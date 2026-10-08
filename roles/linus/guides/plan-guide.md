# Planning Guide (Phases 1-2: Produce Plan + Review Plan)

> **This guide = the detailed method for development process Phases 1-2** (the detailed tutorial referenced by AGENTS.md "Development Process SOP").
> Usage: first follow the "Execution Checklist" item by item; "Details" is the concrete reference for each step, consult as needed.

---

## ✅ Execution Checklist (Todo)

### Phase 1: Produce Plan
- [ ] 1. **Read the full task card** (Goal / Acceptance / Background / project / target)
- [ ] 2. **If there is a decision fork => first draw the design tree + compute the frontier** (see AGENTS.md "Decision Fork Prerequisite"); no fork => go straight to the next step
- [ ] 3. **Write `plan.md`** (to `workspace/<task-id>/plan.md`), it must include:
  - [ ] Requirement breakdown (requirement → implementation approach)
  - [ ] Affected files list (exact paths, "and related files" forbidden)
  - [ ] Test scenario coverage points (unit: normal/boundary/exception; integration: three API endpoint cases)
  - [ ] Execution step Todo (with `[ADD]/[DELETE]/[MODIFY]/[integration]` markers)
  - [ ] Acceptance points (against the task card Acceptance)

### Phase 2: Review Plan (four-dimension self-check)
- [ ] 4. **Logical completeness**: self-consistent, no contradiction/hole (Details §Pattern 3)
- [ ] 5. **Omission check**: every new item has a complete integration path "define → register → call", no dead code (Details §Pattern 4)
- [ ] 6. **Test scenario coverage**: each requirement has clearly written unit/integration test coverage points (Details §Pattern 5)
- [ ] 7. **Todo check**: execution steps are properly formatted (`[ADD]/[DELETE]/[MODIFY]/[integration]`), actionable, and match the plan (Details §Pattern 6)
- [ ] 8. **Impact scope** (required when the change touches interfaces/fields): trace the call chain + judge the 5 parameter-break types + Breaking determination (Details §Pattern 2)
- [ ] 9. Self-check fails => return to step 3 to revise; **if a blocking defect exists => must not proceed to execution**

### Phase 2.5: Send back to Elon for confirmation
- [ ] 10. `sessions_send` back to Elon (`agent:main:main`): absolute path of plan.md + one-sentence goal + key decision summary + items to confirm
- [ ] 11. **Only enter Phase 3 execution after Elon confirms** — do not act without confirmation (hard gate)

---

## Details

### Pattern 1: Analysis mode (analysis) — design philosophy

Examine from "is the design fundamentally sound", along five dimensions:

| Dimension | Core question |
|------|---------|
| Simplicity | Is the simplest feasible approach used? Any over-design / YAGNI violation? |
| Maintainability | Single responsibility? Self-explanatory naming? Isolated change impact? Clear interface contract? |
| Reliability | Is the data flow correct and complete? No gaps in the state machine? Adequate error handling? |
| Robustness | Can exceptions/boundaries/concurrency conflicts be handled gracefully without dying? |
| Elegance | Consistent abstraction levels? Appropriate patterns? Follows project conventions? |

### Pattern 2: Call-chain tracing (impact-tracing) — impact scope + parameter breaks

> 🧭 **Prefer gitnexus (MCP) for automated analysis; use manual grep as a supplement/fallback**. gitnexus understands the call graph, more accurate than grep.
> - `impact({target:"<symbol>", direction:"upstream"})` => who depends on me (whose change will break whom, see the blast radius)
> - `impact({target:"<symbol>", direction:"downstream"})` => whom I depend on
> - `context({name:"<symbol>"})` => callers/callees/execution flows involved
> - `query({query:"<concept>"})` => find code by execution flow (replaces grep)
> - `detect_changes()` => **before committing** verify "the impact surface of this change"
> - ⚠️ **Refresh if the index is stale** (not mandatory): if it reports stale when used => run `node .gitnexus/run.cjs analyze` at the project root (~120s)
> - ⚠️ **Fallback**: no index / non-JS-TS project => fall back to the manual steps below (the original content of this section still applies)
> - ⚠️ High risk (HIGH/CRITICAL) must be flagged before changing (see AGENTS contract)

Two core questions: "If I change here, whom will it affect?" "As data flows from upstream to downstream, does every link match up?"

**Five dimensions (judge which are involved)**: internal code call chain / API call chain / message-event link / **frontend data flow** / cross-service cross-repo.

**Four perspectives (check every chain)**: input params (type/format/required match), output params (field existence/consumer adaptation), intermediate conversion (serialization/deserialization dropping fields), exception paths (timeout/disconnect/error propagation).

**Impact domain classification and risk**: `internal_only` (low) / `api_callers` (medium) / `event_consumers` (medium) / `frontend_dependent` (high) / `cross_repo` (high).

**Breaking Change determination**: parameter deletion / return-field deletion / API path change / DB field rename = Breaking, must be handled before merging. Parameter addition (with default) / return-field addition = compatible.

**Five parameter-break types (🔴 blocking)**:

| Type | Typical scenario |
|------|---------|
| Type mismatch | upstream sends int → downstream expects str |
| Missing field | upstream omits a field, downstream `.get()` has no default |
| Naming inconsistency | snake_case↔camelCase not converted |
| Structural break | dict nesting level wrong, list vs single object |
| Protocol break | JSON↔protobuf field numbering inconsistent |

**Database relations (ten items when a field changes)**: affected tables/fields, design docs, migration SQL, ORM Model, API Schema, frontend presentation layer, external callers, cache invalidation, message queue payload, API version compatibility.

### Pattern 3: Logic integrity check (logic-integrity)

Ask "does the logic hold up", along seven dimensions: premise-conclusion consistency / requirement-solution mapping (any orphan requirements?) / design-decision why chain / boundary-condition logic coverage / logic conflict detection / assumption consistency / logic hole detection (correlation ≠ causation).

### Pattern 4: Omission check (omission) — integration breakpoints

Inventory all new items in the plan (functions/classes/APIs/events/DB/config/frontend components/WebSocket messages), and verify each one has a complete integration path: **define → register → call**, no omission and no dead code.

Related-problem search: does a similar problem exist elsewhere? The same-pattern bug?

### Pattern 5: Test scenario coverage (test-coverage-check)

Analyze requirement by requirement, starting from the requirements:
- **Unit test scenarios**: normal path / boundary conditions / exception paths / state transitions / numeric precision
- **Integration test scenarios**: cross-module calls / API endpoints / DB operations / event messages / config switches

### Pattern 6: Todo check (todo-check)

Execution step Todo format (`[ADD]/[DELETE]/[MODIFY]/[integration]` code-level markers), matching the plan content, complete unit/integration test coverage for every requirement.

### Pattern 7: Review mode (review) — final gate

Document structure review + overall quality assessment, giving the final verdict: **recommend execution / execute after revision / needs rewrite**.

### Pattern 8: Update mode (update)

Perform precise text edits on the plan file based on the analysis report, keeping the original style and structure; after editing, run conflict detection + integrity verification. The only mode allowed to write files.

---

## Global constraints

- Precision over generalization (confirm line numbers, do not write vague descriptions)
- Trace to the end (impact analysis traced to each caller's specific field access)
- No compatibility transition (ship together by default, no compatibility layer)
- No relative paths, no "and related files" in place of precise enumeration

---

## Common mistakes

| Mistake | Consequence |
|---|---|
| Inferring the task from conversation context, not reading plan.md | Deviates from the plan, rework |
| Changing interfaces/fields without tracing the frontend call chain | Frontend silently breaks (Gate 0️⃣ high-frequency defect) |
| New function with no caller (dead code) | Integration breakpoint, feature does not take effect |
| Test scenarios only cover happy-path | Boundaries/exceptions uncovered, false green |
