# Language Runtimes — The Dockerfile Traps That Are Not Docker's

Most "Docker is broken" reports are a runtime behaving differently under a cgroup than on a laptop. Two failure families dominate: **the runtime sizes itself from the host instead of the limit**, and **a prebuilt native artifact does not match the image's libc or architecture**. Everything below is one of those two, or PID 1.

**Contents:** [Sizing Rule Every Runtime Shares](#sizing-rule-every-runtime-shares) · [Python](#python) · [Node](#node) · [Go](#go) · [Java and the JVM](#java-and-the-jvm) · [Rust](#rust) · [PHP](#php) · [Ruby](#ruby) · [.NET](#net) · [Choosing the Runtime Base](#choosing-the-runtime-base)

**Before writing a Dockerfile for a stack you have touched before**, read `## Stacks` in `~/Clawic/data/docker/memory.md` (or `stacks.md` if `## Boxes` points there) and any `artifacts/dockerfile-<service>.md` it indexes. The worker count, the heap flag and the base-image exception were derived once already.

## Sizing Rule Every Runtime Shares

A container limit is a cgroup value; most runtimes read `/proc` and see the host. Two numbers must be set explicitly, every time:

- **Heap or equivalent at ~75% of the container memory limit.** The remaining 25% is thread stacks, native allocations, the metaspace, and the page cache the kernel charges to your cgroup. A runtime given 100% of the limit OOMs on its first native burst, and the exit code (137) blames Docker.
- **Worker/thread count from the CPU limit, never from `cpu_count()`.** `os.cpu_count()`, `runtime.NumCPU()`, `Runtime.availableProcessors()` on older JVMs, and `nproc` all report host cores. On a 64-core build machine a `--cpus 1` container spawns 64 workers, each with its own heap, and dies before serving a request.

Worked example, `-m 1g --memory-swap 1g --cpus 1.5`: JVM `-XX:MaxRAMPercentage=75` (750 MB heap), Node `--max-old-space-size=768`, gunicorn `--workers 3` (`2 × 1.5` rounded, not `2 × host + 1`).

## Python

- **`PYTHONUNBUFFERED=1` is not optional.** Without a TTY, stdout is block-buffered: `docker logs` shows nothing until the buffer fills or the process exits, and a crashed container looks silent. This is the single most reported "Docker ate my logs".
- `PYTHONDONTWRITEBYTECODE=1` keeps `.pyc` files out of layers and out of bind-mounted source trees.
- **Alpine costs more than it saves for Python.** manylinux wheels are glibc; on musl, pip falls back to compiling from source, so `pandas`, `numpy`, `psycopg2`, `cryptography`, `lxml` and `pillow` turn a 30-second install into a multi-minute build that also needs a compiler in the image. `python:3.x-slim` is the default; Alpine only for pure-Python dependency sets.
- Multi-stage with a venv is the portable pattern: build into `/opt/venv`, then `ENV PATH="/opt/venv/bin:$PATH"` and `COPY --from=builder /opt/venv /opt/venv`. It moves compilers and headers out of the runtime image without per-package surgery. `pip install --user` breaks the moment `USER` changes, because `~/.local` follows the home directory.
- Cache the wheel downloads instead of disabling the cache: `RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt` beats `--no-cache-dir`, which only shrinks a layer you were about to discard anyway (`images.md`).
- `uv` and `poetry`: install from the lockfile with the frozen flag (`uv sync --frozen --no-dev`, `poetry install --no-root --only main`) so a resolver run cannot happen inside the build and produce a different image than CI produced.
- Gunicorn/uvicorn: workers from the CPU limit (above). Gunicorn handles SIGTERM correctly as PID 1; a bare `python app.py` in shell form does not (SKILL.md Rule 4).
- `psycopg2` vs `psycopg2-binary`: the binary wheel is convenient and ships its own libpq; mixing it with a system libpq in the same image produces segfaults (exit 139) that look like a Docker bug.

## Node

- **Node installs no SIGTERM handler, so as PID 1 it ignores it.** `docker stop` then always waits the full grace period and SIGKILLs, dropping in-flight requests. Fix with `--init`/`init: true`, or `process.on('SIGTERM', …)` with a real server close. Exec form alone is not enough here (SKILL.md Rule 4).
- **`npm ci` not `npm install`** in every image: it requires the lockfile, deletes `node_modules` first, and refuses to silently update the lock — the only way a CI build and a local build produce the same tree.
- **Native modules are compiled for one arch and one libc.** `bcrypt`, `sharp`, `canvas`, `better-sqlite3`, `node-gyp` output: an arm64 macOS `node_modules` bind-mounted into an amd64 Linux container fails with an "invalid ELF header" or a missing `.node`. Never mount host `node_modules`; shadow it with an anonymous volume (`-v /app/node_modules`) or keep dependencies inside the image (`development.md`).
- Alpine and `sharp`/`canvas`: prebuilt binaries target glibc, so musl forces a source build with `vips`/`cairo` headers. slim is the cheaper default.
- `NODE_ENV=production` before the install skips devDependencies — which breaks any image that must run `tsc`, `vite build` or `next build`. Correct order: install everything → build → either `npm prune --omit=dev` or copy only `dist` and a production install into a runtime stage.
- Heap: `--max-old-space-size=<MB>` at ~75-80% of `-m`. Node's default old-space sizing is derived from what it believes is available memory, and under a container limit that guess is wrong often enough that "explicit" is the only safe posture.
- `npm` cache mount: `RUN --mount=type=cache,target=/root/.npm npm ci`.

## Go

- **`CGO_ENABLED=0` produces a genuinely static binary** that runs on `scratch` or `gcr.io/distroless/static`. Leave CGO on and you need glibc at runtime (`distroless/base`, or an Alpine image built with musl) — the classic break is a CGO binary built on Debian and run on Alpine: exit 127, "not found", which is the dynamic loader missing, not the file.
- **`scratch` has no CA bundle and no timezone database.** Every HTTPS call fails with `x509: certificate signed by unknown authority` and every `time.LoadLocation` fails. Copy `/etc/ssl/certs/ca-certificates.crt` from the builder, or use `distroless/static`, which includes both.
- Cache both Go caches or the build is cold every time: `--mount=type=cache,target=/root/.cache/go-build` and `--mount=type=cache,target=/go/pkg/mod`.
- `COPY go.mod go.sum ./` → `RUN go mod download` → then the source. Skipping this re-downloads the whole module graph on every source edit.
- `-ldflags="-s -w"` strips the symbol table and DWARF: typically a fifth to a third off the binary, at the cost of readable stack symbols in a profiler. Ship it in prod images, not in ones you profile.
- Cross-compile instead of emulating: `GOOS=linux GOARCH=arm64 go build` inside an amd64 builder beats QEMU by a wide margin for multi-arch (`ci.md`).
- No shell on `scratch`: a `HEALTHCHECK` must exec your own binary with a flag, and debugging is a sidecar sharing the network namespace (`commands.md`).

## Java and the JVM

- **`MaxRAMPercentage` defaults to 25%.** A 2 GB container hands the heap 512 MB and the app spends its life in GC while `docker stats` shows plenty of headroom. Set `-XX:MaxRAMPercentage=75` — percentage, not `-Xmx`, so the same image behaves correctly at every limit.
- Container awareness (`UseContainerSupport`) is on by default from JDK 10 and backported to 8u191. Anything older reads host memory and host CPU: a 512 MB container on a 32 GB host sizes a multi-gigabyte heap and is killed at startup (`debug.md`).
- **Layered jars are the single biggest build win.** A fat jar changes entirely on every commit, so every deploy pushes ~60 MB. Spring Boot's `layertools` (or an equivalent split) puts dependencies in their own layer, and a code-only change pushes kilobytes.
- `jlink`/`jdeps` produce a custom runtime containing only the modules used — meaningfully smaller than shipping a full JRE layer, and worth the build complexity for images that are pulled often.
- Startup: AppCDS (`-XX:SharedArchiveFile`) cuts class-loading time on every container start, which matters when the scheduler restarts you frequently.
- Graceful shutdown: the JVM runs shutdown hooks on SIGTERM, but only if the framework registered one and the grace period outlasts in-flight requests. Set `stop_grace_period` above the app's drain timeout, not the other way round.

## Rust

- **`cargo-chef` is the dependency-cache pattern.** Without it, editing one source file rebuilds every crate in the graph, because `cargo` sees a changed workspace. The recipe step compiles dependencies against a manifest-only skeleton, and that layer survives source edits.
- Also mount the caches: `--mount=type=cache,target=/usr/local/cargo/registry` and `target=/app/target`. Cargo's `target/` dir is large; a cache mount keeps it out of the image entirely.
- Static: `x86_64-unknown-linux-musl` gives a `scratch`-ready binary, but `openssl-sys` will not cross to musl without vendored OpenSSL. Switching to `rustls` removes the problem instead of solving it.
- Dynamic: build on the same distro family you run on, and use `distroless/cc` (it carries glibc and libgcc) rather than `scratch`.
- `--release` in the builder stage only; a debug binary is several times larger and slower, and it is easy to ship one by accident when the build stage is copied from a local script.

## PHP

- The official `php` images ship without most extensions: `docker-php-ext-install pdo_mysql opcache` and `pecl install redis` in the builder, with `docker-php-ext-enable` after. `docker-php-ext-configure` is required before installing extensions with library options (`gd`, `intl`).
- **Opcache is off in the CLI image and under-configured elsewhere.** In production set `opcache.enable=1`, `opcache.validate_timestamps=0` (the container is immutable, so revalidation is pure waste) and a `memory_consumption` sized to the codebase — this is usually the largest single performance change in a PHP container.
- php-fpm + a web server is two containers sharing a volume for static assets, or one container with a supervisor. Two containers is the default; the shared-volume detail is what people forget, and the symptom is a 404 on every asset while PHP routes work.
- `composer install --no-dev --optimize-autoloader --no-scripts` in the builder; copy `vendor/` into the runtime stage. Composer itself does not belong in the runtime image.

## Ruby

- `BUNDLE_DEPLOYMENT=1` and `BUNDLE_WITHOUT=development:test` make the install reproducible and keep test gems out. Set them as ENV so every later `bundle` call inherits them.
- Native gems (`nokogiri`, `pg`, `mysql2`, `ffi`) need headers and a compiler. Install them in a builder stage, copy the resulting gem directory into a runtime stage that has only the shared libraries.
- `nokogiri` ships precompiled platform gems; forcing `--platform ruby` (source build) is a common accidental slowdown of several minutes per build.
- Puma: workers from the CPU limit, threads from the connection pool size — a pool smaller than the thread count is a silent queue nobody instrumented.

## .NET

- Two images, always: build with `mcr.microsoft.com/dotnet/sdk`, run with `mcr.microsoft.com/dotnet/aspnet` or `runtime`. Shipping the SDK multiplies the image size for nothing.
- **The aspnet images listen on port 8080 as a non-root user from .NET 8 onward** (it was 80 before). A compose file or reverse proxy carried over from an older version points at the wrong port and reports connection refused.
- `dotnet restore` in its own layer from the `.csproj`/`.sln` files, then copy the source — the same manifest-first ordering as everywhere else (SKILL.md Rule 2).
- `--self-contained` plus trimming removes the runtime dependency and shrinks the image, but trimming breaks reflection-heavy code silently at runtime; test the trimmed artifact, not the untrimmed one.
- `DOTNET_RUNNING_IN_CONTAINER=1` is set in the official images and some libraries branch on it — do not clear the environment wholesale in a derived image.

## Choosing the Runtime Base

| Runtime | Default base | Escape hatch |
|---|---|---|
| Python | `python:3.x-slim` | Alpine only when every dependency is pure Python; distroless when there is no shell requirement and the venv is copied whole |
| Node | `node:22-slim` | distroless/nodejs for prod once debugging is sidecar-based; Alpine only without native modules |
| Go | `scratch` or `distroless/static` (CGO off) | `distroless/base` when CGO is on |
| Java | `eclipse-temurin:*-jre` or a jlink runtime | distroless/java when the shell is not needed |
| Rust | `distroless/cc` | `scratch` with a musl static build |
| PHP | `php:8.x-fpm` | Alpine variants are workable here — the extension build is explicit anyway |
| Ruby | `ruby:3.x-slim` | Alpine costs native-gem build time |
| .NET | `dotnet/aspnet` | `dotnet/runtime-deps` with a self-contained trimmed publish |

**After a language-specific fix that will be needed again** — a heap flag, a worker count, a base-image exception, a native-module workaround — write it where it will be found: the row in `## Stacks` of `memory.md` for a one-liner, `artifacts/dockerfile-<service>.md` for the whole file with its reasoning (`memory-template.md`). Deriving the gunicorn worker count from a CPU limit twice is a tax nobody notices paying.
