#!/usr/bin/env node
/**
 * spawn-lane-isolation.test.mjs — 同仓并发 lane 的**自动隔离**（红→绿）（T-20261012-022948-2）
 *
 * 本文件是 A3「红→绿可证」的取证：构造**同仓并发写**场景 ⇒
 *   **红**：隔离关闭（`isolate:false` / `OPENCLAW_LANE_ISOLATION=0`）⇒ lane 落在**共享 checkout**，
 *        其未提交写立刻对同仓另一 lane 可见（`git status --porcelain` 非空）——这正是
 *        `T-20261012-015340 §6.3`「验证期间工作树带他 lane 未提交改动」的成因；
 *   **绿**：隔离开启（默认）⇒ lane 的 cwd 是该 lane **自己的 worktree**，同样的写**不进入**共享
 *        checkout（porcelain 空、文件在主树不存在、只在 lane 树存在）；且证据取自**子进程真实 cwd**
 *       （假 claude stub 把 `pwd` 落盘 ⇒ 「起会话时真在那棵树里」而非仅计划字段）。
 * 兼容（A5）：单 lane（无并发）路径不变；`role=review` 不隔离；dry-run 零副作用。
 * 串行（A1 的另一半）：同**文件**冲突 ⇒ 拒绝起会话（显式串行），零副作用。
 * fail-closed：隔离被拒（路径被占）⇒ 拒绝起会话，绝不静默降级回共享 checkout。
 *
 * 夹具自持性（T-20261014-034118-2，既有 flaky 的根因修复）：
 *   本文件多个用例断言的都是**「某条 lane 的隔离路径未被占用」这一否定事实**（路径不存在 / 无 worktree
 *   注册）。该前提过去是**跨用例共享且隐式**的：`<LAYOUT>-wt-<card>-<seg>` 由 GREEN 建、也只由 GREEN 的
 *   收尾动作撤；`beforeEach` 只清看板/workspace/registry/stub-args，**不回收 worktree 路径**。于是任何
 *   半完成的建树/清理（高负载下 git 失败或被杀）都会让后续用例的前提静默失效，并且会**反转** fail-closed
 *   用例——`lane-worktree` 的「复用」分支排在「路径被占」守卫**之前**，残留注册让判定走 `reused`，
 *   `spawn-lane` 于是**真的起了会话**（`ok:true`）而不是拒绝。
 *   （行为面已于 `T-20261014-053826-2` 收紧：注册在、目录已删 ⇒ `worktree_stale_registration(<why>)` 点名
 *   拒绝、fail-closed；本文件的夹具自持纪律仍然保留——它挡的是**另一类**静默失效。）
 *   两条加固（均为**收紧**，不削弱任何拒止语义）：
 *     ① 每条 lane 自持：fail-closed 用例改用**专属卡**，其隔离路径与本文件其它用例零交集；
 *     ② 每个用例前**回收**这些 lane 路径（`beforeEach`），回收不掉即显式报红（绝不静默带病继续）。
 *
 * 全程**无破坏性 git**：只用 `git init/add/commit/worktree add|remove|list|prune/rev-parse/status`
 * （`prune` 仅遗忘「工作目录已消失」的注册，不触碰任何工作树）；断言主 checkout
 * 分支与 HEAD 不变、且未出现 `--force`。
 * 隔离：跑在 `os.tmpdir()` 下的临时 git 仓；不起真实模型/不触网/不碰真实仓与真实看板。
 * 运行：node --test team/scripts/tests/spawn-lane-isolation.test.mjs
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const SCRIPTS = path.join(HERE, '..');                     // <repo>/team/scripts

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

/** 「已部署布局」+ 一个**真 git 仓**（本测试的「同仓」）：scripts/ + skills 软链 + 看板目录 */
const LAYOUT = PROVIDER ? (() => {
  // **realpath 归一**（与 lane-worktree.test.mjs 同因）：`os.tmpdir()` 在 macOS 上是符号链接路径
  // （`/var/folders/…`），git 与 spawn-lane 返回的是真实路径（`/private/var/…`）；不归一 ⇒
  // 路径断言在本机恒不等（Linux 上 `/var` 不是链接，故 CI 绿、宿主红）。
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-spawniso-')));
  for (const d of ['scripts', 'tasks', 'tasks/.locks', 'workspace', 'skills', 'bin']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
  }
  fs.symlinkSync(PROVIDER, path.join(root, 'skills', 'task-ops'), 'dir');
  const g = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'test');
  // 看板/运行期产物不入版本控制 ⇒ `git status --porcelain` 只反映「**代码写**污染」
  fs.writeFileSync(path.join(root, '.gitignore'), 'tasks/\nworkspace/\nbin/\nskills/\nscripts/\nclaude-sessions.json\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  g('add', '--', '.gitignore', 'tracked.txt');
  g('commit', '-q', '-m', 'init');
  g('branch', 'dev'); // 缺省 base = dev（开发集成分支，PROTOCOL §⑥.4）
  return root;
})() : null;

let TASKS, WS, BIN, REG, STUB, STUB_ARGS;
let spawnLane, laneWorktree;

if (LAYOUT) {
  TASKS = path.join(LAYOUT, 'tasks');
  WS = path.join(LAYOUT, 'workspace');
  BIN = path.join(LAYOUT, 'bin');
  REG = path.join(LAYOUT, 'claude-sessions.json');
  process.env.OPENCLAW_TEAM_ROOT = LAYOUT; // 必须在 import lib.mjs 之前（TASKS_DIR 在 import 期固化）
  const staged = (rel) => import(pathToFileURL(path.join(LAYOUT, rel)).href);
  ({ spawnLane } = await staged('scripts/spawn-lane.mjs'));
  ({ laneWorktree } = await staged('scripts/lane-worktree.mjs'));

  // 假 claude：复刻 `--settings` 前置校验，并把**真实 cwd** 落到**本用例专属**取证文件首行。
  // 取证文件路径取 env `OC_STUB_ARGS`（由 beforeEach 每个用例换一个新路径）——**不是**固定的
  // `<stub>.args`：固定的单文件是跨用例共享资源，上一个用例的 stub 若在高负载下**迟到落盘**，
  // 其内容会被下一个用例读成自己的证据（T-20261014-034118-2 实证的 flaky 链首环）。
  STUB = path.join(BIN, 'claude-stub');
  fs.writeFileSync(STUB, [
    '#!/bin/sh',
    'settings=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "--settings" ]; then settings="$a"; fi',
    '  prev="$a"',
    'done',
    'if [ -n "$settings" ] && [ ! -f "$settings" ]; then',
    '  echo "Settings file not found: $settings" >&2',
    '  exit 1',
    'fi',
    'args="${OC_STUB_ARGS:-$0.args}"',
    'pwd > "$args"',
    'echo "$@" >> "$args"',
    'echo \'{"type":"system","subtype":"init"}\'',
    'exec sleep 60', // exec ⇒ SIGTERM 直达 sleep：不留下孤儿（收尾 kill 只杀 sh 时 sleep 会陪跑 60s）
    '',
  ].join('\n'));
  fs.chmodSync(STUB, 0o755);
  process.env.OPENCLAW_CLAUDE_BIN = STUB;
  // 本套件真起 lane（stub）：关掉会话终态看守（`lane-reaper`），否则每个 stub 一个看守进程会
  // 活到套件结束后才收口（本套件只测隔离判定，终态收口由 lane-reaper.test.mjs 覆盖）。
  process.env.OPENCLAW_TEAM_REAPER = '0';
}

const spawnPids = [];
const SIBLINGS = [];
after(() => {
  for (const p of spawnPids) { try { process.kill(p, 'SIGTERM'); } catch { /* 已退出 */ } }
  for (const s of SIBLINGS) { try { fs.rmSync(s, { recursive: true, force: true }); } catch { /* best effort */ } }
  if (LAYOUT) fs.rmSync(LAYOUT, { recursive: true, force: true });
});
let stubSeq = 0;
beforeEach(() => {
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.rmSync(REG, { force: true });
  // 本用例专属的 stub 取证文件：**换新路径**而非删旧文件 —— 旧用例的 stub 仍活着，
  // 它的迟到落盘写进旧路径，本用例读新路径 ⇒ 证据不可能串台（删旧文件挡不住迟到写入者）。
  STUB_ARGS = path.join(BIN, `claude-stub.${process.pid}.${(stubSeq += 1)}.args`);
  process.env.OC_STUB_ARGS = STUB_ARGS;
  // lane 隔离产物归零：断言「路径空闲」的用例**不得继承**上一用例的状态（见文件头「夹具自持性」）。
  for (const lane of [LANE, CLASH_LANE, STALE_LANE]) {
    const r = reclaimLane(lane);
    assert.equal(r.ok, true, `beforeEach 未能回收 lane 隔离产物（前置条件无法成立）：${JSON.stringify(r)}`);
  }
});

/** 某 lane 的隔离树路径（与 lane-worktree.mjs 默认命名同源：`<主仓目录>-wt-<lane>`） */
const laneWtPath = (lane) => `${LAYOUT}-wt-${lane}`;
/** 该路径是否**已注册为 worktree**（`git worktree list` 有该条目）——与「目录存在」是两件不同的事 */
const isRegisteredWt = (p) =>
  gitOut(LAYOUT, 'worktree', 'list', '--porcelain')
    .split('\n').some((l) => l.trim() === `worktree ${p}`);
/**
 * 回收某 lane 的隔离产物，恢复「路径空闲」这一**跨用例前提**（全程非破坏性 git：无 --force/reset/clean）。
 * ① 规范入口 `laneWorktree --remove`（仅 clean 时摘除，绝不 --force）；
 * ② 仍有残留 ⇒ 清掉沙箱内的工作目录后再 `git worktree prune`（prune 只遗忘「工作目录已消失」的注册，
 *    不触碰任何工作树；用于兜住高负载下**半完成**的建树/清理，或上一用例在收尾前就断言失败的情形）。
 * @returns {{ok:boolean, action:'clean'|'reclaimed', path:string}}
 */
function reclaimLane(lane) {
  const p = laneWtPath(lane);
  if (!isRegisteredWt(p) && !fs.existsSync(p)) return { ok: true, action: 'clean', path: p };
  laneWorktree({ repo: LAYOUT, lane, remove: true });
  if (isRegisteredWt(p) || fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true }); // 沙箱内的工作目录（非仓外数据）
    if (isRegisteredWt(p)) gitOut(LAYOUT, 'worktree', 'prune');
  }
  return { ok: !isRegisteredWt(p) && !fs.existsSync(p), action: 'reclaimed', path: p };
}

const SELF = 'T-20260103-400000-self';
const OTHER = 'T-20260103-400001-other';
const LANE = `${SELF}-seg1`;
/**
 * fail-closed 用例的**专属卡**：它的隔离路径（`<LAYOUT>-wt-T-20260103-400010-clash-seg1`）与本文件
 * 其余用例零交集 ⇒ 该用例的前置条件（路径空闲）**结构上**不依赖任何别的用例的收尾动作。
 */
const CLASH = 'T-20260103-400010-clash';
const CLASH_LANE = `${CLASH}-seg1`;
/**
 * 「登记在、目录已删」用例的**专属卡**（同 CLASH 的自持纪律：路径与本文件其余用例零交集）。
 * 该态是**真的会发生**的：半完成的建树被高负载杀掉、人工 `rm -rf` 掉工作目录、磁盘清理……
 * 而 `git worktree list` 对残留注册**照列不误** ⇒ 只看注册表就会把「目录已删」读成 `reused`。
 */
const STALE = 'T-20260103-400020-stale';
const STALE_LANE = `${STALE}-seg1`;

function writeCard(id, { status = 'in_progress', claimed = 'linus', project = '__team__', target = '', writes = '' } = {}) {
  const body = '## Background\nx\n## Acceptance\n- [ ] a\n## Progress\n## Comments\n## Sessions\n## Report\n';
  fs.writeFileSync(
    path.join(TASKS, `${id}.md`),
    `---\nid: ${id}\ntitle: isolation fixture\nassignee: ${claimed}\nstatus: ${status}\ngoal: g\n` +
    `project: ${project}\ntarget: ${target}\nclaimed_by: ${claimed}\nheartbeat_at: 2026-01-03T00:00:00.000Z\n` +
    `${writes ? `writes: ${writes}\n` : ''}---\n${body}`
  );
}
/** 同仓并发写场景：本卡 + 另一张**非终态**卡（同 project ⇒ 同仓，写**不同**文件） */
const concurrentBoard = (selfWrites = 'team-a.mjs', otherWrites = 'team-b.mjs') => {
  writeCard(SELF, { writes: selfWrites });
  writeCard(OTHER, { claimed: 'jobs', writes: otherWrites });
};
const porcelain = (dir) => spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
const gitOut = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).stdout.trim();
/** 子会话**真实** cwd（stub 落盘的首行）——隔离的硬证据。只读**本用例**的取证文件（见 STUB_ARGS）。 */
const spawnedCwd = () =>
  (fs.existsSync(STUB_ARGS) ? fs.readFileSync(STUB_ARGS, 'utf8').split('\n')[0].trim() : null);
/**
 * 轮询等待（子进程异步落盘 ⇒ 避免断言与子进程竞态）；超时返回 false。
 * 预算取 30s（可用 `OPENCLAW_TEST_WAIT_MS` 覆盖）：子进程**启动+落盘**耗时随机器负载浮动，
 * 10s 在 12 路并发下实测会被击穿（T-20261014-034118-2 复现数据）；放宽预算不放宽任何断言语义。
 */
const WAIT_MS = Number(process.env.OPENCLAW_TEST_WAIT_MS || 30000);
async function waitFor(fn, { timeout = WAIT_MS, step = 25 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}
const registryEntries = (id) => (fs.existsSync(REG) ? JSON.parse(fs.readFileSync(REG, 'utf8')).filter((e) => e.task_id === id) : []);

// ── A3 红→绿 ────────────────────────────────────────────────────────────────

test('RED. 隔离**关闭** ⇒ lane 落在共享 checkout，其未提交写对同仓另一 lane 立即可见（污染）', { skip: SKIP }, async () => {
  concurrentBoard();
  const head0 = gitOut(LAYOUT, 'rev-parse', 'HEAD');

  const r = spawnLane({ card: SELF, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false, isolate: false });
  if (r.pid) spawnPids.push(r.pid);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isolation.mode, 'disabled', JSON.stringify(r.isolation));
  assert.equal(r.cwd, LAYOUT, '关闭隔离 ⇒ cwd = 共享 checkout（旧行为，兼容路径）');
  assert.equal(await waitFor(() => spawnedCwd() !== null), true, 'stub 应起会话并落盘 cwd');
  assert.equal(path.resolve(spawnedCwd()), path.resolve(LAYOUT), '子进程真的起在共享 checkout 里');

  // 该 lane 的未提交写（模拟 lane 正在写自己的产物）
  fs.writeFileSync(path.join(r.cwd, 'team-a.mjs'), 'lane work\n');
  const dirty = porcelain(LAYOUT);
  assert.match(dirty, /team-a\.mjs/, `共享 checkout 应被他 lane 的未提交写污染，实际 "${dirty}"`);
  assert.equal(
    fs.existsSync(path.join(LAYOUT, 'team-a.mjs')), true,
    '污染即「另一 lane 在**同一棵树**里读到本 lane 的未提交改动」（T-20261012-015340 §6.3 的成因）'
  );
  assert.equal(gitOut(LAYOUT, 'rev-parse', 'HEAD'), head0, '全程无破坏性 git：HEAD 未动');
  fs.rmSync(path.join(LAYOUT, 'team-a.mjs')); // 前向编辑清场（非破坏性 git）
});

test('GREEN. 隔离**开启**（默认）⇒ lane 在自己的 worktree 里写，共享 checkout 干净（无污染）', { skip: SKIP }, async () => {
  concurrentBoard();
  const head0 = gitOut(LAYOUT, 'rev-parse', 'HEAD');

  const r = spawnLane({ card: SELF, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  if (r.pid) spawnPids.push(r.pid);
  assert.equal(r.ok, true, JSON.stringify(r));

  assert.equal(r.isolation.mode, 'worktree', JSON.stringify(r.isolation));
  assert.equal(r.isolation.lane, LANE, 'lane 名确定性 = <card>-<seg>（幂等复用/人工清理的依据）');
  assert.equal(r.isolation.branch, `lane/${LANE}`);
  assert.equal(r.isolation.path, `${LAYOUT}-wt-${LANE}`);
  assert.equal(r.isolation.applied, true, '真实起会话应真的建了树');
  assert.deepEqual(r.isolation.same_repo_lanes, [OTHER], '点名同仓并发 lane（可审计）');
  assert.equal(r.cwd, r.isolation.path, 'cwd 指向该 lane 的 worktree');

  // 硬证据①：子进程的**真实** cwd 就在隔离树里
  assert.equal(await waitFor(() => spawnedCwd() !== null), true, 'stub 应起会话并落盘 cwd');
  assert.equal(path.resolve(spawnedCwd()), path.resolve(r.isolation.path), `子进程 cwd 应为隔离树，实际 ${spawnedCwd()}`);
  // 硬证据②：提示词把工作树纪律交给 lane（否则隔离树的产物无人知道，见 SOP §7）
  assert.match(r.cmd.join(' '), /isolated in a lane worktree/, '子会话提示词应说明工作树与回报纪律');
  // 硬证据③：登记照常（卡 + registry 同写），隔离不改变登记链路
  assert.equal(registryEntries(SELF).length, 1, JSON.stringify(registryEntries(SELF)));
  assert.match(fs.readFileSync(path.join(TASKS, `${SELF}.md`), 'utf8'), /- seg:seg1 /);

  // 绿：同样的写**不进入**共享 checkout
  fs.writeFileSync(path.join(r.cwd, 'team-a.mjs'), 'lane work\n');
  assert.equal(porcelain(LAYOUT), '', '隔离后共享 checkout 必须干净（另一 lane/复核读到的树未被污染）');
  assert.equal(fs.existsSync(path.join(LAYOUT, 'team-a.mjs')), false, 'lane 的未提交写不得出现在共享 checkout');
  assert.equal(fs.readFileSync(path.join(r.cwd, 'team-a.mjs'), 'utf8'), 'lane work\n', '写落在 lane 自己的树里');
  assert.equal(gitOut(LAYOUT, 'rev-parse', 'HEAD'), head0, '全程无破坏性 git：HEAD 未动');
  assert.equal(gitOut(LAYOUT, 'symbolic-ref', '--quiet', 'HEAD'), 'refs/heads/main', '主 checkout 分支未被切换');

  // 登记表可见（`git worktree list` 即审计面）
  assert.match(gitOut(LAYOUT, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${r.isolation.path.replace(/[/.]/g, '\\$&')}`));

  // 收尾纪律：脏树拒绝清理；前向编辑清干净后可 --remove，且**保留分支**（SOP §7）
  const dirtyRm = laneWorktree({ repo: LAYOUT, lane: LANE, remove: true });
  assert.equal(dirtyRm.ok, false, JSON.stringify(dirtyRm));
  assert.match(dirtyRm.reason, /^worktree_dirty/);
  fs.rmSync(path.join(r.cwd, 'team-a.mjs'));
  const rm = laneWorktree({ repo: LAYOUT, lane: LANE, remove: true });
  assert.equal(rm.ok, true, JSON.stringify(rm));
  assert.equal(rm.action, 'removed');
  assert.equal(rm.cmd.includes('--force'), false, '绝不使用 --force');
  assert.equal(gitOut(LAYOUT, 'rev-parse', '--verify', '--quiet', `refs/heads/lane/${LANE}`).length, 40, '清理保留分支（可能承载已提交产物）');
  assert.equal(porcelain(LAYOUT), '', '清理全程不得污染共享 checkout');
  // 清理必须**真的摘掉注册**：`git worktree remove` 退出 0 ≠ 注册已摘。残留注册会让后续用例的
  // 「路径空闲」前提静默失效——fail-closed 用例更会被**反转**成 `reused`（见文件头「夹具自持性」）。
  assert.equal(isRegisteredWt(r.isolation.path), false, '清理后不得残留 worktree 注册（`git worktree list` 无该条目）');
  assert.equal(fs.existsSync(r.isolation.path), false, '清理后目录亦须消失');
});

// ── A5 兼容 / 回退开关 ──────────────────────────────────────────────────────

test('COMPAT. 单 lane（无并发非终态卡）⇒ 路径不变：cwd 仍是项目根，不建树（A5）', { skip: SKIP }, () => {
  writeCard(SELF, { writes: 'team-a.mjs' }); // 看板只有本卡
  const r = spawnLane({ card: SELF, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isolation.mode, 'none', JSON.stringify(r.isolation));
  assert.equal(r.isolation.reason, 'no_concurrent_lane');
  assert.equal(r.cwd, LAYOUT, '单 lane 不受影响（兼容路径）');
  assert.equal(fs.existsSync(`${LAYOUT}-wt-${LANE}`), false, '单 lane 不得建树');
});

test('COMPAT. role=review（只读角色）⇒ 不隔离（SOP §3：隔离写者，不隔离读者）', { skip: SKIP }, () => {
  const id = 'T-20260103-400002-review';
  writeCard(id, { status: 'in_review', claimed: 'linus' });
  writeCard(OTHER, { claimed: 'jobs', writes: 'team-b.mjs' });
  const r = spawnLane({ card: id, owner: 'turing', backend: 'codex', role: 'review', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isolation.mode, 'none', JSON.stringify(r.isolation));
  assert.equal(r.isolation.reason, 'read_only_role');
  assert.equal(r.cwd, LAYOUT);
});

test('SWITCH. 回退开关：CLI --no-isolate 与 env OPENCLAW_LANE_ISOLATION=0 都回到旧行为', { skip: SKIP }, () => {
  concurrentBoard();
  const viaFlag = spawnLane({ card: SELF, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true, isolate: false });
  assert.equal(viaFlag.ok, true, JSON.stringify(viaFlag));
  assert.equal(viaFlag.isolation.mode, 'disabled');
  assert.equal(viaFlag.cwd, LAYOUT);

  const prev = process.env.OPENCLAW_LANE_ISOLATION;
  process.env.OPENCLAW_LANE_ISOLATION = '0';
  try {
    const viaEnv = spawnLane({ card: SELF, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });
    assert.equal(viaEnv.isolation.mode, 'disabled', JSON.stringify(viaEnv.isolation));
    assert.equal(viaEnv.cwd, LAYOUT);
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_LANE_ISOLATION;
    else process.env.OPENCLAW_LANE_ISOLATION = prev;
  }
});

test('DRY-RUN. 隔离开启 + --dry-run ⇒ 报计划 worktree 路径但**零副作用**（不建树/不写 registry/不起进程）', { skip: SKIP }, () => {
  concurrentBoard();
  const r = spawnLane({ card: SELF, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.dryRun, true);
  assert.equal(r.pid, null);
  assert.equal(r.isolation.mode, 'worktree');
  assert.equal(r.isolation.applied, false);
  assert.equal(r.isolation.action, 'would_create');
  assert.equal(r.cwd, `${LAYOUT}-wt-${LANE}`, 'dry-run 即报出**将**使用的工作树（预演保真）');
  assert.equal(fs.existsSync(r.cwd), false, 'dry-run 不得建树');
  assert.equal(porcelain(LAYOUT), '', 'dry-run 不得改仓');
  assert.equal(fs.existsSync(REG), false, 'dry-run 不得写 registry');
  assert.equal(fs.existsSync(STUB_ARGS), false, 'dry-run 不得起进程');
});

// ── A1 的另一半：同文件 ⇒ 显式串行；fail-closed ─────────────────────────────

test('SERIALIZE. 同**文件**并发写 ⇒ 拒绝起会话（显式串行），且零副作用', { skip: SKIP }, () => {
  concurrentBoard('team/CHANGELOG.md', 'team/CHANGELOG.md'); // 同写一个文件（T-20261012-002049 的形状）
  const r = spawnLane({ card: SELF, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });

  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, `lane_samefile_conflict(with=${OTHER},overlap=team/CHANGELOG.md):serialize`, '拒绝原因稳定可 grep');
  assert.equal(r.isolation.mode, 'serialize');
  assert.deepEqual(r.isolation.conflicts, [{ card: OTHER, overlap: ['team/CHANGELOG.md'] }], '冲突点可点名');
  // 零副作用：不建树、不起进程、不写 registry、卡未被改
  assert.equal(fs.existsSync(laneWtPath(LANE)), false);
  assert.equal(isRegisteredWt(laneWtPath(LANE)), false, '拒绝时连注册都不得留下（比「目录不存在」更强）');
  assert.equal(fs.existsSync(REG), false, '拒绝时不得写 registry');
  assert.equal(fs.existsSync(STUB_ARGS), false, '拒绝时不得起进程');
  assert.match(fs.readFileSync(path.join(TASKS, `${SELF}.md`), 'utf8'), /^status: in_progress$/m);
  assert.equal(porcelain(LAYOUT), '');
});

test('FAIL-CLOSED. 隔离被拒（预定路径被非 worktree 目录占用）⇒ 拒绝起会话，绝不静默降级回共享 checkout', { skip: SKIP }, () => {
  // 专属 lane（见 CLASH）：本用例的预定路径与其它用例零交集 ⇒ 不被任何别的用例的收尾状态左右。
  writeCard(CLASH, { writes: 'team-c.mjs' });
  writeCard(OTHER, { claimed: 'jobs', writes: 'team-b.mjs' });
  const clash = laneWtPath(CLASH_LANE);
  // 前置条件（**显式断言**，不是假设）：路径既无目录也**无 worktree 注册**。这两件事在
  // lane-worktree.mjs 里分属两条分支：「有目录、无注册」⇒ `path_exists_not_worktree`（本用例走的这条）；
  // 「有注册」⇒ 该注册必须**真的站在那里**才可复用（T-20261014-053826-2 起：注册在、目录已删 ⇒
  // `worktree_stale_registration` 点名拒绝，既不 `reused`、也不落到本守卫）。前置条件被污染时此断言
  // 直接点名病因，而不是让 fail-closed 断言被静默反转成 `ok:true`（T-20261014-034118-2 的实证形状）。
  assert.equal(fs.existsSync(clash), false, '前置条件：pre-计划隔离路径须为空');
  assert.equal(isRegisteredWt(clash), false, '前置条件：该路径不得已有 worktree 注册');

  SIBLINGS.push(clash);
  fs.mkdirSync(clash, { recursive: true });
  fs.writeFileSync(path.join(clash, 'keep.txt'), 'x');
  assert.equal(isRegisteredWt(clash), false, '普通目录≠worktree 注册：这正是「占用」与「复用」的分界');

  const r = spawnLane({ card: CLASH, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^lane_isolation_failed\(path_exists_not_worktree/, r.reason);
  assert.match(r.reason, /:serialize_or_fix$/);
  assert.equal(fs.readFileSync(path.join(clash, 'keep.txt'), 'utf8'), 'x', '占用目录不得被动');
  assert.equal(fs.existsSync(STUB_ARGS), false, '不得起进程');
  assert.equal(porcelain(LAYOUT), '');
});

test('FAIL-CLOSED. 隔离树「注册在、目录已删」⇒ 拒绝起会话（绝不把 lane 起进不存在的 cwd）(T-20261014-053826-2)', { skip: SKIP }, () => {
  writeCard(STALE, { writes: 'team-s.mjs' });
  writeCard(OTHER, { claimed: 'jobs', writes: 'team-b.mjs' });
  const wt = laneWtPath(STALE_LANE);
  assert.equal(fs.existsSync(wt), false, '前置条件：pre-计划隔离路径须为空');
  assert.equal(isRegisteredWt(wt), false, '前置条件：该路径不得已有 worktree 注册');

  // 经**规范入口**造出真态：先正常建树（目录 + 注册），再删掉工作目录（半完成清理 / 人工 rm -rf）
  SIBLINGS.push(wt);
  const made = laneWorktree({ repo: LAYOUT, lane: STALE_LANE });
  assert.equal(made.ok, true, JSON.stringify(made));
  fs.rmSync(wt, { recursive: true, force: true });
  assert.equal(fs.existsSync(wt), false);
  assert.equal(isRegisteredWt(wt), true, '前置条件：注册仍在 —— 这正是「登记在、目录已删」');

  const r = spawnLane({ card: STALE, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  // 修复前：复用分支早于一切校验 ⇒ 判定 `reused` ⇒ 会话**真的起在那个不存在的目录里**（`ok:true`、pid 非空）
  assert.equal(r.ok, false, `残留注册不得读成可用（会把 lane 起进虚空）：${JSON.stringify(r)}`);
  assert.match(r.reason, /^lane_isolation_failed\(worktree_stale_registration\(dir_missing\)/, r.reason);
  assert.match(r.reason, /:serialize_or_fix$/);
  // fail-closed = 零副作用：不起进程、不写 registry、不建树、不碰那棵树
  assert.equal(fs.existsSync(STUB_ARGS), false, '不得起进程（起进不存在的 cwd 是本缺陷的实际危害）');
  assert.equal(fs.existsSync(REG), false, '预演即在 claim 前拒绝 ⇒ 连 registry 都不该写');
  // 比「没起进程」更强：拒绝发生在 ①c（隔离预演），早于 ④handoff/⑦spawn ⇒ 连 lane 的 workspace 都不该被建
  // （修复前走到 ⑦ 才炸 ⇒ 这里会留下一份「起不来的 lane」的 workspace 产物）
  assert.equal(fs.existsSync(path.join(WS, STALE)), false, '拒绝不得为一起不来的 lane 留 workspace 产物');
  assert.equal(fs.existsSync(wt), false, '拒绝不得顺手重建目录');
  assert.equal(isRegisteredWt(wt), true, '拒绝不得顺手摘注册');
  assert.equal(porcelain(LAYOUT), '', '拒绝不得改仓');

  // 恢复路径（同一入口、非破坏 git）：--remove 遗忘残留注册、保留分支 ⇒ 再建树即成功
  const rm = laneWorktree({ repo: LAYOUT, lane: STALE_LANE, remove: true });
  assert.equal(rm.ok, true, JSON.stringify(rm));
  assert.equal(rm.action, 'removed');
  assert.equal(rm.stale, true);
  assert.equal(isRegisteredWt(wt), false, '残留注册须被遗忘');
  assert.equal(gitOut(LAYOUT, 'rev-parse', '--verify', '--quiet', `refs/heads/lane/${STALE_LANE}`).length, 40, '分支保留（可能承载已提交产物）');

  const again = laneWorktree({ repo: LAYOUT, lane: STALE_LANE });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.created, true);
  assert.equal(again.branchReused, true, '分支仍在 ⇒ 附着复用（幂等可重入）');
  assert.equal(fs.existsSync(wt), true);
  // 收尾：clean ⇒ 摘树（不留在 tmpdir 里，也不留给下一个用例）
  assert.equal(laneWorktree({ repo: LAYOUT, lane: STALE_LANE, remove: true }).action, 'removed');
});
