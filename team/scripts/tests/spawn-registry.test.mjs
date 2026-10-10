#!/usr/bin/env node
/**
 * spawn-registry.test.mjs — spawn 登记链路：spawn ⇒ 团队级 registry 必然有条目 + reconcile 判定
 *
 * 背景（T-20261009-144306-spawnreg）：M4 子会话（session 9c9bda5e）跑完且父回合已提交，
 * 但团队级 `claude-sessions.json` 无该卡/该会话条目，卡内 `## Sessions` 亦无 pid ——
 * 根因是 spawn 登记步骤（`task.session-set`）只写卡内映射，**从不写团队级 registry**，
 * 而 registry 模块当时也没有任何写入 API ⇒ 父回合只能手改 JSON（实际被遗漏）。
 *
 * 本套件验证修复后：`sessionSet`（spawn 登记唯一步骤）**必然**写 canonical registry，
 * `sessionClose` 同步终态，`registry.activeSessions`（reconcile 原语）与 poll 防双跑守卫
 * 均可据此判活跃/僵尸。
 *
 * 隔离：OPENCLAW_TEAM_ROOT = mkdtemp（team-paths.mjs 于模块加载期读取该变量）——**绝不碰真实看板**。
 * 风格：真实 temp 目录 + 动态 import + 真实子进程跑 CLI，不 mock 内部函数。
 * 运行：node --test scripts/tests/spawn-registry.test.mjs
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

// 前置：先设 env，再动态 import（TEAM_ROOT 在模块加载期读取，import 顺序不可颠倒）
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-spawnreg-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
const TASKS = path.join(ROOT, 'tasks');
fs.mkdirSync(path.join(TASKS, '.locks'), { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASK_CLI = path.join(PROVIDER || '', 'lib', 'task.mjs');
const REGISTRY_PATH = path.join(ROOT, 'claude-sessions.json');
const DEAD_PID = 999999;

// provider 依赖为**条件动态 import**：缺 provider 时 lib.mjs/registry.mjs 在 import 期即硬红。
let t, pollEvaluate, activeSessions, isPidAlive;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  t = await import(pathToFileURL(path.join(PROVIDER, 'lib', 'task.mjs')).href);
  ({ pollEvaluate } = await import(pathToFileURL(path.join(PROVIDER, 'lib', 'schedule.mjs')).href));
  ({ activeSessions, isPidAlive } = await import('../../scripts/registry.mjs'));
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const CARD_BODY = '## Background\nx\n## Acceptance\n- [ ] a\n## Progress\n## Comments\n## Sessions\n## Report\n';
function writeCard(id, fmExtra = '') {
  fs.writeFileSync(
    path.join(TASKS, `${id}.md`),
    `---\nid: ${id}\ntitle: spawn-registry test\nassignee: linus\nstatus: in_progress\nproject: __team__\nsubsession_ids: []\nactive_session_id: ""\n${fmExtra}---\n${CARD_BODY}`
  );
}
/** 每张卡独立注册表基线：清 registry + 写卡，使条目数断言确定 */
function freshCard(id, fmExtra) {
  fs.rmSync(REGISTRY_PATH, { force: true });
  writeCard(id, fmExtra);
}
const readRegistry = () => JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const entriesOf = (id) => readRegistry().filter((e) => e.task_id === id);
const sessionsLine = (id) => fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8').split('\n').find((l) => l.startsWith('- seg:'));

// ---- spawn ⇒ registry 条目（ACL 路径） --------------------------------------

test('1. sessionSet（spawn 登记）⇒ 团队级 registry 出现该 seg 条目，且卡内 Sessions 有 pid', () => {
  const id = 'T-20260101-010000-spawn-a';
  freshCard(id);

  const r = t.sessionSet(id, { seg: 'seg1', owner: 'linus', backend: 'claude', phase: 'seg1-m4', pid: process.pid, log: '/tmp/a.out.jsonl', status: 'running' });

  assert.equal(r.ok, true);
  assert.equal(r.registry.ok, true, `registry 应写入成功，实际 ${JSON.stringify(r.registry)}`);
  assert.equal(fs.existsSync(REGISTRY_PATH), true, 'registry 文件应被创建');

  const reg = entriesOf(id);
  assert.equal(reg.length, 1, `应恰有 1 条，实际 ${reg.length}`);
  const e = reg[0];
  assert.equal(e.owner, 'linus');
  assert.equal(e.phase, 'seg1-m4');
  assert.equal(e.pid, process.pid);
  assert.equal(e.status, 'running');
  assert.equal(e.session_id, r.session_id, 'registry.session_id 应与卡内 / 返回值一致（resume 依据）');
  assert.ok(e.startedAt, 'startedAt 应存在');
  assert.equal(e.log, '/tmp/a.out.jsonl');

  const line = sessionsLine(id);
  assert.match(line, new RegExp(`pid:${process.pid}(\\b|\\s|$)`), '卡内 ## Sessions 行应含 pid');
  assert.match(line, new RegExp(`id:${r.session_id}`), '卡内 ## Sessions 行应含 session id');
  assert.equal(t.read(id).fm.active_session_id, r.session_id, 'active_session_id 应置为该会话');
});

test('2. 重复登记同 seg ⇒ 幂等（不产生重复行，无 pid 的重登记不抹掉既有 pid）', () => {
  const id = 'T-20260101-010001-spawn-b';
  freshCard(id);

  t.sessionSet(id, { seg: 'seg1', owner: 'linus', phase: 'p', pid: process.pid, status: 'running' });
  const again = t.sessionSet(id, { seg: 'seg1', owner: 'linus', phase: 'p', status: 'running' }); // 无 pid

  assert.equal(entriesOf(id).length, 1, '同 (task,owner,phase,session_id) 应覆盖而非追加');
  assert.equal(entriesOf(id)[0].pid, process.pid, '无 pid 的重登记应保留既有 pid');
  assert.ok(Array.isArray(again.warnings) && again.warnings.some((w) => w.startsWith('pid_missing')), '缺 pid 应告警');
});

test('3. 缺 pid ⇒ 登记仍成功但带 pid_missing 告警（可诊断，不静默）', () => {
  const id = 'T-20260101-010002-spawn-c';
  freshCard(id);

  const r = t.sessionSet(id, { seg: 'seg1', owner: 'linus', phase: 'p', status: 'running' });

  assert.equal(r.ok, true, '缺 pid 不应导致登记失败（不阻断 spawn）');
  assert.equal(r.registry.ok, true);
  assert.ok(r.warnings.some((w) => w.startsWith('pid_missing')), '应返回 pid_missing 告警');
  assert.equal('pid' in entriesOf(id)[0], false, '缺 pid 时条目不应带 pid 键');
});

// ---- reconcile 依 registry 判定活跃 / 僵尸 -----------------------------------

test('4. reconcile：running + 存活 pid ⇒ 活跃；running + 死 pid ⇒ 僵尸（不活跃）', () => {
  const id = 'T-20260101-010003-spawn-d';
  freshCard(id);

  t.sessionSet(id, { seg: 'seg1', owner: 'linus', phase: 'live', pid: process.pid, status: 'running' });
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(entriesOf(id).length, 1, '存活段应已登记');
  assert.equal(activeSessions(id).length, 1, '存活 pid 应判为活跃');

  // 同卡另一段：死 pid ⇒ 僵尸
  t.sessionSet(id, { seg: 'seg2', owner: 'linus', phase: 'dead', pid: DEAD_PID, status: 'running' });
  const act = activeSessions(id);
  assert.equal(entriesOf(id).length, 2, '两段各一条 registry 条目');
  assert.equal(act.length, 1, `死 pid 段不应计入活跃，实际 ${act.length}`);
  assert.equal(act[0].phase, 'live');
});

test('5. sessionClose ⇒ registry 终态同步（status/endedAt）且不再计为活跃', () => {
  const id = 'T-20260101-010004-spawn-e';
  freshCard(id);

  const s = t.sessionSet(id, { seg: 'seg1', owner: 'linus', phase: 'p', pid: process.pid, status: 'running' });
  assert.equal(activeSessions(id).length, 1);

  const c = t.sessionClose(id, 'seg1', 'closed');
  assert.equal(c.ok, true);
  assert.equal(c.registry.ok, true, `registry 终态应同步，实际 ${JSON.stringify(c.registry)}`);

  const e = entriesOf(id).find((x) => x.session_id === s.session_id);
  assert.equal(e.status, 'closed', 'registry.status 应同步为终态');
  assert.ok(e.endedAt, '终态应记 endedAt');
  assert.equal(activeSessions(id).length, 0, 'closed 不应再计入活跃');
});

// ---- 实际 worker spawn 调用路径（CLI 子进程） -------------------------------

test('6. 真实 CLI：task.mjs session-set ⇒ registry 有条目（父回合走的调用路径）', () => {
  const id = 'T-20260101-010005-spawn-cli';
  freshCard(id);

  const out = execFileSync(
    process.execPath,
    [TASK_CLI, 'session-set', id, 'seg=seg1', 'owner=linus', 'backend=claude', 'phase=cli', `pid=${process.pid}`, 'status=running'],
    { env: { ...process.env, OPENCLAW_TEAM_ROOT: ROOT }, encoding: 'utf8' }
  );
  const parsed = JSON.parse(out);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.registry.ok, true, 'CLI 路径应写 registry');
  const reg = entriesOf(id);
  assert.equal(reg.length, 1);
  assert.equal(reg[0].pid, process.pid);
  assert.equal(reg[0].session_id, parsed.session_id);
});

// ---- 端到端：spawn 登记即可阻止 poll 重领（防双跑） --------------------------

test('7. poll 防双跑守卫：sessionSet 登记的活跃子会话（心跳陈旧 45min）⇒ 该卡不重领', () => {
  // 清空临时看板，保证只有本测试一张卡（判定确定，不受前序测试影响）
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
  fs.rmSync(REGISTRY_PATH, { force: true });

  const id = 'T-20260101-010006-spawn-guard';
  const stale = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  writeCard(id, `priority: medium\nclaimed_by: linus\nclaimed_at: ${stale}\nheartbeat_at: ${stale}\n`);

  // 经 spawn 登记步骤写 registry（非手写 JSON）
  t.sessionSet(id, { seg: 'seg1', owner: 'linus', phase: 'p', pid: process.pid, status: 'running' });

  const r = pollEvaluate({ assignee: 'linus' });
  assert.equal(r.ok, true);
  assert.equal(r.fire, false, `有活跃子会话（心跳陈旧 45min）应不重领，实际 ${JSON.stringify(r)}`);
  assert.match(String(r.message || ''), /活跃子会话/, 'message 应说明守卫原因');
});
