/**
 * protocol-removal-census.test.mjs — 钉住拆除对照表的结构与新鲜度。
 *
 * 这张表是 C2/C3 的施工图：一个未映射的小节、一条没有 owner 的规则、
 * 一份过期的 JSON，都会让后续「零丢失」核对失去意义。故这里断言：
 * 每节有映射、每规则有唯一 owner/carrier/canonical、JSON 与生成器一致、
 * 16 条矛盾与 bare-§ 工作清单都在。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildCensus, CENSUS_PATH } from './protocol-removal-census.mjs';

const census = buildCensus();
const ROLES = ['elon', 'jobs', 'linus', 'turing', 'assistant'];

test('census：每个来源小节都有映射，没有 unmapped', () => {
  const unmapped = census.sections.filter((s) => s.disposition === 'unmapped');
  assert.deepEqual(unmapped, [], `未映射小节：${unmapped.map((s) => `${s.volume}:${s.section}`).join(', ')}`);
  assert.ok(census.sections.length > 0, '必须解析出小节');
});

test('census：每个来源小节只出现一次', () => {
  const keys = census.sections.map((s) => `${s.source}:${s.section}`);
  assert.equal(new Set(keys).size, keys.length, '同一来源小节不得重复');
});

test('census：规则 ID 唯一、owner 合法、carriers 非空、canonical 合法', () => {
  const ids = census.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, '规则 ID 不得重复');
  for (const r of census.rules) {
    assert.ok(ROLES.includes(r.owner), `${r.id} owner 非法：${r.owner}`);
    assert.ok(Array.isArray(r.carriers) && r.carriers.length > 0, `${r.id} carriers 不得为空`);
    for (const c of r.carriers) assert.ok(ROLES.includes(c), `${r.id} carrier 非法：${c}`);
    assert.ok(['owner', 'guide'].includes(r.canonical), `${r.id} canonical 非法：${r.canonical}`);
    if (r.canonical === 'guide') assert.notEqual(r.detail, '-', `${r.id} canonical=guide 必须有 detail`);
    assert.equal(typeof r.title, 'string');
    assert.ok(r.title.length > 0);
  }
});

test('census：没有被任何小节引用的孤儿规则', () => {
  assert.deepEqual(census.orphanRules, [], `孤儿规则：${census.orphanRules.join(', ')}`);
});

test('census：每个带规则的小节引用的规则都存在', () => {
  const ids = new Set(census.rules.map((r) => r.id));
  for (const s of census.sections) {
    for (const id of s.ruleIds) assert.ok(ids.has(id), `${s.volume}:${s.section} 引用未知规则 ${id}`);
  }
});

test('census：原子清单非空，且每节都有四轴结构', () => {
  let total = 0;
  for (const s of census.sections) {
    for (const axis of ['codes', 'tokens', 'refs', 'numbers']) {
      assert.ok(Array.isArray(s.atoms[axis]), `${s.volume}:${s.section} 缺少 ${axis} 轴`);
      total += s.atoms[axis].length;
    }
  }
  assert.ok(total > 0, '整张表不得没有任何原子');
});

test('census：16 条内部矛盾都有处置', () => {
  assert.equal(census.contradictions.length, 16);
  for (const c of census.contradictions) {
    assert.match(c.id, /^C\d+$/);
    assert.ok(c.topic && c.issue && c.resolution);
    assert.equal(c.status, 'resolved-in-migration');
  }
});

test('census：bare-§ 工作清单存在且每条都有定位', () => {
  assert.ok(census.bareRefs.total > 0, '必须扫描到裸 §N');
  assert.equal(census.bareRefs.unresolved.length, 0, '仍有未解析的裸 §N：必须本地可解析或改写为规则 ID');
  for (const b of census.bareRefs.unresolved) {
    assert.ok(b.file && b.line > 0 && b.ref && b.intendedTarget);
  }
});

test('census：提交的 JSON 与生成器一致（过期即红）', () => {
  const committed = JSON.parse(fs.readFileSync(CENSUS_PATH, 'utf8'));
  assert.deepEqual(committed, census, 'census JSON 过期：运行 node test/docs/protocol-removal-census.mjs');
});
