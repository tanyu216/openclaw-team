#!/usr/bin/env node
/**
 * samefile-guard.test.mjs — 同文件并发告警测试（反证：同文件并发告警触发）
 *
 * 背景（T-20261009-211234-concurrencyharden）：同文件多卡并发写 + 连带提交。本套件验证
 * samefile-guard 按非终态卡的声明写集（writes 字段，缺省退化为 target）报出重叠，供串行/worktree 决策。
 * 运行：node --test scripts/tests/samefile-guard.test.mjs
 */
import { test as nodeTest, after, beforeEach } from 'node:test';
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

// 前置：先设 env，再动态 import（TASKS_DIR 于模块加载期读取）
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-samefile-'));
process.env.OPENCLAW_TEAM_ROOT = ROOT;
const TASKS = path.join(ROOT, 'tasks');
fs.mkdirSync(TASKS, { recursive: true });

// provider 依赖为**条件动态 import**：缺 provider 时 samefile-guard.mjs/lib.mjs 在 import 期即硬红。
let samefileConflicts, VOCAB;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ samefileConflicts } = await import('../samefile-guard.mjs'));
  // 规范词表真源（provider ACL 库；check-idem.mjs 同口径）：供「集内即规范在飞词」对拍用。
  VOCAB = await import(pathToFileURL(path.join(PROVIDER, 'lib', 'task.mjs')).href);
}
// 非终态判据现由词表模块持有（零依赖 ⇒ 无条件 import）；第 10 例即对拍它与 provider 词表的一致性。
const { NON_TERMINAL } = await import('../status.mjs');

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
// 每测清空看板，避免跨测卡积累干扰判定
beforeEach(() => {
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
});

function writeCard(id, { status = 'ready', target = '', writes = null } = {}) {
  const lines = [`id: ${id}`, 'title: sf', 'assignee: linus', `status: ${status}`, 'project: __team__'];
  if (target) lines.push(`target: ${target}`);
  if (writes && writes.length) lines.push(`writes: [${writes.join(', ')}]`);
  fs.writeFileSync(path.join(TASKS, `${id}.md`), `---\n${lines.join('\n')}\n---\nbody\n`);
}

test('1. 两卡写集重叠 ⇒ 报出 overlap（同文件并发告警）', () => {
  writeCard('T-20260101-030001-a', { writes: ['team/scripts/lib.mjs', 'team/scripts/poll.mjs'] });
  writeCard('T-20260101-030001-b', { writes: ['team/scripts/poll.mjs', 'team/guides/task-interface.md'] });

  const r = samefileConflicts({ card: 'T-20260101-030001-a' });
  assert.equal(r.ok, true);
  assert.equal(r.conflicts.length, 1, `应 1 条冲突，实际 ${JSON.stringify(r)}`);
  assert.deepEqual(r.conflicts[0].overlap, ['team/scripts/poll.mjs']);
  assert.equal(r.conflicts[0].b.id, 'T-20260101-030001-b');
});

test('2. 写集不相交 ⇒ 无冲突', () => {
  writeCard('T-20260101-030002-a', { writes: ['team/scripts/lib.mjs'] });
  writeCard('T-20260101-030002-b', { writes: ['team/scripts/poll.mjs'] });

  const r = samefileConflicts({ card: 'T-20260101-030002-a' });
  assert.equal(r.conflicts.length, 0, `应无冲突，实际 ${JSON.stringify(r)}`);
});

test('3. 缺省退化 target：同 target 视为同资源 ⇒ 报出', () => {
  writeCard('T-20260101-030003-a', { target: '/live/team' });
  writeCard('T-20260101-030003-b', { target: '/live/team' });

  const r = samefileConflicts({ card: 'T-20260101-030003-a' });
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0].overlap, ['/live/team']);
});

test('4. 终态卡不参与判定（done 排除）', () => {
  writeCard('T-20260101-030004-a', { status: 'ready', writes: ['x.md'] });
  writeCard('T-20260101-030004-b', { status: 'done', writes: ['x.md'] });

  const r = samefileConflicts({ card: 'T-20260101-030004-a' });
  assert.equal(r.conflicts.length, 0, 'done 卡不应触发同文件告警');
});

test('5. --card 过滤：只报与该卡有关的重叠；全板扫描（无 card）也成对去重', () => {
  writeCard('T-20260101-030005-a', { writes: ['x.md'] });
  writeCard('T-20260101-030005-b', { writes: ['x.md'] });
  writeCard('T-20260101-030005-c', { writes: ['y.md'] });

  const r = samefileConflicts({ card: 'T-20260101-030005-a' });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].b.id, 'T-20260101-030005-b');

  const all = samefileConflicts({});
  const ab = all.conflicts.filter((c) => (c.a.id === 'T-20260101-030005-a' && c.b.id === 'T-20260101-030005-b') || (c.a.id === 'T-20260101-030005-b' && c.b.id === 'T-20260101-030005-a'));
  assert.equal(ab.length, 1, '全板扫描应恰好报出 a-b 一对（不重复）');
});

// ── T-20261014-214625-2：`todo`（canonical 新卡词）必须在非终态集内 ──────────────
// 红（修前实测）：集内用 legacy 词 `ready` 顶替 canonical `todo` ⇒ `status: todo` 的卡
// 对写集重叠扫描**完全隐形**（`card_not_found_or_terminal`）。以下 6/7/8 用例修前 6、8 必红。

test('6. `status: todo`（canonical）卡参与写集重叠 ⇒ 报出（修前：隐形，报 0 冲突）', () => {
  writeCard('T-20260101-030006-a', { status: 'in_progress', writes: ['team/scripts/lib.mjs'] });
  writeCard('T-20260101-030006-b', { status: 'todo', writes: ['team/scripts/lib.mjs'] });

  const r = samefileConflicts({ card: 'T-20260101-030006-a' });
  assert.equal(r.conflicts.length, 1, `todo 卡应参与重叠判定，实际 ${JSON.stringify(r)}`);
  assert.equal(r.conflicts[0].b.id, 'T-20260101-030006-b');
  assert.deepEqual(r.conflicts[0].overlap, ['team/scripts/lib.mjs']);
});

test('7. `status: ready`（legacy 别名）仍参与 ⇒ 兼容不回退', () => {
  writeCard('T-20260101-030007-a', { status: 'in_progress', writes: ['team/scripts/lib.mjs'] });
  writeCard('T-20260101-030007-b', { status: 'ready', writes: ['team/scripts/lib.mjs'] });

  const r = samefileConflicts({ card: 'T-20260101-030007-a' });
  assert.equal(r.conflicts.length, 1, `ready 卡应继续参与，实际 ${JSON.stringify(r)}`);
  assert.equal(r.conflicts[0].b.id, 'T-20260101-030007-b');
});

test('8. `--card <todo 卡>`：todo 卡自己有写集 ⇒ 可作查询主体（修前：card_not_found_or_terminal）', () => {
  writeCard('T-20260101-030008-a', { status: 'todo', writes: ['x.md'] });
  writeCard('T-20260101-030008-b', { status: 'in_progress', writes: ['x.md'] });

  const r = samefileConflicts({ card: 'T-20260101-030008-a' });
  assert.equal(r.note, undefined, `todo 卡不应被判为 not_found_or_terminal，实际 ${JSON.stringify(r)}`);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].b.id, 'T-20260101-030008-b');
});

test('9. 负向：终态 `done` 与未排期 `backlog` 都不参与（守卫未被放宽）', () => {
  for (const st of ['done', 'failed', 'canceled', 'backlog']) {
    for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
    writeCard('T-20260101-030009-a', { status: 'in_progress', writes: ['x.md'] });
    writeCard('T-20260101-030009-b', { status: st, writes: ['x.md'] });
    const r = samefileConflicts({ card: 'T-20260101-030009-a' });
    assert.equal(r.conflicts.length, 0, `${st} 卡不应参与同文件告警，实际 ${JSON.stringify(r)}`);
  }
});

// ── 词表对拍（「消除同类再犯」的机器闸）────────────────────────────────────────
// 正向枚举必然会漂移：本套件把「集内 == 规范在飞词 ∪ 兼容别名」逐值钉死 —— 将来 provider 词表
// 增删（或本集拼错一个词）会在这里**变红**，而不是让某类卡静默隐形（本次缺陷的根因）。
test('10. 词表对拍：集内 ⊇（CANONICAL − 终态 − `backlog`），且多出来的**只有**声明的兼容别名', () => {
  assert.ok(VOCAB, 'provider 词表应可用');
  const { CANONICAL_STATUSES, TERMINAL_STATUSES, ACCEPTED_STATUSES } = VOCAB;
  const NOT_SCHEDULED = 'backlog';
  const canonicalInFlight = CANONICAL_STATUSES.filter((s) => !TERMINAL_STATUSES.has(s) && s !== NOT_SCHEDULED);

  // ① 规范「在飞」词一个都不能漏（修前 `todo` 正落在这里 ⇒ 本断言红）
  for (const s of canonicalInFlight) {
    assert.ok(NON_TERMINAL.has(s), `规范在飞词 ${s} 必须在非终态集内（漏掉它 = 该类卡对并发判定隐形）`);
  }
  // ② 负向：终态 + 未排期一律不在集内（守卫不得被放宽）
  for (const s of [...TERMINAL_STATUSES, NOT_SCHEDULED]) {
    assert.ok(!NON_TERMINAL.has(s), `${s} 不得计入非终态`);
  }
  // ③ 多出来的成员**只允许**是显式登记的兼容别名（`ready` = `todo` 的旧词，live 旧卡仍在用）
  const extras = [...NON_TERMINAL].filter((s) => !canonicalInFlight.includes(s)).sort();
  assert.deepEqual(extras, ['ready'], '除规范在飞词外，只允许登记在案的兼容别名（新增别名须在此显式加白）');
  // ④ 集内每个词都得是 provider 认识的词（挡拼写漂移，如 `in_reviw`）
  for (const s of NON_TERMINAL) {
    assert.ok(ACCEPTED_STATUSES.has(s), `集内词 ${s} 不在 provider 接受词表里（拼写漂移？）`);
  }
});
