#!/usr/bin/env node
/**
 * claim-guard.mjs — 统一领取守卫（claim-first 统一 + poll 跨回合互斥 + 同卡双跑拦）
 *
 * 背景（T-20261009-211234-concurrencyharden）：同卡双跑实证之一 =「poll ↔ 直派/异回合」。
 * 直派路径（claim.mjs / ACL task.claim）此前**只**调 lib.claimCard，未查活跃子会话 registry
 * —— 心跳陈旧 >30min 时仍可越过守卫重领。本守卫把「防双跑守卫 + 原子领取」合并为唯一切入点：
 *   1) 领取前先查 registry.activeSessions（running + pid 存活）⇒ 有 ⇒ 不领（active_session）；
 *   2) 再经 lib.claimCard：in_progress+心跳新鲜 ⇒ 不领（in_progress_fresh）；陈旧恢复 ⇒ 同卡跨回合锁
 *      新鲜 ⇒ 不领（turn_locked）；全部通过才原子领取。
 * 用法：node claim-guard.mjs <cardId|绝对路径> <assignee>
 * 输出：JSON { ok, reason?, mode?, card?, cardPath?, sessions? }
 */
import fs from 'node:fs';
import path from 'node:path';
import { claimCard, readCard, cardPathOf, LOCKS_DIR } from './lib.mjs';
import { activeSessions, formatActiveReason } from './registry.mjs';

export function claimGuarded(cardArg, assignee, { registry = null } = {}) {
  // 领取前先取卡 id（供 registry 守卫）；读卡失败 ⇒ 直接交回 claimCard 的 not_found 口径
  let cardId;
  try {
    const r = readCard(cardArg);
    cardId = r.fm.id || path.basename(cardPathOf(cardArg), '.md');
  } catch {
    return claimCard(cardArg, assignee); // 非法路径/缺失卡 ⇒ 复用 claimCard 既有原因
  }
  const active = activeSessions(cardId, { registry });
  if (active.length) {
    return {
      ok: false,
      reason: 'active_session',
      sessions: formatActiveReason(active),
      card: { id: cardId },
    };
  }
  return claimCard(cardArg, assignee);
}

function main() {
  const [cardArg, assignee] = process.argv.slice(2);
  if (!cardArg || !assignee) {
    console.error('用法: node claim-guard.mjs <cardId|绝对路径> <assignee>');
    process.exit(2);
  }
  try {
    fs.mkdirSync(LOCKS_DIR, { recursive: true }); // 直派路径无 poll main 预建锁目录，此处补
  } catch {
    /* 已存在/不可建：claim 内会再暴露 */
  }
  const result = claimGuarded(cardArg, assignee);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

// main-guard：经 realpath 归一后比较（与 lib.mjs 同口径）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
