#!/usr/bin/env node
/**
 * samefile-guard.test.mjs — 同文件并发告警测试（反证：同文件并发告警触发）
 *
 * 背景（T-20261009-211234-concurrencyharden）：同文件多卡并发写 + 连带提交。本套件验证
 * samefile-guard 按非终态卡的声明写集（writes 字段，缺省退化为 target）报出重叠，供串行/worktree 决策。
 * 运行：node --test scripts/tests/samefile-guard.test.mjs
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

// 前置：先设 env，再动态 import（TASKS_DIR 于模块加载期读取）
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-samefile-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
const TASKS = path.join(ROOT, 'tasks');
fs.mkdirSync(TASKS, { recursive: true });

// provider 依赖为**条件动态 import**：缺 provider 时 samefile-guard.mjs/lib.mjs 在 import 期即硬红。
let samefileConflicts;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ samefileConflicts } = await import('../samefile-guard.mjs'));
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
// 每测清空看板，避免跨测卡积累干扰判定
beforeEach(() => {
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
});

function writeCard(id, { status = 'ready', target = '', writes = null } = {}) {
  const lines = [`id: ${id}`, 'title: sf', 'assignee: linus', `status: ${status}`, 'project: __team__'];
  if (target) lines.push(`target: ${target}`);
  if (writes && writes.length) lines.push(`writes: [${writes.join(', ')}]`);
  fs.writeFileSync(path.join(TASKS, `${id}.md`), `---\n${lines.join('\n')}\n---\nbody\n`);
}

test('1. 两卡写集重叠 ⇒ 报出 overlap（同文件并发告警）', () => {
  writeCard('T-20260101-030001-a', { writes: ['team/scripts/lib.mjs', 'team/scripts/poll.mjs'] });
  writeCard('T-20260101-030001-b', { writes: ['team/scripts/poll.mjs', 'team/guides/task-interface.md'] });

  const r = samefileConflicts({ card: 'T-20260101-030001-a' });
  assert.equal(r.ok, true);
  assert.equal(r.conflicts.length, 1, `应 1 条冲突，实际 ${JSON.stringify(r)}`);
  assert.deepEqual(r.conflicts[0].overlap, ['team/scripts/poll.mjs']);
  assert.equal(r.conflicts[0].b.id, 'T-20260101-030001-b');
});

test('2. 写集不相交 ⇒ 无冲突', () => {
  writeCard('T-20260101-030002-a', { writes: ['team/scripts/lib.mjs'] });
  writeCard('T-20260101-030002-b', { writes: ['team/scripts/poll.mjs'] });

  const r = samefileConflicts({ card: 'T-20260101-030002-a' });
  assert.equal(r.conflicts.length, 0, `应无冲突，实际 ${JSON.stringify(r)}`);
});

test('3. 缺省退化 target：同 target 视为同资源 ⇒ 报出', () => {
  writeCard('T-20260101-030003-a', { target: '/Users/tanyu/.openclaw/team' });
  writeCard('T-20260101-030003-b', { target: '/Users/tanyu/.openclaw/team' });

  const r = samefileConflicts({ card: 'T-20260101-030003-a' });
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0].overlap, ['/Users/tanyu/.openclaw/team']);
});

test('4. 终态卡不参与判定（done 排除）', () => {
  writeCard('T-20260101-030004-a', { status: 'ready', writes: ['x.md'] });
  writeCard('T-20260101-030004-b', { status: 'done', writes: ['x.md'] });

  const r = samefileConflicts({ card: 'T-20260101-030004-a' });
  assert.equal(r.conflicts.length, 0, 'done 卡不应触发同文件告警');
});

test('5. --card 过滤：只报与该卡有关的重叠；全板扫描（无 card）也成对去重', () => {
  writeCard('T-20260101-030005-a', { writes: ['x.md'] });
  writeCard('T-20260101-030005-b', { writes: ['x.md'] });
  writeCard('T-20260101-030005-c', { writes: ['y.md'] });

  const r = samefileConflicts({ card: 'T-20260101-030005-a' });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].b.id, 'T-20260101-030005-b');

  const all = samefileConflicts({});
  const ab = all.conflicts.filter((c) => (c.a.id === 'T-20260101-030005-a' && c.b.id === 'T-20260101-030005-b') || (c.a.id === 'T-20260101-030005-b' && c.b.id === 'T-20260101-030005-a'));
  assert.equal(ab.length, 1, '全板扫描应恰好报出 a-b 一对（不重复）');
});
