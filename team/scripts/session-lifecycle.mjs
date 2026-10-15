#!/usr/bin/env node
/**
 * session-lifecycle.mjs — 子会话**终态**的共享原语（判据 + 必然落写 + 留痕）
 *
 * 为什么存在（T-20261015-045724）：lane 起会话走单入口（`spawn-lane`：claim → handoff → spawn →
 * `task.session-set`，卡 + registry 同写），但**终结**从来没有对应的强制入口——唯一的终态写入点
 * 是 ACL `task.session-close`，而它只能由**某个 agent 回合**自觉调用（`roles/<role>/AGENTS.md` 的 SOP 纪律）。
 * 于是 lane 正常结束/被杀/超时/宿主崩溃时，卡内 `## Sessions` 行与 registry 双双停在 `running`
 * （pid 已死），或只被带外手工 reconcile 了一半（registry 终态、卡仍 running）⇒
 *   · `check-sessions` 的 note 堆积（status_mismatch / stale_card_line / zombie_registry）；
 *   · poll 的陈旧恢复判据把这类**不一致态**当「可恢复的陈旧 claim」**再领一次** ⇒ 重复执行风险。
 *
 * 本模块提供三件事（两个 CLI 共用一个判据，绝不各写一份）：
 *   ① `classifyClaimBlock` —— 「不一致态 ⇒ 不得重领」的**唯一判据**（poll 读写两面的上游）；
 *   ② `closeLaneSession` —— **必然**写终态：ACL `sessionClose`（卡行 status + 清 `active_session_id`
 *      + registry 终态 + `endedAt`）之后，再为该行补 `endedAt` 审计字段（追加式，不改既有字段）；
 *   ③ `appendAudit` —— 逐条留痕（`workspace/<task-id>/lane-lifecycle.log`，JSON Lines）。
 *
 * 纪律：ACL 仍是**唯一**的卡 `## Sessions` 写点（`PROTOCOL §⑬.3`）。本模块不直接写卡行正文——
 * `endedAt` 补写只在该行**刚被本模块经 ACL 置终态**时发生（追加一个字段，不重写任何既有字段）。
 *
 * provider 依赖：ACL 库是 provider 拥有、有意不 vendoring 的（`skills/PROVENANCE.md`），故**动态**
 * import（与 `lib.mjs` 对 `team-paths.mjs` 同款）——`poll.mjs` 会静态 import 本模块，静态 import
 * ACL 会让仓内（无 `team/skills/task-ops`）的 poll 在**解析期**就 ENOENT。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { TEAM_ROOT, TASK_OPS_DIR, readCard, writeCardAtomic, nowIso, parseIso } from './lib.mjs';
import { loadRegistry, isPidAlive, setSessionStatus } from './registry.mjs';
import { isSessionTerminal } from './status.mjs';

/** 逐条留痕文件名（落 `workspace/<task-id>/`，与 lane 的 out/err 日志同处）。 */
export const LANE_AUDIT_FILE = 'lane-lifecycle.log';

// 判据/落写的状态口径：本模块只写终态（`running` 由 `task.session-set` 负责）。
// **会话轴**词表（done/closed/failed）与换算单点持有于 `scripts/status.mjs` —— 注意会话终态用
// `closed` 而**卡面**终态用 `canceled`，两轴用词故意不同，唯一换算处见该模块 `sessionTerminalForCard`。

// ---------- ① 卡内 `## Sessions` 行解析（行首 `- seg:… · …`，键值对通用提取） ----------

/**
 * 解析 `## Sessions` 段的行。返回含**正文行号**（`index`）的行对象，供追加式补写定位。
 * 与 `spawn-lane.mjs#sessionsBySeg` / `check-sessions.mjs#sessionsOf` 同源口径（kv 通用提取 +
 * `seg` 恒以行首 `seg:<x> ·` 为准），但此处额外记录行号与 `endedAt`。
 */
export function parseSessionRows(body) {
  const lines = String(body ?? '').split('\n');
  let inSessions = false;
  const out = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^##\s/.test(line)) {
      inSessions = line.trim() === '## Sessions';
      continue;
    }
    if (!inSessions || !line.trim().startsWith('- seg:')) continue;
    const row = { index, line };
    const m = /^- seg:(\S+) ·/.exec(line);
    for (const part of line.replace(/^-\s*/, '').split(' · ')) {
      const kv = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(part.trim());
      if (kv) row[kv[1]] = kv[2].trim();
    }
    row.seg = m ? m[1] : row.seg || '';
    row.pidNum = Number(row.pid);
    out.push(row);
  }
  return out;
}

/**
 * 卡上代表「当前 lane」的那一行：优先 `active_session_id` 命中的行（ACL 在 `status=running` 时
 * 写它，`sessionClose` 清空它），否则退回**最后一条** `running` 行；都没有 ⇒ null。
 * 判据**必须**按身份（session id / seg）对齐，不得只看「最后一行」——同卡多 seg 的历史行是常态。
 */
export function laneRow(rows, { activeSessionId = '' } = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const active = String(activeSessionId || '').trim();
  if (active) {
    const hit = all.find((r) => r.id && r.id === active);
    if (hit) return hit;
  }
  const running = all.filter((r) => r.status === 'running');
  return running.length ? running[running.length - 1] : null;
}

// ---------- ② 进程存活（含僵尸态） ----------

/**
 * 进程存活判定 = `registry.isPidAlive`（kill(pid,0)）**且非僵尸**。
 *
 * 为什么加僵尸断言：被 kill 的子进程在其父（起 lane 的回合）尚未 wait 之前仍是**僵尸**——
 * `kill(pid,0)` 对僵尸**成功** ⇒ 单看 `isPidAlive` 会把「已终结」读成「还在跑」，看守进程于是永不收口
 * （本卡实测的失败模式）。`ps -o stat=` 首列 `Z` 即僵尸；`ps` 不可用/权限不足 ⇒ 退回纯 `isPidAlive`
 * （保守：宁可多等一轮，也不把活进程判死）。
 */
export function laneProcessAlive(pid) {
  const n = Number(pid);
  if (!isPidAlive(n)) return false;
  try {
    const out = execFileSync('ps', ['-o', 'stat=', '-p', String(n)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const stat = out.trim();
    if (!stat) return true; // ps 无输出：与 kill(pid,0) 分歧 ⇒ 保守判活
    return !isZombieStat(stat);
  } catch {
    return true;
  }
}

/** `ps -o stat=` 的僵尸判定（首列 `Z`）：纯函数，便于单测锁死分类（真僵尸进程不易在进程内构造）。 */
export function isZombieStat(stat) {
  return String(stat ?? '').trim().startsWith('Z');
}

// ---------- ③ 「不一致态 ⇒ 不得重领」的唯一判据 ----------

/**
 * poll 陈旧恢复面的守门判据（**只读、零副作用**）。
 *
 * 输入 = 卡上代表当前 lane 的那一行（`laneRow`）+ canonical registry。判据（三条，任一命中即拦）：
 *   · `registry_done` —— registry 该 session 已是 `done`：lane 已宣告完成 ⇒ 工作**可能已交付**，
 *     重领 = 重复执行（本卡的直接根因，实证 `T-20261015-025543`/本卡 `-2` 的 stale_same 重领）；
 *   · `registry_terminal_live` —— registry 该 session 已终态（closed/failed）而卡行 **pid 存活**：
 *     活进程与「已终结」的登记互相矛盾 ⇒ 谁真谁假不可判，重领可能双跑；
 *   · `card_only_live` —— registry **无**该 session 条目而卡行 **pid 存活**：m7 类「只说在跑、
 *     登记面没有」的矛盾态 ⇒ 同上。
 * **不在**守门面的（照旧可领，真恢复路径不得被吃掉）：
 *   · registry `closed`/`failed` 且卡行 pid 已死 ⇒ 僵尸行，交陈旧恢复；
 *   · registry 无条目且卡行 pid 已死 ⇒ 同上；
 *   · 卡行本身已终态 / 无 `## Sessions` 行 / `new`（todo/ready）面 ⇒ 本判据不适用（调用方只在
 *     `in_progress` 陈旧候选上调它）。
 *
 * 返回 `{block, kind?, registry?, pid, session, alive}`；`block:false` 时其余字段仅作诊断。
 */
export function classifyClaimBlock({ taskId, row, registry = null }) {
  if (!row || row.status !== 'running') return { block: false, reason: 'no_running_row' };
  const reg = registry == null ? loadRegistry({ includeLegacy: false }) : registry;
  const e = (Array.isArray(reg) ? reg : []).find((x) => x && x.task_id === taskId && x.session_id === row.id);
  const alive = laneProcessAlive(row.pidNum);
  const base = { task: taskId, session: row.id || '', seg: row.seg || '', pid: Number.isInteger(row.pidNum) ? row.pidNum : null, alive };
  if (e && e.status === 'done') return { block: true, kind: 'registry_done', registry: e.status, ...base };
  if (e && isSessionTerminal(e.status) && alive) return { block: true, kind: 'registry_terminal_live', registry: e.status, ...base };
  if (!e && alive) return { block: true, kind: 'card_only_live', registry: null, ...base };
  return { block: false, registry: e ? e.status : null, ...base };
}

// ---------- ④ 必然落写终态 ----------
//
// 「卡面状态 → 会话终态」的换算（lane 死时卡面即其最终交付面）已上移到词表模块：
// `scripts/status.mjs#sessionTerminalForCard` —— 两轴之间的**唯一**换算处，本模块与
// `lane-reaper.mjs` 共用（原先本文件持有 `terminalStatusFor`，只有 reaper 一个消费者）。

/** 动态装载 provider ACL（缺 provider 由 lib.mjs 的启动期硬失败先行收口）。 */
async function loadAcl() {
  const p = path.join(TASK_OPS_DIR, 'lib', 'task.mjs');
  return import(pathToFileURL(p).href);
}

/** 逐条留痕（JSON Lines；追加写，失败不抛——留痕失败绝不阻断终态落写）。 */
export function appendAudit(taskId, record) {
  try {
    const dir = path.join(TEAM_ROOT, 'workspace', String(taskId));
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, LANE_AUDIT_FILE);
    fs.appendFileSync(p, JSON.stringify({ at: nowIso(), ...record }) + '\n', 'utf8');
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

/**
 * 把某 seg 的会话行置终态——**必然**两侧同步（本卡的 ②）：
 *   1. ACL `task.sessionClose(card, seg, status)`：卡行 status + 清 `active_session_id` + registry
 *      终态（含 `endedAt`）+ 释放同卡跨回合锁，**一次调用同写两侧**（唯一写点）；
 *   2. 为该行**追加** `endedAt` 审计字段（只在本次确实做了 running→终态 跃迁时；追加式，不重写任何
 *      既有字段，幂等：已有 `endedAt` 即不写）。
 *
 * 拒绝面（**绝不写**，返回 ok:false 让调用方决定）：seg 无行 / 行已被别的 lane 重写
 * （`expectSessionId` 不符）/ 行 pid 与看守的 pid 不符且那个 pid **仍存活**（行已被新 lane 接管）。
 * 幂等面：行已是终态 ⇒ `{ok:true, changed:false, reason:'already_terminal'}`（不覆盖他方写入）。
 *
 * @param {{card:string, seg:string, status?:'done'|'closed'|'failed', expectSessionId?:string,
 *          expectPid?:number|null, source?:string, audit?:boolean}} o
 */
export async function closeLaneSession({ card, seg, status = 'closed', expectSessionId = '', expectPid = null, source = 'lane-reaper', audit = true }) {
  const st = String(status || '').trim();
  if (!isSessionTerminal(st)) return { ok: false, reason: `invalid_status(${st})` };
  let c;
  try {
    c = readCard(card);
  } catch (e) {
    return { ok: false, reason: `card_unreadable:${String(e && e.message ? e.message : e)}` };
  }
  const taskId = c.fm.id || path.basename(c.cardPath, '.md');
  const row = parseSessionRows(c.body).find((r) => r.seg === seg);
  if (!row) return { ok: false, taskId, seg, reason: 'seg_row_missing' };
  if (row.status !== 'running') return { ok: true, taskId, seg, changed: false, reason: 'already_terminal', status: row.status, sessionId: row.id || '' };
  if (expectSessionId && row.id && row.id !== expectSessionId) {
    return { ok: false, taskId, seg, reason: `session_id_mismatch(row=${row.id},expect=${expectSessionId})` };
  }
  if (expectPid != null && Number.isInteger(row.pidNum) && row.pidNum > 0 && row.pidNum !== Number(expectPid) && laneProcessAlive(row.pidNum)) {
    // 行已被另一条活 lane 接管（比如同 seg resume 重登）⇒ 看守不得越权关它
    return { ok: false, taskId, seg, reason: `row_taken_by_live_pid(${row.pidNum})` };
  }

  const sessionId = row.id || '';
  let acl;
  try {
    acl = await loadAcl();
  } catch (e) {
    return { ok: false, taskId, seg, reason: `acl_unavailable:${String(e && e.message ? e.message : e)}` };
  }
  const cl = acl.sessionClose(card, seg, st);
  if (!cl || cl.ok !== true) {
    return { ok: false, taskId, seg, reason: `session_close_failed:${(cl && (cl.reason || cl.status)) || 'unknown'}`, detail: cl };
  }

  // 追加 `endedAt` 审计字段（ACL 只把 endedAt 写进 registry；卡行侧由本模块补，见文件头纪律）。
  const endedAt = nowIso();
  let stamped = false;
  try {
    const after = readCard(c.cardPath);
    const row2 = parseSessionRows(after.body).find((r) => r.seg === seg);
    if (row2 && row2.status !== 'running' && !row2.endedAt) {
      const lines = after.body.split('\n');
      lines[row2.index] = `${lines[row2.index]} · endedAt:${endedAt}`;
      writeCardAtomic(after.cardPath, after.fm, lines.join('\n'));
      stamped = true;
    }
  } catch {
    /* 补写失败不改变「终态已落」的事实：ACL 的两侧同步已经完成 */
  }

  const out = { ok: true, taskId, seg, changed: true, status: st, sessionId, endedAt, stamped, source, registry: cl.registry };
  if (audit !== false) appendAudit(taskId, { source, action: 'session-close', seg, session: sessionId, status: st, endedAt, stamped, registry: cl.registry && cl.registry.ok ? 'synced' : (cl.registry && cl.registry.reason) || 'n/a' });
  return out;
}

/**
 * 只落 registry 一侧的终态（僵尸 registry 行**没有**对应卡行时的收口口）。
 * 有卡行 ⇒ 一律走 `closeLaneSession`（两侧同写），不得在此绕过卡侧。
 */
export function closeRegistryOnly({ taskId, sessionId, status = 'closed', source = 'session-reconcile' }) {
  const st = String(status || '').trim();
  if (!isSessionTerminal(st)) return { ok: false, reason: `invalid_status(${st})` };
  const r = setSessionStatus(taskId, sessionId, st, { endedAt: nowIso() });
  if (r && r.ok) appendAudit(taskId, { source, action: 'registry-close', session: sessionId, status: st });
  return r;
}

/** 便利：卡面状态 ⇒ 该 lane 的终态（供看守/对账共用）。 */
export function cardStatusOf(card) {
  try {
    return String(readCard(card).fm.status ?? '');
  } catch {
    return '';
  }
}

/** 供诊断用：卡行 → `{status, id, pid, endedAt}`（缺 ⇒ null）。 */
export function rowStateOf(card, seg) {
  try {
    const row = parseSessionRows(readCard(card).body).find((r) => r.seg === seg);
    if (!row) return null;
    return { status: row.status || '', id: row.id || '', pid: row.pidNum, endedAt: row.endedAt || '' };
  } catch {
    return null;
  }
}

/** 心跳/时间解析再导出（对账清单按 `endedAt`/`heartbeat_at` 归口时用；与 lib.mjs 同源）。 */
export { parseIso };
