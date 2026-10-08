# roles/

Each subdirectory is the **workspace seed** for one agent in the team.
`install.sh` deploys them to `~/.openclaw/workspace-<agent>/`.

| Dir | agent id | workspace |
|---|---|---|
| `elon/` | `main` | `workspace-elon` |
| `jobs/` | `jobs` | `workspace-jobs` |
| `linus/` | `linus` | `workspace-linus` |
| `turing/` | `turing` | `workspace-turing` |
| `assistant/` | `assistant` | `workspace-assistant` |

Files:

- `AGENTS.md` — role operating instructions / standing orders (strong constraints).
- `SOUL.md` — role creed and communication style.
- `IDENTITY.md` — name / emoji / theme mirror (authoritative values live in `openclaw.json`).
- `USER.md` — user-preference template. The installer **never overwrites** an
  existing `USER.md`; edit it per host.

> These role prompts are a **v0 seed** taken from a running reference team — usable
> out of the box, but tune them to your own habits. Runtime files (`MEMORY.md`,
> `DREAMS.md`, `memory/`) are **not** shipped; OpenClaw creates them locally.
