#!/usr/bin/env node
/**
 * lint-impl-names.mjs — 术语抽象门禁（task-interface v1 §1）
 * 上层文档不得出现「实现名」；实现名只许出现在 PROTOCOL §1（基座 spec）与 ACL/代码内部。
 * 扫描范围：PROTOCOL.md（跳过 §1 节）、各角色 AGENTS.md、ROLES.md、guides/redlines.core.md
 * 用法：node lint-impl-names.mjs [--repo <R> | --live] [--report]
 *       --repo <R> / 仓内自动判定 ⇒ 扫仓内种子；实例在场 ⇒ live（行为与历史一致）
 *       --report  只报告不失败（基线）
 * 退出码：0 无违例；1 有违例；2 用法错或模式不可判定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROLES, resolveMode, UsageError } from './host-paths.mjs';

let M;
try { M = resolveMode(); } catch (e) {
  if (e instanceof UsageError) { console.error(`✗ ${e.message}`); process.exit(2); }
  throw e;
}
const shrink = (p) => p.replace(M.home, '~').replace(M.repo, '<repo>');
const docRoot = M.mode === 'repo' ? path.join(M.repo, 'team') : M.team;
const BANNED = [
  { re: /claim\.mjs/g, name: 'claim.mjs' },
  { re: /poll\.mjs/g, name: 'poll.mjs' },
  { re: /\blib\.mjs\b/g, name: 'lib.mjs' },
  { re: /writeCardAtomic/g, name: 'writeCardAtomic' },
];

function files() {
  const list = [];
  const proto = path.join(docRoot, 'PROTOCOL.md');
  if (fs.existsSync(proto)) list.push({ path: proto, skipSection: '## 1.' });
  // L1 第二册（§21 起，产品/工程门禁）：同样是 L1，实现名一样不得出现。
  const gates = path.join(docRoot, 'PROTOCOL-gates.md');
  if (fs.existsSync(gates)) list.push({ path: gates });
  for (const a of ROLES) {
    const p = M.mode === 'repo' ? path.join(M.repo, 'roles', a, 'AGENTS.md') : path.join(M.home, `workspace-${a}`, 'AGENTS.md');
    if (fs.existsSync(p)) list.push({ path: p });
  }
  for (const g of ['ROLES.md', 'guides/redlines.core.md']) {
    const p = path.join(docRoot, g);
    if (fs.existsSync(p)) list.push({ path: p });
  }
  return list;
}

function skipRanges(text, heading) {
  // 返回需跳过的 [start,end) 行区间（§1 节）
  const lines = text.split('\n');
  const hi = lines.findIndex((l) => l.startsWith(heading));
  if (hi === -1) return null;
  let end = lines.length;
  for (let i = hi + 1; i < lines.length; i++) if (/^## \d+\./.test(lines[i])) { end = i; break; }
  return [hi, end];
}

let total = 0;
const hits = [];
for (const f of files()) {
  const text = fs.readFileSync(f.path, 'utf8');
  const lines = text.split('\n');
  const skip = f.skipSection ? skipRanges(text, f.skipSection) : null;
  let fence = false;
  lines.forEach((line, i) => {
    if (skip && i >= skip[0] && i < skip[1]) return;      // 跳过基座 spec 节
    if (/^\s*```/.test(line)) fence = !fence;            // 跳过代码围栏内
    if (fence) return;
    const prev = i > 0 ? lines[i - 1] : '';
    if (/^\s*```/.test(prev)) return;
    for (const b of BANNED) {
      b.re.lastIndex = 0;
      if (b.re.test(line)) { hits.push(`${shrink(f.path)}:${i + 1}  [${b.name}]  ${line.trim().slice(0, 100)}`); total++; }
    }
  });
}

console.log(hits.length ? hits.join('\n') : '无实现名泄漏 ✔');
console.log(`\n违例合计：${total}`);
const reportOnly = process.argv.includes('--report');
process.exit(reportOnly || total === 0 ? 0 : 1);
