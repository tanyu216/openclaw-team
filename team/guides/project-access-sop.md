# Project Access & Isolation SOP

> Rule owners: `R-PROJECT-1` (identity / read-write) and `R-PROJECT-2` (isolation / containment), owner Elon.
> This guide is the long-form body; the owner AGENTS blocks are the short rules.

## 1. Project identity

`project` is a **project identity code** resolved through the task-interface ACL. The backend (the reference implementation is meerkat-taskpanel) is swappable with zero upper-layer changes. Root, repos, guides and default git rules come from the project metadata; a card never hard-codes an absolute path.

## 2. Reading and writing

- **Reading** any registered project file is allowed. Read its `CLAUDE.md` first to learn the conventions.
- **Writing to a project repo** requires all of:
  1. the card's `project` is registered;
  2. the card's `target`, `git_rules` and delivery intent are clear;
  3. the project rules are followed.
- The default working directory is `~/.openclaw/team/workspace/<task-id>/`.
- A project may use independent dual repos (source and design docs); execute within the boundaries in its metadata.

## 3. `__team__`

`__team__` is reserved for internal team chores. `lib.get_project('__team__')` does not query the registry and always returns:

```json
{ "root": null, "writable": ["~/.openclaw/team/**"], "repo": null }
```

A card gains no project-repo access from this pseudo-project.

## 4. One card = one project

Independence is the default. A card's `target`/`writes`, and everything it writes, stay inside **that card's own project**. A second project's content or paths are never mixed in, and nothing points outside the project unless the operator explicitly designates the dependency and the card records it.

## 5. Path basis and containment

- `target`/`writes` are **project-internal relative paths**, resolved against the card's project root.
- Absolute paths — in particular `/Users/…`, `~/…` — and `../` anywhere in a path are not the default and are not used.
- A card whose target resolves into another project, or outside any project, is a **carding defect**.
- A project's registered `root` and every `repos[].rel_path` are cwd anchors and must lie inside that project's own `root`; a `rel_path` that escapes is a **registration defect**, rejected at registration.
- Do not place another project's files, content or identifiers into this project's tree, and do not write this project's artifacts into another project's tree. Reading remains allowed.

## 6. Operator-designated dependency

The only exception: when the operator explicitly designates an out-of-project dependency, record it on the card (`task.comment kind=change` — what/why/who) and, for a skill, declare it as a source in `skills/manifest.json`. An out-of-project reference not recorded this way is a carding defect; if carried into execution it is out-of-bounds (`R-OOB-1`). "Same machine / nearby / it is mine" is not a dependency.

## 7. Enforcement

- `scripts/check-card.mjs` reds a non-`__team__` card whose `target`/`writes` escape the project.
- `scripts/seed-projects.mjs` rejects a `root`/`repos[].rel_path` that escapes.
- Scope is non-terminal cards only; terminal cards are grandfathered so history is not retro-reddened.
