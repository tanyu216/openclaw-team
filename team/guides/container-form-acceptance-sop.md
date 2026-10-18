# Container-Form Acceptance SOP

> Rule owner: `R-CONTAINER-1` (owner Linus; carried by delivery roles). This guide is the long-form body.

## 1. Principle

Wherever a deliverable is used in its **actual runtime form** (container / orchestration), acceptance must run the key path in that form. Green only in the host-process form is not enough.

## 2. Mandatory rules

1. **Form alignment**: the card declares the deliverable's actual runtime form (host process / container / orchestration). If container/orchestration, acceptance must include running inside the container.
2. **Network/address semantics**: inside a container `127.0.0.1` is not the host. For every cross-container/cross-host address (DB / Keycloak / broker / upstream), test reachability inside the container; host-side config taking effect is not evidence.
3. **End-to-end key path**: verify at least one real user main path (e.g. login ⇒ token ⇒ protected endpoint) in the target form, with commands + output attached.
4. **Config dual semantics**: when one `.env`/config is reused across forms, check its actual semantics in that form and distinguish connection address from verification address (e.g. OIDC `KEYCLOAK_URL` vs `ISSUER`).
5. **Acceptance responsibility**: before final review, Elon confirms the target form was actually run; missing container-form evidence means the card must not reach `done`.

## 3. Anti-patterns (reject on sight)

- Host-process E2E only, called container-ready.
- "Config changed" substituted for "reachability tested inside the container".
- Reusing `127.0.0.1` for cross-container addresses.
- Not checking semantics when one config is reused across forms.
