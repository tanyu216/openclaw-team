# scripts/ — framework entry scripts (shipped with the repository)

These are the provider **entry scripts** the framework dispatcher resolves for the
scheduled jobs (`team/automations/providers.json` → `{team}/scripts/…`):

| Entry | Job | Dispatch |
|---|---|---|
| `poll.mjs <agent>` | `poll-<agent>` | claim this agent's new (`todo`/`ready` — `status.mjs#isNew`)/stale cards — **except `kind:deploy`** (deploy cards are never auto-claimed; explicit dispatch only, `PROTOCOL §1`) |
| `poll-run.mjs` | — (library) | single source for the poll RUN contract: `pollRunMessage()` (claim → hand off → return) + `pollRunTimeoutS()` (run bound); `install.sh` and `poll.mjs` both use it (T-20261013-041718) |
| `patrol.mjs` | `task-patrol` | stale-heartbeat scan + an in-process re-check of the candidates **before** emitting (a candidate whose card has since reached terminal is dropped, not fired); `patrol-scan.mjs` is the single-source decision module it imports |
| `sla-scan.mjs [--now ISO] [--recheck f] [--check-thresholds]` | `sla-scan` | board SLA inspection over the `PROTOCOL §15` rows the heartbeat patrol does not cover (+ the contract's `inspector_liveness`); notify-only to the leader, `fire` only on a tier crossing, fail-closed on an unconfirmed evaluation (`team/guides/sla-inspection-contract.md`, `team/AUTOMATIONS.md` §3.8) |
| `tmp-gc.mjs [--json]` (entry) / `tmp-gc.mjs --sweep [--days N] [--dry-run] [--json]` | `tmp-gc` | scratch GC (`PROTOCOL §13.9`): delete files older than 14 days under every `workspace-*/.tmp/` + `$OPENCLAW_HOME/tmp/` + `$OPENCLAW_HOME/team/tmp/`. **Split in two**: the entry only reads the last sweep's verdict and spawns the next sweep detached (~40 ms), because the walk costs the tree size (~320k files ≈ 10–12 s > the 7.5 s eval budget); the sweep does the work out of band and its verdict carries over. Roots from a glob (never a hard-coded role list), symlinks neither followed nor deleted, empty dirs pruned but roots kept, its own lock/flag never deleted; `fire` only when a sweep could not be confirmed (`team/AUTOMATIONS.md` §3.9) |
| `check-all-gate.mjs` | `team-check-all` | aggregate gate patrol, inside the evaluation budget |
| `check-all.sh [--segment fast\|slow\|all] [--repo <R>\|--live]` | (the gate's checks; also run by hand / CI) | aggregate gate patrol |

`check-all.sh` is the gate's **single source of checks**; `check-all-gate.mjs` is the
**scheduled entry** that fits it inside the trigger-evaluation bound: it runs the fast
segment in-band, folds in the cached slow-suite verdict, and refreshes that cache out of
band (`team/AUTOMATIONS.md` §3.5.1). `--segment all` (the default) is the full historical
run, unchanged.

It runs in **two modes** — `live` (an instance is resolvable: board checks, provider
suites, archive preview) and `repo` (**self-verification of the checkout**: syntax checks,
the three linters over the in-repo seeds, the framework suite; instance steps skipped
explicitly). `--repo <R>` / `--live` / `OPENCLAW_TEAM_MODE` override the autodetection, and
the envelope reports `"mode"`. `host-paths.mjs` is the shared resolver the lint group uses.

`install.sh` deploys this directory **recursively** into `{team}/scripts/`, so a
fresh install has no dangling entry path — the former "entry-path coupling" gap
(`team/automations/README.md` gap #2).

Not in the table above (they are **not** job entries — they are helpers a turn or an
entry arms): `spawn-lane.sh`/`spawn-lane.mjs`
start a lane, `lane-reaper.mjs` is the detached **session-terminal watchdog** that
`spawn-lane` arms for every lane, `session-lifecycle.mjs` holds the shared criterion +
two-sided close, and `session-reconcile.mjs` sweeps the historical card↔registry drift
(`team/guides/lane-session-lifecycle-sop.md`).

`status.mjs` is the **single source for the status vocabulary** (T-20261015-status): the
card axis (canonical 7 values of `PROTOCOL §16` + the `ready`/`failed` legacy aliases) and
the session/registry axis, plus the one documented bridge between them
(`sessionTerminalForCard`). Every checker and scanner imports its predicates
(`isTerminal` / `isNew` / `isInFlight` / `isDraft` / `isNonTerminal` / `isOpen`) rather
than re-declaring a set. It has **no imports of its own** — that is what lets it load in
any context (a checkout without the provider included); consistency with the provider's own
vocabulary is asserted by `tests/status.test.mjs`.

## Full index

Every top-level file in this directory, and what reaches it. Tags: **(job)** =
resolved by `team/automations/providers.json`; **(gate)** = a step of
`check-all.sh`; **(lib)** = imported by another file here; **(cli)** = run by hand
and documented under `team/guides/` or `CLAUDE.md`; **(data)** = deployed literal.

| File | What it is | Reached by |
|---|---|---|
| `check-all.sh` | the gate **engine** — the single source of the checks; `--segment fast\|slow\|all`, live/repo modes | **(gate)** CI (`docker/verify-in-container.sh`), `check-all-gate.mjs`, humans |
| `check-redlines.mjs` | each role `AGENTS.md` redline block byte-equals `guides/redlines.core.md` | **(gate)** |
| `sync-redlines.mjs` | the **writer** counterpart: pours the canonical block into each role file | **(cli)** `CLAUDE.md` |
| `lint-refs.mjs` | `PROTOCOL §1…§20` references resolve to `PROTOCOL.md` headings | **(gate)** |
| `lint-doc-refs.mjs` | path references in backticks / markdown links resolve, cross-file section anchors (`<name>.md §N` / `§N.M`) land on a real heading, **and** section-internal item refs (`§N clause M` / `§N step M` / `§N.M #M`) land inside a real ordered list | **(gate)** |
| `lint-impl-names.mjs` | implementation names must not leak into the upper docs | **(gate)** |
| `check-card.mjs` | card frontmatter schema + state machine | **(gate)** |
| `check-handoff.mjs` | the four `handoff.md` anchors | **(gate)**, `spawn-lane.mjs` |
| `check-relations.mjs` | relation invariants (parent / dependency DAG) | **(gate)** |
| `check-idem.mjs` | card-creation idempotency (the `idem` key) | **(gate)** |
| `check-sessions.mjs` | card ↔ registry session consistency | **(gate)** |
| `check-epic-completeness.mjs` | epic roadmap × card ledger + the dangling-roadmap sweep | **(gate)** |
| `check-report.mjs` | `## Report` common core (`A1…A8`) for `in_review` cards | **(gate)** |
| `check-merge.mjs` | every `.worktrees/` checkout whose card is `done` must be an ancestor of `dev` (`PROTOCOL §6.4`) | **(gate)** |
| `scan-deps.mjs` | dependency CVE scan (warn-only unless `SCAN_STRICT=1`) | **(gate)** |
| `archive.mjs` | archive terminal cards to `tasks/archive/YYYY-MM` (`--dry-run` inside the gate) | **(gate)** |
| `prototype-guard.sh` | a prototype dir must not contain real-implementation tokens | **(gate)**, only when `PROTOTYPE_DIR` is set |
| `check-all-gate.mjs` | scheduled entry of the gate: fast segment in-band + cached slow verdict + detached refresh | **(job)** `team-check-all` |
| `poll.mjs` | cron fallback poll: read-only scan + atomic claim | **(job)** `poll-<agent>` |
| `patrol.mjs` | patrol entry: stale-heartbeat scan (+ pre-emit re-check) | **(job)** `task-patrol` |
| `sla-scan.mjs` | board SLA inspection over the `PROTOCOL §15` rows + the threshold-drift check | **(job)** `sla-scan`; **(gate)** `--check-thresholds` |
| `tmp-gc.mjs` | scratch GC of `workspace-*/.tmp` + `$OPENCLAW_HOME/tmp` + `team/tmp` (entry reads the last verdict; `--sweep` does the work) | **(job)** `tmp-gc` |
| `spawn-lane.sh` / `spawn-lane.mjs` | the single mandatory lane entry (claim → handoff → spawn → `session-set`) | `PROTOCOL §6`; humans |
| `lane-reaper.mjs` | detached session-terminal watchdog, armed per lane | **(lib)** `spawn-lane.mjs` |
| `session-lifecycle.mjs` | shared session-terminal criterion + two-sided close | **(lib)** `poll.mjs`, `lane-reaper.mjs`, `session-reconcile.mjs` |
| `session-reconcile.mjs` | historical card↔registry drift sweep | **(cli)** `lane-session-lifecycle-sop.md` |
| `report-census.mjs` | read-only `## Report` census (parameterised, as-of echoed) | **(cli)** `worker-report-template.md` |
| `branch-guard.mjs` | refuse a direct commit on the protected branch | **(cli)** `CLAUDE.md`, `PROTOCOL §6.4` |
| `commit-guard.mjs` | the staged set must be only this card's files | **(cli)** `CLAUDE.md` |
| `samefile-guard.mjs` | same-file concurrency **warning** across non-terminal cards (the spawn-time refusal was removed with the isolation machinery — `PROTOCOL §6.3` case ②) | **(cli)** patrol; `guides/dev-worktree-flow-sop.md` |
| `seed-projects.mjs` | idempotently register project identity codes into the board | **(cli)** `task-interface.md`; **provider** |
| `taskd-pointer-doctor.mjs` | read-only taskd runtime-pointer health check | **(cli)** `team/README.md` |
| `lib.mjs` | shared library: frontmatter I/O, atomic claim, project registry | **(lib)** nearly everything; **provider** |
| `status.mjs` | the status vocabulary (card axis + session axis + the one bridge) | **(lib)** every checker/scanner |
| `card-ids.mjs` | structural board-card enumeration + id-shape recognition | **(lib)** `lib.mjs`, the checkers |
| `registry.mjs` | the sub-session registry + liveness | **(lib)** `poll.mjs`, `check-sessions.mjs`, `spawn-lane.mjs`; **provider** |
| `host-paths.mjs` | host/repo path resolver + the `live`/`repo` mode decision | **(lib)** the lint group |
| `board-adapter.mjs` | team-side projection of the board adapter (`taskctl` CLI, wire-drift gate) | **(lib)** `lib.mjs` |
| `poll-run.mjs` | the poll RUN contract (message + run bound) | **(lib)** `poll.mjs`; executed by `install.sh` |
| `patrol-scan.mjs` | stale-heartbeat scanner (single-source decision module) | **(lib)** `patrol.mjs`, `sla-scan.mjs`; **provider** |
| `claim-guard.mjs` / `claim.mjs` | unified claim guard (active-session + turn-lock) and its CLI | **(lib)** `claim.mjs`; **provider** — see below |
| `idem-baseline.json` / `report-baseline.json` | managed empty baseline / exemption templates | **(data)** deployed by `install.sh`; **provider** |

## Distribution contract

These files **are the source**: `install.sh` copies this directory, executable
bits included, into `{team}/scripts/` on the host. Edit them here and re-install —
never the other way round, and never hand-copy between a host and the repository.

`tests/` holds the framework tests written **for this repository**
(`node --test team/scripts/tests/*.test.mjs`). They ship alongside the scripts, which is
also what `check-all.sh` re-runs in a deployed install.

**Green, but read the skip count.** Suites that need the task-ops provider skip themselves
(they do not fail), and that is most of the suite:

| run | tests | pass | fail | skip |
|---|---|---|---|---|
| bare (no provider) | 781 | 199 | **0** | 582 |
| `OPENCLAW_TASK_OPS_DIR` set | 781 | 777 | **0** | 4 |

So "bare is green" means *0 failures over the 199 that ran*, not *the suite passed*. Point
`OPENCLAW_TASK_OPS_DIR` at a checkout containing `lib/` to run the rest — that is the mode a
deployed instance runs. **CI does not run this suite at all**: CI runs
`docker/verify-in-container.sh`, which runs only `check-all.sh --segment fast`; these tests
live in the **slow** segment.

## Codex plugin lane (`harness=plugin`)

`spawn-lane.mjs` dispatches the execution engine on `harness` (`cli` by default ⇒ the
`codex exec` child-process path, unchanged; `plugin` ⇒ the official `@openclaw/codex`
app-server embedded harness, **Codex backend only**). A plugin lane's handle is a
**native thread id**, so it registers in **two same-write steps** (`id:pending` →
`id:<thread_id>` on the same `seg:` row) and its liveness is **thread reachability**,
not a pid. `--dry-run` still writes nothing.

`registry.mjs` therefore keys entries by `task_id|owner|**seg**|session_id` (a legacy
entry without `seg` falls back to `phase`), exposes `isEntryAlive` / `threadReachable` /
`closePendingEntries`, and `check-sessions.mjs` reads the optional `harness:` row
segment (absent ⇒ `cli`). Mechanism contract and per-gate evidence commands:
`team/guides/codex-plugin-lane-contract.md`; entry usage and refusal codes:
`team/guides/spawn-lane-sop.md`.

## Runtime prerequisite: the provider's ACL library

`lib.mjs` imports the provider-owned ACL library from `{team}/skills/task-ops/lib/`
(installed by the task provider; **intentionally not vendored here** — see
`skills/PROVENANCE.md`). The dependency is **explicit (startup hard-fail, option ②)**:
at import time `lib.mjs` checks the library is present, and if it is missing it prints
a clear `provider 未安装：…` error and **exits non-zero** — it never silently no-ops
(the H1/main-guard silent-failure class is what this kills).

- the entries can only **execute** in a deployed layout that also has the provider
  installed; without it they **hard-fail** (clear error + non-zero exit), so the
  dispatcher degrades to `fire:false` but its `state.stderr` carries the missing-provider
  cause (no longer a cryptic `ERR_MODULE_NOT_FOUND`);
- `tests/sched-vendored-poll.test.mjs` therefore materialises a deployed layout and
  **skips** (with a reason) when no provider install is present. Point
  `OPENCLAW_TASK_OPS_DIR` at a provider checkout (a dir containing `lib/`) to run it,
  or symlink one at `{team}/skills/task-ops`.

### Reverse dependency: the provider imports back into this directory

The provider ACL is **not vendored here** (above) — but it imports *back* into this
directory by relative path. These edges are ordinary ES-module imports, so they are
runtime dependencies as hard as any other; they are also **invisible to a grep of
this repository**, because the importing files are not in it:

| Provider file | Imports from `scripts/` |
|---|---|
| `skills/task-ops/lib/task.mjs` | `lib.mjs`, `claim-guard.mjs`, `registry.mjs` |
| `skills/task-ops/lib/schedule.mjs` | `poll.mjs`, `patrol-scan.mjs`, `lib.mjs` |
| `skills/task-ops/lib/team-paths.mjs` | — (the reverse leg: `lib.mjs` imports *it*) |
| `skills/task-ops/tests/idem.test.mjs` | `lib.mjs`, `check-idem.mjs` |

Three consequences to carry into any tidying of this directory:

1. **`lib.mjs`, `claim-guard.mjs`, `registry.mjs`, `poll.mjs`, `patrol-scan.mjs`,
   `check-idem.mjs` and `seed-projects.mjs` must not be deleted or renamed**
   without a coordinated provider release. The failure mode is a live ACL that
   cannot load — and it would not be caught by anything in this repository.
2. **The flat layout is pinned.** A provider import reads
   `../../../scripts/<file>.mjs`, so **this directory cannot be reorganised into
   subdirectories**, however tempting the file count makes it look.
3. `claim-guard.mjs` is the sharp case: from inside this repository it looks dead
   (only `claim.mjs` and its own test name it — every other path claims through
   the ACL). It is not — `lib/task.mjs` imports `claimGuarded` from it.

See `team/AUTOMATIONS.md` §3.5 for the trigger-evaluation bounds and for what is
platform-level (the `already-running` run lock and stale-run release).
