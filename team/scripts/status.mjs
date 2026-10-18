#!/usr/bin/env node
/**
 * status.mjs — 状态词表的**单一真源**（卡面轴 + 会话轴 + 两轴间唯一桥）。
 *
 * 为什么单独成模块：状态词表是仓内**最横切**的概念，曾散落在 12 个文件里各写一份（`TERMINAL`
 * 就有三种内容），彼此靠注释声明「同口径」维系。代价是实证的 —— canonical `todo` 归一化前后
 * 在四个模块各修一次（T-20261014-204530 / -205709 / -214625，再加重写状态机文档）。本模块把
 * 「哪些状态算终态 / 在飞 / 新卡 / 草稿」收敛为一处，其余模块 import 取用。
 *
 * **零 import**：本模块不依赖 provider ACL、不依赖 `lib.mjs`、不读环境变量、不做 I/O。因此任何
 * 上下文（含未装 provider 的仓内 checkout、纯单测）都能装载它 —— 这是它作为「词表」应有的深度：
 * 接口是一组纯谓词，实现是词表本身。
 *
 * ── 两条轴，词汇**故意不同** ────────────────────────────────────────────────
 * · **卡面轴**（`status:` frontmatter）：`backlog | todo | in_progress | in_review | blocked |
 *   done | canceled`（`R-TERM-1` 规范 7 值）。终态写 `canceled`。
 * · **会话轴**（registry `status:`）：`running | done | closed | failed`（凭证在 `registry.mjs`
 *   `VALID_STATUS`，provider `lib/task.mjs` 亦 import 它作写入门）。终态写 `closed`。
 * 两轴用词不同**不是漂移而是设计**（会话没有 `blocked`，卡面没有 `closed`）；两轴之间**只有一处**
 * 允许换算：`sessionTerminalForCard()`（lane 终结时由卡面推会话终态），见第 ④ 节。
 *
 * ── 与 provider 词表的关系 ─────────────────────────────────────────────────
 * `CANONICAL_STATUSES` / `STATUS_ALIASES` / `ACCEPTED_STATUSES` 与 provider `lib/task.mjs` 逐值
 * 对齐（provider 是**边界**唯一写卡入口，其词表是写侧权威）。provider 有意不随仓 ⇒ 本模块是
 * 仓内**读侧**的断言面，一致性由 `tests/status.test.mjs` 的**对拍**用例机器校验（有 provider 时
 * 逐值对拍，无 provider 时按冻结快照对拍）—— 即「适配器 + 一致性测试」，与 `board-adapter.mjs`
 * 的两腿漂移门同款：词表真源在外部，仓库这一侧声明并**钉住**它。
 *
 * ⚠ 一处**已知的 provider 侧陈旧**（本模块存在时即可见）：provider 的 `NON_TERMINAL` 是
 * `{ready, in_progress, in_review, blocked}` —— 用旧词 `ready` 且**缺** canonical `todo`。
 * 故凡 import provider 该集合的读侧（`check-idem.mjs`）对 `status: todo` 的卡**隐形**。仓内读侧
 * 一律改用本模块的 `NON_TERMINAL`；provider 侧的修不属本仓（见 `skills/PROVENANCE.md`）。
 */

// ─────────────────────────────── ① 卡面轴 · 词表 ───────────────────────────────

/** 规范 7 值（`R-TERM-1`；顺序即规范顺序）。 */
export const CANONICAL_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'];

/** 兼容别名 / 容忍拼写：仅在**边界解析**时归一，绝不回写（旧卡保持原词 ⇒ byte-stable）。 */
export const STATUS_ALIASES = ['ready', 'failed', 'in-review', 'in-progress', 'cancelled'];

/** 别名词 → 规范词（provider 同口径）。 */
export const ALIAS_TARGET = new Map([
  ['ready', 'todo'],
  ['failed', 'canceled'],
  ['in-review', 'in_review'],
  ['in-progress', 'in_progress'],
  ['cancelled', 'canceled'],
]);

/** `setStatus` 侧可接受词表 = 规范 7 值 ∪ 别名（provider `ACCEPTED_STATUSES` 同口径）。 */
export const ACCEPTED_STATUSES = new Set([...CANONICAL_STATUSES, ...STATUS_ALIASES]);

/**
 * 读侧白名单（`check-card.mjs` 的 schema 校验用）：规范 7 值 ∪ 旧词 `{ready, failed}`。
 * **故意窄于 `ACCEPTED_STATUSES`**：`in-review`/`in-progress`/`cancelled` 是 provider 写侧的容忍
 * 拼写，不是仓内卡面该出现的词 —— 拼错要在读侧报红，而不是被容错吞掉。
 */
export const READ_STATUSES = [...CANONICAL_STATUSES, 'ready', 'failed'];

/**
 * 归一：`String(raw).trim()` → 别名词映射到规范词。
 * @returns {string|null} 规范词；空值/未知名 ⇒ `null`（调用方自行决定报红口径）。
 */
export function normalizeCardStatus(raw) {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return null;
  return ALIAS_TARGET.get(s) || (CANONICAL_STATUSES.includes(s) ? s : null);
}

/** 词是否被 provider 接受（规范值或别名；拼写漂移如 `in_reviw` ⇒ false）。 */
export function isAccepted(s) {
  return ACCEPTED_STATUSES.has(String(s == null ? '' : s).trim());
}

// ─────────────────────────── ② 卡面轴 · 谓词（单一判定源） ───────────────────────
//
// 谓词各**具名**、不复用一个「非终态 = 取反」。原因是它们回答的是**不同的业务问题**，取反会在
// 边界上出错：`backlog` 对「会否被 spawn 后占住 cwd」是**在域**（check-card），对「此刻是否占着
// 文件写权」却**不在域**（samefile-guard）。故不提供 `isNonTerminal = !isTerminal`。

/** 终态（= 已收口，不再推进）。含旧词别名 `failed`（= `canceled`，边界解析）。 */
export const TERMINAL = ['done', 'failed', 'canceled'];
/** 终态判定（先归一 ⇒ `cancelled`/`failed` 等价写法同判）。 */
export function isTerminal(s) {
  const n = normalizeCardStatus(s);
  return n === 'done' || n === 'canceled';
}

/** 新卡（可被 poll 自动领取的「未开工」态）。`todo` 是规范值，`ready` 是 retained 兼容别名。 */
export const NEW_STATUSES = new Set(['todo', 'ready']);
export function isNew(s) {
  return normalizeCardStatus(s) === 'todo';
}

/** 在飞（已派发、尚未收口）：handoff 门禁的关注域。 */
export const IN_FLIGHT_STATUSES = ['in_progress', 'in_review'];
export function isInFlight(s) {
  const n = normalizeCardStatus(s);
  return n === 'in_progress' || n === 'in_review';
}

/** 草稿态：Report 段已存在且非空但槽位不全 ⇒ 只给 draft 提示、不置退出码（check-report）。 */
export const DRAFT_STATUSES = ['in_progress', 'blocked'];
export function isDraft(s) {
  const n = normalizeCardStatus(s);
  return n === 'in_progress' || n === 'blocked';
}

/**
 * 非终态（**已排期**且在飞）—— 并发写集/同文件冲突的判定域（samefile-guard）。
 * 含未开工的 `todo`/`ready`（它们已被排期，spawn 后即占写权），**不含** `backlog`（未排期，
 * 不构成并发）与全部终态。名字沿用仓内既有词汇，语义以本注释为准。
 */
export const NON_TERMINAL = new Set(['todo', 'ready', 'in_progress', 'blocked', 'in_review']);
export function isNonTerminal(s) {
  const n = normalizeCardStatus(s);
  return n !== null && n !== 'backlog' && n !== 'done' && n !== 'canceled';
}

/** 未收口（= 非终态且词非空）：SLA 确认门的 open 前置（sla-scan）。空值 ⇒ false。 */
export function isOpen(s) {
  const n = normalizeCardStatus(s);
  return n !== null && n !== 'done' && n !== 'canceled';
}

// ─────────────────────────────── ③ 会话轴 · 词表 ───────────────────────────────

/** registry 合法 status（写入侧唯一口径在 `registry.mjs#VALID_STATUS`；此处为其读侧镜像）。 */
export const SESSION_STATUSES = ['running', 'done', 'closed', 'failed'];

/** 会话终态（lane 收口可落的值）。注意与**卡面**终态用词不同：会话是 `closed` 不是 `canceled`。 */
export const SESSION_TERMINAL_STATUSES = ['done', 'closed', 'failed'];
export function isSessionTerminal(s) {
  return SESSION_TERMINAL_STATUSES.includes(String(s == null ? '' : s).trim());
}

// ───────────────────── ④ 两轴之间**唯一**的换算式（有且仅有这一处） ─────────────────

/**
 * 卡面状态 → 会话终态。lane 进程已死时，卡面即其最终交付面，会话须落一个终态以收口
 * （否则 `poll` 会把「会话已终结、卡仍 in_progress」读成可重领 —— 这正是 T-20261015-045724 的
 * 事故形态）。
 *
 * 换算表：`canceled`/`failed`（交付失败）⇒ 会话 `failed`；`done`/`in_review`（交付已就绪或已
 * 交付待验收）⇒ 会话 `done`；其余（含在飞途中死亡）⇒ `closed`（中性收口，不宣称成败）。
 */
export function sessionTerminalForCard(cardStatus) {
  const n = normalizeCardStatus(cardStatus);
  if (n === 'canceled') return 'failed';
  if (n === 'done' || n === 'in_review') return 'done';
  return 'closed';
}
