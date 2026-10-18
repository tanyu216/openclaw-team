#!/usr/bin/env node
/**
 * lint-rule-refs.mjs — 稳定规则 ID 的引用门。
 *
 * 取代旧的 `lint-refs.mjs`（全局 §N 解析器）。规则：
 *   · 每个 `R-*` 必须在某个 owner 块中定义；retired 规则不得被引用；
 *   · 跨文件引用必须用反引号包住（marker 行 / 代码围栏除外）；
 *   · `R-X clause M` / `step M` 的 M 必须在 canonical 正文的顶层有序列表范围内；
 *   · 角色 AGENTS.md 里引用的规则必须由该角色携带（owner 块或 carrier 块）；
 *   · guides / SOUL / ROLES / README / CLAUDE 只要求全局存在。
 *
 * 只读。用法：node team/scripts/lint-rule-refs.mjs [--repo <R> | --live] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveMode, UsageError } from './host-paths.mjs';
import {
  ROLES, parseRuleBlocks, roleAgentsPath, resolveDetailPath, normalizeOwnerBlock,
} from './lib/agent-doc-blocks.mjs';

const RULE_RE = /(?<![A-Za-z0-9-])(R-[A-Z][A-Z0-9]*-[0-9]+)(?![0-9A-Za-z-])/g;
// 允许 ID 后用反引号收尾（`` `R-X-1` clause 2 `` 是本仓常见写法，不能漏检）。
const CLAUSE_RE = /(?<![A-Za-z0-9-])(R-[A-Z][A-Z0-9]*-[0-9]+)`?\s+(?:clause|step)\s+(\d+)/g;
const RULE_ITEM_RE = /(?<![A-Za-z0-9-])(R-[A-Z][A-Z0-9]*-[0-9]+)`?\s+rule\s+(\d+)/g;

function walkMd(dir, out, depth = 0, skip = new Set()) {
  if (depth > 8) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skip.has(e.name)) continue;
      walkMd(p, out, depth + 1, skip);
    } else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
}

function scanFiles(mode) {
  const files = [];
  if (mode.mode === 'repo') {
    walkMd(path.join(mode.repo, 'team'), files, 0, new Set(['node_modules', '.git', 'tasks', 'workspace', 'memory', '.tmp']));
    walkMd(path.join(mode.repo, 'roles'), files, 0, new Set(['node_modules', '.git', 'tasks', 'workspace', 'memory', '.tmp']));
    for (const f of ['README.md', 'README.zh-CN.md', 'CLAUDE.md']) {
      const p = path.join(mode.repo, f);
      if (fs.existsSync(p)) files.push(p);
    }
  } else {
    walkMd(mode.team, files, 0, new Set(['node_modules', '.git', 'tasks', 'workspace', 'memory', '.tmp', '.backups']));
    for (const role of ROLES) {
      const ws = path.join(mode.home, `workspace-${role}`);
      for (const f of ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md']) {
        const p = path.join(ws, f);
        if (fs.existsSync(p)) files.push(p);
      }
      walkMd(path.join(ws, 'guides'), files, 0, new Set(['node_modules', '.git']));
    }
  }
  return [...new Set(files)].sort();
}

function relOf(file, mode) {
  return path.relative(mode.mode === 'repo' ? mode.repo : mode.home, file).split(path.sep).join('/');
}

function roleOf(rel) {
  const m = rel.match(/^roles\/([^/]+)\/AGENTS\.md$/) || rel.match(/^workspace-([^/]+)\/AGENTS\.md$/);
  return m ? m[1] : '';
}

function countItems(text) {
  let fence = false;
  let n = 0;
  for (const line of String(text || '').split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    // 顶层有序项；允许 blockquote 前缀（owner 块的正文以 `> ` 开头）。
    if (/^[>\s]*\d{1,3}\.\s/.test(line)) n++;
  }
  return n;
}

function sectionText(text, num) {
  const lines = String(text || '').split('\n');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{2,6})\s*(?:§)?(\d+(?:\.\d+)*)(?:[.\s]|$)/);
    if (h && h[2] === num) { start = i; level = h[1].length; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+/);
    if (h && h[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

function inBackticks(line, idx) {
  for (const m of line.matchAll(/`[^`]*`/g)) {
    if (idx >= m.index && idx < m.index + m[0].length) return true;
  }
  return false;
}

function main() {
  const json = process.argv.includes('--json');
  const mode = resolveMode({ argv: process.argv.slice(2), scriptUrl: import.meta.url });
  const errors = [];

  // 定义来源：owner 块
  const rules = new Map();
  const carried = new Map(ROLES.map((r) => [r, new Set()]));
  for (const role of ROLES) {
    const p = roleAgentsPath(role, mode);
    if (!fs.existsSync(p)) { errors.push(`不可读：${p}`); continue; }
    let blocks;
    try { blocks = parseRuleBlocks(fs.readFileSync(p, 'utf8')); } catch (e) { errors.push(`${p}: ${e.message}`); continue; }
    for (const b of blocks) {
      if (b.kind === 'owner') {
        try {
          const r = normalizeOwnerBlock(role, b);
          if (rules.has(r.id)) errors.push(`规则 ${r.id} 重复定义`);
          rules.set(r.id, r);
        } catch (e) { errors.push(e.message); }
      } else {
        carried.get(role).add(b.id);
      }
    }
  }
  for (const r of rules.values()) carried.get(r.owner).add(r.id);

  let resolved = 0;
  let carrierViolations = 0;
  let unknown = 0;
  const files = scanFiles(mode).filter((f) => !/[\\/]SHARED-RULES\.md$/.test(f));
  for (const file of files) {
    const rel = relOf(file, mode);
    const text = fs.readFileSync(file, 'utf8');
    const role = roleOf(rel);
    const lines = text.split('\n');
    let fence = false;
    let redline = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      if (/^\s*<!--\s*BEGIN\s+REDLINES:v1/.test(line)) { redline = true; continue; }
      if (/^\s*<!--\s*END\s+REDLINES:v1/.test(line)) { redline = false; continue; }
      if (/^\s*<!--\s*(?:BEGIN|END)\s+SHARED-RULE:/.test(line)) continue;
      for (const m of line.matchAll(RULE_RE)) {
        const id = m[1];
        const rule = rules.get(id);
        if (!rule) { errors.push(`${rel}:${i + 1}: 未知规则 ID ${id}`); unknown++; continue; }
        if (rule.status === 'retired') { errors.push(`${rel}:${i + 1}: 引用已退役规则 ${id}`); unknown++; continue; }
        if (!inBackticks(line, m.index)) errors.push(`${rel}:${i + 1}: 规则 ID ${id} 未用反引号包住`);
        resolved++;
        if (role && !redline && !carried.get(role).has(id)) {
          errors.push(`${rel}:${i + 1}: ${role} 未携带规则 ${id}（AGENTS 的 owner/generated 段都没有它）`);
          carrierViolations++;
        }
      }
      for (const m of [...line.matchAll(CLAUSE_RE), ...line.matchAll(RULE_ITEM_RE)]) {
        const id = m[1];
        const n = Number(m[2]);
        const rule = rules.get(id);
        if (!rule || rule.status !== 'active') continue;
        let body = null;
        if (rule.canonical === 'owner') body = rule.payload;
        else {
          const abs = resolveDetailPath(rule.detail, mode);
          const sec = String(rule.detail || '').match(/§\s*(\d+(?:\.\d+)*)/);
          if (abs && sec) body = sectionText(fs.readFileSync(abs, 'utf8'), sec[1]);
        }
        if (body === null) {
          errors.push(`${rel}:${i + 1}: ${id} 是 canonical=guide，但 clause 引用无法定位 detail 小节`);
          continue;
        }
        const max = countItems(body);
        if (n < 1 || n > max) errors.push(`${rel}:${i + 1}: ${id} clause ${n} 超出范围（正文有 ${max} 项）`);
      }
    }
  }

  const result = { ok: errors.length === 0, mode: mode.mode, resolved, unknown, carrierViolations, errors };
  if (json) {
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  }
  if (!result.ok) {
    for (const e of errors.slice(0, 80)) console.error(`✗ ${e}`);
    if (errors.length > 80) console.error(`… 另有 ${errors.length - 80} 条`);
    console.error(`\nrule refs: ${resolved} resolved, ${unknown} unknown, ${carrierViolations} carrier violation(s)`);
    process.exit(1);
  }
  console.log(`rule refs: ${resolved} resolved, 0 unknown, 0 carrier violations ✔（${mode.mode}）`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) {
    if (e instanceof UsageError) { console.error(`✗ ${e.message}`); process.exit(2); }
    console.error(`✗ ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}
