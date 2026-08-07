#!/usr/bin/env bash
#
# verify.sh — prove the stack actually works, end to end.
#
# Every check here exists because a weaker check has lied at some point:
# a successful launch message from a Chrome that already exited, a loaded
# LaunchAgent whose process is dead, an MCP that initializes but registers
# only its default tools because it never attached to the browser.
#
# Exits 0 only if every check passes.

set -uo pipefail

PORT=9333
[[ "${1:-}" == "--port" ]] && PORT="$2"

RUNTIME_DIR="$HOME/.automation-chrome"
LABEL="com.local.automation-chrome"
URL="http://127.0.0.1:$PORT"
FAILED=0

pass() { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$*"; FAILED=1; }
info() { printf '    %s\n' "$*"; }

echo "Verifying automation Chrome stack (port $PORT)"

# 1. LaunchAgent is loaded and owns a live process.
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  AGENT_PID="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}')"
  if [[ -n "$AGENT_PID" ]]; then
    pass "LaunchAgent loaded and running (pid $AGENT_PID)"
  else
    fail "LaunchAgent loaded but has no running process"
    info "launchctl kickstart -k gui/\$(id -u)/$LABEL"
  fi
else
  fail "LaunchAgent $LABEL is not loaded"
  info "launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$LABEL.plist"
fi

# 2. The port is the only real evidence Chrome is alive.
if lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
  pass "port $PORT is listening"
else
  fail "port $PORT is closed — Chrome is not running"
fi

# 3. CDP answers, and still answers a few seconds later. A Chrome that was
#    started from a shell dies when that shell's process group is torn down,
#    which looks fine for the first second or two.
if BUILD="$(curl -sS --max-time 3 "$URL/json/version" 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).Browser' 2>/dev/null)"; then
  pass "CDP responds: $BUILD"
  sleep 3
  if curl -sSf --max-time 3 "$URL/json/version" >/dev/null 2>&1; then
    pass "still alive 3s later (not a shell-parented Chrome)"
  else
    fail "Chrome died within 3s — it was started from a shell, not launchd"
  fi
else
  fail "no response from $URL/json/version"
fi

# 4. The MCP boots with the exact installed flag set and exposes the full
#    tool surface. Flag-gated tools only register after the browser
#    connection is established, so the probe forces one first.
if [[ -f "$RUNTIME_DIR/mcp-args.json" && -f "$RUNTIME_DIR/probe-mcp.mjs" ]]; then
  # No mapfile: macOS ships bash 3.2 and this script must run on a stock Mac.
  # Index 0 is the wrapper path, which probe-mcp.mjs supplies itself.
  ARGS=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && ARGS+=("$line")
  done < <(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).slice(1).join("\n")' "$RUNTIME_DIR/mcp-args.json")
  PROBE="$(cd "$RUNTIME_DIR" && node probe-mcp.mjs "${ARGS[@]}" 2>&1 || true)"
  TOOLS="$(printf '%s' "$PROBE" | awk '/^tools:/{print $2}')"
  if [[ -n "$TOOLS" ]] && (( TOOLS >= 40 )); then
    pass "MCP exposes $TOOLS tools"
  elif [[ -n "$TOOLS" ]]; then
    fail "MCP exposed only $TOOLS tools (expected ~51)"
    info "a flag was rejected, or the browser connection was not established"
    info "full probe output:"
    printf '%s\n' "$PROBE" | sed 's/^/      /'
  else
    fail "MCP did not report a tool list"
    printf '%s\n' "$PROBE" | tail -20 | sed 's/^/      /'
  fi
else
  fail "missing $RUNTIME_DIR/mcp-args.json or probe-mcp.mjs — re-run install.sh"
fi

# 5. Client registration.
if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q chrome-devtools; then
    pass "registered with Claude Code"
  else
    fail "not registered with Claude Code (claude mcp list)"
  fi
fi
if [[ -f "$HOME/.cursor/mcp.json" ]]; then
  if node -e 'const j=require(process.env.HOME+"/.cursor/mcp.json");process.exit(j.mcpServers?.["chrome-devtools"]?0:1)' 2>/dev/null; then
    pass "registered with Cursor"
  else
    fail "not registered in ~/.cursor/mcp.json"
  fi
fi

# 6. Skills are discoverable.
for d in "$HOME/.claude/skills/automation-chrome/SKILL.md" "$HOME/.cursor/skills/automation-chrome/SKILL.md"; do
  [[ -f "$d" ]] && pass "skill installed: ~/${d#"$HOME"/}"
done

echo
if (( FAILED )); then
  echo "VERIFY FAILED — fix the ✗ items above and re-run: ./verify.sh"
  exit 1
fi
echo "VERIFY OK"
