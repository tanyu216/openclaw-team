# PROTOCOL-gates.md — OpenClaw Team Protocol, Volume II (Product & Engineering Gates)

> **This is the second volume of `team/PROTOCOL.md`.** The two files are **one logical document with one section numbering space**:
> this volume continues at §21 and runs through §29 + Appendix A; §1–§20 live in `PROTOCOL.md`. **A bare `§N` in either volume
> refers to that shared numbering** (so `§6` here means `PROTOCOL.md` §6), and a citation elsewhere may say `PROTOCOL §22`
> without naming this file.
> **Ownership / Maintainer**: Elon (structure) and the owning role named in each section (content) — `PROTOCOL §3`.
> **Status**: L1, same layer as `PROTOCOL.md`. Numbering only grows, never changes (`PROTOCOL §17`).
> **Applies to**: every role, **when the card's project touches the gate's domain** — these sections are read on demand,
> not every turn. Reading set per role: each `roles/<role>/AGENTS.md` "Hard prerequisite for starting".
> **Reference convention**: `guides/doc-style.md` §6 / `PROTOCOL §6.1` clause 11.

---
## 21. Release and Versioning

> Object = the **version and release of a product/deliverable**. Method: `guides/release-versioning-sop.md`. Cross-references (not copied): `§6` (git discipline) / `§9.3` (container-form acceptance) / `§12` (doc sync) / `§14` (confirmation gate) / `§5.1` (outward publication approval).

1. **Single version source**: each deliverable's outward version number has exactly **one source of truth** (e.g. the package manifest); every other place references it — no hand-written copies.
2. **semver**: MAJOR = incompatible outward change / MINOR = backward-compatible addition / PATCH = backward-compatible fix; during `0.y.z` a MINOR may carry an incompatible change but the changelog must state "incompatible"; **build metadata** (`<semver>+<build>`) is separate from semver, is not compared, and is not hand-written.
3. **Tags**: releases are `vX.Y.Z` (pre-release `-alpha.N` / `-rc.N`), always **annotated**; a version is tagged once and never moved/force-pushed (`§6`); a wrong tag ⇒ bump PATCH and re-release.
4. **changelog ↔ tag one-to-one**: every `vX.Y.Z` has a same-named changelog section (missing ⇒ the release gate fails); the changelog is written **on merge** (`[Unreleased]`) and the release only **freezes** it; breaking entries are marked **BREAKING**.
5. **Three-phase release checklist**: pre-release (tests green / coverage met / lint / **container-form acceptance `§9.3`** / CI green / version source updated / changelog frozen / **doc-impact determination `§12`** / approval) → release (annotated tag / trigger the build / artifact verification / **tag ↔ changelog ↔ artifact version agreement**) → post-release (smoke in the target form / **reverse backfill `§12`** / trail / observation window / exceptions → incident response). Do not advance past a failed gate.
6. **Rollback (`§6`)**: re-release the previous verified version with a **new PATCH**; **forbidden**: the destructive-git set (`§6`); when data has **no backward compatibility**, **do not roll the data back directly** — use **forward repair**. The rollback/forward-repair **decision is approved by Elon** (major upgrades by the operator); **execution belongs to Linus**.
7. **Release approval and trail**: outward/production releases are **approved by Elon**; major changes (MAJOR / breaking / involving data migration) escalate to the **operator**; dev/staging internal validation is self-reviewed with a trail. Every release/rollback is recorded as `task.comment kind=confirm` (version / tag / channel / approver / time / artifact link / changelog section). Outward publication itself still follows `§5.1`.

---

## 22. Runtime Observability (product-level)

> Object = the **runtime state of the delivered product/service** (logs / metrics / alerts / health / inspection); **not** the team's own gateway recovery handbook (`team/README.md §4 Recovery Handbook`). Method: `guides/runtime-observability-sop.md`.

1. **Structured logs**: product logs are **JSON lines** through a single wrapper; **no bare `print`/`console.log`**. Required fields (missing one = non-conforming): `ts` (with timezone) / `service` / `env` / `request_id`|`task_id` / `trace_id` / `level` / `msg`.
2. **Log redaction (hard rule)**: secrets / tokens / credentials / PII **never enter logs**; the wrapper does field whitelisting + value-level redaction; never dump whole request bodies/configs. Redaction failing ⇒ do not deliver.
3. **Minimal metric set**: latency percentiles **p50/p95/p99 (never averages)**, request volume / error rate / saturation / queue depth / key business volume; naming `<service>_<subsystem>_<metric>_<unit>`; must be **programmatically scrapeable** (`/metrics` or OTLP), not log-text only.
4. **Alerts must be executable**: every alert carries **five elements** (trigger condition / threshold / impact / **runbook pointer** / escalation target); missing one = do not ship; deduplicated + suppressed.
5. **Health endpoints separated by semantics**: `/health` (liveness, self only, fail ⇒ restart) and `/ready` (readiness, checks dependencies, fail ⇒ de-pool, no restart) **must be separate**; never mixed.
6. **Routine inspection**: daily health/ready all green + no new P1 error cluster; weekly metrics within thresholds + no "non-executable alerts"; monthly log rotation healthy; criteria must be decidable (green/amber/red) — no "looks fine".
7. **Product inspection ≠ team check-all** (`§20.1`): **cannot be merged and cannot substitute for each other**.

---

## 23. Product Incident Response

> **Object = a product/service production incident**; different from `§15` (team collaboration SLA) / `§15.1` (team stalled), which are **different objects and not interchangeable**. Criterion: a failure in production ⇒ this clause; collaboration stuck ⇒ `§15`; orchestration stalled ⇒ `§15.1`. Method: `guides/incident-response-sop.md`.

1. **Severity S1–S4** (impact × severity × duration + **red-line factors**: any of data / money / security ⇒ bump severity, at least S2, usually S1): S1 ack immediately, mitigate ≤30min, postmortem ≤72h; S2 ack ≤30min, mitigate ≤4h, postmortem ≤72h; S3 ack ≤4h, mitigate ≤24h; S4 routine. Working hours 09:00–23:00; missing a mitigation target ⇒ **escalate one level** with a trail.
2. **on-call / first response**: first response = the on-duty engineering owner (default **Linus**); the only human-facing channel = **Elon** (`§5`); if the rotation table is undecided ⇒ mark as a **gap**, defaulting to "Linus engineering first response + Elon coordination/outward". A handover must explicitly transfer the open incident's severity/state/done/pending/evidence.
3. **Seven-step response**: detect → classify → stop-loss/mitigate → localize → fix → recover → confirm by observation; **recover before root-cause**; no refactoring during an incident; fixes are forward edits passing tests (`§6.1`), no destructive git (`§6`).
4. **Recovery confirmation**: requires **reproducible evidence** (command/output/metric/key-path real run), in the target form (`§9.3`); if verification fails ⇒ the incident does not close.
5. **Escalation**: technical worker→Elon; business/money/security Elon→**the operator** (red-line factors escalate immediately regardless of level; S1 immediately); only Elon escalates to the operator. Elon unreachable ⇒ switch to `§15.1` (product technical handling still follows this clause).
6. **Communication**: internal conclusion-first, trimmed (`§13.4`); S1 every 15–30min, S2 hourly; outward always through Elon (`§5.1`); no blame / no guessing root-cause / no promising uncontrolled timelines.
7. **Blameless postmortem**: S1/S2 mandatory ≤72h, S3 recommended ≤1 week; aimed at **systems and process**; each action item has **owner + deadline + landing point + verification** (no owner/deadline = undefined); action items are **carded by Elon**, engineering defects follow `§9`; exposed gaps are backfilled into the guide and check-all/CI per `§12`.

---

## 24. Data / DB Migration Discipline

> Object = a product/project DB/schema evolution; a **different object** from `§3` (collaboration-structure invariants). Method: `guides/data-migration-sop.md`.

1. **Forward-compatible first (Expand→Migrate→Contract)**: add-only first (new nullable columns / tables / indexes; no `DROP`/rename/type change/`NOT NULL` before backfill) → backfill/double-write + verify → remove the old path (after confirming no reader depends on it). No single-step destructive change straight to production.
2. **append-only**: migration scripts are written once and only added to; applied migrations are **never edited** — corrections open a **new migration**; naming `NNNN_lower_snake_name.sql`, sequence strictly increasing and unique.
3. **Rollback (`§6`)**: no reverse schema / dropped tables / destructive git; with backward compatibility ⇒ switch back to the old code (data untouched); without ⇒ **forward repair**. Data deletion: files via `rm` + `git commit -- <path>`; rows via a new migration `DELETE` with a trail.
4. **Pre/post validation + idempotency**: every migration carries pre/post validation (row count / non-null / unique / foreign key / invariants), failing ⇒ transaction `ROLLBACK` and abort; must be **re-runnable** (version bookmark / `IF NOT EXISTS` / `ON CONFLICT`).
5. **Constraints pushed down to DB machine checks**: `NOT NULL/CHECK/UNIQUE` / foreign keys / triggers (cross-row invariants `RAISE(ABORT,<stable code>)`); co-located triggers on the same event have pairwise **disjoint** conditions; schema ↔ manifest is cross-checked by contract tests.
6. **Destructive changes pre-approved**: `DROP` / column drop / type change / data deletion **require prior approval** (`§14`); pure Expand/backfill is self-reviewed with a trail; every migration and rollback is recorded as `task.comment kind=confirm`.

---

## 25. API Compatibility and Deprecation

> Object = the compatibility and version evolution of outward / cross-module API contracts; **completes `§6.1 #8`'s** version/deprecation flow. Method: `guides/api-compat-sop.md`.

1. **Breaking criteria**: judged by "does this change an existing consumer's behavior" — if a consumer cannot keep working without changing code, it is breaking (field/endpoint/enum/error-code removal, type change, semantic change, required/default/status-code-mapping/route/auth change, tightened validation, pagination/response-shape change). Non-breaking = adding optional fields/endpoints, loosening validation, copy-only changes. **Whether a new enum/error-code is breaking depends on whether consumers tolerate unknown values** — trace consumers first.
2. **Consumer-impact tracing** (per `§6.1 #8`): before changing a contract trace ① backend call sites ② **frontend data flow** ③ cross-service/module contract (interface / event-schema subscribers) ④ docs and scripts; produce a breaking-impact list; **without a reproducible "no callers" proof, do not remove a field/endpoint**.
3. **Version carrying**: the major version = the compatibility break boundary (bumped only when breaking); within a generation `/vN/` only **adds**; to subtract or re-mean ⇒ cut `/v(N+1)/` and deprecate `/vN/`; **no silent semantic change within a generation**. Semantics reuse `§21` (semver is not redefined).
4. **Deprecate before removing**: ① announce (deprecation + replacement + removal window, with a `Deprecated` trail) → ② coexistence → ③ observe usage → ④ remove on expiry. **Three removal preconditions**: deprecation window elapsed + **evidence of no active consumers** + announcement trail complete. The deprecation window is decided by Elon.
5. **Contract tests / snapshots as a machine gate**: cover field names/types/status codes/error codes/pagination; the contract surface is frozen as a **snapshot artifact** in version control, and a **breaking diff blocks**.
6. **Handoff**: breaking ⇒ version magnitude and `BREAKING` changelog to `§21`; where deprecation approval / outward announcement is needed ⇒ `§14` and via Elon.

---

## 26. Dependency CVE Gate

> Object = scanning and gating known vulnerabilities (CVE/GHSA) in dependencies (direct + transitive); excludes SAST of first-party code (Turing's security audit) and vulnerability-fix implementation (`§9`). Method: `guides/dependency-cve-gate.md`.

1. **Hard gate**: scanning the dependency tree for known vulnerabilities is a **hard gate**; Critical/High **must block**, Medium warns, Low is recorded; the block threshold is decided by Elon (recommended CVSS ≥ 7.0).
2. **Time-boxed waivers**: applicable (no upstream patch / verified false positive / unreachable path); registration requires CVE id · package@version · rationale (with evidence) · expiry · approver · review conclusion; **expiry auto-invalidates and the gate reinstates**; no permanent waivers / no whole-repo blanket exemptions by package name; default waiver ≤90 days (Critical ≤30).
3. **Three scan times**: dependency change + periodic full scan (catch new disclosures) + pre-release (no unwaived Critical/High before release); missing one is a blind spot.
4. **SBOM and trail**: produce an SBOM (SPDX/CycloneDX — pick one and stay consistent) as the dependency-surface snapshot; trail the report/exit code/scanner version/threshold version; zero-dependency projects still produce an SBOM.
5. **Gate registration**: register per `§20.1` (machine-checkable → CI/check-all/hooks) / `§20.2` (not machine-checkable → manual, **never auto-pass**); waiver approval / false-positive adjudication / replacement decisions are human.
6. **Boundaries**: a suspected defect ⇒ `§9`; a release block ⇒ ties into the `§21` pre-release checklist; false positive / unreachable ⇒ adjudicated by Turing.

---

## 27. Performance / SLA Baseline

> Object = product/service performance thresholds and SLA/SLO; the **same word, different object** from `§15` (team collaboration wait times) and **not interchangeable**. Method: `guides/performance-sla-sop.md`.

1. **Latency percentile hard requirement**: performance acceptance always uses **p50/p95/p99**, **never averages**; missing any percentile is non-conforming.
2. **Machine-checkable performance gate**: pre-release / regression / capacity change / performance-sensitive key-path change must run a benchmark with a **threshold assertion** (a non-zero exit code is a failure).
3. **Metric naming single source of truth**: naming/units reference `§22` (`<service>_<subsystem>_<metric>_<unit>`), not re-defined here.
4. **SLA/SLO/SLI distinction**: SLI = a measured value, SLO = an internal target, SLA = an outward commitment; **the SLO must be at least as strict as the SLA**; the SLO is decided by Elon, the outward SLA by the **operator**.
5. **Real-form acceptance**: must run in the container/orchestration form (`§9.3`); cross-container uses actually-reachable addresses.
6. **Baseline filed and regressed**: the baseline is filed (e.g. `perf-baseline.json`: environment / sample / per-path six-tuple); regression applies absolute-then-relative criteria, both must pass; the baseline is refreshed only on a **verified** version.
7. **Landing points**: machine checks land per `§20.1`; threshold/path/SLA/degradation adjudication is marked `§20.2` (human).

---

## 28. Cross-Cutting Mechanisms for Post-Delivery Operations and Engineering Gates

> Merges the common mechanisms of `§21–§23` (product operations) and `§24–§27` (engineering gates).

1. **Three mutually-exclusive, non-substitutable object classes**: ① product/service runtime (`§21` release / `§22` observability / `§23` incident — this clause's object); ② the team's own gateway (`team/README.md §4 Recovery Handbook`); ③ team collaboration process (`§15`/`§15.1`). Judge the object first, then pick the convention.
2. **Always mark gaps, never speculate** (`§19`): undecided items (release approver / on-call rotation / monitoring stack / alert thresholds / release channel / log retention / per-project metrics) are marked as a **gap / to be decided by Elon**; before a decision, follow each SOP's **recommended default** and say it is a default.
3. **The "convention / responsibility / landing point" three questions**: every capability (release / logs / metrics / alerts / health / inspection / incidents / migration / compatibility / CVE / performance) must answer: how the convention is set, who maintains/decides/accepts it, and the landing point (CI / check-all / hooks / manual).
4. **Rollback discipline, cross-cutting** (`§6` / `§24`) — do not restate.
5. **Layered, no duplication** (`§17`): this clause only cross-references numbers and does not define methods; methods live in `guides/` (L2.5).

---

## 29. Card-Creation Idempotency Guard (against same-source duplicate cards)

> **Problem**: concurrent Elon turns / automated turns may **create duplicate cards** for the same intent. `review_of`/title alone are **not enough** (wording varies; same-source reviews by different roles are legitimately distinct cards). Method: `guides/task-interface.md §14`.

1. 🔑 **(Main gate) LLM content de-duplication**: before creating a card, the creator (Elon/LLM) must read the `title`/`goal`/`Background` of existing non-terminal cards (especially those sharing `project`/`target`/`review_of`/`parent`) and judge whether the intent matches. A match ⇒ **do not create** (reuse/merge/append). The mechanical key is only a fallback.
2. **Idempotency key (mechanical fallback)**: `idem = <kind> | <assignee> | <source> | <target>`; `source` = `review_of` if non-empty, else `parent`, else empty. Assignee/kind distinguish same-source reviews by different roles.
3. **Creation must carry the key**: derived automatically by the ACL; may be overridden explicitly with `--idem <key>`.
4. **Reject/reuse**: same key + non-terminal state ⇒ reject creation and return the existing card id.
5. **Title is only a weak signal**: same source + similar title ⇒ warn "suspected duplicate"; never judge by title alone.
6. **Atomic creation lock**: creation takes a lock (same mechanism as `claim`), serialising concurrent creation of the same key.
7. **Exemption**: genuinely-needed same-source cards ⇒ append `#<seg>` to the key, or `--allow-dup` with a `kind=change` rationale.
8. **Landing**: the ACL `task.create` implements semantic de-duplication + the key fallback; the patrol adds a duplicate-key check. In this repository the convention is guaranteed by the connected provider + the creator carrying the key (see `guides/task-interface.md §14`).

---

## Appendix A: Data-Repo Organization Conventions (general basis for material organization)

- **Material scope**: organize by project/topic; sources = video / web page / **PDF / md notes**. Material unrelated to the project topic is not collected → report it to Elon.
- **Authority**: each data repo's root `README.md` and `_templates/` are the **sole authority** for directory structure / templates / frontmatter source enum; extending a source value requires changing the template first.
- **Fact note**: the data repo may itself be a git repo with auto-commit, and materials added/moved within it fall into that repo's tracking scope. If independent traceability is needed before changes, snapshot to `team/workspace/<task-id>/` first.
- Video/PDF handling, association links, directory governance and archive rules: `roles/assistant/guides/research-and-data-repo-conventions.md` §2.
