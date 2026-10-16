#!/usr/bin/env node
/**
 * main-guard.test.mjs — 回归测试：经符号链接调用 lib.mjs / patrol-scan.mjs 时 main-guard 必须命中。
 *
 * 缺陷背景：旧守卫 `import.meta.url === `file://${process.argv[1]}`` 比较的是
 *   import.meta.url（模块 realpath）与 process.argv[1]（经符号链接调用时为链接路径）
 *   ⇒ 二者不等 ⇒ main-guard 静默 no-op（不报错、无输出），破坏别名/自动化调用。
 * 期望：realpath 归一后，经符号链接调用与经真实路径调用的 stdout **逐字节一致且非空**。
 *
 * 真实 fs + 真实子进程（spawnSync），不 mock 内部函数。运行：node --test scripts/tests/
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 定位携带 ACL 库的 provider 安装目录（与 archive.test.mjs / check-idem.test.mjs 同口径）。 */
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
// lib.mjs / patrol-scan.mjs 均依赖 provider（lib.mjs 缺 provider 时 import 期即 process.exit(1)）：
// 子进程经 run() 继承 process.env ⇒ 此处先注入，缺 provider 则用例如上整体 SKIP。
if (PROVIDER) process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib.mjs');
const PATROL = path.join(HERE, '..', 'patrol-scan.mjs');
const NODE = process.execPath; // 与既有用例一致：用当前 node，避免 PATH 依赖

const scratchDirs = [];
/** 建临时目录（after 递归清理） */
function mkScratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mainguard-'));
  scratchDirs.push(d);
  return d;
}
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 在 dir 下建指向 target 的符号链接，返回链接绝对路径 */
function symlinkTo(dir, alias, target) {
  const link = path.join(dir, alias);
  fs.symlinkSync(target, link);
  return link;
}

/** 真实子进程跑 `node <script> <args...>`，返回 spawnSync 结果 */
function run(script, args, env) {
  return spawnSync(NODE, [script, ...args], {
    env: { ...process.env, ...(env || {}) },
    encoding: 'utf8',
  });
}

test('lib.mjs: 经符号链接调用 get-project 与真实路径调用 stdout 逐字节一致且非空', () => {
  const dir = mkScratch();
  const teamRoot = path.join(dir, 'team');
  fs.mkdirSync(path.join(teamRoot, 'tasks'), { recursive: true }); // 隔离，绝不触碰真实 tasks/
  const link = symlinkTo(dir, 'lib-alias.mjs', LIB);
  const env = { OPENCLAW_TEAM_ROOT: teamRoot };

  const viaLink = run(link, ['get-project', '__team__'], env);
  const viaReal = run(LIB, ['get-project', '__team__'], env);

  assert.equal(viaLink.status, 0, `符号链接调用应 exit 0（旧守卫会静默 no-op），stderr=${viaLink.stderr}`);
  assert.equal(viaReal.status, 0, `真实路径调用应 exit 0，stderr=${viaReal.stderr}`);
  assert.notEqual(String(viaLink.stdout).trim(), '', '符号链接调用 stdout 不得为空（防 no-op 假绿）');
  assert.equal(
    String(viaLink.stdout),
    String(viaReal.stdout),
    '符号链接调用与真实路径调用 stdout 应逐字节一致'
  );
  // 进一步确认 main() 确实执行了（而非两路都空）
  const parsed = JSON.parse(viaReal.stdout);
  assert.equal(parsed.name, '__team__', '真实路径调用应输出 get-project __team__ 的 JSON');
});

test('patrol-scan.mjs: 经符号链接调用与真实路径调用 stdout 逐字节一致且非空（空看板 → {"stale":[]}）', () => {
  const dir = mkScratch();
  const teamRoot = path.join(dir, 'team');
  fs.mkdirSync(path.join(teamRoot, 'tasks'), { recursive: true }); // 内建空 tasks/ ⇒ 输出确定
  const link = symlinkTo(dir, 'patrol-alias.mjs', PATROL);
  const env = { OPENCLAW_TEAM_ROOT: teamRoot };

  const viaLink = run(link, [], env);
  const viaReal = run(PATROL, [], env);

  assert.equal(viaLink.status, 0, `符号链接调用应 exit 0（旧守卫会静默 no-op），stderr=${viaLink.stderr}`);
  assert.equal(viaReal.status, 0, `真实路径调用应 exit 0，stderr=${viaReal.stderr}`);
  assert.notEqual(String(viaLink.stdout).trim(), '', '符号链接调用 stdout 不得为空（防 no-op 假绿）');
  assert.equal(
    String(viaLink.stdout),
    String(viaReal.stdout),
    '符号链接调用与真实路径调用 stdout 应逐字节一致'
  );
  assert.equal(String(viaLink.stdout).trim(), '{"stale":[]}', '空看板应输出 {"stale":[]}');
});
