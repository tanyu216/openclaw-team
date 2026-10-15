#!/usr/bin/env node
/**
 * lib.mjs — OpenClaw 五人团队共享库
 * 职责：任务卡 frontmatter 读写 / 原子领取(claim) / 项目 metadata registry(get_project)
 * 协议唯一正文：~/.openclaw/team/PROTOCOL.md（本文件实现其看板协议原语）
 *
 * 约定：
 * - TEAM_ROOT 默认 ~/.openclaw/team，可用环境变量 OPENCLAW_TEAM_ROOT 覆盖（单测隔离用）
 * - 卡 id 即文件名（T-YYYYMMDD-HHMMSS.md），引用一律绝对路径
 * - 时间戳一律 ISO 8601 UTC（new Date().toISOString()）
 * - frontmatter 回写保持原键顺序，正文(body)原样保留
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as boardAdapter from './board-adapter.mjs';

// ── provider 依赖显式化（T-20261009-211234-providerdecouple · 方案②启动期硬失败）──
// 路径常量来自 provider ACL 库 skills/task-ops/lib/team-paths.mjs（provider 拥有、有意不随仓
// vendoring，见 skills/PROVENANCE.md）。启动即检测其可用性：缺失 ⇒ 明确错误 + 非零退出，绝不
// 静默 no-op（与 H1/main-guard 静默失效同类高危故障模式）。查找顺序：
//   OPENCLAW_TASK_OPS_DIR（指向含 lib/ 的 task-ops 检出目录）→ {team}/skills/task-ops
//
// 项目（identity code）解析**不再**走 provider 的 projects.mjs：§8 投影现由 team 侧
// `./board-adapter.mjs` 经 CLI 子进程取数（唯一访问点）+ wire 漂移门承担
// （T-20261012-001338 · C 面：不再 import provider 内部、不再直连 sqlite）。
export const TASK_OPS_DIR = process.env.OPENCLAW_TASK_OPS_DIR
  ? path.resolve(process.env.OPENCLAW_TASK_OPS_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'task-ops');
const TASK_OPS_LIB = path.join(TASK_OPS_DIR, 'lib');

const REQUIRED_PROVIDER_LIB = ['team-paths.mjs'];
const missingProviderLib = REQUIRED_PROVIDER_LIB.filter((f) => !fs.existsSync(path.join(TASK_OPS_LIB, f)));
if (missingProviderLib.length) {
  console.error(
    `provider 未安装：脚本依赖 provider ACL 库，缺失 skills/task-ops/lib/{${missingProviderLib.join(', ')}}` +
    `（查找于 ${TASK_OPS_LIB}）。请安装 meerkat-taskpanel 或其它基座（./install.sh --meerkat-taskpanel <dir>），` +
    `或设 OPENCLAW_TASK_OPS_DIR 指向含 lib/ 的 task-ops 检出目录。`
  );
  process.exit(1);
}

// 路径常量单一来源：skills/task-ops/lib/team-paths.mjs（本模块导入并再导出，对外符号不变）
const providerPaths = await import(pathToFileURL(path.join(TASK_OPS_LIB, 'team-paths.mjs')).href);
const { TEAM_ROOT, TASKS_DIR, LOCKS_DIR, PROJECTS_FILE, TEAM_WRITABLE_PREFIX } = providerPaths;
export { TEAM_ROOT, TASKS_DIR, LOCKS_DIR, PROJECTS_FILE };

// 时间阈值（毫秒）——与 PROTOCOL.md 看板协议一致
export const STALE_LOCK_MS = 15 * 60 * 1000;          // 锁 mtime > 15min = 陈旧锁，可清理重试
export const HEARTBEAT_FRESH_MS = 10 * 60 * 1000;     // 心跳新鲜：距上次心跳 ≤ 10min
export const CLAIM_STALE_SAME_MS = 30 * 60 * 1000;    // 陈旧 claim：> 30min 同 assignee 可重领
export const CLAIM_STALE_ANY_MS = 6 * 60 * 60 * 1000; // > 6h 任意 assignee 可领并升级上报

export const AGENTS = ['elon', 'jobs', 'linus', 'turing', 'assistant'];
// 卡 id：T-YYYYMMDD-HHMMSS + 可选多段后缀（如 -designaudit-v1 / -fe-login-review）。
// 每段以字母开头（T-…-v1 这类「段首数字」用 [A-Za-z][A-Za-z0-9]* 兜住整段）。
export const CARD_ID_RE = /^T-\d{8}-\d{6}(-[A-Za-z0-9]+)*$/;

// ---------- 自动领取排除的 kind（部署类卡） ----------
// 口径（PROTOCOL §①；与基座 meerkat-taskpanel 同源，T-20261013-232004 / T-20261014-013629-2）：
// `kind:deploy` = 须在实例/线上执行的高影响卡（重建 dist、重启 taskd、整跑 install.sh 等），
// 由 Elon **显式派发**推进（`issue move` / 指派），**自动候选面不领**。
// 分层与 `epic` **刻意不同**：epic = 领取门拒（claimCard ⇒ `epic_container`，谁都不能领）；
// deploy = **只排除自动候选读**，显式领取路径（claimCard / claim.mjs / ACL task.claim）**不拒**。
// 故本判定只许用在候选扫描侧（poll.mjs#scanCandidates），**不得**下沉进 claimCard。
// 基座对应物：`src/core/domain/claim.mjs#AUTO_CLAIM_EXCLUDED_KINDS` + `isAutoClaimableKind`，
// 由 `commands/tasks.mjs#listCandidates` 在三池（ready/公共池/stale 回收）统一应用（658eb1f）。
export const AUTO_CLAIM_EXCLUDED_KINDS = new Set(['deploy']);

/** 该卡是否参与**自动领取**（自动候选面）：kind 缺省视作 `task`（未知 kind 不误伤）。 */
export function isAutoClaimableKind(fm) {
  return !AUTO_CLAIM_EXCLUDED_KINDS.has(String(fm?.kind ?? 'task').trim());
}

export function nowIso() {
  return new Date().toISOString();
}
export function nowMs() {
  return Date.now();
}
export function parseIso(s) {
  if (!s) return NaN;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? NaN : ms;
}

// 关系图辅助：depends_on 列表解析（与 task-ops 一致）
// 导出供 spawn-lane 的**定基解析**复用（`depends_on` 链 ⇒ 应然的 lane base，T-20261015-133720）：
// 同一张卡的关系面在门（check-relations）与入口（spawn-lane）两侧必须同一口径解析。
export function parseDeps(raw) {
  if (typeof raw !== 'string') return [];
  const s = raw.trim().replace(/^\[|\]$/g, '').replace(/["']/g, '');
  return s.split(/[\s,]+/).filter(Boolean);
}

// ---------- frontmatter ----------
export function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { fm: null, body: raw };
  const fm = {};
  const order = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const k = kv[1];
    let v = kv[2].trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      // 双引号值：与 quoteIfNeeded 的 JSON.stringify 对偶 ⇒ 必须 JSON 反转义。
      // 只剥外层引号会把值内的 \ 与 " 每轮「读→回写」翻倍（指数膨胀事故 T-20261008-214730）。
      try {
        const un = JSON.parse(v);
        v = typeof un === 'string' ? un : v.slice(1, -1);
      } catch {
        v = v.slice(1, -1); // 非合法 JSON（手写/异常）：退回仅剥最外层引号
      }
    } else if (v.startsWith("'") && v.endsWith("'")) {
      v = v.slice(1, -1); // 单引号：维持旧行为（仅剥外层）
    } else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^\d+$/.test(v)) v = Number(v);
    fm[k] = v;
    order.push(k);
  }
  fm.__order = order;
  return { fm, body: raw.slice(m[0].length) };
}

export function serializeFrontmatter(fm, body) {
  const order = Array.isArray(fm.__order) ? fm.__order : [];
  const known = order.filter((k) => k !== '__order');
  const extra = Object.keys(fm).filter((k) => k !== '__order' && !known.includes(k));
  const lines = ['---'];
  for (const k of [...known, ...extra]) {
    const v = fm[k];
    if (v === undefined || v === null || v === '') continue;
    lines.push(`${k}: ${renderValue(v)}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n' + body;
}

function renderValue(v) {
  // 列表字段一律数组形式：[] / [a, b]（元素按需引号，普通 id 不加引号）
  if (Array.isArray(v)) return '[' + v.map((e) => quoteIfNeeded(String(e))).join(', ') + ']';
  return typeof v === 'string' ? quoteIfNeeded(v) : String(v);
}

function quoteIfNeeded(v) {
  // 含冒号/引号/#/前后空白或为空时用 JSON 引号包裹，保证 round-trip
  return /[:#"']|^\s|\s$|^$/.test(v) ? JSON.stringify(v) : v;
}

// ---------- 项目内路径口径（PROTOCOL §②.1 的机械基元） ----------
/**
 * 写集分割 —— `writes` 口径的**唯一持有者**（`samefile-guard.mjs` 与 `check-card.mjs` 共用，
 * 避免两处政策漂移）。数组直接取；字符串剥 `[]`/引号后按逗号切；其余（数字/布尔/undefined）⇒ 空集。
 */
export function splitWrites(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw !== 'string') return [];
  const s = raw.trim().replace(/^\[|\]$/g, '').replace(/["']/g, '');
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * 项目内相对路径判定（PROTOCOL §②.1）：返回 null（合法）或人读逃逸原因。
 * 判据：① 绝对路径 `/…`；② 本机锚 `~…`；③ 盘符绝对 `C:\`/`C:/`；④ **段归一后越出起点**的相对路径
 * —— 看的是 `..` 出现在**任意位置**，不只看开头（`/^\.\.\//` 会把 `a/../../b` 漏过去）。
 * 纯字面：不触盘、不解析符号链接（symlink 越界由运行期 realpath containment 兜，见 §②.1）。
 */
export function escapeReason(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.startsWith('/')) return '绝对路径';
  if (s.startsWith('~')) return '本机锚路径（~）';
  if (/^[A-Za-z]:[\\/]/.test(s)) return '盘符绝对路径';
  let depth = 0;
  for (const seg of s.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (--depth < 0) return '相对路径越界（../ 逃逸）'; }
    else depth++;
  }
  return null;
}

// ---------- 任务卡 IO ----------
export function cardPathOf(arg) {
  // 入参：绝对路径 或 卡 id（T-…）；返回规范绝对路径
  let p = arg;
  if (CARD_ID_RE.test(arg)) p = path.join(TASKS_DIR, `${arg}.md`);
  p = path.resolve(p);
  const base = path.basename(p);
  if (!base.endsWith('.md') || !CARD_ID_RE.test(base.slice(0, -3))) {
    throw new Error(`非法任务卡路径/id: ${arg}`);
  }
  return p;
}

export function readCard(cardPath) {
  const p = cardPathOf(cardPath);
  const raw = fs.readFileSync(p, 'utf8');
  const { fm, body } = parseFrontmatter(raw);
  return { cardPath: p, fm, body, raw };
}

/**
 * 按卡 **id** 读卡（扫描任务目录取 `fm.id` 命中的那张）。
 * 为什么不直接用 `cardPathOf(id)`：文件名**可以带 slug**（历史卡如 `T-20261008-174500-uialignsop.md`，
 * 其 `id` 却是 `T-20261008-174500`）⇒ 按 `<id>.md` 猜路径会漏。本函数按 frontmatter 的 `id` 命中，
 * 与 `check-relations` / `lane-isolation.scanNonTerminal` 同一口径。
 * 未命中（不存在 / 不可读）⇒ `null`——**绝不臆造**一张卡（调用方决定回落口径）。
 * @param {string} id 卡 id（`T-…`）
 * @param {{tasksDir?:string}} [opts] 注入目录（单测隔离用；默认本进程的 TASKS_DIR）
 * @returns {{cardPath:string, fm:object, body:string, raw:string}|null}
 */
export function readCardById(id, { tasksDir = TASKS_DIR } = {}) {
  const want = String(id == null ? '' : id).trim();
  if (!want) return null;
  let files;
  try {
    files = fs.readdirSync(tasksDir);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const p = path.join(tasksDir, f);
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    if (fm && String(fm.id) === want) return { cardPath: p, fm, body, raw };
  }
  return null;
}

export function writeCardAtomic(cardPath, fm, body) {
  const p = cardPathOf(cardPath);
  // 先序列化再做护栏校验：异常体积直接拒绝，绝不落盘（避免部分写入/静默膨胀）
  const out = serializeFrontmatter(fm, body);
  if (fs.existsSync(p)) {
    const prev = fs.statSync(p).size;
    if (out.length > prev * 4) {
      const ratio = prev > 0 ? (out.length / prev).toFixed(2) : 'Infinity';
      throw new Error(
        `拒绝写入：疑似 frontmatter 转义膨胀 (card=${p} prev=${prev}B next=${out.length}B, ratio=${ratio}x > 4x)`
      );
    }
  }
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, p); // 同目录 rename = 原子替换
}

export function refreshHeartbeat(cardPath, assignee) {
  const { fm, body } = readCard(cardPath);
  if (fm.status !== 'in_progress') return { ok: false, reason: `status=${fm.status}` };
  if (fm.claimed_by !== assignee) return { ok: false, reason: `claimed_by=${fm.claimed_by}` };
  fm.heartbeat_at = nowIso();
  writeCardAtomic(cardPath, fm, body);
  touchTurnLock(turnLockPath(cardPath)); // 心跳续锁（跨回合锁与心跳同步保鲜）
  return { ok: true, heartbeat_at: fm.heartbeat_at };
}

// ---------- 原子领取 ----------
function lockPath(cardPath, assignee) {
  const id = path.basename(cardPath, '.md');
  return path.join(LOCKS_DIR, `${id}.claim.${assignee}`);
}

// ---------- 同卡跨回合锁（provider/round 锁；T-20261009-211234-concurrencyharden） ----------
// 一个**与 registry 无关**的持久互斥锁：claim 成功 / heartbeat 刷新时 touch，terminal（done/failed）
// 或 session-close 时释放。作用 = 即便 claude-sessions.json 缺席/不一致（m7 类故障）也能拦下跨回合重领。
// 锁新鲜窗口 = STALE_LOCK_MS（15min，略长于心跳新鲜 10min ⇒ 心跳可正常续锁）。
function turnLockPath(cardPath) {
  const id = path.basename(cardPath, '.md');
  return path.join(LOCKS_DIR, `${id}.turn`);
}

/** 锁龄（ms）；锁不存在 ⇒ Infinity */
function turnLockAgeMs(turnPath) {
  try {
    return nowMs() - fs.statSync(turnPath).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** 刷新（无则创建）跨回合锁：写时间戳占位文件（mtime 即新鲜度依据） */
function touchTurnLock(turnPath) {
  try {
    fs.mkdirSync(LOCKS_DIR, { recursive: true });
  } catch {
    /* LOCKS_DIR 已存在或不可建（写锁时再暴露） */
  }
  fs.writeFileSync(turnPath, String(nowMs()), 'utf8');
}

/** 释放跨回合锁（幂等；锁不存在/已清理不报错） */
export function releaseTurnLock(cardArg) {
  try {
    fs.unlinkSync(turnLockPath(cardPathOf(cardArg)));
  } catch {
    /* 无锁可释放 ⇒ 忽略 */
  }
}

function mkdirLock(lockDir) {
  try {
    fs.mkdirSync(lockDir, { recursive: false });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

// 领取守卫的状态归类：规范词表（skills/task-ops/lib/task.mjs：#CANONICAL_STATUSES 含 `todo`；
// `ready` 仅见于 #STATUS_ALIASES，是兼容别名）与守卫原实现两处口径曾不一致——守卫只认字面量
// `ready`，反把**规范值** `todo` 挡在门外（T-20261014-204530：卡被送回为 `todo` 后 claim 静默
// `status=todo` 拒领，换人/换脚本即卡死）。归一：`todo`（规范）与 `ready`（兼容别名）**同视为
// new**；仅此二者，不引入第三种语义。
export const NEW_STATUSES = new Set(['todo', 'ready']);
export const isNewStatus = (s) => NEW_STATUSES.has(s);

/** 尝试清理陈旧锁；返回 true=已清理（可重试加锁） */
function clearStaleLockIfAllowed(lockDir, fm, now) {
  let st;
  try {
    st = fs.statSync(lockDir);
  } catch {
    return true; // 锁已被清（竞态窗口）
  }
  if (now - st.mtimeMs <= STALE_LOCK_MS) return false; // 锁新鲜：正在被其他进程使用
  // 锁陈旧（>15min）：卡仍 new（todo/ready）→ 删锁重试；卡 in_progress 且心跳过期 → 删锁交恢复路径
  const hb = parseIso(fm.heartbeat_at);
  const hbStale = Number.isNaN(hb) ? true : now - hb > CLAIM_STALE_SAME_MS;
  if (isNewStatus(fm.status) || (fm.status === 'in_progress' && hbStale)) {
    try {
      fs.rmdirSync(lockDir);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 原子领取（幂等）：claim.mjs 与 poll.mjs 共用。
 * 规则（PROTOCOL 看板协议）：
 *  - 仅 assignee 匹配 + new（todo 规范值 / ready 兼容别名，或满足陈旧恢复）可领
 *  - mkdir 抢锁失败 → 不动作（他进程正在领）
 *  - 成功 → 整卡 tmp+rename 写 in_progress + claimed_by/claimed_at/heartbeat_at → 释放锁
 *  - in_progress + 心跳新鲜（≤10min）→ 不动（执行唯一性：仅回报）
 */
export function claimCard(cardArg, assignee) {
  if (!AGENTS.includes(assignee)) return { ok: false, reason: `unknown_assignee:${assignee}` };
  const cardPath = cardPathOf(cardArg);
  if (!fs.existsSync(cardPath)) return { ok: false, reason: 'not_found' };
  try {
    fs.mkdirSync(LOCKS_DIR, { recursive: true }); // 直派路径无 poll main 预建锁目录，此处兜底
  } catch {
    /* 锁目录已存在或不可建（mkdirLock 会再暴露具体错误） */
  }

  const now = nowMs();
  let { fm, body } = readCard(cardPath);
  // 关系守卫（task-interface）：容器卡不可领；前置未完成不可领
  if ((fm.kind || 'task') === 'epic') return { ok: false, reason: 'epic_container', card: fm };
  const warnings = []; // 保留字段：本门当前无 warning 产出（原 review_of_not_found 随上界收紧取消）
  {
    // 复核门（T-20261013-233052，为 000246 的豁免补上界）：复核卡（review_of 非空）的可领性**只看
    // 被复核卡的状态**——目标存在且 status=in_review（已交付、待验证）才可领，否则一律拒领
    // review_not_ready（附 review_of + 目标实际 status；目标不可读 ⇒ status=null）。
    //   · 目标 ready/todo/in_progress/blocked ⇒ 拒：尚未交付，早领 = 空跑（实证 T-20261013-232004-2
    //     于 2026-10-13T15:25:08Z 被 poll 领取时被复核卡 T-20261013-232004 仍 in_progress ⇒ triage
    //     以「无可验证产物」置 blocked）；
    //   · 目标 done/canceled/failed ⇒ 拒：验收/终止已发生，复核已无标的，应由 Elon 直接收口而非领取空转；
    //   · 目标不存在 ⇒ 拒：失去验证对象的复核卡只会空跑（旧口径「不阻塞 + warning review_of_not_found」
    //     随之取消）。
    // 本门**独立于 depends_on**：是否把被复核卡写进 dep 不影响判定（旧口径只在 dep 命中豁免分支时才
    // 校验目标状态，故「复核卡不写 dep」这一常见形态无上界）。
    // 豁免（T-20261013-000246）按原样保留、且仅在目标 in_review 时可达：dep 恰等于 review_of 的那一项
    // 不计入 done 门——目标恒停在 in_review 等验证、永不先 done，该 dep 本就恒不可满足；其余 dep 照旧。
    const ds = parseDeps(fm.depends_on);
    const reviewed = typeof fm.review_of === 'string' ? fm.review_of.trim() : '';
    let effective = ds;
    if (reviewed) {
      let reviewedStatus = null;
      try {
        reviewedStatus = readCard(reviewed).fm.status;
      } catch {
        return { ok: false, reason: 'review_not_ready', review_of: reviewed, status: null, card: fm };
      }
      if (reviewedStatus !== 'in_review') {
        return { ok: false, reason: 'review_not_ready', review_of: reviewed, status: reviewedStatus, card: fm };
      }
      effective = ds.filter((d) => d !== reviewed);
    }
    if (effective.length) {
      const unmet = effective.filter((d) => { try { return readCard(d).fm.status !== 'done'; } catch { return true; } });
      if (unmet.length) return { ok: false, reason: 'deps_unmet', deps: unmet, card: fm };
    }
  }
  if (fm.assignee !== assignee) return { ok: false, reason: `wrong_assignee(assignee=${fm.assignee})` };

  let mode;
  if (isNewStatus(fm.status)) {
    mode = 'new';
  } else if (fm.status === 'in_progress') {
    const hb = parseIso(fm.heartbeat_at);
    const age = Number.isNaN(hb) ? now : now - hb;
    if (age <= HEARTBEAT_FRESH_MS) {
      return { ok: false, reason: 'in_progress_fresh', card: fm };
    }
    if (fm.claimed_by === assignee && age > CLAIM_STALE_SAME_MS) mode = 'recover_same';
    else if (age > CLAIM_STALE_ANY_MS) mode = 'recover_any';
    else return { ok: false, reason: `in_progress_stale_other(claimed_by=${fm.claimed_by},age_ms=${Math.round(age / 1000)}s)`, card: fm };
  } else {
    return { ok: false, reason: `status=${fm.status}`, card: fm };
  }

  // 同卡跨回合锁：领取前查持久锁（与 registry 无关的兜底互斥，见 turnLockPath 注释）。
  //  - new（todo/ready）⇒ 残留锁清除（无持有者，不应阻塞领取）；
  //  - 恢复（recover_same/recover_any）⇒ 新鲜锁（≤ STALE_LOCK_MS）仍被持有 ⇒ 不领（turn_locked）；
  //    陈旧锁 ⇒ 清除后走恢复。
  const turnPath = turnLockPath(cardPath);
  if (mode === 'new') {
    if (turnLockAgeMs(turnPath) !== Infinity) {
      try { fs.unlinkSync(turnPath); } catch { /* 竞态清理，忽略 */ }
    }
  } else {
    if (turnLockAgeMs(turnPath) <= STALE_LOCK_MS) {
      return { ok: false, reason: 'turn_locked', card: fm };
    }
    try { fs.unlinkSync(turnPath); } catch { /* 无锁/已清理，忽略 */ }
  }

  const lockDir = lockPath(cardPath, assignee);
  if (!mkdirLock(lockDir)) {
    // 锁存在：陈旧则清理后重试一次
    const cleared = clearStaleLockIfAllowed(lockDir, fm, now);
    if (!cleared || !mkdirLock(lockDir)) {
      return { ok: false, reason: 'locked', card: fm };
    }
  }
  try {
    // 抢锁成功后重新读卡（期间状态可能已变），二次校验
    ({ fm, body } = readCard(cardPath));
    if (!(isNewStatus(fm.status) || fm.status === 'in_progress')) {
      return { ok: false, reason: `status_changed(${fm.status})`, card: fm };
    }
    if (fm.status === 'in_progress') {
      const hb = parseIso(fm.heartbeat_at);
      const age = Number.isNaN(hb) ? now : now - hb;
      if (age <= HEARTBEAT_FRESH_MS) return { ok: false, reason: 'in_progress_fresh', card: fm };
    }
    const ts = nowIso();
    fm.status = 'in_progress';
    fm.claimed_by = assignee;
    fm.claimed_at = ts;
    fm.heartbeat_at = ts;
    writeCardAtomic(cardPath, fm, body);
    touchTurnLock(turnPath); // 领取成功 ⇒ 持有跨回合锁
    return { ok: true, mode, card: fm, cardPath, warnings };
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      /* 锁可能已被陈旧清理删除，忽略 */
    }
  }
}

// ---------- 项目 metadata ----------
/**
 * 内置保留名 `__team__`（PROTOCOL ②）：团队内部杂务专用，不查基座 / 不查回退。
 *
 * 逐字段与 provider 基座此前的输出一致（对外行为不变）；该保留名是**团队**约定，故由 team 侧持有。
 * 仅可写 ~/.openclaw/team/**（`TEAM_WRITABLE_PREFIX` 来自 provider 路径常量单一来源）。
 */
export function teamProject() {
  return {
    name: '__team__',
    kind: 'team',
    root: null,
    writable: [TEAM_WRITABLE_PREFIX],
    repos: [],
    guides: [`${TEAM_ROOT}/PROTOCOL.md`],
    default_git_rules: '仅写 ~/.openclaw/team/**；无项目仓库访问权',
    registered_at: null,
  };
}

/**
 * get_project(name) → 项目 metadata（identity code）。
 *
 * 经 ACL 解析（guides/task-interface.md §8/§12），**team 侧**实现：
 *   `__team__`（内置）→ 基座（`taskctl project list --json` 子进程取数 + wire 漂移门，见 board-adapter.mjs）
 *   → 只读回退 projects.json（过渡期权威快照）→ 未注册抛错。
 *
 * 基座不可用/漂移 ⇒ **降级**（回退 projects.json），漂移另有显式 stderr 告警（绝不静默）。
 * @param {string} name identity code
 * @param {object} [opts] 透传 board-adapter（如 `{baseOpts:{taskctl, runner}}`，测试用）
 */
export function getProject(name, opts = {}) {
  return boardAdapter.getProject(name, { builtin: teamProject(), fallbackFile: PROJECTS_FILE, ...opts });
}

// ---------- CLI ----------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'get-project': {
      console.log(JSON.stringify(getProject(rest[0]), null, 2));
      break;
    }
    case 'read-card': {
      const { cardPath, fm, body } = readCard(rest[0]);
      console.log(JSON.stringify({ cardPath, frontmatter: fm, body }, null, 2));
      break;
    }
    case 'claim': {
      const [cardArg, assignee] = rest;
      console.log(JSON.stringify(claimCard(cardArg, assignee), null, 2));
      break;
    }
    case 'heartbeat': {
      const [cardArg, assignee] = rest;
      console.log(JSON.stringify(refreshHeartbeat(cardPathOf(cardArg), assignee), null, 2));
      break;
    }
    default:
      console.error(`用法:
  node lib.mjs get-project <name>      # 项目 metadata（__team__ 为保留名）
  node lib.mjs read-card <cardId|path> # 读卡（frontmatter + body）
  node lib.mjs claim <cardId|path> <assignee>   # 原子领取
  node lib.mjs heartbeat <cardId|path> <assignee>  # 刷新心跳（in_progress）
`);
      process.exit(2);
  }
}

// main-guard：经 realpath 归一后比较，符号链接调用亦能命中（import.meta.url 为真实路径，argv[1] 可能是链接路径）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) {
    main().catch((e) => {
      console.error(String(e?.message || e));
      process.exit(1);
    });
  }
} catch { /* realpath 失败 ⇒ 不执行 main */ }
