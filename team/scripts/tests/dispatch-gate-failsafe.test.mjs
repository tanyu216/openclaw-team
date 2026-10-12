#!/usr/bin/env node
/**
 * dispatch-gate-failsafe.test.mjs — T-20261010-190039 / O1: `check-all` is a HEALTH GATE.
 *
 * A gate's whole purpose is to surface failure, so an evaluation that could not be CONFIRMED
 * must FIRE (wake the model / raise the alarm). Reading an unconfirmed gate as `fire:false`
 * reads "unknown" as "green" and silently drops the warning. ACTION jobs (poll / patrol) keep
 * the opposite default — degrade-without-burning — so this file pins BOTH directions to stop
 * the gate's fail-safe from leaking into the action jobs (and vice-versa).
 *
 * O1 had three masking layers, each covered below:
 *   1. exit-code masking (bound-independent) — check-all.sh prints {"ok":false} then `exit $fail`;
 *      judging the exit code alone discarded the gate's own verdict at ANY bound;
 *   2. inner eval-timeout — the gate overran the dispatcher's 8000 ms entry bound;
 *   3. the emission race — install.sh sizes the trigger's exec timeoutSeconds at ceil(budget/1000),
 *      i.e. only ever EQUAL to the inner bound, so a dispatcher that spent the whole budget on the
 *      entry was SIGKILLed with empty stdout and the alarm never left the process.
 *
 * Style: only external boundaries are stubbed — `process.exit` / `process.stdout` for in-process
 * cases, real subprocesses for the rest (same convention as dispatch-eval-timeout.test.mjs).
 *
 * Run: node --test team/scripts/tests/dispatch-gate-failsafe.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { main, entryTimeoutMs, firesOnDegrade, EVAL_EMIT_RESERVE_MS, DEFAULT_EVAL_TIMEOUT_MS } from '../../automations/dispatch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const DISPATCH = path.resolve(HERE, '..', '..', 'automations', 'dispatch.mjs');

const scratchDirs = [];
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

function mkScratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gate-'));
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
/** An entry that never finishes inside the bound. */
const hangCmd = (dir) => `node ${writeEntry(dir, 'hang.mjs', 'setTimeout(() => process.stdout.write("{}"), 30000);\n')}`;

const EXIT = Symbol('dispatch-exit');
/** Call main() in-process, capturing the emitted envelope (process.exit/stdout are boundaries). */
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

// ---- the fail-safe policy itself --------------------------------------------

test('firesOnDegrade: the health gate and the drift detector fail safe; action jobs do not', () => {
  assert.equal(firesOnDegrade('check-all'), true);
  assert.equal(firesOnDegrade('skills-update'), true, 'an unconfirmed drift check must alarm, not read as "nothing moved"');
  assert.equal(firesOnDegrade('poll'), false);
  assert.equal(firesOnDegrade('patrol'), false);
  assert.equal(firesOnDegrade(''), false);
});

test('the default budget is unchanged at 8000 ms, and the entry gets it minus the emission reserve', () => {
  assert.equal(DEFAULT_EVAL_TIMEOUT_MS, 8000, 'the ruled default bound must stay 8000');
  assert.equal(entryTimeoutMs(DEFAULT_EVAL_TIMEOUT_MS), 8000 - EVAL_EMIT_RESERVE_MS);
  assert.ok(entryTimeoutMs(8000) < 8000, 'the entry must not be allowed to consume the whole budget');
  // a tiny bound must not collapse to zero/negative — the reserve is capped at half the budget
  assert.equal(entryTimeoutMs(300), 150);
  assert.equal(entryTimeoutMs(1), 1);
  assert.equal(entryTimeoutMs(0), 1);
});

// ---- layer 1: the gate's own verdict must survive a non-zero exit ------------

test('check-all: non-zero exit WITH an {ok:false} envelope recovers the gate verdict ⇒ fire:true', () => {
  const dir = mkScratch();
  // exactly the shape check-all.sh emits on a red gate: the envelope, then `exit $fail`
  const cmd = entryCmd(dir, 'red.mjs', '{"ok":false,"message":"2 checks failed\\n"}\n', 1);
  const r = capture(['check-all'], { OPENCLAW_TEAM_CHECKALL_CMD: cmd });
  assert.equal(r.fire, true, 'a red gate behind a non-zero exit must still fire');
  assert.equal(r.state.reason, 'gate-failed');
  assert.equal(r.state.exit, 1);
  assert.match(r.message, /2 checks failed/);
});

test('check-all: non-zero exit WITHOUT a usable envelope ⇒ fire:true (never silent)', () => {
  const dir = mkScratch();
  const r = capture(['check-all'], { OPENCLAW_TEAM_CHECKALL_CMD: entryCmd(dir, 'boom.mjs', '', 3) });
  assert.equal(r.fire, true);
  assert.equal(r.state.reason, 'exec-failed');
  assert.equal(r.state.exit, 3);
  assert.match(r.message, /exec-failed/);
});

test('check-all: a non-zero exit whose envelope says ok:true is still UNCONFIRMED ⇒ fire:true', () => {
  const dir = mkScratch();
  const r = capture(['check-all'], { OPENCLAW_TEAM_CHECKALL_CMD: entryCmd(dir, 'odd.mjs', '{"ok":true}\n', 7) });
  assert.equal(r.fire, true, 'an unexplained non-zero exit must not be read as green');
  assert.equal(r.state.reason, 'exec-failed');
});

// ---- layer 2: every degrade path, on the gate, alarms ------------------------

test('check-all: eval-timeout ⇒ fire:true with an alarm message', () => {
  const dir = mkScratch();
  const r = capture(['check-all'], { OPENCLAW_TEAM_EVAL_TIMEOUT_MS: '300', OPENCLAW_TEAM_CHECKALL_CMD: hangCmd(dir) });
  assert.equal(r.fire, true);
  assert.equal(r.state.reason, 'eval-timeout');
  assert.equal(r.state.timeoutMs, 150, 'the reported bound is the effective entry bound');
  assert.equal(r.state.evalTimeoutMs, 300, 'the budget itself is still reported');
  assert.match(r.message, /gate UNCONFIRMED/);
});

test('check-all: unparseable output ⇒ fire:true', () => {
  const dir = mkScratch();
  const r = capture(['check-all'], { OPENCLAW_TEAM_CHECKALL_CMD: entryCmd(dir, 'junk.mjs', 'not json\n') });
  assert.equal(r.fire, true);
  assert.equal(r.state.reason, 'parse-failed');
  assert.match(r.message, /parse-failed/);
});

test('check-all: spawn-error ⇒ fire:true', () => {
  const r = capture(['check-all'], { OPENCLAW_TEAM_CHECKALL_CMD: 'no-such-binary-xyz check-all' });
  assert.equal(r.fire, true);
  assert.equal(r.state.reason, 'spawn-error');
});

test('check-all: an envelope with no verdict field ⇒ fire:true', () => {
  const dir = mkScratch();
  const r = capture(['check-all'], { OPENCLAW_TEAM_CHECKALL_CMD: entryCmd(dir, 'nofire.mjs', '{"checkedAt":"x"}\n') });
  assert.equal(r.fire, true);
  assert.equal(r.state.reason, 'no-fire-field');
});

test('check-all: a missing/invalid provider config ⇒ fire:true (the gate could not run at all)', () => {
  const r = capture(['check-all'], { OPENCLAW_TEAM_TASK_PROVIDER: 'no-such-provider' });
  assert.equal(r.fire, true);
  assert.equal(r.state.reason, 'provider-not-found');
});

// ---- the gate's normal (confirmed) behaviour is unchanged -------------------

test('check-all: ok:true ⇒ fire:false (a confirmed-green gate stays quiet)', () => {
  const dir = mkScratch();
  const r = capture(['check-all'], { OPENCLAW_TEAM_CHECKALL_CMD: entryCmd(dir, 'ok.mjs', '{"ok":true,"checkedAt":"x"}\n') });
  assert.equal(r.fire, false);
  assert.equal(r.state.reason, undefined, 'a clean pass is not a degrade');
});

test('check-all: ok:false with exit 0 ⇒ fire:true (the pre-existing contract still holds)', () => {
  const dir = mkScratch();
  assert.equal(capture(['check-all'], { OPENCLAW_TEAM_CHECKALL_CMD: entryCmd(dir, 'o0.mjs', '{"ok":false}\n') }).fire, true);
});

// ---- regression guard: action jobs keep degrade-without-burning --------------

test('poll/patrol: the SAME degrade paths stay fire:false (fail-safe must not leak)', () => {
  const dir = mkScratch();
  const cases = [
    ['poll', 'OPENCLAW_TEAM_POLL_CMD', entryCmd(dir, 'p-exit.mjs', '', 3), 'exec-failed'],
    ['poll', 'OPENCLAW_TEAM_POLL_CMD', entryCmd(dir, 'p-junk.mjs', 'not json\n'), 'parse-failed'],
    ['poll', 'OPENCLAW_TEAM_POLL_CMD', entryCmd(dir, 'p-nofire.mjs', '{"nope":1}\n'), 'no-fire-field'],
    ['patrol', 'OPENCLAW_TEAM_PATROL_CMD', entryCmd(dir, 't-exit.mjs', '', 3), 'exec-failed'],
  ];
  for (const [job, envVar, cmd, reason] of cases) {
    const r = capture([job], { [envVar]: cmd });
    assert.equal(r.fire, false, `${job} must not fire on degrade`);
    assert.equal(r.state.reason, reason);
    assert.equal(r.message, undefined, 'a non-firing degrade carries no alarm message');
  }
  const hung = capture(['poll'], { OPENCLAW_TEAM_EVAL_TIMEOUT_MS: '300', OPENCLAW_TEAM_POLL_CMD: hangCmd(dir) });
  assert.equal(hung.fire, false);
  assert.equal(hung.state.reason, 'eval-timeout');
});

test('poll: a red-looking entry that exits 0 still fires (the exit-code fix is gate-scoped)', () => {
  const dir = mkScratch();
  // poll's envelope carries {fire}; only the gate recovers an {ok:false} verdict from the shape
  const r = capture(['poll', 'linus'], { OPENCLAW_TEAM_POLL_CMD: entryCmd(dir, 'p-claim.mjs', '{"fire":true,"message":"1 card"}\n') });
  assert.equal(r.fire, true);
  assert.equal(r.message, '1 card');
});

// ---- layer 3: the verdict must survive the caller's own bound ----------------

/**
 * Run the dispatcher as the Gateway trigger does — under a hard wall-clock kill at the
 * evaluation budget (install.sh gives exec() timeoutSeconds = ceil(budget/1000)) — and report
 * whether the {fire} envelope reached stdout before the kill.
 */
function runUnderBound(killMs, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [DISPATCH, 'check-all'], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, killMs);
    p.on('exit', () => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); } catch { parsed = null; }
      resolve({ out: out.trim(), parsed });
    });
  });
}

test('the dispatcher emits its decision INSIDE the caller\'s own bound (emission reserve)', async () => {
  const dir = mkScratch();
  const budget = 1200; // small budget keeps the test fast; the wiring is what is under test
  const killed = await runUnderBound(budget, { OPENCLAW_TEAM_EVAL_TIMEOUT_MS: String(budget), OPENCLAW_TEAM_CHECKALL_CMD: hangCmd(dir) });
  // Without the reserve this is `out === ''` (SIGKILLed mid-flight) ⇒ the alarm is lost at the
  // trigger layer no matter what the dispatcher decided to say.
  assert.notEqual(killed.out, '', 'the dispatcher must print inside the caller\'s bound');
  assert.equal(killed.parsed?.fire, true, 'the gate alarm must reach stdout before the outer kill');
  assert.equal(killed.parsed?.state?.reason, 'eval-timeout');
});
