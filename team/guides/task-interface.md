# 任务管理接口契约（`task-interface v1`）

> **归属**：任务管理**基座**（独立层）。规范正文 = `PROTOCOL §①`；本文件是**基座对上层的唯一访问契约**（= **任务提供方 ACL**）。
> **目的**：上层（协作 / 职责 / SOP / 红线）**只依赖本契约，不依赖底层实现** ⇒ 更换任务系统时，**上层零改动**（只换提供方实现 + 跑契约测试）。
> **提供方**：**非强制、可切换**。`task-panel` 是**参考实现**（任务 skill + `taskctl` CLI）；任何满足本契约的系统皆可（Jira / Linear / Plane / GitHub Issues / 自研 …）。
> **范围**：本项目只交付本 ACL 与团队侧适配约定；**各任务系统自身的 skill / MCP / 鉴权由用户自备，不在本项目范围**。
> **版本**：`v1`；变更走独立卡 + 双签，版本号随 §13 记录。

---

## 1. 分层与访问点
- **提供方（可替换）**：参考实现 = 外部项目 **task-panel**（任务 skill + `taskctl` CLI）；卡内容持久化 + 会话 registry + 触发求值。其它系统（Jira/Linear/Plane…）经同一 ACL 接入。
- **唯一访问点**：task-panel 的任务接口（`taskctl`／任务 skill）—— 对外只暴露下列**命令/事件/数据**。
- **约束**：上层**不得**直接读写卡文件或绕过接口操作，**一律经该访问点**（命令名见 §4）。

## 2. 数据模型（最小必需集）
| 实体 | 字段 |
|---|---|
| **Card** | `id` `title` `assignee` `assignee_kind` `status` `priority` `kind` `labels` `project` `target` `created_by` `created_at` `updated_at` `status_changed_at` `claimed_by` `claimed_at` `heartbeat_at` `blocked_at` `depends_on` `parent` `review_of` `notify_elon` `goal`（= task-panel `KNOWN_CARD_KEYS`；未识别键入 `meta.legacy` 原样保留） |
| **Comment** | `{ id, task_id, body, kind, author_kind, author_id, refs, created_at }`（append-only，落卡 `## Comments` 段；`kind ∈ discuss\|decision\|confirm\|change\|note\|defect`） |
| **AgentSession** | `{ task_id, seg, owner, backend, session_id, phase, pid, status, ts }`（`status ∈ running\|closed\|failed`；落卡 `## Sessions` 段） |
| **Relation** | `{ relation_type, source_task_id, target_task_id }`（`relation_type ∈ parent\|blocks\|related`；`related` 方向规范化为 source<target；单父约束） |

> 实现的私有字段隔离在访问点内，不进上层。

## 3. 状态机
```
backlog | todo → in_progress → in_review → done | canceled
                 ↘  blocked  ↙         （blocked 可从任意执行态进入并回退）
```
- `in_review` = 已交付待 Elon 验收；此后不刷心跳、不重领、poll 不 fire。

## 4. 命令（上层只调这些）
| 命令 | 语义 |
|---|---|
| `task.claim <card> <assignee>` | 原子领取（幂等；新鲜 in_progress ⇒ 不重领） |
| `task.heartbeat <card> <assignee>` | 刷新心跳（仅 in_progress 本人） |
| `task.setStatus <card> <status>` | 置状态（维护 `status_changed_at`；进 `blocked` 记 `blocked_at`） |
| `task.appendProgress <card> <line>` | Progress 追加一行 |
| `task.comment <card> <author> <kind> <text> [refs]` | 追加**过程留痕**（见 §7） |
| `task.writeReport <card> <text>` | 覆盖 Report 段（每卡一次交付结论） |
| `task.registerSubsession <card> <sessionId>` | 登记子会话（append + active） |
| `task.query <filter>` | 只读查询（按 assignee/status） |

## 5. 事件（协作层订阅）
`onReady` · `onClaimed` · `onDelivered(in_review)` · `onBlocked` · `onComment` · `onTerminal(done|canceled)`

## 6. 不变量（契约测试对象）
1. **claim 原子**（不双领）。
2. **执行唯一性**：`in_progress` + 心跳新鲜(≤10min) ⇒ 不重领、不重复执行。
3. **终态不可逆**：`done|canceled` 不再迁移（勘误以新卡或评论更正）。
4. **评论 append-only**：不可改删。
5. **人类决策留痕**：`author=操作者` 的评论即"用户决策/确认"。
6. **终态可归档**：`done|canceled` 满 7 天可归档。

## 7. 评论 / 过程留痕（process trail）
- **用途**：记录**团队协作讨论、操作者决策与确认、双签、异常处置说明**。
- **`kind` 枚举**：`discuss`（协作讨论）/ `decision`（决策）/ `confirm`（确认·双签）/ `change`（**任务变更**）/ `note`（一般）/ `defect`（缺陷相关）。
- **任务变更留痕**：凡对卡的**实质变更**（Acceptance / Background / 范围 / assignee / priority / target / 口径 等）**必须**以 `kind:change` 评论记录（what/why/who，必要时 before→after）；仅状态机常规流转不需。
- **`author`**：`操作者` / `elon` / 各 worker。
- **Report ≠ 评论**：Report = 交付结论（每卡一次）；评论 = 过程流水（多次、任意角色）。
- **衔接**：`§⑭ 确认门禁` 的双签 ⇒ `kind:confirm`；`§⑦/§⑪/§⑨` 澄清与判定 ⇒ 评论留痕。
- **可替换性**：评论 ≈ issue comments，PM 工具里最易映射。

## 8. 未来替换映射（换 PM 工具时，只改访问点实现）
| 契约 | 当前实现 | PM 工具（示例） |
|---|---|---|
| Card | 任务卡 + frontmatter | issue |
| Comment | 卡内 `## Comments` 段 | issue comments |
| status | frontmatter.status | workflow state |
| claim | 原子占用 + 写 status | assignment + lock/CAS |
| heartbeat | `heartbeat_at` | 自定义字段/事件 |
| registry | `claude-sessions.json` | links / sub-issues |
| 触发 | poll 求值 | webhook / 自动触发 |

> **语义鸿沟（访问点必须补实现，是最难的部分）**：①原子领取；②心跳/防双跑；③终态归档；④"卡即内容"（Report/评论体量口径）。

## 9. Session 关联与 resume（省 token）
- **确定性 id**：`sessionId(taskId, owner, seg)` = UUIDv5(`openclaw-team/<taskId>/<owner>/<seg>`)，命令 `task.session-id <card> <owner> [seg]`；同参数恒定 ⇒ 可 `--resume`。
- **卡内映射**：`## Sessions` 段每行 `seg · owner · backend · id · phase · status · pid · ts`；`active_session_id` = 当前分段。
- **命令**：`task.session-set <card> seg=… owner=… backend=claude|codex phase=… pid=… status=running` ｜ `task.session-close <card> <seg> [status]` ｜ `task.session-id <card> <owner> [seg]`。
- **resume 优先**：同任务同分段续做 ⇒ `--resume <id>`；仅语境过期/超长时新起（以 `state.md` 摘要交接）。**目标：减少新起会话重灌上下文 tokens。**
- **恢复**：reconcile 读卡内 `## Sessions` + registry，按 id `--resume` 接管。
- **新起 seg 背景包**：任务卡（Goal/Acceptance/Background）+ 卡内 `## Report` + `## Comments` + `state.md`（保证跨 seg 一致、免重灌旧会话上下文）。**生成方式**：`task.handoff <card> seg=…` → `workspace/<task-id>/handoff.md`（含四锚、摘要化）；子会话先读之，**不手写**。
- **归属**：仅 OpenClaw agent 侧（子会话不感知任务管理，见 `PROTOCOL §⑥#7`）。

## 10. 父子卡与前置依赖（DAG）
- **拆分**：复合任务 = `kind:epic` 父卡（容器/聚合，**不参与领取**）+ 子卡（`parent=<epic>`，普通卡）。
- **依赖**：子卡 `depends_on:[前置]`（只存前置，后继派生）；跨父允许；无依赖并行、有依赖串行。
- **命令**：`task.spawn <epic> title=… assignee=… [depends_on=a,b]` ｜ `task.depend <card> <on…>` ｜ `task.undepend` ｜ `task.children <epic>` ｜ `task.deps <card>` ｜ `task.rollup <epic>`。
- **不变量（写时校验，理由码）**：自指 `self_ref`；父子环 `parent_cycle`；单层 `parent_depth`；父须 epic `parent_not_epic`；依赖环 `dep_cycle`；依赖缺失 `dep_missing`；禁依赖祖先 `dep_on_ancestor`；链长≤8 `chain_too_long`；扇入≤8 `fanin_too_high`；嵌套 epic `nested_epic`。
- **领取守卫**：`epic` ⇒ `epic_container`；`depends_on` 未全 done ⇒ `deps_unmet`（**不新增状态**）。
- **聚合**：`task.rollup` 派生父卡状态；父卡 `done` = 全子卡 done **+ 集成验收**。
- **巡检**：关系不变量入巡检门禁；归档引用保护。

## 11. frontmatter 序列化不变量与写卡护栏
- **不变量（幂等）**：卡 frontmatter 字段值的**转义/反转义必须幂等** —— `parse→serialize→parse` 稳定，同一值反复「读→回写」（heartbeat / comment / status / report 任一）**字节数不增长**。
- **状态取值（对齐 task-panel）**：规范 7 值 `backlog|todo|in_progress|in_review|blocked|done|canceled`；兼容别名 `ready→todo`、`failed→canceled`（及 `in-review`/`in-progress`/`cancelled`）**仅边界解析、不落库**，导出还原原词（旧卡字节稳定）。优先级 `low|medium|high|urgent`（默认 `medium`）。kind 仅 `task|epic`。
- **写卡护栏**：写入**先序列化、后校验**；目标卡已存在且新输出 > 上版文件大小 **× 4（K=4）** 时**拒绝写入**并抛错，避免部分写入与静默膨胀；**新卡（无既有文件）不受限**。
- **回归测试**：幂等矩阵 / 旧格式兼容 / 真卡只读回归 / 护栏，随巡检门禁执行。

## 12. 任务提供方接入与切换（ACL 绑定）
- **角色**：本项目定义 ACL（即本文件的命令/事件/数据/不变量）；**提供方（provider）** 负责实现。`task-panel` 只是**参考实现**，**非强制依赖**。
- **可切换**：任何满足本契约的任务系统皆可 —— 如 Jira / Linear / Plane / GitHub Issues / 自研看板。团队上层只经访问点（§4 命令 / §5 事件）交互，**与具体提供方解耦**。
- **绑定方式**：设环境变量 **`OPENCLAW_TEAM_TASK_PROVIDER=<name>`**（或等价团队配置），并安装该提供方的 skill / CLI / MCP。未配置时团队退回「无任务系统」模式（仅本地卡文件，无跨会话看板）。
- **参考提供方**：`task-panel`（`./install.sh --with-task-panel` 安装；非默认强制）。
- **达标判定**：更换提供方后，跑 **ACL 契约测试**（§6 不变量 + §4 命令语义）判定是否达标；不达标即视为不支持。
- **范围边界**：**提供方自身的 skill / MCP / 鉴权由用户自备，不在本项目范围**（本项目只交付 ACL 定义 + 团队侧适配约定）。

## 13. 变更记录
- **v1**：初始契约（含**评论/过程留痕**）。责任人：Elon。
- **v1（补充 2）**：新增 §12 **任务提供方接入与切换（ACL 绑定）**：task-panel 降为可选参考实现，支持 Jira/Linear/Plane 等替换；变更记录顺延为 §13。责任人：Elon。
