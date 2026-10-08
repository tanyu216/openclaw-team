# Runtimes — Desktop, colima, OrbStack, Rootless, Podman, GPU

"Docker" on the user's machine is one of half a dozen implementations with different sockets, different VM ceilings and different privilege rules. The wrong assumption here produces bugs that look like application bugs. Which one is in play is `runtime_flavor` in `config.yaml`; when it is unset, `docker context ls` and `docker info` answer it in one command each.

**Contents:** [Socket Paths and DOCKER_HOST](#socket-paths-and-docker_host) · [The VM Ceiling (macOS and Windows)](#the-vm-ceiling-macos-and-windows) · [File Sharing Performance](#file-sharing-performance) · [Rootless](#rootless) · [Podman](#podman) · [GPU Containers](#gpu-containers) · [Windows Containers](#windows-containers) · [Choosing](#choosing)

**Before diagnosing anything that smells like a platform difference**, read `## Environment` in `~/Clawic/data/docker/memory.md` — the VM ceiling, the socket override and the SELinux posture of this machine were recorded the first time they cost an hour.

## Socket Paths and DOCKER_HOST

| Flavor | Socket | Notes |
|---|---|---|
| Docker Desktop (macOS) | `~/.docker/run/docker.sock` | Offers an opt-in symlink at `/var/run/docker.sock`; off by default in recent versions |
| Docker Desktop (Windows) | `npipe:////./pipe/docker_engine` | WSL2 backend also exposes a socket inside the distro |
| colima | `~/.colima/<profile>/docker.sock` | `colima start` sets the context; `default` is the usual profile name |
| OrbStack | `~/.orbstack/run/docker.sock` | Creates its own context and a `/var/run/docker.sock` symlink |
| Engine on Linux | `/var/run/docker.sock` | Group `docker` membership is root-equivalent (`security.md`) |
| Rootless | `$XDG_RUNTIME_DIR/docker.sock` | Usually `/run/user/<uid>/docker.sock` |
| Podman | `$XDG_RUNTIME_DIR/podman/podman.sock` | Only after `podman system service` or the socket unit is enabled |

- **Anything that hardcodes `/var/run/docker.sock` breaks on a VM-based runtime**: testcontainers, some CI agents, tools that mount the socket into a helper container. Fix with `DOCKER_HOST=unix://<real path>`, and for testcontainers also `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock` so the value it advertises *inside* containers stays valid.
- `docker context use <name>` is the clean switch between runtimes; `DOCKER_HOST` overrides the context and is the reason a command works in one shell and not another. When two runtimes are installed, check both before believing a "daemon not running" error.
- `host.docker.internal` resolves natively on Desktop, OrbStack and colima. On plain Linux Engine it does not exist until you pass `--add-host=host.docker.internal:host-gateway` (`networking.md`).

## The VM Ceiling (macOS and Windows)

Every non-Linux runtime runs containers inside a Linux VM with a fixed memory and CPU allocation. The container limit you set is bounded by the VM, not by the laptop.

- `docker info` reports `Total Memory` — that is the VM's, not the host's. A `-m 8g` container on a VM allocated 4 GB is killed at 4 GB and the exit code says 137, which reads as an application leak.
- The build itself runs in the VM: a build that OOMs while compiling native modules usually needs a bigger VM, not a bigger `-m`.
- Raising the allocation: Desktop's settings, `colima start --memory N --cpu N` (recreating the VM), OrbStack's settings. Leave headroom for the host — allocating every core makes the whole machine unresponsive under a parallel build and the build gets blamed.
- Disk is also a VM disk: `docker system df` can show room while the VM's virtual disk is full. Desktop and colima both need an explicit disk resize; pruning inside a full VM disk can fail for lack of space to write the new metadata.
- **Record the ceiling once.** The VM's memory and disk size belong in `## Environment` of `memory.md`, because every future limit recommendation depends on them.

## File Sharing Performance

- Bind mounts cross the VM boundary on macOS and Windows regardless of the sharing implementation (VirtioFS, gRPC-FUSE, OrbStack's own). Throughput is fine; **per-file latency is what kills you**, so directories with tens of thousands of small files — `node_modules`, `.venv`, `vendor/`, `target/`, build caches, database data dirs — must live in named volumes, with the source bind-mounted around them (`storage.md`, `development.md`).
- File-change events do not always propagate across the boundary: watchers that rely on inotify miss edits and the app never reloads. Polling is the fallback (`development.md`).
- WSL2: keep the project inside the Linux filesystem (`\\wsl$\...`), not on `/mnt/c`. Cross-filesystem access there is an order of magnitude slower and is the single most common "Docker is slow on Windows".
- Linux Engine has no boundary and none of this applies — which is why a performance complaint always starts with which flavor is running.

## Rootless

Rootless Docker runs the daemon and containers as an unprivileged user, which removes the biggest single risk (a daemon compromise being host root) and adds constraints that are easy to misread as bugs:

- **Ports below 1024 cannot be bound** unless `net.ipv4.ip_unprivileged_port_start` is lowered or `CAP_NET_BIND_SERVICE` is granted to `rootlesskit`. Publish on 8080 and reverse-proxy, which is the better shape anyway.
- **The container sees a different UID map.** A file owned by UID 1000 on the host appears owned by a subuid inside; bind-mount permission fixes that work rootful do not transfer. `--userns-keep-id`-style behavior is Podman's; on rootless Docker, plan around numeric ownership from the start (`storage.md`).
- Storage driver: native `overlay2` in rootless requires a recent kernel with unprivileged overlayfs; otherwise it falls back to `fuse-overlayfs`, which is noticeably slower for builds with many layers. `docker info` names the driver in use.
- Resource limits need cgroup v2 with systemd delegation. Without it, `-m` and `--cpus` are silently ineffective — a limit that does nothing is worse than no limit, because the design assumed it.
- `--network host`, some mount types, and anything needing a real capability behave differently or not at all. Treat a rootless failure as a privilege question before treating it as a Docker question.

## Podman

Docker-compatible enough that most commands transfer, different enough that the gaps matter:

- **No daemon.** There is nothing to restart, and nothing to keep containers running across a reboot: `restart: always` has no supervisor behind it. The replacement is systemd — Quadlet units (`.container` files) or `podman generate systemd` for older versions. A Compose file translated one-for-one loses its restart semantics silently.
- `podman-docker` provides a `docker` shim, and `podman system service` exposes a Docker-API socket so Compose, testcontainers and buildx clients can talk to it.
- **Rootless by default**, so everything in the Rootless section applies, plus `--userns=keep-id` to make bind-mount ownership match the invoking user — the flag that removes most Podman permission complaints.
- Networking uses netavark with DNS enabled on the default network too, so the classic Docker trap ("no DNS on the default bridge") does not reproduce — which means a compose file that only works on Podman may still be broken on Docker.
- SELinux: Podman is common on Fedora/RHEL, where every bind mount needs `:z` (shared) or `:Z` (private) or access dies with EACCES no matter what the UIDs say (`storage.md`).
- Pods are a first-class concept: containers can share a network namespace directly, which is closer to a Kubernetes pod than to a Compose network.

## GPU Containers

- `--gpus all` (or Compose `deploy.resources.reservations.devices`) requires the NVIDIA Container Toolkit installed and configured on the **host**; without it the flag errors out or is silently ignored depending on version.
- **The driver comes from the host, the CUDA userspace comes from the image.** A CUDA 12.x image on a host driver too old fails at runtime with a version-mismatch error, not at pull time. Match the image's CUDA major version to what the host driver supports before debugging the application.
- Verify the plumbing before the workload: run a bare `nvidia-smi` inside the image. If it does not list the GPU, nothing above it will work.
- Not available on macOS at all — no runtime there passes a GPU through. A team with arm64 laptops and GPU training runs builds multi-arch images and tests the GPU path only on the Linux host (`ci.md`).
- Memory limits do not cover VRAM: `-m` bounds host RAM only, and an out-of-VRAM failure surfaces as a framework exception, not as exit 137.

## Windows Containers

- Windows containers and Linux containers are different daemon modes; Desktop switches between them and only one is active at a time. A Linux image simply will not run in Windows mode.
- **Process isolation requires the container's base image build number to match the host's.** A mismatch forces Hyper-V isolation (heavier, slower) or fails outright — the reason a Windows image that ran on one server fails on a differently patched one.
- Images are large (hundreds of MB minimum for nanoserver, several GB for servercore). Layer discipline matters more here, not less.

## Choosing

| Situation | Flavor | Why |
|---|---|---|
| Linux workstation or server | Engine (rootful) | No VM boundary, full feature set, simplest mental model |
| macOS, wants it to just work | Desktop or OrbStack | Native `host.docker.internal`, managed VM; OrbStack is lighter on battery and startup |
| macOS, wants no licence question and a scriptable VM | colima | Plain Lima VM, explicit `--memory`/`--cpu`, easy to destroy and recreate |
| Multi-tenant or untrusted workloads | Rootless or Podman | Daemon compromise stops being host root |
| Fedora/RHEL host, systemd-managed services | Podman + Quadlet | Units are the supervisor; matches the platform's service model |
| GPU training or inference | Engine on Linux + NVIDIA toolkit | The only combination that passes a GPU through |
| Anything else | Whatever `runtime_flavor` says, Desktop if unset | State the assumption before giving flavor-specific advice |

**When a flavor-specific fact costs time to establish** — the socket override this machine needs, the VM's memory and disk ceiling, the SELinux relabel requirement, the CUDA/driver pairing that works — write it as a line in `## Environment` of `~/Clawic/data/docker/memory.md` in the same turn (`memory-template.md`). If the machine is a host others use, its row belongs in the shared inventory `~/Clawic/data/servers/servers.md` with `docker host` in `Role`.
