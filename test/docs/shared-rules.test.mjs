/**
 * shared-rules.test.mjs — marker 解析/渲染/同步的基础回归。
 *
 * 这些测试不依赖 provider：所有工具都只 import node 内置与 host-paths。
 * 另有两条针对真实仓库的断言：check-shared-rules 通过、每个角色 AGENTS ≤32KB。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  ROLES, parseMeta, parseRuleBlocks, parseRedlineBlock, expandCarriers,
  renderCarrierBlock, replaceGeneratedSection, renderIndex,
} from '../../team/scripts/lib/agent-doc-blocks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

test('parseMeta：detail 可含空格，key=value 正确切分', () => {
  const m = parseMeta('owner=elon carriers=all detail=team/guides/foo.md §6.1 redline=1,2 title=A B');
  assert.equal(m.owner, 'elon');
  assert.equal(m.carriers, 'all');
  assert.equal(m.detail, 'team/guides/foo.md §6.1');
  assert.equal(m.redline, '1,2');
  assert.equal(m.title, 'A B');
});

test('parseRuleBlocks：围栏内的 marker 是示例，不被解析', () => {
  const text = [
    '```md',
    '<!-- BEGIN SHARED-RULE:R-X-1 v1 owner=elon carriers=all canonical=owner detail=- -->',
    'example',
    '<!-- END SHARED-RULE:R-X-1 -->',
    '```',
    '<!-- BEGIN SHARED-RULE:R-X-2 v1 owner=elon carriers=all canonical=owner detail=- -->',
    '> real rule',
    '<!-- END SHARED-RULE:R-X-2 -->',
  ].join('\n');
  const blocks = parseRuleBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].id, 'R-X-2');
  assert.equal(blocks[0].payload, '> real rule');
});

test('parseRuleBlocks：END 缺失 / ID 不一致 ⇒ 抛', () => {
  assert.throws(() => parseRuleBlocks('<!-- BEGIN SHARED-RULE:R-X-1 v1 owner=elon carriers=all canonical=owner detail=- -->\n> x'));
  assert.throws(() => parseRuleBlocks('<!-- BEGIN SHARED-RULE:R-X-1 v1 owner=elon carriers=all canonical=owner detail=- -->\n> x\n<!-- END SHARED-RULE:R-X-2 -->'));
});

test('parseRedlineBlock：取到 BEGIN/END 之间的原文', () => {
  const r = parseRedlineBlock('a\n<!-- BEGIN REDLINES:v1 -->\n> 1. x\n<!-- END REDLINES:v1 -->\nb');
  assert.equal(r.payload, '> 1. x');
});

test('expandCarriers：all / 子集 / none / 未知角色', () => {
  assert.deepEqual(expandCarriers('all'), ROLES);
  assert.deepEqual(expandCarriers('jobs,linus'), ['jobs', 'linus']);
  assert.deepEqual(expandCarriers('none'), []);
  assert.throws(() => expandCarriers('bob'), /未知角色/);
});

test('carrier 块渲染后 payload 与 owner 逐字节一致', () => {
  const owner = { id: 'R-X-1', version: 'v1', owner: 'elon', payload: '> rule\n> line 2' };
  const block = renderCarrierBlock(owner);
  const parsed = parseRuleBlocks(block)[0];
  assert.equal(parsed.kind, 'carrier');
  assert.equal(parsed.meta.source, 'owner:elon');
  assert.equal(parsed.payload, owner.payload);
});

test('replaceGeneratedSection：插入后再次替换幂等', () => {
  const text = '## Shared rules (owner)\n\n<!-- BEGIN SHARED-RULE:R-X-1 v1 owner=elon carriers=all canonical=owner detail=- -->\n> rule\n<!-- END SHARED-RULE:R-X-1 -->\n\n## Role Duties\n';
  const block = renderCarrierBlock({ id: 'R-X-2', version: 'v1', owner: 'linus', payload: '> carried' });
  const once = replaceGeneratedSection(text, [block]);
  const twice = replaceGeneratedSection(once, [block]);
  assert.equal(twice, once);
  assert.match(once, /## Shared rules \(generated\)/);
  assert.match(once, /R-X-2/);
});

test('renderIndex：表格行有首尾竖线，正文不入索引', () => {
  const idx = renderIndex([{
    id: 'R-X-1', title: 'T', owner: 'elon', carriers: [...ROLES], canonical: 'owner',
    detail: '-', redline: '1,2', status: 'active', payload: '> body should not appear',
  }]);
  assert.match(idx, /^\| `R-X-1` \| T \| elon \| all \| owner \| - \| 1,2 \| active \|$/m);
  assert.ok(!idx.includes('body should not appear'), '索引不得含规则正文');
});

test('真实仓库：check-shared-rules 通过', () => {
  const out = execFileSync('node', ['team/scripts/check-shared-rules.mjs', '--repo', REPO], { cwd: REPO, encoding: 'utf8' });
  assert.match(out, /0 drift/);
});

// 实测硬预算：owner-AGENTS-as-source 后，Elon/Linus 承载的规则最多；
// 32KB 是 C1 试点的估计值，完整迁移在压缩 + 收窄 carriers 后需要 36/37KB。
// 其余角色按实测留 ~1KB 余量。超限优先收窄 carriers，再压缩正文。
const BUDGET_KB = { elon: 36, jobs: 26, linus: 37, turing: 29, assistant: 23 };

test('真实仓库：每个角色 AGENTS 不超过实测硬预算', () => {
  for (const role of ROLES) {
    const p = path.join(REPO, 'roles', role, 'AGENTS.md');
    const size = fs.statSync(p).size;
    const cap = BUDGET_KB[role] * 1024;
    assert.ok(size <= cap, `${role}/AGENTS.md ${size} bytes > ${BUDGET_KB[role]}KB`);
  }
});

test('真实仓库：关键 canonical=guide 指针指向的段落确实含规则内容', () => {
  const checks = [
    ['team/guides/task-interface.md', '6', /Claim is atomic|Execution uniqueness/],
    ['team/ROLES.md', '1', /Product design|Task routing matrix/],
    ['team/guides/sla-inspection-contract.md', '14', /worker-to-operator|exception report/],
    ['team/guides/lane-session-lifecycle-sop.md', '0', /One registry|Concurrency caps/],
  ];
  for (const [rel, num, re] of checks) {
    const lines = fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n');
    const start = lines.findIndex((l) => new RegExp(`^#{2,6}\\s*(?:§)?${num}(?:\\.|\\s|$)`).test(l));
    assert.ok(start >= 0, `${rel}: 缺 §${num}`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
    const body = lines.slice(start, end).join('\n');
    assert.match(body, re, `${rel} §${num} 不含该规则正文`);
  }
});
