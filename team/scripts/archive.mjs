#!/usr/bin/env node
// archive.mjs — 归档终态任务卡（PROTOCOL §⑳.3）
// 用法: node archive.mjs [--days N]   默认 N=7
// 规则: status ∈ {done, failed} 且 mtime 早于 N 天 → 移到 tasks/archive/YYYY-MM/
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, TASKS_DIR } from './lib.mjs';

const TASKS = TASKS_DIR;
const i = process.argv.indexOf('--days');
const DAYS = i >= 0 ? Number(process.argv[i + 1] || 7) : 7;
const cutoff = Date.now() - DAYS * 86400 * 1000;

// depends_on 列表解析（与 check-relations / lib.parseDeps 口径一致）
function parseList(raw) {
  if (typeof raw !== 'string') return [];
  const s = raw.trim().replace(/^\[|\]$/g, '').replace(/["']/g, '');
  return s.split(/[\s,]+/).filter(Boolean);
}

if (!fs.existsSync(TASKS)) { console.log('archived=0 (no tasks dir)'); process.exit(0); }
let moved = 0;
for (const f of fs.readdirSync(TASKS)) {
  if (!f.endsWith('.md')) continue;
  const p = path.join(TASKS, f);
  let st; try { st = fs.statSync(p); } catch { continue; }
  if (!st.isFile()) continue;
  const raw = fs.readFileSync(p, 'utf8');
  const { fm } = parseFrontmatter(raw);
  const status = fm && fm.status != null ? String(fm.status) : '';
  if (status !== 'done' && status !== 'failed') continue;
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
  const d = new Date(st.mtimeMs);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const dest = path.join(TASKS, 'archive', ym);
  fs.mkdirSync(dest, { recursive: true });
  fs.renameSync(p, path.join(dest, f));
  moved++;
}
console.log(`archived=${moved} (days=${DAYS})`);
