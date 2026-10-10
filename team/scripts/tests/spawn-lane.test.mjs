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
let spawnLane, parseArgs, sessionIdFor, sessionSet, checkSessions, checkHandoff, anchorGaps, upsertSessionEntry;

if (LAYOUT) {
  TASKS = path.join(LAYOUT, 'tasks');
  WS = path.join(LAYOUT, 'workspace');
  BIN = path.join(LAYOUT, 'bin');
  REG = path.join(LAYOUT, 'claude-sessions.json');
  process.env.OPENCLAW_TEAM_ROOT = LAYOUT;

  const staged = (rel) => import(pathToFileURL(path.join(LAYOUT, rel)).href);
  ({ spawnLane, parseArgs } = await staged('scripts/spawn-lane.mjs'));
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

test('GREEN-7. 复核 lane --dry-run：只校验+打印（settings/handoff=would_create，pid=null，零副作用）', { skip: SKIP }, () => {
  const id = 'T-20260101-100018-review-dry';
  writeCard(id, { status: 'in_review', claimed: 'linus', segs: [] });
  const r = spawnLane({ card: id, owner: 'turing', backend: 'codex', role: 'review', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.role, 'review');
  assert.equal(r.pid, null);
  assert.equal(r.settings, 'would_create');
  assert.equal(r.handoff, 'would_create');
  assert.equal(fs.existsSync(REG), false, 'dry-run 不得写 registry');
  assert.equal(cardRaw(id).includes('status: in_review'), true, 'dry-run 不得改卡');
  assert.equal(fs.existsSync(path.join(WS, id, '.claude', 'settings.json')), false, 'dry-run 不得落 settings');
  assert.equal(fs.existsSync(path.join(WS, id, 'handoff.md')), false, 'dry-run 不得生成 handoff');
});

