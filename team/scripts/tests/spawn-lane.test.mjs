#!/usr/bin/env node
/**
 * spawn-lane.test.mjs — VENDORED copy of the live `spawn-lane` entry suite
 * (T-20261010-052210 / T-20261010-084051).
 *
 * Style: no internal mocks. The vendored entries link the provider ACL library at
 * `{team}/skills/task-ops/lib/` (provider-owned and intentionally NOT vendored — see
 * skills/PROVENANCE.md), so they only execute in a DEPLOYED layout
 * (`{team}/scripts/**` + `{team}/skills/task-ops/**`). This test materialises exactly
 * that layout in a temp dir (the vendored `.mjs` entries + a symlink to the provider
 * ACL) and exercises the vendored entry with real files and real subprocesses.
 * When no provider install is present it SKIPS with a reason instead of reporting a
 * false failure — the vendored bytes are still covered by `node --check` and by the
 * install-side bundle checks.
 *
 * Coverage (red→green) = the two framework gaps closed by T-20261010-084051:
 *   项1 review lanes through the single entry (`role=review` / `--review`);
 *   项2 the idempotent `workspace/<id>/.claude/settings.json` preset
 *       (no more "Settings file not found" instant exit on the first spawn).
 *
 * Run: node --test team/scripts/tests/spawn-lane.test.mjs
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const SCRIPTS = path.join(HERE, '..');                     // <repo>/team/scripts

/** Locate a provider install that carries the ACL library the entries import. */
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

/** Materialise a deployed team layout: vendored scripts/ + skills/task-ops + tasks/ workspace/. */
const LAYOUT = PROVIDER ? (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-spawnlane-'));
  for (const d of ['scripts', 'tasks', 'tasks/.locks', 'workspace', 'skills', 'bin']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
  }
  fs.symlinkSync(PROVIDER, path.join(root, 'skills', 'task-ops'), 'dir');
  return root;
})() : null;

// 这些名字在 live 版里是模块级常量；此处由受保护的 setup 赋值（无 provider ⇒ 保持 undefined，
// 但那时所有 test 都 SKIP，回调不会执行）。
let TASKS, WS, BIN, REG, STUB, CODEX_STUB;
let spawnLane, parseArgs, buildCommand, buildPrompt, cardBranchName, resolveCardBranch, reviewSettings, sessionIdFor, sessionSet, checkSessions, checkHandoff, anchorGaps, upsertSessionEntry;
let spawnRunningCount, pollRunningCount, pollClaimBudget;

if (LAYOUT) {
  TASKS = path.join(LAYOUT, 'tasks');
  WS = path.join(LAYOUT, 'workspace');
  BIN = path.join(LAYOUT, 'bin');
  REG = path.join(LAYOUT, 'claude-sessions.json');
  process.env.OPENCLAW_TEAM_ROOT = LAYOUT;

  const staged = (rel) => import(pathToFileURL(path.join(LAYOUT, rel)).href);
  ({ spawnLane, parseArgs, buildCommand, buildPrompt, cardBranchName, resolveCardBranch, reviewSettings, runningCount: spawnRunningCount } = await staged('scripts/spawn-lane.mjs'));
  ({ runningCount: pollRunningCount, claimBudget: pollClaimBudget } = await staged('scripts/poll.mjs'));
  ({ sessionIdFor, sessionSet } = await staged('skills/task-ops/lib/task.mjs'));
  ({ checkSessions } = await staged('scripts/check-sessions.mjs'));
  ({ checkHandoff, anchorGaps } = await staged('scripts/check-handoff.mjs'));
  ({ upsertSessionEntry } = await staged('scripts/registry.mjs'));

  // 假 claude：复刻真实 `claude --settings <p>` 的前置校验（文件缺失 ⇒ 秒退「Settings file not found」），
  // 通过后写一行 NDJSON（模拟 stream-json）并保持存活，便于 pid 存活判定/registry_only 反证。
  STUB = path.join(BIN, 'claude-stub');
  fs.writeFileSync(STUB, [
    '#!/bin/sh',
    '# 前置校验（复刻真实 claude）：--settings 指向的文件必须存在，否则秒退',
    'settings=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "--settings" ]; then settings="$a"; fi',
    '  prev="$a"',
    'done',
    'if [ -n "$settings" ] && [ ! -f "$settings" ]; then',
    '  echo "Settings file not found: $settings" >&2',
    '  exit 1',
    'fi',
    'echo \'{"type":"system","subtype":"init"}\'',
    'echo "$@" >> "$0.args"',
    'sleep 60',
    '',
  ].join('\n'));
  fs.chmodSync(STUB, 0o755);
  process.env.OPENCLAW_CLAUDE_BIN = STUB;
  // 本套件真起 lane（stub）：关掉会话终态看守（`lane-reaper`）——否则每条 stub lane 各留一个看守
  // 进程活到套件收尾之后（本套件测的是入口校验/登记面；终态收口由 lane-reaper.test.mjs 覆盖）。
  process.env.OPENCLAW_TEAM_REAPER = '0';

  // 假 codex（复核 lane backend=codex）：无 --settings 前置校验，起后写 init 行并保持存活
  CODEX_STUB = path.join(BIN, 'codex-stub');
  fs.writeFileSync(CODEX_STUB, '#!/bin/sh\necho \'{"type":"system","subtype":"init"}\'\necho "$@" >> "$0.args"\nsleep 60\n');
  fs.chmodSync(CODEX_STUB, 0o755);
  process.env.OPENCLAW_CODEX_BIN = CODEX_STUB;
}

/** 轮询等待（stub 子进程异步写文件 ⇒ 避免断言与子进程竞态）；超时返回 false（默认 10s：全量并行跑时有富余） */
async function waitFor(fn, { timeout = 10000, step = 25 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

const spawnPids = [];
after(() => {
  for (const p of spawnPids) { try { process.kill(p, 'SIGTERM'); } catch { /* 已退出 */ } }
  if (LAYOUT) fs.rmSync(LAYOUT, { recursive: true, force: true });
});
beforeEach(() => {
  // 无 provider ⇒ LAYOUT/TASKS 未定义，本回调**不得执行**（与上面的 `after` 同一条护栏）。
  // 这个假设曾经自动成立（当时本文件每个 test 都带 `{ skip: SKIP }`），但 82adb81 加的 buildPrompt
  // 五例没带 ⇒ 在无 provider 的检出（仓内模式 / 新鲜克隆 / 贡献者）里回调先炸，慢段整段读红
  // （`fs.readdirSync(undefined)`，5 例）——正是「环境缺失被读成红」这一族。加了护栏 + 那五例补
  // `{ skip: SKIP }`（它们**结构上**就需要 provider：spawn-lane.mjs 静态 import ACL）后，
  // 无 provider 下本文件回到「全 SKIP、0 fail」。
  if (!LAYOUT) return;
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.rmSync(REG, { force: true });
});

function writeCard(id, { status = 'in_progress', claimed = 'linus', assignee = 'linus', segs = [], target = '' } = {}) {
  const body = `## Background\nx\n## Acceptance\n- [ ] a\n## Progress\n## Comments\n## Sessions\n${segs.join('\n')}\n## Report\n`;
  fs.writeFileSync(
    path.join(TASKS, `${id}.md`),
    `---\nid: ${id}\ntitle: spawn-lane test\nassignee: ${assignee}\nstatus: ${status}\n` +
    `goal: g\nproject: __team__\ntarget: ${target}\nclaimed_by: ${claimed}\nheartbeat_at: 2026-01-01T00:00:00.000Z\n---\n${body}`
  );
}
const writeHandoff = (id, content) => {
  fs.mkdirSync(path.join(WS, id), { recursive: true });
  fs.writeFileSync(path.join(WS, id, 'handoff.md'), content);
};

/** 真 git 仓 fixture（`--show-toplevel` / 分支解析用）；每个调用独立目录。 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};
function mkRepo(id) {
  const dir = path.join(LAYOUT, `repo-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr || r.error}`);
    return String(r.stdout || '').trim();
  };
  git('init', '-q', '-b', 'dev');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.com');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'base');
  return { dir, git };
}
const cardRaw = (id) => fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8');
const registryEntries = (id) => (fs.existsSync(REG) ? JSON.parse(fs.readFileSync(REG, 'utf8')).filter((e) => e.task_id === id) : []);

const CANON = '<!-- HANDOFF:v1 -->\n# Handoff\n## 任务卡\n- Goal: g\n## 上段结论（Report 摘要）\n（无）\n## 讨论/决策（Comments 摘要）\n（无）\n## state.md\n- 路径: /x\n';
const HANDWRITTEN = '# 手写 handoff\n无四锚\n';
/** 在审卡的典型形态：执行 lane（linus）已 closed 的登记行（复核 lane 不得覆盖它） */
const SEG1_LINUS_CLOSED = '- seg:seg1 · owner:linus · backend:claude · id:11111111-1111-5111-8111-111111111111 · phase:seg1 · status:closed · pid: · 2026-01-01T00:00:00.000Z';

// ── 红：绕过 ACL 直跑 spawn 的后果（门禁能拦/立即诊断） ───────────────────────

test('RED-1. 直跑 spawn 的典型残留（registry running+存活 / 卡 Sessions 空 / 手写 handoff）⇒ 门禁立即诊断', { skip: SKIP }, () => {
  const id = 'T-20260101-100001-red';
  writeCard(id, { segs: [] });              // 卡内 ## Sessions 空
  writeHandoff(id, HANDWRITTEN);            // 手写件，缺四锚
  // 模拟「只写了 registry」：running + pid 存活（用本进程 pid 保证存活）
  upsertSessionEntry({ task_id: id, owner: 'linus', phase: 'seg1', status: 'running', pid: process.pid, session_id: 'aaaa1111-2222-3333-4444-555555555555', startedAt: 'x' });

  const sess = checkSessions();
  assert.equal(sess.ok, false, `check-sessions 应硬失败，实际 ${JSON.stringify(sess)}`);
  assert.ok(sess.inconsistencies.some((x) => x.type === 'registry_only' && x.task === id), JSON.stringify(sess.inconsistencies));

  const ho = checkHandoff();
  assert.equal(ho.ok, false, `check-handoff 应报缺锚，实际 ${JSON.stringify(ho)}`);
  assert.ok(ho.failures.some((x) => x.id === id && x.type === 'anchors'));
  assert.equal(anchorGaps(HANDWRITTEN).length, 5);
});

test('RED-2. 入口自检：handoff 缺锚 ⇒ 拒绝起会话（不写 registry、不产生 spawn 日志）', { skip: SKIP }, () => {
  const id = 'T-20260101-100002-red';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [] });
  writeHandoff(id, HANDWRITTEN);

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^handoff_anchor_missing:/);
  assert.ok(r.handoff.missing.includes('HANDOFF:v1'));
  assert.equal(registryEntries(id).length, 0, '拒绝时不得写 registry');
  assert.equal(fs.existsSync(path.join(WS, id, 'linus-1.out.jsonl')), false, '拒绝时不得起进程');
});

// ── 绿：走入口一次到位（--dry-run 只校验；real 用 stub backend） ─────────────

test('GREEN-1. --dry-run：只校验 + 打印计划，不起进程、不写 registry/卡/handoff', { skip: SKIP }, () => {
  const id = 'T-20260101-100003-green-dry';
  writeCard(id, { status: 'ready', claimed: '', segs: [] }); // 未领取
  const expectSid = sessionIdFor(id, 'linus', 'seg1').session_id;

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.dryRun, true);
  assert.equal(r.pid, null);
  assert.equal(r.role, 'exec', '默认角色应为执行 lane');
  assert.equal(r.settings, 'would_create', 'settings 缺失时 dry-run 只预演不落盘');
  assert.equal(r.session_id, expectSid, 'session id 应走 ACL 确定性 UUIDv5');
  assert.equal(r.cwd, LAYOUT, 'project=__team__ ⇒ cwd = team 根');
  assert.equal(r.handoff, 'would_create');
  assert.ok(Array.isArray(r.cmd) && r.cmd.includes('--session-id') && r.cmd.includes(expectSid));
  assert.deepEqual(r.claims, ['would_claim']);
  // 零副作用
  assert.equal(fs.existsSync(REG), false, 'dry-run 不得写 registry');
  assert.equal(cardRaw(id).includes('status: ready'), true, 'dry-run 不得改卡');
  assert.equal(fs.existsSync(path.join(WS, id, 'handoff.md')), false, 'dry-run 不得生成 handoff');
});

test('GREEN-2. 真实起会话（stub backend）⇒ 卡 Sessions + registry + 规范 handoff 一次到位', { skip: SKIP }, () => {
  const id = 'T-20260101-100004-green';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [] }); // handoff 缺失，由入口生成

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  if (r.pid) spawnPids.push(r.pid);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(typeof r.pid, 'number');
  assert.equal(r.handoff, 'created', '缺失 handoff 应由入口经 ACL 生成');
  assert.equal(r.settings, 'created', '缺失 settings 应由入口幂等预置');
  assert.equal(r.registry.ok, true);

  // 卡：## Sessions 有该 seg 行（id + pid 存活）
  const raw = cardRaw(id);
  assert.match(raw, /- seg:seg1 /);
  assert.match(raw, new RegExp(`id:${r.session_id}`));
  assert.match(raw, new RegExp(`pid:${r.pid}(\\b|\\s)`));

  // registry：同写 running + pid
  const e = registryEntries(id);
  assert.equal(e.length, 1, JSON.stringify(e));
  assert.equal(e[0].session_id, r.session_id);
  assert.equal(e[0].pid, r.pid);
  assert.equal(e[0].status, 'running');

  // 规范 handoff（四锚齐）
  assert.equal(anchorGaps(fs.readFileSync(path.join(WS, id, 'handoff.md'), 'utf8')).length, 0);

  // 门禁全绿：无 registry_only、无缺锚
  const sess = checkSessions();
  assert.equal(sess.ok, true, `不应有 registry_only，实际 ${JSON.stringify(sess)}`);
  assert.equal(sess.inconsistencies.length, 0);
  const ho = checkHandoff();
  assert.equal(ho.ok, true, `handoff 应规范，实际 ${JSON.stringify(ho)}`);

  // 子会话产物落地（stdout → out.jsonl）
  assert.equal(fs.existsSync(r.log), true, '子会话输出应先落文件');
});

test('GREEN-3. status=ready 未领取 ⇒ 入口自动 claim 后起会话（卡转 in_progress/claimed_by=owner）', { skip: SKIP }, () => {
  const id = 'T-20260101-100005-green-claim';
  writeCard(id, { status: 'ready', claimed: '', segs: [] });

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  if (r.pid) spawnPids.push(r.pid);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.claims.some((x) => String(x).startsWith('claimed:')));
  const raw = cardRaw(id);
  assert.equal(/^status: in_progress$/m.test(raw), true, '卡应转 in_progress');
  assert.equal(/^claimed_by: linus$/m.test(raw), true);
});

// ── 拒绝分支 ────────────────────────────────────────────────────────────────

test('REJECT. 并发额度：running(linus)>=8 ⇒ 拒绝', { skip: SKIP }, () => {
  const id = 'T-20260101-100006-cap';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [] });
  for (let i = 0; i < 8; i++) {
    upsertSessionEntry({ task_id: `T-20260101-2000${String(i).padStart(2, '0')}-cap`, owner: 'linus', phase: 'p', status: 'running', pid: process.pid, session_id: `00000000-0000-4000-8000-00000000000${i}`, startedAt: 'x' });
  }
  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^concurrency_cap\(/);
});

test('REJECT. 并发额度：canonical running(turing)>=3 ⇒ 拒绝（T-20261014-011235 计数源）', { skip: SKIP }, () => {
  const id = 'T-20260101-100030-cap-turing';
  writeCard(id, { status: 'in_progress', claimed: 'turing', assignee: 'turing', segs: [] });
  for (let i = 0; i < 3; i++) {
    upsertSessionEntry({ task_id: `T-20260101-2010${String(i).padStart(2, '0')}-tcap`, owner: 'turing', phase: 'p', status: 'running', pid: process.pid, session_id: `00000000-0000-4000-8000-00000000010${i}`, startedAt: 'x' });
  }
  const r = spawnLane({ card: id, owner: 'turing', seg: 'seg1', backend: 'codex', dryRun: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^concurrency_cap\(owner=turing,running=3,cap=3\)/);
});

test('UNIT. 计数源同口径：poll.runningCount ≡ spawn-lane.runningCount（canonical，含 turing）', { skip: SKIP }, () => {
  const reg = [
    { task_id: 'T-1', owner: 'turing', phase: 'seg1', status: 'running', pid: process.pid, session_id: 's1' },
    { task_id: 'T-2', owner: 'turing', phase: 'seg1', status: 'running', pid: process.pid, session_id: 's2' },
    { task_id: 'T-3', owner: 'linus', phase: 'seg1', status: 'running', pid: process.pid, session_id: 's3' },
    { task_id: 'T-4', owner: 'turing', phase: 'seg1', status: 'done', pid: process.pid, session_id: 's4' },   // 非 running 不计
    { task_id: 'T-5', owner: 'turing', phase: 'seg1', status: 'running', pid: 999999999, session_id: 's5' }, // 死 pid 不计
  ];
  for (const owner of ['turing', 'linus', 'jobs']) {
    assert.equal(pollRunningCount(owner, { registry: reg }), spawnRunningCount(owner, { registry: reg }), `${owner}：两入口计数须同口径`);
  }
  assert.equal(pollRunningCount('turing', { registry: reg }), 2, 'canonical 2 条 live turing');
  assert.equal(pollClaimBudget('turing', { registry: reg }), 1, '3 − 2 = 1');
});

test('REJECT. claimed_by 不符 ⇒ 拒绝', { skip: SKIP }, () => {
  const id = 'T-20260101-100007-mismatch';
  writeCard(id, { status: 'in_progress', claimed: 'jobs', assignee: 'jobs', segs: [] });
  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^claimed_by_mismatch/);
});

test('REJECT. 非法 owner / backend ⇒ 用法错误（code 2）', { skip: SKIP }, () => {
  const id = 'T-20260101-100008-usage';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [] });
  assert.equal(spawnLane({ card: id, owner: 'nobody', seg: 'seg1', backend: 'claude' }).code, 2);
  assert.equal(spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'gpt' }).code, 2);
  assert.equal(spawnLane({ card: '', owner: 'linus' }).code, 2);
});

test('REJECT. 状态不可起（in_review/done）⇒ status_not_spawnable', { skip: SKIP }, () => {
  const id = 'T-20260101-100009-done';
  writeCard(id, { status: 'done', claimed: 'linus', segs: [] });
  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^status_not_spawnable/);
});

test('兼容. 已登记 seg（session-set 路径）与入口生成同 id ⇒ 一致性（resume 依据）', { skip: SKIP }, () => {
  const id = 'T-20260101-100010-compat';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [] });
  const sid = sessionIdFor(id, 'linus', 'seg1').session_id;
  sessionSet(id, { seg: 'seg1', owner: 'linus', phase: 'seg1', pid: process.pid, status: 'running', id: sid });
  const raw = cardRaw(id);
  assert.match(raw, new RegExp(`id:${sid}`), 'ACL session-id 与 session-set 落卡应同源');
  assert.equal(checkSessions().ok, true);
});

test('UNIT. parseArgs：--review 等价 role=review；未给 seg 时留空交给 spawnLane 取默认', { skip: SKIP }, () => {
  assert.equal(parseArgs(['C', 'turing', '--review', 'backend=codex']).role, 'review');
  assert.equal(parseArgs(['C', 'turing']).role, 'exec', '默认角色 = exec');
  assert.equal(parseArgs(['C', 'turing']).seg, '', '未显式 seg ⇒ 留空（由 spawnLane 按 role 取默认）');
  assert.equal(parseArgs(['C', 'turing', 'seg=seg2']).seg, 'seg2', '显式 seg 优先');
  assert.equal(parseArgs(['C', 'turing', '--bogus']).ok, false, '未知旗标 ⇒ 用法错误');
  // 裸位置参数（T-20261012-022948-2 实证）：把 `--dry-run` 误写成 `dry-run` 曾被静默吞掉 ⇒ 真起会话。
  assert.equal(parseArgs(['C', 'turing', 'dry-run']).ok, false, '多余裸位置参数 ⇒ 用法错误（绝不静默忽略）');
  assert.equal(parseArgs(['C', 'turing', 'dry-run']).reason, 'unexpected_positional:dry-run');
  // 隔离/定基旗标已随隔离机制移除 ⇒ 现在都是**未知旗标**（exit 2），绝不静默忽略：
  // 误传 `--base` 却以为钉住了基准，正是「未确认读成已确认」那类失败模式。
  assert.equal(parseArgs(['C', 'turing', '--no-isolate']).ok, false, '--no-isolate 已移除 ⇒ 未知旗标');
  assert.equal(parseArgs(['C', 'turing', '--no-isolate']).reason, 'unknown_flag:--no-isolate');
  assert.equal(parseArgs(['C', 'turing', '--base', 'abc123']).ok, false, '--base 已移除 ⇒ 未知旗标');
  assert.equal(parseArgs(['C', 'turing']).base, undefined, '解析结果不再有 base 字段');
  assert.equal(parseArgs(['C', 'turing']).isolate, undefined, '解析结果不再有 isolate 字段');
});

// ── 项2：settings 预置（幂等；消除「Settings file not found」秒退） ─────────────

test('RED-3. 缺失 --settings 目标 ⇒ 假 claude（复刻真实前置校验）秒退「Settings file not found」', { skip: SKIP }, () => {
  const missing = path.join(WS, 'T-20260101-900001-nosettings', '.claude', 'settings.json');
  const r = spawnSync(STUB, ['-p', 'x', '--settings', missing], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, '缺 settings 应非零退出（秒退）');
  assert.match(r.stderr, /Settings file not found/, r.stderr);
  assert.ok(r.stderr.includes(missing), `stderr 应点名缺失路径，实际 ${r.stderr}`);
});

test('GREEN-4. settings 预置：首次真实起会话 ⇒ settings=created、文件为合法 JSON、stub 不再秒退', { skip: SKIP }, async () => {
  const id = 'T-20260101-100011-settings';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [] });

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  if (r.pid) spawnPids.push(r.pid);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.settings, 'created', '缺 settings 时入口应预置');
  const sp = path.join(WS, id, '.claude', 'settings.json');
  assert.equal(fs.existsSync(sp), true);
  const parsed = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.ok(Array.isArray(parsed.permissions.allow), '预置件应含 permissions.allow');
  assert.ok(parsed.permissions.allow.includes('Write'));
  assert.ok(r.cmd.includes(sp), '--settings 应指向刚预置的文件');

  // 绿：stub 过了前置校验（写出 init 行），且未报 Settings file not found
  assert.equal(await waitFor(() => fs.existsSync(r.log) && fs.readFileSync(r.log, 'utf8').includes('"subtype":"init"')),
    true, 'stub 应正常起会话并写出 init 行');
  assert.equal(fs.readFileSync(r.errlog, 'utf8').includes('Settings file not found'), false);
});

test('GREEN-5. settings 幂等：已存在（自定义）⇒ settings=exists 且内容未被覆盖', { skip: SKIP }, () => {
  const id = 'T-20260101-100012-idem';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [] });
  const sp = path.join(WS, id, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  const custom = '{"permissions":{"allow":["Read"]}}\n';
  fs.writeFileSync(sp, custom);

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  if (r.pid) spawnPids.push(r.pid);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.settings, 'exists');
  assert.equal(fs.readFileSync(sp, 'utf8'), custom, '已存在的 settings 绝不能被覆盖');
});

// ── 项1：复核 lane（role=review）经单一入口 ─────────────────────────────────

test('RED-4. 执行 lane 对 in_review ⇒ 拒绝并提示复核 lane（status_not_spawnable(in_review):use_role=review）', { skip: SKIP }, () => {
  const id = 'T-20260101-100013-review-red';
  writeCard(id, { status: 'in_review', claimed: 'linus', segs: [] });
  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'status_not_spawnable(in_review):use_role=review');
});

test('RED-5. 复核 lane 未显式给 seg ⇒ 默认 segR1（不复用执行侧 seg1）', { skip: SKIP }, () => {
  const id = 'T-20260101-100014-review-default';
  writeCard(id, { status: 'in_review', claimed: 'linus', segs: [] });
  const r = spawnLane({ card: id, owner: 'turing', backend: 'codex', role: 'review', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.role, 'review');
  assert.equal(r.seg, 'segR1', '复核 lane 未给 seg= 时应取 segR1（避开执行侧 seg1 的 upsert 撞名）');
});

test('RED-6. 复核 lane 复用他人 seg ⇒ 拒绝 review_seg_taken（不覆盖执行登记行）', { skip: SKIP }, () => {
  const id = 'T-20260101-100015-review-clash';
  writeCard(id, { status: 'in_review', claimed: 'linus', segs: [SEG1_LINUS_CLOSED] });
  const r = spawnLane({ card: id, owner: 'turing', seg: 'seg1', backend: 'codex', role: 'review', dryRun: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^review_seg_taken\(seg=seg1,owner=linus\)/);
});

test('RED-7. 复核 lane 对非在审卡 ⇒ 拒绝 review_needs_in_review(status=…)', { skip: SKIP }, () => {
  const id = 'T-20260101-100016-review-notin';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [] });
  const r = spawnLane({ card: id, owner: 'turing', seg: 'segR1', backend: 'codex', role: 'review', dryRun: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'review_needs_in_review(status=in_progress)');
});

test('GREEN-6. 复核 lane：role=review 对 in_review ⇒ 卡+registry 同写、不碰 claimed_by、执行行不被覆盖', { skip: SKIP }, async () => {
  const id = 'T-20260101-100017-review-green';
  writeCard(id, { status: 'in_review', claimed: 'linus', segs: [SEG1_LINUS_CLOSED] });

  const r = spawnLane({ card: id, owner: 'turing', backend: 'codex', role: 'review', dryRun: false }); // seg 缺省 ⇒ segR1
  if (r.pid) spawnPids.push(r.pid);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.role, 'review');
  assert.equal(r.seg, 'segR1');

  const raw = cardRaw(id);
  assert.match(raw, /- seg:segR1 · owner:turing · backend:codex /, '复核 lane 应写入自己的 Sessions 行');
  assert.match(raw, /- seg:seg1 · owner:linus ·/, '执行侧登记行必须原样保留（未被覆盖）');
  assert.equal(/^status: in_review$/m.test(raw), true, '复核 lane 不得改卡状态');
  assert.equal(/^claimed_by: linus$/m.test(raw), true, '复核 lane 不得改 claimed_by');

  const rev = registryEntries(id).find((x) => x.owner === 'turing');
  assert.ok(rev && rev.status === 'running' && rev.pid === r.pid, JSON.stringify(registryEntries(id)));

  assert.equal(await waitFor(() => fs.existsSync(r.log) && fs.readFileSync(r.log, 'utf8').includes('"subtype":"init"')), true,
    `codex stub 应起会话并写 init 行，实际 ${r.log}: ${fs.existsSync(r.log) ? fs.readFileSync(r.log, 'utf8').slice(0, 200) : '(missing)'}`);
  assert.equal(checkSessions().ok, true, JSON.stringify(checkSessions()));
  assert.equal(checkHandoff().ok, true, JSON.stringify(checkHandoff()));
});

test('GREEN-7. 复核 lane --dry-run：只校验+打印（codex settings=n/a、handoff=would_create，pid=null，零副作用）', { skip: SKIP }, () => {
  const id = 'T-20260101-100018-review-dry';
  writeCard(id, { status: 'in_review', claimed: 'linus', segs: [] });
  const r = spawnLane({ card: id, owner: 'turing', backend: 'codex', role: 'review', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.role, 'review');
  assert.equal(r.pid, null);
  assert.equal(r.settings, 'n/a', 'codex 复核不消费 --settings（read-only + -o）');
  assert.equal(r.handoff, 'would_create');
  assert.equal(fs.existsSync(REG), false, 'dry-run 不得写 registry');
  assert.equal(cardRaw(id).includes('status: in_review'), true, 'dry-run 不得改卡');
  assert.equal(fs.existsSync(path.join(WS, id, '.claude', 'settings.json')), false, 'dry-run 不得落 settings');
  assert.equal(fs.existsSync(path.join(WS, id, '.claude', 'settings.review.json')), false, 'codex 复核不生成 review settings');
  assert.equal(fs.existsSync(path.join(WS, id, 'handoff.md')), false, 'dry-run 不得生成 handoff');
});

// ── ①b：同卡同 seg 防双跑（Elon 2026-10-11 并入本治理卡；判据同 poll 防双跑守卫） ──────

test('REJECT. 同卡同 seg 已有 running（卡内 Sessions 行 + pid 存活）⇒ 拒绝二次 spawn，零副作用', { skip: SKIP }, () => {
  const id = 'T-20260101-100019-dup-card';
  // 卡内该 seg 行：running 且 pid 存活（用本进程 pid 保证「存活」）
  const live = `- seg:seg1 · owner:linus · backend:claude · id:99999999-9999-5999-8999-999999999999 · phase:seg1 · status:running · pid:${process.pid} · 2026-01-01T00:00:00.000Z`;
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [live] });

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^session_running\(seg=seg1,pid=\d+,id=\S+\):reuse_existing$/);
  assert.equal(r.session.source, 'card');
  assert.equal(r.session.id, '99999999-9999-5999-8999-999999999999', '拒绝须给出可 resume 的既有 session id');
  assert.equal(registryEntries(id).length, 0, '拒绝时不得写 registry');
  assert.equal(fs.existsSync(path.join(WS, id, 'linus-1.out.jsonl')), false, '拒绝时不得起进程');
});

test('REJECT. 同卡同 seg 已有 running（仅 registry：phase=seg + pid 存活）⇒ 同样拒绝', { skip: SKIP }, () => {
  const id = 'T-20260101-100020-dup-reg';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [] }); // 卡内 Sessions 空（只写了 registry 的形态）
  upsertSessionEntry({ task_id: id, owner: 'linus', phase: 'seg1', status: 'running', pid: process.pid, session_id: 'abababab-1111-5111-8111-111111111111', startedAt: 'x' });

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^session_running\(seg=seg1,pid=\d+,id=abababab-1111-5111-8111-111111111111,owner=linus\):reuse_existing$/);
  assert.equal(r.session.source, 'registry');
});

test('GREEN. 僵尸登记（pid 已死）⇒ 不占用，允许起会话（交 reconcile 清理）', { skip: SKIP }, () => {
  const id = 'T-20260101-100021-zombie';
  const dead = '- seg:seg1 · owner:linus · backend:claude · id:12341234-1234-5123-8123-123412341234 · phase:seg1 · status:running · pid:999999999 · 2026-01-01T00:00:00.000Z';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [dead] });
  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.seg, 'seg1');
});

test('REJECT. 复核 lane 遇同卡活跃 lane ⇒ review_needs_quiet_card（执行 lane 必须先结束）', { skip: SKIP }, () => {
  const id = 'T-20260101-100022-diff-seg';
  const live = `- seg:seg1 · owner:linus · backend:claude · id:56565656-5656-5656-8656-565656565656 · phase:seg1 · status:running · pid:${process.pid} · 2026-01-01T00:00:00.000Z`;
  writeCard(id, { status: 'in_review', claimed: 'linus', segs: [live] });
  const r = spawnLane({ card: id, owner: 'turing', backend: 'codex', role: 'review', dryRun: true });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^review_needs_quiet_card\(live=seg1\(pid=/, r.reason);
});

// ── 项3：codex lane 的报告落点写权（T-20261013-164816） ────────────────────────
// 缺陷：codex 分支原仅发 `exec <prompt>`，未授予复核报告落点 `{team}/workspace/<id>/` 的写权；
// 而 claude 分支有 `--add-dir wsDir` + `--add-dir team`。后果：codex 复核 lane 写 report.md 得 EPERM。
//
// codex 沙箱语义（CLI 0.161.0，本卡实测）：
//   · cwd 为受信 git 仓 ⇒ 默认 `sandbox: workspace-write [workdir, /tmp, $TMPDIR]`（仅 cwd 可写）；
//   · cwd 非 git / 未受信 ⇒ 默认 `sandbox: read-only`；
//   · `--add-dir <DIR>` 只**追加可写根**，且**仅在 workspace-write 下生效**——read-only 下被静默忽略
//     （实测：`--add-dir X` 单独给，头部仍打印 `sandbox: read-only`）。
// ⇒ 等效写权 = `--sandbox workspace-write`（根因，缺则 read-only 下 --add-dir 无效）+ `--add-dir <wsDir>`
//   （报告落点）+ `--add-dir <team>`（与 claude 分支同面）。

/** argv 里 flag 紧跟的值（缺失/无值 ⇒ null）。 */
const flagValue = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

test('RED-8. buildCommand：codex 分支须授予报告落点写权（--sandbox workspace-write + --add-dir wsDir/team）', { skip: SKIP }, () => {
  const wsDir = path.join(WS, 'T-20260101-100023-codex');
  const got = buildCommand({ backend: 'codex', bin: 'codex', prompt: 'P', wsDir, sid: 'S', name: 'turing-segR1', team: LAYOUT });

  // ① 显式 workspace-write：read-only 下 --add-dir 被忽略（实测）⇒ 这是写权的前提
  assert.equal(flagValue(got.args, '--sandbox') ?? flagValue(got.args, '-s'), 'workspace-write',
    `codex argv 须显式 --sandbox workspace-write，实际 ${JSON.stringify(got.args)}`);
  // ② 报告落点作为可写根（EPERM 消失的充分条件）
  assert.equal(flagValue(got.args, '--add-dir'), wsDir,
    `codex argv 首个 --add-dir 须指向 workspace 报告落点，实际 ${JSON.stringify(got.args)}`);
  assert.ok(got.args.includes(LAYOUT), `codex argv 须含 team 根可写（与 claude 同面），实际 ${JSON.stringify(got.args)}`);
  // ③ 仍是 `codex exec`，且 prompt 在**最后一个**位置参数（`exec [OPTIONS] [PROMPT]`：旗标须在 prompt 前）
  assert.equal(got.args[0], 'exec');
  assert.equal(got.args[got.args.length - 1], 'P', `prompt 须在末位（旗标前置），实际 ${JSON.stringify(got.args)}`);
});

test('RED-9. codex 复核 lane：--sandbox read-only + -o 报告，不授写权', { skip: SKIP }, () => {
  const id = 'T-20260101-100024-codex-write';
  writeCard(id, { status: 'in_review', claimed: 'linus', segs: [] });
  const r = spawnLane({ card: id, owner: 'turing', backend: 'codex', role: 'review', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));

  const wsDir = path.join(WS, id);
  assert.equal(flagValue(r.cmd, '--sandbox') ?? flagValue(r.cmd, '-s'), 'read-only', `实际 argv=${JSON.stringify(r.cmd)}`);
  assert.equal(flagValue(r.cmd, '-o') ?? flagValue(r.cmd, '--output-last-message'),
    path.join(wsDir, 'review-report.md'), `实际 argv=${JSON.stringify(r.cmd)}`);
  assert.equal(flagValue(r.cmd, '--add-dir'), null, 'read-only 复核不再授 --add-dir 写根');
  assert.equal(r.review_readonly, 'sandbox');
  // prompt 末位：命令须能被 codex 解析（旗标在 prompt 前）
  assert.match(r.cmd[r.cmd.length - 1], /report\.md\.?$/, `prompt 须在末位，实际 ${JSON.stringify(r.cmd)}`);
});

test('GREEN-9. claude 复核 lane：settings.review.json + dontAsk + 不等待权限', { skip: SKIP }, () => {
  const id = 'T-20260101-100024-claude-review';
  writeCard(id, { status: 'in_review', claimed: 'linus', segs: [] });
  const r = spawnLane({ card: id, owner: 'turing', backend: 'claude', role: 'review', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));

  const text = r.cmd.join(' ');
  assert.match(text, /--permission-mode dontAsk/, text);
  assert.match(text, /--permission-prompts none/, text);
  assert.ok(r.cmd.includes(path.join(WS, id, '.claude', 'settings.review.json')), text);
  assert.equal(r.settings, 'would_create');
  assert.equal(r.review_readonly, 'settings');
  const promptArg = r.cmd[r.cmd.indexOf('-p') + 1];
  assert.match(promptArg || '', /report\.md\.?$/, text);
});

test('GREEN-8. buildCommand：claude 分支 argv 逐字节不变（本卡只动 codex 分支）', { skip: SKIP }, () => {
  const wsDir = path.join(WS, 'T-20260101-100025-claude');
  const got = buildCommand({ backend: 'claude', bin: 'claude', prompt: 'P', wsDir, sid: 'S', name: 'linus-seg1', team: LAYOUT });
  assert.deepEqual(got.args, [
    '-p', 'P',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--settings', path.join(wsDir, '.claude', 'settings.json'),
    '--add-dir', wsDir,
    '--add-dir', LAYOUT,
    '--session-id', 'S',
    '--name', 'linus-seg1',
  ]);
});

// ── ①b2 / L1③：同卡并发执行 lane 在 **spawn 前**拦下（T-20261013-233906） ────────────
// 实证：turing 复核卡 `T-20261013-223243` 的 seg1 lane 以 `phase:seg1-verify` 登记，另一执行 turn
// 7s 后又起了一条 segR1 lane（同卡并发执行 turn）⇒ 事后按 PROTOCOL §6 回滚（kill + sessionClose，0B 空产）。

test('REJECT. ①b2 同卡已有活跃执行 lane（异 seg）⇒ spawn 前拦下（card_busy），零副作用', { skip: SKIP }, () => {
  const id = 'T-20260101-100023-card-busy';
  const live = `- seg:seg1 · owner:linus · backend:claude · id:77777777-7777-5777-8777-777777777777 · phase:seg1 · status:running · pid:${process.pid} · 2026-01-01T00:00:00.000Z`;
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [live] });

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg2', backend: 'claude', dryRun: false });

  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(
    r.reason,
    new RegExp(`^card_busy\\(seg=seg2,live=seg1\\(pid=${process.pid},owner=linus\\)\\):second_exec_lane$`),
    r.reason,
  );
  assert.equal(r.session.source, 'card_busy');
  assert.equal(registryEntries(id).length, 0, '拒绝时不得写 registry');
  assert.equal(fs.existsSync(path.join(WS, id, 'linus-2.out.jsonl')), false, '拒绝时不得派生第二条 lane');
});

test('REJECT. ①b L1③ registry `phase` 标签 ≠ seg（phase=seg1-verify，session_id=本 seg 确定性 id）⇒ 仍拦', { skip: SKIP }, () => {
  const id = 'T-20260101-100024-phase-label';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [] }); // 卡内 Sessions 空（只写了 registry 的形态）
  const sid = sessionIdFor(id, 'linus', 'seg1').session_id;
  // 与实证同形：phase 是 caller 自由填的展示标签，不等于 seg；lane 身份只能靠 session_id 认
  upsertSessionEntry({ task_id: id, owner: 'linus', phase: 'seg1-verify', status: 'running', pid: process.pid, session_id: sid, log: '/x/linus-1.out.jsonl', startedAt: 'x' });

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });

  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, new RegExp(`^session_running\\(seg=seg1,pid=${process.pid},id=${sid}`), r.reason);
  assert.equal(r.session.source, 'registry_session', '命中判据应为 session_id，而非 phase 标签');
});

test('REJECT. parallel=1 已移除 ⇒ 程序化调用与 CLI 均明确拒绝（不是静默 no-op）', { skip: SKIP }, () => {
  const id = 'T-20260101-100025-parallel';
  const live = `- seg:seg1 · owner:linus · backend:claude · id:88888888-8888-5888-8888-888888888888 · phase:seg1 · status:running · pid:${process.pid} · 2026-01-01T00:00:00.000Z`;
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [live] });

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg2', backend: 'claude', dryRun: true, parallel: '1' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'removed_arg:parallel');

  const a = parseArgs(['C', 'linus', 'parallel=1']);
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'removed_arg:parallel');
  assert.equal(parseArgs(['C', 'linus']).parallel, undefined, '解析结果不再有 parallel 字段');
});

test('NEG-④ 并发两执行 turn ⇒ 仅一执行：首条真起 lane，第二条在 spawn 前被拦（不派生第二 lane）', { skip: SKIP }, () => {
  const id = 'T-20260101-100026-two-turns';
  writeCard(id, { status: 'in_progress', claimed: 'linus', segs: [] });

  const first = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  if (first.pid) spawnPids.push(first.pid);
  assert.equal(first.ok, true, JSON.stringify(first));

  const second = spawnLane({ card: id, owner: 'linus', seg: 'seg2', backend: 'claude', dryRun: false });
  assert.equal(second.ok, false, JSON.stringify(second));
  assert.match(second.reason, /^card_busy\(seg=seg2,live=/, second.reason);
  assert.equal(second.pid, undefined, '被拦的 turn 不得拿到 pid');
  assert.equal(fs.existsSync(path.join(WS, id, 'linus-2.out.jsonl')), false, '不得产生第二条 lane 的日志');
  assert.equal(registryEntries(id).length, 1, 'registry 只应有第一条 lane 的登记');
});


// ---------------------------------------------------------------------------
// buildPrompt —— 隔离段落的两态合同（P3：改建基于 using-git-worktrees 的 dev 开发流）
//
// 这一段是无头车道能否自建隔离树的**唯一开关**：`using-git-worktrees` skill 的 Step 0 在
// 未隔离时会向用户征求同意，而车道是 `claude -p`、没有人能回答 —— 偏好必须由本提示语声明，
// skill 才会照 "Honor any existing declared preference without asking" 直接建树。
// 两态都必须成立：P3 时旧机制仍在隔离一部分车道，P4 才摘掉它。
// ---------------------------------------------------------------------------

const PROMPT_ARGS = { handoffPath: '/ws/handoff.md', cardPath: '/tasks/T.md', reportPath: '/ws/report.md' };
// 这些例子结构上需要 provider：`buildPrompt` 由 `scripts/spawn-lane.mjs` 导出，而后者**静态**
// import `skills/task-ops/lib/task.mjs`（ACL）。无 provider ⇒ 模块根本 import 不进。

test('UNIT. cardBranchName：seg 不参与命名；非法字符清洗', { skip: SKIP }, () => {
  assert.equal(cardBranchName('T-20261016-111111'), 'T-20261016-111111');
  assert.equal(cardBranchName('T/1 x'), 'T-1-x');
});

test('UNIT. resolveCardBranch：<card> > 唯一 legacy > 新建；segR1 / 自定义段不算 legacy', { skip: SKIP }, () => {
  const card = 'T-1';
  const pick = (r) => ({ branch: r.branch, source: r.source });

  assert.deepEqual(pick(resolveCardBranch({ taskId: card, branches: [card, `${card}-seg1`] })),
    { branch: card, source: 'card' });
  assert.deepEqual(pick(resolveCardBranch({ taskId: card, branches: [`${card}-seg2`] })),
    { branch: `${card}-seg2`, source: 'legacy' });

  const amb = resolveCardBranch({ taskId: card, branches: [`${card}-seg1`, `${card}-seg2`] });
  assert.equal(amb.source, 'new');
  assert.deepEqual(amb.candidates, [`${card}-seg1`, `${card}-seg2`]);

  const reviewOnly = resolveCardBranch({ taskId: card, branches: [`${card}-segR1`, `${card}-seg2-container`] });
  assert.deepEqual(reviewOnly.candidates, []);
  assert.equal(reviewOnly.source, 'new');

  assert.equal(resolveCardBranch({ taskId: card, branches: [], repoMode: 'nogit' }).source, 'nogit');
  assert.equal(resolveCardBranch({ taskId: card, branches: [], repoMode: 'unresolved' }).source, 'unresolved');
  assert.equal(resolveCardBranch({ taskId: 'T/1', branches: [] }).error, 'card_id_not_branch_safe');
});

test('UNIT. reviewSettings：只允许写 review-report.md（Edit 路径规则），禁写型 git 命令', { skip: SKIP }, () => {
  const s = reviewSettings('/ws/T-1/review-report.md');
  assert.ok(s.permissions.allow.includes('Edit(//ws/T-1/review-report.md)'));
  assert.ok(!s.permissions.allow.includes('Write'));
  assert.ok(s.permissions.deny.includes('Bash(git commit:*)'));
  assert.ok(!s.permissions.deny.includes('Edit'), '裸 Edit deny 会连允许的报告路径一起禁掉');
});

// ── 卡分支解析（真 git 仓；dry-run 零副作用） ───────────────────────────────

test('BRANCH-1. 真仓 + 无卡分支 ⇒ source=new，worktree 落在仓内 .worktrees/<card>', { skip: SKIP }, () => {
  const id = 'T-20260101-200001-new';
  const { dir } = mkRepo(id);
  writeCard(id, { target: dir });
  const r = spawnLane({ card: id, owner: 'linus', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.branch_source, 'new');
  assert.equal(r.branch, id);
  // `git --show-toplevel` 返回真实路径（macOS 上 /var → /private/var）
  assert.equal(r.worktree, path.join(fs.realpathSync(dir), '.worktrees', id));
  assert.equal(r.worktree_exists, false);
});

test('BRANCH-2. 已存在 <card> ⇒ source=card', { skip: SKIP }, () => {
  const id = 'T-20260101-200002-card';
  const { dir, git } = mkRepo(id);
  git('branch', id);
  writeCard(id, { target: dir });
  const r = spawnLane({ card: id, owner: 'linus', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.branch_source, 'card');
  assert.equal(r.branch, id);
});

test('BRANCH-3. 仅一条 legacy <card>-seg2 ⇒ 复用该分支', { skip: SKIP }, () => {
  const id = 'T-20260101-200003-legacy';
  const { dir, git } = mkRepo(id);
  git('branch', `${id}-seg2`);
  writeCard(id, { target: dir });
  const r = spawnLane({ card: id, owner: 'linus', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.branch_source, 'legacy');
  assert.equal(r.branch, `${id}-seg2`);
});

test('BRANCH-4. 多条 legacy ⇒ 拒绝 legacy_branch_ambiguous（不静默新建）', { skip: SKIP }, () => {
  const id = 'T-20260101-200004-ambiguous';
  const { dir, git } = mkRepo(id);
  git('branch', `${id}-seg1`);
  git('branch', `${id}-seg2`);
  writeCard(id, { status: 'todo', claimed: '', target: dir });
  const r = spawnLane({ card: id, owner: 'linus', backend: 'claude', dryRun: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^legacy_branch_ambiguous\(candidates=/, r.reason);
  assert.match(cardRaw(id), /status: todo/, '拒绝必须发生在 claim 之前（零副作用）');
});

test('BRANCH-5. <card> 与 non-ancestor legacy 并存 ⇒ 拒绝 legacy_not_ancestor', { skip: SKIP }, () => {
  const id = 'T-20260101-200005-not-ancestor';
  const { dir, git } = mkRepo(id);
  git('branch', id);
  git('checkout', '-q', '-b', `${id}-seg1`);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git('add', 'b.txt');
  git('commit', '-q', '-m', 'legacy');
  git('checkout', '-q', 'dev');
  writeCard(id, { target: dir });
  const r = spawnLane({ card: id, owner: 'linus', backend: 'claude', dryRun: true });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^legacy_not_ancestor\(branch=/, r.reason);
});

test('BRANCH-6. legacy 是 <card> 的祖先 ⇒ 放行', { skip: SKIP }, () => {
  const id = 'T-20260101-200006-ancestor';
  const { dir, git } = mkRepo(id);
  git('checkout', '-q', '-b', `${id}-seg1`);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git('add', 'b.txt');
  git('commit', '-q', '-m', 'legacy');
  git('checkout', '-q', '-b', id);
  writeCard(id, { target: dir });
  const r = spawnLane({ card: id, owner: 'linus', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.branch_source, 'card');
});

test('BRANCH-7. 复核 lane：真仓无卡分支 ⇒ review_branch_missing', { skip: SKIP }, () => {
  const id = 'T-20260101-200007-review-missing';
  const { dir } = mkRepo(id);
  writeCard(id, { status: 'in_review', claimed: 'linus', target: dir });
  const r = spawnLane({ card: id, owner: 'turing', backend: 'codex', role: 'review', dryRun: true });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^review_branch_missing\(branch=/, r.reason);
});

test('BRANCH-8. 复核 lane：真仓有卡分支 ⇒ 放行并 pin tip sha', { skip: SKIP }, () => {
  const id = 'T-20260101-200008-review-ok';
  const { dir, git } = mkRepo(id);
  git('branch', id);
  const tip = git('rev-parse', `refs/heads/${id}`);
  writeCard(id, { status: 'in_review', claimed: 'linus', target: dir });
  const r = spawnLane({ card: id, owner: 'turing', backend: 'codex', role: 'review', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.branch_source, 'card');
  assert.equal(r.review_sha, tip);
});

test('buildPrompt 首建：授权、skill 落点、卡分支名、以 dev 为基', { skip: SKIP }, () => {
  const p = buildPrompt({ ...PROMPT_ARGS, branch: 'T-20261016-111111', branchSource: 'new',
    worktreePath: '/repo/.worktrees/T-20261016-111111', worktreeExists: false });
  assert.match(p, /do NOT ask for consent/, '必须显式授权，否则 skill Step 0 的征求意见在无头下无法满足');
  assert.match(p, /using-git-worktrees/, '点名 skill（车道是 claude 后端，该 skill 装在 claude 目标上）');
  assert.match(p, /\.worktrees\//, '落点必须是 skill 1b 的默认值');
  assert.match(p, /T-20261016-111111/, '分支名必须写出——合并门禁靠分支名反推卡 id');
  assert.match(p, /base it on `dev`/);
  assert.match(p, /git worktree add .* -b T-20261016-111111 dev/);
  assert.match(p, /Never commit directly on the protected release branch/, '发布分支只说角色，不写死名字');
  assert.doesNotMatch(p, /already in a lane worktree/, '未隔离时不得出现「你已在隔离树中」');
});

test('buildPrompt 续段：复用既有分支/树，禁止 -b，不段间合并', { skip: SKIP }, () => {
  const p = buildPrompt({ ...PROMPT_ARGS, branch: 'T-1', branchSource: 'card',
    worktreePath: '/repo/.worktrees/T-1', worktreeExists: true });
  assert.match(p, /already exists/);
  assert.match(p, /do NOT create a new branch/);
  assert.match(p, /do NOT run the skill's `-b` fallback/);
  assert.match(p, /do not merge between segments/);
  assert.doesNotMatch(p, /base it on/);
});

test('buildPrompt legacy：使用旧分支名并标注 in-flight', { skip: SKIP }, () => {
  const p = buildPrompt({ ...PROMPT_ARGS, branch: 'T-1-seg2', branchSource: 'legacy',
    worktreePath: '/repo/.worktrees/T-1-seg2', worktreeExists: true });
  assert.match(p, /T-1-seg2/);
  assert.match(p, /legacy name for this in-flight card/);
});

test('buildPrompt 非 git / 环境不明：不建树，分别直接工作 / 报告 blocked', { skip: SKIP }, () => {
  const nogit = buildPrompt({ ...PROMPT_ARGS, branchSource: 'nogit' });
  assert.doesNotMatch(nogit, /using-git-worktrees/);
  assert.doesNotMatch(nogit, /git worktree add/);

  const unknown = buildPrompt({ ...PROMPT_ARGS, branchSource: 'unresolved' });
  assert.match(unknown, /git rev-parse --is-inside-work-tree/);
  assert.doesNotMatch(unknown, /git worktree add/);
});

test('buildPrompt 复核：只读 + pin + 不建分支；claude 写唯一报告路径', { skip: SKIP }, () => {
  const p = buildPrompt({ ...PROMPT_ARGS, role: 'review', branch: 'T-1', branchSource: 'card',
    worktreePath: '/repo/.worktrees/T-1', worktreeExists: true, pinSha: 'abc123',
    reviewReportPath: '/ws/review-report.md', reviewReadonly: 'settings' });
  assert.match(p, /review lane: read-only/);
  assert.match(p, /Do NOT create a branch or worktree/);
  assert.match(p, /abc123/);
  assert.match(p, /Never commit/);
  assert.match(p, /write your review report to \/ws\/review-report\.md/);
});

test('buildPrompt 复核 codex：最终消息即报告，由 -o 落盘', { skip: SKIP }, () => {
  const p = buildPrompt({ ...PROMPT_ARGS, role: 'review', branch: 'T-1', branchSource: 'card',
    worktreePath: '/repo/.worktrees/T-1', worktreeExists: true, pinSha: 'abc123',
    reviewReportPath: '/ws/review-report.md', reviewReadonly: 'sandbox' });
  assert.match(p, /final message/);
  assert.match(p, /captures it to \/ws\/review-report\.md/);
});

test('buildPrompt：集成分支名可配（与门禁同源），受保护分支则**不点名**（它随仓而异）', { skip: SKIP }, () => {
  const p = buildPrompt({ ...PROMPT_ARGS, branch: 'T-1', branchSource: 'new',
    worktreePath: '/repo/.worktrees/T-1', integration: 'develop' });
  assert.match(p, /base it on `develop`/, '须用传入的集成分支名');
  assert.doesNotMatch(p, /base it on `dev`/);
  assert.match(p, /protected release branch/, '说的是「发布分支」这个角色，不是一个具体名字');
  assert.doesNotMatch(p, /\(main\)/, '不得写死 (main)');
});

test('buildPrompt：报告行必须是末句（exec / review 两态）', { skip: SKIP }, () => {
  const exec = buildPrompt({ ...PROMPT_ARGS, branch: 'T-1', branchSource: 'card',
    worktreePath: '/repo/.worktrees/T-1', worktreeExists: true });
  assert.match(exec, /report\.md\.?$/, `报告行须在末位：${exec.slice(-120)}`);

  const review = buildPrompt({ ...PROMPT_ARGS, role: 'review', branch: 'T-1', branchSource: 'card',
    worktreePath: '/repo/.worktrees/T-1', worktreeExists: true, pinSha: 'abc',
    reviewReportPath: '/ws/review-report.md', reviewReadonly: 'settings' });
  assert.match(review, /report\.md\.?$/, `复核报告行须在末位：${review.slice(-120)}`);
});
