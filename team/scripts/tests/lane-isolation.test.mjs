#!/usr/bin/env node
/**
 * lane-isolation.test.mjs — 同仓并发 lane 的**自动隔离判定**（T-20261012-022948-2）
 *
 * 红（反证）：`scripts/lane-isolation.mjs` 不存在 / 判定不生效 ⇒ import 失败或判定退化为 no-op
 *   （并发场景仍返回 `none` ⇒ spawn-lane 仍在共享 checkout 里起 lane）。
 * 绿：四项判定全部可证 ——
 *   ① 同**文件** ⇒ `serialize`（拒绝并行写同一文件，`PROTOCOL §⑥.3` case ②）；
 *   ② 同**仓**不同文件 ⇒ `worktree`（`path`/`branch` 来自 `lane-worktree --dry-run`，幂等命名）；
 *   ③ 非触发条件 ⇒ `none`（单 lane / 他卡终态 / 他卡在**别的仓** / 只读角色 / 非 git 仓）；
 *   ④ 已在 linked worktree / 回退开关 ⇒ `disabled` / `already_isolated`（不叠床架屋）；
 *   ＋ 预演可拒（`blocked`）、`apply` 零副作用与真实创建、cwd 口径与 `spawn-lane.resolveCwd` 同源。
 *
 * 隔离：全部跑在 `os.tmpdir()` 下的临时 git 仓；不起子会话/不触网/不碰真实仓与真实看板。
 * 运行：node --test team/scripts/tests/lane-isolation.test.mjs
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
    // 部署布局相对候选：<team>/skills/task-ops（自 tests/ 上溯两级）—— 不读宿主 ~/.openclaw
    path.resolve(import.meta.dirname, '..', '..', 'skills', 'task-ops'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, 'lib', 'team-paths.mjs'))) return c;
  return null;
}
const PROVIDER = resolveProviderRoot();
const SKIP = PROVIDER ? false : 'provider ACL library not installed (task-ops is intentionally not vendored)';

/** 物化一个「已部署布局」：vendored scripts/ + skills/task-ops 软链（lib.mjs 的查找口径） */
const LAYOUT = PROVIDER ? (() => {
  // **realpath 归一**（与 lane-worktree / spawn-lane-isolation 两套件同因）：`os.tmpdir()` 在 macOS 上
  // 是符号链接路径（`/var/folders/…`），而 git 与 `lane-isolation` 返回的是真实路径（`/private/var/…`）。
  // 不归一不只是断言不等 —— 这里会**真的改变判定**：`main_repo`（真实）与卡 `target`（未归一）比不中
  // ⇒ 误报 `same_file_conflict` ⇒ 该隔离的退了串行。Linux 上 `/var` 不是链接，故 CI 绿、宿主红。
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-laneiso-')));
  for (const d of ['scripts', 'tasks', 'tasks/.locks', 'workspace', 'skills', 'bin']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
  }
  fs.symlinkSync(PROVIDER, path.join(root, 'skills', 'task-ops'), 'dir');
  return root;
})() : null;

const SIBLINGS = []; // 本测试在 LAYOUT 旁建的 worktree 兄弟目录（收尾清理）
after(() => {
  for (const s of SIBLINGS) { try { fs.rmSync(s, { recursive: true, force: true }); } catch { /* best effort */ } }
  if (LAYOUT) fs.rmSync(LAYOUT, { recursive: true, force: true });
});

let TASKS, laneIsolationPlan, applyLaneIsolation, isolationEnabled, laneNameFor, gitInfo, cardCwd, scanNonTerminal, samefileOverlaps, resolveCwd, laneWorktree;
if (LAYOUT) {
  TASKS = path.join(LAYOUT, 'tasks');
  process.env.OPENCLAW_TEAM_ROOT = LAYOUT; // 必须在 import lib.mjs 之前（TASKS_DIR 在 import 期固化）
  const staged = (rel) => import(pathToFileURL(path.join(LAYOUT, rel)).href);
  ({ laneIsolationPlan, applyLaneIsolation, isolationEnabled, laneNameFor, gitInfo, cardCwd, scanNonTerminal, samefileOverlaps } =
    await staged('scripts/lane-isolation.mjs'));
  ({ laneWorktree } = await staged('scripts/lane-worktree.mjs'));
  ({ resolveCwd } = await staged('scripts/spawn-lane.mjs'));
}

// ── git 夹具 ────────────────────────────────────────────────────────────────
function makeRepo(name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)));   // realpath 归一，见上
  const g = (...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')} 失败: ${r.stderr}`);
    return r.stdout;
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  g('add', '--', 'README.md');
  g('commit', '-q', '-m', 'init');
  g('branch', 'dev'); // 缺省 base = dev（开发集成分支，PROTOCOL §⑥.4）
  return { dir, g };
}

/** 看板夹具：每例前清空（判定只看 TASKS_DIR 的非终态卡） */
function writeCard(id, { status = 'in_progress', project = '__team__', target = '', writes = '' } = {}) {
  fs.writeFileSync(
    path.join(TASKS, `${id}.md`),
    `---\nid: ${id}\ntitle: t\nassignee: linus\nstatus: ${status}\ngoal: g\n` +
    `project: ${project}\ntarget: ${target}\n${writes ? `writes: ${writes}\n` : ''}---\n## Acceptance\n- [ ] a\n`
  );
}
const clearBoard = () => { for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f)); };

/** 主仓（LAYOUT 本身就是测试的看板根，也是被并发写的「同仓」） */
const MAIN = LAYOUT ? (() => {
  const r = spawnSync('git', ['-C', LAYOUT, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git init LAYOUT 失败: ${r.stderr}`);
  for (const a of [['config', 'user.email', 't@example.invalid'], ['config', 'user.name', 'test']]) {
    spawnSync('git', ['-C', LAYOUT, ...a], { encoding: 'utf8' });
  }
  // 看板/运行期产物不入版本控制 ⇒ `git status --porcelain` 只反映「代码写污染」
  fs.writeFileSync(path.join(LAYOUT, '.gitignore'), 'tasks/\nworkspace/\nbin/\nskills/\nscripts/\nclaude-sessions.json\n');
  fs.writeFileSync(path.join(LAYOUT, 'tracked.txt'), 'base\n');
  spawnSync('git', ['-C', LAYOUT, 'add', '--', '.gitignore', 'tracked.txt'], { encoding: 'utf8' });
  spawnSync('git', ['-C', LAYOUT, 'commit', '-q', '-m', 'init'], { encoding: 'utf8' });
  spawnSync('git', ['-C', LAYOUT, 'branch', 'dev'], { encoding: 'utf8' }); // 缺省 base = dev（PROTOCOL §⑥.4）
  return LAYOUT;
})() : null;
const porcelain = (dir) => spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();

const SELF = 'T-20260102-300000-self';

/**
 * 本卡 fm **从看板真实读回**（判定读的是卡，不是合成对象）——否则 `writes` 退化口径根本没被走到。
 * `scanNonTerminal()` 不带 exclude ⇒ 含本卡自身。
 */
const selfFm = () => {
  const me = scanNonTerminal().find((c) => c.id === SELF);
  return me ? me.fm : { project: '__team__', target: '' };
};
const plan = (opts = {}) => laneIsolationPlan({
  taskId: SELF, seg: 'seg1', role: 'exec', cwd: MAIN, fm: selfFm(), ...opts,
});

// ── 开关 / 命名 / 纯函数 ────────────────────────────────────────────────────

test('契约. isolationEnabled：缺省/空 ⇒ 开；0/off/false/no/disabled ⇒ 关（回退开关真值表）', { skip: SKIP }, () => {
  for (const v of [undefined, null, '', '1', 'on', 'true', 'yes']) {
    assert.equal(isolationEnabled(v), true, `${JSON.stringify(v)} 应为开`);
  }
  for (const v of ['0', 'off', 'false', 'no', 'disable', 'disabled', ' OFF ']) {
    assert.equal(isolationEnabled(v), false, `${JSON.stringify(v)} 应为关`);
  }
});

test('契约. laneNameFor：<card>-<seg> 确定性命名（幂等复用/人工清理的依据），非法字符净化', { skip: SKIP }, () => {
  assert.equal(laneNameFor('T-20261012-022948-2', 'seg1'), 'T-20261012-022948-2-seg1');
  assert.equal(laneNameFor('T-20261012-022948-2', 'segR1-replay'), 'T-20261012-022948-2-segR1-replay');
  assert.equal(laneNameFor('T-20261012-022948-2', 'a/b'), 'T-20261012-022948-2-a-b', '路径穿越字符被净化（lane 名恒单段）');
  assert.equal(laneNameFor('T-20261012-022948-2', ''), 'T-20261012-022948-2');
});

test('契约. gitInfo：git 仓 ⇒ 主仓根 + linkedWorktree=false；非 git 目录 ⇒ null；linked worktree ⇒ 解析回主仓', { skip: SKIP }, () => {
  const a = makeRepo('oc-laneiso-repo');
  try {
    const i = gitInfo(a.dir);
    assert.equal(i.root, fs.realpathSync(a.dir), '应给出主仓根');
    assert.equal(i.linkedWorktree, false, '主 checkout 不是 linked worktree');

    const wt = `${a.dir}-wt-x`;
    SIBLINGS.push(wt);
    a.g('worktree', 'add', '-b', 'lane/x', wt);
    const wi = gitInfo(wt);
    assert.equal(wi.root, fs.realpathSync(a.dir), 'linked worktree 应解析回**主**仓（同仓判定的口径）');
    assert.equal(wi.linkedWorktree, true, 'linked worktree 应被识别 ⇒ already_isolated');
  } finally {
    fs.rmSync(a.dir, { recursive: true, force: true });
  }
  assert.equal(gitInfo(LAYOUT + '-definitely-not-a-git-dir'), null, '不存在的路径 ⇒ null（不抛）');
  assert.equal(gitInfo(os.tmpdir()), null, '非 git 目录 ⇒ null（例如 ~/.openclaw/team ⇒ not_a_git_repo 兼容路径）');
});

test('契约. cwd 口径同源：cardCwd ≡ spawn-lane.resolveCwd（一处政策两处实现 ⇒ 由本测试锁定不漂移）', { skip: SKIP }, () => {
  const cases = [
    { project: '__team__', target: '' },
    { project: '__team__', target: 'sub/dir' },
    { project: '__team__', target: '/tmp/absolute-place' },
    { project: 'no-such-project-registered-x', target: '' },
  ];
  for (const fm of cases) {
    let viaResolve = null;
    try { viaResolve = resolveCwd(fm); } catch { viaResolve = null; }
    assert.equal(cardCwd(fm), viaResolve, `cwd 口径应一致: ${JSON.stringify(fm)}`);
  }
});

// ── 判定矩阵 ────────────────────────────────────────────────────────────────

test('NONE-1. 单 lane（看板无他并发非终态卡）⇒ none/no_concurrent_lane（不影响单 lane 路径）', { skip: SKIP }, () => {
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress' });
  const p = plan();
  assert.equal(p.mode, 'none', JSON.stringify(p));
  assert.equal(p.reason, 'no_concurrent_lane');
  assert.equal(p.main_repo, fs.realpathSync(MAIN));
});

test('NONE-2. 他卡**终态**（done/canceled）⇒ 不算并发非终态 lane；scanNonTerminal 只回非终态且排除 self', { skip: SKIP }, () => {
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress' });
  writeCard('T-20260102-300001-done', { status: 'done' });
  writeCard('T-20260102-300002-canceled', { status: 'canceled' });
  assert.equal(plan().mode, 'none');

  const scanned = scanNonTerminal(SELF).map((c) => c.id);
  assert.deepEqual(scanned, [], `仅非终态且非 self，实际 ${scanned.join(',')}`);
  clearBoard();
  writeCard(SELF, { status: 'in_progress' });
  writeCard('T-20260102-300003-ready', { status: 'ready' });
  writeCard('T-20260102-300004-blocked', { status: 'blocked' });
  writeCard('T-20260102-300005-review', { status: 'in_review' });
  assert.deepEqual(
    scanNonTerminal(SELF).map((c) => c.id).sort(),
    ['T-20260102-300003-ready', 'T-20260102-300004-blocked', 'T-20260102-300005-review'],
    '非终态四态（ready/in_progress/blocked/in_review）皆计入（口径同 check-card 状态机 + samefile-guard）'
  );
});

test('NONE-3. 他卡在同仓但是**只读角色**（role=review）⇒ 不隔离（SOP §3：隔离写者，不隔离读者）', { skip: SKIP }, () => {
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress' });
  writeCard('T-20260102-300001-other', { status: 'in_progress' });
  const p = plan({ role: 'review' });
  assert.equal(p.mode, 'none', JSON.stringify(p));
  assert.equal(p.reason, 'read_only_role');
});

test('NONE-4. 非 git 仓（project=__team__ ⇒ team 根，如本机 ~/.openclaw/team）⇒ none/not_a_git_repo', { skip: SKIP }, () => {
  clearBoard();
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-laneiso-plain-')));   // realpath 归一，见上
  try {
    writeCard('T-20260102-300000-self', { status: 'in_progress' });
    writeCard('T-20260102-300001-other', { status: 'in_progress' });
    const p = plan({ cwd: plain });
    assert.equal(p.mode, 'none', JSON.stringify(p));
    assert.equal(p.reason, 'not_a_git_repo');
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('NONE-5. 他卡在**别的仓**（project 根不同）⇒ 与本 lane 的污染无关，不隔离', { skip: SKIP }, () => {
  clearBoard();
  const otherRepo = makeRepo('oc-laneiso-other');
  try {
    writeCard('T-20260102-300000-self', { status: 'in_progress' });
    writeCard('T-20260102-300001-other', { status: 'in_progress', target: otherRepo.dir });
    const p = plan();
    assert.equal(p.mode, 'none', JSON.stringify(p));
    assert.equal(p.reason, 'no_concurrent_lane');
  } finally {
    fs.rmSync(otherRepo.dir, { recursive: true, force: true });
  }
});

test('DISABLED. 回退开关（enabled=false / --no-isolate / env 关）⇒ disabled（回到显式纪律路径）', { skip: SKIP }, () => {
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress' });
  writeCard('T-20260102-300001-other', { status: 'in_progress' });
  const p = plan({ enabled: false });
  assert.equal(p.mode, 'disabled', JSON.stringify(p));
  assert.equal(p.reason, 'switch_off');
});

test('WORKTREE. 同仓不同文件 ⇒ worktree：确定性 path=<主仓>-wt-<card>-<seg> + branch=lane/<lane>，且预演零副作用', { skip: SKIP }, () => {
  clearBoard();
  const before = porcelain(MAIN);
  writeCard('T-20260102-300000-self', { status: 'in_progress', writes: 'team/a.mjs' });
  writeCard('T-20260102-300001-other', { status: 'in_progress', writes: 'team/b.mjs' });

  const p = plan();
  assert.equal(p.mode, 'worktree', JSON.stringify(p));
  assert.equal(p.lane, 'T-20260102-300000-self-seg1');
  assert.equal(p.path, `${MAIN}-wt-T-20260102-300000-self-seg1`, '默认 path 形状与 lane-worktree 一致（<主仓目录>-wt-<lane>）');
  assert.equal(p.branch, 'lane/T-20260102-300000-self-seg1', '默认分支 namespaced（lane/<lane>）');
  assert.equal(p.action, 'would_create', '判定阶段恒为预演视图');
  assert.deepEqual(p.lanes, ['T-20260102-300001-other'], '同仓并发 lane 名单（可审计）');
  assert.equal(fs.existsSync(p.path), false, '判定不得落盘');
  assert.equal(porcelain(MAIN), before, '判定不得改仓');
});

test('SERIALIZE. 同**文件**（写集重叠）⇒ serialize：不隔离、不并行，交由调用方拒绝（显式串行）', { skip: SKIP }, () => {
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress', writes: 'team/same.mjs' });
  writeCard('T-20260102-300001-other', { status: 'in_progress', writes: 'team/same.mjs' });

  const p = plan();
  assert.equal(p.mode, 'serialize', JSON.stringify(p));
  assert.equal(p.reason, 'same_file_conflict');
  assert.deepEqual(p.conflicts, [{ card: 'T-20260102-300001-other', overlap: ['team/same.mjs'] }], '冲突点必须可点名（可审计）');
  assert.equal(fs.existsSync(`${MAIN}-wt-T-20260102-300000-self-seg1`), false, '串行判定不得建树');
});

test('SERIALIZE. 写集缺省退化 target（同 target ⇒ 同资源），与 samefile-guard 同口径', { skip: SKIP }, () => {
  clearBoard();
  const shared = path.join(MAIN, 'shared-resource'); // 同仓内的同一资源（target 退化口径）
  writeCard(SELF, { status: 'in_progress', target: shared });
  writeCard('T-20260102-300001-other', { status: 'in_progress', target: shared });
  const p = plan();
  assert.equal(p.mode, 'serialize', JSON.stringify(p));
  assert.deepEqual(p.conflicts[0].overlap, [shared]);
});

test('REGRESSION. 实盘形状：卡只有 `target: <repo根>`（零 writes）⇒ **隔离**而非串行（否则整仓被串行化）', { skip: SKIP }, () => {
  // 2026-10-12 实盘：本仓**全部** 22 张非终态卡都只声明 `target: <repo 根>`、writes 全缺。
  // 若把该退化写集当「同文件」硬拒绝，就会拦下**每一张**卡的起会话（含本卡自身）——实测于 shadow dry-run。
  clearBoard();
  writeCard(SELF, { status: 'in_progress', target: MAIN });
  writeCard('T-20260102-300001-other', { status: 'in_progress', target: MAIN });
  const p = plan();
  assert.notEqual(p.mode, 'serialize', `仓根退化 target 不得触发串行，实际 ${JSON.stringify(p)}`);
  assert.equal(p.mode, 'worktree', JSON.stringify(p));
  assert.deepEqual(p.lanes, ['T-20260102-300001-other'], '仍须贡献「同仓」信号 ⇒ 走隔离');

  // 对照（直接打判据）：仓根**祖先**同样只是仓指定，不得算冲突；仓内具体路径才算
  const anc = path.dirname(MAIN);
  assert.deepEqual(samefileOverlaps([anc], [{ id: 'x', writes: [anc] }], MAIN), [], '仓根祖先 ⇒ 非文件级');
  assert.deepEqual(samefileOverlaps([MAIN], [{ id: 'x', writes: [MAIN] }], MAIN), [], '仓根本身 ⇒ 非文件级');
  assert.deepEqual(
    samefileOverlaps([path.join(MAIN, 'docs/PLAN.md')], [{ id: 'x', writes: [path.join(MAIN, 'docs/PLAN.md')] }], MAIN),
    [{ card: 'x', overlap: [path.join(MAIN, 'docs/PLAN.md')] }],
    '仓内**具体文件** ⇒ 文件级（照常串行）'
  );
});

test('ALREADY. cwd 已在 linked worktree（显式纪律/上次隔离留下）⇒ already_isolated，不叠床架屋', { skip: SKIP }, () => {
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress' });
  writeCard('T-20260102-300001-other', { status: 'in_progress' });
  const wt = `${MAIN}-wt-manual`;
  SIBLINGS.push(wt);
  const r = spawnSync('git', ['-C', MAIN, 'worktree', 'add', '-b', 'lane/manual', wt], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const p = plan({ cwd: wt });
  assert.equal(p.mode, 'already_isolated', JSON.stringify(p));
  assert.equal(p.path, fs.realpathSync(wt));
});

test('BLOCKED. 预定路径被非 worktree 目录占用 ⇒ blocked（fail-closed 供调用方拒绝，绝不静默降级回共享树）', { skip: SKIP }, () => {
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress', writes: 'team/a.mjs' });
  writeCard('T-20260102-300001-other', { status: 'in_progress', writes: 'team/b.mjs' });
  const clash = `${MAIN}-wt-T-20260102-300000-self-seg1`;
  SIBLINGS.push(clash);
  fs.mkdirSync(clash, { recursive: true });
  fs.writeFileSync(path.join(clash, 'keep.txt'), 'x');

  const p = plan();
  assert.equal(p.mode, 'blocked', JSON.stringify(p));
  assert.match(p.reason, /^path_exists_not_worktree/);
  assert.equal(fs.readFileSync(path.join(clash, 'keep.txt'), 'utf8'), 'x', '占用目录绝不得被动');
  assert.equal(porcelain(MAIN), '', '拒绝路径零副作用');
  fs.rmSync(clash, { recursive: true, force: true }); // 该占用是**本测试**的夹具，立即撤除（勿污染后续用例）
});

// ── 落实（apply） ───────────────────────────────────────────────────────────

test('APPLY-1. dryRun ⇒ 零副作用（不建树、不登记、不改仓），action 为预演视图', { skip: SKIP }, () => {
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress', writes: 'team/a.mjs' });
  writeCard('T-20260102-300001-other', { status: 'in_progress', writes: 'team/b.mjs' });
  const p = plan({ dryRun: true });

  const a = applyLaneIsolation(p, { dryRun: true });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.isolation.mode, 'worktree');
  assert.equal(a.isolation.action, 'would_create');
  assert.equal(a.isolation.applied, false);
  assert.equal(fs.existsSync(a.isolation.path), false, 'dry-run 不得落盘');
  assert.equal(porcelain(MAIN), '', 'dry-run 不得改仓');
});

test('APPLY-2. 真实创建 ⇒ 主 checkout 干净、lane 分支独立、可幂等复用、绝不 --force', { skip: SKIP }, () => {
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress', writes: 'team/a.mjs' });
  writeCard('T-20260102-300001-other', { status: 'in_progress', writes: 'team/b.mjs' });
  const p = plan();
  SIBLINGS.push(p.path);

  const a = applyLaneIsolation(p, { dryRun: false });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.isolation.action, 'created');
  assert.equal(a.isolation.applied, true);
  assert.equal(fs.existsSync(a.isolation.path), true);
  assert.equal(porcelain(MAIN), '', '建树不得污染共享 checkout');
  assert.equal(porcelain(a.isolation.path), '', '新树应为 clean');

  const br = spawnSync('git', ['-C', MAIN, 'rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}`], { encoding: 'utf8' });
  assert.equal(br.status, 0, 'lane 分支应存在');
  assert.equal(
    spawnSync('git', ['-C', MAIN, 'symbolic-ref', '--quiet', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    'refs/heads/main', '主 checkout 分支不得被切换（非破坏性）'
  );

  // 幂等：同参重跑复用而非重建
  const again = applyLaneIsolation(plan(), { dryRun: false });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.isolation.action, 'reused');
  assert.equal(again.isolation.applied, false);

  // 撤除夹具（clean ⇒ 允许；分支保留）——不留残留以免影响后续用例
  assert.equal(laneWorktree({ repo: MAIN, lane: p.lane, remove: true }).action, 'removed');
});

test('APPLY-3. apply 失败（worktree 真被占）⇒ ok:false + 稳定 reason（调用方据此 fail-closed）', { skip: SKIP }, () => {
  clearBoard();
  writeCard(SELF, { status: 'in_progress', writes: 'team/a.mjs' });
  writeCard('T-20260102-300001-other', { status: 'in_progress', writes: 'team/b.mjs' });
  const p = plan();
  fs.mkdirSync(p.path, { recursive: true }); // 预演与落实之间被占（竞态窗口的再现）
  const a = applyLaneIsolation(p, { dryRun: false });
  assert.equal(a.ok, false, JSON.stringify(a));
  assert.match(a.reason, /^path_exists_not_worktree/);
  assert.equal(fs.existsSync(path.join(p.path, 'README.md')), false, '被占路径不得被 worktree 覆盖');
  fs.rmSync(p.path, { recursive: true, force: true });
});

test('APPLY-4. 清理纪律（A4）：--remove 仅 clean 时可清理；清理后**保留分支**（可重入）', { skip: SKIP }, () => {
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress', writes: 'team/a.mjs' });
  writeCard('T-20260102-300001-other', { status: 'in_progress', writes: 'team/b.mjs' });
  const p = plan();
  SIBLINGS.push(p.path);
  assert.equal(applyLaneIsolation(p, { dryRun: false }).ok, true);

  // 脏树（lane 的未提交工作）⇒ 拒绝清理，绝不 --force 丢弃产物
  fs.writeFileSync(path.join(p.path, 'wip.txt'), 'work in progress\n');
  const dirty = laneWorktree({ repo: MAIN, lane: p.lane, remove: true });
  assert.equal(dirty.ok, false, JSON.stringify(dirty));
  assert.match(dirty.reason, /^worktree_dirty/);
  assert.equal(fs.existsSync(p.path), true, '拒绝时不得删除 worktree');

  // 前向编辑（非破坏性 git）清掉该文件 ⇒ 可清理；分支保留 ⇒ 幂等可重入
  fs.rmSync(path.join(p.path, 'wip.txt'));
  const gone = laneWorktree({ repo: MAIN, lane: p.lane, remove: true });
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.equal(gone.action, 'removed');
  assert.equal(fs.existsSync(p.path), false);
  assert.equal(gone.cmd.includes('--force'), false, '绝不使用 --force');
  assert.equal(
    spawnSync('git', ['-C', MAIN, 'rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}`], { encoding: 'utf8' }).status,
    0, '清理 worktree 不得删除分支'
  );
  assert.equal(porcelain(MAIN), '', '清理全程不得污染共享 checkout');
});

// ── T-20261014-214625-2：`todo`（canonical 新卡词）必须参与同仓/同文件判定 ─────────
// 红（修前实测）：`NON_TERMINAL` 用 legacy 词 `ready` 顶替 canonical `todo` ⇒ `status: todo`
// 的他卡在 `scanNonTerminal` 里隐形 ⇒ 同文件冲突漏判（退化成并行写同一文件）、同仓并发漏判
// （退化成 none，lane 落进共享 checkout —— 正是 SOP §1 要防的事故）。
test('TODO-1. `status: todo` 他卡 ⇒ 同文件串行（serialize）与同仓隔离（worktree）都生效', { skip: SKIP }, () => {
  // ① 同文件：写集与一张 `todo` 卡重叠 ⇒ 必须串行（修前退化为 none/no_concurrent_lane）
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress', target: MAIN, writes: 'team/scripts/lib.mjs' });
  writeCard('T-20260102-300101-todo', { status: 'todo', target: MAIN, writes: 'team/scripts/lib.mjs' });
  const p1 = plan();
  assert.equal(p1.mode, 'serialize', `todo 卡的同文件冲突必须被看见：${JSON.stringify(p1)}`);
  assert.equal(p1.reason, 'same_file_conflict');
  assert.deepEqual(p1.conflicts, [{ card: 'T-20260102-300101-todo', overlap: ['team/scripts/lib.mjs'] }]);

  // ② 同仓不同文件：看板上唯一他卡是 `todo` ⇒ 必须隔离（修前 none/no_concurrent_lane）
  clearBoard();
  writeCard('T-20260102-300000-self', { status: 'in_progress', target: MAIN, writes: 'team/a.mjs' });
  writeCard('T-20260102-300102-todo', { status: 'todo', target: MAIN });
  const p2 = plan();
  assert.equal(p2.mode, 'worktree', `todo 卡的同仓并发必须被看见：${JSON.stringify(p2)}`);
  assert.deepEqual(p2.lanes, ['T-20260102-300102-todo']);
});

test('TODO-2. 负向不回退：`backlog`/`done` 他卡仍不触发（守卫未被放宽）', { skip: SKIP }, () => {
  for (const st of ['backlog', 'done', 'failed', 'canceled']) {
    clearBoard();
    writeCard('T-20260102-300000-self', { status: 'in_progress', target: MAIN, writes: 'team/scripts/lib.mjs' });
    writeCard('T-20260102-300103-notlive', { status: st, target: MAIN, writes: 'team/scripts/lib.mjs' });
    const p = plan();
    assert.equal(p.mode, 'none', `${st} 卡不得触发并发判定，实际 ${JSON.stringify(p)}`);
  }
});
