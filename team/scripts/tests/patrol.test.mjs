#!/usr/bin/env node
/**
 * patrol.test.mjs — 框架侧 patrol 入口 scripts/patrol.mjs 回归测试
 *
 * 锁定的失败模式（T-20261010-090407 项1；来源 071808 补充复核 / Turing R41，verdict=(a)）：
 * 告警信封基于**生成时点**的 stale 快照，经迟到投递抵达消费方时卡已成 done/in_review ⇒ 收到的是
 * 已收口的陈旧告警，worker 被迫反复 live-verify。patrol.mjs 在**发出前**对候选做一次现态重核
 * （复用 patrol-scan.mjs 的 liveVerdict，口径同源），把已终结的候选移入 `dropped`。
 * providers.json 的 patrol 条目必须指向 patrol.mjs —— 直调 patrol-scan.mjs 会绕过这次重核。
 *
 * 风格：不做内部 mock。每个用例在临时目录物化一份**完整部署布局**
 * （scripts/**.mjs + automations/{dispatch.mjs,providers.json} + skills/task-ops 软链 + tasks/ +
 * workspace/），一切经**真实子进程**驱动、隔离 team root。
 * 注意：**不用 in-process import** —— provider 的 team-paths.mjs 按 URL 缓存（且软链会被 realpath
 * 归一），in-process 复用会把 TEAM_ROOT 钉死在首个布局上；子进程每次都是全新模块图，确定性隔离。
 * 无 provider 安装 ⇒ SKIP（不是失败）。
 *
 * Run: node --test team/scripts/tests/patrol.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const SCRIPTS = path.join(HERE, '..');                     // <repo>/team/scripts
const TEAM_DIR = path.join(SCRIPTS, '..');                 // <repo>/team
const AUTOMATIONS = path.join(TEAM_DIR, 'automations');

const MIN = 60 * 1000;
const ISO = (msAgo) => new Date(Date.now() - msAgo).toISOString();

/** 定位携带 ACL 库的 provider 安装（与 sched-vendored-poll.test.mjs 同口径）。 */
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

const scratchDirs = [];
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * 驱动脚本：在**独立子进程**（fresh module graph）里以在手快照调用 patrol.decide()。
 * argv: <snapshot.json> [recheckSpec]；recheckSpec 缺省=真重核 | 'throw'=抛错 | 其它=JSON 畸变信封。
 */
const DRIVER = `import fs from 'node:fs';
const [snapPath, spec] = process.argv.slice(2);
const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const patrol = await import(new URL('./scripts/patrol.mjs', import.meta.url).href);
const opts = { scan: () => ({ stale: snap }) };
if (spec !== undefined) {
  opts.recheck = spec === 'throw' ? () => { throw new Error('boom'); } : () => JSON.parse(spec);
}
process.stdout.write(JSON.stringify(patrol.decide(opts)) + '\\n');
`;

/** 物化一份部署布局：scripts/ + automations/ + skills/task-ops + tasks/ + workspace/ */
function mkLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-patrol-entry-'));
  scratchDirs.push(root);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'automations'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
  }
  for (const f of ['dispatch.mjs', 'providers.json']) {
    fs.copyFileSync(path.join(AUTOMATIONS, f), path.join(root, 'automations', f));
  }
  fs.symlinkSync(PROVIDER, path.join(root, 'skills', 'task-ops'), 'dir');
  fs.writeFileSync(path.join(root, '__decide-driver.mjs'), DRIVER, 'utf8');
  return root;
}

/**
 * 写一张合成卡。frontmatter 值一律 JSON 引号（与 lib.mjs 写出形态一致）；
 * body 默认含**空** `## Sessions` 段（模板形态 ⇒ 无开工证据）。
 */
function writeCard(root, id, fm = {}, bodyLines) {
  const merged = {
    id, status: 'in_progress', claimed_by: 'linus',
    claimed_at: ISO(50 * MIN), status_changed_at: ISO(50 * MIN), heartbeat_at: ISO(45 * MIN),
    ...fm,
  };
  const lines = ['---'];
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${JSON.stringify(String(v))}`);
  }
  lines.push('---', '');
  const body = bodyLines || ['## Background', 'x', '## Sessions', '## Report'];
  fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), lines.concat(body).join('\n') + '\n', 'utf8');
}

/** 跑一个 CLI 并取末行 JSON。隔离：TEAM_ROOT 由 OPENCLAW_TEAM_ROOT 决定（缺省读真实 ~/.openclaw/team）。 */
function runCli(argv, root) {
  const res = spawnSync(process.execPath, argv, {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
    encoding: 'utf8',
  });
  const lines = String(res.stdout || '').split('\n').filter((l) => l.trim() !== '');
  let json = null;
  try { json = JSON.parse(lines[lines.length - 1]); } catch { json = null; }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, lines, json };
}

/** patrol.mjs CLI */
const runPatrol = (root) => runCli([path.join(root, 'scripts', 'patrol.mjs')], root);
/** dispatch.mjs CLI（真实子进程 ⇒ 端到端覆盖 providers.json → patrol.mjs） */
const runDispatch = (root, job = 'patrol') => runCli([path.join(root, 'automations', 'dispatch.mjs'), job], root);

/**
 * 以「在手快照」驱动 patrol.decide()（模拟 071808 的迟到投递信封：快照生成时卡仍 in_progress，
 * 送达时卡已成 done/in_review）。子进程隔离 ⇒ 重核读到的是本布局的**现态**。
 */
function runDecide(root, snapshot, recheckSpec) {
  const snapPath = path.join(root, 'snapshot.json');
  fs.writeFileSync(snapPath, JSON.stringify(snapshot), 'utf8');
  const argv = [path.join(root, '__decide-driver.mjs'), snapPath];
  if (recheckSpec !== undefined) argv.push(recheckSpec);
  return runCli(argv, root);
}

// ── 1. 空扫描 → {"stale":[]}，exit 0（零成本空转，绝不唤醒） ────────────────────────
test('无候选卡 ⇒ stdout 恰一行 {"stale":[]} 且 exit 0', { skip: SKIP }, () => {
  const root = mkLayout();
  const r = runPatrol(root);
  assert.equal(r.status, 0, `应 exit 0，stderr=${r.stderr}`);
  assert.equal(r.lines.length, 1, `stdout 应恰一行 JSON，实际 ${r.lines.length} 行`);
  assert.deepEqual(r.json, { stale: [] });
});

test('无候选卡 ⇒ dispatch patrol 归一为 fire:false（不唤醒模型）', { skip: SKIP }, () => {
  const root = mkLayout();
  const r = runDispatch(root, 'patrol');
  assert.equal(r.status, 0, `dispatch 应 exit 0，stderr=${r.stderr}`);
  assert.equal(r.json.fire, false);
});

// ── 2. 现态仍 in_progress 且心跳陈旧 → 保留告警（fire:true，不误收缩） ───────────────
test('现态 in_progress + 心跳陈旧 ⇒ 保留告警（dropped 空）', { skip: SKIP }, () => {
  const root = mkLayout();
  const id = 'T-20260101-100001-livestale';
  writeCard(root, id);

  const r = runPatrol(root);
  assert.equal(r.status, 0, `应 exit 0，stderr=${r.stderr}`);
  assert.equal(r.lines.length, 1, 'stdout 应恰一行 JSON');
  assert.equal(r.json.stale.length, 1, '真·陈旧卡应保留');
  assert.equal(r.json.stale[0].id, id);
  assert.equal(r.json.stale[0].ageMin, 45);
  assert.equal(r.json.stale[0].stale_kind, 'unstarted');
  assert.deepEqual(r.json.dropped, []);

  const d = runDispatch(root, 'patrol');
  assert.equal(d.json.fire, true, 'dispatch 应 fire:true');
  assert.ok(String(d.json.message || '').includes(id), 'message 应含告警卡 id');
});

// ── 3. 回归主线：快照陈旧但现态已终结 ⇒ dropped，不 fire ─────────────────────────
test('回归：在手快照命中但现态已 done ⇒ dropped（不 fire）', { skip: SKIP }, () => {
  const root = mkLayout();
  const id = 'T-20260101-100002-livedone';
  // 现态：done（status_changed_at 晚于心跳快照）
  writeCard(root, id, { status: 'done', status_changed_at: ISO(11 * MIN), heartbeat_at: ISO(70 * MIN) });

  const snapshot = [{ id, claimed_by: 'linus', ageMin: 70 }]; // 陈旧的 in_progress 快照
  const out = runDecide(root, snapshot).json;

  assert.deepEqual(out.stale, [], '现态已 done ⇒ 不得告警');
  assert.equal(out.dropped.length, 1, '应恰好剔除 1 条（审计可见，绝不静默丢）');
  assert.equal(out.dropped[0].id, id);
  assert.equal(out.dropped[0].dropped_reason, 'live_status:done');
  assert.equal(out.recheck, undefined, '正常路径不应带 fail-safe 标记');
});

test('回归：在手快照命中但现态已 in_review ⇒ dropped', { skip: SKIP }, () => {
  const root = mkLayout();
  const id = 'T-20260101-100003-livereview';
  writeCard(root, id, { status: 'in_review', heartbeat_at: ISO(70 * MIN) });

  const out = runDecide(root, [{ id, claimed_by: 'linus', ageMin: 70 }]).json;
  assert.deepEqual(out.stale, []);
  assert.equal(out.dropped[0].dropped_reason, 'live_status:in_review');
});

test('混合：陈旧快照里 done 与 in_progress 并存 ⇒ 只 fire 存活者', { skip: SKIP }, () => {
  const root = mkLayout();
  const live = 'T-20260101-100004-live';
  const dead = 'T-20260101-100005-dead';
  writeCard(root, live);
  writeCard(root, dead, { status: 'done', heartbeat_at: ISO(70 * MIN) });

  const out = runDecide(root, [{ id: live, ageMin: 45 }, { id: dead, ageMin: 70 }]).json;
  assert.deepEqual(out.stale.map((s) => s.id), [live], '仅存活候选应保留');
  assert.deepEqual(out.dropped.map((d) => d.id), [dead]);
});

// ── 4. fail-safe：重核环节自身故障 ⇒ 保留原候选（宁可多报，不吞真警报） ─────────────
test('fail-safe：recheckStale 抛错 ⇒ 保留原候选 + 标记 recheck:"failed"', { skip: SKIP }, () => {
  const root = mkLayout();
  const id = 'T-20260101-100006-failsafe';
  writeCard(root, id);

  const snapshot = [{ id, claimed_by: 'linus', ageMin: 45 }];
  const out = runDecide(root, snapshot, 'throw').json;
  assert.deepEqual(out.stale, snapshot, '重核抛错 ⇒ 必须保留原候选（绝不静默收缩）');
  assert.deepEqual(out.dropped, []);
  assert.equal(out.recheck, 'failed', 'fail-safe 触发应可机检');
});

test('fail-safe：recheck 返回畸变信封 ⇒ 保留原候选（同 patrol-main.js O3 口径）', { skip: SKIP }, () => {
  const root = mkLayout();
  const id = 'T-20260101-100007-malformed';
  writeCard(root, id);

  const snapshot = [{ id, ageMin: 45 }];
  const malformed = [null, '[]', '{}', '{"stale":"nope"}', '{"stale":[null]}', '{"stale":[{"noId":true}]}',
    '{"stale":[{"id":"x"}]}', '{"stale":[],"dropped":"nope"}'];
  for (const bad of malformed) {
    const out = runDecide(root, snapshot, bad).json;
    assert.deepEqual(out.stale, snapshot, `畸变信封 ${bad} ⇒ 保留原候选`);
    assert.equal(out.recheck, 'failed', `畸变信封 ${bad} ⇒ 标记 failed`);
  }
});

test('fail-safe 反向：重核良构收缩 ⇒ 生效（这是真·静默信号，非畸变）', { skip: SKIP }, () => {
  const root = mkLayout();
  const id = 'T-20260101-100008-shrink';
  writeCard(root, id, { status: 'done', heartbeat_at: ISO(70 * MIN) });

  const out = runDecide(root, [{ id, ageMin: 70 }]).json; // 默认=真重核（读现态）
  assert.deepEqual(out.stale, [], '良构的收缩必须生效');
  assert.equal(out.dropped[0].dropped_reason, 'live_status:done');
  assert.equal(out.recheck, undefined);
});

// ── 5. 出口闸：providers.json 的 patrol 必须指向 patrol.mjs（防回归到直调扫描器） ────
test('providers.json patrol 条目指向 patrol.mjs（含发火前重核），非直调 patrol-scan.mjs', () => {
  const j = JSON.parse(fs.readFileSync(path.join(AUTOMATIONS, 'providers.json'), 'utf8'));
  const entry = j['meerkat-taskpanel'] && j['meerkat-taskpanel'].patrol;
  assert.equal(entry, 'node {team}/scripts/patrol.mjs',
    'patrol 条目必须走 patrol.mjs —— 直调 patrol-scan.mjs 会绕过发出前现态重核（071808 未生效的根因）');
  assert.ok(!/\{team\}\/scripts\/patrol-scan\.mjs/.test(String(entry)));
});

// ── 6. 端到端：dispatch.mjs patrol 的 fire 确实来自 patrol.mjs 的输出 ───────────────
test('端到端：全是已终结卡 ⇒ patrol 不报 stale、dispatch fire:false', { skip: SKIP }, () => {
  const root = mkLayout();
  writeCard(root, 'T-20260101-100009-done', { status: 'done', heartbeat_at: ISO(70 * MIN) });
  writeCard(root, 'T-20260101-100010-review', { status: 'in_review', heartbeat_at: ISO(70 * MIN) });

  const r = runPatrol(root);
  assert.equal(r.status, 0, `patrol 应 exit 0，stderr=${r.stderr}`);
  assert.deepEqual(r.json, { stale: [] }, '无候选 ⇒ 契约形状为裸 {"stale":[]}');

  const d = runDispatch(root, 'patrol');
  assert.equal(d.status, 0, `dispatch 应 exit 0，stderr=${d.stderr}`);
  assert.equal(d.json.fire, false, 'dispatch 的 fire 应取自 patrol.mjs 的 stale 数组');
  assert.equal(d.json.state.job, 'patrol');
  assert.equal(d.json.message, undefined, 'fire:false 不应带 message');
});

test('端到端：存活 + 已终结并存 ⇒ dispatch fire:true 且 message 只含存活者', { skip: SKIP }, () => {
  const root = mkLayout();
  const live = 'T-20260101-100011-live';
  const dead = 'T-20260101-100012-dead';
  writeCard(root, live);
  writeCard(root, dead, { status: 'done', heartbeat_at: ISO(70 * MIN) });

  const d = runDispatch(root, 'patrol');
  assert.equal(d.json.fire, true);
  assert.ok(String(d.json.message).includes(live), 'message 应含存活卡');
  assert.ok(!String(d.json.message).includes(dead), 'message 不得含已终结卡（这就是 071808 的误报面）');
});

// ── 7. 单行 JSON + 非零退出仅限真实故障 ─────────────────────────────────────────
test('CLI 契约：stdout 恰一行良构 JSON（可被 dispatch 归一）', { skip: SKIP }, () => {
  const root = mkLayout();
  writeCard(root, 'T-20260101-100013-oneline');
  const r = runPatrol(root);
  assert.equal(r.lines.length, 1, `stdout 应恰一行，实际 ${r.lines.length}`);
  assert.ok(r.json && Array.isArray(r.json.stale), '末行须为含 stale 数组的 JSON');
});

test('真实故障：tasks 路径不可读 ⇒ patrol 非零退出且输出可辨（绝不静默假绿）', { skip: SKIP }, () => {
  const root = mkLayout();
  // 把 tasks 换成**文件**：readdirSync 抛 ENOTDIR ⇒ decide() 抛 ⇒ 非零退出
  fs.rmSync(path.join(root, 'tasks'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'tasks'), 'not a dir\n', 'utf8');

  const r = runPatrol(root);
  assert.notEqual(r.status, 0, '扫描器不可用应非零退出');
  assert.equal(r.json.error, 'scan_failed', '输出信封应可机检故障原因');
  assert.deepEqual(r.json.stale, []);

  const d = runDispatch(root, 'patrol');
  assert.equal(d.status, 0, 'dispatch 自身仍 exit 0（degrade）');
  assert.equal(d.json.fire, false, '真实故障 ⇒ dispatch 降级为 fire:false，绝不唤醒模型');
});
