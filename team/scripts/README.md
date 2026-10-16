# scripts/ — framework entry scripts (shipped with the repository)

These are the provider **entry scripts** the framework dispatcher resolves for the
scheduled jobs (`team/automations/providers.json` → `{team}/scripts/…`):

| Entry | Job | Dispatch |
|---|---|---|
| `poll.mjs <agent>` | `poll-<agent>` | claim this agent's new (`todo`/`ready` — `status.mjs#isNew`)/stale cards — **except `kind:deploy`** (deploy cards are never auto-claimed; explicit dispatch only, `PROTOCOL §①`) |
| `poll-run.mjs` | — (library) | single source for the poll RUN contract: `pollRunMessage()` (claim → hand off → return) + `pollRunTimeoutS()` (run bound); `install.sh` and `poll.mjs` both use it (T-20261013-041718) |
| `patrol-scan.mjs` | `task-patrol` | scan for stale `in_progress` heartbeats |
| `sla-scan.mjs [--now ISO] [--recheck f] [--check-thresholds]` | `sla-scan` | board SLA inspection over the `PROTOCOL §⑮` rows the heartbeat patrol does not cover (+ the contract's `inspector_liveness`); notify-only to the leader, `fire` only on a tier crossing, fail-closed on an unconfirmed evaluation (`team/guides/sla-inspection-contract.md`, `team/AUTOMATIONS.md` §3.8) |
| `tmp-gc.mjs [--json]` (entry) / `tmp-gc.mjs --sweep [--days N] [--dry-run] [--json]` | `tmp-gc` | scratch GC (`PROTOCOL §⑬.9`): delete files older than 14 days under every `workspace-*/.tmp/` + `$OPENCLAW_HOME/tmp/` + `$OPENCLAW_HOME/team/tmp/`. **Split in two**: the entry only reads the last sweep's verdict and spawns the next sweep detached (~40 ms), because the walk costs the tree size (~320k files ≈ 10–12 s > the 7.5 s eval budget); the sweep does the work out of band and its verdict carries over. Roots from a glob (never a hard-coded role list), symlinks neither followed nor deleted, empty dirs pruned but roots kept, its own lock/flag never deleted; `fire` only when a sweep could not be confirmed (`team/AUTOMATIONS.md` §3.9) |
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
entry arms): `spawn-lane.sh`/`spawn-lane.mjs` (+ `lane-isolation.mjs`, `lane-worktree.mjs`)
start a lane, `lane-reaper.mjs` is the detached **session-terminal watchdog** that
`spawn-lane` arms for every lane, `session-lifecycle.mjs` holds the shared criterion +
two-sided close, and `session-reconcile.mjs` sweeps the historical card↔registry drift
(`team/guides/lane-session-lifecycle-sop.md`).

`status.mjs` is the **single source for the status vocabulary** (T-20261015-status): the
card axis (canonical 7 values of `PROTOCOL §⑯` + the `ready`/`failed` legacy aliases) and
the session/registry axis, plus the one documented bridge between them
(`sessionTerminalForCard`). Every checker and scanner imports its predicates
(`isTerminal` / `isNew` / `isInFlight` / `isDraft` / `isNonTerminal` / `isOpen`) rather
than re-declaring a set. It has **no imports of its own** — that is what lets it load in
any context (a checkout without the provider included); consistency with the provider's own
vocabulary is asserted by `tests/status.test.mjs`.

## Distribution contract

These files **are the source**: `install.sh` copies this directory, executable
bits included, into `{team}/scripts/` on the host. Edit them here and re-install —
never the other way round, and never hand-copy between a host and the repository.

`tests/` holds the framework tests written **for this repository**
(`node --test team/scripts/tests/*.test.mjs`; green bare — suites that need the
task-ops provider skip themselves). They ship alongside the scripts, which is also
what `check-all.sh` re-runs in a deployed install.

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

See `team/AUTOMATIONS.md` §3.5 for the trigger-evaluation bounds and for what is
platform-level (the `already-running` run lock and stale-run release).
