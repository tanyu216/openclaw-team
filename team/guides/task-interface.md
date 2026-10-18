# Task-Management Interface Contract (`task-interface v1`)

> **Ownership**: the task-management **base** (an independent layer). Normative team rules = `R-BOARD-1`; this file is the base's **sole access contract to the upper layers** (the task-provider ACL).
> **Purpose**: the upper layers depend only on this contract, not on the underlying implementation ⇒ swapping the task system changes zero upper-layer behavior (only the provider implementation + the contract tests).
> **Provider**: **not mandatory, swappable**. `meerkat-taskpanel` is the **reference implementation** (task skill + `taskctl` CLI); Jira / Linear / Plane / GitHub Issues / a custom board works if it satisfies this contract.
> **Scope**: this project delivers only the ACL and the team-side adaptation conventions; each task system's own skill / MCP / authentication is user-supplied and out of scope.
> **Canonical card schema**: the provider skill's `references/card-schema.md` (installed with the provider; see `skills/PROVENANCE.md`). This file does **not** restate fields, body-section shapes or value enums — it states the **operations**, the **team-side state semantics**, the **invariants the team's gates rely on**, and the **swap requirements**.
> **Version**: `v1`; changes go through a separate card + dual-signing.

---

## 1. Layering and Access Point

- **Provider (replaceable)**: reference implementation = the external **meerkat-taskpanel** (task skill + `taskctl` CLI); card persistence + session registry + trigger evaluation. Other systems integrate through the same ACL.
- **Sole access point**: the provider's task interface. The upper layers **must not** directly read/write card files or bypass it; everything goes through the operations in §4.
- **Team-side projection**: `team/scripts/lib.mjs` + `board-adapter.mjs`. The provider's physical schema (storage, wire format) is provider knowledge and never enters the upper layers.
- **Registry ownership**: `claude-sessions.json` is the OpenClaw-side session registry (team runtime), not the provider's card store; the provider's card/session fields are owned by the provider's schema.

---

## 2. Data Model (ACL minimum the team relies on)

> **The canonical card schema lives in the provider, not here.** Field meanings, value enums, body-section shapes and the import→export round-trip are owned by the provider's `references/card-schema.md`. A replacement provider ships its own canonical schema document; this contract only requires that the fields the team uses are mapped 1:1 and that unknown/team-side keys round-trip verbatim.

- **Team-side extension keys** (outside the provider's schema; carried by the provider's unknown-key passthrough): `target` (project-internal location), `goal` (one-line goal), `review_of` (the reviewed card), `writes` (declared write set), `git_rules`, `subsession_ids`, `active_session_id`. Their discipline is owned by `R-BOARD-1`.
- **`project`** = a project identity code, resolved through this ACL to a backend entity; the upper layers never depend on a backend's internal project id.
- **`writes`** (optional): the card's declared file/resource set; defaults to `target`. It feeds the same-file concurrency warning (`scripts/samefile-guard.mjs`) — overlap ⇒ serialize first or isolate in a worktree.
- **Swappability**: a candidate provider must map the fields the team uses 1:1, preserve unknown keys, and pass the ACL contract tests (§6 invariants + §4 operation semantics) to be judged conformant (§12).

---

## 3. State Machine (team-visible semantics)

```text
backlog | todo → in_progress → in_review → done | canceled
                 ↘  blocked  ↙         (blocked can be entered from any executing state and reverted)
```

- `in_review` = delivered and awaiting Elon's acceptance; thereafter no heartbeat refresh, no re-claim, poll does not fire.
- `done` / `canceled` (legacy word `failed`) are **terminal and frozen**: the ACL refuses any further write to the card outside the acceptance path (§4, `R-PARALLEL-1`).
- The **full machine** — including the provider's attention overlay (`awaiting`) and every per-transition rule — is in the provider's `references/card-schema.md`. The team relies on the transitions above, not on a second copy of the machine.

---

## 4. Commands (the upper layers call only these)

| Operation | Team-visible semantics |
|---|---|
| `task.claim <card> <assignee>` | Atomic claim (idempotent; fresh `in_progress` ⇒ no re-claim). |
| `task.heartbeat <card> <assignee>` | Refresh the heartbeat (only the `in_progress` owner). |
| `task.setStatus <card> <status> [actor]` | Move status; entering `blocked` records `blocked_at`; the terminal `done` and terminal-irreversibility gates apply. |
| `task.appendProgress <card> <line>` | Append one line to the Progress section. |
| `task.comment <card> <author> <kind> <text> [refs]` | Append a process-trail entry (§7). |
| `task.writeReport <card> <text>` | Overwrite the Report section (one delivery conclusion per card). |
| `task.session-id` / `task.session-set` / `task.session-close` | Session association / registration / close-out (§9). |
| `task.create` / `task.idemCheck` / `task.idemCandidates` | Card creation + idempotency (§14). |
| `task.spawn` / `task.depend` / `task.undepend` / `task.children` / `task.deps` / `task.rollup` | Epic / child / dependency graph (§10). |
| `task.query` / `task.pollCandidates` | Read-only query / candidate surface (zero side effects; a candidate is **not** a claim). `kind:deploy` is excluded from the candidate surface. |
| `task.handoff` | Generate a new segment's handoff pack (§9). |

- **The provider's command syntax, parameters and `--json` envelopes are in its `references/cli.md`.** This contract names the operations and their team-visible semantics only.
- The provider's own events: `onReady` · `onClaimed` · `onDelivered(in_review)` · `onBlocked` · `onComment` · `onTerminal(done|canceled)`.

---

## 5. Events (subscribed to by the collaboration layer)

`onReady` · `onClaimed` · `onDelivered(in_review)` · `onBlocked` · `onComment` · `onTerminal(done|canceled)`.

---

## 6. Invariants (contract-test subjects)

1. **Claim is atomic** (no double-claiming).
2. **Execution uniqueness**: `in_progress` + fresh heartbeat (≤10min) ⇒ no re-claim, no re-execution.
3. **Terminal state is irreversible at the write layer**: `done|canceled` (legacy `failed`) do not transition again — the ACL refuses any write to an already-terminal card outside the acceptance path (`reason:terminal_immutable`). The only allowed exit is an **explicit Elon reopen**, trailed as a `kind:change` comment.
4. **Comments are append-only** (cannot be edited or deleted).
5. **Human decisions are trailed**: a comment with `author=operator` is a user decision/confirmation.
6. **Terminal states are archivable**: `done|canceled` after 7 full days may be archived.
7. **`done` actor gate**: only Elon (final acceptance) or a privileged internal management path may set terminal `done`; a worker/unknown actor is refused (`done_requires_elon`) and told to close out as `in_review`.

---

## 7. Comments / Process Trail (team-side rules)

- **Use**: record team collaboration discussions, operator input (suggestions / decisions / questions / clarifications / corrections), confirmations, dual-signs and anomaly-handling notes.
- **`kind` enum**: `discuss` / `decision` / `confirm` / `change` / `note` / `defect`.
- **Task-change trail**: any substantive card change (Acceptance / Background / scope / assignee / priority / target / convention) ⇒ a `kind:change` comment (what/why/who, before→after when needed). Ordinary state transitions do not need one.
- **Operator-input trail**: whatever the operator says about a card lands on that card as an `author=operator` comment **in the same turn it is received** — the conversation is not a durable carrier; no card yet ⇒ card the input first (normative text `R-DISC-8`).
- **Report ≠ comment**: Report = delivery conclusion (one per card); comments = process flow (many, any role).
- **Replaceability**: a comment ≈ an issue comment; the provider's command/`kind` handling is in `references/cli.md`.

---

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

> **Semantic gaps the access point must implement (the hardest part)**: ① atomic claim; ② heartbeat / anti-double-run; ③ terminal-state archiving; ④ "card as content" (Report/comment volume conventions).
>
> **Board adapter (team-side)**: `board-adapter.mjs` projects the provider's board wire into the team's project metadata and carries a schema-drift gate (version + structural legs). The provider's wire schema, snapshot version and `--meta` write limits are provider knowledge — see the provider's `references/cli.md` and the implementation notes in `team/scripts/README.md`.

---

## 9. Session Association and Resume (save tokens)

- **Policy**: continuing the same task and same segment ⇒ **resume by id** in the host's exact form; start new only when the context is stale/overlong. Goal: reduce context-reload tokens.
- **Card mapping**: each line of `## Sessions` is `seg · owner · backend · id · phase · status · pid` (+ `harness:plugin` after `backend:` for a plugin lane); `active_session_id` = the current segment. A registration row's identity is `(task_id, owner, session_id)`; `phase` is a free-form display label, not a second `seg`.
- **Newly started seg background pack**: the task card (Goal/Acceptance/Background) + the card's `## Report` + `## Comments` + `state.md`. Generation: `task.handoff <card> seg=…` → `workspace/<task-id>/handoff.md` (four anchors, summarized); the subsession reads it first; **do not hand-write it**.
- **Command syntax / per-host resume forms** (`claude --resume`, `codex exec resume`, `pi --session`, plugin-lane thread continue): the provider's `references/cli.md` and `references/practice-guides.md`; the lane entry's registered forms: `guides/spawn-lane-sop.md` §3.
- **Interactive lane questions/decisions**: an interactive lane's `AskUserQuestion` / `request_user_input` is **not** answered in-process. The host writes `workspace/<task-id>/questions/<owner>-<seg>-<ts>-<request>.json`, posts a `discuss` (clarify) or `decision` comment carrying `blocked_reason=clarify|decision` and `refs:question:<id>`, sets the card `blocked`, and stops. The answer is recorded by the operator/Elon on the card; the owner starts a **new segment**, whose handoff already carries `## Comments`. Full flow: `guides/interactive-lane-sop.md` §7–§8.
- **Ownership**: OpenClaw agent side only; subsessions are unaware of task management (`R-SESSION-1` clause 7).

---

## 10. Parent/Child Cards and Predecessor Dependencies (DAG)

- **Split**: a composite task = a `kind:epic` parent (not claimable) + child cards (`parent=<epic>`, ordinary cards); hierarchy depth follows the provider base; a parent must be an epic.
- **Dependencies**: children carry `depends_on` (predecessors only; successors are derived); no dependency = parallel, with dependency = serial.
- **Registration**: all batches are registered at once; only dispatch/release may be batched (`R-DAG-1`).
- **Claim guard**: `epic` ⇒ `epic_container`; unmet `depends_on` ⇒ `deps_unmet` (no new status). A review card's `review_of` dependency is exempt; the review gate additionally requires the target to exist and be `in_review` (`review_not_ready`).
- **Aggregation**: parent `done` = all children done **+ integration acceptance**; blocked/canceled children block/cancel the parent (`task.rollup`).
- **Deploy cards**: `kind:deploy` is never auto-claimed; explicit dispatch only (the candidate surface excludes it, the explicit claim path still allows it — only `epic` is refused).
- **Provider command names, invariant reason codes and hierarchy limits**: `references/cli.md`; team granularity: `R-GRANULARITY-1`, `roles/elon/guides/carding-sop.md`.

---

## 11. Serialization and Write Guardrails (what the team relies on)

- **Idempotence**: parse→serialize→parse is stable; repeatedly writing the same value (heartbeat / comment / status / report) must not grow the card's byte count.
- **List fields** (`labels`, `depends_on`, `subsession_ids`, …) serialize in **array form**; readers stay backward-compatible with legacy bare strings.
- **Write guardrails** (provider-enforced; the team relies on them): a write that would inflate the frontmatter block beyond the provider's bound is rejected with zero side effects; a `## Report` over **64 KiB** is rejected at write time (historical over-bound cards are not retro-reddened). Bulk evidence belongs in `workspace/<id>/` and is referenced from the Report.
- **Where the exact bounds live**: the provider's `references/card-schema.md` / implementation. `worker-report-template.md` §6 states the 64 KiB cap the team inherits.

---

## 12. Task-Provider Integration and Switching (ACL binding)

- **Roles**: this project defines the ACL (this file's operations / events / data / invariants); the provider implements it. `meerkat-taskpanel` is only the reference implementation.
- **Swappable**: any system satisfying this contract works (Jira / Linear / Plane / GitHub Issues / custom). The upper layers interact only through the access point (§4 / §5).
- **Binding**: set `OPENCLAW_TEAM_TASK_PROVIDER=<name>` (or an equivalent team config) and install that provider's skill / CLI / MCP. Unconfigured ⇒ "no task system" mode (local card files only, no cross-session board).
- **Pass criteria**: after swapping, run the ACL contract tests (§6 invariants + §4 operation semantics); failing means unsupported.
- **Scope boundary**: the provider's own skill / MCP / authentication is user-supplied.

---

## 13. Change Record

`task-interface` is versioned `v1`. Changes go through a separate card + dual-signing; the change narrative lives in git (the card id is the audit trail), not in this contract body.

---

## 14. Card-Creation Idempotency (team contract)

- **(Main gate) LLM content de-duplication**: before creating a card, the creator (Elon/LLM) must read the `title`/`goal`/`Background` of existing non-terminal cards and judge whether the intent matches. A match ⇒ **do not create** (reuse/merge). The mechanical key is only a fallback.
- **Idempotency key**: `idem = <kind> | <assignee> | <source> | <target>`; `source` = `review_of` if non-empty, else `parent`, else empty. Not dependent on the title.
- **Semantics**: same key + non-terminal state ⇒ reject creation and return the existing card id (idempotent reuse); concurrency is serialised by a creation lock.
- **Weak signal**: same source + highly similar title ⇒ warn, never a de-duplication basis.
- **Exemption**: genuinely-needed same-source cards append `#<seg>` to the key, or use `--allow-dup` with a `kind=change` rationale.
- **Landing / commands / patrol / baseline registry**: provider `references/cli.md` + the reference implementation; this repository bundles no create path, so the convention is guaranteed by the connected provider + the creator carrying the key.

---

## 15. Label Taxonomy (issue labels, team-side convention)

> A team-side convention layer, not a base feature. `labels` is a free-form string list on the card (array form, §11); the base does not enforce a type. This section defines a namespaced prefix convention (`<ns>:<value>`) so a card's class / dev sub-area / bug environment is greppable and machine-checkable without new enum fields.

| Namespace | Meaning | Values | Presence rule |
|---|---|---|---|
| `category:` | card class | `req` / `dev` / `test` / `bug`; optional `design` / `docs` / `chore` / `research` | every card **SHOULD** carry ≥1 |
| `area:` | development sub-area | `api` / `core` / `ui` / `cli` / `mcp` / `db` / `infra` / … (open set) | a `category:dev` card **SHOULD** carry ≥1 |
| `env:` | bug environment | `test` / `prod` / `staging` / `dev` | a `category:bug` card **MUST** carry ≥1 |
| `sev:` | severity | `blocker` / `critical` / `major` / `minor` | optional; recommended for `category:bug` |

**Rules**: any mix of namespaced and free-form labels is valid; only the four prefixes are reserved. `kind:epic` follows the same convention (usually `category:req`). Values are lower-case, one value per label. `labels` serializes in array form exactly like the other list fields (§11).

**Machine check (soft — warn, never hard-block)**: the gate warns when a card carries no `category:*`, or `category:dev` without `area:*`, or `category:bug` without `env:*`. A warning is advisory; free-form-label compatibility is preserved.
