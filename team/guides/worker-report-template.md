# Worker Report Standard (common core + Jobs / Linus / Turing)

> **What this is.** The single shape of a worker's delivery Report, so that Elon's
> acceptance audit (`PROTOCOL §⑨`, redline 11 in the role redline block) has a fixed set
> of slots to look at instead of having to *find* and *guess* them.
> **Who it binds.** Jobs / Linus / Turing (Simons and Assistant follow the common core).
> **Where it lands.** The `## Report` section of the task card (L5 evidence layer,
> `PROTOCOL §⑰`). Message-level reports stay trimmed to conclusion + card path + hash
> (`PROTOCOL §④` reporting discipline) — this guide governs the **card-facing** Report.
> **Language.** English by default (`PROTOCOL §④`); keep code/technical terms in English.
> **Enforcement.** The common core is machine-checked by `team/scripts/check-report.mjs`
> in the `check-all` fast segment (`PROTOCOL §⑳.1`, `AUTOMATIONS.md §3.5.1/§6`). The
> role-specific sections are audited by the role's own review, not mechanically.

## 0. How the slots work (the anchor grammar)

Every required item is introduced by a **slot label** at the start of a line:

```
- **A1 Conclusion** — acceptable | not acceptable; one line.
```

- The label (`A1`, `A2`, …) is the **machine handle** — `check-report.mjs` greps for it
  and reports the card as incomplete when it is absent or carries no text after it.
- The text after the label is **free-form**; length and structure are yours.
- Labels are language-neutral on purpose: `- **A1 结论** — …` is equally valid.
- Slot order in the card should follow the numbering; the anchor only requires presence.
- Wrapping a label in `**…**`, or using `·`/`:`/`—` after it, is all accepted. What is
  **not** accepted is renaming the handle (`Conclusion:` with no `A1`) — that is exactly
  the "slot is unstable, acceptance has to guess" defect this guide removes.

Role-specific slots continue the same grammar: `L1…L6` (Linus), `J1…J5` (Jobs),
`T1…T7` (Turing).

---

## 1. Common core — required for every worker

### A1 Conclusion — verdict first

- **Write**: one line saying whether the deliverable is **acceptable** or **not
  acceptable**, and (when not acceptable) why in the same line.
- **Why acceptance needs it**: Elon's audit opens with the verdict; burying it behind
  evidence forces a full read of the Report to learn the answer.
- **Minimal example**: `- **A1 Conclusion** — acceptable; all 8 Acceptance items met, live gate exit 0.`

### A2 Delivery coordinates

- **Write**: the **card path**, the **commit hash**, the **branch / base**, and whether
  it is **pushed**.
- **Why acceptance needs it**: without the card path the auditor cannot tell *which*
  card the Report belongs to; without the hash the claim is not reproducible.
  (Historical hit rate for the card path is the worst of the whole core — see §4.)
- **Minimal example**:
  `- **A2 Delivery coordinates** — card: tasks/T-20261015-010749-2.md · commit: a1b2c3d · branch: lane/T-20261015-010749-2-seg1 (base 1c54cec) · pushed: no (see A8).`

### A3 Change surface

- **Write**: file count touched, whether the change is **zero-implementation**
  (docs / read-only / registration only), and whether anything went **out of bounds**.
- **Why acceptance needs it**: acceptance has to know whether to audit behavior or only
  text, and whether a boundary was crossed that needs a fresh decision.
- **Minimal example**: `- **A3 Change surface** — 7 files (2 new guides/scripts, 1 new test, 4 wired docs); no implementation change; no out-of-bounds edits.`

### A4 Acceptance item-by-item

- **Write**: a table or list mapping **every** Acceptance item on the card to the
  evidence that discharges it. Unfinished items are marked "not done" — never hidden.
- **Why acceptance needs it**: this is the spine of the audit; a missing row is an
  unauditable Acceptance item.
- **Minimal example**:

  ```
  - **A4 Acceptance item-by-item**
    | # | item | status | evidence |
    |---|---|---|---|
    | ① | guide with common core | done | team/guides/worker-report-template.md §1 |
    | ② | machine check | done | team/scripts/check-report.mjs + tests |
  ```

### A5 Re-run evidence

- **Write**: the **command**, its **exit code**, and a **pointer to the artifact**
  (report file, log path, JSON envelope). "Tests pass" alone is not evidence.
- **Why acceptance needs it**: exit codes and artifacts are what make the claim
  independent of the author's summary. Jobs' historical hit rate here is 17%.
- **Minimal example**: `- **A5 Re-run evidence** — cmd: node --test scripts/tests/check-report.test.mjs · exit: 0 · artifact: workspace/T-…/test-output.txt`

### A6 Residuals / risks / open items + owner

- **Write**: what is left undone, what could bite later, what is still undecided — each
  with a named **owner** for the follow-up.
- **Why acceptance needs it**: an unowned residual is a silent gap; acceptance must be
  able to route it. "None" is a valid answer when true.
- **Minimal example**: `- **A6 Residuals** — the roles AGENTS.md leg cannot be deployed from a lane (outside its roots) → owner: integration leg / Elon.`

### A7 Out-of-literal handling

- **Write**: each place the work went beyond (or chose between) the card's letter —
  itemized, with **whether it is revertible**.
- **Why acceptance needs it**: `PROTOCOL §⑪` requires out-of-bounds handling to be
  visible; acceptance needs to distinguish "authorized extension" from "silent drift".
- **Minimal example**: `- **A7 Out-of-literal handling** — extended the gate to warn on content hints (blocking scope unchanged); revertible: yes (delete the hints table).`

### A8 Not-pushed accounting

- **Write**: if anything is not pushed, say so explicitly, name the branch/worktree, and
  state that the worktree can be reclaimed.
- **Why acceptance needs it**: unpushed work is invisible to everyone else; the
  integration leg needs to know exactly what to fetch and whether it is safe to delete.
- **Minimal example**: `- **A8 Not pushed** — no push; branch lane/T-…-seg1 @ a1b2c3d; worktree clean, reclaimable after merge.`

---

## 2. Role-specific slots

### 2.1 Linus — build / change self-proof

- **L1 Change list (files + line counts)** — every touched file with `+N/-M`.
- **L2 Self-proof method** — how you convinced yourself, and **mutation self-proof**
  (break the logic on purpose ⇒ the check must go red; restore ⇒ green). A test that
  passes both before and after a deliberate break is not self-proof.
- **L3 Regression case readings** — the case counts actually observed (total / passed),
  not the numbers you expected.
- **L4 A / B before-after comparison** — the measured value **before** the fix and
  **after** it, both actually executed. "Should now work" is not a comparison.
- **L5 Build / deploy evidence** — the build or deploy command, exit code, and the
  artifact (hash / path / instance sha before-after for instance legs).
- **L6 Commit discipline** — `git commit -- <explicit paths>`; state that no pathless
  commit and no destructive git was used, and list the exact paths committed.

### 2.2 Jobs — contract vs shipped artifact

- **J1 Authoritative source vs shipped prototype consistency** — which artifact is the
  authority, and how the shipped one matches it.
- **J2 Contract symbol / terminology pinning** — the exact names (blocks, tokens,
  selectors, field names) that downstream work must use, pinned verbatim.
- **J3 Drift check against existing contracts** — what you compared against and the
  result; explicitly note any divergence and its disposition.
- **J4 Prototype "visible + interactive" evidence** — proof that it renders and that the
  interactions work (screenshot path / selector assertion / recording), not just that
  files were written.
- **J5 doc-only proof** — the evidence that no implementation code was introduced
  (`prototype/**` must not contain implementation, `PROTOCOL §⑨.2`): the path set
  touched and the command that shows it.

### 2.3 Turing — independent verification

- **T1 Verification object (SUT tree + base)** — the exact tree and the base commit you
  verified. Verification of "the lane" is not verifiable.
- **T2 Independent re-run** — re-run the checks yourself; **do not cite the lane's
  readings**. Repeating the author's numbers is not verification.
- **T3 Assertion totals / passes** — assertion count and pass count, per suite.
- **T4 Mutation self-proof RED→GREEN** — the mutation you injected, the RED it produced,
  and the GREEN after restoring it.
- **T5 Requirement → implementation → assertion consistency matrix** — every
  requirement mapped to the implementation site and to the assertion that covers it
  (`PROTOCOL §⑥` clause 13). A requirement with no assertion is a gap, not a pass.
- **T6 Defect grading** — per defect: severity, reproduction steps, expected vs actual,
  suspected owner, evidence path.
- **T7 Explicit "not fixed, report only"** — state plainly that verification fixes
  nothing and the defect fix card is created by Elon (`PROTOCOL §⑨`).

---

## 3. Minimal compliant Report

```markdown
## Report

- **A1 Conclusion** — acceptable; all Acceptance items met, live gate exit 0.
- **A2 Delivery coordinates** — card: tasks/T-20261015-010749-2.md · commit: a1b2c3d ·
  branch: lane/T-20261015-010749-2-seg1 (base 1c54cec) · pushed: no (A8).
- **A3 Change surface** — 6 files; 1 new script + 1 new test + 1 new guide + 3 wired docs;
  no implementation; no out-of-bounds.
- **A4 Acceptance item-by-item**
  | # | item | status | evidence |
  |---|---|---|---|
  | ① | guide | done | guides/worker-report-template.md |
  | ② | machine check | done | scripts/check-report.mjs |
- **A5 Re-run evidence** — cmd: node --test scripts/tests/check-report.test.mjs · exit: 0 ·
  artifact: workspace/<id>/test-output.txt
- **A6 Residuals** — none outstanding (or: <item> → owner <role>).
- **A7 Out-of-literal handling** — none (or: <item> · revertible yes/no).
- **A8 Not pushed** — no push; branch <branch> @ <hash>; worktree clean, reclaimable.

### Linus specifics      (or Jobs specifics / Turing specifics)
- **L1 Change list** — guides/x.md +40/-0; scripts/y.mjs +180/-0; …
- **L2 Self-proof method** — … incl. mutation: remove the A5 rule ⇒ gate red; restore ⇒ green.
- **L3 Regression case readings** — 42 total / 42 passed.
- **L4 A/B before-after** — before: exit 1 (4 violations); after: exit 0.
- **L5 Build/deploy evidence** — cmd + exit + instance sha before/after.
- **L6 Commit discipline** — `git commit -- <paths>`; explicit paths; no destructive git.
```

---

## 4. Common gaps (what actually goes missing)

Measured on the card board (Elon's read-only census, cards with a non-empty `## Report`,
n = 487: Linus 303 · Turing 105 · Jobs 76 · Assistant 3):

| slot | Linus | Jobs | Turing |
|---|---|---|---|
| commit hash | 99% | 99% | 98% |
| Acceptance item-by-item | 95% | 92% | 92% |
| evidence pointer | 81% | 84% | 93% |
| conclusion | 88% | 91% | 78% |
| **command + exit code** | 75% | **17%** | 67% |
| not-pushed accounting | 62% | 53% | 38% |
| residuals / risks | 48% | 42% | 55% |
| A/B before-after | 37% | 32% | 46% |
| pending decision | 26% | 36% | 14% |
| **card path** | **19%** | **16%** | **16%** |
| change surface | 29% | 50% | 24% |

Read it as: **the core is already real** (hash / Acceptance table / evidence pointer are
habit), but three families leak systematically.

1. **Card path — the worst slot on every role (16–19%).** The redline asks for
   "conclusion + card path + hash" yet the path is usually dropped. Slot **A2** exists to
   make it un-droppable; `check-report.mjs` warns when A2 carries no card id or hash.
2. **Jobs: command + exit code (17%).** Jobs' Reports describe the design and stop before
   the machine-readable proof. Slot **J5/J4** plus **A5** force the command + exit code.
3. **Turing: conclusion (78%) and pending decision (14%).** Verification reports list
   findings without a verdict or a decision fork. Slots **A1** and **A6** carry them.
4. **All roles: the "soft" slots are unstable** — change surface, residuals, A/B
   comparison, pending decision (14–55%). Their titles vary per Report, so acceptance
   has to guess where to look. The anchor grammar in §0 fixes the handle, not the prose.
5. **The empty-Report accident.** On the night of 2026-10-14, four cards reached
   `in_review` with a **blank `## Report`** — the shape was not the problem, the absence
   was. `check-report.mjs` hard-checks exactly that case (`in_review` ⇒ Report present,
   non-empty, all eight slots); see its header for the trigger surface, the effective
   cutoff, and the exemption switch.

## 5. Effective date and grandfathering

- **Effective from 2026-10-15** (the local day Terry's instruction landed). Cards created
  before the gate's cutover are **grandfathered** — violations are reported as warnings
  and never set the exit code, so the historical board (487 Reports) is not retro-reddened.
- **Terminal cards** (`done` / `canceled` / `failed`) are never checked at all.
- **Only `in_review` is a hard trigger.** Cards still being worked
  (`in_progress` / `blocked` / `todo` / `ready` / `backlog`) are at most a warning.
- Full trigger surface, cutoff and exemption switches: `team/scripts/check-report.mjs`
  header (`PROTOCOL §⑳.1` machine-checkable gate row).
