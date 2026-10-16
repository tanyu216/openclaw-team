# Performance / SLA Baseline SOP (performance-sla-sop.md)

> **Status**: official · the *mechanism* is owned by `PROTOCOL §㉗` (L1, normative); this file is the L2.5 execution detail.
> **Ownership / Maintainer**: **Linus** (engineering — owns the method, the baseline artifact and the acceptance process). **Elon is the sole writer of L1** and adjudicates the *values* (thresholds, SLA/SLO numbers) that land in `PROTOCOL §㉗`.
> **Depends on**: `PROTOCOL §⑥.1` (engineering quality standards) · `§⑨.3` (container-form acceptance) · `§⑫` (two-way document sync) · `§⑮` (SLA / timeout — a **different object**, see §0 and §1) · `§⑰` (doc layering / no verbatim copying) · `§⑳.1` (machine-checkable gates) · `§⑳.2` (not machine-checkable) · `§㉑` (release & versioning) · `§㉒` (runtime observability — **owns metric naming**) · `§㉗` (performance / SLA baseline — the L1 clause this SOP details).
> **Sibling guides**: `runtime-observability-sop.md` · `release-versioning-sop.md` · `incident-response-sop.md` · `ci-release-sop.md`.
> **Scope**: this file = the **L2.5 method library** for *product-level performance / SLA·SLO baseline definitions and performance acceptance*. Cross-role mechanisms are **referenced, not copied**, from L1 and the sibling guides.
> **Reference convention**: always write "document name §section name" or "`PROTOCOL §<n> <name>`" — **no line-number anchors, no card-number anchors**.

---

## 0. Object Declaration (read first — do not confuse with neighbouring SOPs)

> ⚠️ **The object of this SOP = the performance-metric baseline of the delivered product/service, its external SLA / internal SLO definitions, and its acceptance at release / regression / capacity change.**
> It is **not** the construction of the run-time monitoring stack (collection / dashboards / alert rules / on-call) — see `runtime-observability-sop.md`. It is **not** online incident grading and response — see `incident-response-sop.md`.

| Dimension | **This SOP (performance / SLA baseline)** | `runtime-observability-sop.md` | `incident-response-sop.md` |
|---|---|---|---|
| **Object** | Critical-path **performance thresholds** and **SLA/SLO targets**; **pre-release performance acceptance** | The product's **run-time** logs / metrics / alerts / health / patrol | Online **incident** grading / on-call / escalation / post-mortem |
| **Timing** | **Before delivery** (release / regression / capacity change) | **Run time** (continuous) | **Failure time** (response / post-mortem) |
| **Output** | Thresholds, baseline file, acceptance criteria | Collection definitions, the five actionable elements of alerts | Incident ticket, post-mortem, action items |
| **Linkage** | Metric **naming and units reference `PROTOCOL §㉒`** (does not copy it); thresholds are the **input** to that guide's alert thresholds | Alert fires → incident response | Post-mortem action items **backfill** this baseline |

**Unified method (file-level; every section below is under it)**: every baseline answers three questions — **Definition** (how the metric is defined, threshold, pass criteria — carried inline in each section), **Responsibility** (who maintains / adjudicates / accepts), **Landing point** (which concrete target it lands on: CI / check-all / hook / human). Responsibility and Landing point are consolidated here and not restated per section:

| Section | Responsibility | Landing point |
|---|---|---|
| §1 Scope | Linus (definitions and engineering landing points); Elon (threshold/numeric adjudication and integration into L1) | **CI** (benchmark script + threshold assertion) / **check-all** (baseline file present/format) / **human** (path selection, numeric adjudication, regression adjudication) |
| §2 Critical path | Linus proposes the candidate list; Elon / the product owner adjudicates "which count as critical" | the list lands in the baseline file (the `paths[]` of §6 `perf-baseline.json`); list changes go through the confirmation gate |
| §3 Metric definitions | metric definitions maintained by Linus; numeric thresholds adjudicated by Elon / the project decision (see §9.3) | CI (benchmark-script output + optional naming lint) / human (threshold adjudication) |
| §4 SLA vs SLO | the SLO is proposed by Linus and adjudicated by Elon; the **external SLA commitment is decided by the operator** (the external-facing owner) | human (numeric adjudication, confirmation gate); SLI collection belongs to `PROTOCOL §㉒` |
| §5 Performance acceptance | Linus produces the test and the evidence; Turing verifies the test's authenticity and scenario fidelity (`PROTOCOL §⑥.1`); Elon gives final sign-off | CI (benchmark script + threshold assertion) / human (acceptance adjudication) |
| §6 Baseline management | Linus maintains the baseline file; Elon adjudicates "whether a degradation is acceptable" (a human judgement, §7) | the file is committed (product repo); check-all validates presence/format; CI does the threshold assertion |

---

## 1. Scope and Boundaries

**Definition**: define critical-path performance metrics, SLA/SLO baseline, the performance-acceptance process and its landing points (Responsibility / Landing point → the §0 table).

| Item | Content |
|---|---|
| **Does** | ① identify critical user paths and their baseline metrics; ② metric definitions (latency percentiles / throughput / error rate / saturation / concurrency·queue); ③ SLI vs SLO vs SLA definitions and error budget; ④ performance-acceptance definitions (when / how / pass criteria / environment); ⑤ baseline management and regression comparison; ⑥ per-workload-profile definitions and landing points |
| **Does not** | **Does not** build the run-time alerting/monitoring stack (collection, dashboards, alert rules, on-call) — that belongs to `runtime-observability-sop.md` (reference its sections, do not copy); **does not** change incident grading / on-call / escalation / post-mortem — that belongs to `incident-response-sop.md`; **does not define** the team's *own* gateway SLA — `PROTOCOL §⑮` is the **team-internal timeout/escalation table**, a **different object** from this SOP's "product external SLA" and **not interchangeable** |
| **Handoff** | Baseline thresholds → **input** to the alert thresholds of `runtime-observability-sop.md`; performance regression → route through the defect loop (per the engineering quality standards, `PROTOCOL §⑥.1`); undecided values → confirmation gate before the decision fork (**to be decided**); machine-checkable gates are registered per `PROTOCOL §⑳.1`, non-machine-checkable items are labelled `§⑳.2` |

> **Key distinction**: `PROTOCOL §⑮` (SLA / timeout escalation table) governs **team-collaboration wait times** (e.g. blocked-pending-clarification ≤ 2h, confirmation gate ≤ 4h). The SLA in *this* file governs the **product's external availability and performance commitments**. They share the word "SLA" but have **different objects** — always name the document when referencing, never conflate them.

---

## 2. Critical-Path Identification

**Definition**: a critical path = a **critical user main path** (the minimal end-to-end call sequence a user must traverse to complete the core business). Path identification reuses the **end-to-end critical path** definition of `PROTOCOL §⑨.3` (e.g. "login ⇒ obtain token ⇒ access a protected endpoint"), because that clause already makes the "real user main path" a mandatory verification object of container-form acceptance; **this SOP uses it as the main-path baseline** and does not invent a second one. (Responsibility / Landing point → §0.)

### 2.1 Generic shape of a critical path (template)

| Step | Description | Typical baseline metrics |
|---|---|---|
| ① Login / auth | User identity established (incl. OIDC/token acquisition) | end-to-end latency percentiles, error rate |
| ② Token fetch / refresh | Credential acquisition and refresh | latency percentiles, failure rate |
| ③ Core business read | Primary query (list / detail / market data / positions, etc.) | latency percentiles, throughput, cache hit |
| ④ Core business write | Order / task creation / status change — a **side-effecting** path | latency percentiles, error rate, **data-consistency assertion** |
| ⑤ Result read-back / push | Confirm write-then-visible (incl. WebSocket/polling read-back) | end-to-end latency, **eventual-consistency delay** |

### 2.2 Mandatory baseline metrics per path (six-tuple)

Every critical path registers **at least** the following six items in the baseline file (definitions in §3):

1. **Latency**: p50 / p95 / p99 (**averages forbidden**);
2. **Throughput**: QPS / RPS (target tier + peak tier);
3. **Error rate**: 5xx share / business failure rate;
4. **Saturation**: CPU / memory / connection-pool usage;
5. **Concurrency / queue depth**: concurrency tiers and backpressure ceiling;
6. **Sample definition**: dataset, concurrency tier, warm-up and sampling window (§5.2).

---

## 3. Metric Definitions (hard requirements)

**Definition**: **the naming and unit convention is identical to `PROTOCOL §㉒` (runtime observability, which owns it)** — `<service>_<subsystem>_<metric>_<unit>` (time `_seconds`, size `_bytes`, count `_total`). This file **references that clause, it does not copy the wording**. Details of collection are in `runtime-observability-sop.md`. (Responsibility / Landing point → §0.)

### 3.1 Latency — **percentiles, not averages**

| Metric | Meaning | Recommended default tier (**to be decided**, see below) |
|---|---|---|
| **p50** | Median experience (typical user) | primary read path ≤ 200 ms |
| **p95** | The **main acceptance criterion** for most users | primary read ≤ 500 ms; primary write ≤ 800 ms |
| **p99** | The tail (**mandatory under the hard requirement**) | primary read ≤ 1500 ms; primary write ≤ 2000 ms |

- **Averages forbidden**: an average masks the tail (same rule as `PROTOCOL §㉒`). **A latency report must give all three of p50/p95/p99**; missing any one is a fail.
- Units are always `_seconds` (e.g. `<service>_http_request_duration_seconds`); if a threshold is stated in ms, note the conversion.

### 3.2 Throughput

| Metric | Meaning | Unit convention |
|---|---|---|
| **QPS / RPS** | Requests per second (per endpoint / per path) | counts use `_total` (e.g. `..._requests_total`); the rate is the windowed mean |
| **Peak throughput** | Short-burst sustainable tier | bound to a concurrency tier; must state the sampling window |

### 3.3 Error rate

| Metric | Meaning |
|---|---|
| **5xx share** | Server errors / total requests (windowed) |
| **Business failure rate** | HTTP 2xx but **business-semantic failure** (e.g. body `code != 0`) — must be counted **separately** from 5xx; a 2xx must not mask a business failure |

### 3.4 Saturation

| Metric | Meaning |
|---|---|
| CPU / memory | Process- or container-level usage (memory unit `_bytes`) |
| Connection pool | active / idle / waiting counts (a full pool is a bottleneck signal) |

### 3.5 Concurrency / queue depth

| Metric | Meaning |
|---|---|
| Concurrency tier | Load-test concurrent users / connections (acceptance must state "at X concurrency") |
| Queue depth | Pending tasks / message backlog (backpressure warning; links to `runtime-observability-sop.md`) |

---

## 4. SLA vs SLO Definitions

**Definition**: the three must be distinguished and never conflated; an **SLI** is the measured value, an **SLO** is the internal target, an **SLA** is the external commitment. (Responsibility / Landing point → §0.)

### 4.1 The three distinguished (★ write this out)

| Concept | Definition | Faces | Who decides | Consequence of violation |
|---|---|---|---|---|
| **SLI** (Indicator, a measurement) | The value actually measured (e.g. "30d-window request success rate = 99.93%") | internal | Linus (definition) | — |
| **SLO** (Objective, an internal target) | The **target value** pursued internally (e.g. "success rate ≥ 99.9%") | internal | Elon (adjudication) | triggers engineering action / consumes error budget |
| **SLA** (Agreement, an external commitment) | A **contract-level commitment** to the **outside** (incl. compensation / exemption clauses) | external (operator / customer) | the operator (external-facing owner) | breach compensation / reputation loss |

> **Relationship**: **SLO must be stricter than (or equal to) SLA** — the internal target leaves headroom, so the service is not run right against the external red line. Anti-pattern: using the SLA directly as the SLO (no headroom; a single wobble breaches the contract).

### 4.2 Error budget and the "availability % → permitted downtime" conversion

- **Error budget** = `1 − SLO`, accumulated over a **rolling window** (30d recommended).
  Example: SLO availability 99.9% (30d) ⇒ error budget = 0.1% ⇒ **permitted unavailability ≈ 43m 12s / 30d**.
- **Availability % → permitted downtime table** (30d window, for reference):

| Availability | Permitted unavailability / 30d | Permitted unavailability / year (≈365d) |
|---|---|---|
| 99% | 7h 12m | ≈ 3.65d |
| 99.5% | 3h 36m | ≈ 1.83d |
| **99.9%** | **43m 12s** | ≈ 8.76h |
| 99.95% | 21m 36s | ≈ 4.38h |
| 99.99% | 4m 19s | ≈ 52.6m |

- **Use**: ① an **exhausted error budget ⇒ freeze non-essential releases** and prioritise stability fixes (links to the release channels of `release-versioning-sop.md`); ② it is the quantitative source of the "availability-class criteria" in §5 acceptance.
- **Landing point**: budget **observation** belongs to `PROTOCOL §㉒` (runtime observability); the **release-freeze action** after exhaustion belongs to `release-versioning-sop.md`.

---

## 5. Performance Acceptance (hard requirements)

**Definition**: performance is an **acceptable item** and must close the loop on four questions — **when / how / pass criteria / environment**. (Responsibility / Landing point → §0.)

### 5.1 When to test (triggers)

| Trigger | Description | Intensity |
|---|---|---|
| **Pre-release** | Every external release, attached to the pre-release checklist of `release-versioning-sop.md` | full benchmark |
| **Regression** | Compare against the baseline to judge degradation (§6) | full or reduced |
| **Capacity change** | Changes to dependencies / sizing / topology (scale up-down, DB swap, cache addition, container resource changes) | full + capacity tier |
| **Major code change** | Performance-sensitive changes that hit a critical path (must be declared as a hit in the card) | full |

> Triggers are driven by the "form alignment" declaration of `PROTOCOL §⑨.3`: **the actual run form of the deliverable = container/orchestration ⇒ performance acceptance must run in that form.**

### 5.2 How to test (method)

| Element | Definition |
|---|---|
| **Benchmark script / load tool** | **to be decided** (tooling selection). **Recommended**: a scriptable, reproducible, CI-callable lightweight load tool (e.g. `k6` / `wrk` / `hey` / Locust — pick one), with the script committed to the repo and versioned with the product |
| **Dataset** | A fixed, reproducible, production-like **dataset** (same dataset across versions, otherwise incomparable); recorded in the baseline file's sample definition |
| **Concurrency tiers** | At least **multiple tiers** (e.g. 1× / target / peak); the report gives **percentiles per tier independently** — never a single tier only |
| **Warm-up** | Warm-up is mandatory (JIT / connection pool / cache cold start); warm-up samples are **excluded** from statistics; cold-start measured directly as steady state is forbidden |
| **Sampling window** | State the load duration and statistical window explicitly; short loads must report variance |
| **Runs** | **Take percentiles across multiple runs** (≥ 3 recommended); report median and worst side by side; a single run must not settle the conclusion |

### 5.3 Pass criteria

- **Latency**: `p95 ≤ threshold` **and** `p99 ≤ threshold` (**a percentile miss is a failure**; averages must not substitute);
- **Error rate**: `5xx ≤ threshold` **and** `business failure rate ≤ threshold`;
- **No leak**: resource usage (memory / connections / handles) does **not grow monotonically** under load **steady state** (no memory/connection leak); — this is a **different object** from the "test-resource cleanup" requirement of `PROTOCOL §⑥.1` (the latter cleans test processes/temp files; this item judges the product's own leaks);
- **Consistency**: write paths must attach a **side-effect consistency assertion** (write-then-read-back is consistent);
- **Combined criterion**: latency + error rate + saturation must pass **simultaneously**; any dimension red is a failure.

### 5.4 Environment (real run form)

- Tests **must** run in the **real run form**: if the deliverable is a container/orchestration ⇒ **run inside the container** (mandatory, `PROTOCOL §⑨.3`);
- **Address semantics**: inside a container `127.0.0.1` ≠ the host; the load target address must be the **actually reachable address in that form** (service name / network alias), never the host-side address;
- **Data source**: use production-isomorphic dependencies (same-version DB / queue) — avoid "local sqlite numbers presented as production conclusions";
- **Reproducible**: the test command + environment description (image tag / resource limits / concurrency tier) must be left as a trail with the Report (`PROTOCOL §⑥.1`).

### 5.5 Performance Acceptance Checklist

> Every item needs **command + output evidence** before it can be ticked (`PROTOCOL §⑥.1`). No evidence ⇒ do not tick.

- [ ] Critical-path list confirmed per §2 (including write path and read-back)
- [ ] Load script committed, reproducible, CI-callable
- [ ] Dataset fixed and recorded in the baseline file
- [ ] Concurrency tiers ≥ 2 (target + peak), percentiles reported per tier
- [ ] Warmed up; warm-up samples excluded from statistics
- [ ] Multiple runs (≥ 3) for percentiles; report includes the worst tier
- [ ] Latency `p50/p95/p99` all present (**no average substitution**)
- [ ] Both `p95 ≤ threshold` and `p99 ≤ threshold` satisfied
- [ ] `5xx ≤ threshold` and `business failure rate ≤ threshold`
- [ ] Saturation (CPU/mem/connection pool) within thresholds
- [ ] No memory/connection leak in steady state (usage not monotonic)
- [ ] Write-path side-effect consistency assertion passed
- [ ] Run **inside the real run form (container/orchestration)** (not only a host process)
- [ ] No regression beyond threshold vs the baseline (§6)
- [ ] Results backfilled into the baseline file (§6) and left as a trail

---

## 6. Baseline Management and Regression

**Definition**: the baseline is a **versionable set of numbers**, landed in a file, comparable and traceable; regression is judged as degradation relative to the baseline. (Responsibility / Landing point → §0.)

### 6.1 Baseline file (`perf-baseline.json`)

- **Filename**: `perf-baseline.json` (recommended; per project, land it in that repo's root or a `perf/` directory) — this file name is the project's baseline artifact convention.
- **Minimal structure (example, not a mandatory schema — finalised by the project)**:

```json
{
  "version": "1",
  "generated_at": "<ISO8601>",
  "env": { "form": "container", "image": "<tag>", "limits": { "cpu": "…", "mem": "…" } },
  "sample": { "dataset": "<id>", "warmup_s": 30, "duration_s": 300, "runs": 3 },
  "paths": [
    {
      "name": "login->token->protected-read",
      "concurrency": [1, 50, 200],
      "latency_seconds": { "p50": 0.0, "p95": 0.0, "p99": 0.0 },
      "throughput_rps": 0.0,
      "error_rate": { "http_5xx": 0.0, "biz_fail": 0.0 },
      "saturation": { "cpu": 0.0, "mem_bytes": 0, "pool_wait": 0 },
      "queue_depth_max": 0
    }
  ]
}
```

- **Units**: identical to `PROTOCOL §㉒` — time `_seconds`, size `_bytes`, count `_total`.
- **Recording rule**: the baseline is **refreshed only on "verified/passing" versions** (only a green version may become a new baseline); a degraded version must never be written back as the baseline (it would mask the degradation).

### 6.2 Regression comparison (fail on degradation relative to the baseline)

| Dimension | Comparison definition | Recommended fail threshold (**to be decided**) |
|---|---|---|
| Latency percentile | this run's p95/p99 vs the same baseline tier | **degradation > 20%** = fail (p99 may relax to **> 30%**) |
| Throughput | target-tier RPS vs baseline | **drop > 15%** = fail |
| Error rate | this run vs baseline | **rise by > 1 order of magnitude, or absolute value over threshold** = fail |
| Saturation | resource usage at the same load vs baseline | a significant rise (e.g. **> 20%**) = warn, human re-check |

- **Same-definition comparison is mandatory**: same dataset / same concurrency tier / same environment form; if the definitions differ, the comparison conclusion is **invalid** and must be re-run (to stop "environment difference" masquerading as "performance degradation", or vice versa).
- **Relative vs absolute**: first pass the §5.3 **absolute criteria** (does it meet thresholds), then pass this section's **relative criteria** (did it degrade); **both must pass** to pass.

---

## 7. Machine-checkable vs Human Judgement (master table)

> **Use**: land what can be machine-checked on scripts, and **honestly** route what cannot to a human, labelled `PROTOCOL §⑳.2` (**do not claim it is gated**). Machine-checkable gates are registered following the `PROTOCOL §⑳.1` pattern.

| Check item | Machine-checkable (landing point: CI / check-all / hook) | Human (responsible role) |
|---|---|---|
| Benchmark script exists and runs | **CI**: benchmark script run (pre-release / regression trigger) | — |
| Threshold assertion (p95/p99 ≤ threshold) | **CI**: non-zero script exit = fail (threshold from the baseline file) | the threshold **value** is adjudicated by Elon |
| Error-rate assertion | **CI**: over-threshold 5xx / business failure = fail | verifying the boundary of the business-failure definition (Turing) |
| No leak (usage not monotonic) | **CI**: steady-state slope assertion | leak root-cause localisation (Linus) |
| Baseline file present / well-formed | **check-all**: `perf-baseline.json` present + JSON schema/field validation | — |
| Baseline file unit convention | **check-all**: `_seconds`/`_bytes`/`_total` naming lint | — |
| Regression comparison | **CI**: degradation vs baseline > X% = fail | **the adjudication of whether a degradation is acceptable** (Elon) |
| Critical-path list selection | — | **Linus nominates + Elon adjudicates** (§2) |
| SLA / SLO numeric adjudication | — | **Elon (SLO) / the operator (external SLA)** (§9.3) |
| External SLA commitment | — | **decided by the operator** (external contract) |
| Environment form authenticity (container/orchestration) | **check-all**: declared-form consistency lint (partially machine-checkable) | final sign-off "the target form has actually been run" (Elon, `PROTOCOL §⑨.3`) |
| Dataset / concurrency-tier reasonableness | — | **Turing** (test-scenario authenticity, `PROTOCOL §⑥.1`) |
| Degradation threshold value (X%) | — | **adjudicated by Elon** (§9.4) |

---

## 8. Workload Profiles and Landing Points

Not every deliverable is a long-running request/response service. The metric framing must follow the **workload shape**:

| Profile | Applicability | Landing point (CI / check-all / hook / human) | Notes |
|---|---|---|---|
| **Long-running service** | A resident service / API exposing endpoints | **CI**: run the benchmark script + threshold assertion inside the container form; **check-all**: `perf-baseline.json` validation; **human**: threshold adjudication | The critical path follows the §2.1 template as the minimum mandatory path; if the project already has a container-form acceptance basis, performance acceptance runs directly in that form (satisfying `PROTOCOL §⑨.3`), so a separate environment is not built — the **most mature landing point** |
| **Non-resident / batch runner** | A single-run job (e.g. a backtest, a batch pipeline, a strategy runner) that is **not** a resident service | **human + check-all**: the performance definition is the **single run** — duration, resource use, output verification | Do **not** apply the "QPS / p95" web definition; the metric definition switches to **run duration** (p50/p95/p99 across multiple runs), **peak memory** (`_bytes`), and **batch throughput** (units processed per second, e.g. backtest-years/second); the specific benchmark and metric definitions are **to be decided** by the project; the runner's generated artifacts are not versioned |

---

## 9. Open Questions (unresolved — not yet L1)

Each item is **to be decided** (Elon / project decision); until adjudicated it stays open and is backfilled into the named section (and the baseline file / CI assertion parameters). Origin section numbers are kept for traceability.

1. **(ex §2.3) Per-project critical-path list** — **to be decided**. **Recommended**: start with the **end-to-end main path** listed under `PROTOCOL §⑨.3` (login ⇒ obtain token ⇒ access protected endpoint) as the **minimum mandatory path**; each workload profile (§8) adds one **read path**, one **write path** and one **read-back path**. The list is adjudicated by Elon and backfilled into §2 and the baseline file's `paths[]`.
2. **(ex §3.6) Thresholds / p95·p99 numbers per path** (latency / throughput / error rate) — **to be decided**. **Recommended defaults** (an adjudication starting point, not final values): latency per the §3.1 table; error rate **5xx ≤ 0.1%**, **business failure ≤ 1%**; saturation **CPU/mem ≤ 80%**, **connection-pool wait = 0**; queue depth **backlog does not grow monotonically with load duration** (steady-state criterion).
3. **(ex §4.3) Per-project SLA / SLO numbers** — **to be decided**. **Recommended defaults**: **availability SLO = 99.9% (30d)**; latency SLO uses the p95 thresholds (§3.1); error-rate SLO **5xx ≤ 0.1%**. **No SLA is preset** — the external commitment must be decided by the operator (an external-contract escalation).
4. **(ex §6.3) Degradation thresholds** (the X in "degrade > X% = fail" per dimension) — **to be decided**. **Recommended**: latency p95 **20%**, p99 **30%**; throughput **15%**; error rate as above; saturation **20%** escalated to human. Once adjudicated by Elon these are backfilled into the §6.2 table and used as CI assertion parameters.
