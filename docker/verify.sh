#!/usr/bin/env bash
#
# Host entry point: build the verification image and run the suite inside it.
# The suite itself lives in docker/verify-in-container.sh (single source of truth).
#
#   docker/verify.sh          # offline checks
#   docker/verify.sh --net    # also exercise the network fetch path
#
# Never runs verification on the host (project convention).

set -euo pipefail
cd "$(dirname "$0")/.."

IMG="${OPENCLAW_TEAM_IMAGE:-openclaw-team:verify}"

echo "== docker build ($IMG) =="
docker build -f docker/Dockerfile -t "$IMG" .

echo "== docker run (verify-in-container.sh) =="
if [ "${1:-}" = "--net" ]; then
  docker run --rm -e OPENCLAW_TEAM_NET=1 "$IMG" bash docker/verify-in-container.sh
else
  docker run --rm "$IMG" bash docker/verify-in-container.sh
fi
