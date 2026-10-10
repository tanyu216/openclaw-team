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
# Task management is NOT bundled here. The team integrates with any task
# system through a small ACL (see team/guides/task-interface.md); `meerkat-taskpanel`
# is the DEFAULT reference provider (installed unless --no-meerkat-taskpanel).
# Connectors for other systems (Jira, Linear, Plane, ...) are out of scope.
#
# Team-level SCHEDULING is FRAMEWORK-OWNED and provider-agnostic: the scheduled
# jobs (*-poll / task-patrol / team-check-all) are registered here and dispatch
# to the configured provider through team/automations/dispatch.mjs (meerkat-taskpanel
# by default; select another with OPENCLAW_TEAM_TASK_PROVIDER). See
# --skip-automations.
#
# The provider ENTRY scripts ship WITH the repository (deployed from team/scripts/
# into $TEAM_DIR/scripts/), so a fresh install has no dangling entry path.
#
# Trigger evaluation is BOUNDED (③): the generated Gateway trigger script caps the
# dispatcher call with `timeoutSeconds`, and dispatch.mjs itself bounds the provider
# entry with OPENCLAW_TEAM_EVAL_TIMEOUT_MS (default 8000 ms) — both well under the
# Gateway's own 30 s per-evaluation wall-clock budget. Poll jobs also carry a run
# upper bound (`--timeout-seconds`, default 3600 s; OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S
# overrides, 0 disables). NOTE: `already-running` (a run holding the job lock) and
# stale-run release are GATEWAY-SCHEDULER/platform concerns — this installer does
# not bound or reap them. See team/AUTOMATIONS.md §3.5.
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
#   --meerkat-taskpanel DIR       Path to the meerkat-taskpanel source checkout
#   --with-meerkat-taskpanel      Install the reference task provider (meerkat-taskpanel) [default]
#   --no-meerkat-taskpanel        Opt out: do NOT install meerkat-taskpanel; bring your own
#                                 task system (Jira/Plane/Linear/...) via the
#                                 task-interface ACL
#                                 (legacy-name-compat: the pre-rebrand --*-task-panel flags are
#                                  still accepted as deprecated aliases)
#   --skip-automations     Do not register team-level scheduled jobs
#   --vendor               Snapshot skills from source into skills/vendor/
#   --offline              Install skills from skills/vendor/ (no network)
#   --no-register          Deploy role workspaces but skip agent registration
#                          (no `openclaw agents add`; useful in containers/CI)
#   --keep-existing        Skip existing files (never overwrite); default is
#                          UPGRADE: managed files are backed up then overwritten
#   --keys                 Force the interactive API-key prompt
#   --skip-keys            Never prompt; list every key in the closing summary
#   --prototype <carrier>  Prototype carrier chosen at install time:
#                          static-html | figma | google-stitch | pixso
#                          (default static-html). Recorded in
#                          ~/.openclaw/team/team.config.json for Jobs/Linus.
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
MEERKAT_TASKPANEL_SRC="${MEERKAT_TASKPANEL_SRC:-}"
WITH_MEERKAT_TASKPANEL=1   # meerkat-taskpanel is the DEFAULT reference provider (opt out: --no-meerkat-taskpanel)
KEEP=0            # --keep-existing: never overwrite (legacy install-only behaviour)
BK_DIR=""        # backup dir for this run (set in preflight)
VERSION="$(cat "$REPO/VERSION" 2>/dev/null || echo 0.0.0)"

DRY_RUN=0
FORCE=0
DO_TEAM=1
DO_SKILLS=1
DO_CLAUDE_SKILLS=1
DO_CODEX_SKILLS=1
DO_AGENTS=1
DO_CONFIG=1
DO_TASKS=1
DO_AUTOMATIONS=1  # --skip-automations: do not register team-level scheduled jobs
VENDOR=0
OFFLINE=0
NOREG=0           # --no-register: deploy role workspaces but skip `openclaw agents add`
PROTOTYPE=""      # --prototype: static-html|figma|google-stitch|pixso (recorded in team.config.json)
SKIP_KEYS=""      # --skip-keys: never prompt; --keys: force prompt (default: prompt only on a TTY)

WARNINGS=0
STEPS=0

# ---- scheduling bounds (③) --------------------------------------------------
# Trigger-evaluation bound (ms). It must stay well under the Gateway's 30 s
# per-evaluation wall clock AND under the exec helper's 10 s default `yieldMs`
# (above which the call backgrounds and the trigger would read partial output) —
# so values > 10000 are not useful. Invalid/absent ⇒ 8000.
EVAL_TIMEOUT_MS="${OPENCLAW_TEAM_EVAL_TIMEOUT_MS:-8000}"
case "$EVAL_TIMEOUT_MS" in ''|*[!0-9]*) EVAL_TIMEOUT_MS=8000 ;; esac
[ "$EVAL_TIMEOUT_MS" -gt 0 ] 2>/dev/null || EVAL_TIMEOUT_MS=8000
# exec() takes SECONDS (verified against the Gateway exec tool schema), so round up.
EVAL_TIMEOUT_S=$(( (EVAL_TIMEOUT_MS + 999) / 1000 ))
# Poll RUN upper bound (seconds): a poll run executes every card claimed this round
# (up to the agent's concurrency quota), so the bound must cover several cards.
# 0 disables the scheduler timeout (see `openclaw automations add --help`).
POLL_RUN_TIMEOUT_S="${OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S:-3600}"
case "$POLL_RUN_TIMEOUT_S" in ''|*[!0-9]*) POLL_RUN_TIMEOUT_S=3600 ;; esac
# Poll cadence (②): the interval between per-worker poll triggers. Poll is the FALLBACK —
# the mainline is Elon dispatching with sessions_send (push); poll only wakes a worker when
# that push did not land, and it keeps the worst-case claim latency ≤5m (claim timing
# belongs to poll, PROTOCOL §①). Override with OPENCLAW_TEAM_POLL_INTERVAL (e.g. 3m).
POLL_INTERVAL="${OPENCLAW_TEAM_POLL_INTERVAL:-5m}"
case "$POLL_INTERVAL" in [0-9]*[smhd]) ;; *) POLL_INTERVAL=5m ;; esac

# role dir  ->  agent id  ->  workspace dir (relative to OPENCLAW_HOME)
ROLES=(elon jobs linus turing assistant)
AGENT_ID=(main jobs linus turing assistant)
WORKSPACE=(workspace-elon workspace-jobs workspace-linus workspace-turing workspace-assistant)

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; }

# dep_flag <old> <new> — one-line deprecation note for a legacy-name-compat flag alias.
# It deliberately does NOT go through warn(): warn() bumps WARNINGS, which flips the
# installer's exit code to 1 — that would break callers still passing a deprecated
# alias (the meerkat-taskpanel product repo's docker/verify-in-container.sh runs it
# under `set -euo pipefail`, where a non-zero installer exit aborts the script).
dep_flag() { printf '  \033[33m! %s is deprecated (legacy-name-compat); use %s\033[0m\n' "$1" "$2" >&2; }

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
    --meerkat-taskpanel) MEERKAT_TASKPANEL_SRC="${2:?}"; shift ;;
    --meerkat-taskpanel=*) MEERKAT_TASKPANEL_SRC="${1#*=}" ;;
    --with-meerkat-taskpanel) WITH_MEERKAT_TASKPANEL=1 ;;
    --no-meerkat-taskpanel) WITH_MEERKAT_TASKPANEL=0 ;;
    --task-panel) dep_flag --task-panel --meerkat-taskpanel; MEERKAT_TASKPANEL_SRC="${2:?}"; shift ;; # legacy-name-compat
    --task-panel=*) dep_flag --task-panel --meerkat-taskpanel; MEERKAT_TASKPANEL_SRC="${1#*=}" ;;      # legacy-name-compat
    --with-task-panel) dep_flag --with-task-panel --with-meerkat-taskpanel; WITH_MEERKAT_TASKPANEL=1 ;; # legacy-name-compat
    --no-task-panel) dep_flag --no-task-panel --no-meerkat-taskpanel; WITH_MEERKAT_TASKPANEL=0 ;;       # legacy-name-compat
    --skip-automations) DO_AUTOMATIONS=0 ;;
    --skip-skills) DO_SKILLS=0 ;;
    --vendor) VENDOR=1 ;;
    --offline) OFFLINE=1 ;;
    --keep-existing) KEEP=1 ;;
    --skip-claude-skills) DO_CLAUDE_SKILLS=0 ;;
    --skip-codex-skills) DO_CODEX_SKILLS=0 ;;
    --skip-agents) DO_AGENTS=0 ;;
    --no-register) NOREG=1 ;;
    --prototype) PROTOTYPE="${2:?}"; shift ;;
    --prototype=*) PROTOTYPE="${1#*=}" ;;
    --keys) SKIP_KEYS=0 ;;
    --skip-keys) SKIP_KEYS=1 ;;
    --skip-config) DO_CONFIG=0 ;;
    --skip-team) DO_TEAM=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

TEAM_DIR="$OPENCLAW_HOME/team"

case "$PROTOTYPE" in
  ""|static-html|figma|google-stitch|pixso) ;;
  *) echo "install.sh: --prototype must be static-html|figma|google-stitch|pixso" >&2; exit 2 ;;
esac

# ---- helpers ----------------------------------------------------------------
say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$*" >&2; WARNINGS=$((WARNINGS+1)); }
step() { STEPS=$((STEPS+1)); say "[$STEPS] $*"; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

# have_cmd <name>
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# backup_path <path> — copy an existing managed path into $BK_DIR before overwrite
backup_path() {
  [ -n "$BK_DIR" ] || return 0
  local p="$1" rel
  case "$p" in "$OPENCLAW_HOME"/*) rel="${p#$OPENCLAW_HOME/}" ;; *) rel="$(basename "$p")" ;; esac
  run mkdir -p "$BK_DIR/$(dirname "$rel")"
  run cp -R "$p" "$BK_DIR/$rel"
}

# write_install_state <key=value ...> — read-modify-write $TEAM_DIR/.install-state.json.
# Replaces the former whole-file overwrite so extra fields (optimizationApplied) survive
# a later version refresh. Keys are simple identifiers; values true/false/numbers/strings.
# No-op under --dry-run (state must not be written when previewing).
write_install_state() {
  [ "$DRY_RUN" = 1 ] && return 0
  mkdir -p "$TEAM_DIR"
  node -e '
    const fs=require("fs");const p=process.argv[1];const kv=process.argv.slice(2);
    let d={};try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){d={}}
    for(const t of kv){const i=t.indexOf("=");if(i<0)continue;
      const k=t.slice(0,i),v=t.slice(i+1);
      if(v==="true")d[k]=true;else if(v==="false")d[k]=false;
      else if(/^-?\d+(\.\d+)?$/.test(v))d[k]=Number(v);else d[k]=v;}
    fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n");
  ' "$TEAM_DIR/.install-state.json" "$@"
}

# deploy_file <src> <dst> <label> — install / upgrade / keep a single managed file
deploy_file() {
  local src="$1" dst="$2" label="$3"
  if [ ! -e "$dst" ]; then run mkdir -p "$(dirname "$dst")"; run cp "$src" "$dst"; info "install  $label"; return 0; fi
  if cmp -s "$src" "$dst"; then info "unchanged $label"; return 0; fi
  if [ "$KEEP" = 1 ]; then info "keep      $label (differs)"; return 0; fi
  backup_path "$dst"; run cp "$src" "$dst"; info "upgrade  $label"; return 0
}

# deploy_tree <src> <dst> <label> — deploy a managed file, or recurse into a directory.
# `deploy_file` copies with plain `cp`, which fails on a directory; managed trees
# (e.g. team/scripts/ with its tests/) need the recursion so a nested dir deploys
# instead of erroring.
deploy_tree() {
  local src="$1" dst="$2" label="$3" sub
  if [ -d "$src" ]; then
    run mkdir -p "$dst"
    for sub in "$src"/*; do
      [ -e "$sub" ] || continue
      deploy_tree "$sub" "$dst/$(basename "$sub")" "$label/$(basename "$sub")"
    done
    return 0
  fi
  deploy_file "$src" "$dst" "$label"
}

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

# automations_json_ok — validate that $AUTOMATIONS_JSON is `{jobs:[...]}`
# (guards against an error object / gateway-unreachable reply on stdout)
automations_json_ok() {
  printf '%s' "$AUTOMATIONS_JSON" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const j=JSON.parse(s);process.exit(Array.isArray((j&&(j.jobs||j.items))||j)?0:1);}catch(e){process.exit(1);}
    });'
}

# (existence/reconcile decisions moved to config/reconcile.mjs — the declaration source
#  is the single source of truth and a drifted job is edited, not skipped.)

# write_trigger <dispatch-args> <outfile> — generate the Gateway inline-JS trigger.
# Absolute paths only; NEVER {{...}} templating (see team/AUTOMATIONS.md §6). The
# script is a thin adapter over the framework dispatcher: it wakes the agent only
# when the dispatcher's last JSON line says fire:true.
#
# The exec() call carries a BOUNDED timeout (③): `timeoutSeconds` is the exec tool's
# own parameter (the Gateway exec schema has `timeoutSeconds`, not `timeoutMs`), and
# the dispatcher applies the matching OPENCLAW_TEAM_EVAL_TIMEOUT_MS bound internally.
# Both stay under the Gateway's 30 s per-evaluation budget; see team/AUTOMATIONS.md §3.5.
write_trigger() {
  local dargs="$1" out="$2"
  # Body template lives in ONE place (team/automations/trigger-template.mjs) so
  # config/reconcile.mjs can compare the live trigger against byte-exact expected bytes
  # and tests can build matching fixtures (T-20261010-092547).
  node "$REPO/team/automations/trigger-template.mjs" "$TEAM_DIR" "$EVAL_TIMEOUT_S" "$EVAL_TIMEOUT_MS" $dargs > "$out"
}

# register_automation <name> <agent> <declarationKey> <job> <schedule-args...>
#   job ∈ poll|patrol|check-all (dispatch job; poll also passes <agent>)
# Idempotent by declarationKey; never hard-codes a provider name.
register_automation() {
  local name="$1" agent="$2" key="$3" job="$4"; shift 4
  local sched=("$@")
  local dargs="$job" msg tmp run_extra=""
  case "$job" in
    poll)
      dargs="poll $agent"
      # Run upper bound (③): a poll run executes every card claimed this round.
      # `--timeout-seconds` is the scheduler's agent/command-job run timeout
      # (verified in `openclaw automations add --help`); 0 disables it.
      run_extra="--timeout-seconds $POLL_RUN_TIMEOUT_S"
      msg="[openclaw-team] Scheduled poll for $agent: if the dispatcher claimed a card, execute it via the task-interface ACL and PROTOCOL.md; otherwise reply NO_REPLY." ;;
    patrol)    msg="[openclaw-team] Stale in_progress card(s) detected by task-patrol: recover per the PROTOCOL recovery rules." ;;
    check-all) msg="[openclaw-team] Team gate patrol failed: run the team gate checks and handle per the PROTOCOL gates/archiving rules." ;;
    *)         msg="[openclaw-team] Scheduled job $name." ;;
  esac
  tmp="$(mktemp "${TMPDIR:-/tmp}/openclaw-trigger.XXXXXX")"
  write_trigger "$dargs" "$tmp"
  info "add      $name  ($key)"
  # `--light-context` is the cron-slimming lever (④): a lighter bootstrap context for
  # trigger-script decision jobs (poll/patrol/check-all) — see team/AUTOMATIONS.md §4.
  run "${OCL[@]}" automations add "$name" --agent "$agent" "${sched[@]}" \
      $run_extra --light-context --session isolated --wake now --trigger-script "$tmp" --declaration-key "$key" --message "$msg"
  rm -f "$tmp"
}

# ---- 0. preflight -----------------------------------------------------------
say "openclaw-team installer  (dry-run=$DRY_RUN force=$FORCE)"
step "preflight"
if ! have_cmd node; then echo "install.sh: node is required" >&2; exit 1; fi
info "node $(node -v)  ·  repo $REPO"
info "openclaw home: $OPENCLAW_HOME"
if resolve_openclaw; then info "openclaw CLI: ${OCL[*]}"
elif [ "$DO_CONFIG" = 1 ] || { [ "$DO_AGENTS" = 1 ] && [ "$NOREG" != 1 ]; }; then
  warn "openclaw CLI not found — agent registration/config steps need it (npm i -g openclaw)"
else info "openclaw CLI not found (ok: registration/config steps disabled)"; fi

# upgrade detection + backup dir (used by deploy_file on overwrite)
prev="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).version||""))}catch(e){}' "$TEAM_DIR/.install-state.json" 2>/dev/null || true)"
if [ -n "$prev" ] && [ "$prev" != "$VERSION" ]; then info "existing install v$prev → v$VERSION (upgrade)"
elif [ -n "$prev" ]; then info "existing install v$prev (re-run)"; fi
BK_DIR="$TEAM_DIR/.backups/$(date +%Y%m%d-%H%M%S)"
[ "$KEEP" = 1 ] && info "mode: keep-existing (no overwrite)" || info "mode: install/upgrade (backs up before overwrite)"

if have_cmd claude; then info "claude: $(claude --version 2>/dev/null | head -1)"
else info "claude CLI absent — Claude skills still install to $CLAUDE_HOME/skills (optional host; npm i -g @anthropic-ai/claude-code)"; fi
if have_cmd codex; then info "codex: $(codex --version 2>/dev/null | head -1)"
else info "codex CLI absent — Codex skills still install to $CODEX_HOME/skills (optional host; npm i -g @openai/codex)"; fi

# ---- 1. team docs -----------------------------------------------------------
if [ "$DO_TEAM" = 1 ]; then
  step "team docs → $TEAM_DIR"
  run mkdir -p "$TEAM_DIR"
  for f in "$REPO"/team/*; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    case "$name" in tasks|workspace|memory) continue ;; esac   # runtime dirs (user-owned)
    if [ -d "$f" ]; then
      deploy_tree "$f" "$TEAM_DIR/$name" "$name"
    else
      deploy_file "$f" "$TEAM_DIR/$name" "$name"
    fi
  done
  for d in tasks workspace memory; do run mkdir -p "$TEAM_DIR/$d"; done
  info "protocol: $TEAM_DIR/PROTOCOL.md"
fi

# ---- 1a. team tooling (repo tools/ -> instance ROOT $TEAM_DIR/tools/) -------
# Design/verification tooling (e.g. tools/ui-fidelity, tools/ui-align) ships in the
# repo-root tools/ tree and deploys into the instance ROOT ($TEAM_DIR/tools/), NOT
# under team/ (the instance has no team/tools/ subdir). Both engines coexist by
# design (ui-fidelity README: it complements, not replaces, ui-align). Idempotent via
# deploy_tree (install / unchanged / backup-then-overwrite on change); host-local
# extras in the instance tools/ (e.g. a local openssl3 build) are never touched.
if [ "$DO_TEAM" = 1 ] && [ -d "$REPO/tools" ]; then
  step "team tooling -> $TEAM_DIR/tools"
  for t in "$REPO"/tools/*; do
    [ -e "$t" ] || continue
    name="$(basename "$t")"
    if [ -d "$t" ]; then
      deploy_tree "$t" "$TEAM_DIR/tools/$name" "tools/$name"
    else
      deploy_file "$t" "$TEAM_DIR/tools/$name" "tools/$name"
    fi
  done
fi

# ---- 1b. prototype carrier (install-time choice read by Jobs/Linus) ---------
carrier="$PROTOTYPE"
if [ -z "$carrier" ]; then
  carrier="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).prototype.carrier||""))}catch(e){}' "$TEAM_DIR/team.config.json" 2>/dev/null || true)"
fi
[ -n "$carrier" ] || carrier="static-html"
if [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] set prototype.carrier=$carrier in $TEAM_DIR/team.config.json"
else
  run mkdir -p "$TEAM_DIR"
  node -e '
    const fs=require("fs");const p=process.argv[1],c=process.argv[2];
    let d={version:1};try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
    d.prototype=Object.assign({},d.prototype,{carrier:c});
    fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n");
  ' "$TEAM_DIR/team.config.json" "$carrier"
  info "prototype carrier: $carrier ($TEAM_DIR/team.config.json)"
fi

# ---- 1c. prototype connector check (figma|pixso|google-stitch need an MCP) --
if [ "$carrier" != "static-html" ]; then
  step "prototype connector ($carrier)"
  want="$(node -e 'try{const m=require(process.argv[1]);const c=m.carriers[process.argv[2]];process.stdout.write((c&&c.connector&&c.connector.name)||"")}catch(e){}' "$REPO/config/prototype-carriers.json" "$carrier" 2>/dev/null || true)"
  have="$(node -e 'try{const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(Object.keys((d.mcp&&d.mcp.servers)||{}).join(" "))}catch(e){}' "$OPENCLAW_HOME/openclaw.json" 2>/dev/null || true)"
  if [ -n "$want" ] && printf '%s' "$have" | tr ' ' '\n' | grep -qx "$want"; then
    info "connector '$want' present in mcp.servers"
  else
    warn "carrier '$carrier' needs connector MCP '$want' — not found in mcp.servers"
    info "  template: config/examples/mcp.example.json5  (edit, then: openclaw config patch --file <it>)"
  fi
fi

# ---- 1d. API keys (masked prompt; skippable) -------------------------------
KEYS_FILE="$TEAM_DIR/.secrets.env"
if [ -f "$REPO/config/api-keys.json" ]; then
  step "api keys"
  krows="$(node -e '
    const m=require(process.argv[1]);const c=process.argv[2];
    for(const [k,v] of Object.entries(m.keys||{})){
      const when=v.when||"";
      if(when && !when.split(",").map(s=>s.trim()).includes("carrier="+c)) continue;
      console.log([k,(v.purpose||""),(v.configure||""),(v.required?"1":"0")].join("|"));
    }
  ' "$REPO/config/api-keys.json" "$carrier" 2>/dev/null || true)"
  while IFS='|' read -r kname kpurpose kconf kreq; do
    [ -n "$kname" ] || continue
    eval "curval=\${$kname:-}"
    if [ -n "$curval" ]; then info "$kname: already set in environment"; continue; fi
    if [ "$SKIP_KEYS" = 1 ] || [ "$DRY_RUN" = 1 ] || [ ! -t 0 ]; then
      info "$kname: not set (see the closing summary)"; continue
    fi
    printf '  %s — %s\n  Enter value (input hidden; Enter to skip): ' "$kname" "$kpurpose"
    read -rs kval < /dev/tty || true
    printf '\n'
    if [ -n "$kval" ]; then
      mkdir -p "$TEAM_DIR"; umask 077
      printf '%s=%s\n' "$kname" "$kval" >> "$KEYS_FILE"; chmod 600 "$KEYS_FILE"
      info "$kname: stored (0600) in $KEYS_FILE"
    else
      info "$kname: skipped"
    fi
  done <<< "$krows"
fi

# ---- 2. skills (declared sources; option A) ---------------------------------
if [ "$DO_SKILLS" = 1 ]; then
  if [ -f "$REPO/skills/manifest.json" ]; then
    step "skills (declared sources)"
    sargs=(--openclaw-home "$OPENCLAW_HOME" --claude-home "$CLAUDE_HOME" --codex-home "$CODEX_HOME")
    [ "$DRY_RUN" = 1 ] && sargs+=(--dry-run)
    [ "$KEEP" = 1 ] && sargs+=(--keep)
    [ "$VENDOR" = 1 ] && sargs+=(--vendor)
    [ "$OFFLINE" = 1 ] && sargs+=(--offline)
    node "$REPO/skills/fetch.mjs" "${sargs[@]}" || warn "some skills failed to fetch (see above)"
  else
    warn "skills/manifest.json missing — falling back to vendored copies"
    install_skills "openclaw global" "$REPO/skills/openclaw" "$OPENCLAW_HOME/skills"
    [ "$DO_CLAUDE_SKILLS" = 1 ] && install_skills "claude code" "$REPO/skills/claude" "$CLAUDE_HOME/skills"
    [ "$DO_CODEX_SKILLS" = 1 ] && install_skills "codex" "$REPO/skills/codex" "$CODEX_HOME/skills"
    for a in jobs linus turing assistant; do
      install_skills "agent:$a" "$REPO/skills/agents/$a" "$OPENCLAW_HOME/workspace-$a/skills"
    done
  fi
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
      # USER.md is user-owned: never overwritten by install/upgrade.
      if [ "$f" = "USER.md" ] && [ -e "$dst" ]; then info "keep      $id/USER.md (user-owned)"; continue; fi
      deploy_file "$src" "$dst" "$id/$f"
    done
    if [ -d "$REPO/roles/$role/guides" ]; then
      run mkdir -p "$wsdir/guides"
      for g in "$REPO/roles/$role/guides"/*; do
        [ -e "$g" ] || continue
        deploy_file "$g" "$wsdir/guides/$(basename "$g")" "$id/guides/$(basename "$g")"
      done
    fi
    if [ "$NOREG" = 1 ]; then
      info "agent '$id': files deployed (registration skipped)"
    elif [ -n "${OCL[*]:-}" ] && agent_exists "$id"; then
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

# ---- 4b. config optimization (providers backfill, idempotent) ----------------
# Providers backfill is a read-modify-write over the FULL models array (config patch
# REPLACES arrays, so a sparse element would fail schema). It only fills MISSING fields
# (never overwrites a user's custom value) and runs once per install unless --force.
if [ "$DO_CONFIG" = 1 ] && [ -n "${OCL[*]:-}" ] && [ "${OPENCLAW_TEAM_OPTIMIZE_PROVIDERS:-1}" = 1 ]; then
  step "config optimization (providers backfill)"
  OPT_MARKER="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).optimizationApplied||""))}catch(e){}' "$TEAM_DIR/.install-state.json" 2>/dev/null || true)"
  if [ -n "$OPT_MARKER" ] && [ "$FORCE" != 1 ]; then
    info "optimization already applied (marker set; --force to re-run)"
  else
    CFG_FILE="$OPENCLAW_HOME/openclaw.json"
    if [ ! -e "$CFG_FILE" ]; then
      info "no openclaw.json present — nothing to optimize"
    else
      backup_path "$CFG_FILE"
      PATCH_FILE="$(mktemp "${TMPDIR:-/tmp}/openclaw-opt.XXXXXX")"
      node "$REPO/config/optimization.mjs" "$CFG_FILE" > "$PATCH_FILE"
      if node -e 'const fs=require("fs");let o;try{o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){process.exit(1)}process.exit(Object.keys(o).length?1:0)' "$PATCH_FILE"; then
        info "providers already optimized (no missing fields)"
      else
        info "apply providers backfill (missing fields only)"
        if [ "$DRY_RUN" = 1 ]; then
          run "${OCL[@]}" config patch --file "$PATCH_FILE" --dry-run
        else
          run "${OCL[@]}" config patch --file "$PATCH_FILE"
          if "${OCL[@]}" config validate; then
            info "config validate ok"
            write_install_state optimizationApplied=true
          else
            warn "config validate FAILED after optimization — restoring $CFG_FILE from backup"
            if [ -n "$BK_DIR" ] && [ -e "$BK_DIR/openclaw.json" ]; then run cp "$BK_DIR/openclaw.json" "$CFG_FILE"; fi
          fi
        fi
      fi
      rm -f "$PATCH_FILE"
    fi
  fi
elif [ "$DO_CONFIG" = 1 ] && [ -n "${OCL[*]:-}" ] && [ "${OPENCLAW_TEAM_OPTIMIZE_PROVIDERS:-1}" != 1 ]; then
  info "providers optimization disabled (OPENCLAW_TEAM_OPTIMIZE_PROVIDERS=0)"
fi

# ---- 5. task provider (ACL) -------------------------------------------------
# The team talks to ANY task system through the ACL in
# team/guides/task-interface.md. meerkat-taskpanel is the DEFAULT reference provider
# (opt out with --no-meerkat-taskpanel); other systems (Jira/Linear/Plane/...) are the
# user's own concern. This stage only selects/installs the provider — the
# framework OWNS scheduling and dispatches through the ACL (see stage 6).
if [ "$DO_TASKS" = 1 ]; then
  step "task provider (ACL)"
  provider="${OPENCLAW_TEAM_TASK_PROVIDER:-meerkat-taskpanel}"
  info "configured provider: $provider  (ACL: team/guides/task-interface.md)"
  # legacy-name-compat: detect a pre-rebrand skill dir too, so an existing install is
  # still recognised instead of being needlessly reinstalled.
  if [ -e "$OPENCLAW_HOME/skills/meerkat-taskpanel" ] || [ -e "$OPENCLAW_HOME/skills/task-panel" ] || have_cmd taskctl; then # legacy-name-compat
    info "reference provider present: meerkat-taskpanel"
  fi
  if [ "$WITH_MEERKAT_TASKPANEL" = 1 ]; then
    if [ -e "$OPENCLAW_HOME/skills/meerkat-taskpanel" ]; then
      info "meerkat-taskpanel already installed at $OPENCLAW_HOME/skills/meerkat-taskpanel"
    elif [ -e "$OPENCLAW_HOME/skills/task-panel" ]; then # legacy-name-compat
      info "meerkat-taskpanel already installed (legacy-name-compat dir $OPENCLAW_HOME/skills/task-panel)"
    else
      src="$MEERKAT_TASKPANEL_SRC"
      [ -n "$src" ] || for c in "$HOME/Documents/meerkat-taskpanel" "$HOME/meerkat-taskpanel" "$PWD/../meerkat-taskpanel" \
                                "$HOME/Documents/task-panel" "$HOME/task-panel" "$PWD/../task-panel"; do # legacy-name-compat
        [ -f "$c/install.sh" ] && { src="$c"; break; }
      done
      if [ -n "$src" ] && [ -f "$src/install.sh" ]; then
        info "installing reference provider meerkat-taskpanel from $src"
        args=(--target openclaw --prefix "$HOME")
        [ "$FORCE" = 1 ] && args+=(--force)
        [ "$DRY_RUN" = 1 ] && args+=(--dry-run)
        run bash "$src/install.sh" "${args[@]}"
      else
        # meerkat-taskpanel is the default provider but its source is an external
        # checkout; missing source degrades (informational, never fatal).
        info "meerkat-taskpanel source not found — reference provider NOT installed."
        info "  provide it:  ./install.sh --meerkat-taskpanel <dir>   (or git clone it)"
        info "  or opt out:  ./install.sh --no-meerkat-taskpanel      (bring your own below)"
        info "  the framework still deploys scheduling; it dispatches through the ACL"
        info "  and degrades to no-fire until a provider entry exists."
      fi
    fi
  else
    info "meerkat-taskpanel opted out (--no-meerkat-taskpanel)."
    info "  Scheduling stays framework-owned and provider-agnostic (see stage 6)."
    info "  Bring your own task system — Jira / Plane / Linear / GitHub Issues / …:"
    info "    install its connector skill/MCP, then set OPENCLAW_TEAM_TASK_PROVIDER=<name>"
    info "    and point the entry commands at it (team/automations/providers.json or"
    info "    OPENCLAW_TEAM_POLL_CMD / OPENCLAW_TEAM_PATROL_CMD / OPENCLAW_TEAM_CHECKALL_CMD)."
    info "  The upper layers change zero — they depend only on the task-interface ACL"
    info "  (team/guides/task-interface.md)."
  fi
fi

# ---- 6. team automations (framework-owned scheduling, provider-agnostic) ----
# The framework registers the team's scheduled jobs; each trigger calls the
# framework dispatcher, which in turn calls the configured provider behind the
# ACL. No provider literal (meerkat-taskpanel / taskctl) appears in any trigger script.
if [ "$DO_AUTOMATIONS" = 1 ]; then
  step "team automations (provider-agnostic)"
  auto_provider="${OPENCLAW_TEAM_TASK_PROVIDER:-meerkat-taskpanel}"
  info "scheduler: framework-owned  ·  provider: $auto_provider (callee via the ACL)"
  info "dispatcher: $TEAM_DIR/automations/dispatch.mjs"
  info "bounds: trigger-eval ${EVAL_TIMEOUT_MS}ms (OPENCLAW_TEAM_EVAL_TIMEOUT_MS) · poll run ${POLL_RUN_TIMEOUT_S}s (OPENCLAW_TEAM_POLL_RUN_TIMEOUT_S, 0=off)"
  info "poll: every $POLL_INTERVAL (OPENCLAW_TEAM_POLL_INTERVAL) · --light-context on poll/patrol/check-all"
  # built-in workers only for poll (skip main/elon), derived from ROLES/AGENT_ID
  auto_agents=()
  for i in "${!ROLES[@]}"; do
    id="${AGENT_ID[$i]}"; [ "$id" = main ] && continue
    auto_agents+=("$id")
  done
  if [ -z "${OCL[*]:-}" ]; then
    info "openclaw CLI not found — skipping automation registration (npm i -g openclaw)"
    info "  re-run ./install.sh once the CLI + Gateway are up; registration is idempotent"
  else
    AUTOMATIONS_JSON="$("${OCL[@]}" automations list --json --timeout 10000 2>/dev/null || true)"
    if ! automations_json_ok; then
      info "Gateway/automations API unreachable — skipping registration (no changes made)"
      info "  re-run when the Gateway is up; registration is idempotent (declarationKey)"
    else
      # Declared jobs are the single source of truth; config/reconcile.mjs aligns the
      # runtime to them (add missing / edit drifted / skip matching). This is what makes
      # an upgrade backfill --light-context onto jobs that already exist (B5/B7).
      #
      # Each declared job also carries `triggerScriptPath` = the byte-exact expected inline
      # trigger body (generated by write_trigger from the single template), so a drifted
      # live `trigger.script` is repaired on re-run instead of silently surviving
      # (T-20261010-092547). The generated files must outlive the reconcile call so the
      # `edit` branch can pass `--trigger-script <path>`; the whole dir is removed after.
      DECLARED_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-declared.XXXXXX")"
      DECLARED_FILE="$DECLARED_DIR/declared.json"
      MANIFEST="$DECLARED_DIR/manifest.txt"
      : > "$MANIFEST"
      # manifest line: key|name|agent|job|kind|interval|triggerPath
      for id in "${auto_agents[@]}"; do
        tp="$DECLARED_DIR/trigger-poll-$id.js"
        write_trigger "poll $id" "$tp"
        printf '%s|%s|%s|%s|%s|%s|%s\n' "openclaw-team:poll:$id" "poll-$id" "$id" "poll" "interval" "$POLL_INTERVAL" "$tp" >> "$MANIFEST"
      done
      # task-patrol cadence: a stale in_progress heartbeat recovery scan (NOT a claim path);
      # 15m widens the wake cadence — worker crash recovery window ≈ patrol 15m + poll 5m.
      tp="$DECLARED_DIR/trigger-task-patrol.js"; write_trigger "patrol" "$tp"
      printf '%s|%s|%s|%s|%s|%s|%s\n' "openclaw-team:task-patrol" "task-patrol" "main" "patrol" "interval" "15m" "$tp" >> "$MANIFEST"
      tp="$DECLARED_DIR/trigger-team-check-all.js"; write_trigger "check-all" "$tp"
      printf '%s|%s|%s|%s|%s|%s|%s\n' "openclaw-team:team-check-all" "team-check-all" "main" "check-all" "cron" "" "$tp" >> "$MANIFEST"
      node -e '
        const fs=require("fs");
        const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
        const jobs=lines.map(l=>{
          const [key,name,agent,job,kind,interval,tp]=l.split("|");
          const j={key,name,agent,job,kind,lightContext:true,triggerScriptPath:tp};
          if(kind==="interval") j.interval=interval;
          return j;
        });
        fs.writeFileSync(process.argv[2], JSON.stringify(jobs));
      ' "$MANIFEST" "$DECLARED_FILE"
      ACTIONS="$(printf '%s' "$AUTOMATIONS_JSON" | node "$REPO/config/reconcile.mjs" "$DECLARED_FILE")"
      while IFS='|' read -r act key name agent job id eargs; do
        case "$act" in
          add)
            case "$job" in
              poll)      register_automation "$name" "$agent" "$key" poll --every "$POLL_INTERVAL" ;;
              patrol)    register_automation "$name" "$agent" "$key" patrol --every 15m ;;
              check-all) register_automation "$name" "$agent" "$key" check-all --cron "0 * * * *" --tz Asia/Shanghai ;;
            esac ;;
          edit) info "edit     $name  ($key)"; run "${OCL[@]}" automations edit "$id" $eargs ;;
          skip) info "ok       $name  ($key)" ;;
        esac
      done <<< "$ACTIONS"
      rm -rf "$DECLARED_DIR"
    fi
  fi
fi

# ---- summary ----------------------------------------------------------------
# State is written read-modify-write so the optimizationApplied marker set in §4b
# survives the version/installedAt refresh (A3).
write_install_state version="$VERSION" installedAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)" repoPath="$REPO"
# ---- closing summary: API keys ---------------------------------------------
if [ -f "$REPO/config/api-keys.json" ]; then
  say ""
  say "API keys (closing summary)"
  krows="$(node -e '
    const m=require(process.argv[1]);const c=process.argv[2];
    for(const [k,v] of Object.entries(m.keys||{})){
      const when=v.when||"";
      if(when && !when.split(",").map(s=>s.trim()).includes("carrier="+c)) continue;
      console.log([k,(v.purpose||""),(v.configure||""),(v.required?"1":"0")].join("|"));
    }
  ' "$REPO/config/api-keys.json" "$carrier" 2>/dev/null || true)"
  while IFS='|' read -r kname kpurpose kconf kreq; do
    [ -n "$kname" ] || continue
    state="NOT SET"
    eval "curval=\${$kname:-}"
    if [ -n "$curval" ]; then state="set (environment)"
    elif [ -f "$KEYS_FILE" ] && grep -q "^$kname=" "$KEYS_FILE" 2>/dev/null; then state="provided (stored 0600)"; fi
    req=""; [ "$kreq" = 1 ] && req=" [required]"
    printf '  %-26s %s%s\n' "$kname" "$state" "$req"
    if [ "$state" = "NOT SET" ]; then info "    → $kpurpose"; info "      set it:  $kconf"; fi
  done <<< "$krows"
  info "Stored keys: $KEYS_FILE (0600; never committed). Re-run with --keys to (re)enter them."
fi

say ""
say "Done. version=$VERSION  steps=$STEPS  warnings=$WARNINGS"
[ "$DRY_RUN" = 1 ] && say "(dry-run: nothing was changed)"
if [ "$WARNINGS" -gt 0 ]; then
  say "Review the warnings above, then run: ${OCL[*]:-openclaw} doctor"
  exit 1
fi
exit 0
