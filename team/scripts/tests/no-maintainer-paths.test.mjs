/**
 * no-maintainer-paths.test.mjs — 开源仓不得残留维护者本机路径（机检，防回潮）
 *
 * 为什么要有这条：这个仓是**分发给任何人**的团队搭建指南，文档/注释/测试里出现某台机器的
 * `/<user>/…` 绝对路径，对读者是噪声、对作者是信息泄漏（2026-10-15 一次性清了 11 个文件）。
 * 清理会回潮（复制粘贴、新写的示例），所以把它钉成一条测试。
 *
 * 扫描面：仓内全部文本文件（跳过 .git 与二进制）。判据：出现 `/Users/<字母>` 这一形态。
 * 允许：合成夹具（如测试里的 `/home/tester`）与文档中的占位写法（`<repo>` / `<team>` / `$HOME`）。
 * 注意本文件自身**不能**含该字面量（否则自我命中），故用拼接构造针。
 *
 * Run: node --test team/scripts/tests/no-maintainer-paths.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS, '..', '..', '..');
const NEEDLE = '/Us' + 'ers/';            // 拼接：避免本文件自我命中
const NEEDLE_RE = new RegExp('/Us' + 'ers/[A-Za-z]');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;   // 按名字跳过：linked worktree 里 `.git` 是**文件**（内容是维护者路径）
    if (e.isDirectory()) yield* walk(path.join(dir, e.name));
    else if (e.isFile()) yield path.join(dir, e.name);
  }
}

test('仓内文本文件不得出现维护者本机路径（/Users/<name>）', () => {
  const hits = [];
  for (const p of walk(REPO)) {
    let buf;
    try { buf = fs.readFileSync(p); } catch { continue; }
    if (buf.includes(0)) continue;                       // 二进制（含 NUL）跳过
    const text = buf.toString('utf8');
    if (!text.includes(NEEDLE)) continue;
    text.split('\n').forEach((line, i) => {
      if (NEEDLE_RE.test(line)) hits.push(`${path.relative(REPO, p)}:${i + 1}  ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], `发现维护者本机路径（请改为 <repo> / $HOME / 合成夹具）：\n${hits.join('\n')}`);
});
