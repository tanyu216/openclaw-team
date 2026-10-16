#!/usr/bin/env node
/**
 * lane-reaper.test.mjs — ②「lane 终结必写会话终态」测试（含异常/超时/被杀路径 + 接线 + fail-closed）
 *
 * 背景（T-20261015-045724）：`spawn-lane` 的单向登记（`status=running`）没有对应的**必然**终结
 * 写点——唯一写点 ACL `task.session-close` 只能由某个 agent 回合自觉调用。lane 被杀/崩溃/超时后，
 * 卡 `## Sessions` 行与 registry 双双停在 `running`（pid 已死），或被带外手工 reconcile 了一半。
 *
 * 本套件锁定 `lane-reaper.mjs` 的契约（真进程、真文件、真 ACL，无内部 mock）：
 *   · RED 形态：起 lane 后**杀掉它** ⇒ 卡行/registry 双双停在 running（漂移态，修复前即此末态）；
 *   · GREEN：看守（等 pid 死）⇒ 一次写完两侧终态：卡行 status + `endedAt` 追加 + 清
 *     `active_session_id` + registry 终态（含 `endedAt`）+ 逐条留痕；
 *   · 异常路径：SIGKILL / 自杀（超时等价）/ 非零退出（崩溃）**一律**收口；
 *   · 幂等与不越权：已终态 ⇒ 零写；行被另一条**活** pid 接管 ⇒ 不越权关它；pid 仍活 ⇒ 不动；
 *   · 接线：`spawn-lane` 起会话后**必然**起看守（`reaper.state==='armed'`），`--no-reaper` /
 *     `OPENCLAW_TEAM_REAPER=0` 关闭；看守起不来 ⇒ **拒绝起会话**且把已登记的行走 ACL 就地收口。
 *
 * 运行：node --test team/scripts/tests/lane-reaper.test.mjs
 */
import { test as nodeTest, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const SCRIPTS = path.join(HERE, '..');                     // <repo>/team/scripts

/** 定位携带 ACL 库的 provider 安装目录（与 spawn-lane.test.mjs 同口径）。 */
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

/** 部署布局：vendored scripts/ + skills/task-ops + tasks/ workspace/ bin/（与 spawn-lane.test.mjs 同款）。 */
const LAYOUT = PROVIDER ? (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-reaper-'));
  for (const d of ['scripts', 'tasks', 'tasks/.locks', 'workspace', 'skills', 'bin']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
  }
  fs.symlinkSync(PROVIDER, path.join(root, 'skills', 'task-ops'), 'dir');
  return root;
})() : null;

let TASKS, WS, BIN, REG;
let watchAndReap, reapOnce, armLaneReaper, reaperEnabled, parseReaperArgs, lifecycle, registryMod;
let spawnLane, spawnParseArgs, sessionSet, sessionClose;
let stub;

if (LAYOUT) {
  TASKS = path.join(LAYOUT, 'tasks');
  WS = path.join(LAYOUT, 'workspace');
  BIN = path.join(LAYOUT, 'bin');
  REG = path.join(LAYOUT, 'claude-sessions.json');
  process.env.OPENCLAW_TEAM_ROOT = LAYOUT;
  delete process.env.OPENCLAW_TEAM_REAPER;      // 默认开（接线测试要用真实看守）
  delete process.env.OPENCLAW_TEAM_REAPER_NODE; // 默认用 process.execPath

  const staged = (rel) => import(pathToFileURL(path.join(LAYOUT, rel)).href);
  ({ watchAndReap, reapOnce, armLaneReaper, reaperEnabled, parseReaperArgs } = await staged('scripts/lane-reaper.mjs'));
  lifecycle = await staged('scripts/session-lifecycle.mjs');
  registryMod = await staged('scripts/registry.mjs');
  ({ spawnLane, parseArgs: spawnParseArgs } = await staged('scripts/spawn-lane.mjs'));
  ({ sessionSet, sessionClose } = await staged('skills/task-ops/lib/task.mjs'));

  // 假 claude：起后写一行 NDJSON 并保持存活；被 SIGTERM/SIGKILL 即退出（= lane 的三种终结形态）
  stub = path.join(BIN, 'claude-stub');
  fs.writeFileSync(stub, '#!/bin/sh\necho \'{"type":"system","subtype":"init"}\'\nsleep 300\n');
  fs.chmodSync(stub, 0o755);
  process.env.OPENCLAW_CLAUDE_BIN = stub;
}

const live = []; // 本测试起的所有进程，after 统一清理
after(() => {
  for (const p of live) { try { process.kill(p, 'SIGKILL'); } catch { /* 已退出 */ } }
  if (LAYOUT) fs.rmSync(LAYOUT, { recursive: true, force: true });
});
beforeEach(() => {
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.rmSync(REG, { force: true });
});

const SID = 'aaaaaaaa-1111-5111-8111-111111111111';
const OTHER_SID = 'bbbbbbbb-2222-5222-8222-222222222222';

function writeCard(id, { status = 'in_progress', claimed = 'linus', segs = [], active = '' } = {}) {
  const body = `## Background\nx\n## Acceptance\n- [ ] a\n## Progress\n## Comments\n## Sessions\n${segs.join('\n')}\n## Report\n`;
  fs.writeFileSync(
    path.join(TASKS, `${id}.md`),
    `---\nid: ${id}\ntitle: reaper test\nassignee: linus\nstatus: ${status}\nproject: __team__\n` +
    `claimed_by: ${claimed}\nheartbeat_at: 2026-01-01T00:00:00.000Z\n${active ? `active_session_id: ${active}\n` : ''}---\n${body}`,
  );
}
const cardRaw = (id) => fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8');
const fmOf = (id) => {
  const fm = {};
  for (const line of /^---\n([\s\S]*?)\n---/.exec(cardRaw(id))[1].split('\n')) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2];
  }
  return fm;
};
const rowOf = (id, seg = 'seg1') => lifecycle.parseSessionRows(cardRaw(id)).find((r) => r.seg === seg);
const regEntry = (id, sid = SID) => (fs.existsSync(REG) ? JSON.parse(fs.readFileSync(REG, 'utf8')) : []).find((e) => e.task_id === id && e.session_id === sid);
/** 按 (task, session) 取条目——spawn-lane 用的是确定性 UUIDv5，测试不预设其值，故从卡行取值。 */
const regEntryFor = (id, sid) => regEntry(id, sid);
const auditLines = (id) => {
  const p = path.join(WS, id, lifecycle.LANE_AUDIT_FILE);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

/** 起一条真 lane（stub）+ 经 ACL 登记（卡行 + registry 同写，与 spawn-lane 步 ⑧ 同源）。 */
function startLane(id, { seg = 'seg1', sid = SID, status = 'in_progress' } = {}) {
  writeCard(id, { status, segs: [], claimed: 'linus' });
  const child = spawnChild(stub, [], { detached: true, stdio: 'ignore' });
  child.unref();
  live.push(child.pid);
  sessionSet(id, { seg, owner: 'linus', backend: 'claude', phase: seg, pid: child.pid, log: '', status: 'running', id: sid });
  return child.pid;
}
const killAndReap = (pid, signal = 'SIGTERM') => {
  try { process.kill(pid, signal); } catch { /* 已退出 */ }
};

/**
 * 等 pid「不再存活」（判据与看守同源：`laneProcessAlive` 把僵尸态也算终结）。
 *
 * 委托给共享原语 `session-lifecycle.waitPidDead`（T-20261016-210926）：上限 15s 是**活性**上界
 * 而非性能断言（pid 一死就返回 ⇒ 绿路径不付它），一次到期不作数（重取一次）——宿主负载/休眠
 * 让「观测不成」时不再把 stub 读成「一直活着」而误红；pid 真的一直活着仍两次到期 ⇒ 照旧红。
 */
const waitDead = (pid, timeout = lifecycle.PID_DEAD_WAIT_MS) => lifecycle.waitPidDead(pid, { timeoutMs: timeout });

// ── 判据三态 / 「观测不成 ≠ 还活着」/「真失败仍红」（T-20261016-210926）───────────

test('判据：probePidState 三态 —— ps 抛错 / 无输出都是 unknown（**不是** alive），Z 是 dead', { skip: SKIP }, () => {
  // 观测不成的两种形态：与 kill(pid,0) 分歧时**不得**读成「还活着」这一结论
  assert.equal(lifecycle.probePidState(process.pid, { ps: () => { throw new Error('EAGAIN'); } }), 'unknown', 'ps 起不来');
  assert.equal(lifecycle.probePidState(process.pid, { ps: () => '' }), 'unknown', 'ps 无输出');
  assert.equal(lifecycle.probePidState(process.pid, { ps: () => '   \n' }), 'unknown');
  // 观测得成的两种形态
  assert.equal(lifecycle.probePidState(process.pid, { ps: () => 'S+' }), 'alive');
  assert.equal(lifecycle.probePidState(process.pid, { ps: () => 'Z' }), 'dead', '僵尸：kill(pid,0) 对它成功，只有 ps 看得出来');
  assert.equal(lifecycle.probePidState(999999), 'dead', '真死 pid（真读数）');
  // 看守侧的保守口径一字未改：unknown ⇒ 存活（它的错判代价是「多等一轮」，不是「关掉活 lane」）
  assert.equal(lifecycle.laneProcessAlive(process.pid, { ps: () => { throw new Error('x'); } }), true);
});

test('判据：pid 观测不成 ⇒ 单次交回「没等死」（复现慢段 lane-reaper 假红），重取拿到真答案', { skip: SKIP }, async () => {
  const id = 'T-20260101-060015-blind';
  const pid = startLane(id);
  killAndReap(pid, 'SIGKILL');
  assert.ok(await waitDead(pid), '先让它真死透（真读数）');

  // 「观测不成」＝ 负载/休眠把 `ps` 打掉的那个形态：头 200ms 一律 unknown，之后回到真判据。
  const blindUntil = Date.now() + 200;
  const probe = (p) => (Date.now() < blindUntil ? 'unknown' : lifecycle.probePidState(p));

  const single = await lifecycle.waitPidDead(pid, { timeoutMs: 150, intervalMs: 5, probe, retries: 0 });
  assert.equal(single, false, '单次语义：整个窗口观测不成 ⇒ 交回「没等死」—— 这正是慢段里那条 `stub 应自行退出` 的读数');
  const recovered = await lifecycle.waitPidDead(pid, { timeoutMs: 150, intervalMs: 5, probe });
  assert.equal(recovered, true, '一次击穿后重取，观测恢复 ⇒ 拿到真答案（停滞不再误红）');
});

test('判据：真失败仍红 —— pid 真的还活着时两次都到期 ⇒ 仍判「没等死」', { skip: SKIP }, async () => {
  const id = 'T-20260101-060016-stillalive';
  const pid = startLane(id);                       // `sleep 300` 的 stub：本用例全程活着
  try {
    assert.equal(await lifecycle.waitPidDead(pid, { timeoutMs: 100, intervalMs: 5 }), false, '活 pid 重取两次也不会被读成「已终结」');
  } finally {
    killAndReap(pid, 'SIGKILL');
  }
});

// ── RED 形态：lane 终结后无人收口 ⇒ 卡行与 registry 双双停在 running ─────────────

test('RED. lane 被杀后**无人收口**的末态：卡行 running + registry running（pid 已死）= 本卡缺陷形态', { skip: SKIP }, async () => {
  const id = 'T-20260101-060001-red';
  const pid = startLane(id);
  killAndReap(pid, 'SIGKILL');
  assert.ok(await waitDead(pid), 'stub 应已死');

  assert.equal(rowOf(id).status, 'running', '无人收口 ⇒ 卡行停在 running（RED 形态）');
  assert.equal(regEntry(id).status, 'running', '无人收口 ⇒ registry 停在 running（RED 形态）');
  assert.equal(lifecycle.laneRow(lifecycle.parseSessionRows(cardRaw(id)), { activeSessionId: SID }).status, 'running');
});

// ── GREEN：看守必写两侧终态（连同异常/超时/被杀路径） ────────────────────────

for (const [label, signal] of [['被杀（SIGKILL）', 'SIGKILL'], ['被终止（SIGTERM）', 'SIGTERM']]) {
  test(`GREEN. lane ${label} ⇒ 看守收口：卡行 closed + endedAt + 清 active_session_id + registry closed`, { skip: SKIP }, async () => {
    const id = `T-20260101-060002-${signal.toLowerCase()}`;
    const pid = startLane(id);
    assert.equal(fmOf(id).active_session_id, SID, '登记后 active_session_id 应指向本 lane');
    killAndReap(pid, signal);
    assert.ok(await waitDead(pid), 'stub 应已死');

    const r = await watchAndReap({ card: id, seg: 'seg1', pid, intervalMs: 20, graceMs: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.action, 'closed', JSON.stringify(r));

    const row = rowOf(id);
    assert.equal(row.status, 'closed', '卡行必写终态');
    assert.match(String(row.endedAt), /^\d{4}-\d\d-\d\dT/, `卡行应带 endedAt 审计字段，实际 ${row.endedAt}`);
    assert.ok(!fmOf(id).active_session_id, `active_session_id 应清空（序列化层把空值落成缺键），实际 ${fmOf(id).active_session_id}`);
    const e = regEntry(id);
    assert.equal(e.status, 'closed', 'registry 必写终态');
    assert.ok(e.endedAt, 'registry 应记 endedAt');
    const audit = auditLines(id);
    assert.ok(audit.length >= 1 && audit[0].action === 'session-close', '应逐条留痕（lane-lifecycle.log）');
  });
}

test('GREEN. lane 自杀（超时等价路径：进程自行 exit）⇒ 看守收口', { skip: SKIP }, async () => {
  const id = 'T-20260101-060003-timeout';
  const quick = path.join(BIN, 'lane-quick');
  fs.writeFileSync(quick, '#!/bin/sh\nsleep 0.1\n');
  fs.chmodSync(quick, 0o755);
  writeCard(id, { status: 'in_progress' });
  const child = spawnChild(quick, [], { detached: true, stdio: 'ignore' });
  child.unref();
  live.push(child.pid);
  sessionSet(id, { seg: 'seg1', owner: 'linus', backend: 'claude', phase: 'seg1', pid: child.pid, log: '', status: 'running', id: SID });

  assert.ok(await waitDead(child.pid), 'stub 应自行退出');
  const r = await watchAndReap({ card: id, seg: 'seg1', pid: child.pid, intervalMs: 20, graceMs: 0 });
  assert.equal(r.action, 'closed', JSON.stringify(r));
  assert.equal(rowOf(id).status, 'closed');
});

test('GREEN. lane 崩溃（非零退出）⇒ 看守收口，且卡面 in_review ⇒ registry 记 done', { skip: SKIP }, async () => {
  const id = 'T-20260101-060004-crash';
  const crash = path.join(BIN, 'lane-crash');
  fs.writeFileSync(crash, '#!/bin/sh\nsleep 0.1\nexit 3\n');
  fs.chmodSync(crash, 0o755);
  writeCard(id, { status: 'in_review' });           // lane 交付后崩在收尾：卡面已是 in_review
  const child = spawnChild(crash, [], { detached: true, stdio: 'ignore' });
  child.unref();
  live.push(child.pid);
  sessionSet(id, { seg: 'seg1', owner: 'linus', backend: 'claude', phase: 'seg1', pid: child.pid, log: '', status: 'running', id: SID });

  assert.ok(await waitDead(child.pid), 'stub 应已退出');
  const r = await reapOnce({ card: id, seg: 'seg1', pid: child.pid });
  assert.equal(r.action, 'closed', JSON.stringify(r));
  assert.equal(r.status, 'done', '卡面 in_review ⇒ lane 终态 done（工作已交付）');
  assert.equal(regEntry(id).status, 'done');
  assert.equal(rowOf(id).status, 'done');
});

// ── 幂等 / 不越权 / 不误杀 ──────────────────────────────────────────────────

test('幂等：看守二次运行 = 零写（endedAt 不重复追加，不再写卡）', { skip: SKIP }, async () => {
  const id = 'T-20260101-060005-idem';
  const pid = startLane(id);
  killAndReap(pid, 'SIGKILL');
  assert.ok(await waitDead(pid));
  await watchAndReap({ card: id, seg: 'seg1', pid, intervalMs: 20, graceMs: 0 });
  const raw1 = cardRaw(id);
  const r2 = await watchAndReap({ card: id, seg: 'seg1', pid, intervalMs: 20, graceMs: 0 });
  assert.equal(r2.action, 'noop', JSON.stringify(r2));
  assert.equal(r2.reason, 'already_terminal');
  assert.equal(cardRaw(id), raw1, '二次运行不得改写卡（零写）');
});

test('幂等：lane 自己已 session-close ⇒ 看守零写（不覆盖他方终态）', { skip: SKIP }, async () => {
  const id = 'T-20260101-060006-selfclose';
  const pid = startLane(id);
  sessionClose(id, 'seg1', 'closed');                 // lane 自觉收尾（happy path）
  killAndReap(pid, 'SIGKILL');
  assert.ok(await waitDead(pid));
  const raw1 = cardRaw(id);
  const r = await watchAndReap({ card: id, seg: 'seg1', pid, intervalMs: 20, graceMs: 0 });
  assert.equal(r.action, 'noop', JSON.stringify(r));
  assert.equal(cardRaw(id), raw1, '不得改写 lane 自己写的终态');
});

test('不误杀：pid 仍活 ⇒ 看守不动（--once）', { skip: SKIP }, async () => {
  const id = 'T-20260101-060007-alive';
  const pid = startLane(id);
  const r = await watchAndReap({ card: id, seg: 'seg1', pid, once: true });
  assert.equal(r.action, 'noop', JSON.stringify(r));
  assert.equal(r.reason, 'still_running');
  assert.equal(rowOf(id).status, 'running', '活 lane 的行不得被动');
  killAndReap(pid, 'SIGKILL');
});

test('不越权：行已被另一条**活** pid 接管 ⇒ 看守不动它', { skip: SKIP }, async () => {
  const id = 'T-20260101-060008-taken';
  const livePid = startLane(id);                       // 行 pid = 活进程
  const r = await reapOnce({ card: id, seg: 'seg1', pid: 999999 }); // 看守盯的是另一个（死）pid
  assert.equal(r.action, 'noop', JSON.stringify(r));
  assert.match(String(r.reason), /row_taken_by_live_pid/);
  assert.equal(rowOf(id).status, 'running');
  killAndReap(livePid, 'SIGKILL');
});

test('判据：pid 未知不得读成 pid 已死 —— 循环看守缺 pid 显式报错（零写）', { skip: SKIP }, async () => {
  assert.equal(parseReaperArgs(['x', 'seg1', 'pid=']).pid, null, '空 pid 值 ⇒ null');
  assert.equal(parseReaperArgs(['x', 'seg1', 'pid=0']).pid, null, '非正 pid ⇒ null');
  assert.equal(parseReaperArgs(['x', 'seg1', 'pid=abc']).pid, null);
  assert.equal(parseReaperArgs(['x', 'seg1', '--pid', '4242']).pid, 4242);

  const id = 'T-20260101-060014-nopid';
  const pid = startLane(id);
  const r = await watchAndReap({ card: id, seg: 'seg1', intervalMs: 10 }); // 无 pid
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.reason), /pid_required/);
  assert.equal(rowOf(id).status, 'running', '缺 pid 时不得收口（零写）');
  killAndReap(pid, 'SIGKILL');
});

test('判据：僵尸态（ps stat=Z）判「已终结」——单看 kill(pid,0) 会把僵尸误读成「还在跑」', { skip: SKIP }, () => {
  // 纯判据（`ps -o stat=` 首列）——真僵尸只能由「短命父 + detached 子」造出，进程内不可造，
  // 故此处锁死分类函数，另加两条真实 ps 读数（活进程 / 死 pid）证明链路本身通。
  assert.equal(lifecycle.isZombieStat('Z'), true);
  assert.equal(lifecycle.isZombieStat('Z+'), true);
  assert.equal(lifecycle.isZombieStat('S'), false);
  assert.equal(lifecycle.isZombieStat('R+'), false);
  assert.equal(lifecycle.isZombieStat(''), false);
  assert.equal(lifecycle.laneProcessAlive(process.pid), true, '活进程应判活（真 ps 读数）');
  assert.equal(lifecycle.laneProcessAlive(999999), false, '死 pid 应判死');
});

// ── 接线：spawn-lane 起会话 ⇒ 必然起看守；回退开关；起不来 ⇒ fail-closed ─────────

test('接线：spawn-lane 起会话后自动起看守（reaper.state=armed，真进程存活）', { skip: SKIP }, async () => {
  const id = 'T-20260101-060009-wired';
  writeCard(id, { status: 'in_progress' });
  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reaper?.state, 'armed', `应起看守，实际 ${JSON.stringify(r.reaper)}`);
  live.push(r.reaper.pid);
  assert.equal(registryMod.isPidAlive(r.reaper.pid), true, '看守应是存活真进程');
  assert.equal(rowOf(id).status, 'running');
  // 收尾：杀掉看守与 lane（本测试只验接线，收口链路由上面的 GREEN 例覆盖）
  killAndReap(r.reaper.pid, 'SIGKILL');
  killAndReap(r.pid, 'SIGKILL');
});

test('接线：--dry-run 只报 would_arm（零副作用，不起看守）', { skip: SKIP }, () => {
  const id = 'T-20260101-060010-dryarm';
  writeCard(id, { status: 'in_progress' });
  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reaper, 'would_arm');
  assert.equal(fs.existsSync(path.join(WS, id, 'linus-1.out.jsonl')), false, 'dry-run 不得起进程');
});

test('回退开关：--no-reaper（等价 OPENCLAW_TEAM_REAPER=0）⇒ 不起看守', { skip: SKIP }, () => {
  const id = 'T-20260101-060011-noreaper';
  writeCard(id, { status: 'in_progress' });
  // spawn-lane 的旗标解析：`--no-reaper` ⇒ reaper:false；缺省 ⇒ reaper:true
  assert.equal(spawnParseArgs(['x', 'linus', '--no-reaper']).reaper, false);
  assert.equal(spawnParseArgs(['x', 'linus']).reaper, true);

  const r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false, reaper: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reaper?.state, 'disabled');
  killAndReap(r.pid, 'SIGKILL');

  process.env.OPENCLAW_TEAM_REAPER = '0';
  try {
    assert.equal(reaperEnabled(), false, 'env 回退开关应生效');
  } finally {
    delete process.env.OPENCLAW_TEAM_REAPER;
  }
  assert.equal(reaperEnabled(), true, '未设 ⇒ 默认开');
});

test('fail-closed：看守起不来 ⇒ 拒绝起会话，且把已登记的行**就地收口**（不留无人收口的 running）', { skip: SKIP }, async () => {
  const id = 'T-20260101-060012-armfail';
  writeCard(id, { status: 'in_progress' });
  process.env.OPENCLAW_TEAM_REAPER_NODE = path.join(BIN, 'no-such-node');
  let r;
  try {
    r = spawnLane({ card: id, owner: 'linus', seg: 'seg1', backend: 'claude', dryRun: false });
  } finally {
    delete process.env.OPENCLAW_TEAM_REAPER_NODE;
  }
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.reason), /^lane_reaper_failed/, JSON.stringify(r));
  assert.equal(rowOf(id).status, 'closed', '拒绝路径必须先把已登记的会话行收口（fail-closed，不留漂移）');
  assert.ok(!fmOf(id).active_session_id, 'active_session_id 应清空（空值在序列化层落成缺键）');
  const row = rowOf(id);
  assert.equal(regEntryFor(id, row.id).status, 'closed', 'registry 同侧收口');
  if (r.pid) {
    const t0 = Date.now();
    while (registryMod.isPidAlive(r.pid) && Date.now() - t0 < 3000) await new Promise((res) => setTimeout(res, 25));
    assert.equal(registryMod.isPidAlive(r.pid), false, '拒绝时 lane 进程应被终止');
  }
});

test('看守 CLI：pid 已死 ⇒ 一行 JSON `action:closed`，退出码 0（可被 spawn-lane/人工复用）', { skip: SKIP }, async () => {
  const id = 'T-20260101-060013-cli';
  writeCard(id, {
    status: 'in_progress',
    segs: [`- seg:seg1 · owner:linus · backend:claude · id:${SID} · phase:seg1 · status:running · pid:999999 · 2026-01-01T00:00:00.000Z`],
    active: SID,
  });
  const out = spawnSync(process.execPath, [path.join(LAYOUT, 'scripts', 'lane-reaper.mjs'), id, 'seg1', 'pid=999999', '--once', 'grace=0'], { encoding: 'utf8' });
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  const last = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(last.action, 'closed', JSON.stringify(last));
  assert.equal(rowOf(id).status, 'closed');
});
