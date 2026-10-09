# scripts/ — framework entry scripts (shipped with the repository)

These are the provider **entry scripts** the framework dispatcher resolves for the
scheduled jobs (`team/automations/providers.json` → `{team}/scripts/…`):

| Entry | Job | Dispatch |
|---|---|---|
| `poll.mjs <agent>` | `poll-<agent>` | claim this agent's ready/stale cards |
| `patrol-scan.mjs` | `task-patrol` | scan for stale `in_progress` heartbeats |
| `check-all.sh` | `team-check-all` | aggregate gate patrol |

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
`skills/PROVENANCE.md`). Consequences:

- the entries can only **execute** in a deployed layout that also has the provider
  installed; without it they fail to import and the dispatcher degrades to
  `fire:false` (scheduling keeps working, nothing fires);
- `tests/sched-vendored-poll.test.mjs` therefore materialises a deployed layout and
  **skips** (with a reason) when no provider install is present. Point
  `OPENCLAW_TASK_OPS_DIR` at a provider checkout to run it.

See `team/AUTOMATIONS.md` §3.5 for the trigger-evaluation bounds and for what is
platform-level (the `already-running` run lock and stale-run release).
