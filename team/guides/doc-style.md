# Doc Style (`doc-style.md`)

> **Ownership / Maintainer**: **Elon** owns this style and approves exceptions; every role applies it to the docs it authors.
> **Status**: method library (`L2.5`). The **normative clauses** it serves live in `PROTOCOL §6.1` clause 11 (reference notation) and `PROTOCOL §17` (layering, single source of truth); this file **states the formatting convention those clauses imply** and does not restate them.
> **Applies to**: every markdown document under `team/` — `PROTOCOL.md`, `ROLES.md`, `AUTOMATIONS.md`, and `team/guides/**`. It does **not** apply to `README.md` (the repository's outward-facing front page, which has its own audience) or to `roles/*/SOUL.md` (creed, prose by design).
> **Reference convention**: `PROTOCOL §<n> <name>` for L1, `<guide-name> §<n>` for a guide's own sections — never line-number anchors (`PROTOCOL §6.1` clause 11).

---

## 1. Why this file exists

The formatting of these documents was **convention by precedent, written down nowhere** — so it drifted: five different ways of annotating a heading, five different markers for one meaning ("mandatory"), the same kind of content in bullets here and numbered lists there, and change history accumulating in the body. Rules that exist only as precedent cannot be checked, cannot be taught, and cannot survive an editor who has not read every other file.

This file is the **written form of the convention**. It is deliberately short and mechanical: every rule below is something a person or a script can apply without judgement. Where the documents disagreed with each other, this file picks one form and says so.

---

## 2. Headings

1. **Level 2 is the numbered section**: `## N. Title`. Numbering runs `1.`, `2.`, … with a **trailing period**.
2. **Level 3 is a numbered subsection**: `### N.M Title`. Every `###` carries a number — a free-standing `###` is not allowed.
3. **A heading carries the name only.** It must **not** contain a date, a card id, a commit, a codename, or an edit verb (`rewritten`, `revised`, `superseded`), and must not contain a literal placeholder such as `T-<id>`.
4. **A scope qualifier may follow the name** where it is genuinely part of the title's meaning (`## 6. Session Orchestration Discipline (Jobs/Linus/Turing)`). What is forbidden is *provenance*, not parentheticals as such. If in doubt: a reader who did not know the project's history must still understand the heading.
5. **An effective date, if the rule needs one, is stated once in the body** as `> **Effective**: YYYY-MM-DD` on the first line under the heading — never in the heading, never with a card id (`PROTOCOL §17` rule 1 permits a permanent convention to carry an effective date).

## 3. Marker vocabulary

One marker, one meaning, and **nothing is marked unless it is one of these**:

| Marker | Meaning | Where it may appear |
|---|---|---|
| 🚨 | A **mandatory rule** — violating it fails a gate or a review | At most once per rule |
| 📌 | A **mechanism or contract pointer** — "the detail lives here" | On a reference line |
| ⚠️ | A **caveat** — a real trap a reader would otherwise fall into | Inline in the rule it qualifies |
| 🔑 | The **single most load-bearing item** in a section | Sparingly; a section may have none |

- Anything not in the table carries **no marker**. "Mandatory" is 🚨, never also ⚠️ or 📌 or plain bold-with-no-marker.
- Markers are **not decoration**. If removing the marker loses no information, remove it.
- A numbered sub-series that is deliberately its own namespace may use one marker consistently throughout (e.g. a section's addendum series) — consistency inside the series is what matters.

## 4. Container per role

The same role always uses the same container. Nothing here varies by section.

| Role | Container |
|---|---|
| A normative rule | Numbered list: `N. **Name** — rule text.` |
| An anti-pattern list | One bulleted block introduced by `**Anti-patterns (reject on sight)**:` |
| An example or illustration | Nested bullet under the rule it illustrates |
| Key–value or tabular data | Table |
| A cross-reference or method pointer | A `> See:` / `> Method:` line at the end of the section |

- A rule is **never** a bullet in one section and numbered in the next.
- A table cell holds **one clause**. If a cell needs to argue, the argument belongs in a bullet below the table, not inside the cell.
- Tables use a uniform delimiter row: `|---|---|` (three dashes per column).

## 5. Provenance, rationale, and history

1. **No change history in the body.** No `(added <date>)`, `(since <date>)`, `(mandatory since …)`, `(T-… on the provider side)`, `> Takeover note`, `> Origin:`, or "supersedes the old note". A dated one-off record belongs to L5, not to a document (`PROTOCOL §17` rule 1).
2. **No bare card ids or commit shas in prose.** A rule does not need to cite the card that introduced it in order to bind.
3. **An incident story is not a rule.** The rule stands alone; the story of the failure that produced it is L5 material. If a single trailing clause of rationale prevents a specific misreading, that clause may stay — the retelling may not.
4. **Rationale uses one label**: `> **Rationale**: …`, at most one per rule. Not `Purpose:` in one place, `Why:` in another, `Basis:` in a third.
5. **A recorded gap is a clause.** "This is not machine-checked", "to be decided", "unknown" statements are kept — deleting them would claim a guarantee the team does not have.

## 6. References

Numbered references follow `PROTOCOL §6.1` clause 11. Three things this file adds:

1. **The discriminator is the name, not the glyph.** A section reference is always `§` plus an **arabic** number. A **bare** `§5` means **the document you are in**; a reference to any other document **names it** — `PROTOCOL §6.1`, `guides/task-interface.md` §3, `sla-inspection-contract.md` §4. Being L1 buys no exemption: write `PROTOCOL §6.1`, never `§①`.
2. **A citation list may give the name once per backtick span**, separating the rest with `·` or `/`: `PROTOCOL §15 · §1 · §9.1`.
3. **Circled numerals are never references.** They survive only as **inline prose ordinals** (`① collect → ② triage → ③ record`). A circled numeral used for a section is a defect, not a stylistic variant.
4. **An item inside a section is written `§N clause M` or `§N step M`** — never with the subsection form (`§N.M` denotes a real `### N.M` heading, and using it for an item either dangles or collides with an unrelated subsection in another file).

`team/scripts/lint-refs.mjs` (named/bare section refs) and `team/scripts/lint-doc-refs.mjs` (paths, cross-file anchors, section-internal items) enforce this. A dangling reference is a gate failure, not a style remark.

## 7. Separators and structure

1. **One `---` before each `##` heading**, and none inside a section. Not "some sections", not "the long ones" — every one.
2. **A document opens with a title, a header blockquote, and a `---`.** The blockquote carries `**Ownership / Maintainer**`, `**Status**`, `**Applies to**`, and — where the document is a method library — the `**Reference convention**` line.
3. **A guide's H1 names its file**: `# Spawn-Lane SOP (`spawn-lane-sop.md`)`, so that a reader can cite it without guessing the path.

## 8. Line length

1. **No fixed column width is imposed.** A paragraph or bullet is one logical line; do not hard-wrap prose at an arbitrary column, because re-wrapping invalidates every line in the file's history for no semantic gain.
2. **A single line over roughly 1000 characters is split by sentence.** Such a line is not one thought — it is several that were never separated, and it defeats review and `git blame`.

## 9. What is deliberately not uniform

These look like inconsistencies and are not. They must survive a normalisation pass, and removing them is a convention change requiring the owner's explicit sign-off:

1. **Deliberate duplication across role seeds.** The one-line redline quick-reference and the role-shared action skeleton repeated in each `roles/*/AGENTS.md` exist so that a layer still carries its constraints when `PROTOCOL` is never opened. This is the "reference transmission" requirement of `PROTOCOL §17` rule 4, and it is carved out of rule 2's duplication ban by that same clause.
2. **A self-consistent sub-series inside one section** may adopt its own shape — a repeated multi-part template, a dedicated marker namespace — as long as it is consistent *within itself*.

## 10. Related

> `PROTOCOL §6.1` clause 11 (reference notation) · `PROTOCOL §17` (layering and single source of truth) · `team/scripts/lint-doc-refs.mjs` (the gate that enforces the reference half) · `team/scripts/lint-impl-names.mjs` (terminology leakage).
