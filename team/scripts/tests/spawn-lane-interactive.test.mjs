#!/usr/bin/env node
/**
 * spawn-lane-interactive.test.mjs — `--interactive` 的入口级集成测试。
 *
 * 与 `spawn-lane.test.mjs` 同一套“临时部署布局 + provider ACL 符号链接”模式：
 *   · 交互 spawn：登记 pid = lane-host（不是后端），等 host.ready，sidecar/prompt/control 落盘；
 *   · 非交互：argv 仍直接指向后端、不产生任何交互文件；
 *   · 拒绝面：plugin harness、非法策略、host ready 超时。
 * 无 provider ⇒ 全部 SKIP（不误报红）。
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPTS = path.resolve(import.meta.dirname, '..');

function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    path.resolve(import.meta.dirname, '..', '..', 'skills', 'task-ops'),
  ].filter(Boolean);
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, 'lib', 'team-paths.mjs'))) return root;
  }
  return null;
}
const PROVIDER = resolveProviderRoot();
const SKIP = PROVIDER ? false : 'provider ACL library not installed; set OPENCLAW_TASK_OPS_DIR to run';

const LAYOUT = PROVIDER ? (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-spawnlane-int-'));
  for (const d of ['scripts', 'tasks', 'tasks/.locks', 'workspace', 'skills', 'bin']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs') || f.endsWith('.json')) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
  }
  fs.symlinkSync(PROVIDER, path.join(root, 'skills', 'task-ops'), 'dir');
  return root;
})() : null;

let TASKS, WS, BIN, REG, CL_PLAIN, CL_INTERACTIVE, CL_NOINIT;
let spawnLane, parseArgs, interactiveDeclared, buildPrompt;

if (LAYOUT) {
  TASKS = path.join(LAYOUT, 'tasks');
  WS = path.join(LAYOUT, 'workspace');
  BIN = path.join(LAYOUT, 'bin');
  REG = path.join(LAYOUT, 'claude-sessions.json');
  process.env.OPENCLAW_TEAM_ROOT = LAYOUT;
  process.env.OPENCLAW_LANE_SKIP_PREFLIGHT = '1';
  process.env.OPENCLAW_TEAM_REAPER = '0';
  ({ spawnLane, parseArgs, interactiveDeclared, buildPrompt } = await import(
    pathToFileURL(path.join(LAYOUT, 'scripts', 'spawn-lane.mjs')).href
  ));

  const writeBin = (name, body) => {
    const p = path.join(BIN, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
    return p;
  };
  // 非交互：只回 init 并保持存活（复刻现有套件的 stub）
  CL_PLAIN = writeBin('claude-plain', '#!/bin/sh\necho \'{"type":"system","subtype":"init"}\'\nsleep 60\n');
  // 交互：完整 stream-json 控制通道
  CL_INTERACTIVE = writeBin('claude-interactive', `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init' });
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (;;) {
    const i = buf.indexOf('\\n'); if (i < 0) break;
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'user') out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git status' }, tool_use_id: 'c1' } });
    if (m.type === 'control_response') out({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
  }
});
process.stdin.on('end', () => process.exit(0));
`);
  // 握手超时：不写 init、保持存活
  CL_NOINIT = writeBin('claude-noinit', '#!/bin/sh\nsleep 60\n');
}

after(() => {
  if (LAYOUT) fs.rmSync(LAYOUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(() => {
  if (!LAYOUT) return;
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
  // 上一条真实 lane 可能还在关闭 fd；给 rm 一个重试窗口，避免把清理竞态读成测试失败。
  fs.rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fs.mkdirSync(WS, { recursive: true });
  fs.rmSync(REG, { force: true });
});

function writeCard(id) {
  const body = '## Background\nx\n## Acceptance\n- [ ] a\n## Progress\n## Comments\n## Sessions\n\n## Report\n';
  fs.writeFileSync(
    path.join(TASKS, `${id}.md`),
    `---\nid: ${id}\ntitle: interactive test\nassignee: linus\nstatus: in_progress\n` +
    `goal: g\nproject: __team__\ntarget: \nclaimed_by: linus\nheartbeat_at: 2026-01-01T00:00:00.000Z\n---\n${body}`,
  );
}
const cardRaw = (id) => fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8');
const registryEntries = (id) => (fs.existsSync(REG) ? JSON.parse(fs.readFileSync(REG, 'utf8')).filter((e) => e.task_id === id) : []);
const waitFor = async (fn, { timeout = 8000, step = 25 } = {}) => {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, step));
  }
};
const withEnv = async (patch, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(patch)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

test('parseArgs：--interactive 与 interactive=1', { skip: SKIP }, () => {
  assert.equal(parseArgs(['c', 'linus', '--interactive']).interactive, '1');
  assert.equal(parseArgs(['c', 'linus', 'interactive=1']).interactive, '1');
  assert.equal(parseArgs(['c', 'linus']).interactive, '');
  assert.equal(interactiveDeclared('yes'), true);
  assert.equal(interactiveDeclared('0'), false);
});

test('buildPrompt：交互 lane 要求结构化提问、禁止 shell 重定向；非交互不变', { skip: SKIP }, () => {
  const base = { handoffPath: 'h', cardPath: 'c', reportPath: 'r.md', branch: 'b', branchSource: 'nogit' };
  const on = buildPrompt({ ...base, interactive: true });
  assert.match(on, /structured question tool/);
  assert.match(on, /do not use shell redirection/);
  assert.match(on.trim().split('\n').pop(), /r\.md/);
  const off = buildPrompt(base);
  assert.doesNotMatch(off, /structured question tool/);
});

test('应急总闸：OPENCLAW_TEAM_LANE_INTERACTIVE=0 ⇒ 明确拒绝', { skip: SKIP }, async () => {
  const id = 'T-20260101-200009';
  writeCard(id);
  await withEnv({ OPENCLAW_TEAM_LANE_INTERACTIVE: '0' }, async () => {
    const r = spawnLane({ card: id, owner: 'linus', interactive: '1', dryRun: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /interactive_disabled_by_env/);
  });
});

test('dry-run：交互计划字段齐全，零写入', { skip: SKIP }, () => {
  const id = 'T-20260101-200001';
  writeCard(id);
  const r = spawnLane({ card: id, owner: 'linus', interactive: '1', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.interactive, true);
  assert.equal(r.harness, 'cli');
  assert.ok(r.cmd[1].endsWith('lane-host.mjs'), r.cmd.join(' '));
  assert.equal(r.backend_cmd[0], process.env.OPENCLAW_CLAUDE_BIN || 'claude');
  assert.ok(r.control_log.endsWith('.control.jsonl'));
  assert.ok(r.state_file.endsWith('.host.json'));
  assert.ok(r.prompt_file.endsWith('.prompt.txt'));
  assert.equal(r.policy.source, 'default');
  assert.match(r.policy.digest, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(r.prompt_file), false);
  assert.equal(fs.existsSync(r.control_log), false);
  assert.equal(fs.existsSync(r.state_file), false);
  assert.equal(cardRaw(id).includes('seg:seg1'), false);
});

test('dry-run：非交互计划不含交互字段，cmd 直接指向后端', { skip: SKIP }, () => {
  const id = 'T-20260101-200002';
  writeCard(id);
  const r = spawnLane({ card: id, owner: 'linus', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal('interactive' in r, false);
  assert.equal(r.cmd[1], '-p');
  assert.ok(!r.cmd.some((a) => String(a).endsWith('lane-host.mjs')));
  assert.equal(r.backend_cmd, undefined);
  assert.equal(r.control_log, undefined);
});

test('真实交互 spawn：登记 host pid、等 ready、sidecar/prompt/control 落盘', { skip: SKIP }, async () => {
  const id = 'T-20260101-200003';
  writeCard(id);
  await withEnv({
    OPENCLAW_CLAUDE_BIN: CL_INTERACTIVE,
    OPENCLAW_LANE_POST_RESULT_WAIT_MS: '100',
    OPENCLAW_LANE_STOP_GRACE_MS: '100',
  }, async () => {
    const r = spawnLane({ card: id, owner: 'linus', interactive: '1' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(Number.isInteger(r.pid) && r.pid > 0);
    assert.equal(r.interactive, true);
    assert.ok(r.cmd[1].endsWith('lane-host.mjs'));
    const out = path.join(WS, id, 'linus-1.out.jsonl');
    assert.equal(await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('"event":"ready"')), true);
    assert.equal(await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('"event":"done"')), true);
    const state = JSON.parse(fs.readFileSync(r.state_file, 'utf8'));
    assert.equal(state.state, 'done');
    assert.equal(state.host_pid, r.pid);
    assert.ok(state.backend_pid > 0);
    assert.match(cardRaw(id), new RegExp(`pid:${r.pid}`));
    assert.ok(registryEntries(id).some((e) => e.pid === r.pid && e.session_id === r.session_id));
    assert.equal(fs.existsSync(r.prompt_file), true);
    assert.equal(fs.existsSync(r.control_log), true);
    assert.equal(fs.statSync(r.prompt_file).mode & 0o777, 0o600);
  });
});

test('plugin harness + interactive ⇒ 拒绝', { skip: SKIP }, async () => {
  const id = 'T-20260101-200004';
  writeCard(id);
  const r = spawnLane({ card: id, owner: 'linus', backend: 'codex', harness: 'plugin', interactive: '1', dryRun: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /interactive_unsupported_harness\(plugin\)/);
});

test('review lane + interactive ⇒ 拒绝（只读保证不成立）', { skip: SKIP }, async () => {
  const id = 'T-20260101-200008';
  writeCard(id);
  fs.writeFileSync(path.join(TASKS, `${id}.md`), fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8').replace('status: in_progress', 'status: in_review'));
  const r = spawnLane({ card: id, owner: 'turing', role: 'review', interactive: '1', dryRun: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /review_interactive_unsupported/);
});

test('非法策略 ⇒ policy_load_failed，零副作用', { skip: SKIP }, async () => {
  const id = 'T-20260101-200005';
  writeCard(id);
  const bad = path.join(LAYOUT, 'bad-policy.json');
  fs.writeFileSync(bad, '{"version":1,"default":"allow","rules":[]}');
  await withEnv({ OPENCLAW_LANE_POLICY: bad }, async () => {
    const r = spawnLane({ card: id, owner: 'linus', interactive: '1', dryRun: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /policy_load_failed/);
    assert.equal(cardRaw(id).includes('seg:seg1'), false);
  });
});

test('host ready 超时 ⇒ 关会话为 failed 并拒绝', { skip: SKIP }, async () => {
  const id = 'T-20260101-200006';
  writeCard(id);
  await withEnv({ OPENCLAW_CLAUDE_BIN: CL_NOINIT }, async () => {
    const r = spawnLane({ card: id, owner: 'linus', interactive: '1', readyTimeoutMs: 300 });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /host_ready_timeout/);
    assert.match(cardRaw(id), /status:failed/);
    assert.ok(registryEntries(id).some((e) => e.status === 'failed'));
  });
});

test('非交互真实 spawn 不产生任何交互文件', { skip: SKIP }, async () => {
  const id = 'T-20260101-200007';
  writeCard(id);
  await withEnv({ OPENCLAW_CLAUDE_BIN: CL_PLAIN }, async () => {
    const r = spawnLane({ card: id, owner: 'linus' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal('interactive' in r, false);
    const dir = path.join(WS, id);
    assert.equal(fs.existsSync(path.join(dir, 'linus-1.prompt.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, 'linus-1.control.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, 'linus-1.host.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '.claude', 'settings.json')), true);
    try { process.kill(-r.pid, 'SIGTERM'); } catch { try { process.kill(r.pid, 'SIGTERM'); } catch { /* 已退出 */ } }
    await new Promise((res) => setTimeout(res, 100));
  });
});
