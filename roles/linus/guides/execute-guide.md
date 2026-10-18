# Execution Guide (Phase 3: Execute Plan)

> **This guide = the detailed method for development process Phase 3** (TDD/coverage/evidence gate/cross-segment contract).
> Usage: first follow the "Execution Checklist" item by item; "Details" is the concrete reference for each step, consult as needed.
>
> **Layer**: role method library (`R-LAYER-1`). **Owner**: Linus. **Effective**: 2026-10-16.
> **On conflict**: the shared-rule block in `roles/linus/AGENTS.md` governs, then this guide.
> **Single-home boundary**: this guide is the home for the TDD decision table, the coverage grading
> and the evidence gate. The Report slots belong to `team/guides/worker-report-template.md`; the
> commit-path rule belongs to `R-SESSION-1` + redline 7; the segment/`state.md` contract belongs to
> `R-SEG-1` — all three are **referenced** below, never restated.

---

## ✅ Execution Checklist (Todo)

> **Iron rule**: the **only legitimate source** of the task list is the plan file (`plan.md`); inferring from conversation context is forbidden. No plan.md => first return to Phase 1.

- [ ] 1. **Read `plan.md` to get the task list** (item-by-item tasks + `[ADD]/[DELETE]/[MODIFY]/[integration]` markers)
- [ ] 2. **Make a TDD decision + size grading for each task** (see §TDD decision table / §Coverage grading)
- [ ] 3. **Walk the loop**: development → unit test loop → integration test loop → E2E (when frontend is involved)
- [ ] 4. **Evidence gate**: before each task is completed, evidence must be complete (see §Evidence gate)
- [ ] 5. **Commit immediately after each task's loop** (`feat(scope): desc` + coverage info)
- [ ] 6. **Multi-segment spawn => obey the cross-segment contract**: at segment end append a state.md snapshot; at the next segment's start read state.md first
- [ ] 7. **Do not skip failures**: test failure / coverage below target / dependency has a bug => fix, do not skip, do not lower requirements (see §Mandatory constraints)
- [ ] 8. **Keep the heartbeat fresh while executing** — refresh `heartbeat_at` at ≤10 min intervals
  (redline 2). Phase 3 is where a card runs longest, and a card whose heartbeat has gone stale reads
  to Elon as a dead lane.
- [ ] 9. **Segment close-out (all three, or the segment did not complete)**: refresh the heartbeat →
  set the card's terminal state → send Elon a Report (conclusion + card path + hash). "Finish then
  quit" distorts card state and makes Elon wait idly.
- [ ] 10. **Before `in_review`: every machine-gated item has a home and is satisfied** — the card's
  `## Report` carries the required slots of `team/guides/worker-report-template.md` (common core
  `A1`…`A8` plus Linus's `L1`…`L6`; `team/scripts/check-report.mjs` machine-checks the common core on
  `in_review` cards), and every delivery task is committed with **explicit paths**
  (`git commit -- <paths>`, `R-SESSION-1` / redline 7 — a bare `git commit` sweeps another lane's
  unstaged hunks out of the shared index).

### N/A policy (same principle as `verify-guide.md` §N/A conditions)

A step may be marked N/A **only after you have searched and confirmed the thing it checks does not
exist**. "It looks unrelated" is not N/A; "grep + read showed there is no such call path" is. Record
the N/A and the search that justified it — an unexamined N/A is indistinguishable from a skipped step.

---

## Details

### TDD decision table

| Task characteristic | TDD |
|---------|-----|
| Complex business logic / brand-new feature / new API | ✅ Enable (RED→GREEN→REFACTOR) |
| Bug fix (has existing tests) | ⚠️ Optional |
| Refactor (unchanged interface) / config constants / data migration | ❌ Disabled (but must not skip tests) |
| Frontend UI styling | ⚠️ TDD if the component logic is complex |

> Note: pure CRUD APIs also need TDD — they most easily produce import path errors, response body breaks, and status code deviations; they are the type with the largest gap between grep verification and runtime.

### Task size → coverage grading

| Size | Code volume | Unit test | Integration test |
|------|--------|------|--------|
| Micro | <30 lines with no business logic | ≥60% | Optional |
| Small | 30-100 lines | ≥75% | ≥30% |
| Medium | 100-300 lines | ≥80% | ≥40% |
| Large | >300 lines/multi-module | ≥85% | ≥50% |

Branch coverage additionally ≥60% (command see AGENTS.md "Test Discipline"; choose `pytest --cov` / `jest --coverage` / `c8` per the project test suite).

### Task-level loop (Phase 1-4)

- **Phase 1 Development execution**: TDD tasks go RED→GREEN→REFACTOR; non-TDD tasks are implemented directly but **must not skip tests** (at least the normal path + 1 exception path).
- **Phase 2 Unit test loop**: coverage counts only files involved in the current task; loop limit 5; two consecutive iterations with no coverage improvement (<1%) → report.
- **Phase 3 Integration test loop**: coverage scope: API endpoints / Service public methods / CRUD operations involved in this task. Loop limit 5.
- **Phase 4 E2E (when frontend is involved)**: trigger conditions: touches `.vue`/interaction flows/WebSocket/explicit user request.

### Evidence gate (Task Completion Gate)

Before any task goes `in_progress` → `completed`, there must be a verifiable artifact:

| Phase | Evidence | Check |
|------|------|------|
| Development | lint/compile output | `ruff check` / `vue-tsc --noEmit` |
| Unit test | pytest + coverage | `pytest --cov` |
| Integration test | pytest + API smoke | integration test output |
| E2E | Playwright output | `npx playwright test` |

**No evidence output = the task does not count as complete.**

#### Integration test three cases (required for every API endpoint)

Permission check (no token→401) | success path (valid→200+expected body) | business error (correct code/message + status).

> The three respectively expose: route not registered (404), import/signature error (500), response body structure break (frontend cannot get the field).

### Test environment probing

Dependencies are auto-probed from project docs (not hardcoded), priority: project `CLAUDE.md` > project `README.md` > `.env.example` > docker-compose.

### Test data management priority

Existing fixture > factory function (factory-boy) > test SQL script > mock (last resort).

### Mandatory constraints: do not skip problems

| Problem type | Handling | Forbidden |
|---------|------|------|
| Test failure | Fix the code or the test | Skip/comment out/mark xfail |
| Coverage below target | Add tests | Lower the requirement |
| Existing code has a bug | Fix it | Mark "known issue, not handled for now" |
| Dependency module has a problem | Fix the dependency | Assume it works |
| Environment problem | Resolve the environment | Skip that test |

**Backoff**: environment problems at most 3 times (2s→4s→8s); insufficient coverage 5 times; two consecutive iterations with no progress → terminate early and report.

### Regression test shield

Before a fix loop: snapshot backup of the code → run related regressions → confirm pass before fixing → full regression after the fix. Key constraint: a fix must not break existing functionality.

### Cross-segment consistency contract (`R-SEG-1`)

Full rule of record: `R-SEG-1`. What matters when you are the one walking Phase 3:

- **Segment end** — **append** a completion snapshot to `workspace/<task-id>/state.md` (goal /
  implemented / key decisions with reasons+constraints / conventions / pitfalls / leftovers /
  expected input for the next segment). **Missing ⇒ the segment does not count as completed.**
- **Segment start** — read the whole `state.md` before spawning, and inject it into the next
  segment's prompt. Missing ⇒ **do not spawn**. (`spawn-lane` also requires the `handoff.md`
  four anchors — `guides/spawn-lane-sop.md`.)
- **Overturning a prior decision** — say so explicitly in `state.md` ("overturn segment N decision
  X, reason Y"); silent drift is a defect.
- **Verifiable cross-segment interfaces** (field names / constants / signatures) — pin them with
  contract assertions in the tests rather than trusting the prose.
- **Carrier layering** — the card's `## Progress` carries segment-level *milestones*; `state.md`
  carries segment-level *decisions and definitions*.

### Git commit

Commit immediately after each task's loop ("commit immediately after each logical feature point is
done"). Single task format: `feat(scope): desc` + coverage info. After all tasks, if there are
cross-task common changes, do one summary commit.

> **Rule of record: `R-SESSION-1` + redline 7** — always `git commit -- <explicit paths>`; a bare
> `git commit` / `git commit -a` is forbidden, because the shared index gets swept up by another
> lane's concurrent commits. Not restated here on purpose (`R-LAYER-1`).

---

## Common mistakes

| Mistake | Consequence |
|---|---|
| Inferring tasks from the conversation, not reading plan.md | Deviates from the plan, rework |
| Non-TDD task skips tests | False completion, no regression protection |
| Marking completed without evidence | Cannot be re-verified, equivalent to not done |
| Lowering requirements when coverage is below target | Quality gate breached |
| Marking a test failure as xfail | Masks real defects |
| Multi-segment spawn without writing state.md | Inter-segment cognition drift, inconsistent conventions |
