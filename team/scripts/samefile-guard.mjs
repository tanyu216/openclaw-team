#!/usr/bin/env node
/**
 * samefile-guard.mjs — 同文件并发告警（worktree 隔离/先串行的决策依据）
 *
 * 背景（T-20261009-211234-concurrencyharden）：同文件多卡并发写 + 连带提交（952a001）。
 * 本脚本比对**非终态**卡的声明写集，报出重叠（同文件/同 target 资源）⇒ 供 worker 决策「先串行
 * 或 git worktree 隔离」。只读扫描，零副作用，绝不写卡/领卡。
 *
 * 写集口径：卡 frontmatter `writes`（可选数组，本卡声明要改的文件，repo 相对路径）；
 *           缺省退化为 `target`（粗判：同 target 视为同资源）。
 * 用法：
 *   node samefile-guard.mjs [--card <id>] [--writes <p1,p2,...>]
 *   --card：只看该卡与其它非终态卡的重叠；--writes：直接给写集（卡未落盘时用）；都不给 ⇒ 全板成对扫描。
 * 输出：JSON { ok:true, conflicts:[{a:{id,writes},b:{id,writes},overlap:[...]}] }；退出码恒 0（告警非闸）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { TASKS_DIR, CARD_ID_RE, parseFrontmatter, splitWrites } from './lib.mjs';

/**
 * 非终态（可写）状态集 —— **同文件/同仓并发判定的唯一口径**，`scripts/lane-isolation.mjs`
 * 与本脚本共用（T-20261012-022948-2：单点持有，避免两处政策漂移）。
 *
 * 口径（`guides/worktree-isolation-sop.md §1`：非终态 = **在飞四态**）：
 *   - **规范词**（真源 `skills/task-ops/lib/task.mjs#CANONICAL_STATUSES`）：`todo` / `in_progress`
 *     / `blocked` / `in_review`。⚠ `todo` 才是**规范值**，`ready` 只是它的 legacy 别名。
 *   - **兼容别名** `ready`：旧卡仍用它写「新卡」（live 仍有 `ready` 旧卡，本卡实测 5 张）⇒ 必须
 *     继续计入，否则只是把同一个缺陷换个方向再犯一遍（轮到 `ready` 卡隐形）。
 *   - **不在集内**：终态 `done`/`failed`/`canceled`（口径同 `TERMINAL_STATUSES`），以及**未排期**
 *     的 `backlog`（尚未进入在飞写集 ⇒ 不构成写者；`§1` 的四态不含它）。
 *
 * **为什么不用 `!TERMINAL_STATUSES.has(status)` 的反向口径**：那会把 `backlog` 与一切**未知名 /
 * 写错**的 status 一并读成写者，把守卫**放宽**到卡面从没声明过的语义（`§1` 明写非终态=在飞四态；
 * 且 live 现存 11 张 `backlog` 卡会突然开始参与同仓判定）。「同类再犯」改由**回归套件**兜住：
 * `scripts/tests/samefile-guard.test.mjs` 以「规范 7 值 − 终态 − 未排期 ∪ 兼容别名」逐值对拍本集合，
 * 并断言集内每个词都在 `ACCEPTED_STATUSES` 里 —— 将来词表增删/拼错会把它**变红**，而不是静默漂移。
 *
 * 本次缺陷（T-20261014-214625-2）：原集正向枚举 `['ready','in_progress','blocked','in_review']`，
 * 用 legacy 词 `ready` 顶替 canonical `todo` ⇒ `status: todo` 的卡对写集重叠扫描与同仓并发判定
 * **完全隐形**（实测：`samefileConflicts({card:<todo 卡>})` 报 `card_not_found_or_terminal`，
 * `laneIsolationPlan` 对一张同写集 `todo` 卡报 `none/no_concurrent_lane`）。
 */
export const NON_TERMINAL = new Set(['todo', 'ready', 'in_progress', 'blocked', 'in_review']);

/** 卡 → 写集（`writes` 优先；缺省退化 `target` —— 粗判口径见本文件头注） */
export function resolveWriteSet(fm) {
  const writes = splitWrites(fm?.writes); // 分割口径已抽到 lib.mjs（单点持有，check-card 共用）
  if (writes.length) return writes;
  const target = String(fm?.target ?? '').trim();
  return target ? [target] : [];
}

/** 扫描所有非终态卡及其写集（只读） */
function scanBoard() {
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
    if (!fm || !fm.id || !NON_TERMINAL.has(fm.status)) continue;
    const writes = resolveWriteSet(fm);
    if (!writes.length) continue; // 无写集信号 ⇒ 不参与重叠判定
    cards.push({ id: fm.id, status: fm.status, writes });
  }
  return cards;
}

function overlap(a, b) {
  return a.filter((x) => b.includes(x));
}

export function samefileConflicts({ card = null, writes = null } = {}) {
  const board = scanBoard();
  const conflicts = [];
  if (card) {
    const me = board.find((c) => c.id === card);
    if (!me) return { ok: true, card, conflicts, note: `card_not_found_or_terminal:${card}` };
    for (const other of board) {
      if (other.id === card) continue;
      const ov = overlap(writes || me.writes, other.writes);
      if (ov.length) conflicts.push({ a: { id: card, writes: writes || me.writes }, b: { id: other.id, writes: other.writes }, overlap: ov });
    }
  } else if (writes) {
    for (const other of board) {
      const ov = overlap(writes, other.writes);
      if (ov.length) conflicts.push({ a: { id: '(本次写集)', writes }, b: { id: other.id, writes: other.writes }, overlap: ov });
    }
  } else {
    for (let i = 0; i < board.length; i++) {
      for (let j = i + 1; j < board.length; j++) {
        const ov = overlap(board[i].writes, board[j].writes);
        if (ov.length) conflicts.push({ a: { id: board[i].id, writes: board[i].writes }, b: { id: board[j].id, writes: board[j].writes }, overlap: ov });
      }
    }
  }
  return { ok: true, conflicts };
}

function main() {
  const argv = process.argv.slice(2);
  let card = null;
  let writes = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--card' && argv[i + 1]) card = argv[++i];
    else if (argv[i] === '--writes' && argv[i + 1]) writes = splitWrites(argv[++i]);
  }
  const r = samefileConflicts({ card, writes });
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

// main-guard：realpath 归一（与 lib.mjs 同口径）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
