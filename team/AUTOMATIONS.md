# AUTOMATIONS.md — 定时任务 / 巡检清单

> 团队 Gateway 的全部定时任务（cron / every / trigger）总览与决策记录。维护者：Elon。
> 最后更新：2026-10-08。查看实时：`automations list`（或 Control UI → Automations）。
> 关联：`PROTOCOL §⑳`（门禁与归档）、`§⑥.4`（poll 到终态）、`README §三`（运维命令）。

## 1. 任务总览（当前 17 条）

| 名称 | Agent | 频率 | Trigger | 投递 | 作用 |
|---|---|---|---|---|---|
| `jobs-poll` | jobs | 每 1m | ✅ | none | 看板轮询兜底：原子领取 jobs 的 ready/stale 卡 |
| `linus-poll` | linus | 每 1m | ✅ | none | 同上（linus） |
| `turing-poll` | turing | 每 1m | ✅ | none | 同上（turing） |
| `simons-poll` | simons | 每 1m | ✅ | none | 同上（simons） |
| `assistant-poll` | assistant | 每 1m | ✅ | none | 同上（assistant；2026-10-08 新增） |
| `task-patrol` | main | 每 5m | ✅ | none | 心跳陈旧(>30min)的 in_progress 卡 → 唤醒/恢复（2026-10-08 加 trigger） |
| `team-check-all` | main | **每小时** | ✅ | none | 门禁巡检 `check-all.sh`；仅失败才唤起模型（2026-10-08 改每小时+trigger） |
| `heartbeat-main` | main | 每 30m | — | none | 主会话心跳 |
| `memory-dreaming-promotion` | main | 03:00 (Asia/Shanghai) | — | none | memory-core 短时记忆晋升（托管） |
| `token-hygiene` | main | 04:00 (Asia/Shanghai) | — | none | 大日志压缩/记忆索引 |
| `session-rollover` | main | 06:00 (Asia/Shanghai) | — | none | 主会话换代 |
| `skill-collection-review-{main,jobs,linus,turing,simons,assistant}` | 各自 | 每 7d（错峰） | — | none | 技能收藏巡检 |

## 2. 成本模型（重要）
- **Trigger 任务空转 = 零成本**：`fire:false` 只写 state、不产生 run、不耗模型。故所有 poll / task-patrol / team-check-all 在**无异常时近乎零成本**。
- 只有 **`fire:true` 才唤起一次模型回合**（poll=领到卡；task-patrol=有陈旧卡；check-all=门禁失败）。
- 非 trigger 任务（心跳/维护/技能）按固定频率产生 run。

## 3. Trigger 脚本位置
| 任务 | 脚本 |
|---|---|
| `*-poll` | `scripts/triggers/poll-<agent>.js` → `scripts/poll.mjs <agent>` |
| `task-patrol` | `scripts/triggers/patrol-main.js` → `scripts/patrol-scan.mjs` |
| `team-check-all` | `scripts/triggers/check-all.js` → `scripts/check-all.sh` |

## 4. 决策记录
- **保留 per-worker poll，不做"单一看板扫描分发"**（Terry 2026-10-08）：per-worker `*-poll` 是**独立兜底**（worker 各自原子领取，Elon/main 停摆时已建卡仍可能被领走）。合并为「main 扫描→分发」会收敛为 Elon 单点并改变 `PROTOCOL §①`「领取时点归属 poll」语义，收益仅少几条零成本配置行 ⇒ 不采用。
- **巡检频率**：门禁巡检 `team-check-all` 定为**每小时**（Terry 2026-10-08）；因仅失败触发模型，频率提高不增成本。

## 5. 管理
- 查看：`automations list` ｜ 详情：`automations get <jobId>` ｜ 历史：`automations runs <jobId>`
- 试跑：`automations run <jobId> runMode=force`
- 增删改：首选 `automations` 工具；**但该工具在 agent/cron 回合是 read-only**（只有 status/list/get/remove/runs/next_check，无 add/update/run）⇒ 实际改调度用官方 CLI：`openclaw automations edit <jobId> --trigger-script <file>`（Gateway WS 托管路径，非手工改库）。禁手改 sqlite/store。
- 约束：`declarationKey` 为 **add-only**（建时定，之后不可 update）；改 key 需 remove + re-add。
- 权限：chat 回合 `add` 指定**其他 agent** 的 job 会被 scope 拒（`agentId outside caller scope`）；变通＝先建后 `update agentId`（或由 owner 在 Control UI 创建）。

## 6. 巡检度量（check-all 附带）
<!-- 决策记录 2026-10-08：trigger 脚本占位符修复 -->
- **2026-10-08 事故修复**：7 条 trigger 脚本（`team-check-all`/`task-patrol`/`*-poll` ×5）曾用 `{{HOME}}`/`{{NODE_BIN}}` 占位符；**trigger 内联 JS 不做大括号模板替换**，字面量传入 shell ⇒ `bash: {{HOME}}/...: No such file or directory` ⇒ `team-check-all` 每小时误报失败并空耗模型回合（poll 类则因 JSON.parse 失败恒 `fire:false`，静默失效）。
- **修复**：`scripts/triggers/*.js` 全部改用**绝对路径**（`/Users/<you>/...`），并经 `openclaw automations edit <id> --trigger-script <file>` 逐条回写 job；验证 `automations list` 无占位符、`check-all.sh` 全绿 ⇒ trigger 求值为 `fire:false`。
- **口径**：trigger 脚本路径一律绝对路径；禁占位符。
- 红线块漂移 = 0 ｜ 术语抽象违例 = 0 ｜ §引用断链 = 0 ｜ 卡 schema 违规 = 0 ｜ 契约测试全绿。
- **新 seg 背景包率**：`check-handoff` 校验「卡内 running/closed 的 seg 均有 `workspace/<task-id>/handoff.md` 且含四锚」——目标 100%；缺口即处置（生成/建卡）。
