# Verification Guide (Phase 4: Verify Plan)

> **This guide = the detailed method for development process Phase 4** (quality gate/traceability matrix/smoke/pre-delivery wrap-up).
> Usage: first follow the "Execution Checklist" item by item; "Details" is the concrete reference for each step, consult as needed.

---

## ✅ Execution Checklist (Todo)

> **Core principle**: reading code can be delegated to a "read-only tool"; but verification that "the code actually works" (running tests/import/curl) **must be performed by Linus himself**, and cannot be outsourced.

- [ ] 1. **Requirement→code traceability**: for each requirement, Read the code to confirm the behavior is really implemented (not just grep symbols) (Details §Phase 1)
- [ ] 2. **Run compile/import yourself**: `python -c "import X"` / `vue-tsc --noEmit` / `ruff check` (ImportError/SyntaxError = fatal)
- [ ] 3. **Dead code/caller verification**: is the old code really deleted? Does the new API have a frontend caller? Is the scheduled task registered? (Details §Phase 1)
- [ ] 4. **Parameter passing completeness**: signature changes traced hop by hop (API→Service→CRUD→DB) (Details §Phase 1)
- [ ] 5. **Standards compliance**: unified wrapper/logging/interface contract three checks (Details §Phase 2)
- [ ] 6. **Run tests + coverage yourself**: `pytest --cov-report=term-missing` to drill into the details (Details §Phase 3)
- [ ] 7. **Requirement→test traceability matrix**: each REQ-xxx mapped to a specific `test_xxx`, no coverage = FAIL (Details §Phase 3)
- [ ] 8. **API endpoint three cases complete**: permission (401)/success (200)/business error, missing any = FAIL
- [ ] 9. **Endpoint smoke**: really send the request (404/500 = fatal) (Details §Phase 4)
- [ ] 10. **E2E** (when frontend is involved): Playwright verifies the key user path
- [ ] 11. **Requirement doc sync assessment**: new tables/fields/API changes => does the design doc need syncing
- [ ] 12. **Pre-delivery quality wrap-up**: Code review (self-check) / dead code cleanup / standards three checks => write each one into the Report
- [ ] 13. **Documentation impact determination (PROTOCOL ⑫)**: does this diff involve [interface/data structure/architecture/config/convention]? Involved => sync the design doc (or list it in the Report as pending sync); not involved => declare "no documentation impact"
- [ ] 14. **Write the Report**: Acceptance item-by-item checklist (requirement/done?/evidence); write unfinished items truthfully, do not mark done

---

## Details

### Phase 1: Code evidence + impact scope

#### Requirement→code traceability (two-level verification)

- **Level 1 (symbol existence)**: grepping the function name = the minimum bar; if the symbol does not exist, direct FAIL.
- **Level 2 (logic verification)**: Read the function body, confirm "the behavior described by the requirement is really implemented". Example: "60-second cache" requires seeing `cache_ttl=60` or `timedelta(seconds=60)`, not passing merely because the function name was grepped.

#### Git state awareness

Before verification run `git diff --stat` to detect whether the working tree is dirty. If dirty: use `git show HEAD:<file>` to read the committed version to judge "whether the task is complete", and record working-tree differences as deviations. Priority: **HEAD > working tree**.

#### Dead code cleanup (plan-driven)

When the plan has "replace/migrate/refactor" tasks, verify the old code is really deleted: old functions/old imports/old components/old CSS/commented-out code blocks/old constants.

#### New code caller verification (three modes)

- **API→frontend**: for a new API endpoint, does the frontend have a corresponding call? (No → FAIL "dead interface")
- **Scheduled task→startup**: for a new scheduled task, is it registered at the startup entry? (No → FAIL "never runs")
- **Function→caller**: does a new function have ≥1 non-test caller? (Only test references → ⚠️; none → FAIL "island")

#### Parameter passing completeness

When a signature changes, trace hop by hop `API handler → Service → CRUD → ORM/DB`, confirm the new parameter is passed down at every hop. A typical bug: B drops new_flag when calling C.

> 🧭 **gitnexus can cross-verify**: `detect_changes()` checks the impact surface of this change; `impact({target, direction:"upstream"})` checks whether all callers are adapted (refresh if the index is stale, see plan-guide Pattern 2).

### Phase 2: Standards compliance review

Style (naming/indentation/import order), security, database review. Compile/type/SQL compile verification must be performed yourself.

### Phase 3: Tests + coverage + requirement→test traceability

**3.1 Run the tests (yourself)**: `pytest <test> --cov --cov-report=term`, cannot merely grep that test files exist.

**3.2 Cross-verify the planned test list**: for each test case name declared in the plan, grep to confirm `def test_xxx` exists. Missing → FAIL (pytest only reports "tests that were written", not "tests not written").

**3.3 Requirement coverage verification**: for each verification requirement point in the plan, search for the corresponding assert. No assertion coverage → FAIL.

**3.4 Requirement→test traceability matrix (core)**: each requirement REQ-xxx mapped to a specific `test_xxx` function (a vague conclusion like "whole file covered" is not allowed).

| Condition | Conclusion |
|------|------|
| All requirements covered by test functions | PASS |
| Some requirement has no test | FAIL (requirement not tested) |
| Only integration coverage, no unit test | WARNING |
| Test content does not match the requirement | FAIL (test mismatch) |

**API endpoint integration test completeness**: permission (401) / success (200) / business error three cases, missing any → FAIL.

### Phase 4: Endpoint smoke + E2E

**Endpoint smoke**: for each new/modified API, really send a request to verify. Verdict: 200/201 with business code=success → pass; 404 → route not registered (fatal); 500 → service exception (fatal).

> A bare curl 401 only proves "the route exists"; a token-bearing request proves "the business runs".

**E2E**: when frontend is involved, use Playwright to verify the key user path.

### Phase 5: Requirement doc sync

When new tables/fields/API format changes are added, check whether the design doc needs to be synced.

### N/A conditions (not all checks apply)

Key judgment principle: **you must first search and confirm "the content the check focuses on really does not exist in the project" before marking N/A**; you cannot skip just because "it looks unrelated".

Common N/A: no API change→API call-chain tracing N/A; pure backend→frontend call-chain N/A; no plan file→requirement traceability N/A; no CRUD→CRUD integration test N/A, etc.

### Pre-delivery quality wrap-up (same level as "Test Discipline" and "Requirement Completion Acceptance")

> After development + testing are complete, **before marking done** three items must be completed; **if not done, done must not be set**.
> **Standards basis**: defer to the project's **existing finalized** standards (e.g. `docs/design-docs/architecture/api-spec-design.md`). **Where standards are not finalized** => follow current best practices and mark "**pending standard**" in the Report.

1. **Code review (self-check, not a formality)**: read through this diff against the requirements, check naming/structure/boundaries/exceptions/duplication/readability; judge "can it be simplified"; judge for bad smells (long functions, deep nesting, magic numbers, implicit coupling, error swallowing, duplicate implementations). **For each problem found**: fix it / write down the "reason for keeping".
2. **Dead code check and cleanup**: clean up dead code/unused imports/unreachable branches/abandoned stubs/commented-out old code/orphan files within this change and the touched scope; **write each one into the Report** (what was cleaned + why it is safe; **if unsure, do not delete, list it as a doubt**).
3. **Development-standards compliance self-check (the project's own standards) — three checks**:
   - **Unified wrapper utility classes**: where the project's unified utilities/wrappers should be used, do not write your own (time ↔ `core/time`; storage ↔ `core/storage`; logging ↔ `core/logger`; JSON ↔ pydantic; response ↔ the established envelope);
   - **Logging standards**: log according to the project's logging standards; `print` / custom formats are forbidden;
   - **Interface standards**: API / internal interfaces implemented per the established contract; do not start your own;
   - **Write the three-check results into the Report item by item**: compliant ✔ / deviation found (fixed) / standards gap found (report to Elon).

---

## Common failure modes (high-frequency lessons)

| Mode | Prevention |
|------|------|
| Looking only at task status, not checking the code | Always grep for evidence |
| Tracing only same-language calls, ignoring API/WebSocket/message links | Cover all communication methods |
| Marking pass without running tests | Always run tests and check pass rate + coverage |
| Checking only pass rate, not coverage | Check both |
| New code not wired into business logic | Trace every new symbol's call chain to a business entry point |
| Old code left behind after refactor | Search old symbol names to confirm deletion |
| Mock DB tests bypass SQL compilation | Do dialect-aware SQL compile verification |
| Continuing after a unit test failure | Stop on any test failure, continue only after fixing |
| Trusting a sub-session's grep, not running it yourself | Running tests/import/curl must be done yourself |

---

## Reporting mechanism

The Report must attach: **Acceptance item-by-item checklist** (requirement / done? / evidence) + **requirement→test traceability matrix** + **pre-delivery quality wrap-up three items** (Code review conclusion / dead code list / three-check results).
