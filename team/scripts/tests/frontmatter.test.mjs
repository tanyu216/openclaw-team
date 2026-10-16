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

// ---- 测试 4：写卡护栏（口径 = frontmatter 膨胀比值 + `## Report` 绝对上限） --------
// T-20261015-025543-3（D8）：旧口径「整文件 4× 比值」既拦不住它命名的事故（大卡上 FM 翻倍被
// 正文稀释 ⇒ 只读作 ~1.005×），又误伤合法长 Report（新 Report 标准 29KB/3KB = 9.70×）。
const reportSection = (raw) => {
  const lines = raw.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^## Report[ \t]*$/.test(lines[i])) { start = i; continue; }
    if (start >= 0 && /^## /.test(lines[i])) { end = i; break; }
  }
  return start < 0 ? 0 : Buffer.byteLength(lines.slice(start, end).join('\n'), 'utf8');
};

test('护栏 A：frontmatter 乘性膨胀（事故 T-20261008-214730 形态）被拒 —— 原文件不变、无 tmp', () => {
  const dir = mkScratch();
  const card = path.join(dir, `${CARD_ID}.md`);
  const fmOf = (n) => ({
    __order: ['id', 'title'],
    id: CARD_ID,
    title: 'guard-baseline',
    // 模拟旧实现的转义翻倍：标题里的 `\` 逐轮复制 ⇒ frontmatter 块乘性增长
    note: '\\"'.repeat(n),
  });
  fs.writeFileSync(card, serializeFrontmatter(fmOf(1), 'body\n'), 'utf8');
  const before = fs.readFileSync(card);

  assert.throws(
    () => writeCardAtomic(card, fmOf(400), 'body\n'), // FM 块 ≫ 1.5× 且增量 ≫ 1 KiB
    (err) => {
      assert.match(String(err.message), /拒绝写入：疑似 frontmatter 转义膨胀/);
      assert.ok(err.message.includes(card), '错误信息应含卡路径');
      assert.match(err.message, /fm_prev=\d+B fm_next=\d+B/);
      assert.match(err.message, /ratio=[\d.]+x > 1\.5x/);
      assert.match(err.message, /\+(\d+)B > 1024B/);
      return true;
    },
    '应抛错拒绝 frontmatter 膨胀写'
  );
  assert.ok(before.equals(fs.readFileSync(card)), '原文件应字节不变（无部分写入）');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp.')), [], '不应残留 tmp 文件');
});

test('护栏 A：事故形态逐轮倍增，在有限轮内被拦（不是「永远差一点」）', () => {
  const dir = mkScratch();
  const card = path.join(dir, `${CARD_ID}.md`);
  const fmOf = (esc) => ({ __order: ['id', 'title'], id: CARD_ID, title: 't', note: esc });
  let esc = '\\"';
  fs.writeFileSync(card, serializeFrontmatter(fmOf(esc), 'body\n'), 'utf8');
  let rounds = 0;
  let caught = false;
  for (; rounds < 12; rounds++) {
    esc = esc + esc; // 每轮翻倍（旧实现的行为）
    try {
      writeCardAtomic(card, fmOf(esc), 'body\n');
    } catch (err) {
      assert.match(String(err.message), /疑似 frontmatter 转义膨胀/);
      caught = true;
      break;
    }
  }
  assert.ok(caught, `事故形态应在有限轮内被拦，实测 ${rounds} 轮仍未拦`);
});

test('护栏 B：`## Report` 段 > 64 KiB 被拒（写期强制 guide §6 上限）', () => {
  const dir = mkScratch();
  const card = path.join(dir, `${CARD_ID}.md`);
  const fm = { __order: ['id', 'title'], id: CARD_ID, title: 'guard-baseline' };
  fs.writeFileSync(card, serializeFrontmatter(fm, '\n## Report\nsmall\n'), 'utf8');
  const before = fs.readFileSync(card);

  // 正文总量 ≫ 64 KiB，但全部落在 `## Report` 段内
  assert.throws(
    () => writeCardAtomic(card, fm, `\n## Report\n${'z'.repeat(64 * 1024 + 1)}\n`),
    (err) => {
      assert.match(String(err.message), /拒绝写入：`## Report` 段超上限/);
      assert.ok(err.message.includes(card));
      assert.match(err.message, /report=\d+B > 65536B=64KiB/);
      return true;
    },
    '应抛错拒绝超限 Report'
  );
  assert.ok(before.equals(fs.readFileSync(card)), '原文件应字节不变');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp.')), [], '不应残留 tmp 文件');
});

test('护栏 B 边界：恰好 64 KiB 的 `## Report` 可写，超 1B 即拒', () => {
  const dir = mkScratch();
  const card = path.join(dir, `${CARD_ID}.md`);
  const fm = { __order: ['id', 'title'], id: CARD_ID, title: 't' };
  const body = (n) => `\n## Report\n${'z'.repeat(n)}\n`;
  // 先量出「段 = 64 KiB」所需的正文长度，再在边界两侧各测一次
  const head = reportSection(body(0));           // `\n## Report\n` + `\n` 的段内开销
  const fill = 64 * 1024 - head;
  writeCardAtomic(card, fm, body(fill));
  assert.equal(reportSection(fs.readFileSync(card, 'utf8')), 64 * 1024, '恰好 64 KiB 应可写');
  assert.throws(() => writeCardAtomic(card, fm, body(fill + 1)), /`## Report` 段超上限/);
});

test('护栏 B 不追溯：已超限的历史 Report 不被无关写入冻结（也不阻止收缩）', () => {
  const dir = mkScratch();
  const card = path.join(dir, `${CARD_ID}.md`);
  const fm = { __order: ['id', 'title'], id: CARD_ID, title: 't' };
  // 落一张「历史遗留」超限卡（模拟 161 KiB Report 的 T-20261012-012736）：**直接写盘**，
  // 模拟守卫存在之前就已落地的卡 —— 守卫不接受新写的超限 Report，故不能用 writeCardAtomic 造前置。
  fs.writeFileSync(card, serializeFrontmatter(fm, `\n## Report\n${'z'.repeat(70 * 1024)}\n`), 'utf8');
  const legacy = fs.readFileSync(card, 'utf8');
  assert.ok(reportSection(legacy) > 64 * 1024, '前置：该卡 Report 已超限');

  // 无关写入（心跳/评论等价物）：Report 段不变 ⇒ 应放行
  writeCardAtomic(card, { ...fm, heartbeat_at: '2026-01-01T00:00:00.000Z' }, `\n## Report\n${'z'.repeat(70 * 1024)}\n`);
  assert.match(fs.readFileSync(card, 'utf8'), /heartbeat_at:/, '超限历史卡不应被无关写入冻结');

  // 收缩到上限内：放行
  writeCardAtomic(card, { ...fm, heartbeat_at: '2026-01-01T00:00:00.000Z' }, `\n## Report\n${'z'.repeat(1024)}\n`);
  assert.ok(reportSection(fs.readFileSync(card, 'utf8')) <= 64 * 1024);

  // 再次顶过上限：拒
  assert.throws(
    () => writeCardAtomic(card, fm, `\n## Report\n${'z'.repeat(70 * 1024)}\n`),
    /`## Report` 段超上限/
  );
});

test('护栏：D8 回归 —— 合法长 Report（29KB 写入 3KB 卡，旧口径 9.70x 被拒）现应写入', () => {
  const dir = mkScratch();
  const card = path.join(dir, `${CARD_ID}.md`);
  const fm = { __order: ['id', 'title'], id: CARD_ID, title: 'guard-baseline' };
  // 复刻 D8 现场：3 003B 的卡 + 29 136B 的 Report
  fs.writeFileSync(card, serializeFrontmatter(fm, 'x'.repeat(3003 - serializeFrontmatter(fm, '').length)), 'utf8');
  const prevSize = fs.statSync(card).size;
  const report = 'B'.repeat(29136); // 29 136B = D8 现场的报告体量
  writeCardAtomic(card, fm, `\n\n## Report\n${report}\n`);
  const after = fs.readFileSync(card, 'utf8');
  assert.equal(reportSection(after), B(`## Report\n${report}\n`), 'Report 段应原样落盘');
  assert.ok(B(after) > prevSize * 9, `整文件应确实 >9×（实得 ${(B(after) / prevSize).toFixed(2)}×）—— 旧口径必拒`);
});

test('护栏 A 假阳性边界：合法 FM 增长（同 write 内新增字段 ≲1 KiB）不受限', () => {
  const dir = mkScratch();
  const card = path.join(dir, `${CARD_ID}.md`);
  const fm = { __order: ['id', 'title'], id: CARD_ID, title: 't' };
  fs.writeFileSync(card, serializeFrontmatter(fm, 'body\n'), 'utf8');
  // 比值 >1.5× 但增量 ≤1 KiB ⇒ 合法（实测全生命周期最大 1.248× / +105B）
  writeCardAtomic(card, { ...fm, claimed_by: 'linus', claimed_at: '2026-01-01T00:00:00.000Z', heartbeat_at: '2026-01-01T00:00:00.000Z' }, 'body\n');
  assert.match(fs.readFileSync(card, 'utf8'), /claimed_by: linus/);
  // FM 大幅**缩减**（session 收敛）同样放行
  writeCardAtomic(card, fm, 'body\n');
  assert.equal(fs.readFileSync(card, 'utf8'), serializeFrontmatter(fm, 'body\n'));
});

test('护栏：新卡（无既有文件）不受限 + 正常小幅改写可写', () => {
  const dir = mkScratch();
  const fresh = path.join(dir, 'T-20260101-000001-fresh.md');
  const fm = { __order: ['id', 'title'], id: 'T-20260101-000001-fresh', title: 'fresh' };
  // 新卡：大 body 也照写（无基线可比较）
  writeCardAtomic(fresh, fm, 'y'.repeat(5000));
  assert.equal(fs.readFileSync(fresh, 'utf8').length > 5000, true);

  // 已存在卡的小幅改写：应正常写入
  const small = path.join(dir, `${CARD_ID}.md`);
  fs.writeFileSync(small, serializeFrontmatter(fm, 'body\n'), 'utf8');
  const large = serializeFrontmatter(fm, 'body\n\nmore\n');
  writeCardAtomic(small, fm, 'body\n\nmore\n');
  assert.equal(fs.readFileSync(small, 'utf8'), large, '小幅改写应成功');
});
