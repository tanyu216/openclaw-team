# CI Gate and Release SOP (Linus)

> Ownership: **Linus role SOP** (L2.5 method library). Normative text references `PROTOCOL §6.1`; this file is the **execution detail**.
> Scope: all version-controlled project deliveries — **CI gate, build, release, and deploy** are all Linus's responsibility.

## 1. Boundary of Duties
- **Linus is responsible for**: maintenance and passing of the CI gate, build, release, deploy.
- **Turing is responsible for**: independent verification / regression / security audit (not responsible for CI config, but may re-check whether the gate is genuinely effective).
- **Elon is responsible for**: acceptance and sign-off.
That is: **Linus ensures the gate is red/green, while acceptance is judged independently by Turing/Elon**.

## 2. Verification Environment: Docker (mandatory)
> Project convention: **local verification always runs inside the container, never on the host** (consistent with meerkat-taskpanel).

- **Sole health source of truth**: `docker/verify-in-container.sh` — CI and the local `docker/verify.sh` call **the same script**, so "local green = CI green".
- **Entry points**: `docker/verify.sh` (host build+run) · `docker compose -f docker/docker-compose.yml up --build` · CI `.github/workflows/verify.yml`.
- **Offline first**: no network by default; for network paths use `OPENCLAW_TEAM_NET=1` (or `docker/verify.sh --net`).
- **Coverage**: syntax (shell/node) · manifest+lock integrity (0 unresolved/0 duplicates) · installer and fetcher dry-run · real file deployment · **upgrade/backup/user-file retention** · (optional) upstream fetch.
- **Requirement**: before any delivery, container verification must be **all green**; running directly on the host is allowed only for troubleshooting and **must not be used as delivery evidence**.
- **Acceptance basis**: the Report attaches the container verification output (exit code 0 + last line `all container checks passed`).

## 3. CI Gate Discipline
1. **The gate is the DoD**: any commit / PR must pass the unified gate before it can be merged and before `done` can be set.
2. **Minimal gate set** (tailored per project; missing items must be explained in the card):
   - [ ] lint / static checks
   - [ ] type check (`tsc --noEmit` / `mypy` / `ruff`, etc.)
   - [ ] unit tests + integration tests
   - [ ] coverage thresholds (see `PROTOCOL §6.1` and Linus's testing discipline)
   - [ ] **the build must succeed** (build is a gate item, not optional)
3. **Red means stop**: if the gate is not all green ⇒ do not merge, do not set `done`; rerun until all green after fixing.
4. **Pass locally first**: run the equivalent gate before pushing (`pre-commit` / `make check` / `npm run check`) to avoid burning CI on spins.
5. **No bypassing**: do not use `--no-verify`, skipping or disabling jobs, or similar to bypass the gate; if truly necessary, it requires **written authorization in the card** and a trail.
6. **Failure trail**: a CI failure must have "failed job + key log excerpt + fixing commit" attached to the Report.
7. **Gate config belongs to Linus**: workflows / Makefile / task runner are maintained by Linus; changes are **convention changes** and require dual-signing and a `kind=change` trail (`PROTOCOL §13`).

## 4. Release SOP (Build & Release)
1. **Version number**: semantic `MAJOR.MINOR.PATCH`; update `CHANGELOG` on each release.
2. **Freeze**: before release, confirm the gate is all green and the pending content is frozen (no half-finished work).
3. **Reproducible build**: lock dependencies (lockfile) + pin the toolchain version; generate a `sha256` checksum for the artifact.
4. **Release steps**:
   - [ ] Gate all green (including build)
   - [ ] Update the version number + `CHANGELOG`
   - [ ] Tag (annotated; sign if signing is available)
   - [ ] Build the artifact + generate the checksum
   - [ ] **Smoke-test the artifact** (not just the source tests)
   - [ ] Publish / archive the artifact
5. **Release evidence goes into the Report**: `tag` + `commit hash` + CI run link + artifact `sha256` + smoke result.

## 5. Deploy SOP (Deploy)
1. **Environment layering**: `staging → production`; skipping staging is forbidden (emergency hotfixes must document the reason and be approved by Elon).
2. **Before deploy**: back up the current version / data; confirm the **rollback point**.
3. **During deploy**: execute via the established script / pipeline; **hand-editing production is forbidden**.
4. **After deploy**: smoke verification (health check + key paths); **roll back immediately** on failure.
5. **Rollback plan**: keep the previous stable version; leave a trail after rollback (time / reason / version).
6. **Record goes into the Report**: deployed version, time, environment, smoke result, rollback point.

## 6. Pre-Delivery Gate Checklist (merged into Linus's "Pre-Delivery Master Checklist")
- [ ] CI gate all green (including build)
- [ ] Release: tag + CHANGELOG + artifact hash + artifact smoke
- [ ] Deploy: backup/rollback point + deploy smoke
- [ ] Report contains gate and release/deploy evidence

## 7. Reference Relationships
- Quality / test thresholds: `PROTOCOL §6.1`
- Two-way document sync: `PROTOCOL §12`
- End-of-segment (heartbeat/terminal state/Report): `PROTOCOL §6`
- Task-change trail: `PROTOCOL §13.7` (`kind=change`)
