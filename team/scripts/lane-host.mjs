#!/usr/bin/env node
/**
 * lane-host.mjs — 交互 lane 的**长生命周期宿主**。
 *
 * 为什么需要它：`spawn-lane` 当前是“起进程 → 登记 → 退出”，纯文本 `claude -p` 与
 * `codex exec` 都没有“执行中提问/审批”的通道。host 作为被登记的 pid 活到整个 turn：
 *   · Claude：stream-json + `can_use_tool` 控制请求；
 *   · Codex：`app-server --stdio` 的 JSON-RPC server→client 请求。
 * 它只做三件事：**转发输出、按本地策略裁决权限、把澄清/无法裁决的请求升级到看板并停止**。
 *
 * 不变量：
 *   · 默认 fail-closed：策略无匹配 ⇒ deny；策略异常 ⇒ deny；未知控制消息 ⇒ error。
 *   · 澄清/`requires_user_interaction`/`requestUserInput` **永远**升级，任何 allow 规则都盖不住。
 *   · 升级 ≠ 等待：写产物 + 评论 + `blocked`，然后停止 lane；答案由新分段承接。
 *   · 所有控制请求在 `control_timeout_ms` 内作答；host 不会无声挂起。
 *
 * 退出码：0 完成 · 1 后端/协议失败 · 2 握手/配置 · 3 澄清停止 · 4 决策/权限升级停止。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadPolicy, evaluatePolicy, normalizeRequest, redact } from './lane-policy.mjs';
import { buildInteractiveCommand } from './lane-backend.mjs';
import { writeState, updateState } from './lane-host-state.mjs';
import { writeQuestionArtifact, buildEscalationText, escalate } from './lane-escalate.mjs';

const DEFAULTS = {
  controlTimeoutMs: 5000,
  handshakeTimeoutMs: 30000,
  postResultWaitMs: 10000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

export function parseHostArgs(argv = []) {
  const kv = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { ok: true, help: true };
    if (!a.startsWith('--')) return { ok: false, reason: `unexpected_positional:${a}` };
    const key = a.slice(2);
    const v = argv[++i];
    if (v == null) return { ok: false, reason: `missing_value:${a}` };
    kv[key] = v;
  }
  const required = ['backend', 'bin', 'card', 'task-id', 'seg', 'owner', 'ws-dir', 'team-root', 'cwd',
    'control-log', 'state-file', 'question-dir', 'prompt-file'];
  for (const k of required) if (!kv[k]) return { ok: false, reason: `missing:${k}` };
  if (!['claude', 'codex'].includes(kv.backend)) return { ok: false, reason: `unknown_backend:${kv.backend}` };
  return {
    ok: true,
    backend: kv.backend,
    bin: kv.bin,
    card: kv.card,
    taskId: kv['task-id'],
    seg: kv.seg,
    owner: kv.owner,
    role: kv.role || 'exec',
    wsDir: kv['ws-dir'],
    teamRoot: kv['team-root'],
    cwd: kv.cwd,
    sid: kv.sid || '',
    name: kv.name || '',
    controlLog: kv['control-log'],
    stateFile: kv['state-file'],
    questionDir: kv['question-dir'],
    policyPath: kv.policy || '',
    promptFile: kv['prompt-file'],
    controlTimeoutMs: num(kv['control-timeout-ms'], DEFAULTS.controlTimeoutMs),
    handshakeTimeoutMs: num(kv['handshake-timeout-ms'], DEFAULTS.handshakeTimeoutMs),
    postResultWaitMs: num(kv['post-result-wait-ms'], DEFAULTS.postResultWaitMs),
  };
}

function logLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function writeJson(stream, obj) {
  if (!stream || stream.destroyed || !stream.writable) return false;
  try {
    stream.write(`${JSON.stringify(obj)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 逐行读取（文件/管道都可能把一行拆成多个 chunk）。 */
function onLines(stream, cb) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      const i = buf.indexOf('\n');
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) cb(line);
    }
  });
  stream.on('end', () => {
    if (buf.trim()) cb(buf);
  });
}

function appendControl(ctx, event) {
  try {
    fs.mkdirSync(path.dirname(ctx.controlLog), { recursive: true });
    fs.appendFileSync(ctx.controlLog, `${JSON.stringify(redact({ ts: nowIso(), ...event }))}\n`);
  } catch {
    /* 控制日志失败不阻断裁决：stdout/stderr 仍是主证据 */
  }
}

function exitCodeForKind(kind) {
  return kind === 'decision' ? 4 : 3;
}

function eventForKind(kind) {
  return kind === 'decision' ? 'stopped_for_decision' : 'stopped_for_clarification';
}

function spawnBuilt(ctx, built) {
  const child = spawn(built.bin, built.args, {
    cwd: ctx.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // 后端自成一个进程组 ⇒ host 可用 -pid 一次清掉整棵子进程树
    env: process.env,
  });
  child.on('error', () => { /* 具体错误在 exit/handshake 路径收口 */ });
  return child;
}

function killBackend(ctx, signal = 'SIGTERM') {
  const pid = ctx.child && ctx.child.pid;
  if (!pid) return;
  try { process.kill(-pid, signal); return; } catch { /* 非组/已退出：回退单 pid */ }
  try { ctx.child.kill(signal); } catch { /* 忽略 */ }
}

function markReady(ctx, extra = {}) {
  if (ctx.ready) return;
  ctx.ready = true;
  updateState(ctx.stateFile, {
    state: 'running',
    backend_pid: ctx.child && ctx.child.pid ? ctx.child.pid : null,
    ...extra,
  });
  logLine({
    type: 'lane-host',
    event: 'ready',
    backend: ctx.backend,
    pid: process.pid,
    backend_pid: ctx.child && ctx.child.pid ? ctx.child.pid : null,
    ...extra,
  });
}

/**
 * 结束 host：先关闭后端 stdin，留出收尾窗口，再 SIGTERM/SIGKILL 整组。
 * `ctx.finished` 保证 result/exit/escalate 多路触发只收口一次。
 */
async function settle(ctx, code, event, extra = {}) {
  if (ctx.finished) return;
  ctx.finished = true;
  ctx.settleCode = code;
  try { if (ctx.child && ctx.child.stdin) ctx.child.stdin.end(); } catch { /* 忽略 */ }
  // 正常完成留出收尾窗口；升级/信号停止只留 2s，避免“已经停下来还在等”。
  const stoppedWait = Number(process.env.OPENCLAW_LANE_STOPPED_WAIT_MS);
  const wait = event.startsWith('stopped')
    ? (Number.isFinite(stoppedWait) && stoppedWait >= 0 ? stoppedWait : 2000)
    : Math.max(0, ctx.postResultWaitMs);
  if (wait) await sleep(wait);
  killBackend(ctx, 'SIGTERM');
  const stopGrace = Number(process.env.OPENCLAW_LANE_STOP_GRACE_MS);
  await sleep(Number.isFinite(stopGrace) && stopGrace >= 0 ? stopGrace : 1500);
  killBackend(ctx, 'SIGKILL');
  updateState(ctx.stateFile, { state: event, ended_at: nowIso(), exit_code: code });
  logLine({ type: 'lane-host', event, backend: ctx.backend, exit_code: code, ...extra });
  process.exit(code);
}

function fail(ctx, code, reason, extra = {}) {
  appendControl(ctx, { event: 'failure', backend: ctx.backend, reason });
  return settle(ctx, code, 'failed', { reason, ...extra });
}

function onSignal(ctx, signal) {
  if (ctx.finished) return;
  ctx.finished = true;
  appendControl(ctx, { event: 'signal', backend: ctx.backend, signal });
  killBackend(ctx, 'SIGTERM');
  updateState(ctx.stateFile, { state: 'stopped', ended_at: nowIso(), signal });
  logLine({ type: 'lane-host', event: 'signal', backend: ctx.backend, signal });
  // 给 SIGKILL 一个窗口；即使没跑完，reaper 仍会按 sidecar 清理。
  const stopGrace = Number(process.env.OPENCLAW_LANE_STOP_GRACE_MS);
  setTimeout(() => {
    killBackend(ctx, 'SIGKILL');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }, Number.isFinite(stopGrace) && stopGrace >= 0 ? stopGrace : 1500);
}

// ---------------------------------------------------------------------------
// 决策辅助
// ---------------------------------------------------------------------------

function claudeRequestKind(tool) {
  if (tool === 'Bash') return 'command';
  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') return 'file';
  return 'tool';
}

function normalizeClaudeQuestions(input = {}) {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs.map((q, i) => ({
    id: String(q.id || i + 1),
    header: String(q.header || ''),
    question: String(q.question || ''),
    options: Array.isArray(q.options)
      ? q.options.map((o) => ({ label: String(o.label || ''), description: String(o.description || '') }))
      : [],
    isOther: true,
  }));
}

function permissionQuestion({ tool, input = {}, decision = {} } = {}) {
  const subject = tool === 'Bash'
    ? String(input.command || '')
    : String(input.file_path || input.path || '');
  return [{
    id: 'approval',
    header: 'Approval',
    question: `Allow ${tool}${subject ? `: ${subject}` : ''}? (policy: ${decision.ruleId || decision.reason || 'no rule'})`,
    options: [
      { label: 'allow', description: 'Approve this one request' },
      { label: 'deny', description: 'Do not run it' },
    ],
    isOther: false,
  }];
}

function codexApprovalQuestion(method, params = {}, decision = {}) {
  const subject = params.command || params.grantRoot || params.reason || '';
  return [{
    id: 'approval',
    header: 'Approval',
    question: `${method}${subject ? `: ${subject}` : ''} (policy: ${decision.ruleId || decision.reason || 'no rule'})`,
    options: [
      { label: 'allow', description: 'Approve this one request' },
      { label: 'deny', description: 'Do not run it' },
    ],
    isOther: false,
  }];
}

/**
 * 共用升级：写产物 → 评论 + blocked → 停止。
 * `reply` 由调用方在调用前/后决定（Claude 必须先回 deny 才解除阻塞；Codex 先回 cancel/空答案）。
 */
async function escalateAndStop(ctx, { kind, questions, requestId, tool, context = {} }) {
  // 先立“正在停止”标志：后端可能在我们写产物/评论期间就发出 result/turn-completed，
  // 那些正常完成信号不能抢先 settle 成 done。
  ctx.stopping = true;
  // Codex：先中断当前 turn，避免模型拿着空答案/取消继续跑；Claude 靠 deny + close stdin。
  if (ctx.backend === 'codex' && typeof ctx.interruptTurn === 'function') {
    try { await ctx.interruptTurn(); } catch { /* 中断失败不掩盖主因：仍然停止 */ }
  }
  const artifact = writeQuestionArtifact({
    questionDir: ctx.questionDir,
    owner: ctx.owner,
    seg: ctx.seg,
    backend: ctx.backend,
    taskId: ctx.taskId,
    requestId,
    sessionId: ctx.sid,
    threadId: ctx.threadId || '',
    kind,
    questions,
    context,
  });
  const text = buildEscalationText({
    card: ctx.card,
    taskId: ctx.taskId,
    seg: ctx.seg,
    owner: ctx.owner,
    backend: ctx.backend,
    kind,
    artifactPath: artifact.path || '',
    questions,
  });
  const result = await escalate({
    card: ctx.card,
    owner: ctx.owner,
    kind,
    artifactPath: artifact.path || '',
    text,
    env: process.env,
  });
  appendControl(ctx, {
    event: 'escalate',
    backend: ctx.backend,
    request_id: requestId,
    tool,
    kind,
    action: 'escalate',
    artifact: artifact.path || '',
    artifact_ok: artifact.ok,
    board_ok: result.ok,
    comment_ok: Boolean(result.comment && result.comment.ok),
    status_ok: Boolean(result.status && result.status.ok),
    fallback_ok: Boolean(result.fallback && result.fallback.ok),
    reason: result.reason || artifact.reason || '',
    policy_digest: ctx.policyDigest,
  });
  await settle(ctx, exitCodeForKind(kind), eventForKind(kind), {
    artifact: artifact.path || '',
    request_id: requestId,
    tool,
  });
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

function replyClaude(ctx, requestId, request, behavior, message = '') {
  const response = behavior === 'allow'
    ? { behavior: 'allow', updatedInput: request.input || {}, toolUseID: request.tool_use_id }
    : { behavior: 'deny', message: message || 'denied by lane policy', toolUseID: request.tool_use_id };
  writeJson(ctx.child.stdin, {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  });
}

function replyClaudeError(ctx, requestId, error) {
  writeJson(ctx.child.stdin, {
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error },
  });
}

async function handleClaudeControl(ctx, msg) {
  const request = msg.request || {};
  const requestId = msg.request_id;
  if (request.subtype !== 'can_use_tool') {
    replyClaudeError(ctx, requestId, `unsupported_control:${request.subtype || ''}`);
    appendControl(ctx, { event: 'protocol_error', backend: 'claude', request_id: requestId, reason: `unsupported_control:${request.subtype || ''}` });
    return;
  }
  const tool = request.tool_name || '';
  if (request.requires_user_interaction === true || tool === 'AskUserQuestion') {
    replyClaude(ctx, requestId, request, 'deny', 'question escalated to the board; this lane is stopping. Do not guess.');
    await escalateAndStop(ctx, {
      kind: 'clarify',
      questions: normalizeClaudeQuestions(request.input || {}),
      requestId,
      tool,
      context: { cwd: ctx.cwd, tool_name: tool },
    });
    return;
  }
  const kind = claudeRequestKind(tool);
  const normalized = normalizeRequest({ backend: 'claude', kind, tool, input: request.input || {} });
  let decision;
  try {
    decision = evaluatePolicy(ctx.policy, normalized, ctx.policyCtx);
  } catch (e) {
    decision = { action: 'deny', ruleId: '', reason: `policy_error:${e && e.message ? e.message : e}`, subject: normalized.subject };
  }
  appendControl(ctx, {
    event: 'request',
    backend: 'claude',
    request_id: requestId,
    tool,
    kind,
    action: decision.action,
    rule_id: decision.ruleId,
    reason: decision.reason,
    policy_digest: ctx.policyDigest,
    subject_redacted: decision.subject,
  });
  if (decision.action === 'allow') {
    replyClaude(ctx, requestId, request, 'allow');
    return;
  }
  if (decision.action === 'deny') {
    replyClaude(ctx, requestId, request, 'deny', decision.reason || 'denied by lane policy');
    return;
  }
  replyClaude(ctx, requestId, request, 'deny', 'escalated to the board; this lane is stopping. Do not guess.');
  await escalateAndStop(ctx, {
    kind: 'decision',
    questions: permissionQuestion({ tool, input: request.input || {}, decision }),
    requestId,
    tool,
    context: { cwd: ctx.cwd, tool_name: tool, rule_id: decision.ruleId },
  });
}

async function runClaude(ctx) {
  const built = buildInteractiveCommand({
    backend: 'claude', bin: ctx.bin, wsDir: ctx.wsDir, team: ctx.teamRoot, sid: ctx.sid, name: ctx.name,
  });
  const child = spawnBuilt(ctx, built);
  ctx.child = child;
  let sawResult = false;
  const handshake = setTimeout(() => {
    if (!ctx.ready) fail(ctx, 2, 'handshake_timeout');
  }, ctx.handshakeTimeoutMs);

  onLines(child.stdout, (line) => {
    process.stdout.write(`${line}\n`);
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (ctx.ready) return;
      clearTimeout(handshake);
      markReady(ctx);
      writeJson(child.stdin, {
        type: 'user',
        message: { role: 'user', content: ctx.prompt },
      });
      return;
    }
    if (msg.type === 'control_request') { void handleClaudeControl(ctx, msg); return; }
    if (msg.type === 'control_cancel_request') {
      appendControl(ctx, { event: 'control_cancel', backend: 'claude', request_id: msg.request_id });
      return;
    }
    if (msg.type === 'keep_alive') return;
    if (msg.type === 'result') {
      sawResult = true;
      if (ctx.stopping) return; // 升级流程正在收口
      void settle(ctx, 0, 'done', { subtype: msg.subtype || '' });
    }
  });
  onLines(child.stderr, (line) => process.stderr.write(`${line}\n`));
  child.on('exit', (code, signal) => {
    clearTimeout(handshake);
    if (ctx.finished || ctx.stopping) return;
    if (!ctx.ready) return fail(ctx, 2, `handshake_failed(exit=${code},signal=${signal})`);
    if (!sawResult) return fail(ctx, 1, `backend_exit(code=${code},signal=${signal})`);
  });
}

// ---------------------------------------------------------------------------
// Codex app-server
// ---------------------------------------------------------------------------

function codexReply(ctx, id, result) {
  writeJson(ctx.child.stdin, { jsonrpc: '2.0', id, result });
}

function codexReplyError(ctx, id, code, message) {
  writeJson(ctx.child.stdin, { jsonrpc: '2.0', id, error: { code, message } });
}

async function handleCodexServerRequest(ctx, msg, io) {
  const method = msg.method;
  const params = msg.params || {};
  const id = msg.id;

  const decide = (kind, tool) => {
    const normalized = normalizeRequest({ backend: 'codex', kind, tool, params });
    try {
      return { normalized, decision: evaluatePolicy(ctx.policy, normalized, ctx.policyCtx) };
    } catch (e) {
      return { normalized, decision: { action: 'deny', ruleId: '', reason: `policy_error:${e && e.message ? e.message : e}`, subject: normalized.subject } };
    }
  };
  const record = (kind, tool, decision, extra = {}) => appendControl(ctx, {
    event: 'request',
    backend: 'codex',
    request_id: id,
    method,
    tool,
    kind,
    action: decision.action,
    rule_id: decision.ruleId,
    reason: decision.reason,
    policy_digest: ctx.policyDigest,
    subject_redacted: decision.subject,
    ...extra,
  });

  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const { decision } = decide('command', 'Bash');
      record('command', 'Bash', decision);
      if (decision.action === 'allow') return codexReply(ctx, id, { decision: 'accept' });
      if (decision.action === 'deny') return codexReply(ctx, id, { decision: 'decline' });
      codexReply(ctx, id, { decision: 'cancel' });
      return escalateAndStop(ctx, {
        kind: 'decision',
        questions: codexApprovalQuestion(method, params, decision),
        requestId: id,
        tool: 'Bash',
        context: { cwd: ctx.cwd, method, command: params.command || '' },
      });
    }
    case 'item/fileChange/requestApproval': {
      const { decision } = decide('file', 'Write');
      record('file', 'Write', decision);
      if (decision.action === 'allow') return codexReply(ctx, id, { decision: 'accept' });
      if (decision.action === 'deny') return codexReply(ctx, id, { decision: 'decline' });
      codexReply(ctx, id, { decision: 'cancel' });
      return escalateAndStop(ctx, {
        kind: 'decision',
        questions: codexApprovalQuestion(method, params, decision),
        requestId: id,
        tool: 'Write',
        context: { cwd: ctx.cwd, method, grant_root: params.grantRoot || '' },
      });
    }
    case 'item/permissions/requestApproval': {
      const { decision } = decide('permission', 'permission');
      record('permission', 'permission', decision);
      if (decision.action === 'allow') {
        return codexReply(ctx, id, { permissions: params.permissions || {}, scope: 'turn' });
      }
      codexReply(ctx, id, { permissions: {} });
      if (decision.action === 'deny') return;
      return escalateAndStop(ctx, {
        kind: 'decision',
        questions: codexApprovalQuestion(method, params, decision),
        requestId: id,
        tool: 'permission',
        context: { cwd: ctx.cwd, method },
      });
    }
    case 'item/tool/requestUserInput': {
      // 先回空答案解除 server 阻塞，再 interrupt + 升级；模型不会拿到一个“猜测的”答案。
      codexReply(ctx, id, { answers: {} });
      appendControl(ctx, {
        event: 'request', backend: 'codex', request_id: id, method, tool: 'request_user_input',
        kind: 'question', action: 'escalate', policy_digest: ctx.policyDigest,
      });
      return escalateAndStop(ctx, {
        kind: 'clarify',
        questions: Array.isArray(params.questions) ? params.questions : [],
        requestId: id,
        tool: 'request_user_input',
        context: { cwd: ctx.cwd, method, item_id: params.itemId || '' },
      });
    }
    case 'mcpServer/elicitation/request': {
      codexReply(ctx, id, { action: 'decline' });
      appendControl(ctx, {
        event: 'request', backend: 'codex', request_id: id, method, tool: 'mcp_elicitation',
        kind: 'question', action: 'escalate', policy_digest: ctx.policyDigest,
      });
      return escalateAndStop(ctx, {
        kind: 'clarify',
        questions: [{
          id: 'elicitation',
          header: 'MCP elicitation',
          question: String(params.message || params.question || 'MCP server requested input'),
          options: [],
          isOther: true,
        }],
        requestId: id,
        tool: 'mcp_elicitation',
        context: { cwd: ctx.cwd, method },
      });
    }
    case 'execCommandApproval':
    case 'applyPatchApproval': {
      const kind = method === 'execCommandApproval' ? 'command' : 'file';
      const tool = kind === 'command' ? 'Bash' : 'Write';
      const { decision } = decide(kind, tool);
      record(kind, tool, decision);
      if (decision.action === 'allow') return codexReply(ctx, id, { decision: 'approved' });
      if (decision.action === 'deny') return codexReply(ctx, id, { decision: 'denied' });
      codexReply(ctx, id, { decision: 'abort' });
      return escalateAndStop(ctx, {
        kind: 'decision',
        questions: codexApprovalQuestion(method, params, decision),
        requestId: id,
        tool,
        context: { cwd: ctx.cwd, method },
      });
    }
    case 'item/tool/call':
      codexReplyError(ctx, id, -32601, 'dynamic tool calls are not supported by lane-host');
      appendControl(ctx, { event: 'protocol_error', backend: 'codex', request_id: id, reason: 'item/tool/call_unsupported' });
      return;
    default:
      codexReplyError(ctx, id, -32601, `unsupported server request: ${method}`);
      appendControl(ctx, { event: 'protocol_error', backend: 'codex', request_id: id, reason: `unsupported_method:${method}` });
      return;
  }
}

async function runCodex(ctx) {
  const built = buildInteractiveCommand({ backend: 'codex', bin: ctx.bin });
  const child = spawnBuilt(ctx, built);
  ctx.child = child;

  let nextId = 1;
  const pending = new Map();
  const handshake = setTimeout(() => {
    if (!ctx.ready) fail(ctx, 2, 'handshake_timeout');
  }, ctx.handshakeTimeoutMs);

  const send = (method, params) => {
    const id = nextId++;
    writeJson(child.stdin, { jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const notify = (method, params) => writeJson(child.stdin, params === undefined
    ? { jsonrpc: '2.0', method }
    : { jsonrpc: '2.0', method, params });
  const io = { send, notify };
  ctx.interruptTurn = async () => {
    if (!ctx.threadId || !ctx.turnId) return;
    try {
      // 服务端可能不回应 interrupt（或已自行结束 turn）；升级流程不能被它挂住。
      await Promise.race([
        send('turn/interrupt', { threadId: ctx.threadId, turnId: ctx.turnId }),
        sleep(2000),
      ]);
    } catch { /* 已结束/不支持 */ }
  };

  onLines(child.stdout, (line) => {
    process.stdout.write(`${line}\n`);
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id != null && msg.method) { void handleCodexServerRequest(ctx, msg, io); return; }
    if (msg.method) {
      if (msg.method === 'thread/started') {
        const tid = msg.params && msg.params.thread && msg.params.thread.id;
        if (tid && !ctx.threadId) {
          ctx.threadId = tid;
          updateState(ctx.stateFile, { thread_id: tid });
        }
        return;
      }
      if (msg.method === 'turn/started') {
        const tid = msg.params && msg.params.turn && msg.params.turn.id;
        if (tid) ctx.turnId = tid;
        return;
      }
      if (msg.method === 'turn/completed') {
        const turn = (msg.params && msg.params.turn) || {};
        ctx.completed = true;
        if (ctx.stopping) return; // 升级流程正在收口，正常完成信号不得抢先
        if (turn.status === 'failed') return void settle(ctx, 1, 'failed', { turn_status: turn.status });
        return void settle(ctx, 0, 'done', { turn_status: turn.status || '' });
      }
      if (msg.method === 'error') {
        appendControl(ctx, { event: 'protocol_error', backend: 'codex', reason: JSON.stringify(msg.params || {}).slice(0, 500) });
        if (!ctx.ready) return fail(ctx, 1, 'codex_error_before_ready');
        return;
      }
      return;
    }
  });
  onLines(child.stderr, (line) => process.stderr.write(`${line}\n`));
  child.on('exit', (code, signal) => {
    clearTimeout(handshake);
    if (ctx.finished || ctx.stopping) return;
    if (!ctx.ready) return fail(ctx, 2, `handshake_failed(exit=${code},signal=${signal})`);
    if (!ctx.completed) return fail(ctx, 1, `backend_exit(code=${code},signal=${signal})`);
  });

  try {
    await send('initialize', {
      clientInfo: { name: 'openclaw-lane-host', title: 'OpenClaw Lane Host', version: '1.0.0' },
      capabilities: {},
    });
    notify('initialized');
    const started = await send('thread/start', {
      cwd: ctx.cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    });
    ctx.threadId = (started && started.thread && started.thread.id) || (started && started.threadId) || '';
    if (!ctx.threadId) throw new Error('thread_id_missing');
    logLine({ type: 'thread.started', thread_id: ctx.threadId });
    updateState(ctx.stateFile, { thread_id: ctx.threadId });
    const turn = await send('turn/start', {
      threadId: ctx.threadId,
      cwd: ctx.cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [ctx.wsDir, path.join(ctx.teamRoot, 'workspace', ctx.taskId)],
        networkAccess: false,
      },
      input: [{ type: 'text', text: ctx.prompt }],
    });
    ctx.turnId = (turn && turn.turn && turn.turn.id) || '';
    clearTimeout(handshake);
    markReady(ctx, { thread_id: ctx.threadId, turn_id: ctx.turnId || null });
  } catch (e) {
    clearTimeout(handshake);
    await fail(ctx, 1, `codex_handshake_failed:${e && e.message ? e.message : e}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const a = parseHostArgs(argv);
  if (!a.ok) {
    console.log(JSON.stringify({ ok: false, reason: a.reason }));
    process.exit(2);
  }
  if (a.help) {
    console.log('usage: node lane-host.mjs --backend claude|codex --bin <path> --card <path> --task-id <id> ...');
    process.exit(0);
  }

  const loaded = loadPolicy({ policyPath: a.policyPath, teamRoot: a.teamRoot, env: process.env });
  if (!loaded.ok) {
    console.log(JSON.stringify({ ok: false, reason: `policy_load_failed:${loaded.reason}` }));
    process.exit(2);
  }
  let prompt;
  try {
    prompt = fs.readFileSync(a.promptFile, 'utf8');
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: `prompt_unreadable:${e && e.message ? e.message : e}` }));
    process.exit(2);
  }

  const ctx = {
    ...a,
    prompt,
    policy: loaded.policy,
    policySource: loaded.source,
    policyPath: loaded.path,
    policyDigest: loaded.digest,
    policyCtx: { cwd: a.cwd, wsDir: a.wsDir, teamRoot: a.teamRoot, taskId: a.taskId, home: process.env.HOME || '' },
    child: null,
    ready: false,
    finished: false,
    threadId: '',
    turnId: '',
    completed: false,
  };

  writeState(ctx.stateFile, {
    v: 1,
    host_pid: process.pid,
    backend: ctx.backend,
    card: ctx.card,
    task_id: ctx.taskId,
    seg: ctx.seg,
    owner: ctx.owner,
    role: ctx.role,
    session_id: ctx.sid,
    thread_id: '',
    interactive: true,
    control_log: ctx.controlLog,
    question_dir: ctx.questionDir,
    policy_path: ctx.policyPath,
    policy_source: ctx.policySource,
    policy_digest: ctx.policyDigest,
    state: 'starting',
    started_at: nowIso(),
    ended_at: '',
  });
  process.on('SIGTERM', () => onSignal(ctx, 'SIGTERM'));
  process.on('SIGINT', () => onSignal(ctx, 'SIGINT'));

  if (ctx.backend === 'codex') await runCodex(ctx);
  else await runClaude(ctx);
}

const self = fs.realpathSync(new URL(import.meta.url));
try {
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) void main();
} catch { /* 被 import 时不执行 main */ }
