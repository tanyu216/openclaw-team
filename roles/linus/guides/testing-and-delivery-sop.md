# Linus Testing, Prototype & Delivery SOP (role-owned)

> Method home for Test Discipline, Prototype Consumption, Frontend Tech-Stack Defaults and Requirement-Completeness Acceptance.

## Test Discipline (mandatory, TDD + coverage + mock boundary + integration tests)

1. **Prefer TDD**: failing test first → implement → green; never "code then tests". One feature point → one failing test written first.
2. **Unit test coverage ≥ 80%**: run coverage at delivery (`pytest --cov` / `jest --coverage` / `c8`), write totals + line/branch coverage into the Report; below 80% must not be set to done — explain and add tests.
3. **Mock boundary (hard constraint)**: mock only **external I/O and external systems** — http / db / redis / mq / filesystem / third-party SDK / clock and randomness sources etc.; **never mock internal functions** (pure functions, private methods, directly-called internal logic within this module), which produces "fake green" hiding real regressions.
4. **Integration tests are essential**:
   - ≥1 integration case for the core flow (end-to-end main path);
   - **≥1 integration case per public API endpoint** (real routing/serialization/DB or test db/middleware);
   - avoid mocking where possible (or mock only uncontrollable external services), covering real component collaboration;
   - each integration case verifies: HTTP status code + key response body fields + side effects (DB write/cache etc.).
5. **Self-proving loop**: the Report attaches "command + exit code + output summary + coverage number + unit/integration case count"; never just "tests pass".
6. **Test resource leftover cleanup (mandatory, after every test run)** — **confirm no test-related processes/resources remain**:
   - [ ] **Test-runner leftover processes**: `ps aux | grep -E "pytest|jest|python.*test"` to confirm **no orphan/zombie test processes left by this task**
   - [ ] **Test fixtures/temp resources**: temp files, temp DB/redis/mq connections, mock server ports ⇒ clean up (or release via fixture teardown)
   - [ ] **Cleanup action**: on finding leftovers → record PID and origin + `kill` (with `-9` if needed) + write "cleaned up (was PID xxx)" in the Report
   - Reason: leftovers hold memory/ports/file locks, polluting later sub-sessions and creating cross-task interference.

> Acceptance linkage: Turing re-checks coverage and integration cases; missing unit/integration tests or sub-threshold coverage gives Elon the right to send back.

## Prototype Consumption (by carrier)

> The prototype carrier is a **deployment choice** recorded in `~/.openclaw/team/team.config.json` (`prototype.carrier`; set by `install.sh --prototype`): `static-html` | `figma` | `google-stitch` | `pixso`. Linus must **obtain the prototype and implement against it** in every case. The prototype is **read-only**; the implementation always lands in the **real frontend project**, never in `prototype/**`.

| Carrier | How Linus obtains the baseline | Prerequisite |
|---|---|---|
| `static-html` | Read `prototype/**/*.html` + the shared Tailwind theme tokens, then implement in the real frontend | — |
| `figma` | Pull the design through the **Figma MCP/API** (frames → specs/tokens/assets), or use the static HTML mirror Jobs exports into `prototype/**` | Figma MCP server configured in `mcp.servers` |
| `google-stitch` | Consume the Stitch export bundle (static HTML + tokens + assets) in `prototype/**` | — |
| `pixso` | Pull through the **Pixso MCP**, or use the exported file | Pixso MCP server configured in `mcp.servers` |

Rules:
- **Connector**: `figma` / `pixso` / `google-stitch` each require their **connector MCP/skill installed** (declared in `config/prototype-carriers.json`; the installer checks and warns if missing; template in `config/examples/mcp.example.json5`); `static-html` needs none.
- **Obtain, don't invent**: if the configured carrier's source is unavailable or unreadable ⇒ set the card `blocked` + send back to Elon; never guess the design.
- The prototype must be a **renderable artifact** (static HTML mirror and/or exported screenshots) for the fidelity gates — see `team/guides/ui-align-sop.md` §10 and `tools/ui-fidelity/README.md`.
- The prototype is a **design baseline, not shippable code**: never copy prototype HTML/JS into the implementation as-is, and never write implementation into `prototype/**` (`PROTOCOL §9.2`).
- The closed prototype tech stack (Tailwind + daisyUI + jQuery) constrains the **prototype** only; the real frontend stack is the project's call.

## Frontend Tech-Stack Defaults
> Default stack for **new** frontend work (the **engineering real frontend** that ships — *not* the Jobs prototype; see "Prototype Consumption (by carrier)" and `PROTOCOL §6`):

- **`Tailwind CSS`** — styling (utility-first CSS)
- **`daisyUI`** — component layer on top of Tailwind
- **`Vue 3` or `React`** — component framework (pick one per project/requirement; do not mix both in one app)
- **`Vite`** — build tool / dev server
- **TypeScript preferred** (TS-first for new code)

Rules:
- **New frontends default to this stack**; another stack needs a written rationale in the card and Elon's approval.
- **Existing projects keep their current stack — no forced migration**; migrate only when the card explicitly asks.
- **Do not confuse it with the Jobs prototype stack**: the HTML high-fidelity **prototype** (a design deliverable) uses `Tailwind CSS + daisyUI + jQuery` (`PROTOCOL §6`, HTML path) — that closure constrains the **prototype only**; the **engineering real frontend** is `Vue 3` or `React` (+ Tailwind/daisyUI). A prototype is a design baseline and is never shipped as-is (`PROTOCOL §9.2`).

## Requirement-Completeness Acceptance (mandatory, after Claude Code finishes)
> After Claude Code finishes, **do not only check unit/integration tests for "is the code correct" but also verify item by item against the task requirement "is it truly all done as required"**. A green test ≠ a completed requirement.

1. **Check against Acceptance item by item**: copy out the card's Acceptance and verify each is "truly done", not "the code runs".
2. **Requirement vs implementation check**: against Background/goal, check for **omitted features/edge conditions/parameter requirements**.
3. **How to verify**: do not only trust tests; run the business scenario/command and see whether the artifact matches the requirement description.
4. **Check each item into the Report**: attach an "Acceptance item-by-item checklist" (requirement / done? / evidence); write "not done" honestly for unfinished items — do not hide it, do not set done.
5. **On finding something unfinished/deviating** → keep using Claude Code to complete it, or set blocked + send back to Elon stating the gap; do not hand in "roughly done".

> Division of labor with Test Discipline: **Test Discipline** answers "is the code correct"; **this section** answers "is the requirement done". Both must pass to be deliverable.

**Check each item before delivery**:
- [ ] Every Acceptance item actually run and verified (not just code that runs)
- [ ] No omitted features/edges/parameters from Background
- [ ] Report contains the "Acceptance item-by-item checklist" (requirement / done? / evidence)
- [ ] Unfinished items written honestly, not set to done
