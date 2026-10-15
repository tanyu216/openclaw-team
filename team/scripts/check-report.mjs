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
 *   生效登记 = ① ∪ ②（`loadExemptions`）。登记项形状 `{ id, gaps: [...], reason }`——`reason` 是
 *   **必填**且去空白后 ≥8 字符（D5，见 `validExemption`）：`gaps` 只能证明「缺口集合没变」，
 *   说不清「为何这个缺口良性」，而豁免的合法性全在那句人工判断上 ⇒ 写不下来就不放行（回到判红
 *   路径），并在结果 `invalidExemptions` 里点名，供人工补写登记。
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
 * ── (vii) v1.1 判定精度与词汇收口（D1–D5，T-20261015-025543）───────────────────
 *   来源 T-20261015-010749-3 T6 缺陷票；逐条：
 *   · **D1 词汇面**：A4 状态词表由 3 值扩为**基座同款 4 值** `met/partial/not_met/not_applicable`
 *     （`ACCEPTANCE_STATUSES`）。裁定取「缺失」而非「3 值子集 by design」——`not_applicable`
 *     （本卡不适用）是标准必须能表达的一档，否则作者只能违心写 `met`/`not_met`。并明确
 *     `not_applicable` **不**触发 A4→A6 耦合（`UNMET_STATUSES` 只含 `partial`/`not_met`）。
 *   · **D2 提示精度**：Δ1 耦合由**词级**改**行级**（`couplingHint` / `a4UnmetRows` / `a6ClaimsNone`
 *     / `a6AccountsFor`）。旧口径双错：A6 里 `none critical` 一类**限定语**被当「无残留」⇒ 误报
 *     （本腿 Report 实测）；中文 `无` 类表述不在词表 ⇒ 误漏。新口径 = 「A6 声明无残留」**且**
 *     「该未达成行未在 A6 交代」才提示。
 *   · **D3 sha 规则**：A2 提示由松散 `\b[0-9a-f]{7,40}\b` 收紧为「7–40 位**小写** hex **或**显式
 *     声明无提交」；删掉「槽位里出现 `commit` 字样即放行」的逃生口；**大写 40 位 sha-1 真值不被拒**。
 *   · **D4 边界语义**：项数/字节上限与 `truncated` 属**基座 provider 的载荷边界**，本门禁**不校验**
 *     （理由见 guide §6：上游写入时已界定，门禁是只读的槽位存在性检查，重复设限只会给合法长报告
 *     制造假红）。
 *   · **D5 豁免理由**：登记项 `reason` **必填**且 ≥8 字符（`validExemption`）；不合格 ⇒ 不放行。
 *
 * 注：与 `check-card.mjs`（frontmatter schema）、`check-handoff.mjs`（背景包四锚）**正交**——
 * 前者管卡头字段，后者管 workspace/<id>/handoff.md，本脚本只读**卡面 `## Report` 段**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, TASKS_DIR } from './lib.mjs';
import { isDraft, isTerminal } from './status.mjs';

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

/** A4 状态词表（D1：与基座 provider `ACCEPTANCE_STATUSES = met/partial/not_met/not_applicable`
 *  **四值对齐**，见 guide §1 A4）。子集口径被裁定为缺失而非「by design」：`not_applicable`
 *  （本卡不适用该项）是标准必须能表达的一档，否则作者只能违心写 `met` 或 `not_met`。 */
export const ACCEPTANCE_STATUSES = ['met', 'partial', 'not_met', 'not_applicable'];
/** 未达成集合：只有这两类需要在 A6 里归口。`not_applicable` **不是**未达成 ⇒ **不**参与
 *  A4→A6 耦合（D1(a)，对齐基座 leftovers 规则「未达成项才必须出现在 leftovers」）。 */
export const UNMET_STATUSES = ['partial', 'not_met'];

/** 槽位标签的匹配式：行首（可带列表符号 `-`/`*`/`+`、可带 `**` 粗体）后接标签，标签后须为非数字边界
 *  （`A10` 不得命中 `A1`）。标签即机读手柄，其余正文自由（见 guide §0 锚点语法）。 */
export function slotRegex(id) {
  return new RegExp(`(^|\\n)[ \\t]*(?:[-*+][ \\t]+)?(?:\\*\\*)?${id}(?![0-9])`);
}

/** D3 判据：sha 规则（guide §1 A2）——字段值里出现 `7–40 位小写 hex`，或 40 位**全大写** sha-1
 *  真值（某些工具大写输出，且它是真 sha ⇒ 不得被拒）；或**显式声明无提交**。
 *  `commit`/`提交` 字段**在**时只看字段值，不要求「值恰为一个 sha」：线上实测（2026-10-15 全库扫描）
 *  真实的 A2 都带注记，如 `` `270cce9` (7 files, +2956/−133) ``、`` `cf3a45c` (docs) + `f5b3e76` (cli) ``、
 *  以及 `无（写面 tasks/*.md 不在任何 git 仓）` 式的显式无提交 —— 按整值全等判定会把这 12 张全判成
 *  误报。收紧的着力点是「**裸 `commit:`（无值）/ 6 位缩写不算数**」，不是「值必须纯 sha」。
 *  字段**不在**时才退回整段扫描（兼容「不标注直接写 hash」的写法）——扫描前先抹掉卡路径
 *  `T-YYYYMMDD-HHMMSS`：它的 8 位日期是合法 hex，否则任何带卡路径的 A2 都会「白捡」一个 hash
 *  （旧口径实测如此：只写卡路径的 A2 从不提示 commit 缺失）。 */
const SHA_LOWER = /\b[0-9a-f]{7,40}\b/;
const SHA_UPPER40 = /\b[0-9A-F]{40}\b/;
const NO_COMMIT_VALUE = /^(?:none\b|n\/?a\b|—|-|无|no commit\b)/i;
const NO_COMMIT_PHRASE = /\bno commit\b|无提交|未提交/i;
function commitField(seg) {
  const m = /(?:^|[\s·|;；])(?:commit|提交)\s*[:：]\s*([^\n·|;；]*)/i.exec(seg);
  return m ? m[1].trim() : null;                       // null = 字段不在；'' = 字段在但空
}
/** A2 是否交代了提交坐标（`{ok, reason}`；reason 只用于报文）。 */
export function commitCoordinate(seg) {
  const field = commitField(seg);
  if (field !== null) {
    if (SHA_LOWER.test(field) || SHA_UPPER40.test(field) || NO_COMMIT_VALUE.test(field)) return { ok: true };
    return { ok: false, reason: field ? `commit 字段值不是合法 sha：\`${field}\`` : 'commit 字段为空' };
  }
  const scrubbed = String(seg).replace(/T-\d{8}-\d{6}[^\s·|,，;；]*/g, ' ');
  if (SHA_LOWER.test(scrubbed) || SHA_UPPER40.test(scrubbed) || NO_COMMIT_PHRASE.test(scrubbed)) return { ok: true };
  return { ok: false, reason: 'A2 里既无小写 hex sha（7–40 位）也无显式无提交声明' };
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

// 终态 / 草稿态判据来自 `scripts/status.mjs`（`isTerminal` / `isDraft`，与 provider
// `TERMINAL_STATUSES` / check-card 同口径）——本文件不再自持这两份集合。
/** 硬触发态：交付待验收（父卡实测事故型即此）。属本门禁**政策**（非词表），留在本文件。 */
export const HARD_STATUSES = ['in_review'];

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
    if (!/T-\d{8}-\d{6}/.test(seg)) hints.push({ slot: 'A2', hint: '未含卡路径（`tasks/T-YYYYMMDD-HHMMSS….md`）——实测全岗最缺槽位（口径相关：guide §4 只给相对结论，不引百分比；取数 scripts/report-census.mjs）' });
    const cc = commitCoordinate(seg);                      // D3
    if (!cc.ok) {
      hints.push({ slot: 'A2', hint: `未提交坐标：${cc.reason} —— 规则＝**7–40 位小写 hex**（大写 40 位 sha-1 真值亦可），或 \`commit: none\` 式**显式声明无提交**` });
    }
  }
  const a5 = /(^|\n)[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?A5(?![0-9])[\s\S]*?(?=\n[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?A[0-9]|\n#{1,6}\s|$)/.exec(body);
  if (a5) {
    // 判据取**宽**（hint 是非阻断信号，宁可漏报）：须同时出现「退出码字样」与「数字」。
    // 不要求两者相邻 —— A5 常写成表格（列头 `exit`、单元格 `0`），相邻判据会对合规表格误报。
    const seg = a5[0];
    const hasWord = /\bexit\b|退出码|返回码|\brc\b/i.test(seg);
    const hasNumber = /\d/.test(seg);
    if (!(hasWord && hasNumber)) hints.push({ slot: 'A5', hint: '未含**退出码**（命令 + 退出码）——实测 Jobs 是最常漏此项的岗位（取数 scripts/report-census.mjs；gate 只提示不阻断，审计仍按 §6）' });
  }
  return hints;
}

/** 交付面提示（Δ1/Δ4，**永远非阻断**，且**只对生效截止之后的卡**计算）：由 `scanReports` 在
 *  「硬触发 + 已过截止 + 槽位齐备」时调用，避免给历史卡制造噪声。
 *   · Δ1：A4 有未达成项（`partial`/`not_met`）却把 A6 写成「无残留」**且未交代该项** ⇒ guide 的
 *        耦合规则被违反（未达成项必须同时出现在 A6 leftovers）。判据为**行级**，见 `couplingHint`
 *        与文件头 (vii)：旧口径是词级匹配，会误报（A6 里 `none critical` 被当成「无残留」）也会
 *        误漏（中文 `无` 类表述不在词表里）。
 *   · Δ4：本卡曾被退回后重新交付，而 Report 未声明本轮交付时间/轮次 ⇒ 疑似复用旧轮报告。
 */
export function deliveryHints(body, fm = {}) {
  if (!body || !body.trim()) return [];
  const hints = [];
  const ch = couplingHint(slotSpan(body, 'A4').text, slotSpan(body, 'A6').text); // Δ1
  if (ch) hints.push(ch);
  const rh = roundHint(fm, body);                                               // Δ4
  if (rh) hints.push(rh);
  return hints;
}

// ---------- Δ1：A4 → A6 耦合（**行级**判定，非阻断提示；D2 重写） ----------

/** 单元格归一化：剥**首尾**的粗体/反引号/下划线标记与空白、把空白与连字符折叠为 `_`、小写。
 *  目的是把 `partial` / `` `partial` `` / `**not_met**` / `Not Met` / `not-met` 都归一到词表值上。
 *  **不能**把 `_` 当强调符全局剥掉：`not_met` 的状态词本身带下划线，全局剥会把它读成 `notmet`
 *  ⇒ 未达成项被当成表头、静默漏判（本仓单测已钉住该形态）。故只剥首尾。 */
function normCell(s) {
  return String(s).replace(/^[`*_\s]+|[`*_\s]+$/g, '').replace(/[\s-]+/g, '_').toLowerCase();
}

/**
 * 抽 A4 里的**未达成行**（`{ key, item }`）。只认 markdown 表格行，且状态列必须**归一化后恰为**
 * 状态词——状态词钉在独立单元格里，故 A4 的词汇图例行（`met | partial | not_met | not_applicable`）
 * 或项名正文里偶然出现的 `partial` **不会**被当成一行（旧口径正是栽在这里的）。
 *   · `key` = 序号列（`①`/`2`/`#3`；无序号列 ⇒ `''`）——用于在 A6 里回检「这一项交代了吗」；
 *   · `item` = 状态列之前的项名正文（存在时）。
 * `not_applicable` 不是未达成 ⇒ 不进结果（D1(a)）。
 */
export function a4UnmetRows(a4Text) {
  const rows = [];
  for (const line of String(a4Text || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))) continue;          // 分隔行
    const si = cells.findIndex((c) => ACCEPTANCE_STATUSES.includes(normCell(c)));
    if (si < 0 || !UNMET_STATUSES.includes(normCell(cells[si]))) continue;        // 表头/图例/已达成
    rows.push({
      key: si !== 0 && normCell(cells[0]) !== '#' ? cells[0].replace(/[`*]/g, '').trim() : '',
      item: si >= 2 ? cells[1] || '' : '',
    });
  }
  return rows;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 该未达成行是否**已在 A6 里交代**（D2）。判据取**宽**（宁漏报、不误报）：命中任一即算交代。
 *  ① 序号键（`①`/`#3`/`2`）以**独立 token** 出现（数字键须有词边界：否则日期或 `1 file` 会误吞）；
 *  ② 项名正文（≥6 字符）作为子串出现。
 *  有这一条，A6 合法地写着 `none critical` 之类措辞时，不会仅因 A4 有未达成项就被判矛盾。 */
function a6AccountsFor(a6Text, row) {
  const a6 = String(a6Text || '');
  if (row.key) {
    const k = escapeRe(row.key);
    if (k && new RegExp(`(?<![\\p{L}\\p{N}])${k}(?![\\p{L}\\p{N}])`, 'u').test(a6)) return true;
  }
  const item = String(row.item || '').replace(/[`*]/g, '').trim();
  return item.length >= 6 && a6.includes(item);
}

/** A6 是否**声明无残留**（D2）。关键：不能把 `none` 的一切实例都读成「无残留」——
 *  `none critical` / `none of the above blocks` 是**限定语**（残留存在、只是不严重；
 *  本腿自己 Report 的实测误报即此），而旧口径按词命中即判矛盾。
 *  中文只认「无」+ 句读或残留名词（`无。` / `无残留` / `无未决项`），`无法`（cannot）之类不算。 */
const A6_NONE = [
  /\bnone\b(?!\s+(?:critical|block\w*|serious|major|of\b))/i,
  /\bnothing\s+(?:outstanding|remaining|open|pending)\b/i,
  /\bno\s+(?:residual\w*|remaining|outstanding|open|pending|known|block\w*)\b/i,
  /\bn\/?a\b/i,
  /(?:^|[\s（(、,，;；|·>—\-*）)])无(?=[\s。.!！,，;；|)）·—]|$|残留|未决|待办|风险|遗留|其他|其余|剩余|新增|问题|阻塞|未完成)/m,
];
export function a6ClaimsNone(a6Text) { return A6_NONE.some((re) => re.test(String(a6Text || ''))); }

/**
 * Δ1 耦合判定的实现（**行级**，D2 重写）：返回提示或 `null`。
 * 两段式——先问 A6 有没有**声明无残留**（矛盾的必要条件），再逐行回检该未达成项是否已在 A6
 * 出现（交代了 ⇒ 不是矛盾）。两段都过才提示，故：
 *   · 误报面关掉：A6 写 `none critical`（限定语）或已逐项交代 ⇒ 不提示；
 *   · 误漏面关掉：A6 写 `无。`/`无未决项`（旧词表外）而 A4 有 `partial` 且未交代 ⇒ 提示。
 * A4 非表格（散文形态）⇒ 退化为词表命中（`partial`/`not_met`/`未达成`），此时无法逐行回检，
 * 但 A6 侧已换成「声明无残留」判据 ⇒ 旧口径的 `none` 误报仍然消除。
 */
export function couplingHint(a4Text, a6Text) {
  if (!a6ClaimsNone(a6Text)) return null;
  const a4 = String(a4Text || '');
  const tableShaped = /(^|\n)[ \t]*\|/.test(a4);
  const pending = tableShaped
    ? a4UnmetRows(a4).filter((r) => !a6AccountsFor(a6Text, r))
    : (/\b(?:partial|not_met)\b|未达成|部分达成/.test(a4) ? [{}] : []);
  if (!pending.length) return null;
  return {
    slot: 'A6',
    hint: 'A4 有未达成项（`partial`/`not_met`）但 A6 声明「无残留」且未交代该项 —— guide §1 A4 耦合规则：'
      + '未达成项**必须**同时出现在 A6 leftovers 并带归口（`not_applicable` 不是未达成项，不参与本条）',
  };
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

/** 豁免理由的最小长度（D5，口径对齐基座 provider 的 `reason ≥8 字符`）。 */
export const MIN_EXEMPTION_REASON = 8;

/**
 * 登记项是否**有效**（D5）：形状 `{ id, gaps: [...], reason }` 且 `reason` 去空白后 ≥8 字符。
 * **理由缺失/过短 ⇒ 该项不放行**（回到判红路径），并在巡检结果 `invalidExemptions` 里点名。
 * 理由不是形式主义：`gaps` 只能证明「缺口集合没变」，说不清「为什么这个缺口是良性的」——
 * 而豁免的全部合法性来源就是那句人工判断，写不下来就等于没有。故它跟 `gaps` 一样是**必填**。
 */
export function validExemption(e) {
  return Boolean(e) && typeof e.id === 'string' && e.id !== ''
    && Array.isArray(e.gaps)
    && typeof e.reason === 'string' && e.reason.trim().length >= MIN_EXEMPTION_REASON;
}

/** 登记面 = 托管模板（①，只读）∪ 运行时登记（②，tasks 目录内）。两源可注入，便于单测。
 *  注意：本函数只负责**读**（含形状不合的条目，便于点名）；放行与否由 `validExemption` 在判红处裁定。 */
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
 *            drafts:Array, exempt:Array, invalidExemptions:Array, hints:Array, effectiveAt:string}}
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
  const invalidExemptions = [];
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
    if (isTerminal(status)) { skipped++; continue; }   // 终态：连 warn 都不报（不翻旧账）

    const body = reportBody(raw);
    const gaps = slotGaps(body);
    const origin = reportOrigin(body);
    const inHardStatus = HARD_STATUSES.includes(status);

    if (!inHardStatus) {
      // 软面：仅当「已开工且在写的 Report 已成形」时才提示，避免为尚未动笔的卡制造噪声
      if (isDraft(status) && body !== null && body.trim() !== '' && gaps.length) {
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

    const candidates = base.filter((b) => b && b.id === id && sameGapSet(b.gaps || [], hardGaps));
    const hit = candidates.find(validExemption);                 // D5：理由不合格者一律不放行
    if (hit) { exempt.push({ id, status, gaps: hardGaps, reason: String(hit.reason ?? '').trim() }); continue; }
    if (candidates.length) {
      // 形状对（id + 缺口集合全等）但 reason 不合格 ⇒ 不放行，点名供人工补写登记（不是卡面缺陷）
      invalidExemptions.push({ id, status, gaps: hardGaps, reason: String(candidates[0].reason ?? '').trim() });
    }
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
    invalidExemptions,
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
      invalidExemptions: r.invalidExemptions.filter(pick),
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
    for (const v of r.exempt) console.error(`  · exempt ${v.id}（${v.reason}）缺 ${describeGaps(v.gaps)}`);
  }
  if (r.invalidExemptions.length) {
    console.error(`Report 完备性豁免登记**未生效**（D5：reason 缺失或去空白后 <${MIN_EXEMPTION_REASON} 字符 ⇒ 不放行）：${r.invalidExemptions.length} 条 —— 请在登记项补写可核对的理由`);
    for (const v of r.invalidExemptions) console.error(`  · invalid-exempt ${v.id} reason=${v.reason ? `"${v.reason}"` : '(缺失)'} 缺 ${describeGaps(v.gaps)}`);
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
