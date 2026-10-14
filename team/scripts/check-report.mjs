#!/usr/bin/env node
/**
 * check-report.mjs — 卡面 Report 完备性巡检（公共核心 8 项；纳入 check-all fast 段）
 * 依据：guides/worker-report-template.md（Report 规范）；PROTOCOL §⑳.1（机检门禁登记）；
 *       AUTOMATIONS.md §3.5.1/§6（快段接线与巡检指标）。卡 T-20261015-010749-2（父 T-20261015-010749）。
 *
 * 口径：只校验**公共核心 8 项**（A1…A8）的**槽位存在性**——即 Report 段内每个必需项是否都有其
 * 槽位标签（anchor）且标签后有正文。**不校验正文语义**（那是 Elon/Turing 的 Report 审计职责，
 * 见 §6「Elon's acceptance = report audit」）：正文怎么写由 guide 管，机检只钉「槽位稳不稳」。
 * 三岗专属小节（L1…L6 / J1…J5 / T1…T7）**有意不入机检**：其必需项随岗位与 flow 变化，语义判定
 * 无法机检（见 guide §2；由各岗自身复核 + Turing 独立复核覆盖）。
 * 唯一的语义例外是**报告作者来源**（(v)：`delivery` vs `import`）——它是**声明式**的：卡面自己
 * 标注来源，机检只读这个声明并据此判定「能不能开门」。正文怎么写仍然不管。
 *
 * ── (i) 触发面（trigger surface）──────────────────────────────────────────────
 *   · **硬触发（置退出码 1）＝ 仅 `in_review`**：卡处于交付待验收态 ⇒ Report 必须存在、非空、且
 *     8 个槽位齐备。这正是父卡实测的**事故型**：2026-10-14 夜间连续 4 张卡 `in_review` 而**卡面
 *     Report 为空**，此前纯人肉把关。
 *   · **软提示（不置退出码）**：`in_progress`/`blocked` 且 Report 段**已存在且非空**但槽位不全
 *     ⇒ 记为 draft 提示（在写的草稿，不该红）。
 *   · **不检查（skip）**：`todo`/`ready`/`backlog`（尚未开工，无 Report 预期；`ready`/`todo` 还会被
 *     spawn-lane exec 自动领取）；以及 `done`/`failed`/`canceled`（终态，见 (ii)）。
 *
 * ── (ii) 生效截止 + 历史卡降 warn（no retro-reddening）────────────────────────
 *   生效截止 `EFFECTIVE_AT`（默认常量，见下；可用 `OPENCLAW_TEAM_REPORT_EFFECTIVE_AT` 覆盖，ISO 8601）：
 *   卡面 `created_at < EFFECTIVE_AT` ⇒ **grandfather**：违规降为 **warn**、**不置退出码**。理由与
 *   `check-card.mjs` 的 `__team__` target 规则同口径（T-20261013-023535-2：门禁目的是捕获**交付时**
 *   缺陷，历史卡不追溯转红）：本规范落地前写就的 Report 不因新规转红。实测（2026-10-15 落仓时，
 *   全库 581 卡 / 30 张非终态）：若不做截止，本门禁一上线即对 4 张**既存**卡转红——其中 3 张是
 *   本卡自身的 epic/子卡（尚未产生 Report），1 张是上述事故卡。这与「不得对历史卡翻旧账」直接
 *   冲突，故截止为**门禁落仓时刻**（而不是「今天的 00:00」）：卡在门禁存在之前创建 ⇒ 只报 warn。
 *   `created_at` 缺失/不可解析 ⇒ 同样按 grandfather 处理（保守：绝不因缺字段转红）。
 *   **终态卡一律不检查**（连 warn 都不报）：终态是不可逆的过去，翻旧账无行动价值。
 *
 * ── (iii) 豁免机制（仿 check-idem 的 baseline：托管模板 + 运行时登记）─────────
 *   **一个文件不能同时是「随 install 部署的托管物」与「运行时可变登记处」**（T-20261014-131423
 *   在 check-idem 上踩实过：登记被升级清回，且在清回前就令慢段转红）⇒ 拆成两类来源，语义与
 *   check-idem 逐字对齐：
 *     ① **托管模板** `BASELINE_PATH = <本目录>/report-baseline.json`：随 install.sh §1 的
 *        `team/scripts/**` 部署树进实例（默认 upgrade ⇒ 仓内副本覆盖实例）⇒ **只读**，仓内副本
 *        是唯一权威。**仓内副本必须保持 `cards: []`**（「仓内不得夹带豁免」是被单测钉住的不变量；
 *        与 idem 的托管模板同款）。**运行时登记一律不写此文件**。
 *     ② **运行时登记** `runtimeBaselinePath(tasksDir)` = `<被巡检的 tasks 目录>/.report-baseline.json`
 *        （`RUNTIME_BASELINE_NAME`）：`install.sh` 跳过 `tasks/`、防漂移巡检亦排除 `tasks/` ⇒
 *        不属任何部署树 ⇒ **升级不清回登记**；且随 `tasksDir` 派生 ⇒ 单测隔离 root 自动读到空登记。
 *   生效登记 = ① ∪ ②（`loadExemptions`）。登记项形状 `{ id, gaps: [...], reason }`。
 *   **判据（防「登记一次、永久放行」）**：`id` 命中 **且** `gaps` 排序后与该卡**当前**缺口集合
 *   **完全一致** ⇒ 移入 `exempt`、不判红。集合一旦变化（补齐若干槽位、或又有新缺口）即**豁免失效**，
 *   回到判红/降级路径——豁免因此不可能掩盖**新增**损伤。
 *   豁免**只对硬触发行之下的违规生效**（draft 提示与 grandfather warn 本身即非阻断，无需登记）。
 *   `--no-baseline` 忽略**两者**（用于核查「真实违规」或登记是否已过期）。
 *
 * ── (iv) 触发条件 + 豁免开关（可执行面变更，同 §⑩ 口径）──────────────────────
 *   本脚本是**可执行面变更**：随 `team/scripts/**` 部署进实例、由 `check-all.sh` **fast 段**调用
 *   （快段预算 6000ms；本步实测 ≈0.05s / 581 卡，余量充足）。故按 §⑩ 口径同步登记：
 *     · `PROTOCOL §⑳.1` 机检门禁表新增一行（规则 → 脚本 → 落点）；
 *     · `AUTOMATIONS.md §3.5.1`（快段接线）+ §6（巡检指标）各记一条。
 *   触发条件：`in_review` 且已过生效截止 且缺槽/空 Report ⇒ **exit 1**（check-all 红）。
 *   豁免开关：① 生效截止 `OPENCLAW_TEAM_REPORT_EFFECTIVE_AT`（把截止前移 ⇒ 更多卡降 warn）；
 *             ② 登记 ① 托管模板（只读，仓内钉空）/ ② 运行时登记（人工核对后追加）；
 *             ③ `--no-baseline`（CLI，忽略两源，核查真违规）。
 *   退出码：0 无「非豁免硬违规」（含 grandfather warn / draft / content hint）；1 有之。
 *   隔离：`OPENCLAW_TEAM_ROOT` 覆盖（与 team-paths.mjs 同源），便于单测用 mkdtemp。
 *
 * ── (v) 报告作者来源（Δ2：delivery vs import/代收口）────────────────────────────
 *   对齐 TaskPanel `task_reports.origin = delivery|import`（Terry 2026-10-15 批准的设计输入）：
 *   「这张卡的 Report 是谁写的」是**验收资格**问题，不只是内容问题 ——
 *     · `delivery`（默认）：**交付者本人**所写 ⇒ 可作为验收证据；
 *     · `import`：**迁移 / 代收口**所写（替已死会话、或历史迁移补写）⇒ **不是交付证据**。
 *   机读手柄 = **可选**槽位 `A0`（`- **A0 Report origin** — import; author: <谁>; source: <自哪来>`）。
 *   判据（只作用于**硬触发档**，即 `in_review`；draft/grandfather 本就非阻断，不受影响）：
 *     · 无 `A0` ⇒ 视为 `delivery`（正常情形：交付者本人写自己的 Report）；
 *     · 有 `A0` 但**认不出来源词** ⇒ 缺口 `REPORT_ORIGIN_UNKNOWN`（fail-closed：来源自称不可识别时，
 *       不得当作交付证据开门）；
 *     · `A0` = `import` ⇒ ① **必须**同时标注 `author` 与 `source`，缺一即缺口
 *       `REPORT_IMPORT_NO_PROVENANCE`；② 且在 `in_review` 下**一律**缺口 `REPORT_IMPORT_NOT_DELIVERY`
 *       —— **代收口报告不得当交付证据开门**（这正是 2026-10-14 夜间 4 例「`in_review` 卡面 Report
 *       空」的代收口形态：报告不是没有，而是**不是交付者写的**）。人工核对后确属良性的（例如
 *       迁移期的一次性补写），走 (iii) 的**运行时登记**：`gaps` 写该卡**当前**缺口集合。
 *   已知上限（残余）：机检只能读**卡面自报**的来源；若代收口报告根本不写 `A0`，它不可与 delivery
 *   区分 —— 要堵这条口须由 provider ACL（`skills/task-ops/lib/task.mjs#writeReport`）在写入时盖章
 *   `origin`，属**基座侧**改造，不在本卡边界内（见 guide §5 与卡面 Report 的 A6）。
 *
 * ── (vi) 轮次语义（Δ4，warn-only 提示）────────────────────────────────────────
 *   防「复用上一轮的报告」：卡被退回重来（`blocked_at` 有值）后重新交付（`status_changed_at` 晚于
 *   `blocked_at`）⇒ 交付轮次 ≥2。此时若 Report **未声明本轮交付时间/轮次**（正文既无 `YYYY-MM-DD`
 *   日期、也无 `round N` / `第 N 轮` 字样），出**非阻断**提示 —— 审计无法判断这张 Report 属于
 *   当前一轮还是上一轮。因无 Report 写入时间戳（`writeReport` 只换段、不盖时间），本判定只能
 *   基于「卡头 + 自报」，故**只出提示、不置退出码**；且**只对 `in_review` 且已过生效截止的卡**
 *   生效（历史卡不制造噪声）。
 *
 * 注：与 `check-card.mjs`（frontmatter schema）、`check-handoff.mjs`（背景包四锚）**正交**——
 * 前者管卡头字段，后者管 workspace/<id>/handoff.md，本脚本只读**卡面 `## Report` 段**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, TASKS_DIR } from './lib.mjs';

// ---------- 常量与口径 ----------

/** 公共核心必需槽位（guides/worker-report-template.md §1 A1…A8）——单一来源。 */
export const REQUIRED_SLOTS = [
  { id: 'A1', label: 'Conclusion' },
  { id: 'A2', label: 'Delivery coordinates' },
  { id: 'A3', label: 'Change surface' },
  { id: 'A4', label: 'Acceptance item-by-item' },
  { id: 'A5', label: 'Re-run evidence' },
  { id: 'A6', label: 'Residuals / risks / open items + owner' },
  { id: 'A7', label: 'Out-of-literal handling' },
  { id: 'A8', label: 'Not-pushed accounting' },
];

/** **可选**槽位（guide §1 A0）：报告作者来源声明。不属必需项 ⇒ 缺它不是缺口（默认 `delivery`），
 *  但**存在**时参与硬判定（见文件头 (v)）。 */
export const OPTIONAL_SLOTS = [{ id: 'A0', label: 'Report origin' }];

/** 全部槽位 id（必需 + 可选）：仅用于**切片边界**——每个槽位片段到下一个槽位标签为止。 */
const SLOT_IDS = [...OPTIONAL_SLOTS, ...REQUIRED_SLOTS].map((s) => s.id);

/** 槽位标签的匹配式：行首（可带列表符号 `-`/`*`/`+`、可带 `**` 粗体）后接标签，标签后须为非数字边界
 *  （`A10` 不得命中 `A1`）。标签即机读手柄，其余正文自由（见 guide §0 锚点语法）。 */
export function slotRegex(id) {
  return new RegExp(`(^|\\n)[ \\t]*(?:[-*+][ \\t]+)?(?:\\*\\*)?${id}(?![0-9])`);
}

/** 槽位片段（本槽位标签之后 → 下一个槽位标签之前）：`{found, text}`。
 *  用于「标签在、但标签后无正文」的半空形态（空 Report 的另一半）。 */
function slotSpan(body, id) {
  const re = slotRegex(id);
  re.lastIndex = 0;
  const m = re.exec(body);
  if (!m) return { found: false, text: '' };
  const start = m.index + m[0].length;
  let next = body.length;
  for (const sid of SLOT_IDS) {
    const r2 = slotRegex(sid);
    r2.lastIndex = 0;
    const mm = r2.exec(body.slice(start));
    if (mm) { const abs = start + mm.index; if (abs < next) next = abs; }
  }
  return { found: true, text: body.slice(start, next) };
}

/**
 * 槽位是否「有正文」。判据刻意取**保守方向**（宁漏报、不误红）：把该槽位的 canonical 英文名
 * （标签自带的名字，如 A1 的 `Conclusion`）从片段里去掉后，还须剩 ≥1 个字/数字字符。
 * 于是 `- **A1 Conclusion** —`（标签在、正文空）判**缺**，而 `- **A1 结论** —` / `- **A1** …
 * 任意非空正文` 判**在**。中文标签名与英文 canonical 名不同 ⇒ 只会漏报空壳，绝不误红。
 */
function slotHasBody(body, slot) {
  const { found, text } = slotSpan(body, slot.id);
  if (!found) return false;
  const stripped = text
    .replace(new RegExp(slot.label, 'gi'), '')
    .replace(/[*_`#|.\-—·:()\[\]\s>]/g, '');
  return /[\p{L}\p{N}]/u.test(stripped);
}

/** 伪缺口标签：Report 段缺失 / 段存在但为空（事故型的两种形态）。 */
export const GAP_NO_SECTION = 'REPORT_MISSING';
export const GAP_EMPTY = 'REPORT_EMPTY';
/** 伪缺口标签：来源（(v)）。代收口报告不是交付证据 ⇒ 与槽位缺口同列，走同一套登记判定。 */
export const GAP_ORIGIN_UNKNOWN = 'REPORT_ORIGIN_UNKNOWN';
export const GAP_IMPORT_NO_PROVENANCE = 'REPORT_IMPORT_NO_PROVENANCE';
export const GAP_IMPORT_NOT_DELIVERY = 'REPORT_IMPORT_NOT_DELIVERY';

/** 终态（历史卡，**不追溯**）：与 provider `TERMINAL_STATUSES` / check-card.mjs 同口径。 */
export const TERMINAL = ['done', 'failed', 'canceled'];
/** 硬触发态：交付待验收（父卡实测事故型即此）。 */
export const HARD_STATUSES = ['in_review'];
/** 软提示态：Report 段已存在且非空但槽位不全 ⇒ draft 提示（在写草稿，不置退出码）。 */
export const DRAFT_STATUSES = ['in_progress', 'blocked'];

/**
 * 生效截止：**门禁落仓时刻**（本地 2026-10-15 01:10 +0800）。`created_at` 早于此 ⇒ grandfather（warn）。
 * 取值理由见文件头 (ii)：截止必须晚于既存非终态卡的 `created_at`，否则上线即对历史卡转红。
 * 覆盖：`OPENCLAW_TEAM_REPORT_EFFECTIVE_AT`（ISO 8601；非法值 ⇒ 回退常量，绝不静默变严）。
 */
export const EFFECTIVE_AT = '2026-10-14T17:10:00Z';
export function effectiveAt() {
  const raw = process.env.OPENCLAW_TEAM_REPORT_EFFECTIVE_AT;
  if (!raw) return EFFECTIVE_AT;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : EFFECTIVE_AT;
}

export const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'report-baseline.json');
/** 运行时登记文件名：落在**被巡检的 tasks 目录**内（非部署托管、单测自动隔离；同 check-idem）。 */
export const RUNTIME_BASELINE_NAME = '.report-baseline.json';
export function runtimeBaselinePath(tasksDir = TASKS_DIR) {
  return path.join(tasksDir, RUNTIME_BASELINE_NAME);
}

// ---------- Report 段抽取 ----------

/** 抽卡面 `## Report` 段正文（到下一个 `## ` 标题为止）；无该段 ⇒ `null`。 */
export function reportBody(raw) {
  const lines = String(raw).split('\n');
  const hi = lines.findIndex((l) => /^##\s+Report\s*$/.test(l));
  if (hi < 0) return null;
  let end = lines.length;
  for (let i = hi + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  return lines.slice(hi + 1, end).join('\n');
}

/** 缺口清单：段缺失 ⇒ `[REPORT_MISSING]`；段空 ⇒ `[REPORT_EMPTY]`；否则为「标签缺 **或** 标签后无正文」
 *  的槽位 id 列表（后者即父卡事故型「有壳无肉」的另一半）。 */
export function slotGaps(body) {
  if (body === null) return [GAP_NO_SECTION];
  if (body.trim() === '') return [GAP_EMPTY];
  return REQUIRED_SLOTS.filter((s) => !slotHasBody(body, s)).map((s) => s.id);
}

// ---------- 报告作者来源（(v)：delivery vs import） ----------

export const ORIGIN_DELIVERY = 'delivery';
export const ORIGIN_IMPORT = 'import';
export const ORIGIN_UNKNOWN = 'unknown';

/** 取自声明文本的来源字段（`author:`/`作者：`…）：取到下一个字段分隔符（`;`/`·`/`,`/`、`/行尾）为止。
 *  只用于「填了没有」的布尔判定，不参与语义解释 —— 故取**顺手的宽松**：分隔符按中英双套。 */
function originField(text, names) {
  for (const n of names) {
    const m = new RegExp(`${n}\\s*[:：]\\s*([^\\n;；·|,，、]+)`, 'i').exec(text);
    if (m) {
      const v = m[1].replace(/[*\s]+$/, '').trim();
      if (v) return v;
    }
  }
  return '';
}

/**
 * 解析可选槽位 `A0` 的来源声明：`{ origin: 'delivery'|'import'|'unknown', declared, author, source }`。
 * 无 `A0` ⇒ `delivery` + `declared:false`（交付者本人写自己的 Report 是常态，不需要声明）。
 * `import` **优先于** `delivery` 判定（同一行两种词都出现时按 fail-closed 取 import）。
 */
export function reportOrigin(body) {
  const { found, text } = slotSpan(body, 'A0');
  if (!found) return { origin: ORIGIN_DELIVERY, declared: false, author: '', source: '' };
  const isImport = /\bimport(ed)?\b|代收口|迁移|补写|导入/i.test(text);
  const isDelivery = /\bdelivery\b|交付者本人|\b本人\b|交付者|自写/i.test(text);
  const author = originField(text, ['author', '作者']);
  const source = originField(text, ['source', '来源']);
  return {
    origin: isImport ? ORIGIN_IMPORT : isDelivery ? ORIGIN_DELIVERY : ORIGIN_UNKNOWN,
    declared: true,
    author,
    source,
  };
}

/** 来源缺口（只由硬触发档消费）：`delivery` ⇒ 无缺口；`import` ⇒ 交代 + 不开门两条；其余 ⇒ 不可识别。 */
export function originGaps(origin) {
  if (!origin || origin.origin === ORIGIN_DELIVERY) return [];
  if (origin.origin === ORIGIN_UNKNOWN) return [GAP_ORIGIN_UNKNOWN];
  const gaps = [];
  if (!origin.author || !origin.source) gaps.push(GAP_IMPORT_NO_PROVENANCE);
  gaps.push(GAP_IMPORT_NOT_DELIVERY);
  return gaps;
}

/**
 * 内容提示（**永远非阻断**）：只对父卡实测命中率最低、且**有稳定机读形态**的两项做轻量核对。
 * 语义判定不入机检（见文件头），故这里只报 hint，绝不置退出码。
 */
export function contentHints(body) {
  if (!body || !body.trim()) return [];
  const hints = [];
  const a2 = /(^|\n)[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?A2(?![0-9])[\s\S]*?(?=\n[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?A[0-9]|\n#{1,6}\s|$)/.exec(body);
  if (a2) {
    const seg = a2[0];
    if (!/T-\d{8}-\d{6}/.test(seg)) hints.push({ slot: 'A2', hint: '未含卡路径（`tasks/T-YYYYMMDD-HHMMSS….md`）——实测全岗最缺槽位（16–19%）' });
    if (!/\b[0-9a-f]{7,40}\b/.test(seg) && !/commit/i.test(seg)) hints.push({ slot: 'A2', hint: '未含 commit hash' });
  }
  const a5 = /(^|\n)[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?A5(?![0-9])[\s\S]*?(?=\n[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?A[0-9]|\n#{1,6}\s|$)/.exec(body);
  if (a5) {
    // 判据取**宽**（hint 是非阻断信号，宁可漏报）：须同时出现「退出码字样」与「数字」。
    // 不要求两者相邻 —— A5 常写成表格（列头 `exit`、单元格 `0`），相邻判据会对合规表格误报。
    const seg = a5[0];
    const hasWord = /\bexit\b|退出码|返回码|\brc\b/i.test(seg);
    const hasNumber = /\d/.test(seg);
    if (!(hasWord && hasNumber)) hints.push({ slot: 'A5', hint: '未含**退出码**（命令 + 退出码）——实测 Jobs 仅 17% 命中（gate 只提示不阻断，审计仍按 §6）' });
  }
  return hints;
}

/**
 * 交付面提示（Δ1/Δ4，**永远非阻断**，且**只对生效截止之后的卡**计算）：由 `scanReports` 在
 * 「硬触发 + 已过截止 + 槽位齐备」时调用，避免给历史卡制造噪声。
 *   · Δ1：A4 里出现 `partial`/`not_met`（固定状态词表）却把 A6 写成「无残留」⇒ guide 的耦合规则
 *        被违反（未达成项必须同时出现在 A6 leftovers）。
 *   · Δ4：本卡曾被退回后重新交付，而 Report 未声明本轮交付时间/轮次 ⇒ 疑似复用旧轮报告。
 */
export function deliveryHints(body, fm = {}) {
  if (!body || !body.trim()) return [];
  const hints = [];
  // Δ1：A4 未达成项 ⇔ A6 必须交代
  const a4 = slotSpan(body, 'A4').text;
  const a6 = slotSpan(body, 'A6').text;
  if (/\b(partial|not_met)\b|未达成|部分达成/.test(a4) && /\bnone\b|\bn\/a\b|无残留|无未决|无待办|无风险|无遗留/.test(a6)) {
    hints.push({ slot: 'A6', hint: 'A4 有未达成项（`partial`/`not_met`）但 A6 写「无残留」——guide §1 A4 耦合规则：未达成项**必须**同时出现在 A6 leftovers 并带归口' });
  }
  const rh = roundHint(fm, body);
  if (rh) hints.push(rh);
  return hints;
}

/**
 * Δ4 轮次提示：`blocked_at` 有值（曾被退回/阻塞）且 `status_changed_at` 晚于它 ⇒ 至少交付过两轮；
 * 此时 Report 若不声明本轮交付时间（`YYYY-MM-DD`）或轮次（`round N` / `第 N 轮`），则审计无从判断
 * 这张 Report 属于哪一轮（`writeReport` 只换段、不盖时间戳 ⇒ 无更硬的信号）。
 * 仅对 `in_review` 生效（调用方已保证过了生效截止）。无该形状 ⇒ 返回 null（零噪声）。
 */
export function roundHint(fm, body) {
  if (!fm) return null;
  if (!HARD_STATUSES.includes(String(fm.status || ''))) return null;
  const blocked = Date.parse(String(fm.blocked_at || ''));
  const changed = Date.parse(String(fm.status_changed_at || ''));
  if (!Number.isFinite(blocked) || !Number.isFinite(changed) || changed <= blocked) return null;
  if (/\d{4}-\d{2}-\d{2}/.test(body) || /\bround\s*\d+/i.test(body) || /第\s*\d+\s*轮/.test(body)) return null;
  return {
    slot: 'A2',
    hint: `疑似复用旧轮报告：本卡曾被退回（blocked_at=${fm.blocked_at}）后重新交付，但 Report 未声明**本轮交付时间/轮次** ⇒ 审计无法判断该 Report 是否属于当前一轮（guide §1 A2「被退回过的卡」）`,
  };
}

// ---------- 豁免登记（① 托管模板 ∪ ② 运行时登记） ----------

/** 读登记文件：缺失/损坏/形状不对 ⇒ 视为空列表（**不报错**，退化为全量判红）。 */
export function loadBaseline(file = BASELINE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw && raw.cards) ? raw.cards : [];
  } catch { return []; }
}

/** 生效登记 = 托管模板（①，只读）∪ 运行时登记（②，tasks 目录内）。两源可注入，便于单测。 */
export function loadExemptions(tasksDir = TASKS_DIR, { template = BASELINE_PATH, runtime = runtimeBaselinePath(tasksDir) } = {}) {
  return [...loadBaseline(template), ...loadBaseline(runtime)];
}

/** 两个缺口标签集合是否**完全一致**（排序后逐项相等；顺序无关，长度不同 ⇒ 否）。 */
function sameGapSet(a, b) {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// ---------- 扫描 ----------

/**
 * 执行 Report 完备性巡检（只读）。可注入 tasksDir/baseline 供隔离测试。
 * @returns {{ok:boolean, checked:number, skipped:number, violations:Array, grandfathered:Array,
 *            drafts:Array, exempt:Array, hints:Array, effectiveAt:string}}
 */
export function scanReports(tasksDir = TASKS_DIR, { baseline } = {}) {
  const eff = effectiveAt();
  const effMs = Date.parse(eff);
  const base = baseline === undefined
    ? loadExemptions(tasksDir)
    : (Array.isArray(baseline) ? baseline : []);

  const violations = [];
  const grandfathered = [];
  const drafts = [];
  const exempt = [];
  const hints = [];
  let checked = 0;
  let skipped = 0;

  const files = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((f) => f.endsWith('.md')) : [];
  for (const f of files) {
    let fm;
    let raw;
    try {
      raw = fs.readFileSync(path.join(tasksDir, f), 'utf8');
      ({ fm } = parseFrontmatter(raw));
    } catch { continue; }
    if (!fm) continue;
    const id = fm.id || f.replace(/\.md$/, '');
    const status = String(fm.status || '');
    if (TERMINAL.includes(status)) { skipped++; continue; }   // 终态：连 warn 都不报（不翻旧账）

    const body = reportBody(raw);
    const gaps = slotGaps(body);
    const origin = reportOrigin(body);
    const inHardStatus = HARD_STATUSES.includes(status);

    if (!inHardStatus) {
      // 软面：仅当「已开工且在写的 Report 已成形」时才提示，避免为尚未动笔的卡制造噪声
      if (DRAFT_STATUSES.includes(status) && body !== null && body.trim() !== '' && gaps.length) {
        drafts.push({ id, status, gaps });
      } else skipped++;
      if (gaps.length === 0) hints.push(...contentHints(body).map((h) => ({ id, ...h })));
      continue;
    }

    // 生效截止：`created_at` 不可解析 ⇒ 按 grandfather 处理（保守：绝不因缺字段转红）
    const created = Date.parse(String(fm.created_at || ''));
    const pastCutoff = Number.isFinite(created) && created >= effMs;
    if (pastCutoff) checked++; else skipped++;

    // 硬面完整缺口集 = 槽位缺口 ∪ 来源缺口（(v)：代收口报告不得当交付证据开门）
    const hardGaps = [...gaps, ...originGaps(origin)];

    if (!hardGaps.length) {
      hints.push(...contentHints(body).map((h) => ({ id, ...h })));
      // Δ1/Δ4 属新增口径 ⇒ 只对生效截止之后的卡计算（历史卡不制造噪声）
      if (pastCutoff) hints.push(...deliveryHints(body, fm).map((h) => ({ id, ...h })));
      continue;
    }

    // 截止优先于豁免：grandfather 档本就非阻断，登记对它无实义（登记只用于消解硬违规）
    if (!pastCutoff) {
      grandfathered.push({ id, status, gaps: hardGaps, created_at: fm.created_at || '' });
      continue;
    }

    const hit = base.find((b) => b && b.id === id && sameGapSet(b.gaps || [], hardGaps));
    if (hit) { exempt.push({ id, status, gaps: hardGaps, reason: hit.reason || '' }); continue; }
    violations.push({ id, status, gaps: hardGaps, origin: origin.origin });
  }

  return {
    ok: violations.length === 0,
    checked,
    skipped,
    violations,
    grandfathered,
    drafts,
    exempt,
    hints,
    effectiveAt: eff,
  };
}

// ---------- CLI ----------

/** 缺口标签 → 人类可读（供 stderr 报文；`REPORT_*` 都是伪标签）。渲染成**接在「缺 …」后面也通顺**的
 *  名词短语（历史报文里 `REPORT_MISSING` 曾被直出，读作「缺 REPORT_MISSING」）。 */
const GAP_TEXT = {
  [GAP_NO_SECTION]: '`## Report` 段（整段缺失）',
  [GAP_EMPTY]: '`## Report` 段的正文（空段）',
  [GAP_ORIGIN_UNKNOWN]: '可识别的来源标注（`A0` 只认 `delivery`/`import`）',
  [GAP_IMPORT_NO_PROVENANCE]: '代收口报告的**作者/来源**标注（`author:` + `source:`）',
  [GAP_IMPORT_NOT_DELIVERY]: '**交付者本人**的 Report（本报告自称代收口 ⇒ 不是交付证据）',
};
function describeGaps(gaps) {
  return gaps.map((g) => GAP_TEXT[g] || g).join(', ');
}

function main() {
  const noBaseline = process.argv.includes('--no-baseline');
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  let tasksDir = TASKS_DIR;
  if (arg) {
    // 单卡模式：仍扫 tasksDir（登记/隔离语义不变），只是报告面收窄到该卡
    const cardId = arg.endsWith('.md') ? path.basename(arg, '.md') : arg;
    const r = scanReports(tasksDir, { baseline: noBaseline ? [] : undefined });
    const pick = (x) => x.id === cardId;
    const one = {
      ...r,
      ok: r.violations.filter(pick).length === 0,
      violations: r.violations.filter(pick),
      grandfathered: r.grandfathered.filter(pick),
      drafts: r.drafts.filter(pick),
      exempt: r.exempt.filter(pick),
      hints: r.hints.filter(pick),
    };
    console.log(JSON.stringify(one, null, 2));
    if (!one.violations.length) { console.error(`Report 校验通过 ✔（${cardId}）`); return; }
    console.error(`Report 校验失败：${cardId}`);
    for (const v of one.violations) console.error(`  · ${v.id} [${v.status}] 缺 ${describeGaps(v.gaps)}`);
    process.exitCode = 1;
    return;
  }

  const r = scanReports(tasksDir, { baseline: noBaseline ? [] : undefined });
  console.log(JSON.stringify(r, null, 2));
  if (r.violations.length) {
    console.error(`Report 完备性违例：${r.violations.length} 张 in_review 卡缺公共核心必需项 —— 按 guides/worker-report-template.md §1 补齐（A1…A8 槽位标签）；来源标注见 §1 A0（代收口报告不是交付证据，须交付者本人补写）`);
    // 逃生口可发现性：登记处只报一次（人工核对后追加），免去「翻头注才知道登记在哪」
    console.error(`  如需登记良性豁免（人工核对后）：追加 ${RUNTIME_BASELINE_NAME} @ ${runtimeBaselinePath(tasksDir)}（运行时不随部署；判据 = id + 缺口集合全等，集合变化即失效）`);
    for (const v of r.violations) console.error(`  · ${v.id} [${v.status}]${v.origin && v.origin !== 'delivery' ? ` origin=${v.origin}` : ''} 缺 ${describeGaps(v.gaps)}`);
  }
  if (r.grandfathered.length) {
    console.error(`Report 完备性 warn（生效截止 ${effectiveAt()} 之前创建的卡 ⇒ 不追溯转红）：${r.grandfathered.length} 张`);
    for (const v of r.grandfathered) console.error(`  · warn ${v.id} [${v.status}] created=${v.created_at} 缺 ${describeGaps(v.gaps)}`);
  }
  if (r.drafts.length) {
    console.error(`Report 完备性提示（在写草稿，Report 段已成形但槽位不全）：${r.drafts.length} 张`);
    for (const v of r.drafts) console.error(`  · draft ${v.id} [${v.status}] 缺 ${describeGaps(v.gaps)}`);
  }
  if (r.exempt.length) {
    console.error(`Report 完备性基线豁免：${r.exempt.length} 张（exempt）—— 登记处＝运行时 ${RUNTIME_BASELINE_NAME} ∪ 托管模板 report-baseline.json（只读）；缺口集合变化即失效`);
    for (const v of r.exempt) console.error(`  · exempt ${v.id}${v.reason ? `（${v.reason}）` : ''} 缺 ${describeGaps(v.gaps)}`);
  }
  if (r.hints.length) {
    console.error(`Report 内容提示（非阻断，不置退出码）：${r.hints.length} 条`);
    for (const h of r.hints) console.error(`  · hint ${h.id} ${h.slot}: ${h.hint}`);
  }
  if (r.violations.length) process.exitCode = 1; // 置退出码而非 process.exit：管道 stdout 不截断（调用方需解析 JSON）
}

// main-guard：经 realpath 归一后比较，符号链接调用亦能命中（与其它 scripts/* 同风格）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
