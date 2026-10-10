#!/usr/bin/env node
/**
 * install-reconcile.test.mjs — B5/B6/B7: reconcile emits add / edit / skip from the
 * declared jobs + the runtime `automations list --json`, with the drift rules pinned:
 *   - poll/patrol (interval) drift ⇒ --light-context (+ --every when the interval drifted)
 *   - team-check-all (cron) ⇒ --light-context only, NEVER --every
 *
 * Run: node --test test/install/install-reconcile.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { reconcileAutomations } from "../../config/reconcile.mjs";

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
/** Write an "expected trigger" file in a scratch dir and return its absolute path. */
function expectedTrigger(content) {
  const dir = tmpDirs[0] || (tmpDirs[0] = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-trigger-")));
  const p = path.join(dir, `t-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(p, content);
  return p;
}

const DECLARED = [
  { key: "openclaw-team:poll:linus", name: "poll-linus", agent: "linus", job: "poll", kind: "interval", interval: "5m", lightContext: true },
  { key: "openclaw-team:task-patrol", name: "task-patrol", agent: "main", job: "patrol", kind: "interval", interval: "15m", lightContext: true },
  { key: "openclaw-team:team-check-all", name: "team-check-all", agent: "main", job: "check-all", kind: "cron", lightContext: true },
];

const job = (over = {}) => ({
  id: "job-1",
  declarationKey: "openclaw-team:poll:linus",
  name: "poll-linus",
  schedule: "every 5m",
  payload: { lightContext: true },
  ...over,
});

test("missing job ⇒ add", () => {
  const actions = reconcileAutomations({ jobs: [] }, DECLARED);
  assert.equal(actions.length, 3);
  assert.ok(actions.every((a) => a.action === "add"));
});

test("existing job already matching ⇒ skip", () => {
  const actions = reconcileAutomations(
    { jobs: [job()] },
    DECLARED
  );
  const poll = actions.find((a) => a.key === "openclaw-team:poll:linus");
  assert.equal(poll.action, "skip");
});

test("existing poll missing lightContext ⇒ edit --light-context", () => {
  const actions = reconcileAutomations(
    { jobs: [job({ payload: { lightContext: false } })] },
    DECLARED
  );
  const poll = actions.find((a) => a.key === "openclaw-team:poll:linus");
  assert.equal(poll.action, "edit");
  assert.deepEqual(poll.editArgs, ["--light-context"]);
  assert.equal(poll.id, "job-1");
});

test("existing poll with drifted interval ⇒ edit --every 5m (plus light-context if also missing)", () => {
  const drifted = job({ schedule: "every 1m", payload: { lightContext: true } });
  const actions = reconcileAutomations({ jobs: [drifted] }, DECLARED);
  const poll = actions.find((a) => a.key === "openclaw-team:poll:linus");
  assert.equal(poll.action, "edit");
  assert.deepEqual(poll.editArgs, ["--every", "5m"]);

  const both = job({ schedule: "every 1m", payload: { lightContext: false } });
  const actions2 = reconcileAutomations({ jobs: [both] }, DECLARED);
  assert.deepEqual(actions2.find((a) => a.key === "openclaw-team:poll:linus").editArgs, ["--light-context", "--every", "5m"]);
});

test("check-all (cron) missing lightContext ⇒ edit --light-context, NEVER --every", () => {
  const checkAll = {
    id: "job-ca",
    declarationKey: "openclaw-team:team-check-all",
    name: "team-check-all",
    schedule: "cron 0 * * * * @ Asia/Shanghai",
    payload: { lightContext: false },
  };
  const actions = reconcileAutomations({ jobs: [job(), checkAll] }, DECLARED);
  const ca = actions.find((a) => a.key === "openclaw-team:team-check-all");
  assert.equal(ca.action, "edit");
  assert.deepEqual(ca.editArgs, ["--light-context"], "cron job must not get --every");
});

test("patrol interval drift (live 5m vs declared 15m) ⇒ --every 15m", () => {
  const patrol = {
    id: "job-patrol",
    declarationKey: "openclaw-team:task-patrol",
    name: "task-patrol",
    schedule: "every 5m",
    payload: { lightContext: true },
  };
  const actions = reconcileAutomations({ jobs: [patrol] }, DECLARED);
  const p = actions.find((a) => a.key === "openclaw-team:task-patrol");
  assert.equal(p.action, "edit");
  assert.deepEqual(p.editArgs, ["--every", "15m"]);
});

test("declarationKey and declaration_key are both honoured", () => {
  const actions = reconcileAutomations(
    { jobs: [job({ declarationKey: undefined, declaration_key: "openclaw-team:poll:linus" })] },
    DECLARED
  );
  assert.equal(actions.find((a) => a.key === "openclaw-team:poll:linus").action, "skip");
});

// — real runtime shape: `schedule` is an object, `{kind:"every", everyMs:N}` —
test("real runtime {kind:every,everyMs:300000} vs declared 5m ⇒ skip (no --every)", () => {
  const real = job({ schedule: { kind: "every", everyMs: 300000, anchorMs: 1 }, payload: { lightContext: true } });
  const actions = reconcileAutomations({ jobs: [real] }, DECLARED);
  const poll = actions.find((a) => a.key === "openclaw-team:poll:linus");
  assert.equal(poll.action, "skip");
  assert.deepEqual(poll.editArgs, undefined);
});

test("real runtime {kind:every,everyMs:900000} (task-patrol) vs declared 15m ⇒ skip", () => {
  const patrol = {
    id: "job-patrol",
    declarationKey: "openclaw-team:task-patrol",
    name: "task-patrol",
    schedule: { kind: "every", everyMs: 900000, anchorMs: 1 },
    payload: { lightContext: true },
  };
  const actions = reconcileAutomations({ jobs: [patrol] }, DECLARED);
  const p = actions.find((a) => a.key === "openclaw-team:task-patrol");
  assert.equal(p.action, "skip");
});

test("real runtime {kind:every,everyMs:60000} vs declared 5m ⇒ edit --every 5m", () => {
  const real = job({ schedule: { kind: "every", everyMs: 60000, anchorMs: 1 }, payload: { lightContext: true } });
  const actions = reconcileAutomations({ jobs: [real] }, DECLARED);
  const poll = actions.find((a) => a.key === "openclaw-team:poll:linus");
  assert.equal(poll.action, "edit");
  assert.deepEqual(poll.editArgs, ["--every", "5m"]);
});

test("real runtime {kind:every,everyMs:60000} missing lightContext ⇒ --light-context --every 5m", () => {
  const real = job({ schedule: { kind: "every", everyMs: 60000, anchorMs: 1 }, payload: { lightContext: false } });
  const actions = reconcileAutomations({ jobs: [real] }, DECLARED);
  const poll = actions.find((a) => a.key === "openclaw-team:poll:linus");
  assert.equal(poll.action, "edit");
  assert.deepEqual(poll.editArgs, ["--light-context", "--every", "5m"]);
});

test("real runtime {kind:cron,expr:…} (check-all) missing lightContext ⇒ --light-context only", () => {
  const checkAll = {
    id: "job-ca",
    declarationKey: "openclaw-team:team-check-all",
    name: "team-check-all",
    schedule: { kind: "cron", expr: "0 * * * *", tz: "Asia/Shanghai" },
    payload: { lightContext: false },
  };
  const actions = reconcileAutomations({ jobs: [job(), checkAll] }, DECLARED);
  const ca = actions.find((a) => a.key === "openclaw-team:team-check-all");
  assert.equal(ca.action, "edit");
  assert.deepEqual(ca.editArgs, ["--light-context"], "cron must never get --every");
});

// — trigger-script body reconciliation (T-20261010-092547) —
// RED before the feature: a job whose live `trigger.script` drifts from the declared
// expected file was reported `skip` (the body was never reconciled). GREEN now: it emits
// `--trigger-script <declaredPath>` so a re-run of install.sh repairs the drift.
test("trigger body drift ⇒ edit --trigger-script <path> (red→green)", () => {
  const p = expectedTrigger("// EXPECTED TRIGGER BODY\n");
  const declared = [{ ...DECLARED[0], triggerScriptPath: p }];
  const live = job({ trigger: { script: "// DRIFTED LEGACY TRIGGER\n" } });
  const actions = reconcileAutomations({ jobs: [live] }, declared);
  const poll = actions.find((a) => a.key === "openclaw-team:poll:linus");
  assert.equal(poll.action, "edit");
  assert.deepEqual(poll.editArgs, ["--trigger-script", p]);
  assert.ok(poll.reasons.includes("trigger-script drift"));
});

test("trigger body already matching ⇒ skip (idempotent; trailing newline tolerated)", () => {
  const p = expectedTrigger("// EXPECTED TRIGGER BODY\n");
  const declared = [{ ...DECLARED[0], triggerScriptPath: p }];
  // Gateway strips the heredoc trailing newline on round-trip ⇒ must still be a match.
  const live = job({ trigger: { script: "// EXPECTED TRIGGER BODY" } });
  const actions = reconcileAutomations({ jobs: [live] }, declared);
  const poll = actions.find((a) => a.key === "openclaw-team:poll:linus");
  assert.equal(poll.action, "skip");
});

test("trigger body drift combines with lightContext/interval drift (order: light-context, every, trigger-script)", () => {
  const p = expectedTrigger("// EXPECTED\n");
  const declared = [{ ...DECLARED[0], triggerScriptPath: p }];
  const live = job({ schedule: { kind: "every", everyMs: 60000 }, payload: { lightContext: false }, trigger: { script: "// OLD\n" } });
  const actions = reconcileAutomations({ jobs: [live] }, declared);
  const poll = actions.find((a) => a.key === "openclaw-team:poll:linus");
  assert.equal(poll.action, "edit");
  assert.deepEqual(poll.editArgs, ["--light-context", "--every", "5m", "--trigger-script", p]);
});

test("declared triggerScriptPath unreadable ⇒ rule skipped, never emits a bad path (fail-safe)", () => {
  const declared = [{ ...DECLARED[0], triggerScriptPath: path.join(os.tmpdir(), "definitely-missing-trigger-xyz.js") }];
  const live = job({ trigger: { script: "// anything\n" } });
  const actions = reconcileAutomations({ jobs: [live] }, declared);
  const poll = actions.find((a) => a.key === "openclaw-team:poll:linus");
  assert.equal(poll.action, "skip");
});

test("run twice on the same input ⇒ identical actions (pure/deterministic, 幂等)", () => {
  const p = expectedTrigger("// EXPECTED\n");
  const declared = [{ ...DECLARED[0], triggerScriptPath: p }];
  const live = job({ trigger: { script: "// OLD\n" } });
  const a1 = reconcileAutomations({ jobs: [live] }, declared);
  const a2 = reconcileAutomations({ jobs: [live] }, declared);
  assert.deepEqual(a1, a2);
});
