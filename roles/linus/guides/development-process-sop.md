# Linus Development-Process SOP (role-owned)

> Method home for the Development-Process SOP section of `roles/linus/AGENTS.md`.

## Development-Process SOP (mandatory: Plan → Check Plan → Execute Plan → Verify Plan)
> Requirement development **always starts from a Plan**; writing code directly is not allowed. **Details in `~/.openclaw/workspace-linus/guides/`**: `plan-guide.md` (phases 1-2) / `execute-guide.md` (phase 3) / `verify-guide.md` (phase 4); this section is only the skeleton.
> **Pre-delivery gates (gate 0️⃣ impact scope + omissions, especially frontend / gate 1️⃣ data-param breakage — highest priority)**: self-check item by item; missing any one forbids done.

> **Decision-branch prerequisite (mandatory for complex plans)**: a plan with a **decision branch** (multi-option selection, undefined definition, undecided paradigm, architecture options) **must draw the "design tree + frontier" before writing plan.md**:
> ① **Design tree**: expand the plan into "decision → branching sub-decisions → …", without presupposing answers;
> ② **Frontier**: only decisions whose prerequisites are settled are on the current frontier (those depending on undecided items belong to later rounds);
> ③ **Find facts yourself**: a prerequisite needing an environment lookup (code/docs/dependencies) ⇒ look it up yourself; do not ask Elon;
> ④ **Ask the whole frontier in one round**: send back only the "needs Elon sign-off" subset (tech-selection disagreement/definition disagreement/large impact), each with **your recommendation**; the rest you decide;
> ⑤ after answers, recompute the frontier, next round; **only an empty frontier proceeds to Phase 1 to write the plan**.
> ⇒ Output to `workspace/<task-id>/design-tree.md` (or the first section of plan.md). **Branch-free simple cards proceed as before, no ceremony.**

### Phase 1: Produce the Plan
1. After taking the card, first have a Claude Code sub-session write `plan.md` (into `~/.openclaw/team/workspace/<task-id>/plan.md`): requirement breakdown, implementation plan, files involved, test-scenario coverage points, execution-step todos (tagged `[ADD]/[DELETE]/[MODIFY]/[integration]`), acceptance points.
2. The plan file is the **sole task source** for subsequent execution; never infer tasks from conversation context ad hoc.

### Phase 2: Check the Plan
1. Self-check plan.md item by item — **all six**. The canonical list is `team/guides/plan-quality.md` (① logical completeness · ② omission · ③ quality (simple·feasible·elegant·readable·maintainable) · ④ end-to-end execution path · ⑤ test-scenario coverage · ⑥ todo check); **referenced, not restated here** (`R-LAYER-1` — the same text in two places is a violation).
2. **④ is unconditional**: the end-to-end path (vertical path + per-hop up/downstream impact + side effects/consumers) is required for **every** plan, including changes touching no interface or field. The interface/field-change specialisation (call-chain tracing + the 5 parameter-break types + Breaking determination) is an *addition* to ④, never a replacement.
3. If the check fails → back to Phase 1 and revise; a blocking defect → must not proceed to execution. Record the verdict (**execute as-is / execute after revision / needs rewrite**).
4. Details: **six-item checklist (team) + method-per-check (role)** — the checklist is `team/guides/plan-quality.md`, the per-check methods `~/.openclaw/workspace-linus/guides/plan-guide.md`.

### Phase 2.5: Elon Confirmation (mandatory; every task must pass this gate)
1. After the self-check passes, **`sessions_send` back to Elon** (agent:main:main) with: ① the plan.md absolute path; ② a one-line goal; ③ a summary of key decisions/technical approach; ④ open items needing confirmation/disputed.
2. **Enter Phase 3 execution only after Elon confirms** — no confirmation, no action. A hard gate, not optional.
3. Elon may confirm directly, send back for revision (to Phase 1/2), or escalate to operator review (in which case expect extra waiting).

### Phase 3: Execute the Plan
1. **Walk the closed loop task by task**; each task: TDD decision → develop → unit-test loop → integration-test loop → E2E (if frontend).
2. **TDD decision + size grading per task** — the TDD decision table (new feature / new API / complex logic ✅ RED→GREEN→REFACTOR · bug fix ⚠️ optional · pure refactor / config / migration ❌ but tests are never skipped) and the coverage grading (micro ≥60% / small ≥75% / medium ≥80% / large ≥85%; integration ≥30-50%; branch ≥60%) are the **home of `~/.openclaw/workspace-linus/guides/execute-guide.md`** — read the numbers there, not from memory.
3. **Evidence gate**: before each task is `completed` you must have — lint/compile output, unit-test + coverage output, integration-test output (API endpoints with 401/200/business-error 3 cases), E2E output. No evidence = not complete. (Table: `execute-guide.md` §Evidence gate.)
4. Immediately git commit after each task completes — `git commit -- <explicit paths>` (`R-SESSION-1` / redline 7), never a bare `git commit`.
5. **Cross-segment consistency contract** (`R-SEG-1`, mandatory): when a task is split into multiple spawned sub-sessions, `workspace/<task-id>/state.md` is the **only** carrier between them — append a snapshot at segment end (or that segment does not count as completed), read the whole file before the next spawn (or do not spawn), trail any reversal of an earlier decision explicitly. **Rule of record: `R-SEG-1`**; the Phase-3 walkthrough is `execute-guide.md` §Cross-segment consistency contract.

### Phase 4: Verify the Plan
0. **Completion self-verification = two ordered passes** (the "did we finish, correctly" gate):
   ① **Plan conformance** (against `plan.md`): every planned task done as specified — **no silent deviation, no scope creep, no leftover/unimplemented item**, no work beyond the plan;
   ② **Requirement conformance** (against the card): the "Requirement-Completeness Acceptance" below — Acceptance item-by-item + Background/goal omitted-item check + the requirement→test traceability matrix.
   Only after **both** pass → write the Report (plan-conformance table + Acceptance checklist + evidence) → set `in_review`. Neither pass alone is deliverable.
1. After all tasks run, do the **quality gates**:
   - **Requirement→code traceability**: for each requirement, not only grep symbols but Read the code logic to confirm "the behavior described by the requirement is really implemented";
   - **Compile/import verification**: run `python -c "import X"` / `vue-tsc --noEmit` / `ruff check` yourself; ImportError/SyntaxError = CRITICAL;
   - **Dead code/callers/parameter completeness**: when the plan had a replacement task, verify the old code was really deleted; a new API has a frontend caller, a scheduled task a startup registration, a function business callers;
   - **Requirement→test traceability matrix**: each requirement REQ-xxx maps to a concrete test_xxx; no coverage = FAIL;
   - **Endpoint smoke**: interfaces that can be curl/smoke-verified must be actually requested and verified (404/500 = CRITICAL).
2. **Executor-separation principle**: reading code/building mappings may be delegated to a Claude Code sub-session; but "running tests/coverage/import/curl/smoke" — these **code-running actions must be done by Linus personally with Bash**, not merely grepped by a sub-session.
3. Detailed six phases and criteria are in `guides/verify-guide.md`.

> This section (four-phase SOP) + Test Discipline + Requirement-Completeness Acceptance must work together: Phase 2's "test-scenario coverage" is the prerequisite for Phase 3's TDD; Phase 4's "requirement→test traceability matrix" is how Requirement-Completeness Acceptance is landed.

### Pre-Delivery Quality Close-out (mandatory; same level as "Test Discipline" and "Requirement-Completeness Acceptance")
> After development + testing, and **before setting done**, three items must be completed; **not done ⇒ no done**.
> **Methods and item-by-item definition: `~/.openclaw/workspace-linus/guides/verify-guide.md` §Pre-delivery quality wrap-up** — **① code review (self-review) · ② dead-code check & cleanup · ③ norm triple-check** — and the Report must attach their results (referenced, not restated here — `R-LAYER-1`).
> **Normative basis**: the project's **existing finalized docs** (`docs/design-docs/architecture/API-spec-design.md` etc.). **Where the norm is not finalized** → follow **current best practice** and mark "**pending norm**" in the Report (do not invent norms, do not change shared norms).

> **Segment close-out mandatory items (missing any one ⇒ the segment does not count as completed)**: before a sub-session segment ends, **three things are mandatory**: ① **refresh heartbeat** (`heartbeat_at` to now); ② **set the card terminal state** (status: done/canceled/blocked, check Acceptance); ③ **send Elon a Report** (conclusion + card path + commit hash).
