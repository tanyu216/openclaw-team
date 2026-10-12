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
  bash ~/.openclaw/team/scripts/spawn-lane.sh <card> <owner> [seg=seg1] [backend=claude|codex] [harness=cli|plugin] [phase=<p>] [role=exec|review] [--review] [--plugin] [--dry-run] [--no-isolate]
  ```
  The thin wrapper `scripts/spawn-lane.sh` execs the core `scripts/spawn-lane.mjs`.
  `role=exec` (default) starts an execution lane; `role=review` (`--review` is equivalent) starts a **review lane** (§9).
  `harness=cli` (default) keeps the current `codex exec` child-process path; `harness=plugin` (`--plugin` is equivalent, **`backend=codex` only**) runs the Codex lane on the official app-server embedded harness — its handle is a **native thread id**, so registration is a **two-step backfill** (§3.1).
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
2. **same-card / same-seg double-run guard** — if this card already carries a **live** registration for this `seg` (card's `## Sessions` row or the registry entry with `phase=seg`, `status=running` **and a live pid**), the entry **refuses** (`session_running(seg=…,pid=…,id=…):reuse_existing`) instead of starting a second session. The criterion is the same as the poll double-run guard (live pid = the freshness proxy), and a dead-pid zombie row does **not** block (that is reconcile's job). Reuse the existing session — resume it in the host's exact form (§4 / step 7) — never force a second spawn. The guard runs **before** the claim, so a refusal has **zero side effects**.
3. **concurrency cap** — refuse when `running(owner) >= 8` (linus/jobs) or `>= 3` (turing) (`PROTOCOL §⑥` clause 2). Counting uses live pids, so a dead-pid zombie row does not consume a slot (that is reconcile's job).
4. **cwd** — resolved from the card's `project` through the ACL (`__team__` ⇒ the team root), then overlaid with `target`; business code is never spawned inside the task workspace (`PROTOCOL §⑥`).
5. **handoff self-check (key gate)** — ensure `workspace/<task-id>/` exists; if `handoff.md` is missing, generate it with the ACL handoff command (**never overwrite** an existing one); if it **exists but misses any of the four anchors, refuse to start** (exit ≠ 0, naming the missing anchor).
6. **workspace settings preset (idempotent)** — ensure `workspace/<task-id>/.claude/settings.json` exists (it is the target of `--settings` in step 8); **never overwrite** an existing one (§10).
7. **session id** — for **claude**, a deterministic UUIDv5 via the ACL (`<card> <owner> <seg>`) ⇒ predictable, and passed at spawn via `--session-id` (**claude only** — **codex has no `--session-id`** and self-assigns its session id at spawn, so the UUIDv5 is not a codex spawn parameter) — resume in the host's exact form: claude `--resume <id>`, codex `codex exec resume <id>` (continue most recent `--last`), pi `pi --print --session <id>` (`PROTOCOL §⑥` clause 8; basis `T-20261011-231103`).
8. **spawn** — `claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits --settings <ws>/.claude/settings.json --add-dir <ws> --add-dir <team> --session-id <uuid> --name <owner>-<seg>`, started as a **new session detached from the parent process group** (see §5), `stdin`=DEVNULL, stdout → `workspace/<task-id>/<owner>-<n>.out.jsonl`, stderr → `<owner>-<n>.err.log`, cwd = project root.
9. **session-set (immediately after spawn)** — one ACL call writes **both** the card's `## Sessions` row (seg/owner/backend/id/phase/status/**pid**) **and** the team registry. Registration is never two half-writes.

`--dry-run` performs the full validation chain and prints the planned command line, but **starts no process and writes nothing** (no registry, no card, no handoff, no settings).

### 3.1 Codex plugin lane (`harness=plugin`) — the two-step backfill

A plugin lane diverges from step 7–9 above in exactly one way: **there is no `--session-id` and no lane pid**. The handle is a **native thread id** the harness assigns at spawn, so it cannot be predicted before the turn starts. Registration therefore happens in **two same-write steps** (`task.session-set` writes card + registry together **each time**, so there is never a half-written state):

1. **step ① — `id:pending`** (immediately after dispatch): the card row carries `backend:codex · harness:plugin · id:pending`; the registry entry gets `harness:plugin`, `id_state:pending`, `seg`, `backend`, and `pid` = the **gateway** pid (or the placeholder `-`).
2. **step ② — `id:<thread_id>`** (as soon as the native thread id is read back): the **same `seg:` row** is overwritten (`id:<thread_id>`, `id_state:bound`, registry `thread_id` + `id_state:bound`). The upsert key is `seg:<seg> ·`, so the card never accumulates two rows; the registry's pending row for that `(task, seg)` is **closed** in the same step, so it never lingers as a second `running` entry (which would double-count the concurrency cap).
3. **bind timeout** — `id_state=pending` past `THREAD_BIND_TIMEOUT_MS` (default **120 s**, aligned with the existing startup-probe window) ⇒ the lane is `failed` and reported (`thread_bind_timeout(seg=…,ms=…):reconcile`); the entry **never** parks silently.

Liveness for a plugin lane is **`pid` alive OR native thread reachable** — the registry `pid` is the long-lived **gateway** pid and must **never** be read as the lane's own liveness (§12). cwd, sandbox domain and the approval posture are the **same** as the CLI path, not relaxed: the sandbox maps onto the same `read-only | workspace-write | danger-full-access` values and an unattended lane keeps the CLI-equivalent, non-bypass approval posture (no auto-approve weakening; a blocking approval ⇒ `blocked` + report). Gateway logs (24 h prune) are exported to `workspace/<task-id>/evidence/` at lane start.

Mechanism contract + per-gate evidence commands: `guides/codex-plugin-lane-contract.md`. Test surface: `scripts/tests/spawn-lane-plugin.test.mjs`.

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

# Codex plugin lane (official app-server harness; two-step registration — §3.1)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 turing backend=codex harness=plugin --dry-run
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 turing backend=codex --plugin
```

- The **last stdout line is JSON** `{ok, role, settings, session_id, pid, cwd, handoff, log, cmd, …}` for machine reading.
- Exit codes: **0** started (or dry-run OK) · **1** refused (validation/handoff/claim/cap) · **2** usage error.
- Refusal reasons are stable and greppable, e.g. `claimed_by_mismatch(…)`, `concurrency_cap(owner=…,running=…,cap=…)`, `handoff_anchor_missing:…`, `status_not_spawnable(…)`, `lane_samefile_conflict(…):serialize`, `lane_isolation_failed(…):serialize_or_fix` (`§11`).
- After starting a lane you **still own polling it to terminal state** (`PROTOCOL §⑥` clause 4); the entry does not take over polling.

## 5. Detach discipline (macOS)

The entry starts the child as a **new session detached from the parent process group** — in Node that is `spawn(bin, args, { detached: true })` + `unref()`, the portable equivalent of Python `subprocess.Popen(…, start_new_session=True)`. **Do not** use `nohup … &` (it gets reaped when the parent turn ends) and **there is no `setsid` on macOS** (`PROTOCOL §⑥` clause 3 note).

## 6. How the gates back this up

- `scripts/check-sessions.mjs` — two-way card↔registry comparison; `registry_only` / `card_only` are hard failures (a bypass lane that only wrote the registry is caught here).
- `scripts/check-handoff.mjs` — validates the four anchors for **two** populations: ① every registered `running|closed` seg, and ② **any `in_progress|in_review` card whose `handoff.md` already exists** — so a hand-written handoff left by a direct launch is caught **before or after** its seg is registered.

Both gates are aggregated by `scripts/check-all.sh`; a bypass lane therefore cannot stay invisible on the board.

`check-sessions` also judges **liveness** with the plugin lane in mind: a Codex plugin row/entry (`harness:plugin`) is alive when its **native thread is reachable**, not when a pid is — a row without a `harness:` segment is read as `cli` (backward compatible), so historical rows keep their old meaning.

## 7. When the entry refuses

- **`handoff_anchor_missing:…`** — the existing `handoff.md` is hand-written/stale. Regenerate it through the ACL (back up the old file first if it holds anything you need), then re-run the entry. Do **not** hand-edit anchors in.
- **`session_running(seg=…,pid=…,id=…):reuse_existing`** — the same card + same `seg` already has a **live** session. Do **not** start a second one: resume the existing session in the host's exact form (§4 / step 7), or wait for it to reach a terminal state. If the pid is genuinely a zombie, reconcile the registry first — the guard stops blocking once the pid is dead.
- **`concurrency_cap(…)`** — you are at your cap (`PROTOCOL §⑥` clause 2 / §⑥.3 parallelism-first). Finish or reconcile an existing lane first; do not raise the cap.
- **`claimed_by_mismatch` / `status_not_spawnable(…)`** — the card is not yours to run (or is not in a spawnable state); take it through the board flow in `PROTOCOL §①`.
- **`status_not_spawnable(in_review):use_role=review`** — you ran an **execution** lane against an in-review card. If you meant to review it, re-run with `role=review` / `--review` (§9); otherwise wait for the reviewer.
- **`review_needs_in_review(status=…)`** — a review lane (`role=review`) was pointed at a card that is not `in_review`.
- **`review_seg_taken(seg=…,owner=…):use_seg=segR1`** — a review lane was given a `seg=` that already belongs to another owner on this card. Reusing it would **overwrite that owner's `## Sessions` row** (the card's upsert key is `seg:<seg> ·`); drop `seg=` (default `segR1`) or pass a fresh one (§9).
- **`unknown_harness:<v>`** (usage, exit 2) — `harness=` was given a value outside `cli|plugin`. Nothing was started or written; use `harness=cli` (default) or `harness=plugin`.
- **`harness_plugin_requires_codex(backend=<b>)`** (usage, exit 2) — `harness=plugin` was combined with a non-codex backend. The official embedded harness exists for the **Codex leg only** (`claude`/`pi` have none) — run the lane as `backend=codex`, or drop `harness=plugin` (§3.1).
- **`thread_bind_timeout(seg=…,ms=…):reconcile`** (exit 1) — a plugin lane never reported its native thread id within `THREAD_BIND_TIMEOUT_MS` (default 120 s). The lane is marked `failed` and its dispatcher terminated; **do not** start a replacement blindly — reconcile the registry entry first, then re-run the entry (§3.1).
- **`lane_samefile_conflict(with=…,overlap=…):serialize`** — a same-repo non-terminal card writes a file this card also writes. **Serialize**: wait for that card to reach terminal state, or re-scope the writes. Do **not** work around it with `--no-isolate` (that removes the protection, not the conflict) — isolation cannot fix a same-file collision, it only moves it to a branch merge (§11).
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
- `lane_isolation_failed(<inner reason>):serialize_or_fix` — the worktree could not be taken (path occupied by a non-worktree directory, lane branch checked out elsewhere, `bad_lane`, `worktree_add_failed`). **Fail-closed**: the entry refuses rather than starting the lane in the shared checkout, because "could not isolate" silently read as "green" is precisely the failure this closes. Fix the obstacle (`git worktree list`, remove the stale path) or serialize; do not work around it by spawning directly.

**Output**: `isolation: { mode, lane, branch, path, main_repo, same_repo_lanes, action, applied }`; `cwd` equals `isolation.path` when isolated, and the sub-session prompt gains one line stating the worktree + branch and asking for the branch/sha in the Report. The card's `target` is **not** rewritten (it is the declaration and the `samefile-guard` fallback write set — rewriting it would silently disarm the same-file guard); the *effective* tree is `isolation.path`.

**Rollback switch**: `--no-isolate`, or `OPENCLAW_LANE_ISOLATION=0` (`off`/`false`/`no`/`disabled`) ⇒ the pre-change behaviour, `isolation.mode = "disabled"`.

```bash
# Default: automatic isolation (a worktree appears only if the repo really has a concurrent lane)
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> linus --dry-run     # rehearse: prints cwd + isolation, zero side effects
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> linus              # may create <repo>-wt-<card>-seg1
# Rollback to the explicit discipline
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> linus --no-isolate
```

---

> **Doc-sync note (T-20261010-084051)**: this guide is a framework doc whose normative parent is `PROTOCOL §⑥`. The change above is **method-library level** (`role=review` entry semantics + the settings preset) and adds **no new protocol clause**, so it **does not trigger a PROTOCOL §⑥ edit**; it only requires this file to be mirrored live→repo alongside `scripts/spawn-lane.mjs` (both are vendored from the same source).

> **Doc-sync note (T-20261012-022948-2)**: §8 + §11 (automatic same-repo lane isolation) are likewise **method-library level**. They **implement** existing clauses — `PROTOCOL §⑥.3` case ② (same-file/same-resource ⇒ serialize; parallelism-first otherwise), `§⑨.1` (single writer per file) and `PROTOCOL §⑥` cwd normalization — and **redefine nothing**, so no PROTOCOL edit is triggered. Scope of the change: `scripts/lane-isolation.mjs` (new decision module), `scripts/spawn-lane.mjs` (①c/③b wiring + `--no-isolate`), `scripts/lane-worktree.mjs` + `scripts/tests/lane-worktree.test.mjs` (the 074754-2 mechanism, **backfilled into the repo** — it previously existed only in the deployed instance) and the tests `tests/lane-isolation.test.mjs` / `tests/spawn-lane-isolation.test.mjs`. Response: `guides/worktree-isolation-sop.md §9`.

> **Doc-sync note (T-20261013-012318-4)**: §1 (entry signature), §3.1 (the plugin lane's two-step backfill), §4 (example), §6 (liveness in the gate) and §7 (new refusal codes) implement the A1 contract `guides/codex-plugin-lane-contract.md` for the **Codex leg only**. They **add** an opt-in `harness=plugin` sub-path and **change no existing discipline** (default `harness=cli` is byte-for-byte the old path), so the PROTOCOL edit is **additive**: a new plugin-lane note in `§⑥`, plus one-clause touches to `§⑥` clauses 2/3/8, the board `## Sessions` schema comment and `§⑬.2` — all **reflecting** the contract rather than redefining it. Scope of the change: `scripts/spawn-lane.mjs` (harness dispatch + two-step backfill + G8 export), `scripts/registry.mjs` (`seg` in the dedupe key, `isEntryAlive`/`threadReachable`/`closePendingEntries`), `scripts/check-sessions.mjs` (harness-aware parsing + liveness), the provider ACL `task.sessionSet` (no repository home — **landed in the deployed instance** and contract-tested from the repo) and `scripts/tests/spawn-lane-plugin.test.mjs`. Response: `guides/task-interface.md §9` + `PROTOCOL §⑥`.
