# Decision Quality SOP (`decision-quality-sop.md`)

> **Ownership / Maintainer**: **Elon** owns the normative rule, the escalation decision and this guide; every role applies it to every decision.
> **Status**: method library. The normative rule is `R-DECISION-1`; this file is its canonical body (`canonical=guide`). The owner block is a short pointer and does not restate these clauses (`R-LAYER-1`).
> **Applies to**: every role — Elon, Jobs, Linus, Turing and Assistant — at every decision point.
> **Effective**: 2026-10-18
> **Depends on**: `R-CONFIRM-1` · `R-DISC-5` · `R-AMBIG-1` · `R-OOB-1` · `R-ENG-1` · `R-SLA-7`
> **Reference convention**: a cross-role rule is `` `R-<DOMAIN>-<n>` ``; a guide's own section is `<guide-name> §<n>`; a bare `§<n>` means this file; never line-number anchors (`R-ENG-2`).

---

## 0. Object Declaration (read first)

1. **Object** — the object is the choice of which solution to implement at a decision point. It binds every role, including Elon.
2. **Decision points covered** — requirement interpretation, architecture and design, implementation approach, dependency and tool selection, test strategy, migration, release and rollback, documentation and process.
3. **Not a gate** — this guide does not replace `R-ENG-1` (acceptance), `R-CONFIRM-1` (confirmation) or `R-INCIDENT-1` (incident response), and it creates no new escalation channel.
4. **Two principles** — (1) decide on the five dimensions in §2; (2) choose the most correct, thorough, complete solution and never a stopgap, per §3.

---

## 1. Scope and Application

1. **Every decision point** — this guide applies whenever a role chooses between options, not only when writing a development plan.
2. **Every role** — the rule is carried in every role's `AGENTS.md`; no role is exempt.
3. **Initial and later decisions** — it applies to the first plan and to every re-decision: defect fix, scope change, fallback, rework.
4. **Not a substitute for correctness gates** — passing `R-ENG-1`, CI or acceptance does not make an incomplete solution complete.
5. **Record scales with the decision** — a trivial decision needs one line in the existing record; a material decision needs the full §6 record.

---

## 2. The Five Decision Dimensions (principle 1)

1. **Simple** — the fewest moving parts that **fully meet the requirement**; reuse before inventing; no speculative abstraction or future-proofing. "Simple" means the least accidental complexity for the complete requirement, never the least work or the fastest ship.
2. **Reliable** — correct on real paths, including boundaries, failures, retries, concurrency and recovery; no data loss, no silent failure, no reliance on timing or luck; idempotency and rollback are design properties.
3. **Maintainable** — the next owner can change it safely: localized edits, one responsibility per unit, no duplicated logic, clear extension points, explicit contracts.
4. **Efficient** — acceptable time, compute, memory, bandwidth, cost and operator attention across the whole lifecycle, not just the first run; efficiency is a design property, not a post-hoc optimization.
5. **Elegant** — fits existing patterns and seams; one clear responsibility; naming and structure express intent; no accidental complexity.
6. **Conflict rule** — all five are mandatory questions, not a scoring formula. When they conflict, choose the option that satisfies the full requirement with the least total complexity and risk, and record the trade-off per §6.
7. **No cheap synonyms** — never use *simple* or *efficient* as a synonym for *cheap*, *fast to build* or *temporary*. A cheaper option that leaves the requirement incomplete is rejected under §3; the most expensive option is not automatically correct either — the criterion is correctness and completeness, not gold-plating.
8. **Legacy vocabulary mapping** — `plan-quality.md` §3 keeps the plan-local words *simple, feasible, elegant, readable, maintainable*. **Feasible** is *simple* under the full constraint set; **readable** is a facet of *maintainable* and *elegant*. This guide owns the canonical decision-dimension wording; `plan-quality.md` references it and does not restate it.

---

## 3. The Most-Correct, Complete Solution (principle 2)

1. **Choose the complete solution** — select the most correct, thorough, complete solution that fully satisfies the requirement, not the first option that runs.
2. **Reject the cheapest stopgap** — reject the *cheapest* / *good enough for now* / *cope for the moment* option when it leaves any of: an uncovered Acceptance line, a known defect, a missing error or boundary path, an unowned follow-up, a manual step that should be automated, or an incomplete integration path (define → register → call, no dead code).
3. **Difficulty, duration and cost are not selection criteria** — high implementation cost or a large cost/consequence (effort, schedule, money, operational or reputational risk) is a reason to **escalate the decision to a superior** per §5, never a reason to silently choose an incomplete solution or a stopgap.
4. **Completeness test** — a solution is complete only when all of the following hold: every Acceptance line maps to an implemented step; the end-to-end path is integrated; normal, boundary, error, retry, concurrency, migration and rollback paths are handled; unit and integration tests cover normal, boundary and exception cases; no mandatory work is deferred to an uncarded follow-up; the decision record names the rejected cheaper option and why it is incomplete.
5. **Root cause over local patch** — prefer eliminating the cause; a local patch is allowed only as a bounded temporary measure under §4.
6. **No silent downgrade** — if the correct solution cannot be implemented within current authority, scope or budget, or its implementation cost is high or its cost/consequence is large, stop and escalate to a superior for a decision per §5. Do not implement the stopgap first and "fix it later" without the §4 record.
7. **Complete is not gold-plated** — completeness covers every Acceptance line and required quality attribute; it does not include speculative future-proofing or unrequested features.

---

## 4. Bounded Temporary Measures (the only legitimate exceptions)

1. **Incident mitigate-first** — restore service before root cause (`incident-response-sop.md` §4.1 · §4.2 · §5.3); the root cause and follow-up land in the postmortem action-item flow.
2. **Time-boxed CVE waiver** — only when no fix is immediately possible, there is a verified false positive, or the vulnerable path is unreachable; the waiver carries expiry, approver, registration fields and re-review (`dependency-cve-gate.md` §4.3).
3. **Release rollback or stop-the-bleed** — restore the previous verified version or a degraded mode (`release-versioning-sop.md` §5.2); a root-cause and regression card is mandatory under `R-DEFECT-1`.
4. **Named trigger** — one of the three classes above must apply. "It is hard", "it is slow", "the deadline is close" or "we need something that runs" is **not** a trigger.
5. **Correct emergency goal** — the measure restores safety or availability or protects data; it never claims the requirement is complete.
6. **Bounded** — explicit scope, named owner, expiry date or follow-up card id, and evidence that the bound is real. An open-ended "temporary" is forbidden.
7. **Trailed** — record it on the card (`task.comment kind=change` or `kind=note`), and create the follow-up card before the work closes; a defect follows the `R-DEFECT-1` loop.
8. **Never the final state** — the follow-up card is not optional; the temporary measure must not be accepted as the architecture or silently become permanent.

| Legal temporary measure | Forbidden stopgap |
|---|---|
| Incident rollback or degrade with a postmortem and follow-up card | "Refactor later" with no card, owner or expiry |
| CVE waiver with CVE id, rationale, expiry, approver and re-review | Permanent waiver or blanket package exemption |
| Release rollback to the last verified version | Shipping a known-incomplete fix and calling it done |

---

## 5. Escalation When Implementation Cost Is High

1. **Mandatory escalation trigger** — escalate to the superior for a decision whenever implementation cost is high or the cost/consequence is large (effort, schedule, money, operational or reputational risk), as well as when the correct solution exceeds the card's authority or scope, or the choice is disputed. High cost is never a reason to choose an incomplete solution unilaterally.
2. **Worker to Elon** — set the card `blocked` and send Elon the decision fork with options, recommendation, cost and duration, and the tail and risk of the cheap option (`R-DISC-5`; use `R-AMBIG-1` for an ambiguous requirement and `R-OOB-1` for work outside the role). Do not start the stopgap while waiting; proceed only after the superior confirms the decision.
3. **Elon to operator** — Elon decides routine items. Major, disputed, funds, security or architectural-direction items — including any decision whose implementation cost or cost/consequence is materially high — are escalated through `R-CONFIRM-1` (`confirmation-gate-sop.md` §2). Only Elon faces humans (`R-MSG-1`).
4. **Leader stalled** — if Elon is unreachable beyond the `leader_stalled` bound, a worker uses the `R-SLA-7` exception channel only (`sla-inspection-contract.md` §14); that channel exists for a leader stall and is not a general cost-escalation path.
5. **Content of the escalation** — state the complete solution, its implementation cost and duration, the cheaper option and its incomplete tail, the recommendation, and the exact decision needed.
6. **Outcome trail** — record the superior's decision on the card in the same turn (`R-DISC-8`).
7. **No parallel authority** — a worker does not ask another worker to approve a downgrade, and does not quietly choose the cheap option because Elon is busy or because the cost is uncomfortable.

---

## 6. Decision Record

1. **When** — every non-trivial decision; the record scales with the decision.
2. **What** — the options considered; the chosen option and why it is the most correct and complete; the rejected cheaper option and the specific incompleteness it would leave; the five-dimension trade-off, if any; the escalation outcome, if any.
3. **Landing point** — use an existing artifact, never a new one:

| Decision kind | Landing point |
|---|---|
| Development plan | `plan.md` |
| Decision fork | `design-tree.md` (`R-DISC-5`; `roles/elon/guides/carding-sop.md` §8) |
| Product or operations decision | the card's Background or Progress |
| Plan self-check | `plan-quality.md` §3 |

4. **No record, no claim** — a decision that skipped the record cannot later be defended as intentional.

---

## 7. Relationship to Gates and Other Rules

| Rule | Relationship |
|---|---|
| `R-ENG-1` | The acceptance gate. `R-DECISION-1` is the selection standard applied before and during planning; neither substitutes for the other. |
| `R-CONFIRM-1` | The confirmation gate. This rule adds a decision-quality dimension to what is confirmed; it does not bypass confirmation. |
| `R-DISC-5` | The decision-fork path to Elon; cost escalation uses it and does not replace it. |
| `R-AMBIG-1` / `R-OOB-1` | Ambiguous-requirement and out-of-duties handling; both return the card to Elon and are not downgrade licenses. |
| `R-SLA-7` | The only worker-to-operator exception channel; bounded to a leader stall. |
| `R-INCIDENT-1` / `R-CVE-1` / `R-VERSION-1` | Owners of the three legitimate exception classes in §4; this rule does not restate their mechanisms. |

---

## 8. Anti-Patterns (reject on sight)

**Anti-patterns (reject on sight)**:

- "Ship a minimal version first and fix it later" without the §4 bounds.
- "It is just a temporary workaround" with no owner, expiry or follow-up card.
- Choosing a tool or dependency because it is fastest to wire, when it cannot meet the correctness or reliability requirement.
- Deferring mandatory error handling, migration, rollback or tests to an uncarded follow-up.
- Treating "too hard" or "too long" as a reason to lower the standard instead of escalating.
- Copying an existing pattern that is known to be incomplete because it is familiar.
- Calling a cheaper option "simpler" when it leaves the requirement incomplete.

---

## 9. See Also

> See: `R-DECISION-1` (this rule) · `plan-quality.md` §3 (the plan-local projection) · `confirmation-gate-sop.md` §2 and `sla-inspection-contract.md` §14 (escalation paths) · `incident-response-sop.md`, `dependency-cve-gate.md` and `release-versioning-sop.md` (the bounded exception classes).
