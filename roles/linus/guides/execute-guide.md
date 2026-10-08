# Execution Guide (Phase 3: Execute Plan)

> **This guide = the detailed method for development process Phase 3** (TDD/coverage/evidence gate/cross-segment contract).
> Usage: first follow the "Execution Checklist" item by item; "Details" is the concrete reference for each step, consult as needed.

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

### Cross-segment consistency contract (PROTOCOL ⑥.0)

- **Segment end**: **append** a "segment completion snapshot" to `workspace/<task-id>/state.md` (segment goal/implemented/key decisions with reasons+constraints/conventions/pitfalls/leftovers/expected input for the next segment), otherwise that segment does not count as completed.
- **Segment start**: before spawn, **first read the full state.md**, inject it into the next segment's prompt, otherwise do not spawn.
- **Overturning a previous segment's decision**: write explicitly in state.md "overturn segment N decision X, reason Y", no silent drift.
- **Consistency verification**: for cross-segment interfaces/conventions that are verifiable, add contract assertions in tests.

### Git commit

Commit immediately after each task's loop ("commit immediately after each logical feature point is done"). Single task format: `feat(scope): desc` + coverage info. After all tasks, if there are cross-task common changes, do one summary commit.

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
