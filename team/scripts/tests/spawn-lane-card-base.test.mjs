#!/usr/bin/env node
/**
 * spawn-lane-card-base.test.mjs — 自动起 lane 的**跨卡叠卡定基**（T-20261015-133720）
 *
 * 红（本卡的缺陷，§①）：`--base` 是手工纪律，而 **poll/自动起 lane 路径从不传它**（`scripts/poll-run.mjs`
 *   的移交指令原话：`bash scripts/spawn-lane.sh <card> <owner> [seg] [backend]`）⇒ 一张 `depends_on` 的前置卡
 *   **已 done、但其 lane 分支 tip 未并入 main** 时，隔离树静默建在仓 `HEAD`（= main）上，**丢掉前置产物**。
 *   实证（今日两度）：`T-20261015-075826`（`depends_on: T-20261015-063755`，其 tip `fb782dd` 未并入 main）
 *   与 `T-20261015-132952` —— 两次都得由 Linus **非破坏**收掉重起（doomed tip 记档、分支删、registry close）。
 *   已修过的 `T-20261014-112936` 只覆盖**同卡**多段续接（上一 seg 的 lane tip）；**跨卡**前置无人解析。
 *
 * 绿（本卡的修复，§②）：入口在**未给 `--base`** 时自行解析「卡面应有的 base」，档位（高 → 低）：
 *   `--base`（显式，行为不变） > 同卡上一 seg 的 lane tip（行走 lane-isolation 的原路径、证据逐字节不变）
 *   > **`depends_on` 链（传递闭包）上尚未并入 `HEAD` 的 lane 分支 tip**（取**信息最全**的最大元）。
 *   无法判定（两个未合并且互不包含的前置）⇒ `base_undeterminable(base_ambiguous)` **拒绝**；应有 base 却
 *   **不会建隔离树**（单 lane ⇒ lane 会落在共享 checkout 的 `HEAD`）⇒ `base_required_not_isolated` **拒绝**
 *   —— 两者都**绝不静默落 main**（这正是本卡要消灭的失败模式）。
 *
 * 判据分三层，缺一层都算不上「修好了」：
 *   ① **纯函数**：`dependencyChain`（顺序/去重/深度/读不到只少一层）、`depLaneBranches`（名字空间不串卡）；
 *   ② **判定层**：`resolveSpawnBase` 的候选集与最大元选择（含 `base_ambiguous`）；
 *   ③ **落实层**：`spawnLane` 的输出（`isolation.base.source='dependency'` + `isolation.head` = 前置 tip）
 *      与**真建树**（新树里前置的产物文件真在）—— 「算得准」掩盖「建得错」只在这一层能被抓住。
 *
 * 负向（§③）：前置**已并入** `HEAD` ⇒ 无候选、`base` 仍是 `HEAD`（旧行为不变）；显式 `--base` 优先且
 *   **不被改判**（`source='explicit'`）；`--no-isolate` 的回退语义不变（关掉隔离检查 ≠ 起不来 lane）。
 *
 * 隔离：全部跑在 `os.tmpdir()` 下的临时 git 仓；不起子会话/不触网/不碰真实仓与真实看板。
 * 全程**无破坏性 git**：夹具分支经 `hash-object`/`mktree`/`commit-tree`/`branch` 落成，**不切换任何 HEAD**
 * （「已并入」用「分支 tip 即 main tip」建模，而不是真去 merge）。
 * 运行：node --test team/scripts/tests/spawn-lane-card-base.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const SCRIPTS = path.join(HERE, '..');                     // <repo>/team/scripts

/** provider ACL 库定位（有意不随仓；缺 ⇒ SKIP，绝不假红） */
function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    path.join(os.homedir(), '.openclaw', 'team', 'skills', 'task-ops'),
    path.join(os.homedir(), '.openclaw', 'skills', 'task-ops'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, 'lib', 'team-paths.mjs'))) return c;
  return null;
}
const PROVIDER = resolveProviderRoot();
const SKIP = PROVIDER ? false : 'provider ACL library not installed (task-ops is intentionally not vendored)';

/** 「已部署布局」+ 一个**真 git 仓**（= 本测试的「同仓」） */
const LAYOUT = PROVIDER ? (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cardbase-'));
  for (const d of ['scripts', 'tasks', 'tasks/.locks', 'workspace', 'skills', 'bin']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
  }
  fs.symlinkSync(PROVIDER, path.join(root, 'skills', 'task-ops'), 'dir');
  return root;
})() : null;

const SIBLINGS = []; // 本测试建出的隔离树（收尾清理；分支保留，不删）
after(() => {
  for (const s of SIBLINGS) { try { spawnSync('git', ['-C', LAYOUT, 'worktree', 'remove', s], { encoding: 'utf8' }); } catch { /* best effort */ } }
  if (LAYOUT) fs.rmSync(LAYOUT, { recursive: true, force: true });
});

let TASKS, spawnLane, resolveSpawnBase, dependencyChain, depLaneBranches, laneIsolationPlan, applyLaneIsolation, sessionsBySeg;
if (LAYOUT) {
  TASKS = path.join(LAYOUT, 'tasks');
  process.env.OPENCLAW_TEAM_ROOT = LAYOUT; // 必须在 import lib.mjs 之前（TASKS_DIR 在 import 期固化）
  const staged = (rel) => import(pathToFileURL(path.join(LAYOUT, rel)).href);
  ({ resolveSpawnBase, dependencyChain, depLaneBranches, sessionsBySeg } = await staged('scripts/spawn-lane.mjs'));
  spawnLane = (await staged('scripts/spawn-lane.mjs')).spawnLane;
  ({ laneIsolationPlan, applyLaneIsolation } = await staged('scripts/lane-isolation.mjs'));
}

// ── git 夹具 ────────────────────────────────────────────────────────────────
const gOut = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')} 失败: ${r.stderr}`);
  return r.stdout.trim();
};
const gIn = (dir, args, input) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', input });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout.trim();
};

/**
 * 在**不切换任何 HEAD** 的前提下，从 `parent` 上长出一个含 `files` 的新提交并挂成 `branch`
 * （`hash-object` → `mktree` → `commit-tree -p` → `branch`；只新增对象与引用）。
 * @returns {string} 新提交 sha
 */
function commitOnBranch(branch, parent, files, msg) {
  const listing = parent ? gOut(LAYOUT, 'ls-tree', parent) : '';
  const entries = files.map(([name, content]) => {
    const blob = gIn(LAYOUT, ['hash-object', '-w', '--stdin'], content);
    return `100644 blob ${blob}\t${name}`;
  });
  const tree = gIn(LAYOUT, ['mktree'], `${[listing, ...entries].filter(Boolean).join('\n')}\n`);
  const args = ['commit-tree', tree, '-m', msg];
  if (parent) args.push('-p', parent);
  const commit = gOut(LAYOUT, ...args);
  gOut(LAYOUT, 'branch', branch, commit);
  return commit;
}

/**
 * 夹具用**互不复用的卡**（各自的分支 fixture 专属于自己 —— `lane-worktree` 的幂等复用排在定基之前，
 * 若被测 seg 的 lane 分支已然存在，预演会退化成「复用」而忽略 base；`lane-continuation-base.test.mjs`
 * 首版即栽在此）。
 */
const DEP   = 'T-20260102-100001-dep';    // 前置：产物只在 lane 分支上（未并入 main）
const DEP2  = 'T-20260102-100002-dep2';   // 第二个前置：与 DEP 互不包含（扇入歧义用）
const MID   = 'T-20260102-100003-mid';    // 传递依赖的中间卡：自己**无** lane 分支
const MERGED_DEP = 'T-20260102-100004-mdep'; // 前置：**已并入** main（分支 tip 即 main tip）
const STACK = 'T-20260102-100000-stack';  // 主角：depends_on [DEP]，无前驱
const CHAIN = 'T-20260102-100010-chain';  // 传递：depends_on [MID] ⇒ MID depends_on [DEP2]
const MULTI = 'T-20260102-100020-multi';  // 扇入歧义：depends_on [DEP, DEP2]
const OKDEP = 'T-20260102-100030-okdep';  // 前置已并入 ⇒ 旧行为
const EXPL  = 'T-20260102-100040-explicit'; // 显式 --base 优先
const SELF  = 'T-20260102-100050-self';   // 同卡续接：seg1 分支已含 DEP 的产物
const APPLY = 'T-20260102-100060-apply';  // 落实层：真建树
const OTHER = 'T-20260102-100070-other';  // 同仓并发写者（触发自动隔离）
const CONT  = 'T-20260102-100005-cont';   // 名字空间用：同卡多段 lane 分支 + 一张 id 互为前缀的兄弟卡
const SIB2  = 'T-20260102-100080-2';      // 前缀陷阱：依赖卡（**无** lane 分支）
const SIB3  = 'T-20260102-100080-3';      // 前缀陷阱：本卡（**有**自己的 lane 分支；绝不能被读成前置 tip）
const RETRY = 'T-20260102-100090-retry';  // 前置「收掉重起」过：seg1 作废支线（未并入）+ seg2 真产物（**已**并入）
const RETRY2 = 'T-20260102-100091-retry2';// 前置同形但真产物**未**并入 ⇒ 应认出末段 tip（而非判歧义）
const RETRY_SELF  = 'T-20260102-100092-rself';  // 依赖 RETRY（前置已并入 ⇒ 旧行为：HEAD）
const RETRY_SELF2 = 'T-20260102-100093-rself2'; // 依赖 RETRY2（⇒ base = 末段真产物 tip）

const FIX = LAYOUT ? (() => {
  const g = (...a) => gOut(LAYOUT, ...a);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(LAYOUT, '.gitignore'), 'tasks/\nworkspace/\nbin/\nskills/\nscripts/\nclaude-sessions.json\n');
  fs.writeFileSync(path.join(LAYOUT, 'tracked.txt'), 'base\n');
  g('add', '--', '.gitignore', 'tracked.txt');
  g('commit', '-q', '-m', 'init');
  const mainTip = g('rev-parse', 'HEAD');
  // 前置产物**只**存在于其 lane 分支（正是错基会丢掉的东西）
  const depTip = commitOnBranch(`lane/${DEP}-seg1`, mainTip, [['dep-product.txt', 'dep work\n']], 'dep product');
  const dep2Tip = commitOnBranch(`lane/${DEP2}-seg1`, mainTip, [['dep2-product.txt', 'dep2 work\n']], 'dep2 product');
  // 「已并入 main」= 分支 tip 就是 main tip（不真 merge，绝不动 HEAD）
  g('branch', `lane/${MERGED_DEP}-seg1`, mainTip);
  // 同卡续接：seg1 的 tip **包含** DEP 的产物
  const selfSeg1 = commitOnBranch(`lane/${SELF}-seg1`, depTip, [['self-seg1.txt', 'seg1 work\n']], 'self seg1');
  // 名字空间用：同一张卡的两段 lane 分支 + 一张 **id 互为前缀**的兄弟卡分支（前缀 glob 的陷阱）
  const contSeg1 = commitOnBranch(`lane/${CONT}-seg1`, mainTip, [['cont-1.txt', 'c1\n']], 'cont seg1');
  const contSeg2 = commitOnBranch(`lane/${CONT}-seg2`, mainTip, [['cont-2.txt', 'c2\n']], 'cont seg2');
  commitOnBranch(`lane/${CONT}-2-seg1`, mainTip, [['cont-sib.txt', 'sib\n']], 'SIBLING card (id 前缀相同)');
  // 前缀陷阱的入口级复现：本卡 id = 依赖卡 id + `-3`；**本卡自己的** lane 分支存在，依赖卡的分支不存在。
  // 错解（`lane/<dep>-*` 前缀 glob）会把本卡自己的分支读成前置 tip ⇒ 自指错基。
  commitOnBranch(`lane/${SIB3}-seg1`, mainTip, [['sib3.txt', 'sib3\n']], 'self branch of the dependent card');
  // 「收掉重起」形状（今日两度的收尾形状）：早期 seg 是**作废支线**（基于当时的 main，与重起后的产物
  // **互不包含**）；末段才是真产物。RETRY 的末段**已并入** main（分支仍在 —— SOP §7 只收工作树不收分支），
  // RETRY2 的末段**未**并入。判据：作废支线**绝不**能被读成「缺的前置」。
  const retryAbandoned = commitOnBranch(`lane/${RETRY}-seg1`, mainTip, [['doomed.txt', 'doomed attempt\n']], 'abandoned seg1 (收掉重起)');
  g('branch', `lane/${RETRY}-seg2`, mainTip); // 末段已并入 main（同 MERGED_DEP 的建模方式：tip 即 main tip）
  const retry2Abandoned = commitOnBranch(`lane/${RETRY2}-seg1`, mainTip, [['doomed2.txt', 'doomed attempt\n']], 'abandoned seg1 (收掉重起)');
  const retry2Final = commitOnBranch(`lane/${RETRY2}-seg2`, mainTip, [['retry2-product.txt', 'real work\n']], 'final seg2 (未并入)');
  return { mainTip, depTip, dep2Tip, selfSeg1, contSeg1, contSeg2, retryAbandoned, retry2Abandoned, retry2Final };
})() : null;

const porcelain = (dir) => gOut(dir, 'status', '--porcelain');
const R = (dir, ref) => spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' });
const isAncestor = (dir, anc, desc) =>
  spawnSync('git', ['-C', dir, 'merge-base', '--is-ancestor', anc, desc], { encoding: 'utf8' }).status === 0;

function writeCard(id, { status = 'in_progress', claimed = 'linus', deps = [], writes = '', sessions = [], target = LAYOUT } = {}) {
  const sess = sessions.length
    ? `## Sessions\n${sessions.map((s) => `- seg:${s} · owner:linus · backend:claude · id:x · phase:${s} · status:exited · pid:0 · 2026-01-05T00:00:00.000Z`).join('\n')}\n`
    : '## Sessions\n';
  fs.writeFileSync(
    path.join(TASKS, `${id}.md`),
    `---\nid: ${id}\ntitle: card-base fixture\nassignee: ${claimed}\nstatus: ${status}\ngoal: g\n` +
    `project: __team__\ntarget: ${target}\nclaimed_by: ${claimed}\nheartbeat_at: 2026-01-05T00:00:00.000Z\n` +
    `depends_on: [${deps.join(', ')}]\n${writes ? `writes: ${writes}\n` : ''}---\n` +
    `## Background\nx\n## Acceptance\n- [ ] a\n${sess}## Report\n`
  );
}
const clearBoard = () => { for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f)); };
/** 前置卡（终态 ⇒ 不参与「同仓并发」判定，但仍可读：分支名由它们的 `## Sessions` 反推） */
const writeDeps = () => {
  writeCard(DEP, { status: 'done', sessions: ['seg1'] });
  writeCard(DEP2, { status: 'done', sessions: ['seg1'] });
  writeCard(MERGED_DEP, { status: 'done', sessions: ['seg1'] });
  writeCard(MID, { status: 'done', deps: [DEP2] });   // 中间卡：无 lane 分支
  writeCard(SIB2, { status: 'done' });                // 前缀陷阱用：依赖卡无分支
  writeCard(RETRY, { status: 'done', sessions: ['seg1', 'seg2'] });   // 收掉重起：末段已并入
  writeCard(RETRY2, { status: 'done', sessions: ['seg1', 'seg2'] });  // 收掉重起：末段未并入
};
/** 同仓并发写场景：本卡 + 前置卡 + 另一张**非终态**卡 ⇒ 触发自动隔离（没有后者 ⇒ `no_concurrent_lane`） */
const concurrentBoard = (id, opts = {}) => {
  clearBoard();
  writeDeps();
  writeCard(id, { writes: 'team-a.mjs', ...opts });
  writeCard(OTHER, { claimed: 'jobs', writes: 'team-b.mjs' });
};
/** 本卡 fm（判据层直接喂 fm，不经看板） */
const fmOf = (id) => {
  const raw = fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2];
  }
  return fm;
};

// ── ① 纯函数：依赖链 / 分支名字空间 ─────────────────────────────────────────

test('契约. dependencyChain：广度优先、去重、深度上界；读不到的卡只少一层（不抛、不猜）', { skip: SKIP }, () => {
  const A = 'T-20260102-200000-a', B = 'T-20260102-200001-b', C = 'T-20260102-200002-c',
        D = 'T-20260102-200003-d', E = 'T-20260102-200004-e', X = 'T-20260102-200005-x';
  const graph = { [A]: { depends_on: `[${B}, ${C}]` }, [B]: { depends_on: `[${D}, ${A}]` }, [C]: { depends_on: '[]' }, [D]: { depends_on: `[${E}]` }, [E]: { depends_on: `[${X}]` }, [X]: { depends_on: '[]' } };
  const read = (id) => (graph[id] ? { fm: graph[id], body: '' } : null);
  assert.deepEqual(dependencyChain(A, read), [B, C, D, E, X], 'BFS 序 + 去重（B 回指 A 被剔除）+ 传递闭包');
  assert.deepEqual(dependencyChain(A, () => null), [], '一张卡都读不到 ⇒ 空链（绝不臆造依赖）');
  assert.deepEqual(dependencyChain(A, read, 1), [B, C], '深度上界 = 1 ⇒ 只看直接依赖（护栏可注入）');
  assert.deepEqual(dependencyChain(A, (id) => (id === B ? null : read(id))), [B, C], '中间卡读不到 ⇒ 该层断层，但**直接依赖仍在**（B 仍按 id 进候选）');
  assert.deepEqual(dependencyChain(A, (id) => (id === A ? { fm: { depends_on: '[not-a-card, T-20260102-200002-c]' }, body: '' } : read(id))), [C], '非法卡 id 形状剔除（不把 `not-a-card` 当成卡）');
});

test('契约. depLaneBranches：只认该卡**自己登记过的 seg**，不串到 id 互为前缀的兄弟卡', { skip: SKIP }, () => {
  assert.deepEqual(depLaneBranches(LAYOUT, DEP, ['seg1']), [`lane/${DEP}-seg1`], '只有该卡自己的分支');
  assert.deepEqual(
    depLaneBranches(LAYOUT, CONT, ['seg1', 'seg2']).sort(),
    [`lane/${CONT}-seg1`, `lane/${CONT}-seg2`].sort(),
    '整段拆分（多段 lane）都能认出来'
  );
  assert.deepEqual(depLaneBranches(LAYOUT, CONT, ['seg9']), [], 'seg 未登记/分支不存在 ⇒ 不产生候选（分支存在才是过滤器）');
  assert.equal(
    depLaneBranches(LAYOUT, CONT, ['seg1', 'seg2']).includes(`lane/${CONT}-2-seg1`), false,
    '**前缀陷阱**：`lane/T-…-cont-2-seg1` 属于另一张卡（id 互为前缀）⇒ 绝不能被读成本卡的分支'
  );
  assert.deepEqual(depLaneBranches(LAYOUT, 'T-20260102-999999-none', ['seg1']), [], '无分支 ⇒ 空（不抛）');
});

// ── ② 判定层：候选集与最大元 ───────────────────────────────────────────────

test('契约. resolveSpawnBase：未合并的前置 ⇒ 候选；最大元（信息最全者）胜出', { skip: SKIP }, () => {
  clearBoard();
  writeCard(DEP, { status: 'done', deps: [], writes: '', sessions: ['seg1'] });      // 前置：产物只在 lane 分支上
  writeCard(DEP2, { status: 'done', deps: [], writes: '', sessions: ['seg1'] });
  writeCard(MERGED_DEP, { status: 'done', deps: [], writes: '', sessions: ['seg1'] }); // 前置：分支 tip 即 main tip
  writeCard(MID, { status: 'done', deps: [DEP2], writes: '', sessions: [] });          // 中间卡：**无** lane 分支
  writeCard(SIB2, { status: 'done', deps: [], writes: '', sessions: [] });             // 依赖卡：**无** lane 分支
  writeCard(STACK, { deps: [DEP], writes: 'team-a.mjs' });
  writeCard(CHAIN, { deps: [MID], writes: 'team-a.mjs' });
  writeCard(MULTI, { deps: [DEP, DEP2], writes: 'team-a.mjs' });
  writeCard(OKDEP, { deps: [MERGED_DEP], writes: 'team-a.mjs' });
  writeCard(SELF, { deps: [DEP], writes: 'team-a.mjs', sessions: ['seg1'] });
  writeCard(SIB3, { deps: [SIB2], writes: 'team-a.mjs', sessions: ['seg1'] });         // 前缀陷阱：本卡自己的分支在
  writeCard(OTHER, { claimed: 'jobs', writes: 'team-b.mjs' });
  const B = (id, seg, extra = {}) => resolveSpawnBase({ repo: LAYOUT, taskId: id, seg, fm: fmOf(id), sessions: [], ...extra });

  const stack = B(STACK, 'seg1');
  assert.equal(stack.source, 'dependency', JSON.stringify(stack));
  assert.equal(stack.dep, DEP);
  assert.equal(stack.resolved, FIX.depTip, '前置的 lane 分支 tip 就是应然 base');
  assert.deepEqual(stack.candidates.map((c) => c.ref), [`lane/${DEP}-seg1`], '候选集随证据回带（可审计试过什么）');

  const chain = B(CHAIN, 'seg1');
  assert.equal(chain.dep, DEP2, '中间卡无分支 ⇒ 传递闭包给出下一层的可命中者');
  assert.equal(chain.resolved, FIX.dep2Tip);

  const merged = B(OKDEP, 'seg1');
  assert.equal(merged, null, '前置**已并入** HEAD ⇒ 不产生候选（旧行为：base 仍是 HEAD）');

  const fresh = B(OTHER, 'seg1');
  assert.equal(fresh, null, '零依赖零前驱 ⇒ 无候选（不臆造）');

  const multi = B(MULTI, 'seg1');
  assert.equal(multi.error, 'base_ambiguous', JSON.stringify(multi));
  assert.equal(multi.candidates.length, 2, '两个未合并且互不包含的前置都被点名——「无法判定」不是猜，是报账');

  const sib = B(SIB3, 'seg1');
  assert.equal(sib, null, '**前缀陷阱**：依赖卡（`-2`）无分支，本卡（`-3`）自己的分支存在 ⇒ 仍**无候选**（绝不拿自己的分支当前置）');

  const self = B(SELF, 'seg2', { sessions: [{ seg: 'seg1' }] });
  assert.equal(self.source, 'prev_seg', 'seg1 分支**包含**前置产物 ⇒ 最大元是续接 tip（不是前置 tip）');
  assert.equal(self.resolved, FIX.selfSeg1);
  assert.equal(isAncestor(LAYOUT, FIX.depTip, self.resolved), true, '续接 tip 确实以前置 tip 为祖先');
});

test('REGRESSION. 前置「收掉重起」过：作废支线**绝不**当「缺的前置」（末段已并入 ⇒ base 仍 HEAD）', { skip: SKIP }, () => {
  // §① 的**收尾形状**（今日两度的实际收尾）：前置卡被重起过 ⇒ seg1 是作废支线（未并入、与真产物互不
  // 包含），而末段（真产物）已并入 main 且**分支仍在**（SOP §7：只收工作树，不收分支）。
  // 缺陷形状：若把该卡**每一段**未合并的分支都当候选，作废支线的 tip（**不是** HEAD 的祖先）会被读成
  // 「缺的前置」⇒ 新树建在被丢弃的尝试上，丢掉 main 上后来的一切 = 错基换了个形状回来。
  clearBoard();
  writeDeps();
  writeCard(RETRY_SELF, { deps: [RETRY], writes: 'team-a.mjs' });
  writeCard(OTHER, { claimed: 'jobs', writes: 'team-b.mjs' });
  const B = resolveSpawnBase({ repo: LAYOUT, taskId: RETRY_SELF, seg: 'seg1', fm: fmOf(RETRY_SELF), sessions: [] });
  assert.equal(B, null, `前置末段（真产物）已并入 HEAD ⇒ 无候选（作废支线不得入选）：${JSON.stringify(B)}`);
  assert.equal(isAncestor(LAYOUT, FIX.retryAbandoned, FIX.mainTip), false, '夹具前提：作废支线确实**不是** HEAD 的祖先（否则测不到该形状）');

  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: RETRY_SELF, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.base, undefined, '无候选 ⇒ 无入口推导证据');
  assert.deepEqual(
    { ref: r.isolation.base.ref, source: r.isolation.base.source, resolved: r.isolation.base.resolved },
    { ref: 'HEAD', source: 'head', resolved: FIX.mainTip },
    '前置已满足 ⇒ 与修复前逐字段一致（树仍建在 main tip，而不是作废支线）'
  );
});

test('REGRESSION. 前置「收掉重起」过而真产物未并入 ⇒ 认**末段** tip（不因作废支线误判歧义）', { skip: SKIP }, () => {
  clearBoard();
  writeDeps();
  writeCard(RETRY_SELF2, { deps: [RETRY2], writes: 'team-a.mjs' });
  writeCard(OTHER, { claimed: 'jobs', writes: 'team-b.mjs' });
  const B = resolveSpawnBase({ repo: LAYOUT, taskId: RETRY_SELF2, seg: 'seg1', fm: fmOf(RETRY_SELF2), sessions: [] });
  assert.equal(B.error, undefined, `作废支线不与末段比大小 ⇒ 不该判歧义：${JSON.stringify(B)}`);
  assert.equal(B.source, 'dependency');
  assert.equal(B.dep, RETRY2);
  assert.equal(B.resolved, FIX.retry2Final, '前置的产物 tip = 它**末段**（真产物）的落点');
  assert.deepEqual(B.candidates.map((c) => c.ref), [`lane/${RETRY2}-seg2`], '候选集只含末段（作废支线不入候选）');

  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: RETRY_SELF2, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isolation.base.dep, RETRY2, JSON.stringify(r.isolation.base));
  assert.equal(r.isolation.head, FIX.retry2Final, '预演视图的 head 即前置末段 tip');
  assert.notEqual(r.isolation.head, FIX.retry2Abandoned, '绝不能被建到作废支线上');
});

test('契约. resolveSpawnBase：非 git 仓 ⇒ null（这里没有「base」可言，绝不误拒）', { skip: SKIP }, () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-notgit-'));
  try {
    assert.equal(resolveSpawnBase({ repo: notRepo, taskId: STACK, seg: 'seg1', sessions: [] }), null);
  } finally {
    fs.rmSync(notRepo, { recursive: true, force: true });
  }
});

// ── ③ 入口贯通：spawn-lane 自动路径（无 --base） ────────────────────────────

test('ENTRY-FIX. 叠卡 + 无 --base ⇒ 隔离树建在前置分支 tip 上（不再是 main）', { skip: SKIP }, () => {
  concurrentBoard(STACK, { deps: [DEP] });
  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: STACK, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isolation.mode, 'worktree', JSON.stringify(r.isolation));
  assert.deepEqual(
    { ref: r.isolation.base.ref, source: r.isolation.base.source, dep: r.isolation.base.dep, resolved: r.isolation.base.resolved },
    { ref: `lane/${DEP}-seg1`, source: 'dependency', dep: DEP, resolved: FIX.depTip },
    '定基证据须**标明来源是依赖**（否则「这棵树为什么建在这个 tip 上」在输出里读不出来）'
  );
  assert.equal(r.isolation.head, FIX.depTip, '预演视图的 head 即前置 tip');
  assert.notEqual(r.isolation.head, FIX.mainTip, '绝不能再落在仓 HEAD 上——这正是 §① 的缺陷形状');
  assert.equal(r.base.source, 'dependency', '入口自身的定基证据同时报账（含候选集）');
  assert.equal(fs.existsSync(r.cwd), false, 'dry-run 不得建树');
  assert.equal(porcelain(LAYOUT), '', '判定不得改仓');
});

test('REGRESSION. 显式 --base 不被改判（优先于依赖解析，证据仍标 explicit）', { skip: SKIP }, () => {
  concurrentBoard(EXPL, { deps: [DEP] });
  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: EXPL, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true, base: FIX.mainTip });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isolation.base.source, 'explicit', JSON.stringify(r.isolation.base));
  assert.equal(r.isolation.base.ref, FIX.mainTip);
  assert.equal(r.isolation.head, FIX.mainTip, '显式锚点覆盖依赖推导');
  assert.equal(r.base, undefined, '显式路径不产生入口推导证据（由 isolation.base.source 表达）');
});

test('REGRESSION. 前置已并入 HEAD ⇒ 旧行为不变（base=head，树仍建在 main tip）', { skip: SKIP }, () => {
  concurrentBoard(OKDEP, { deps: [MERGED_DEP] });
  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: OKDEP, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.base, undefined, '无候选 ⇒ 无推导证据');
  assert.deepEqual(
    { ref: r.isolation.base.ref, source: r.isolation.base.source, resolved: r.isolation.base.resolved },
    { ref: 'HEAD', source: 'head', resolved: FIX.mainTip },
    '前置已并入 ⇒ 与修复前逐字段一致'
  );
  assert.equal(r.isolation.head, FIX.mainTip);
});

test('REGRESSION. --no-isolate 的回退语义不变（关掉隔离自动化 ≠ 起不来 lane）', { skip: SKIP }, () => {
  concurrentBoard(STACK, { deps: [DEP] });
  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: STACK, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true, isolate: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isolation.mode, 'disabled', JSON.stringify(r.isolation));
  assert.equal(r.cwd, LAYOUT, '回退到显式纪律路径（cwd = project + target）');
  assert.equal(r.isolation.base_ignored, `lane/${DEP}-seg1`, '推导出的 base 未被采用 ⇒ 必须记账（不静默丢弃）');
});

// ── 负向：无法判定 / 无法交付 ⇒ 拒绝（绝不静默落 main） ──────────────────────

test('REJECT. 扇入歧义（两个未合并且互不包含的前置）⇒ 拒绝，零副作用', { skip: SKIP }, () => {
  concurrentBoard(MULTI, { deps: [DEP, DEP2] });
  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: MULTI, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^base_undeterminable\(base_ambiguous\):specify_base$/, r.reason);
  assert.equal(r.base.candidates.length, 2, '拒绝时把两个候选都交出来（可判定由人来做）');
  assert.equal(fs.existsSync(`${LAYOUT}-wt-${MULTI}-seg1`), false, '拒绝路径零副作用（不建树）');
  assert.equal(fs.existsSync(path.join(LAYOUT, 'claude-sessions.json')), false, '拒绝路径零副作用（不写 registry）');
  assert.equal(porcelain(LAYOUT), '');
});

test('REJECT. 应有 base 却不会建隔离树（单 lane ⇒ 共享 checkout 的 HEAD）⇒ 拒绝，零副作用', { skip: SKIP }, () => {
  clearBoard();
  writeDeps();
  writeCard(STACK, { deps: [DEP], writes: 'team-a.mjs' }); // 看板只有本卡 + 终态前置 ⇒ no_concurrent_lane
  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: STACK, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^base_required_not_isolated\(dep=T-20260102-100001-dep,base=lane\/T-20260102-100001-dep-seg1\):specify_base$/, r.reason);
  assert.equal(r.isolation.mode, 'none', JSON.stringify(r.isolation));
  assert.equal(fs.existsSync(path.join(LAYOUT, 'claude-sessions.json')), false, '拒绝路径零副作用（不写 registry）');
  assert.equal(porcelain(LAYOUT), '');
});

test('REJECT. 显式 --base 可接管该拒绝（人可判定 ⇒ 人可钉）', { skip: SKIP }, () => {
  clearBoard();
  writeDeps();
  writeCard(EXPL, { deps: [DEP], writes: 'team-a.mjs' });
  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: EXPL, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true, base: FIX.depTip });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isolation.mode, 'none', '单 lane 仍不隔离（本卡不动隔离政策）');
  assert.equal(r.cwd, LAYOUT);
  assert.equal(r.isolation.base_ignored, FIX.depTip, '显式意图被记账；lane 落在共享 checkout 是调用者的选择');
});

test('REVIEW. 复核 lane 是**读者**：不参与定基解析，也不因前置未并入而被拒（隔离政策同款）', { skip: SKIP }, () => {
  clearBoard();
  writeDeps();
  writeCard(EXPL, { status: 'in_review', deps: [DEP], writes: 'team-a.mjs' }); // 唯一非终态卡 ⇒ 无并发 lane
  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: EXPL, owner: 'turing', seg: 'segR1', role: 'review', backend: 'codex', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isolation.mode, 'none', JSON.stringify(r.isolation));
  assert.equal(r.isolation.reason, 'read_only_role');
  assert.equal(r.base, undefined, '读者没有「建在哪个 tip 上」这回事 ⇒ 不做定基解析（也就没有错基可言）');
});

// ── ④ 落实层：真建树必须建在对的基上（预演算得准 ≠ 建得对） ────────────────

test('APPLY. 叠卡定基**真的**落到树上：新树含前置的产物文件与提交', { skip: SKIP }, () => {
  concurrentBoard(APPLY, { deps: [DEP] });
  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const plan = laneIsolationPlan({
    taskId: APPLY, seg: 'seg1', role: 'exec', cwd: LAYOUT,
    fm: { project: '__team__', target: LAYOUT, writes: 'team-a.mjs' },
    sessions: [], enabled: true, dryRun: true,
    base: `lane/${DEP}-seg1`, // = spawn-lane 解析出并传下去的那个 ref
  });
  SIBLINGS.push(plan.path);
  const a = applyLaneIsolation(plan, { dryRun: false });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.isolation.action, 'created');

  // 硬证据①：跨进程、对**真实工作树**取证的祖先关系
  assert.equal(gOut(a.isolation.path, 'rev-parse', 'HEAD'), FIX.depTip, '新分支恰在前置 tip 上起');
  assert.equal(
    isAncestor(a.isolation.path, FIX.depTip, 'HEAD'), true,
    '§② 的终极判据（落实层）：新树 HEAD 以前置 tip 为祖先——「算出来但没传下去」的 bug 只能在这里被抓住'
  );
  // 硬证据②：前置的产物**真在树里**（不只看 sha —— 文件才是产物）
  assert.equal(
    fs.readFileSync(path.join(a.isolation.path, 'dep-product.txt'), 'utf8'), 'dep work\n',
    '前置的产物文件必须在叠卡树里（这正是错基会丢掉的东西）'
  );
  // 非破坏性：主 checkout 干净、分支未切、HEAD 未动
  assert.equal(porcelain(LAYOUT), '', '建树不得污染共享 checkout');
  assert.equal(gOut(LAYOUT, 'symbolic-ref', '--quiet', 'HEAD'), 'refs/heads/main', '主 checkout 分支未被切换');
  assert.equal(gOut(LAYOUT, 'rev-parse', 'HEAD'), FIX.mainTip, '主 checkout HEAD 未动');
  assert.equal(R(LAYOUT, `refs/heads/${plan.branch}`).status, 0, 'lane 分支已建');
});
