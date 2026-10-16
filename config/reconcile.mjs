#!/usr/bin/env node
// config/reconcile.mjs — declarative reconcile of team automations (add / edit / skip).
//
// install.sh is the DECLARATION SOURCE for the team's scheduled jobs; this module is
// the decision engine that aligns the runtime (`automations list --json`) to that
// declaration. For every declared job it emits one of three actions:
//
//   add   — no job with the declarationKey exists yet       → install.sh registers it
//   edit  — the job exists but drifts (lightContext / interval / trigger body)
//           → `automations edit …`
//   skip  — the job exists and already matches              → nothing to do
//
// Drift rules:
//   - lightContext: every declared job must have payload.lightContext === true.
//   - interval (poll/patrol): the runtime `schedule` must carry the declared interval;
//     drift ⇒ append `--every <interval>`.
//   - cron (team-check-all / skills-update / tmp-gc): only lightContext is reconciled — the
//     cron expression is NEVER rewritten (a `--every` would silently turn a cron into an
//     interval job).
//   - trigger-script body (T-20261010-092547): when a declared job carries
//     `triggerScriptPath`, the live `trigger.script` must byte-match that file's content
//     (trailing-newline tolerant); drift ⇒ append `--trigger-script <triggerScriptPath>`.
//     This is what makes trigger-body drift self-heal on a re-run of install.sh. If the
//     declared path is missing/unreadable the rule is SKIPPED (fail-safe: never emit a
//     `--trigger-script` pointing at a file we could not read).
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
//   { key, name, agent, job: "poll"|"patrol"|"check-all"|"skills-update"|"sla-scan"|"tmp-gc",
//     kind: "interval"|"cron", interval?: "5m", lightContext: true,
//     triggerScriptPath?: "/abs/path/to/expected-trigger.js" }
//
// `editArgs` is word-split by install.sh (`automations edit <id> $editArgs`), so a
// trigger-script edit emits two tokens: `--trigger-script` + the absolute path.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

    // trigger-script body: compare the live inline script to the declared expected file.
    // Unreadable/missing declared file ⇒ skip (fail-safe; never point --trigger-script at
    // a path we could not read — that would let install.sh write an empty/garbage trigger).
    if (d.triggerScriptPath) {
      let want;
      try { want = fs.readFileSync(d.triggerScriptPath, "utf8"); }
      catch { want = null; }
      if (want != null && normalizeScript(triggerScriptOf(existing)) !== normalizeScript(want)) {
        editArgs.push("--trigger-script", d.triggerScriptPath);
        reasons.push("trigger-script drift");
      }
    }

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

/** The live inline condition script (the Gateway stores it at `trigger.script`). */
function triggerScriptOf(j) {
  if (!j) return "";
  const t = j.trigger;
  if (t && typeof t === "object" && typeof t.script === "string") return t.script;
  if (typeof j.triggerScript === "string") return j.triggerScript;
  if (typeof j.trigger_script === "string") return j.trigger_script;
  return "";
}

/**
 * Normalize a trigger body for comparison: CRLF→LF and drop a trailing newline run.
 * `write_trigger` emits a heredoc-style trailing "\n", but the Gateway strips it on
 * round-trip — a strict compare would re-edit the same job on every install (非幂等).
 */
function normalizeScript(s) {
  return String(s ?? "").replace(/\r\n?/g, "\n").trimEnd();
}

/**
 * Normalize a runtime `schedule` into a minute-counted interval string (the same
 * shape the declared jobs use for `interval`), so `intervalMatches` can compare
 * real runtime shapes (`{kind:"every", everyMs:N}`) against `"5m"`/`"15m"`.
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
// main-guard：经 realpath 归一后比较（与 lib.mjs / build-guard 等同口径）——朴素比较在**符号链接调用**
// 下不成立（`import.meta.url` 已解析为真实路径，`argv[1]` 是调用时路径）⇒ 静默 no-op、exit 0。
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
