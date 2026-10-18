#!/usr/bin/env node
/**
 * seed-projects.test.mjs — identity code 登记守卫回归（A 面，T-20261012-001338）
 *
 * 背景（事故链复盘 R76→R79）：`registerIdentityCodes` 只校验 root 为绝对路径，
 * 缺 root 的目录被**静默登记**进基座 meta，之后解析拿陈旧 root 当工作目录 ⇒ 一路静默失败。
 *
 * 本套件断言两条：
 *   ① root 守卫：缺 / 相对 / 不存在 / 非目录 ⇒ 默认**拒绝整轮**（一条不写）；合法 ⇒ 正常登记；
 *      `allowInvalidRoot` 时逐条**显式告警并跳过**，其余照常登记。
 *   ② 惰性 `workspacePath` 已清理：createProject / updateProject 调用中**不得**出现该字段
 *      （O3 后 taskpanel 不读；基座 0012 已删列），目录锚点只在 meta.root。
 *
 * 运行：node --test scripts/tests/
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 定位携带 ACL 库的 provider 安装目录（与 main-guard.test.mjs / archive.test.mjs 同口径）。 */
function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    // 部署布局相对候选：<team>/skills/task-ops（自 tests/ 上溯两级）—— 不读宿主 ~/.openclaw
    path.resolve(import.meta.dirname, '..', '..', 'skills', 'task-ops'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'lib', 'team-paths.mjs'))) return c;
  }
  return null;
}
const PROVIDER = resolveProviderRoot();
const SKIP = PROVIDER
  ? false
  : 'provider ACL library not installed (task-ops is intentionally not vendored); set OPENCLAW_TASK_OPS_DIR to run';
const test = SKIP ? nodeTest.skip : nodeTest;

// provider 依赖为**条件动态 import**：缺 provider 时 lib.mjs 在 import 期即 process.exit(1) 硬红。
// seed-projects 顶层还会动态导入 provider 基座适配器 ⇒ 亦须 provider 就位。
let registerIdentityCodes, invalidRootReason, invalidRepoReason;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ registerIdentityCodes, invalidRootReason, invalidRepoReason } = await import('../seed-projects.mjs'));
}

const scratchDirs = [];
function mkScratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-seed-'));
  scratchDirs.push(d);
  return d;
}
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 记录型假基座：只记调用，不写任何东西。`existing` = 已存在的 code 集合。 */
function fakeBoard(existing = []) {
  const calls = { created: [], updated: [] };
  return {
    calls,
    board: {
      repos: { projects: { get: (code) => (existing.includes(code) ? { id: code } : undefined) } },
      commands: {
        createProject: (input) => calls.created.push(input),
        updateProject: (input) => calls.updated.push(input),
      },
    },
  };
}

/** 静默 logger（收集 warn 文案，供告警断言） */
function spyLogger() {
  const warns = [];
  return { warns, logger: { warn: (m) => warns.push(String(m)), log: () => {} } };
}

// ---- ① root 守卫：invalidRootReason 逐条判据 ---------------------------------

test('root 守卫：缺失 ⇒ 非法（缺）', () => {
  assert.match(String(invalidRootReason(undefined)), /缺失/);
  assert.match(String(invalidRootReason('')), /缺失/);
  assert.match(String(invalidRootReason('   ')), /缺失/);
  assert.match(String(invalidRootReason(42)), /缺失/);
});

test('root 守卫：相对路径 ⇒ 非法（非绝对路径）', () => {
  assert.match(String(invalidRootReason('rel/path')), /非绝对路径/);
  assert.match(String(invalidRootReason('./x')), /非绝对路径/);
});

test('root 守卫：不存在 ⇒ 非法（不存在）', () => {
  const missing = path.join(mkScratch(), 'does-not-exist');
  assert.match(String(invalidRootReason(missing)), /不存在/);
});

test('root 守卫：是文件而非目录 ⇒ 非法（非目录）', () => {
  const dir = mkScratch();
  const file = path.join(dir, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.match(String(invalidRootReason(file)), /非目录/);
});

test('root 守卫：存在的目录 ⇒ 合法（null）', () => {
  const dir = mkScratch();
  assert.equal(invalidRootReason(dir), null);
});

// ---- ① root 守卫：registerIdentityCodes 的整轮行为 --------------------------

test('登记：非法 root（缺/相对/不存在/非目录）⇒ 默认拒绝整轮，一条都不写', () => {
  const good = mkScratch();
  const file = path.join(mkScratch(), 'file.txt');
  fs.writeFileSync(file, 'x');
  const { board, calls } = fakeBoard();
  const registry = {
    projects: {
      okp: { kind: 'code', root: good },
      miss: { kind: 'code' },
      rel: { kind: 'code', root: 'somewhere/rel' },
      ghost: { kind: 'code', root: path.join(os.tmpdir(), 'oc-seed-ghost-nope') },
      afile: { kind: 'code', root: file },
    },
  };
  assert.throws(() => registerIdentityCodes(board, registry), (e) => {
    // 显式报出每一个非法 code 与原因（不静默）
    for (const code of ['miss', 'rel', 'ghost', 'afile']) assert.match(e.message, new RegExp(`${code}:`));
    assert.match(e.message, /登记中止/);
    return true;
  });
  assert.equal(calls.created.length, 0, '拒绝模式不得写任何项目（含合法的那个 —— 整体拒绝）');
  assert.equal(calls.updated.length, 0);
});

test('登记：合法 root ⇒ 新建 created / 已存在 updated，且 meta.root 为锚点', () => {
  const dirNew = mkScratch();
  const dirOld = mkScratch();
  const { board, calls } = fakeBoard(['existing']);
  const registry = {
    projects: {
      newp: { kind: 'code', root: dirNew, repos: [{ path: 'src' }] },
      existing: { kind: 'docs', root: dirOld, default_git_rules: 'md only' },
      __team__: { kind: 'team', root: '/definitely/not/checked' }, // 保留名：不校验、不登记
    },
  };
  const summary = registerIdentityCodes(board, registry);
  assert.deepEqual(summary.map((s) => s.action).sort(), ['created', 'updated']);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].id, 'newp');
  assert.equal(calls.created[0].meta.root, dirNew);
  assert.deepEqual(calls.created[0].meta.repos, [{ path: 'src' }]);
  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0].id, 'existing');
  assert.equal(calls.updated[0].patch.meta.root, dirOld);
  assert.equal(summary.some((s) => s.code === '__team__'), false, '保留名 __team__ 不得登记');
});

test('登记：allowInvalidRoot ⇒ 逐条显式告警并跳过，其余照常登记（不静默）', () => {
  const good = mkScratch();
  const { board, calls } = fakeBoard();
  const { warns, logger } = spyLogger();
  const registry = { projects: { okp: { kind: 'code', root: good }, ghost: { kind: 'code', root: '/nope/nope' } } };
  const summary = registerIdentityCodes(board, registry, { allowInvalidRoot: true, logger });
  assert.equal(calls.created.length, 1, '合法项仍登记');
  assert.equal(calls.created[0].id, 'okp');
  const skipped = summary.find((s) => s.action === 'skipped');
  assert.ok(skipped, 'summary 须显式回报 skipped');
  assert.equal(skipped.code, 'ghost');
  assert.match(String(skipped.reason), /不存在/);
  assert.equal(warns.length, 1, '跳过必须显式告警（stderr 通道）');
  assert.match(warns[0], /跳过 ghost/);
});

// ---- ①b rel_path containment：invalidRepoReason 判据（`R-PROJECT-2`） ---------

test('invalidRepoReason：空/缺省/项目内相对 ⇒ null（合法）', () => {
  for (const v of [undefined, null, '', '   ', '.', './', 'src', 'src/x', './x', 'a/b/']) {
    assert.equal(invalidRepoReason(v), null, `${JSON.stringify(v)} 应合法`);
  }
});

test('invalidRepoReason：绝对/本机锚/盘符/../ 逃逸（含中段 ..）⇒ 报原因', () => {
  for (const v of ['/abs/x', '~/.openclaw/team', 'C:\\work', '../sibling', 'a/../../b']) {
    assert.match(String(invalidRepoReason(v)), /越出项目 root/, v);
  }
});

test('invalidRepoReason：非字符串 ⇒ 明确报错（不静默）', () => {
  assert.match(String(invalidRepoReason(42)), /非字符串/);
});

test('登记：repos[].rel_path 逃逸 ⇒ 默认拒绝整轮，一条都不写（`R-PROJECT-2`）', () => {
  const good = mkScratch();
  const { board, calls } = fakeBoard();
  const registry = {
    projects: {
      okp: { kind: 'code', root: good },
      bad: { kind: 'code', root: good, repos: [{ kind: 'code', rel_path: '../sibling', git: true }] },
    },
  };
  assert.throws(() => registerIdentityCodes(board, registry), (e) => {
    assert.match(e.message, /bad:/);
    assert.match(e.message, /rel_path 越出项目 root/);
    assert.match(e.message, /登记中止/);
    return true;
  });
  assert.equal(calls.created.length, 0, '拒绝模式不得写任何项目（含合法的那个 —— 整体拒绝）');
});

test('登记：repos[].rel_path 逃逸 + allowInvalidRoot ⇒ 显式告警并跳过，其余照常登记', () => {
  const good = mkScratch();
  const { board, calls } = fakeBoard();
  const { warns, logger } = spyLogger();
  const registry = {
    projects: {
      okp: { kind: 'code', root: good },
      bad: { kind: 'code', root: good, repos: [{ rel_path: '/etc' }] },
    },
  };
  const summary = registerIdentityCodes(board, registry, { allowInvalidRoot: true, logger });
  assert.equal(calls.created.length, 1, '合法项仍登记');
  assert.equal(calls.created[0].id, 'okp');
  const skipped = summary.find((s) => s.action === 'skipped');
  assert.equal(skipped.code, 'bad');
  assert.match(String(skipped.reason), /越出项目 root/);
  assert.equal(warns.length, 1);
});

test('登记：live 形态 rel_path="." ⇒ 不误报（实测 live 两个项目皆为 "." ⇒ 零既存红）', () => {
  const good = mkScratch();
  const { board, calls } = fakeBoard();
  const repos = [{ kind: 'code', rel_path: '.', git: true, remote: 'x', url: 'y' }];
  const summary = registerIdentityCodes(board, { projects: { TaskPanel: { kind: 'code', root: good, repos } } });
  assert.deepEqual(summary.map((s) => s.action), ['created']);
  assert.deepEqual(calls.created[0].meta.repos, repos, 'repos 原样透传（不做规范化改写）');
});

test('登记：repos 无 rel_path 键（旧形 {path:…}）⇒ 不误报（不猜字段）', () => {
  const good = mkScratch();
  const { board, calls } = fakeBoard();
  const registry = { projects: { p: { kind: 'code', root: good, repos: [{ path: 'src' }] } } };
  assert.doesNotThrow(() => registerIdentityCodes(board, registry));
  assert.equal(calls.created.length, 1);
});

// ---- ② 惰性 workspacePath 已清理 --------------------------------------------

test('惰性 workspacePath：create/update 调用中不得出现 workspacePath（O3 后无消费方）', () => {
  const dirNew = mkScratch();
  const dirOld = mkScratch();
  const { board, calls } = fakeBoard(['existing']);
  registerIdentityCodes(board, {
    projects: { newp: { kind: 'code', root: dirNew }, existing: { kind: 'code', root: dirOld } },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(calls.created[0], 'workspacePath'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(calls.updated[0], 'workspacePath'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(calls.updated[0].patch, 'workspacePath'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(calls.created[0], 'name'), true, 'create 仍须带 name');
  assert.equal(calls.created[0].meta.root, dirNew, '目录锚点只在 meta.root');
});
