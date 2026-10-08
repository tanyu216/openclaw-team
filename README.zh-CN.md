# openclaw-team

把一支 **AI Agent 研发团队** 装进一台 OpenClaw 主机：一名统筹（Elon）＋四名专家（设计 / 开发 / 测试 / 助理）。定位是**标准个人独立开发者**的多 agent 工作流。

> 本文是 [README.md](README.md) 的中文镜像；**英文为默认文档语言**。

本仓库是 **Phase A（纯文件 + 幂等安装器）**：`install.sh` 把协议、角色工作区、技能、agent 注册与配置装配到 OpenClaw，可重复执行。**不含插件**（Phase B 已明确不做）。

```text
你  ──►  Elon(main，统筹)  ──►  Jobs(设计) · Linus(开发) · Turing(测试) · Assistant(杂务)
```

## 角色

| 角色 | agent id | 工作区 | 职责 |
|---|---|---|---|
| 🧠 Elon | `main` | `workspace-elon` | 需求入口 / 建卡 / 派单 / 验收 / 汇报 |
| 🎨 Jobs | `jobs` | `workspace-jobs` | 产品设计 / PRD / UI / UX |
| ⚙️ Linus | `linus` | `workspace-linus` | 代码开发 / 缺陷修复 / 重构 · **CI 门禁 / 构建 / 发版 / 部署** |
| 🧪 Turing | `turing` | `workspace-turing` | 测试 / 验收 / 回归 / 安全审计 |
| 🧹 Assistant | `assistant` | `workspace-assistant` | 视频解析 / 运营 / 杂活 |

> **定位与角色扩展**：`openclaw-team` 是**面向个人开发者快速搭建研发团队的框架**。上表**五个角色（elon / jobs / linus / turing / assistant）是标准内置角色**。**五角色之外的岗位**（如业务特有职位）由**用户自行定义/扩展**——框架不把任何实例的额外角色写死。


## 安装

```bash
git clone <this-repo> ~/Documents/openclaw-team
cd ~/Documents/openclaw-team
./install.sh --dry-run      # 先看将执行什么
./install.sh                # 幂等安装
```

常用选项：

| 选项 | 说明 |
|---|---|
| `--dry-run` | 只打印动作，不改任何文件 |
| `--force` | 覆盖已存在的 skill / 角色文件 / team 文档 |
| `--openclaw-home DIR` | OpenClaw 家目录（默认 `~/.openclaw`） |
| `--claude-home DIR` / `--codex-home DIR` | Claude Code / Codex 家目录 |
| `--task-panel DIR` | 指定 task-panel 源码路径 |
| `--with-task-panel` | 安装参考任务提供方（**task-panel 默认即安装**） |
| `--no-task-panel` | 退出 task-panel：自备任务系统（Jira / Plane / Linear …），经 `task-interface` ACL 对接 |
| `--skip-automations` | 不注册团队级定时任务 |
| `--keep-existing` | 从不覆盖已存在文件（跳过而非升级） |
| `--skip-skills` `--skip-agents` `--skip-config` `--skip-team` | 跳过对应阶段 |
| `--vendor` | 从来源快照到 `skills/vendor/` |
| `--offline` | 从 `skills/vendor/` 快照安装（不联网） |

安装器做这些事（每步幂等，已存在则跳过）：

1. **预检**：node / openclaw CLI；检查 `claude`、`codex`（缺失给出安装提示，不中断）。
2. **团队文档** → `~/.openclaw/team/`（`PROTOCOL.md`、`ROLES.md`、`README.md`、`guides/`）。**不覆盖**运行时目录 `tasks/`、`workspace/`、`memory/`。
3. **技能（声明源）**：逐条解析 `skills/manifest.json` 的上游来源（ClawHub / GitHub / git）并安装到对应目标。无已核上游（`needs_source`）的条目会跳过并告警。`--vendor` 快照到 `skills/vendor/`；`--offline` 从快照安装。
4. **Agent 与角色工作区**：拷贝 `AGENTS.md`/`SOUL.md`/`IDENTITY.md`，然后 `openclaw agents add <id> --workspace <dir> --non-interactive`；已注册则跳过。**永不覆盖**既有 `USER.md`。
5. **配置片段** → `openclaw config patch --file config/*.json5`（`config/examples/` 下仅参考，不自动应用）。
6. **任务提供方（ACL）**：报告已配置的提供方（`OPENCLAW_TEAM_TASK_PROVIDER`，默认 `task-panel`）；**默认安装**参考实现 task-panel。`--no-task-panel` 退出并打印「自备」指引（Jira / Plane / Linear …，经 `task-interface` ACL）。
7. **团队定时任务（调度）**：注册团队级定时任务（`poll-<agent>` 每 1m、`task-patrol` 每 5m、`team-check-all` 每小时），**幂等**（按 `declarationKey`）、**provider-agnostic**：每个触发脚本只调用框架派发器 `team/automations/dispatch.mjs`，**不含任何 provider 字面量**。`--skip-automations` 关闭。见 [调度与团队定时任务](#调度与团队定时任务)。

### 升级 / 重装

默认模式为 **安装或升级**。仓库更新后重跑 `./install.sh` 会**覆盖**先前安装的受管内容：

- **受管**（升级时更新）：团队文档、角色种子 `AGENTS.md` / `SOUL.md` / `IDENTITY.md`、配置片段、技能。
- **用户所有**（从不触碰）：`USER.md`、`team/tasks/`、`team/workspace/`、`team/memory/` 与会话 registry。
- **备份**：凡内容有变的受管文件，**覆盖前**先备份到 `~/.openclaw/team/.backups/<时间戳>/`。
- **状态**：已装版本记录在 `~/.openclaw/team/.install-state.json`；升级会打印 旧→新 版本。
- **退出升级**：`--keep-existing` 恢复旧的「只装不覆盖」行为。

```bash
./install.sh --dry-run        # 预览安装/升级动作
./install.sh                  # 安装或升级受管内容
./install.sh --keep-existing  # 从不覆盖
```

### 技能（方案 A：只存声明，不 vendor 代码）

技能**正文不存本仓库**。`skills/manifest.json` 声明每个技能的上游来源；`skills/lock.json` 锁定已解析的 ref 与目录哈希。安装器从来源拉取：

```bash
./install.sh                 # 按声明源拉取并安装
./install.sh --vendor        # 快照来源到 skills/vendor/
./install.sh --offline       # 从既有快照安装（不联网）
```

目标：

| 目标 | 位置 |
|---|---|
| `openclaw` | `~/.openclaw/skills/` |
| `claude` | `~/.claude/skills/` |
| `codex` | `~/.codex/skills/` |
| `agent:<id>` | `~/.openclaw/workspace-<id>/skills/` |

标 `needs_source: true` 的条目尚无已核上游，解析前一律跳过。来源与许可见 [`skills/PROVENANCE.md`](skills/PROVENANCE.md)。

> **已迁移（方案 A 完成）**：技能正文不再 vendor；90 条声明均解析到已核上游（GitHub / ClawHub），安装时由 `skills/fetch.mjs` 拉取。

## 任务系统与调度（可切换，经 ACL）

**边界归属**：`openclaw-team` 拥有**调度**与 **ACL 抽象**；任务基座（task-panel / Jira / Plane …）只是 ACL 背后的**被调方**。完整契约见 `team/guides/task-interface.md`（卡、原子领取 + 心跳、`ready → in_progress → in_review → done | failed` 状态机、评论/过程留痕、父子 + 依赖 DAG），本文不复述。

- **默认提供方 —— task-panel**：默认安装（任务 skill + `taskctl` CLI）。`./install.sh --no-task-panel` 可退出；用 `--task-panel DIR` 指定源码。
- **自备 / 换基座**：Jira / Linear / Plane / GitHub Issues / 自研看板 … —— 自行安装其连接 skill/MCP，并用 `OPENCLAW_TEAM_TASK_PROVIDER=<name>` 指向它。上层（角色 / SOP / 定时任务）**零改动**，因为它们只依赖 ACL；随后跑 ACL 契约测试（`task-interface.md §6`、`§12`）。
- **范围边界**：第三方任务系统的连接 skill/MCP **不在本项目范围**；本仓库只交付 ACL 与团队侧适配约定。

### 调度与团队定时任务

团队级**调度归框架所有、provider-agnostic**，**不**下放给任务提供方。`install.sh` 注册三类任务（幂等，按 `declarationKey`；`--skip-automations` 关闭）：

| 任务 | 频率 | 用途 |
|---|---|---|
| `poll-<agent>` | 每 1m | 各 worker 轮询（jobs/linus/turing/assistant）；仅当领取到卡时 fire |
| `task-patrol` | 每 5m | 心跳陈旧的 `in_progress` 卡扫描 |
| `team-check-all` | 每小时（`0 * * * *` @ Asia/Shanghai） | 门禁巡检；仅失败时 fire |

每个触发脚本调用框架派发器 `team/automations/dispatch.mjs <poll|patrol|check-all> [agent]`；派发器解析 provider 的入口命令（`team/automations/providers.json`；provider = `OPENCLAW_TEAM_TASK_PROVIDER`，默认 `task-panel`）并返回 `{"fire":…}`。触发脚本**不含任何 provider 字面量**，故**换基座 = 定时任务零改动**。入口缺失 / 执行失败 / 解析失败 ⇒ `fire:false`（零成本）。详见 `team/automations/README.md`。

### 扩展角色

五个内置角色（elon / jobs / linus / turing / assistant）是标准集；**五角色之外的岗位由用户自行定义/扩展** —— 框架不把任何实例的额外角色写死（见 [角色](#角色)）。新增角色 = 增加其工作区种子文件，并（可选）加一条 `poll-<agent>` 定时任务；调度本身仍归框架。

## 仓库结构

```text
openclaw-team/
├─ install.sh                # 幂等安装入口
├─ config/                   # 自动应用的 config patch（*.json5）
│  └─ examples/              # 仅参考、不自动应用（模型/绑定/自动化/项目元数据）
├─ roles/<agent>/            # 每角色工作区种子：AGENTS/SOUL/IDENTITY/USER.md
├─ skills/
│  ├─ openclaw/              # 全局 OpenClaw 技能
│  ├─ claude/ codex/         # Claude Code / Codex 技能
│  ├─ agents/<agent>/        # 各 agent 工作区技能
│  └─ PROVENANCE.md          # 来源与许可清单
└─ team/                     # 部署到 ~/.openclaw/team/ 的静态文档
   ├─ PROTOCOL.md ROLES.md README.md AUTOMATIONS.md
   ├─ automations/           # 框架派发器 + provider 入口（调度）
   └─ guides/
```

## 设计原则

- **仓库只放静态内容**：协议、技能、角色模板、配置片段、安装器。**运行时状态**（`team/tasks/`、`team/workspace/`、会话 registry）留在本机，不入库。
- **幂等**：可反复执行；默认不覆盖既有文件，`--force` 才覆盖。
- **不碰机密**：仓库内无 token / 凭证 / 绝对个人路径。
- **本地优先**：先本地跑通，再决定推送到哪个 GitHub 账号。

## 未包含（明确边界）

- 插件 / 原生扩展（Phase B）。
- 运行时任务卡与工作区产物。

## 验证（Docker）

验证**在容器内跑，绝不在宿主**：

```bash
docker/verify.sh          # 构建镜像 + 跑离线套件
docker/verify.sh --net    # 额外验证上游拉取路径
docker compose -f docker/docker-compose.yml up --build --abort-on-container-exit
```

`docker/verify-in-container.sh` 是唯一健康事实源（CI 跑同一脚本），「本地绿 = CI 绿」。覆盖：shell/node 语法 · manifest+lock 完整性 · 安装器与 fetcher 干跑 · 真实文件部署（隔离 HOME）· 安装→升级→备份路径。

## License

MIT — 见 [LICENSE](LICENSE)。
