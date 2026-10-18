# Lane Session Lifecycle SOP (`lane-session-lifecycle-sop.md`)

Scope: **the terminal half of a lane's life** — from "a lane was registered `running`" to "that
registration is closed on **both** surfaces (the card's `## Sessions` row *and* the canonical
registry)". Companion to `guides/spawn-lane-sop.md` (the spawn half). Owner: framework
(`team/scripts/**`); motivated by.
---

## 1. The invariant (and why it needed a mechanism, not a rule)

> **A lane that was registered `running` reaches a terminal state on both surfaces — including the
> abnormal paths (killed / timed out / crashed / host reboot).**

Spawn was already a single entry with a one-step two-sided registration (`spawn-lane`):
claim → handoff self-check → settings preset → spawn → `task.session-set` (card + registry in one
call). Termination had **no** counterpart. The only terminal writer is the ACL
`task.session-close`, and it can only be invoked **by an agent turn** that remembers to do it —
it appears in `roles/<role>/AGENTS.md` as SOP discipline for the *parent* turn, i.e. exactly the
party that gets interrupted, times out, or is replaced.

Field failure mode (2026-10-14 closing observation):

1. a lane ends (any reason) without a `session-close`;
2. the card stays `in_progress` with a `## Sessions` row `status:running · pid:<dead>`, and the
   registry keeps a `running` row for the same session — **or**, after an out-of-band manual
   registry edit, the registry is terminal while the card still says `running`;
3. `check-sessions` accumulates `note`s (that class reached **38** live rows before the sweep in §6);
4. worse: poll's stale-recovery reads the card as "an abandoned stale claim" and **re-claims it**
   (`stale_same`), re-running work that may already have been delivered ⇒ duplicate execution.

The framework cannot hook the lane's exit: the lane is a `detached` + `unref`'d session leader
(`spawn-lane-sop.md` §5), so the parent has no child handle. Anything the lane does *itself* at the
end (a closing tool call, an exit hook) is gone under SIGKILL / timeout / host crash. The only
criterion that survives every abnormal path is **process liveness**, which is what the reaper uses.
---

## 2. Lever 1 — the reaper (mechanism: the terminal write is guaranteed)

`scripts/lane-reaper.mjs`, armed by `spawn-lane` **after** a successful registration (step ⑨):

```
spawn ✓ → session-set (running, card + registry) ✓ → lane-reaper (detached, stdio ignore) …
                                                        ↓ every 2 s
                                             lane pid alive?  ── no ──▶ grace 1.5 s
                                                        ↓                     ↓
                                                      wait        session-close (ACL, BOTH sides)
                                                                    + endedAt on the card row
                                                                    + workspace/<card>/lane-lifecycle.log
```

* **Liveness, not cooperation.** `laneProcessAlive` = `kill(pid,0)` **and** `ps -o stat=` is not
  `Z`. The zombie clause matters: a killed child stays a zombie (and `kill(pid,0)` *succeeds*) until
  its parent reaps it, so a naive liveness check would wait forever.
* **One write, both surfaces.** The close goes through the ACL `task.session-close` — the single
  sanctioned writer — which sets the card row's `status`, clears `active_session_id`, writes the
  registry terminal state (+`endedAt`) and releases the per-card turn lock, all in one call. The
  reaper then **appends** `endedAt:<iso>` to that same card row (additive audit field; idempotent).
* **Status is derived from the card**: `done`/`in_review` ⇒ `done` (the lane's turn completed),
  `failed`/`canceled` ⇒ `failed`, anything else ⇒ `closed`. `--status` overrides.
* **It refuses to overre-close**: an already-terminal row is a no-op (lane closed itself, or another
  actor got there first); a row whose pid was taken over by a **live** process is left alone.
* **Fail-closed wiring**: if the reaper cannot be started, `spawn-lane` refuses to run the lane
  **and closes the row it just registered** (`lane_reaper_failed(…)`). "Registered but nobody owns the
  close" is precisely the failure this card exists to kill, so it is not allowed to exist.
---

## 3. Lever 2 — poll does not re-claim an inconsistent row (guard)

Criterion (single source: `scripts/session-lifecycle.mjs#classifyClaimBlock`; used by both the
claiming path `runPoll` and the read-only surface `pollCandidates`):

For an **stale `in_progress` candidate**, take the card row that represents the current lane
(`active_session_id`, else the last `running` row). **Do not claim** when:

| kind | shape | why it must not be claimed |
|---|---|---|
| `registry_done` | registry says that session is `done` | the lane declared completion; the work may already be delivered ⇒ re-claim = duplicate execution (the incident) |
| `registry_terminal_live` | registry terminal (`closed`/`failed`) **and** the card row's pid is alive | a live process contradicts "already ended"; who is right cannot be decided automatically |
| `card_only_live` | no registry entry **and** the card row's pid is alive | the m7 shape: "the card says it runs, the registry has never heard of it" ⇒ same ambiguity |

Deliberately **still claimable** (the real recovery path must not be eaten):

* registry says `closed`/`failed` **and** the pid is dead ⇒ zombie row, stale recovery is correct;
* no registry entry and the pid is dead ⇒ idem;
* the card has no `## Sessions` row, or the candidate is on the `new` (`todo`/`ready`) surface.

The blocked cards are reported in the poll envelope (`state.inconsistent[]`, plus the message) so
the drift is visible rather than silently dropped.

Field replay (three real pre-state cards replayed into a sandbox, registry
untouched): the two `registry=done` rows — including the incident card, `pid:12159`, dead — come
back `kind:registry_done` and are **not** claimed; the `registry=closed` row is still claimed, i.e.
recovery is preserved.
---

## 4. Rollback / opt-out (and what you then owe)

The reaper is **on by default**. To run without it (§11-style explicit discipline):

```bash
bash scripts/spawn-lane.sh <card> <owner> --no-reaper      # or OPENCLAW_TEAM_REAPER=0
```

You then owe the close yourself, in the host's exact form, **before your turn ends**
(`task.session-close <card> <seg> done|closed|failed`), and you own the drift if you are
interrupted. `--dry-run` never arms anything (it prints `reaper: "would_arm"`).
---

## 5. Where it sits in the spawn sequence

`spawn-lane` step ⑨ (after `session-set`). The output JSON carries
`reaper: {state:"armed", pid:<reaper pid>}` (or `"disabled"`). Nothing else in the spawn path
changes: the watch is a separate detached process, the registered lane pid is the **lane process**
itself, and `--dry-run` stays zero-side-effect.

For a non-interactive lane that process is the backend (`claude -p` / `codex exec`). For an
**interactive** lane (`interactive=1`) it is the long-lived `lane-host.mjs` supervisor, which
lives for the whole turn and owns the backend and its pipes — registering a transient wrapper
would still break poll's liveness guard, but the supervisor is not transient. The interactive
reaper is additionally armed with `state=<sidecar>`; when the host pid dies it verifies
`state.host_pid` and the backend's parent, then terminates the recorded backend/process group
before closing the session (`guides/interactive-lane-sop.md` §9).
---

## 6. Lever 3 — the reconciliation sweep (historical backlog)

`scripts/session-reconcile.mjs` — the missing hand for the `note`s that already existed:

```bash
node scripts/session-reconcile.mjs                                   # inventory + classification, zero writes
node scripts/session-reconcile.mjs --apply --ledger <path>           # fix the fixable ones, one ledger row each
```

It reuses `check-sessions.mjs#checkSessions` (same criterion, no second scanner) and classifies every
item into exactly one bucket:

| class | shape | action |
|---|---|---|
| `fixable` | the card row's pid is **dead** (or absent) ⇒ registration drift, the registry fact is knowable | close the row via the ACL (`status` adopted from the registry, or `closed` for a zombie); registry-only close when there is no card row to sync |
| `manual` | the card row's pid is **alive** while the registry is terminal; or a hard failure (`registry_only` / `card_only`) | escalate — a live process and a terminal registry are mutually exclusive, so the script must not guess |
| `immutable` | `duplicate_lane` (historical duplicate rows for one lane identity) | keep — the read side already folds by identity; deleting rows destroys the audit trail |

Non-destructive by construction: it only turns a `running` row into a state **the registry already
declared** (or `closed` for a dead zombie); it never invents a state, never touches frontmatter
state-machine fields, and `--apply` **requires** `--ledger <path>` (one row per item, plus one JSON
line per card in `workspace/<card>/lane-lifecycle.log`).

Live run of this card (2026-10-14): `62` items → `38 fixable` (all applied, 0 failed) / `24
immutable` / `0 manual`; `check-sessions` went from **61 notes** (`36 status_mismatch` + `25
duplicate_lane`) to **24 notes** (all `duplicate_lane`), hard failures `0` throughout.
---

## 7. Residuals (honest limits)

* **Host reboot / reaper and lane both killed**: neither survives, so the terminal write is lost —
  the guard (§3) still prevents the duplicate run, and the sweep (§6) repairs the backlog. There is
  no durable out-of-band scheduler for the reaper yet (would need a registered job; out of this
  card's write surface).
* **pid reuse**: a recycled pid can make a dead lane look alive ⇒ the reaper waits longer than it
  should (it never writes a *wrong* state). The guard and the sweep are the safety nets.
* **Lanes without a pid** (the plugin/native harnesses drafted in
  `guides/codex-plugin-lane-contract.md`, still awaiting an Elon ruling): liveness cannot be
  observed, so the reaper cannot close them. That contract must bring its own terminal hook;
  until it does, the guard + sweep is all they get.
* The reaper is one idle process per live lane (one `ps` call every 2 s); it exits as soon as the
  row is terminal or its lane is gone.
---

## 8. References

* `team/scripts/lane-reaper.mjs` — the watch; `team/scripts/session-lifecycle.mjs` — the shared
  criterion + the two-sided close; `team/scripts/session-reconcile.mjs` — the sweep.
* `team/scripts/spawn-lane.mjs` step ⑨ (`--no-reaper`), `guides/spawn-lane-sop.md` §3/§5/§7.
* `team/scripts/check-sessions.mjs` — the read-only consistency gate (`registry_only` / `card_only`
  are hard failures; the rest are notes this SOP is about).
