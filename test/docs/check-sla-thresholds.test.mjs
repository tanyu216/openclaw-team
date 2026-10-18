/**
 * check-sla-thresholds.test.mjs — SLA JSON 的 schema/边界/无 provider 可跑性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateThresholds } from '../../team/scripts/sla-thresholds.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const JSON_PATH = path.join(REPO, 'team/guides/sla-thresholds.json');
const CLI = path.join(REPO, 'team/scripts/check-sla-thresholds.mjs');

function base() { return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); }

test('SLA JSON：仓库里的文件通过校验', () => {
  assert.deepEqual(validateThresholds(base()), []);
});

test('SLA JSON：缺行 / 重复行 / further<=normal / 非整数 / liveness 阈值 / PROTOCOL 引用 均红', () => {
  const cases = [];
  let d = base(); d.rows.pop(); cases.push(['缺行', d]);
  d = base(); d.rows.push({ ...d.rows[0] }); cases.push(['重复行', d]);
  d = base(); d.rows[0].furtherMin = d.rows[0].normalMin; cases.push(['further<=normal', d]);
  d = base(); d.rows[0].normalMin = 1.5; cases.push(['非整数', d]);
  d = base(); d.liveness.normalMin = 5; cases.push(['liveness 有阈值', d]);
  d = base(); d.rows[0].action += ' see PROTOCOL'; cases.push(['PROTOCOL 引用', d]);
  for (const [name, data] of cases) {
    assert.ok(validateThresholds(data).length > 0, `${name} 应报错`);
  }
});

test('check-sla-thresholds：repo 模式无 provider 可跑', () => {
  const out = execFileSync('node', [CLI, '--repo', REPO, '--json'], { encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.equal(j.ok, true);
  assert.equal(j.rows, 6);
  assert.equal(j.liveness, 'inspector_liveness');
});

test('check-sla-thresholds：阈值文件缺失 ⇒ 非零退出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-missing-'));
  try {
    const r = (() => {
      try {
        execFileSync('node', [CLI, '--repo', dir, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return 0;
      } catch (e) { return e.status; }
    })();
    assert.notEqual(r, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
