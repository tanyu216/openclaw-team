#!/usr/bin/env node
/**
 * sync-redlines.mjs — 把 canonical 红线块灌入各 AGENTS.md（幂等）
 * canonical：`<doc root>/guides/redlines.core.md` 的 <!-- BEGIN REDLINES:v1 -->…<!-- END --> 块。
 * 用法：node sync-redlines.mjs              # LIVE 模式：安装实例的 workspace-<role>/AGENTS.md
 *       node sync-redlines.mjs --repo <R>   # 仓内模式：重生成 <R>/roles/<role>/AGENTS.md 的块
 *
 * 目标面解析（root 一律解析自 host-paths.mjs ⇒ OPENCLAW_TEAM_ROOT / OPENCLAW_HOME 都生效）：
 *   默认（无 `--repo`）= **LIVE 模式**：canonical 与目标都在安装实例 —— 行为与历史逐字节一致。
 *   `--repo <R>` = **仓内模式**：以仓内 `<R>/team/guides/redlines.core.md` 重生成仓内
 *     `<R>/roles/<role>/AGENTS.md` 的标记块。用途：改红线时不必**手抄** 5 份仓内块
 *     （§⑰ 禁逐字复制；手抄正是「无检查守着、只靠当前恰好一致」的成因）。
 * 本脚本是**写者**：仓内模式只认**显式** `--repo`，绝不按 host-paths#resolveMode 的自动判定去写仓。
 * 目标文件缺失 ⇒ 跳过（`skip(no file)`），不是错误 —— 仓与实例各自可能只带部分角色。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROLES, teamRoot, openclawHome, parseArgs } from './host-paths.mjs';

const { repo: REPO } = parseArgs();
const TEAM = teamRoot();
const OC_HOME = openclawHome();
const CORE = REPO ? path.join(REPO, 'team/guides/redlines.core.md') : path.join(TEAM, 'guides/redlines.core.md');
const roleFile = (r) => (REPO ? path.join(REPO, 'roles', r, 'AGENTS.md') : path.join(OC_HOME, `workspace-${r}`, 'AGENTS.md'));
const core = fs.readFileSync(CORE, 'utf8');
const m = /<!-- BEGIN REDLINES:v1[\s\S]*?<!-- END REDLINES:v1 -->/.exec(core);
if (!m) { console.error('canonical 缺 REDLINES:v1 标记块'); process.exit(2); }
const BLOCK = m[0];

let n = 0;
let bad = 0;
for (const r of ROLES) {
  const p = roleFile(r);
  if (!fs.existsSync(p)) { console.warn('skip(no file):', r); continue; }
  let s = fs.readFileSync(p, 'utf8');
  const before = s;

  // 红线块：标记必须已存在（seeds 与安装实例都带）；缺失是结构错误，不再按旧标题猜锚点。
  if (!/<!-- BEGIN REDLINES:v1/.test(s)) {
    console.error(`✗ ${r}: 缺 REDLINES:v1 标记块（先手工放入一次）`);
    bad++;
    continue;
  }
  s = s.replace(/<!-- BEGIN REDLINES:v1[\s\S]*?<!-- END REDLINES:v1 -->/, BLOCK);

  if (s !== before) { fs.writeFileSync(p, s); n++; console.log('synced:', r); }
}
console.log(`done. roles changed = ${n}${bad ? `, failed = ${bad}` : ''}`);
process.exit(bad ? 1 : 0);
