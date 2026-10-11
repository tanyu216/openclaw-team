#!/usr/bin/env node
/**
 * terminal-guard.test.mjs — 「终态不可逆」守卫的**仓内契约测试**（T-20261012-015421）
 *
 * 契约依据：`guides/task-interface.md` §6.3「Terminal state is irreversible (enforced at the write layer)」
 * 与 §4 `task.setStatus`：卡已是终态（`done`/`failed`/`canceled`）时，`DONE_ACTORS` 之外的**任何**写入
 * 一律被拒（`reason:terminal_immutable`，绝不写卡）。
 *
 * 事故背景：Elon 置卡 `done`（17:48:43Z）后，该卡会话的并发收口写入（report/progress/comment/
 * session-close + `status→in_review`，17:49:29Z）**晚于** done 到达，把终态覆写回 `in_review`。
 *
 * provider 口径（同 claim-guard.test.mjs / archive.test.mjs）：ACL 库有意不随仓 ⇒ 本地
 * `resolveProviderRoot()` 依次尝试 `OPENCLAW_TASK_OPS_DIR` → `~/.openclaw/team/skills/task-ops`
 * → `~/.openclaw/skills/task-ops`，命中后**条件动态 import**；无 provider ⇒ 本文件全部 SKIP。
 * 隔离：`OPENCLAW_TEAM_ROOT` 指向临时目录（import 前设置），不写 live 卡。
 * 运行：node --test team/scripts/tests/terminal-guard.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** 定位携带 ACL 库的 provider 安装目录（与 claim-guard.test.mjs 同口径）。 */
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

// 前置：先设 env，再动态 import（TEAM_ROOT 于模块加载期读取，import 顺序不可颠倒）
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-terminalguard-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
fs.mkdirSync(path.join(ROOT, 'tasks', '.locks'), { recursive: true });

let t = null;
let TASK_MJS = null;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  TASK_MJS = path.join(PROVIDER, 'lib', 'task.mjs');
  t = await import(pathToFileURL(TASK_MJS).href);
}

const BODY = '\n## Background\nx\n\n## Acceptance\n- [ ] a\n\n## Progress\n\n## Comments\n\n## Sessions\n\n## Report\n';
let seq = 0;
/** 写一张 status=<st> 的最小可解析卡，返回其 id */
function newCard(st = 'in_progress') {
  const id = `T-20260101-0000${String(seq++).padStart(2, '0')}-tg`;
  const keys = ['id', 'title', 'assignee', 'status', 'priority', 'project', 'claimed_by', 'notify_leader'];
  const vals = [id, 'terminal guard test', 'linus', st, 'medium', '__team__', 'linus', 'true'];
  const head = keys.map((k, i) => `${k}: ${vals[i]}`).join('\n');
  fs.writeFileSync(path.join(ROOT, 'tasks', `${id}.md`), `---\n${head}\nsubsession_ids: []\n---\n${BODY}`);
  return id;
}
const statusOf = (id) => t.read(id).fm.status;
const changedAtOf = (id) => t.read(id).fm.status_changed_at;
const bodyOf = (id) => t.read(id).body;
const fileOf = (id) => fs.readFileSync(path.join(ROOT, 'tasks', `${id}.md`), 'utf8');
/** 真实子进程跑 ACL CLI status；返回 { code, json } */
function runCli(args) {
  const r = spawnSync(process.execPath, [TASK_MJS, 'status', ...args], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: ROOT }, encoding: 'utf8',
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 非 JSON 输出 */ }
  return { code: r.status, json };
}

const REFUSED = (r) => r.ok === false && r.reason === 'terminal_immutable';

test('常量：终态集合含 done/failed/canceled，不含任何非终态', () => {
  assert.ok(t.TERMINAL_STATUSES instanceof Set);
  for (const s of ['done', 'failed', 'canceled']) assert.ok(t.TERMINAL_STATUSES.has(s), `应含 ${s}`);
  for (const s of ['in_review', 'in_progress', 'blocked', 'ready', 'todo', 'backlog']) {
    assert.ok(!t.TERMINAL_STATUSES.has(s), `不应含 ${s}`);
  }
});

test('红：done 卡被 worker 覆写为 in_review ⇒ 拒绝且零副作用（事故原样复现点）', () => {
  const c = newCard('done');
  const before = changedAtOf(c);
  const r = t.setStatus(c, 'in_review', { actor: 'linus' });
  assert.ok(REFUSED(r), 'worker 覆写终态应被拒');
  assert.equal(r.from, 'done');
  assert.equal(r.to, 'in_review');
  assert.equal(r.actor, 'linus');
  assert.match(String(r.hint), /elon/i, 'hint 应指向 Elon 显式重开');
  assert.equal(statusOf(c), 'done', '卡 status 未被写');
  assert.equal(changedAtOf(c), before, 'status_changed_at 未被写');
  assert.ok(!fileOf(c).includes('status: in_review'), '卡文件内不得出现新状态');
});

test('红：真实 CLI —— done 卡 status in_review actor=linus ⇒ 非零退出 + 卡未变', () => {
  const c = newCard('done');
  const r = runCli([c, 'in_review', 'actor=linus']);
  assert.notEqual(r.code, 0);
  assert.ok(r.json && r.json.ok === false && r.json.reason === 'terminal_immutable');
  assert.equal(statusOf(c), 'done');
});

test('红：failed 卡同样冻结（→in_progress / →in_review / →ready 均拒）', () => {
  for (const to of ['in_progress', 'in_review', 'ready']) {
    const c = newCard('failed');
    assert.ok(REFUSED(t.setStatus(c, to, { actor: 'turing' })), `failed →${to} 应被拒`);
    assert.equal(statusOf(c), 'failed');
  }
});

test('红：终态改写终态（done → failed）亦被拒', () => {
  const c = newCard('done');
  assert.ok(REFUSED(t.setStatus(c, 'failed', { actor: 'linus' })));
  assert.equal(statusOf(c), 'done');
});

test('红：终态同值重写亦拒（保护 status_changed_at 审计时间戳）', () => {
  const c = newCard('failed');
  const before = changedAtOf(c);
  assert.ok(REFUSED(t.setStatus(c, 'failed', { actor: 'linus' })));
  assert.equal(changedAtOf(c), before, '审计时间戳不得被刷新');
});

test('绿：Elon 显式重开 ⇒ 成功 + kind=change 留痕', () => {
  const c = newCard('done');
  const r = t.setStatus(c, 'in_review', { actor: 'elon' });
  assert.equal(r.ok, true);
  assert.equal(statusOf(c), 'in_review');
  assert.equal(r.reopened_from, 'done');
  assert.match(bodyOf(c), /· change · elon — 终态重开：done → in_review/, '重开须留 kind=change 痕迹');
});

test('绿：特权管理路径（未传 actor 键 ⇒ 哨兵 lib）重开同样可用并留痕', () => {
  const c = newCard('failed');
  const r = t.setStatus(c, 'in_review');
  assert.equal(r.ok, true);
  assert.equal(statusOf(c), 'in_review');
  assert.match(bodyOf(c), /· change · lib — 终态重开：failed → in_review/);
});

test('绿：真实 CLI —— Elon 重开退出 0；Elon 同值重申不算重开、不留痕', () => {
  const c = newCard('done');
  const cli = runCli([c, 'in_review', 'actor=elon']);
  assert.equal(cli.code, 0);
  assert.ok(cli.json && cli.json.ok === true);
  assert.equal(statusOf(c), 'in_review');

  const c2 = newCard('done');
  const r = t.setStatus(c2, 'done', { actor: 'elon' });
  assert.equal(r.ok, true);
  assert.equal(r.reopened_from, undefined);
  assert.ok(!bodyOf(c2).includes('change'), '同值重申不得留 change 痕迹');
});

test('回归：非终态路径行为完全不变（ready→in_progress→in_review→blocked）', () => {
  const c = newCard('ready');
  assert.equal(t.setStatus(c, 'in_progress', { actor: 'linus' }).ok, true);
  assert.equal(t.setStatus(c, 'in_review', { actor: 'linus' }).ok, true);
  assert.equal(statusOf(c), 'in_review');
  assert.equal(t.setStatus(c, 'blocked', { actor: 'linus' }).ok, true);
  assert.ok(t.read(c).fm.blocked_at, '进 blocked 应记 blocked_at');
  assert.equal(t.setStatus(c, 'in_progress', { actor: 'linus' }).ok, true);
  assert.equal(runCli([c, 'in_review', 'actor=linus']).code, 0);
});

test('回归：done-actor 门不受影响（两道门各司其职，拒因不混淆）', () => {
  const c = newCard('in_progress');
  const r = t.setStatus(c, 'done', { actor: 'linus' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'done_requires_elon', '非终态卡置 done ⇒ 仍是 done-actor 门');
  assert.equal(statusOf(c), 'in_progress');
  const cli = runCli([c, 'done']);
  assert.notEqual(cli.code, 0);
  assert.equal(cli.json.reason, 'done_requires_elon');
  assert.equal(t.setStatus(c, 'done', { actor: 'elon' }).ok, true);

  const c2 = newCard('in_progress');
  assert.equal(t.setStatus(c2, 'done').ok, true, 'privileged lib 置 done 零回归');
  assert.ok(t.DONE_ACTORS.has('elon') && t.DONE_ACTORS.has('lib') && !t.DONE_ACTORS.has('linus'));
});

after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 已清理则忽略 */ } });
