#!/usr/bin/env node
/**
 * lint-refs.mjs — §引用可解析（PROTOCOL 编号）：扫 AGENTS.md / ROLES.md / guides/redlines.core.md
 * 仅校验「圈号 §①…§⑳（可带 .N 子号）」，阿拉伯 §N 视为他文档小节、忽略。
 * 退出码：0 全解析；1 有断引用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const TEAM = path.join(HOME, '.openclaw/team');
const P = fs.readFileSync(path.join(TEAM, 'PROTOCOL.md'), 'utf8');

const targets = [];
for (const a of ['elon', 'jobs', 'linus', 'turing', 'simons', 'assistant']) {
  const p = path.join(HOME, `.openclaw/workspace-${a}/AGENTS.md`);
  if (fs.existsSync(p)) targets.push(p);
}
for (const g of ['ROLES.md', 'guides/redlines.core.md']) {
  const p = path.join(TEAM, g);
  if (fs.existsSync(p)) targets.push(p);
}

let bad = 0;
for (const p of targets) {
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    for (const mm of line.matchAll(/§([①-⑳])(?:\.([0-9]))?/g)) {
      const base = mm[1]; const sub = mm[2];
      const target = sub ? `${base}.${sub}` : base;
      const ok = sub ? (P.includes(`### ${target}`) || P.includes(`## ${target}`)) : P.includes(`## ${base}`);
      if (!ok) { console.log(`✗ ${p.replace(HOME, '~')}:${i + 1} 断引用 §${target}`); bad++; }
    }
  });
}
console.log(bad ? `\n断引用：${bad}` : '§引用全部可解析 ✔');
process.exit(bad ? 1 : 0);
