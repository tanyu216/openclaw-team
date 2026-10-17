/**
 * lint-doc-refs.test.mjs — 指针节（PROTOCOL §17 规则 6）的第三腿行为。
 *
 * 为什么存在：Track B 把若干 L1 节的**正文**移入团队级 L2.5 指南，L1 只留
 * `> **Normative body**: `guides/x.md` §N` 指针。若第三腿（`§N clause M` / `§N step M` /
 * `§N #M`）不跟随指针，所有 clause 引用会静默变成 `no-list` skip —— 门禁看着绿，实际失守。
 * 本测试钉住：跟随、无指针、成环、目标不存在四种行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { itemIndex } from '../../team/scripts/lint-doc-refs.mjs';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ldr-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return { root, protocol: path.join(root, 'PROTOCOL.md') };
}

test('指针节：跟随 Normative body 到指南的同名 §N 节数条目', () => {
  const { protocol } = fixture({
    'PROTOCOL.md': '# P\n\n## 6.1 Section\n\n> **Normative body**: `guides/foo.md` §6.1\n',
    'guides/foo.md': '# G\n\n## §6.1 Section\n\n1. one\n2. two\n3. three\n',
  });
  assert.deepEqual(itemIndex(protocol, '6.1'), { ok: true, count: 3 });
});

test('无指针且无有序列表 ⇒ no-list（保持原 skip 口径）', () => {
  const { protocol } = fixture({
    'PROTOCOL.md': '# P\n\n## 6.1 Section\n\nJust prose, no list and no pointer.\n',
  });
  assert.deepEqual(itemIndex(protocol, '6.1'), { ok: false, why: 'no-list' });
});

test('指针成环 ⇒ pointer-loop（不递归爆栈）', () => {
  const { protocol } = fixture({
    'PROTOCOL.md': '# P\n\n## 6.1 Section\n\n> **Normative body**: `guides/foo.md` §6.1\n',
    'guides/foo.md': '# G\n\n## §6.1 Section\n\n> **Normative body**: `PROTOCOL.md` §6.1\n',
  });
  assert.deepEqual(itemIndex(protocol, '6.1'), { ok: false, why: 'pointer-loop' });
});

test('指针目标不存在 ⇒ 退回 no-list（不误报）', () => {
  const { protocol } = fixture({
    'PROTOCOL.md': '# P\n\n## 6.1 Section\n\n> **Normative body**: `guides/missing.md` §6.1\n',
  });
  assert.deepEqual(itemIndex(protocol, '6.1'), { ok: false, why: 'no-list' });
});
