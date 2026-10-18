#!/usr/bin/env node
/**
 * lane-backend.test.mjs — 交互后端 argv 的纯单测（不需要 provider）。
 *
 * 这些断言是“控制通道真的会被打开”的结构证据：prompt 不进 argv、Claude 带
 * `--permission-prompt-tool stdio`、Codex 走 `app-server --stdio`、settings 指向窄基线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildClaudeInteractiveCommand, buildCodexAppServerCommand, buildInteractiveCommand,
  buildLaneHostCommand, INTERACTIVE_SETTINGS,
} from '../lane-backend.mjs';

const ws = '/team/workspace/T1';
const team = '/team';

test('Claude 交互命令：prompt 不在 argv，控制通道与窄 settings 齐全', () => {
  const c = buildClaudeInteractiveCommand({ bin: 'claude', wsDir: ws, team, sid: 'sid-1', name: 'linus-seg1' });
  assert.equal(c.bin, 'claude');
  assert.equal(c.harness, 'cli');
  assert.equal(c.args[0], '-p');
  assert.ok(c.args.includes('--input-format'));
  assert.ok(c.args.includes('stream-json'));
  assert.ok(c.args.includes('--permission-mode'));
  assert.equal(c.args[c.args.indexOf('--permission-mode') + 1], 'default');
  assert.equal(c.args[c.args.indexOf('--settings') + 1], path.join(ws, '.claude', 'settings.interactive.json'));
  assert.equal(c.args[c.args.indexOf('--permission-prompts') + 1], 'host');
  assert.equal(c.args[c.args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(c.args[c.args.indexOf('--session-id') + 1], 'sid-1');
  assert.equal(c.args[c.args.indexOf('--name') + 1], 'linus-seg1');
  // prompt 不在 argv（由 host 通过 stdin 的 user 消息发送）
  assert.ok(!c.args.some((a) => a.includes('Read your background pack')));
});

test('Codex 交互命令：使用 app-server --stdio，而不是 codex exec', () => {
  const c = buildCodexAppServerCommand({ bin: 'codex' });
  assert.deepEqual(c.args, ['app-server', '--stdio']);
  assert.equal(c.harness, 'app-server');
  assert.equal(buildInteractiveCommand({ backend: 'codex', bin: 'codex' }).args[0], 'app-server');
  assert.equal(buildInteractiveCommand({ backend: 'claude', bin: 'claude', wsDir: ws, team }).args[0], '-p');
});

test('交互 settings 刻意窄于 DEFAULT_SETTINGS', () => {
  assert.deepEqual(INTERACTIVE_SETTINGS.permissions.allow, ['Read', 'Glob', 'Grep', 'TodoWrite']);
  assert.ok(INTERACTIVE_SETTINGS.permissions.deny.includes('Agent'));
  // 不得出现会绕过策略的宽 Bash 规则
  assert.ok(!INTERACTIVE_SETTINGS.permissions.allow.some((r) => r.startsWith('Bash')));
});

test('host 命令：node 执行 lane-host.mjs，参数齐全', () => {
  const c = buildLaneHostCommand({
    hostPath: '/team/scripts/lane-host.mjs',
    backend: 'claude', bin: 'claude', card: '/team/tasks/T-1.md', taskId: 'T-1', seg: 'seg1',
    owner: 'linus', role: 'exec', wsDir: ws, teamRoot: team, cwd: '/repo', sid: 'sid-1', name: 'linus-seg1',
    controlLog: `${ws}/linus-1.control.jsonl`, stateFile: `${ws}/linus-1.host.json`,
    questionDir: `${ws}/questions`, policyPath: '/team/scripts/lane-policy.default.json',
    promptFile: `${ws}/linus-1.prompt.txt`, controlTimeoutMs: 5000,
    handshakeTimeoutMs: 30000, postResultWaitMs: 10000,
  });
  assert.equal(c.bin, process.execPath);
  assert.equal(c.args[0], '/team/scripts/lane-host.mjs');
  for (const flag of ['--backend', '--bin', '--card', '--task-id', '--seg', '--owner', '--role',
    '--ws-dir', '--team-root', '--cwd', '--sid', '--name', '--control-log', '--state-file',
    '--question-dir', '--policy', '--prompt-file', '--control-timeout-ms',
    '--handshake-timeout-ms', '--post-result-wait-ms']) {
    assert.ok(c.args.includes(flag), `missing ${flag}`);
  }
  assert.equal(c.args[c.args.indexOf('--backend') + 1], 'claude');
  assert.equal(c.args[c.args.indexOf('--policy') + 1], '/team/scripts/lane-policy.default.json');
  assert.equal(c.harness, 'cli');
});
