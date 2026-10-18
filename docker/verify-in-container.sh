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

# 门禁的去耦验收（本仓是**分发通道**：贡献者/CI 机器上没有安装实例）。
# 没有 ~/.openclaw 时，check-all.sh 必须**自动落到仓内自证**并给出绿判 —— 这正是它的设计目标；
# 同时证明「仓的健康不再依赖任何一台机器的实例」。`env -u` 是必需的：否则宿主/CI 环境里漏进来的
# OPENCLAW_* 会让本步失去意义（测的就不是「无实例」了）。
step "gate: repo mode on a machine with NO instance"
NOHOME=/tmp/nohome
rm -rf "$NOHOME" && mkdir -p "$NOHOME"
GATE_OUT="$(env -u OPENCLAW_TEAM_ROOT -u OPENCLAW_HOME -u OPENCLAW_TEAM_REPO HOME="$NOHOME" bash team/scripts/check-all.sh --segment fast)"
echo "$GATE_OUT" | tail -1
echo "$GATE_OUT" | tail -1 | grep -q '"ok":true' || { echo "gate is RED in repo mode (no instance)"; echo "$GATE_OUT" | tail -25; exit 1; }
echo "$GATE_OUT" | tail -1 | grep -q '"mode":"repo"' || { echo "gate did not select repo mode"; echo "$GATE_OUT" | tail -25; exit 1; }
echo "repo-mode gate ok"

step "install unit tests (node:test — optimization backfill + reconcile + dry-run)"
node --test 'test/install/'*.test.mjs

step "skills update tests (node:test — ref drift detect / zero-write default / --apply + tree_sha256)"
node --test 'test/skills/'*.test.mjs

# 文档层「零条款丢失」比对器自身的回归（`test/docs/` 是仓侧工具，不随 install.sh 部署）。
# 它是压缩 team/guides 时唯一能机检「条款没丢」的东西，坏了没有别的门看得见 —— 因为
# 「什么都没报」正是它的正常输出。故须与其它仓侧套件同场跑。
step "doc-clause-diff tests (node:test — 反证：注入删除必须被抓到)"
node --test 'test/docs/'*.test.mjs

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
for f in .openclaw/team/SHARED-RULES.md .openclaw/team/guides/sla-thresholds.json .openclaw/team/guides/ci-release-sop.md .openclaw/team/guides/task-interface.md .openclaw/team/guides/seg-continuity-sop.md .openclaw/team/.install-state.json; do
  [ -f "$KHOME/$f" ] || { echo "missing after install: $f"; exit 1; }
done
for f in .openclaw/team/PROTOCOL.md .openclaw/team/PROTOCOL-gates.md .openclaw/team/scripts/lint-refs.mjs; do
  [ ! -e "$KHOME/$f" ] || { echo "retired file still present after fresh install: $f"; exit 1; }
done
for f in .openclaw/workspace-elon/AGENTS.md .openclaw/workspace-linus/AGENTS.md; do
  [ -f "$KHOME/$f" ] || { echo "missing role workspace: $f"; exit 1; }
done
for f in \
  .openclaw/workspace-elon/guides/carding-sop.md \
  .openclaw/workspace-elon/guides/project-registration-sop.md \
  .openclaw/workspace-elon/guides/token-hygiene-sop.md \
  .openclaw/workspace-elon/guides/duties-sop.md \
  .openclaw/workspace-jobs/guides/duties-sop.md \
  .openclaw/workspace-jobs/guides/tool-discipline-sop.md \
  .openclaw/workspace-linus/guides/duties-sop.md \
  .openclaw/workspace-linus/guides/testing-and-delivery-sop.md \
  .openclaw/workspace-linus/guides/development-process-sop.md \
  .openclaw/workspace-turing/guides/duties-sop.md \
  .openclaw/workspace-turing/guides/tool-discipline-sop.md \
  .openclaw/workspace-assistant/guides/research-and-data-repo-conventions.md; do
  [ -f "$KHOME/$f" ] || { echo "missing role guide: $f"; exit 1; }
done
echo "deployed files ok"

step "install/upgrade path (idempotent + backup + retirement)"
# Simulate an old instance that still has the retired volumes/lint, then upgrade.
for legacy in PROTOCOL.md PROTOCOL-gates.md; do echo "# legacy" > "$KHOME/.openclaw/team/$legacy"; done
echo "// legacy" > "$KHOME/.openclaw/team/scripts/lint-refs.mjs"
echo "my prefs" >> "$KHOME/.openclaw/workspace-elon/USER.md"
HOME="$KHOME" ./install.sh --openclaw-home "$KHOME/.openclaw" --claude-home "$KHOME/.claude" --codex-home "$KHOME/.codex" --no-meerkat-taskpanel --skip-skills --no-register --skip-config >/dev/null
for legacy in PROTOCOL.md PROTOCOL-gates.md scripts/lint-refs.mjs; do
  [ -n "$(find "$KHOME/.openclaw/team/.backups" -path "*/team/$legacy" 2>/dev/null)" ] || { echo "no backup written for retired $legacy"; exit 1; }
  [ ! -e "$KHOME/.openclaw/team/$legacy" ] || { echo "retired file not removed: $legacy"; exit 1; }
done
grep -q "# legacy" "$KHOME/.openclaw/team/.backups"/*/team/PROTOCOL.md || { echo "backup missing edit"; exit 1; }
grep -q "my prefs" "$KHOME/.openclaw/workspace-elon/USER.md" || { echo "USER.md was clobbered"; exit 1; }
echo "upgrade + backup + retirement + user-file preservation ok"

if [ "${OPENCLAW_TEAM_NET:-0}" = "1" ]; then
  step "fetch from upstream sources (network sample)"
  node skills/fetch.mjs --openclaw-home "$KHOME/.openclaw" --claude-home "$KHOME/.claude" --codex-home "$KHOME/.codex" --only tdd,canvas-design
  [ -f "$KHOME/.claude/skills/tdd/SKILL.md" ] || { echo "tdd not installed"; exit 1; }
  [ -f "$KHOME/.claude/skills/canvas-design/SKILL.md" ] || { echo "canvas-design not installed"; exit 1; }
  echo "network fetch ok"
fi

echo
echo "== all container checks passed =="
