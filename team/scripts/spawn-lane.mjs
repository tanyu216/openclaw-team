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
 *   入参：<card> <owner> [seg=seg1] [backend=claude|codex] [phase=<p>] [role=exec|review] [parallel=1]
 *         [--review] [--dry-run] [--no-isolate] [--no-reaper] [--base <ref>] [--help]
 *   ① 解析卡（ACL `task.read`）；**按 role 分派状态口径**：
 *      - role=exec（默认）：断言 status=in_progress && claimed_by=owner（status=ready/todo 时自动 claim）；
 *        in_review ⇒ 拒绝并提示改用复核 lane（`status_not_spawnable(in_review):use_role=review`）。
 *      - role=review（复核 lane，`--review` 等价）：仅接受 status=in_review；**不 claim、不校验 claimed_by**
 *        （复核人 ≠ 实施人）；未显式 seg= 时取 `segR1`（避开执行侧 seg1 的行 upsert 撞名，见 sop §Review lanes）。
 *   ①b 同卡同 seg 防双跑（两层，T-20261013-233906 加固）：卡内 `## Sessions` 该 seg 行 / registry 该卡
 *      `phase=seg` 条目 / registry 该卡 `session_id=<本 seg 确定性 id>` 条目若 `status=running`
 *      **且 pid 存活** ⇒ 拒绝二次 spawn（`session_running(...):reuse_existing`，零副作用），
 *      提示复用既有 session（与 poll 防双跑守卫同口径）；僵尸行（pid 已死）不占用，交 reconcile。
 *      第三判据（session_id）见 `runningLaneBlocker`：`phase` 是 caller 自由填的展示标签
 *      （实测有 `seg1-verify` / `seg2-browser`），拿它当身份会让同 seg 二次 spawn 漏放。
 *   ①b2 同卡并发**执行 lane** 防双跑（本卡 ①）：`role=exec` 且该卡**已有任意活跃 lane（任意 seg）**
 *      ⇒ 拒绝（`card_busy(...):second_exec_lane`）——「同卡并发执行 turn」的第二条 lane 必须在 spawn
 *      前拦下（而非事后按 §⑥ 回滚）。同一计划内**有意**并行多分段时显式声明 `parallel=1` 越过本层。
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
 *      `merge-base --is-ancestor <seg1 tip> → NO`，前段产物被丢）。首 seg / 无前驱 ⇒ 缺省 base = `OPENCLAW_LANE_BASE`
 *      或 `dev`（开发集成分支，`PROTOCOL §⑥.4`，T-20261015-devbranch）；缺省与显式 `--base <ref>` **不可解析即拒绝**（绝不静默回落）。
 *      证据在输出 `isolation.base`。
 *   ①c-c **叠卡定基**（T-20261015-133720）：自动起 lane 路径（`poll-run` 的移交指令、无 `--base`）此前
 *      只认「同卡续接」⇒ **跨卡**叠卡（`depends_on` 的前置卡已 done、而其 lane 分支 tip **未并入 main**）
 *      静默落仓 `HEAD`（= main），新树丢掉前置产物（`T-20261015-075826` / `T-20261015-132952` 实测）。
 *      现入口自行解析「本卡应有的 base」：`--base` 显式最优先（不改判）；否则在候选集
 *      {①同卡上一 seg 的 lane tip、②`depends_on` 链上未并入 `HEAD` 的分支 tip} 中取**信息最全的最大元**。
 *      选到②时以该 tip 建树并把 `isolation.base.source` 标为 `dependency`（+ 点名 `dep`）；选到①时
 *      **不把 base 传下去**（续接档仍走 `lane-isolation` 的原推导 ⇒ 该档证据逐字节不变）。
 *      **行为边界（如实记，勿读成「续接档不变」）**：①与②**同台比大小、无先天优先级** ⇒ 两者互不包含时
 *      （本卡的上一 seg 不含未并入的前置 tip，反之亦然）同为 `base_ambiguous` ⇒ **续接档在「本卡旧段 vs
 *      前置」发散时由「继续」变为「拒绝」**（改前会静默沿上一 seg tip 继续、丢掉前置产物）。这是有意的
 *      fail-closed 取舍（选哪一档属策略问题，人可 `--base` 钉定）。
 *      另：无法判定（两个互不包含的未合并前置）⇒ `base_undeterminable(base_ambiguous)` 拒绝；
 *      应有 base 却**不会建隔离树**（单 lane，lane 将落在共享 checkout 的 `HEAD`）⇒
 *      `base_required_not_isolated(...)` 拒绝 —— 两者都**绝不静默落 main**。
 *      证据在输出 `base`（候选集）与 `isolation.base`（实际建树基准）。
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
 *   ⑥b 后端分派（`buildCommand`）：claude 分支照 `PROTOCOL §⑥` 模板（含 `--add-dir wsDir/team`）；
 *      codex 分支（T-20261013-164816）显式 `--sandbox workspace-write` + `--add-dir <wsDir>` + `--add-dir <team>`
 *      ——否则 codex 沙箱的可写根只有 cwd（主 workspace），复核报告落点 `{team}/workspace/<id>/` 在 cwd 之外
 *      ⇒ lane 写 `report.md` 得 EPERM（须父回合手工回迁）。`--add-dir` 只在 workspace-write 下生效（实测）；
 *   ⑦ 起后**立即** ACL `task.session-set`（seg/owner/backend/phase/pid/log/status=running；卡 + registry 同写）。
 *   ⑧ 登记成功后**立即**起「会话终态看守」（`lane-reaper.mjs`，detached）——lane 进程一死（正常结束/
 *      被杀/超时/崩溃）即经 ACL `task.session-close` 写完两侧终态 + 逐条留痕。**起看守失败即拒绝**
 *      （fail-closed：先 `session-close` 收口已登记的行、再 kill 子进程——「登记了却无人负责收口」正是
 *      本卡要消灭的失败模式）。回退开关：`--no-reaper` 或 env `OPENCLAW_TEAM_REAPER=0`。
 *   `--dry-run`：只做校验 + 打印计划命令行，**不起进程、不写 registry/卡/handoff/settings**。
 *
 * 输出：末行 JSON `{ok, role, settings, isolation, session_id, pid, cwd, handoff, log, cmd, …}`（机读）；失败 exit≠0（用法 2 / 拒绝 1）。
 * 用法错误：未知旗标 / **多余的裸位置参数**（如把 `--dry-run` 误写成 `dry-run`）⇒ exit 2，绝不静默忽略。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { TEAM_ROOT, AGENTS, getProject, readCardById, parseDeps } from './lib.mjs';
import { anchorGaps } from './check-handoff.mjs';
import { loadRegistry, isPidAlive, isEntryAlive, closePendingEntries } from './registry.mjs';
import { isolationEnabled, laneIsolationPlan, applyLaneIsolation, prevSegCandidates, laneNameFor } from './lane-isolation.mjs';
import { branchHead, revParse } from './lane-worktree.mjs';
import { read as aclRead, claim as aclClaim, sessionSet, sessionClose, sessionIdFor, handoff as aclHandoff } from '../skills/task-ops/lib/task.mjs';
import { armLaneReaper, reaperEnabled } from './lane-reaper.mjs';

/** 并发额度（PROTOCOL §⑥ clause 2）：linus/jobs < 8；turing < 3；其余默认 8 */
export const RUNNING_CAPS = { linus: 8, jobs: 8, turing: 3 };
export const DEFAULT_CAP = 8;
export function capFor(owner) {
  return RUNNING_CAPS[owner] ?? DEFAULT_CAP;
}

/**
 * `harness` = 执行引擎形态（契约 `guides/codex-plugin-lane-contract.md` §1.3 / §8.1）。
 * `cli`（默认）= 现状 `codex exec <prompt>` 独立子进程；`plugin` = 官方 codex 插件
 * app-server embedded harness turn（句柄 = native thread id，非 pid）。缺省 ⇒ `cli`（向后兼容）。
 */
export const HARNESSES = ['cli', 'plugin'];
/** 契约 §4.2：两步回填状态位（仅插件 lane 写卡/写 registry） */
export const ID_STATES = ['pending', 'bound'];
/**
 * 绑定超时（契约 §3.2 / §11 G-7，默认 120s，与既有 ACP 启动探针窗口同口径）：
 * `id_state=pending` 超时仍读不回 native thread id ⇒ 判 lane `failed` 并回报，**不静默挂起**。
 */
export const THREAD_BIND_TIMEOUT_MS = Number(process.env.THREAD_BIND_TIMEOUT_MS || 120000);
/** 绑定轮询间隔 */
export const THREAD_BIND_POLL_MS = Number(process.env.THREAD_BIND_POLL_MS || 250);

/**
 * 插件 lane 的**网关调度形态**（契约 §8.2 / §11 G-3）。G-3 裁定「优先 Gateway 原生 dispatch、
 * 不自造 CLI」，故此处不硬编码某个 verb，而是把调度命令**整体模板化**，由宿主配置钉定：
 *   `OPENCLAW_CODEX_PLUGIN_CMD`（空格分隔的 **argv 模板，不含可执行文件本身**——bin 由
 *   `OPENCLAW_CODEX_PLUGIN_BIN` 决定），占位符 `{prompt} {cwd} {model} {sandbox} {approval_policy} {ws}`。
 * 默认模板 = 契约 §8.2/§8.5/§8.9 的映射落点（model / cwd / sandbox / approvalPolicy 四项），
 * 待 A3/Elon 按 G-3 确认真实 verb 后**仅改配置、不改代码**。
 */
export const PLUGIN_CMD_TEMPLATE = process.env.OPENCLAW_CODEX_PLUGIN_CMD
  || 'codex run --json --non-interactive --model {model} --cwd {cwd} --sandbox {sandbox} --approval-policy {approval_policy} {prompt}';
/** 插件 lane 的默认模型引用 / 沙箱 / 审批姿态（契约 §8.2 / §8.5 / §8.9；均 env 可覆） */
export const PLUGIN_MODEL = process.env.OPENCLAW_CODEX_PLUGIN_MODEL || 'openai/gpt-6-astra';
export const PLUGIN_SANDBOX = process.env.OPENCLAW_CODEX_PLUGIN_SANDBOX || 'workspace-write';
/** G-4 裁定：审批姿态与 CLI lane **等价**（非交互、sandbox=workspace-write），**不得**开旁路 */
export const PLUGIN_APPROVAL_POLICY = process.env.OPENCLAW_CODEX_PLUGIN_APPROVAL_POLICY || 'on-failure';

/** 把模板展开为 argv（含占位符替换；`{prompt}` 原样保留为单个 argv 元素） */
export function expandPluginCmd(template, vars) {
  return String(template)
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => tok.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)));
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
 * 口径 = registry 中 `owner==owner && status==='running'` **且判活**；判活见 `isEntryAlive`
 * （CLI lane = pid 存活；插件 lane = pid 存活 **或** native thread 可达，契约 §7 / G-2）。
 * 死/不可达的 running 行是僵尸（reconcile 职责），不占用额度，避免误拒。
 * **CLI lane 与插件 lane 合并计数**（同一 registry，契约 §8.4）。
 */
export function runningCount(owner, { registry = null, ...opts } = {}) {
  const entries = registry == null ? loadRegistry({ includeLegacy: false }) : registry;
  return entries.filter((e) => e.owner === owner && e.status === 'running' && isEntryAlive(e, opts)).length;
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

/** 卡内 `## Sessions` 行是否代表「在跑」：CLI lane 看 pid；插件 lane 看 bound 的 native thread id */
function cardRowLive(s) {
  if (isPidAlive(Number(s.pid))) return true;
  return s.harness === 'plugin' && !!s.id && s.id !== 'pending';
}

/**
 * 该卡当前**活跃 lane** 清单（判据与 poll 防双跑守卫同口径：登记 `status=running` **且判活** ——
 * 判活见 `cardRowLive` / `isEntryAlive`（契约 §7）：CLI lane 看 pid，**插件 lane**（`harness:plugin`）无
 * 独立 pid（`pid` 为网关 pid/`-`）⇒ pid-only 会漏判在飞 lane 而放行双跑，必须叠加 native thread 可达性）。
 * 两个登记源合并去重（同 session id 以卡内行为准）：卡内 `## Sessions` 行 + registry 条目。
 * 僵尸行（pid 已死 / pid 缺失）**不**计入（reconcile 的职责），避免误拒恢复。
 * @returns {{seg:string, pid:number, id:string, owner:string, source:'card'|'registry'}[]}
 */
export function liveLanes(taskId, cardBody = '', registry = null) {
  const reg = registry == null ? loadRegistry() : registry;
  const out = [];
  const seen = new Set();
  for (const s of sessionsBySeg(cardBody)) {
    const pid = Number(s.pid);
    if (s.status !== 'running' || !cardRowLive(s)) continue;
    out.push({ seg: s.seg, pid, id: s.id || '', owner: s.owner || '', source: 'card' });
    if (s.id) seen.add(s.id);
  }
  for (const e of reg) {
    if (e.task_id !== taskId || e.status !== 'running' || !isEntryAlive(e)) continue;
    if (e.session_id && seen.has(e.session_id)) continue;
    out.push({ seg: e.phase || '', pid: e.pid, id: e.session_id || '', owner: e.owner || '', source: 'registry' });
  }
  return out;
}

/**
 * 同卡防双跑判据（**与 poll 防双跑守卫同口径**：登记 `status=running` **且判活** —— CLI lane 看 pid，
 * 插件 lane 看 native thread 可达，见 `cardRowLive`）。分两层：
 *
 *  L1 同 lane 身份（精确，不可越过）。一个 lane 的身份 = `(task_id, owner, seg)`，其确定性投影
 *    `session_id = UUIDv5(card, owner, seg)`（§⑥ registry 字段）⇒ 三个登记源任一命中即拒绝：
 *      ① 卡内 `## Sessions` 该 seg 行（seg 语义精确，含 id 供 resume）；
 *      ② registry 该卡 `phase===seg` 的条目（历史口径：`phase` 缺省即 `seg`）；
 *      ③ registry 该卡 `session_id===<本 seg 的确定性 id>` 的条目 —— **与 `phase` 标签无关**。
 *    ③ = T-20261013-233906 修复：`phase` 是 caller 自由填的**展示标签**（实测有 `seg1-verify` /
 *    `seg2-browser`），不是身份。实证 `T-20261013-223243` 的 seg1 lane 以 `phase:seg1-verify` 登记，
 *    旧判据只比 `phase===seg` ⇒ 同 seg 二次 spawn 漏放，落出同 session_id 的重复 registry 行。
 *
 *  L2 同卡并发**执行 lane**（本卡 ①，`role=exec`）。该卡已有任意活跃 lane（**任意 seg**）⇒ 拒绝
 *    「第二条执行 lane」。理由：framework 在 spawn 期看不到 turn 边界，「同卡已有执行 lane 在跑」
 *    正是「同卡并发执行 turn」的可观测形态；事后按 §⑥ 回滚等于白起一条 lane（实证 turing segR1）。
 *    同一计划内**有意**并行多分段时，调用方显式声明 `allowParallel`（CLI `parallel=1`）越过本层。
 *    只读角色（`role=review`）不加 L2：复核 lane 靠 pin commit、与执行 lane 并跑是既有契约
 *    （SOP §Review lanes）；L1 对复核 lane 照常生效（复核不得复用执行侧 seg）。
 *
 * @param {{taskId:string, seg:string, cardBody?:string, registry?:object[]|null,
 *          sid?:string, role?:'exec'|'review', allowParallel?:boolean}} input
 *   `sid` = 本 seg 的确定性 session id（`sessionIdFor(card, owner, seg)`）；缺省 ⇒ 跳过 L1③。
 * @returns {{blocked:boolean, session?:object, live?:object[]}}
 */
export function runningLaneBlocker({ taskId, seg, cardBody = '', registry = null, sid = '', role = 'exec', allowParallel = false, ...opts }) {
  const reg = registry == null ? loadRegistry() : registry;
  const byCard = sessionsBySeg(cardBody).find(
    (s) => s.seg === seg && s.status === 'running' && cardRowLive(s),
  );
  if (byCard) return { blocked: true, session: { ...byCard, pid: Number(byCard.pid) || null, source: 'card' } };
  const byReg = reg.find(
    (e) => e.task_id === taskId && e.status === 'running'
      && (e.seg == null || e.seg === '' ? e.phase : e.seg) === seg
      && isEntryAlive(e, opts),
  );
  if (byReg) return { blocked: true, session: { ...byReg, seg, source: 'registry' } };
  const bySid = sid
    ? reg.find((e) => e.task_id === taskId && e.status === 'running' && e.session_id === sid && isPidAlive(e.pid))
    : null;
  if (bySid) return { blocked: true, session: { ...bySid, seg, source: 'registry_session' } };

  if (role !== 'exec' || allowParallel) return { blocked: false };
  const live = liveLanes(taskId, cardBody, reg);
  if (live.length) return { blocked: true, session: { ...live[0], seg, source: 'card_busy' }, live };
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
 * 解析 CLI 参数（位置：card owner；k=v：seg/backend/harness/phase/role/base；带值 flag：--base；
 * 开关：--review/--plugin（= harness=plugin，仅 backend=codex）/--dry-run/--no-isolate/--no-reaper/--help）
 * `--base <ref>` 与 `base=<ref>` 等价（前者形状与 `lane-worktree.mjs` 对齐，见 worktree-isolation-sop §5）。
 */
export function parseArgs(argv) {
  const pos = [];
  const kv = {};
  let dryRun = false;
  let help = false;
  let isolate = true;
  let reaper = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--no-isolate') { isolate = false; continue; } // 回退开关（等价 OPENCLAW_LANE_ISOLATION=0）
    if (a === '--no-reaper') { reaper = false; continue; } // 回退开关（等价 OPENCLAW_TEAM_REAPER=0）
    if (a === '--review') { kv.role = 'review'; continue; } // 等价 role=review
    if (a === '--plugin') { kv.harness = 'plugin'; continue; } // 等价 harness=plugin（契约 §8.1）
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
    reaper,
    card: pos[0] || '',
    owner: pos[1] || '',
    // 未显式给 seg ⇒ ''，由 spawnLane 按 role 取默认（exec=seg1 / review=segR1）
    seg: kv.seg || '',
    backend: kv.backend || 'claude',
    // 未显式给 harness ⇒ 'cli'（默认路径 = 现状 `codex exec`，契约 §8.1 向后兼容）
    harness: kv.harness || 'cli',
    role: kv.role || 'exec',
    phase: kv.phase || kv.seg || '',
    // 同一计划内**有意**并行多分段：显式声明越过 ①b2（见 runningLaneBlocker L2）
    parallel: kv.parallel || '',
    base: kv.base || '',
  };
}

/** `parallel=1|true|yes|on` ⇒ 越过 ①b2（同卡并发执行 lane 守卫）；其它值（含空）⇒ 不越过 */
export function parallelDeclared(value) {
  return /^(1|true|yes|on)$/i.test(String(value == null ? '' : value).trim());
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
      `Commit there with explicit paths, and report the branch + commit sha in your Report so it can be integrated and the worktree removed. ` +
      `Do not commit on the protected branch (main): integration happens on the dev branch (ref PROTOCOL §⑥.4, scripts/branch-guard.mjs).`,
    );
  }
  return lines.join('\n');
}

/** 组装子进程命令（argv 数组；claude 参数照 PROTOCOL §⑥ 模板） */
export function buildCommand({ backend, harness = 'cli', bin, prompt, wsDir, sid, name, cwd = '', team = TEAM_ROOT }) {
  // --- 插件分支（契约 §8.2）：网关中介的 codex app-server harness turn ---
  // 与 CLI 分支的关键差异：**句柄 = native thread id（非 pid）**；沙箱/审批经调度参数绑定
  // （§8.5 映射表 / §8.9，G-4 裁定：审批姿态与 CLI lane 等价，不开旁路）。
  if (harness === 'plugin') {
    const args = expandPluginCmd(PLUGIN_CMD_TEMPLATE, {
      prompt,
      cwd: cwd || wsDir,
      ws: wsDir,
      model: PLUGIN_MODEL,
      sandbox: PLUGIN_SANDBOX,
      approval_policy: PLUGIN_APPROVAL_POLICY,
    });
    return { bin, args, harness: 'plugin' };
  }
  // --- CLI 分支（现状，保留可回退；契约 §8.2）---
  if (backend === 'codex') {
    // T-20261013-164816：codex 分支原仅发 `exec <prompt>` ⇒ 沙箱可写根只有 cwd（主 workspace），
    // 复核报告落点 {team}/workspace/<id>/ 在 cwd 之外 ⇒ lane 写 report.md 得 EPERM，须父回合手工回迁。
    // 等效写权（机制可与 claude 不同形；codex 0.161.0 实测语义）：
    //   · `--sandbox workspace-write`：**必须显式**。cwd 非 git / 未受信时默认沙箱是 read-only，而
    //     `--add-dir` 只**追加可写根**且**仅在 workspace-write 下生效**（read-only 下被静默忽略）⇒
    //     缺此旗标则 --add-dir 形同虚设。
    //   · `--add-dir <wsDir>`：把本卡报告落点并入可写根（EPERM 消失的充分条件）。
    //   · `--add-dir <team>`：报告落点之根（与 claude 分支同面，lane 亦须能写回卡/登记）。
    // 旗标须在 prompt **之前**（`codex exec [OPTIONS] [PROMPT]`）。
    return {
      bin,
      harness: 'cli',
      args: ['exec', '--sandbox', 'workspace-write', '--add-dir', wsDir, '--add-dir', team, prompt],
    };
  }
  return {
    bin,
    harness: 'cli',
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

/** 插件 lane 的调度 bin（env 可钉定；默认 `openclaw` = 网关 CLI） */
export function pluginBin() {
  return process.env.OPENCLAW_CODEX_PLUGIN_BIN || 'openclaw';
}

/**
 * 从调度器 stdout（NDJSON）中读回 **native thread id**（契约 §3.1 步②的绑定源）。
 * 逐行 JSON 解析，接受 `thread_id` / `threadId` / `session_id` 三个键（宿主实现差异兜底）；
 * 返回首个非空字符串值；未出现 ⇒ null（调用方按 `THREAD_BIND_TIMEOUT_MS` 判超时）。
 */
export function parseThreadId(text) {
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    for (const k of ['thread_id', 'threadId', 'session_id']) {
      const v = o && o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

/** 读取文件内的 native thread id（绑定轮询用；文件不存在/不可读 ⇒ null） */
export function readThreadIdFrom(logPath) {
  try { return parseThreadId(fs.readFileSync(logPath, 'utf8')); } catch { return null; }
}

/**
 * 同步等待绑定：轮询 `logPath` 直到出现 native thread id 或超时（契约 §3.2 / §11 G-7）。
 * 返回 `{ threadId }` 或 `{ timeout: true, ms }`。`pollMs` 可注入（测试免等真实 120s）。
 */
export function awaitThreadId(logPath, { timeoutMs = THREAD_BIND_TIMEOUT_MS, pollMs = THREAD_BIND_POLL_MS, sleepSync = busySleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tid = readThreadIdFrom(logPath);
    if (tid) return { threadId: tid };
    if (Date.now() >= deadline) return { timeout: true, ms: timeoutMs };
    sleepSync(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** 同步睡眠（spawn 入口是同步流；绑定窗口短，不引入异步重排） */
function busySleep(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * G8 日志导出（契约 §8.7）：把网关 JSON-lines 日志（含 codex 插件行）导出到
 * `<ws>/evidence/plugin-<ts>.log`，并写 `<ws>/evidence/manifest.json`
 * （`exported_at` / `lane_seg` / `source`）。**触发时机 = lane 启动时 + 终态前各一次**。
 * 导出失败 ⇒ 返回 `{ok:false}`，调用方按契约 R3「判 blocked 并回报，不静默丢证据」处置。
 * `--dry-run` 由调用方保证不进来（本函数有写副作用）。
 */
export function exportPluginLogs({ wsDir, seg, sourceDir = (process.env.OPENCLAW_GATEWAY_LOG_DIR || '/tmp/openclaw'), now = new Date(), files = null }) {
  try {
    let srcs = files;
    if (!srcs) {
      srcs = [];
      try {
        for (const f of fs.readdirSync(sourceDir)) {
          if (/^openclaw(-[A-Za-z0-9_-]+)?-\d{4}-\d{2}-\d{2}\.log$/.test(f)) srcs.push(path.join(sourceDir, f));
        }
      } catch { /* 源目录不存在 ⇒ 空集（仍落 manifest，显式记 source_missing） */ }
    }
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const evDir = path.join(wsDir, 'evidence');
    fs.mkdirSync(evDir, { recursive: true });
    const dest = path.join(evDir, `plugin-${stamp}.log`);
    let bytes = 0;
    const chunks = [];
    for (const p of srcs) {
      try { const b = fs.readFileSync(p); chunks.push(b); bytes += b.length; } catch { /* 单文件不可读 ⇒ 跳过 */ }
    }
    fs.writeFileSync(dest, Buffer.concat(chunks));
    const manifest = {
      exported_at: now.toISOString(),
      lane_seg: seg,
      source: srcs.map((p) => path.relative(sourceDir, p) || p),
      source_dir: sourceDir,
      log: dest,
      bytes,
    };
    fs.writeFileSync(path.join(evDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { ok: true, path: dest, bytes, manifest };
  } catch (e) {
    return { ok: false, reason: `export_failed:${String(e && e.message ? e.message : e)}` };
  }
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

// ---------- ①c-b2 定基解析：自动路径（无 `--base`）也须落在「卡面应有的 base」上 ----------
// （T-20261015-133720）为什么存在：`--base` 是**手工**纪律，而 poll/自动起 lane 路径（`poll-run` 的移交
// 指令原话：`bash scripts/spawn-lane.sh <card> <owner> [seg] [backend]`）**从不传 `--base`** ⇒ 叠卡
// （`depends_on` 的前置卡已 done、但其 lane 分支 tip **未并入 main**）起 lane 时静默落该仓 `HEAD`
// （= main），新树**不含**前置产物。今日两度实测（`T-20261015-075826` 的 `depends_on: T-20261015-063755`
// 其 tip `fb782dd` 未并入 main；`T-20261015-132952` 同形），Linus 均需非破坏收掉重起。
// 「续接上一 seg」（`T-20261014-112936` 已修）只覆盖**同卡**多段；**跨卡**的叠卡前置仍无解 ⇒ 本段补上。
// 只读：只用 `rev-parse` / `merge-base --is-ancestor` 探测，不建树、不改仓、不写卡。

/** 依赖链深度上界（与 `check-relations.mjs` 的依赖链长护栏同口径：≤8） */
const DEP_CHAIN_MAX = 8;

/** `anc` 是否为 `desc` 的祖先（含相等）。任一不可解析 ⇒ false（不猜） */
function isAncestor(cwd, anc, desc) {
  if (!anc || !desc) return false;
  return spawnSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', anc, desc], { encoding: 'utf8' }).status === 0;
}

/**
 * 前置卡在本仓的 lane 分支 —— **只认它自己登记过的 seg**（`lane/<id>-<seg>`，分支存在才算）。
 *
 * 为什么不去 `for-each-ref refs/heads/lane/<id>-*`：那条 glob **过宽**。卡 id 互为前缀在本板是常态
 * （`T-…-025543` / `-025543-2` / `-025543-3` 是**三张不同的卡**），前缀 glob 会把**兄弟卡**甚至
 * **本卡自己**的分支读成前置 tip（实板推演当场踩到：卡 `T-…-025543-3` 被解析出自己的
 * `lane/T-…-025543-3-seg1` 当 base —— 自指错基）。改由前置卡 `## Sessions` 的 seg 反推分支名
 * （与 `lane-isolation.deriveLaneBase` ② 档同一手法），名字空间与**身份**同时被钉死。
 * @param {string[]} segs 前置卡已登记的 seg（`sessionsBySeg` 的结果）
 * @returns {string[]} 存在的分支名（如 `lane/T-…-seg1`）
 */
export function depLaneBranches(repo, depId, segs = []) {
  const out = [];
  for (const s of (Array.isArray(segs) ? segs : []).map((x) => (x && typeof x === 'object' ? x.seg : x)).filter(Boolean)) {
    const branch = `lane/${laneNameFor(depId, s)}`;
    if (branchHead(repo, branch)) out.push(branch);
  }
  return out;
}

/**
 * `depends_on` 链（**传递闭包**，广度优先、深度 ≤ `DEP_CHAIN_MAX`）的卡 id 列表（不含起点自身）。
 * 读不到某张卡（已被归档/删除）只是**少一层**：断层以下的依赖无从得知，绝不臆造。
 * @param {string} startId
 * @param {(id:string)=>({fm:object,body:string}|null)} readCard 卡 id ⇒ 卡（注入缝，单测可造图）
 */
export function dependencyChain(startId, readCard, max = DEP_CHAIN_MAX) {
  const seen = new Set([startId]);
  const order = [];
  const memo = new Map(); // 同一张卡只读一次（看板可达数百张，逐层重扫会做无谓 IO）
  const read = (id) => {
    if (!memo.has(id)) memo.set(id, readCard(id));
    return memo.get(id);
  };
  let frontier = [startId];
  for (let d = 0; d < max && frontier.length; d++) {
    const next = [];
    for (const id of frontier) {
      const c = read(id);
      if (!c || !c.fm) continue;
      for (const dep of parseDeps(c.fm.depends_on)) {
        if (seen.has(dep)) continue;
        // 只跟随**解析得到**的依赖 —— 这比原先的「形状合法才跟随」更强：一个形状合法但
        // 看板上并不存在的 dep 不再被当成分支点（它会一路空转）。判据不再是命名规则。
        if (!read(dep)?.fm) continue;
        seen.add(dep);
        order.push(dep);
        next.push(dep);
      }
    }
    frontier = next;
  }
  return order;
}

/** 默认的卡读取（经 lib 的 `readCardById`；读不到 ⇒ null） */
const defaultReadCard = (id) => readCardById(id);

/**
 * 「本卡应有的 base」解析（**只读**；自动路径专用，显式 `--base` 不走这里）。
 *
 * 候选（**无先天优先级** —— ①与②同台比大小，由下方「选择」按祖先关系取最大元）：
 *   ① **上一 seg 的 lane 分支 tip**（同卡续接；`prevSegCandidates` + `laneNameFor`，与
 *      `lane-isolation.deriveLaneBase` ② 档同一口径 —— 此处复算只为**与其他候选比大小**）；
 *   ② **`depends_on` 链上前置的产物 tip**（跨卡叠卡；本卡新增）—— 即前置卡**最后登记的一段**的 lane
 *      分支 tip，**其自身**尚未并入 `HEAD`。分支由前置卡 `## Sessions` 的 seg 反推（见 `depLaneBranches`：
 *      前缀 glob 会把兄弟卡/本卡自己的分支读成前置 tip）。「未并入」判据 = tip **不是** `HEAD` 的祖先。
 *      「已并入」时 tip 必是 `HEAD` 的祖先（本仓 git 纪律要求 ff 或 `--no-ff` 合并并留 merge commit ⇒
 *      分支 tip 成为 main 的祖先），故已合并的前置**不产生候选**、`base` 仍是 `HEAD`（旧行为不变）。
 *      **只认末段**的理由见下方循环内注释（作废支线陷阱：卡被「收掉重起」过时，早期那段未并入的分支
 *      不是「缺的前置」，拿它建树会丢掉 main 上后来的一切）。
 * 选择：取唯一「最大元」（其余候选皆其祖先 —— 即**信息最全**的那个 tip）。候选集若没有最大元
 *   （两个互不包含的未合并前置；**或**本卡上一 seg 与一个未并入的前置发散），**无法判定** ⇒ 回
 *   `error`，由调用方 fail-closed 拒绝起 lane（**续接档因此也会拒绝**，不再静默沿上一 seg 继续）。
 * @param {{repo:string,taskId:string,seg:string,fm?:object,sessions?:object[],readCard?:Function,headRef?:string}} o
 *   `readCard` = 卡 id ⇒ `{fm, body}`（注入缝；默认经 ACL/lib 读真实看板）
 * @returns {{ref:string,source:'prev_seg'|'dependency',resolved:string,prev_seg?:string,dep?:string,
 *            candidates:object[]} | {error:string,candidates:object[]} | null}
 *   `null` = 本仓无候选（非 git 仓 / 无 `HEAD` / 无前驱 / 前置均已并入）⇒ 调用方保持旧行为（`HEAD`）。
 */
export function resolveSpawnBase({ repo, taskId = '', seg = '', fm = {}, sessions = [], readCard = defaultReadCard, headRef = 'HEAD' } = {}) {
  const head = revParse(repo, headRef);
  if (!head) return null; // 不是 git 仓（或 HEAD 不可解析）⇒ 「base」这个词在这里没有意义，保持旧行为
  const cands = [];
  // ① 同卡续接（既有口径；只用于比大小 —— 真值仍由 lane-isolation 自己推导，见 spawnLane 的注释）
  for (const c of prevSegCandidates(seg, sessions)) {
    const branch = `lane/${laneNameFor(taskId, c)}`;
    const tip = branchHead(repo, branch);
    if (tip) cands.push({ ref: branch, source: 'prev_seg', prev_seg: c, resolved: tip });
  }
  // ② 跨卡叠卡：depends_on 链上前置的**产物 tip**（分支名由前置卡自己的 seg 反推；只认**末段**）
  // **本层不判前置的状态**（terminality）：`depends_on` 面按**写的**读，前置是 done 与否都照解析。
  // 「前置已 done」这层保证在**上游**：自动路径上卡先经 `claimCard`（`lib.mjs`：任一 `depends_on`
  // 非 done ⇒ `deps_unmet` 拒领）⇒ 领得到的卡其前置必然 done，与本卡前提（当日两度实证）一致。
  // 反例（今日实板普查，2026-10-15）：`T-20261015-075845` 的前置 `T-20261015-051046-2` 仍在 `in_review`
  // ⇒ 它领不到（自动路径到此为止），但**显式领取**仍可起 —— 此时按前置产物 tip 建树比静默回落 `HEAD`
  // 更接近意图（人本来就会 `--base <那个 tip>`）。故此处**不加**状态门：加了等于把一个已判定的意图
  // 换回「静默落 main」，正是本卡要消灭的形状。
  for (const depId of dependencyChain(taskId, readCard)) {
    const dep = readCard(depId);
    if (!dep || !dep.body) continue; // 前置卡读不到 ⇒ 无从确认分支归属，不猜
    // 只取**最后登记的一段**已存在的分支（`depLaneBranches` 保 `## Sessions` 序）：前置卡的产物 tip
    // 就是它最后那段的落点。**不可**把该卡每一段未合并的分支都当候选 —— 卡被「收掉重起」过时（今日
    // 两度实测 `T-20261015-075826` / `T-20261015-132952` 的收尾形状），早期那段是**作废支线**（基于
    // 当时的 main、与重起后的真产物**互不包含**）；一旦最终段的 tip 已并入 `HEAD` 而分支仍在（SOP §7
    // 只收工作树、**不收分支**），作废支线恰恰**不是** `HEAD` 的祖先 ⇒ 会被读成「缺的前置」，把新树
    // 建在被丢弃的尝试上（丢掉 main 上后来的一切）—— 本卡要消灭的错基换个形状回来。
    // 边界（如实记）：一张卡**显式并行**多段（`parallel=1`）且都未合并时，产物 tip 本无单一定论，
    // 此处取末段（人可判定的场景请用显式 `--base` 钉住）。
    const branches = depLaneBranches(repo, depId, sessionsBySeg(dep.body));
    const branch = branches.length ? branches[branches.length - 1] : '';
    const tip = branch ? branchHead(repo, branch) : null;
    if (!tip || isAncestor(repo, tip, head)) continue; // 末段分支不存在 / 已并入 ⇒ 前置已满足，无候选
    cands.push({ ref: branch, source: 'dependency', dep: depId, resolved: tip });
  }
  const uniq = [];
  for (const c of cands) if (!uniq.some((u) => u.resolved === c.resolved)) uniq.push(c);
  const evidence = uniq.map((c) => ({ ref: c.ref, source: c.source, resolved: c.resolved, ...(c.dep ? { dep: c.dep } : {}), ...(c.prev_seg ? { prev_seg: c.prev_seg } : {}) }));
  if (!uniq.length) return null;
  const maxima = uniq.filter((c) => uniq.every((o) => o === c || isAncestor(repo, o.resolved, c.resolved)));
  if (maxima.length === 1) return { ...maxima[0], candidates: evidence };
  // 无最大元 ⇒ 两个（或更多）互不包含的未合并前置：**无法判定**哪一个是「本卡应有的 base」
  return { error: 'base_ambiguous', candidates: evidence };
}

const reject = (reason, extra = {}) => ({ ok: false, code: 1, reason, ...extra });
const usage = (reason) => ({ ok: false, code: 2, reason });

/**
 * 执行入口（dry-run 与真实起会话共用同一条校验链）。
 * @param {{card:string,owner:string,seg:string,backend:string,phase:string,role:'exec'|'review',
 *          dryRun:boolean,isolate?:boolean,parallel?:string,base?:string}} opts `isolate:false` = 关自动隔离
 *   （回退开关，等价 `--no-isolate`）；`parallel='1'` = 同一计划内有意并行多分段（越过 ①b2，见上）；
 *   `base` = 显式定基（等价 `--base <ref>`），未给则由上一 seg 分支 tip 推导。
 */
export function spawnLane(opts = {}) {
  const { card = '', owner = '', seg: segArg = '', backend = 'claude', harness = 'cli', dryRun = false, base = '' } = opts;
  const role = opts.role || 'exec';
  const allowParallel = parallelDeclared(opts.parallel);
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
  // harness 值域（契约 §8.1）：未识别 ⇒ usage 错（exit 2），理由码 unknown_harness:<v>
  if (!HARNESSES.includes(harness)) return usage(`unknown_harness:${harness}`);
  // 插件天然只有 Codex 腿（契约 §6 / §1.2：claude 与 pi 无官方 embedded harness）
  if (harness === 'plugin' && backend !== 'codex') return usage(`harness_plugin_requires_codex(backend=${backend})`);

  // ---- ① 解析卡（ACL）----
  let c;
  try {
    c = aclRead(card);
  } catch (e) {
    return reject(`card_unreadable:${String(e && e.message ? e.message : e)}`);
  }
  const taskId = c.fm.id || path.basename(c.cardPath, '.md');
  // 卡 id 的**形状**归 task provider，不在这里判（`card-ids.mjs` 头注）。到这一步卡已经解析到手
  // （上面的 `card_unreadable` 才是真正的失败码）；原先的 `bad_card_id` 形状断言是对 provider
  // 命名规则的镜像，已删除。
  if (!String(taskId).trim()) return reject(`card_unreadable:empty_card_id`);
  const cardPath = c.cardPath;
  let claims = [];
  let status = String(c.fm.status || '');

  // ---- ①b 同卡同 seg 防双跑守卫（并入本治理卡；判据同 poll 防双跑守卫：running 登记 + pid 存活）----
  // 已有在跑的会话 ⇒ 拒绝再次 spawn（提示复用既有 session，按 host 口径 resume），绝不双跑。
  // 放在 claim 之前：拒绝路径**零副作用**（不 claim、不写 registry/卡/日志）。
  {
    // 本 seg 的确定性 session id（= 该 lane 的身份投影）；读卡失败 ⇒ 空串（跳过 L1③，其余判据照跑）
    let sid = '';
    try { sid = sessionIdFor(card, owner, seg).session_id; } catch { sid = ''; }
    const hit = runningLaneBlocker({ taskId, seg, cardBody: c.body, sid, role, allowParallel });
    if (hit.blocked) {
      const s = hit.session || {};
      const session = { seg, pid: s.pid ?? null, id: s.id || s.session_id || null, owner: s.owner || null, source: s.source };
      if (s.source === 'card_busy') {
        const live = (hit.live || []).map((l) => `${l.seg || '?'}(pid=${l.pid},owner=${l.owner || ''})`).join(';');
        return reject(`card_busy(seg=${seg},live=${live}):second_exec_lane`, { session, live: hit.live });
      }
      return reject(
        `session_running(seg=${seg},pid=${s.pid ?? ''},id=${s.id || s.session_id || ''},owner=${s.owner || ''}):reuse_existing`,
        { session },
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
  // ---- ①c-b2 定基解析（T-20261015-133720）：显式 `--base` ⇒ 不介入（显式意图绝不改判）；
  //      否则解析「本卡应有的 base」，其中**跨卡叠卡**（depends_on 链上未并入 main 的前置）是本卡的修复面。
  //      「同卡续接」仍交给 lane-isolation 自己推导（那里是它的正本），此处复算只为与依赖候选**比大小**：
  //      只有当选出的最大元**确实来自依赖**时才把 base 显式传下去 —— 选到 prev_seg 时（**若它胜出**）一律不传，
  //      保持 `T-20261014-112936` 的推导路径与 `isolation.base` 证据**逐字节不变**（不回归）。
  //      role=review 不参与：复核 lane 是**读者**（不隔离、不建树，靠 pin commit），它没有「建在哪个
  //      tip 上」这回事；给读者加一道写者的拒绝门是错位的（隔离政策同款：隔离写者，不隔离读者）。----
  const baseDerived = base || role === 'review'
    ? null
    : resolveSpawnBase({ repo: baseCwd, taskId, seg, fm: c.fm, sessions: sessionsBySeg(c.body) });
  if (baseDerived && baseDerived.error) {
    // 候选互不包含 ⇒ 无法判定哪一个才是「本卡应有的 base」：告警并拒绝起 lane（绝不静默落 main）
    return reject(`base_undeterminable(${baseDerived.error}):specify_base`, { base: baseDerived });
  }
  const depBase = baseDerived && baseDerived.source === 'dependency' ? baseDerived : null;

  const isoPlan = laneIsolationPlan({
    taskId, seg, role, cwd: baseCwd, fm: c.fm, enabled: isolateEnabled, dryRun,
    // 续接定基（T-20261014-112936）：既有 seg 登记 + 显式 --base ⇒ 由 lane-isolation 推导建树基准
    sessions: sessionsBySeg(c.body),
    base: depBase ? depBase.ref : base,
  });
  if (depBase && isoPlan.base && isoPlan.base.source === 'explicit') {
    // 这个 ref 是入口按**卡面依赖**推导出来的，不是调用者的 `--base` ⇒ 证据须标明来源，否则
    // 「这棵树为什么建在这个 tip 上」在输出里读不出来（可审计性正是本卡的验收面之一）。
    isoPlan.base = { ref: depBase.ref, source: 'dependency', dep: depBase.dep, resolved: depBase.resolved };
  }
  if (depBase && isoPlan.mode === 'none' && isoPlan.reason === 'no_concurrent_lane') {
    // 本卡应有 base（未并入的前置 tip），但本次**不会建隔离树** ⇒ lane 的 cwd 是共享 checkout 的
    // `HEAD`（= main），前置产物同样不在 ⇒ 这正是本卡要消灭的错基，只是换了个入口。
    // fail-closed：告警并拒绝（`--base <ref>` 可显式接管；前置并入 main 后本判据自动消失）。
    return reject(
      `base_required_not_isolated(dep=${depBase.dep},base=${depBase.ref}):specify_base`,
      { base: depBase, isolation: isoPlan },
    );
  }
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

  // ---- ⑤ 会话句柄 ----
  // claude / codex-cli：确定性 UUIDv5（ACL）——codex 无 `--session-id`，其 id 由宿主自赋，
  //   故对 codex-cli 仅作登记/id 占位（沿用现状）。
  // 插件 lane：**放弃**确定性 UUIDv5（契约 §3.3 G4）——句柄 = native thread id，spawn 前不可知，
  //   登记走两步回填（步① id:pending → 步② id:<thread_id>），故此处不取 sessionIdFor。
  let sid = null;
  if (harness !== 'plugin') {
    try {
      sid = sessionIdFor(card, owner, seg).session_id;
    } catch (e) {
      return reject(`session_id_failed:${String(e && e.message ? e.message : e)}`);
    }
  }

  // ---- ⑥ 组装命令 ----
  const prompt = buildPrompt({ handoffPath, cardPath, reportPath, isolation });
  const bin = harness === 'plugin' ? pluginBin() : backendBin(backend);
  const built = buildCommand({ backend, harness, bin, prompt, wsDir, sid, name: `${owner}-${seg}`, cwd });
  const args = built.args;
  const plan = {
    ok: true,
    dryRun,
    // 插件 lane 的卡面 id 在步①为 `pending`、步②为 native thread id（契约 §3.1）
    session_id: harness === 'plugin' ? null : sid,
    thread_id: null,
    id_state: harness === 'plugin' ? 'pending' : '',
    harness,
    pid: null,
    role,
    settings,
    cwd,
    isolation,
    // 定基解析证据（T-20261015-133720）：自动路径（无 `--base`）从卡面推出的 base 及其候选集。
    // 不消除歧义就不报账 = 又一次隐性错基；显式 `--base` 时无此字段（由 isolation.base.source=explicit 表达）。
    ...(baseDerived ? { base: baseDerived } : {}),
    handoff: handoffState,
    log: outLog,
    errlog: errLog,
    backend,
    seg,
    owner,
    task_id: taskId,
    reaper: opts.reaper !== false && reaperEnabled() ? 'would_arm' : 'disabled',
    ...(claims.length ? { claims } : {}),
    cmd: [bin, ...args],
    cmdline: [bin, ...args].map((s) => (/[\s"'$]/.test(s) ? JSON.stringify(s) : s)).join(' '),
  };
  if (dryRun) return plan;

  // ---- ⑥b G8：lane 启动即导出网关日志（契约 §8.7；**放在 spawn 之前** ⇒ 导出失败则零副作用拒绝，
  //        不在无证据的情况下起 lane —— 契约 R3「不静默丢证据」）----
  if (harness === 'plugin') {
    const exp0 = exportPluginLogs({ wsDir, seg });
    if (!exp0.ok) return reject(`${exp0.reason}:blocked`, { seg });
  }

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
  const dispatchPid = child.pid;

  // ---- ⑧ 登记 ----
  // 插件分支：**两步回填**（契约 §3.1 / §8.3）——步① pending 同写；读回 native thread id 后步② bound 同写。
  // 卡面 upsert 键 = `seg:<seg> ·` ⇒ 两步写的是**同一卡内行**（无重复行）；registry 侧由绑定步关闭
  // pending 行（`closePendingEntries`，契约 §11 G-1），避免 pending/bound 双 running 双计额度。
  if (harness === 'plugin') {
    const gwPid = gatewayPid();
    const regPend = sessionSet(card, {
      seg, owner, backend, harness, phase, pid: gwPid, log: outLog, status: 'running',
      id: 'pending', id_state: 'pending',
    });
    if (!regPend.ok) {
      try { process.kill(dispatchPid, 'SIGTERM'); } catch { /* 已退出/无权限：忽略 */ }
      return reject(`session_set_failed:${regPend.reason || 'unknown'}`, { detail: regPend, dispatch_pid: dispatchPid });
    }

    // ---- ⑨ 绑定：读回 native thread id（超时 ⇒ lane 判 failed，不静默挂起；契约 §3.2）----
    const bound = awaitThreadId(outLog, {
      timeoutMs: opts.bindTimeoutMs ?? THREAD_BIND_TIMEOUT_MS,
      pollMs: opts.bindPollMs ?? THREAD_BIND_POLL_MS,
    });
    if (bound.timeout) {
      try { aclSessionClose(card, seg, 'failed'); } catch { /* 关闭失败不掩盖主错：主因是绑定超时 */ }
      try { process.kill(dispatchPid, 'SIGTERM'); } catch { /* 已退出/无权限：忽略 */ }
      return reject(`thread_bind_timeout(seg=${seg},ms=${bound.ms}):reconcile`, { seg, dispatch_pid: dispatchPid });
    }

    const regBound = sessionSet(card, {
      seg, owner, backend, harness, phase, pid: gwPid, log: outLog, status: 'running',
      id: bound.threadId, id_state: 'bound', thread_id: bound.threadId,
    });
    if (!regBound.ok) {
      try { process.kill(dispatchPid, 'SIGTERM'); } catch { /* 已退出/无权限：忽略 */ }
      return reject(`session_set_failed:${regBound.reason || 'unknown'}`, { detail: regBound, dispatch_pid: dispatchPid });
    }

    // 终态前再导一次（契约 §8.7）。导入失败不掩盖 lane 已在跑的事实：记 warnings、显式回报。
    const exp1 = exportPluginLogs({ wsDir, seg });
    const warnings = [...(regBound.warnings || [])];
    if (!exp1.ok) warnings.push(exp1.reason);

    return {
      ...plan,
      pid: null,                 // 插件 lane 无独立 pid（句柄 = native thread id）
      dispatch_pid: dispatchPid, // 调度器进程 pid（证据/审计用，非 lane 句柄）
      thread_id: bound.threadId,
      id_state: 'bound',
      session_id: bound.threadId,
      handoff: regBound.handoff === 'created' ? 'created' : handoffState,
      card: regBound.cardPath || cardPath,
      registry: regBound.registry,
      evidence: exp1.ok ? exp1.manifest : null,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  // CLI 分支（现状不变）：一步登记（卡 + registry 同写）
  const reg = sessionSet(card, { seg, owner, backend, phase, pid: dispatchPid, log: outLog, status: 'running', id: sid });
  if (!reg.ok) {
    try { process.kill(dispatchPid, 'SIGTERM'); } catch { /* 已退出/无权限：忽略 */ }
    return reject(`session_set_failed:${reg.reason || 'unknown'}`, { detail: reg, pid: dispatchPid });
  }

  // ---- ⑨ 会话终态看守（lane 一死必写终态；见 lane-reaper.mjs 与 guides/lane-session-lifecycle-sop.md）----
  // fail-closed：看守起不来 ⇒ 把已登记的行就地收口（ACL 唯一写点，两侧同写）后拒绝起会话。
  // 「登记了却无人负责收口」正是本卡要消灭的失败模式：宁可不跑这条 lane，也不留下一条无人收口
  // 的 running 登记（它会同时污染 check-sessions 与 poll 的陈旧恢复面）。
  const reaperOn = opts.reaper !== false && reaperEnabled();
  let reaperState = { state: reaperOn ? 'armed' : 'disabled' };
  if (reaperOn) {
    const armed = armLaneReaper({ card, seg, pid: dispatchPid, owner, env: process.env });
    if (!armed.ok) {
      const closed = (() => { try { return sessionClose(card, seg, 'closed'); } catch (e) { return { ok: false, reason: String(e && e.message ? e.message : e) }; } })();
      try { process.kill(dispatchPid, 'SIGTERM'); } catch { /* 已退出/无权限：忽略 */ }
      return reject(`lane_reaper_failed(${armed.reason})`, { detail: armed, dispatch_pid: dispatchPid, session_close: closed, session: { seg, pid: dispatchPid, id: sid } });
    }
    reaperState = { state: 'armed', pid: armed.pid };
  }

  return {
    ...plan,
    pid: dispatchPid,
    handoff: reg.handoff === 'created' ? 'created' : handoffState,
    card: reg.cardPath || cardPath,
    registry: reg.registry,
    reaper: reaperState,
    ...(reg.warnings ? { warnings: reg.warnings } : {}),
  };
}

/** 插件 lane 登记里的 `pid` = 网关进程 pid（可经 env 提供）；未知 ⇒ 占位 `-`（契约 §4.3） */
export function gatewayPid() {
  const p = process.env.OPENCLAW_GATEWAY_PID;
  return p && /^\d+$/.test(String(p).trim()) ? String(p).trim() : '-';
}

const HELP = `用法: bash scripts/spawn-lane.sh <card> <owner> [seg=seg1] [backend=claude|codex] [harness=cli|plugin] [phase=<p>] [role=exec|review] [parallel=1] [--review] [--plugin] [--dry-run] [--no-isolate] [--no-reaper] [--base <ref>]

新 lane 起会话的单一强制入口（claim → handoff 自检 → settings 预置 → spawn → session-set 卡+registry 同写
→ 起会话终态看守）。
role=exec（默认）起执行 lane（in_progress 卡）；role=review（--review 等价）起复核 lane（in_review 卡，
不 claim、不校验 claimed_by，未给 seg= 时默认 segR1）。
同卡防双跑（spawn 前，零副作用）：同 seg 已有活跃 lane（卡行 / registry phase=seg / registry session_id
= 本 seg 确定性 id 任一命中）⇒ 拒绝复用既有 session；执行 lane 遇该卡**已有任意活跃 lane** ⇒ 拒绝第二条
执行 lane（card_busy）。同一计划内有意并行多分段须显式声明 parallel=1。
harness=cli（默认）走现状 \`codex exec\` 子进程；harness=plugin（--plugin 等价，**仅 backend=codex**）
走官方 codex 插件 app-server embedded harness turn（句柄 = native thread id，非 pid）：
spawn 先写 id:pending（卡+registry 同写），读回 thread id 后覆盖同一 seg 行写 id:<thread_id>（id_state=bound）；
绑定超时 THREAD_BIND_TIMEOUT_MS（默认 120000ms）⇒ lane 判 failed 并回报，不静默挂起。
同仓已有并发非终态 lane ⇒ 自动建隔离 worktree（cwd 指向该树）；同文件冲突 ⇒ 拒绝并提示串行；
隔离树的 base：续接上一 seg ⇒ 上一 seg 的 lane 分支 tip（首 seg ⇒ HEAD）；--base <ref> 显式指定且
不可解析即拒绝。**未给 --base 时还会解析卡面依赖**：depends_on 链上有分支 tip 尚未并入 HEAD（叠卡前置）
⇒ 以该 tip 建树（isolation.base.source=dependency），绝不静默落 main；若两个未合并前置互不包含 ⇒
base_undeterminable(base_ambiguous) 拒绝，若应有 base 但本次不建隔离树 ⇒ base_required_not_isolated 拒绝。
--no-isolate（或 OPENCLAW_LANE_ISOLATION=0）关闭该自动化（回退为显式纪律）。
起会话成功后自动起**会话终态看守**（lane-reaper.mjs，detached）：lane 进程一死（正常/被杀/超时/崩溃）
即经 ACL session-close 写完卡行 status + 清 active_session_id + registry 终态；起看守失败即拒绝起会话
（fail-closed，且会先把已登记的行收口）。--no-reaper（或 OPENCLAW_TEAM_REAPER=0）关闭该自动化。
禁「直跑 claude -p / codex exec 不登记」；见 guides/spawn-lane-sop.md、guides/lane-session-lifecycle-sop.md、guides/codex-plugin-lane-contract.md、
禁「直跑 claude -p / codex exec 不登记」；见 guides/spawn-lane-sop.md、guides/codex-plugin-lane-contract.md、
guides/worktree-isolation-sop.md 与 PROTOCOL §⑥。

示例:
  bash scripts/spawn-lane.sh T-20261010-052210 linus --dry-run
  bash scripts/spawn-lane.sh T-20261010-052210 linus seg=seg1 backend=claude
  bash scripts/spawn-lane.sh T-20261010-052210 linus seg=seg2            # 续接 seg1 ⇒ base=lane/<card>-seg1
  bash scripts/spawn-lane.sh T-20261010-052210 linus seg=seg2 --base 43bdf5f   # 显式定基
  bash scripts/spawn-lane.sh T-20261010-052210 turing --review backend=codex
  bash scripts/spawn-lane.sh T-20261010-052210 turing backend=codex harness=plugin --dry-run
  OPENCLAW_LANE_ISOLATION=0 bash scripts/spawn-lane.sh T-20261010-052210 linus   # 显式纪律回退
  OPENCLAW_TEAM_REAPER=0 bash scripts/spawn-lane.sh T-20261010-052210 linus      # 关闭会话终态看守
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
