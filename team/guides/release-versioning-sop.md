# Release and Versioning SOP (release-versioning-sop.md)

> **Ownership / Maintainer**: **Linus** (engineering) maintains this file. **Elon** is the sole writer of the normative L1 clause (`PROTOCOL §㉑`); this file references it and never copies its body.
> **Depends on**: `PROTOCOL §⑤.1` (public release channel & approval), `§⑥` (git discipline), `§⑥.1` (engineering quality standards), `§⑨.3` (container-form acceptance), `§⑫` (two-way doc sync), `§⑭` (confirmation gate), `§⑮` (SLA/timeout escalation), `§⑮.1` (team-stalled exception channel), `§⑰` (doc layering / no verbatim copying), `§⑳.1` (machine-checkable gates), `§㉑` (release & versioning — the L1 clause this SOP details).
> **Scope**: this file = the **L2.5 method library** (release/version execution detail). Cross-role mechanisms reference L1 (`PROTOCOL §㉑`) and are **not copied** here.
> **Reference convention**: always write `PROTOCOL §<n> <name>` or `guide-name §<section>` — **no line-number anchors, no card-number anchors** (`§⑥.1 clause 11`).

---

## 1. Scope and Boundaries

| Item | Content |
|---|---|
| **Does** | Version-number policy (semver / internal build id), tag conventions, changelog rules, release checklist, rollback plan (forward edit), release channels and approval stance |
| **Does not** | Recovery of the team's own collaboration gateway (see `team/README.md §4 Recovery Handbook`); incident response and on-call (see `incident-response-sop.md`); logs/metrics/alerting (see `runtime-observability-sop.md`); the public-release approval itself (owned by `PROTOCOL §⑤.1` — this file only references its stance); CI gate / build / deploy mechanics (see `ci-release-sop.md`) |
| **Handoff** | The mechanism/carrier that records the version and change history lives in each product repo (see §7); the release approval goes through Elon (§6); runtime observation after the release action completes is handed to `runtime-observability-sop.md` |

> ⚠️ **Object distinction (avoid confusion)**:
> - `PROTOCOL §⑨.3` = **container-form acceptance** (the test environment must cover the actual runtime form) — this SOP's "pre-release checks" **connect** to it (a release requires §⑨.3 evidence beforehand), but §⑨.3 is **not** the release/version SOP.
> - `team/README.md §4 Recovery Handbook` = recovery of the **team's own gateway** (its object is the team's collaboration substrate), **not** a product-level release SOP.

> **This file vs `ci-release-sop.md`**: that sibling guide owns the **CI gate, build and deploy** mechanics. This SOP owns **version numbers, tags, changelog and release channels**; where an item belongs to CI/build/deploy, it is referenced, not duplicated.

---

## 2. Version-Number Policy

> **Stance**: the externally traceable version number is uniformly **semver**; build/internal identifiers use **build metadata**, kept separate. **There is exactly one source of truth for the version number** — hand-writing it in multiple places is forbidden.

### 2.1 semver semantics (MAJOR / MINOR / PATCH)

| Digit | When it increments | Criterion (against the external contract) |
|---|---|---|
| **MAJOR** | Incompatible external change | Breaks an existing interface / data structure / config semantics; callers must change code to upgrade |
| **MINOR** | Backward-compatible feature addition | New interface/capability; old usage still works |
| **PATCH** | Backward-compatible bug fix | Bug fix / copy / internal refactor only; the external contract is unchanged |

- **0.y.z phase**: during initial development the external contract is not frozen — incompatible changes **may** ride the MINOR digit, but the changelog **must** explicitly mark them **BREAKING**. A project still at `version: 0.0.0` is in an unreleased state.
- **Increment responsibility**: the **implementer (Linus)** sets the increment **when initiating the release**; the **reviewer (Elon)** confirms **at approval time** that it matches the actual size of the change (against the §3 changelog).

### 2.2 Internal version / build number (build metadata)

- **Shape**: `<semver>+<build>`, e.g. `0.0.0+sha.a1b2c3d`, `0.0.0+ci.20261009.7`.
- **Semantics**: build metadata **does not participate** in semver precedence comparison (everything after `+` is for traceability only) and **must not** be used to express compatibility semantics.
- **Source**: injected automatically by CI or the local build script (git short sha / CI run number); **hand-writing is forbidden**.
- **Zero-dependency / offline projects**: when there is no runtime build pipeline, the build id may degrade to "the commit sha at local packaging time", recorded in the changelog or the release notes. The concrete injection method is **to be decided** where no unified builder exists.

### 2.3 Pre-release channels (`-alpha` / `-rc`)

| Suffix | Meaning | Allowed release channel (§6) |
|---|---|---|
| `-alpha.N` | Internal / early validation, contract may still change | dev |
| `-beta.N` | Awaiting external validation (optional) | staging / canary |
| `-rc.N` | Release candidate, feature-frozen, bug fixes only | staging → prod |

- **Stance**: pre-release suffixes are for **non-stable channels only**; a version entering prod **must not** carry a pre-release suffix.
- In semver ordering a pre-release is **lower than** the same-numbered release (`1.0.0-rc.1 < 1.0.0`).
- **Responsibility**: the initiator marks the channel; Elon confirms at approval that the suffix matches the target channel.

### 2.4 Tag naming convention

- **Format**: `vX.Y.Z` (release) / `vX.Y.Z-alpha.N`, `vX.Y.Z-rc.N` (pre-release); **always with the `v` prefix**.
- **Form**: **annotated tag** (with author / time / description); the tag message reads "version + one-line summary + pointer to the changelog section".
- **Uniqueness**: one version number is tagged once; **moving / force-pushing an existing tag is forbidden** (it falls under the `§⑥` destructive-git prohibition). Tagged by mistake ⇒ **increment PATCH and re-release** (see §5).
- **Trigger**: the release pipeline is triggered by pushing a tag matching `v*` (see `ci-release-sop.md` for the workflow details).
- **Ledger**: the tag is the version's **external anchor**; changelog, build artifact and release notes must each correspond one-to-one with the tag (§3.3).

### 2.5 Version source (single source of truth)

| Repo/delivery shape | Version source (single source of truth) | Notes |
|---|---|---|
| **Single-package repo** | the package/build manifest's `version` field | Packaging/release reads this field |
| **Multi-subproject repo** | **to be decided** (candidate: each subproject's manifest) | First define the "release unit"; a repo holding multiple subprojects must pick the unit before a version source can exist |
| **Document-as-source project** | **to be decided** (suggested: a `VERSION` file or the source document's frontmatter) | When the source of truth is a document, carry the version there |

- **Hard rule**: anywhere "the version number appears" (README, changelog, build script, artifact name) **must not** each hand-write it; always read from, or reference, the source of truth (the same principle as `PROTOCOL §⑰` single source of truth, applied to the version dimension).
- **Responsibility**: the source of truth is maintained by the implementer (Linus); consistency is checked by the release checklist (§4.1), by machine or by hand.

---

## 3. Changelog Rules

### 3.1 Format (Keep a Changelog style)

- **Fixed groups** (write if present, omit if not): `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`.
- **Version section**: `## [X.Y.Z] - YYYY-MM-DD`; keep a `## [Unreleased]` section at the top accumulating unreleased changes.
- **Entries**: start with a verb, described **for the user** in terms of impact (not a restatement of commits); breaking changes must be explicitly marked **BREAKING** in the entry.
- **Language**: **follow the project's default documentation language** (`PROTOCOL §⑥` / the project's `default_git_rules` stance) — a project whose default docs are English keeps the changelog in English (bilingual where necessary); a project whose docs are Chinese keeps the changelog in Chinese with technical terms left in English.
- **Location**: the changelog file at the repo root (a project without one shows `to be created`, see §7).

### 3.2 Who writes / when

| Point in time | Action | Responsibility |
|---|---|---|
| **On merge** | Write the change entry into the matching group under `## [Unreleased]` | The change implementer (usually Linus) |
| **On release** | Freeze `[Unreleased]` into `[X.Y.Z] - date`, and open a fresh empty `[Unreleased]` | The release initiator (Linus), reviewed by Elon |
| **Bug fix** | After regression, backfill a `Fixed` entry (backfill per `PROTOCOL §⑫`) | The fixer |

- **Stance**: **write on merge** (not coupled to release); at release time only the "freeze" action is performed — this avoids recalling changes from memory at release time.

### 3.3 Correspondence with commit / tag

- **commit → changelog**: a changelog entry **may** cite the corresponding PR/commit short sha as a trace, but **not every commit is required** to enter the changelog (only user-facing changes are recorded).
- **tag → changelog**: **every `vX.Y.Z` tag must correspond to a same-named version section in the changelog** (missing one fails the release gate, §4.1).
- **Release notes**: the tag's annotated message or the release notes = an excerpt of that changelog version section (slimmed down; the `PROTOCOL §⑬.4` stance).

---

## 4. Release Checklist (checkable)

> Three phases: **pre-release** (all-green gate) → **during release** (tag/build/artifact) → **post-release** (smoke/backfill/observation).
> A failed gate blocks the next phase; any failure ⇒ stop in that phase and decide per §5.

### 4.1 Pre-release

- [ ] **Unit tests all green** (the project's test command; the CI-gate mechanics are `ci-release-sop.md`)
- [ ] **Coverage threshold met** (`PROTOCOL §⑥.1`; a project sets its own floor — e.g. lines/branches/functions ≥ 80%; where a repo has no threshold defined it is **to be decided**)
- [ ] **Integration / E2E**: critical paths pass (interfaces / data flow)
- [ ] **lint / static checks**: the project's static-check command passes
- [ ] **Container-form acceptance (`§⑨.3`)**: the critical path is **actually run** in the artifact's real runtime form with evidence (command + output); host-form green does not count
- [ ] **CI green**: the push/PR-triggered CI pipeline is all green (see `ci-release-sop.md`)
- [ ] **Version source updated** (§2.5) and matching the size of this change (§2.1)
- [ ] **Changelog frozen** (§3.2), `[Unreleased]` → `[X.Y.Z]`
- [ ] **Documentation impact determined** (`§⑫`: the design docs to sync, or an explicit "no documentation impact" declaration)
- [ ] **Approval passed** (§6, trailed as a confirmation record)

### 4.2 During release

- [ ] **Tag annotated**: `vX.Y.Z` (with message; §2.4), **placed in one step, never moved**
- [ ] **Trigger the build**: the tag `v*` triggers the release pipeline (re-run checks + `build` + packaging dry-run — build/pipeline mechanics are `ci-release-sop.md`)
- [ ] **Artifact verification**: the packaged file list matches expectations; the build succeeds; no unexpected files enter the package
- [ ] **tag ↔ changelog ↔ artifact**: all three carry the same version number (§3.3)
- [ ] **(if applicable) Release notes**: release notes = a changelog excerpt

> **Note**: "release" here is defined as **tagging + passing the release pipeline + producing a traceable artifact**. Actual distribution (publish / upload) is a separate concern; where it is not yet enabled it stays **to be decided** (distribution channel).

### 4.3 Post-release

- [ ] **Smoke test**: run one real main path in the target form (aligned with `§⑨.3`)
- [ ] **Backfill changes**: `PROTOCOL §⑫` reverse backfill — design docs / README catch up with the code; changelog completed
- [ ] **Trail**: a confirmation record (approver / time / tag / artifact link)
- [ ] **Observation window**: enter the post-release observation period (duration and metrics per `runtime-observability-sop.md`; where no window is defined it is **to be decided**)
- [ ] **Anomaly handling**: an anomaly within the window ⇒ hand to `incident-response-sop.md`, and roll back per §5 if necessary

---

## 5. Rollback Plan (forward edit, per `PROTOCOL §⑥`)

> 🔒 **Hard constraint**: this SOP's "rollback" is **not** a reverse git operation. **Forbidden**: `git revert` / `git reset` / `git checkout --` / `git restore` / `git stash` / `git clean` / `push --force` (`§⑥`). Every rollback is realized by a **forward edit + a normal commit**.

### 5.1 Rollback definition

**Rollback = re-releasing "the previous verified version" (a forward re-release)** — i.e. on the current repo, **forwards** the code/artifact back to the behavior of the last verified version, and **increments a new version number** (PATCH) for the outside, rather than erasing history.

| Layer | Rollback method (forward) |
|---|---|
| **Code** | "If you changed it wrong, change it back": restore the previous logic with a **new forward-edit commit** (equivalent to re-applying the previous diff); the commit message notes the forward restoration; stage explicitly with `git commit -- <explicit path>` |
| **Artifact / distribution** | Re-release the artifact of "the previous verified version" (new tag); do **not** delete an already-released version; if the registry supports it, mark it deprecated (a forward declaration), **do not** force-unpublish |
| **Config** | Forward-edit back to the previous config values; where environment variables / version numbers are involved, record a `Changed` entry in the changelog afterwards |
| **Data / migration** | **must satisfy one of**: ① **backward-compatible** (both old and new code can read the schema/data) ⇒ switch back directly; ② **not backward-compatible** ⇒ **direct data rollback is forbidden**; go through a **forward fix** (write a new migration moving the data to a safe state). **Forbidden**: destructive actions like dropping a DB/table or reverse-engineering a schema (migration mechanics are `data-migration-sop.md`) |

### 5.2 Rollback decision criterion: when to roll back vs forward-fix

| Condition | Recommendation |
|---|---|
| Large impact (core path unavailable / data damaged) and **the previous version is usable** | **Roll back** (forward re-release of the previous version) — stop the bleeding first |
| The fix is **small and clear** (a single-point bug, a change of < 1 block) | **Forward fix** (cut a new PATCH) — avoid flip-flopping |
| Involves an **irreversible data migration** | **Forward fix** (unless backward-compatible) |
| The rollback itself is **high-cost / high-risk** (downstream already depends on the new contract) | **Forward fix** |
| Root cause not located | First **stop the bleeding** (rollback or degrade), then locate; do not make consecutive forward changes before locating the cause |

- **Responsibility**: the rollback / forward-fix **decision is approved by Elon** (major: escalate to Terry); **execution belongs to Linus**; trailed as a confirmation record.
- **After rollback**: a "root cause + regression" card must be opened (`§⑨` defect-fix loop), and the failed release noted in the changelog as `Removed`/`Fixed`.

---

## 6. Release Channels and Approval

### 6.1 Channel definitions

| Channel | Purpose | Version form | Audience |
|---|---|---|---|
| **dev** | Development / self-validation, may break at any time | `-alpha.N` / `0.y.z` | Team-internal |
| **staging** | Pre-release validation, canary | `-beta.N` / `-rc.N` | Team + internal acceptance |
| **prod** | Externally / production usable | `X.Y.Z` (no pre-release) | External / production |

> **Alias stance**: `alpha/beta/stable` map one-to-one to `dev/staging/prod` (alpha↔dev, beta↔staging, stable↔prod); a project uses only one naming set and must not mix them.

### 6.2 Approvers

- **Default (until a different ruling)**: **public release / production (prod)** is approved by **Elon**; **major upgrades** (MAJOR / breaking change / involving data migration) **escalate to Terry**; **dev/staging / internal validation** is self-approved by the implementer with a trail, with Elon reviewing where necessary. The exact approver set per repo is **to be decided**.
- **Relation to `§⑤.1`**: the **public release action itself** (delivery/distribution to an external audience) still follows `PROTOCOL §⑤.1` (always through Elon); this file only adds the "version/tag production" side of the stance.

### 6.3 Trail

- Every release / rollback must leave a trail: a **confirmation record** (`task.comment kind=confirm`) containing: version number, tag, target channel, approver, time, artifact/link, associated changelog section.
- **Forbidden**: substituting "verbal agreement" for an approval trail; skipping the gate to tag directly; force-pushing an existing tag.
- SLA per `PROTOCOL §⑭` (confirmation gate) / `§⑮` (timeout escalation); team-stalled cases go through `§⑮.1`.

---

## 7. Landing Points by Repo Shape

> "Landing point" = who actually executes the action / which machine gate carries it: **CI / script gate / hook / human**.
> "Version / change carrier" = the file or directory where the version number and the change record **actually live**.

| Repo shape | Version / change carrier (actual) | Landing point (CI / script gate / hook / human) | Notes |
|---|---|---|---|
| **Single-package public repo, offline / zero-dependency** | Version = the manifest's `version` field; changes = the changelog file (create if absent); tag = `vX.Y.Z` | **CI**: a push/PR check workflow + a tag-`v*`-triggered release workflow (re-run checks + build + packaging dry-run; distribution not necessarily enabled). **Human**: tagging, changelog freeze/review, approval | Single version source (the manifest); changelog follows the project's default doc language |
| **Multi-subproject repo (code + design docs in separate repos)** | Changes = the design-doc repo + each subproject's source; version = **to be decided** (the version-source file) | **CI + human**; branch/environment naming **to be decided** | Release described as a **dev→release branch** flow; each repo leaves its own trail; a directory excluded from git **must not** be used as a version/tag carrier |
| **Document-as-source project (not a git repo)** | Changes = the source document; version = **to be decided** (no version file yet); generated-artifact directories are **not** versioned | **Human + a script gate**: redlines / terminology / `§`-references / card schema / contract tests; **no CI** ⇒ "release checklist + human trail" dominates | No version control ⇒ substitute "source-document version/date + manual changelog"; generated output must not be treated as a version artifact |

**Generic landing-point summary**:
- **CI carries it**: single-package repos with a check workflow + a tag-triggered release workflow (mechanics in `ci-release-sop.md`).
- **A team-level check script carries it**: team-level gates (`PROTOCOL §⑳.1`) — used to check this file's references / redlines / card-schema consistency, and **not** a substitute for the project's own build/test gate.
- **Hook**: project-side commit / release hooks are **to be decided** (a pre-tag check is a candidate).
- **Human**: approval, tagging, changelog freeze, rollback decision — all human landing points (responsibilities in §3 / §5 / §6).

---

## 8. Related Clauses

- Version/tag/changelog/channel mechanisms → `PROTOCOL §㉑` (the L1 clause this SOP details); public release approval → `PROTOCOL §⑤.1`.
- Git discipline (no destructive commands; forward-edit rollback) → `PROTOCOL §⑥`; engineering quality standards → `PROTOCOL §⑥.1`.
- Container-form acceptance → `PROTOCOL §⑨.3`; two-way doc sync → `PROTOCOL §⑫`; confirmation gate → `PROTOCOL §⑭`; SLA / timeout escalation → `PROTOCOL §⑮` / `§⑮.1`; doc layering / no verbatim copying → `PROTOCOL §⑰`; machine-checkable gates → `PROTOCOL §⑳.1`.
- Sibling guides: `ci-release-sop.md` (CI gate / build / deploy), `runtime-observability-sop.md` (log/metric/alert + observation window), `incident-response-sop.md` (incident handling), `data-migration-sop.md` (data migration / forward fix), `api-compat-sop.md` (external contract compatibility).
- Team-gateway (not a product) recovery → `team/README.md §4 Recovery Handbook`.
