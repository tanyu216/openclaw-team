#!/usr/bin/env node
/**
 * check-card.test.mjs — priority 枚举校验（T-20261009-035200-teambackfill-depfix）
 *
 * 口径：priority 统一 low|medium|high|urgent（旧 p0–p3 弃用）。缺省/空不报错
 *   （REQUIRED 不含 priority，避免误伤）；非法值报错且 CLI 退出码 1。
 * 既直接调 checkOne（获得行/分支覆盖），又 spawn 子进程验证退出码。
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

// provider 依赖为**条件动态 import**：缺 provider 时 check-card.mjs/lib.mjs 在 import 期即硬红。
let checkOne, PRIORITY;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ checkOne, PRIORITY } = await import('../check-card.mjs'));
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cc-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const CHECK_CARD = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'check-card.mjs');
let seq = 0;
/** 造一张合法卡（仅 priority 行可变）；priorityLine 传 null ⇒ 不含 priority 字段 */
function mkCard(priorityLine) {
  const id = `T-20260101-3000${String(seq++).padStart(2, '0')}-cc`;
  const lines = ['---', `id: ${id}`, 'title: t', 'assignee: linus', 'status: ready', 'goal: g', 'project: __team__'];
  if (priorityLine) lines.push(priorityLine);
  lines.push('---', '## Report', '');
  const p = path.join(TMP, `${id}.md`);
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return p;
}
const runCli = (cardPath) => spawnSync(process.execPath, [CHECK_CARD, cardPath], { encoding: 'utf8' });

/** 造一个隔离的 OPENCLAW_TEAM_ROOT（含 tasks/），返回 { root, dir } */
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cc-root-'));
  const dir = path.join(root, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}
function writeRaw(dir, id, body) {
  fs.writeFileSync(path.join(dir, `${id}.md`), body, 'utf8');
}

test('PRIORITY 枚举 = low|medium|high|urgent', () => {
  assert.deepEqual(PRIORITY, ['low', 'medium', 'high', 'urgent']);
});

test('合法 priority（low/medium/high/urgent）通过', () => {
  for (const p of PRIORITY) assert.deepEqual(checkOne(mkCard(`priority: ${p}`)), [], `${p} 应通过`);
});

test('缺省 priority 不报错（REQUIRED 不含 priority，避免误伤）', () => {
  assert.deepEqual(checkOne(mkCard(null)), []);
});

test('非法 priority（p2/urgentt）报错', () => {
  assert.deepEqual(checkOne(mkCard('priority: p2')), ['非法 priority: p2']);
  assert.deepEqual(checkOne(mkCard('priority: urgentt')), ['非法 priority: urgentt']);
});

test('CLI 子进程：合法 ⇒ 退出码 0', () => {
  const r = runCli(mkCard('priority: high'));
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
});

test('CLI 子进程：非法 ⇒ 退出码 1 且输出含「非法 priority: p2」', () => {
  const r = runCli(mkCard('priority: p2'));
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /非法 priority: p2/);
});

test('CLI 扫描全部模式：合法卡通过（退出码 0）+ 裸 id 参数（补 .md）', () => {
  const { root, dir } = mkRoot();
  const id = 'T-20260101-300090-scan';
  writeRaw(dir, id, `---\nid: ${id}\ntitle: t\nassignee: linus\nstatus: ready\npriority: urgent\ngoal: g\nproject: __team__\n---\n## Report\n`);
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: root };
  const all = spawnSync(process.execPath, [CHECK_CARD], { env, encoding: 'utf8' });
  assert.equal(all.status, 0, `stdout=${all.stdout}`);
  assert.match(all.stdout, /卡校验通过/);
  const byId = spawnSync(process.execPath, [CHECK_CARD, id], { env, encoding: 'utf8' }); // 不含 .md ⇒ 走 id 分支
  assert.equal(byId.status, 0, `stdout=${byId.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('既有校验分支：缺必填/非法 status/非法 assignee/in_progress 缺 claimed_by', () => {
  const { root, dir } = mkRoot();
  const mk = (id, fm) => writeRaw(dir, id, `---\n${fm}\n---\n## Report\n`);
  mk('T-20260101-300091-a', 'id: T-20260101-300091-a\ntitle: t\nassignee: linus\nstatus: ready\nproject: __team__'); // 缺 goal
  mk('T-20260101-300092-b', 'id: T-20260101-300092-b\ntitle: t\nassignee: linus\nstatus: weird\ngoal: g\nproject: __team__');
  mk('T-20260101-300093-c', 'id: T-20260101-300093-c\ntitle: t\nassignee: nobody\nstatus: ready\ngoal: g\nproject: __team__');
  mk('T-20260101-300094-d', 'id: T-20260101-300094-d\ntitle: t\nassignee: linus\nstatus: in_progress\ngoal: g\nproject: __team__');
  mk('T-20260101-300095-e', 'id: T-20260101-300095-e\ntitle: t\ngoal: g'); // status/assignee/project 全缺 ⇒ 覆盖 && 假分支
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: root };
  const r = spawnSync(process.execPath, [CHECK_CARD], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /缺必填字段 goal/);
  assert.match(r.stdout, /非法 status: weird/);
  assert.match(r.stdout, /非法 assignee: nobody/);
  assert.match(r.stdout, /in_progress 但缺 claimed_by/);
  assert.match(r.stdout, /缺必填字段 assignee/);
  assert.match(r.stdout, /缺必填字段 status/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('CLI 扫描全部模式：tasks 目录不存在 ⇒ 0 张通过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cc-empty-'));
  const r = spawnSync(process.execPath, [CHECK_CARD], { env: { ...process.env, OPENCLAW_TEAM_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 0, `stdout=${r.stdout}`);
  assert.match(r.stdout, /0 张/);
  fs.rmSync(root, { recursive: true, force: true });
});
