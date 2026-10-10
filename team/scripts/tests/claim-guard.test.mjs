#!/usr/bin/env node
/**
 * claim-guard.test.mjs — 统一领取守卫 + 同卡跨回合锁 测试（反证：同卡双跑被拦 / provider-round 锁）
 *
 * 背景（T-20261009-211234-concurrencyharden）：同卡双跑实证（poll ↔ 直派/异回合）。
 * 本套件不 mock 内部函数：真实 temp 目录 + 真实子进程跑直派 CLI，验证：
 *   1) 直派路径（claim.mjs）领取前查活跃子会话 registry ⇒ 有 ⇒ 不领（active_session）；
 *   2) 同卡跨回合锁：心跳陈旧但锁新鲜 ⇒ 不领（turn_locked）；锁陈旧 ⇒ 清除后恢复；
 *   3) 终态（done）释放跨回合锁 ⇒ 可再次恢复。
 * 运行：node --test scripts/tests/claim-guard.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// 前置：先设 env，再动态 import（TEAM_ROOT/LOCKS_DIR 于模块加载期读取，import 顺序不可颠倒）
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-claimguard-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
const TASKS = path.join(ROOT, 'tasks');
fs.mkdirSync(path.join(TASKS, '.locks'), { recursive: true });

// provider 依赖为**条件动态 import**：缺 provider 时 lib.mjs 在 import 期即 process.exit(1) 硬红。
let claimCard, readCard, writeCardAtomic, serializeFrontmatter, parseFrontmatter, LOCKS_DIR, STALE_LOCK_MS, refreshHeartbeat, claimGuarded, taskAcl;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  const lib = await import('../lib.mjs');
  ({ claimCard, readCard, writeCardAtomic, serializeFrontmatter, parseFrontmatter, LOCKS_DIR, STALE_LOCK_MS, refreshHeartbeat } = lib);
  ({ claimGuarded } = await import('../claim-guard.mjs'));
  taskAcl = await import(pathToFileURL(path.join(PROVIDER, 'lib', 'task.mjs')).href);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAIM_CLI = path.join(HERE, '..', 'claim.mjs');
const MIN = 60 * 1000;
const OLD = '2020-01-01T00:00:00.000Z';

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const writeCard = (id, fm) => fs.writeFileSync(path.join(TASKS, `${id}.md`), serializeFrontmatter(fm, 'body\n'), 'utf8');
const readFm = (id) => parseFrontmatter(fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8')).fm;
const writeRegistry = (entries) => fs.writeFileSync(path.join(ROOT, 'claude-sessions.json'), JSON.stringify(entries, null, 2), 'utf8');
const turnPath = (id) => path.join(LOCKS_DIR, `${id}.turn`);

const runningEntry = (id, extra = {}) => ({
  task_id: id, owner: 'linus', phase: 'seg1', status: 'running', pid: process.pid, session_id: 'u-guard', ...extra,
});

const staleCardFm = (id, heartbeatAgoMs) => ({
  id, title: 'guard', assignee: 'linus', status: 'in_progress',
  claimed_by: 'linus', claimed_at: OLD, heartbeat_at: new Date(Date.now() - heartbeatAgoMs).toISOString(),
});

// ---- 反证 1：同卡双跑被拦（直派路径查活跃子会话） ---------------------------

test('1. 直派守卫：有活跃子会话（心跳陈旧 45min）⇒ 不领（active_session）', () => {
  const id = 'T-20260101-020001-direct';
  writeCard(id, staleCardFm(id, 45 * MIN));
  writeRegistry([runningEntry(id)]);

  const r = claimGuarded(id, 'linus');
  assert.equal(r.ok, false, `应被拦，实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'active_session');
  assert.ok(String(r.sessions).includes(String(process.pid)), 'sessions 应含存活 pid');

  const fm = readFm(id);
  assert.equal(fm.claimed_at, OLD, 'claimed_at 不应被改写（未越过守卫）');
});

test('2. 直派 CLI（claim.mjs）：有活跃子会话 ⇒ 非零退出 + active_session', () => {
  const id = 'T-20260101-020002-cli';
  writeCard(id, staleCardFm(id, 45 * MIN));
  writeRegistry([runningEntry(id)]);

  const out = spawnSync(process.execPath, [CLAIM_CLI, id, 'linus'], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: ROOT },
    encoding: 'utf8',
  });
  assert.notEqual(out.status, 0, '应非零退出');
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'active_session');
  assert.equal(readFm(id).claimed_at, OLD, '直派 CLI 不应改写 claimed_at');
});

test('3. 直派守卫：无活跃子会话 ⇒ 正常领取', () => {
  const id = 'T-20260101-020003-ok';
  writeCard(id, { id, title: 'guard', assignee: 'linus', status: 'ready', claimed_at: '' });
  writeRegistry([]);

  const r = claimGuarded(id, 'linus');
  assert.equal(r.ok, true, `应领取成功，实际 ${JSON.stringify(r)}`);
  assert.equal(readFm(id).status, 'in_progress');
  assert.equal(readFm(id).claimed_by, 'linus');
});

// ---- 反证 2：provider/round 锁（同卡跨回合锁） ------------------------------

test('4. 跨回合锁：心跳陈旧但锁新鲜 ⇒ 不领（turn_locked）；锁陈旧 ⇒ 清除恢复', () => {
  const id = 'T-20260101-020004-turn';
  writeCard(id, staleCardFm(id, 45 * MIN));

  // 回合 1：陈旧恢复领取 ⇒ 持有跨回合锁
  const c1 = claimCard(id, 'linus');
  assert.equal(c1.ok, true);
  assert.equal(c1.mode, 'recover_same');
  assert.equal(fs.existsSync(turnPath(id)), true, '领取成功应落跨回合锁');

  // 模拟「心跳写坏但锁仍被持有」：直接把心跳改陈旧，不碰锁文件
  const r = readCard(id);
  r.fm.heartbeat_at = new Date(Date.now() - 45 * MIN).toISOString();
  writeCardAtomic(r.cardPath, r.fm, r.body);

  // 回合 2：心跳陈旧（本可恢复）但跨回合锁新鲜 ⇒ 不领
  const c2 = claimCard(id, 'linus');
  assert.equal(c2.ok, false, `应被跨回合锁拦下，实际 ${JSON.stringify(c2)}`);
  assert.equal(c2.reason, 'turn_locked');

  // 锁陈旧 ⇒ 清除后走恢复
  const past = new Date(Date.now() - (STALE_LOCK_MS + 60 * 1000));
  fs.utimesSync(turnPath(id), past, past);
  const c3 = claimCard(id, 'linus');
  assert.equal(c3.ok, true);
  assert.equal(c3.mode, 'recover_same');
});

test('5. 心跳续锁：refreshHeartbeat 刷新跨回合锁（心跳新鲜 ⇒ 锁新鲜）', () => {
  const id = 'T-20260101-020005-hb';
  writeCard(id, { id, title: 'hb', assignee: 'linus', status: 'in_progress', claimed_by: 'linus', claimed_at: OLD, heartbeat_at: OLD });
  // 领（恢复）落锁
  assert.equal(claimCard(id, 'linus').ok, true);
  const before = fs.statSync(turnPath(id)).mtimeMs;
  // 心跳刷新 ⇒ 锁 mtime 也应刷新（非倒退）
  const hb = refreshHeartbeat(path.join(TASKS, `${id}.md`), 'linus');
  assert.equal(hb.ok, true);
  const afterMs = fs.statSync(turnPath(id)).mtimeMs;
  assert.ok(afterMs >= before, '心跳刷新应续锁（mtime 不早于前值）');
});

test('6. 终态（done）释放跨回合锁 ⇒ 后续可恢复', () => {
  const id = 'T-20260101-020006-release';
  writeCard(id, staleCardFm(id, 45 * MIN));
  assert.equal(claimCard(id, 'linus').ok, true);
  assert.equal(fs.existsSync(turnPath(id)), true);

  const s = taskAcl.setStatus(id, 'done');
  assert.equal(s.ok, true);
  assert.equal(fs.existsSync(turnPath(id)), false, 'done 应释放跨回合锁');

  // 收口后：改回 in_progress + 心跳陈旧 ⇒ 可再次恢复（无锁拦）
  const r = readCard(id);
  r.fm.status = 'in_progress';
  r.fm.heartbeat_at = new Date(Date.now() - 45 * MIN).toISOString();
  writeCardAtomic(r.cardPath, r.fm, r.body);
  const again = claimCard(id, 'linus');
  assert.equal(again.ok, true, `done 释放锁后应可恢复，实际 ${JSON.stringify(again)}`);
  assert.equal(again.mode, 'recover_same');
});
