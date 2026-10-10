#!/usr/bin/env node
// patrol-scan.mjs — 扫描看板：**告警前按卡现态二次核对**，仅报「当前仍 in_progress 且确实需要告警」的卡。
// 输出 JSON {stale:[...]}（形状不变），供 cron condition-trigger（patrol-main.js）/ dispatch 消费：无陈旧卡 = 不 fire（零成本）。
//
// 复用 lib.mjs 的 parseFrontmatter（去引号 + JSON 反转义），绝不手动正则解析 frontmatter：
// 卡里 heartbeat_at 由 lib.mjs 以双引号写出（如 "2026-…Z"），旧实现把原值直喂 Date.parse
// ⇒ NaN ⇒ 当作「无限陈旧」⇒ 每张带引号心跳的 in_progress 卡被误报 stale（误触发误唤醒）。
//
// ── 现态二次核对（T-20261010-061248）──────────────────────────────────────────────
// 告警判定不再只看（可能已陈旧的）心跳快照，而是对**当前卡文件**二次核对现态，杜绝「快照陈旧但
// 现态已 done」的陈旧告警：
//   ① 现态 status 必须仍为 in_progress —— done/in_review/blocked 一律不告警；
//   ② 心跳确实陈旧（>30min）方告警；claim→spawn 窗口（claim 后数分钟、心跳尚未写出/尚新、
//      尚无 `## Sessions`/workspace）**不告警**（避免把正常在途的卡误判为「已领未开工」）；
//   ③ 每条告警显式携带现态证据 status_changed_at / has_sessions / has_workspace，并把陈旧细分为
//      stale_kind: 'heartbeat'（有开工证据的心跳停摆）| 'unstarted'（claim 后确无 Sessions/workspace）；
//   ④ fail-safe 不回归：心跳缺失/无法解析仍告警（reason:'unparseable'），仅当 claim 仍处 claim→spawn
//      窗口内才暂缓。
// 另导出 `recheckStale(entries)`：对**已在手**的告警快照（如 cron 消息正文里的 stale 数组）按现态
// 逐条重核后再告警——调用方可 `node patrol-scan.mjs --recheck <snapshot.json>` 做「告警前把关」。
import fs from 'node:fs';
import path from 'node:path';

import { parseFrontmatter, parseIso, TASKS_DIR, TEAM_ROOT } from './lib.mjs';

const STALE = 30 * 60 * 1000; // 30min：与 PROTOCOL.md 看板协议一致，勿改
const WORKSPACE_DIR = path.join(TEAM_ROOT, 'workspace');

/**
 * body 是否含**非空** `## Sessions` 段（真实开工证据）。
 * 卡模板的 `## Sessions` 段默认只含一行 HTML 注释占位 ⇒ 视为空（不算开工证据）。
 */
export function hasSessionsSection(body) {
  const lines = String(body || '').split(/\r?\n/);
  let inSec = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (/^##\s+Sessions\s*$/.test(t)) { inSec = true; continue; }
    if (!inSec) continue;
    if (/^#{1,6}\s/.test(t)) return false;            // 到下一标题仍无条目 ⇒ 空段
    if (!t) continue;                                  // 空行
    if (/^<!--/.test(t) || /^-->$/.test(t)) continue;  // 模板注释占位 ⇒ 非条目
    return true;                                       // 非空非注释行 ⇒ 真条目
  }
  return false;
}

/** 卡是否已有真实会话证据：`## Sessions` 段有条目 / active_session_id 非空 / subsession_ids 非空 */
export function hasSessionEvidence(fm, body) {
  if (hasSessionsSection(body)) return true;
  if (!fm) return false;
  if (typeof fm.active_session_id === 'string' && fm.active_session_id.trim()) return true;
  const subs = fm.subsession_ids;
  if (Array.isArray(subs) && subs.length) return true;
  if (typeof subs === 'string' && subs.replace(/[[\]\s"']/g, '')) return true;
  return false;
}

function workspaceExists(id, workspaceDir) {
  try {
    return fs.existsSync(path.join(workspaceDir, id));
  } catch {
    return false;
  }
}

/**
 * 按卡**现态**判定是否需告警（scanStale 与 recheckStale 共用的单一判定源）。
 * @returns {{alert:false, reason:string} | {alert:true, entry:object}}
 */
function liveVerdict(fm, body, { id, workspaceDir = WORKSPACE_DIR, now = Date.now(), staleMs = STALE }) {
  if (!fm || fm.status !== 'in_progress') {
    return { alert: false, reason: `live_status:${fm ? fm.status : 'no_frontmatter'}` };
  }
  const claimed_by = fm.claimed_by || '';
  const has_sessions = hasSessionEvidence(fm, body);
  const has_workspace = workspaceExists(id, workspaceDir);
  const live = {
    status: 'in_progress',
    status_changed_at: Number.isNaN(parseIso(fm.status_changed_at)) ? null : fm.status_changed_at,
    has_sessions,
    has_workspace,
  };
  const claimedMs = parseIso(fm.claimed_at);
  const claimAge = Number.isNaN(claimedMs) ? null : now - claimedMs;

  const hb = parseIso(fm.heartbeat_at);
  if (Number.isNaN(hb)) {
    // fail-safe：心跳缺失/无法解析 ⇒ 仍告警（不回归），reason 明确区分，不与真·陈旧卡混淆。
    // 唯一暂缓：claim 仍处 claim→spawn 窗口（claim 后数分钟、心跳尚未写出）⇒ 正常在途，不误报。
    if (claimAge !== null && claimAge <= staleMs) return { alert: false, reason: 'claim_window' };
    return { alert: true, entry: { id, claimed_by, ageMin: null, reason: 'unparseable', stale_kind: 'unparseable', ...live } };
  }
  const age = now - hb;
  if (age > staleMs) {
    const stale_kind = has_sessions || has_workspace ? 'heartbeat' : 'unstarted';
    return { alert: true, entry: { id, claimed_by, ageMin: Math.round(age / 60000), stale_kind, ...live } };
  }
  // 心跳尚新 ⇒ 在途/正常，不告警（含 claim→spawn 窗口）
  return { alert: false, reason: has_sessions || has_workspace ? 'in_progress_started' : 'claim_window' };
}

/**
 * 扫描 tasksDir，返回 { stale:[...] }。
 * - 现态 in_progress 且心跳可解析且 age > staleMs → { id, claimed_by, ageMin, stale_kind, status, status_changed_at, has_sessions, has_workspace }
 * - 现态 in_progress 但心跳缺失/空/无法解析 → { …, ageMin:null, reason:'unparseable' }（fail-safe 且可区分）
 * - 非 in_progress（done/in_review/blocked/ready…）/ 无 frontmatter / 非 .md → 忽略
 * - claim→spawn 窗口（claim 后 ≤staleMs 且心跳尚新或尚未写出）→ 不报
 * @param {{tasksDir?:string, workspaceDir?:string, now?:number, staleMs?:number}} [opts]
 */
export function scanStale({ tasksDir = TASKS_DIR, workspaceDir = WORKSPACE_DIR, now = Date.now(), staleMs = STALE } = {}) {
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
    const { fm, body } = parseFrontmatter(raw);
    if (!fm) continue;
    if (fm.status !== 'in_progress') continue;
    const id = fm.id || f.replace(/\.md$/, '');
    const v = liveVerdict(fm, body, { id, workspaceDir, now, staleMs });
    if (v.alert) stale.push(v.entry);
  }
  return { stale };
}

/**
 * 现态二次核对（告警前把关）：对一批**已在手**的疑似陈旧快照条目（如 cron 消息正文里的 stale 数组），
 * 按卡现态逐条重核；仅返回**当前仍需告警**者（含刷新后的现态证据），被剔除者带 dropped_reason。
 * @param {Array<{id:string}>} entries
 * @param {{tasksDir?:string, workspaceDir?:string, now?:number, staleMs?:number}} [opts]
 * @returns {{stale:Array, dropped:Array}}
 */
export function recheckStale(entries, { tasksDir = TASKS_DIR, workspaceDir = WORKSPACE_DIR, now = Date.now(), staleMs = STALE } = {}) {
  const stale = [];
  const dropped = [];
  if (!Array.isArray(entries)) return { stale, dropped };
  for (const e of entries) {
    const id = e && e.id;
    if (!id) {
      // 无 id 的快照条目无法按现态定位 ⇒ 归入 dropped（绝不静默丢弃：审计可见）
      dropped.push({ ...(e && typeof e === 'object' ? e : { value: e }), dropped_reason: 'missing_id' });
      continue;
    }
    let raw;
    try {
      raw = fs.readFileSync(path.join(tasksDir, `${id}.md`), 'utf8');
    } catch {
      dropped.push({ ...e, dropped_reason: 'card_missing' });
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    const v = liveVerdict(fm, body, { id, workspaceDir, now, staleMs });
    if (v.alert) stale.push(v.entry);
    else dropped.push({ ...e, dropped_reason: v.reason });
  }
  return { stale, dropped };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────
/** 读快照文件：接受 JSON 数组或 {stale:[...]}；非法 ⇒ 抛（调用方转非零退出） */
function readSnapshotEntries(p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.stale)) return j.stale;
  throw new Error('snapshot shape: expected array or {stale:[]}');
}

// main-guard：经 realpath 归一后比较，符号链接调用亦能命中（import.meta.url 为真实路径，argv[1] 可能是链接路径）
let IS_MAIN = false;
try {
  IS_MAIN = fs.realpathSync(new URL(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
} catch {
  IS_MAIN = false; // realpath 失败 ⇒ 不执行 main
}

if (IS_MAIN) {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf('--recheck');
  if (ri === -1) {
    console.log(JSON.stringify(scanStale()));
  } else {
    let entries = null;
    const p = argv[ri + 1];
    try {
      entries = p ? readSnapshotEntries(p) : null;
    } catch {
      entries = null;
    }
    if (entries === null) {
      // 快照不可读 ⇒ 非零退出（绝不静默假绿：调用方须察觉把关失效）
      console.log(JSON.stringify({ stale: [], dropped: [], error: 'snapshot_unreadable' }));
      process.exit(1);
    }
    console.log(JSON.stringify(recheckStale(entries)));
  }
}
