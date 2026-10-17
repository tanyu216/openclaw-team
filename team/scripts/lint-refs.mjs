#!/usr/bin/env node
/**
 * lint-refs.mjs — §引用可解析（PROTOCOL 编号）：扫 AGENTS.md / ROLES.md / guides/redlines.core.md
 * 记法（2026-10-16 阿拉伯化后）：节引用一律 `§` + **阿拉伯**数字（`§15` / `§6.1`）。
 * 判别符是**点名与否**，不是字形：`PROTOCOL §N` 指 L1；**裸 `§N`** 指**本文件自己的**节 ——
 * 而本腿扫的三个目标都没有编号标题（无「自己的节」可言），故裸引用按 PROTOCOL 解析。
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
// L1 是**两册、同一个节编号空间**：§1–§20 在 PROTOCOL.md，§21 起（+ 附录 A）在 PROTOCOL-gates.md。
// `PROTOCOL §N` 与裸 `§N` 一律按两册合计解析，所以合订成一份文本再查标题。
const P = ['PROTOCOL.md', 'PROTOCOL-gates.md']
  .map((f) => path.join(docRoot, f))
  .filter((p) => fs.existsSync(p))
  .map((p) => fs.readFileSync(p, 'utf8'))
  .join('\n');

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
let checked = 0;
for (const p of targets) {
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    // `PROTOCOL §N` 与裸 `§N` 都收（本腿的三个目标无自己的编号节 ⇒ 裸引用即 PROTOCOL）。
    for (const mm of line.matchAll(/(?:PROTOCOL\s*)?§\s*(\d+)(?:\.(\d+))?/g)) {
      // 已点名的另一种写法：`` `<file>.md` §N `` —— § 落在反引号**外**。
      // 那是 lint-doc-refs 第二腿（跨文件章节锚）的职责，本腿不重复判。
      if (!/^PROTOCOL/.test(mm[0]) && /\.md`?\s*$/.test(line.slice(0, mm.index))) continue;
      const base = mm[1]; const sub = mm[2];
      const target = sub ? `${base}.${sub}` : base;
      checked++;
      // 有子号 ⇒ 必须有该子节标题；无子号 ⇒ 该节或其任一子节存在即可。
      const ok = sub
        ? (P.includes(`### ${target}`) || P.includes(`## ${target}`))
        : (P.includes(`## ${base}.`) || P.includes(`### ${base}.`));
      if (!ok) { console.log(`✗ ${shrink(p)}:${i + 1} 断引用 §${target}`); bad++; }
    }
  });
}
console.log(bad ? `\n断引用：${bad}（已检查 ${checked} 条）` : `§引用全部可解析 ✔（已检查 ${checked} 条）`);
process.exit(bad ? 1 : 0);
