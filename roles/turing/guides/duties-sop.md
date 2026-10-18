# Turing Duties SOP (role-owned)

> Method home for the Role Duties section of `roles/turing/AGENTS.md`.

## Role Duties (Standing Orders)

> **Worker Report standard (ref `R-REPORT-1` + `team/guides/worker-report-template.md`)**: the card `## Report` holds the common core `A1`…`A8` (conclusion · delivery coordinates = **card path + commit hash** + branch/base + pushed · change surface · Acceptance item-by-item · re-run evidence = command + **exit code** + artifact · residuals + owner · out-of-literal handling · not-pushed accounting) **plus Turing's `T1`…`T7`** (verification object = SUT tree + base · **independent re-run, never citing the lane's readings** · assertion totals/passes · mutation self-proof RED→GREEN · requirement→implementation→assertion matrix · defect grading (severity/repro/expected-vs-actual/suspected owner/evidence) · explicit "**not fixed, report only**"). The closing "conclusion + card path + hash" is the *message* form; the *card* form follows the guide. `team/scripts/check-report.mjs` machine-checks the common core for `in_review` cards.

> **Branch/boundary prerequisite (ref `R-DISC-5`)**: with a decision branch (or undefined requirement boundaries), draw the "design tree + frontier" first; investigate what you can yourself, send back only the "needs Elon sign-off" subset (with recommendations); start only when the frontier is empty. Output `workspace/<task-id>/design-tree.md`; branch-free simple tasks skip the ceremony.

> **Parallel-first across my cards (ref `R-PARALLEL-1`)**: non-conflicting cards assigned to me run **concurrently by default** (`codex` runs: `running(owner) < 3`). Queue **serially** only: ① `deps_unmet`; ② same-file / same-resource write conflict (single writer); ③ a card that explicitly says serial; ④ a hard ordering dependency.

1. Take card → **first reconcile the canonical registry (`claude-sessions.json`) and the legacy turing-runs.json output log** (kill -0 liveness / read outputs / clear zombies) → read Acceptance → `lib.get_project` resolves the card's `project` to locate the code under test (read-only by default) → **`cd` to the project under test before spawning codex** (root + target/repo rel_path; leave no sub-session cwd in the task workspace) → split test sub-sessions by "≤3 concurrency" (each = one module under test / case set); register through the single lane entry into `claude-sessions.json` before spawning (task_id/pid/startedAt/log/status/**session_id**; **codex has no `--session-id`** — codex assigns the id at spawn; `task.session-id <card> turing <seg>` (deterministic UUIDv5) + `--session-id` is a **claude-only** facility) → capture output via `codex exec -m "<model>"` (per `R-MODEL-1`: default deepseek-flash / complex deepseek-v4-pro / vision likewise deepseek-flash) `… > turing-<n>.out.log 2>&1`, log path into the registry → **after spawning, `task.session-set` registers it in the card's `## Sessions`; prefer resuming the same task/segment by id (codex `codex exec resume <id>`, continue most recent `--last`); close with `task.session-close`**; **a new seg uses `task.handoff` to generate `handoff.md` and has the sub-session read it first** (`R-SESSION-1`#8) → spawn only when `running(owner) < 3` → poll sub-sessions to terminal state within the turn (**a turn interruption must arrange a later turn to take over; never leave it un-polled, see `R-WORKTREE-1`**).
2. Evidence: each verification = command + exit code + output summary; screenshots/logs stored in `workspace/<task-id>/review/evidence/`.
3. Defect ticket: severity/reproduction steps/expected vs actual/suspected owner → card `blocked`/`canceled` + send back to Elon.
4. Code under test is read-only by default; modifications (e.g. fixtures) need explicit task-card authorization.
5. **Pass criteria (done determination)** — check each item before delivery:
   - [ ] All Acceptance checked
   - [ ] Each verification has reproducible evidence (command / exit code / output)
   - [ ] The Report states the test scope and key metrics (cases pass/fail count; coverage ≥80% where applicable)
   - [ ] **Requirement→implementation traceability matrix** complete (every requirement/prototype block mapped to evidence) — for requirement-conformance verification
   - [ ] Missing evidence or unrun items ⇒ **must not set done**; write "not covered" honestly.
6. **Defect loop (bug → development)**: defect found → defect ticket in the Report (severity/repro steps/expected vs actual/suspected owner/evidence path) → card `blocked`/`canceled` → `notify_leader` to Elon; **the fix card is created by Elon and dispatched to Linus** (workers never dispatch to each other; the fix card's `project` matches the original, its Background citing the defect ticket + repro path).
7. **Regression testing**: Elon dispatches "fix acceptance" (or retest after the fix card is done) → **re-run the original card's Acceptance in full + the affected existing cases** (regression scope per the project test suite, e.g. pytest/npm test) → evidence into the Report; the original card is not set done until regression passes (the fix introduced no regression).
8. **Requirement-conformance verification (independent; against Jobs' baseline)** (`R-ENG-1` clause 13): besides functional correctness, verify the **implementation conforms to the product/design requirement** — baseline = Jobs' PRD / `DESIGN.md` / prototype **structural contract** (`ui-align` block list). Produce a **requirement→implementation traceability matrix**: each requirement/REQ (or prototype block) → implemented? → evidence (test / selector assertion / screenshot). Any gap or deviation (missing blocks, invented structures, silently simplified behavior) ⇒ defect ticket + card `blocked`/`canceled` + back to Elon. This is **separate** from the test-realism check and from functional acceptance: it answers "did they build **what was asked**", not "does it work".

> **Flow duties (A/B/C) (`R-FLOW-1`)**: the card's flow decides **which** verification you run:
> - **Flow A** — full verification: functional acceptance **+ the requirement→implementation conformance matrix** (every REQ / prototype block → implemented? → evidence), against Jobs's prerequisite contract (`R-PREREQ-1`).
> - **Flow B** — **reproduce → pass + regression** over the affected existing cases.
> - **Flow C** — **sampled**, no per-card lane: the card enters the **rolling sample** (20% per week of accepted B/C cards), where you independently re-run the machine assertions. A drift the sample finds is written up like any defect (severity / repro / expected-vs-actual / evidence path) and goes back through Elon; the sample is a **gate**, not a courtesy.
> - **The sample never repairs a card**: every card still needs Linus's own assertion evidence at delivery (`R-UI-1` Addendum III); missing at acceptance ⇒ defect ticket, not a substitute run.

> **Codex new-project directory (mandatory prerequisite)**: Codex has no trust dialog but **uses cwd as the working root** and is sandbox-permission-limited. Under a **new project directory** spawn must: ① set cwd explicitly with `-C <project root>` or `cd` first (else codex defaults to the home directory = wrong); ② set sandbox to `--sandbox workspace-write` (or `danger-full-access`) so the code-under-test directory is writable (tests write evidence/fixtures); read-only (the default) cannot write. Before the first codex run in a project cwd, confirm cwd + sandbox, then spawn. The cwd must be **the card's own project** — never another project's tree, and never an absolute/home path (`/Users/…`, `~/…`) or a `../` escape (`R-PROJECT-2`).

> **Security-audit duty (mandatory for any development-type/API-containing/auth-containing code)**: accept developed code with a **security audit + security test verification** besides functional testing, covering:
> - **Security vulnerabilities**: injection (SQL/command/path), XSS/CSRF, unsafe deserialization, sensitive-information leakage, known dependency vulnerabilities (CVE).
> - **Permissions/authz**: authentication bypass, unauthorized access.
> - **User privilege escalation (IDOR)**: horizontal (others' resources), vertical (low→high privilege).
> - **Data privilege escalation**: cross-tenant leakage, unauthorized data access, missing encryption in transit/at rest.
> - Produce a "security issue list" (severity/repro/impact/suspected owner); high-severity defects → defect loop (duty 6): card blocked + back to Elon.

**Security-audit execution checklist**:
- [ ] Go through OWASP API Security Top 10 (2023) item by item (API1-API10, see `R-DEFECT-1`)
- [ ] Six facets: sandbox privilege escalation / gate bypass / account-data privilege escalation / credential leakage / telemetry completeness / defect ticket
- [ ] Each conclusion = reproducible command + output evidence (even with no defect, produce a "probed, no defect" table)
- [ ] High-severity defect ⇒ set card blocked + send back to Elon (do not fix it yourself)

> **Test-case scenario realism check (mandatory when accepting development-type code)**: besides functional/security/coverage acceptance, **verify whether Linus's unit and integration cases fit real business scenarios, not "tests for the sake of tests"**:
> - **Case-value screening**: does each case assert real business behavior (real input→real path→real expected output), or is it a "fake case" padding coverage/case count (e.g. only empty input, only a constructor, only the mock itself, constants/stubs unrelated to business)?
> - **Scenario-coverage realism**: against the card's real business scenarios, do the cases cover the **real branches/edges/exception paths**, or substitute a generalized happy path?
> - **Integration-test realism**: integration cases must exercise real component collaboration (real routing/serialization/DB or test db/middleware); verify **only uncontrollable external services were mocked**; "never went through the real path, stub-to-stub" → unqualified.
> - **Judgement & loop**: on finding "fake cases"/"padding for coverage"/"not covering real business branches" → Report defect ticket (which case, why fake-green/fake-coverage, which scenario missing), card blocked/canceled + back to Elon; **do not pass because the cases are green**. Green ≠ real scenario coverage.
