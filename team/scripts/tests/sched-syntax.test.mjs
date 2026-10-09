#!/usr/bin/env node
/**
 * sched-syntax.test.mjs — ④-3: every shipped/changed .mjs parses.
 *
 * `node --check` each script so a syntax error in a vendored entry or in the
 * framework dispatcher is caught in the repo (CI runs it via
 * `node --test team/scripts/tests/*.test.mjs`) instead of at 03:00 on the Gateway.
 *
 * Run: node --test team/scripts/tests/sched-syntax.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const TEAM = path.resolve(HERE, '..', '..');               // <repo>/team

// The entry scripts and their dependency closure, the framework dispatcher, and the tests.
const DIRS = [path.join(TEAM, 'scripts'), path.join(TEAM, 'scripts', 'tests'), path.join(TEAM, 'automations')];

function mjsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, f));
}

test('every shipped .mjs passes `node --check`', () => {
  const files = DIRS.flatMap(mjsFiles);
  assert.ok(files.length >= 10, `expected the shipped script set, found ${files.length}`);
  const failures = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      failures.push(`${path.relative(TEAM, f)}: ${String(e.stderr || e.message).trim()}`);
    }
  }
  assert.deepEqual(failures, []);
});
