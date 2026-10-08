# Development — The Local Loop That Does Not Fight You

The production Dockerfile and the development loop have opposite goals: production wants a small, immutable, non-root artifact; development wants your editor's next keystroke visible in a second. Trying to satisfy both with one image is why dev containers get a reputation for being slow.

**Contents:** [The Two-Target Rule](#the-two-target-rule) · [Hot Reload](#hot-reload) · [compose watch](#compose-watch) · [Dependency Directories](#dependency-directories) · [Seeding Databases](#seeding-databases) · [Attaching a Debugger](#attaching-a-debugger) · [Devcontainers](#devcontainers) · [Testcontainers and Ephemeral Services](#testcontainers-and-ephemeral-services) · [Local TLS and Hostnames](#local-tls-and-hostnames) · [Keeping It Fast](#keeping-it-fast)

**Before setting up a loop for a stack that already exists**, read `## Stacks` and `## Environment` in `~/Clawic/data/docker/memory.md` — the polling requirement, the anonymous-volume shadow and the seed workaround for this project were solved once already.

## The Two-Target Rule

One Dockerfile, named stages, two targets:

```dockerfile
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS dev          # dev target: full deps, source bind-mounted at run time
CMD ["npm","run","dev"]

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-slim AS prod  # prod target: no dev deps, non-root, exec form
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=deps  --chown=10001:10001 /app/node_modules ./node_modules
USER 10001
CMD ["node","dist/server.js"]
```

- Compose selects with `build: {context: ., target: dev}`. Both targets share the `deps` layer, so switching between them costs nothing.
- Two separate Dockerfiles drift within a month: the dev one gets a dependency the prod one lacks, and the first CI failure after that is unexplainable from the diff.
- The dev target may run as root; say so deliberately rather than by omission, because a `USER 10001` in dev makes every bind-mounted file unwritable (`storage.md`).

## Hot Reload

Three things must all be true, and only the first is obvious:

1. **The source is bind-mounted** into the path the process actually runs from — `./src:/app/src`, not `./:/app` if `/app` also holds build output.
2. **The watcher can see the events.** On macOS and Windows, filesystem events do not reliably cross the VM boundary, so inotify-based watchers miss edits and nothing reloads. Polling is the fallback: `CHOKIDAR_USEPOLLING=true` (nodemon, Vite, webpack-dev-server through chokidar), `WATCHPACK_POLLING=true` (webpack 5/Next), `uvicorn --reload` with `--reload-dir`, `WATCHFILES_FORCE_POLLING=true` for watchfiles. Polling costs CPU — scope it to the source directory, never to `/app` with `node_modules` inside.
3. **The process restarts, not the container.** A reload tool inside the container is faster than `restart: on-failure` bouncing the whole container, and it keeps the debugger attached.

Symptom map: edits ignored entirely → the mount is wrong or the path differs; edits seen but no restart → watcher needs polling; restart happens but old code runs → the image was baked with the source and the mount is shadowed by it; CPU pinned at idle → polling over a dependency tree.

## compose watch

Compose v2.22 and later has `develop.watch`, which removes the bind-mount-plus-polling stack for many projects:

```yaml
services:
  web:
    build: {context: ., target: dev}
    develop:
      watch:
        - action: sync
          path: ./src
          target: /app/src
        - action: rebuild
          path: package-lock.json
        - action: sync+restart
          path: ./config
          target: /app/config
```

- `sync` copies changed files into the running container — no bind mount, so no VM-boundary latency and no inotify problem.
- `rebuild` is for files that change the image (lockfiles, the Dockerfile itself); it is the correct answer to "I added a dependency and the container does not have it".
- `sync+restart` for config the process reads only at startup.
- Started with `docker compose watch`, not `up`. A team half-using it is confusing — pick one loop and record which in `config.yaml` under `tooling`.

## Dependency Directories

The rule: **dependency trees never cross the VM boundary and never come from the host.**

- Node: `-v ./:/app -v /app/node_modules` — the second, anonymous volume shadows the host directory so the container keeps the modules it installed. Host modules are compiled for the host's arch and libc and will fail in the container (`languages.md`).
- Python: keep the venv at `/opt/venv` outside the mounted tree, or shadow `/app/.venv` the same way.
- Rust/Go/Java: `target/`, the module cache and `~/.m2` belong in named volumes, both for speed and because their contents are platform-specific.
- Symptom of getting this wrong: `Error: Cannot find module` or `invalid ELF header` immediately after a mount that "worked yesterday" on a different machine.

## Seeding Databases

- **`/docker-entrypoint-initdb.d` runs only when the data directory is empty.** Postgres, MySQL and Mongo all behave this way. Adding a new `.sql` file to an existing volume does nothing, silently — this is the most common "my migration did not run".
- To re-seed: `docker compose down -v` (destroys the volume — destructive, confirm first), or drop and recreate the database from a one-shot service.
- The durable shape is a separate migration service that runs to completion before the app starts: `depends_on: {db: {condition: service_healthy}, migrate: {condition: service_completed_successfully}}`. Idempotent migrations beat init scripts because they also work on the second run.
- Seed data belongs in the repository, not in a volume backup. A volume that only exists on one laptop is the reason new joiners cannot start the stack.
- Anonymized production dumps: restore into a named volume once, then snapshot that volume as a tarball for the team (`storage.md`) — faster than replaying a multi-gigabyte dump per developer.

## Attaching a Debugger

Three things, and the third is what people miss:

1. **The debug port is published**: `-p 9229:9229` (Node), `-p 5678:5678` (Python debugpy), `-p 5005:5005` (JDWP), `-p 2345:2345` (Delve).
2. **The debugger listens on `0.0.0.0`**, not the loopback: `node --inspect=0.0.0.0:9229`, `debugpy.listen(("0.0.0.0", 5678))`, JDWP `address=*:5005`. A debugger bound to `127.0.0.1` inside the container is unreachable no matter what you publish (`networking.md`).
3. **Source paths are mapped.** The editor knows `/Users/me/project/src/app.js`; the runtime reports `/app/src/app.js`. Without a `localRoot`/`remoteRoot` (VS Code), path mapping (PyCharm), or module path mapping (JetBrains JVM), breakpoints attach to nothing and show as unverified. This is the entire explanation for "grey breakpoints in Docker".

Waiting for the debugger before the app starts (`--inspect-brk`, `debugpy --wait-for-client`) is how you debug a startup crash; leave it off otherwise or the container never becomes healthy.

## Devcontainers

- `.devcontainer/devcontainer.json` describes the environment the editor attaches to: an image or a Dockerfile or a compose service, plus features, extensions and post-create commands. It is a spec several editors implement, not a Docker feature.
- `dockerComposeFile` + `service` attaches to a service inside your existing stack — the correct choice when the app needs a database, rather than a standalone container that then cannot reach anything.
- **UID mismatch is the recurring pain on Linux**: files created inside the container are owned by the container user. `remoteUser` plus `updateRemoteUserUID` (default true) remaps to your host UID; on macOS the VM's file sharing hides the problem, which is why it only appears when a Linux user joins the team.
- `postCreateCommand` runs once per container creation, `postStartCommand` on every start. Dependency installation belongs in the image or in `postCreate`, never in `postStart`, or every restart costs minutes.
- Features are composable installers, but each adds layers and build time; three or four is convenient, a dozen is a slow rebuild on every joiner's first day.

## Testcontainers and Ephemeral Services

- Testcontainers starts real dependencies per test run and tears them down; it needs a reachable Docker socket, which on VM runtimes means `DOCKER_HOST` and often `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` (`runtimes.md`).
- The Ryuk sidecar performs cleanup after the test process dies. Disabling it (`TESTCONTAINERS_RYUK_DISABLED=true`) is common in restricted CI and leaves orphan containers behind — pair it with an explicit cleanup step or the runner accumulates them.
- Container reuse (`withReuse` plus `testcontainers.reuse.enable=true` in `~/.testcontainers.properties`) turns a multi-second startup per suite into a one-time cost locally. It is a local optimization: never rely on it in CI, where a reused container is a shared-state bug waiting for a flaky test.
- Compose profiles are the lighter alternative for services you want sometimes: `profiles: [tools]` on a service keeps it out of a plain `up` and starts it with `--profile tools`.

## Local TLS and Hostnames

- A reverse proxy in front of the stack (`traefik`, `caddy`, nginx) gives every service a hostname and one TLS terminus, which removes the port-number juggling that makes local setups unmemorable.
- Any `*.localhost` name resolves to loopback on most modern resolvers without touching `/etc/hosts`; where it does not, one wildcard entry or a local DNS responder is less maintenance than a growing hosts file.
- Locally trusted certificates come from a local CA added to the system trust store. The container is a separate trust store: mount the CA and run the distro's update command, or the app inside sees an unknown authority while the browser is happy (`networking.md`).
- Third-party callbacks (OAuth, webhooks) need a public URL; a tunnel is the standard answer, and the thing to check first is that the app's configured base URL matches the tunnel's, not `localhost`.

## Keeping It Fast

In the order that pays:

1. `.dockerignore` before anything else — a build context carrying `.git`, `node_modules` and build output is uploaded on every build (`images.md`).
2. Dependency layer before source (SKILL.md Rule 2), then cache mounts for the package manager's downloads.
3. Dependency trees in named volumes, not on the host (above).
4. `compose watch` sync, or scoped polling — never polling over a dependency tree.
5. Give the VM enough memory and enough cores, but not all of them (`runtimes.md`).
6. Prune on a schedule rather than in a panic; a build host at 95% disk is slow before it is broken (`production.md`, `## Due`).

**When the loop finally works**, the compose file or dev target that made it work goes to `~/Clawic/data/docker/artifacts/<kebab-name>.md` with a line saying when to read it, and its `## Boxes` line in `memory.md` in the same turn (`memory-template.md`). The polling flag, the anonymous-volume shadow and the seed workaround are exactly the details that get rediscovered by the next person, including you in four months.
