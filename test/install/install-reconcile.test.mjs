#!/usr/bin/env node
/**
 * install-reconcile.test.mjs — B5/B6/B7: reconcile emits add / edit / skip from the
 * declared jobs + the runtime `automations list --json`, with the drift rules pinned:
 *   - poll/patrol (interval) drift ⇒ --light-context (+ --every when the interval drifted)
 *   - team-check-all (cron) ⇒ --light-context only, NEVER --every
 *
 * Run: node --test test/install/install-reconcile.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileAutomations } from "../../config/reconcile.mjs";

const DECLARED = [
  { key: "openclaw-team:poll:linus", name: "poll-linus", agent: "linus", job: "poll", kind: "interval", interval: "2m", lightContext: true },
  { key: "openclaw-team:task-patrol", name: "task-patrol", agent: "main", job: "patrol", kind: "interval", interval: "5m", lightContext: true },
  { key: "openclaw-team:team-check-all", name: "team-check-all", agent: "main", job: "check-all", kind: "cron", lightContext: true },
];

const job = (over = {}) => ({
  id: "job-1",
  declarationKey: "openclaw-team:poll:linus",
  name: "poll-linus",
  schedule: "every 2m",
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

test("existing poll with drifted interval ⇒ edit --every 2m (plus light-context if also missing)", () => {
  const drifted = job({ schedule: "every 1m", payload: { lightContext: true } });
  const actions = reconcileAutomations({ jobs: [drifted] }, DECLARED);
  const poll = actions.find((a) => a.key === "openclaw-team:poll:linus");
  assert.equal(poll.action, "edit");
  assert.deepEqual(poll.editArgs, ["--every", "2m"]);

  const both = job({ schedule: "every 1m", payload: { lightContext: false } });
  const actions2 = reconcileAutomations({ jobs: [both] }, DECLARED);
  assert.deepEqual(actions2.find((a) => a.key === "openclaw-team:poll:linus").editArgs, ["--light-context", "--every", "2m"]);
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

test("patrol interval drift ⇒ --every 5m", () => {
  const patrol = {
    id: "job-patrol",
    declarationKey: "openclaw-team:task-patrol",
    name: "task-patrol",
    schedule: "every 5m",
    payload: { lightContext: true },
  };
  const actions = reconcileAutomations({ jobs: [patrol] }, DECLARED);
  const p = actions.find((a) => a.key === "openclaw-team:task-patrol");
  assert.equal(p.action, "skip");
});

test("declarationKey and declaration_key are both honoured", () => {
  const actions = reconcileAutomations(
    { jobs: [job({ declarationKey: undefined, declaration_key: "openclaw-team:poll:linus" })] },
    DECLARED
  );
  assert.equal(actions.find((a) => a.key === "openclaw-team:poll:linus").action, "skip");
});
