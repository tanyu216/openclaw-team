#!/usr/bin/env node
/**
 * optimization-backfill.test.mjs — A2: providers backfill merges missing fields only,
 * never overwrites an existing (customised) value, and re-emits the COMPLETE models
 * array (config patch replaces arrays, so a sparse element would fail schema).
 *
 * contextTokens is gated by `model.contextWindow > threshold` (NOT deepseek-only):
 * only models whose declared context window exceeds the target get a backfilled
 * contextTokens; unknown/≤threshold windows are skipped (never guess). The
 * OPENCLAW_TEAM_CONTEXT_TOKENS_ALL=1 wildcard ignores the window check.
 *
 * Run: node --test test/install/optimization-backfill.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeProvidersPatch,
  DEFAULT_CONTEXT_TOKENS,
} from "../../config/optimization.mjs";

const deepseekProvider = {
  deepseek: {
    models: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1000000 },
      { id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 1000000 },
    ],
  },
};

test("contextWindow (1000000) > threshold & contextTokens missing → backfilled 200000", () => {
  const { patch, applied } = computeProvidersPatch(deepseekProvider);
  assert.equal(patch.deepseek.models[0].contextTokens, DEFAULT_CONTEXT_TOKENS);
  assert.equal(patch.deepseek.models[1].contextTokens, DEFAULT_CONTEXT_TOKENS);
  assert.equal(applied.length, 4); // 2× contextTokens + 2× cacheRead
});

test("non-deepseek model with contextWindow > threshold ⇒ backfilled (window, not vendor)", () => {
  const providers = {
    moonshot: {
      models: [{ id: "kimi-k2", name: "Kimi K2", contextWindow: 256000 }],
    },
  };
  const { patch, applied } = computeProvidersPatch(providers);
  assert.equal(patch.moonshot.models[0].contextTokens, DEFAULT_CONTEXT_TOKENS, "window-gated, not deepseek-only");
  assert.deepEqual(applied, ["moonshot:kimi-k2.contextTokens=200000"]);
});

test("contextWindow == threshold (200000) ⇒ skipped, e.g. minimax", () => {
  const providers = {
    minimax: {
      models: [{ id: "minimax-m2", name: "MiniMax M2", contextWindow: 200000 }],
    },
  };
  // pre-red: the fixture sits EXACTLY on the boundary, so the skip only holds if the gate
  // is strictly greater (`>=` would wrongly backfill here) — a vacuous "never backfills"
  // implementation cannot satisfy this precondition.
  assert.equal(providers.minimax.models[0].contextWindow, DEFAULT_CONTEXT_TOKENS, "fixture must sit exactly on the threshold");
  const { patch, applied } = computeProvidersPatch(providers);
  assert.equal(patch.minimax?.models?.[0]?.contextTokens, undefined, "window == threshold must not be backfilled");
  assert.deepEqual(applied, []);
  // positive control: threshold+1 IS backfilled — the skip above is discriminating, not a
  // blanket refusal.
  const above = computeProvidersPatch({ m: { models: [{ id: "m-1", name: "M1", contextWindow: DEFAULT_CONTEXT_TOKENS + 1 }] } });
  assert.equal(above.patch.m.models[0].contextTokens, DEFAULT_CONTEXT_TOKENS, "threshold+1 must be backfilled");
});

test("contextWindow unknown (field absent) ⇒ skipped, never guess", () => {
  const providers = {
    acme: {
      models: [{ id: "acme-1", name: "Acme 1" }],
    },
  };
  // pre-red: the window is genuinely ABSENT (not 0/NaN) — the skip must come from
  // "unknown", and this model must still be eligible under the wildcard.
  assert.equal("contextWindow" in providers.acme.models[0], false, "fixture must have NO contextWindow");
  const { patch, applied } = computeProvidersPatch(providers);
  assert.equal(patch.acme?.models?.[0]?.contextTokens, undefined, "unknown window must not be backfilled");
  assert.deepEqual(applied, []);
  // positive control: the wildcard DOES backfill this same model — the default-mode skip is
  // due to the unknown window, not a function that refuses the model outright.
  const wild = computeProvidersPatch(providers, { allModels: true });
  assert.equal(wild.patch.acme.models[0].contextTokens, DEFAULT_CONTEXT_TOKENS, "wildcard must backfill the unknown-window model");
});

test("existing custom contextTokens is PRESERVED even when window > threshold", () => {
  const providers = {
    deepseek: {
      models: [{ id: "deepseek-v4-pro", name: "Pro", contextWindow: 1000000, contextTokens: 333333 }],
    },
  };
  const { patch } = computeProvidersPatch(providers);
  assert.equal(patch.deepseek.models[0].contextTokens, 333333, "custom contextTokens must not be overwritten");
});

test("allModels wildcard ignores the window check: unknown/≤threshold also backfilled", () => {
  const providers = {
    minimax: {
      models: [{ id: "minimax-m2", name: "MiniMax M2", contextWindow: 200000 }],
    },
    acme: {
      models: [{ id: "acme-1", name: "Acme 1" }], // no contextWindow at all
    },
  };
  const { patch } = computeProvidersPatch(providers, { allModels: true });
  assert.equal(patch.minimax.models[0].contextTokens, DEFAULT_CONTEXT_TOKENS);
  assert.equal(patch.acme.models[0].contextTokens, DEFAULT_CONTEXT_TOKENS);
});

test("deepseek cacheRead whitelist: flash→0.006, v4-pro→0.003625 (missing only)", () => {
  const { patch } = computeProvidersPatch(deepseekProvider);
  // literal values, not the module's own DEEPSEEK_CACHE_READ constant — asserting against
  // the same export would self-certify a wrong constant.
  assert.equal(patch.deepseek.models.find((m) => m.id === "deepseek-flash").cost.cacheRead, 0.006);
  assert.equal(patch.deepseek.models.find((m) => m.id === "deepseek-v4-pro").cost.cacheRead, 0.003625);
});

test("existing custom cost.cacheRead is PRESERVED", () => {
  const providers = {
    deepseek: {
      models: [{ id: "deepseek-flash", name: "Flash", contextWindow: 1000000, cost: { cacheRead: 0.999, input: 0.1 } }],
    },
  };
  const { patch } = computeProvidersPatch(providers);
  assert.equal(patch.deepseek.models[0].cost.cacheRead, 0.999, "custom cacheRead must not be overwritten");
  assert.equal(patch.deepseek.models[0].cost.input, 0.1, "other cost fields must be untouched");
});

test("malformed non-object cost (string/number/null) ⇒ NOT clobbered into {cacheRead}", () => {
  // bb139ff edge: `cost` present but non-object. Backfill must leave it untouched rather
  // than replace it with `{cacheRead}` — overwriting even a malformed user value is wrong.
  for (const badCost of ["oops", 5, null]) {
    const providers = {
      deepseek: {
        models: [{ id: "deepseek-flash", name: "Flash", contextWindow: 1000000, cost: badCost }],
      },
    };
    const { patch, applied } = computeProvidersPatch(providers);
    assert.deepEqual(patch.deepseek.models[0].cost, badCost, `cost ${JSON.stringify(badCost)} must be left untouched`);
    assert.equal(patch.deepseek.models[0].contextTokens, DEFAULT_CONTEXT_TOKENS, "unrelated contextTokens backfill still happens");
    assert.equal(
      applied.some((a) => a.includes("cacheRead")),
      false,
      `no cacheRead written onto a malformed cost ${JSON.stringify(badCost)}`,
    );
  }
});

test("array cost ([]/[1]) ⇒ NOT clobbered into {cacheRead}; no false applied report", () => {
  // Turing observation on T-20261010-051200: `typeof [] === "object"` slipped arrays past the
  // object guard — the backfill wrote a non-index `cacheRead` property onto the array.
  // JSON.stringify drops non-index array properties, so on the JSON CLI path the patch would
  // silently OMIT the change while `applied`/stderr claimed it was made. No data harm, but the
  // report was a lie. The guard must exclude arrays alongside other non-objects.
  for (const arrCost of [[], [1]]) {
    const providers = {
      deepseek: {
        models: [{ id: "deepseek-flash", name: "Flash", contextWindow: 1000000, cost: structuredClone(arrCost) }],
      },
    };
    const { patch, applied } = computeProvidersPatch(providers);
    assert.deepEqual(patch.deepseek.models[0].cost, arrCost, `cost ${JSON.stringify(arrCost)} must be left untouched`);
    assert.equal(patch.deepseek.models[0].contextTokens, DEFAULT_CONTEXT_TOKENS, "unrelated contextTokens backfill still happens");
    assert.equal(
      applied.some((a) => a.includes("cacheRead")),
      false,
      `no cacheRead written onto an array cost ${JSON.stringify(arrCost)}`,
    );
    // NON-discriminating sanity check — the JSON round-trip assertion below does NOT fail pre-fix
    // (measured), so it must not be read as this guard's proof. `patch…cost` is the array produced
    // by `deepClone` (arrays via `v.map(deepClone)`), and `JSON.stringify` drops non-index array
    // properties on BOTH sides, so the hidden `cacheRead` the pre-fix code wrote vanishes before the
    // comparison and the assertion passes with or without the fix.
    // The assertions in this test that DO have discriminating power (i.e. fail pre-fix) are the two
    // above, not this one:
    //   · `assert.deepEqual(patch.deepseek.models[0].cost, arrCost)` — deepStrictEqual compares own
    //     enumerable keys, so it sees the stray non-index `cacheRead` the weak guard let through;
    //   · `assert.equal(applied.some((a) => a.includes("cacheRead")), false)` — pre-fix the code
    //     reported a change the JSON CLI patch never carried (the phantom `applied`).
    const roundTripped = JSON.parse(JSON.stringify(patch.deepseek.models[0].cost));
    assert.deepEqual(roundTripped, arrCost, `array cost ${JSON.stringify(arrCost)} must survive the JSON round-trip unchanged`);
  }
});

test("non-deepseek model, window unknown: contextTokens NOT backfilled; cacheRead never", () => {
  const providers = {
    openai: {
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    },
  };
  const { patch, applied } = computeProvidersPatch(providers);
  assert.deepEqual(patch, {}, "no backfill for an unknown-window model in default mode");
  assert.deepEqual(applied, []);
});

test("non-deepseek model with allModels opt-in: contextTokens backfilled, cacheRead still not", () => {
  const providers = {
    openai: {
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    },
  };
  const { patch } = computeProvidersPatch(providers, { allModels: true });
  assert.equal(patch.openai.models[0].contextTokens, DEFAULT_CONTEXT_TOKENS);
  assert.equal(patch.openai.models[0].cost, undefined, "cacheRead must never be backfilled for non-whitelisted ids");
});

test("all satisfied ⇒ empty patch / applied=[]", () => {
  const providers = {
    deepseek: {
      models: [
        { id: "deepseek-v4-pro", name: "Pro", contextWindow: 1000000, contextTokens: 200000, cost: { cacheRead: 0.003625 } },
        { id: "deepseek-flash", name: "Flash", contextWindow: 1000000, contextTokens: 200000, cost: { cacheRead: 0.006 } },
      ],
    },
  };
  const { patch, applied } = computeProvidersPatch(providers);
  assert.deepEqual(patch, {});
  assert.deepEqual(applied, []);
});

test("contract: the emitted patch preserves EVERY input field (array ⊇ input)", () => {
  const providers = {
    deepseek: {
      name: "DeepSeek",
      models: [
        { id: "deepseek-v4-pro", name: "Pro", contextWindow: 1000000, contextTokens: 12345, cost: { input: 0.1, output: 0.2 } },
      ],
    },
    openai: {
      models: [{ id: "gpt-4o", name: "GPT-4o", tags: ["a", "b"] }],
    },
  };
  const { patch } = computeProvidersPatch(providers);

  // every field of every input provider/model must survive into the patch
  assert.equal(patch.deepseek.name, "DeepSeek");
  assert.equal(patch.deepseek.models.length, 1);
  assert.equal(patch.deepseek.models[0].id, "deepseek-v4-pro");
  assert.equal(patch.deepseek.models[0].name, "Pro");
  assert.equal(patch.deepseek.models[0].contextWindow, 1000000);
  assert.equal(patch.deepseek.models[0].contextTokens, 12345, "preserved, not rewritten");
  assert.deepEqual(patch.deepseek.models[0].cost.input, 0.1);
  assert.deepEqual(patch.deepseek.models[0].cost.output, 0.2);
  assert.equal(patch.openai.models[0].id, "gpt-4o");
  assert.equal(patch.openai.models[0].name, "GPT-4o");
  assert.deepEqual(patch.openai.models[0].tags, ["a", "b"]);

  // the one missing field (deepseek cacheRead) was filled on top of the preserved cost object
  assert.equal(patch.deepseek.models[0].cost.cacheRead, 0.003625);
});

test("missing / non-object providers ⇒ empty patch", () => {
  assert.deepEqual(computeProvidersPatch(undefined), { patch: {}, applied: [] });
  assert.deepEqual(computeProvidersPatch(null), { patch: {}, applied: [] });
  assert.deepEqual(computeProvidersPatch([]), { patch: {}, applied: [] });
  assert.deepEqual(computeProvidersPatch({}, { allModels: true }), { patch: {}, applied: [] });
});
