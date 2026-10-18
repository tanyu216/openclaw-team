# Defect Fix and Regression SOP

> Rule owner: `R-DEFECT-1` (owner Elon; carried by delivery roles). This guide is the long-form body.

## 0. Normative steps (`R-DEFECT-1`)

1. **Defect ticket** — Turing records severity / reproduction / expected vs actual / evidence path, sets the card `blocked` or `canceled`, and sends it back to Elon.
2. **Fix card** — Elon creates a fix card for Linus, referencing the original card and the defect ticket.
3. **Acceptance** — when Linus finishes, the fix card returns to `todo`; Elon accepts it.
4. **Regression** — Turing reruns the full original Acceptance plus affected existing cases.
5. **Close** — only a fully green regression moves the original card to `done`; a failed regression returns the fix card to Linus. Never pack fix→retry→fix into one card's `seg` (anti-pattern below).


## 1. Anti-pattern

Do not pack a repeated fix→retry→fix loop inside one card as a `seg`. That masks a defect behind an execution tool. Open a defect/fix card and run the loop above; the seg rules are in `R-SEGUSE-1`.
