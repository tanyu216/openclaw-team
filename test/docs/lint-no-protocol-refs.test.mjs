/**
 * lint-no-protocol-refs.test.mjs — guides 反向引用门 + 精确 allowlist 的反证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO, 'team/scripts/lint-no-protocol-refs.mjs');

function makeRepo(guideText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-proto-'));
  fs.mkdirSync(path.join(dir, 'team', 'guides'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'team', 'guides', 'foo.md'), guideText);
  for (const role of ['elon', 'jobs', 'linus', 'turing', 'assistant']) {
    fs.mkdirSync(path.join(dir, 'roles', role, 'guides'), { recursive: true });
  }
  return dir;
}

function run(dir, extra = []) {
  try {
    const out = execFileSync('node', [SCRIPT, '--repo', dir, '--json', ...extra], { encoding: 'utf8' });
    return { code: 0, json: JSON.parse(out) };
  } catch (e) {
    return { code: e.status, json: JSON.parse(e.stdout) };
  }
}

function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('lint-no-protocol-refs：guide 含 PROTOCOL ⇒ 红', () => {
  const dir = makeRepo('see `PROTOCOL §1`\n');
  try {
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.equal(r.json.hits, 1);
    assert.equal(r.json.samples[0].file, 'team/guides/foo.md');
  } finally { cleanup(dir); }
});

test('lint-no-protocol-refs：guide 干净 ⇒ 绿', () => {
  const dir = makeRepo('see `R-BOARD-1`\n');
  try {
    const r = run(dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.hits, 0);
  } finally { cleanup(dir); }
});

test('lint-no-protocol-refs：--all 的精确 allowlist 放行，未登记仍红', () => {
  const dir = makeRepo('see `PROTOCOL §1`\n');
  try {
    const allow = path.join(dir, 'test', 'docs', 'protocol-ref-allowlist.json');
    fs.mkdirSync(path.dirname(allow), { recursive: true });
    fs.writeFileSync(allow, JSON.stringify({ files: [], entries: ['team/guides/foo.md:1:PROTOCOL §'] }, null, 2));

    const allowed = run(dir, ['--all', '--allowlist', allow]);
    assert.equal(allowed.code, 0, JSON.stringify(allowed.json));
    assert.equal(allowed.json.hits, 0);

    const denied = run(dir, ['--all', '--allowlist', path.join(dir, 'nope-allowlist.json')]);
    assert.equal(denied.code, 1);
    assert.ok(denied.json.hits >= 1);
  } finally { cleanup(dir); }
});
