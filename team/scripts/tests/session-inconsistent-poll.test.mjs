#!/usr/bin/env node
/**
 * session-inconsistent-poll.test.mjs — ③「不一致态下不得重领」测试（卡 running ↔ registry 终态）
 *
 * 背景（T-20261015-045724）：lane 终结未写会话终态 ⇒ 卡停在 `in_progress` + `## Sessions`
 * `status:running`（pid 死）而 **registry 已是终态**（手工/带外 reconcile 只写了 registry 一侧）。
 * 这类**不一致态**下 poll 的陈旧恢复判据（心跳超期 ⇒ stale_same）会把卡**再领一次**——工作其实
 * 可能已交付 ⇒ 重复执行。
 *
 * 本套件锁定的判据（与 session-lifecycle.mjs `classifyClaimBlock` 同源）：
 *   · registry 该 session **done** ⇒ 不重领（lane 已宣告完成，重领 = 重复执行）；
 *   · registry **无**该 session 且卡行 pid **存活** ⇒ 不重领（「卡说在跑、registry 说没有」矛盾态）；
 *   · registry closed/failed/无 + pid 死 ⇒ **照旧可领**（真恢复路径，不得被本守卫吃掉）；
 *   · 卡内无 `## Sessions` 行 / `new`（todo）面 ⇒ 不受本守卫约束（行为不变）。
 *
 * 运行：node --test scripts/tests/session-inconsistent-poll.test.mjs
 */
import { test as nodeTest, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 定位携带 ACL 库的 provider 安装目录（与 check-sessions.test.mjs / poll-guard.test.mjs 同口径）。 */
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sesspoll-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
const TASKS = path.join(ROOT, 'tasks');
fs.mkdirSync(TASKS, { recursive: true });

// provider 依赖为**条件动态 import**：缺 provider 时 lib.mjs/poll.mjs 在 import 期即硬红。
let runPoll, pollCandidates;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ runPoll, pollCandidates } = await import('../poll.mjs'));
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
});

const STALE_HB = '2020-01-01T00:00:00.000Z'; // > 30min & > 6h ⇒ 陈旧
const DEAD_PID = 999999;                     // 不存在 ⇒ 判死
const SID = '11111111-2222-3333-4444-555555555555';
const SID2 = '22222222-3333-4444-5555-666666666666';

/** 会话行（与 ACL `session-set` 落卡格式同形：`- seg:… · owner:… · … · <ts>`） */
const sessionLine = (seg, status, sid = SID, pid = DEAD_PID) =>
  `- seg:${seg} · owner:linus · backend:claude · id:${sid} · phase:${seg} · status:${status} · pid:${pid} · 2026-01-01T00:00:00.000Z`;

/**
 * 写一张合成卡。`sessions` = `## Sessions` 段的行数组；`active` = frontmatter `active_session_id`。
 */
function writeCard(id, { status = 'in_progress', claimed_by = 'linus', heartbeat_at = STALE_HB, sessions = [], active = '' } = {}) {
  const body = [
    '## Background', 'x', '## Acceptance', '- [ ] a', '## Progress', '## Comments',
    '## Sessions', ...sessions, '## Report', '',
  ].join('\n');
  const fm = [
    `id: ${id}`, 'title: inconsistent-poll test', 'assignee: linus', `status: ${status}`,
    `claimed_by: ${claimed_by}`, `claimed_at: ${STALE_HB}`, `heartbeat_at: ${heartbeat_at}`,
    'project: __team__', ...(active ? [`active_session_id: ${active}`] : []),
  ].join('\n');
  const p = path.join(TASKS, `${id}.md`);
  fs.writeFileSync(p, `---\n${fm}\n---\n${body}`, 'utf8');
  return p;
}

const fmOf = (id) => {
  const raw = fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8');
  const out = {};
  for (const line of /^---\n([\s\S]*?)\n---/.exec(raw)[1].split('\n')) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
};

const entry = (taskId, sid, status, pid = DEAD_PID) =>
  ({ task_id: taskId, owner: 'linus', phase: 'seg1', status, pid, session_id: sid, startedAt: 'x' });

// ── ① 事故形态：卡 running + registry done ⇒ 不得重领 ─────────────────────────

test('1. RED 事故形态：卡 in_progress/running(pid 死) + registry done ⇒ 不重领（stale_same 被一致性守卫拦下）', () => {
  const id = 'T-20260101-050001-done';
  writeCard(id, { sessions: [sessionLine('seg1', 'running', SID, DEAD_PID)], active: SID });
  const before = fmOf(id);

  const r = runPoll({ assignee: 'linus', registry: [entry(id, SID, 'done')] });

  assert.equal(r.fire, false, `registry=done 的不一致态不得重领，实际 ${JSON.stringify(r)}`);
  const after = fmOf(id);
  assert.equal(after.status, 'in_progress', '卡不得被重领');
  assert.equal(after.claimed_at, before.claimed_at, 'claimed_at 不得被重写（= 未发生领取）');
  assert.equal(after.heartbeat_at, before.heartbeat_at, 'heartbeat_at 不得被重写（= 未发生领取）');
  assert.ok(
    (r.state?.inconsistent || []).some((x) => x.card === id && x.kind === 'registry_done'),
    `信封须载明判据与证据，实际 ${JSON.stringify(r.state || r)}`,
  );
});

test('2. 只读候选面同源：pollCandidates 也排除该不一致态（ACL 上游一致）', () => {
  const id = 'T-20260101-050002-readonly';
  writeCard(id, { sessions: [sessionLine('seg1', 'running', SID, DEAD_PID)], active: SID });

  const out = pollCandidates('linus', { registry: [entry(id, SID, 'done')] });
  assert.equal(out.candidates.filter((c) => c.id === id).length, 0, '只读面不得把不一致态列为候选');
});

test('3. 判据按 active_session_id 对齐：该 session 终态 ⇒ 不领（同卡他行 running 不干扰）', () => {
  const id = 'T-20260101-050003-active';
  // 两条 running 行、pid 皆死（⇒ poll 既有「活跃子会话」守卫不会挡住，本判据必须自己命中）
  writeCard(id, {
    sessions: [sessionLine('seg1', 'running', SID, DEAD_PID), sessionLine('seg2', 'running', SID2, DEAD_PID)],
    active: SID,
  });
  const r = runPoll({ assignee: 'linus', registry: [entry(id, SID, 'done'), entry(id, SID2, 'closed')] });
  assert.equal(r.fire, false, `active_session_id 指向的 session 已 done ⇒ 不领，实际 ${JSON.stringify(r)}`);
  assert.ok((r.state?.inconsistent || []).some((x) => x.card === id && x.session === SID), '证据须指向 active_session_id 那条');
});

// ── ② 反面对照：真恢复路径不得被本守卫吃掉 ───────────────────────────────────

test('4. 对照·registry 无条目 + pid 死 ⇒ 照旧可领（僵尸行交恢复路径）', () => {
  const id = 'T-20260101-050004-recover';
  writeCard(id, { sessions: [sessionLine('seg1', 'running', SID, DEAD_PID)], active: SID });

  const r = runPoll({ assignee: 'linus', registry: [] });
  assert.equal(r.fire, true, `真僵尸行应可恢复重领，实际 ${JSON.stringify(r)}`);
  assert.equal(fmOf(id).status, 'in_progress');
  assert.notEqual(fmOf(id).claimed_at, STALE_HB, '恢复领取应刷新 claimed_at');
});

test('5. 对照·registry closed / failed + pid 死 ⇒ 照旧可领（终态≠已交付）', () => {
  for (const st of ['closed', 'failed']) {
    const id = `T-20260101-050005-${st}`;
    writeCard(id, { sessions: [sessionLine('seg1', 'running', SID, DEAD_PID)], active: SID });
    const r = runPoll({ assignee: 'linus', registry: [entry(id, SID, st)] });
    assert.equal(r.fire, true, `registry=${st} 且 pid 死 ⇒ 应走恢复，实际 ${JSON.stringify(r)}`);
  }
});

test('6. 对照·registry 无条目但卡行 pid 存活 ⇒ 不领（card_only 矛盾态，防双跑）', () => {
  const id = 'T-20260101-050006-cardonly';
  writeCard(id, { sessions: [sessionLine('seg1', 'running', SID, process.pid)], active: SID });

  const r = runPoll({ assignee: 'linus', registry: [] });
  assert.equal(r.fire, false, `卡行 pid 存活而 registry 无条目 ⇒ 不得重领，实际 ${JSON.stringify(r)}`);
  assert.equal(fmOf(id).claimed_at, STALE_HB);
  assert.ok((r.state?.inconsistent || []).some((x) => x.card === id && x.kind === 'card_only_live'));
});

// ── ③ 行为不变面（守卫不得越界） ─────────────────────────────────────────────

test('7. 对照·卡内无 ## Sessions 行 ⇒ 不受本守卫约束（陈旧恢复照旧）', () => {
  const id = 'T-20260101-050007-norow';
  writeCard(id, { sessions: [] });
  const r = runPoll({ assignee: 'linus', registry: [entry(id, SID, 'done')] });
  assert.equal(r.fire, true, `无 Sessions 行时不得套用本守卫，实际 ${JSON.stringify(r)}`);
});

test('8. 对照·new（todo）面不受本守卫约束（重开卡仍可领）', () => {
  const id = 'T-20260101-050008-new';
  writeCard(id, { status: 'todo', claimed_by: '', sessions: [sessionLine('seg1', 'running', SID, DEAD_PID)], active: SID });
  const r = runPoll({ assignee: 'linus', registry: [entry(id, SID, 'done')] });
  assert.equal(r.fire, true, `new 面应照旧可领，实际 ${JSON.stringify(r)}`);
});
