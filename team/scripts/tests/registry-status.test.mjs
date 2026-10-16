#!/usr/bin/env node
/**
 * registry-status.test.mjs — registry status 写入加固：剥 `status=` 首缀 + 白名单校验
 *
 * 背景（T-20261009-224500-registrystatusfix）：`claude-sessions.json` 出现 13 条畸形 status
 * （`status=done`／`status=closed`，应为 `done`／`closed`）。根因＝caller 受文档记法
 * `[status=closed|failed]` 误导，把整串 `status=done` 当**参数值**传入位置参数；`setSessionStatus`
 * 原样落盘 ⇒ 污染（非白名单字面值，破坏严格比较与 reconcile）。
 *
 * 修复口径：**写入侧**（`setSessionStatus`/`upsertSessionEntry`/CLI；`task.sessionSet`/
 * `task.sessionClose`）剥除首缀 `status=` 并按白名单 `done|closed|failed|running` 校验；
 * 非法 ⇒ 拒绝（不落盘）+ 显式告警，绝不静默落错值。
 *
 * 隔离：`OPENCLAW_TEAM_ROOT` = mkdtemp（team-paths.mjs 于模块加载期读取该变量）——**绝不碰真实看板**。
 * 风格：真实 temp 目录 + 动态 import + 真实子进程跑 CLI，不 mock 内部函数。
 * 运行：node --test scripts/tests/registry-status.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

// 前置：先设 env，再动态 import（TEAM_ROOT 在模块加载期读取，import 顺序不可颠倒）
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-regstatus-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
const TASKS = path.join(ROOT, 'tasks');
fs.mkdirSync(path.join(TASKS, '.locks'), { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_CLI = path.join(HERE, '..', 'registry.mjs');
const TASK_CLI = path.join(PROVIDER || '', 'lib', 'task.mjs');
const REGISTRY_PATH = path.join(ROOT, 'claude-sessions.json');

// provider 依赖为**条件动态 import**：缺 provider 时 registry.mjs/lib.mjs 在 import 期即硬红。
let reg, t;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  reg = await import('../../scripts/registry.mjs');
  t = await import(pathToFileURL(path.join(PROVIDER, 'lib', 'task.mjs')).href);
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const CARD_BODY = '## Background\nx\n## Acceptance\n- [ ] a\n## Progress\n## Comments\n## Sessions\n## Report\n';
function writeCard(id) {
  fs.writeFileSync(
    path.join(TASKS, `${id}.md`),
    `---\nid: ${id}\ntitle: registry-status test\nassignee: linus\nstatus: in_progress\nproject: __team__\nsubsession_ids: []\nactive_session_id: ""\n---\n${CARD_BODY}`
  );
}
/** 清 registry（使条目数/残留断言确定）+ 写卡 */
function freshCard(id) {
  fs.rmSync(REGISTRY_PATH, { force: true });
  writeCard(id);
}
const readRegistry = () => JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const entriesOf = (id) => readRegistry().filter((e) => e.task_id === id);
const noPrefixAnywhere = (list) => list.every((e) => !String(e.status).includes('='));
const sessionsLine = (id) => fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8').split('\n').find((l) => l.startsWith('- seg:'));

// ---- ① normalizeStatus：剥首缀 + 白名单 ------------------------------------

test('1. normalizeStatus：剥 status= 首缀 + 白名单校验', () => {
  assert.deepEqual(reg.normalizeStatus('status=done'), { ok: true, status: 'done', normalized: true });
  assert.deepEqual(reg.normalizeStatus('status=closed'), { ok: true, status: 'closed', normalized: true });
  for (const s of ['done', 'closed', 'failed', 'running']) {
    const r = reg.normalizeStatus(s);
    assert.equal(r.ok, true, `${s} 应合法`);
    assert.equal(r.status, s);
    assert.equal(r.normalized, false, `${s} 值未改动 ⇒ normalized:false`);
  }
  for (const bad of ['bogus', 'status=bogus', 'status=', '']) {
    const r = reg.normalizeStatus(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应非法`);
    assert.equal(r.reason, 'invalid_status');
  }
});

// ---- ② setSessionStatus：status=done ⇒ done，全 registry 无前缀残留 --------

test('2. setSessionStatus：传 status=done ⇒ 落盘 done，全 registry 无 status= 前缀残留', () => {
  const id = 'T-20260101-020000-reg-a';
  freshCard(id);
  reg.upsertSessionEntry({ task_id: id, session_id: 'sid-a', owner: 'linus', phase: 'p', status: 'running' });

  const r = reg.setSessionStatus(id, 'sid-a', 'status=done');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 'done');
  assert.equal(r.normalized, true);
  assert.equal(entriesOf(id)[0].status, 'done', '应落规范化值 done');
  assert.ok(noPrefixAnywhere(readRegistry()), 'registry 不得有 status= 前缀残留');
});

// ---- ③ setSessionStatus：非法值 ⇒ 拒绝且不改写 ------------------------------

test('3. setSessionStatus：非法值 ⇒ ok:false 且该条 status 未被改写', () => {
  const id = 'T-20260101-020001-reg-b';
  freshCard(id);
  reg.upsertSessionEntry({ task_id: id, session_id: 'sid-b', owner: 'linus', phase: 'p', status: 'running' });

  for (const bad of ['bogus', 'status=bogus']) {
    const r = reg.setSessionStatus(id, 'sid-b', bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒`);
    assert.equal(r.reason, 'invalid_status');
    assert.equal(entriesOf(id)[0].status, 'running', '被拒时原值不得改写');
  }
  assert.ok(noPrefixAnywhere(readRegistry()));
});

// ---- ④ upsertSessionEntry：规范化 / 非法拒绝 --------------------------------

test('4. upsertSessionEntry：status=closed ⇒ closed；非法 ⇒ 拒绝且不落盘', () => {
  const id = 'T-20260101-020002-reg-c';
  freshCard(id);

  const ok = reg.upsertSessionEntry({ task_id: id, session_id: 'sid-c', owner: 'linus', phase: 'p', status: 'status=closed' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(entriesOf(id)[0].status, 'closed', '应落规范化值 closed');
  assert.ok(noPrefixAnywhere(readRegistry()));

  const before = readRegistry();
  const bad = reg.upsertSessionEntry({ task_id: id, session_id: 'sid-c2', owner: 'linus', phase: 'p', status: 'nope' });
  assert.equal(bad.ok, false, '非法 status 应拒绝该条写入');
  assert.equal(bad.reason, 'invalid_status');
  assert.equal(readRegistry().length, before.length, '非法条目不落盘');
});

// ---- ⑤ CLI 子进程：registry.mjs close <task> <sid> status=done --------------

test('5. 真实 CLI：registry.mjs close <task> <sid> status=done ⇒ registry status=done', () => {
  const id = 'T-20260101-020003-reg-cli';
  freshCard(id);
  reg.upsertSessionEntry({ task_id: id, session_id: 'sid-cli', owner: 'linus', phase: 'p', status: 'running' });

  const out = execFileSync(
    process.execPath,
    [REGISTRY_CLI, 'close', id, 'sid-cli', 'status=done'],
    { env: { ...process.env, OPENCLAW_TEAM_ROOT: ROOT }, encoding: 'utf8' }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(entriesOf(id)[0].status, 'done', 'CLI 入口应落规范化值');
  assert.ok(noPrefixAnywhere(readRegistry()));
});

// ---- ⑥ task.mjs ACL：sessionSet/sessionClose 前缀净化 ------------------------

test('6. task.mjs：sessionSet/sessionClose 传 status= 前缀 ⇒ 卡内 Sessions 与 registry 均干净', () => {
  const id = 'T-20260101-020004-reg-acl';
  freshCard(id);

  const s = t.sessionSet(id, { seg: 'seg1', owner: 'linus', backend: 'claude', phase: 'acl', pid: process.pid, status: 'status=running' });
  assert.equal(s.ok, true, JSON.stringify(s));
  const line = sessionsLine(id);
  assert.match(line, /status:running(\b|\s|$)/, '卡内应为 status:running');
  assert.ok(!line.includes('status='), '卡内 Sessions 行不得留 status= 前缀');
  const e = entriesOf(id).find((x) => x.session_id === s.session_id);
  assert.equal(e.status, 'running');
  assert.ok(noPrefixAnywhere(readRegistry()));

  const c = t.sessionClose(id, 'seg1', 'status=closed');
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.status, 'closed');
  const line2 = sessionsLine(id);
  assert.match(line2, /status:closed(\b|\s|$)/, '关闭后卡内应为 status:closed');
  assert.ok(!line2.includes('status='), '关闭后卡内不得留 status= 前缀');
  const e2 = entriesOf(id).find((x) => x.session_id === s.session_id);
  assert.equal(e2.status, 'closed');
  assert.ok(noPrefixAnywhere(readRegistry()));

  // 真实 CLI 路径（父回合走的调用路径）
  const id2 = 'T-20260101-020005-reg-aclcli';
  freshCard(id2);
  const out = execFileSync(
    process.execPath,
    [TASK_CLI, 'session-set', id2, 'seg=seg1', 'owner=linus', 'backend=claude', 'phase=cli', `pid=${process.pid}`, 'status=status=running'],
    { env: { ...process.env, OPENCLAW_TEAM_ROOT: ROOT }, encoding: 'utf8' }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(entriesOf(id2)[0].status, 'running');
  assert.ok(!sessionsLine(id2).includes('status='), 'CLI 路径卡内不得留 status= 前缀');
});

// ---- ⑦ task.mjs ACL：非法 status ⇒ 拒绝（不写卡不写 registry） ---------------

test('7. task.mjs：sessionSet/sessionClose 非法 status ⇒ 拒绝（不写卡不写 registry）', () => {
  const id = 'T-20260101-020006-reg-aclbad';
  freshCard(id);

  const s = t.sessionSet(id, { seg: 'seg1', owner: 'linus', phase: 'p', pid: process.pid, status: 'bogus' });
  assert.equal(s.ok, false, '非法 status 应拒绝登记');
  assert.equal(s.reason, 'invalid_status');
  assert.equal(fs.existsSync(REGISTRY_PATH), false, '非法不得写 registry');
  assert.equal(sessionsLine(id), undefined, '非法不得写卡内 Sessions');

  const c = t.sessionClose(id, 'seg1', 'status=bad');
  assert.equal(c.ok, false, '非法 status 应拒绝关闭');
  assert.equal(c.reason, 'invalid_status');
  assert.equal(fs.existsSync(REGISTRY_PATH), false, '非法不得写 registry');
});

// ---- ⑧ 读侧原语（loadRegistry 回退合并 / 存活判定 / 活跃查询）--------------
// 目的：写入加固不应改动读侧语义；同时覆盖 registry.mjs 读原语（覆盖率门禁 ≥80%）。
test('8. 读侧原语：loadRegistry 回退合并 + isPidAlive/activeSessions/hasActiveSession/formatActiveReason', () => {
  const id = 'T-20260101-020007-reg-read';
  freshCard(id);
  reg.upsertSessionEntry({ task_id: id, session_id: 'sid-live', owner: 'linus', phase: 'p', pid: process.pid, status: 'running' });
  reg.upsertSessionEntry({ task_id: id, session_id: 'sid-dead', owner: 'linus', phase: 'p', pid: 999999, status: 'running' });
  // legacy 回退：workspace/<task>/claude-sessions.json 独有条目应被 loadRegistry 追加并打标 legacy:true
  const wsDir = path.join(ROOT, 'workspace', id);
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'claude-sessions.json'), JSON.stringify([
    { task_id: id, owner: 'legacy', phase: 'legacy', session_id: 'sid-legacy', status: 'running', pid: process.pid },
  ]));

  const all = reg.loadRegistry();
  assert.ok(all.some((e) => e.session_id === 'sid-legacy' && e.legacy === true), 'legacy 独有条目应被回退合并并打标');
  assert.ok(all.every((e) => !String(e.status).includes('=')), '读侧不得见 status= 前缀');

  assert.equal(reg.isPidAlive(process.pid), true);
  assert.equal(reg.isPidAlive(999999), false, '死 pid 应判不存活');
  assert.equal(reg.isPidAlive(0), false, '非法 pid 应判不存活');

  const act = reg.activeSessions(id).map((e) => e.session_id).sort();
  assert.deepEqual(act, ['sid-legacy', 'sid-live'], '存活 pid 段应计活跃（含 legacy）；死 pid 段不计');
  const has = reg.hasActiveSession(id);
  assert.equal(has.active, true);
  assert.match(reg.formatActiveReason(has.sessions), /active_subsession\(pid=/);
});

// ---- ⑨ CLI 读/登记/migrate 入口（补齐 registry.mjs CLI 分支覆盖） -----------
test('9. 真实 CLI：register/list/active/migrate 入口可用（且迁移不改写污染）', () => {
  const id = 'T-20260101-020008-reg-cli2';
  freshCard(id);
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: ROOT };
  const runCli = (...a) => JSON.parse(execFileSync(process.execPath, [REGISTRY_CLI, ...a], { env, encoding: 'utf8' }));

  const r = runCli('register', id, 'owner=linus', 'phase=p', `pid=${process.pid}`, 'session_id=sid-cli2', 'status=running');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(runCli('list').total >= 1, true, 'list 应含已登记条目');
  assert.equal(runCli('active', id).active, true, 'active 应判该卡活跃');
  const mig = runCli('migrate');
  assert.equal(Array.isArray(mig.migrated), true, 'migrate 应返回 migrated 列表');
  assert.ok(noPrefixAnywhere(readRegistry()), 'migrate 后 registry 无 status= 前缀');
});
