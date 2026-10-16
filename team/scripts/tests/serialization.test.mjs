#!/usr/bin/env node
/**
 * serialization.test.mjs — 列表字段序列化口径（T-20261009-035200-teambackfill-depfix）
 *
 * 不变量：`depends_on`/`subsession_ids` 等列表字段**一律序列化为数组形式**
 *   （空 ⇒ `[]`，非空 ⇒ `[a, b]`）；读取端向后兼容旧裸空格串（`a b`）。
 * 直接 import 真实实现（不 mock），全部临时文件走 os.tmpdir()，经 OPENCLAW_TEAM_ROOT 隔离。
 * 运行：node --test scripts/tests/*.test.mjs
 *
 * provider 依赖：lib.mjs / task.mjs 依赖 provider ACL 库 skills/task-ops/lib/*（provider 拥有、有意不
 * 随仓，见 skills/PROVENANCE.md）；lib.mjs 启动即检测其可用性，缺失 ⇒ process.exit(1)。故对
 * `../lib.mjs` 的静态相对导入在缺 provider 时 import 期即硬红（整文件 fail）。缺 provider 时依赖它的
 * 用例整体 SKIP（与 archive.test.mjs / check-idem.test.mjs / sched-vendored-poll.test.mjs 同契约）。
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 定位携带 ACL 库的 provider 安装目录（与 archive.test.mjs / check-idem.test.mjs 同口径）。 */
function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    // 部署布局相对候选：<team>/skills/task-ops（自 tests/ 上溯两级）—— 不读宿主 ~/.openclaw
    path.resolve(import.meta.dirname, '..', '..', 'skills', 'task-ops'),
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
const test = SKIP ? nodeTest.skip : nodeTest;

// lib.mjs / task.mjs 在 import 时读取 OPENCLAW_TEAM_ROOT ⇒ 必须先设环境变量再动态 import
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-serial-'));
process.env.OPENCLAW_TEAM_ROOT = tmp;
const TASKS = path.join(tmp, 'tasks');
fs.mkdirSync(TASKS, { recursive: true });
fs.mkdirSync(path.join(TASKS, '.locks'), { recursive: true });

// provider 依赖为**条件动态 import**：缺 provider 时静态导入在 import 期即 process.exit(1) 硬红。
let serializeFrontmatter, parseFrontmatter, t;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ serializeFrontmatter, parseFrontmatter } = await import('../lib.mjs'));
  t = await import(pathToFileURL(path.join(PROVIDER, 'lib', 'task.mjs')).href);
}

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BODY = '\n## Background\nx\n## Acceptance\n- [ ] a\n## Progress\n## Comments\n## Sessions\n## Report\n';
const cardText = (id) => fs.readFileSync(path.join(TASKS, `${id}.md`), 'utf8');
const fieldRe = (key) => new RegExp(`^${key}: (.*)$`, 'm');
const fieldOf = (text, key) => {
  const m = fieldRe(key).exec(text);
  return m ? m[1] : undefined;
};
function baseFm(id) {
  return [`id: ${id}`, 'title: t', 'assignee: linus', 'status: ready', 'priority: medium', 'goal: g', 'project: __team__'].join('\n');
}
function writeCard(id, extra = '') {
  fs.writeFileSync(path.join(TASKS, `${id}.md`), `---\n${baseFm(id)}${extra}\n---\n${BODY}`, 'utf8');
}

// 依赖目标卡（depend/spawn 需要它们已存在）
const D1 = 'T-20260101-200000-d1';
const D2 = 'T-20260101-200001-d2';
writeCard(D1);
writeCard(D2);

// ---- serializeFrontmatter ---------------------------------------------------
test('serializeFrontmatter：数组值 → [a, b]，空数组 → []', () => {
  const s1 = serializeFrontmatter({ __order: ['id', 'depends_on'], id: 'T-0', depends_on: ['a', 'b'] }, 'body\n');
  assert.equal(fieldOf(s1, 'depends_on'), '[a, b]', '非空数组应渲染为 [a, b]（id 元素不加引号）');
  const s2 = serializeFrontmatter({ __order: ['id', 'depends_on'], id: 'T-0', depends_on: [] }, 'body\n');
  assert.equal(fieldOf(s2, 'depends_on'), '[]', '空数组应渲染为 []（不得省略/退化为裸串）');
});

test('serializeFrontmatter：数组值 round-trip 幂等（5 轮字节不变）', () => {
  const fm = { __order: ['id', 'depends_on', 'subsession_ids'], id: 'T-0', depends_on: ['T-1', 'T-2'], subsession_ids: [] };
  const s0 = serializeFrontmatter(fm, 'body\n');
  let cur = s0;
  for (let i = 0; i < 5; i++) {
    const { fm: f2, body } = parseFrontmatter(cur);
    cur = serializeFrontmatter(f2, body);
  }
  assert.equal(cur, s0, '数组值序列化后反复 round-trip 应字节稳定');
  assert.deepEqual(t.parseList(parseFrontmatter(s0).fm.depends_on), ['T-1', 'T-2'], '读回后可还原为列表');
});

// ---- task.mjs 写入点 --------------------------------------------------------
const SUBJ = 'T-20260101-200002-subj';

test('depend：写入 depends_on: [a, b]（数组形式，非裸空格串）', () => {
  writeCard(SUBJ, '\ndepends_on: []');
  const r = t.depend(SUBJ, [D1, D2]);
  assert.equal(r.ok, true);
  const txt = cardText(SUBJ);
  assert.equal(fieldOf(txt, 'depends_on'), `[${D1}, ${D2}]`, 'depends_on 应为数组形式');
  assert.doesNotMatch(txt, new RegExp(`^depends_on: ${D1} ${D2}$`, 'm'), '不得写裸空格串');
});

test('undepend：清空后 depends_on 为 []（不写空串/不省略）', () => {
  const r = t.undepend(SUBJ, [D1, D2]);
  assert.equal(r.ok, true);
  const txt = cardText(SUBJ);
  assert.equal(fieldOf(txt, 'depends_on'), '[]', '清空 ⇒ []');
  assert.match(txt, fieldRe('depends_on'), '字段必须存在（不得省略）');
});

const EPIC = 'T-20260101-200004-epic';

test('spawn：depends_on / subsession_ids 写数组形式（有依赖与空依赖）', () => {
  writeCard(EPIC, '\nkind: epic');
  // 注：spawn 现已带建卡幂等守卫（task-interface §14）——同父同 assignee+target 的第二张会被拒（dup）。
  // 本用例只验「列表字段序列化」，故两子卡给不同 target 以派生出不同 idem 键。
  const withDep = t.spawn(EPIC, { title: 'c1', assignee: 'linus', goal: 'g1', depends_on: [D1], target: 'serial-c1' });
  assert.equal(withDep.ok, true);
  const t1 = cardText(withDep.id);
  assert.equal(fieldOf(t1, 'depends_on'), `[${D1}]`, 'spawn 有依赖 ⇒ depends_on: [d]');
  assert.equal(fieldOf(t1, 'subsession_ids'), '[]', 'spawn 空 subsession_ids ⇒ []');
  assert.doesNotMatch(t1, new RegExp(`^depends_on: ${D1}$`, 'm'), '不得写裸串');

  const noDep = t.spawn(EPIC, { title: 'c2', assignee: 'linus', goal: 'g2', target: 'serial-c2' });
  assert.equal(noDep.ok, true);
  assert.equal(fieldOf(cardText(noDep.id), 'depends_on'), '[]', 'spawn 无依赖 ⇒ depends_on: []');
});

const RS = 'T-20260101-200005-rs';
const RS_EMPTY = 'T-20260101-200007-rsempty';

test('registerSubsession：subsession_ids 写数组形式 [x, y] 与 []', () => {
  writeCard(RS, '\nsubsession_ids: []');
  t.registerSubsession(RS, 'seg-1');
  t.registerSubsession(RS, 'seg-2');
  const txt = cardText(RS);
  assert.equal(fieldOf(txt, 'subsession_ids'), '[seg-1, seg-2]', '两次登记 ⇒ [seg-1, seg-2]');
  assert.doesNotMatch(txt, /^subsession_ids: seg-1 seg-2$/m, '不得写裸空格串');

  writeCard(RS_EMPTY, '\nsubsession_ids: []');
  t.registerSubsession(RS_EMPTY); // 无 sessionId ⇒ 保持空数组
  assert.equal(fieldOf(cardText(RS_EMPTY), 'subsession_ids'), '[]', '空 ⇒ []');
});

// ---- 向后兼容（旧裸空格串） -------------------------------------------------
const OLD = 'T-20260101-200006-old';

test('向后兼容：旧裸空格串 depends_on/subsession_ids 仍可解析，回写后 subsession_ids 变数组', () => {
  writeCard(OLD, `\ndepends_on: ${D1} ${D2}\nsubsession_ids: seg-old`);
  const r = t.read(OLD);
  assert.deepEqual(t.parseList(r.fm.depends_on), [D1, D2], '裸空格串 depends_on 应可解析');
  assert.deepEqual(t.deps(OLD).depends_on, [D1, D2], 'deps 应正常返回');
  assert.deepEqual(t.parseSubsessions(r.fm.subsession_ids), ['seg-old'], '裸串 subsession_ids 应可解析');

  const rr = t.registerSubsession(OLD, 'seg-new');
  assert.equal(rr.ok, true);
  const txt = cardText(OLD);
  assert.equal(fieldOf(txt, 'subsession_ids'), '[seg-old, seg-new]', '回写后 subsession_ids 应为数组形式');
  assert.deepEqual(t.parseSubsessions(t.read(OLD).fm.subsession_ids), ['seg-old', 'seg-new'], '兼容读回三相形态');
});
