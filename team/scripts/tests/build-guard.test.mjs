#!/usr/bin/env node
/**
 * build-guard.test.mjs — 构建-写互斥测试（build 锁串行 + dirty worktree 检测）
 *
 * 背景（T-20261009-211234-concurrencyharden）：整树快照类构建与其它 lane 写并发 ⇒ 假失败。
 * 本套件用真实临时目录验证 build 锁的 acquire/release/陈旧恢复 + dirty 检测（真实 git 仓库）。
 * 运行：node --test scripts/tests/build-guard.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 定位携带 ACL 库的 provider 安装目录（与 archive.test.mjs / check-idem.test.mjs 同口径）。 */
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

// 前置：先设 env，再动态 import（LOCKS_DIR 于模块加载期读取）
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-build-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
const LOCK_ROOT = path.join(ROOT, 'tasks', '.locks');

// provider 依赖为**条件动态 import**：缺 provider 时 lib.mjs 在 import 期即 process.exit(1) 硬红。
let acquire, release, detect, LOCKS_DIR, STALE_LOCK_MS;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ acquire, release, detect } = await import('../build-guard.mjs'));
  ({ LOCKS_DIR, STALE_LOCK_MS } = await import('../lib.mjs'));
}

const repos = [];
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); for (const d of repos) fs.rmSync(d, { recursive: true, force: true }); });

test('1. acquire 抢锁 / 二抢 busy / release 后重抢成功', () => {
  const a = acquire({ name: 't1' });
  assert.equal(a.ok, true);
  assert.equal(a.held, true);

  const b = acquire({ name: 't1' });
  assert.equal(b.ok, true);
  assert.equal(b.held, false, '同锁应 busy');

  const rel = release({ name: 't1' });
  assert.equal(rel.released, true);

  const c = acquire({ name: 't1' });
  assert.equal(c.held, true, '释放后应可重抢');
  release({ name: 't1' });
});

test('2. 陈旧锁（>STALE_LOCK_MS）⇒ 清理后重抢（recovered_stale）', () => {
  // 手工造一把陈旧 build 锁（不 mock：直接造锁目录并回拨 mtime）
  const dir = path.join(LOCKS_DIR, 'build.stale');
  fs.mkdirSync(LOCKS_DIR, { recursive: true });
  fs.mkdirSync(dir);
  const past = new Date(Date.now() - (STALE_LOCK_MS + 60 * 1000));
  fs.utimesSync(dir, past, past);

  const a = acquire({ name: 'stale' });
  assert.equal(a.ok, true);
  assert.equal(a.held, true, '陈旧锁应被清理后重抢');
  assert.equal(a.recovered_stale, true);
  release({ name: 'stale' });
});

test('3. detect：dirty worktree（并发写信号）⇒ 报出；clean ⇒ 空', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-build-repo-'));
  repos.push(repo);
  execFileSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf8' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@e.c'], { encoding: 'utf8' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'T'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'x.txt'), 'x1\n');
  execFileSync('git', ['-C', repo, 'add', 'x.txt'], { encoding: 'utf8' });

  const dirty = detect({ repo });
  assert.equal(dirty.ok, true);
  assert.ok(dirty.dirtyCount > 0, `应检出 dirty，实际 ${JSON.stringify(dirty)}`);

  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'c'], { encoding: 'utf8' });
  const clean = detect({ repo });
  assert.equal(clean.ok, true);
  assert.equal(clean.dirtyCount, 0, `提交后应 clean，实际 ${JSON.stringify(clean)}`);
});

test('4. detect：非 git 仓库 ⇒ not_a_git_repo', () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-build-notrepo-'));
  repos.push(notRepo);
  assert.equal(detect({ repo: notRepo }).reason, 'not_a_git_repo');
});

// 确保测试结束无锁残留（清理顺序在 after；此处显式释放锁根目录便于断言）
test('5. release 不存在锁 ⇒ released:false（幂等，不抛）', () => {
  const r = release({ name: 'never-held' });
  assert.equal(r.ok, true);
  assert.equal(r.released, false);
});
