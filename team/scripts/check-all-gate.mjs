#!/usr/bin/env node
/**
 * check-all-gate.mjs — the SCHEDULED entry of the `team-check-all` HEALTH GATE
 * (T-20261013-031036).
 *
 * Why this exists
 * ---------------
 * The full gate (`check-all.sh`, PROTOCOL §20.1) is ~15-20 s; the dispatcher bounds the
 * trigger evaluation at OPENCLAW_TEAM_EVAL_TIMEOUT_MS (default 8000 ms, entry bound
 * 7500 ms). The evaluation therefore ended in `eval-timeout` EVERY hour, which under the
 * gate fail-safe (T-20261010-190039) meant `fire:true` every hour — and, worse, the timeout
 * envelope carried no verdict at all, so a genuinely red gate was MASKED until somebody ran
 * check-all by hand. Raising the bound is not available: the exec helper's 10 s `yieldMs`
 * cap sits below the gate's wall clock (team/AUTOMATIONS.md §3.5), so the cost cannot be
 * escaped by widening the budget.
 *
 * What this does instead (coverage-neutral; no bound change)
 * ---------------------------------------------------------
 * `check-all.sh` is now segmented: `--segment fast` runs every check except the one slow
 * step (the full `node --test scripts/tests/*.test.mjs` suite, ~1.6 s vs ~17 s), and
 * `--segment slow` runs exactly that step. This entry:
 *
 *   1. runs the FAST segment in-band (bounded, seconds) and takes its verdict — so a red
 *      FAST check is reported INSIDE the evaluation budget, `fire:true`, with the failing
 *      steps in `message` (the masking problem, fixed);
 *   2. folds in the SLOW segment's most recent verdict from a cache file
 *      (`<team>/.check-all-slow.json`), which the same entry refreshes OUT OF BAND: it
 *      launches `check-all.sh --segment slow --report <cache>` detached and exits. The
 *      whole suite therefore still runs every cron period — coverage is unchanged — it just
 *      lands in the NEXT evaluation's budget instead of blowing this one;
 *   3. FAILS CLOSED on the slow axis: a missing / stale / unreadable cached verdict is
 *      UNCONFIRMED, never green (the §3.5 rule that "unknown ≠ green"). A lost refresh
 *      degrades to an alarm, never to a silent pass.
 *
 * Residual (deliberate, documented): the slow verdict is up to one cron period old, so a
 * regression that only the slow suite catches is reported within one period rather than
 * instantly. The freshness bound itself tolerates ONE missed period (a host that sleeps across
 * a cron hour skips that evaluation, and with it that period's refresh) — see
 * `DEFAULT_SLOW_TTL_MS`. That is strictly better than the previous behaviour (never confirmed),
 * and it is the only shape that fits a <10 s evaluation without dropping coverage.
 *
 * Usage:  node check-all-gate.mjs          → last stdout line is the {"ok":…} envelope
 * Overrides (ops/tests — all default to the deployed layout):
 *   OPENCLAW_TEAM_ROOT                     team dir (default: this file's parent)
 *   OPENCLAW_TEAM_CHECKALL_SH              path to check-all.sh
 *   OPENCLAW_TEAM_CHECKALL_CACHE           slow-verdict cache file
 *   OPENCLAW_TEAM_CHECKALL_LOCK            refresh lock file
 *   OPENCLAW_TEAM_CHECKALL_LOG             detached refresh log
 *   OPENCLAW_TEAM_CHECKALL_SLOW_TTL_MS     max accepted cache age (default 150 min; see below)
 *   OPENCLAW_TEAM_CHECKALL_FAST_TIMEOUT_MS fast-segment wall-clock bound (default 6000 ms)
 *   OPENCLAW_TEAM_CHECKALL_LOCK_MAX_MS     refresh treated as in-flight up to this age
 *   OPENCLAW_TEAM_CHECKALL_NO_REFRESH=1    do not launch the detached slow refresh
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <TEAM_DIR>/scripts

/** Accepted cache age by default — the slow axis' freshness bound (T-20261015-005519).
 *
 *  The cache is refilled by ONE detached refresh per hourly cron period (P = 60 min), so the
 *  age a healthy evaluation reads is ~1P; ONE missed evaluation makes it ~2P, TWO make it ~3P.
 *  For the bound to mean what it says — "a single missed refresh is tolerated, a second one
 *  alarms" — it must sit strictly BETWEEN 2P and 3P. 90 min (1.5P) sat below 2P, so the FIRST
 *  missed period already read as stale: any host that sleeps across a cron hour (a sleeping
 *  laptop skips the evaluation, and with it that period's refresh) produced a fail-closed false
 *  alarm on the next wake — the reported defect, where a 1 h 47 m old cache was called stale.
 *  150 min = 2.5P is the midpoint of (2P, 3P): ~30 min of margin over a single missed period,
 *  and a second consecutive miss (≥3P) still alarms. Note the bound is deliberately NOT wider
 *  than 3P: that would tolerate two missed refreshes and read green on a genuinely lost one. */
export const DEFAULT_SLOW_TTL_MS = 150 * 60 * 1000;
/** In-band bound for the fast segment. The dispatcher gives the entry the 8000 ms budget
 *  minus its 500 ms emission reserve (7500 ms); the fast segment measures ~1.6 s, so 6000 ms
 *  is a wide margin that still leaves room to print. */
export const DEFAULT_FAST_TIMEOUT_MS = 6000;
/** A refresh older than this is treated as dead even if its pid still exists. */
export const DEFAULT_LOCK_MAX_MS = 20 * 60 * 1000;

function num(v, dflt) {
  const n = Number(String(v == null ? "" : v).trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** Resolve the team dir: $OPENCLAW_TEAM_ROOT, else this file's parent (the deployed layout). */
export function resolveTeamDir(env = process.env) {
  const fromEnv = String(env.OPENCLAW_TEAM_ROOT || "").trim();
  if (fromEnv) return fromEnv;
  return path.resolve(HERE, "..");
}

/**
 * Read the cached slow-suite verdict and classify its freshness.
 * @returns {{status:'fresh'|'stale'|'missing'|'unparseable', ok:boolean, failed:string[],
 *            message:string, at:number, ageMs:number}}
 */
export function readSlowCache(file, nowMs, ttlMs) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch { return { status: "missing", ok: false, failed: [], failedFiles: [], message: "", at: 0, ageMs: Infinity }; }
  let j;
  try { j = JSON.parse(raw); }
  catch { return { status: "unparseable", ok: false, failed: [], failedFiles: [], message: "", at: 0, ageMs: Infinity }; }
  if (!j || typeof j !== "object") return { status: "unparseable", ok: false, failed: [], failedFiles: [], message: "", at: 0, ageMs: Infinity };
  const at = Number(j.at) || Date.parse(String(j.checkedAt || "")) || 0;
  if (!at) return { status: "unparseable", ok: false, failed: [], failedFiles: [], message: "", at: 0, ageMs: Infinity };
  const ageMs = nowMs - at;
  // A small negative age is clock skew between writer and reader, not staleness.
  const status = ageMs <= ttlMs && ageMs >= -60_000 ? "fresh" : "stale";
  // `slowFailedFiles` (check-all.sh --segment slow) names the failing test files; `failed` is
  // the fallback (step labels). Prefer the files — that is what an operator acts on.
  const files = Array.isArray(j.slowFailedFiles) ? j.slowFailedFiles.map(String) : [];
  const steps = Array.isArray(j.failed) ? j.failed.map(String) : [];
  return { status, ok: j.ok === true, failed: steps, failedFiles: files, message: String(j.message || ""), at, ageMs };
}

/** Human-facing age for the alarm message. */
export function fmtAge(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 60_000) return "<1m";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/**
 * Combine the in-band fast verdict with the cached slow verdict into the gate's verdict.
 * Fail-closed on the slow axis: anything but a FRESH cached verdict is unconfirmed ⇒ red.
 * @returns {{ok:boolean, message?:string}}
 */
export function computeVerdict(fast, slow) {
  const parts = [];
  if (!fast.ok) {
    parts.push(fast.unconfirmed
      ? `fast segment UNCONFIRMED (${fast.reason})`
      : `fast RED: ${fast.failed && fast.failed.length ? fast.failed.join(", ") : "see stdout"}`);
  }
  if (slow.status === "fresh") {
    if (!slow.ok) {
      const named = slow.failedFiles && slow.failedFiles.length ? slow.failedFiles : slow.failed;
      parts.push(`slow suite RED (${fmtAge(slow.ageMs)} ago): ${named && named.length ? named.join(", ") : "see .check-all-slow.json"}`);
    }
  } else if (slow.status === "missing") {
    parts.push("slow suite UNCONFIRMED: no cached verdict yet (first run since deploy — the refresh just started)");
  } else if (slow.status === "unparseable") {
    parts.push("slow suite UNCONFIRMED: cached verdict is unreadable");
  } else {
    parts.push(`slow suite UNCONFIRMED: cached verdict is ${fmtAge(slow.ageMs)} old (refresh did not land)`);
  }
  if (!parts.length) return { ok: true };
  return { ok: false, message: `check-all gate RED — ${parts.join("; ")} — run \`bash scripts/check-all.sh\` and handle per PROTOCOL §20.` };
}

/** Parse the gate's {ok:…} envelope from the last non-empty stdout line. */
function parseEnvelope(stdout) {
  const lines = String(stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  try { const r = JSON.parse(lines[lines.length - 1]); return r && typeof r === "object" && !Array.isArray(r) ? r : null; }
  catch { return null; }
}

/** Run the fast segment in-band under a wall-clock bound. Never throws. */
export function runFast(checkall, timeoutMs, env = process.env) {
  let res;
  try {
    res = spawnSync("bash", [checkall, "--segment", "fast"], { encoding: "utf8", timeout: timeoutMs, env });
  } catch (e) {
    return { ok: false, unconfirmed: true, reason: "spawn-error", failed: [] };
  }
  if (res.error) {
    const code = String(res.error.code || "");
    return { ok: false, unconfirmed: true, reason: code === "ETIMEDOUT" ? "fast-timeout" : "spawn-error", failed: [] };
  }
  const envelope = parseEnvelope(res.stdout);
  if (!envelope) return { ok: false, unconfirmed: true, reason: "fast-unparseable", failed: [] };
  // An unexplained non-zero exit is not a verdict on its own (mirrors dispatch.mjs's gate rule).
  if (envelope.ok === true && res.status !== 0) return { ok: false, unconfirmed: true, reason: "fast-nonzero-exit", failed: [] };
  return { ok: envelope.ok === true, unconfirmed: false, failed: Array.isArray(envelope.failed) ? envelope.failed.map(String) : [], exit: res.status };
}

/** Is the recorded detached refresh still plausibly running? */
export function isLockLive(lock, nowMs, lockMaxMs) {
  if (!lock || typeof lock !== "object") return false;
  const pid = Number(lock.pid);
  const startedAt = Number(lock.startedAt);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (!Number.isFinite(startedAt) || nowMs - startedAt > lockMaxMs) return false; // too old ⇒ treat as dead
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * Launch the slow segment DETACHED so it outlives this evaluation and writes the cache for
 * the next one. Returns a status string for the envelope's state. Never throws.
 */
export function maybeRefresh({ checkall, cacheFile, lockFile, logFile, nowMs, lockMaxMs, env }) {
  if (String(env.OPENCLAW_TEAM_CHECKALL_NO_REFRESH || "") === "1") return "disabled";
  if (isLockLive(readLock(lockFile), nowMs, lockMaxMs)) return "in-flight";
  let fd;
  try { fd = fs.openSync(logFile, "a"); } catch { return "log-open-failed"; }
  try {
    const child = spawn("bash", [checkall, "--segment", "slow", "--report", cacheFile], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
    });
    child.unref();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: child.pid, startedAt: Date.now(), report: cacheFile }) + "\n");
    return "launched";
  } catch {
    return "spawn-failed";
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const team = resolveTeamDir(env);
  const checkall = env.OPENCLAW_TEAM_CHECKALL_SH || path.join(team, "scripts", "check-all.sh");
  const cacheFile = env.OPENCLAW_TEAM_CHECKALL_CACHE || path.join(team, ".check-all-slow.json");
  const lockFile = env.OPENCLAW_TEAM_CHECKALL_LOCK || path.join(team, ".check-all-slow.lock");
  const logFile = env.OPENCLAW_TEAM_CHECKALL_LOG || path.join(team, ".check-all-slow.log");
  const ttlMs = num(env.OPENCLAW_TEAM_CHECKALL_SLOW_TTL_MS, DEFAULT_SLOW_TTL_MS);
  const fastTimeoutMs = num(env.OPENCLAW_TEAM_CHECKALL_FAST_TIMEOUT_MS, DEFAULT_FAST_TIMEOUT_MS);
  const lockMaxMs = num(env.OPENCLAW_TEAM_CHECKALL_LOCK_MAX_MS, DEFAULT_LOCK_MAX_MS);

  // Pin the team dir for the spawned segments: check-all.sh would otherwise fall back to
  // $HOME/.openclaw/team, which need not be this file's deploy root (e.g. a Gateway whose HOME
  // differs). The gate resolved the root from its own location, so pass it down explicitly.
  const childEnv = { ...env, OPENCLAW_TEAM_ROOT: team };

  const fast = runFast(checkall, fastTimeoutMs, childEnv);
  const slow = readSlowCache(cacheFile, Date.now(), ttlMs);
  const verdict = computeVerdict(fast, slow);
  const refresh = maybeRefresh({ checkall, cacheFile, lockFile, logFile, nowMs: Date.now(), lockMaxMs, env: childEnv });

  const out = { ok: verdict.ok };
  if (verdict.message) out.message = verdict.message;
  out.state = {
    job: "check-all",
    segment: "gate",
    fast: { ok: fast.ok, unconfirmed: !!fast.unconfirmed, reason: fast.reason, failed: fast.failed },
    slow: { status: slow.status, ok: slow.ok, ageMs: Number.isFinite(slow.ageMs) ? slow.ageMs : null, failed: slow.failed, failedFiles: slow.failedFiles || [] },
    slowRefresh: refresh,
    at: Date.now(),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  return verdict.ok ? 0 : 1;
}

// Run only when invoked as a CLI — importing this module (unit tests) must stay side-effect free.
// Guard 以 **realpath 归一后**比较（与 lib.mjs / build-guard / check-card 等 23 个脚本同口径）：
// `import.meta.url` 是解析后的真实路径，`process.argv[1]` 是**调用时**路径；符号链接调用
// （macOS `/tmp -> private/tmp`、`os.tmpdir()` 在 `/var` 之下同理）时二者不等 ⇒ 朴素比较会让本脚本
// **静默 no-op、exit 0**。对这道 fail-closed 的门而言，「什么都没做」与「判定为绿」在触发层看来一模一样。
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) process.exit(main());
} catch { /* realpath 失败 ⇒ 不执行 main */ }
