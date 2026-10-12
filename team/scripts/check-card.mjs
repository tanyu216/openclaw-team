#!/usr/bin/env node
/**
 * check-card.mjs — 任务卡 schema/状态机校验（契约 task-interface v1）
 * 用法：node check-card.mjs [cardId|path]   # 省略则扫全部 tasks/*.md
 * 退出码：0 通过；1 有违规。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, TASKS_DIR } from './lib.mjs';

const TASKS = TASKS_DIR;
const MAX_CARD_BYTES = 1_000_000;
// 读侧白名单：canonical 7（PROTOCOL.md §①）∪ 旧词别名 {ready, failed}（别名只在读侧容错，永不回写）。
export const STATUS = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled', 'ready', 'failed'];
const ASSIGNEES = ['elon', 'jobs', 'linus', 'turing', 'simons', 'assistant'];
export const PRIORITY = ['low', 'medium', 'high', 'urgent'];
const REQUIRED = ['id', 'title', 'assignee', 'status', 'goal', 'project'];
/**
 * 内部事务卡的项目码（PROTOCOL §①/§⑩.4）。`__team__` 卡的 cwd 由卡片 `target` 决定
 * （§⑥ cwd normalization）；**缺 target ⇒ `spawn-lane.resolveCwd` 回落到 live team 根**
 * （`~/.openclaw/team`）——正是「不动 live」被静默破坏的系统口子（T-20261013-015831）。
 * 故 `__team__` 卡 `target` 必填；缺失按 carding 缺陷报红（机读 `[role]` 标签 + exit≠0）。
 */
export const TEAM_PROJECT = '__team__';

export function checkOne(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const { fm } = parseFrontmatter(raw);
  if (!fm) return ['缺 frontmatter'];
  const errs = [];
  if (raw.length > MAX_CARD_BYTES) errs.push(`卡体积异常 ${raw.length}B (>${MAX_CARD_BYTES})`);
  for (const k of REQUIRED) if (!fm[k]) errs.push(`缺必填字段 ${k}`);
  if (fm.status && !STATUS.includes(fm.status)) errs.push(`非法 status: ${fm.status}`);
  if (fm.assignee && !ASSIGNEES.includes(fm.assignee)) errs.push(`非法 assignee: ${fm.assignee}`);
  if (fm.priority && !PRIORITY.includes(fm.priority)) errs.push(`非法 priority: ${fm.priority}`);
  if (fm.status === 'in_progress' && !fm.claimed_by) errs.push('in_progress 但缺 claimed_by');
  // `project=__team__` 卡 target 必填（§⑩.4 约定）：缺 target ⇒ spawn-lane 默认 cwd=live。
  // 报错串带机读 `[role] <归口>` 标签（归口 = 建卡人 created_by，缺省 elon——carding 硬门责任人）。
  if (fm.project === TEAM_PROJECT && !String(fm.target ?? '').trim()) {
    const role = fm.created_by || 'elon';
    errs.push(`project=__team__ 缺 target [role] ${role}（carding 缺陷：spawn-lane 否则默认 cwd=live ~/.openclaw/team）`);
  }
  return errs;
}

function main() {
  let files;
  if (process.argv[2]) {
    const a = process.argv[2];
    files = [a.endsWith('.md') ? path.resolve(a) : path.join(TASKS, a + '.md')];
  } else {
    files = fs.existsSync(TASKS) ? fs.readdirSync(TASKS).filter((f) => f.endsWith('.md')).map((f) => path.join(TASKS, f)) : [];
  }
  let bad = 0;
  for (const f of files) {
    const errs = checkOne(f);
    if (errs.length) { console.log(`✗ ${path.basename(f)}: ${errs.join('; ')}`); bad++; }
  }
  console.log(bad ? `\n卡校验失败：${bad}/${files.length}` : `卡校验通过 ✔（${files.length} 张）`);
  process.exit(bad ? 1 : 0);
}

// main-guard：经 realpath 归一后比较，符号链接调用亦能命中；被 import 时（如单测）不执行 CLI
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
