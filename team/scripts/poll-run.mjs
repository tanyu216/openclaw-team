#!/usr/bin/env node
/**
 * poll-run.mjs — poll RUN 的契约（单一真源）：**短跑 = 领取 → 移交 → 返回**。
 *
 * 为什么存在（T-20261013-041718，P1）：
 *   Gateway 的 `already-running` **run 锁** = 「该 job 已有 run 在飞 ⇒ 下一次触发的求值整段被跳过」
 *   —— 这是 Gateway 调度器行为，框架**不能**改（见 AUTOMATIONS.md §3.5）。因此 poll 兜底节奏
 *   （PROTOCOL §1「claim timing belongs to poll」）能否兑现，**完全取决于 poll RUN 本身的时长**：
 *   run 不结束，2min 的兜底就一直不 fire。
 *
 *   修复前契约把「本 run 内执行卡 + 把 lane 轮询到终态」写进 poll run（旧 poll.mjs message
 *   「直接执行不再 claim」+ PROTOCOL §6.4 的 poll-to-terminal）⇒ run 时长 ≈ 一条 lane 的工时。
 *   实测（E2E-C-4）：run 19:39Z→20:05Z 未结束，其间 19:42:35Z 落板的 ready 卡迟至 run 结束才被领
 *   ⇒ `Δ=1389s ≫ 120s`；同窗外的即时领取（85.8s）反证机制本身健存、停摆由**长驻 run** 解释。
 *
 * 本模块把新契约收敛为可 import 的纯函数（install.sh 用 CLI 取文案/上界；poll.mjs 用 getter 组
 * payload；tests 用同源造 fixture —— 与 `automations/trigger-template.mjs` 同风格）：
 *   - 文案 `pollRunMessage()`：本 run 只做移交（`spawn-lane.sh` detached），**不等 lane、不把 lane
 *     轮询到终态**；lane 监督交回「后续 cron 回合 + task-patrol」（PROTOCOL §6 已允许回合被中断后
 *     由后续回合接管轮询）；
 *   - 上界 `pollRunTimeoutS()`：run 的 `--timeout-seconds` **不得长于它所保证的兜底节奏**
 *     （默认 = 1 个 poll interval，而非旧的 3600s），0 = 关闭调度器超时。
 *
 * CLI：
 *   node poll-run.mjs message <agent>            # 打印 run payload（无卡路径的模板态）
 *   node poll-run.mjs timeout-default <interval> # 打印默认 run 上界秒数（interval 形如 5m/2m/90s）
 */
import fs from 'node:fs';
import path from 'node:path';

/** 握手（移交）指令：poll run 的唯一动作。文案改这里，poll.mjs 与 install.sh 同时生效。 */
export const HANDOFF_DIRECTIVE = [
  '【本轮 = 短跑，勿长驻】本 run 只做「移交」：对每张已领卡，用',
  '`bash scripts/spawn-lane.sh <card> <owner> [seg] [backend]` 起 lane（detached，起后即返回），',
  '**不要**在本 run 内执行卡片、**不要**在本 run 内把 lane 轮询到终态。移交完即结束本 run；',
  'lane 的进度由 lane 自己回写卡片（心跳/Report），异常由后续 cron 回合（poll / task-patrol）接管。',
  '**不要**给该命令追加定基/隔离/并行类旗标——`--base`、`--no-isolate` 已随旧隔离机制移除，',
  '`parallel=1` 也已移除，传了即用法错误。隔离树由 lane 自己按 `using-git-worktrees` skill 在仓内',
  '`.worktrees/<branch>` 建立/复用：**一张卡一条分支 `<card>`，所有 seg 复用同一分支与树**，seg 之间不做合并；',
  '首建基于 `dev`，只在卡 `done` 前合并一次（见 guides/dev-worktree-flow-sop.md）；入口拒绝时按其报的拒绝码处置，勿绕过。',
  '理由：run 在飞会占住 Gateway 的 job 锁（`already-running`），使后续 tick 的兜底领取整段停摆（T-20261013-041718）。',
].join('');

/** 兼容旧文案的显式禁用词：修复前 poll run 的「就地执行」契约，出现在 message 里即为回归。 */
export const FORBIDDEN_INLINE_PHRASE = '直接执行不再 claim';

/**
 * poll run 的 payload（领取回执 + 短跑移交指令）。
 * @param {string} assignee
 * @param {string[]} cardPaths 本轮已领卡的卡文件路径（可空 —— install.sh 的 job 默认 message 即空表）
 * @returns {string}
 */
export function pollRunMessage(assignee, cardPaths = []) {
  const paths = Array.isArray(cardPaths) ? cardPaths : [];
  const list = paths.map((p, i) => `${i + 1}. ${p}`);
  const head = paths.length
    ? `【${assignee} 轮询领取】本轮已领 ${paths.length} 张卡（并发额度内、互不冲突）：\n${list.join('\n')}\n`
    : `【${assignee} 轮询】\n`;
  const receipt = paths.length
    ? `—— 均已原子领取（status=in_progress, claimed_by=${assignee}），勿再 claim。\n\n`
    : '';
  return head + receipt + HANDOFF_DIRECTIVE;
}

/**
 * 解析 poll interval 规格（install.sh 的 `OPENCLAW_TEAM_POLL_INTERVAL` 口径）→ 秒。
 * 接受 `<n><s|m|h|d>`；非法（缺单位/非正数/未知单位）⇒ null（caller 决定回退）。
 * @param {string} spec
 * @returns {number|null}
 */
export function parseIntervalSeconds(spec) {
  const m = /^(\d+)([smhd])$/.exec(String(spec == null ? '' : spec).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
  return n * unit;
}

/** 默认 run 上界（秒）= 它所要保证的兜底节奏本身；interval 无法解析 ⇒ 300s（5m 声明默认）。 */
export const DEFAULT_POLL_INTERVAL_S = 300;

/**
 * poll run 的 `--timeout-seconds`。
 * 语义（T-20261013-041718）：
 *   - `OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S` 显式给出**正整数** ⇒ 用它；`0` ⇒ 0（关闭调度器超时）；
 *   - 显式值非法（负/非数/空）⇒ 回落到默认，**绝不**把 typo 读成「无上界」；
 *   - 默认 = `intervalSeconds`（run 不得长于它所要保证的兜底节奏），无法解析 ⇒ `DEFAULT_POLL_INTERVAL_S`。
 * @param {{intervalSeconds?:number, env?:Record<string,string|undefined>}} [o]
 * @returns {number} 秒（≥0）
 */
export function pollRunTimeoutS({ intervalSeconds = DEFAULT_POLL_INTERVAL_S, env = {} } = {}) {
  const iv = Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? Math.floor(intervalSeconds) : DEFAULT_POLL_INTERVAL_S;
  const raw = String((env && env.OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S) ?? '').trim();
  if (/^\d+$/.test(raw)) return Number(raw); // 含 0（= 关闭）
  return iv;
}

// ---- CLI --------------------------------------------------------------------
function main(argv) {
  const [cmd, arg] = argv;
  if (cmd === 'message') {
    process.stdout.write(pollRunMessage(arg || '<agent>'));
    process.stdout.write('\n');
    return;
  }
  if (cmd === 'timeout-default') {
    const s = parseIntervalSeconds(arg);
    if (s == null) {
      process.stderr.write('poll-run.mjs: timeout-default 需要 interval 形如 5m/2m/90s/1h\n');
      process.exit(2);
    }
    process.stdout.write(String(s) + '\n');
    return;
  }
  process.stderr.write('用法:\n  node poll-run.mjs message <agent>\n  node poll-run.mjs timeout-default <interval>\n');
  process.exit(2);
}

// 仅当作为 CLI 调用时执行（被 import 时无副作用）。
// main-guard：经 realpath 归一后比较（与 lib.mjs / build-guard 等同口径）——朴素比较在**符号链接调用**
// 下不成立（`import.meta.url` 已解析为真实路径，`argv[1]` 是调用时路径）⇒ 静默 no-op、exit 0。
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main(process.argv.slice(2));
} catch { /* realpath 失败 ⇒ 不执行 main */ }
