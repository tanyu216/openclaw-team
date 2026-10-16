# Codex 插件 lane 机制契约（A1）

> 卡：（父 epic ）· 责任：Jobs（设计/契约）·
> 下游：A2 （linus 实现）→ A3 （turing 独立验证）。
> 规格来源：`workspace/T-20261013-012318-3/design-spec.md`（骨架 / 硬约束 / 已核事实 / 设计裁定 R-1…R-6）。
> 评估依据：`workspace/T-20261013-005900/consolidation.md`（裁定 = **仅 Codex 腿 opt-in 试点**，其余不动）。
> 引用约定：本文只写「文档名 §章节名」，**不使用行号锚**（`PROTOCOL §6.1` 第 11 条）。
> 状态：**设计交付**。不改产品仓、不改运行时代码/配置。

---

## 1. 概览与范围

### 1.1 Goal

为团队 codex lane 从 `codex exec` CLI 切换到 OpenClaw 官方 `@openclaw/codex` 插件 harness 定义**机制契约**：会话归属、卡↔native thread 映射、registry 与 `## Sessions` 的 backend 表达、G1–G12 证据门位置、三宿主（claude/pi）显式 N/A。契约须**不改变**团队既有编排纪律（并发额度 / cwd+沙箱 / 登记 / 终态 / reconcile / 单入口 spawn-lane），并为 A2 提供可直接执行的接口契约。

### 1.2 Non-goal

- **不改 claude 腿**：claude 无官方 embedded harness（`claude-cli` 是 CLI-backend/文本回退，见 `plugins/cli-backend-plugins.md`、`concepts/agent-runtimes.md`），本契约不覆盖。
- **不改 pi 腿**：`pi --print --session <id>`，本卡**显式 N/A**（§6）。
- **不动产品仓**、不改任何运行时代码/配置（`scripts/**`、`skills/task-ops/**`、`~/.openclaw/**` 均只读）。
- **不做实现**：`spawn-lane.mjs` / `registry.mjs` / `task.mjs` 的改动属 A2；本契约只锁定接口与不变量。
- **不做整体切换**：按评估裁定，插件仅为 **Codex 腿 opt-in 旁路**，默认路径不变。

### 1.3 术语表

| 术语 | 定义 |
|---|---|
| **lane** | 一次独立的子会话执行单元；由 `scripts/spawn-lane.sh`（薄包装）→ `scripts/spawn-lane.mjs`（核心）单一入口起。归属 = 卡 `claimed_by` 的 owner。 |
| **seg** | lane 在卡内的分段键，形如 `seg1` / `seg2` / `segR1`（复核 lane 默认 `segR1`）。卡 `## Sessions` 的 upsert 键 = `seg:<seg> ·`（**非** owner 域）。 |
| **native thread** | Codex app-server 侧的原生会话线程（thread id 由 Codex 自赋）。插件 lane 的底层会话载体；不暴露 `--session-id`。 |
| **harness** | 执行引擎形态。`harness=cli`（现状：`codex exec <prompt>` 子进程）vs `harness=plugin`（本卡对象：`@openclaw/codex` app-server embedded turn）。 |
| **卡↔thread 映射** | 卡（`## Sessions` 行 `id`）↔ 插件 native thread id ↔ 团队 registry 条目三者的一致绑定。 |
| **CCD（Codex 插件 lane）** | 本文对 `backend=codex && harness=plugin` 的 lane 的简称。 |

### 1.4 已核事实（直接引用 `design-spec.md` §1，执行核实）

- 现状：`BACKENDS = ['claude','codex']`；`buildCommand` 对 codex 产出 `codex exec <prompt>`（一行 prompt），claude 走 `claude -p … --session-id <uuid>`（`scripts/spawn-lane.mjs`）。
- 官方插件：`@openclaw/codex` **v2026.10.2**（`~/.openclaw/extensions/codex/`，已安装且 enabled）；`dist/harness.js` 导出 `createCodexAppServerAgentHarness(options)` —— 即**由 OpenClaw Gateway 加载的 embedded harness 工厂**，非独立 CLI 入口；runtime extension = `./dist/index.js`。
- codex CLI **0.161.0**（宿主 PATH）；插件默认自带并管理 `@openai/codex` **0.160.0**；app-server 版本门 **≥0.149.0**（`plugins/codex-harness.md` Requirements）。
- 卡 `## Sessions` 行格式（唯一写入点 = ACL `task.session-set`，`skills/task-ops/lib/task.mjs`）：
  `- seg:… · owner:… · backend:… · id:… · phase:… · status:running|closed|failed · pid:… · <ISO8601Z>`；upsert 键 = `seg:<seg> ·`。
- registry 唯一事实源 = `~/.openclaw/team/claude-sessions.json`；写点 = `scripts/registry.mjs` `upsertSessionEntry` / `setSessionStatus`；**现行条目去重键 = `task_id|owner|phase|session_id`**，字段 `task_id/owner/phase/pid/startedAt/log/status/session_id`（终态加 `endedAt`）。
- 单入口纪律：新 lane 只能经 `scripts/spawn-lane.sh`（`guides/spawn-lane-sop.md`）；直跑 `claude -p` / `codex exec` 不登记 = 违规（复现 `registry_only` / `card_only` 两类 `check-sessions` 红）。
- 三宿主能力矩阵（）：claude 2.1.292 / codex 0.161.0 / pi 1.0.4；resume 形态 claude `--resume <id>`、codex `codex exec resume <id>`、pi `pi --print --session <id>`。

---

## 2. 会话归属契约（G1 / G2 / G9）

### 2.1 归属模型（R-1）

**1 张卡: N 个 lane（seg）: 每 lane = 1 个 codex 插件 native thread。**

执行归属在插件路径下改为**双坐标**：

| 坐标 | 值 | 说明 |
|---|---|---|
| `owner`（团队侧） | 卡 `claimed_by` 的 owner（jobs/linus/turing） | 执行权与并发额度仍按 owner 计（`capFor`）。 |
| `harness_host`（网关侧） | `gateway`（OpenClaw 网关进程） | native thread 由 **网关进程内的 codex 插件 harness** 持有；lane **不再等价于一个独立的 `codex exec` 子进程**。 |

⇒ 关键结构性差异：CLI lane 是「worker 回合派生的独立子进程（有自身 pid、脱离父进程组存活）」；CCD lane 是「**网关进程内的 embedded turn**（无独立子进程；句柄 = native thread id）」。这一差异是 §5 G7、§7 与 §11 的核心。

### 2.2 执行唯一权与 `PROTOCOL §6` 执行唯一性的对接

`PROTOCOL §6` 的执行唯一性纪律（卡已 `in_progress` 的新回合只报状态、不重复执行；`heartbeat_at` 新鲜 ≤10min 且 `in_progress` ⇒ poll 返回 `fire:false`）在插件路径下**保持不变，并加一条**：

**同一卡同一时刻至多 1 个 running lane**，由**双条件**守住：
1. **registry 活跃判定**：`claude-sessions.json` 中该卡存在 `status=running` 且可达（pid 存活 **或** thread 可达，见 §5 G7）的条目 ⇒ 不重复起 lane；
2. **卡状态双条件**：`status=in_progress` 且 `claimed_by=owner`（`spawn-lane` step ① 既有断言）。

两条同时满足才允许起新 lane；任一不满足 ⇒ `spawn-lane` 拒绝（沿用 `status_not_spawnable` / `claimed_by_mismatch` / `concurrency_cap` 稳定拒绝码）。**并发额度（G1）与 cwd+沙箱（G2）仍由 `spawn-lane` step ②③ 守住**（见 §8）。

### 2.3 G9 的前置约束（审批不阻塞）

无人值守 lane 的审批旁路是**会话归属的前置条件**：若插件审批层会挂起无人应答的 turn，则 lane 事实上无法在 owner 回合内完成，归属契约失效。契约要求（细节见 §8「审批」行）：CCD lane 作用域内 `approvalPolicy=never`（无人值守旁路），或退化为 **fail-fast**（lane 立即判 `blocked` 并回报，不静默挂起）。禁止在无人值守 lane 上使用 `approvalsReviewer=user`。

---

## 3. 卡↔native thread 映射（G6 / G3 / G4）

### 3.1 映射三面

| 面 | 载体 | 值 |
|---|---|---|
| 卡面 | 卡 `## Sessions` 行的 `id` 字段 | 绑定前 = `pending`；绑定后 = **codex native thread id** |
| 网关面 | 插件 harness / app-server | native thread id（Codex 自赋） |
| registry 面 | `claude-sessions.json` 条目 | `thread_id`（= native thread id）+ `id_state ∈ {pending, bound}` |

**codex 无 `--session-id`**（`design-spec.md` §1；`PROTOCOL §6` 第 8 条），id 由宿主 spawn 时自赋 ⇒ **不能像 claude 那样先取确定性 UUIDv5**。因此契约定义**两步回填**：

1. **spawn 时 `session-set` 先写 `id:pending`**：`seg/owner/backend=codex/harness=plugin/phase/pid(网关 pid 或 `-`)/status=running` 齐全，registry 条目 `id_state=pending`、`thread_id=''`（或未设）。
2. **spawn 成功后（读回原生 thread id）二次 `session-set` 覆盖同一 `seg:` 行**：`id:<thread_id>`、`harness=plugin`；registry 同键覆盖为 `thread_id=<thread_id>`、`id_state=bound`。

`## Sessions` 行的 upsert 键 = `seg:<seg> ·`（`task.mjs` `upsertSectionLine`）⇒ 两步写的是**同一卡内行**，卡面无重复行。（registry 侧去重键问题见 §11 G-1。）

### 3.2 断链 / 重连 / resume 规则（R-2）

- **绑定时以 `(card_id, seg)` 为键**：同一卡同一 seg 的绑定恒等；跨 seg 视为不同 lane。
- **断链判定**：`id_state=pending` 且超时（**建议 ≤120s**，与既有 ACP 启动探针窗口同口径）⇒ 判该 lane `failed` 并走 §▸reconcile（`kill -0` / thread 可达性判活，见 §5 G7）。
- **重连**：`id_state=bound` 后，网关重启 ⇒ 按 registry 里 bound 的 `thread_id` **重新绑定**（`openclaw codex continue <thread_id>`）；绑定成功前 lane 视为不可达。
- **resume 形态**：`bound` 后 resume = `openclaw codex continue <thread_id>`（原生 thread resume；对照 CLI 旧形态 `codex exec resume <id>`）。
- **幂等**：重复绑定同一 `(card_id, seg)` 不产生新 thread（回填覆盖，非追加）。

### 3.3 G3 同写与 G4 确定性（门定义见 §5 G3/G4）

- **G3（卡↔Sessions 同写）**：卡 `## Sessions` 行与 registry 条目由**同一次** `task.session-set` 落盘（`task.mjs` `sessionSet` 内 `writeCardAtomic` + `upsertSessionEntry`）；两步回填的两个时刻各自都是同一次同写，无半写窗口。
- **G4（确定性/可 resume）**：放弃确定性 UUIDv5，改用「**记录 native thread id + resume 断言**」——同 thread 可 resume、transcript 连续（非空跑对照：新会话答不出前次 marker）。证据与命令见 §5。

---

## 4. registry 与 `## Sessions` 的 backend 表达（G3 / G4 / G5）

### 4.1 R-3：backend 值域与 harness 标记

- `backend` 值域扩为 **`claude | codex | pi`**（现 `BACKENDS` 已含 claude/codex，pi 为值域预留，本卡不实现 pi lane）。
- codex lane **另标 `harness: "plugin"`**（与旧 `harness:"cli"` 区分）；未标 ⇒ 默认 `cli`（向后兼容：历史 codex lane 无 `harness` 段，一律视为 `cli`）。
- **唯一写入点不变**：`task.session-set` → 卡 `## Sessions` + registry 同写。**不得**为插件另开 registry 面（否则复现 `registry_only`/`card_only` 红，`guides/spawn-lane-sop.md` §9）。

### 4.2 registry schema 增量字段

| 字段 | 现值 | 增量 | 说明 |
|---|---|---|---|
| `backend` | 无 | 增 `backend ∈ {claude,codex,pi}` | 让 registry 能独立辨别宿主（现由卡 `## Sessions` 行推断，见  报告 §1.2）。 |
| `harness` | 无 | 增 `harness ∈ {plugin,cli}` | 仅 codex lane 有意义。 |
| `thread_id` | 无 | 增（codex 插件 lane 的 native thread id） | 绑定后写入；未绑定为空。 |
| `id_state` | 无 | 增 `id_state ∈ {pending,bound}` | 两步回填的状态位。 |
| `seg` | 无（由 `phase` 隐含） | 增 `seg`，并**纳入 registry upsert 键** | 见 §11 G-1（现行键 `task_id|owner|phase|session_id` 在大绑定后会产生两行）。 |

保留既有字段与白名单：`status ∈ {done,closed,failed,running}`（`registry.mjs` `VALID_STATUS`）；终态加 `endedAt`。

### 4.3 `## Sessions` 行格式增量

现状（`task.mjs` `sessionSet` 生成）：

```
- seg:<seg> · owner:<owner> · backend:<backend> · id:<id> · phase:<phase> · status:<running|closed|failed> · pid:<pid> · <ISO8601Z>
```

增量（CDD lane）：

```
- seg:<seg> · owner:<owner> · backend:codex · harness:plugin · id:<pending|thread_id> · phase:<phase> · status:<running|closed|failed> · pid:<gateway_pid|-> · <ISO8601Z>
```

- `harness` 段插在 `backend:` 之后（**新增可选段**；claude/pi lane 不写该段，行解析需向后兼容）。
- plugin lane 的 `pid` = **网关进程 pid**（或占位 `-`）；真正的 lane 句柄是 `id`（native thread id）。
- 只允许经 `task.session-set` 写卡（`PROTOCOL §13.3` 统一写入路径）；**不在 ACL 外手改卡/JSON**。

### 4.4 终态同步

`task.session-close <card> <seg> done|failed|closed`（**直传值，勿写 `status=` 前缀**）不变：
- 卡 `## Sessions` 该 `seg:` 行 `status` 改终态，清 `active_session_id`；
- registry 由该行 `id` 反查 `setSessionStatus(task_id, session_id, …)` 置终态 + `endedAt`；
- CCD lane 额外：registry 条目 `id_state` 保持 `bound`，并记录 `endedAt`；`thread_id` 保留（供 resume/审计）。

---

## 5. G1–G12 证据门表

> 逐门：定义 · 证据位置 · 机读命令（可直接复跑）· 期望 exit/断言 · 责任人。
> 门集来源：`workspace/T-20261013-005900/consolidation.md` §2 + 父卡 「必过门」+ `workspace/T-20261013-005900-4/report.md` §4。
> 路径约定：`<team>` = `~/.openclaw/team`；`<card>` = 卡 id；`<ws>` = `<team>/workspace/<card>`。

### G1 并发不回归

- **定义**：`running(owner) < cap`（linus/jobs 8、turing 3）；**插件 lane 与 CLI lane 合并计数**（同一 registry）。
- **证据位置**：`<team>/claude-sessions.json`（含 CCD 条目）；`spawn-lane` 末行机读 JSON。
- **机读命令**：`bash <team>/scripts/spawn-lane.sh <card> turing backend=codex harness=plugin --dry-run`（额度内）；负例：`running(turing)=3` 时同命令。
- **期望 exit/断言**：额度内 exit 0、末行 JSON `ok:true`；达上限 exit 1、`reason` 含 `concurrency_cap(owner=turing,running=3,cap=3)`。
- **责任人**：linus（A2 实现）/ turing（A3 验证）。

### G2 cwd + 沙箱不回归

- **定义**：cwd 仍由 `project`+`target` 解析；插件侧沙箱参数与 CLI 路径**等价**并写清映射。
- **证据位置**：`spawn-lane` JSON 的 `cwd`；插件配置 `plugins.entries.codex.config.appServer.{sandbox,defaultWorkspaceDir}`；**写仓负例**后目标仓 `git status --porcelain`。
- **机读命令**：`bash <team>/scripts/spawn-lane.sh <card> <owner> backend=codex harness=plugin --dry-run | tail -1 | jq -r.cwd`；`jq -r '.plugins.entries.codex.config.appServer.sandbox' ~/.openclaw/openclaw.json`；写仓负例后 `git -C <repo> status --porcelain`。
- **期望 exit/断言**：`cwd` == `resolveCwd(project,target)`（绝对路径，`spawn-lane.mjs` `resolveCwd`）；sandbox 映射见 §8；负例后 `git status --porcelain` 空输出（exit 0）。
- **责任人**：linus / turing。

### G3 卡↔Sessions 同写

- **定义**：卡 `## Sessions` 行与 registry 条目由**同一次** `task.session-set` 落盘（可 diff 两处 `seg:` 行证同源）。
- **证据位置**：卡 `## Sessions` 的 `seg:<seg> ·` 行；`<team>/claude-sessions.json` 同 `(task_id,seg)` 条目。
- **机读命令**：`node <team>/scripts/check-sessions.mjs`；`grep -c 'seg:seg1 ·' <team>/tasks/<card>.md`。
- **期望 exit/断言**：`check-sessions` exit 0、无 `registry_only` / `card_only`；卡行与 registry 条目的 `id`（或 `thread_id`）/`status`/`pid` 一致。
- **责任人**：linus。

### G4 确定性 / 可 resume

- **定义**：codex 无 `--session-id` ⇒ 契约 = **记录 native thread id + resume 断言**（同 thread 续接、transcript 连续）。
- **证据位置**：registry `thread_id` + `id_state:bound`；卡 `## Sessions` 行 `id`（= thread id）；resume 回读日志。
- **机读命令**：`openclaw codex continue <thread_id> --json`（resume）；标记回读：`openclaw codex sessions --search <marker> --json`。
- **期望 exit/断言**：resume exit 0；续接后 transcript 含前次写入 marker；**非空跑对照**：新会话答不出 marker（证明非提示词重放，照  口径）。
- **责任人**：linus / turing。

### G5 机读命令 + exit 证据

- **定义**：lane 起/终都产出机读证据；命令面 = `--dry-run` 末行 JSON；产物面 = lane `*.out.jsonl` 末行 `type=result` + exit code。
- **证据位置**：`spawn-lane` 末行 JSON `{ok,backend,harness,session_id|thread_id,cmd,…}`；`<ws>/<owner>-<n>.out.jsonl`（NDJSON）。
- **机读命令**：`bash <team>/scripts/spawn-lane.sh <card> <owner> backend=codex harness=plugin --dry-run | tail -1 | jq -e '.ok==true and.backend=="codex"'`；`tail -1 <ws>/<owner>-<n>.out.jsonl | jq -e '.type=="result"'`。
- **期望 exit/断言**：两命令 exit 0；`out.jsonl` 存在且非空、末行 `type=result`、含 `exit_code` 字段（对照 `PROTOCOL §6` 子会话「先落文件」纪律）。
- **责任人**：linus。

### G6 卡↔native thread 映射

- **定义**：卡 id + seg ↔ native thread id ↔ registry 条目**双向可查**。
- **证据位置**：registry `thread_id` + `id_state`；卡 `## Sessions` 行 `id`；网关侧 `/codex binding` / `openclaw codex sessions --json`。
- **机读命令**：`node -e 'const j=require(process.env.HOME+"/.openclaw/team/claude-sessions.json");const e=j.find(x=>x.task_id==="<card>"&&x.seg==="seg1");process.stdout.write(String(e.thread_id||""))'`；`openclaw codex sessions --search <card> --json`。
- **期望 exit/断言**：registry `thread_id` 非空且 `id_state=bound`；`openclaw codex sessions --json` 命中该 thread_id（exit 0）；卡行 `id` == registry `thread_id`。
- **责任人**：linus / turing。

### G7 网关重启对账不丢终态

- **定义**：网关重启对账 = registry `status=running` 但 pid/thread **不可达** ⇒ 由 reconcile 置 `failed` 并**保留卡终态**（不丢终态；`terminal_immutable` 不被触发/不改写）。
- **证据位置**：reconcile 台账 `<ws>/evidence/reconcile-<ts>.md`；卡 `## Sessions` 行 status；卡 frontmatter `status`。
- **机读命令**：`node <team>/scripts/registry.mjs active <card>`（判活）；`grep 'seg:seg1 ·' <team>/tasks/<card>.md`。
- **期望 exit/断言**：重启窗口后，不可达的 `running` 条目被置 `failed`（registry `status=failed` + `endedAt`）；卡 `## Sessions` 行 `status` 更新为 `failed/closed`，而卡 **frontmatter `status` 保持其既有态**（终态不被会话关闭反写，`PROTOCOL §1` 终态不可逆）。
- **责任人**：linus。

### G8 日志 24h 内导出到 workspace

- **定义**：网关 JSON-lines 文件日志按天滚动、**24h 后 prune**（`/tmp/openclaw/openclaw[-<profile>]-YYYY-MM-DD.log`）⇒ 契约规定：**lane 启动即**把插件/harness 侧日志导出到 `<ws>/evidence/`，并记 `exported_at`；超出 24h 的证据必须已落盘。
- **证据位置**：`<ws>/evidence/plugin-<ts>.log`；`<ws>/evidence/manifest.json`（含 `exported_at` / `lane_seg` / `source`）。
- **机读命令**：`test -s <ws>/evidence/plugin-*.log`；`jq -e '.exported_at' <ws>/evidence/manifest.json`。
- **期望 exit/断言**：导出文件存在且非空；`exported_at` 距 lane 启动 ≤24h，且在**卡终端态之前**已落盘（否则观测窗内证据被 GC）。
- **责任人**：linus。

### G9 审批不阻塞无人值守 lane

- **定义**：无人值守 lane 下 plugin approvals / exec approvals **不阻塞**（旁路策略或 fail-fast 语义）。
- **证据位置**：插件配置 `plugins.entries.codex.config.appServer.approvalPolicy`（lane 作用域）；网关日志中 pending `plugin.approval.*`；一次无人应答 lane 的终态。
- **机读命令**：`jq -r '.plugins.entries.codex.config.appServer.approvalPolicy' ~/.openclaw/openclaw.json`；`grep -c 'plugin.approval' /tmp/openclaw/openclaw-*.log`。
- **期望 exit/断言**：`approvalPolicy == never`（或声明 `on-failure` + fail-fast）；无人应答 lane 达正常终态（非挂起）；pending 审批计数在 lane 期间不增。
- **责任人**：linus。

### G10 三宿主显式 N/A 声明（claude/pi）

- **定义**：本门**本身**即「三宿主 N/A 声明门」——claude/pi 的适用门与非适用门逐门显式标注，**不得**用「未验证」代替「N/A」。
- **证据位置**：本契约 §6 三宿主 N/A 表。
- **机读命令**：`grep -c 'N/A' <ws>/codex-plugin-lane-contract.md`（覆盖各门）；人读复核 §6 逐门完整。
- **期望 exit/断言**：G1–G12 每门对 claude/pi 均给「适用」或「N/A + 理由」；无空项。
- **责任人**：jobs（本契约）/ turing（A3 复核）。

### G11 版本门 + doctor

- **定义**：codex CLI **≥0.149.0**（app-server 门；managed 默认 **0.160.0**）+ 记录版本；`openclaw doctor` 通过。
- **证据位置**：`codex --version` 输出；`openclaw doctor --lint --only codex/managed-app-server --json`；`openclaw doctor` 输出。
- **机读命令**：`codex --version`；`openclaw doctor --lint --only codex/managed-app-server --json`；`openclaw doctor`。
- **期望 exit/断言**：`codex --version` ≥0.149.0（宿主 0.161.0 / managed 0.160.0 均满足）；doctor lint exit 0 且 `ok`；`openclaw doctor` exit 0。
- **责任人**：linus。

### G12 插件加载可判

- **定义**：`openclaw plugins inspect codex --json` 的 shape/capability 明确；加载失败可经 doctor 诊断（**非静默失败**）。
- **证据位置**：`openclaw plugins inspect codex --json`；`~/.openclaw/extensions/codex/openclaw.plugin.json`（id / categories / contracts）。
- **机读命令**：`openclaw plugins inspect codex --json`；`openclaw doctor --json`。
- **期望 exit/断言**：inspect 返回 `id:codex` 且 `enabled=true`；`contracts.tools` 含 `codex_session_send` / `codex_session_read` / `codex_session_interrupt`（`openclaw.plugin.json` `contracts`）；doctor 对加载失败给出明确 exit 语义。
- **责任人**：linus。

---

## 6. 三宿主显式 N/A 声明（G10）

> 逐门标注：`适用` = 该门对该宿主有意义且受本契约约束；`N/A` = 该门对本卡/该宿主不适用，**附理由**。禁止用「未验证」代替「N/A」。各门定义见 §5；本节只列**非适用**项（`适用` 为默认）。

claude/pi **无官方 embedded harness**（`concepts/agent-runtimes.md`：`claude-cli`/`pi` 属 CLI-backends）⇒ **G6/G7/G8/G9/G11/G12 对二者 N/A**（官方插件路**天然只有 Codex 腿**）：

| N/A 门 | 理由 |
|---|---|
| **G6 卡↔native thread 映射** | claude 无 native thread（`claude-cli` 为 CLI-backend 文本回退，**非** harness）；pi 无官方 harness |
| **G7 网关重启对账** | claude lane 为独立子进程，不随网关重启（现行 `kill -0` reconcile 已覆盖）；pi 同 |
| **G8 日志 24h 导出** | claude lane 日志落 `<ws>/*.out.jsonl`，无网关 prune 问题；pi 同 |
| **G9 审批不阻塞** | claude 侧信任 / `--permission-mode`，无插件审批层；pi 同 |
| **G11 版本门+doctor** | claude/pi 无 app-server 版本门 |
| **G12 插件加载可判** | claude 插件不作为 coding lane 载体；pi 同 |

**G4 确定性/resume**：codex 适用（thread_id + resume 断言，无 UUIDv5）；claude 适用（确定性 UUIDv5 + `--resume`，形态**不变**）；**pi N/A**（本卡不改 pi resume 形态；pi 无官方 embedded harness）。
**其余**（G1 并发 / G2 cwd+沙箱 / G3 卡↔Sessions 同写 / G5 机读+exit / G10 三宿主 N/A 声明）对三宿主**均适用**（G2 插件沙箱 ↔ CLI `-s` 映射见 §8；G10 本门 = 声明门本身）。

---

## 7. 与 `PROTOCOL §6` 现行纪律对照（新增·变更点清单）

> 逐条对照 `PROTOCOL §6`（会话编排纪律）六项：并发额度 / cwd+沙箱 / 登记 / 终态 / reconcile / 单入口 spawn-lane。矛盾处**显式标注「需 Elon 裁决」**。

| PROTOCOL §6 纪律（现行口径见 `PROTOCOL §6`） | CCD 新增·变更点 | 矛盾？ |
|---|---|---|
| **并发额度**（第 2 条） | 插件 lane 与 CLI lane **合并计数**（同 registry）；registry 条目须带 `backend/harness` 以辨宿主 | **无变更**（沿用 `capFor`/`runningCount`） |
| **cwd + 沙箱**（第 3 条 / cwd 归一小节） | 插件侧沙箱映射 `appServer.sandbox ∈ {read-only,workspace-write,danger-full-access}` ↔ CLI `-s` 同值；`defaultWorkspaceDir`/thread cwd = resolved cwd | **需 Elon 裁决**：OpenClaw 沙箱激活态下 codex **native Code Mode 被关闭**（`plugins/codex-harness.md`），须裁定「是否要求插件 lane 在无 OpenClaw 沙箱态运行」 |
| **登记**（第 8 条 / registry 字段小节） | registry 增 `backend/harness/thread_id/id_state/seg`（§4.2）；`## Sessions` 行增 `harness`（§4.3）；**两步回填**（pending→bound） | **需 Elon 裁决**：CCD 无独立子进程 ⇒ 登记改「pending 先写、bound 后覆盖」；是否放宽「立即完整登记（含 pid）」口径 |
| **终态**（`PROTOCOL §13.2` / `session-close`） | 沿用 `task.session-close <card> <seg> done\|failed\|closed`；CCD 额外保留 `thread_id`（供 resume/审计），`id_state` 保持 `bound` | **无变更** |
| **reconcile**（第 1 条 / `kill -0`） | 判活扩为「`isPidAlive(pid)` **或** thread 可达（`codex_session_read` / `openclaw codex sessions --json`）」；网关重启场景见 G7 | **需 Elon 裁决**：是否把「native thread 可达性」正式纳入 `PROTOCOL §6` reconcile 判活口径 |
| **单入口 spawn-lane**（单入口小节 / `guides/spawn-lane-sop.md`） | 入口增 `harness=plugin` 分支与两步回填；`--dry-run` 语义不变（只校验+打印，零副作用） | **无变更**（单入口纪律不变；仅增一条分支） |

> 结论：六条纪律中 **三条无变更**（并发额度 / 终态 / 单入口），**三条含变更且各有一处矛盾点，均标注「需 Elon 裁决」**（沙箱态、两步登记、reconcile 判活）。矛盾点汇总见 §11。

---

## 8. A2 实现接口契约（可直接执行）

> 最低要求来自 `design-spec.md` §4；「可细化不可减项」。默认路径**保持现状（`exec`）until A2 落地**。

### 8.1 入口参数

```
bash scripts/spawn-lane.sh <card> <owner> seg=<seg> backend=codex harness=plugin [phase=<p>] [role=exec|review] [--dry-run]
```

- 新增 **`harness=plugin|cli`**（默认 `cli` ⇒ 现 `codex exec` 行为不变）；**`--plugin` 等价 `harness=plugin`**。
- `--dry-run` 仍**只做校验链 + 打印计划命令行，零副作用**（不起进程、不写 registry/卡/handoff/settings）。
- 未识别 harness 值 ⇒ **usage 错（exit 2）**，理由码 `unknown_harness:<v>`。

### 8.2 后端分派（`buildCommand`）

- **plugin 分支**：`buildCommand({backend:'codex', harness:'plugin', …})` 返回**网关中介的 codex harness turn** 调度形态（`bin`=`openclaw`（或等价 Gateway dispatch），args 绑定：model ref（如 `openai/gpt-6-astra`）+ resolved cwd + 沙箱参数 + 任务 prompt）。返回句柄 = **native thread id**（非 pid）。
- **cli 分支（旧，保留可回退）**：`{ bin:<codex>, args:['exec', prompt] }` —— 保持现状，作为回退路径。
- 分派依据 `harness` 开关；`harness` 缺省 ⇒ cli 分支（向后兼容）。
- 机读信封不变：末行 JSON 增 `harness` 与 `thread_id`（pending 阶段 `thread_id` 为空、`id_state=pending`）。

### 8.3 登记（两步回填）

- spawn 后 `session-set`：`id:pending`、`harness:plugin`、`id_state=pending`、`thread_id=''`、`pid=<网关pid|->`（§3.1 步①）。
- 绑定后二次 `session-set`（覆盖同一 `seg:` 行）：`id:<thread_id>`、`id_state=bound`、registry `thread_id=<thread_id>`（§3.1 步②）。
- **registry upsert 键须容纳 `seg`**（§11 G-1），否则 pending 行残留。

### 8.4 并发

- 沿用 `running(owner) < cap`（`capFor`：linus/jobs 8、turing 3）；**插件 lane 与 CLI lane 合并计数**（同一 `claude-sessions.json`）。
- 判活：`isPidAlive(pid)`（CLI lane）或 thread 可达（CCD lane）——死条目不占额度（reconcile 职责）。

### 8.5 cwd / 沙箱（映射表）

| 维度 | CLI 路径（现状） | 插件路径（CCD） | 等价性 |
|---|---|---|---|
| cwd | `-C <cwd>`；`resolveCwd(project,target)` | `appServer.defaultWorkspaceDir` / thread cwd = `resolveCwd(project,target)` | 等价（同一解析函数） |
| 沙箱 | `-s read-only\|workspace-write\|danger-full-access` | `appServer.sandbox ∈ {read-only,workspace-write,danger-full-access}` | 同值域映射 |
| 审批 | 宿主 exec 审批 | `appServer.approvalPolicy` / `approvalsReviewer`（见 8.9） | 语义映射，见 §11 G-4 裁决 |

### 8.6 终态 / reconcile

- 终态：沿用 `task.session-close <card> <seg> done|failed|closed`（直传值）。
- reconcile：判活 = `isPidAlive(pid)` **或** thread 可达；`status=running` 且不可达 ⇒ 置 `failed` + `endedAt`，**卡终态保留**（G7）。

### 8.7 日志导出（G8）

- **触发时机**：lane 启动时 **+** 终态前各一次。
- **路径**：导出 `<ws>/evidence/plugin-<ts>.log`；写 `<ws>/evidence/manifest.json`（`exported_at` / `lane_seg` / `source`）。
- **源**：`/tmp/openclaw/openclaw[-<profile>]-YYYY-MM-DD.log`（含 codex 插件行）。

### 8.8 版本门 / doctor（G11 / G12）

| 项 | 命令 | 期望 |
|---|---|---|
| codex 版本门 | `codex --version` | ≥0.149.0（managed 0.160.0 / 宿主 0.161.0） |
| managed app-server | `openclaw doctor --lint --only codex/managed-app-server --json` | exit 0 / `ok` |
| doctor | `openclaw doctor` | exit 0 |
| 插件加载 | `openclaw plugins inspect codex --json` | `id:codex` + enabled + `contracts.tools` 含 `codex_session_*` |

### 8.9 审批（G9）

- 无人值守 lane 作用域：`appServer.approvalPolicy=never`（**旁路**）；若策略不可旁路 ⇒ **fail-fast**（lane 立即判 `blocked` 并回报，不静默挂起）。
- 禁止无人值守 lane 使用 `approvalsReviewer=user`；`auto_review` / `guardian_subagent` 视为需额外裁决（§11 G-4）。

---

## 9. 风险 R1–R5（缓解 / 回退 + 再评估触发条件）

> 源头：`workspace/T-20261013-005900/consolidation.md` §3 头部风险 + `workspace/T-20261013-005900-4/report.md` §5。

### R1 插件 Codex-only ⇒ 三宿主一致性破坏（严重度：高）

- **缓解**：保留 CLI 为**统一入口**（默认不变）；插件仅 Codex 腿 opt-in；宿主 matrix **显式 N/A**（G10，§6）。
- **回退**：`harness` 开关默认 `cli`；任一问题即整体回退 `codex exec`（§8.2 旧分支常驻）。
- **再评估触发**：官方推出 **Claude 侧 embedded harness**（非文本回退）；或 **三宿主对等的插件化路径**出现（`consolidation.md` §4①②③）。

### R2 网关重启命中网关内 lane（严重度：高）

- **依据**：E2E-C round-2 实测 `gateway.restart_shutdown_timeout` 停机 ≈646.8s（`workspace/T-20261012-012736/evidence/execC2-poll-*`）。
- **缓解**：G7 网关解耦对账（registry 不可达 ⇒ `failed`，卡终态保留）；关键 lane 保留 CLI 独立进程路径（回退）。
- **回退**：切回 `harness=cli`（lane 为独立子进程，不随网关重启）。
- **再评估触发**：离线数据表明网关重启不再中断在飞 lane（或官方提供 lane 级持久化/恢复）；现行 CLI 路出现无法自修的恢复缺口（§4④）。

### R3 网关日志 24h prune（严重度：中）

- **缓解**：G8 观测窗内**启动即导出**日志到 `<ws>/evidence/` + `exported_at` 台账。
- **回退**：导出失败 ⇒ lane 判 `blocked` 并回报（不静默丢证据）。
- **再评估触发**：网关日志留存策略改为 ≥观测窗（或提供插件侧持久导出 API）。

### R4 证据链外移（严重度：中）

- **缓解**：G3 同写绑卡 + G6 卡↔thread 映射断言，使证据面**仍可机检**（`check-sessions` + registry `thread_id`）。
- **回退**：任一映射缺位 ⇒ 该 lane 不计入验收证据（判 `failed`）。
- **再评估触发**：需要 **Codex 原生 chat-control**（`bind/resume/steer/stop`）成为常规 ⇒ 接受证据面外移（§4②）。

### R5 审批阻塞无人值守（严重度：中）

- **缓解**：G9 `approvalPolicy=never` 旁路；不可旁路 ⇒ fail-fast（不静默挂起）。
- **回退**：审批阻塞不可消除 ⇒ 回退 CLI lane（宿主 exec 审批更可控）。
- **再评估触发**：插件审批提供「无人值守默认放行」语义（或 lane 级 approval policy）。

---

## 10. 文档同步判定（`PROTOCOL §12`）

**判定：有文档影响**（本卡触及接口 / 数据结构 / 约定变更）。需同步章节如下——**由 A2 落地时按 `PROTOCOL §12` 反向回填同步**（A1 为设计交付，只定义、不改文档）：

| 目标文档 | 需同步章节 | 变更要点（明细锚） |
|---|---|---|
| `PROTOCOL.md` | `PROTOCOL §6` 第 2/3/8 条、单入口小节、第 1 条（reconcile/`kill -0`）、`PROTOCOL §1` Board `## Sessions` schema 注、`PROTOCOL §13.2` | §4、§7 对照表：插件 lane 合并计数；沙箱映射；codex id = native thread id（非确定性 UUIDv5）+ `harness`；入口增 `harness=plugin`；reconcile 判活扩为 pid 或 thread 可达；`## Sessions` 行增 `harness` 段 |
| `guides/spawn-lane-sop.md` | §1 Rule、§3 Sequence、§6 How the gates back this up、§7 When the entry refuses | 增 `harness=plugin` 入参与两步回填；新增拒绝码 `unknown_harness` / `thread_bind_timeout` |
| `guides/task-interface.md` | **AgentSession 的 canonical schema 归产品（引用，不在此声明）**：`skills/meerkat-taskpanel/references/card-schema.md`；`task-interface §2` = 仅 ACL 最小必需集（**不再含 AgentSession**）；§9 Session Association and Resume（team 侧处理）；§8 Future-Swap Mapping | AgentSession 增 `harness/thread_id/id_state`（落产品 `## Sessions` schema）；registry 行映射（§9）；codex resume 形态（插件 `openclaw codex continue <thread_id>`） |
| `scripts/README.md` | spawn-lane / registry 段 | 后端分派新增插件分支；registry 字段增量 |

> 无「无文档影响」声明。同步触发点 = A2 实现 PR（`PROTOCOL §12` 反向回填）；本契约文档自身为 L5 证据，不改 L1/L2 正文。

---

## 11. 未决项 / gap

> 标注「需 Elon 裁决」者，A2 落地前须由 Elon 定夺；无裁决项按契约默认执行。

| ID | 未决项 | 影响 | 处置 |
|---|---|---|---|
| **G-1** | **registry upsert 键在大绑定后 session_id 变更**：现行键 = `task_id\|owner\|phase\|session_id`；pending（`session_id=pending`）→ bound（`session_id=<thread_id>`）会产生**两行**（pending 残留），破坏「覆盖同一行」预期 | 两步回填的 registry 侧一致性 | **需 A2 + Elon 裁决**：将 `seg` 纳入 registry 去重键，或绑定步显式关闭（`closed`）pending 行。契约默认 = 键纳入 `seg`（§4.2） |
| **G-2** | **插件 lane 无独立 pid**：现行 `PROTOCOL §6` 并发/reconcile 以 pid 判活；CCD 的 `pid` = 网关 pid | reconcile 判活口径 | **需 Elon 裁决**：是否把「native thread 可达性」正式纳入 `PROTOCOL §6` reconcile 口径（§7） |
| **G-3** | **非交互启动面未定稿**：`dist/harness.js` 是 Gateway 加载的 harness 工厂（非 CLI 入口）；CCD lane 的「非交互 dispatch」具体 CLI/RPC 形态（候选：`openclaw agent --model openai/gpt-6-astra` / Gateway RPC / `sessions_spawn({runtime:'codex'})`）须 A2 定稿 | A2 实现入口 | A2 定稿；契约只锁不变量（单入口、机读 JSON、pending→bound、cwd/沙箱等价）。**建议**：优先 Gateway 原生 dispatch（避免自造 CLI） |
| **G-4** | **OpenClaw 沙箱态下 native Code Mode 关闭** ⇒ 插件 lane 原生执行面受限（`plugins/codex-harness.md`） | cwd+沙箱等价性（G2）/审批（G9） | **需 Elon 裁决**：是否要求插件 lane 在无 OpenClaw 沙箱态运行；`approvalsReviewer` 取值（`auto_review`/`guardian_subagent`）是否可用于无人值守 lane |
| **G-5** | **`## Sessions` 行新增 `harness` 段**会改变 ACL `sessionSet` 输出（`task.mjs`）——属 task-provider 契约增量 | provider ACL / `check-sessions` 行解析 | A2 与 `task-interface.md §9` 同步；行解析须**向后兼容**（无 `harness` 段的历史行视为 `cli`） |
| **G-6** | **版本门值域**：宿主 `codex` CLI 0.161.0（PATH）vs managed `@openai/codex` 0.160.0 | G11 版本门判据 | 契约默认：**≥0.149.0 为下限**，managed pin 0.160.0；正常启动用 managed（不依赖 PATH） |
| **G-7** | **绑定超时阈值**：`id_state=pending` 超时建议 ≤120s（与既有 ACP 启动探针窗口同口径） | 断链判定（§3.2） | 契约默认 120s；A2 可配（建议命名 `THREAD_BIND_TIMEOUT_MS`） |

---

> **契约自检**（对照 `design-spec.md` §5 完成判据）：11 章齐全；R-1…R-6 逐条落实未改向；G1–G12 逐门含「证据位置 + 机读命令 + 期望 exit/断言」；三宿主 N/A 逐门显式标注；A2 接口契约逐行填实；无行号锚；纯新增 1 文档。
