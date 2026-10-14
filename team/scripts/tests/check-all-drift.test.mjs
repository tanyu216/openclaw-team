#!/usr/bin/env node
/**
 * check-all-drift.test.mjs — the anti-drift patrol's SEVERITY per surface (T-20261014-214625).
 *
 * `check-all.sh` diffs the repo against the deployed instance and escalates the surfaces whose
 * drift is ALWAYS "deploy lag" (the third implementation state) to a default red:
 *   - `team/scripts/**`      — install.sh §1, the executable deploy surface (T-20261014-204806)
 *   - `team/automations/**`  — install.sh §1, the dispatch/provider ROUTING surface (this card)
 *   - `tools/**`             — install.sh §1a, compared EXPLICITLY as `$REPO/tools ↔ $TEAM/tools`
 *                              (a different path pair from the `team/` tree; `-x tools` stays)
 * Everything else (`docs/`, `guides/`) stays warn-only, escalating only under `DRIFT_STRICT=1`.
 *
 * What this pins:
 *   1. automations drift is RED by default — it used to be warn-only, and the root cause of
 *      T-20261014-211759 was exactly a stale live `dispatch.mjs` silently mis-routing jobs;
 *   2. the tools pair is compared repo `tools/` → instance `tools/` (NOT `repo/team/tools`),
 *      so a repo-side tools change is caught and an INSTANCE-ONLY entry (a host-local extra
 *      such as `openssl3`) is ignored — never a false red;
 *   3. docs drift keeps its裁定'd severity (warn-only; `DRIFT_STRICT=1` escalates);
 *   4. the scripts surface keeps its own label (no regression from the shared predicate).
 *
 * Style: the REAL `check-all.sh` is pointed at a temp "deployed layout" via OPENCLAW_TEAM_ROOT,
 * and at a temp repo mirror via OPENCLAW_TEAM_REPO — every check-all step is a stub, so no
 * provider install and no live instance is involved.
 *
 * Run: node --test team/scripts/tests/check-all-drift.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // <repo>/team/scripts/tests
const SCRIPTS = path.resolve(HERE, '..');                    // <repo>/team/scripts
const CHECKALL = path.join(SCRIPTS, 'check-all.sh');          // the REAL gate, segmented

const scratch = [];
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });

const OK_STUB = 'process.exit(0);\n';
// Every fast-segment step, as a stub that exits 0 (the drift step is the only one under test).
const FAST_STEPS = [
  'scripts/check-redlines.mjs', 'scripts/lint-impl-names.mjs', 'scripts/lint-refs.mjs',
  'scripts/scan-deps.mjs', 'scripts/check-card.mjs', 'scripts/check-handoff.mjs',
  'scripts/check-relations.mjs', 'scripts/check-idem.mjs', 'scripts/check-sessions.mjs',
  'scripts/archive.mjs', 'scripts/sla-scan.mjs',
  'skills/task-ops/tests/contract.test.mjs', 'skills/task-ops/tests/terminal-guard.test.mjs',
  'skills/task-ops/tests/projects.test.mjs', 'skills/task-ops/tests/schedule.test.mjs',
];

/**
 * Materialize a temp "deployed layout" (the instance) plus a byte-identical REPO MIRROR of it,
 * so `diff -rq <repo>/team <instance>` is clean at t0 and every drift below is induced on purpose.
 */
function mkLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-drift-inst-'));
  scratch.push(root);
  for (const d of ['scripts', 'scripts/tests', 'skills/task-ops/lib', 'skills/task-ops/tests', 'tasks', 'guides']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of ['team-paths', 'projects']) fs.writeFileSync(path.join(root, 'skills/task-ops/lib', `${f}.mjs`), '');
  for (const rel of FAST_STEPS) fs.writeFileSync(path.join(root, rel), OK_STUB);
  // The docs/automations files the drift diff reads (their CONTENT is irrelevant, only equality).
  // `scripts/README.md` is a NON-step file on the scripts surface, used to induce a form-(a) diff.
  for (const rel of ['PROTOCOL.md', 'README.md', 'AUTOMATIONS.md', 'guides/redlines.core.md', 'automations/dispatch.mjs', 'scripts/README.md']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `live:${rel}\n`);
  }
  // The tools pair (install.sh §1a) — identical on both sides at t0, plus a HOST-LOCAL extra that
  // only ever exists in the instance (install.sh never touches it).
  fs.mkdirSync(path.join(root, 'tools/ui-align/lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools/ui-align/lib/manifest.mjs'), 'engine v1\n');
  fs.mkdirSync(path.join(root, 'tools/openssl3/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools/openssl3/bin/openssl'), 'host-local build\n');

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-drift-repo-'));
  scratch.push(repo);
  fs.cpSync(root, path.join(repo, 'team'), { recursive: true });   // repo/team == instance
  fs.cpSync(path.join(root, 'tools'), path.join(repo, 'tools'), { recursive: true });  // repo/tools == instance/tools
  fs.rmSync(path.join(repo, 'tools/openssl3'), { recursive: true, force: true });      // host-local extra: repo has none
  return { root, repo };
}

/** Run the REAL check-all.sh against the fixture. */
function runFast(root, repo, extra = {}) {
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: root, OPENCLAW_TEAM_REPO: repo, ...extra };
  delete env.NODE_TEST_CONTEXT;   // a nested `node --test` inheriting it skips its files
  delete env.DRIFT_STRICT;
  delete env.PROTOTYPE_DIR;
  Object.assign(env, extra);      // re-apply (extra may deliberately set DRIFT_STRICT)
  try {
    const stdout = execFileSync('bash', [CHECKALL, '--segment', 'fast'], { encoding: 'utf8', env, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, stdout, envelope: JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()) };
  } catch (e) {
    const stdout = String(e.stdout || '');
    return { exit: e.status, stdout, envelope: JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()) };
  }
}

const ROUTING = '部署面漂移 team/automations';

test('clean tree: green, and BOTH deploy-surface pairs report consistent', () => {
  const { root, repo } = mkLayout();
  const r = runFast(root, repo);
  assert.equal(r.exit, 0, r.stdout);
  assert.equal(r.envelope.ok, true);
  assert.match(r.stdout, /✔ 仓 team\/ 与实例一致/);
  assert.match(r.stdout, /✔ 仓 tools\/ 与实例 tools\/ 一致/, 'the tools pair is compared and clean');
});

test('tools: an INSTANCE-ONLY entry (host-local extra) is ignored — no false red', () => {
  const { root, repo } = mkLayout();
  fs.writeFileSync(path.join(root, 'tools/openssl3/bin/openssl'), 'host-local build v2\n');   // touched locally
  const r = runFast(root, repo);
  assert.equal(r.exit, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /openssl3/, 'the host-local extra never reaches the diff output');
});

test('tools: a repo-side change (not deployed) is RED — the blind spot this card closes', () => {
  const { root, repo } = mkLayout();
  fs.writeFileSync(path.join(repo, 'tools/ui-align/lib/manifest.mjs'), 'engine v2 (repo)\n');
  const r = runFast(root, repo);
  assert.equal(r.exit, 1);
  assert.equal(r.envelope.ok, false);
  assert.ok(r.envelope.failed.includes('部署面漂移 tools'), `failed=${JSON.stringify(r.envelope.failed)}`);
  assert.match(r.stdout, /manifest\.mjs/);
});

test('tools: a repo-only tool (never deployed) is RED — "Only in <repo>/tools" counts', () => {
  const { root, repo } = mkLayout();
  fs.mkdirSync(path.join(repo, 'tools/ui-fidelity'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tools/ui-fidelity/README.md'), 'new tool\n');
  const r = runFast(root, repo);
  assert.equal(r.exit, 1);
  assert.ok(r.envelope.failed.includes('部署面漂移 tools'), `failed=${JSON.stringify(r.envelope.failed)}`);
});

test('tools: repo tools/ exists but the instance has none ⇒ RED (deploy lag, not a skip)', () => {
  const { root, repo } = mkLayout();
  fs.rmSync(path.join(root, 'tools'), { recursive: true, force: true });
  const r = runFast(root, repo);
  assert.equal(r.exit, 1);
  assert.ok(r.envelope.failed.includes('部署面漂移 tools'), `failed=${JSON.stringify(r.envelope.failed)}`);
});

test('automations drift is RED by default (was warn-only; stale live dispatch.mjs mis-routes jobs)', () => {
  const { root, repo } = mkLayout();
  fs.writeFileSync(path.join(repo, 'team/automations/dispatch.mjs'), 'repo:automations/dispatch.mjs v2\n');
  const r = runFast(root, repo);
  assert.equal(r.exit, 1);
  assert.equal(r.envelope.ok, false);
  assert.ok(r.envelope.failed.includes(ROUTING), `failed=${JSON.stringify(r.envelope.failed)}`);
  assert.match(r.stdout, /FAIL \(deploy surface drift: team\/automations\/\*\*\)/);
});

test('scripts drift keeps its OWN label (the automations predicate must not shadow it)', () => {
  const { root, repo } = mkLayout();
  fs.writeFileSync(path.join(repo, 'team/scripts/README.md'), 'repo:scripts/README.md v2\n');
  const r = runFast(root, repo);
  assert.equal(r.exit, 1);
  assert.deepEqual(r.envelope.failed, ['部署面漂移 team/scripts'], 'exactly the scripts surface, not automations');
});

// ALL THREE diff forms must count as deploy lag (T-20261014-214625 closed forms b/c):
//   (a) present on both sides, content differs   → `.../team/<s>/x ... differ`
//   (b) the surface DIR is repo-only            → `Only in <repo>/team: <s>`
//   (c) a file directly in the surface is repo-only → `Only in <repo>/team/<s>: x`
test('a repo-only NEW file anywhere under a deploy surface is RED (form b: nested "Only in")', () => {
  const { root, repo } = mkLayout();
  fs.writeFileSync(path.join(repo, 'team/scripts/tests/brand-new.test.mjs'), OK_STUB);
  const r = runFast(root, repo);
  assert.equal(r.exit, 1);
  assert.ok(r.envelope.failed.includes('部署面漂移 team/scripts'), `failed=${JSON.stringify(r.envelope.failed)}`);
});

test('a repo-only FILE directly in a deploy surface is RED (form c: "Only in <repo>/team/scripts: x")', () => {
  const { root, repo } = mkLayout();
  fs.writeFileSync(path.join(repo, 'team/scripts/poll-run.mjs'), OK_STUB);   // new script, never deployed
  const r = runFast(root, repo);
  assert.equal(r.exit, 1);
  assert.ok(r.envelope.failed.includes('部署面漂移 team/scripts'), `failed=${JSON.stringify(r.envelope.failed)}`);
  assert.match(r.stdout, /Only in .*team\/scripts: poll-run\.mjs/, 'form c must be visible in the output');
});

test('a repo-only TOP-LEVEL surface dir is RED (form b: "Only in <repo>/team: automations")', () => {
  const { root, repo } = mkLayout();
  fs.rmSync(path.join(root, 'automations'), { recursive: true, force: true });   // never deployed
  const r = runFast(root, repo);
  assert.equal(r.exit, 1);
  assert.ok(r.envelope.failed.includes(ROUTING), `failed=${JSON.stringify(r.envelope.failed)}`);
  assert.match(r.stdout, /Only in .*team: automations/, 'form b must be visible in the output');
});

test('docs drift stays warn-only; DRIFT_STRICT=1 escalates it (裁定 unchanged)', () => {
  const { root, repo } = mkLayout();
  fs.writeFileSync(path.join(repo, 'team/PROTOCOL.md'), 'repo:PROTOCOL.md v2\n');
  fs.writeFileSync(path.join(repo, 'team/guides/redlines.core.md'), 'repo:guides/redlines.core.md v2\n');

  const warn = runFast(root, repo);
  assert.equal(warn.exit, 0, 'docs drift must NOT red the gate by default');
  assert.equal(warn.envelope.ok, true);
  assert.match(warn.stdout, /⚠ 检出动差异/, 'the drift is still REPORTED, just not fatal');

  const strict = runFast(root, repo, { DRIFT_STRICT: '1' });
  assert.equal(strict.exit, 1);
  assert.ok(strict.envelope.failed.includes('防漂移巡检 (strict)'), `failed=${JSON.stringify(strict.envelope.failed)}`);
});

test('no repo configured ⇒ the drift step skips (never a red, never a silent green)', () => {
  const { root } = mkLayout();
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: root, OPENCLAW_TEAM_REPO: '' };
  delete env.NODE_TEST_CONTEXT;
  const stdout = execFileSync('bash', [CHECKALL, '--segment', 'fast'], { encoding: 'utf8', env, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(stdout, /\(skip\) 未配置仓路径/);
  assert.match(stdout, /"ok":true/);
});
