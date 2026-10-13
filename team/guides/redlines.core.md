# Redline Quick-Reference (canonical, single source of truth)

> Maintainer: Elon. The team tool injects the marked block below into each `workspace-<role>/AGENTS.md` and validates consistency.
> **Do not hand-edit the blocks in each AGENTS file** (edit here → rerun the sync).

<!-- BEGIN REDLINES:v1 (generated from team/guides/redlines.core.md — do not hand-edit) -->
> 🚨 **Redline quick-reference (in-person every turn; details in `PROTOCOL §①/§④/§⑥/§⑨/§⑬`)**
> 1. **Claim**: always via the task-system contract `task.claim` (**ACL: `task-ops`**); `in_progress` + fresh heartbeat ⇒ do not re-claim, do not re-execute (execution uniqueness).
> 2. **Heartbeat/closing**: refresh the heartbeat every ≤10min while executing; the three end-of-segment items = refresh heartbeat → set terminal state (`in_review`/`done`/`failed`/`blocked`) → send back an Elon Report (conclusion + card path + hash).
> 3. **Process trail**: collaborative discussion / user decisions / confirmations (dual-sign) / **task changes** use `task.comment` (`kind ∈ discuss|decision|confirm|change|note|defect`; mark human decisions `author=operator`; **task changes use `kind=change`, recording what/why**).
> 4. **Report trimming**: give only conclusion + card path + hash; logs/long tables/large files do not enter messages or context.
> 5. **State machine**: `ready→in_progress→in_review→done|failed` (`blocked` can be entered/left from any state).
> 6. **Messages**: only Elon faces humans; workers do not dispatch to each other; idle means no reports.
> 7. **Tool redlines**: writing code goes through Claude Code; testing through codex; `prototype/**` must not contain implementation; no destructive git; commit with `git commit -- <explicit path>`.
> 8. **Ambiguity**: set `blocked` and send back to Elon for clarification; do not speculate.
> 9. **Relations (parent/child/dependencies) only via the task-system ACL**: `task.spawn/depend/…` (auto-rejects cycles/self-reference/dependency on ancestors/deep trees/over-long chains); `kind:epic` is not claimable; `deps_unmet` is not claimed.
> 10. **UI/UX fidelity to the Jobs prototype**: a dev task sourced from Jobs must reproduce the prototype's page structure / styles / **interactions as-is** — no unilateral UI/UX change (add/remove/move/restyle a block, change visible copy, change what a control does). If the prototype **omits** a case you may supplement it minimally, but you **must record it** (`task.comment kind=change|note`, what+why) and surface it to Elon/Jobs; a **contradiction** (not an omission) needs **Elon's approval** before you implement (see `PROTOCOL §⑨.1` Addendum II).
> 11. **Elon's acceptance = report audit**: accept by auditing the worker Report(s) — check **every Acceptance item is covered with an evidence pointer, no key point is omitted, and it conforms to the card**; independent verification evidence is produced by the workers (Turing functional/requirement-conformance for flows A/B and the sample for C, Jobs visual/design, Linus build/test self-proof). **Elon does not re-run the checks himself**; a missing key point ⇒ send back / open an independent-verification card (see `PROTOCOL §⑨/§⑨.1`).
> 12. **No UI change bypasses the delivery gate**: every UI change — flow A/B/C alike (`PROTOCOL §⑩.5`) — must run its **relevant assertion subset** and carry the result (command + exit code) in the Report **before** delivery; a red assertion ⇒ **not deliverable**. A micro-change / the short chain shortens the **chain**, never the gate (`PROTOCOL §⑨.1` Addendum III).
<!-- END REDLINES:v1 -->
