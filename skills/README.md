# skills/ — declared sources, fetch, and upstream update

Skill **bodies are not stored in this repository** (option A). This directory holds the
*declarations* and the two scripts that act on them:

| File | Role |
|---|---|
| `manifest.json` | The declaration: 93 entries, each with `targets` and a `source{kind,repo,ref,path}` (`kind` ∈ `github` / `clawhub` / `local`; `local` has no entry right now but stays supported — it is the escape hatch for a skill authored in this repo). This is the **single source of truth** — the old hand-maintained `~/.claude/sources/.installed-skills.json` is not. |
| `lock.json` | Resolved state: per entry `ref` + `tree_sha256` + `resolved`, so a drift in either direction is visible. |
| `fetch.mjs` | **Install at the pinned ref.** `node fetch.mjs` / `--vendor` / `--offline`, driven by `install.sh`. Never decides *which* ref — that is `update.mjs`'s job. |
| `update.mjs` | **Detect a drifted upstream ref, and (opt-in) advance to it.** See below. |
| `PROVENANCE.md` | Per-skill provenance of the transitional vendored copies. |

A skill that shells out to an external CLI is only half-installed without that CLI.
Those CLIs are declared in [`../config/skill-clis.json`](../config/skill-clis.json)
(probe + mode + the skills that require them) rather than vendored, and `install.sh`
probes each: `mode:install` entries are installed best-effort (`ocr`, `gitnexus`),
`mode:check-only` entries are only reported — `tvly`'s upstream installer is a
`curl | bash` pipe, and `tvly init` would overwrite the ref-pinned bodies this
directory installs. Note that `fetch.mjs`/`update.mjs` do **not** touch any of them:
fetching a skill body and provisioning its CLI are separate steps.

## `update.mjs`

```bash
node skills/update.mjs            # DETECT ONLY — zero writes (default)
node skills/update.mjs --json     # same, plus a one-line machine envelope (used by the scheduler)
node skills/update.mjs --apply    # advance refs, rewrite lock, reinstall targets
node skills/update.mjs --only antfu,ask-matt
```

For every `source.kind === "github"` entry it resolves the upstream's current commit with
a **read-only** command — `git ls-remote <repo> HEAD`, or `refs/heads/<branch>` when the
entry declares `source.track` — and compares it to the pinned `source.ref`.

* **Default (no `--apply`) writes nothing.** Not the manifest, not the lock, not a target
  directory. It prints the change list (`name`, `old → new`, `targets`) plus a summary
  line, and exits 0. **When nothing drifted it prints nothing at all** — that silence is
  what keeps the weekly job at zero cost.
* **`--apply`** then, per changed entry: advances `manifest.json` `source.ref`, recomputes
  `lock.json` `tree_sha256` from the newly pinned tree, and reinstalls the entry into each
  of its `targets` (same copy semantics as `fetch.mjs`). The write face is exactly
  `skills/manifest.json`, `skills/lock.json`, and the target skill directories.
* **Idempotent.** Re-running after an apply finds no drift and writes nothing.
* **Exit code**: `0` when nothing failed (drift found or not); `1` when at least one entry
  could not be resolved or installed. `source.kind === "unknown"` keeps the existing
  `needs_source` semantics — skipped and counted as `unresolved`, never an error.
* **Non-destructive**: the only git verbs are `ls-remote`, `clone`, `fetch` and `checkout`
  (the last three inside a temp directory the script creates and removes, and never in a
  repository it did not create).

### Why it does not apply by itself

A skill body is **instruction text for an agent**. Advancing a ref therefore promotes a
third-party author's edits straight into the agent's host, unreviewed. `update.mjs`
defaults to detect-and-report for that reason; `--apply` is the opt-in, and the weekly
scheduled job (`skills-update`, see [`../team/AUTOMATIONS.md`](../team/AUTOMATIONS.md) §1)
only ever *reports*. Review the diff, then apply.

### What `tree_sha256` is

`sha256` over the sorted `<file sha256>␣␣<repo-relative path>` lines of every file under
the pinned path — i.e. `find <path> -type f | sort | xargs shasum -a 256 | shasum -a 256`
run from the clone root (`PROVENANCE.md` documents the same recipe). `--apply` writes one
`sha256:<hex>` value per changed entry.

## Boundary — this is not `skill-collection-review`

`skill-collection-review-*` patrols the **installed collection** on a host (what is
present, duplicated, broken, stale *as a set*). `update.mjs` patrols the **declared
upstreams** (has the pinned ref drifted from upstream?) and is the only path that can
*advance* a ref. A skill can be perfectly installed while its upstream moved; a collection
can be broken while every upstream is current. Neither job subsumes the other.

## Relationship to `team/skills/`

Different directories, different owners. `{team}/skills/` (i.e. `~/.openclaw/team/skills/`)
belongs to the **task provider** (`task-ops/` ACL library). This directory is a **repo-side
asset driven in place by `install.sh`** and is deliberately not deployed into `{team}/`.
That is why the scheduled job reaches it through the `{repo}` placeholder rather than
`{team}` (see `../team/automations/providers.json`).
