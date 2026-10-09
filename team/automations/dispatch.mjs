#!/usr/bin/env node
// openclaw-team — provider-agnostic automation dispatcher (framework-owned).
//
// The framework owns *scheduling*; a task provider (meerkat-taskpanel by default) is
// only a *callee* behind the `task-interface` ACL (see team/guides/task-interface.md).
// This dispatcher picks the provider's entry command for a job, runs it WITHOUT a
// shell, and emits a single-line JSON decision on stdout for the Gateway trigger
// script to consume:
//
//   {"fire": <bool>, "message"?: <string>, "state"?: <object>}
//
// Usage:  node dispatch.mjs <job> [agent]      job ∈ poll | patrol | check-all
//
// Provider resolution:
//   provider   = $OPENCLAW_TEAM_TASK_PROVIDER              (default: meerkat-taskpanel)
//                (legacy-name-compat: the pre-rebrand `task-panel` name/key still resolves,
//                 bidirectionally, with a one-line stderr note — see LEGACY_PROVIDER_ALIAS)
//   entry cmd  = providers.json[provider][<job key>], overridable per job with:
//                  poll      -> $OPENCLAW_TEAM_POLL_CMD
//                  patrol    -> $OPENCLAW_TEAM_PATROL_CMD
//                  check-all -> $OPENCLAW_TEAM_CHECKALL_CMD
//
// Placeholders: {team} -> the deployed team dir (~/.openclaw/team, resolved from
// this file's location); {agent} -> the agent argument.
//
// Trigger-evaluation timeout (③): the provider entry runs synchronously, so its
// wall clock IS the trigger evaluation's wall clock. It is bounded by
// OPENCLAW_TEAM_EVAL_TIMEOUT_MS (default 8000 ms; invalid/absent ⇒ default) and
// stays well under the Gateway's own 30 s per-evaluation budget. See
// team/AUTOMATIONS.md §3.5 for what this does NOT cover (`already-running` / stale
// run release are Gateway-scheduler concerns).
//
// Degrade-without-burning: a missing/invalid provider config, an unrunnable entry,
// a non-zero exit, a timeout, or an unparseable result prints
// {"fire":false, "state":{...}} and exits 0 — it never throws and never wakes a
// model on its own.

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <TEAM_DIR>/automations
const TEAM_DIR = path.resolve(HERE, "..");                 // <TEAM_DIR>
const PROVIDERS_FILE = path.join(HERE, "providers.json");

// legacy-name-compat: the pre-rebrand provider name. Mapped *bidirectionally* so BOTH an old
// OPENCLAW_TEAM_TASK_PROVIDER value and a providers.json still carrying the old key
// (e.g. preserved by install.sh --keep-existing) resolve after the rename to meerkat-taskpanel.
const LEGACY_PROVIDER_ALIAS = { "meerkat-taskpanel": "task-panel", "task-panel": "meerkat-taskpanel" }; // legacy-name-compat

// job -> providers.json key, and -> env override var
const JOB_KEY = { poll: "poll", patrol: "patrol", "check-all": "checkAll" };
const JOB_ENV = {
  poll: "OPENCLAW_TEAM_POLL_CMD",
  patrol: "OPENCLAW_TEAM_PATROL_CMD",
  "check-all": "OPENCLAW_TEAM_CHECKALL_CMD",
};

/** Default trigger-evaluation bound (ms): one multi-claim poll evaluation fits well inside it. */
export const DEFAULT_EVAL_TIMEOUT_MS = 8000;

/**
 * Resolve the trigger-evaluation timeout from a raw env value.
 * A positive finite number (floored) wins; anything else falls back to the default
 * so a typo can never widen the bound to "unbounded".
 */
export function resolveEvalTimeoutMs(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return DEFAULT_EVAL_TIMEOUT_MS;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_EVAL_TIMEOUT_MS;
}

/** Effective bound for the evaluation in flight; set by main() from the job env. */
let EVAL_TIMEOUT_MS = DEFAULT_EVAL_TIMEOUT_MS;

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function degrade(job, reason, extra) {
  emit({ fire: false, state: Object.assign({ job: job || "", reason, evalTimeoutMs: EVAL_TIMEOUT_MS, at: Date.now() }, extra || {}) });
  process.exit(0);
}

export function main(argvIn = process.argv.slice(2), env = process.env) {
  const job = argvIn[0] || "";
  const agent = argvIn[1] || "";
  EVAL_TIMEOUT_MS = resolveEvalTimeoutMs(env.OPENCLAW_TEAM_EVAL_TIMEOUT_MS);
  if (!JOB_KEY[job]) degrade(job, "unknown-job", { usage: "dispatch.mjs <poll|patrol|check-all> [agent]" });

  let provider = env.OPENCLAW_TEAM_TASK_PROVIDER || "meerkat-taskpanel";

  // 1) entry command: env override first, else providers.json
  let template = String(env[JOB_ENV[job]] || "").trim();
  if (!template) {
    let providers;
    try { providers = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8")); }
    catch (e) { degrade(job, "providers.json-missing-or-invalid", { provider }); }
    let p = providers[provider];
    const alias = LEGACY_PROVIDER_ALIAS[provider];
    if ((!p || typeof p !== "object") && alias && providers[alias]) {
      process.stderr.write(`[dispatch] provider "${provider}" 已弃用（legacy-name-compat）：改用 "${alias}"\n`);
      provider = alias; p = providers[alias];
    }
    if (!p || typeof p !== "object") degrade(job, "provider-not-found", { provider });
    template = String(p[JOB_KEY[job]] || "").trim();
    if (!template) degrade(job, "entry-not-configured", { provider, jobKey: JOB_KEY[job] });
  }

  // 2) substitute placeholders (absolute TEAM_DIR; {agent} only where used)
  if (/\{agent\}/.test(template) && !agent) degrade(job, "agent-required", { provider });
  const expanded = template.replace(/\{team\}/g, TEAM_DIR).replace(/\{agent\}/g, agent);

  // 3) build argv explicitly (no shell ⇒ no injection); honour "..." quoting
  const argv = tokenize(expanded);
  if (!argv.length) degrade(job, "empty-entry", { provider });

  // 4) run — bounded (③): a hung entry degrades instead of stalling the evaluation
  const res = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: EVAL_TIMEOUT_MS });
  if (res.error) {
    const code = String(res.error.code || "");
    if (code === "ETIMEDOUT") degrade(job, "eval-timeout", { provider, timeoutMs: EVAL_TIMEOUT_MS });
    degrade(job, "spawn-error", { provider, detail: String(res.error.message || res.error) });
  }
  if (res.status !== 0) degrade(job, "exec-failed", { provider, exit: res.status, stderr: tail(res.stderr) });

  // 5) parse the LAST non-empty stdout line as the provider's result envelope
  let r = null;
  try { r = JSON.parse(lastLine(res.stdout)); } catch (e) { r = null; }
  if (!r || typeof r !== "object" || Array.isArray(r)) degrade(job, "parse-failed", { provider, stdout: tail(res.stdout) });

  // 6) normalize to the {fire} envelope (generic JSON conventions, not provider-specific)
  let fire;
  if (typeof r.fire === "boolean") fire = r.fire;              // canonical
  else if (Array.isArray(r.stale)) fire = r.stale.length > 0;  // patrol convention
  else if (typeof r.ok === "boolean") fire = !r.ok;            // health-check convention
  else degrade(job, "no-fire-field", { provider, keys: Object.keys(r) });

  const out = { fire };
  if (r.message) out.message = String(r.message);
  else if (fire && Array.isArray(r.stale)) out.message = "[task-patrol] stale in_progress cards: " + JSON.stringify(r.stale);
  out.state = Object.assign({ job, provider, evalTimeoutMs: EVAL_TIMEOUT_MS, at: Date.now() }, r.state && typeof r.state === "object" ? r.state : {});
  emit(out);
  process.exit(0);
}

// Run only when invoked as a CLI — importing this module (unit tests) must stay side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

// ---- helpers ---------------------------------------------------------------
function tokenize(s) {
  const out = []; let cur = "", q = null;
  for (const ch of String(s)) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ""; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function lastLine(s) {
  const lines = String(s || "").split("\n").map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}
function tail(s, n = 300) { s = String(s || "").trim(); return s.length > n ? s.slice(-n) : s; }
