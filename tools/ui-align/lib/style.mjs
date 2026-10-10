/**
 * computed style 双侧 diff（纯函数，便于复核）。
 *
 * 口径（与 Elon 的 PoC 逐条一致，便于结果可对照）：
 *   · 逐目标 × 逐属性断言；`checks += 属性数`，值不等则 `diffs++`。
 *   · **实现侧缺元素** ⇒ 记 1 条 diff（「该有的没有」本身就是还原缺陷），不计属性断言。
 *   · **原型侧缺元素** ⇒ 整条跳过（原型没有的东西不构成还原义务）。
 *   · 盒尺寸差异单独列出，不计入 checks/diffs（尺寸由 width/height 属性断言覆盖）。
 * 一致率 = 1 - diffs / checks。
 */

export function judgeStyle({ impl, proto, props, targets, width }) {
  const byName = (r) => Object.fromEntries((r?.targets ?? []).map((d) => [d.name, d]))
  const iM = byName(impl)
  const pM = byName(proto)

  let checks = 0
  let diffs = 0
  const rows = []
  const propTally = new Map()

  for (const t of targets) {
    const i = iM[t.name]
    const p = pM[t.name]
    const row = { name: t.name, selector: t.selector, status: 'compared', dims: [], box: null }

    if (!i || i.missing) {
      row.status = 'missing-impl'
      diffs++
      rows.push(row)
      continue
    }
    if (!p || p.missing) {
      row.status = 'missing-proto'
      rows.push(row)
      continue
    }
    for (const prop of props) {
      checks++
      const a = i.style[prop]
      const b = p.style[prop]
      if (a !== b) {
        diffs++
        row.dims.push({ prop, proto: b, impl: a })
        propTally.set(prop, (propTally.get(prop) ?? 0) + 1)
      }
    }
    row.box = { impl: i.box, proto: p.box, same: i.box.w === p.box.w && i.box.h === p.box.h }
    rows.push(row)
  }

  return {
    width,
    theme: { impl: impl?.theme ?? null, proto: proto?.theme ?? null },
    lang: { impl: impl?.lang ?? null, proto: proto?.lang ?? null },
    targets: rows,
    totals: { checks, diffs, rate: checks ? 1 - diffs / checks : 0 },
    propRanking: [...propTally.entries()].sort((a, b) => b[1] - a[1]).map(([prop, n]) => ({ prop, n })),
  }
}

/** 多档结果汇总（口径：逐档相加 ⇒ 总一致率按断言数加权）。 */
export function sumStyle(perWidth, props, targets) {
  const checks = perWidth.reduce((n, r) => n + r.totals.checks, 0)
  const diffs = perWidth.reduce((n, r) => n + r.totals.diffs, 0)
  const implMissing = perWidth.flatMap((r) => r.targets.filter((t) => t.status === 'missing-impl'))
  const protoMissing = perWidth.flatMap((r) => r.targets.filter((t) => t.status === 'missing-proto'))
  const totals = {
    props: props.length,
    targets: targets.length,
    widths: perWidth.map((r) => r.width),
    checks,
    diffs,
    rate: checks ? 1 - diffs / checks : 0,
    implMissing,
    protoMissing,
  }
  return { ...totals, totals, pass: diffs === 0 }
}
