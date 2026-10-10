/**
 * 报告输出：人读（text，逐区块/逐断言上屏）+ 机读（--json，供 CI）。
 * 文字版保留 trader 既有排版（下游习惯逐行读），新增 [computed style] 段。
 */

const MARK = { ok: 'PASS', bad: 'FAIL', skip: 'SKIP' }
const pct = (r) => `${(r * 100).toFixed(1)}%`

/* 控制字符用显式转义构造，避免源码里出现裸控制字节（编辑器/工具链都会被它噎到）。 */
const RE_OSC = new RegExp('\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)', 'g') // ESC ] … BEL / ST
const RE_ESC = new RegExp('\x1b[[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]', 'g') // CSI 等
const RE_C0 = new RegExp('[\x00-\x08\x0b-\x1f\x7f]', 'g') // C0 + DEL（保留 \n \t）

/** 页面来源文本进终端前清洗：剥 ANSI 转义序列 + 其余控制字符。
 *  console 文本 / 异常堆栈 / URL 都来自**被测页面**（不受本工具控制）——不清洗就是终端注入面
 *  （伪造上报行、改标题、藏光标）。只作用于**文本报告**；`--json` 保留原值以免丢信息。 */
export function sanitize(s) {
  return String(s ?? '').replace(RE_OSC, '').replace(RE_ESC, '').replace(RE_C0, '')
}

export function printHuman(r, { exitPass, exitFail, styleBlocking }) {
  const w = process.stdout.write.bind(process.stdout)
  w(`\nui-align check — ${sanitize(r.name)}（${sanitize(r.page)}）\n`)
  w(`  清单   ${sanitize(r.manifest)}\n`)
  w(`  目标   ${sanitize(r.target)}\n`)
  w(`  档位   ${r.widths.join(' / ')}   （html lang=${sanitize(r.htmlLang)}）\n`)

  for (const b of r.blocks) {
    const tag = b.skip ? MARK.skip : b.ok ? MARK.ok : MARK.bad
    w(`\n[${tag}] ${sanitize(b.block.id)} · ${sanitize(b.block.name)}${b.skip ? `（未实现：${sanitize(b.block.pendingWhy ?? '—')}）` : ''}\n`)
    w(`       证据 ${sanitize(b.block.evidence)}\n`)
    if (b.skip) continue
    for (const row of b.rows) {
      const c = row.check
      /* 实测命中数上屏（全档一致只写一个）：PASS 行也要可审计 —— 否则「全绿」可能只是断言空转。 */
      const hits = row.widths.map((x) => x.count)
      const hit = hits.every((n) => n === hits[0]) ? `${hits[0]}` : hits.join('/')
      const head = `  ${row.ok ? '·' : '✗'} ${sanitize(c.selector)}${c.scope ? `   （scope ${sanitize(c.scope)}）` : ''}`
      w(`${head.padEnd(58)}${c.expect} · 命中 ${hit}${c.desc ? `   ${sanitize(c.desc)}` : ''}\n`)
      if (!row.ok) {
        for (const x of row.widths.filter((x) => !x.ok)) w(`      ↳ ${x.width}px: ${sanitize(x.why.join('；'))}\n`)
      }
    }
  }

  w(`\n[五档无溢出] scrollWidth <= clientWidth\n`)
  for (const o of r.overflow) {
    const ok = o.rows.every((x) => x.ok)
    w(`  ${ok ? '·' : '✗'} ${sanitize(o.target.selector)}${o.target.desc ? `（${sanitize(o.target.desc)}）` : ''}\n`)
    if (!ok) for (const x of o.rows.filter((x) => !x.ok)) w(`      ↳ ${x.width}px: ${sanitize(x.why)}\n`)
  }
  w(`    每档实测：${r.overflow.flatMap((o) => o.rows).filter((x) => x.ok).length}/${r.overflow.length * r.widths.length} 通过\n`)

  w(`\n[console errors == []]\n`)
  for (const c of r.console) {
    w(`  ${c.errors.length === 0 ? '·' : '✗'} ${c.width}px：${c.errors.length} 条${c.muted.length ? `（另有白名单内 ${c.muted.length} 条已过滤）` : ''}\n`)
    for (const e of c.errors) {
      w(`      ↳ [${sanitize(e.from)}] ${sanitize(e.text).split('\n')[0]}${e.at ? `  @ ${sanitize(e.at)}` : ''}\n`)
    }
  }
  if (r.allowlist.length) {
    w(`    白名单（白名单外 = 缺陷，口径同原型侧 _console-whitelist）：\n`)
    for (const a of r.allowlist) {
      w(`      · "${sanitize(a.pattern)}" —— ${sanitize(a.reason)}${a.evidence ? `（证据：${sanitize(a.evidence)}）` : ''}\n`)
    }
  }

  if (r.style) printStyle(w, r.style, styleBlocking)

  if (r.notReady.length) w(`\n[!] 就绪选择器超时的档位：${r.notReady.map((x) => `${x.width}px`).join(' / ')}（断言已如实执行）\n`)

  const t = r.totals
  w(`\n── 汇总 ──\n`)
  w(`  区块 ${t.blocks}（断言 ${t.asserted} ｜ 待实现 ${t.skipped}）· 断言 ${t.checks} 条 · 失败 ${t.failedChecks}\n`)
  w(`  溢出档位失败 ${t.overflowFailures} ｜ console 失败档位 ${t.consoleFailures}\n`)
  if (r.style) {
    w(`  computed style 差异 ${r.style.totals.diffs} / 断言 ${r.style.totals.checks}（一致率 ${pct(r.style.totals.rate)}）`)
    w(styleBlocking ? '  ← --style-strict，计入退出码\n' : '  ← 非阻塞（配 --style-strict 可升级为失败）\n')
  }
  if (t.skipped) {
    const names = r.blocks.filter((b) => b.skip).map((b) => b.block.id).join('、')
    w(`  待实现（SKIP，不计入失败）：${sanitize(names)}${r.strict ? '' : '   ← --strict 可升级为失败'}\n`)
  }
  w(`\n${r.pass ? 'PASS' : 'FAIL'} —— 退出码 ${r.pass ? exitPass : exitFail}\n`)
}

function printStyle(w, s, blocking) {
  w(`\n[computed style] 原型 vs 实现（同 theme=${sanitize(s.theme.impl) || '—'} / lang=${sanitize(s.lang.impl) || '—'}）\n`)
  const mismatched = []
  if ((s.theme.impl ?? null) !== (s.theme.proto ?? null)) mismatched.push(`theme：原型 ${sanitize(s.theme.proto) || '—'} ≠ 实现 ${sanitize(s.theme.impl) || '—'}`)
  if ((s.lang.impl ?? null) !== (s.lang.proto ?? null)) mismatched.push(`lang：原型 ${sanitize(s.lang.proto) || '—'} ≠ 实现 ${sanitize(s.lang.impl) || '—'}`)
  if (mismatched.length) {
    w(`  ⚠️ 双侧口径未对齐（差异不可信，先修配置）：\n`)
    for (const m of mismatched) w(`      ↳ ${m}\n`)
  }
  for (const wd of s.perWidth) {
    w(`  ── ${wd.width}px（${wd.totals.checks} 断言 · 不一致 ${wd.totals.diffs} · 一致率 ${pct(wd.totals.rate)}）\n`)
    for (const t of wd.targets) {
      const sel = `\`${sanitize(t.selector)}\``
      if (t.status === 'missing-impl') {
        w(`    ✗ ${sanitize(t.name).padEnd(14)} ${sel} 实现侧缺失（选择器无命中）\n`)
        continue
      }
      if (t.status === 'missing-proto') {
        w(`    – ${sanitize(t.name).padEnd(14)} ${sel} 原型侧缺失 ⇒ 跳过（不计入一致率）\n`)
        continue
      }
      const box = t.box ? (t.box.same ? `尺寸一致 ${t.box.impl.w}×${t.box.impl.h}` : `尺寸 原型 ${t.box.proto.w}×${t.box.proto.h} / 实现 ${t.box.impl.w}×${t.box.impl.h}`) : ''
      w(`    ${t.dims.length ? '✗' : '·'} ${sanitize(t.name).padEnd(14)} ${sel} ${t.dims.length ? `差异 ${t.dims.length} 项` : '全一致'}   ${box}\n`)
      for (const d of t.dims) w(`        ${sanitize(d.prop).padEnd(16)} 原型 \`${sanitize(d.proto)}\`  →  实现 \`${sanitize(d.impl)}\`\n`)
    }
    if (wd.propRanking.length) {
      w(`    高频差异属性：${wd.propRanking.slice(0, 8).map((p) => `${sanitize(p.prop)}×${p.n}`).join(' · ')}\n`)
    }
  }
  w(`  汇总：${s.totals.widths.length} 档 · 断言 ${s.totals.checks} · 不一致 ${s.totals.diffs} · 一致率 ${pct(s.totals.rate)}`)
  w(`${blocking ? '  ← 计入退出码' : '  ← 非阻塞'}\n`)
}
