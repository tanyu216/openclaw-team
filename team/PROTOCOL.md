# PROTOCOL.md — OpenClaw Five-Agent Team Protocol (Single Source of Truth)

> This file is the **single protocol source of truth** for team collaboration. Each agent's AGENTS.md only references section numbers from this file; it does not copy the content.
> Shared area: `~/.openclaw/team/` (the only cross-agent shared path; always reference it by absolute path).
> Revisions: this file is maintained by Elon and the implementer (PROTOCOL ③); agents only read/write data and never change structure.

## Team Roles

| Agent | Role | One-line duty |
|---|---|---|
| Elon (agent:main:main) | CEO / coordinator (sole card creator / sole dispatcher / human-facing) | Breakdown, dispatch, acceptance, reporting; self-organizes non-research notes |
| Jobs | Product design + PRD docs + UI design + UX design + image design (five duties) + **ownership of aesthetics and design style (positioning/selection/unification; sole arbiter)** + UX/UI quality gate | Produce designs via Claude Code / MCP design tools (PRD/specs/DESIGN.md/prototypes/illustrations·logos, etc.); maintain the unified design style guide; product design documents must be reviewed and dual-signed by Elon; personally review and certify interactions |
| Linus | Code development + CI gate + build/release/deploy | Orchestrate ≤8 concurrent Claude Code subsessions |
| Turing | Product testing + security audit | Orchestrate ≤3 concurrent codex subsessions for verification (functional + security); defect tickets; regression retest |
| Assistant | Elon's assistant / odd-jobs executor + marketing·operations·customer support | Video download and video text parsing (dispatched via Elon), speech-to-text (ASR), subtitle OCR and speech cross-alignment, marketing/operations/customer support, and other odd jobs with no clear boundary |

> **Positioning & extensibility**: `openclaw-team` is a **framework for individual developers to quickly stand up a dev team**. The **five roles above (elon / jobs / linus / turing / assistant) are the standard built-ins**. **Roles beyond the five** (e.g. business-specific positions) are **defined/extended by the user** — the framework must not hard-code any instance's extra roles.

---

## ① Board Protocol

> **Task provider (ACL, swappable)**: the task layer of this protocol connects to any task system via the ACL in `guides/task-interface.md`; the **reference implementation** = `meerkat-taskpanel` (`taskctl`), **not a mandatory dependency** (swappable for Jira/Linear/Plane, etc.; connectors/skills/MCP for those systems are user-supplied). All commands below use the reference implementation as an example.

A task card is the sole carrier of persisted content (Goal/Acceptance/Background/Report), stored at `~/.openclaw/team/tasks/T-YYYYMMDD-HHMMSS.md` (flat directory).

**Schema (frontmatter)** — **aligned with meerkat-taskpanel** (`KNOWN_CARD_KEYS`; export key order `CARD_KEY_ORDER`, byte-stable export):

```markdown
---
id: T-20260908-101500          # Card id (team identifier; meerkat-taskpanel also has a project-scoped identifier)
title: One-line title
assignee: linus                # elon|jobs|linus|turing|assistant (only Elon may create cards)
assignee_kind: agent           # agent | human
status: todo                   # Canonical 7 values: backlog|todo|in_progress|in_review|blocked|done|canceled
priority: medium               # low | medium | high | urgent (default medium)
kind: task                     # task | epic (container/aggregate, not claimable)
labels: []                     # Free-form labels + namespaced prefix labels (category:req/dev/test/bug, area:*, env:*, sev:*) — taxonomy: guides/task-interface.md §15 Label Taxonomy; array form (§11)
project: example-app           # ★ Required: project identity code (stable id; resolved via the task-interface ACL to a backend implementation — currently meerkat-taskpanel, swappable for Jira/Linear/Plane); internal chores use the reserved name __team__
target: ""                     # Optional: project-internal location (a repos kind, e.g. code/docs, or a module path)
created_by: elon
created_at: "2026-09-08T02:15:00.000Z"   # ISO-8601 UTC, fixed millisecond width (lexicographic order = time order)
updated_at: "2026-09-08T02:15:00.000Z"
status_changed_at: ""          # Time of the most recent status change (SLA measurement start; see §⑮)
claimed_by: ""
claimed_at: ""
heartbeat_at: ""               # Refreshed every ≤10min while in_progress
blocked_at: ""                 # Time blocked was set (SLA measurement start; see §⑮)
depends_on: []                 # Predecessor card ids (meerkat-taskpanel relation `blocks`; no cycles/no ancestor deps; chain length ≤8; fan-in ≤8)
parent: ""                     # Child card → parent (epic) (relation `parent`; empty = top level; hierarchy depth follows the provider base, meerkat-taskpanel; parents must be epics)
review_of: ""                  # Optional: id of the task being reviewed (UX review; a meerkat-taskpanel known key)
notify_leader: true           # On terminal state, sessions_send back to the leader (coordinator; currently Elon / agent:main:main); the field does not bind a person's name
goal: One-line goal            # Card summary (meerkat-taskpanel known key)
---
## Background        # Distilled by Elon, so a context-free session can execute self-contained
## Acceptance        # Line-by-line `- [ ]`; all must be checked before done
## Progress          # append-only heartbeat/progress (each line timestamped)
## Comments          # Process trail (discuss|decision|confirm|change|note|defect)
## Sessions          # seg→id mapping (subsession details; claude id = deterministic UUIDv5 via `--session-id`, codex id = self-assigned, §⑥ clause 8)
## Report            # Conclusion / Acceptance self-check / verification commands+output / change list / leftovers
```

**Alignment rules (single source of truth = meerkat-taskpanel schema)**:
- **Status (canonical 7 values)**: `backlog | todo | in_progress | in_review | blocked | done | canceled`. Compatible aliases `ready→todo`, `failed→canceled` (also tolerating `in-review`/`in-progress`/`cancelled`) are **resolved only at the boundary and never persisted**; export restores the original word ⇒ old cards stay byte-stable.
- **Claimable status = `todo`** (= the old `ready`); **`backlog` does not participate in claiming**.
- **Priority**: `low | medium | high | urgent` (default `medium`).
- **kind**: only `task | epic`; **do not invent a `review` kind** — use `labels:[review]` + `review_of`.
- **Time columns**: always **ISO-8601 UTC with fixed milliseconds** (`2026-10-08T15:31:25.161Z`).
- **Extension keys**: meerkat-taskpanel **preserves unknown keys verbatim and writes them back** (`meta.legacy`), but self-invented keys (e.g. `git_rules`) are **discouraged**.
- **Serialization invariants**: see §⑪.

**State machine**: `backlog|todo → in_progress → in_review → done` (`canceled` is a terminal state; `blocked` can be entered from any executing state and reverted). (`in_review` = delivered and awaiting Elon's acceptance; `blocked` can be entered from any executing state and reverted). `claimed` is only a transient during the atomic write process; the externally visible state goes straight to in_progress.
- **Terminal irreversibility (frozen, machine-enforced)**: `done` / `canceled` (= the legacy word `failed`) are **terminal and irreversible once entered**. The ACL write layer — `task.setStatus`, the single card-`status` write point — **refuses every write to a card already in a terminal state** for any actor outside `DONE_ACTORS` (Elon `elon`, plus the privileged internal/management path that passes no `actor` key ⇒ sentinel `lib`): `ok:false, reason:terminal_immutable` with `from`/`to`, **and no card write at all** (no `status`, no `status_changed_at`, no turn-lock release). This is the mechanical enforcement of the invariant: it closes the incident in which a worker's concurrent closeout (`report`/`progress`/`comment`/`session-close` **plus `status→in_review`**), arriving **after** Elon's acceptance had already set `done`, silently overwrote the terminal state back to `in_review` (`T-20261012-015421`). Elon's **explicit reopen** (terminal → another state) remains available and is **trailed as a `kind:change` comment** (§⑬.7). Contract detail: `guides/task-interface.md` §3 / §4 / §6.3.
- **`in_review` details**: after delivery, the worker sets `in_review` (thereafter no heartbeat refresh, no re-claim, poll does not fire, duplicate execution turns are not accepted); Elon's acceptance/regression (⑨, ⑨.1) closes within `in_review` — pass ⇒ `done`; fail ⇒ `blocked`/`canceled` or a fix card is opened.

**Atomic claim (meerkat-taskpanel base)**:
1. Read card frontmatter: only continue if `assignee==self && status==todo` (or a stale-recovery condition is met);
2. Atomically occupy the card (the same card cannot be claimed twice; implementation detail is the base's responsibility);
3. On successful occupation → atomically write `status: in_progress` + `claimed_by/claimed_at/heartbeat_at`.
- Stale-occupation self-healing: if an occupation is not completed within 15min → retry claiming if the card is still `todo`; if the card is `in_progress` but the heartbeat has expired (>30min), hand it to the stale-recovery path.
- Stale-claim recovery: `heartbeat_at` older than >30min → the same assignee may re-claim (the executor is considered dead); >6h → any assignee may claim and escalate (escalation = the re-claimer sends sessions_send back to agent:main:main to inform Elon).
- Fresh heartbeat (≤10min) and `in_progress` → **do not touch**; poll returns fire:false.

**Claim timing belongs to poll (key to preventing spin)** : qualifying claims are completed during meerkat-taskpanel's poll trigger evaluation (fire:true ⇔ the card has been moved to `in_progress` with claimed_by=self). Therefore a **run turn does not claim again**: when the card has `claimed_by==self` + a fresh heartbeat → skip claiming and execute directly; only when the turn finds the card still `todo` (e.g. a sessions_send direct dispatch bypassing poll) do you additionally run `taskctl claim`.

**Execution uniqueness (anti-double-run hardening; the claim lock only prevents double-claiming, not double-execution)** : any newly woken turn (cron isolated run / sessions_send direct dispatch to the main session / sessions_spawn turn) that finds the target card already `in_progress` (regardless of whether claimed_by is self and whether the heartbeat is fresh) → **only report status (IN_PROGRESS + claimed_by/heartbeat) or append heartbeat_at, and do not execute again**; only a stale card (heartbeat expired >30min) may be re-claimed and taken over per the recovery rules. The first executor holds execution rights; other turns must not re-spawn claude/codex or repeat side-effecting operations such as writing to the repo.

**Heartbeat**: while executing, refresh `heartbeat_at` every ≤10min (`taskctl heartbeat <card> <assignee>`); append a line (timestamped) to the Progress section, append-only.

**Reporting format (Report section)**: conclusion / Acceptance self-check (line-by-line checklist) / verification commands+output / change list / leftovers.

---

## ② Project Access Rules

- `project` = a **project identity code** (stable id; under the current implementation the project name, e.g. `example-app` / the reserved name `__team__`). Project info is **resolved via the `task-interface` ACL** — root/repos/guides/default git rules come from the project metadata exposed by the ACL, not hard-coded as absolute paths in cards.
- **Swappable backend (ACL abstraction)**: the current `task-interface` implementation binds to **meerkat-taskpanel**; it can later be swapped for Jira/Linear/Plane, etc., with **zero changes to the upper layers** (cards/SOP/duties) — only swap the ACL implementation and run the contract tests (see `guides/task-interface.md §8`). The upper layers **must not** depend on any backend's internal project id.
- **Reading** any registered project file is allowed (read its CLAUDE.md first to learn the conventions).
- **Writing to a project repo** requires all of: the card's `project` is registered + the card's `target`/`git_rules`/delivery intent are clear + project rules are followed.
  - Example `example-app`: based on the dev branch, no destructive git commands (restore/reset --hard/stash/clean, etc.), incremental commits; source and design docs may be **independent dual repos**, executed per the repos boundaries in the project metadata (resolved via the ACL).
- The default working directory is `~/.openclaw/team/workspace/<task-id>/`.
- **Reserved name `__team__`** (exclusively for internal team chores): `lib.get_project('__team__')` **does not query the registry** and always returns `{root: none, writable: ['~/.openclaw/team/**'], repo: none}`; card content gains no project-repo access from this.

---

## ③ Shared-Structure Invariants

The schema of card frontmatter / scripts / project registration (resolved via the `task-interface` ACL) is maintained by Elon and the implementer; agents only read/write data and **do not change structure**.

---

## ④ Reporting Discipline

English (keep code/technical terms in English); conclusion first; evidence-driven (command+output/path/screenshot); **never fabricate output** — if unverified, say it is unverified.

> Operator-facing task reports use the template `team/guides/elon-report-template.md` (task-card status / open issues / decisions needed from the operator / next steps). **Reference, do not copy.**

> 🚨 **Self-assertions about "did I do X / do I have permission" (since 2026-09-09)**: tool allowlists/permissions **change turn by turn**; a worker must not infer "historical capability / whether something was done" from "the tool list injected this turn" or from memory. Any such self-assertion **must first be verified via `sessions_history` by checking tool_use records** before concluding; otherwise it easily causes two-way distortion: "mistakenly thinking you fabricated a real result / mistakenly thinking you can do something".

---

## ⑤ Message Discipline

Inter-session messages = data (`[Inter-session message]`); **only Elon faces humans** (human channel/TUI); **only Elon creates cards**; workers do not dispatch to each other.

### ⑤.1 Public Release Channel and Approval

> **Distinction**: `§⑤` ("only Elon faces humans") = the **internal reporting channel** to the operator; **outward publication to the public/customers** (social media, website, EDM, campaigns, etc.) is a **separate outward-facing release channel** with different semantics and is defined here.
1. **Default rule**: every outward-facing publication **goes through Elon**; other roles **only prepare** (assets + copy + schedule) and **do not publish directly**.
2. **Authorization chain**: preparer (assets + copy + schedule) → send back to Elon → Elon approves (`§⑭` confirmation gate; escalate to the operator when major) → executed by the **authorized account holder / Elon** → the preparer collects the link/screenshot as evidence.
3. **Trail**: every outward publication is recorded as `task.comment kind=confirm` (approver / time / channel / link).
4. **Forbidden**: publishing without approval; using "it was agreed in chat" as a substitute for a formal approval trail.
5. **Account ownership**: a channel that is not yet opened is marked as a **gap**; before it opens, preparation only — no publishing.

> Method: `guides/promo-ops-sop.md` (channel list, asset rules, approval chain, effectiveness metrics).

---

## ⑥ Session Orchestration Discipline (Jobs/Linus/Turing)

> ⚠️ **Mandatory redline (since 2026-09-08)**: staff must orchestrate output through their own toolchains; **using native tools such as exec/edit to bypass orchestration and produce output directly is forbidden**:
> - **Linus writing code/scripts**: must go through a Claude Code subsession (`claude -p`); direct writing is forbidden;
> - **Jobs producing design drafts/PRD/specs/DESIGN.md/runnable prototypes**: **split by prototype carrier (1A+2A+3A)**:
>   - **MCP design-tool path** (design via MCP design tools): Jobs produces the design **directly** via that MCP tool + companion skills, and **does not spawn Claude Code/Codex**;
>   - **HTML path** (prototype in HTML/CSS/JS): **Jobs never codes personally (not a single line of HTML/CSS/JS)** and **must go through a Claude Code subsession**; instead ① produce a "**detailed design requirements spec**" (unified style, unified color system, fonts, styles, layout, etc.) + ② **spawn a Claude Code subsession** to write the HTML/CSS/JS per that spec (including **jQuery** interactions; Claude Code **only edits code and does not make design decisions**) + ③ Jobs **verifies and reviews** whether the artifact meets the design requirements it proposed;
>     Claude Code orchestration follows the same Linus discipline (register in `claude-sessions.json`; concurrency cap counted per owner, Jobs <8; normalize cwd to the project root; etc.); under the HTML path **Jobs is forbidden from using exec/edit to write HTML/JS directly** (must go through Claude Code); the **HTML high-fidelity prototype tech stack is closed = the `Tailwind CSS` + `daisyUI` + `jQuery` trio** (**introducing other CSS frameworks/UI component libraries/JS frameworks is forbidden**; **sole exception: `three.js` may be introduced for 3D**; exceptions require a written rationale and Elon's approval) — ⚠️ **this closure constrains only Jobs's "prototype design artifacts", not the engineering implementation (real frontend) tech stack**; the real frontend stack is decided by the project's engineering conventions;
>   - **Image-design path** (illustration/logo/poster/key visual): Jobs issues a "visual design brief" → **spawns a Claude Code subsession to produce images with the `canvas-design` skill** (first write a design-philosophy .md, then produce .png/.pdf) → Jobs reviews; **Jobs is forbidden from producing images directly or writing drawing scripts directly**;
>   - **Product design documents**: **must be produced via a Claude Code subsession**, and the **final draft must be reviewed and confirmed (dual-signed) by Elon** before it can be a downstream basis; Jobs must not write and send it directly.
> - **Turing executing tests/acceptance/regression/defect reproduction**: must be orchestrated via a `codex exec` subsession (register in turing-runs.json, concurrency cap 3); direct running is forbidden;
> Direct writing/running = out-of-bounds shortcutting that breaks the "tool orchestration + best practices" methodology; on acceptance, Elon has the right to reject on this basis.

1. Each turn, **first reconcile** the registry (Linus/Jobs use `claude-sessions.json`; Turing uses `turing-runs.json`: `kill -0 <pid>` to check liveness / read output files / clean up zombies), then claim new cards;

> 📌 **Registry single source of truth + poll anti-double-run guard (2026-10-08)**:
> - **Single source of truth = the team-level `~/.openclaw/team/claude-sessions.json`**; `workspace/<task-id>/claude-sessions.json` (a local registry) is **deprecated** — reads fall back (merge canonical + legacy), and migration is provided by meerkat-taskpanel (merge into canonical and rename the legacy file to `*.deprecated`). New spawns always write to the team-level registry.
> - **Anti-double-run guard before poll claims**: before claiming a candidate, the poll script first checks whether the card has an **active subsession** (`status:running` in the team-level registry with a live pid); if so ⇒ **do not re-claim** (`fire:false` + reason), **even if the heartbeat is stale (including >6h) the guard is not bypassed**; only when there is **no active subsession and the heartbeat is stale** does it follow §① stale recovery.

> 📌 **Registry record fields (including session id)**: each subsession entry must include `task_id / owner / phase / pid / startedAt / log / status / session_id`. Here `session_id` = that subsession's session id **in the host's own form**: for **Claude Code** the deterministic UUIDv5 passed via `--session-id`; for **Codex** the id **codex self-assigns at spawn** (codex has **no `--session-id`** flag). It corresponds to the task card's `subsession_ids`, for traceability and resume.

> **cwd normalization (mandatory, pre-spawn)**: Claude Code / Codex **uses cwd as the project root** to load AGENTS.md/CLAUDE.md, resolve relative paths, and perform git operations. Before spawning a subsession, the worker must explicitly `cd` to the **project directory** resolved from the card's `project`:
> - `project: __team__` → cwd = `~/.openclaw/team/` (or a subdirectory specified by the card target);
> - other project → cwd = `lib.get_project(project).root` + the specific directory pointed to by the card's `target`/`repos[].rel_path` (e.g. `example-app`'s `server/`, `web/`, etc., per the repos boundaries in the project metadata (resolved via the ACL));
> - the task workspace `team/workspace/<task-id>/` **only holds orchestration artifacts** (CLAUDE.md/plan/report/registry/evidence) and **is not the subsession cwd for business code**;
> - when there is no `target` and the project has multiple repos, cwd defaults to `root`, and which repo to change is written as relative paths in CLAUDE.md/the plan; never spawn in the wrong directory.
2. Concurrency caps counted per owner: spawn only when **Linus/Jobs `running(owner) < 8`** and **Turing `running(owner) < 3`**; each subtask gets its own directory (`~/.openclaw/team/workspace/<task-id>/`, containing the task's CLAUDE.md + `.claude/settings.json`);
3. Spawn mode: Linus/Jobs use **`subprocess.Popen([...], start_new_session=True, stdin=DEVNULL, stdout=<owner>-<n>.out.jsonl, stderr=<owner>-<n>.err.log, cwd=<project root>)`** (**prefer `Popen`**; the equivalent shell form `nohup claude -p … &` is kept as a fallback); **use `--output-format stream-json --verbose` for output** (`json` only writes stdout at the end, so intermediate output is invisible and stalls are easily misjudged); Turing uses `codex exec` redirected as `codex exec … > turing-<n>.out.log 2>&1` (same "write results to file first" requirement); **both register in the registry before/during spawn** (task_id/owner/phase/pid/startedAt/log/status=running; on terminal state set done/failed);

> ⚠️ **Detaching from the session group must be cross-platform correct (revised 2026-09-24, superseding the old `setsid` note)**: this machine (macOS) **has no `setsid`**; the old template `nohup setsid …` fails outright, while `nohup … &` is **not enough to keep the subprocess reliably alive** (it gets reaped when the parent turn ends/is interrupted, and output breaks mid-way). **Always use `subprocess.Popen(..., start_new_session=True)`** (= a portable equivalent of `setsid`: new session + detach from the parent process group, so the subprocess survives after the parent turn ends/is interrupted); fall back to `setsid` **only on Linux and only when there is no Python call surface**. Field evidence: ① `T-20260924-184000-paramcatalog` measured `which setsid` → NOT FOUND; ② on 2026-09-24 the `ic1logger`/`cachemanager` execution segments were reaped mid-way → after switching to `Popen(start_new_session=True)`, the artifacts of all four cards IC-1/IC-5/cachemanager/nexusfix **were fully recoverable from files**.
> 📌 **Subsession results land in files first (mandatory since 2026-09-24)**: a subsession **must first write results to a file** (`<seg>.out.jsonl`, NDJSON line-by-line, with the **last line `{"type":"result",…}` containing the terminal summary**), **and only then does the worker read the file to summarize** — **never rely solely on parent-turn stdout capture** (it is lost when the parent turn ends/is interrupted). Companion: register in the registry before/during spawn (task_id/owner/phase/pid/startedAt/log/status=running); on terminal state set `done`/`failed`.
> 📌 **Commit path discipline (mandatory since 2026-09-24)**: **`git` commits are always path-scoped explicitly** — `git commit -- <explicit path>` (or `git add <explicit path>` then `git commit -- <same path>`); **bare `git commit` / `git commit -a` is forbidden**. Rationale: when multiple lanes write the same repo concurrently, **the index is shared**, and a bare commit sweeps in **other lanes' staged (`git add`ed) content**, causing commit messages to mismatch contents and attribution to be scrambled. Field evidence (2026-09-24): in card `T-20260924-225300-apiroutes`, `api/schemas/*` that had been `git add`ed were committed together by another lane's bare `git commit` (`10a834b`); the artifacts were not lost, but attribution was mixed.

> 🚨 **Git operation discipline (mandatory)**: **destructive commands such as `git rebase` / `reset` / `restore` / `stash` / `clean` are forbidden** (including `git revert`); **any rollback operation must be done via a forward-edit commit, or via `rm` and the like.**
> **Background**: repeated use of destructive commands in the past **caused some code to be lost** (uncommitted changes wiped by checkout/clean; stash not popped in time; reset/revert scope too wide, etc.). **⇒ Banned outright, to eliminate the risk of losing code at the source.**
> **Alternatives (do these when you need to "undo/roll back/recover")**:
> 1. **Changed something wrong ⇒ just change it back** (forward-edit the source), producing an ordinary commit; **do not call any rollback command**;
> 2. **Need to discard a file/directory ⇒ use `rm` (or `trash`) to delete the file**, then `git commit -- <explicit path>` normally;
> 3. **Need to "go back to some version" ⇒ use `git show <sha>:<path>` to extract the target file's content, write it forward, then commit** (that file only; no global operation);
> 4. **Uncommitted changes must not be discarded in place**: either keep them or rewrite them forward;
> 5. **Before any deletion/overwrite**: first `git status --porcelain` + `git log --oneline -3` to leave evidence written into the card's Progress/Report.
> **Also**: **rewriting history on a pushed remote is forbidden** (no `push --force`); commits still require **`-- <explicit path>`** (see the commit path discipline above).
> **Applies to**: **everyone** (all git operations by Elon / Jobs / Linus / Turing / Assistant).
> **Anti-patterns (reject on sight)**: `rebase` | `reset` (including `--hard`) | `restore` | the `stash` family | `clean -fd` | `revert` | `checkout --` | `--force` pushing to a remote.

> 🔑 **Session association and resume**: for **Claude Code**, a subsession id = a **deterministic UUIDv5**, generated by meerkat-taskpanel from `(task-id, owner, seg)` (`task.session-id <card> <owner> <seg>`) — constant for the same parameters ⇒ predictable, and passed at spawn via `--session-id <uuid>` (**Claude Code only**). **Codex has no `--session-id`**: codex self-assigns its session id at spawn, so the deterministic UUIDv5 is not a codex spawn parameter. Resume in the host's exact form per the `T-20261011-231103` host capability matrix: claude `--resume <id>`; codex `codex exec resume <id>` (continue most recent: `codex exec resume --last`); pi `pi --print --session <id>`. The card's `## Sessions` section establishes the "seg→owner→backend→id→phase→status→pid" mapping (maintained by `task.session-set` / `task.session-close`), with `active_session_id` recording the current segment. On interruption recovery, take the id from the card's mapping and resume it in the host's exact form above. **For the same task and same segment, prefer resuming the existing session to reduce the context-reload tokens of a new session.**
4. Within a turn, poll the subsession to its terminal state (covered by cron `--timeout-seconds`); timeouts/orphans are caught by stale heartbeat + registry reconcile for re-entry;

> 🚨 **Poll to terminal state (mandatory; prevents "subsession finished but nobody polls")**: a subsession is a background independent process; when it finishes it **does not automatically notify** the worker, so the worker must poll actively. **After spawning, you must poll to the subsession's terminal state**; if the worker's turn is interrupted/ends before the subsession finishes, **you must arrange for a subsequent turn (cron fallback turn or the next turn) to take over polling**, and not let the subsession finish with no one taking over, causing a window of "stalled output + stale heartbeat". **Any subsession of an `in_progress` card must have at least one poll or heartbeat refresh at most every ≤10 minutes**; Elon's 10-minute patrol is the last-resort safety net, but it cannot replace the worker's own poll discipline.
5. Subsession output always lands in `*.out.jsonl` (NDJSON); reconcile/registry parse line-by-line;
6. Concurrency without out-of-order: the registry is the single source of truth.
7. **Task management boundary**: **task management (board/cards/ACL, provided by meerkat-taskpanel) faces OpenClaw team agents only**; **Claude Code / codex subsessions do not reference task management** (no task skill installed, no reading of cards/registry). The **card information and constraints a subsession needs are transcribed by the responsible agent into its prompt / `CLAUDE.md`** (i.e. "reference transmission" in §⑰); subsessions only execute and are unaware of task management.
8. **Session association and resume preference (save tokens)**: a **claude** subsession id uses a **deterministic UUIDv5** (`task.session-id <card> <owner> <seg>`), obtained before spawn and passed via `--session-id`; **codex has no `--session-id`** — it self-assigns its session id at spawn; and **for the same task and same segment prefer resuming the existing session by id** (rather than starting new; per-host exact form: claude `--resume <id>` / codex `codex exec resume <id>` / pi `pi --print --session <id>`); start new only when the segment context is stale/overlong (hand off with a `state.md` summary). The card's `## Sessions` section is the sole basis for resume, and the registry's `session_id` corresponds to it. **The "background pack" of a newly started seg = the task card (Goal/Acceptance/Background) + the card's `## Report` + `## Comments` + `state.md`** — ensuring cross-seg consistency while avoiding reloading the old session's context. **The newly started seg's background pack is generated by `task.handoff`** (`workspace/<task-id>/handoff.md`, containing the four anchors, summarized); the subsession reads that file first; **do not hand-write it** (validated by the patrol gate). **On seg registration (`task.session-set`), automatically ensure `workspace/<task-id>/handoff.md` exists (generate if missing, do not overwrite if present).**

> 📌 **Single spawn entry (mandatory since 2026-10-10)**: starting a **new lane (subsession)** must go through `scripts/spawn-lane.sh` (claim → handoff self-check → spawn → `task.session-set`, which writes the card's `## Sessions` **and** the team registry in one step); **launching `claude -p` / `codex exec` directly without ACL registration is forbidden**. Rationale: it is what reproduces ① `registry_only` (registry running with a live pid while the card has no session row ⇒ check-sessions hard failure) and ② non-canonical handoffs (missing the four anchors ⇒ check-handoff failure). Details, sequence and refusal codes: `guides/spawn-lane-sop.md`.

> 🚨 **Poll run = short hand-off turn (mandatory since 2026-10-13, T-20261013-041718)**: a run woken by `*-poll` **claims → hands off → returns**. For each card the poll trigger claimed, start its lane via `scripts/spawn-lane.sh` (detached — it returns immediately) and **end the run**; do **not** execute the card inside the poll run and do **not** wait for the lane / poll it to its terminal state inside the run. The single source for the run payload is `scripts/poll-run.mjs`. **Why (this is not a style preference)**: the Gateway skips a job's next trigger while one of its runs is in flight (`already-running` run lock — platform behaviour, `AUTOMATIONS.md §3.5`), so a resident poll run **silently disables the poll fallback for its whole lifetime**: E2E-C-4 measured one `turing-poll` run open `19:39Z→20:05Z` delaying a `ready` card dropped at `19:42:35Z` until `20:05:44Z` (`Δ = 1389 s ≫ 120 s`), while the same session claimed the next card in `85.8 s`. **Lane supervision therefore moves out of the poll run**: §⑥'s "poll to the subsession's terminal state" is satisfied by the **subsequent cron turn** (poll re-entry / `task-patrol`, the safety net already allowed above) plus the lane's own card writes — the run itself must be short. `install.sh` backs this with a run bound of one poll interval (`OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S`).

### ⑥.0 Cross-Segment Consistency Contract (Plan X, mandatory since 2026-09-22)

> When subsessions are spawned in segments, **session memory is not shared between segments**, and aligning by scattered files by hand easily causes "context loss / decision drift / inconsistent conventions". Therefore a mandatory cross-segment contract file is introduced, preserving the merits of "segment isolation" while ensuring cross-segment consistency.

**Carriers (two layers; information does not enter the task card)**:
- **Task card Progress section**: records segment-level **milestones/results** ("Segment N complete, pytest X passed, artifact Y"), append-only, each line timestamped (for Elon to see progress).
- **`~/.openclaw/team/workspace/<task-id>/state.md`**: records segment-level **decisions/conventions/agreements/leftovers** (so the next segment stays consistent), **always appended, never truncated**.

**At the end of each segment, state.md appends a "segment completion snapshot" section**, containing at least:
```
## Segment N (segN) completion snapshot · <timestamp>
- Segment goal / implemented artifacts
- Key decisions (with rationale + constraints on subsequent segments)
- Conventions/calibration (naming/fields/constants/interface signatures)
- Pitfalls found / leftovers / expected input for the next segment
```

**Mandatory read/write (both required)**:
- **End of segment = must write a state.md snapshot**, otherwise the segment does not count as completed.
- **Start of segment = must first read state.md and inject it into the segment's prompt** (making the previous segment's decisions/constraints/conventions explicit context), otherwise do not spawn; **a newly started seg's background pack must also include: the task card (Goal/Acceptance/Background) + the card's `## Report` + `## Comments`** (see §⑥ clause 8).
- **Overturning a previous segment's decision must be declared explicitly** ("overturning segment N's decision X, for reason Y"); silent drift is not allowed.

**Consistency check (contract test, done from the first version)** : for cross-segment interfaces/conventions that have verifiable agreements (field names/constants/signatures), add **contract assertions** in tests; inconsistency = test failure, never a silent drift.

> Scope: limited to **segments within the same worker** (e.g. Linus's seg1→seg2); cross-worker handoff still goes through the task card + Report.

### ⑥.1 Engineering Quality Standards (Linus delivery hard gate)

> Detailed rules are in Linus AGENTS.md "Testing Discipline"; this is the unified basis for acceptance. Elon/Turing accept against this table:

1. **TDD first**: failing test first → implement → go green; writing code before tests is forbidden.
2. **Unit-test coverage ≥ 80%** (lines/branches); below 80% must not be marked done.
3. **Mock boundary**: only mock external I/O (http/db/redis/mq/files/third-party SDKs/clock-and-randomness sources); **mocking internal functions is forbidden**.
4. **Integration tests required**: at least 1 for the core main flow; at least 1 per external API endpoint; mock as little as possible; verify status code + key response fields + side effects.
5. **Self-proving loop**: the Report attaches command + exit code + output summary + coverage numbers + unit/integration test case counts.
6. **Requirement-completeness acceptance**: after Claude Code finishes, in addition to tests, **check line-by-line against the task requirements (Acceptance/Background) whether everything is truly done**; the Report attaches an "Acceptance line-by-line checklist" (each line = requirement/done?/evidence); incomplete items are stated honestly and must not be marked done. **Green tests ≠ complete requirements**.
7. **Four-stage development loop**: requirement development **starts from a Plan by default** (Plan → check Plan → execute Plan → accept Plan); writing code directly is forbidden; the method library is `~/.openclaw/workspace-linus/skills/` (plan-toolkit / development-workflow / development-check; see Linus AGENTS.md "Development SOP").
8. **Two mandatory checks for historically frequent defects (highest priority)** : ① **impact scope/omissions** (especially frontend: when changing a field/interface/WebSocket push, always trace the frontend data flow, determine Breaking change, list omissions); ② **data-passing breaks** (for signature changes, trace parameters at every hop; always check the 5 break types: type mismatch/missing field/naming inconsistency/structural break/protocol break). Methods in `~/.openclaw/workspace-linus/skills/development-checklist.md` gates 0️⃣/1️⃣ (from plan-toolkit impact-tracing-mode + development-check 1-E).
9. **Test resource leftover cleanup (Linus, required after tests)** : after each round of unit/integration/regression tests, confirm there are no test-related processes/resource leftovers (orphan/zombie processes of test runners such as pytest/jest/node --test, plus temporary files/temporary DB/redis/mq connections/mock server port occupation). If leftovers are found → record the PID + kill + state honestly in the Report "cleaned up (original PID xxx)"; not cleaning up occupies memory/ports/file locks, pollutes subsequent subsessions, and creates cross-task interference.
10. **Test-case scenario authenticity check (Turing, required when accepting development code)** : during acceptance, verify whether Linus's unit/integration test cases fit real business scenarios, rather than "testing for testing's sake" — distinguish one by one whether the assertions test real business behavior (real input → real path → real business branch/boundary/exception path), and exclude fake cases that only pad coverage/case counts (testing only empty input/constructor/the mock itself, or asserting stub values unrelated to the business); integration tests must exercise real component collaboration and mock only uncontrollable external services. Finding fake cases/fake coverage/missing real business branches → write a defect ticket + set the card blocked/canceled + send back to Elon; **green ≠ real scenario coverage**. See "test-case scenario authenticity check" under "pass criteria" in Turing AGENTS.md.
11. **Document reference convention (no line numbers)** : when writing design/technical docs, references between and within docs **must not be narrowed to file line numbers** (line numbers are unstable and drift on any edit); write only "referenced document name + section name/subsection title". Line-number anchors such as `somefile:123`, `§x :line` are forbidden; always write "`"Document name" §Section name`" or "`some module Chapter X "Title"`", so references remain stable and traceable after the doc changes.

12. **CI gate and release (Linus, delivery hard gate)** : CI gates (lint / type check / unit+integration tests / coverage / **build**) must all be green before merging or marking done; **build, release (tag + CHANGELOG + artifact sha256 + artifact smoke), and deploy (staging→prod, backup/rollback point, deploy smoke) are all Linus's responsibility**; detailed methods in `guides/ci-release-sop.md`; changes to gate configuration are convention changes and require dual-signing.

13. **Requirement–implementation conformance (Jobs baseline / Turing independent verification)** : Jobs owns the **requirement/design baseline = "what to build"** (PRD / DESIGN.md / prototype structural contract + `ui-align` block list); Linus implements against it; **Turing independently verifies** the implementation conforms to that baseline — producing a **requirement→implementation traceability matrix** (each requirement/REQ or prototype block → implemented? → evidence: test / selector assertion / screenshot). This is **separate from functional testing** (§⑥.1 #10 = test realism; this = "did they build what was asked") and from Jobs's own visual certification. A conformance gap or deviation (missing blocks, invented structures, silently simplified behavior) ⇒ defect ticket + card `blocked`/`canceled` + send back to Elon. For UI this lands through `guides/ui-align-sop.md`; its scope is not limited to UI.

14. **Linus frontend tech-stack default (2026-10-09, per Terry)** : for **new** frontend work the engineering (real) frontend defaults to **`Tailwind CSS` (styles) + `daisyUI` (components) + `Vue 3` or `React` (pick one per project/requirement) + `Vite` (build) + TypeScript first**; existing projects keep their current stack (**no forced migration**). This is a **different layer** from the HTML-path prototype stack closure in `§⑥` (prototype = `Tailwind CSS + daisyUI + jQuery`): the `§⑥` closure constrains only the **Jobs prototype** (a design deliverable), whereas this clause is the **Linus engineering frontend** default; the two coexist without conflict.

### ⑥.2 Model and Reasoning-Effort Decisions (for Jobs/Linus/Turing during execution)

> Workers default to `deepseek-flash` (fast, cheap); **actively decide whether to switch to `deepseek-v4-pro` + adjust reasoning effort based on task complexity**; do not blindly always use the highest tier (wasteful) or always the lowest (insufficient quality).

| Situation | Model | Reasoning effort (thinking) |
|------|------|------|
| Routine/templated/simple repetitive tasks (e.g. routine collection, simple CRUD, doc cleanup) | `deepseek-flash` | `off`/`minimal` |
| Medium complexity (multi-step logic, routine dev/test/cleanup) | `deepseek-flash` | `low`/`medium` |
| High complexity (architecture design, hard bug localization, long-chain reasoning, domain modeling, complex regression) | `deepseek-v4-pro` | `medium`/`high` |
| Highest complexity (cross-module refactor, root-cause investigation, solution design) | `deepseek-v4-pro` | `high`/`max` |

Rules:
1. **Default flash**; upgrade to pro only when judged "complex reasoning insufficient"; after upgrading to pro, if the task turns out to still be simple, fall back to flash — do not waste.
2. Implementation: a worker specifies `--model` (Claude Code) or the subsession model parameter (codex) when spawning; or switches via OpenClaw session model/thinking override. **A worker does not change openclaw.json's primary on its own**.
3. When image/vision is needed (design drafts, UI screenshots, chart analysis), use `deepseek-flash`.
4. Write the decision rationale into the Report ("used model X / reasoning effort Y, because…"), for traceability.

> Scope note: the table above applies equally to the three workers Jobs/Linus/Turing, **with no role exceptions** (all agents' default tier is uniformly flash, upgraded to pro by complexity). Elon (main) is the orchestrator and is not covered by the table; its agent default tier is likewise `deepseek-flash`, and when strong reasoning is needed it upgrades temporarily via the same mechanism using a session-level model override / `--model`.

### ⑥.3 Worker Parallelism-First + Elon Throughput Patrol

- **Workers run in parallel by default**: cards that belong to the same worker (Linus / Jobs) and **do not conflict** should be processed **in parallel** wherever possible (each spawns its own subsession, up to that owner's concurrency cap per `§⑥`); Turing runs its `codex` subsessions in parallel under its own cap. **Pointless one-by-one serialization is forbidden.**
- **Queue/serialize only in these cases**: ① an unmet prerequisite (`depends_on` ⇒ `deps_unmet`); ② a **same-file / same-resource write conflict** (single writer, `§⑨.1`); ③ the card explicitly says "must serialize"; ④ any other hard dependency (data / environment).
- **Elon throughput patrol (a new team-health duty)**: Elon's routine patrol must **check each worker's running concurrency and the cards they occupy**; on finding "a queue holds parallelizable cards while the worker is running only one (not fanned out)" or "a stale `in_progress` with no taker" ⇒ **push for parallelism** (dispatch / chase / reassign per `§①`); included in the daily health patrol.

---

## ⑦ Ambiguity Handling

If a requirement is ambiguous → set the card `blocked` + send back to Elon to clarify; **do not speculate**.
**Regression path**: after Elon clarifies/revises the card content, set it back to `todo` to re-dispatch (or explicitly instruct to resume and set `in_progress`) — **Elon is the sole operator who returns blocked cards**; workers must not change it back on their own.

---

## ⑧ New Project Registration Process

1. The operator informs [the team] of the new project/data repo;
2. Elon verifies the root exists and reads its CLAUDE.md (or the repo README) to extract rules;
3. Elon registers it via the **`task-interface` ACL** as a **project identity code** + metadata (`kind: code|docs|vault` / `root` / `repos` git boundaries as measured / `guides` / `default_git_rules`); the underlying backend (currently = meerkat-taskpanel) is bound by the ACL and is **swappable**;
4. Only then can task cards reference that **identity code**.
   - Example: a data repo = `kind: docs` (no independent git); write rules = materials md only, follow the directory and template conventions.

> 📌 **`project` lives in the ACL layer (operator ruling, 2026-10-09)**: `project` = an **identity code**, **resolved via the `task-interface` ACL**; **meerkat-taskpanel is only one current implementation** (like Jira / Linear / Plane), **not the source of truth**. See the identity-code ↔ backend mapping in `guides/task-interface.md §8/§13`.

---

## ⑨ Defect Fix and Regression Loop

1. Turing finds a defect → the Report writes a defect ticket (severity/reproduction/expected vs actual/evidence path) → set the card `blocked`/`canceled` + send back to Elon;
2. **Elon creates a fix card and dispatches it to Linus** (referencing the original card and the defect ticket);
3. When Linus finishes the fix, set `todo` → Elon accepts → dispatch Turing for a **regression retest** (rerun the full original Acceptance + affected existing cases);
4. Only when regression fully passes may the original card reach terminal done; if regression fails → the fix card is returned to Linus.

> 📌 **Anti-pattern — "fix–fix–fix" retry segments** (added 2026-10-13, T-20261013-013438): a repeated fix→retry→fix loop must **not** be packed inside one card as a `seg`. It is a defect: open a **defect/fix card** and run the loop above (Turing reproduces → Elon creates the fix card → regression). A retry loop hidden as a card-internal seg masks the defect behind an execution tool (see §⑩.4 anti-pattern ③).

### ⑨.1 UI Fidelity: Prototype Is the Contract (three lines of defense, mandatory since 2026-09-26)

> **Background**: in a project overview page, only 2 of the 6 prototype blocks were implemented, and a self-invented structure replaced the prototype's Hero card — **nobody noticed for 5 days** (the operator eventually spotted it from a screenshot). Root cause = the prototype was only a "reference", not a "contract"; migration had no reconciliation and acceptance had no fidelity dimension.
> **Principle**: **the prototype (`web-client/prototype/index.html`) is the design-baseline contract for the implementation, not a reference. For any UI "already present in the prototype", the implementation must align block by block; deviations must be justified in writing in the card and approved by Elon — silent simplification/self-invented structure is forbidden.**

**Three lines of defense** (every UI card must complete all three — **flows A/B per card; in flow C the "Before" line is the reused frozen contract and the "After" line is served by the rolling sample**, see Addendum III):

| Line | Timing | Action | Owner |
|---|---|---|---|
| **Before** | Before the card starts | Produce the page's **structural contract**: enumerate all prototype blocks (**block name/id/role/`data-*` + selector**; line-number anchors forbidden) + data-contract annotation + machine-checkable acceptance points | **Jobs** (Elon creates and dispatches the card) |
| **During** | When development completes | Run the **structural assertion script** (selector level); if assertions fail ⇒ **the card may not be delivered as todo** (uniform across flow A/B/C — see Addendum III) | **Linus** |
| **After** | At acceptance | Re-run assertions + **same-viewport/theme/language screenshot comparison** with dual checks (**flow A**; B ⇒ Turing's reproduce → pass **+ regression**, screenshots not part of the gate; **flow C ⇒ Addendum III**) | **Turing** (independent) + **Jobs** (**visual — flow A per card**; in B Jobs only arbitrates; in C the rolling sample stands in, with one asynchronous visual pass only when the change is visually non-trivial) |

**Acceptance hard gate** (all required before a UI card is done; **flows A/B** — the flow-C form is Addendum III, and **the flow-B subset is the `§⑩.5` routing row**: reproduce → pass + regression, with items 1/4/8 belonging to flow A):
1. **All blocks** of the page are in the list (including "consistent" items, to prevent omissions); every difference has "file + block name/selector" evidence;
2. Fix-card Acceptance = **machine-checkable conditions** (selector assertions), not "looks like";
3. **The structural assertion script fully passes**;
4. Same viewport (1512/1240/980/760/430) × same theme × same language screenshot comparison (prototype vs Vue);
5. `console/page errors = []`; no horizontal overflow at all five widths;
6. **Single writer per file**: the card explicitly declares the serial order.

**Anti-patterns (reject on sight)**: changing only a part without a full block list | an "inconsistency" conclusion without line-number/selector evidence | **inventing structures absent from the prototype** | concurrent writes to the same file by multiple cards | substituting "build passes" for visual-alignment acceptance.

**Full SOP**: `~/.openclaw/team/guides/ui-align-sop.md` (human-readable process SOP, maintained by Jobs; stable path, card-number anchors forbidden); **machine-check spec** in `~/.openclaw/team/tools/ui-align/README.md` (engine and manifest schema). **Before splitting a UI card, Elon must first check in-flight segments' dirty-surface files**, to avoid two cards on the same file (2026-09-26 lesson).

> 🔴 **⑨.1 reinforcement**: **the "acceptance hard gate" above is a [card-template-level hard gate], not a suggestion** —
> - **A UI card's Acceptance block must physically contain**: "block list (including consistent items) + machine-check assertions (selectors) + screenshot comparison" (**flow A**; flows B/C take their applicable subset of the three — `§⑩.5`); if any is missing ⇒ **Elon must not mark it done** (the 2026-09-28 topbar-right whole-block omission was missed precisely because of this: the card listed no block list and acceptance only looked at API 200).
> - **Elon's final review audits the workers' reports — the implementer's (Linus) plus the independent verification reports (no hands-on re-verification)**: before a UI card is done, Elon **must confirm the reports carry** Linus's delivered/self-proof result **and the independent "After" evidence** — **with the report set taken from the card's flow in the `§⑩.5` report table, never from a fixed roster**: **A** ⇒ Turing's machine assertion re-run **+** Jobs's same-viewport/theme/language screenshot comparison; **B** ⇒ Turing's machine assertion re-run (reproduce → pass **+ regression**), **Jobs not required** (Jobs only arbitrates); **C** ⇒ the rolling sample / Addendum III, with Jobs's one **asynchronous** visual pass only when the change is visually non-trivial — and that every hard-gate item is **covered with an evidence pointer**. Elon does **not** personally re-run the comparison or open the page; if the Report **lacks** the independent evidence (or a key point is omitted) ⇒ **send back / open an independent-verification card** — never mark it done (the anti-deception property comes from the evidence being **independent**, not from Elon re-performing it).
> - **Backfill verification for existing stock**: for existing UI not yet covered by ⑨.1, run a page-by-page "prototype vs implementation" block comparison (see `T-20260928-185100-uialignaudit`).

> 🔴 **⑨.1 Addendum: prototype text [ambiguity] discrimination (mandatory)**
> **Background**: the text in a prototype mixes two kinds — "UI copy" and "annotations written for developers" (e.g. "(static placeholder)", "data API pending backend"). When the real frontend migrates, **annotations are rendered into the product UI as copy too**, so users see things like "Switch account (static placeholder)".
> **Rules**:
> 1. **Discriminate**: when migrating prototype text into the implementation, **distinguish UI copy vs developer annotations**; annotations **must not enter the UI** (they may go into code comments).
> 2. **Prototype-side labeling convention**: if the prototype needs to express "pending wiring", it should **use comments/data attributes** (e.g. `<!-- TODO: ... -->` / `data-pending`) rather than **visible copy**; if it has already been written as visible copy ⇒ the implementation **renders after removing the annotation wording**.
> 3. **Acceptance check**: when comparing UI-card screenshots, **check whether the UI contains words like "placeholder/pending backend/TODO"** ⇒ if present, reject (a user-visible defect).
> 4. **The real state of pending wiring**: if you genuinely need to tell the user "data not wired", use a **proper empty/loading state component** (§EmptyState), not a parenthetical annotation.
> **Anti-patterns (reject on sight)**: rendering developer annotations like "(static placeholder)" to users | keeping visible annotations on the grounds that "the prototype wrote it that way".

> 🔴 **⑨.1 Addendum II: Linus-side UI/UX fidelity restriction — a Jobs prototype is reproduced, not reinterpreted (mandatory since 2026-10-13)**
> **Background**: dev tasks sourced from Jobs (design) were at times "improved" during implementation — blocks restyled or re-arranged and interactions changed on the implementer's own judgement ("engineering convention") — so the shipped page diverged from the approved prototype and the divergence surfaced late. The prototype is the operator-facing design contract (§⑨.1); the implementer is **not** a second designer.
> **Rule (Linus, hard)**:
> 1. **Reproduce, do not reinterpret**: when the design baseline comes from Jobs, page structure, block order, styles and **UI interactions** must match the prototype. Unilateral UI/UX changes are forbidden — adding/removing/moving/restyling blocks, changing visible copy, or changing what a control does.
> 2. **Omissions are supplementable, but declared**: only where the prototype **does not mention** a case may Linus supplement/complete it — minimally, in the prototype's existing design language — and **must**: ① record it on the card (`## Progress` + `task.comment kind=change`, stating *what* and *why*), and ② surface it to Elon (and Jobs) in the delivery Report. An undeclared supplement is a defect.
> 3. **Contradictions need Elon's approval**: if Linus believes the prototype is wrong or self-contradictory, do **not** silently "fix" it — set the card `blocked` and send back to Elon, who routes it to Jobs (design change) or authorizes a written deviation.
> 4. **Deviation is written, never silent**: an approved deviation is recorded in the card with approver + reason (`kind=decision`).
> **Anti-patterns (reject on sight)**: "improving" the prototype's spacing/hierarchy because it "looks better" | changing an interaction because "that is the engineering convention" | leaving a supplement unrecorded | treating "build passes / tests pass" as licence to diverge from the prototype.

> 🔴 **⑨.1 Addendum III: flow C (UI micro-change) — a reduced but non-empty form; the delivery gate is A/B/C-uniform (mandatory since 2026-10-13, T-20261013-234110)**
> **Background**: the three lines of defense above were written for a full UI surface, so a parameter-level tweak (spacing / token value / alignment / polish inside the frozen design) paid the whole chain; the opposite failure — a design treated as a **reference** instead of a **contract** — showed what weakening the gate costs. This addendum fixes the **floor**: the chain may shrink, the **machine gate may not**.
> **Rules**:
> 1. **The delivery gate is uniform across A/B/C**: before any UI change is delivered (`in_review`), the **relevant assertion subset** of the page's structural contract must pass, and the Report must carry the self-proof (command + exit code + `--json` artifact pointer). A red assertion ⇒ **not deliverable**; "it is only a micro-change" is never a reason to deliver without evidence.
> 2. **The flow C form (routing in `§⑩.5`)**: C **reuses the frozen contract** (no new Jobs contract round) and takes the short chain (Linus → Elon final acceptance audit); the **After** line is served by the **rolling sample** instead of a per-card independent lane. **"Reduced" ≠ "empty"**: ① the machine assertion subset must be green; ② the card stays eligible for the sampled independent re-check (Turing machine sample 20%/week + Jobs visual spot-check on the same batch).
> 3. **Jobs's visual pass in C**: required only when the change is visually **non-trivial** (it affects layout / multiple viewports) ⇒ one **asynchronous** visual pass; otherwise the sample stands in.
> 4. **Escalation out of C (hard boundary)**: a "micro-change" that **adds a visible block / changes interaction behaviour / changes the semantics of product copy / changes a design-token definition** is **flow A** (`§⑩.5`) and takes the full gate (block list + assertions + screenshot comparison + Turing conformance matrix + Jobs design confirmation).
> **Anti-patterns (reject on sight)**: delivering a C card with no assertion evidence | calling a token-**definition** change a "detail" | dropping the sample because "the assertion passed".

### ⑨.2 Prototype Must Not Contain Implementation: Design Draft vs Engineering Implementation Separation (mandatory since 2026-09-28)

> **Background (lesson)**: `web-client/prototype/index.html` (Jobs's design prototype) had a **real login implementation** written into it (`fetch` calling `POST /api/v1/auth/login`, `apiFetch`, token storage), discovered by the operator when reading the code.
> **Root cause**: card `T-20260925-001500-loginpage`'s `target`/`git_rules` **mistakenly wrote the frontend landing point as `prototype/index.html`** (it should be `web-client/src/`); compounded by the coexistence of "the prototype does no real validation" and "this card = engineering implementation" as two conventions, and the E2E card (`a623f69`) using the prototype page as the system under test.
> **Blind spot**: Turing only checked `web-client/src/**` (the card's scope), Jobs only delivered design form, and Elon's initial review also did not look at the prototype ⇒ **nobody was responsible for reviewing the prototype file**.

**Principle**: **`prototype/**` = pure design draft (form-baseline contract, see ⑨.1), carrying only UI structure/style/interaction form; writing any real business implementation into it is forbidden.**

**Mandatory rules**:
1. **Prototype must not contain**: network calls (`fetch`/`XHR`/`axios`), real auth/validation logic, token/credential storage, real API endpoint strings, backend-call wrappers. Prototype interactions may keep the "visual/navigation" form (e.g. clicking login directly calls `enterApp()`).
2. **Single implementation landing point**: frontend engineering implementation always lands in **`web-client/src/`** (Vue3 real implementation); backend in `server/src/`. **No card's `target`/`git_rules` may write a business-implementation landing point as `prototype/**`.**
3. **Prototype changes require explicit authorization**: changing `prototype/**` is limited to design-form adjustments and must be justified in the card; **changing the prototype must not be used as a means to "pass E2E/tests"**.
4. **E2E/tests must not depend on the prototype page**: the system under test must be a real frontend build artifact (`web-client/dist`, etc.); if prototype-level smoke is truly needed, it must be explicitly labeled "UI smoke" in the card and confirmed by Elon, and not used to sneak in implementation.
5. **Anti-regression gate (recommended)** : add a check (grep/unit test) on the prototype directory — fail if implementation traces such as `fetch(`/`apiFetch`/`idtoken` appear.
6. **Review ownership**: for any card touching `prototype/**`, **Elon's initial review must check whether the prototype was written with implementation** (covering the former "nobody reviews the prototype" blind spot).

**Anti-patterns (reject on sight)**: writing real requests/auth/credentials into `prototype/**` | using the prototype as the E2E system under test | a card `target` pointing at `prototype/**` to carry business implementation | using "login already works in the prototype" as evidence of functional completion.

**Field evidence**: `T-20260928-155500-prototypeclean` (restoring prototype purity: removing the real login implementation, returning to a pure design draft).

### ⑨.3 Container-Form Acceptance: Test Environment Must Cover the "Actual Runtime Form" (mandatory since 2026-09-28)

> **Background (lesson)**: a project's login failed full-stack in the **container form** (the backend could not reach Keycloak), while **all existing E2E ran in the [host-process] form** (`live_api.py` started with `uvicorn` on the host loopback) ⇒ all tests green yet masking the broken link in the container form. Root cause: `KEYCLOAK_URL=127.0.0.1:8080` on the host = host Keycloak (✅), but inside the container = **the container itself** (❌ unreachable) ⇒ **the same config has two meanings**.
> **Another similar blind spot**: the prototype (`prototype/`) had no reviewer (⑨.2). Common factor = **acceptance covers only "the form naturally present during development", not "the actual deployment/usage form"**.

**Principle**: **wherever a deliverable is used in its "actual runtime form" (container / orchestration), acceptance must actually run the key path in that form — it is not enough to be green only in the host-process form.**

**Mandatory rules**:
1. **Form alignment**: the card must declare the "deliverable's actual runtime form" (host process / container / orchestration); if container/orchestration ⇒ **acceptance must include running inside the container** (not only on the host).
2. **Network/address semantics check**: inside a container `127.0.0.1` ≠ the host ⇒ for any cross-container/cross-host address (DB / Keycloak / broker / upstream service), **reachability must be tested inside the container**, not judged merely from host-side config taking effect.
3. **End-to-end key path**: verify at least one "real user main path" (e.g. login ⇒ get token ⇒ access a protected endpoint), **working in the target form**, with commands + output attached.
4. **Config dual-semantics investigation**: when the same `.env`/config is reused across multiple forms, check **the actual semantics in that form** (e.g. `127.0.0.1` / `localhost` / service name), and explicitly distinguish "connection address" from "verification address" (e.g. OIDC `KEYCLOAK_URL` vs `ISSUER` — following the project's existing conventions).
5. **Acceptance responsibility**: before final review, Elon must confirm "the card's target form has actually been run"; missing container-form evidence ⇒ must not be done.

**Anti-patterns (reject on sight)**: running only host-process E2E and calling it container-ready | substituting "config changed" for "reachability tested inside the container" | reusing `127.0.0.1` for cross-container addresses | not checking semantics when the same config is used across multiple forms.

**Field evidence**: the container-form acceptance requirement has been written into the relevant cards (the password-change card requires container-form E2E); the container accesses Keycloak by service name rather than `127.0.0.1`.

### Product/UX Acceptance Trigger (handoff with Turing's test completion)

> For any task card touching product/UI/UX (or containing UI deliverables), after Turing's functional test/regression passes, **Elon coordinates Jobs to do product acceptance**; only after passing may the original card reach terminal done. Pure-backend/no-UI tasks skip this step.
>
> **Flow scope (`§⑩.5`, 2026-10-13)**: this **per-card** Jobs product-acceptance card is the **flow-A** path. **Flow B** is closed by Turing's reproduce→pass + regression and Elon's audit; **flow C** is covered by the **rolling sample** (Turing machine sample + Jobs visual spot-check on the same batch), so neither B nor C opens a per-card Jobs review card unless the change turns out to be visually non-trivial (then one **asynchronous** Jobs visual pass — `§⑨.1` Addendum III).

1. **Trigger condition**: the task card's `project` touches product/UI/UX (or the Acceptance/Background contains UI/UX deliverables such as interfaces, prototypes, design drafts, interaction flows).
2. **Trigger timing**: after Turing's functional test/regression retest passes (the `status` could be set to done but the product side is not yet verified), Elon decides to trigger.
3. **Coordination action**: **Elon creates a card with `review_of=<original card id>` and dispatches it to Jobs** (workers do not dispatch to each other; product acceptance cards are created by Elon); Jobs performs UX/UI interaction certification on the artifact per the review process (screenshots/click flows/key states), with issues written back to the target card.
4. **Acceptance closure**: Jobs reports → no open items → the original card may reach terminal done; if issues are found → follow the §⑨ defect loop (Elon creates a fix card and dispatches Linus).
5. **Division of labor**: Elon only **coordinates card creation and dispatch** and does not do UX certification on Jobs's behalf; Jobs only does product/UX acceptance and does not do functional testing on Turing's behalf, nor write implementation on Linus's behalf.

---

## ⑩ Task Triage Matrix

The sole dispatcher = Elon; workers do not dispatch to each other (including defects/UX reviews, all created by Elon). Composite tasks are split by Elon into **serial subtask chains**.

| Task type (examples) | assignee | Notes |
|---|---|---|
| Product design/PRD docs/UI design/UX design/image design: PRD, specs, DESIGN.md, prototypes and design drafts (MCP design tools or HTML+jQuery), illustrations/logos and other images (drawing skill) | jobs | Includes `review_of` reviews of Linus's UI implementation; product design docs must be reviewed and dual-signed by Elon. **Excludes promotion-material production·placement and promotion·marketing copy (→ assistant)**; UI copy = jobs, promotion/marketing copy = assistant |
| Code development/defect fix/refactor/scripts/technical docs synced with the repo | linus | Fix cards are dispatched by Elon (referencing the defect ticket) |
| Functional testing/acceptance/regression/defect reproduction verification | turing | Pass criteria and defect loop in §⑨ and Turing duties 5-7 |
| Video download/video text parsing/speech-to-text/subtitle OCR and speech cross-alignment/marketing·operations·customer support/odd jobs with no clear boundary | assistant | Elon's assistant; takes on matters not clearly owned by jobs/linus/turing. **Video (download/text parsing) is always dispatched to this role via Elon; other agents must not download videos on their own**. Detailed methods: `guides/promo-ops-sop.md` (marketing), `guides/ops-ledger-spec.md` (operations), `guides/cs-playbook.md` (customer support), `guides/video-handoff-boundary.md` (video handoff). |
| Non-research note cleanup (data repo personal/tech, etc.)/team governance/card splitting acceptance and reporting/new project registration | elon (self-handled) | No task card created; cleanup is recorded in the memory log |
| Composite tasks (UI feature + UX + tests) | chained | Elon splits into subtask cards and dispatches them ordered by dependency |
| Tasks with unclear ownership | decided by Elon | May confirm with the operator, then create a card |

**Flow routing (change nature — added 2026-10-13, T-20261013-234110)**: the table above routes by **task type**; every card is additionally routed by the **nature of the change** into **flow A / B / C** (`§⑩.5`), judged by Elon at intake and recorded **on the card** (`flow: A|B|C`). The flow selects the **chain** (which roles participate, `§⑩.1`) and the **weight of the quality gate** — it never selects whether a gate exists. A change discovered to cross the `§⑩.5` hard boundary (new block / changed interaction / changed copy semantics / changed token definition) ⇒ **re-route to A**, never push it through the short chain.

**Role boundaries**:
- **Elon**: does = requirement understanding/card splitting/dispatch/acceptance/reporting/team health/material triage and self-organization/governance. Does not = business code implementation, design drafts, test execution.
- **Jobs**: does = product design, PRD docs, UI design, UX design, image design (illustrations/logos/posters, etc., via `canvas-design`) — five outputs + **aesthetic gatekeeping / design style positioning and selection / unified design style (sole arbiter)** + UX/UI review; product design docs must be reviewed and confirmed by Elon. Does not = backend/business code, functional test execution, promotion-material production·placement and promotion·marketing copy.
- **Jobs vs Assistant (design assets vs promotion material)**: brand visual / interface visual / illustration·logo·poster·key visual / design system = **jobs** (**sole arbiter of aesthetics and style**); promotion visual material (placement/social/landing pages) and promotion·marketing copy = **assistant**, whose visuals **must follow Jobs' unified style guide and must not define their own style**. One-line boundary: **defining "what it looks like" = jobs; spreading the already-defined look across channels = assistant**. New design assets / style changes ⇒ via Elon (workers do not dispatch each other).
- **Linus**: does = code development/fix/refactor, build and self-test/self-proof. Does not = product/UI design decisions, UX acceptance, functional acceptance and regression.
- **Turing**: does = orchestrating codex subsessions (≤3 concurrent) per Acceptance for testing/regression/defect reproduction + **security audit (security vulnerabilities/permissions/user privilege escalation/data privilege escalation)**. Does not = fixing bugs or writing implementation (fixtures require card authorization), UI design, research.
- **Assistant**: does = video download and video text parsing (dispatched via Elon, the sole entry point), speech-to-text (ASR), subtitle OCR and speech cross-alignment, marketing, operations, customer support, and other odd jobs with no clear boundary. Does not = business code implementation (Linus), UX design (Jobs), functional testing (Turing).

### ⑩.1 Task-Card Review Participants (determined dynamically, not a fixed roster)

> **Who reviews a task card is determined by the workers the card actually involves; it is not fixed that "some set of agents all review".**

| Card nature | Review participants |
|---|---|
| Involves development (assignee or deliverables related to implementation) | Linus (engineering feasibility) |
| Involves verifiability (Acceptance measurable, test points complete) | Turing (verifiability) |
| Involves product/UX design | Jobs (design) |
| Purely internal chores / none of the above | Only the assignee confirms; no multi-party cross-review needed |

- Elon organizes the review: dispatch the relevant workers in parallel to review the task card, collect, then summarize; undivided technical corrections are written back directly by Elon, cognitive differences are escalated to the operator for a decision; only after confirming line-by-line "no omissions, no differences" is it dispatched.
- For the full card-splitting SOP (splitting scope/review gatekeeping/serial dispatch), see Elon AGENTS.md "Task Card Splitting SOP".

**By flow (added 2026-10-13, T-20261013-234110)**: the participant set of a card **is its flow's chain** (`§⑩.5`) —
**A** = Jobs (prerequisite contract, then design-dimension confirmation) + Linus + Turing (independent verification + conformance matrix) + Elon (final acceptance audit);
**B** = Linus + Turing (reproduce → pass + regression) + Elon;
**C** = Linus + Elon, with Turing/Jobs entering through the **rolling sample** (Turing machine sample 20%/week; Jobs visual spot-check on the same batch), or one **asynchronous** Jobs visual pass when the change is visually non-trivial.
A flow's chain **does not remove** the review participants the card's nature demands in the table above; the flow decides **who reviews the card at intake and whose reports Elon audits at acceptance**, not whether review happens.

---

### ⑩.2 Composite Task = Subtask Cards + Dependency Graph (DAG)

- **Split**: a composite task creates a `kind:epic` parent card (container/aggregate, **not claimable**); units become **child cards** (`parent=<epic>`, ordinary cards).
- **Registration is all-at-once; dispatch may be batched** (added 2026-10-13, T-20261013-010610): when a requirement has to be built out in **more than one batch**, **create the epic first and register *every* batch as child cards in the same pass** (`task.spawn <epic> title=… assignee=… [depends_on=…]` per child; register the roster by enumerating `task.children <epic>`); later batches may sit as `todo`/`backlog` **placeholders**. **Only the dispatch/release step may be batched** — release the next batch when the previous batch's cards are accepted. Registering batch 1 and stopping is a violation: nothing downstream (`task.children`/`task.deps`/`task.rollup`) can see a batch that was never registered, so the epic would look finished while the rest of the requirement is silently lost. This is **consistent with the aggregation semantics below** (parent `done` = all children `done` **+ integration acceptance**): an early placeholder child correctly holds the epic open until every registered batch is finished.
- **Parallel/temporal**: child cards add `depends_on:[predecessors]` (store predecessors only; cross-parent allowed); no dependency ⇒ parallel, with dependency ⇒ serial (resource-aware parallel reuse).
- **Relations only via ACL**: `task.spawn/depend/undepend/children/deps/rollup`; **at write time** validate invariants (reject cycles/self-reference/dependency on ancestors/deep trees/over-long chains/fan-in), returning reason codes.
- **Claim guard**: `kind:epic` is skipped; if `depends_on` is not all done ⇒ `deps_unmet`, not claimed (no new status added). **Review cards must not `depends_on` the card under review**: for a card with non-empty `review_of`, the dependency entry equal to `review_of` is exempt (all other entries still apply) — that relation is carried by `review_of`, and the reviewed card stops at `in_review` and never reaches `done` first, so the entry would be permanently unsatisfiable (contract detail: `guides/task-interface.md §10`).
- **Aggregation**: parent card `done` = all child cards done **and integration acceptance passes**; if any child card is blocked/canceled ⇒ the parent card is blocked/canceled (`task.rollup`).
- **Invariants (I1–I13)**: see the team proposal document; **patrol**: relation invariants enter the patrol gate; **archive protection**: referenced cards cannot be archived.
- **Hierarchy/shape**: **follows the provider base (meerkat-taskpanel)** — **single parent, no cycles/self-reference, chain length ≤8, fan-in ≤8**; **supports multiple levels (a parent must be an epic; intermediate nodes are epics)**; the team sets **no additional depth number** (how deep to split ⇒ see §⑩.3 granularity principle).

### ⑩.3 Carding Granularity & Breakdown Authority (2026-10-09)

- **Card creation / breakdown is unified in Elon** (the sole card creator); **Jobs/Linus/Turing/Simons/Assistant may only "request a card from Elon"** (state the need / the gap found) — they **must not create or split cards themselves**.
- **Granularity principle (anti-over-split)**: one card = **one "independently acceptable delivery unit"** (clear Goal/Acceptance, assignable to a single person, closable on its own). If one card contains **multiple independently acceptable units** ⇒ **it should be split**; if a split-out child is **too small to have independent acceptance value** ⇒ **it should not be split** (merge it). **How deep to split = adjudicated by Elon under this principle.**
- **Soft guardrails (alert, not hard block)**: patrol **warns** on "**deep chains** (chain length approaching the base limit, e.g. ≥5)" and "**fragmented cards** (too many child cards / granularity too small)", for Elon's manual review.
- **Registered-but-undispatched batches (added 2026-10-13, T-20261013-010610)**: patrol **warns** when an epic has **already released a batch** (the epic is `in_progress`, or some child has left the placeholder state) yet still holds child cards parked in `todo`/`backlog` **beyond a threshold** (default 48h) — the "first batch built, second batch forgotten" pattern. **Basis (machine-checkable)**: the signal is entirely in card frontmatter (`kind`/`status`/`parent`/`status_changed_at`), so it lands as a **`warn` in `check-relations.mjs`** (invoked by the `check-all` gate patrol per §⑳.1), **not** on the `task-patrol` stale-heartbeat channel (whose object is a stalled *worker*, `§⑥.4`) and **not** a hard gate — exit code is unchanged, decisions stay human (§㉔.7). The threshold is overridable via `OPENCLAW_TEAM_EPIC_TODO_WARN_MS`.

### ⑩.4 Card Granularity ⇔ seg Usage (2026-10-13, T-20261013-013438)

> A card carries **one Acceptance**; a `seg` is a further session *inside* one card. Opening segs is an execution-level tool, **not** a way to cope with "the card is big" — the team's actual practice for large work is to **split cards**. This clause fixes when a seg is legitimate.

- **Criterion (one line)**: ask whether the two segs are the **same Acceptance**. Same Acceptance ⇒ a seg *may* be legitimate (and only if it fits the whitelist below); different Acceptance ⇒ **split the card**.
- **The intuition, rewritten explicitly**: **"card is big ⇒ split the card"** (NOT "card is big ⇒ open a pile of segs"). Opening segs to cope with size uses an execution tool to hide "the breakdown was not done".
- **seg whitelist (only these four; each must still share a single Acceptance)**:
  1. **the current lane cannot reach the environment** (the run must continue in another window — deterministic UUIDv5 + resume, `§⑥`);
  2. **bounded retry** where reopening the whole card costs more than re-running the failing seg;
  3. **≥2 mutually-exclusive file families + a single acceptance** run as parallel probes (splitting into cards would make each demand its own acceptance);
  4. **independent verification isolated from the author** (fresh context, no anchoring — anti-confirmation-bias).
- **Split triggers (any one ⇒ split the card; do not open a seg)**: ① a **second independent Acceptance** appears; ② **≥2 independently-acceptable deliverables**; ③ a different **phase / delivery surface**; ④ a fix touching **more than one Acceptance**; ⑤ **different roles** must accept separately.
- **Anti-patterns (forbidden)**:
  ① opening a pile of segs because "the card is big" ⇒ the correct action is **split the card**;
  ② **phase / delivery-surface segmentation** ⇒ should be **epic child cards** (`§⑩.2`, each with its own Acceptance/claim/acceptance);
  ③ **fix–fix–fix retry segments** ⇒ should be a **defect/fix card** (`§⑨`);
  ④ "**the context is just too long**" is not a reason to open a seg — it is a reason to **split the card**.
- **Carding enforcement (hard gate)**: `roles/elon/AGENTS.md` §1 (Task-Card Breakdown SOP — Breakdown Scope), carried **alongside the batch-carding hard rule**: expecting ≥2 independent Acceptance or ≥2 independently-acceptable deliverables ⇒ judge whether to split / build an epic **before** carding.
- **`__team__` cards must declare `target` (hard gate; 2026-10-13, T-20261013-015831)**: a card with `project: __team__` **must** carry a `target`, one of the two meanings — **framework change (write the repo)** ⇒ `/Users/tanyu/Documents/openclaw-team`; **deploy/ops on live** ⇒ `/Users/tanyu/.openclaw/team`. Rationale: `spawn-lane` resolves cwd from `project` and, with **no `target`**, silently falls back to the **live** team root (`§⑥` cwd normalization) — so a missing `target` is exactly the hole through which a card "about the framework" ends up writing live. **A `__team__` card with no `target` is therefore a carding defect ⇒ hard red** (`check-card.mjs`: machine-readable `[role] <owner>` tag + exit≠0), not a soft warning. **Scope of the check = non-terminal cards only** (2026-10-13, T-20261013-023535-2): the gate exists to catch a **carding-time** defect, so cards already in a **terminal** state (`done`/`failed`/`canceled`) are **grandfathered** — the gate does **not** retro-redden history (`check-card.mjs` narrows on `!TERMINAL.includes(status)`, the complement of the provider's `TERMINAL_STATUSES`; `ready`/`todo`/`backlog` stay in scope, since `spawn-lane` exec auto-claims `ready`/`todo` and would land on `cwd=live`).

### ⑩.5 Flow Triage A/B/C — Change-Nature Routing + Quality Spine (2026-10-13, T-20261013-234110)

> **Why**: every change used to walk one long chain (Jobs design → Linus → Turing → Jobs acceptance → Elon), a parameter-level UI tweak included; the TaskPanel evidence also showed the opposite failure — a design treated as a **reference** instead of a **contract**, so blocks went missing and stayed missing for 5 days. This clause routes by the **nature of the change**: a small change takes the short chain **without** weakening the machine gate.
> **Judgement**: Elon judges the flow **at intake** and records it on the card — `flow: A|B|C` (a team-side convention field; the provider schema is unchanged, `§⑯`). A change that turns out to cross the hard boundary below ⇒ **re-route to A on discovery**; the short chain never traps an A-class change.

| Flow | Trigger (criteria) | Chain | Quality gate |
|---|---|---|---|
| **A · feature / design-bearing** | new UI structure or block, new interaction, new or semantically changed copy, product-logic change, design-system / token **definition** change | **Jobs prerequisite contract (`§⑩.6`) → Linus development → Turing independent verification (functional + requirement→implementation conformance matrix) → Jobs design-dimension confirmation → Elon final acceptance audit** | full: block list + assertions + screenshot comparison |
| **B · defect / behaviour fix** | fixing behaviour; restoring consistency with an **already-frozen** design; **produces no new design decision** | **Linus fix → Turing verification (reproduce → pass) + regression → Elon final acceptance audit** | reproduction test + (when UI is touched) the assertion subset |
| **C · UI micro-change / detail** | parameter-level change **inside the frozen design**: spacing, token **value**, alignment, wording of already-decided copy, visual polish; **no new block, no new interaction, no product logic** | **Linus → Elon final acceptance audit** (2 steps) | **machine assertion subset must pass** + sampled independent re-check |

**Hard boundary (any one ⇒ always A, never B/C)**: **new UI structure / adds a visible block / changes interaction behaviour / changes the semantics of product copy / product-logic change / changes a design-token definition** — the enumeration is the closed form of the **flow-A criteria row** of the routing table above, so a change that reads as A there can never be routed as B/C here. When in doubt the card goes A — a longer chain beats a missed design decision.

**Quality spine (5 safeguards — the chain may shrink, the spine may not)**:
1. **Frozen design contract** (Jobs, **once per surface**) — block list (name / id / `data-*` / selector) + assertions + design tokens, landing in `workspace/<task-id>/`; **a UI surface with no machine-checkable contract does not start**; B/C **reuse** the frozen contract and produce no new one.
2. **Delivery gate** (Linus, **mandatory for A/B/C**) — the relevant assertion subset passes and the self-proof (build / exit code / `--json` artifact pointer) is in the Report **before** delivery; red ⇒ **not deliverable** (`§⑨.1` Addendum III).
3. **Independent verification** (Turing) — A = functional **+ requirement-conformance matrix** (block/REQ → evidence); B = reproduce → pass **+ regression**; C = **sampled** (below).
4. **Design-dimension confirmation** (Jobs, **A only**) — **evidence-based**: read Turing's matrix + assertions + screenshot comparison to judge "was it built to the design"; **no re-doing, no re-running**.
5. **Elon report audit + rolling sampled patrol** — the statistical safety net that replaces "Elon re-does the verification himself" (`§⑨.1` reinforcement).

**Report set audited by flow (Elon's final acceptance — a PASS on one report never substitutes for the others, `§⑨`)**:

| Flow | Reports Elon must audit |
|---|---|
| **A** | Linus (implementation/self-proof) **+** Turing (independent verification + conformance matrix) **+** Jobs (design / design-dimension confirmation) |
| **B** | Linus **+** Turing |
| **C** | Linus (**+** the sampling verifier's report when this card was sampled) |

**Three locks against "not built to design + spec not enforced"**: ① **design = contract** — no machine-verifiable block list/assertions ⇒ the UI card is invalid; ② **delivery gate mandatory** — red assertions ⇒ not deliverable; ③ **drift = defect class** — missing blocks / self-invented structure / silent simplification ⇒ **defect ticket + card `blocked` + revert through the `§⑨` loop**, and a **missing conformance matrix ⇒ Elon sends the card back**.

**Card template scales with the flow**: **A** = 3+ Acceptance items (block list + machine-check assertions + screenshot comparison); **B/C** = 2 items (the applicable gate + the evidence pointer). What shrinks is the **Acceptance surface**, never the evidence requirement.

**Rolling sample (the statistical safety net)**: Turing machine-samples **20% per week** of the B/C cards that were accepted, and Jobs visual spot-checks **the same batch**; a drift found by the sample ⇒ defect ticket, and the finding tightens **the class**, not just the spot (never fix only the single occurrence). The sample is executed by Turing/Jobs; Elon **audits their reports** (he does not run it).

**Sampling rule (executable — 2026-10-14, T-20261014-003241)**: the weekly unit is the **B/C cards accepted during that week**, counted **by card**; the sample size is **20% of that count, rounded to the nearest integer and never below 1** (`max(1, round(0.2 × N))` — so a week with a single accepted B/C card still samples that one). **Turing** draws the cards and re-runs the **machine assertions**; **Jobs** visual-spot-checks **the same batch**; both reports go to Elon as **one batch**, which is the report set he audits for the sampled cards (never card by card, and never a substitute for the per-card delivery evidence).

### ⑩.6 Jobs Prerequisite Task (design contract / PRD) — a hard dependency of the dev card (2026-10-13, T-20261013-234110)

> **Origin (operator ruling, 2026-10-13)**: Jobs iterates with the operator over several rounds and only then settles **one complete product design prototype**; **at that point** the development cards are created for Linus in one pass. In that case Jobs **must first produce a "prerequisite task"** (the design contract / PRD document = the design baseline), and the **development card depends on that prerequisite**.

**Rules**:
1. **Trigger**: flow **A** whose implementation baseline is a design that is **not yet frozen** (in practice: every UI feature card sourced from Jobs). B/C **reuse** the frozen contract and need no new prerequisite card.
2. **Form**: Elon creates the prerequisite card (**`assignee: jobs`**, with its own Acceptance); Jobs produces the design contract — PRD / `DESIGN.md` / prototype structural contract + `ui-align` block list + machine-check points — into `workspace/<task-id>/`. A **product design document** still passes the "Jobs authors → Elon confirms" dual-sign gate (`roles/jobs/AGENTS.md`).
3. **Dependency (hard)**: the development card carries **`depends_on: [<prerequisite card>]`**; while unmet it is `deps_unmet` and **must not be claimed** (`§⑩.2`). "Jobs is still designing, Linus starts anyway" is precisely the hole that produced the 5-day-unnoticed drift.
4. **Multi-round design iteration stays inside the prerequisite card**: the operator-facing design rounds are the prerequisite task's **production/review loop** (`roles/jobs/AGENTS.md`), **not** development segs (`§⑩.4`); only the **frozen** output is handed to Linus.
5. **Re-entry on contradiction**: if implementation shows the contract is wrong or self-contradictory ⇒ Linus sets the card `blocked` and sends it back (`§⑦`, `§⑨.1` Addendum II clause 3); Elon routes it back to Jobs as a **design change on the prerequisite** (revision / new prerequisite card), never as a silent in-card deviation.
6. **Reuse is the point**: once frozen, the contract serves **every** B/C card on that surface — it is produced **once per surface**, not once per card (`§⑩.5` quality spine #1).

---

## ⑪ Out-of-Bounds Handling

If a worker receives a task card outside its own duties → **do not execute**, set the card `blocked` + send back to Elon explaining the correct owner and rationale; Elon reviews and reassigns or redefines. A worker must not reassign on its own or silently discard it.

---

## ⑫ Two-Way Document Sync (backfill after acceptance)

> Origin: normally design docs guide development, but during iteration code is often "finished per requirements while docs lag"; the acceptance step must catch the docs up, and the acceptance criteria must be set when the card is split.

1. **The card includes the doc criterion at creation**: if a card touches a [interface / data structure / architecture / config / convention] change ⇒ Acceptance must include one of:
   - explicitly list the **design docs + sections to sync**; or
   - explicitly declare "**no documentation impact**" with a rationale (cannot be omitted).
2. **Acceptance checks the docs**: Elon's final review adds a "documentation-impact determination" — comparing against the diff, judge whether the card triggers a design-doc update; if a sync was needed but not done ⇒ **reject** or open a "doc sync card".
3. **Reverse backfill loop**: when code leads the docs, **after acceptance passes** Elon triggers the reverse update (what the card already touched is synced along the way by the implementer; cross-card accumulated lag is opened as a doc sync card by Elon); when done, record in `memory/YYYY-MM-DD.md`.
   ⇒ The loop = requirements → code → docs backfill, ensuring "docs never lag behind code".
4. **Reference convention**: when syncing, follow §⑥.1 clause 11 — write only "`"Document name" §Section name`", **no line-number anchors**.
5. **Ownership**: design docs belong to their repo (e.g. the project's design-docs subtree under `docs/`; independent dual repos see §⑥); other projects follow their repo rules.

---

## ⑬ Universal Hard Discipline (applies to all 5 roles)

> The following are **permanent hard disciplines** across roles; each role's AGENTS.md **only references these clause numbers and no longer copies the text**, keeping only one line of "redline quick-reference + §anchors".
> **Distribution mechanism**: the canonical redline quick-reference block = `team/guides/redlines.core.md`, injected by team tools into each AGENTS marker block with consistency validation (anti-drift).

### ⑬.1 Silent When Idle
After being woken by poll, if there is no new `todo` card to claim, no `in_progress` card to advance, and no Elon decision/escalation needed ⇒ **stay silent** (no "no active tasks" empty receipts). Send back to Elon only for: ① claimed a new card ② key progress/milestone ③ completed a Report ④ card set blocked pending clarification ⑤ found an anomaly needing coordination.
### ⑬.2 The Three End-of-Segment Closing Items (all required)
Any "segment/subsession" end must, in order: ① refresh `heartbeat_at`; ② set the card's terminal state (`in_review`/`done`/`canceled`/`blocked`); ③ `sessions_send` back to Elon a Report (conclusion + card absolute path + commit hash). **"Finish and quit" is forbidden**; pausing to await external conditions must explicitly set a state and send back an explanation. If a segment has multiple subsessions, close them out together when the last segment completes.
### ⑬.3 Unified Claim Path
Claiming a task card **always goes through `task.claim`** (`taskctl claim <card> <assignee>`); **bypassing** (equivalent atomic writes / directly editing frontmatter status) is forbidden. task.claim and cron poll share the same lock; bypassing causes double-claiming by direct dispatch and poll.
### ⑬.4 Token Trimming
Worker sends always follow "**conclusion + card absolute path + commit hash**"; test output/logs/long tables/screenshot paths only land in the card and `workspace/`, and **do not enter inter-session messages**; `*.out.jsonl`/`*.zst`/any log >100KB **never enters context**.
### ⑬.5 Decision Fork First
If a task has a decision fork (interaction paradigm/tech selection/convention/sample interval, etc.) ⇒ draw the "design tree + frontier" before acting; what you can check yourself (code/docs/competitors) you check yourself, and send back only the subset "needing Elon's decision" (each with a recommendation); start only when the frontier is empty. Output lands in `workspace/<task-id>/design-tree.md`. Simple tasks with no fork do not go through the ritual.
### ⑬.6 Minimal "In-Person" Self-Check
Each role's AGENTS.md keeps 3–5 lines of startup self-check (read card + read PROTOCOL → claim via `task.claim` → write `state.md` at segment end + check Acceptance line-by-line before terminal state → trim the Report); the rest references this clause.

### ⑬.7 Task-Change Trail
**Substantive changes** to a task card (Acceptance / Background / scope / assignee / priority / target / convention, etc.) **must** be trailed via `task.comment <card> <author> change <what+why>` (attach before→after if needed); only ordinary state-machine transitions (a `set-status` that does not change card content) do not need it. Purpose: changes are traceable and auditable.

## ⑭ Confirmation Gate (unified)

- **Triggers**: ① finalizing plan.md for development tasks (Linus four-stage SOP stage 2.5); ② finalizing product design docs (Jobs).
- **Responsibility**: the worker `sessions_send`s back to Elon (plan/doc path + goal + key decision summary + open items).
- **Action**: Elon reviews against Acceptance/Background; routinely confirms on its own; major/disputed/involving-funds-security/architectural-direction items are escalated to the operator.
- **Evidence**: the confirmation message goes into the card's Progress; product design docs must record "Elon confirmed (dual-signed)".
- **Check**: without confirmation, do not proceed to execution and do not use it as a downstream basis.
- **Timeout**: see §⑮ for wait limits; timeouts are handled by Elon's patrol.

> **Two-layer document model (T1 decision)**: **L1 (this file) defines mechanisms and numbering**; **detailed methods and local rules belong to L2 (role AGENTS.md) and L2.5 (`workspace-<role>/guides/`, `skills/`)**. The "L1 summary + L2/L2.5 delegated detail" pattern is **legitimate**; **verbatim copying is forbidden** (the same text copied in ≥2 places = a violation; it should be lifted to L1 and changed to a reference).

## ⑮ SLA / Timeout Escalation Table

> Measurement start = the card's `blocked_at` / `status_changed_at` (§① schema). **Working hours**: Asia/Shanghai daily 09:00–23:00; off-hours roll over.
> **Executor**: all "escalate to operator" actions are **performed by Elon** (workers have no direct channel, see §⑤); the §⑮.1 exception channel is enabled only when the team is stalled.

| Wait scenario | Normal limit | Action on expiry (handled by Elon's patrol) | Further timeout |
|---|---|---|---|
| blocked awaiting Elon's clarification | ≤ 2h | Must handle (clarify/revise/reassign) | > 24h ⇒ escalate to operator |
| Confirmation gate awaiting review (§⑭) | ≤ 4h | Must review | > 24h ⇒ escalate to operator |
| Defect fix card creation (⑨) | ≤ 24h | Must create and dispatch to Linus | > 48h ⇒ escalate to operator |
| Product/UX acceptance queued (⑨.1 last section; **flow A** — B/C are covered by `§⑩.5`, no per-card Jobs card) | ≤ 24h | Must create a review card and dispatch Jobs | > 48h ⇒ escalate to operator |
| Worker heartbeat stale (§①) | 30 min | Same assignee re-claims | > 6h ⇒ any agent may claim + report |
| Elon patrol stalled | > 60 min no action | — | Per the §⑮.1 contingency / operator appoints a proxy |

### ⑮.1 Worker → Operator Exception Channel (team stalled only)

- **Trigger condition**: Elon is stalled (patrol/dispatch > 6h no action) and a worker judges the team cannot advance.
- **Method**: send to the operator via the `message` tool, with the title prefixed `[exception direct report]`.
- **Boundary**: **only when the team is stalled**; routine escalation always goes through Elon.

## ⑯ Terminology Conventions

- "**End user**" = the human **operator** (human channel/local TUI); all docs uniformly say "operator".
- `agent:main:main` ≡ **Elon** (two spellings of the same subject).
- **leader** = the team coordinator (currently = **Elon**); the card field is uniformly **`notify_leader`**, **never hard-coding a person's name** (renaming the leader does not affect the schema or cards).
- **The role roster** in this file's "Team Roles" table is the **sole authority (5 people)**; each `SOUL.md` "positioning" no longer lists its own roster and instead references this table.
- **State-machine vocabulary**: the canonical 7 values `backlog` / `todo` / `in_progress` / `in_review` / `blocked` / `done` / `canceled` (= the canonical names for the old `ready`/`failed`; worker text must not use terminal words outside this table).
- **Model tier**: default `deepseek-flash`; high complexity upgrades to `deepseek-v4-pro`; visual tasks see ⑥.2. **Specific model names appear only in this file (L1)**; role files uniformly reference ⑥.2 and never write specific models (to prevent L2/L3 drifting from L1).
- **Flow vocabulary**: **`flow: A|B|C`** (`§⑩.5`) = the **change-nature route** recorded on the card — **A** feature/design-bearing, **B** defect/behaviour fix, **C** UI micro-change inside the frozen design. It is a **team-side convention field** (the provider schema is not changed). The **combination** "flow + status/state" is written with the canonical 7 status words only (`§⑯` state-machine bullet); "flow" never replaces the participant set the card's nature demands (`§⑩.1`).

## ⑰ Document-System Layering and Single Source of Truth

**Layering (each layer has a single responsibility; crossing layers is forbidden)**: L0 config (`openclaw.json` identity) | **L1 this file** (cross-role mechanisms/discipline; numbering only grows, never changes) | **L2 role AGENTS.md** (role SOP, references L1 only) | **L2.5 role method library** (`workspace-<role>/guides/` details + `skills/`; on conflict, guides prevail) | **L3 SOUL** (creed/style, no dates/card numbers) | **L4 USER** (communication model/work profile) | **L5 memory and evidence** (`memory/`, `workspace/<id>/state.md`, `README.md`).

**Hard rules**:
1. **Anything with a date / card number / commit / one-off decision record → goes only to L5**; but **permanent operational conventions with an effective date** (e.g. "video sole entry point") stay in L2 (drop the date or note the effective date).
2. **Verbatim copying forbidden**: the same text appearing in ≥2 places is a violation; it should be lifted to L1 and changed to a numbered reference.
3. **L1 summary + L2/L2.5 delegated detail** is legitimate (see the §⑭ two-layer model).
4. **Reference transmission**: before a worker spawns a subsession, it must **transcribe the referenced L1 constraints into CLAUDE.md / the subsession prompt** (otherwise the subsession layer has no constraints).
5. **Broken-reference periodic check**: Elon's patrol includes a "§x reference resolvable" lint (periodic, not one-off).

## ⑱ Research Convention Hard Constraints (applies to research outputs)

- Do not speculate; if the convention is undecided, first follow §⑬.5 (decision fork first).
- Any conclusion (metric/experiment/comparison) **must attach the convention + reproducible commands + output trail**; missing = considered incomplete.
- Research items go through the **full lifecycle**: definition → single-item analysis → evaluation (out-of-sample/robustness) → conclusion and disposition; do not skip stages.
- A research Report missing "reproducible commands / data convention" ⇒ check fails.

## ⑲ All-Hands Work Creed

1. **Conclusion first, evidence-driven**: deliveries must carry verifiable evidence (command+output / screenshot / path); never fabricate.
2. **Read before write**: read PROTOCOL and the full task card before acting; when context is missing, prefer to ask back.
3. **State discipline**: strictly follow the card state machine; refresh `heartbeat_at` every ≤10min while executing.
4. **Least privilege**: write only paths the task card allows (default `~/.openclaw/team/**`); everything else is read-only.
5. **No speculation**: ambiguous requirement ⇒ set `blocked` + send back to Elon to clarify; do not fill in gaps yourself (Elon's own ambiguities are clarified with the operator).

> Each role's `SOUL.md` "work creed" references this clause and does not copy the text.

## ⑳ Gates and Archiving

### ⑳.1 Machine-Checkable Gates (landed as scripts, invoked by CI/commit hooks/patrol)
| Rule | Gate | Landing point |
|---|---|---|
| Prototype must not contain implementation (§⑨.2) | Prototype gate script (exhaustive banned-token set; path resolved by `lib.get_project`) | Project CI / pre-commit |
| UI structural contract (§⑨.1) | Selector assertions (artifact = selector-manifest JSON + runner; spec in `team/guides/ui-align-assert-spec.md`) | Must be attached to the card's Acceptance |
| Worker Report trimming (§⑬.4) | Report body threshold / large-table warning (merged into `token-hygiene`) | Patrol |
| Research-type Report (§⑱) | Warn on missing "reproducible commands / data convention" | Patrol |
| Broken references | `§x` reference resolvable lint | Patrol (periodic) |

- **Aggregation and the scheduled verdict (T-20261013-031036)**: `scripts/check-all.sh` is the **single source of the checks** (default `--segment all` = the full historical run, for humans and CI). The **scheduled** gate is `scripts/check-all-gate.mjs`, whose contract is that it returns a **real verdict inside the trigger-evaluation budget** (`team/AUTOMATIONS.md` §3.5/§3.5.1): the **fast** segment runs in-band, the **slow** framework suite runs **detached** and its verdict is cached (`<team>/.check-all-slow.json`) and folded into the next evaluation. The slow axis **fails closed** — a missing/stale/unreadable cached verdict is *unconfirmed* ⇒ alert, never green. A red verdict **must carry the failing items in `message`**: a timeout or any other degrade must never *mask* a real failure (that masking, not the cost, is what broke the gate before).

### ⑳.2 Not Machine-Checkable (converted to manual/post-hoc; **must not falsely claim it is gated**)
- **No bare commit**: the hook layer cannot access the `git commit` command line; instead use a commit wrapper or a commit-msg trailer + CI comparison of "the staged path set == the card's declared path set".
- **No bypassing task.claim**: warn only on hard contradictions like "`in_progress` with empty `claimed_by`"; and add a lock audit log to `task.claim` for traceability.
- **General business-code provenance, reasonableness of model selection**: checked post-hoc by Elon/Turing.

### ⑳.3 Card Archiving
- `tasks/archive/YYYY-MM/`: a card set to `done|canceled` for 7 full days ⇒ archived by meerkat-taskpanel (`taskctl`) into this directory; the trigger layer scans only unarchived cards.
- Executed by Elon's routine patrol; the rule is recorded in `README`.

---

## ㉑ Release and Versioning

> Object = the **version and release of a product/deliverable**. Method: `guides/release-versioning-sop.md`. Cross-references (not copied): `§⑥` (git discipline) / `§⑨.3` (container-form acceptance) / `§⑫` (doc sync) / `§⑭` (confirmation gate) / `§⑤.1` (outward publication approval).

1. **Single version source**: each deliverable's outward version number has exactly **one source of truth** (e.g. the package manifest); every other place references it — no hand-written copies.
2. **semver**: MAJOR = incompatible outward change / MINOR = backward-compatible addition / PATCH = backward-compatible fix; during `0.y.z` a MINOR may carry an incompatible change but the changelog must state "incompatible"; **build metadata** (`<semver>+<build>`) is separate from semver, is not compared, and is not hand-written.
3. **Tags**: releases are `vX.Y.Z` (pre-release `-alpha.N` / `-rc.N`), always **annotated**; a version is tagged once and never moved/force-pushed (`§⑥`); a wrong tag ⇒ bump PATCH and re-release.
4. **changelog ↔ tag one-to-one**: every `vX.Y.Z` has a same-named changelog section (missing ⇒ the release gate fails); the changelog is written **on merge** (`[Unreleased]`) and the release only **freezes** it; breaking entries are marked **BREAKING**.
5. **Three-phase release checklist**: pre-release (tests green / coverage met / lint / **container-form acceptance `§⑨.3`** / CI green / version source updated / changelog frozen / **doc-impact determination `§⑫`** / approval) → release (annotated tag / trigger the build / artifact verification / **tag ↔ changelog ↔ artifact version agreement**) → post-release (smoke in the target form / **reverse backfill `§⑫`** / trail / observation window / exceptions → incident response). Do not advance past a failed gate.
6. **Rollback = forward edit**: every rollback is a **forward edit + normal commit** (re-release the previous verified version with a **new PATCH**); **forbidden**: `git revert/reset/restore/stash/clean/checkout --/push --force` (`§⑥`); when data has **no backward compatibility**, **do not roll the data back directly** — use **forward repair**. The rollback/forward-repair **decision is approved by Elon** (major upgrades by the operator); **execution belongs to Linus**.
7. **Release approval and trail**: outward/production releases are **approved by Elon**; major changes (MAJOR / breaking / involving data migration) escalate to the **operator**; dev/staging internal validation is self-reviewed with a trail. Every release/rollback is recorded as `task.comment kind=confirm` (version / tag / channel / approver / time / artifact link / changelog section). Outward publication itself still follows `§⑤.1`.

---

## ㉒ Runtime Observability (product-level)

> Object = the **runtime state of the delivered product/service** (logs / metrics / alerts / health / inspection); **not** the team's own gateway recovery handbook (`team/README.md §4 Recovery Handbook`). Method: `guides/runtime-observability-sop.md`.

1. **Structured logs**: product logs are **JSON lines** through a single wrapper; **no bare `print`/`console.log`**. Required fields (missing one = non-conforming): `ts` (with timezone) / `service` / `env` / `request_id`|`task_id` / `trace_id` / `level` / `msg`.
2. **Log redaction (hard rule)**: secrets / tokens / credentials / PII **never enter logs**; the wrapper does field whitelisting + value-level redaction; never dump whole request bodies/configs. Redaction failing ⇒ do not deliver.
3. **Minimal metric set**: latency percentiles **p50/p95/p99 (never averages)**, request volume / error rate / saturation / queue depth / key business volume; naming `<service>_<subsystem>_<metric>_<unit>`; must be **programmatically scrapeable** (`/metrics` or OTLP), not log-text only.
4. **Alerts must be executable**: every alert carries **five elements** (trigger condition / threshold / impact / **runbook pointer** / escalation target); missing one = do not ship; deduplicated + suppressed.
5. **Health endpoints separated by semantics**: `/health` (liveness, self only, fail ⇒ restart) and `/ready` (readiness, checks dependencies, fail ⇒ de-pool, no restart) **must be separate**; never mixed.
6. **Routine inspection**: daily health/ready all green + no new P1 error cluster; weekly metrics within thresholds + no "non-executable alerts"; monthly log rotation healthy; criteria must be decidable (green/amber/red) — no "looks fine".
7. **Product inspection ≠ team check-all** (`§⑳.1`): **cannot be merged and cannot substitute for each other**.

---

## ㉓ Product Incident Response

> **Object = a product/service production incident**; different from `§⑮` (team collaboration SLA) / `§⑮.1` (team stalled), which are **different objects and not interchangeable**. Criterion: a failure in production ⇒ this clause; collaboration stuck ⇒ `§⑮`; orchestration stalled ⇒ `§⑮.1`. Method: `guides/incident-response-sop.md`.

1. **Severity S1–S4** (impact × severity × duration + **red-line factors**: any of data / money / security ⇒ bump severity, at least S2, usually S1): S1 ack immediately, mitigate ≤30min, postmortem ≤72h; S2 ack ≤30min, mitigate ≤4h, postmortem ≤72h; S3 ack ≤4h, mitigate ≤24h; S4 routine. Working hours 09:00–23:00; missing a mitigation target ⇒ **escalate one level** with a trail.
2. **on-call / first response**: first response = the on-duty engineering owner (default **Linus**); the only human-facing channel = **Elon** (`§⑤`); if the rotation table is undecided ⇒ mark as a **gap**, defaulting to "Linus engineering first response + Elon coordination/outward". A handover must explicitly transfer the open incident's severity/state/done/pending/evidence.
3. **Seven-step response**: detect → classify → stop-loss/mitigate → localize → fix → recover → confirm by observation; **recover before root-cause**; no refactoring during an incident; fixes are forward edits passing tests (`§⑥.1`), no destructive git (`§⑥`).
4. **Recovery confirmation**: requires **reproducible evidence** (command/output/metric/key-path real run), in the target form (`§⑨.3`); if verification fails ⇒ the incident does not close.
5. **Escalation**: technical worker→Elon; business/money/security Elon→**the operator** (red-line factors escalate immediately regardless of level; S1 immediately); only Elon escalates to the operator. Elon unreachable ⇒ switch to `§⑮.1` (product technical handling still follows this clause).
6. **Communication**: internal conclusion-first, trimmed (`§⑬.4`); S1 every 15–30min, S2 hourly; outward always through Elon (`§⑤.1`); no blame / no guessing root-cause / no promising uncontrolled timelines.
7. **Blameless postmortem**: S1/S2 mandatory ≤72h, S3 recommended ≤1 week; aimed at **systems and process**; each action item has **owner + deadline + landing point + verification** (no owner/deadline = undefined); action items are **carded by Elon**, engineering defects follow `§⑨`; exposed gaps are backfilled into the guide and check-all/CI per `§⑫`.

---

## ㉔ Data / DB Migration Discipline

> Object = a product/project DB/schema evolution; a **different object** from `§③` (collaboration-structure invariants). Method: `guides/data-migration-sop.md`.

1. **Forward-compatible first (Expand→Migrate→Contract)**: add-only first (new nullable columns / tables / indexes; no `DROP`/rename/type change/`NOT NULL` before backfill) → backfill/double-write + verify → remove the old path (after confirming no reader depends on it). No single-step destructive change straight to production.
2. **append-only**: migration scripts are written once and only added to; applied migrations are **never edited** — corrections open a **new migration**; naming `NNNN_lower_snake_name.sql`, sequence strictly increasing and unique.
3. **Rollback = forward edit** (per `§⑥`): no reverse schema / dropped tables / destructive git; with backward compatibility ⇒ switch back to the old code (data untouched); without ⇒ **forward repair**. Data deletion: files via `rm` + `git commit -- <path>`; rows via a new migration `DELETE` with a trail.
4. **Pre/post validation + idempotency**: every migration carries pre/post validation (row count / non-null / unique / foreign key / invariants), failing ⇒ transaction `ROLLBACK` and abort; must be **re-runnable** (version bookmark / `IF NOT EXISTS` / `ON CONFLICT`).
5. **Constraints pushed down to DB machine checks**: `NOT NULL/CHECK/UNIQUE` / foreign keys / triggers (cross-row invariants `RAISE(ABORT,<stable code>)`); co-located triggers on the same event have pairwise **disjoint** conditions; schema ↔ manifest is cross-checked by contract tests.
6. **Destructive changes pre-approved**: `DROP` / column drop / type change / data deletion **require prior approval** (`§⑭`); pure Expand/backfill is self-reviewed with a trail; every migration and rollback is recorded as `task.comment kind=confirm`.

---

## ㉕ API Compatibility and Deprecation

> Object = the compatibility and version evolution of outward / cross-module API contracts; **completes `§⑥.1 #8`'s** version/deprecation flow. Method: `guides/api-compat-sop.md`.

1. **Breaking criteria**: judged by "does this change an existing consumer's behavior" — if a consumer cannot keep working without changing code, it is breaking (field/endpoint/enum/error-code removal, type change, semantic change, required/default/status-code-mapping/route/auth change, tightened validation, pagination/response-shape change). Non-breaking = adding optional fields/endpoints, loosening validation, copy-only changes. **Whether a new enum/error-code is breaking depends on whether consumers tolerate unknown values** — trace consumers first.
2. **Consumer-impact tracing** (per `§⑥.1 #8`): before changing a contract trace ① backend call sites ② **frontend data flow** ③ cross-service/module contract (interface / event-schema subscribers) ④ docs and scripts; produce a breaking-impact list; **without a reproducible "no callers" proof, do not remove a field/endpoint**.
3. **Version carrying**: the major version = the compatibility break boundary (bumped only when breaking); within a generation `/vN/` only **adds**; to subtract or re-mean ⇒ cut `/v(N+1)/` and deprecate `/vN/`; **no silent semantic change within a generation**. Semantics reuse `§㉑` (semver is not redefined).
4. **Deprecate before removing**: ① announce (deprecation + replacement + removal window, with a `Deprecated` trail) → ② coexistence → ③ observe usage → ④ remove on expiry. **Three removal preconditions**: deprecation window elapsed + **evidence of no active consumers** + announcement trail complete. The deprecation window is decided by Elon.
5. **Contract tests / snapshots as a machine gate**: cover field names/types/status codes/error codes/pagination; the contract surface is frozen as a **snapshot artifact** in version control, and a **breaking diff blocks**.
6. **Handoff**: breaking ⇒ version magnitude and `BREAKING` changelog to `§㉑`; where deprecation approval / outward announcement is needed ⇒ `§⑭` and via Elon.

---

## ㉖ Dependency CVE Gate

> Object = scanning and gating known vulnerabilities (CVE/GHSA) in dependencies (direct + transitive); excludes SAST of first-party code (Turing's security audit) and vulnerability-fix implementation (`§⑨`). Method: `guides/dependency-cve-gate.md`.

1. **Hard gate**: scanning the dependency tree for known vulnerabilities is a **hard gate**; Critical/High **must block**, Medium warns, Low is recorded; the block threshold is decided by Elon (recommended CVSS ≥ 7.0).
2. **Time-boxed waivers**: applicable (no upstream patch / verified false positive / unreachable path); registration requires CVE id · package@version · rationale (with evidence) · expiry · approver · review conclusion; **expiry auto-invalidates and the gate reinstates**; no permanent waivers / no whole-repo blanket exemptions by package name; default waiver ≤90 days (Critical ≤30).
3. **Three scan times**: dependency change + periodic full scan (catch new disclosures) + pre-release (no unwaived Critical/High before release); missing one is a blind spot.
4. **SBOM and trail**: produce an SBOM (SPDX/CycloneDX — pick one and stay consistent) as the dependency-surface snapshot; trail the report/exit code/scanner version/threshold version; zero-dependency projects still produce an SBOM.
5. **Gate registration**: register per `§⑳.1` (machine-checkable → CI/check-all/hooks) / `§⑳.2` (not machine-checkable → manual, **never auto-pass**); waiver approval / false-positive adjudication / replacement decisions are human.
6. **Boundaries**: a suspected defect ⇒ `§⑨`; a release block ⇒ ties into the `§㉑` pre-release checklist; false positive / unreachable ⇒ adjudicated by Turing.

---

## ㉗ Performance / SLA Baseline

> Object = product/service performance thresholds and SLA/SLO; the **same word, different object** from `§⑮` (team collaboration wait times) and **not interchangeable**. Method: `guides/performance-sla-sop.md`.

1. **Latency percentile hard requirement**: performance acceptance always uses **p50/p95/p99**, **never averages**; missing any percentile is non-conforming.
2. **Machine-checkable performance gate**: pre-release / regression / capacity change / performance-sensitive key-path change must run a benchmark with a **threshold assertion** (a non-zero exit code is a failure).
3. **Metric naming single source of truth**: naming/units reference `§㉒` (`<service>_<subsystem>_<metric>_<unit>`), not re-defined here.
4. **SLA/SLO/SLI distinction**: SLI = a measured value, SLO = an internal target, SLA = an outward commitment; **the SLO must be at least as strict as the SLA**; the SLO is decided by Elon, the outward SLA by the **operator**.
5. **Real-form acceptance**: must run in the container/orchestration form (`§⑨.3`); cross-container uses actually-reachable addresses.
6. **Baseline filed and regressed**: the baseline is filed (e.g. `perf-baseline.json`: environment / sample / per-path six-tuple); regression applies absolute-then-relative criteria, both must pass; the baseline is refreshed only on a **verified** version.
7. **Landing points**: machine checks land per `§⑳.1`; threshold/path/SLA/degradation adjudication is marked `§⑳.2` (human).

---

## ㉘ Cross-Cutting Mechanisms for Post-Delivery Operations and Engineering Gates

> Merges the common mechanisms of `§㉑–§㉓` (product operations) and `§㉔–§㉗` (engineering gates).

1. **Three mutually-exclusive, non-substitutable object classes**: ① product/service runtime (`§㉑` release / `§㉒` observability / `§㉓` incident — this clause's object); ② the team's own gateway (`team/README.md §4 Recovery Handbook`); ③ team collaboration process (`§⑮`/`§⑮.1`). Judge the object first, then pick the convention.
2. **Always mark gaps, never speculate** (`§⑲`): undecided items (release approver / on-call rotation / monitoring stack / alert thresholds / release channel / log retention / per-project metrics) are marked as a **gap / to be decided by Elon**; before a decision, follow each SOP's **recommended default** and say it is a default.
3. **The "convention / responsibility / landing point" three questions**: every capability (release / logs / metrics / alerts / health / inspection / incidents / migration / compatibility / CVE / performance) must answer: how the convention is set, who maintains/decides/accepts it, and the landing point (CI / check-all / hooks / manual).
4. **Rollback discipline, cross-cutting** (`§⑥`): any revert/rollback/undo is a **forward edit + normal commit** (or `rm` then commit); data with **no backward compatibility** is not rolled back directly but **forward-repaired** (same as `§㉔`).
5. **Layered, no duplication** (`§⑰`): this clause only cross-references numbers and does not define methods; methods live in `guides/` (L2.5).

---

## ㉙ Card-Creation Idempotency Guard (against same-source duplicate cards)

> **Problem**: concurrent Elon turns / automated turns may **create duplicate cards** for the same intent (observed several times: duplicate review/fix/regress from the same source). `review_of`/title alone are **not enough** (wording varies; same-source reviews by different roles are legitimately distinct cards). Method: `guides/task-interface.md §14`.

1. 🔑 **(Main gate · critical) LLM content de-duplication**: before creating a card, the **creator (Elon/LLM) must read the `title` / `goal` / `Background` of existing non-terminal cards** (especially those sharing `project`/`target`/`review_of`/`parent`), and **judge whether the intent and content match** — a match ⇒ **do not create** (reuse/merge the existing card, or append/reassign on it). **The mechanical key is only a fallback; semantic de-duplication is what matters** (it catches "different key, same intent" duplicates, e.g. a different assignee/source pointing at the same fix). A "similar-candidates script" may list a to-read set, but **the final judgement is made by the LLM**.
2. **Idempotency key (mechanical fallback, title-independent)**: `idem = <kind> | <assignee> | <source> | <target>`; `source` = `review_of` if non-empty, otherwise `parent`, otherwise empty. Including assignee/kind distinguishes same-source reviews by different roles from review/fix/regress.
3. **Creation must carry the idempotency key**: derived automatically by the ACL; may also be overridden explicitly with `--idem <key>`.
4. **Reject/reuse**: if a card with the **same key and a non-terminal state** (not `done`/`canceled`; e.g. `todo`/`in_progress`/`in_review`/`blocked`) exists ⇒ **reject creation** and return the existing card id (reuse).
5. **Title is only a weak signal**: same source + highly similar title ⇒ **warn** "suspected duplicate", for Elon to adjudicate; **never** judge duplication by title alone.
6. **Atomic creation lock**: card creation takes a `mkdir` lock (the same mechanism as `claim`), serialising concurrent creation of the same key.
7. **Exemption**: when multiple same-source cards are genuinely needed (e.g. segmented child cards) ⇒ append `#<seg>` to the key, or explicitly `--allow-dup` with a `kind=change` rationale.
8. **Landing**: the ACL `task.create` (on **both the md base and the meerkat-taskpanel base**) implements **LLM semantic de-duplication (a mandatory step) + the idempotency-key fallback**; the patrol adds a "duplicate key" check. In this repository, which bundles no create path, the convention is **guaranteed by the connected provider + the creator carrying the `idem` key** (see `guides/task-interface.md §14`).

---

## Appendix A: Data-Repo Organization Conventions (general basis for material organization)

- **Material scope**: organize by project/topic (research/tech/product, etc. all fine). Sources = video / web page / **PDF / md notes**. **Material unrelated to the project topic is not collected** → report it to Elon to file into the corresponding data repo.
- **Directory structure / templates / frontmatter source enum**: the `README.md` and `_templates/` in each data repo root are the **sole authority** (see the repo navigation). Extending a source value requires first changing the template, then syncing each role's clauses.
- Video material: download + transcript draft temporarily stored in `00-inbox/` → refined draft filed → the draft path is written into frontmatter; do not move the whole transcript.
- PDF/md notes: extract text/normalize → material card (add frontmatter, file it), retaining the source note.
- Conclusions must attach the convention and reproducible commands; do not write a conclusion without its basis.
- Use `[[double links]]` for association within the repo; the body does not write absolute paths outside the repo (except command examples).
- **Directory governance**: when a subdirectory exceeds ~30 files, consider subdirectory-izing/renaming; adjustments = move + sync the README structure description and affected double links; **archive only, never delete**.
- ⚠️ Fact note: the data repo root may itself be a git repo with an auto-commit mechanism, and files added/moved within the repo fall into that repo's tracking scope; the repo itself may have no independent git repo, so the material-organization role need not perform git operations — but if independent traceability is needed before changes, copy a snapshot to `team/workspace/<task-id>/`.
