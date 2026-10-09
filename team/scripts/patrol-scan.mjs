#!/usr/bin/env node
// patrol-scan.mjs — 扫描看板：in_progress 且心跳陈旧(>30min) 的卡。输出 JSON {stale:[...]}。
// 供 cron condition-trigger（patrol-main.js）使用：无陈旧卡 = 不 fire（零成本）。
//
// 复用 lib.mjs 的 parseFrontmatter（去引号 + JSON 反转义），绝不手动正则解析 frontmatter：
// 卡里 heartbeat_at 由 lib.mjs 以双引号写出（如 "2026-…Z"），旧实现把原值直喂 Date.parse
// ⇒ NaN ⇒ 当作「无限陈旧」⇒ 每张带引号心跳的 in_progress 卡被误报 stale（误触发误唤醒）。
import fs from 'node:fs';
import path from 'node:path';

import { parseFrontmatter, parseIso, TASKS_DIR } from './lib.mjs';

const STALE = 30 * 60 * 1000; // 30min：与 PROTOCOL.md 看板协议一致，勿改

/**
 * 扫描 tasksDir，返回 { stale:[...] }。
 * - in_progress 且心跳可解析且 age > staleMs → { id, claimed_by, ageMin }
 * - in_progress 但心跳缺失/空/无法解析 → { id, claimed_by, ageMin:null, reason:'unparseable' }（fail-safe 且可区分）
 * - 非 in_progress / 无 frontmatter / 非 .md → 忽略
 * @param {{tasksDir?:string, now?:number, staleMs?:number}} [opts]
 */
export function scanStale({ tasksDir = TASKS_DIR, now = Date.now(), staleMs = STALE } = {}) {
  const stale = [];
  if (!fs.existsSync(tasksDir)) return { stale };
  for (const f of fs.readdirSync(tasksDir)) {
    if (!f.endsWith('.md')) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(tasksDir, f), 'utf8');
    } catch {
      continue;
    }
    const { fm } = parseFrontmatter(raw);
    if (!fm) continue;
    if (fm.status !== 'in_progress') continue;
    const id = fm.id || f.replace(/\.md$/, '');
    const claimed_by = fm.claimed_by || '';
    const hb = parseIso(fm.heartbeat_at);
    if (Number.isNaN(hb)) {
      // fail-safe：无法判定新鲜度 → 报出，但用 reason 明确区分，不与真·陈旧卡混淆
      stale.push({ id, claimed_by, ageMin: null, reason: 'unparseable' });
      continue;
    }
    const age = now - hb;
    if (age > staleMs) stale.push({ id, claimed_by, ageMin: Math.round(age / 60000) });
  }
  return { stale };
}

// main-guard：经 realpath 归一后比较，符号链接调用亦能命中（import.meta.url 为真实路径，argv[1] 可能是链接路径）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) {
    console.log(JSON.stringify(scanStale()));
  }
} catch { /* realpath 失败 ⇒ 不执行 main */ }
