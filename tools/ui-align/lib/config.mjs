/**
 * ui-align 配置（`<project>/.ui-align.json`）—— **项目侧唯一落点**。
 *
 * 引擎内零项目知识：路径 / 端口 / 主题 / 语言 / 偏好键 / 选择器全部来自本文件。
 * 新增项目接入 = 写一份 `.ui-align.json`，不改本工具任何一行。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

/** 计算样式默认属性集：字体 / 字号 / 字重 / 行高 / 字距 / 颜色 / 背景 / 边框 / 圆角 / 盒模型 / 布局。 */
export const DEFAULT_STYLE_PROPS = [
  'display', 'position', 'flexDirection', 'alignItems', 'justifyContent', 'gap',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'width', 'height', 'minWidth', 'maxWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'color', 'backgroundColor', 'borderRadius', 'borderTopWidth', 'borderColor',
  'whiteSpace', 'overflow', 'textTransform',
]

export const DEFAULT_VIEWPORTS = [1512, 1240, 980, 760, 430]

const str = (v) => typeof v === 'string' && v.trim().length > 0
const intList = (v) => Array.isArray(v) && v.length > 0 && v.every((n) => Number.isInteger(n) && n > 0)

/** `{theme}` / `{locale}` / `{localeTag}` / `{page}` / `{port}` 占位替换。
 *  任一占位无值 ⇒ 返回 null（调用方跳过该条，**不写入字面量占位符**）。 */
export function fill(template, values) {
  let missing = false
  const out = String(template).replace(/\{(\w+)\}/g, (_, k) => {
    const v = values[k]
    if (v === undefined || v === null || v === '') {
      missing = true
      return ''
    }
    return String(v)
  })
  return missing ? null : out
}

/**
 * 载入并校验配置。返回归一化对象（路径一律绝对）。
 * @param {string} configFile `--config` 传入的路径（相对 cwd 解析）
 */
export function loadConfig(configFile, { cwd = process.cwd() } = {}) {
  if (!str(configFile)) throw new Error('缺少 --config <项目/.ui-align.json>')
  const file = isAbsolute(configFile) ? configFile : resolve(cwd, configFile)
  if (!existsSync(file)) throw new Error(`配置文件不存在：${file}`)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`配置不是合法 JSON：${file}\n  ${e.message}`)
  }
  const root = dirname(file) // 项目根 = 配置文件所在目录
  const problems = []
  const abs = (p) => (isAbsolute(p) ? p : resolve(root, p))

  if (!str(raw.manifests)) problems.push('"manifests" 必填（清单目录，含 <page>.json）')

  /* 原型：静态根目录（工具自带静态服务）或外部基址。 */
  const prototypeRoot = str(raw.prototypeRoot) ? abs(raw.prototypeRoot) : abs('prototype')
  const prototypePaths = raw.prototypePaths ?? { '*': '{page}.html' }
  if (typeof prototypePaths !== 'string' && (typeof prototypePaths !== 'object' || prototypePaths === null)) {
    problems.push('"prototypePaths" 须为字符串模板或 { 页名: 相对路径 } 对象')
  }

  /* 实现侧：显式基址（--url / implBaseUrl）或自举 devServer。 */
  let devServer = null
  if (raw.devServer !== undefined) {
    const d = raw.devServer
    if (typeof d !== 'object' || d === null) problems.push('"devServer" 须为对象')
    else {
      if (!str(d.cmd)) problems.push('"devServer.cmd" 必填（自举命令，可含 {port} 占位）')
      devServer = {
        cmd: d.cmd,
        cwd: str(d.cwd) ? abs(d.cwd) : root,
        env: d.env ?? {},
        url: str(d.url) ? d.url : 'http://127.0.0.1:{port}',
        readyTimeoutMs: Number.isInteger(d.readyTimeoutMs) ? d.readyTimeoutMs : 30_000,
        readyPath: str(d.readyPath) ? d.readyPath : '/',
      }
    }
  }
  const implBaseUrl = str(raw.implBaseUrl) ? raw.implBaseUrl.replace(/\/+$/, '') : null
  if (!implBaseUrl && !devServer) problems.push('须给 "implBaseUrl" 或 "devServer" 之一（否则没有可比对的实现侧地址）')

  /* 同 theme + 同 locale —— 双侧强制对齐（PoC 教训：主题不一致会产生成片假差异）。 */
  const theme = str(raw.theme) ? raw.theme : null
  const locale = str(raw.locale) ? raw.locale : null
  const localeTag = str(raw.localeTag) ? raw.localeTag : locale
  const applyRaw = raw.apply ?? {}
  const apply = {
    htmlAttributes: applyRaw.htmlAttributes ?? (theme || localeTag ? { 'data-theme': '{theme}', lang: '{localeTag}' } : {}),
    localStorage: applyRaw.localStorage ?? {},
  }

  const viewports = raw.viewports === undefined ? DEFAULT_VIEWPORTS : raw.viewports
  if (!intList(viewports)) problems.push('"viewports" 须为非空正整数数组')

  const style = raw.style ?? {}
  const styleTargets = [...(raw.styleTargets ?? []), ...(style.targets ?? [])]
  for (const [i, t] of styleTargets.entries()) {
    if (!str(t?.selector)) problems.push(`styleTargets[${i}] 缺 "selector"`)
  }
  if (raw.styleProps !== undefined && !(Array.isArray(raw.styleProps) && raw.styleProps.length > 0 && raw.styleProps.every(str))) {
    problems.push('"styleProps" 须为非空字符串数组')
  }

  if (problems.length) throw new Error(`配置校验未过：${file}\n  - ${problems.join('\n  - ')}`)

  return {
    file,
    root,
    prototypeRoot,
    prototypePaths,
    prototypeBaseUrl: str(raw.prototypeBaseUrl) ? raw.prototypeBaseUrl.replace(/\/+$/, '') : null,
    implBaseUrl,
    devServer,
    /* 实现侧「确实挂上了本应用」的自检选择器：地址指错端口/目录时给人话而不是一片 count=0。
       缺省 `#app`（Vue/React 惯例）；项目可改，`null` = 跳过自检。 */
    implShellSelector: raw.implShellSelector === null ? null : (str(raw.implShellSelector) ? raw.implShellSelector : '#app'),
    manifests: abs(raw.manifests),
    viewports,
    height: Number.isInteger(raw.height) ? raw.height : 900,
    theme,
    locale,
    localeTag,
    apply,
    settleMs: Number.isInteger(raw.settleMs) ? raw.settleMs : 350,
    styleProps: raw.styleProps ?? DEFAULT_STYLE_PROPS,
    styleTargets,
    style: {
      widths: intList(style.widths) ? style.widths : null, // null ⇒ 取 viewports[0]
      blocking: style.blocking === true,
      /* 开关三态：显式 true/false 直取；未写 = 自动（**有 styleTargets 就跑**，目标可写在
         项目配置或页清单任一处，故此处不能只看配置侧）。 */
      enabled: typeof style.enabled === 'boolean' ? style.enabled : null,
    },
    browsers: {
      executablePath: str(raw.browsers?.executablePath) ? raw.browsers.executablePath : null,
      extraPaths: Array.isArray(raw.browsers?.extraPaths) ? raw.browsers.extraPaths : [],
    },
  }
}

/** 页名 → 原型页相对路径（`prototypePaths` 为模板字符串或映射表，键 `*` = 缺省）。 */
export function prototypePathFor(config, page) {
  const pp = config.prototypePaths
  const tpl = typeof pp === 'string' ? pp : (pp[page] ?? pp['*'] ?? '{page}.html')
  return fill(tpl, { page })
}
