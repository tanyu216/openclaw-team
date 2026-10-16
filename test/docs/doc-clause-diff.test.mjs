/**
 * doc-clause-diff.test.mjs — `doc-clause-diff.mjs` 的回归套件。
 *
 * 为什么要有：这个工具是文档层压缩时**唯一**能机检「条款没丢」的东西。它自己静默失准
 * （某轴不再抽取、allowlist 粒度失效、整文件删除被读成静默通过）＝ 安全网消失，而它坏了
 * 没人会知道 —— 因为「没报错」正是它的正常输出。故用反证钉住四条：**注入删除必须被抓到**。
 *
 * 运行：node --test test/docs/doc-clause-diff.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAtoms, compareFile } from './doc-clause-diff.mjs';

const EMPTY = { files: {}, atoms: {} };

test('extractAtoms：四轴各自抽取，且 codes 与 tokens 不相交', () => {
  const a = extractAtoms([
    '- The card must not reach `in_review` before `task.claim` — see `PROTOCOL §⑥.4`.',
    '- Refuse with `base_unresolved:<ref>` and `OPENCLAW_LANE_BASE`; cap `64 KiB` / `30 days`.',
    '- 拒绝码 `lane_isolation_failed(<i>):serialize_or_fix`。',
  ].join('\n'));

  assert.ok(a.codes.has('in_review'), 'codes 轴须收到 snake_case 目标态');
  assert.ok(a.codes.has('base_unresolved'), 'codes 轴须收到拒绝码');
  assert.ok(a.codes.has('lane_isolation_failed'), 'codes 轴须收到带参拒绝码');
  assert.ok(a.tokens.has('task.claim'), 'tokens 轴须收到反引号标识符');
  assert.ok(a.tokens.has('OPENCLAW_LANE_BASE'), 'tokens 轴须收到全大写环境变量');
  assert.ok(a.refs.has('§⑥.4'), 'refs 轴须收到 § 编号引用');
  assert.ok(a.numbers.has('64KiB'), 'numbers 轴须收到带单位阈值');
  assert.ok(a.numbers.has('30days'), 'numbers 轴须收到带单位时长');
  // 不相交：纯 snake_case 只归 codes，不重复计入 tokens（否则报告对同一条重报两次）。
  assert.ok(!a.tokens.has('in_review'), '纯 snake_case 不得同时计入 tokens');
});

test('extractAtoms：围栏不跳过（JSON 骨架字段名是被钉死的条款），但标题轴跳过围栏', () => {
  const a = extractAtoms([
    '```json',
    '{ "first_seen": "…", "observed_by": "…" }',
    '# not a heading',
    '```',
    '## Real Heading',
  ].join('\n'));
  assert.ok(a.codes.has('first_seen'), '围栏内字段名必须被抽取');
  assert.ok(a.codes.has('observed_by'), '围栏内字段名必须被抽取');
  assert.ok(a.headings.has('Real Heading'), '围栏外标题应被收取');
  assert.ok(!a.headings.has('not a heading'), '围栏内 shell 注释不得被读成标题');
});

test('compareFile：注入的条款删除被抓到，且按轴归类', () => {
  const before = [
    '- Refuse with `base_unresolved:<ref>` (see `§⑥.4`); cap `64 KiB`.',
    '- A card must not be set to `in_review`.',
  ].join('\n');
  const after = '- Refuse with `base_unresolved:<ref>` (see `§⑥.4`); cap `64 KiB`.\n';  // 删掉第二行

  const { entry, unaccountedTotal } = compareFile('team/guides/x.md', before, after, EMPTY);
  assert.equal(unaccountedTotal, 1, '注入删除须恰好产生 1 条未登记缺失');
  assert.deepEqual(entry.unaccounted.codes, ['in_review'], '缺失须落在 codes 轴');
  assert.equal(entry.deleted, false);
});

test('compareFile：整份文件删除 ⇒ base 版全部原子视为缺失（不得静默通过）', () => {
  const before = '- Rule: refuse with `base_unresolved`; see `§⑥.4`; cap `64 KiB`.\n';
  const { entry, unaccountedTotal } = compareFile('team/guides/gone.md', before, null, EMPTY);
  assert.equal(entry.deleted, true, '须标记为已删除');
  assert.ok(unaccountedTotal >= 3, '删除一份文档须报出全部原子缺失，而不是零');
  assert.ok(entry.unaccounted.refs.includes('§⑥.4'));
});

test('compareFile：改写不丢原子 ⇒ 零缺失（本工具不得对正常改写误报）', () => {
  const before = '- **Rule**: a lane must not be started without a claim (`base_unresolved` is refused, `§⑥.4`), and the cap is `64 KiB`.\n';
  const after = '- A lane needs a claim: `base_unresolved` refused (`§⑥.4`); cap `64 KiB`.\n';  // 同一组原子、不同表达
  const { unaccountedTotal } = compareFile('team/guides/x.md', before, after, EMPTY);
  assert.equal(unaccountedTotal, 0, '同原子不同表达的改写不得报红');
});

test('allowlist：精确登记与整轴登记都生效，未登记的仍判红', () => {
  const before = '- cap `64 KiB`; refuse `base_unresolved`; see `§⑥.4`.\n';
  const after = '- cap `64 KiB`.\n';

  const exact = { files: {}, atoms: { 'f.md:codes:base_unresolved': '精确登记（理由）' } };
  const r1 = compareFile('f.md', before, after, exact);
  assert.ok(!r1.entry.unaccounted.codes, '精确登记的 codes 应被豁免');
  assert.equal(r1.unaccountedTotal, 1, '未登记的 § 引用仍判红');
  assert.deepEqual(r1.entry.unaccounted.refs, ['§⑥.4']);

  const whole = { files: { 'f.md': { codes: '整轴登记（理由）', refs: '整轴登记（理由）' } }, atoms: {} };
  assert.equal(compareFile('f.md', before, after, whole).unaccountedTotal, 0, '整轴登记应全部豁免');
});

test('allowlist：整轴登记不越界到别的文件', () => {
  const before = '- refuse `base_unresolved`.\n';
  const after = '- done.\n';
  const allow = { files: { 'other.md': { codes: '别的文件的登记' } }, atoms: {} };
  assert.equal(compareFile('f.md', before, after, allow).unaccountedTotal, 1, '登记须按文件隔离');
});

test('软轴（标题）：只报告，不判红', () => {
  const before = '## Old Heading\n- refuse `base_unresolved`.\n';
  const after = '## New Heading\n- refuse `base_unresolved`.\n';
  const { entry, unaccountedTotal } = compareFile('f.md', before, after, EMPTY);
  assert.equal(unaccountedTotal, 0, '标题改名不得判红');
  assert.ok(entry.missing.headings.includes('Old Heading'), '但须报告出来');
});
