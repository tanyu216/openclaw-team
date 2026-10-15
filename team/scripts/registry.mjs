#!/usr/bin/env node
/**
 * registry.mjs — 子会话 registry（claude-sessions.json）唯一事实源 + 回退/迁移/存活判定
 *
 * 背景（T-20261008-235247-teampollguard）：registry 曾两套并存（团队级 + workspace 局部），
 * 局部陈旧无人更新导致 reconcile 困惑。本文件统一为：
 *   - 唯一事实源 = 团队级 team/claude-sessions.json（REGISTRY_PATH）
 *   - workspace/<task-id>/claude-sessions.json 已废弃：读取走回退合并，迁移用 `migrate`
 *
 * lane 身份（T-20261013-233906）：一条登记行的身份 = `(task_id, owner, session_id)`（`session_id` 是
 * `(card, owner, seg)` 的确定性投影）——`phase` 只是展示标签，**不**参与身份。去重/覆盖一律按该身份，
 * 避免同一条 lane 因标签变化落出重复行、把 check-sessions 判成不一致。详见 `dedupeKey` / `upsertSessionEntry`。
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
import { execFileSync } from 'node:child_process';
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

/**
 * 去重键（= **lane 身份**）。
 *
 * `session_id` 是 `(task_id, owner, seg)` 的确定性投影（§⑥：claude 的 UUIDv5）⇒ 它才是「哪条 lane」，
 * 而 `phase` 是 caller 自由填的**展示标签**（实证有 `seg1-verify` / `seg2-browser`，也可能缺省）。旧键
 * 把 `phase` 计入身份，于是同一条 lane 以不同标签二次登记就落出**重复行** ⇒ `check-sessions` 看见
 * 同卡两条 running、卡内登记行被 pid-空的重复行覆盖（T-20261013-233906 实证：同 session_id d55e03c4
 * 的 `phase:seg1-verify/pid 9271` 与 `phase:seg1/pid 空`）。
 *
 * 无 `session_id` 的旧式行退回粗键（含 phase/pid/startedAt），避免把互不相干的历史行折叠成一条。
 */
function dedupeKey(e) {
  const sid = e && e.session_id ? String(e.session_id) : '';
  const seg = e && e.seg != null && e.seg !== '' ? String(e.seg) : '';
  // seg 是**新规范**的分段身份（契约 §4.2）：插件 lane 的两步回填期间 session_id 皆为 `pending`，
  // 只有该 (task,owner) 的同 seg 行才是同一行 ⇒ seg 必须参与身份，否则两个 seg 的 pending 行互相覆盖。
  if (seg) return `${e.task_id}|${e.owner}|${seg}|${sid}`;
  // 历史行（无 seg）：身份 = session_id（= (task,owner,seg) 的确定性投影）；`phase` 只是展示标签，
  // **不**参与身份 —— 否则同一条 lane 换个标签二次登记就落出重复行（T-20261013-233906）。
  if (sid) return `${e.task_id}|${e.owner}|${sid}`;
  return `${e?.task_id ?? ''}|${e?.owner ?? ''}|${e?.phase ?? ''}|${e?.pid ?? ''}|${e?.startedAt ?? ''}`;
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

/** 契约 §4.2：harness 值域（未标 ⇒ `cli`，向后兼容历史条目） */
export const VALID_HARNESS = ['cli', 'plugin'];
/** 契约 §4.2：插件 lane 两步回填的状态位（claude / codex-cli lane 不写该字段） */
export const VALID_ID_STATE = ['pending', 'bound'];
/**
 * 插件 lane 的「thread 可达」观测窗：宿主未提供探测面时，按 NDJSON 日志的
 * 未报终态 + mtime 新鲜度作代理判活；超窗即判不可达（交 reconcile）。可经 env 覆盖。
 */
export const THREAD_TTL_MS = Number(process.env.OPENCLAW_CODEX_THREAD_TTL_MS || 30 * 60 * 1000);

/** 可注入的 thread 探针（宿主/测试钉定用）；null ⇒ 走内置回退探针 */
let threadProbe = null;
export function setThreadProbe(fn) { threadProbe = typeof fn === 'function' ? fn : null; }

/** 宿主钉定的真实探测命令：exit 0 且 stdout 含 thread_id ⇒ 可达 */
function probeByCommand(cmd, tid) {
  try {
    const out = execFileSync(cmd, { shell: true, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.includes(tid);
  } catch { return false; }
}

function lastNonEmptyLine(p) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim();
  } catch { /* 不可读 */ }
  return null;
}

/** 未配置探测面时的可观测代理：NDJSON 日志未报终态且 mtime 在观测窗内 */
function inFlightProxy(entry, now) {
  if (!entry.log) return false;
  let stm;
  try { stm = fs.statSync(entry.log); } catch { return false; }
  if (now - stm.mtimeMs > THREAD_TTL_MS) return false;
  const last = lastNonEmptyLine(entry.log);
  if (last == null) return true; // 尚无输出：turn 在飞
  return !/"type"\s*:\s*"result"/.test(last);
}

/**
 * 判定插件 lane 的 native thread 是否可达（G7 / 契约 §3.2、§5 G7、§7 reconcile 裁定）。
 * 优先级：① `id_state!=='bound'` 或无 `thread_id` ⇒ **不可达**（绑定成功前 lane 视为不可达）；
 * ② 注入探针（`setThreadProbe`）；③ `OPENCLAW_CODEX_THREAD_PROBE_CMD`（宿主钉定真实探测，
 * 如 `openclaw codex sessions --json`）；④ 回退「在飞代理」（日志未报终态 + mtime 新鲜）。
 * ④ 是「宿主未提供探测面」时的可观测代理、**不是 native 真值**；宿主提供 ③ 后以 ③ 为准。
 */
export function threadReachable(entry, { probe = threadProbe, now = Date.now() } = {}) {
  if (!entry || entry.harness !== 'plugin') return false;
  if (entry.id_state !== 'bound') return false;
  if (!entry.thread_id) return false;
  if (typeof probe === 'function') return !!probe(entry);
  const cmd = process.env.OPENCLAW_CODEX_THREAD_PROBE_CMD;
  if (cmd) return probeByCommand(cmd, entry.thread_id);
  return inFlightProxy(entry, now);
}

/**
 * 条目判活（G7 / 契约 §7 / §11 G-2 裁定）。
 * - **CLI lane**（claude / codex-cli）：判活 = `isPidAlive(pid)`（现状口径不变）。
 * - **插件 lane**（`harness==='plugin'`）：`pid` 字段是**网关进程 pid**（长存活）——**绝不能**当 lane
 *   判活依据，否则网关在跑 ⇒ 僵尸 lane 被永久误判为活（正是 G-2 要修的反向误判）。故判活 =
 *   **native thread 可达**（见 `threadReachable`）。
 */
export function isEntryAlive(entry, opts = {}) {
  if (!entry) return false;
  if (entry.harness === 'plugin') return threadReachable(entry, opts);
  return isPidAlive(entry.pid);
}

/** 过滤：e.task_id===taskId && e.status==='running' && isEntryAlive(e) */
export function activeSessions(taskId, { registry = loadRegistry(), ...opts } = {}) {
  const reg = registry == null ? loadRegistry() : registry;
  return reg.filter((e) => e.task_id === taskId && e.status === 'running' && isEntryAlive(e, opts));
}

/**
 * 关闭某 (task_id, seg) 下仍 `running` 的 `id_state=pending` 条目 —— 插件 lane 两步回填的
 * **绑定步**调用之（契约 §3.1 步② / §11 G-1 的「绑定步显式关闭 pending 行」分支）。
 * 为什么必须做：pending 行的 `pid` 是**存活的网关 pid**，若与 bound 行并存为两条 `running`
 * ⇒ `runningCount`/`activeSessions` **双计并发额度**，且复现 `registry_only` 类门禁红。
 * status 默认 `closed`（不是失败，是被绑定步取代）。
 */
export function closePendingEntries(taskId, seg, status = 'closed', extra = {}) {
  const norm = normalizeStatus(status);
  if (!norm.ok) return { ok: false, reason: 'invalid_status', rejected: status };
  const list = readRegistryFile(REGISTRY_PATH);
  let updated = 0;
  const endedAt = extra.endedAt || new Date().toISOString();
  for (const e of list) {
    const eSeg = e.seg == null || e.seg === '' ? e.phase : e.seg;
    if (e.task_id !== taskId || eSeg !== seg) continue;
    if (e.id_state !== 'pending' || e.status !== 'running') continue;
    Object.assign(e, { status: norm.status, endedAt });
    updated++;
  }
  if (updated) writeRegistryFile(list);
  return { ok: true, updated, status: norm.status, registryPath: REGISTRY_PATH };
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
 * 去重键 = **lane 身份**（见 `dedupeKey`：task_id|owner|session_id，`phase` 只是展示标签）⇒ 同一条 lane
 * 重复登记幂等覆盖，**不产生重复行**；`phase` 标签被刷新（同一 lane 换标签不算新 lane）。
 * 必填 task_id / session_id；缺失 ⇒ { ok:false, reason:'entry_missing_key' }（不落盘）。
 * 拒写：既有行是活跃 running（pid 存活）而无 pid 的重复登记 ⇒ { ok:false, reason:'duplicate_running_lane' }
 * （T-20261013-233906；保护活跃行的 log/startedAt/pid，且不留僵尸行给 check-sessions）。
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
  if (i >= 0) {
    // 拒写（T-20261013-233906）：既有行是**活跃** running（pid 存活），而本次登记是「无 pid 的 running」
    // —— 这是同一条 lane 的一次无主重复登记。合并只会抹掉活跃行的 log/startedAt、并让 check-sessions
    // 看见一条 pid 空的僵尸 running 行（实证：同 session_id 的 `phase:seg1/pid 空`）。保留原行，明报。
    const prev = list[i];
    const nowPid = Number(clean.pid);
    if (prev.status === 'running' && isPidAlive(prev.pid) && clean.status === 'running' && !(Number.isInteger(nowPid) && nowPid > 0)) {
      console.warn(`[registry] 拒绝写入 ${clean.task_id}/${clean.session_id}：已有活跃 lane（pid=${prev.pid},phase=${prev.phase ?? ''}）在跑，本次为无 pid 的重复登记（phase=${clean.phase ?? ''}）；未落盘（原行保留）。`);
      return { ok: false, reason: 'duplicate_running_lane', existing: prev, entry: clean, registryPath: REGISTRY_PATH };
    }
    list[i] = { ...prev, ...clean };
  } else list.push(clean);
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
