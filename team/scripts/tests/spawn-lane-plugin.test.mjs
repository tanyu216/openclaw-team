#!/usr/bin/env node
/**
 * spawn-lane-plugin.test.mjs — Codex 插件 lane（harness=plugin）契约测试
 * 卡 T-20261013-012318-4（A2 实现）· 契约 guides/codex-plugin-lane-contract.md §3/§4/§5/§8
 *
 * 覆盖（逐条对应卡 Acceptance）：
 *   ① 入口 harness 值域 + 拒绝码（unknown_harness / harness_plugin_requires_codex，exit 2）
 *   ② 后端分派双分支（cli 字节不变 / plugin 网关调度形态，句柄 = native thread id）
 *   ③ 两步回填：pending 先写 → 读回 native thread id → bound 覆盖同一 seg 行；
 *      绑定超时 ⇒ lane 判 failed 且回报 thread_bind_timeout（不静默挂起）
 *   ④ registry 增量字段（backend/harness/thread_id/id_state/seg）+ 去重键纳入 seg +
 *      绑定步关闭 pending 行（G-1：不残留第二条 running）
 *   ⑤ 判活口径 isEntryAlive（G7：CLI 看 pid / 插件看 native thread 可达）
 *   ⑧ G8 日志导出（evidence/plugin-<ts>.log + manifest.json）
 *   ⑨ G3 门禁兼容：check-sessions 识别 `harness:` 段、历史行视作 cli 且不误报
 *
 * 隔离：**materialise 一份部署布局**（vendored scripts/ + skills/task-ops 符号链接 + tasks/），
 * 再设 OPENCLAW_TEAM_ROOT 指向它（team-paths.mjs 于模块加载期读取该变量）——**绝不碰真实看板**。
 * provider（task-ops ACL）**故意不 vendored**：缺 provider 时整档 skip（与 spawn-lane.test.mjs 同口径）。
 * 风格：真实 temp 目录 + 动态 import + 真实子进程，不 mock 内部函数。
 * 运行：node --test team/scripts/tests/spawn-lane-plugin.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const SCRIPTS = path.join(HERE, '..');                     // <repo>/team/scripts

/** 定位携带 ACL 库的 provider 安装目录（与 spawn-lane.test.mjs 同口径） */
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

/**
 * provider 半能力探针。本仓只带「插件 lane」的**仓库半**：spawn-lane 负责把 `harness`/`id_state` 传进
 * `task.session-set`；**渲染卡行 `harness:` 段**与**写侧白名单**由 provider ACL（task-ops，有意不随仓）
 * 实现。provider 尚未升级时，下列用例断言的正是那一半 ⇒ 显式 skip（而非假红），理由即缺口所在。
 */
const PROVIDER_HARNESS = PROVIDER
  ? (() => { try { return /harness/.test(fs.readFileSync(path.join(PROVIDER, 'lib', 'task.mjs'), 'utf8')); } catch { return false; } })()
  : false;
const SKIP_ACL = PROVIDER_HARNESS
  ? false
  : 'provider ACL 尚未支持 harness/id_state（插件 lane 的 provider 半不在本仓；契约 §4.2 / §11 G-1）';
const aclTest = SKIP_ACL ? nodeTest.skip : nodeTest;

/** materialise 部署布局：vendored scripts/ + skills/task-ops 符号链接 + tasks/ + bin/ */
const LAYOUT = PROVIDER ? (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-laneplugin-'));
  for (const d of ['scripts', 'tasks', 'tasks/.locks', 'workspace', 'skills', 'bin']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
  }
  fs.symlinkSync(PROVIDER, path.join(root, 'skills', 'task-ops'), 'dir');
  fs.writeFileSync(path.join(root, 'projects.json'), '{}\n');
  return root;
})() : null;

let sp, reg, t, cs;
let TASKS, REGISTRY_PATH;

if (LAYOUT) {
  TASKS = path.join(LAYOUT, 'tasks');
  REGISTRY_PATH = path.join(LAYOUT, 'claude-sessions.json');
  process.env.OPENCLAW_TEAM_ROOT = LAYOUT;
  // （原 `OPENCLAW_LANE_ISOLATION=0` 已随隔离机制移除：cwd 恒为仓根，本档无需再钉定。）

  const staged = (rel) => import(pathToFileURL(path.join(LAYOUT, rel)).href);
  sp = await staged('scripts/spawn-lane.mjs');
  reg = await staged('scripts/registry.mjs');
  cs = await staged('scripts/check-sessions.mjs');
  t = await staged('skills/task-ops/lib/task.mjs');
}

after(() => { if (LAYOUT) fs.rmSync(LAYOUT, { recursive: true, force: true }); });

const CARD_BODY = '## Background\nx\n## Acceptance\n- [ ] a\n## Progress\n## Comments\n## Sessions\n## Report\n';
function writeCard(id, fmExtra = '') {
  fs.writeFileSync(
    path.join(TASKS, `${id}.md`),
    `---\nid: ${id}\ntitle: plugin lane test\nassignee: linus\nstatus: in_progress\npriority: high\nproject: __team__\nclaimed_by: linus\nsubsession_ids: []\nactive_session_id: ""\n${fmExtra}---\n${CARD_BODY}`
  );
}
const readRegistry = () => JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const entriesOf = (id) => readRegistry().filter((e) => e.task_id === id);
const sessionsLine = (id) => fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8').split('\n').find((l) => l.startsWith('- seg:'));
/** 清空临时看板（check-sessions 全盘扫描 ⇒ 跨用例残留会互相污染，判定必须确定） */
function clearBoard() {
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
  fs.rmSync(REGISTRY_PATH, { force: true });
}
/** 写一个可执行的 stub 插件调度器：按行回 NDJSON（含 native thread id / 终态 result） */
function writeStubBin(name, lines) {
  const p = path.join(LAYOUT, 'bin', name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${lines.map((l) => `echo '${l}'`).join('\n')}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}
/** 临时目录里放一份“网关日志”，供 G8 导出（不碰真实 /tmp/openclaw） */
function fakeGatewayLogDir(name) {
  const d = path.join(LAYOUT, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'openclaw-2026-10-13.log'), '{"plugin":"codex"}\n');
  return d;
}

// ---- ① 入口 harness 值域 / 拒绝码 -------------------------------------------

test('1. parseArgs：harness 缺省 cli；--plugin ⇒ plugin；harness=plugin 显式值', () => {
  assert.equal(sp.parseArgs(['CARD', 'linus']).harness, 'cli', '缺省应为 cli（默认路径向后兼容）');
  assert.equal(sp.parseArgs(['CARD', 'linus', '--plugin']).harness, 'plugin', '--plugin 等价 harness=plugin');
  assert.equal(sp.parseArgs(['CARD', 'linus', 'backend=codex', 'harness=plugin']).harness, 'plugin');
});

test('2. spawnLane：未知 harness ⇒ usage 错（exit 2 码 + unknown_harness:<v>）', () => {
  const r = sp.spawnLane({ card: 'T-20260101-000000-x', owner: 'linus', backend: 'codex', harness: 'bogus', dryRun: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 2, '用法错必须 exit 2');
  assert.equal(r.reason, 'unknown_harness:bogus');
});

test('3. spawnLane：harness=plugin 非 codex 后端 ⇒ usage 错（插件天然只有 Codex 腿）', () => {
  const r = sp.spawnLane({ card: 'T-20260101-000000-x', owner: 'linus', backend: 'claude', harness: 'plugin', dryRun: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 2);
  assert.match(r.reason, /^harness_plugin_requires_codex\(backend=claude\)$/);
});

// ---- ② 后端分派双分支 -------------------------------------------------------

test('4. buildCommand：cli 分支对 codex 产出带沙箱/加目录的 exec（T-20261013-164816 修复后的形状）', () => {
  // 本用例原断 `['exec','P']` —— 那是 T-20261013-164816（codex 沙箱可写根 EPERM 修复）之前的口径；
  // 本分支早于该修复，合并进 dev 时保留 dev 的修复形状（`--sandbox workspace-write` 必须显式 +
  // `--add-dir <wsDir>`/`--add-dir <team>` 把报告落点并入可写根）。
  const c = sp.buildCommand({ backend: 'codex', harness: 'cli', bin: 'codex', prompt: 'P', wsDir: '/ws', team: '/team', sid: 's', name: 'n' });
  assert.deepEqual(c.args, ['exec', '--sandbox', 'workspace-write', '--add-dir', '/ws', '--add-dir', '/team', 'P']);
  assert.equal(c.harness, 'cli');
});

test('5. buildCommand：plugin 分支产出网关调度形态，prompt 为单个 argv 元素（不拆词）', () => {
  const prompt = 'line one\nline two with spaces';
  const c = sp.buildCommand({ backend: 'codex', harness: 'plugin', bin: 'openclaw', prompt, wsDir: '/ws', cwd: '/repo', sid: null, name: 'n' });
  assert.equal(c.harness, 'plugin');
  assert.equal(c.args.filter((a) => a === prompt).length, 1, 'prompt 应为单个 argv 元素');
  const s = c.args.join(' ');
  assert.match(s, /--cwd \/repo/, 'cwd 应绑定 resolveCwd 结果（契约 §8.5）');
  assert.match(s, /--sandbox workspace-write/);
  assert.match(s, /--approval-policy on-failure/, 'G-4：审批姿态与 CLI lane 等价，不开旁路');
  assert.notEqual(c.args[0], 'openclaw', 'bin 与 args 不得重复携带可执行文件');
});

test('6. expandPluginCmd：占位符逐项替换，未知占位符原样保留', () => {
  const out = sp.expandPluginCmd('a --model {model} --cwd {cwd} {nope}', { model: 'm', cwd: '/c' });
  assert.deepEqual(out, ['a', '--model', 'm', '--cwd', '/c', '{nope}']);
});

// ---- ③ 绑定读回 / 超时 ------------------------------------------------------

test('7. parseThreadId：接受 thread_id / threadId / session_id；无则 null', () => {
  assert.equal(sp.parseThreadId('{"type":"x","thread_id":"T1"}'), 'T1');
  assert.equal(sp.parseThreadId('noise\n{"threadId":"T2"}\n'), 'T2');
  assert.equal(sp.parseThreadId('{"session_id":"T3"}'), 'T3');
  assert.equal(sp.parseThreadId('{"type":"item"}\nnot json'), null);
  assert.equal(sp.parseThreadId(''), null);
});

test('8. awaitThreadId：读回 native thread id；超时 ⇒ {timeout:true}', () => {
  const lp = path.join(LAYOUT, 'bind-ok.jsonl');
  fs.writeFileSync(lp, '{"type":"item"}\n{"type":"thread.started","thread_id":"TH-9"}\n');
  assert.deepEqual(sp.awaitThreadId(lp, { timeoutMs: 200, pollMs: 10 }), { threadId: 'TH-9' });

  const miss = path.join(LAYOUT, 'bind-miss.jsonl');
  fs.writeFileSync(miss, '{"type":"item"}\n');
  assert.equal(sp.awaitThreadId(miss, { timeoutMs: 120, pollMs: 20 }).timeout, true);
});

// ---- ⑧ G8 日志导出 ---------------------------------------------------------

test('9. exportPluginLogs：导出插件日志 + manifest（exported_at/lane_seg/source），只收网关日志', () => {
  const src = path.join(LAYOUT, 'gwlogs');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'openclaw-2026-10-13.log'), '{"plugin":"codex"}\n');
  fs.writeFileSync(path.join(src, 'openclaw-work-2026-10-13.log'), '{"plugin":"codex","p":"work"}\n');
  fs.writeFileSync(path.join(src, 'unrelated.txt'), 'nope\n');
  const ws = path.join(LAYOUT, 'ws-g8');
  const r = sp.exportPluginLogs({ wsDir: ws, seg: 'seg1', sourceDir: src, now: new Date('2026-10-13T00:00:00Z') });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(r.path));
  assert.ok(r.bytes > 0);
  const man = JSON.parse(fs.readFileSync(path.join(ws, 'evidence', 'manifest.json'), 'utf8'));
  assert.equal(man.lane_seg, 'seg1');
  assert.equal(man.exported_at, '2026-10-13T00:00:00.000Z');
  assert.deepEqual(man.source.sort(), ['openclaw-2026-10-13.log', 'openclaw-work-2026-10-13.log'], '只收网关日志，排除无关文件');
});

// ---- ④ registry 增量：去重键 / pending 关闭 ---------------------------------

test('10. registry：去重键纳入 seg ⇒ 同 session_id 不同 seg 各占一行', () => {
  const id = 'T-20260101-000010-segkey';
  clearBoard();
  writeCard(id);
  const base = { task_id: id, owner: 'linus', session_id: 'same-sid', status: 'running', pid: process.pid };
  reg.upsertSessionEntry({ ...base, seg: 'seg1', phase: 'seg1' });
  reg.upsertSessionEntry({ ...base, seg: 'seg2', phase: 'seg2' });
  assert.equal(entriesOf(id).length, 2, 'seg 应参与去重键（否则两条相互覆盖）');
});

test('11. registry：closePendingEntries 只关闭该 (task,seg) 的 pending running 行', () => {
  const id = 'T-20260101-000011-closepending';
  clearBoard();
  writeCard(id);
  reg.upsertSessionEntry({ task_id: id, owner: 'linus', seg: 'seg1', phase: 'seg1', session_id: 'pending', status: 'running', id_state: 'pending', harness: 'plugin' });
  reg.upsertSessionEntry({ task_id: id, owner: 'linus', seg: 'seg2', phase: 'seg2', session_id: 'pending', status: 'running', id_state: 'pending', harness: 'plugin' });
  reg.upsertSessionEntry({ task_id: id, owner: 'linus', seg: 'seg1', phase: 'seg1', session_id: 'TH-1', status: 'running', id_state: 'bound', harness: 'plugin' });

  const r = reg.closePendingEntries(id, 'seg1', 'closed');
  assert.equal(r.ok, true);
  assert.equal(r.updated, 1, '只应关闭 seg1 的 pending 行');
  const rows = entriesOf(id);
  assert.equal(rows.find((e) => e.seg === 'seg1' && e.session_id === 'pending').status, 'closed');
  assert.equal(rows.find((e) => e.seg === 'seg2' && e.session_id === 'pending').status, 'running', 'seg2 不受影响');
  assert.equal(rows.find((e) => e.session_id === 'TH-1').status, 'running', 'bound 行不受影响');
});

// ---- ⑤ 判活口径（G7） -------------------------------------------------------

test('12. isEntryAlive：CLI 看 pid；插件不得把（长存活的）网关 pid 当判活依据', () => {
  assert.equal(reg.isEntryAlive({ harness: 'cli', pid: process.pid }), true);
  assert.equal(reg.isEntryAlive({ pid: 999999 }), false, '死 pid ⇒ 不活');
  assert.equal(reg.isEntryAlive({ harness: 'plugin', pid: process.pid, id_state: 'pending', thread_id: '' }), false, '未 bound ⇒ 不活');
  assert.equal(reg.isEntryAlive({ harness: 'plugin', pid: process.pid, id_state: 'bound', thread_id: 'TH' }), false, '无探测面且无日志 ⇒ 保守判不可达');
});

test('13. threadReachable：注入探针生效；在飞代理（日志未报终态）判可达，报终态后不可达', () => {
  const entry = { harness: 'plugin', id_state: 'bound', thread_id: 'TH-X', log: '' };

  reg.setThreadProbe(() => true);
  assert.equal(reg.threadReachable(entry), true, '注入探针 ⇒ 以探针为准');

  reg.setThreadProbe(null);
  const log = path.join(LAYOUT, 'thread-flight.jsonl');
  fs.writeFileSync(log, '{"type":"thread.started","thread_id":"TH-X"}\n');
  assert.equal(reg.threadReachable({ ...entry, log }, { now: Date.now() }), true, '未报终态 ⇒ 在飞（代理判可达）');

  fs.appendFileSync(log, '{"type":"result","exit_code":0}\n');
  assert.equal(reg.threadReachable({ ...entry, log }, { now: Date.now() }), false, '已报终态 ⇒ 不可达（交 reconcile）');

  assert.equal(reg.threadReachable({ id_state: 'bound', thread_id: 'TH' }), false, '历史行（无 harness）不得判成插件 lane');
});

// ---- ③ 两步回填（ACL 同写）+ ⑨ 门禁兼容 ------------------------------------

aclTest('14. 两步回填：pending 同写 → bound 覆盖同一 seg 行，registry 无残留 running（G-1）', () => {
  const id = 'T-20260101-000014-twostep';
  clearBoard();
  writeCard(id);

  const p1 = t.sessionSet(id, { seg: 'seg1', owner: 'linus', backend: 'codex', harness: 'plugin', phase: 'seg1', pid: '-', status: 'running', id: 'pending', id_state: 'pending' });
  assert.equal(p1.ok, true);
  assert.match(sessionsLine(id), /backend:codex · harness:plugin · id:pending/, '卡行应插 harness 段且 id=pending');
  assert.equal(entriesOf(id).length, 1);
  assert.equal(entriesOf(id)[0].id_state, 'pending');
  assert.equal(entriesOf(id)[0].backend, 'codex');
  assert.equal(entriesOf(id)[0].seg, 'seg1');

  const p2 = t.sessionSet(id, { seg: 'seg1', owner: 'linus', backend: 'codex', harness: 'plugin', phase: 'seg1', pid: '-', status: 'running', id: 'th_abc', id_state: 'bound', thread_id: 'th_abc' });
  assert.equal(p2.ok, true);

  const allLines = fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8').split('\n').filter((l) => l.startsWith('- seg:'));
  assert.equal(allLines.length, 1, '卡内该 seg 只应有一行（upsert 键 = seg:<seg>）');
  assert.match(allLines[0], /id:th_abc/, '卡行 id 应覆盖为 native thread id');
  assert.match(allLines[0], /harness:plugin/);

  const rows = entriesOf(id);
  const running = rows.filter((e) => e.status === 'running');
  assert.equal(running.length, 1, '不得残留第二条 running（否则双计并发额度）');
  assert.equal(running[0].thread_id, 'th_abc');
  assert.equal(running[0].id_state, 'bound');
  assert.equal(running[0].session_id, 'th_abc');
  // G6 映射：卡行 id == registry.thread_id
  assert.match(allLines[0], new RegExp(`id:${running[0].thread_id}(\\s|·|$)`));
});

aclTest('15. ACL：非法 harness / id_state ⇒ 拒绝且不落盘（写侧白名单加固）', () => {
  const id = 'T-20260101-000015-badharness';
  clearBoard();
  writeCard(id);
  const bad = t.sessionSet(id, { seg: 'seg1', owner: 'linus', backend: 'codex', harness: 'bogus', status: 'running' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid_harness');
  assert.equal(fs.existsSync(REGISTRY_PATH), false, '非法值不得写 registry');
  assert.equal(sessionsLine(id), undefined, '非法值不得写卡');

  const bad2 = t.sessionSet(id, { seg: 'seg1', owner: 'linus', backend: 'codex', harness: 'plugin', id_state: 'nope', status: 'running' });
  assert.equal(bad2.ok, false);
  assert.equal(bad2.reason, 'invalid_id_state');
});

test('16. 向后兼容：无 harness 段的历史行 ⇒ 解析为 cli，且不误判卡片缺失（软告警）', () => {
  clearBoard();
  const id = 'T-20260101-000016-legacy';
  writeCard(id);
  const p = path.join(TASKS, `${id}.md`);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('## Sessions\n', '## Sessions\n- seg:seg1 · owner:linus · backend:codex · id:legacy-sid · phase:seg1 · status:running · pid:999999 · 2026-01-01T00:00:00.000Z\n'));
  const r = cs.checkSessions({ registry: [] });
  assert.equal(r.ok, true, '历史行（死 pid）应为软告警而非硬失败');
  assert.ok(r.notes.some((n) => n.type === 'stale_card_line' && n.harness === 'cli'), '历史行应解析为 cli 并软告警');
});

// ---- ⑨ check-sessions：插件 lane 不误报 ------------------------------------

test('17. check-sessions：bound 插件 lane（卡行 + registry 一致）⇒ 无 registry_only/card_only', () => {
  clearBoard();
  const id = 'T-20260101-000017-csplugin';
  writeCard(id);
  fs.writeFileSync(REGISTRY_PATH, '[]\n');
  const log = path.join(LAYOUT, 'cs-thread.jsonl');
  fs.writeFileSync(log, '{"type":"thread.started","thread_id":"TH-CS"}\n');
  t.sessionSet(id, { seg: 'seg1', owner: 'linus', backend: 'codex', harness: 'plugin', phase: 'seg1', pid: '-', log, status: 'running', id: 'TH-CS', id_state: 'bound', thread_id: 'TH-CS' });
  const r = cs.checkSessions();
  assert.deepEqual(r.inconsistencies, [], `插件 lane 不应产生硬失败，实际 ${JSON.stringify(r.inconsistencies)}`);
});

// ---- ③ 绑定超时（入口） -----------------------------------------------------

aclTest('18. 绑定超时 ⇒ lane 判 failed 并回报 thread_bind_timeout（不静默挂起）', () => {
  clearBoard();
  const id = 'T-20260101-000018-timeout';
  writeCard(id);
  fs.writeFileSync(REGISTRY_PATH, '[]\n');
  const keep = process.env.OPENCLAW_GATEWAY_LOG_DIR;
  process.env.OPENCLAW_GATEWAY_LOG_DIR = fakeGatewayLogDir('gwlogs-timeout');
  process.env.OPENCLAW_CODEX_PLUGIN_BIN = writeStubBin('stub-nobind', ['{"type":"item"}']);

  const r = sp.spawnLane({ card: id, owner: 'linus', backend: 'codex', harness: 'plugin', bindTimeoutMs: 300, bindPollMs: 50 });
  if (keep === undefined) delete process.env.OPENCLAW_GATEWAY_LOG_DIR; else process.env.OPENCLAW_GATEWAY_LOG_DIR = keep;

  assert.equal(r.ok, false, '绑定超时必须拒绝');
  assert.equal(r.code, 1);
  assert.match(r.reason, /^thread_bind_timeout\(seg=seg1,ms=\d+\):reconcile$/);
  assert.match(sessionsLine(id), /status:failed/, '卡行应判 failed');
  assert.equal(entriesOf(id).filter((e) => e.status === 'running').length, 0, '不得残留 running 条目');
});

// ---- 端到端：入口 ⇒ 两步回填 + G6 + G8 --------------------------------------

aclTest('19. 端到端（入口）：spawn-lane 插件 lane ⇒ 两步回填 + G6 映射 + G8 证据', () => {
  clearBoard();
  const id = 'T-20260101-000019-e2e';
  writeCard(id);
  fs.writeFileSync(REGISTRY_PATH, '[]\n');
  const keepDir = process.env.OPENCLAW_GATEWAY_LOG_DIR;
  const keepBin = process.env.OPENCLAW_CODEX_PLUGIN_BIN;
  process.env.OPENCLAW_GATEWAY_LOG_DIR = fakeGatewayLogDir('gwlogs-e2e');
  process.env.OPENCLAW_CODEX_PLUGIN_BIN = writeStubBin('stub-bind', [
    '{"type":"thread.started","thread_id":"th_e2e_1"}',
    '{"type":"result","subtype":"success","exit_code":0}',
  ]);

  const r = sp.spawnLane({ card: id, owner: 'linus', backend: 'codex', harness: 'plugin' });
  if (keepDir === undefined) delete process.env.OPENCLAW_GATEWAY_LOG_DIR; else process.env.OPENCLAW_GATEWAY_LOG_DIR = keepDir;
  if (keepBin === undefined) delete process.env.OPENCLAW_CODEX_PLUGIN_BIN; else process.env.OPENCLAW_CODEX_PLUGIN_BIN = keepBin;

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.harness, 'plugin');
  assert.equal(r.id_state, 'bound');
  assert.equal(r.thread_id, 'th_e2e_1');
  assert.equal(r.session_id, 'th_e2e_1', '插件 lane 的句柄 = native thread id（非确定性 UUIDv5）');
  assert.equal(r.pid, null, '插件 lane 无独立 pid');

  // G6：卡行 id == registry.thread_id
  const line = sessionsLine(id);
  assert.match(line, /backend:codex · harness:plugin · id:th_e2e_1 ·/);
  const rows = entriesOf(id);
  const bound = rows.find((e) => e.id_state === 'bound');
  assert.equal(bound.thread_id, 'th_e2e_1');
  assert.equal(bound.status, 'running');
  assert.equal(rows.filter((e) => e.status === 'running').length, 1, 'pending 行应已被绑定步关闭');
  assert.ok(rows.some((e) => e.id_state === 'pending' && e.status === 'closed'), 'pending 行应留痕为 closed');

  // G8：evidence 落盘（启动 + 绑定后各一次）
  assert.ok(r.evidence && r.evidence.exported_at, 'G8：manifest 应有 exported_at');
  const evDir = path.join(LAYOUT, 'workspace', id, 'evidence');
  assert.ok(fs.readdirSync(evDir).some((f) => /^plugin-.*\.log$/.test(f)), 'G8：应导出 plugin-<ts>.log');
  assert.equal(JSON.parse(fs.readFileSync(path.join(evDir, 'manifest.json'), 'utf8')).lane_seg, 'seg1');
});
