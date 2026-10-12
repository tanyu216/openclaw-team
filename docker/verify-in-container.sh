#!/usr/bin/env bash
#
# openclaw-team verification suite — runs *inside* the container.
#
# This is the single source of truth for "is the repository healthy": CI and
# local `docker/verify.sh` both invoke exactly this script, so a green local run
# and a green CI run mean the same thing.
#
#   docker run --rm openclaw-team:verify bash docker/verify-in-container.sh
#
# Offline by default. Set OPENCLAW_TEAM_NET=1 to also exercise the network path
# (fetch skills from their upstream sources).
#
# Each step prints a `== ... ==` header; any failure exits non-zero immediately.

set -euo pipefail
cd "$(dirname "$0")/.."

step() { echo; echo "== $* =="; }

KHOME=/tmp/vhome
rm -rf "$KHOME" && mkdir -p "$KHOME"

step "shell syntax"
bash -n install.sh
bash -n docker/verify-in-container.sh
bash -n docker/verify.sh

step "node syntax"
node --check skills/fetch.mjs
node --check skills/update.mjs
node --check config/optimization.mjs
node --check config/reconcile.mjs

step "install unit tests (node:test — optimization backfill + reconcile + dry-run)"
node --test 'test/install/'*.test.mjs

step "skills update tests (node:test — ref drift detect / zero-write default / --apply + tree_sha256)"
node --test 'test/skills/'*.test.mjs

step "manifest + lock integrity (0 unresolved required)"
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("skills/manifest.json", "utf8"));
const l = JSON.parse(fs.readFileSync("skills/lock.json", "utf8"));
if (!Array.isArray(m.skills) || !Array.isArray(l.skills)) { console.error("bad shape"); process.exit(1); }
const bad = m.skills.filter(s => !s.name || !Array.isArray(s.targets) || !s.targets.length || !s.source || !s.source.kind);
if (bad.length) { console.error("entries missing fields:", bad.map(b => b.name)); process.exit(1); }
const un = m.skills.filter(s => s.source.kind === "unknown");
if (un.length) { console.error("unresolved sources:", un.map(s => s.name)); process.exit(1); }
const dup = m.skills.map(s => s.name + "|" + JSON.stringify(s.source)).filter((v, i, a) => a.indexOf(v) !== i);
if (dup.length) { console.error("duplicate entries:", dup); process.exit(1); }
console.log(`manifest ${m.skills.length} entries · lock ${l.skills.length} entries · 0 unresolved · 0 duplicate`);
'

step "skills fetcher dry-run (no network)"
node skills/fetch.mjs --openclaw-home "$KHOME/.openclaw" --claude-home "$KHOME/.claude" --codex-home "$KHOME/.codex" --dry-run | tail -1

step "installer dry-run (isolated HOME)"
HOME="$KHOME" ./install.sh --openclaw-home "$KHOME/.openclaw" --claude-home "$KHOME/.claude" --codex-home "$KHOME/.codex" --no-meerkat-taskpanel --skip-skills --no-register --skip-config --dry-run | tail -1

step "installer real run (file deploy; isolated HOME; no network)"
HOME="$KHOME" ./install.sh --openclaw-home "$KHOME/.openclaw" --claude-home "$KHOME/.claude" --codex-home "$KHOME/.codex" --no-meerkat-taskpanel --skip-skills --no-register --skip-config >/dev/null
for f in .openclaw/team/PROTOCOL.md .openclaw/team/guides/ci-release-sop.md .openclaw/team/guides/task-interface.md .openclaw/team/.install-state.json; do
  [ -f "$KHOME/$f" ] || { echo "missing after install: $f"; exit 1; }
done
for f in .openclaw/workspace-elon/AGENTS.md .openclaw/workspace-linus/AGENTS.md; do
  [ -f "$KHOME/$f" ] || { echo "missing role workspace: $f"; exit 1; }
done
echo "deployed files ok"

step "install/upgrade path (idempotent + backup)"
echo "# local edit" >> "$KHOME/.openclaw/team/PROTOCOL.md"
echo "my prefs" >> "$KHOME/.openclaw/workspace-elon/USER.md"
HOME="$KHOME" ./install.sh --openclaw-home "$KHOME/.openclaw" --claude-home "$KHOME/.claude" --codex-home "$KHOME/.codex" --no-meerkat-taskpanel --skip-skills --no-register --skip-config >/dev/null
[ -n "$(find "$KHOME/.openclaw/team/.backups" -name PROTOCOL.md 2>/dev/null)" ] || { echo "no backup written on upgrade"; exit 1; }
grep -q "local edit" "$KHOME/.openclaw/team/.backups"/*/team/PROTOCOL.md || { echo "backup missing edit"; exit 1; }
grep -q "my prefs" "$KHOME/.openclaw/workspace-elon/USER.md" || { echo "USER.md was clobbered"; exit 1; }
echo "upgrade + backup + user-file preservation ok"

if [ "${OPENCLAW_TEAM_NET:-0}" = "1" ]; then
  step "fetch from upstream sources (network sample)"
  node skills/fetch.mjs --openclaw-home "$KHOME/.openclaw" --claude-home "$KHOME/.claude" --codex-home "$KHOME/.codex" --only tdd,canvas-design
  [ -f "$KHOME/.claude/skills/tdd/SKILL.md" ] || { echo "tdd not installed"; exit 1; }
  [ -f "$KHOME/.claude/skills/canvas-design/SKILL.md" ] || { echo "canvas-design not installed"; exit 1; }
  echo "network fetch ok"
fi

echo
echo "== all container checks passed =="
