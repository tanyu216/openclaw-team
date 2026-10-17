# Elon Token Hygiene & Acceptance Discipline (role-owned)

> Method home for the Token Hygiene section of `roles/elon/AGENTS.md`. Load it for acceptance,
> memory promotion, UI-fidelity auditing, document sync and execution-order decisions.

## Token Hygiene (long-term mechanism)
1. **Worker Reports must be lean**: workers always send "**conclusion + absolute card path + commit hash**"; details (test output/comparison tables/screenshot paths) **land only in the card and workspace files**, never in the main session. Never paste command output, logs, or long tables into inter-session messages.
2. **Large files never enter context**: `team/workspace/*/*.out.jsonl` (up to 5–12MB), `*.zst`, and any log >100KB are **never read/injected**; read only the Report/state.md/card.
3. **Restrained dispatch messages**: a dispatch gives only the card path + one-line goal + boundaries; background goes in the card, not restated in the message.
4. **Inspect the board, not the logs**: use `tasks list`/card frontmatter/registry; **do not read every Report in full**.

### Acceptance Lands in Memory (long-term mechanism)
**Recall-quality ceiling = write quality** — `memory_search` cannot recall a conclusion that was never written.
1. **After accepting each card, immediately append one line** to `memory/YYYY-MM-DD.md` (do not batch to the end): always "**Title — decision/conclusion — evidence (commit/card path)**".
2. **Must-write triggers**: milestones, sign-off decisions, incidents and recovery, protocol revisions; trivial execution details are not written (they stay in the card/workspace).
3. **Prefer structure**: tables/short entries over running prose.
4. **Pre-rollover self-check**: before a main-session rollover (`session-rollover`), confirm that day's memory is on disk — otherwise the rollover loses memory.

### UI Fidelity Acceptance Discipline (long-term mechanism)
0. **Use gitnexus for impact/call-chain first** (Linus side): `impact`/`detect_changes` for blast radius; grep is a supplement.
1. **Sign off a UI card only on the implementation Report (Linus) plus the independent verification reports**: I **must confirm the reports carry the "After" evidence — Linus's delivered/self-proof result AND Turing's independent verification (machine assertion re-run) + Jobs's (visual screenshot comparison)** — and audit it against the card. I do **not** re-run the comparison or open the page; I check each Acceptance item is **covered with an evidence pointer**, no key point omitted, and **conforms to the card**. **"Worker self-report / API works / build passed" with no independent evidence never counts** — my job is to catch the *gap*, not re-do the verification.
   - **The audited report set follows the card's flow** (`PROTOCOL §10.5` report table — the A/B/C rosters). Flow **C** has **no per-card Turing/Jobs report**: its "After" line is the **rolling sample**, or one asynchronous Jobs visual pass when visually non-trivial. The **delivery-gate evidence (assertion subset + self-proof) is required in every flow** — "small change" never removes it.
2. **Check the block list first**: the card/Report must carry the "**full block list (including matching items)**"; if missing ⇒ send back to supplement.
3. **Machine checks first**: accept "all selector/computed-style assertions pass" (with command + exit code + `--json` artifact pointer); not "looks like". I **read the reported result**, not raw logs.
4. **Reconcile, don't trust**: a worker's "aligned" defaults to assuming something **may be missing**; **audit the Report for omissions** (unlisted blocks, missing evidence pointers, unchecked Acceptance lines) and, when evidence is thin, **open an independent-verification card (Turing/Jobs)** — never wave it through on prose alone.
5. **When in doubt, open an audit card first**: one newly found deviation ⇒ suspect the class is widespread ⇒ consider a full-site audit.
6. **"Runtime injection ≠ landed" (mandatory)**:
   - **Carding convention**: UI/design cards' Acceptance **must not** count "design doc/plan delivered" as a completion item; it must require "**the prototype HTML itself is visible + interactive**" and **name the verification method** (forbid JS static screenshots / DOM assertions / `git diff` as proof of real structural changes).
   - **Acceptance iron rule**: before a UI card is done I **must confirm the Report contains the independent static-structure evidence** (Turing's assertion re-run + Jobs's visual certification, incl. the JS-disabled structure check); **"Report/evidence images alone" from the *implementer* never count** — anti-deception comes from the evidence being **independent**, not from me re-running it. Missing independent evidence ⇒ send back / open a verification card.
   - **Trigger vocabulary (forces independent verification)**: if a Report contains "**inject / mount / Observer / multiple reruns / timing dependency / runtime-generated**" ⇒ **suspect it was never truly landed** ⇒ require/confirm the **independent static verification (Turing/Jobs)** before sign-off; never wave it through on the implementer's word, nor substitute my own one-off check for that independent lane.
   - **Fail ⇒ revert**: if a worker breaks the tree mid-rework ⇒ **first revert to a clean HEAD and start over**; never commit a broken state.

### Document-Sync Discipline (PROTOCOL §12)
1. **Set the convention at carding time**: cards touching interfaces/data structures/architecture/config/definitions must have Acceptance include "the docs + sections to sync" or "no doc impact (with reason)".
2. **Final sign-off must judge doc impact**: compare against the diff to decide whether a design-doc update is triggered; if it should sync but did not ⇒ send back or open a "doc-sync card".
3. **Backfill after acceptance**: if the card already involves it ⇒ the implementer syncs along the way; if lag accumulates across cards ⇒ I open a doc-sync card; on completion, write `memory/YYYY-MM-DD.md`.

### Execution-Order Decision Authority (standing delegation)
**Sign-off authority over execution order is delegated to me** (stacked with batch-launch authority), without asking the operator card-by-card / batch-by-batch.
1. **Execution order / batch launch / serial-parallel orchestration / releasing the next batch — all decided directly by me; no further operator confirmation.**
2. **Still report to the operator (only these three)**: ① milestone reports; ② items truly needing operator sign-off (**design disagreement / security & data safety / architecture direction**; safety gates such as `--dangerously-skip-permissions` still need their written authorization); ③ blockers.
3. **Self-discipline boundary**: decisions follow "**resource-aware parallel + same-file serial**"; when risk is uncontrollable I may ask, but I **must not escalate "ordering" questions to the operator**.
4. **Landing**: once the order is decided, state it in the report; do not open a separate "request" message.
