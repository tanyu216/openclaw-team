# openclaw-team

Install a small **AI agent dev team** onto an OpenClaw host: one coordinator (Elon)
plus four specialists (design / engineering / QA / assistant). Built for a
**standard individual independent developer** workflow — no quant-research role.

> **English is the default documentation language.** 中文说明见 [README.zh-CN.md](README.zh-CN.md).

This repository is **Phase A (file-based, idempotent installer)**: `install.sh`
deploys protocol docs, per-agent workspaces (roles), skills, agent registration,
and config wiring onto OpenClaw. It is safe to re-run. **No plugin is involved**
(Phase B was explicitly dropped).

```text
You  ──►  Elon (main, coordinator)  ──►  Jobs (design) · Linus (dev) · Turing (QA) · Assistant (misc)
```

## Roles

| Role | agent id | workspace | Responsibility |
|---|---|---|---|
| 🧠 Elon | `main` | `workspace-elon` | Intake / carding / dispatch / acceptance / reporting |
| 🎨 Jobs | `jobs` | `workspace-jobs` | Product design / PRD / UI / UX |
| ⚙️ Linus | `linus` | `workspace-linus` | Implementation / fixes / refactoring · **CI gates / build / release / deploy** |
| 🧪 Turing | `turing` | `workspace-turing` | Testing / acceptance / regression / security audit |
| 🧹 Assistant | `assistant` | `workspace-assistant` | Video parsing / ops / misc |

> The quant-research role (Simons) is **not** part of this repository — this
> project targets general solo developers.

## Install

```bash
git clone <this-repo> ~/Documents/openclaw-team
cd ~/Documents/openclaw-team
./install.sh --dry-run      # preview every action
./install.sh                # idempotent install
```

Options:

| Option | Meaning |
|---|---|
| `--dry-run` | Print planned actions, change nothing |
| `--force` | Overwrite existing skills / role files / team docs |
| `--openclaw-home DIR` | OpenClaw home (default `~/.openclaw`) |
| `--claude-home DIR` / `--codex-home DIR` | Claude Code / Codex home |
| `--with-task-panel` | Install the reference task provider (task-panel) |
| `--task-panel DIR` | Path to the task-panel source checkout |
| `--no-task-panel` | Skip the task-provider step |
| `--keep-existing` | Never overwrite existing files (skip instead of upgrade) |
| `--skip-skills` `--skip-agents` `--skip-config` `--skip-team` | Skip a stage |
| `--vendor` | Snapshot skills from their sources into `skills/vendor/` |
| `--offline` | Install skills from `skills/vendor/` (no network) |

What the installer does (every stage is idempotent; existing items are skipped):

1. **Preflight** — node / OpenClaw CLI; checks for `claude` and `codex` (warns with
   install hints if absent; never aborts).
2. **Team docs** → `~/.openclaw/team/` (`PROTOCOL.md`, `ROLES.md`, `README.md`,
   `guides/`). Never touches runtime dirs `tasks/`, `workspace/`, `memory/`.
3. **Skills (declared sources)** — resolves every entry in `skills/manifest.json`
   from its upstream (ClawHub / GitHub / git) and installs it into the right
   target. Entries with no verified upstream (`needs_source`) are skipped with a
   warning. `--vendor` snapshots sources into `skills/vendor/`; `--offline`
   installs from that snapshot.
4. **Agents & role workspaces** — copies `AGENTS.md`/`SOUL.md`/`IDENTITY.md`, then
   `openclaw agents add <id> --workspace <dir> --non-interactive` (skipped if the
   agent already exists). An existing `USER.md` is **never** overwritten.
5. **Config fragments** → `openclaw config patch --file config/*.json5`
   (anything under `config/examples/` is reference-only and not applied).
6. **Task provider (ACL)** — reports any configured provider
   (`OPENCLAW_TEAM_TASK_PROVIDER`). Installs the reference provider only with
   `--with-task-panel`; otherwise prints how to bring your own.

### Upgrade / reinstall

The default mode is **install-or-upgrade**. Re-running `./install.sh` after a repo
update overwrites previously installed managed content:

- **Managed** (updated on upgrade): team docs, role seeds `AGENTS.md` / `SOUL.md` /
  `IDENTITY.md`, config fragments, and skills.
- **User-owned** (never touched): `USER.md`, `team/tasks/`, `team/workspace/`,
  `team/memory/`, `team/projects.json`, and the session registries.
- **Backup**: any managed file that differs is copied to
  `~/.openclaw/team/.backups/<timestamp>/` **before** being overwritten.
- **State**: the installed version is recorded in
  `~/.openclaw/team/.install-state.json`; upgrades print the old → new version.
- **Opt out**: `--keep-existing` restores the old install-only behaviour (skip
  existing files).

```bash
./install.sh --dry-run        # preview install/upgrade actions
./install.sh                  # install or upgrade managed content
./install.sh --keep-existing  # never overwrite
```

### Skills (option A: declarations, not vendored code)

Skill **bodies are not stored in this repo**. `skills/manifest.json` declares each
skill's upstream source; `skills/lock.json` pins resolved refs and tree hashes.
The installer fetches from source:

```bash
./install.sh                 # fetch + install from declared sources
./install.sh --vendor        # snapshot sources into skills/vendor/
./install.sh --offline       # install from a previous snapshot (no network)
```

Targets:

| Target | Where |
|---|---|
| `openclaw` | `~/.openclaw/skills/` |
| `claude` | `~/.claude/skills/` |
| `codex` | `~/.codex/skills/` |
| `agent:<id>` | `~/.openclaw/workspace-<id>/skills/` |

Entries marked `needs_source: true` have no verified upstream yet and are skipped
until resolved. Provenance notes: [`skills/PROVENANCE.md`](skills/PROVENANCE.md).

> **Migrated (option A complete)**: third-party skill bodies are no longer
> vendored. All 90 declared skills resolve to verified upstreams (GitHub / ClawHub)
> and are fetched at install time via `skills/fetch.mjs`.

## Task system (pluggable, via ACL)

Task management is **not bundled** and is **not a hard dependency**. The team
talks to any task system through a small **ACL** contract
(`team/guides/task-interface.md`): cards, atomic claim + heartbeat, a
`ready → in_progress → in_review → done | failed` state machine,
comments/process trail, and a parent/child + dependency DAG.

- **Reference provider** — **task-panel** ships a task skill and a `taskctl` CLI.
  Install it only if you want it:
  `./install.sh --with-task-panel [--task-panel DIR]`.
- **Bring your own** — Jira, Linear, Plane, GitHub Issues, a custom board, …:
  install that system's connector skill/MCP yourself and point the team at it
  with `OPENCLAW_TEAM_TASK_PROVIDER=<name>`.
- **Out of scope** — connector skills/MCP for third-party task systems are not
  part of this project; the repo ships only the ACL and the team-side
  adaptation contract.

## Repository layout

```text
openclaw-team/
├─ install.sh                # idempotent installer entry point
├─ config/                   # auto-applied config patches (*.json5)
│  └─ examples/              # reference only (model / bindings / automations / projects)
├─ roles/<agent>/            # workspace seeds: AGENTS/SOUL/IDENTITY/USER.md
├─ skills/
│  ├─ openclaw/              # global OpenClaw skills
│  ├─ claude/ codex/         # Claude Code / Codex skills
│  ├─ agents/<agent>/        # per-agent workspace skills
│  └─ PROVENANCE.md          # source + license manifest
└─ team/                     # static docs deployed to ~/.openclaw/team/
   ├─ PROTOCOL.md ROLES.md README.md
   └─ guides/
```

## Design principles

- **Static content only**: protocol, skills, role seeds, config fragments, installer.
  **Runtime state** (`team/tasks/`, `team/workspace/`, session registries) stays on
  the host and is never committed.
- **Idempotent**: re-runnable; existing files are preserved unless `--force`.
- **No secrets**: no tokens, credentials, or absolute personal paths in the repo.
- **Local first**: verify locally, then decide where to push.

## Out of scope

- Plugins / native extensions (Phase B).
- Quant-research roles and skills.
- Runtime task cards and workspace artifacts.

## Verify

```bash
bash -n install.sh
./install.sh --dry-run
openclaw doctor
```

## License

MIT — see [LICENSE](LICENSE).
