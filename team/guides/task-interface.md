# 任务管理接口契约（`task-interface v1`）

> **归属**：任务管理**基座**（独立层）。规范正文 = `PROTOCOL §①`；本文件是**基座对上层的唯一访问契约**。
> **目的**：上层（协作 / 职责 / SOP / 红线）**只依赖本契约，不依赖底层实现** ⇒ 日后把基座换成成熟 PM 工具时，**上层零改动**（只换 ACL 实现 + 跑契约测试）。
> **版本**：`v1`（2026-10-08）；变更走独立卡 + 双签，版本号随 §9 记录。

---

## 1. 分层与访问点
- **基座实现（当前）**：markdown 卡（`tasks/*.md`）+ 内部脚本（`scripts/claim.mjs` / `lib.mjs`）+ registry（`claude-sessions.json`/`turing-runs.json`）+ 触发（`poll.mjs`）。
- **唯一访问点（ACL）**：`team/skills/task-ops/` —— 对外只暴露下列**命令/事件/数据**。
- **约束**：上层**不得**直接读写卡文件/registry 或调用内部脚本，**一律经 ACL**（命令名见 §4）。

## 2. 数据模型（最小必需集）
| 实体 | 字段 |
|---|---|
| **Card** | `id` `title` `assignee` `status` `priority` `goal` `project` `target` `created_by` `created_at` `claimed_by` `claimed_at` `heartbeat_at` `blocked_at` `status_changed_at` `notify_elon` `subsession_ids` `active_session_id` |
| **Comment** | `{ ts, author, kind, text, refs? }`（append-only，落卡的 `## Comments` 段） |
| **Registry** | 子会话条目：`task_id/owner/phase/pid/startedAt/log/status/session_id` |

> 工具私有字段（未来 PM 工具特有）**隔离在 ACL 内**，不进上层。

## 3. 状态机
```
ready → in_progress → in_review → done | failed
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
`onReady` · `onClaimed` · `onDelivered(in_review)` · `onBlocked` · `onComment` · `onTerminal(done|failed)`

## 6. 不变量（契约测试对象）
1. **claim 原子**（抢锁；不双领）。
2. **执行唯一性**：`in_progress` + 心跳新鲜(≤10min) ⇒ 不重领、不重复执行。
3. **终态不可逆**：`done|failed` 不再迁移（勘误以新卡或评论更正）。
4. **评论 append-only**：不可改删。
5. **人类决策留痕**：`author=Terry` 的评论即"用户决策/确认"。
6. **终态可归档**：`done|failed` 满 7 天可归档（`archive.mjs`）。

## 7. 评论 / 过程留痕（process trail）
- **用途**：记录**团队协作讨论、用户(Terry)决策与确认、双签、异常处置说明**。
- **`kind` 枚举**：`discuss`（协作讨论）/ `decision`（决策）/ `confirm`（确认·双签）/ `change`（**任务变更**）/ `note`（一般）/ `defect`（缺陷相关）。
- **任务变更留痕**：凡对卡的**实质变更**（Acceptance / Background / 范围 / assignee / priority / target / 口径 等）**必须**以 `kind:change` 评论记录（what/why/who，必要时 before→after）；仅状态机常规流转不需。
- **`author`**：`Terry` / `elon` / 各 worker。
- **Report ≠ 评论**：Report = 交付结论（每卡一次）；评论 = 过程流水（多次、任意角色）。
- **衔接**：`§⑭ 确认门禁` 的双签 ⇒ `kind:confirm`；`§⑦/§⑪/§⑨` 澄清与判定 ⇒ 评论留痕。
- **可替换性**：评论 ≈ issue comments，PM 工具里最易映射。

## 8. 未来替换映射（换 PM 工具时，只改 ACL）
| 契约 | 当前实现（md） | PM 工具（示例） |
|---|---|---|
| Card | `tasks/*.md` + frontmatter | issue |
| Comment | 卡内 `## Comments` 段 | issue comments |
| status | frontmatter.status | workflow state |
| claim | mkdir 锁 + 写 status | assignment + lock/CAS |
| heartbeat | `heartbeat_at` | 自定义字段/事件 |
| registry | `claude-sessions.json` | links / sub-issues |
| 触发 | `poll.mjs` cron | webhook / 自动触发 |

> **语义鸿沟（ACL 必须补实现，是最难的部分）**：①原子领取；②心跳/防双跑；③终态归档；④"卡即内容"（Report/评论体量口径）。

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
- **巡检**：`check-relations.mjs`（I1–I13）入 `check-all`；`archive.mjs` 引用保护。

## 11. frontmatter 序列化不变量与写卡护栏
- **不变量（幂等）**：卡 frontmatter 字段值的**转义/反转义必须幂等** —— `parse→serialize→parse` 稳定，同一值反复「读→回写」（heartbeat / comment / status / report 任一）**字节数不增长**。实现：`quoteIfNeeded` 用 `JSON.stringify` 包裹，`parseFrontmatter` 对双引号值用 `JSON.parse` 反转义（二者互为对偶）。
- **过渡期口径（旧代码可能仍在）**：建卡/写卡时 frontmatter 字段值**禁用 ASCII 双引号 `"` 与反斜杠 `\`**；需要引号一律用中文「」替代。否则在旧代码路径上一轮回写即把转义层数翻倍，导致文件指数膨胀（事故 T-20261008-214730：8.4MB→…→268MB）。
- **写卡护栏**：`writeCardAtomic` **先序列化、后校验**；目标卡已存在且新输出 > 上版文件大小 **× 4（K=4）** 时**拒绝写入**并抛错（`拒绝写入：疑似 frontmatter 转义膨胀 …`），避免部分写入与静默膨胀；**新卡（无既有文件）不受限**。原子写仍为同目录 tmp + `renameSync`。
- **回归测试**：`scripts/tests/frontmatter.test.mjs`（幂等矩阵 / 旧格式兼容 / 真实卡只读回归 / 护栏），随 `check-all.sh` 执行。

## 12. 变更记录
- **v1** 2026-10-08：初始契约（含**评论/过程留痕**）。责任人：Elon。
- **v1（补充）** 2026-10-08：新增 §11 **frontmatter 序列化不变量与写卡护栏**（修 T-20261008-214730 回写指数膨胀事故）。责任人：Linus。
