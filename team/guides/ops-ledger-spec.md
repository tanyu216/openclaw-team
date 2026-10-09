# Operations Ledger Spec (ops-ledger-spec.md)

> Ownership: **Assistant role SOP** (L2.5 method library). Normative text references `PROTOCOL §⑩` (triage matrix), `§⑫` (two-way doc sync), `§⑬.4` (token trimming); this file is the execution detail and never copies L1 body.
> **Maintainer**: the **Assistant** role. **Integrator** (sole writer of L1 normative text): **Elon**.
> **Effective**: on adoption (no fixed date).
> **Scope**: L2.5 method library — the operations ledger's fields / template / update cadence, plus routine operations actions.

---

## 1. Scope and Boundaries

| Item | Content |
|---|---|
| **Does** | Process/content operations; data organisation and routine operations actions; operations-ledger maintenance |
| **Does not** | Business code (Linus); functional testing (Turing); UX design (Jobs); research material (the research role, if the instance defines one); outward publication execution (via Elon — see `promo-ops-sop.md §5`) |
| **Handoff** | Needs system events / backend data ⇒ send back to Elon to create a card for Linus; needs design ⇒ dispatch Jobs |

---

## 2. Ledger Fields (minimal required set)

> Ledger carrier: `workspace/<task-id>/ops-ledger.md` (one per routine operations task) or accumulate by topic `<topic>-ledger.md`; **not committed to version control**. For structured use, a same-name `.csv` / `.json` helps with statistics.

| Field | Description | Required |
|---|---|---|
| `date` | record date (YYYY-MM-DD) | ✅ |
| `kind` | record type: `content` / `process` / `data` / `action` / `issue` | ✅ |
| `item` | item/entry name (e.g. "channel schedule", "user-feedback digest") | ✅ |
| `channel` | related channel/module (promotion channel or operations module) | required for promotion |
| `metric` | related metric name + value (e.g. reads=1024) | required for data |
| `status` | `planned` / `doing` / `done` / `blocked` | ✅ |
| `owner` | owner (default assistant) | ✅ |
| `next` | next step / todo | optional |
| `evidence` | evidence path/link (screenshot, file, backend export) | optional |
| `note` | remark / blocking reason | optional |

---

## 3. Ledger Template (Markdown)

```markdown
# Operations Ledger · <topic>
<!-- Cadence: see §4; one row per action / data point; append-only, never edit historical rows -->

| date | kind | item | channel | metric | status | owner | next | evidence | note |
|---|---|---|---|---|---|---|---|---|---|
| <date> | content | <topic schedule> | <channel> | — | planned | assistant | <next step> | — | example row — fill per instance |
| <date> | data | <first-post reads> | <channel> | reads=1024 | done | assistant | week-over-week | shot/<date>.png | example row |
```

**Update rules**:
- **append-only**: never edit historical rows (a correction goes on a new row, `note` says "corrects previous row").
- **One row per action / data point**: do not cram several into a single row.
- Split files across channels/topics to avoid an oversized single file.

---

## 4. Update Cadence

| Ledger type | Frequency | Trigger |
|---|---|---|
| Promotion-data ledger | once at T+1 and once at T+7 after distribution | a distribution happened |
| Content-operations ledger | on every content production/publication (after publishing via Elon) | content action |
| Process-operations ledger | on every process change / issue handling | event-driven |
| Routine operations daily/weekly report | daily with the day's ledger; the weekly summary goes through Elon | periodic |

> Cadence may be tuned to actual operating density; a change must be recorded in this file's §6 (append a change row).

---

## 5. Routine Operations Action List

| Action | Frequency | Output | Note |
|---|---|---|---|
| Content-schedule maintenance | weekly | `promo-schedule.md` updated (linked with `promo-ops-sop.md §4`) | collaborate with promotion |
| Data collection & organisation | after distribution | ledger data rows + weekly-report points | definitions in `promo-ops-sop.md §6` |
| User/channel feedback digest | weekly | feedback digest (issue-type goes to the CS playbook) | collaborate with customer support |
| Process inspection (ops side) | biweekly | issue list + improvement suggestions | system-level ⇒ send back to Elon to create a card |
| Ledger archiving | monthly | archive old ledgers (archive only, never delete) | keep sources |

---

## 6. Change Log

- Initial version (Assistant) — effective on adoption. *(append change rows over time.)*

---

## 7. Open Items / Gaps

1. Whether the ledger needs task-panel integration (currently a file ledger).
2. Degree of systematisation of data sources (if the channel backend is not open, data collection is limited — see `promo-ops-sop.md §6` gaps).
3. Whether to set a formal "monthly operations review" as a regular meeting-style action (currently only a weekly report).
