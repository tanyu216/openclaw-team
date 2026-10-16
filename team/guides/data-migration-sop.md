# Data / DB Migration SOP (data-migration-sop.md)

> **Ownership**: this file is the **L2.5 method library** for data / DB / schema change discipline — the execution detail for tables, columns, indexes, constraints, data backfills and the migration-script lifecycle. The normative mechanism lives in `PROTOCOL §㉔` (data/DB migration discipline); this SOP **details that clause and references it, never copies it** (`§⑰`).
> **Maintainer**: **Linus** (engineering). **Elon** is the sole writer of the L1 normative text (`PROTOCOL`).
> **Depends on**: `PROTOCOL §③` (shared-structure invariants — a different object from the product DB) · `§⑥` (git discipline) · `§⑥.1` (engineering quality standards) · `§⑨` (defect loop) · `§⑨.3` (container-form acceptance) · `§⑫` (two-way doc sync) · `§⑭` (confirmation gate) · `§⑰` (doc layering / no verbatim copying) · `§⑳.1` (machine-checkable gates).
> **Adjacent guides (different objects, not interchangeable)**: `release-versioning-sop.md` (tags / changelog / channels / release approval; see `PROTOCOL §㉑`) · `ci-release-sop.md` (CI gate / build / release / deploy) · `incident-response-sop.md` (incident response / on-call) · `api-compat-sop.md` (external API compatibility).
> **Scope**: L2.5 method library. Cross-role mechanisms that are not data-specific (approval, gate registration) are **referenced by their L1 numbers**, not restated.
> **Reference convention**: always write "`PROTOCOL §<n> <name>`" or "`guide-name §<section>`" — **no line-number anchors and no card-number anchors** (`§⑥.1` clause 11).

---

## 0. Key Distinction (read first — avoid confusion with adjacent SOPs)

> ⚠️ The object of this SOP is **the discipline of data / DB / schema change** — the lifecycle of tables, columns, indexes, constraints, data backfills and migration scripts.
> It is **not** a release / versioning SOP (tags, changelog, channels, release approval → `release-versioning-sop.md`, `PROTOCOL §㉑`), and **not** a runtime observability SOP.

**File-level method (Responsibility / Landing point — every section below is under it)**: per-section wording is owned and landed as:

| Section | Responsibility | Landing point |
|---|---|---|
| §1 Scope and boundary | wording maintained by **Linus** (engineering); L1 text integration belongs to **Elon** | project repository (migration files) + project CI + the team-level aggregator gate (`§⑳.1`) + human approval |
| §2 Forward compatibility | the change plan is designed by the **implementer (Linus)** with the three-step breakdown written in the plan; **destructive cleanup (step ③) requires approver sign-off** (§7) | each step gets its **own migration file** (§3); the step ③ "no reader dependency" evidence goes into the card's progress record |
| §5 Data validation | the validation script + idempotent implementation belong to the **implementer (Linus)**; the **validation assertions are independently re-checked by an independent verifier (Turing) at acceptance** (real business scenarios, aligned with `§⑥.1`) | the validation script goes into the project (called by CI); idempotency is enforced by the runner + bookmark table |
| §6 Invariants and constraints | constraint/trigger design belongs to the **implementer (Linus)**; consistency is machine-checked by the **contract tests** | project CI (running the test suite); a new constraint must be committed together with its migration file (§3) |
| §4 Rollback | rollback / forward-fix is **approved through the confirmation gate** (`§⑭`), with major changes escalating to the next authority; **execution belongs to Linus**; the trail is a confirmation-gate record (`kind=confirm`, `§⑭`) | the data dimension only (§4.1) |
| §7 Approval and trail | the approval **decision** belongs to the confirmation-gate approver (`§⑭`); **execution belongs to Linus** | a confirmation-gate record (`task.comment kind=confirm`) — see §7.2 |

| Dimension | This SOP (data/DB migration discipline) | Adjacent SOP (different object, not interchangeable) |
|---|---|---|
| **Object** | schema evolution and data backfill (migration) | release action and version numbers (`release-versioning-sop.md`) |
| **Focus** | forward compatibility / append-only / validation / invariants / rollback (forward) | tag / changelog / channel / release approval |
| **Junction** | a migration **is a sub-step of a release** ⇒ the release checklist must contain the migration gate | the release SOP's "data/migration" rollback row **references** this file, never copies its text |

- **vs `§⑥.1` (test-resource residue cleanup)**: different object — that clause governs leftover test runners / temp DBs / ports; this file governs the **production schema/data evolution**. They connect (after a migration runs, clean up temp DBs/connections) but do not replace each other.
- **vs `§⑨.3` (container-form acceptance)**: if a migration or data validation runs in a container form ⇒ it must be **actually run inside the target form** (e.g. DB connectivity inside the container), never self-certified on the host process form.
- **vs `§③` (shared-structure invariants)**: a **different object** — `§③` governs **collaboration structures**, this file the **product data plane** (see §3.3).

---

## 1. Scope and Boundary

| Item | Content |
|---|---|
| **Does** | data / DB / schema change discipline: **forward compatibility** (Expand-Contract / stepwise dual-write), **append-only migration scripts**, **rollback strategy (forward edit)**, **pre/post migration validation**, **idempotency**, **invariant and constraint gates**, **destructive-change approval and trail** |
| **Does not** | ① **backup / restore drills** (object is disaster recovery, not schema evolution); ② **capacity planning** (object is resource sizing); ③ **product observability** (logs/metrics/alerts/health — a separate observability SOP); ④ version numbers / tags / changelog (→ `release-versioning-sop.md`); ⑤ live incident response / on-call (→ `incident-response-sop.md`) |
| **Handoffs** | migration scripts land in the project repository (§10); destructive/irreversible migrations are **pre-approved** through the confirmation gate (`§⑭`, see §7); runtime observation after a migration/rollback is handed to the observability path; a failed migration triggers the defect loop (`§⑨`) |

- **Wording**: this file defines only "how a data/schema change is made safe, traceable and machine-checkable". Cross-role mechanisms (approval / gates registration) are always **referenced by their L1 numbers**, never copied (`§⑰` single source of truth). (Responsibility / Landing point → the §0 file-level table.)

---

## 2. Forward Compatibility (Expand → Migrate → Contract)

> **Wording**: schema change is **compatible first, cleanup later**. Every change must let **both the old and the new generation of code run correctly against the same schema** before any old structure is cleaned up. **Forbidden**: a single-step destructive change (`DROP` / rename / `RENAME` / type change) going straight to production.

### 2.1 Three Steps (Expand → Migrate → Contract)

| Step | Name | Allowed | Forbidden | Precondition |
|---|---|---|---|---|
| ① | **Expand (add only, never delete)** | add a **nullable** column / a new table / a new index (`IF NOT EXISTS`); a new constraint only when the existing data already satisfies it | `DROP` / rename / type change / tightening `NOT NULL` before the old data is backfilled | none (forward-compatible, may ship first) |
| ② | **Migrate (backfill / dual-write)** | backfill data into the new column/structure; if needed **dual-write** (both the old and new paths are written) and **validate** (§5) | deleting the old column before the backfill is complete | ① is live; the validation script is ready |
| ③ | **Contract (remove the old path)** | delete the old column/table/index/path; withdraw the dual-write | — | **must confirm "no reader depends on it"** (all readers have switched to the new structure) |

- **"No reader dependency" criteria** (Contract precondition; evidence trail required): ① the whole repository has **no read reference** to the old column/table (code search + contract assertion); ② downstream / external consumers have confirmed the migration (where it is an external contract); ③ within the observation window, access to the old path is 0 (where measurable).
- **Stepwise dual-write / dual-read**: readers switch via "dual-read → canary to new → stop old read"; writers switch via "dual-write → validate consistency → stop old write"; each step is independently reversible (see §4).
- **Example**: widening a status enumeration ⇒ ① relax the `CHECK` / add a nullable column and dual-write; ② backfill historical rows; ③ once no reader depends on it, tighten the constraint and drop the old column.

### 2.2 Destructive-Change Blacklist (never ship in a single step)

| Change | Why it breaks | Compliant path |
|---|---|---|
| `DROP TABLE` / `DROP COLUMN` | old code / downstream may still read or write it | split into step ③, and "no reader dependency" must hold |
| column/table **rename** (`RENAME`) | old code accessing the old name errors | add the new name (step ①) → backfill/dual-write (step ②) → retire the old name (step ③) |
| **type change** (e.g. `TEXT` → `INTEGER`) | incompatible old values / implicit conversion loses data | add the target-type column → convert + backfill → validate → retire the old column |
| tightening a constraint (adding `NOT NULL` / a stricter `CHECK` / `UNIQUE`) | existing data that fails it causes the migration to fail | backfill until satisfied → add the constraint (§6) |

---

## 3. append-only Migration Discipline

> **Wording**: migration scripts are **written once and only added to, never edited**. **A published (already applied) migration file must never be edited**; corrections are always a **new migration**, never a rewrite of history.

### 3.1 Naming and Order

- **Naming**: `NNNN_lower_snake_name.sql` (four-digit zero-padded sequence + an underscore name) — **sortable**, **unique version**, **sequence only increases**.
- **Order**: execution order = filename sort order; a sequence collision (two files with the same number) ⇒ **fail outright**, never silently overwrite.
- **Forbidden**: inserting/deleting a middle number; reusing a used number; editing the contents of an already-applied file (this triggers a checksum mismatch — §3.3).

### 3.2 Reference Implementation (generic)

A representative implementation of this discipline:

- **Carrier**: a version-controlled migrations directory of `NNNN_*.sql` files — append-only, with `STRICT` tables and invariant triggers.
- **Runner** enforces three guarantees:
  1. **Idempotent** — a re-run returns `applied: []` (already-applied versions are skipped);
  2. **append-only** — editing an already-applied file raises a stable error code (e.g. `MIGRATION_CHECKSUM_MISMATCH`) and **refuses to apply**, pointing the author to "add a new `NNNN_*.sql` instead of editing this one";
  3. **atomic** — each file runs in its own `BEGIN IMMEDIATE` transaction; on failure neither the schema change nor a bookmark row is written.
- **Bookmark table**: a migrations bookmark table carrying `version`, `checksum` and `applied_at` columns self-records the version plus a **content checksum** (`sha256`, with `\r\n` normalized to `\n` to avoid cross-platform false "tampering" reads).
- **Schema-current assertion**: a startup assertion (`assertSchemaCurrent`) raises a stable error code (e.g. `SCHEMA_MISMATCH`), listing the missing/unknown migrations when the database is behind (`missing`) or carries unknown migrations (`unknownApplied`) — refusing to serve.
- **Parity contract test**: a contract test reads the migration `.sql` files and the code's declared table manifest and **diffs them both ways** (a table the SQL creates but the manifest omits, or vice versa ⇒ red).

> This is an example of the mechanism, not a fixed requirement. The mechanism — append-only, checksummed, atomic, idempotent, parity-checked — is what is normative.

### 3.3 Boundary with Shared-Structure Invariants (`§③`)

- `§③`: card / scripts / project-registry schema is **maintained by the maintainer and implementers — agents read and write data but do not change the structure**.
- This file: the **product's own DB schema** evolves under this SOP (append-only + validation). The two have **different objects**: `§③` governs **collaboration-structure conventions**, this file governs the **product data plane**.

---

## 4. Rollback Strategy (Forward Edit, per §⑥)

> 🔒 **Hard constraint**: "rollback" in this SOP is **not** reversing the schema, **not** dropping tables, and **not** a git reverse operation. **Forbidden**: `git revert` / `reset` / `restore` / `stash` / `clean` / `checkout --` / `push --force` (`§⑥` git discipline). All rollback is achieved by **forward edit + a normal commit** (or `rm` of a file).

### 4.1 Rollback Definition (data dimension)

**Rollback ≠ reverse schema / drop table.** At the data dimension there are only two legal paths:

| Case | Action | Note |
|---|---|---|
| ① **Backward-compatible** | **switch back to the old code** | the new schema is still readable by old code (e.g. only a nullable column was added, no old structure touched) ⇒ old code runs as-is, **data unchanged** |
| ② **Not backward-compatible** | **forward-fix (do not roll the data back)** | old code cannot read the new schema ⇒ **never** reverse the schema / drop columns / lose data; write a **new migration** that moves the data/schema to a **safe state** (forward) |

- **Forward-fix example**: a new migration adds a column with a default, relaxes a constraint, or repairs bad data back into the legal domain; the **old migration file is untouched** (append-only, §3).
- **Two legal paths for deletion**: ① a **file** ⇒ `rm` (or `trash`) then a normal `git commit -- <explicit path>`; ② a **table row** ⇒ write a **new migration** (`DELETE` statement) and **leave a trail**. **Forbidden**: any destructive act such as "drop the DB / drop the table / reverse the schema".
- **Preserve evidence before delete/overwrite** (`§⑥`): first write `git status --porcelain` + `git log --oneline -3` into the card's progress/report.

### 4.2 Rollback Decision Criteria (rollback vs forward-fix)

| Condition | Recommendation | Reason |
|---|---|---|
| Large blast radius (core path unusable / data damaged) **and** old code can read the new schema (backward-compatible) | **switch back to the old code** (data unchanged) | stop the bleeding first, zero data change |
| No backward compatibility (old code cannot read the new schema) | **forward-fix** (new migration to a safe state) | reversing the schema loses data — a forbidden action |
| The fix is **small and well-understood** (single point, < 1 block) | **forward-fix** (new migration) | avoid flip-flopping |
| A migration is **already applied** but a bug is found | **forward-fix** (a corrective new migration) | applied migrations are append-only (§3) |
| Cause **not yet located** | **stop the bleeding first** (switch back / stop the new write path), then locate | do not chain forward changes before the cause is known |

- **After rollback**: a "root-cause + regression" card must be opened (aligned with the defect loop, `§⑨`), and the change record must be annotated `Fixed`/`Removed`.
- **To be decided**: the production "switch back to the old code" deployment/traffic-switch mechanism depends on each project's deployment form and is out of this SOP's scope.

---

## 5. Data Validation

> **Wording**: **every migration must carry pre- and post-migration validation**; a validation failure ⇒ **the migration aborts** (no half-finished state). Validation and migration share a transaction (or are idempotent and re-runnable), guaranteeing "all or nothing".

### 5.1 Validation Dimensions (run once before and once after)

| Dimension | Assertion (example) | Machine-check landing point |
|---|---|---|
| **Row count** | the target column's non-null row count meets the target; `COUNT(*)` is equal before and after (pure add-column case) | validation script / CI |
| **Non-null** | new-column backfill coverage = 100% (`COUNT(*) WHERE new IS NULL` = 0) | validation script |
| **Uniqueness** | the new `UNIQUE` index builds successfully (no duplicates); `GROUP BY ... HAVING COUNT(*) > 1` is empty | validation script / `§6` constraint |
| **Foreign key** | all new reference values hit the referenced table (no orphan rows); `PRAGMA foreign_key_check` is empty | validation script |
| **Invariant triggers** | a trigger assertion does not `RAISE(ABORT)` because of the migrated data (the data satisfies every invariant) | `§6` triggers + contract test |

- **Pre-validation**: confirm the **precondition** before migrating (that the old data satisfies the premise of the new constraint).
- **Post-validation**: confirm the **target state** after migrating (backfill complete, constraint creatable, invariants hold).
- **Failure handling**: any validation failure ⇒ **roll the migration back to the pre-migration state** (transaction `ROLLBACK`; no bookmark row written) and mark the card `blocked`/`failed` + escalate (aligned with `§⑨`).

### 5.2 Idempotency (re-runnable)

- **Requirement**: migrations must be **re-runnable** (repeating execution produces no second side effect). Reference behaviour: the runner returns `applied: []` for already-applied versions (§3.2).
- **Means**: ① a version bookmark table decides "already applied?"; ② statements use idempotent forms such as `IF NOT EXISTS` / `INSERT ... ON CONFLICT DO NOTHING`; ③ backfill statements carry `WHERE new_col IS NULL` (backfill only unbackfilled rows).
- **Why idempotent**: CI reruns, retries after failure, and multi-environment replays ⇒ a non-idempotent migration causes duplicate data or a failed re-create.

---

## 6. Invariants and Constraints (Machine-Check Gate)

> **Wording**: push "data correctness" down as far as possible into **database-level machine checks** — `NOT NULL` / `CHECK` / `UNIQUE` / foreign keys / triggers — so that an illegal write is **rejected at the write point**, rather than relying on callers' discipline.

### 6.1 Constraint Layers

| Mechanism | Function | Example |
|---|---|---|
| **`STRICT` tables** | reject type-mismatched writes (writing non-text into a `TEXT` column errors) | all core tables declared `) STRICT` |
| **`NOT NULL`** | key columns cannot be null | a workspace/path column `NOT NULL`, a status column `NOT NULL` |
| **`CHECK`** | domain constraint (enum / range) | `kind IN ('agent','human')`, `status IN (...)`, `next_number >= 1` |
| **`UNIQUE` / unique index** | de-duplication | a unique workspace index, a unique identifier index, a **conditional unique index** (`... WHERE source_path IS NOT NULL`) |
| **Foreign key** | referential integrity | `child.parent_id REFERENCES parent(id)` |
| **Triggers (invariants)** | cross-row / cross-column business invariants raised as `RAISE(ABORT, <code>)` with a **stable reason code** | e.g. `SELF_REFERENCE`, `RELATION_CYCLE` / `CHAIN_TOO_LONG` / `FANIN_TOO_HIGH`, `TERMINAL_STATE`, `COMMENT_APPEND_ONLY` |

- **Design note (reusable)**: **multiple triggers for the same event must be pairwise condition-disjoint** (determinism) — otherwise the order in which several `RAISE`s fire is unspecified and the reason code becomes a coin flip. A migration that adds triggers should state "conditionally disjoint" explicitly at its top.
- **append-only invariant**: a table can use triggers to forbid `UPDATE`/`DELETE`, pushing "append-only" down to a DB-level guarantee (the same principle as migration append-only in §3, but a different object).

### 6.2 Contract Tests (schema ↔ manifest, both-way consistent)

- A contract test **exercises both** "the DB-trigger path" and "the service-layer validation path"; if the two drift ⇒ red (ensuring the machine-checked invariant and the business message share one source).
- A parity contract test **diffs both ways**: the tables the migration `.sql` actually creates ↔ the code's declared table manifest.

---

## 7. Approval and Trail

> **Wording**: **destructive / irreversible** migrations (`DROP`, column deletion, type change, data deletion) **must be pre-approved**; everything is executed only after approval. Every migration and rollback **must leave a trail**.

### 7.1 Approval Scope and Responsibility

| Change type | Pre-approval required? | Approver |
|---|---|---|
| Pure Expand (add a nullable column / new table / new index) | No (self-review + trail) | implementer self-review |
| Data backfill / dual-write | No (self-review + pre/post validation) | implementer self-review |
| **Destructive / irreversible** (`DROP` / column deletion / type change / data deletion) | **Yes** | **the confirmation-gate approver (`§⑭`)** |

- **Default (until a further ruling)**: **production migrations** (including any destructive change) go through the confirmation gate (`§⑭`); **major changes** (irreversible / cross-repo / touching core data) escalate to the next authority. (The exact escalation path is **to be decided**.)

### 7.2 Trail Carrier

- **Carrier**: a confirmation-gate record (`task.comment kind=confirm`) whose content includes: **change type** (expand/backfill/contract), **target object** (DB/table/column), **migration file number + name**, **validation result**, **approver/time**, **rollback plan** (§4).
- **Forbidden**: replacing an approval trail with a verbal "OK"; skipping the gate and applying a destructive migration directly; editing an already-applied migration (append-only, §3).
- **Junction**: gates and timing follow the confirmation gate (`PROTOCOL §⑭`).

---

## 8. Migration Checklist

**Before applying**
- [ ] The change is classified (pure Expand / backfill / Contract / destructive) and recorded.
- [ ] For a forward-compatible change, the three-step plan (Expand → Migrate → Contract) is written.
- [ ] A destructive/irreversible change is approved through the confirmation gate (`§⑭`) with a trail.
- [ ] The new migration file is named `NNNN_lower_snake_name.sql`, the sequence is monotonic, and each step is a single new file.
- [ ] Pre-migration validation is written (row count / non-null / uniqueness / FK / invariants).
- [ ] Statements are idempotent (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING` / `WHERE new_col IS NULL`).
- [ ] The rollback plan is recorded (switch back to old code, or a forward-fix migration).
- [ ] The backup / restore point is confirmed (owned by the adjacent disaster-recovery path; referenced, not replaced).

**During**
- [ ] Each file runs in its own `BEGIN IMMEDIATE` transaction.
- [ ] A bookmark row, with version + checksum + `applied_at`, is written only on success.
- [ ] Any validation failure ⇒ `ROLLBACK` to the pre-migration state; the card is marked `blocked`/`failed`; the defect loop (`§⑨`) is triggered.
- [ ] Checksums are normalized for cross-platform stability.

**After**
- [ ] Post-migration validation passes (backfill complete, constraints creatable, invariants hold).
- [ ] The schema-current assertion passes (no missing / unknown migrations).
- [ ] The schema ↔ declared-manifest parity contract test is green.
- [ ] The trail is recorded: change type, target object, migration file number + name, validation result, approver/time, rollback plan.
- [ ] Runtime observation after the migration/rollback is handed to the observability path.

---

## 9. Machine-Checkable vs Manual Gate Matrix

> A card's acceptance hard requirement: **annotate every item's landing point**. A machine-check landing point = `CI / aggregator gate / hook`; a manual landing point = a responsible role.
> "Aggregator gate" = the team-level gate aggregation (`§⑳.1`); "CI" = the project's own pipeline.

| # | Check | Machine-checkable (landing point) | Manual (responsible role) |
|---|---|---|---|
| 1 | **Migration re-runnable / idempotent** (re-run ⇒ `applied: []`) | **CI**: migration-runner unit tests (rerun assertion) | implementer designs idempotent statements |
| 2 | **`STRICT` + constraint assertions** (`NOT NULL`/`CHECK`/`UNIQUE`/FK) | **CI**: contract tests + DB triggers | implementer designs the constraints |
| 3 | **Invariant triggers** (`RAISE(ABORT, code)` assertable) | **CI**: contract tests exercise the trigger path | implementer designs the triggers (pairwise disjoint) |
| 4 | **Pre/post validation script** (row count / non-null / uniqueness / FK) | **CI**: a non-zero exit of the validation script fails | implementer writes it; independent verifier re-checks realism |
| 5 | **Migration file append-only check** (an applied file cannot change) | **aggregator gate**: scan the migrations directory for checksum/sequence uniqueness (the project-side runner also enforces it) | implementer obeys "add only, never edit" |
| 6 | **Naming-convention lint** (`NNNN_lower_snake_name.sql`, unique sequence) | **aggregator gate / CI**: migration filename/sequence lint | implementer names the files |
| 7 | **Migration review** (three-step plan, blast radius) | manual | implementer produces the plan; approver reviews |
| 8 | **Destructive-change approval** (`DROP` / column deletion / type change / data deletion) | manual | **confirmation-gate approver (`§⑭`)**; major changes escalate |
| 9 | **"No reader dependency" criteria** (Contract precondition) | semi-machine-checkable: whole-repo reference search (CI can grep/assert the contract) | confirm downstream / external consumers manually |
| 10 | **Rollback decision criteria** (switch back vs forward-fix) | manual | **approver decides (`§⑭`)**; Linus executes |

- **Landing summary**:
  - **CI carries**: the project's own test pipeline (the migration runner's idempotency/checksum enforcement, the parity/invariant contract tests, the validation script).
  - **Aggregator gate carries**: **text-level lint** over migration files (append-only / naming / sequence uniqueness, `§⑳.1`) — it does **not** replace the project's own DB tests.
  - **Hook**: a project-side migration-commit hook (e.g. a pre-commit check of migration sequence/checksum) — **to be decided**; not yet fixed.
  - **Manual**: approval, review, and rollback decisions are all manual landing points (responsibility in §4 / §7).

---

## 10. Landing Points and Carriers

> "Landing point" = who / which machine gate actually carries the action; "migration trail carrier" = the **actually existing** migration files/directory/table. The carrier depends on the repository shape, so it is chosen per project:

| Repository shape | Migration carrier | Landing point | Note |
|---|---|---|---|
| Version-controlled repo that owns the deployed DB | migrations directory under version control (`NNNN_*.sql`) + a bookmark table (version + checksum) + a declared table manifest in code | **CI** (test suite incl. parity/invariant contract tests) + migration-runner idempotency/checksum enforcement + **manual** plan review & destructive-change approval | the primary case; the reference blueprint (append-only + `STRICT` + invariant triggers) |
| Directory excluded from git (a locally scoped / vault-like root that must not use git) | — | — | such a directory **must not** be relied on for version management and **must not** host the migration files; the real carrier must be verified (see below) |
| Repo that is **not** under version control | no VCS carrier; migrations must be represented as "script + date/doc version + manual trail" | **manual + project scripts** (aggregator-gate scripts, `§⑳.1`); no CI ⇒ "migration script + manual trail" is the main stay | a non-versioned repo has no CI; generated build artifacts must **never** be the migration carrier |
| Multi-repo layout (implementation repo + design/interface docs) | land the migration files in the repo that owns the **implemented DB** (e.g. `projects/<sub>/migrations/*.sql`) | project CI + manual approval | if the schema change also touches design/interface wording, sync those docs (`§⑫`); migrate files must not land in a directory that cannot be versioned |

**Landing-carry rules**:
- A directory that is **excluded from git** (a locally scoped root, a vault root, or similar) **must not** host migration files and rely on version management; verify where the real migration files land first.
- In a multi-repo layout, decide **which repository** the migration files belong to before starting: if each sub-project builds its own DB, give each its own `migrations/` directory; if a schema change also touches shared design/interface wording, sync those docs (`§⑫`).
- **Recommendation** (pending confirmation): land migration files in the repository of the sub-project that implements the DB, and reuse the discipline of §3 / §5 / §6.
