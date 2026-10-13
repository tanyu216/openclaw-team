# Task-Management Interface Contract (`task-interface v1`)

> **Ownership**: the task-management **base** (an independent layer). Normative text = `PROTOCOL §①`; this file is **the base's sole access contract to the upper layers** (= the **task-provider ACL**).
> **Purpose**: the upper layers (collaboration / roles / SOP / redlines) **depend only on this contract, not on the underlying implementation** ⇒ when swapping the task system, **the upper layers change zero** (only swap the provider implementation + run the contract tests).
> **Provider**: **not mandatory, swappable**. `meerkat-taskpanel` is the **reference implementation** (task skill + `taskctl` CLI); any system satisfying this contract works (Jira / Linear / Plane / GitHub Issues / custom …).
> **Scope**: this project delivers only this ACL and the team-side adaptation conventions; **each task system's own skill / MCP / authentication is user-supplied and out of this project's scope**.
> **Version**: `v1`; changes go through a separate card + dual-signing, with the version number recorded in §13.

---

## 1. Layering and Access Point
- **Provider (replaceable)**: reference implementation = the external project **meerkat-taskpanel** (task skill + `taskctl` CLI); card content persistence + session registry + trigger evaluation. Other systems (Jira/Linear/Plane…) integrate through the same ACL.
- **Sole access point**: meerkat-taskpanel's task interface (`taskctl` / the task skill) — it exposes only the following **commands/events/data** externally.
- **Constraint**: the upper layers **must not** directly read/write card files or bypass the interface; **everything goes through that access point** (command names in §4).

## 2. Data Model (ACL minimal required set)

> **The canonical card schema lives in the product, not here.** Every frontmatter key's meaning and values, the body-section shapes, the status machine and the import→export round-trip rules are owned by the reference provider: **`skills/meerkat-taskpanel/references/card-schema.md`** (in the `meerkat-taskpanel` checkout; installed as the skill `meerkat-taskpanel` ⇒ `$OPENCLAW_HOME/skills/meerkat-taskpanel/references/card-schema.md`). Its code fact source is `KNOWN_CARD_KEYS` in `src/core/storage/md/import.mjs`. This ACL is a **referencing consumer**: it does not restate field semantics — for any value question, that document is the answer. (A replacement provider ships its own canonical schema document; the pointer moves with the provider.) The **ACL's own commands / events / invariants** (§4–§12 of this file) stay normative here and in `PROTOCOL §①`; what moved to the product is the **card format** — its fact source is no longer the framework.

**ACL minimal required set** — the card keys the upper layers may depend on, and therefore the keys a swappable provider must map. The names are **the product's own names**: a **subset** of the canonical set, never a paraphrase and never an addition.

| Entity | Minimal required set |
|---|---|
| **Card** (frontmatter) | `id` `title` `status` `priority` `kind` `labels` `project` `assignee` `assignee_kind` `created_by` `created_at` `updated_at` `status_changed_at` `claimed_by` `claimed_at` `heartbeat_at` `blocked_at` `depends_on` `parent` `notify_leader` |
| **Comment / AgentSession / Relation** | **not re-declared here** — the product document defines them (the card's `## Comments` / `## Sessions` sections and the relation types); the team-side handling is §7 (process trail), §9 (session association) and §10 (relations/DAG). |

**Swappability (what the minimal set buys)**:
- A candidate provider (Jira / Linear / Plane / GitHub Issues / custom) must **map these names 1:1** — no renaming, no drop, no extra required key — and then pass the ACL contract tests (§6 invariants + §4 command semantics) to be judged conformant (§12).
- It must also **round-trip unknown keys verbatim**: a card may carry team-side keys outside the set (see below) and the provider must not drop them. The reference provider does this through its unknown-key passthrough, documented in the product document's *Unknown keys are preserved* section; a replacement needs an equivalent. (This is a contract requirement, **not yet a tested one** — the ACL contract tests do not assert it today.)
- §8 is the concrete projection of this set onto PM-tool equivalents (Card→issue, Comment→issue comments, claim→assignment, heartbeat→custom field, …).

> The implementation's private fields are isolated inside the access point and do not enter the upper layers.
> **`project` = a project identity code** (ACL layer; a stable id — under the current implementation the project name, e.g. `example-app` / the reserved `__team__`). It is **resolved via this ACL to a backend implementation** (currently meerkat-taskpanel, **swappable** for Jira/Linear/Plane, …); the upper layers **must not** depend on any backend's internal project id.
> **Team-side extension keys (not part of the ACL set)**: the team layers a few keys on top of the provider's schema — `target` (project-internal location), `goal` (one-line goal), `review_of` (the reviewed card, §10), `writes`, `git_rules`, `subsession_ids`, `active_session_id`. The provider neither maps nor validates them; they ride the same verbatim round-trip as any unknown key (the product document names most of them explicitly in *Unknown keys are preserved*). The list and its discipline are owned by `PROTOCOL §①`.
> **`writes` (optional, one of the extension keys above)**: a card declares the set of files/resources it will modify (comma-separated paths; defaults to `target` when absent). This feeds the **same-file concurrency warning** — before starting, a worker compares this card's write set against the other in-flight cards; an overlap means serialize first (or isolate via `git worktree`). Implemented team-side by `scripts/samefile-guard.mjs`.

## 3. State Machine
```
backlog | todo → in_progress → in_review → done | canceled
                 ↘  blocked  ↙         (blocked can be entered from any executing state and reverted)
```
- `in_review` = delivered and awaiting Elon's acceptance; thereafter no heartbeat refresh, no re-claim, poll does not fire.
- `done` / `canceled` (legacy word `failed`) are **terminal and frozen**: once entered, the ACL refuses any further write to the card unless the actor is Elon / a privileged management path (§4, §6.3).

## 4. Commands (the upper layers call only these)
| Command | Semantics |
|---|---|
| `task.claim <card> <assignee>` | Atomic claim (idempotent; fresh in_progress ⇒ no re-claim) |
| `task.heartbeat <card> <assignee>` | Refresh heartbeat (only by the in_progress owner) |
| `task.setStatus <card> <status> [actor=<a>]` | Set status (maintains `status_changed_at`; entering `blocked` records `blocked_at`). **`done` actor gate**: the terminal `done` may be set **only** by Elon (`actor=elon`) or an explicitly privileged management path (internal ACL callers that pass no `actor` key ⇒ sentinel `lib`); a worker / unknown actor setting `done` is **refused** (`ok:false, reason:done_requires_elon`, no card write) with a hint to close out as `in_review`. The CLI always passes `actor` explicitly (default `''`) and exits non-zero on refusal — so a direct-run `status <card> done` (no `actor=elon`) is rejected (`T-20261010-073931`). **Terminal irreversibility guard** (a second, independent gate — `T-20261012-015421`): when the card is **already terminal** (`done` / `failed` / `canceled`) *every* write from an actor outside `DONE_ACTORS` is **refused** (`ok:false, reason:terminal_immutable` + `from`/`to`, **no card write**: no `status`, no `status_changed_at`, no turn-lock release), so a concurrent worker closeout (`status → in_review`) can no longer overwrite an accepted `done` card; Elon's **explicit reopen** (terminal → another state) is still allowed and is **trailed as a `kind:change` comment** (§7) |
| `task.appendProgress <card> <line>` | Append one line to Progress |
| `task.comment <card> <author> <kind> <text> [refs]` | Append a **process trail** entry (see §7) |
| `task.writeReport <card> <text>` | Overwrite the Report section (one delivery conclusion per card) |
| `task.registerSubsession <card> <sessionId>` | Register a subsession (append + active) |
| `task.query <filter>` | Read-only query (by assignee/status) |
| `task.pollCandidates [assignee]` | **Read-only candidate query (zero side effects)**: returns the claimable candidates for guards/diagnostics; changes no card/registry state; a candidate result is **not** a claim — claiming still goes only through `task.claim` |

## 5. Events (subscribed to by the collaboration layer)
`onReady` · `onClaimed` · `onDelivered(in_review)` · `onBlocked` · `onComment` · `onTerminal(done|canceled)`

## 6. Invariants (contract-test subjects)
1. **claim is atomic** (no double-claiming).
2. **Execution uniqueness**: `in_progress` + fresh heartbeat (≤10min) ⇒ no re-claim, no re-execution.
3. **Terminal state is irreversible (enforced at the write layer)**: `done|canceled` (legacy `failed`) do not transition again — the ACL refuses **any** write to a card already in a terminal state from an actor outside `DONE_ACTORS` (`ok:false, reason:terminal_immutable`, no card write), so a concurrent closeout cannot overwrite an accepted `done`. The only allowed transition out of a terminal state is an **explicit Elon reopen**, and it is trailed as a `kind:change` comment; errata otherwise via a new card or a comment. See §4 (`T-20261012-015421`).
4. **Comments are append-only**: cannot be edited or deleted.
5. **Human decisions are trailed**: a comment with `author=operator` is a "user decision/confirmation".
6. **Terminal states are archivable**: `done|canceled` after 7 full days may be archived.
7. **`done` actor gate**: only `elon` (Elon's final acceptance) or a privileged internal management path (ACL-internal callers that pass no `actor` key ⇒ sentinel `lib`) may set the terminal `done`; a worker / unknown actor is refused (`done_requires_elon`) and told to close out as `in_review`. See §4 `task.setStatus` (`T-20261010-073931`).

## 7. Comments / Process Trail
- **Use**: record **team collaboration discussions, operator decisions and confirmations, dual-signs, and anomaly-handling notes**.
- **`kind` enum**: `discuss` (collaboration discussion) / `decision` (decision) / `confirm` (confirmation·dual-sign) / `change` (**task change**) / `note` (general) / `defect` (defect-related).
- **Task-change trail**: any **substantive change** to the card (Acceptance / Background / scope / assignee / priority / target / convention, etc.) **must** be recorded as a `kind:change` comment (what/why/who, with before→after when needed); ordinary state-machine transitions do not need it.
- **`author`**: `operator` / `elon` / each worker.
- **Report ≠ comment**: Report = delivery conclusion (one per card); comments = process flow (many times, any role).
- **Handoff**: the §⑭ confirmation gate's dual-sign ⇒ `kind:confirm`; §⑦/§⑪/§⑨ clarifications and determinations ⇒ comment trail.
- **Replaceability**: a comment ≈ an issue comment, the easiest thing to map in PM tools.

## 8. Future-Swap Mapping (when swapping PM tools, only change the access-point implementation)
| Contract | Current implementation | PM tool (example) |
|---|---|---|
| Card | task card + frontmatter | issue |
| Comment | the card's `## Comments` section | issue comments |
| status | frontmatter.status | workflow state |
| claim | atomic occupation + write status | assignment + lock/CAS |
| heartbeat | `heartbeat_at` | custom field/event |
| registry | `claude-sessions.json` | links / sub-issues |
| trigger | poll evaluation | webhook / automatic trigger |

> **Semantic gaps (the access point must implement these; the hardest part)** : ① atomic claim; ② heartbeat/anti-double-run; ③ terminal-state archiving; ④ "card as content" (Report/comment volume conventions).

### 8.1 Board base adapter = a thin CLI call (team-side projection + schema drift gate)

- **Thin call, one access point**: the upper layers resolve a `project` identity code **only** through the access point of §1 — the provider CLI (`taskctl`). The team-side **§8 projection** (`team/scripts/board-adapter.mjs`) runs `taskctl --version --json` (the version leg, see below) and then `taskctl project list --json` in a **subprocess** (read-only: `TASKD_NO_AUTOSTART=1`, so a read never starts a daemon) and projects the returned board `project` wire **once** into the §8 project metadata. It **does not import provider internals** and **does not open the board database** (no `node:sqlite`): the **physical schema is the provider's knowledge**, never the team's.
- **Alignment source of truth = the board wire**: the projection mirrors `src/shared/wire.mjs#projectToWire` (the shape the provider freezes in its contract snapshot as `shape:"project"` — `docs/contract.md`, snapshot `schema_version` currently **4**). The adapter **declares** the wire fields it consumes (`PROJECT_WIRE_FIELDS`) and the snapshot version it **targets** (`BOARD_WIRE_SCHEMA_VERSION` = the *expected* value, not the truth).
- **Schema drift gate (two legs)**:
  - **version leg (runtime)**: the projection reads the **provider's live** `schema_version` from `taskctl --version --json` ⇒ `data.schema_version` (`CONTRACT_SCHEMA_VERSION`, the same single source as the contract snapshot) and compares it with the adapter's declaration **before** it reads any board data. **Mismatch ⇒ loud red + degrade** (`available:false` + explicit warning; the resolver falls back to the read-only `projects.json`) — and it does **not** even fetch the project list, because a version mismatch makes the whole chain untrustworthy, independently of whether the code exists on the board. **Version leg unreadable** (no such subcommand, non-JSON envelope, or no `schema_version` field) is **also red**: the leg is part of the frozen CLI contract, so "cannot read it" *is* drift — never a silent return to the structural leg alone.
    Why runtime and not a shared team-side constant: a constant would be a **second copy** of the number; provider bumps the snapshot while the team copy lags ⇒ two copies disagree and the gate silently stops gating — exactly the defect class this closes. Runtime reading keeps **one source of truth** and the gate turns red on a provider bump with no human sync step (the team-side constant only needs a human re-check when *this adapter* moves to the new wire).
  - **structural leg**: the fetched board `project` wire is compared field-by-field against `PROJECT_WIRE_FIELDS` —
    - **missing field / changed type** ⇒ **explicit warning + degrade** (`available:false`; resolver falls back to the read-only `projects.json`), never a silent read under the old schema;
    - **added field** ⇒ warning, but still **readable** (additive drift is forward-compatible);
    - **aligned** ⇒ green, no output.
  - `opts.boardSchemaVersion` remains as an **explicit override seam** (tests / degradation drills); when omitted the adapter always reads the runtime leg.
  Host requirement: the provider CLI must expose `--version --json` with `schema_version` (provider side landed as `ea2a089` / `T-20261012-015340`; the leg must be on `PATH`, per the `taskctl` deployment in `T-20261012-015323-2`).
- **Two schemas: mapped once, never merged** (boundary): the mapping above is **board `project` wire → §8 project metadata**, and nothing else. The team's **card frontmatter schema** — `team/scripts/lib.mjs` `parseFrontmatter` / `serializeFrontmatter`, governed by §11 idempotence — **stays team-side and is untouched**. The provider's board schema is **never re-declared** team-side.
- **Resolution order** (semantics unchanged from the previous adapter): builtin `__team__` → board base (CLI) → read-only `projects.json` fallback → `项目未注册` error.
- **Known limit when a CLI-only write path is wanted**: the CLI reads full `meta` (`project list --json` carries the whole `meta` object) but `--meta k=v` is **string-valued only**, so structured metadata (`repos[]`, booleans, nested objects) cannot be **written** through it. The registration script (`team/scripts/seed-projects.mjs`) therefore still uses the provider bootstrap for the write path; a `--meta-json`-style flag would be a small provider enhancement (separate card).

## 9. Session Association and Resume (save tokens)
- **Deterministic id (claude)**: `sessionId(taskId, owner, seg)` = UUIDv5(`openclaw-team/<taskId>/<owner>/<seg>`), command `task.session-id <card> <owner> [seg]`; constant for the same parameters ⇒ predictable, and passed at spawn via `--session-id` (**claude only** — **codex has no `--session-id`** and self-assigns its session id at spawn, so the UUIDv5 is not a codex spawn parameter or resume handle) — **per-host exact form (basis: `T-20261011-231103` host capability matrix)**: claude `--resume <id>`; codex `codex exec resume <id>`; pi `pi --print --session <id>` (`--resume`/`-r` is a no-arg selector).
- **Card mapping**: each line of the `## Sessions` section is `seg · owner · backend · id · phase · status · pid · ts`; `active_session_id` = the current segment.
- **Commands**: `task.session-set <card> seg=… owner=… backend=claude|codex phase=… pid=… [status]` (`status ∈ {running}`, default `running`; **pass the bare value — do not prefix with `status=`**) | `task.session-close <card> <seg> [status]` (`status ∈ {closed,failed}`, default `closed`; likewise pass the bare value) | `task.session-id <card> <owner> [seg]`. The write side strips a mis-passed `status=` prefix and validates against the whitelist `done|closed|failed|running`; invalid values are rejected with a warning (`T-20261009-224500`).
- **Resume preference**: continuing the same task and same segment ⇒ resume by id in the host's own exact form (**claude** `--resume <id>` | **codex** `codex exec resume <id>` | **pi** `pi --print --session <id>`); start new only when the context is stale/overlong (hand off with a `state.md` summary). **Goal: reduce the context-reload tokens of a new session.**
- **Recovery**: reconcile reads the card's `## Sessions` + registry and takes over by resuming that id in the host's exact form (above).
- **Newly started seg background pack**: the task card (Goal/Acceptance/Background) + the card's `## Report` + `## Comments` + `state.md` (ensuring cross-seg consistency and avoiding reloading the old session context). **Generation**: `task.handoff <card> seg=…` → `workspace/<task-id>/handoff.md` (containing the four anchors, summarized); the subsession reads it first; **do not hand-write it**.
- **Ownership**: OpenClaw agent side only (subsessions are unaware of task management; see `PROTOCOL §⑥#7`).

## 10. Parent/Child Cards and Predecessor Dependencies (DAG)
- **Split**: a composite task = a `kind:epic` parent card (container/aggregate, **not claimable**) + child cards (`parent=<epic>`, ordinary cards); **hierarchy depth follows the provider base** (meerkat-taskpanel: single parent + chain ≤8, no cycles/self-reference); **supports multiple levels; a parent must be an epic (so intermediate nodes are epics)**; breakdown granularity ⇒ `PROTOCOL §⑩.3`.
- **Dependencies**: child cards `depends_on:[predecessors]` (store predecessors only; successors are derived); cross-parent allowed; no dependency = parallel, with dependency = serial.
- **Commands**: `task.spawn <epic> title=… assignee=… [depends_on=a,b]` | `task.depend <card> <on…>` | `task.undepend` | `task.children <epic>` | `task.deps <card>` | `task.rollup <epic>`.
- **Invariants (validated at write time, with reason codes)** : self-reference `self_ref`; parent/child cycle `parent_cycle`; parent must be epic or a card `parent_not_epic`; dependency cycle `dep_cycle`; missing dependency `dep_missing`; dependency on an ancestor forbidden `dep_on_ancestor`; chain length ≤8 `chain_too_long` (**the base limit; the team sets no additional**); fan-in ≤8 `fanin_too_high`.
- **Claim guard**: `epic` ⇒ `epic_container`; `depends_on` not all done ⇒ `deps_unmet` (**no new status added**). **Review cards must not `depends_on` the card under review**: a card with non-empty `review_of` is exempt from the dependency check for the entry that equals `review_of` (all other entries still apply) — the relation is carried by `review_of`, and the reviewed card must stop at `in_review` awaiting verification and never reaches `done` first, so such a `depends_on` would be permanently unsatisfiable and the review card permanently unclaimable (3 recurrences: `T-20261012-194841` / `T-20261012-211516-3` / `T-20261012-224743-3`; exemption added by `T-20261013-000246`). **The exemption is not an unconditional pass — the review gate is the upper bound on it** (full rule by `T-20261013-233052`, which generalises and **supersedes** the narrower `T-20261013-035746` rule): **a review card may be claimed only while the card under review is in `in_review`**. With non-empty `review_of`, the target must **exist** and have `status=in_review`; otherwise the claim is refused with `reason=review_not_ready`, carrying `review_of` + the target's actual `status` (`status: null` when the target is absent/unreadable). This holds **regardless of whether the reviewed card also appears in `depends_on`** — the earlier rule checked the target only on the exempted-dependency branch, so the common shape (a review card that lists no `depends_on` at all) had **no** upper bound and could be poll-claimed before delivery (evidence `T-20261013-232004-2` claimed 2026-10-13T15:25:08Z while `T-20261013-232004` was still `in_progress` — lane produced no artifact, triage set `blocked`; earlier `T-20261013-030936` claimed ~10min early). Concretely: target `ready`/`todo`/`in_progress`/`blocked` ⇒ refuse (not delivered yet; claiming early makes the verifier spin or go `blocked`); target `done`/`canceled`/`failed` ⇒ refuse (**the review has no remaining subject** — such a card should be closed out by Elon instead of being claimed); target **missing** ⇒ refuse (the earlier "do not block + `warnings: ["review_of_not_found:<id>"]`" behaviour is withdrawn — a review card without its subject only spins). The reason string `review_unmet` (`T-20261013-035746`) is renamed to `review_not_ready`; the dependency exemption itself (`T-20261013-000246`) is untouched — when the gate passes, the `depends_on` entry equal to `review_of` is still excluded from the `done` check (the target stays at `in_review` awaiting verification and never reaches `done` first, so that entry would be permanently unsatisfiable), and all other entries are still enforced.
- **Aggregation**: `task.rollup` derives the parent card's status; parent card `done` = all child cards done **+ integration acceptance**; **with multiple layers, recurse bottom-up** (integration acceptance at every layer).
- **Patrol**: relation invariants enter the patrol gate; archive reference protection.

## 11. frontmatter Serialization Invariants and Write Guardrail
- **Invariant (idempotence)**: escaping/unescaping of card frontmatter field values **must be idempotent** — `parse→serialize→parse` is stable, and repeatedly "read→write back" the same value (via any of heartbeat / comment / status / report) **does not grow the byte count**.
- **List fields (always array form)**: list fields — `depends_on` / `subsession_ids` / `labels` (see §15) and any future list field — serialize **always as an array** (empty = `[]`; non-empty = `[a, b]`, elements quoted only when needed, plain ids unquoted); a bare space-joined string is never written. Readers stay backward-compatible with legacy bare/space strings (`a b`) and bracketed strings (`[a, b]`). `labels` follows exactly this path (array form, same as `depends_on`), so it does not grow the card (§11 idempotence invariant).
- **Status values (aligned with meerkat-taskpanel)**: canonical 7 values `backlog|todo|in_progress|in_review|blocked|done|canceled`; compatible aliases `ready→todo`, `failed→canceled` (and `in-review`/`in-progress`/`cancelled`) are **resolved only at the boundary and never persisted**; export restores the original word (old cards stay byte-stable). Priority `low|medium|high|urgent` (default `medium`). kind only `task|epic`.
- **Write guardrail**: writes are **serialized first, then validated**; if the target card already exists and the new output exceeds the previous file size **× 4 (K=4)**, **reject the write** and throw, avoiding partial writes and silent growth; **a new card (no existing file) is not limited**.
- **Regression tests**: the idempotence matrix / old-format compatibility / real-card read-only regression / guardrail, executed with the patrol gate.

## 12. Task-Provider Integration and Switching (ACL binding)
- **Roles**: this project defines the ACL (this file's commands/events/data/invariants); the **provider** implements it. `meerkat-taskpanel` is only the **reference implementation**, **not a mandatory dependency**.
- **Swappable**: any task system satisfying this contract works — e.g. Jira / Linear / Plane / GitHub Issues / a custom board. The team's upper layers interact only through the access point (§4 commands / §5 events), **decoupled from the concrete provider**.
- **Binding method**: set the environment variable **`OPENCLAW_TEAM_TASK_PROVIDER=<name>`** (or an equivalent team config), and install that provider's skill / CLI / MCP. When unconfigured, the team falls back to "no task system" mode (local card files only, no cross-session board).
- **Reference provider**: `meerkat-taskpanel` (installed via `./install.sh --with-meerkat-taskpanel`; not the default/mandatory).
- **Pass criteria**: after swapping the provider, run the **ACL contract tests** (§6 invariants + §4 command semantics) to judge conformance; failing means unsupported.
- **Scope boundary**: **the provider's own skill / MCP / authentication is user-supplied and out of this project's scope** (this project delivers only the ACL definitions + team-side adaptation conventions).

## 14. Card-Creation Idempotency (`idem` key)

- **(Main gate · critical) LLM content de-duplication**: before creating a card, the creator (LLM) must **read the `title`/`goal`/`Background` of existing non-terminal cards** and judge whether the intent/content matches; a match ⇒ **do not create** (reuse/merge); the mechanical key is only a **fallback**.
- **Idempotency key**: `idem = <kind> | <assignee> | <source> | <target>`; `source` = `review_of` if non-empty, otherwise `parent`, otherwise empty. **Not dependent on the title.**
- **Command**: `task.create <...> [--idem <key>|--allow-dup]` (or derived automatically by `spawn`).
- **Semantics**: a card with the **same key and a non-terminal state** ⇒ **reject creation** and return the existing card id (idempotent reuse); under concurrency, serialise with a `mkdir` lock.
- **Weak signal**: same source + highly similar title ⇒ warn (human judgement), **not** a de-duplication basis.
- **Exemption**: segmented child cards append `#<seg>` to the key, or `--allow-dup` + a `kind=change` rationale.

### 14.1 Landing (**main gate = LLM semantic de-duplication**; mechanical key = fallback)

- **Main gate (LLM semantic de-duplication, a mandatory step)**: before creating a card, the creator (Elon/LLM) fetches the **to-read list** from `task.idemCandidates` (non-terminal cards' `title`/`goal`), and judges them one by one for intent match; a match ⇒ **do not create** (reuse/merge/reassign). The mechanical key only catches "same-key" duplicates; it cannot catch "different key, same intent" (e.g. a different assignee / a different source pointing at the same fix) — **only semantic de-duplication can**.
- **Commands** (ACL level; implementable by any provider):

| Command | Semantics |
|---|---|
| `task.create <k=v …>` | Create a card (idempotent). `idem` may be overridden explicitly; the key = `<kind> \| <assignee> \| <source> \| <target>` (source = `review_of` ‖ `parent` ‖ empty). A card with the **same key and a non-terminal state** ⇒ return `{ok:false, reason:'dup', existing, existingStatus}` (**do not create**; reuse the existing card). Concurrency is serialised by a `mkdir` lock (`tasks/.locks/create.<slug>`), re-checked inside the lock before writing. |
| `task.idemCheck <k=v …>` | Read-only idempotency check: `{ok, key, dup, existing?, existingStatus?, similar:[{id,title,status}]}`; `allow_dup=true` ⇒ `dup:false` and `bypass:'allow_dup'` (still returns `similar` for the warning). |
| `task.idemCandidates [project=…] [assignee=…] [source=…]` | **The LLM semantic-de-duplication to-read list**: lists all non-terminal cards (`id`/`status`/`assignee`/`kind`/`target`/`idem`/`title`/`goal`). |

- **`spawn`**: after validating the parent card and before writing, derives the key automatically (`kind='task'`, `source=parent`) and runs the same check; if a same-source child card with the same assignee+target already exists in a non-terminal state ⇒ `{ok:false, reason:'dup'}` (`allow_dup` skips).
- **Patrol**: `check-idem` scans the board, groups **non-terminal** cards by idem key, and **exits 1** if any group has >1; it is **part of `check-all`** (right after `check-relations`).
- **Baseline exemption**: the mechanical key necessarily collides for "same-project, same-person sequential milestones" (same `assignee` + same `target`, no `parent`/`review_of`), which are **not true duplicates**. Such **existing benign groups** are registered in `idem-baseline.json` (schema `{groups:[{key, ids, reason, date, by}]}`); the criterion = the same `key` **and** the sorted `ids` **exactly matching** that group's card-id set ⇒ moved to `exempt` (not flagged); **once the id set changes (add/remove/swap) the exemption lapses**, and it warns again (preventing "register once, allow forever"). `--no-baseline` ignores the baseline (everything is treated as duplicates, for checking real duplicates or whether the baseline is stale); a missing baseline file is treated as an empty group list (no error).
- **Weak signal** (warning only, **not** a de-duplication basis): same source and title similarity (character-bigram Jaccard) ≥ 0.6 ⇒ appears in `similar`.
- **Unit tests**: an isolated `mkdtemp` test (including 5 concurrent same-key subprocesses ⇒ exactly 1 card).
- **Engine declaration (this repository)**: `openclaw-team` **bundles no task-create path** — task management is delegated to the connected provider through this ACL. Therefore idempotency is **guaranteed by the connected provider** (`meerkat-taskpanel` by default satisfies this clause; any replacement must implement it and pass the ACL contract tests), and **the card creator must carry the `idem` key** (the ACL derives it, or `--idem` overrides). Both the `md base` (the team-side reference `task-ops` library) and the `meerkat-taskpanel base` implement this clause.

## 15. Label Taxonomy (issue labels)

> **A team-side convention layer, not a base feature.** `labels` is a **free-form string list** on the card (array form — see §11); the base (meerkat-taskpanel) does **not** enforce any type on it. This section defines a **namespaced prefix convention** (`<ns>:<value>`) on top of free-form labels, so a card's class / dev sub-area / bug environment is greppable and machine-checkable **without adding new enum fields and without changing the base**.

**Namespaces**

| Namespace | Meaning | Values | Presence rule |
|---|---|---|---|
| `category:` | card class | `req` (requirement) / `dev` (development) / `test` (testing) / `bug` (defect); optional `design` / `docs` / `chore` / `research` | every card **SHOULD** carry ≥1 |
| `area:` | development sub-area | `api` / `core` / `ui` / `cli` / `mcp` / `db` / `infra` / … (open set) | a `category:dev` card **SHOULD** carry ≥1 |
| `env:` | bug environment | `test` / `prod` / `staging` / `dev` | a `category:bug` card **MUST** carry ≥1 |
| `sev:` | severity | `blocker` / `critical` / `major` / `minor` | optional; recommended for `category:bug` |

**Rules**
- A card may carry any mix of namespaced and free-form labels; namespaced labels are additive. Only the four prefixes `category:` / `area:` / `env:` / `sev:` are reserved by this section.
- Free-form labels (e.g. `review`) stay valid and are unaffected.
- `kind:epic` cards follow the same convention (usually `category:req`).
- Values are lower-case and one value per label (`category:dev` — never `category:dev,ui`).
- Default audience: every card; `env:*` is bug-specific and `area:*` is dev-specific.

**Examples**
- Requirement card: `labels: [category:req]`
- Development card: `labels: [category:dev, area:api]`
- Bug card: `labels: [category:bug, env:prod, sev:major]`
- Mixed (still valid): `labels: [category:dev, area:ui, review]`

**Serialization**: `labels` is a **list field** and serializes in **array form** exactly like `depends_on` (§11): `[]` when empty, `[category:dev, area:api]` when not — never a bare space-joined string. This preserves the §11 idempotence / no-growth invariant.

**Machine check (soft — warn, never hard-block)**: the card / patrol gate **warns** (exit stays 0; the card is still valid) when:
- a card carries no `category:*`; or
- a card carries `category:dev` but no `area:*`; or
- a card carries `category:bug` but no `env:*`.
A warning is advisory. A hard block is **not** applied — it would break free-form-label compatibility.

**Base compatibility**: this is a **team-side convention only**; the base (meerkat-taskpanel) keeps `labels` as a free-form list and **is not forced to change**. Because it is a prefix convention, cards and the base stay valid whether or not the checker runs.

## 13. Change Record
- **v1**: initial contract (including **comments/process trail**). Owner: Elon.
- **v1 (supplement 2)**: added §12 **task-provider integration and switching (ACL binding)**: meerkat-taskpanel is downgraded to an optional reference implementation, supporting replacement by Jira/Linear/Plane, etc.; the change record shifts to §13. Owner: Elon.
- **v1 (supplement 3)**: added §14 **card-creation idempotency (`idem` key)** — LLM semantic de-duplication as the **main gate** + the mechanical key `<kind>|<assignee>|<source>|<target>` as fallback; ACL commands `task.create` / `task.idemCheck` / `task.idemCandidates`; `spawn` derives the key automatically; `check-idem` patrol with a baseline exemption. Owner: Elon (convention) / Linus (landing).
- **v1 (supplement 4)**: added §15 **Label Taxonomy (issue labels)** — namespaced prefix labels `category:` / `area:` / `env:` / `sev:` over the free-form `labels` list (required rules, examples, soft machine-check criteria); §11 now names `labels` among the array-form list fields; base (meerkat-taskpanel) unchanged (prefix convention). Owner: Elon (convention) / Linus (landing).
- **v1 (supplement 5)**: concurrency hardening — §2 Card gains optional `writes` (same-file concurrency-warning source); §4 gains `task.pollCandidates` (read-only, zero-side-effect candidate query; claiming still only via `task.claim`). Owner: Linus.
- **v1 (supplement 6)**: added **§8.1** — the board base adapter is a **thin CLI call** (subprocess, no provider internals, no direct DB access) with a **schema drift gate** aligned to the board wire (`projectToWire`, snapshot `schema_version`); records the **two-schemas-mapped-once / never-merged** boundary (§8.1 vs §11) and the CLI's string-only `--meta` write limit. Owner: Elon (convention) / Linus (landing).
- **v1 (supplement 7)**: **terminal irreversibility becomes enforced, not merely declared** (§3/§4/§6.3) — `task.setStatus` gained a **second, independent gate** beside the `done` actor gate: a card already in a terminal state (`done` / `failed` / `canceled`) is **frozen** — every write from an actor outside `DONE_ACTORS` is refused (`reason:terminal_immutable`, no card write), which closes the real incident where a worker's concurrent closeout (`report`/`progress`/`comment`/`session-close` + `status→in_review`) arriving **after** Elon's acceptance silently overwrote `done` back to `in_review`. Elon's explicit reopen stays available and is trailed as a `kind:change` comment (§7). Owner: Elon (convention) / Linus (landing) (`T-20261012-015421`).
- **v1 (supplement 8)**: §8.1 **version leg connected** — the adapter no longer treats the board `schema_version` as a caller-injected value: it reads the **runtime** leg (`taskctl --version --json` ⇒ `data.schema_version`) and compares it with its declaration on every resolve. Mismatch **or** an unreadable leg ⇒ loud red + degrade (`available:false`, no board fetch). Rationale for runtime-over-shared-constant: one source of truth, no silent second copy. Owner: Elon (convention) / Linus (landing) (`T-20261012-022948`; provider side `T-20261012-015340`).
- **v1 (supplement 9)**: **card schema becomes a reference, not a definition** — §2 no longer declares the entity field semantics; it keeps only the **ACL minimal required set** (a field-name subset of the product's canonical set) + a pointer to `skills/meerkat-taskpanel/references/card-schema.md` (**the product owns the schema**; code fact source `KNOWN_CARD_KEYS`). The Comment/AgentSession/Relation field lists are dropped as duplicates (the product document defines the card's `## Comments` / `## Sessions` sections and the relation types; team-side handling stays in §7/§9/§10). Team-side extension keys (`target` / `goal` / `review_of` / `writes` / `git_rules` / `subsession_ids` / `active_session_id`) are named as **outside the ACL set** and ride the provider's unknown-key passthrough. Companion change: `PROTOCOL §①` (same split). Owner: operator (ruling 2026-10-14) / Elon (convention) / Linus (landing) (`T-20261014-003524-2`; product side `T-20261014-003524`).
