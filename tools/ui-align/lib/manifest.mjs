/**
 * 页清单（`<manifests>/<page>.json`）载入 + schema 校验 + 断言归一化。
 *
 * 清单 schema（跨项目通用；trader 既有 9 份清单逐字兼容）：
 * {
 *   "page": "overview",                     // 与文件名一致（载入时自检）
 *   "name": "总览页",
 *   "route": "/overview",                   // 拼到 implBaseUrl 后
 *   "widths": [1512, 1240, 980, 760, 430],  // 缺省取配置 viewports
 *   "height": 900,
 *   "overflowTargets": [{ "selector": "html", "desc": "文档根" }],
 *   "console": { "allowlist": [{ "pattern": "favicon", "reason": "…", "evidence": "…" }] },
 *   "styleTargets": [{ "name": "topbar", "selector": ".topbar" }],   // 可选：computed style 对比目标
 *   "blocks": [{
 *     "id": "hero", "name": "Hero 大卡",
 *     "evidence": "prototype/pages/overview.html:41 <section class=\"hero card\">",
 *     "status": "delivered",                // delivered（缺省）| pending（记 SKIP；--strict 升级为失败）
 *     "checks": [
 *       { "selector": "section.hero.card", "desc": "Hero 卡在位" },   // 缺省 min:1 = 存在
 *       { "selector": "#heroChart", "nonEmpty": true },
 *       { "selector": ".card.mini", "count": 3 },
 *       { "selector": ".ov-kpi", "count": 0 },
 *       { "scope": ".pf-group", "selector": "thead th", "count": 9 }
 *     ]
 *   }]
 * }
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function loadManifest(manifestDir, page, config) {
  const file = join(manifestDir, `${page}.json`)
  if (!existsSync(file)) throw new Error(`清单不存在：${file}`)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`清单不是合法 JSON：${file}\n  ${e.message}`)
  }

  const problems = []
  if (raw.page !== page) problems.push(`"page" 应为 "${page}"，实际 ${JSON.stringify(raw.page)}`)
  if (!Array.isArray(raw.blocks) || raw.blocks.length === 0) problems.push('"blocks" 必须是非空数组')
  for (const [i, b] of (raw.blocks ?? []).entries()) {
    if (!b.id) problems.push(`blocks[${i}] 缺 "id"`)
    if (!b.name) problems.push(`blocks[${i}] 缺 "name"（${b.id ?? i}）`)
    if (!b.evidence) problems.push(`block "${b.id ?? i}" 缺 "evidence"（SOP §6.1：每条差异须有文件+行号+选择器）`)
    if (!Array.isArray(b.checks) || b.checks.length === 0) problems.push(`block "${b.id ?? i}" 的 "checks" 必须是非空数组`)
    for (const c of b.checks ?? []) {
      if (!c.selector) problems.push(`block "${b.id}" 有 check 缺 "selector"`)
      const bounds = ['count', 'min', 'max'].filter((k) => typeof c[k] === 'number')
      if (bounds.length > 1) problems.push(`block "${b.id}" 的 check(${c.selector}) 同时给了 ${bounds.join('/')}，只能给一个`)
      if (c.count !== undefined && !Number.isInteger(c.count)) problems.push(`block "${b.id}" 的 check(${c.selector}) "count" 必须是整数`)
    }
  }
  if (problems.length) throw new Error(`清单校验未过：${file}\n  - ${problems.join('\n  - ')}`)

  raw.widths = raw.widths?.length ? raw.widths : config.viewports
  raw.height ??= config.height
  raw.overflowTargets ??= [
    { selector: 'html', desc: '文档根' },
    { selector: 'body', desc: '文档体' },
  ]
  raw.console ??= {}
  raw.console.allowlist ??= []
  return { manifest: raw, file }
}

/** 断言期望的可读表述（报告用）。 */
export function expectText(c) {
  const parts = []
  if (c.count !== undefined) parts.push(`count == ${c.count}`)
  if (c.min !== undefined) parts.push(`count >= ${c.min}`)
  if (c.max !== undefined) parts.push(`count <= ${c.max}`)
  if (c.nonEmpty) parts.push('非空')
  return parts.join(' · ')
}

/** 归一化：只补一条缺省界（min:1 = 「存在」），**不补 count** —— 补 count 会让同一条出两条失败原因
 *  （`期望 1；期望 >=1`），且把「至少 1 个」误收紧成「恰好 1 个」。scope / selector 原样下发给浏览器。 */
export function normalizeChecks(block) {
  return block.checks.map((c, i) => {
    const hasBound = ['count', 'min', 'max'].some((k) => typeof c[k] === 'number')
    const n = {
      id: `${block.id}#${i}`,
      scope: c.scope ?? null,
      selector: c.selector,
      count: hasBound ? c.count : undefined,
      min: hasBound ? c.min : 1,
      max: hasBound ? c.max : undefined,
      nonEmpty: !!c.nonEmpty,
      desc: c.desc ?? '',
    }
    return { ...n, expect: expectText(n) }
  })
}

/** 页级 + 项目级 styleTargets 合并（页级优先，同名去重）。
 *  两处均可写：`styleTargets`（裸数组）或 `style.targets`（带 note 的分组写法）。 */
export function mergeStyleTargets(config, manifest) {
  const out = new Map()
  const list = [
    ...config.styleTargets,
    ...(manifest.styleTargets ?? []),
    ...(manifest.style?.targets ?? []),
  ]
  for (const t of list) {
    if (t?.selector) out.set(t.name ?? t.selector, { name: t.name ?? t.selector, selector: t.selector })
  }
  return [...out.values()]
}
