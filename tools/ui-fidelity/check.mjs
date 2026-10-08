#!/usr/bin/env node
// ui-fidelity — layered UI fidelity checker.
//
//   L1 structural     : block selectors exist, min counts, no horizontal overflow, clean console
//   L2 pixel regression: screenshot vs baseline (pixelmatch), deterministic viewport/DPR/theme/locale
//   L3 prototype-as-oracle: render prototype AND implementation in the same browser; diff computed
//                        styles per block selector (stronger than comparing screenshots by eye)
//
// Usage:
//   node check.mjs --config ./.ui-fidelity.json [page] [options]
// Options:
//   --json                 machine-readable report on stdout
//   --update-baseline      write current screenshots as the L2 baseline (no failure)
//   --style-strict         make L3 computed-style diffs fail the exit code (default: report only)
//   --max-pixel-ratio N    L2 failure threshold, ratio 0..1 (default 0.002)
//
// Exit codes: 0 pass · 1 assertion failure · 2 config/environment error.
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);

const configPath = resolve(opt("--config", "./.ui-fidelity.json"));
if (!existsSync(configPath)) { console.error(`config not found: ${configPath}`); process.exit(2); }
const cfg = JSON.parse(readFileSync(configPath, "utf8"));
const cfgDir = dirname(configPath);
const onlyPage = argv.find((a) => !a.startsWith("-") && a !== opt("--config") && a !== opt("--max-pixel-ratio") && a !== opt("--json"));

const JSON_OUT = flag("--json");
const UPDATE = flag("--update-baseline");
const STYLE_STRICT = flag("--style-strict");
const MAX_RATIO = Number(opt("--max-pixel-ratio", "0.002"));

const viewports = cfg.viewports ?? [1512, 1240, 980, 760, 430];
const height = cfg.viewportHeight ?? 900;
const theme = cfg.theme ?? "light";
const locale = cfg.locale ?? "en-US";
const DPR = cfg.deviceScaleFactor ?? 1;
const styleProps = cfg.styleProps ?? [
  "color", "background-color", "font-family", "font-size", "font-weight", "line-height",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "border-radius", "display", "gap",
];
const manifestsDir = resolve(cfgDir, cfg.manifests ?? "./manifests");
const outDir = resolve(cfgDir, cfg.outDir ?? "./.ui-fidelity/out");
const baseDir = resolve(cfgDir, cfg.baselineDir ?? "./.ui-fidelity/baseline");
const prototype = cfg.prototype;   // { baseUrl, paths: { page: path } }
const impl = cfg.impl;
if (!prototype?.baseUrl || !impl?.baseUrl) { console.error("config needs prototype.baseUrl and impl.baseUrl"); process.exit(2); }

mkdirSync(outDir, { recursive: true });
mkdirSync(baseDir, { recursive: true });

const pages = Object.keys(manifestsDirList());
function manifestsDirList() {
  if (!existsSync(manifestsDir)) return {};
  const out = {};
  for (const f of readdirSync(manifestsDir)) if (f.endsWith(".json")) out[f.replace(/\.json$/, "")] = join(manifestsDir, f);
  return out;
}

function loadManifest(page) {
  const f = manifestsDirList()[page];
  if (!f) return null;
  return JSON.parse(readFileSync(f, "utf8"));
}

function urlFor(side, page) {
  const base = side.baseUrl.replace(/\/$/, "");
  const p = side.paths?.[page] ?? "/";
  if (base.startsWith("file:")) return p.startsWith("/") ? `file://${p}` : `${base}/${p.replace(/^\//, "")}`;
  return `${base}/${p.replace(/^\//, "")}`;
}

async function applyContext(page, ctx) {
  await page.emulateMedia({ colorScheme: ctx.theme });
  await page.addInitScript(([t, l]) => {
    try {
      localStorage.setItem("theme", t);
      document.documentElement.setAttribute("data-theme", t);
      document.documentElement.setAttribute("lang", l);
    } catch {}
  }, [ctx.theme, ctx.locale]);
}

async function snapshot(page, url, vp, ctx) {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await applyContext(page, ctx);
  await page.setViewportSize({ width: vp, height });
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), ctx.theme);
  await page.waitForTimeout(120);
  return errors;
}

function styleOf(el, props) {
  const cs = getComputedStyle(el);
  const out = {};
  for (const p of props) out[p] = cs.getPropertyValue(p);
  return out;
}

const results = { pages: {}, failures: [], notes: [] };
const browser = await chromium.launch();
try {
  const targets = onlyPage ? [onlyPage] : pages;
  for (const pageName of targets) {
    const man = loadManifest(pageName);
    if (!man) { results.failures.push(`no manifest for page '${pageName}'`); continue; }
    const pageRes = { structural: [], style: [], pixel: [], console: [] };

    // ---- L1 + L3 (per viewport) ----
    for (const vp of man.viewports ?? viewports) {
      const ctx = { theme, locale };
      const pPage = await browser.newPage({ viewport: { width: vp, height }, deviceScaleFactor: DPR, locale });
      const pErr = await snapshot(pPage, urlFor(prototype, pageName), vp, ctx);
      const iPage = await browser.newPage({ viewport: { width: vp, height }, deviceScaleFactor: DPR, locale });
      const iErr = await snapshot(iPage, urlFor(impl, pageName), vp, ctx);

      // L1 structural
      for (const b of man.blocks ?? []) {
        if (!b.selector) continue;
        const cnt = await iPage.locator(b.selector).count();
        const min = b.min ?? 1;
        const ok = cnt >= min && (!b.required || cnt > 0);
        if (!ok) results.failures.push(`[L1 vp=${vp}] ${b.name ?? b.selector}: found ${cnt}, need ≥${min}`);
        pageRes.structural.push({ vp, block: b.name ?? b.selector, count: cnt, need: min, ok });
      }
      const overflow = await iPage.evaluate(() => document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth);
      if (overflow) results.failures.push(`[L1 vp=${vp}] horizontal overflow`);
      // console (implementation side)
      for (const e of iErr) { results.failures.push(`[L1 vp=${vp}] console: ${e}`); pageRes.console.push(e); }

      // L3 prototype-as-oracle: computed style diff per block (first match)
      for (const b of man.blocks ?? []) {
        if (!b.selector) continue;
        const a = await pPage.locator(b.selector).first().evaluate(styleOf, styleProps).catch(() => null);
        const z = await iPage.locator(b.selector).first().evaluate(styleOf, styleProps).catch(() => null);
        if (!a || !z) continue; // missing elements already reported by L1
        const diffs = {};
        for (const p of styleProps) if (a[p] !== z[p]) diffs[p] = { prototype: a[p], impl: z[p] };
        if (Object.keys(diffs).length) {
          pageRes.style.push({ vp, block: b.name ?? b.selector, diffs });
          const msg = `[L3 vp=${vp}] ${b.name ?? b.selector}: ${Object.keys(diffs).join(", ")}`;
          if (STYLE_STRICT) results.failures.push(msg); else results.notes.push(msg);
        }
      }

      // ---- L2 pixel regression (implementation screenshots) ----
      const shot = join(outDir, `${pageName}.${vp}.png`);
      await iPage.screenshot({ path: shot, fullPage: true });
      const base = join(baseDir, `${pageName}.${vp}.png`);
      if (UPDATE || !existsSync(base)) {
        writeFileSync(base, readFileSync(shot));
        results.notes.push(`[L2 vp=${vp}] baseline ${UPDATE ? "updated" : "created"}`);
      } else {
        const a = PNG.sync.read(readFileSync(base));
        const b = PNG.sync.read(readFileSync(shot));
        if (a.width !== b.width || a.height !== b.height) {
          results.failures.push(`[L2 vp=${vp}] size change ${a.width}x${a.height} → ${b.width}x${b.height}`);
        } else {
          const diff = new PNG({ width: a.width, height: a.height });
          const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
          const ratio = n / (a.width * a.height);
          const diffPath = join(outDir, `${pageName}.${vp}.diff.png`);
          writeFileSync(diffPath, PNG.sync.write(diff));
          const ok = ratio <= MAX_RATIO;
          if (!ok) results.failures.push(`[L2 vp=${vp}] pixel diff ${(ratio * 100).toFixed(3)}% > ${(MAX_RATIO * 100).toFixed(3)}% (see ${diffPath})`);
          pageRes.pixel.push({ vp, ratio, ok });
        }
      }
      await pPage.close(); await iPage.close();
    }
    results.pages[pageName] = pageRes;
  }
} finally {
  await browser.close();
}

if (JSON_OUT) {
  console.log(JSON.stringify({ failures: results.failures, notes: results.notes }, null, 2));
} else {
  console.log("== ui-fidelity ==");
  for (const n of results.notes) console.log("  · " + n);
  for (const f of results.failures) console.log("  ✗ " + f);
  console.log(results.failures.length ? `\nFAILED (${results.failures.length})` : "\nPASS");
}
process.exit(results.failures.length ? 1 : 0);
