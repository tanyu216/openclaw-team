# 红线速查（canonical，唯一正文）

> 维护者：Elon。由团队工具灌入各 `workspace-<role>/AGENTS.md` 的标记块并校验一致。
> **勿手改各 AGENTS 里的块**（改这里 → 重跑同步）。

<!-- BEGIN REDLINES:v1 (generated from team/guides/redlines.core.md — 勿手改) -->
> 🚨 **红线速查（每回合当面；详解见 `PROTOCOL §①/§④/§⑥/§⑬`）**
> 1. **领取**：一律经任务系统契约 `task.claim`（task-panel）；`in_progress` + 心跳新鲜 ⇒ 不重领、不重复执行（执行唯一性）。
> 2. **心跳/收尾**：执行中 ≤10min 刷心跳；段结束三件＝刷心跳 → 置终态(`in_review`/`done`/`failed`/`blocked`) → 回发 Elon Report（结论+卡路径+hash）。
> 3. **过程留痕**：协作讨论 / 用户决策 / 确认(双签) / **任务变更** 用 `task.comment`（`kind ∈ discuss|decision|confirm|change|note|defect`；人类决策标 `author=操作者`；**任务变更用 `kind=change`，记 what/why**）。
> 4. **汇报瘦身**：只给结论+卡路径+hash；日志/长表/大文件不进消息、不进上下文。
> 5. **状态机**：`ready→in_progress→in_review→done|failed`（`blocked` 任意态进出）。
> 6. **消息**：只有 Elon 面向人类；worker 不互派单；空闲不报批。
> 7. **工具红线**：写码经 Claude Code；测试经 codex；`prototype/**` 禁写实现；禁破坏性 git；提交 `git commit -- <显式路径>`。
> 8. **二义**：置 `blocked` 回发 Elon 澄清，不臆测。
> 9. **关系（父子/依赖）只经任务系统 ACL**：`task.spawn/depend/…`（自动拒环/自指/依赖祖先/深树/超链）；`kind:epic` 不领取；`deps_unmet` 不领取。
<!-- END REDLINES:v1 -->
