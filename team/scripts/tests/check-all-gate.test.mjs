#!/usr/bin/env node
/**
 * check-all-gate.test.mjs — T-20261013-031036: the `team-check-all` gate stays inside the
 * dispatcher's evaluation budget WITHOUT dropping coverage.
 *
 * The gate is ~15-20 s while the trigger evaluation is bounded at 8000 ms (entry 7500 ms),
 * so the evaluation used to end in `eval-timeout` every hour — fail-safe ⇒ `fire:true`
 * hourly — and the timeout envelope carried no verdict, masking a genuinely red gate.
 * Raising the bound is not available (exec helper `yieldMs` cap < gate wall clock,
 * AUTOMATIONS.md §3.5).
 *
 * Covered here:
 *   - `check-all.sh --segment fast|slow|all` splits the gate; the fast segment is the
 *     in-band verdict and the slow suite is the ONLY thing left out of it (coverage intact:
 *     the fast verdict is unaffected by a failing slow test);
 *   - a red fast segment yields `ok:false` WITH the failing steps in `message`/`failed[]`
 *     (the masking fix), and the dispatcher can forward it;
 *   - the gate folds in the cached slow verdict and FAILS CLOSED: missing / stale /
 *     unreadable cache ⇒ unconfirmed ⇒ red (never green);
 *   - the slow refresh is launched detached, writes the cache, and the next evaluation
 *     reads it — the composed verdict is green exactly when both axes are green;
 *   - a live refresh lock suppresses a second concurrent refresh.
 *
 * Style: pure functions called directly + real subprocesses against a temp "deployed layout"
 * (fixture team dir; the REAL check-all.sh is pointed at it via OPENCLAW_TEAM_ROOT). No
 * provider install required — every heavy step is a stub.
 *
 * Run: node --test team/scripts/tests/check-all-gate.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeVerdict, readSlowCache, isLockLive, fmtAge,
  resolveTeamDir, DEFAULT_SLOW_TTL_MS, DEFAULT_FAST_TIMEOUT_MS,
} from '../check-all-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // <repo>/team/scripts/tests
const SCRIPTS = path.resolve(HERE, '..');                    // <repo>/team/scripts
const GATE = path.join(SCRIPTS, 'check-all-gate.mjs');
const CHECKALL = path.join(SCRIPTS, 'check-all.sh');          // the REAL gate, segmented

const scratch = [];
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });

// ---- pure: freshness classification -----------------------------------------

test('readSlowCache: missing / unparseable / fresh / stale', () => {
  const MISSING = path.join(os.tmpdir(), 'oc-gate-does-not-exist.json');
  assert.equal(readSlowCache(MISSING, 1e12, DEFAULT_SLOW_TTL_MS).status, 'missing');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gate-cache-'));
  scratch.push(dir);
  const f = path.join(dir, 'cache.json');
  fs.writeFileSync(f, 'not json');
  assert.equal(readSlowCache(f, 1e12, DEFAULT_SLOW_TTL_MS).status, 'unparseable');

  const now = 1_000_000_000_000;
  fs.writeFileSync(f, JSON.stringify({ ok: false, at: now - 1000, failed: ['a.test.mjs'] }));
  const fresh = readSlowCache(f, now, DEFAULT_SLOW_TTL_MS);
  assert.equal(fresh.status, 'fresh');
  assert.equal(fresh.ok, false);
  assert.deepEqual(fresh.failed, ['a.test.mjs']);

  // exactly beyond the TTL ⇒ stale
  fs.writeFileSync(f, JSON.stringify({ ok: true, at: now - DEFAULT_SLOW_TTL_MS - 1 }));
  assert.equal(readSlowCache(f, now, DEFAULT_SLOW_TTL_MS).status, 'stale');
  // clock skew (writer slightly ahead of reader) is not staleness
  fs.writeFileSync(f, JSON.stringify({ ok: true, at: now + 5000 }));
  assert.equal(readSlowCache(f, now, DEFAULT_SLOW_TTL_MS).status, 'fresh');
  // checkedAt ISO string is accepted as the timestamp source
  fs.writeFileSync(f, JSON.stringify({ ok: true, checkedAt: new Date(now - 60_000).toISOString() }));
  const viaIso = readSlowCache(f, now, DEFAULT_SLOW_TTL_MS);
  assert.equal(viaIso.status, 'fresh');
  assert.ok(viaIso.ageMs >= 59_000 && viaIso.ageMs <= 61_000, `age from ISO, got ${viaIso.ageMs}`);
});

// ---- pure: the verdict ------------------------------------------------------

const FAST_OK = { ok: true, unconfirmed: false, failed: [] };
const fresh = (o = true, failed = []) => ({ status: 'fresh', ok: o, failed, ageMs: 60_000, at: 0, message: '' });

test('the gate is green ONLY when the fast segment AND a fresh cached slow verdict are green', () => {
  const ok = computeVerdict(FAST_OK, fresh(true));
  assert.equal(ok.ok, true);
  assert.equal(ok.message, undefined, 'a clean pass carries no alarm message');
});

test('a red FAST segment is reported in-band with the failing steps (the masking fix)', () => {
  const v = computeVerdict({ ok: false, unconfirmed: false, failed: ['卡 schema/状态机 check-card', '§引用可解析 lint-refs'] }, fresh(true));
  assert.equal(v.ok, false);
  assert.match(v.message, /check-all gate RED/);
  assert.match(v.message, /check-card/);
  assert.match(v.message, /lint-refs/);
  assert.match(v.message, /PROTOCOL §⑳/, 'the alarm stays actionable');
});

test('an UNCONFIRMED fast segment never reads as green', () => {
  for (const reason of ['fast-timeout', 'spawn-error', 'fast-unparseable', 'fast-nonzero-exit']) {
    const v = computeVerdict({ ok: false, unconfirmed: true, reason, failed: [] }, fresh(true));
    assert.equal(v.ok, false, reason);
    assert.match(v.message, /fast segment UNCONFIRMED/);
    assert.match(v.message, new RegExp(reason));
  }
});

test('the slow axis FAILS CLOSED: missing / stale / unreadable ⇒ red, never green', () => {
  const missing = computeVerdict(FAST_OK, { status: 'missing', ok: false, failed: [], ageMs: Infinity });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /slow suite UNCONFIRMED: no cached verdict yet/);

  const stale = computeVerdict(FAST_OK, { status: 'stale', ok: true, failed: [], ageMs: 5 * 3600_000 });
  assert.equal(stale.ok, false, 'a stale green cache is UNCONFIRMED — the refresh did not land');
  assert.match(stale.message, /slow suite UNCONFIRMED/);
  assert.match(stale.message, /5h/, `age is reported, got: ${stale.message}`);

  const unreadable = computeVerdict(FAST_OK, { status: 'unparseable', ok: false, failed: [], ageMs: Infinity });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.message, /unreadable/);
});

test('a RED slow verdict fires and names the failing test files', () => {
  const v = computeVerdict(FAST_OK, { status: 'fresh', ok: false, ageMs: 60_000, failed: ['frontmatter 幂等/写卡护栏 测试'], failedFiles: ['projects-delegation.test.mjs', 'scan-deps.test.mjs'] });
  assert.equal(v.ok, false);
  assert.match(v.message, /slow suite RED/);
  assert.match(v.message, /projects-delegation\.test\.mjs/);
  assert.match(v.message, /scan-deps\.test\.mjs/);
});

test('a RED slow verdict falls back to the step label when no failing file was parsed', () => {
  const v = computeVerdict(FAST_OK, { status: 'fresh', ok: false, ageMs: 60_000, failed: ['frontmatter 幂等/写卡护栏 测试'], failedFiles: [] });
  assert.equal(v.ok, false);
  assert.match(v.message, /frontmatter 幂等\/写卡护栏 测试/);
});

test('fmtAge is bounded and human readable', () => {
  assert.equal(fmtAge(30_000), '<1m');
  assert.equal(fmtAge(5 * 60_000), '5m');
  assert.equal(fmtAge(90 * 60_000), '1h30m');
  assert.equal(fmtAge(Infinity), 'unknown');
});

// ---- pure: refresh lock ------------------------------------------------------

test('isLockLive: our own live pid is in-flight; a dead pid or an over-age lock is not', () => {
  const now = Date.now();
  assert.equal(isLockLive({ pid: process.pid, startedAt: now - 1000 }, now, 20 * 60_000), true);
  assert.equal(isLockLive({ pid: 999_999_999, startedAt: now - 1000 }, now, 20 * 60_000), false, 'dead pid');
  assert.equal(isLockLive({ pid: process.pid, startedAt: now - 30 * 60_000 }, now, 20 * 60_000), false, 'over-age lock');
  assert.equal(isLockLive(null, now, 20 * 60_000), false);
});

test('resolveTeamDir: env override wins, else the deployed layout (this file\'s parent)', () => {
  assert.equal(resolveTeamDir({ OPENCLAW_TEAM_ROOT: '/tmp/x' }), '/tmp/x');
  assert.equal(resolveTeamDir({}), path.resolve(SCRIPTS, '..'));
});

// ---- integration: a temp "deployed layout" ----------------------------------

const OK_STUB = 'process.exit(0);\n';
const FAST_STEPS = [
  'scripts/check-redlines.mjs', 'scripts/lint-impl-names.mjs', 'scripts/lint-refs.mjs',
  'scripts/scan-deps.mjs', 'scripts/check-handoff.mjs', 'scripts/check-relations.mjs',
  'scripts/check-idem.mjs', 'scripts/check-sessions.mjs', 'scripts/archive.mjs',
  'skills/task-ops/tests/contract.test.mjs', 'skills/task-ops/tests/terminal-guard.test.mjs',
  'skills/task-ops/tests/projects.test.mjs', 'skills/task-ops/tests/schedule.test.mjs',
];

/**
 * Materialize a team dir that satisfies check-all.sh: the provider lib files exist (so the
 * provider-gated steps run), every step is a stub, and the one slow step is a tiny real
 * node --test file.
 */
function mkFixture({ redStep = null, slowFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gate-fix-'));
  scratch.push(root);
  for (const d of ['scripts', 'scripts/tests', 'skills/task-ops/lib', 'skills/task-ops/tests', 'tasks']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of ['team-paths', 'projects']) fs.writeFileSync(path.join(root, 'skills/task-ops/lib', `${f}.mjs`), '');
  for (const rel of FAST_STEPS) fs.writeFileSync(path.join(root, rel), OK_STUB);
  fs.writeFileSync(path.join(root, redStep || 'scripts/check-card.mjs'),
    redStep ? 'process.stderr.write("boom\\n"); process.exit(1);\n' : OK_STUB);
  fs.writeFileSync(path.join(root, 'scripts/tests/fixture.test.mjs'),
    slowFails
      ? 'import {test} from "node:test";\nimport assert from "node:assert/strict";\ntest("fine", () => {});\ntest("broken", () => { assert.equal(1, 2); });\n'
      : 'import {test} from "node:test";\ntest("fine", () => {});\n');
  return root;
}

/**
 * A stand-in for `check-all.sh` that answers the two segment contracts directly, so the GATE's
 * orchestration (fast in-band, cached slow, detached refresh, fail-closed) is exercised without
 * paying for the real script's ~13 step processes. `checkAllEntry` points OPENCLAW_TEAM_CHECKALL_SH
 * at it. The REAL script's own segmentation is covered by the two `runCheckAll` tests below.
 */
function mkStubCheckAll(root, { fastOk = true, fastFailed = [], slowOk = true, slowFailedFiles = [], slowAt = Date.now() } = {}) {
  const p = path.join(root, 'stub-check-all.sh');
  const fastEnv = JSON.stringify(fastOk
    ? { ok: true, segment: 'fast' }
    : { ok: false, segment: 'fast', failed: fastFailed, message: `check-all(fast) RED: ${fastFailed.join(', ')}` });
  const slowEnv = JSON.stringify({ ok: slowOk, segment: 'slow', at: slowAt, failed: [], slowFailedFiles, message: 'stub' });
  fs.writeFileSync(p, [
    '#!/usr/bin/env bash',
    'set -u',
    'SEG="all"; REPORT=""',
    'while [ $# -gt 0 ]; do case "$1" in --segment) SEG="$2"; shift 2 ;; --report) REPORT="$2"; shift 2 ;; *) shift ;; esac; done',
    `if [ "$SEG" = slow ]; then`,
    `  [ -n "$REPORT" ] && printf '%s\\n' '${slowEnv}' > "$REPORT"`,
    `  printf '%s\\n' '${slowEnv}'`,
    `  exit ${slowOk ? 0 : 1}`,
    'fi',
    `printf '%s\\n' '${fastEnv}'`,
    `exit ${fastOk ? 0 : 1}`,
    '',
  ].join('\n'), { mode: 0o755 });
  return p;
}

/**
 * Child env for a fixture run. OPENCLAW_TEAM_ROOT makes check-all.sh operate on the fixture (its
 * step paths are relative to the team root); OPENCLAW_TEAM_CHECKALL_SH points the gate at the
 * entry under test (the real script, or a stub).
 */
function fixtureEnv(root, { checkall = CHECKALL, ...extra } = {}) {
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: root, OPENCLAW_TEAM_CHECKALL_SH: checkall, ...extra };
  delete env.OPENCLAW_TEAM_REPO;
  delete env.OPENCLAW_TEAM_CHECKALL_CMD;
  // `node --test` sets NODE_TEST_CONTEXT for its children; a NESTED `node --test` that inherits
  // it skips its own files and exits 0 — which would make the fixture's red slow suite look
  // green. The gate itself runs outside the test runner, so this is test-harness hygiene only.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Run the gate CLI; returns {exit, envelope}. */
function runGate(root, extra = {}) {
  try {
    const out = execFileSync(process.execPath, [GATE], { encoding: 'utf8', env: fixtureEnv(root, extra), timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, envelope: JSON.parse(out.trim().split('\n').filter(Boolean).pop()) };
  } catch (e) {
    const out = String(e.stdout || '');
    return { exit: e.status, envelope: JSON.parse(out.trim().split('\n').filter(Boolean).pop()) };
  }
}

/** Run the (real) segmented checkpoint script directly. */
function runCheckAll(root, args) {
  try {
    const out = execFileSync('bash', [CHECKALL, ...args], { encoding: 'utf8', env: fixtureEnv(root), timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, envelope: JSON.parse(out.trim().split('\n').filter(Boolean).pop()) };
  } catch (e) {
    const out = String(e.stdout || '');
    return { exit: e.status, envelope: JSON.parse(out.trim().split('\n').filter(Boolean).pop()) };
  }
}

/** Run a child, capturing stdout/stderr/exit WITHOUT throwing — so a missing envelope is an assertion failure, not a parse crash. */
function runRaw(file, args, env) {
  try {
    const stdout = execFileSync(file, args, { encoding: 'utf8', env, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, stdout, stderr: '' };
  } catch (e) {
    return { exit: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the detached refresh has written the cache. */
async function waitForCache(root, ms = 30_000) {
  const f = path.join(root, '.check-all-slow.json');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* mid-rename */ } }
    await sleep(100);
  }
  throw new Error('slow refresh never wrote the cache');
}

test('check-all.sh --segment fast is green even when the SLOW suite is red (the split holds)', () => {
  const root = mkFixture({ slowFails: true });
  const fast = runCheckAll(root, ['--segment', 'fast']);
  assert.equal(fast.exit, 0);
  assert.equal(fast.envelope.ok, true, 'the failing slow test must not leak into the fast verdict');
  assert.equal(fast.envelope.segment, 'fast');

  // and the slow segment DOES see it, naming the failing file
  const slow = runCheckAll(root, ['--segment', 'slow', '--report', path.join(root, '.check-all-slow.json')]);
  assert.equal(slow.exit, 1);
  assert.equal(slow.envelope.ok, false);
  assert.deepEqual(slow.envelope.failed, ['frontmatter 幂等/写卡护栏 测试']);
  assert.match(slow.envelope.message, /fixture\.test\.mjs/, 'the failing test file is named');
});

test('check-all.sh --segment fast names the failing step in the envelope (message + failed[])', () => {
  const root = mkFixture({ redStep: 'scripts/check-card.mjs' });
  const r = runCheckAll(root, ['--segment', 'fast']);
  assert.equal(r.exit, 1);
  assert.equal(r.envelope.ok, false);
  assert.deepEqual(r.envelope.failed, ['卡 schema/状态机 check-card']);
  assert.match(r.envelope.message, /check-all\(fast\) RED/);
  assert.match(r.envelope.message, /check-card/);
});

test('check-all.sh: bad --segment is a usage error (exit 2), never a silent pass', () => {
  const root = mkFixture();
  for (const args of [['--segment', 'bogus'], ['--bogus']]) {
    let status = 0;
    try { execFileSync('bash', [CHECKALL, ...args], { encoding: 'utf8', env: fixtureEnv(root), stdio: 'pipe' }); }
    catch (e) { status = e.status; }
    assert.equal(status, 2, `${args.join(' ')} must exit 2`);
  }
});

// ---- locale domain: the envelope must survive a UTF-8 locale (T-20261013-045600) ------------
/**
 * On macOS bash 3.2 under a UTF-8 locale, a BARE `$SEGMENT` sitting immediately before a
 * multi-byte character (`（`/`）`) had the multi-byte lead byte folded into the variable name
 * (`SEGMENT\xef…`) ⇒ `set -u` aborted the script BEFORE it printed its `{ok:…}` envelope ⇒ the
 * scheduled path read `fast-unparseable` and a genuinely RED gate was masked (the exact defect
 * this card exists to remove). The three sites are braced now; this pins the envelope under a
 * UTF-8 locale so it cannot silently regress. Coverage: the green branch (L149 pass line), the
 * red branch (L152 fail line) and the usage-error branch (L40) — every site that carried one.
 * Not a skip: a host with no UTF-8 locale fails loudly, because the invariant is unverifiable there.
 */
function utf8Locale() {
  // `C.UTF-8` is accepted by macOS (UTF-8 alias) and glibc alike; `en_US.UTF-8` is the macOS default.
  for (const loc of ['C.UTF-8', 'en_US.UTF-8', 'C.utf8', 'en_US.utf8']) {
    try {
      const out = execFileSync('locale', ['charmap'], { encoding: 'utf8', env: { ...process.env, LC_ALL: loc }, stdio: ['ignore', 'pipe', 'pipe'] });
      if (/UTF-8/i.test(out)) return loc;
    } catch { /* not installed on this host — try the next candidate */ }
  }
  return null;
}

test('UTF-8 locale: check-all.sh still emits its envelope (bash 3.2 multibyte var-name regression)', () => {
  const loc = utf8Locale();
  assert.ok(loc, 'no UTF-8 locale available on this host — the envelope invariant cannot be exercised');
  const env = { LC_ALL: loc, LC_CTYPE: loc, LANG: loc };

  /** The last stdout line must be the envelope — never an `unbound variable` abort. */
  const envelopeOf = (r) => {
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    const last = lines[lines.length - 1] ?? '';
    assert.doesNotMatch(last, /unbound variable/, `check-all.sh died before its envelope under ${loc}`);
    return JSON.parse(last);                       // throws (test fails) if the envelope is absent
  };

  // green branch (L149): `check-all（<seg>）：全部通过` precedes the envelope
  const green = runRaw('bash', [CHECKALL, '--segment', 'fast'], fixtureEnv(mkFixture(), env));
  assert.equal(green.exit, 0, `a green fast segment exited ${green.exit} under ${loc}`);
  assert.equal(envelopeOf(green).ok, true);

  // red branch (L152): `check-all（<seg>）：存在失败项` precedes the envelope — the masking case
  const red = runRaw('bash', [CHECKALL, '--segment', 'fast'], fixtureEnv(mkFixture({ redStep: 'scripts/check-card.mjs' }), env));
  assert.equal(red.exit, 1);
  const redEnvelope = envelopeOf(red);
  assert.equal(redEnvelope.ok, false);
  assert.deepEqual(redEnvelope.failed, ['卡 schema/状态机 check-card'], 'the failing step is still named under a UTF-8 locale');

  // usage-error branch (L40): a clean exit 2, not an unbound-variable death
  const bad = runRaw('bash', [CHECKALL, '--segment', 'bogus'], fixtureEnv(mkFixture(), env));
  assert.equal(bad.exit, 2, `bad --segment exited ${bad.exit} under ${loc}`);
  assert.match(bad.stderr, /未知 --segment/);
});

// ---- the gate's orchestration (stub entry point: exercises the gate, not check-all.sh) ----

/** A gate fixture: a temp team dir plus a stub check-all.sh (see mkStubCheckAll). */
function mkGateRoot(stubOpts = {}, cache = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gate-root-'));
  scratch.push(root);
  if (cache) fs.writeFileSync(path.join(root, '.check-all-slow.json'), JSON.stringify(cache));
  const entry = mkStubCheckAll(root, stubOpts);
  return { root, entry };
}

test('gate: first run has no cache ⇒ UNCONFIRMED (red) and launches the refresh', () => {
  const { root, entry } = mkGateRoot({});
  const { exit, envelope } = runGate(root, { checkall: entry, OPENCLAW_TEAM_CHECKALL_NO_REFRESH: '1' });
  assert.equal(exit, 1, 'an unconfirmed slow axis must not exit 0');
  assert.equal(envelope.ok, false);
  assert.equal(envelope.state.fast.ok, true, 'the fast segment was confirmed green in-band');
  assert.equal(envelope.state.slow.status, 'missing');
  assert.equal(envelope.state.slowRefresh, 'disabled');
  assert.match(envelope.message, /slow suite UNCONFIRMED/);
});

test('gate: refresh lands out of band; the NEXT evaluation is green (fast ∧ fresh slow)', async () => {
  // end-to-end with the REAL check-all.sh: the detached refresh runs the fixture's slow suite
  const root = mkFixture();
  const first = runGate(root);
  assert.equal(first.envelope.state.slow.status, 'missing');
  assert.equal(first.envelope.state.slowRefresh, 'launched', 'the slow suite runs every period, detached');
  assert.equal(first.exit, 1, 'the first run cannot confirm the slow axis yet');

  const cache = await waitForCache(root);
  assert.equal(cache.ok, true);
  assert.equal(cache.segment, 'slow');

  const second = runGate(root, { OPENCLAW_TEAM_CHECKALL_NO_REFRESH: '1' });
  assert.equal(second.exit, 0, 'a confirmed fast+slow green gate stays quiet');
  assert.equal(second.envelope.ok, true);
  assert.equal(second.envelope.message, undefined);
  assert.equal(second.envelope.state.slow.status, 'fresh');
});

test('gate: a slow regression is reported on the next evaluation, naming the file', () => {
  const { root, entry } = mkGateRoot(
    { fastOk: true },
    { ok: false, at: Date.now(), segment: 'slow', failed: ['frontmatter 幂等/写卡护栏 测试'], slowFailedFiles: ['fixture.test.mjs'], message: 'x' },
  );
  const r = runGate(root, { checkall: entry, OPENCLAW_TEAM_CHECKALL_NO_REFRESH: '1' });
  assert.equal(r.exit, 1);
  assert.equal(r.envelope.state.slow.status, 'fresh');
  assert.match(r.envelope.message, /slow suite RED/);
  assert.match(r.envelope.message, /fixture\.test\.mjs/);
});

test('gate: a STALE cache is unconfirmed (fail closed), not a stale green', () => {
  const { root, entry } = mkGateRoot({}, { ok: true, at: Date.now() - 5 * 3600_000, segment: 'slow', failed: [] });
  const r = runGate(root, { checkall: entry, OPENCLAW_TEAM_CHECKALL_NO_REFRESH: '1' });
  assert.equal(r.exit, 1, 'a 5h-old green cache must not pass the gate');
  assert.equal(r.envelope.state.slow.status, 'stale');
  assert.match(r.envelope.message, /slow suite UNCONFIRMED/);
});

test('gate: a live refresh lock suppresses a second concurrent refresh', () => {
  const { root, entry } = mkGateRoot({});
  fs.writeFileSync(path.join(root, '.check-all-slow.lock'),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), report: '' }));
  const r = runGate(root, { checkall: entry, OPENCLAW_TEAM_CHECKALL_NO_REFRESH: '0' });
  assert.equal(r.envelope.state.slowRefresh, 'in-flight');
});

test('gate: a red FAST segment fires in-band and names the step', () => {
  const { root, entry } = mkGateRoot({ fastOk: false, fastFailed: ['卡 schema/状态机 check-card'] });
  const r = runGate(root, { checkall: entry, OPENCLAW_TEAM_CHECKALL_NO_REFRESH: '1' });
  assert.equal(r.exit, 1);
  assert.equal(r.envelope.state.fast.ok, false);
  assert.match(r.envelope.message, /fast RED/);
  assert.match(r.envelope.message, /check-card/);
});

test('gate: a green fast segment + a fresh green cache ⇒ ok:true, exit 0, no message', () => {
  const { root, entry } = mkGateRoot({}, { ok: true, at: Date.now() - 60_000, segment: 'slow', failed: [] });
  const r = runGate(root, { checkall: entry, OPENCLAW_TEAM_CHECKALL_NO_REFRESH: '1' });
  assert.equal(r.exit, 0);
  assert.equal(r.envelope.ok, true);
  assert.equal(r.envelope.message, undefined);
  assert.equal(r.envelope.state.fast.ok, true);
  assert.equal(r.envelope.state.slow.status, 'fresh');
});

// ---- the SCHEDULED path end to end: dispatcher ⇒ gate ⇒ {fire, message} ------

const DISPATCH = path.resolve(SCRIPTS, '..', 'automations', 'dispatch.mjs');

/** Run the real dispatcher with the gate as the check-all entry. */
function runDispatch(root, entry) {
  const env = fixtureEnv(root, {
    checkall: entry,
    OPENCLAW_TEAM_CHECKALL_CMD: `node ${GATE}`,
    OPENCLAW_TEAM_CHECKALL_NO_REFRESH: '1',
  });
  const out = execFileSync(process.execPath, [DISPATCH, 'check-all'], { encoding: 'utf8', env, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

test('scheduled path: a confirmed-green gate stays quiet; a red gate fires WITH the failing items', () => {
  const green = mkGateRoot({}, { ok: true, at: Date.now(), segment: 'slow', failed: [] });
  const quiet = runDispatch(green.root, green.entry);
  assert.equal(quiet.fire, false, 'ok:true must keep fire:false (no model wake)');

  const red = mkGateRoot({}, { ok: false, at: Date.now(), segment: 'slow', failed: ['frontmatter 幂等/写卡护栏 测试'], slowFailedFiles: ['projects-delegation.test.mjs'] });
  const fired = runDispatch(red.root, red.entry);
  assert.equal(fired.fire, true, 'a red gate must fire');
  assert.match(fired.message, /projects-delegation\.test\.mjs/, 'the alarm names the failing item — a timeout/degrade must not mask it');
  assert.equal(fired.state.slow.ok, false);
});
