#!/usr/bin/env node
/**
 * lane-continuation-base.test.mjs — 续接 seg 时隔离 worktree 的**定基**（T-20261014-112936）
 *
 * 红（本卡的缺陷，§①）：自动隔离的建树基准恒为仓 `HEAD`。对一张**已有非终态 seg1** 的卡 spawn
 *   seg2，新树建在当时的 main 上 ⇒ **丢掉前一段 seg 的产物**，`merge-base --is-ancestor <seg1 tip> → NO`。
 *   实证：`T-20261013-154930-2` 打回续做时 seg2 被建在错基线上（D42 会修在没有 seg1 成果的树上），
 *   编排者察觉后 kill + `worktree remove --force` + 人工 `--base 43bdf5f` 重建才续上——此前**只能**
 *   靠人肉 `lane-worktree --base <prev-tip>` 绕开（worktree-isolation-sop §⑤ 的 workaround）。
 * 绿（本卡的修复，§②）：**续接上一 seg** ⇒ base = **上一 seg 的 lane 分支 tip**；首 seg ⇒ 缺省 base
 *   （`OPENCLAW_LANE_BASE` 或 `dev`，T-20261015-devbranch，`PROTOCOL §⑥.4`）；
 *   显式 `--base <ref>` 优先，且缺省/显式**不可解析即拒绝**（绝不静默回落成 HEAD——那又是隐性错基）。
 *
 * 判据分三层，缺一层都算不上「修好了」：
 *   ① **纯函数**（`segOrdinal` / `prevSegCandidates`）：前驱候选的有序性与去重；
 *   ② **判定层**（`laneIsolationPlan`）：`isolation.base = {ref, source, resolved, prev_seg}` 且
 *      `isolation.head` 就是 seg1 的 tip（预演视图）；
 *   ③ **落实层**（`applyLaneIsolation` 真建树）：新树里 `merge-base --is-ancestor <seg1 tip> HEAD → YES`
 *      且 seg1 的产物文件**真在树里**。少了这一层，「算得准」会掩盖「建得错」——预演拿到 seg1 tip 而
 *      `lane-worktree` 仍按缺省 HEAD 建树的 bug 只能在这一层被抓住。
 *
 * 负向（§③ 的另一半）：
 *   · 首 seg（`seg1`，无前驱）⇒ `base.source='default'`、`base.ref='dev'`、`head = dev tip`（夹具里 == main tip）；
 *   · 缺 dev 的仓 ⇒ `deriveLaneBase` 回 `error:'base_unresolved:dev'`（缺省同样 fail-closed）；
 *   · `--base <不可解析>` ⇒ `blocked(base_unresolved:*):` ⇒ `spawn-lane` 拒绝起会话，零副作用；
 *   · 隔离**不适用**（单 lane）却给了 `--base` ⇒ 输出带 `base_ignored`（显式意图被记账，不静默丢弃）。
 *
 * 隔离：全部跑在 `os.tmpdir()` 下的临时 git 仓；不起子会话/不触网/不碰真实仓与真实看板。
 * 全程**无破坏性 git**：夹具分支经 `hash-object`/`mktree`/`commit-tree`/`branch` 落成，**不切换任何 HEAD**。
 * 运行：node --test team/scripts/tests/lane-continuation-base.test.mjs
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

/** 「已部署布局」+ 一个**真 git 仓**（本测试的「同仓」）：scripts/ + skills 软链 + 看板目录 */
const LAYOUT = PROVIDER ? (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-contbase-'));
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
  for (const s of SIBLINGS) { try { fs.rmSync(s, { recursive: true, force: true }); } catch { /* best effort */ } }
  if (LAYOUT) fs.rmSync(LAYOUT, { recursive: true, force: true });
});

let TASKS, laneIsolationPlan, applyLaneIsolation, deriveLaneBase, prevSegCandidates, segOrdinal, laneWorktree, spawnLane, parseArgs, resolveCwd, sessionsBySeg;
if (LAYOUT) {
  TASKS = path.join(LAYOUT, 'tasks');
  process.env.OPENCLAW_TEAM_ROOT = LAYOUT; // 必须在 import lib.mjs 之前（TASKS_DIR 在 import 期固化）
  const staged = (rel) => import(pathToFileURL(path.join(LAYOUT, rel)).href);
  ({ laneIsolationPlan, applyLaneIsolation, deriveLaneBase, prevSegCandidates, segOrdinal } =
    await staged('scripts/lane-isolation.mjs'));
  ({ laneWorktree } = await staged('scripts/lane-worktree.mjs'));
  ({ spawnLane, parseArgs, resolveCwd, sessionsBySeg } = await staged('scripts/spawn-lane.mjs'));
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
 * 在**不切换任何 HEAD** 的前提下，从 `parent` 上长出一个含 `files` 的新提交并挂成 `branch`。
 * 手法：`hash-object -w`（落 blob，纯写对象库）→ `mktree`（用 parent 树全量 + 新条目的清单建树）
 * → `commit-tree -p <parent>` → `branch <name> <sha>`。全程只**新增对象与引用**，不动工作树、不动 HEAD。
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
 * 夹具用**三张不同的卡**，各配自己的前驱分支——**绝不复用**「被测 seg 的 lane 名」。
 * 为什么必须分开：`lane-worktree` 的幂等复用分支排在「按 base 建树」**之前**，所以只要被测 seg 的
 * lane 分支**已然存在**（例如夹具为别的用例预建了它），预演就走 `would_reuse` ⇒ `head` 取既有分支 tip
 * 而**忽略 base**。那会让「定基」用例悄悄退化成「复用」用例（本文件首版即栽在此：夹具的
 * `lane/<self>-seg2` 与被测的 seg2 lane 同名）。
 *
 *   SELF  — 续接主角：夹具只有 `lane/<SELF>-seg1`（被测 seg2 的 lane 空闲）
 *   MULTI — 非数值续接：夹具 `lane/<MULTI>-seg1` / `-seg2`（被测 `seg2-container` 的 lane 空闲）
 *   FRESH — 首 seg / 无前驱：**零**夹具分支
 *   OTHER — 并发写者（触发自动隔离；与上面三张同仓、写不同文件）
 */
const SELF = 'T-20260105-600000-self';
const MULTI = 'T-20260105-600010-multi';
const FRESH = 'T-20260105-600020-fresh';
const OTHER = 'T-20260105-600001-other';

/** 夹具主仓（main）+ 三条领先于 main 的 lane 分支（模拟前几段 seg 的已提交产物） */
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
  g('branch', 'dev', mainTip); // 缺省 base = dev（开发集成分支，PROTOCOL §⑥.4）；建在 main tip 上
  const devTip = g('rev-parse', 'dev');
  // 前段 seg 的产物只存在于其 lane 分支、**不在** main 上——正是「续接丢掉前段成果」的那个差
  const seg1Branch = `lane/${SELF}-seg1`;
  const seg1Tip = commitOnBranch(seg1Branch, mainTip, [['seg1-product.txt', 'seg1 work\n']], 'seg1 product');
  const m1Branch = `lane/${MULTI}-seg1`;
  const m1Tip = commitOnBranch(m1Branch, mainTip, [['m1-product.txt', 'm1 work\n']], 'multi seg1');
  const m2Branch = `lane/${MULTI}-seg2`;
  const m2Tip = commitOnBranch(m2Branch, m1Tip, [['m2-product.txt', 'm2 work\n']], 'multi seg2');
  return { mainTip, devTip, seg1Branch, seg1Tip, m1Branch, m1Tip, m2Branch, m2Tip };
})() : null;

const porcelain = (dir) => gOut(dir, 'status', '--porcelain');

function writeCard(id, { status = 'in_progress', claimed = 'linus', writes = '', sessions = [] } = {}) {
  const sess = sessions.length
    ? `## Sessions\n${sessions.map((s) => `- seg:${s} · owner:linus · backend:claude · id:x · phase:${s} · status:exited · pid:0 · 2026-01-05T00:00:00.000Z`).join('\n')}\n`
    : '## Sessions\n';
  fs.writeFileSync(
    path.join(TASKS, `${id}.md`),
    `---\nid: ${id}\ntitle: continuation fixture\nassignee: ${claimed}\nstatus: ${status}\ngoal: g\n` +
    `project: __team__\ntarget: \nclaimed_by: ${claimed}\nheartbeat_at: 2026-01-05T00:00:00.000Z\n` +
    `${writes ? `writes: ${writes}\n` : ''}---\n## Background\nx\n## Acceptance\n- [ ] a\n${sess}## Report\n`
  );
}
const clearBoard = () => { for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f)); };
/** 同仓并发写场景：本卡（可带 `## Sessions` 登记）+ 另一张**非终态**卡 ⇒ 触发自动隔离 */
const concurrentBoard = (id = SELF, sessions = []) => {
  clearBoard();
  writeCard(id, { writes: 'team-a.mjs', sessions });
  writeCard(OTHER, { claimed: 'jobs', writes: 'team-b.mjs' });
};
const R = (dir, ref) => spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' });
const isAncestor = (dir, anc, desc) =>
  spawnSync('git', ['-C', dir, 'merge-base', '--is-ancestor', anc, desc], { encoding: 'utf8' }).status === 0;

/**
 * 判定层入口：指定卡 + 指定 seg。`sessions` **从看板真读回**（经 `spawn-lane.sessionsBySeg` 同一解析器）
 * ——非数值续接的兜底定基走的正是这条链，合成一个数组就等于没测到解析。
 */
const planFor = (id, seg, opts = {}) => laneIsolationPlan({
  taskId: id, seg, role: 'exec', cwd: LAYOUT, fm: { project: '__team__', target: '', writes: 'team-a.mjs' },
  sessions: sessionsBySeg(fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8')),
  enabled: true, ...opts,
});

// ── ① 纯函数：前驱候选（有序 + 去重） ───────────────────────────────────────

test('契约. segOrdinal：只认 `<segN>` 形状（其余 ⇒ null，不猜）', { skip: SKIP }, () => {
  assert.equal(segOrdinal('seg1'), 1);
  assert.equal(segOrdinal('seg12'), 12);
  assert.equal(segOrdinal('seg0'), 0);
  assert.equal(segOrdinal('segR1'), null, '复核 seg 不是数值 seg');
  assert.equal(segOrdinal('seg2-container'), null, '带后缀的 seg 不按数值解析（避免猜错前驱）');
  assert.equal(segOrdinal(''), null);
  assert.equal(segOrdinal(null), null);
});

test('契约. prevSegCandidates：数值前驱在前、卡内既有 seg 逆序兜底，自身/空/重复剔除', { skip: SKIP }, () => {
  assert.deepEqual(prevSegCandidates('seg3', []), ['seg2'], '多 seg 续接的常规形状：只看 seg 名即可定前驱');
  assert.deepEqual(prevSegCandidates('seg1', []), [], '首 seg 无前驱（⇒ base 退回 HEAD，行为不变）');
  assert.deepEqual(prevSegCandidates('seg0', []), [], 'seg0 非「第 N≥1 段」形状 ⇒ 不推导');
  assert.deepEqual(
    prevSegCandidates('seg2', [{ seg: 'seg1' }, { seg: 'segR1' }]),
    ['seg1', 'segR1'],
    '数值前驱优先；卡内既有 seg 逆登记序兜底；seg1 去重（两来源命中同一项）'
  );
  assert.deepEqual(
    prevSegCandidates('seg2-container', [{ seg: 'seg1' }, { seg: 'seg2' }]),
    ['seg2', 'seg1'],
    '非数值续接：只能靠卡 `## Sessions`（逆登记序 ⇒ 最近一段在前）'
  );
  assert.deepEqual(prevSegCandidates('seg2', ['seg1', 'seg1']), ['seg1'], '字符串条目亦可，重复剔除');
});

test('契约. deriveLaneBase：三档来源 + 显式不可解析回 error（纯函数，直接打判据）', { skip: SKIP }, () => {
  const B = (o) => deriveLaneBase({ repo: LAYOUT, taskId: SELF, seg: 'seg2', ...o });
  assert.deepEqual(
    { ref: B({}).ref, source: B({}).source, prev_seg: B({}).prev_seg, resolved: B({}).resolved },
    { ref: FIX.seg1Branch, source: 'prev_seg', prev_seg: 'seg1', resolved: FIX.seg1Tip },
    '② 上一 seg 分支存在 ⇒ 取其 tip，并回带 candidates（可审计试过哪些前驱）'
  );
  assert.deepEqual(B({}).candidates, ['seg1'], 'candidates 一并回带');
  assert.deepEqual(
    { ref: B({ base: FIX.mainTip }).ref, source: B({ base: FIX.mainTip }).source },
    { ref: FIX.mainTip, source: 'explicit' },
    '① 显式 base 恒胜出（此处显式钉在 main，与自动推导的 seg1 tip 不同）'
  );
  assert.equal(B({ base: 'no-such-ref-xyz' }).error, 'base_unresolved:no-such-ref-xyz', '① 显式不可解析 ⇒ error（绝不静默回落）');
  assert.equal(B({ base: 'no-such-ref-xyz' }).ref, undefined, 'error 形状下不给出 ref，调用方无从误用');
  assert.deepEqual(
    { ref: B({ taskId: FRESH, seg: 'seg1' }).ref, source: B({ taskId: FRESH, seg: 'seg1' }).source, fallback: B({ taskId: FRESH, seg: 'seg1' }).fallback },
    { ref: 'dev', source: 'default', fallback: undefined },
    '③ 首 seg（无候选）⇒ 缺省 base=dev，且**不算**回落（它本来就没有前段可接）'
  );
  // ③ 的 fail-closed：缺 dev 的仓 ⇒ error（绝不静默回落 HEAD）——与①同样的不可解析语义
  assert.equal(B({ base: 'dev' }).error, undefined, '前置：夹具确有 dev 分支');
});

test('契约. 缺省 base=dev 的三个覆盖面（env / 显式 / 缺失 fail-closed）', { skip: SKIP }, () => {
  const B = (o) => deriveLaneBase({ repo: LAYOUT, taskId: FRESH, seg: 'seg1', ...o });
  // env 覆盖：OPENCLAW_LANE_BASE=main ⇒ 缺省 base 变成 main
  const prev = process.env.OPENCLAW_LANE_BASE;
  process.env.OPENCLAW_LANE_BASE = 'main';
  try {
    const b = B({ taskId: FRESH, seg: 'seg1' });
    assert.deepEqual({ ref: b.ref, source: b.source, resolved: b.resolved }, { ref: 'main', source: 'default', resolved: FIX.mainTip },
      'OPENCLAW_LANE_BASE 覆盖缺省 base（未迁移历史仓的逃生口）');
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_LANE_BASE; else process.env.OPENCLAW_LANE_BASE = prev;
  }
  // 显式 base 仍优先于 dev 缺省
  const ex = B({ base: 'main', taskId: FRESH, seg: 'seg1' });
  assert.deepEqual({ ref: ex.ref, source: ex.source }, { ref: 'main', source: 'explicit' }, '显式恒胜出');
});

test('REJECT. 仓无 dev 分支 ⇒ deriveLaneBase 返回 error（fail-closed）', { skip: SKIP }, () => {
  // 用一个没有 dev 的临时仓（不动 FIX 主夹具）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-nodev-cb-'));
  const g = (...a) => gOut(dir, ...a);
  try {
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.invalid');
    g('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
    g('add', '--', 'x.txt');
    g('commit', '-q', '-m', 'init');
    const b = deriveLaneBase({ repo: dir, taskId: FRESH, seg: 'seg1' });
    assert.equal(b.error, 'base_unresolved:dev', `缺 dev 必须 fail-closed：${JSON.stringify(b)}`);
    assert.equal(b.ref, undefined, 'error 形状下不给出 ref，调用方无从误用');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── ② 判定层：续接 ⇒ 上一 seg 分支 tip；首 seg ⇒ 缺省 dev ──────────────────

test('NEGATIVE. 首 seg（seg1，无前驱）⇒ base = 缺省 dev（开发集成分支，PROTOCOL §⑥.4）', { skip: SKIP }, () => {
  concurrentBoard(FRESH);
  const p = planFor(FRESH, 'seg1');
  assert.equal(p.mode, 'worktree', JSON.stringify(p));
  assert.equal(p.base.source, 'default', JSON.stringify(p.base));
  assert.equal(p.base.ref, 'dev');
  assert.equal(p.base.resolved, FIX.devTip, '首 seg 的基准是缺省 dev（夹具里 == main tip）');
  assert.equal(p.head, FIX.devTip);
  // 首 seg 的树**不含** seg1 的产物——这对首 seg 是正确的（seg1 就是第一段）
  assert.equal(isAncestor(LAYOUT, FIX.seg1Tip, p.head), false, '首 seg 本就不该含 seg1 产物');
});

test('FIX-1. 续接 seg2（seg1 分支存在）⇒ base = 上一 seg 的 lane 分支 tip（不再是 HEAD）', { skip: SKIP }, () => {
  concurrentBoard(SELF);
  const p = planFor(SELF, 'seg2');
  assert.equal(p.mode, 'worktree', JSON.stringify(p));
  assert.deepEqual(
    { ref: p.base.ref, source: p.base.source, prev_seg: p.base.prev_seg, resolved: p.base.resolved },
    { ref: FIX.seg1Branch, source: 'prev_seg', prev_seg: 'seg1', resolved: FIX.seg1Tip },
    '定基证据须点名前驱 seg 与其 tip（可审计「这棵树建在什么之上」）'
  );
  assert.equal(p.head, FIX.seg1Tip, '预演视图的 head 即 seg1 tip');
  assert.notEqual(p.head, FIX.mainTip, '绝不能再落在仓 HEAD 上——这正是 §① 的缺陷形状');
  assert.equal(
    isAncestor(LAYOUT, FIX.seg1Tip, p.head), true,
    '§② 的验收判据：merge-base --is-ancestor <seg1 tip> <planned head> → YES'
  );
  assert.equal(porcelain(LAYOUT), '', '判定不得改仓');
});

test('FIX-2. 非数值续接（seg2-container 续 seg2）⇒ 由卡 `## Sessions` 兜底定基', { skip: SKIP }, () => {
  concurrentBoard(MULTI, ['seg1', 'seg2']);
  const p = planFor(MULTI, 'seg2-container');
  assert.equal(p.mode, 'worktree', JSON.stringify(p));
  assert.equal(p.base.source, 'prev_seg');
  assert.equal(p.base.prev_seg, 'seg2', '逆登记序取最近一段');
  assert.equal(p.base.ref, FIX.m2Branch);
  assert.equal(p.base.resolved, FIX.m2Tip);
  assert.equal(isAncestor(LAYOUT, FIX.m1Tip, p.head), true, '续在 seg2 上 ⇒ seg1 的产物仍在祖先链上');
});

test('FIX-3. 续接但前驱**无 lane 分支**（未隔离过 / 分支已删）⇒ 退回缺省 base，不猜（但**不静默**）', { skip: SKIP }, () => {
  concurrentBoard(FRESH);
  const p = planFor(FRESH, 'seg2');
  assert.equal(p.mode, 'worktree', JSON.stringify(p));
  assert.equal(p.base.source, 'default', '无前驱可循 ⇒ 缺省 base（dev）；绝不臆造一个 tip');
  assert.equal(p.base.ref, 'dev');
  assert.equal(p.base.resolved, FIX.devTip);
  assert.equal(
    p.base.fallback, 'no_prev_seg_branch',
    '「这是一次续接、但没接上任何前段产物」必须可见——回落是缺省行为，静默才是缺陷'
  );
  // 对照组：**首** seg 不叫 fallback（它本来就没有前段可接）
  assert.equal(planFor(FRESH, 'seg1').base.fallback, undefined);
});

// ── 显式 --base：优先、拒绝不可解析、不适用时记账 ────────────────────────────

test('EXPLICIT-1. 显式 base 优先于自动推导（可钉更早/更晚的锚点）', { skip: SKIP }, () => {
  concurrentBoard(SELF);
  assert.equal(planFor(SELF, 'seg2').base.source, 'prev_seg', '对照组：不给 base 时自动推导到 seg1');
  const p = planFor(SELF, 'seg2', { base: FIX.mainTip });
  assert.equal(p.base.source, 'explicit', JSON.stringify(p.base));
  assert.equal(p.base.ref, FIX.mainTip);
  assert.equal(p.head, FIX.mainTip, '显式锚点覆盖自动推导的 seg1 tip');
  assert.equal(isAncestor(LAYOUT, FIX.seg1Tip, p.head), false, '显式钉在 main ⇒ 确实不含 seg1（由调用者负责）');
});

test('EXPLICIT-2. 显式 base **不可解析** ⇒ blocked（fail-closed），绝不静默回落 HEAD', { skip: SKIP }, () => {
  concurrentBoard(SELF);
  const p = planFor(SELF, 'seg2', { base: 'no-such-ref-xyz' });
  assert.equal(p.mode, 'blocked', JSON.stringify(p));
  assert.equal(p.reason, 'base_unresolved:no-such-ref-xyz', '拒绝原因稳定可 grep');
  assert.equal(fs.existsSync(`${LAYOUT}-wt-${SELF}-seg2`), false, '拒绝路径零副作用（不建树）');
  assert.equal(porcelain(LAYOUT), '');
});

test('EXPLICIT-3. 隔离**不适用**（单 lane）却给了 --base ⇒ base_ignored 记账（显式意图不静默丢弃）', { skip: SKIP }, () => {
  clearBoard();
  writeCard(SELF, { writes: 'team-a.mjs' }); // 看板只有本卡 ⇒ 无并发 lane ⇒ 不隔离
  const p = planFor(SELF, 'seg2', { base: FIX.seg1Tip });
  assert.equal(p.mode, 'none', JSON.stringify(p));
  assert.equal(p.reason, 'no_concurrent_lane');
  assert.equal(p.base_ignored, FIX.seg1Tip, '「提供了但未参与建树」必须可见（否则又是隐性状态）');
  // 关闭开关时同理
  assert.equal(planFor(SELF, 'seg2', { base: FIX.seg1Tip, enabled: false }).base_ignored, FIX.seg1Tip);
  assert.equal(planFor(SELF, 'seg2', { base: FIX.seg1Tip, role: 'review' }).base_ignored, FIX.seg1Tip);
});

// ── 入口（spawn-lane）贯通 + CLI 形状 ───────────────────────────────────────

test('ENTRY. spawn-lane 起 seg3 ⇒ 计划的隔离树定基在 seg2 的 lane tip（①c-b 贯通到输出 JSON）', { skip: SKIP }, () => {
  concurrentBoard(MULTI, ['seg1', 'seg2']);
  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: MULTI, owner: 'linus', seg: 'seg3', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isolation.mode, 'worktree', JSON.stringify(r.isolation));
  assert.equal(r.isolation.base.source, 'prev_seg');
  assert.equal(r.isolation.base.prev_seg, 'seg2');
  assert.equal(r.isolation.head, FIX.m2Tip);
  assert.equal(r.cwd, r.isolation.path);
  assert.equal(fs.existsSync(r.cwd), false, 'dry-run 不得建树');
});

test('ENTRY. spawn-lane 起 seg2 + --base 不可解析 ⇒ 拒绝起会话，零副作用（负向）', { skip: SKIP }, () => {
  concurrentBoard(SELF, ['seg1']);
  fs.rmSync(path.join(LAYOUT, 'claude-sessions.json'), { force: true });
  const r = spawnLane({ card: SELF, owner: 'linus', seg: 'seg2', backend: 'claude', dryRun: false, base: 'no-such-ref-xyz' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^lane_isolation_failed\(base_unresolved:no-such-ref-xyz\):serialize_or_fix$/, r.reason);
  assert.equal(fs.existsSync(`${LAYOUT}-wt-${SELF}-seg2`), false, '拒绝时不得建树');
  assert.equal(fs.existsSync(path.join(LAYOUT, 'claude-sessions.json')), false, '拒绝时不得写 registry');
  assert.equal(porcelain(LAYOUT), '');
});

// ── ③ 落实层：真建树也必须建在对的基上（预演算得准 ≠ 建得对） ────────────────
// 放在最后：本用例会**真的建出** `lane/<SELF>-seg2`（`--remove` 保留分支，SOP §7），
// 而 `lane-worktree` 的幂等复用分支排在定基之前 ⇒ 若先跑，后续任何 plan(SELF, 'seg2') 的用例
// 都会悄悄退化成「复用」而非「定基」。测试顺序即依赖，故显式排在所有 SELF/seg2 用例之后。

test('APPLY. 续接定基**真的**落到树上：新树含 seg1 的产物文件与提交', { skip: SKIP }, () => {
  concurrentBoard(SELF);
  const p = planFor(SELF, 'seg2');
  SIBLINGS.push(p.path);
  const a = applyLaneIsolation(p, { dryRun: false });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.isolation.action, 'created');
  assert.equal(a.isolation.base.ref, FIX.seg1Branch, '定基证据随建树一路带上（isolation.base）');

  // 硬证据①：跨进程、对**真实工作树**取证的祖先关系
  assert.equal(
    isAncestor(a.isolation.path, FIX.seg1Tip, 'HEAD'), true,
    '§② 的终极判据（落实层）：新树 HEAD 以 seg1 tip 为祖先——「算出来但没传下去」的 bug 只能在这里被抓住'
  );
  assert.equal(gOut(a.isolation.path, 'rev-parse', 'HEAD'), FIX.seg1Tip, '新分支恰在 seg1 tip 上起');
  // 硬证据②：前一段的产物**真在树里**（不只看 sha —— 文件才是产物）
  assert.equal(
    fs.readFileSync(path.join(a.isolation.path, 'seg1-product.txt'), 'utf8'), 'seg1 work\n',
    'seg1 的产物文件必须在续接树里（这正是错基会丢掉的东西）'
  );
  // 非破坏性：主 checkout 干净、分支未切、HEAD 未动
  assert.equal(porcelain(LAYOUT), '', '建树不得污染共享 checkout');
  assert.equal(gOut(LAYOUT, 'symbolic-ref', '--quiet', 'HEAD'), 'refs/heads/main', '主 checkout 分支未被切换');
  assert.equal(gOut(LAYOUT, 'rev-parse', 'HEAD'), FIX.mainTip, '主 checkout HEAD 未动');

  // 幂等：同参重跑复用而非重建，且**不改变**已定基的树
  const again = applyLaneIsolation(planFor(SELF, 'seg2'), { dryRun: false });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.isolation.action, 'reused');
  assert.equal(gOut(a.isolation.path, 'rev-parse', 'HEAD'), FIX.seg1Tip, '复用路径不得重定基');

  assert.equal(laneWorktree({ repo: LAYOUT, lane: p.lane, remove: true }).action, 'removed');
  assert.equal(R(LAYOUT, `refs/heads/${FIX.seg1Branch}`).status, 0, '清理保留前驱分支（它是定基的活证据，SOP §7）');
});

test('CLI. parseArgs：--base <ref> 带值；base=<ref> 等价；缺值/下一个是旗标 ⇒ 用法错误（绝不吞旗标当值）', { skip: SKIP }, () => {
  assert.equal(parseArgs(['C', 'linus', '--base', '43bdf5f']).base, '43bdf5f');
  assert.equal(parseArgs(['C', 'linus', 'base=43bdf5f']).base, '43bdf5f', 'k=v 形状与带值旗标等价');
  assert.equal(parseArgs(['C', 'linus']).base, '', '未给 ⇒ 空（由上一 seg 推导）');
  assert.equal(parseArgs(['C', 'linus', '--base']).ok, false, '缺值 ⇒ 用法错误');
  assert.equal(parseArgs(['C', 'linus', '--base']).reason, 'missing_value:--base');
  assert.equal(parseArgs(['C', 'linus', '--base', '--dry-run']).ok, false, '值形如旗标 ⇒ 用法错误，绝不静默吞掉 --dry-run');
  assert.equal(parseArgs(['C', 'linus', '--base', '--dry-run']).reason, 'missing_value:--base');
  // 回归：既有旗标语义不变
  assert.equal(parseArgs(['C', 'linus', '--dry-run']).dryRun, true);
  assert.deepEqual(parseArgs(['C', 'linus', 'semver']).ok, false, '多余裸位置参数仍为用法错误');
});

test('CLI. resolveCwd 口径不受 --base 影响（定基只动建树基准，不动 lane 的 cwd 归一）', { skip: SKIP }, () => {
  assert.equal(resolveCwd({ project: '__team__', target: '' }), path.resolve(LAYOUT));
});
