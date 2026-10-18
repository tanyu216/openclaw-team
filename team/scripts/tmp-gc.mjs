#!/usr/bin/env node
// tmp-gc.mjs — 临时文件回收（`R-DISC-9`）
//
// 两种模式，因为**清扫比一次触发评估的预算更大**：
//   默认（调度入口，providers.json 调的就是它）：
//     node tmp-gc.mjs [--json] [--openclaw-home <p>] [--days N] [--root <p>]...
//     —— 只做两件事：读上次清扫留下的失败标记（有 ⇒ fire:true 并把原因带出去），然后
//        以 detached 子进程发起一次清扫，立刻返回。毫秒级，永远在评估预算内。
//   --sweep（真正干活，由上面的入口 detached 拉起；也可手工跑）：
//     node tmp-gc.mjs --sweep [--dry-run] [--json] [--days N] [--deadline-ms N] [--root <p>]...
// 为什么分离：本机的 $OPENCLAW_HOME/tmp 实测 32 万文件 / 10 万目录 / 最深 14 层，完整
//   mtime 遍历 10.0 s，而框架给入口的评估预算是 8000ms − 500ms 保留 = 7.5 s，且触发脚本
//   的 exec 有 ~10 s yieldMs 上限 ⇒ 调大预算解决不了。同步遍历已是最快形态（并发实测更慢：
//   24–40 s）。故：入口只管「判定 + 派活」，遍历 detached 跑完。与 check-all 慢腿同款机制。
//
// 规则: 根的**内部**、mtime 早于 N 天（默认 14）的**普通文件** ⇒ 删除；随后自下而上修剪
//       因此变空的目录（止步于根，绝不删根本身）。
// 安全: 全程 lstat，符号链接既不删也不跟随；根解析成 realpath 后拒绝 `/` 与 $HOME；
//       根缺失不算错误。
// 失败闭合：根/子目录读不了、unlink 失败、或（sweep 内）遍历被截断 ⇒ 写失败标记 ⇒
//       下次评估 fire:true 唤醒 leader；正常清扫完（哪怕删得很多）⇒ 无标记、fire:false。
//       dry-run 是真只读：不 unlink、不 rmdir、不建目录、不碰 mtime、也不写任何标记。
//
// 为什么根族用 glob 而不是硬编码角色表：① 仓内不再出现 install.sh 角色表的第二份副本
//    （两份名单必然漂移）；② 主机上任何额外的 workspace-* 目录也自动覆盖，无需改脚本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DAYS = 14;
/** 入口侧的枚举截止（ms）。入口模式其实不遍历，这个值只作为传给 detached 子进程的默认；
 *  数值本身取"稳妥小于一次触发评估预算"的量级，以防有人把 --sweep 直接接在同步路径上。 */
export const DEFAULT_DEADLINE_MS = 6000;
/** --sweep 的默认枚举截止（ms）：detached 运行，不在触发评估预算内，故给足余量（10 分钟）。
 *  实测本机 32 万文件 ≈ 10 s，所以 10 分钟是 60× 的余量；真撞上说明文件系统出了怪事，
 *  届时 deadlineHit ⇒ 按"未确认"报警（见 runSweep），而不是静默漏扫。 */
export const SWEEP_DEADLINE_MS = 600000;

/**
 * 解析 CLI。
 * `--days` 的缺省/畸形值一律回落到默认（token 形态同 archive.mjs）。
 * `deadlineMs` 缺省时返回 undefined —— 由**模式**决定真正的默认（入口 6000 / sweep 600000），
 * 故这里不能预先填一个值，否则 --sweep 会继承入口侧的 6s 而被截断。
 */
export function parseArgs(argv = []) {
  const val = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
  };
  const roots = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--root' && argv[i + 1] != null) roots.push(argv[i + 1]);
  const daysRaw = Number(val('--days', DEFAULT_DAYS));
  const dlRaw = Number(val('--deadline-ms', process.env.OPENCLAW_TEAM_TMPGC_DEADLINE_MS));
  return {
    days: Number.isFinite(daysRaw) && daysRaw >= 0 ? daysRaw : DEFAULT_DAYS,
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    sweep: argv.includes('--sweep'),
    roots,
    openclawHome: path.resolve(val('--openclaw-home', process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'))),
    // undefined = 没显式给 ⇒ 由模式决定（入口 6000 / sweep 600000）
    deadlineMs: Number.isFinite(dlRaw) && dlRaw > 0 ? dlRaw : undefined,
  };
}

/** 年龄判定：只看条目自己的 mtime（绝不看根的 mtime）。 */
export function isExpired(mtimeMs, now, days) {
  return mtimeMs < now - days * 86400 * 1000;
}

/** 默认根族：每个成员 workspace 下的 .tmp，加上 $OH/tmp 与 $OH/team/tmp（存在才收）。 */
export function defaultRoots(openclawHome) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(openclawHome); } catch { names = []; }
  for (const n of names.sort()) {
    if (!n.startsWith('workspace-')) continue;
    const p = path.join(openclawHome, n, '.tmp');
    try { if (fs.lstatSync(p).isDirectory()) out.push(p); } catch { /* 不存在即跳过 */ }
  }
  for (const p of [path.join(openclawHome, 'tmp'), path.join(openclawHome, 'team', 'tmp')]) {
    try { if (fs.lstatSync(p).isDirectory()) out.push(p); } catch { /* 不存在即跳过 */ }
  }
  return out;
}

/**
 * 根守卫：解析成 realpath 后拒绝明显越界的根（`/`、$HOME，或整个 home 本身）。
 * 拒绝的根计入 refused，绝不遍历。
 */
export function guardRoot(root) {
  let real;
  try { real = fs.realpathSync(root); } catch { return { ok: false, reason: 'missing' }; }
  let st;
  try { st = fs.lstatSync(root); } catch { return { ok: false, reason: 'missing' }; }
  if (!st.isDirectory()) return { ok: false, reason: 'not-a-directory' };
  const home = fs.realpathSync(os.homedir());
  if (real === path.parse(real).root || real === home) return { ok: false, reason: 'too-broad' };
  return { ok: true, real };
}

/**
 * 枚举（只读）：走遍每个根，收集"过期普通文件"作为待删目标。
 * 安全规则：一律 lstat；符号链接**跳过**（既不删也不递归进去，故不会走出根、不会成环）；
 * 只有普通文件可能进 targets；目录只登记、留给 applyPlan 修剪。
 */
export function collectPlan({ roots, now = Date.now(), days = DEFAULT_DAYS, deadlineMs = DEFAULT_DEADLINE_MS } = {}) {
  const deadlineAt = now + deadlineMs;
  const plan = {
    roots: [], refused: [], missing: [], unreadable: [],
    targets: [], dirs: [], scanned: 0, symlinksSkipped: 0, deadlineHit: false,
  };
  outer:
  for (const root of roots) {
    const g = guardRoot(root);
    if (!g.ok) { (g.reason === 'missing' ? plan.missing : plan.refused).push({ root, reason: g.reason }); continue; }
    plan.roots.push(root);
    const stack = [root];
    while (stack.length) {
      if (Date.now() > deadlineAt) { plan.deadlineHit = true; break outer; }
      const dir = stack.pop();
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (e) { plan.unreadable.push({ path: dir, error: String(e && e.code || e) }); continue; }
      plan.dirs.push(dir);
      for (const ent of ents) {
        if (STATE_FILES.has(ent.name)) continue;                        // 自带运行期状态：永不删
        const p = path.join(dir, ent.name);
        let st;
        try { st = fs.lstatSync(p); }
        catch (e) { plan.unreadable.push({ path: p, error: String(e && e.code || e) }); continue; }
        if (st.isSymbolicLink()) { plan.symlinksSkipped++; continue; }  // 不跟随：既不删也不进
        if (st.isDirectory()) { stack.push(p); continue; }
        if (!st.isFile()) continue;                                     // fifo/socket/device 一律不碰
        plan.scanned++;
        if (isExpired(st.mtimeMs, now, days)) plan.targets.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  return plan;
}

/**
 * 执行（默认写）：unlink 目标，然后自下而上 rmdir 因之变空的目录（止步于根）。
 * dry-run 下两件事都不做，只回报"将会删多少"。
 */
export function applyPlan(plan, { dryRun = false } = {}) {
  const res = { deleted: 0, failed: 0, bytes: 0, prunedDirs: 0, failures: [] };
  for (const t of plan.targets) {
    if (dryRun) { res.deleted++; res.bytes += t.size; continue; }
    try { fs.unlinkSync(t.path); res.deleted++; res.bytes += t.size; }
    catch (e) {
      // ENOENT = 目标已经不在了：清理的目的已达成，不是失败。这条让"陈旧锁被接管后两次
      // 清扫并发"之类的竞态不会误报成告警。
      if (e && e.code === 'ENOENT') { res.deleted++; res.bytes += t.size; continue; }
      res.failed++; res.failures.push({ path: t.path, error: String(e && e.code || e) });
    }
  }
  if (dryRun) return res;
  // 深的先试：只在空目录上成功，ENOTEMPTY 即止步（正是"止步于根"的机制）。
  const roots = new Set(plan.roots);
  for (const d of [...plan.dirs].sort((a, b) => b.length - a.length)) {
    if (roots.has(d)) continue;
    try { fs.rmdirSync(d); res.prunedDirs++; } catch { /* 非空/已被父级带走 ⇒ 正常 */ }
  }
  return res;
}

/** 编排：枚举 + 执行 ⇒ 输出信封（fire/message/state）。 */
export function gc(opts) {
  const { roots, days, dryRun, deadlineMs } = opts;
  const now = Date.now();
  const plan = collectPlan({ roots, now, days, deadlineMs });
  const res = applyPlan(plan, { dryRun });
  // fail-closed：评估未被确认（读不了 / 删不掉）⇒ 告警；正常清扫完 ⇒ fire:false。
  const unconfirmed = plan.unreadable.length + plan.refused.length + res.failed;
  const state = {
    job: 'tmp-gc', days, dryRun, deadlineHit: plan.deadlineHit,
    deleted: res.deleted, failed: res.failed, bytes: res.bytes, prunedDirs: res.prunedDirs,
    scanned: plan.scanned, symlinksSkipped: plan.symlinksSkipped,
    roots: plan.roots, missingRoots: plan.missing, refusedRoots: plan.refused,
    unreadable: plan.unreadable.slice(0, 20), failures: res.failures.slice(0, 20),
    at: now,
  };
  const env = { fire: unconfirmed > 0, deleted: res.deleted, failed: res.failed, bytes: res.bytes, roots: plan.roots };
  if (unconfirmed > 0) {
    env.message = alarmText({ unreadable: plan.unreadable.length, refused: plan.refused.length, failed: res.failed, deadlineHit: plan.deadlineHit });
  }
  env.state = state;
  return env;
}

// ── 运行期状态：单飞锁 + 失败标记 ─────────────────────────────────────────────────
// 落点在 $OPENCLAW_HOME/team/tmp/：该目录已被门禁漂移巡检 `-x tmp` 排除，故新增运行期
// 文件不会让 repo↔instance 比对报警；且清扫**永不删这两个文件**（见 STATE_FILES）。
export const LOCK_NAME = '.tmp-gc.lock';
export const FAIL_NAME = '.tmp-gc-failed';
export const STATE_FILES = new Set([LOCK_NAME, FAIL_NAME]);
/** 超过它即视为陈旧锁（同 lib.mjs 的 15min 陈旧锁口径），可被后来者接管。 */
export const STALE_LOCK_MS = 15 * 60 * 1000;

export function stateDir(openclawHome) { return path.join(openclawHome, 'team', 'tmp'); }

export function alarmText({ unreadable = 0, refused = 0, failed = 0, deadlineHit = false } = {}) {
  return `[openclaw-team] tmp-gc could not confirm the scratch cleanup: ` +
    `unreadable=${unreadable} refused=${refused} unlink-failed=${failed} deadline-hit=${deadlineHit}. ` +
    `Check permissions/space on the scratch roots (workspace-*/.tmp, ~/.openclaw/tmp, ~/.openclaw/team/tmp) ` +
    `and re-run \`node scripts/tmp-gc.mjs --sweep --dry-run --json\` to see the state.`;
}

/** 读失败标记；不存在/不可读 ⇒ null（"没有已知失败"，不是"失败"）。 */
export function readFailure(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, FAIL_NAME), 'utf8')); } catch { return null; }
}

export function writeFailure(dir, payload) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FAIL_NAME), JSON.stringify(payload));
}

export function clearFailure(dir) {
  try { fs.unlinkSync(path.join(dir, FAIL_NAME)); } catch { /* 本来就没有 ⇒ 正常 */ }
}

/** pid 是否存活（EPERM 视为存活：进程在，只是不归我们管）。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/**
 * 单飞锁。返回 {ok:true} 表示拿到了锁（调用方负责 release）；{ok:false, heldBy} 表示
 * 已有一次清扫在跑。陈旧锁（超时或 pid 已死）会被接管 —— 否则一次崩溃的清扫会永久
 * 停摆这个作业。
 */
export function acquireLock(dir, now = Date.now()) {
  const p = path.join(dir, LOCK_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const take = () => { fs.writeFileSync(p, JSON.stringify({ pid: process.pid, at: now })); return { ok: true }; };
  const existing = (() => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } })();
  if (existing && pidAlive(existing.pid) && now - (existing.at || 0) < STALE_LOCK_MS) {
    return { ok: false, heldBy: existing.pid };
  }
  return take();
}

export function releaseLock(dir) {
  try { fs.unlinkSync(path.join(dir, LOCK_NAME)); } catch { /* 已释放 ⇒ 正常 */ }
}

/**
 * --sweep：真正干活。拿到单飞锁后遍历 + 删除，然后据此写/清失败标记。
 * 返回清扫信封（deleted/bytes/... ，fire 表示这次清扫自身是否未确认）。
 */
export function runSweep(opts) {
  const { openclawHome, dryRun } = opts;
  const dir = stateDir(openclawHome);
  let held = { ok: true };
  if (!dryRun) held = acquireLock(dir);
  if (!held.ok) return { fire: false, state: { job: 'tmp-gc', mode: 'sweep', skipped: 'already-running', heldBy: held.heldBy } };
  try {
    const env = gc(opts);
    env.state.mode = 'sweep';
    if (!dryRun) {
      // 截断也是"未确认"：遍历没走完 ⇒ 不能声称这次清扫完成。
      const unconfirmed = env.fire || env.state.deadlineHit;
      if (unconfirmed) {
        const payload = { at: env.state.at, message: env.message || alarmText({ deadlineHit: env.state.deadlineHit }), state: env.state };
        writeFailure(dir, payload);
      } else {
        clearFailure(dir);
      }
    }
    return env;
  } finally {
    if (!dryRun) releaseLock(dir);
  }
}

/**
 * 默认模式（调度入口）：读上次的失败标记 ⇒ fire；再 detached 发起一次清扫 ⇒ 立刻返回。
 * 本函数不做任何遍历，故永远在触发评估预算内。
 * spawnFn 可注入，便于单测断言"发起了什么"，而不真的起进程。
 */
export function runEntry(opts, spawnFn = spawn) {
  // sweepDeadlineMs = 调用方**显式**要求的子进程截止；缺省时子进程用自己的 SWEEP_DEADLINE_MS。
  // 这里绝不能把入口侧的 6000ms 顺手套给子进程 —— 那会让 detached 的那次清扫在 6s 被截断，
  // 于是天天报"未确认"。
  const { openclawHome, days, dryRun, roots, sweepDeadlineMs } = opts;
  const dir = stateDir(openclawHome);
  const failure = readFailure(dir);
  const state = { job: 'tmp-gc', mode: 'entry', days, spawned: false, alreadyRunning: false, alarm: !!failure, at: Date.now() };

  if (dryRun) {
    state.dryRun = true;                       // dry-run 入口：只看标记，绝不派活
  } else {
    const lock = acquireLock(dir);
    if (!lock.ok) {
      state.alreadyRunning = true;
      state.heldBy = lock.heldBy;
    } else {
      releaseLock(dir);                        // 锁由被拉起的那次 --sweep 自己再取
      const args = [fileURLToPath(import.meta.url), '--sweep', '--openclaw-home', openclawHome, '--days', String(days)];
      if (Number.isFinite(sweepDeadlineMs)) args.push('--deadline-ms', String(sweepDeadlineMs));
      for (const r of roots || []) args.push('--root', r);
      try {
        spawnFn(process.execPath, args, { detached: true, stdio: 'ignore', env: process.env }).unref();
        state.spawned = true;
      } catch (e) {
        state.spawned = false;
        state.spawnError = String((e && e.message) || e);
        writeFailure(dir, { at: state.at, message: alarmText({}), state: { spawnError: state.spawnError } });
        return { fire: true, message: alarmText({}), state };
      }
    }
  }

  const env = { fire: !!failure || !!state.spawnError };
  if (env.fire) env.message = (failure && failure.message) || alarmText({});
  env.state = state;
  return env;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────
// main-guard：经 realpath 归一后比较，符号链接调用亦能命中（同 patrol-scan.mjs）
let IS_MAIN = false;
try {
  IS_MAIN = fs.realpathSync(new URL(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
} catch {
  IS_MAIN = false;
}

if (IS_MAIN) {
  const o = parseArgs(process.argv.slice(2));
  const roots = o.roots.length ? o.roots.map((r) => path.resolve(r)) : defaultRoots(o.openclawHome);
  const deadlineMs = o.deadlineMs ?? (o.sweep ? SWEEP_DEADLINE_MS : DEFAULT_DEADLINE_MS);
  const opts = { roots, days: o.days, dryRun: o.dryRun, deadlineMs, openclawHome: o.openclawHome, sweepDeadlineMs: o.deadlineMs };
  const env = o.sweep ? runSweep(opts) : runEntry(opts);
  if (o.json) {
    console.log(JSON.stringify(env));
  } else if (o.sweep) {
    console.log(
      `${o.dryRun ? 'dry-run (nothing deleted): would-delete' : 'deleted'}=${env.deleted ?? 0}` +
      ` failed=${env.failed ?? 0} bytes=${env.bytes ?? 0} roots=${(env.roots || []).length} (days=${o.days})`
    );
  } else {
    console.log(
      `entry: spawned=${env.state.spawned} already-running=${env.state.alreadyRunning} ` +
      `alarm=${env.state.alarm} fire=${env.fire} (days=${o.days})`
    );
  }
}
