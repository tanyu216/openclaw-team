#!/usr/bin/env node
// sla-scan.mjs — SLA 巡检（openclaw-cron 机制）：覆盖 `R-SLA-1`…`R-SLA-6` 六行 + 契约新增的 inspector_liveness。
//
// 语义契约（本文件的**规范来源**，阈值一律引用不复制）：team/guides/sla-inspection-contract.md
// （C1 `T-20261014-022254-2` design-only 契约）。阈值**单一事实源 = `team/guides/sla-thresholds.json`**；本文件只携带
// 「引用 + 运行期映射表」，阈值直接加载 `team/guides/sla-thresholds.json`（契约 §11 钩子 H6）。
//
// 为什么存在（父 epic `T-20261014-022254`）：openclaw 侧与 loop 侧的巡检**都只扫 `in_progress`
// 心跳 >30min**；blocked / in_review / 确认门 / 缺陷建卡 / 验收建卡 / 巡检失联**均零覆盖**，而二者
// 驱动**同一** task-interface 看板 ⇒ 同一 SLA 语义须在两处实现（本文件 = openclaw 侧）。
//
// ── 落地要点（逐条对契约）────────────────────────────────────────────────────────
// 六行 + 1：blocked_clarification / confirmation_gate / defect_card_creation /
//    acceptance_card_creation / heartbeat_stale / leader_stalled（`R-SLA-1`…`R-SLA-6` 六行）+
//    inspector_liveness（契约 §5.3 新增行，threshold_min=null）。输出为契约 §4 的**发射元组**
//    （#1–#22 + #25；另附建卡草图别名 kind/id/ageMin，见 toAlert）。契约 §10.1 信封：
//    {fire, alerts, dropped, state}。
//    注：契约 §4 #23/#24（first_seen/last_seen/observed_by）是 **Req.=ledger 的账本元数据**，
//    **不随 alerts[] 发行** —— 只落在账本条目里（契约 §4.1 / 钩子 H10，T-20261014-044112-2）。
// ② 现态二次核对 + fail-safe：候选**发出前**按卡现态重核（scanSla 与 recheckSla **共用同一判定源**
//    `evaluateCard`，口径不可能漂移，契约 §9.6）；重核抛错/信封畸变 ⇒ **保留原候选照常告警**；
//    起点不可读 ⇒ unverifiable/warn/threshold_min=null（绝不假绿，契约 §6.5/§9.3）。
// ③ 零成本空转：无跨档 ⇒ `{fire:false, alerts:[]}`，不写卡、不写账本（契约 §9.4）。静默 ≠ 失败：
//    正常结局一律 exit 0。
// ④ 工作时段滚动 + 去重记账：Asia/Shanghai 09:00–23:00 **累计**（非墙钟，契约 §6.4；东八区无夏令时，
//    全程 UTC 推算 ⇒ 与观测主机时区无关）；去重键 = `<card>#<row>#<tier>@<origin>`（契约 §8.3）：
//    同档重复观测不再告警，**升档是新键**（升级永不被去重），**新等待重新告警**（状态变化 ⇒ 新起点）。
// ⑤ 只提示不自动改状态：「可释放」仅提示（契约 §7.4）；**不调任何写卡 ACL 命令**；升级目标恒为
//    `target:"leader"`（契约 §9.1 / 钩子 H1；具体指代经 `OPENCLAW_TEAM_LEADER`，默认当前协调者）。
// ⑥ trigger 接线：`automations/providers.json#slaScan` + `automations/dispatch.mjs`（作业 `sla-scan`，
//    **fail-closed 检测器**：degrade ⇒ fire:true，契约 §10.2）+ `install.sh` 注册（interval，默认 30m）。
//
// ── 本轮的显式实现决策/偏离（均按契约 §12「未决前已采纳口径」或 §8.3 规则 5 记偏离）──────────
//  D1 账本后端 = **主机本地文件**（`<team>/.sla-scan-ledger.json`），非契约默认的「卡内 trail 标记」：
//     本轮 inspector 不持有任何写卡能力（写活卡面有损坏风险），故按契约 §8.3 规则 5 的
//     **backendless 兜底**：机制内自去重成立，跨机制残余「每键至多 1 次重复」为**已记偏离**。
//  D2 `acceptance_card_creation` 的触发状态取「交付态 = `in_review`」（契约 §6.3-C 原文的
//     「its entry into the delivery/in_review state」）；`done` **不**纳入：终态卡的等待无法再按现态
//     计龄，且会把全量历史 done 卡一次性点着（违 §9.4 零成本空转）。UI 范围判据（`R-UI-1` clause 1）
//     不可机判 ⇒ **不**加过滤器（宁可多报，契约 §9.3）——首次运行对既有在途卡一次性告警，见 report。
//  D3 `inspector_liveness`：对端（loop-patrol，C4）标记**缺失**时记 `peer:'absent'` 可见注记而**不**告警
//     （否则在对端落地前形成「永不绿」的每周期唤醒，正是 §10.2 要避免的失败模式）；标记**存在但超界**
//     才告警。需要「缺失即告警」的口径时置 `OPENCLAW_TEAM_SLA_PEER_REQUIRED=1`。
//  D4 跨机制共享账本需共享通道；契约 §8.3 给定的是「卡内 trail」，异主机场景由 C4/Elon 裁定
//     （本文件只做机制内去重 + 己方 liveness 落盘，见 §8.4 的发布职责）。
//
// ── 契约 v1.1 回灌的实现修正（§12 G-10 ⑤⑥⑦ = 设计确认 T-20261014-022327 的 F1/F5/F8）──────────
//  F1 §4 #9：`measure_start_source` **只**写读取位置（`frontmatter|comments|progress|missing`），
//     `trail_event`/`created_at`/`status_changed_at` 是 §4 #7 的 **kind** 词汇，曾越界写进 source。
//     现在两者各归其位：全部行的 source 取自读取位置（见 MEASURE_START_SOURCES），
//     `leader_stalled` 的 kind 亦随真实事件而定（轨迹条目 / 建卡 / leader 驱动的终态迁移）。
//  F5 §6.3-D：`leader_stalled` 的起点**照发真实值**，回溯窗只把 confidence 降为 `low`（窗外）——
//     不再「丢起点 ⇒ threshold_min=null ⇒ 最深停摆被降成 warn」。看板完全无 leader 事件时才走
//     §6.5 的 unverifiable/warn 兜底。
//  F8 §4 #19：`blocked_reason` 在**每一行**取「卡当前值」（缺失 ⇒ null），不再只有
//     `blocked_clarification` 填、其余行落 null。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseFrontmatter, parseIso, TASKS_DIR, TEAM_ROOT } from './lib.mjs';
import { hasSessionEvidence } from './patrol-scan.mjs';
import { isOpen, isTerminal } from './status.mjs';
import { repoRootFromScript, teamRoot, openclawHome } from './host-paths.mjs';
import { loadSlaRows, loadLivenessRow } from './sla-thresholds.mjs';

// ── 机制参数（**不是** SLA 阈值；契约 §2 符号表）────────────────────────────────────
/** 机制来源标识（契约 §4 #21）。 */
export const MECHANISM = 'openclaw-cron';
/** 对端机制标识（契约 §8.4；C4 落地前其标记缺失，见 D3）。 */
export const PEER_MECHANISM = 'loop-patrol';
/** 升档目标恒为 leader（契约 §9.1 / 钩子 H1）；具体指代经环境变量，默认当前协调者（`R-TERM-1`）。 */
export const LEADER = String(process.env.OPENCLAW_TEAM_LEADER || 'elon').trim().toLowerCase();
/** `P` 解析：正整数分钟；非法/缺省 ⇒ `DEFAULT_PERIOD_MIN`（见下方 G-6 裁定）。 */
export const DEFAULT_PERIOD_MIN = 15;
export function resolvePeriodMin(raw) {
  const n = Number(String(raw == null ? '' : raw).trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PERIOD_MIN;
}

/**
 * 机制自身周期 `P`（分钟）：升档前导取本机制的巡检周期（契约 §5.2/§12 G-6）。
 * **G-6 口径对齐（本卡的接线裁定）**：`warn` 界 = `L − P` 且**钳 0**，而 `R-SLA-5` 最紧的一行是
 * heartbeat_stale `L=30min` ⇒ 若 `P ≥ 30`（即按运行期③「~30min」注册），该行的 warn 界塌到
 * `T ≥ 0`：**每张在途卡每个心跳周期都会告警且永不收敛**，正面违反契约 §9.4 零成本空转。
 * 故此处把注册 cadence 定为 **15m**（与框架既有 `task-patrol` 的声明周期一致，且与③同为同一量级），
 * 并把「`P` 必须小于最紧的 `L`」写成机检（tests/sla-scan.test.mjs 的 cadence 用例）。
 */
export const CADENCE_PERIOD_MIN = resolvePeriodMin(process.env.OPENCLAW_TEAM_SLA_PERIOD_MIN);
/** leader 动作回溯窗口（机制参数）：窗口内无 leader 事件 ⇒ 该行 origin 记 unverifiable（契约 §6.3-D）。 */
export const LEADER_LOOKBACK_DAYS = 7;
/** 对端 liveness 界系数：`peer_stale ⇔ now − peer.last_ok > k × P_peer`（契约 §5.3，派生非 SLA 数）。 */
export const PEER_LIVENESS_K = 3;
/** 对端周期（分钟，机制参数）。 */
export const PEER_PERIOD_MIN = 30;
/** 对端标记缺失是否即为失联（默认否，见 D3）。 */
export const PEER_REQUIRED = process.env.OPENCLAW_TEAM_SLA_PEER_REQUIRED === '1';

/** 工作时段（契约 §6.4）：Asia/Shanghai 每日 09:00–23:00，界外滚动（时钟停）。 */
export const WINDOW = { tzOffsetMin: 8 * 60, startMin: 9 * 60, endMin: 23 * 60 };

/** 主机本地运行期状态（与契约 §8.4 的 liveness 发布职责对应；漂移巡检已忽略，见 check-all.sh）。 */
export const SELF_STATE_FILE = path.join(TEAM_ROOT, '.sla-scan-state.json');
export const PEER_STATE_FILE = path.join(TEAM_ROOT, `.sla-${PEER_MECHANISM}-state.json`);
export const LEDGER_FILE = path.join(TEAM_ROOT, '.sla-scan-ledger.json');
export const WORKSPACE_DIR = path.join(TEAM_ROOT, 'workspace');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

// 终态/在途判据来自 `scripts/status.mjs`（`isTerminal` / `isOpen`，与 ACL 终态守卫同口径：
// done/failed/canceled）。

/**
 * 运行期阈值映射表 —— **唯一数值源 = `team/guides/sla-thresholds.json`**（契约 §2 规则 1 / 钩子 H6）。
 * 本文件不再携带任何数字：直接加载 JSON，`slaRef` / `thresholdRef` 指向 `R-SLA-*`。
 * `leader_stalled` 的 `noWarnLead` 是机制标志（该行的界本身就是「无动作」界），不是阈值。
 */
const REPO_ROOT = repoRootFromScript(import.meta.url);
const SLA_MODE = REPO_ROOT
  ? { mode: 'repo', repo: REPO_ROOT, team: teamRoot(), home: openclawHome() }
  : { mode: 'live', repo: '', team: teamRoot(), home: openclawHome() };

export const SLA_ROWS = Object.freeze(loadSlaRows(SLA_MODE).map((r) =>
  r.row === 'leader_stalled' ? Object.freeze({ ...r, noWarnLead: true }) : Object.freeze({ ...r })));

/**
 * 契约 §4 #9：`measure_start_source` 的**唯一合法取值** = **读取位置**，绝不是 `measure_start_kind`
 * （F1：`trail_event` / `created_at` / `status_changed_at` 是 kind 词汇，写进 source 即越出本枚举）。
 * 映射：frontmatter 字段 ⇒ `frontmatter`；`## Comments` 条目 ⇒ `comments`；`## Progress` 条目 ⇒
 * `progress`；无可读起点 ⇒ `missing`。
 */
export const MEASURE_START_SOURCES = Object.freeze(['frontmatter', 'comments', 'progress', 'missing']);

/** trail 条目所在小节 ⇒ §4 #9 的读取位置（`splitSections` 已把节名小写化）。 */
function sourceOfSection(section) {
  return section === 'comments' ? 'comments' : 'progress';
}

/** 契约 §5.3 新增行（**非** `R-SLA-*` 行）：threshold_min = null，只有 warn。 */
export const LIVENESS_ROW = Object.freeze({ ...loadLivenessRow(SLA_MODE) });

const ROW_BY_NAME = new Map([...SLA_ROWS, LIVENESS_ROW].map((r) => [r.row, r]));

// ── 工作时段累计（契约 §6.4）────────────────────────────────────────────────────
/**
 * `[fromMs, toMs]` 内在工作时段（Asia/Shanghai 09:00–23:00）内的**累计分钟**。
 * 东八区无夏令时且偏移为整小时 ⇒ 平移后按 UTC 日历日推算即可，与观测主机时区无关。
 * @returns {number} 向下取整的分钟数（负数/倒序 ⇒ 0）
 */
export function workingMinutesBetween(fromMs, toMs, w = WINDOW) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  const shift = w.tzOffsetMin * MIN_MS;
  const a = fromMs + shift;
  const b = toMs + shift;
  if (b <= a) return 0;
  let total = 0;
  for (let day = Math.floor(a / DAY_MS) * DAY_MS; day <= b; day += DAY_MS) {
    const lo = Math.max(a, day + w.startMin * MIN_MS);
    const hi = Math.min(b, day + w.endMin * MIN_MS);
    if (hi > lo) total += hi - lo;
  }
  return Math.floor(total / MIN_MS);
}

/**
 * `workingMinutesBetween` 的逆：自 `fromMs` 起在**工作时段内**推进 `minutes` 分钟后的时刻。
 * `due_at` 是**展示用**投影（契约 §4 #13），必须在**同一时间基**上前推（工作时段），否则窗口边缘
 * 会给出与判定不一致的到期时刻（判定永远只用 `elapsed_working_min ≥ threshold_min`）。
 */
export function addWorkingMinutes(fromMs, minutes, w = WINDOW) {
  if (!Number.isFinite(fromMs) || !(minutes > 0)) return fromMs;
  const shift = w.tzOffsetMin * MIN_MS;
  let remain = minutes * MIN_MS;
  let t = fromMs;
  for (let guard = 0; remain > 0 && guard < 4000; guard++) {
    const local = t + shift;
    const day = Math.floor(local / DAY_MS) * DAY_MS;
    const winStart = day + w.startMin * MIN_MS;
    const winEnd = day + w.endMin * MIN_MS;
    if (local < winStart) { t = winStart - shift; continue; }
    if (local >= winEnd) { t = day + DAY_MS + w.startMin * MIN_MS - shift; continue; }
    const avail = winEnd - local;
    if (avail >= remain) { t += remain; remain = 0; break; }
    remain -= avail;
    t = day + DAY_MS + w.startMin * MIN_MS - shift;
  }
  return t;
}

// ── 升档梯（契约 §5.2；纯函数：L/F 来自 `sla-thresholds.json`，P 来自机制）────────────────────────────
/**
 * 最高「新跨档」= 契约 §5.2 规则 4（只发最高档）。
 * `warn` = `T ≥ L − P`（钳 0；`noWarnLead` 行不适用）；`overdue` = `T ≥ L`；`escalate` = `T ≥ F`。
 * @returns {{severity:'warn'|'overdue'|'escalate'|null, crossed:string[]}}
 */
export function verdictFor(row, elapsedMin, periodMin) {
  const L = row.normalMin;
  const F = row.furtherMin;
  const crossed = [];
  if (L == null) {
    // threshold_min=null ⇒ 无到点档，只有可见性 warn（契约 §5.3 / §7.4）
    return elapsedMin >= 0 ? { severity: 'warn', crossed: ['warn'] } : { severity: null, crossed: [] };
  }
  const warnAt = row.noWarnLead ? L : Math.max(0, L - periodMin);
  if (elapsedMin >= warnAt) crossed.push('warn');
  if (!row.noWarnLead && elapsedMin >= L) crossed.push('overdue');
  if (F != null && elapsedMin >= F) crossed.push('escalate');
  if (!crossed.length) return { severity: null, crossed };
  return { severity: crossed[crossed.length - 1], crossed };
}

// ── 看板读取与解析小工具 ────────────────────────────────────────────────────────
/** frontmatter 列表字段（lib.parseFrontmatter 不解列表）：`[]` / `[a, b]` / `a b` 均可。 */
export function parseList(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw !== 'string') return [];
  const s = raw.trim().replace(/^\[|\]$/g, '').replace(/["']/g, '');
  return s.split(/[\s,]+/).filter(Boolean);
}

/** 卡体按 `## <name>` 切段 ⇒ { '<name 小写>': [lines] }（契约 §6.1 的 trail 来源）。 */
export function splitSections(body) {
  const out = {};
  let cur = null;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(raw);
    if (h) {
      cur = h[1].toLowerCase();
      if (!out[cur]) out[cur] = [];
      continue;
    }
    if (cur) out[cur].push(raw);
  }
  return out;
}

const ISO_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/;
const KIND_RE = /·\s*(discuss|decision|confirm|change|note|defect)\s*·\s*([A-Za-z_][A-Za-z0-9_-]*)/;

/**
 * 进程 trail 条目（`## Comments` / `## Progress` 内**带时间戳**的行）。
 * @returns {{section:string, ts:string, tsMs:number, kind:string|null, author:string|null, text:string}[]}
 */
export function trailEntries(body) {
  const secs = splitSections(body);
  const entries = [];
  for (const [name, lines] of Object.entries(secs)) {
    if (name !== 'comments' && name !== 'progress') continue;
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      const m = ISO_RE.exec(t);
      if (!m) continue;
      const km = KIND_RE.exec(t);
      entries.push({
        section: name,
        ts: m[1],
        tsMs: parseIso(m[1]),
        kind: km ? km[1] : null,
        author: km ? km[2].toLowerCase() : null,
        text: t,
      });
    }
  }
  return entries;
}

function workspaceExists(id, workspaceDir = WORKSPACE_DIR) {
  try {
    return fs.existsSync(path.join(workspaceDir, id));
  } catch {
    return false;
  }
}

/**
 * 读看板：`{ byId: Map<id, {id, fm, body, raw, path}>, list: [...] }`。
 * 目录不可读 ⇒ 抛（调用方 fail-closed，契约 §9.3/§10.2）——绝不把「读不到」当「无告警」。
 */
export function readBoard(tasksDir = TASKS_DIR) {
  if (!fs.existsSync(tasksDir)) {
    const err = new Error(`tasks dir unreadable: ${tasksDir}`);
    err.code = 'board_unreadable';
    throw err;
  }
  const byId = new Map();
  const list = [];
  for (const f of fs.readdirSync(tasksDir)) {
    if (!f.endsWith('.md')) continue;
    const p = path.join(tasksDir, f);
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      continue; // 单卡不可读 ⇒ 跳过；整体不可读已在上方抛
    }
    const { fm, body } = parseFrontmatter(raw);
    if (!fm) continue;
    const id = fm.id || f.replace(/\.md$/, '');
    const card = { id, fm, body, raw, path: p };
    byId.set(id, card);
    list.push(card);
  }
  return { byId, list };
}

// ── 行判定（**scan 与 recheck 共用的单一判定源**，契约 §9.6）─────────────────────────
/** 卡是否处于终态（看板内查不到 = 不算终态 ⇒ 依赖未满足，契约 §7.4 deps_satisfied）。 */
function cardIsTerminal(board, id) {
  const c = board.byId.get(id);
  return !!c && isTerminal(c.fm.status);
}

/** 该卡是否已是某卡的复核卡 ⇒ 覆盖 `<id>` 的验收等待。 */
function hasReviewCard(id, board) {
  for (const c of board.list) {
    if (String(c.fm.review_of || '').trim() === id) return true;
  }
  return false;
}

/** 该卡是否已有缺陷修复卡（`R-DEFECT-1` clause 2）：`category:bug` 标签 + 卡面回指原卡（契约 §6.3-B）。 */
function hasFixCard(id, board) {
  for (const c of board.list) {
    if (c.id === id) continue;
    const labels = parseList(c.fm.labels);
    if (!labels.includes('category:bug')) continue;
    if (String(c.raw).includes(id)) return true;
  }
  return false;
}

/** `blocked_reason` 归一（契约 §7.2/§7.3）：缺失 ⇒ null（语义同 clarify）；未知值 ⇒ 'unknown'。 */
export function normalizeBlockedReason(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return null;
  return ['clarify', 'decision', 'dependency', 'out_of_bounds', 'defect', 'external', 'resource', 'unknown'].includes(s)
    ? s
    : 'unknown';
}

/** `R-SLA-*` 无对应行的 blocked_reason ⇒ 仅可见性告警（threshold_min=null，契约 §7.4 / §12 G-3）。 */
const NO_THRESHOLD_REASONS = new Set(['dependency', 'external', 'resource']);

/**
 * 确认门请求信号（契约 §6.3-A 优先级 2 / §12 G-5：`[confirm-request]` 为**已批准的契约约定**标记）。
 * 标记优先；标记尚未普及时用**高精度形状**兜底（宁可少判形状、不可误判语义：把一条普通巡检回执
 * 误标成「确认门等待」会让 leader 收到错的判据）。故：
 *   - `shape` 只收「阶段2.5 / 确认门 / 回发 Elon / 待双签」这类**请求**措辞；
 *   - **排除**「已回发 / 已确认 / kind=confirm」这类**收口**行 —— 它们不是等待中的请求（否则会被当成
 *     一个永不被回答的请求，制造误报）。
 */
const CONFIRM_MARKER_RE = /\[confirm-request\]/;
const CONFIRM_SHAPE_RE = /阶段\s*2\.5|确认门|confirmation gate|(?<!已)回发\s*(?:elon|leader|主)|待[^。；\n]{0,8}双签/i;
/** 收口措辞：出现在请求**之后**即视为该请求已被回答（契约 §6.3-A 的 open 谓词）。 */
const CONFIRM_DONE_RE = /\[confirm(?:ed)?\]|已回发|已确认|已双签/i;
/** 收口措辞出现在**请求行本身** ⇒ 它不是等待中的请求（不取作 gate 起点）。 */
function looksAnswered(entry) {
  return entry.kind === 'confirm' || CONFIRM_DONE_RE.test(entry.text);
}

/**
 * 单卡行判定：返回**候选**（未去重、未计数）或 null。
 * @param {{id:string, fm:object, body:string}} card
 * @param {{board:object, nowMs:number, periodMin:number, workspaceDir:string}} ctx
 */
export function evaluateCard(card, ctx) {
  const out = [];
  const { fm, body, id } = card;
  const { board, nowMs, periodMin } = ctx;
  const status = String(fm.status || '').trim();
  // 契约 §4 #19：`blocked_reason` 在**每一行**取「卡当前值」（缺失 ⇒ null，绝不用行专属替身）
  const blockedReason = normalizeBlockedReason(fm.blocked_reason);

  // 行 1 — blocked_clarification（`R-SLA-1` blocked awaiting clarification）
  if (status === 'blocked') {
    const reason = blockedReason;
    const blockedMs = parseIso(fm.blocked_at);
    const changedMs = parseIso(fm.status_changed_at);
    let origin = null;
    if (Number.isFinite(blockedMs)) {
      origin = { kind: 'blocked_at', ms: blockedMs, at: iso(blockedMs), source: 'frontmatter', confidence: 'high' };
    } else if (Number.isFinite(changedMs)) {
      // 降级方向 = 宁可多报（契约 §6.2）：status_changed_at 只可能让等待看起来更老
      origin = { kind: 'status_changed_at', ms: changedMs, at: iso(changedMs), source: 'frontmatter', confidence: 'low' };
    }
    const noThreshold = reason !== null && NO_THRESHOLD_REASONS.has(reason);
    const deps = parseList(fm.depends_on);
    const entries = trailEntries(body);
    const rel = releasability({ reason, blockedMs, deps, entries, board, fm, id });
    out.push(stripNull({
      card_id: id,
      sla_row: 'blocked_clarification',
      origin,
      thresholdMin: noThreshold ? null : ROW_BY_NAME.get('blocked_clarification').normalMin,
      furtherMin: noThreshold ? null : ROW_BY_NAME.get('blocked_clarification').furtherMin,
      blocked_reason: reason,
      releasable: rel.releasable,
      releasable_basis: rel.basis,
      row: ROW_BY_NAME.get('blocked_clarification'),
      evidence: {
        status,
        status_changed_at: Number.isFinite(changedMs) ? fm.status_changed_at : null,
        has_sessions: hasSessionEvidence(fm, body),
        has_workspace: workspaceExists(id, ctx.workspaceDir),
        threshold_ref: noThreshold ? null : ROW_BY_NAME.get('blocked_clarification').thresholdRef,
        open_predicate: 'blocked',
        blocked_reason: reason,
        depends_on: deps,
        deps_all_done: deps.length ? deps.every((d) => cardIsTerminal(board, d)) : null,
        no_threshold_reason: noThreshold,
      },
    }));
  }

  // 行 2 — confirmation_gate（`R-SLA-2` confirmation gate / `R-CONFIRM-1`）
  if (isOpen(status)) {
    const entries = trailEntries(body);
    const reqs = entries
      .filter((e) => Number.isFinite(e.tsMs))
      .filter((e) => !looksAnswered(e))
      .filter((e) => CONFIRM_MARKER_RE.test(e.text) || CONFIRM_SHAPE_RE.test(e.text));
    if (reqs.length) {
      const req = reqs[reqs.length - 1];
      const answered = entries.some((e) => e.tsMs > req.tsMs && looksAnswered(e));
      if (!answered) {
        const marker = CONFIRM_MARKER_RE.test(req.text);
        out.push(stripNull({
          card_id: id,
          sla_row: 'confirmation_gate',
          origin: {
            kind: 'gate_at',
            ms: req.tsMs,
            at: iso(req.tsMs),
            source: req.section === 'comments' ? 'comments' : 'progress',
            // 契约 §6.3-A 优先级 2（派生）；契约约定的稳定标记 ⇒ exact（契约 §12 G-5）
            confidence: marker ? 'high' : 'low',
          },
          thresholdMin: ROW_BY_NAME.get('confirmation_gate').normalMin,
          furtherMin: ROW_BY_NAME.get('confirmation_gate').furtherMin,
          blocked_reason: blockedReason,
          row: ROW_BY_NAME.get('confirmation_gate'),
          evidence: {
            status,
            status_changed_at: Number.isFinite(parseIso(fm.status_changed_at)) ? fm.status_changed_at : null,
            has_sessions: hasSessionEvidence(fm, body),
            has_workspace: workspaceExists(id, ctx.workspaceDir),
            threshold_ref: ROW_BY_NAME.get('confirmation_gate').thresholdRef,
            open_predicate: 'no later confirmation entry',
            confirm_request_marker: marker,
            gate_start_source: req.section,
            confirm_request_at: req.ts,
          },
        }));
      }
    }
  }

  // 行 3 — defect_card_creation（`R-SLA-3` defect fix card creation / `R-DEFECT-1`）
  if (status === 'blocked' || status === 'canceled') {
    const entries = trailEntries(body);
    const defects = entries.filter((e) => e.kind === 'defect' && Number.isFinite(e.tsMs));
    if (defects.length) {
      const changedMs = parseIso(fm.status_changed_at);
      const cands = [defects[0].tsMs];
      if (Number.isFinite(changedMs)) cands.push(changedMs);
      const ms = Math.min(...cands); // 契约 §6.3-B：取最早候选（降级方向 = 宁可多报）
      const fix = hasFixCard(id, board);
      if (!fix) {
        out.push(stripNull({
          card_id: id,
          sla_row: 'defect_card_creation',
          origin: {
            kind: 'trail_event',
            ms,
            at: iso(ms),
            // §4 #9：读取位置 = 该缺陷条目的**所在小节**（Comments/Progress），frontmatter 字段才是 frontmatter
            source: ms === defects[0].tsMs ? sourceOfSection(defects[0].section) : 'frontmatter',
            confidence: Number.isFinite(changedMs) ? 'high' : 'low',
          },
          thresholdMin: ROW_BY_NAME.get('defect_card_creation').normalMin,
          furtherMin: ROW_BY_NAME.get('defect_card_creation').furtherMin,
          blocked_reason: blockedReason,
          row: ROW_BY_NAME.get('defect_card_creation'),
          evidence: {
            status,
            status_changed_at: Number.isFinite(changedMs) ? fm.status_changed_at : null,
            has_sessions: hasSessionEvidence(fm, body),
            has_workspace: workspaceExists(id, ctx.workspaceDir),
            threshold_ref: ROW_BY_NAME.get('defect_card_creation').thresholdRef,
            open_predicate: 'no fix card referencing this card',
            defect_entries: defects.length,
            fix_card_present: false,
          },
        }));
      }
    }
  }

  // 行 4 — acceptance_card_creation（`R-SLA-4` product/UX acceptance queued / `R-UI-1`；flow A）
  if (status === 'in_review') {
    const flow = String(fm.flow || '').trim().toUpperCase();
    const flowEffective = flow || 'A'; // 契约 §6.3-C：缺省 ⇒ 视为 A（fail-safe）
    if (flowEffective === 'A') {
      const changedMs = parseIso(fm.status_changed_at);
      if (!hasReviewCard(id, board)) {
        out.push(stripNull({
          card_id: id,
          sla_row: 'acceptance_card_creation',
          origin: Number.isFinite(changedMs)
            ? { kind: 'status_changed_at', ms: changedMs, at: iso(changedMs), source: 'frontmatter', confidence: 'high' }
            : null,
          thresholdMin: ROW_BY_NAME.get('acceptance_card_creation').normalMin,
          furtherMin: ROW_BY_NAME.get('acceptance_card_creation').furtherMin,
          blocked_reason: blockedReason,
          row: ROW_BY_NAME.get('acceptance_card_creation'),
          evidence: {
            status,
            status_changed_at: Number.isFinite(changedMs) ? fm.status_changed_at : null,
            has_sessions: hasSessionEvidence(fm, body),
            has_workspace: workspaceExists(id, ctx.workspaceDir),
            threshold_ref: ROW_BY_NAME.get('acceptance_card_creation').thresholdRef,
            open_predicate: 'no card with review_of=<this card>',
            flow_declared: flow || null,
            flow_effective: flowEffective,
            review_card_present: false,
          },
        }));
      }
    }
  }

  // 行 5 — heartbeat_stale（§15 Worker heartbeat stale §1；既有行为保持，契约 §10.4）
  if (status === 'in_progress') {
    const hbMs = parseIso(fm.heartbeat_at);
    const claimMs = parseIso(fm.claimed_at);
    const live = {
      status,
      status_changed_at: Number.isFinite(parseIso(fm.status_changed_at)) ? fm.status_changed_at : null,
      has_sessions: hasSessionEvidence(fm, body),
      has_workspace: workspaceExists(id, ctx.workspaceDir),
      threshold_ref: ROW_BY_NAME.get('heartbeat_stale').thresholdRef,
      open_predicate: 'in_progress',
    };
    if (!Number.isFinite(hbMs)) {
      const claimAge = Number.isFinite(claimMs) ? workingMinutesBetween(claimMs, nowMs) : null;
      // claim→spawn 窗口（与 patrol-scan 同口径，§10.4 不回归）：claim 后尚在界内 ⇒ 正常在途
      if (claimAge === null || claimAge > ROW_BY_NAME.get('heartbeat_stale').normalMin) {
        out.push(stripNull({
          card_id: id,
          sla_row: 'heartbeat_stale',
          origin: null, // fail-safe：心跳不可读 ⇒ unverifiable（契约 §6.5）
          thresholdMin: null,
          furtherMin: null,
          blocked_reason: blockedReason,
          row: ROW_BY_NAME.get('heartbeat_stale'),
          evidence: { ...live, threshold_ref: null, heartbeat_unparseable: true, claimed_by: fm.claimed_by || '' },
        }));
      }
    } else {
      out.push(stripNull({
        card_id: id,
        sla_row: 'heartbeat_stale',
        origin: { kind: 'heartbeat_at', ms: hbMs, at: iso(hbMs), source: 'frontmatter', confidence: 'high' },
        thresholdMin: ROW_BY_NAME.get('heartbeat_stale').normalMin,
        furtherMin: ROW_BY_NAME.get('heartbeat_stale').furtherMin,
        blocked_reason: blockedReason,
        row: ROW_BY_NAME.get('heartbeat_stale'),
        evidence: { ...live, heartbeat_at: fm.heartbeat_at, claimed_by: fm.claimed_by || '' },
      }));
    }
  }

  return out.map((c) => ({ ...c, _card: card }));
}

/** 可释放性提示（契约 §7.4；**仅提示**，绝不自动改状态）。 */
function releasability({ reason, blockedMs, deps, entries, board, id }) {
  const eff = reason === null ? 'clarify' : reason; // §7.3-2：缺失语义同 clarify
  if (eff === 'dependency' && deps.length) {
    if (deps.every((d) => cardIsTerminal(board, d))) return { releasable: true, basis: 'deps_satisfied' };
  }
  if ((eff === 'clarify' || eff === 'decision') && Number.isFinite(blockedMs)) {
    const after = entries.some((e) => e.tsMs > blockedMs && (e.kind === 'change' || e.kind === 'confirm'));
    if (after) return { releasable: true, basis: 'clarification_trail_after_block' };
  }
  if (eff === 'out_of_bounds' && Number.isFinite(blockedMs)) {
    // 快照看不到 assignee 变更史 ⇒ 以 trail 证据为代理（leader 改派留痕），并在 evidence 注明
    const reassigned = entries.some(
      (e) => e.tsMs > blockedMs && e.author === LEADER && /改派|reassign|assignee\s*[:=]/i.test(e.text),
    );
    if (reassigned) return { releasable: true, basis: 'assignee_changed' };
  }
  return { releasable: false, basis: null }; // 未确立 ⇒ 仍告警（契约 §7.4 末行）
}

/**
 * leader 侧「可归属事件」的最新时间戳（契约 §6.3-D）：leader 作者的 confirm/decision/change 轨迹、
 * leader 建卡、以及只由 leader 驱动的终态迁移（`done`）。
 *
 * 返回值同时携带 `kind`（§4 #7 的 kind 词汇：`trail_event` / `created_at` / `status_changed_at`，
 * 随事件本身而定 —— F1：kind 必须与来源自洽）与 `source`（§4 #9 的**读取位置**：轨迹条目 ⇒
 * `comments`/`progress`；`created_at` / `status_changed_at` 是 frontmatter 字段 ⇒ `frontmatter`）。
 * 回溯窗**只**决定 `inLookback`（供 confidence 取值），**不**决定起点有无（F5，见 `stalledCandidate`）。
 * @returns {{ms:number, at:string, kind:string, source:string, inLookback:boolean}|null}
 */
function latestLeaderEvent(board, lookbackMs, nowMs) {
  let best = null;
  let bestInLookback = false;
  const consider = (ms, kind, source) => {
    if (!Number.isFinite(ms)) return;
    if (best === null || ms > best.ms) {
      best = { ms, at: iso(ms), kind, source };
      bestInLookback = nowMs - ms <= lookbackMs;
    }
  };
  for (const c of board.list) {
    for (const e of trailEntries(c.body)) {
      if (e.author === LEADER && ['confirm', 'decision', 'change'].includes(e.kind)) {
        consider(e.tsMs, 'trail_event', sourceOfSection(e.section));
      }
    }
    if (String(c.fm.created_by || '').trim().toLowerCase() === LEADER) consider(parseIso(c.fm.created_at), 'created_at', 'frontmatter');
    if (String(c.fm.status || '').trim() === 'done') consider(parseIso(c.fm.status_changed_at), 'status_changed_at', 'frontmatter');
  }
  return best ? { ...best, inLookback: bestInLookback } : null;
}

/**
 * `leader_stalled` 的证据承载卡：该行**不属于单张卡**，取**字典序最小**的合格卡承载（同看板恒得同一
 * 承载卡 ⇒ 去重键稳定，否则承载卡漂移会重复告警）。
 */
function stalledHolder(board, otherCands) {
  const holders = otherCands
    .filter((c) => ['acceptance_card_creation', 'blocked_clarification', 'confirmation_gate', 'defect_card_creation'].includes(c.sla_row))
    .map((c) => c.card_id)
    .concat(board.list.filter((c) => String(c.fm.status || '').trim() === 'in_review').map((c) => c.id))
    .sort();
  return holders.length ? holders[0] : '';
}

/**
 * `leader_stalled` 候选（契约 §5.1 条件规则 + §6.3-D）—— **scan 与现态重核共用的单一构造源**（§9.6）。
 *
 * 起点 = 最近一次 leader 归属事件，**照发真实起点**（F5）：即便它早于 `LEADER_LOOKBACK_DAYS` 回溯窗，
 * 也只把 `confidence` 降为 `low`，**不**丢弃起点、**不**把 threshold 降成 null —— 否则最深的停摆
 * （> 窗无 leader 动作，T 早已 ≥ F）会被降级成最弱信号 `warn`，与契约 §6.3-D 的「照发 + confidence:low」
 * 相反。看板**完全无** leader 事件 ⇒ 无起点可量 ⇒ 按 §6.5 的 `unverifiable`/`warn` 兜底（仍发，不假绿）。
 * @returns {object|null} 未去重候选（调用方自行 `toAlert`）；条件规则不成立 ⇒ null
 */
function stalledCandidate(board, ctx, otherCands) {
  if (!leaderOwed(board, otherCands)) return null;
  const ev = latestLeaderEvent(board, LEADER_LOOKBACK_DAYS * DAY_MS, ctx.nowMs);
  const row = ROW_BY_NAME.get('leader_stalled');
  const holder = stalledHolder(board, otherCands);
  const holderCard = holder ? board.byId.get(holder) : null;
  return {
    card_id: holder,
    sla_row: 'leader_stalled',
    origin: ev
      ? { kind: ev.kind, ms: ev.ms, at: ev.at, source: ev.source, confidence: ev.inLookback ? 'high' : 'low' }
      : null,
    thresholdMin: ev ? row.normalMin : null,
    furtherMin: ev ? row.furtherMin : null,
    blocked_reason: holderCard ? normalizeBlockedReason(holderCard.fm.blocked_reason) : null,
    row,
    evidence: {
      status: 'board',
      status_changed_at: null,
      has_sessions: null,
      has_workspace: null,
      threshold_ref: ev ? row.thresholdRef : null,
      open_predicate: 'leader-owed work present',
      leader_event_at: ev ? ev.at : null,
      leader_event_kind: ev ? ev.kind : null,
      leader_event_source: ev ? ev.source : null,
      leader_event_in_lookback: ev ? ev.inLookback : null,
      leader_lookback_days: LEADER_LOOKBACK_DAYS,
      holder_card: holder || null,
      confidence_reason: ev
        ? ev.inLookback
          ? 'latest leader-attributed event is inside the lookback window'
          : `latest leader-attributed event predates the ${LEADER_LOOKBACK_DAYS}d lookback ⇒ real origin kept, confidence low (契约 §6.3-D)`
        : 'no leader-attributed event on the board ⇒ no readable origin (契约 §6.5 fail-safe)',
    },
  };
}

/** 「leader 有待动作」条件（契约 §5.1 leader_stalled 的条件规则）。 */
function leaderOwed(board, candidates) {
  if (candidates.some((c) => ['acceptance_card_creation', 'blocked_clarification', 'confirmation_gate', 'defect_card_creation'].includes(c.sla_row))) {
    return true;
  }
  return board.list.some((c) => String(c.fm.status || '').trim() === 'in_review');
}

// ── 候选 → 告警元组（契约 §4）─────────────────────────────────────────────────────
function iso(ms) {
  return new Date(ms).toISOString();
}

function stripNull(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/**
 * 候选 → 契约 §4 告警元组。`origin === null` ⇒ unverifiable（契约 §6.5：绝不假绿，绝不静默）。
 * 另附建卡草图别名 `kind`/`id`/`ageMin`（`T-20261014-022254-3` 卡面用名），便于按卡核对。
 *
 * **发射面恰为契约 §4 的 #1–#22 + #25（+ 三个别名）。** #23/#24（`first_seen`/`last_seen`/
 * `observed_by`）是 **Req.=ledger 的账本元数据**，绝不进本函数：账本条目才是它们的家
 * （`record()`，契约 §8.3/§4.1）。原因（契约 §4.1）：① #24 的用途是「被抑制的重复仍可审计」，
 * 而被抑制者按定义不进 `alerts[]`；② 本函数只被「账本内无此键」的候选调用（有键即被抑制），
 * 回填只能写出 `first_seen=last_seen=发射瞬时`、`observed_by=[本方]`，会把「两机制同一值」的
 * 共享账本语义谎报成机制本地值；③ 现态重核（§9.6）路径不参与账本 ⇒ 无法在所有发射路径上填。
 */
export function toAlert(cand, ctx) {
  const row = cand.row;
  const origin = cand.origin;
  const ageMin = origin ? workingMinutesBetween(origin.ms, ctx.nowMs) : 0;
  // 有效阈值：候选可把 threshold_min 降到 null（§5.3/§7.4 可见性行、起点不可读）⇒ 梯级上限只有 warn
  const thresholdMin = origin ? (cand.thresholdMin === undefined ? row.normalMin : cand.thresholdMin) : null;
  const effRow = {
    normalMin: thresholdMin,
    furtherMin: thresholdMin === null ? null : cand.furtherMin === undefined ? row.furtherMin : cand.furtherMin,
    noWarnLead: row.noWarnLead === true,
  };
  const verdict = origin
    ? verdictFor(effRow, ageMin, ctx.periodMin)
    : { severity: 'warn', crossed: ['warn'] }; // 起点不可读 ⇒ warn（fail-safe）
  const severity = origin ? verdict.severity : 'warn';
  if (!severity) return null;

  const measureStartAt = origin ? origin.at : null;
  const originKey = origin ? origin.at : 'unverifiable';
  const alertId = `${cand.card_id}#${row.row}#${severity}`;
  const dedupKey = `${alertId}@${originKey}`;
  const dueAt = origin && thresholdMin != null ? iso(addWorkingMinutes(origin.ms, thresholdMin)) : null;

  return stripNull({
    alert_id: alertId,
    dedup_key: dedupKey,
    card_id: cand.card_id,
    sla_row: row.row,
    sla_ref: row.slaRef,
    severity,
    notify: severity === 'escalate' ? 'immediate' : 'digest',
    measure_start_kind: origin ? origin.kind : 'unverifiable',
    measure_start_at: measureStartAt,
    measure_start_source: origin ? origin.source : 'missing',
    elapsed_working_min: ageMin,
    elapsed_basis: 'working_hours',
    threshold_min: thresholdMin,
    due_at: dueAt,
    action: actionFor(row.row, cand, severity),
    target: 'leader',
    releasable: cand.releasable === true,
    releasable_basis: cand.releasable_basis || null,
    blocked_reason: cand.blocked_reason === undefined ? null : cand.blocked_reason,
    confidence: origin ? origin.confidence : 'low',
    mechanism: MECHANISM,
    mechanism_host: ctx.host,
    evidence: cand.evidence,
    // 建卡草图别名（T-20261014-022254-3）：kind/id/ageMin
    kind: row.row,
    id: cand.card_id,
    ageMin,
  });
}

/** 动作提醒（契约 §4 #14：**只给 leader 的提醒**，巡检绝不执行；不复述 `R-SLA-*` 正文，只引用）。 */
function actionFor(rowName, cand, severity) {
  const hint = cand.releasable
    ? `；可释放性提示(${cand.releasable_basis})——仅提示，是否放行由 leader 决定（不自动改状态）`
    : '';
  switch (rowName) {
    case 'blocked_clarification':
      return cand.thresholdMin === null
        ? `leader：本卡阻塞原因无 \`R-SLA-*\` 对应行 ⇒ 仅可见性告警（无到点，不造阈值）；请裁定是否澄清/改派/放行${hint}`
        : `leader：按 \`R-SLA-1\` 阻塞待澄清行处置（澄清/修订/改派）${hint}`;
    case 'confirmation_gate':
      return 'leader：请复核本卡的 `R-CONFIRM-1` 确认门请求（契约 §6.3-A 的起点为该请求）；确认后卡才可作下游依据';
    case 'defect_card_creation':
      return 'leader：按 `R-DEFECT-1` 创缺陷修复卡并派发';
    case 'acceptance_card_creation':
      return 'leader：按 `R-UI-1` 创产品/UX 验收卡（review_of=本卡）并派发';
    case 'heartbeat_stale':
      return severity === 'escalate'
        ? 'leader：心跳已过进一步时限——按 `R-SLA-5` 该行，任意 agent 可领取并上报（巡检只提醒，不代领）'
        : 'leader：按 `R-SLA-5` 心跳陈旧行提醒同 assignee 重领';
    case 'leader_stalled':
      return 'leader：看板存在待你处置的工作而近期无 leader 动作——请动作或转交；巡检不经 `R-SLA-7` 通道';
    case 'inspector_liveness':
      return `leader：对端巡检（${PEER_MECHANISM}）未在派生界内完成成功运行 ⇒ 本契约有一半未被验证`;
    default:
      return 'leader：请核查本卡时间戳';
  }
}

// ── 去重账本（AlertLedger 接口，契约 §8.3；后端见 D1）──────────────────────────────
/** 账本读：不可读/缺失 ⇒ 空账本（**照常告警**，契约 §8.3 规则 3，绝不因读不到而抑制）。 */
export function readLedger(file = LEDGER_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && j.entries && typeof j.entries === 'object' ? { version: 1, entries: j.entries } : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

/** 账本写：原子写；失败 ⇒ 只落 stderr（**不得**因记账失败而改变已发出的告警，契约 §8.3 规则 2）。 */
export function writeLedger(ledger, file = LEDGER_FILE) {
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 0) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    process.stderr.write(`[sla-scan] 账本写失败（下次将重复告警，可接受方向）：${e && e.message ? e.message : e}\n`);
    return false;
  }
}

// ── 扫描 + 现态重核（契约 §9.6）─────────────────────────────────────────────────
/**
 * 扫描整个看板 ⇒ 候选（未去重）。
 * @param {{tasksDir?:string, workspaceDir?:string, nowMs?:number, periodMin?:number,
 *          readBoardImpl?:Function, peerState?:object|null}} [opts]
 */
export function scanSla(opts = {}) {
  const tasksDir = opts.tasksDir || TASKS_DIR;
  const workspaceDir = opts.workspaceDir || WORKSPACE_DIR;
  const nowMs = opts.nowMs || Date.now();
  const periodMin = opts.periodMin || CADENCE_PERIOD_MIN;
  const board = (opts.readBoardImpl || readBoard)(tasksDir);
  const ctx = { board, nowMs, periodMin, workspaceDir, host: mechanismHost() };

  let candidates = [];
  for (const card of board.list) {
    for (const c of evaluateCard(card, ctx)) {
      const alert = toAlert(c, ctx);
      if (alert) candidates.push({ alert, cand: c });
    }
  }

  // 行 6 — leader_stalled（条件规则：仅当看板确有 leader 待动作，契约 §5.1）
  const stalledCand = stalledCandidate(board, ctx, candidates.map((x) => x.cand));
  if (stalledCand) {
    const alert = toAlert(stalledCand, ctx);
    if (alert) candidates.push({ alert, cand: stalledCand });
  }

  // 行 7 — inspector_liveness（契约 §5.3；非 `R-SLA-*` 行）
  const peer = opts.peerState !== undefined ? opts.peerState : readPeerState();
  const liveness = livenessVerdict(peer, nowMs);
  if (liveness.alert) {
    const cand = {
      card_id: '',
      sla_row: LIVENESS_ROW.row,
      origin: null,
      thresholdMin: null,
      furtherMin: null,
      row: LIVENESS_ROW,
      evidence: {
        status: 'mechanism',
        status_changed_at: null,
        has_sessions: null,
        has_workspace: null,
        threshold_ref: null,
        open_predicate: `peer ${PEER_MECHANISM} last_ok older than ${PEER_LIVENESS_K} × ${PEER_PERIOD_MIN}min`,
        peer: PEER_MECHANISM,
        peer_last_ok: liveness.lastOk,
        peer_age_min: liveness.ageMin,
        peer_bound_min: liveness.boundMin,
        peer_state: peer ? 'present' : 'absent',
      },
    };
    const alert = toAlert(cand, ctx);
    if (alert) candidates.push({ alert, cand });
  }

  return { candidates, board, ctx, peer, liveness };
}

/** 对端标记读取（契约 §8.4）；缺失/不可读 ⇒ null（见 D3）。 */
export function readPeerState(file = PEER_STATE_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** 对端 liveness 判定：`peer_stale ⇔ now − peer.last_ok > k × P_peer`（契约 §5.3）。 */
export function livenessVerdict(peer, nowMs) {
  const boundMin = PEER_LIVENESS_K * PEER_PERIOD_MIN;
  const lastOk = peer ? String(peer.last_ok || peer.lastOk || '').trim() : '';
  const ms = parseIso(lastOk);
  if (!Number.isFinite(ms)) {
    // 标记缺失（对端未落地）⇒ 可见注记，不告警；需要「缺失即失联」时置 PEER_REQUIRED=1
    return { alert: PEER_REQUIRED, lastOk: null, ageMin: null, boundMin, reason: 'peer_absent' };
  }
  const ageMin = Math.floor((nowMs - ms) / MIN_MS);
  return { alert: ageMin > boundMin, lastOk, ageMin, boundMin, reason: ageMin > boundMin ? 'peer_stale' : 'peer_ok' };
}

/** 主机标识（契约 §4 #22：不透明，仅供诊断，永不用于路由）。 */
export function mechanismHost() {
  const h = String(process.env.OPENCLAW_TEAM_MECHANISM_HOST || '').trim();
  if (h) return h;
  try {
    return os.hostname() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 现态二次核对（契约 §9.6）：对**在手候选**逐条按卡现态重核，仅保留仍成立者；
 * 被剔除者带 `dropped_reason`（绝不静默丢，契约 §8.3 规则 6）。
 * 「仍成立」判定与扫描**同源**：重跑同一 `evaluateCard` 并要求 (sla_row, 起点) 未变。
 */
export function recheckCandidates(candidates, opts = {}) {
  const tasksDir = opts.tasksDir || TASKS_DIR;
  const workspaceDir = opts.workspaceDir || WORKSPACE_DIR;
  const nowMs = opts.nowMs || Date.now();
  const periodMin = opts.periodMin || CADENCE_PERIOD_MIN;
  const board = (opts.readBoardImpl || readBoard)(tasksDir);
  const ctx = { board, nowMs, periodMin, workspaceDir, host: mechanismHost() };
  const kept = [];
  const dropped = [];
  for (const item of candidates || []) {
    const alert = item && item.alert ? item.alert : item;
    const row = alert && alert.sla_row;
    if (!alert || !row || !R_BY_NAME_HAS(row)) {
      dropped.push({ ...(alert && typeof alert === 'object' ? alert : { value: alert }), dropped_reason: 'malformed_candidate' });
      continue;
    }
    try {
      if (row === LIVENESS_ROW.row) {
        const lv = livenessVerdict(opts.peerState !== undefined ? opts.peerState : readPeerState(), nowMs);
        if (lv.alert) kept.push(item);
        else dropped.push({ ...alert, dropped_reason: `live:${lv.reason}` });
        continue;
      }
      if (row === 'leader_stalled') {
        // 与扫描**同源**重建该候选（§9.6）：条件规则 + 起点都要现态成立才算「仍成立」。
        // 起点在回溯窗外**不是**收口条件（F5）—— 它只影响 confidence，故这里同样照常保留。
        const fresh = stalledCandidate(board, ctx, otherRowCands(board, ctx));
        const freshAlert = fresh ? toAlert(fresh, ctx) : null;
        if (freshAlert && freshAlert.measure_start_at === alert.measure_start_at) {
          kept.push({ alert: freshAlert, cand: fresh });
        } else {
          dropped.push({ ...alert, dropped_reason: freshAlert ? 'live:leader_stalled_origin_changed' : 'live:no_leader_owed_work' });
        }
        continue;
      }
      const card = board.byId.get(alert.card_id);
      if (!card) {
        dropped.push({ ...alert, dropped_reason: 'card_missing' });
        continue;
      }
      const fresh = evaluateCard(card, ctx)
        .map((c) => ({ c, a: toAlert(c, ctx) }))
        .filter((x) => x.a && x.a.sla_row === row);
      const same = fresh.find((x) => x.a.measure_start_at === alert.measure_start_at) || fresh[0];
      if (same) kept.push({ alert: same.a, cand: same.c });
      else dropped.push({ ...alert, dropped_reason: `live_status:${String(card.fm.status || '').trim() || 'no_frontmatter'}` });
    } catch (e) {
      // fail-safe：重核对某卡自身故障 ⇒ **保留原候选**（宁可多报），并记明原因
      kept.push(item);
      dropped.push({ card_id: alert.card_id, sla_row: row, dropped_reason: 'recheck_error_kept', error: String((e && e.message) || e) });
    }
  }
  return { kept, dropped };
}

function R_BY_NAME_HAS(row) {
  return ROW_BY_NAME.has(row);
}

/** leader_stalled 之外的「leader 待处置」行候选（现态重核用；与 scan 同一 `evaluateCard` 判定源）。 */
function otherRowCands(board, ctx) {
  const rows = ['acceptance_card_creation', 'blocked_clarification', 'confirmation_gate', 'defect_card_creation'];
  const out = [];
  for (const card of board.list) {
    for (const c of evaluateCard(card, ctx)) {
      if (rows.includes(c.sla_row)) out.push(c);
    }
  }
  return out;
}

// ── 信封（契约 §10.1）───────────────────────────────────────────────────────────
/**
 * 一次完整巡检：扫描 → 现态重核 → 去重记账 → 信封。
 * 信封键**恰为** `{fire, alerts, dropped, state}`；重复被抑制者亦进 `dropped`（带 `dropped_reason`），
 * 保证「绝不静默丢弃」（契约 §8.3 规则 6）。
 * @returns {{envelope:object, record:(ledgerFile?:string)=>void}}
 */
export function decide(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const taskOpts = { ...opts, nowMs };
  let scanned;
  try {
    scanned = scanSla(taskOpts);
  } catch (e) {
    // 看板不可读 ⇒ fail-closed（契约 §9.3/§10.2）：fire:true + 原因，绝不「无告警」
    return {
      envelope: {
        fire: true,
        alerts: [],
        dropped: [],
        state: { job: 'sla-scan', mechanism: MECHANISM, reason: 'board-unreadable', detail: String((e && e.message) || e), counts: { alerts: 0, dropped: 0, suppressed: 0, candidates: 0 } },
      },
      record: () => {},
    };
  }

  let rechecked;
  let recheckFailed = false;
  try {
    rechecked = recheckCandidates(scanned.candidates, { ...taskOpts, peerState: scanned.peer });
    if (!rechecked || !Array.isArray(rechecked.kept) || !Array.isArray(rechecked.dropped)) recheckFailed = true;
  } catch (e) {
    recheckFailed = true;
    process.stderr.write(`[sla-scan] 重核抛错，fail-safe 保留原候选：${e && e.message ? e.message : e}\n`);
  }
  const kept = recheckFailed ? scanned.candidates : rechecked.kept;
  const dropped = recheckFailed ? [] : rechecked.dropped;

  const ledger = readLedger(opts.ledgerFile || LEDGER_FILE);
  const alerts = [];
  const suppressed = [];
  const nowIsoStr = iso(nowMs);
  const newKeys = [];
  for (const item of kept) {
    const alert = item.alert;
    const key = alert.dedup_key;
    const known = ledger.entries[key];
    if (known) {
      // 已知键：同档重复观测 ⇒ 不告警，但 observed_by/last_seen 仍增长（契约 §8.3 规则 4）
      known.last_seen = nowIsoStr;
      known.observed_by = uniquePush(known.observed_by, MECHANISM);
      suppressed.push({ ...alert, dropped_reason: 'duplicate' });
      continue;
    }
    alerts.push(alert);
    newKeys.push(alert);
  }

  const state = {
    job: 'sla-scan',
    mechanism: MECHANISM,
    mechanism_host: scanned.ctx.host,
    cadence_period_min: taskOpts.periodMin || CADENCE_PERIOD_MIN,
    working_window: { tz: 'Asia/Shanghai', start: '09:00', end: '23:00', basis: 'rolled_over_accumulated' },
    leader_target: 'leader',
    counts: { alerts: alerts.length, dropped: dropped.length, suppressed: suppressed.length, candidates: scanned.candidates.length },
    peer: scanned.peer ? { mechanism: PEER_MECHANISM, last_ok: scanned.liveness.lastOk, age_min: scanned.liveness.ageMin, bound_min: scanned.liveness.boundMin, status: scanned.liveness.reason } : { mechanism: PEER_MECHANISM, last_ok: null, status: 'absent' },
    recheck: recheckFailed ? 'failed' : 'ok',
    notes: [
      scanned.peer ? null : `对端 ${PEER_MECHANISM} 未发布 last_ok 标记 ⇒ 单向覆盖（见 sla-scan.mjs D3；置 OPENCLAW_TEAM_SLA_PEER_REQUIRED=1 可改为失联即告警）`,
    ].filter(Boolean),
  };

  const envelope = { fire: alerts.length > 0, alerts, dropped: [...dropped, ...suppressed], state };

  // 记账在**发出之后**（契约 §8.3 规则 2：先通知后记账；记账失败 ⇒ 下轮重复告警，可接受方向）
  const record = () => {
    for (const a of newKeys) {
      ledger.entries[a.dedup_key] = {
        first_seen: ledger.entries[a.dedup_key] ? ledger.entries[a.dedup_key].first_seen : nowIsoStr,
        last_seen: nowIsoStr,
        observed_by: uniquePush((ledger.entries[a.dedup_key] || {}).observed_by, MECHANISM),
        card_id: a.card_id,
        sla_row: a.sla_row,
        severity: a.severity,
        target: 'leader',
      };
      // 契约 §5.2 规则 4：低档被跳过者记 superseded（审计可见、不通知）
      for (const tier of ['warn', 'overdue']) {
        if (tier === a.severity) break;
        const k = `${a.card_id}#${a.sla_row}#${tier}@${a.measure_start_at || 'unverifiable'}`;
        if (!ledger.entries[k]) {
          ledger.entries[k] = { first_seen: nowIsoStr, last_seen: nowIsoStr, observed_by: [MECHANISM], card_id: a.card_id, sla_row: a.sla_row, severity: tier, superseded: true, target: 'leader' };
        }
      }
    }
    // 零成本空转（契约 §9.4）：本轮无**新键** ⇒ 不写账本文件（被抑制者的 last_seen 不刷新，
    // 代价仅是审计字段略旧；observed_by 在同一机制内不会变化）。liveness 标记仍每次写（契约 §8.4）。
    if (newKeys.length) {
      pruneLedger(ledger, nowMs);
      writeLedger(ledger, opts.ledgerFile || LEDGER_FILE);
    }
    writeSelfState(envelope, nowMs, opts.stateFile || SELF_STATE_FILE);
  };

  return { envelope, record };
}

function uniquePush(arr, v) {
  const a = Array.isArray(arr) ? arr.slice() : [];
  if (!a.includes(v)) a.push(v);
  return a;
}

/** 账本裁剪：保留 `LEDGER_RETAIN_DAYS` 天（裁剪后若等待仍开 ⇒ 下次重新告警=可接受方向）。 */
export const LEDGER_RETAIN_DAYS = 180;
export function pruneLedger(ledger, nowMs) {
  const cut = nowMs - LEDGER_RETAIN_DAYS * DAY_MS;
  for (const [k, v] of Object.entries(ledger.entries)) {
    const ms = parseIso(v && v.last_seen);
    if (Number.isFinite(ms) && ms < cut) delete ledger.entries[k];
  }
  return ledger;
}

/** 己方 liveness 落盘（契约 §8.4 的发布职责；主机本地，漂移巡检已忽略）。 */
export function writeSelfState(envelope, nowMs, file = SELF_STATE_FILE) {
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        mechanism: MECHANISM,
        last_ok: iso(nowMs),
        cadence_period_min: CADENCE_PERIOD_MIN,
        fire: envelope.fire,
        counts: envelope.state.counts,
      }) + '\n',
    );
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    process.stderr.write(`[sla-scan] 状态落盘失败（不影响判定）：${e && e.message ? e.message : e}\n`);
    return false;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
/** 读快照：接受 JSON 数组或 `{alerts:[...]}`；非法 ⇒ null（调用方 fail-closed）。 */
function readSnapshot(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.alerts)) return j.alerts;
    return null;
  } catch {
    return null;
  }
}

function resolveNow(argv) {
  const i = argv.indexOf('--now');
  const raw = i !== -1 && argv[i + 1] ? argv[i + 1] : process.env.OPENCLAW_TEAM_SLA_NOW;
  const ms = parseIso(raw);
  return Number.isFinite(ms) ? ms : Date.now();
}

function print(o) {
  process.stdout.write(JSON.stringify(o) + '\n');
}

// main-guard（realpath 归一，符号链接调用亦命中；被 import 时零副作用）
let IS_MAIN = false;
try {
  IS_MAIN = fs.realpathSync(new URL(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
} catch {
  IS_MAIN = false;
}

if (IS_MAIN) {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(
      [
        'sla-scan.mjs — SLA 巡检（openclaw-cron）：scan → 现态重核 → 去重记账 → 信封',
        '用法: node sla-scan.mjs [--now <ISO>] [--recheck <snapshot.json>]',
        '  （无参数）  跑一次巡检，stdout 恰一行 {fire,alerts,dropped,state}；正常结局恒 exit 0',
        '  --recheck   对在手信封（{alerts:[…]} 或数组）按现态重核后再发',
        '  阈值校验   node check-sla-thresholds.mjs（repo/live 均可，不需要 provider）',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  const nowMs = resolveNow(argv);
  const ri = argv.indexOf('--recheck');
  if (ri !== -1) {
    const snap = argv[ri + 1] ? readSnapshot(argv[ri + 1]) : null;
    if (snap === null) {
      // 快照不可读 ⇒ fail-closed（绝不静默假绿）
      print({ fire: true, alerts: [], dropped: [], state: { job: 'sla-scan', mechanism: MECHANISM, reason: 'snapshot_unreadable', counts: { alerts: 0, dropped: 0, suppressed: 0, candidates: 0 } } });
      process.exit(0);
    }
    const { kept, dropped } = recheckCandidates(snap, { nowMs });
    const alerts = kept.map((k) => (k && k.alert ? k.alert : k)).filter(Boolean);
    print({
      fire: alerts.length > 0,
      alerts,
      dropped,
      state: { job: 'sla-scan', mechanism: MECHANISM, mode: 'recheck', counts: { alerts: alerts.length, dropped: dropped.length, suppressed: 0, candidates: snap.length } },
    });
    process.exit(0);
  }

  const { envelope, record } = decide({ nowMs });
  print(envelope);        // 先发（契约 §8.3 规则 2：通知先于记账）
  record();
  process.exit(0);
}
