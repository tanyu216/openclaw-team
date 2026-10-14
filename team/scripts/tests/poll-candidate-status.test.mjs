#!/usr/bin/env node
/**
 * poll-candidate-status.test.mjs — poll 自动候选面的状态归一（T-20261014-205709）
 *
 * 缺陷：`scanCandidates` 原判据为裸 `fm.status === 'ready'`，把**规范值** `todo` 挡在自动候选面外
 * （`claimCard` 早已归一 `todo|ready`，故端到端表现为「能领却永不被扫到」）。与 T-20261014-204530
 * 的 claim 守卫**同根**（同一状态字面量假设）。
 *
 * 覆盖 Acceptance ①「判据复用单一真源、无裸 ready 字面量」+ ②「A/B：todo 入 / ready 入 /
 * backlog·in_progress·终态不入」：
 * - 纯函数口径：todo 与 ready 同入候选面（reason=rank0），非 new 状态不入；
 * - 只读候选面（pollCandidates）/ 真实 poll CLI（runPoll）双读面一致；
 * - 端到端：todo 卡经 poll CLI 真被领取（fire:true ⇒ in_progress）；
 * - 源头断言：poll.mjs 源码不得再出现带引号的 `ready` 字面量（防回归到第二份状态表）。
 *
 * 风格对齐 poll-deploy.test.mjs：不 mock 内部函数——真实读写临时文件 + 真实子进程跑 CLI。
 * 运行：node --test scripts/tests/poll-candidate-status.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 定位携带 ACL 库的 provider 安装目录（与 archive.test.mjs / poll-deploy.test.mjs 同口径）。 */
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
let parseFrontmatter, serializeFrontmatter, NEW_STATUSES, isNewStatus, scanCandidates;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ parseFrontmatter, serializeFrontmatter, NEW_STATUSES, isNewStatus } = await import('../lib.mjs'));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL = path.join(HERE, '..', 'poll.mjs');
const POLL_URL = pathToFileURL(POLL).href;
const POLL_SRC = fs.readFileSync(POLL, 'utf8');
const FRESH = new Date().toISOString();

const scratchDirs = [];
/** 建临时 team-root（含 tasks/），返回 root */
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pcs-'));
  scratchDirs.push(root);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  return root;
}
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 写一张合成任务卡（默认 linus，status 由调用方给） */
function writeCard(root, id, fm) {
  const merged = { id, title: 'candidate-status-test', assignee: 'linus', project: '__team__', target: `/a/${id}`, created_at: FRESH, ...fm };
  const p = path.join(root, 'tasks', `${id}.md`);
  fs.writeFileSync(p, serializeFrontmatter(merged, 'body\n'), 'utf8');
  return p;
}

function readFm(root, id) {
  return parseFrontmatter(fs.readFileSync(path.join(root, 'tasks', `${id}.md`), 'utf8')).fm;
}

/** 以独立进程跑真实 poll CLI（OPENCLAW_TEAM_ROOT 指向临时 root），返回解析后的 JSON */
function runPollCli(root, agent = 'linus') {
  const out = execFileSync(process.execPath, [POLL, agent], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

/** 以独立进程跑真实 poll.mjs 的**只读候选面**（ACL `task.pollCandidates` 的上游） */
function runPollCandidates(root, agent = 'linus') {
  const code = `const m = await import(${JSON.stringify(POLL_URL)});console.log(JSON.stringify(m.pollCandidates(${JSON.stringify(agent)})));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

// ---- 单一真源 --------------------------------------------------------------

test('1. 单一真源：lib.mjs 导出 NEW_STATUSES/isNewStatus，值仍是 {todo,ready}', () => {
  assert.deepEqual([...NEW_STATUSES].sort(), ['ready', 'todo'], `状态表被改动，实际 ${JSON.stringify([...NEW_STATUSES])}`);
  assert.equal(isNewStatus('todo'), true, 'todo（规范值）应视为 new');
  assert.equal(isNewStatus('ready'), true, 'ready（兼容别名）应视为 new');
  for (const s of ['backlog', 'in_progress', 'in_review', 'blocked', 'done', 'canceled', '']) {
    assert.equal(isNewStatus(s), false, `${s || '(空)'} 不得视为 new`);
  }
});

test('2. 防回归：poll.mjs 源码内不得再出现带引号的 ready 字面量（无第二份状态表）', () => {
  const hits = POLL_SRC.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /['"]ready['"]/.test(line));
  assert.deepEqual(hits, [], `poll.mjs 仍含裸 ready 字面量：${JSON.stringify(hits)}`);
});

// ---- A/B：候选面口径 -------------------------------------------------------

test('3. todo 卡入自动候选面（修前不入 —— 本卡要修的行为），reason=rank0', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-100001-todo', { status: 'todo' });

  const out = runPollCandidates(root);
  assert.equal(out.ok, true);
  const c = out.candidates.find((x) => x.id === 'T-20260101-100001-todo');
  assert.ok(c, `status:todo 卡必须进候选面，实际 ${JSON.stringify(out)}`);
  assert.equal(c.status, 'todo');
  assert.equal(c.rank, 0, 'new 池 rank 应为 0（与 ready 同池）');
  assert.equal(c.reason, 'new');
});

test('4. ready 卡仍入候选面（兼容别名不回归），与 todo 同池同 rank', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-100002-rdy', { status: 'ready' });

  const out = runPollCandidates(root);
  assert.equal(out.ok, true);
  const c = out.candidates.find((x) => x.id === 'T-20260101-100002-rdy');
  assert.ok(c, `status:ready 卡必须仍在候选面，实际 ${JSON.stringify(out)}`);
  assert.equal(c.rank, 0);
  assert.equal(c.reason, 'new');
});

test('5. backlog / in_progress(心跳新鲜) / done / archived 仍不入候选面', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-100003-bkl', { status: 'backlog' });
  writeCard(root, 'T-20260101-100004-inp', {
    status: 'in_progress', claimed_by: 'linus', claimed_at: FRESH, heartbeat_at: FRESH,
  });
  writeCard(root, 'T-20260101-100005-don', { status: 'done' });
  writeCard(root, 'T-20260101-100006-arc', { status: 'archived' });

  const out = runPollCandidates(root);
  assert.equal(out.ok, true);
  assert.deepEqual(out.candidates, [], `非 new/非陈旧恢复状态不得入候选面，实际 ${JSON.stringify(out.candidates)}`);
});

test('6. 混合轮候选面：todo + ready 入列且按 created_at 升序，其余屏除', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-100011-a', { status: 'todo', created_at: '2026-01-01T00:00:01.000Z' });
  writeCard(root, 'T-20260101-100012-b', { status: 'ready', created_at: '2026-01-01T00:00:02.000Z' });
  writeCard(root, 'T-20260101-100013-c', { status: 'backlog', created_at: '2026-01-01T00:00:00.000Z' });

  const out = runPollCandidates(root);
  assert.deepEqual(out.candidates.map((c) => c.id), ['T-20260101-100011-a', 'T-20260101-100012-b']);
  assert.deepEqual(out.candidates.map((c) => c.rank), [0, 0], '两池同 rank ⇒ 仅按 created_at 升序');
});

// ---- 端到端：todo 卡真被领取 ----------------------------------------------

test('7. 端到端：唯一候选是 status:todo 卡 ⇒ poll 真领取（fire:true，卡转 in_progress）', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-100021-t1', { status: 'todo' });

  const out = runPollCli(root);
  assert.equal(out.fire, true, `todo 卡应可被自动领取，实际 ${JSON.stringify(out)}`);
  assert.deepEqual(out.state.cardIds, ['T-20260101-100021-t1']);
  const fm = readFm(root, 'T-20260101-100021-t1');
  assert.equal(fm.status, 'in_progress', '领取后应落 in_progress');
  assert.equal(fm.claimed_by, 'linus');
});

test('8. 端到端混合轮：todo + ready 同轮均领，backlog 不动', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-100022-t2', { status: 'todo', created_at: '2026-01-01T00:00:01.000Z' });
  writeCard(root, 'T-20260101-100023-r2', { status: 'ready', created_at: '2026-01-01T00:00:02.000Z' });
  writeCard(root, 'T-20260101-100024-b2', { status: 'backlog', created_at: '2026-01-01T00:00:03.000Z' });

  const out = runPollCli(root);
  assert.equal(out.fire, true, JSON.stringify(out));
  assert.deepEqual(out.state.cardIds, ['T-20260101-100022-t2', 'T-20260101-100023-r2'], 'todo 与 ready 同轮均领');
  assert.equal(readFm(root, 'T-20260101-100024-b2').status, 'backlog', 'backlog 不领');
});
