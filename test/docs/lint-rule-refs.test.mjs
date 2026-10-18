/**
 * lint-rule-refs.test.mjs — 稳定规则 ID 引用门的反证测试。
 *
 * 每个用例构造一个最小 repo（五个角色的 AGENTS + 一个 guide），
 * 用 `--repo <tmp> --json` 跑真实 CLI，断言退出码与错误类别。
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
const SCRIPT = path.join(REPO, 'team/scripts/lint-rule-refs.mjs');
const ROLES = ['elon', 'jobs', 'linus', 'turing', 'assistant'];

function ownerBlock({ id = 'R-TEST-1', meta = 'owner=elon carriers=all canonical=owner detail=-', payload = '> rule' } = {}) {
  return `<!-- BEGIN SHARED-RULE:${id} v1 ${meta} -->\n${payload}\n<!-- END SHARED-RULE:${id} -->\n`;
}
function carrierBlock({ id = 'R-TEST-1', owner = 'elon', payload = '> rule' } = {}) {
  return `<!-- BEGIN SHARED-RULE:${id} v1 generated=1 source=owner:${owner} -->\n${payload}\n<!-- END SHARED-RULE:${id} -->\n`;
}

function makeRepo({ owner = ownerBlock(), carriers = {}, guide = '', extraRole = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-refs-'));
  for (const role of ROLES) {
    const d = path.join(dir, 'roles', role);
    fs.mkdirSync(d, { recursive: true });
    let text = '';
    if (role === 'elon') text += owner;
    if (carriers[role]) text += carriers[role];
    if (extraRole[role]) text += extraRole[role];
    fs.writeFileSync(path.join(d, 'AGENTS.md'), text);
  }
  fs.mkdirSync(path.join(dir, 'team', 'guides'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'team', 'guides', 'foo.md'), guide);
  return dir;
}

function run(dir) {
  try {
    const out = execFileSync('node', [SCRIPT, '--repo', dir, '--json'], { encoding: 'utf8' });
    return { code: 0, json: JSON.parse(out) };
  } catch (e) {
    return { code: e.status, json: JSON.parse(e.stdout) };
  }
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('lint-rule-refs：已定义且已携带的引用通过', () => {
  const dir = makeRepo({ carriers: { jobs: carrierBlock() }, guide: 'see `R-TEST-1`\n' });
  try {
    const r = run(dir);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.equal(r.json.resolved, 1);
  } finally { cleanup(dir); }
});

test('lint-rule-refs：未知 ID ⇒ 红', () => {
  const dir = makeRepo({ guide: 'see `R-NOPE-1`\n' });
  try {
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /未知规则 ID/);
  } finally { cleanup(dir); }
});

test('lint-rule-refs：AGENTS 引用未携带的规则 ⇒ 红', () => {
  const dir = makeRepo({
    carriers: {},
    extraRole: { jobs: 'see `R-TEST-1`\n' },
  });
  try {
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /未携带规则/);
  } finally { cleanup(dir); }
});

test('lint-rule-refs：未用反引号 ⇒ 红', () => {
  const dir = makeRepo({ carriers: { jobs: carrierBlock() }, guide: 'see R-TEST-1\n' });
  try {
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /未用反引号/);
  } finally { cleanup(dir); }
});

test('lint-rule-refs：clause 超出顶层有序项数 ⇒ 红', () => {
  const dir = makeRepo({
    owner: ownerBlock({ payload: '> rule\n1. first\n2. second' }),
    carriers: { jobs: carrierBlock({ payload: '> rule\n1. first\n2. second' }) },
    guide: 'see `R-TEST-1 clause 3`\n',
  });
  try {
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /超出范围/);
  } finally { cleanup(dir); }
});

test('lint-rule-refs：引用 retired 规则 ⇒ 红', () => {
  const dir = makeRepo({
    owner: ownerBlock({ meta: 'owner=elon carriers=none canonical=owner detail=- status=retired' }),
    guide: 'see `R-TEST-1`\n',
  });
  try {
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /已退役/);
  } finally { cleanup(dir); }
});
