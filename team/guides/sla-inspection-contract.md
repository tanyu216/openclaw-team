# SLA Inspection Contract (sla-inspection-contract.md)

> **Status**: method library · **design contract** (design-only — no implementation in this file). Produced by **jobs**; it is the **common input** of C2 (`sla-scan`, openclaw side) / C3 (`blocked_reason` card field, TaskPanel) / C4 (loop patrol extension, TaskPanel).
> **Normative text**: `R-SLA-1`…`R-SLA-7` (SLA / timeout rules — **the per-row threshold values live in `guides/sla-thresholds.json`**), `R-BOARD-1` (board schema / state machine / heartbeat / stale recovery), `R-AMBIG-1` (ambiguity handling), `R-DEFECT-1` (defect loop), `R-UI-1` (acceptance card), `R-FLOW-1` (flow A/B/C), `R-CONFIRM-1` (confirmation gate), `R-SLA-7` (worker→operator exception channel), `R-LAYER-1` (doc layering / reference-not-copy), `R-OBS-1` clause 4 (an alert must be executable), `R-GATE-1` (machine-checkable gates).
> **Maintainer**: the contract's *mechanism* is owned by the two implementations; **Elon** owns the normative rule and adjudicates every value that lands in `guides/sla-thresholds.json`. **Integrator / dual-sign**: Elon (`R-CONFIRM-1`).
> **Depends on**: `R-SLA-1`; `guides/task-interface.md` (ACL — §2 data model, §4 `task.setStatus`, §11 serialization invariants, §15 label taxonomy); `guides/performance-sla-sop.md` and `guides/runtime-observability-sop.md` (**different objects**, see §0).
> **Sibling guides (reference, do not copy)**: `performance-sla-sop.md` · `runtime-observability-sop.md` · `incident-response-sop.md` · `task-interface.md`.
> **Reference convention**: always write "`R-SLA-1`" / "`guides/<file>.md` §<section>" — **no line-number anchors, no `file:line`** (`R-ENG-1` #11, `R-DOCSYNC-1` clause 4).

---

## 0. Object Declaration (read first — do not confuse with neighbouring documents)

> ⚠️ **The object of this contract = the observation, classification and *notification* of the team's own collaboration wait times on the task board** (the waits enumerated in `R-SLA-1`).

It is **not**: the product's runtime alerting stack (`R-OBS-1` / `runtime-observability-sop.md`); the product's external SLA/SLO baseline (`R-PERF-1` / `performance-sla-sop.md`); production incident grading and on-call (`R-INCIDENT-1` / `incident-response-sop.md`); the team-stalled worker→operator exception channel (`R-SLA-7`).

| Aspect | **This contract** | `R-SLA-7` | `R-OBS-1` |
|---|---|---|---|
| **Object** | Board wait times of the team's *own* collaboration | Team stalled, worker files an exception | Product runtime / product external SLA |
| **Actor** | Machine inspectors (two mechanisms) | A **worker's judgement**, manually filed | On-call / product owner |
| **Output** | An `alerts[]` list addressed to the **leader** only | A message to the **operator** | Product alert rules / dashboards |
| **Boundary** | **Never** acts on the board; never uses the `R-SLA-7` channel | Enabled **only** when the team is stalled | Not team-collaboration objects |

**Non-substitution (hard)**: this contract **never** invokes `R-SLA-7`, **never** addresses the operator, and **never** changes a card. See §9.

**Cross-cutting object classes (`R-CROSS-1`)** — three objects share the board but are not substitutable:
1. **Team collaboration waits** — this contract (`R-SLA-1`…`R-SLA-6`); measured on the board, addressed to the leader.
2. **Team-stalled exception** — `R-SLA-7`; a worker's judgement, addressed to the operator.
3. **Product runtime / external SLA** — `R-OBS-1` (runtime) and `R-PERF-1` (SLO/SLA); product-facing, not board waits.

Rules: (a) a gap in one class is **marked as a gap**, never filled with another class's numbers or mechanism; (b) when the boundary is unclear, ask three questions — *which actor, which object, which output/target*; (c) a convention shared across classes is **referenced**, with one responsibility owner and one landing point; (d) a mechanism's rollback/opt-out is explicit and recorded, never silent; (e) do not duplicate another class's normative text here.

**Positioning inside the parent epic**: the two mechanisms driving the *same* `task-interface` board each inspect only a narrow slice today; this contract fixes **one semantics** both must implement (`R-SLA-1` rows), plus the card field `blocked_reason` that the rows need in order to be distinguished.

---

## 1. Scope and Boundaries

| Item | Content |
|---|---|
| **Does** | ① fix the **alert tuple** shared by both mechanisms (§4); ② map the six `R-SLA-1` rows to measurement origin / trigger / threshold source / tier ladder / action / target (§5, §6); ③ define the structural card field `blocked_reason` (§7); ④ define cross-mechanism semantic equivalence, de-duplication and mutual liveness (§8); ⑤ define the safe-operation envelope — read-only, notify-only, fail-safe, zero-cost idle, working hours (§9); ⑥ define the machine envelope and the wiring duties of C2/C4 (§10); ⑦ list the verification hooks the independent verification must check (§11) |
| **Does not** | **No implementation** — no code, no edit of the inspectors, no trigger registration (that is C2/C4's cards); **no threshold value** — every number belongs to `R-SLA-1` (§2); **no card-state action** — the inspectors hold no write capability onto card state (§9); **no provider schema change by itself** — `blocked_reason` is *specified* here and *landed* by C3 in the provider; **no rule edit** — changes proposed to `R-SLA-1` are backfill items for Elon (§12) |
| **Handoff** | Contract → **C2** (openclaw `sla-scan` + trigger wiring) / **C3** (`blocked_reason` provider field) / **C4** (loop patrol extension); verification → **C5** / **C6** / design confirmation → rule backfill (if any) → Elon per `R-DOCSYNC-1` |

---

## 2. Normative Sources and the Reference-Not-Copy Rule

1. **Thresholds — single source of truth = `guides/sla-thresholds.json`.** This contract **carries no numeric SLA value**. Every threshold cell in §5 is written as a **reference** to the `sla-thresholds.json` row and field it comes from; `R-SLA-1`…`R-SLA-7` remain the normative rules that say what each row *means*. The implementation's runtime mapping table MUST carry the same reference next to each constant, and a **drift check** against `sla-thresholds.json` is required (§11 hook H6).
2. **Symbols used in this document** (all are *references* or *mechanism parameters*, never new SLA numbers):

| Symbol | Meaning | Origin |
|---|---|---|
| `L` | the row's **normal limit** | `R-SLA-1`, column *Normal limit* |
| `F` | the row's **further-timeout** bound | `R-SLA-1`, column *Further timeout* (where published) |
| `P` | the **inspecting mechanism's own period** (the cadence of the job that inspects) | mechanism parameter, pinned by the operator's ruling — **not** an SLA threshold |
| `T` | elapsed time of the wait, on the row's **measurement basis** | computed (§6) |

3. **Reference-not-copy (`R-LAYER-1` clause 2).** The `R-SLA-1` row **names** are quoted here only as identifiers required for a mapping; the row's limit values, its action prose and its further-timeout prose are **not reproduced** — they are referenced. Anything this contract adds (measurement origin, tier boundary formulas, target, de-duplication) is *derived detail*, which `R-LAYER-1` clause 3 explicitly permits.
4. **Implementation names** (entry scripts, jobs) appear only as *current landing points*; the contract is written in terms of **mechanism roles** so that a rename or a re-hosting does not invalidate it.

---

## 3. The Two Mechanisms

| | **openclaw-side inspector** | **loop-side inspector** |
|---|---|---|
| Role name | `openclaw-cron` | `loop-patrol` |
| Where it runs | the leader's gateway host (the OpenClaw instance) | the worker/loop host(s) (the TaskPanel-side supervisor) |
| Current landing point | a new entry (`sla-scan`), registered as its own scheduled job and reaching the board through the provider ACL | the loop's existing patrol path, extended in scope |
| Cadence | the framework's own scheduled cadence (a **mechanism parameter**; see the cadence note in §12 gap G‑6) | the loop patrol's own period (`P`) |
| Today's coverage | **one** `R-SLA-1` row only (stale `in_progress` heartbeat) | **one** `R-SLA-1` row only (the same one) |
| Duty after this contract | cover **every** row of §5 | cover **every** row of §5, **with the same semantics** |

**Hard rules for both mechanisms**
- **Read-only on card state.** The inspector may read the board and may **not** call any mutating `task-interface` command (no claim, no `setStatus`, no dispatch, no card creation). See §9 for the single, bounded exception (the de-duplication marker, §8.3, which is a *trail* write and never a state write).
- **Notify-only.** Every alert is addressed to the **leader** (`R-TERM-1`: `leader` = the team coordinator; the name is never hard-coded — the card field is `notify_leader`).
- **Never the operator.** The inspector must not use the operator channel; the `R-SLA-7` exception channel stays a worker-judgement channel outside this contract (§0).
- **Never auto-release.** No `blocked → todo`, no stale re-claim, no fix-card creation, no acceptance-card creation, no reassignment. Those stay `R-SLA-1`-action / `R-AMBIG-1` **leader** actions. The inspector's job stops at *visibility*, *due-time reminder* and *releasability hint*.

---

## 4. The Alert Tuple (`alerts[]`)

One alert = one **(card, `R-SLA-1` row)** pair at its highest newly-crossed tier (§5.2). Flat object, JSON. All time fields are ISO-8601 **UTC with fixed milliseconds** (`R-BOARD-1` time convention).

| # | Field | Type / enum | Req. | Semantics |
|---|---|---|---|---|
| 1 | `alert_id` | string | ✅ | `<card_id>#<sla_row>#<severity>` — deterministic, human-readable, reproducible by either mechanism |
| 2 | `dedup_key` | string | ✅ | `<alert_id>@<measure_start_at>` — the idempotency key (§8.3). Addressed by **tier**, so a tier promotion is a *new* key and is **never** de-duplicated away |
| 3 | `card_id` | string | ✅ | the card the wait belongs to (or the card holding the *evidence* of the wait, see §6.3-B) |
| 4 | `sla_row` | enum | ✅ | `blocked_clarification` \| `confirmation_gate` \| `defect_card_creation` \| `acceptance_card_creation` \| `heartbeat_stale` \| `leader_stalled` \| `inspector_liveness` (last one is not a `R-SLA-1` row — see §5.3) |
| 5 | `sla_ref` | string | ✅ | the citation string, e.g. `R-SLA-1 <row name>` — **never** a line anchor. Makes the alert self-explaining and lets a reader re-derive the threshold |
| 6 | `severity` | enum | ✅ | `warn` \| `overdue` \| `escalate` (§5.2) |
| 7 | `measure_start_kind` | enum | ✅ | `blocked_at` \| `status_changed_at` \| `heartbeat_at` \| `gate_at` \| `trail_event` \| `created_at` \| `unverifiable` (§6) |
| 8 | `measure_start_at` | ISO-8601 UTC ms | ✅ | the origin instant `T` counts from |
| 9 | `measure_start_source` | string | ✅ | **the read location only** (`frontmatter` \| `comments` \| `progress` \| `missing`) — **never** the `measure_start_kind` value; a frontmatter field ⇒ `frontmatter`, a `## Comments` entry ⇒ `comments`, a `## Progress` entry ⇒ `progress`, nothing readable ⇒ `missing`. Audit trail for a derived origin |
| 10 | `elapsed_working_min` | number | ✅ | `T` in **working-hours minutes** (§6.4) |
| 11 | `elapsed_basis` | enum | ✅ | `working_hours` (default, `R-SLA-1` rolls off-hours over) \| `wall_clock` (only when a row explicitly needs it — none does today) |
| 12 | `threshold_min` | number \| null | ✅ | the value **taken from `guides/sla-thresholds.json` at runtime**; `null` ⇔ the row has **no** published threshold (§5.3, §7.4) ⇒ no `due_at`, no tier above `warn` |
| 13 | `due_at` | ISO-8601 UTC ms \| null | ✅ | projection of `measure_start_at` advanced by `threshold_min` on the measurement basis. **Display only** — the verdict is computed from `elapsed_working_min ≥ threshold_min`, never from `due_at` (a rounding slip in `due_at` must not be able to create a false green) |
| 14 | `action` | string | ✅ | the `R-SLA-1` action **for this row** as a *reminder to the leader*; the inspector never performs it. May carry the releasability hint (§7.4) |
| 15 | `target` | const | ✅ | `"leader"` — the only admissible value (§9, §11 hook H1) |
| 16 | `notify` | enum | ✅ | `digest` (routine) \| `immediate` (tier promotion to `escalate`) |
| 17 | `releasable` | boolean | ✅ | the *hint* — the card looks releasable (§7.4) |
| 18 | `releasable_basis` | enum \| null | ✅ | `deps_satisfied` \| `clarification_trail_after_block` \| `assignee_changed` \| null |
| 19 | `blocked_reason` | enum \| null | ✅ | the card's **current** `blocked_reason` (§7) — on **every** row, not only `blocked_clarification`; `null` **iff** the card carries none (never a row-specific substitute) |
| 20 | `confidence` | enum | ✅ | `high` (an exact origin field was read) \| `low` (the origin was derived/fallback — §6.2) |
| 21 | `mechanism` | enum | ✅ | `openclaw-cron` \| `loop-patrol` |
| 22 | `mechanism_host` | string | ✅ | opaque host/agent id of the observer (diagnostics only, never used for routing) |
| 23 | `first_seen` / `last_seen` | ISO-8601 UTC ms | **ledger** | maintained by the shared de-duplication ledger (§8.3) and therefore **never a field of the emitted tuple** (§4.1); read from the ledger entry of the `dedup_key`. Identical for both mechanisms *because* it is that ledger's record, never a per-mechanism re-derivation |
| 24 | `observed_by` | string[] | **ledger** | mechanisms that have *seen* this `dedup_key` — **ledger metadata, never a field of the emitted tuple** (§4.1), so a suppressed duplicate stays auditable in the ledger |
| 25 | `evidence` | object | ✅ | machine-checkable keys only (no line anchors, `R-ENG-1` #11): `{ status, status_changed_at, has_sessions, has_workspace, threshold_ref, open_predicate }` |

**The `Req.` column has two values.** `✅` = a field of the **emitted** tuple. **`ledger`** = a field of the **de-duplication ledger's** record (§4.1): it is part of the wait's machine record, but **not** published in `alerts[]`. Rows #23/#24 are the only two below that line; every other row is emitted.

**Emitted-tuple skeleton (`alerts[]` — exactly what a mechanism publishes)**

```json
{
  "alert_id": "T-20261014-022254-2#blocked_clarification#overdue",
  "dedup_key": "T-20261014-022254-2#blocked_clarification#overdue@2026-10-14T02:22:54.000Z",
  "card_id": "T-20261014-022254-2",
  "sla_row": "blocked_clarification",
  "sla_ref": "`R-SLA-1` <row name>",
  "severity": "overdue",
  "measure_start_kind": "blocked_at",
  "measure_start_at": "2026-10-14T02:22:54.000Z",
  "measure_start_source": "frontmatter",
  "elapsed_working_min": 0,
  "elapsed_basis": "working_hours",
  "threshold_min": 0,
  "due_at": "2026-10-14T04:22:54.000Z",
  "action": "<`R-SLA-1` action for this row, as a reminder to the leader>",
  "target": "leader",
  "notify": "digest",
  "releasable": false,
  "releasable_basis": null,
  "blocked_reason": "clarify",
  "confidence": "high",
  "mechanism": "openclaw-cron",
  "mechanism_host": "<opaque>",
  "evidence": {
    "status": "blocked",
    "status_changed_at": "2026-10-14T02:22:54.000Z",
    "has_sessions": true,
    "has_workspace": true,
    "threshold_ref": "`R-SLA-1` <row name> · Normal limit",
    "open_predicate": "open"
  }
}
```

**Ledger-entry skeleton (`record`, §8.3 — where #23/#24 live)**

```json
{
  "<dedup_key>": {
    "first_seen": "2026-10-14T02:22:54.000Z",
    "last_seen": "2026-10-14T02:22:54.000Z",
    "observed_by": ["openclaw-cron"],
    "card_id": "T-20261014-022254-2",
    "sla_row": "blocked_clarification",
    "severity": "overdue",
    "target": "leader"
  }
}
```

> The three **normative** names here are `first_seen` / `last_seen` / `observed_by` (§4.1); the accompanying identification keys are the current landing's (openclaw `sla-scan`) and are shown for concreteness. The ledger is also where the `superseded` low-tier records of §5.2 rule 4 live — which is the point: the **ledger** is the audit surface, `alerts[]` is the notification surface.

> **Why flat and mechanism-tagged**: two independent implementations read one `R-SLA-1` table, and a shared *shape* is what makes "same field ⇒ same semantics" checkable (Acceptance item 2) — a nested, mechanism-specific shape would let the two sides drift field by field.

### 4.1 #23/#24 are ledger metadata — not fields of the emitted tuple

**Adopted 2026-10-15 (closure of defect F1 of the independent verification).** Rows #23/#24 are declared `ledger`: `first_seen` / `last_seen` / `observed_by` are maintained by the de-duplication ledger (§8.3) and are **never published inside `alerts[]`**. The emitted tuple carries rows **#1–#22 and #25** (the landing adds its three card-draft aliases `kind`/`id`/`ageMin`, which are not §4 rows).

The declaration follows the implementation — and it *must*: a row marked `Req. ✅` invites an
implementation to "satisfy" #23/#24 by bolting the three fields onto the tuple, but the emitted
value could then only ever be `first_seen = last_seen = <emit instant>` and
`observed_by = [<this mechanism>]` — a mechanism-local number wearing a cross-mechanism label, a
false statement to every consumer (the peer mechanism, the leader's digest, any dashboard),
false under the backendless fallback where no shared ledger exists (§8.3 rule 5, §12 G-10 ⑧),
and unfillable on the emit path that re-derives alerts without ledger participation (§9.6).
#24's own justification — "so a **suppressed** duplicate is still auditable" — is servable only
in the ledger, since a suppressed duplicate is by definition the alert that is **not** emitted
(§8.3 rule 4: `observed_by` grows, nothing is notified).

**Consequence — what the contract now obliges.** Not silence, but two provable halves: the emitted tuple must **not** carry #23/#24, and the ledger entry `record` writes for that `dedup_key` **must** carry them. Both halves are machine-checked (§11 hook **H10**; the assertion lands in `team/scripts/tests/sla-scan.test.mjs`). If a shared ledger is ever landed (§12 G-10 ⑧ — owned by C4/Elon), promoting these rows back into the emitted tuple is a **contract change** and must be made for **both** mechanisms in the same step; a one-sided addition would break the shared shape while looking like a local fix.

---

## 5. `R-SLA-1`…`R-SLA-6` Row-by-Row Mapping

### 5.1 The mapping table

`T` = elapsed on the row's measurement basis · `L` = the row's `normalMin` in `guides/sla-thresholds.json` · `F` = the row's `furtherMin` there · `P` = the inspecting mechanism's own period · **no numeric SLA value is written here on purpose** (§2).

Rows are identified by **name, never by index or position** — `R-SLA-1`'s table order may drift; the `sla_row` enum value is the stable identifier and the rule row name (quoted) is the human anchor (`R-ENG-1` #11: no positional anchors). `L`/`F` in the table are per-row references to that row's `R-SLA-N` columns.

| `sla_row` (contract) | `R-SLA-1` row (quoted name) | Measurement origin (§6) | Trigger condition | Threshold (source) | Tier ladder (§5.2) | Action (reminder only) | Target |
|---|---|---|---|---|---|---|---|
| `blocked_clarification` | *blocked awaiting the leader's clarification* | `blocked_at` (`status_changed_at` fallback) | card is `blocked` **and** `blocked_at` present **and** the wait is open | `R-SLA-1` · same row · *Normal limit* (= `L`) / *Further timeout* (= `F`) | `warn`: `T ≥ L − P` · `overdue`: `T ≥ L` · `escalate`: `T ≥ F` | the row's action, restated as "the leader must clarify / revise / reassign"; plus the releasability hint (§7.4) | **leader** |
| `confirmation_gate` | *confirmation gate awaiting review* (`R-CONFIRM-1`) | `gate_at` (§6.3-A) | card carries an **unanswered** confirmation request (`R-CONFIRM-1`) | `R-SLA-2` · same row · *Normal limit* (= `L`) / *Further timeout* (= `F`) | `warn`: `T ≥ L − P` · `overdue`: `T ≥ L` · `escalate`: `T ≥ F` | the leader must review (`R-CONFIRM-1`); the reminder carries the confirmation-request evidence pointer | **leader** |
| `defect_card_creation` | *defect fix card creation* (`R-DEFECT-1`) | `trail_event` (§6.3-B) | a defect is recorded on a card (`R-DEFECT-1` step 1: defect ticket + card set `blocked`/`canceled`) **and** no fix card referencing it exists yet | `R-SLA-3` · same row · *Normal limit* (= `L`) / *Further timeout* (= `F`) | `warn`: `T ≥ L − P` · `overdue`: `T ≥ L` · `escalate`: `T ≥ F` | the leader must create the fix card and dispatch it to Linus (`R-DEFECT-1`) | **leader** |
| `acceptance_card_creation` | *product/UX acceptance queued* (`R-UI-1` tail) | `status_changed_at` (§6.3-C) | the card is **flow A** (`R-FLOW-1`; absent `flow` ⇒ treated as A, fail-safe) **and** its delivery is ready **and** no card with `review_of=<card>` exists | `R-SLA-4` · same row · *Normal limit* (= `L`) / *Further timeout* (= `F`) | `warn`: `T ≥ L − P` · `overdue`: `T ≥ L` · `escalate`: `T ≥ F` | the leader must create the review card and dispatch Jobs (`R-UI-1`) | **leader** |
| `heartbeat_stale` | *worker heartbeat stale* (`R-BOARD-1`) | `heartbeat_at` | card is `in_progress` **and** the heartbeat is stale (existing behaviour, preserved — §10.4) | `R-SLA-5` · same row · *Normal limit* (= `L`) / *Further timeout* (= `F`) | `warn`: `T ≥ L − P` · `overdue`: `T ≥ L` · `escalate`: `T ≥ F` | reminder that the same assignee may re-claim; at `escalate` the row's action is "any agent may claim + report" — **the inspector only notifies, it never claims** | **leader** |
| `leader_stalled` | *leader patrol stalled* | `trail_event` (§6.3-D) | **there is work pending on a leader action** (see below) **and** no leader action is observable on the board for longer than the row's bound | `R-SLA-6` · same row · *Normal limit* (= `L`); the further bound is the `R-SLA-7` stall bound (= `F`) | `warn`: `T ≥ L` (this row's limit is already a "no action for" bound — the `−P` lead is **not** applied; §5.2 rule 5) · `overdue`: not emitted · `escalate`: `T ≥ F` | the leader is reminded that its own patrol looks stalled; **the inspector does not use `R-SLA-7`** — that channel stays a worker's manual exception (§0) | **leader** |

**"Work pending on a leader action" (`leader_stalled`'s conditioning rule)** — the row is emitted **only** when a leader-owed item exists: a card in `in_review` awaiting acceptance; a card `blocked` whose wait is open; an unanswered confirmation request; a `defect_card_creation` / `acceptance_card_creation` wait that is open. **Rationale**: an idle board is *not* a stalled leader, and an unconditional `leader_stalled` trigger would break the zero-cost-idle rule (§9.4) every night.

### 5.2 The tier ladder (one definition, both mechanisms)

1. `warn` ⇔ `T ≥ L − P` (**clamped at 0**: if `P ≥ L` the boundary is `T ≥ 0`). Semantics = **到点提醒**: the `R-SLA-1` point will be crossed before the next inspection, so the leader is told *at* the point rather than after it. `warn` states **no breach of `R-SLA-1`**.
2. `overdue` ⇔ `T ≥ L`. Semantics = the `R-SLA-1` point is passed and the condition is still open — the `R-SLA-1` action is due and unmet.
3. `escalate` ⇔ `T ≥ F`, **only where `R-SLA-1` publishes a further-timeout bound for that row**. Its action is the `R-SLA-1` further-timeout action; its **target is still `leader`** (operator ruling ① — see gap G‑2).
4. **Highest tier wins, and only the highest *newly crossed* tier is emitted.** After a long outage the inspector may find a card past `escalate`; it then emits **one** entry at `escalate` and records the skipped lower tiers as `superseded` in the ledger (audit-visible, no notification) — this is the anti-storm rule (`R-OBS-1` clause 4's "deduplicated + suppressed" in shape; it does **not** import that clause's object).
5. **The `leader_stalled` row is exempt from rule 1's `−P` lead**: its published bound is already a *"no action for"* bound, and a `warn` one period earlier would fire on a normally busy leader whose board simply happened to be quiet for one period. It therefore has exactly two states: `warn` (at `L`) and `escalate` (at the `R-SLA-7` stall bound, `F`).
6. **The ladder is a formula over `L`, `F` and `P` only.** `P` is a *mechanism parameter* pinned by the operator's ruling ③, **not** a new SLA number; `L` and `F` come from `R-SLA-1` and nowhere else — the contract stays free of self-invented thresholds.

> **Decision fork DF-1 — decided.** Elon's `R-CONFIRM-1` dual-sign **adopted option A** (`warn = L − P`) on 2026-10-13T18:47Z (card); option B is rejected. `R-SLA-1` publishes **two** points per row while the epic asks for a **three**-tier ladder, so the `warn` boundary must come from somewhere. **Option A (adopted)**: `warn` = one *own period* before `L` (rule 1) — invents no SLA number, testable with a fixed clock, makes "到点提醒" literal. **Option B (rejected)**: `warn = L`, `overdue = F`, `escalate` = the leader-stalled row only — needs no lead, but `overdue`/`escalate` are then not comparable across rows (`heartbeat_stale` and `leader_stalled` publish different kinds of "further" point) and the two mechanisms would label a card by their *cadence*, not the card. Under option A the tier is a pure function of `(card state, own period)`, so the shared ledger (§8.3) makes the *emitted* label identical too.
>
> **As of v1.1 this contract is a downstream basis** — the dual-sign it was waiting for has landed (§12 G‑9).

### 5.3 Rows the contract adds (explicitly **not** in `R-SLA-1`)

| # | Row | Origin | Trigger | Threshold | Tiers | Action | Target |
|---|---|---|---|---|---|---|---|
| 7 | `inspector_liveness` | the peer mechanism's last-successful-run marker | the **peer** inspector has not completed a successful run within the derived liveness bound | **none from `R-SLA-1`** ⇒ `threshold_min: null`. The bound is **derived**: `peer_stale ⇔ now − peer.last_ok > k × P_peer` (a small integer `k`, a *mechanism parameter*) | `warn` only (§5.2 rule 3 cannot apply — no `F`) | tell the leader that one of the two inspectors is not running — the mutual watchdog that closes the epic's "巡检失联 zero coverage" gap | **leader** |

> **Discipline**: `inspector_liveness` exists because **zero coverage of an inspector's own death is a silent-green risk** (§9.3). It is written with an explicit `threshold_ref: null` and a derived bound **so that it invents no SLA value**; if the rule wants a published bound, that is a backfill item for Elon (gap G‑4).

---

## 6. Measurement Origins (`T` counts from here)

### 6.1 Origin vocabulary

| `measure_start_kind` | Read from | Used by |
|---|---|---|
| `blocked_at` | card frontmatter (`R-BOARD-1`; written by `task.setStatus` when entering `blocked`) | `blocked_clarification` |
| `status_changed_at` | card frontmatter (`R-BOARD-1`; maintained by `task.setStatus`) | `acceptance_card_creation`; `blocked_clarification`'s fallback |
| `heartbeat_at` | card frontmatter | `heartbeat_stale` |
| `gate_at` | *derived* — see §6.3-A | `confirmation_gate` |
| `trail_event` | the **process trail** (`## Comments` / `## Progress`) — earliest matching entry | rows 3 and 6 |
| `created_at` | card frontmatter (`R-BOARD-1`; a card **created** by the leader) | `leader_stalled` (§6.3‑D) |
| `unverifiable` | nothing readable | any row — **fail-safe**, see §6.5 |

### 6.2 Derivation discipline

- **Prefer an exact frontmatter field.** If one exists, `confidence: "high"`.
- **Otherwise derive, and say so.** Every derived or fallback origin sets `confidence: "low"` and `measure_start_source` to where it was read. A derived origin must be **deterministic** (same board ⇒ same origin, both mechanisms) and **monotone-safe** — when in doubt, choose the **earlier** candidate: the fail-safe direction of an inspector is *over-alert*, never *silent miss* (§9.3).
- **Never re-derive per mechanism.** The derivation lives in one place per implementation and is exercised by the shared fixtures of §11.
- **Confidence value rule (pinned).** `confidence: "high"` ⇔ the origin instant was **read verbatim** from a single, unambiguous source (a frontmatter field, or one uniquely-identified trail entry). `confidence: "low"` ⇔ the origin came from a **fallback** (§6.3‑A step 3), an **approximate / pattern match**, or **no readable candidate** (§6.5). Choosing deterministically among several *exact* candidates (§6.3‑B "earliest of", §6.3‑D "latest of") does **not** by itself lower confidence — each candidate is exact and the choice is reproducible.

### 6.3 Row-specific derivations

**A — `confirmation_gate`: `gate_at` (a confirmation-gate start).** `R-CONFIRM-1` records the request in the card's `## Progress`, and the gate's limit is a *wait for the leader's review*, so the wait starts at the **request**, not at the card's last status change. Priority: (1) an explicit gate-start field, if the provider ever carries one (absent today); (2) else the timestamp of the **latest** confirmation-request entry in `## Progress` / `## Comments` — the `R-CONFIRM-1` landing is asked to append such a request as a Progress line carrying a stable marker (`[confirm-request]`); until that marker is standard a detector may match the existing "send back to the leader with plan/doc path + key decisions + open items" shape; (3) else **fallback** to `status_changed_at` with `confidence: "low"` — which can only make the gate look **older**, i.e. only **over-alert**, the admissible direction. The *open* predicate: **no later leader confirmation** in the trail.

**B — `defect_card_creation` (defect fix card creation).** Origin = the **earliest** of the card's `status_changed_at` at its `R-DEFECT-1` step-1 entry into `blocked`/`canceled`, and the timestamp of the earliest `kind=defect` trail entry (the defect ticket lives in the untimestamped Report ⇒ the trail is the observable). *Open* predicate: **no card references this card as its fix card** — detected by the `category:bug` label convention of `guides/task-interface.md` §15 plus a reference back to the origin card; if it cannot be decided, treat it as **open** with `confidence: "low"` (fail-safe). **Confidence**: an exact timestamp (the frontmatter `status_changed_at`, or one `kind=defect` trail entry) ⇒ `high`; only the undecidable-predicate path (open) ⇒ `low`.

**C — `acceptance_card_creation` (product/UX acceptance queued).** Applicable **only to flow A** (`R-FLOW-1`; absent `flow` ⇒ A, fail-safe). Origin = `status_changed_at` of the delivered card (its entry into the delivery/`in_review` state per `R-BOARD-1`). *Open* predicate: **no card with `review_of = <this card>`** exists yet, and Jobs is its assignee when one does (`R-UI-1` clause 3: the leader creates it).

**D — `leader_stalled`.** `R-SLA-1` measures "no action", observable only through the board, so the inspector takes the **latest board-side timestamp on a leader-attributed event**, where *leader-attributed* is **one** of: (a) a `kind ∈ {confirm, decision, change}` comment whose `author` is the leader; (b) a card **created** by the leader (`created_at`, §6.1); (c) a card whose `status_changed_at` moved through a leader-only transition (`done` is leader-only per `guides/task-interface.md` §4). **The filter is on `author`, not `kind`** — a `kind=change` entry by a *worker* does **not** reset the stall clock; one by the *leader* does. **This attribution set is the single set both mechanisms must use** (F2); no mechanism may add or drop a member. The *open* predicate is the conditioning rule of §5.1.
With no leader event at all within the lookback window, the row is still emitted with `confidence: "low"` — an inspector that has never seen the leader act must say so rather than stay quiet. **Confidence**: an exact leader-event timestamp ⇒ `high`; a lookback window with **no** leader event ⇒ `low`.

### 6.4 Measurement basis — working hours (the "到点" question, answered)

- **Basis = working hours, accumulated** — `R-SLA-1` states its limits are governed by the daily working window (Asia/Shanghai) with off-hours **rolled over**, i.e. the clock *stops* outside the window. So `T` is **not** wall-clock elapsed: the inspector accumulates only time inside the window.
- **`elapsed_basis` is therefore `working_hours` for every row of §5.1.** `wall_clock` exists in the vocabulary only so that a future row may opt out explicitly; no row does today, and no implementation may silently choose it.
- **The window is a fixed civil window in Asia/Shanghai regardless of the observer host's timezone.** An observer on a host in another zone must convert into Asia/Shanghai, not use its own local day. Asia/Shanghai has no daylight-saving transitions, so the window has no DST edge — but the *conversion* is still required and is a hook (§11 H5).
- **`due_at` is display only** (§4 #13). The verdict is `elapsed_working_min ≥ threshold_min`; the projection must never be the thing that decides green.

### 6.5 Fail-safe on an unreadable / missing origin

- If no origin can be derived, emit the alert with `measure_start_kind: "unverifiable"`, `threshold_min: null`, `severity: "warn"`, `confidence: "low"` and an action that says "verify this card's timestamps". **An unreadable card is never green** — this mirrors the existing stale-scan behaviour for an unparseable heartbeat, which also alerts rather than stays quiet.
- If the **trigger's own inputs** are unavailable (board unreadable, provider ACL missing, snapshot unreadable), the inspector's *envelope* must fail closed, not open — see §10.3.

---

## 7. `blocked_reason` — Structural Card Field

### 7.1 Why a structural field (operator ruling ④)

The `R-SLA-1` row *blocked awaiting the leader's clarification* is *one* row, but a card can be blocked for reasons that are **not** a clarification request; without a machine-readable reason an inspector cannot tell "the leader owes an answer" from "waiting on a predecessor", and the releasability hint (§7.4) cannot be computed. The operator's ruling: a **structural field in one step**, not a free-text convention.

### 7.2 Field definition

| Aspect | Definition |
|---|---|
| **Name / carrier** | `blocked_reason` — a **known card key** of the provider (a card frontmatter field, `guides/task-interface.md` §2), beside the existing `blocked_at` (`R-BOARD-1`) |
| **Type** | single-value **enum string** (never a list, never free text) |
| **Enum** | `clarify` — the card awaits the leader's clarification of an ambiguous requirement (`R-AMBIG-1`) · `decision` — awaits a decision fork / gate sign-off (`R-DISC-5`) · `dependency` — awaits a predecessor card or upstream artifact (`depends_on` unmet) · `out_of_bounds` — raised back because the card is outside the worker's duties (`R-OOB-1`) · `defect` — awaits the defect loop (`R-DEFECT-1`) · `external` — awaits something outside the team (a third-party service, an operator input, a host resource) · `resource` — awaits capacity (host/model/concurrency limits) · `unknown` — present but unclassified |
| **Semantics** | **who/what the block is waiting for** — *not* a severity, *not* a free-text explanation. The human-readable explanation stays in the comment trail (`kind=change` / `note`), which is where prose belongs; the field carries only the class, so it stays greppable and machine-checkable |
| **Write timing** | Written **atomically inside the same `task.setStatus` write that enters `blocked`** (`guides/task-interface.md` §4 already records `blocked_at` there). One write point ⇒ `status`, `blocked_at` and `blocked_reason` can never disagree. Writers: the **worker** when it raises an ambiguity or an out-of-bounds hand-back (`R-AMBIG-1`), and the **leader** when it returns a card to `blocked` (e.g. a failed acceptance, `R-BOARD-1`). **The inspectors never write it** (§9.1) |
| **Cleared when** | Leaving `blocked` clears it in the same write (the field describes the *current* block). History is not lost — it is in the trail |
| **Validation** | The write point validates against the enum. A **supplied-but-invalid** value is a caller bug ⇒ refuse with `ok:false` and a stable reason (`bad_blocked_reason`), and write nothing. **Omitting** the field is always legal (see 7.3) |
| **Relation to `blocked_at`** | **Same write, no coupling to timing.** `blocked_at` remains the *only* origin for `blocked_clarification`'s `T`; `blocked_reason` never changes a threshold (single source = `sla-thresholds.json`, §2). Its only job is to *select which semantics apply* — see 7.4 |

### 7.3 Default and compatibility (byte stability)

1. **Absent by default.** A card never carries the key unless it is `blocked` with a reason. `blocked_reason` is **not** written when empty (no `""`, no `unknown` filler) — so **every existing card stays byte-identical**, and the provider's round-trip stays byte-stable (the C3/C6 acceptance items).
2. **Absent is not an error.** An inspector reading a `blocked` card with no `blocked_reason` behaves exactly as it does for `clarify` (`sla_row: blocked_clarification`) with `blocked_reason: null` — the ruling's "缺省/兼容口径": *absence preserves today's semantics*, it never silences the alert.
3. **Unknown values round-trip.** A value written by a **newer** provider version must be preserved verbatim on read/write (the provider's unknown-key rule, `guides/task-interface.md` §2 / `R-BOARD-1`) and treated by an older inspector as `unknown`. An unrecognised *known-key* value must **never** be re-written as `unknown` by an older writer — that would destroy a newer writer's data.
4. **No bulk migration.** Legacy `blocked` cards keep an absent field. Nothing is back-filled — a bulk write over historical cards would violate byte stability and the provider's append-only habits, and buys nothing, because §7.3 item 2 already gives the right behaviour.

### 7.4 `blocked_reason` → `R-SLA-1` row mapping (and the honest gap)

| `blocked_reason` | `R-SLA-1` row applied | Note |
|---|---|---|
| `clarify`, `decision`, `out_of_bounds`, `defect`, `unknown`, `null` (absent) | `blocked_clarification` | these all resolve to a **leader action** — the row's object matches |
| `dependency`, `external`, `resource` | **none — `R-SLA-1` publishes no row for these** ⇒ the alert is emitted with `sla_row: blocked_clarification`, `threshold_min: null`, `severity: "warn"` (§5.3 discipline: **visibility without a due point**) | **Gap G‑3**: a card blocked on a predecessor/external is currently *invisible* to both mechanisms, and the contract must not invent a limit for it. Visibility-only + a rule backfill proposal is the honest resolution |

**The releasability hint (`releasable` / `releasable_basis`)** — *hint only, never an action* (ruling ②, `R-AMBIG-1`: only the leader returns a blocked card):

| basis | Condition (machine-checkable) |
|---|---|
| `deps_satisfied` | `blocked_reason = dependency` **and** every `depends_on` entry is in a terminal state |
| `clarification_trail_after_block` | `blocked_reason ∈ {clarify, decision}` **and** a newer `kind=change` / `kind=confirm` trail entry exists after `blocked_at` |
| `assignee_changed` | `blocked_reason = out_of_bounds` **and** a newer `kind=change` trail entry records the reassignment after `blocked_at` (**evidence channel** = the `§7` substantive-change trail; the board snapshot carries only the *current* `assignee`, so the trail is the only machine-readable change channel) |
| `null` | nothing establishes releasability ⇒ `releasable: false`. **The alert is still emitted** — an unknown must not become silence |

> **Evidence channel (F7).** Both trail-based bases (`clarification_trail_after_block`, `assignee_changed`) read the **same** channel — the `kind=change` / `kind=confirm` entries of the card trail; a pre-emit snapshot alone is never sufficient, because it carries no change history.

---

## 8. Cross-Mechanism Alignment

### 8.1 What "semantic equivalence" means here (and what it cannot mean)

Two inspectors with **different periods** can never be bit-identical at every instant, and that is not the requirement. Equivalence is asserted over **predicates**, not over wall-clock instants:

| # | Equivalence clause | Checkable by |
|---|---|---|
| E1 | **Same input surface**: card frontmatter + the `## Comments` / `## Progress` trail, read through the ACL; no private state may be required to *decide* a verdict | same fixtures ⇒ same `alerts[]` |
| E2 | **Same row set**: every row of §5.1, plus `inspector_liveness` (§5.3) | coverage diff |
| E3 | **Same origins and same derivations** (§6), including the fail-safe fallbacks | same fixture card ⇒ same `measure_start_at` |
| E4 | **Same tier boundaries** — the formulas of §5.2, over `L`/`F` from `R-SLA-1` and the mechanism's own `P` | tier diff at a fixed clock |
| E5 | **Same target, same notify-only discipline** (`target: "leader"`, §9) | `target` is a constant (§11 H1) |
| E6 | **Same de-duplication key and ledger semantics** (§8.3) | shared-key fixture |
| E7 | **Same fail-safe direction**: over-alert > silent miss; unreadable ⇒ not green (§9.3) | injected-fault fixtures |

**The only permitted difference is `P` ⇒ a tier's observation latency is bounded by the observer's own period.** Equivalence is therefore: *given the same board state at the same instant, both mechanisms must compute the same `sla_row`, `measure_start_at`, `threshold_min`, **verdict predicate** and `target`; they may differ only in whether they have already observed the crossing.* A test demanding byte-identical output from two different periods tests the wrong thing.

### 8.2 Why a shared ledger is needed at all

Both mechanisms drive **one** board, and the accepted delivery channel is the **leader's gateway**, so without a shared substrate a single wait crossing a tier would be notified **twice** (once per mechanism) — the "不重复告警" half of the Acceptance. The mechanisms may run on **different hosts**, so a shared *file* cannot be assumed; the only channel both are guaranteed to share is **the card itself, through the provider ACL**.

### 8.3 De-duplication (the AlertLedger interface)

Define one tiny interface — the **same semantics, either backend**:

```
seen(dedup_key) -> { known: bool, first_seen, last_seen, observed_by[] }
record(dedup_key, meta)      // idempotent
```

| Backend | Where state lives | Guarantee |
|---|---|---|
| **(a) card-trail marker — default** | an **append-only trail entry** on the card itself, carrying a single machine-stable line (e.g. `[sla-alert] key=<dedup_key> tier=<severity> at=<ts> by=<mechanism>`) in `kind=note` | works when the two mechanisms share no filesystem; survives restarts on either host |
| **(b) shared ledger file — only if co-resident** | a single file under the team root (host-local, excluded from the drift patrol) | cheaper, but admissible **only** when both mechanisms provably run on the same host |

**Rules**
1. **Key** = `dedup_key` (§4 #2) = `<card>#<row>#<tier>@<origin>`. Three deliberate properties: the **row** separates distinct waits on one card; the **tier** means a promotion is a new key (an escalation is **never** de-duplicated away); the **origin** means a *new* wait on the same card/row/tier re-notifies (a re-blocked card is a new wait, not a duplicate).
2. **Notify, then record.** The marker is written **after** a successful emit. If recording fails, the next tick re-notifies — a duplicate is the admissible failure; a *lost* alert is not.
3. **Unreadable ledger ⇒ notify anyway** (never suppress on a failed read).
4. **`observed_by` grows even for suppressed duplicates**, so a suppressed second observation stays auditable (`R-OBS-1` clause 4's audit spirit; different object). **Where these three fields live**: in the ledger entry, **not** in the emitted tuple — `first_seen` / `last_seen` / `observed_by` are §4 **`ledger`** rows (#23/#24) and are never published in `alerts[]` (§4.1, hook H10).
5. **Trail-write budget**: the marker is written **only on a newly crossed tier**, i.e. at most a handful of trail entries per wait per card — not one per tick. If a project judges any card-trail write unacceptable, the fallback is **backendless de-duplication**: each mechanism de-duplicates only *within itself*, and the cross-mechanism residual is **at most one duplicate notification per key**. That fallback must be recorded as a deliberate deviation, not discovered as a defect.
6. **Dropped, never silently.** Every candidate the pre-emit re-check drops (§10.2) must appear in `dropped` with a reason — the existing patrol's "绝不静默丢弃" discipline, reused.

### 8.4 Mutual liveness (`inspector_liveness`)

Each mechanism publishes a last-successful-run marker and **watches the peer's**. If the peer's marker is older than the derived bound of §5.3, the watcher emits `inspector_liveness` at `warn`: *one inspector is not running, so one half of this contract is currently unverified*. This is the only defence against the failure mode this team has been bitten by before — **a silent inspector reads exactly like a healthy board**.

---

## 9. Safe-Operation Envelope

### 9.1 Read-only guarantee (the "不自动放行" boundary, stated mechanically)

The inspector's capability set is: **read the board through the ACL**, **write its own ledger marker** (§8.3 — a trail note, never card state), **send one message to the leader**. It holds **no** capability to change a card's `status`, `assignee`, `claimed_by`, `heartbeat_at`, `blocked_at`, `depends_on` or any other field, and it calls **no** state-changing ACL command.

**Explicitly "notify only" (never automated)** — each one is a `R-SLA-1` action or a `R-AMBIG-1` leader action:

| Action | Owner per rule |
|---|---|
| `blocked → todo` (releasing a blocked card; the releasability *hint* only points at it) | leader (`R-AMBIG-1`: the leader is the sole operator who returns blocked cards) |
| re-claiming a stale card (`R-BOARD-1` stale recovery) | the same assignee (or, past the further bound, any agent — a worker action, not the inspector's) |
| clarifying / revising / reassigning a blocked card | leader (`R-SLA-1`, the blocked-awaiting-clarification row) |
| reviewing a confirmation gate | leader (`R-CONFIRM-1`) |
| creating and dispatching the defect fix card | leader (`R-DEFECT-1` step 2) |
| creating and dispatching the product acceptance card | leader (`R-UI-1`) |
| escalating to the operator | **nobody via this contract** — ruling ①; the `R-SLA-7` channel stays a worker's manual exception |
| creating any card, dispatching any role | leader (`R-TRIAGE-1`: the sole dispatcher) |

### 9.2 Do what the epic's principle says — and no more

巡检只做 **可见性 / 到点提醒 / 可释放性提示**. Translated into this contract: `severity` + `action` + `releasable` (§4) are the whole output surface. There is no fourth kind of output.

### 9.3 Fail-safe (不假绿)

| Situation | Required behaviour |
|---|---|
| origin missing / unparseable | emit at `warn` with `measure_start_kind: "unverifiable"` (§6.5) — **alert, do not stay quiet** |
| the open/closed predicate cannot be decided | treat the wait as **open**, `confidence: "low"` |
| the ledger is unreadable | notify anyway (§8.3 rule 3) |
| the pre-emit re-check throws, or returns a malformed envelope | **keep the original candidates and alert** — the existing patrol's fail-safe, reused verbatim in spirit; the check must never be able to silence a real alert by failing |
| the inspector's own evaluation degrades (timeout, provider missing, unparseable output) | **fail closed**: the envelope must read as *unconfirmed ⇒ alarm*, never as "nothing to report" (§10.3) |
| the peer inspector is silent | `inspector_liveness` (§8.4) |

### 9.4 Zero-cost idle

When nothing crosses a tier, the inspector produces **no alert entry** and does not wake a model turn. "Idle" includes: no card in a qualifying live state; a wait that is inside its `warn` lead; and a **quiet board with no leader-owed work** (the row-6 conditioning rule, §5.1). Tier-crossing alerts are batched into **one** envelope per inspection, so N simultaneous breaches cost one wake, not N.

### 9.5 Working hours

Per §6.4: Asia/Shanghai 09:00–23:00, off-hours rolled over, applied identically by both mechanisms. Two easy-to-miss consequences: (a) an alert may legitimately fire *outside* the window (the inspector runs whenever it runs — the *limit*, not the inspection, rolls over); (b) a wait can never expire while its clock is stopped, so a card blocked at the end of a working day cannot be "overdue" during the off-hours.

### 9.6 Re-check before emit

Both mechanisms must perform a **live second look at the card immediately before emitting** (the existing `patrol.mjs` scan + in-process re-check idiom): generate candidates → re-read each candidate's live state → drop those that no longer qualify (they go to `dropped`) → emit the survivors. The decision rule for "still qualifying" must be **one shared function per implementation**, used by both the scan and the re-check, so the two can never drift apart (again: the existing idiom, not a new invention).

---

## 10. Machine Envelope and Wiring Duties

> **Duties, not implementation.** This section fixes what C2/C4 must satisfy; how they satisfy it is their cards' business.

### 10.1 Envelope

```
{ "fire": <bool>, "alerts": [ <tuple>, … ], "dropped": [ … ], "state": { … } }
```
- `fire` is an **explicit boolean** (the dispatcher's canonical form). `alerts` must **not** be published under the legacy `stale` key — that key belongs to the heartbeat patrol's existing consumer contract, and overloading it would silently change that job's meaning (`Array.isArray(stale) ⇒ fire = stale.length > 0`).
- `state` carries at least `{ job, mechanism, cadence_period, working_window, counts }` for diagnostics.
- **Exit code 0 on every normal outcome, including "no alerts".** A non-zero exit is reserved for a genuine inspector failure, so that "no alerts" can never be read as a failure and a failure can never be read as "no alerts".

### 10.2 Degrade policy — this inspector **fails closed**

The framework's dispatcher classifies a job by *what its degrade must say*: wake-sources degrade to `fire:false`; **gates and detectors degrade to `fire:true`** (an unconfirmed check must alarm, never read green). The SLA inspector is a **detector with an alarm obligation**, so:
- evaluation timeout ⇒ `fire:true` with a degrade reason, **not** `fire:false`;
- provider/ACL unavailable ⇒ `fire:true` with the cause in the state;
- unparseable output ⇒ `fire:true`.

**Wiring duty (C2)**: classify the new job as fail-closed in the dispatcher's degrade policy — a detector that inherits the poll/patrol default would silently report green on exactly the failure this contract exists to prevent. **Verification duty (C5)**: inject each degrade and assert `fire:true`.

### 10.3 Budget

The inspector must fit the scheduled trigger's evaluation budget. Card reads (frontmatter + trail) are cheap; anything needing a provider round-trip (a candidate query, a registry lookup) must be kept **out of the in-band verdict path** or reduced to a cached/one-shot read. The cross-mechanism ledger read (§8.3) must degrade to "notify anyway" rather than stretch the budget (§9.3).

### 10.4 No regression on the existing heartbeat patrol

The existing heartbeat behaviour (`in_progress` + stale heartbeat ⇒ alert, with its `stale_kind` / reason vocabulary and its `{stale:[…]}` envelope) is a **published contract** consumed by the current job and by its pre-emit re-check. The new coverage must be **additive**: either a new job/entry alongside it, or a strictly superset entry that still honours the old envelope for the old consumer. Folding the old job into the new one is a **separate, later card** — never a side effect of this contract.
**SLA channel note (F4).** The legacy alert stays as the old consumer's envelope, but for `heartbeat_stale` to participate in the shared §4 tuple / ledger (§8.3), each mechanism **must also emit the §4 tuple** for that row; the legacy `type:"stale"` shape is **not** a substitute for the SLA channel.

---

## 11. Verification Hooks (what C5 / C6 /  must be able to check)

| Hook | Assertion | Why it can fail |
|---|---|---|
| **H1** | `target` is `"leader"` for **every** emitted alert, in every fixture, and no code path names the operator | ruling ① is a one-line invariant that is easy to break in a branch |
| **H2** | For a fixture card at each `R-SLA-1` row, the emitted `sla_row` / `measure_start_at` / `threshold_min` / `severity` are **identical** for both mechanisms at a fixed clock | the two implementations read the same `R-SLA-1` but were written separately |
| **H3** | A tier promotion emits a **new** alert while a repeated observation of the same tier emits **none** (ledger) | the de-duplication key is the whole "不重复告警" property |
| **H4** | Injected faults (unparseable heartbeat, missing origin, unreadable ledger, re-check throwing) all **alarm**; none of them yields a silently clean envelope | fail-safe is only real if it is exercised |
| **H5** | Working-hours accumulation: a wait spanning the off-hours window is not "overdue" during it; a host in another timezone yields the same `elapsed_working_min` | the window is a *civil* window in a fixed zone, not the host's |
| **H6** | The implementation's runtime threshold table references `guides/sla-thresholds.json` per value and matches it (drift check) | the "single source of truth" decays the first time `sla-thresholds.json` is edited |
| **H7** | An absent `blocked_reason` behaves as `clarify`; an unknown enum value round-trips unmodified; a card without the field is byte-identical after a read/write cycle | C3/C6's byte-stability items |
| **H8** | An idle board produces `fire:false` and writes no trail entry | zero-cost idle is a hard requirement, not a nicety |
| **H9** | Degrades produce `fire:true` (§10.2) | the failure mode this repo has already been bitten by |
| **H10** | `first_seen` / `last_seen` / `observed_by` are **absent from every emitted `alerts[]` entry** and **present in the ledger entry** `record` writes for that `dedup_key` (§4.1) | a row marked `Req. ✅` invites an implementation to satisfy it by bolting the three fields onto the tuple, which would assert the cross-mechanism invariant of §4 #23 that the backendless fallback (§8.3 rule 5) cannot provide |

---

## 12. Open Items, Gaps and Backfill Proposals

> Everything below is **for Elon's `R-CONFIRM-1` dual-sign or an rule backfill (`R-DOCSYNC-1`)**. None of it blocks C2/C3/C4 from starting on the contract as written; each item states the *adopted* behaviour so an implementation is never left waiting.

| # | Item | Adopted behaviour until decided |
|---|---|---|
| **G-1** | **rule pointer**: `R-SLA-1` has no "Method: `guides/…`" pointer to this contract (unlike `R-OBS-1`). Adding one is a rule edit (`R-STRUCT-1`) ⇒ Elon's. | this contract is reachable by name from the cards; the pointer is proposed, not assumed |
| **G-2** | **`R-SLA-1`'s further-timeout column reads "escalate to operator"**, which the operator's ruling ① supersedes (all tiers → leader). | **the inspector never emits an operator target** (ruling ① wins); whether the rule's wording is re-worded is a backfill for Elon. Consequence: the `escalate` tier's *target* is unchanged but its *meaning* narrows to "louder, immediate reminder to the leader" |
| **G-3** | **`R-SLA-1` has no row for a card blocked on a dependency / an external / a resource** — invisible to both mechanisms today. | visibility-only alert (`threshold_min: null`, `warn`) + this backfill proposal (a row, if Elon wants a limit) |
| **G-4** | **No `R-SLA-1` row for the inspectors' own liveness.** | `inspector_liveness` with a **derived** bound (`k × P_peer`) — no invented SLA number |
| **G-5** | **`R-CONFIRM-1`'s confirmation request has no stable machine marker** (§6.3-A priority 2). | derive from the request shape, then fall back to `status_changed_at` with `confidence: "low"` (over-alerts only); a `[confirm-request]` Progress marker is proposed as the `R-CONFIRM-1` landing. **Status**: **landed 2026-10-14** — the `[confirm-request]` Progress marker is now a normative convention (`R-CONFIRM-1` "Machine marker"); §6.3-A priority 2 reads the marker first and keeps the request-shape + `status_changed_at` (`confidence: "low"`, over-alerts only) fallback when it is absent |
| **G-6** | **Cadence mismatch.** The operator's ruling ③ says the openclaw side keeps "cron ~30 min", but the framework's declared cadence for its existing patrol job is *not* 30 min (the repo declaration and the live store also differ from each other — see `team/AUTOMATIONS.md` §"Job Overview", the cadence caveat). | the contract is written **cadence-agnostic** (all formulas use the mechanism's own `P`), so no implementation depends on the number; the ruling's "~30 min" should be reconciled with the declared/live values on the card that wires the trigger (**C2**), and the reconciliation recorded |
| **G-7** | **Trail writes for de-duplication** (§8.3 backend (a)) — a purist reading of "巡检不写" may object. | default backend is the card-trail marker with a bounded budget; the backendless fallback and its residual duplicate are documented, so the choice is explicit rather than accidental (Elon may pick backend (b) if both mechanisms are ever co-resident) |
| **G-8** | **`blocked_reason` as a provider known key** (C3) vs. a team-side convention field. | specified as a **provider known key** (ruling ④ "一步到位立结构字段"); the enum lives here, the serialization/round-trip rules live in the provider contract (`guides/task-interface.md`) |
| **G-9** | **Who signs the tier ladder (DF-1).** | **signed** — Elon's `R-CONFIRM-1` dual-sign adopted **option A** (`warn = L − P`) on 2026-10-13T18:47Z (card); the contract **is** a downstream basis as of v1.1 |
| **G-10** | **Recorded cross-mechanism deviations pending sync** (from design confirmation **no threshold affected**), each with an owner. | ① `leader_stalled` attribution set — C4 (§6.3‑D); ② `heartbeat_stale` channel asymmetry — C4 (§4 tuple / §10.4); ③ `confidence` for `defect_card_creation` / `leader_stalled` — C4 (§6.2 / §6.3‑B/D); ④ `releasable_basis: assignee_changed` channel — C4 (§7.4); ⑤ C2 wrote a *kind* value into `measure_start_source` — C2 (§4 #9); ⑥ C2 dropped the pre-lookback `leader_stalled` origin — C2 (§6.3‑D); ⑦ C2 emitted `blocked_reason: null` on non-`blocked_clarification` rows — C2 (§4 #19); ⑧ §8.3 backend (a) is implemented by **neither** mechanism ⇒ both use the rule‑5 **backendless** fallback (residual ≤ 1 duplicate per key). Until ①–⑦ land, the two mechanisms are **not** yet at `§8.1` E1–E7 equivalence. ⑨ **§4 #23/#24** were declared `Req. ✅` while neither mechanism could fill them (defect F1 of) — **closed 2026-10-15** by declaring them **ledger metadata** (§4.1) and pinning both halves with hook H10 (card); no threshold and no emitted field changed. |

---

## 13. Change Log

- **v1** (jobs, design-only) — initial contract (object declaration · alert tuple · six-row `R-SLA-1` mapping + tier ladder (DF-1) · measurement origins incl. `gate_at` · `blocked_reason` structural field · cross-mechanism equivalence + AlertLedger de-duplication + mutual liveness · safe-operation envelope · envelope + fail-closed degrade duty · verification hooks · open items).
- **v1.1** (jobs) — post-design-confirmation write-back ( findings F1–F12): DF-1 / G‑9 dual-sign recorded (option A) · `measure_start_kind` gains `created_at`; `measure_start_source` re-affirmed as **read-location only** · §6.2 / §6.3‑B/D confidence pinned + `leader_stalled` attribution set (**`author=leader` filter**, F2) · §7.4 `assignee_changed` evidence channel (F7) · §10.4 heartbeat SLA-channel note (F4) · §12 **G‑10** added. **No threshold changed** (single source remains `sla-thresholds.json`).
- **v1.2** (linus, declaration + test) — §4 declaration fix (defect F1 of): `first_seen` / `last_seen` / `observed_by` are **ledger metadata, never fields of the emitted tuple** — §4.1 added, the `Req.` column gains the `ledger` value, the skeleton split into **emitted tuple** vs **ledger entry**, §8.3 rule 4 cross-references §4.1, hook **H10** added, §12 G‑10 ⑨ registers the closure. **No emitted field changed, no threshold changed**; only the tuple's *description* now matches its shape. *(append change rows over time.)*

---

## 14. Worker → operator exception channel (`R-SLA-7`)

> This is the **only** worker-to-operator path; it is an exception channel, not a dispatch path.

1. **Trigger** — a worker has waited beyond the `leader_stalled` further bound (`furtherMin` in `guides/sla-thresholds.json`, currently 6h) for Elon/leader action on a blocked/decision item, or its card is stalled because the leader is unreachable.
2. **Action** — the worker sends one **direct exception report** to the operator (`message` tool), marked `[exception direct report]`, with the card id, the blocker, the elapsed wait and the requested decision.
3. **Trail** — record the same fact on the card as a `task.comment kind=note` (or `kind=change` if it alters the card); the operator's answer is trailed `author=operator`.
4. **Scope** — this does **not** let workers dispatch each other or create cards; Elon remains the card creator/dispatcher. The channel exists so a leader stall cannot deadlock the team.

## See Also

- `R-SLA-1` — **all thresholds**; `R-SLA-7` — the worker→operator channel this contract deliberately does not use.
- `R-BOARD-1` — board schema, state machine, heartbeat, stale recovery; `R-AMBIG-1` — ambiguity handling (blocked / return); `R-DEFECT-1` + `R-UI-1` — the defect and acceptance card loops; `R-FLOW-1` — flow A/B/C (`acceptance_card_creation`'s applicability); `R-CONFIRM-1` — the confirmation gate; `R-LAYER-1` — layering and the reference-not-copy rule; `R-OBS-1` clause 4 — an alert must be executable (shape only, different object); `R-GATE-1` — where a machine check of this contract would land.
- `guides/task-interface.md` — the ACL: §2 data model, §4 `task.setStatus`, §11 serialization invariants, §15 label taxonomy (`category:bug` is `defect_card_creation`'s fix-card marker).
- `guides/performance-sla-sop.md` · `guides/runtime-observability-sop.md` · `guides/incident-response-sop.md` — neighbouring objects, not substitutes.
