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
// 硬前置句：AGENTS.md 已英文化（context 优化）⇒ canonical 用英文句（与 roles/<role>/AGENTS.md 一致）。
// 旧中文「开工硬前置」行会被就地规范化成该英文句。
const HARD = '> 🚦 **Hard prerequisite for starting**: the **first step of this turn is to read `team/PROTOCOL.md` (at minimum §① Board / §⑬ Hard Discipline + the sections relevant to this role); do not execute or claim any task card until it is read**. After reading, log one line "read PROTOCOL §…" in the card\'s Progress.';
const HARD_RE = /开工硬前置|Hard prerequisite for starting/;

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

  // 2) 开工硬前置：canonical 为英文句；旧中文行就地规范化，缺失则插入（锚点兼容中英两版标题）
  const zhHard = /^> 🚦 \*\*开工硬前置\*\*：.*$/m;
  if (zhHard.test(s)) {
    s = s.replace(zhHard, HARD);
  } else if (!HARD_RE.test(s)) {
    s = s.replace(/^(## 团队与唯一事实源|## Team & Single Source of Truth)/m, HARD + '\n\n$1');
  }

  if (s !== before) { fs.writeFileSync(p, s); n++; console.log('synced:', r); }
}
console.log(`done. roles changed = ${n}`);
