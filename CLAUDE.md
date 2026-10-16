# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

`openclaw-team` is an **installable team-building guide, not a running system**.
It ships an idempotent installer (`install.sh`) that stands up an AI agent dev
team — one coordinator (Elon) plus four specialists (Jobs/Linus/Turing/Assistant)
— on an OpenClaw host, by default under `~/.openclaw/team/`. This repository is
the source it is installed from, and the place the framework's own gate script
and tests are written.

**That split drives almost every rule below.** There is no build step, no
package.json, and no dependency tree to install — the artifacts are shell
scripts, Node ESM (`.mjs`), Markdown docs, and JSON5 config fragments.

### The gate: two modes, no host required

[team/scripts/check-all.sh](team/scripts/check-all.sh) runs in one of **two modes**,
decided by whether an installed instance is resolvable (`$TEAM/scripts` exists ⇒
**live**, else **repo**; `--repo <R>` / `--live` / `OPENCLAW_TEAM_MODE` override):

- **live** — audits an **installed instance**: board checks over `tasks/`, the
  provider ACL suites, the archive preview, and the three linters against
  `$OPENCLAW_HOME/workspace-<role>/AGENTS.md`.
- **repo** — **self-verification of this checkout**, needing no instance and no
  host path: syntax (`bash -n` / `node --check`), the three linters in repo mode
  (they check the **seeds** `roles/<role>/AGENTS.md` + `team/**`), and the
  framework suite. Instance-scoped steps are skipped **explicitly**, never red.
  This is the path a contributor, a fresh clone and CI take.

The envelope carries `"mode":"live"|"repo"`. `docker/verify-in-container.sh`
pins the acceptance criterion: a machine with **no** `~/.openclaw` must return
`{"ok":true,"mode":"repo"}`.

**Deploying is `install.sh`'s job, and it is the only sanctioned way** to put
these artifacts on a host — never hand-copy files into `~/.openclaw/team/`. The
mirror is by **substitution of matching paths**, never a wholesale copy: runtime
directories (`tasks/`, `workspace/`, `memory/`) and host-local additions exist on
the instance only and must not be clobbered. Editing a deployed copy in place
makes the repo stale; re-running `install.sh` is what brings a host up to date.

`team/scripts/**` is the artifact set `install.sh` deploys verbatim, and
`team/scripts/tests/` ships with it — those tests are written for this
repository, so treat them as source, not as host configuration.

## Common commands

```bash
# Install / upgrade (idempotent; preview first)
./install.sh --dry-run
./install.sh
./install.sh --keep-existing       # never overwrite (skip instead of upgrade)
./install.sh --force               # overwrite managed content

# Framework tests — 0 failures bare, but ~75% of the suite SKIPS without the provider.
# Suites that need the task-ops provider self-skip (they do not fail). To actually run them,
# point OPENCLAW_TASK_OPS_DIR at a checkout containing lib/ — that is the mode the deployed
# instance runs (`check-all.sh --segment slow`).
#   bare            : 781 tests · 199 pass · 0 fail · 582 skip
#   + provider      : 781 tests · 777 pass · 0 fail ·   4 skip
# NOT covered by CI: CI runs `docker/verify-in-container.sh`, which runs only
# `check-all.sh --segment fast`; this suite lives in the SLOW segment. A green CI run
# therefore says nothing about it.
node --test team/scripts/tests/*.test.mjs
node --test team/scripts/tests/claim-guard.test.mjs        # a single suite

# Repo-side tests (installer / skills update)
node --test test/install/*.test.mjs
node --test test/skills/*.test.mjs

# Doc rewriting: prove no clause was lost (repo-side tool, not deployed)
# before/after diff over team/guides + roles; unregistered losses exit non-zero
node test/docs/doc-clause-diff.mjs --base dev --path team/guides roles

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

# Branch / worktree discipline (dev is the integration base; main is protected)
node team/scripts/branch-guard.mjs                    # refuse a direct commit on the protected branch
node team/scripts/lane-worktree.mjs <repo> <lane> --dry-run   # one lane = one worktree = one branch
node team/scripts/lane-worktree.mjs <repo> <lane>             # create it (idempotent reuse)
node team/scripts/lane-worktree.mjs <repo> <lane> --remove    # refuses a dirty tree; keeps the branch
```

CI (`.github/workflows/verify.yml`) runs exactly `docker/verify-in-container.sh`,
which is the single source of truth — a green local `docker/verify.sh` and a
green CI run mean the same thing.
**Scope of that parity:** it covers the installer, the skills pipeline and
`check-all.sh --segment fast` (the gate). It does **not** cover `team/scripts/tests/`
(those live in the gate's *slow* segment and are never invoked from CI), and the
container has no task-ops provider, so it could not run most of them anyway.
A green CI run is not evidence about that suite.

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
gate (`check-all`) and the detectors/janitors (`skills-update`, `sla-scan`,
`tmp-gc`) → `fire:true` (an unconfirmed evaluation must alarm, not read as
green — for `tmp-gc` that means an unreadable root or a failed delete, never
"it deleted a lot").

Jobs are registered declaratively by
[config/reconcile.mjs](config/reconcile.mjs) — declared jobs are the single source
of truth; each run aligns the runtime (missing ⇒ add, drifted ⇒ edit, matching ⇒
skip). Overrides for local testing: `OPENCLAW_TEAM_POLL_CMD`,
`OPENCLAW_TEAM_PATROL_CMD`, `OPENCLAW_TEAM_CHECKALL_CMD`,
`OPENCLAW_TEAM_TMPGC_CMD`, and `OPENCLAW_TEAM_TASK_PROVIDER=<name>`.

`tmp-gc` (daily 02:20 Asia/Shanghai) is the enforcement arm of the scratch-file
discipline `PROTOCOL §⑬.9`: every role keeps its temporary files in its own
`workspace-<role>/.tmp/`, and the job deletes anything older than 14 days there,
plus `~/.openclaw/tmp/` and `~/.openclaw/team/tmp/`. Roots come from a glob, so
the repo never carries a second copy of the role roster. It is **split in two**,
because walking the scratch tree costs the tree size (~320k files ≈ 10–12 s on the
reference host) and does not fit the 7.5 s entry bound: the entry only reads the
last sweep's failure flag and spawns the next sweep detached and returns (~40 ms);
the `--sweep` half does the work out of band and its verdict carries over to the
next evaluation. Audit with `node team/scripts/tmp-gc.mjs --sweep --days 14 --dry-run --json`.

### The gate — [team/scripts/check-all.sh](team/scripts/check-all.sh)

The single source of checks. It is **read-only**: no step may write `tasks/`
(archival runs `--dry-run` only). It prints a final-line envelope
`{"ok":true|false,"mode":…, ...}`, carrying `message` and `failed[]` on red.
It **runs with or without an installed instance** — see
[The gate: two modes](#the-gate-two-modes-no-host-required) for the `live` /
`repo` modes and the `--repo <R>` / `--live` switches.

It is **segmented** because the full run (~15–20 s) exceeds the scheduler's
trigger-evaluation budget (`OPENCLAW_TEAM_EVAL_TIMEOUT_MS`, default 8000 ms), and
a timeout envelope carries no verdict — a real red would be silently masked.

- `--segment fast` — seconds; runs in-band under
  `OPENCLAW_TEAM_CHECKALL_FAST_TIMEOUT_MS` (6000 ms; typical warm 2.4–3.7 s).
- `--segment slow` — `node --test` framework suite plus (live mode only) the
  provider ACL full suite (not in-band; would fast-timeout).
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
- **Path override:** `OPENCLAW_TEAM_ROOT` (default `~/.openclaw/team`), plus
  `OPENCLAW_HOME` (default `~/.openclaw`, used for `workspace-<role>/`) and
  `OPENCLAW_TEAM_MODE=live|repo`. [team/scripts/host-paths.mjs](team/scripts/host-paths.mjs)
  is the single resolver for the lint group (`check-redlines.mjs`,
  `lint-refs.mjs`, `lint-doc-refs.mjs`, `lint-impl-names.mjs`, `sync-redlines.mjs`); `lib.mjs` (and the
  provider's `team-paths.mjs` behind it), `check-all.sh` and `scan-deps.mjs`
  resolve the same roots themselves — deliberately not merged, see the module
  header. With `OPENCLAW_TEAM_ROOT=<sandbox>/team` the workspace root becomes
  `<sandbox>/` too, so a sandbox can never silently read the real `~/.openclaw`.
- **Lane isolation** — [team/scripts/lane-isolation.mjs](team/scripts/lane-isolation.mjs),
  [team/scripts/lane-worktree.mjs](team/scripts/lane-worktree.mjs),
  [team/scripts/spawn-lane.mjs](team/scripts/spawn-lane.mjs). Same repo + a
  concurrent lane ⇒ one git worktree per lane (automatic; `--no-isolate` opts
  out). Branch and base rules: [Branch and worktree discipline](#branch-and-worktree-discipline).
  Contract: [team/guides/worktree-isolation-sop.md](team/guides/worktree-isolation-sop.md),
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

## Branch and worktree discipline

Development **integrates on the long-lived branch `dev`**; `main` is the protected
release branch. Every task runs on its own lane branch `lane/<lane>` — one lane,
one branch, one worktree — and the lane's product merges into `dev` before the card
is closed. `dev → main` is the explicit integration/release step.

| Branch | Role |
|---|---|
| `main` | protected release branch; the only direct write is the `dev → main` step |
| `dev` | integration base — the default parent of every lane |
| `lane/<lane>` | one task / one segment; holds that lane's commits until it merges |

- **One lane = one worktree = one branch.** A same-repo concurrent lane is isolated
  automatically by [spawn-lane.mjs](team/scripts/spawn-lane.mjs) into a sibling
  tree `<repo>-wt-<lane>` (`--no-isolate` opts out). Never put two lanes in one
  worktree — that recreates the shared-checkout hazard *inside* the isolation.
- **No role develops on `main`.** It is never a development base (nor a lane's
  base): the only write to it is the explicit `dev → main` step. Linus, Jobs and
  Turing alike work on `lane/<lane>`.
- **The base is a snapshot, not whatever `HEAD` is now.** A first segment bases on
  `dev`; a continuation segment bases on **its previous segment's lane-branch
  tip** — an implicit `HEAD` silently drops the earlier segment's committed work.
  `--base <ref>` pins explicitly; `OPENCLAW_LANE_BASE` overrides process-wide. An
  unresolvable base is **refused** (`base_unresolved:<ref>`), never a silent
  fallback.
- **Never commit on the protected branch.** [branch-guard.mjs](team/scripts/branch-guard.mjs)
  refuses a direct commit on `main` (`OPENCLAW_PROTECTED_BRANCHES` overrides the
  set); `dev → main` is the one sanctioned exception and must pass
  `--allow-protected`, whose `overridden:true` is the trail. Note the mechanism:
  like `commit-guard.mjs`, the guard is **invoked by SOP, not wired as a git hook**
  (`.git/hooks/` is empty) — run it yourself; nothing blocks a bare `git commit`.
- **A lane's product merges into `dev` before the card is closed.** On a non-`dev`
  branch or in a worktree — i.e. every lane — the merge is a **precondition of the
  terminal `done`**, not a step after it: the lane owner merges `lane/<lane>` into
  `dev` and reports the merged sha, and Elon records it on the card before closing.
  An unmerged lane branch is **not** delivery — `dev` does not contain it, so the
  next task bases on a tree without it. Remove the worktree only **after** the
  merge.
- **The main checkout holds `dev`.** Integration happens on `dev`, so that is what
  the main checkout sits on — branch work still belongs in its own worktree, but
  the tree you are standing in *is* the integration tree. Consequently `main` has
  no long-lived checkout at all, and the `dev → main` step is done from a
  **throwaway worktree** (`git worktree add <tmp> main` → merge → remove) rather
  than by flipping the main checkout's branch, which would interrupt any work in
  progress on `dev`.
- **Bootstrapping:** a repo with no `dev` refuses lane isolation — create it once
  (`git branch dev <base>`) before the first isolated lane.

Normative source: [team/PROTOCOL.md](team/PROTOCOL.md) §⑥.4. Mechanics:
[worktree-isolation-sop.md](team/guides/worktree-isolation-sop.md) §5/§9,
[spawn-lane-sop.md](team/guides/spawn-lane-sop.md).

> **Migration state:** `PROTOCOL §⑥.4`, the `dev` base default and
> `branch-guard.mjs` land as one change. If your tree has no `dev` branch and no
> `branch-guard.mjs`, it predates that change — there lanes base on `HEAD` and the
> guard does not exist. Create `dev` before the first isolated lane.

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
  and a trailing card id, e.g. `fix(lib): 反膨胀守卫改口径… (T-20261015-025543-3)`.
  Work is tracked by cards; **the card id and the form a card is stored in belong
  to the task provider** (`guides/task-interface.md` + the ACL), not to this repo —
  under the current reference implementation a card is a markdown file whose name
  is its id, but nothing here may assume that shape.
