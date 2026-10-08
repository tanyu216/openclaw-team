#!/usr/bin/env bash
#
# Host entry point for the ui-fidelity self-test (builds the pinned image and
# runs the checker against the bundled fixtures). Deterministic by construction.

set -euo pipefail
cd "$(dirname "$0")/../.."

IMG="${UI_FIDELITY_IMAGE:-openclaw-team:ui-fidelity}"

echo "== docker build ($IMG) =="
docker build -f docker/ui-fidelity/Dockerfile -t "$IMG" .

echo "== docker run (ui-fidelity self-test) =="
docker run --rm "$IMG" bash self-test.sh
