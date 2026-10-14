#!/usr/bin/env node
/**
 * spawn-lane.mjs — 「新 lane 起会话」的**单一强制入口**（T-20261010-052210）
 *
 * 为什么存在：绕过 ACL 直跑 `claude -p` 会同时踩两个坑（实证）——
 *   ① registry 有 running（pid 存活）而卡内 `## Sessions` 缺失 ⇒ `check-sessions` 报 `registry_only`（硬失败）；
 *   ② workspace/<id>/handoff.md 是手写件（缺四锚）⇒ `check-handoff` 失败。
 * 本入口把「claim → handoff 自检 → spawn → session-set（卡 + registry 同写）」收敛为**一条命令**，
 * 任一步失败即拒绝起会话（绝不半登记）。
 *
 * 语义（契约）：
 *   入参：<card> <owner> [seg=seg1] [backend=claude|codex] [phase=<p>] [role=exec|review] [--review] [--dry-run] [--help]
 *   ① 解析卡（ACL `task.read`）；**按 role 分派状态口径**：
 *      - role=exec（默认）：断言 status=in_progress && claimed_by=owner（status=ready/todo 时自动 claim）；
 *        in_review ⇒ 拒绝并提示改用复核 lane（`status_not_spawnable(in_review):use_role=review`）。
 *      - role=review（复核 lane，`--review` 等价）：仅接受 status=in_review；**不 claim、不校验 claimed_by**
 *        （复核人 ≠ 实施人）；未显式 seg= 时取 `segR1`（避开执行侧 seg1 的行 upsert 撞名，见 sop §Review lanes）。
 *   ①b 同卡同 seg 防双跑：卡内 `## Sessions` 该 seg 行 / registry 该卡 `phase=seg` 条目若
 *      `status=running` **且 pid 存活** ⇒ 拒绝二次 spawn（`session_running(...):reuse_existing`，零副作用），
 *      提示复用既有 session（与 poll 防双跑守卫同口径）；僵尸行（pid 已死）不占用，交 reconcile。
 *   ①c **同仓并发 lane 自动隔离**（T-20261012-022948-2；判定见 `scripts/lane-isolation.mjs`）：
 *      起会话前判定本 lane 的仓是否已有**并发非终态 lane**，复用既有政策（不重定政策）——
 *        · 同**文件**（写集重叠）⇒ **严格串行**：拒绝起会话（`lane_samefile_conflict(...):serialize`，
 *          零副作用；`PROTOCOL §⑥.3` case ②）；
 *        · 同**仓**不同文件 ⇒ **自动**建隔离 worktree 并把本 lane 的 cwd 指向它（`lane-worktree.mjs`）；
 *        · 只读角色（role=review）/ 非 git 仓 / 无并发 / 已在 linked worktree ⇒ 不动（兼容路径不变）。
 *      隔离**失败即 fail-closed**（`lane_isolation_failed(...)`）：把「无法隔离」读成「绿」正是本卡要消灭的
 *      失败模式。回退开关：`--no-isolate` 或 env `OPENCLAW_LANE_ISOLATION=0`（回到显式纪律路径）。
 *      ①c-b **续接定基**（T-20261014-112936）：隔离树的基准 ⇏ 恒为 `HEAD`。**续接上一 seg** 时
 *      （多 seg 续做 / 打回续做）以**上一 seg 的 lane 分支 tip**为 base —— 派单者此前只能靠人工
 *      `lane-worktree --base <prev-tip>` 手建树绕开（`T-20261013-154930-2` 实证：seg2 默认建在 HEAD ⇒
 *      `merge-base --is-ancestor <seg1 tip> → NO`，前段产物被丢）。首 seg / 无前驱 ⇒ 仍 `HEAD`（不变）；
 *      显式 `--base <ref>` 优先且**不可解析即拒绝**（显式意图绝不静默回落）。证据在输出 `isolation.base`。
 *   ② 并发额度：linus/jobs running>=8 或 turing running>=3 ⇒ 拒绝；
 *   ③ cwd：由 project 经 ACL 解析（`__team__` ⇒ team 根），叠加 target；若 ①c 判定需隔离，
 *      cwd 改为该 lane 的隔离 worktree（卡 `target` **不**回写：`target` 是 `samefile-guard` 写集退化口径的
 *      输入，回写绝对 worktree 路径会把同文件守卫静默拆掉；有效目标见输出 JSON `isolation.path`）；
 *   ④ handoff 自检：workspace/<id>/ 确保存在；handoff.md 缺失 ⇒ 用 ACL `task.handoff` 生成（不覆盖）；
 *      **已存在但缺四锚 ⇒ 拒绝起会话**（exit≠0，明报缺哪个锚）；
 *   ④b settings 预置（幂等）：确保 workspace/<id>/.claude/settings.json 存在（`--settings` 的目标；
 *      缺则 claude 起会话秒退「Settings file not found」）；已存在 ⇒ **绝不覆盖**；
 *   ⑤ session id = ACL `task.session-id <card> <owner> <seg>`（确定性 UUIDv5）；
 *   ⑥ 起子会话：Node `child_process.spawn(..., { detached:true, stdio:[ignore,fd,fd] })` + `unref()`
 *      ——等价于 Python `subprocess.Popen(..., start_new_session=True)`（macOS 无 `setsid`；勿用 `nohup … &`）；
 *   ⑦ 起后**立即** ACL `task.session-set`（seg/owner/backend/phase/pid/log/status=running；卡 + registry 同写）。
 *   `--dry-run`：只做校验 + 打印计划命令行，**不起进程、不写 registry/卡/handoff/settings**。
 *
 * 输出：末行 JSON `{ok, role, settings, isolation, session_id, pid, cwd, handoff, log, cmd, …}`（机读）；失败 exit≠0（用法 2 / 拒绝 1）。
 * 用法错误：未知旗标 / **多余的裸位置参数**（如把 `--dry-run` 误写成 `dry-run`）⇒ exit 2，绝不静默忽略。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { TEAM_ROOT, CARD_ID_RE, AGENTS, getProject } from './lib.mjs';
import { anchorGaps } from './check-handoff.mjs';
import { loadRegistry, isPidAlive } from './registry.mjs';
import { isolationEnabled, laneIsolationPlan, applyLaneIsolation } from './lane-isolation.mjs';
import { read as aclRead, claim as aclClaim, sessionSet, sessionIdFor, handoff as aclHandoff } from '../skills/task-ops/lib/task.mjs';

/** 并发额度（PROTOCOL §⑥ clause 2）：linus/jobs < 8；turing < 3；其余默认 8 */
export const RUNNING_CAPS = { linus: 8, jobs: 8, turing: 3 };
export const DEFAULT_CAP = 8;
export function capFor(owner) {
  return RUNNING_CAPS[owner] ?? DEFAULT_CAP;
}

/** 角色：exec（执行 lane，默认）| review（复核 lane，对在审卡） */
export const ROLES = ['exec', 'review'];
/**
 * 复核 lane 未显式给 seg= 时的默认 seg 名。
 * 取 `segR1` 而非 `seg1`：卡内 `## Sessions` 以 `seg:<seg> ·` 为 upsert 键，
 * 复核若复用执行侧 seg1 会**覆盖**执行 lane 的登记行（丢审计轨迹）——既有 Turing 复核
 * 一律用独立 seg（`segR1-replay` / `seg2-container` 等），此处默认值与该约定对齐。
 */
export const REVIEW_SEG = 'segR1';

/**
 * `workspace/<id>/.claude/settings.json` 的幂等预置内容。
 * 宽松 allow（读/写/改 + 常用 Bash），与既有 workspace 件同口径；缺此文件 ⇒
 * `claude --settings <path>` 前置校验失败，起会话秒退「Settings file not found」。
 */
export const DEFAULT_SETTINGS = {
  permissions: {
    allow: [
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite',
      'Bash(node:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(git:*)', 'Bash(ls:*)', 'Bash(cat:*)',
      'Bash(mkdir:*)', 'Bash(rm:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(chmod:*)', 'Bash(ln:*)',
      'Bash(touch:*)', 'Bash(mktemp:*)', 'Bash(diff:*)', 'Bash(wc:*)', 'Bash(echo:*)', 'Bash(printf:*)',
      'Bash(grep:*)', 'Bash(sed:*)', 'Bash(awk:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(find:*)',
      'Bash(sort:*)', 'Bash(uniq:*)', 'Bash(cut:*)', 'Bash(tr:*)', 'Bash(xargs:*)', 'Bash(which:*)',
      'Bash(env:*)', 'Bash(date:*)', 'Bash(true:*)', 'Bash(test:*)', 'Bash(basename:*)', 'Bash(dirname:*)',
      'Bash(realpath:*)', 'Bash(shasum:*)', 'Bash(sh:*)', 'Bash(bash:*)', 'Bash(python3:*)',
    ],
  },
};
export const DEFAULT_SETTINGS_JSON = `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`;

/**
 * 该 owner 当前活跃子会话数（并发额度口径）。
 * 口径 = registry 中 `owner==owner && status==='running'` **且 pid 存活**；
 * 死 pid 的 running 行是僵尸（reconcile 职责），不占用额度，避免误拒。
 */
export function runningCount(owner, { registry = null } = {}) {
  const entries = registry == null ? loadRegistry({ includeLegacy: false }) : registry;
  return entries.filter((e) => e.owner === owner && e.status === 'running' && isPidAlive(e.pid)).length;
}

/** cwd 解析：project 经 ACL → 根（`__team__` 取 team 根）→ 叠加 target（绝对 target 直接生效） */
export function resolveCwd(fm = {}) {
  const meta = getProject(fm.project || '__team__');
  const base = meta && meta.root ? path.resolve(meta.root) : TEAM_ROOT;
  const target = fm.target == null ? '' : String(fm.target).trim();
  return target ? path.resolve(base, target) : base;
}

/**
 * 卡内 `## Sessions` 段已登记的条目（复核 lane 的 seg 撞名守卫 + 防双跑守卫用；只读解析，不写卡）。
 * 行格式（task-interface §9）：`- seg:… · owner:… · backend:… · id:… · phase:… · status:… · pid:… · <ts>`。
 * 解析为 `{seg, owner, backend, id, phase, status, pid, …}`（键值对通用提取；无键的尾部时间戳忽略）。
 * 旧行/手写行缺字段 ⇒ 该字段缺席（不抛、不猜）。
 */
export function sessionsBySeg(body) {
  const lines = String(body || '').split('\n');
  const hi = lines.findIndex((l) => l.trim() === '## Sessions');
  if (hi < 0) return [];
  const out = [];
  for (let i = hi + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    const m = /^- seg:(\S+) ·/.exec(lines[i]);
    if (!m) continue;
    const entry = {};
    for (const part of lines[i].replace(/^-\s*/, '').split(' · ')) {
      const kv = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(part.trim());
      if (kv) entry[kv[1]] = kv[2].trim();
    }
    entry.seg = m[1]; // seg 恒以行首 `seg:<x> ·` 为准（即便后面还有名为 seg 的部件）
    out.push(entry);
  }
  return out;
}

/**
 * 同卡同 seg 防双跑判据（Elon 2026-10-11 并入本治理卡；**与 poll 防双跑守卫同口径**：
 * 登记 `status=running` **且 pid 存活**）。两个登记源任一命中即视为「已有在跑的会话」：
 *   ① 卡内 `## Sessions` 该 seg 行（seg 语义精确，含 id 供 resume）；
 *   ② registry 该卡 `status=running` 且 pid 存活、且 `phase===seg` 的条目
 *      （registry 条目无 `seg` 字段，`phase` 即 spawn 链路写入的 seg —— 见 sessionSet 的 regEntry）。
 * 僵尸行（pid 已死）**不**算占用（reconcile 的职责），避免误拒恢复。
 * @param {{taskId: string, seg: string, cardBody?: string, registry?: object[]|null}} input
 * @returns {{blocked: boolean, session?: object}}
 */
export function runningLaneBlocker({ taskId, seg, cardBody = '', registry = null }) {
  const byCard = sessionsBySeg(cardBody).find(
    (s) => s.seg === seg && s.status === 'running' && isPidAlive(Number(s.pid)),
  );
  if (byCard) return { blocked: true, session: { ...byCard, pid: Number(byCard.pid), source: 'card' } };
  const reg = registry == null ? loadRegistry() : registry;
  const byReg = reg.find(
    (e) => e.task_id === taskId && e.status === 'running' && e.phase === seg && isPidAlive(e.pid),
  );
  if (byReg) return { blocked: true, session: { ...byReg, seg, source: 'registry' } };
  return { blocked: false };
}

/**
 * 幂等预置 `workspace/<id>/.claude/settings.json`（`--settings` 的目标）。
 * 已存在 ⇒ **绝不覆盖**（`exists`，保住卡内既有自定义）；dry-run 且缺 ⇒ `would_create`（不落盘）。
 * @returns {{state:'exists'|'created'|'would_create', path:string}}
 */
export function ensureWorkspaceSettings(wsDir, { dryRun = false } = {}) {
  const settingsDir = path.join(wsDir, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  if (fs.existsSync(settingsPath)) return { state: 'exists', path: settingsPath };
  if (dryRun) return { state: 'would_create', path: settingsPath };
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsPath, DEFAULT_SETTINGS_JSON);
  return { state: 'created', path: settingsPath };
}

/**
 * 解析 CLI 参数（位置：card owner；k=v：seg/backend/phase/role/base；带值 flag：--base；开关：--review/--dry-run/--no-isolate/--help）
 * `--base <ref>` 与 `base=<ref>` 等价（前者形状与 `lane-worktree.mjs` 对齐，见 worktree-isolation-sop §5）。
 */
export function parseArgs(argv) {
  const pos = [];
  const kv = {};
  let dryRun = false;
  let help = false;
  let isolate = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--no-isolate') { isolate = false; continue; } // 回退开关（等价 OPENCLAW_LANE_ISOLATION=0）
    if (a === '--review') { kv.role = 'review'; continue; } // 等价 role=review
    if (a === '--help' || a === '-h') { help = true; continue; }
    if (a === '--base') { // 带值旗标：缺值 / 值形如 `--x` ⇒ 用法错误（绝不把下一个旗标吞成值）
      const v = argv[++i];
      if (v == null || v.startsWith('--')) return { ok: false, reason: `missing_value:${a}` };
      kv.base = v;
      continue;
    }
    if (a.startsWith('--')) return { ok: false, reason: `unknown_flag:${a}` };
    const i2 = a.indexOf('=');
    if (i2 > 0 && !a.startsWith('=')) { kv[a.slice(0, i2)] = a.slice(i2 + 1); continue; }
    pos.push(a);
  }
  // 位置参数只有 `card owner` 两个；**多余的裸位置参数一律用法错误**，绝不静默忽略
  // （实证 T-20261012-022948-2：把 `--dry-run` 误写成裸 `dry-run` ⇒ 被当多余位置参数吞掉 ⇒
  //  **真的起了会话**（真建 worktree + 真 spawn + 真登记），而调用者以为自己只做了预演。
  //  「未确认」读成「已预演」＝ 本治理线一直在消灭的失败模式。）
  if (pos.length > 2) return { ok: false, reason: `unexpected_positional:${pos[2]}` };
  return {
    ok: true,
    help,
    dryRun,
    isolate,
    card: pos[0] || '',
    owner: pos[1] || '',
    // 未显式给 seg ⇒ ''，由 spawnLane 按 role 取默认（exec=seg1 / review=segR1）
    seg: kv.seg || '',
    backend: kv.backend || 'claude',
    role: kv.role || 'exec',
    phase: kv.phase || kv.seg || '',
    base: kv.base || '',
  };
}

const BACKENDS = ['claude', 'codex'];
const backendBin = (backend) =>
  (backend === 'codex'
    ? process.env.OPENCLAW_CODEX_BIN || 'codex'
    : process.env.OPENCLAW_CLAUDE_BIN || 'claude');

/**
 * 子会话提示词：先读背景包（handoff），再执行卡。子会话不读牌面（PROTOCOL §⑥ clause 7）。
 * 隔离开启时追加一行工作树纪律：本 lane 在**自己的 worktree** 上，提交落在 lane 分支，
 * 收尾须回报 branch + sha 供整合（否则隔离树的产物无人知道，见 guides/worktree-isolation-sop.md §7）。
 */
export function buildPrompt({ handoffPath, cardPath, reportPath, isolation = null }) {
  const lines = [
    `Read your background pack first: ${handoffPath}`,
    `Task card: ${cardPath}`,
    `Execute the card's Acceptance and write your report to ${reportPath}.`,
  ];
  if (isolation && isolation.mode === 'worktree') {
    lines.push(
      `You are isolated in a lane worktree: ${isolation.path} (branch ${isolation.branch}) — another non-terminal lane is writing the same repo. ` +
      `Commit there with explicit paths, and report the branch + commit sha in your Report so it can be integrated and the worktree removed.`,
    );
  }
  return lines.join('\n');
}

/** 组装子进程命令（argv 数组；claude 参数照 PROTOCOL §⑥ 模板） */
export function buildCommand({ backend, bin, prompt, wsDir, sid, name, team = TEAM_ROOT }) {
  if (backend === 'codex') return { bin, args: ['exec', prompt] };
  return {
    bin,
    args: [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--settings', path.join(wsDir, '.claude', 'settings.json'),
      '--add-dir', wsDir,
      '--add-dir', team,
      '--session-id', sid,
      '--name', name,
    ],
  };
}

/** seg → 序号（seg1 → 1），用于 <owner>-<n>.out.jsonl 命名（与既有约定一致） */
function segNumber(seg) {
  const m = /^seg(\d+)$/.exec(String(seg));
  return m ? Number(m[1]) : null;
}
/** 无 seg 序号时取下一个空闲序号 */
function nextFreeIndex(wsDir, owner) {
  let max = 0;
  try {
    for (const f of fs.readdirSync(wsDir)) {
      const m = new RegExp(`^${owner}-(\\d+)\\.out\\.jsonl$`).exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* 目录不存在 ⇒ 从 1 起 */ }
  return max + 1;
}

const reject = (reason, extra = {}) => ({ ok: false, code: 1, reason, ...extra });
const usage = (reason) => ({ ok: false, code: 2, reason });

/**
 * 执行入口（dry-run 与真实起会话共用同一条校验链）。
 * @param {{card:string,owner:string,seg:string,backend:string,phase:string,role:'exec'|'review',
 *          dryRun:boolean,isolate?:boolean,base?:string}} opts `isolate:false` = 关自动隔离（回退开关，
 *  等价 `--no-isolate`）；`base` = 显式定基（等价 `--base <ref>`），未给则由上一 seg 分支 tip 推导。
 */
export function spawnLane(opts = {}) {
  const { card = '', owner = '', seg: segArg = '', backend = 'claude', dryRun = false, base = '' } = opts;
  const role = opts.role || 'exec';
  // 自动隔离开关：CLI `--no-isolate` 与 env `OPENCLAW_LANE_ISOLATION` 任一关闭即关闭（两者都须为「开」）
  const isolateEnabled = opts.isolate !== false && isolationEnabled();
  // 显式 seg= 优先；否则按 role 取默认（复核 lane 用 segR1，避开执行侧 seg1 的 Sessions 行撞名）
  const seg = segArg || (role === 'review' ? REVIEW_SEG : 'seg1');
  const phase = opts.phase || seg;

  // ---- 参数校验 ----
  if (!card) return usage('missing_card');
  if (!owner) return usage('missing_owner');
  if (!AGENTS.includes(owner)) return usage(`unknown_owner:${owner}`);
  if (!BACKENDS.includes(backend)) return usage(`unknown_backend:${backend}`);
  if (!ROLES.includes(role)) return usage(`unknown_role:${role}`);

  // ---- ① 解析卡（ACL）----
  let c;
  try {
    c = aclRead(card);
  } catch (e) {
    return reject(`card_unreadable:${String(e && e.message ? e.message : e)}`);
  }
  const taskId = c.fm.id || path.basename(c.cardPath, '.md');
  if (!CARD_ID_RE.test(String(taskId))) return reject(`bad_card_id:${taskId}`);
  const cardPath = c.cardPath;
  let claims = [];
  let status = String(c.fm.status || '');

  // ---- ①b 同卡同 seg 防双跑守卫（并入本治理卡；判据同 poll 防双跑守卫：running 登记 + pid 存活）----
  // 已有在跑的会话 ⇒ 拒绝再次 spawn（提示复用既有 session，按 host 口径 resume），绝不双跑。
  // 放在 claim 之前：拒绝路径**零副作用**（不 claim、不写 registry/卡/日志）。
  {
    const hit = runningLaneBlocker({ taskId, seg, cardBody: c.body });
    if (hit.blocked) {
      const s = hit.session || {};
      return reject(
        `session_running(seg=${seg},pid=${s.pid ?? ''},id=${s.id || s.session_id || ''},owner=${s.owner || ''}):reuse_existing`,
        { session: { seg, pid: s.pid ?? null, id: s.id || s.session_id || null, owner: s.owner || null, source: s.source } },
      );
    }
  }
  // ---- ①c cwd 归一 + 同仓并发 lane 的自动隔离**判定**（零副作用；放在 claim 前 ⇒ 拒绝路径零副作用）----
  let baseCwd;
  try {
    baseCwd = resolveCwd(c.fm);
  } catch (e) {
    return reject(`project_unresolved:${String(e && e.message ? e.message : e)}`);
  }
  const isoPlan = laneIsolationPlan({
    taskId, seg, role, cwd: baseCwd, fm: c.fm, enabled: isolateEnabled, dryRun,
    // 续接定基（T-20261014-112936）：既有 seg 登记 + 显式 --base ⇒ 由 lane-isolation 推导建树基准
    sessions: sessionsBySeg(c.body),
    base,
  });
  if (isoPlan.mode === 'serialize') {
    const withIds = isoPlan.conflicts.map((x) => x.card).join(',');
    const overlap = [...new Set(isoPlan.conflicts.flatMap((x) => x.overlap))].join(',');
    return reject(`lane_samefile_conflict(with=${withIds},overlap=${overlap}):serialize`, { isolation: isoPlan });
  }
  if (isoPlan.mode === 'blocked') {
    // fail-closed：隔离预演被拒（路径被占/分支已在别处检出）⇒ 不静默降级回共享 checkout
    return reject(`lane_isolation_failed(${isoPlan.reason}):serialize_or_fix`, { isolation: isoPlan });
  }

  // ---- status / claim 断言（按 role 分派）----
  if (role === 'review') {
    // 复核 lane：只认在审卡；不 claim、不改/不校验 claimed_by（复核人 ≠ 实施人）
    if (status !== 'in_review') return reject(`review_needs_in_review(status=${status})`);
    // seg 撞名守卫：`## Sessions` 以 `seg:<seg> ·` 为 upsert 键，复用他人 seg 会覆盖其登记行
    const clash = sessionsBySeg(c.body).find((s) => s.seg === seg && s.owner && s.owner !== owner);
    if (clash) return reject(`review_seg_taken(seg=${seg},owner=${clash.owner}):use_seg=${REVIEW_SEG}`);
  } else {
    const claimable = status === 'ready' || status === 'todo';
    if (claimable) {
      if (dryRun) {
        claims.push('would_claim');
      } else {
        const r = aclClaim(card, owner);
        if (!r.ok) return reject(`claim_failed:${r.reason}`, { detail: r });
        claims.push(`claimed:${r.mode || 'new'}`);
        c = aclRead(card); // 重读刷新 fm（status=in_progress, claimed_by=owner）
        status = String(c.fm.status || '');
      }
    }
    if (status === 'in_progress') {
      if (c.fm.claimed_by !== owner) {
        return reject(`claimed_by_mismatch(claimed_by=${c.fm.claimed_by || ''})`);
      }
    } else if (!(dryRun && claimable)) {
      // dry-run + 可领取（ready）已在上面放行（仅预演 claim，不落盘）；其余状态一律不可起。
      // in_review 额外提示可改用复核 lane（本入口的角色分工，见 guides/spawn-lane-sop.md §Review lanes）。
      const hint = status === 'in_review' ? ':use_role=review' : '';
      return reject(`status_not_spawnable(${status})${hint}`);
    }
  }

  // ---- ② 并发额度 ----
  const cap = capFor(owner);
  const running = runningCount(owner);
  if (running >= cap) {
    return reject(`concurrency_cap(owner=${owner},running=${running},cap=${cap})`, { running, cap });
  }

  // ---- ④ handoff 自检 ----
  const wsDir = path.join(TEAM_ROOT, 'workspace', taskId);
  const handoffPath = path.join(wsDir, 'handoff.md');
  const reportPath = path.join(wsDir, 'report.md');
  let handoffState;
  if (fs.existsSync(handoffPath)) {
    const miss = anchorGaps(fs.readFileSync(handoffPath, 'utf8'));
    if (miss.length) {
      return reject(`handoff_anchor_missing:${miss.join(',')}`, { handoff: { path: handoffPath, missing: miss } });
    }
    handoffState = 'exists';
  } else if (dryRun) {
    handoffState = 'would_create';
  } else {
    fs.mkdirSync(wsDir, { recursive: true });
    try {
      aclHandoff(card, { seg });
    } catch (e) {
      return reject(`handoff_generate_failed:${String(e && e.message ? e.message : e)}`);
    }
    handoffState = 'created';
  }

  // ---- ④b settings 预置（幂等；--settings 的目标，缺则 claude 起会话秒退「Settings file not found」）----
  let settings;
  try {
    settings = ensureWorkspaceSettings(wsDir, { dryRun }).state;
  } catch (e) {
    return reject(`settings_preset_failed:${String(e && e.message ? e.message : e)}`);
  }

  const n = segNumber(seg) ?? nextFreeIndex(wsDir, owner);
  const outLog = path.join(wsDir, `${owner}-${n}.out.jsonl`);
  const errLog = path.join(wsDir, `${owner}-${n}.err.log`);

  // ---- ③b 隔离落实（**放在全部可拒绝步骤之后** ⇒ 拒绝路径一律不留下 worktree）----
  // 同文件冲突与隔离预演拒绝已在 ①c 收口；此处只做**真实创建**（`--dry-run` ⇒ 幂等预演，零副作用）。
  const applied = applyLaneIsolation(isoPlan, { dryRun });
  if (!applied.ok) {
    return reject(`lane_isolation_failed(${applied.reason}):serialize_or_fix`, { isolation: isoPlan });
  }
  const isolation = applied.isolation;
  const cwd = isolation.mode === 'worktree' ? isolation.path : baseCwd; // ③ cwd（隔离时指向 lane worktree）

  // ---- ⑤ 确定性 session id（ACL）----
  let sid;
  try {
    sid = sessionIdFor(card, owner, seg).session_id;
  } catch (e) {
    return reject(`session_id_failed:${String(e && e.message ? e.message : e)}`);
  }

  // ---- ⑥ 组装命令 ----
  const prompt = buildPrompt({ handoffPath, cardPath, reportPath, isolation });
  const { bin, args } = buildCommand({ backend, bin: backendBin(backend), prompt, wsDir, sid, name: `${owner}-${seg}` });
  const plan = {
    ok: true,
    dryRun,
    session_id: sid,
    pid: null,
    role,
    settings,
    cwd,
    isolation,
    handoff: handoffState,
    log: outLog,
    errlog: errLog,
    backend,
    seg,
    owner,
    task_id: taskId,
    ...(claims.length ? { claims } : {}),
    cmd: [bin, ...args],
    cmdline: [bin, ...args].map((s) => (/[\s"'$]/.test(s) ? JSON.stringify(s) : s)).join(' '),
  };
  if (dryRun) return plan;

  // ---- ⑦ 起子会话（detached 新会话组；macOS 无 setsid）----
  fs.mkdirSync(wsDir, { recursive: true });
  const outFd = fs.openSync(outLog, 'a');
  const errFd = fs.openSync(errLog, 'a');
  let child;
  try {
    child = spawnChild(bin, args, {
      cwd,
      detached: true, // = Python subprocess.Popen(start_new_session=True)：新会话 + 脱离父进程组
      stdio: ['ignore', outFd, errFd],
      env: process.env,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  child.on('error', () => { /* 起失败已在 pid 判定处收口；此处兜住避免 unhandled */ });
  if (child.pid == null) return reject(`spawn_failed(bin=${bin})`);
  child.unref();
  const pid = child.pid;

  // ---- ⑧ 立即登记（卡 + registry 同写，唯一步骤）----
  const reg = sessionSet(card, { seg, owner, backend, phase, pid, log: outLog, status: 'running', id: sid });
  if (!reg.ok) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出/无权限：忽略 */ }
    return reject(`session_set_failed:${reg.reason || 'unknown'}`, { detail: reg, pid });
  }

  return {
    ...plan,
    pid,
    handoff: reg.handoff === 'created' ? 'created' : handoffState,
    card: reg.cardPath || cardPath,
    registry: reg.registry,
    ...(reg.warnings ? { warnings: reg.warnings } : {}),
  };
}

const HELP = `用法: bash scripts/spawn-lane.sh <card> <owner> [seg=seg1] [backend=claude|codex] [phase=<p>] [role=exec|review] [--review] [--dry-run] [--no-isolate] [--base <ref>]

新 lane 起会话的单一强制入口（claim → handoff 自检 → settings 预置 → spawn → session-set 卡+registry 同写）。
role=exec（默认）起执行 lane（in_progress 卡）；role=review（--review 等价）起复核 lane（in_review 卡，
不 claim、不校验 claimed_by，未给 seg= 时默认 segR1）。
同仓已有并发非终态 lane ⇒ 自动建隔离 worktree（cwd 指向该树）；同文件冲突 ⇒ 拒绝并提示串行；
隔离树的 base：续接上一 seg ⇒ 上一 seg 的 lane 分支 tip（首 seg ⇒ HEAD）；--base <ref> 显式指定且
不可解析即拒绝。--no-isolate（或 OPENCLAW_LANE_ISOLATION=0）关闭该自动化（回退为显式纪律）。
禁「直跑 claude -p 不登记」；见 guides/spawn-lane-sop.md、guides/worktree-isolation-sop.md 与 PROTOCOL §⑥。

示例:
  bash scripts/spawn-lane.sh T-20261010-052210 linus --dry-run
  bash scripts/spawn-lane.sh T-20261010-052210 linus seg=seg1 backend=claude
  bash scripts/spawn-lane.sh T-20261010-052210 linus seg=seg2            # 续接 seg1 ⇒ base=lane/<card>-seg1
  bash scripts/spawn-lane.sh T-20261010-052210 linus seg=seg2 --base 43bdf5f   # 显式定基
  bash scripts/spawn-lane.sh T-20261010-052210 turing --review backend=codex
  OPENCLAW_LANE_ISOLATION=0 bash scripts/spawn-lane.sh T-20261010-052210 linus   # 显式纪律回退
`;

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.ok) { console.error(HELP); console.log(JSON.stringify({ ok: false, reason: a.reason })); process.exit(2); }
  if (a.help) { console.log(HELP); process.exit(0); }
  const r = spawnLane(a);
  if (!r.ok) console.error(`✗ spawn-lane 拒绝：${r.reason}`);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : r.code || 1);
}

// main-guard：realpath 归一；被 import（单测）时不执行 CLI
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
