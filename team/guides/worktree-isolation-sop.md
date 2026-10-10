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
- **The dispatch surface is the card's `target`.** `scripts/spawn-lane.mjs` resolves the lane's cwd from `project` + `target` (`PROTOCOL §⑥` cwd normalization); pointing `target` at the lane worktree is therefore the *whole* wiring — no new spawn path, no changed `spawn-lane.mjs` behaviour.
- **Non-terminal** = the four in-flight states that can still write: `todo`, `in_progress`, `blocked`, `in_review` (`done`/`canceled` are terminal). `blocked`/`in_review` still hold uncommitted work — the 061638 O2 incident was exactly an `in_progress` writer (063151) landing in a checkout an `in_review` verification (R26) was reading.
- **Decide before you start, not after.** The signal is already on the board: `scripts/samefile-guard.mjs` reports overlapping write-sets across non-terminal cards (`guides/task-interface.md` `writes`, falling back to `target`). An overlap ⇒ **isolate (this SOP) or serialize (`PROTOCOL §⑥.3` case ②)**.

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
| `base` | `HEAD` | Override with `--base <ref>` for a pinned snapshot; record the resulting sha (it is echoed as `head`). |
| `lane` | — | One path-safe segment: `[A-Za-z0-9][A-Za-z0-9._-]*` — **no `/`, no `..`** (path traversal is rejected). |

- **One lane = one worktree = one branch.** Do not put two lanes in one worktree; that reintroduces the shared-checkout hazard inside the isolation.
- **The base is a snapshot, not "whatever main is now".** For verification, pin `--base <sha>`; the `head` field in the JSON is the evidence of what was actually checked out.

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

## 7. Closeout / cleanup discipline

- **Commit in your own worktree** with explicit paths (`PROTOCOL §⑥` commit-path discipline). A commit made *inside* the lane worktree cannot sweep another lane's hunks — that is the point.
- **`--remove` only when clean.** The entry pre-checks `git status --porcelain` inside the worktree and refuses (`worktree_dirty`) otherwise; it never forces. Uncommitted work is never discarded by this entry — if you want to drop it, that is a deliberate, separate action (`PROTOCOL §⑥` git-operation discipline).
- **`--remove` keeps the branch.** The branch may carry committed artifacts (e.g. `rename/meerkat-taskpanel` @ `c6ead89`); deleting it would be the one destructive step. Deleting a lane branch, if ever wanted, is a separate explicit decision by Elon — never a side effect of cleanup.
- **Re-entrant.** After `--remove` the branch survives, so re-running create **attaches** to it (`branchReused:true`) instead of erroring — idempotent create/remove cycles are safe.
- **Leftover hygiene**: an isolated lane that finishes must not leave a registered worktree behind. `git worktree list` is the audit surface (`scripts/check-all.sh` is not needed to see it — it is one git call).

## 8. Relationship to the existing guards (cross-reference, not replacement)

- `scripts/samefile-guard.mjs` — **detects** the overlap (read-only warning). This SOP is the **remedy** it points at; together they close the loop "warn → isolate".
- `PROTOCOL §⑥.3` — parallelism-first; serialize only for a same-file/same-resource conflict. Worktree isolation is how you keep the parallelism *and* the single-writer invariant.
- `PROTOCOL §⑨.1` — "single writer per file"; a worktree per lane is the mechanism that makes this true *across repos*, not just within one file list.
- `PROTOCOL §⑥` — commit-path discipline and the ban on destructive git both still apply *inside* the worktree.
