#!/usr/bin/env node
/**
 * poll.mjs — cron 兜底轮询条件触发脚本（automations --trigger-script）
 * 用法：node poll.mjs <assignee>            # Phase 1 单测 / 显式传参
 *       node poll.mjs --agent <assignee>    # 同上
 * 身份来源：argv 优先；否则按序尝试环境变量（OPENCLAW_AGENT_ID / OPENCLAW_AGENT / AGENT_ID）——
 *          真实 trigger-script 注入的环境变量名在 Phase 2 实测后回填（复核清单 #13）
 *
 * 契约（automation cron-jobs Event triggers）：
 * - 返回 JSON { fire, message?, state? }；fire:false 零成本空转（不产生 run 记录）
 * - 只做"只读扫描 + 幂等原子领取"，动作留给 run 回合 payload
 * - 一轮可领取**多张**（上限 = 该 agent 并发额度 − 当前 running；且仅领**互不冲突**的卡）
 * - fire:true ⇔ 本轮至少成功领取一张（卡已转 in_progress、claimed_by=自己）——run 回合直接执行、不再 claim
 * - in_progress + 心跳新鲜（含 claimed_by=自己）→ 不动，fire:false
 * - 领取前防双跑守卫：有活跃子会话不重领（即使心跳陈旧也不越过守卫）
 * - 写冲突粗判（§⑥.3 单写者）：同 project+target 视为同资源 ⇒ 冲突组每轮只领 1 张（串行）
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  TEAM_ROOT,
  TASKS_DIR,
  LOCKS_DIR,
  AGENTS,
  CARD_ID_RE,
  CLAIM_STALE_SAME_MS,
  CLAIM_STALE_ANY_MS,
  parseIso,
  parseFrontmatter,
  claimCard,
  nowMs,
} from './lib.mjs';
import { activeSessions, formatActiveReason, loadRegistry, isPidAlive } from './registry.mjs';

/** 并发额度（PROTOCOL §⑥ 第 2 条 / §⑥.3）：Linus/Jobs/Simons=8、Turing=3；其余 agent 未定义 */
export const CONCURRENCY_QUOTA = { linus: 8, jobs: 8, simons: 8, turing: 3 };

/** Turing 的 codex 子会话 registry（PROTOCOL §⑥：Turing 用 turing-runs.json，非 claude-sessions.json） */
const TURING_RUNS_FILE = path.join(TEAM_ROOT, 'turing-runs.json');

export function resolveAssignee() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent' && argv[i + 1]) return argv[i + 1];
  }
  for (const a of argv) if (AGENTS.includes(a)) return a;
  for (const env of ['OPENCLAW_AGENT_ID', 'OPENCLAW_AGENT', 'AGENT_ID']) {
    if (process.env[env] && AGENTS.includes(process.env[env])) return process.env[env];
  }
  return null;
}

function createdMs(fm, filePath) {
  const t = parseIso(fm.created_at);
  if (!Number.isNaN(t)) return t;
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return nowMs();
  }
}

/** 只读扫描候选：ready(assignee=自己) 优先，其次陈旧恢复（>30min 同 agent / >6h 任意） */
export function scanCandidates(assignee) {
  const now = nowMs();
  const cards = [];
  if (!fs.existsSync(TASKS_DIR)) return cards;
  for (const f of fs.readdirSync(TASKS_DIR)) {
    if (!f.endsWith('.md') || !CARD_ID_RE.test(f.slice(0, -3))) continue;
    const p = path.join(TASKS_DIR, f);
    let fm;
    try {
      fm = parseFrontmatter(fs.readFileSync(p, 'utf8')).fm;
    } catch {
      continue;
    }
    if (!fm || !fm.id || fm.assignee !== assignee) continue;
    let cand = null;
    if (fm.status === 'ready') cand = { reason: 'ready', rank: 0 };
    else if (fm.status === 'in_progress') {
      const hb = parseIso(fm.heartbeat_at);
      const age = Number.isNaN(hb) ? Infinity : now - hb;
      if (age > CLAIM_STALE_ANY_MS) cand = { reason: 'stale_any', rank: 1 };
      else if (fm.claimed_by === assignee && age > CLAIM_STALE_SAME_MS) cand = { reason: 'stale_same', rank: 1 };
    }
    if (cand) cards.push({ filePath: p, fm, rank: cand.rank, reason: cand.reason });
  }
  cards.sort((a, b) => a.rank - b.rank || createdMs(a.fm, a.filePath) - createdMs(b.fm, b.filePath));
  return cards;
}

/**
 * 只读候选查询（**零副作用**）：供守卫/诊断，绝不领取、不写卡、不抢锁。
 * 契约（task-interface §4.1）：领取仍唯一走 pollEvaluate/runPoll；本函数仅返回 poll **会考虑**的
 * 候选（ready 优先 + 陈旧恢复），不含并发额度削减与防双跑守卫的过滤（那是 pollEvaluate 的职责）。
 * @returns {{ok:true, candidates:Array<{cardPath,id,assignee,status,title,reason,rank,claimed_by,heartbeat_at}>}}
 */
export function pollCandidates(assignee, { registry = null } = {}) {
  const candidates = scanCandidates(assignee);
  return {
    ok: true,
    candidates: candidates.map((c) => ({
      cardPath: c.filePath,
      id: c.fm.id,
      assignee: c.fm.assignee,
      status: c.fm.status,
      title: c.fm.title ?? '',
      reason: c.reason,
      rank: c.rank,
      claimed_by: c.fm.claimed_by ?? '',
      heartbeat_at: c.fm.heartbeat_at ?? '',
    })),
  };
}

/** 读 turing-runs.json（Turing 的 codex 子会话 registry）；缺失/损坏/非数组 ⇒ [] */
export function readTuringRuns() {
  try {
    const data = JSON.parse(fs.readFileSync(TURING_RUNS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const isAliveRunning = (e) => !!e && e.status === 'running' && isPidAlive(e.pid);

/**
 * 当前该 agent 的活跃（running）子会话数（并发计数）。
 * 口径（PROTOCOL §⑥）：Turing 用 turing-runs.json；其余用 claude-sessions.json（registry 唯一事实源）。
 */
export function runningCount(assignee, { registry = null } = {}) {
  if (assignee === 'turing') return readTuringRuns().filter((e) => e.owner === 'turing' && isAliveRunning(e)).length;
  const reg = registry == null ? loadRegistry() : registry;
  return reg.filter((e) => e.owner === assignee && isAliveRunning(e)).length;
}

/** 该 agent 并发额度；未定义（如 assistant/elon）⇒ null */
export function concurrencyQuota(assignee) {
  return CONCURRENCY_QUOTA[assignee] ?? null;
}

/**
 * 写面粗判冲突键（§⑥.3 单写者）：同 project+target ⇒ 同资源写冲突 ⇒ 冲突组只领 1 张。
 * 两者皆无 ⇒ 空串（保守：所有「未知写面」卡归入同一组，串行）。
 */
export function conflictKey(fm) {
  const project = String(fm?.project ?? '').trim();
  const target = String(fm?.target ?? '').trim();
  return `${project}\u0000${target}`;
}

/** 本轮可领额度 = 并发额度 − 当前 running；额度未定义 ⇒ 保守 1（保留旧「每轮至多 1 张」行为） */
export function claimBudget(assignee, { registry = null } = {}) {
  const quota = concurrencyQuota(assignee);
  if (quota == null) return 1;
  return Math.max(0, quota - runningCount(assignee, { registry }));
}

/**
 * 一轮轮询：领取前先查防双跑守卫；在并发额度内领取多张互不冲突的卡。
 * 顺序：候选按 ready 优先 + created_at 升序；冲突组内取最先者，其余该组候选本轮串行跳过。
 */
export function runPoll({ assignee, registry = null }) {
  const candidates = scanCandidates(assignee);
  const budget = claimBudget(assignee, { registry });
  const claimed = [];
  const guarded = [];     // 防双跑守卫跳过（有活跃子会话）
  const conflicted = [];  // 写冲突跳过（同 project+target 已领 1 张）
  const failed = [];      // 领取失败（锁竞争/deps_unmet/status 变化）——继续尝试下一张
  const claimedKeys = new Set();

  if (budget > 0) {
    for (const c of candidates) {
      if (claimed.length >= budget) break;
      const active = activeSessions(c.fm.id, { registry });
      if (active.length) {
        guarded.push({ card: c.fm.id, reason: formatActiveReason(active) });
        continue;
      }
      const key = conflictKey(c.fm);
      if (claimedKeys.has(key)) {
        conflicted.push({ card: c.fm.id, reason: `write_conflict(project=${c.fm.project ?? ''},target=${c.fm.target ?? ''})` });
        continue;
      }
      const r = claimCard(c.filePath, assignee);
      if (r.ok) {
        claimed.push(r);
        claimedKeys.add(key);
      } else {
        // 领取失败不占冲突组（该组仍可被后续候选领取），继续尝试下一张候选
        failed.push({ card: c.fm.id, reason: r.reason || 'claim_failed' });
      }
    }
  }

  if (claimed.length) {
    const ids = claimed.map((r) => r.card.id);
    const list = claimed.map((r, i) => `${i + 1}. ${r.cardPath}`);
    const message = `【${assignee} 轮询领取】本轮已领 ${claimed.length} 张卡（并发额度内、互不冲突，可并行执行）：\n${list.join('\n')}\n—— 均已原子领取（status=in_progress, claimed_by=${assignee}），直接执行不再 claim；执行中每 ≤10min 刷新 heartbeat_at，完成后按 PROTOCOL 汇报。`;
    return {
      fire: true,
      message,
      state: {
        cardId: ids[0],
        cardIds: ids,
        cardPaths: claimed.map((r) => r.cardPath),
        cards: claimed.map((r) => ({ cardPath: r.cardPath, cardId: r.card.id, title: r.card.title, mode: r.mode })),
        claimed: claimed.length,
        budget,
        skipped: [...guarded, ...conflicted].map((s) => s.card),
        failed: failed.map((f) => f.card),
      },
    };
  }

  if (budget <= 0) {
    return { fire: false, message: `poll.mjs: ${assignee} 并发额度已满（running 已达额度），本轮零成本空转` };
  }
  if (guarded.length) {
    const detail = guarded.map((s) => `[${s.card} ${s.reason}]`).join(' ');
    return {
      fire: false,
      message: `poll.mjs: 跳过 ${guarded.length} 张有活跃子会话的卡（防双跑），未重领：${detail}`,
    };
  }
  return { fire: false };
}

function main() {
  const assignee = resolveAssignee();
  if (!assignee) {
    console.log(JSON.stringify({ fire: false, message: 'poll.mjs: 无法确定 agent 身份（需 argv 或环境变量）' }));
    process.exit(0);
  }
  if (!fs.existsSync(LOCKS_DIR)) fs.mkdirSync(LOCKS_DIR, { recursive: true });

  console.log(JSON.stringify(runPoll({ assignee })));
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
