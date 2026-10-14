# scripts/ — framework entry scripts (shipped with the repository)

These are the provider **entry scripts** the framework dispatcher resolves for the
scheduled jobs (`team/automations/providers.json` → `{team}/scripts/…`):

| Entry | Job | Dispatch |
|---|---|---|
| `poll.mjs <agent>` | `poll-<agent>` | claim this agent's new (`todo`/`ready` — `lib.mjs#isNewStatus`)/stale cards — **except `kind:deploy`** (deploy cards are never auto-claimed; explicit dispatch only, `PROTOCOL §①`) |
| `poll-run.mjs` | — (library) | single source for the poll RUN contract: `pollRunMessage()` (claim → hand off → return) + `pollRunTimeoutS()` (run bound); `install.sh` and `poll.mjs` both use it (T-20261013-041718) |
| `patrol-scan.mjs` | `task-patrol` | scan for stale `in_progress` heartbeats |
| `sla-scan.mjs [--now ISO] [--recheck f] [--check-thresholds]` | `sla-scan` | board SLA inspection over the `PROTOCOL §⑮` rows the heartbeat patrol does not cover (+ the contract's `inspector_liveness`); notify-only to the leader, `fire` only on a tier crossing, fail-closed on an unconfirmed evaluation (`team/guides/sla-inspection-contract.md`, `team/AUTOMATIONS.md` §3.8) |
| `check-all-gate.mjs` | `team-check-all` | aggregate gate patrol, inside the evaluation budget |
| `check-all.sh [--segment fast\|slow\|all]` | (the gate's checks; also run by hand / CI) | aggregate gate patrol |

`check-all.sh` is the gate's **single source of checks**; `check-all-gate.mjs` is the
**scheduled entry** that fits it inside the trigger-evaluation bound: it runs the fast
segment in-band, folds in the cached slow-suite verdict, and refreshes that cache out of
band (`team/AUTOMATIONS.md` §3.5.1). `--segment all` (the default) is the full historical
run, unchanged.

`install.sh` deploys this directory **recursively** into `{team}/scripts/`, so a
fresh install has no dangling entry path — the former "entry-path coupling" gap
(`team/automations/README.md` gap #2).

## Vendoring contract

These files are **byte-identical copies of the deployed runtime**
(`~/.openclaw/team/scripts/**`, including the executable bit); the repository is
their distribution channel. They carry no local edits — if a runtime fix is needed,
fix it in the runtime and re-copy the whole flat set, so the two never diverge.

`tests/` is the exception: it holds the framework tests written **for this
repository** (`node --test team/scripts/tests/*.test.mjs`, green with no
prerequisites). They are deployed alongside the scripts, which is also what
`check-all.sh` re-runs in a deployed install.

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
