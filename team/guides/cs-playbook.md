# Customer Support Playbook (cs-playbook.md)

> Ownership: **Assistant role SOP** (L2.5 method library). Normative text references `PROTOCOL §5` (message discipline / outward always via Elon), `PROTOCOL §10` (triage matrix), `PROTOCOL §9` (defect fix and regression loop), `PROTOCOL §15` (SLA / timeout escalation), `PROTOCOL §15.1` (operator exception channel); this file is the execution detail and never copies L1 body.
> **Maintainer**: the **Assistant** role. **Integrator** (sole writer of L1 normative text): **Elon**.
> **Effective**: on adoption (no fixed date).
> **Scope**: L2.5 method library — customer-support FAQ + response flow + escalation path + knowledge-base maintenance.

---

## 1. Scope and Boundaries

| Item | Content |
|---|---|
| **Does** | User inquiry / problem response **content preparation**; FAQ maintenance; problem digest and escalation feedback |
| **Does not** | Direct outward sending (always via Elon — see §3 and `promo-ops-sop.md §5`); business code fixes (Linus); functional testing (Turing) |
| **Handoff** | Product defect ⇒ summarise the defect-ticket points and send back to Elon (Elon creates a card for Turing/Linus); design issue ⇒ dispatch Jobs |

> ⚠️ **Outward sending always via Elon**: the Assistant only **prepares reply content** and **digests problems**; the actual outward sending is executed by Elon or with Elon's written authorization (the same authorization chain as `promo-ops-sop.md §5`).

---

## 2. FAQ Skeleton

> The FAQ here is a **structural skeleton + placeholders**; entries are filled once the product matures / inquiries accumulate. **Do not fabricate product facts**; unconfirmed answers are marked `TODO`.

| # | Question | Answer points | Status | Basis / source |
|---|---|---|---|---|
| F1 | What is the product / what problem does it solve | TODO | pending | needs Elon/product stance |
| F2 | How to get started / onboarding path | TODO | pending | needs PRD/Jobs |
| F3 | Which platforms / environments are supported | TODO | pending | needs engineering stance |
| F4 | Pricing / subscription | TODO | pending | needs operator |
| F5 | How data / privacy is handled | TODO | pending | needs compliance stance |
| F6 | How to report a bug | collect: symptom / steps / environment / screenshot → digest → via Elon to Turing | usable | this playbook §4 |
| F7 | How to contact us | via the official channel (to be registered) | pending | needs channel registration |

**Maintenance rule**: every FAQ entry must carry "status + basis/source"; a `TODO` entry must not be answered to a user — route it through escalation (§5) first.

---

## 3. Response Flow

```
1. Collect: record the inquiry text + source channel + time (do not speculate on unwritten information)
2. Triage:
   - FAQ has a clear answer ⇒ draft a reply (cite the FAQ number)
   - no FAQ / FAQ is TODO ⇒ go through the escalation path (§5); do not fabricate
   - defect/outage ⇒ collect reproduction info → digest defect points → send back to Elon
3. Draft: the Assistant prepares the reply content (conclusion first, bad news stated plainly)
4. Send: always via Elon (sessions_send back to Elon with the draft attached)
5. Trail: problem points + disposition + reply link/screenshot → record in the CS ledger (see ops-ledger-spec.md)
6. Digest: recurring problems are promoted to FAQ candidates (§6)
```

**Response time (draft guidance)**: first-response target ≤ 4h (working hours, PROTOCOL §15); if it cannot be answered immediately ⇒ reply "received, will follow up within X" and escalate.

---

## 4. Defect / Issue Capture Template

```
- Symptom: <user description>
- Reproduction steps: 1)… 2)… 3)…
- Expected vs actual: …
- Environment: platform / version / account
- Evidence: screenshot / recording / log path
- Impact / frequency: …
- Source: channel + time
```

> After completing the capture, **send back to Elon** (Elon determines ownership and creates a card for Turing to reproduce / Linus to fix, PROTOCOL §9).

---

## 5. Escalation Path

| Situation | Escalate to | Method | Time limit (PROTOCOL §15) |
|---|---|---|---|
| General product question, no stance | Elon | `sessions_send` `agent:main:main` | immediately |
| Suspected defect / outage | Elon (→ Turing/Linus) | capture template + send back | immediately |
| Compliance / legal / privacy risk | Elon (operator if needed) | send back, mark "high risk" | immediately |
| Pricing / promise (operator-decided) | Elon → operator | send back | immediately |
| Team stalled (Elon > 6h no action) | operator (PROTOCOL §15.1 exception channel) | `message` tool, prefix `[exception direct report]` | only when stalled |

> **Forbidden**: the Assistant promising a user an unconfirmed item; bypassing Elon to send outward directly (except the PROTOCOL §15.1 exception).

---

## 6. Knowledge-Base Maintenance

- **Carrier**: this playbook's §2 FAQ table (extended as the product matures); if entries grow, split into `faq/<topic>.md`.
- **Distillation source**: questions recurring in the CS ledger (≥ 2 times) ⇒ promote to a FAQ candidate ⇒ complete the answer (needs a confirmed source) ⇒ enter the table.
- **Cadence**: record in the ledger after each CS action; the FAQ is updated with the weekly digest.
- **Version**: FAQ changes are recorded in this playbook's §7 change log (append).
- **Quality gate**: any FAQ answer must be traceable (the basis/source column non-empty); an unsourced answer must not enter the table.

---

## 7. Change Log

- Initial version (Assistant) — effective on adoption. *(append change rows over time.)*

---

## 8. Open Items / Gaps

1. Official contact channel not registered (F7).
2. Product-fact FAQs depend on the PRD/engineering stance and are not yet available.
3. Ownership and opening of the CS external entry (email / ticketing system).
4. Whether the response-time SLA is formally added to the PROTOCOL §15 table (currently draft guidance).
