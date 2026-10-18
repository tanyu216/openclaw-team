# Elon Carding SOP (role-owned)

> Method home for `R-REVIEW-1` · `R-DAG-1` · `R-GRANULARITY-1` and Elon's Task-Card Breakdown SOP. The owner
> blocks in `roles/elon/AGENTS.md` keep the normative summaries; this guide carries the operational detail. Load it when breaking down a
> project, an epic, or a multi-card requirement.

## 1. Breakdown scope

- Per the architecture/design doc milestones, **break out all task cards at once (M1~Mn)**, not just the first card.
- **🔒 Hard rule — register all batches at once, dispatch in batches**: whenever a requirement has to be built out in **more than one batch**, I **first create a `kind:epic` parent card, then register *every* batch as child cards in the same pass** — `task.spawn <epic> title=… assignee=… [depends_on=…]` per child; **later batches may sit as `todo`/`backlog` placeholders**. **Registration must be all-at-once; only the dispatch/release step may be batched.** Creating just batch 1 and moving on is **forbidden**: a batch I never registered is invisible to `task.children` and `task.rollup`, so the epic would look like it can close while the rest of the requirement silently evaporates. This is the *hard form* of the soft SOP line above; `R-DAG-1` carries the same clause (a placeholder child keeps the epic open until every batch is done). **Before releasing each batch, verify the epic's full child roster with `task.children <epic>`** (see Dispatch §4).
- **🔒 Hard rule — judge split/epic before carding when more than one unit is in play**: at carding time, if a card is **expected to carry ≥2 independent Acceptance items or ≥2 independently-acceptable deliverables**, I **first judge whether to split it / build an epic** — **"the card is big" is a reason to split the card, never a reason to open a pile of segs inside one card.** A `seg` is legitimate only for the **four structural reasons** whitelisted in `R-SEGUSE-1` (lane-unreachable environment / bounded retry / ≥2 mutually-exclusive file families with a single acceptance / author-isolated independent verification), and every seg must still **share one Acceptance**. Carried **alongside the batch-carding hard rule above** (both are carding-time gates).
- Each card: Goal (one line) / Acceptance (checkable, verifiable, ≥3 items) / Background (self-contained) / project required / assignee per the `R-TRIAGE-1` routing matrix.
- Explicitly state **inter-card dependencies** (e.g. M2 depends on M1) and **open items** (a decision needed during implementation ⇒ set blocked and send back to me).
- **🔒 Hard rule — one card = one project; paths stay inside it**: a card's `target`/`writes` are **project-internal relative paths**; never card another project's tree, and never an absolute/home path (`/Users/…`, `~/…`) or a `../` escape. A genuinely out-of-project dependency is legitimate **only** on the **operator's explicit designation**, then recorded on the card (`task.comment kind=change`). Carding defects here are machine-caught (`R-PROJECT-2`).

## 2. Review participants (dynamically determined, not a fixed roster)

> **Who reviews a task card is determined by the workers the card actually involves; it is not fixed that "some set of agents all review".**

| Card nature | Review participants |
|---|---|
| Involves development (assignee or deliverables related to implementation) | Linus (engineering feasibility) |
| Involves verifiability (Acceptance measurable, test points complete) | Turing (verifiability) |
| Involves product/UX design | Jobs (design) |
| Purely internal chores / none of the above | Only the assignee confirms; no multi-party cross-review needed |

- Elon organizes the review: dispatch the relevant workers in parallel to review the task card, collect, then summarize; undivided technical corrections are written back directly by Elon, cognitive differences are escalated to the operator for a decision; only after confirming line-by-line "no omissions, no differences" is it dispatched.
- Example: a module M1~M5 involving both "development (Linus) + verifiability (Turing)" → both review; a purely-development card with no research aspect and no special acceptance difficulty → only Linus confirms; a later requirement involving UX → add Jobs.

**By flow (`R-FLOW-1`)**: the participant set of a card **is its flow's chain** —
**A** = Jobs (prerequisite contract, then design-dimension confirmation) + Linus + Turing (independent verification + conformance matrix) + Elon (final acceptance audit);
**B** = Linus + Turing (reproduce → pass + regression) + Elon;
**C** = Linus + Elon, with Turing/Jobs entering through the **rolling sample** (Turing machine sample 20%/week; Jobs visual spot-check on the same batch), or one **asynchronous** Jobs visual pass when the change is visually non-trivial.
A flow's chain **does not remove** the review participants the card's nature demands in the table above; the flow decides **who reviews the card at intake and whose reports Elon audits at acceptance**, not whether review happens. A flow-A dev card's `depends_on` points at its Jobs prerequisite card (`R-PREREQ-1`).

## 3. Review & gating

- Dispatch the relevant workers in parallel via `sessions_send` to review the task card (give the card path + review angle), then aggregate when all are collected.
- "No-disagreement technical fixes" from review → I write them back into each card directly; no more item-by-item operator questions.
- "Cognitive disagreements" from review → summarize as options; ask the operator to sign off, then finalize.
- Only after confirming item by item "no omissions, no disagreements" does dispatch begin.

## 4. Dispatch

- **Resource-aware parallel (parallel by default)**: **judge "do write resources conflict" first** — **No conflict** (different workers / different files / isolatable) ⇒ **dispatch in parallel immediately** (including Linus↔Turing parallel); no "serial-first" queueing. **Conflict** (same file / same batch of files without isolation / shared mutable resource) ⇒ **serialize only the conflicting objects**; the rest parallel.
- Data dependencies (e.g. a result needs a prerequisite artifact) still serialize as needed — a **data dependency**, not a resource lock.
- In the card/dispatch message, explicitly annotate "parallelizable / must serialize (because of X)".
- **Pre-release roster check (multi-batch epics)**: before releasing each batch, run `task.children <epic>` and confirm the **full** child roster is registered — later batches must already exist as `todo`/`backlog` placeholders from the initial all-at-once registration (§1). Do not "create batch N+1 late" as a way of starting it. If `check-relations`/patrol flags an epic that has released a batch but still parks `todo` children past the threshold (the "forgot batch 2" pattern) ⇒ reconcile per `R-DAG-1`/`R-GRANULARITY-1`.
- Card acceptance passes → release the next card whose dependencies are ready; acceptance fails → send back (add evidence / open a revision card).

## 5. Worker plan confirmation (after receiving a worker's Phase-2.5 reply)

- After a worker (Linus etc.) self-checks their plan, they `sessions_send` me the plan path + summary + open items (see each worker's AGENTS.md "Phase 2.5"). On receipt I:
  1. Review the plan (against the task-card Acceptance/Background): is the approach reachable, are there omissions/overreach, do the open items need resolving.
  2. **Decide whether to escalate to the operator**: routine/clear → I confirm myself (reply to the worker "confirmed, execute"); major/disputed/involving security & data safety/architecture direction → escalate to the operator for review.
  3. **When escalating**: dispatch assistant to export plan.md to PDF and send it to the operator via the human channel; on the operator's feedback, reply to the worker (confirm or send back for revision).
  4. When sending back, state clearly "what to change + why"; the worker returns to Phase 1/2, revises, and re-sends for my confirmation.

## 6. Composite task = subtask cards + dependency graph (DAG)

- **Split**: a composite task creates a `kind:epic` parent card (container/aggregate, **not claimable**); units become **child cards** (`parent=<epic>`, ordinary cards).
- **Registration is all-at-once; dispatch may be batched** (see §1). Register every batch as child cards in one pass; later batches may sit as `todo`/`backlog` placeholders. Only the release step may be batched.
- **Parallel/temporal**: child cards add `depends_on:[predecessors]` (store predecessors only; cross-parent allowed); no dependency ⇒ parallel, with dependency ⇒ serial (resource-aware parallel reuse).
- **Relations only via the ACL**: the board commands are the provider's (`task.spawn` / `task.depend` / `task.undepend` / `task.children` / `task.deps` / `task.rollup`; contract: `team/guides/task-interface.md` §10). **At write time** the provider validates invariants (cycles / self-reference / dependency on ancestors / graph shape) and returns reason codes.
- **Claim guard**: `kind:epic` is skipped; if `depends_on` is not all done ⇒ `deps_unmet`, not claimed (no new status added). **Review cards must not `depends_on` the card under review**: for a card with non-empty `review_of`, the dependency entry equal to `review_of` is exempt (all other entries still apply) — that relation is carried by `review_of`, and the reviewed card stops at `in_review` and never reaches `done` first, so the entry would be permanently unsatisfiable (contract detail: `team/guides/task-interface.md` §10).
- **Aggregation**: parent card `done` = all child cards done **and integration acceptance passes**; if any child card is blocked/canceled ⇒ the parent card is blocked/canceled (`task.rollup`).
- **Archive protection**: referenced cards cannot be archived. Relation invariants enter the patrol gate.
- **Hierarchy/shape**: follows the provider base (single parent, no cycles/self-reference, chain and fan-in limits). The provider schema/limits are the fact source (`team/guides/task-interface.md` §10); the team sets **no additional depth number** — how deep to split is the §7 granularity principle.

## 7. Carding granularity & breakdown authority

- **Breakdown authority = `R-MSG-1`** (Elon is the sole card creator; Jobs/Linus/Turing/Assistant may only request a card, never create or split one themselves).
- **Granularity principle (anti-over-split)**: one card = **one "independently acceptable delivery unit"** (clear Goal/Acceptance, assignable to a single person, closable on its own). If one card contains **multiple independently acceptable units** ⇒ **it should be split**; if a split-out child is **too small to have independent acceptance value** ⇒ **it should not be split** (merge it). **How deep to split = adjudicated by Elon under this principle.**
- **Soft guardrails (alert, not hard block)**: patrol **warns** on "**deep chains** (chain length approaching the base limit, e.g. ≥5)" and "**fragmented cards** (too many child cards / granularity too small)", for Elon's manual review.
- **Registered-but-undispatched batches**: patrol **warns** when an epic has **already released a batch** (the epic is `in_progress`, or some child has left the placeholder state) yet still holds child cards parked in `todo`/`backlog` **beyond a threshold** (default 48h) — the "first batch built, second batch forgotten" pattern. **Basis (machine-checkable)**: the signal is entirely in card frontmatter (`kind`/`status`/`parent`/`status_changed_at`), so it lands as a **`warn` in `check-relations.mjs`** (invoked by the `check-all` gate patrol per `R-GATE-1`), **not** on the `task-patrol` stale-heartbeat channel (whose object is a stalled *worker*, `R-WORKTREE-1`) and **not** a hard gate — exit code is unchanged, decisions stay human (`R-GATE-2`). The threshold is overridable via `OPENCLAW_TEAM_EPIC_TODO_WARN_MS`.
- **`__team__` cards must declare `target`**: a card with `project: __team__` **must** carry a `target`, one of the two meanings — **framework change (write the repo)** ⇒ the **repo checkout root** on this host; **deploy/ops on live** ⇒ the **live team root** (`~/.openclaw/team`, i.e. `$OPENCLAW_HOME/team`). Both are this host's absolute paths; neither is a fixed literal (the repo may be checked out anywhere). Rationale: `spawn-lane` resolves cwd from `project` and, with **no `target`**, silently falls back to the **live** team root (`R-SESSION-1` cwd normalization) — so a missing `target` is exactly the hole through which a card "about the framework" ends up writing live. **A `__team__` card with no `target` is therefore a carding defect ⇒ hard red** (`check-card.mjs`: machine-readable `[role] <owner>` tag + exit≠0), not a soft warning.
  **Scope of the check = non-terminal cards only**: the gate catches a **carding-time** defect, so cards already in a **terminal** state (`done`/`failed`/`canceled`) are **grandfathered** — the gate does **not** retro-redden history (`check-card.mjs` narrows on `!TERMINAL.includes(status)`; `ready`/`todo`/`backlog` stay in scope, since `spawn-lane` exec auto-claims `ready`/`todo` and would land on `cwd=live`).

## 8. Phase 0 kickoff / requirement interrogation (design tree + frontier)

**Applies to**: new project kickoff, large multi-card requirements, ambiguous requirements, major plan changes. **Routine small cards may skip it.**

1. **Draw the design tree**: expand the requirement into a tree of "decision → branching sub-decisions → …", **without presupposing answers**.
2. **Compute the frontier**: only decisions whose prerequisites are settled are on the current frontier; decisions depending on undecided items belong to **later rounds**.
3. **Find facts yourself**: if a frontier question needs an environment lookup (files/code/materials) ⇒ **I use native tools directly** (read/grep/`web_search`); no subtasks, no asking the operator.
4. **Ask the whole frontier in one round**: each item carries **my recommended answer**; **≤3 questions per round** (prevent fatigue/perfunctory answers).
5. **Give the operator only the subset needing sign-off**: design disagreement/security & data safety/architecture direction ⇒ ask the operator via `ask_user`; the rest (technical feasibility, definition detail) I judge myself.
6. **After answers, recompute the frontier**, next round; **depth by scenario**: routine 1–2 rounds, major kickoff 3–5 rounds.
7. **Empty frontier = consensus reached** ⇒ proceed to Phase 1 (carding).

**Output**: design tree + settled decisions + frontier trail, saved to `workspace/<task-id>/design-tree.md` (new projects) or the card Background (small requirements).

## 7.1 seg usage (`R-SEGUSE-1`)

> A card carries **one Acceptance**; a `seg` is a further session *inside* one card. Opening segs is an execution-level tool, **not** a way to cope with "the card is big" — the team's actual practice for large work is to **split cards**. This clause fixes when a seg is legitimate.

- **Criterion (one line)**: ask whether the two segs are the **same Acceptance**. Same Acceptance ⇒ a seg *may* be legitimate (and only if it fits the whitelist below); different Acceptance ⇒ **split the card**.
- **The intuition, rewritten explicitly**: **"card is big ⇒ split the card"** (NOT "card is big ⇒ open a pile of segs"). Opening segs to cope with size uses an execution tool to hide "the breakdown was not done".
- **A seg is a session boundary, not a branch boundary**: all segments of one card share the same branch `<card-id>` and worktree, and run serially. There is no intra-card parallel lane.
- **seg whitelist (only these three; each must still share a single Acceptance)**:
  1. **the current lane cannot reach the environment** (the run must continue in another window — deterministic UUIDv5 + resume, `§6`);
  2. **bounded retry** where reopening the whole card costs more than re-running the failing seg;
  3. **independent verification isolated from the author** (fresh context, no anchoring — anti-confirmation-bias).
- **Parallelism is not a seg reason**: work that must proceed in parallel is **split into separate cards** (each with its own branch), or serialized. "≥2 mutually-exclusive file families + one acceptance" is a **split trigger**, not a seg reason — keeping them in one card would force them to run serially.
- **Split triggers (any one ⇒ split the card; do not open a seg)**: ① a **second independent Acceptance** appears; ② **≥2 independently-acceptable deliverables**; ③ a different **phase / delivery surface**; ④ a fix touching **more than one Acceptance**; ⑤ **different roles** must accept separately; ⑥ the parts **must run in parallel** (or are mutually-exclusive file families under one acceptance).
- **Anti-patterns (forbidden)**:
  ① opening a pile of segs because "the card is big" ⇒ the correct action is **split the card**;
  ② **phase / delivery-surface segmentation** ⇒ should be **epic child cards** (`R-DAG-1`, each with its own Acceptance/claim/acceptance);
  ③ **fix–fix–fix retry segments** ⇒ should be a **defect/fix card** (`R-DEFECT-1`);
  ④ "**the context is just too long**" is not a reason to open a seg — it is a reason to **split the card**.

## 7.2 Flow sampling (`R-FLOW-1`)

> Method home for the flow-triage rationale, the three locks and the rolling-sample arithmetic. The routing table, the hard boundary and the five-item quality spine are in `guides/flow-triage-sop.md` §10.5 (the normative body delegated by `R-FLOW-1`); this section references them and does not copy them (`R-ENG-1` clause 11).

**Rationale.** Routing by the **nature of the change** is what lets a small change take the short chain **without** weakening the machine gate — the gate's weight follows the change, never whether a gate exists. The short chain never traps an A-class change: one that crosses the hard boundary is re-routed to A on discovery.

**Three locks against "not built to design + spec not enforced"**:
① **design = contract** — no machine-verifiable block list/assertions ⇒ the UI card is invalid;
② **delivery gate mandatory** — red assertions ⇒ not deliverable;
③ **drift = defect class** — missing blocks / self-invented structure / silent simplification ⇒ **defect ticket + card `blocked` + revert through the `R-DEFECT-1` loop**, and a **missing conformance matrix ⇒ Elon sends the card back**.

**Card template scales with the flow**: **A** = 3+ Acceptance items (block list + machine-check assertions + screenshot comparison); **B/C** = 2 items (the applicable gate + the evidence pointer). What shrinks is the **Acceptance surface**, never the evidence requirement.

**Rolling sample (the statistical safety net)**: Turing machine-samples **20% per week** of the B/C cards that were accepted, and Jobs visual spot-checks **the same batch**; a drift found by the sample ⇒ defect ticket, and the finding tightens **the class**, not just the spot (never fix only the single occurrence). The sample is executed by Turing/Jobs; Elon **audits their reports** (he does not run it).

**Sampling rule**: the weekly unit is the **B/C cards accepted during that week**, counted **by card**; the sample size is **20% of that count, rounded to the nearest integer and never below 1** (`max(1, round(0.2 × N))` — so a week with a single accepted B/C card still samples that one). **Turing** draws the cards and re-runs the **machine assertions**; **Jobs** visual-spot-checks **the same batch**; both reports go to Elon as **one batch**, which is the report set he audits for the sampled cards (never card by card, and never a substitute for the per-card delivery evidence).

## 7.3 Jobs prerequisite task (`R-PREREQ-1`)

> A flow-A card whose implementation baseline is not frozen needs a design contract first.

1. **Trigger**: flow A whose baseline is an unfrozen design (in practice, every UI feature card sourced from Jobs). B/C reuse the frozen contract.
2. **Form**: Elon creates the prerequisite card (`assignee: jobs`, own Acceptance); Jobs produces the design contract (PRD / `DESIGN.md` / prototype structural contract + ui-align block list + machine-check points) in `workspace/<task-id>/`. The product design document still passes the Jobs-authors → Elon-confirms dual-sign gate.
3. **Dependency (hard)**: the development card carries `depends_on: [<prerequisite card>]`; while unmet it is `deps_unmet` and must not be claimed.
4. **Iteration stays inside the prerequisite card**: operator-facing design rounds are its production/review loop, not development segs; only the frozen output is handed to Linus.
5. **Re-entry**: if implementation proves the contract wrong or self-contradictory, Linus sets the card `blocked` and sends it back; Elon routes it to Jobs as a design change on the prerequisite, never a silent in-card deviation.
6. **Reuse**: once frozen, the contract serves every B/C card on that surface; it is produced once per surface.
