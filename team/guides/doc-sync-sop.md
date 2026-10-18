# Two-Way Document Sync SOP

> Rule owner: `R-DOCSYNC-1` (owner Elon). This guide is the long-form body.

## 0. Normative clauses (`R-DOCSYNC-1`)

1. **Declare at creation** — a card touching an interface, data structure, architecture, config or convention names the docs+sections to sync, or explicitly declares "no documentation impact" with a rationale; omission is invalid.
2. **Acceptance checks** — Elon's final review adds a documentation-impact determination against the diff; a needed-but-missing sync rejects the card or opens a doc-sync card.
3. **Reverse backfill** — when code leads the docs, the implementer syncs what the card touched after acceptance; cross-card accumulated lag becomes a doc-sync card. Record the result in `memory/YYYY-MM-DD.md`.
4. **Reference convention** — follow `R-ENG-2`; no line-number anchors.
5. **Ownership** — design docs belong to their repo (`R-PROJECT-1`); other projects follow their own repo rules.

## 1. Declare the criterion at creation

If a card touches an interface, data structure, architecture, config or convention change, its Acceptance must include one of:

- the explicit design docs + sections to sync; or
- an explicit **"no documentation impact"** with a rationale (this cannot be omitted).

## 2. Acceptance checks the docs

Elon's final review adds a documentation-impact determination against the diff. If a sync was needed but not done, reject the card or open a doc-sync card.

## 3. Reverse backfill

When code leads the docs, after acceptance passes Elon triggers the reverse update. The implementer syncs what the card already touched; cross-card accumulated lag becomes a doc-sync card. Record the result in `memory/YYYY-MM-DD.md`.

The loop is: requirements → code → docs backfill, so docs never lag behind code.

## 4. Reference convention

Follow `R-ENG-2`: cross-role rules are `R-DOMAIN-N`; guide sections are `<guide>.md §N`; a bare `§N` means the current file. No line-number anchors.

## 5. Ownership

Design docs belong to their repo (for independent dual repos, `R-PROJECT-1`). Other projects follow their own repo rules.
