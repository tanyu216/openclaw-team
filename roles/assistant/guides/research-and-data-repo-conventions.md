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

## 3. Video + transcription + alignment flow
1. Start a browser at the platform short link → fresh cookies (a direct connection to the target platform 403s, so this step is required).
2. Download the video with the **`video-downloader-skill`** skill (needs fresh cookies) → local mp4.
3. Transcribe a verbatim script (specify Chinese) with the ASR backend of the day; artifacts `transcript.txt` + `transcript.segments.jsonl` (with start_ms/end_ms).
4. Subtitle OCR + cross-alignment via the **`subtitle-extractor`** and **`subtitle`** skills: OCR the subtitle band, then cross-align narration vs subtitles.
   ```bash
   <subtitle tool> <video> \
     --segments <asr>/transcript.segments.jsonl \
     --crop 1280:240:0:480 --fps 1 --concurrency 4 \
     --out <outdir>
   ```
   > The alignment tool ships with the `subtitle` / `subtitle-extractor` skills (declared in `skills/manifest.json`), not this repo; if a skill is unavailable ⇒ set the card `blocked` + send back to Elon.
5. The tool cross-aligns narration vs subtitles → marks conflicts → outputs `conflicts.md` (human-readable) + `conflicts.json` (structured) + terminology-difference hints.
6. Write conflict points (especially numbers/thresholds) into the organized document's ⚠️ annotations; terminology hints (e.g. `ca1985` vs `Kyle 1985`) for human review.
7. Delivery: hand `conflicts.md` to the downstream organizer with the material card, ensuring corrections from on-screen subtitles are adopted.
