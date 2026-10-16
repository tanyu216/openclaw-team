#!/usr/bin/env node
/**
 * check-epic-completeness.mjs — 建卡完备性门禁（epic 子卡完整性 + 「路线图 × 卡」对账）
 *                                   + 悬空路线图巡检（软告警）
 *
 * 依据：PROTOCOL §10.2（登记一次到位、放行可分批）/ PROTOCOL §10.3（粒度与拆卡权威）/ PROTOCOL §20.1（机检落地）；
 *       目标伞卡 T-20261012-171026 机制 ③「建卡完备性闸门」与 ⑤「悬空路线图巡检」。
 * 事故实证（同伞卡 Background）：「原型↔实现对齐」M0/M1 done 且有独立复核，M2–M4 **从未建卡**
 *       ⇒ 目标半途消失；Elon 补卡时又只补 M2、漏 M3/M4。根因＝**路线图与卡之间没有对账**。
 *
 * ── 契约：什么是「路线图 × 卡 台账」（ledger） ──────────────────────────────────────────────
 * 台账 = **markdown 表格**，其表头**同时**含
 *   · 「阶段列」（表头单元匹配 /阶段|里程碑|phase|milestone/i），且
 *   · 「卡列」（表头单元归一后匹配 卡/卡片/card/cards）。
 * 数据行的「卡列」单元 = 该阶段的落地卡：写**卡 id**（`T-YYYYMMDD-HHMMSS[-seg]`，可多个），
 * 或**显式写理由**（≥4 个词字符，如 `（Elon 运维步骤）`、`（见下，本批新建）`）——即
 * 「未建卡阶段须显式写理由」。范式见伞卡 T-20261012-171026 的「目标台账（路线图 × 卡 对账）」
 * 与 T-20261012-165652 的「阶段台账（路线图 × 卡 对账）」。
 *
 * ── 硬判（exit 1）：domain = **非终态 epic 且声明了台账** ─────────────────────────────────────
 * 与 PROTOCOL §10.4「`__team__` 缺 target」同款口径：门禁的目的是**卡时**捕获缺陷，历史**终态** epic 已永不
 * dispatch，回溯转红只是噪声 ⇒ **grandfather**（同类违例降为**告警**，仍可见、不改退出码）。
 * 规则域同时要求「声明了台账」：本门禁约束**已在用的对账表**必须自洽，不强制 21 张历史 epic 补表
 * （补表是 Elon 的作业面，缺表只软告警 `epic_no_roadmap`，见下）。
 *   ① ledger_dangling:<卡>      —— 台账引用了 tasks/ 里**不存在**的卡（路线图指着一张不存在的卡）。
 *   ② ledger_not_child:<卡>     —— 台账引用的卡存在，但其 `parent` ≠ 本 epic（台账≠子卡花名册）。
 *   ③ ledger_phase_no_card:<行> —— 某阶段行**无卡 id 且无显式理由**（空/`-`/`TBD`/`待建`…）。
 *   ④ ledger_self_ref           —— 台账把 epic 自己列为阶段卡。
 *
 * ── 软告警（**绝不改退出码**，PROTOCOL §10.3 软护栏同款） ─────────────────────────────────────────────
 *   · epic_no_roadmap:<epic>          —— 非终态 epic 有子卡却**无台账**（补表提示，不阻断）。
 *   · ledger_unlisted_child:<卡>      —— 子卡未出现在本 epic 台账任何一行（反向对账，提示漏登）。
 *   · ledger_card_duplicate:<卡>      —— 同一卡在台账中出现多次。
 *   · 终态 epic 的 ①②③④ 违例（grandfather：可见但不判红）。
 *   · **悬空路线图巡检**（机制 ⑤）：扫 `workspace/<task>/plan.md`、`workspace/<task>/design/…` 设计文档、
 *     以及**全部** epic 卡，输出「有阶段无卡」清单——某阶段行无卡 id 且无显式理由 ⇒ `phase_no_card`；
 *     整张路线图**没有卡列**（无法对账）⇒ `roadmap_no_card_column`（每表一条，非逐行）。
 *
 * 只读：绝不写 tasks/ / workspace/。扫描根 OPENCLAW_TEAM_ROOT（与 lib.mjs 同源；单测隔离用）。
 * 退出码：0 无硬违例（含仅有软告警）；1 有硬违例。
 * 用法：node check-epic-completeness.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, TASKS_DIR, TEAM_ROOT } from './lib.mjs';
import { boardNamespaces, extractCardIdRefs } from './card-ids.mjs';
import { isTerminal } from './status.mjs';

// 终态判据来自 `scripts/status.mjs`（与 check-card / provider TERMINAL_STATUSES 同口径）：
// 终态 epic 走 grandfather。
/** 非卡 id 的「卡列」单元须达成的**显式理由**最小词字符数（CJK/字母/数字，余皆剥离）。 */
export const REASON_MIN_CHARS = 4;
/** 阶段列表头判据 / 卡列表头判据（归一后匹配）。 */
const PHASE_HEADER_RE = /阶段|里程碑|phase|milestone/i;
const CARD_HEADER_RE = /^(卡|卡片|card|cards)$/i;
/** 卡 id 扫描：**判据不再是命名形状**，而是「像某个**看板派生**命名空间下的 id」。见下方与 card-ids.mjs。 */

/** 工作表：`phase_no_card` / `roadmap_no_card_column` 的软告警标签（单测与文档按此核对）。 */
export const SOFT_TAGS = Object.freeze({
  PHASE_NO_CARD: 'phase_no_card',
  NO_CARD_COLUMN: 'roadmap_no_card_column',
  EPIC_NO_ROADMAP: 'epic_no_roadmap',
  UNLISTED_CHILD: 'ledger_unlisted_child',
  CARD_DUPLICATE: 'ledger_card_duplicate',
});

/** 归一表头单元：去空格/强调/括号，小写。 */
function normHeader(cell) {
  return String(cell || '').replace(/[\s*`_（）()【】[\]]/g, '').toLowerCase();
}

/**
 * 从任意文本里抽出卡引用（去重、保持出现序）。
 * 判据 = 「像某个**看板派生**命名空间下的 id」（`card-ids.mjs`），**不是**命名形状 —
 * 否则「引用了看板上并不存在的卡」这一类永远抓不到（它按定义不在成员集里）。
 * @param {string} text
 * @param {{namespaces?:Set<string>}} [opts] 命名空间集合；缺省取本进程看板派生的那套
 */
export function extractCardIds(text, opts = {}) {
  return extractCardIdRefs(text, opts);
}

/** 「卡列」单元是否写了**显式理由**（非空且词字符 ≥ REASON_MIN_CHARS）；空/占位符 ⇒ false。 */
export function hasExplicitReason(cell) {
  const stripped = String(cell || '').replace(/[\s*`_~>|]/g, '').replace(/[（）()【】[\]<>《》「」『』,，、。.;；:：!！?？—–\-+=/\\"']/g, '');
  const wordChars = (stripped.match(/[A-Za-z0-9一-鿿぀-ヿ]/g) || []).length;
  return wordChars >= REASON_MIN_CHARS;
}

/**
 * 解析 markdown 内的**台账表**。纯行式解析（表头行须以 `|` 起）：
 * 连续 `|` 行成表（第 1 行为表头、第 2 行为分隔行）；表头同时含阶段列与卡列 ⇒ 是台账。
 * 返回 [{ headerCells, phaseIdx, cardIdx, rows:[{ cells, text }], line }]；rows 不含表头/分隔行。
 */
export function parseLedgerTables(markdown) {
  const lines = String(markdown || '').split('\n');
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*\|/.test(lines[i])) { i++; continue; }
    const start = i;
    const block = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) { block.push(lines[i]); i++; }
    if (block.length < 2) continue;
    const split = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const headerCells = split(block[0]);
    // 分隔行：| --- | :--: | …（只含 -、:、空格、|）
    if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(block[1]) || !/-/.test(block[1])) continue;
    const phaseIdx = headerCells.findIndex((c) => PHASE_HEADER_RE.test(c));
    if (phaseIdx < 0) continue;
    const cardIdx = headerCells.findIndex((c) => CARD_HEADER_RE.test(normHeader(c)));
    const rows = block.slice(2).map((l) => {
      const cells = split(l);
      return { cells, phase: cells[phaseIdx] || '', card: cardIdx >= 0 ? (cells[cardIdx] || '') : '' };
    });
    tables.push({ headerCells, phaseIdx, cardIdx, hasCardColumn: cardIdx >= 0, rows, line: start + 1 });
  }
  return tables;
}

/** 读 tasks/ 下全部卡的 { id -> { fm, body } }（无 frontmatter 的卡用文件名兜底）。 */
function loadCards(tasksDir) {
  const cards = new Map();
  if (!fs.existsSync(tasksDir)) return cards;
  for (const f of fs.readdirSync(tasksDir)) {
    if (!f.endsWith('.md')) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(tasksDir, f), 'utf8'); } catch { continue; }
    let parsed;
    try { parsed = parseFrontmatter(raw); } catch { parsed = { fm: null, body: raw }; }
    const { fm, body } = parsed || {};
    const id = (fm && fm.id) || f.replace(/\.md$/, '');
    cards.set(id, { id, fm: fm || {}, body: body || '' });
  }
  return cards;
}

/**
 * 主巡检。返回 { ok, bad, warn, notes, stats }。
 * @param {{tasksDir?:string, workspaceDir?:string, root?:string}} [opts] 全部可注入（单测隔离）。
 */
export function checkEpicCompleteness({ tasksDir = TASKS_DIR, workspaceDir, root = TEAM_ROOT } = {}) {
  const wsDir = workspaceDir || path.join(root, 'workspace');
  const cards = loadCards(tasksDir);
  // 卡 id 的**命名空间**由看板派生（不是仓内自撰的规则）：台账里的引用要能识别**不存在**的卡，
  // 否则「引用了不存在的卡」这一类永远抓不到（按定义它不在成员集里）。见 card-ids.mjs。
  const boardNs = boardNamespaces({ ids: new Set(cards.keys()) });
  const bad = [];
  const warn = [];
  const notes = [];
  const childrenOf = {};
  for (const { id, fm } of cards.values()) {
    const p = fm.parent;
    if (p) (childrenOf[p] || (childrenOf[p] = [])).push(id);
  }

  let epicCount = 0, ledgered = 0, hardScoped = 0;
  for (const { id, fm, body } of cards.values()) {
    if ((fm.kind || 'task') !== 'epic') continue;
    epicCount++;
    const terminal = isTerminal(fm.status);
    const tables = parseLedgerTables(body).filter((t) => t.hasCardColumn);
    const kids = childrenOf[id] || [];

    // 非终态 epic 有子卡却无台账 ⇒ 软告警（补表提示；不阻断 —— 历史 epic 不追溯）
    if (!terminal && tables.length === 0 && kids.length > 0) {
      warn.push(`${SOFT_TAGS.EPIC_NO_ROADMAP} ${id}（有子卡 ${kids.length} 张、无「阶段|卡」台账）`);
    }
    if (tables.length === 0) continue;
    ledgered++;
    // 硬判域＝**非终态** epic 的台账违例；终态 epic 同款违例降为告警（grandfather，PROTOCOL §10.4 同款）
    if (!terminal) hardScoped++;
    const hard = !terminal;
    // 非终态 ⇒ 每条违例独立进 bad（可执行的红）；终态 ⇒ grandfather，逐条**折叠为一行**告警
    // （历史不追溯转红，但不隐藏——「可见但不判红」，与 PROTOCOL §10.4 同款）。
    const cited = new Set();
    const seenCount = new Map();
    const violations = [];

    for (const t of tables) {
      for (let r = 0; r < t.rows.length; r++) {
        const row = t.rows[r];
        const ids = extractCardIds(row.card, { namespaces: boardNs });
        const where = `@L${t.line + 2 + r}`;
        const phaseText = row.phase.replace(/\s+/g, ' ').slice(0, 40) || '(空阶段)';
        if (ids.length === 0) {
          // ③ 有阶段无卡：必须显式写理由
          if (!hasExplicitReason(row.card)) {
            violations.push(`ledger_phase_no_card:${phaseText} ${where}`);
            // 悬空路线图巡检（机制 ⑤）：同一现象另出软告警（终态 epic 也报，只此一处不重复）
            notes.push({ tag: SOFT_TAGS.PHASE_NO_CARD, source: `${id}.md`, phase: phaseText, where });
          }
          continue;
        }
        for (const c of ids) {
          cited.add(c);
          seenCount.set(c, (seenCount.get(c) || 0) + 1);
          if (c === id) { violations.push(`ledger_self_ref ${where}`); continue; }
          if (!cards.has(c)) { violations.push(`ledger_dangling:${c} ${where}`); continue; }
          const parent = cards.get(c).fm.parent;
          if (parent !== id) violations.push(`ledger_not_child:${c} ${where}`);
        }
      }
    }
    if (hard) for (const v of violations) bad.push(`${id} ${v}`);
    else if (violations.length) warn.push(`[grandfather·终态 ${fm.status}] ${id} 台账违例 ${violations.length} 条：${violations.join('；')}`);
    // 软告警：同一卡重复登记 / 子卡漏登（反向对账；**折叠为一行**，避免 20+ 子卡的 epic 刷屏）
    for (const [c, n] of seenCount) if (n > 1) warn.push(`${SOFT_TAGS.CARD_DUPLICATE} ${id} ${c}（出现 ${n} 次）`);
    const unlisted = kids.filter((k) => !cited.has(k));
    if (unlisted.length) warn.push(`${SOFT_TAGS.UNLISTED_CHILD} ${id} 子卡未列入台账 ${unlisted.length}/${kids.length}：${unlisted.slice(0, 5).join(',')}${unlisted.length > 5 ? ' …' : ''}`);
  }

  // ── 悬空路线图巡检（机制 ⑤）：workspace/*/plan.md + workspace/*/design/** 设计文档 ──
  const patrol = { planFiles: 0, designFiles: 0, phaseNoCard: 0, noCardColumn: 0 };
  const scanDoc = (file, text) => {
    for (const t of parseLedgerTables(text)) {
      if (!t.hasCardColumn) {
        patrol.noCardColumn++;
        notes.push({ tag: SOFT_TAGS.NO_CARD_COLUMN, source: file, header: t.headerCells.join(' | '), line: t.line });
        continue;
      }
      for (let r = 0; r < t.rows.length; r++) {
        const row = t.rows[r];
        if (extractCardIds(row.card, { namespaces: boardNs }).length === 0 && !hasExplicitReason(row.card)) {
          patrol.phaseNoCard++;
          notes.push({ tag: SOFT_TAGS.PHASE_NO_CARD, source: file, phase: row.phase.replace(/\s+/g, ' ').slice(0, 40) || '(空阶段)', where: `@L${t.line + 2 + r}` });
        }
      }
    }
  };
  const readDoc = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  if (fs.existsSync(wsDir)) {
    for (const d of fs.readdirSync(wsDir)) {
      const dir = path.join(wsDir, d);
      let st;
      try { st = fs.statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      const plan = path.join(dir, 'plan.md');
      if (fs.existsSync(plan)) { const t = readDoc(plan); if (t != null) { patrol.planFiles++; scanDoc(`${d}/plan.md`, t); } }
      // 设计文档：workspace/<card>/design/**（深度 ≤2；跳过 assets/prototype/node_modules）
      const designDir = path.join(dir, 'design');
      if (!fs.existsSync(designDir)) continue;
      const walk = (base, depth) => {
        if (depth > 2) return;
        let entries;
        try { entries = fs.readdirSync(base); } catch { return; }
        for (const e of entries) {
          if (/^(assets|prototype|node_modules|\.git)$/.test(e)) continue;
          const p = path.join(base, e);
          let s;
          try { s = fs.statSync(p); } catch { continue; }
          if (s.isDirectory()) walk(p, depth + 1);
          else if (e.endsWith('.md')) { const t = readDoc(p); if (t != null) { patrol.designFiles++; scanDoc(path.relative(wsDir, p), t); } }
        }
      };
      walk(designDir, 0);
    }
  }

  return {
    ok: bad.length === 0,
    bad, warn,
    notes,
    stats: { cards: cards.size, epics: epicCount, ledgered, hardScoped, ...patrol },
  };
}

function main() {
  const json = process.argv.includes('--json');
  const r = checkEpicCompleteness();
  if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
  const s = r.stats;
  console.log(`epic 完备性：${s.epics} 张 epic（${s.ledgered} 张有台账、${s.hardScoped} 张在硬判域）· 卡 ${s.cards} 张`);
  console.log(r.bad.length ? r.bad.join('\n') : '「路线图 × 卡」对账通过 ✔');
  if (r.warn.length) console.log(`\n⚠ 软告警（不阻断，PROTOCOL §10.3）：\n${r.warn.map((w) => `  · ${w}`).join('\n')}`);
  const dangling = r.notes.filter((n) => n.tag === SOFT_TAGS.PHASE_NO_CARD);
  if (dangling.length) {
    console.log(`\n⚠ 悬空路线图巡检：「有阶段无卡」${dangling.length} 处（软告警，不改退出码）`);
    for (const n of dangling.slice(0, 20)) console.log(`  · ${n.source} ${n.where} ${n.phase}`);
    if (dangling.length > 20) console.log(`  …（其余 ${dangling.length - 20} 处略）`);
  }
  const noCol = r.notes.filter((n) => n.tag === SOFT_TAGS.NO_CARD_COLUMN);
  if (noCol.length) {
    console.log(`\n⚠ 路线图未含卡列（无法对账）${noCol.length} 张表：${noCol.map((n) => n.source).join('、')}`);
  }
  console.log(r.bad.length ? `\n违例：${r.bad.length}` : '');
  process.exit(r.bad.length ? 1 : 0);
}

// main-guard：经 realpath 归一后比较，符号链接调用亦能命中；被 import 时（如单测）不执行 CLI
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
