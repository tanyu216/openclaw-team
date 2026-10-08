# ui-fidelity — layered UI fidelity checker

Turns UI fidelity from "looks like" into a deterministic, containerized gate.
Complements the existing **structure** engine (`tools/ui-align`) rather than
replacing it.

| Layer | What | Fails the exit code? |
|---|---|---|
| **L1 structural** | block selectors exist · `min` counts · no horizontal overflow · clean console | yes |
| **L2 pixel regression** | full-page screenshot vs baseline, `pixelmatch` ratio ≤ threshold | yes |
| **L3 prototype-as-oracle** | render **prototype AND implementation in the same browser**, diff **computed styles** per block selector | only with `--style-strict` (report by default) |
| L5 a11y | (roadmap: axe-core at each viewport) | — |

> L3 is the key upgrade: the design baseline is the **prototype itself rendered by
> the same engine**, so per-element deltas are objective — far stronger than
> eyeballing two screenshots.

## Config — `.ui-fidelity.json`

```json
{
  "prototype": { "baseUrl": "file:", "paths": { "home": "/abs/prototype/home.html" } },
  "impl":      { "baseUrl": "http://localhost:5173", "paths": { "home": "/" } },
  "manifests": "./manifests",
  "outDir": "./.ui-fidelity/out",
  "baselineDir": "./.ui-fidelity/baseline",
  "viewports": [1512, 1240, 980, 760, 430],
  "theme": "light",
  "locale": "en-US",
  "styleProps": ["color", "background-color", "font-family", "font-size", "border-radius", "padding-top", "gap"]
}
```

Manifests live in `manifests/<page>.json` (same contract as the ui-align selector
manifest):

```json
{
  "page": "home",
  "viewports": [1512, 760],
  "blocks": [
    { "name": "top nav", "selector": "[data-nav-topbar]", "required": true },
    { "name": "KPI cards", "selector": "[data-ov-kpi] .kpi-card", "min": 3 }
  ]
}
```

Selectors must use `data-*` semantic hooks, never Tailwind class names. The block
list must include **already-consistent** items (anti-omission).

## Usage

```bash
node check.mjs --config ./.ui-fidelity.json              # L1+L2+L3 report
node check.mjs --config ./.ui-fidelity.json --style-strict
node check.mjs --config ./.ui-fidelity.json --update-baseline
node check.mjs --config ./.ui-fidelity.json --json
```

Exit codes: `0` pass · `1` assertion failure · `2` config/environment error.

## Determinism (why it runs in Docker)

Pixel diffs are brittle: fonts, GPU, DPR and OS rendering cause false positives.
Run this in a **pinned image** (`docker/ui-fidelity/Dockerfile`, official
Playwright base with bundled fonts) with a fixed `deviceScaleFactor`, viewport,
theme and locale — never on a developer laptop. Also mask/stabilize dynamic
regions and **review the diff images**, never blind-pass.

## Self-test

```bash
docker build -f docker/ui-fidelity/Dockerfile -t openclaw-team:ui-fidelity .
docker run --rm openclaw-team:ui-fidelity bash self-test.sh
```

`fixtures/impl-ok.html` (conforming) must pass; `fixtures/impl-bad.html` (missing
block + wrong tokens) must fail.
