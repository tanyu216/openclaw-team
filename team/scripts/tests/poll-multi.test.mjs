#!/usr/bin/env node
/**
 * poll-multi.test.mjs — poll.mjs 一轮多张领取 测试（T-20261009-193500-pollthroughput）
 *
 * 覆盖 Acceptance：多张领取 / 额度封顶 / 冲突只领一张 / 无候选 fire:false / 部分失败继续(deps_unmet)。
 * 风格对齐 poll-guard.test.mjs：不 mock 内部函数——真实读写 os.tmpdir() 临时文件 + 真实子进程跑 poll CLI。
 * 运行：node --test scripts/tests/poll-multi.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// provider 依赖为**条件动态 import**：缺 provider 时 lib.mjs/poll.mjs 在 import 期即硬红。
let parseFrontmatter, serializeFrontmatter, concurrencyQuota, conflictKey, runningCount, claimBudget;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ parseFrontmatter, serializeFrontmatter } = await import('../lib.mjs'));
  ({ concurrencyQuota, conflictKey, runningCount, claimBudget } = await import('../poll.mjs'));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL = path.join(HERE, '..', 'poll.mjs');

const scratchDirs = [];
/** 建临时 team-root（含 tasks/），返回 root */
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pm-'));
  scratchDirs.push(root);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  return root;
}
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 写一张合成任务卡（默认 linus + ready，可覆盖字段） */
function writeCard(root, id, fm = {}) {
  const merged = { id, title: 'multi-test', assignee: 'linus', status: 'ready', ...fm };
  const p = path.join(root, 'tasks', `${id}.md`);
  fs.writeFileSync(p, serializeFrontmatter(merged, 'body\n'), 'utf8');
  return p;
}

function readFm(root, id) {
  return parseFrontmatter(fs.readFileSync(path.join(root, 'tasks', `${id}.md`), 'utf8')).fm;
}

function writeRegistry(root, entries) {
  fs.writeFileSync(path.join(root, 'claude-sessions.json'), JSON.stringify(entries, null, 2), 'utf8');
}

function writeTuringRuns(root, entries) {
  fs.writeFileSync(path.join(root, 'turing-runs.json'), JSON.stringify(entries, null, 2), 'utf8');
}

/** 以独立进程跑真实 poll CLI（OPENCLAW_TEAM_ROOT 指向临时 root），返回解析后的 JSON */
function runPollCli(root, agent = 'linus') {
  const out = execFileSync(process.execPath, [POLL, agent], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

const runningEntry = (taskId, owner = 'linus', extra = {}) => ({
  task_id: taskId,
  owner,
  phase: 'seg1',
  status: 'running',
  pid: process.pid,
  session_id: `u-${taskId}`,
  ...extra,
});

// ---- 多张领取 --------------------------------------------------------------

test('1. 多张领取：3 张不同写面 ready 卡一轮全领，message 列出全部路径', () => {
  const root = mkRoot();
  const ids = ['T-20260101-100001-m1', 'T-20260101-100002-m2', 'T-20260101-100003-m3'];
  writeCard(root, ids[0], { project: '__team__', target: '/a/one', created_at: '2026-01-01T00:00:01.000Z' });
  writeCard(root, ids[1], { project: '__team__', target: '/a/two', created_at: '2026-01-01T00:00:02.000Z' });
  writeCard(root, ids[2], { project: 'TaskPanel', target: '/a/three', created_at: '2026-01-01T00:00:03.000Z' });

  const out = runPollCli(root);
  assert.equal(out.fire, true, `应 fire:true，实际 ${JSON.stringify(out)}`);
  assert.equal(out.state.claimed, 3, '应一轮领 3 张');
  assert.equal(out.state.cardPaths.length, 3);
  assert.equal(out.state.cardId, ids[0], 'cardId 兼容旧契约 = 首张卡');
  for (const id of ids) {
    assert.equal(readFm(root, id).status, 'in_progress', `${id} 应为 in_progress`);
    assert.equal(readFm(root, id).claimed_by, 'linus');
  }
  for (const p of out.state.cardPaths) {
    assert.ok(out.message.includes(p), `message 应列出已领卡路径 ${p}`);
  }
  assert.ok(out.message.includes('已领 3 张'), 'message 应含本轮领取张数');
});

// ---- 额度封顶 --------------------------------------------------------------

test('2. 额度封顶：linus running=7 ⇒ budget=1，一轮只领 1 张', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-200001-q1', { project: '__team__', target: '/a/q1', created_at: '2026-01-01T00:00:01.000Z' });
  writeCard(root, 'T-20260101-200002-q2', { project: '__team__', target: '/a/q2', created_at: '2026-01-01T00:00:02.000Z' });
  const reg = [];
  for (let i = 1; i <= 7; i++) reg.push(runningEntry(`T-20260101-000000-r${i}`));
  writeRegistry(root, reg);

  const out = runPollCli(root);
  assert.equal(out.fire, true, JSON.stringify(out));
  assert.equal(out.state.claimed, 1, '额度 8-7=1 ⇒ 只领 1 张');
  assert.equal(out.state.budget, 1);
  assert.equal(readFm(root, 'T-20260101-200001-q1').status, 'in_progress');
  assert.equal(readFm(root, 'T-20260101-200002-q2').status, 'ready', '第二张应仍 ready（额度未满不领）');
});

test('3. 额度已满 ⇒ fire:false（零成本空转）', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-200003-full', { project: '__team__', target: '/a/full' });
  const reg = [];
  for (let i = 1; i <= 8; i++) reg.push(runningEntry(`T-20260101-000000-f${i}`));
  writeRegistry(root, reg);

  const out = runPollCli(root);
  assert.equal(out.fire, false, JSON.stringify(out));
  assert.equal(readFm(root, 'T-20260101-200003-full').status, 'ready', '额度满不领');
});

// ---- 冲突只领一张 ----------------------------------------------------------

test('4. 冲突只领一张：同 project+target 的 3 张只领最早 1 张，其余记 skipped', () => {
  const root = mkRoot();
  const t = '/repo/app';
  writeCard(root, 'T-20260101-300001-c1', { project: 'TaskPanel', target: t, created_at: '2026-01-01T00:00:01.000Z' });
  writeCard(root, 'T-20260101-300002-c2', { project: 'TaskPanel', target: t, created_at: '2026-01-01T00:00:02.000Z' });
  writeCard(root, 'T-20260101-300003-c3', { project: 'TaskPanel', target: t, created_at: '2026-01-01T00:00:03.000Z' });

  const out = runPollCli(root);
  assert.equal(out.fire, true, JSON.stringify(out));
  assert.equal(out.state.claimed, 1, '冲突组只领 1 张');
  assert.equal(readFm(root, 'T-20260101-300001-c1').status, 'in_progress', '最早卡被领');
  assert.equal(readFm(root, 'T-20260101-300002-c2').status, 'ready', '同组第二张应串行跳过');
  assert.equal(readFm(root, 'T-20260101-300003-c3').status, 'ready', '同组第三张应串行跳过');
  assert.equal(out.state.skipped.length, 2, '2 张写冲突卡记入 skipped');
});

// ---- 无候选 fire:false -----------------------------------------------------

test('5. 无候选 ⇒ fire:false（零成本空转，无 message）', () => {
  const root = mkRoot();
  const out = runPollCli(root);
  assert.equal(out.fire, false);
  assert.equal(out.message, undefined);
});

// ---- 部分失败继续（deps_unmet 跳过） ----------------------------------------

test('6. 部分失败继续：deps_unmet 跳过，其余两张仍领（fire:true）', () => {
  const root = mkRoot();
  // 前置卡（jobs/ready，未完成）⇒ 非 linus 候选，但使 d1 依赖未满足
  writeCard(root, 'T-20260101-400000-dep', { assignee: 'jobs', status: 'ready', project: '__team__', target: '/a/dep' });
  writeCard(root, 'T-20260101-400001-d1', { project: '__team__', target: '/a/d1', depends_on: ['T-20260101-400000-dep'], created_at: '2026-01-01T00:00:01.000Z' });
  writeCard(root, 'T-20260101-400002-d2', { project: '__team__', target: '/a/d2', created_at: '2026-01-01T00:00:02.000Z' });
  writeCard(root, 'T-20260101-400003-d3', { project: '__team__', target: '/a/d3', created_at: '2026-01-01T00:00:03.000Z' });

  const out = runPollCli(root);
  assert.equal(out.fire, true, JSON.stringify(out));
  assert.equal(out.state.claimed, 2, 'deps_unmet 跳过，其余 2 张领');
  assert.equal(readFm(root, 'T-20260101-400001-d1').status, 'ready', 'deps_unmet 卡应仍 ready');
  assert.equal(readFm(root, 'T-20260101-400002-d2').status, 'in_progress');
  assert.equal(readFm(root, 'T-20260101-400003-d3').status, 'in_progress');
  assert.deepEqual(out.state.failed, ['T-20260101-400001-d1'], 'failed 应记录 deps_unmet 卡');
});

// ---- Turing 额度口径（canonical registry = 唯一事实源） ---------------------
// 口径修正卡 T-20261014-011235：计数源从 turing-runs.json 收敛到 canonical registry
// （与 lane 登记面同源）。以下 7 为原用例改源，9/10/11 为红→绿负例。

test('7. Turing 额度 3：canonical registry running=2 ⇒ budget=1', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-500001-t1', { assignee: 'turing', project: '__team__', target: '/a/t1', created_at: '2026-01-01T00:00:01.000Z' });
  writeCard(root, 'T-20260101-500002-t2', { assignee: 'turing', project: '__team__', target: '/a/t2', created_at: '2026-01-01T00:00:02.000Z' });
  writeRegistry(root, [
    runningEntry('T-20260101-000000-x1', 'turing'),
    runningEntry('T-20260101-000000-x2', 'turing'),
  ]);

  const out = runPollCli(root, 'turing');
  assert.equal(out.fire, true, JSON.stringify(out));
  assert.equal(out.state.claimed, 1, 'Turing 额度 3-2=1');
  assert.equal(out.state.budget, 1);
  assert.equal(readFm(root, 'T-20260101-500001-t1').status, 'in_progress');
  assert.equal(readFm(root, 'T-20260101-500002-t2').status, 'ready');
});

// ---- 纯函数口径 ------------------------------------------------------------

test('8. concurrencyQuota / conflictKey 纯函数口径', () => {
  assert.equal(concurrencyQuota('linus'), 8);
  assert.equal(concurrencyQuota('jobs'), 8);
  assert.equal(concurrencyQuota('turing'), 3);
  assert.equal(concurrencyQuota('assistant'), null, '未定义额度 ⇒ null');
  assert.equal(concurrencyQuota('elon'), null);
  assert.equal(conflictKey({ project: 'A', target: '/x' }), 'A\u0000/x');
  assert.equal(conflictKey({ project: 'A', target: '/x' }), conflictKey({ project: 'A', target: '/x' }));
  assert.notEqual(conflictKey({ project: 'A', target: '/x' }), conflictKey({ project: 'A', target: '/y' }), '不同 target 不冲突');
  assert.notEqual(conflictKey({ project: 'A', target: '/x' }), conflictKey({ project: 'B', target: '/x' }), '不同 project 不冲突');
  assert.equal(conflictKey({}), '\u0000', '未知写面 ⇒ 空组');
  assert.equal(conflictKey({ project: 'A' }), 'A\u0000');
});

// ---- T-20261014-011235 负例（红→绿）：计数源 = canonical registry -----------

test('9. NEG：canonical 3 条 live turing lane ⇒ budget=0，不再多领（over-claim 回归）', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-600001-t1', { assignee: 'turing', project: '__team__', target: '/a/t1', created_at: '2026-01-01T00:00:01.000Z' });
  writeCard(root, 'T-20260101-600002-t2', { assignee: 'turing', project: '__team__', target: '/a/t2', created_at: '2026-01-01T00:00:02.000Z' });
  // lane 登记面 = canonical registry：3 条 live（pid 存活）⇒ 额度 3 已满
  writeRegistry(root, [
    runningEntry('T-20260101-000000-y1', 'turing'),
    runningEntry('T-20260101-000000-y2', 'turing'),
    runningEntry('T-20260101-000000-y3', 'turing'),
  ]);

  const out = runPollCli(root, 'turing');
  assert.equal(out.fire, false, `额度耗尽 ⇒ fire:false，实际 ${JSON.stringify(out)}`);
  assert.match(out.message, /并发额度已满/);
  assert.equal(readFm(root, 'T-20260101-600001-t1').status, 'ready', '额度满不得多领第一张');
  assert.equal(readFm(root, 'T-20260101-600002-t2').status, 'ready', '额度满不得多领第二张');
});

test('10. NEG：canonical N=2 ⇒ runningCount(turing)=2、claimBudget=3−2=1（纯函数口径）', () => {
  const reg = [runningEntry('T-20260101-000000-z1', 'turing'), runningEntry('T-20260101-000000-z2', 'turing')];
  assert.equal(runningCount('turing', { registry: reg }), 2, 'turing 计数须认 canonical（不再对 owner 特判）');
  assert.equal(claimBudget('turing', { registry: reg }), 1, '1 = 3 − 2');
  // 与其余 owner 同一口径：linus 同法
  assert.equal(runningCount('linus', { registry: reg }), 0, '异 owner 不串台');
});

test('11. NEG：turing-runs.json 不再是计数面 —— 仅它有条目也不扣额度', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-700001-t1', { assignee: 'turing', project: '__team__', target: '/a/t1', created_at: '2026-01-01T00:00:01.000Z' });
  writeCard(root, 'T-20260101-700002-t2', { assignee: 'turing', project: '__team__', target: '/a/t2', created_at: '2026-01-01T00:00:02.000Z' });
  writeCard(root, 'T-20260101-700003-t3', { assignee: 'turing', project: '__team__', target: '/a/t3', created_at: '2026-01-01T00:00:03.000Z' });
  writeTuringRuns(root, [
    runningEntry('T-20260101-000000-w1', 'turing'),
    runningEntry('T-20260101-000000-w2', 'turing'),
  ]);

  const out = runPollCli(root, 'turing');
  assert.equal(out.fire, true, JSON.stringify(out));
  assert.equal(out.state.budget, 3, 'canonical 为空 ⇒ 全额 3（不再被 turing-runs.json 扣减）');
  assert.equal(out.state.claimed, 3, '三张互不冲突卡一轮全领');
});
