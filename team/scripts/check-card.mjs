#!/usr/bin/env node
/**
 * check-card.mjs — 任务卡 schema/状态机校验（契约 task-interface v1）
 * 用法：node check-card.mjs [cardId|path]   # 省略则扫全部 tasks/*.md
 * 退出码：0 通过；1 有违规。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, TASKS_DIR, splitWrites, escapeReason } from './lib.mjs';

const TASKS = TASKS_DIR;
const MAX_CARD_BYTES = 1_000_000;
// 读侧白名单：canonical 7（PROTOCOL.md §①）∪ 旧词别名 {ready, failed}（别名只在读侧容错，永不回写）。
export const STATUS = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled', 'ready', 'failed'];
const ASSIGNEES = ['elon', 'jobs', 'linus', 'turing', 'assistant'];
export const PRIORITY = ['low', 'medium', 'high', 'urgent'];
const REQUIRED = ['id', 'title', 'assignee', 'status', 'goal', 'project'];
/**
 * 内部事务卡的项目码（PROTOCOL §①/§⑩.4）。`__team__` 卡的 cwd 由卡片 `target` 决定
 * （§⑥ cwd normalization）；**缺 target ⇒ `spawn-lane.resolveCwd` 回落到 live team 根**
 * （`~/.openclaw/team`）——正是「不动 live」被静默破坏的系统口子（T-20261013-015831）。
 * 故 `__team__` 卡 `target` 必填；缺失按 carding 缺陷报红（机读 `[role]` 标签 + exit≠0）。
 */
export const TEAM_PROJECT = '__team__';
/**
 * 终态（历史卡，**不追溯**）：`done` ∪ 旧词别名 `failed` ∪ canonical `canceled`（与 provider
 * `lib/task.mjs` 的 `TERMINAL_STATUSES` 同口径）。`__team__` 缺 `target` 报红规则域 = **非终态**
 * （T-20261013-023535-2）：门禁目的是捕获**卡时**缺陷，历史终态旧卡已永不 spawn-lane，
 * 回落报红 = 噪声 ⇒ grandfather。
 * 非终态按**排除法**判定（`!TERMINAL.includes(status)`），故 `todo`（canonical）/`ready`（旧词）
 * 与 `backlog` 均在域内——`ready`/`todo` 会被 `spawn-lane` exec 自动 claim 后直接 spawn，
 * 缺 target 正是落 `cwd=live` 的口子，必须覆盖。
 */
export const TERMINAL = ['done', 'failed', 'canceled'];

/**
 * 项目内路径 containment 门禁（PROTOCOL §②.1）：非 `__team__` 卡的 `target`/`writes` 必须是
 * **项目内相对路径**；绝对 / 本机锚（`/Users/…`、`~/…`）/ 盘符 / `../` 逃逸 ⇒ 卡时缺陷报红。
 *
 * 洞（本规则立的理由）：`spawn-lane.mjs`/`lane-isolation.mjs` 用
 * `path.resolve(getProject(project).root, target)` 算 lane cwd —— `path.resolve` 的第二个参数
 * 若是**绝对路径**会**丢弃第一个** ⇒ 一张 `project: A`、`target: /Users/…/B` 的卡，其 lane
 * 写入面静默落进 **B 项目**。本门禁在**卡时**拦下它（机读 `[role] <created_by>` 标签 + exit≠0）。
 *
 * 生效截止 `PATH_EFFECTIVE_AT`（缺省常量；`OPENCLAW_TEAM_PATH_EFFECTIVE_AT` 可覆盖，ISO 8601；
 * 非法值 ⇒ 回退常量，绝不静默变严）：`created_at < 截止` ⇒ **grandfather**（不报、不置退出码）。
 *
 * 取值理据（**两条，缺一即「上线即红」**）：
 *   ① 晚于**既存**非终态卡的 `created_at`。2026-10-15 实测 live 非 `__team__` 非终态 **19 张全带
 *      绝对 target**（且都等于各自项目 root、无一真实越界）；max `created_at` = `2026-10-15T05:37:20.997Z`。
 *   ② 晚于**本门禁的部署时刻**。否则「普查 → 部署」之间按旧习惯新建的绝对 target 卡，会在部署
 *      瞬间被追溯转红 —— 与 ① 是同一个坑的两种进入路径。
 * ⇒ 本常量是**部署期参数，不是冻结值**：**部署卡必须先重跑普查、再按当时 max `created_at` 重定**
 *   （用 `OPENCLAW_TEAM_PATH_EFFECTIVE_AT` 临时覆盖即可验证）。一次性迁移卡把在飞 19 张改成项目内
 *   相对（等价形态 `.`，`resolveCwd` 结果不变、纯 no-op）后，本截止可收紧到部署日。
 *
 * `created_at` 缺失/不可解析 ⇒ 同按 grandfather（保守：绝不因缺字段转红；口径同 check-report.mjs）。
 * 规则域 = **非终态**（`!TERMINAL.includes(status)`，故 `backlog` 亦在域内）；`project: __team__`
 * 排除（其 target 绝对形态由 §⑩.4 硬门管辖，见上）。
 */
export const PATH_EFFECTIVE_AT = '2026-11-01T00:00:00Z';

/** 生效截止（env 覆盖；非法 ⇒ 回退常量） */
export function pathEffectiveAt() {
  const raw = process.env.OPENCLAW_TEAM_PATH_EFFECTIVE_AT;
  if (!raw) return PATH_EFFECTIVE_AT;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : PATH_EFFECTIVE_AT;
}

/**
 * 越界检查项：`target`（非空时）∪ `writes` 的每个元素。返回人读报错串数组（空 = 合法）。
 * 纯字面（不触盘、不查 registry）⇒ fast 段保持 offline 且确定。
 */
export function pathViolations(fm) {
  if (!fm || fm.project === TEAM_PROJECT) return [];
  if (TERMINAL.includes(fm.status)) return [];
  // created_at 宽容读法：lib.mjs 的 parseFrontmatter 已做 JSON 反转义，此处再剥一层裸引号，
  // 使直接以「原样 frontmatter 值」调用本函数（单测/外部脚本）也能解析。
  const created = Date.parse(String(fm.created_at ?? '').trim().replace(/^"|"$/g, ''));
  if (!(Number.isFinite(created) && created >= Date.parse(pathEffectiveAt()))) return []; // grandfather
  const who = fm.created_by || 'elon';
  const out = [];
  const target = String(fm.target ?? '').trim();
  const rt = target && escapeReason(target);
  if (rt) out.push(`非 __team__ 项目 target 越出项目边界（须项目内相对路径）[role] ${who}: ${target} — ${rt}`);
  for (const w of splitWrites(fm.writes)) {
    const rw = escapeReason(w);
    if (rw) out.push(`非 __team__ 项目 writes 越出项目边界（须项目内相对路径）[role] ${who}: ${w} — ${rw}`);
  }
  return out;
}

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
  // 规则域限**非终态**（T-20261013-023535-2）：终态历史卡 grandfather、不追溯转红。
  // 报错串带机读 `[role] <归口>` 标签（归口 = 建卡人 created_by，缺省 elon——carding 硬门责任人）。
  if (fm.project === TEAM_PROJECT && !TERMINAL.includes(fm.status) && !String(fm.target ?? '').trim()) {
    const role = fm.created_by || 'elon';
    errs.push(`project=__team__ 缺 target [role] ${role}（carding 缺陷：spawn-lane 否则默认 cwd=live ~/.openclaw/team）`);
  }
  // 项目内路径 containment（§②.1）：非 __team__ 卡的 target/writes 越出项目边界的卡时缺陷
  errs.push(...pathViolations(fm));
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
