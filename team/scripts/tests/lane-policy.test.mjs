#!/usr/bin/env node
/**
 * lane-policy.test.mjs — 交互 lane 本地策略引擎的纯单测（不需要 provider）。
 *
 * 覆盖：默认 deny、首个匹配、命令前缀边界、shell 元字符、路径逃逸、脱敏、digest、
 * 策略加载优先级与非法策略拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPolicy, evaluatePolicy, normalizeRequest, redact, policyDigest,
  matchesCommandPrefix, hasShellMeta, validatePolicy,
} from '../lane-policy.mjs';

const ctx = { cwd: '/repo', wsDir: '/repo/ws/T1', teamRoot: '/team', taskId: 'T1', home: '/home/u' };
const evalCmd = (policy, command) => evaluatePolicy(
  policy, normalizeRequest({ backend: 'claude', kind: 'command', tool: 'Bash', input: { command } }), ctx,
);
const evalFile = (policy, filePath) => evaluatePolicy(
  policy, normalizeRequest({ backend: 'claude', kind: 'file', tool: 'Write', input: { file_path: filePath } }), ctx,
);

function defaultPolicy() {
  const r = loadPolicy({});
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.policy;
}

test('默认策略：只读放行、破坏性 deny、网络 escalate、未知 escalate', () => {
  const p = defaultPolicy();
  assert.equal(evalCmd(p, 'git status').action, 'allow');
  assert.equal(evalCmd(p, 'git status -s').action, 'allow');
  assert.equal(evalCmd(p, 'git reset --hard').action, 'deny');
  assert.equal(evalCmd(p, 'find . -name x -delete').action, 'deny');
  assert.equal(evalCmd(p, 'git push origin main').action, 'escalate');
  assert.equal(evalCmd(p, 'some-unknown-binary --x').action, 'escalate');
});

test('命令前缀有边界：ls 命中 ls -la，不命中 lsof', () => {
  assert.equal(matchesCommandPrefix('ls -la', 'ls'), true);
  assert.equal(matchesCommandPrefix('lsof -i', 'ls'), false);
  assert.equal(matchesCommandPrefix('git add .', 'git add '), true);
  assert.equal(matchesCommandPrefix('git addx', 'git add '), false);
});

test('shell 元字符：复合命令不得靠前缀白名单绕过', () => {
  assert.equal(hasShellMeta('git status && rm -rf /'), true);
  assert.equal(hasShellMeta('git status'), false);
  const p = defaultPolicy();
  const d = evalCmd(p, 'git status && rm -rf /');
  assert.equal(d.action, 'escalate');
  assert.equal(d.ruleId, 'escalate-shell-meta');
});

test('路径：workspace 可写、凭据路径 deny、.. 逃逸不匹配', () => {
  const p = defaultPolicy();
  assert.equal(evalFile(p, '/repo/ws/T1/report.md').action, 'allow');
  assert.equal(evalFile(p, '/team/workspace/T1/report.md').action, 'allow');
  assert.equal(evalFile(p, '/team/.secrets.env').action, 'deny');
  assert.equal(evalFile(p, '/repo/ws/T1/../../etc/passwd').action, 'escalate');
});

test('多个路径：allow 规则必须覆盖全部路径', () => {
  const policy = {
    version: 1, default: 'deny', rules: [
      { id: 'allow-ws', kind: 'file', tool: ['Write'], pathPrefix: ['/repo/ws/T1'], action: 'allow' },
      { id: 'rest', kind: '*', action: 'deny' },
    ],
  };
  const ok = evaluatePolicy(policy, normalizeRequest({ backend: 'claude', kind: 'file', tool: 'Write', input: { file_path: '/repo/ws/T1/a' } }), ctx);
  assert.equal(ok.action, 'allow');
  const bad = evaluatePolicy(policy, { backend: 'claude', kind: 'file', tool: 'Write', paths: ['/repo/ws/T1/a', '/etc/passwd'], subject: '' }, ctx);
  assert.equal(bad.action, 'deny');
});

test('策略校验：default 必须 deny；非法 action/regex 拒绝', () => {
  assert.ok(validatePolicy({ version: 1, default: 'allow', rules: [] }).includes('default_must_be_deny'));
  assert.ok(validatePolicy({ version: 1, default: 'deny', rules: [{ id: 'x', action: 'maybe' }] }).some((e) => e.includes('action_invalid')));
  assert.ok(validatePolicy({ version: 1, default: 'deny', rules: [{ id: 'x', action: 'deny', commandRegex: ['('] }] }).some((e) => e.includes('commandRegex_invalid')));
  assert.ok(validatePolicy({ version: 1, default: 'deny', rules: [{ id: 'x', action: 'deny' }] }).includes('rules[0].no_matcher'));
});

test('脱敏：按关键键名遮蔽，长串截断，问题文本保留', () => {
  const out = redact({
    token: 'abc', nested: { apiKey: 'k', command: 'git status' }, long: 'x'.repeat(20),
    questions: [{ question: 'Which DB?', secret: 's' }],
  }, { maxString: 10 });
  assert.equal(out.token, '[redacted]');
  assert.equal(out.nested.apiKey, '[redacted]');
  assert.equal(out.nested.command, 'git status');
  assert.match(out.long, /truncated/);
  assert.equal(out.questions[0].question, 'Which DB?');
  assert.equal(out.questions[0].secret, '[redacted]');
  // 值级脱敏：命令/问题文本里的 token 形态
  assert.equal(redact('curl --token=abc https://x'), 'curl --token=[redacted] https://x');
  assert.match(redact('Authorization: Bearer abc.def'), /Bearer \[redacted\]/);
  assert.match(redact('key sk-abcdefgh123'), /\[redacted\]/);
});

test('digest 与键序无关、与内容有关', () => {
  const a = { version: 1, default: 'deny', rules: [] };
  const b = { rules: [], default: 'deny', version: 1 };
  assert.equal(policyDigest(a), policyDigest(b));
  assert.notEqual(policyDigest(a), policyDigest({ ...a, default: 'deny', control_timeout_ms: 1 }));
});

test('加载优先级：显式 > env > team > 默认；显式缺失/非法 team 文件失败', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-policy-'));
  try {
    const team = path.join(dir, 'lane-policy.json');
    const explicit = path.join(dir, 'explicit.json');
    fs.writeFileSync(team, JSON.stringify({ version: 1, default: 'deny', rules: [{ id: 't', kind: '*', action: 'deny' }] }));
    fs.writeFileSync(explicit, JSON.stringify({ version: 1, default: 'deny', rules: [{ id: 'e', kind: '*', action: 'deny' }] }));
    assert.equal(loadPolicy({ teamRoot: dir }).path, team);
    assert.equal(loadPolicy({ teamRoot: dir, env: { OPENCLAW_LANE_POLICY: explicit } }).path, explicit);
    assert.equal(loadPolicy({ policyPath: explicit, teamRoot: dir }).path, explicit);
    assert.equal(loadPolicy({ policyPath: path.join(dir, 'nope.json') }).ok, false);
    fs.writeFileSync(team, '{"version":1,"default":"allow","rules":[]}');
    assert.equal(loadPolicy({ teamRoot: dir }).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
