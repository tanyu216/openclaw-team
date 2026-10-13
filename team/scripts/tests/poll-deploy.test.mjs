#!/usr/bin/env node
/**
 * poll-deploy.test.mjs — poll 候选面排除部署类卡（`kind:deploy`）测试（T-20261014-013629-2）
 *
 * 覆盖 Acceptance ①「poll 消费面对 deploy 卡不自动领取」：
 * 排除（ready 池 + 陈旧恢复池）/ 只读候选面（pollCandidates）一致 / 显式领取路径不拒（不锁死派发）/
 * 缺省与 `task` kind 不误伤。
 *
 * 风格对齐 poll-multi.test.mjs：不 mock 内部函数——真实读写 os.tmpdir() 临时文件 + 真实子进程跑 CLI。
 * 运行：node --test scripts/tests/poll-deploy.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 定位携带 ACL 库的 provider 安装目录（与 archive.test.mjs / poll-multi.test.mjs 同口径）。 */
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
let parseFrontmatter, serializeFrontmatter, AUTO_CLAIM_EXCLUDED_KINDS, isAutoClaimableKind;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ parseFrontmatter, serializeFrontmatter, AUTO_CLAIM_EXCLUDED_KINDS, isAutoClaimableKind } = await import('../lib.mjs'));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL = path.join(HERE, '..', 'poll.mjs');
const CLAIM = path.join(HERE, '..', 'claim.mjs');
const POLL_URL = pathToFileURL(POLL).href;
const OLD = '2020-01-01T00:00:00.000Z'; // >6h 前 ⇒ 陈旧恢复池

const scratchDirs = [];
/** 建临时 team-root（含 tasks/），返回 root */
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pd-'));
  scratchDirs.push(root);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  return root;
}
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 写一张合成任务卡（默认 linus + ready，可覆盖字段） */
function writeCard(root, id, fm = {}) {
  const merged = { id, title: 'deploy-test', assignee: 'linus', status: 'ready', ...fm };
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

/** 以独立进程跑真实显式领取 CLI，返回 { status, json } */
function runClaimCli(root, cardPath, agent = 'linus') {
  try {
    const out = execFileSync(process.execPath, [CLAIM, cardPath, agent], {
      env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
      encoding: 'utf8',
    });
    return { status: 0, json: JSON.parse(out.trim()) };
  } catch (e) {
    return { status: e.status, json: JSON.parse(String(e.stdout || '').trim() || '{}') };
  }
}

// ---- 排除：ready 池 --------------------------------------------------------

test('1. ready 池：唯一候选是 deploy 卡 ⇒ fire:false，卡不动（未领取）', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-600001-dp1', { kind: 'deploy', project: '__team__', target: '/live/team' });

  const out = runPollCli(root);
  assert.equal(out.fire, false, `deploy 卡不得触发领取，实际 ${JSON.stringify(out)}`);
  assert.equal(out.state, undefined, '未领取 ⇒ 无 state');
  const fm = readFm(root, 'T-20260101-600001-dp1');
  assert.equal(fm.status, 'ready', 'deploy 卡应仍 ready');
  assert.ok(!fm.claimed_by, 'deploy 卡不应被 claimed_by 落章');
});

test('2. 混合轮：deploy + 普通卡 ⇒ 只领普通卡，deploy 既不领也不记 skipped', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-600002-dp2', { kind: 'deploy', project: '__team__', target: '/live/team', created_at: '2026-01-01T00:00:01.000Z' });
  writeCard(root, 'T-20260101-600003-n1', { project: '__team__', target: '/a/n1', created_at: '2026-01-01T00:00:02.000Z' });

  const out = runPollCli(root);
  assert.equal(out.fire, true, JSON.stringify(out));
  assert.deepEqual(out.state.cardIds, ['T-20260101-600003-n1'], '只领普通卡');
  assert.equal(readFm(root, 'T-20260101-600003-n1').status, 'in_progress');
  assert.equal(readFm(root, 'T-20260101-600002-dp2').status, 'ready', 'deploy 卡不领');
  assert.ok(!out.state.skipped.includes('T-20260101-600002-dp2'), 'deploy 卡不进 skipped（它是候选面排除，不是冲突/守卫跳过）');
});

// ---- 排除：陈旧恢复池 ------------------------------------------------------

test('3. 陈旧恢复池：in_progress + 心跳 >6h 的 deploy 卡也不重领', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-600004-dp3', {
    kind: 'deploy', status: 'in_progress', claimed_by: 'linus', claimed_at: OLD, heartbeat_at: OLD,
    project: '__team__', target: '/live/team',
  });

  const out = runPollCli(root);
  assert.equal(out.fire, false, `陈旧 deploy 卡不得被恢复重领，实际 ${JSON.stringify(out)}`);
  const fm = readFm(root, 'T-20260101-600004-dp3');
  assert.equal(fm.status, 'in_progress');
  assert.equal(fm.claimed_by, 'linus', 'claimed_by 不应被改写');
  assert.equal(fm.heartbeat_at, OLD, 'heartbeat_at 不应被刷新');
});

// ---- 只读候选面一致 --------------------------------------------------------

test('4. 只读候选面 pollCandidates：排除 deploy，普通卡仍在列（ACL 上游同源）', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-600005-dp4', { kind: 'deploy', project: '__team__', target: '/live/team' });
  writeCard(root, 'T-20260101-600006-n2', { project: '__team__', target: '/a/n2' });

  const out = runPollCandidates(root);
  assert.equal(out.ok, true);
  const ids = out.candidates.map((c) => c.id);
  assert.deepEqual(ids, ['T-20260101-600006-n2'], `候选面应只剩普通卡，实际 ${JSON.stringify(ids)}`);
});

// ---- 显式派发不锁死 --------------------------------------------------------

test('5. 显式派发仍可用：显式领取 ready deploy 卡成功（不因标记被拒）', () => {
  const root = mkRoot();
  const p = writeCard(root, 'T-20260101-600007-dp5', { kind: 'deploy', project: '__team__', target: '/live/team' });

  const r = runClaimCli(root, p);
  assert.equal(r.status, 0, `显式领取应成功，实际 ${JSON.stringify(r)}`);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(r.json.mode, 'new');
  assert.equal(readFm(root, 'T-20260101-600007-dp5').status, 'in_progress');
  assert.equal(readFm(root, 'T-20260101-600007-dp5').kind, 'deploy', 'kind 保持 deploy');
});

// ---- 不误伤 ----------------------------------------------------------------

test('6. 不误伤：缺省 kind 与 kind:task 仍自动领取（纯函数口径同判）', () => {
  const root = mkRoot();
  writeCard(root, 'T-20260101-600008-k0', { project: '__team__', target: '/a/k0', created_at: '2026-01-01T00:00:01.000Z' });
  writeCard(root, 'T-20260101-600009-k1', { kind: 'task', project: '__team__', target: '/a/k1', created_at: '2026-01-01T00:00:02.000Z' });
  writeCard(root, 'T-20260101-600010-ep1', { kind: 'epic', project: '__team__', target: '/a/ep1', created_at: '2026-01-01T00:00:03.000Z' });

  const out = runPollCli(root);
  assert.equal(out.fire, true, JSON.stringify(out));
  assert.deepEqual(out.state.cardIds, ['T-20260101-600008-k0', 'T-20260101-600009-k1'], '缺省/task 仍领，epic 仍被领取门拒');
  assert.deepEqual(out.state.failed, ['T-20260101-600010-ep1'], 'epic 走 claimCard 的 epic_container（既有语义不变）');

  assert.deepEqual([...AUTO_CLAIM_EXCLUDED_KINDS], ['deploy'], '排除集只含 deploy');
  assert.equal(isAutoClaimableKind({ kind: 'deploy' }), false);
  assert.equal(isAutoClaimableKind({ kind: 'task' }), true);
  assert.equal(isAutoClaimableKind({}), true, 'kind 缺省 ⇒ 视作 task');
  assert.equal(isAutoClaimableKind({ kind: 'epic' }), true, 'epic 不在此判定（它由 claimCard 拒领，分层不同）');
});
