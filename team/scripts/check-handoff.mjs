#!/usr/bin/env node
/**
 * check-handoff.mjs — 「新 seg 背景包」门禁（PROTOCOL §⑥#8）
 * 对卡内每个 running|closed 的 seg，校验 workspace/<task-id>/handoff.md 存在且含四锚。
 * 退出码：0 通过；1 有缺失。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, TASKS_DIR } from './lib.mjs';

const TEAM = path.dirname(TASKS_DIR);
const TASKS = TASKS_DIR;
const ANCHORS = ['HANDOFF:v1', '## 任务卡', '## 上段结论', '## 讨论/决策', 'state.md'];

let bad = 0, checked = 0;
const files = fs.existsSync(TASKS) ? fs.readdirSync(TASKS).filter((f) => f.endsWith('.md')) : [];
for (const f of files) {
  const raw = fs.readFileSync(path.join(TASKS, f), 'utf8');
  const { fm } = parseFrontmatter(raw);
  const id = (fm && fm.id) || f.replace(/\.md$/, '');
  const lines = raw.split('\n');
  const hi = lines.findIndex((l) => l.trim() === '## Sessions');
  if (hi < 0) continue;
  let end = lines.length;
  for (let i = hi + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  const segs = [];
  for (let i = hi + 1; i < end; i++) {
    const m = /- seg:(\S+) ·.*status:(\w+)/.exec(lines[i]);
    if (m && ['running', 'closed'].includes(m[2])) segs.push(m[1]);
  }
  for (const seg of segs) {
    checked++;
    const hp = path.join(TEAM, 'workspace', id, 'handoff.md');
    if (!fs.existsSync(hp)) { console.log(`✗ ${id} seg:${seg} 缺 handoff.md`); bad++; continue; }
    const t = fs.readFileSync(hp, 'utf8');
    const miss = ANCHORS.filter((a) => !t.includes(a));
    if (miss.length) { console.log(`✗ ${id} seg:${seg} handoff 缺锚: ${miss.join(',')}`); bad++; }
  }
}
console.log(bad ? `\nhandoff 校验失败：${bad}/${checked}` : `handoff 校验通过 ✔（${checked} 个 seg）`);
process.exit(bad ? 1 : 0);
