# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

`openclaw-team` is a **distribution channel, not a running system**. It ships an
idempotent installer (`install.sh`) that deploys an AI agent dev team — one
coordinator (Elon) plus four specialists (Jobs/Linus/Turing/Assistant) — onto an
OpenClaw host. The live system lives at `~/.openclaw/team/`; this repo is the
source it is deployed from and the place the framework's own gate script and
tests are written.

**This split drives almost every rule below.** There is no build step, no
package.json, and no dependency tree to install — the artifacts are shell
scripts, Node ESM (`.mjs`), Markdown docs, and JSON5 config fragments.

### Repo ↔ deployed instance (the central invariant)

[team/scripts/check-all.sh](team/scripts/check-all.sh) runs a **bidirectional drift
patrol** (`diff -rq $REPO/team $TEAM`). Drift on the deploy surfaces
(`team/scripts/**`, `team/automations/**`, `tools/**`) is **fail-closed** — the
live gate goes red. Consequences:

- **Never hand-copy files between the repo and `~/.openclaw/team/`.** `install.sh`
  is the sanctioned deploy path, and the repo↔instance mirror is by
  **substitution of matching paths**, never a wholesale copy (runtime dirs
  `tasks/`, `workspace/`, `memory/` and host-local additions like
  `tools/openssl3` exist on the instance only and must not be clobbered).
- Editing a deployed script in place makes the repo stale; fixing it in the repo
  without deploying makes the instance stale. Both directions are checked.
- To evaluate a lane's unmerged content against the gate without the instance
  drift dictating the colour, set `OPENCLAW_TEAM_REPO=<repo>` (overrides
  `.install-state.json.repoPath`). Note `check-redlines.mjs` and `lint-refs.mjs`
  ignore it.

`team/scripts/**` is described as **byte-identical to the deployed runtime**:
these files carry no local edits — fix in the runtime and re-copy the whole flat
set, so the two never diverge. `team/scripts/tests/` is the documented exception
(tests written for the repo).

## Common commands

```bash
# Install / upgrade (idempotent; preview first)
./install.sh --dry-run
./install.sh
./install.sh --keep-existing       # never overwrite (skip instead of upgrade)
./install.sh --force               # overwrite managed content

# Framework tests — green with no prerequisites, run bare
node --test team/scripts/tests/*.test.mjs
node --test team/scripts/tests/claim-guard.test.mjs        # a single suite

# Repo-side tests (installer / skills update)
node --test test/install/*.test.mjs
node --test test/skills/*.test.mjs

# The gate (single source of checks; also what the hourly job runs)
bash team/scripts/check-all.sh                     # --segment all (default)
bash team/scripts/check-all.sh --segment fast      # seconds; the in-band segment
bash team/scripts/check-all.sh --segment slow      # node --test conformance suites
bash team/scripts/check-all.sh --report /tmp/v.json

# Verification — runs inside Docker, NEVER on the host (project convention)
docker/verify.sh                                   # build image + offline suite
docker/verify.sh --net                             # also exercise upstream skill fetch
docker/ui-fidelity/verify.sh                       # pixel-deterministic UI-fidelity image

# Skill upstream drift (read-only unless --apply)
node skills/update.mjs
node skills/update.mjs --apply
```

CI (`.github/workflows/verify.yml`) runs exactly `docker/verify-in-container.sh`,
which is the single source of truth — a green local `docker/verify.sh` and a
green CI run mean the same thing.

## Architecture

### The installer — [install.sh](install.sh)

Single entry point, every stage idempotent. Stages (§ markers in the file):

| § | Action |
|---|---|
| 0 | preflight (node / OpenClaw CLI; warns on missing `claude`/`codex`) |
| 1 | team docs → `~/.openclaw/team/` (`PROTOCOL.md`, `ROLES.md`, `guides/`); never touches `tasks/`, `workspace/`, `memory/` |
| 1a | repo `tools/` → instance `$TEAM/tools/` |
| 1b–1c | prototype carrier choice (recorded in `team.config.json`) + connector check |
| 1d | masked API-key prompt → `$TEAM/.secrets.env` (0600) |
| 2 | skills resolved from `skills/manifest.json` sources (`--vendor` snapshots, `--offline` restores) |
| 3 | agents + role seeds (`roles/<agent>/{AGENTS,SOUL,IDENTITY,USER}.md`); existing `USER.md` never overwritten |
| 4 | `openclaw config patch --file config/*.json5` |
| 4b | providers backfill via `config/optimization.mjs` (merge, never whole-file) |
| 5 | task provider (ACL) — meerkat-taskpanel by default |
| 6 | team automations via `config/reconcile.mjs` (declarative by `declarationKey`; add/edit/skip) |

Managed content is overwritten on upgrade (with a `.backups/<ts>/` copy of any
differing file); user-owned content (`USER.md`, `tasks/`, `workspace/`,
`memory/`, session registries) is never touched.

### Scheduling — provider-agnostic by construction

Every scheduled job calls the framework dispatcher
[team/automations/dispatch.mjs](team/automations/dispatch.mjs), which resolves the
provider's entry command from
[team/automations/providers.json](team/automations/providers.json) and prints one
line `{"fire": bool}`. **No trigger script contains a provider literal**, so
swapping the task base (meerkat-taskpanel → Jira / Plane / Linear) changes zero
jobs. Failure/timeout/unparseable output degrades differently by job kind:
action jobs (`poll`, `patrol`) → `fire:false` (don't wake anyone); the health
gate (`check-all`) → `fire:true` (an unconfirmed gate must alarm, not read as
green).

Jobs are registered declaratively by
[config/reconcile.mjs](config/reconcile.mjs) — declared jobs are the single source
of truth; each run aligns the runtime (missing ⇒ add, drifted ⇒ edit, matching ⇒
skip). Overrides for local testing: `OPENCLAW_TEAM_POLL_CMD`,
`OPENCLAW_TEAM_PATROL_CMD`, `OPENCLAW_TEAM_CHECKALL_CMD`, and
`OPENCLAW_TEAM_TASK_PROVIDER=<name>`.

### The gate — [team/scripts/check-all.sh](team/scripts/check-all.sh)

The single source of checks. It is **read-only**: no step may write `tasks/`
(archival runs `--dry-run` only). It prints a final-line envelope
`{"ok":true|false, ...}`, carrying `message` and `failed[]` on red.

It is **segmented** because the full run (~15–20 s) exceeds the scheduler's
trigger-evaluation budget (`OPENCLAW_TEAM_EVAL_TIMEOUT_MS`, default 8000 ms), and
a timeout envelope carries no verdict — a real red would be silently masked.

- `--segment fast` — seconds; runs in-band under
  `OPENCLAW_TEAM_CHECKALL_FAST_TIMEOUT_MS` (6000 ms; typical warm 2.4–3.7 s).
- `--segment slow` — `node --test` framework suite plus the provider ACL full
  suite (not in-band; would fast-timeout).
- `--segment all` — both; the default for humans and CI.

[team/scripts/check-all-gate.mjs](team/scripts/check-all-gate.mjs) is the scheduled
entry: runs the fast segment in-band, folds in the cached slow verdict, and
refreshes that cache out of band.

### Runtime and isolation

- **[team/scripts/lib.mjs](team/scripts/lib.mjs) is the shared library** — card
  frontmatter I/O, atomic claim, project registry — implementing the board
  protocol primitives of `PROTOCOL.md`.
- **Provider ACL is a deliberate runtime dependency, not vendored.** `lib.mjs`
  imports `{team}/skills/task-ops/lib/team-paths.mjs` (owned by the task
  provider; see `skills/PROVENANCE.md`). At import time it checks the library is
  present and **hard-fails with a clear error and non-zero exit** — never a
  silent no-op. Point `OPENCLAW_TASK_OPS_DIR` at a checkout containing `lib/` to
  satisfy it.
- **Path override:** `OPENCLAW_TEAM_ROOT` (default `~/.openclaw/team`) is the
  isolation seam used by unit tests; `lib.mjs`, `check-all.sh`, and `scan-deps.mjs`
  are same-origin on it, but `check-redlines.mjs` and `lint-refs.mjs` are not.
- **Lane isolation** — [team/scripts/lane-isolation.mjs](team/scripts/lane-isolation.mjs),
  [team/scripts/lane-worktree.mjs](team/scripts/lane-worktree.mjs),
  [team/scripts/spawn-lane.mjs](team/scripts/spawn-lane.mjs). Same repo + a
  concurrent lane ⇒ one git worktree per lane (automatic; `--no-isolate` opts
  out). The lane base defaults to **`dev`** ([PROTOCOL §⑥.4](team/PROTOCOL.md);
  continuation segs use the previous seg's branch tip; `OPENCLAW_LANE_BASE`
  overrides; an unresolvable base is refused, never silently `HEAD`). A lane's
  product merges into `dev`; [team/scripts/branch-guard.mjs](team/scripts/branch-guard.mjs)
  refuses a direct commit on the protected branch (`main`). Contract:
  [team/guides/worktree-isolation-sop.md](team/guides/worktree-isolation-sop.md),
  [team/guides/spawn-lane-sop.md](team/guides/spawn-lane-sop.md).

### Content layers

- **[team/](team/)** — static docs deployed to `~/.openclaw/team/`.
  [PROTOCOL.md](team/PROTOCOL.md) is the single source of the protocol body (board
  protocol, state machine, dispatch matrix, gates); [ROLES.md](team/ROLES.md) is
  the boundary/handoff reconciliation table. Other docs **reference, not copy**.
  [team/guides/](team/guides/) holds the per-domain SOPs and contracts
  (`task-interface.md` is the ACL contract; `redlines.core.md` is the canonical
  redlines source for `check-redlines.mjs`).
- **[roles/<agent>/](roles/)** — workspace seed files. `AGENTS.md` is the role's
  standing orders (SOP).
- **[config/](config/)** — `*.json5` are auto-applied; `config/examples/*` are
  reference-only and never applied.
- **[skills/](skills/)** — skill bodies are **not stored here**. `manifest.json`
  declares upstream sources, `lock.json` pins refs and tree hashes; the installer
  fetches them. Entries with `needs_source: true` are skipped until resolved.
- **[tools/](tools/)** — `ui-fidelity/` (L1 structural · L2 pixel regression ·
  L3 prototype-as-oracle) and `ui-align/`.

## Conventions

- **The card state machine is `todo`** (`ready` is a retained legacy alias —
  `lib.mjs#isNewStatus` accepts both). `backlog | todo → in_progress → in_review
  → done`; `blocked` / `canceled` are side/terminal.
- **Much of `team/` code and gate output is in Chinese** — comments, gate step
  labels, and error messages. Match the surrounding language when editing those
  files; the English `README.md` is the canonical documentation language
  (`README.zh-CN.md` is the mirror).
- **Config writes are always merge/patch** — `~/.openclaw/openclaw.json` is never
  whole-file replaced.
- Commit messages in this repo are conventional-commit style with a `(scope)`
  and a trailing card id, e.g.
  `fix(check-all): 防漂移巡检… (T-20261014-214625)`. Work is tracked by cards
  whose id is the filename (`T-YYYYMMDD-HHMMSS.md`).
