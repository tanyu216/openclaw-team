#!/usr/bin/env node
/**
 * check-idem.mjs — 建卡幂等巡检（同 idem 键的非终态卡 >1 ⇒ 报警；纳入 check-all）
 * 依据：PROTOCOL §㉙.8「巡检加『重复 key』校验」；guides/task-interface.md §14。
 *
 * 口径：按 `idem = <kind> | <assignee> | <source> | <target>`（source = review_of ‖ parent）
 * 对**非终态**（ready/in_progress/in_review/blocked）卡分组，仅报组内 >1 的组。
 *
 * **无 source（无 review_of 且无 parent）⇒ 不产键**（`idemKey` 返回空串）⇒ 不参与机械判重、
 * 扫描时直接跳过（同项目同人不再误撞）；机械判重仅对「有 source」的卡兜底（review_of/子卡）。
 *
 * 基线豁免（**机制保留、当前空/退役**）：`scripts/idem-baseline.json` 现为 `{ "groups": [] }`。
 * 机制：判据 = `key` 相同 **且** `ids` 排序后与该组卡 id 集合**完全一致** ⇒ 移入 `exempt`（不判红）；
 * 集合一旦变化（增卡/删卡/换卡）即**豁免失效**，重新报警（防「登记一次、永久放行」）。
 * 新增豁免须人工核对后追加；`--no-baseline` 可忽略基线（全部按 duplicates）。
 *
 * 退出码：0 无非豁免重复；1 有非豁免重复（报警）。
 * 隔离：OPENCLAW_TEAM_ROOT 覆盖（与 team-paths.mjs 同源），便于单测用 mkdtemp。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, TASKS_DIR } from './lib.mjs';
import { idemKey, NON_TERMINAL } from '../skills/task-ops/lib/task.mjs';

export const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'idem-baseline.json');

/** 读基线文件：缺失/损坏/形状不对 ⇒ 视为空组列表（**不报错**，退化为全量判红）。 */
export function loadBaseline(file = BASELINE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw && raw.groups) ? raw.groups : [];
  } catch { return []; }
}

/** 两个 id 集合是否**完全一致**（排序后逐项相等；顺序无关，长度不同 ⇒ 否）。 */
function sameIdSet(a, b) {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function scanIdem(tasksDir = TASKS_DIR, { baseline } = {}) {
  const groups = new Map();
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir)) {
      if (!f.endsWith('.md')) continue;
      let fm;
      try { ({ fm } = parseFrontmatter(fs.readFileSync(path.join(tasksDir, f), 'utf8'))); } catch { continue; }
      if (!fm) continue;
      const id = fm.id || f.replace(/\.md$/, '');
      if (!NON_TERMINAL.has(fm.status)) continue;
      const key = idemKey({ ...fm, id });
      if (!key) continue; // 无 source ⇒ 不产键，跳过（不参与机械判重）
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ id, status: fm.status, assignee: fm.assignee || '', title: fm.title || '' });
    }
  }
  const base = baseline === undefined
    ? loadBaseline()
    : (Array.isArray(baseline) ? baseline : []);

  const duplicates = [];
  const exempt = [];
  for (const [key, cards] of groups.entries()) {
    if (cards.length <= 1) continue;
    const ids = cards.map((c) => c.id);
    const hit = base.find((b) => b && b.key === key && sameIdSet(b.ids || [], ids));
    if (hit) exempt.push({ key, cards, reason: hit.reason || '' });
    else duplicates.push({ idem: key, cards });
  }
  return { ok: true, duplicates, exempt };
}

// main-guard：经 realpath 归一后比较，符号链接调用亦能命中（与其它 scripts/* 同风格）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) {
    // --no-baseline：忽略基线豁免（用于核查「真实重复」或基线本身是否过期）
    const noBaseline = process.argv.includes('--no-baseline');
    const r = scanIdem(TASKS_DIR, { baseline: noBaseline ? [] : undefined });
    console.log(JSON.stringify(r, null, 2));
    if (r.duplicates.length) {
      console.error(`建卡幂等违例：${r.duplicates.length} 组同 idem 的非终态卡（>1）—— 机械键兜底命中，需人工裁定（LLM 语义判重为主闸）`);
      for (const g of r.duplicates) {
        console.error(`  · ${g.idem}`);
        for (const c of g.cards) console.error(`      ${c.id} [${c.status}] ${c.title}`);
      }
    }
    if (r.exempt.length) {
      console.error(`建卡幂等基线豁免：${r.exempt.length} 组（exempt）—— 既存良性组，登记于 scripts/idem-baseline.json；集合变化即失效`);
      for (const g of r.exempt) {
        console.error(`  · exempt ${g.key}${g.reason ? `（${g.reason}）` : ''}`);
        for (const c of g.cards) console.error(`      ${c.id} [${c.status}] ${c.title}`);
      }
    }
    if (r.duplicates.length) process.exitCode = 1; // 置退出码而非 process.exit：管道 stdout 不截断（调用方需解析 JSON）
  }
} catch { /* realpath 失败 ⇒ 不执行 main */ }
