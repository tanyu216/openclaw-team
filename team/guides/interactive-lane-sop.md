# 交互式 Lane SOP（`interactive-lane-sop.md`）

> **Ownership**: Linus owns the host/policy implementation; Elon owns the normative rule (`R-SESSION-1` clause 3) and approves policy exceptions.
> **Status**: method guide. **默认关闭**；只有显式 `interactive=1` / `--interactive` 的 lane 才走本指南。
> **Depends on**: `R-SESSION-1` · `guides/spawn-lane-sop.md` · `guides/lane-session-lifecycle-sop.md` · `guides/task-interface.md` §7/§9 · `guides/codex-plugin-lane-contract.md`.
> **Reference convention**: `R-<DOMAIN>-<n>` / `<guide> §<section>`；不写行号、不写卡号。

---

## 1. 范围与默认

- **默认是无人值守**：`spawn-lane` 不带 `--interactive` 时，argv、settings、登记、日志**逐字节不变**；需要确认的动作继续自动拒绝（`claude -p` 的 `permission_denials` / `codex exec` 的无 TTY 降级）。
- **交互是显式 opt-in**：`spawn-lane.sh <card> <owner> interactive=1` 或 `--interactive`。开启后，登记 pid 是 **`lane-host.mjs`**（长生命周期），不是后端进程。
- **v1 只支持 `harness=cli`**：`harness=plugin` + `interactive=1` 直接拒绝（`interactive_unsupported_harness(plugin):use_harness=cli`）。插件 lane 的审批姿态由网关契约管理。
- **v1 不做“实时等人”**：权限请求由本地策略**同步**裁决；策略无法裁决 ⇒ 拒绝 + 写问题 + 置 `blocked` + **停止 lane**。人类/Elon 的答复在**新分段**生效。host 不会为一个人类无限挂起。

## 2. 两条通道

| 通道 | 触发 | 处理 | 是否阻塞 |
|---|---|---|---|
| **权限批准** | Claude `can_use_tool`（非 `requires_user_interaction`） / Codex `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval` | 本地策略 `allow` / `deny`；`escalate` 则升级并停止 | 只在本地策略评估期间（毫秒级） |
| **澄清/决策** | Claude `AskUserQuestion` 或 `requires_user_interaction:true` / Codex `item/tool/requestUserInput`、`mcpServer/elicitation/request` | **永远**升级：写问题产物 + 评论 + `blocked` + 停止 | 不等人 |

`AskUserQuestion` / `requestUserInput` / MCP elicitation **不受任何 allow 规则影响**——这是刻意的：模型不能靠“策略恰好放行”把问题变成猜测。

## 3. 入口用法

```bash
# 预演（只校验 + 打印计划；零副作用）
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> <owner> --interactive --dry-run

# 启动交互 lane（host 作为登记 pid）
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> <owner> --interactive
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> <owner> interactive=1 backend=codex
```

计划 JSON 新增字段（仅交互 lane）：

| 字段 | 含义 |
|---|---|
| `interactive` | `true` |
| `harness` | Claude `cli`；Codex `app-server` |
| `cmd` | 实际起的 **host** 命令（`node lane-host.mjs …`） |
| `backend_cmd` | host 内部起的后端命令 |
| `prompt_file` | `workspace/<id>/<owner>-<n>.prompt.txt`（0600） |
| `control_log` | `workspace/<id>/<owner>-<n>.control.jsonl` |
| `state_file` | `workspace/<id>/<owner>-<n>.host.json` |
| `question_dir` | `workspace/<id>/questions/` |
| `policy` | `{path, source, digest}` |

非交互 lane 不出现这些字段。

## 4. 策略引擎

### 4.1 文件与优先级

1. `--policy <path>` / `OPENCLAW_LANE_POLICY`
2. `<TEAM>/lane-policy.json`（操作者覆盖；**不随 installer 覆盖**）
3. `team/scripts/lane-policy.default.json`（随脚本部署）

显式/env 路径必须存在；team 文件存在但非法 ⇒ **失败**，不静默回退。`default` 必须是 `deny`，否则加载失败。

### 4.2 规则形状

```json
{
  "version": 1,
  "default": "deny",
  "control_timeout_ms": 5000,
  "rules": [
    { "id": "allow-read-tools", "kind": "tool", "tool": ["Read", "Glob"], "action": "allow" },
    { "id": "allow-write-ws", "kind": "file", "tool": ["Write", "Edit"],
      "pathPrefix": ["{ws}", "{team}/workspace/{task_id}", "{cwd}/.worktrees"], "action": "allow" },
    { "id": "escalate-shell-meta", "kind": "command", "shellMeta": true, "action": "escalate" },
    { "id": "allow-git-read", "kind": "command", "commandPrefix": ["git status", "git diff"], "action": "allow" },
    { "id": "deny-destructive", "kind": "command", "commandRegex": ["(^|\\s)git\\s+reset(\\s|$)"], "action": "deny" }
  ]
}
```

- 规则**按顺序首个匹配**；`backend` 可限定 `claude|codex|*`；`kind` 为 `tool|command|file|permission|question|*`。
- `commandPrefix` 做空白归一化 + 词边界（`ls` 不匹配 `lsof`）。
- `commandRegex` 是 JS 正则。
- `pathPrefix` 支持 `{ws}` `{team}` `{cwd}` `{home}` `{task_id}`；解析 `..` 与最近存在祖先的 realpath；逃逸 ⇒ 不匹配。`allow` 规则必须覆盖**全部**路径；`deny`/`escalate` 命中任意一条即可。
- `shellMeta:true` 命中含 `; && || | > < $( ) 反引号` 的命令。**这条先于前缀白名单**，防止 `git status && rm -rf /` 绕过。
- 动作：`allow` 放行；`deny` 拒绝后本轮继续；`escalate` 拒绝 + 写问题 + `blocked` + 停 lane。
- 所有裁决写 `control_log`：`rule_id`、`action`、`policy_digest`、`subject_redacted`。
- `control_timeout_ms` 是宿主给**异步决策**留的预算；当前策略评估是同步的（毫秒级），因此它不会实际触发。它的存在是为了将来接入人工/远程决策通道时不改变协议。

### 4.3 覆盖边界（必须如实理解）

- **Claude**：`settings.interactive.json` 只 allow `Read/Glob/Grep/TodoWrite`；`--permission-mode default` 让 `Write/Edit/Bash` 落到 host。Claude 内置的**只读命令分类器**仍可能在策略之前放行只读命令——那是只读面，不是策略失效。
- **Codex**：`workspace-write` 沙箱先于审批；策略只看见越界/网络/提权等会触发 `requestApproval` 的动作。**策略不是沙箱**。
- 交互 lane 不启用 `acceptEdits` 的宽 allow；这是与无人值守 lane 的关键区别。

## 5. Claude 时序

1. host 起 `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode default --settings <ws>/.claude/settings.interactive.json --add-dir <ws> --add-dir <team> --permission-prompts host --permission-prompt-tool stdio [--session-id <sid>] [--name <name>]`。
2. 等 `system/init`（`OPENCLAW_LANE_HANDSHAKE_TIMEOUT_MS`，默认 30000）；host 写 `{"type":"lane-host","event":"ready"}`。
3. host 通过 stdin 发 `{"type":"user","message":{"role":"user","content":"<prompt>"}}`。
4. `control_request`：
   - `subtype !== can_use_tool` ⇒ 回 error（fail-closed），继续。
   - `requires_user_interaction` 或 `AskUserQuestion` ⇒ 升级。
   - 否则策略裁决；`allow` 必须回 `updatedInput` + `toolUseID`；`deny` 回 `message`。
   - `control_cancel_request` 丢弃；`keep_alive` 忽略；坏行跳过。
5. `result` ⇒ close stdin，等 `OPENCLAW_LANE_POST_RESULT_WAIT_MS`（默认 10000），SIGTERM/SIGKILL，exit 0。
6. 升级 ⇒ 拒绝、写产物、评论、`blocked`、exit 3（澄清）/ 4（决策）。

## 6. Codex 时序

1. host 起 `codex app-server --stdio`。
2. `initialize` → `initialized` → `thread/start`（`cwd`、`approvalPolicy:"on-request"`、`approvalsReviewer:"user"`、`sandbox:"workspace-write"`）→ `turn/start`（`input:[{type:"text",text:prompt}]`、`sandboxPolicy:{type:"workspaceWrite",writableRoots:[ws, <team>/workspace/<id>], networkAccess:false}`）。
3. 捕获 `thread.id`；写 `{"type":"thread.started","thread_id":…}` 与 sidecar；写 `lane-host ready`。
4. server→client 请求：
   | 方法 | 策略处理 | 回复 |
   |---|---|---|
   | `item/commandExecution/requestApproval` | `kind=command` | `{decision:"accept"\|"decline"\|"cancel"}` |
   | `item/fileChange/requestApproval` | `kind=file`（`grantRoot`） | 同上 |
   | `item/permissions/requestApproval` | `kind=permission` | `{permissions:{}, scope:"turn"}`（默认不扩权） |
   | `item/tool/requestUserInput` | **升级** | `{answers:{}}` + `turn/interrupt` |
   | `mcpServer/elicitation/request` | **升级** | `{action:"decline"}` |
   | legacy `execCommandApproval` / `applyPatchApproval` | 策略 | `{decision:"approved"\|"denied"\|"abort"}` |
   | 未知方法 / `item/tool/call` | fail-closed | JSON-RPC error |
5. `turn/completed` ⇒ `turn.status==="failed"` exit 1，否则 exit 0。
6. 升级 ⇒ 回 cancel/空答案 → `turn/interrupt`（2s 上限）→ 写产物/评论/blocked → exit 3/4。

**G9 口径**：`codex-plugin-lane-contract.md` 的“无人值守 lane 不得阻塞在审批上”只适用于**未开启 `interactive=1`** 的 lane。交互 lane 显式使用 `approvalsReviewer=user`，由 host 在**有界时间**内作答或停止；仍然禁止把 `user` 交给一个无人应答的无人值守 lane。

## 7. 问题产物与看板流程

产物：`workspace/<task-id>/questions/<owner>-<seg>-<ts>-<request_id>.json`

```json
{
  "v": 1, "task_id": "...", "seg": "seg1", "owner": "linus", "backend": "claude|codex",
  "request_id": "...", "session_id": "...", "thread_id": "...", "created_at": "ISO",
  "kind": "clarify|decision",
  "questions": [{ "id": "q1", "header": "...", "question": "...",
                  "options": [{ "label": "...", "description": "..." }], "isOther": true }],
  "context": { "cwd": "...", "tool_name": "AskUserQuestion|request_user_input" },
  "status": "pending"
}
```

升级顺序：

1. 写产物（原子）。
2. `task.comment <card> <owner> discuss|decision "<blocked_reason=...; artifact=...; 问题与选项>" refs:question:<id>`。
3. `task.setStatus <card> blocked actor=<owner>`（provider 只写 `blocked_at`，`blocked_reason` 在评论文本里）。
4. 拒绝/中断后端，exit 3/4；reaper 收口 session 行（卡保持 `blocked`）。
5. `sla-scan`（15m）唤醒 Elon；Elon/operator 在卡上回答，并把卡放回 `todo`。
6. owner 起**新分段**（仍加 `--interactive`）；prompt 会列出 pending 问题产物，handoff 已含 Comments。

降级：`comment` 失败 ⇒ `appendProgress`；再失败 ⇒ 仅产物 + `lane-lifecycle.log`，**仍然停止**。

## 8. 答案与 resume

- **v1 用新分段**：`spawn-lane <card> <owner> seg=<next> --interactive`。新分段读 handoff + 问题产物 + 操作者答案；不猜。
- **后续形态**（记录，不在 v1）：Claude `claude --resume <sid>`；Codex `thread/resume`（sidecar 里的 `thread_id`）。这需要一个显式的 resume 动作；v1 不新增。

## 9. sidecar 与控制日志

`workspace/<id>/<owner>-<n>.host.json`：

```json
{"v":1,"host_pid":123,"backend_pid":124,"card":"...","task_id":"...","seg":"seg1",
 "owner":"linus","backend":"claude","role":"exec","session_id":"...","thread_id":"...",
 "interactive":true,"control_log":"...","question_dir":"...","policy_path":"...",
 "policy_source":"default","policy_digest":"...","state":"starting|running|done|stopped|failed",
 "started_at":"ISO","ended_at":"","exit_code":0}
```

control log 每行：`{ts,event,backend,request_id,tool,kind,action,rule_id,reason,policy_digest,subject_redacted,...}`。值按**键名**脱敏（token/secret/password/api_key/authorization/cookie/credential）；原始后端 stdout 仍按原样落 `*.out.jsonl`（兼容现有证据面）。

## 10. 失败模式与拒绝码

| 失败 | 行为 |
|---|---|
| `interactive_unsupported_harness(plugin)` | usage 拒绝（exit 2） |
| `interactive_unsupported_cli(…)` | claim 前拒绝（CLI 旗标/子命令缺失） |
| `policy_load_failed:<reason>` | claim 前拒绝 |
| `interactive_prompt_unwritable:<path>` | 拒绝（不 spawn） |
| `host_ready_timeout(seg=…,ms=…)` | 关会话 `failed`、杀 host、拒绝 |
| `interactive_host_failed:<reason>` | 同上（host 提前写 failed） |
| 策略异常 / 未知控制消息 | deny / error，turn 继续 |
| host SIGKILL | reaper 读 sidecar，校验 `host_pid` 与父进程后清理残留后端 |
| 卡已终态 / `setStatus` 拒绝 | 记录；产物保留；仍停止 |

host 退出码：`0` 完成 · `1` 后端/协议失败 · `2` 握手/配置 · `3` 澄清停止 · `4` 决策/权限升级停止。

## 11. 安全与限制

- **默认 deny**；没有“全放行”开关；不要用 `--dangerously-skip-permissions` 代替策略。
- 交互 lane **不支持** background commands / `/loop` 唤醒；`result` 后按 `post_result_wait_ms` 收口。
- 交互 lane 默认 **deny 子代理**（`Agent`/`Task`）与网络工具；需要时由操作者在 `<TEAM>/lane-policy.json` 显式放行。
- 策略不是沙箱：见 §4.3。凭据文件（`.secrets.env`、`~/.ssh` 等）默认 deny。
- 原始 out 日志可能含敏感命令；需要更严格时可后续加 `--redact-out`（v1 未实现）。

## 12. 验证

```bash
node --test team/scripts/tests/lane-policy.test.mjs \
            team/scripts/tests/lane-backend.test.mjs \
            team/scripts/tests/lane-host.test.mjs \
            team/scripts/tests/lane-reaper-interactive.test.mjs

OPENCLAW_TASK_OPS_DIR=~/.openclaw/team/skills/task-ops \
  node --test team/scripts/tests/spawn-lane-interactive.test.mjs \
            team/scripts/tests/spawn-lane.test.mjs

bash team/scripts/check-all.sh --segment fast --repo .
```
