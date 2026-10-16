#!/usr/bin/env node
/**
 * dispatch-collision.test.mjs — 直派 × poll 并发领取碰撞（第 4 次）反证测试
 *
 * 背景（T-20261009-235600-dispatchcollision）：Elon 直派（sessions_send）不走 task.claim ⇒ 卡仍 ready；
 * cron poll 求值期见 ready 原子领取 ⇒ 同一张卡被两条路径各唤醒一次（双唤醒，执行唯一性虽由
 * claim-guard/turn-lock 保住，但浪费一次唤醒、易被误判双跑）。
 *
 * 方案（择一·② 统一领取入口）：直派改走 `task.dispatch`（claim-first，复用 claimGuarded 同一把锁/原语）
 * —— 先原子 claim 成功 ⇒ dispatched:true（此时才 sessions_send 唤醒）；claim 失败 ⇒ dispatched:false
 * （派单侧据此放弃 sessions_send）。poll 无需改动：卡已 in_progress+心跳新鲜 ⇒ 自然不 fire。
 *
 * 本套件不 mock 内部函数：真实 os.tmpdir() 临时 team-root + 真实子进程跑 task.mjs dispatch / poll.mjs。
 * 运行：node --test scripts/tests/dispatch-collision.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-dispatch-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
const TASKS = path.join(ROOT, 'tasks');
fs.mkdirSync(TASKS, { recursive: true });
fs.mkdirSync(path.join(TASKS, '.locks'), { recursive: true });

// provider 依赖为**条件动态 import**：缺 provider 时 lib.mjs/poll.mjs 在 import 期即硬红。
let serializeFrontmatter, parseFrontmatter, readCard, runPoll, taskAcl;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  const lib = await import('../lib.mjs');
  ({ serializeFrontmatter, parseFrontmatter, readCard } = lib);
  ({ runPoll } = await import('../poll.mjs'));
  taskAcl = await import(pathToFileURL(path.join(PROVIDER, 'lib', 'task.mjs')).href);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASK_CLI = path.join(PROVIDER || '', 'lib', 'task.mjs');
const POLL_CLI = path.join(HERE, '..', 'poll.mjs');
const MIN = 60 * 1000;

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const writeCard = (id, fm) => fs.writeFileSync(path.join(TASKS, `${id}.md`), serializeFrontmatter(fm, 'body\n'), 'utf8');
const readFm = (id) => parseFrontmatter(fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8')).fm;
const writeRegistry = (entries) => fs.writeFileSync(path.join(ROOT, 'claude-sessions.json'), JSON.stringify(entries, null, 2), 'utf8');

const readyFm = (id, assignee = 'linus') => ({ id, title: 'dispatch-collision', assignee, status: 'ready', project: '__team__' });

/** 真实子进程跑 task.mjs dispatch；返回 { status, json } */
function dispatchCli(id, worker) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TASK_CLI, 'dispatch', id, worker], {
      env: { ...process.env, OPENCLAW_TEAM_ROOT: ROOT },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, json: JSON.parse(out.trim()) }));
  });
}

/** 真实子进程跑 poll.mjs；返回 { status, json } */
function pollCli(worker) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [POLL_CLI, worker], {
      env: { ...process.env, OPENCLAW_TEAM_ROOT: ROOT },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, json: JSON.parse(out.trim()) }));
  });
}

// ---- 对照（红：复现旧直派双唤醒机制，不改任何语义） ------------------------

test('对照·旧直派（裸 sessions_send 不 claim）：poll 仍见 ready 并领取 ⇒ 双唤醒', () => {
  const id = 'T-20260101-030001-control';
  writeCard(id, readyFm(id));
  // 旧直派 = 只发 sessions_send，不动卡（卡仍 ready）——此处模拟「未 claim」
  assert.equal(readFm(id).status, 'ready', '旧直派不写卡：卡仍 ready');

  const r = runPoll({ assignee: 'linus' });
  assert.equal(r.fire, true, 'poll 见 ready ⇒ 领取 ⇒ fire:true（双唤醒之一）');
  assert.equal(readFm(id).status, 'in_progress');
  assert.equal(readFm(id).claimed_by, 'linus');
});

// ---- 反证：dispatch-first（方案② 统一领取入口） -----------------------------

test('dispatch-first：task.dispatch claim-first 后 poll 不 fire（无双唤醒）', () => {
  const id = 'T-20260101-030002-dispfirst';
  writeCard(id, readyFm(id));

  const d = taskAcl.dispatch(id, 'linus');
  assert.equal(d.ok, true, `直派应 claim-first 成功，实际 ${JSON.stringify(d)}`);
  assert.equal(d.dispatched, true);
  assert.equal(readFm(id).status, 'in_progress', '直派已原子预占（in_progress）');
  assert.equal(readFm(id).claimed_by, 'linus');

  const claimedAt = readFm(id).claimed_at;
  const r = runPoll({ assignee: 'linus' });
  assert.equal(r.fire, false, `poll 应零唤醒，实际 ${JSON.stringify(r)}`);
  assert.equal(readFm(id).claimed_at, claimedAt, 'poll 不得改写 claimed_at（无双领）');
});

// ---- 反证：poll-first 顺序（poll 先领，直派据此放弃 sessions_send） ---------

test('poll-first：poll 先领 ⇒ dispatch 返回 dispatched:false（派单侧放弃唤醒）', () => {
  const id = 'T-20260101-030003-pollfirst';
  writeCard(id, readyFm(id));

  const r = runPoll({ assignee: 'linus' });
  assert.equal(r.fire, true, 'poll 先领');
  assert.equal(readFm(id).status, 'in_progress');

  const d = taskAcl.dispatch(id, 'linus');
  assert.equal(d.ok, false, `直派应让位，实际 ${JSON.stringify(d)}`);
  assert.equal(d.dispatched, false);
  assert.equal(d.reason, 'in_progress_fresh', 'in_progress+心跳新鲜 ⇒ 不重领（执行唯一性不变）');
});

// ---- 执行唯一性语义不变 ---------------------------------------------------

test('执行唯一性：dispatch 预占后二次 claim ⇒ in_progress_fresh（不重领）', () => {
  const id = 'T-20260101-030004-unique';
  writeCard(id, readyFm(id));

  assert.equal(taskAcl.dispatch(id, 'linus').ok, true);
  const c = taskAcl.claim(id, 'linus');
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'in_progress_fresh');
});

// ---- 跨 worker 隔离 -------------------------------------------------------

test('跨 worker：dispatch 给 turing ⇒ linus 的 poll 不 fire（assignee 隔离）', () => {
  const id = 'T-20260101-030005-cross';
  writeCard(id, readyFm(id, 'turing'));

  assert.equal(taskAcl.dispatch(id, 'turing').ok, true);
  const r = runPoll({ assignee: 'linus' });
  assert.equal(r.fire, false, '非 assignee 不领');
  assert.equal(readFm(id).claimed_by, 'turing');
});

// ---- 活跃子会话守卫复用（claim-guard 不绕过） ------------------------------

test('活跃子会话：dispatch 不越过 claim-guard（active_session 让位）', () => {
  const id = 'T-20260101-030006-active';
  writeCard(id, { ...readyFm(id), status: 'in_progress', claimed_by: 'linus', claimed_at: '2020-01-01T00:00:00.000Z', heartbeat_at: new Date(Date.now() - 45 * MIN).toISOString() });
  writeRegistry([{ task_id: id, owner: 'linus', phase: 'seg1', status: 'running', pid: process.pid, session_id: 'u-disp' }]);

  const d = taskAcl.dispatch(id, 'linus');
  assert.equal(d.ok, false);
  assert.equal(d.dispatched, false);
  assert.equal(d.reason, 'active_session', '有活跃子会话 ⇒ 不直派（复用 claim-guard）');
});

// ---- 非法入参 -------------------------------------------------------------

test('非法入参：dispatch 未知 worker ⇒ 拒绝且不写卡', () => {
  const id = 'T-20260101-030007-bad';
  writeCard(id, readyFm(id));
  const d = taskAcl.dispatch(id, 'nobody');
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'unknown_assignee:nobody');
  assert.equal(readFm(id).status, 'ready', '非法 worker 不写卡');
});

// ---- CLI（真实子进程） -----------------------------------------------------

test('CLI：task.mjs dispatch 成功 ⇒ 退出 0 + dispatched:true', async () => {
  const id = 'T-20260101-030008-cli';
  writeCard(id, readyFm(id));
  const { status, json } = await dispatchCli(id, 'linus');
  assert.equal(status, 0);
  assert.equal(json.ok, true);
  assert.equal(json.dispatched, true);
  assert.equal(readFm(id).claimed_by, 'linus');
});

test('CLI：task.mjs dispatch 已领卡 ⇒ 退出 0 + dispatched:false（决策成功，非错误）', async () => {
  const id = 'T-20260101-030009-cli2';
  writeCard(id, readyFm(id));
  assert.equal(taskAcl.dispatch(id, 'linus').ok, true);
  const { status, json } = await dispatchCli(id, 'linus');
  assert.equal(status, 0, '决策完成（让位）亦退出 0');
  assert.equal(json.dispatched, false);
  assert.equal(json.reason, 'in_progress_fresh');
});

// ---- 并发：dispatch × poll 同卡竞争 ⇒ 仅一条路径执行 -----------------------

test('并发：dispatch 与 poll 同卡竞争 ⇒ 恰好一条路径领取（不双唤醒）', async () => {
  // 隔离：清空共享 root 的遗留 ready 卡，确保 poll 只竞争本卡（前序测试遗留的 ready 卡会干扰 poll 判断）
  for (const f of fs.readdirSync(TASKS)) {
    if (f.endsWith('.md')) fs.unlinkSync(path.join(TASKS, f));
  }
  for (let i = 0; i < 3; i++) {
    const id = `T-20260101-04000${i}-race`;
    writeCard(id, readyFm(id));
    const [d, p] = await Promise.all([dispatchCli(id, 'linus'), pollCli('linus')]);
    const dispatchWon = d.json.dispatched === true;
    const pollWon = p.json.fire === true;
    assert.equal(
      dispatchWon !== pollWon,
      true,
      `恰好一条路径领取（dispatchWon=${dispatchWon}, pollWon=${pollWon}, dispatch=${JSON.stringify(d.json)}, poll=${JSON.stringify(p.json)}）`
    );
    const fm = readFm(id);
    assert.equal(fm.status, 'in_progress', '终态 in_progress');
    assert.equal(fm.claimed_by, 'linus');
  }
});
