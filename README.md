# automation-chrome

A dedicated, always-running Chrome for AI coding agents to drive over CDP —
separate from your everyday browser, supervised by launchd, and wired into both
Cursor and Claude Code through the `chrome-devtools` MCP.

```bash
git clone https://github.com/vicks1008/automation-chrome.git ~/Development/automation-chrome
cd ~/Development/automation-chrome
./install.sh
```

Re-running `install.sh` is the supported way to apply any change.
`PROMPT.md` holds the master prompt for setting this up on a new machine with
an AI agent driving.

## Why a separate Chrome

Pointing `chrome-devtools-mcp` at your main Chrome creates a flaky loop:

- Main Chrome is usually launched by `open`, so `--remote-debugging-port` may or
  may not survive Launch Services; sometimes the port is bound but
  `/json/version` returns nothing.
- "Continue where you left off" plus dozens of background tabs means Puppeteer's
  `Network.enable` times out attaching to dormant targets
  ([#775](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/775)).
- Multiple editor workspaces fight over the same debug port
  ([#1156](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1156)).
- `DevToolsActivePort` goes stale in Chrome 144+, so `--autoConnect` breaks
  silently.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  macOS login                                                       │
│     │                                                              │
│     ▼                                                              │
│  launchd (com.local.automation-chrome)  ← ~/Library/LaunchAgents/  │
│     │                                                              │
│     ▼                                                              │
│  automation-chrome  ─── execs ──►  Google Chrome                   │
│                                    --user-data-dir=CursorAutomation│
│                                    --remote-debugging-port=9333    │
│                                    (visible window, clean tabs)    │
│                                       ▲                            │
│  Cursor ─┐                            │                            │
│          ├─ spawns ─► chrome-devtools-mcp-filtered.mjs ────────────┘
│  Claude ─┘             (wrapper: target filtering + logging)       │
│                        --browserUrl http://127.0.0.1:9333          │
│                                                                    │
│  stealth-cdp ─── spawns on demand ──►  Google Chrome               │
│  (raw CDP, no Runtime.enable)          --user-data-dir=CursorStealth
│                                        --remote-debugging-port=9334│
│                                        (invisible to the MCP)      │
└────────────────────────────────────────────────────────────────────┘
```

Port **9333**, not 9222: a main Chrome previously launched with
`--remote-debugging-port` squats 9222 on IPv4 and answers slowly or not at all.
Separate ports mean the MCP only ever talks to the clean profile.

## Layout

| Path | Role |
| ---- | ---- |
| `~/.local/bin/automation-chrome` | Launches the dedicated Chrome. Idempotent. `AUTOMATION_CHROME_FOREGROUND=1` for launchd. |
| `~/.local/bin/automation-chrome-health` | Verifies port 9333, `/json/version`, target count, MCP processes. |
| `~/.local/bin/automation-chrome-reset` | Kills wedged MCPs and restarts Chrome through launchd. |
| `~/.local/bin/automation-chrome-sync-cookies` | Hot-copies Cookies + Local Storage from the main profile. **Not for bot-managed sites** — see below. |
| `~/.local/bin/stealth-cdp` | Drives a page over raw CDP without `Runtime.enable`, in its own Chrome on port 9334. For bot-protected sites. |
| `~/Library/LaunchAgents/com.local.automation-chrome.plist` | Starts at login, restarts on crash (not on clean quit). |
| `~/.automation-chrome/` | Runtime dir: MCP wrapper, pinned `node_modules`, logs, resolved flag set. |
| `~/.automation-chrome/chrome-devtools-mcp-filtered.mjs` | Wrapper that monkey-patches `puppeteer.connect` for target filtering. |
| `~/.automation-chrome/mcp-args.json` | The resolved MCP flag set. Written by the installer; read by `verify.sh`. |
| `~/.automation-chrome/probe-mcp.mjs` | Boots the MCP with a candidate flag set and reports the tool surface. |
| `~/.automation-chrome/gd-cookies.mjs` | Lists/clears bot-management cookies and storage for a domain, over CDP. |
| `~/.automation-chrome/kasada-ab-test.mjs` | A/B harness: measures which CDP domains trip a site's bot detection. |
| `~/.automation-chrome/stealth-target.json` | Which tab `stealth-cdp` is currently driving. |
| `~/Library/Application Support/Google/Chrome/CursorAutomation/` | The dedicated profile. Created on first launch; logins persist. |
| `~/Library/Application Support/Google/Chrome/CursorStealth/` | Profile for the stealth Chrome (port 9334). Logins persist here too. |
| `~/.claude/skills/automation-chrome/`, `~/.cursor/skills/automation-chrome/` | The skill, so agents know how to operate this. |

The profile keeps the name `CursorAutomation` even on a Claude-only machine:
`pgrep -f "user-data-dir=.*CursorAutomation"` is baked into every script and the
docs, and renaming it buys nothing.

## Daily workflow

Nothing to do. Chrome is always running and the MCP connects automatically.
Look for the Chrome window whose profile pill reads `CursorAutomation`.

```bash
automation-chrome-health         # is everything alive?
automation-chrome-reset          # kill wedged MCP + restart Chrome if down
automation-chrome-sync-cookies   # re-pull sessions from main Chrome
stealth-cdp status               # is the bot-safe Chrome (9334) up, what tab?
./verify.sh                      # full end-to-end check incl. MCP tool count
```

If a session expires, just log in once inside the automation window — the
profile survives launchd restarts.

## Enabled tool categories

The installer passes these so the full DevTools-for-agents surface (~51 tools)
is exposed rather than the core defaults:

| Flag | Adds |
| ---- | ---- |
| `--memoryDebugging=true` | Heap snapshot tools. |
| `--experimentalVision=true` | `click_at(x,y)` coordinate clicking. |
| `--experimentalScreencast=true` | `screencast_start` / `screencast_stop` (needs ffmpeg). |
| `--experimentalFfmpegPath=...` | Resolved from `command -v ffmpeg` at install time, so screencast works regardless of the client's PATH. |
| `--categoryExperimentalThirdParty=true` | `list_3p_developer_tools`, `execute_3p_developer_tool`. |
| `--categoryExperimentalWebmcp=true` | `list_webmcp_tools`, `execute_webmcp_tool`. |
| `--categoryExtensions=true` | Extension install/reload/uninstall/trigger. |
| `--allow-unrestricted-paths` | Lets file-writing tools save outside the OS temp dir. 1.6.0 restricts them unless the client negotiates MCP roots, which Cursor does not. |

Core categories (input, navigation, emulation, performance, network, debugging,
lighthouse) are on by default.

### Caveats that cost real time to find

- **The browser connection is lazy.** Flag-gated tools only register after the
  MCP has actually attached to Chrome, so a `tools/list` issued right after
  `initialize` under-reports — 29 instead of 51. `probe-mcp.mjs` calls
  `list_pages` first to force the connection; do the same in any other harness.
- **`take_screenshot` downscales — never read coordinates off it.** A page
  reporting `innerWidth === 1732` came back as a 1024px-wide image. Coordinates
  taken from the image are short by ~40% and `click_at` lands on nothing, which
  reads as a dead button. Take geometry from `getBoundingClientRect()` and
  confirm with `document.elementFromPoint` before clicking.
- **The WebMCP feature flag was renamed** between 1.2.0 (`WebMCPTesting`) and
  1.6.0 (`WebMCP`). The launcher passes `WebMCP,WebMCPTesting,DevToolsWebMCPSupport`
  — an unrecognised feature name is ignored rather than fatal.
- **Extension tools now work with `--browserUrl`.** In 1.2.0 the combination made
  the server refuse to start. As of 1.6.0 it boots fine and adds 5 tools.
- **`--experimentalPageIdRouting`** would address multi-workspace port contention
  (#1156) but adds a `pageId` parameter to every page-scoped tool. Left off so
  the calling convention stays stable.
- **A scripted click that does nothing** is diagnosed in order: verify the click
  lands (`document.elementFromPoint`), then that a handler exists, then invoke
  the handler directly and await it. Frameworks routinely discard the returned
  promise, so a server-side rejection produces no console error and no UI
  feedback. WebSocket transports (Meteor DDP, GraphQL subscriptions) are
  invisible to `fetch`/XHR hooks and to `list_network_requests`.

## Bot detection: why `Runtime.enable` is poison

Some sites (Kasada, Akamai, DataDome) refuse to authenticate any tab the MCP is
attached to. The symptom is a modal reading *"Your browser is a bit unusual…
Enable JavaScript… Disconnect from your VPN…"* over a **429** on the auth XHR.

The modal is a red herring. JavaScript is fine and the fingerprint is clean
(`navigator.webdriver === false`, real UA, real WebGL). The trigger is
**`Runtime.enable`** — it switches the renderer into "a debugger is listening"
mode, streaming `executionContextCreated` and `consoleAPICalled`. That state is
observable from inside the page with no network round-trip, and Puppeteer calls
it on every frame it attaches to. Measured one variable at a time against a
Kasada-protected login, identical profile/machine/IP:

| CDP domain enabled | auth XHR |
| ------------------ | -------- |
| `Page` only | 200 OK |
| `Network.enable` | 200 OK |
| `Log.enable` | 200 OK |
| `DOM.enable` | 200 OK |
| `Runtime.evaluate` (no enable) | 200 OK |
| **`Runtime.enable`** | **429 blocked** |

Reproduce it on any Kasada-protected login:

```bash
node ~/.automation-chrome/kasada-ab-test.mjs --username=you@example.com --variant=clean    # expect 200
node ~/.automation-chrome/kasada-ab-test.mjs --username=you@example.com --variant=runtime  # expect 429
```

### Two mitigations, applied together

**1. The MCP never attaches to hostile origins.** Set
`CDM_EXCLUDE_URL_PATTERNS` (comma-separated substrings) in the MCP env and the
wrapper's `targetFilter` rejects those targets before Puppeteer can attach.
Confirm it is live by looking for `[cdm-wrapper] EXCLUDE https://...` in the MCP
stderr, which needs `CDM_PATCH_LOG=1` (the installer sets it). To add origins:

```bash
claude mcp remove chrome-devtools --scope user
claude mcp add chrome-devtools --scope user \
  -e CDM_PATCH_LOG=1 -e CDM_EXCLUDE_URL_PATTERNS=godaddy.com,example.com \
  -- node $(node -p 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.automation-chrome/mcp-args.json","utf8")).join(" ")')
```

For Cursor, add the same key to `env` in `~/.cursor/mcp.json`.

**2. `stealth-cdp` drives those sites instead.** It speaks raw CDP and uses
`Runtime.evaluate` — a one-shot command that does *not* flip the debugger
switch — plus real `Input.*` events. It runs its own Chrome on **port 9334**
with its own persistent profile, so the MCP on 9333 cannot see it at all.

A URL exclude alone is not airtight: a tab is briefly `about:blank` between
creation and navigation, and Puppeteer can attach during that window and enable
Runtime before the filter has a URL to match. Separate browsers is the only
airtight answer.

```bash
stealth-cdp status                                   # is it up, which tab
stealth-cdp open "https://sso.godaddy.com/"
stealth-cdp type '#username' 'you@example.com'
stealth-cdp type '#password' --stdin < ~/.secrets/gd # keeps it out of argv
stealth-cdp click 'button[type=submit]'
stealth-cdp clicktext 'Add New Record'               # click by visible label
stealth-cdp clickxy 640 380                          # reaches cross-origin iframes
stealth-cdp typefocused 'text'                       # for iframe fields
stealth-cdp net idp                                  # status codes, no Network domain
stealth-cdp shot /tmp/out.png
stealth-cdp focus                                    # raise the window to log in by hand
```

The stealth Chrome does not need launchd. It is spawned with `detached: true`,
which makes it a process-group leader via `setsid`, so tearing down the calling
shell's process group does not reach it. The main launcher's `nohup` only
ignores SIGHUP and cannot survive that — which is exactly why *it* is given to
launchd instead.

`stealth-cdp` has no `Runtime.enable`, so there is no console-message stream and
no network event stream. `net` reads `performance.getEntriesByType('resource')`,
which exposes `responseStatus` without enabling the Network domain.

### Click by label, do not tag the DOM

`clicktext` exists to replace this idiom, which was the default way to reach a
control with no stable selector:

```bash
# DON'T: mutates the page
stealth-cdp eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^Save$/i.test(x.innerText));b.id='sc-x';return 'ok'})()"
stealth-cdp click '#sc-x'
```

An injected `id` is **not inert**. SPA routers, tab strips, `label[for]` pairs
and anchor targets all read `id`. Setting `id="sc-dnstab"` on a GoDaddy tab
button made its router treat the injected value as the tab key, navigate to
`?tab=sc-dnstab`, and render an empty table — which reads as "the page is
broken", not "the tool broke the page". Use `data-*` if you must tag something;
prefer not tagging at all.

```bash
stealth-cdp clicktext 'Save'                       # innerText or aria-label
stealth-cdp clicktext 'Delete' --scope='tbody tr'  # narrow the search root
stealth-cdp clicktext 'DNS' --nth=1                # disambiguate; count is printed
stealth-cdp clicktext 'Add New' --contains         # substring
```

It matches `aria-label` as well as text, so icon-only row buttons are reachable
by accessible name, skips hidden elements, and resolves to the **innermost**
match — a wrapper inherits its child's `innerText`, and clicking the wrapper
often misses the real handler. When more than one element matches it prints the
count, so ambiguity is visible instead of silently resolving to the first hit.

**Do not sync cookies into a bot-protected site.** Akamai/Kasada/DataDome
cookies (`_abck`, `bm_*`, `ak_bmsc`, `reese84`, `datadome`) are bound to the
fingerprint of the browser that minted them, so replaying them from another
instance looks exactly like cookie theft and actively causes blocks. An `_abck`
whose second `~`-delimited field is `0` rather than `-1` is already marked bad.
Log in inside the automation window instead. To inspect or reset them:

```bash
node ~/.automation-chrome/gd-cookies.mjs list  godaddy   # flags [BOT-MGMT] entries
node ~/.automation-chrome/gd-cookies.mjs clear godaddy   # cookies + local storage + IDB
```

Despite the name it takes any domain substring, and
`AUTOMATION_CHROME_DEBUG_PORT=9334` points it at the stealth Chrome instead.

**Do not inject `id` attributes to find elements.** An injected `id` is not
inert: SPA routers, tab strips, `label[for]` pairs and anchor targets all read
it. Setting `id="x"` on a tab button made its router treat the injected value as
the tab key and render an empty table — which reads as "the page is broken", not
"the tool broke the page". Use `data-*` if you must tag, prefer matching on
accessible name.

## Upgrading chrome-devtools-mcp

The wrapper resolves the package from `~/.automation-chrome/node_modules` via
`createRequire`, which **cannot see globally-installed packages** — `npm i -g`
has no effect here.

```bash
cd ~/.automation-chrome
npm install chrome-devtools-mcp@latest

# confirm the flag names still exist
node ./node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js --help \
  | grep -iE "category|experimental|memory|paths"

# boot the installed flag set and count the resulting tools
cd ~/Development/automation-chrome && ./verify.sh
```

A rejected flag makes the server exit at launch, so verify before relying on it.
Then bump the pin in `mcp/package.json` in this repo so a fresh install matches.

## LaunchAgent management

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.automation-chrome.plist
launchctl bootout   gui/$(id -u)/com.local.automation-chrome     # stop until next login
launchctl kickstart -k gui/$(id -u)/com.local.automation-chrome  # force restart now
launchctl print     gui/$(id -u)/com.local.automation-chrome     # status
```

## Troubleshooting

**MCP returns `Not connected` after a config change.** Clients cache MCP state.
Cursor: reload the window, or toggle the server in Settings → Features → MCP.
Claude Code: start a new session and run `/mcp`.

**Chrome keeps relaunching unexpectedly.** Check
`~/.automation-chrome/automation-chrome.launchd.err.log`. If Chrome exits
non-zero, `KeepAlive.Crashed=true` restarts it.

**You want it gone temporarily.** Quit the window normally. Because
`SuccessfulExit=false`, launchd won't resurrect it until next login.

**Port 9333 collides with another tool.** Re-run `./install.sh --port 9444`,
which updates the agent and both client configs together.

**A site says "your browser is unusual" / "enable JavaScript" / "disable your
VPN".** That is bot management, not a real browser problem. Confirm by checking
whether the site's auth XHRs return 429, then drive it with `stealth-cdp`
instead of the MCP and add the origin to `CDM_EXCLUDE_URL_PATTERNS`. If the site
was working before, clear its bot cookies first with `gd-cookies.mjs clear`.

**A page suddenly returns empty lists / no rows.** Check the URL before
debugging selectors. Expired sessions usually redirect to a login page that
still parses fine, so queries return `[]` rather than an error. The stealth
profile's sessions expire (typically overnight); run `stealth-cdp url` first,
and `stealth-cdp focus` to raise the window and log back in.

**Do not conclude a host is down from a failed connection.** Outbound port 25 is
blocked on most consumer networks, and CDN challenge pages return 403 to any
request without a browser User-Agent. Both look exactly like an outage. Test a
known-good control host first.

**Logs.** `~/.automation-chrome/` holds `automation-chrome.log` (manual
launches), `automation-chrome.launchd.{out,err}.log`, and
`chrome-devtools-mcp.log`. The MCP protocol log records full CDP traffic
including form submissions, so `automation-chrome` rotates anything over 32MB to
`<name>.log.1` on each launch.
