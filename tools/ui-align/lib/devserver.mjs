/**
 * 服务自举：① 项目 dev server（配置驱动，`{port}` 占位 + 进程组回收）
 *           ② 原型静态服务（工具自带，Node 内置 http —— 免外部依赖，且给原型一个真 HTTP 源）。
 *
 * 为什么原型不直接用 `file://`：ES module / localStorage / CORS 在 `file://` 下行为不一致
 * （有的浏览器直接拒），换项目就会踩。起一个内建静态服务，成本 40 行，换来两边同源语义一致。
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { freePort, poll } from './browser.mjs'
import { fill } from './config.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

/**
 * 自举项目 dev server。返回 `{child, url, logs, stop()}`。
 * 端口取空闲端口后以 `{port}` 注入命令与 URL 模板 ⇒ 不与既有 dev server 抢端口。
 */
export async function startDevServer(cfg) {
  const port = await freePort()
  const values = { port }
  const cmd = fill(cfg.cmd, values)
  const url = fill(cfg.url, values)
  if (!cmd || !url) throw new Error('devServer.cmd / devServer.url 含无法解析的占位符')

  const child = spawn(cmd, {
    cwd: cfg.cwd,
    env: { ...process.env, ...cfg.env },
    shell: true,
    detached: true, // 自建进程组 ⇒ 收尾时能整组 kill（npm/壳脚本会再 fork 子进程）
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))
  let exited = null
  child.on('exit', (code) => { exited = code })

  const up = await poll(
    async () => !exited && (await fetch(`${url}${cfg.readyPath ?? '/'}`, { signal: AbortSignal.timeout(2000) })).ok,
    { timeout: cfg.readyTimeoutMs ?? 30_000, label: `dev server 启动（${url}）` },
  )
  const stop = () => killGroup(child)
  if (!up) {
    stop()
    throw new Error(`dev server 起不来（exit=${exited}）\n命令 ${cmd}（cwd ${cfg.cwd}）\n${logs.join('')}`)
  }
  return { child, url, logs, stop }
}

/** 原型静态服务（只读）。返回 `{child: null, url, stop()}`，与 devServer 同形状便于统一收尾。 */
export async function startStaticServer(root) {
  if (!existsSync(root)) throw new Error(`原型目录不存在：${root}`)
  const base = resolve(root)
  const realBase = realpathSync(base) // 原型根自身可能是软链 ⇒ 以真路径为界
  const server = createServer((req, res) => {
    let rel
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    } catch {
      res.writeHead(400).end('bad request')
      return
    }
    let p = resolve(base, '.' + normalize(rel))
    if (p !== base && !p.startsWith(base + sep)) {
      res.writeHead(403).end('forbidden') // 词法目录穿越（..）
      return
    }
    /* 真路径复核：软链可能指向界外（词法包含查不出）。解析后再比一次真路径包含。 */
    try {
      p = realpathSync(p)
    } catch {
      res.writeHead(404).end('not found')
      return
    }
    if (p !== realBase && !p.startsWith(realBase + sep)) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html')
    if (!existsSync(p)) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(p).toLowerCase()] ?? 'application/octet-stream' })
    createReadStream(p).pipe(res)
  })
  const port = await freePort()
  await new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(port, '127.0.0.1', res)
  })
  return { child: null, url: `http://127.0.0.1:${port}`, stop: () => server.close() }
}

/** 收整组进程（`detached` 起的 npm/壳会再 fork，单杀 child 会留下孤儿）。 */
function killGroup(child) {
  if (!child || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
}
