#!/usr/bin/env node
/**
 * registry.mjs — 子会话 registry（claude-sessions.json）唯一事实源 + 回退/迁移/存活判定
 *
 * 背景（T-20261008-235247-teampollguard）：registry 曾两套并存（团队级 + workspace 局部），
 * 局部陈旧无人更新导致 reconcile 困惑。本文件统一为：
 *   - 唯一事实源 = 团队级 team/claude-sessions.json（REGISTRY_PATH）
 *   - workspace/<task-id>/claude-sessions.json 已废弃：读取走回退合并，迁移用 `migrate`
 *
 * 用法：
 *   node registry.mjs list               # 打印 loadRegistry 汇总
 *   node registry.mjs active <taskId>    # 打印某卡活跃子会话
 *   node registry.mjs register <taskId> owner=… phase=… pid=… session_id=…   # 登记/更新（写 canonical）
 *   node registry.mjs close <taskId> <sessionId> [status]                   # 置终态（status ∈ {done,closed,failed,running}，直传值，勿带 `status=` 前缀）
 *   node registry.mjs migrate            # 把 legacy 合并进 canonical 并改名 *.deprecated
 *
 * 写入侧唯一入口 = upsertSessionEntry / setSessionStatus；上层登记经 ACL `task.session-set`
 * （登记与卡内 `## Sessions` 同步落盘，见 skills/task-ops/lib/task.mjs）——不在 ACL 外手改 JSON。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEAM_ROOT } from './lib.mjs';

export const REGISTRY_PATH = path.join(TEAM_ROOT, 'claude-sessions.json');
export const WORKSPACE_DIR = path.join(TEAM_ROOT, 'workspace');

/** workspace/<task-id>/claude-sessions.json（存在的局部 registry 文件） */
export function legacyRegistryPaths() {
  if (!fs.existsSync(WORKSPACE_DIR)) return [];
  let dirs;
  try {
    dirs = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(WORKSPACE_DIR, d.name, 'claude-sessions.json');
    try {
      if (fs.statSync(p).isFile()) out.push(p);
    } catch {
      /* 忽略不存在/不可读 */
    }
  }
  return out;
}

/** 读单个 JSON 数组；非数组 / 解析失败 / 不存在 → [] */
export function readRegistryFile(p) {
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** 去重键：task_id|owner|phase|session_id */
function dedupeKey(e) {
  return `${e.task_id}|${e.owner}|${e.phase}|${e.session_id}`;
}

/**
 * 加载 registry：canonical(REGISTRY_PATH) 条目在前；legacy 条目追加（打标 legacy:true, legacy_path）。
 * 去重键见 dedupeKey；canonical 优先（保留先出现的）。
 */
export function loadRegistry({ includeLegacy = true } = {}) {
  const out = [];
  const seen = new Set();
  for (const e of readRegistryFile(REGISTRY_PATH)) {
    const key = dedupeKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  if (includeLegacy) {
    for (const lp of legacyRegistryPaths()) {
      for (const e of readRegistryFile(lp)) {
        const key = dedupeKey(e);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...e, legacy: true, legacy_path: lp });
      }
    }
  }
  return out;
}

/** Number.isInteger(pid) && pid>0 ? (kill(pid,0) 成功) : false；EPERM=存在但无权限 ⇒ true */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'EPERM') return true;
    return false;
  }
}

/** 过滤：e.task_id===taskId && e.status==='running' && isPidAlive(e.pid) */
export function activeSessions(taskId, { registry = loadRegistry() } = {}) {
  const reg = registry == null ? loadRegistry() : registry;
  return reg.filter((e) => e.task_id === taskId && e.status === 'running' && isPidAlive(e.pid));
}

export function hasActiveSession(taskId, opts) {
  const sessions = activeSessions(taskId, opts);
  return { active: sessions.length > 0, sessions };
}

/** 可读串：active_subsession(pid=...,phase=...,owner=...)，多条以 ';' 连接 */
export function formatActiveReason(sessions) {
  return sessions
    .map((s) => `active_subsession(pid=${s.pid},phase=${s.phase ?? ''},owner=${s.owner ?? ''})`)
    .join(';');
}

/** 原子写 canonical registry（同目录 tmp + rename，与 lib.writeCardAtomic 同风格） */
function writeRegistryFile(entries) {
  const out = JSON.stringify(entries, null, 2) + '\n';
  const tmp = `${REGISTRY_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, REGISTRY_PATH);
}

/**
 * 登记/更新子会话条目（canonical registry 的唯一写入点）。
 * 去重键同 dedupeKey ⇒ 同 (task_id,owner,phase,session_id) 幂等覆盖（重复登记不产生重复行）。
 * 必填 task_id / session_id；缺失 ⇒ { ok:false, reason:'entry_missing_key' }（不落盘）。
 * 注意：先前已有键在本 entry 中缺席者（如重登记未带 pid）保留原值，不被 undefined 抹掉。
 */
export function upsertSessionEntry(entry) {
  if (!entry || !entry.task_id || !entry.session_id) return { ok: false, reason: 'entry_missing_key' };
  let status = entry.status;
  if (status !== undefined) {
    const norm = normalizeStatus(status);
    if (!norm.ok) {
      console.warn(`[registry] 拒绝写入条目 ${entry.task_id}/${entry.session_id}：非法 status=${JSON.stringify(status)}（允许：${VALID_STATUS.join('|')}）；该条未落盘。`);
      return { ok: false, reason: 'invalid_status', rejected: status };
    }
    status = norm.status;
  }
  const clean = Object.fromEntries(Object.entries({ ...entry, status }).filter(([, v]) => v !== undefined));
  const list = readRegistryFile(REGISTRY_PATH);
  const key = dedupeKey(clean);
  const i = list.findIndex((e) => dedupeKey(e) === key);
  if (i >= 0) list[i] = { ...list[i], ...clean };
  else list.push(clean);
  writeRegistryFile(list);
  return { ok: true, created: i < 0, entry: clean, registryPath: REGISTRY_PATH };
}

/**
 * 合法 registry status 白名单（写入侧唯一口径）。
 * 依据 T-20261009-224500-registrystatusfix：caller 曾把整串 `status=done` 当参数值传入 ⇒ 落盘污染。
 */
export const VALID_STATUS = ['done', 'closed', 'failed', 'running'];

/**
 * 规范化 registry status：`String(raw).trim()` → 剥除误传的首缀 `status=` → 白名单校验。
 * 合法 ⇒ `{ ok:true, status, normalized }`（`normalized` = 值是否被改动，如剥了首缀/去了空白）；
 * 非法（含空串、`status=` 后为空）⇒ `{ ok:false, reason:'invalid_status', original }`。
 */
export function normalizeStatus(raw) {
  const before = raw == null ? '' : String(raw);
  let s = before.trim();
  if (s.startsWith('status=')) s = s.slice('status='.length).trim();
  if (VALID_STATUS.includes(s)) return { ok: true, status: s, normalized: s !== before };
  return { ok: false, reason: 'invalid_status', original: raw };
}

/** 置某子会话终态（running→done/failed/closed，并记 endedAt）；按 (task_id, session_id) 命中 */
export function setSessionStatus(taskId, sessionId, status, extra = {}) {
  if (!taskId || !sessionId) return { ok: false, reason: 'missing_key' };
  const norm = normalizeStatus(status);
  if (!norm.ok) {
    // 显式告警 + 拒绝（不静默落错值）：allowed 白名单随附，便于 caller 自纠
    console.warn(`[registry] 拒绝写入 ${taskId}/${sessionId}：非法 status=${JSON.stringify(status)}（允许：${VALID_STATUS.join('|')}）；未落盘。`);
    return { ok: false, reason: 'invalid_status', rejected: status };
  }
  const list = readRegistryFile(REGISTRY_PATH);
  let updated = 0;
  for (const e of list) {
    if (e.task_id === taskId && e.session_id === sessionId) {
      Object.assign(e, { status: norm.status }, Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)));
      updated++;
    }
  }
  if (updated) writeRegistryFile(list);
  return { ok: updated > 0, updated, status: norm.status, normalized: norm.normalized, registryPath: REGISTRY_PATH };
}

/**
 * 把 legacy 条目按去重键合并进 canonical（canonical 已有则不重复；legacy 独有的追加并清 legacy 标记），
 * 然后 legacy 文件改名 `<path>.deprecated`（保留内容，非删除）。幂等。canonical 不存在时创建为 []。
 */
export function migrateLegacyRegistries() {
  const existed = fs.existsSync(REGISTRY_PATH);
  const canonical = existed ? readRegistryFile(REGISTRY_PATH) : [];
  const seen = new Set(canonical.map(dedupeKey));
  const migrated = [];
  let merged = 0;
  for (const lp of legacyRegistryPaths()) {
    for (const e of readRegistryFile(lp)) {
      const key = dedupeKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      const { legacy, legacy_path, ...clean } = e;
      canonical.push(clean);
      migrated.push(clean);
      merged++;
    }
    try {
      fs.renameSync(lp, `${lp}.deprecated`);
    } catch {
      /* 改名失败不阻断其余迁移 */
    }
  }
  if (!existed || merged > 0) {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(canonical, null, 2) + '\n', 'utf8');
  }
  return { migrated, merged };
}

// ---------- CLI ----------
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'list': {
      const reg = loadRegistry();
      console.log(JSON.stringify({ registryPath: REGISTRY_PATH, total: reg.length, entries: reg }, null, 2));
      break;
    }
    case 'active': {
      const taskId = rest[0];
      const sessions = activeSessions(taskId);
      console.log(JSON.stringify({ taskId, active: sessions.length > 0, sessions }, null, 2));
      break;
    }
    case 'migrate': {
      console.log(JSON.stringify(migrateLegacyRegistries(), null, 2));
      break;
    }
    case 'register': {
      const [taskId, ...kv] = rest;
      const o = {};
      for (const a of kv) { const i = a.indexOf('='); if (i > 0) o[a.slice(0, i)] = a.slice(i + 1); }
      if (o.pid != null) { const n = Number(o.pid); o.pid = Number.isInteger(n) && n > 0 ? n : undefined; }
      console.log(JSON.stringify(upsertSessionEntry({ task_id: taskId, status: 'running', ...o }), null, 2));
      break;
    }
    case 'close': {
      const [taskId, sessionId, status = 'done'] = rest;
      console.log(JSON.stringify(setSessionStatus(taskId, sessionId, status, { endedAt: new Date().toISOString() }), null, 2));
      break;
    }
    default:
      console.error(`用法:
  node registry.mjs list               # 打印 loadRegistry 汇总
  node registry.mjs active <taskId>    # 打印某卡活跃子会话
  node registry.mjs register <taskId> owner=<o> phase=<p> pid=<n> session_id=<uuid> [log=<path>] [status=running]
  node registry.mjs close <taskId> <sessionId> [status]   # status ∈ {done,closed,failed,running}，直传值，勿带 status= 前缀
  node registry.mjs migrate            # 合并 legacy 入 canonical 并改名 *.deprecated
`);
      process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
