#!/usr/bin/env bash
#
# install.sh — set up the automation Chrome stack on a fresh macOS machine.
#
# Architecture (fixed ports, do not change without reading the README):
#   9335  the dedicated Chrome itself (internal, launchd job com.local.automation-chrome)
#   9333  the focus-guard proxy (public, launchd job com.local.automation-chrome-focus-guard)
#         everything — mcp.json, Playwright, scripts — talks to 9333
#   9334  the on-demand stealth Chrome (stealth-cdp spawns it; no LaunchAgent)
#
# Idempotent: safe to re-run after editing anything in this repo. Re-running is
# the supported way to apply changes.
#
# Usage:
#   ./install.sh                 # install for whichever clients are present
#   ./install.sh --no-cursor     # skip Cursor MCP + skill registration
#   ./install.sh --no-claude     # skip Claude Code MCP + skill registration
#   ./install.sh --force         # overwrite the live install / existing skills
#                                # (required on the machine that authored this bundle)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$HOME/.cursor/mcp-wrappers"
BIN_DIR="$HOME/.local/bin"
LA_DIR="$HOME/Library/LaunchAgents"
CHROME_LABEL="com.local.automation-chrome"
GUARD_LABEL="com.local.automation-chrome-focus-guard"
CHROME_PLIST="$LA_DIR/$CHROME_LABEL.plist"
GUARD_PLIST="$LA_DIR/$GUARD_LABEL.plist"
PUBLIC_PORT=9333
CHROME_PORT=9335
PUBLIC_URL="http://127.0.0.1:$PUBLIC_PORT"
CHROME_URL="http://127.0.0.1:$CHROME_PORT"
DO_CURSOR=1
DO_CLAUDE=1
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-cursor) DO_CURSOR=0; shift ;;
    --no-claude) DO_CLAUDE=0; shift ;;
    --force)     FORCE=1; shift ;;
    -h|--help)   sed -n '3,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# Reload a launchd job from a (possibly changed) plist, idempotently. bootout is
# asynchronous: bootstrapping again before the label has fully unloaded fails
# with "Input/output error" (errno 5). So wait for the label to disappear first.
reload_job() {
  local label="$1" plist="$2" uid; uid="$(id -u)"
  if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
    launchctl bootout "gui/$uid/$label" 2>/dev/null || true
    for _ in $(seq 1 40); do
      launchctl print "gui/$uid/$label" >/dev/null 2>&1 || break
      sleep 0.25
    done
  fi
  launchctl bootstrap "gui/$uid" "$plist"
  launchctl kickstart -k "gui/$uid/$label"
}

# ---------------------------------------------------------------- preflight

say "Preflight"

[[ "$(uname -s)" == "Darwin" ]] || die "macOS only (launchd + Chrome app paths)."

CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x "$CHROME_BIN" ]] || die "Google Chrome not found. Install it: brew install --cask google-chrome"
echo "    chrome:  $("$CHROME_BIN" --version 2>/dev/null || echo unknown)"

command -v node >/dev/null 2>&1 || die "node not found. Install it: brew install node"
command -v npm  >/dev/null 2>&1 || die "npm not found. Install it: brew install node"
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "node >= 20 required (found $(node -v)); chrome-devtools-mcp needs it."
echo "    node:    $(node -v) ($NODE_BIN)"

FFMPEG_BIN="$(command -v ffmpeg || true)"
if [[ -n "$FFMPEG_BIN" ]]; then
  echo "    ffmpeg:  $FFMPEG_BIN"
else
  warn "ffmpeg not found — screencast tools will be omitted. brew install ffmpeg, then re-run."
fi

echo "    (first launch may prompt for macOS permissions — approve them)"

# This bundle is authored from a live machine whose runtime dir carries extra
# tooling the bundle never installs (e.g. razz-recorder). A plain ./install.sh
# there would overwrite the live scripts and skills with the packaged copies, so
# refuse unless --force. A fresh target machine has no such marker and installs
# with no flag.
if [[ $FORCE -ne 1 && -d "$RUNTIME_DIR/razz-recorder" ]]; then
  die "This looks like the machine that authors this bundle (found $RUNTIME_DIR/razz-recorder).
       Re-run with --force to overwrite the live install, or run it on the target machine."
fi

# ------------------------------------------------------------------ scripts

say "Installing scripts to $BIN_DIR"
mkdir -p "$BIN_DIR" "$RUNTIME_DIR"
for f in "$REPO_DIR"/bin/*; do
  install -m 0755 "$f" "$BIN_DIR/$(basename "$f")"
  echo "    $(basename "$f")"
done

if ! printf '%s' ":$PATH:" | grep -q ":$BIN_DIR:"; then
  warn "$BIN_DIR is not on your PATH."
  for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
    [[ -f "$rc" ]] || continue
    if ! grep -q '\.local/bin' "$rc"; then
      printf '\n# automation-chrome\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$rc"
      echo "    appended PATH export to $rc"
    fi
  done
  export PATH="$BIN_DIR:$PATH"
fi

# ------------------------------------------------- mcp wrapper + focus guard

say "Installing MCP wrapper and focus guard to $RUNTIME_DIR"
install -m 0755 "$REPO_DIR/mcp/chrome-devtools-mcp-filtered.mjs" "$RUNTIME_DIR/"
install -m 0755 "$REPO_DIR/mcp/focus-guard.mjs"                  "$RUNTIME_DIR/"
install -m 0755 "$REPO_DIR/mcp/probe-mcp.mjs"                    "$RUNTIME_DIR/"
install -m 0644 "$REPO_DIR/mcp/package.json"                     "$RUNTIME_DIR/"

say "Installing bot-detection tools to $RUNTIME_DIR"
for f in "$REPO_DIR"/tools/*.mjs; do
  install -m 0755 "$f" "$RUNTIME_DIR/$(basename "$f")"
  echo "    $(basename "$f")"
done

# The wrapper resolves chrome-devtools-mcp with createRequire from this
# directory, which cannot see globally-installed packages. This local install is
# what pins the version — do not replace it with `npm i -g`. `ws` is needed by
# focus-guard.mjs and automation-chrome-focus.
say "Installing pinned dependencies (local install)"
( cd "$RUNTIME_DIR" && npm install --no-audit --no-fund --loglevel=error )
MCP_VERSION="$(node -p "require('$RUNTIME_DIR/node_modules/chrome-devtools-mcp/package.json').version")"
echo "    chrome-devtools-mcp@$MCP_VERSION + ws"

# ------------------------------------------------------------------ launchd

say "Installing LaunchAgents"
mkdir -p "$LA_DIR"
sed "s|__HOME__|$HOME|g" \
  "$REPO_DIR/launchd/$CHROME_LABEL.plist.template" >"$CHROME_PLIST"
echo "    $CHROME_LABEL.plist"
sed -e "s|__HOME__|$HOME|g" -e "s|__NODE__|$NODE_BIN|g" \
  "$REPO_DIR/launchd/$GUARD_LABEL.plist.template" >"$GUARD_PLIST"
echo "    $GUARD_LABEL.plist"

# Boot order matters: Chrome must own 9335 before the guard binds 9333 and
# proxies to it. Bring up Chrome first, wait for it, then the guard.
say "Starting Chrome (internal port $CHROME_PORT) via launchd"
reload_job "$CHROME_LABEL" "$CHROME_PLIST"
for _ in $(seq 1 40); do
  sleep 0.5
  curl -sSf --max-time 2 "$CHROME_URL/json/version" >/dev/null 2>&1 && { echo "    $CHROME_URL is up"; break; }
done
curl -sSf --max-time 2 "$CHROME_URL/json/version" >/dev/null 2>&1 \
  || die "Chrome never came up on $CHROME_PORT. Check $RUNTIME_DIR/automation-chrome.launchd.err.log"

say "Starting focus guard (public port $PUBLIC_PORT) via launchd"
reload_job "$GUARD_LABEL" "$GUARD_PLIST"
for _ in $(seq 1 40); do
  sleep 0.5
  curl -sSf --max-time 2 "$PUBLIC_URL/focus-guard/health" >/dev/null 2>&1 && { echo "    $PUBLIC_URL is proxying"; break; }
done
curl -sSf --max-time 2 "$PUBLIC_URL/focus-guard/health" >/dev/null 2>&1 \
  || die "Focus guard never came up on $PUBLIC_PORT. Check $RUNTIME_DIR/focus-guard.launchd.err.log"

# --------------------------------------------------------------- mcp clients

MCP_ARGS=(
  "$RUNTIME_DIR/chrome-devtools-mcp-filtered.mjs"
  "--browserUrl" "$PUBLIC_URL"
  "--logFile"    "$RUNTIME_DIR/chrome-devtools-mcp.log"
  "--memoryDebugging=true"
  "--experimentalVision=true"
)
if [[ -n "$FFMPEG_BIN" ]]; then
  MCP_ARGS+=( "--experimentalScreencast=true" "--experimentalFfmpegPath=$FFMPEG_BIN" )
fi
MCP_ARGS+=(
  "--categoryExperimentalThirdParty=true"
  "--categoryExperimentalWebmcp=true"
  "--categoryExtensions=true"
  "--allow-unrestricted-paths"
  "--no-page-id-routing"
  "--no-usage-statistics"
)

# Single source of truth for the resolved flag set: both client configs and
# verify.sh read it, so they can never drift from each other.
MCP_ARGS_JSON="$(printf '%s\n' "${MCP_ARGS[@]}" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>
    console.log(JSON.stringify(d.split("\n").filter(Boolean),null,2)));')"
printf '%s\n' "$MCP_ARGS_JSON" >"$RUNTIME_DIR/mcp-args.json"

if [[ "$DO_CLAUDE" == "1" ]] && command -v claude >/dev/null 2>&1; then
  say "Registering MCP with Claude Code (user scope)"
  claude mcp remove chrome-devtools --scope user >/dev/null 2>&1 || true
  claude mcp add chrome-devtools --scope user \
    -e CDM_PATCH_LOG=1 -e CDM_EXCLUDE_URL_PATTERNS=godaddy.com \
    -- node "${MCP_ARGS[@]}"
  echo "    claude mcp list → $(claude mcp list 2>/dev/null | grep -c chrome-devtools || echo 0) entry"
elif [[ "$DO_CLAUDE" == "1" ]]; then
  warn "claude CLI not found; skipping Claude Code MCP registration."
fi

if [[ "$DO_CURSOR" == "1" ]]; then
  say "Registering MCP with Cursor (~/.cursor/mcp.json)"
  mkdir -p "$HOME/.cursor"
  CFG="$HOME/.cursor/mcp.json" ARGS="$MCP_ARGS_JSON" node -e '
    const fs=require("fs");
    const p=process.env.CFG;
    let j={};
    if(fs.existsSync(p)){
      // Always back up before touching an existing config.
      fs.copyFileSync(p,p+".bak");
      try{ j=JSON.parse(fs.readFileSync(p,"utf8")); }
      catch(e){ console.error("    existing mcp.json is not valid JSON; backed up to .bak, starting fresh"); j={}; }
    }
    j.mcpServers=j.mcpServers||{};
    j.mcpServers["chrome-devtools"]={
      command:"node",
      args:JSON.parse(process.env.ARGS),
      env:{CDM_PATCH_LOG:"1",CDM_EXCLUDE_URL_PATTERNS:"godaddy.com"}
    };
    fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
    console.log("    wrote "+p+" (other servers preserved)");
  '
fi

# ------------------------------------------------------------------- skills

# Skills accrue learned, machine-specific notes over time (the learning loop).
# Install them only if absent, so a re-run never clobbers local edits. --force
# overwrites.
install_skill() {
  local src_dir="$1" dest_root="$2" label="$3"
  local name; name="$(basename "$src_dir")"
  local dest="$dest_root/$name"
  if [[ -e "$dest/SKILL.md" && $FORCE -ne 1 ]]; then
    echo "    $label → kept existing $name (pass --force to overwrite)"
    return
  fi
  mkdir -p "$dest"
  # Copy the whole skill tree (SKILL.md + any references/ and scripts/).
  cp -R "$src_dir/." "$dest/"
  echo "    $label → $dest/SKILL.md"
}

say "Installing skills"
for sk in "$REPO_DIR"/skills/*/; do
  [[ -d "$sk" ]] || continue
  [[ "$DO_CLAUDE" == "1" ]] && install_skill "${sk%/}" "$HOME/.claude/skills" "Claude Code"
  [[ "$DO_CURSOR" == "1" ]] && install_skill "${sk%/}" "$HOME/.cursor/skills" "Cursor"
done

install -m 0644 "$REPO_DIR/README.md" "$RUNTIME_DIR/README.md"

# ------------------------------------------------------------------- verify

say "Verifying"
"$REPO_DIR/verify.sh"

cat <<EOF

$(say "Done")
    Runtime dir:  $RUNTIME_DIR
    Public CDP:   $PUBLIC_URL  (focus guard → Chrome on $CHROME_PORT)
    Reference:    $RUNTIME_DIR/README.md

Restart your MCP client so it picks up the new server:
    Cursor       reload the window (Cmd+Shift+P → Developer: Reload Window)
    Claude Code  start a new session, then run /mcp to confirm it connected
EOF
