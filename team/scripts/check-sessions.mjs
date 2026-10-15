#!/usr/bin/env node
/**
 * check-sessions.mjs — 卡↔registry 子会话一致性守卫（spawn 登记一致性）
 *
 * 背景（T-20261009-211234-concurrencyharden 追加实证 m7）：某卡 `## Sessions` 为空，registry 却有
 * 2 条 running（pid 存活）⇒ 登记只走了 registry、未走 `task.session-set`（卡 + registry 同写）。
 * 本守卫双向比对，把这类不一致作为**门禁**报出（check-all 接入）：
 *
 *   硬失败（不一致，exit 1）——「活跃但另一侧缺失」才判硬：
 *     - registry_only：registry running+pid 存活，卡内无对应 running Sessions 行（m7 主例）；
 *     - card_only：卡内 Sessions running 行且卡行 pid 存活，registry 无对应条目（spawn 漏写 registry）。
 *   软告警（note，不影响退出码）：
 *     - zombie_registry：registry running 但 pid 不存活（reconcile 的职责，非 spawn 缺陷）；
 *     - stale_card_line：卡 running 行但卡行 pid 不存活（陈旧行，reconcile 清理）；
 *     - status_mismatch：卡 running 行 vs registry 终态不一致；
 *     - duplicate_lane：canonical registry 内同一 lane 身份（task|owner|session_id，`phase` 只是展示标签）
 *       出现多行（T-20261013-233906）。读取侧 `loadRegistry` 按身份折叠 ⇒ 重复行不进 running/硬失败，
 *       但不报出来就等于静默丢审计痕迹；写入侧已去重 + 拒写（`registry.upsertSessionEntry`），此处只做可见性。
 * 只读：绝不写卡 / 写 registry。扫描 OPENCLAW_TEAM_ROOT（import 期读取；隔离测试在 import 前设该环境变量）。
 * 用法：node check-sessions.mjs
 *
 * note（mismatch 类）的**收口工具** = `session-reconcile.mjs`（清单 + 归口 fixable/manual/immutable +
 * `--apply` 逐条留痕修复）；poll 侧对这类**不一致态**不再重领（`session-lifecycle.mjs#classifyClaimBlock`）。
 * 见 guides/lane-session-lifecycle-sop.md（T-20261015-045724）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { TASKS_DIR, CARD_ID_RE, readCard } from './lib.mjs';
import { loadRegistry, isEntryAlive, readRegistryFile, REGISTRY_PATH } from './registry.mjs';

/**
 * canonical registry 内的**重复 lane 行**：同一 lane 身份 `task_id|owner|session_id` 出现 >1 行。
 * 无 `session_id` 的行无法判身份（旧式/手写行）⇒ 跳过。只读，返回软告警条目。
 * @returns {{type:'duplicate_lane', task:string, session:string, rows:object[]}[]}
 */
export function duplicateLaneRows() {
  const groups = new Map();
  for (const e of readRegistryFile(REGISTRY_PATH)) {
    if (!e || !e.session_id) continue;
    const key = `${e.task_id}|${e.owner}|${e.session_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    out.push({
      type: 'duplicate_lane',
      task: rows[0].task_id,
      session: rows[0].session_id,
      rows: rows.map((e) => ({ phase: e.phase ?? '', status: e.status ?? '', pid: e.pid ?? null })),
    });
  }
  return out;
}

/**
 * 解析卡 body 内 `## Sessions` 段（行首 `- seg:`）的 running 会话行。
 * `harness:` 段为契约 §4.3 的增量（插件 lane 写 `harness:plugin`；**历史行无该段 ⇒ 视为 `cli`**，
 * 向后兼容——行解析按「段名:值」通用提取，不做位置假设）。
 */
function sessionsOf(cardPath) {
  const { body } = readCard(cardPath);
  const lines = body.split('\n');
  const out = [];
  let inSessions = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) { inSessions = line.trim() === '## Sessions'; continue; }
    if (!inSessions) continue;
    if (!line.trim().startsWith('- seg:')) continue;
    const id = /id:(\S+)/.exec(line);
    const status = /status:(\S+)/.exec(line);
    const seg = /seg:(\S+)/.exec(line);
    const pid = /pid:(\S+)/.exec(line);
    const harness = /(?:^| · )harness:(\S+)/.exec(line);
    out.push({
      id: id ? id[1] : '', status: status ? status[1] : '', seg: seg ? seg[1] : '',
      pid: pid ? pid[1] : '', harness: harness ? harness[1] : 'cli',
    });
  }
  return out;
}

/**
 * 卡行是否代表「在跑」：CLI lane 看 pid 存活；插件 lane 看 **bound 的 native thread id**
 * （`id:pending` 未绑定 ⇒ 不算在跑，与 `registry.threadReachable` 的 `id_state` 口径一致）。
 */
function cardRowLive(line) {
  const nPid = Number(line.pid);
  if (Number.isInteger(nPid) && nPid > 0 && isPidAliveNum(nPid)) return true;
  return line.harness === 'plugin' && !!line.id && line.id !== 'pending';
}
/** 保留本文件原有的 pid 存活判定语义（EPERM 视为存在） */
function isPidAliveNum(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function scanCards() {
  const cards = [];
  if (!fs.existsSync(TASKS_DIR)) return cards;
  for (const f of fs.readdirSync(TASKS_DIR)) {
    if (!f.endsWith('.md') || !CARD_ID_RE.test(f.slice(0, -3))) continue;
    const p = path.join(TASKS_DIR, f);
    try {
      const { fm } = readCard(p);
      const id = fm.id || f.slice(0, -3);
      cards.push({ id, path: p, sessions: sessionsOf(p) });
    } catch {
      /* 不可读卡跳过 */
    }
  }
  return cards;
}

export function checkSessions({ registry = null } = {}) {
  const entries = registry == null ? loadRegistry({ includeLegacy: false }) : registry;
  const running = entries.filter((e) => e.status === 'running');
  const cards = scanCards();
  const byId = new Map(cards.map((c) => [c.id, c]));

  const inconsistencies = [];
  const notes = [];

  // 方向 1：registry running → 卡内 Sessions 行
  for (const e of running) {
    const card = byId.get(e.task_id);
    const line = card && card.sessions.find((s) => s.id && s.id === e.session_id);
    if (!isEntryAlive(e)) {
      notes.push({ type: 'zombie_registry', task: e.task_id, session: e.session_id, pid: e.pid, harness: e.harness || 'cli' });
      continue;
    }
    if (!card || !line) {
      inconsistencies.push({
        type: 'registry_only',
        task: e.task_id,
        session: e.session_id,
        pid: e.pid,
        cardExists: !!card,
      });
    }
    // 有行且 registry running ⇒ 一致（含判活）→ 无需处理
  }

  // 方向 2：卡内 Sessions running 行 → registry 条目
  // 口径：卡行**判活**（CLI pid 存活；插件 bound 的 thread 行）⇒ 真实活跃会话缺 registry 条目
  //       （spawn 漏写 registry）⇒ 硬失败；卡行不活 ⇒ 陈旧 running 行（reconcile 职责）⇒ 软告警。
  for (const card of cards) {
    for (const line of card.sessions.filter((s) => s.status === 'running')) {
      if (!line.id) continue; // 无 session id 的行不参与判定（无法对齐）
      const e = entries.find((x) => x.task_id === card.id && x.session_id === line.id);
      if (!e) {
        if (cardRowLive(line)) {
          inconsistencies.push({ type: 'card_only', task: card.id, session: line.id, pid: line.pid, harness: line.harness });
        } else {
          notes.push({ type: 'stale_card_line', task: card.id, session: line.id, pid: line.pid, harness: line.harness });
        }
      } else if (e.status !== 'running') {
        notes.push({ type: 'status_mismatch', task: card.id, session: line.id, card: line.status, registry: e.status });
      }
      // e.status === 'running' 已在方向 1 处理（一致或 zombie note）
    }
  }

  // 软告警：canonical registry 里的重复 lane 行（读取侧已折叠 ⇒ 不报就看不见）
  for (const dup of duplicateLaneRows()) notes.push(dup);

  return {
    ok: inconsistencies.length === 0,
    registryPath: REGISTRY_PATH,
    checked: { cards: cards.length, registryRunning: running.length },
    inconsistencies,
    notes,
  };
}

function main() {
  const r = checkSessions();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

// main-guard：realpath 归一（与 lib.mjs 同口径）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
