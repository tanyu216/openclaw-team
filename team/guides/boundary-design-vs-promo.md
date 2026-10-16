# 边界 draft — 设计资产（Jobs）vs 推广素材（Assistant） + 设计交付物定义统一

> **状态（provenance · 2026-10-10 已整合）**：本文件原为 draft（产出者 Jobs），其**规范性正文已并入正文档**，本文件保留为**来源记录 + 操作性残留**，不再是规范来源；凡冲突以正文档为准：
> - **归属边界口径**（设计资产 vs 推广素材 / Jobs vs Assistant）⇒ `PROTOCOL §10` 分流矩阵 Jobs 行 + 角色边界「Jobs vs Assistant」；
> - **角色「做/不做/关键输入/关键产出/交接对象」** ⇒ `ROLES.md` Jobs 行。
> 依据：`PROTOCOL §10、§14`（确认门禁/双签）、`PROTOCOL §12`（文档双向同步）、`PROTOCOL §9.1`（原型即契约三层防线）、`PROTOCOL §9.2`（原型禁写实现）、`PROTOCOL §6`（会话编排/载体分流）、`PROTOCOL §6.1` 第 11 条（引用只写「文档名 §章节名」，零行号锚）、`ROLES.md`。
> **原 §4「拟增 §条文清单」(建议 a–d) 已删**：该节是**建议文本**（原文自注「可直接粘贴，或由 Elon 改写后并入」，非生效条款）。(a) 已逐字并入 `PROTOCOL §10` 分流矩阵 Jobs 行（「Excludes promotion-material production·placement and promotion·marketing copy (→ assistant); UI copy = jobs」），(b) 并入 `PROTOCOL §10` 角色边界「Jobs vs Assistant」，(c) 的交付物清单由 `PROTOCOL §10` 分流矩阵/`PROTOCOL §6` + `roles/jobs/AGENTS.md` 承载；**(d)（`ROLES.md` Jobs 行「关键产出/交接对象」措辞对齐，原文自注「可选」）从未被采纳** —— 该节删除即连带删去，故在此留痕：如需重启，按 `PROTOCOL §12` 重新提案。

---

## 0. 目的与总原则（正文已并入 `PROTOCOL §10`，此处只留指针）

- **目的**：划定「设计资产（Jobs）」与「推广素材（Assistant）」的归属边界与交接形态；统一「设计交付物」的定义、载体与审核门禁。
- **总原则**（正文见 `PROTOCOL §10`）：① **Jobs = 审美与设计风格唯一裁决者**（品牌视觉/界面视觉/交互/设计规范/视觉资产归 Jobs）；② **Assistant = 推广/运营/客服执行**，**其视觉必须遵循 Jobs 统一风格规范（色板/字体/token），不得自定设计风格**；③ **一句话分界：定义「长什么样、为什么这样」= Jobs；把「已定义的样子」铺到推广渠道 = Assistant**；④ **越界不可静默** ⇒ 回发 Elon 建卡（worker 不互派单，`PROTOCOL §10`）。

---

## 1. Jobs 行边界（已并入 `ROLES.md` Jobs 行）

Jobs 的「做」以**设计定义与视觉资产**为界（产品设计/PRD/UI/UX/图片设计五项 + 审美与设计风格主权 + UX/UI `review_of` 评审 + 需求-实现一致性基线）；**不含**后端与业务代码 / 功能测试执行 / 量化研究 / **推广物料制作与投放、推广·营销文案**（归 Assistant）。**界面 UI 文案 = Jobs**（属 UI/UX 设计）；**推广/营销文案 = Assistant**。静态视觉资产（插画/Logo/海报/主视觉）**创作**归 Jobs，**推广场景下的物料复用与排版投放**归 Assistant（复用须符合 Jobs 规范）。完整「做/不做/关键输入/关键产出/交接对象」见 `ROLES.md` Jobs 行。设计交付物定义见 §2。

---

## 2. 设计交付物定义统一（载体 + 产出方式 + 审核门禁；`PROTOCOL §10` 未逐项，保留于此）

> 「设计交付物」= **Jobs 五项职责**的最终产物；均落任务工作区 `workspace/<task-id>/`（L5），按 `PROTOCOL §6` 载体分流产出。

| # | 交付物 | 载体 / 形态 | 产出方式（`PROTOCOL §6` 工具链） | 审核门禁 |
|---|---|---|---|---|
| 1 | **PRD / 需求文档 / 功能规格** | Markdown | **Claude Code 子会话**产出（Jobs 主导规划 → 子会话撰写） | **Elon 审议双签 `PROTOCOL §14`**（产品设计文档终稿） |
| 2 | **产品方案 / 设计提案** | Markdown | 同 #1（Jobs 主导规划 + Claude Code） | 含产品设计文档性质 ⇒ `PROTOCOL §14` 双签；纯方向提案 ⇒ Elon 拍板 |
| 3 | **`DESIGN.md` / 设计规范 / `design-style-guide.md`** | Markdown | Claude Code 子会话（或 Pixso 载体）；Jobs 裁决 | Jobs 自审 + **跨页/跨任务风格一致性**比对（`roles/jobs/AGENTS.md` 第 9 条） |
| 4 | **可运行原型（HTML 高保真）** | HTML/CSS/JS（**封闭栈 = Tailwind CSS + daisyUI + jQuery；3D 例外 three.js**） | ① Jobs 出 `design-spec.md`（逐条可执行的详细设计需求规范）→ ② **Claude Code 子会话**编码（只代码、不设计）→ ③ Jobs 验证审核 | **Jobs 按 `design-spec` 逐条比对 + `PROTOCOL §9.1` 结构契约/截图对照**；不达标回退 |
| 5 | **可运行原型（Pixso 载体）** | Pixso 文件 / 导出文件 | **Jobs 直接经 Pixso MCP + `pixso-*` skills**（不 spawn Claude Code） | Jobs review；交付物含 **pixso 链接或导出文件** |
| 6 | **图片（插画 / Logo / 海报 / 主视觉）** | `.png` / `.pdf` + 设计哲学 `.md` | ① Jobs 出 `image-brief.md`（视觉设计简令）→ ② **Claude Code 子会话用 `canvas-design` skill**（先写设计哲学 md → 再出 png/pdf）→ ③ Jobs 审核 | Jobs 审核是否符合 `image-brief` + 项目视觉规范；不符打回子会话修订 |
| 7 | **《问题清单》（UX/UI review）** | Markdown（`workspace/<task-id>/review/`） | Jobs **亲自**（浏览器/工具交互认证：截图/点击流/关键状态） | 回填目标卡；无未决项方可放行（`PROTOCOL §9` 尾节 产品/UX 验收触发） |

**统一口径**：
- **载体二分**：设计物只在 **Pixso 载体** 与 **HTML 载体** 二者择一（图片设计另走 `canvas-design`）；**Jobs 不直写 HTML/CSS/JS，不直出图**（`PROTOCOL §6` 强制红线）。
- **审核门禁二分**：产品设计文档（#1/#2）⇒ `PROTOCOL §14` 双签；原型/图片（#4–#6）⇒ Jobs 自审 + 规范/契约比对。
- **单一风格源**：所有交付物共用**统一设计风格规范**（色板/字体/间距/圆角/组件态/动效 token），风格变更须**显式声明 + 同步受影响产物**（`roles/jobs/AGENTS.md` 第 9 条）。

---

## 3. 与 Assistant 的交接点（`ROLES.md` 行间边界；细节保留于此）

### 3.1 归属矩阵（正文已并入 `PROTOCOL §10` 角色边界）

品牌视觉（Logo/VI/色板/字体/主视觉/品牌 token）= **Jobs**（唯一裁决者，含变更审批）；界面视觉（UI 稿/原型/设计规范/组件态）= **Jobs**（实现基线契约 `PROTOCOL §9.1`）；插画/海报/主视觉（静态图创作）= **Jobs**（经 `canvas-design` 出图）；**推广视觉物料**（投放 banner/社媒图/落地页物料/活动图）= **Assistant**（视觉须遵循 Jobs 品牌规范）；**推广·营销·社媒文案** = **Assistant**；界面 UI 文案 = **Jobs**；推广效果度量/投放台账/客服知识库 = **Assistant**（见 `promo-ops-sop.md` / `ops-ledger-spec.md` / `cs-playbook.md`）。

### 3.2 交接点（Handoff）

| 方向 | 交接物 | 形态 | 规则 |
|---|---|---|---|
| **Jobs → Assistant** | 品牌视觉资产包 | `design-style-guide.md` + 源文件（Logo/色板/字体/主视觉导出） | Assistant 据此制作推广物料，**不得改规范**；缺失资产 ⇒ 回发 Elon 建 Jobs 卡 |
| **Assistant → Jobs** | 推广视觉需求 | 需求描述（用途/尺寸/渠道/调性） | 需**新设计资产/风格变更** ⇒ 回发 Elon 建 Jobs 卡；Jobs 不直收（worker 不互派单 `PROTOCOL §10`） |
| **Jobs → Linus** | 原型 / `DESIGN.md` | HTML 构建产物 / Pixso 导出 / md | 作为**实现基线契约**（`PROTOCOL §9.1`）；偏离须书面说明并经 Elon 批准 |
| **Jobs → Elon** | 产品设计文档终稿 | PRD/方案 md | **`PROTOCOL §14` 双签**后方可作下游依据 |

### 3.3 争议/变更裁决

- **审美与风格争议**：Jobs 为**唯一裁决者**；Assistant 认为规范不适配推广场景 ⇒ 提需求，**不自行改风格**。
- **品牌重大变更**（Logo/VI/主视觉更换）：Jobs 定义 + 影响重大/有分歧时**带推荐回发 Elon 拍板**。

---

## 4. 文档影响判定（`PROTOCOL §12`）

本卡触发**归属边界口径**变更（设计资产 vs 推广素材，属 `PROTOCOL §12` 第 1 条「口径」变更）。需同步：`ROLES.md`（Jobs 行 + Jobs 行与 Assistant 行的行间边界）、`PROTOCOL §10`（分流矩阵 Jobs 行 + 角色边界）。**同步责任 = Elon 整合**（本卡为 draft，不改正文，符合 `PROTOCOL §12` 反向回填闭环 + 单一事实源 `PROTOCOL §17`）。卡 `project=__team__`（团队治理），**无项目设计文档影响**。

---

*（draft 结束 · 产出者 Jobs · 供 Elon 整合）*
