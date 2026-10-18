#!/usr/bin/env node
/**
 * protocol-retirement.test.mjs — installer retires the two protocol volumes and
 * the superseded §N lint, with backups and explicit opt-outs.
 *
 * Cases: fresh install, upgrade (backup + delete), dry-run (no writes),
 * --keep-existing (explicitly keeps, warning only), --skip-team (no retirement),
 * and a second run (idempotent).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const INSTALL = path.join(REPO, 'install.sh');
const LEGACY = ['PROTOCOL.md', 'PROTOCOL-gates.md', 'scripts/lint-refs.mjs'];

const scratch = [];
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-retire-'));
  scratch.push(root);
  return { root, home: path.join(root, '.openclaw'), claude: path.join(root, '.claude'), codex: path.join(root, '.codex') };
}

function run(h, args = []) {
  const e = { ...process.env, HOME: h.root };
  delete e.OPENCLAW_TEAM_ROOT;
  delete e.OPENCLAW_HOME;
  return spawnSync('bash', [INSTALL, '--openclaw-home', h.home, '--claude-home', h.claude, '--codex-home', h.codex,
    '--no-meerkat-taskpanel', '--skip-skills', '--skip-automations', '--no-register', '--skip-config', ...args],
  { encoding: 'utf8', env: e, timeout: 120_000 });
}

function seedLegacy(h) {
  const team = path.join(h.home, 'team');
  fs.mkdirSync(path.join(team, 'scripts'), { recursive: true });
  for (const rel of LEGACY) fs.writeFileSync(path.join(team, rel), `# legacy ${rel}\n`);
}

function exists(h, rel) { return fs.existsSync(path.join(h.home, 'team', rel)); }

function backups(h, rel) {
  const root = path.join(h.home, 'team', '.backups');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map((ts) => path.join(root, ts, 'team', rel)).filter((p) => fs.existsSync(p));
}

test('fresh install: new rule index present, retired files absent', () => {
  const h = home();
  const r = run(h);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(h.home, 'team', 'SHARED-RULES.md')));
  assert.ok(fs.existsSync(path.join(h.home, 'team', 'guides', 'sla-thresholds.json')));
  for (const rel of LEGACY) assert.equal(exists(h, rel), false, `fresh install left ${rel}`);
});

test('upgrade: legacy files are backed up then removed', () => {
  const h = home();
  assert.equal(run(h).status, 0);
  seedLegacy(h);
  const r = run(h);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const rel of LEGACY) {
    assert.equal(exists(h, rel), false, `upgrade did not remove ${rel}`);
    assert.ok(backups(h, rel).length >= 1, `upgrade did not back up ${rel}`);
  }
});

test('dry-run: prints the retirement plan, writes nothing', () => {
  const h = home();
  seedLegacy(h);
  const r = run(h, ['--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /retired|retire/);
  for (const rel of LEGACY) assert.equal(exists(h, rel), true, `dry-run removed ${rel}`);
});

test('--keep-existing: explicit opt-out keeps legacy files with a warning', () => {
  const h = home();
  seedLegacy(h);
  const r = run(h, ['--keep-existing']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /keep-existing: legacy/);
  for (const rel of LEGACY) assert.equal(exists(h, rel), true, `--keep-existing removed ${rel}`);
});

test('--skip-team: team deployment (and retirement) is skipped', () => {
  const h = home();
  seedLegacy(h);
  const r = run(h, ['--skip-team']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const rel of LEGACY) assert.equal(exists(h, rel), true, `--skip-team removed ${rel}`);
});

test('idempotent: a second upgrade run does not fail and legacy stays gone', () => {
  const h = home();
  assert.equal(run(h).status, 0);
  seedLegacy(h);
  assert.equal(run(h).status, 0);
  const r2 = run(h);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  for (const rel of LEGACY) assert.equal(exists(h, rel), false, `${rel} reappeared`);
});
