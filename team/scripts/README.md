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
