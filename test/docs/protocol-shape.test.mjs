/**
 * protocol-shape.test.mjs — PROTOCOL.md 的「形状」回归门。
 *
 * 为什么存在：本轮把 §6/§9/§10 的执行细节下沉到 guides，但四处结构是不可动的：
 *   1. `## 1. Board Protocol` 的标题形状（lint-impl-names.mjs 精确跳过 `## 1.`）；
 *   2. §6 / §6.1 / §9.1 / §10.5 的顶层有序列表（lint-doc-refs.mjs 按位置解析 `§N clause M`）；
 *   3. §15 / §15.1 的切片形状（sla-scan.mjs 结构化解析 `## 15.` 与 `> 6h`）；
 *   4. §9.1 的三个 Addendum 锚字符串（多份 AGENTS/guide 按散文引用）。
 * 后续每一次搬移都必须先过这道门；否则 linter 可能「静默跳过」而不是报红。
 *
 * 另外记录**体积预算**（warning 级）：超预算只打印 diagnostic，不判红。
 *
 * 运行：node --test test/docs/protocol-shape.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const PROTOCOL = path.join(REPO, 'team', 'PROTOCOL.md');
const ENGINEERING = path.join(REPO, 'team', 'guides', 'engineering-standards-sop.md');
const WORKTREE = path.join(REPO, 'team', 'guides', 'dev-worktree-flow-sop.md');
const UIALIGN = path.join(REPO, 'team', 'guides', 'ui-align-sop.md');
const FLOWTRIAGE = path.join(REPO, 'team', 'guides', 'flow-triage-sop.md');

const text = fs.readFileSync(PROTOCOL, 'utf8');
const lines = text.split('\n');
const engineering = fs.readFileSync(ENGINEERING, 'utf8');
const engineeringLines = engineering.split('\n');
const worktree = fs.readFileSync(WORKTREE, 'utf8');
const worktreeLines = worktree.split('\n');
const uialign = fs.readFileSync(UIALIGN, 'utf8');
const uialignLines = uialign.split('\n');
const flowtriage = fs.readFileSync(FLOWTRIAGE, 'utf8');
const flowtriageLines = flowtriage.split('\n');

/**
 * 取一个节的正文：从匹配 `startRe` 的标题之后，到**下一个任意级标题**之前。
 * 围栏内的 `## ` 不是标题（§6 里就有 `## Segment N ...` 的示例块）。
 * 关键：不能只按 `## ` 切 —— 那会把 §6.0/§6.1/§6.2 的条目一并算进 §6。
 */
function bodyOf(src, startRe) {
  const i = src.findIndex((l) => startRe.test(l));
  if (i < 0) return null;
  let fence = false;
  const out = [];
  for (let j = i + 1; j < src.length; j++) {
    const l = src[j];
    if (/^\s*```/.test(l)) {
      fence = !fence;
      out.push(l);
      continue;
    }
    if (!fence && /^#{2,6}\s/.test(l)) break;
    out.push(l);
  }
  return out;
}
const sectionBody = (startRe) => bodyOf(lines, startRe);

const ordered = (body) => (body || []).filter((l) => /^\d{1,3}\.\s/.test(l));

test('§1 标题形状不变（lint-impl-names 精确跳过 `## 1.`）', () => {
  assert.match(text, /^## 1\. Board Protocol\s*$/m);
});

test('§6 正文仍是 8 条，且主题顺序不变', () => {
  const items = ordered(sectionBody(/^## 6\./));
  assert.equal(items.length, 8, `§6 正文应为 8 条，实测 ${items.length}`);
  const expected = [
    /reconcile/i,
    /Concurrency caps/i,
    /Spawn mode/i,
    /poll the subsession/i,
    /\*\.out\.jsonl/,
    /single source of truth/i,
    /Task management boundary/i,
    /Resume preference/i,
  ];
  expected.forEach((re, i) => {
    assert.match(items[i], re, `§6 第 ${i + 1} 条主题漂移`);
  });
});

test('§6.1 是指针节，正文在 engineering-standards-sop.md，仍是 14 条且主题顺序不变', () => {
  const pointer = (sectionBody(/^### 6\.1/) || []).join('\n');
  assert.match(pointer, /Normative body\*\*: `guides\/engineering-standards-sop\.md` §6\.1/,
    '§6.1 必须指向 engineering-standards-sop.md §6.1');
  const items = ordered(bodyOf(engineeringLines, /^## §6\.1/));
  assert.equal(items.length, 14, `指南 §6.1 应为 14 条，实测 ${items.length}`);
  const expected = [
    /TDD first/,
    /coverage ≥ 80%/,
    /Mock boundary/,
    /Integration tests required/,
    /Self-proving loop/,
    /Requirement-completeness acceptance/,
    /Four-stage development loop/,
    /Two mandatory checks for historically frequent defects/,
    /Test resource leftover cleanup/,
    /Test-case scenario authenticity check/,
    /Document reference convention/,
    /CI gate and release/,
    /Requirement.{1,3}implementation conformance/,
    /Linus frontend tech-stack default/,
  ];
  expected.forEach((re, i) => {
    assert.match(items[i], re, `§6.1 第 ${i + 1} 条主题漂移`);
  });
});

test('§6.4 是指针节，正文在 dev-worktree-flow-sop.md，仍是 6 条 bullet', () => {
  const pointer = (sectionBody(/^### 6\.4/) || []).join('\n');
  assert.match(pointer, /Normative body\*\*: `guides\/dev-worktree-flow-sop\.md` §6\.4/,
    '§6.4 必须指向 dev-worktree-flow-sop.md §6.4');
  const bullets = (bodyOf(worktreeLines, /^## §6\.4/) || []).filter((l) => /^- \*\*/.test(l));
  assert.equal(bullets.length, 6, `指南 §6.4 应为 6 条 bullet，实测 ${bullets.length}`);
  const expected = [
    /Development integrates/,
    /main checkout holds `dev`/,
    /Isolation is the lane's own act/,
    /The branch is based on `dev`/,
    /must be merged into `dev` before the card is closed/,
    /Never commit on the protected branch/,
  ];
  expected.forEach((re, i) => {
    assert.match(bullets[i], re, `§6.4 第 ${i + 1} 条主题漂移`);
  });
});

test('§9.1 是指针节，正文在 ui-align-sop.md，hard gate 仍是 6 条（Addenda 的 `> 1.` 不计）', () => {
  const pointer = (sectionBody(/^### 9\.1/) || []).join('\n');
  assert.match(pointer, /Normative body\*\*: `guides\/ui-align-sop\.md` §9\.1/,
    '§9.1 必须指向 ui-align-sop.md §9.1');
  const items = ordered(bodyOf(uialignLines, /^## §9\.1/));
  assert.equal(items.length, 6, `指南 §9.1 顶层有序条目应为 6，实测 ${items.length}`);
});

test('§9.1 三线防御表仍是 Before/During/After 三行', () => {
  const table = (bodyOf(uialignLines, /^## §9\.1/) || []).filter((l) => l.startsWith('|'));
  assert.equal(table.length, 5, `指南 §9.1 表格行应为 5（表头+分隔+3 数据），实测 ${table.length}`);
  for (const line of ['Before', 'During', 'After']) {
    assert.ok(table.some((l) => l.includes(`| **${line}** |`)), `§9.1 三线表缺少 ${line} 行`);
  }
});

test('§10.5 是指针节，正文在 flow-triage-sop.md，quality spine 仍是 5 条', () => {
  const pointer = (sectionBody(/^### 10\.5/) || []).join('\n');
  assert.match(pointer, /Normative body\*\*: `guides\/flow-triage-sop\.md` §10\.5/,
    '§10.5 必须指向 flow-triage-sop.md §10.5');
  const items = ordered(bodyOf(flowtriageLines, /^## §10\.5/));
  assert.equal(items.length, 5, `指南 §10.5 顶层有序条目应为 5，实测 ${items.length}`);
});

test('§10.5 路由表、报告表与 hard boundary 原样存在', () => {
  const body = (bodyOf(flowtriageLines, /^## §10\.5/) || []).join('\n');
  for (const flow of ['A · feature / design-bearing', 'B · defect / behaviour fix', 'C · UI micro-change / detail']) {
    assert.ok(body.includes(`| **${flow}** |`), `§10.5 路由表缺少 ${flow} 行`);
  }
  for (const flow of ['A', 'B', 'C']) {
    assert.ok(body.includes(`| **${flow}** |`), `§10.5 报告表缺少 ${flow} 行`);
  }
  assert.ok(body.includes('**Hard boundary (any one ⇒ always A, never B/C)**'), '§10.5 缺少 hard boundary');
  assert.ok(body.includes('The chain may shrink; the spine may not'), '§10.5 缺少「chain 可缩、spine 不可缩」');
});

test('§15 表仍是 6 个数据行（含表头/分隔共 8 行 `|`）', () => {
  const body = sectionBody(/^## 15\./);
  const table = (body || []).filter((l) => l.startsWith('|'));
  assert.equal(table.length, 8, `§15 表格行应为 8（表头+分隔+6 数据），实测 ${table.length}`);
  assert.equal(table.length - 2, 6, '§15 数据行应为 6');
});

test('§15.1 仍含 `> 6h` 边界（sla-scan 解析）', () => {
  const body = sectionBody(/^### 15\.1/);
  assert.ok(body, '§15.1 标题必须存在');
  assert.match(body.join('\n'), />\s*6h/);
});

test('§9.1 三个 Addendum 锚字符串原样存在（在指针目标指南里）', () => {
  assert.ok(uialign.includes('§9.1 Addendum:'), '缺少 §9.1 Addendum:');
  assert.ok(uialign.includes('§9.1 Addendum II:'), '缺少 §9.1 Addendum II:');
  assert.ok(uialign.includes('§9.1 Addendum III:'), '缺少 §9.1 Addendum III:');
});

test('体积预算（warning 级，不判红）', (t) => {
  // 阈值 = 2026-10 瘦身后的实测 + 少量余量：用于防反弹，不是"再压到此值"的目标。
  // 继续下降需要动共享规范（§6.1/§6.4/§9.1/§10.5），风险高于收益。
  const budgets = [
    ['team/PROTOCOL.md', 93 * 1024],
    ['team/PROTOCOL-gates.md', 20 * 1024],
    ['roles/elon/AGENTS.md', 15 * 1024],
    ['roles/jobs/AGENTS.md', 13 * 1024],
    ['roles/linus/AGENTS.md', 21 * 1024],
    ['roles/turing/AGENTS.md', 13 * 1024],
    ['roles/assistant/AGENTS.md', 13 * 1024],
  ];
  for (const [rel, budget] of budgets) {
    const p = path.join(REPO, rel);
    if (!fs.existsSync(p)) continue;
    const size = fs.statSync(p).size;
    if (size > budget) {
      t.diagnostic(`WARN 体积超预算：${rel} = ${size} B > ${budget} B`);
    }
  }
  assert.ok(true);
});
