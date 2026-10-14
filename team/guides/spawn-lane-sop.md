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
  bash ~/.openclaw/team/scripts/spawn-lane.sh <card> <owner> [seg=seg1] [backend=claude|codex] [phase=<p>] [role=exec|review] [--review] [--dry-run] [--no-isolate]
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
      → arm session reaper (lane pid ⇒ terminal write on both sides, whichever way the lane ends)
```

1. **claim** — parse the card through the ACL, then dispatch on `role`:
   - `role=exec` (default): assert `status=in_progress && claimed_by=<owner>`; if the card is `ready`/`todo`, the entry claims it first. A card that is `in_review`/`done`/`failed`, or claimed by someone else, is refused. `in_review` is refused with an actionable hint — `status_not_spawnable(in_review):use_role=review` (a review lane is what you want: §9).
   - `role=review`: accept **only** `status=in_review` (otherwise `review_needs_in_review(status=…)`); **never claims and never asserts `claimed_by`** — the reviewer is not the implementer (§9).
2. **same-card double-run guard (two layers, `T-20261013-233906`)** — runs **before** the claim, so every refusal has **zero side effects** (no claim, no card write, no registry row, no log, no second lane):
   - **L1 — same lane identity.** A lane's identity is `(card, owner, seg)`; its deterministic projection is the `session_id` (`UUIDv5(card, owner, seg)`, `PROTOCOL §⑥` clause 8). The entry refuses when any registration source carries a **live** lane for this `seg` (`status=running` **and a live pid**): ① the card's `## Sessions` row for this `seg`; ② a registry entry with `phase=<seg>`; ③ a registry entry whose `session_id` equals this seg's deterministic id. ③ is load-bearing: `phase` is a free-form **display label** (real lanes register `seg1-verify`, `seg2-browser`), *not* an identity — keying on `phase` alone let a same-seg second spawn through (evidence `T-20261013-223243`). Refusal: `session_running(seg=…,pid=…,id=…):reuse_existing`. Reuse the existing session — resume it in the host's exact form (§4 / step 7) — never force a second spawn. The freshness proxy is the same as the poll double-run guard, and a dead-pid zombie row does **not** block (that is reconcile's job).
   - **L2 — same-card concurrent execution lane** (`role=exec` only). If the card already has **any** live lane (any seg), a second *execution* lane is refused: `card_busy(seg=…,live=seg1(pid=…,owner=…)):second_exec_lane`. This is the spawn-time shape of "two concurrent execution turns on one card" (`PROTOCOL §⑥` execution uniqueness); catching it here is what keeps the second lane from being derived at all — the alternative (spawn it, then roll it back per §⑥) burns a whole lane (evidence `T-20261013-223243`: a `turing` execution turn spawned `segR1` on a card already running `seg1`, and the lane was killed with a 0-byte `turing-3.out.jsonl`). **Deliberately parallel segments of one plan** (e.g. `seg1` + `seg2` started by the same turn) declare it explicitly with `parallel=1`; that declaration bypasses **L2 only** — L1 always applies (a second spawn of the *same* lane is refused even with `parallel=1`).
   `role=review` lanes skip L2 (a reviewer is a reader: pin a commit and run beside the execution lane, §9); L1 still applies to them.
3. **concurrency cap** — refuse when `running(owner) >= 8` (linus/jobs) or `>= 3` (turing) (`PROTOCOL §⑥` clause 2). Counting uses live pids, so a dead-pid zombie row does not consume a slot (that is reconcile's job).
   - **Counting source = the unique source of truth = the canonical registry `claude-sessions.json`** (team-level; `scripts/registry.mjs` `REGISTRY_PATH`), **for every owner including `turing`**. It is the **same surface the lane is registered on** (step 9), so the count can never drift from the registration. Both entries share one criterion — `owner===<owner> && status==='running' && pid alive`:
     - the entry: `scripts/spawn-lane.mjs` `runningCount()` / `capFor()`;
     - the poll gate: `scripts/poll.mjs` `runningCount()` / `claimBudget()` (its claim budget = `quota − running`, so a lane that holds a slot is not over-claimed by the next poll round).
   - **`turing-runs.json` is NOT a counting or registration surface** (T-20261014-011235; consistent with §9's ruling that a registry-only surface reproduces the `registry_only`/`card_only` breakage). Reading the count there while lanes register in the canonical registry made `running(turing)` read 0 with live lanes present, so the cap 3 did not bind (over-claim). Turing lanes register through this same single entry and are counted from the canonical registry like every other owner.
4. **cwd** — resolved from the card's `project` through the ACL (`__team__` ⇒ the team root), then overlaid with `target`; business code is never spawned inside the task workspace (`PROTOCOL §⑥`).
5. **handoff self-check (key gate)** — ensure `workspace/<task-id>/` exists; if `handoff.md` is missing, generate it with the ACL handoff command (**never overwrite** an existing one); if it **exists but misses any of the four anchors, refuse to start** (exit ≠ 0, naming the missing anchor).
6. **workspace settings preset (idempotent)** — ensure `workspace/<task-id>/.claude/settings.json` exists (it is the target of `--settings` in step 8); **never overwrite** an existing one (§10).
7. **session id** — for **claude**, a deterministic UUIDv5 via the ACL (`<card> <owner> <seg>`) ⇒ predictable, and passed at spawn via `--session-id` (**claude only** — **codex has no `--session-id`** and self-assigns its session id at spawn, so the UUIDv5 is not a codex spawn parameter) — resume in the host's exact form: claude `--resume <id>`, codex `codex exec resume <id>` (continue most recent `--last`), pi `pi --print --session <id>` (`PROTOCOL §⑥` clause 8; basis `T-20261011-231103`).
8. **spawn** — `claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits --settings <ws>/.claude/settings.json --add-dir <ws> --add-dir <team> --session-id <uuid> --name <owner>-<seg>`, started as a **new session detached from the parent process group** (see §5), `stdin`=DEVNULL, stdout → `workspace/<task-id>/<owner>-<n>.out.jsonl`, stderr → `<owner>-<n>.err.log`, cwd = project root.
9. **session-set (immediately after spawn)** — one ACL call writes **both** the card's `## Sessions` row (seg/owner/backend/id/phase/status/**pid**) **and** the team registry. Registration is never two half-writes.
10. **arm the session reaper (immediately after registration, `T-20261015-045724`)** — a detached watchdog (`scripts/lane-reaper.mjs`) waits for **this lane's pid** to die (including the zombie case) and then closes the session on both surfaces through the ACL `task.session-close`, stamping `endedAt` on the card row and appending one audit line to `workspace/<task-id>/lane-lifecycle.log`. This is what makes the terminal write hold on the abnormal paths too (killed / timed out / crashed) — the parent turn is not in the loop. Exit-field: `reaper: {state:"armed", pid:…}`. If the reaper cannot be started the entry **refuses to run the lane and closes the row it just registered** (`lane_reaper_failed(…)`): "registered but nobody owns the close" is exactly the drift this step removes. `--no-reaper` / `OPENCLAW_TEAM_REAPER=0` opts out (see `lane-session-lifecycle-sop.md` §4 for what you then owe).

`--dry-run` performs the full validation chain and prints the planned command line, but **starts no process and writes nothing** (no registry, no card, no handoff, no settings).

## 4. How to run

```bash
# Rehearse (validate + print the command; zero side effects)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 linus --dry-run

# Start a lane (defaults: seg=seg1, backend=claude)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 linus
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 jobs seg=seg2 phase=seg2-ui
# A deliberately parallel segment of ONE plan (declares it ⇒ bypasses L2 of the double-run guard; L1 still applies)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 jobs seg=seg2 parallel=1
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 turing backend=codex

# Review lane on an in_review card (defaults: seg=segR1, backend=codex)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 turing --review backend=codex

# Opt out of the session reaper (you then own task.session-close before your turn ends)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 linus --no-reaper      # = OPENCLAW_TEAM_REAPER=0
```

- The **last stdout line is JSON** `{ok, role, settings, session_id, pid, cwd, handoff, log, cmd, …}` for machine reading.
- Exit codes: **0** started (or dry-run OK) · **1** refused (validation/handoff/claim/cap) · **2** usage error.
- Refusal reasons are stable and greppable, e.g. `claimed_by_mismatch(…)`, `concurrency_cap(owner=…,running=…,cap=…)`, `handoff_anchor_missing:…`, `status_not_spawnable(…)`, `lane_samefile_conflict(…):serialize`, `lane_isolation_failed(…):serialize_or_fix` (`§11`).
- After starting a lane you **still own polling it to terminal state** (`PROTOCOL §⑥` clause 4); the entry does not take over polling. You do **not** own the session's terminal *registration* any more: step 10's reaper writes it when the lane's process ends (`lane-session-lifecycle-sop.md`).

## 5. Detach discipline (macOS)

The entry starts the child as a **new session detached from the parent process group** — in Node that is `spawn(bin, args, { detached: true })` + `unref()`, the portable equivalent of Python `subprocess.Popen(…, start_new_session=True)`. **Do not** use `nohup … &` (it gets reaped when the parent turn ends) and **there is no `setsid` on macOS** (`PROTOCOL §⑥` clause 3 note).

## 6. How the gates back this up

- `scripts/check-sessions.mjs` — two-way card↔registry comparison; `registry_only` / `card_only` are hard failures (a bypass lane that only wrote the registry is caught here). Its `note`s (the drift class: `status_mismatch` / `stale_card_line` / `zombie_registry`) are collected by `scripts/session-reconcile.mjs` (`lane-session-lifecycle-sop.md` §6); the live claiming surface no longer acts on them — poll refuses to re-claim such a card (same SOP, §3).
- `scripts/check-handoff.mjs` — validates the four anchors for **two** populations: ① every registered `running|closed` seg, and ② **any `in_progress|in_review` card whose `handoff.md` already exists** — so a hand-written handoff left by a direct launch is caught **before or after** its seg is registered.

Both gates are aggregated by `scripts/check-all.sh`; a bypass lane therefore cannot stay invisible on the board.

## 7. When the entry refuses

- **`handoff_anchor_missing:…`** — the existing `handoff.md` is hand-written/stale. Regenerate it through the ACL (back up the old file first if it holds anything you need), then re-run the entry. Do **not** hand-edit anchors in.
- **`session_running(seg=…,pid=…,id=…):reuse_existing`** — the same card + same `seg` already has a **live** session. Do **not** start a second one: resume the existing session in the host's exact form (§4 / step 7), or wait for it to reach a terminal state. If the pid is genuinely a zombie, reconcile the registry first — the guard stops blocking once the pid is dead.
- **`card_busy(seg=…,live=…):second_exec_lane`** — this card already has a **live** lane (any seg) and you asked for another **execution** lane: that is a second concurrent execution turn on one card. Do **not** reach for a different `seg` to get around it — that is exactly the case this guard exists for (evidence `T-20261013-223243`). Either wait for the running lane, or, if the work is genuinely **one plan's parallel segment**, re-run with `parallel=1` (`§3` step 2 / §4). If you merely intended to review, use `role=review` (§9).
- **`duplicate_running_lane`** (registry write, not a spawn refusal) — a registration with **no pid** was refused because the same lane (`task_id`+`owner`+`session_id`) already has a **live** running row. The live row is kept untouched. Register with a real `pid=` (that is what `spawn-lane` always does), or close the lane instead of re-registering it.
- **`concurrency_cap(…)`** — you are at your cap (`PROTOCOL §⑥` clause 2 / §⑥.3 parallelism-first). Finish or reconcile an existing lane first; do not raise the cap.
- **`claimed_by_mismatch` / `status_not_spawnable(…)`** — the card is not yours to run (or is not in a spawnable state); take it through the board flow in `PROTOCOL §①`.
- **`status_not_spawnable(in_review):use_role=review`** — you ran an **execution** lane against an in-review card. If you meant to review it, re-run with `role=review` / `--review` (§9); otherwise wait for the reviewer.
- **`review_needs_in_review(status=…)`** — a review lane (`role=review`) was pointed at a card that is not `in_review`.
- **`review_seg_taken(seg=…,owner=…):use_seg=segR1`** — a review lane was given a `seg=` that already belongs to another owner on this card. Reusing it would **overwrite that owner's `## Sessions` row** (the card's upsert key is `seg:<seg> ·`); drop `seg=` (default `segR1`) or pass a fresh one (§9).
- **`lane_samefile_conflict(with=…,overlap=…):serialize`** — a same-repo non-terminal card writes a file this card also writes. **Serialize**: wait for that card to reach terminal state, or re-scope the writes. Do **not** work around it with `--no-isolate` (that removes the protection, not the conflict) — isolation cannot fix a same-file collision, it only moves it to a branch merge (§11).
- **`lane_reaper_failed(…)`** — the session reaper (step 10) could not be started, so the entry refused to run the lane and already closed the row it had registered (fail-closed: no lane is left running without an owner for its terminal write). Re-run the entry; if it keeps failing, check that the reaper can be spawned at all (node executable, `TEAM_ROOT` writable) — and do **not** work around it with `--no-reaper` unless you are taking the close over yourself (`lane-session-lifecycle-sop.md` §4).
- **`lane_isolation_failed(…):serialize_or_fix`** — the lane's repo has a concurrent lane but its worktree could not be taken. Run `git worktree list` in the repo, clear the obstacle named in the reason (a stale path, a branch checked out elsewhere), then re-run the entry (§11). Never re-launch the lane in the shared checkout to "get it moving".
- Any refusal that looks wrong ⇒ report to Elon with the JSON envelope; do not work around the entry by launching directly.

## 8. Same-repo concurrent lane ⇒ worktree isolation (now automatic)

Two lanes must never share one checkout: multiple writers in a shared working tree corrupt each other's verification (061638 O2: an external lane's `b359780` mixed into an `in_review` snapshot — detected by content forensics, 27,807 B ≠ 18,432 B) and can sweep foreign hunks into a commit (`PROTOCOL §⑥`).

The entry resolves cwd from the card's `project` + `target` (`§3` step 4), and **since `T-20261012-022948-2` it performs the isolation itself** — no dispatch-side memory required, no card edit (`§11`). The manual route below remains valid as an **override** (non-default lane/branch/base, or when the automatic path is switched off):
```bash
# 1) overlap detected by scripts/samefile-guard.mjs (read-only)?
# 2) take a per-lane worktree (idempotent; --dry-run first — zero side effects):
node ~/.openclaw/team/scripts/lane-worktree.mjs <repo> <lane> [--branch <b>] [--base <ref>] --dry-run
# 3) point the lane's working tree at the returned `path` (in practice: by hand, put it in the
#    prompt or on the card `target`), then dispatch through §4 as usual.
```

Hand-building a worktree to **continue a card** (the `--base <previous-seg-tip>` workaround) is **no longer needed**: since `T-20261014-112936` the automatic path derives the base for a continuation spawn itself (`§11`, `worktree-isolation-sop.md §9`). The manual form survives only for a base that is neither `HEAD` nor the previous seg's tip.

**Full rule, judging criteria, naming/branch/base discipline, and cleanup**: `guides/worktree-isolation-sop.md` (§9 = the automatic path). Serialize instead when the card says so or `depends_on` is unmet (`PROTOCOL §⑥.3`).

## 9. Review lanes (`role=review`) — the single entry, not a side registry

**Ruling (T-20261010-084051): a review lane goes through this same single entry with `role=review`** (`--review` is equivalent). It is **not** registered on a separate surface.

Why the "separate registration surface" is not an option: a review lane is still a live sub-session, so it must appear **on both sides at once** — the card's `## Sessions` row *and* the team registry. The ACL `task.session-set` is the only thing that writes both in one step, and `check-sessions` treats "active on one side, missing on the other" as a hard failure. A registry-only surface (e.g. `turing-runs.json`) therefore reproduces exactly the `registry_only` / `card_only` breakage this entry exists to prevent.

```bash
# review lane on an in_review card (Turing reviews with codex)
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> turing --review backend=codex
```

- **State gate**: `status` must be `in_review`; anything else ⇒ `review_needs_in_review(status=…)`.
- **No claim, no ownership assertion**: the entry does not call `task.claim`, does not touch `claimed_by`, and does not assert `claimed_by == <owner>`. The reviewer is **not** the implementer — asserting ownership here would refuse every legitimate review.
- **A review lane is not a second execution turn** (`T-20261013-233906`): the double-run guard's L2 (`card_busy`) applies to `role=exec` only, so a reviewer may run beside an execution lane (a reviewer is a *reader*: it pins a commit rather than serializing on the tree). L1 still applies — a review lane must not reuse the execution lane's `seg`, or it would collide on lane identity.
- **Everything else is unchanged**: concurrency cap (turing < 3), cwd resolution, the four-anchor handoff self-check, the deterministic session id, the detached spawn, and the card+registry write in one step.
- **`seg` defaults to `segR1`** and must differ from the execution lane's seg. The card's `## Sessions` upsert key is `seg:<seg> ·` (not owner-scoped), so a review lane reusing the execution lane's `seg1` would **overwrite the execution lane's row** and destroy the audit trail of who implemented it. If you pass a `seg=` already held by another owner, the entry refuses with `review_seg_taken(seg=…,owner=…):use_seg=segR1`. This matches the pre-existing convention for review segs (`segR1-replay`, `seg2-container`, …).
- Output JSON carries `role: "review"` so a caller can tell the lanes apart.

## 10. Workspace settings preset (`settings: exists | created | would_create`)

`claude` is launched with `--settings workspace/<task-id>/.claude/settings.json`, and **the file is a preflight requirement**: if it is missing, the lane dies at once with `Settings file not found` (the spawn "succeeds" — a pid exists — but the session is dead on arrival, and the registry then holds a zombie). So the entry presets it **before** spawning:

- path exists ⇒ `settings: "exists"` — **never overwritten** (a card's own customisations survive);
- missing and `--dry-run` ⇒ `settings: "would_create"` — nothing written;
- missing and real run ⇒ the entry `mkdir -p`s `workspace/<task-id>/.claude/` and writes the default allow-list (read/write/edit + common `Bash(...)` entries) ⇒ `settings: "created"`.

The preset is idempotent and side-effect-free under `--dry-run`, and it is done for every backend (for `codex`, which takes no `--settings`, the file is simply inert).

## 11. Automatic same-repo lane isolation (default on; `--no-isolate` opts out)

**Rule**: when the lane's repo already carries a **concurrent non-terminal lane**, the entry isolates the lane **by itself** — it creates a per-lane worktree through `scripts/lane-worktree.mjs` (`guides/worktree-isolation-sop.md §4`) and points the lane's cwd at it. The judgment is **not** recomputed here: `scripts/lane-isolation.mjs` reuses the existing policy (same **file** ⇒ strict serial; same **repo**, other **file** ⇒ isolate).

Where it sits in the sequence (`§3`): the **decision** runs at **①c**, *before* the claim, so a refusal has zero side effects (no claim, no registry, no log); the **worktree is created at ③b**, after the concurrency cap and the handoff/settings pre-checks, so a refused spawn never leaves a worktree behind. It reuses the entry's own cwd resolution (`§3` step 4) and the `lane-worktree.mjs` naming defaults: `lane = <card>-<seg>`, `path = <repo>-wt-<lane>`, `branch = lane/<lane>`.

**Not isolated** (unchanged behaviour): no other non-terminal lane in the repo · a non-git repo (e.g. `project: __team__` ⇒ the team root, which is not a checkout) · `role=review` (a review lane is a *reader*; isolate the writer and pin the commit, `worktree-isolation-sop.md §3`) · the lane's cwd is already a linked worktree · the switch is off. In all of those `isolation.mode` is `none` / `already_isolated` / `disabled` and `cwd` is exactly what it was before this feature.

**Two new refusals** (exit 1, both zero-side-effect, both greppable):

- `lane_samefile_conflict(with=…,overlap=…):serialize` — a same-repo non-terminal card shares a file with this one. Isolation does not fix that (the collision would just move to a branch merge), so the lane **waits**: serialize (`PROTOCOL §⑥.3` case ②).
- `lane_isolation_failed(<inner reason>):serialize_or_fix` — the worktree could not be taken (path occupied by a non-worktree directory, lane branch checked out elsewhere, `bad_lane`, `worktree_add_failed`, or an explicit `--base` that does not resolve ⇒ `base_unresolved:<ref>`). **Fail-closed**: the entry refuses rather than starting the lane in the shared checkout, because "could not isolate" silently read as "green" is precisely the failure this closes. Fix the obstacle (`git worktree list`, remove the stale path, correct the ref) or serialize; do not work around it by spawning directly.

**Output**: `isolation: { mode, lane, branch, path, main_repo, same_repo_lanes, action, applied, base }`; `cwd` equals `isolation.path` when isolated, and the sub-session prompt gains one line stating the worktree + branch and asking for the branch/sha in the Report. The card's `target` is **not** rewritten (it is the declaration and the `samefile-guard` fallback write set — rewriting it would silently disarm the same-file guard); the *effective* tree is `isolation.path`.

**Base — a continuation is not a fresh start (T-20261014-112936).** `isolation.head` is no longer always `HEAD`. A spawn that **continues an existing seg** is built on the **previous seg's lane-branch tip** (`isolation.base = {ref, source: "prev_seg", prev_seg, resolved}`), so the earlier segment's committed work is in the tree; a **first** seg is still built on `HEAD` (`base.source: "head"`, behaviour unchanged). `--base <ref>` (or `base=<ref>`) pins the base explicitly and is **refused if unresolvable** (`lane_isolation_failed(base_unresolved:<ref>):serialize_or_fix`) rather than silently falling back to `HEAD`. Full rule and evidence: `worktree-isolation-sop.md §9`.

**Rollback switch**: `--no-isolate`, or `OPENCLAW_LANE_ISOLATION=0` (`off`/`false`/`no`/`disabled`) ⇒ the pre-change behaviour, `isolation.mode = "disabled"`.

```bash
# Default: automatic isolation (a worktree appears only if the repo really has a concurrent lane)
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> linus --dry-run     # rehearse: prints cwd + isolation, zero side effects
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> linus              # may create <repo>-wt-<card>-seg1
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> linus seg=seg2     # continuation: base = lane/<card>-seg1
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> linus --base 43bdf5f   # pin the base explicitly
# Rollback to the explicit discipline
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> linus --no-isolate
```

---

> **Doc-sync note (T-20261010-084051)**: this guide is a framework doc whose normative parent is `PROTOCOL §⑥`. The change above is **method-library level** (`role=review` entry semantics + the settings preset) and adds **no new protocol clause**, so it **does not trigger a PROTOCOL §⑥ edit**; it only requires this file to be mirrored live→repo alongside `scripts/spawn-lane.mjs` (both are vendored from the same source).

> **Doc-sync note (T-20261013-233906)**: §3 step 2 (the two-layer double-run guard) + §7 (`card_busy`, `duplicate_running_lane`) are **method-library level**. They **implement** existing clauses — `PROTOCOL §⑥` execution uniqueness (one execution turn per card) and the **registry single source of truth** — and **redefine nothing**, so no PROTOCOL edit is triggered. Scope: `scripts/spawn-lane.mjs` (L1③ `session_id` criterion + L2 `card_busy` + `parallel=1`), `scripts/registry.mjs` (lane identity for dedupe, `duplicate_running_lane` refusal), `scripts/check-sessions.mjs` (soft `duplicate_lane` note), `tests/spawn-lane.test.mjs` + `tests/registry-lane-identity.test.mjs`.
>
> **Disposition of the "Elon direct dispatch vs poll claim" candidate (card acceptance ②)**: that race was closed earlier (`T-20261009-235600`, one-way path: every direct wake-up goes through `task.dispatch`, which is claim-first on the same lock/primitive as poll; a failed claim ⇒ `dispatched:false` ⇒ **no** `sessions_send`). The 2026-10-13 recurrence was **not** a claim race: the card was already `in_progress` with a live lane, so no claim was involved on either side — the hole was in the **spawn** path (a second turn derived a lane for a card it did not hold, and the per-`phase` guard let it through). The single enforcement point is therefore **this entry**: a turn must not spawn a lane for a card another turn is already executing, and `spawn-lane` now refuses it before anything is derived. Dispatch-side discipline (`task.dispatch`, never a bare `sessions_send` that bypasses the claim) is unchanged and remains the rule.
>
> **Deploy note**: `scripts/registry.mjs` is imported by the provider ACL (`task.sessionSet` / `sessionClose` write the registry **through this file**), so the lane-identity dedupe + `duplicate_running_lane` refusal only take effect **after the changed files are deployed to the live team dir** (`install.sh`), not by the repo commit alone.

> **Doc-sync note (T-20261012-022948-2)**: §8 + §11 (automatic same-repo lane isolation) are likewise **method-library level**. They **implement** existing clauses — `PROTOCOL §⑥.3` case ② (same-file/same-resource ⇒ serialize; parallelism-first otherwise), `§⑨.1` (single writer per file) and `PROTOCOL §⑥` cwd normalization — and **redefine nothing**, so no PROTOCOL edit is triggered. Scope of the change: `scripts/lane-isolation.mjs` (new decision module), `scripts/spawn-lane.mjs` (①c/③b wiring + `--no-isolate`), `scripts/lane-worktree.mjs` + `scripts/tests/lane-worktree.test.mjs` (the 074754-2 mechanism, **backfilled into the repo** — it previously existed only in the deployed instance) and the tests `tests/lane-isolation.test.mjs` / `tests/spawn-lane-isolation.test.mjs`. Response: `guides/worktree-isolation-sop.md §9`.

> **Doc-sync note (T-20261014-112936)**: §8 + §11's base rule (a continuation spawn is built on the **previous seg's branch tip**, not `HEAD`; `--base <ref>` pins and is refused when unresolvable) is likewise **method-library level** — it implements the "the base is a snapshot" discipline of `guides/worktree-isolation-sop.md §5` on the automatic path and **adds no clause**, so no `PROTOCOL §⑥` edit is triggered. Scope: `scripts/lane-isolation.mjs` (`deriveLaneBase` / `prevSegCandidates` + `isolation.base`), `scripts/lane-worktree.mjs` (exports `branchHead`/`revParse`; its own `base` default stays `HEAD`), `scripts/spawn-lane.mjs` (`--base`/`base=` + `sessions` plumbing) and the test `tests/lane-continuation-base.test.mjs`. Response: `guides/worktree-isolation-sop.md §9`.
