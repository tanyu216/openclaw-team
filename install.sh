#!/usr/bin/env bash
#
# openclaw-team installer — Phase A (file-based, idempotent).
#
# Deploys a "standard individual independent developer" agent team onto an
# OpenClaw host: team docs/protocol, per-agent workspaces (roles), skills for
# OpenClaw / Claude Code / Codex, agent registration, and config wiring.
#
# It is IDEMPOTENT: re-running installs only what is missing. Existing files are
# preserved unless --force is given. Use --dry-run to preview every action.
#
# Task management is NOT bundled here: the team consumes the external
# `task-panel` project. This installer checks for it and installs it into
# OpenClaw when missing (see --task-panel / --no-task-panel).
#
# Usage:
#   ./install.sh [options]
#
# Options:
#   --dry-run              Print planned actions, change nothing
#   --force                Overwrite existing skills / role files / team docs
#   --openclaw-home DIR    OpenClaw home            (default: ~/.openclaw)
#   --claude-home DIR      Claude Code home         (default: ~/.claude)
#   --codex-home DIR       Codex home               (default: ~/.codex)
#   --task-panel DIR       Path to the task-panel source checkout
#   --no-task-panel        Do not check/install task-panel
#   --skip-skills          Skip all skill installation
#   --skip-claude-skills   Skip Claude Code skills
#   --skip-codex-skills    Skip Codex skills
#   --skip-agents          Skip agent registration / role deployment
#   --skip-config          Skip config fragment patch
#   --skip-team            Skip team docs deployment
#   -h | --help            Show this help
#
# Exit codes: 0 ok · 1 completed with warnings · 2 usage error

set -uo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"

# ---- defaults ---------------------------------------------------------------
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
TASK_PANEL_SRC="${TASK_PANEL_SRC:-}"

DRY_RUN=0
FORCE=0
DO_TEAM=1
DO_SKILLS=1
DO_CLAUDE_SKILLS=1
DO_CODEX_SKILLS=1
DO_AGENTS=1
DO_CONFIG=1
DO_TASKS=1

WARNINGS=0
STEPS=0

# role dir  ->  agent id  ->  workspace dir (relative to OPENCLAW_HOME)
ROLES=(elon jobs linus turing assistant)
AGENT_ID=(main jobs linus turing assistant)
WORKSPACE=(workspace-elon workspace-jobs workspace-linus workspace-turing workspace-assistant)

usage() { sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --openclaw-home) OPENCLAW_HOME="${2:?}"; shift ;;
    --openclaw-home=*) OPENCLAW_HOME="${1#*=}" ;;
    --claude-home) CLAUDE_HOME="${2:?}"; shift ;;
    --claude-home=*) CLAUDE_HOME="${1#*=}" ;;
    --codex-home) CODEX_HOME="${2:?}"; shift ;;
    --codex-home=*) CODEX_HOME="${1#*=}" ;;
    --task-panel) TASK_PANEL_SRC="${2:?}"; shift ;;
    --task-panel=*) TASK_PANEL_SRC="${1#*=}" ;;
    --no-task-panel) DO_TASKS=0 ;;
    --skip-skills) DO_SKILLS=0 ;;
    --skip-claude-skills) DO_CLAUDE_SKILLS=0 ;;
    --skip-codex-skills) DO_CODEX_SKILLS=0 ;;
    --skip-agents) DO_AGENTS=0 ;;
    --skip-config) DO_CONFIG=0 ;;
    --skip-team) DO_TEAM=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

TEAM_DIR="$OPENCLAW_HOME/team"

# ---- helpers ----------------------------------------------------------------
say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$*" >&2; WARNINGS=$((WARNINGS+1)); }
step() { STEPS=$((STEPS+1)); say "[$STEPS] $*"; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

# have_cmd <name>
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# install_skills <label> <src_root> <dst_root>
# Copies each immediate child (file or dir) of <src_root> into <dst_root>,
# skipping children that already exist unless --force.
install_skills() {
  local label="$1" src="$2" dst="$3" name target installed=0 skipped=0
  if [ ! -d "$src" ]; then info "$label: no source ($src), skip"; return 0; fi
  step "skills: $label → $dst"
  run mkdir -p "$dst"
  for entry in "$src"/*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    target="$dst/$name"
    if [ -e "$target" ] && [ "$FORCE" != 1 ]; then
      skipped=$((skipped+1)); continue
    fi
    run rm -rf "$target"
    run cp -R "$entry" "$target"
    installed=$((installed+1))
  done
  info "installed=$installed  skipped(exists)=$skipped"
}

# resolve_openclaw -> sets OCL array
OCL=()
resolve_openclaw() {
  if have_cmd openclaw; then OCL=(openclaw); return 0; fi
  local root
  root="$(npm root -g 2>/dev/null || true)"
  if [ -n "$root" ] && [ -f "$root/openclaw/dist/index.js" ]; then
    OCL=(node "$root/openclaw/dist/index.js"); return 0
  fi
  return 1
}

# agent_exists <id> ; uses `agents list --json`
agent_exists() {
  local id="$1"
  "${OCL[@]}" agents list --json 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.agents||j.items||[]);
      const ids=a.map(x=>x.id||x.name||x.agentId);
      process.exit(ids.includes(process.argv[1])?0:1);}catch(e){process.exit(2);}
    });' "$id"
}

# ---- 0. preflight -----------------------------------------------------------
say "openclaw-team installer  (dry-run=$DRY_RUN force=$FORCE)"
step "preflight"
if ! have_cmd node; then echo "install.sh: node is required" >&2; exit 1; fi
info "node $(node -v)  ·  repo $REPO"
info "openclaw home: $OPENCLAW_HOME"
if resolve_openclaw; then info "openclaw CLI: ${OCL[*]}"; else warn "openclaw CLI not found (npm i -g openclaw)"; fi

if have_cmd claude; then info "claude: $(claude --version 2>/dev/null | head -1)"
else warn "claude CLI not found — Claude skills will still be copied, but the host is absent (npm i -g @anthropic-ai/claude-code)"; fi
if have_cmd codex; then info "codex: $(codex --version 2>/dev/null | head -1)"
else warn "codex CLI not found — Codex skills will still be copied, but the host is absent (npm i -g @openai/codex)"; fi

# ---- 1. team docs -----------------------------------------------------------
if [ "$DO_TEAM" = 1 ]; then
  step "team docs → $TEAM_DIR"
  run mkdir -p "$TEAM_DIR"
  for f in "$REPO"/team/*; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    case "$name" in tasks|workspace|memory) continue ;; esac   # runtime dirs
    if [ -d "$f" ]; then
      run mkdir -p "$TEAM_DIR/$name"
      for sub in "$f"/*; do
        [ -e "$sub" ] || continue
        if [ -e "$TEAM_DIR/$name/$(basename "$sub")" ] && [ "$FORCE" != 1 ]; then continue; fi
        run cp -R "$sub" "$TEAM_DIR/$name/"
      done
    else
      if [ -e "$TEAM_DIR/$name" ] && [ "$FORCE" != 1 ]; then info "keep existing $name"; continue; fi
      run cp "$f" "$TEAM_DIR/$name"
    fi
  done
  for d in tasks workspace memory; do run mkdir -p "$TEAM_DIR/$d"; done
  info "protocol: $TEAM_DIR/PROTOCOL.md"
fi

# ---- 2. skills --------------------------------------------------------------
if [ "$DO_SKILLS" = 1 ]; then
  install_skills "openclaw global" "$REPO/skills/openclaw" "$OPENCLAW_HOME/skills"
  if [ "$DO_CLAUDE_SKILLS" = 1 ]; then
    install_skills "claude code" "$REPO/skills/claude" "$CLAUDE_HOME/skills"
  fi
  if [ "$DO_CODEX_SKILLS" = 1 ]; then
    install_skills "codex" "$REPO/skills/codex" "$CODEX_HOME/skills"
  fi
  i=0
  for a in jobs linus turing assistant; do
    install_skills "agent:$a" "$REPO/skills/agents/$a" "$OPENCLAW_HOME/workspace-$a/skills"
    i=$((i+1))
  done
fi

# ---- 3. agents + roles ------------------------------------------------------
if [ "$DO_AGENTS" = 1 ]; then
  step "agents + role workspaces"
  for i in "${!ROLES[@]}"; do
    role="${ROLES[$i]}"; id="${AGENT_ID[$i]}"; wsdir="$OPENCLAW_HOME/${WORKSPACE[$i]}"
    run mkdir -p "$wsdir"
    for f in AGENTS.md SOUL.md IDENTITY.md USER.md; do
      src="$REPO/roles/$role/$f"
      [ -f "$src" ] || continue
      dst="$wsdir/$f"
      # Never clobber an existing USER.md: it holds operator preferences.
      if [ "$f" = "USER.md" ] && [ -e "$dst" ]; then info "keep existing $id/USER.md"; continue; fi
      if [ -e "$dst" ] && [ "$FORCE" != 1 ]; then info "keep existing $id/$f"; continue; fi
      run cp "$src" "$dst"
    done
    if [ -n "${OCL[*]:-}" ] && agent_exists "$id"; then
      info "agent '$id' already registered"
    elif [ -n "${OCL[*]:-}" ]; then
      run "${OCL[@]}" agents add "$id" --workspace "$wsdir" --non-interactive
      if [ "$DRY_RUN" != 1 ] && [ -e "$wsdir/BOOTSTRAP.md" ]; then
        info "removing BOOTSTRAP.md (role files already deployed)"
        rm -f "$wsdir/BOOTSTRAP.md"
      fi
    else
      warn "cannot register agent '$id' (openclaw CLI missing) — workspace files deployed only"
    fi
  done
fi

# ---- 4. config fragment -----------------------------------------------------
if [ "$DO_CONFIG" = 1 ] && [ -n "${OCL[*]:-}" ]; then
  step "config fragment"
  for frag in "$REPO"/config/*.json5; do
    [ -f "$frag" ] || continue
    case "$(basename "$frag")" in *.template.json5) ;; *) : ;; esac
    info "patch $(basename "$frag")"
    if [ "$DRY_RUN" = 1 ]; then
      run "${OCL[@]}" config patch --file "$frag" --dry-run
    else
      run "${OCL[@]}" config patch --file "$frag"
    fi
  done
elif [ "$DO_CONFIG" = 1 ]; then
  warn "skip config patch (openclaw CLI missing)"
fi

# ---- 5. task-panel (external dependency) ------------------------------------
if [ "$DO_TASKS" = 1 ]; then
  step "task-panel dependency"
  if [ -e "$OPENCLAW_HOME/skills/task-panel" ]; then
    info "task-panel already installed at $OPENCLAW_HOME/skills/task-panel"
  else
    src="$TASK_PANEL_SRC"
    [ -n "$src" ] || for c in "$HOME/Documents/task-panel" "$HOME/task-panel" "$PWD/../task-panel"; do
      [ -f "$c/install.sh" ] && { src="$c"; break; }
    done
    if [ -n "$src" ] && [ -f "$src/install.sh" ]; then
      info "installing task-panel from $src"
      pfx="$HOME"
      args=(--target openclaw --prefix "$pfx")
      [ "$FORCE" = 1 ] && args+=(--force)
      [ "$DRY_RUN" = 1 ] && args+=(--dry-run)
      run bash "$src/install.sh" "${args[@]}"
    else
      warn "task-panel not found — clone it and re-run, or set --task-panel <dir>"
      info "  git clone <task-panel-repo> ~/Documents/task-panel && ./install.sh"
    fi
  fi
fi

# ---- summary ----------------------------------------------------------------
say ""
say "Done. steps=$STEPS  warnings=$WARNINGS"
[ "$DRY_RUN" = 1 ] && say "(dry-run: nothing was changed)"
if [ "$WARNINGS" -gt 0 ]; then
  say "Review the warnings above, then run: ${OCL[*]:-openclaw} doctor"
  exit 1
fi
exit 0
