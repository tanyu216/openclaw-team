#!/usr/bin/env node
/**
 * check-relations.mjs — 关系不变量巡检（子任务卡与依赖 DAG；纳入 check-all）
 * 校验（对齐基座 task-panel）：自指/父子环/父存在/父须 epic/依赖存在/禁祖先/扇入/依赖环/
 * 依赖链长≤8/父链长≤8/空 epic。**不再设单层/嵌套 epic 限制**（支持多层，中间节点须为 epic）。
 * 深链（父链长 ≥5）为软告警：打印告警但**不改退出码**。
 * 退出码：0 通过；1 有 hard 违例。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, TASKS_DIR } from './lib.mjs';

const TASKS = TASKS_DIR;
const MAX_CHAIN = 8, MAX_FANIN = 8, DEEP_CHAIN_WARN = 5;

function parseList(raw) {
  if (typeof raw !== 'string') return [];
  const s = raw.trim().replace(/^\[|\]$/g, '').replace(/["']/g, '');
  return s.split(/[\s,]+/).filter(Boolean);
}

const cards = {};
if (fs.existsSync(TASKS)) {
  for (const f of fs.readdirSync(TASKS)) {
    if (!f.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(TASKS, f), 'utf8');
    const { fm } = parseFrontmatter(raw);
    const id = (fm && fm.id) || f.replace(/\.md$/, '');
    cards[id] = { ...(fm || {}), id };
  }
}
const ids = Object.keys(cards);
const bad = [];
const warn = [];
const parentOf = (id) => (cards[id] && cards[id].parent) || '';
const depsOf = (id) => parseList(cards[id] && cards[id].depends_on);
const anc = (id) => { const a = []; const seen = new Set([id]); let c = parentOf(id); while (c && !seen.has(c)) { seen.add(c); a.push(c); c = parentOf(c); } return a; };

for (const id of ids) {
  const fm = cards[id]; const deps = depsOf(id);
  const par = parentOf(id);
  const ancList = anc(id);
  if (par === id) bad.push(`${id} self_ref(parent)`);
  if (deps.includes(id)) bad.push(`${id} self_ref(dep)`);
  if (par) { const p = cards[par]; if (!p) bad.push(`${id} parent_missing`); else if ((p.kind || 'task') !== 'epic') bad.push(`${id} parent_not_epic`); }
  if (ancList.includes(id)) bad.push(`${id} parent_cycle`);
  // 父链长度（对齐基座：根=1，即 id 到 root 路径上卡数）：>8 hard；≥5 软告警（不改退出码）
  if (par) {
    const chainLen = ancList.length + 1;
    if (chainLen > MAX_CHAIN) bad.push(`${id} parent_chain_too_long`);
    else if (chainLen >= DEEP_CHAIN_WARN) warn.push(`${id}(${chainLen})`);
  }
  for (const d of deps) if (!cards[d]) bad.push(`${id} dep_missing:${d}`);
  const a = new Set([...ancList, par]);
  for (const d of deps) if (a.has(d)) bad.push(`${id} dep_on_ancestor:${d}`);
  if (deps.length > MAX_FANIN) bad.push(`${id} fanin_too_high`);
}
// I5 环（Kahn）
{
  const edges = {}; for (const id of ids) edges[id] = new Set(depsOf(id));
  const indeg = {}; for (const id of ids) indeg[id] = indeg[id] || 0;
  for (const id of ids) for (const t of edges[id]) { if (!(t in edges)) { edges[t] = new Set(); indeg[t] = 0; } indeg[t]++; }
  const q = Object.keys(edges).filter((x) => indeg[x] === 0); let seen = 0;
  while (q.length) { const n = q.shift(); seen++; for (const t of edges[n]) if (--indeg[t] === 0) q.push(t); }
  if (seen !== Object.keys(edges).length) bad.push('dep_cycle(detected)');
}
// I9 链长
{
  const memo = {};
  const dfs = (id, st) => { if (memo[id] != null) return memo[id]; if (st.has(id)) return 0; st.add(id); let m = 0; for (const d of depsOf(id)) m = Math.max(m, 1 + dfs(d, st)); st.delete(id); memo[id] = m; return m; };
  let mx = 0; for (const id of ids) mx = Math.max(mx, dfs(id, new Set()));
  if (mx > MAX_CHAIN) bad.push(`chain_too_long(${mx})`);
}
// I12 空 epic
for (const id of ids) if ((cards[id].kind || 'task') === 'epic' && !ids.some((x) => parentOf(x) === id)) bad.push(`${id} empty_epic`);

console.log(bad.length ? bad.join('\n') : `关系校验通过 ✔（${ids.length} 卡）`);
if (warn.length) console.log(`\n⚠ 深链告警：${warn.join('、')}（父链长 ≥${DEEP_CHAIN_WARN}；软护栏，不阻断）`);
console.log(bad.length ? `\n违例：${bad.length}` : '');
process.exit(bad.length ? 1 : 0);
