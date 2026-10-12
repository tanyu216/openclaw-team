#!/usr/bin/env node
/**
 * claim-guard.test.mjs — 统一领取守卫 + 同卡跨回合锁 测试（反证：同卡双跑被拦 / provider-round 锁）
 *
 * 背景（T-20261009-211234-concurrencyharden）：同卡双跑实证（poll ↔ 直派/异回合）。
 * 本套件不 mock 内部函数：真实 temp 目录 + 真实子进程跑直派 CLI，验证：
 *   1) 直派路径（claim.mjs）领取前查活跃子会话 registry ⇒ 有 ⇒ 不领（active_session）；
 *   2) 同卡跨回合锁：心跳陈旧但锁新鲜 ⇒ 不领（turn_locked）；锁陈旧 ⇒ 清除后恢复；
 *   3) 终态（done）释放跨回合锁 ⇒ 可再次恢复；
 *   4) 复核卡（review_of 非空）dep=被复核卡 ⇒ 豁免（可领），其余 dep 仍生效（T-20261013-000246）。
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

// ---- 复核卡 deps 豁免（T-20261013-000246） ---------------------------------
// 缺陷：复核卡（review_of 非空）自带 depends_on:[被复核卡]，而被复核卡须停在 in_review
// 等验证、永不先 done ⇒ 依赖门（要求 dep=done）恒不可满足 ⇒ 复核卡恒不可领。
// 口径：豁免「dep 恰等于 fm.review_of」的那一项，其余 dep 照旧生效。

test('7. 负例：复核卡 dep=被复核卡（in_review）⇒ 可领（豁免）', () => {
  const reviewed = 'T-20260101-020007-reviewed';
  const review = 'T-20260101-020008-review';
  writeCard(reviewed, { id: reviewed, title: 'impl', assignee: 'jobs', status: 'in_review' });
  writeCard(review, {
    id: review, title: 'review', assignee: 'linus', status: 'ready',
    depends_on: [reviewed], review_of: reviewed,
  });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, true, `复核卡应可领（dep 由 review_of 承载），实际 ${JSON.stringify(r)}`);
  assert.equal(readFm(review).status, 'in_progress');
  assert.equal(readFm(reviewed).status, 'in_review', '被复核卡不应被领取副作用改写');
});

// 收紧（T-20261013-035746）：豁免 ≠ 无条件放行。被复核卡须**已交付**（in_review/done）才豁免；
// 仍 in_progress/ready/blocked ⇒ 拒领（review_unmet），否则复核者可早于交付被 poll 领取、被迫空转。
// 被复核卡不存在（readCard 抛错）⇒ 保持旧行为（不阻塞）+ warning review_of_not_found:<id>。

test('7.1 收紧负例：被复核卡仍 in_progress ⇒ 拒领（review_unmet，附 review_of）', () => {
  const reviewed = 'T-20260101-020016-reviewed';
  const review = 'T-20260101-020017-review';
  writeCard(reviewed, { id: reviewed, title: 'impl', assignee: 'jobs', status: 'in_progress', claimed_by: 'jobs' });
  writeCard(review, {
    id: review, title: 'review', assignee: 'linus', status: 'ready',
    depends_on: [reviewed], review_of: reviewed,
  });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, false, `被复核卡未交付应拒领，实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'review_unmet');
  assert.equal(r.review_of, reviewed, '应附 review_of');
  assert.equal(r.status, 'in_progress', '应附被复核卡实际状态');
  assert.equal(readFm(review).status, 'ready', '拒领不得改写复核卡状态');
});

test('7.2 收紧正例：被复核卡 done ⇒ 可领（豁免）', () => {
  const reviewed = 'T-20260101-020018-reviewed';
  const review = 'T-20260101-020019-review';
  writeCard(reviewed, { id: reviewed, title: 'impl', assignee: 'jobs', status: 'done' });
  writeCard(review, {
    id: review, title: 'review', assignee: 'linus', status: 'ready',
    depends_on: [reviewed], review_of: reviewed,
  });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, true, `被复核卡 done 应可领，实际 ${JSON.stringify(r)}`);
  assert.equal(readFm(review).status, 'in_progress');
});

test('7.3 收紧负例：被复核卡 ready（未交付）⇒ 拒领', () => {
  const reviewed = 'T-20260101-020020-reviewed';
  const review = 'T-20260101-020021-review';
  writeCard(reviewed, { id: reviewed, title: 'impl', assignee: 'jobs', status: 'ready' });
  writeCard(review, {
    id: review, title: 'review', assignee: 'linus', status: 'ready',
    depends_on: [reviewed], review_of: reviewed,
  });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, false, `被复核卡 ready 应拒领，实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'review_unmet');
  assert.equal(r.review_of, reviewed);
});

test('7.4 被复核卡不存在 ⇒ 保持现状（不阻塞）+ warning review_of_not_found', () => {
  const ghost = 'T-20260101-020022-ghost';
  const review = 'T-20260101-020023-review';
  writeCard(review, {
    id: review, title: 'review', assignee: 'linus', status: 'ready',
    depends_on: [ghost], review_of: ghost,
  });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, true, `被复核卡缺失不应阻塞（保持现状），实际 ${JSON.stringify(r)}`);
  assert.ok(Array.isArray(r.warnings), '成功返回应带 warnings 数组');
  assert.ok(r.warnings.includes(`review_of_not_found:${ghost}`), `应记录缺失 warning，实际 ${JSON.stringify(r.warnings)}`);
  assert.equal(readFm(review).status, 'in_progress');
});

test('8. 豁免仅限被复核卡：其余未完成 dep 仍 deps_unmet', () => {
  const reviewed = 'T-20260101-020009-reviewed';
  const other = 'T-20260101-020010-other';
  const review = 'T-20260101-020011-review';
  writeCard(reviewed, { id: reviewed, title: 'impl', assignee: 'jobs', status: 'in_review' });
  writeCard(other, { id: other, title: 'other', assignee: 'jobs', status: 'ready' });
  writeCard(review, {
    id: review, title: 'review', assignee: 'linus', status: 'ready',
    depends_on: [reviewed, other], review_of: reviewed,
  });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, false, `其余 dep 未完成仍应拦，实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'deps_unmet');
  assert.deepEqual(r.deps, [other], '未满足集应只含被豁免项之外的那张');
});

test('9. 正例（既有语义）：普通卡 dep 未完成 ⇒ deps_unmet 不可领', () => {
  const dep = 'T-20260101-020012-dep';
  const card = 'T-20260101-020013-norm';
  writeCard(dep, { id: dep, title: 'dep', assignee: 'jobs', status: 'ready' });
  writeCard(card, { id: card, title: 'norm', assignee: 'linus', status: 'ready', depends_on: [dep] });

  const r = claimCard(card, 'linus');
  assert.equal(r.ok, false, `普通卡 dep 未完成应拦，实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'deps_unmet');
  assert.deepEqual(r.deps, [dep]);

  // dep 完成（done）⇒ 可领（既有语义未破坏）
  taskAcl.setStatus(dep, 'done');
  assert.equal(claimCard(card, 'linus').ok, true);
});

test('10. 无 review_of 时不做任何豁免：dep 即被引用卡也不放行', () => {
  const dep = 'T-20260101-020014-dep';
  const card = 'T-20260101-020015-plain';
  writeCard(dep, { id: dep, title: 'dep', assignee: 'jobs', status: 'in_review' });
  writeCard(card, { id: card, title: 'plain', assignee: 'linus', status: 'ready', depends_on: [dep] });

  const r = claimCard(card, 'linus');
  assert.equal(r.ok, false, `review_of 为空不应豁免，实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'deps_unmet');
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
