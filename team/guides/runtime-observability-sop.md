# Runtime Observability SOP (runtime-observability-sop.md)

> **Ownership**: `R-OBS-1` (runtime observability). This file is the **method library** that details that clause; the clause holds the normative mechanism and this file **references it, does not copy it** (`R-LAYER-1`).
> **Maintainer**: **Linus** (engineering — lands the runtime-observability implementation). **Elon** owns `R-OBS-1` (the normative rule); convention changes flow through him.
> **Depends on / referenced clauses**: `R-ENG-1` (engineering quality standards) · `R-CONTAINER-1` (container-form acceptance) · `R-DOCSYNC-1` (two-way document sync) · `R-SLA-1` (SLA/timeout) · `R-SLA-7` (team-stalled exception channel) · `R-LAYER-1` (document layering / no verbatim copying) · `R-GATE-1` (machine-checkable gates) · `R-GATE-2` (not machine-checkable) · `R-OBS-1` (runtime observability — the rule this SOP details) · `R-INCIDENT-1` (product incident response — the alert→incident handoff) · `R-PERF-1` (performance/SLA).
> **Sibling guides (reference, do not copy)**: `incident-response-sop.md` (product incident response) · `release-versioning-sop.md` (release / rollback) · `performance-sla-sop.md` (SLO / thresholds) · `ci-release-sop.md` (CI gate / build / release / deploy).
> **Scope**: the **runtime observability of the delivered product/service** — logging / metrics / alerting / health checks / inspection. Cross-role mechanisms are referenced from the rules, never copied.
> **Reference convention**: always write "`document name §section name`" or "`R-<DOMAIN>-<n>`"; **no line-number anchors and no card-number anchors**.

---

## 0. Key Distinction (read first — do not confuse with the team's own handbook)

> ⚠️ **The object of this SOP = the runtime observability of the delivered product/service (product-level).**
> It is **not** the team's own gateway recovery handbook (that is `team/README.md §4 Recovery Handbook`: worker stuck / double-run / gateway restart losing dispatches / broken config / broken human-channel routing).

| Dimension | This SOP (product-level runtime observability) | Team's own gateway handbook (`team/README.md §4`) |
|---|---|---|
| **Object** | The **product/service runtime** delivered to users (e.g. a long-running service, a batch/strategy job) | The team's own **gateway / worker / session** runtime |
| **Goal** | Make the product's **logs / metrics / alerts / health** observable/reviewable | Let **team collaboration** recover from stuck / restart / config corruption |
| **Owner** | The product **on-call** (see `incident-response-sop.md`) | Team worker self-healing + operator patrol + the team-stalled exception channel (`R-SLA-7`) |
| **Failure signal** | Silent alerts, distorted metrics, false-positive health probes | Stale heartbeat, double-run, poll stalled |

Likewise, **product incident** response is governed by `incident-response-sop.md`; it is a **different object** from `R-SLA-7` (the team-stalled exception channel) and the two **must not substitute for each other**.

**Normative clauses (`R-OBS-1`)**:
1. **JSON logs + redaction** — structured logs; secrets and personal data are redacted before they are written.
2. **Metrics** — the minimal set with stable names and units; dashboards are derived, not hand-maintained.
3. **Alerts** — every alert is executable: a concrete action, an owner and a due point; silence windows and dedup are explicit.
4. **Health** — separate health / liveness / readiness probes; a probe must not report green when the dependency it checks is unavailable.
5. **Inspection** — a documented read-only inspection convention for the on-call.
6. **Object separation** — product runtime observability is not the team's own gateway handbook and not `R-SLA-7`.

---

## 1. Scope and Boundaries

| Item | Content |
|---|---|
| **Do** | Define the minimal convention and landing points for product-level **logging / metrics / alerting / health checks / inspection**; give the applicable convention for both **long-running services** and **batch/strategy jobs** |
| **Do not** | Do not define the team's own gateway recovery (`team/README.md §4 Recovery Handbook`); do not define product release/rollback (`release-versioning-sop.md`); do not define incident grading / on-call rota / retro (`incident-response-sop.md` — this file only **hands off** to it) |
| **Handoff** | Alert fires → incident response (`incident-response-sop.md`); metric thresholds and monitoring-stack selection → decision owner (**to be decided**, §8); machine-checkable gate landing points follow `R-GATE-1` |

### 1.1 Convention / ownership / landing point (file-level)

> Each section below previously restated its own "convention / ownership / landing point" block; consolidated here. A section says inline where it genuinely differs.

| § | Convention | Ownership | Landing point |
|---|---|---|---|
| §2 Logging | Structured JSON lines; unified fields; unified wrapper; redaction | Product owner (engineering lands the implementation); on-call readability | CI (schema lint, §2.4) + hooks (no bare `print`) + manual (inspection spot-check) |
| §3 Metrics | Minimal metric set + naming convention (prefix + unit) | Product owner; metric convention maintained by Linus | CI (naming lint, optional) + manual (dashboards / inspection); collection stack **to be decided** (§8) |
| §4 Alerting | Grading + executable + inhibition/dedup + silence windows / on-call | On-call (hands off to `incident-response-sop.md`); rules maintained by Linus | Monitoring stack (**to be decided**, §8) + manual (silence-window approval, on-call handover) |
| §5 Health Checks | Separate `/health` (liveness) from `/ready` (readiness) | Product owner (engineering) | CI (container verification — the sole source of truth) + hooks/orchestrator (compose healthcheck) + manual |
| §6 Inspection | Routine checklist: period / item / criterion / owner / trail | Product on-call (executes) + operator patrol (spot-checks) | Mostly manual; items that can be machine-checked are folded into CI/hooks (`R-GATE-1`) |

---

## 2. Logging

### 2.1 Structured convention (JSON lines)

- **Format**: **one JSON object per line** (JSON lines / NDJSON); **multi-line stack traces mixed into the stream are forbidden** (put the stack inside a field value, escape the newlines).
- **Reason**: directly parseable by collectors / `grep` / `jq`, keeping one troubleshooting method stack-wide.

### 2.2 Levels and use

| Level | Use | Emitted by default |
|---|---|---|
| `error` | Request/task failure, dependency unavailable, needs human intervention | Yes |
| `warn` | Degradation, retry, approaching threshold (non-fatal) | Yes |
| `info` | Key business milestones (start / stop / task completion) | Yes |
| `debug` | Troubleshooting detail (off by default, on demand) | **No** (must be explicitly enabled) |

- **Forbidden**: using `error` as `info` (noise drowns the alerts); logging business data at `debug` so it never appears in production (leaves troubleshooting without evidence).

### 2.3 Required fields (minimal set)

| Field | Description | Example key |
|---|---|---|
| Timestamp | ISO8601 / with timezone | `ts` |
| Service name | The service/component producing the log | `service` |
| Environment | dev / staging / prod | `env` |
| Request or task id | Correlation id for one request/task | `request_id` / `task_id` |
| Trace id | Cross-service trace id | `trace_id` |
| Level | `error` / `warn` / `info` / `debug` | `level` |
| Message | Human-readable description (no sensitive data) | `msg` |

> Missing any required field ⇒ the log is **non-conforming** (unsearchable / uncorrelatable / unreviewable).

### 2.4 No bare `print` / temporary formats (unified logging wrapper)

- **Forbidden** to call `print()` / `console.log()` / build ad-hoc strings directly in code — all output goes through the **unified logging wrapper** (a per-service logger).
- **Reference**: `R-ENG-1` (engineering quality standards) sets the delivery hard gate; raising "unified logging wrapper" to normative text is a normative mechanism — `R-OBS-1` owns it, this file only points at it (`R-LAYER-1`).
- **Pre-submit self-check** (may be merged into the code-review checklist):
  - [ ] **Wrapper**: all output goes through the unified logger — no bare `print` / `console.log`
  - [ ] **Fields**: contains all required fields (§2.3)
  - [ ] **Redaction**: contains no secret / token / PII (§2.6)

### 2.5 Rotation and retention

- **Rotation**: trigger on **both size and time** (a single file cannot fill the disk); rotated files may be compressed/archived.
- **Retention**: **to be decided** (per product data volume and compliance requirements; §8). Until decided, apply the floor: **cover at least one review/retro window**.
- **Landing point**: rotation config ships with the product deployment; the retention policy is a **to-be-decided** item.

### 2.6 Redaction of sensitive information (hard rule)

- **Must not enter logs**: secrets, tokens / credentials, PII.
- **Method**: the wrapper centrally applies a **field whitelist + value-level redaction** (e.g. a token keeps only the first and last 4 characters); dumping a whole request body / config object is forbidden.
- **Determination**: a log review that fails the "redaction" check (§2.4, third check) ⇒ **must not be delivered**.

---

## 3. Metrics

### 3.1 Minimal metric set (all long-running services)

| Category | Metric | Purpose |
|---|---|---|
| Request volume | Request count / QPS (by endpoint, by status code) | Load and error surface |
| Latency | **p50 / p95 / p99** (distribution, not mean) | User experience and SLO |
| Error rate | 5xx share / business failure rate | Health |
| Saturation | CPU / memory / connection-pool occupancy | Capacity and bottlenecks |
| Queue depth | Backlog of pending tasks/messages | Back-pressure warning |
| Key business volume | Core business counts (e.g. tasks created/completed) | Business health |

> Policy: **use quantiles (p50/p95/p99) for distributions, not averages** (averages mask the long tail).

### 3.2 Naming convention (prefix + unit)

- **Structure**: `<service>_<subsystem>_<metric>_<unit>` (Prometheus-style).
- **Fixed unit suffixes**: time `_seconds`; size `_bytes`; count `_total` (a monotonic counter).
- **Forbidden**: multiple names for the same semantic; bare numbers without a unit; using a gauge as a counter.

### 3.3 Collection and exposure

- **Method**: **to be decided** (e.g. Prometheus / OpenTelemetry / …; §8).
- **Tool-independent convention**: metrics must be **programmatically scrapeable** (e.g. a `/metrics` endpoint or OTLP export) — they must **not** exist only as log text.

---

## 4. Alerting

### 4.1 Grading and routing

| Level | Semantics | Response | Routing |
|---|---|---|---|
| **P1 / critical** | Service unavailable / data error / wide impact | Immediate (page on-call) | On-call (escalation target per §4.2) |
| **P2 / warn** | Degradation / approaching threshold / partial failure | Respond in working hours | On-call or product owner |
| **P3 / info** | Informational / deferrable | Handled in the inspection roll-up | Inspection checklist (§6) |

> Thresholds and specific routing targets: **to be decided** (must combine SLO and capacity baselines; §8).

### 4.2 Alerts must be executable (hard requirement)

**Every alert must carry all five elements**; missing one means it must not ship:

| Element | Description |
|---|---|
| **Trigger condition** | An explicit decision expression (e.g. "5xx share > X% within 5 min") |
| **Threshold** | A concrete value/range (**to be decided** where not yet set — use a placeholder until then; §8) |
| **Impact** | What it will cause (user-visible / internal) |
| **First action** | The on-call's first handling step (runbook pointer) |
| **Escalation target** | When and to whom it escalates (the escalation chain in `incident-response-sop.md`) |

> Anti-pattern: only reporting "XX is abnormal" with no action = an **unexecutable alert**, treated as noise.

### 4.3 Inhibition and deduplication (prevent alert storms)

- **Deduplication**: multiple alerts from one root cause aggregate into one (aggregate by `service` + root-cause dimension).
- **Inhibition**: when an upstream fault occurs, **inhibit** the downstream correlated alerts (avoid an avalanche of noise).
- **Storm threshold**: if the alert count per unit time exceeds a limit ⇒ automatically degrade to a roll-up notification and trigger human investigation.

### 4.4 Silence windows and on-call

- **Silence window**: during planned maintenance / known changes, silence the corresponding alerts for the window; **a trail is mandatory** (who opened it, why, when it closed) — never let "silence" mask a real fault.
- **On-call**: the on-call rota and handover convention **belong to `incident-response-sop.md`** (this file only hands off; it does not redefine them).
- **Distinct from the team's own**: this on-call is **product** production on-call; it is **not** the team's worker heartbeat/poll patrol (the latter is `team/README.md §4 Recovery Handbook` and `R-SLA-1`).

---

## 5. Health Checks (health / liveness / readiness)

### 5.1 Endpoint semantics (★ stated explicitly)

| Endpoint | Semantics | What it checks | Meaning of failure |
|---|---|---|---|
| `/health` (**liveness**) | The process is still running and can respond | The process itself only (does **not** check external dependencies) | **Restart** the instance |
| `/ready` (**readiness**) | Can take traffic | **Dependencies available** (see §5.2) | **Remove** from traffic; do not restart |

> Anti-pattern: putting dependency checks into `/health` (a dependency blip triggers a restart → amplifies the blip); using `/ready` as a liveness probe (a readiness failure causes a spurious restart).

### 5.2 Readiness check content

| Dependency | Check point |
|---|---|
| DB | Connection alive + a simple query round-trip |
| Queue | Can produce / can consume |
| Upstream dependency | Key upstream reachable (mind **in-container address semantics**, `R-CONTAINER-1`) |
| Disk | Free space ≥ threshold |
| Clock | Clock skew within tolerance |

### 5.3 Probe cadence and timeout

- **Knobs**: `interval` (probe interval) / `timeout` (per-probe timeout) / `retries` (consecutive failures) / `start_period` (startup grace).
- **Convention**: `timeout` must be smaller than `interval`; `start_period` must cover cold start, so a slow boot is not misjudged as a failure.
- **Illustrative example** (generic): `interval: 5s`, `timeout: 3s`, `retries: 12`, `start_period: 5s` ⇒ the service should turn `healthy` within a bounded window (order of a minute). Adjust to the real service.

### 5.4 Example landing points (generic, reusable)

- **Landing point A — CI (sole source of truth)**: the repo's container verification entry (`docker/verify.sh` / `docker/verify-in-container.sh`) is the **sole source of truth** for the repo's "healthy". CI and the local verification call **the same script** ⇒ local green = CI green. It is reusable as a pre-/post-release health check (`R-CONTAINER-1`).
- **Landing point B — hook / orchestrator**: a compose `healthcheck` on the long-running service:
  - `test` = an in-container `fetch('http://127.0.0.1:<port>/health')` (**in-container loopback**, matching `R-CONTAINER-1` address semantics);
  - `interval` / `timeout` / `retries` / `start_period` ⇒ the service should turn `healthy` within a bounded window;
  - the healthcheck is a **contract**: it must keep passing from the skeleton all the way to the real implementation (not relaxed because the implementation changed).
- **Task-completion criterion**: after bringing the stack up (`docker compose up -d --build`, or equivalent), the long-running service reaches `healthy`.
- **Metrics / alerts**: **to be decided** (a monitoring stack may not exist yet — health probes only; §8).

---

## 6. Inspection Convention

### 6.1 Routine inspection checklist (template)

| Period | Check item | Criterion | Owner | Trail |
|---|---|---|---|---|
| Daily | Health endpoints `/health`, `/ready` | All green | Product on-call | Inspection record (time / conclusion) |
| Daily | Error-log overview | No new P1-level error cluster | Product on-call | Record anomaly summary |
| Weekly | Key metrics (latency quantiles / error rate / queue depth) | Within thresholds, no degrading trend | Product owner | Metric snapshot |
| Weekly | Alert effectiveness | No "unexecutable alerts" / no long silence masking a fault | On-call + owner | Alert-list review |
| Monthly | Log rotation / retention | No disk alert; retention policy matches the decision | Product owner | Conclusion |

Reusable checklist form:

- [ ] Daily: `/health` and `/ready` all green (trail: time / conclusion)
- [ ] Daily: no new P1-level error cluster in the error log
- [ ] Weekly: key metrics within thresholds, no degrading trend (snapshot kept)
- [ ] Weekly: no unexecutable alerts, no long silence masking a fault
- [ ] Monthly: log rotation healthy, retention policy matches the decision

> Criteria must be **decidable** (clear green / yellow / red) — "looks about right" is not allowed.

### 6.2 Relationship to the team check-all gate (★ stated explicitly — different objects)

> The **team check-all gate** = the **team-side gate aggregator**; its object is **shared-area and protocol consistency** (redline-block consistency / terminology abstraction / §-reference resolvability / card schema / contract tests / prototype gate / archive dry-run), landing point `R-GATE-1`.
> **Product inspection ≠ team check-all**:

| | Object | Content | Executor |
|---|---|---|---|
| **Product inspection (this section)** | The product **runtime** | Health / logs / metrics / alerts | Product on-call / owner |
| **Team check-all** | Shared-area / protocol **consistency** | Docs / lint / schema / contract | The team (operator patrol aggregation) |

> The two **must not be merged or substituted for each other**: check-all green ≠ product healthy; product healthy ≠ protocol-consistent. Product-inspection items that **can be machine-checked** may land in CI/hooks, but **must not be folded into the team check-all gate**.

---

## 7. Applicability and Landing Points by Runtime Shape

> Ownership summary: the product owner lands the engineering; convention decisions go through the rule owner (Elon).

| Runtime shape | Applicability | Landing point (CI / team check-all / hooks / manual) | Notes |
|---|---|---|---|
| **Long-running service** | Full model (§2–§6) | **CI**: container verification = sole health source of truth (reusable for pre-/post-release health check); **hooks/orchestrator**: compose `healthcheck`; **metrics/alerts**: **to be decided** | Health probe exists and is a contract; logs/metrics/alerts may still need building out; if no monitoring stack exists yet, metrics/alerts are the **biggest gap** |
| **Batch / strategy job (not a long-running service)** | Partial | **manual + team check-all** | Observability is mainly **run logs** (§2) + **result-artifact verification**; the output artifacts do **not** enter version control but a **run snapshot may be kept** for review; there is no long-running service ⇒ the §5 liveness/readiness probe semantics do **not** apply. Landing point = manual + the team check-all gate (which only covers shared-area consistency, not product runtime — §6.2) |

---

## 8. Open Items (undecided; defaults in force until decided)

1. **Log retention policy** — **to be decided** (per product data volume and compliance); floor until then: cover at least one review/retro window (§2.5).
2. **Metric collection stack / exposure method** — **to be decided** (e.g. Prometheus / OpenTelemetry); metrics must stay programmatically scrapeable, never log-text-only (§3.3).
3. **Alert thresholds and specific routing targets** — **to be decided** (must combine SLO and capacity baselines); where a threshold is not yet set, use a placeholder until then (§4.1 / §4.2).
4. **Metrics / alerts monitoring stack** — **to be decided** (a monitoring stack may not exist yet — health probes only) (§5.4 / §7).
5. **Metric naming lint in CI** — optional; to be decided (§3).
