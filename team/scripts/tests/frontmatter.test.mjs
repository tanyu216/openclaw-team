#!/usr/bin/env node
/**
 * frontmatter.test.mjs — 任务卡 frontmatter 序列化幂等性 + 写卡护栏回归
 *
 * 背景（事故 T-20261008-214730，8.4MB→…→268MB 指数膨胀）：
 *   parseFrontmatter 只剥外层引号、不做反转义，而 quoteIfNeeded 用 JSON.stringify 包裹
 *   ⇒ 值内含 \ 或 " 时，每次「读→回写」把转义层数翻倍。
 *
 * 本套件直接 import 真实实现（不 mock），只读真实卡，全部临时文件走 os.tmpdir()。
 * 运行：node --test scripts/tests/
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 定位携带 ACL 库的 provider 安装目录（与 archive.test.mjs / check-idem.test.mjs 同口径）。 */
function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    path.join(os.homedir(), '.openclaw', 'team', 'skills', 'task-ops'),
    path.join(os.homedir(), '.openclaw', 'skills', 'task-ops'),
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

// provider 依赖为**条件动态 import**：缺 provider 时 lib.mjs 在 import 期即 process.exit(1) 硬红。
let parseFrontmatter, serializeFrontmatter, writeCardAtomic, TASKS_DIR;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ parseFrontmatter, serializeFrontmatter, writeCardAtomic, TASKS_DIR } = await import('../lib.mjs'));
}

const B = (s) => Buffer.byteLength(s, 'utf8');
const CARD_ID = 'T-20260101-000000-fmtest';
const roundtrip = (raw) => {
  const { fm, body } = parseFrontmatter(raw);
  return { out: serializeFrontmatter(fm, body), fm, body };
};

// ---- 测试 1：幂等矩阵 -------------------------------------------------------
// 覆盖普通词 / 含 " / 含 \ / 含 \" / 含 : / 含 # / 前后空白 / 空串 / 整数 / 布尔 / 列表
const VALUES = {
  word: 'hello',
  dquote: 'he said "hi"',
  backslash: 'C:\\Users\\team',
  escaped_quote: 'he said \\"hi\\"',
  colon: 'a: b',
  hash: 'issue #42',
  padded: '  padded  ',
  empty: '',
  integer: 42,
  boolean: true,
  list: '["a","b"]',
};

for (const [key, val] of Object.entries(VALUES)) {
  test(`幂等：${key}（反复 round-trip 稳定且不增长）`, () => {
    // 始终带一个非空伴随键（id），避免「全空 frontmatter 块」这种无法解析的退化形态
    const fm = { __order: ['id', key], id: 'T-0', [key]: val };
    const s0 = serializeFrontmatter(fm, 'body\n');

    // 5 轮 serialize(parse(...))：字节长度恒定、内容与首轮一致
    const lengths = [B(s0)];
    let cur = s0;
    for (let i = 0; i < 5; i++) {
      cur = roundtrip(cur).out;
      lengths.push(B(cur));
    }
    assert.equal(cur, s0, `${key}: 5 轮后应与首轮字节一致（幂等）`);
    assert.deepEqual(lengths, lengths.map(() => lengths[0]), `${key}: 长度不应增长 [${lengths.join(', ')}]`);

    // 值语义还原 + body 原样保留
    const { fm: back, body: bodyBack } = parseFrontmatter(s0);
    assert.equal(bodyBack, 'body\n', `${key}: body 应原样保留`);
    if (val === '') {
      // 序列化约定：空串字段被丢弃（serializeFrontmatter 跳过空值），故还原为 undefined
      assert.equal(back[key], undefined, `${key}: 空值按约定不落盘`);
    } else if (typeof val === 'string') {
      assert.equal(back[key], val, `${key}: parse(serialize(v)) 应等于原值`);
    } else {
      assert.deepEqual(back[key], val, `${key}: 非字符串原值应保持`);
    }
  });
}

test('幂等：全字段合并矩阵 round-trip 稳定', () => {
  const fm = { __order: Object.keys(VALUES), ...VALUES };
  const s0 = serializeFrontmatter(fm, '## Body\n正文\n');
  let cur = s0;
  const seen = [B(s0)];
  for (let i = 0; i < 3; i++) {
    cur = roundtrip(cur).out;
    seen.push(B(cur));
  }
  assert.equal(cur, s0, '合并矩阵 3 轮后字节一致');
  assert.deepEqual(seen, seen.map(() => seen[0]), `合并矩阵长度不应增长 [${seen.join(', ')}]`);
  // 键顺序保持（空值字段按约定被丢弃，故不含 'empty'）
  assert.deepEqual(
    parseFrontmatter(s0).fm.__order,
    Object.keys(VALUES).filter((k) => VALUES[k] !== '')
  );
});

test('回归：含 \\" 的值正是旧实现指数膨胀的触发器，现应恒定', () => {
  const v = 'he said \\"hi\\"';
  const fm = { __order: ['goal'], goal: v };
  let raw = serializeFrontmatter(fm, '');
  const first = B(raw);
  for (let i = 0; i < 20; i++) raw = roundtrip(raw).out;
  assert.equal(B(raw), first, `20 轮后长度应恒为 ${first}B，实际 ${B(raw)}B`);
  assert.equal(parseFrontmatter(raw).fm.goal, v, '值应无损还原');
});

// ---- 测试 2：旧格式兼容 -----------------------------------------------------
test('旧格式：旧代码写的单层 JSON.stringify 值可正确反转义', () => {
  const raw = '---\ngoal: "has \\"quotes\\" inside"\ncreated_at: "2026-01-01T00:00:00.000Z"\n---\nbody\n';
  const { fm, body } = parseFrontmatter(raw);
  assert.equal(fm.goal, 'has "quotes" inside', '应 JSON 反转义为原始字符串');
  assert.equal(fm.created_at, '2026-01-01T00:00:00.000Z');
  // 再序列化应回到同一（单层）形态，且稳定
  const out = serializeFrontmatter(fm, body);
  assert.ok(out.includes('goal: "has \\"quotes\\" inside"'), '应写回单层转义形态');
  assert.equal(roundtrip(out).out, out, '旧格式读入后 round-trip 稳定');
  assert.equal(B(roundtrip(out).out) - B(out), 0, '旧格式不应增长');
});

test('旧格式：单引号值维持旧行为（仅剥外层）', () => {
  const { fm } = parseFrontmatter("---\nnote: 'keep \\\\ raw'\n---\n");
  assert.equal(fm.note, 'keep \\\\ raw', '单引号不反转义');
});

// ---- 测试 3：真实卡只读回归 -------------------------------------------------
test('真实卡回归：round-trip 不膨胀（只读，绝不写盘）', () => {
  const files = fs.existsSync(TASKS_DIR) ? fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.md')) : [];
  console.log(`[real-card] 扫描 ${TASKS_DIR} 下 ${files.length} 张卡`);
  assert.ok(files.length > 0, '未找到任何任务卡');
  for (const f of files) {
    const p = path.join(TASKS_DIR, f);
    const raw = fs.readFileSync(p, 'utf8'); // 只读
    const { fm, body } = parseFrontmatter(raw);
    const out = serializeFrontmatter(fm, body);
    const delta = B(out) - B(raw);
    // 有符号 delta ≤ 8：只拦「膨胀」；负值来自空串字段按约定被丢弃（归一化，非损失）
    assert.ok(delta <= 8, `${f}: round-trip 膨胀 ${delta}B (raw=${B(raw)}B out=${B(out)}B)`);
    if (delta < 0) console.log(`[real-card] ${f}: ${delta}B（空值字段归一化丢弃，正常）`);
  }
});

// ---- 测试 4：写卡护栏 -------------------------------------------------------
const scratchDirs = [];
const mkScratch = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fm-guard-'));
  scratchDirs.push(d);
  return d;
};
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('护栏：输出 >4× 时拒绝写入，且原文件字节不变、无 tmp 残留', () => {
  const dir = mkScratch();
  const card = path.join(dir, `${CARD_ID}.md`);
  const baseFm = { __order: ['id', 'title'], id: CARD_ID, title: 'guard-baseline' };
  fs.writeFileSync(card, serializeFrontmatter(baseFm, 'body\n'), 'utf8');

  const before = fs.readFileSync(card);
  const prevSize = before.length;
  const bigBody = 'x'.repeat(prevSize * 8); // 输出必然 > 4× 上版

  assert.throws(
    () => writeCardAtomic(card, { __order: ['id', 'title'], id: CARD_ID, title: 'guard-baseline' }, bigBody),
    (err) => {
      assert.match(String(err.message), /拒绝写入：疑似 frontmatter 转义膨胀/);
      assert.ok(err.message.includes(card), '错误信息应含卡路径');
      assert.ok(err.message.includes(`prev=${prevSize}B`), '错误信息应含前次大小');
      assert.match(err.message, /ratio=[\d.]+x > 4x/);
      return true;
    },
    '应抛错拒绝膨胀写'
  );

  assert.ok(before.equals(fs.readFileSync(card)), '原文件应字节不变（无部分写入）');
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('.tmp.')),
    [],
    '不应残留 tmp 文件'
  );
});

test('护栏：新卡（无既有文件）不受限制 + 正常小幅改写可写', () => {
  const dir = mkScratch();
  const fresh = path.join(dir, 'T-20260101-000001-fresh.md');
  const fm = { __order: ['id', 'title'], id: 'T-20260101-000001-fresh', title: 'fresh' };
  // 新卡：大 body 也照写（无基线可比较）
  writeCardAtomic(fresh, fm, 'y'.repeat(5000));
  assert.equal(fs.readFileSync(fresh, 'utf8').length > 5000, true);

  // 已存在卡的小幅改写：应正常写入
  const small = path.join(dir, `${CARD_ID}.md`);
  fs.writeFileSync(small, serializeFrontmatter(fm, 'body\n'), 'utf8');
  const large = serializeFrontmatter(fm, 'body\n\nmore\n'); // 远小于 4×
  writeCardAtomic(small, fm, 'body\n\nmore\n');
  assert.equal(fs.readFileSync(small, 'utf8'), large, '小幅改写应成功');
});
