# SKILL PROVENANCE

> **Source of truth is now [`manifest.json`](manifest.json) + [`lock.json`](lock.json)**
> (option A: declarations, not vendored code). The table below documents the
> vendored copies that remain as a transitional fallback — it is superseded as
> entries acquire verified upstream sources.

Vendored skills, by source layer. Generated 2026-10-08T17:56Z.

> Third-party skills keep their own licenses. Review each before redistribution.

### Newly registered (2026-10-09) — fetched from upstream, not vendored

Two front-end skills resolved to verified GitHub upstreams and installed to
`claude` + `agent:linus`:

| skill | upstream | ref (pinned) | path |
|---|---|---|---|
| `frontend-design` | `https://github.com/anthropics/skills` | `683bc88e56f3e09ba94f7055977f3d3aa499f202` | `skills/frontend-design` |
| `react-best-practices` | `https://github.com/vercel-labs/agent-skills` | `063bee94c3f4df8453406c830b0a7df0f2860278` | `skills/react-best-practices` |

- No ClawHub-only fallback was needed: both have a GitHub upstream
  (`source.kind = github`), so none is registered with `kind = clawhub`.
- `react-best-practices`: upstream SKILL.md frontmatter `name` is
  `vercel-react-best-practices`; the manifest/install name stays
  `react-best-practices` (matches the upstream directory basename). Claude Code
  lists it as `react-best-practices (vercel-react-best-practices)`.
- `tree_sha256` in `lock.json` = `shasum -a 256` over the sorted
  `sha256sum`-style lines of every file under the pinned path
  (`find <path> -type f | sort | xargs shasum -a 256 | shasum -a 256`).

### Newly registered (2026-10-16) — fetched from upstream, not vendored

One skill resolved to a verified GitHub upstream and installed to `claude`:

| skill | upstream | ref (pinned) | path |
|---|---|---|---|
| `using-git-worktrees` | `https://github.com/obra/superpowers` | `bb92a77741419a4ab5f06e711a283343f1ada0c3` | `skills/using-git-worktrees` |

- `source.kind = github`, so no ClawHub fallback is registered for it.
- **Scope of the registration**: `obra/superpowers` is a multi-harness plugin
  repository (Claude Code / Codex CLI / Cursor / OpenCode / Gemini CLI / …).
  Only **this one** skill is declared here. The rest of that collection is
  deliberately not registered, so a consumer of this manifest inherits neither
  the plugin's hooks nor its other skills.
- `tree_sha256` computed with the in-repo `treeSha256()` exported by
  `skills/update.mjs` — the same function `update.mjs --apply` writes with — so
  the value here and the value a later `--apply` recomputes cannot disagree.

#### This skill is what `R-WORKTREE-1` now delegates to

Since 2026-10-16 the framework's dev flow **is** this skill's flow, not a bespoke
alternative to it. `scripts/spawn-lane.mjs` no longer decides or creates worktrees; the
lane runs `using-git-worktrees`, whose git fallback puts the tree at
`<repo>/.worktrees/<branch>` — the same place, so flow and skill agree rather than
reconcile. `.worktrees/` is pre-ignored in `.gitignore`, which matters because the skill's
Step 1b **mandates** that precondition before it will create a tree there.

What the framework supplies that the skill cannot infer, all in the lane prompt
(`buildPrompt`):

- **authorisation** — Step 0 otherwise asks *the user* for consent, and a lane is a headless
  `claude -p` process with no user to answer; the skill honours a declared preference, so
  the prompt declares one;
- **the branch name** — `<card-id>`, one branch for the whole card (all segments reuse it),
  which `scripts/check-merge.mjs` later uses to attribute the tree to a card at closeout;
- **first entry vs continuation** — create the branch/tree with `-b` on the first segment;
  on every later segment **re-enter** the existing tree and never `-b` (the skill's fallback
  always creates a branch, so the prompt must override it);
- **the absolute worktree path** — `<show-toplevel>/.worktrees/<card-id>`, so the tree lands
  where the merge gate scans;
- **review lanes create no branch/tree** — they re-enter the card tree read-only at a pinned
  commit.

On **first entry** the base needs no machinery: the skill bases on implicit `HEAD`, and the
main checkout holds `dev` (`R-WORKTREE-1`), so `HEAD` *is* `dev`. Later segments reuse the
card branch; there is no merge between segments.

Normative source: `R-WORKTREE-1`; sequence and closure strength:
`guides/dev-worktree-flow-sop.md`.

The skill body is deliberately **not** edited to record any of this: bodies are third-party
upstream content and would be overwritten by `update.mjs --apply`.

### OpenClaw global (`skills/openclaw/` → `~/.openclaw/skills/`)

| skill | license file | source |
|---|---|---|
| `excel-xlsx` | — | `skills/openclaw/excel-xlsx` |
| `find-skills-skill` | — | `skills/openclaw/find-skills-skill` |
| `humanizer` | — | `skills/openclaw/humanizer` |
| `pdf` | — | `skills/openclaw/pdf` |
| `playwright` | — | `skills/openclaw/playwright` |
| `skill-creator` | LICENSE.txt | `skills/openclaw/skill-creator` |
| `skill-vetter` | — | `skills/openclaw/skill-vetter` |
| `tavily-best-practices` | — | `skills/openclaw/tavily-best-practices` |
| `tavily-cli` | — | `skills/openclaw/tavily-cli` |
| `tavily-crawl` | — | `skills/openclaw/tavily-crawl` |
| `tavily-dynamic-search` | — | `skills/openclaw/tavily-dynamic-search` |
| `tavily-extract` | — | `skills/openclaw/tavily-extract` |
| `tavily-map` | — | `skills/openclaw/tavily-map` |
| `tavily-research` | — | `skills/openclaw/tavily-research` |
| `tavily-search` | — | `skills/openclaw/tavily-search` |
| `word-docx` | — | `skills/openclaw/word-docx` |

### Claude Code (`skills/claude/` → `~/.claude/skills/`)

| skill | license file | source |
|---|---|---|
| `antfu` | — | `skills/claude/antfu` |
| `ask-matt` | — | `skills/claude/ask-matt` |
| `canvas-design` | LICENSE.txt | `skills/claude/canvas-design` |
| `claude-handoff` | — | `skills/claude/claude-handoff` |
| `code-review` | — | `skills/claude/code-review` |
| `codebase-design` | — | `skills/claude/codebase-design` |
| `daisyui` | — | `skills/claude/daisyui` |
| `diagnosing-bugs` | — | `skills/claude/diagnosing-bugs` |
| `docx` | LICENSE.txt | `skills/claude/docx` |
| `domain-modeling` | — | `skills/claude/domain-modeling` |
| `git-guardrails-claude-code` | — | `skills/claude/git-guardrails-claude-code` |
| `grill-with-docs` | — | `skills/claude/grill-with-docs` |
| `grilling` | — | `skills/claude/grilling` |
| `handoff` | — | `skills/claude/handoff` |
| `implement-spec` | — | `skills/claude/implement-spec` |
| `implement` | — | `skills/claude/implement` |
| `improve-codebase-architecture` | — | `skills/claude/improve-codebase-architecture` |
| `nuxt` | — | `skills/claude/nuxt` |
| `pdf` | LICENSE.txt | `skills/claude/pdf` |
| `pinia` | — | `skills/claude/pinia` |
| `pnpm` | — | `skills/claude/pnpm` |
| `pr` | — | `skills/claude/pr` |
| `prototype` | — | `skills/claude/prototype` |
| `setup-matt-pocock-skills` | — | `skills/claude/setup-matt-pocock-skills` |
| `setup-pre-commit` | — | `skills/claude/setup-pre-commit` |
| `skill-installer` | — | `skills/claude/skill-installer` |
| `tavily-cli` | — | `skills/claude/tavily-cli` |
| `tavily-dynamic-search` | — | `skills/claude/tavily-dynamic-search` |
| `tavily-extract` | — | `skills/claude/tavily-extract` |
| `tavily-research` | — | `skills/claude/tavily-research` |
| `tavily-search` | — | `skills/claude/tavily-search` |
| `tdd` | — | `skills/claude/tdd` |
| `to-questionnaire` | — | `skills/claude/to-questionnaire` |
| `to-spec` | — | `skills/claude/to-spec` |
| `to-tickets` | — | `skills/claude/to-tickets` |
| `triage` | — | `skills/claude/triage` |
| `unocss` | — | `skills/claude/unocss` |
| `vite` | — | `skills/claude/vite` |
| `vitest` | — | `skills/claude/vitest` |
| `vue` | — | `skills/claude/vue` |
| `wayfinder` | — | `skills/claude/wayfinder` |
| `xlsx` | LICENSE.txt | `skills/claude/xlsx` |

### Codex (`skills/codex/` → `~/.codex/skills/`)

| skill | license file | source |
|---|---|---|
| `e2e-testing-patterns` | — | `skills/codex/e2e-testing-patterns` |
| `nm-parseltongue-python-testing` | — | `skills/codex/nm-parseltongue-python-testing` |
| `vitest` | — | `skills/codex/vitest` |

### agent `jobs` (`skills/agents/jobs/` → `~/.openclaw/workspace-jobs/skills/`)

| skill | license file | source |
|---|---|---|
| `daisyui` | — | `skills/agents/jobs/daisyui` |
| `finesse-term` | — | `skills/agents/jobs/finesse-term` |
| `finesse-ui` | — | `skills/agents/jobs/finesse-ui` |
| `frame-smith` | — | `skills/agents/jobs/frame-smith` |
| `grilling` | — | `skills/agents/jobs/grilling` |
| `handoff` | — | `skills/agents/jobs/handoff` |
| `impeccable` | — | `skills/agents/jobs/impeccable` |
| `interface-design` | — | `skills/agents/jobs/interface-design` |
| `prototype` | — | `skills/agents/jobs/prototype` |
| `research` | — | `skills/agents/jobs/research` |
| `taste-skill` | — | `skills/agents/jobs/taste-skill` |
| `to-questionnaire` | — | `skills/agents/jobs/to-questionnaire` |
| `to-spec` | — | `skills/agents/jobs/to-spec` |
| `to-tickets` | — | `skills/agents/jobs/to-tickets` |
| `ui-ux-pro-max` | — | `skills/agents/jobs/ui-ux-pro-max` |
| `wayfinder` | — | `skills/agents/jobs/wayfinder` |

### agent `linus` (`skills/agents/linus/` → `~/.openclaw/workspace-linus/skills/`)

| skill | license file | source |
|---|---|---|
| `ask-matt` | — | `skills/agents/linus/ask-matt` |
| `claude-handoff` | — | `skills/agents/linus/claude-handoff` |
| `code-review` | — | `skills/agents/linus/code-review` |
| `codebase-design` | — | `skills/agents/linus/codebase-design` |
| `diagnosing-bugs` | — | `skills/agents/linus/diagnosing-bugs` |
| `docker` | — | `skills/agents/linus/docker` |
| `domain-modeling` | — | `skills/agents/linus/domain-modeling` |
| `git-guardrails-claude-code` | — | `skills/agents/linus/git-guardrails-claude-code` |
| `grill-with-docs` | — | `skills/agents/linus/grill-with-docs` |
| `implement-spec` | — | `skills/agents/linus/implement-spec` |
| `implement` | — | `skills/agents/linus/implement` |
| `improve-codebase-architecture` | — | `skills/agents/linus/improve-codebase-architecture` |
| `pr` | — | `skills/agents/linus/pr` |
| `retro` | — | `skills/agents/linus/retro` |
| `setup-matt-pocock-skills` | — | `skills/agents/linus/setup-matt-pocock-skills` |
| `setup-pre-commit` | — | `skills/agents/linus/setup-pre-commit` |
| `tdd` | — | `skills/agents/linus/tdd` |
| `wizard` | — | `skills/agents/linus/wizard` |

### agent `turing` (`skills/agents/turing/` → `~/.openclaw/workspace-turing/skills/`)

| skill | license file | source |
|---|---|---|
| `api-security-testing` | — | `skills/agents/turing/api-security-testing` |
| `code-review` | — | `skills/agents/turing/code-review` |
| `e2e-testing-patterns` | — | `skills/agents/turing/e2e-testing-patterns` |
| `nm-parseltongue-python-testing` | — | `skills/agents/turing/nm-parseltongue-python-testing` |
| `qa-api-testing` | — | `skills/agents/turing/qa-api-testing` |
| `qa-test-automation-arch` | — | `skills/agents/turing/qa-test-automation-arch` |
| `security-audit-toolkit` | — | `skills/agents/turing/security-audit-toolkit` |
| `tdd` | — | `skills/agents/turing/tdd` |

### agent `assistant` (`skills/agents/assistant/` → `~/.openclaw/workspace-assistant/skills/`)

| skill | license file | source |
|---|---|---|
| `marketing-copywriting` | — | `skills/agents/assistant/marketing-copywriting` |
| `subtitle-extractor` | — | `skills/agents/assistant/subtitle-extractor` |
| `subtitle` | — | `skills/agents/assistant/subtitle` |
| `video-downloader-skill` | — | `skills/agents/assistant/video-downloader-skill` |
| `writing-beats` | — | `skills/agents/assistant/writing-beats` |
| `writing-fragments` | — | `skills/agents/assistant/writing-fragments` |
| `writing-shape` | — | `skills/agents/assistant/writing-shape` |

---

**task-ops / meerkat-taskpanel**: the team's task skill comes from the external [meerkat-taskpanel](https://github.com/) project, installed separately. It is intentionally not vendored here.

**Expected provider-skill capabilities** (the provider owns them; this repo only references them):
`references/card-schema.md` (frontmatter fields, state machine, body sections), `references/cli.md`
(the `taskctl` command surface), `references/practice-guides.md` (board rules), `references/projects-json.md`
(the local project map) and `references/reports.md` (periodic reports). The installed skill name and
version may vary (`meerkat-taskpanel` in the source repo; some hosts install it as `task-panel`), so
openclaw-team docs reference the **capability and reference filename**, never a hardcoded absolute
path or version. When an installed copy lacks a reference, read `taskctl --help` and the provider's
own repo; do not copy the missing text back into this repo.
