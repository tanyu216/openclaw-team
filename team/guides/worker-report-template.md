# Worker Report Standard (common core + Jobs / Linus / Turing)

> **What this is.** The single shape of a worker's delivery Report, so that Elon's
> acceptance audit (`PROTOCOL §9`, redline 11 in the role redline block) has a fixed set
> of slots to look at instead of having to *find* and *guess* them.
> **Who it binds.** Jobs / Linus / Turing (Assistant follows the common core).
> **Where it lands.** The `## Report` section of the task card (L5 evidence layer,
> `PROTOCOL §17`). Message-level reports stay trimmed to conclusion + card path + hash
> (`PROTOCOL §4` reporting discipline) — this guide governs the **card-facing** Report.
> **Language.** English by default (`PROTOCOL §4`); keep code/technical terms in English.
> **Enforcement.** The common core is machine-checked by `team/scripts/check-report.mjs`
> in the `check-all` fast segment (`PROTOCOL §20.1`, `AUTOMATIONS.md §3.5.1/§6`) — slot
> **presence**, plus the two declared-semantic rules of §1: the **A0 report origin**
> (`delivery` | `import`) and the **A4 → A6 coupling** for unmet items. The role-specific
> sections are audited by the role's own review, not mechanically. Payload bounds (§6) are
> the provider's and are **not** re-checked here.
---

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

One slot is **optional**: `A0` (§1) — the report origin. Omitting it means `delivery`
(the deliverer wrote their own Report). Writing it is how a migration / proxy-collected
Report states what it is.

---

## 1. Common core — required for every worker

### A0 (optional) Report origin — who wrote this Report

- **Write** — only when the Report is **not** the deliverer's own: one line with the origin
  token, the **author** and the **source**:
  `- **A0 Report origin** — import; author: elon; source: collected from workspace/T-…/handoff.md after the owning session died.`
  A Report the deliverer wrote themselves may state `- **A0 Report origin** — delivery` (optional).
- **Vocabulary** — one machine-readable token: **`delivery` | `import`**. Chinese
  equivalents are accepted: `交付者本人` = delivery, `代收口` / `迁移` / `补写` / `导入` = import.
  Any other wording is read as **unrecognised** and fails closed (see below).
- **Why acceptance needs it**: `delivery` is the deliverer's own claim and can be used as
  acceptance evidence; `import` says *somebody else* collected it (a migration, or a proxy
  pick-up for a dead session) — it is **not** delivery evidence. TaskPanel's
  `task_reports.origin = delivery | import` draws exactly this line, and the four cards that
  reached `in_review` with a blank Report on 2026-10-14 were of the proxy kind: the evidence
  was not missing so much as **not the deliverer's**.
- **Default**: no `A0` line ⇒ `delivery` (the normal case).
- **Machine consequence** (`in_review` only): an `import` Report must name **both**
  `author` and `source`, and it can **never** clear an `in_review` card on its own — the gate
  reports it as not-delivery-evidence so a proxy Report cannot open the acceptance door. The
  route out is a real Report from the deliverer, or a reviewed register entry (`§5`).
- **Minimal example**: `- **A0 Report origin** — delivery.`

### A1 Conclusion — verdict first

- **Write**: one line saying whether the deliverable is **acceptable** or **not
  acceptable**, and (when not acceptable) why in the same line.
- **Why acceptance needs it**: Elon's audit opens with the verdict; burying it behind
  evidence forces a full read of the Report to learn the answer.
- **Minimal example**: `- **A1 Conclusion** — acceptable; all 8 Acceptance items met, live gate exit 0.`

### A2 Delivery coordinates

- **Write**: the **card path**, the **commit hash**, the **branch / base**, and whether
  it is **pushed**.
- **Commit hash rule** — what counts as a commit reference: a **7–40 character lowercase
  hex** sha (git's own shape, `^[0-9a-f]{7,40}$`), or a 40-character uppercase sha-1 (some
  tooling prints shas in uppercase; that is a real sha, not a violation). If the card
  genuinely has **no commit** — a read-only / docs-only leg, or work that never landed —
  say so **explicitly**: `commit: none` (also accepted: `no commit`, `commit: —`,
  `无提交`, `未提交`). Anything else is *not* a commit reference: the word "commit" with no
  value, a branch name, or a 6-hex abbreviation. The gate raises an A2 hint when neither
  form is present (§5); stating a bare `commit:` no longer satisfies it.
- **If the card has been sent back** (its frontmatter carries a `blocked_at`, i.e. this is
  round ≥ 2): also state the **delivery time / round** of *this* round. Nothing on the card
  face records *when* the Report was written, so without it acceptance cannot tell a fresh
  Report from the previous round's reused one, and the gate can only raise an advisory hint
  (`§5`).
- **Why acceptance needs it**: without the card path the auditor cannot tell *which*
  card the Report belongs to; without the hash the claim is not reproducible.
  (Historically the weakest slot of the whole core — §4 states the criterion that makes that
  true, and why no rate is quoted.)
- **Minimal example**:
  `- **A2 Delivery coordinates** — card: tasks/T-20261015-010749-2.md · commit: a1b2c3d · branch: T-20261015-010749-2 (base 1c54cec) · pushed: no (see A8).`

### A3 Change surface

- **Write**: file count touched, whether the change is **zero-implementation**
  (docs / read-only / registration only), and whether anything went **out of bounds**.
- **Why acceptance needs it**: acceptance has to know whether to audit behavior or only
  text, and whether a boundary was crossed that needs a fresh decision.
- **Minimal example**: `- **A3 Change surface** — 7 files (2 new guides/scripts, 1 new test, 4 wired docs); no implementation change; no out-of-bounds edits.`

### A4 Acceptance item-by-item

- **Write**: a table mapping **every** Acceptance item on the card to the evidence that
  discharges it, each with a **status from the fixed vocabulary** — the same four values
  the provider's `ACCEPTANCE_STATUSES` uses:
  **`met | partial | not_met | not_applicable`** — no other words (`done`, `ok`, `yes`,
  emoji are not statuses).
- **`not_applicable`** means *this Acceptance item does not apply to this card* — the card
  was narrowed, or the item is another leg's. It is **not** an unmet item: it needs no A6
  entry and never makes the Report incomplete. Reach for it instead of writing a false
  `met`; the provider draws the same line, so a `not_applicable` row survives a round trip
  through TaskPanel unchanged.
- **Coupling rule**: a row that is **`partial`** or **`not_met`** must **also** appear in
  **A6**, with its owner. `partial`/`not_met` in A4 with no matching A6 entry means the
  item was quietly dropped — and an unmet row next to an A6 that **declares no residuals**
  (`none`, `nothing outstanding`, `无`, `n/a`) is a contradiction the gate flags as a hint.
  The gate matches **row by row**: if A6 already accounts for that item — its ordinal
  (`③`) or its item name — there is **no** hint, which is why a qualifier such as
  "none *critical*" in A6 is not read as a claim of no residuals. **`not_applicable` rows
  are outside this rule entirely.** Unfinished work is declared, never hidden.
- **Why acceptance needs it**: this is the spine of the audit; a missing row is an
  unauditable Acceptance item, and an unmet item with no A6 entry is an unowned gap.
- **Minimal example**:

  ```
  - **A4 Acceptance item-by-item**
    | # | item | status | evidence |
    |---|---|---|---|
    | ① | guide with common core | met | team/guides/worker-report-template.md §1 |
    | ② | machine check | met | team/scripts/check-report.mjs + tests |
    | ③ | A/B before-after table | partial | no pre-fix reading taken → A6 #2 |
  ```

### A5 Re-run evidence

- **Write**: the **command**, its **exit code**, and a **pointer to the artifact**
  (report file, log path, JSON envelope). "Tests pass" alone is not evidence.
- **Why acceptance needs it**: exit codes and artifacts are what make the claim
  independent of the author's summary. Jobs is the role that historically drops this slot
  hardest (§4 — no rate quoted there, and why).
- **Minimal example**: `- **A5 Re-run evidence** — cmd: node --test scripts/tests/check-report.test.mjs · exit: 0 · artifact: workspace/T-…/test-output.txt`

### A6 Residuals / risks / open items + owner

- **Write**: what is left undone, what could bite later, what is still undecided — each
  with a named **owner** for the follow-up. Every A4 row that is **`partial` or `not_met`**
  belongs here; a `not_applicable` row does not (it is not residual work — the §1 A4
  coupling rule).
- **Why acceptance needs it**: an unowned residual is a silent gap; acceptance must be
  able to route it. "None" is a valid answer **only when every A4 row is `met` or
  `not_applicable`** — and it has to be an actual claim that there are no residuals:
  `none` / `nothing outstanding` / `无` qualify; `none critical` does not (residuals exist,
  they are just not severe — say *that*, and name them).
- **Minimal example**: `- **A6 Residuals** — the roles AGENTS.md leg cannot be deployed from a lane (outside its roots) → owner: integration leg / Elon.`

### A7 Out-of-literal handling

- **Write**: each place the work went beyond (or chose between) the card's letter —
  itemized, with **whether it is revertible**.
- **Why acceptance needs it**: `PROTOCOL §11` requires out-of-bounds handling to be
  visible; acceptance needs to distinguish "authorized extension" from "silent drift".
- **Minimal example**: `- **A7 Out-of-literal handling** — extended the gate to warn on content hints (blocking scope unchanged); revertible: yes (delete the hints table).`

### A8 Not-pushed accounting

- **Write**: if anything is not pushed, say so explicitly, name the branch/worktree, and
  state that the worktree can be reclaimed.
- **Why acceptance needs it**: unpushed work is invisible to everyone else; the
  integration leg needs to know exactly what to fetch and whether it is safe to delete.
- **Minimal example**: `- **A8 Not pushed** — no push; branch <card-id> @ a1b2c3d; worktree clean, reclaimable after merge.`

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
  (`prototype/**` must not contain implementation, `PROTOCOL §9.2`): the path set
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
  (`PROTOCOL §6.1` clause 13). A requirement with no assertion is a gap, not a pass.
- **T6 Defect grading** — per defect: severity, reproduction steps, expected vs actual,
  suspected owner, evidence path.
- **T7 Explicit "not fixed, report only"** — state plainly that verification fixes
  nothing and the defect fix card is created by Elon (`PROTOCOL §9`).

---

## 3. Skeleton — fill this in and it IS a legal Report

The block below **passes `check-report.mjs` as written** (that is asserted by the suite: the
fence is extracted and fed to the gate). Copy it into the card's `## Report` section and
replace every value with yours. Three rules for filling it in:

1. **Defaults are `not_met`.** Copy the rows out of the card's own `## Acceptance` list —
   never write them from memory — and a row stays `not_met` until you hold the evidence that
   upgrades it. `not_met` is a legal, honest status; an invented `met` is not.
2. **Evidence: explicit first, never invented.** Prefer a path / command / exit code / hash
   you actually produced over a sentence about it; if you have nothing, the row's evidence is
   "none yet → A6", not a plausible-looking pointer.
3. **Every `partial`/`not_met` row reappears in A6** with an owner (§1 A4 coupling rule).
   `not_applicable` rows do **not** — they are not unmet work.

```markdown
## Report

- **A0 Report origin** — delivery.
- **A1 Conclusion** — acceptable; all Acceptance items met, live gate exit 0.
- **A2 Delivery coordinates** — card: tasks/T-20261015-010749-2.md · commit: a1b2c3d ·
  branch: T-20261015-010749-2 (base 1c54cec) · pushed: no (A8).
- **A3 Change surface** — 6 files; 1 new script + 1 new test + 1 new guide + 3 wired docs;
  no implementation; no out-of-bounds.
- **A4 Acceptance item-by-item**
  | # | item | status | evidence |
  |---|---|---|---|
  | ① | guide with the common core | met | guides/worker-report-template.md §1 |
  | ② | machine check + tests | met | scripts/check-report.mjs + scripts/tests/check-report.test.mjs |
  | ③ | A/B before-after table | partial | no pre-fix reading was taken → A6 #1 |
  | ④ | <an item this card narrows away> | not_applicable | out of scope here → owner: whoever owns it |
- **A5 Re-run evidence** — cmd: node --test scripts/tests/check-report.test.mjs · exit: 0 ·
  artifact: workspace/<id>/test-output.txt
- **A6 Residuals** — ③ A/B table carries no before-reading (`partial`) → owner: integration
  leg; and: <item> → owner <role>.
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

When the Report is **not** yours to write (§1 A0) the first line becomes
`- **A0 Report origin** — import; author: <who>; source: <from where>` — and the card stays
un-acceptable as delivery evidence until the deliverer's own Report exists.

---

## 4. Common gaps (what actually goes missing)

> **Relative conclusions only — absolute numbers are not evidence.** This section names
> **which families leak and where**, not how often. The census that once stood here (a
> published `n = 487` hit-rate table) was **withdrawn**: no script, no **as-of**, no stated
> criterion (defect **D6**; evidence  §T6) — the population is live and
> mostly terminal (the surface `check-report.mjs` **never inspects**), and the criterion is a
> parameter that flips one family's conclusion (under `--card-path=path` the card path is
> among the weakest on every role; under `--card-path=id` among the strongest). **Quote a rate
> only together with its command and its as-of**; the census is now
> **`team/scripts/report-census.mjs`** — read-only, every axis parameterised, `params` / `asOf`
> echoed in the `--json` envelope, and `--compare` re-prints the old table with a per-family
> verdict (`equal` / `near` / `diverged`).

Read it as: **the core anchors are real** (commit hash / evidence pointer / conclusion are
habit on every role), but these families leak systematically:

1. **Card path** — the redline asks for it yet it is usually dropped; slot **A2** makes it
   un-droppable (`check-report.mjs` warns when A2 carries no card id or hash). The claim is
   criterion-bound: it holds when you require the `path` form and reverses when a bare card id
   is accepted.
2. **Jobs: command + exit code** — Jobs' Reports describe the design and stop before the
   machine-readable proof (the sharpest per-role contrast: the slot Linus/Turing carry in most
   of their Reports, Jobs carries in a small minority). Slots **J5/J4** + **A5** force it.
3. **Turing: the leak band is lowest here** — verification reports list findings without a
   verdict or a decision fork; Turing is weakest on pending decision, change surface,
   not-pushed accounting and residuals (and, under the shape criterion, A/B before-after).
   Slots **A1**, **A6** and the role slots carry them.
4. **All roles: the "soft" slots are unstable** — change surface, residuals, A/B comparison,
   pending decision (their titles vary, so acceptance guesses where to look; the §0 anchor
   grammar fixes the handle, not the prose).
5. **The empty-Report accident** — four cards reached `in_review` with a **blank `## Report`**
   on 2026-10-14: the absence, not the shape, was the problem. `check-report.mjs` hard-checks
   exactly that (`in_review` ⇒ Report present, non-empty, all eight slots; §5).
6. **The proxy Report — the sharper half of that accident** — a Report written by **someone
   other than the deliverer** carries no delivery evidence yet *looks* complete (all eight
   slots filled, nothing to accept); hence the origin slot (`§1 A0`), and `import` never clears
   an `in_review` card on its own. **A0 is the one slot where saying nothing is the normal
   case** — which makes the undeclared proxy Report the residual risk (§1 A0, §5).
7. **The reused Report — the round gap** — a sent-back card's previous round can stay on the
   card and satisfy every slot; there is no write-timestamp on a `## Report` section, so the
   only counter is A2's delivery time/round declaration for sent-back cards (a hint, not a
   block; §5).
---

## 5. Effective date, grandfathering and the gate surface

- **Effective from 2026-10-15** (the local day Terry's instruction landed). Cards created
  before the gate's cutover are **grandfathered** — violations are reported as warnings
  and never set the exit code, so the historical board is not retro-reddened.
- **Terminal cards** (`done` / `canceled` / `failed`) are never checked at all.
- **Only `in_review` is a hard trigger.** Cards still being worked
  (`in_progress` / `blocked` / `todo` / `ready` / `backlog`) are at most a warning.

What `check-report.mjs` actually decides (this section and the script header are the
contract; `PROTOCOL §20.1` carries the registry row):

| surface | rule | effect |
|---|---|---|
| slots `A1…A8` | label present **and** carrying text (§0/§1) | `in_review` + past cutoff ⇒ **violation** |
| empty / missing `## Report` | the 2026-10-14 accident shape (§4 #5) | violation (same class) |
| origin `A0` | no line ⇒ `delivery`; `import` without `author:`+`source:` ⇒ violation; `import` **at all** ⇒ not-delivery-evidence violation (§1 A0) | violation; `import` is cleared only by a real Report or a register entry |
| origin `A0` unreadable | a present `A0` whose token is neither `delivery` nor `import` | violation (fails closed — an unreadable provenance claim must not open the door) |
| A4 → A6 coupling | an **unmet** row (`partial`/`not_met` — `not_applicable` is exempt) that A6 does not account for, while A6 **declares no residuals** | **hint only** (non-blocking; matched row by row and qualifier-aware, so "none *critical*" is not a claim) |
| round (sent-back card) | `blocked_at` set and `status_changed_at` later, Report declares no delivery time/round | **hint only** (non-blocking) |
| A2 card path / commit, A5 exit code | content shape — a commit is 7–40 **lowercase** hex (or a 40-char uppercase sha-1), or an explicit no-commit declaration | **hint only** (non-blocking) |
| exemption register entry | `{id, gaps}` matching the card's *current* gaps but with **no `reason`** of ≥8 characters | **does not exempt** — the card is still a violation, and the entry is named on stderr for repair |
| payload bounds (§6) | ≤64 items per list · ≤64 KiB · `truncated` | **not checked** — bounded upstream at write time, and checking it here would duplicate a rule that cannot fire on a well-formed card (§6) |
| role slots `L*` / `J*` / `T*` | — | never machine-checked (§2) |

- **Grandfathering wins over every new rule**: a pre-cutoff card is reported at most as a
  warning, so none of the rules above retro-redden history. The hint rows are computed
  **only** for cards past the cutoff, so historical cards are not nagged either.
- **Escapes**: `OPENCLAW_TEAM_REPORT_EFFECTIVE_AT` moves the cutoff; the register
  (`scripts/report-baseline.json` ∪ `<tasks>/.report-baseline.json`) exempts a card whose
  **current** gap set matches exactly (so an exemption cannot hide a *new* gap) **and whose
  entry carries a `reason`** of ≥8 characters (see the `exemption register entry` row above);
  `--no-baseline` ignores both sources for a true-violation reading.
- **The register needs a reason.** An entry exempts only if it carries `{id, gaps, reason}`
  with a `reason` of **≥8 characters** after trimming. The reason is not ceremony: `gaps`
  proves only that the gap *set* did not change; it cannot say *why this gap is benign* —
  and that judgement is the entire legitimacy of an exemption. A structurally matching entry
  with a missing or too-short reason **does not exempt**: the card is still reported as a
  violation, and the entry is named on stderr (`invalid-exempt …`) so it can be repaired.
- **Known limit of the origin rule**: the gate reads what the card **declares**. A proxy
  Report that simply omits `A0` is indistinguishable from a delivered one; closing that needs
  the provider ACL to stamp `origin` at write time (`skills/task-ops/lib/task.mjs#writeReport`)
  — a base-side change, tracked as a residual on not enforced here.
- Full trigger surface, cutoff and exemption switches: `team/scripts/check-report.mjs` header
  (`PROTOCOL §20.1` machine-checkable gate row).

---

## 6. Bounds — the payload limits a Report inherits

The provider bounds every Report payload it stores: **at most 64 items per list**, **at
most 64 KiB per payload**, with anything over the bound marked **`truncated`** rather than
silently dropped. Those are the provider's numbers (`boundEvidence` in the TaskPanel report
layer; taken here from defect ticket  §T6 **D4** — that layer is not
read first-hand from this side of the boundary, so treat the exact constants as the
provider's, not this guide's). This standard **inherits** them, because a Report that
exceeds the bound reaches the auditor already cut.

In practice:

- Keep each list — the A4 table, the A6 residual list — under **64 items**. If a card's
  Acceptance genuinely has more, group them instead of truncating.
- Keep the whole `## Report` under **64 KiB**. Near the limit, the bulk belongs in
  `workspace/<id>/` (the artifact A5 points at), not on the card face.
- A `truncated` marker on a stored Report is a **defect to report**, not a normal state.

**The gate does not validate size or item counts — deliberately.** The bound is enforced
**upstream, at write time**, so the card face the gate reads is already the post-bound
artifact (a size check here cannot fire on a well-formed card); `check-report.mjs` is a
**read-only slot-presence check** by design (§0, §5), and a second, weaker copy of a provider
rule would blur which layer owns the bound — worse, a size limit at this layer would red on
exactly what the bound exists to protect, **legitimately long Reports** (the framework has
already refused one such Report for size, the report-volume guard misfiring on a 9.7×
legitimate write §T6 **D8**).
