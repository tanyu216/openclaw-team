#!/usr/bin/env node
/**
 * update.test.mjs — skills/update.mjs (T-20261013-025818).
 *
 * Covers the acceptance clauses for the update path:
 *   ③ default is detect-only AND zero-write; no drift ⇒ silent + exit 0
 *   ① an advanced upstream ref is detected via a read-only git command
 *   ② --apply advances manifest.ref, recomputes lock.tree_sha256, reinstalls targets
 *   ④ non-destructive + idempotent (only ls-remote/clone/fetch/checkout are ever run)
 *   ⑤ per-entry failure ⇒ non-zero exit; kind:"unknown" ⇒ unresolved, not a failure
 *
 * Hermetic: every fixture builds its own LOCAL git repository and points the manifest
 * at it with a `file://` URL, so no test touches the network or the real ~/.claude.
 * The CLI is exercised as a real subprocess against a COPIED skills/ dir (update.mjs
 * resolves manifest.json/lock.json relative to its own location), so exit codes and
 * stdout silence are asserted exactly as the weekly Gateway job would see them.
 *
 * Run: node --test test/skills/update.test.mjs
 */
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { treeSha256 } from "../../skills/update.mjs";

// git 是本套件的硬依赖：每个夹具都用**真实 git** 建本地上游仓库（file:// URL）。
// 无 git 时整体 SKIP 而非硬红 —— 与其它套件缺 provider 时的自跳过同口径
// （docker/Dockerfile 基于 node:*-slim，镜像里本来就没有 git；那是既有状态，不是本套件的问题，
// 而且它会让 verify-in-container.sh 在 `set -e` 下**提前退出**，后续步骤一步都跑不到）。
const HAS_GIT = (() => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const SKIP = HAS_GIT ? false : "git is not installed — this suite builds its fixtures with real git";
const test = SKIP ? nodeTest.skip : nodeTest;

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/test/skills
const REPO = path.resolve(HERE, "..", "..");               // <repo>
const UPDATE_SRC = path.join(REPO, "skills", "update.mjs");

const scratch = [];
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });

function scratchDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `oc-skills-${tag}-`));
  scratch.push(d);
  return d;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(cwd, argv) {
  return execFileSync("git", argv, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

/** Create (or advance) a local upstream repo; returns its commit sha. */
function commit(repoDir, files, message = "c") {
  fs.mkdirSync(repoDir, { recursive: true });
  if (!fs.existsSync(path.join(repoDir, ".git"))) git(repoDir, ["init", "-q"]);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", message, "--allow-empty"]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

function fileUrl(p) { return `file://${p}`; }

/**
 * Build a throwaway "repo" whose skills/ dir carries a manifest, a lock and a copy of
 * update.mjs, plus an upstream git repo each declared skill points at.
 * `spec` = [{ name, targets, repoDir, ref, path?, kind? }]
 */
function fixture(tag, specs) {
  const root = scratchDir(tag);
  const skills = path.join(root, "skills");
  fs.mkdirSync(skills, { recursive: true });
  fs.copyFileSync(UPDATE_SRC, path.join(skills, "update.mjs"));

  const manifest = { $schema: "openclaw-team/skills-manifest@1", skills: [] };
  const lock = { $schema: "openclaw-team/skills-lock@1", skills: [] };
  for (const s of specs) {
    const source = s.kind === "unknown"
      ? { kind: "unknown" }
      : { kind: "github", repo: fileUrl(s.repoDir), ref: s.ref, path: s.path ?? "." };
    manifest.skills.push({ name: s.name, targets: s.targets, source });
    lock.skills.push({ name: s.name, targets: s.targets, ref: s.ref, repo: source.repo, tree_sha256: [], resolved: true });
  }
  fs.writeFileSync(path.join(skills, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(skills, "lock.json"), JSON.stringify(lock, null, 2));

  const homes = {
    openclaw: path.join(root, "home", ".openclaw"),
    claude: path.join(root, "home", ".claude"),
    codex: path.join(root, "home", ".codex"),
  };
  return {
    root, skills, homes,
    manifestPath: path.join(skills, "manifest.json"),
    lockPath: path.join(skills, "lock.json"),
    manifest: () => JSON.parse(fs.readFileSync(path.join(skills, "manifest.json"), "utf8")),
    lock: () => JSON.parse(fs.readFileSync(path.join(skills, "lock.json"), "utf8")),
    run: (args) => spawnSync(process.execPath, [path.join(skills, "update.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: path.join(root, "home") },
    }),
    runArgs: ["--openclaw-home", homes.openclaw, "--claude-home", homes.claude, "--codex-home", homes.codex],
  };
}

// ---------------------------------------------------------------------------
// ①③ detect-only: drift reported, nothing written
// ---------------------------------------------------------------------------
test("detect: an advanced upstream ref is reported, and the run writes NOTHING", () => {
  const upstream = scratchDir("up-detect");
  const r1 = commit(upstream, { "SKILL.md": "v1\n" });
  const f = fixture("detect", [{ name: "demo", targets: ["claude"], repoDir: upstream, ref: r1 }]);
  const beforeManifest = fs.readFileSync(f.manifestPath, "utf8");
  const beforeLock = fs.readFileSync(f.lockPath, "utf8");
  commit(upstream, { "SKILL.md": "v2\n" });          // upstream moves on

  const r = f.run(f.runArgs);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skills-update: 1 upstream ref\(s\) moved/);
  assert.match(r.stdout, /demo/);
  assert.match(r.stdout, new RegExp(r1.slice(0, 12)));
  assert.match(r.stdout, /\[claude\]/, "the change list must name the targets");
  assert.match(r.stdout, /changed=1 applied=0 .*failed=0/);

  assert.equal(fs.readFileSync(f.manifestPath, "utf8"), beforeManifest, "manifest must not be written without --apply");
  assert.equal(fs.readFileSync(f.lockPath, "utf8"), beforeLock, "lock must not be written without --apply");
  assert.ok(!fs.existsSync(path.join(f.homes.claude, "skills", "demo")), "no target dir may be created without --apply");
});

// ---------------------------------------------------------------------------
// ③ no drift ⇒ silent, exit 0
// ---------------------------------------------------------------------------
test("no drift ⇒ completely silent, exit 0 (this is the zero-cost idle path)", () => {
  const upstream = scratchDir("up-idle");
  const head = commit(upstream, { "SKILL.md": "steady\n" });
  const f = fixture("idle", [{ name: "demo", targets: ["claude"], repoDir: upstream, ref: head }]);

  const r = f.run(f.runArgs);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "", "a drift-free run must print nothing");
});

// ---------------------------------------------------------------------------
// ② --apply: manifest ref + lock tree_sha256 + targets, then idempotent
// ---------------------------------------------------------------------------
test("--apply advances ref, recomputes tree_sha256 and installs into every target", () => {
  const upstream = scratchDir("up-apply");
  const r1 = commit(upstream, { "SKILL.md": "v1\n", "refs/a.md": "a\n" });
  const f = fixture("apply", [
    { name: "demo", targets: ["claude", "agent:linus"], repoDir: upstream, ref: r1, path: "skills/demo" },
  ]);
  // the fixture's declared path must exist upstream: re-commit with it in place
  const r2 = commit(upstream, { "skills/demo/SKILL.md": "v2\n", "skills/demo/refs/a.md": "a2\n" });

  const r = f.run([...f.runArgs, "--apply"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /changed=1 applied=1/);

  const m = f.manifest().skills[0];
  assert.equal(m.source.ref, r2, "manifest.source.ref must advance to the new upstream commit");

  const l = f.lock().skills[0];
  assert.equal(l.ref, r2, "lock.ref must advance too");
  assert.equal(l.resolved, true);
  assert.equal(l.tree_sha256.length, 1);
  assert.match(l.tree_sha256[0], /^sha256:[0-9a-f]{64}$/);

  // independent recomputation over a fresh clone of the newly pinned commit
  const verify = scratchDir("verify");
  git(verify, ["clone", "-q", fileUrl(upstream), "c"]);
  const expected = treeSha256(path.join(verify, "c"), "skills/demo");
  assert.equal(l.tree_sha256[0], `sha256:${expected}`, "tree_sha256 must match a fresh recomputation");

  const installed = fs.readFileSync(path.join(f.homes.claude, "skills", "demo", "SKILL.md"), "utf8");
  assert.equal(installed, "v2\n", "the claude target must hold the new body");
  const installedAgent = fs.readFileSync(path.join(f.homes.openclaw, "workspace-linus", "skills", "demo", "SKILL.md"), "utf8");
  assert.equal(installedAgent, "v2\n", "the agent:linus target must hold the new body");
});

test("--apply is idempotent: the second run is a silent no-op", () => {
  const upstream = scratchDir("up-idem");
  const r1 = commit(upstream, { "SKILL.md": "v1\n" });
  const f = fixture("idem", [{ name: "demo", targets: ["claude"], repoDir: upstream, ref: r1 }]);
  commit(upstream, { "SKILL.md": "v2\n" });

  assert.equal(f.run([...f.runArgs, "--apply"]).status, 0);
  const afterApply = fs.readFileSync(f.manifestPath, "utf8");
  const lockAfter = fs.readFileSync(f.lockPath, "utf8");

  const again = f.run([...f.runArgs, "--apply"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, "", "an already-advanced ref must produce no drift and no output");
  assert.equal(fs.readFileSync(f.manifestPath, "utf8"), afterApply, "a no-op apply must not rewrite the manifest");
  assert.equal(fs.readFileSync(f.lockPath, "utf8"), lockAfter, "a no-op apply must not rewrite the lock");
});

// ---------------------------------------------------------------------------
// ⑤ failures: per-entry, non-zero exit
// ---------------------------------------------------------------------------
test("an unresolvable entry is recorded per-entry and the process exits non-zero", () => {
  const upstream = scratchDir("up-fail");
  const head = commit(upstream, { "SKILL.md": "ok\n" });
  const f = fixture("fail", [
    { name: "good", targets: ["claude"], repoDir: upstream, ref: head },
    { name: "bad", targets: ["claude"], repoDir: path.join(scratchDir("gone"), "nope"), ref: "0".repeat(40) },
  ]);

  const r = f.run(f.runArgs);
  assert.equal(r.status, 1, "a failed entry must end the process with a non-zero code");
  assert.match(r.stdout, /✗ bad:/, "the failing entry must be named");
  assert.match(r.stdout, /changed=0 applied=0 .*failed=1/);
});

test("kind:\"unknown\" keeps needs_source semantics: unresolved, never a failure", () => {
  const f = fixture("unknown", [{ name: "mystery", targets: ["claude"], kind: "unknown" }]);
  // An unresolved source is not drift, so the run stays silent (③) — the count is carried
  // in the machine envelope instead, where the scheduler reads it.
  const human = f.run(f.runArgs);
  assert.equal(human.status, 0, "an unresolved source must not be an error");
  assert.equal(human.stdout, "", "an unresolved-only run reports nothing in human mode");

  const json = f.run([...f.runArgs, "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const env = JSON.parse(json.stdout.trim().split("\n").pop());
  assert.equal(env.fire, false);
  assert.equal(env.state.unresolved, 1);
  assert.deepEqual(env.state.failed, []);
});

test("the unresolved count is surfaced once something else already needs attention", () => {
  const upstream = scratchDir("up-mixed");
  const r1 = commit(upstream, { "SKILL.md": "v1\n" });
  const f = fixture("mixed", [
    { name: "mystery", targets: ["claude"], kind: "unknown" },
    { name: "demo", targets: ["claude"], repoDir: upstream, ref: r1 },
  ]);
  commit(upstream, { "SKILL.md": "v2\n" });

  const r = f.run(f.runArgs);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unresolved mystery \(needs_source\)/);
  assert.match(r.stdout, /unresolved=1/);
});

// ---------------------------------------------------------------------------
// ⑥ dispatcher contract: fire semantics in --json mode
// ---------------------------------------------------------------------------
test("--json: drift ⇒ fire:true carrying the change list; no drift ⇒ fire:false", () => {
  const upstream = scratchDir("up-json");
  const r1 = commit(upstream, { "SKILL.md": "v1\n" });
  const f = fixture("json", [{ name: "demo", targets: ["claude"], repoDir: upstream, ref: r1 }]);

  const quiet = JSON.parse(f.run([...f.runArgs, "--json"]).stdout.trim());
  assert.equal(quiet.fire, false, "no drift must not wake the model");

  commit(upstream, { "SKILL.md": "v2\n" });
  const loud = JSON.parse(f.run([...f.runArgs, "--json"]).stdout.trim());
  assert.equal(loud.fire, true, "drift must fire");
  assert.match(loud.message, /\[skills-update\] 1 upstream skill ref\(s\) moved/);
  assert.match(loud.message, /demo/);
  assert.equal(loud.state.job, "skills-update");
  assert.equal(loud.state.mode, "detect");
  assert.equal(loud.state.changed[0].targets[0], "claude");
});

test("--json: a failure emits an {ok:false,fire:true} envelope the dispatcher can recover, exit 1", () => {
  const f = fixture("jsonfail", [
    { name: "bad", targets: ["claude"], repoDir: path.join(scratchDir("gone2"), "nope"), ref: "0".repeat(40) },
  ]);
  const r = f.run([...f.runArgs, "--json"]);
  assert.equal(r.status, 1);
  const env = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(env.ok, false, "the dispatcher recovers an {ok:false} verdict behind a non-zero exit");
  assert.equal(env.fire, true, "an unconfirmed weekly check must alarm, not pass silently");
  assert.match(env.message, /failed: bad/);
});

// ---------------------------------------------------------------------------
// ④ non-destructive by construction
// ---------------------------------------------------------------------------
test("only ls-remote/clone/fetch/checkout are ever run, and no history-rewriting verb appears", async () => {
  const src = fs.readFileSync(UPDATE_SRC, "utf8");
  assert.ok(!/rebase|reset|restore|stash|clean|revert/i.test(src),
    "the update path must contain no history-rewriting / worktree-discarding git verb");

  const { resolveUpstream, materialize } = await import("../../skills/update.mjs");
  const seen = [];
  const fake = (argv) => {
    seen.push(argv);
    if (argv[0] === "ls-remote") return `${"a".repeat(40)}\tHEAD\n`;
    return "";
  };
  await resolveUpstream({ repo: "https://example.invalid/x" }, fake);
  const dir = scratchDir("gitverbs");
  materialize({ name: "demo", source: { repo: "https://example.invalid/x" } }, "b".repeat(40), dir, fake);

  // `-C <dir>` is a global option, not a verb — the verb is what follows it.
  const verbs = seen.map((a) => (a[0] === "-C" ? a[2] : a[0]));
  assert.deepEqual([...new Set(verbs)].sort(), ["checkout", "clone", "fetch", "ls-remote"],
    "the update path may only run read-only git verbs");
});

// ---------------------------------------------------------------------------
// tree hash recipe — the value --apply writes must be the one lock.json documents
// ---------------------------------------------------------------------------
test("treeSha256 pins the documented recipe (repo-relative paths, sorted, LF-terminated)", () => {
  const d = scratchDir("hash");
  fs.mkdirSync(path.join(d, "skills", "demo", "refs"), { recursive: true });
  fs.writeFileSync(path.join(d, "skills", "demo", "SKILL.md"), "hello\n");
  fs.writeFileSync(path.join(d, "skills", "demo", "refs", "a.md"), "world\n");
  const h = treeSha256(d, "skills/demo");
  // Golden value: guards the recipe against a silent format change (double space
  // separator, "<sha256>  <repo-relative path>" lines, bytewise sort, trailing newline).
  assert.equal(h, "a17a2f3a3f3b5adf64da25dcee561169d7a6aa6fc81b0eae5969a90d8ac98ba8");
});
