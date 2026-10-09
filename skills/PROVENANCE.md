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

### OpenClaw global (`skills/openclaw/` → `~/.openclaw/skills/`)

| skill | license file | source |
|---|---|---|
| `excel-xlsx` | — | `~/Documents/openclaw-team/skills/openclaw/excel-xlsx` |
| `find-skills-skill` | — | `~/Documents/openclaw-team/skills/openclaw/find-skills-skill` |
| `humanizer` | — | `~/Documents/openclaw-team/skills/openclaw/humanizer` |
| `pdf` | — | `~/Documents/openclaw-team/skills/openclaw/pdf` |
| `playwright` | — | `~/Documents/openclaw-team/skills/openclaw/playwright` |
| `skill-creator` | LICENSE.txt | `~/Documents/openclaw-team/skills/openclaw/skill-creator` |
| `skill-vetter` | — | `~/Documents/openclaw-team/skills/openclaw/skill-vetter` |
| `tavily-best-practices` | — | `~/Documents/openclaw-team/skills/openclaw/tavily-best-practices` |
| `tavily-cli` | — | `~/Documents/openclaw-team/skills/openclaw/tavily-cli` |
| `tavily-crawl` | — | `~/Documents/openclaw-team/skills/openclaw/tavily-crawl` |
| `tavily-dynamic-search` | — | `~/Documents/openclaw-team/skills/openclaw/tavily-dynamic-search` |
| `tavily-extract` | — | `~/Documents/openclaw-team/skills/openclaw/tavily-extract` |
| `tavily-map` | — | `~/Documents/openclaw-team/skills/openclaw/tavily-map` |
| `tavily-research` | — | `~/Documents/openclaw-team/skills/openclaw/tavily-research` |
| `tavily-search` | — | `~/Documents/openclaw-team/skills/openclaw/tavily-search` |
| `word-docx` | — | `~/Documents/openclaw-team/skills/openclaw/word-docx` |

### Claude Code (`skills/claude/` → `~/.claude/skills/`)

| skill | license file | source |
|---|---|---|
| `antfu` | — | `~/Documents/openclaw-team/skills/claude/antfu` |
| `ask-matt` | — | `~/Documents/openclaw-team/skills/claude/ask-matt` |
| `canvas-design` | LICENSE.txt | `~/Documents/openclaw-team/skills/claude/canvas-design` |
| `claude-handoff` | — | `~/Documents/openclaw-team/skills/claude/claude-handoff` |
| `code-review` | — | `~/Documents/openclaw-team/skills/claude/code-review` |
| `codebase-design` | — | `~/Documents/openclaw-team/skills/claude/codebase-design` |
| `daisyui` | — | `~/Documents/openclaw-team/skills/claude/daisyui` |
| `diagnosing-bugs` | — | `~/Documents/openclaw-team/skills/claude/diagnosing-bugs` |
| `docx` | LICENSE.txt | `~/Documents/openclaw-team/skills/claude/docx` |
| `domain-modeling` | — | `~/Documents/openclaw-team/skills/claude/domain-modeling` |
| `git-guardrails-claude-code` | — | `~/Documents/openclaw-team/skills/claude/git-guardrails-claude-code` |
| `grill-with-docs` | — | `~/Documents/openclaw-team/skills/claude/grill-with-docs` |
| `grilling` | — | `~/Documents/openclaw-team/skills/claude/grilling` |
| `handoff` | — | `~/Documents/openclaw-team/skills/claude/handoff` |
| `implement-spec` | — | `~/Documents/openclaw-team/skills/claude/implement-spec` |
| `implement` | — | `~/Documents/openclaw-team/skills/claude/implement` |
| `improve-codebase-architecture` | — | `~/Documents/openclaw-team/skills/claude/improve-codebase-architecture` |
| `nuxt` | — | `~/Documents/openclaw-team/skills/claude/nuxt` |
| `pdf` | LICENSE.txt | `~/Documents/openclaw-team/skills/claude/pdf` |
| `pinia` | — | `~/Documents/openclaw-team/skills/claude/pinia` |
| `pnpm` | — | `~/Documents/openclaw-team/skills/claude/pnpm` |
| `pr` | — | `~/Documents/openclaw-team/skills/claude/pr` |
| `prototype` | — | `~/Documents/openclaw-team/skills/claude/prototype` |
| `setup-matt-pocock-skills` | — | `~/Documents/openclaw-team/skills/claude/setup-matt-pocock-skills` |
| `setup-pre-commit` | — | `~/Documents/openclaw-team/skills/claude/setup-pre-commit` |
| `skill-installer` | — | `~/Documents/openclaw-team/skills/claude/skill-installer` |
| `tavily-cli` | — | `~/Documents/openclaw-team/skills/claude/tavily-cli` |
| `tavily-dynamic-search` | — | `~/Documents/openclaw-team/skills/claude/tavily-dynamic-search` |
| `tavily-extract` | — | `~/Documents/openclaw-team/skills/claude/tavily-extract` |
| `tavily-research` | — | `~/Documents/openclaw-team/skills/claude/tavily-research` |
| `tavily-search` | — | `~/Documents/openclaw-team/skills/claude/tavily-search` |
| `tdd` | — | `~/Documents/openclaw-team/skills/claude/tdd` |
| `to-questionnaire` | — | `~/Documents/openclaw-team/skills/claude/to-questionnaire` |
| `to-spec` | — | `~/Documents/openclaw-team/skills/claude/to-spec` |
| `to-tickets` | — | `~/Documents/openclaw-team/skills/claude/to-tickets` |
| `triage` | — | `~/Documents/openclaw-team/skills/claude/triage` |
| `unocss` | — | `~/Documents/openclaw-team/skills/claude/unocss` |
| `vite` | — | `~/Documents/openclaw-team/skills/claude/vite` |
| `vitest` | — | `~/Documents/openclaw-team/skills/claude/vitest` |
| `vue` | — | `~/Documents/openclaw-team/skills/claude/vue` |
| `wayfinder` | — | `~/Documents/openclaw-team/skills/claude/wayfinder` |
| `xlsx` | LICENSE.txt | `~/Documents/openclaw-team/skills/claude/xlsx` |

### Codex (`skills/codex/` → `~/.codex/skills/`)

| skill | license file | source |
|---|---|---|
| `e2e-testing-patterns` | — | `~/Documents/openclaw-team/skills/codex/e2e-testing-patterns` |
| `nm-parseltongue-python-testing` | — | `~/Documents/openclaw-team/skills/codex/nm-parseltongue-python-testing` |
| `vitest` | — | `~/Documents/openclaw-team/skills/codex/vitest` |

### agent `jobs` (`skills/agents/jobs/` → `~/.openclaw/workspace-jobs/skills/`)

| skill | license file | source |
|---|---|---|
| `daisyui` | — | `~/Documents/openclaw-team/skills/agents/jobs/daisyui` |
| `finesse-term` | — | `~/Documents/openclaw-team/skills/agents/jobs/finesse-term` |
| `finesse-ui` | — | `~/Documents/openclaw-team/skills/agents/jobs/finesse-ui` |
| `frame-smith` | — | `~/Documents/openclaw-team/skills/agents/jobs/frame-smith` |
| `grilling` | — | `~/Documents/openclaw-team/skills/agents/jobs/grilling` |
| `handoff` | — | `~/Documents/openclaw-team/skills/agents/jobs/handoff` |
| `impeccable` | — | `~/Documents/openclaw-team/skills/agents/jobs/impeccable` |
| `interface-design` | — | `~/Documents/openclaw-team/skills/agents/jobs/interface-design` |
| `prototype` | — | `~/Documents/openclaw-team/skills/agents/jobs/prototype` |
| `research` | — | `~/Documents/openclaw-team/skills/agents/jobs/research` |
| `taste-skill` | — | `~/Documents/openclaw-team/skills/agents/jobs/taste-skill` |
| `to-questionnaire` | — | `~/Documents/openclaw-team/skills/agents/jobs/to-questionnaire` |
| `to-spec` | — | `~/Documents/openclaw-team/skills/agents/jobs/to-spec` |
| `to-tickets` | — | `~/Documents/openclaw-team/skills/agents/jobs/to-tickets` |
| `ui-ux-pro-max` | — | `~/Documents/openclaw-team/skills/agents/jobs/ui-ux-pro-max` |
| `wayfinder` | — | `~/Documents/openclaw-team/skills/agents/jobs/wayfinder` |

### agent `linus` (`skills/agents/linus/` → `~/.openclaw/workspace-linus/skills/`)

| skill | license file | source |
|---|---|---|
| `ask-matt` | — | `~/Documents/openclaw-team/skills/agents/linus/ask-matt` |
| `claude-handoff` | — | `~/Documents/openclaw-team/skills/agents/linus/claude-handoff` |
| `code-review` | — | `~/Documents/openclaw-team/skills/agents/linus/code-review` |
| `codebase-design` | — | `~/Documents/openclaw-team/skills/agents/linus/codebase-design` |
| `diagnosing-bugs` | — | `~/Documents/openclaw-team/skills/agents/linus/diagnosing-bugs` |
| `docker` | — | `~/Documents/openclaw-team/skills/agents/linus/docker` |
| `domain-modeling` | — | `~/Documents/openclaw-team/skills/agents/linus/domain-modeling` |
| `git-guardrails-claude-code` | — | `~/Documents/openclaw-team/skills/agents/linus/git-guardrails-claude-code` |
| `grill-with-docs` | — | `~/Documents/openclaw-team/skills/agents/linus/grill-with-docs` |
| `implement-spec` | — | `~/Documents/openclaw-team/skills/agents/linus/implement-spec` |
| `implement` | — | `~/Documents/openclaw-team/skills/agents/linus/implement` |
| `improve-codebase-architecture` | — | `~/Documents/openclaw-team/skills/agents/linus/improve-codebase-architecture` |
| `pr` | — | `~/Documents/openclaw-team/skills/agents/linus/pr` |
| `retro` | — | `~/Documents/openclaw-team/skills/agents/linus/retro` |
| `setup-matt-pocock-skills` | — | `~/Documents/openclaw-team/skills/agents/linus/setup-matt-pocock-skills` |
| `setup-pre-commit` | — | `~/Documents/openclaw-team/skills/agents/linus/setup-pre-commit` |
| `tdd` | — | `~/Documents/openclaw-team/skills/agents/linus/tdd` |
| `wizard` | — | `~/Documents/openclaw-team/skills/agents/linus/wizard` |

### agent `turing` (`skills/agents/turing/` → `~/.openclaw/workspace-turing/skills/`)

| skill | license file | source |
|---|---|---|
| `api-security-testing` | — | `~/Documents/openclaw-team/skills/agents/turing/api-security-testing` |
| `code-review` | — | `~/Documents/openclaw-team/skills/agents/turing/code-review` |
| `e2e-testing-patterns` | — | `~/Documents/openclaw-team/skills/agents/turing/e2e-testing-patterns` |
| `nm-parseltongue-python-testing` | — | `~/Documents/openclaw-team/skills/agents/turing/nm-parseltongue-python-testing` |
| `qa-api-testing` | — | `~/Documents/openclaw-team/skills/agents/turing/qa-api-testing` |
| `qa-test-automation-arch` | — | `~/Documents/openclaw-team/skills/agents/turing/qa-test-automation-arch` |
| `security-audit-toolkit` | — | `~/Documents/openclaw-team/skills/agents/turing/security-audit-toolkit` |
| `tdd` | — | `~/Documents/openclaw-team/skills/agents/turing/tdd` |

### agent `assistant` (`skills/agents/assistant/` → `~/.openclaw/workspace-assistant/skills/`)

| skill | license file | source |
|---|---|---|
| `marketing-copywriting` | — | `~/Documents/openclaw-team/skills/agents/assistant/marketing-copywriting` |
| `subtitle-extractor` | — | `~/Documents/openclaw-team/skills/agents/assistant/subtitle-extractor` |
| `subtitle` | — | `~/Documents/openclaw-team/skills/agents/assistant/subtitle` |
| `video-downloader-skill` | — | `~/Documents/openclaw-team/skills/agents/assistant/video-downloader-skill` |
| `writing-beats` | — | `~/Documents/openclaw-team/skills/agents/assistant/writing-beats` |
| `writing-fragments` | — | `~/Documents/openclaw-team/skills/agents/assistant/writing-fragments` |
| `writing-shape` | — | `~/Documents/openclaw-team/skills/agents/assistant/writing-shape` |

---

**task-ops / task-panel**: the team's task skill comes from the external [task-panel](https://github.com/) project, installed separately. It is intentionally not vendored here.
