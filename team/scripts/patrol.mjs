#!/usr/bin/env node
// patrol.mjs — 框架侧 patrol 入口（供 automations/dispatch.mjs 消费）：扫描 + **发火前现态二次核对**。
//
// 为什么需要这一层：patrol-scan.mjs 的现态门禁判定的是「**扫描时点**的卡现态」，但告警要从生成走到
// 送达（T-20261010-071808 / Turing R41：生成时点确实命中 stale，送达时卡已成 done/in_review）⇒
// 消费方拿到的是**已收口的陈旧告警**，被迫反复 live-verify。本入口在候选**发出前**做一次 in-process
// 现态重核，把「快照仍陈旧但现态已终结」的候选从 fire 集合剔除（进 dropped，审计可见，绝不静默丢）。
//
// 判定口径单一来源：scanStale 与 recheckStale 共用 patrol-scan.mjs 的 liveVerdict，故「扫描」与
// 「重核」两次判定完全同源，不会出现两套口径漂移。本文件**不**重复实现任何判定逻辑。
//
// 为什么不是直调 patrol-scan.mjs：patrol-scan.mjs 只做单次扫描（默认子命令无「发出前把关」）；
// live 触发路径（Gateway automation）应指向本文件，使 061248/071808 的 re-check 真正生效。
//
// 契约（dispatch.mjs §6 归一化：`Array.isArray(r.stale) ⇒ fire = r.stale.length > 0`）：
//   - stdout **恰一行** JSON：
//       无候选                      ⇒ {"stale":[]}
//       有候选、重核正常            ⇒ {"stale":[<存活>],"dropped":[<剔除>]}
//       有候选、重核抛错/信封畸变   ⇒ {"stale":[<原候选>],"dropped":[],"recheck":"failed"}
//   - 退出码：0 = 正常（含「无告警」）；非零**仅**真实故障（扫描器本身不可用）——绝不把「无告警」当失败。
//   - fail-safe（绝不静默假红/假绿）：重核抛错或返回畸变信封 ⇒ **保留原候选**（照常告警）。宁可多报一次，
//     也不因`把关`环节自身故障而吞掉真警报。收缩告警集**仅**在收到良构 `{stale:[…]}` 时发生。
//   - 无绝对路径、与 cwd 无关：卡目录 / workspace 一律经 lib.mjs 的 TEAM_ROOT 解析
//     （team-paths.mjs 默认 ~/.openclaw/team，可由 OPENCLAW_TEAM_ROOT 覆盖——单测隔离用）。
//   - main-guard（realpath 比较，同 patrol-scan.mjs）：被 import 时零副作用。
import fs from 'node:fs';
import path from 'node:path';

import { TEAM_ROOT } from './lib.mjs';
import { scanStale, recheckStale } from './patrol-scan.mjs';

/**
 * 候选条目有效性：须为含**非空字符串 id** 的普通对象。
 * 与 patrol-main.js 的 O3 同口径：null / 标量 / 数组 / 无 id 均视为**载荷畸变**，
 * 不得被当成「现态已无 stale」而静默收缩告警集。
 */
function isStaleEntry(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e) && typeof e.id === 'string' && e.id !== '';
}

/**
 * 重核结果是否良构：`{stale:[…合法条目], dropped:[…]}`。
 * 声明非空却**全为畸变条目** ⇒ 不合良构（fail-safe 保留原候选）；良构的**空**数组才是合法收缩信号。
 */
function isWellFormed(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  if (!Array.isArray(r.stale) || !Array.isArray(r.dropped)) return false;
  if (r.stale.length === 0) return true;
  return r.stale.every(isStaleEntry);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 执行一次「扫描 + 重核」，返回待输出的信封（不打印、不退出——便于单测直接调用）。 */
export function decide({ scan = scanStale, recheck = recheckStale } = {}) {
  const scanned = scan();
  const candidates = scanned && Array.isArray(scanned.stale) ? scanned.stale : [];
  if (!candidates.length) return { stale: [] };

  let rechecked;
  try {
    rechecked = recheck(candidates);
  } catch (e) {
    // fail-safe：重核环节自身故障 ⇒ 保留原候选（照常告警），诊断走 stderr，绝不污染 stdout 信封
    process.stderr.write(`[patrol] recheck 抛错，fail-safe 保留原候选（root=${TEAM_ROOT}）：${e && e.message ? e.message : e}\n`);
    return { stale: candidates, dropped: [], recheck: 'failed' };
  }
  if (!isWellFormed(rechecked)) {
    process.stderr.write(`[patrol] recheck 信封畸变，fail-safe 保留原候选（root=${TEAM_ROOT}）\n`);
    return { stale: candidates, dropped: [], recheck: 'failed' };
  }
  return { stale: rechecked.stale, dropped: rechecked.dropped };
}

// main-guard：经 realpath 归一后比较，符号链接调用亦能命中（import.meta.url 为真实路径，argv[1] 可能是链接路径）
let IS_MAIN = false;
try {
  IS_MAIN = fs.realpathSync(new URL(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
} catch {
  IS_MAIN = false; // realpath 失败 ⇒ 不执行 main
}

if (IS_MAIN) {
  let env;
  try {
    env = decide();
  } catch (e) {
    // 扫描器本身不可用才是真实故障 ⇒ 非零退出（dispatch.mjs 归一为 fire:false，绝不唤醒模型）
    emit({ stale: [], error: 'scan_failed' });
    process.stderr.write(`[patrol] scan 失败：${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
  emit(env);
}
