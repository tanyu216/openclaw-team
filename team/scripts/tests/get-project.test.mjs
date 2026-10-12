#!/usr/bin/env node
/**
 * get-project.test.mjs — `lib.get_project` 的 §8 解析链（team 侧薄调用）回归（C 面，T-20261012-001338）
 *
 * 端到端断言（真临时目录 + 真子进程 + 假 taskctl 可执行）：`__team__` 内置短路 → 基座（版本腿 +
 * CLI 取数）→ 只读回退 projects.json → 未注册抛错；并钉住保留名 `__team__` 的输出形状（对外行为不变）。
 * 假 CLI 同时应答**版本腿**（`--version --json`，版本由 `$FAKE_SCHEMA_VERSION` 控制，默认 4 = 与本
 * 适配器声明一致），故「版本漂移 ⇒ 判红降级」可在本套件端到端证伪/证实。
 *
 * 运行：node --test scripts/tests/
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 定位携带 ACL 库的 provider 安装目录（与 frontmatter.test.mjs 同口径）。 */
function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    path.join(os.homedir(), '.openclaw', 'team', 'skills', 'task-ops'),
    path.join(os.homedir(), '.openclaw', 'skills', 'task-ops'),
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

const scratchDirs = [];
function mkScratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-getproject-'));
  scratchDirs.push(d);
  return d;
}
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

// 隔离实例根：lib.mjs 的 PROJECTS_FILE 取自 OPENCLAW_TASK_OPS_DIR 之外的 OPENCLAW_TEAM_ROOT
const ROOT = mkScratch();
fs.mkdirSync(path.join(ROOT, 'tasks'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'projects.json'),
  JSON.stringify({ projects: { fbproj: { kind: 'docs', root: '/from-fallback' } } }),
);

// 假 taskctl：`--version --json` ⇒ 版本腿（$FAKE_SCHEMA_VERSION，默认 4）；其余 ⇒ 板上只有 `boardproj`
// （projectToWire 形状的 meta），其它 code 不在板上。
const stubDir = mkScratch();
const STUB = path.join(stubDir, 'taskctl');
fs.writeFileSync(
  STUB,
  `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "--version" ]; then
    printf '{"ok":true,"data":{"version":"1.0.0","schema_version":%s}}\\n' "\${FAKE_SCHEMA_VERSION:-4}"
    exit 0
  fi
done
cat <<'JSON'
{"ok":true,"data":{"projects":[
 {"id":"boardproj","name":"boardproj","labels":[],"meta":{"kind":"code","root":"/from-board","repos":[{"path":"src"}],"guides":[]},"readme":null,"task_count":2,"archived_at":null,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}
]}}
JSON
`,
);
fs.chmodSync(STUB, 0o755);

let lib;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  process.env.OPENCLAW_TEAM_ROOT = ROOT;
  process.env.OPENCLAW_TEAM_TASKCTL = STUB;
  lib = await import('../lib.mjs');
}

test('保留名 __team__：内置短路，输出形状与契约逐字段一致（不查板、不查回退）', () => {
  const expected = {
    name: '__team__',
    kind: 'team',
    root: null,
    writable: [path.join(os.homedir(), '.openclaw', 'team') + path.sep],
    repos: [],
    guides: [path.join(ROOT, 'PROTOCOL.md')],
    default_git_rules: '仅写 ~/.openclaw/team/**；无项目仓库访问权',
    registered_at: null,
  };
  assert.deepEqual(lib.teamProject(), expected);
  assert.deepEqual(lib.getProject('__team__'), expected);
});

test('基座命中：经 `taskctl project list --json` 子进程取数 → §8 投影（root 取 meta.root）', () => {
  const meta = lib.getProject('boardproj');
  assert.equal(meta.name, 'boardproj');
  assert.equal(meta.kind, 'code');
  assert.equal(meta.root, '/from-board', 'root 只在 meta.root（board 0012 后无目录列）');
  assert.deepEqual(meta.repos, [{ path: 'src' }]);
});

test('版本腿（端到端）：provider schema_version 升到 5 ⇒ 基座判红、降级回退；还原回 4 ⇒ 板命中回到绿', () => {
  process.env.FAKE_SCHEMA_VERSION = '5';
  try {
    // 版本漂移 ⇒ 基座不可用（响亮）⇒ 解析链按既有语义落到只读回退，绝不按旧 schema 读板
    assert.equal(lib.getProject('fbproj').kind, 'docs', '基座判红后应落到 projects.json 回退');
    assert.throws(() => lib.getProject('boardproj'), /项目未注册/, '版本漂移时不得命中板');
  } finally {
    delete process.env.FAKE_SCHEMA_VERSION;
  }
  assert.equal(lib.getProject('boardproj').root, '/from-board', '版本还原 ⇒ 绿色恢复（证明拦的是版本腿）');
});

test('板可读但无该 code ⇒ 只读回退 projects.json（过渡期快照）', () => {
  assert.equal(lib.getProject('fbproj').kind, 'docs');
  assert.equal(lib.getProject('fbproj').root, '/from-fallback');
});

test('未注册 ⇒ 明确抛错（与历史消息一致，绝不静默）', () => {
  assert.throws(() => lib.getProject('nope'), /项目未注册: nope/);
});

test('基座不可用（CLI 缺失）⇒ 降级为回退（不抛、不静默返回半截 metadata）', () => {
  const before = process.env.OPENCLAW_TEAM_TASKCTL;
  process.env.OPENCLAW_TEAM_TASKCTL = path.join(stubDir, 'no-such-taskctl');
  try {
    assert.equal(lib.getProject('fbproj').kind, 'docs');
    assert.throws(() => lib.getProject('boardproj'), /项目未注册/);
  } finally {
    process.env.OPENCLAW_TEAM_TASKCTL = before;
  }
});
