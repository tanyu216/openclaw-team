# Marketing / Promotion SOP (promo-ops-sop.md)

> Ownership: **Assistant role SOP** (method library). Normative text references `R-PUB-1` (public release channel & approval), `R-MSG-1` (message discipline), `R-TRIAGE-1` (triage matrix), `R-DISC-5` (decision fork first), `R-CONFIRM-1` (confirmation gate); this file is the execution detail and never copies a rule body.
> **Maintainer**: the **Assistant** role. **Integrator** (owner of the normative rules): **Elon**.
> **Effective**: on adoption (no fixed date).
> **Scope**: promotion execution detail — channel list, asset standards, scheduling, outward-release approval chain, effectiveness metrics, and the asset boundary with Jobs.

---

## 1. Scope and Boundaries

| Item | Content |
|---|---|
| **Does** | Promotion copy/asset preparation; channel content **preparation**; campaign planning and execution; schedule management; promotion effectiveness measurement |
| **Does not** | Product/UI/visual design output (owned by Jobs — see §7 asset boundary); the outward publication action itself (see §5 approval chain); research-material organisation (owned by the research role, if the instance defines one) |
| **Handoff** | Design assets need Jobs to produce art / set style ⇒ card created via Elon; outward publication ⇒ approved and executed via Elon |

> ⚠️ **Isolated from the "misc-chore fallback"**: promotion / operations / customer support are **key functions** and must not be indefinitely stalled because the role picks up unbounded misc chores. While a promotion card for the team project is `in_progress`, a misc-chore card must not crowd out the same round's execution time (promotion / operations / support first, misc chores after).

---

## 2. Promotion Channel List

> Definition: a **channel** = "a publishing location facing an external audience". **A channel whose account is not yet opened is marked as a gap; before it opens, do preparation only and schedule no publishing.**

| Channel | Form | Target audience | Publishing method | Approval | Status |
|---|---|---|---|---|---|
| WeChat Official Account | article / long text | followers | backend broadcast | Elon (§5) | `<gap \| registered>` |
| WeChat Moments / Channels | short video / image | private domain | manual | Elon | `<gap \| registered>` |
| Xiaohongshu | image / note | broad users | note publishing | Elon | `<gap \| registered>` |
| X / Twitter | short / long post | English / technical audience | manual | Elon | `<gap \| registered>` |
| Zhihu | answer / column | technical / product audience | column publishing | Elon | `<gap \| registered>` |
| Developer communities (e.g. Juejin) | technical long-form | developers | post | Elon | `<gap \| registered>` |
| Website / landing page | page copy | all | site update (engineering implementation point, Linus) | Elon + engineering card | `<gap \| registered>` |
| Email (EDM) | email | subscribers | email platform | Elon | `<gap \| registered>` |

> **The channel list is a template — fill per instance**: register each channel's account ownership, publishing permission, and approver. The rows above are **examples of the shape**, not any specific instance's account state.

- **Channel priority**: if undecided ⇒ recommend the operator/Elon decide by "target audience × operating cost × measurability" (via `R-DISC-5` decision fork first, producing `design-tree.md`).
- **New channel**: any new channel must first be registered in this table (including account ownership, publishing permission, approver) before it can be scheduled.

---

## 3. Asset Standards

| Category | Standard |
|---|---|
| **Copy** | Primarily the project's working language, technical terms kept in English; title ≤ 30 chars (long-form may use a subtitle); structure "conclusion first → evidence → call to action" |
| **Images** | **Produced or certified by Jobs** (see §7); the promotion side only gives selection/cropping **suggestions**, and does not change the design style |
| **Sizes** | Channel cover 900×383; generic square 1080×1080; vertical/video 1080×1920 (recheck against the actual backend spec once the channel opens) |
| **Naming** | `<channel>-<campaign/topic>-<YYYYMMDD>-<vN>.<ext>`; version ascending, never overwrite an older version |
| **Storage** | Staged in `workspace/<task-id>/assets/` (the orchestration artifact area); **not committed to version control**; final paths recorded in the ledger and the card |
| **Compliance** | No unproven quantitative-return promises, no exaggeration; disclaimers follow the project's stance; any data citation must be sourced |

---

## 4. Distribution Preparation and Scheduling

**Schedule table template** (write to `workspace/<task-id>/promo-schedule.md`):

| Planned publish date | Channel | Topic / campaign | Asset (vN) | Owner | Approval status | Actual publish date | Link / screenshot trail |
|---|---|---|---|---|---|---|---|

**Pre-publication checklist (all required before publishing)**:
- [ ] Assets conform to §3 (including Jobs' certification/delivery)
- [ ] Copy is free of misleading/compliance risk; citations are traceable
- [ ] §5 approval passed (trail: `task.comment kind=confirm`)
- [ ] Publishing account/permission available (channel registered, not a gap)
- [ ] The link/screenshot return path is confirmed (for §6 metrics)

**Cadence**: per channel, suggest ≤ 3 posts/week to avoid self-cannibalising; campaigns must enter approval with **≥ 3 days' lead** before publishing.

---

## 5. Outward Publication Channel and Approval (★ explicit)

> **Key distinction**: **Elon faces humans** (`R-MSG-1`) = the **internal / operator-facing reporting channel**; this is **not** the same as the "outward publication channel to the external public/customers". The two must not be conflated and are defined separately.

**Definition**:
- **Outward publication channel** = content distribution and account operation facing external audiences beyond the team and the operator (social media / website / EDM / etc.).
- It is **two separate channels** from `R-MSG-1`'s "facing humans": `R-MSG-1` governs "who reports to the operator"; this section governs "who publishes to the external public".

**Authorization chain**:
```
Assistant (prepares assets + copy + schedule)
   → sends back to Elon via sessions_send: asset path + copy + target channel + planned date
   → Elon reviews against Acceptance/compliance (`R-CONFIRM-1` confirmation gate)
   → approved: the [authorized publishing account holder] executes the publication
         (when the account holder is undecided, Elon executes by default, or Elon names an authorized member)
   → Assistant returns the publish link/screenshot → writes the ledger → records task.comment kind=confirm (with approver/time/link)
```
- **Default stance (absent a new ruling)**: **all outward publication goes through Elon**; the Assistant **only prepares, does not publish outward directly**; the publishing action is performed by Elon or Elon's written designee.
- **Trail**: every outward publication must record "approval record + channel + publish link/screenshot + time" via `task.comment` (`kind=confirm`, approver signed) into the relevant task card.
- **Forbidden**: the Assistant publishing outward without approval; substituting "Elon already said so in chat" for a formal approval trail.

---

## 6. Promotion Effectiveness Metrics (★ duty + minimal metric definitions)

**Duty**: the Assistant owns **data collection, definition maintenance, and periodic reporting** of promotion effectiveness (outward reporting goes through Elon).

| Metric | Definition | Source | Gap / TBD (example) |
|---|---|---|---|
| Impressions | number of times content was displayed | each channel's backend | channel backend not yet available |
| Reach | deduplicated reached users / reads | channel backend | — |
| Clicks / CTR | link clicks; CTR = clicks ÷ impressions | channel backend + short-link stats | short-link service TBD |
| Conversions | target action completions (signup/download/inquiry, defined per campaign) | landing page / backend events (engineering) | attribution and definition TBD |
| CAC | spend ÷ conversions | ad ledger (if paid) | no paid-ad ledger |
| ROI | (conversion value − spend) ÷ spend | cost ledger + conversion-value definition | conversion-value definition TBD |

> The "Gap / TBD" column shows the **shape of a gap**; fill the actual state per instance (the values above are examples).

**Measurement cadence**: after each distribution, collect once at T+1 (first day) and once at T+7 (week); campaigns follow the campaign cycle.
**Reporting format** (trimmed, `R-DISC-4`): channel / metric actual values / period-over-period / conclusion and next step; details stay in the ledger — do not paste long tables into messages.
**Gap summary** (example, fill per instance): account not opened, short-link service TBD, event attribution TBD, no cost ledger — to be completed after an operator/Elon decision.

---

## 7. Asset Boundary with Jobs

| Item | Jobs | Assistant |
|---|---|---|
| Visual style / palette / font / typography spec | **authority** (sole arbiter) | complies, does not change |
| Illustrations / logo / poster / key visual | produces (via canvas-design) | only selection/cropping suggestions |
| Promotion copy / email body / campaign planning | does not produce | **produces** |
| Asset compliance / size reuse | provides source files and spec | reuses and names per §3 |
| Delivery path | art lands in the project design repo/area | orchestration artifacts land in `workspace/<task-id>/` |

> Need new design assets ⇒ the Assistant sends back to Elon ⇒ Elon creates a card and dispatches Jobs (workers do not dispatch to each other, `R-TRIAGE-1`).

---

## 8. Open Items / Gaps (need operator/Elon decisions)

1. Account ownership and opening priority for the "gap" channels (recommend `R-DISC-5`).
2. The **account holder** for outward publication and the automation boundary (whether/who may publish on their behalf).
3. Short-link service, event attribution, conversion-value definition, ad-cost ledger.
4. The effective point of this SOP and whether to create a separate promotion-metrics card.
