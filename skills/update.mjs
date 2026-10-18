#!/usr/bin/env node
// Update the declared team skills from their upstream sources — the missing half of
// `fetch.mjs`, which only ever installs at the *pinned* `source.ref`.
//
//   node update.mjs                 # detect only — ZERO writes (default, safe)
//   node update.mjs --apply         # advance refs + rewrite lock + reinstall targets
//   node update.mjs --json          # machine envelope for the framework dispatcher
//   node update.mjs --only a,b      # restrict to the named entries
//
// For every `source.kind === "github"` entry this resolves the upstream's current
// commit with a READ-ONLY git command (`git ls-remote <repo> HEAD`, or
// `refs/heads/<source.track>` when the entry declares a tracked branch) and compares
// it to the pinned `source.ref`. Nothing is written unless `--apply` is passed.
//
// Non-destructive by construction: the only git verbs used here are `ls-remote`,
// `clone`, `fetch` and `checkout` — the last three inside a temp dir this script
// created and later removes. No history-rewriting or worktree-discarding git verb
// appears anywhere in this file, and no repository the script did not create is ever
// touched. Re-running is idempotent: an applied run advances every ref, so the next
// run finds no drift and prints nothing.
//
// `--apply` semantics (per changed entry): advance `manifest.json` `source.ref`, then
// recompute `lock.json` `tree_sha256` from the newly pinned tree and reinstall the
// entry into each of its `targets` (same copy semantics as `fetch.mjs`). The whole
// write face is: skills/manifest.json, skills/lock.json, and the target skill dirs.
//
// Exit codes: 0 = no failure (whether or not drift was found); 1 = at least one entry
// failed to resolve or install. `kind:"unknown"` entries keep the existing
// `needs_source` semantics: skipped, counted as `unresolved`, never a failure.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));   // <repo>/skills
const REPO = dirname(HERE);                             // <repo>

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(n);

const APPLY = flag("--apply");
const JSON_OUT = flag("--json");
const ONLY = new Set((opt("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean));

const OPENCLAW_HOME = opt("--openclaw-home", join(os.homedir(), ".openclaw"));
const CLAUDE_HOME = opt("--claude-home", join(os.homedir(), ".claude"));
const CODEX_HOME = opt("--codex-home", join(os.homedir(), ".codex"));

const MANIFEST_FILE = join(HERE, "manifest.json");
const LOCK_FILE = join(HERE, "lock.json");

function targetDir(t) {
  if (t === "openclaw") return join(OPENCLAW_HOME, "skills");
  if (t === "claude") return join(CLAUDE_HOME, "skills");
  if (t === "codex") return join(CODEX_HOME, "skills");
  if (t.startsWith("agent:")) return join(OPENCLAW_HOME, `workspace-${t.slice(6)}`, "skills");
  throw new Error(`unknown target: ${t}`);
}

/**
 * The remote ref a `git ls-remote` should ask for: the entry's tracked branch when it
 * declares `source.track`, else the remote HEAD. Two entries pointing at the same
 * (repo, spec) share ONE resolution — see `resolveAll`.
 */
export function specOf(source) { return source.track ? `refs/heads/${source.track}` : "HEAD"; }

/** Resolve an entry's current upstream commit with a read-only `git ls-remote`. */
export async function resolveUpstream(source, git = runGit) {
  const spec = specOf(source);
  const out = await git(["ls-remote", source.repo, spec]);
  const rows = String(out || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!rows.length) throw new Error(`ls-remote returned no ref for ${spec}`);
  const exact = rows.find((l) => l.split(/\s+/)[1] === spec);
  const sha = (exact || rows[0]).split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unparseable ls-remote output for ${spec}`);
  return sha;
}

/**
 * `tree_sha256` recipe (skills/PROVENANCE.md): sha256 over the sorted
 * `<sha256>  <repo-relative path>` lines of every file under the pinned path.
 * Paths are relative to the CLONE ROOT (that is what makes the value reproducible
 * from a fresh checkout of the pinned ref), sorted bytewise, LF-terminated.
 */
export function treeSha256(root, subpath) {
  const dir = subpath ? join(root, subpath) : root;
  if (!existsSync(dir)) throw new Error(`path not found in repo: ${subpath || "."}`);
  const rels = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else rels.push(p.slice(root.length + 1));
    }
  })(dir);
  rels.sort();
  const lines = rels.map((rel) => {
    const h = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
    return `${h}  ${rel}`;
  });
  return createHash("sha256").update(lines.join("\n") + "\n").digest("hex");
}

/** Materialize an entry at `ref` into `workdir` (fresh clone; read-only git). */
export function materialize(entry, ref, workdir, git = runGit) {
  const s = entry.source;
  const clone = join(workdir, entry.name);
  rmSync(clone, { recursive: true, force: true });
  git(["clone", "-q", "--depth", "1", s.repo, clone]);
  try { git(["-C", clone, "fetch", "-q", "--depth", "1", "origin", ref]); }
  catch { /* shallow fetch by sha can fail on some servers; the clone may already hold it */ }
  git(["-C", clone, "checkout", "-q", ref]);
  return clone;
}

/** Copy the materialized skill into every declared target (fetch.mjs copyInto semantics). */
export function installInto(srcDir, name, targets, targetDirFn = targetDir) {
  const done = [];
  for (const t of targets) {
    const dst = join(targetDirFn(t), name);
    if (resolve(srcDir) === resolve(dst)) { done.push(t); continue; }
    mkdirSync(dirname(dst), { recursive: true });
    rmSync(dst, { recursive: true, force: true });
    cpSync(srcDir, dst, { recursive: true });
    done.push(t);
  }
  return done;
}

function runGit(argv) {
  return execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const execFileAsync = promisify(execFile);

/** Async/parallel runner used for the DETECT scan (the scheduled, time-bounded path). */
async function runGitAsync(argv) {
  const { stdout } = await execFileAsync("git", argv, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/**
 * Resolve every unique (repo, spec) pair ONCE, in parallel and with bounded concurrency.
 *
 * The manifest declares ~73 github entries but only ~15 distinct upstream repositories, and
 * the scheduled job runs under the dispatcher's trigger-evaluation bound (`install.sh` caps
 * the trigger's `exec({ timeoutSeconds })` at 8 s, and the exec helper backgrounds at 10 s, so
 * that bound cannot simply be widened). Resolving per ENTRY (73 sequential network
 * round-trips) cannot fit it; even per REPO, sequential playback measured ~45 s on this host.
 * The concurrency default therefore issues the whole unique set in ONE wave (measured: 15
 * parallel `ls-remote` ≈ 5 s end-to-end) — a smaller pool puts the tail repos in a second
 * wave and blows the bound. Returns a Map keyed by `repoKey`; a failing repo is recorded as
 * an error value, never a rejection, so one dead upstream cannot fail the whole scan.
 */
export async function resolveAll(sources, git = runGitAsync, concurrency = 16) {
  const unique = new Map();
  for (const s of sources) {
    const key = repoKey(s);
    if (!unique.has(key)) unique.set(key, { source: s, sha: "", error: "" });
  }
  const jobs = [...unique.values()];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try { job.sha = await resolveUpstream(job.source, git); }
      catch (e) { job.error = String((e && e.message) || e); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
  return unique;
}

export function repoKey(source) { return `${source.repo}\u0000${specOf(source)}`; }

function shortSha(sha) { return String(sha || "").slice(0, 12); }

/**
 * Render the change list for the fired `message`. The message is delivered INTO an agent
 * turn, so it is capped: a first upstream bump after a quiet month can move dozens of refs
 * at once and the full list belongs in the report, not in the wake payload (`R-DISC-4`).
 */
function changeList(changes, limit = 8) {
  const shown = changes.slice(0, limit).map((c) => `${c.name} ${shortSha(c.old)}→${shortSha(c.new)}`);
  const more = changes.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` … (+${more} more)` : "");
}

/**
 * Rewrite a JSON file in place, preserving its exact formatting convention: 2-space
 * indent and whatever trailing-newline style the file already used (manifest.json ends
 * with a newline, lock.json does not — a careless write would churn the whole file).
 */
export function writeJsonLike(file, obj, raw) {
  writeFileSync(file, JSON.stringify(obj, null, 2) + (raw.endsWith("\n") ? "\n" : ""));
}

async function main() {
  const manifestRaw = readFileSync(MANIFEST_FILE, "utf8");
  const lockRaw = readFileSync(LOCK_FILE, "utf8");
  const manifest = JSON.parse(manifestRaw);
  const lock = JSON.parse(lockRaw);

  const changes = [];
  const failures = [];
  const unresolvedNames = [];
  let skipped = 0;

  const selected = manifest.skills.filter((e) => !ONLY.size || ONLY.has(e.name));
  for (const entry of selected) {
    const kind = (entry.source || {}).kind;
    if (kind === "unknown") unresolvedNames.push(entry.name);
    else if (kind !== "github") skipped++;   // clawhub / local have no git upstream to resolve
  }
  const unresolved = unresolvedNames.length;

  // One read-only resolution per upstream REPO (not per entry), in parallel — the
  // scheduled run must finish inside the dispatcher's trigger-evaluation bound.
  const github = selected.filter((e) => (e.source || {}).kind === "github");
  const resolved = await resolveAll(github.map((e) => e.source));
  for (const entry of github) {
    const r = resolved.get(repoKey(entry.source));
    if (r && r.error) {
      failures.push({ name: entry.name, error: r.error });
      continue;
    }
    const head = r ? r.sha : "";
    if (head !== entry.source.ref) {
      changes.push({ name: entry.name, old: entry.source.ref, new: head, targets: entry.targets });
    }
  }

  let applied = 0;
  if (APPLY && changes.length) {
    const work = join(os.tmpdir(), `openclaw-team-skills-update-${process.pid}`);
    mkdirSync(work, { recursive: true });
    const appliedNames = new Set();
    try {
      for (const c of changes) {
        const entry = manifest.skills.find((e) => e.name === c.name);
        try {
          const clone = materialize(entry, c.new, work);
          const hash = treeSha256(clone, entry.source.path);
          const lockEntry = lock.skills.find((l) => l.name === c.name);
          const dir = entry.source.path ? join(clone, entry.source.path) : clone;
          const installed = installInto(dir, entry.name, entry.targets);
          entry.source.ref = c.new;
          if (lockEntry) {
            lockEntry.ref = c.new;
            lockEntry.tree_sha256 = [`sha256:${hash}`];
            lockEntry.resolved = true;
          }
          appliedNames.add(c.name);
          applied++;
          c.hash = hash;
          c.installed = installed;
          console.log(`  ✓ ${c.name} ${shortSha(c.old)} → ${shortSha(c.new)}  [${entry.targets.join(", ")}]`);
        } catch (e) {
          failures.push({ name: c.name, error: e.message });
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    // Write back only the entries that actually landed (a failed entry keeps its old ref
    // so the next run retries it rather than silently pinning an unverified tree).
    if (appliedNames.size) {
      writeJsonLike(MANIFEST_FILE, manifest, manifestRaw);
      writeJsonLike(LOCK_FILE, lock, lockRaw);
    }
  }

  const failed = failures.length;
  const summary =
    `skills-update: changed=${changes.length} applied=${applied} ` +
    `unresolved=${unresolved} skipped=${skipped} failed=${failed}`;
  // Reported only alongside something that already needs attention, so a run with no
  // drift stays byte-for-byte silent. The count itself is always in the --json state.
  const unresolvedDetail = () =>
    unresolvedNames.map((n) => `  ! unresolved ${n} (needs_source) — skipped`);

  if (JSON_OUT) {
    const state = {
      job: "skills-update",
      mode: APPLY ? "apply" : "detect",
      changed: changes.map((c) => ({ name: c.name, from: shortSha(c.old), to: shortSha(c.new), targets: c.targets })),
      applied,
      unresolved,
      skipped,
      failed: failures.map((f) => ({ name: f.name, error: f.error })),
      at: Date.now(),
    };
    if (failed) {
      emit({ ok: false, fire: true, message: `[skills-update] ${failed} skill(s) failed: ${failures.map((f) => f.name).join(", ")} — ${summary}`, state });
      process.exit(1);
    }
    if (changes.length && !APPLY) {
      emit({
        fire: true,
        message: `[skills-update] ${changes.length} upstream skill ref(s) moved: ` +
          changeList(changes) +
          ` — review and run \`node skills/update.mjs --apply\` to advance.`,
        state,
      });
      process.exit(0);
    }
    emit({ fire: false, state });
    process.exit(0);
  }

  // Human mode: STRICTLY silent when there is nothing to report. A run that found no
  // drift, no failure and nothing unresolved prints nothing at all and exits 0 — that is
  // the contract the scheduled job depends on (a no-op must not look like a report).
  if (changes.length || failed) {
    if (changes.length && !APPLY) {
      console.log(`skills-update: ${changes.length} upstream ref(s) moved`);
      for (const c of changes) {
        console.log(`  ${c.name}  ${shortSha(c.old)} → ${shortSha(c.new)}  [${c.targets.join(", ")}]`);
      }
    }
    for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
    for (const l of unresolvedDetail()) console.log(l);
    console.log(summary);
  }
  process.exit(failed ? 1 : 0);
}

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

// main-guard：经 realpath 归一后比较，符号链接调用亦能命中（import.meta.url 为真实路径，
// argv[1] 可能是链接路径）。未归一前守卫恒假 ⇒ main() 从不执行、stdout 恒空、exit 0 ——
// 表现成「检测不到漂移」的假绿（本机 macOS 的 /var → /private/var，或把本文件复制进符号
// 链接目录的测试夹具）。与 team/scripts/{lib,patrol-scan}.mjs 同口径，回归见 main-guard.test.mjs。
let IS_MAIN = false;
try {
  IS_MAIN = realpathSync(new URL(import.meta.url)) === realpathSync(resolve(process.argv[1]));
} catch {
  IS_MAIN = false; // realpath 失败 / argv[1] 缺席 ⇒ 不执行 main
}
if (IS_MAIN) {
  main().catch((e) => {
    console.log(`  ✗ skills-update: ${(e && e.message) || e}`);
    process.exit(1);
  });
}
