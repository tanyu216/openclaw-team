#!/usr/bin/env node
/**
 * report-census.mjs — 卡面 `## Report` 普查（**只读**；口径显式化、可复跑、as-of 随输出回显）
 *
 * 缘起：卡 `T-20261015-025543-2`（D6；源 = 独立复核 `T-20261015-010749-3` §T6 D6）。
 *   `guides/worker-report-template.md` §4 曾公布一张「487 份 Report 的槽位命中率」表，但**无脚本、
 *   无 as-of、无口径**：独立复核以显式字面口径重跑得 **n=471**（Linus 298 / Turing 98 / Jobs 72 /
 *   Assistant 3），且半数命中率**在任一口径下都不复现**（Acceptance 行公布 92–95% vs 实测 15–54%；
 *   卡路径公布 13–19% vs 实测 13–85%，取决于口径）。**排序结论大体成立，绝对值不成立。**
 *   本脚本交付的是**口径本身**：任何读数都必须能被「同一条命令 + 同一组 params」重取；脚本不提供
 *   「唯一正确数字」——因为它不存在（分母是活动的看板，判定是字面规则）。故 §4 已按 (b) 收口为
 *   「仅排序/相对结论」（见 guide §4）：**读数是当次的，脚本与口径才是常驻的。**
 *
 * ── 口径三轴（全部可参数化，且一律在输出（含 `--json`）里回显 `params`）────────────
 *   ① **样本** `--sample=nonempty|section|board`（默认 `nonempty`）
 *        `nonempty` 卡面有 `## Report` 段且段体非空 —— §4 v1 自称的口径（"cards with a non-empty
 *                   `## Report`"），本脚本默认可与之直接对照；
 *        `section`  有 `## Report` 段即可（含空段）；
 *        `board`    全部带 frontmatter 的卡（不看 Report）。
 *   ② **状态面** `--status=all|nonterminal|terminal|<csv>`（默认 `all`）
 *        终态集合沿用 `check-report.mjs#TERMINAL`（`done|failed|canceled`）。§4 v1 公布值含终态卡
 *        （历史全库），故默认 `all` 才可比。
 *   ③ **字面判定** `--criterion=topic|shape`（默认 `shape`）
 *        同一家族两档规则**各自独立、非包含关系**（见 `FAMILIES`；某族可能出现 topic 命中反而更少）。
 *        `topic` = 「这个话题/标记出现过」；`shape` = 「具备机读形状」（验收表/勾选、命令与数字相邻、
 *        成对前后对照、卡路径形态…）。单层家族（`levels: 'single'`）表示没有更严的可辨形状。
 *   另：`--card-path=id|path|abs`（默认 `path`）**单独钉住最敏感的一条轴**——裸卡号 / `tasks/<id>.md`
 *   路径 / 绝对路径。§4 v1 #1「card path 是全场最差槽位」**只在 `path` 口径下成立**；`id` 口径下
 *   它反而是最好的一列（69–85%）。这一条是「口径决定结论」的样板，故不并入 `--criterion`。
 *   另：`--include-archived` 追加扫 `tasks/archive/**`。终态卡满 7 天后**会**被 `archive.mjs` 移出
 *   顶层 `tasks/`（见该脚本头注；截至本卡落笔 `tasks/archive/` 尚不存在——首批卡未满 7 天），
 *   ⇒ 分母此后双向移动（新增 + 归档）。archived 计数单列，不偷偷并进分母（也便于将来核对
 *   「公布 n=487 vs 实测」是否有一支落在归档里）。
 *   另：`--slots=<key,...>` 只算指定家族（`FAMILIES` 的 key）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node scripts/report-census.mjs                       # 人类可读表（默认 shape/nonempty/all/path）
 *   node scripts/report-census.mjs --json                # 机读信封（params 回显 + asOf）
 *   node scripts/report-census.mjs --criterion=topic --card-path=id --status=nonterminal
 *   node scripts/report-census.mjs --compare             # 与 §4 v1（已撤回）公布值逐项对照 + 逐行解释
 *
 * ── 保证与边界 ──────────────────────────────────────────────────────────────
 *   · **只读**：只读 `tasks/*.md` 与 `tasks/archive/**`；不写卡、不改状态、不写账本/状态文件
 *     （同 `sla-scan.mjs` 契约 §9.1 口径，由 `tests/report-census.test.mjs` 钉住）。
 *   · **不入门禁**：本脚本是取数工具，不是门禁——门禁是 `check-report.mjs`（只钉槽位存在性）。
 *   · **不冻结历史**：asOd 是**运行时刻**；Report 段体可被就地重写、卡可被归档 ⇒ 历史读数
 *     **不可精确重建**。要引用数字，必须连 as-of + 命令 + params 一起引用（guide §4）。
 *   · 退出码：`0` 读数完成（不论命中率高低）；`1` `tasks/` 不可读（fail-closed：读不到绝不读作
 *     「没有 Report」）；`2` 参数非法。
 *   · 隔离：`OPENCLAW_TEAM_ROOT` / `OPENCLAW_TASK_OPS_DIR`（与 `lib.mjs` 同源）⇒ 单测用 mkdtemp 沙箱。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS_DIR, parseFrontmatter } from './lib.mjs';
import { reportBody } from './check-report.mjs';
import { TERMINAL, isTerminal } from './status.mjs';

export const SAMPLE_LEVELS = ['nonempty', 'section', 'board'];
export const CRITERION_LEVELS = ['topic', 'shape'];
export const CARD_PATH_LEVELS = ['id', 'path', 'abs'];
export const ARCHIVE_DIR = 'archive';
/** `--compare` 的「量级上门当户对」阈值（pt）：|Δ| ≤ 5 ⇒ near。仅用于给对照表一个可核对的判词，
 *  不改变任何主张——主张只落在 verdict 上（equal / near / diverged）。 */
export const NEAR_POINTS = 5;

/**
 * 槽位家族 = §4 表那 11 行。每族给出**显式字面规则**的两档（`topic` / `shape`）：
 *   · 两条规则**彼此独立**（非包含关系）：某族完全可能 topic 档比 shape 档命中更少（如 A/B）。
 *   · `levels: 'single'` = 该族只有一层可辨规则（没有更严的形状可写）——显式标注，免得读者以为
 *     漏看了一层。
 *   · 规则文本抽自独立复核 `T-20261015-010749-3` 的 `evidence/board-census.mjs` +
 *     `census-variants.mjs`（那两处就是「实测口径」的书面出处），本脚本只做参数化与分层。
 */
export const FAMILIES = [
  {
    key: 'commit-hash',
    label: 'commit hash',
    levels: 'single',
    topic: (b) => /\b[0-9a-f]{7,40}\b/.test(b),
    shape: (b) => /\b[0-9a-f]{7,40}\b/.test(b),
  },
  {
    key: 'acceptance-table',
    label: 'Acceptance item-by-item',
    topic: (b) => /(acceptance|验收)/i.test(b),
    shape: (b) => /(acceptance|验收)/i.test(b) && /(\|.*\|.*\||- \[[ xX]\]|逐条|逐项|勾选)/.test(b),
  },
  {
    key: 'evidence-pointer',
    label: 'evidence pointer',
    levels: 'single',
    topic: (b) => /(workspace\/|team\/|\/Users\/|[A-Za-z0-9_.-]+\.(mjs|md|json|log|txt|sh|js|sql|png|yml|yaml|html|css))/.test(b),
    shape: (b) => /(workspace\/|team\/|\/Users\/|[A-Za-z0-9_.-]+\.(mjs|md|json|log|txt|sh|js|sql|png|yml|yaml|html|css))/.test(b),
  },
  {
    key: 'conclusion',
    label: 'conclusion',
    levels: 'single',
    topic: (b) => /(结论|conclusion|verdict|acceptable|可验收|不可验收)/i.test(b),
    shape: (b) => /(结论|conclusion|verdict|acceptable|可验收|不可验收)/i.test(b),
  },
  {
    key: 'command-exit',
    label: 'command + exit code',
    topic: (b) => /(\bexit\b|退出码|返回码|\brc\b)/i.test(b) && /\d/.test(b),
    shape: (b) => /(\bexit\b|退出码|返回码|\brc\b)[^\n]{0,15}\d/i.test(b),
  },
  {
    key: 'not-pushed',
    label: 'not-pushed accounting',
    levels: 'single',
    topic: (b) => /(未\s*push|not pushed|no push|\bpush(ed)?\b\s*[:：]|\bpush\s*[:：])/i.test(b),
    shape: (b) => /(未\s*push|not pushed|no push|\bpush(ed)?\b\s*[:：]|\bpush\s*[:：])/i.test(b),
  },
  {
    key: 'residuals',
    label: 'residuals / risks',
    levels: 'single',
    topic: (b) => /(残留|遗留|风险|leftover|residual|risk)/i.test(b),
    shape: (b) => /(残留|遗留|风险|leftover|residual|risk)/i.test(b),
  },
  {
    key: 'ab-before-after',
    label: 'A/B before-after',
    topic: (b) => /(A\/B|before\s*[:：]?\s*[→⇒]|前后对照|修前|修后)/i.test(b),
    shape: (b) => /(\bbefore\b[\s\S]{0,120}\bafter\b|修前[\s\S]{0,80}修后|前[\s\S]{0,20}后对照)/.test(b),
  },
  {
    key: 'pending-decision',
    label: 'pending decision',
    levels: 'single',
    topic: (b) => /(待裁|待决|待定|未决|待确认|pending (decision|question))/i.test(b),
    shape: (b) => /(待裁|待决|待定|未决|待确认|pending (decision|question))/i.test(b),
  },
  {
    key: 'card-path',
    label: 'card path',
    // 三档独立于 --criterion（见头注）：card-path 是「松口径反而最高」的样板轴。
    levels: 'axis (--card-path)',
    topic: (b) => CARD_PATH_RULES.id(b),
    shape: (b) => CARD_PATH_RULES.path(b),
  },
  {
    key: 'change-surface',
    label: 'change surface',
    levels: 'single',
    topic: (b) => /(变更面|写面|改动面|change surface|文件数|files? (touched|changed))/i.test(b),
    shape: (b) => /(变更面|写面|改动面|change surface|文件数|files? (touched|changed))/i.test(b),
  },
];

// 单层家族的两档**同源**（同一函数对象）：既省得两处规则漂移，也让 `tests/report-census.test.mjs`
// 能用恒等断言钉住「标了 single 就真的是 single」。
for (const f of FAMILIES) if (f.levels === 'single') f.shape = f.topic;

/** 卡路径三档（`--card-path`）。§4 v1 #1 的结论完全落在这条轴上。 */
export const CARD_PATH_RULES = {
  id: (b) => /T-\d{8}-\d{6}/.test(b),
  path: (b) => /(tasks\/T-\d{8}-\d{6}|T-\d{8}-\d{6}\.md)/.test(b),
  abs: (b) => /\/tasks\/T-\d{8}-\d{6}/.test(b),
};

/** §4 v1 公布值（**已撤回**，此处仅作 `--compare` 的对照常量，不是任何主张的依据）。
 *  as-of 缺失是它被撤回的首要原因之一：公布时未记录取数时刻，故连「重取一次」都无从对齐。 */
export const PUBLISHED_V1 = {
  asOf: null,
  sampleNote: 'cards with a non-empty `## Report`（口径自述；无脚本、无 --status / --criterion / --card-path 参数记录）',
  n: 487,
  byRole: { linus: 303, turing: 105, jobs: 76, assistant: 3 },
  roles: ['linus', 'jobs', 'turing'],
  rows: {
    'commit-hash': { linus: 99, jobs: 99, turing: 98 },
    'acceptance-table': { linus: 95, jobs: 92, turing: 92 },
    'evidence-pointer': { linus: 81, jobs: 84, turing: 93 },
    conclusion: { linus: 88, jobs: 91, turing: 78 },
    'command-exit': { linus: 75, jobs: 17, turing: 67 },
    'not-pushed': { linus: 62, jobs: 53, turing: 38 },
    residuals: { linus: 48, jobs: 42, turing: 55 },
    'ab-before-after': { linus: 37, jobs: 32, turing: 46 },
    'pending-decision': { linus: 26, jobs: 36, turing: 14 },
    'card-path': { linus: 19, jobs: 16, turing: 16 },
    'change-surface': { linus: 29, jobs: 50, turing: 24 },
  },
  /** 逐行差异**机制**解释（`--compare` 打印）。刻意不重复数字：数字在同行的 cells 里（公布→实测）。
   *  三条机制：① 单层规则 ⇒ 差异只能来自样本/时点（公布无 as-of，无从对齐）；② 两档规则都不命中
   *  公布值 ⇒ 公布用的是第三种未记录的判定；③ 结论随口径反转的轴。 */
  mechanism: {
    'commit-hash': '单层规则；差异方向一致（公布略高）⇒ 样本/时点（分母与段体都在动），不是口径。',
    'acceptance-table': '两档规则**都不命中**公布值 ⇒ 公布用的是第三种判定，且未写下 ⇒ 无法对齐。§4 v1 不可复现的样板行。',
    'evidence-pointer': '单层规则（文件名/路径记号出现即命中）⇒ 差异只能来自样本/时点。',
    conclusion: '单层规则 ⇒ 同上；Turing 一格公布低于实测，方向不定亦印证是时点差异而非系统偏移。',
    'command-exit': 'Jobs 是唯一在两档、两轮读数里都同量级复现的格子 ⇒ 该族的「Jobs 会在这一步断线」这个**相对结论**稳。',
    'not-pushed': '单层规则 ⇒ 方向一致（公布略高），量级小 ⇒ 样本/时点。',
    residuals: '单层规则 ⇒ 差异跨零（有高有低）⇒ 样本/时点，不是口径。',
    'ab-before-after': '两档都远低于公布值（差 2–5 倍）⇒ 公布用的是更宽的判定（未记录）。「口径决定结论」的样板之一。',
    'pending-decision': '单层规则，但公布值约为实测 2–4 倍 ⇒ 除样本外另有判定差异（公布口径未记录）。',
    'card-path': '公布值只落在 `path` 档；`id` 档方向相反 ⇒ §4 v1 #1「card path 是全场最差槽位」**隐含**用了 `path` 口径，而该口径从未写下 —— 换一条口径该结论即反转。「口径决定结论」的样板之二。',
    'change-surface': '单层规则；Jobs 单格差异最大 ⇒ 样本/时点。',
  },
};

/** 参数解析（非法值 ⇒ `null`，由 `main` 判 exit 2）。 */
export function parseArgs(argv = process.argv.slice(2)) {
  const get = (name) => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
  };
  const bad = [];
  const sample = get('sample') ?? 'nonempty';
  if (sample !== true && !SAMPLE_LEVELS.includes(sample)) bad.push(`--sample=${sample}`);
  const criterion = get('criterion') ?? 'shape';
  if (criterion !== true && !CRITERION_LEVELS.includes(criterion)) bad.push(`--criterion=${criterion}`);
  const cardPath = get('card-path') ?? 'path';
  if (cardPath !== true && !CARD_PATH_LEVELS.includes(cardPath)) bad.push(`--card-path=${cardPath}`);
  const statusRaw = get('status') ?? 'all';
  let statuses = ['all'];
  if (statusRaw !== true) {
    if (statusRaw === 'all' || statusRaw === 'nonterminal' || statusRaw === 'terminal') statuses = [statusRaw];
    else statuses = String(statusRaw).split(',').map((s) => s.trim()).filter(Boolean);
    if (!statuses.length) bad.push(`--status=${statusRaw}`);
  }
  const slots = get('slots');
  let slotKeys = FAMILIES.map((f) => f.key);
  if (slots && slots !== true) {
    slotKeys = String(slots).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = slotKeys.filter((k) => !FAMILIES.some((f) => f.key === k));
    if (unknown.length) bad.push(`--slots 未知家族: ${unknown.join(',')}`);
  }
  return {
    json: argv.includes('--json'),
    compare: argv.includes('--compare'),
    help: argv.includes('-h') || argv.includes('--help'),
    includeArchived: argv.includes('--include-archived'),
    sample,
    criterion,
    cardPath,
    statuses,
    slotKeys,
    bad,
  };
}

function statusMatcher(statuses) {
  if (statuses.includes('all')) return () => true;
  if (statuses.includes('nonterminal')) return (s) => !isTerminal(s);
  if (statuses.includes('terminal')) return (s) => isTerminal(s);
  return (s) => statuses.includes(s);
}

function readCardFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { fm } = parseFrontmatter(raw);
  if (!fm) return null;
  const body = reportBody(raw);
  return {
    id: String(fm.id || path.basename(file, '.md')),
    role: String(fm.assignee || '(none)'),
    status: String(fm.status || ''),
    createdAt: String(fm.created_at || ''),
    reportState: body === null ? 'missing' : body.trim() === '' ? 'empty' : 'present',
    report: body === null ? '' : body,
    archived: false,
  };
}

function walkMd(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 读看板（只读）。`tasks/` 不存在 ⇒ `ok:false`（fail-closed，绝不读作「没有 Report」）。 */
export function readBoard(tasksDir = TASKS_DIR, { includeArchived = false } = {}) {
  if (!fs.existsSync(tasksDir)) return { ok: false, reason: 'tasks-dir-unreadable', tasksDir, cards: [] };
  const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.md')).sort();
  const cards = files.map((f) => readCardFile(path.join(tasksDir, f))).filter(Boolean);
  const archivedFiles = includeArchived ? walkMd(path.join(tasksDir, ARCHIVE_DIR), []) : [];
  const archived = archivedFiles
    .map((f) => readCardFile(f))
    .filter(Boolean)
    .map((c) => ({ ...c, archived: true }));
  return {
    ok: true,
    tasksDir,
    cardFiles: files.length,
    archivedFiles: archivedFiles.length,
    archivedParsed: archived.length,
    cards: includeArchived ? [...cards, ...archived] : cards,
  };
}

/** 样本轴（`--sample`，叠加 `--status`）。返回值含被各档排除掉的计数，供对照表解释差异。 */
export function selectSample(cards, { sample, statuses }) {
  const inStatus = statusMatcher(statuses);
  const byStatus = {};
  for (const c of cards) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  const statusFiltered = cards.filter((c) => inStatus(c.status));
  const sampleFilter = (c) =>
    sample === 'board' ? true : sample === 'section' ? c.reportState !== 'missing' : c.reportState === 'present';
  const selected = statusFiltered.filter(sampleFilter);
  return {
    selected,
    counts: {
      cards: cards.length,
      afterStatus: statusFiltered.length,
      selected: selected.length,
      noReportSection: statusFiltered.filter((c) => c.reportState === 'missing').length,
      emptyReport: statusFiltered.filter((c) => c.reportState === 'empty').length,
      byStatus,
    },
  };
}

/** 命中率（family × role）。`criterion` 决定 topic/shape 档；`card-path` 恒由 `cardPath` 决定。 */
export function census(cards, { criterion, cardPath, slotKeys }) {
  const roles = [...new Set(cards.map((c) => c.role))].sort(
    (a, b) => cards.filter((c) => c.role === b).length - cards.filter((c) => c.role === a).length || a.localeCompare(b),
  );
  const pick = (fam) => {
    if (fam.key === 'card-path') return CARD_PATH_RULES[cardPath];
    if (fam.levels === 'single') return fam.topic;
    return fam[criterion];
  };
  const hitRates = {};
  for (const fam of FAMILIES) {
    if (!slotKeys.includes(fam.key)) continue;
    const fn = pick(fam);
    const byRole = {};
    for (const role of roles) {
      const rows = cards.filter((c) => c.role === role);
      const hits = rows.filter((c) => fn(c.report)).length;
      byRole[role] = { hits, n: rows.length, pct: rows.length ? Math.round((hits / rows.length) * 100) : null };
    }
    const hits = cards.filter((c) => fn(c.report)).length;
    hitRates[fam.key] = {
      label: fam.label,
      levels: fam.levels === 'single' ? 'single' : fam.key === 'card-path' ? `card-path=${cardPath}` : criterion,
      byRole,
      total: { hits, n: cards.length, pct: cards.length ? Math.round((hits / cards.length) * 100) : null },
    };
  }
  const byRole = Object.fromEntries(roles.map((r) => [r, cards.filter((c) => c.role === r).length]));
  return { roles, hitRates, census: { n: cards.length, byRole } };
}

const pctCell = (c) => (c.n ? `${c.pct}% (${c.hits}/${c.n})` : '-');

/** 一次完整读数（供测试直接调用；不做 IO 之外的副作用）。 */
export function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const params = {
    sample: args.sample,
    statuses: args.statuses,
    criterion: args.criterion,
    cardPath: args.cardPath,
    slots: args.slotKeys,
    includeArchived: args.includeArchived,
    tasksDir: TASKS_DIR,
  };
  const board = readBoard(TASKS_DIR, { includeArchived: args.includeArchived });
  if (!board.ok) {
    // fail-closed：读不到看板 ⇒ ok:false + 非零退出；**绝不**退化成「0 份 Report ⇒ 全绿」。
    return {
      envelope: { ok: false, reason: board.reason, asOf: new Date().toISOString(), tasksDir: TASKS_DIR, params },
      args,
      roles: [],
    };
  }
  const { selected, counts } = selectSample(board.cards, args);
  const result = census(selected, args);
  const envelope = {
    ok: true,
    asOf: new Date().toISOString(),
    tasksDir: board.tasksDir,
    params,
    board: {
      cardFiles: board.cardFiles,
      archive: { files: board.archivedFiles, parsed: board.archivedParsed, included: args.includeArchived },
      ...counts,
    },
    census: result.census,
    hitRates: result.hitRates,
  };
  if (args.compare) {
    envelope.comparison = comparePublished(result, args);
  }
  return { envelope, args, roles: result.roles };
}

function comparePublished(result, args) {
  const rows = [];
  for (const fam of FAMILIES) {
    if (!result.hitRates[fam.key]) continue;
    const pub = PUBLISHED_V1.rows[fam.key];
    const got = result.hitRates[fam.key].byRole;
    const cells = PUBLISHED_V1.roles.map((role) => {
      const p = pub[role];
      const g = got[role] ? got[role].pct : null;
      const delta = g === null ? null : g - p;
      return {
        role,
        published: p,
        measured: g,
        delta,
        // verdict：equal（逐点相同）/ near（|Δ| ≤ 5pt，量级上门当户对）/ diverged（口径或样本另有其事）
        verdict: delta === null ? 'n/a' : delta === 0 ? 'equal' : Math.abs(delta) <= NEAR_POINTS ? 'near' : 'diverged',
      };
    });
    const rank = { equal: 0, near: 1, diverged: 2, 'n/a': 3 };
    rows.push({
      key: fam.key,
      label: fam.label,
      levels: result.hitRates[fam.key].levels,
      cells,
      bestVerdict: cells.reduce((acc, c) => (rank[c.verdict] < rank[acc] ? c.verdict : acc), 'n/a'),
      note: PUBLISHED_V1.mechanism[fam.key] || '',
    });
  }
  return {
    publishedAsOf: PUBLISHED_V1.asOf,
    publishedN: PUBLISHED_V1.n,
    publishedByRole: PUBLISHED_V1.byRole,
    measuredN: result.census.n,
    measuredByRole: result.census.byRole,
    sampleNote: PUBLISHED_V1.sampleNote,
    rows,
  };
}

function printHuman(run1, args) {
  const { envelope } = run1;
  const { board, params } = envelope;
  console.log(`report-census · as-of ${envelope.asOf}`);
  console.log(`  tasksDir=${envelope.tasksDir}`);
  console.log(
    `  params: sample=${params.sample} status=${params.statuses.join('|')} criterion=${params.criterion}`
    + ` card-path=${params.cardPath} include-archived=${params.includeArchived}`,
  );
  console.log(
    `  board: cardFiles=${board.cardFiles} cards=${board.cards} (after --status ${board.afterStatus}`
    + ` → sample.n ${board.selected}) noReportSection=${board.noReportSection} emptyReport=${board.emptyReport}`
    + ` archive(included=${board.archive.included}, files=${board.archive.files})`,
  );
  console.log(`  census.n=${envelope.census.n} byRole=${JSON.stringify(envelope.census.byRole)}`);
  const roles = run1.roles;
  const w = Math.max(26, ...Object.values(envelope.hitRates).map((r) => r.label.length + 1));
  console.log(`  ${'family'.padEnd(w)} ${roles.map((r) => r.padEnd(16)).join('')}`);
  for (const [key, row] of Object.entries(envelope.hitRates)) {
    const cells = roles.map((r) => pctCell(row.byRole[r] || { n: 0, hits: 0 }).padEnd(16)).join('');
    console.log(`  ${row.label.padEnd(w)} ${cells} [${row.levels}]`);
  }
  if (envelope.comparison) printComparison(envelope.comparison);
}

function printComparison(cmp) {
  console.log('');
  console.log(`── §4 v1 公布值对照（公布 n=${cmp.publishedN} ${JSON.stringify(cmp.publishedByRole)}；`
    + `本次 n=${cmp.measuredN} ${JSON.stringify(cmp.measuredByRole)}）`);
  console.log(`   公布样本自述：${cmp.sampleNote}`);
  console.log(`   公布 as-of = ${cmp.publishedAsOf ?? '（未记录 —— 不可复现的首要原因）'}`);
  for (const row of cmp.rows) {
    const pub = row.cells.map((c) => c.published);
    const cells = row.cells
      .map((c) => `${c.role} ${c.published}%→${c.measured === null ? '-' : `${c.measured}%`}`
        + ` ${c.verdict === 'equal' ? '=' : `(Δ${c.delta > 0 ? '+' : ''}${c.delta ?? '-'})`}`)
      .join('  ');
    console.log('  ' + `${row.label.padEnd(26)} 公布 ${Math.min(...pub)}–${Math.max(...pub)}%  |  ${cells}`
      + `  [${row.levels} · 判词 ${row.bestVerdict}]`);
    console.log(`      → ${row.note}`);
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法: node scripts/report-census.mjs [--json] [--compare]'
      + ` [--sample=${SAMPLE_LEVELS.join('|')}] [--status=all|nonterminal|terminal|<csv>]`
      + ` [--criterion=${CRITERION_LEVELS.join('|')}] [--card-path=${CARD_PATH_LEVELS.join('|')}]`
      + ' [--slots=<key,...>] [--include-archived]');
    console.log(`家族 key: ${FAMILIES.map((f) => f.key).join(', ')}`);
    return 0;
  }
  if (args.bad.length) {
    console.error(`report-census: 参数非法 —— ${args.bad.join(' ')}`);
    console.error(`  sample ∈ {${SAMPLE_LEVELS.join(',')}} · criterion ∈ {${CRITERION_LEVELS.join(',')}}`
      + ` · card-path ∈ {${CARD_PATH_LEVELS.join(',')}} · status ∈ {all,nonterminal,terminal,<csv>}`);
    return 2;
  }
  const r = run(argv, env);
  if (!r.envelope.ok) {
    console.error(`report-census: 看板不可读（${r.envelope.tasksDir}）—— 绝不读作「没有 Report」`);
    if (args.json) console.log(JSON.stringify(r.envelope));
    return 1;
  }
  if (args.json) {
    console.log(JSON.stringify(r.envelope));
  } else {
    printHuman(r, args);
  }
  return 0;
}

// ── direct-run guard（与 scripts/* 同风格：realpath 归一后比较）─────────────────
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main());
