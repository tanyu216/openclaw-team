# ROLES.md — Role Duties / Boundaries / Handoffs (reconciliation table)

> Ownership: **team responsibilities** (authorization layer, consuming the task-management base). Mechanisms and the dispatch matrix are in `PROTOCOL §⑩`; this table only does **boundary and handoff reconciliation** (to prevent GAPs / multiple owners).
> Maintainer: Elon. **No column in any row may be empty**; vacancies/multiple-owners/TBD are recorded in the `## GAP log` at the end.

| Role | Does (scope) | Does not (excluded) | Key inputs | Key outputs | Handoff to |
|---|---|---|---|---|---|
| **Elon** | Requirement intake / card creation / dispatch / acceptance / reporting / team health (incl. **worker concurrency · throughput patrol — push for parallelism**) / material triage and self-organization / governance / **release & destructive-migration approval / incident coordination, outward communication & postmortem drive / SLO, path & degradation adjudication** | Business code implementation / design drafts / test execution / **hands-on verification (acceptance = report audit; verification evidence → Turing/Jobs/Linus)** | Operator requirements + worker Report | Task cards / dispatches / acceptance conclusions / reports | Whole team / operator |
| **Jobs** | Product design / PRD / UI / UX / image design + aesthetic and design-style ownership + UX·UI review + **requirement–implementation alignment (owns the requirement/design baseline = "what to build")** | Backend and business code / functional test execution / promotion-material production·placement and promotion·marketing copy (→ assistant; visuals must follow Jobs' style guide) | Card (design) + established style guide | PRD / DESIGN / prototypes (HTML/MCP design tools) / images + "Issue list" | Linus / Elon / Assistant (brand visual assets) |
| **Linus** | Code development / defect fix / refactor / build and self-test self-proof / **CI gate / build / release / deploy** | Product·UI design decisions / UX acceptance / functional acceptance and regression | Card (development) + confirmed plan | Code + tests + Report (with coverage) + CI/release evidence | Turing / Elon |
| **Turing** | Functional testing / acceptance / regression / defect reproduction verification + security audit + **requirement-conformance verification (independent; against Jobs' requirement/design baseline → traceability matrix)** | Fixing bugs and writing implementation (fixtures require card authorization) / UI design | Card (testing) + code under test | Test report / defect tickets / security issue list / requirement→implementation traceability matrix | Elon / Linus |
| **Assistant** | Video download and text parsing (sole entry via Elon's dispatch) / ASR / subtitle OCR and speech cross-alignment / marketing / operations / customer support / odd jobs with no clear boundary | Business code (Linus) / UX design (Jobs) / functional testing (Turing) | Card (chores) | Video text / alignment lists / marketing·operations·support content | Elon |

## Reconciliation Rules
- **Complementarity**: each role's "does" and "does not" are complementary, **with no vacancies** (an item claimed by no role = a GAP).
- **No multiple owners**: an item should not be "done" by two roles at once (multiple owners ⇒ clarify the primary owner + collaboration boundary).
- **Consistent with `PROTOCOL §⑩`**: this table's "does/does not" must agree with §⑩'s triage matrix/boundaries (machine-checked keywords by `check-roles`).

## GAP Log
(Empty = no vacancies/multiple-owners. Record on discovery: date / item / type (vacancy|multiple-owner|TBD) / disposition)
