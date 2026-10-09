#!/usr/bin/env node
/**
 * claim.mjs — 单卡原子领取（防双跑核心原语）
 * 用法：node claim.mjs <cardId|绝对路径> <assignee>
 * 输出：JSON { ok, reason?, mode?, card?, cardPath? }
 *
 * 语义（PROTOCOL 看板协议，与 poll.mjs 共用 lib.claimCard）：
 * - 领取时机归属 poll：poll 在触发求值期完成原子领取（fire:true ⇔ 卡已 in_progress、claimed_by=自己）
 * - run 回合通常跳过 claim 直接执行；仅当回合内发现卡仍 ready（如 sessions_send 直派未经 poll）才补执行本脚本
 * - in_progress + 心跳新鲜（≤10min）→ 不动（执行唯一性：仅回报状态，不重复执行）
 * - 陈旧恢复：心跳 >30min 同 assignee 可重领；>6h 任意 assignee 可领（上报由 run 回合做）
 */
import { claimCard } from './lib.mjs';

const [cardArg, assignee] = process.argv.slice(2);
if (!cardArg || !assignee) {
  console.error('用法: node claim.mjs <cardId|绝对路径> <assignee>');
  process.exit(2);
}
const result = claimCard(cardArg, assignee);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
