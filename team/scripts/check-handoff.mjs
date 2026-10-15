#!/usr/bin/env node
/**
 * check-handoff.mjs — 「新 seg 背景包」门禁（PROTOCOL §⑥#8）
 *
 * 两类校验（同一四锚口径，ANCHORS 为单一来源；spawn 入口复用 anchorGaps）：
 *   A. 已登记 seg（原口径）：卡内 `## Sessions` 的每个 running|closed seg ⇒
 *      workspace/<task-id>/handoff.md 必须存在且含四锚。
 *   B. 门禁扩面（T-20261010-052210）：status ∈ {in_progress,in_review} 且
 *      workspace/<task-id>/handoff.md **已存在** 的卡 ⇒ 亦校验四锚。
 *      ⇒ 「绕过 ACL 直跑 claude -p，留下手写 handoff」在 seg 登记**前/后**都能被拦
 *      （登记前：B 命中；登记后：A 命中）。
 * 退出码：0 通过；1 有缺失。check-all.sh 按退出码聚合。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, TASKS_DIR } from './lib.mjs';
import { isInFlight } from './status.mjs';

const TEAM = path.dirname(TASKS_DIR);

/** 规范 handoff 的四锚（与 task.handoff 生成物 + spawn-lane 入口自检同口径） */
export const ANCHORS = ['HANDOFF:v1', '## 任务卡', '## 上段结论', '## 讨论/决策', 'state.md'];
// 门禁扩面覆盖的在途状态（handoff 已存在时才判；缺失由 A 类「已登记 seg」负责）：
// 判据现由 `scripts/status.mjs#isInFlight` 单点持有。

/** 四锚缺失清单（空 = 合规）。文本入参，供门禁与 spawn 入口共用，避免口径漂移。 */
export function anchorGaps(text) {
  return ANCHORS.filter((a) => !text.includes(a));
}

/** 解析卡 body 内 `## Sessions` 段的 running|closed seg（行首 `- seg:`） */
export function registeredSegs(raw) {
  const lines = raw.split('\n');
  const hi = lines.findIndex((l) => l.trim() === '## Sessions');
  if (hi < 0) return [];
  let end = lines.length;
  for (let i = hi + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  const segs = [];
  for (let i = hi + 1; i < end; i++) {
    const m = /- seg:(\S+) ·.*status:(\w+)/.exec(lines[i]);
    if (m && ['running', 'closed'].includes(m[2])) segs.push(m[1]);
  }
  return segs;
}

/**
 * 执行 handoff 门禁（只读）。可注入 tasksDir/team 供隔离测试。
 * @returns {{ok:boolean, checked:number, failures:Array<{id:string,seg:string,type:'missing'|'anchors',status?:string,missing?:string[]}>}}
 */
export function checkHandoff({ tasksDir = TASKS_DIR, team = TEAM } = {}) {
  const failures = [];
  let checked = 0;
  const files = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((f) => f.endsWith('.md')) : [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(tasksDir, f), 'utf8');
    const { fm } = parseFrontmatter(raw);
    const id = (fm && fm.id) || f.replace(/\.md$/, '');
    const hp = path.join(team, 'workspace', id, 'handoff.md');
    const exists = fs.existsSync(hp);
    const gapsNow = () => (exists ? anchorGaps(fs.readFileSync(hp, 'utf8')) : null);

    // A. 已登记 seg ⇒ handoff 必须存在且合规
    let segAnchorFailed = false;
    for (const seg of registeredSegs(raw)) {
      checked++;
      if (!exists) { failures.push({ id, seg, type: 'missing' }); continue; }
      const miss = gapsNow();
      if (miss.length) { failures.push({ id, seg, type: 'anchors', missing: miss }); segAnchorFailed = true; }
    }

    // B. 门禁扩面：在途卡且 handoff 已存在 ⇒ 亦须合规（拦「绕过 ACL 直跑 spawn」的手写件）
    if (exists && isInFlight(fm && fm.status)) {
      if (segAnchorFailed) continue; // A 已就同一卡报出缺锚，避免重复
      checked++;
      const miss = gapsNow();
      if (miss.length) failures.push({ id, seg: '', type: 'anchors', status: fm.status, missing: miss });
    }
  }
  return { ok: failures.length === 0, checked, failures };
}

function main() {
  const r = checkHandoff();
  for (const x of r.failures) {
    if (x.type === 'missing') console.log(`✗ ${x.id} seg:${x.seg} 缺 handoff.md`);
    else if (x.seg) console.log(`✗ ${x.id} seg:${x.seg} handoff 缺锚: ${x.missing.join(',')}`);
    else console.log(`✗ ${x.id} handoff 缺锚（status=${x.status}）: ${x.missing.join(',')}`);
  }
  console.log(r.ok ? `handoff 校验通过 ✔（${r.checked} 项）` : `\nhandoff 校验失败：${r.failures.length}/${r.checked}`);
  process.exit(r.ok ? 0 : 1);
}

// main-guard：realpath 归一；被 import（单测/spawn 入口）时不执行 CLI
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
