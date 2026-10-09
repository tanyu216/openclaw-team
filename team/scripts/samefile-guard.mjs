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
import { TASKS_DIR, CARD_ID_RE, parseFrontmatter } from './lib.mjs';

const NON_TERMINAL = new Set(['ready', 'in_progress', 'blocked', 'in_review']);

function parseWrites(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw !== 'string') return [];
  const s = raw.trim().replace(/^\[|\]$/g, '').replace(/["']/g, '');
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function resolveWriteSet(fm) {
  const writes = parseWrites(fm?.writes);
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
    else if (argv[i] === '--writes' && argv[i + 1]) writes = parseWrites(argv[++i]);
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
