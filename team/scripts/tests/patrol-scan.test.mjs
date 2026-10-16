#!/usr/bin/env node
/**
 * patrol-scan.test.mjs — 巡检扫描器 patrol-scan.mjs 回归测试
 *
 * 背景：patrol-scan.mjs 旧实现手写 frontmatter 正则，把 lib.mjs 用双引号写出的
 * heartbeat_at 原样直喂 Date.parse ⇒ NaN ⇒ 当作无限陈旧 ⇒ 每张带引号心跳的 in_progress 卡
 * 被误报 stale（误触发 cron、误唤醒健康 worker）。本套件锁定修复。
 *
 * 全部合成卡写入 os.tmpdir() 临时目录，绝不触碰真实 tasks/。运行：node --test scripts/tests/
 *
 * provider 依赖：patrol-scan.mjs 静态依赖 ./lib.mjs；lib.mjs 启动即检测 provider ACL 库
 * skills/task-ops/lib/*（provider 拥有、有意不随仓，见 skills/PROVENANCE.md），缺失 ⇒ process.exit(1)。
 * 故对 `../patrol-scan.mjs` 的静态导入在缺 provider 时 import 期即硬红（整文件 fail，非单例失败）。
 * 缺 provider 时依赖它的用例整体 SKIP（与 archive.test.mjs / check-idem.test.mjs 同契约），而非硬红。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.join(HERE, '..', 'patrol-scan.mjs');

/** 定位携带 ACL 库的 provider 安装目录（与 archive.test.mjs / check-idem.test.mjs / sched-vendored-poll.test.mjs 同口径）。 */
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

// provider 依赖为**条件动态 import**：patrol-scan.mjs 静态依赖 ./lib.mjs，lib.mjs 启动即检测 provider
// ACL 库、缺失即 process.exit(1) —— 故对 patrol-scan.mjs 的静态导入在缺 provider 时 import 期即硬红
// （整文件 fail）。仅当 PROVIDER 存在时加载，缺则保持 undefined（对应用例全部 { skip: SKIP }，不会执行
// 到）。先设 env 再 import：patrol-scan.mjs / lib.mjs 经 OPENCLAW_TASK_OPS_DIR 解析 provider。顶层 await
// 合法（ESM）。
let scanStale;
let patrol;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  patrol = await import('../patrol-scan.mjs');
  scanStale = patrol.scanStale;
}

const MIN = 60 * 1000;
const STALE_MS = 30 * MIN;

const scratchDirs = [];
/** 建临时 team-root，内含 tasks/，返回 { root, tasks } */
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-patrol-'));
  scratchDirs.push(root);
  const tasks = path.join(root, 'tasks');
  fs.mkdirSync(tasks);
  return { root, tasks };
}
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

const iso = (msAgo, now) => new Date(now - msAgo).toISOString();
/** 写一张合成卡；heartbeat 为 undefined 时省略该行 */
function writeCard(tasks, name, { id, status = 'in_progress', claimed_by = 'linus', heartbeat, quote = true }) {
  const lines = ['---', `id: ${id}`, `status: ${status}`, `claimed_by: ${claimed_by}`];
  if (heartbeat !== undefined) {
    lines.push(`heartbeat_at: ${quote ? JSON.stringify(heartbeat) : heartbeat}`);
  }
  lines.push('---', '', 'body', '');
  fs.writeFileSync(path.join(tasks, `${name}.md`), lines.join('\n'), 'utf8');
}

const NOW = Date.parse('2026-10-08T16:00:00.000Z');

test('quoted heartbeat + fresh(<30min) in_progress → NOT stale', { skip: SKIP }, () => {
  const { tasks } = mkRoot();
  writeCard(tasks, 'T-20260101-000001-fresh', {
    id: 'T-20260101-000001-fresh',
    heartbeat: iso(5 * MIN, NOW), // 5 分钟前
  });
  const { stale } = scanStale({ tasksDir: tasks, now: NOW, staleMs: STALE_MS });
  assert.deepEqual(stale, [], '新鲜卡不应出现在 stale');
});

test('quoted heartbeat + old(>30min) in_progress → stale with numeric correct ageMin', { skip: SKIP }, () => {
  const { tasks } = mkRoot();
  writeCard(tasks, 'T-20260101-000002-old', {
    id: 'T-20260101-000002-old',
    heartbeat: iso(45 * MIN, NOW), // 45 分钟前
  });
  const { stale } = scanStale({ tasksDir: tasks, now: NOW, staleMs: STALE_MS });
  assert.equal(stale.length, 1, '应报 1 张陈旧卡');
  assert.equal(stale[0].id, 'T-20260101-000002-old');
  assert.equal(stale[0].claimed_by, 'linus');
  assert.equal(typeof stale[0].ageMin, 'number', 'ageMin 应为数字');
  assert.equal(stale[0].ageMin, 45, 'ageMin 应为正确的 45');
  assert.equal(stale[0].reason, undefined, '真·陈旧卡不应带 unparseable reason');
});

test('unparseable heartbeat → stale with ageMin:null and reason:"unparseable"', { skip: SKIP }, () => {
  const { tasks } = mkRoot();
  writeCard(tasks, 'T-20260101-000003-bad', { id: 'T-20260101-000003-bad', heartbeat: 'not-a-date' });
  writeCard(tasks, 'T-20260101-000004-empty', { id: 'T-20260101-000004-empty', heartbeat: '' });
  writeCard(tasks, 'T-20260101-000005-missing', { id: 'T-20260101-000005-missing' }); // 无 heartbeat 行
  const { stale } = scanStale({ tasksDir: tasks, now: NOW, staleMs: STALE_MS });
  assert.equal(stale.length, 3, '三种不可解析形态都应报出');
  for (const e of stale) {
    assert.equal(e.ageMin, null, `${e.id}: ageMin 应为 null`);
    assert.equal(e.reason, 'unparseable', `${e.id}: 应带 reason:"unparseable"`);
  }
});

test('non-in_progress statuses (done/ready) → never stale', { skip: SKIP }, () => {
  const { tasks } = mkRoot();
  writeCard(tasks, 'T-20260101-000006-done', { id: 'T-20260101-000006-done', status: 'done', heartbeat: iso(999 * MIN, NOW) });
  writeCard(tasks, 'T-20260101-000007-ready', { id: 'T-20260101-000007-ready', status: 'ready', heartbeat: iso(999 * MIN, NOW) });
  writeCard(tasks, 'T-20260101-000008-ready-bad', { id: 'T-20260101-000008-ready-bad', status: 'ready', heartbeat: 'garbage' });
  const { stale } = scanStale({ tasksDir: tasks, now: NOW, staleMs: STALE_MS });
  assert.deepEqual(stale, [], '非 in_progress 一律忽略，即使心跳陈旧/不可解析');
});

test('no frontmatter + non-.md file → ignored, no throw', { skip: SKIP }, () => {
  const { tasks } = mkRoot();
  fs.writeFileSync(path.join(tasks, 'T-20260101-000009-nofm.md'), 'plain markdown, no frontmatter\n', 'utf8');
  fs.writeFileSync(path.join(tasks, 'notes.txt'), 'not a card\n', 'utf8');
  fs.writeFileSync(path.join(tasks, 'README'), 'junk\n', 'utf8');
  let out;
  assert.doesNotThrow(() => {
    out = scanStale({ tasksDir: tasks, now: NOW, staleMs: STALE_MS });
  });
  assert.deepEqual(out.stale, [], '无 frontmatter / 非 .md 应被忽略');
});

test('regression: unquoted heartbeat behaves same as quoted', { skip: SKIP }, () => {
  const { tasks } = mkRoot();
  const fresh = iso(10 * MIN, NOW);
  const old = iso(90 * MIN, NOW);
  writeCard(tasks, 'T-20260101-000010-qfresh', { id: 'T-20260101-000010-qfresh', heartbeat: fresh, quote: true });
  writeCard(tasks, 'T-20260101-000011-ufresh', { id: 'T-20260101-000011-ufresh', heartbeat: fresh, quote: false });
  writeCard(tasks, 'T-20260101-000012-qold', { id: 'T-20260101-000012-qold', heartbeat: old, quote: true });
  writeCard(tasks, 'T-20260101-000013-uold', { id: 'T-20260101-000013-uold', heartbeat: old, quote: false });
  const { stale } = scanStale({ tasksDir: tasks, now: NOW, staleMs: STALE_MS });
  const ids = stale.map((s) => s.id).sort();
  assert.deepEqual(ids, ['T-20260101-000012-qold', 'T-20260101-000013-uold'], '带/不带引号的与新鲜度判定应一致');
  for (const s of stale) assert.equal(s.ageMin, 90, '两种写法 ageMin 都应正确');
});

test('missing tasksDir → empty stale, no throw', { skip: SKIP }, () => {
  const { root } = mkRoot();
  const out = scanStale({ tasksDir: path.join(root, 'nope'), now: NOW, staleMs: STALE_MS });
  assert.deepEqual(out.stale, []);
});

test('direct-run stdout is a single valid JSON line (OPENCLAW_TEAM_ROOT honored)', { skip: SKIP }, () => {
  const { root, tasks } = mkRoot();
  // 一张新鲜卡 + 一张陈旧卡：验证 CLI 输出形态 + 新鲜卡不被报出
  writeCard(tasks, 'T-20260101-000020-clifresh', { id: 'T-20260101-000020-clifresh', heartbeat: new Date(Date.now() - 5 * MIN).toISOString() });
  writeCard(tasks, 'T-20260101-000021-cliold', { id: 'T-20260101-000021-cliold', heartbeat: new Date(Date.now() - 45 * MIN).toISOString() });

  const res = spawnSync(process.execPath, [SCANNER], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `应 exit 0，stderr=${res.stderr}`);
  const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines.length, 1, `stdout 应恰好一行 JSON，实际 ${lines.length} 行`);
  const parsed = JSON.parse(lines[0]); // 必须是合法 JSON
  assert.ok(Array.isArray(parsed.stale), 'stale 应为数组');
  const ids = parsed.stale.map((s) => s.id);
  assert.deepEqual(ids, ['T-20260101-000021-cliold'], '只应报陈旧卡，新鲜卡不得出现');
});

// ═════════════════════════════════════════════════════════════════════════════
// 现态二次核对（T-20261010-061248）：告警前按卡**现态**核对，消除对已终结卡的陈旧告警
// 变更面：scripts/patrol-scan.mjs（新增 recheckStale + 现态门禁）
// ═════════════════════════════════════════════════════════════════════════════

const SESS_BODY = [
  '## Background', 'x', '## Acceptance', '- [ ] a', '## Progress', '## Comments',
  '## Sessions', '- seg:seg1 · owner:linus · backend:claude · id:00000000-0000-5000-8000-000000000001',
  '## Report',
];
const EMPTY_SESS_BODY = [
  '## Background', 'x', '## Acceptance', '- [ ] a', '## Progress', '## Comments',
  '## Sessions', '## Report',
];
/** 卡模板形态：空 `## Sessions` 段只含 HTML 注释（不算开工证据） */
const COMMENT_SESS_BODY = [
  '## Background', 'x', '## Progress', '## Comments',
  '## Sessions', '<!-- 子会话关联（每段一行） -->', '## Report',
];
/** 写一张完整合成卡（frontmatter 值一律 JSON 引号；可含 claimed_at/status_changed_at + 自定义正文） */
function writeFullCard(tasks, name, fm, bodyLines) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${JSON.stringify(String(v))}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(tasks, `${name}.md`), lines.concat(bodyLines || EMPTY_SESS_BODY).join('\n') + '\n', 'utf8');
}
const wsOf = (root) => path.join(root, 'workspace');

test('现态二次核对：快照陈旧但现态已 done ⇒ 改前误报、改后静默（红→绿）', { skip: SKIP }, () => {
  const { root, tasks } = mkRoot();
  const id = 'T-20260101-000030-livedone';
  // 现态：已 done（status_changed_at 晚于快照），心跳仍是很旧的快照值
  writeFullCard(tasks, id, {
    id, status: 'done', claimed_by: 'linus',
    claimed_at: iso(120 * MIN, NOW), status_changed_at: iso(11 * MIN, NOW), heartbeat_at: iso(70 * MIN, NOW),
  });

  // 「陈旧快照」= 旧告警路径（cron 消息正文）里逐字携带的那份 stale 数组
  const snapshot = [{ id, claimed_by: 'linus', ageMin: 70 }];
  const beforeMsg = '[定时巡检] 心跳陈旧 in_progress 卡：' + JSON.stringify(snapshot);
  assert.ok(beforeMsg.includes(id), '改前：快照被逐字报警 ⇒ 消息含该卡 id（即误报）');

  // 改后：告警前按现态二次核对 ⇒ 现态 done ⇒ 静默
  const r = patrol.recheckStale(snapshot, { tasksDir: tasks, workspaceDir: wsOf(root), now: NOW });
  assert.deepEqual(r.stale, [], '现态已 done ⇒ 不得告警（静默）');
  assert.equal(r.dropped.length, 1, '应恰好剔除 1 条');
  assert.equal(r.dropped[0].id, id);
  assert.equal(r.dropped[0].dropped_reason, 'live_status:done', '剔除原因应为现态 done');

  // 现态直扫同样静默
  assert.deepEqual(patrol.scanStale({ tasksDir: tasks, workspaceDir: wsOf(root), now: NOW }).stale, []);
});

test('现态二次核对：done/in_review/blocked 一律不告警', { skip: SKIP }, () => {
  const { root, tasks } = mkRoot();
  const snap = [];
  for (const st of ['done', 'in_review', 'blocked']) {
    const id = `T-20260101-000040-${st}`;
    writeFullCard(tasks, id, { id, status: st, claimed_by: 'linus', claimed_at: iso(90 * MIN, NOW), heartbeat_at: iso(90 * MIN, NOW) }, SESS_BODY);
    snap.push({ id, claimed_by: 'linus', ageMin: 90 });
  }
  const r = patrol.recheckStale(snap, { tasksDir: tasks, workspaceDir: wsOf(root), now: NOW });
  assert.deepEqual(r.stale, [], '终态卡（done/in_review/blocked）一律不告警');
  assert.deepEqual(
    r.dropped.map((d) => d.dropped_reason).sort(),
    ['live_status:blocked', 'live_status:done', 'live_status:in_review'],
  );
});

test('现态二次核对：现态仍 in_progress 且心跳确实陈旧 ⇒ 保留告警并携带现态证据', { skip: SKIP }, () => {
  const { root, tasks } = mkRoot();
  const id = 'T-20260101-000050-livestale';
  writeFullCard(tasks, id, {
    id, status: 'in_progress', claimed_by: 'linus',
    claimed_at: iso(50 * MIN, NOW), status_changed_at: iso(50 * MIN, NOW), heartbeat_at: iso(45 * MIN, NOW),
  }, EMPTY_SESS_BODY);
  const snap = [{ id, claimed_by: 'linus', ageMin: 45 }];
  const r = patrol.recheckStale(snap, { tasksDir: tasks, workspaceDir: wsOf(root), now: NOW });
  assert.equal(r.stale.length, 1, '现态仍 in_progress + 心跳陈旧 ⇒ 应保留告警');
  const e = r.stale[0];
  assert.equal(e.id, id);
  assert.equal(e.ageMin, 45);
  assert.equal(e.reason, undefined, '真·陈旧（非 unparseable）不应带 reason');
  assert.equal(e.status, 'in_progress', '应携带现态 status');
  assert.equal(e.has_sessions, false);
  assert.equal(e.has_workspace, false);
  assert.equal(e.stale_kind, 'unstarted', 'claim 后无 Sessions/workspace ⇒ 分类 unstarted（已领未开工）');
  assert.equal(e.status_changed_at, iso(50 * MIN, NOW), '应携带现态 status_changed_at');
  assert.deepEqual(r.dropped, []);
});

test('现态证据：`## Sessions` 有条目/workspace 存在 ⇒ has_* 为真（陈旧仍告警，不误抑制）', { skip: SKIP }, () => {
  const { root, tasks } = mkRoot();
  const id = 'T-20260101-000060-hassess';
  writeFullCard(tasks, id, {
    id, status: 'in_progress', claimed_by: 'linus',
    claimed_at: iso(60 * MIN, NOW), heartbeat_at: iso(45 * MIN, NOW),
  }, SESS_BODY);
  fs.mkdirSync(path.join(wsOf(root), id), { recursive: true }); // 已开工：workspace 存在
  const { stale } = patrol.scanStale({ tasksDir: tasks, workspaceDir: wsOf(root), now: NOW });
  assert.equal(stale.length, 1, '有心跳陈旧即应告警（现态证据不抑制真陈旧）');
  assert.equal(stale[0].has_sessions, true, '`## Sessions` 有条目 ⇒ has_sessions:true');
  assert.equal(stale[0].has_workspace, true, 'workspace 存在 ⇒ has_workspace:true');
  assert.equal(stale[0].stale_kind, 'heartbeat', '有开工证据的陈旧 ⇒ 分类 heartbeat');
});

test('现态证据：卡模板空 `## Sessions`（仅注释）不算开工 ⇒ has_sessions:false', { skip: SKIP }, () => {
  const { root, tasks } = mkRoot();
  const id = 'T-20260101-000061-commentonly';
  writeFullCard(tasks, id, { id, status: 'in_progress', claimed_by: 'linus', claimed_at: iso(60 * MIN, NOW), heartbeat_at: iso(45 * MIN, NOW) }, COMMENT_SESS_BODY);
  const { stale } = patrol.scanStale({ tasksDir: tasks, workspaceDir: wsOf(root), now: NOW });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].has_sessions, false, '空段仅含注释 ⇒ 不算开工证据');
  assert.equal(stale[0].stale_kind, 'unstarted');
});

test('claim→spawn 窗口（claim 后数分钟、尚无 Sessions/workspace）⇒ 不误报', { skip: SKIP }, () => {
  const { root, tasks } = mkRoot();
  // (a) claim 后 3min：心跳尚新，无 Sessions/workspace
  writeFullCard(tasks, 'T-20260101-000070-window', {
    id: 'T-20260101-000070-window', status: 'in_progress', claimed_by: 'linus',
    claimed_at: iso(3 * MIN, NOW), heartbeat_at: iso(3 * MIN, NOW),
  }, EMPTY_SESS_BODY);
  // (b) claim 后 2min：心跳尚未写出（缺失），claim 尚新
  writeFullCard(tasks, 'T-20260101-000071-nohb', {
    id: 'T-20260101-000071-nohb', status: 'in_progress', claimed_by: 'linus',
    claimed_at: iso(2 * MIN, NOW),
  }, EMPTY_SESS_BODY);
  const { stale } = patrol.scanStale({ tasksDir: tasks, workspaceDir: wsOf(root), now: NOW });
  assert.deepEqual(stale, [], 'claim→spawn 窗口内（含心跳未写出）不得告警');
});

test('fail-safe 不回归：心跳缺失/无法解析且 claim 已陈旧（或缺失）⇒ 仍告警 reason:unparseable', { skip: SKIP }, () => {
  const { root, tasks } = mkRoot();
  // 缺心跳 + claim 已 60min 陈旧
  writeFullCard(tasks, 'T-20260101-000080-nohb-old', { id: 'T-20260101-000080-nohb-old', status: 'in_progress', claimed_by: 'linus', claimed_at: iso(60 * MIN, NOW) });
  // 心跳无法解析 + 无 claimed_at
  writeFullCard(tasks, 'T-20260101-000081-bad', { id: 'T-20260101-000081-bad', status: 'in_progress', claimed_by: 'linus', heartbeat_at: 'not-a-date' });
  // 心跳为空串 + claim 已陈旧
  writeFullCard(tasks, 'T-20260101-000082-empty', { id: 'T-20260101-000082-empty', status: 'in_progress', claimed_by: 'linus', claimed_at: iso(60 * MIN, NOW), heartbeat_at: '' });
  const { stale } = patrol.scanStale({ tasksDir: tasks, workspaceDir: wsOf(root), now: NOW });
  assert.equal(stale.length, 3, '三种不可解析形态都应报出（fail-safe 不回归）');
  for (const e of stale) {
    assert.equal(e.ageMin, null, `${e.id}: ageMin 应为 null`);
    assert.equal(e.reason, 'unparseable', `${e.id}: 应带 reason:"unparseable"`);
  }
});

test('recheckStale：无 id 的快照条目 ⇒ 归入 dropped(missing_id)（绝不静默丢弃）', { skip: SKIP }, () => {
  const { root, tasks } = mkRoot();
  const r = patrol.recheckStale([{ claimed_by: 'linus', ageMin: 70 }, null], { tasksDir: tasks, workspaceDir: wsOf(root), now: NOW });
  assert.deepEqual(r.stale, [], '无 id 无法定位 ⇒ 不告警');
  assert.equal(r.dropped.length, 2, '两条无 id 条目都应出现在 dropped（审计可见）');
  assert.deepEqual(r.dropped.map((d) => d.dropped_reason), ['missing_id', 'missing_id']);
});

test('CLI --recheck：对快照按现态重核，done 卡静默（exit 0，单行 JSON）', { skip: SKIP }, () => {
  const { root, tasks } = mkRoot();
  const id = 'T-20260101-000090-clidone';
  writeFullCard(tasks, id, { id, status: 'done', claimed_by: 'linus', claimed_at: iso(90 * MIN, NOW), heartbeat_at: iso(90 * MIN, NOW) }, SESS_BODY);
  const snapPath = path.join(root, 'snapshot.json');
  fs.writeFileSync(snapPath, JSON.stringify([{ id, claimed_by: 'linus', ageMin: 90 }]), 'utf8');

  const res = spawnSync(process.execPath, [SCANNER, '--recheck', snapPath], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `应 exit 0，stderr=${res.stderr}`);
  const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines.length, 1, `stdout 应恰一行 JSON，实际 ${lines.length} 行`);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed.stale, [], '现态 done ⇒ --recheck 静默');
  assert.equal(parsed.dropped[0].dropped_reason, 'live_status:done');
});

test('CLI --recheck：快照文件不可读 ⇒ 非零退出（退出码可辨）', { skip: SKIP }, () => {
  const { root } = mkRoot();
  const res = spawnSync(process.execPath, [SCANNER, '--recheck', path.join(root, 'nope.json')], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
    encoding: 'utf8',
  });
  assert.notEqual(res.status, 0, '快照不可读应非零退出（绝不静默假绿）');
  const parsed = JSON.parse(res.stdout.split('\n').filter((l) => l.trim() !== '').pop());
  assert.equal(parsed.error, 'snapshot_unreadable');
});
