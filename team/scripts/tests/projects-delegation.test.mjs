#!/usr/bin/env node
/**
 * projects-delegation.test.mjs — scripts/lib.mjs 经 ACL 解析项目 + seed 登记脚本
 *
 * 契约：guides/task-interface.md §8；设计：任务卡 T-20261009-040200-teambackfill-projmigrate。
 * 仓内版（T-20261013-015522-4）：由 live 孤儿测试重写而来，**对齐 root 校验新契约**
 * （seed-projects.mjs#invalidRootReason：root 须「绝对 / 存在 / 为目录」，登记前整体校验）。
 * 旧版 fixture 用 `/abs/alpha` 一类**不存在**的占位 root ⇒ 新守卫下整轮登记拒绝（7 失败）；
 * 本版 fixture 一律物化**真实存在**的目录，并把断言对准新契约的错误语义（/登记中止/ +
 * 「一条都不写」的 fail-fast），不保留任何被退休的「root 无需存在」假设。
 *
 * 隔离：OPENCLAW_TEAM_ROOT=tmp（fixture projects.json）+ 基座不可用（OPENCLAW_TEAM_TASKCTL 指不存在命令），
 *       令 lib.getProject 走只读回退；**不碰真实 projects.json / 真实 board**。
 * 注：team 侧 §8 解析自 T-20261012-015323-2 起走 board-adapter（taskctl 子进程），
 *     故「基座不可用」改由 OPENCLAW_TEAM_TASKCTL 注入（不再看 provider 的 board DB 文件）。
 * 逐字口径见 seed-projects.test.mjs（A 面：root 守卫单测）；本文件偏 B 面（lib / CLI / seed 主流程 / 集成）。
 * 无 provider 安装 ⇒ SKIP（不是失败）。
 * 运行：node --test team/scripts/tests/projects-delegation.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 定位携带 ACL 库的 provider 安装目录（与 seed-projects.test.mjs / patrol.test.mjs 同口径）。 */
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
/** provider 缺失 ⇒ 一并跳过；否则按 cond 决定 */
const skipUnless = (cond, reason) => SKIP || (cond ? false : reason);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-del-'));
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

process.env.OPENCLAW_TEAM_ROOT = TMP;
// 基座不可用：taskctl 指向不存在命令 ⇒ resolver 必走只读回退
process.env.OPENCLAW_TEAM_TASKCTL = path.join(TMP, 'no-such-taskctl');
delete process.env.TASKD_DB;
delete process.env.TASKD_DATA_DIR;
delete process.env.OPENCLAW_TEAM_TASKPANEL_DB;
if (PROVIDER) process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;

// ── fixture root：**必须真实存在**（新守卫要求绝对 / 存在 / 为目录）──────────────
const ALPHA_ROOT = path.join(TMP, 'repos', 'alpha');
const BETA_ROOT = path.join(TMP, 'repos', 'beta');
fs.mkdirSync(ALPHA_ROOT, { recursive: true });
fs.mkdirSync(BETA_ROOT, { recursive: true });

const REGISTRY = {
  projects: {
    __team__: { kind: 'team', root: '/should-be-skipped' }, // 保留名：不校验、不登记
    Alpha: {
      kind: 'code',
      root: ALPHA_ROOT,
      root_git: true,
      repos: [{ kind: 'code', rel_path: '.', git: true }],
      guides: [`${ALPHA_ROOT}/README.md`],
      default_git_rules: 'g-alpha',
      notes: 'n-alpha',
      registered_at: '2026-01-01',
    },
    Beta: {
      kind: 'vault',
      root: BETA_ROOT,
      root_git: false,
      repos: [],
      guides: [],
      default_git_rules: '',
      notes: 'n-beta',
      registered_at: '2026-01-02',
    },
  },
};
fs.writeFileSync(path.join(TMP, 'projects.json'), JSON.stringify(REGISTRY), 'utf8');

// provider 依赖为**条件动态 import**：缺 provider 时 lib.mjs 在 import 期即 process.exit(1) 硬红，
// seed-projects 顶层还会动态导入 provider 基座适配器（bases/task-panel.mjs）⇒ 亦须 provider 就位。
let lib, seed;
if (PROVIDER) {
  lib = await import('../lib.mjs');
  seed = await import('../seed-projects.mjs');
}
const { registerIdentityCodes, seedProjects, main, isMainEntry } = seed ?? {};

const fakeBoard = (existingIds = []) => {
  const calls = { create: [], update: [] };
  return {
    calls,
    repos: { projects: { get: (id) => (existingIds.includes(id) ? { id, meta: {} } : null) } },
    commands: {
      createProject: (input) => { calls.create.push(input); return { id: input.id }; },
      updateProject: (input) => { calls.update.push(input); return { id: input.id }; },
    },
  };
};

// ── 默认 meerkat-taskpanel 检出（去个人默认路径）：与 seed-projects.mjs 同源的兄弟目录探测 ──
// 解析为 REPO_ROOT（team/scripts 上三级）的兄弟目录：新名 ../meerkat-taskpanel 优先，
// 兼容旧名 ../task-panel（legacy-name-compat）。部署布局下兄弟目录通常不存在 ⇒ HAS_REPO=false。
const DEFAULT_REPO_CANDIDATES = ['meerkat-taskpanel', 'task-panel'] // legacy-name-compat(旧检出目录名)
  .map((n) => path.resolve(SCRIPTS, '..', '..', '..', n));
const REPO = process.env.MEERKAT_TASKPANEL_REPO
  || DEFAULT_REPO_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'src', 'core', 'bootstrap.mjs')))
  || DEFAULT_REPO_CANDIDATES[0];
const HAS_REPO = fs.existsSync(path.join(REPO, 'src', 'core', 'bootstrap.mjs'));

// ---------- lib.mjs 经 ACL ----------

test('lib 再导出路径常量与 team-paths 同源（TEAM_ROOT 指向隔离根）', () => {
  assert.equal(lib.TEAM_ROOT, TMP);
  assert.equal(lib.PROJECTS_FILE, path.join(TMP, 'projects.json'));
  assert.equal(lib.TASKS_DIR, path.join(TMP, 'tasks'));
});

test('lib.getProject：基座不可用 ⇒ 走只读回退返回 metadata（含 name）', () => {
  const p = lib.getProject('Alpha');
  assert.equal(p.name, 'Alpha');
  assert.equal(p.kind, 'code');
  assert.equal(p.root, ALPHA_ROOT);
  assert.equal(p.default_git_rules, 'g-alpha');
  assert.deepEqual(p.repos, [{ kind: 'code', rel_path: '.', git: true }]);
  assert.equal(p.registered_at, '2026-01-01');
});

test('lib.getProject：__team__ 保留名正常（不查基座/回退）', () => {
  const p = lib.getProject('__team__');
  assert.equal(p.kind, 'team');
  assert.equal(p.root, null);
  assert.ok(p.guides[0].endsWith('/PROTOCOL.md'));
});

test('lib.getProject：未知 code 抛「项目未注册」', () => {
  assert.throws(() => lib.getProject('NoSuchCode'), /项目未注册: NoSuchCode/);
});

test('CLI get-project 经回退；未知 code 退出非 0 且 stderr 报未注册', () => {
  const run = (arg) => spawnSync(process.execPath, [path.join(SCRIPTS, 'lib.mjs'), 'get-project', arg], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: TMP, OPENCLAW_TEAM_TASKCTL: path.join(TMP, 'no-such-taskctl') },
    encoding: 'utf8',
  });
  const okRun = run('Beta');
  assert.equal(okRun.status, 0);
  const parsed = JSON.parse(okRun.stdout);
  assert.equal(parsed.name, 'Beta');
  assert.equal(parsed.kind, 'vault');

  const badRun = run('NoSuchCode');
  assert.notEqual(badRun.status, 0);
  assert.match(String(badRun.stderr), /项目未注册/);
});

// ---------- seed：registerIdentityCodes ----------

test('registerIdentityCodes：新增走 create、已存在走 update、跳过 __team__', () => {
  const board = fakeBoard(['Beta']);
  const summary = registerIdentityCodes(board, REGISTRY);

  assert.equal(board.calls.create.length, 1);
  assert.equal(board.calls.update.length, 1);

  const c = board.calls.create[0];
  assert.equal(c.id, 'Alpha');
  assert.equal(c.name, 'Alpha');
  assert.equal(c.meta.kind, 'code');
  assert.equal(c.meta.root, ALPHA_ROOT);
  assert.equal(c.meta.root_git, true);
  assert.deepEqual(c.meta.repos, [{ kind: 'code', rel_path: '.', git: true }]);
  assert.deepEqual(c.meta.guides, [`${ALPHA_ROOT}/README.md`]);
  assert.equal(c.meta.default_git_rules, 'g-alpha');
  assert.equal(c.meta.registered_at, '2026-01-01');
  assert.equal(Object.prototype.hasOwnProperty.call(c, 'workspacePath'), false, 'O3：惰性 workspacePath 不得出现');

  const u = board.calls.update[0];
  assert.equal(u.id, 'Beta');
  assert.equal(u.patch.name, 'Beta');
  assert.equal(u.patch.meta.kind, 'vault');
  assert.equal(u.patch.meta.root, BETA_ROOT);

  assert.ok(!board.calls.create.some((x) => x.id === '__team__'));
  assert.ok(!board.calls.update.some((x) => x.id === '__team__'));

  assert.deepEqual(summary.map((s) => [s.code, s.action]), [['Alpha', 'created'], ['Beta', 'updated']]);
});

test('registerIdentityCodes：幂等（重复执行 ⇒ 全 update，不重复创建）', () => {
  const board = fakeBoard(['Alpha', 'Beta']);
  const summary = registerIdentityCodes(board, REGISTRY);
  assert.equal(board.calls.create.length, 0);
  assert.equal(board.calls.update.length, 2);
  assert.deepEqual(summary.map((s) => [s.code, s.action]), [['Alpha', 'updated'], ['Beta', 'updated']]);
});

test('registerIdentityCodes：空/缺失 registry 不报错', () => {
  const board = fakeBoard([]);
  assert.deepEqual(registerIdentityCodes(board, {}), []);
  assert.deepEqual(registerIdentityCodes(board, null), []);
  assert.equal(board.calls.create.length, 0);
});

test('registerIdentityCodes：root 非法 ⇒ 默认拒绝整轮（抛错、一条都不写，绝不部分登记）', () => {
  const board = fakeBoard([]);
  // 新契约：缺 / 相对 / 不存在 三类都非法；默认模式 fail-fast，合法的 Alpha 也不得落库
  assert.throws(
    () => registerIdentityCodes(board, {
      projects: {
        Alpha: { kind: 'code', root: ALPHA_ROOT },      // 合法
        Bad: { kind: 'code', root: 'relative/path' },   // 非绝对
        Ghost: { kind: 'code', root: path.join(TMP, 'no-such-dir') }, // 不存在
        NoRoot: { kind: 'code' },                       // 缺失
      },
    }),
    (e) => {
      assert.match(e.message, /登记中止/);
      assert.match(e.message, /Bad: 非绝对路径/);
      assert.match(e.message, /Ghost: 不存在/);
      assert.match(e.message, /NoRoot: 缺失/);
      return true;
    },
  );
  assert.equal(board.calls.create.length, 0, '整体拒绝：一条都不写');
  assert.equal(board.calls.update.length, 0);
});

test('registerIdentityCodes：allowInvalidRoot ⇒ 逐条显式告警并跳过，其余照常登记', () => {
  const board = fakeBoard([]);
  const warns = [];
  const summary = registerIdentityCodes(board, {
    projects: {
      Alpha: { kind: 'code', root: ALPHA_ROOT },
      Ghost: { kind: 'code', root: path.join(TMP, 'no-such-dir') },
    },
  }, { allowInvalidRoot: true, logger: { warn: (m) => warns.push(String(m)), log: () => {} } });

  assert.equal(board.calls.create.length, 1, '合法项仍登记');
  assert.equal(board.calls.create[0].id, 'Alpha');
  const skipped = summary.find((s) => s.action === 'skipped');
  assert.ok(skipped, 'summary 须显式回报 skipped');
  assert.equal(skipped.code, 'Ghost');
  assert.match(String(skipped.reason), /不存在/);
  assert.equal(warns.length, 1, '跳过必须显式告警');
  assert.match(warns[0], /跳过 Ghost/);
});

// ---------- seed：seedProjects 主流程 ----------

test('seedProjects：主流程（temp board + fixture registry）⇒ 摘要 + 幂等', { skip: skipUnless(HAS_REPO, 'task-panel 仓缺失') }, async () => {
  const dir = path.join(TMP, 'seed-main');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'board.sqlite');
  const logs = [];
  const res = await seedProjects({
    repo: REPO,
    projectsFile: path.join(TMP, 'projects.json'),
    dataDir: dir,
    dbPath,
    logger: { log: (m) => logs.push(String(m)) },
  });
  assert.equal(res.dbPath, dbPath);
  assert.deepEqual(res.summary.map((s) => [s.code, s.action]), [['Alpha', 'created'], ['Beta', 'created']]);
  assert.ok(fs.existsSync(dbPath), 'board 文件应已建立');
  assert.ok(logs.some((l) => l.includes('完成：2 个项目')));

  // 幂等：再跑一次 ⇒ 全 updated，不重复创建
  const res2 = await seedProjects({
    repo: REPO,
    projectsFile: path.join(TMP, 'projects.json'),
    dataDir: dir,
    dbPath,
    logger: { log() {} },
  });
  assert.deepEqual(res2.summary.map((s) => s.action), ['updated', 'updated']);
});

test('seedProjects：meerkat-taskpanel 仓缺失 ⇒ 抛可诊断错误', async () => {
  await assert.rejects(
    () => seedProjects({ repo: path.join(TMP, 'no-repo'), logger: { log() {} } }),
    /meerkat-taskpanel 仓不存在/,
  );
});

test('seedProjects：identity code 来源缺失 ⇒ 抛错', { skip: skipUnless(HAS_REPO, 'task-panel 仓缺失') }, async () => {
  await assert.rejects(
    () => seedProjects({ repo: REPO, projectsFile: path.join(TMP, 'missing-projects.json'), logger: { log() {} } }),
    /未找到 identity code 来源/,
  );
});

test('seedProjects：默认来源兜底（MEERKAT_TASKPANEL_REPO env + PROJECTS_FILE + 团队默认 board）', { skip: skipUnless(HAS_REPO, 'task-panel 仓缺失') }, async () => {
  const saved = {
    MEERKAT_TASKPANEL_REPO: process.env.MEERKAT_TASKPANEL_REPO,
    OPENCLAW_TEAM_TASKPANEL_DB: process.env.OPENCLAW_TEAM_TASKPANEL_DB,
    TASKD_DB: process.env.TASKD_DB,
    TASKD_DATA_DIR: process.env.TASKD_DATA_DIR,
  };
  process.env.MEERKAT_TASKPANEL_REPO = REPO;
  delete process.env.OPENCLAW_TEAM_TASKPANEL_DB; // 令 dbPath/dataDir 走团队默认兜底
  delete process.env.TASKD_DB;
  delete process.env.TASKD_DATA_DIR;
  try {
    // 不传 repo/projectsFile/dataDir/dbPath ⇒ 走 env / 常量 / 团队默认兜底分支
    const res = await seedProjects({ logger: { log() {} } });
    assert.ok(res.summary.length >= 2);
    assert.equal(res.dbPath, path.join(TMP, '.board', 'board.sqlite'), `dbPath 应为团队默认: ${res.dbPath}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('seedProjects：无 MEERKAT_TASKPANEL_REPO env ⇒ 缺省解析（存在则成功，否则明确报错，不静默）', async () => {
  const saved = process.env.MEERKAT_TASKPANEL_REPO;
  delete process.env.MEERKAT_TASKPANEL_REPO;
  try {
    if (HAS_REPO) {
      // 检出布局：兄弟 ../meerkat-taskpanel（或旧名 ../task-panel）存在 ⇒ 走缺省仓、登记成功
      const res = await seedProjects({ logger: { log() {} } });
      assert.ok(res.summary.length >= 2);
    } else {
      // 部署布局：缺省仓不存在 ⇒ 契约要求明确可诊断错误（绝不静默 no-op）
      await assert.rejects(
        () => seedProjects({ logger: { log() {} } }),
        /meerkat-taskpanel 仓不存在或结构不符/,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.MEERKAT_TASKPANEL_REPO;
    else process.env.MEERKAT_TASKPANEL_REPO = saved;
  }
});

test('main：CLI 入口成功路径（隔离 env，静音输出）', { skip: skipUnless(HAS_REPO, 'task-panel 仓缺失') }, async () => {
  const saved = {
    MEERKAT_TASKPANEL_REPO: process.env.MEERKAT_TASKPANEL_REPO,
    OPENCLAW_TEAM_TASKPANEL_DB: process.env.OPENCLAW_TEAM_TASKPANEL_DB,
    TASKD_DB: process.env.TASKD_DB,
    TASKD_DATA_DIR: process.env.TASKD_DATA_DIR,
  };
  process.env.MEERKAT_TASKPANEL_REPO = REPO;
  delete process.env.OPENCLAW_TEAM_TASKPANEL_DB;
  delete process.env.TASKD_DB;
  delete process.env.TASKD_DATA_DIR;
  const realLog = console.log;
  console.log = () => {}; // 静音 seed 摘要
  try {
    const code = await main();
    assert.equal(code, 0);
    assert.ok(fs.existsSync(path.join(TMP, '.board', 'board.sqlite')), 'main 应建立团队默认 board');
  } finally {
    console.log = realLog;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('main：失败路径返回退出码 1（仓缺失，不退出进程）', async () => {
  const saved = process.env.MEERKAT_TASKPANEL_REPO;
  const realErr = console.error;
  process.env.MEERKAT_TASKPANEL_REPO = path.join(TMP, 'no-repo');
  console.error = () => {};
  try {
    assert.equal(await main(), 1);
  } finally {
    console.error = realErr;
    if (saved === undefined) delete process.env.MEERKAT_TASKPANEL_REPO;
    else process.env.MEERKAT_TASKPANEL_REPO = saved;
  }
});

test('isMainEntry：主模块命中 / 被 import 不命中 / 非法路径不抛', () => {
  const seedUrl = new URL('../seed-projects.mjs', import.meta.url);
  const seedPath = fileURLToPath(seedUrl);
  assert.equal(isMainEntry(seedUrl, seedPath), true, 'URL 对象自身路径 ⇒ true');
  assert.equal(isMainEntry(seedUrl, fileURLToPath(import.meta.url)), false, '测试文件 ⇒ false');
  assert.equal(isMainEntry(seedUrl, path.join(TMP, 'no-such-file.mjs')), false, 'realpath 失败 ⇒ false（不抛）');
});

test('isMainEntry：file:// 字符串（import.meta.url 的实际形态）也必须命中 [回归缺陷]', () => {
  const seedUrl = new URL('../seed-projects.mjs', import.meta.url);
  const seedPath = fileURLToPath(seedUrl);
  // 回归：import.meta.url 是「file://…」字符串，直接 realpathSync 会 ENOENT ⇒ 曾致 CLI main-guard 失效
  assert.equal(isMainEntry(seedUrl.href, seedPath), true, 'file:// 字符串 ⇒ true（修复前为 false）');
  assert.equal(isMainEntry(seedUrl.href, fileURLToPath(import.meta.url)), false, 'file:// 字符串 + 测试文件 ⇒ false');
  assert.equal(isMainEntry('file:///no/such/file.mjs', seedPath), false, '不存在的 file:// 串 ⇒ false（不抛）');
  assert.equal(isMainEntry(seedPath, fileURLToPath(import.meta.url)), false, '普通路径串与 argv1 不同 ⇒ false');
});

// ---------- 集成：seed 写入真实 board ⇒ 适配器 source=base ----------

test('集成：registerIdentityCodes 写入真实 board ⇒ ACL 适配器 source=base', { skip: skipUnless(HAS_REPO, 'task-panel 仓缺失') }, async () => {
  const boardDir = path.join(TMP, 'board-e2e');
  fs.mkdirSync(boardDir, { recursive: true });
  const boot = await import(pathToFileURL(path.join(REPO, 'src/core/bootstrap.mjs')).href);
  const board = await boot.openBoard({ dataDir: boardDir, dbPath: path.join(boardDir, 'board.sqlite'), pointer: false });
  try {
    registerIdentityCodes(board, REGISTRY);
  } finally {
    board.close();
  }

  // provider ACL 库（有意不随仓）⇒ 从 provider 安装根解析，而非仓内相对路径
  const acl = await import(pathToFileURL(path.join(PROVIDER, 'lib', 'projects.mjs')).href);
  const saved = process.env.OPENCLAW_TEAM_TASKPANEL_DB;
  process.env.OPENCLAW_TEAM_TASKPANEL_DB = path.join(boardDir, 'board.sqlite');
  try {
    const hit = acl.resolveProject('Alpha', { fallbackFile: path.join(TMP, 'definitely-missing.json') });
    assert.equal(hit.source, 'base');
    assert.equal(hit.metadata.name, 'Alpha');
    assert.equal(hit.metadata.root, ALPHA_ROOT);
    assert.equal(hit.metadata.default_git_rules, 'g-alpha');

    // 幂等：再登记一次仍能解析（update 路径）
    const board2 = await boot.openBoard({ dataDir: boardDir, dbPath: path.join(boardDir, 'board.sqlite'), pointer: false });
    try {
      registerIdentityCodes(board2, REGISTRY);
    } finally {
      board2.close();
    }
    assert.equal(acl.resolveProject('Beta', { fallbackFile: path.join(TMP, 'definitely-missing.json') }).source, 'base');
  } finally {
    if (saved === undefined) delete process.env.OPENCLAW_TEAM_TASKPANEL_DB;
    else process.env.OPENCLAW_TEAM_TASKPANEL_DB = saved;
  }
});
