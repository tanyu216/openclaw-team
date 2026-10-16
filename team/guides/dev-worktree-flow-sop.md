# Dev Worktree Flow SOP (`dev-worktree-flow-sop.md`)

> **Ownership / Maintainer**: **Linus** (engineering) owns the flow and this guide; **Elon** owns
> dispatch and acceptance.
> **Status**: method library (`L2.5`). The **normative clauses** live in `PROTOCOL §⑥.4`
> (development-branch and worktree discipline), `§⑥.3` (parallelism-first) and
> `§⑳.1`/`§⑳.2` (what is machine-checked and what is *not*). This file **references** them and
> does not copy their text (`PROTOCOL §⑥.1` clause 11).
> **Applies to**: every development card whose work lands in a git checkout this framework manages.
> **Replaces**: `worktree-isolation-sop.md` (deleted 2026-10-16 with the mechanism it documented).

---

## 1. Two layers — who decides what

The flow has exactly two layers, and they own disjoint things. Most confusion about this flow comes
from asking one layer to do the other's job.

| | **spawner** (`scripts/spawn-lane.mjs`) | **lane** (headless `claude -p`) |
|---|---|---|
| runs | **before** the agent exists | after the spawn |
| owns | claim · handoff self-check · workspace settings · cwd (= **repo root**) · session registration · the session reaper · the initial prompt | the **worktree** · the commits · the Report |
| cannot | know where the lane will put its tree, or what it will name the branch | claim the card, register the session, or extend its own concurrency budget |

**Why the worktree belongs to the lane layer.** The `using-git-worktrees` skill's Step 0, when the
cwd is not already a linked worktree, asks *the user* for consent
("Would you like me to set up an isolated worktree?"). A lane is a **headless** `claude -p` process:
there is no user to answer. The skill also says *"Honor any existing declared preference without
asking"* — so the preference has to arrive **in the prompt**. That is the entire integration, and it
is why `buildPrompt` carries the authorisation and the branch name:

- **authorisation** — "set one up before you start — you are authorised, do NOT ask for consent";
- **branch name** — `<card>-<seg>`, which the merge gate later uses to attribute the tree to a card.

A native worktree tool, when the harness provides one, takes precedence inside the skill (Step 1a);
the framework supplies no such tool today, so lanes use the skill's git fallback (Step 1b).

**Layer boundary worth restating**: the spawner used to decide *whether* to isolate and *where to
branch from*. It no longer does either (`PROTOCOL §⑥.4`). What it still guarantees is that the lane
starts in the repo root with an unambiguous card, a handoff pack, settings, a registered session and
an owner for the terminal write.

---

## 2. One lane, end to end

| # | step | who | enforcement |
|---|---|---|---|
| 1 | card dispatched (`todo`/`ready` → claimed) | Elon / poll | **machine** — claim is atomic (`lib.mjs#claimCard`) |
| 2 | `spawn-lane.sh <card> <owner> [seg] [backend]` — claim → handoff → settings → spawn → `session-set` → arm reaper | spawner | **machine** — any failure refuses the spawn (zero side effects) |
| 3 | lane reads its prompt: authorised to isolate · branch `<card>-<seg>` · base `dev` | spawner → lane | **machine** — the prompt is generated (`buildPrompt`) |
| 4 | lane creates/enters `.worktrees/<branch>` | **lane** (`using-git-worktrees`) | **prose** — the skill instructs it; nothing verifies it happened |
| 5 | work; commits use **explicit paths** | lane | **prose** + `commit-guard.mjs` (SOP-invoked, not a git hook) |
| 6 | Report written: conclusion · branch · commit sha · **merged sha** | lane | **machine (partial)** — `check-report.mjs` checks slot *presence* only; the merged sha is not a checked slot |
| 7 | owner merges the card branch into `dev` | lane owner | **prose** |
| 8 | Elon accepts: confirms the merge landed, records the merged sha, sets `done` | Elon | **prose** — the `done` write is *git-blind* (ACL requires only actor + non-terminal) |
| 9 | gate re-checks: a `done` card's worktree must be an ancestor of `dev` | gate | **machine** — `check-merge.mjs` (`PROTOCOL §⑳.1`) |
| 10 | worktree removed | owner | **prose** — and only **after** the merge |

**The order in steps 7–10 is the load-bearing part.** "Merge, *then* remove" is not tidiness: a
removed worktree is invisible to `check-merge.mjs`, so removing first silently converts step 9 from a
check into a no-op (`PROTOCOL §⑳.2`).

### Continuation and rework

Because the base is the skill's implicit `HEAD` and the main checkout holds `dev` (`PROTOCOL §⑥.4`),
`HEAD` **is** `dev`. Two rules follow, and both replace machinery that used to exist:

- **A continuation segment may only start once the previous segment's branch is merged into `dev`.**
  Otherwise its tree is built on a `dev` that lacks the earlier segment.
- **Rework of an unmerged branch stays in the same worktree.** Sending a card back for changes is not
  a reason to build a second tree on a base that lacks the first one's commits.

Both are prose, and step 9 is what makes them bite: an unmerged branch cannot reach `done`.

---

## 3. Worktree landing spots — three exist, only one is ours

| | location | created by | in this repo |
|---|---|---|---|
| **this flow** | `<repo>/.worktrees/<branch>` — **inside** the repo | the lane, via the skill's git fallback | ✅ the only sanctioned spot |
| the skill's own default (Step 1b) | same path | same | ✅ — the flow and the skill **agree**; no reconciliation needed |
| a harness-native tool (e.g. `EnterWorktree`) | `.claude/worktrees/` — elsewhere | the harness | ❌ not used; no lane has such a tool |

`.worktrees/` is **pre-ignored** in `.gitignore`. That matters twice: the skill's Step 1b *mandates*
that the directory be ignored before it will create a tree in it (otherwise the whole tree gets
committed), and pre-ignoring removes a race — several lanes starting at once would otherwise each
edit `.gitignore` and commit that edit onto the shared repo root.

---

## 4. Closure strength — what is actually enforced

This table is the point of the guide. Read it before trusting any claim that a step "is gated".

| obligation | strength | mechanism / gap |
|---|---|---|
| a lane runs through the single entry | **machine** | `spawn-lane.sh`; the poll hand-off names it |
| one execution lane per card | **machine** | `runningLaneBlocker` (`card_busy`) |
| handoff pack exists with its four anchors | **machine** | `check-handoff.mjs` |
| session终态 write happens even on crash | **machine** | `lane-reaper.mjs` (fail-closed arm) |
| the Report carries its core slots | **machine** | `check-report.mjs` — **slot presence only**, not semantics |
| the Report names the branch / merged sha | **prose** | slot A2 carries them as free text; no check reads them |
| the lane actually created a worktree | **prose** | the skill instructs it; nothing verifies |
| the branch was based on `dev` | **prose** | follows from the main checkout's branch; unverified per lane |
| the branch is merged into `dev` before `done` | **machine (partial)** | `check-merge.mjs` — see the gaps below |
| same-file write conflict ⇒ serialized | **machine (warn only)** | `samefile-guard.mjs` reports; nothing blocks a start |
| no direct commit on `main` | **prose** | `branch-guard.mjs` is SOP-invoked, not a git hook |

**`check-merge.mjs` is a net, not a wall.** Its four structural gaps (`PROTOCOL §⑳.2`): a removed
worktree is invisible; a branch name that does not carry the card id escapes attribution; it covers
only "not merged", not whether the merge was any good; and a merged result can be reverted afterwards.
The invariant therefore remains **prose-enforced at the moment `done` is written** — the gate is the
backstop for that discipline, not a replacement for it.

---

## 5. openclaw ↔ Claude Code: who can see which skills

The two harnesses load skills from **different faces**, and the boundary is not inferable from the
repo layout — it is set by `skills/manifest.json` `targets` and consumed by `skills/fetch.mjs`:

| `targets` entry | installs to | loaded by |
|---|---|---|
| `claude` | `~/.claude/skills` | **Claude Code** — i.e. every lane spawned as `backend=claude` |
| `agent:linus` / `agent:jobs` / … | `~/.openclaw/workspace-<role>/skills` | that OpenClaw agent's own sessions |
| `openclaw` | `~/.openclaw/skills` | the OpenClaw-global skill face |
| `codex` | `~/.codex/skills` | the codex backend |

**Consequence for this flow**: a skill that the *lanes* must use has to be declared with
`targets: ["claude"]`. `using-git-worktrees` is registered exactly that way — and only that way,
because it is written for the Claude Code harness. Declaring it for `agent:*` would install text that
no OpenClaw agent can act on.

The reverse also holds: a lane does **not** see the `agent:*` or `openclaw` faces. If a lane's work
depends on an OpenClaw-agent skill, that dependency is not satisfied by installing the skill for the
agent — declare it for `claude` too, or the lane will run without it.

---

## 6. Related

- `PROTOCOL §⑥.4` — the clauses (branch, base, merge-before-`done`, protected branch).
- `PROTOCOL §⑳.1` — the gate registry (`check-merge.mjs` is registered there).
- `PROTOCOL §⑳.2` — what is deliberately **not** machine-checked, including this flow's residue.
- `guides/spawn-lane-sop.md` — the entry itself (§8, §11).
- `guides/worktree-…` — **deleted**; this guide is its replacement.
