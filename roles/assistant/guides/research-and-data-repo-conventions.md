# Research & Data-Repo Conventions (Assistant role-owned)

> Method home for `PROTOCOL §18` and the gates volume's Appendix A. L1 keeps the normative
> summaries; this guide carries the operational detail. Load it for research outputs and for
> material organization in a data repo.

## 1. Research convention hard constraints

- Do not speculate; if the convention is undecided, first follow `PROTOCOL §13.5` (decision fork first).
- Any conclusion (metric/experiment/comparison) **must attach the convention + reproducible commands + output trail**; missing = considered incomplete.
- Research items go through the **full lifecycle**: definition → single-item analysis → evaluation (out-of-sample/robustness) → conclusion and disposition; do not skip stages.
- A research Report missing "reproducible commands / data convention" ⇒ check fails.

## 2. Data-repo organization conventions

- **Material scope**: organize by project/topic (research/tech/product, etc. all fine). Sources = video / web page / **PDF / md notes**. **Material unrelated to the project topic is not collected** → report it to Elon to file into the corresponding data repo.
- **Directory structure / templates / frontmatter source enum**: the `README.md` and `_templates/` in each data repo root are the **sole authority** (see the repo navigation). Extending a source value requires first changing the template, then syncing each role's clauses.
- Video material: download + transcript draft temporarily stored in `00-inbox/` → refined draft filed → the draft path is written into frontmatter; do not move the whole transcript.
- PDF/md notes: extract text/normalize → material card (add frontmatter, file it), retaining the source note.
- Conclusions must attach the convention and reproducible commands; do not write a conclusion without its basis.
- Use `[[double links]]` for association within the repo; the body does not write absolute paths outside the repo (except command examples).
- **Directory governance**: when a subdirectory exceeds ~30 files, consider subdirectory-izing/renaming; adjustments = move + sync the README structure description and affected double links; **archive only, never delete**.
- ⚠️ Fact note: the data repo root may itself be a git repo with an auto-commit mechanism, and files added/moved within the repo fall into that repo's tracking scope; the repo itself may have no independent git repo, so the material-organization role need not perform git operations — but if independent traceability is needed before changes, copy a snapshot to `team/workspace/<task-id>/`.
