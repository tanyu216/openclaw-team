#!/usr/bin/env node
// config/reconcile.mjs — declarative reconcile of team automations (add / edit / skip).
//
// install.sh is the DECLARATION SOURCE for the team's scheduled jobs; this module is
// the decision engine that aligns the runtime (`automations list --json`) to that
// declaration. For every declared job it emits one of three actions:
//
//   add   — no job with the declarationKey exists yet       → install.sh registers it
//   edit  — the job exists but drifts (lightContext / interval) → `automations edit …`
//   skip  — the job exists and already matches              → nothing to do
//
// Drift rules:
//   - lightContext: every declared job must have payload.lightContext === true.
//   - interval (poll/patrol): the runtime `schedule` must carry the declared interval;
//     drift ⇒ append `--every <interval>`.
//   - cron (team-check-all): only lightContext is reconciled — the cron expression is
//     NEVER rewritten (a `--every` would silently turn a cron into an interval job).
//
// CLI contract (used by install.sh §6):
//   printf '%s' "$AUTOMATIONS_JSON" | node config/reconcile.mjs <declared-jobs.json>
//     stdin  = the raw `openclaw automations list --json` output ({jobs:[…]} or […])
//     argv[1]= a JSON file holding the declared jobs (see declared job shape below)
//     stdout = pipe-delimited, one action per line (pipe, NOT tab — bash `read`
//       collapses runs of whitespace IFS, which would drop empty agent/job columns):
//       <action>|<key>|<name>|<agent>|<job>|<id>|<editArgs space-joined>
//
// Declared job shape:
//   { key, name, agent, job: "poll"|"patrol"|"check-all",
//     kind: "interval"|"cron", interval?: "2m", lightContext: true }

import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Align `list` (automations list output) to `declaredJobs`.
 * @param {object|array} list  {jobs:[…]} | {items:[…]} | […]
 * @param {object[]} declaredJobs
 * @returns {{action:"add"|"edit"|"skip", key:string, name:string, agent?:string,
 *            job?:string, id?:string, editArgs?:string[], reasons?:string[]}[]}
 */
export function reconcileAutomations(list, declaredJobs) {
  const jobs = normalizeJobs(list);
  const actions = [];
  for (const d of declaredJobs || []) {
    const existing = jobs.find((j) => keyOf(j) === d.key);
    if (!existing) {
      actions.push({ action: "add", key: d.key, name: d.name, agent: d.agent, job: d.job });
      continue;
    }

    const id = idOf(existing);
    const editArgs = [];
    const reasons = [];

    if (lightContextOf(existing) !== true) {
      editArgs.push("--light-context");
      reasons.push("lightContext missing");
    }
    if (d.kind === "interval" && d.interval && !intervalMatches(scheduleOf(existing), d.interval)) {
      editArgs.push("--every", d.interval);
      reasons.push(`interval drift (want ${d.interval})`);
    }
    // cron jobs: never append --every — the cron expression is left untouched.

    if (editArgs.length) {
      actions.push({ action: "edit", key: d.key, name: d.name, id, editArgs, reasons });
    } else {
      actions.push({ action: "skip", key: d.key, name: d.name, id });
    }
  }
  return actions;
}

/** Read declared jobs from argv[1], automations list JSON from stdin, print TSV actions. */
export function main(argvIn = process.argv.slice(2), env = process.env) {
  const declaredFile = argvIn[0];
  let declared = [];
  if (declaredFile && declaredFile !== "-") {
    try { declared = JSON.parse(fs.readFileSync(declaredFile, "utf8")); }
    catch (e) { declared = []; }
  }

  let list = [];
  if (!process.stdin.isTTY) {
    const raw = fs.readFileSync(0, "utf8");
    try { list = JSON.parse(raw || "[]"); } catch (e) { list = []; }
  }

  for (const a of reconcileAutomations(list, declared)) {
    const editArgs = (a.editArgs || []).join(" ");
    // Pipe-delimited (NOT tab): `read` collapses runs of whitespace IFS, which would
    // drop the empty agent/job columns on edit/skip lines and misalign every field.
    process.stdout.write(
      [a.action, a.key, a.name, a.agent || "", a.job || "", a.id || "", editArgs].join("|") + "\n"
    );
  }
}

function normalizeJobs(list) {
  if (Array.isArray(list)) return list;
  if (list && Array.isArray(list.jobs)) return list.jobs;
  if (list && Array.isArray(list.items)) return list.items;
  return [];
}
function keyOf(j) { return String((j && (j.declarationKey ?? j.declaration_key)) ?? ""); }
function idOf(j) { return String((j && (j.id ?? j.jobId ?? j.job_id ?? j.name)) ?? ""); }
function lightContextOf(j) {
  if (!j) return undefined;
  if (j.payload && typeof j.payload === "object" && "lightContext" in j.payload) return j.payload.lightContext;
  return j.lightContext;
}
function scheduleOf(j) {
  if (!j) return "";
  return j.schedule ?? "";
}

/**
 * Normalize a runtime `schedule` into a minute-counted interval string (the same
 * shape the declared jobs use for `interval`), so `intervalMatches` can compare
 * real runtime shapes (`{kind:"every", everyMs:N}`) against `"2m"`/`"5m"`.
 *
 *   - {kind:"every", everyMs:N} → "Nm" (whole minutes), "Ns" (whole seconds) or "Nms"
 *   - {kind:"cron", expr:…}     → "" (a cron never maps to an interval; --every is only
 *     ever emitted for interval-kind declared jobs)
 *   - string                    → the string with any "every" prefix stripped + trimmed
 *   - {value|expression|interval} → legacy tolerant object shapes (unchanged)
 */
function scheduleToInterval(schedule) {
  if (schedule == null) return "";
  if (typeof schedule === "string") return stripEvery(schedule);
  if (typeof schedule === "object") {
    if (schedule.kind === "every" && typeof schedule.everyMs === "number") {
      return everyMsToInterval(schedule.everyMs);
    }
    if (schedule.kind === "cron") return "";
    const legacy = schedule.value ?? schedule.expression ?? schedule.interval;
    if (legacy != null) return stripEvery(String(legacy));
  }
  return "";
}
function stripEvery(v) {
  return String(v).replace(/\bevery\b/gi, "").trim();
}
function everyMsToInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
function intervalMatches(schedule, interval) {
  const s = scheduleToInterval(schedule).trim();
  if (!s) return false;
  return s === stripEvery(interval);
}

// Run only when invoked as a CLI — importing this module (unit tests) stays side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
