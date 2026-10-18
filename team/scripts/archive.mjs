#!/usr/bin/env node
// archive.mjs — 归档终态任务卡（PROTOCOL §20.3）
// 用法: node archive.mjs [--days N] [--dry-run]   默认 N=7
// 规则: status ∈ {done, failed} 且 mtime 早于 N 天 → 移到 tasks/archive/YYYY-MM/
// 模式（T-20261010-055607）：
//   默认 = 写操作（真移动文件，mkdir + rename）。
//   --dry-run = 真只读：只统计“将归档”的卡，绝不 mkdir / rename / 改 mtime（可安全用于巡检门禁）。
// 输出契约：
//   默认    archived=<n> (days=<N>)
//   dry-run dry-run (no files moved): would-archive=<n> (days=<N>)
//
// 复杂度（门禁快段预算）：引用保护需要「被 parent / depends_on 指向」的全集。逐候选卡重扫全目录是
// O(N²)（实测 658 卡 × 109 候选 ≈ 72k 次 readFileSync+parse ⇒ 5-7s，把快段顶出 6000ms 门禁预算
// ⇒ 每小时 fast-timeout、门禁恒 UNCONFIRMED）。改为**一次读全表建引用集**（O(N)），判定语义不变：
// 某卡可归档 ⟺ 无**另一张**卡引用它（自引用不算，与旧内扫 `o === f` 跳过同口径，精确匹配非子串）。
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, TASKS_DIR } from './lib.mjs';
import { isTerminal } from './status.mjs';

const TASKS = TASKS_DIR;
const i = process.argv.indexOf('--days');
const DAYS = i >= 0 ? Number(process.argv[i + 1] || 7) : 7;
const DRY = process.argv.includes('--dry-run');
const cutoff = Date.now() - DAYS * 86400 * 1000;

// depends_on 列表解析（与 check-relations / lib.parseDeps 口径一致）
function parseList(raw) {
  if (typeof raw !== 'string') return [];
  const s = raw.trim().replace(/^\[|\]$/g, '').replace(/["']/g, '');
  return s.split(/[\s,]+/).filter(Boolean);
}

if (!fs.existsSync(TASKS)) {
  console.log(DRY ? 'dry-run (no files moved): would-archive=0 (no tasks dir)' : 'archived=0 (no tasks dir)');
  process.exit(0);
}

// 一次读全表（每张卡只读/解析一次）：id → 终态 / mtime / parent / depends_on
const cards = [];
for (const f of fs.readdirSync(TASKS)) {
  if (!f.endsWith('.md')) continue;
  const p = path.join(TASKS, f);
  let st; try { st = fs.statSync(p); } catch { continue; }
  if (!st.isFile()) continue;
  const { fm } = parseFrontmatter(fs.readFileSync(p, 'utf8'));
  const status = fm && fm.status != null ? String(fm.status) : '';
  const parentOf = fm && fm.parent != null ? String(fm.parent) : '';
  const deps = parseList(fm && fm.depends_on);
  // 终态即可归档（判据单点持有于 scripts/status.mjs）。**行为变更**：修前判据写死 `done|failed`，
  // 漏了 canonical `canceled`（PROTOCOL §16：`failed` 只是 `canceled` 的旧词）⇒ 已取消的卡永不被归档。
  cards.push({ id: f.replace(/\.md$/, ''), mtimeMs: st.mtimeMs, terminal: isTerminal(status), parentOf, deps });
}

// 引用集：被 parent / depends_on 指向的 id（精确匹配，非子串）；**自引用不算**（旧内扫逐个跳过 o === f）。
const referenced = new Set();
for (const c of cards) {
  if (c.parentOf && c.parentOf !== c.id) referenced.add(c.parentOf);
  for (const d of c.deps) if (d !== c.id) referenced.add(d);
}

let moved = 0;
for (const c of cards) {
  if (!c.terminal) continue;
  if (c.mtimeMs > cutoff) continue;
  if (referenced.has(c.id)) continue; // 引用保护：被 parent / depends_on 引用的卡不得归档
  moved++;
  if (DRY) continue; // 真只读：不建目录、不 rename、不触碰任何文件
  const d = new Date(c.mtimeMs);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const dest = path.join(TASKS, 'archive', ym);
  fs.mkdirSync(dest, { recursive: true });
  fs.renameSync(path.join(TASKS, c.id + '.md'), path.join(dest, c.id + '.md'));
}
console.log(DRY ? `dry-run (no files moved): would-archive=${moved} (days=${DAYS})` : `archived=${moved} (days=${DAYS})`);
