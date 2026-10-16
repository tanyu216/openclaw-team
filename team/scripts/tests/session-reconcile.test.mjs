#!/usr/bin/env node
/**
 * session-reconcile.test.mjs — ④「历史对账：清单 + 归口 + 可修者非破坏修复」测试
 *
 * 背景（T-20261015-045724）：`check-sessions` 的 note（mismatch 类）只会越积越多，没人有工具收口。
 * 本套件锁定 `session-reconcile.mjs` 的契约：
 *   · 清单复用 `checkSessions()`（同一判据，不另写扫描）；
 *   · 归口三档：`fixable`（pid 已死的登记漂移）/ `manual`（活 pid 矛盾、硬失败）/ `immutable`
 *     （`duplicate_lane` 历史重复行 = 审计痕迹，只保不改）；
 *   · `--apply` 只动 fixable，走 ACL 两侧同写，**逐条台账 + 逐条留痕**；默认零写；
 *   · 非破坏：`manual`/`immutable` 项一字不改；fixable 只把 running 行改成 registry 已宣告的终态。
 *
 * 运行：node --test team/scripts/tests/session-reconcile.test.mjs
 */
import { test as nodeTest, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 定位携带 ACL 库的 provider 安装目录（与 check-sessions.test.mjs 同口径）。 */
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sessrec-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
const TASKS = path.join(ROOT, 'tasks');
const WS = path.join(ROOT, 'workspace');
fs.mkdirSync(TASKS, { recursive: true });
fs.mkdirSync(WS, { recursive: true });

let reconcileSessions, classifyItem, lifecycle;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ reconcileSessions, classifyItem } = await import('../session-reconcile.mjs'));
  lifecycle = await import('../session-lifecycle.mjs');
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
  fs.rmSync(path.join(ROOT, 'claude-sessions.json'), { force: true });
});

const DEAD = 999999;
const SID = '11111111-2222-3333-4444-555555555555';
const SID2 = '22222222-3333-4444-5555-666666666666';
const line = (seg, status, sid, pid) =>
  `- seg:${seg} · owner:linus · backend:claude · id:${sid} · phase:${seg} · status:${status} · pid:${pid} · 2026-01-01T00:00:00.000Z`;

function writeCard(id, { status = 'in_progress', segs = [] } = {}) {
  const body = `## Background\nx\n## Acceptance\n- [ ] a\n## Progress\n## Comments\n## Sessions\n${segs.join('\n')}\n## Report\n`;
  fs.writeFileSync(path.join(TASKS, `${id}.md`), `---\nid: ${id}\ntitle: rec\nassignee: linus\nstatus: ${status}\nproject: __team__\n---\n${body}`);
}
const writeRegistry = (entries) => fs.writeFileSync(path.join(ROOT, 'claude-sessions.json'), JSON.stringify(entries, null, 2));
const cardRaw = (id) => fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8');
const rowOf = (id, seg = 'seg1') => lifecycle.parseSessionRows(cardRaw(id)).find((r) => r.seg === seg);
const entry = (taskId, sid, status, pid = DEAD) => ({ task_id: taskId, owner: 'linus', phase: 'seg1', status, pid, session_id: sid, startedAt: 'x' });

// ── 归口：三档判据 ──────────────────────────────────────────────────────────

test('1. 归口 fixable：卡行 running（pid 死）+ registry done ⇒ 按 registry 事实收口卡行', { skip: SKIP }, async () => {
  const id = 'T-20260101-070001-fixable';
  writeCard(id, { segs: [line('seg1', 'running', SID, DEAD)] });
  writeRegistry([entry(id, SID, 'done')]);

  const out = await reconcileSessions({ apply: false });
  const it = out.classified.find((c) => c.task === id);
  assert.equal(it.class, 'fixable', JSON.stringify(it));
  assert.equal(it.action, 'close_card_row');
  assert.equal(it.status, 'done', '采用 registry 已宣告的终态，不发明状态');
  assert.equal(out.counts.applied, 0, '未 --apply ⇒ 零写');
  assert.equal(rowOf(id).status, 'running', '默认零写：卡行不得变');
});

test('2. 归口 manual：卡行 pid **存活**而 registry 终态 ⇒ 活进程与终态互斥，不代判', { skip: SKIP }, () => {
  const id = 'T-20260101-070002-manual';
  writeCard(id, { segs: [line('seg1', 'running', SID, process.pid)] }); // 真活 pid
  writeRegistry([entry(id, SID, 'done', process.pid)]);
  const it = classifyItem({ type: 'status_mismatch', task: id, session: SID, card: 'running', registry: 'done' });
  assert.equal(it.class, 'manual', JSON.stringify(it));
  assert.match(it.why, /存活/);
  // 硬失败（spawn 漏写面）同样只归口，不代判
  const hard = classifyItem({ type: 'registry_only', task: id, session: SID, pid: process.pid });
  assert.equal(hard.class, 'manual');
  assert.match(hard.why, /硬失败/);
});

test('3. 归口 immutable：duplicate_lane 历史重复行 ⇒ 只保不改（审计痕迹）', { skip: SKIP }, () => {
  const it = classifyItem({ type: 'duplicate_lane', task: 'T-1', session: SID, rows: [] });
  assert.equal(it.class, 'immutable');
  assert.equal(it.action, 'keep');
});

// ── 修复：--apply 只动 fixable，其余一字不改 ─────────────────────────────────

test('4. --apply：可修项两侧收口（卡行 done + 清 active_session_id + registry done）+ 台账 + 留痕', { skip: SKIP }, async () => {
  const id = 'T-20260101-070004-apply';
  writeCard(id, { segs: [line('seg1', 'running', SID, DEAD)] });
  writeRegistry([entry(id, SID, 'done')]);
  const ledger = path.join(WS, 'ledger.json');

  const out = await reconcileSessions({ apply: true, ledger });

  assert.equal(out.counts.fixable, 1, JSON.stringify(out.counts));
  assert.equal(out.counts.applied, 1, JSON.stringify(out.counts));
  assert.equal(out.counts.failed, 0);
  const row = rowOf(id);
  assert.equal(row.status, 'done', '卡行按 registry 终态收口');
  assert.match(String(row.endedAt), /^\d{4}-/, '卡行应补 endedAt 审计字段');
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude-sessions.json'), 'utf8')).find((e) => e.session_id === SID);
  assert.equal(reg.status, 'done');
  assert.ok(reg.endedAt, 'registry 侧应有 endedAt');

  const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(led.counts.applied, 1);
  assert.equal(led.records.length, 1);
  assert.equal(led.records[0].task, id);
  assert.equal(led.records[0].action, 'close_card_row');
  const audit = path.join(WS, id, lifecycle.LANE_AUDIT_FILE);
  assert.ok(fs.existsSync(audit), '须逐条留痕（workspace/<card>/lane-lifecycle.log）');
  assert.equal(JSON.parse(fs.readFileSync(audit, 'utf8').trim().split('\n')[0]).source, 'session-reconcile');
});

test('5. --apply 不碰 manual/immutable：活 pid 的卡行与历史重复行一字不改', { skip: SKIP }, async () => {
  const id = 'T-20260101-070005-skip';
  writeCard(id, { segs: [line('seg1', 'running', SID, process.pid)] }); // pid 存活
  writeRegistry([entry(id, SID, 'done'), entry(id, SID2, 'done')]);
  const before = cardRaw(id);
  const regBefore = fs.readFileSync(path.join(ROOT, 'claude-sessions.json'), 'utf8');

  const out = await reconcileSessions({ apply: true, ledger: path.join(WS, 'ledger2.json') });

  assert.equal(out.counts.fixable, 0, `活 pid 项不得入可修面：${JSON.stringify(out.classified)}`);
  assert.equal(cardRaw(id), before, 'manual 项：卡一字不改');
  assert.equal(fs.readFileSync(path.join(ROOT, 'claude-sessions.json'), 'utf8'), regBefore, 'manual 项：registry 一字不改');
});

test('6. --apply 缺 --ledger ⇒ 拒绝（绝不静默改线上数据无台账）', { skip: SKIP }, async () => {
  await assert.rejects(() => reconcileSessions({ apply: true, ledger: '' }), /--ledger/);
});

test('7. 非破坏：修复后再跑一次对账 ⇒ 该项已消失（幂等收敛，无新增不一致）', { skip: SKIP }, async () => {
  const id = 'T-20260101-070007-converge';
  writeCard(id, { segs: [line('seg1', 'running', SID, DEAD)] });
  writeRegistry([entry(id, SID, 'closed')]);
  const first = await reconcileSessions({ apply: true, ledger: path.join(WS, 'ledger3.json') });
  assert.equal(first.counts.fixable, 1);
  const second = await reconcileSessions({ apply: false });
  assert.equal(second.counts.fixable, 0, `二次对账应无同类项：${JSON.stringify(second.classified)}`);
  assert.equal(second.counts.manual, 0);
});
