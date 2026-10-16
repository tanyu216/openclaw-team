# Plan Quality Checklist (Linus — plan self-check)

> Companion to `roles/linus/AGENTS.md` **Phase 2** and `PROTOCOL §6.1`. Used before
> execution; a plan that fails any required item must not proceed.

## The six checks

### 1. Logical completeness
Self-consistent, no contradictions, no holes. Each step's input exists by the time
it runs; no step depends on something a later step creates.

### 2. Omission check
Every new item has a **full integration path**: definition → registration → call
(no dead code), and **nothing from the requirement is missing** — every Acceptance
line maps to at least one plan step.

### 3. Quality — simple, feasible, elegant, readable, maintainable
- **Simple & feasible**: the fewest moving parts that actually works with the
  available tools, skills and time; reuse before inventing; no speculative
  abstraction or future-proofing. If a simpler option exists, the plan must say why
  it was rejected.
- **Elegant**: fits the existing patterns; one responsibility per unit; a clear
  seam; no accidental complexity; naming and structure express intent.
- **Readable**: a reviewer can follow it top-down without extra context; no magic
  values, no hidden coupling, no surprising control flow.
- **Maintainable**: safe to change — localized edits, no duplicated logic, clear
  extension points; **failure / retry / idempotency** considered; no fragile
  ordering, no reliance on luck (timing, races).
- If any of these is weak, the plan must state the trade-off explicitly and prefer
  the simpler/clearer option.

### 4. End-to-end execution path (UI → API → persistence → back)
Trace the **full vertical path** — e.g.
`UI event → UI state → API/route → handler/controller → service/domain → storage (DB/queue/fs) → response → UI render`.
For **every hop**, state the **upstream/downstream impact**:

| Hop | Check |
|---|---|
| UI → API | payload shape, validation, auth, error surfaces, loading/empty/error states |
| API → service | contract/DTO, transactions, idempotency |
| service → storage | schema/migration, indexes, nullability, rollback, persist/read-back consistency |
| storage → response | serialization, pagination, envelope/error codes |
| response → UI | cache invalidation, refetch, optimistic vs server truth |

Also list **side effects** (jobs, webhooks, notifications, cache, search index) and
**consumers** of anything whose shape changes (other services, frontends, cron).

### 5. Test-scenario coverage
Each requirement states its **unit + integration** coverage points, including the
real branches/boundaries/error paths (not just the happy path).

### 6. Todo check
Execution steps are well-formed, actionable, ordered, and match the plan; markers
`[ADD]/[DELETE]/[MODIFY]/[integration]` are consistent with the file list.

## Output
- The check results are recorded in the plan (or the card's Progress); failures
  return to Phase 1. Blocking defects stop execution.
