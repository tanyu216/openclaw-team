/**
 * 浏览器管理：解析可执行文件（Chrome / Chromium / Playwright 自带构建自适应）+ 启动 + 极简 CDP 客户端。
 *
 * **零 npm 依赖**：用 Node ≥22 内置 `WebSocket` 直连 Chrome DevTools Protocol。
 * 解析顺序：`--browser` > 配置 `browsers.executablePath` > `CHROME_PATH` > 配置 `browsers.extraPaths`
 *           > 本机已知路径（mac / linux / windows）> Playwright 浏览器缓存（`ms-playwright/chromium-*`，
 *             按 revision 取最新）。
 * 最后那段是 PoC 教训的修复：之前要手工指定 `chromium_headless_shell-1223` 才能跑；现在自动发现。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function freePort() {
  const srv = createServer()
  await new Promise((res, rej) => {
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', res)
  })
  const { port } = srv.address()
  await new Promise((res) => srv.close(res))
  return port
}

export async function poll(fn, { timeout, interval = 150, label = '' }) {
  const deadline = Date.now() + timeout
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true
    } catch (e) {
      lastErr = e
    }
    await sleep(interval)
  }
  if (label) process.stderr.write(`  ! 等待超时：${label}${lastErr ? `（${lastErr.message}）` : ''}\n`)
  return false
}

/** 本机常见安装位置。 */
const SYSTEM_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google Chrome\\Application\\chrome.exe',
]

/** Playwright 浏览器缓存根（与 playwright 包是否存在无关，纯目录扫描）。 */
function playwrightCacheRoots() {
  const home = homedir()
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(home, 'Library', 'Caches', 'ms-playwright'),
    join(home, '.cache', 'ms-playwright'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : null,
  ].filter(Boolean)
}

/** 缓存内可执行文件相对布局（按 revision 目录）。 */
const PW_BIN_LAYOUT = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux/chrome',
  'chrome-win/chrome.exe',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
  'chrome-headless-shell-mac-x64/chrome-headless-shell',
  'chrome-headless-shell-linux64/chrome-headless-shell',
  'chrome-headless-shell-win64/chrome-headless-shell.exe',
]

/** 扫描 Playwright 缓存：`chromium-<rev>` / `chromium_headless_shell-<rev>`，rev 大者优先。 */
function playwrightCandidates() {
  const found = []
  for (const base of playwrightCacheRoots()) {
    if (!existsSync(base)) continue
    let entries
    try {
      entries = readdirSync(base)
    } catch {
      continue
    }
    const dirs = entries
      .map((n) => /^chromium(?:_headless_shell)?-(\d+)$/.exec(n))
      .filter(Boolean)
      .map((m) => ({ name: m[0], rev: Number(m[1]) }))
      .sort((a, b) => (b.rev - a.rev) || a.name.localeCompare(b.name)) // 最新在前；同 rev 时完整 chromium 优先
    for (const d of dirs) {
      for (const rel of PW_BIN_LAYOUT) {
        const p = join(base, d.name, rel)
        if (existsSync(p)) found.push(p)
      }
    }
  }
  return found
}

/**
 * 解析浏览器可执行文件。
 * @returns {{bin: string, source: string, tried: string[]}}
 */
export function resolveBrowser({ cliPath = null, config = null } = {}) {
  const configured = config?.browsers ?? {}
  const chain = [
    [cliPath, '--browser'],
    [configured.executablePath, 'config browsers.executablePath'],
    [process.env.CHROME_PATH, '$CHROME_PATH'],
    ...(configured.extraPaths ?? []).map((p) => [p, 'config browsers.extraPaths']),
    ...SYSTEM_CANDIDATES.map((p) => [p, '本机已知路径']),
    ...playwrightCandidates().map((p) => [p, 'Playwright 浏览器缓存']),
  ].filter(([p]) => typeof p === 'string' && p.length > 0)

  for (const [bin, source] of chain) {
    if (existsSync(bin)) return { bin, source, tried: chain.map(([p, s]) => `${p}  (${s})`) }
  }
  const err = new Error(
    `未找到可用的 Chrome/Chromium。已尝试 ${chain.length} 条路径：\n  ` +
      chain.map(([p, s]) => `${p}  (${s})`).join('\n  ') +
      '\n  ⇒ 装 Chrome，或用 --browser <可执行文件> / 配置 browsers.executablePath / $CHROME_PATH 指定。',
  )
  err.tried = chain.map(([p, s]) => `${p}  (${s})`)
  throw err
}

const isHeadlessShell = (bin) => /headless[-_]shell/i.test(bin)

export async function launchBrowser({ bin, onStderr } = {}) {
  const port = await freePort()
  const profile = mkdtempSync(join(tmpdir(), 'ui-align-chrome-'))
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    // 与既有截图流程同口径（隐藏滚动条 ⇒ 视口宽度全部给内容，多档才有可比性）
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1512,900',
    'about:blank',
  ]
  // chrome-headless-shell 本身即无头；给它 `--headless=new` 反而不认。
  if (!isHeadlessShell(bin)) args.unshift('--headless=new')

  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', (d) => onStderr?.(String(d)))
  let exited = null
  child.on('exit', (code) => { exited = code })

  const base = `http://127.0.0.1:${port}`
  const up = await poll(async () => !exited && (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2000) })).ok, {
    timeout: 20_000,
    label: `Chrome 调试端口（${base}）`,
  })
  if (!up) {
    rmSync(profile, { recursive: true, force: true })
    throw new Error(`浏览器起不来或调试端口未开（exit=${exited}）：${bin}`)
  }
  return { child, base, profile, bin }
}

/* ── 极简 CDP 客户端（Node 内置 WebSocket；只实现本工具要用的面） ─────────────── */

export class Cdp {
  #ws
  #id = 0
  #pending = new Map()
  #listeners = new Map()

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error(`CDP WebSocket 连接失败：${wsUrl}`)), { once: true })
    })
    const cdp = new Cdp(ws)
    ws.addEventListener('message', (e) => cdp.#onMessage(e.data))
    return cdp
  }

  constructor(ws) {
    this.#ws = ws
  }

  #onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id)
      if (!p) return
      this.#pending.delete(msg.id)
      clearTimeout(p.timer)
      msg.error ? p.reject(new Error(`${msg.error.message}（${p.method}）`)) : p.resolve(msg.result)
      return
    }
    for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params)
  }

  send(method, params = {}, timeoutMs = 20_000) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP 超时 ${timeoutMs}ms：${method}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, method, timer })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set())
    this.#listeners.get(method).add(fn)
  }

  once(method, timeoutMs) {
    return new Promise((resolve) => {
      const off = (params) => {
        clearTimeout(timer)
        this.#listeners.get(method).delete(off)
        resolve(params)
      }
      const timer = setTimeout(() => {
        this.#listeners.get(method)?.delete(off)
        resolve(null)
      }, timeoutMs)
      this.on(method, off)
    })
  }

  close() {
    try {
      this.#ws.close()
    } catch {
      /* 关已关的连接不构成失败 */
    }
  }
}

export async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    throw new Error(`页面内求值抛错：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  }
  return r.result.value
}

/** 取当前浏览器的第一个 page target 并接上 CDP。 */
export async function attachPage(browser) {
  const list = await (await fetch(`${browser.base}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page?.webSocketDebuggerUrl) throw new Error('浏览器无 page target（headless 未就绪？）')
  const cdp = await Cdp.open(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  return cdp
}
