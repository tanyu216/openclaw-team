#!/usr/bin/env node
/**
 * check-idem.test.mjs — 建卡幂等巡检口径收口测试（T-20261010-064006-2）
 *
 * 重点（红→绿负例）：**同 parent + 同 assignee + 空 target 的兄弟卡**在旧口径下机械键相同 ⇒ 被误判
 * duplicates；新口径降级为非阻断 hints（退出码 0）。真重复（同 review_of / 非空同 target）仍判红。
 * 口径依据：scripts/check-idem.mjs 头部注释；PROTOCOL §㉙.8；guides/task-interface.md §14。
 *
 * 风格：核心逻辑直接 import `scanIdem(dir)`（注入 mkdtemp 隔离目录）取行/分支覆盖；退出码/输出另
 * spawn 子进程验证（OPENCLAW_TEAM_ROOT 指向隔离 root，**绝不碰真实看板**）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scanIdem, SIBLING_HINT_REASON } from '../check-idem.mjs';
import { idemKey } from '../../skills/task-ops/lib/task.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_IDEM = path.join(HERE, '..', 'check-idem.mjs');

const TMP = [];
after(() => { for (const r of TMP) fs.rmSync(r, { recursive: true, force: true }); });

/** 卡序列化：列表写数组，其余写原值（空 target 写 `target: ` ⇒ 解析为 ''） */
function cardText(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', '## Background', 'x', '## Report', '');
  return lines.join('\n');
}

/** 建隔离 root（tasks/ + workspace/）→ 返回 root 路径 */
function mkRoot(cards) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-idem-'));
  TMP.push(root);
  const T = path.join(root, 'tasks');
  fs.mkdirSync(T, { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  for (const c of cards) fs.writeFileSync(path.join(T, `${c.id}.md`), cardText(c), 'utf8');
  return root;
}

const tasksOf = (root) => path.join(root, 'tasks');

/** 卡工厂：默认非终态 task，assignee linus；target/review_of/parent 默认空 */
const card = (id, extra = {}) => ({
  id, title: `t-${id}`, assignee: 'linus', status: 'ready', kind: 'task', project: '__team__', ...extra,
});

/** 跑 CLI，返回 { code, out, err }（out/err 为字符串，不 throw） */
function runCli(root, args = []) {
  const r = spawnSync(process.execPath, [CHECK_IDEM, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/**
 * 旧口径复现（**仅用于红→绿取证**）：按机械键分组、组内非终态 >1 即判 duplicates。
 * 与改前 check-idem 的 `scanIdem` 分组/判红逻辑等价（不解析键字符串之外任何字段）。
 */
function oldDuplicates(cards) {
  const groups = new Map();
  for (const c of cards) {
    const key = idemKey(c);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c.id);
  }
  return [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids }));
}

const SIBLINGS = [
  card('T-20260101-100000-a', { parent: 'T-20260101-090000-epic' }),
  card('T-20260101-100001-b', { parent: 'T-20260101-090000-epic', status: 'in_progress' }),
];

// ---- 红→绿：同 parent 同 assignee 空 target 的兄弟卡 ----

test('红→绿：兄弟卡（同 parent/assignee、空 target）旧口径误报、新口径不判 duplicates', () => {
  // 旧口径复现：两卡机械键相同 ⇒ 旧代码会判 1 组 duplicates（= 误报的「红」）
  const red = oldDuplicates(SIBLINGS);
  assert.equal(red.length, 1, '旧口径应按机械键撞车判红（红条件复现）');
  assert.equal(idemKey(SIBLINGS[0]), idemKey(SIBLINGS[1]), '兄弟卡 mech key 必须相同');
  assert.equal(red[0].key, 'task | linus | T-20260101-090000-epic | ');

  // 新口径：不再判 duplicates，降级为非阻断 hint（= 修复后的「绿」）
  const r = scanIdem(tasksOf(mkRoot(SIBLINGS)));
  assert.equal(r.ok, true);
  assert.equal(r.duplicates.length, 0, `兄弟卡不应判红：${JSON.stringify(r.duplicates)}`);
  assert.equal(r.exempt.length, 0);
  assert.equal(r.hints.length, 1, '应降级为 1 组 hints（仍可见，非静默丢弃）');
  assert.equal(r.hints[0].idem, 'task | linus | T-20260101-090000-epic | ');
  assert.equal(r.hints[0].reason, SIBLING_HINT_REASON);
  assert.deepEqual(r.hints[0].cards.map((c) => c.id).sort(), ['T-20260101-100000-a', 'T-20260101-100001-b']);
});

test('红→绿：CLI 对兄弟卡退出 0（无违例报文），stdout 含 hints 明细', () => {
  const root = mkRoot(SIBLINGS);
  const { code, out, err } = runCli(root);
  assert.equal(code, 0, `兄弟卡不应置退出码 1；stderr=${err}`);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.duplicates.length, 0);
  assert.equal(parsed.hints.length, 1);
  assert.match(err, /建卡幂等提示/, '应打印非阻断提示');
  assert.doesNotMatch(err, /建卡幂等违例/, '不应打印违例');
});

test('兄弟卡数量扩充（3 张空 target）仍仅提示、不判红', () => {
  const r = scanIdem(tasksOf(mkRoot([
    ...SIBLINGS,
    card('T-20260101-100002-c', { parent: 'T-20260101-090000-epic', status: 'blocked' }),
  ])));
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.hints.length, 1);
  assert.equal(r.hints[0].cards.length, 3);
});

// ---- 真重复（红）必须保持 ----

test('真重复：同 review_of + 同 assignee + 同 target ⇒ 仍判 duplicates（退出 1）', () => {
  const dup = [
    card('T-20260101-110000-a', { review_of: 'T-20260101-000000-src', target: '/x' }),
    card('T-20260101-110001-b', { review_of: 'T-20260101-000000-src', target: '/x', status: 'in_review' }),
  ];
  const root = mkRoot(dup);
  const r = scanIdem(tasksOf(root));
  assert.equal(r.hints.length, 0, 'review_of 有实义 ⇒ 不入 hints');
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].idem, 'task | linus | T-20260101-000000-src | /x');
  assert.equal(r.duplicates[0].cards.length, 2);

  const { code, out, err } = runCli(root);
  assert.equal(code, 1, `真重复应置退出码 1；stdout=${out}`);
  assert.equal(JSON.parse(out).duplicates.length, 1);
  assert.match(err, /建卡幂等违例/);
  // --no-baseline 对真重复等价（基线为空 ⇒ 不豁免）
  assert.equal(runCli(root, ['--no-baseline']).code, 1);
});

// ---- D3（T-20261010-081140 裁定）：非空 target 的兄弟卡**不**降级 ----
// 同一 idem 键 ⇒ 同一 target 字符串；非空且相同 target = 「同人同目标」真实区分信号 ⇒ 维持 duplicates（红）。
// 口径见 check-idem.mjs 头注「非空 target 的兄弟卡」。

test('D3 裁定：同 parent + 同**非空** target 的兄弟卡 ⇒ duplicates（红，不降级为 hints）', () => {
  const root = mkRoot([
    card('T-20260101-120000-a', { parent: 'T-20260101-090000-epic', target: '/repo/meerkat' }),
    card('T-20260101-120001-b', { parent: 'T-20260101-090000-epic', target: '/repo/meerkat' }),
  ]);
  const r = scanIdem(tasksOf(root));
  assert.equal(r.hints.length, 0, '非空同 target 有区分信号 ⇒ 不得降级为 hints');
  assert.equal(r.duplicates.length, 1, '同人同目标（非空）仍属真重复档');
  assert.equal(r.duplicates[0].idem, 'task | linus | T-20260101-090000-epic | /repo/meerkat');

  // 退出码契约：duplicates ⇒ 1（只有 hints 才是不置码的非阻断档）
  const { code, out, err } = runCli(root);
  assert.equal(code, 1, `非空同 target 兄弟卡应置退出码 1；stderr=${err}`);
  const parsed = JSON.parse(out);
  assert.equal(parsed.duplicates.length, 1);
  assert.equal(parsed.hints.length, 0);
  assert.match(err, /建卡幂等违例/, '应打印违例（而非提示）');
  assert.doesNotMatch(err, /建卡幂等提示/, '不得打印 hints 提示');
});

test('D3 边界：同 parent 但**不同**非空 target ⇒ 键不同、不分组（区分信号生效的另一面）', () => {
  const r = scanIdem(tasksOf(mkRoot([
    card('T-20260101-121000-a', { parent: 'T-20260101-090000-epic', target: '/repo/meerkat' }),
    card('T-20260101-121001-b', { parent: 'T-20260101-090000-epic', target: '/repo/other' }),
  ])));
  assert.equal(r.hints.length, 0);
  assert.equal(r.duplicates.length, 0, '不同 target ⇒ 键不同 ⇒ 根本不分组');
});

test('边界：兄弟卡组内一张带 review_of ⇒ 整组升为真重复（任一卡有信号即红）', () => {
  const r = scanIdem(tasksOf(mkRoot([
    card('T-20260101-130000-a', { parent: 'T-20260101-090000-epic' }),
    card('T-20260101-130001-b', { parent: 'T-20260101-090000-epic', review_of: 'T-20260101-090000-epic' }),
  ])));
  assert.equal(r.hints.length, 0);
  assert.equal(r.duplicates.length, 1);
});

test('边界：同 assignee/空 target 但 parent 不同 ⇒ 键不同、不分组（既有无 source 口径不回退）', () => {
  const r = scanIdem(tasksOf(mkRoot([
    card('T-20260101-140000-a', { parent: 'T-20260101-090000-e1' }),
    card('T-20260101-140001-b', { parent: 'T-20260101-090000-e2' }),
  ])));
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.hints.length, 0);
});

test('回归：无 source（无 review_of 且无 parent）不产键 ⇒ 同人同 target 两张也不判重', () => {
  const cards = [
    card('T-20260101-150000-a', { target: '/x' }),
    card('T-20260101-150001-b', { target: '/x' }),
  ];
  assert.equal(idemKey(cards[0]), '', '无 source 应返回空键');
  const r = scanIdem(tasksOf(mkRoot(cards)));
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.hints.length, 0);
});

// ---- 基线豁免机制不受收口影响 ----

test('基线：review_of 真重复组注入匹配基线 ⇒ exempt、不判红（机制保留）', () => {
  const root = mkRoot([
    card('T-20260101-160000-a', { review_of: 'T-20260101-000000-bsrc', target: '/x' }),
    card('T-20260101-160001-b', { review_of: 'T-20260101-000000-bsrc', target: '/x', status: 'in_review' }),
  ]);
  const key = 'task | linus | T-20260101-000000-bsrc | /x';
  const r = scanIdem(tasksOf(root), { baseline: [{ key, ids: ['T-20260101-160001-b', 'T-20260101-160000-a'], reason: '注入组' }] });
  assert.equal(r.duplicates.length, 0, '命中基线 ⇒ 不判红');
  assert.equal(r.exempt.length, 1);
  assert.equal(r.exempt[0].key, key);
  // 集合变化（加第 3 张）⇒ 豁免失效、重判红
  fs.writeFileSync(path.join(tasksOf(root), 'T-20260101-160002-c.md'),
    cardText(card('T-20260101-160002-c', { review_of: 'T-20260101-000000-bsrc', target: '/x', status: 'blocked' })), 'utf8');
  const drift = scanIdem(tasksOf(root), { baseline: [{ key, ids: ['T-20260101-160001-b', 'T-20260101-160000-a'], reason: '注入组' }] });
  assert.equal(drift.exempt.length, 0);
  assert.equal(drift.duplicates.length, 1);
});

test('基线/hints 解耦：兄弟卡组不消耗基线豁免；同 root 内真重复组照常红', () => {
  const root = mkRoot([
    ...SIBLINGS,
    card('T-20260101-170000-a', { review_of: 'T-20260101-000000-csrc', target: '/y' }),
    card('T-20260101-170001-b', { review_of: 'T-20260101-000000-csrc', target: '/y' }),
  ]);
  const bkey = 'task | linus | T-20260101-000000-csrc | /y';
  // 只给真重复组登记基线 ⇒ 兄弟卡仍为 hint（非阻断，无需登记），真重复组豁免
  const r = scanIdem(tasksOf(root), { baseline: [{ key: bkey, ids: ['T-20260101-170000-a', 'T-20260101-170001-b'], reason: '注入组' }] });
  assert.equal(r.hints.length, 1);
  assert.equal(r.exempt.length, 1);
  assert.equal(r.duplicates.length, 0);
  // 不注入基线（等价空/退役基线）⇒ 真重复组判红，兄弟卡仍仅提示
  const plain = scanIdem(tasksOf(root), { baseline: [] });
  assert.equal(plain.hints.length, 1);
  assert.equal(plain.duplicates.length, 1);
  assert.equal(plain.duplicates[0].idem, bkey);
});

// ---- 终态卡不参与分组 ----

test('终态卡不入组：两张兄弟卡其中一张 done ⇒ 不产 hint、不判红', () => {
  const r = scanIdem(tasksOf(mkRoot([
    card('T-20260101-180000-a', { parent: 'T-20260101-090000-epic' }),
    card('T-20260101-180001-b', { parent: 'T-20260101-090000-epic', status: 'done' }),
  ])));
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.hints.length, 0);
});
