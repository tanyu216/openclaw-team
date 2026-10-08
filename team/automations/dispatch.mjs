#!/usr/bin/env node
// openclaw-team — provider-agnostic automation dispatcher (framework-owned).
//
// The framework owns *scheduling*; a task provider (task-panel by default) is
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
//   provider   = $OPENCLAW_TEAM_TASK_PROVIDER              (default: task-panel)
//   entry cmd  = providers.json[provider][<job key>], overridable per job with:
//                  poll      -> $OPENCLAW_TEAM_POLL_CMD
//                  patrol    -> $OPENCLAW_TEAM_PATROL_CMD
//                  check-all -> $OPENCLAW_TEAM_CHECKALL_CMD
//
// Placeholders: {team} -> the deployed team dir (~/.openclaw/team, resolved from
// this file's location); {agent} -> the agent argument.
//
// Degrade-without-burning: a missing/invalid provider config, an unrunnable entry,
// a non-zero exit, or an unparseable result prints {"fire":false, "state":{...}}
// and exits 0 — it never throws and never wakes a model on its own.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <TEAM_DIR>/automations
const TEAM_DIR = path.resolve(HERE, "..");                 // <TEAM_DIR>
const PROVIDERS_FILE = path.join(HERE, "providers.json");

// job -> providers.json key, and -> env override var
const JOB_KEY = { poll: "poll", patrol: "patrol", "check-all": "checkAll" };
const JOB_ENV = {
  poll: "OPENCLAW_TEAM_POLL_CMD",
  patrol: "OPENCLAW_TEAM_PATROL_CMD",
  "check-all": "OPENCLAW_TEAM_CHECKALL_CMD",
};

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function degrade(job, reason, extra) {
  emit({ fire: false, state: Object.assign({ job: job || "", reason, at: Date.now() }, extra || {}) });
  process.exit(0);
}

const job = process.argv[2] || "";
const agent = process.argv[3] || "";
if (!JOB_KEY[job]) degrade(job, "unknown-job", { usage: "dispatch.mjs <poll|patrol|check-all> [agent]" });

const provider = process.env.OPENCLAW_TEAM_TASK_PROVIDER || "task-panel";

// 1) entry command: env override first, else providers.json
let template = String(process.env[JOB_ENV[job]] || "").trim();
if (!template) {
  let providers;
  try { providers = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8")); }
  catch (e) { degrade(job, "providers.json-missing-or-invalid", { provider }); }
  const p = providers[provider];
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

// 4) run
const res = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 25000 });
if (res.error) degrade(job, "spawn-error", { provider, detail: String(res.error.message || res.error) });
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
out.state = Object.assign({ job, provider, at: Date.now() }, r.state && typeof r.state === "object" ? r.state : {});
emit(out);
process.exit(0);

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
