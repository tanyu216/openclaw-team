#!/usr/bin/env node
/**
 * scan-deps.test.mjs — T-20261010-042500-depsgate-team
 *
 * Behavioural tests for scan-deps.mjs (dependency CVE gate, check-all warn layer).
 * All fixtures are local (mkdtemp) — no network, no real scanner required:
 *   - a "no scanner" environment is a PATH pointing at an empty dir;
 *   - a scanner is simulated by a fake `osv-scanner` on PATH that prints OSV JSON.
 *
 * Contract under test (team/guides/dependency-cve-gate.md §3.2 / §4.1):
 *   - default (warn)        : exit 0 even with Critical/High hits;
 *   - SCAN_STRICT=1         : exit non-zero iff a Critical/High (CVSS >= 7.0) hit exists;
 *   - offline / no scanner  : print SKIP, exit 0;
 *   - deterministic         : same input => byte-identical stdout.
 *
 * Run: node --test team/scripts/tests/scan-deps.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const SCRIPT = path.resolve(HERE, '..', 'scan-deps.mjs');

// ── fixtures ────────────────────────────────────────────────────────────────

function tmp(prefix = 'scan-deps-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A target directory that "contains a lockfile" so scan-deps treats it as scannable. */
function lockfileTarget(root, name = 'package-lock.json') {
  const dir = path.join(root, 'pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), '{}\n');
  return dir;
}

/** osv-scanner-shaped JSON with one finding of the given severity. */
function osvJson(severity, id = `GHSA-test-${severity.toLowerCase()}`) {
  return JSON.stringify({
    results: [{
      source: { path: 'package-lock.json', type: 'lockfile' },
      packages: [{
        package: { name: 'leftpad', version: '1.0.0', ecosystem: 'npm' },
        vulnerabilities: [{ id, database_specific: { severity } }],
      }],
    }],
  });
}

/** Write a fake `osv-scanner` executable that ignores args and prints `json`. */
function fakeOsvScanner(binDir, json, exitCode = 1) {
  fs.mkdirSync(binDir, { recursive: true });
  const p = path.join(binDir, 'osv-scanner');
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'OSV_EOF'\n${json}\nOSV_EOF\nexit ${exitCode}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function runScanDeps(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// ── offline / no-scanner ────────────────────────────────────────────────────

test('no scanner on PATH => SKIP and exit 0 (warn layer never blocks offline)', () => {
  const t = tmp();
  const target = lockfileTarget(t);
  const emptyBin = path.join(t, 'empty-bin');
  fs.mkdirSync(emptyBin);

  const r = runScanDeps([target], { PATH: emptyBin });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stderr}`);
  assert.match(r.stdout, /SKIP/, `expected a SKIP notice, got:\n${r.stdout}`);
});

// ── warn vs strict ──────────────────────────────────────────────────────────

test('Critical hit: default exits 0 (warn), SCAN_STRICT=1 exits non-zero', () => {
  const t = tmp();
  const target = lockfileTarget(t);
  const bin = path.join(t, 'bin');
  fakeOsvScanner(bin, osvJson('CRITICAL'), 1);
  const PATH = bin + path.delimiter + process.env.PATH;

  const warn = runScanDeps([target], { PATH });
  assert.equal(warn.status, 0, `warn must not block, got ${warn.status}\n${warn.stdout}`);
  assert.match(warn.stdout, /critical=1/, `expected critical=1 in summary:\n${warn.stdout}`);

  const strict = runScanDeps([target], { PATH, SCAN_STRICT: '1' });
  assert.notEqual(strict.status, 0, `strict must block on Critical:\n${strict.stdout}`);
});

test('High hit blocks under SCAN_STRICT=1; Medium does not (threshold CVSS >= 7.0)', () => {
  const tHigh = tmp();
  const highTarget = lockfileTarget(tHigh);
  const highBin = path.join(tHigh, 'bin');
  fakeOsvScanner(highBin, osvJson('HIGH'), 1);
  const high = runScanDeps([highTarget], { PATH: highBin + path.delimiter + process.env.PATH, SCAN_STRICT: '1' });
  assert.notEqual(high.status, 0, `strict must block on High:\n${high.stdout}`);

  const tMed = tmp();
  const medTarget = lockfileTarget(tMed);
  const medBin = path.join(tMed, 'bin');
  fakeOsvScanner(medBin, osvJson('MEDIUM'), 1);
  const med = runScanDeps([medTarget], { PATH: medBin + path.delimiter + process.env.PATH, SCAN_STRICT: '1' });
  assert.equal(med.status, 0, `strict must NOT block on Medium alone:\n${med.stdout}`);
});

test('an unknown-severity-only finding does not block under SCAN_STRICT=1', () => {
  const t = tmp();
  const target = lockfileTarget(t);
  const bin = path.join(t, 'bin');
  fakeOsvScanner(bin, osvJson('WEIRD'), 1); // unrecognised label => unknown
  const r = runScanDeps([target], { PATH: bin + path.delimiter + process.env.PATH, SCAN_STRICT: '1' });
  assert.equal(r.status, 0, `unknown severity must not block:\n${r.stdout}`);
});

// ── determinism ─────────────────────────────────────────────────────────────

test('deterministic: identical input => byte-identical stdout across runs', () => {
  const t = tmp();
  const target = lockfileTarget(t);
  const bin = path.join(t, 'bin');
  fakeOsvScanner(bin, osvJson('CRITICAL'), 1);
  const env = { PATH: bin + path.delimiter + process.env.PATH };

  const a = runScanDeps([target], env);
  const b = runScanDeps([target], env);
  assert.equal(a.status, b.status);
  assert.equal(a.stdout, b.stdout, 'stdout must be reproducible');
});

// ── unit: severity mapping ──────────────────────────────────────────────────

test('classifySeverity / scoreToSeverity map onto the §4.1 block threshold', async () => {
  const mod = await import(SCRIPT);
  assert.equal(mod.classifySeverity('CRITICAL'), 'critical');
  assert.equal(mod.classifySeverity('high'), 'high');
  assert.equal(mod.classifySeverity('Moderate'), 'medium');
  assert.equal(mod.classifySeverity('MEDIUM'), 'medium');
  assert.equal(mod.classifySeverity('low'), 'low');
  assert.equal(mod.classifySeverity('nonsense'), 'unknown');
  assert.equal(mod.scoreToSeverity(9.8), 'critical');
  assert.equal(mod.scoreToSeverity(7.0), 'high');
  assert.equal(mod.scoreToSeverity(6.9), 'medium');
  assert.equal(mod.scoreToSeverity(0.1), 'low');
  assert.equal(mod.BLOCK_SEVERITIES.join(','), 'critical,high');
});

test('every shipped .mjs still parses (node --check scan-deps.mjs)', () => {
  // Mirrors sched-syntax.test.mjs locally so a syntax error is caught here first.
  execFileSync(process.execPath, ['--check', SCRIPT], { stdio: 'pipe' });
  assert.ok(fs.existsSync(SCRIPT), 'scan-deps.mjs must exist');
});
