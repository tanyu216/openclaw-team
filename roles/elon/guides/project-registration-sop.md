# Project Registration SOP (role-owned)

> Method home for `PROTOCOL §8`. L1 keeps the four-step process; this guide carries the ACL and
> metadata detail. Load it when the operator announces a new project or data repo.

## 1. Registration process

1. The operator informs the team of the new project/data repo.
2. Elon verifies the root exists and reads its `CLAUDE.md` (or the repo `README`) to extract the project rules.
3. Elon registers it via the **`task-interface` ACL** as a **project identity code** + metadata:
   - `kind: code|docs|vault`
   - `root`
   - `repos` git boundaries, as measured
   - `guides`
   - `default_git_rules`
   The underlying backend (currently meerkat-taskpanel) is bound by the ACL and is **swappable**.
4. Only then can task cards reference that **identity code**.

Example: a data repo = `kind: docs` (no independent git); write rules = materials `md` only, following the data repo's directory and template conventions.

> **`project` lives in the ACL layer**: `project` = an **identity code**, resolved via the `task-interface` ACL. Meerkat-taskpanel is only one current implementation (like Jira / Linear / Plane), **not the source of truth**. Identity-code ↔ backend mapping: `team/guides/task-interface.md` §8 / §13. The provider's own project map (`projects.json`) is provider-owned; do not hand-edit it here.
