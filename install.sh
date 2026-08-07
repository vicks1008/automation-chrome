#!/usr/bin/env bash
#
# install.sh — set up the automation Chrome stack on a fresh macOS machine.
#
# Idempotent: safe to re-run after editing anything in this repo. Re-running
# is the supported way to apply changes.
#
# Usage:
#   ./install.sh                 # install for whichever clients are present
#   ./install.sh --no-cursor     # skip Cursor MCP + skill registration
#   ./install.sh --no-claude     # skip Claude Code MCP + skill registration
#   ./install.sh --port 9444     # use a different CDP port everywhere

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$HOME/.automation-chrome"
BIN_DIR="$HOME/.local/bin"
LABEL="com.local.automation-chrome"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT=9333
DO_CURSOR=1
DO_CLAUDE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-cursor) DO_CURSOR=0; shift ;;
    --no-claude) DO_CLAUDE=0; shift ;;
    --port)      PORT="$2"; shift 2 ;;
    -h|--help)   sed -n '3,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

BROWSER_URL="http://127.0.0.1:$PORT"
say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

say "Preflight"

[[ "$(uname -s)" == "Darwin" ]] || die "macOS only (launchd + Chrome app paths)."

CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x "$CHROME_BIN" ]] || die "Google Chrome not found. Install it: brew install --cask google-chrome"
CHROME_VERSION="$("$CHROME_BIN" --version 2>/dev/null || echo unknown)"
echo "    chrome:  $CHROME_VERSION"

command -v node >/dev/null 2>&1 || die "node not found. Install it: brew install node"
command -v npm  >/dev/null 2>&1 || die "npm not found. Install it: brew install node"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "node >= 20 required (found $(node -v)); chrome-devtools-mcp needs it."
echo "    node:    $(node -v)"

FFMPEG_BIN="$(command -v ffmpeg || true)"
if [[ -n "$FFMPEG_BIN" ]]; then
  echo "    ffmpeg:  $FFMPEG_BIN"
else
  warn "ffmpeg not found — screencast tools will be omitted. brew install ffmpeg, then re-run."
fi

# Chrome asks for Screen Recording / Accessibility permission the first time
# something drives it. That is a GUI-only grant; flag it early rather than
# letting it surface as a mysterious failure later.
echo "    (first launch may prompt for macOS permissions — approve them)"

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

# ------------------------------------------------------------- mcp wrapper

say "Installing MCP wrapper to $RUNTIME_DIR"
install -m 0755 "$REPO_DIR/mcp/chrome-devtools-mcp-filtered.mjs" "$RUNTIME_DIR/"
install -m 0755 "$REPO_DIR/mcp/probe-mcp.mjs"                    "$RUNTIME_DIR/"
install -m 0644 "$REPO_DIR/mcp/package.json"                     "$RUNTIME_DIR/"

say "Installing bot-detection tools to $RUNTIME_DIR"
for f in "$REPO_DIR"/tools/*.mjs; do
  install -m 0755 "$f" "$RUNTIME_DIR/$(basename "$f")"
  echo "    $(basename "$f")"
done

# The wrapper resolves chrome-devtools-mcp with createRequire from its own
# directory, which cannot see globally-installed packages. The local install
# is what pins the version — do not replace it with `npm i -g`.
say "Pinning chrome-devtools-mcp (local install)"
( cd "$RUNTIME_DIR" && npm install --no-audit --no-fund --loglevel=error )
MCP_VERSION="$(node -p "require('$RUNTIME_DIR/node_modules/chrome-devtools-mcp/package.json').version")"
echo "    chrome-devtools-mcp@$MCP_VERSION"

# ------------------------------------------------------------------ launchd

say "Installing LaunchAgent"
mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__HOME__|$HOME|g" \
  "$REPO_DIR/launchd/$LABEL.plist.template" >"$PLIST_DST"
if [[ "$PORT" != "9333" ]]; then
  # Inject the port override into the agent's environment.
  /usr/libexec/PlistBuddy -c \
    "Add :EnvironmentVariables:AUTOMATION_CHROME_DEBUG_PORT string $PORT" \
    "$PLIST_DST" 2>/dev/null || true
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "    bootstrapped $LABEL"

say "Waiting for Chrome to listen on $PORT"
for _ in $(seq 1 40); do
  sleep 0.5
  if curl -sSf --max-time 2 "$BROWSER_URL/json/version" >/dev/null 2>&1; then
    echo "    $BROWSER_URL is up"
    break
  fi
done
curl -sSf --max-time 2 "$BROWSER_URL/json/version" >/dev/null 2>&1 \
  || die "Chrome never came up on $PORT. Check $RUNTIME_DIR/automation-chrome.launchd.err.log"

# -------------------------------------------------------------- mcp clients

MCP_ARGS=(
  "$RUNTIME_DIR/chrome-devtools-mcp-filtered.mjs"
  "--browserUrl" "$BROWSER_URL"
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
  claude mcp add chrome-devtools --scope user -e CDM_PATCH_LOG=1 -- node "${MCP_ARGS[@]}"
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
      try{ j=JSON.parse(fs.readFileSync(p,"utf8")); }
      catch(e){ console.error("    existing mcp.json is not valid JSON; backing it up");
                fs.copyFileSync(p,p+".bak"); j={}; }
    }
    j.mcpServers=j.mcpServers||{};
    j.mcpServers["chrome-devtools"]={
      command:"node",
      args:JSON.parse(process.env.ARGS),
      env:{CDM_PATCH_LOG:"1"}
    };
    fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
    console.log("    wrote "+p+" (other servers preserved)");
  '
fi

# ------------------------------------------------------------------- skills

install_skill() {
  local dest="$1" label="$2"
  mkdir -p "$dest/automation-chrome"
  install -m 0644 "$REPO_DIR/skills/automation-chrome/SKILL.md" "$dest/automation-chrome/SKILL.md"
  echo "    $label → $dest/automation-chrome/SKILL.md"
}

say "Installing the automation-chrome skill"
[[ "$DO_CLAUDE" == "1" ]] && install_skill "$HOME/.claude/skills" "Claude Code"
[[ "$DO_CURSOR" == "1" ]] && install_skill "$HOME/.cursor/skills" "Cursor"

install -m 0644 "$REPO_DIR/README.md" "$RUNTIME_DIR/README.md"

# ------------------------------------------------------------------- verify

say "Verifying"
"$REPO_DIR/verify.sh" --port "$PORT"

cat <<EOF

$(say "Done")
    Runtime dir:  $RUNTIME_DIR
    CDP endpoint: $BROWSER_URL
    Reference:    $RUNTIME_DIR/README.md

Restart your MCP client so it picks up the new server:
    Cursor       reload the window (Cmd+Shift+P → Developer: Reload Window)
    Claude Code  start a new session, then run /mcp to confirm it connected
EOF
