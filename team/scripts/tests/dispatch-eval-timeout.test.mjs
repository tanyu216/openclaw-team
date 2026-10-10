#!/usr/bin/env node
/**
 * dispatch-eval-timeout.test.mjs — ③ + ④: the framework dispatcher is
 * degrade-without-burning AND its trigger evaluation is BOUNDED.
 *
 * Covered:
 *   - the {fire:false} envelope for a missing provider / missing entry / missing
 *     providers.json / unparseable output / non-zero exit (never throws, exit 0);
 *   - OPENCLAW_TEAM_EVAL_TIMEOUT_MS parsing (positive wins, anything else ⇒ default);
 *   - a hung provider entry degrades to `eval-timeout` instead of stalling the
 *     Gateway's trigger evaluation.
 *
 * Style: only external boundaries are stubbed — `process.exit` / `process.stdout`
 * (process control + I/O) for the in-process cases, real subprocesses for the rest.
 * No internal function is mocked; the entry commands the dispatcher runs are real
 * `node` processes in a temp dir.
 *
 * Run: node --test team/scripts/tests/dispatch-eval-timeout.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { main, resolveEvalTimeoutMs, DEFAULT_EVAL_TIMEOUT_MS } from '../../automations/dispatch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const REPO = path.resolve(HERE, '..', '..', '..');          // <repo>

const scratchDirs = [];
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

function mkScratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-dispatch-'));
  scratchDirs.push(d);
  return d;
}
function writeEntry(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}
/** An entry command that prints `line` on stdout and exits with `code`. */
const entryCmd = (dir, name, line, code = 0) =>
  `node ${writeEntry(dir, name, `process.stdout.write(${JSON.stringify(line)}); process.exit(${code});\n`)}`;

const EXIT = Symbol('dispatch-exit');
/**
 * Call main() in-process, capturing the emitted envelope. `process.exit`/stdout are
 * external boundaries, so they are stubbed here; everything else is real.
 */
function capture(argv, env) {
  const writes = [];
  const origWrite = process.stdout.write;
  const origExit = process.exit;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.exit = () => { throw EXIT; };
  try {
    main(argv, env);
    assert.fail('main() must terminate the process');
  } catch (e) {
    if (e !== EXIT) throw e;
  } finally {
    process.stdout.write = origWrite;
    process.exit = origExit;
  }
  const last = writes.join('').trim().split('\n').filter(Boolean).pop();
  return JSON.parse(last);
}

// ---- ③ timeout resolution ---------------------------------------------------

test('resolveEvalTimeoutMs: positive wins, everything else falls back to the default', () => {
  assert.equal(DEFAULT_EVAL_TIMEOUT_MS, 8000);
  assert.equal(resolveEvalTimeoutMs(undefined), 8000);
  assert.equal(resolveEvalTimeoutMs(null), 8000);
  assert.equal(resolveEvalTimeoutMs(''), 8000);
  assert.equal(resolveEvalTimeoutMs('   '), 8000);
  assert.equal(resolveEvalTimeoutMs('abc'), 8000);
  assert.equal(resolveEvalTimeoutMs('0'), 8000);
  assert.equal(resolveEvalTimeoutMs('-5'), 8000);
  assert.equal(resolveEvalTimeoutMs('Infinity'), 8000);
  assert.equal(resolveEvalTimeoutMs('2500'), 2500);
  assert.equal(resolveEvalTimeoutMs(' 1200 '), 1200);
  assert.equal(resolveEvalTimeoutMs('8000.9'), 8000);
});

test('the effective evaluation bound is reported in state and follows the env', () => {
  assert.equal(capture(['bogus'], {}).state.evalTimeoutMs, 8000);
  assert.equal(capture(['bogus'], { OPENCLAW_TEAM_EVAL_TIMEOUT_MS: '1234' }).state.evalTimeoutMs, 1234);
  assert.equal(capture(['bogus'], { OPENCLAW_TEAM_EVAL_TIMEOUT_MS: 'oops' }).state.evalTimeoutMs, 8000);
});

// ---- degrade-without-burning (④-2) ------------------------------------------

test('unknown job ⇒ fire:false (never throws)', () => {
  const r = capture(['not-a-job'], {});
  assert.equal(r.fire, false);
  assert.equal(r.state.reason, 'unknown-job');
});

test('provider not configured ⇒ fire:false', () => {
  const r = capture(['poll', 'linus'], { OPENCLAW_TEAM_TASK_PROVIDER: 'no-such-provider' });
  assert.equal(r.fire, false);
  assert.equal(r.state.reason, 'provider-not-found');
  assert.equal(r.state.provider, 'no-such-provider');
});

test('entry not configured for the job ⇒ fire:false', () => {
  const dir = mkScratch();
  const team = path.join(dir, 'team');
  fs.mkdirSync(path.join(team, 'automations'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'team/automations/dispatch.mjs'), path.join(team, 'automations/dispatch.mjs'));
  // provider present, but it declares no `poll` entry
  fs.writeFileSync(path.join(team, 'automations/providers.json'), JSON.stringify({ 'meerkat-taskpanel': { patrol: 'node x' } }), 'utf8');
  const out = execFileSync(process.execPath, [path.join(team, 'automations/dispatch.mjs'), 'poll', 'linus'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TEAM_POLL_CMD: '' },
  });
  const r = JSON.parse(out.trim());
  assert.equal(r.fire, false);
  assert.equal(r.state.reason, 'entry-not-configured');
  assert.equal(r.state.jobKey, 'poll');
});

// ---- legacy-name-compat: the pre-rebrand provider name/key still resolves -----
// (bidirectional: an old OPENCLAW_TEAM_TASK_PROVIDER value AND an old providers.json key)
/** A scratch team dir whose providers.json holds the entry under `key` (a provider name). */
function scratchTeam(key) {
  const dir = mkScratch();
  const team = path.join(dir, 'team');
  fs.mkdirSync(path.join(team, 'automations'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'team/automations/dispatch.mjs'), path.join(team, 'automations/dispatch.mjs'));
  const cmd = entryCmd(dir, 'entry.mjs', '{"fire":true,"message":"aliased"}\n');
  fs.writeFileSync(path.join(team, 'automations/providers.json'), JSON.stringify({ [key]: { poll: cmd } }), 'utf8');
  return { team };
}

test('legacy provider env value resolves against the renamed providers.json key', () => {
  const { team } = scratchTeam('meerkat-taskpanel');
  const out = execFileSync(process.execPath, [path.join(team, 'automations/dispatch.mjs'), 'poll', 'linus'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TEAM_POLL_CMD: '', OPENCLAW_TEAM_TASK_PROVIDER: 'task-panel' }, // legacy-name-compat env value
  });
  const r = JSON.parse(out.trim());
  assert.equal(r.fire, true);
  assert.equal(r.message, 'aliased');
  assert.equal(r.state.provider, 'meerkat-taskpanel'); // resolved to the canonical key
});

test('renamed default provider resolves against a pre-rebrand providers.json key', () => {
  const { team } = scratchTeam('task-panel'); // legacy-name-compat key
  const env = { ...process.env, OPENCLAW_TEAM_POLL_CMD: '' };
  delete env.OPENCLAW_TEAM_TASK_PROVIDER; // no override ⇒ the (renamed) default provider name
  const out = execFileSync(process.execPath, [path.join(team, 'automations/dispatch.mjs'), 'poll', 'linus'], {
    encoding: 'utf8', env,
  });
  const r = JSON.parse(out.trim());
  assert.equal(r.fire, true);
  assert.equal(r.message, 'aliased');
  assert.equal(r.state.provider, 'task-panel'); // legacy-name-compat: resolved to the legacy key that exists
});

test('unparseable provider output ⇒ fire:false', () => {
  const dir = mkScratch();
  const r = capture(['poll', 'linus'], { OPENCLAW_TEAM_POLL_CMD: entryCmd(dir, 'junk.mjs', 'not json\n') });
  assert.equal(r.fire, false);
  assert.equal(r.state.reason, 'parse-failed');
});

test('non-zero exit ⇒ fire:false', () => {
  const dir = mkScratch();
  const r = capture(['poll', 'linus'], { OPENCLAW_TEAM_POLL_CMD: entryCmd(dir, 'boom.mjs', '', 3) });
  assert.equal(r.fire, false);
  assert.equal(r.state.reason, 'exec-failed');
  assert.equal(r.state.exit, 3);
});

test('missing providers.json ⇒ fire:false (exit 0), via the real CLI', () => {
  const dir = mkScratch();
  const team = path.join(dir, 'team');
  fs.mkdirSync(path.join(team, 'automations'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'team/automations/dispatch.mjs'), path.join(team, 'automations/dispatch.mjs'));
  // no providers.json written on purpose
  const out = execFileSync(process.execPath, [path.join(team, 'automations/dispatch.mjs'), 'poll', 'linus'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TEAM_POLL_CMD: '' },
  });
  const r = JSON.parse(out.trim());
  assert.equal(r.fire, false);
  assert.equal(r.state.reason, 'providers.json-missing-or-invalid');
});

test('agent placeholder without an agent / empty entry / unrunnable binary all degrade', () => {
  assert.equal(capture(['poll', ''], { OPENCLAW_TEAM_POLL_CMD: 'node {agent}' }).state.reason, 'agent-required');
  assert.equal(capture(['poll', 'linus'], { OPENCLAW_TEAM_POLL_CMD: "''" }).state.reason, 'empty-entry');
  assert.equal(capture(['poll', 'linus'], { OPENCLAW_TEAM_POLL_CMD: 'no-such-binary-xyz poll' }).state.reason, 'spawn-error');
});

// ---- normalization -----------------------------------------------------------

test('{fire} / {stale} / {ok} envelopes normalize to the same decision', () => {
  const dir = mkScratch();
  const fire = capture(['poll', 'linus'], { OPENCLAW_TEAM_POLL_CMD: entryCmd(dir, 'f.mjs', '{"fire":true,"message":"hi"}\n') });
  assert.equal(fire.fire, true);
  assert.equal(fire.message, 'hi');
  assert.equal(fire.state.job, 'poll');

  const stale = capture(['patrol'], { OPENCLAW_TEAM_PATROL_CMD: entryCmd(dir, 's.mjs', '{"stale":["T-1"]}\n') });
  assert.equal(stale.fire, true);
  assert.match(stale.message, /stale/);

  assert.equal(capture(['check-all'], { OPENCLAW_TEAM_CHECKALL_CMD: entryCmd(dir, 'o1.mjs', '{"ok":false}\n') }).fire, true);
  assert.equal(capture(['check-all'], { OPENCLAW_TEAM_CHECKALL_CMD: entryCmd(dir, 'o2.mjs', '{"ok":true}\n') }).fire, false);
  assert.equal(capture(['poll', 'linus'], { OPENCLAW_TEAM_POLL_CMD: entryCmd(dir, 'n.mjs', '{"nope":1}\n') }).state.reason, 'no-fire-field');
});

test('quoted entries (paths with spaces) tokenize correctly; long/empty output degrades', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-dispatch quoted-'));
  scratchDirs.push(dir);
  const script = writeEntry(dir, 'quoted entry.mjs', 'process.stdout.write("{\\"fire\\":true,\\"message\\":\\"spaced\\"}\\n");\n');
  // single- and double-quoted spellings of the same path must both work (no shell is used)
  assert.equal(capture(['poll', 'linus'], { OPENCLAW_TEAM_POLL_CMD: `node "${script}"` }).message, 'spaced');
  assert.equal(capture(['poll', 'linus'], { OPENCLAW_TEAM_POLL_CMD: `node '${script}'` }).message, 'spaced');

  const empty = mkScratch();
  assert.equal(capture(['poll', 'linus'], { OPENCLAW_TEAM_POLL_CMD: entryCmd(empty, 'silent.mjs', '') }).state.reason, 'parse-failed');

  const noisy = mkScratch();
  const r = capture(['poll', 'linus'], { OPENCLAW_TEAM_POLL_CMD: entryCmd(noisy, 'noisy.mjs', 'x'.repeat(5000) + '\n') });
  assert.equal(r.state.reason, 'parse-failed');
  assert.ok(r.state.stdout.length <= 300, 'degraded state must carry a bounded output tail');
});

// ---- ③ the bound actually fires ---------------------------------------------

test('a hung entry degrades to eval-timeout instead of stalling the evaluation', () => {
  const dir = mkScratch();
  // a real entry that never finishes within the bound
  const sleeper = writeEntry(dir, 'hang.mjs', 'setTimeout(() => process.stdout.write("{}"), 30000);\n');
  const t0 = Date.now();
  const r = capture(['poll', 'linus'], {
    OPENCLAW_TEAM_EVAL_TIMEOUT_MS: '300',
    OPENCLAW_TEAM_POLL_CMD: `node ${sleeper}`,
  });
  const elapsed = Date.now() - t0;
  assert.equal(r.fire, false);
  assert.equal(r.state.reason, 'eval-timeout');
  // the entry gets the budget minus the emission reserve (T-20261010-190039): a 300 ms budget
  // leaves the entry 150 ms, so the verdict still lands inside the caller's own 300 ms bound.
  assert.equal(r.state.timeoutMs, 150);
  assert.equal(r.state.evalTimeoutMs, 300);
  assert.ok(elapsed < 10000, `must return promptly, took ${elapsed}ms`);
});
