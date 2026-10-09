#!/usr/bin/env node
/**
 * sync-redlines.mjs — 把 canonical 红线块 + 开工硬前置 灌入各 AGENTS.md（幂等）
 * canonical：team/guides/redlines.core.md 的 <!-- BEGIN REDLINES:v1 -->…<!-- END --> 块。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const TEAM = path.join(HOME, '.openclaw', 'team');
const CORE = path.join(TEAM, 'guides/redlines.core.md');
const core = fs.readFileSync(CORE, 'utf8');
const m = /<!-- BEGIN REDLINES:v1[\s\S]*?<!-- END REDLINES:v1 -->/.exec(core);
if (!m) { console.error('canonical 缺 REDLINES:v1 标记块'); process.exit(2); }
const BLOCK = m[0];
const HARD = '> 🚦 **开工硬前置**：本回合**第一步必读 `team/PROTOCOL.md`（至少 §① 看板 / §⑬ 硬纪律 + 本岗相关 §）；未读不得执行、不得领取任务卡**。读毕在卡 Progress 记一行「已读 PROTOCOL §…」。';

const roles = ['elon', 'jobs', 'linus', 'turing', 'simons', 'assistant'];
let n = 0;
for (const r of roles) {
  const p = path.join(HOME, `.openclaw/workspace-${r}/AGENTS.md`);
  if (!fs.existsSync(p)) { console.warn('skip(no file):', r); continue; }
  let s = fs.readFileSync(p, 'utf8');
  const before = s;

  // 1) 红线块
  if (/<!-- BEGIN REDLINES:v1/.test(s)) {
    s = s.replace(/<!-- BEGIN REDLINES:v1[\s\S]*?<!-- END REDLINES:v1 -->/, BLOCK);
  } else if (/^> 🚨 \*\*硬纪律（引 `PROTOCOL §⑬`/m.test(s)) {
    s = s.replace(/^> 🚨 \*\*硬纪律（引 `PROTOCOL §⑬`[\s\S]*?(?=\n\n)/m, BLOCK);
  } else {
    s = s.replace(/^(## 消息来源判定)/m, BLOCK + '\n\n$1');
  }

  // 2) 开工硬前置
  if (!/开工硬前置/.test(s)) {
    s = s.replace(/^(## 团队与唯一事实源)/m, HARD + '\n\n$1');
  }

  if (s !== before) { fs.writeFileSync(p, s); n++; console.log('synced:', r); }
}
console.log(`done. roles changed = ${n}`);
