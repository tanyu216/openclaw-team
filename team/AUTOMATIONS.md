# AUTOMATIONS.md — Scheduled Jobs / Patrol List

> Overview and decision record of all scheduled jobs (cron / every / trigger) on the team Gateway. Maintainer: Elon.
> Last updated: 2026-10-14 (added `sla-scan`, T-20261014-022254-3; + the contract-v1.1 conformance fixes F1/F5/F8, T-20261014-084606). View live: `automations list` (or Control UI → Automations).
> Related: `PROTOCOL §⑳` (gates and archiving), `§⑥.4` (poll to terminal state), `README §3` (operations commands), `guides/task-interface.md` (task-provider ACL).

## 0. Boundary — framework owns scheduling; provider is only a callee (ACL)

- **Scheduling belongs to the FRAMEWORK** (`openclaw-team`), **not** to the task
  provider. The framework registers the team-level jobs and evaluates each trigger
  through its own dispatcher (`automations/dispatch.mjs`).
- **The provider is only a *callee*** behind the `task-interface` ACL
  (`guides/task-interface.md`). **`meerkat-taskpanel` is the DEFAULT provider** (installed
  by default; opt out with `./install.sh --no-meerkat-taskpanel`) and **is replaceable**
  (Jira / Plane / Linear / …) with **zero change to these jobs** — swap the provider
  via `OPENCLAW_TEAM_TASK_PROVIDER` and the entry commands in
  `automations/providers.json` (or `OPENCLAW_TEAM_POLL_CMD` /
  `OPENCLAW_TEAM_PATROL_CMD` / `OPENCLAW_TEAM_CHECKALL_CMD`).
- **Install behaviour matches this document**: `./install.sh` registers the jobs
  below; `--skip-automations` disables registration. Re-running is idempotent
  (`declarationKey`).

## 1. Job Overview (repo declares 19: 8 by `install.sh` — 4 × `*-poll` + `task-patrol` + `team-check-all` + `skills-update` + `sla-scan`; the other 11 registered by their own mechanisms)

> **Cadence / scope caveat.** The `Frequency` column documents the **framework-declared (repo) defaults**: `*-poll` = `every 5m` and `task-patrol` = `every 15m` (`install.sh:126` / `:698` / `:718`). The **live Gateway store is not yet re-deployed** and still runs the *old* cadence (`*-poll` = `every 2m`, `task-patrol` = `every 5m`); the repo values take effect only after `install.sh` / `config/reconcile.mjs` runs against the store (§3.6). Live breakdown so far (17 jobs, pre-`skills-update`): **6 declared by `install.sh`** = 4 × `*-poll` (jobs/linus/turing/assistant) + `task-patrol` + `team-check-all`; **4 framework/plugin-owned** = `heartbeat-main`, `memory-dreaming-promotion`, `token-hygiene`, `session-rollover`; **6 × `skill-collection-review`** (main/jobs/linus/turing/assistant/simons); **1 out-of-band `simons-poll`** (`simons` is not in `install.sh` `ROLES`). `skills-update` is the repo's 7th declared job (18th overall) and appears in the store only once `install.sh` re-runs.<br>**Boundary vs `skill-collection-review-*`** (they are *not* the same concern): `skill-collection-review-*` reviews the **installed collection** on each host (what is present, duplicated, broken, stale *as a set*); `skills-update` reviews the **declared upstreams** in `skills/manifest.json` (has the pinned `source.ref` drifted from the upstream commit?) and is the only job that can *advance* a ref. Neither subsumes the other: a skill can be perfectly installed while its upstream moved, and a collection can be broken while every upstream is current.

| Name | Agent | Frequency | Trigger | Delivery | Purpose |
|---|---|---|---|---|---|
| `jobs-poll` | jobs | every 5m | ✅ | none | Board poll fallback: atomically claim jobs's todo/stale cards |
| `linus-poll` | linus | every 5m | ✅ | none | Same (linus) |
| `turing-poll` | turing | every 5m | ✅ | none | Same (turing) |
| `assistant-poll` | assistant | every 5m | ✅ | none | Same (assistant) |
| `simons-poll` | simons | every 5m | ✅ | none | Same (simons) — live-registered out-of-band (`simons` not declared by `install.sh` `ROLES`) |
| `task-patrol` | main | every 15m | ✅ | none | in_progress cards with stale heartbeat (>30min) → wake/recover |
| `sla-scan` | main | every **15m** (`OPENCLAW_TEAM_SLA_INTERVAL`) | ✅ | none | Board SLA inspection (`PROTOCOL §⑮` rows the heartbeat patrol does not cover: blocked / confirmation gate / defect-card creation / acceptance-card creation / leader stalled, + the contract's `inspector_liveness`); **notify-only to the leader**, wakes the model only on a tier crossing — see §3.8 |
| `team-check-all` | main | **hourly** | ✅ | none | Gate patrol; wakes the model only on failure |
| `skills-update` | main | **Sundays 05:00 (Asia/Shanghai)** | ✅ | none | Upstream skill-ref drift DETECT (`skills/manifest.json` vs `git ls-remote`); wakes the model only on drift/failure. Detect-only — `--apply` is a manual, reviewed step (see [`skills/README.md`](../skills/README.md)) |
| `heartbeat-main` | main | every 30m | — | none | Main-session heartbeat |
| `memory-dreaming-promotion` | main | 03:00 (Asia/Shanghai) | — | none | memory-core short-term memory promotion (managed) |
| `token-hygiene` | main | 04:00 (Asia/Shanghai) | — | none | Large-log compaction/memory indexing |
| `session-rollover` | main | 06:00 (Asia/Shanghai) | — | none | Main-session rollover |
| `skill-collection-review-{main,jobs,linus,turing,assistant,simons}` | respective | every 7d (staggered) | — | none | Skill collection patrol (`simons` out-of-band; not declared by `install.sh`) |

## 2. Cost Model (important)
- **An idle trigger job = zero cost**: `fire:false` only writes state, produces no run, and consumes no model. So all poll / task-patrol / team-check-all / skills-update / sla-scan jobs are **near zero cost when there is no anomaly**. (`skills-update` still costs a few seconds of *network* every Sunday — it must ask 15 upstreams for their current HEAD — but it wakes no model.)
- Only **`fire:true` wakes a model turn** (poll = a card was claimed; task-patrol = a stale card exists; check-all = the gate failed; skills-update = an upstream skill ref moved, or the check could not be confirmed; sla-scan = a board wait newly crossed a `§⑮` tier, or the inspection could not be confirmed).
- Non-trigger jobs (heartbeat/maintenance/skill) produce runs at a fixed frequency.

## 3. Dispatch Path (framework-owned, provider-agnostic)

Scheduling is owned by the **framework**; it is **not** delegated to the provider.
Each trigger script is generated by `install.sh` (absolute paths only — no
template substitution) and calls the framework dispatcher:

| Job | Dispatch call |
|---|---|
| `*-poll` | `node <team>/automations/dispatch.mjs poll <agent>` |
| `task-patrol` | `node <team>/automations/dispatch.mjs patrol` |
| `team-check-all` | `node <team>/automations/dispatch.mjs check-all` |
| `skills-update` | `node <team>/automations/dispatch.mjs skills-update` |
| `sla-scan` | `node <team>/automations/dispatch.mjs sla-scan` |

`dispatch.mjs` selects the provider's entry command (from
`automations/providers.json`; provider = `OPENCLAW_TEAM_TASK_PROVIDER`, default
`meerkat-taskpanel`), runs it **without a shell**, and returns a one-line
`{"fire":bool,"message"?,"state"?}`. The Gateway trigger wakes the agent **only on
`fire:true`**; a missing entry, a failure, a timeout, or unparseable output degrades
(exit 0), and what a degrade says depends on the job: **`poll`/`patrol` ⇒ `fire:false`
(zero cost)**, but the **`check-all` gate ⇒ `fire:true`** — an unconfirmed gate must
alarm, never report green (T-20261010-190039). **`skills-update` ⇒ `fire:true`** for the
same reason: a weekly detector that degrades to `fire:false` is indistinguishable from
"nothing moved", so an evaluation it could not complete must be surfaced. **`sla-scan`
⇒ `fire:true`** for the SLA-inspector version of the same rule: an unconfirmed inspection
must not read as "nothing overdue" (`guides/sla-inspection-contract.md` §10.2). Contract +
ACL gaps: `automations/README.md`.

**Entry paths: all but one resolve to `{team}`.** The `skills-update` entry is the
exception — `providers.json` `skillsUpdate` = `node {repo}/skills/update.mjs --json`.
The skills pipeline (`manifest.json` + `lock.json` + `fetch.mjs` + `update.mjs`) is a
**repo-side asset that `install.sh` drives in place**; it is deliberately *not* deployed
into `{team}/`, because `{team}/skills/` is the task provider's own ACL directory
(`task-ops/`). `{repo}` therefore resolves at dispatch time to the framework checkout —
`$OPENCLAW_TEAM_REPO` first, else the `repoPath` recorded in
`{team}/.install-state.json` (the same resolution `check-all.sh` uses for its drift
baseline). If neither resolves, the job degrades to an **alarm** rather than substituting
an empty path.

So `task-patrol` → `dispatch.mjs patrol` → `providers.json` **`patrol` =
`node {team}/scripts/patrol.mjs`** — a **scan + re-check before emit**: `patrol.mjs`
runs `scanStale()` and, when candidates exist, re-checks them **in-process** against
each card's *current* on-disk state before emitting, so a candidate whose card has
since reached `done`/`in_review`/`blocked` moves into `dropped` instead of firing.
`patrol-scan.mjs` stays the single-source decision module (both `scanStale` and
`recheckStale` go through its `liveVerdict`). **Call `patrol.mjs`, not
`patrol-scan.mjs` directly**: the scanner alone has no pre-emit re-check, and the
re-check is what stops a stale snapshot from being fired verbatim
(`T-20261010-061248`, `T-20261010-071808`, `T-20261010-090407`).
The re-check is **fail-safe**: if it throws or returns a malformed envelope, the
original candidates are kept (emit the alert rather than silently swallow it) and the
envelope is marked `recheck:"failed"`. Exit is non-zero **only** on a real scanner
failure; "no alert" is always exit 0 with `{"stale":[]}`.

**The entry scripts ship with the framework.** `poll.mjs` / `patrol.mjs` /
`patrol-scan.mjs` / `check-all.sh` (with their runtime dependency closure and the framework test suite)
live in this repository under `team/scripts/**` and are deployed by `install.sh`
into `{team}/scripts/**` — a fresh install has no dangling entry path
(the former "entry-path coupling" gap, `automations/README.md` gap #2). These
scripts still link the provider's ACL library at `{team}/skills/task-ops/lib/`
(provider-owned, intentionally not vendored), so a provider install is still
required for them to execute. That requirement is now **explicit (startup
hard-fail)**: absent a provider install the entries print a clear
`provider 未安装：…` error and exit non-zero (no silent no-op) — see
`T-20261009-211234-providerdecouple`.

## 3.5 Run lock: what the framework bounds, and what it cannot (③)

Two different clocks are involved; only the first is framework-owned.

| Concern | Owner | Framework behaviour |
|---|---|---|
| **Trigger evaluation** (the poll/patrol/check-all/skills-update *decision*: run the entry, read `{fire}`) | framework | **Bounded.** `dispatch.mjs` runs the entry under `OPENCLAW_TEAM_EVAL_TIMEOUT_MS` (default **8000 ms**; invalid/absent ⇒ default) **minus `EVAL_EMIT_RESERVE_MS`** (500 ms of emission headroom — `install.sh` sizes the trigger's `timeoutSeconds` at `ceil(budget/1000)`, i.e. only ever *equal* to the inner bound, so without the reserve the outer `exec` would kill the dispatcher before it could print), and `install.sh` generates each trigger with `exec({ command, timeoutSeconds })`. Both stay under the Gateway's own **30 s** per-evaluation wall-clock budget — and the trigger's `timeoutSeconds` is additionally capped in practice by the exec helper's **10 s default `yieldMs`**, above which the call backgrounds and the trigger would read partial output; the bound therefore cannot simply be widened for a slow job. A degrade exits 0 and **fails safe**: `poll`/`patrol` → `{"fire":false,"state":{"reason":"eval-timeout"}}`, but the `check-all` **gate** → `{"fire":true,"message":…,…}` (an unconfirmed gate must alarm, never report green — T-20261010-190039), and so does `skills-update` (an unconfirmed drift check must not read as "nothing moved"). **The `check-all` gate is 15-20 s** — longer than this whole budget — so it does not run whole inside it; **§3.5.1** covers how the gate stays a real verdict inside the bound without dropping coverage. |
| **Run lock** (`already-running`: a run already holds the job lock, so the next trigger is skipped; releasing **stale** runs) | **Gateway scheduler (platform)** | **Lock itself: not addressed here** — the framework neither bounds nor reaps runs *holding* the lock; that needs owner/OpenClaw platform capability and is **out of scope**. **What the framework DOES own is the run's LIFETIME** (below), and since the lock is only ever held for as long as a run lives, a short run is the framework-side lever on the same failure mode (T-20261013-041718). |

**Poll run = short hand-off turn (T-20261013-041718, P1).** The lock row above is not
academic: with `*-poll` on a 2–5 m cadence, a single poll run that stays resident
**silently disables the fallback for its whole lifetime** — every intervening trigger
is skipped, so a card dropped mid-run waits until the run ends. Measured (E2E-C-4):
a `turing-poll` run open `19:39Z → 20:05Z` delayed a `ready` card dropped at
`19:42:35Z` until `20:05:44Z` (`Δ = 1389 s ≫ 120 s`), while the very next card in the
same session was claimed in `85.8 s` — i.e. the *mechanism* was healthy and the whole
`Δ` is the run's lifetime. The framework's answer is therefore **two-sided, and only
the second is genuinely platform-free**:

1. **Contract — the poll run must be SHORT.** `team/scripts/poll-run.mjs` is the single
   source for the run payload: the run **claims → hands off** (`scripts/spawn-lane.sh`,
   detached) **→ returns**; it does **not** execute the card and does **not** poll the
   spawned lane to its terminal state inside the run. Lane supervision moves to the
   **next cron turn + `task-patrol`**, which `PROTOCOL §⑥` already sanctions ("if the
   worker's turn is interrupted/ends before the subsession finishes, arrange for a
   subsequent turn to take over polling"). This retires the previous payload
   (`直接执行不再 claim`, i.e. execute-in-place) as the poll-run default.
2. **Bound — the run may not outlive the fallback it guarantees.** `install.sh` registers
   each poll job with `--timeout-seconds "$OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S"`, whose
   default is now **one poll interval** (`OPENCLAW_TEAM_POLL_INTERVAL`, e.g. `2m` ⇒ `120`),
   not the old **3600 s**. So even a run that ignores the contract is reaped by the
   scheduler within ≈one cadence instead of holding the lock for up to an hour. `0`
   disables the bound; an invalid value falls back to the interval default (a typo can
   never widen the bound to "unbounded").

**Residual (still platform): releasing a run the scheduler never reaps.** The bound
above bounds the *run*; it does not make the Gateway reap a run that has already
overrun its own bookkeeping, and it cannot make a trigger fire *while* a run is in
flight. Closing that last gap needs owner/OpenClaw platform capability and is **not
claimed here**.

**`skills-update` and the trigger budget (measured).** This is the only framework job
whose entry talks to the network, so it is the only one where the 8 s bound bites. It
resolves upstream refs **per unique repository, not per manifest entry** (~73 github
entries live in ~15 repos) and issues the whole set in **one parallel wave**: measured on
the maintainer host, 15 concurrent `git ls-remote` finish in ≈5 s, while the same work
played back sequentially takes ≈45 s, and any smaller pool re-queues the tail repos into a
second wave and exceeds the bound. That is why `resolveAll`'s concurrency default covers
the unique-repo set instead of being a small fixed worker count. A slow/offline network
therefore *does* blow the bound — and the honest outcome there is the alarm above, not a
silent "no drift".

Poll jobs additionally carry a **run upper bound**: `install.sh` registers them with
`--timeout-seconds "$OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S"`, whose default is now **one poll
interval** (T-20261013-041718 — see the "Poll run = short hand-off turn" block above;
the pre-fix default was 3600 s; `0` disables). The poll run is a claim-and-hand-off turn
(`team/scripts/poll-run.mjs`), so the bound no longer has to cover a card's execution
time — it only has to ensure a runaway run cannot outlive the fallback cadence it is
there to guarantee. This bounds one run's lifetime; it does **not** release a lock held
by a run that the scheduler never reaps.

### 3.5.1 The `check-all` gate inside the budget: segmented verdict + cached slow suite (T-20261013-031036)

The `check-all` gate grew past the evaluation budget: measured **15-20 s** against an entry
bound of 7500 ms, of which the `node --test team/scripts/tests/*.test.mjs` suite is ~17 s and
everything else is ~1.6 s. Two things went wrong, and the second is the worse one:

1. the gate was **never confirmed** — every hourly evaluation ended in `eval-timeout`, which
   under the gate fail-safe is `fire:true`, i.e. an hourly model wake and a status that is
   never green;
2. the timeout envelope **carried no verdict at all**, so a genuinely red gate was *masked*
   by the timeout until somebody ran `check-all.sh` by hand.

Widening the bound is not an option: the exec helper's 10 s `yieldMs` cap sits *below* the
gate's wall clock (table above), so the cost cannot be escaped by budget. The gate is
therefore **segmented** — this is a routing change, not a coverage change:

| Piece | Where | Bounded? |
|---|---|---|
| **fast segment** — every check except the framework test suite (`check-all.sh --segment fast`, ~1.6 s) | **in-band**, inside the evaluation | yes (fast bound 6000 ms) |
| **slow segment** — the framework test suite only (`check-all.sh --segment slow`) | **detached**, launched by the gate and run to completion *after* the evaluation returns | no (it is ~17 s by nature) |
| the slow verdict | **cached** at `<team>/.check-all-slow.json` and **folded into the next evaluation** | freshness-bounded (TTL default 90 min) |

`check-all.sh` is still the single source of every check (`--segment all` is the default and
is byte-for-byte the historical full run, for humans and CI). The scheduled entry is
`scripts/check-all-gate.mjs`: it runs the fast segment in-band, reads the cached slow verdict,
emits `{"ok":…,"message":…}` and launches the detached slow refresh. Consequences:

- a **red fast check fires immediately, with the failing steps in `message`** (the masking
  problem is gone — the dispatcher forwards that message verbatim);
- the slow suite still runs **every cron period**, so per-period coverage is unchanged; its
  result is reported by the *next* evaluation (worst-case detection latency = one cron
  period, documented and accepted — strictly better than "never confirmed");
- the slow axis **fails closed**: a missing, stale, or unreadable cached verdict is
  *unconfirmed* ⇒ `ok:false` ⇒ `fire:true`. A refresh that never lands degrades to an alarm,
  never to a silent green. The one-time consequence is that the **first run after deploy**
  alarms (no cache yet); every run after it is green.

Runtime state written by the gate (`<team>/.check-all-slow.json`, `.check-all-slow.lock`,
`.check-all-slow.log`) is excluded from the repo↔instance drift patrol — it is host-local,
like `.install-state.json`.

## 3.6 Live trigger drift (item 1 — the re-check must reach the *live* trigger)

The framework side above is necessary but **not sufficient**: the deployed Gateway job
does not read `providers.json`. It carries its **own** inline trigger script.

- `task-patrol` is registered in the **Gateway automations store** under
  `declarationKey` `openclaw-team:task-patrol` (job id `eb1e3fa3-…`), **not** as a file
  anywhere under `~/.openclaw/**` — grepping the deployed tree will not find it. Read it
  with `openclaw automations get <id>` (or `automations list`); edit the trigger with
  `openclaw automations edit <id> --trigger-script <file>`.
- A trigger that calls `node …/scripts/patrol-scan.mjs` **directly skips the pre-emit
  re-check**, and bypasses `dispatch.mjs` entirely. That was the state found on
  2026-10-10: the live `task-patrol` trigger still ran the old inline
  `exec node patrol-scan.mjs` (no `--recheck`), while the wrapper
  `scripts/triggers/patrol-main.js` — which *does* carry `--recheck` — was referenced by
  **no** live automation. A fix that only lands in the repo/instance files therefore
  does **not** take effect until the live trigger is re-pointed.
- **Reconcile now covers the trigger body (T-20261010-092547).** `config/reconcile.mjs`
  reconciles `payload.lightContext`, the (interval) **schedule**, **and** the live
  `trigger.script` **content**. The declaration source (`install.sh` §6) writes each job's
  byte-exact expected trigger body — from the single template
  `team/automations/trigger-template.mjs` via `write_trigger()` — to a `triggerScriptPath`,
  and reconcile emits `--trigger-script <path>` whenever the live body drifts (trailing
  newline tolerated). So re-running `install.sh` **self-heals** a drifted/stale trigger body
  instead of leaving it to a manual `automations edit`. If the declared path is
  missing/unreadable the rule is skipped (fail-safe: never point `--trigger-script` at a
  file that could not be read).
- **Attribution / scope (Gateway store writes)**: the *decision* is repo-side
  (`config/reconcile.mjs` + its tests); the *write* to the Gateway automations store still
  happens only at install time through the official CLI
  (`openclaw automations edit <id> --trigger-script <file>`, §4/§6). The agent/cron
  `automations` tool remains **read-only** (§4 caveat), so an agent turn cannot apply it —
  a live repair requires an install run (or an operator-scope CLI call).
- **Operating rule**: land decision-path fixes in `team/scripts/**`; the trigger body is
  generated from `team/automations/trigger-template.mjs`, so a re-run of `install.sh`
  re-points the live trigger to the current expected body (verify with
  `openclaw automations get <id>`). To hot-fix without a full install, use
  `openclaw automations edit <id> --trigger-script <file>` directly. Repo-green ≠
  live-green until reconcile/install has run against the store.

## 3.7 Inter-session delivery latency (item 2 — a correct verdict can still arrive stale)

Patrol's verdict can be **correct at generation time** and still be useless on arrival.
Supplemental review R41 (`T-20261010-071808`, 2026-10-10) established the mechanism:
the 18 nudge messages had **genuinely** matched a stale card when generated; the
staleness in the consumer's experience came from **delivery latency, not a patrol
cache**. Measured **generate → deliver ≈ 12–130 min**, and the control group was
decisive: manually dispatched cards in the same window were delayed **38–108 min** too
⇒ the root cause is the **transport / liveness layer (Gateway), not patrol**.

Consequence: by the time a true alert reaches the worker the card often already looks
"closed", so the worker is forced to re-verify live.

**Root cause is 归口 the gateway platform layer (待 Terry 裁定).** The team side cannot
bound transport latency from inside `team/scripts/**`. Three candidate mitigations,
recorded for that decision:

1. **Delivery-time re-check** — re-run the present-state check when the message is
   *delivered* (not just generated). This is the only one that fully closes the window;
   it needs the queue/consumer side, i.e. the Gateway.
2. **Superseded downgrade** — mark a nudge as superseded if a newer state for the same
   card already exists at delivery, and degrade it instead of waking the worker.
3. **Queue latency upper bound / alert-on-latency** — bound how long an alert may sit
   queued; a breach is itself a signal worth surfacing (the backlog is the incident).

**Team-side mitigation landed here (partial, honest about scope).** `patrol.mjs` moves
the re-check as late as the team layer owns — to **just before emit** — and every alert
entry now carries **machine-checkable present-state evidence** (`status`,
`status_changed_at`, `has_sessions`, `has_workspace`) plus the card's `stale_kind`.
A consumer that knows when the alert was generated can therefore **drop or downgrade a
superseded nudge without a new round-trip**. That narrows the window; it does **not**
close it — the residual is the Gateway transport backlog above.

## 3.8 `sla-scan` — board SLA inspection (the §⑮ rows patrol does not cover)

`task-patrol` covers **one** `PROTOCOL §⑮` row (`in_progress` + stale heartbeat). Every other
row — *blocked awaiting clarification*, *confirmation gate awaiting review* (§⑭), *defect fix
card creation* (§⑨), *product/UX acceptance queued* (§⑨.1), *leader patrol stalled* — was
**zero-coverage**, on a board whose waits are the team's own. `sla-scan` closes that gap on the
openclaw side; the loop side does the same under `guides/sla-inspection-contract.md` (C4), and the
contract fixes **one semantics** both implement.

- **Entry / dispatch**: `providers.json` `slaScan` = `node {team}/scripts/sla-scan.mjs`;
  `dispatch.mjs sla-scan` (a **fail-closed detector**, §3 above). Trigger body comes from the same
  single template (`automations/trigger-template.mjs`) as every other job, so it inherits the
  bounded `exec({timeoutSeconds})` form and the `--light-context` registration.
- **Envelope**: `{"fire": <bool>, "alerts": […], "dropped": […], "state": {…}}` — an **explicit
  `fire`**, never the legacy `stale` key (which belongs to the heartbeat patrol's own consumer
  contract; overloading it would silently change that job's meaning). `dropped` carries both the
  candidates the pre-emit re-check removed **and** the ones the de-duplication ledger suppressed —
  nothing is ever dropped silently.
- **契约**: `guides/sla-inspection-contract.md` §4 (alert tuple: `sla_row` / `severity` / tier /
  `measure_start_*` / `threshold_min` / `target:"leader"` / `evidence` …), §5 (six `§⑮` rows +
  the contract's `inspector_liveness`), §9 (read-only / notify-only / fail-safe / zero-cost idle /
  working hours / pre-emit re-check), §8.3 (de-duplication ledger).
- **Never changes a card.** The inspector's only writes are its own host-local runtime artefacts in
  `<team>/` (`.sla-scan-ledger.json`, `.sla-scan-state.json`), both excluded from the repo↔instance
  drift patrol. The releasability hint (`releasable` / `releasable_basis`) is a **hint**: releasing a
  blocked card, re-claiming a stale one, creating a fix/acceptance card and escalating all stay
  leader actions (`§⑦` / `§⑨` / `§⑨.1` / `§⑮.1` is a *worker* channel this job never uses).
- **Working hours**: Asia/Shanghai 09:00–23:00, **accumulated** (the clock stops off-hours) — computed
  in UTC with a fixed +08:00 offset, so an observer on another host gets the same elapsed minutes.

**Cadence — the `§⑮`-row reconciliation (contract §12 G-6, owed by this wiring card).** The contract's
tier ladder puts `warn` at `L − P` (clamped at 0), where `P` is *this mechanism's own period*. `§⑮`'s
tightest row is *Worker heartbeat stale* (`L = 30 min`), so `P ≥ 30` makes that row's warn boundary
`T ≥ 0` — every in-flight card would alarm on every tick, which is exactly the zero-cost idle the
contract forbids. The registered cadence is therefore **`every 15m`** (`OPENCLAW_TEAM_SLA_INTERVAL`,
default `15m`), i.e. the same figure as the framework's existing `task-patrol` and the same order of
magnitude as the operator ruling's "~30 min". The runtime `P`
(`scripts/sla-scan.mjs` `DEFAULT_PERIOD_MIN`) and the registered interval are pinned to each other by
a machine check (`scripts/tests/sla-scan.test.mjs`), so the two cannot drift apart silently.

**Thresholds are never re-typed.** `scripts/sla-scan.mjs` carries a runtime mapping table whose
every value sits next to its `§⑮` reference; `node scripts/sla-scan.mjs --check-thresholds` re-parses
`PROTOCOL §⑮` and fails loudly on drift (contract §11 hook H6). Same idea for the *contract* prose:
this section references the guide, it does not restate it (`PROTOCOL §⑰`).

**Known deviations / limits (deliberate, recorded — not discovered as defects):**
1. **De-duplication backend is a host-local file, not a card-trail marker.** The contract's default
   backend (§8.3 (a)) writes a marker into the card's own trail; this landing holds **no card-write
   capability** (writing a live board's cards from a 15-minute job is a corruption risk the contract
   itself bounds). So the contract's sanctioned backendless fallback applies (§8.3 rule 5):
   de-duplication holds **within** this mechanism, and the cross-mechanism residual is **at most one
   duplicate notification per key** — recorded here as a deliberate deviation. The shared channel the
   contract prefers (the card itself) is a C4/Elon decision.
2. **`inspector_liveness` treats a *never-published* peer marker as a visible note, not an alarm.**
   The peer mechanism (the loop-side patrol) does not publish a marker yet; alarming on its absence
   every period would be a permanently-red job — the failure mode §10.2 exists to prevent. The state
   block always reports `peer.status`, so the gap is visible; `OPENCLAW_TEAM_SLA_PEER_REQUIRED=1`
   switches to alarm-on-absence once C4 lands.
3. **`acceptance_card_creation` covers the delivery state (`in_review`) with `flow` absent read as A**
   (the contract's fail-safe default). `§⑨.1`'s UI-scope condition ("touches product/UI/UX") is not
   machine-decidable from the board, and adding a filter that guesses would risk silencing a real
   acceptance wait. Consequence: a board where many `in_review` cards are older than the row's limit
   produces one alert per such card (de-duplicated thereafter) — the measured first-run shape is in
   the landing card's report.

**Contract-v1.1 conformance fixes (F1 / F5 / F8, `T-20261014-084606`).** Three deviations the design
confirmation `T-20261014-022327` found in this landing (registered as §12 **G-10 ⑤⑥⑦**) are fixed;
`§⑮` thresholds, the tier ladder and the coverage set are untouched:

- **F1 — `measure_start_source` is the read location only.** The field had been fed the
  `measure_start_kind` vocabulary (`trail_event` / `created_at` / `status_changed_at`), which is
  outside the contract §4 #9 enum (`frontmatter|comments|progress|missing`). Source and kind now have
  separate vocabularies (`MEASURE_START_SOURCES`), and `leader_stalled`'s `kind` follows the real
  event again (`trail_event` for a leader-authored trail entry, `created_at` for a leader-created
  card, `status_changed_at` for a leader-only terminal transition).
- **F5 — the `leader_stalled` origin is emitted, not dropped.** Previously a latest leader event older
  than the 7-day lookback window was treated as "no origin", which nulled `threshold_min` and capped
  the row at the weakest signal (`warn`) — so the *deepest* stall was reported as the *mildest* one.
  The lookback window now only lowers `confidence` to `low` (contract §6.3-D); the real origin and the
  row's `L`/`F` are kept, so a long stall can still reach `escalate`. Only a board with **no**
  leader-attributed event at all falls back to §6.5 (`unverifiable` / `warn`, still emitted).
  The pre-emit re-check uses the same construction, so it can no longer drop the row for being
  outside the window.
- **F8 — `blocked_reason` is the card's current value on every row.** It had been filled only on
  `blocked_clarification`, so the `defect_card_creation` (and every other) tuple carried `null` even
  when the card held a reason — contrary to §4 #19 ("on **every** row"). It is now read once per card
  and carried by every row of that card (`null` iff the card carries none), including `leader_stalled`,
  which takes the value of its evidence-holder card.

## 4. Decision Record
- **Keep per-worker poll; do not do a "single board scan → dispatch"**: per-worker `*-poll` is an **independent fallback** (each worker atomically claims, so cards already created can still be claimed when Elon/main is stalled). Merging into "main scans → dispatch" would converge to a single Elon point and change the `PROTOCOL §①` "claim timing belongs to poll" semantics; the only gain is a few zero-cost config lines ⇒ not adopted.
- **Patrol frequency**: the gate patrol `team-check-all` is set to **hourly**; because it triggers the model only on failure, a higher frequency adds no cost.
- **Cron slimming (`T-20261010-040000-configoptim-cronslim`)**: per-worker poll was thinned **1m → 2m → 5m** (override `OPENCLAW_TEAM_POLL_INTERVAL`, default `5m`) and `task-patrol` widened to **15m**, and every framework job now runs with **`--light-context`** so scheduler triggers stay cheap. The trigger decision is still an atomic claim check — 5m keeps the "claim timing belongs to poll" fallback (§①) while cutting scheduler wake-ups (worst-case claim latency ≤5m; worker crash recovery window ≈ patrol 15m + poll 5m).
- **Fallback cadence widened (`T-20261010-224144`)**: per-worker poll **2m → 5m** (`OPENCLAW_TEAM_POLL_INTERVAL`) and `task-patrol` **5m → 15m**. The dispatch mainline is Elon assigning via `sessions_send` (push); poll only fires when that push did not land, so the accepted worst-case claim latency is now ≤5m and the accepted worker crash recovery window ≈ patrol 15m + poll 5m. Nothing else moves: the trigger decision stays an atomic claim check (§①), `task-patrol` stays **light-context only**, and its stale threshold (>30min) is unchanged. **The ≤5m figure is a claim about the CADENCE, not about any single run**: it holds only while a poll run is not resident across the boundary, which is why `T-20261013-041718` pins the run contract to a short hand-off turn and the run bound to one interval (§3.5).

## 5. Management
- **Install-time registration (declarative reconcile)**: `./install.sh` is the declaration source; `config/reconcile.mjs` aligns the runtime to it by `declarationKey` (`openclaw-team:poll:<agent>` / `openclaw-team:task-patrol` / `openclaw-team:team-check-all` / `openclaw-team:skills-update`); `--skip-automations` disables it. Re-running is safe and **self-healing**: a missing key ⇒ `add`; a present key that drifts ⇒ `edit`; a present key that already matches ⇒ `skip`. **Drift** = `payload.lightContext !== true`; (interval jobs only) a schedule mismatch with the declared interval; or a live `trigger.script` body that differs from the declared `triggerScriptPath` file (⇒ `--trigger-script <path>`, §3.6). **Cron jobs (`team-check-all`, `skills-update`) are never given `--every`** — only `lightContext`/trigger are reconciled, so the cron expression is left untouched. The registration is **provider-agnostic** — no `meerkat-taskpanel`/`taskctl` literal appears in any trigger script. The expected trigger body comes from the single template `team/automations/trigger-template.mjs`.
- **Scheduling bounds** (set at registration; see §3.5): poll jobs get `--timeout-seconds` (run upper bound, `OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S`, default = one `OPENCLAW_TEAM_POLL_INTERVAL` — T-20261013-041718; was 3600 s); every generated trigger passes `exec({ …, timeoutSeconds })` and the dispatcher applies `OPENCLAW_TEAM_EVAL_TIMEOUT_MS` (default 8000 ms). Both are install-time overridable env vars.
- View: `automations list` | Details: `automations get <jobId>` | History: `automations runs <jobId>`
- Test run: `automations run <jobId> runMode=force`
- Add/remove/modify: prefer the `automations` tool; **but that tool is read-only in agent/cron turns** (only status/list/get/remove/runs/next_check, no add/update/run) ⇒ to actually change scheduling, use the official CLI: `openclaw automations edit <jobId> --trigger-script <file>` (Gateway WS managed path, not a manual DB edit). Hand-editing sqlite/store is forbidden.
- Constraint: `declarationKey` is **add-only** (fixed at creation, cannot be updated afterwards); changing a key requires remove + re-add.
- Permissions: in a chat turn, `add`-ing a job for **another agent** is rejected by scope (`agentId outside caller scope`); workaround = create first, then `update agentId` (or have the owner create it in the Control UI).

## 6. Patrol Metrics (attached to check-all)
- **Trigger-script placeholder incident fix (historical)**: the trigger inline JS **does not do brace template substitution**, so a placeholder literal passed to shell fails (`bash: {{HOME}}/...: No such file or directory`) ⇒ the gate patrol falsely reports failure and burns a model turn (poll-type jobs silently fail instead). **Fix**: switch trigger scripts to **absolute paths** and write back each job via `openclaw automations edit <id> --trigger-script <file>`; verify `automations list` has no placeholders and the gate is all green ⇒ trigger evaluation is `fire:false`. **Convention**: trigger script paths are always absolute; placeholders are forbidden.
- Redline-block drift = 0 | terminology-abstraction violations = 0 | §reference broken links = 0 | card-schema violations = 0 | contract tests all green.
- **New-seg background-pack rate**: the gate verifies that "all running/closed segs in the card have `workspace/<task-id>/handoff.md` containing the four anchors" — target 100%; gaps are handled (generated/carded).
