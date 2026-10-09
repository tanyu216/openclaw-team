#!/usr/bin/env node
// config/optimization.mjs — providers backfill (read-modify-write over the FULL models array).
//
// `openclaw config patch` merges objects recursively but REPLACES arrays (a sparse
// array element like `models:[{contextTokens:200000}]` fails schema validation because
// `models[0].id`/`.name` are required). So providers backfill cannot be a sparse patch:
// it must re-emit the COMPLETE `models.providers` subtree with only the MISSING fields
// filled in, preserving every existing field (including any user-customised value).
//
// CLI contract (used by install.sh §4b):
//   node config/optimization.mjs <openclaw.json path>
//     stdout = `{}`                         when nothing is missing (nothing to do)
//     stdout = `{"models":{"providers":…}}`  the complete models.providers subtree with
//                                            missing fields backfilled, ready for
//                                            `openclaw config patch --file <tmp>`
//
// Backfill rules (owner-verified, T-20261010-040000):
//   - contextTokens: only for deepseek models (model id or provider key contains
//     "deepseek") unless OPENCLAW_TEAM_CONTEXT_TOKENS_ALL=1 opts into "all models";
//     value OPENCLAW_TEAM_CONTEXT_TOKENS (default 200000); only when the field is absent.
//   - cost.cacheRead: only for whitelisted deepseek model ids (deepseek-flash=0.006,
//     deepseek-v4-pro=0.003625) and only when the field is absent.
//   - NEVER overwrite an existing value (contextTokens, cost.cacheRead, or anything else).

import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Default context window (tokens) the compression lever aims for. */
export const DEFAULT_CONTEXT_TOKENS = 200000;

/** Whitelisted deepseek cache-read costs, keyed by exact model id. */
export const DEEPSEEK_CACHE_READ = {
  "deepseek-flash": 0.006,
  "deepseek-v4-pro": 0.003625,
};

/**
 * Backfill missing fields on the models.providers subtree WITHOUT overwriting any
 * existing value.
 *
 * @param {object|undefined} providers  the value of `models.providers` in openclaw.json
 * @param {object} opts
 *   - contextTokens {number|string} default 200000
 *   - cacheRead     {object}        extra/overriding id→cost map (merged onto the whitelist)
 *   - allModels     {boolean}       backfill contextTokens for non-deepseek models too
 * @returns {{patch: object, applied: string[]}}
 *   - patch: the COMPLETE models.providers subtree when anything changed, else `{}`.
 *   - applied: human-readable list of the changes made.
 */
export function computeProvidersPatch(providers, opts = {}) {
  const contextTokens = numberOr(opts.contextTokens, DEFAULT_CONTEXT_TOKENS);
  const cacheRead = Object.assign({}, DEEPSEEK_CACHE_READ, opts.cacheRead || {});
  const allModels = Boolean(opts.allModels);

  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return { patch: {}, applied: [] };
  }

  const applied = [];
  const out = deepClone(providers);

  for (const [pkey, pval] of Object.entries(out)) {
    if (!pval || typeof pval !== "object" || !Array.isArray(pval.models)) continue;
    const isDeepseekProvider = /deepseek/i.test(String(pkey));
    for (const model of pval.models) {
      if (!model || typeof model !== "object") continue;
      const id = typeof model.id === "string" ? model.id : "";
      const isDeepseekModel = isDeepseekProvider || /deepseek/i.test(id);

      // contextTokens — only deepseek models unless allModels opts in (missing only).
      if (model.contextTokens == null && (allModels || isDeepseekModel)) {
        model.contextTokens = contextTokens;
        applied.push(`${pkey}:${id || "?"}.contextTokens=${contextTokens}`);
      }

      // cost.cacheRead — only whitelisted deepseek ids (missing only).
      if (id && cacheRead[id] != null) {
        const cost = model.cost && typeof model.cost === "object" ? model.cost : (model.cost = {});
        if (cost.cacheRead == null) {
          cost.cacheRead = cacheRead[id];
          applied.push(`${pkey}:${id}.cost.cacheRead=${cacheRead[id]}`);
        }
      }
    }
  }

  return applied.length ? { patch: out, applied } : { patch: {}, applied };
}

/** Read openclaw.json, compute the backfill, and print the patch (or `{}`) on stdout. */
export function main(argvIn = process.argv.slice(2), env = process.env) {
  const cfgPath = argvIn[0];
  if (!cfgPath) { emit({}); process.exit(0); }

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
  catch (e) { emit({}); process.exit(0); }   // missing/unparseable config ⇒ nothing to do

  const providers = cfg && cfg.models ? cfg.models.providers : undefined;
  const { patch, applied } = computeProvidersPatch(providers, {
    contextTokens: env.OPENCLAW_TEAM_CONTEXT_TOKENS,
    allModels: env.OPENCLAW_TEAM_CONTEXT_TOKENS_ALL === "1",
  });

  for (const line of applied) process.stderr.write(`backfill ${line}\n`);
  if (!applied.length) { emit({}); process.exit(0); }
  emit({ models: { providers: patch } });
  process.exit(0);
}

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

function numberOr(v, dflt) {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = deepClone(x);
    return o;
  }
  return v;
}

// Run only when invoked as a CLI — importing this module (unit tests) stays side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
