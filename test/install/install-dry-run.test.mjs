#!/usr/bin/env node
/**
 * install-dry-run.test.mjs — B1/B4/B5 + A3 (bash-level integration).
 *
 * Runs `install.sh --dry-run` against a FAKE `openclaw` shim (PATH-injected) and an
 * isolated OPENCLAW_HOME, so the real CLI and the real ~/.openclaw deployment are
 * never touched. Asserts the declarative source produces the intended preview:
 *   - poll/patrol/check-all add commands all carry `--light-context`
 *   - poll carries `--every 5m` (not the retired `--every 2m`/`--every 1m`)
 *   - task-patrol carries `--every 15m`
 *   - a job that already exists but drifts (lightContext missing) previews an `edit`
 *   - an already-optimised install (optimizationApplied marker) previews NO backfill
 *
 * Run: node --test test/install/install-dry-run.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { renderTrigger } from "../../team/automations/trigger-template.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/test/install
const REPO = path.resolve(HERE, "..", "..");               // <repo>
const INSTALL = path.join(REPO, "install.sh");

const scratchDirs = [];
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Fake `openclaw` shim: records argv, answers `automations list --json` from a fixture. */
function writeFakeOpenclaw(bin) {
  const shim = path.join(bin, "openclaw");
  fs.writeFileSync(shim, [
    "#!/usr/bin/env bash",
    'echo "openclaw $*" >> "${FAKE_OPENCLAW_LOG:?}"',
    'if [ "$1" = "automations" ] && [ "$2" = "list" ]; then',
    '  cat "${FAKE_AUTOMATIONS_JSON:?}"',
    '  exit 0',
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  return shim;
}

function setup({ automationsJobs = [], jobsFn = null, optimizationApplied = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-install-dryrun-"));
  scratchDirs.push(root);
  const openclawHome = path.join(root, ".openclaw");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(openclawHome, { recursive: true });

  const automationsFixture = path.join(root, "automations.json");
  const jobs = jobsFn ? jobsFn(openclawHome) : automationsJobs;
  fs.writeFileSync(automationsFixture, JSON.stringify({ jobs }));

  const log = path.join(root, "fake-openclaw.log");
  writeFakeOpenclaw(bin);

  // an openclaw.json whose deepseek models are MISSING the backfill fields
  fs.writeFileSync(path.join(openclawHome, "openclaw.json"), JSON.stringify({
    models: {
      providers: {
        deepseek: {
          models: [
            { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
            { id: "deepseek-flash", name: "DeepSeek Flash" },
          ],
        },
      },
    },
  }));

  if (optimizationApplied) {
    fs.mkdirSync(path.join(openclawHome, "team"), { recursive: true });
    fs.writeFileSync(path.join(openclawHome, "team", ".install-state.json"),
      JSON.stringify({ version: "0.0.0", installedAt: "2026-01-01T00:00:00Z", optimizationApplied: true }));
  }

  const tmpdir = path.join(root, "tmp");
  fs.mkdirSync(tmpdir, { recursive: true });

  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    OPENCLAW_HOME: openclawHome,
    TMPDIR: tmpdir, // keep install.sh `mktemp` inside the sandbox, off the real ~/.openclaw/tmp
    FAKE_AUTOMATIONS_JSON: automationsFixture,
    FAKE_OPENCLAW_LOG: log,
  };
  return { root, openclawHome, env, log };
}

const BASE_ARGS = ["--dry-run", "--no-meerkat-taskpanel", "--skip-skills", "--skip-agents"];

/** byte-exact expected poll trigger for an isolated OPENCLAW_HOME (matches install.sh write_trigger). */
function expectedPollTrigger(openclawHome, agent = "linus") {
  return renderTrigger({
    teamDir: path.join(openclawHome, "team"),
    dargs: `poll ${agent}`,
    evalTimeoutS: 8,
    evalTimeoutMs: 8000,
  });
}

function runInstall(env, extra = []) {
  const r = spawnSync("bash", [INSTALL, ...BASE_ARGS, ...extra], { env, encoding: "utf8" });
  return { out: (r.stdout || "") + (r.stderr || ""), status: r.status };
}

test("legacy-name-compat: the pre-rebrand --no-task-panel alias still opts out, exit 0, no warning", () => {
  const { env } = setup();
  // deliberately NOT BASE_ARGS: exercise the pre-rebrand flag name on its own
  const r = spawnSync("bash",
    [INSTALL, "--dry-run", "--no-task-panel", "--skip-skills", "--skip-agents"], // legacy-name-compat
    { env, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");

  // Exit 0 matters: the meerkat-taskpanel repo's docker/verify-in-container.sh calls the
  // installer under `set -euo pipefail`, so a warning would abort it.
  assert.equal(r.status, 0, "the deprecated alias must not flip the installer exit code");
  assert.ok(out.includes("is deprecated (legacy-name-compat)"), "the alias must announce its deprecation");
  assert.ok(out.includes("meerkat-taskpanel opted out"), "the alias must still opt out of the provider");
  assert.ok(out.includes("warnings=0"), "a deprecation note must not be counted as a warning");
});

test("dry-run previews --light-context on poll/patrol/check-all and --every 5m on poll", () => {
  const { env } = setup();
  const { out } = runInstall(env);

  assert.ok(out.includes("--every 5m"), "poll must preview the new 5m interval");
  assert.ok(!out.includes("--every 1m"), "the old 1m interval must be gone from the declaration source");
  assert.ok(!out.includes("--every 2m"), "the retired 2m interval must be gone from the declaration source");

  const pollAdd = out.split("\n").find((l) => l.includes("automations add poll-linus"));
  assert.ok(pollAdd, "poll add preview must be present");
  assert.ok(pollAdd.includes("--every 5m"));
  assert.ok(pollAdd.includes("--light-context"));

  assert.ok(out.split("\n").some((l) => l.includes("automations add task-patrol") && l.includes("--light-context")),
    "task-patrol add must carry --light-context");
  // pin the DECLARED patrol cadence here (this is the only test that actually executes
  // install.sh): the reconcile suite's DECLARED is a hand-written fixture, so without this
  // a patrol 15m → 5m reversion in install.sh would be invisible to the whole suite.
  const patrolAdd = out.split("\n").find((l) => l.includes("automations add task-patrol"));
  assert.ok(patrolAdd.includes("--every 15m"), "task-patrol must preview the widened 15m interval");
  assert.ok(out.split("\n").some((l) => l.includes("automations add team-check-all") && l.includes("--light-context")),
    "team-check-all add must carry --light-context");
});

test("optimizationApplied marker set ⇒ no providers backfill is previewed", () => {
  const { env } = setup({ optimizationApplied: true });
  const { out } = runInstall(env);

  assert.ok(out.includes("optimization already applied"), "marker hit must be reported");
  assert.ok(!out.includes("apply providers backfill"), "no backfill patch may be previewed when the marker is set");
});

test("existing poll missing lightContext ⇒ edit --light-context preview; matching job ⇒ no edit", () => {
  const drifted = {
    id: "job-1",
    declarationKey: "openclaw-team:poll:linus",
    name: "poll-linus",
    schedule: "every 5m",
    payload: { lightContext: false },
  };
  const { env } = setup({ automationsJobs: [drifted] });
  const { out } = runInstall(env);

  assert.ok(out.includes("automations edit job-1 --light-context"),
    "a drifted poll must preview an edit --light-context");
  assert.ok(out.includes("--trigger-script"),
    "a job with no/drifted trigger body must also preview --trigger-script (T-20261010-092547)");
  assert.ok(!out.includes("automations add poll-linus"), "an existing poll must not be re-added");

  // fully matching job: lightContext present AND the live trigger body byte-matches the
  // declared expected file ⇒ NO edit (idempotent re-run). The trigger must be rendered
  // against the SAME isolated home install.sh will use (TEAM_DIR = OPENCLAW_HOME/team).
  const { env: env3 } = setup({
    jobsFn: (home) => [{
      ...drifted,
      payload: { lightContext: true },
      trigger: { script: expectedPollTrigger(home, "linus") },
    }],
  });
  const { out: out2 } = runInstall(env3);
  assert.ok(!out2.includes("automations edit"), "an already-matching poll must not be edited");
  assert.ok(out2.includes("automations add task-patrol"), "other (missing) jobs still preview an add");
});

test("drifted live trigger.script ⇒ edit --trigger-script preview (red→green)", () => {
  const drifted = {
    id: "job-1",
    declarationKey: "openclaw-team:poll:linus",
    name: "poll-linus",
    schedule: "every 5m",
    payload: { lightContext: true },
    trigger: { script: "// OLD inline poll trigger (pre-dispatcher)\n" },
  };
  const { env } = setup({ automationsJobs: [drifted] });
  const { out } = runInstall(env);
  const edit = out.split("\n").find((l) => l.includes("automations edit job-1"));
  assert.ok(edit, "trigger drift must preview an edit");
  assert.ok(edit.includes("--trigger-script"), "the edit must carry --trigger-script <expected path>");
});

// ---- skills-update (T-20261013-025818 ⑥) ------------------------------------

/** byte-exact expected skills-update trigger for an isolated OPENCLAW_HOME. */
function expectedSkillsUpdateTrigger(openclawHome) {
  return renderTrigger({
    teamDir: path.join(openclawHome, "team"),
    dargs: "skills-update",
    evalTimeoutS: 8,
    evalTimeoutMs: 8000,
  });
}

test("dry-run previews the weekly skills-update job (Sundays 05:00 Asia/Shanghai, light-context, isolated)", () => {
  const { env } = setup();
  const { out, status } = runInstall(env);
  assert.equal(status, 0);

  const line = out.split("\n").find((l) => l.includes("automations add skills-update"));
  assert.ok(line, "the skills-update job must be part of the declared set");
  assert.ok(line.includes("--agent main"), "the detector runs in the main session");
  assert.ok(line.includes("--cron 0 5 * * 0"), "cadence = weekly on Sunday 05:00");
  assert.ok(line.includes("--tz Asia/Shanghai"));
  assert.ok(line.includes("--light-context"), "framework jobs run light-context (§4)");
  assert.ok(line.includes("--session isolated"));
  assert.ok(line.includes("--declaration-key openclaw-team:skills-update"));
  assert.ok(line.includes("--trigger-script"), "the job is a trigger job, not a plain cron run");
});

test("an already-registered skills-update job previews a skip — re-running install.sh is idempotent", () => {
  const live = (home) => [{
    id: "job-su",
    declarationKey: "openclaw-team:skills-update",
    name: "skills-update",
    schedule: { kind: "cron", expr: "0 5 * * 0" },
    payload: { lightContext: true },
    trigger: { script: expectedSkillsUpdateTrigger(home) },
  }];
  const { env } = setup({ jobsFn: live });
  const { out } = runInstall(env);
  assert.ok(!out.includes("automations add skills-update"), "a registered job must not be re-added");
  assert.ok(!out.split("\n").some((l) => l.includes("automations edit")), "an already-matching job must not be edited");
  assert.ok(out.includes("ok       skills-update"), "it must be reported as already matching");
  assert.ok(out.includes("automations add task-patrol"), "the other (missing) jobs still preview an add");
});

// ---- tmp-gc (`R-DISC-9`) --------------------------------------------------

/** byte-exact expected tmp-gc trigger for an isolated OPENCLAW_HOME. */
function expectedTmpGcTrigger(openclawHome) {
  return renderTrigger({
    teamDir: path.join(openclawHome, "team"),
    dargs: "tmp-gc",
    evalTimeoutS: 8,
    evalTimeoutMs: 8000,
  });
}

test("dry-run previews the daily tmp-gc scratch GC (02:20 Asia/Shanghai, light-context, isolated)", () => {
  const { env } = setup();
  const { out, status } = runInstall(env);
  assert.equal(status, 0);

  const line = out.split("\n").find((l) => l.includes("automations add tmp-gc"));
  assert.ok(line, "the scratch GC job must be part of the declared set");
  assert.ok(line.includes("--agent main"), "the janitor runs in the main session");
  assert.ok(line.includes("--cron 20 2 * * *"), "cadence = daily 02:20 (a slot free of the other crons)");
  assert.ok(line.includes("--tz Asia/Shanghai"));
  assert.ok(line.includes("--light-context"), "framework jobs run light-context (§4)");
  assert.ok(line.includes("--session isolated"));
  assert.ok(line.includes("--declaration-key openclaw-team:tmp-gc"));
  assert.ok(line.includes("--trigger-script"), "the job is a trigger job, not a plain cron run");
});

test("the role workspaces get their .tmp scratch root at install time (§⑬.9)", () => {
  // NOT BASE_ARGS: --skip-agents skips §3 entirely, which is exactly the step under test.
  const { env, openclawHome } = setup();
  const r = spawnSync("bash", [INSTALL, "--dry-run", "--no-meerkat-taskpanel", "--skip-skills"], { env, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  assert.equal(r.status, 0);
  for (const ws of ["workspace-elon", "workspace-jobs", "workspace-linus", "workspace-turing", "workspace-assistant"]) {
    const want = path.join(openclawHome, ws, ".tmp");
    assert.ok(out.split("\n").some((l) => l.includes("mkdir -p") && l.trim().endsWith(want)),
      `${want} must be created by install.sh §3`);
  }
});

test("an already-registered tmp-gc job previews a skip — re-running install.sh is idempotent", () => {
  const live = (home) => [{
    id: "job-tg",
    declarationKey: "openclaw-team:tmp-gc",
    name: "tmp-gc",
    schedule: { kind: "cron", expr: "20 2 * * *" },
    payload: { lightContext: true },
    trigger: { script: expectedTmpGcTrigger(home) },
  }];
  const { env } = setup({ jobsFn: live });
  const { out } = runInstall(env);
  assert.ok(!out.includes("automations add tmp-gc"), "a registered job must not be re-added");
  assert.ok(out.includes("ok       tmp-gc"), "it must be reported as already matching");
});
