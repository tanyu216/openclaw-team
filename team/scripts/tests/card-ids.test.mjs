/**
 * card-ids.test.mjs — 卡身份识别与路径安全的契约。
 *
 * 这一组测的是「去卡命名规则」之后**拿什么替代它**：
 *   · 枚举 = 结构性（`<tasksDir>` 下带 frontmatter `id` 的 `.md`），不是命名形状；
 *   · 引用识别 = 「像某个**看板派生**命名空间下的 id」——必须仍能识别**不存在**的卡，
 *     否则 `ledger_dangling`（正是本次新增 lint-doc-refs 之外的同类防线）无从判起；
 *   · 路径安全 = 「id 是单一路径段」这条**与命名无关**的性质仍然成立。
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 定位携带 ACL 库的 provider 安装目录（与 frontmatter.test.mjs 同口径：**不读宿主 ~/.openclaw**）。 */
function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    // 部署布局相对候选：<team>/skills/task-ops（自 tests/ 上溯两级）
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cardids-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const TASKS = path.join(ROOT, 'tasks');

let readBoardCards, listCardIds, boardNamespaces, isCardId, extractCardIdRefs, cardPathOf, TASKS_DIR;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  process.env.OPENCLAW_TEAM_ROOT = path.join(ROOT, 'team');
  fs.mkdirSync(TASKS, { recursive: true });
  ({ readBoardCards, listCardIds, boardNamespaces, isCardId, extractCardIdRefs } = await import('../card-ids.mjs'));
  ({ cardPathOf, TASKS_DIR } = await import('../lib.mjs'));
}

/** 写一张卡（`id` 为空串 = 故意不是卡）。 */
const write = (name, id, extra = '') => {
  const fm = id === null ? '---\ntitle: no-id\n---\n' : `---\nid: ${id}\ntitle: ${id}\n${extra}---\n`;
  fs.writeFileSync(path.join(TASKS, name), fm, 'utf8');
};

test('readBoardCards：结构性枚举 —— 带 frontmatter id 的 .md 才算卡', { skip: SKIP }, () => {
  write('T-20260101-000001-a.md', 'T-20260101-000001-a');
  write('T-20260101-000002-b.md', 'T-20260101-000002-b', 'status: todo\n');
  write('no-id.md', null);                       // 无 frontmatter id ⇒ 不是卡
  write('.scratch.md', 'T-20260101-000009-z');   // 点号开头 ⇒ 跳过（临时件）
  write('notes.txt', 'T-20260101-000009-y');     // 非 .md ⇒ 跳过
  fs.mkdirSync(path.join(TASKS, 'oc-sub'), { recursive: true });

  const cards = readBoardCards({ tasksDir: TASKS });
  assert.deepEqual(cards.map((c) => c.id).sort(), ['T-20260101-000001-a', 'T-20260101-000002-b']);
  assert.deepEqual([...listCardIds({ tasksDir: TASKS })].sort(), ['T-20260101-000001-a', 'T-20260101-000002-b']);
});

test('readBoardCards：文件名不必等于 id（承载形态归 provider）', { skip: SKIP }, () => {
  write('whatever-name.md', 'T-20260101-000003-c');   // 文件名与 id 不一致
  const ids = [...listCardIds({ tasksDir: TASKS })];
  assert.ok(ids.includes('T-20260101-000003-c'), '身份取自 frontmatter id，而非文件名');
  assert.ok(!ids.includes('whatever-name'), '文件名不得被当成卡 id');
});

test('boardNamespaces / isCardId：命名空间由**看板派生**，不是仓内自撰规则', { skip: SKIP }, () => {
  const ids = new Set(['T-20260101-000001-a']);
  assert.deepEqual([...boardNamespaces({ ids })], ['T-']);
  assert.equal(isCardId('T-20260101-000001-a', { ids }), true, '在看板上 ⇒ 是卡');
  assert.equal(isCardId('T-20260101-999999-ghost', { ids }), true, '形状像看板命名空间、但**不存在** ⇒ 仍是卡引用');
  assert.equal(isCardId('T-20260101-999999-ghost', { ids, allowAbsent: false }), false, '收紧到成员判定 ⇒ 不认');
  assert.equal(isCardId('not-a-card', { ids }), false, '命名空间不属于看板 ⇒ 不是卡');
  assert.equal(isCardId('PROJ-123', { ids }), false, '外部命名空间 ⇒ 不是卡');
});

test('extractCardIdRefs：从散文抽引用；能抽出**不存在**的卡', { skip: SKIP }, () => {
  const ids = new Set(['T-20260101-000001-a']);
  assert.deepEqual(extractCardIdRefs('| T-20260101-000001-a 与 T-20260101-000002-b |', { ids }), ['T-20260101-000001-a', 'T-20260101-000002-b']);
  assert.deepEqual(extractCardIdRefs('（Elon 运维步骤）', { ids }), []);
  assert.deepEqual(extractCardIdRefs('T-20260101-000001-a / T-20260101-000001-a', { ids }), ['T-20260101-000001-a']);
  assert.deepEqual(extractCardIdRefs('| T-20260101-999999-ghost |', { ids }), ['T-20260101-999999-ghost'],
    '看板上不存在但形状属本命名空间 ⇒ 必须抽得出（否则 dangling 无从判起）');
  assert.deepEqual(extractCardIdRefs('not-a-card PROJ-123', { ids }), [], '非本看板命名空间 ⇒ 不抽');
});

test('cardPathOf：id 是**单一路径段**（与命名规则无关的安全性质）', { skip: SKIP }, () => {
  assert.equal(cardPathOf('anything-at-all'), path.join(TASKS_DIR, 'anything-at-all.md'),
    '裸单段参数按 id 拼接 —— **不做形状校验**（形状归 provider）');
  assert.equal(cardPathOf('T-20260101-000001-a'), path.join(TASKS_DIR, 'T-20260101-000001-a.md'));
  // 含分隔符 ⇒ 不再当 id 拼接，走路径分支（此处以不存在而告终，但不落到 TASKS_DIR/...）
  assert.notEqual(cardPathOf('/tmp/card.md'), path.join(TASKS_DIR, '/tmp/card.md.md'));
});

test('cardPathOf：路径分支必须落在 .md 上；`.`/`..`/空值被拒', { skip: SKIP }, () => {
  assert.throws(() => cardPathOf(''), /非法任务卡路径\/id/);
  assert.throws(() => cardPathOf('.'), /非法任务卡路径\/id/, '`.` 含分隔语义的裸段不按 id 拼');
  assert.throws(() => cardPathOf('..'), /非法任务卡路径\/id/);
  assert.throws(() => cardPathOf('/tmp/notacard.json'), /非法任务卡路径\/id/, '非 .md ⇒ 拒');
  assert.equal(cardPathOf('/tmp/some/dir/card.md'), '/tmp/some/dir/card.md', '路径分支只要求 .md');
});
