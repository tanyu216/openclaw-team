#!/usr/bin/env node
/**
 * ui-align —— **跨项目** UI 还原度机检工具（原型 vs 实现）。
 *
 * 为什么存在：「看起来不一致」不是可判定的验收条件。本工具把清单里每条验收点落成
 * 可直接断言的 DOM / computed style 条件，失败即非 0 退出（CI / 门禁可挂）。
 * 五种能力：① 多视口 DOM 断言 ② 五档无溢出 ③ console 白名单 ④ **computed style 双侧 diff** ⑤ text/json 报告。
 *
 * 用法：
 *   node <本目录>/check.mjs --config <project>/.ui-align.json [page] [选项]
 *
 * 选项：
 *   --config <file>   项目配置（**必填**；所有项目知识都在这里，引擎内零硬编码）
 *   --url <url>       断言既有服务（跳过 devServer 自举）
 *   --browser <path>  指定浏览器可执行文件（覆盖自动发现）
 *   --strict          pending 区块也当失败（对齐完成后翻档用）
 *   --json            机器可读输出（CI）
 *   --widths a,b,c    覆盖清单档位
 *   --style           强制跑 computed style 对比
 *   --no-style        强制不跑
 *   --style-strict    computed style 差异计入退出码（缺省只上屏、不判失败）
 *   --style-widths a,b  覆盖样式对比档位（缺省取第一档）
 *   --keep-open       跑完不关浏览器/服务（排查用；打印 pid，**需自行收掉**）
 *   --help
 *
 * 退出码：0 全过 ｜ 1 有断言失败 ｜ 2 环境或配置/清单错误（无浏览器 / 配置缺失 / 服务起不来）
 *
 * 依赖：**零 npm 依赖** —— Node ≥22 内置 `WebSocket` 直连 Chrome DevTools Protocol。
 * 浏览器自动发现：本机 Chrome / Chromium / Edge，退化到 Playwright 浏览器缓存（按 revision 取最新）。
 */
import { rmSync } from 'node:fs'

import { loadConfig, prototypePathFor } from './lib/config.mjs'
import { loadManifest, mergeStyleTargets, normalizeChecks } from './lib/manifest.mjs'
import { evaluate, launchBrowser, attachPage, poll, resolveBrowser } from './lib/browser.mjs'
import { startDevServer, startStaticServer } from './lib/devserver.mjs'
import { buildApplyExpr, buildDomProbe, buildPrefsScript, buildStyleProbe } from './lib/probe.mjs'
import { judgeStyle, sumStyle } from './lib/style.mjs'
import { judge } from './lib/judge.mjs'
import { printHuman } from './lib/report.mjs'

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_BLOCKED = 2

const HELP = `用法：node check.mjs --config <project>/.ui-align.json [page] [选项]

  page               清单名（<manifests>/<page>.json），缺省 overview
  --config <file>    项目配置（必填）
  --url <url>        断言既有服务（跳过 devServer 自举）
  --browser <path>   指定浏览器可执行文件
  --strict           pending 区块也当失败
  --json             机器可读输出
  --widths a,b,c     覆盖清单档位
  --style / --no-style        强制开关 computed style 对比
  --style-strict     style 差异计入退出码
  --style-widths a,b 覆盖样式对比档位
  --keep-open        跑完不关浏览器/服务（自行收 pid）
  --help

退出码：0 全过 ｜ 1 断言失败 ｜ 2 环境/配置/清单错误`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const opts = {
    page: 'overview', config: null, url: null, browser: null, strict: false, json: false,
    widths: null, style: null, styleStrict: false, styleWidths: null, keepOpen: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    else if (a === '--config') opts.config = argv[++i]
    else if (a === '--url') opts.url = argv[++i]
    else if (a === '--browser') opts.browser = argv[++i]
    else if (a === '--strict') opts.strict = true
    else if (a === '--json') opts.json = true
    else if (a === '--style') opts.style = true
    else if (a === '--no-style') opts.style = false
    else if (a === '--style-strict') opts.styleStrict = true
    else if (a === '--keep-open') opts.keepOpen = true
    else if (a === '--widths') opts.widths = argv[++i].split(',').map((n) => Number(n.trim())).filter(Number.isFinite)
    else if (a === '--style-widths') opts.styleWidths = argv[++i].split(',').map((n) => Number(n.trim())).filter(Number.isFinite)
    else if (a.startsWith('-')) throw new Error(`未知选项：${a}`)
    else opts.page = a
  }
  if (opts.url) opts.url = opts.url.replace(/\/+$/, '')
  return opts
}

/** console 报错收集（CDP 事件 → sink）。 */
function describeArg(a) {
  if (!a) return ''
  if (a.type === 'string') return a.value
  if ('value' in a) return typeof a.value === 'object' ? safeJson(a.value) : String(a.value)
  return a.description ?? a.unserializableValue ?? a.type
}
function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function attachConsoleCollector(cdp, sink) {
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'assert') return
    sink.push({
      from: 'console',
      level: p.type,
      text: (p.args ?? []).map(describeArg).join(' '),
      url: p.stackTrace?.callFrames?.[0]?.url ?? '',
      at: p.stackTrace?.callFrames?.[0]
        ? `${p.stackTrace.callFrames[0].url}:${p.stackTrace.callFrames[0].lineNumber + 1}:${p.stackTrace.callFrames[0].columnNumber + 1}`
        : '',
    })
  })
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails ?? {}
    sink.push({
      from: 'exception',
      level: 'error',
      text: d.exception?.description ?? d.text ?? '(无描述)',
      url: d.url ?? '',
      at: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}` : '',
    })
  })
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry ?? {}
    if (e.level !== 'error') return
    sink.push({
      from: `log/${e.source ?? '?'}`,
      level: 'error',
      text: e.text ?? '',
      url: e.url ?? '',
      at: e.url ? `${e.url}:${(e.lineNumber ?? 0) + 1}` : '',
    })
  })
}

/** 导航到 url 并等 load（+ 可选就绪选择器轮询）。返回 `{ready}`。 */
async function goto(cdp, url, { width, height, readySelector, settleMs }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  const loaded = cdp.once('Page.loadEventFired', 20_000)
  await cdp.send('Page.navigate', { url })
  await loaded
  let ready = null
  if (readySelector) {
    ready = await poll(async () => (await evaluate(cdp, `!!document.querySelector(${JSON.stringify(readySelector)})`)) === true, {
      timeout: 15_000,
      interval: 120,
    })
  }
  await sleep(settleMs)
  return { ready }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(`${HELP}\n`)
    return EXIT_PASS
  }

  const config = loadConfig(opts.config)
  const { manifest, file } = loadManifest(config.manifests, opts.page, config)
  const widths = opts.widths?.length ? opts.widths : manifest.widths
  const blocks = manifest.blocks.map((b) => ({ ...b, norm: normalizeChecks(b) }))
  const allChecks = blocks.flatMap((b) => b.norm)

  const styleTargets = mergeStyleTargets(config, manifest)
  const styleEnabled = opts.style ?? config.style.enabled ?? true
  const styleWidths = (opts.styleWidths?.length ? opts.styleWidths : config.style.widths) ?? [widths[0]]
  const styleBlocking = opts.styleStrict || config.style.blocking
  const needStyle = styleEnabled && styleTargets.length > 0

  const cleanups = []
  let devServer = null
  let staticServer = null
  let chrome = null
  let cdp = null
  try {
    /* 1. 实现侧地址：--url > 配置 > 自举 devServer */
    let implBase = opts.url ?? config.implBaseUrl
    if (!implBase) {
      devServer = await startDevServer(config.devServer)
      cleanups.push(() => devServer.stop())
      implBase = devServer.url
    }
    const target = `${implBase}${manifest.route ?? '/'}`
    const targetOk = await poll(async () => (await fetch(target, { signal: AbortSignal.timeout(2000) })).ok, {
      timeout: 15_000,
      label: `目标页可达（${target}）`,
    })
    if (!targetOk) throw new Error(`目标页不可达：${target}`)

    /* 2. 原型侧地址（仅样式对比用）：外部基址 > 工具自带静态服务。 */
    let protoUrl = null
    if (needStyle) {
      const rel = prototypePathFor(config, opts.page)
      if (!rel) throw new Error(`prototypePaths 无法为页 "${opts.page}" 解析出原型路径`)
      if (config.prototypeBaseUrl) {
        protoUrl = `${config.prototypeBaseUrl}/${rel.replace(/^\/+/, '')}`
      } else {
        staticServer = await startStaticServer(config.prototypeRoot)
        cleanups.push(() => staticServer.stop())
        protoUrl = `${staticServer.url}/${rel.replace(/^\/+/, '')}`
      }
      const protoOk = await poll(async () => (await fetch(protoUrl, { signal: AbortSignal.timeout(2000) })).ok, {
        timeout: 10_000,
        label: `原型页可达（${protoUrl}）`,
      })
      if (!protoOk) throw new Error(`原型页不可达：${protoUrl}（prototypeRoot=${config.prototypeRoot}）`)
    }

    /* 3. 浏览器（自动发现）+ CDP */
    const { bin, source } = resolveBrowser({ cliPath: opts.browser, config })
    if (!opts.json) process.stderr.write(`  · 浏览器 ${bin}（${source}）\n`)
    chrome = await launchBrowser({ bin })
    cleanups.push(() => chrome.child.kill('SIGTERM'))
    cleanups.push(() => rmSync(chrome.profile, { recursive: true, force: true }))
    cdp = await attachPage(chrome)
    cleanups.push(() => cdp.close())

    /* 4. 偏好强制：① 浏览器层媒体特性（prefers-color-scheme ⇒ 影响页面**自己的**主题判定）
     *              ② 文档起始注入 localStorage（应自己按配置启动）
     *              ③ 载入后复施 html 属性（兜页面脚本回写）
     * ①是 PoC 教训的正解：原型 `app.js` 用 `matchMedia('(prefers-color-scheme: dark)')` 决定主题，
     * 无头浏览器默认为 light ⇒ 静态 `data-theme="dark"` 被覆盖，于是「原型浅色 / 实现深色」
     * 产生成片假差异。只写死属性不解决 —— 页面启动时仍会按媒体特性重算。 */
    if (config.theme) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: config.theme }],
      })
    }
    const prefsScript = buildPrefsScript(config)
    if (prefsScript) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: prefsScript })

    const consoleSink = []
    attachConsoleCollector(cdp, consoleSink)

    /* 5. 逐档 DOM 断言 */
    const readySelector =
      manifest.readySelector ?? blocks.find((b) => (b.status ?? 'delivered') === 'delivered')?.norm[0]?.selector
    const perWidth = []
    for (const width of widths) {
      consoleSink.length = 0
      const { ready } = await goto(cdp, target, { width, height: manifest.height, readySelector, settleMs: config.settleMs })
      // 壳层自检：地址指错端口/目录时给出人话，而不是一片 count=0
      if (config.implShellSelector) {
        const sel = config.implShellSelector
        const shell = await evaluate(
          cdp,
          `({ hasShell: !!document.querySelector(${JSON.stringify(sel)}), title: document.title })`,
        )
        if (!shell.hasShell) {
          throw new Error(`目标页不是本应用（无 ${sel}）：${target}（title=${shell.title}）—— 地址是否指错端口/目录？`)
        }
      }
      const probe = await evaluate(cdp, buildDomProbe(allChecks, manifest.overflowTargets))
      perWidth.push({ width, ready, probe, errors: consoleSink.map((e) => ({ ...e })) })
    }

    /* 6. computed style 双侧对比（同视口 + 同 theme/locale） */
    let style = null
    if (needStyle) {
      const perStyleWidth = []
      for (const width of styleWidths) {
        const common = { width, height: manifest.height, settleMs: config.settleMs }
        await goto(cdp, protoUrl, common)
        const proto = await evaluate(cdp, buildStyleProbe(styleTargets, config.styleProps))
        await goto(cdp, target, { ...common, readySelector })
        const applied = await evaluate(cdp, buildApplyExpr(config))
        const impl = await evaluate(cdp, buildStyleProbe(styleTargets, config.styleProps))
        perStyleWidth.push({ ...judgeStyle({ impl, proto, props: config.styleProps, targets: styleTargets, width }), applied })
      }
      style = {
        ...sumStyle(perStyleWidth, config.styleProps, styleTargets),
        perWidth: perStyleWidth,
        theme: perStyleWidth[0].theme,
        lang: perStyleWidth[0].lang,
        protoUrl,
        blocking: styleBlocking,
      }
    }

    /* 7. 判定 + 报告 */
    const rendered = await evaluate(cdp, `({ lang: document.documentElement.lang, title: document.title })`)
    const report = judge({ manifest, blocks, perWidth, widths, rendered, target, file, style, opts })

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ...report, configFile: config.file, prototypeUrl: protoUrl }, null, 2)}\n`)
    } else {
      printHuman(report, { exitPass: EXIT_PASS, exitFail: EXIT_FAIL, styleBlocking })
    }

    if (opts.keepOpen) {
      process.stdout.write(
        `\n--keep-open：浏览器 pid ${chrome.child.pid ?? '?'}（profile ${chrome.profile}）｜` +
          `dev server pid ${devServer?.child?.pid ?? '(用 --url / implBaseUrl，未自举)'}｜` +
          `原型静态服务 ${staticServer ? '在跑' : '未起'}\n`,
      )
      cleanups.length = 0 // 交还给人，不 kill
      if (cdp) cdp.close()
    }
    return report.pass ? EXIT_PASS : EXIT_FAIL
  } finally {
    for (const fn of cleanups.reverse()) {
      try {
        fn()
      } catch {
        /* 收尾失败不影响退出码 */
      }
    }
  }
}

try {
  process.exitCode = await main()
} catch (e) {
  process.stderr.write(
    `\nui-align check 无法执行（环境/配置问题，退出码 ${EXIT_BLOCKED}）：\n  ${String(e.message ?? e).split('\n').join('\n  ')}\n`,
  )
  process.exitCode = EXIT_BLOCKED
}
