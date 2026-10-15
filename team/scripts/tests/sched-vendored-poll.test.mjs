#!/usr/bin/env node
/**
 * sched-vendored-poll.test.mjs — ①②: the VENDORED poll entry ships with the repo and
 * implements single-round multi-claim.
 *
 * Style: no internal mocks. The framework entry scripts link the provider ACL library
 * at `{team}/skills/task-ops/lib/` (provider-owned and intentionally NOT vendored —
 * see skills/PROVENANCE.md), so they can only execute in a DEPLOYED layout
 * (`{team}/scripts/**` + `{team}/skills/task-ops/**`). This test materialises exactly
 * that layout in a temp dir and exercises it with real files and real subprocesses.
 * When no provider install is present it SKIPS with a reason instead of reporting a
 * false failure — the vendored scripts themselves are still covered by the byte-copy
 * check and by `node --check`.
 *
 * Run: node --test team/scripts/tests/sched-vendored-poll.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/team/scripts/tests
const SCRIPTS = path.join(HERE, '..');                     // <repo>/team/scripts

/** Locate a provider install that carries the ACL library the entries import. */
function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    path.join(os.homedir(), '.openclaw', 'team', 'skills', 'task-ops'),
    path.join(os.homedir(), '.openclaw', 'skills', 'task-ops'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'lib', 'team-paths.mjs'))) return c;
  }
  return null;
}
const PROVIDER = resolveProviderRoot();
const SKIP = PROVIDER
  ? false
  : 'provider ACL library not installed (task-ops is intentionally not vendored); set OPENCLAW_TASK_OPS_DIR to run';

const scratchDirs = [];
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Materialise a deployed team layout: scripts/ + skills/task-ops + tasks/. */
function mkLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-team-layout-'));
  scratchDirs.push(root);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
  }
  fs.symlinkSync(PROVIDER, path.join(root, 'skills', 'task-ops'), 'dir');
  return root;
}

/** Write a synthetic card (plain frontmatter — the on-disk contract poll consumes). */
function writeCard(root, id, fm = {}) {
  const merged = { id, title: 'vendored-poll-test', assignee: 'linus', status: 'ready', created_at: '2026-10-09T00:00:00Z', ...fm };
  const body = Object.entries(merged).map(([k, v]) => `${k}: ${v}`).join('\n');
  const p = path.join(root, 'tasks', `${id}.md`);
  fs.writeFileSync(p, `---\n${body}\n---\nbody\n`, 'utf8');
  return p;
}

function readStatus(root, id) {
  const raw = fs.readFileSync(path.join(root, 'tasks', `${id}.md`), 'utf8');
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2];
  }
  return fm;
}

/** Run the vendored poll CLI in the layout (real process, isolated team root). */
function runPollCli(root, agent = 'linus') {
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: root };
  const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'poll.mjs'), agent], { env, encoding: 'utf8' });
  return JSON.parse(out.trim());
}

test('vendored poll.mjs exposes the multi-claim API surface', { skip: SKIP }, async () => {
  const root = mkLayout();
  // 隔离：poll.mjs 的 TEAM_ROOT 在 import 时由 OPENCLAW_TEAM_ROOT 决定（缺省读真实 ~/.openclaw/team）。
  // 必须在 import 前指向本布局，否则会读到真实 turing-runs.json（存在活跃 Turing 会话 ⇒ 额度被扣减），
  // 使本断言依赖宿主运行状态、非确定性失败。
  const prevTeamRoot = process.env.OPENCLAW_TEAM_ROOT;
  process.env.OPENCLAW_TEAM_ROOT = root;
  let poll;
  try {
    poll = await import(pathToFileURL(path.join(root, 'scripts', 'poll.mjs')).href);
  } finally {
    if (prevTeamRoot === undefined) delete process.env.OPENCLAW_TEAM_ROOT;
    else process.env.OPENCLAW_TEAM_ROOT = prevTeamRoot;
  }

  assert.deepEqual(poll.CONCURRENCY_QUOTA, { linus: 8, jobs: 8, turing: 3 });
  for (const fn of ['runningCount', 'concurrencyQuota', 'claimBudget', 'conflictKey', 'scanCandidates', 'runPoll']) {
    assert.equal(typeof poll[fn], 'function', `${fn} must be exported`);
  }
  // budget = quota − running; no sessions registered ⇒ the full quota
  assert.equal(poll.concurrencyQuota('linus'), 8);
  assert.equal(poll.claimBudget('linus', { registry: [] }), 8);
  assert.equal(poll.claimBudget('turing', { registry: [] }), 3);
  // quota undefined for other agents ⇒ conservative single claim (legacy behaviour)
  assert.equal(poll.claimBudget('assistant', { registry: [] }), 1);
});

test('one round claims MULTIPLE non-conflicting cards and lists them all', { skip: SKIP }, () => {
  const root = mkLayout();
  const ids = ['T-20261009-120001-aa1', 'T-20261009-120002-bb2', 'T-20261009-120003-cc3'];
  ids.forEach((id, i) => writeCard(root, id, { project: `proj${i}`, target: `/tmp/target${i}` }));

  const r = runPollCli(root);
  assert.equal(r.fire, true);
  assert.equal(r.state.claimed, 3);
  assert.deepEqual(r.state.cardIds, ids);
  for (const id of ids) {
    assert.equal(readStatus(root, id).status, 'in_progress', `${id} must be claimed`);
    assert.ok(r.message.includes(path.join(root, 'tasks', `${id}.md`)), `message must list ${id}`);
  }
});

test('write conflict: same project+target in one round claims exactly one card', { skip: SKIP }, () => {
  const root = mkLayout();
  const a = 'T-20261009-130001-aa1';
  const b = 'T-20261009-130002-bb2';
  writeCard(root, a, { project: 'same', target: '/tmp/same' });
  writeCard(root, b, { project: 'same', target: '/tmp/same' });

  const r = runPollCli(root);
  assert.equal(r.fire, true);
  assert.equal(r.state.claimed, 1);
  const claimed = [readStatus(root, a).status, readStatus(root, b).status].filter((s) => s === 'in_progress');
  assert.equal(claimed.length, 1, 'conflicting group must be serialised to a single claim');
});

test('deps_unmet is skipped: a ready card with an unmet dependency stays unclaimed', { skip: SKIP }, () => {
  const root = mkLayout();
  const id = 'T-20261009-140001-aa1';
  writeCard(root, id, { depends_on: '[T-20261009-999999-missing]' });

  const r = runPollCli(root);
  assert.equal(r.fire, false);
  assert.equal(readStatus(root, id).status, 'ready', 'unmet dependency must not be claimed');
});

test('no candidate cards ⇒ fire:false (zero-cost idle)', { skip: SKIP }, () => {
  const root = mkLayout();
  const r = runPollCli(root);
  assert.equal(r.fire, false);
});
