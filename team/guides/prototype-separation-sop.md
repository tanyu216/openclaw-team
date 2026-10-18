# Prototype / Implementation Separation SOP

> Rule owner: `R-PROTO-1` (owner Linus; Jobs carries it). This guide is the long-form body.

## 1. Principle

`prototype/**` is a **pure design draft**: it carries UI structure, style and interaction form only. Writing real business implementation into it is forbidden. The prototype is the form-baseline contract (`R-UI-1`), not a system under test.

## 2. Mandatory rules

1. **No implementation in the prototype**: no `fetch`/`XHR`/`axios`, no real auth/validation, no token/credential storage, no real API endpoint strings, no backend-call wrappers. Visual/navigation interactions may remain (e.g. login calls `enterApp()`).
2. **Single implementation landing point**: frontend implementation lands in `web-client/src/`; backend in `server/src/`. No card's `target`/`git_rules` may designate `prototype/**` as a business-implementation landing point.
3. **Prototype changes require explicit authorization**: changes are limited to design-form adjustments, must be justified on the card, and must never be used to "pass E2E/tests".
4. **E2E/tests must not depend on the prototype page**: the system under test is the real frontend build artifact (`web-client/dist`, etc.). Prototype-level smoke must be labeled "UI smoke", confirmed by Elon, and must not smuggle in implementation.
5. **Anti-regression gate**: add a check (grep/unit test) that fails if implementation traces such as `fetch(`, `apiFetch` or `idtoken` appear under the prototype directory.
6. **Review ownership**: for any card touching `prototype/**`, Elon's initial review checks whether implementation was written into the prototype.

## 3. Anti-patterns (reject on sight)

- Real requests/auth/credentials in `prototype/**`.
- Using the prototype as the E2E system under test.
- A card `target` pointing at `prototype/**` to carry business implementation.
- "Login already works in the prototype" as evidence of functional completion.
