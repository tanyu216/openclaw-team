#!/usr/bin/env node
/**
 * check-sessions.test.mjs — 卡↔registry 子会话一致性守卫测试（spawn 登记一致性，m7 反证）
 *
 * 背景（T-20261009-211234-concurrencyharden 追加）：m7 卡 Sessions 空、registry 2 running（存活）
 * ⇒ 登记只走了 registry 未走 task.session-set。本套件双向比对：
 *   registry_only（卡无行但 registry running+存活）⇒ 硬失败；
 *   card_only（卡有 running 行但 registry 无条目）⇒ 硬失败；
 *   zombie_registry / status_mismatch ⇒ 软告警（不影响 ok）。
 * 运行：node --test scripts/tests/check-sessions.test.mjs
 */
import { test as nodeTest, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// 前置：先设 env，再动态 import（TASKS_DIR/REGISTRY_PATH 于模块加载期读取）
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sesscheck-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
const TASKS = path.join(ROOT, 'tasks');
fs.mkdirSync(TASKS, { recursive: true });

// provider 依赖为**条件动态 import**：缺 provider 时 check-sessions.mjs/lib.mjs 在 import 期即硬红。
let checkSessions;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ checkSessions } = await import('../check-sessions.mjs'));
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
// 每测清空看板，避免跨测卡积累干扰判定
beforeEach(() => {
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
});

const SID = '11111111-2222-3333-4444-555555555555';
const sessionLine = (seg, status, sid = SID, pid = process.pid) =>
  `seg:${seg} · owner:linus · backend:claude · id:${sid} · phase:p · status:${status} · pid:${pid} · 2026-01-01T00:00:00.000Z`;

function writeCard(id, sessionLines = []) {
  const body = `## Background\nx\n## Acceptance\n- [ ] a\n## Progress\n## Comments\n## Sessions\n${sessionLines.map((l) => `- ${l}`).join('\n')}\n## Report\n`;
  fs.writeFileSync(path.join(TASKS, `${id}.md`), `---\nid: ${id}\ntitle: sc\nassignee: linus\nstatus: in_progress\nproject: __team__\n---\n${body}`);
}

const runningEntry = (taskId, sid, pid = process.pid) => ({ task_id: taskId, owner: 'linus', phase: 'seg1', status: 'running', pid, session_id: sid, startedAt: 'x' });

test('1. 一致：卡行 running + registry running 存活 ⇒ ok:true 无硬失败', () => {
  const id = 'T-20260101-040001-ok';
  writeCard(id, [sessionLine('seg1', 'running')]);
  const r = checkSessions({ registry: [runningEntry(id, SID)] });
  assert.equal(r.ok, true, `应一致，实际 ${JSON.stringify(r)}`);
  assert.equal(r.inconsistencies.length, 0);
});

test('2. 反证 m7：registry running+存活 但卡 Sessions 无行 ⇒ registry_only（硬失败）', () => {
  const id = 'T-20260101-040002-m7';
  writeCard(id, []); // Sessions 空
  const r = checkSessions({ registry: [runningEntry(id, SID)] });
  assert.equal(r.ok, false, `应硬失败，实际 ${JSON.stringify(r)}`);
  assert.ok(r.inconsistencies.some((x) => x.type === 'registry_only' && x.task === id));
});

test('3. 卡有 running 行（pid 存活）但 registry 无条目 ⇒ card_only（硬失败）', () => {
  const id = 'T-20260101-040003-cardonly';
  writeCard(id, [sessionLine('seg1', 'running', SID, process.pid)]);
  const r = checkSessions({ registry: [] });
  assert.equal(r.ok, false);
  assert.ok(r.inconsistencies.some((x) => x.type === 'card_only' && x.task === id));
});

test('3b. 卡 running 行但 pid 已死 ⇒ stale_card_line（软告警，ok 仍 true）', () => {
  const id = 'T-20260101-040003-stale';
  writeCard(id, [sessionLine('seg1', 'running', SID, 999999)]);
  const r = checkSessions({ registry: [] });
  assert.equal(r.ok, true, `死 pid 的陈旧行应是软告警，实际 ${JSON.stringify(r)}`);
  assert.equal(r.inconsistencies.length, 0);
  assert.ok(r.notes.some((x) => x.type === 'stale_card_line' && x.task === id));
});

test('4. 僵尸：registry running 但 pid 死 ⇒ 软告警 zombie_registry（ok 仍 true）', () => {
  const id = 'T-20260101-040004-zombie';
  writeCard(id, [sessionLine('seg1', 'running', SID, 999999)]);
  const r = checkSessions({ registry: [runningEntry(id, SID, 999999)] });
  assert.equal(r.ok, true, `僵尸应是软告警不影响门禁，实际 ${JSON.stringify(r)}`);
  assert.equal(r.inconsistencies.length, 0);
  assert.ok(r.notes.some((x) => x.type === 'zombie_registry'));
});

test('5. 状态错位：卡 running 行 + registry closed ⇒ 软告警 status_mismatch', () => {
  const id = 'T-20260101-040005-mismatch';
  writeCard(id, [sessionLine('seg1', 'running')]);
  const reg = runningEntry(id, SID);
  reg.status = 'closed';
  const r = checkSessions({ registry: [reg] });
  assert.equal(r.ok, true);
  assert.ok(r.notes.some((x) => x.type === 'status_mismatch' && x.task === id));
});
