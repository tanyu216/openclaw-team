# Spawn-Lane SOP (`spawn-lane-sop.md`)

> **Ownership / Maintainer**: **Linus** (engineering) owns the entry and this SOP; **Elon** owns the normative rule `R-SESSION-1` and approves exceptions.
> **Status**: method library. The **normative clause** lives in `R-SESSION-1` (session orchestration); this file **references** it and does not copy its text (`R-LAYER-1`).
> **Depends on**: `R-BOARD-1` · `R-SESSION-1` · `guides/task-interface.md` · `guides/incident-response-sop.md`.
> **Applies to**: **every newly started lane** (a `claude -p` or `codex exec` sub-session) for Linus / Jobs / Turing.
> **Reference convention**: always write `R-<DOMAIN>-<n>` or `<guide-name> §<section>` — never line-number anchors, never card-number anchors (`R-LAYER-1`).

---

## 1. Rule: one entry, no direct launch

- **The only legitimate way to start a lane is the single entry**:
  ```bash
  bash ~/.openclaw/team/scripts/spawn-lane.sh <card> <owner> [seg=seg1] [backend=claude|codex] [harness=cli|plugin] [phase=<p>] [role=exec|review] [--review] [--plugin] [--interactive] [--dry-run] [--no-reaper]
  ```
  The thin wrapper `scripts/spawn-lane.sh` execs the core `scripts/spawn-lane.mjs`.
  `role=exec` (default) starts an execution lane; `role=review` (`--review` is equivalent) starts a **review lane** (§9).
  `harness=cli` (default) keeps the current `codex exec` child-process path; `harness=plugin` (`--plugin` is equivalent, **`backend=codex` only**) runs the Codex lane on the official app-server embedded harness — its handle is a **native thread id**, so registration is a **two-step backfill** (§3.1).
  `interactive=1` (`--interactive` is equivalent) opts this lane into the **interactive host** (`scripts/lane-host.mjs`): permission requests are decided by a fail-closed local policy, and clarifications/decisions are written to the board (`blocked` + question artifact) and stop the lane. **Default off.** Unsupported with `harness=plugin` and with `role=review` (the review read-only guarantee needs `settings.review.json` + `dontAsk`/`read-only`). Full contract: `guides/interactive-lane-sop.md`.
- **Forbidden**: running `claude -p …` / `codex exec …` **directly** and registering (or not registering) by hand. A lane started that way bypasses the ACL and reproduces the two failure modes in §2.
- A lane **must not** be started outside the entry even when it "seems simpler" — the entry only adds one command's worth of friction and removes two classes of board-wide breakage.
---

## 2. Why (two field-verified failure modes)

Both were observed on 2026-10-10 (`check-all` red) on lanes started by a direct `claude -p` — the card claim was fine, but the session was never registered through the ACL.

1. **`registry_only`** — the team-level registry (`claude-sessions.json`) held a **`running`** entry whose **pid was alive**, while the card's `## Sessions` section was **empty**. The gate `check-sessions` treats "active on one side, missing on the other" as a **hard failure**, so `check-all` went red. Root cause: registration wrote only the registry, never the card (the ACL writes both in one step).
2. **Non-canonical handoff** — `workspace/<task-id>/handoff.md` was **hand-written**, missing the four anchors (`HANDOFF:v1` / `## 任务卡` / `## 上段结论` / `## 讨论/决策` / `state.md`). Once a seg was registered, `check-handoff` failed; the file is what the next segment is supposed to read first, so a non-canonical one silently breaks cross-segment consistency (`R-SEG-1`).

⇒ The entry makes both **impossible by construction**, and the gates catch any lane that still bypasses it.
---

## 3. Sequence (what the entry does, in order)

```
claim → handoff self-check → resolve cwd/session-id → spawn → session-set (card + registry, one step)
      → arm session reaper (lane pid ⇒ terminal write on both sides, whichever way the lane ends)
```

1. **claim** — parse the card through the ACL, then dispatch on `role`:
   - `role=exec` (default): assert `status=in_progress && claimed_by=<owner>`; if the card is `ready`/`todo`, the entry claims it first. A card that is `in_review`/`done`/`failed`, or claimed by someone else, is refused. `in_review` is refused with an actionable hint — `status_not_spawnable(in_review):use_role=review` (a review lane is what you want: §9).
   - `role=review`: accept **only** `status=in_review` (otherwise `review_needs_in_review(status=…)`); **never claims and never asserts `claimed_by`** — the reviewer is not the implementer (§9).
2. **same-card double-run guard (two layers)** — runs **before** the claim, so every refusal has **zero side effects** (no claim, no card write, no registry row, no log, no second lane):
   - **L1 — same lane identity.** A lane's identity is `(card, owner, seg)`; its deterministic projection is the `session_id` (`UUIDv5(card, owner, seg)`, `R-SESSION-1` clause 8). The entry refuses when any registration source carries a **live** lane for this `seg` (`status=running` **and a live pid**): ① the card's `## Sessions` row for this `seg`; ② a registry entry with `phase=<seg>`; ③ a registry entry whose `session_id` equals this seg's deterministic id. ③ is load-bearing: `phase` is a free-form **display label** (real lanes register `seg1-verify`, `seg2-browser`), *not* an identity — keying on `phase` alone let a same-seg second spawn through. Refusal: `session_running(seg=…,pid=…,id=…):reuse_existing`. Reuse the existing session — resume it in the host's exact form (§4 / step 7) — never force a second spawn. The freshness proxy is the same as the poll double-run guard, and a dead-pid zombie row does **not** block (that is reconcile's job).
   - **L2 — same-card concurrent execution lane** (`role=exec` only). If the card already has **any** live lane (any seg), a second *execution* lane is refused: `card_busy(seg=…,live=seg1(pid=…,owner=…)):second_exec_lane`. This is the spawn-time shape of "two concurrent execution turns on one card" (`R-SESSION-1` execution uniqueness); catching it here is what keeps the second lane from being derived at all — the alternative (spawn it, then roll it back per `R-SESSION-1`) burns a whole lane. **There is no parallel bypass**: `parallel=1` was removed; work that must run in parallel is split into separate cards or serialized.
   `role=review` lanes skip L2, but `spawnLane` applies a stricter review gate: the card must have **no other live lane** (`review_needs_quiet_card`). A reviewer therefore starts only after the execution lane has ended; L1 still applies (a review lane must not reuse the execution lane's `seg`).
3. **concurrency cap** — refuse when `running(owner) >= 8` (linus/jobs) or `>= 3` (turing) (`R-SESSION-1` clause 2). Counting uses live pids, so a dead-pid zombie row does not consume a slot (that is reconcile's job).
   - **Counting source = the unique source of truth = the canonical registry `claude-sessions.json`** (team-level; `scripts/registry.mjs` `REGISTRY_PATH`), **for every owner including `turing`**. It is the **same surface the lane is registered on** (step 9), so the count can never drift from the registration. Both entries share one criterion — `owner===<owner> && status==='running' && pid alive`:
     - the entry: `scripts/spawn-lane.mjs` `runningCount` / `capFor`;
     - the poll gate: `scripts/poll.mjs` `runningCount` / `claimBudget` (its claim budget = `quota − running`, so a lane that holds a slot is not over-claimed by the next poll round).
   - **`turing-runs.json` is NOT a counting or registration surface** (consistent with §9's ruling that a registry-only surface reproduces the `registry_only`/`card_only` breakage). Reading the count there while lanes register in the canonical registry made `running(turing)` read 0 with live lanes present, so the cap 3 did not bind (over-claim). Turing lanes register through this same single entry and are counted from the canonical registry like every other owner.
4. **cwd** — resolved from the card's `project` through the ACL (`__team__` ⇒ the team root), then overlaid with `target`; business code is never spawned inside the task workspace (`R-SESSION-1`).
5. **handoff self-check (key gate)** — ensure `workspace/<task-id>/` exists; if `handoff.md` is missing, generate it with the ACL handoff command (**never overwrite** an existing one); if it **exists but misses any of the four anchors, refuse to start** (exit ≠ 0, naming the missing anchor).
6. **workspace settings preset (idempotent)** — execution lanes ensure `workspace/<task-id>/.claude/settings.json` exists (the target of `--settings` in step 8); review lanes ensure `workspace/<task-id>/.claude/settings.review.json` instead. **Never overwrite** an existing file (§10). The review file is a `dontAsk` allowlist: read-only tools plus **only** `Edit(//<abs>/review-report.md)`; it must not carry a bare `Edit` deny (deny beats allow and would also block the report).
7. **session id** — for **claude**, a deterministic UUIDv5 via the ACL (`<card> <owner> <seg>`) ⇒ predictable, and passed at spawn via `--session-id` (**claude only** — **codex has no `--session-id`** and self-assigns its session id at spawn, so the UUIDv5 is not a codex spawn parameter) — resume in the host's exact form: claude `--resume <id>`, codex `codex exec resume <id>` (continue most recent `--last`), pi `pi --print --session <id>` (`R-SESSION-1` clause 8; basis).
8. **spawn** — execution lane: `claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits --settings <ws>/.claude/settings.json --add-dir <ws> --add-dir <team> --session-id <uuid> --name <owner>-<seg>`; or `codex exec --sandbox workspace-write --add-dir <ws> --add-dir <team> <prompt>`. Review lane: claude uses `--permission-mode dontAsk --permission-prompts none --settings <ws>/.claude/settings.review.json`; codex uses `codex exec --sandbox read-only -o <ws>/review-report.md <prompt>`. Every form is started as a **new session detached from the parent process group** (see §5), `stdin`=DEVNULL, stdout → `workspace/<task-id>/<owner>-<n>.out.jsonl`, stderr → `<owner>-<n>.err.log`, cwd = project root.
   **Interactive lanes** (`interactive=1`) are the exception to “spawn the backend directly”: the spawned process is `node lane-host.mjs …`, which owns the backend and its stdin/stdout pipes. The **registered pid is the host**; the actual backend argv is printed as `backend_cmd` in the plan. The host waits for the backend handshake and writes `{"type":"lane-host","event":"ready"}` before the entry returns; a ready timeout closes the session and refuses (`host_ready_timeout`). The Claude form uses `--input-format stream-json --permission-mode default --permission-prompt-tool stdio` with the narrow `settings.interactive.json`; the Codex form uses `codex app-server --stdio` instead of `codex exec`.
9. **session-set (immediately after spawn)** — one ACL call writes **both** the card's `## Sessions` row (seg/owner/backend/id/phase/status/**pid**) **and** the team registry. Registration is never two half-writes.
10. **arm the session reaper (immediately after registration)** — a detached watchdog (`scripts/lane-reaper.mjs`) waits for **this lane's pid** to die (including the zombie case) and then closes the session on both surfaces through the ACL `task.session-close`, stamping `endedAt` on the card row and appending one audit line to `workspace/<task-id>/lane-lifecycle.log`. This is what makes the terminal write hold on the abnormal paths too (killed / timed out / crashed) — the parent turn is not in the loop. Exit-field: `reaper: {state:"armed", pid:…}`. If the reaper cannot be started the entry **refuses to run the lane and closes the row it just registered** (`lane_reaper_failed(…)`): "registered but nobody owns the close" is exactly the drift this step removes. `--no-reaper` / `OPENCLAW_TEAM_REAPER=0` opts out (see `lane-session-lifecycle-sop.md` §4 for what you then owe).

`--dry-run` performs the full validation chain and prints the planned command line, but **starts no process and writes nothing** (no registry, no card, no handoff, no settings).

### 3.1 Codex plugin lane (`harness=plugin`) — the two-step backfill

A plugin lane diverges from step 7–9 above in exactly one way: **there is no `--session-id` and no lane pid**. The handle is a **native thread id** the harness assigns at spawn, so it cannot be predicted before the turn starts. Registration therefore happens in **two same-write steps** (`task.session-set` writes card + registry together **each time**, so there is never a half-written state):

1. **step ① — `id:pending`** (immediately after dispatch): the card row carries `backend:codex · harness:plugin · id:pending`; the registry entry gets `harness:plugin`, `id_state:pending`, `seg`, `backend`, and `pid` = the **gateway** pid (or the placeholder `-`).
2. **step ② — `id:<thread_id>`** (as soon as the native thread id is read back): the **same `seg:` row** is overwritten (`id:<thread_id>`, `id_state:bound`, registry `thread_id` + `id_state:bound`). The upsert key is `seg:<seg> ·`, so the card never accumulates two rows; the registry's pending row for that `(task, seg)` is **closed** in the same step, so it never lingers as a second `running` entry (which would double-count the concurrency cap).
3. **bind timeout** — `id_state=pending` past `THREAD_BIND_TIMEOUT_MS` (default **120 s**, aligned with the existing startup-probe window) ⇒ the lane is `failed` and reported (`thread_bind_timeout(seg=…,ms=…):reconcile`); the entry **never** parks silently.

Liveness for a plugin lane is **`pid` alive OR native thread reachable** — the registry `pid` is the long-lived **gateway** pid and must **never** be read as the lane's own liveness (`R-SESSION-1`). cwd, sandbox domain and the approval posture are the **same** as the CLI path, not relaxed: the sandbox maps onto the same `read-only | workspace-write | danger-full-access` values and an unattended lane keeps the CLI-equivalent, non-bypass approval posture (no auto-approve weakening; a blocking approval ⇒ `blocked` + report). Gateway logs (24 h prune) are exported to `workspace/<task-id>/evidence/` at lane start.

Mechanism contract + per-gate evidence commands: `guides/codex-plugin-lane-contract.md`. Test surface: `scripts/tests/spawn-lane-plugin.test.mjs`.
---

## 4. How to run

```bash
# Rehearse (validate + print the command; zero side effects)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 linus --dry-run

# Start a lane (defaults: seg=seg1, backend=claude)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 linus
# A continuation segment = a new session on the SAME card branch/tree (no new branch, no `-b`)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 jobs seg=seg2 phase=seg2-ui
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 turing backend=codex

# Review lane on an in_review card (defaults: seg=segR1, backend=codex)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 turing --review backend=codex

# Opt out of the session reaper (you then own task.session-close before your turn ends)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 linus --no-reaper      # = OPENCLAW_TEAM_REAPER=0
# Codex plugin lane (official app-server harness; two-step registration — §3.1)
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 turing backend=codex harness=plugin --dry-run
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 turing backend=codex --plugin

# Interactive lane (opt-in): host decides permissions by policy; questions escalate to the board
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 linus --interactive
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 turing backend=codex interactive=1
bash ~/.openclaw/team/scripts/spawn-lane.sh T-20261010-052210 linus --interactive --dry-run   # prints host cmd + backend_cmd
```

- The **last stdout line is JSON** `{ok, role, settings, session_id, pid, cwd, handoff, log, cmd, …}` for machine reading.
- Exit codes: **0** started (or dry-run OK) · **1** refused (validation/handoff/claim/cap) · **2** usage error.
- Refusal reasons are stable and greppable, e.g. `claimed_by_mismatch(…)`, `concurrency_cap(owner=…,running=…,cap=…)`, `handoff_anchor_missing:…`, `status_not_spawnable(…)`, `card_busy(…)`, `session_running(…)` (`§7`).
- After starting a lane you **still own polling it to terminal state** (`R-SESSION-1` clause 4); the entry does not take over polling. You do **not** own the session's terminal *registration* any more: step 10's reaper writes it when the lane's process ends (`lane-session-lifecycle-sop.md`).
---

## 5. Detach discipline (macOS)

The entry starts the child as a **new session detached from the parent process group** — in Node that is `spawn(bin, args, { detached: true })` + `unref`, the portable equivalent of Python `subprocess.Popen(…, start_new_session=True)`. **Do not** use `nohup … &` (it gets reaped when the parent turn ends) and **there is no `setsid` on macOS** (`R-SESSION-1` clause 3 note).
---

## 6. How the gates back this up

- `scripts/check-sessions.mjs` — two-way card↔registry comparison; `registry_only` / `card_only` are hard failures (a bypass lane that only wrote the registry is caught here). Its `note`s (the drift class: `status_mismatch` / `stale_card_line` / `zombie_registry`) are collected by `scripts/session-reconcile.mjs` (`lane-session-lifecycle-sop.md` §6); the live claiming surface no longer acts on them — poll refuses to re-claim such a card (same SOP, §3).
- `scripts/check-handoff.mjs` — validates the four anchors for **two** populations: ① every registered `running|closed` seg, and ② **any `in_progress|in_review` card whose `handoff.md` already exists** — so a hand-written handoff left by a direct launch is caught **before or after** its seg is registered.

Both gates are aggregated by `scripts/check-all.sh`; a bypass lane therefore cannot stay invisible on the board.

`check-sessions` also judges **liveness** with the plugin lane in mind: a Codex plugin row/entry (`harness:plugin`) is alive when its **native thread is reachable**, not when a pid is — a row without a `harness:` segment is read as `cli` (backward compatible), so historical rows keep their old meaning.
---

## 7. When the entry refuses

- **`handoff_anchor_missing:…`** — the existing `handoff.md` is hand-written/stale. Regenerate it through the ACL (back up the old file first if it holds anything you need), then re-run the entry. Do **not** hand-edit anchors in.
- **`session_running(seg=…,pid=…,id=…):reuse_existing`** — the same card + same `seg` already has a **live** session. Do **not** start a second one: resume the existing session in the host's exact form (§4 / step 7), or wait for it to reach a terminal state. If the pid is genuinely a zombie, reconcile the registry first — the guard stops blocking once the pid is dead.
- **`card_busy(seg=…,live=…):second_exec_lane`** — this card already has a **live** lane (any seg) and you asked for another **execution** lane: that is a second concurrent execution turn on one card. Do **not** reach for a different `seg` to get around it — a different seg is still the same card branch/worktree. Either **wait** for the running lane, or, if the work is genuinely parallel, **split it into separate cards** (or serialize). `parallel=1` no longer exists. If you merely intended to review, use `role=review` (§9).
- **`duplicate_running_lane`** (registry write, not a spawn refusal) — a registration with **no pid** was refused because the same lane (`task_id`+`owner`+`session_id`) already has a **live** running row. The live row is kept untouched. Register with a real `pid=` (that is what `spawn-lane` always does), or close the lane instead of re-registering it.
- **`concurrency_cap(…)`** — you are at your cap (`R-SESSION-1` clause 2 / `R-PARALLEL-1` parallelism-first). Finish or reconcile an existing lane first; do not raise the cap.
- **`claimed_by_mismatch` / `status_not_spawnable(…)`** — the card is not yours to run (or is not in a spawnable state); take it through the board flow in `R-BOARD-1`.
- **`status_not_spawnable(in_review):use_role=review`** — you ran an **execution** lane against an in-review card. If you meant to review it, re-run with `role=review` / `--review` (§9); otherwise wait for the reviewer.
- **`review_needs_in_review(status=…)`** — a review lane (`role=review`) was pointed at a card that is not `in_review`.
- **`review_seg_taken(seg=…,owner=…):use_seg=segR1`** — a review lane was given a `seg=` that already belongs to another owner on this card. Reusing it would **overwrite that owner's `## Sessions` row** (the card's upsert key is `seg:<seg> ·`); drop `seg=` (default `segR1`) or pass a fresh one (§9).
- **`review_needs_quiet_card(live=…)`** — the card still has a live lane (an execution lane finishing, or another reviewer). A review must start only after the execution lane has ended; retry shortly. The pin is captured at spawn, so starting earlier would risk reviewing a moving tree.
- **`review_branch_missing(branch=…)`** — the card is `in_review` in a git repo but the card branch does not exist yet (nothing committed to review). Commit the implementation first; a review lane cannot pin an uncommitted tree.
- **`legacy_branch_ambiguous(candidates=…)`** — the card has **more than one** legacy execution branch (`<card>-segN`) and no `<card>` branch. Reconcile them manually (merge/rename to `<card>`, or delete the stale one) before spawning; the entry will not silently pick one.
- **`legacy_not_ancestor(branch=…)`** — `<card>` exists **and** a legacy `<card>-segN` exists that is not contained in `<card>`; continuing would silently lose the legacy commits. Merge/rebase the legacy branch into `<card>` first.
- **`card_id_not_branch_safe`** — the card id contains characters that would be sanitised in a branch name, so the merge gate could not attribute the branch back to the card. Fix the card id at the provider; do not work around it.
- **`removed_arg:parallel`** (usage, exit 2) — `parallel=1` was removed. Split the work into cards or serialize; do not re-add a bypass.
- **`review_plugin_unsupported`** (usage, exit 2) — `role=review` with `harness=plugin`; the plugin harness has no equivalent read-only constraint yet. Use `harness=cli` for review lanes.
- **`review_interactive_unsupported`** (usage, exit 2) — `role=review` with `interactive=1`; the interactive host does not yet carry the review settings/sandbox, so read-only cannot be guaranteed. Run the review as a non-interactive CLI lane.
- **`interactive_unsupported_harness(plugin)`** (usage, exit 2) — `harness=plugin` cannot be combined with `interactive=1` in v1. Use `harness=cli`.
- **`interactive_unsupported_cli(backend=…)`** (exit 1) — the installed CLI lacks the required flag/subcommand (`claude --permission-prompts`/`--permission-prompt-tool`, or `codex app-server --stdio`). Nothing was started; pin a supported CLI version (`R-SESSION-1`) or use a non-interactive lane.
- **`policy_load_failed:<reason>`** (exit 1) — the interactive policy file is missing/invalid (`default` must be `deny`). Fix `OPENCLAW_LANE_POLICY` or `<TEAM>/lane-policy.json`; do not start with a permissive fallback.
- **`interactive_prompt_unwritable:<path>`** (exit 1) — the 0600 prompt file could not be written. Check the workspace permissions; nothing was spawned.
- **`host_ready_timeout(seg=…,ms=…)` / `interactive_host_failed:<reason>`** (exit 1) — the host never completed the backend handshake, or reported a failure before ready. The session row is already closed as `failed` and the host was terminated; inspect `<owner>-<n>.err.log` / `state_file`, reconcile the registry, then retry.
- **`unknown_harness:<v>`** (usage, exit 2) — `harness=` was given a value outside `cli|plugin`. Nothing was started or written; use `harness=cli` (default) or `harness=plugin`.
- **`harness_plugin_requires_codex(backend=<b>)`** (usage, exit 2) — `harness=plugin` was combined with a non-codex backend. The official embedded harness exists for the **Codex leg only** (`claude`/`pi` have none) — run the lane as `backend=codex`, or drop `harness=plugin` (§3.1).
- **`thread_bind_timeout(seg=…,ms=…):reconcile`** (exit 1) — a plugin lane never reported its native thread id within `THREAD_BIND_TIMEOUT_MS` (default 120 s). The lane is marked `failed` and its dispatcher terminated; **do not** start a replacement blindly — reconcile the registry entry first, then re-run the entry (§3.1).
- **`lane_reaper_failed(…)`** — the session reaper (step 10) could not be started, so the entry refused to run the lane and already closed the row it had registered (fail-closed: no lane is left running without an owner for its terminal write). Re-run the entry; if it keeps failing, check that the reaper can be spawned at all (node executable, `TEAM_ROOT` writable) — and do **not** work around it with `--no-reaper` unless you are taking the close over yourself (`lane-session-lifecycle-sop.md` §4).
- Any refusal that looks wrong ⇒ report to Elon with the JSON envelope; do not work around the entry by launching directly.
---

## 8. Same-repo concurrent lanes ⇒ the lane isolates itself

Two lanes must never share one checkout: multiple writers in a shared working tree corrupt each other's verification (061638 O2: an external lane's `b359780` mixed into an `in_review` snapshot — detected by content forensics, 27,807 B ≠ 18,432 B) and can sweep foreign hunks into a commit (`R-SESSION-1`).

**The entry no longer performs the isolation** (`R-WORKTREE-1`). It resolves cwd from the card's `project` + `target` (`§3` step 4), resolves the **git environment** (`repo` / `nogit` / `unresolved` via `git rev-parse --is-inside-work-tree` + `--show-toplevel`), and stops there — cwd is always the repo root. The **lane** sets up or re-enters its tree through the `using-git-worktrees` skill, and the prompt carries what the skill cannot know:

- the **authorisation** (its Step 0 would otherwise ask the *user*, which a headless lane cannot answer);
- the **branch name** — **`<card-id>`**, one branch for the whole card (all segments reuse it; `seg` is not part of the name);
- whether this is a **first entry** (create the branch/tree from the integration branch with `-b`) or a **continuation** (enter the existing `.worktrees/<card-id>`; never `-b`, never re-base);
- the **absolute worktree path** (`<show-toplevel>/.worktrees/<card-id>`), so the tree lands where `check-merge.mjs` scans;
- for a **non-git project** (`nogit`): no branch or tree — work directly in the project root;
- for an **unresolved** git environment: do not guess; confirm `git rev-parse --is-inside-work-tree` and report blocked if it fails.

```bash
# Rehearse what the lane will be told (zero side effects):
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> <owner> --dry-run
```
The printed prompt's last line is the Report target; the workspace paragraph just above it names the branch and the base (the integration branch).

**Why the base needs no derivation any more**: on **first entry** the base is the skill's implicit `HEAD`, and the main checkout sits on the **integration branch** (`dev` by default, `OPENCLAW_TEAM_INTEGRATION_BRANCH`; `R-WORKTREE-1`) — so `HEAD` *is* that branch. After that, a **continuation** segment re-enters the same branch and tree; there is **no merge between segments** and no intermediate sync of `dev`. **Rework of an unmerged branch stays in the same worktree.** `scripts/check-merge.mjs` enforces the single card-level merge at closeout (`§7` of the companion guide).

Same-file conflicts are no longer a spawn-time refusal: two lanes now work in separate trees and would collide at merge, so `scripts/samefile-guard.mjs` reports the overlap as a **warning** and the owner sequences the cards (`R-PARALLEL-1` case ②). Serialize when the card says so or `depends_on` is unmet.

**Sequence, naming, and cleanup**: `guides/dev-worktree-flow-sop.md`.
---

## 9. Review lanes (`role=review`) — the single entry, not a side registry

**Ruling: a review lane goes through this same single entry with `role=review`** (`--review` is equivalent). It is **not** registered on a separate surface.

Why the "separate registration surface" is not an option: a review lane is still a live sub-session, so it must appear **on both sides at once** — the card's `## Sessions` row *and* the team registry. The ACL `task.session-set` is the only thing that writes both in one step, and `check-sessions` treats "active on one side, missing on the other" as a hard failure. A registry-only surface (e.g. `turing-runs.json`) therefore reproduces exactly the `registry_only` / `card_only` breakage this entry exists to prevent.

```bash
# review lane on an in_review card (Turing reviews with codex)
bash ~/.openclaw/team/scripts/spawn-lane.sh <card> turing --review backend=codex
```

- **State gate**: `status` must be `in_review`; anything else ⇒ `review_needs_in_review(status=…)`.
- **No claim, no ownership assertion**: the entry does not call `task.claim`, does not touch `claimed_by`, and does not assert `claimed_by == <owner>`. The reviewer is **not** the implementer — asserting ownership here would refuse every legitimate review.
- **A review lane is not a second execution turn, and it does not run beside one**: `runningLaneBlocker` L2 applies to `role=exec` only, but `spawnLane` adds a stricter **quiet-card** gate — the card must have **no other live lane** (`review_needs_quiet_card(live=…)`). The reviewer therefore reads a stable tree; retry shortly after the execution lane exits. L1 still applies — a review lane must not reuse the execution lane's `seg`.
- **A review lane creates no branch and no worktree.** It re-enters the card worktree (`.worktrees/<card-id>`) read-only, pinned to the card-branch tip captured at spawn (`review_sha`). If the worktree is missing it re-attaches with `git worktree add <path> <branch>` (no `-b`); if the branch is missing in a real repo the entry refuses (`review_branch_missing`). It never commits, never runs `checkout/reset/restore/stash/clean`, and reads with `git show <pin>:<path>` when the tree is dirty or HEAD differs from the pin.
- **Read-only is machine-enforced**: claude review uses `settings.review.json` + `--permission-mode dontAsk --permission-prompts none` (allowlist includes only read tools, read-only git, and `Edit(//<abs>/review-report.md)`); codex review uses `--sandbox read-only -o <ws>/review-report.md`. The final message is the complete review report.
- **Report location**: `workspace/<task-id>/review-report.md`, never the implementer's `report.md`.
- **Everything else is unchanged**: concurrency cap (turing < 3), cwd resolution, the four-anchor handoff self-check, the deterministic session id, the detached spawn, and the card+registry write in one step.
- **`seg` defaults to `segR1`** and must differ from the execution lane's seg. The card's `## Sessions` upsert key is `seg:<seg> ·` (not owner-scoped), so a review lane reusing the execution lane's `seg1` would **overwrite the execution lane's row** and destroy the audit trail of who implemented it. If you pass a `seg=` already held by another owner, the entry refuses with `review_seg_taken(seg=…,owner=…):use_seg=segR1`. This matches the pre-existing convention for review segs (`segR1-replay`, `seg2-container`, …).
- Output JSON carries `role: "review"`, `branch`, `branch_source`, `review_sha`, and `review_readonly` (`settings` | `sandbox`) so a caller can tell the lanes apart and see what was pinned.
---

## 9.1 Workspace settings preset (`settings: exists | created | would_create`)

`claude` is launched with `--settings workspace/<task-id>/.claude/settings.json`, and **the file is a preflight requirement**: if it is missing, the lane dies at once with `Settings file not found` (the spawn "succeeds" — a pid exists — but the session is dead on arrival, and the registry then holds a zombie). So the entry presets it **before** spawning:

- path exists ⇒ `settings: "exists"` — **never overwritten** (a card's own customisations survive);
- missing and `--dry-run` ⇒ `settings: "would_create"` — nothing written;
- missing and real run ⇒ the entry `mkdir -p`s `workspace/<task-id>/.claude/` and writes the default allow-list (read/write/edit + common `Bash(...)` entries) ⇒ `settings: "created"`.

**Review lanes use a separate file**, `settings.review.json`, generated the same idempotent way. It is the
`dontAsk` allowlist described in §9. The two files never overwrite each other, so a card can host an
execution lane and a later review lane without either inheriting the other's permissions.

The preset is idempotent and side-effect-free under `--dry-run`, and it is done for every backend (for `codex`, which takes no `--settings`, the file is simply inert).
---

## 10. Model and reasoning-effort selection (`R-MODEL-1`)

> Method home for `R-MODEL-1`. `R-MODEL-1` keeps the tier rule; this table carries the selection detail.

| Situation | Model | Reasoning effort (thinking) |
|---|---|---|
| Routine/templated/simple repetitive tasks (e.g. routine collection, simple CRUD, doc cleanup) | `deepseek-flash` | `off`/`minimal` |
| Medium complexity (multi-step logic, routine dev/test/cleanup) | `deepseek-flash` | `low`/`medium` |
| High complexity (architecture design, hard bug localization, long-chain reasoning, domain modeling, complex regression) | `deepseek-v4-pro` | `medium`/`high` |
| Highest complexity (cross-module refactor, root-cause investigation, solution design) | `deepseek-v4-pro` | `high`/`max` |

Rules:

1. **Default flash**; upgrade to pro only when judged "complex reasoning insufficient"; after upgrading to pro, if the task turns out to still be simple, fall back to flash — do not waste.
2. Implementation: a worker specifies `--model` (Claude Code) or the subsession model parameter (codex) when spawning; or switches via OpenClaw session model/thinking override. **A worker does not change `openclaw.json`'s primary on its own**.
3. When image/vision is needed (design drafts, UI screenshots, chart analysis), use `deepseek-flash`.
4. Write the decision rationale into the Report ("used model X / reasoning effort Y, because…"), for traceability.

> Scope: the table applies equally to Jobs/Linus/Turing, **with no role exceptions** (all workers default to flash, upgraded to pro by complexity). Elon (main) is the orchestrator and is not covered by the table; its agent default tier is likewise `deepseek-flash`, and when strong reasoning is needed it upgrades temporarily through the same session-level override / `--model` mechanism.

## 11. Isolation is the lane's own act (`R-WORKTREE-1`)

**There is no automatic isolation in this entry any more** (`T-20261016-`). The entry resolves cwd
from the card's `project` + `target` (`§3` step 4) and stops there: **cwd is always the repo root**.
The lane sets up its own tree through the `using-git-worktrees` skill — git fallback
`git worktree add <abs-worktree> -b <branch> <integration>` on **first entry** — and the prompt
carries the authorisation, the branch name (`<card-id>`), the absolute tree path, and whether this
is a first entry or a **continuation** (re-enter the existing tree, no `-b`), none of which the skill
can infer.

What this removed, and where it went:

| removed | now |
|---|---|
| `lane-isolation.mjs` decision + `isolation.*` output | nothing — no decision to make; the lane always isolates itself |
| `lane-worktree.mjs` create/reuse/remove | the lane's `using-git-worktrees` git fallback |
| same-file ⇒ **refuse to start** (`lane_samefile_conflict`) | `scripts/samefile-guard.mjs` **warns**; the owner sequences the cards (`R-PARALLEL-1` case ②) |
| `--base` / `OPENCLAW_LANE_BASE` derivation, `base_*` refusals | on first entry the base is the skill's implicit `HEAD`, and the main checkout holds the integration branch ⇒ `HEAD` *is* it; later segments reuse the card branch (`R-WORKTREE-1`) |
| `--no-isolate` / `OPENCLAW_LANE_ISOLATION=0` | gone — there is no automation to switch off |

**The obligation the derivation used to carry does not disappear, it moves to closeout**: every
segment re-enters the **same** card branch and worktree — there is no merge between segments — and
the card branch is merged **once** before `done`. Rework of an unmerged branch stays in the same
worktree. `scripts/check-merge.mjs` enforces the card-level merge at closeout; its residual limits
are in `R-GATE-2`.

Sequence, naming, cleanup and the openclaw↔claude collaboration model: `guides/dev-worktree-flow-sop.md`.

> **Implementation & deploy notes.** Most of the above is **method-library level**, but the
> **one-branch-per-card rule** and the **removal of `parallel=1`** change `R-WORKTREE-1`'s normative body and
> require rule edits to `R-SESSION-1` clause 8, `R-PARALLEL-1` case ②, `R-SEGUSE-1`, `R-GATE-1` and `R-GATE-2`; the
> `R-WORKTREE-1` body itself lives in `guides/dev-worktree-flow-sop.md`. The Codex plugin leg (§3.1) also
> touches `R-SESSION-1` clauses 2/3/8, the board `## Sessions` schema comment and `R-DISC-2`. Sections touched: §1 (entry signature), §3 + §3.1 (double-run guard; plugin two-step backfill), §4, §6 (liveness in the gate), §7 (refusal codes), §8 + §11 (isolation / base). They implement `R-SESSION-1` execution uniqueness, `R-PARALLEL-1` (serialize vs isolate), `R-WORKTREE-1` (base snapshot), `R-UI-1` (single writer per file) and the registry single-source-of-truth.
> - **Dispatch discipline**: every direct wake-up goes through `task.dispatch` — claim-first on the same lock/primitive as poll; a failed claim ⇒ `dispatched:false` ⇒ **no** `sessions_send`. The single enforcement point for "no second execution turn on a card" is **this entry** (a turn must not spawn a lane for a card another turn is already executing). This closes the "Elon direct dispatch vs poll claim" race; dispatch-side discipline (`task.dispatch`, never a bare `sessions_send` that bypasses the claim) is unchanged and remains the rule.
> - **Deploy note**: `scripts/registry.mjs` is imported by the provider ACL (`task.sessionSet` / `sessionClose` write the registry **through this file**), so the lane-identity dedupe + `duplicate_running_lane` refusal (and the `check-sessions` soft `duplicate_lane` note) take effect only **after the changed files are deployed to the live team dir** (`install.sh`) — not by the repo commit alone.
> - **Tests / response guides**: the contract suites `tests/spawn-lane.test.mjs` (including the `buildPrompt` isolation-contract cases), `tests/registry-lane-identity.test.mjs`, `tests/spawn-lane-plugin.test.mjs`; response for the worktree flow is `guides/dev-worktree-flow-sop.md`, for the merge invariant `scripts/check-merge.mjs` (`R-GATE-1`), for the plugin leg `guides/codex-plugin-lane-contract.md`.
