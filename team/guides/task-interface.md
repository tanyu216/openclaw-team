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

## 2. Data Model (minimal required set)
| Entity | Fields |
|---|---|
| **Card** | `id` `title` `assignee` `assignee_kind` `status` `priority` `kind` `labels` `project` `target` `writes` `created_by` `created_at` `updated_at` `status_changed_at` `claimed_by` `claimed_at` `heartbeat_at` `blocked_at` `depends_on` `parent` `review_of` `notify_leader` `goal` (= meerkat-taskpanel `KNOWN_CARD_KEYS`; unrecognized keys are preserved verbatim in `meta.legacy`) |
| **Comment** | `{ id, task_id, body, kind, author_kind, author_id, refs, created_at }` (append-only, lands in the card's `## Comments` section; `kind ∈ discuss\|decision\|confirm\|change\|note\|defect`) |
| **AgentSession** | `{ task_id, seg, owner, backend, session_id, phase, pid, status, ts }` (`status ∈ running\|closed\|failed`; lands in the card's `## Sessions` section) |
| **Relation** | `{ relation_type, source_task_id, target_task_id }` (`relation_type ∈ parent\|blocks\|related`; the `related` direction is normalized to source<target; single-parent constraint) |

> The implementation's private fields are isolated inside the access point and do not enter the upper layers.
> **`project` = a project identity code** (ACL layer; a stable id — under the current implementation the project name, e.g. `example-app` / the reserved `__team__`). It is **resolved via this ACL to a backend implementation** (currently meerkat-taskpanel, **swappable** for Jira/Linear/Plane, …); the upper layers **must not** depend on any backend's internal project id.
> **`writes` (optional)**: a card declares the set of files/resources it will modify (comma-separated paths; defaults to `target` when absent). This feeds the **same-file concurrency warning** — before starting, a worker compares this card's write set against the other in-flight cards; an overlap means serialize first (or isolate via `git worktree`).

## 3. State Machine
```
backlog | todo → in_progress → in_review → done | canceled
                 ↘  blocked  ↙         (blocked can be entered from any executing state and reverted)
```
- `in_review` = delivered and awaiting Elon's acceptance; thereafter no heartbeat refresh, no re-claim, poll does not fire.

## 4. Commands (the upper layers call only these)
| Command | Semantics |
|---|---|
| `task.claim <card> <assignee>` | Atomic claim (idempotent; fresh in_progress ⇒ no re-claim) |
| `task.heartbeat <card> <assignee>` | Refresh heartbeat (only by the in_progress owner) |
| `task.setStatus <card> <status> [actor=<a>]` | Set status (maintains `status_changed_at`; entering `blocked` records `blocked_at`). **`done` actor gate**: the terminal `done` may be set **only** by Elon (`actor=elon`) or an explicitly privileged management path (internal ACL callers that pass no `actor` key ⇒ sentinel `lib`); a worker / unknown actor setting `done` is **refused** (`ok:false, reason:done_requires_elon`, no card write) with a hint to close out as `in_review`. The CLI always passes `actor` explicitly (default `''`) and exits non-zero on refusal — so a direct-run `status <card> done` (no `actor=elon`) is rejected (`T-20261010-073931`) |
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
3. **Terminal state is irreversible**: `done|canceled` do not transition again (errata via a new card or a comment).
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

## 9. Session Association and Resume (save tokens)
- **Deterministic id**: `sessionId(taskId, owner, seg)` = UUIDv5(`openclaw-team/<taskId>/<owner>/<seg>`), command `task.session-id <card> <owner> [seg]`; constant for the same parameters ⇒ resumable via `--resume`.
- **Card mapping**: each line of the `## Sessions` section is `seg · owner · backend · id · phase · status · pid · ts`; `active_session_id` = the current segment.
- **Commands**: `task.session-set <card> seg=… owner=… backend=claude|codex phase=… pid=… [status]` (`status ∈ {running}`, default `running`; **pass the bare value — do not prefix with `status=`**) | `task.session-close <card> <seg> [status]` (`status ∈ {closed,failed}`, default `closed`; likewise pass the bare value) | `task.session-id <card> <owner> [seg]`. The write side strips a mis-passed `status=` prefix and validates against the whitelist `done|closed|failed|running`; invalid values are rejected with a warning (`T-20261009-224500`).
- **Resume preference**: continuing the same task and same segment ⇒ `--resume <id>`; start new only when the context is stale/overlong (hand off with a `state.md` summary). **Goal: reduce the context-reload tokens of a new session.**
- **Recovery**: reconcile reads the card's `## Sessions` + registry and takes over by `--resume` on the id.
- **Newly started seg background pack**: the task card (Goal/Acceptance/Background) + the card's `## Report` + `## Comments` + `state.md` (ensuring cross-seg consistency and avoiding reloading the old session context). **Generation**: `task.handoff <card> seg=…` → `workspace/<task-id>/handoff.md` (containing the four anchors, summarized); the subsession reads it first; **do not hand-write it**.
- **Ownership**: OpenClaw agent side only (subsessions are unaware of task management; see `PROTOCOL §⑥#7`).

## 10. Parent/Child Cards and Predecessor Dependencies (DAG)
- **Split**: a composite task = a `kind:epic` parent card (container/aggregate, **not claimable**) + child cards (`parent=<epic>`, ordinary cards); **hierarchy depth follows the provider base** (meerkat-taskpanel: single parent + chain ≤8, no cycles/self-reference); **supports multiple levels; a parent must be an epic (so intermediate nodes are epics)**; breakdown granularity ⇒ `PROTOCOL §⑩.3`.
- **Dependencies**: child cards `depends_on:[predecessors]` (store predecessors only; successors are derived); cross-parent allowed; no dependency = parallel, with dependency = serial.
- **Commands**: `task.spawn <epic> title=… assignee=… [depends_on=a,b]` | `task.depend <card> <on…>` | `task.undepend` | `task.children <epic>` | `task.deps <card>` | `task.rollup <epic>`.
- **Invariants (validated at write time, with reason codes)** : self-reference `self_ref`; parent/child cycle `parent_cycle`; parent must be epic or a card `parent_not_epic`; dependency cycle `dep_cycle`; missing dependency `dep_missing`; dependency on an ancestor forbidden `dep_on_ancestor`; chain length ≤8 `chain_too_long` (**the base limit; the team sets no additional**); fan-in ≤8 `fanin_too_high`.
- **Claim guard**: `epic` ⇒ `epic_container`; `depends_on` not all done ⇒ `deps_unmet` (**no new status added**).
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
