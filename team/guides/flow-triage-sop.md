# Flow Triage SOP (`flow-triage-sop.md`)

> **Ownership**: **Elon** owns the intake decision and the card `flow` field. This file's `§10.5` is the
> **normative body** delegated by `R-FLOW-1` (`R-LAYER-1` rule 6): the A/B/C routing table, the
> hard boundary, the five-item quality spine and the report set. The sampling arithmetic stays in
> `roles/elon/guides/carding-sop.md` §7.2.
> **Applies to**: every card at intake.

---

## §10.5 Flow Triage A/B/C — Change-Nature Routing + Quality Spine


> Elon judges the flow **at intake** and records it on the card — `flow: A|B|C` (a team-side convention field; the provider schema is unchanged, `R-TERM-1`). A change that turns out to cross the hard boundary below ⇒ **re-route to A on discovery**. Rationale, the three locks and the sampling arithmetic: `roles/elon/guides/carding-sop.md` §7.2.

| Flow | Trigger (criteria) | Chain | Quality gate |
|---|---|---|---|
| **A · feature / design-bearing** | new UI structure or block, new interaction, new or semantically changed copy, product-logic change, design-system / token **definition** change | **Jobs prerequisite contract (`R-PREREQ-1`) → Linus development → Turing independent verification (functional + requirement→implementation conformance matrix) → Jobs design-dimension confirmation → Elon final acceptance audit** | full: block list + assertions + screenshot comparison |
| **B · defect / behaviour fix** | fixing behaviour; restoring consistency with an **already-frozen** design; **produces no new design decision** | **Linus fix → Turing verification (reproduce → pass) + regression → Elon final acceptance audit** | reproduction test + (when UI is touched) the assertion subset |
| **C · UI micro-change / detail** | parameter-level change **inside the frozen design**: spacing, token **value**, alignment, wording of already-decided copy, visual polish; **no new block, no new interaction, no product logic** | **Linus → Elon final acceptance audit** (2 steps) | **machine assertion subset must pass** + sampled independent re-check |

**Hard boundary (any one ⇒ always A, never B/C)**: **new UI structure / adds a visible block / changes interaction behaviour / changes the semantics of product copy / product-logic change / changes a design-token definition** — the enumeration is the closed form of the **flow-A criteria row** of the routing table above, so a change that reads as A there can never be routed as B/C here. When in doubt the card goes A — a longer chain beats a missed design decision.

**Quality spine (5 safeguards — the chain may shrink, the spine may not)**:
1. **Frozen design contract** (Jobs, **once per surface**) — block list (name / id / `data-*` / selector) + assertions + design tokens, landing in `workspace/<task-id>/`; **a UI surface with no machine-checkable contract does not start**; B/C **reuse** the frozen contract and produce no new one.
2. **Delivery gate** (Linus, **mandatory for A/B/C**) — the relevant assertion subset passes and the self-proof (build / exit code / `--json` artifact pointer) is in the Report **before** delivery; red ⇒ **not deliverable** (`R-UI-1` Addendum III).
3. **Independent verification** (Turing) — A = functional **+ requirement-conformance matrix** (block/REQ → evidence); B = reproduce → pass **+ regression**; C = **sampled** (below).
4. **Design-dimension confirmation** (Jobs, **A only**) — **evidence-based**: read Turing's matrix + assertions + screenshot comparison to judge "was it built to the design"; **no re-doing, no re-running**.
5. **Elon report audit + rolling sampled patrol** — the statistical safety net that replaces "Elon re-does the verification himself" (`R-UI-1` reinforcement).

**Report set audited by flow (Elon's final acceptance — a PASS on one report never substitutes for the others, `R-DEFECT-1`)**:

| Flow | Reports Elon must audit |
|---|---|
| **A** | Linus (implementation/self-proof) **+** Turing (independent verification + conformance matrix) **+** Jobs (design / design-dimension confirmation) |
| **B** | Linus **+** Turing |
| **C** | Linus (**+** the sampling verifier's report when this card was sampled) |

**The chain may shrink; the spine may not.** What shrinks is the **Acceptance surface** — flow A carries 3+ items (block list + machine-check assertions + screenshot comparison), B/C carry 2 (the applicable gate + the evidence pointer) — never the evidence requirement.

**Rolling sample (the statistical safety net)**: the sample rate, weekly unit and batch form are in `roles/elon/guides/carding-sop.md` §7.2. A drift found by the sample ⇒ defect ticket, and the finding tightens **the class**, not just the spot (never fix only the single occurrence). The sample is executed by Turing/Jobs; Elon **audits their reports** (he does not run it).

---

## §9.4 Product/UX acceptance trigger (`R-UXACCEPT-1`)

> For a card touching product/UI/UX, after Turing's functional test/regression passes, Elon coordinates Jobs' product acceptance; only then may the original card close.

1. **Trigger**: the card's `project` touches product/UI/UX, or its Acceptance/Background contains UI/UX deliverables (interfaces, prototypes, design drafts, interaction flows).
2. **Timing**: after Turing's functional pass (the card could be set to done but the product side is not yet verified).
3. **Coordination**: Elon creates a card with `review_of=<original>` and dispatches Jobs; workers do not dispatch each other.
4. **Closure**: Jobs reports; no open items ⇒ the original may close; issues ⇒ the defect loop (`R-DEFECT-1`).
5. **Division of labor**: Elon coordinates/cards/dispatches; Jobs certifies UX/UI; Turing owns functional testing; Linus owns implementation.

---

## Related

- `R-FLOW-1` — the rule pointer.
- `R-REVIEW-1` — review participants (dynamic, not a fixed roster).
- `roles/elon/guides/carding-sop.md` §7.2 — rationale, the three locks and the sampling arithmetic.
- `guides/ui-align-sop.md` §9.1 — the UI gate the flow selects.
