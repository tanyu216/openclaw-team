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

// 路径常量单一来源：skills/task-ops/lib/team-paths.mjs（本模块导入并再导出，对外符号不变）
import { TEAM_ROOT, TASKS_DIR, LOCKS_DIR, PROJECTS_FILE } from '../skills/task-ops/lib/team-paths.mjs';
import { getProject as aclGetProject } from '../skills/task-ops/lib/projects.mjs';
export { TEAM_ROOT, TASKS_DIR, LOCKS_DIR, PROJECTS_FILE };

// 时间阈值（毫秒）——与 PROTOCOL.md 看板协议一致
export const STALE_LOCK_MS = 15 * 60 * 1000;          // 锁 mtime > 15min = 陈旧锁，可清理重试
export const HEARTBEAT_FRESH_MS = 10 * 60 * 1000;     // 心跳新鲜：距上次心跳 ≤ 10min
export const CLAIM_STALE_SAME_MS = 30 * 60 * 1000;    // 陈旧 claim：> 30min 同 assignee 可重领
export const CLAIM_STALE_ANY_MS = 6 * 60 * 60 * 1000; // > 6h 任意 assignee 可领并升级上报

export const AGENTS = ['elon', 'jobs', 'linus', 'simons', 'turing', 'assistant'];
// 卡 id：T-YYYYMMDD-HHMMSS + 可选多段后缀（如 -designaudit-v1 / -fe-login-review）。
// 每段以字母开头（T-…-v1 这类「段首数字」用 [A-Za-z][A-Za-z0-9]* 兜住整段）。
export const CARD_ID_RE = /^T-\d{8}-\d{6}(-[A-Za-z0-9]+)*$/;

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
function parseDeps(raw) {
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
  return { ok: true, heartbeat_at: fm.heartbeat_at };
}

// ---------- 原子领取 ----------
function lockPath(cardPath, assignee) {
  const id = path.basename(cardPath, '.md');
  return path.join(LOCKS_DIR, `${id}.claim.${assignee}`);
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

/** 尝试清理陈旧锁；返回 true=已清理（可重试加锁） */
function clearStaleLockIfAllowed(lockDir, fm, now) {
  let st;
  try {
    st = fs.statSync(lockDir);
  } catch {
    return true; // 锁已被清（竞态窗口）
  }
  if (now - st.mtimeMs <= STALE_LOCK_MS) return false; // 锁新鲜：正在被其他进程使用
  // 锁陈旧（>15min）：卡仍 ready → 删锁重试；卡 in_progress 且心跳过期 → 删锁交恢复路径
  const hb = parseIso(fm.heartbeat_at);
  const hbStale = Number.isNaN(hb) ? true : now - hb > CLAIM_STALE_SAME_MS;
  if (fm.status === 'ready' || (fm.status === 'in_progress' && hbStale)) {
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
 *  - 仅 assignee 匹配 + ready（或满足陈旧恢复）可领
 *  - mkdir 抢锁失败 → 不动作（他进程正在领）
 *  - 成功 → 整卡 tmp+rename 写 in_progress + claimed_by/claimed_at/heartbeat_at → 释放锁
 *  - in_progress + 心跳新鲜（≤10min）→ 不动（执行唯一性：仅回报）
 */
export function claimCard(cardArg, assignee) {
  if (!AGENTS.includes(assignee)) return { ok: false, reason: `unknown_assignee:${assignee}` };
  const cardPath = cardPathOf(cardArg);
  if (!fs.existsSync(cardPath)) return { ok: false, reason: 'not_found' };

  const now = nowMs();
  let { fm, body } = readCard(cardPath);
  // 关系守卫（task-interface）：容器卡不可领；前置未完成不可领
  if ((fm.kind || 'task') === 'epic') return { ok: false, reason: 'epic_container', card: fm };
  {
    const ds = parseDeps(fm.depends_on);
    if (ds.length) {
      const unmet = ds.filter((d) => { try { return readCard(d).fm.status !== 'done'; } catch { return true; } });
      if (unmet.length) return { ok: false, reason: 'deps_unmet', deps: unmet, card: fm };
    }
  }
  if (fm.assignee !== assignee) return { ok: false, reason: `wrong_assignee(assignee=${fm.assignee})` };

  let mode;
  if (fm.status === 'ready') {
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
    if (!(fm.status === 'ready' || fm.status === 'in_progress')) {
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
    return { ok: true, mode, card: fm, cardPath };
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
 * get_project(name) → 项目 metadata（identity code）。
 *
 * 经 ACL 解析（skills/task-ops/lib/projects.mjs，见 guides/task-interface.md §8）：
 *   __team__（内置）→ 基座（当前 task-panel `projects` 表）→ 只读回退 projects.json → 未注册抛错。
 * 保留名 __team__ 不查基座/回退：团队内部杂务专用，仅可写 ~/.openclaw/team/**。
 */
export function getProject(name) {
  return aclGetProject(name);
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
