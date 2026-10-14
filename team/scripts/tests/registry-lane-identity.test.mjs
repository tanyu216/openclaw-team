#!/usr/bin/env node
/**
 * registry-lane-identity.test.mjs — registry「lane 身份」去重 + 拒写（T-20261013-233906）
 *
 * 背景（实证 T-20261013-223243）：同一张卡出现**重复 seg 登记**——
 *   `{phase:'seg1-verify', pid:9271, session_id:d55e03c4}`
 *   `{phase:'seg1',        pid:∅,    session_id:d55e03c4}`   ← 无 pid 的重复登记
 * 根因：去重键把 `phase` 计入身份（`task|owner|phase|session_id`），而 `phase` 是 caller 自由填的
 * **展示标签**（未必等于 seg）⇒ 同一条 lane 换个标签再登记就成了「新行」。后果：`check-sessions`
 * 看见同卡两条 running（一条 pid 空 ⇒ 僵尸告警/可能的 registry_only 判读），且活跃行的 log/startedAt
 * 会被无主重复登记抹掉。
 *
 * 修复口径（本仓 `scripts/registry.mjs`）：
 *   ① 身份 = `(task_id, owner, session_id)`（`session_id` 是 `(card, owner, seg)` 的确定性投影）；
 *      `phase` 只是随行刷新的标签 ⇒ 同 lane 重复登记**幂等覆盖，不产生重复行**；
 *   ② 既有行是**活跃 running（pid 存活）**时，**无 pid 的 running** 重复登记 ⇒ **拒写**
 *      （`duplicate_running_lane`），原行 pid/log/startedAt 保留；
 *   ③ `check-sessions` 对**已落盘**的重复行（历史污染/旁路写入）报软告警 `duplicate_lane`（不影响退出码，
 *      因为读取侧已按身份折叠，不报就等于静默丢审计痕迹）。
 *
 * 隔离：`OPENCLAW_TEAM_ROOT` = mkdtemp（lib.mjs/TEAM_ROOT 于模块加载期读取）——**绝不碰真实看板**。
 * 风格：真实 temp 目录 + 动态 import，不 mock 内部函数。
 * 运行：node --test scripts/tests/registry-lane-identity.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';


// 前置：先设 env，再动态 import（TEAM_ROOT 在模块加载期读取，import 顺序不可颠倒）
// provider（task-ops，有意不随仓）为**条件依赖**：缺 ⇒ 整文件 SKIP（与 registry-status.test.mjs 同口径）。
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-laneident-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
if (PROVIDER) process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
const TASKS = path.join(ROOT, 'tasks');
fs.mkdirSync(path.join(TASKS, '.locks'), { recursive: true });

const REGISTRY_PATH = path.join(ROOT, 'claude-sessions.json');
// provider 依赖为**条件动态 import**：缺 provider 时 registry.mjs/lib.mjs 在 import 期即硬红。
let reg, checkSessions, duplicateLaneRows;
if (PROVIDER) {
  reg = await import('../registry.mjs');
  ({ checkSessions, duplicateLaneRows } = await import('../check-sessions.mjs'));
}

const rawRegistry = () => (fs.existsSync(REGISTRY_PATH) ? JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) : []);
const rowsOf = (taskId) => rawRegistry().filter((e) => e.task_id === taskId);

/** 卡文件（最小形态：frontmatter + 必需段落；与 check-card/check-sessions 的读取口径兼容） */
function writeCard(id, { status = 'in_progress', segs = [] } = {}) {
  const body = `## Background\nx\n## Acceptance\n- [ ] a\n## Progress\n## Comments\n## Sessions\n${segs.join('\n')}\n## Report\n`;
  fs.writeFileSync(
    path.join(TASKS, `${id}.md`),
    `---\nid: ${id}\ntitle: lane-identity test\nassignee: linus\nstatus: ${status}\ngoal: g\nproject: __team__\nclaimed_by: linus\nheartbeat_at: 2026-01-01T00:00:00.000Z\n---\n${body}`,
  );
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('1. 去重：同一 lane（task|owner|session_id）换 phase 标签二次登记 ⇒ 只一行，标签被刷新', () => {
  const id = 'T-20260101-200001-lane-dedupe';
  const sid = 'd55e03c4-af22-5cec-899e-6f023298abd4';
  writeCard(id, { segs: [`- seg:seg1 · owner:turing · backend:claude · id:${sid} · phase:seg1-verify · status:running · pid:${process.pid} · 2026-01-01T00:00:00.000Z`] });
  reg.upsertSessionEntry({ task_id: id, owner: 'turing', phase: 'seg1-verify', status: 'running', pid: process.pid, session_id: sid, log: '/x/turing-1.out.jsonl', startedAt: '2026-01-01T00:00:00.000Z' });
  const second = reg.upsertSessionEntry({ task_id: id, owner: 'turing', phase: 'seg1', status: 'running', pid: process.pid, session_id: sid, log: '/x/turing-1.out.jsonl', startedAt: '2026-01-01T00:00:01.000Z' });

  const rows = rowsOf(id);
  assert.equal(rows.length, 1, `同一 lane 不得落重复行，实际 ${JSON.stringify(rows)}`);
  assert.equal(second.created, false, '第二次登记是覆盖（created:false），不是新增');
  assert.equal(rows[0].phase, 'seg1', 'phase 只是标签：随行刷新');
  assert.equal(rows[0].session_id, sid);
});

test('2. 拒写：活跃 running 行 + 无 pid 的 running 重复登记 ⇒ duplicate_running_lane，原行不被抹', () => {
  const id = 'T-20260101-200002-lane-refuse';
  const sid = 'a1a1a1a1-1111-5111-8111-111111111111';
  writeCard(id, { segs: [`- seg:seg1 · owner:turing · backend:claude · id:${sid} · phase:seg1-verify · status:running · pid:${process.pid} · 2026-01-01T00:00:00.000Z`] });
  reg.upsertSessionEntry({ task_id: id, owner: 'turing', phase: 'seg1-verify', status: 'running', pid: process.pid, session_id: sid, log: '/x/turing-1.out.jsonl', startedAt: '2026-01-01T00:00:00.000Z' });

  const dup = reg.upsertSessionEntry({ task_id: id, owner: 'turing', phase: 'seg1', status: 'running', session_id: sid, log: '', startedAt: '2026-01-01T00:00:02.000Z' });

  assert.equal(dup.ok, false, JSON.stringify(dup));
  assert.equal(dup.reason, 'duplicate_running_lane');
  const rows = rowsOf(id);
  assert.equal(rows.length, 1, '拒绝 ⇒ 不落盘（不产生重复行）');
  assert.equal(rows[0].pid, process.pid, '活跃行的 pid 保留');
  assert.equal(rows[0].log, '/x/turing-1.out.jsonl', '活跃行的 log 不得被空重复登记抹掉');
  assert.equal(rows[0].phase, 'seg1-verify', '活跃行的标签不被无主登记改写');
});

test('3. check-sessions：去重后同一 lane 的重复登记不产生僵尸 running 行（ok:true，无 zombie/duplicate 告警）', () => {
  const id = 'T-20260101-200003-sessions-consistent';
  const sid = 'b2b2b2b2-2222-5222-8222-222222222222';
  writeCard(id, { segs: [`- seg:seg1 · owner:turing · backend:claude · id:${sid} · phase:seg1-verify · status:running · pid:${process.pid} · 2026-01-01T00:00:00.000Z`] });
  reg.upsertSessionEntry({ task_id: id, owner: 'turing', phase: 'seg1-verify', status: 'running', pid: process.pid, session_id: sid, log: '/x/turing-1.out.jsonl', startedAt: '2026-01-01T00:00:00.000Z' });
  reg.upsertSessionEntry({ task_id: id, owner: 'turing', phase: 'seg1', status: 'running', pid: process.pid, session_id: sid, log: '/x/turing-1.out.jsonl', startedAt: '2026-01-01T00:00:01.000Z' });

  const r = checkSessions();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.inconsistencies, [], '同 lane 重复登记不得产出 registry_only/card_only 硬失败');
  assert.equal(r.notes.filter((n) => n.type === 'zombie_registry' && n.task === id).length, 0, '不得留下 pid 空的僵尸 running 行');
  assert.equal(r.notes.filter((n) => n.type === 'duplicate_lane' && n.task === id).length, 0, '写入侧已去重 ⇒ 无重复行可报');
});

test('4. 软告警：**已落盘**的重复行（history/旁路写入）⇒ duplicate_lane，ok 仍 true（不新增红）', () => {
  const id = 'T-20260101-200004-legacy-dup';
  const sid = 'c3c3c3c3-3333-5333-8333-333333333333';
  writeCard(id, { segs: [`- seg:seg1 · owner:turing · backend:claude · id:${sid} · phase:seg1-verify · status:running · pid:${process.pid} · 2026-01-01T00:00:00.000Z`] });
  // 直接伪造「历史污染」形态（绕过去重：手写文件），模拟修复前落盘的重复 seg 行
  const list = rawRegistry();
  list.push(
    { task_id: id, owner: 'turing', phase: 'seg1-verify', pid: process.pid, status: 'running', session_id: sid, startedAt: 'x', log: '/x/a.jsonl' },
    { task_id: id, owner: 'turing', phase: 'seg1', pid: 999999999, status: 'done', session_id: sid, startedAt: 'y', log: '' },
  );
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(list, null, 2) + '\n');

  const dups = duplicateLaneRows();
  assert.ok(dups.some((d) => d.task === id && d.session === sid), JSON.stringify(dups));
  assert.equal(dups.find((d) => d.task === id).rows.length, 2, '两行都报出（phase 一并列出，便于清理）');

  const r = checkSessions();
  assert.equal(r.ok, true, '重复行是软告警，不改变退出码（零新增红）');
  assert.ok(r.notes.some((n) => n.type === 'duplicate_lane' && n.task === id), JSON.stringify(r.notes));
});
