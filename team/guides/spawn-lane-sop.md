# Spawn-Lane SOP (`spawn-lane-sop.md`)

> **Ownership / Maintainer**: **Linus** (engineering) owns the entry and this SOP; **Elon** owns the L1 normative clause in `PROTOCOL §⑥` and approves exceptions.
> **Status**: method library (`L2.5`). The **normative clause** lives in `PROTOCOL §⑥` (session orchestration); this file **references** it and does not copy its text (`PROTOCOL §⑰`).
> **Depends on**: `PROTOCOL §① board` · `PROTOCOL §⑥ session orchestration` · `guides/task-interface.md` · `guides/incident-response-sop.md`.
> **Applies to**: **every newly started lane** (a `claude -p` or `codex exec` sub-session) for Linus / Jobs / Turing.
> **Reference convention**: always write `PROTOCOL §<n> <name>` or `<guide-name> §<section>` — never line-number anchors, never card-number anchors (`PROTOCOL §⑰`).

---

## 1. Rule: one entry, no direct launch

- **The only legitimate way to start a lane is the single entry**:
  ```bash
  bash ~/.openclaw/team/scripts/spawn-lane.sh <card> <owner> [seg=seg1] [backend=claude|codex] [phase=<p>] [role=exec|review] [--review] [--dry-run]
  ```
  The thin wrapper `scripts/spawn-lane.sh` execs the core `scripts/spawn-lane.mjs`.
  `role=exec` (default) starts an execution lane; `role=review` (`--review` is equivalent) starts a **review lane** (§9).
- **Forbidden**: running `claude -p …` / `codex exec …` **directly** and registering (or not registering) by hand. A lane started that way bypasses the ACL and reproduces the two failure modes in §2.
- A lane **must not** be started outside the entry even when it "seems simpler" — the entry only adds one command's worth of friction and removes two classes of board-wide breakage.

## 2. Why (two field-verified failure modes)

Both were observed on 2026-10-10 (`check-all` red) on lanes started by a direct `claude -p` — the card claim was fine, but the session was never registered through the ACL.

1. **`registry_only`** — the team-level registry (`claude-sessions.json`) held a **`running`** entry whose **pid was alive**, while the card's `## Sessions` section was **empty**. The gate `check-sessions` treats "active on one side, missing on the other" as a **hard failure**, so `check-all` went red. Root cause: registration wrote only the registry, never the card (the ACL writes both in one step).
2. **Non-canonical handoff** — `workspace/<task-id>/handoff.md` was **hand-written**, missing the four anchors (`HANDOFF:v1` / `## 任务卡` / `## 上段结论` / `## 讨论/决策` / `state.md`). Once a seg was registered, `check-handoff` failed; the file is what the next segment is supposed to read first, so a non-canonical one silently breaks cross-segment consistency (`PROTOCOL §⑥.0`).

⇒ The entry makes both **impossible by construction**, and the gates catch any lane that still bypasses it.

## 3. Sequence (what the entry does, in order)

```
claim → handoff self-check → resolve cwd/session-id → spawn → session-set (card + registry, one step)
```

1. **claim** — parse the card through the ACL, then dispatch on `role`:
   - `role=exec` (default): assert `status=in_progress && claimed_by=<owner>`; if the card is `ready`/`todo`, the entry claims it first. A card that is `in_review`/`done`/`failed`, or claimed by someone else, is refused. `in_review` is refused with an actionable hint — `status_not_spawnable(in_review):use_role=review` (a review lane is what you want: §9).
   - `role=review`: accept **only** `status=in_review` (otherwise `review_needs_in_review(status=…)`); **never claims and never asserts `claimed_by`** — the reviewer is not the implementer (§9).
2. **concurrency cap** — refuse when `running(owner) >= 8` (linus/jobs) or `>= 3` (turing) (`PROTOCOL §⑥` clause 2). Counting uses live pids, so a dead-pid zombie row does not consume a slot (that is reconcile's job).
3. **cwd** — resolved from the card's `project` through the ACL (`__team__` ⇒ the team root), then overlaid with `target`; business code is never spawned inside the task workspace (`PROTOCOL §⑥`).
4. **handoff self-check (key gate)** — ensure `workspace/<task-id>/` exists; if `handoff.md` is missing, generate it with the ACL handoff command (**never overwrite** an existing one); if it **exists but misses any of the four anchors, refuse to start** (exit ≠ 0, naming the missing anchor).
5. **workspace settings preset (idempotent)** — ensure `workspace/<task-id>/.claude/settings.json` exists (it is the target of `--settings` in step 7); **never overwrite** an existing one (§10).
6. **session id** — deterministic UUIDv5 via the ACL (`<card> <owner> <seg>`) ⇒ predictable and resumable by id on every host — claude `--resume <id>`, codex `codex exec resume <id>`, pi `pi --print --resume <id>` (`PROTOCOL §⑥` clause 8; basis `T-20261011-231103`).
7. **spawn** — `claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits --settings <ws>/.claude/settings.json --add-dir <ws> --add-dir <team> --session-id <uuid> --name <owner>-<seg>`, started as a **new session detached from the parent process group** (see §5), `stdin`=DEVNULL, stdout → `workspace/<task-id>/<owner>-<n>.out.jsonl`, stderr → `<owner>-<n>.err.log`, cwd = project root.
8. **session-set (immediately after spawn)** — one ACL call writes **both** the card's `## Sessions` row (seg/owner/backend/id/phase/status/**pid**) **and** the team registry. Registration is never two half-writes.

`--dry-run` performs the full validation chain and prints the planned command line, but **starts no process and writes nothing** (no registry, no card, no handoff, no settings).

## 4. How to run

```bash
# Rehearse (validate + print the command; zero side effects)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 linus --dry-run

# Start a lane (defaults: seg=seg1, backend=claude)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 linus
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 jobs seg=seg2 phase=seg2-ui
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 turing backend=codex

# Review lane on an in_review card (defaults: seg=segR1, backend=codex)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 turing --review backend=codex
```

- The **last stdout line is JSON** `{ok, role, settings, session_id, pid, cwd, handoff, log, cmd, …}` for machine reading.
- Exit codes: **0** started (or dry-run OK) · **1** refused (validation/handoff/claim/cap) · **2** usage error.
- Refusal reasons are stable and greppable, e.g. `claimed_by_mismatch(…)`, `concurrency_cap(owner=…,running=…,cap=…)`, `handoff_anchor_missing:…`, `status_not_spawnable(…)`.
- After starting a lane you **still own polling it to terminal state** (`PROTOCOL §⑥` clause 4); the entry does not take over polling.

## 5. Detach discipline (macOS)

The entry starts the child as a **new session detached from the parent process group** — in Node that is `spawn(bin, args, { detached: true })` + `unref()`, the portable equivalent of Python `subprocess.Popen(…, start_new_session=True)`. **Do not** use `nohup … &` (it gets reaped when the parent turn ends) and **there is no `setsid` on macOS** (`PROTOCOL §⑥` clause 3 note).

## 6. How the gates back this up

- `scripts/check-sessions.mjs` — two-way card↔registry comparison; `registry_only` / `card_only` are hard failures (a bypass lane that only wrote the registry is caught here).
- `scripts/check-handoff.mjs` — validates the four anchors for **two** populations: ① every registered `running|closed` seg, and ② **any `in_progress|in_review` card whose `handoff.md` already exists** — so a hand-written handoff left by a direct launch is caught **before or after** its seg is registered.

Both gates are aggregated by `scripts/check-all.sh`; a bypass lane therefore cannot stay invisible on the board.

## 7. When the entry refuses

- **`handoff_anchor_missing:…`** — the existing `handoff.md` is hand-written/stale. Regenerate it through the ACL (back up the old file first if it holds anything you need), then re-run the entry. Do **not** hand-edit anchors in.
- **`concurrency_cap(…)`** — you are at your cap (`PROTOCOL §⑥` clause 2 / §⑥.3 parallelism-first). Finish or reconcile an existing lane first; do not raise the cap.
- **`claimed_by_mismatch` / `status_not_spawnable(…)`** — the card is not yours to run (or is not in a spawnable state); take it through the board flow in `PROTOCOL §①`.
- **`status_not_spawnable(in_review):use_role=review`** — you ran an **execution** lane against an in-review card. If you meant to review it, re-run with `role=review` / `--review` (§9); otherwise wait for the reviewer.
- **`review_needs_in_review(status=…)`** — a review lane (`role=review`) was pointed at a card that is not `in_review`.
- **`review_seg_taken(seg=…,owner=…):use_seg=segR1`** — a review lane was given a `seg=` that already belongs to another owner on this card. Reusing it would **overwrite that owner's `## Sessions` row** (the card's upsert key is `seg:<seg> ·`); drop `seg=` (default `segR1`) or pass a fresh one (§9).
- Any refusal that looks wrong ⇒ report to Elon with the JSON envelope; do not work around the entry by launching directly.

## 8. Same-repo concurrent lane ⇒ worktree isolation

The entry resolves cwd from the card's `project` + `target` (`§3` step 3) — so **a lane is isolated by pointing its `target` at its own worktree**, with **no change to this entry's behaviour**:
```bash
# 1) overlap detected by scripts/samefile-guard.mjs (read-only)?
# 2) take a per-lane worktree (idempotent; --dry-run first — zero side effects):
node ~/.openclaw/team/scripts/lane-worktree.mjs <repo> <lane> [--branch <b>] [--base <ref>] --dry-run
# 3) set the card's `target` to the returned `path`, then dispatch through §4 as usual.
```
Two lanes must never share one checkout: multiple writers in a shared working tree corrupt each other's verification (061638 O2: an external lane's `b359780` mixed into an `in_review` snapshot — detected by content forensics, 27,807 B ≠ 18,432 B) and can sweep foreign hunks into a commit (`PROTOCOL §⑥`).

**Full rule, judging criteria, naming/branch/base discipline, and cleanup**: `guides/worktree-isolation-sop.md`. Serialize instead when the card says so or `depends_on` is unmet (`PROTOCOL §⑥.3`).

## 9. Review lanes (`role=review`) — the single entry, not a side registry

**Ruling (T-20261010-084051): a review lane goes through this same single entry with `role=review`** (`--review` is equivalent). It is **not** registered on a separate surface.

Why the "separate registration surface" is not an option: a review lane is still a live sub-session, so it must appear **on both sides at once** — the card's `## Sessions` row *and* the team registry. The ACL `task.session-set` is the only thing that writes both in one step, and `check-sessions` treats "active on one side, missing on the other" as a hard failure. A registry-only surface (e.g. `turing-runs.json`) therefore reproduces exactly the `registry_only` / `card_only` breakage this entry exists to prevent.

```bash
# review lane on an in_review card (Turing reviews with codex)
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> turing --review backend=codex
```

- **State gate**: `status` must be `in_review`; anything else ⇒ `review_needs_in_review(status=…)`.
- **No claim, no ownership assertion**: the entry does not call `task.claim`, does not touch `claimed_by`, and does not assert `claimed_by == <owner>`. The reviewer is **not** the implementer — asserting ownership here would refuse every legitimate review.
- **Everything else is unchanged**: concurrency cap (turing < 3), cwd resolution, the four-anchor handoff self-check, the deterministic session id, the detached spawn, and the card+registry write in one step.
- **`seg` defaults to `segR1`** and must differ from the execution lane's seg. The card's `## Sessions` upsert key is `seg:<seg> ·` (not owner-scoped), so a review lane reusing the execution lane's `seg1` would **overwrite the execution lane's row** and destroy the audit trail of who implemented it. If you pass a `seg=` already held by another owner, the entry refuses with `review_seg_taken(seg=…,owner=…):use_seg=segR1`. This matches the pre-existing convention for review segs (`segR1-replay`, `seg2-container`, …).
- Output JSON carries `role: "review"` so a caller can tell the lanes apart.

## 10. Workspace settings preset (`settings: exists | created | would_create`)

`claude` is launched with `--settings workspace/<task-id>/.claude/settings.json`, and **the file is a preflight requirement**: if it is missing, the lane dies at once with `Settings file not found` (the spawn "succeeds" — a pid exists — but the session is dead on arrival, and the registry then holds a zombie). So the entry presets it **before** spawning:

- path exists ⇒ `settings: "exists"` — **never overwritten** (a card's own customisations survive);
- missing and `--dry-run` ⇒ `settings: "would_create"` — nothing written;
- missing and real run ⇒ the entry `mkdir -p`s `workspace/<task-id>/.claude/` and writes the default allow-list (read/write/edit + common `Bash(...)` entries) ⇒ `settings: "created"`.

The preset is idempotent and side-effect-free under `--dry-run`, and it is done for every backend (for `codex`, which takes no `--settings`, the file is simply inert).

---

> **Doc-sync note (T-20261010-084051)**: this guide is a framework doc whose normative parent is `PROTOCOL §⑥`. The change above is **method-library level** (`role=review` entry semantics + the settings preset) and adds **no new protocol clause**, so it **does not trigger a PROTOCOL §⑥ edit**; it only requires this file to be mirrored live→repo alongside `scripts/spawn-lane.mjs` (both are vendored from the same source).
