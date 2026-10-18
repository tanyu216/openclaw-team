# Confirmation Gate SOP

> Rule owner: `R-CONFIRM-1` (owner Elon). This guide is the long-form body.

## 1. Triggers

1. Finalizing `plan.md` for a development task (Linus four-stage SOP stage 2.5).
2. Finalizing product design docs (Jobs).
3. A destructive data/DB migration.
4. An API deprecation decision.

## 2. Responsibility and action

The worker `sessions_send`s Elon: plan/doc path + goal + key decision summary + open items. Elon reviews against Acceptance/Background. Routine items Elon confirms on his own; major, disputed, funds/security or architectural-direction items are escalated to the operator.

## 3. Evidence

The confirmation message goes into the card's Progress. Product design docs record "Elon confirmed (dual-signed)". A confirmation request carries the stable marker `[confirm-request]` (optionally `[confirm-request: <topic>]`); the SLA detector looks for the marker first and falls back to the request shape + `status_changed_at` with low confidence.

## 4. No-proceed rule

Without confirmation, do not proceed to execution and do not use the item as a downstream basis.

## 5. Timeout

Wait limits and escalation are in `R-SLA-2`; timeouts are handled by Elon's patrol.
