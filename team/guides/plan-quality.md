# Plan Quality Checklist (Linus — plan self-check)

> Companion to `roles/linus/AGENTS.md` **Phase 2** and `PROTOCOL §⑥.1`. Used before
> execution; a plan that fails any required item must not proceed.

## The six checks

### ① Logical completeness
Self-consistent, no contradictions, no holes. Each step's input exists by the time
it runs; no step depends on something a later step creates.

### ② Omission check
Every new item has a **full integration path**: definition → registration → call
(no dead code), and **nothing from the requirement is missing** — every Acceptance
line maps to at least one plan step.

### ③ Simplicity & reliability (is it simple and reliable?)
- **Simplest reliable design**: fewest moving parts; no speculative abstraction or
  future-proofing; reuse before inventing.
- **Failure modes**: what breaks, what happens then, is it retryable/idempotent?
- **No fragile ordering / hidden coupling**; no reliance on luck (timing, races).
- If a simpler option exists, the plan must say why it was rejected.

### ④ End-to-end execution path (UI → API → persistence → back)
Trace the **full vertical path** — e.g.
`UI event → UI state → API/route → handler/controller → service/domain → storage (DB/queue/fs) → response → UI render`.
For **every hop**, state the **upstream/downstream impact**:

| Hop | Check |
|---|---|
| UI → API | payload shape, validation, auth, error surfaces, loading/empty/error states |
| API → service | contract/DTO, transactions, idempotency |
| service → storage | schema/migration, indexes, nullability, rollback, 落库/读回一致性 |
| storage → response | serialization, pagination, envelope/error codes |
| response → UI | cache invalidation, refetch, optimistic vs server truth |

Also list **side effects** (jobs, webhooks, notifications, cache, search index) and
**consumers** of anything whose shape changes (other services, frontends, cron).

### ⑤ Test-scenario coverage
Each requirement states its **unit + integration** coverage points, including the
real branches/boundaries/error paths (not just the happy path).

### ⑥ Todo check
Execution steps are well-formed, actionable, ordered, and match the plan; markers
`[ADD]/[DELETE]/[MODIFY]/[integration]` are consistent with the file list.

## Output
- The check results are recorded in the plan (or the card's Progress); failures
  return to Phase 1. Blocking defects stop execution.
