#!/usr/bin/env node
/**
 * lane-isolation.mjs — 同仓并发 lane 的**自动隔离判定**（T-20261012-022948-2）
 *
 * 为什么存在（实证）：`T-20261010-074754-2` 交付了隔离**机制**（`scripts/lane-worktree.mjs`）与
 * SOP，但它是**显式纪律**——「dispatch 侧按 lane 分 worktree」靠派单者（Elon）**记忆**遵守。
 * 2026-10-12 实证未遵守：`T-20261012-015340` §6.3（本仓非终态卡 14 张、in_progress 7 张；验证期间
 * 工作树带他 lane 未提交改动，绿在此 tree 上跑出）+ `T-20261012-002049`（与在跑 lane 同写
 * `CHANGELOG.md`）。本模块把该纪律**自动化**：`spawn-lane.mjs` 起会话前判定「本 lane 的仓是否已有
 * 并发非终态 lane」，命中即**自动**建隔离 worktree，并把本 lane 的 cwd 指向该树。
 *
 * 判定**复用既有政策**（不重定政策、不新增 PROTOCOL 条款）：
 *   ① 同**文件**（写集重叠）⇒ **严格串行**：拒绝起会话（`PROTOCOL §⑥.3` case ②；写集口径 =
 *      卡 `writes`，缺省退化 `target`，见 `guides/task-interface.md §2` 与 `scripts/samefile-guard.mjs`）。
 *      ⚠ **退化到仓根本身（或仓根祖先）的 `target` 不是写集**——它命中每一张同仓卡，按它拒绝会把
 *      整仓串行化（实测本仓所有非终态卡都只写 `target: <repo>`）；此类条目只贡献「同仓」信号。
 *      分工：**粗信号（target 退化）⇒ 隔离；精确信号（`writes` / 仓内具体路径）⇒ 串行**。
 *   ② 同**仓**不同文件 ⇒ 可并行，但**须隔离树**（`guides/worktree-isolation-sop.md §1/§3`）；
 *   ③ 只读角色（`role=review`）与「已在 linked worktree」⇒ **不**隔离（SOP §3：隔离**写者**，
 *      不隔离读者；复核靠 pin commit，不靠占树）。
 *   非终态 = `todo | in_progress | blocked | in_review`（可写四态；`done`/`canceled` 终态）。
 *
 * 只读性：本模块自身只用**只读 git**（`rev-parse` / `worktree list`）与只读扫描（读卡不写卡）；
 * 唯一的写动作是把具体创建**委托**给 `lane-worktree.mjs`（幂等、禁一切破坏性 git）。**绝不写卡、
 * 绝不改 registry**——本模块不产生卡面副作用。
 *
 * 用法（由 `spawn-lane.mjs` 调用；亦可单测直接调）：
 *   const plan = laneIsolationPlan({ taskId, seg, cwd, fm, role, enabled });
 *   const applied = applyLaneIsolation(plan, { dryRun });
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TASKS_DIR, CARD_ID_RE, TEAM_ROOT, parseFrontmatter, getProject } from './lib.mjs';
import { NON_TERMINAL, resolveWriteSet } from './samefile-guard.mjs';
import { laneWorktree } from './lane-worktree.mjs';

/** 回退开关（env）：`OPENCLAW_LANE_ISOLATION=0|off|false` ⇒ 关闭自动隔离（回到显式纪律路径）。 */
export const ISOLATION_ENV = 'OPENCLAW_LANE_ISOLATION';

/** env 值 → 是否启用自动隔离（缺省/空 = 启用）。 */
export function isolationEnabled(value = process.env[ISOLATION_ENV]) {
  if (value == null || String(value).trim() === '') return true;
  return !/^(0|off|false|no|disable|disabled)$/i.test(String(value).trim());
}

/**
 * 该 lane 的 worktree 名（**确定性** ⇒ 幂等复用、可人工清理）。
 * `lane = <card>-<seg>`（`seg` 非法字符折成 `-`），如 `T-20261012-022948-2-seg1`。
 * 卡 id 已过 `CARD_ID_RE`（路径安全）；顺手净化 seg 以兜住异常 seg 名（如含 `/` 的旧式 seg）。
 */
export function laneNameFor(taskId, seg) {
  const s = String(seg == null ? '' : seg).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return s ? `${taskId}-${s}` : String(taskId);
}

/** git 调用（只读；本模块不使用任何破坏性子命令） */
function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * 最近的**已存在**祖先目录（卡 `target` 可能指向尚不存在的**文件/资源**路径——如一张声明要新建的
 * 文件；不向上收敛就会把该卡误判成「不在任何仓」）。
 * @returns {string|null}
 */
export function nearestExistingDir(dir) {
  let p = dir ? path.resolve(String(dir)) : '';
  for (;;) {
    if (p && fs.existsSync(p)) {
      try {
        if (fs.statSync(p).isDirectory()) return p;
        p = path.dirname(p); // 存在但是**文件** ⇒ 取其父目录
        continue;
      } catch {
        return null;
      }
    }
    const up = path.dirname(p);
    if (!up || up === p) return null; // 到根仍不存在 ⇒ 无
    p = up;
  }
}

/**
 * 目录 → git 主仓信息（`linked worktree` 亦解析回**主** checkout）。
 * 不存在的路径 ⇒ 向上收敛到最近已存在祖先再探测（见 `nearestExistingDir`）。
 * @returns {{root:string, gitDir:string, commonDir:string, linkedWorktree:boolean}|null} 非 git 仓 ⇒ null
 */
export function gitInfo(dir) {
  const probe = nearestExistingDir(dir);
  if (!probe) return null;
  const gd = git(probe, ['rev-parse', '--path-format=absolute', '--git-dir']);
  if (gd.code !== 0) return null;
  const cd = git(probe, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (cd.code !== 0) return null;
  const gitDir = gd.stdout.trim();
  const commonDir = cd.stdout.trim();
  if (!gitDir || !commonDir || path.basename(commonDir) !== '.git') return null; // bare / 异常布局 ⇒ 拒绝
  try {
    if (!fs.statSync(commonDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return { root: path.dirname(commonDir), gitDir, commonDir, linkedWorktree: gitDir !== commonDir };
}

/** project 名 → 项目根（memo：同一次判定里同一 project 只经 ACL 取数一次） */
function projectBaseFactory() {
  const cache = new Map();
  return (name) => {
    const key = String(name || '__team__');
    if (cache.has(key)) return cache.get(key);
    let base = null;
    try {
      const meta = getProject(key);
      base = meta && meta.root ? path.resolve(meta.root) : TEAM_ROOT;
    } catch {
      base = null; // 未注册/取数失败 ⇒ 该卡不参与同仓判定（绝不猜）
    }
    cache.set(key, base);
    return base;
  };
}

/**
 * 该卡的**本 lane cwd**（project 根 + target 叠加）。与 `scripts/spawn-lane.mjs resolveCwd` **同规则**
 * （`PROTOCOL §⑥` cwd 归一）：绝对 target 直接生效、相对 target 落在项目根下、无 target 取项目根。
 * 两处一致性由测试锁定（`tests/lane-isolation.test.mjs` "cwd 口径同源"）。
 * @returns {string|null} project 未注册 ⇒ null
 */
export function cardCwd(fm = {}, base = undefined) {
  const baseOf = typeof base === 'function' ? base : projectBaseFactory();
  const root = baseOf(fm.project || '__team__');
  if (!root) return null;
  const target = fm.target == null ? '' : String(fm.target).trim();
  return target ? path.resolve(root, target) : root;
}

/** 卡 id 列表 → 便于拒绝原因可读（最多 3 个，超出加 `+N`） */
const idList = (ids) => (ids.length > 3 ? `${ids.slice(0, 3).join(',')}+${ids.length - 3}` : ids.join(','));

/**
 * 扫描看板**非终态**卡（只读；排除 `exclude`）。
 * 与 `scripts/samefile-guard.mjs` 的扫描口径一致（同 `NON_TERMINAL` 集合），但**不过滤**无写集的卡——
 * 无写集只影响「同文件」判定，不影响「同仓」判定（一张没声明写集的非终态卡仍是同仓并发写者）。
 * @returns {{id:string,status:string,fm:object,writes:string[]}[]}
 */
export function scanNonTerminal(exclude = '') {
  const out = [];
  if (!fs.existsSync(TASKS_DIR)) return out;
  for (const f of fs.readdirSync(TASKS_DIR)) {
    if (!f.endsWith('.md') || !CARD_ID_RE.test(f.slice(0, -3))) continue;
    const id = f.slice(0, -3);
    if (id === exclude) continue;
    let fm;
    try {
      fm = parseFrontmatter(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')).fm;
    } catch {
      continue;
    }
    if (!fm || !fm.id || !NON_TERMINAL.has(String(fm.status))) continue;
    out.push({ id, status: String(fm.status), fm, writes: resolveWriteSet(fm) });
  }
  return out;
}

/**
 * 写集条目 → 是否「文件级」资源（足以支撑**同文件串行**硬拒绝）。
 *
 * 退化为**仓根本身**（或仓根的祖先）的 `target` 只是「仓指定」，不是写集：它命中**每一张**同仓卡，
 * 若据此拒绝就等于把整仓串行化（与 `PROTOCOL §⑥.3` parallelism-first 正相反）。实测本仓
 * （2026-10-12）**全部**非终态卡都只声明 `target: <repo>`、零 `writes` ⇒ 按粗口径拒绝会拦下
 * **每一张**卡（含本卡自身）。故此类条目只贡献「同仓」信号，不贡献「同文件」冲突。
 *
 * 由此确立本模块的分工：**粗信号（target 退化）⇒ 隔离**；**精确信号（`writes`，或指向仓内的
 * 具体 target）⇒ 串行**。`scripts/samefile-guard.mjs` 的粗口径保持不变（它只**告警**，不阻断）。
 */
function isFileLevel(entry, mainRepo) {
  const abs = path.resolve(mainRepo, String(entry));
  if (abs === mainRepo) return false;                       // target = 仓根
  if (mainRepo.startsWith(abs + path.sep)) return false;     // 仓根的祖先（如 /Users/tanyu/Documents）
  return true;
}

/** 同写集卡（写集为精确路径交集；口径同 `samefile-guard.mjs`：空写集不参与；仓根退化条目不算冲突） */
export function samefileOverlaps(selfWrites = [], others = [], mainRepo = '') {
  const mine = (selfWrites || []).map(String).filter(Boolean);
  if (!mine.length) return [];
  return others
    .filter((o) => (o.writes || []).length)
    .map((o) => ({
      card: o.id,
      overlap: mine.filter((w) => o.writes.includes(w) && (mainRepo ? isFileLevel(w, mainRepo) : true)),
    }))
    .filter((c) => c.overlap.length);
}

/**
 * 判定本 lane 是否需要隔离（**纯判定 + 只读预演**；不落盘、不写卡、不起进程）。
 *
 * @param {{taskId?:string, seg?:string, role?:string, cwd?:string, fm?:object,
 *          enabled?:boolean, dryRun?:boolean}} input
 *   `cwd` = 本 lane 的解析后工作目录（`spawn-lane` 的 `resolveCwd` 结果）；
 *   `enabled=false`（`--no-isolate` / env 关闭）⇒ 直接 `disabled`（回退开关）。
 * @returns {{mode:'disabled'|'none'|'already_isolated'|'serialize'|'blocked'|'worktree', ...}}
 *   `serialize` = 同文件冲突 ⇒ 调用方**拒绝起会话**（显式串行）；
 *   `blocked`   = 隔离预演被 `lane-worktree.mjs` 拒绝（如路径被占/分支已在别处检出）⇒ **fail-closed**；
 *   `worktree`  = 应予隔离（`path`/`branch` 来自 `lane-worktree --dry-run`，可被调用方直接复用）。
 */
export function laneIsolationPlan({
  taskId = '', seg = '', role = 'exec', cwd = '', fm = null,
  enabled = true, dryRun = false,
} = {}) {
  if (!enabled) return { mode: 'disabled', reason: 'switch_off' };
  // ③ 只读角色不隔离（SOP §3：隔离写者，不隔离读者——复核靠 pin commit）
  if (role === 'review') return { mode: 'none', reason: 'read_only_role' };
  const info = gitInfo(cwd);
  if (!info) return { mode: 'none', reason: 'not_a_git_repo' };
  // ③ 已在 linked worktree ⇒ 已隔离（幂等；尊重既有手工/显式纪律建的树，不叠床架屋）
  if (info.linkedWorktree) return { mode: 'already_isolated', main_repo: info.root, path: path.resolve(cwd) };

  const baseOf = projectBaseFactory();
  const lanes = [];
  for (const other of scanNonTerminal(taskId)) {
    const oc = cardCwd(other.fm, baseOf);
    if (!oc) continue;
    const oi = gitInfo(oc);
    if (!oi || oi.root !== info.root) continue; // 不同仓 ⇒ 与本 lane 的污染无关
    lanes.push({ id: other.id, status: other.status, writes: other.writes, cwd: oc });
  }
  if (!lanes.length) return { mode: 'none', reason: 'no_concurrent_lane', main_repo: info.root };

  // ① 同文件 ⇒ 严格串行（与隔离**不是**同一件事：隔离树不会让同文件的两次写自动合流）
  const conflicts = samefileOverlaps(resolveWriteSet(fm || {}), lanes, info.root);
  if (conflicts.length) {
    return {
      mode: 'serialize',
      reason: 'same_file_conflict',
      main_repo: info.root,
      conflicts,
      lanes: lanes.map((l) => l.id),
    };
  }

  // ② 同仓不同文件 ⇒ 隔离树（预演；`--dry-run` 与真跑走同一条入口，故拒绝可被预演）
  const lane = laneNameFor(taskId, seg);
  const pre = laneWorktree({ repo: info.root, lane, dryRun: true });
  if (!pre.ok) return { mode: 'blocked', reason: pre.reason, main_repo: info.root, lane, lanes: lanes.map((l) => l.id) };
  return {
    mode: 'worktree',
    main_repo: info.root,
    lane: pre.lane,
    branch: pre.branch,
    path: pre.path,
    action: pre.action,
    head: pre.head ?? null,
    lanes: lanes.map((l) => l.id),
    dryRun,
  };
}

/**
 * 落实判定结果：仅 `worktree` 模式有副作用（委托 `lane-worktree.mjs`；`dryRun` ⇒ 零副作用）。
 * @returns {{ok:true, isolation:object}|{ok:false, reason:string}}
 *   失败 ⇒ 调用方 **fail-closed**（拒绝起会话）：把「无法隔离」读成「绿」正是本卡要消灭的失败模式。
 */
export function applyLaneIsolation(plan = {}, { dryRun = false } = {}) {
  if (plan.mode !== 'worktree') return { ok: true, isolation: { mode: plan.mode, reason: plan.reason ?? null, ...(plan.main_repo ? { main_repo: plan.main_repo } : {}), ...(plan.lanes ? { same_repo_lanes: plan.lanes } : {}), ...(plan.conflicts ? { conflicts: plan.conflicts } : {}) } };
  const base = {
    mode: 'worktree',
    lane: plan.lane,
    branch: plan.branch,
    path: plan.path,
    main_repo: plan.main_repo,
    same_repo_lanes: plan.lanes || [],
    head: plan.head ?? null,
  };
  if (dryRun) return { ok: true, isolation: { ...base, action: plan.action, applied: false } };
  const r = laneWorktree({ repo: plan.main_repo, lane: plan.lane, branch: plan.branch, path: plan.path });
  if (!r.ok) return { ok: false, reason: r.reason };
  return {
    ok: true,
    isolation: { ...base, action: r.action, applied: r.action === 'created', head: r.head ?? base.head },
  };
}
