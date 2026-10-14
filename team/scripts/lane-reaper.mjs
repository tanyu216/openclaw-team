#!/usr/bin/env node
/**
 * lane-reaper.mjs — lane **会话终态看守**：lane 进程一死，必然写终态（含异常/超时/被杀路径）
 *
 * 为什么存在（T-20261015-045724）：`spawn-lane` 起 lane 时是一次**单向**登记（`status=running`），
 * 而终结侧的**唯一**写点是 ACL `task.session-close`——只能由某个 agent 回合自觉调用。于是 lane
 * 正常结束/被杀/超时/宿主崩溃时，卡 `## Sessions` 行与 registry 双双停在 `running`（pid 已死），
 * 或只被带外手工 reconcile 了一半（registry 终态、卡仍 running）⇒ `check-sessions` note 堆积，
 * 且 poll 的陈旧恢复会把这类**不一致态**再领一次（重复执行风险，实证 `T-20261015-025543-2`）。
 *
 * 本模块把「终态必写」变成**机制**而不是纪律：`spawn-lane` 在起 lane **之后**立即起一个 detached
 * 看守进程，看守只做一件事——**等 lane 的 pid 死**（含僵尸态，见 `laneProcessAlive`），然后经
 * `session-lifecycle.closeLaneSession` 一次写完两侧（卡行 status + 清 `active_session_id` +
 * registry 终态 + `endedAt`）+ 逐条留痕。
 *
 * 为什么是「看守进程」而不是「lane 自己收尾」或「退出钩子」：lane 是 `detached` + `unref` 的
 * **新会话组**（`guides/spawn-lane-sop.md` §5），框架侧**没有**它的退出钩子；被杀（SIGKILL）、
 * 宿主重启、API 超时这类路径下，lane 内部**任何**收尾代码都不会执行。判据取「进程存活」而不是
 * 「lane 是否合作」，才覆盖全部异常路径（超时被杀 = pid 消失；崩溃 = pid 消失；宿主重启 = 看守
 * 与 lane 同亡，由 poll 侧的**不得重领**守卫 + `session-reconcile` 兜底，见 `guides/`）。
 *
 * 用法：
 *   node lane-reaper.mjs <card> <seg> [pid=N] [owner=O] [interval=ms] [grace=ms] [max-wait=ms] [status=done|closed|failed]
 *   node lane-reaper.mjs <card> <seg> [--pid N] [--interval MS] [--grace MS] [--max-wait MS] [--status S] [--once] [--dry-run]
 *
 * 语义：
 *   · 默认循环：每 `interval`（默认 2000ms）查一次 pid；pid 死 ⇒ 等 `grace`（默认 1500ms，让 lane
 *     最后的卡写入落盘）⇒ 收口。行已是终态（lane 自己关了 / 他方已收口）⇒ 立即幂等退出（零写）。
 *   · `--once`：只查一次（已死才收口）——给对账/诊断用，也便于单测。
 *   · `--dry-run`：只打印**会怎么写**，零副作用（不写卡/不写 registry/不留痕）。
 *   · 末行 JSON（机读）：`{ok, action:'closed'|'noop'|'would_close'|'error', taskId, seg, status, …}`。
 *     看守在生产里以 `stdio:'ignore'` 起（无父可读 stdout），诊断走留痕文件
 *     `workspace/<task-id>/lane-lifecycle.log`（JSON Lines）。
 *   · 退出码：0 = 已收口或幂等无操作；1 = 看守失败（拒绝面/ACL 不可用）。
 *
 * 回退开关：`OPENCLAW_TEAM_REAPER=0`（等价 `spawn-lane --no-reaper`）——关闭自动起看守，
 * 回到「父回合自觉收尾」的显式纪律路径（见 `guides/lane-session-lifecycle-sop.md` §4）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild } from 'node:child_process';
import { TEAM_ROOT } from './lib.mjs';
import { closeLaneSession, cardStatusOf, terminalStatusFor, laneProcessAlive, rowStateOf, appendAudit } from './session-lifecycle.mjs';

/** 默认轮询间隔（ms）：看守是空闲进程，2s 的判活粒度远小于任何 lane 的收口时延。 */
export const REAPER_INTERVAL_MS = 2000;
/** pid 死后等待（ms）：让 lane 最后的卡写入（Report/心跳/status）落盘后再收口。 */
export const REAPER_GRACE_MS = 1500;

/** 看守开关：显式 `OPENCLAW_TEAM_REAPER=0` 关闭（未设/其它值 ⇒ 开）。 */
export function reaperEnabled(env = process.env) {
  return String((env && env.OPENCLAW_TEAM_REAPER) ?? '').trim() !== '0';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `key=value` 与带值旗标两种写法通用解析（与 `spawn-lane` 的参数习惯一致）。 */
export function parseReaperArgs(argv = []) {
  const pos = [];
  const kv = {};
  let once = false;
  let dryRun = false;
  let help = false;
  const takesValue = { '--pid': 'pid', '--owner': 'owner', '--interval': 'interval', '--grace': 'grace', '--max-wait': 'maxwait', '--status': 'status' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') { once = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--help' || a === '-h') { help = true; continue; }
    if (takesValue[a]) {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) return { ok: false, reason: `missing_value:${a}` };
      kv[takesValue[a]] = v;
      continue;
    }
    if (a.startsWith('--')) return { ok: false, reason: `unknown_flag:${a}` };
    const i2 = a.indexOf('=');
    if (i2 > 0) { kv[a.slice(0, i2)] = a.slice(i2 + 1); continue; }
    pos.push(a);
  }
  if (pos.length > 2) return { ok: false, reason: `unexpected_positional:${pos[2]}` };
  const num = (v, dflt) => {
    if (v == null || String(v).trim() === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    ok: true,
    help,
    once,
    dryRun,
    card: pos[0] || '',
    seg: pos[1] || 'seg1',
    pid: kv.pid == null ? null : Number(kv.pid),
    owner: kv.owner || '',
    intervalMs: num(kv.interval, REAPER_INTERVAL_MS),
    graceMs: num(kv.grace, REAPER_GRACE_MS),
    maxWaitMs: num(kv.maxwait, 0),
    status: kv.status || '',
  };
}

/**
 * `spawn-lane` 用的看守起手法：detached + `stdio:'ignore'` + `unref()`，**不阻塞**移交，
 * 也不因父回合结束而被回收（同 lane 自身的 detach 纪律，`guides/spawn-lane-sop.md` §5）。
 * cwd 固定为团队根：lane 的 cwd 可能是稍后被清理的隔离 worktree，看守不得依赖它。
 * @returns {{ok:boolean, pid?:number, reason?:string, argv:string[]}}
 */
export function armLaneReaper({ card, seg, pid, owner = '', intervalMs = REAPER_INTERVAL_MS, graceMs = REAPER_GRACE_MS, env = process.env }) {
  const self = fileURLToPath(import.meta.url);
  // node 可执行文件可注入（`OPENCLAW_TEAM_REAPER_NODE`）：与 `OPENCLAW_CLAUDE_BIN`/`OPENCLAW_CODEX_BIN`
  // 同款测试缝——单测需要一条「看守起不来」的真实路径来验 fail-closed 分支（指向不存在的 bin ⇒
  // `spawn` 返回无 pid 的 ChildProcess ⇒ 本函数同步返回 ok:false）。
  const bin = env && env.OPENCLAW_TEAM_REAPER_NODE ? String(env.OPENCLAW_TEAM_REAPER_NODE) : process.execPath;
  const argv = [card, seg, `pid=${pid}`];
  if (owner) argv.push(`owner=${owner}`);
  if (intervalMs !== REAPER_INTERVAL_MS) argv.push(`interval=${intervalMs}`);
  if (graceMs !== REAPER_GRACE_MS) argv.push(`grace=${graceMs}`);
  let child;
  try {
    child = spawnChild(bin, [self, ...argv], { cwd: TEAM_ROOT, detached: true, stdio: 'ignore', env });
  } catch (e) {
    return { ok: false, reason: `spawn_failed:${String(e && e.message ? e.message : e)}`, argv };
  }
  child.on('error', () => { /* 起失败由 pid 判定收口，此处兜住避免 unhandled */ });
  if (child.pid == null) return { ok: false, reason: 'no_pid', argv };
  child.unref();
  return { ok: true, pid: child.pid, argv };
}

/** 一次收口尝试（pid 已死时调用）：状态由 `--status` 或卡面推导；`dryRun` 只报不做。 */
export async function reapOnce({ card, seg, pid = null, status = '', source = 'lane-reaper', dryRun = false }) {
  const cardStatus = cardStatusOf(card);
  const st = status || terminalStatusFor(cardStatus);
  const before = rowStateOf(card, seg);
  if (!before) return { ok: false, action: 'error', reason: 'seg_row_missing', seg, cardStatus };
  if (before.status !== 'running') {
    return { ok: true, action: 'noop', reason: 'already_terminal', seg, status: before.status, sessionId: before.id, cardStatus };
  }
  if (pid != null && Number.isInteger(before.pid) && before.pid > 0 && before.pid !== Number(pid) && laneProcessAlive(before.pid)) {
    return { ok: true, action: 'noop', reason: `row_taken_by_live_pid(${before.pid})`, seg, sessionId: before.id, cardStatus };
  }
  if (dryRun) return { ok: true, action: 'would_close', seg, status: st, sessionId: before.id, cardStatus, pid };
  const r = await closeLaneSession({ card, seg, status: st, expectPid: pid, source });
  return { ...r, action: r.ok ? (r.changed ? 'closed' : 'noop') : 'error', seg, cardStatus, pid };
}

/**
 * 看守主循环：等 pid 死（或该 seg 行已被他方收口）⇒ 收口。返回末行 JSON 的对象。
 * @param {{card:string, seg:string, pid:number, intervalMs?:number, graceMs?:number, maxWaitMs?:number,
 *          status?:string, once?:boolean, dryRun?:boolean, source?:string}} o
 */
export async function watchAndReap({ card, seg, pid, intervalMs = REAPER_INTERVAL_MS, graceMs = REAPER_GRACE_MS, maxWaitMs = 0, status = '', once = false, dryRun = false, source = 'lane-reaper' }) {
  const t0 = Date.now();
  for (;;) {
    const row = rowStateOf(card, seg);
    if (!row) return { ok: true, action: 'noop', reason: 'seg_row_missing', seg, card };
    if (row.status !== 'running') return { ok: true, action: 'noop', reason: 'already_terminal', seg, status: row.status, sessionId: row.id };
    if (pid != null && !laneProcessAlive(Number(pid))) {
      if (graceMs > 0 && !dryRun) await sleep(graceMs);
      return reapOnce({ card, seg, pid, status, dryRun, source });
    }
    if (once) return { ok: true, action: 'noop', reason: 'still_running', seg, pid };
    if (maxWaitMs > 0 && Date.now() - t0 >= maxWaitMs) {
      return { ok: false, action: 'error', reason: `max_wait_exceeded(${maxWaitMs}ms)`, seg, pid };
    }
    await sleep(intervalMs);
  }
}

const HELP = `用法: node lane-reaper.mjs <card> <seg> [pid=N] [owner=O] [interval=ms] [grace=ms] [max-wait=ms] [status=done|closed|failed]
       node lane-reaper.mjs <card> <seg> [--pid N] [--interval MS] [--grace MS] [--max-wait MS] [--status S] [--once] [--dry-run]

lane 会话终态看守（单入口 spawn-lane 自动起）：等 lane pid 死 ⇒ 经 ACL session-close 一次写完
卡 ## Sessions 行 status + 清 active_session_id + registry 终态（含 endedAt），并追加 endedAt 审计字段 +
逐条留痕 workspace/<card>/lane-lifecycle.log。状态缺省由卡面推导（done/in_review ⇒ done；
failed/canceled ⇒ failed；其余 ⇒ closed）。
--once 只判一次（pid 仍活 ⇒ noop）；--dry-run 只报不做（零副作用）。回退：OPENCLAW_TEAM_REAPER=0。
`;

function main() {
  const a = parseReaperArgs(process.argv.slice(2));
  if (!a.ok) { console.error(HELP); console.log(JSON.stringify({ ok: false, reason: a.reason })); process.exit(2); }
  if (a.help) { console.log(HELP); process.exit(0); }
  if (!a.card) { console.error(HELP); console.log(JSON.stringify({ ok: false, reason: 'missing_card' })); process.exit(2); }
  watchAndReap({
    card: a.card, seg: a.seg, pid: a.pid, intervalMs: a.intervalMs, graceMs: a.graceMs,
    maxWaitMs: a.maxWaitMs, status: a.status, once: a.once, dryRun: a.dryRun,
  }).then((r) => {
    if (!r.ok && r.action === 'error') appendAudit(r.taskId || a.card, { source: 'lane-reaper', action: 'error', seg: a.seg, pid: a.pid, reason: r.reason });
    console.log(JSON.stringify({ ok: r.ok !== false, card: a.card, ...r }));
    process.exit(r.ok === false ? 1 : 0);
  }).catch((e) => {
    const reason = String(e && e.stack ? e.stack : e);
    appendAudit(a.card, { source: 'lane-reaper', action: 'error', seg: a.seg, pid: a.pid, reason });
    console.log(JSON.stringify({ ok: false, card: a.card, action: 'error', reason }));
    process.exit(1);
  });
}

// main-guard：realpath 归一（被 import 时不执行 CLI）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
