#!/usr/bin/env node
/**
 * check-merge.mjs — 交付合并巡检：已关闭卡的 worktree 检出必须已并入**集成分支**（纳入 check-all fast 段）
 * 依据：PROTOCOL §6.4（卡的产物必须先并入集成分支才算交付）；PROTOCOL §20.1（机检门禁登记）；
 *       PROTOCOL §20.2（明确不机器化的规则）；guides/dev-worktree-flow-sop.md（集成分支开发流）。
 *
 * 口径一句话：`<repo>/.worktrees/` 下每一个**检出**，若其归属卡已 `done`，则该检出所在分支
 * **必须是**集成分支**的祖先**——缺省 `dev`，`OPENCLAW_TEAM_INTEGRATION_BRANCH` 可改
 * （`lib.mjs#integrationBranch()`，与车道提示语同源）；否则判红。
 *
 * ── (i) 为什么需要这个门禁：这是一条被声明了很久、却从无机检的不变量 ──────────────
 *   `PROTOCOL §6.4` 原文把「卡的产物必须先并入集成分支才算交付」定为**终态 `done` 的前置条件**，
 *   roles/elon 的验收纪律、worker-report-template 的 A2/A8 槽位都复述了它。但在本门禁落地前，
 *   **全库没有任何一行代码读过它**：`check-card.mjs` 只校验 frontmatter schema（读单卡、
 *   看不见上一次状态，结构上不可能校验转移）；`check-report.mjs` 只校验 Report 的**槽位存在性**，
 *   其 `commitCoordinate` 仅作 hint 且从不置退出码；进入 `done` 在 ACL 侧只要求 actor ∈ {elon,lib}
 *   且卡非终态，**写卡层是 git-blind 的**。全库对 `rev-list`/`ahead`/`merge-base --is-ancestor`
 *   的唯一用法在 `spawn-lane.mjs` 的**定基**处，与收口无关。
 *   ⇒ 「未合并的分支不是交付」在此之前纯属**人肉纪律**。本脚本把它变成机检。
 *
 * ── (ii) 判定对象：扫 `.worktrees/*` 的**检出**，而不是扫分支名 ────────────────────
 *   新开发流（guides/dev-worktree-flow-sop.md）里，隔离树落在**仓内** `<repo>/.worktrees/<branch>`
 *   ——这正是 `using-git-worktrees` skill Step 1b 的默认落点。故巡检面是「仓内 `.worktrees/` 下的
 *   实际检出」，而不是「名字像不像某个分支」：
 *     · 每个子的分支用 `git -C <子目录> symbolic-ref --short -q HEAD` 读**真实检出**；
 *     · detached HEAD（读不到）⇒ 退回**目录名**（约定：目录名即分支名）。
 *   只按目录名推断会把「检出与目录名不一致」这类现场悄悄放过；读真实检出更诚实。
 *
 * ── (iii) 触发面：只对**归属卡已 `done`** 的检出硬判 ──────────────────────────────
 *   这是本门禁最容易做错的地方。**作业中的车道天然持有一个未合并的 worktree**（隔离树的存在
 *   就是为了让她在合并前改东西）⇒ 若无条件硬判，**每一条在跑的 lane 都会被判红**，门禁上线即全红。
 *   故判定收窄为：该检出归属的卡 `status === 'done'` 才硬判。
 *   · 归属卡非终态（`todo`/`in_progress`/`in_review`/`blocked`/`backlog`）⇒ **skip**（正常在途）；
 *   · 归属卡 `canceled` ⇒ **skip**：废弃的产物不必合并，把它判红是翻旧账（与 check-report 的
 *     终态口径一致）；
 *   · **归属卡找不到**（缓存树、手工树、卡已被归档）⇒ **skip + warn**：无从判断「该不该合并」，
 *     不得凭猜测转红。这是已知上限，见 (vi)。
 *
 *   归属判定（`cardOfBranch`）：分支名即卡 id（新流程的提示语固定了该命名）；亦接受
 *   `<card-id>-<seg>` 形状（分段交付），逐级去掉尾部 `-<段>` 直到命中板上某张卡。
 *
 * ── (iv) 生效截止 + 历史卡降 warn（no retro-reddening）──────────────────────────
 *   与 `check-report.mjs` 同口径：卡面 `created_at < EFFECTIVE_AT`（默认常量，可用
 *   `OPENCLAW_TEAM_MERGE_EFFECTIVE_AT` 覆盖，ISO 8601）⇒ **grandfather**：违规降为 **warn**、
 *   **不置退出码**。理由同 check-card 的 `__team__` target 规则（T-20261013-023535-2）：门禁目的是
 *   捕获**交付时**的缺陷，历史卡不追溯转红。`created_at` 缺失/不可解析 ⇒ 同样按 grandfather 处理
 *   （保守：绝不因缺字段转红）。非法的时间覆盖值 ⇒ 回退常量，**绝不静默变严**。
 *
 * ── (v) 豁免机制（照 check-report/check-idem 的 baseline 口径）───────────────────
 *   ① **托管模板** `BASELINE_PATH = <本目录>/merge-baseline.json`：随 install.sh §1 的
 *      `team/scripts/**` 部署树进实例 ⇒ **只读**，仓内副本是唯一权威。**仓内副本必须保持
 *      `cards: []`**（「仓内不得夹带豁免」被单测钉住）。运行时不写此文件。
 *   ② **运行时登记** `runtimeBaselinePath(tasksDir)` = `<被巡检 tasks 目录>/.merge-baseline.json`：
 *      `install.sh` 不部署 `tasks/` ⇒ 升级不清回登记；随 tasksDir 派生 ⇒ 单测隔离 root 自动读空登记。
 *   生效登记 = ① ∪ ②。登记项 `{ id, branch?, reason }`；`reason` **必填**且去空白后 ≥8 字符
 *   （`validExemption`），不合格 ⇒ **不放行**并点入 `invalidExemptions`。
 *   判据（防「登记一次、永久放行」）：`id` 命中 **且**（登记未写 `branch`，或 `branch` 与该检出
 *   分支**完全一致**）⇒ 放行。分支换了 ⇒ 豁免失效。
 *   `--no-baseline` 忽略两源（核查真违规/登记是否过期）。
 *
 * ── (vi) 已知上限（残余）—— 不得假装已门禁 ─────────────────────────────────────
 *   · **worktree 被移除后无法复查**：合并前就把树删了，则既查不到分支未合并，也查不到合并——本
 *     门禁**看不见已消失的树**。这是本口径最大的口子，故收口顺序必须「先合并、后 `--remove`」。
 *   · **分支名不合规即漏检**：既有的 `lane/<slug>` 一类手工分支名不含卡 id ⇒ 归属判定失败 ⇒
 *     skip + warn（不转红，也不放行）。
 *   · **只覆盖「未并入集成分支」**，不覆盖「合并了但质量不合格」——后者是 Turing/Elon 的职责。
 *   · **归属卡找不到**的一律 skip（见 (iii)）。
 *   以上四条必须同步记入 `PROTOCOL §20.2`（Not Machine-Checkable），不得在别处声称已机检。
 *
 * ── (vii) repo 定位与「不敢判」的处置 ─────────────────────────────────────────
 *   `.worktrees/` 在**分发仓**里，不在实例里（live 模式下 `TASKS_DIR` 是 `<openclaw>/team/tasks`）。
 *   仓根解析与 `team/automations/dispatch.mjs#resolveRepoDir`（`{repo}` 占位符）**逐字同源**：
 *   `$OPENCLAW_TEAM_REPO`（须存在）→ `TEAM_DIR/.install-state.json` 的 `repoPath`（须存在）→ ""。
 *   **本处是刻意重复，不 import dispatch.mjs**：`scripts/host-paths.mjs` 的头注把
 *   「`scan-deps.mjs` / provider 的 `team-paths.mjs` / `dispatch.mjs`」列为**有意不合并**的
 *   重复解析（"免得下一个人再加第四个"），且本仓刻意没有 `scripts/ → automations/` 的依赖边。
 *   多一处解析的代价是漂移风险，故此处语义必须与 dispatch.mjs 对齐，改一处要同时改另一处。
 *   **不敢判的三态一律 skip + warn，绝不转红**（假红比漏报更有害，且本门禁是新增面）：
 *     · 仓根解析不到（drop 到 `repo-missing`）；
 *     · `<repo>/.worktrees/` 不存在（尚无隔离树 ⇒ 无事可查）；
 *     · 集成分支在仓里解析不到（**关键**：`merge-base --is-ancestor X <integ>` 在该分支不存在时返回
 *       非零，若不加这道守卫，会与「未合并」不可区分 ⇒ 把没有该分支的仓全判红）。
 *
 * 退出码：0 无「非豁免硬违规」（含 grandfather warn / skip）；1 有之。用 `process.exitCode` 而非
 * `process.exit`：管道 stdout 的 JSON 不得被截断（调用方要解析）。隔离：`OPENCLAW_TEAM_ROOT` /
 * `OPENCLAW_TEAM_REPO` / `OPENCLAW_TEAM_INSTALL_STATE` 覆盖，便于单测 mkdtemp。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, TASKS_DIR, integrationBranch } from './lib.mjs';

// ---------- 常量与口径 ----------

/** 隔离树目录名（仓内）。`using-git-worktrees` skill Step 1b 的默认落点即此。 */
export const WORKTREES_DIRNAME = '.worktrees';

/**
 * 集成分支名**不再是本模块的常量**：它是 `lib.mjs#integrationBranch()`（缺省 `dev`，
 * `OPENCLAW_TEAM_INTEGRATION_BRANCH` 可改）。单一出处的理由见 lib.mjs —— 门禁查的分支与车道
 * 提示语里让车道的分支**必须**是同一个名字，否则两边各说各话、门禁静默失效。
 */

/** 硬判状态：**只有** `done`。作业中的卡天然持有未合并的树，判它必红（见 (iii)）。 */
export const HARD_STATUS = 'done';

/**
 * 生效截止。默认 = 本门禁落仓时刻（2026-10-16）。覆盖：`OPENCLAW_TEAM_MERGE_EFFECTIVE_AT`
 * （ISO 8601；非法值 ⇒ 回退常量，绝不静默变严）。
 */
export const EFFECTIVE_AT = '2026-10-16T10:43:23Z';
export function effectiveAt() {
  const raw = process.env.OPENCLAW_TEAM_MERGE_EFFECTIVE_AT;
  if (!raw) return EFFECTIVE_AT;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : EFFECTIVE_AT;
}

export const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'merge-baseline.json');
/** 运行时登记文件名：落在**被巡检的 tasks 目录**内（非部署托管、单测自动隔离；同 check-report）。 */
export const RUNTIME_BASELINE_NAME = '.merge-baseline.json';
export function runtimeBaselinePath(tasksDir = TASKS_DIR) {
  return path.join(tasksDir, RUNTIME_BASELINE_NAME);
}

/** 登记面 = 托管模板（①，只读）∪ 运行时登记（②，tasks 目录内）。本函数只负责**读**。 */
export function loadBaseline(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw && raw.cards) ? raw.cards : [];
  } catch { return []; }
}
export function loadExemptions(tasksDir = TASKS_DIR, { template = BASELINE_PATH, runtime = runtimeBaselinePath(tasksDir) } = {}) {
  return [...loadBaseline(template), ...loadBaseline(runtime)];
}

/** 豁免理由最小长度（口径对齐 check-report / check-idem）。 */
export const MIN_EXEMPTION_REASON = 8;

/** 登记项是否**有效**：形状 `{ id, reason }`（`branch` 可选）且 `reason` 去空白后 ≥8 字符。
 *  理由不是形式主义：登记项只能证明「还是那条分支」，说不清「为何未合并是良性的」——
 *  豁免的全部合法性来源就是那句人工判断，写不下来就等于没有。 */
export function validExemption(e) {
  return Boolean(e) && typeof e.id === 'string' && e.id !== ''
    && typeof e.reason === 'string' && e.reason.trim().length >= MIN_EXEMPTION_REASON;
}

// ---------- git 探测（只读；只用内置命令） ----------

/**
 * 分发仓检出定位。语义**必须**与 `team/automations/dispatch.mjs#resolveRepoDir` 一致
 * （两处刻意重复，非合并；理由见头注 (vii)）：
 *   1. `$OPENCLAW_TEAM_REPO`，且指向**存在**的目录；
 *   2. 否则 `TEAM_DIR/.install-state.json` 的 `repoPath`，且指向存在的目录
 *      （状态文件位置可用 `$OPENCLAW_TEAM_INSTALL_STATE` 覆盖——**存在该 seam 是因为部署实例上
 *       该文件必然存在，没有它单测就钉不死「两条腿都不通 ⇒ 告警，绝不留空」这条契约**）；
 *   3. 都不通 ⇒ `""`（调用方按 (vii) 的「不敢判」处置，**绝不静默当成空串继续跑**）。
 */
export function resolveRepoDir(env = process.env) {
  const fromEnv = String(env.OPENCLAW_TEAM_REPO || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const stateFile = String(env.OPENCLAW_TEAM_INSTALL_STATE || '').trim()
    || path.join(path.dirname(TASKS_DIR), '.install-state.json');
  try {
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const p = String(st.repoPath || '').trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* 无状态文件 / 不可读 ⇒ 未解析 */ }
  return '';
}

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/** 集成分支在仓里是否可解析。解析不到 ⇒ 不敢判（否则 isAncestor 的非零会与「未合并」混淆）。 */
export function integrationRef(repo) {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${integrationBranch()}`]);
  return r.status === 0 ? String(r.stdout).trim() : '';
}

/** 分支是否为集成分支的祖先（只读 `merge-base --is-ancestor`）。 */
export function isMerged(repo, branch) {
  if (!branch) return false;
  return git(repo, ['merge-base', '--is-ancestor', branch, integrationBranch()]).status === 0;
}

/** 该 worktree 路径当前**真实检出**的分支；detached 或读不到 ⇒ 退回目录名（约定：目录名即分支名）。 */
export function checkedOutBranch(wtPath) {
  const r = git(wtPath, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const b = r.status === 0 ? String(r.stdout).trim() : '';
  return b || path.basename(wtPath);
}

/**
 * 列出仓内 `.worktrees/` 的检出（只读目录 + 只读 git）。
 * 无该目录 / 仓解析不到 ⇒ `[]`（调用方按 (vii) 的「不敢判」处置）。
 */
export function listWorktrees(repo) {
  if (!repo) return [];
  const dir = path.join(repo, WORKTREES_DIRNAME);
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return names
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => {
      const wtPath = path.join(dir, e.name);
      return { dir: e.name, path: wtPath, branch: checkedOutBranch(wtPath) };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

// ---------- 归属判定 ----------

/**
 * 分支名 → 卡 id。新流程固定「分支名即卡 id」（可带 `-<seg>` 后缀）⇒ 逐级剥掉尾部段位，
 * 第一个命中板上的 id 即归属。命中不了 ⇒ `null`（无从判断「该不该合并」，调用方 skip + warn）。
 */
export function cardOfBranch(branch, ids) {
  if (!branch) return null;
  if (ids.has(branch)) return branch;
  // `<card-id>-<seg>`：从右往左逐段剥离，只认「前段是板上存在的 id」的切法
  const parts = branch.split('-');
  for (let cut = parts.length - 1; cut > 0; cut--) {
    const head = parts.slice(0, cut).join('-');
    if (ids.has(head)) return head;
  }
  return null;
}

// ---------- 扫描 ----------

/**
 * 执行交付合并巡检（只读）。可注入 tasksDir/repo/baseline 供隔离测试。
 * @returns {{ok:boolean, effectiveAt:string, repo:string, integrationResolved:string, worktrees:number,
 *            checked:number, skipped:number, violations:Array, grandfathered:Array, unattributed:Array,
 *            exempt:Array, invalidExemptions:Array, notes:Array}}
 */
export function scanMerges(tasksDir = TASKS_DIR, { repo, baseline, env = process.env } = {}) {
  const eff = effectiveAt();
  const effMs = Date.parse(eff);
  const notes = [];

  const violations = [];
  const grandfathered = [];
  const unattributed = [];
  const exempt = [];
  const invalidExemptions = [];
  let checked = 0;
  let skipped = 0;

  // 卡面：id → { status, created_at }
  const cards = new Map();
  const files = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((f) => f.endsWith('.md')) : [];
  for (const f of files) {
    let fm;
    try { ({ fm } = parseFrontmatter(fs.readFileSync(path.join(tasksDir, f), 'utf8'))); } catch { continue; }
    if (!fm) continue;
    cards.set(fm.id || f.replace(/\.md$/, ''), { status: String(fm.status || ''), created_at: String(fm.created_at || '') });
  }

  // 仓根：显式注入 > 既有约定（$OPENCLAW_TEAM_REPO → .install-state.json repoPath）
  const repoDir = repo === undefined ? resolveRepoDir(env) : String(repo || '');
  if (!repoDir) { notes.push('repo-missing'); return finish(); }
  if (!fs.existsSync(path.join(repoDir, WORKTREES_DIRNAME))) { notes.push('no-worktrees-dir'); return finish(repoDir); }

  const integ = integrationRef(repoDir);
  if (!integ) { notes.push(`integration-unresolved:${integrationBranch()}`); return finish(repoDir); }

  const wts = listWorktrees(repoDir);
  const base = baseline === undefined
    ? loadExemptions(tasksDir)
    : (Array.isArray(baseline) ? baseline : []);

  for (const wt of wts) {
    const id = cardOfBranch(wt.branch, new Set(cards.keys()));
    if (!id) { unattributed.push({ dir: wt.dir, branch: wt.branch, why: 'no_card_for_branch' }); skipped++; continue; }
    const card = cards.get(id);
    if (card.status !== HARD_STATUS) { skipped++; continue; }   // 在途 / 已取消：正常，或废弃产物不必合并

    if (isMerged(repoDir, wt.branch)) { skipped++; continue; }

    const created = Date.parse(card.created_at);
    const pastCutoff = Number.isFinite(created) && created >= effMs;
    if (pastCutoff) checked++; else skipped++;

    if (!pastCutoff) {
      grandfathered.push({ id, branch: wt.branch, dir: wt.dir, created_at: card.created_at });
      continue;
    }

    const cands = base.filter((b) => b && b.id === id && (!b.branch || b.branch === wt.branch));
    const hit = cands.find(validExemption);
    if (hit) { exempt.push({ id, branch: wt.branch, dir: wt.dir, reason: String(hit.reason).trim() }); continue; }
    if (cands.length) {
      invalidExemptions.push({ id, branch: wt.branch, dir: wt.dir, reason: String(cands[0].reason ?? '').trim() });
    }
    violations.push({ id, status: card.status, branch: wt.branch, dir: wt.dir });
  }

  return finish(repoDir, integ);

  function finish(repoOut = repoDir, integOut = '') {
    return {
      ok: violations.length === 0,
      effectiveAt: eff,
      repo: repoOut || '',
      integrationResolved: integOut || '',
      worktrees: repoOut ? listWorktrees(repoOut).length : 0,
      checked,
      skipped,
      violations,
      grandfathered,
      unattributed,
      exempt,
      invalidExemptions,
      notes,
    };
  }
}

// ---------- CLI ----------

function main() {
  const args = process.argv.slice(2);
  const noBaseline = args.includes('--no-baseline');
  const repoArg = (() => { const i = args.indexOf('--repo'); return i >= 0 ? args[i + 1] : undefined; })();
  let tasksDir = TASKS_DIR;
  const positional = args.find((a) => !a.startsWith('--') && a !== repoArg);
  if (positional) tasksDir = path.resolve(positional);

  const r = scanMerges(tasksDir, { repo: repoArg, baseline: noBaseline ? [] : undefined });
  console.log(JSON.stringify(r, null, 2));

  if (r.notes.length) {
    console.error(`交付合并巡检**未判定**（未确认 ≠ 通过）：${r.notes.join(', ')}`);
  }
  if (r.violations.length) {
    console.error(`交付合并违例：${r.violations.length} 张已 done 的卡，其 worktree 检出未并入 ${integrationBranch()} —— 按 guides/dev-worktree-flow-sop.md 收口：先合并分支入 ${integrationBranch()}，再移除 worktree（PROTOCOL §6.4：未合并的分支不是交付）`);
    for (const v of r.violations) console.error(`  · ${v.id} [${v.status}] ${WORKTREES_DIRNAME}/${v.dir} → 分支 ${v.branch} 不是 ${integrationBranch()} 的祖先`);
  }
  if (r.grandfathered.length) {
    console.error(`交付合并 warn（生效截止 ${r.effectiveAt} 之前创建的卡 ⇒ 不追溯转红）：${r.grandfathered.length} 条`);
    for (const v of r.grandfathered) console.error(`  · warn ${v.id} created=${v.created_at} 分支 ${v.branch} 未并入 ${integrationBranch()}`);
  }
  if (r.unattributed.length) {
    console.error(`交付合并提示（非阻断）：${r.unattributed.length} 个 worktree 检出无法归属到板上任何卡 —— 分支名不含卡 id 即无从判断该不该合并（PROTOCOL §20.2 已记上限）`);
    for (const v of r.unattributed) console.error(`  · unattributed ${WORKTREES_DIRNAME}/${v.dir} → 分支 ${v.branch}`);
  }
  if (r.exempt.length) {
    console.error(`交付合并基线豁免：${r.exempt.length} 条 —— 登记处＝运行时 ${RUNTIME_BASELINE_NAME} ∪ 托管模板 merge-baseline.json（只读）；分支变化即失效`);
    for (const v of r.exempt) console.error(`  · exempt ${v.id}（${v.reason}）分支 ${v.branch}`);
  }
  if (r.invalidExemptions.length) {
    console.error(`交付合并豁免登记**未生效**（reason 缺失或去空白后 <${MIN_EXEMPTION_REASON} 字符 ⇒ 不放行）：${r.invalidExemptions.length} 条 —— 请在登记项补写可核对的理由`);
    for (const v of r.invalidExemptions) console.error(`  · invalid-exempt ${v.id} reason=${v.reason ? `"${v.reason}"` : '(缺失)'} 分支 ${v.branch}`);
  }
  if (r.violations.length) process.exitCode = 1; // 置退出码而非 process.exit：管道 stdout 不截断
}

// main-guard：经 realpath 归一后比较，符号链接调用亦能命中（与其它 scripts/* 同风格）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
