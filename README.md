# openclaw-team

Install a small **AI agent dev team** onto an OpenClaw host: one coordinator (Elon)
plus four specialists (design / engineering / QA / assistant). Built for a
**standard individual independent developer** workflow.

> **English is the default documentation language.** See [README.zh-CN.md](README.zh-CN.md) for the Chinese mirror.

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

> **Positioning & extending roles**: `openclaw-team` is a **framework for individual
> developers to quickly stand up a dev team**. These **five roles (elon / jobs / linus /
> turing / assistant) are the standard built-ins**. **Roles beyond the five** (e.g.
> business-specific positions) are **defined/extended by the user** — the framework
> does not hard-code any instance's extra roles.


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
| `--task-panel DIR` | Path to the task-panel source checkout |
| `--with-task-panel` | Install the reference task provider (**task-panel is installed by default**) |
| `--no-task-panel` | Opt out of task-panel; bring your own task system (Jira / Plane / Linear / …) via the `task-interface` ACL |
| `--skip-automations` | Do not register the team-level scheduled jobs |
| `--prototype <carrier>` | Prototype carrier: `static-html` \| `figma` \| `google-stitch` \| `pixso` (default `static-html`); recorded in `~/.openclaw/team/team.config.json` for Jobs/Linus |
| `--keys` / `--skip-keys` | Force / skip the interactive API-key prompt (default: prompt only on a TTY) |
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
6. **Task provider (ACL)** — reports the configured provider
   (`OPENCLAW_TEAM_TASK_PROVIDER`, default `task-panel`) and installs the
   reference provider **task-panel by default**. `--no-task-panel` opts out and
   prints how to bring your own (Jira / Plane / Linear / … via the `task-interface`
   ACL).
7. **Team automations (scheduling)** — registers the team-level scheduled jobs
   (`poll-<agent>` every 1m, `task-patrol` every 5m, `team-check-all` hourly),
   **idempotently** (by `declarationKey`) and **provider-agnostically**: each
   trigger calls the framework dispatcher `team/automations/dispatch.mjs`, never a
   provider literal. `--skip-automations` disables it. See
   [Scheduling & team automations](#scheduling--team-automations).

### Upgrade / reinstall

The default mode is **install-or-upgrade**. Re-running `./install.sh` after a repo
update overwrites previously installed managed content:

- **Managed** (updated on upgrade): team docs, role seeds `AGENTS.md` / `SOUL.md` /
  `IDENTITY.md`, config fragments, and skills.
- **User-owned** (never touched): `USER.md`, `team/tasks/`, `team/workspace/`,
  `team/memory/`, and the session registries.
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

## Task system & scheduling (pluggable, via ACL)

**Ownership boundary**: `openclaw-team` owns the **scheduling** and the **ACL
abstraction**; the task base (task-panel / Jira / Plane / …) is only a **callee**
behind the ACL. The full contract is `team/guides/task-interface.md` (cards, atomic
claim + heartbeat, the `ready → in_progress → in_review → done | failed` state
machine, comments/process trail, and a parent/child + dependency DAG); this README
does not restate it.

- **Default provider — task-panel**: installed by default (task skill + `taskctl`
  CLI). Opt out with `./install.sh --no-task-panel`; supply a source checkout with
  `--task-panel DIR`.
- **Bring your own / swap the base** — Jira, Linear, Plane, GitHub Issues, a custom
  board, …: install that system's connector skill/MCP and point the team at it with
  `OPENCLAW_TEAM_TASK_PROVIDER=<name>`. The upper layers (roles / SOP / jobs) change
  **zero** because they depend only on the ACL; then run the ACL contract tests
  (`task-interface.md §6`, `§12`).
- **Out of scope** — connector skills/MCP for third-party task systems are not part
  of this project; the repo ships only the ACL and the team-side adaptation contract.
- **Idempotent card creation** — creating cards is **idempotent**: before creating,
  the creator (LLM) **semantically de-duplicates** against existing non-terminal
  cards, backed by a mechanical key `idem = <kind>|<assignee>|<source>|<target>`;
  a same-key non-terminal card ⇒ **reject/reuse** (the repo bundles no create path,
  so the convention is **guaranteed by the connected provider** + the creator
  carrying the `idem` key). See `team/PROTOCOL.md §㉙` and
  `team/guides/task-interface.md §14`.

### Scheduling & team automations

Team-level **scheduling is framework-owned and provider-agnostic** — it is *not*
delegated to the task provider. `install.sh` registers three kinds of job
(idempotently, by `declarationKey`; `--skip-automations` disables them):

| Job | Schedule | Purpose |
|---|---|---|
| `poll-<agent>` | every 1m | per-worker board poll (jobs/linus/turing/assistant); fires only when a card is claimed |
| `task-patrol` | every 5m | stale `in_progress` heartbeat scan |
| `team-check-all` | hourly (`0 * * * *` @ Asia/Shanghai) | gate patrol; fires only on failure |

Each trigger calls the framework dispatcher
`team/automations/dispatch.mjs <poll|patrol|check-all> [agent]`, which resolves the
provider's entry command (`team/automations/providers.json`; provider =
`OPENCLAW_TEAM_TASK_PROVIDER`, default `task-panel`) and returns `{"fire":…}`. **The
entry scripts themselves ship with this repository** — `poll.mjs`, `patrol-scan.mjs`,
`check-all.sh` and their dependency closure live in `team/scripts/**` and are
installed into `{team}/scripts/**`, so a fresh install has no dangling entry path.
No trigger script contains a provider literal, so **swapping the base changes zero
jobs**. A missing entry / failure / timeout / unparseable output ⇒ `fire:false`
(zero cost). Trigger evaluation is bounded (`OPENCLAW_TEAM_EVAL_TIMEOUT_MS`, default
8000 ms); the `already-running` run lock and stale-run release are platform
(Gateway scheduler) concerns the framework does not claim to solve.
Details and ACL gaps: `team/automations/README.md`, `team/AUTOMATIONS.md §3.5`.

### Extending roles

The five built-in roles (elon / jobs / linus / turing / assistant) are the standard
set; **roles beyond the five are defined by the user** — the framework does not
hard-code an instance's extra roles (see [Roles](#roles)). Adding one means adding
its workspace seed files and (optionally) a `poll-<agent>` automation; scheduling
itself stays the framework's job.

## Repository layout

```text
openclaw-team/
├─ install.sh                # idempotent installer entry point
├─ config/                   # auto-applied config patches (*.json5)
│  └─ examples/              # reference only (model / bindings / automations / project-metadata)
├─ roles/<agent>/            # workspace seeds: AGENTS/SOUL/IDENTITY/USER.md
├─ skills/
│  ├─ openclaw/              # global OpenClaw skills
│  ├─ claude/ codex/         # Claude Code / Codex skills
│  ├─ agents/<agent>/        # per-agent workspace skills
│  └─ PROVENANCE.md          # source + license manifest
└─ team/                     # static docs deployed to ~/.openclaw/team/
   ├─ PROTOCOL.md ROLES.md README.md AUTOMATIONS.md
   ├─ automations/           # framework dispatcher + provider entries (scheduling)
   ├─ scripts/               # framework entry scripts (poll/patrol/check-all) + tests
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
- Runtime task cards and workspace artifacts.

## Verify (Docker)

Verification runs **inside Docker, never on the host**:

```bash
docker/verify.sh          # build image + run the offline suite
docker/verify.sh --net    # also exercise the upstream fetch path
docker compose -f docker/docker-compose.yml up --build --abort-on-container-exit
```

`docker/verify-in-container.sh` is the single source of truth (CI runs the same
script), so a green local run and a green CI run mean the same thing. It covers
shell/node syntax, manifest+lock integrity, installer/fetcher dry-runs, a real
file deploy into a throwaway HOME, and the install→upgrade→backup path.

For **UI fidelity** there is a second, network-based image that pins the browser
and fonts so pixel diffs are deterministic:

```bash
docker/ui-fidelity/verify.sh    # build + run the ui-fidelity self-test
```

See `tools/ui-fidelity/README.md` (L1 structural · L2 pixel regression · L3
prototype-as-oracle) and `team/guides/ui-align-sop.md` §10.

### Prototype carrier

The UI prototype's source is a **deployment choice** (`install.sh --prototype`),
recorded in `~/.openclaw/team/team.config.json` and consumed by both Jobs
(produces the baseline) and Linus (implements against it):

| Carrier | Baseline source | Required connector |
|---|---|---|
| `static-html` (default) | HTML/CSS/JS under `prototype/**` (closed stack: Tailwind + daisyUI + jQuery) | none |
| `figma` | Figma via MCP/API, or the exported static HTML mirror | MCP server **`figma`** |
| `google-stitch` | Stitch export bundle (static HTML + tokens + assets) | MCP/skill **`stitch`** |
| `pixso` | Pixso via MCP, or the exported file | MCP server **`pixso`** |

The installer **checks** the connector for non-`static-html` carriers and warns when it
is missing (declared in `config/prototype-carriers.json`; template in
`config/examples/mcp.example.json5`). Connectors are user-supplied.

See `roles/linus/AGENTS.md` "Prototype Consumption" and `roles/jobs/AGENTS.md`
carrier routing.

### API keys

Keys the install may need are declared in `config/api-keys.json` — the model
provider key, the memory-search key, `TAVILY_API_KEY` (used by the `tavily-*`
skills; keyless access has limits), and carrier tokens for
`figma`/`pixso`/`google-stitch`. When interactive the installer **prompts for each
one with hidden input**, and you may press **Enter to skip**; provided values are
stored `0600` in `~/.openclaw/team/.secrets.env` (never in the repo, never echoed).
At the end it prints a **unified key summary**: the status of every key plus the
exact command to set each one later. Non-interactive runs never prompt — they just
print the summary. Re-enter keys any time with `./install.sh --keys`.

## License

MIT — see [LICENSE](LICENSE).
