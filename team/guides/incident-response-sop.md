# Incident Response SOP (incident-response-sop.md)

> **Ownership / Maintainer**: first response on the engineering side is **Linus**; **Elon** owns coordination and reporting and is the **sole writer of L1** (the normative text). This file is the L2.5 method library.
> **Depends on**: `PROTOCOL §5` (message discipline) · `PROTOCOL §5.1` (public release channel & approval) · `PROTOCOL §6` (git discipline) · `PROTOCOL §6.1` (engineering quality standards) · `PROTOCOL §9` (defect loop) · `PROTOCOL §9.3` (container-form acceptance) · `PROTOCOL §12` (two-way doc sync) · `PROTOCOL §14` (confirmation gate) · `PROTOCOL §15` (SLA / timeout) · `PROTOCOL §15.1` (team-stalled exception channel) · `PROTOCOL §17` (doc layering / no verbatim copying) · `PROTOCOL §20.1` (machine-checkable gates) · `PROTOCOL §20.2` (not machine-checkable) · `PROTOCOL §21` (release & versioning) · `PROTOCOL §22` (runtime observability).
> **Scope**: this file = **L2.5 method library** for product/service incident response. The **normative mechanism** lives in the L1 clause `PROTOCOL §23` (product incident response); this SOP **details and operationalises** it and is **referenced, not copied** (see `PROTOCOL §17`). Where this file and L1 disagree, **L1 wins**.
> **Reference convention**: always write "`PROTOCOL §<n> <name>`" or "`guide-name §<section>`"; **never line-number anchors and never card-number anchors**.
> **Sibling guides**: `runtime-observability-sop.md` · `release-versioning-sop.md` · `data-migration-sop.md` · `ci-release-sop.md`.
> **Team-gateway (not a product) failure**: the team's own orchestration gateway is **not** a product incident — see `team/README.md §4 Recovery Handbook`.

---

## 0. Object Declaration (read first)

> 🚩 **This SOP has a different object from `PROTOCOL §15 / §15.1` (canonical boundary: `sla-inspection-contract.md §0`):**
> - **This SOP = a product/service incident in production** (production unavailable / data corruption / money or transaction anomaly / security event). Its landing point is **the delivered product or service**.
> - **`PROTOCOL §15`** = the **team-collaboration SLA / timeout-escalation table** (blocked cards, confirmation gates awaiting review, stale heartbeats) — object = **the team collaboration process itself**.
> - **`PROTOCOL §15.1`** = the **team-stalled exception channel** (coordinator patrol/dispatch idle >6h) — object = **team-orchestration stall**, not a product fault.
>
> **One-line boundary**: **product/service is down ⇒ this SOP; team collaboration is stuck ⇒ `PROTOCOL §15`; team orchestration is stalled ⇒ `PROTOCOL §15.1`.** The three do not substitute for each other and must not be conflated (see §6).

---

## 1. Scope and Boundary

| Item | Content |
|---|---|
| **Does** | **Grading**, **on-call first response**, **stop-the-bleed / mitigation**, **escalation**, **recovery confirmation**, **postmortem**, **backfill** for production product/service incidents. |
| **Does not** | Collaboration wait timeouts (`PROTOCOL §15`); the team-stalled exception report (`PROTOCOL §15.1`); the release action itself and version-number/rollback-plan details (that is `release-versioning-sop.md`); building monitoring / alerting / health checks (that is `runtime-observability-sop.md`); the engineering process for fixing a code defect (that is the defect-repair-and-regression loop, `PROTOCOL §9`). |
| **Handoff in** | Discovery comes from observability/alerting (`runtime-observability-sop.md`); a rollback/revert to a previous version follows `release-versioning-sop.md`; defect reproduction/regression goes to the testing owner (`PROTOCOL §9`); action-item cards and external notification are done by Elon (`PROTOCOL §5`). |
| **Does not apply** | Problems in a not-yet-live development/test environment (use the `PROTOCOL §9` defect flow); pure requirement changes (use the triage flow); the team's own orchestration-gateway failure (see `team/README.md §4 Recovery Handbook` — not a product incident). |

---

## 2. Severity Model

### 2.1 The three grading factors

**Level = blast radius × severity × duration**, plus **red-line factors** (**if any of data / money / security is hit ⇒ grade up to the higher level**).

| Factor | Criteria |
|---|---|
| **Blast radius** | All users / some users / a single point of users / no user-visible impact |
| **Severity** | Fully unavailable / severely degraded (core path failing) / mildly degraded (a workaround exists) / no functional impact |
| **Duration** | Confirmed elapsed time + estimated time-to-recovery; **>30min without mitigation ⇒ consider escalation** |
| **Red-line factors** | Data corruption or loss · money/transaction safety · credential leak / privilege escalation / intrusion · compliance risk ⇒ **at least S2, usually S1** |

### 2.2 Level definitions and deadlines

> Deadline basis: **working hours** Asia/Shanghai 09:00–23:00 (same as `PROTOCOL §15`); outside working hours S1/S2 respond immediately, S3/S4 may wait until the next working period. **ack** = acknowledge the incident and reply with its grading. **Mitigation target** = the deadline to restore service or degrade to an acceptable state (**stop the bleed first; root cause may follow**).

| Level | Criteria (any one suffices) | ack deadline | Mitigation target | Postmortem deadline |
|---|---|---|---|---|
| **S1 Severe** | Production **wholly unavailable**; **data corruption/loss**; **money/transaction anomaly**; **security event** (credential leak / privilege escalation / intrusion); an S2 not mitigated for >4h | **Immediately** (immediately inside working hours; also immediately outside working hours) | **≤30min** or fight continuously until recovery | **≤72h** |
| **S2 Major** | A core function unavailable or severely degraded (e.g. login failing, checkout failing, broad API 5xx); wide blast radius but a workaround path exists | **≤30min** | **≤4h** | **≤72h** |
| **S3 Minor** | Non-core function abnormal, performance degradation, single-point user impact, a clear workaround exists | **≤4h** | **≤24h** (or the next working day) | Recommended **≤1 week** |
| **S4 Trivial** | No user-visible impact or a negligible one (copy/style, alert noise, an internal-metric anomaly) | Routine (with the normal card flow) | Routine | Optional / batch into others |

> **Escalation is not optional**: any level missing its mitigation target within the deadline ⇒ **step up one level** (S4→S3→S2→S1), stating the reason and timestamp in the status update.

### 2.3 Grading examples

| Scenario | Level | Reason |
|---|---|---|
| The product's API returns global 5xx and users cannot place orders | **S1** | Fully unavailable + money/transaction involved |
| A DB connection failure makes positions/trades be **mispriced or lost** | **S1** | Data corruption + money |
| The shared identity/auth service is down; some tenants cannot log in | **S2** | Core path degraded, wide blast radius, a workaround exists (already-authenticated sessions still work) |
| A batch/strategy job's signals lag (widening delay) but it is still running | **S3** | Functional degradation, single-job impact, observable workaround |
| The release pipeline fails on a given tag and **the artifact is not published** | **S2** | Release incident, delivery channel affected |
| A typo in a product's documentation | **S4** | No functional impact |
| Credentials/keys are suspected leaked | **S1** | Security red line, escalate to the operator immediately |

> Grading is **dynamic**: re-grade at any time as blast radius/duration change, and leave a trail (see §4.4).

---

## 3. On-call / Duty

### 3.1 Duty rules

| Item | Content |
|---|---|
| **Who is on call** | First-response responsibility = the **on-duty engineering owner** (by default Linus, engineering side). The **sole channel facing the human = Elon** (`PROTOCOL §5`). |
| **Rotation** | The rotation schedule (who is on call, cycle length, timezone coverage, holiday rules) is **to be decided** (§8). Until it lands, the **default is Linus for engineering first response + Elon for coordination/reporting**. |
| **How to hand over** | Handover must be explicit: **open incidents and their grading / current status / actions taken / open items and next step / evidence paths**; the handover record lands in the incident card's `Progress` (append-only, timestamped). |
| **On-duty responsibilities** | ① **First response** (ack) ② **Grading** (per §2) ③ **Open/join the incident** (create or link the incident card and claim it) ④ **Broadcast** (status updates, see §4.4) ⑤ direct the mitigation ⑥ initiate the postmortem. |

### 3.2 Minimum actions executable by a single person (agent-team specialisation)

> Workers in this team have **no direct channel to the human** (`PROTOCOL §5`: only Elon faces the human), so **all outward incident notification goes through Elon**.

When only one person is online (no multi-person collaboration is possible), the **minimum-action list** (any S1/S2 first responder must complete) is:

1. **Immediate stop-the-bleed fallback**: if it is a rollback-able release/config change, revert via **forward edits** per `release-versioning-sop.md` (**destructive git is forbidden, `PROTOCOL §6`**); if a rollback is not possible, first **degrade / circuit-break / shed traffic**.
2. **Open the incident and leave a trail**: create or claim the incident card; record **symptom / first-seen time / blast radius / initial grading / actions taken**.
3. **Report back to Elon**: send back through the team message channel to Elon (conclusion first, `PROTOCOL §5`; keep it lean) — **this is the team's only human-notification path**. S1/S2 **report back immediately**; for money/security involvement **explicitly tag "recommend escalate to the operator"** in the report-back.
4. **Keep observing**: after recovery a **post-recovery health check is mandatory** (see §4.3 and the container-form basis in `PROTOCOL §9.3`); "I changed the config back" is **not** proof of recovery.
5. **Pending escalation**: if Elon is unreachable and it is an S1 (data/money/security), **do not wait silently** — the product-incident escalation still goes through Elon, **but Elon being unreachable is itself a team stall** ⇒ **switch to the `PROTOCOL §15.1` exception channel** (object switch, see §6).

---

## 4. Response and Escalation

### 4.1 Response flow (seven steps)

```
discover → triage → mitigate → locate → fix → recover → verify
    1        2         3          4      5     6        7
```

| Step | Basis | Owner | Landing point | Deadline |
|---|---|---|---|---|
| **1 Discover** | Sources = alerting / user feedback / patrol / CI. **Any suspected production anomaly opens the incident flow**; do not first self-certify it as "a one-off" | First discoverer | Alerting system (`runtime-observability-sop.md`) / manual | Immediate |
| **2 Triage** | Grade per §2's three factors + red-line factors; record the first-seen time | On-duty owner | Incident card | Within ack deadline |
| **3 Stop-the-bleed / mitigate** | **Restore service first, root cause after**; prefer rollback / degrade / circuit-break / shift traffic | On-duty owner (Elon coordinates) | Manual + release rollback plan | S1 ≤30min / S2 ≤4h |
| **4 Locate** | After mitigation, locate the trigger and root cause; read-only investigation (logs / metrics / traces) | Relevant worker | Observability stack (`runtime-observability-sop.md`) | By level |
| **5 Fix** | Fix via forward edits; **destructive git is forbidden (`PROTOCOL §6`)**; the fix must pass tests (`PROTOCOL §6.1`) | Relevant worker | CI (tests / gates) | By level |
| **6 Recover** | Deploy the recovery and declare "service restored" | On-duty owner | Release channel (`release-versioning-sop.md`) | — |
| **7 Verify** | **Post-recovery health check**: metrics back to baseline, key paths exercised live, alerts resolved | On-duty owner | CI (health check) + manual | Immediately after recovery |

> **Mitigate-first principle**: **restore service first, root cause after**. Do not do a large refactor or an "incidental root-cause fix" while the incident is in progress; root cause is left to the postmortem and follow-up cards (out-of-scope discoveries are not fixed on the side).

> **Rollback discipline**: when a revert is needed, always use a **forward-edit commit**, or `rm` plus a normal commit (`PROTOCOL §6`); **forbidden**: `rebase` / `reset` / `restore` / `stash` / `clean` / `revert` / `checkout --` / `push --force`. Rollback-plan details are in `release-versioning-sop.md`.

### 4.2 Escalation paths and thresholds

| Category | Path | Escalation threshold | Deadline |
|---|---|---|---|
| **Technical** (service / code / config / dependency) | Relevant worker → **Elon** (`PROTOCOL §5`: workers do not go outward directly or bypass Elon) | From S2, Elon's coordination is required; an S2 **not mitigated ≤30min after ack** ⇒ escalate to Elon for reinforcements | Within ack |
| **Business / money / security** | **Elon → the operator** (`PROTOCOL §5 / §15`: only Elon escalates to the operator) | **A red-line factor hit (data / money / security) escalates immediately regardless of level**; S1 immediately | Immediate |
| **Cross-system / cross-project** | Worker → Elon → the relevant product owner | Impact on ≥2 deliverables or involvement of a shared service (e.g. a shared identity service or database) | S1 immediate / S2 ≤30min |
| **Team stalled** (not a product incident) | **Switch to the `PROTOCOL §15.1` exception channel** (coordinator idle >6h) | This is the switch point between product-incident escalation and `PROTOCOL §15.1` (see §6) | Per `PROTOCOL §15.1` |

> **Escalation is notification**: record every escalation in the card's `Progress` (target / time / reason / expected action).

### 4.3 Recovery confirmation (must not be skipped)

- **Basis**: a service that "looks fine" ≠ recovered. Recovery requires **reproducible evidence** (command + output / metric screenshot / key path exercised live).
- **Responsibility**: the on-duty owner produces the evidence; Elon gives the final sign-off that the incident can be closed.
- **Landing point**: CI health check + manual. Under a container/orchestration form, exercise the key paths live in the **target runtime form** per `PROTOCOL §9.3` (`127.0.0.1` ≠ the host; cross-container addresses must be proven reachable).
- **Deadline**: verify **immediately** after the recovery declaration; if verification fails ⇒ the incident is not closed, return to §4.1 step 3.

### 4.4 Communication

| Communication type | Basis | Owner | Landing point | Cadence |
|---|---|---|---|---|
| **Internal status update** | Conclusion first: **current level / blast radius / actions taken / next step / ETA to recovery**; keep it lean (long logs land only in the workspace) | On-duty owner | Incident card `Progress` (append-only, timestamped) | S1 every **15–30min**; S2 every **1h**; S3/S4 at key points (ack / mitigate / recover) |
| **External communication** (users / public / customers) | **Always through Elon** (`PROTOCOL §5 / §5.1`); workers **must not** publish or promise directly | Elon (escalating to the operator when needed) | Public release channel (`PROTOCOL §5.1`: approval + trail) | Before recovery, **be conservative**: state only confirmed facts and a known ETA range, never speculate on root cause |
| **Cross-project / cross-role broadcast** | Relayed uniformly through Elon; workers do not dispatch to each other (`PROTOCOL §5`) | Elon | task / message | Immediately on escalation or when blast radius widens |

> **External-messaging discipline**: incident wording **does not blame, does not speculate on root cause, does not promise an uncontrollable time**; nothing goes outward without Elon's approval (`PROTOCOL §5.1` forbidden items).

---

## 5. Postmortem

### 5.1 Principles and deadlines

| Item | Content |
|---|---|
| **Principle** | **Blameless**: the postmortem targets the **system and process**, not individuals; the goal is "why did the system allow this incident, and how do we make it harder to recur". |
| **Deadline** | **S1/S2 ≤72h** (working days, counted from incident closure); S3 recommended ≤1 week; S4 optional/batchable. |
| **Trigger** | Any S1/S2 is mandatory; S3 recommended; S4 optional. |
| **Responsibility** | The postmortem host = the on-duty owner (usually Linus); Elon reviews it and drives the action items to completion. |
| **Landing point** | A team-level `postmortem.md` in the incident workspace, or the relevant product's `docs/` for a product-level postmortem (`PROTOCOL §12`). |

### 5.2 Postmortem template (fields)

1. **Metadata**: incident ID / level / start and end times / grading and re-grading record / host and participants.
2. **Timeline**: `time | event | action | result` — covering the whole chain **first-seen → discover → ack → mitigate → recover → close**.
3. **Impact**: blast radius (users/tenants/transaction volume), duration, **data/money/security** consequences, whether reversible.
4. **Root cause**: proximate cause + systemic root cause (trace at least to "which line of defence should have caught this and did not").
5. **Trigger**: what change/condition triggered it (a release? a config? an external dependency? traffic?).
6. **Why not detected earlier**: is it **no monitoring/alerting**, **alerting that did not fire on the threshold**, or **an alert nobody watched** — judge each.
7. **What went well / what went poorly**: was the mitigation fast enough, was recovery confirmation sufficient, was communication adequate.
8. **Action items**: each with **action / owner / deadline / landing point (CI / check-all / hook / manual) / verification method**. **An action item without an owner or without a deadline counts as undefined.**
9. **Doc and gate updates**: the list of guides / check-all / CI gates to backfill (see §5.3).
10. **Attachments**: evidence paths (logs, metrics, command output) — land them only in the workspace or the product's `docs/`.

### 5.3 Action-item flow and backfill

- **Turn into task cards**: postmortem action items are **turned into cards by Elon** (workers do not create cards, `PROTOCOL §5`); engineering defects go to the `PROTOCOL §9` repair-and-regression loop. An action-item card must reference the postmortem file path.
- **Backfill (`PROTOCOL §12` two-way doc sync)**: if the root cause exposes a **SOP gap / gate gap** ⇒
  - update the relevant guide (this file, `release-versioning-sop.md`, or `runtime-observability-sop.md`);
  - add `check-all` / CI gates (**machine-checkable items land as scripts, `PROTOCOL §20.1`**; **not-machine-checkable items become manual and must not be falsely claimed as gated, `PROTOCOL §20.2`**);
  - references use only "`"<document name>" §<section name>` / `PROTOCOL §<n>`", **never line numbers** (`PROTOCOL §6.1`).
- **Closure**: a postmortem with un-landed action items ⇒ may not be treated as "postmortemed"; Elon's patrol tracks it until the action items are complete.

---

## 6. Interfaces with Other SOPs

| Scenario / need | Where it goes | Note |
|---|---|---|
| Release action, version number, changelog, **rollback plan** | `release-versioning-sop.md` | Incident mitigation often needs a rollback ⇒ follow its forward-edit revert plan (obeying `PROTOCOL §6`) |
| Monitoring / logs / metrics / **alert discovery** / health checks / patrol | `runtime-observability-sop.md` | An incident's "discovery" and "why not detected earlier" depend on its basis |
| Team collaboration **wait timeout** / **team stalled** | `PROTOCOL §15 / §15.1` | **Different objects** — see §0 (collaboration process vs team-orchestration stall); the worker→operator exception report is `PROTOCOL §15.1` |
| Code-defect repair and the regression loop | `PROTOCOL §9` | An incident's root-cause fix goes through the defect flow |
| Container-form acceptance / post-recovery health check | `PROTOCOL §9.3` | Recovery confirmation must be exercised live in the target runtime form |
| Confirmation gate (major / money-security escalation to the operator) | `PROTOCOL §14` | Interlocks with the §4.2 escalation paths |

> 🔀 **SOP switch criterion (one line)**: **a fault in production/the deliverable ⇒ this SOP; collaboration stuck ⇒ `PROTOCOL §15`; orchestration stalled ⇒ `PROTOCOL §15.1`.**
> ⚠️ These can **chain**: a product-incident escalation needs to go through Elon, **but Elon being unreachable is itself a team stall** ⇒ that segment switches to the `PROTOCOL §15.1` exception channel (the **technical handling** of the product incident still follows this SOP).

---

## 7. Landing Points (product-agnostic)

> The mechanism above applies to **any delivered product or service**; only the landing points vary, and they must never weaken the severity model or the recovery-confirmation bar.

| Aspect | Landing point (choose per product) |
|---|---|
| **Services with a production runtime** (e.g. a long-running API, a database, a queue, a shared service) | **Manual** (service handling) + **CI re-verification** (target-form health check, `PROTOCOL §9.3`). Recovery confirmation must prove cross-container addresses are reachable. Data/money red lines are dense here. |
| **Batch / strategy jobs** (e.g. a scheduled job, a signal/risk pipeline) | **Manual** (job handling / circuit-break) + **check-all** (gate re-verification, `PROTOCOL §20.1`). A job anomaly may be circuit-broken/stopped to mitigate before locating the cause. |
| **Product with no production runtime** (e.g. a public repo/library with only a CI/CD channel) | **CI** does the **post-recovery health check** (`PROTOCOL §9.3` container form, CI consistent with local) + **manual** judgement. The main incident form is a **release/CI incident** (pipeline failed, artifact not published, tag misplaced); S1 is unlikely, but release incidents still apply (mostly S2/S3). |

> **Unified basis**: for **every** product, **recovery confirmation** requires "exercised live in the target runtime form + evidence on disk" (`PROTOCOL §9.3`); a **red-line factor (data / money / security)** hit ⇒ **top severity and immediate escalation to the operator**, never discounted because a product is small.

---

## 8. Open Items (undecided; defaults in force until decided)

1. **On-call rotation schedule** — who is on call, cycle length, timezone coverage, holiday rules are **to be decided**; default until then: Linus (engineering first response) + Elon (coordination/reporting) (§3.1).
2. **On-call tooling, duty channel, alert-delivery path** — **to be decided** (to be closed together with `runtime-observability-sop.md`) (§3.1).
