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
let moved = 0;
for (const f of fs.readdirSync(TASKS)) {
  if (!f.endsWith('.md')) continue;
  const p = path.join(TASKS, f);
  let st; try { st = fs.statSync(p); } catch { continue; }
  if (!st.isFile()) continue;
  const raw = fs.readFileSync(p, 'utf8');
  const { fm } = parseFrontmatter(raw);
  const status = fm && fm.status != null ? String(fm.status) : '';
  // 终态即可归档（判据单点持有于 scripts/status.mjs）。**行为变更**：修前判据写死 `done|failed`，
  // 漏了 canonical `canceled`（PROTOCOL §16：`failed` 只是 `canceled` 的旧词）⇒ 已取消的卡永不被归档。
  if (!isTerminal(status)) continue;
  if (st.mtimeMs > cutoff) continue;
  // 引用保护：被 parent / depends_on 引用的卡不得归档（精确匹配，非子串）
  const id = f.replace(/\.md$/, '');
  let referenced = false;
  for (const o of fs.readdirSync(TASKS)) {
    if (!o.endsWith('.md') || o === f) continue;
    const ofm = parseFrontmatter(fs.readFileSync(path.join(TASKS, o), 'utf8')).fm;
    if (!ofm) continue;
    const parentOf = ofm.parent == null ? '' : String(ofm.parent);
    const deps = parseList(ofm.depends_on);
    if (parentOf === id || deps.includes(id)) { referenced = true; break; }
  }
  if (referenced) continue;
  moved++;
  if (DRY) continue; // 真只读：不建目录、不 rename、不触碰任何文件
  const d = new Date(st.mtimeMs);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const dest = path.join(TASKS, 'archive', ym);
  fs.mkdirSync(dest, { recursive: true });
  fs.renameSync(p, path.join(dest, f));
}
console.log(DRY ? `dry-run (no files moved): would-archive=${moved} (days=${DAYS})` : `archived=${moved} (days=${DAYS})`);
