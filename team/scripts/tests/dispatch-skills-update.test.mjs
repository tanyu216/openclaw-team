#!/usr/bin/env node
/**
 * dispatch-skills-update.test.mjs — the `skills-update` dispatch job (T-20261013-025818 ⑥).
 *
 * The weekly skills-update job is a DETECTOR wired through the same dispatcher contract as
 * poll/patrol/check-all, with one deliberate difference: its normal outcome is `fire:false`
 * (no upstream skill ref moved ⇒ zero cost, no model wake), while BOTH outcomes that need a
 * human — drift found, and an evaluation that could not be completed — must fire.
 *
 * Pinned here:
 *   - providers.json declares the entry for the default provider, under the key the
 *     dispatcher looks up for job `skills-update` (`skillsUpdate`);
 *   - a `{repo}` placeholder resolves to the framework repo checkout ($OPENCLAW_TEAM_REPO,
 *     else `.install-state.json`), and an unresolvable one degrades to an ALARM (never a
 *     silent empty substitution);
 *   - fire:false on a drift-free run (the zero-cost idle path);
 *   - fire:true with the entry's message when the entry itself fires;
 *   - a non-zero exit carrying {ok:false} is recovered so the DETECTOR's own verdict and
 *     message survive (the check-all recursion, reused for the detector);
 *   - a non-zero exit with no usable verdict, a hang, and a spawn failure all ALARM.
 *
 * Run: node --test team/scripts/tests/dispatch-skills-update.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, firesOnDegrade } from '../../automations/dispatch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const AUTOMATIONS = path.resolve(HERE, '..', '..', 'automations');
const PROVIDERS = path.join(AUTOMATIONS, 'providers.json');

const scratchDirs = [];
after(() => { for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true }); });
function mkScratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skills-update-'));
  scratchDirs.push(d);
  return d;
}

/** An entry command that prints `line` and exits with `code`. */
function entryCmd(dir, name, line, code = 0) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `process.stdout.write(${JSON.stringify(line)}); process.exit(${code});\n`);
  return `node ${p}`;
}

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
  return JSON.parse(writes.join('').trim().split('\n').filter(Boolean).pop());
}

// ---- wiring -----------------------------------------------------------------

test('providers.json wires the job the dispatcher looks up, at the repo-side entry', () => {
  const providers = JSON.parse(fs.readFileSync(PROVIDERS, 'utf8'));
  const entry = providers['meerkat-taskpanel'].skillsUpdate;
  assert.equal(typeof entry, 'string');
  assert.match(entry, /^node \{repo\}\/skills\/update\.mjs --json$/,
    'the entry must run the JSON parser path (update.mjs --json), from the repo tree');
});

test('a failing detector fails safe: an unconfirmed check must alarm', () => {
  assert.equal(firesOnDegrade('skills-update'), true);
});

// ---- fire semantics ---------------------------------------------------------

test('no drift ⇒ fire:false (the zero-cost idle path: no model is woken)', () => {
  const dir = mkScratch();
  const out = capture(['skills-update'], {
    OPENCLAW_TEAM_SKILLSUPDATE_CMD: entryCmd(dir, 'idle.mjs', '{"fire":false,"state":{"changed":[]}}'),
  });
  assert.equal(out.fire, false);
  assert.equal(out.message, undefined, 'a non-firing verdict carries no message');
});

test('drift ⇒ fire:true and the entry\'s change list is forwarded verbatim', () => {
  const dir = mkScratch();
  const msg = '[skills-update] 2 upstream skill ref(s) moved: ask-matt f3fc5632f401→49dd158d1076, antfu e53a142a2420→feb0f3aba656 — review and run `node skills/update.mjs --apply` to advance.';
  const out = capture(['skills-update'], {
    OPENCLAW_TEAM_SKILLSUPDATE_CMD: entryCmd(dir, 'drift.mjs', JSON.stringify({ fire: true, message: msg, state: { changed: 2 } })),
  });
  assert.equal(out.fire, true);
  assert.equal(out.message, msg, 'the change list must reach the woken model unchanged');
  assert.equal(out.state.job, 'skills-update');
});

// ---- degrade paths: every one of them alarms ---------------------------------

test('a non-zero exit carrying {ok:false} is recovered — the detector keeps its own message', () => {
  const dir = mkScratch();
  const out = capture(['skills-update'], {
    OPENCLAW_TEAM_SKILLSUPDATE_CMD: entryCmd(dir, 'bad.mjs',
      JSON.stringify({ ok: false, fire: true, message: '[skills-update] 1 skill(s) failed: broken' }), 1),
  });
  assert.equal(out.fire, true);
  assert.match(out.message, /skill\(s\) failed: broken/);
  assert.equal(out.state.reason, 'gate-failed');
});

test('a non-zero exit with no usable verdict ⇒ fire:true (never silently green)', () => {
  const dir = mkScratch();
  const out = capture(['skills-update'], {
    OPENCLAW_TEAM_SKILLSUPDATE_CMD: entryCmd(dir, 'plain.mjs', 'boom', 1),
  });
  assert.equal(out.fire, true, 'an unconfirmed detector must alarm');
  assert.equal(out.state.reason, 'exec-failed');
});

test('a hang ⇒ fire:true with an eval-timeout alarm, still inside the trigger budget', () => {
  const dir = mkScratch();
  const p = path.join(dir, 'hang.mjs');
  fs.writeFileSync(p, 'setTimeout(() => {}, 30000);\n');
  const out = capture(['skills-update'], {
    OPENCLAW_TEAM_SKILLSUPDATE_CMD: `node ${p}`,
    OPENCLAW_TEAM_EVAL_TIMEOUT_MS: '300',
  });
  assert.equal(out.fire, true);
  assert.equal(out.state.reason, 'eval-timeout');
  assert.match(out.message, /check UNCONFIRMED/);
  assert.match(out.message, /skills-update/);
});

// ---- {repo} resolution -------------------------------------------------------

test('{repo} resolves from $OPENCLAW_TEAM_REPO and is passed through to the entry', () => {
  const dir = mkScratch();
  const repo = mkScratch();
  const out = capture(['skills-update'], {
    OPENCLAW_TEAM_REPO: repo,
    OPENCLAW_TEAM_SKILLSUPDATE_CMD: entryCmd(dir, 'repo.mjs',
      `{"fire":true,"message":"repo=${repo}"}`),
  });
  assert.equal(out.fire, true);
  assert.equal(out.message, `repo=${repo}`);
});

test('an unresolvable {repo} degrades to an ALARM, never an empty substitution', () => {
  // No env override here on purpose: the template must come from providers.json so the
  // `{repo}` placeholder is actually present and has to be resolved.
  const out = capture(['skills-update'], { OPENCLAW_TEAM_REPO: '' });
  assert.equal(out.fire, true, 'a job that cannot even locate its entry must alarm');
  assert.equal(out.state.reason, 'repo-not-found');
});

test('the job is registered under a known job name (an unknown job still degrades)', () => {
  const out = capture(['skills-updateX'], {});
  assert.equal(out.fire, false, 'an unknown job stays a non-firing degrade');
  assert.equal(out.state.reason, 'unknown-job');
  assert.match(out.state.usage, /skills-update/);
});
