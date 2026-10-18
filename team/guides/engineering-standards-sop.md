# Engineering Quality Standards SOP (`engineering-standards-sop.md`)

> **Ownership / Maintainer**: **Linus** owns the engineering method; **Turing** owns independent
> verification (including the test-case realism check); **Elon** accepts against the checklist.
> **Status**: method library. This file's `§6.1` is the **normative checklist** (14 clauses)
> delegated by `R-ENG-1` under `R-LAYER-1` rule 6 — the owner AGENTS block is a pointer to this body.
> The sections below carry the methods, examples and checklists the clauses point at.
> **Role-owned method homes**: Linus's `roles/linus/guides/testing-and-delivery-sop.md` (test
> discipline, prototype consumption, frontend stack defaults, requirement completeness) and
> `roles/linus/guides/development-process-sop.md` (phased development); Turing's
> `roles/turing/guides/duties-sop.md` (acceptance duties and the realism check).

---

## §6.1 Engineering Quality Standards (Linus delivery hard gate)

> **Normative checklist** delegated from `R-ENG-1` (`R-LAYER-1` rule 6). Elon/Turing accept against this list; the method detail follows below.

1. **TDD first**: failing test first → implement → go green; writing code before tests is forbidden.
2. **Unit-test coverage ≥ 80%** (lines/branches); below 80% must not be marked done.
3. **Mock boundary**: only mock external I/O (http/db/redis/mq/files/third-party SDKs/clock-and-randomness sources); **mocking internal functions is forbidden**.
4. **Integration tests required**: at least 1 for the core main flow and at least 1 per external API endpoint; mock as little as possible; verify status code + key response fields + side effects.
5. **Self-proving loop**: the Report attaches command + exit code + output summary + coverage numbers + unit/integration test case counts.
6. **Requirement-completeness acceptance**: after Claude Code finishes, **check line-by-line against the task requirements (Acceptance/Background) whether everything is truly done**; the Report attaches an "Acceptance line-by-line checklist" (each line = requirement/done?/evidence); incomplete items must not be marked done. **Green tests ≠ complete requirements**.
7. **Four-stage development loop**: requirement development **starts from a Plan by default** (Plan → check Plan → execute Plan → accept Plan); writing code directly is forbidden; the method pointers are in `guides/engineering-standards-sop.md` §7.
8. **Two mandatory checks for historically frequent defects (highest priority)**: ① **impact scope/omissions** (trace the frontend data flow, determine the Breaking change, list omissions); ② **data-passing breaks** (trace parameters at every hop; check the 5 break types: type mismatch/missing field/naming inconsistency/structural break/protocol break); the method pointers are in `guides/engineering-standards-sop.md` §8.
9. **Test resource leftover cleanup (Linus, required after tests)**: after each test round confirm there are no test-related processes/resource leftovers (orphan/zombie runners, temporary files/DB/redis/mq connections, mock-server port occupation); if found → record the PID + kill + state it honestly in the Report.
10. **Test-case scenario authenticity check (Turing, required when accepting development code)**: verify unit/integration cases fit real business scenarios rather than "testing for testing's sake"; exclude fake cases that only pad coverage/case counts; **green ≠ real scenario coverage**; detail in `guides/engineering-standards-sop.md` §10 and Turing's pass criteria.
11. **Document reference convention (no line numbers)**: references between and within docs **must not be narrowed to file line numbers**; a section reference is `§` + an arabic number and **names its document** (a **bare** `§N` means the document you are in); an item inside a section is `§N clause M` / `§N step M`, never the subsection form `§N.M`. Dangling references are a gate red (`scripts/lint-doc-refs.mjs` / `scripts/lint-refs.mjs`); full notation: `guides/doc-style.md` §6.
12. **CI gate and release (Linus, delivery hard gate)**: CI gates (lint / type check / unit+integration tests / coverage / **build**) must all be green before merging or marking done; **build, release (tag + CHANGELOG + artifact sha256 + artifact smoke), and deploy (staging→prod, backup/rollback point, deploy smoke) are all Linus's responsibility**; methods in `guides/ci-release-sop.md`; changes to gate configuration are convention changes and require dual-signing.
13. **Requirement–implementation conformance (Jobs baseline / Turing independent verification)**: Jobs owns the **requirement/design baseline = "what to build"** (PRD / DESIGN.md / prototype structural contract + `ui-align` block list); Linus implements against it; **Turing independently verifies** conformance and produces a **requirement→implementation traceability matrix** (each requirement/REQ or prototype block → implemented? → evidence: test / selector assertion / screenshot). This is **separate from functional testing** (§6.1 #10) and from Jobs's own visual certification; a gap or deviation (missing blocks, invented structures, silently simplified behavior) ⇒ defect ticket + card `blocked`/`canceled` + send back to Elon. For UI this lands through `guides/ui-align-sop.md`; its scope is not limited to UI.
14. **Linus frontend tech-stack default**: for **new** frontend work the engineering (real) frontend defaults to **`Tailwind CSS` (styles) + `daisyUI` (components) + `Vue 3` or `React` (pick one per project/requirement) + `Vite` (build) + TypeScript first**; existing projects keep their current stack (**no forced migration**). This is a **different layer** from the HTML-path prototype stack closure in `§6` (prototype = `Tailwind CSS + daisyUI + jQuery`): the `§6` closure constrains only the **Jobs prototype**, whereas this clause is the **Linus engineering frontend** default; the two coexist without conflict.

---

## 1. TDD and coverage (`R-ENG-1` clauses 1–2)

- One feature point → one failing test written first → implement → go green. "Code then tests" is
  the forbidden order, not merely a weaker preference.
- Unit coverage is measured at delivery (`pytest --cov` / `jest --coverage` / `c8`) and reported as
  totals plus line and branch coverage. Below **80%** the card cannot be set to `done`: explain the
  gap and add tests.
- The TDD decision table (new feature / new API / complex logic ⇒ RED→GREEN→REFACTOR; bug fix ⇒
  optional; pure refactor / config / migration ⇒ no new test) and the coverage grading by task size
  live in `~/.openclaw/workspace-linus/guides/execute-guide.md`. Tests are never skipped — only the
  RED-first ceremony is waived.

## 2. Mock boundary and integration tests (`R-ENG-1` clauses 3–4)

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

## 3. Self-proof and requirement completeness (`R-ENG-1` clauses 5–6)

- The Report attaches **command + exit code + output summary + coverage number + unit/integration
  case count** — never the bare claim "tests pass".
- After Claude Code finishes, run the requirement-completeness pass: copy out the card's Acceptance
  and verify each line against the artifact. The Report carries an **Acceptance line-by-line
  checklist** (requirement / done? / evidence). Unfinished items are written honestly; a green test
  suite is not evidence that the requirement is complete.
- Method detail: `roles/linus/guides/testing-and-delivery-sop.md` § Requirement-Completeness
  Acceptance.

## 4. Four-stage development loop (`R-ENG-1` clause 7)

Requirement development **starts from a Plan by default**; writing code directly is forbidden.
The four stages and their method homes:

| Stage | What happens | Method home |
|---|---|---|
| Plan | produce the plan from the requirement | `~/.openclaw/workspace-linus/guides/plan-guide.md` (phases 1–2) |
| Check Plan | review the plan against the requirement before executing | `plan-guide.md` |
| Execute Plan | work the plan's task list; TDD per task | `~/.openclaw/workspace-linus/guides/execute-guide.md` (phase 3) |
| Accept Plan | verify delivery against the plan and the card | `~/.openclaw/workspace-linus/guides/verify-guide.md` (phase 4) |

Skeleton and gates: `roles/linus/guides/development-process-sop.md`.

## 5. Historically frequent defects (`R-ENG-1` clause 8)

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

## 6. Test-resource cleanup (`R-ENG-1` clause 9)

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

## 7. Test-case realism — Turing (`R-ENG-1` clause 10)

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

## 8. Document references (`R-ENG-1` clause 11)

The rule is in the clause; the **full notation form** — the name-not-glyph discriminator, the
citation-list shorthand, circled numerals, and the item form — is `guides/doc-style.md` §6. The two
linters (`scripts/lint-refs.mjs`, `scripts/lint-doc-refs.mjs`) enforce it.

## 9. Delivery, conformance and frontend stack (`R-ENG-1` clauses 12–14)

- **CI / release / deploy**: `guides/ci-release-sop.md` (Docker verification environment, gate
  discipline, build/release/deploy SOP, pre-delivery checklist).
- **Requirement–implementation conformance**: for UI it lands through `guides/ui-align-sop.md`
  (block list, assertions, screenshot comparison, traceability matrix); the clause itself is not
  limited to UI.
- **Linus frontend stack defaults**: `roles/linus/guides/testing-and-delivery-sop.md`
  § Frontend Tech-Stack Defaults. The prototype stack (`Tailwind CSS` + `daisyUI` + `jQuery`) and
  the engineering stack (`Vue 3` or `React` + `Vite`) are different layers; only the prototype is
  closed by `R-SESSION-1`.

---

## 10. Related

- `R-ENG-1` — the 14 normative clauses this guide supports.
- `roles/linus/guides/testing-and-delivery-sop.md` — Linus's test discipline, prototype
  consumption, frontend defaults and requirement-completeness acceptance.
- `roles/linus/guides/development-process-sop.md` — the phased development gates.
- `roles/turing/guides/duties-sop.md` — acceptance duties, defect loop and the realism check.
- `guides/ci-release-sop.md` — CI gate, build, release and deploy.
- `guides/ui-align-sop.md` — UI conformance and the traceability matrix.
- `guides/doc-style.md` §6 — the full reference notation.
