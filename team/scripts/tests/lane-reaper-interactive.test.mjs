#!/usr/bin/env node
/**
 * lane-reaper-interactive.test.mjs — 交互 lane 的 reaper 加固单测。
 *
 * 覆盖：`--state` 解析/透传、host 死后残留后端清理、host_pid 不匹配时绝不误杀。
 * `lane-reaper.mjs` 静态 import `lib.mjs`（需要 provider ACL），因此本套件同样
 * 在临时部署布局里运行；无 provider ⇒ 全部 SKIP（不误报红）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    path.resolve(import.meta.dirname, '..', '..', 'skills', 'task-ops'),
  ].filter(Boolean);
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, 'lib', 'team-paths.mjs'))) return root;
  }
  return null;
}
const PROVIDER = resolveProviderRoot();
const SKIP = PROVIDER ? false : 'provider ACL library not installed; set OPENCLAW_TASK_OPS_DIR to run';

const LAYOUT = PROVIDER ? (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-reaper-int-'));
  for (const d of ['scripts', 'tasks', 'tasks/.locks', 'workspace', 'skills']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  const SCRIPTS = path.resolve(import.meta.dirname, '..');
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs') || f.endsWith('.json')) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
  }
  fs.symlinkSync(PROVIDER, path.join(root, 'skills', 'task-ops'), 'dir');
  return root;
})() : null;

let parseReaperArgs, cleanupOrphanBackend, armLaneReaper;
const children = [];
if (LAYOUT) {
  process.env.OPENCLAW_TEAM_ROOT = LAYOUT;
  ({ parseReaperArgs, cleanupOrphanBackend, armLaneReaper } = await import(
    pathToFileURL(path.join(LAYOUT, 'scripts', 'lane-reaper.mjs')).href
  ));
}
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } }
  if (LAYOUT) fs.rmSync(LAYOUT, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('--state / state= 解析', { skip: SKIP }, () => {
  assert.equal(parseReaperArgs(['card', 'seg1', '--state', '/tmp/s.json']).state, '/tmp/s.json');
  assert.equal(parseReaperArgs(['card', 'seg1', 'state=/tmp/s.json']).state, '/tmp/s.json');
  assert.equal(parseReaperArgs(['card', 'seg1']).state, '');
});

test('armLaneReaper 透传 state=', { skip: SKIP }, () => {
  const r = armLaneReaper({
    card: 'x', seg: 'seg1', pid: 1, owner: 'linus', stateFile: '/tmp/s.json',
    env: { OPENCLAW_TEAM_REAPER_NODE: '/nonexistent-node-for-test' },
  });
  assert.equal(r.ok, false); // 起不来是预期的：本用例只校验 argv
  assert.ok(r.argv.includes('state=/tmp/s.json'), JSON.stringify(r.argv));
});

test('host 死后清理残留后端（父进程 = 登记的 host）', { skip: SKIP }, async () => {
  const child = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
  child.unref();
  children.push(child);
  const state = path.join(LAYOUT, 'orphan.json');
  fs.writeFileSync(state, JSON.stringify({ v: 1, host_pid: process.pid, backend_pid: child.pid, state: 'running' }));
  const r = await cleanupOrphanBackend({ stateFile: state, hostPid: process.pid });
  assert.equal(r.action, 'killed', JSON.stringify(r));
  await sleep(100);
  assert.equal(alive(child.pid), false);
});

test('host_pid 不匹配 ⇒ noop，不误杀', { skip: SKIP }, async () => {
  const child = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
  child.unref();
  children.push(child);
  const state = path.join(LAYOUT, 'orphan2.json');
  fs.writeFileSync(state, JSON.stringify({ v: 1, host_pid: process.pid + 1, backend_pid: child.pid, state: 'running' }));
  const r = await cleanupOrphanBackend({ stateFile: state, hostPid: process.pid });
  assert.equal(r.action, 'noop');
  assert.equal(r.reason, 'host_pid_mismatch');
  assert.equal(alive(child.pid), true);
});

test('sidecar 缺失 ⇒ noop', { skip: SKIP }, async () => {
  const r = await cleanupOrphanBackend({ stateFile: path.join(LAYOUT, 'nope.json'), hostPid: 1 });
  assert.equal(r.action, 'noop');
  assert.equal(r.reason, 'state_missing');
});
