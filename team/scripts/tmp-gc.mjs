#!/usr/bin/env node
// tmp-gc.mjs — 临时文件回收（PROTOCOL §⑬.9）
// 用法: node tmp-gc.mjs [--days N] [--dry-run] [--json]
//                       [--root <path>]... [--openclaw-home <path>] [--deadline-ms N]
//   默认 N=14。
//   默认根族 = 已存在的 $OPENCLAW_HOME/workspace-*/.tmp + $OPENCLAW_HOME/tmp
//            + $OPENCLAW_HOME/team/tmp（--root 可重复，给了就只用给的）。
// 规则: 根的**内部**、mtime 早于 N 天的**普通文件** ⇒ 删除；随后自下而上修剪因此变空的目录
//       （止步于根，绝不删根本身）。
// 模式: 默认 = 写操作（真删）。--dry-run = 真只读：不 unlink、不 rmdir、不建目录、不碰 mtime
//       （可安全用于巡检/首次试跑）。
// 输出: 裸跑 = 一行人读文本；--json = 单行 JSON 信封（作业入口 providers.json 用这个）。
// 失败闭合：根/子目录读不了、或任一 unlink 失败 ⇒ {"fire":true,"message":…}，让
//       上层唤醒 leader 处理；正常的清扫（哪怕删了很多）⇒ fire:false，零成本静默。
//
// 为什么根族用 glob 而不是硬编码角色表：① 仓内不再出现 install.sh 角色表的第二份副本
//    （两份名单必然漂移）；② 主机上任何额外的 workspace-* 目录也自动覆盖，无需改脚本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DAYS = 14;
/** 内部枚举截止（ms）。作业预算 = OPENCLAW_TEAM_EVAL_TIMEOUT_MS(8000) − EVAL_EMIT_RESERVE_MS(500)；
 *  留足余量，保证再大的树也能在预算内出结论（超时即停止枚举并照常 emit，state.deadlineHit=true）。 */
export const DEFAULT_DEADLINE_MS = 6000;

/**
 * 解析 CLI。
 * `--days` 的缺省/畸形值一律回落到默认（token 形态同 archive.mjs），绝不产生"无界"。
 */
export function parseArgs(argv = []) {
  const val = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
  };
  const roots = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--root' && argv[i + 1] != null) roots.push(argv[i + 1]);
  const daysRaw = Number(val('--days', DEFAULT_DAYS));
  const dlRaw = Number(val('--deadline-ms', process.env.OPENCLAW_TEAM_TMPGC_DEADLINE_MS ?? DEFAULT_DEADLINE_MS));
  return {
    days: Number.isFinite(daysRaw) && daysRaw >= 0 ? daysRaw : DEFAULT_DAYS,
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    roots,
    openclawHome: path.resolve(val('--openclaw-home', process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'))),
    deadlineMs: Number.isFinite(dlRaw) && dlRaw > 0 ? dlRaw : DEFAULT_DEADLINE_MS,
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
    catch (e) { res.failed++; res.failures.push({ path: t.path, error: String(e && e.code || e) }); }
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
    env.message = `[openclaw-team] tmp-gc could not confirm the scratch cleanup: unreadable=${plan.unreadable.length} refused=${plan.refused.length} unlink-failed=${res.failed}. Check permissions on the scratch roots (workspace-*/.tmp, ~/.openclaw/tmp, ~/.openclaw/team/tmp) and re-run.`;
  }
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
  const env = gc({ roots, days: o.days, dryRun: o.dryRun, deadlineMs: o.deadlineMs });
  if (o.json) {
    console.log(JSON.stringify(env));
  } else {
    console.log(
      `${o.dryRun ? 'dry-run (nothing deleted): would-delete' : 'deleted'}=${env.deleted}` +
      ` failed=${env.failed} bytes=${env.bytes} roots=${env.roots.length} (days=${o.days})`
    );
  }
}
