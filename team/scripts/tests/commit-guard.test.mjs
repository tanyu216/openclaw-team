#!/usr/bin/env node
/**
 * commit-guard.test.mjs — 提交自检测试（反证：异卡 hunk 自检触发）
 *
 * 背景（T-20261009-211234-concurrencyharden）：`git commit -- <path>` 连带扫入同文件异卡未暂存
 * hunk（952a001）。本套件用真实临时 git 仓库 + 真实子进程跑 commit-guard CLI，验证：
 *   1) 暂存集含异卡文件 ⇒ 停手（foreign 报出，非零退出）；
 *   2) 本卡文件有未暂存 hunk ⇒ 停手（mixed 报出）；--allow-mixed 降级为告警；
 *   3) --mode last 校验最近一次提交的文件集。
 * 运行：node --test scripts/tests/commit-guard.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, '..', 'commit-guard.mjs');
const repos = [];
after(() => { for (const d of repos) fs.rmSync(d, { recursive: true, force: true }); });

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

function initRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-commit-'));
  repos.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  return repo;
}

function runGuard(repo, ...args) {
  return spawnSync(process.execPath, [GUARD, '--repo', repo, ...args], { encoding: 'utf8' });
}
const parse = (out) => JSON.parse(out.stdout);

test('1. 暂存集只含本卡文件 ⇒ 通过（ok:true）', () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b1\n');
  git(repo, 'add', 'a.txt');

  const r = runGuard(repo, '--allowed', 'a.txt');
  const j = parse(r);
  assert.equal(r.status, 0, `应通过，实际 ${JSON.stringify(j)}`);
  assert.equal(j.ok, true);
  assert.deepEqual(j.foreign, []);
});

test('2. 暂存集含异卡文件 ⇒ 停手（foreign 报出，非零退出）', () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b1\n');
  git(repo, 'add', 'a.txt', 'b.txt');

  const r = runGuard(repo, '--allowed', 'a.txt');
  const j = parse(r);
  assert.notEqual(r.status, 0, '应非零退出');
  assert.equal(j.ok, false);
  assert.deepEqual(j.foreign, ['b.txt'], '异卡文件应被报出');
  assert.ok(j.message.includes('停手'));
});

test('3. 本卡文件有未暂存 hunk ⇒ 停手（mixed）；--allow-mixed 降级告警', () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\n');
  git(repo, 'add', 'a.txt');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a2 异卡 hunk\n'); // 暂存后又有未暂存改动

  const r1 = runGuard(repo, '--allowed', 'a.txt');
  const j1 = parse(r1);
  assert.notEqual(r1.status, 0, '默认应停手');
  assert.equal(j1.ok, false);
  assert.deepEqual(j1.mixed, ['a.txt'], '同文件未暂存 hunk 应报出');

  const r2 = runGuard(repo, '--allowed', 'a.txt', '--allow-mixed');
  const j2 = parse(r2);
  assert.equal(r2.status, 0, '--allow-mixed 应放行');
  assert.equal(j2.ok, true);
  assert.deepEqual(j2.mixed, ['a.txt']);
  assert.ok(j2.message.includes('告警'));
});

test('4. --mode last：校验最近一次提交的文件集', () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b1\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'c1');

  const ok = runGuard(repo, '--mode', 'last', '--allowed', 'a.txt');
  assert.equal(parse(ok).ok, true);

  const bad = runGuard(repo, '--mode', 'last', '--allowed', 'other.txt');
  const jb = parse(bad);
  assert.equal(jb.ok, false);
  assert.deepEqual(jb.foreign, ['a.txt'], '提交中的文件应被识别为异卡文件');
});

test('5. 非 git 仓库 / 缺白名单 ⇒ 明确报错', () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-notrepo-'));
  repos.push(notRepo);
  const r1 = runGuard(notRepo, '--allowed', 'x');
  assert.equal(parse(r1).reason, 'not_a_git_repo');

  const repo = initRepo();
  const r2 = runGuard(repo);
  assert.equal(parse(r2).reason, 'missing_allowed');
});
