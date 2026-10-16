#!/usr/bin/env node
/**
 * skill-clis.test.mjs — the declared external CLI dependencies (`config/skill-clis.json`)
 * and the installer step that provisions them.
 *
 * A skill that shells out to a CLI is only half-installed without that CLI; the
 * declaration is what keeps the two from drifting apart, so the checks here are:
 *   - every entry names a probe, a valid mode, and something to install with; and every
 *     `requiredBy` skill really exists in `skills/manifest.json` (a renamed skill would
 *     otherwise fail silently)
 *   - `mode:install` CLIs are PLANNED under --dry-run without ever calling npm
 *     (dry-run must not mutate the machine), and reported `present` when they exist
 *   - `mode:check-only` CLIs are REPORTED with their upstream command and NEVER installed,
 *     which is the whole point of the mode — its upstream installer is not something an
 *     unattended run may execute
 *   - --skip-skill-clis (alias --skip-ocr-cli) suppresses the step entirely
 *
 * NOT covered here: the branch that actually runs `npm i -g`. Reaching it needs a
 * non-dry-run installer pass, and a non-dry-run pass fetches all 94 skills from the
 * network — out of scope for a unit suite. The container's `--net` run uses
 * `--skip-skills`, so it does not reach it either.
 *
 * Run: node --test test/install/skill-clis.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/test/install
const REPO = path.resolve(HERE, "..", "..");               // <repo>
const INSTALL = path.join(REPO, "install.sh");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const CLIS = readJson(path.join(REPO, "config", "skill-clis.json"));
const MANIFEST = readJson(path.join(REPO, "skills", "manifest.json"));

const ENTRIES = Object.entries(CLIS.clis || {});
const modeOf = (c) => c.mode || "install";
const INSTALL_MODE = ENTRIES.filter(([, c]) => modeOf(c) === "install");
const CHECK_ONLY = ENTRIES.filter(([, c]) => modeOf(c) === "check-only");
const probeOf = ([name, c]) => c.probe || name;

const scratchDirs = [];
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ---- declaration integrity (pure, no subprocess) ----------------------------

test("config/skill-clis.json: every entry is actionable and points at real skills", () => {
  assert.ok(ENTRIES.length > 0, "the declaration must not be empty");

  const names = new Set(MANIFEST.skills.map((s) => s.name));
  for (const entry of ENTRIES) {
    const [name, c] = entry;
    assert.match(name, /^[a-z0-9][a-z0-9-]*$/, `${name}: CLI name must be a bare command name`);
    assert.ok(c.probe, `${name}: needs a probe`);
    assert.ok(["install", "check-only"].includes(modeOf(c)), `${name}: unknown mode ${c.mode}`);
    assert.ok(Array.isArray(c.requiredBy) && c.requiredBy.length, `${name}: needs requiredBy[]`);
    for (const skill of c.requiredBy) {
      assert.ok(names.has(skill), `${name}: requiredBy "${skill}" is not a declared skill`);
    }
    if (modeOf(c) === "install") {
      assert.equal(c.manager, "npm", `${name}: install mode currently only executes npm`);
      assert.ok(c.package, `${name}: install mode needs an npm package`);
    } else {
      // check-only entries are only ever DISPLAYED — so the display string is the contract.
      assert.ok(c.install, `${name}: check-only needs the upstream install command to report`);
      assert.ok(!c.package, `${name}: check-only must not look installable`);
    }
  }
  assert.ok(CLIS.clis.ocr && CLIS.clis.gitnexus, "ocr + gitnexus are the install-mode CLIs");
});

test("the tavily CLI is check-only, and the declaration records why", () => {
  const tvly = CLIS.clis.tvly;
  assert.equal(modeOf(tvly), "check-only", "tvly must never be auto-installed");
  assert.match(tvly.install, /cli\.tavily\.com/, "the reported command is the upstream one");
  // The npm package of this name is a third party's; the note must keep saying so.
  assert.match(tvly.note, /pyrytakala/, "the name hazard must stay documented");
});

// The change that made these skills usable from Claude Code: both halves of that
// skill ship to the `claude` target — and the lock must agree, or drift detection
// would compare against a target set fetch.mjs never used.
test("open-code-review* are installed for claude in BOTH manifest and lock", () => {
  const LOCK = readJson(path.join(REPO, "skills", "lock.json"));
  for (const name of CLIS.clis.ocr.requiredBy) {
    for (const [file, doc] of [["manifest", MANIFEST], ["lock", LOCK]]) {
      const entry = doc.skills.find((s) => s.name === name);
      assert.ok(entry, `${name}: missing from ${file}`);
      assert.ok(entry.targets.includes("claude"), `${name}: ${file} does not target claude`);
      assert.ok(entry.targets.includes("openclaw"), `${name}: ${file} dropped the openclaw target`);
    }
  }
});

// ---- installer behaviour (bash-level, offline) ------------------------------

/**
 * Fake `openclaw` (exit 0) + fake `npm` that records invocations instead of running,
 * plus a symlink to the *real* node (install.sh needs it). `present` names the probes
 * to fake as installed; nothing else is linked, so "missing" is a fact of this sandbox
 * rather than a property of the host — a developer who has these CLIs installed must not
 * see a different result than CI.
 */
function writeShims(bin, present = []) {
  fs.writeFileSync(path.join(bin, "openclaw"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "npm"),
    '#!/usr/bin/env bash\necho "npm $*" >> "${FAKE_NPM_LOG:?}"\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  for (const name of present) {
    fs.writeFileSync(path.join(bin, name), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  }
}

function setup({ present = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-skill-clis-"));
  scratchDirs.push(root);
  const bin = path.join(root, "bin");
  const tmpdir = path.join(root, "tmp");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(tmpdir, { recursive: true });
  writeShims(bin, present);

  const npmLog = path.join(root, "npm.log");
  fs.writeFileSync(npmLog, "");
  // PATH is REPLACED, not prefixed: the sandbox must expose exactly the shims above
  // plus the system dirs (bash/awk/…), so host-installed CLIs cannot leak in.
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: tmpdir,
    FAKE_NPM_LOG: npmLog,
  };
  return { root, env, npmLog, bin };
}

// Skills stay ON (that is the stage under test); every other stage is turned off so
// the run stays offline and touches nothing outside the temp root.
const ARGS = ["--dry-run", "--no-meerkat-taskpanel", "--no-register",
  "--skip-agents", "--skip-config", "--skip-team", "--skip-automations"];

function runInstall(env, extra = []) {
  const r = spawnSync("bash", [INSTALL, ...ARGS, ...extra], { env, encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}

const npmInstalledAnything = (log) =>
  fs.readFileSync(log, "utf8").split("\n").some((l) => /npm i -g|npm install -g/.test(l));

test("dry-run: plans every install-mode CLI and never shells out to npm", () => {
  const { env, npmLog } = setup();
  const out = runInstall(env);
  for (const entry of INSTALL_MODE) {
    const [name, c] = entry;
    assert.ok(out.includes(`would install: npm i -g ${c.package}`),
      `expected a dry-run plan line for ${name}, got:\n${out}`);
  }
  assert.ok(!npmInstalledAnything(npmLog), "dry-run must not install anything");
});

test("install-mode CLIs that are present are reported present and npm is untouched", () => {
  const { env, npmLog } = setup({ present: INSTALL_MODE.map(probeOf) });
  const out = runInstall(env);
  for (const entry of INSTALL_MODE) {
    assert.ok(out.includes(`${entry[0]} CLI: present`), `expected ${entry[0]} present:\n${out}`);
  }
  assert.ok(!out.includes("would install"), "nothing should be planned for install");
  assert.ok(!npmInstalledAnything(npmLog), "nothing should be installed");
});

test("check-only CLIs are reported with the upstream command and NEVER installed", () => {
  assert.ok(CHECK_ONLY.length > 0, "this test is meaningless with no check-only entry");
  const { env, npmLog } = setup(); // nothing present
  const out = runInstall(env);
  for (const entry of CHECK_ONLY) {
    const [name, c] = entry;
    assert.ok(out.includes(`${name} CLI: missing (declared check-only`),
      `expected ${name} to be reported check-only, got:\n${out}`);
    assert.ok(out.includes(c.install), `${name}: the upstream command must be shown:\n${out}`);
    assert.ok(!out.includes(`would install: ${c.install}`), `${name}: must never be planned as an install`);
  }
  assert.ok(!npmInstalledAnything(npmLog), "a check-only CLI must never reach npm");
});

test("--skip-skill-clis suppresses the step (alias --skip-ocr-cli too)", () => {
  for (const flag of ["--skip-skill-clis", "--skip-ocr-cli"]) {
    const { env, npmLog } = setup();
    const out = runInstall(env, [flag]);
    assert.ok(!out.includes("would install"), `${flag}: the step must be skipped entirely:\n${out}`);
    assert.ok(!out.includes("CLI: missing"), `${flag}: nothing should be reported at all:\n${out}`);
    assert.ok(!npmInstalledAnything(npmLog), `${flag}: npm must not be called`);
  }
});
