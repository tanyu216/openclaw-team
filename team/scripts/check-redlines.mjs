#!/usr/bin/env node
/**
 * check-redlines.mjs — 校验各 AGENTS.md 的标记块 == canonical，且含开工硬前置（防漂移）
 * 退出码：0 全绿；1 有漂移/缺失。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const TEAM = path.join(HOME, '.openclaw', 'team');
const core = fs.readFileSync(path.join(TEAM, 'guides/redlines.core.md'), 'utf8');
const BLOCK = (/<!-- BEGIN REDLINES:v1[\s\S]*?<!-- END REDLINES:v1 -->/.exec(core) || [])[0];
if (!BLOCK) { console.error('canonical 缺标记块'); process.exit(2); }

const roles = ['elon', 'jobs', 'linus', 'turing', 'simons', 'assistant'];
let bad = 0;
for (const r of roles) {
  const p = path.join(HOME, `.openclaw/workspace-${r}/AGENTS.md`);
  if (!fs.existsSync(p)) { console.log(`✗ ${r}: 缺文件`); bad++; continue; }
  const s = fs.readFileSync(p, 'utf8');
  const b = (/<!-- BEGIN REDLINES:v1[\s\S]*?<!-- END REDLINES:v1 -->/.exec(s) || [])[0];
  if (!b) { console.log(`✗ ${r}: 缺红线标记块`); bad++; continue; }
  if (b !== BLOCK) { console.log(`✗ ${r}: 红线块 != canonical（漂移）`); bad++; continue; }
  // 硬前置句：AGENTS.md 已英文化（context 优化），canonical 句为 "Hard prerequisite for starting"；
  // 兼容旧中文「开工硬前置」（过渡/未迁移角色），两者其一即可。
  if (!/开工硬前置|Hard prerequisite for starting/.test(s)) { console.log(`✗ ${r}: 缺开工硬前置`); bad++; continue; }
  console.log(`✔ ${r}`);
}
console.log(bad ? `\n红线校验失败：${bad} 项` : '\n红线校验通过 ✔');
process.exit(bad ? 1 : 0);
