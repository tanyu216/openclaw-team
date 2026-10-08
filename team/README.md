<!-- NOTE: this file is a v0 document derived from a reference instance. It still references the legacy in-house task scripts; task management now lives in the external `task-panel` project. Expect a generalisation pass. -->

# OpenClaw 六人 Agent 团队 — 交接文档（README）

> 架构 / 协议 / 运维 / 恢复 / 费用观察 / 已知坑 / 未采用方案决策。
> 本目录 `~/.openclaw/team/` 是跨 agent 唯一共享区；协议正文见 `PROTOCOL.md`。
> 最后更新：2026-10-08（文档体系与协作机制优化 v2 落地：PROTOCOL ①–⑲ + 六角色文件引用化；架构/协议/运维/恢复见下）

## 一、架构

```
[人类 Terry]──(微信/TUI bindings)──► Elon（agent:main:main，CEO/统筹/唯一建卡者/唯一面向人类）
                                          │  sessions_send（即时直派） / sessions_spawn（并行子任务）
                     ┌────────────────────┼─────────────────────┬────────────────────┐
                     ▼                    ▼                     ▼                    ▼
                  Jobs                Linus                 Turing               Simons
              产品设计/UX门禁         代码开发              测试/验收           量化研究/资料
        （编排 claude 子会话，    （编排 ≤8 claude       （编排 ≤3 codex 子会话）  （claude 写码 +
         pixso.cn 经 Claude       子会话，reconcile                    codex 分析 + qlib 回测）
         Code 集成；亲自 review）  registry 先行）
                     └──────────── 每 worker 一个 cron（every 1m + trigger）兜底 ────────────┘
                     poll.mjs 只读扫描+原子领取（claim.mjs mkdir 锁）→ fire:true 唤醒执行
```

**事实源分工**：
- 任务**内容**（Goal/Acceptance/Background/Report）→ 任务卡 `tasks/T-*.md`
- 任务**派单/状态/通讯** → OpenClaw 原生（sessions_send/spawn、background tasks、automations）
- 项目 metadata（路径/git 边界/规则）→ `projects.json`（`node scripts/lib.mjs get-project <name>`）
- 会话 registry（claude/codex 子进程）→ `claude-sessions.json` / `turing-runs.json`

## 二、目录速览

| 路径 | 内容 |
|---|---|
| `PROTOCOL.md` | 协议唯一正文（①–⑲：看板/项目访问/结构不变式/汇报/消息/会话编排/二义/注册/缺陷回环/分流/越界/文档同步/通用硬纪律/确认门禁/SLA/术语/分层/研究口径/工作信条 + 附A） |
| `projects.json` | 注册项目：QuantMaster / QuantTrader / ObsidianQuant（含 git 边界实测） |
| `tasks/` + `.locks/` + `archive/` | 任务卡 + 原子领取锁 + 终态归档（满 7 天，`archive.mjs`） |
| `workspace/<task-id>/` | 任务工作目录 + 产物（review/ 子目录存问题清单与证据） |
| `scripts/{lib,claim,poll}.mjs` + `triggers/` | 看板原语 + cron 条件触发适配器；另有 `prototype-guard.sh`（原型门禁）、`archive.mjs`（卡归档） |
| `AUTOMATIONS.md` | 定时任务/巡检清单（cron 总览、成本模型、决策） |
| `ROLES.md` | 角色职责/边界/交接 对账表（防 GAP） |
| `guides/` | 稳定引用文档（任务接口契约、红线 canonical、UI 对齐 SOP、UI 断言规格等） |
| `skills/task-ops/` | 任务管理基座 ACL（唯一访问点，`task-interface v1`）；**仅 OpenClaw agent 侧，子会话不装** |
| `claude-sessions.json` | Jobs/Linus/Simons 编排的 claude 子会话 registry（运行时维护） |
| `turing-runs.json` | Turing codex 运行 registry（运行时维护） |

Workspaces：`~/.openclaw/workspace-elon`（main 迁移更名）与 `workspace-{jobs,linus,turing,simons,assistant}`（新建）；角色技能在各自 `workspace-*/skills/`，全局技能 `~/.openclaw/skills/`（13 个，由原 main workspace/skills 迁移）。

## 三、运维命令

```bash
OCL='/Users/<you>/.nvm/versions/node/v24.20.0/bin/node /Users/<you>/.nvm/versions/node/v24.20.0/lib/node_modules/openclaw/dist/index.js'   # nvm node v24.20.0
# 状态
$OCL gateway status | $OCL agents list --bindings | $OCL automations list | $OCL tasks list
$OCL automations runs <jobId> --limit 20      # 看 poll 空转/领取历史
$OCL sessions list --all-agents --json        # 会话总览
# 看板
cat ~/.openclaw/team/tasks/*.md               # 全卡（含 Report）
node ~/.openclaw/team/scripts/poll.mjs <agent>   # 手动跑一轮触发求值（领卡演练/排障）
node ~/.openclaw/team/scripts/lib.mjs get-project QuantMaster
# 重启（维护窗口：先备份配置，微信验证在 restart 后由 Terry 发消息）
$OCL gateway restart
# 停某 worker 兜底
$OCL automations disable <jobId>    # 恢复: automations enable <jobId>
```

## 四、恢复手册

| 场景 | 动作 |
|---|---|
| worker 卡死（心跳 >30min） | 同 assignee 下轮 poll 自动重领接管；>6h 任何 agent 可领并上报 Elon |
| 双跑风险 | claim 锁防双领；`in_progress`+新鲜心跳 = 执行唯一性（新回合只回报不重复执行）；stale 才接管 |
| Gateway 重启丢单 | 卡持久在 tasks/；每 worker cron 每分钟扫 ready/stale 卡兜底重派 |
| 配置写坏 | `cp ~/.openclaw/openclaw.json.pre-* `（链式备份）；平台 `.last-good`/`.bak` 轮转；`doctor --fix` 可恢复 |
| main workspace 事故 | 备份 `~/.openclaw/workspace.bak-persona-20260908`（9.6M 全量，迁移前快照） |
| 微信断路由 | 检查 `agents list --bindings` 微信=main；恢复 pre-team 配置 + restart |

## 五、费用观察指引

- 4 个 poll cron 每分钟求值但 **fire:false 零成本**（不产生 run、不耗模型）；仅领到卡才触发回合。
- 模型策略：**全部 agent（Elon/Jobs/Linus/Simons/Turing/Assistant）默认档统一为 `deepseek-flash`**，agent 配置的 primary 与 fallback 均为它；`deepseek-v4-pro` 不再是任何 agent 的默认，改为按任务复杂度临时升级，视觉任务用 `deepseek-flash`（细则见 PROTOCOL ⑥.2）。
- 编排子会话（claude/codex）是主要成本源：留意 `claude-sessions.json` 并发数与孤儿回收（reconcile 纪律）。
- 观察：`$OCL automations runs` 只统计 fired run，空转不计数——费用与 run 数直接相关。

## 六、已知坑归档（实测）

1. **模型 contextWindow 声明错误曾致 pro 全挂**：deepseek 条目曾写 `contextWindow: 64000`（实际 1M），网关按此管理上下文/输出预算 → v4-pro 长会话深推理顶满 `max_tokens`（`stopReason=length`、`payloads=0`）→ "Agent couldn't generate a response"。**修复：`contextWindow: 1048576` + `maxTokens: 32768`**。今后遇此报错先查模型声明再怀疑模型/网络。
2. **agents add 会覆盖 IDENTITY.md 的 Name 行**为小写 agent id → add 后需恢复 `- **Name:** <大写角色名>`（备份快照比对）。
3. **automations `--trigger-script` 是内联 JS 条件脚本**（gateway 解析执行，30s 预算/≤5 工具调用），不是 shell；不能带 shebang/顶层 import。方案：`scripts/triggers/poll-<agent>.js` 薄适配器 `exec({command: node poll.mjs <agent>})` 显式传身份（1 次工具调用），动作留给 run 回合。
4. **openclaw 技能体系与 claude CLI 技能体系是两套**：Jobs/Linus spawn 的 claude 子会话加载 `~/.claude/skills` + 任务目录 `.claude/skills`；openclaw 的 `~/.openclaw/skills`（及 workspace skills）不会被 claude 子会话加载——spawn 前按角色把所需技能复制进任务目录 `.claude/skills/`。
5. **pixso Claude Code 集成 = skills（5 个 pixso-*）+ 项目作用域 `pixso-oauth-mcp`**（挂在 cwd=/Users/<you> 的项目下；cwd 在 home 之外不可见）。账号登录为一次性人工步骤（未完成前 Jobs 设计退化为文档型产出）。
6. **obsidian 根目录是带自动提交的 git 仓库**（quant vault 无独立 git）：vault 文件会被父仓库跟踪（天然留痕）；Simons 不需 git 操作。
7. **sqlite `workspace_path_aliases` 旧路径行是历史缓存，惰性无害**：main 行仍指向旧 `workspace` 路径字符串（Dreaming 03:00 写入），运行时以 config pin（workspace-elon）为准，无需手工改 DB。
8. **trigger-script 求值期与 run 回合分离**：领取发生在 poll 求值期（fire:true ⇔ 已领取）；run 回合发现 `claimed_by=自己`+新鲜心跳 → 跳过 claim 直接执行，仅卡仍 ready 才补 `claim.mjs`。
9. **heartbeat 仅 main 有**（30m，defaults 配置）；worker 无 heartbeat 空跑；Dreaming(03:00) 只摄入 main 会话。
10. **深层排查经验**：gateway 日志 `/tmp/openclaw/openclaw-*.log`（JSON 行）；模型请求/fallback/推理溢出均有 subsystem 标记（`model-fallback/decision`、`agent/embedded` reasoning-only 等），先 grep runId。
11. **任务管理 skill 只装 OpenClaw 团队侧（`~/.openclaw/skills/task-ops`），不装 Claude 侧**：任务管理仅面向 OpenClaw 团队 agent（`PROTOCOL §⑥` 第 7 条）；**Claude Code / codex 子会话不安装、不引用 task-ops**，所需卡信息与约束由 agent 转写进其 prompt/`CLAUDE.md`。**勿再往 `~/.claude/skills/` 装 task-ops**（曾误加，已撤）。

## 七、未采用方案决策记录

- **Swarm**（一次性扇出、无队列/跨轮次状态）→ v1 不引入。派单双路径（sessions_send 直派 / sessions_spawn 并行）+ cron 兜底已覆盖需求。
- **managed TaskFlow**（需自建插件 controller 才可驱动）→ 不自建消息/调度系统；任务持久化用最小补丁（任务卡 + 原子领取锁），其余全走原生。
- **ACP**（外部 harness 通道，非 agent 团队内建）→ 不引入。
- **不把任何人挂 claude-cli runtime**：claude CLI 是 backend 依赖本机登录态；Jobs/Linus/Simons = 协调者 + exec 驱动 claude 子进程的方案不变。
- **单一「看板扫描」分发（合并 per-worker poll）→ 不采用**（Terry 2026-10-08 定）：per-worker 的 `*-poll`（每 1m + trigger，空转零成本）是**独立兜底**——worker 在被唤醒时各自原子领取，Elon(main) 停摆时已建卡仍可能被领走。合并为「main 扫描→分发」会把唤醒链收敛到 Elon 单点，且改变 `PROTOCOL §①`「领取时点归属 poll」语义。收益仅少几条零成本配置行，**故保留现状**。

## 八、Phase 状态

- ✅ Phase 0（冒烟）/ Phase 1（骨架+单测 14 项）/ Phase 2（注册配置+维护窗口+模型配置修复+微信路由验证/A2A/spawn）
- ⏳ Phase 3 端到端演练：**由 Terry 微信发需求给 Elon** 起真实任务链（Jobs 设计小任务含 ux-review 迭代 → Linus 3 子任务并发 → Turing 已知坏函数 failed 路径 → 故障演练 automations disable）。首任务同时实测 isolated 回合 setsid 子进程存活性（spawn 主模式定案）与 claude-sessions.json 建卡落账。
- ⏳ Phase 4 本 README 待演练后补充：问题清单模板实际产出、registry 样例、费用实测。

**实施计划全文**：`/Users/<you>/.claude/plans/openclaw-agents-glittery-mochi.md`（含任务卡 schema 与各角色 Standing Orders 条文源）。
