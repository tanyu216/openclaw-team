#!/usr/bin/env node
/**
 * lint-impl-names.mjs — 术语抽象门禁（task-interface v1 §1）
 * 上层文档不得出现「实现名」；实现名只许出现在 PROTOCOL §①（基座 spec）与 ACL/代码内部。
 * 扫描范围：team/PROTOCOL.md（跳过 §① 节）、workspace-<role>/AGENTS.md、team/ROLES.md、team/guides/redlines.core.md
 * 用法：node lint-impl-names.mjs            # 报告 + 违例即 exit 1
 *       node lint-impl-names.mjs --report   # 只报告不失败（基线）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const TEAM = path.join(HOME, '.openclaw', 'team');
const BANNED = [
  { re: /claim\.mjs/g, name: 'claim.mjs' },
  { re: /poll\.mjs/g, name: 'poll.mjs' },
  { re: /\blib\.mjs\b/g, name: 'lib.mjs' },
  { re: /writeCardAtomic/g, name: 'writeCardAtomic' },
];

function files() {
  const list = [];
  const proto = path.join(TEAM, 'PROTOCOL.md');
  if (fs.existsSync(proto)) list.push({ path: proto, skipSection: '## ①' });
  for (const a of ['elon', 'jobs', 'linus', 'turing', 'assistant']) {
    const p = path.join(HOME, `.openclaw/workspace-${a}/AGENTS.md`);
    if (fs.existsSync(p)) list.push({ path: p });
  }
  for (const g of ['ROLES.md', 'guides/redlines.core.md']) {
    const p = path.join(TEAM, g);
    if (fs.existsSync(p)) list.push({ path: p });
  }
  return list;
}

function skipRanges(text, heading) {
  // 返回需跳过的 [start,end) 行区间（§① 节）
  const lines = text.split('\n');
  const hi = lines.findIndex((l) => l.startsWith(heading));
  if (hi === -1) return null;
  let end = lines.length;
  for (let i = hi + 1; i < lines.length; i++) if (/^## [①-⑳]/.test(lines[i])) { end = i; break; }
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
      if (b.re.test(line)) { hits.push(`${f.path.replace(HOME, '~')}:${i + 1}  [${b.name}]  ${line.trim().slice(0, 100)}`); total++; }
    }
  });
}

console.log(hits.length ? hits.join('\n') : '无实现名泄漏 ✔');
console.log(`\n违例合计：${total}`);
const reportOnly = process.argv.includes('--report');
process.exit(reportOnly || total === 0 ? 0 : 1);
