#!/usr/bin/env node
/**
 * poll-guard.test.mjs — poll.mjs 防双跑守卫 + registry.mjs 存活判定/回退/迁移 测试
 *
 * 背景（T-20261008-235247-teampollguard）：同一任务卡出现多轮并发执行（双跑）。
 * 根因：poll 按陈旧恢复重领，但旧轮仍持有活跃子会话；且 registry 两套并存。
 *
 * 本套件不 mock 内部函数：只真实读写 os.tmpdir() 临时文件 + 真实子进程跑 poll CLI。
 * 运行：node --test scripts/tests/poll-guard.test.mjs
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

// provider 依赖为**条件动态 import**：缺 provider 时 lib.mjs/registry.mjs 在 import 期即硬红。
let parseFrontmatter, serializeFrontmatter, isPidAlive, activeSessions;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ parseFrontmatter, serializeFrontmatter } = await import('../lib.mjs'));
  ({ isPidAlive, activeSessions } = await import('../registry.mjs'));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL = path.join(HERE, '..', 'poll.mjs');
const REGISTRY = path.join(HERE, '..', 'registry.mjs');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const OLD = '2020-01-01T00:00:00.000Z';

const scratchDirs = [];
/** 建临时 team-root（含 tasks/），返回 root */
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pol-'));
  scratchDirs.push(root);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  return root;
}
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 写一张合成任务卡（minimal frontmatter） */
function writeCard(root, id, { status, heartbeatAgoMs, claimed_by = 'linus', claimed_at = OLD, assignee = 'linus', extra = {} } = {}) {
  const fm = {
    id,
    title: 'guard-test',
    assignee,
    status,
    claimed_by,
    claimed_at,
    ...extra,
  };
  if (heartbeatAgoMs != null) fm.heartbeat_at = new Date(Date.now() - heartbeatAgoMs).toISOString();
  const p = path.join(root, 'tasks', `${id}.md`);
  fs.writeFileSync(p, serializeFrontmatter(fm, 'body\n'), 'utf8');
  return p;
}

function readFm(root, id) {
  return parseFrontmatter(fs.readFileSync(path.join(root, 'tasks', `${id}.md`), 'utf8')).fm;
}

/** 写 canonical registry（team-root/claude-sessions.json） */
function writeRegistry(root, entries) {
  fs.writeFileSync(path.join(root, 'claude-sessions.json'), JSON.stringify(entries, null, 2), 'utf8');
}

/** 以独立进程跑真实 poll CLI（OPENCLAW_TEAM_ROOT 指向临时 root），返回解析后的 JSON */
function runPollCli(root) {
  const out = execFileSync(process.execPath, [POLL, 'linus'], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

/** 以独立进程跑 registry.mjs CLI */
function registryCli(root, ...args) {
  const out = execFileSync(process.execPath, [REGISTRY, ...args], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

const runningEntry = (id, extra = {}) => ({
  task_id: id,
  owner: 'linus',
  phase: 'seg1',
  status: 'running',
  pid: process.pid,
  session_id: 'u-test',
  ...extra,
});

// ---- 守卫场景 --------------------------------------------------------------

test('1. 活子会话 ⇒ 不重领（心跳陈旧 45min + running/pid 存活）', () => {
  const root = mkRoot();
  const id = 'T-20260101-000001-guard';
  writeCard(root, id, { status: 'in_progress', heartbeatAgoMs: 45 * MIN });
  writeRegistry(root, [runningEntry(id)]);

  const out = runPollCli(root);
  assert.equal(out.fire, false, `应不 fire，实际 ${JSON.stringify(out)}`);
  assert.ok(out.message.includes('活跃子会话'), 'message 应含「活跃子会话」');
  assert.ok(out.message.includes(id), 'message 应含卡 id');
  assert.ok(out.message.includes(String(process.pid)), 'message 应含存活 pid');

  const fm = readFm(root, id);
  assert.equal(fm.status, 'in_progress', '卡状态应仍为 in_progress');
  assert.equal(fm.claimed_at, OLD, 'claimed_at 不应被改写');
});

test('2a. 陈旧且无活子会话（无条目）⇒ 可重领', () => {
  const root = mkRoot();
  const id = 'T-20260101-000002-a-guard';
  writeCard(root, id, { status: 'in_progress', heartbeatAgoMs: 45 * MIN });
  writeRegistry(root, []);

  const out = runPollCli(root);
  assert.equal(out.fire, true, `应 fire:true，实际 ${JSON.stringify(out)}`);
  const fm = readFm(root, id);
  assert.equal(fm.status, 'in_progress');
  assert.equal(fm.claimed_by, 'linus');
  assert.notEqual(fm.claimed_at, OLD, 'claimed_at 应被刷新');
});

test('2b. 陈旧且无活子会话（死 pid）⇒ 可重领', () => {
  const root = mkRoot();
  const id = 'T-20260101-000002-b-guard';
  writeCard(root, id, { status: 'in_progress', heartbeatAgoMs: 45 * MIN });
  writeRegistry(root, [runningEntry(id, { pid: 999999 })]);

  const out = runPollCli(root);
  assert.equal(out.fire, true, `死 pid 不活跃，应 fire:true，实际 ${JSON.stringify(out)}`);
  const fm = readFm(root, id);
  assert.notEqual(fm.claimed_at, OLD, 'claimed_at 应被刷新');
});

test('3. 陈旧 8h 但有活子会话 ⇒ 不重领（stale_any 不越过守卫）', () => {
  const root = mkRoot();
  const id = 'T-20260101-000003-guard';
  writeCard(root, id, { status: 'in_progress', heartbeatAgoMs: 8 * HOUR });
  writeRegistry(root, [runningEntry(id)]);

  const out = runPollCli(root);
  assert.equal(out.fire, false, `应不 fire，实际 ${JSON.stringify(out)}`);
  assert.ok(out.message.includes('活跃子会话'));
  const fm = readFm(root, id);
  assert.equal(fm.status, 'in_progress');
  assert.equal(fm.claimed_at, OLD, 'claimed_at 不应被改写');
});

test('4. in_progress 心跳新鲜（≤10min）⇒ 不动（现状回归）', () => {
  const root = mkRoot();
  const id = 'T-20260101-000004-fresh';
  writeCard(root, id, { status: 'in_progress', heartbeatAgoMs: 5 * MIN });
  // 无 registry 文件

  const out = runPollCli(root);
  assert.equal(out.fire, false);
  assert.equal(out.message, undefined, '新鲜卡跳过应维持现状 {"fire":false}');
  assert.equal(readFm(root, id).claimed_at, OLD);
});

test('5. ready 且无活跃子会话 ⇒ 领取', () => {
  const root = mkRoot();
  const id = 'T-20260101-000005-ready';
  writeCard(root, id, { status: 'ready', claimed_at: '' });

  const out = runPollCli(root);
  assert.equal(out.fire, true, `应 fire:true，实际 ${JSON.stringify(out)}`);
  const fm = readFm(root, id);
  assert.equal(fm.status, 'in_progress');
  assert.equal(fm.claimed_by, 'linus');
});

test('5.1 复核卡提前轮询被拦：被复核卡仍 in_progress ⇒ 不领取；转 in_review ⇒ 可领取', () => {
  // 事故原样复现点（T-20261013-233052）：poll 曾可在被复核卡未交付时领走复核卡 ⇒ 空跑。
  const root = mkRoot();
  const reviewed = 'T-20260101-000051-reviewed';
  const review = 'T-20260101-000052-review';
  writeCard(root, reviewed, { status: 'in_progress', claimed_by: 'jobs', assignee: 'jobs' });
  writeCard(root, review, { status: 'ready', claimed_at: '', extra: { review_of: reviewed } });
  writeRegistry(root, []);
  const beforeClaimedAt = readFm(root, review).claimed_at;

  const out1 = runPollCli(root);
  assert.equal(out1.fire, false, `被复核卡未 in_review ⇒ poll 不应领取复核卡，实际 ${JSON.stringify(out1)}`);
  const fm1 = readFm(root, review);
  assert.equal(fm1.status, 'ready', '复核卡应保持 ready（未被领取）');
  assert.equal(fm1.claimed_at, beforeClaimedAt, 'claimed_at 不应被改写');

  // 被复核卡交付（in_review）⇒ 同一张复核卡可被 poll 领取
  const rf = readFm(root, reviewed);
  rf.status = 'in_review';
  fs.writeFileSync(path.join(root, 'tasks', `${reviewed}.md`), serializeFrontmatter(rf, 'body\n'), 'utf8');

  const out2 = runPollCli(root);
  assert.equal(out2.fire, true, `被复核卡 in_review ⇒ 应领取，实际 ${JSON.stringify(out2)}`);
  const fm2 = readFm(root, review);
  assert.equal(fm2.status, 'in_progress');
  assert.equal(fm2.claimed_by, 'linus');
});

// ---- legacy 回退 + 迁移 ----------------------------------------------------

test('6. legacy 回退：canonical 空但 workspace 局部有活子会话 ⇒ 不重领；migrate 迁移改名', () => {
  const root = mkRoot();
  const id = 'T-20260101-000006-legacy';
  writeCard(root, id, { status: 'in_progress', heartbeatAgoMs: 45 * MIN });
  writeRegistry(root, []); // canonical 为空

  const legacyDir = path.join(root, 'workspace', id);
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyPath = path.join(legacyDir, 'claude-sessions.json');
  const entry = runningEntry(id);
  fs.writeFileSync(legacyPath, JSON.stringify([entry], null, 2), 'utf8');

  const out = runPollCli(root);
  assert.equal(out.fire, false, `读取回退应生效 ⇒ 不 fire，实际 ${JSON.stringify(out)}`);
  assert.ok(out.message.includes('活跃子会话'));

  const mig = registryCli(root, 'migrate');
  assert.equal(mig.merged, 1, `应合并 1 条，实际 ${JSON.stringify(mig)}`);
  assert.equal(fs.existsSync(legacyPath), false, 'legacy 文件应被改名');
  assert.equal(fs.existsSync(`${legacyPath}.deprecated`), true, '应存在 .deprecated 文件');

  const canonical = JSON.parse(fs.readFileSync(path.join(root, 'claude-sessions.json'), 'utf8'));
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].task_id, id);
  assert.equal(canonical[0].status, 'running');
  assert.equal(canonical[0].pid, process.pid);
  assert.equal(canonical[0].legacy, undefined, '合并入 canonical 后不应残留 legacy 标记');
});

// ---- registry 单测 ---------------------------------------------------------

test('7. registry：isPidAlive 与 activeSessions 过滤正确', () => {
  assert.equal(isPidAlive(process.pid), true, '自身 pid 应存活');
  assert.equal(isPidAlive(999999), false, '死 pid 应不存活');
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive('123'), false);

  const reg = [
    runningEntry('T-1', { phase: 'seg1' }),
    runningEntry('T-1', { phase: 'seg2', pid: 999999 }),
    runningEntry('T-1', { phase: 'seg3', status: 'done' }),
    runningEntry('T-2', { phase: 'seg1' }),
  ];
  const act = activeSessions('T-1', { registry: reg });
  assert.equal(act.length, 1, '只应保留 task_id 匹配 + running + pid 存活 的条目');
  assert.equal(act[0].phase, 'seg1');
});
