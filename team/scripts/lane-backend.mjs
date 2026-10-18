#!/usr/bin/env node
/**
 * lane-backend.mjs — 交互 lane 的**纯 argv 构造**（无副作用，单测不需要 provider）。
 *
 * 与 `spawn-lane.mjs#buildCommand` 的分工：
 *   · 非交互 lane 仍由 `spawn-lane.mjs` 构造 `claude -p` / `codex exec`（逐字节不变）。
 *   · 交互 lane 由本模块构造**后端**命令；`spawn-lane.mjs` 再把它包进 `lane-host.mjs`。
 *
 * 关键事实（2026-10 实测，Claude Code 2.1.292 / codex-cli 0.161.0）：
 *   · Claude 自建宿主的绑定是 `--permission-prompt-tool stdio`（公开文档未写，SDK 内部即此路径）；
 *     `--permission-prompts host` 是文档默认，一并带上。prompt 走 stdin 的 stream-json user 消息，
 *     不放进 argv（-p 无 prompt 时由 `--input-format stream-json` 驱动）。
 *   · Codex 交互不能用 `codex exec`（无审批通道）；用 `codex app-server --stdio`。
 *     approval/sandbox 由 JSON-RPC 的 thread/start、turn/start 传入，不靠 CLI 旗标。
 */
import path from 'node:path';

/**
 * 交互 lane 的 Claude settings。**刻意比 `DEFAULT_SETTINGS` 窄**：
 * 后者含 `Bash(git:*)`/`Bash(rm:*)`，会让高风险命令在到达 host 策略之前就被自动放行。
 * 这里只放行只读工具；Write/Edit/Bash 全部落到 host 的 `--permission-mode default` 流程。
 */
export const INTERACTIVE_SETTINGS = {
  permissions: {
    allow: ['Read', 'Glob', 'Grep', 'TodoWrite'],
    deny: ['Agent', 'Task', 'WebFetch', 'WebSearch'],
  },
};
export const INTERACTIVE_SETTINGS_JSON = `${JSON.stringify(INTERACTIVE_SETTINGS, null, 2)}\n`;

/** Claude 交互后端命令（prompt 不在 argv；host 通过 stdin 发 user 消息）。 */
export function buildClaudeInteractiveCommand({ bin = 'claude', wsDir, team, sid = '', name = '' }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'default',
    '--settings', path.join(wsDir, '.claude', 'settings.interactive.json'),
    '--add-dir', wsDir,
    '--add-dir', team,
    '--permission-prompts', 'host',
    '--permission-prompt-tool', 'stdio',
  ];
  if (sid) args.push('--session-id', sid);
  if (name) args.push('--name', name);
  return { bin, args, harness: 'cli' };
}

/**
 * Codex 交互后端命令。thread/start 负责 approvalPolicy/sandbox；turn/start 负责 writable roots。
 * 这里只起 stdio transport。
 */
export function buildCodexAppServerCommand({ bin = 'codex' } = {}) {
  return { bin, args: ['app-server', '--stdio'], harness: 'app-server' };
}

export function buildInteractiveCommand({ backend, bin, wsDir, team, sid = '', name = '' }) {
  if (backend === 'codex') return buildCodexAppServerCommand({ bin });
  return buildClaudeInteractiveCommand({ bin, wsDir, team, sid, name });
}

function pushOpt(args, flag, value) {
  if (value == null || value === '') return;
  args.push(flag, String(value));
}

/** 组装 `node lane-host.mjs ...` 的 host 命令（spawn-lane 的登记 pid = 这个进程）。 */
export function buildLaneHostCommand({
  hostPath,
  backend,
  bin,
  card,
  taskId,
  seg,
  owner,
  role = 'exec',
  wsDir,
  teamRoot,
  cwd,
  sid = '',
  name = '',
  controlLog,
  stateFile,
  questionDir,
  policyPath = '',
  promptFile,
  controlTimeoutMs,
  handshakeTimeoutMs,
  postResultWaitMs,
}) {
  const args = [hostPath];
  pushOpt(args, '--backend', backend);
  pushOpt(args, '--bin', bin);
  pushOpt(args, '--card', card);
  pushOpt(args, '--task-id', taskId);
  pushOpt(args, '--seg', seg);
  pushOpt(args, '--owner', owner);
  pushOpt(args, '--role', role);
  pushOpt(args, '--ws-dir', wsDir);
  pushOpt(args, '--team-root', teamRoot);
  pushOpt(args, '--cwd', cwd);
  pushOpt(args, '--sid', sid);
  pushOpt(args, '--name', name);
  pushOpt(args, '--control-log', controlLog);
  pushOpt(args, '--state-file', stateFile);
  pushOpt(args, '--question-dir', questionDir);
  pushOpt(args, '--policy', policyPath);
  pushOpt(args, '--prompt-file', promptFile);
  pushOpt(args, '--control-timeout-ms', controlTimeoutMs);
  pushOpt(args, '--handshake-timeout-ms', handshakeTimeoutMs);
  pushOpt(args, '--post-result-wait-ms', postResultWaitMs);
  return { bin: process.execPath, args, harness: backend === 'codex' ? 'app-server' : 'cli' };
}
