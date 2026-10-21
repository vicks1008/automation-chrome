#!/usr/bin/env bash
#
# verify.sh — prove the stack actually works, end to end.
#
# Every check here exists because a weaker check has lied at some point:
# a successful launch message from a Chrome that already exited, a loaded
# LaunchAgent whose process is dead, an MCP that initializes but registers
# only its default tools because it never attached to the browser, a focus
# guard that is down so a raw Chrome answers on 9333 and steals focus.
#
# Exits 0 only if every check passes.

set -uo pipefail

PUBLIC_PORT=9333
CHROME_PORT=9335
CHROME_LABEL="com.local.automation-chrome"
GUARD_LABEL="com.local.automation-chrome-focus-guard"
RUNTIME_DIR="$HOME/.cursor/mcp-wrappers"
PUBLIC_URL="http://127.0.0.1:$PUBLIC_PORT"
FAILED=0

pass() { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$*"; FAILED=1; }
info() { printf '    %s\n' "$*"; }

echo "Verifying automation Chrome stack (guard $PUBLIC_PORT → Chrome $CHROME_PORT)"

# 1. Both LaunchAgents are loaded and own live processes.
for L in "$CHROME_LABEL" "$GUARD_LABEL"; do
  if launchctl print "gui/$(id -u)/$L" >/dev/null 2>&1; then
    PID="$(launchctl print "gui/$(id -u)/$L" 2>/dev/null | awk '/^\tpid = /{print $3}')"
    if [[ -n "$PID" ]]; then
      pass "LaunchAgent $L running (pid $PID)"
    else
      fail "LaunchAgent $L loaded but has no running process"
      info "launchctl kickstart -k gui/\$(id -u)/$L"
    fi
  else
    fail "LaunchAgent $L is not loaded"
    info "launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$L.plist"
  fi
done

# 2. The ports are the only real evidence the processes are alive.
for P in "$CHROME_PORT" "$PUBLIC_PORT"; do
  if lsof -iTCP:"$P" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    pass "port $P is listening"
  else
    fail "port $P is closed"
  fi
done

# 3. The focus guard answers its health endpoint (so 9333 is the guard, not a
#    raw Chrome that would steal focus).
if curl -sS --max-time 3 "$PUBLIC_URL/focus-guard/health" 2>/dev/null | grep -q '"ok":true'; then
  pass "focus guard health endpoint ok"
else
  fail "focus guard health endpoint silent — a raw Chrome may be bound to $PUBLIC_PORT"
fi

# 4. CDP answers through the guard, and still answers a few seconds later. A
#    shell-parented Chrome dies when its process group is torn down, which looks
#    fine for the first second or two.
if BUILD="$(curl -sS --max-time 3 "$PUBLIC_URL/json/version" 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).Browser' 2>/dev/null)"; then
  pass "CDP responds through guard: $BUILD"
  sleep 3
  if curl -sSf --max-time 3 "$PUBLIC_URL/json/version" >/dev/null 2>&1; then
    pass "still alive 3s later (not a shell-parented Chrome)"
  else
    fail "Chrome died within 3s — it was started from a shell, not launchd"
  fi
else
  fail "no response from $PUBLIC_URL/json/version"
fi

# 5. The guard is really proxying, not just up: the WebSocket URL it advertises
#    must be rewritten back to the public port, not Chrome's internal port.
WS="$(curl -sS --max-time 3 "$PUBLIC_URL/json/version" 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).webSocketDebuggerUrl' 2>/dev/null || true)"
if [[ "$WS" == *":$PUBLIC_PORT/"* ]]; then
  pass "guard rewrites advertised WebSocket URL to :$PUBLIC_PORT"
elif [[ "$WS" == *":$CHROME_PORT/"* ]]; then
  fail "WebSocket URL still points at :$CHROME_PORT — the guard is not rewriting"
else
  fail "could not read a webSocketDebuggerUrl from $PUBLIC_URL/json/version"
fi

# 6. The MCP boots with the exact installed flag set and exposes the full tool
#    surface. Flag-gated tools only register after the browser connection is
#    established, so the probe forces one first.
if [[ -f "$RUNTIME_DIR/mcp-args.json" && -f "$RUNTIME_DIR/probe-mcp.mjs" ]]; then
  # No mapfile: macOS ships bash 3.2 and this script must run on a stock Mac.
  # Index 0 is the wrapper path, which probe-mcp.mjs supplies itself.
  ARGS=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && ARGS+=("$line")
  done < <(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).slice(1).join("\n")' "$RUNTIME_DIR/mcp-args.json")
  PROBE="$(cd "$RUNTIME_DIR" && node probe-mcp.mjs "${ARGS[@]}" 2>&1 || true)"
  TOOLS="$(printf '%s' "$PROBE" | awk '/^tools:/{print $2}')"
  if [[ -n "$TOOLS" ]] && (( TOOLS >= 50 )); then
    pass "MCP exposes $TOOLS tools"
  elif [[ -n "$TOOLS" ]]; then
    fail "MCP exposed only $TOOLS tools (expected ~55)"
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

# 7. Client registration.
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

# 8. Stealth tooling is present and parses. Deliberately not exercised: a real
#    run launches a second Chrome on 9334, which is on-demand by design.
if command -v stealth-cdp >/dev/null 2>&1 && stealth-cdp --help >/dev/null 2>&1; then
  pass "stealth-cdp installed (bot-safe Chrome, port ${STEALTH_CHROME_PORT:-9334})"
else
  fail "stealth-cdp missing or not runnable"
fi
for t in gd-cookies.mjs kasada-ab-test.mjs; do
  if [[ -f "$RUNTIME_DIR/$t" ]] && node --check "$RUNTIME_DIR/$t" 2>/dev/null; then
    pass "$t installed"
  else
    fail "$RUNTIME_DIR/$t missing or has a syntax error"
  fi
done

# 9. The focus command is installed and parses.
if command -v automation-chrome-focus >/dev/null 2>&1 && node --check "$(command -v automation-chrome-focus)" 2>/dev/null; then
  pass "automation-chrome-focus installed"
else
  fail "automation-chrome-focus missing or has a syntax error"
fi

# 10. Skills are discoverable.
for d in "$HOME/.claude/skills"/*/SKILL.md "$HOME/.cursor/skills"/*/SKILL.md; do
  [[ -f "$d" ]] || continue
  case "$d" in
    *automation-chrome*|*razz-website-editor*) pass "skill installed: ~/${d#"$HOME"/}" ;;
  esac
done

echo
if (( FAILED )); then
  echo "VERIFY FAILED — fix the ✗ items above and re-run: ./verify.sh"
  exit 1
fi
echo "VERIFY OK"
