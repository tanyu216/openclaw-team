#!/usr/bin/env node
// Fetch team skills from their declared upstream sources (option A).
//
//   node fetch.mjs                 # install from source (needs network)
//   node fetch.mjs --vendor        # snapshot sources into skills/vendor/
//   node fetch.mjs --offline       # install from skills/vendor/ (no network)
//
// Reads skills/manifest.json (+ lock.json). Never invents a source: entries
// whose source.kind === "unknown" are skipped with a warning.
import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(n);

const OPENCLAW_HOME = opt("--openclaw-home", join(os.homedir(), ".openclaw"));
const CLAUDE_HOME = opt("--claude-home", join(os.homedir(), ".claude"));
const CODEX_HOME = opt("--codex-home", join(os.homedir(), ".codex"));
const VENDOR_DIR = opt("--vendor-dir", join(HERE, "vendor"));
const DRY = flag("--dry-run"), KEEP = flag("--keep");
const MODE = flag("--vendor") ? "vendor" : flag("--offline") ? "offline" : "install";

const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));

function targetDir(t) {
  if (t === "openclaw") return join(OPENCLAW_HOME, "skills");
  if (t === "claude") return join(CLAUDE_HOME, "skills");
  if (t === "codex") return join(CODEX_HOME, "skills");
  if (t.startsWith("agent:")) return join(OPENCLAW_HOME, `workspace-${t.slice(6)}`, "skills");
  throw new Error(`unknown target: ${t}`);
}

let installed = 0, skipped = 0, unresolved = 0, failed = 0;

function copyInto(srcDir, name, target) {
  const dst = join(targetDir(target), name);
  if (resolve(srcDir) === resolve(dst)) { installed++; return; }
  if (existsSync(dst) && KEEP) { console.log(`  skip  ${name} → ${target} (exists)`); skipped++; return; }
  console.log(`  ${DRY ? "[dry-run] " : ""}fetch ${name} → ${target}`);
  if (DRY) { installed++; return; }
  mkdirSync(dirname(dst), { recursive: true });
  rmSync(dst, { recursive: true, force: true });
  cpSync(srcDir, dst, { recursive: true });
  installed++;
}

function materialize(entry, workdir) {
  // returns a local directory containing the skill, or null
  const s = entry.source;
  if (s.kind === "local") return join(HERE, "local", entry.name);
  if (s.kind === "github") {
    const clone = join(workdir, entry.name);
    execFileSync("git", ["clone", "-q", "--depth", "1", s.repo, clone], { stdio: "inherit" });    if (s.ref) {
      try { execFileSync("git", ["-C", clone, "fetch", "-q", "--depth", "1", "origin", s.ref], { stdio: "inherit" }); }
      catch { /* shallow fetch by sha may fail on some servers */ }
      execFileSync("git", ["-C", clone, "checkout", "-q", s.ref], { stdio: "inherit" });
    }
    const dir = s.path ? join(clone, s.path) : clone;
    if (!existsSync(dir)) throw new Error(`path not found in repo: ${s.path}`);
    return dir;
  }
  if (s.kind === "clawhub") {
    if (MODE === "vendor") {
      const dst = join(VENDOR_DIR, entry.name);
      const a = ["skills", "install", s.ref, "--global", "--force"];
      if (s.version) a.push("--version", s.version);
      execFileSync("openclaw", a, { stdio: "inherit" });
      const slug = s.ref.split("/").pop();
      const src = join(OPENCLAW_HOME, "skills", slug);
      rmSync(dst, { recursive: true, force: true });
      cpSync(src, dst, { recursive: true });
      return dst;
    }
    const slug = s.ref.split("/").pop();
    const dst = join(OPENCLAW_HOME, "skills", slug);
    if (existsSync(dst) && KEEP) return dst; // already present
    const a = ["skills", "install", s.ref, "--global", "--force"];
    if (s.version) a.push("--version", s.version);
    execFileSync("openclaw", a, { stdio: "inherit" });
    return dst;
  }
  return null;
}

const work = join(os.tmpdir(), `openclaw-team-skills-${process.pid}`);
mkdirSync(work, { recursive: true });
mkdirSync(VENDOR_DIR, { recursive: true });

try {
  for (const entry of manifest.skills) {
    const s = entry.source;
    if (s.kind === "unknown") {
      console.log(`  ! unresolved ${entry.name} (needs_source) — skipped`);
      unresolved++;
      continue;
    }
    try {
      if (DRY) {
        for (const t of entry.targets) console.log(`  [dry-run] fetch ${entry.name} → ${t}`);
        installed++;
        continue;
      }
      let dir;
      if (MODE === "offline") {
        dir = join(VENDOR_DIR, entry.name);
        if (!existsSync(dir)) { console.log(`  ! offline: no snapshot for ${entry.name}`); failed++; continue; }
      } else if (MODE === "vendor") {
        dir = materialize(entry, work);
        console.log(`  ${DRY ? "[dry-run] " : ""}vendored ${entry.name}`);
        installed++;
        continue;
      } else {
        dir = materialize(entry, work);
      }
      if (!dir) { console.log(`  ! ${entry.name}: unsupported source ${s.kind}`); failed++; continue; }
      for (const t of entry.targets) copyInto(dir, entry.name, t);
    } catch (e) {
      console.log(`  ✗ ${entry.name}: ${e.message}`);
      failed++;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (MODE === "vendor" && !DRY && installed > 0) {
  writeFileSync(join(VENDOR_DIR, "SNAPSHOT.md"),
    `# Skills snapshot\n\nGenerated by \`fetch.mjs --vendor\` on ${new Date().toISOString()}. ` +
    `Offline install: \`install.sh --offline\`. Bodies here are third-party; keep their licenses.\n`);
}

console.log(`\nskills[${MODE}]: installed=${installed} skipped=${skipped} unresolved=${unresolved} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
