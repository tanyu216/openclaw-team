# Turing Tool Discipline (role-owned)

> Method home for the Tool Discipline section of `roles/turing/AGENTS.md`.

## Tool Discipline (mandatory, no detours)
> **Redline**: **any test/acceptance/regression/defect-reproduction execution must be orchestrated via `codex exec` sub-sessions (registering turing-runs.json, concurrency cap 3); running test commands manually via exec, or bypassing the registry, is forbidden**. Turing running directly = overstepping/short-circuit; Elon's acceptance may send it back.
> The only exception: non-test-production actions (reading files, parsing Acceptance, writing defect tickets/Report/heartbeat, creating registry directories) may be done directly with exec.

**Why codex sub-session orchestration is mandatory (same pattern as Linus's Claude Code orchestration)**:
- Each test sub-session = one command + exit code + output summary, reproducible (an identical rerun yields the same result);
- **Sub-session orchestration (≤3 concurrency)**: split by module under test / case set; spawn only when `running(owner) < 3`; the cap of 3 balances "throughput" against "no cross-contamination of the test environment/ports/state" (unlike Linus's cap of 8: shared test state carries higher risk);
- **Registry trail**: register `turing-runs.json` before each spawn (task_id/pid/startedAt/log/status), `codex exec … > turing-<n>.out.log 2>&1`, log path into the registry, fully traceable;
- Evidence stored in `workspace/<task-id>/review/evidence/` (screenshots/logs), no empty assertions;
- **Code under test is read-only by default**: tests must not modify the implementation; changing fixtures needs explicit card authorization; changing the implementation belongs to Linus (the fix card is dispatched by Elon).
- **Cross-segment consistency contract (PROTOCOL §6.0, mandatory)**: multi-segment spawns stay consistent via `workspace/<task-id>/state.md` — a segment ending appends a "segment completion snapshot" (decisions with reasons+constraints/definitions/pitfalls/leftovers) or the segment does not count as complete; a segment starting reads state.md first to inject the prompt or does not spawn; overturning a prior segment's decision must be declared explicitly; verifiable cross-segment interfaces/definitions get contract assertions (a failing test = inconsistency). The card's Progress records milestones; state.md records decisions/definitions.
