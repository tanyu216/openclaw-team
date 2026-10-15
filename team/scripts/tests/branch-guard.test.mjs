#!/usr/bin/env node
/**
 * branch-guard.test.mjs — 提交侧分支守卫（T-20261015-devbranch）
 *
 * 红（反证）：`scripts/branch-guard.mjs` 不存在 ⇒ import 失败（模块缺失即红）。
 * 绿：开发集成在 `dev` 上（`PROTOCOL §⑥.4`）——lane 提交落在 `lane/*`、`dev` 上放行；
 *   **直接提交受保护分支（缺省 `main`）被拒**；detached HEAD 被拒；`--allow-protected` 放行为
 *   告警 + `overridden:true`（`dev→main` 集成步骤的显式出口）；自定义受保护集；
 *   非 git 仓被拒；CLI 末行 JSON 契约与退出码 0/1/2。
 *
 * 隔离：全部跑在 `os.tmpdir()` 下的临时 git 仓；只读该仓，不触网/不碰真实仓。
 * 运行：node --test scripts/tests/branch-guard.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.join(HERE, '..', 'branch-guard.mjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-branchguard-'));
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

let seq = 0;
/** 建一个含 `main` + `dev` + `lane/x` 的临时仓，并停在 `dev` 上。 */
function makeRepo(name = `repo${++seq}`) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')} 失败: ${r.stderr}`);
    return r.stdout.trim();
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  g('add', '--', 'README.md');
  g('commit', '-q', '-m', 'init');
  g('branch', 'dev');
  g('branch', 'lane/x');
  return { dir, g };
}

const mod = await import(MOD.url ?? MOD);
const { runCheck, parseArgs, protectedSet, PROTECTED_ENV } = mod;

// ── 契约：参数与受保护集解析 ────────────────────────────────────────────────

test('契约. parseArgs：--repo/--protected/--allow-protected/--json；未知参数与缺值报错', () => {
  const a = parseArgs(['--repo', '/r', '--protected', 'main,release', '--allow-protected', '--json']);
  assert.equal(a.repo, '/r');
  assert.deepEqual(a.protected, ['main', 'release']);
  assert.equal(a.allowProtected, true);
  assert.equal(a.json, true);
  assert.equal(parseArgs(['--nope']).error, 'unknown_arg:--nope');
  assert.equal(parseArgs(['--repo']).error, 'missing_value:--repo');
});

test('契约. protectedSet：CLI > env > 缺省 main', () => {
  assert.deepEqual(protectedSet({ protected: ['a'] }, {}), ['a'], 'CLI 最优先');
  assert.deepEqual(protectedSet({ protected: [] }, { [PROTECTED_ENV]: 'dev, release' }), ['dev', 'release'], 'env 逗号分隔并 trim');
  assert.deepEqual(protectedSet({ protected: [] }, {}), ['main'], '缺省 main');
});

// ── 放行 / 拒绝 ────────────────────────────────────────────────────────────

test('GREEN. dev 与 lane/* 上的提交放行（开发集成在 dev 上，lane 提交不在 dev 上）', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', 'dev');
  const onDev = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(onDev.ok, true, JSON.stringify(onDev));
  assert.equal(onDev.branch, 'dev');
  assert.equal(onDev.overridden, false);

  g('checkout', '-q', 'lane/x');
  const onLane = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(onLane.ok, true, JSON.stringify(onLane));
  assert.equal(onLane.branch, 'lane/x');
});

test('REJECT. 受保护分支（缺省 main）⇒ 拒绝，且点名分支（不是「只许 dev」）', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', 'main');
  const r = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'protected_branch_commit:main');
  assert.equal(r.branch, 'main');
  assert.deepEqual(r.protected, ['main']);
});

test('REJECT. detached HEAD ⇒ 拒绝（开发须落在具名分支上）', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', '--detach', 'HEAD');
  const r = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'detached_head_commit');
});

test('OVERRIDE. --allow-protected ⇒ 放行 + overridden:true（dev→main 集成步骤的显式出口）', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', 'main');
  const r = runCheck({ repo: dir, protected: [], allowProtected: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.branch, 'main');
  assert.equal(r.overridden, true, 'override 必须可见（留痕）');
});

test('GREEN. --protected 自定义受保护集：换掉 main ⇒ main 放行、新集被拒', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', 'main');
  const free = runCheck({ repo: dir, protected: ['release'], allowProtected: false });
  assert.equal(free.ok, true, 'main 不在自定义集 ⇒ 放行');

  g('checkout', '-q', 'dev');
  const blocked = runCheck({ repo: dir, protected: ['release', 'dev'], allowProtected: false });
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.reason, 'protected_branch_commit:dev');
});

test('REJECT. 非 git 仓 ⇒ not_a_git_repo', () => {
  const plain = path.join(ROOT, 'notarepo');
  fs.mkdirSync(plain, { recursive: true });
  const r = runCheck({ repo: plain, protected: [], allowProtected: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_a_git_repo');
});

// ── CLI：末行 JSON 契约 + 退出码 ───────────────────────────────────────────

test('CLI. 末行 JSON {ok,branch,...}；通过 0 / 违规 1 / 用法 2', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', 'dev');
  const ok = spawnSync(process.execPath, [MOD, '--repo', dir, '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const j = JSON.parse(ok.stdout.trim().split('\n').pop());
  assert.equal(j.ok, true);
  assert.equal(j.branch, 'dev');

  g('checkout', '-q', 'main');
  const bad = spawnSync(process.execPath, [MOD, '--repo', dir, '--json'], { encoding: 'utf8' });
  assert.equal(bad.status, 1, '受保护分支 ⇒ 1');
  assert.equal(JSON.parse(bad.stdout.trim().split('\n').pop()).ok, false);

  const usage = spawnSync(process.execPath, [MOD, '--nope'], { encoding: 'utf8' });
  assert.equal(usage.status, 2, '用法错误 ⇒ 2');
});
