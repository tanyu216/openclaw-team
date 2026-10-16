#!/usr/bin/env node
/**
 * poll-run.test.mjs — T-20261013-041718：poll RUN 短跑契约 + run 上界（③ 负例/回归）
 *
 * 覆盖 Acceptance ②③：
 *   - poll run 的 payload 只做「移交」（spawn-lane detached），**不含**修复前的「就地执行」契约；
 *   - run 上界 **不得长于它所要保证的兜底节奏**（默认 = 1 个 poll interval，而非 3600s）；
 *   - 负例：`OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S` 非法值绝不放大为「无上界」；
 *   - 回归：「上一轮 run 未结束」（该 agent 仍有活跃子会话 / 已领卡在飞）⇒ 下一 tick **仍能推进**
 *     新落板 ready 卡的领取。
 *
 * 风格对齐 poll-multi/poll-guard：不 mock 内部函数——纯函数直接 import；行为用例真实读写
 * os.tmpdir() 临时 team-root + 真实子进程跑 poll CLI。provider ACL 库缺失时行为用例 SKIP。
 *
 * 运行：node --test team/scripts/tests/poll-run.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  HANDOFF_DIRECTIVE,
  FORBIDDEN_INLINE_PHRASE,
  pollRunMessage,
  parseIntervalSeconds,
  pollRunTimeoutS,
  DEFAULT_POLL_INTERVAL_S,
} from '../poll-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // team/scripts/tests
const SCRIPTS = path.join(HERE, '..');                     // team/scripts
const TEAM_DIR = path.join(SCRIPTS, '..');                 // <team> (repo/team, or ~/.openclaw/team live)

/**
 * `<repo>` = 拥有 `install.sh` 的框架检出。**install.sh 从不部署**（它住在仓里、驱动部署），
 * 所以任何对它的断言必须读**仓**而非实例；两种布局下 HERE/../../.. 指代不同：
 *   - 仓检出：  HERE = <repo>/team/scripts/tests ⇒ HERE/../../.. = <repo>（有 install.sh）；
 *   - 部署实例：HERE = <team>/scripts/tests       ⇒ HERE/../../.. = $OPENCLAW_HOME（无 install.sh）。
 * 显式解析（口径同 team/automations/dispatch.mjs 的 {repo} 解析）：先 $OPENCLAW_TEAM_REPO，再读
 * `<team>/.install-state.json.repoPath`；都没有再回退到布局猜测。
 */
function resolveRepoRoot() {
  let recorded = null;
  try {
    recorded = JSON.parse(fs.readFileSync(path.join(TEAM_DIR, '.install-state.json'), 'utf8')).repoPath;
  } catch { /* 无状态文件 / 不可读 ⇒ 忽略 */ }
  const guess = path.resolve(HERE, '..', '..', '..');
  for (const c of [process.env.OPENCLAW_TEAM_REPO, recorded, guess].filter(Boolean)) {
    if (fs.existsSync(path.join(c, 'install.sh'))) return c;
  }
  return guess;
}
const REPO = resolveRepoRoot();

/** 定位携带 ACL 库的 provider 安装目录（与 poll-multi/poll-guard 同口径）。 */
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

// ---- ② run 上界：默认 = 兜底节奏（红→绿的核心断言） ------------------------

test('pollRunTimeoutS: 默认 = 1 个 poll interval（绝不是 3600s 的旧默认）', () => {
  assert.equal(pollRunTimeoutS({ intervalSeconds: 120, env: {} }), 120, '2m 节奏 ⇒ run 上界 120s');
  assert.equal(pollRunTimeoutS({ intervalSeconds: 300, env: {} }), 300, '5m 节奏 ⇒ run 上界 300s');
  for (const iv of [60, 120, 300, 900]) {
    assert.ok(
      pollRunTimeoutS({ intervalSeconds: iv, env: {} }) <= iv,
      `run 上界必须 ≤ 它所要保证的兜底节奏（interval=${iv}s）`,
    );
  }
  assert.notEqual(pollRunTimeoutS({ intervalSeconds: 120, env: {} }), 3600, '修复前默认 3600s ⇒ run 可长驻一小时');
});

test('pollRunTimeoutS: 显式 env 覆盖 / 0 关闭 / 非法值回落（绝不放大为无上界）', () => {
  assert.equal(pollRunTimeoutS({ intervalSeconds: 300, env: { OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S: '600' } }), 600);
  assert.equal(pollRunTimeoutS({ intervalSeconds: 300, env: { OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S: '0' } }), 0, '0 = 关闭调度器超时');
  for (const bad of ['', '  ', 'abc', '-5', '30s', 'NaN', '1e3']) {
    assert.equal(
      pollRunTimeoutS({ intervalSeconds: 300, env: { OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S: bad } }),
      300,
      `非法值 ${JSON.stringify(bad)} 必须回落到 interval 默认，绝不读成「无上界」`,
    );
  }
  assert.equal(pollRunTimeoutS({ env: {} }), DEFAULT_POLL_INTERVAL_S, '未给 interval ⇒ 声明默认 300s');
  assert.equal(pollRunTimeoutS({ intervalSeconds: 0, env: {} }), DEFAULT_POLL_INTERVAL_S, 'interval 非正 ⇒ 默认');
  assert.equal(pollRunTimeoutS({ intervalSeconds: NaN, env: {} }), DEFAULT_POLL_INTERVAL_S);
});

test('parseIntervalSeconds: <n><s|m|h|d> 解析，非法 ⇒ null', () => {
  assert.equal(parseIntervalSeconds('90s'), 90);
  assert.equal(parseIntervalSeconds('2m'), 120);
  assert.equal(parseIntervalSeconds('5m'), 300);
  assert.equal(parseIntervalSeconds('1h'), 3600);
  assert.equal(parseIntervalSeconds('2d'), 172800);
  assert.equal(parseIntervalSeconds('5'), null, '缺单位 ⇒ 非法');
  assert.equal(parseIntervalSeconds('m'), null);
  assert.equal(parseIntervalSeconds('0m'), null, '0 ⇒ 非法（不是「无节奏」）');
  assert.equal(parseIntervalSeconds('5M'), null, '大写单位不收');
  assert.equal(parseIntervalSeconds(''), null);
  assert.equal(parseIntervalSeconds(undefined), null);
});

// ---- ③ payload：短跑移交，不是「就地执行」 --------------------------------

test('pollRunMessage: 只做移交（spawn-lane detached / 不等待 lane），不再要求就地执行', () => {
  const msg = pollRunMessage('turing', ['/t/tasks/T-1.md', '/t/tasks/T-2.md']);
  assert.ok(msg.includes(HANDOFF_DIRECTIVE), 'payload 必须携带单一真源的移交指令');
  assert.ok(msg.includes('spawn-lane'), 'payload 必须点名 spawn-lane（单一 spawn 入口）');
  assert.ok(msg.includes('detached'), 'payload 必须说明 detached（起后即返回）');
  assert.ok(/不要.*轮询到终态/.test(msg), 'payload 必须禁止在本 run 内把 lane 轮询到终态');
  assert.ok(msg.includes('已领 2 张'), '保留领取回执（poll-multi 契约）');
  for (const p of ['/t/tasks/T-1.md', '/t/tasks/T-2.md']) assert.ok(msg.includes(p), `payload 应列出 ${p}`);
  assert.equal(msg.includes(FORBIDDEN_INLINE_PHRASE), false, `payload 不得含修复前契约「${FORBIDDEN_INLINE_PHRASE}」`);
  assert.ok(msg.includes('T-20261013-041718'), 'payload 应留痕缺陷编号（可追溯到 run 锁机制）');
});

test('pollRunMessage: 空卡表（install.sh job 默认 message）也走同一短跑契约', () => {
  const msg = pollRunMessage('linus');
  assert.ok(msg.includes(HANDOFF_DIRECTIVE));
  assert.equal(msg.includes(FORBIDDEN_INLINE_PHRASE), false);
  assert.equal(msg.includes('本轮已领'), false, '无卡时不出现领取回执');
  assert.equal(msg.includes('勿再 claim'), false, '无卡时不宜称「勿再 claim」');
});

// ---- ② 接线：install.sh / poll.mjs 都用同一真源 ---------------------------

test('接线：install.sh 的 run 上界默认取自 poll-run.mjs，不再硬编码 3600', () => {
  const sh = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
  assert.ok(sh.includes('team/scripts/poll-run.mjs" timeout-default'), 'install.sh 应经 poll-run.mjs 派生默认上界');
  assert.equal(/POLL_RUN_TIMEOUT_S="\$\{OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S:-3600\}/.test(sh), false, '不得再硬编码 3600');
  assert.ok(sh.includes('team/scripts/poll-run.mjs" message'), 'install.sh 的 job message 应取同一文案真源');
  assert.equal(sh.includes('execute it via the task-interface ACL'), false, '旧「就地执行」job message 必须消失');
});

test('接线：poll.mjs 经 poll-run.mjs 组 payload，旧就地执行文案已消失', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'poll.mjs'), 'utf8');
  assert.ok(src.includes("from './poll-run.mjs'"), 'poll.mjs 应 import poll-run.mjs');
  assert.ok(src.includes('pollRunMessage('), 'poll.mjs 应用 pollRunMessage 组 message');
  assert.equal(src.includes(FORBIDDEN_INLINE_PHRASE), false, 'poll.mjs 不得残留旧就地执行文案');
});

test('CLI：message / timeout-default 可被 install.sh 调用', () => {
  const t = execFileSync(process.execPath, [path.join(SCRIPTS, 'poll-run.mjs'), 'timeout-default', '2m'], { encoding: 'utf8' });
  assert.equal(t.trim(), '120');
  const m = execFileSync(process.execPath, [path.join(SCRIPTS, 'poll-run.mjs'), 'message', 'jobs'], { encoding: 'utf8' });
  assert.ok(m.includes(HANDOFF_DIRECTIVE));
  assert.throws(
    () => execFileSync(process.execPath, [path.join(SCRIPTS, 'poll-run.mjs'), 'timeout-default', 'bogus'], { encoding: 'utf8', stdio: 'pipe' }),
    /Command failed|exit/,
    '非法 interval ⇒ 非零退出（不静默给个数）',
  );
});

// ---- ③ 行为回归：「上一轮 run 未结束」⇒ 下一 tick 仍能推进领取 ------------

let serializeFrontmatter;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ serializeFrontmatter } = await import('../lib.mjs'));
}

const scratchDirs = [];
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-prun-'));
  scratchDirs.push(root);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  return root;
}
function writeCard(root, id, fm = {}) {
  const merged = { id, title: 'poll-run-test', assignee: 'linus', status: 'ready', ...fm };
  fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), serializeFrontmatter(merged, 'body\n'), 'utf8');
}
function readFm(root, id) {
  const raw = fs.readFileSync(path.join(root, 'tasks', `${id}.md`), 'utf8');
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].replace(/^"|"$/g, '');
  }
  return fm;
}
function runPollCli(root, agent = 'linus') {
  const out = execFileSync(process.execPath, [path.join(SCRIPTS, 'poll.mjs'), agent], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}
const runningEntry = (taskId, extra = {}) => ({
  task_id: taskId, owner: 'linus', phase: 'seg1', status: 'running', pid: process.pid,
  session_id: `u-${taskId}`, ...extra,
});

test('回归：上一轮 run 未结束（在飞卡有活跃子会话）⇒ 下一 tick 仍领新 ready 卡', { skip: SKIP }, () => {
  const root = mkRoot();
  // 上一轮：A 已领且在飞（in_progress + 活跃子会话 = 上一轮 run 尚未结束）
  writeCard(root, 'T-20261013-900001-inflight', { status: 'in_progress', claimed_by: 'linus', heartbeat_at: '2020-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(root, 'claude-sessions.json'), JSON.stringify([runningEntry('T-20261013-900001-inflight')], null, 2), 'utf8');
  // 下一 tick 前新落板：B ready（唯一前置满足）
  writeCard(root, 'T-20261013-900002-fresh', { status: 'ready', project: '__team__', target: '/t/fresh', created_at: '2026-10-13T00:00:02.000Z' });

  const out = runPollCli(root);
  assert.equal(out.fire, true, `在飞卡不应阻塞新卡的领取，实际 ${JSON.stringify(out)}`);
  assert.deepEqual(out.state.cardIds, ['T-20261013-900002-fresh'], '只领新 ready 卡');
  assert.equal(readFm(root, 'T-20261013-900002-fresh').status, 'in_progress', '新卡必须被领');
  assert.equal(readFm(root, 'T-20261013-900001-inflight').claimed_by, 'linus', '在飞卡不被重领/不改写');
  // A 被防双跑守卫跳过（上一轮 run 未结束），但**不阻塞**同轮 B
  assert.ok(out.state.skipped.includes('T-20261013-900001-inflight'), '在飞卡记入 skipped（防双跑），而非阻塞整轮');
  assert.ok(out.message.includes('spawn-lane'), '本轮 payload 仍是短跑移交契约');
});

test('回归：额度内且无可领卡时零成本空转不受影响', { skip: SKIP }, () => {
  const root = mkRoot();
  const out = runPollCli(root);
  assert.equal(out.fire, false);
});
