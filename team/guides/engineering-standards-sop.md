# Engineering Quality Standards SOP (`engineering-standards-sop.md`)

> **Ownership / Maintainer**: **Linus** owns the engineering method; **Turing** owns independent
> verification (including the test-case realism check); **Elon** accepts against the checklist.
> **Status**: method library (`L2.5`). The **normative checklist** is `PROTOCOL §6.1` (14 clauses);
> this file carries the methods, examples and checklists those clauses point at. It **references**
> the clauses and does not restate them (`PROTOCOL §6.1` clause 11).
> **Role-owned method homes**: Linus's `roles/linus/guides/testing-and-delivery-sop.md` (test
> discipline, prototype consumption, frontend stack defaults, requirement completeness) and
> `roles/linus/guides/development-process-sop.md` (phased development); Turing's
> `roles/turing/guides/duties-sop.md` (acceptance duties and the realism check).

---

## 1. TDD and coverage (`PROTOCOL §6.1` clauses 1–2)

- One feature point → one failing test written first → implement → go green. "Code then tests" is
  the forbidden order, not merely a weaker preference.
- Unit coverage is measured at delivery (`pytest --cov` / `jest --coverage` / `c8`) and reported as
  totals plus line and branch coverage. Below **80%** the card cannot be set to `done`: explain the
  gap and add tests.
- The TDD decision table (new feature / new API / complex logic ⇒ RED→GREEN→REFACTOR; bug fix ⇒
  optional; pure refactor / config / migration ⇒ no new test) and the coverage grading by task size
  live in `~/.openclaw/workspace-linus/guides/execute-guide.md`. Tests are never skipped — only the
  RED-first ceremony is waived.

## 2. Mock boundary and integration tests (`PROTOCOL §6.1` clauses 3–4)

- Mock **external I/O and external systems only**: http / db / redis / mq / filesystem /
  third-party SDK / clock and randomness sources. **Never mock internal functions** (pure functions,
  private methods, directly-called logic within the module) — that produces "fake green" and hides
  real regressions.
- Integration tests are essential:
  - ≥1 case for the core flow (end-to-end main path);
  - **≥1 case per public API endpoint** (real routing / serialization / DB or test DB / middleware);
  - avoid mocking where possible, or mock only uncontrollable external services;
  - each case verifies: HTTP status code + key response body fields + side effects (DB write, cache).
- API endpoint tests carry the three cases that make the endpoint's contract real: 401, 200, and a
  business-error path. Evidence table: `roles/linus/guides/development-process-sop.md` Phase 3.

## 3. Self-proof and requirement completeness (`PROTOCOL §6.1` clauses 5–6)

- The Report attaches **command + exit code + output summary + coverage number + unit/integration
  case count** — never the bare claim "tests pass".
- After Claude Code finishes, run the requirement-completeness pass: copy out the card's Acceptance
  and verify each line against the artifact. The Report carries an **Acceptance line-by-line
  checklist** (requirement / done? / evidence). Unfinished items are written honestly; a green test
  suite is not evidence that the requirement is complete.
- Method detail: `roles/linus/guides/testing-and-delivery-sop.md` § Requirement-Completeness
  Acceptance.

## 4. Four-stage development loop (`PROTOCOL §6.1` clause 7)

Requirement development **starts from a Plan by default**; writing code directly is forbidden.
The four stages and their method homes:

| Stage | What happens | Method home |
|---|---|---|
| Plan | produce the plan from the requirement | `~/.openclaw/workspace-linus/guides/plan-guide.md` (phases 1–2) |
| Check Plan | review the plan against the requirement before executing | `plan-guide.md` |
| Execute Plan | work the plan's task list; TDD per task | `~/.openclaw/workspace-linus/guides/execute-guide.md` (phase 3) |
| Accept Plan | verify delivery against the plan and the card | `~/.openclaw/workspace-linus/guides/verify-guide.md` (phase 4) |

Skeleton and gates: `roles/linus/guides/development-process-sop.md`.

## 5. Historically frequent defects (`PROTOCOL §6.1` clause 8)

Two checks carry the highest priority because they are the defects that recur:

1. **Impact scope / omissions** — when changing a field, interface or WebSocket push, trace the
   **frontend data flow**, determine whether it is a Breaking change, and list what was omitted.
2. **Data-passing breaks** — for a signature change, trace the parameter at **every hop** and check
   all five break types: type mismatch / missing field / naming inconsistency / structural break /
   protocol break.

Method homes: the plan-side gates are `~/.openclaw/workspace-linus/guides/plan-guide.md`
§ Pattern 2 (call-chain tracing / parameter breaks) and § Pattern 4 (omission check); the
verify-side counterparts are `~/.openclaw/workspace-linus/guides/verify-guide.md` § Phase 1
(parameter-passing completeness / dead-code and caller verification).

## 6. Test-resource cleanup (`PROTOCOL §6.1` clause 9)

After every round of unit / integration / regression tests, confirm no test-related resource is
left behind:

- [ ] **Runner processes**: no orphan or zombie `pytest` / `jest` / `node --test` process from
      this task (`ps aux | grep -E "pytest|jest|python.*test"`).
- [ ] **Fixtures and temp resources**: temp files, temp DB / redis / mq connections, mock-server
      ports — cleaned up or released by fixture teardown.
- [ ] **Cleanup trail**: on finding leftovers, record the PID and origin, kill it (with `-9` if
      needed), and write "cleaned up (was PID xxx)" in the Report.

Why it is a rule: leftovers hold memory, ports and file locks; they pollute later subsessions and
create cross-task interference.

## 7. Test-case realism — Turing (`PROTOCOL §6.1` clause 10)

At acceptance, check whether the unit / integration cases fit **real business scenarios** rather
than existing "for testing's sake". Distinguish case by case:

- does the assertion test real business behaviour — **real input → real path → real business
  branch / boundary / exception path**;
- is it a fake case that only pads coverage or case count — testing only empty input, only a
  constructor, only the mock itself, or asserting stub values unrelated to the business;
- does the integration test exercise **real component collaboration**, mocking only uncontrollable
  external services.

Finding fake cases, fake coverage or a missing real business branch ⇒ write a defect ticket + set
the card `blocked`/`canceled` + send it back to Elon. **Green ≠ real scenario coverage.** Full
checklist: "test-case scenario authenticity check" under Turing's pass criteria in
`roles/turing/guides/duties-sop.md`.

## 8. Document references (`PROTOCOL §6.1` clause 11)

The rule is in the clause; the **full notation form** — the name-not-glyph discriminator, the
citation-list shorthand, circled numerals, and the item form — is `guides/doc-style.md` §6. The two
linters (`scripts/lint-refs.mjs`, `scripts/lint-doc-refs.mjs`) enforce it.

## 9. Delivery, conformance and frontend stack (`PROTOCOL §6.1` clauses 12–14)

- **CI / release / deploy**: `guides/ci-release-sop.md` (Docker verification environment, gate
  discipline, build/release/deploy SOP, pre-delivery checklist).
- **Requirement–implementation conformance**: for UI it lands through `guides/ui-align-sop.md`
  (block list, assertions, screenshot comparison, traceability matrix); the clause itself is not
  limited to UI.
- **Linus frontend stack defaults**: `roles/linus/guides/testing-and-delivery-sop.md`
  § Frontend Tech-Stack Defaults. The prototype stack (`Tailwind CSS` + `daisyUI` + `jQuery`) and
  the engineering stack (`Vue 3` or `React` + `Vite`) are different layers; only the prototype is
  closed by `PROTOCOL §6`.

---

## 10. Related

- `PROTOCOL §6.1` — the 14 normative clauses this guide supports.
- `roles/linus/guides/testing-and-delivery-sop.md` — Linus's test discipline, prototype
  consumption, frontend defaults and requirement-completeness acceptance.
- `roles/linus/guides/development-process-sop.md` — the phased development gates.
- `roles/turing/guides/duties-sop.md` — acceptance duties, defect loop and the realism check.
- `guides/ci-release-sop.md` — CI gate, build, release and deploy.
- `guides/ui-align-sop.md` — UI conformance and the traceability matrix.
- `guides/doc-style.md` §6 — the full reference notation.
