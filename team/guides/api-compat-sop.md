# API Compatibility and Deprecation SOP (api-compat-sop.md)

> **Ownership / Maintainer**: **Linus** (engineering) owns and maintains this SOP. The normative mechanism lives in **`PROTOCOL §㉕` (API compatibility & deprecation)**, which is the L1 clause **Elon alone** writes; this file references that clause and **never copies its text** (`PROTOCOL §⑰`).
> **Depends on**: `PROTOCOL §⑥` (git discipline) · `§⑥.1` (engineering quality standards — **clause 8** owns the consumer-impact tracing this SOP completes) · `§⑨` (defect loop) · `§⑫` (two-way document sync) · `§⑭` (confirmation gate) · `§⑰` (doc layering / no verbatim copying) · `§⑳.1` (machine-checkable gates) · `§㉑` (release & versioning — owns semver) · `§㉔` (data/DB migration) · `§㉕` (the L1 clause this SOP details).
> **Sibling guides**: `release-versioning-sop.md`, `data-migration-sop.md`, `incident-response-sop.md`, `ci-release-sop.md`.
> **Scope**: this file is the **L2.5 method library** — the executable detail for API-contract compatibility, versioning and deprecation. Cross-role mechanism is owned by L1 (`PROTOCOL §㉕`) and is referenced, not restated.
> **Reference convention**: always write `PROTOCOL §<n> <name>` or `guide-name §<section>`. **No line-number anchors, no card-number anchors** (`PROTOCOL §⑥.1` clause 11).

---

## 0. Object Declaration (read first)

> 🚩 **This SOP and its neighbours have different objects and are not interchangeable:**
> - **This SOP = the compatibility and version evolution of external / cross-module API contracts** (HTTP APIs, inter-module interfaces, event/message schemas). The landing point is **the contract itself**.
> - **`PROTOCOL §⑥.1` clause 8** = the engineering quality standard's dual check for "impact scope / omissions + data/argument breaks" (a historically high-frequency defect class). This SOP **connects to and completes** it (adding the "versioning + deprecation" step that clause 8 does not cover) and **references its number only, without copying its text**.
> - **`release-versioning-sop.md` = release and version management** (semver policy, tags, changelog, rollback, release channels). This SOP **references its §2 version-number policy** for version-bump decisions and **does not redefine semver**.
> - **`data-migration-sop.md` = DB/schema change discipline.** This SOP **excludes** DB migration (see §1 "Does not do").
>
> **One-line boundary**: **compatibility determination and version/deprecation of a changed contract ⇒ this SOP; release action / version numbers / tags / changelog format ⇒ `release-versioning-sop.md`; changing database structure and data ⇒ `data-migration-sop.md`.** The three are complementary and non-overlapping.

---

## 1. Scope and Boundaries

| Item | Content |
|---|---|
| **Does** | ① Breaking-change determination; ② the contract-versioning scheme and the major/minor boundary; ③ the deprecation process and expiry removal; ④ consumer-impact tracing (producing a Breaking-change impact list); ⑤ contract tests and contract-snapshot comparison; ⑥ gate registration for each of the above ("machine-checkable vs manual") |
| **Does not do** | Internal private function/module **refactoring** (the external contract is unchanged, so it is not version evolution; its correctness belongs to unit tests, `§⑥.1` clauses 1/2); **DB/schema migration** (⇒ `data-migration-sop.md`); the **release process** (tag / changelog format / rollback action ⇒ `release-versioning-sop.md`, by reference); outward public **launch/approval** (⇒ `PROTOCOL §⑤.1`); performance/SLA baselines (⇒ the performance/SLA SOP) |
| **Handoff** | Determined breaking ⇒ version-bump magnitude and the changelog `BREAKING` trail go to `release-versioning-sop.md §2/§3`; a needed rollback / forward fix ⇒ follow its §5; a contract defect found ⇒ open a defect-loop card (`PROTOCOL §⑨`); a deprecation needing sign-off or public announcement ⇒ `PROTOCOL §⑭` (confirmation gate), via Elon |
| **Not applicable** | Personal draft interfaces that are undelivered and have no consumers; purely internal CLI output formats (unless scripts/docs already depend on them as a contract) |

> **Rule / responsibility / landing point**: rule = any change to an interface/contract **that has consumers** falls under this SOP; responsibility = the change implementer (Linus) produces the determination and the impact list, the reviewer (Elon) checks it at the confirmation gate; landing point = see §7 (machine gate + manual criteria).

---

## 2. Breaking-Change Determination Checklist

> **Rule**: the basis for determination is **whether the behaviour for existing consumers changes**, not "whether code moved". Any change where a consumer **cannot keep working without changing its code** is breaking.
> **Interface rule**: `PROTOCOL §⑥.1` clause 8 already requires "determine Breaking change + trace impact scope / argument breaks"; this SOP **completes the "versioning/deprecation" step it does not cover**, aligning its determination actions to clause 8's numbering (**by number, without copying its text**).

### 2.1 Breaking vs Non-Breaking (item by item)

| # | Change class | Verdict | Consumer must change code? |
|---|---|---|---|
| B1 | **Delete a field** / endpoint / enum member / error code | 💥 Breaking | Yes (references necessarily break) |
| B2 | **Change a field type** (e.g. `string`→`int`, array↔object) | 💥 Breaking | Yes |
| B3 | **Change field semantics** (same name, different meaning: unit `seconds`→`milliseconds`, time zone, coordinate system) | 💥 Breaking | Yes (and **hardest to detect**, weak machine check) |
| B4 | **Change required-ness** (optional→required; omitting on the client is now rejected) | 💥 Breaking | Yes |
| B5 | **Change an enum value** (member spelling / case / value domain) | 💥 Breaking | Yes |
| B6 | **Change a default value** (affects behaviour when a parameter is not passed explicitly) | 💥 Breaking | Yes |
| B7 | **Change an error code / HTTP-status mapping** (same failure, different code or status) | 💥 Breaking | Yes (consumers branching on the code necessarily break) |
| B8 | **Change a URL / route / version prefix** (non-compatible rewrite other than `/api/v1/x`→`/api/v2/x`) | 💥 Breaking | Yes |
| B9 | **Change auth/authorization** (different header, token shape, or tightened authorization) | 💥 Breaking | Yes |
| B10 | **Tighten validation** (reject input that used to be accepted) | 💥 Breaking | Yes (previously valid requests are rejected) |
| B11 | **Change pagination semantics** (`limit/offset`↔`cursor`, default page size, sort stability, total-count meaning) | 💥 Breaking | Yes (paging/dedup can go wrong) |
| B12 | **Change the response structure** (envelope shape, field-name case e.g. `snake_case`↔`camelCase`) | 💥 Breaking | Yes |
| N1 | **Add an optional field** (added to the response, or an optional request field whose absent-case behaviour is unchanged) | ✅ Non-breaking | No (must tolerate unknown fields) |
| N2 | **Add an endpoint** | ✅ Non-breaking | No |
| N3 | **Loosen validation** (accept more input; previously valid input stays valid) | ✅ Non-breaking | No |
| N4 | **Add an enum value / error code** | ✅ Non-breaking* | No (**precondition: consumers tolerate unknown values/codes**) |
| N5 | Docs/description/performance only; contract unchanged | ✅ Non-breaking | No |

> \* **The N4 trap**: adding an enum value or error code is non-breaking **only if consumers treat unknown values leniently** (no throw, no crash into a `default` branch). If a consumer is known to match the enum **strictly by exhaustive cases**, the change **degrades to breaking** (B5/B7). ⇒ This is why §5 "consumer-impact tracing" is a **precondition** for the N4 verdict.

### 2.2 Compatibility Decision Table (criteria index, for review citation)

| Criterion question | If "yes" ⇒ |
|---|---|
| Can an old consumer, **changing nothing**, still get the same semantics? | Otherwise = **breaking (requires MAJOR)** |
| Does the change only **add**, without changing the type/semantics/required-ness of existing keys? | Yes ⇒ candidate **non-breaking (MINOR)** |
| Does that "addition" depend on consumers **tolerating unknown values**? | Yes ⇒ must pass §5 impact tracing first, otherwise it degrades to breaking |
| Does the change only touch error text/logging/internals, leaving the external contract (fields/codes/status/pagination) unchanged? | Yes ⇒ **PATCH** |
| Have semantics changed while the signature/type did not (B3)? | Yes ⇒ **breaking** (hard to machine-detect, **must be judged manually**) |

> **Rule / responsibility / landing point**: rule = the list above is the **source of truth** for determination, and reviews and changelogs cite its item numbers; responsibility = the determination and impact list are Linus's, review is Elon's (escalating to Turing if needed, `§⑭`); landing point = B1/B2/B4/B5/B7/B8/B11/B12 are **machine-checkable** (schema/route/error-code diff), while **B3 (semantics) and "is an addition breaking" can only be judged manually**.

---

## 3. Versioning Scheme

> **Rule**: versioning is used to **expose and isolate incompatible changes** so old consumers can keep working through the deprecation window (see §4). **Version-bump semantics** follow `release-versioning-sop.md §2` (MAJOR = incompatible, MINOR = compatible addition, PATCH = compatible fix); this file **does not redefine them** and only decides **how an API version is carried externally**.

### 3.1 Candidate Schemes Compared

| Scheme | Form (example) | Pros | Cons | Best for |
|---|---|---|---|---|
| **URI major version** | `/api/v1/items`, `/api/v2/items` | Most visible; easiest to route/see by path at CDNs/gateways/logs; intuitive to debug; a client changes one prefix | Multiple paths to maintain per resource; coarse-grained (whole bundle bumps) | **Major-version boundaries** (a whole API generation changes) |
| **Header version** | `Accept-Version: 2` (or `X-Api-Version`) | Clean paths; end-point-level granularity; multiple versions on the same URL | Invisible (hard to tell apart in cache/logs); must remember the header to debug; easily stripped by gateways/proxies | **Single-endpoint transition** (local, temporary break) |
| **Media-type version** | `Accept: application/vnd.<service>.v2+json` | Most rigorous semantics (REST-orthodox); unified with content negotiation | High client-implementation bar; unfamiliar to most teams/toolchains; costly to debug | A few interfaces with strong content-negotiation needs |

### 3.2 Major vs Minor Boundary

| Boundary | Criterion (per §2) |
|---|---|
| **Major (`MAJOR` / `/vN/`)** | Triggered by any **B (breaking)** item in §2.1; requires a `MAJOR` bump (or the equivalent incompatible marking in the `0.y.z` phase, `release-versioning-sop.md §2.1`) |
| **Minor (`MINOR`)** | Only **N (non-breaking)** items from §2.1; backward-compatible expansion **within the same `/vN/`**; **does not open a new `/v(N+1)/`** |
| **Patch (`PATCH`)** | No contract change (text/performance/internal fix, N5) |

- **Principle**: **within the same generation `/vN/`, do only "addition"**; once a "subtraction/re-meaning" is required, cut `/v(N+1)/` and put `/vN/` into deprecation (§4).
- **Forbidden**: silently changing semantics under the same `/vN/` (B3) — this is the root cause of "the version didn't move, yet consumers broke".

> ⚠️ **Versioning scheme: to be decided.**
> **Recommended default (in force until decided)**: **use URI major versioning (`/api/vN/`) for external / cross-service APIs, with stable internal contracts**.
> Rationale: ① best visibility and gateway routing; ② URI versioning is the most natural fit for services whose public routes already carry a `/api/v1/...` prefix, so adopting it = a natural continuation with no migration cost; ③ keep **internal module-to-module / event contracts as unversioned stable contracts** (internal parties can upgrade in lockstep, so versioning is only worth it where external/cross-module consumers exist) — this avoids scattering version numbers everywhere internally.
> **Only when** a single endpoint needs a local transition and the whole bundle should not bump may a **Header version** be allowed as a special case (with a written reason and Elon's approval).

> **Rule / responsibility / landing point**: rule = `/vN/` = the compatibility-generation boundary, and `N` only increments on a breaking change; responsibility = the scheme decision is Elon's (`§⑭`), implementation is Linus's; landing point = route-prefix consistency is **machine-checkable** (route table / contract tests), while the generation-cut decision is **manual**.

---

## 4. Deprecation Process

> **Rule**: deprecation ≠ immediate removal. **Deprecation = announce first, coexist, observe usage, then remove.** Any breaking change (§2 B items) within its `/vN/` follows this process and must not be "deleted on the next step".

### 4.1 Four-Phase Lifecycle

| Phase | Action | Output / trail | Landing point |
|---|---|---|---|
| **① Announce** | Declare a field/endpoint/version **deprecated as of version X**, with the replacement and the removal window | changelog records `Deprecated` (`release-versioning-sop.md §3.1`) + a task comment; the response may carry `Deprecation`/`Sunset` headers (if applicable) | Manual (publish the announcement) + **machine-check** (marker presence) |
| **② Coexist** | **Dual version / dual field coexist**: the old one **still works** (a downgrade/warning may be added), the new one is available in the same window | The old field still returns, the old `/vN/` still serves | Implementer (Linus) |
| **③ Observe usage** | Use **alerts/telemetry** to measure the old item's **consumer call volume** (who calls it, how much, when it hits zero) | Usage curve / logs; zero-usage evidence | **Machine-check** (telemetry) + manual judgement |
| **④ Remove at expiry** | Remove when the deprecation period has expired **and** usage has hit zero **and** it was announced; otherwise extend | changelog records `Removed` + a task comment | Manual decision + machine-check review |

- **Removal hard preconditions (all three required)**: ① the deprecation period has expired; ② there is **evidence** the old item has **no active consumers** (§5 "no caller proof ⇒ no deletion"); ③ the deprecation announcement and trail are complete.
- **Trail carriers**: changelog `Deprecated`/`Removed` groups (`release-versioning-sop.md §3.1`) + a task comment; both must be traceable.

### 4.2 Deprecation Period Duration

> ⚠️ **Deprecation period duration: to be decided.**
> **Recommended default (in force until decided)**: **at least ≥ 1 release cycle** (i.e. at least one full release / MINOR has crossed), and **≥ 30 days** for versioned external interfaces. Take the **longer** of "one release cycle" and "≥ 30 days".
> Rationale: ① consumers need one release window to respond; ② too short (e.g. 1 week) is impossible for projects with only manual inspection and no CI; ③ this aligns with the release-channel/observation-window cadence of `release-versioning-sop.md`.
> **Shortenable special case**: internal consumers only and all migrations confirmed complete (with §5 evidence) ⇒ may be shortened, but **the announcement + trail are still required** and Elon's approval is needed.

> **Rule / responsibility / landing point**: rule = a breaking removal always follows "deprecate first, remove later"; responsibility = starting and observing the deprecation is Linus's, **approving the deprecation period and the expiry removal is Elon's** (`§⑭`; overdue handling per `§⑮`); landing point = phases ①②④ contain manual actions, and ③ is the machine-check main field (telemetry).

---

## 5. Consumer-Impact Tracing (interface with `PROTOCOL §⑥.1` clause 8)

> **Rule**: **before changing a contract you must trace the callers** (clause 8's "impact scope / omissions" requirement, applied to the API scenario, is this section). Tracing produces the **Breaking-change impact list**; **without proof of "no callers", a field/endpoint must not be deleted.**
> **Object scope**: ① backend call sites (grep caller modules/services); ② **frontend data flow** (changing a field/interface/push requires tracing the frontend consumption path, explicitly required by clause 8); ③ cross-service/cross-module contracts (subscribers of OpenAPI / interface contracts, event/message schemas); ④ documentation and script consumption points.

### 5.1 Tracing Actions and Outputs

| Step | Action | Output |
|---|---|---|
| 1 | **List the change surface**: which fields/endpoints/events change, and which §2 class each is | Change entries (citing §2 item numbers) |
| 2 | **grep the call sites**: search field names / paths / symbols repo-wide and cross-repo | Call-site list (files/modules, **write the section, not a line number**, `§⑥.1` clause 11) |
| 3 | **Trace the frontend data flow**: interface → store → component/render; push → subscriber | Frontend consumption-path list |
| 4 | **Check cross-service contracts**: referencing parties of OpenAPI / interface contracts / event schemas | Contract-reference list |
| 5 | **Judge argument breaks**: verify parameters hop by hop along the call chain (type/field/naming/structure/protocol — the 5 break-point classes in clause 8, **by number, not copied**) | Break-point records |
| 6 | **Summarise**: each row = change → affected party → impact type → migration action → owner | **Breaking-change impact list** |

### 5.2 Hard Rules

- **No caller proof ⇒ no deletion**: before deleting a field/endpoint there must be reproducible evidence of "zero consumers" (search command + result + telemetry usage, in the single-source-of-truth spirit of `§⑥`). **Deleting without tracing = violating `§⑥.1` clause 8**.
- **The impact list is input to deprecation/removal**: the "no active consumers" criterion in §4 "removal at expiry" is taken from this list + §4.1 ③ telemetry.
- **Cross-segment consistency**: if the change crosses segment/worker boundaries, register the affected surface in the segment-completion snapshot per the cross-segment consistency contract.

> **Rule / responsibility / landing point**: rule = "trace before you change; no proof, no deletion"; responsibility = tracing and the list are the change implementer's (Linus), and reviewing "was the frontend/cross-service side fully traced" is Elon's/Turing's (analogous to `§⑥.1` clause 10 scenario truthfulness); landing point = grep/search is **machine-checkable** (a script can run it, see §7), while "was it traced completely" is a **manual** criterion.

---

## 6. Contract Tests

> **Rule**: contract tests = assertions on the **contract surface** (not implementation details), serving as a **machine-check gate**. The contract surface covers at least: **field names / field types / status codes / error codes / pagination structure** (aligned with `PROTOCOL §⑥.1` clause 4, "every external API has at least 1 integration test verifying status code + key fields").

### 6.1 Assertion Surface

| Contract surface | Assertion | Landing point (example) |
|---|---|---|
| **Field names/structure** | Response key set, `snake_case` naming, envelope shape | A contract-test directory, e.g. `test/contract/*` + the HTTP-layer tests `test/server/*`; the shared wire projection is the single source |
| **Field types** | Type / nullability / array element type | Same as above |
| **Status codes** | Success/failure HTTP code | Route errors map through the shared error-code table |
| **Error codes** | **Error-code vocabulary consistency** (no codes invented/rewritten out of thin air) | The shared `ERROR_CODES` table is the single source of truth; a contract test can prove its partition is exhaustive |
| **Pagination structure** | `limit/offset` (or cursor), total count, sort stability | The query contract of the list routes (e.g. `GET /items`) |

### 6.2 Contract-Snapshot Comparison

- **Form**: freeze the contract surface into a **snapshot artifact** (e.g. an OpenAPI document, a JSON Schema, or a route/error-code listing) under version control.
- **Gate action**: on change, **diff** against the snapshot; a **breaking diff (matching a §2 B item) is blocked**; a non-breaking diff passes and is recorded.
- **Snapshot artifact form: to be decided.** A lightweight, offline, zero-dependency form is recommended: generate an OpenAPI document where a generator exists, and in all cases export a JSON "route table + error-code table + wire field table" as a second snapshot. Both must run in CI with no network.
- **Where no OpenAPI toolchain exists**, the exported JSON listings (error-code table + wire projection + route table + interface-contract document) are themselves the contract artifact and are already a contract-test subject.

> **Rule / responsibility / landing point**: rule = contract tests are a **gate, not an optional test**; responsibility = authoring is the implementer's (Linus), and verifying scenario truthfulness is Turing's (`§⑥.1` clause 10); landing point = **CI machine-check** (see §7).

---

## 7. Machine-Checkable vs Manual — Master Table

> Aligned with `PROTOCOL §⑳.1` (machine-checkable gates). Register new gates in this table.

| Check | Machine-checkable (landing: CI / check-all / hooks) | Manual (responsible role) |
|---|---|---|
| **Contract-snapshot diff** (block breaking OpenAPI/Schema diffs) | ✅ machine: CI (snapshot comparison) / check-all | — |
| **Contract tests** (field names/types/status codes/error codes/pagination) | ✅ machine: CI test suite (`node --test` picks up `test/contract/*`, `test/server/*`) | Scenario-truthfulness verification (Turing, `§⑥.1` clause 10) |
| **Error-code vocabulary consistency** (no codes changed out of thin air) | ✅ machine: CI (error-code-partition exhaustiveness assertion) | Semantic judgement of whether a new code is "non-breaking" (Elon) |
| **Lint for unmarked breaking changes** (error if a change is unmarked `BREAKING` / unversioned) | ✅ machine: CI/hooks (e.g. cross-check of changelog `BREAKING` marker + version-bump magnitude) | Whether the magnitude matches the change (Elon, `release-versioning-sop.md §6.2`) |
| **Deprecation-marker presence** (`Deprecation`/`Sunset` header or registry marker) | ✅ machine: CI/inspection | **Deprecation-period duration and approval** (Elon, `§⑭`) |
| **Route/version-prefix consistency** (`/vN/` prefix, no duplicate/conflicting registration) | ✅ machine: CI (route-table tests) | **Version generation-cut decision** (whether to cut `/v(N+1)/`, Elon) |
| **Call-site search** (grep for presence/absence of consumers) | 🟡 half machine: a script can run the search | **"Was it traced completely" (frontend/cross-service)** (Elon/Turing) |
| **Breaking-change criterion (esp. B3 semantic change)** | ❌ not machine-checkable | **Manual**: Linus determines + Elon reviews |
| **Version-bump decision** (MAJOR/MINOR/PATCH) | ❌ not machine-checkable (a machine can only check "declared magnitude vs changelog"; the criterion itself is human) | **Manual**: Linus decides, Elon reviews (`release-versioning-sop.md §2.1`) |
| **"Is a new enum value breaking" determination** | ❌ not machine-checkable | **Manual**: depends on the §5 impact list (do consumers tolerate unknown values) |
| **Deprecation approval / expiry-removal approval** | ❌ not machine-checkable | **Manual**: Elon (`§⑭`) |

---

## 8. Landing Points (how this SOP is carried)

> "Landing point" = who executes the action / which machine gate carries it: **CI / check-all / hooks / manual**.

| Carrier | What it carries | Notes |
|---|---|---|
| **CI** | Contract tests (field names/types/status codes/error codes/pagination), contract-snapshot diff, route-prefix consistency, error-code vocabulary assertions, the unmarked-breaking-change lint | Must stay **offline / zero-dependency**: when no OpenAPI toolchain is available, use the exported JSON snapshot instead |
| **check-all** | Team-level gate — validates this SOP's reference/redline consistency | Does **not** replace a project's own contract tests |
| **Hooks** | Contract-snapshot comparison on `pre-push`/`pre-tag` | To be decided per project |
| **Manual** | Breaking-change criterion, version-bump decision, deprecation approval, impact-list review | Responsibilities per §2/§3/§4/§5 |

---

## 9. Related Clauses

- Version bump + changelog `BREAKING` trail → `release-versioning-sop.md §2/§3` (`PROTOCOL §㉑`); rollback → its §5.
- Consumer-impact tracing (this SOP completes it) → `PROTOCOL §⑥.1` clause 8; scenario-truthfulness verification → clause 10; reference convention → clause 11.
- Deprecation approval / expiry removal → `PROTOCOL §⑭` (confirmation gate); overdue handling → `§⑮`.
- Contract defect found → defect loop, `PROTOCOL §⑨`.
- DB/schema migration boundary → `data-migration-sop.md` (`PROTOCOL §㉔`).
- Two-way document sync → `PROTOCOL §⑫`; doc layering / no verbatim copying → `§⑰`; machine-checkable gates → `§⑳.1`.
- Release / deploy execution → `ci-release-sop.md`; incident handling → `incident-response-sop.md`.
