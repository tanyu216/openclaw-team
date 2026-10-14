#!/usr/bin/env node
/**
 * session-reconcile.mjs — 卡↔registry 会话**历史对账**：清单 + 归口 + 逐条修复（非破坏、留痕）
 *
 * 为什么存在（T-20261015-045724 ④）：`check-sessions` 把「卡行 running ↔ registry 终态/缺失」这类
 * 不一致报成 note，而 note 只会**越积越多**——没人有工具去收口。本脚本就是那只手：
 *   1. **清单**：复用 `check-sessions.mjs#checkSessions`（同一判据，绝不另写一份扫描）；
 *   2. **归口**：每条不一致落三档之一——
 *      · `fixable`   —— 卡行 pid **已死**（或缺失）⇒ 登记漂移，可按 registry 事实收口卡行；
 *      · `manual`    —— 卡行 pid **仍存活**（活进程与「已终结」的 registry 互相矛盾，谁真谁假不可判）
 *                       或硬失败（`registry_only`/`card_only`：活进程一侧缺登记，属 spawn 漏写面）；
 *      · `immutable` —— `duplicate_lane`（canonical registry 内同 lane 身份的历史重复行）：读取侧
 *                       已按身份折叠，**保留原行 = 保留审计痕迹**，不得删改。
 *   3. **修复**（`--apply`）：只对 `fixable` 逐条执行，走 ACL `task.session-close`（卡 + registry
 *      **同写**，唯一写点）或（无卡行时的）registry 单侧收口；每条写一行台账（`--ledger <path>`），
 *      并落 `workspace/<card>/lane-lifecycle.log`。**非破坏**：只把 running 行改成 registry 已经
 *      宣告的终态 / 僵尸行的 `closed`，绝不发明状态、绝不改卡 frontmatter 状态机字段。
 *
 * 用法：
 *   node session-reconcile.mjs                       # 只出清单 + 归口（零写）
 *   node session-reconcile.mjs --apply --ledger <path>   # 执行可修项 + 写台账
 *   node session-reconcile.mjs --json                # 机读（默认即 JSON；--json 与之一致，留给习惯）
 *
 * 退出码：0 = 本次运行完成（含「有 manual/immutable 待人工」，那是**归口结果**不是失败）；
 *         1 = 有 `fixable` 项修复失败（--apply 下），须人工看台账。
 */
import fs from 'node:fs';
import path from 'node:path';
import { nowIso, readCard } from './lib.mjs';
import { checkSessions } from './check-sessions.mjs';
import { parseSessionRows, closeLaneSession, closeRegistryOnly, laneProcessAlive, TERMINAL_STATUSES } from './session-lifecycle.mjs';

/** 从卡面取该 session 的登记行（按 id 对齐；无 ⇒ null）。 */
function rowForSession(taskId, sessionId) {
  try {
    return parseSessionRows(readCard(taskId).body).find((r) => r.id === sessionId) || null;
  } catch {
    return null;
  }
}

/**
 * 把一条 check-sessions 报告项归口。
 * @returns {{class:'fixable'|'manual'|'immutable', action:string, seg?:string, status?:string, why:string}}
 */
export function classifyItem(item) {
  const { type, task, session } = item;
  if (type === 'duplicate_lane') {
    return { class: 'immutable', action: 'keep', why: '历史重复行：读取侧已按 lane 身份折叠，保留原行=保留审计痕迹' };
  }
  if (type === 'registry_only' || type === 'card_only') {
    return {
      class: 'manual',
      action: 'escalate',
      why: `${type}（硬失败）：活跃进程与登记面互相矛盾，是 spawn 漏写面 ⇒ 须人工核对，脚本不得代判`,
    };
  }
  const row = rowForSession(task, session);
  if (!row) {
    if (type === 'zombie_registry') {
      // registry running + pid 已死 + 卡面无该行 ⇒ 只剩 registry 一侧可收口（无卡行可同步，不制造半写）
      return { class: 'fixable', action: 'close_registry_only', status: 'closed', why: 'registry running 但 pid 已死且卡面无该 session 行 ⇒ 只收口 registry 一侧' };
    }
    return { class: 'manual', action: 'escalate', why: `${type}：卡面已无该 session 行（可能已被他方收口）⇒ 复核` };
  }
  const alive = laneProcessAlive(row.pidNum);
  if (type === 'status_mismatch') {
    const reg = String(item.registry || '');
    if (alive) {
      return { class: 'manual', action: 'escalate', seg: row.seg, why: `卡行 pid=${row.pidNum} 存活而 registry=${reg} ⇒ 活进程与终态互斥，不可代判` };
    }
    if (!TERMINAL_STATUSES.includes(reg)) {
      return { class: 'manual', action: 'escalate', seg: row.seg, why: `registry=${reg} 非终态，不属本对账面` };
    }
    return { class: 'fixable', action: 'close_card_row', seg: row.seg, status: reg, why: `pid 已死 + registry=${reg} ⇒ 按 registry 事实把卡行收口（两侧同写）` };
  }
  if (type === 'stale_card_line') {
    return { class: 'fixable', action: 'close_card_row', seg: row.seg, status: 'closed', why: '卡行 running 但 pid 已死且 registry 无条目 ⇒ 僵尸行收口 + 清 active_session_id' };
  }
  if (type === 'zombie_registry') {
    return { class: 'fixable', action: 'close_card_row', seg: row.seg, status: 'closed', why: 'registry running 但 pid 已死 ⇒ 两侧收口（卡行可定位时）' };
  }
  return { class: 'manual', action: 'escalate', why: `未知 note 类型 ${type} ⇒ 不代判` };
}

/** 执行一条修复（只允许 fixable）。 */
async function applyItem(item, cls) {
  if (cls.action === 'close_card_row') {
    const r = await closeLaneSession({ card: item.task, seg: cls.seg, status: cls.status || 'closed', expectSessionId: item.session || '', source: 'session-reconcile' });
    return { ok: r.ok !== false && (r.changed === true || r.reason === 'already_terminal'), changed: r.changed === true, reason: r.reason || '', detail: r };
  }
  if (cls.action === 'close_registry_only') {
    const r = closeRegistryOnly({ taskId: item.task, sessionId: item.session, status: 'closed' });
    return { ok: !!(r && r.ok), changed: !!(r && r.ok), reason: (r && r.reason) || '' };
  }
  return { ok: false, changed: false, reason: `unhandled_action:${cls.action}` };
}

/**
 * 对账主流程（纯逻辑集中在导出函数里，CLI 只是壳）。
 * @param {{apply?:boolean, ledger?:string, report?:object}} o
 */
export async function reconcileSessions({ apply = false, ledger = '', report = null } = {}) {
  const rep = report || checkSessions();
  const items = [];
  for (const it of rep.inconsistencies || []) items.push({ ...it, source: 'hard' });
  for (const it of rep.notes || []) items.push({ ...it, source: 'note' });

  const classified = items.map((it) => {
    const cls = classifyItem(it);
    return {
      task: it.task, session: it.session || '', type: it.type, source: it.source,
      registry: it.registry ?? null, card: it.card ?? null, pid: it.pid ?? null,
      class: cls.class, action: cls.action, seg: cls.seg || '', status: cls.status || '', why: cls.why,
    };
  });
  const counts = { total: classified.length, fixable: 0, manual: 0, immutable: 0, applied: 0, failed: 0 };
  for (const c of classified) counts[c.class]++;

  const records = [];
  if (apply) {
    for (const c of classified) {
      if (c.class !== 'fixable') continue;
      const r = await applyItem({ task: c.task, session: c.session }, c);
      if (r.ok) counts.applied++; else counts.failed++;
      records.push({ at: nowIso(), task: c.task, session: c.session, type: c.type, class: c.class, action: c.action, seg: c.seg, status: c.status, ok: r.ok, changed: !!r.changed, reason: r.reason || '' });
    }
  }

  let ledgerPath = '';
  if (apply) {
    if (!ledger) throw new Error('session-reconcile: --apply 需要 --ledger <path>（逐条留痕，绝不静默改线上数据）');
    ledgerPath = path.resolve(ledger);
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify({ at: nowIso(), apply: true, counts, records, classified }, null, 2) + '\n', 'utf8');
  }

  return {
    ok: counts.failed === 0,
    apply: !!apply,
    registryPath: rep.registryPath,
    checked: rep.checked,
    counts,
    classified,
    records,
    ledger: ledgerPath,
  };
}

const HELP = `用法: node session-reconcile.mjs [--apply --ledger <path>] [--json]

卡↔registry 会话历史对账（T-20261015-045724 ④）：清单 → 归口（fixable/manual/immutable）→
（--apply）逐条修复可修项：走 ACL task.session-close（卡行 status + 清 active_session_id + registry
终态 + endedAt），台账落 --ledger 指定文件，并落 workspace/<card>/lane-lifecycle.log。
默认零写（只出清单）；不可修（活 pid 矛盾 / 硬失败）与不可动（历史重复行）只归口，不代判。
`;

function main(argv) {
  const apply = argv.includes('--apply');
  const help = argv.includes('--help') || argv.includes('-h');
  let ledger = '';
  const li = argv.indexOf('--ledger');
  if (li >= 0) ledger = argv[li + 1] || '';
  if (help) { console.log(HELP); process.exit(0); }
  const unknown = argv.filter((a, i) => a.startsWith('--') && !['--apply', '--json', '--help', '-h', '--ledger'].includes(a) && argv[i - 1] !== '--ledger');
  if (unknown.length) { console.error(HELP); console.log(JSON.stringify({ ok: false, reason: `unknown_flag:${unknown[0]}` })); process.exit(2); }
  reconcileSessions({ apply, ledger }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }).catch((e) => {
    console.log(JSON.stringify({ ok: false, reason: String(e && e.message ? e.message : e) }));
    process.exit(2);
  });
}

try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main(process.argv.slice(2));
} catch { /* realpath 失败 ⇒ 不执行 main */ }
