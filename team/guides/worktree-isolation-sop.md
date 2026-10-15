# Worktree Isolation SOP (`worktree-isolation-sop.md`)

> **Ownership / Maintainer**: **Linus** (engineering) owns the entry and this SOP; **Elon** owns dispatch (card `target`) and approves exceptions.
> **Status**: method library (`L2.5`). The **normative clauses** live in `PROTOCOL §⑥` (session orchestration) and `PROTOCOL §⑥.3` (parallelism-first / serialize-only cases); this file **references** them and does not copy their text (`PROTOCOL §⑰`).
> **Depends on**: `PROTOCOL §① board` · `PROTOCOL §⑥` · `PROTOCOL §⑥.3` · `PROTOCOL §⑨.1` (single writer per file) · `guides/spawn-lane-sop.md` · `guides/task-interface.md` (`writes`).
> **Applies to**: **every same-repo concurrent lane** — two or more non-terminal cards whose work lands in the *same* git checkout, for Linus / Jobs / Turing.
> **Reference convention**: always write `PROTOCOL §<n> <name>` or `<guide-name> §<section>` — never line-number anchors, never card-number anchors (`PROTOCOL §⑰`).

---

## 1. Rule: same repo + a concurrent lane ⇒ one worktree per lane

- **A shared checkout is single-writer.** When a card's work lands in a repo that **already has a non-terminal lane writing it**, do not work in that checkout. Take a **lane worktree** and point the card's `target` at it:
  ```bash
  node ~/.openclaw/team/scripts/lane-worktree.mjs <repo> <lane> [--branch <b>] [--base <ref>] [--dry-run]
  ```
- **The dispatch surface is the lane's working directory.** `scripts/spawn-lane.mjs` resolves the lane's cwd from `project` + `target` (`PROTOCOL §⑥` cwd normalization); pinning the lane to its own worktree is therefore the *whole* wiring — there is no separate spawn path. Since `T-20261012-022948-2` the entry does that pinning **itself** (§9), so the card's declared `target` no longer has to be edited by hand (and is deliberately **not** rewritten — see §9).
- **Non-terminal** = the four in-flight states that can still write: `todo`, `in_progress`, `blocked`, `in_review` (`done`/`failed`/`canceled` are terminal, and the not-yet-scheduled `backlog` is neither; the single source of truth is the status machine in `scripts/check-card.mjs`, and `scripts/samefile-guard.mjs` + `scripts/lane-isolation.mjs` share that set). `blocked`/`in_review` still hold uncommitted work — the 061638 O2 incident was exactly an `in_progress` writer (063151) landing in a checkout an `in_review` verification (R26) was reading.
- **Decide before you start, not after.** The signal is already on the board: `scripts/samefile-guard.mjs` reports overlapping write-sets across non-terminal cards (`guides/task-interface.md` `writes`, falling back to `target`). An overlap ⇒ **isolate (this SOP) or serialize (`PROTOCOL §⑥.3` case ②)**. Note the two signals are not equally sharp: a **declared `writes`** (or a `target` naming something *inside* the repo) is a file-level claim and can force a **serialize**; a `target` that is just the **repo root** is a *repo designation*, not a write set — it means "isolate", never "you two conflict" (§9).

## 2. Why (field-verified failure modes)

| # | Incident | Evidence |
|---|---|---|
| 1 | **Mixed tree during independent verification** — 061638's Turing run (R26) read a checkout that an external lane had written 25 minutes earlier. | External process committed **`b359780`** (card `T-20261010-063151`, contractsnapshot) at **2026-10-10 07:29:20 +0800**; R26 detected the mixed tree by **mirror-content forensics** — in-container `scripts/verify/contract.mjs` was **27,807 B ≠ 18,432 B** at pinned `7bef38f`. The run was discarded and re-run on a **clean snapshot**. Source: `workspace/T-20261010-061638/report-turing.md` O2. |
| 2 | **Test conclusions drift** when a lane's HEAD moves under a test run — the same command yields different results, misread as flakiness/environment difference. | `T-20261009-235100-taskpanel-testenv` (pin the snapshot / run on a worktree). |
| 3 | **Concurrent writes to the same file + a commit sweeping foreign hunks** — `git commit -- <path>` does not exclude *another* card's unstaged hunks in the same file. | `T-20261009-211234-concurrencyharden` (`952a001` swept `labelspec`'s hunk); hence commit-path discipline in `PROTOCOL §⑥`. |
| 4 | **A checkout held in-flight could not be renamed/re-pointed** — the local-dir rename card had to wait for the writers to drain. | `T-20261010-062341-3` (blocked: 063151 live writer + the linked worktree's `.git` pointer into the main repo). |

⇒ Isolation removes failure mode 1–4 **by construction**: the verifier reads a tree nobody else can write.

## 3. When to isolate (and when not)

**Isolate** when **all** hold:
1. two or more non-terminal cards target the **same** git checkout (same `project`/repo); and
2. at least one of them writes (not mere reads); and
3. they are not strictly serialized by `depends_on` / the card (`PROTOCOL §⑥.3` case ①/③).

**Do not isolate** (pointless overhead, and `PROTOCOL §⑥.3` forbids pointless serialization too):
- single lane on the repo — work in place;
- read-only work (audit, review, measurement) — pin a commit instead and record the sha;
- work that must observe the *live* checkout (e.g. reconcile/registry inspection) — isolate the *writer*, not the reader.

**Anti-patterns (reject on sight)**: a second writer in a checkout already being written | verifying `in_review` against a checkout another lane can write | "it's only one file" when the *file* is shared | `git add -a` / bare commits in a shared checkout (`PROTOCOL §⑥`).

## 4. How to run (the entry)

```bash
# Rehearse — computes path/branch/action, ZERO side effects (no dir, no registration, no repo change)
node ~/.openclaw/team/scripts/lane-worktree.mjs /path/to/repo laneA --dry-run

# Create, or reuse if it already exists (idempotent)
node ~/.openclaw/team/scripts/lane-worktree.mjs /path/to/repo laneA

# Pin the base explicitly (mirrors the manual rename-line worktree at 5d99058)
node ~/.openclaw/team/scripts/lane-worktree.mjs /path/to/repo laneA --base 5d99058

# Clean up — ONLY when the worktree is clean (no uncommitted changes); never --force
node ~/.openclaw/team/scripts/lane-worktree.mjs /path/to/repo laneA --remove
```

- **Last stdout line is JSON** `{ok,repo,lane,path,branch,created,dryRun,…}` for machine reading (dispatch consumes `path` ⇒ the card `target`). Extra keys: `action`, `head`, `existed`, `branchReused`, `cmd`.
- **Exit codes**: **0** ok (or dry-run ok) · **1** refused · **2** usage error.
- **`action`** is the precise outcome: `created` · `reused` · `would_create` · `would_reuse` · `removed` · `would_remove` · `absent`. **`created`** = a worktree was (dry-run: would be) created this invocation; a reuse is `created:false`.
- **Refusal reasons are stable and greppable**: `not_a_git_repo(…)` · `path_exists_not_worktree(…)` · `worktree_path_occupied(branch=…)` · `branch_checked_out(branch=…,path=…)` · `worktree_dirty(…)` · `worktree_detached(…)` · `worktree_branch_mismatch(…)` · `base_unresolved(…)` · `bad_lane(…)` / `bad_branch(…)`.
- **Safety by construction**: the entry uses only git built-ins and **never** passes `--force` (nor `reset`/`clean`/`stash`/`rm -r`). It refuses rather than overwrite: an occupied path, a branch checked out elsewhere, a dirty worktree on `--remove`.

## 5. Naming / branch / base discipline

| Field | Default | Notes |
|---|---|---|
| `path` | `<main-repo-dir>-wt-<lane>` (sibling of the main checkout) | Stable regardless of which worktree you invoke from (resolved via `git rev-parse --git-common-dir`); override with `--path`. |
| `branch` | `lane/<lane>` | Namespaced so it cannot collide with a product branch; override with `--branch`. |
| `base` | `dev` (the integration base, `PROTOCOL §⑥.4`; `OPENCLAW_LANE_BASE` overrides), **except** a continuation spawn ⇒ the previous seg's lane-branch tip (§9) | Override with `--base <ref>` for a pinned snapshot; an unresolvable base is **refused** (`base_unresolved:<ref>`), never silently `HEAD`. Record the resulting sha (echoed as `head`; `isolation.base` says *why* that base was chosen). |
| `lane` | — | One path-safe segment: `[A-Za-z0-9][A-Za-z0-9._-]*` — **no `/`, no `..`** (path traversal is rejected). |

- **One lane = one worktree = one branch.** Do not put two lanes in one worktree; that reintroduces the shared-checkout hazard inside the isolation.
- **The base is a snapshot, not "whatever main is now".** For verification, pin `--base <sha>`; the `head` field in the JSON is the evidence of what was actually checked out. On the **automatic** path a continuation spawn picks the snapshot for you (§9) — you no longer have to pre-build the worktree by hand to get the right one.

## 6. Wiring into dispatch (and consistency with the rename-line practice)

The mechanism is **already in use manually, and this SOP only formalizes it** — so it is *incremental and non-breaking*:

| | Manual instance (existing) | This entry (formalized) |
|---|---|---|
| Repo | `/Users/tanyu/Documents/meerkat-taskpanel` | same |
| Path | `/Users/tanyu/Documents/meerkat-taskpanel-wt-meerkat` | `<repo>-wt-<lane>` — identical for `lane=meerkat` |
| Branch | `rename/meerkat-taskpanel` | `--branch rename/meerkat-taskpanel` reproduces it exactly |
| Base | `5d99058` | `--base 5d99058` |
| Card wiring | card `target` = the worktree path (`T-20261010-062341-2`) | unchanged — the card `target` is still the wiring |
| `spawn-lane.mjs` | — | **unchanged** |

So the rename-line card (`062341-2`, branch `rename/meerkat-taskpanel` @ `c6ead89`) is a **hand-run instance of exactly this shape**; the script's `--dry-run` for that lane returns the same `path`/`branch` pair without touching the repo. Everything the entry adds is a *pre-flight check and a naming convention*, not a new workflow.

Dispatch procedure (Elon) for a same-repo concurrent lane:
1. `samefile-guard.mjs` shows the overlap;
2. `lane-worktree.mjs <repo> <lane> --dry-run` → read `path` (and `head`, for a pinned base);
3. set the card's `target` to that `path`;
4. create it (`lane-worktree.mjs <repo> <lane>`), then dispatch through `guides/spawn-lane-sop.md` as usual — `spawn-lane` resolves cwd to the worktree.

> **Since T-20261012-022948-2 this procedure is a *manual override*, not the normal path.** `spawn-lane.mjs` performs steps 1–4 **automatically** (§9). Do them by hand only when the automatic path is switched off (`--no-isolate`) or when you want a non-default lane/branch/base. **In particular, the base workaround is covered** (T-20261014-112936; default base `dev` since T-20261015-devbranch): pre-building a worktree by hand with `--base <previous-seg-tip>` to continue a card was the only way to avoid the implicit-`HEAD` mis-base — the automatic path now derives that base itself (§9), so the hand-built form is needed only for a base that is **neither** the default base (`dev`) **nor** the previous seg's tip (use `--base <ref>` on the entry).

## 7. Closeout / cleanup discipline

- **Commit in your own worktree** with explicit paths (`PROTOCOL §⑥` commit-path discipline). A commit made *inside* the lane worktree cannot sweep another lane's hunks — that is the point.
- **Merge into `dev` before the card closes (`PROTOCOL §⑥.4`).** What a worktree isolates is exactly what the board cannot see: an unmerged lane branch leaves `dev` — and every future base derived from it — without this lane's product. So the closeout order is **commit (explicit paths) → Report the branch + merged sha → merge `lane/<lane>` into `dev` → Elon's acceptance sets `done`**. `--remove` comes **after** the merge: removing a worktree merges nothing (the branch survives — next bullet), and "the branch still holds the commits" is not delivery.
- **`--remove` only when clean.** The entry pre-checks `git status --porcelain` inside the worktree and refuses (`worktree_dirty`) otherwise; it never forces. Uncommitted work is never discarded by this entry — if you want to drop it, that is a deliberate, separate action (`PROTOCOL §⑥` git-operation discipline).
- **`--remove` keeps the branch.** The branch may carry committed artifacts (e.g. `rename/meerkat-taskpanel` @ `c6ead89`); deleting it would be the one destructive step. Deleting a lane branch, if ever wanted, is a separate explicit decision by Elon — never a side effect of cleanup.
- **Re-entrant.** After `--remove` the branch survives, so re-running create **attaches** to it (`branchReused:true`) instead of erroring — idempotent create/remove cycles are safe.
- **Leftover hygiene**: an isolated lane that finishes must not leave a registered worktree behind. `git worktree list` is the audit surface (`scripts/check-all.sh` is not needed to see it — it is one git call).

## 8. Relationship to the existing guards (cross-reference, not replacement)

- `scripts/samefile-guard.mjs` — **detects** the overlap (read-only warning). This SOP is the **remedy** it points at; together they close the loop "warn → isolate".
- `PROTOCOL §⑥.3` — parallelism-first; serialize only for a same-file/same-resource conflict. Worktree isolation is how you keep the parallelism *and* the single-writer invariant.
- `PROTOCOL §⑨.1` — "single writer per file"; a worktree per lane is the mechanism that makes this true *across repos*, not just within one file list.
- `PROTOCOL §⑥` — commit-path discipline and the ban on destructive git both still apply *inside* the worktree.

## 9. Automatic isolation — when it fires, cleanup, failure fallback (T-20261012-022948-2)

§1–§8 are the **rule and the mechanism**. As of `T-20261012-022948-2` the rule is **enforced by the entry**, not by dispatch discipline: `scripts/spawn-lane.mjs` calls `scripts/lane-isolation.mjs` before starting a lane and isolates **by itself**. (Why: the discipline above was field-verified *not* to hold — `T-20261012-015340 §6.3` (14 non-terminal cards in this repo, 7 `in_progress`; a verification ran green on a tree carrying another lane's uncommitted changes) and `T-20261012-002049` (two live lanes both writing `CHANGELOG.md`).)

**When it fires** — all of:

| # | Condition | Source |
|---|---|---|
| 1 | the lane's cwd resolves into a **git** repo | `git rev-parse --git-common-dir` (a linked worktree resolves back to the *main* checkout) |
| 2 | **≥1 other non-terminal card** resolves into the **same** repo (`todo`/`ready`(legacy alias)/`in_progress`/`blocked`/`in_review`) | board scan (`scripts/lane-isolation.mjs`) |
| 3 | the lane is a **writer** — `role=exec` (a `role=review` lane is a reader: §3) | card role |
| 4 | the lane is **not already isolated** (cwd is not itself a linked worktree) | `git rev-parse --git-dir` ≠ `--git-common-dir` |
| 5 | the switch is on (see *Rollback*) | `--no-isolate` / `OPENCLAW_LANE_ISOLATION` |

**The same-file branch is *not* isolated — it is refused.** If the card's write set (`writes`, else `target`) overlaps another same-repo non-terminal card's, parallelism would only defer the collision to a branch merge, so the entry **refuses to start** (`lane_samefile_conflict(with=…,overlap=…):serialize`, zero side effects) and the lane waits for the other card to reach terminal state — `PROTOCOL §⑥.3` case ②, single writer (`§⑨.1`). Choosing between "isolate" and "serialize" is therefore **not** a dial: same **file** ⇒ serialize, same **repo** other **file** ⇒ isolate.

**Sharp signal blocks; coarse signal only warns.** The fallback write set (`target`) is coarse, and a *shared* coarse value must never be read as a file conflict: on 2026-10-12 **every** non-terminal card in this repo declared `target: <repo root>` and none declared `writes`, so comparing the fallback verbatim would have refused **every** lane on the repo — the whole repo serialized, the opposite of `PROTOCOL §⑥.3`. So the hard decision treats a write-set entry that resolves to **the repo root (or an ancestor of it)** as a *repo designation*: it feeds the "same repo ⇒ isolate" signal and is **excluded from the conflict test**. `writes`, or a `target` naming a path *inside* the repo, remain file-level and can still force a serialize. (`scripts/samefile-guard.mjs` keeps its coarse comparison — it only **warns**; a warning may be blunt, a refusal may not.)

**What the lane gets.** `lane = <card>-<seg>`, `path = <repo>-wt-<lane>`, `branch = lane/<lane>` (the entry's own naming defaults, §5). The entry **does not rewrite the card's `target`**: `target` is the *declaration* (and the fallback write set behind `samefile-guard.mjs`), so writing an absolute worktree path into it would silently disarm the same-file guard for every card that relies on the fallback. The lane's working tree is the §3 *effective* cwd instead, and it is machine-readable in the entry's JSON: `isolation: { mode, lane, branch, path, main_repo, same_repo_lanes, action, applied, base }` (`cwd` equals `isolation.path`). `same_repo_lanes` names the lanes that triggered it — the audit trail for "why was I isolated?"; `base` is the audit trail for "what was this tree built on?" (below).

**Base on a continuation spawn — a continuation is not a fresh start (T-20261014-112936; default base `dev` since T-20261015-devbranch, `PROTOCOL §⑥.4`).** A spawn that **continues an existing seg** (multi-seg work, or a card sent back for rework) must not be built on `HEAD`. An implicit `HEAD` silently drops the previous segment's committed work: on `T-20261013-154930-2` a seg2 lane was built on the then-current `main` — `merge-base --is-ancestor <seg1 tip> → NO`, so the fix would have landed on a tree that did not contain seg1's result — and the only recovery was to kill it, `worktree remove --force` it, and hand-build with `--base 43bdf5f`. The entry now derives the base itself, in this order:

| # | Source | When | Result |
|---|---|---|---|
| 1 | explicit `--base <ref>` | always wins | `base.source = "explicit"`; **an unresolvable ref is refused** (`lane_isolation_failed(base_unresolved:<ref>):serialize_or_fix`) — a pinned base never silently becomes `HEAD` |
| 2 | **previous seg's lane-branch tip** `lane/<card>-<prev-seg>` | the card has a previous seg *and* that branch exists | `base.source = "prev_seg"`, `base.prev_seg = "<seg>"` |
| 3 | default base — `dev` (`OPENCLAW_LANE_BASE` overrides it; `PROTOCOL §⑥.4`) | first seg, or no previous branch to follow | `base.source = "default"`; **refused** if the ref does not resolve in the repo (`base_unresolved:<ref>`) |

The previous seg is found by name first (`segN` continues `seg(N-1)`) and then from the card's `## Sessions` (most recently registered first), which covers non-numeric seg names; **branch existence is the real filter** (a review lane's seg never gets a lane branch, so it is skipped). The branch survives `--remove` (§7), so the previous segment's committed work is exactly what is available as a base. `base` is echoed in `isolation.base` (`{ref, source, resolved, prev_seg}`) and the resolved sha is `isolation.head` — read them to confirm the tree was built where you meant. Two states are reported rather than passed over in silence: a continuation that found **no** previous branch to follow still falls back to the default base (row 3) but says so with `isolation.base.fallback = "no_prev_seg_branch"` — that is your signal that this continuation did **not** pick up the earlier segment's work; and if isolation does not apply at all (single lane, review role, switch off) an explicit `--base` is reported as `isolation.base_ignored`.

This is **method-library level**: it implements this guide's §5 "the base is a snapshot, not whatever main is now" discipline on the automatic path and adds no `PROTOCOL` clause, so no protocol edit is triggered (same posture as the `T-20261012-022948-2` note in `guides/spawn-lane-sop.md`). Evidence: `scripts/tests/lane-continuation-base.test.mjs` (contract, judgement and fulfilment layers — the last one asserts on the *created* worktree, since "computed correctly but not passed through" is only visible there).

**Cleanup (`--remove`).** Unchanged and inside the lane's own tree: the lane commits there, reports the branch + sha in its Report, and the worktree is removed **only when clean** — `worktree_dirty` otherwise; the lane branch is **kept** (it may carry the committed product). Re-entrant: after `--remove`, re-spawning the same lane attaches to the surviving branch (`branchReused:true`). The lane's Report must carry the branch + sha, otherwise the isolated tree's product is invisible to the repo (`PROTOCOL §⑥` doc/commit discipline); the entry puts that sentence in the sub-session prompt.

**Failure fallback — fail-closed, then escalate.** If the isolation cannot be performed (path occupied by a non-worktree directory, lane branch already checked out elsewhere, `bad_lane`, `worktree_add_failed`), the entry **refuses to start** the lane:

- `lane_isolation_failed(<stable inner reason>):serialize_or_fix` (exit 1, zero side effects).

It does **not** quietly fall back to the shared checkout: "could not isolate" read as "green" *is* the failure mode this automation exists to remove. Two legitimate ways out: (**a**) serialize — wait for the other lane to reach terminal state (the same-file path, above); (**b**) fix the obstacle — `git worktree list` / remove the stale directory / re-point the branch, then re-run the entry. Both are deliberate; neither happens behind your back.

**Rollback (switch off).** `--no-isolate` on the `spawn-lane.sh` call, or `OPENCLAW_LANE_ISOLATION=0` (also `off`/`false`/`no`/`disabled`), restores the pre-change behaviour exactly: no detection, no worktree, cwd = `project` + `target`, `isolation.mode = "disabled"` in the JSON. That is the escape hatch for a repo where isolation is not wanted (and the state a regression test pins). Detection is **read-only** either way: the entry writes nothing (no card, no registry) while deciding, and a refusal leaves no worktree behind.
