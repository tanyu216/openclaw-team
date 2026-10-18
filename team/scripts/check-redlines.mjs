#!/usr/bin/env node
/**
 * check-redlines.mjs — 校验各 AGENTS.md 的标记块 == canonical（防漂移）
 * 退出码：0 全绿；1 有漂移/缺失；2 用法错或模式不可判定。
 * 模式（判定见 host-paths.mjs）：实例在场 ⇒ **live**（默认，行为与历史一致，读
 *   `<home>/workspace-<role>/AGENTS.md` + `<team>/guides/redlines.core.md`）；
 *   否则 ⇒ **repo**：校验**仓内种子** `<repo>/roles/<role>/AGENTS.md`，canonical 取
 *   `<repo>/team/guides/redlines.core.md` —— 不需要本机装任何实例。
 * 用法：node check-redlines.mjs [--repo <R> | --live]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROLES, resolveMode, UsageError } from './host-paths.mjs';

let M;
try { M = resolveMode(); } catch (e) {
  if (e instanceof UsageError) { console.error(`✗ ${e.message}`); process.exit(2); }
  throw e;
}
const shrink = (p) => p.replace(M.home, '~').replace(M.repo, '<repo>');
const core = fs.readFileSync(M.mode === 'repo'
  ? path.join(M.repo, 'team/guides/redlines.core.md')
  : path.join(M.team, 'guides/redlines.core.md'), 'utf8');
const BLOCK = (/<!-- BEGIN REDLINES:v1[\s\S]*?<!-- END REDLINES:v1 -->/.exec(core) || [])[0];
if (!BLOCK) { console.error(`canonical 缺标记块（${M.mode} 模式）`); process.exit(2); }

const roleFile = (r) => (M.mode === 'repo'
  ? path.join(M.repo, 'roles', r, 'AGENTS.md')
  : path.join(M.home, `workspace-${r}`, 'AGENTS.md'));
let bad = 0;
for (const r of ROLES) {
  const p = roleFile(r);
  if (!fs.existsSync(p)) { console.log(`✗ ${r}: 缺文件（${shrink(p)}）`); bad++; continue; }
  const s = fs.readFileSync(p, 'utf8');
  const b = (/<!-- BEGIN REDLINES:v1[\s\S]*?<!-- END REDLINES:v1 -->/.exec(s) || [])[0];
  if (!b) { console.log(`✗ ${r}: 缺红线标记块`); bad++; continue; }
  if (b !== BLOCK) { console.log(`✗ ${r}: 红线块 != canonical（漂移）`); bad++; continue; }
  console.log(`✔ ${r}`);
}
console.log(bad ? `\n红线校验失败：${bad} 项（${M.mode} 模式）` : `\n红线校验通过 ✔（${M.mode} 模式）`);
process.exit(bad ? 1 : 0);
