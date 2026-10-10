#!/usr/bin/env bash
# spawn-lane.sh — 新 lane 起会话「单一入口」薄包装（核心 = scripts/spawn-lane.mjs）
# 用法：bash scripts/spawn-lane.sh <card> <owner> [seg=seg1] [backend=claude|codex] [phase=<p>] [--dry-run]
# 语义/理由见 guides/spawn-lane-sop.md；规范 PROTOCOL §⑥（禁直跑 claude -p 不登记）。
# 薄：不解析参数、不做业务判断，仅 exec node 转交核心（退出码透传：0 通过 / 1 拒绝 / 2 用法）。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/spawn-lane.mjs" "$@"
