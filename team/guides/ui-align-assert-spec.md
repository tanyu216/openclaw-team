# UI 结构断言规格（可机检门禁）

> 归属：`PROTOCOL §⑨.1`（UI 保真度：原型即契约）与 `§⑳.1`（可机检门禁）。
> 适用：所有 UI 卡的「事中结构断言」与「事后验收复跑」。

## 1. 产物契约

每张 UI 卡的工作区产出两个文件（路径 `workspace/<task-id>/`）：

- `ui-selectors.json` —— **选择器清单**（区块枚举），结构：
  ```json
  {
    "page": "<页面标识>",
    "viewports": ["1512", "1240", "980", "760", "430"],
    "blocks": [
      { "name": "顶部导航", "selector": "[data-nav-topbar]", "required": true },
      { "name": "KPI 卡组", "selector": "[data-ov-kpi] .kpi-card", "required": true, "min": 3 }
    ],
    "noHorizontalOverflow": { "viewports": ["1512","1240","980","760","430"] }
  }
  ```
  约定：选择器优先 `data-*` 语义钩子（禁依赖 Tailwind class 名）；**列表须含「一致项」**（防漏项）。

- `ui-check.mjs`（或等价 runner）—— 读 `ui-selectors.json`，在无头浏览器内断言：
  1. 每个 `required` 选择器存在且可见；
  2. `min` 数量达标；
  3. 各视口 `document.scrollingElement.scrollWidth <= clientWidth`（无横向溢出）；
  4. `console/pageerror` 为空。

## 2. 判定

- 断言全过 ⇒ 该卡 UI 结构门禁通过（Linus 交付前必跑；Turing 验收复跑）。
- 任一断言失败 ⇒ 卡不得置 `in_review`/`done`。
- **截图对照**（同视口 × 同主题 × 同语言）保留为**人工/半自动**：批量截图可由脚本预生成，最终比对仍由 Elon 亲验（§⑨.1 硬门槛 #4）。

## 3. 与禁行号的关系

选择器清单只写**区块名 / `data-*` / 选择器**，**禁行号锚点**（沿用 `§⑥.1 第 11 条`）。
