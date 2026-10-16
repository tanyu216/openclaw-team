#!/usr/bin/env node
/**
 * claim-guard.test.mjs — 统一领取守卫 + 同卡跨回合锁 测试（反证：同卡双跑被拦 / provider-round 锁）
 *
 * 背景（T-20261009-211234-concurrencyharden）：同卡双跑实证（poll ↔ 直派/异回合）。
 * 本套件不 mock 内部函数：真实 temp 目录 + 真实子进程跑直派 CLI，验证：
 *   1) 直派路径（claim.mjs）领取前查活跃子会话 registry ⇒ 有 ⇒ 不领（active_session）；
 *   2) 同卡跨回合锁：心跳陈旧但锁新鲜 ⇒ 不领（turn_locked）；锁陈旧 ⇒ 清除后恢复；
 *   3) 终态（done）释放跨回合锁 ⇒ 可再次恢复；
 *   4) 复核卡（review_of 非空）dep=被复核卡 ⇒ 豁免（可领），其余 dep 仍生效（T-20261013-000246）；
 *   5) 复核门上界：复核卡仅在被复核卡**存在且 in_review** 时可领，否则 review_not_ready 拒领
 *      （T-20261013-233052；与 dep 是否显式列出被复核卡无关）。
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

// 收紧（T-20261013-233052，收编 T-20261013-035746 的更窄口径）：复核卡的可领性**只看被复核卡状态**——
// 目标须存在且 `status=in_review`（已交付、待验证）；其余一律拒领 `review_not_ready`（附 review_of +
// 目标实际 status）。本口径取代 035746 的「in_review/done 皆可」与「目标缺失不阻塞 + warning」两条旧行为：
//   · 目标 ∈ {ready,todo,in_progress,blocked} ⇒ 拒（早领 = 空跑；实证 T-20261013-232004-2 于
//     2026-10-13T15:25:08Z 被 poll 领取时被复核卡仍 in_progress ⇒ triage 置 blocked）；
//   · 目标 done/canceled/failed ⇒ 拒（验收/终止已发生，复核已无标的，应由 Elon 直接收口而非领取空转）；
//   · 目标不存在 ⇒ 拒（失去验证对象的复核卡只会空跑；旧口径不阻塞 + `review_of_not_found` warning）。
// 注：与 dep 是否显式列出被复核卡**无关**（旧口径只在 dep 命中豁免分支时才校验目标状态）。

test('7.1 收紧负例：被复核卡仍 in_progress ⇒ 拒领（review_not_ready，附 review_of）', () => {
  const reviewed = 'T-20260101-020016-reviewed';
  const review = 'T-20260101-020017-review';
  writeCard(reviewed, { id: reviewed, title: 'impl', assignee: 'jobs', status: 'in_progress', claimed_by: 'jobs' });
  writeCard(review, {
    id: review, title: 'review', assignee: 'linus', status: 'ready',
    depends_on: [reviewed], review_of: reviewed,
  });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, false, `被复核卡未交付应拒领，实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'review_not_ready');
  assert.equal(r.review_of, reviewed, '应附 review_of');
  assert.equal(r.status, 'in_progress', '应附被复核卡实际状态');
  assert.equal(readFm(review).status, 'ready', '拒领不得改写复核卡状态');
});

test('7.2 收紧负例：被复核卡 done ⇒ 拒领（验收已发生，复核无标的）', () => {
  const reviewed = 'T-20260101-020018-reviewed';
  const review = 'T-20260101-020019-review';
  writeCard(reviewed, { id: reviewed, title: 'impl', assignee: 'jobs', status: 'done' });
  writeCard(review, {
    id: review, title: 'review', assignee: 'linus', status: 'ready',
    depends_on: [reviewed], review_of: reviewed,
  });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, false, `被复核卡已 done 应拒领（复核已无标的），实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'review_not_ready');
  assert.equal(r.status, 'done', '应附被复核卡实际状态');
  assert.equal(readFm(review).status, 'ready', '拒领不得改写复核卡状态');
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
  assert.equal(r.reason, 'review_not_ready');
  assert.equal(r.review_of, reviewed);
});

test('7.4 被复核卡不存在 ⇒ 拒领（review_not_ready，status=null）', () => {
  const ghost = 'T-20260101-020022-ghost';
  const review = 'T-20260101-020023-review';
  writeCard(review, {
    id: review, title: 'review', assignee: 'linus', status: 'ready',
    depends_on: [ghost], review_of: ghost,
  });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, false, `被复核卡缺失应拒领（失去验证对象），实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'review_not_ready');
  assert.equal(r.review_of, ghost);
  assert.equal(r.status, null, '目标不可读 ⇒ status=null');
  assert.equal(readFm(review).status, 'ready', '拒领不得改写复核卡状态');
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

// ---- 复核门上界（T-20261013-233052）：与 dep 是否列出被复核卡无关 ------------
// 000246 的豁免只解除「dep=被复核卡」的 done 门，**未**对复核卡本身设上界 ⇒ 复核卡可在被复核卡
// 未 in_review 时被 poll 领取（实证 T-20261013-232004-2，见上）。下列用例覆盖「复核卡不写
// depends_on」这一最常见形态（建卡模板不鼓励复核卡带 dep），确认上界不依赖 dep 分支。

test('11. 负例（本卡主症）：复核卡无 dep，被复核卡仍 in_progress ⇒ 拒领 review_not_ready', () => {
  const reviewed = 'T-20260101-020030-reviewed';
  const review = 'T-20260101-020031-review';
  writeCard(reviewed, { id: reviewed, title: 'impl', assignee: 'jobs', status: 'in_progress', claimed_by: 'jobs' });
  writeCard(review, { id: review, title: 'review', assignee: 'linus', status: 'ready', review_of: reviewed });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, false, `被复核卡未交付应拒领（旧口径会放行 ⇒ 空跑），实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'review_not_ready');
  assert.equal(r.review_of, reviewed);
  assert.equal(r.status, 'in_progress');
  assert.equal(readFm(review).status, 'ready', '拒领不得改写复核卡状态');
});

test('11.1 正例：复核卡无 dep，被复核卡 in_review ⇒ 可领（负例红→绿）', () => {
  const reviewed = 'T-20260101-020032-reviewed';
  const review = 'T-20260101-020033-review';
  writeCard(reviewed, { id: reviewed, title: 'impl', assignee: 'jobs', status: 'in_review' });
  writeCard(review, { id: review, title: 'review', assignee: 'linus', status: 'ready', review_of: reviewed });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, true, `被复核卡 in_review 应可领，实际 ${JSON.stringify(r)}`);
  assert.equal(readFm(review).status, 'in_progress');
  assert.equal(readFm(reviewed).status, 'in_review', '被复核卡不应被领取副作用改写');
});

test('11.2 负例表：目标 ready/blocked/canceled/failed ⇒ 均拒领 review_not_ready', () => {
  const table = [
    ['ready', 'T-20260101-020040-revd', 'T-20260101-020041-revw'],
    ['blocked', 'T-20260101-020042-revd', 'T-20260101-020043-revw'],
    ['canceled', 'T-20260101-020044-revd', 'T-20260101-020045-revw'],
    ['failed', 'T-20260101-020046-revd', 'T-20260101-020047-revw'],
  ];
  for (const [st, reviewed, review] of table) {
    writeCard(reviewed, { id: reviewed, title: 'impl', assignee: 'jobs', status: st });
    writeCard(review, { id: review, title: 'review', assignee: 'linus', status: 'ready', review_of: reviewed });

    const r = claimCard(review, 'linus');
    assert.equal(r.ok, false, `目标 ${st} 应拒领，实际 ${JSON.stringify(r)}`);
    assert.equal(r.reason, 'review_not_ready', `目标 ${st} 的 reason`);
    assert.equal(r.status, st, `目标 ${st} 应回显实际状态`);
  }
});

test('11.3 负例：被复核卡不存在且复核卡无 dep ⇒ 拒领（不因无 dep 分支而放行）', () => {
  const ghost = 'T-20260101-020034-ghost';
  const review = 'T-20260101-020035-review';
  writeCard(review, { id: review, title: 'review', assignee: 'linus', status: 'ready', review_of: ghost });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, false, `目标缺失应拒领，实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'review_not_ready');
  assert.equal(r.status, null);
});

test('11.4 上界通过后其余 dep 照旧：目标 in_review + 另一 dep 未完成 ⇒ deps_unmet', () => {
  const reviewed = 'T-20260101-020036-reviewed';
  const other = 'T-20260101-020037-other';
  const review = 'T-20260101-020038-review';
  writeCard(reviewed, { id: reviewed, title: 'impl', assignee: 'jobs', status: 'in_review' });
  writeCard(other, { id: other, title: 'other', assignee: 'jobs', status: 'ready' });
  writeCard(review, {
    id: review, title: 'review', assignee: 'linus', status: 'ready',
    depends_on: [other], review_of: reviewed,
  });

  const r = claimCard(review, 'linus');
  assert.equal(r.ok, false, `其余 dep 未完成仍应拦，实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'deps_unmet', '上界通过后走既有 deps 门（不被复核门遮蔽）');
  assert.deepEqual(r.deps, [other]);
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

// ---- 状态归一：todo（规范值）| ready（兼容别名）同视为 new（T-20261014-204530）----------
// 缺陷：claimCard 原判据是**字面量** `status === 'ready'`，未做状态归一；而规范词表
// （skills/task-ops/lib/task.mjs：CANONICAL_STATUSES 含 `todo`，`ready` 仅 STATUS_ALIASES 别名）
// 明示 `todo` 才是规范值 ⇒ 卡被 Elon 送回为 `todo`（in_review|blocked|in_review → todo）后 claim
// 静默 `status=todo` 拒领（换人/换脚本即卡死）。修复仅归一 new 档位（todo|ready），不引入第三种语义。
// 下列四组：① todo 可领 ② ready 仍可领（兼容不回退）③ backlog 仍拒 ④ 其余守卫（epic/deps_unmet/
// wrong_assignee/in_progress_fresh/turn_locked）仍拒（证明未放宽）。

test('12. 状态归一①：`todo`（规范值）卡可领 ⇒ mode=new, status→in_progress', () => {
  const id = 'T-20260101-020050-todo';
  writeCard(id, { id, title: 'todo claimable', assignee: 'linus', status: 'todo' });

  const r = claimCard(id, 'linus');
  assert.equal(r.ok, true, `todo 卡应可领（规范化前为 status=todo 拒领），实际 ${JSON.stringify(r)}`);
  assert.equal(r.mode, 'new', 'todo 与 ready 同档 ⇒ 应走 new');
  assert.equal(readFm(id).status, 'in_progress');
  assert.equal(readFm(id).claimed_by, 'linus');
});

test('12.1 状态归一②：`ready`（兼容别名）卡仍可领（兼容不回退）', () => {
  const id = 'T-20260101-020051-ready';
  writeCard(id, { id, title: 'ready claimable', assignee: 'linus', status: 'ready' });

  const r = claimCard(id, 'linus');
  assert.equal(r.ok, true, `ready 卡应可领（既有行为不得回退），实际 ${JSON.stringify(r)}`);
  assert.equal(r.mode, 'new');
  assert.equal(readFm(id).status, 'in_progress');
});

test('12.2 状态归一③负向：`backlog`（未排期）仍不可领 ⇒ status=backlog', () => {
  const id = 'T-20260101-020052-backlog';
  writeCard(id, { id, title: 'backlog not claimable', assignee: 'linus', status: 'backlog' });

  const r = claimCard(id, 'linus');
  assert.equal(r.ok, false, `backlog 不在 new 档，应仍拒领，实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'status=backlog');
  assert.equal(readFm(id).status, 'backlog', '拒领不得改写状态');
});

test('12.3 状态归一④负向：其余守卫逐条仍拒（epic/deps_unmet/wrong_assignee/in_progress_fresh/turn_locked）', () => {
  // epic 容器：不可领
  {
    const id = 'T-20260101-020053-epic';
    writeCard(id, { id, title: 'epic', assignee: 'linus', status: 'todo', kind: 'epic' });
    const r = claimCard(id, 'linus');
    assert.equal(r.ok, false, `epic 容器应仍拒，实际 ${JSON.stringify(r)}`);
    assert.equal(r.reason, 'epic_container');
  }
  // deps_unmet：前置未 done
  {
    const dep = 'T-20260101-020054-dep';
    const id = 'T-20260101-020055-depsum';
    writeCard(dep, { id: dep, title: 'dep', assignee: 'jobs', status: 'todo' });
    writeCard(id, { id, title: 'card', assignee: 'linus', status: 'todo', depends_on: [dep] });
    const r = claimCard(id, 'linus');
    assert.equal(r.ok, false, `前置未完成应仍拒，实际 ${JSON.stringify(r)}`);
    assert.equal(r.reason, 'deps_unmet');
    assert.deepEqual(r.deps, [dep]);
  }
  // wrong_assignee：assignee 不匹配（即便 status=todo）
  {
    const id = 'T-20260101-020056-wrong';
    writeCard(id, { id, title: 'card', assignee: 'jobs', status: 'todo' });
    const r = claimCard(id, 'linus');
    assert.equal(r.ok, false, `assignee 不匹配应仍拒，实际 ${JSON.stringify(r)}`);
    assert.equal(r.reason, 'wrong_assignee(assignee=jobs)');
  }
  // in_progress_fresh：心跳新鲜仍拒（执行唯一性）
  {
    const id = 'T-20260101-020057-fresh';
    writeCard(id, {
      id, title: 'card', assignee: 'linus', status: 'in_progress',
      claimed_by: 'linus', claimed_at: OLD, heartbeat_at: new Date().toISOString(),
    });
    const r = claimCard(id, 'linus');
    assert.equal(r.ok, false, `心跳新鲜应仍拒，实际 ${JSON.stringify(r)}`);
    assert.equal(r.reason, 'in_progress_fresh');
  }
  // turn_locked：心跳陈旧但跨回合锁新鲜仍拒（同卡跨回合互斥）
  {
    const id = 'T-20260101-020058-turnlock';
    writeCard(id, staleCardFm(id, 45 * MIN));
    assert.equal(claimCard(id, 'linus').ok, true, '先恢复领取以落跨回合锁');
    const rr = readCard(id);
    rr.fm.heartbeat_at = new Date(Date.now() - 45 * MIN).toISOString();
    writeCardAtomic(rr.cardPath, rr.fm, rr.body);
    const r = claimCard(id, 'linus');
    assert.equal(r.ok, false, `跨回合锁新鲜应仍拒，实际 ${JSON.stringify(r)}`);
    assert.equal(r.reason, 'turn_locked');
  }
});
