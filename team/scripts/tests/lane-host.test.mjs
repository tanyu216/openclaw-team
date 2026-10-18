#!/usr/bin/env node
/**
 * lane-host.test.mjs — 交互宿主的两条原生控制通道（不需要 provider）。
 *
 * 假后端用 Node 编写（能直接读写 NDJSON/JSON-RPC），覆盖：
 *   · Claude：init → user → can_use_tool allow/deny/escalate → AskUserQuestion → result；
 *   · Codex：initialize/thread.start/turn.start → requestApproval / requestUserInput → turn.completed；
 *   · 失败面：握手超时、策略加载失败、坏行、未知控制 subtype。
 * 升级路径把 `OPENCLAW_TASK_OPS_DIR` 指向不存在的目录 ⇒ 只验产物 + 停止，不碰真卡。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.join(HERE, '..', 'lane-host.mjs');
const POLICY = path.join(HERE, '..', 'lane-policy.default.json');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-host-test-'));

const FAKE_CLAUDE = path.join(ROOT, 'fake-claude');
const FAKE_CODEX = path.join(ROOT, 'fake-codex');

fs.writeFileSync(FAKE_CLAUDE, `#!/usr/bin/env node
import fs from 'node:fs';
const t = process.env.FAKE_TRANSCRIPT;
const log = (o) => fs.appendFileSync(t, JSON.stringify(o) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const mode = process.env.FAKE_MODE || 'allow';
log({ argv: process.argv.slice(2) });
if (mode === 'badline') process.stdout.write('not json\\n');
if (mode !== 'noinit') out({ type: 'system', subtype: 'init' });
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (;;) {
    const i = buf.indexOf('\\n');
    if (i < 0) break;
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    log({ stdin: m });
    if (m.type === 'user') {
      if (mode === 'question') out({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', requires_user_interaction: true, input: { questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres', description: 'pg' }] }] }, tool_use_id: 'call-q' } });
      else if (mode === 'unknown') out({ type: 'control_request', request_id: 'u1', request: { subtype: 'nope' } });
      else out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: process.env.FAKE_COMMAND || 'git status' }, tool_use_id: 'call-1' } });
    }
    if (m.type === 'control_response') {
      log({ response: m.response });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`);
fs.chmodSync(FAKE_CLAUDE, 0o755);

fs.writeFileSync(FAKE_CODEX, `#!/usr/bin/env node
import fs from 'node:fs';
const t = process.env.FAKE_TRANSCRIPT;
const log = (o) => fs.appendFileSync(t, JSON.stringify(o) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const mode = process.env.FAKE_MODE || 'allow';
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (;;) {
    const i = buf.indexOf('\\n');
    if (i < 0) break;
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    log({ in: m });
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { userAgent: 'fake' } });
    else if (m.method === 'thread/start') out({ jsonrpc: '2.0', id: m.id, result: { thread: { id: 'th_test' } } });
    else if (m.method === 'turn/start') {
      out({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'turn_test' } } });
      out({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'th_test', turn: { id: 'turn_test', status: 'inProgress' } } });
      if (mode === 'badline') out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th_test', turn: { id: 'turn_test', status: 'completed' } } });
      else if (mode === 'question') out({ jsonrpc: '2.0', id: 'srv-q', method: 'item/tool/requestUserInput', params: { threadId: 'th_test', turnId: 'turn_test', itemId: 'i1', isBlocking: true, questions: [{ id: 'q1', header: 'DB', question: 'Which DB?', options: [{ label: 'Postgres', description: 'pg' }] }] } });
      else if (mode === 'unknown') out({ jsonrpc: '2.0', id: 'srv-u', method: 'item/tool/call', params: { threadId: 'th_test', turnId: 'turn_test', callId: 'c1', tool: 'x', arguments: {} } });
      else out({ jsonrpc: '2.0', id: 'srv-a', method: 'item/commandExecution/requestApproval', params: { threadId: 'th_test', turnId: 'turn_test', itemId: 'i1', startedAtMs: 1, command: process.env.FAKE_COMMAND || 'git status' } });
    } else if (m.method === 'turn/interrupt') {
      out({ jsonrpc: '2.0', id: m.id, result: {} });
      out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th_test', turn: { id: 'turn_test', status: 'interrupted' } } });
    } else if ((m.id === 'srv-a' || m.id === 'srv-q' || m.id === 'srv-u') && m.method === undefined) {
      out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th_test', turn: { id: 'turn_test', status: 'completed' } } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`);
fs.chmodSync(FAKE_CODEX, 0o755);

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function runHost({ backend, fake, mode = 'allow', command = 'git status', policy = POLICY, extraArgs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, `${backend}-`));
  fs.mkdirSync(path.join(dir, 'questions'), { recursive: true });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'do the thing\n');
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');
  const args = [
    HOST, '--backend', backend, '--bin', fake,
    '--card', path.join(dir, 'card.md'), '--task-id', 'T-1', '--seg', 'seg1', '--owner', 'linus',
    '--ws-dir', dir, '--team-root', ROOT, '--cwd', dir,
    '--control-log', path.join(dir, 'control.jsonl'), '--state-file', path.join(dir, 'host.json'),
    '--question-dir', path.join(dir, 'questions'), '--policy', policy, '--prompt-file', prompt,
    '--post-result-wait-ms', '50', '--handshake-timeout-ms', '800', '--control-timeout-ms', '200',
    ...extraArgs,
  ];
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      FAKE_TRANSCRIPT: transcript,
      FAKE_MODE: mode,
      FAKE_COMMAND: command,
      OPENCLAW_TASK_OPS_DIR: path.join(ROOT, 'no-provider'),
      OPENCLAW_LANE_STOPPED_WAIT_MS: '50',
      OPENCLAW_LANE_STOP_GRACE_MS: '100',
    },
  });
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  return { ...r, dir, transcript: read('transcript.jsonl'), control: read('control.jsonl'), out: r.stdout || '', state: read('host.json') };
}

const lastJson = (text) => text.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).pop();

// ── Claude ─────────────────────────────────────────────────────────────────

test('Claude allow：策略放行 ⇒ control_response allow，host exit 0', () => {
  const r = runHost({ backend: 'claude', fake: FAKE_CLAUDE, command: 'git status' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.control, /"action":"allow"/);
  assert.match(r.transcript, /"behavior":"allow"/);
  assert.match(r.out, /"event":"ready"/);
  assert.match(r.out, /"event":"done"/);
});

test('Claude deny：破坏性命令 ⇒ deny，turn 继续，exit 0', () => {
  const r = runHost({ backend: 'claude', fake: FAKE_CLAUDE, command: 'git reset --hard' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.control, /"action":"deny"/);
  assert.match(r.transcript, /"behavior":"deny"/);
});

test('Claude AskUserQuestion：写产物、拒绝、exit 3', () => {
  const r = runHost({ backend: 'claude', fake: FAKE_CLAUDE, mode: 'question' });
  assert.equal(r.status, 3, r.stderr);
  const files = fs.readdirSync(path.join(r.dir, 'questions'));
  assert.equal(files.length, 1);
  const artifact = JSON.parse(fs.readFileSync(path.join(r.dir, 'questions', files[0]), 'utf8'));
  assert.equal(artifact.kind, 'clarify');
  assert.equal(artifact.questions[0].question, 'Which DB?');
  assert.match(r.transcript, /"behavior":"deny"/);
});

test('Claude 策略 escalate：写产物、拒绝、exit 4', () => {
  const r = runHost({ backend: 'claude', fake: FAKE_CLAUDE, command: 'git push origin main' });
  assert.equal(r.status, 4, r.stderr);
  assert.equal(fs.readdirSync(path.join(r.dir, 'questions')).length, 1);
  assert.match(r.control, /"event":"escalate"/);
});

test('Claude 未知 control subtype：回 error 后继续，exit 0', () => {
  const r = runHost({ backend: 'claude', fake: FAKE_CLAUDE, mode: 'unknown' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.transcript, /"subtype":"error"/);
  assert.match(r.control, /"event":"protocol_error"/);
});

test('Claude 坏行：跳过并继续，exit 0', () => {
  const r = runHost({ backend: 'claude', fake: FAKE_CLAUDE, mode: 'badline' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.out, /not json/);
});

test('Claude 握手超时：exit 2，state=failed', () => {
  const r = runHost({ backend: 'claude', fake: FAKE_CLAUDE, mode: 'noinit' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.state, /"state": "failed"/);
});

// ── Codex ──────────────────────────────────────────────────────────────────

test('Codex allow：requestApproval ⇒ accept，turn completed，exit 0', () => {
  const r = runHost({ backend: 'codex', fake: FAKE_CODEX, command: 'git status' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.control, /"action":"allow"/);
  assert.match(r.transcript, /"decision":"accept"/);
  assert.match(r.out, /"thread_id":"th_test"/);
});

test('Codex deny：破坏性命令 ⇒ decline，exit 0', () => {
  const r = runHost({ backend: 'codex', fake: FAKE_CODEX, command: 'git reset --hard' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.transcript, /"decision":"decline"/);
});

test('Codex requestUserInput：空答案 + 中断 + 产物 + exit 3', () => {
  const r = runHost({ backend: 'codex', fake: FAKE_CODEX, mode: 'question' });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(fs.readdirSync(path.join(r.dir, 'questions')).length, 1);
  assert.match(r.transcript, /"answers":\{\}/);
  assert.match(r.transcript, /"method":"turn\/interrupt"/);
});

test('Codex 策略 escalate：cancel + 产物 + exit 4', () => {
  const r = runHost({ backend: 'codex', fake: FAKE_CODEX, command: 'git push origin main' });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.transcript, /"decision":"cancel"/);
  assert.equal(fs.readdirSync(path.join(r.dir, 'questions')).length, 1);
});

test('Codex 未知 server request：回 error 后 turn 完成，exit 0', () => {
  const r = runHost({ backend: 'codex', fake: FAKE_CODEX, mode: 'unknown' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.transcript, /"error":\{/);
  assert.match(r.control, /"event":"protocol_error"/);
});

// ── 配置失败 ───────────────────────────────────────────────────────────────

test('策略加载失败：exit 2，不启动后端', () => {
  const bad = path.join(ROOT, 'bad-policy.json');
  fs.writeFileSync(bad, '{"version":1,"default":"allow","rules":[]}');
  const r = runHost({ backend: 'claude', fake: FAKE_CLAUDE, policy: bad });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /policy_load_failed/);
});
