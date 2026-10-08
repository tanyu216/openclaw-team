# openclaw-team

把一支 **AI Agent 研发团队** 装进一台 OpenClaw 主机：一名统筹（Elon）＋四名专家（设计 / 开发 / 测试 / 助理）。定位是**标准个人独立开发者**的多 agent 工作流——不含量化研究角色。

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
| ⚙️ Linus | `linus` | `workspace-linus` | 代码开发 / 缺陷修复 / 重构 |
| 🧪 Turing | `turing` | `workspace-turing` | 测试 / 验收 / 回归 / 安全审计 |
| 🧹 Assistant | `assistant` | `workspace-assistant` | 视频解析 / 运营 / 杂活 |

> 量化研究角色（Simons）**不在本仓库内**——本项目面向通用个人开发者。

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
| `--with-task-panel` | 安装参考任务提供方（task-panel） |
| `--task-panel DIR` | 指定 task-panel 源码路径 |
| `--no-task-panel` | 跳过任务提供方阶段 |
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
6. **任务提供方（ACL）**：报告已配置的提供方（`OPENCLAW_TEAM_TASK_PROVIDER`）；仅在 `--with-task-panel` 时安装参考实现，否则打印「自备」指引。

### 升级 / 重装

默认模式为 **安装或升级**。仓库更新后重跑 `./install.sh` 会**覆盖**先前安装的受管内容：

- **受管**（升级时更新）：团队文档、角色种子 `AGENTS.md` / `SOUL.md` / `IDENTITY.md`、配置片段、技能。
- **用户所有**（从不触碰）：`USER.md`、`team/tasks/`、`team/workspace/`、`team/memory/`、`team/projects.json` 与会话 registry。
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

> **迁移说明**：旧 `skills/{openclaw,claude,codex,agents}/` 副本暂留作过渡兜底；待 manifest 每条都有已核来源后移除。

## 任务系统（可切换，经 ACL）

任务管理**不在本仓库内**，且**非强制依赖**。团队经一个小的 **ACL** 契约（`team/guides/task-interface.md`）对接任意任务系统：卡、原子领取 + 心跳、`ready → in_progress → in_review → done | failed` 状态机、评论/过程留痕、父子 + 依赖 DAG。

- **参考提供方**：**task-panel**（提供任务 skill + `taskctl` CLI）。需要时安装：`./install.sh --with-task-panel [--task-panel DIR]`。
- **自备**：Jira / Linear / Plane / GitHub Issues / 自研看板 … —— 自行安装其连接 skill/MCP，并用 `OPENCLAW_TEAM_TASK_PROVIDER=<name>` 指向它。
- **范围边界**：第三方任务系统的连接 skill/MCP **不在本项目范围**；本仓库只交付 ACL 与团队侧适配约定。

## 仓库结构

```text
openclaw-team/
├─ install.sh                # 幂等安装入口
├─ config/                   # 自动应用的 config patch（*.json5）
│  └─ examples/              # 仅参考、不自动应用（模型/绑定/自动化/项目）
├─ roles/<agent>/            # 每角色工作区种子：AGENTS/SOUL/IDENTITY/USER.md
├─ skills/
│  ├─ openclaw/              # 全局 OpenClaw 技能
│  ├─ claude/ codex/         # Claude Code / Codex 技能
│  ├─ agents/<agent>/        # 各 agent 工作区技能
│  └─ PROVENANCE.md          # 来源与许可清单
└─ team/                     # 部署到 ~/.openclaw/team/ 的静态文档
   ├─ PROTOCOL.md ROLES.md README.md
   └─ guides/
```

## 设计原则

- **仓库只放静态内容**：协议、技能、角色模板、配置片段、安装器。**运行时状态**（`team/tasks/`、`team/workspace/`、会话 registry）留在本机，不入库。
- **幂等**：可反复执行；默认不覆盖既有文件，`--force` 才覆盖。
- **不碰机密**：仓库内无 token / 凭证 / 绝对个人路径。
- **本地优先**：先本地跑通，再决定推送到哪个 GitHub 账号。

## 未包含（明确边界）

- 插件 / 原生扩展（Phase B）。
- 量化研究角色与相关技能。
- 运行时任务卡与工作区产物。

## 验证

```bash
bash -n install.sh
./install.sh --dry-run
openclaw doctor
```

## License

MIT — 见 [LICENSE](LICENSE)。
