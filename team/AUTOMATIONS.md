# AUTOMATIONS.md — Scheduled Jobs / Patrol List

> Overview and decision record of all scheduled jobs (cron / every / trigger) on the team Gateway. Maintainer: Elon.
> Last updated: 2026-10-08. View live: `automations list` (or Control UI → Automations).
> Related: `PROTOCOL §⑳` (gates and archiving), `§⑥.4` (poll to terminal state), `README §3` (operations commands).

## 1. Job Overview (currently 15)

| Name | Agent | Frequency | Trigger | Delivery | Purpose |
|---|---|---|---|---|---|
| `jobs-poll` | jobs | every 1m | ✅ | none | Board poll fallback: atomically claim jobs's todo/stale cards |
| `linus-poll` | linus | every 1m | ✅ | none | Same (linus) |
| `turing-poll` | turing | every 1m | ✅ | none | Same (turing) |
| `assistant-poll` | assistant | every 1m | ✅ | none | Same (assistant) |
| `task-patrol` | main | every 5m | ✅ | none | in_progress cards with stale heartbeat (>30min) → wake/recover |
| `team-check-all` | main | **hourly** | ✅ | none | Gate patrol; wakes the model only on failure |
| `heartbeat-main` | main | every 30m | — | none | Main-session heartbeat |
| `memory-dreaming-promotion` | main | 03:00 (Asia/Shanghai) | — | none | memory-core short-term memory promotion (managed) |
| `token-hygiene` | main | 04:00 (Asia/Shanghai) | — | none | Large-log compaction/memory indexing |
| `session-rollover` | main | 06:00 (Asia/Shanghai) | — | none | Main-session rollover |
| `skill-collection-review-{main,jobs,linus,turing,assistant}` | respective | every 7d (staggered) | — | none | Skill collection patrol |

## 2. Cost Model (important)
- **An idle trigger job = zero cost**: `fire:false` only writes state, produces no run, and consumes no model. So all poll / task-patrol / team-check-all jobs are **near zero cost when there is no anomaly**.
- Only **`fire:true` wakes a model turn** (poll = a card was claimed; task-patrol = a stale card exists; check-all = the gate failed).
- Non-trigger jobs (heartbeat/maintenance/skill) produce runs at a fixed frequency.

## 3. Trigger Script Locations
| Job | Script |
|---|---|
| `*-poll` | Trigger adapter → calls the task-panel task interface for evaluation (`taskctl poll <agent>`) |
| `task-patrol` | Trigger adapter → stale-card scan |
| `team-check-all` | Trigger adapter → gate patrol |

## 4. Decision Record
- **Keep per-worker poll; do not do a "single board scan → dispatch"**: per-worker `*-poll` is an **independent fallback** (each worker atomically claims, so cards already created can still be claimed when Elon/main is stalled). Merging into "main scans → dispatch" would converge to a single Elon point and change the `PROTOCOL §①` "claim timing belongs to poll" semantics; the only gain is a few zero-cost config lines ⇒ not adopted.
- **Patrol frequency**: the gate patrol `team-check-all` is set to **hourly**; because it triggers the model only on failure, a higher frequency adds no cost.

## 5. Management
- View: `automations list` | Details: `automations get <jobId>` | History: `automations runs <jobId>`
- Test run: `automations run <jobId> runMode=force`
- Add/remove/modify: prefer the `automations` tool; **but that tool is read-only in agent/cron turns** (only status/list/get/remove/runs/next_check, no add/update/run) ⇒ to actually change scheduling, use the official CLI: `openclaw automations edit <jobId> --trigger-script <file>` (Gateway WS managed path, not a manual DB edit). Hand-editing sqlite/store is forbidden.
- Constraint: `declarationKey` is **add-only** (fixed at creation, cannot be updated afterwards); changing a key requires remove + re-add.
- Permissions: in a chat turn, `add`-ing a job for **another agent** is rejected by scope (`agentId outside caller scope`); workaround = create first, then `update agentId` (or have the owner create it in the Control UI).

## 6. Patrol Metrics (attached to check-all)
- **Trigger-script placeholder incident fix (historical)**: the trigger inline JS **does not do brace template substitution**, so a placeholder literal passed to shell fails (`bash: {{HOME}}/...: No such file or directory`) ⇒ the gate patrol falsely reports failure and burns a model turn (poll-type jobs silently fail instead). **Fix**: switch trigger scripts to **absolute paths** and write back each job via `openclaw automations edit <id> --trigger-script <file>`; verify `automations list` has no placeholders and the gate is all green ⇒ trigger evaluation is `fire:false`. **Convention**: trigger script paths are always absolute; placeholders are forbidden.
- Redline-block drift = 0 | terminology-abstraction violations = 0 | §reference broken links = 0 | card-schema violations = 0 | contract tests all green.
- **New-seg background-pack rate**: the gate verifies that "all running/closed segs in the card have `workspace/<task-id>/handoff.md` containing the four anchors" — target 100%; gaps are handled (generated/carded).
