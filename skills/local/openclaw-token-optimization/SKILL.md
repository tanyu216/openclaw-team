---
name: openclaw-token-optimization
description: Cut OpenClaw token/cost burn end-to-end — measure where the tokens go (raw transcripts, cacheRead), lower the effective context window (per-model contextTokens + top-level compaction/contextPruning/contextLimits), and slim scheduled jobs (--light-context, poll cadence, script payloads). Use for token/cost questions, cacheRead dominance, compaction thresholds, context growth, or poll/cron burn.
---

# OpenClaw token optimization

Reduce OpenClaw token/cost burn. Burn is dominated by re-sent prompt context (`cacheRead`, often ≥95%), so the target is **context size × turn count** — not shorter replies. Work in this order: measure → lower the window → slim the scheduled jobs.

## 1. Measure where the tokens go

Confirm `cacheRead` dominates and find the prompt-size buckets before changing anything.

Try the built-in surfaces first:
- `openclaw status --usage` — provider quota plus per-session token/context.
- `openclaw gateway usage-cost --all-agents --days N --json` — per-day totals from session logs.

If those give real numbers, use them and stop. **If they return zeros with `cacheStatus.status = "refreshing"` (nonzero `pendingFiles`/`staleFiles`), the aggregate cache is not ready — do not wait; read the raw transcripts.**

Raw stores:
- Live transcripts: `~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite`, table `transcript_events` (`session_id`, `event_json`, `event_zstd`, `created_at`).
- Deleted/reset sessions: `~/.openclaw/agents/<agent>/sessions/*.zst` (session id = filename prefix).

Access rules (non-obvious pitfalls):
- An external `sqlite3` is **blocked** under the state dir ("external sqlite3 cannot open databases under the active OpenClaw state directory"). Use Node built-in `node:sqlite` `DatabaseSync(path, { readOnly: true })` (preferred; handles BLOB columns on Node 24), or copy the DB to a temp dir then `sqlite3 "file:<copy>?immutable=1"`.
- **`transcript_events` stores many rows only in `event_zstd` with `event_json NULL`** (~half in practice). A `where event_json like '%usage%'` filter silently drops them.
- Decompress `event_zstd` with Node built-in zstd: `zlib.zstdDecompressSync(buf)`. The `zstd` CLI is often not installed.

Extract/aggregate:
- Keep events where `type === "message"`, `message.role === "assistant"`, with a `message.usage` object.
- `usage`: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` (= input + output + cacheRead), `cost.total`.
- Bucket by **local calendar day** and state the timezone (default Asia/Shanghai, UTC+8); totals shift a lot across the day boundary.
- Dedupe by message id (`event.id`) per agent; a session can appear both live and archived.
- Report by agent, model, session, token type.

Interpret:
- Expect **`cacheRead` to dominate (often ≥95%)** — re-read prompt context, not new output. A day's burn is driven by *context size × turn count*.
- Check prompt size per turn (`input + cacheRead`): the top buckets (500k–1M) usually hold most of the volume.
- Recorded `cost.total` may price `cacheRead` at 0 (a model's `cost` block can omit `cacheRead`, which then counts as 0). Set `models.providers.<provider>.models[].cost.cacheRead` to the provider rate; cross-check the provider dashboard (e.g. DeepSeek) — a local reconstruction can differ by tens of percent.

Ready-to-run: `scripts/usage-report.mjs` implements the raw-store steps (copies each agent DB to a temp dir; parses `event_json`, `event_zstd`, and `*.zst`; prints per-day totals, per-agent breakdown, top sessions, and the prompt-size distribution).

```
node scripts/usage-report.mjs 2026-10-09        # Asia/Shanghai (default)
TZOFF=0 node scripts/usage-report.mjs 2026-10-09 # UTC
```

## 2. Lower the effective context window

The lever is per-model **`contextTokens`**, not `compaction.enabled`. `compaction.enabled: true` alone does **not** move the trigger point: the built-in compaction reserve is fixed (~20k, capped at 1/4 of the window), so with a 1M `contextWindow` and no `contextTokens` the first compaction fires only near ~980k — sessions grow huge and every turn re-sends the whole context. Keep `contextWindow` as the true model limit; `contextTokens` is the working budget (e.g. `contextTokens: 200000` ⇒ compaction ≈180k). A model without `contextTokens` never gets the smaller window.

Config knobs — top-level `agents.defaults` (**NOT** under `models.providers.*`):
- `compaction`: `{ "enabled": true, "keepRecentTokens": 20000, "maxActiveTranscriptBytes": "20mb", "midTurnPrecheck": { "enabled": true } }`
- `contextPruning`: `{ "mode": "cache-ttl", "ttl": "10m", "hardClear": { "enabled": true } }`
- `contextLimits`: `{ "postCompactionMaxChars": 8000 }`

Do **not** also add `session.reset` when a session-rollover cron already handles the daily reset — they double up.

Apply safely — a misplaced key kills the whole config:
- Any unrecognized or misplaced key **invalidates the entire config**, and an invalid config makes the Gateway **silently skip hot reload**: the running process keeps the old settings and only a `warn ... config reload skipped (invalid config)` log line appears. Easy mistake: nesting a block under the wrong parent (e.g. an `agents` block under `models.providers.deepseek` → `Unrecognized key: "agents"`, whole file rejected).
- Procedure: back up `~/.openclaw/openclaw.json` → edit (preserve/merge, never whole-file replace) → `openclaw config validate` (must print `Config valid`) → confirm `openclaw logs` shows `config hot reload applied (...)` and `source revision N accepted (file)`. No `applied` line ⇒ it did not take effect. Only restart the Gateway if hot reload truly fails.
- `openclaw config get <path>` returns the **effective, schema-normalized** values (defaults filled in) — verify what actually took effect, not just what you wrote (e.g. `agents.defaults.compaction` reports `mode: "safeguard"`).

## 3. Slim scheduled jobs

Isolated agent jobs re-inject the workspace bootstrap context on **every** run; at a 1-minute `--every` cadence across several agents, that idle bootstrap can dwarf the useful work. Fix the scheduled jobs, not the model.

Levers (highest value first):
1. **Lightweight bootstrap** — add `--light-context` so each run uses the light bootstrap instead of the full one. New: `openclaw automations add ... --light-context`. Existing: `openclaw automations edit <jobId> --light-context` (undo with `--no-light-context`).
2. **Cadence** — a 1m poll usually evaluates its trigger and does nothing. Widen `--every 1m` to 2–3m, or consolidate several poll jobs into one dispatcher.
3. **Script payload** — deterministic work belongs in a `--command`/`--script` job (0 agent tokens), not an `agentTurn`.

Declared jobs — a runtime edit is not the declaration source:
- Automations created by an installer carry a `--declaration-key` (e.g. `openclaw-team:poll:linus`), shown in the `Declaration` column. The installer registers idempotently (a job whose key already exists is **skipped**), so a runtime `edit` is not undone by re-running the installer, but a **fresh** install on another machine creates the job **without** your flag.
- To make a change stick for future installs/upgrades, change the **declaration source** (the installer's `openclaw automations add` call) and add an idempotent backfill that detects existing jobs and `edit`s them. Installer edits are code — route them to the code owner instead of editing only the runtime.

Verify what actually took effect: `openclaw automations list --json` (or `get <jobId>`) — an agent job with light context reports `payload.lightContext: true`; the list also shows each job's `Declaration`, `agentId`, and `schedule`.

## Completion check
Numbers move (`cacheRead` and the top prompt buckets drop; compaction fires ~180k, not ~980k); `openclaw config validate` passes and the reload log shows `applied`; `openclaw automations list --json` shows `payload.lightContext: true` on the intended jobs and the new cadence.

## Pitfalls
- A misplaced or unrecognized config key invalidates the **whole** file, and the Gateway silently skips hot reload — only a `config reload skipped (invalid config)` log line appears.
- A runtime automation edit is not the declaration source: a fresh install recreates the job without the flag.
- `openclaw config get <path>` returns effective, schema-normalized values — verify what actually took effect, not what you typed.
