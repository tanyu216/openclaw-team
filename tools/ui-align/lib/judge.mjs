/**
 * DOM 判定（纯函数，便于单测/复核）：逐档原始探针数据 → 报告对象。
 * 判定口径与 trader 既有 `ui-align-check.mjs` 逐条一致（该脚本的输出被下游解析，不能漂）。
 */

/** console 白名单匹配：`text + url` 小写包含 pattern 即放行（口径同 prototype/pages/_console-whitelist.md）。 */
export function isAllowedError(e, allow) {
  return allow.some((a) => `${e.text} ${e.url}`.toLowerCase().includes(String(a.pattern).toLowerCase()))
}

export function judge({ manifest, blocks, perWidth, widths, rendered, target, file, style, opts }) {
  const allow = manifest.console.allowlist ?? []
  const isAllowed = (e) => isAllowedError(e, allow)

  const blockResults = blocks.map((b) => {
    const pending = (b.status ?? 'delivered') === 'pending'
    const skip = pending && !opts.strict
    const rows = []
    for (const c of b.norm) {
      const perWidthRow = perWidth.map((w) => {
        const r = w.probe.checks.find((x) => x.id === c.id) ?? { error: '探针缺该条结果' }
        let ok = true
        const why = []
        if (r.error) {
          ok = false
          why.push(`选择器非法：${r.error}`)
        } else {
          if (r.scopeMissing) {
            ok = false
            why.push(`scope 未命中：${c.scope}`)
          }
          if (c.count !== undefined && r.count !== c.count) {
            ok = false
            why.push(`count=${r.count}，期望 ${c.count}`)
          }
          if (c.min !== undefined && r.count < c.min) {
            ok = false
            why.push(`count=${r.count}，期望 >=${c.min}`)
          }
          if (c.max !== undefined && r.count > c.max) {
            ok = false
            why.push(`count=${r.count}，期望 <=${c.max}`)
          }
          if (c.nonEmpty && r.emptyAt !== null) {
            ok = false
            why.push(`第 ${r.emptyAt + 1} 个命中为空（无子元素且无文本）`)
          }
        }
        return { width: w.width, ok, why, count: r.count ?? null }
      })
      rows.push({ check: c, widths: perWidthRow, ok: perWidthRow.every((r) => r.ok) })
    }
    return { block: b, pending, skip, rows, ok: rows.every((r) => r.ok) }
  })

  const overflow = manifest.overflowTargets.map((t) => ({
    target: t,
    rows: perWidth.map((w) => {
      const r = w.probe.overflow.find((x) => x.selector === t.selector)
      if (!r || r.missing) return { width: w.width, ok: false, why: `目标不存在：${t.selector}` }
      const over = r.scrollWidth - r.clientWidth
      return {
        width: w.width,
        ok: over <= 0,
        why: over > 0 ? `溢出 ${over}px（scrollWidth ${r.scrollWidth} > clientWidth ${r.clientWidth}）` : '',
        scrollWidth: r.scrollWidth,
        clientWidth: r.clientWidth,
      }
    }),
  }))

  const consoleRows = perWidth.map((w) => {
    const bad = w.errors.filter((e) => !isAllowed(e))
    const muted = w.errors.filter(isAllowed)
    return { width: w.width, errors: bad, muted }
  })

  const asserted = blockResults.filter((b) => !b.skip)
  const failedChecks = asserted.flatMap((b) => b.rows.filter((r) => !r.ok))
  const overflowFailed = overflow.flatMap((o) => o.rows.filter((r) => !r.ok))
  const consoleFailed = consoleRows.filter((c) => c.errors.length > 0)
  const notReady = perWidth.filter((w) => w.ready === false)

  /* --strict 时 pending 块不 skip ⇒ 其失败已计入 failedChecks，无需额外判据。
     computed style 差异**默认不参与退出码**（见 opts.styleStrict）：新能力先上屏观察，
     否则等于用一次工具升级把下游 CI 一次性判红。 */
  const styleFailed = opts.styleStrict ? (style?.totals?.diffs ?? 0) > 0 : false
  const pass = failedChecks.length === 0 && overflowFailed.length === 0 && consoleFailed.length === 0 && !styleFailed

  return {
    page: manifest.page,
    strict: opts.strict,
    name: manifest.name ?? manifest.page,
    manifest: file,
    target,
    widths,
    htmlLang: rendered.lang,
    viewportLangs: perWidth.map((w) => w.probe.lang),
    blocks: blockResults,
    overflow,
    console: consoleRows,
    allowlist: allow,
    notReady,
    style: style ?? null,
    pass,
    totals: {
      blocks: blockResults.length,
      asserted: asserted.length,
      skipped: blockResults.length - asserted.length,
      checks: asserted.reduce((n, b) => n + b.rows.length, 0),
      failedChecks: failedChecks.length,
      overflowFailures: overflowFailed.length,
      consoleFailures: consoleFailed.length,
    },
  }
}
