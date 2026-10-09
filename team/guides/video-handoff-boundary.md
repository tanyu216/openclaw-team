# Video Handoff Boundary (video-handoff-boundary.md)

> Ownership: **Assistant role SOP** (L2.5 method library). Normative text references `PROTOCOL §⑩` (triage matrix / video sole entry point), `§⑤` (message discipline), `§⑦` (ambiguity handling), and Appendix A (data-repo organisation conventions); this file is the execution detail and never copies L1 body.
> **Maintainer**: the **Assistant** role. **Integrator** (sole writer of L1 normative text): **Elon**.
> **Effective**: on adoption (no fixed date).
> **Scope**: L2.5 method library — Assistant → research-role video deliverable shapes + financial/research-video triage.

---

## 1. Sole Entry Point and Boundary (restatement, referencing §⑩)

- **The video (download / text parsing) sole entry point = Assistant**, always dispatched to this role via Elon; other agents (Jobs / Linus / Turing / the research role, if the instance defines one / Elon) **must not download videos on their own** — anyone needing a video reports to Elon, who creates a card and dispatches the Assistant.
- **Assistant does**: download → ASR transcription → subtitle OCR → cross-alignment → produce deliverables.
- **Assistant does not**: the **refinement / placement** of financial (research) videos — owned by the research role, if the instance defines one (its research knowledge base; see Appendix A).
- **Handoff mode**: the Assistant produces "source-level deliverables"; **Elon creates a card** to hand over to the research role for refinement / placement; workers do not dispatch to each other (§⑩).

---

## 2. Assistant → Research-role Deliverable Shapes (★ explicit)

> Deliverables land in `workspace/<task-id>/`; the path is **sent back to Elon in the card Report and the `sessions_send` summary**, for Elon to relay to the research role (do not copy whole documents).

| Deliverable | Path (relative to `workspace/<task-id>/`) | Content | Downstream use |
|---|---|---|---|
| Verbatim transcript | `transcript.txt` | ASR full plain text | refinement baseline |
| Segmented transcript | `transcript.segments.jsonl` | each line has `start_ms` / `end_ms` / text (with timeline) | locating / citing |
| Conflict list (human-readable) | `conflicts.md` | spoken vs subtitle-OCR conflicts, ⚠️ flagged (especially numbers / thresholds) | targeted-correction basis |
| Conflict list (structured) | `conflicts.json` | structured conflict data + terminology-difference hints | machine-readable / review |
| Original video (optional) | `video.mp4` or the original link | for review if needed | review |
| Alignment screenshots (optional) | `frames/` or OCR screenshots | subtitle-area OCR evidence | review |

**Stance**:
- **Authority precedence**: for a conflict, **the on-screen embedded subtitle prevails** (Appendix A stance), but it must be explicitly flagged in `conflicts.md` for manual review.
- **Terminology hints**: OCR/ASR terminology differences (e.g. `ca1985` vs `Kyle 1985`) go into the terminology-difference section of `conflicts.json`.
- **No refinement**: the Assistant delivers source-level products only — **no material card, no placement, no filling in the knowledge-base frontmatter** (owned by the research role).
- **Stable paths**: delivery paths must be written into the card Report; the research role's refined draft starts in the research knowledge base's `00-inbox/`, and the source path is written into frontmatter (Appendix A); do not copy whole documents.

---

## 3. Financial vs Non-Financial Video Triage (★ owner)

**Triage owner: Elon** (sole dispatcher / card creator). Reason: triage decides a video's destination (the research knowledge base vs other), which is a dispatch matter; the Assistant only executes download/parsing and does not decide placement itself (§⑩ / §⑤).

**Triage rules (for Elon to judge; the Assistant may **flag a suggestion** but does not self-decide)**:

| Video topic | Destination | Note |
|---|---|---|
| The instance's primary research domain | the research role (research knowledge base) | Appendix A material scope |
| Adjacent domain, methodological reference value | the research role (**methodology reference only**) | Appendix A: adjacent-domain material is not a practical basis for the primary-domain research |
| Non-research (personal / tech etc.) | Elon self-organises (other knowledge bases) | §⑩: non-research is not collected by the research role |
| Unclear / ambiguous | **set `blocked` and send back to Elon to clarify** (§⑦) | do not speculate |

> The domain split above is **illustrative of the shape** — the concrete "primary research domain" and "adjacent domains" are **instance-defined**; the triage shape (in-scope / methodological-reference / non-research / ambiguous) is what is fixed.

**The Assistant may write "triage suggestion: <destination> (reason)" in the card report; the final destination is decided by Elon, who creates the corresponding card.**

---

## 4. Handoff Checklist (Assistant side, before delivery)

- [ ] `transcript.txt` / `transcript.segments.jsonl` exist and are non-empty
- [ ] `conflicts.md` / `conflicts.json` exist (even with no conflict, produce a "no conflict" note)
- [ ] Terminology differences are listed separately
- [ ] Delivery paths are written into the card Report
- [ ] Triage suggestion (financial / non-financial) is flagged and sent back to Elon
- [ ] (If financial) reminded that "refinement / placement belongs to the research role; the Assistant does not do it"

---

## 5. Open Items / Gaps

1. Whether the original video is copied to the research role with the handoff, or only the path is given (recommend: path only + copy on demand, to save space).
2. Whether deliverable names should include the video platform / short-link id (recommend yes, to distinguish multiple videos).
3. Whether the research knowledge base should pre-set a fixed receiving path for "financial videos" (needs research-role / Appendix A confirmation).
4. Whether the boundary with Appendix A needs Elon to explicitly add an "Assistant → research-role video handoff" reference line in §⑩ / Appendix A.
