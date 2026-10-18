# Cross-Segment Continuity SOP (`seg-continuity-sop.md`)

> Method home for `R-SEG-1`. `R-SEG-1` states the contract (carriers, read/write
> obligations, overturn declaration); this guide carries the template and the operational detail.
> It references `R-SEG-1` and never redefines it.

## 1. Why the contract exists

Session memory is not shared between segments. Aligning by scattered files by hand causes context
loss, decision drift and inconsistent conventions. A single mandatory contract file keeps the
benefits of segment isolation while guaranteeing cross-segment consistency.

**Segment isolation is session/context isolation, not git isolation.** All segments of one card share
the same card branch `<card-id>` and the same worktree; the `seg` key remains the session/registration
identity (`## Sessions` upsert key, deterministic session id, log name), never a branch name.

## 2. Carriers (two layers; decisions/conventions do not enter the task card, milestones do)

- **Task card `## Progress`**: records segment-level **milestones/results** ("Segment N complete,
  pytest X passed, artifact Y"), append-only, each line timestamped (for Elon to see progress).
- **`~/.openclaw/team/workspace/<task-id>/state.md`**: records segment-level
  **decisions/conventions/agreements/leftovers** (so the next segment stays consistent),
  **always appended, never truncated**.

## 3. Segment completion snapshot

At the end of each segment, `state.md` appends a section with at least:

```markdown
## Segment N (segN) completion snapshot · <timestamp>
- Segment goal / implemented artifacts
- Key decisions (with rationale + constraints on subsequent segments)
- Conventions/calibration (naming/fields/constants/interface signatures)
- Pitfalls found / leftovers / expected input for the next segment
```

## 4. Read/write obligations

- **End of segment = must write a `state.md` snapshot**, otherwise the segment does not count as
  completed.
- **Start of segment = must first read `state.md` and inject it into the segment's prompt**
  (making the previous segment's decisions/constraints/conventions explicit context), otherwise do
  not spawn. The background pack for a newly started seg is the one defined in `R-SESSION-1`
  clause 8 (card Goal/Acceptance/Background + `## Report` + `## Comments` + `state.md`).
- **Overturning a previous segment's decision must be declared explicitly** ("overturning
  segment N's decision X, for reason Y"); silent drift is not allowed.
- **A segment resumed after an interactive escalation must read the pending question artifacts**
  (`workspace/<task-id>/questions/*.json`) together with the operator/Elon answer on the card.
  The artifact is the machine-readable question; the card comment is the decision. Do not guess
  an answer that is not on the card (`guides/interactive-lane-sop.md` §7–§8).

## 5. Consistency check

For cross-segment interfaces/conventions that have verifiable agreements (field names / constants /
signatures), add **contract assertions** in tests. Inconsistency = test failure, never a silent
drift. Do this from the first version.

## 6. Scope

Limited to **segments within the same worker** (e.g. Linus's seg1 → seg2). Cross-worker handoff still
goes through the task card + Report.
