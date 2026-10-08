# openclaw-team

把一支 **AI Agent 研发团队** 装进一台 OpenClaw 主机：一名统筹（Elon）＋四名专家（设计 / 开发 / 测试 / 助理）。定位是**标准个人独立开发者**的多 agent 工作流——不含量化研究角色。

本仓库是 **Phase A（纯文件 + 幂等安装器）**：`install.sh` 把协议、角色工作区、技能、agent 注册与配置装配到 OpenClaw，并可重复执行。**不含插件**（Phase B 已明确不做）。

```text
Terry / 你  ──►  Elon(main，统筹)  ──►  Jobs(设计) · Linus(开发) · Turing(测试) · Assistant(杂务)
```

## 角色

| 角色 | agent id | 工作区 | 职责 |
|---|---|---|---|
| 🧠 Elon | `main` | `workspace-elon` | 需求入口 / 建卡 / 派单 / 验收 / 汇报 |
| 🎨 Jobs | `jobs` | `workspace-jobs` | 产品设计 / PRD / UI / UX |
| ⚙️ Linus | `linus` | `workspace-linus` | 代码开发 / 缺陷修复 / 重构 |
| 🧪 Turing | `turing` | `workspace-turing` | 测试 / 验收 / 回归 / 安全审计 |
| 🧹 Assistant | `assistant` | `workspace-assistant` | 视频解析 / 运营 / 无明确边界杂活 |

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
| `--task-panel DIR` | 指定 task-panel 源码路径 |
| `--no-task-panel` | 不检查/安装 task-panel |
| `--skip-skills` `--skip-agents` `--skip-config` `--skip-team` | 跳过对应阶段 |

安装器做这些事（每步幂等，已存在则跳过）：

1. **预检**：node / openclaw CLI；检查 `claude`、`codex` 是否存在（缺失给出安装提示，不中断）。
2. **团队文档** → `~/.openclaw/team/`（`PROTOCOL.md`、`ROLES.md`、`README.md`、`guides/`）。**不覆盖**运行时目录 `tasks/`、`workspace/`、`memory/`。
3. **技能** → 见下表。
4. **Agent 与角色工作区**：拷贝 `AGENTS.md`/`SOUL.md`/`IDENTITY.md`，然后 `openclaw agents add <id> --workspace <dir> --non-interactive`；已注册则跳过。**永不覆盖**既有的 `USER.md`。
5. **配置片段** → `openclaw config patch --file config/*.json5`（`config/examples/` 下的示例不会自动应用）。
6. **task-panel 依赖**：检测 `~/.openclaw/skills/task-panel`；缺失则调用其 `install.sh --target openclaw` 安装。

### 技能安装目标

| 来源 | 目标 |
|---|---|
| `skills/openclaw/` | `~/.openclaw/skills/` |
| `skills/claude/` | `~/.claude/skills/` |
| `skills/codex/` | `~/.codex/skills/` |
| `skills/agents/<agent>/` | `~/.openclaw/workspace-<agent>/skills/` |

技能来源与许可见 [`skills/PROVENANCE.md`](skills/PROVENANCE.md)。

## 依赖：task-panel

任务管理不在本仓库内——团队消费独立项目 **task-panel**（本地看板 + agent 领取/心跳/依赖树）。安装器会检测并代为安装：

```bash
./install.sh --task-panel ~/Documents/task-panel   # 显式指定源码
```

未找到源码时会给出警告与克隆指引；`task-panel` 提供的技能即团队的任务技能（本仓库不再自带旧 `task-ops`）。

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
- **不碰机密**：仓库内无 token / 凭证 / 绝对路径；`config/examples/` 用占位符。
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
