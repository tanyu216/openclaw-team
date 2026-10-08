# Registries — Auth, Rate Limits, Promotion, Retention, Signing

A registry is a content-addressed blob store with a tag index bolted on. Almost every registry problem comes from treating tags as identities, or from forgetting that deleting a tag deletes nothing.

**Contents:** [Names and What They Default To](#names-and-what-they-default-to) · [Authentication](#authentication) · [Pull Rate Limits and Mirrors](#pull-rate-limits-and-mirrors) · [Promotion Without Rebuilding](#promotion-without-rebuilding) · [Retention and Garbage Collection](#retention-and-garbage-collection) · [Private Registries and TLS](#private-registries-and-tls) · [Signing, SBOM, Provenance](#signing-sbom-provenance) · [Air-Gapped and Registry-to-Registry](#air-gapped-and-registry-to-registry) · [Registry Failure Signatures](#registry-failure-signatures)

**Before touching registry configuration**, read `## Registries` in `~/Clawic/data/docker/memory.md` — which registry holds what, how auth is provided, the mirror in front of Docker Hub and the retention policy already agreed are recorded there.

## Names and What They Default To

- `nginx` expands to `docker.io/library/nginx:latest`. `acme/app` expands to `docker.io/acme/app:latest`. Only a name containing a dot or a colon before the first slash is treated as a registry host — which is why `localhost:5000/app` works and `myregistry/app` silently means Docker Hub.
- `default_registry` in `config.yaml` is the host to prefix when the user writes an unqualified name. Docker Engine, unlike Podman, has no search-path concept: the daemon-level `registry-mirrors` setting redirects Docker Hub pulls only, it does not add alternative namespaces.
- A digest reference (`app@sha256:…`) ignores the tag entirely and is the only reference that cannot change under you (SKILL.md Rule 1).

## Authentication

- `docker login` writes to `~/.docker/config.json`. **The default `auths` entry is base64, which is encoding, not encryption** — anyone reading the file reads the password. Treat that file as a credential.
- Credential helpers keep the secret out of the file: `docker-credential-osxkeychain`, `-secretservice`, `-pass`, `-wincred`, plus provider helpers (`ecr-login`, `gcloud`, `acr`). Configure with `"credsStore": "<helper>"` for all registries or `credHelpers` per host.
- Short-lived tokens are the right shape in CI: the provider's OIDC-to-registry exchange, or `aws ecr get-login-password | docker login --password-stdin`. Never `--password` on the command line — it lands in shell history and in the process list.
- In memory files this is always a pointer, never a value: `keychain:ghcr-push`, `env:REGISTRY_TOKEN`, `1password:Work/Registry/ci`, `file:~/.docker/config.json` (`memory-template.md`).
- `docker logout <registry>` before handing a machine over; the config file survives user switches.

## Pull Rate Limits and Mirrors

- Docker Hub throttles anonymous pulls per source IP. The published thresholds have changed more than once, so read the current policy rather than designing against a remembered number — what is stable is the failure shape: a CI farm behind one NAT address hits the limit at random-looking times, and the error is `toomanyrequests: You have reached your pull rate limit`.
- Three fixes, in increasing order of durability: authenticate the pull (raises the limit), mirror the handful of base images you actually use into your own registry (removes the dependency), or run a pull-through cache in front of Docker Hub (removes it for everything at once).
- Pull-through cache: an OCI registry configured as a proxy to the upstream, pointed at with `registry-mirrors` in `daemon.json`. It caches on first pull and is invisible to the Dockerfile — which is the point, because it also removes the outage risk of a single upstream.
- A mirror does not cover `docker push`, private repositories, or non-Hub registries. It is a Hub read path, nothing more.

## Promotion Without Rebuilding

- **Rebuilding to promote is the bug.** If staging validated one image and prod builds another from the same source, they are different artifacts: different base digest, different transitive dependency versions, different build timestamp.
- Promote by moving a tag onto the digest that was tested: `docker buildx imagetools create -t app:prod app@sha256:…`. It writes a manifest reference; no layers move, no build runs.
- Immutable identity tag on every build (`app:<git-sha>`), movable tags (`latest`, `staging`, `prod`) as pointers only. Deploy by digest or by the sha tag, never by the movable one (`ci.md`).
- `docker buildx imagetools inspect app:tag` returns the digest and the platform list without pulling — the cheap assertion that the thing you are about to promote is the thing you built.
- Record the promoted digest in `deploys/<year>.md` at the moment of the deploy (SKILL.md Rule 9), because the movable tag will have moved before you need to roll back.

## Retention and Garbage Collection

- **Deleting a tag frees no space.** Blobs are shared and reference-counted; the storage comes back only when the registry's garbage collection runs. On a self-hosted `registry:2` that is `registry garbage-collect` with the registry in read-only mode — running it while writes are in flight can delete a blob a concurrent push is about to reference.
- Managed registries (ECR, GHCR, GAR, ACR, Harbor) have lifecycle policies instead: keep the last N tagged images per repository, expire untagged manifests after N days, expire `pr-*` tags after N days. **PR and branch tags are the disk leak nobody owns** — every CI pipeline creates them and no human deletes them.
- Untagged manifests accumulate invisibly whenever a movable tag is repointed. An expiry rule for untagged images is usually the single biggest reclaim.
- Attestations and cache manifests count as artifacts: a registry-backed build cache (`ci.md`) grows without bound unless it has its own retention rule. Give the `buildcache` tag a short expiry.
- Write the agreed policy into `## Registries` in `memory.md`. A retention rule that exists only in one person's console session gets reverted by the next person who reads a scary storage bill.

## Private Registries and TLS

- Self-signed or internal-CA registry: put the CA at `/etc/docker/certs.d/<host>:<port>/ca.crt` on every host that pulls. The port must be in the directory name when the registry uses a non-default port — the most common reason the file "does nothing".
- Client certificates go in the same directory as `client.cert` and `client.key`.
- `insecure-registries` in `daemon.json` disables verification, applies daemon-wide, and requires a daemon restart. It is a last resort for a lab, never a fix for a production pull failure.
- **The build container needs the CA too**, separately from the daemon: a `RUN` step that fetches from an internal HTTPS endpoint trusts only the image's own CA store (`networking.md`).
- Registries behind a reverse proxy need the proxy to pass through large bodies and to not buffer them; the symptom of a misconfigured proxy is pushes that fail only for large layers.

## Signing, SBOM, Provenance

- `cosign` keyless signing uses an OIDC identity from the CI provider and a transparency log, so there is no private key to rotate or leak — the right default for CI. Key-pair signing still fits air-gapped setups where the log is unreachable.
- Verification is worth nothing unless something enforces it: verify in the deploy step, or at an admission controller. A signature nobody checks is a build-time cost with no security return.
- BuildKit can attach SBOM and provenance attestations (`--sbom=true --provenance=true`). They land as extra manifest entries, which older tooling displays as an `unknown/unknown` platform and a few strict clients reject — verify your registry and deploy path accept them before turning them on in every pipeline.
- Scanning belongs at two points, not one: at build (blocks a bad image from being pushed) and in the registry on a schedule (catches CVEs published after the push). CI-only scanning approves images that rot in place (`security.md`, and the rebuild cadence in `## Due`).

## Air-Gapped and Registry-to-Registry

- `docker save` / `docker load` moves an image as a tarball through a daemon; it preserves layers and metadata but is single-platform and loses nothing except convenience. `docker export`/`import` flattens and **loses ENTRYPOINT, CMD and ENV** — never use it to move a runnable image.
- `skopeo copy docker://src docker://dst` moves images between registries without a daemon and without pulling to disk, preserving digests and multi-arch manifests. It is the correct tool for mirroring, and the only one that keeps the digest stable — which matters because a digest-pinned deployment breaks the moment a mirror changes it.
- Mirroring a base image into your own registry is also a supply-chain control: you pin what you vetted, and an upstream tag repoint cannot reach you.

## Registry Failure Signatures

| Error | Cause | First move |
|---|---|---|
| `unauthorized: authentication required` on pull of a public image | Stale or wrong credentials for that host in `config.json`, or a token expired mid-CI-run | `docker logout <host>` then retry anonymously to isolate |
| `denied: requested access to the resource is denied` on push | Authenticated, but the token lacks write scope, or the namespace does not exist | Check the token's scopes before checking the image name |
| `toomanyrequests` | Pull rate limit | Authenticate, mirror, or pull-through cache (above) |
| `manifest unknown` | Tag does not exist for this platform, or was deleted | `imagetools inspect` the repo; a multi-arch tag missing your arch reports this |
| `no matching manifest for linux/arm64` | Single-arch image, wrong host arch | Build multi-arch, or pull with `--platform` and accept emulation (`ci.md`) |
| `x509: certificate signed by unknown authority` | Registry CA not in `certs.d`, or the *build step* lacks the CA | Daemon-side and build-side are separate fixes (above) |
| `blob upload unknown` / push retries forever | Reverse proxy buffering or body-size limit in front of the registry | Test with a tiny image to confirm it is size-dependent |
| Push succeeds, pull gets an old image | Two registries with the same name in different contexts, or a mirror serving a cached manifest | Compare digests on both sides, never tags |
| Anything else | Read the error's HTTP status: 401/403 is auth, 404 is naming, 413/502 is the proxy, 429 is rate limiting | — |

**After any registry change that will outlive the session** — a registry added, a credential helper configured, a mirror or pull-through cache set up, a retention policy agreed, a rate limit hit — write the row in `## Registries` of `~/Clawic/data/docker/memory.md` with the auth as a pointer, never a token (`memory-template.md`). If the fix was a file with real content (a `certs.d` layout, a mirror's registry config), it is an `artifacts/` file with its `## Boxes` line in the same turn.
