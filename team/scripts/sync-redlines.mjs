#!/usr/bin/env node
/**
 * sync-redlines.mjs — 把 canonical 红线块 + 开工硬前置 灌入各 AGENTS.md（幂等）
 * canonical：team/guides/redlines.core.md 的 <!-- BEGIN REDLINES:v1 -->…<!-- END --> 块。
 * 用法：node sync-redlines.mjs              # LIVE 模式：安装实例的 workspace-<role>/AGENTS.md
 *       node sync-redlines.mjs --repo <R>   # 仓内模式：重生成 <R>/roles/<role>/AGENTS.md 的块
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 目标面解析：
 *   默认（无 `--repo`）= **LIVE 模式**：canonical 与目标都在安装实例（`~/.openclaw/team`、
 *     `~/.openclaw/workspace-<role>/AGENTS.md`）—— 行为与历史逐字节一致。
 *   `--repo <R>` = **仓内模式**：以仓内 `<R>/team/guides/redlines.core.md` 重生成仓内
 *     `<R>/roles/<role>/AGENTS.md` 的标记块。用途：改红线时不必**手抄** 5 份仓内块
 *     （§⑰ 禁逐字复制；手抄正是「无检查守着、只靠当前恰好一致」的成因）。
 *     仓内无 `roles/simons/`（simons 是 LIVE-only 角色）⇒ 缺目录**跳过**，不是错误。
 * 注意：`--repo` 只改**仓内种子**；LIVE 的 `workspace-<role>/AGENTS.md` 由 install.sh §3 部署，
 *   而 simons 不经 install ⇒ 部署腿仍须在 install 后跑一次 LIVE 模式的本脚本（见 §②.1 落地卡）。
 */
const argv = process.argv.slice(2);
let REPO = '';
for (let i = 0; i < argv.length; i++) if (argv[i] === '--repo' && argv[i + 1]) REPO = path.resolve(argv[++i]);

const HOME = os.homedir();
const TEAM = path.join(HOME, '.openclaw', 'team');
const CORE = REPO ? path.join(REPO, 'team/guides/redlines.core.md') : path.join(TEAM, 'guides/redlines.core.md');
const roleFile = (r) => (REPO ? path.join(REPO, 'roles', r, 'AGENTS.md') : path.join(HOME, `.openclaw/workspace-${r}/AGENTS.md`));
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
  const p = roleFile(r);
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
