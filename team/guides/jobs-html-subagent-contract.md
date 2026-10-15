# Jobs HTML 原型「自持 sub-agent 独立 session」机制契约

> 卡：`T-20261013-012319-2`（父 epic `T-20261013-012318-2`）· 责任：Jobs（设计/契约）。
> 规格来源：`workspace/T-20261013-012319-2/design-spec.md`（骨架 / HARD 约束 / 已核事实 F1–F8 / 设计裁定 R-1…R-9）。
> 同族对齐对象（只读）：`workspace/T-20261013-012318-3/codex-plugin-lane-contract.md`（Epic A / A1 契约）。**统一的是证据模型，不是引擎。**
> 引用约定：本文只写「文档名 §章节名」，**不使用行号锚**（`PROTOCOL §⑥.1` 第 11 条）。
> 状态：**设计交付**。不改运行时代码/配置、不改产品仓、不改框架仓。事实与规格不符处见 `report.md §2`（以实测为准）。

---

## 1. 概览与范围

### 1.1 Goal

把 `roles/jobs/AGENTS.md` 的 **HTML path** 从

> Jobs 产 `design-spec.md` → spawn **Claude Code** sub-session 写 HTML/CSS/JS → Jobs 复核

改为

> Jobs 产 `design-spec.md` → **Jobs 用 OpenClaw `sessions_spawn` 启动一个 Jobs 自持的独立 sub-agent session** 写 HTML/CSS/JS → Jobs 复核

并定义该机制的**契约面**：会话归属、卡↔sub-agent session 映射、registry 与卡 `## Sessions` 的 backend 表达、G1–G12 证据门、与 `PROTOCOL §⑥` 的逐条对照、`roles/jobs` 三份文件的 before/after 修改点、其它 Jobs 职责不变的证明、风险与回退、`§⑫` 文档同步判定。**其它 Jobs 职责不变。**

### 1.2 Non-goal

- **不改 claude 腿**：Claude Code sub-session（`claude -p` + 确定性 UUIDv5）仍是团队通用 lane 形态；本契约只把 **Jobs HTML path** 这一条支路切到原生 sub-agent，不覆盖、不改动 claude lane 语义。
- **不改 codex 插件 leg**：codex 插件 harness 的落地属 Epic A（`T-20261013-012318-3` → A2 实现 → A3 验证）；本契约只声明**证据模型同族对齐**，不接管其实现。
- **不做实现**：`scripts/**`、`skills/task-ops/**`、`~/.openclaw/**` 的改动不属本卡；本契约只锁定接口与不变量。
- **不改 `PROTOCOL.md`**：与 `§⑥` 现行纪律的矛盾处**只标注「需 Elon 裁决」**，不擅自改 L1。
- **不改团队级红线段**：`team/guides/redlines.core.md` 是生成源（owner=Elon）；E11 只标注、不落改。

### 1.3 术语表

| 术语 | 定义 |
|---|---|
| **HTML path** | Jobs 的 `static-html` 原型制作路径（`prototype/**` 内的 HTML/CSS/JS 设计交付物）。 |
| **native sub-agent session** | 由 OpenClaw `sessions_spawn`（`runtime:"subagent"`）启动的子会话；句柄 = OpenClaw 子会话 id / sessionKey，**不是** shell 子进程 pid。 |
| **自持（Jobs-owned）** | 该 sub-agent session 由 Jobs 本人发起、由 Jobs 复核并收口；归属坐标见 §3。 |
| **harness** | 执行引擎形态。本机制 `harness=native`（OpenClaw 原生 sub-agent）；对照 `harness=cli`（`claude -p` / `codex exec` 子进程）与 Epic A 的 `harness=plugin`（codex app-server embedded turn）。 |
| **seg** | lane 在卡内的分段键，形如 `seg1` / `seg2`；卡 `## Sessions` 的 upsert 键 = `seg:<seg> ·`（**非** owner 域）。 |
| **id_state** | 卡↔会话绑定的状态位：`pending`（已登记、未拿到子会话 id）→ `bound`（已回填子会话 id）。 |
| **JHS（Jobs HTML sub-agent）** | 本文对 `backend=subagent && harness=native` 的 HTML-path lane 的简称。 |
| **判活** | 判定某 lane 是否仍活跃。CLI lane = `kill -0 <pid>`；JHS lane = **子会话可达性**（`subagents` / 会话目录查询），见 §5。 |
| **三步式** | 不变的制作流程：`design-spec.md` → 制作（sub-agent）→ Jobs 复核。 |

### 1.4 已核事实（F1–F8；核实状态以本文实测为准）

| 编号 | 事实（规格口径） | 本文核实状态 |
|---|---|---|
| **F1** | `sessions_spawn`（core）能力面：`runtime:"subagent"`；`agentId`；`model`（覆盖子会话模型）；`context:"isolated"\|"fork"`；`mode:"run"`；`cleanup:"delete"\|"keep"`；`visible`（持久 sidebar session）；`worktree`/`worktreeName`/`worktreeBaseRef`；`completionTarget:"parent"`；`expectsCompletionMessage`；`runTimeoutSeconds`；`lightContext`；继承调用方 tool-policy 上限；**子会话继承父 workspace**。 | **部分核实**：本机 OpenClaw 发行物（Control UI 工具目录）对 `sessions_spawn` 的描述为「Spawn hidden subagent (ephemeral) or visible work session (durable).」⇒ 印证「ephemeral subagent / durable visible session」二态与 `visible` 语义；同目录另有 `sessions_yield`（End turn to receive sub-agent results）、`subagents`（list/cancel 后台工作）、`agents_wait`（Wait for collector subagents.）。**逐参数清单**（`context`/`runTimeoutSeconds`/`worktree*`/`completionTarget` 等）本机无静态 schema 可回读，按规格口径引用，A2 落地前以运行时 schema 复核。 |
| **F2** | `agents_list`（requester=jobs）→ 仅 `jobs`（`allowAny:false`）；`agents.entries` = main/jobs/linus/turing/assistant；`main.subagents.allowAgents=[jobs,linus,turing,assistant]`；**jobs 未配置 `subagents.allowAgents`**。 | **核实（静态面）**：`agents.entries` = main/jobs/linus/turing/assistant；`entries.main.subagents.allowAgents = [jobs,linus,turing,assistant]`；`entries.jobs` 无 `subagents` 键。**偏差**：`openclaw.json` 的 `agents` 下**无 `allowAny` 静态键**（该值来自 `agents_list` 运行时返回，非配置）。 |
| **F3** | `providers.deepseek` 有 `deepseek-v4-pro`、`deepseek-flash`；另有 `minimax`。**全部 agent 现配 `model: deepseek/deepseek-flash`**。 | **核实**：`models.providers.deepseek.models` 含 `deepseek-v4-pro`/`deepseek-flash`；`minimax` provider 存在（`agents.defaults.models` 有 `minimax` 别名）；main/jobs/linus/turing/assistant 的 `model` 均为 `deepseek/deepseek-flash`；`agents.defaults.model.primary = deepseek/deepseek-flash`，fallbacks = `[deepseek/deepseek-v4-pro]`。 |
| **F4** | `plugins.codex.enabled=true`（`global:codex`）；codex CLI `0.161.0`（≥门 `0.149`）；Epic A 契约已落 `team/guides/codex-plugin-lane-contract.md`。 | **部分核实 + 偏差**：插件启用实为 `plugins.entries.codex.enabled=true`；本地安装 `@openclaw/codex` **2026.10.2**，`contracts.tools` 含 `codex_threads`/`codex_plugins`/`codex_session_read`/`codex_session_send`/`codex_session_interrupt` 等。**偏差**：Epic A 契约现落于 `workspace/T-20261013-012318-3/codex-plugin-lane-contract.md`（A1 设计交付），**不在** `team/guides/` 下。codex CLI 版本（`0.161.0`）本会话未能复跑 `codex --version`（命令需审批），按规格口径引用。 |
| **F5** | 团队 registry `~/.openclaw/team/claude-sessions.json`：条目键 `task_id\|owner\|phase\|pid\|session_id\|status\|log\|startedAt\|endedAt`；卡 `## Sessions` 行 `- seg:<seg> · owner:… · backend:… · id:… · phase:… · status:… · pid:…`（upsert 键 `seg:<seg> ·`）；`check-sessions` 做卡↔registry 双向比对（`registry_only`/`card_only` 硬失败）。 | **核实**：本卡 registry 条目实测字段 = `task_id/owner/phase/startedAt/log/status/session_id/pid`（终态加 `endedAt`）；卡 `## Sessions` 行格式逐字一致；`registry.mjs` 去重键实测 = **`task_id\|owner\|phase\|session_id`**；`check-sessions.mjs` 按 `session_id` 对齐、按 `isPidAlive(pid)` 判活，产出 `registry_only`（硬）/`card_only`（硬）/`zombie_registry`（软）/`stale_card_line`（软）/`status_mismatch`（软）。 |
| **F6** | spawn-lane 面：唯一入口 `scripts/spawn-lane.sh`；`BACKENDS = claude\|codex`；`check-handoff` 锚点 `['HANDOFF:v1','## 任务卡','## 上段结论','## 讨论/决策','state.md']`；`role=exec` 断言 `in_progress && claimed_by=owner`；并发帽 `linus/jobs <8`、`turing <3`。 | **核实**：`spawn-lane.mjs` `BACKENDS = ['claude','codex']`；`check-handoff.mjs` `ANCHORS` 逐字一致；`capFor` 与 role 断言与规格一致。 |
| **F7** | 现状 `roles/jobs` 的 Claude 依赖点（HTML 相关）：`roles/jobs/AGENTS.md` Role Duties item 1 static-html 段（"must be done via a Claude Code sub-session" + ①②③）；§Tool Discipline「HTML path」红线 +「Tool scope / HTML path」注；§Pre-Delivery Checklist 两行；`roles/jobs/SOUL.md` 第 5 行；`roles/jobs/IDENTITY.md` theme 行。 | **核实（逐字）**：`workspace-<role>` 部署面 `roles/jobs/AGENTS.md`/`SOUL.md`/`IDENTITY.md` 六处措辞与 F7 一致；对应 before 串见 §9（E1–E10）。 |
| **F8** | 生成红线段：`roles/jobs/AGENTS.md` 的 `BEGIN REDLINES:v1` 段由 `team/guides/redlines.core.md` 生成，勿手改；其第 7 条现写 "writing code goes through Claude Code; testing through codex"（团队级红线，owner 非 Jobs）。 | **核实**：`team/guides/redlines.core.md`（及注入块）第 7 条逐字一致，`owner=Elon`。⇒ 契约**只标注**（E11），不落改。 |

> 三条规格偏差（D-1…D-3）汇总与处置见 `report.md §2`；本文档正文一律以实测口径书写。

---

## 2. 引擎裁定（(a) 原生 sub-agent / (b) codex 插件 harness / (c) 其它）

> **本节为「建议 + 风险」陈述；引擎最终裁定权归 Elon（见本节 2.4）。执行方不预决。**

### 2.1 (a) OpenClaw 原生 sub-agent —— **建议：作为默认引擎**

**建议**：HTML path 默认引擎 = `sessions_spawn({runtime:"subagent", agentId, model, context:"isolated"})`，建议搭配 `mode:"run"` + `expectsCompletionMessage` + `completionTarget:"parent"`，使结果回到 Jobs 回合，并可经 `sessions_send` 追加修订（对应 R-1）。

**理由**：
1. 直接兑现派单口径（「Jobs 用 `sessions_spawn` 启动独立 sub-agent session」），是全卡的存在理由；
2. 去掉外部 `claude -p` CLI + `claude-sessions.json` 胶水 + pid 轮询三重机械（对比现状 F7）；
3. 原生会话目录与可观测（`subagents` / `sessions_history`）、继承调用方 tool-policy 上限、原生 `worktree`、结果回父回合、`runTimeoutSeconds` / `cleanup` 生命周期（F1）；
4. **设计门仍在 Jobs**：`design-spec.md` + 复核权不变，sub-agent 只执行、无设计判断权（R-7）。

**风险**：
- **R1 模型质量**（严重度 高）：现全 agent = `deepseek-flash`（F3）；写 HTML/CSS/JS + jQuery + Tailwind/daisyUI 的成品质量**不足**。缓解见 §2.4 与 §11 R1。
- **R2 判活/对账**（严重度 中）：native sub-agent **无独立 pid**，与现行 `kill -0` 判活、`check-sessions` 对齐口径冲突；且会话在网关进程内，网关重启可能中断在飞 lane。缓解见 §5 / §11 R2。
- **R4 写面越界**（严重度 中）：F1「子会话继承父 workspace」⇒ 若不在本次 spawn 内钉死 cwd，sub-agent 可能写到父 workspace 而非原型仓。缓解见 §6 G2 / §11 R4。
- **归属主体未定**（严重度 低）：F2 显示 jobs **未配置** `subagents.allowAgents` ⇒ (a) 必须回答「子会话跑哪个 agent（self / 专用条目）」——留 §2.4 待裁。

### 2.2 (b) codex 插件 harness —— **建议：不作默认；仅作可选后端；证据模型同族统一**

**建议**：codex 插件 harness **不**作为 HTML path 默认引擎；**仅**在「原型需要 codex 级编码能力且需与 Epic A 统一」时作为 **opt-in 可选后端**。**但其证据/登记模型（G 门族、registry 字段、`## Sessions` harness 段）应与本契约同族统一**——统一的是证据模型，不是引擎。

**理由**：Epic A 已把 codex lane 的 G1–G12、registry 增量字段（`backend`/`harness`/`thread_id`/`id_state`/`seg`）、卡 `## Sessions` 行增量（`harness` 段）、两步回填等钉死（`workspace/T-20261013-012318-3/codex-plugin-lane-contract.md` §3/§4/§5）。两机制**同形**（都无独立 pid、都两步回填、都需判活扩口径），故证据面应共用一套口径，避免团队出现两套并行审计语言。

**风险**：
- codex-only + app-server 版本门（`≥0.149.0`）+ 会改变 Jobs 现「Codex 在工具范围外」的口径（F7 §Tool scope 注）；
- 把**设计生产腿绑到工程引擎**：设计交付物依赖 codex 运行时可判性，故障域从「设计」扩到「工程引擎」（对照 §11 R2）；
- OpenClaw 沙箱激活态下 codex native Code Mode 被关闭（Epic A §11 G-4 同族），原型 lane 的原生执行面受限。

### 2.3 (c) 其它（ACP / 裸 CLI）—— **建议：不采为默认**

**理由**：ACP 当前适配面窄、生命周期与登记面无团队级证据链；裸 `claude -p` / `codex exec` 正是 2026-10-10「单入口」纪律要退休的胶水形态（`PROTOCOL §⑥` 单入口小节；`guides/spawn-lane-sop.md` §2 两类失效）。

**风险**：绕过 ACL 登记 ⇒ 复现 `registry_only` / `card_only` 硬红；无可判版本门；无可观测会话目录。**不建议采纳**。

### 2.4 交 Elon 确认（**不预决**）

- **引擎三选**：(a) 原生 sub-agent / (b) codex 插件 harness / (c) 其它 —— 本契约**建议 (a) 为默认、(b) 为可选后端、(c) 不采**，但**最终由 Elon 裁定**。
- **模型三选**（必须写入风险，见 R1）：① 默认非 Claude 强模型（如 `deepseek/deepseek-v4-pro`）；② 可配（`team.config.json` 增 `prototype.subagent_model`）；③ 允许 Claude 模型经 OpenClaw agent 跑。
- **语义边界待明确**：口径「不再依赖 claude」的边界 = 「不再依赖 **Claude Code CLI**」还是「不再使用 **Claude 模型**」？**逐字待 Elon 明确**（影响选项③是否越界）。
- **子 agent 主体**：JHS 子会话跑 **self（jobs agent）** 还是**专用 agent 条目**（如 `prototyper`，Jobs 名下，配 code-capable 模型）？因 F2 显示 jobs 未配 `subagents.allowAgents`，须一并裁定。

> 以上四项的裁决结果写入 `state.md`；未裁决前**不落地** E1–E10，仅保留本契约设计。

---

## 3. 会话归属契约

### 3.1 归属模型（R-3）

**1 张卡 : N 个 seg : 每 seg = 1 个 Jobs 自持 sub-agent session。**

执行归属改为**双坐标**（同 Epic A §2.1 同族）：

| 坐标 | 值 | 说明 |
|---|---|---|
| `owner`（团队侧） | 卡 `claimed_by` 的 owner（本机制恒为 `jobs`） | 执行权与并发额度仍按 owner 计（`capFor`；jobs < 8）。 |
| `harness_host`（网关侧） | `gateway`（OpenClaw 网关进程） | 子会话由网关持有；lane **不等价于**一个独立 shell 子进程。 |

⇒ 关键结构性差异：CLI lane 是「worker 回合派生的独立子进程（有自身 pid、脱离父进程组存活）」；JHS lane 是「**网关侧的子会话**（句柄 = 子会话 id / sessionKey，无独立 pid）」。该差异驱动 §5、§6 G6/G7、§11 R2。

### 3.2 执行唯一权

`PROTOCOL §⑥` 执行唯一性纪律（卡已 `in_progress` 的新回合只报状态、不重复执行；`heartbeat_at` 新鲜且 `in_progress` ⇒ poll 返回 `fire:false`）在 JHS path 下**保持不变，并加一条**：

**同卡同段同时刻至多 1 个 JHS lane**，由**双条件**守住：
1. **registry 活跃判定**：`claude-sessions.json` 中该 `(task_id, seg)` 存在 `status=running` 且**可达**（见 §5 判活口径）的条目 ⇒ **禁止二次 spawn**；
2. **卡状态双条件**：`status=in_progress` 且 `claimed_by=jobs`。

两条同时满足才允许起新 lane；任一不满足 ⇒ **拒绝 spawn**（稳定拒绝码建议 `jhs_already_running` / `claimed_by_mismatch` / `concurrency_cap`）。**幂等复用**：命中既有可达子会话 ⇒ **复用（`sessions_send` 续跑）**，不新起。

### 3.3 断链 / 重连 / 修订（R-4 尾）

- **resume = 对保留的子会话 `sessions_send`**（native 无 `--session-id`、无 UUIDv5 决定论；**不得**伪装成 claude/codex 的 `--resume` / `codex exec resume` 形态）。
- **保留策略**：spawn 建议 `cleanup:"keep"`（保证可 `sessions_send` 追加修订与事后审计）；若采用 `cleanup:"delete"`，该 seg **不可修订**，修订必须新起 seg，且须在 `state.md` 声明。
- **绑定时以 `(card_id, seg)` 为键**：同一卡同一 seg 恒等；跨 seg 视为不同 lane。
- **断链判定**：`id_state=pending` 且超时（建议 ≤120s，与 Epic A §3.2 同口径）⇒ 判该 seg `failed`，走 §6 G7 对账。
- **网关重启**：`id_state=bound` 后网关重启 ⇒ 按 registry 内已绑定的子会话 id **重新判定可达性**；绑定成功前该 lane 视为不可达。

### 3.4 审批前置（G9）

无人值守 lane 的审批旁路是**会话归属的前置条件**：若审批层会挂起无人应答的回合，则 lane 事实上无法在 Jobs 回合内完成，归属契约失效。契约要求（细节 §6 G9）：JHS 作用域内要么**审批旁路**，要么**fail-fast**（lane 立即判 `blocked` 并回报，**不静默挂起**）。

---

## 4. 卡↔sub-agent session 映射

### 4.1 映射三面（R-4）

| 面 | 载体 | 值 |
|---|---|---|
| 卡面 | 卡 `## Sessions` 行的 `id` 字段 | 绑定前 = `pending`；绑定后 = **OpenClaw 子会话 id** |
| 网关面 | OpenClaw 子会话（`subagents` / 会话目录） | 子会话 id / sessionKey（宿主自赋） |
| registry 面 | `claude-sessions.json` 条目 | `session_id`（= 子会话 id）+ `id_state ∈ {pending,bound}` + `harness=native` + `seg` |

**native 无 `--session-id`**（子会话 id 由宿主 spawn 时自赋）⇒ **不能**像 claude 那样先取确定性 UUIDv5。因此契约定义**两步回填**：

1. **spawn 时 `session-set` 先写 `id:pending`**：`seg/owner=jobs/backend=subagent/harness=native/phase/status=running` 齐全，`pid` 省略或置 `-`；registry 条目 `id_state=pending`、`session_id=pending` 占位。
2. **spawn 成功后（读回子会话 id）二次 `session-set` 覆盖同一 `seg:` 行**：`id:<subsession_id>`、`id_state=bound`；registry 同键覆盖为 `session_id=<subsession_id>`、`id_state=bound`。

卡 `## Sessions` 行的 upsert 键 = `seg:<seg> ·`（`task.mjs` `upsertSectionLine`）⇒ 两步写的是**同一卡内行**，卡面无重复行。**registry 侧去重键问题见 §13 U-4**（与 Epic A §11 G-1 同族）。

### 4.2 唯一写入点（禁止二次半写）

**唯一写入点 = ACL `task.session-set`**（`skills/task-ops/lib/task.mjs` `sessionSet`），一次调用**同时**写卡 `## Sessions` + 团队 registry。**禁止**：
- 只写 registry 不写卡（⇒ `registry_only` 硬红）；
- 只写卡不写 registry（⇒ `card_only` 硬红）；
- 在 ACL 外手改卡/JSON。

### 4.3 与 `handoff` 的衔接

`sessionSet` 在登记 seg 后**自动确保** `workspace/<task-id>/handoff.md` 存在（缺失即生成、已存在不覆盖）。JHS 子会话的**背景包读取仍然适用**（`PROTOCOL §⑥` clause 8）：子会话先读 `handoff.md`（含四锚），再执行卡。子会话**不读牌面**、不引用任务管理（`§⑥` clause 7 保持不变）。

> **注意**：`handoff.md` 现有锚点集（`F6`）为 claude/codex CLI lane 的口径；JHS 不改变锚点集，只沿用。若后续要为 native 增锚，属 `check-handoff` 的 ACL 增量，须另开卡。

---

## 5. registry / ## Sessions 的 backend 表达

### 5.1 backend 值域与 harness 标记（R-5）

- `backend` 值域扩为 **`claude | codex | subagent`**（现 `BACKENDS` 仅 claude/codex）。
- JHS lane **另标 `harness: "native"`**；缺省不写 harness 段 ⇒ 视为历史 CLI lane（向后兼容）。
- **唯一写入点不变**：`task.session-set` → 卡 `## Sessions` + registry 同写；**不得**为 native 另开 registry 面（否则复现 `registry_only`/`card_only`，`guides/spawn-lane-sop.md` §9）。

### 5.2 registry schema 增量字段

| 字段 | 现值 | 增量 | 说明 |
|---|---|---|---|
| `backend` | 无 | 增 `backend ∈ {claude,codex,subagent}` | 让 registry 能独立辨别宿主。 |
| `harness` | 无 | 增 `harness ∈ {native,cli,plugin}` | 仅 `subagent`（native）/ codex 插件（plugin）有意义。 |
| `id_state` | 无 | 增 `id_state ∈ {pending,bound}` | 两步回填状态位。 |
| `seg` | 无（由 `phase` 隐含） | 增 `seg`，并**纳入 registry upsert 键** | 见 §13 U-4（现行键 `task_id\|owner\|phase\|session_id` 在大绑定后会产生两行）。 |

保留既有字段与白名单：`status ∈ {done,closed,failed,running}`（`registry.mjs` `VALID_STATUS`）；终态加 `endedAt`。

### 5.3 `## Sessions` 行格式增量

现状（`task.mjs` `sessionSet` 生成）：

```
- seg:<seg> · owner:<owner> · backend:<backend> · id:<id> · phase:<phase> · status:<running|closed|failed> · pid:<pid> · <ISO8601Z>
```

增量（JHS lane）：

```
- seg:<seg> · owner:jobs · backend:subagent · harness:native · id:<pending|subsession_id> · phase:<phase> · status:<running|closed|failed> · pid:- · <ISO8601Z>
```

- `harness` 段插在 `backend:` 之后（**新增可选段**；claude/codex lane 不写该段，行解析需**向后兼容**）。
- JHS lane **无独立 pid** ⇒ `pid:` 段**省略**或置 `-`；真正的 lane 句柄是 `id`（子会话 id）。
- 只允许经 `task.session-set` 写卡（`PROTOCOL §⑬.3`）；**不在 ACL 外手改卡/JSON**。

### 5.4 判活口径（**需 Elon 裁决**）

现状判活 = `kill -0 <pid>`（`registry.mjs` `isPidAlive`）。JHS lane 无独立 pid ⇒ 契约定义：

> **判活口径由 `kill -0 <pid>` 改为「子会话可达性」**——查 `subagents` / OpenClaw 会话目录（子会话 id 是否仍被网关持有且可 `sessions_send`）。

**连锁影响（实测，F5）**：`check-sessions.mjs` 现按 `session_id` 对齐、按 `isPidAlive(pid)` 判活 ⇒ JHS 行因无 pid 会被判为 `stale_card_line`（软）/ `zombie_registry`（软），**污染门信号**。故该口径变更必须同步 `check-sessions` 的判活与对齐逻辑（见 §8、§12、§13 U-7）。

**此项与 Epic A 的 G-2 同类 ⇒ 标「需 Elon 裁决」**（是否把「子会话可达性」正式纳入 `§⑥` reconcile 判活口径）。

### 5.5 终态同步

`task.session-close <card> <seg> done|failed|closed`（**直传值，勿写 `status=` 前缀**）不变：
- 卡 `## Sessions` 该 `seg:` 行 `status` 改终态，清 `active_session_id`；
- registry 由该行 `id` 反查 `setSessionStatus(task_id, session_id, …)` 置终态 + `endedAt`；
- JHS lane 额外：registry 条目 `id_state` 保持 `bound`；子会话 id 保留（供 `sessions_send` 修订 / 审计）。

---

## 6. 证据门 G1–G12

> 逐门：定义 · 证据位置 · 机读命令（可直接复跑）· 期望 exit/断言 · 责任人。
> 门集来源：`design-spec.md` §3 R-6 + Epic A 同族门集（`workspace/T-20261013-012318-3/codex-plugin-lane-contract.md` §5）。
> 路径约定：`<team>` = `~/.openclaw/team`；`<card>` = 卡 id；`<ws>` = `<team>/workspace/<card>`。
> 机读命令中凡涉 native 专有 CLI 的**形态**标注「A2 定稿」；不变量在此已锁死。

### G1 并发不回归

- **定义**：`running(owner) < cap`（linus/jobs 8、turing 3）；**JHS lane 与 CLI lane 合并计数**（同一 registry）；扇出计入 `running(jobs) < 8`。
- **证据位置**：`<team>/claude-sessions.json`（含 `backend=subagent` 条目）；`<ws>/evidence/concurrency-<ts>.json`（计数快照）。
- **机读命令**：读 registry 统计 `owner=jobs && status=running && 可达` 的条目数（node 单行读 `claude-sessions.json`），或 `node <team>/scripts/registry.mjs active <card>`（判活面，需按 §5.4 扩展）。
- **期望 exit/断言**：计数 `running(jobs) < 8` ⇒ exit 0；达上限 ⇒ 起 lane 被拒，`reason` 含 `concurrency_cap(owner=jobs,running=<n>,cap=8)`。
- **责任人**：linus（实现）/ turing（验证）。

### G2 cwd / 沙箱不回归

- **定义**：子会话 cwd 必须钉死为**原型仓**（`lib.get_project(project).root` + 卡 `target`），**不得**落父 workspace（F1「子会话继承父 workspace」为默认风险）；写面仅限原型仓。
- **证据位置**：spawn 调用参数（`agentId`/`cwd`/`worktree*`）落 `<ws>/evidence/spawn-<ts>.json`；写仓负例后目标仓 `git status --porcelain`。
- **机读命令**：`git -C <repo> status --porcelain`（写入前后各一次）；对父 workspace 做**未预期写**巡检（`git -C <team> status --porcelain` 空）。
- **期望 exit/断言**：原型仓仅出现设计预期的 HTML/CSS/JS 变更；`git -C <team> status --porcelain` 空输出（exit 0）；`<ws>` 内无工程实现落到 `prototype/**` 之外的越界写。
- **责任人**：linus / turing。

### G3 卡↔Sessions 同写

- **定义**：卡 `## Sessions` 行与 registry 条目由**同一次** `task.session-set` 落盘（两步回填的两个时刻各自都是**同一次**同写：pending 同写、bound 同写），无半写窗口。
- **证据位置**：卡 `## Sessions` 的 `seg:<seg> ·` 行；`<team>/claude-sessions.json` 同 `(task_id,seg)` 条目。
- **机读命令**：`node <team>/scripts/check-sessions.mjs`；`grep -c 'seg:seg1 ·' <team>/tasks/<card>.md`。
- **期望 exit/断言**：`check-sessions` exit 0，无 `registry_only` / `card_only`；卡行与 registry 条目的 `id`/`status`/`backend`/`harness` 一致。
- **责任人**：linus。

### G4 确定性 / 可修订

- **定义**：native 无 UUIDv5、无 `--session-id` ⇒ 契约 = **记录子会话 id + `sessions_send` 续接断言**（同子会话续跑、transcript 连续；**非**提示词重放）。
- **证据位置**：registry `session_id` + `id_state:bound`；卡 `## Sessions` 行 `id`；续接前后子会话记录（落 `<ws>/evidence/`）。
- **机读命令**：对已绑定子会话发 `sessions_send`（marker 回读），随后回读子会话记录查 marker（命令形态 A2 定稿）。
- **期望 exit/断言**：续接 exit 0；续接后子会话记录含前次写入 marker；**非空跑对照**：新起子会话答不出 marker。
- **责任人**：linus / turing。

### G5 机读命令 + exit 证据

- **定义**：lane 起/终都产出机读证据；命令面 = `sessions_spawn` 的 receipt（`ok` + 子会话 id/handle）；产物面 = 子会话输出落 `*.out.jsonl`（NDJSON，末行 `type=result`）。
- **证据位置**：`<ws>/evidence/spawn-<ts>.json`（receipt）；`<ws>/<owner>-<n>.out.jsonl`（NDJSON）。
- **机读命令**：`jq -e '.ok==true and .backend=="subagent"' <ws>/evidence/spawn-<ts>.json`；`tail -1 <ws>/<owner>-<n>.out.jsonl | jq -e '.type=="result"'`。
- **期望 exit/断言**：两命令 exit 0；`out.jsonl` 存在且非空、末行 `type=result`、含 `exit_code` 字段（对照 `PROTOCOL §⑥` 子会话「先落文件」纪律）。
- **责任人**：linus。

### G6 卡↔sub-agent session 映射

- **定义**：卡 id + seg ↔ 子会话 id ↔ registry 条目**双向可查**。
- **证据位置**：registry `session_id` + `id_state` + `seg`；卡 `## Sessions` 行 `id`；网关侧 `subagents` / 会话目录。
- **机读命令**：node 单行读 `claude-sessions.json` 取 `(task_id,seg)` 条目的 `session_id`；`subagents` 查询（形态 A2 定稿）命中该 id。
- **期望 exit/断言**：registry `session_id` 非空且 `id_state=bound`；网关侧命中该 id（exit 0）；卡行 `id` == registry `session_id`。
- **责任人**：linus / turing。

### G7 网关重启对账不丢终态

- **定义**：网关重启后，registry `status=running` 但**子会话不可达** ⇒ 由 reconcile 置 `failed` 并**保留卡终态**（不丢终态；`terminal_immutable` 不被触发/不改写）。
- **证据位置**：reconcile 台账 `<ws>/evidence/reconcile-<ts>.md`；卡 `## Sessions` 行 status；卡 frontmatter `status`。
- **机读命令**：`node <team>/scripts/registry.mjs active <card>`（判活，需按 §5.4 扩展）；`grep 'seg:seg1 ·' <team>/tasks/<card>.md`。
- **期望 exit/断言**：重启窗口后，不可达 `running` 条目被置 `failed`（registry `status=failed` + `endedAt`）；卡 `## Sessions` 行 `status` 更新为 `failed/closed`，而卡 **frontmatter `status` 保持其既有态**（终态不被会话关闭反写，`PROTOCOL §①` 终态不可逆）。
- **责任人**：linus。

### G8 日志/会话记录 24h 内导出到 workspace

- **定义**：网关日志与会话记录存在滚动/prune 窗口（参照 Epic A §5 G8 的 24h 口径）⇒ 契约规定：**lane 启动即 + 终态前各一次**，把子会话记录/网关日志导出到 `<ws>/evidence/`，并记 `exported_at`。
- **证据位置**：`<ws>/evidence/subagent-<ts>.log` / `<ws>/evidence/subagent-<ts>.jsonl`；`<ws>/evidence/manifest.json`（`exported_at` / `lane_seg` / `source`）。
- **机读命令**：`test -s <ws>/evidence/subagent-*.log`；`jq -e '.exported_at' <ws>/evidence/manifest.json`。
- **期望 exit/断言**：导出文件存在且非空；`exported_at` 距 lane 启动 ≤24h，且在**卡终端态之前**已落盘。
- **责任人**：linus。

### G9 审批不阻塞无人值守 lane

- **定义**：无人值守 lane 下审批/确认**不阻塞**（旁路策略或 fail-fast 语义）。
- **证据位置**：spawn 作用域的审批策略（`<ws>/evidence/spawn-<ts>.json`）；网关日志中 pending 审批计数；一次无人应答 lane 的终态。
- **机读命令**：`jq -r '.approvalPolicy' <ws>/evidence/spawn-<ts>.json`；`grep -c 'approval' /tmp/openclaw/openclaw-*.log`（形态 A2 定稿）。
- **期望 exit/断言**：策略 = 旁路（或声明 fail-fast）；无人应答 lane 达**正常终态**（非挂起）；pending 审批计数在 lane 期间不增。
- **责任人**：linus。

### G10 引擎显式 N/A 声明

- **定义**：本门**本身**即「引擎 N/A 声明门」——对 claude lane / codex 插件 harness / native sub-agent 三者，逐门显式标注「适用」或「N/A + 理由」，**不得**用「未验证」代替「N/A」。
- **证据位置**：本契约 §7 引擎 N/A 表。
- **机读命令**：`grep -c 'N/A' <ws>/jobs-html-subagent-contract.md`（覆盖各门）；人读复核 §7 逐门完整。
- **期望 exit/断言**：G1–G12 每门对三引擎均给「适用」或「N/A + 理由」；无空项。
- **责任人**：jobs（本契约）/ turing（复核）。

### G11 版本门 + doctor

- **定义**：native 无外部 CLI 版本门 ⇒ 版本门 = **OpenClaw 自身版本 + 子会话运行时可判**（`openclaw status` / `openclaw doctor`）。
- **证据位置**：`openclaw --version` 输出；`openclaw status` 输出；`openclaw doctor` 输出；`<ws>/evidence/doctor-<ts>.json`。
- **机读命令**：`openclaw --version`；`openclaw status`；`openclaw doctor`。
- **期望 exit/断言**：`openclaw --version` 与卡内登记的运行时版本一致；`openclaw status` exit 0 且网关在线；`openclaw doctor` exit 0。
- **责任人**：linus。

### G12 引擎可判

- **定义**：`agents_list`（requester=jobs）+ `sessions_spawn` receipt 使「引擎是否可用 / 子会话是否起得来」**可判**（非静默失败）。
- **证据位置**：`agents_list` 返回（`<ws>/evidence/agents-<ts>.json`）；`sessions_spawn` receipt（`<ws>/evidence/spawn-<ts>.json`）。
- **机读命令**：调用 `agents_list` 并断言返回含可派发 agent（形态 A2 定稿）；`jq -e '.ok==true' <ws>/evidence/spawn-<ts>.json`。
- **期望 exit/断言**：`agents_list` 非空且含本机制要派的 agent；receipt `ok=true` 且含子会话 id；（对照 F2）若 `allowAgents` 未放行 ⇒ 显式拒绝语义，不静默。
- **责任人**：linus / turing。

---

## 7. 引擎 N/A 表

> 逐门标注：`适用` = 该门对该引擎有意义且受本契约/同族契约约束；`N/A` = 该门对本引擎不适用，**附理由**。禁止用「未验证」代替「N/A」。

| 门 | native sub-agent（JHS，本机制） | claude lane（CLI） | codex 插件 harness（Epic A） |
|---|---|---|---|
| **G1 并发** | 适用（**本门核心**：JHS 与 CLI 合并计数，扇出计入 `running(jobs)<8`） | 适用（现行 `running<8` 纪律不变） | 适用（同族：与 CLI 合并计数） |
| **G2 cwd+沙箱** | 适用（**本门核心**：子会话继承父 workspace ⇒ 必须钉死原型仓 cwd） | 适用（现行 cwd 归一 + 沙箱） | 适用（沙箱值域映射，Epic A §8.5） |
| **G3 卡↔Sessions 同写** | 适用（两步回填皆同写） | 适用（现行单次同写） | 适用（两步回填皆同写） |
| **G4 确定性/可修订** | 适用（改为子会话 id + `sessions_send` 续接断言；无 UUIDv5） | 适用（确定性 UUIDv5 + `--resume <id>`，形态**不变**） | 适用（thread_id + resume 断言） |
| **G5 机读+exit** | 适用（receipt + `*.out.jsonl`） | 适用（现行 `--dry-run` JSON + `*.out.jsonl`） | 适用 |
| **G6 卡↔会话映射** | 适用（**本门核心**：卡 id ↔ 子会话 id ↔ registry） | **N/A**（claude 无 native sub-agent 概念；其 id 为确定性 UUIDv5，映射由 `## Sessions` 单面承担，无独立「网关面」） | 适用（卡 ↔ native thread id） |
| **G7 网关重启对账** | 适用（**本门核心**：JHS 子会话在网关进程内，随网关重启而中断） | **N/A**（claude lane 为独立子进程，不随网关重启；现行 `kill -0` reconcile 已覆盖） | 适用（Epic A §5 G7） |
| **G8 日志/记录 24h 导出** | 适用（子会话记录/网关日志有滚动窗口） | **N/A**（claude lane 输出落 `<ws>/*.out.jsonl`，无网关 prune 问题） | 适用（插件/网关日志 24h prune） |
| **G9 审批不阻塞** | 适用（**本门核心**：审批层挂起即归属失效） | **N/A**（claude 侧信任 / `--permission-mode`，无独立审批层） | 适用（插件多层审批） |
| **G10 引擎 N/A 声明** | 适用（**本门 = 声明门本身**） | 适用（被声明对象） | 适用（被声明对象） |
| **G11 版本门+doctor** | 适用（native 门 = OpenClaw 版本 + `status`/`doctor` 可判） | **N/A**（claude lane 无 app-server 版本门，版本由 CLI 自身承担） | 适用（codex app-server 版本门 ≥0.149.0） |
| **G12 引擎可判** | 适用（`agents_list` + spawn receipt） | **N/A**（claude lane 由 `spawn-lane` 单入口可判，不涉 `agents_list` 派发面） | 适用（`openclaw plugins inspect codex`） |

**一句话**：native sub-agent 与 codex 插件 harness **同形**（无独立 pid、两步回填、网关内会话）⇒ G6/G7/G8 对二者**适用**而对 claude lane **N/A**；其余通用编排门（G1/G2/G3/G5/G10）对三者**适用**。**三处以上 N/A 已显式声明**（本表 `N/A` 共 7 处，分布 G6/G7/G8/G9/G11/G12 对 claude lane）。

---

## 8. 与 PROTOCOL §⑥ 现行纪律对照（新增·变更点清单）

> 逐条对照 `PROTOCOL §⑥`（会话编排纪律）：执行唯一性 / 并发额度 / cwd+沙箱 / 登记 / 终态 / reconcile / 单入口 / 会话关联与 resume。矛盾处**显式标注「需 Elon 裁决」**。

| `§⑥` 纪律 | 现行口径 | JHS 新增·变更点 | 矛盾？ |
|---|---|---|---|
| **红线段（`§⑥` 顶部强制红线）** | 「Jobs 产 design drafts/PRD/specs/DESIGN.md/runnable prototypes（HTML path）**must go through a Claude Code subsession**」 | **变更**：HTML path 改走 **Jobs 自持 sub-agent session**（`sessions_spawn`）；MCP design-tool path / image path / product-doc path **不变** | **需 Elon 裁决**：该红线是 L1 正文，E1–E10 只改 L2（`roles/jobs/*`）；L1 `§⑥` 红线段是否同步改写须 Elon 定 |
| **执行唯一性**（`§⑥`「执行唯一性」小节） | 卡 `in_progress` 的新回合只报状态、不重复执行 | **不变 + 加一条**：同卡同段至多 1 个 running JHS lane（双条件，§3.2） | **无变更**（沿用 + 一条同族约束） |
| **并发额度**（`§⑥` 第 2 条） | `running(owner)` 按 owner 计（linus/jobs<8、turing<3），判活 = pid 存活 | **新增**：JHS 与 CLI lane **合并计数**（同 registry）；registry 条目须带 `backend/harness` 以辨宿主 | **无变更**（沿用 `capFor`；仅要求 registry 能识别 native 条目） |
| **cwd + 沙箱**（`§⑥` 第 3 条 / cwd 归一） | cwd 由 `project`+`target` 经 ACL 解析；子会话 cwd = 项目根 | **新增**：native 子会话**继承父 workspace**，故必须**在 spawn 时显式钉死原型仓 cwd**（否则越界写，§11 R4）；沙箱面继承调用方 tool-policy 上限 | **需 Elon 裁决**：现行 cwd 归一假设「spawn 的子进程 heredoc cwd」；native 子会话的 cwd 钉死形态（`cwd`/`worktree*` 参数 vs 提示词约束）须 A2 定稿并裁定是否写入 `§⑥` |
| **登记**（`§⑥` 第 8 条 / registry 字段） | 一条 `task.session-set` 写卡 `## Sessions` + registry（含 pid），spawn 后**立即**登记 | **新增**：registry 增 `backend/harness/id_state/seg`（§5.2）；`## Sessions` 行增 `harness` 段、`pid` 省略/`-`（§5.3）；**两步回填**（pending→bound） | **需 Elon 裁决**：现行「spawn 后立即**完整**登记（含 pid）」假设存在子进程；JHS 无独立 pid ⇒ 登记改「pending 先写、bound 后覆盖」；是否放宽「立即完整登记」口径 |
| **终态**（`§⑬.2` / `session-close`） | `task.session-close <card> <seg> done\|failed\|closed`；卡行 status + registry `setSessionStatus` + `endedAt` | **不变**；JHS 额外保留子会话 id（供 `sessions_send` 修订/审计），`id_state` 保持 `bound` | **无变更** |
| **reconcile**（`§⑥` 第 1 条 / `kill -0`） | 判活 = `kill -0 <pid>`；僵尸清理/接管 | **变更**：JHS 无独立 pid ⇒ 判活扩为「`isPidAlive(pid)` **或** 子会话可达性」；并须同步 `check-sessions` 判活/对齐（§5.4） | **需 Elon 裁决**：是否把「子会话可达性」正式纳入 `§⑥` reconcile 口径（与 Epic A G-2 同类） |
| **单入口 spawn-lane**（`§⑥` 单入口小节 / `guides/spawn-lane-sop.md` §1） | 新 lane 只能经 `scripts/spawn-lane.sh`（claim → handoff → spawn → session-set）；直跑 `claude -p`/`codex exec` 不登记 = 违规 | **变更**：JHS **不是 shell lane**（不经 `claude -p`/`codex exec`），由 `sessions_spawn` 直连网关起会话 ⇒ 单入口纪律需**扩展**（spawn-lane 增 native 分支）或**显式排除**并为 JHS 指定等价登记路径（`task.session-set` 两步回填） | **需 Elon 裁决**：单入口纪律是否要求 JHS 也经 `spawn-lane`（若否，须显式声明例外并保证 G3/G6 证据不降级）。**此为本节最关键矛盾点** |
| **会话关联与 resume**（`§⑥` 第 3/8 条） | claude = 确定性 UUIDv5 + `--resume <id>`；codex = 自赋 id + `codex exec resume <id>` | **变更**：native 无 `--session-id`、无 UUIDv5 ⇒ resume = 对保留子会话 `sessions_send`；**不得**伪装成 claude/codex resume 形态 | **需 Elon 裁决**：`§⑥` clause 8 列举的 resume 形态需否补入 native（`sessions_send`）第四形态 |
| **子会话不读牌面**（`§⑥` clause 7） | 子会话不引用任务管理，卡信息由 worker 转写进 prompt/CLAUDE.md | **不变**：JHS 子会话同样不读牌面；背景包经 `handoff.md` 注入（§4.3） | **无变更** |

> 结论：十条纪律中 **四条无变更**（执行唯一性 / 并发额度 / 终态 / 子会话不读牌面），**六条含变更且各有一处矛盾点，均标注「需 Elon 裁决」**（L1 红线段、cwd 钉死形态、两步登记、reconcile 判活、单入口归属、resume 第四形态）。矛盾点汇总见 §13。

---

## 9. roles/jobs AGENTS before/after 修改点（逐处）

> 覆盖 E1–E12；逐处 before/after，**不改向**（R-9 基线）。落改属下游卡；本契约为设计交付。
> **未获 §2.4 引擎/模型裁定前，E1–E10 不落改**（避免先落地后返工）。

#### E1 `roles/jobs/AGENTS.md` · Role Duties item 1 · static-html 段引导句

- **before**：`"...it **must be done via a Claude Code sub-session**, in three steps:"`
- **after**：`"...it **must be done via a Jobs-owned sub-agent session** (OpenClaw \`sessions_spawn\`), in three steps:"`

#### E2 同段 ①

- **before**：`"...so Claude Code **needs no design judgement of its own**;"`
- **after**：`"...so the sub-agent **needs no design judgement of its own**;"`

#### E3 同段 ②

- **before**：`"**Spawn a Claude Code sub-session** to write **HTML/CSS/JS** … — Claude Code only edits code, takes no part in design decisions; orchestration discipline same as Linus: register \`claude-sessions.json\`, concurrency <8, cwd normalized, output to files, poll to terminal state);"`
- **after**：`"**Spawn a Jobs-owned sub-agent session** via OpenClaw \`sessions_spawn\` (\`runtime:"subagent"\`, \`context:"isolated"\`) to write **HTML/CSS/JS** … — the sub-agent only edits code, takes no part in design decisions; orchestration discipline: register the sub-agent session (card \`## Sessions\` + team registry, one ACL step), concurrency <8, cwd normalized to the prototype repo, output to files, await to terminal state);"`

#### E4 同段 ③

- **before**：`"…mismatch ⇒ send back to Claude Code for revision (never hand-edit yourself)."`
- **after**：`"…mismatch ⇒ send back to the sub-agent session (\`sessions_send\`) for revision (never hand-edit yourself)."`

#### E5 `roles/jobs/AGENTS.md` · §Tool Discipline 红线「HTML path」

- **before**：`"② **spawn Claude Code** to code per spec (Claude Code only edits code…"`
- **after**：`"② **spawn a Jobs-owned sub-agent session** to code per spec (the sub-agent only edits code…"`

#### E6 同段「Tool scope」注

- **before**：`"> - **HTML path**: **allowed and required** to spawn a **Claude Code** sub-session (only for HTML/JS code editing); orchestration discipline same as Linus (\`claude-sessions.json\`, concurrency <8, normalized cwd, output to files, poll to terminal state). **Codex is still outside Jobs's tool scope.**"`
- **after**：`"> - **HTML path**: **allowed and required** to spawn a **Jobs-owned sub-agent session** via OpenClaw \`sessions_spawn\` (only for HTML/JS code editing); orchestration discipline same as Linus (register the sub-agent session on card + registry, concurrency <8, normalized cwd, output to files, await to terminal state). **Claude Code sub-sessions and Codex remain outside Jobs's tool scope for the HTML path.**"`

#### E7 §Pre-Delivery Checklist · carrier 行

- **before**：`"…**HTML path** ⇒ produce design-spec.md → **spawn Claude Code to code (Jobs hand-writes nothing)** → Jobs verifies & reviews"`
- **after**：`"…**HTML path** ⇒ produce design-spec.md → **spawn the Jobs-owned sub-agent session to code (Jobs hand-writes nothing)** → Jobs verifies & reviews"`

#### E8 §Pre-Delivery Checklist · HTML path 行

- **before**：`"…(all HTML/CSS/JS produced via Claude Code; …); …; Claude Code orchestration registered in the registry"`
- **after**：`"…(all HTML/CSS/JS produced via the Jobs-owned sub-agent session; …); …; sub-agent session registered on the card + registry"`

#### E9 `roles/jobs/SOUL.md` 第 5 行

- **before**：`"**design/prototypes/images are always produced via a Claude Code sub-session, never hand-written**"`
- **after**：`"**design docs/images via a Claude Code sub-session；HTML prototypes via a Jobs-owned sub-agent session（OpenClaw \`sessions_spawn\`）—— 一律非亲手写**"`

#### E10 `roles/jobs/IDENTITY.md` theme 行

- **before**：`"UX/UI quality gate (via Claude Code / MCP design tool)"`
- **after**：`"UX/UI quality gate (via a Jobs-owned sub-agent / Claude Code / MCP design tool)"`

#### E11（团队级，标「需 Elon 双签」）· `team/guides/redlines.core.md` 第 7 条

- **现状**：`"writing code goes through Claude Code; testing through codex"`
- **待裁**：是否需为 Jobs HTML 原型**划范围**（"HTML prototype code via the Jobs-owned sub-agent"）。
- **处置**：**契约只标注、不落改**（`redlines.core.md` 是生成源，生成件 `roles/*/AGENTS.md` 红线段禁手改，owner=Elon）。**需 Elon（+ 团队级双签）裁决**。

#### E12（范围外，仅声明）· `guides/spawn-lane-sop.md` §1

- **现状**：§1 把 lane 限定为 `claude -p` / `codex exec` 子会话。
- **问题**：Jobs 的 sub-agent session **不是 shell lane**（不经 `claude -p`/`codex exec`）。
- **处置**：须在 `§12` 声明「该 SOP 范围需**扩展**或**显式排除** HTML sub-agent」+ 登记等价物（R-4/R-5：`task.session-set` 两步回填 + 子会话可达性判活）。**不改向、不改 SOP 正文**；是否扩展由 §8 单入口裁决联动。

---

## 10. 「其它 Jobs 职责不变」证明

> R-8：下列各项**不动**，逐条给「不变」+ 证据锚。

| # | 职责 | 状态 | 证据锚 |
|---|---|---|---|
| ① | **产品文档 SOP**（item 7） | **不变**：仍 Claude Code sub-session 产出，Elon 双签后方可作下游输入 | `roles/jobs/AGENTS.md` §Role Duties item 7（①–④）；`PROTOCOL §⑥` 红线段「Product design documents」；`PROTOCOL §⑭` Confirmation Gate |
| ② | **图像设计 SOP**（item 8） | **不变**：仍 Claude Code sub-session 加载 `canvas-design` skill（设计哲学 .md → .png/.pdf） | `roles/jobs/AGENTS.md` §Role Duties item 8（①–③）；`PROTOCOL §⑥` 红线段「Image-design path」 |
| ③ | **MCP carriers**（figma/google-stitch/pixso） | **不变**：直连 MCP + 本 workspace 配套 skill，**不 spawn** Claude Code/Codex（更不 spawn sub-agent） | `roles/jobs/AGENTS.md` §Role Duties item 1（figma/google-stitch/pixso 三段）；`PROTOCOL §⑥` 红线段「MCP design-tool path」；`guides/task-interface.md` §2（project 解析） |
| ④ | **Review round**（item 2） | **不变**：ux-review 清单 + 浏览器认证 + issue list 落 `workspace/<task-id>/review/`；item 1 各 carrier 一致 | `roles/jobs/AGENTS.md` §Role Duties item 2；`PROTOCOL §⑨.1`（三线防御：before=Jobs / during=Linus / after=Turing+Jobs 视觉） |
| ⑤ | **Prototype Tech-Stack Spec**（封闭栈） | **不变**：`Tailwind CSS` + `daisyUI` + `jQuery`（3D 例外 `three.js`）；`data-*` 语义钩子；禁其它框架/UI 库 | `roles/jobs/AGENTS.md` §Prototype Tech-Stack Spec 第 0–5 条；`PROTOCOL §⑥` 红线段封闭栈小节 + `§⑥.1` clause 14（Linus 工程栈与原型栈分层、互不冲突） |
| ⑥ | **Requirement-alignment baseline 归属** | **不变**：Jobs owns「what to build」基线（PRD/`DESIGN.md`/原型结构契约 + block list），Turing 独立核对 | `roles/jobs/AGENTS.md` §Requirement–implementation alignment 段；`PROTOCOL §⑥.1` clause 13；`ROLES.md` Jobs 行 |
| ⑦ | **并发/cap/复核/终态纪律** | **不变**：`running(jobs)<8`、iteration cap 4 轮、终态不可逆、§⑬.2 三件套 | `PROTOCOL §⑥` 第 2 条 + `§⑥.3`；`ROLES.md` 顶部；`PROTOCOL §①` 终态不可逆；`PROTOCOL §⑬.2` |
| ⑧ | **保护红线** | **保留**：「**Jobs 不亲手写 HTML/CSS/JS**」改写为「**Jobs 不亲手写 HTML/CSS/JS —— 由 Jobs 自持的 sub-agent session 写，Jobs 复核**」；封闭技术栈不变；三段式（`design-spec.md` → 制作 → Jobs 复核）不变 | 本契约 §9 E1–E10（措辞改写）；`roles/jobs/AGENTS.md` §Tool Discipline；`PROTOCOL §⑥` 红线段 |

**结论**：本机制**只替换 HTML path 的制作执行体**（Claude Code sub-session → Jobs 自持 sub-agent session），其余 ①–⑦ 全部不动、⑧ 仅按 R-7 措辞改写。**其它 Jobs 职责不变。**

---

## 11. 风险 R1–R5（缓解 / 回退 + 再评估触发）

> 源头：`design-spec.md` §3 R-2 模型风险 + R-5 判活/登记变更 + 同族 Epic A §9 风险面。

### R1 模型质量不足（严重度：高）

- **依据**：F3——全部 agent 现配 `deepseek/deepseek-flash`；写 HTML/CSS/JS + jQuery + Tailwind/daisyUI 的质量**不足**（R-2 明列）。
- **缓解**：**新建专用 agent 条目**（如 `prototyper`，Jobs 名下，配 code-capable 模型）**或** per-spawn `model` 覆盖（如 `deepseek/deepseek-v4-pro`）。**三选待 Elon 裁定**（§2.4）。
- **回退**：模型输出不达设计门 ⇒ 按 §9 E4「send back to the sub-agent session（`sessions_send`）for revision」，超 4 轮仍不达 ⇒ 卡 `blocked` + 回 Elon。
- **再评估触发**：团队出现稳定达标的 code-capable 非 Claude 模型；或 Terry 口径「不再依赖 claude」的语义边界被明确为「不再用 Claude **模型**」（则选项③合法化）。

### R2 判活/对账缺口（严重度：中）

- **依据**：JHS 无独立 pid（R-5）；会话在网关进程内，网关重启可能中断在飞 lane（同族 Epic A §9 R2 的网关重启面）。
- **缓解**：§5.4 判活扩为「子会话可达性」；§6 G7 网关解耦对账（registry 不可达 ⇒ `failed`，卡终态保留）；`cleanup:"keep"` 保留子会话供重判。
- **回退**：判活不可判 ⇒ 该 seg 不计入验收证据（判 `failed`），改回 claude lane 重做该段。
- **再评估触发**：官方提供 lane 级持久化/恢复；或离线数据表明网关重启不再中断在飞 lane。

### R3 registry 去重键在大绑定后产生两行（严重度：中）

- **依据**：实测 `registry.mjs` 去重键 = `task_id|owner|phase|session_id`（F5）。两步回填使 `session_id` 由 `pending` → `<subsession_id>` ⇒ **产生两行**（pending 残留），破坏「覆盖同一行」预期（与 Epic A §11 G-1 同族同因）。
- **缓解**：把 `seg` 纳入 registry upsert 键（§5.2）；或绑定步显式关闭 pending 行（置 `closed`）。
- **回退**：键变更不可行 ⇒ 绑定步以「先 `session-close` pending 行、再 `session-set` bound 行」两步显式收敛，并在 `state.md` 留痕。
- **再评估触发**：registry 去重键正式纳入 `seg`（实现落地）后本风险消解。

### R4 写面越界（子会话继承父 workspace）（严重度：中）

- **依据**：F1「子会话继承父 workspace」⇒ 若 spawn 未钉死 cwd，sub-agent 可能写到父 workspace 或 `prototype/**` 之外（违反 `PROTOCOL §⑨.2` 原型纯净、污染 `§⑨.1` 单写者纪律）。
- **缓解**：§6 G2——spawn 时显式钉死原型仓 cwd（`cwd`/`worktree*`），写面仅限原型仓；落 `git status --porcelain` 前后证据；可选原生 `worktree` 隔离（`guides/worktree-isolation-sop.md`）。
- **回退**：越界写 ⇒ 判该 lane evidence 无效 + 按 Git 纪律前向修正（**禁用** rebase/reset/stash/clean，`PROTOCOL §⑥` Git 纪律）。
- **再评估触发**：native spawn 提供强制 cwd 沙箱（不可越界）能力。

### R5 合规/越权语义边界（严重度：中）

- **依据**：F8——团队级红线第 7 条「writing code goes through Claude Code」（owner 非 Jobs）；且 Terry 口径「不再依赖 claude」的语义边界未定（§2.4）。JHS 可能被读作「Jobs 越过团队级红线自行产码」。
- **缓解**：本契约**显式标注**（E11「需 Elon 双签」）+ §2.4 语义边界请裁；在裁决前**不落地** E1–E10；`SOUL.md` 保持「不 spawn openclaw agents」类红线不变。
- **回退**：裁决为「红线禁止」⇒ HTML path 维持 Claude Code sub-session，本契约降级为「备选引擎设计稿」。
- **再评估触发**：红线第 7 条为 HTML-proto 划出范围（双签落地）；或语义边界明确为「不再依赖 Claude Code CLI」。

---

## 12. §⑫ 文档同步判定

**判定：有文档影响**（本卡触及接口 / 数据结构 / 约定变更：`## Sessions` 行 schema、registry 字段、resume 形态、判活口径、引擎约定）。需同步章节如下——**由下游实现卡落地时按 `§⑫` 反向回填同步**（本契约为设计交付，只定义、不改文档）：

| 目标文档 | 需同步章节 | 变更要点 |
|---|---|---|
| `PROTOCOL.md` | `§⑥` 顶部红线段（「HTML path must go through a Claude Code subsession」） | 改为「Jobs 自持 sub-agent session」；**需 Elon 裁决**（L1 正文） |
| `PROTOCOL.md` | `§⑥` 第 2 条（并发额度）、第 3 条（cwd 归一注）、第 8 条（会话关联与 resume）、单入口小节 | JHS 与 CLI 合并计数；native cwd 钉死；resume = `sessions_send`；单入口是否覆盖 JHS |
| `PROTOCOL.md` | `§⑥` 第 1 条（reconcile/`kill -0`）、`§①` Board 的 `## Sessions` schema 注、`§⑬.2` | 判活扩为 pid 或子会话可达性；`## Sessions` 行增 `harness` 段、`pid` 省略/`-` |
| `guides/spawn-lane-sop.md` | §1 Rule、§3 Sequence、§6 gates、§7 refusal | **范围声明**（E12）：扩展或显式排除 HTML sub-agent + 登记等价物；若扩展则增 native 分支与拒绝码 |
| `guides/task-interface.md` | **AgentSession 的 canonical schema 归产品（引用，不在此声明）**：`skills/meerkat-taskpanel/references/card-schema.md`；`task-interface §2` = 仅 ACL 最小必需集（**不再含 AgentSession**）；§9 Session Association and Resume（team 侧处理）；§8 Future-Swap Mapping | AgentSession 增 `harness/id_state/seg`（落产品 `## Sessions` schema）；`## Sessions` 行映射（§9）；native resume 形态（`sessions_send`） |
| `scripts/README.md` | spawn-lane / registry 段 | 若单入口扩展：后端分派增 native 分支；registry 字段增量 |
| `roles/jobs/AGENTS.md` · `SOUL.md` · `IDENTITY.md` | Role Duties item 1 / §Tool Discipline / §Pre-Delivery Checklist / 第 5 行 / theme 行 | E1–E10 before/after（§9） |
| `team/guides/redlines.core.md` | 第 7 条 | E11：是否划范围（**需 Elon 双签**，只标注不落改） |
| `scripts/check-sessions.mjs`（判活/对齐口径） | 判活函数与卡↔registry 对齐键 | §5.4：无 pid ⇒ 判活扩为子会话可达性；否则 native 行被误报 `stale_card_line`/`zombie_registry` |

> 无「无文档影响」声明。同步触发点 = 下游实现 PR（`§⑫` 反向回填）；本契约文档自身为 L5 证据，不改 L1/L2 正文。

---

## 13. 未决项 / 需 Elon 裁决

> 标注「需 Elon 裁决」者，落地前须由 Elon 定夺；未裁决项按契约默认，但**不落地**。

| ID | 未决项 | 影响 | 处置 |
|---|---|---|---|
| **U-1** | **引擎三选**：(a) 原生 sub-agent / (b) codex 插件 harness / (c) 其它（§2） | HTML path 执行体 | **需 Elon 裁决**；契约**建议 (a) 默认 / (b) 可选 / (c) 不采**，**不预决** |
| **U-2** | **模型三选**：① 默认非 Claude 强模型 / ② 可配（`team.config.json` 增 `prototype.subagent_model`）/ ③ 允许 Claude 模型经 OpenClaw agent 跑（§2.4） | 质量（R1） | **需 Elon 裁决** |
| **U-3** | **「不再依赖 claude」语义边界**：指「不再依赖 Claude Code CLI」还是「不再用 Claude 模型」 | 选项③合法性、E6 措辞 | **需 Elon 逐字明确** |
| **U-4** | **registry upsert 键**：现行 `task_id\|owner\|phase\|session_id` 在大绑定后产生两行（§5.2、R3；同族 Epic A §11 G-1） | 两步回填的 registry 一致性 | **需 Elon 裁决**：将 `seg` 纳入去重键，或绑定步显式关闭 pending 行。契约默认 = 键纳入 `seg` |
| **U-5** | **子 agent 主体**：JHS 子会话跑 self（jobs agent）还是专用 agent 条目（如 `prototyper`）？F2 显示 jobs 未配 `subagents.allowAgents` | spawn 参数 `agentId` 与放行面 | **需 Elon 裁决** |
| **U-6** | **reconcile 判活口径**：是否把「子会话可达性」正式纳入 `§⑥`（§5.4、§8；同族 Epic A G-2） | 判活/对账（R2） | **需 Elon 裁决** |
| **U-7** | **`check-sessions` 判活/对齐扩展**：无 pid ⇒ native 行被误报 `stale_card_line`/`zombie_registry`（F5 实测） | 门信号洁净度 | **需 Elon 裁决** + linus 实现同步（§12） |
| **U-8** | **单入口归属**：JHS 是否也须经 `spawn-lane.sh` 单入口？还是 `sessions_spawn` 直连 + `task.session-set` 两步回填即视为等价登记（§8） | 单入口纪律 + G3/G6 证据面 | **需 Elon 裁决**（**本节最关键**） |
| **U-9** | **绑定超时阈值**：`id_state=pending` 超时建议 ≤120s（与 Epic A §3.2 同口径） | 断链判定（§3.3） | 契约默认 120s；A2 可配（建议命名 `SUBAGENT_BIND_TIMEOUT_MS`） |
| **U-10** | **会话持久态默认**：`visible`（持久 sidebar session）vs ephemeral（`cleanup:"delete"`）默认取值；及 `cleanup:"keep"` 是否强制（R-4 修订语义） | 可观测性 + 可修订性 | 契约默认 `cleanup:"keep"`（保证 `sessions_send` 修订）；`visible` 仅用户要求独立 sidebar session 时用 |
| **U-11** | **L1 红线段是否同步**：`§⑥` 顶部红线「HTML path must go through a Claude Code subsession」是否随 E1–E10 改写 | L1/L2 一致性 | **需 Elon 裁决**（L1 正文，owner=Elon） |
| **U-12** | **codex 插件后端 opt-in 的触发条件**：何时把 JHS 切到 (b)（§2.2） | 引擎切换面 | **需 Elon 裁决**；契约建议仅在「需 codex 级编码 + 与 Epic A 统一」时 opt-in |

---

> **契约自检**（对照 `design-spec.md` §4 HARD 约束）：13 章齐全（`## 1.` … `## 13.` 逐字命中骨架）；`### G1` … `### G12` 十二门齐；§7 N/A 表含 7 处显式 `N/A`（≥3）；§2 同时含「建议」「风险」「交 Elon 确认」且**不预决**；§9 覆盖 E1–E12 逐处 before/after 不改向；§10 逐条给「不变」+ 证据锚；§12 给「有文档影响」判定 + 需同步章节清单；全文只写「文档名 §章节名」，**无行号锚**；纯设计交付，只写本 workspace 三文件。
