#!/usr/bin/env node
/**
 * lint-refs.mjs — §引用可解析（PROTOCOL 编号）：扫 AGENTS.md / ROLES.md / guides/redlines.core.md
 * 仅校验「圈号 §①…§⑳（可带 .N 子号）」，阿拉伯 §N 视为他文档小节、忽略。
 * 退出码：0 全解析；1 有断引用；2 用法错或模式不可判定。
 * 模式（判定见 host-paths.mjs）：实例在场 ⇒ **live**（行为与历史一致）；否则 ⇒ **repo**：
 *   扫仓内种子 `<repo>/roles/<role>/AGENTS.md` + `<repo>/team/**`，不读本机实例。
 * 用法：node lint-refs.mjs [--repo <R> | --live]
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
// 文档面在两种模式下来自不同的树：live = 安装实例（<team>/** + <home>/workspace-<r>/），
// repo = 分发仓（<repo>/team/** + <repo>/roles/<r>/）。
const docRoot = M.mode === 'repo' ? path.join(M.repo, 'team') : M.team;
const P = fs.readFileSync(path.join(docRoot, 'PROTOCOL.md'), 'utf8');

const targets = [];
for (const a of ROLES) {
  const p = M.mode === 'repo' ? path.join(M.repo, 'roles', a, 'AGENTS.md') : path.join(M.home, `workspace-${a}`, 'AGENTS.md');
  if (fs.existsSync(p)) targets.push(p);
}
for (const g of ['ROLES.md', 'guides/redlines.core.md']) {
  const p = path.join(docRoot, g);
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
      if (!ok) { console.log(`✗ ${shrink(p)}:${i + 1} 断引用 §${target}`); bad++; }
    }
  });
}
console.log(bad ? `\n断引用：${bad}` : '§引用全部可解析 ✔');
process.exit(bad ? 1 : 0);
