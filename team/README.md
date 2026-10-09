<!-- NOTE: this file is a v0 document derived from a reference instance. Task management is provider-agnostic (ACL); `task-panel` is the reference provider and is optional. -->

# OpenClaw Five-Agent Team — Handover Document (README)

> Architecture / protocol / operations / recovery / cost observation / known pitfalls / rejected-option decisions.
> This directory `~/.openclaw/team/` is the only cross-agent shared area; the protocol source of truth is `PROTOCOL.md`.
> Last updated: 2026-10-09 (lifecycle & engineering-gate clauses landed: PROTOCOL ①–㉘ incl. §⑤.1 public release approval, §⑥.3 worker parallelism + throughput patrol, and §㉑–§㉘ release/observability/incident/migration/API-compat/CVE/perf/cross-cutting, with the matching SOPs in `guides/`; architecture/protocol/operations/recovery below)

## 1. Architecture

```
[Human operator]──(human channel/TUI bindings)──► Elon (agent:main:main, CEO/coordinator/sole card creator/sole human-facing)
                                                  │  sessions_send (immediate dispatch) / sessions_spawn (parallel subtasks)
                     ┌────────────────────────────┼─────────────────────┬────────────────────┐
                     ▼                            ▼                     ▼                    ▼
                  Jobs                        Linus                 Turing               Assistant
              product design/UX gate       code development      testing/acceptance    chores/marketing/ops/support
        (orchestrates claude subsessions, (orchestrates ≤8 claude  (orchestrates ≤3 codex
         personally reviews and certifies   subsessions, reconcile   subsessions)
         interactions)                      registry first)
                     └──────────── one cron per worker (every 1m + trigger) as fallback ────────────┘
                     poll read-only scan + atomic claim → fire:true wakes execution
```

**Source-of-truth split**:
- Task **content** (Goal/Acceptance/Background/Report) → task cards (managed by the task provider; reference implementation `task-panel`, swappable via ACL)
- Task **dispatch/status/communication** → OpenClaw native (sessions_send/spawn, background tasks, automations)
- Project metadata (paths/git boundaries/rules) → project **identity codes resolved via the `task-interface` ACL** (the backend — currently task-panel — is swappable)
- Session registry (claude/codex subprocesses) → `claude-sessions.json` / `turing-runs.json`

## 2. Directory Overview

| Path | Contents |
|---|---|
| `PROTOCOL.md` | The single protocol source of truth (①–㉘: board/project access/structure invariants/reporting/messages/session orchestration/ambiguity/registration/defect loop/triage/out-of-bounds/doc sync/universal hard discipline/confirmation gate/SLA/terminology/layering/research convention/work creed/gates and archiving/release and versioning/runtime observability/product incident response/data migration/API compatibility/dependency CVE gate/performance SLA/cross-cutting + Appendix A) |
| Project registration (ACL) | Project **identity code ↔ backend entity**; the current backend is task-panel's `projects` table (swappable). A legacy `projects.json`, if present, is a transitional runtime file **pending migration** — it is **not** the project registry. |
| `tasks/` + `archive/` | Task cards and terminal-state archive (board content, managed by `task-panel`) |
| `workspace/<task-id>/` | Task working directory + artifacts (a `review/` subdirectory holds issue lists and evidence) |
| `AUTOMATIONS.md` | Scheduled jobs/patrol list (cron overview, cost model, decisions) |
| `ROLES.md` | Role duties/boundaries/handoffs reconciliation table (anti-GAP) |
| `guides/` | Stable reference docs (task-interface contract, redlines canonical, UI alignment SOP, UI assertion spec, etc.) |
| `claude-sessions.json` | Registry of claude subsessions orchestrated by Jobs/Linus (maintained at runtime) |
| `turing-runs.json` | Registry of Turing codex runs (maintained at runtime) |

Workspaces: `workspace-elon` (main) and `workspace-{jobs,linus,turing,assistant}`; role skills live in their respective `workspace-*/skills/`, global skills in `~/.openclaw/skills/`.

## 3. Operations Commands

```bash
OCL="$OPENCLAW_HOME/bin/openclaw"   # OpenClaw CLI (adjust the path to the local install)
# Status
$OCL gateway status | $OCL agents list --bindings | $OCL automations list | $OCL tasks list
$OCL automations runs <jobId> --limit 20      # inspect poll spin/claim history
$OCL sessions list --all-agents --json        # session overview
# Board (task-panel provides the task skill + taskctl CLI)
taskctl list                                  # board overview
taskctl show <card>                           # a single card (including Report)
taskctl poll <agent>                          # manually run one trigger evaluation (claim drill/troubleshooting)
# Restart (maintenance window: back up config first; after restart the operator sends a message to verify the human channel)
$OCL gateway restart
# Disable a worker's fallback
$OCL automations disable <jobId>    # restore: automations enable <jobId>
```

## 4. Recovery Handbook

| Scenario | Action |
|---|---|
| Worker stuck (heartbeat >30min) | The same assignee re-claims and takes over on the next poll; after >6h any agent may claim and report to Elon |
| Double-run risk | Atomic claim prevents double-claiming; `in_progress`+fresh heartbeat = execution uniqueness (a new turn only reports, does not re-execute); only stale takes over |
| Gateway restart loses dispatch | Cards persist in tasks/; each worker's cron sweeps todo/stale cards every minute as a fallback re-dispatch |
| Config broken | `cp ~/.openclaw/openclaw.json.pre-*` (chained backups); platform `.last-good`/`.bak` rotation; `doctor --fix` can recover |
| main workspace accident | Back up `~/.openclaw/workspace.bak-persona-*` (pre-migration snapshot) |
| Human channel route broken | Check `agents list --bindings` bindings; restore the pre-team config + restart |

## 5. Cost Observation Guide

- The 5 poll crons evaluate every minute but **fire:false costs nothing** (no run produced, no model consumed); a turn is triggered only when a card is claimed.
- Model strategy: **all agents (Elon/Jobs/Linus/Turing/Assistant) have `deepseek-flash` as the unified default tier**, with both primary and fallback set to it; `deepseek-v4-pro` is no longer any agent's default and is instead upgraded temporarily by task complexity; visual tasks use `deepseek-flash` (details in PROTOCOL ⑥.2).
- Orchestrated subsessions (claude/codex) are the main cost source: watch `claude-sessions.json` concurrency and orphan reclamation (reconcile discipline).
- Observation: `$OCL automations runs` counts only fired runs; spins are not counted — cost is directly tied to run count.

## 6. Known-Pitfall Archive (measured)

1. **A wrong model contextWindow declaration once took down all pro runs**: the deepseek entry once said `contextWindow: 64000` (actual 1M); the gateway managed context/output budget by it → v4-pro long sessions with deep reasoning hit `max_tokens` (`stopReason=length`, `payloads=0`) → "Agent couldn't generate a response". **Fix: `contextWindow: 1048576` + `maxTokens: 32768`**. When you see this error in future, check the model declaration before suspecting the model/network.
2. **agents add overwrites the IDENTITY.md Name line** to the lowercase agent id → after add, restore `- **Name:** <Capitalized role name>` (compare against the backup snapshot).
3. **Automations `--trigger-script` is an inline JS condition script** (parsed and executed by the gateway, 30s budget/≤5 tool calls), not shell; it cannot carry a shebang/top-level import. Approach: the trigger script is a thin adapter that calls `taskctl poll <agent>` with the identity passed explicitly (1 tool call), leaving the action to the run turn.
4. **The openclaw skill system and the claude CLI skill system are two different systems**: claude subsessions spawned by Jobs/Linus load `~/.claude/skills` + the task directory's `.claude/skills`; openclaw's `~/.openclaw/skills` (and workspace skills) are not loaded by claude subsessions — before spawn, copy the needed skills into the task directory's `.claude/skills/` per role.
5. **MCP integration of design tools needs project-scoped config**: some design/third-party MCP tools are mounted under a specific cwd's project scope and are invisible when cwd is outside home; account login is a one-off manual step (until done, design degrades to document-type output).
6. **The material-repo root may be a git repo with auto-commit**: repo files are tracked by the parent repo (natural traceability); the repo itself may have no independent git, so this kind of material-organization role needs no git operations.
7. **The old sqlite `workspace_path_aliases` path rows are historical cache and lazily harmless**: the main row still points to the old `workspace` path string (written by Dreaming at 03:00); at runtime the config pin (workspace-elon) prevails, so no manual DB edit is needed.
8. **Trigger-script evaluation phase and run turn are separate**: the claim happens during poll evaluation (fire:true ⇔ already claimed); the run turn finds `claimed_by=self`+fresh heartbeat → skip claiming and execute directly, and only runs `taskctl claim` if the card is still todo.
9. **heartbeat exists only for main** (30m, defaults config); workers have no heartbeat and run idle; Dreaming (03:00) ingests only the main session.
10. **Deep-troubleshooting experience**: gateway logs `/tmp/openclaw/openclaw-*.log` (JSON lines); model requests/fallbacks/reasoning overflow all have subsystem markers (`model-fallback/decision`, `agent/embedded` reasoning-only, etc.); grep runId first.
11. **Task management is installed only on the OpenClaw team side**: task management (board/cards/ACL) is provided by the external `task-panel` and **faces OpenClaw team agents only** (`PROTOCOL §⑥` clause 7); **Claude Code / codex subsessions do not install or reference task management**, and the needed card info and constraints are transcribed by the agent into its prompt/`CLAUDE.md`.

## 7. Rejected-Option Decision Record

- **Swarm** (one-shot fan-out, no queue/cross-turn state) → not introduced in v1. The two dispatch paths (sessions_send direct dispatch / sessions_spawn parallel) + cron fallback already cover the need.
- **managed TaskFlow** (requires a self-built plugin controller to drive) → do not build a bespoke message/scheduling system; task persistence uses a minimal patch (task cards + atomic claim), everything else goes native.
- **ACP** (external harness channel, not built into the agent team) → not introduced.
- **Do not put anyone on the claude-cli runtime**: the claude CLI is a backend depending on the local login state; Jobs/Linus = coordinator + exec-driven claude subprocess, unchanged.
- **Single "board scan" dispatch (merging per-worker poll) → not adopted**: per-worker `*-poll` (every 1m + trigger, zero-cost when idle) is an **independent fallback** — each worker atomically claims when woken, so cards already created can still be claimed even when Elon (main) is stalled. Merging into "main scans → dispatch" would converge the wake chain to a single Elon point and change the `PROTOCOL §①` "claim timing belongs to poll" semantics. The only gain is a few zero-cost config lines, **so the status quo is kept**.

## 8. Phase Status

- ✅ Phase 0 (smoke) / Phase 1 (skeleton + 14 unit tests) / Phase 2 (registration config + maintenance window + model config fix + human channel routing validation/A2A/spawn)
- ⏳ Phase 3 end-to-end drill: **the operator sends a requirement to Elon via the human channel** to start a real task chain (Jobs designs a small task including ux-review iterations → Linus 3 concurrent subtasks → Turing's known-bad-function failed path → failure drill automations disable). The first task also empirically tests isolated-turn subprocess survivability (settling the main spawn mode) and claude-sessions.json card registration.
- ⏳ Phase 4: this README to be filled in after the drill: actual issue-list template output, registry samples, measured costs.

**Full implementation plan**: see the team-internal plan document (containing the task-card schema and the clause sources for each role's Standing Orders).
