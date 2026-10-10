# ui-align —— 跨项目 UI 还原度机检工具

把「原型（设计稿）vs 实现」的还原度从**主观截图比对**变成**可复现、可量化、可进 CI 的断言**。

- **原型侧**：任意静态 HTML（工具自带静态服务，不需要项目先起服务）
- **实现侧**：任意跑得起来的 Web 应用（自举 dev server 或指向既有地址）
- **零 npm 依赖**：只用 Node ≥22 内置能力 + 本机浏览器（CDP 直连）

产出四类判定 + 一致率：

| # | 能力 | 判据 |
|---|------|------|
| 1 | DOM 存在性 | `selector` 的命中数 / 非空（逐视口） |
| 2 | 五档无溢出 | `scrollWidth <= clientWidth` |
| 3 | console 干净 | 白名单外报错 = 缺陷 |
| 4 | **computed style 双侧 diff** | 逐元素逐属性比对（同一份 DOM 事实，不是像素） |
| 5 | 报告 | 文本（人读）/ `--json`（CI） |

> 为什么不用截图：截图不可量化、不可复现、进不了 CI，而且**看不出 0×0 的隐形元素**——
> computed style 恰恰能一眼抓到（`.avatar-name` 0×0 就是这么发现的）。

---

## 1. 安装

```bash
git clone <team-repo> ~/.openclaw        # 或 git pull
node ~/.openclaw/team/tools/ui-align/check.mjs --help
```

**依赖**：Node ≥ 22（用到内置 `WebSocket` / `fetch`）+ 一个 Chrome/Chromium。浏览器**自动发现**，顺序：

```
--browser <path>  >  配置 browsers.executablePath  >  $CHROME_PATH
  >  配置 browsers.extraPaths  >  本机已知路径（mac/linux/windows）
  >  Playwright 浏览器缓存（~/Library/Caches/ms-playwright/chromium-*，按 revision 取最新）
```

最后一段是刻意的：以前跑样式 PoC 得手工指名 `chromium_headless_shell-1223` 才能跑；
现在装了 Playwright 缓存就能被自动认出来，不必再手填路径。

---

## 2. 快速开始（项目侧三步）

```bash
# ① 在项目根写 .ui-align.json（见 §3）
# ② 在清单目录写 <page>.json（见 §4）
# ③ 跑
node ~/.openclaw/team/tools/ui-align/check.mjs --config ./.ui-align.json overview
```

接进 `package.json`：

```json
{ "scripts": { "ui-align": "node <path-to>/team/tools/ui-align/check.mjs --config .ui-align.json" } }
```

---

## 3. 配置 `<project>/.ui-align.json`

**项目知识只允许落在这一个文件里**——引擎内零项目路径、零端口、零选择器。
所有相对路径相对**本文件所在目录**（= 项目根）。

| 键 | 必填 | 说明 |
|---|---|---|
| `manifests` | ✅ | 清单目录（含 `<page>.json`） |
| `prototypeRoot` | | 原型静态根目录（工具自带 HTTP 服务）。缺省 `prototype` |
| `prototypePaths` | | 页名 → 原型页相对路径。字符串模板或映射表，键 `*` 为缺省。缺省 `{ "*": "{page}.html" }` |
| `prototypeBaseUrl` | | 原型已在别处起服务时给基址（跳过自带静态服务） |
| `implBaseUrl` | ⚠️ | 实现侧基址。与 `devServer` **二选一**（`--url` 可临时覆盖） |
| `devServer` | ⚠️ | 自举实现侧：`{ cmd, cwd, env, url, readyTimeoutMs, readyPath }`，`cmd`/`url` 支持 `{port}` 占位 |
| `viewports` | | 视口宽度档位。缺省 `[1512,1240,980,760,430]`；清单 `widths` 优先 |
| `height` | | 视口高度，缺省 900 |
| `theme` | | **强制**双侧主题（`dark` / `light`）。见 §5 |
| `locale` / `localeTag` | | **强制**双侧语言（`locale` 给应用读，`localeTag` 写 `<html lang>`） |
| `apply` | | 偏好注入：`{ htmlAttributes: {...}, localStorage: {...} }`，值支持 `{theme}`/`{locale}`/`{localeTag}` 占位 |
| `styleProps` | | computed style 属性集，缺省 31 项（字体/字号/字重/行高/字距/颜色/背景/边框/圆角/盒模型/布局） |
| `styleTargets` | | 项目级样式对比目标（每个页面都跑，如全局壳层）。页级目标写在清单里，见 §4 |
| `style` | | `{ enabled, blocking, targets, widths }`。`blocking` 缺省 `false`（差异只上屏、不判失败） |
| `settleMs` | | 导航后静置，缺省 350（等 Vue 挂载/图表渲染） |
| `browsers` | | `{ executablePath, extraPaths }` |

**最小可用示例**：

```json
{
  "prototypeRoot": "web-client/prototype",
  "prototypePaths": { "*": "pages/{page}.html", "appshell": "pages/overview.html" },
  "manifests": "web-client/tools/ui-align",
  "devServer": {
    "cmd": "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port {port} --strictPort",
    "cwd": "web-client",
    "env": { "VITE_API_BASE": "" },
    "url": "http://127.0.0.1:{port}"
  },
  "theme": "dark",
  "locale": "zh",
  "localeTag": "zh-CN",
  "apply": {
    "htmlAttributes": { "data-theme": "{theme}", "data-updown": "cn", "lang": "{localeTag}" },
    "localStorage": { "trader-theme": "{theme}", "trader-updown": "cn", "trader-lang": "{locale}" }
  }
}
```

> **`devServer.env` 为什么常常要覆盖一个空值**：很多前端用「环境变量是否为空」区分
> **接入态**（打真后端）与**离线态**（静态示例数据）。机检要的是**结构完整、零请求**的
> 离线态 ⇒ 用 `env` 把该变量显式置空（trader 是 `VITE_API_BASE: ""`）。

---

## 4. 清单 `<manifests>/<page>.json`

「页 + 区块清单」：一个区块一组断言，每条差异都要求 `evidence`（文件+行号+选择器）。

```json
{
  "page": "overview",
  "name": "总览页",
  "route": "/overview",
  "widths": [1512, 1240, 980, 760, 430],
  "height": 900,
  "overflowTargets": [{ "selector": "html", "desc": "文档根" }],
  "console": { "allowlist": [{ "pattern": "favicon", "reason": "…", "evidence": "…" }] },
  "style": {
    "targets": [{ "name": "topbar", "selector": ".topbar" }]
  },
  "blocks": [
    {
      "id": "hero", "name": "Hero 大卡",
      "evidence": "prototype/pages/overview.html:41 <section class=\"hero card\">",
      "status": "delivered",
      "checks": [
        { "selector": "section.hero.card", "desc": "Hero 卡在位" },
        { "selector": "#heroChart", "nonEmpty": true },
        { "selector": ".card.mini", "count": 3 },
        { "selector": ".ov-kpi", "count": 0 },
        { "scope": ".pf-group", "selector": "thead th", "count": 9 }
      ]
    }
  ]
}
```

**check 词汇表**（只此六种，够用且可判定）：

| 字段 | 语义 |
|---|---|
| `selector` | 必填。CSS 选择器 |
| `scope` | 在 `scope` 的首个命中内查 `selector`（列集/行集对齐用） |
| `min` / `max` / `count` | 命中数上下界；**三选一**；都给会报错。都不给 = 缺省 `min:1`（存在） |
| `nonEmpty` | 命中元素须「有子元素或有文本」（防空壳） |
| `desc` | 报告里的可读说明 |

**block 字段**：`id` / `name` / `evidence` / `checks` 必填；`status` 取 `delivered`（缺省）
或 `pending`（未实现 ⇒ 记 SKIP 并上屏，`--strict` 升级为失败）。
`pending` 的价值：清单**从第一天起就是全量**，任何区块都不能悄悄消失。

---

## 5. computed style 双侧对比（本工具的核心增量）

**取数方式**：同一档视口下，先后加载原型页与实现页，各自 `getComputedStyle` 逐目标逐属性读取，
按属性字符串逐字比对。输出差异清单（属性 / 原型值 / 实现值）+ 盒尺寸 + **一致率**。

**必须在同 theme + 同 locale 下比**。这是 PoC 踩出来的坑：原型浅色、实现深色，
于是颜色类属性成片「不一致」——**全是假差异**，真问题被淹没。
工具用三重手段把两侧口径钉死：

1. **浏览器层**：`Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] })`
   —— 页面若用 `matchMedia('(prefers-color-scheme: dark)')` 决定主题（很常见），只有这层能治。
   只写死 `data-theme` 属性**不够**：页面启动时会按媒体特性重算并覆盖。
2. **文档起始注入** `localStorage`：让应用**自己**按配置的 theme/locale 启动
   （在页面脚本之前执行），而不是「先按默认渲染、再被工具改属性」。
3. **载入后复施** `<html>` 属性：兜住「页面脚本把属性写回去了」。

报告顶部会打印实测的 `theme` / `lang`；**两侧不一致时会显式告警「差异不可信，先修配置」**。

**非阻塞**：`style` 差异默认**不计入退出码**（只上屏 + 进 `--json`）——新能力先观察，
避免一次工具升级把下游 CI 一次性判红。要卡门禁加 `--style-strict`。

**怎么读结果**（两类「差异」不是bug）：

- **0×0 元素**是有效发现：元素在但没尺寸（隐藏/未挂载/容器塌陷）。也可能是**数据态**所致
  （未登录 ⇒ 昵称为空 ⇒ 宽度 0），与样式无关——按元素语义人工判断。
- **布局连带**：父容器宽度变了，子元素 `width`/`marginLeft` 会跟着变；看**最外层那个差异**才是根因。

---

## 6. 用法 / 退出码

```bash
node check.mjs --config <project>/.ui-align.json [page] [选项]
```

| 选项 | 说明 |
|---|---|
| `--config <file>` | **必填** |
| `--url <url>` | 断言既有服务（跳过自举） |
| `--browser <path>` | 指定浏览器 |
| `--strict` | `pending` 区块也当失败 |
| `--json` | 机器可读（CI） |
| `--widths a,b,c` | 覆盖清单档位 |
| `--style` / `--no-style` | 强制开关样式对比 |
| `--style-strict` | 样式差异计入退出码 |
| `--style-widths a,b` | 覆盖样式档位（缺省取第一档） |
| `--keep-open` | 跑完不关浏览器/服务，打印 pid（**需自行收掉**） |

**退出码**：`0` 全过 ｜ `1` 有断言失败 ｜ `2` 环境/配置/清单错误（无浏览器 / 配置缺失 / 服务起不来）。

---

## 7. 新项目接入步骤

> 目标：**不改本工具任何一行**，只写项目侧两份文件。

1. **起原型**：确认原型是**纯静态** HTML（设计稿）。工具自带静态服务 ⇒ 不需要项目先起。
   若原型不能独立打开（要构建、要登录），给 `prototypeBaseUrl` 指向已起来的服务。
2. **定实现侧**：能自举就给 `devServer`（推荐 —— CI 里不用先手动起服务）；
   否则给 `implBaseUrl` 或每次 `--url`。
   - `cmd` 里的端口写 `{port}`：工具取**空闲端口**注入 ⇒ 不与本地已跑的 dev server 抢 5173。
   - **务必用 `env` 把项目切到「离线态 / 示例数据态」**（见 §3 末注），否则会被登录/权限/网络挡在门外。
3. **对齐口径**：填 `theme` / `locale` / `localeTag` / `apply`。
   验证方法：先跑一次，看 `[computed style]` 段首行的 `theme=… / lang=…`，两侧一致才算对齐。
4. **写清单**：`<manifests>/<page>.json`。先写**全量**区块（未实现的标 `status:"pending"`），
   每条 check 都要能指到 `evidence`（原型文件:行号 选择器）。
   - 从 1 个页面开始（通常是「有壳层 + 内容最全」的那页），跑通再铺开。
5. **写样式目标**：`style.targets`（页级）或 `styleTargets`（项目级，如全局顶栏/侧栏）。
   目标选择器要**两侧都存在**；只在一侧存在的会进 `missing-impl` / `missing-proto`，属预期噪声，先看数再决定保留。
6. **挂 CI**：
   ```bash
   node ~/.openclaw/team/tools/ui-align/check.mjs --config .ui-align.json --json > ui-align.json
   ```
   先只卡退出码（DOM/溢出/console），样式稳定后再加 `--style-strict`。
7. **登记基线**：把首次跑出的数字（区块/断言/失败/样式一致率）记进项目 README —— 后续回归有对照物。

**首次接入自查**：能复现 `PASS`（或只有已知差异）+ `--json` 可解析 + 退出码符合预期（故意改坏一条断言应得 `1`）。

---

## 8. 目录结构

```
check.mjs            CLI 入口 + 主流程编排
lib/config.mjs       .ui-align.json 载入 / 校验 / 默认值 / 占位替换
lib/manifest.mjs     页清单载入 / schema 校验 / 断言归一化
lib/browser.mjs      浏览器发现 + 启动 + 极简 CDP 客户端
lib/devserver.mjs    dev server 自举（进程组回收）+ 原型静态服务
lib/probe.mjs        页面内探针源码生成（DOM / computed style / 偏好注入）
lib/style.mjs        computed style 差异判定（纯函数）
lib/judge.mjs        DOM 判定（纯函数）
lib/report.mjs       文本 / JSON 报告
```

`check.mjs` 是唯一入口；`lib/*` 除 `browser.mjs` / `devserver.mjs` 外都是**纯函数**
（给定输入给输出，不碰 IO），便于复核口径与单测。

---

## 9. 安全与信任模型（接入 CI 前必读）

`.ui-align.json` 的 `devServer.cmd` 会被本工具**执行**（`shell: true`，整组进程回收），
且子进程**继承当前环境变量**。

⇒ **`.ui-align.json` 是可信输入，信任级别等同 `package.json` 的 `scripts`**：
能改它的人本来就能改 `package.json`。因此：

- ✅ 正常用法（项目内自跑、CI 跑自己仓库的代码）没有问题。
- ❌ **不要**在「检出未审核的 PR 内容」的场景下直接执行 —— 例如
  `pull_request_target` 类工作流、或把外部贡献者的分支拿来自动跑。
  这类场景请在**无密钥、断网**的独立 job 里跑，或先人工审核配置改动。
- 工具本身**不读取、不转发、不打印任何凭据**；报告里只有结构/样式数据。

其余加固：原型静态服务只绑 `127.0.0.1` 的随机端口，且做了**词法 + 真路径双重包含校验**
（软链逃逸也会被 403）；页面来源文本（console 报错/异常堆栈/URL）进终端前一律**剥 ANSI 与
控制字符**（防终端注入），`--json` 侧保留原值以免丢信息。

---

## 10. 已知边界

- **只比 DOM 事实，不比像素**：渐变叠加、阴影合成、字体渲染抗锯齿等渲染层差异不在口径内。
- **console 只判实现侧**：原型侧的设计稿引用可能自带噪声，不参与判定。
- **需要交互才出现的元素**（开抽屉、切 tab）不在本工具范围——静态断言只覆盖默认态。
- **`settleMs` 是保守静置**：图表/动画未收敛时会读到中间态；必要时按项目调大。
- **主题媒体特性**：`theme` 未配置时不注入 `prefers-color-scheme`，页面按环境默认走。

---

## 11. 与 trader 的关系（首个接入项目）

- **`~/.openclaw`（本仓库）**：引擎与本文档。
- **`trader` 仓库**：`.ui-align.json`（配置）+ `web-client/tools/ui-align/*.json`（清单）；
  `web-client/tools/ui-align-check.mjs` 保留为**薄封装**（转调本工具，
  保证 `npm run ui-align` 这个既有门禁入口一字不改地继续可用；断言引擎不再重复实现，
  避免两份实现各自漂移）。

trader 基线（2026-09-28 实测）：DOM 断言 37 条 / 8 区块全过；computed style 341 条属性断言 /
不一致 10 / 一致率 **97.1%**（口径与 `tools/ui-align-style-poc.mjs` 的 PoC 逐条一致：
12 目标 × 31 属性）。
