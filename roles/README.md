# roles/

每个子目录是一支 team 中某个 **agent 的工作区种子**。`install.sh` 会把它们部署到 `~/.openclaw/workspace-<agent>/`。

| 目录 | agent id | 工作区 |
|---|---|---|
| `elon/` | `main` | `workspace-elon` |
| `jobs/` | `jobs` | `workspace-jobs` |
| `linus/` | `linus` | `workspace-linus` |
| `turing/` | `turing` | `workspace-turing` |
| `assistant/` | `assistant` | `workspace-assistant` |

文件：

- `AGENTS.md` — 岗位运行说明 / Standing Orders（强约束）。
- `SOUL.md` — 角色信条与沟通风格。
- `IDENTITY.md` — name / emoji / theme 镜像（权威在 `openclaw.json`）。
- `USER.md` — 用户偏好模板。**安装器永不覆盖已存在的 `USER.md`**，请按需编辑。

> 这些角色提示词取自一支**已在运行的参考团队**（v0 种子），开箱可用；请按自身项目习惯微调。运行时文件（`MEMORY.md`、`DREAMS.md`、`memory/`）**不随仓库分发**，由 OpenClaw 本地生成/维护。
