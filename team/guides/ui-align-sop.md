# UI Alignment SOP (human-readable end-to-end process)

> **Ownership**: `PROTOCOL §⑨.1` (UI fidelity: prototype is the contract). This file is the **full SOP** referenced by that clause, placed at a stable path (`~/.openclaw/team/guides/ui-align-sop.md`) for humans to execute end to end.
> **Maintainer**: **Jobs** (owner of aesthetics and the UX/UI quality gate). Changes must stay consistent with the text below and must not conflict.
> **Single sources of truth (this file references, does not copy)**:
> - Mechanisms and hard numbering (three lines of defense / acceptance hard gate / anti-patterns / reinforcement clauses / ambiguity discrimination) → `PROTOCOL §⑨.1`;
> - Machine-check engine and manifest schema (`.ui-align.json`, `<page>.json`, the check vocabulary, computed style, exit codes, integration, security model, known boundaries) → `tools/ui-align/README.md`;
> - Assertion artifact contract (selector-manifest JSON + runner determination) → `guides/ui-align-assert-spec.md`;
> - Related redlines: prototype must not contain implementation → `PROTOCOL §⑨.2`; document reference convention → `PROTOCOL §⑥.1 clause 11`; machine-checkable gate landing points → `PROTOCOL §⑳.1`.
> **Reference convention**: always write "document name §section name", with **no line-number anchors and no card-number anchors** (following `§⑥.1 clause 11`).

---

## 1. One-Sentence Principle

**The prototype (design draft) is the design-baseline contract for the implementation, not a reference.** For any UI already present in the prototype, the implementation must **align block by block**; any deviation must be **justified in writing in the card and approved by Elon** — silent simplification and inventing structures absent from the prototype are forbidden.

> What this SOP addresses is consistency in the "prototype → implementation" segment: turning fidelity from a **subjective impression** into a process that is **enumerable (block list), reproducible (assertion script), and determinable (machine check + screenshot dual-core)**.

---

## 2. Three Lines of Defense Overview (who / when / what output / how judged)

Every UI card must complete all three layers; missing any one means unfinished.

| Line | Timing | Owner | Output | Determination / evidence |
|---|---|---|---|---|
| **Before · structural contract** | **before** the card starts | **Jobs** (Elon creates and dispatches the card) | The page's **structural contract**: enumerate all prototype **blocks** (block name / id / role / `data-*` + selector) + data-contract annotation + machine-checkable acceptance points; lands in `workspace/<task-id>/` (manifest JSON, contract version) | The block list **includes "consistent" items** (anti-omission); **no line-number anchors**; serves as the source of the card's machine-check conditions in Acceptance |
| **During · structural assertion** | when development completes | **Linus** | The selector assertion script artifact (`ui-selectors.json` + runner), run through with `tools/ui-align` | If assertions **fail ⇒ the card must not be delivered as todo** (`§⑨.1` hard gate) |
| **After · screenshot comparison** | at acceptance | **Turing** (machine re-run, independent) + **Jobs** (visual certification); **Elon** personally views screenshots at final review | Assertion re-run report + **same viewport × same theme × same language** screenshot comparison (prototype vs implementation) | Dual-core: machine check + visual; Elon **must personally compare screenshots**, not rely only on "API passes/build passes/worker self-report" |

> Note: the three layers' "timings" are **gate positions** — before the structural contract is issued, development should not start; before the during-assertions pass, the card should not be delivered; before the after-comparison is done, Elon should not set done.

---

## 3. End-to-End Process (by stage)

### Stage A · Before card splitting (Elon)
- **Check in-flight segments' dirty-surface files**: UI cards touching the same file must be serial, avoiding "concurrent writes to the same file by two cards" (the `§⑨.1` endnote lesson). The card must explicitly declare the **single writer per file and the serial order**.
- **Attach machine-check conditions at card creation**: a UI card's Acceptance must physically contain the three items "block list (including consistent items) + machine-check assertions (selectors) + screenshot comparison" (`§⑨.1` reinforcement clause). Missing any one ⇒ the card is invalid.
- Dispatch the "before · structural contract" to **Jobs**.

### Stage B · Before-stage contract (Jobs)
1. Read the page's **prototype** in full and enumerate **all blocks** (not just "the ones to build", but the **full set**, including already-consistent items).
2. For each block give: **block name + id/role/`data-*` semantic hook + selector**; annotate the **data contract** (data source/fields/state: loading/empty/error states).
3. Produce the **machine-checkable acceptance points** (selector + count/non-empty, etc.), structurally matching the **selector-manifest JSON** contract in `guides/ui-align-assert-spec.md` (that file defines the artifact schema and runner determination).
4. Selectors **prefer `data-*` semantic hooks** and **must not depend on Tailwind class names** (to avoid breaking JS/tests when class names change; see `PROTOCOL §⑥.1 clause 11` and Jobs's HTML-path conventions).
5. Visual conventions: first confirm the **unified design style guide** (`design-style-guide.md`, the single source of truth for palette/fonts/spacing/tokens); if absent, define it first — **pages must not invent their own** (Jobs is the sole arbiter of aesthetics and style).

### Stage C · During development (Linus)
- Implement per the structural contract; **land each block already present in the prototype one by one**; deviations must be justified in the card and approved by Elon.
- **Prototype text ambiguity discrimination** (`§⑨.1` addendum): the **visible text** in the prototype must distinguish "UI copy" from "annotations written for developers" (e.g. "(static placeholder)", "data API pending backend") — **annotations must not enter the UI**; the prototype side should express "pending wiring" in **non-visible** forms such as comments/`data-pending`.
- **Prototype must not contain implementation** (`§⑨.2`): `prototype/**` is a pure design draft; writing `fetch`/auth/credentials/real endpoints into it is **forbidden**; implementation always lands in the real frontend project directory.

### Stage D · During-stage assertions (Linus)
1. Write `.ui-align.json` at the project root and `<page>.json` in the manifest directory (format in `tools/ui-align/README.md` §3 / §4; this SOP's section 6 gives the minimal steps).
2. Run `check.mjs`: DOM existence / no overflow at five widths / clean console / computed-style dual-side diff.
3. Only when **all assertions pass** may it be delivered as todo; `pending` (unimplemented) blocks count as failures under `--strict` — the point of the full manifest is that **no block can silently disappear**.
4. Results land in files first (`--json`); the Report attaches command + exit code + summary.

### Stage E · Acceptance (Turing machine check + Jobs visual + Elon final review)
1. **Turing** (independent) re-runs the assertion script + checks the acceptance hard gate (section 4); **must not reuse Linus's conclusion**.
2. **Jobs** does UX/UI **visual certification**: browser/tool same viewport (1512/1240/980/760/430) × same theme × same language **screenshot comparison** (prototype vs implementation), block-by-block; check whether any **visible annotations** like "placeholder/pending backend/TODO" appear (if so, reject). The "Issue list" is written to `workspace/<task-id>/review/`.
3. **Elon must personally view screenshots at final review** (`§⑨.1` reinforcement clause), confirm the documentation-impact determination (`§⑫`), then set the terminal state.

### Stage F · Closing
- Check off Acceptance line by line; **documentation-impact determination** (if it touches interfaces/data structures/architecture/config/conventions ⇒ sync the docs; otherwise explicitly declare "no documentation impact") (`§⑫`).
- Differences and leftovers are written into the card's Report; cross-segment decisions are written into `state.md`.

---

## 4. Acceptance Hard Gate (all required before a UI card is done)

Aligned with `PROTOCOL §⑨.1` "acceptance hard gate", landed as operable items:

1. **Full block list (including consistent items)**: **all blocks** of the page are in the list, **including already-consistent items** (anti-omission); every difference has "**file + block name/selector**" evidence (`§⑨.1` hard gate #1).
2. **Machine-check conditions**: the fix card's Acceptance uses **selector assertions (machine-check conditions)**, **not "looks like"**.
3. **The structural assertion script fully passes.**
4. **Screenshot comparison**: same viewport × same theme × same language, **prototype vs implementation** (five widths: 1512/1240/980/760/430).
5. **console / page errors = `[]`**; **no horizontal overflow** at all five widths.
6. **Single writer per file**: the card explicitly declares the serial order (to prevent concurrent writes to the same file by two cards).
7. (Reinforcement) **Elon personally views screenshots at final review**; the **UI card's Acceptance physically contains** "block list + machine-check assertions + screenshot comparison"; missing any one ⇒ must not be done.
8. **Requirement conformance (Turing, independent)**: a **requirement→implementation traceability matrix** — every requirement/prototype block mapped to evidence (selector assertion / screenshot) — filed by Turing against Jobs' baseline; any conformance gap ⇒ not done (`PROTOCOL §⑥.1` clause 13).

---

## 5. Anti-Pattern List (reject on sight)

- Changing only part, **without a full block list**.
- An "inconsistency" conclusion without "file + block name/selector" evidence (judging from impression).
- **Inventing structures absent from the prototype** (e.g. replacing the prototype's Hero card with a self-invented component).
- **Concurrent writes to the same file by multiple cards** (no serialization).
- Substituting "**build passes**" for **visual-alignment acceptance**.
- Rendering the prototype's **developer annotations** ("(static placeholder)", etc.) into the user interface as copy (`§⑨.1` ambiguity discrimination).
- Writing real requests/auth/credentials into `prototype/**`, or using the prototype page as the E2E system under test (`§⑨.2`).
- Substituting "API 200 / build passes / worker self-report" for "**Elon personally views screenshots**".
- Setting todo/delivering when assertions were not run or did not pass.

---

## 6. Integration with `tools/ui-align` (engine and machine-check spec in `README.md`)

> This section gives only the **integration steps and landing points**; all field semantics, defaults, and schema details are governed by `tools/ui-align/README.md` (§3 config / §4 manifest / §5 style / §6 usage and exit codes / §7 integration / §9 security model / §10 boundaries).

### 6.1 Write `<project>/.ui-align.json`
- **Project knowledge may land only in this one file** (the engine has zero project paths/ports/selectors); relative paths are relative to this file's directory (= the project root).
- Required `manifests` (manifest directory). On the implementation side choose one of: `devServer` (recommended; CI need not start the service by hand; use the `{port}` placeholder for `cmd`'s port to pick a free port) or `implBaseUrl`.
- **Mandatory dual-side convention alignment**: `theme` (dark/light) + `locale`/`localeTag` + `apply` (`htmlAttributes`/`localStorage` injection; values support placeholders). **Must compare same theme and same language**, otherwise color-related properties produce swaths of "false differences" that drown the real issues (see `README.md` §5).
- Use `devServer.env` to switch the project to an **offline/sample-data state** (many frontends distinguish wired vs offline state by "whether an environment variable is empty"; what the machine check wants is a structurally complete, zero-request offline state).

### 6.2 Write the manifest `<manifests>/<page>.json`
- Structure = "page + block list": one block per group of assertions, each difference requiring `evidence`; fields/vocabulary in `README.md` §4.
- The check vocabulary is **only six kinds** (`selector` / `scope` / `min|max|count` / `nonEmpty` / `desc`), sufficient and determinable.
- `status`: `delivered` (default) or `pending` (unimplemented ⇒ recorded as SKIP and shown, upgraded to failure by `--strict`).
- **Full from day one**: write the full block list first, marking unimplemented ones `pending` ⇒ no block can silently disappear.

### 6.3 Run `check.mjs`
- Command: `node ~/.openclaw/team/tools/ui-align/check.mjs --config ./.ui-align.json [page] [options]`.
- Produces four classes of determination + a consistency rate: DOM existence / no overflow at five widths / clean console / computed-style dual-side diff (+ human-readable or `--json` report).
- **Exit codes**: `0` all pass | `1` assertion failure | `2` environment/config/manifest error. Style differences do **not** count toward the exit code by default; to gate them, add `--style-strict`.

### 6.4 Wire into CI
- Suggested script: `node ~/.openclaw/team/tools/ui-align/check.mjs --config .ui-align.json --json > ui-align.json`.
- **Gate only exit codes first** (DOM/overflow/console); **add `--style-strict` only after styles stabilize** (to avoid a single tool upgrade turning downstream CI red all at once).
- **Security model** (`README.md` §9): `.ui-align.json`'s `devServer.cmd` is executed, with a **trust level equal to `package.json` scripts** ⇒ **must not** be run directly in "checkout of an unreviewed PR" scenarios (`pull_request_target` types, external contributor branches); for such scenarios run in an independent job **without secrets and offline**, or manually review the config first.

### 6.5 Register the baseline
- Record the numbers from the first run (block count / assertion count / failure count / **style consistency rate**) in the project README — so later regressions have a reference (`README.md` §7).

> Relationship to projects: this repo = the engine and docs; a specific project = `.ui-align.json` + manifests, with the project side only doing a **thin wrapper** that delegates to this tool (the assertion engine is not reimplemented, avoiding two implementations drifting). See `README.md`.

---

## 7. Evidence Format and "Consistent Items Must Also Be in the List"

- **Evidence format**: every difference / every assertion carries `evidence` = a "**file + block name/selector**" location (`§⑨.1` hard gate #1). **Document bodies and references never write line-number anchors**; the precise schema of the tool manifest's `evidence` field is governed by `tools/ui-align/README.md` §4.
- **Consistent items must also be in the list**: the manifest is **the enumeration of all blocks of the page**; items **with no difference must still be listed** (`status: delivered`). Rationale: omissions cannot be found by a "list differences only" method (the historical lesson = a whole block missing yet undiscovered for 5 days). "Full manifest + consistent items" is the only means to prevent omissions.
- **Determination trail**: screenshot comparisons, assertion `--json` reports, and issue lists all land in `workspace/<task-id>/` (evidence does not enter inter-session messages; see `§⑬` token trimming).

---

## 8. Role Division Quick-Reference

| Role | What it does in this SOP |
|---|---|
| **Elon** | Check dirty-surface files before card splitting / create UI cards and attach the three Acceptance items / **personally view screenshots** at final review / approve "deviation rationales" / documentation-impact determination |
| **Jobs** | Before: **structural contract** (full block list + machine-check points) / After: **visual screenshot comparison** certification + "Issue list" / maintain this file and the unified design style guide |
| **Linus** | Implement per the contract / write the manifest and config / get the **during-stage assertions** to pass / self-prove before delivery (command + exit code) |
| **Turing** | **Independently** re-run assertions / check the acceptance hard gate / screenshot comparison (same viewport × same theme × same language) / **requirement-conformance verification** against Jobs' baseline (traceability matrix) |

---

## 9. Known Boundaries (avoid misjudgment)

The tool **compares only DOM facts, not pixels**; computed style covers fonts/colors/box model/layout, etc. (excluding gradient overlays, shadow compositing, anti-aliasing); console is judged only on the implementation side; **elements that require interaction to appear** (opening a drawer/switching a tab) are outside static-assertion scope; `settleMs` is a conservative settle, and a chart that has not converged will be read mid-state. The full list and the reading of "0×0 elements / layout side effects" are in `tools/ui-align/README.md` §5 and §10.

---

## 10. Layered Gate Upgrade — L2 Pixel Regression + L3 Prototype-as-Oracle (recommended)

> The original gate is **structure-only** (§9 Known Boundaries: "compares only DOM facts, not pixels"). The upgrade keeps L1 and adds layers, all **deterministic in Docker**.

| Layer | What | Tool | Gate |
|---|---|---|---|
| L1 structural | blocks / counts / overflow / console / computed-style dual-side diff | `tools/ui-align` | hard |
| **L2 pixel regression** | full-page screenshot vs pinned baseline (`pixelmatch`) | `tools/ui-fidelity` | hard |
| **L3 prototype-as-oracle** | render **prototype and implementation in the same browser**, diff **computed styles** per block | `tools/ui-fidelity` | `--style-strict` |
| L4 design tokens | computed CSS variables equal the design tokens | roadmap | — |
| L5 a11y | axe-core (contrast/labels/roles) across viewports | roadmap | — |
| L6 human/VLM | Elon personally views screenshots (redline) + optional VLM pre-triage | — | hard |

**Determinism rules (mandatory):**
- Run in the pinned image `docker/ui-fidelity/Dockerfile` (bundled fonts + fixed browser) — **never on a developer laptop**.
- Fix `deviceScaleFactor`, viewport, `theme` and `locale`; mask/stabilize dynamic regions.
- **Review the diff images**; never blind-pass. Thresholds are a filter, not a verdict.
- L2 baselines are committed/versioned; `--update-baseline` is a deliberate, reviewed act.

**Why L3 first:** it reuses the existing dual-side computed-style diff and simply points side A at the **prototype rendered by the same engine** — objective per-element deltas, no image brittleness. L2 then covers what DOM cannot (pure pixels: gradients, shadows, icons, charts).

**Prototype carrier:** the baseline source is chosen at install time — `static-html` | `figma` | `google-stitch` | `pixso` (`~/.openclaw/team/team.config.json`). L3 needs a **renderable** prototype; for non-HTML carriers use the exported **static HTML mirror** (or exported screenshots for L2-only). See `roles/linus/AGENTS.md` "Prototype Consumption", `roles/jobs/AGENTS.md` carrier routing.

Run:
```bash
docker/ui-fidelity/verify.sh                    # self-test (conforming passes, violating fails)
node tools/ui-fidelity/check.mjs --config ./.ui-fidelity.json --style-strict
```

## 11. Related Clauses

- Mechanisms/hard-gate thresholds → `PROTOCOL §⑨.1`; prototype must not contain implementation → `PROTOCOL §⑨.2`; container-form acceptance → `PROTOCOL §⑨.3`.
- Two-way document sync (backfill after acceptance) → `PROTOCOL §⑫`; machine-checkable gate landing points → `PROTOCOL §⑳.1`.
- Reference convention (no line-number anchors, no verbatim copying) → `PROTOCOL §⑥.1 clause 11`, `§⑰`.
