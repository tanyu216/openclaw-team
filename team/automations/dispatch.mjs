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
// wall clock IS the trigger evaluation's wall clock. The whole decision is bounded by
// OPENCLAW_TEAM_EVAL_TIMEOUT_MS (default 8000 ms; invalid/absent ⇒ default) and stays
// well under the Gateway's own 30 s per-evaluation budget. The entry itself gets that
// budget MINUS EVAL_EMIT_RESERVE_MS so the dispatcher still has room to print its verdict
// inside the caller's bound (install.sh sizes the trigger's exec timeoutSeconds at
// ceil(budget/1000) — i.e. only ever EQUAL to the inner bound, never larger). See
// team/AUTOMATIONS.md §3.5 for what this does NOT cover (`already-running` / stale
// run release are Gateway-scheduler concerns).
//
// Degrade policy — degrade-without-burning by default, with ONE deliberate exception:
//   * ACTION jobs (poll / patrol): a missing/invalid provider config, an unrunnable entry,
//     a non-zero exit, a timeout or an unparseable result prints {"fire":false,"state":{…}}
//     and exits 0 — it never throws and never wakes a model on its own.
//   * GATE job (check-all): a degrade means the gate's state is UNCONFIRMED, and an
//     unconfirmed gate must ALARM — it prints {"fire":true,"message":…,"state":{…}} instead
//     of reporting green (T-20261010-190039 / O1: reading "unknown" as "green" silently
//     drops the warning). A non-zero exit is not the gate's verdict on its own: an
//     {"ok":false} envelope on stdout is recovered FIRST (reason `gate-failed`), because
//     check-all.sh prints exactly that envelope and then `exit $fail`.

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
 * Emission headroom (ms) the dispatcher keeps OUT of the entry's own timeout so that its
 * decision still fits inside the SAME evaluation budget (T-20261010-190039).
 *
 * install.sh sizes the trigger's `exec({ timeoutSeconds })` at ceil(budget/1000) — the OUTER
 * bound is therefore only ever EQUAL to the inner one, never larger. Let the entry consume the
 * whole budget and the outer exec kills the dispatcher before it can print: measured with an
 * 8000 ms entry bound the process dies at 8008 ms with EMPTY stdout, so the verdict — and with
 * it every failure alarm — is lost at the trigger layer no matter what the dispatcher meant to
 * say. Measured dispatcher overhead (startup + spawn + emit + exit) is 65–137 ms, so 500 ms is
 * a wide margin.
 */
export const EVAL_EMIT_RESERVE_MS = 500;

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

/**
 * The budget the provider ENTRY gets: the evaluation budget minus EVAL_EMIT_RESERVE_MS, so the
 * dispatcher can still print its decision inside the caller's own bound. The reserve is capped
 * at half the budget (a tiny bound must not collapse to zero) and the result never drops below 1.
 */
export function entryTimeoutMs(bound) {
  const b = Math.floor(bound);
  return Math.max(1, b - Math.min(EVAL_EMIT_RESERVE_MS, Math.floor(b / 2)));
}

/**
 * Fail-safe policy (T-20261010-190039): a HEALTH GATE (`check-all`) whose evaluation could not
 * be CONFIRMED must fire — its whole purpose is to surface failure, so `fire:false` on a
 * timeout / spawn error / non-zero exit / unparseable result reads "unknown" as "green" and
 * silently drops the alarm (O1). ACTION jobs (poll / patrol) keep degrade-without-burning: a
 * failed evaluation should simply not wake anyone.
 */
export function firesOnDegrade(job) { return job === "check-all"; }

/** Budget + entry bound for the evaluation in flight; set by main() from the job env. */
let EVAL_TIMEOUT_MS = DEFAULT_EVAL_TIMEOUT_MS;
let ENTRY_TIMEOUT_MS = entryTimeoutMs(DEFAULT_EVAL_TIMEOUT_MS);

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

/**
 * Alarm text for a degenerate GATE — the trigger forwards `message` to the woken model, so it
 * carries BOTH the cause and the action. The trailing directive mirrors the `--message` that
 * install.sh registers for team-check-all, so a fired alarm stays as actionable as the curated
 * one it may replace.
 */
function alarmMessage(job, reason, extra) {
  const d = extra || {};
  const bits = [reason];
  if (d.exit !== undefined) bits.push("exit=" + d.exit);
  if (d.timeoutMs !== undefined) bits.push("entryTimeoutMs=" + d.timeoutMs);
  if (d.detail) bits.push(String(d.detail));
  return `[${job}] gate UNCONFIRMED (${bits.join("; ")}) — unknown ≠ green: run the team gate checks and handle per the PROTOCOL gates/archiving rules.`;
}

function degrade(job, reason, extra) {
  const fire = firesOnDegrade(job);
  const out = { fire, state: Object.assign({ job: job || "", reason, evalTimeoutMs: EVAL_TIMEOUT_MS, at: Date.now() }, extra || {}) };
  if (fire) out.message = alarmMessage(job, reason, extra);
  emit(out);
  process.exit(0);
}

export function main(argvIn = process.argv.slice(2), env = process.env) {
  const job = argvIn[0] || "";
  const agent = argvIn[1] || "";
  EVAL_TIMEOUT_MS = resolveEvalTimeoutMs(env.OPENCLAW_TEAM_EVAL_TIMEOUT_MS);
  ENTRY_TIMEOUT_MS = entryTimeoutMs(EVAL_TIMEOUT_MS);
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

  // 4) run — bounded (③): a hung entry degrades instead of stalling the evaluation.
  //    The entry gets the budget MINUS the emission reserve so the decision below still
  //    lands inside the caller's own (equal) bound — see EVAL_EMIT_RESERVE_MS.
  const res = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: ENTRY_TIMEOUT_MS });
  if (res.error) {
    const code = String(res.error.code || "");
    if (code === "ETIMEDOUT") degrade(job, "eval-timeout", { provider, timeoutMs: ENTRY_TIMEOUT_MS });
    degrade(job, "spawn-error", { provider, detail: String(res.error.message || res.error) });
  }

  // 5) parse the LAST non-empty stdout line as the provider's result envelope.
  //    Parsed BEFORE the exit code is judged: a health gate reports its verdict as
  //    {"ok":false} and exits non-zero in the same breath (check-all.sh: `exit $fail`),
  //    so judging the exit code alone would discard the gate's own verdict (O1).
  let r = null;
  try { r = JSON.parse(lastLine(res.stdout)); } catch (e) { r = null; }
  const envelope = r && typeof r === "object" && !Array.isArray(r) ? r : null;

  if (res.status !== 0) {
    if (firesOnDegrade(job) && envelope && envelope.ok === false) {
      // Recover the gate's verdict rather than reading the exit code alone (O1).
      emit({
        fire: true,
        message: envelope.message ? String(envelope.message) : alarmMessage(job, "gate-failed", { exit: res.status }),
        state: Object.assign(
          { job, provider, reason: "gate-failed", evalTimeoutMs: EVAL_TIMEOUT_MS, at: Date.now(), exit: res.status },
          envelope.state && typeof envelope.state === "object" ? envelope.state : {},
        ),
      });
      process.exit(0);
    }
    degrade(job, "exec-failed", { provider, exit: res.status, stderr: tail(res.stderr) });
  }
  if (!envelope) degrade(job, "parse-failed", { provider, stdout: tail(res.stdout) });

  // 6) normalize to the {fire} envelope (generic JSON conventions, not provider-specific)
  let fire;
  if (typeof envelope.fire === "boolean") fire = envelope.fire;              // canonical
  else if (Array.isArray(envelope.stale)) fire = envelope.stale.length > 0;  // patrol convention
  else if (typeof envelope.ok === "boolean") fire = !envelope.ok;            // health-check convention
  else degrade(job, "no-fire-field", { provider, keys: Object.keys(envelope) });

  const out = { fire };
  if (envelope.message) out.message = String(envelope.message);
  else if (fire && Array.isArray(envelope.stale)) out.message = "[task-patrol] stale in_progress cards: " + JSON.stringify(envelope.stale);
  out.state = Object.assign({ job, provider, evalTimeoutMs: EVAL_TIMEOUT_MS, at: Date.now() }, envelope.state && typeof envelope.state === "object" ? envelope.state : {});
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
