---
name: automation-chrome
description: Start, verify, troubleshoot, and audit the dedicated automation Chrome (CursorAutomation profile, port 9333) that the chrome-devtools MCP attaches to. Use when the user asks to use automation-chrome or Chrome automation, before driving chrome-devtools MCP tools, when a browser tool call fails with "Could not connect to Chrome", or when asked to check automation-chrome for updates, upgrade chrome-devtools-mcp, or audit the stack for drift.
---

# Automation Chrome

The chrome-devtools MCP does not launch a browser. It attaches over CDP to an
already-running Chrome at `http://127.0.0.1:9333`, using the dedicated
`CursorAutomation` profile supervised by launchd.

## The focus guard: never raise the window

`http://127.0.0.1:9333` is **not** Chrome itself — it is the `focus-guard`
proxy (`~/.cursor/mcp-wrappers/focus-guard.mjs`, launchd job
`com.local.automation-chrome-focus-guard`). Chrome listens internally on
**9335**; the guard forwards 9333 -> 9335 and silently neutralises the three
commands that would pull macOS keyboard focus to Chrome and interrupt the user:

- `Target.createTarget` is rewritten to `{ background: true, newWindow: true }`,
  so every new page opens as its own **inactive window** that renders fully
  (screenshots and lazy iframes work) without the app ever coming forward.
- `Page.bringToFront` and `Target.activateTarget` are answered locally with an
  empty success result and never reach Chrome.
- HTTP `/json/new` creates a background window; `/json/activate/<id>` is a no-op.

Consequences for how you drive it:

- **Never try to raise the window to make a page render.** It already renders in
  the background. Calls to `bringToFront` / `activateTarget` succeed but do
  nothing, by design. This is the whole point — do not work around it.
- **Only raise the window for a genuine human hand-off** (the user must log in or
  type an MFA code). Use `automation-chrome-focus` for that; it talks straight to
  Chrome on 9335 and raises the exact `CursorAutomation` process. With no
  argument it raises the most recent page, or pass a target id or URL substring.
- Ports: `9333` guard (public, what `mcp.json` and every workflow use), `9335`
  Chrome (internal), `9334` the separate `stealth-cdp` Chrome.

## Start it with launchd, never from a shell

```bash
launchctl kickstart -k gui/$(id -u)/com.local.automation-chrome
```

Running `automation-chrome` directly looks like it works — it prints
`ready on port 9335` and an immediate health check passes — then Chrome dies
the moment the command returns. The launcher backgrounds Chrome inside the
agent shell's process group, which is torn down on completion. `nohup` does not
save it. launchd owns the process independently of any shell, so it survives.

If kickstart reports the service is not loaded:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.automation-chrome.plist
```

**Reloading a changed plist: `bootout` is asynchronous.** To pick up an edited
plist you must `bootout` then `bootstrap`, but bootstrapping immediately after
bootout fails with `Bootstrap failed: 5: Input/output error` (errno 5) because
the label has not finished unloading. Worse, the job is left *booted out* (Chrome
down) while the script dies on `set -e`. Wait for the label to disappear first:

```bash
launchctl bootout gui/$(id -u)/com.local.automation-chrome 2>/dev/null || true
for _ in $(seq 1 40); do launchctl print gui/$(id -u)/com.local.automation-chrome >/dev/null 2>&1 || break; sleep 0.25; done
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.automation-chrome.plist
launchctl kickstart -k gui/$(id -u)/com.local.automation-chrome
```

## Verify the port, not the launch message

```bash
automation-chrome-health
curl -s --max-time 5 http://127.0.0.1:9335/json/version   # Chrome itself
curl -s --max-time 5 http://127.0.0.1:9333/json/version   # through the guard
```

Confirm 9335 (Chrome) is still listening a few seconds later. A Chrome that
already exited leaves a successful-looking launch message and a stale health
check behind, so treat the port as the only real evidence.

`Could not connect to Chrome` from any MCP browser tool means the chain is
broken: either the guard is down on 9333 or Chrome is down on 9335. Check both
(`automation-chrome-health` reports each), start what is missing, then retry.

## It is a separate profile from the user's own Chrome

`CursorAutomation` keeps its own cookies, sessions, and `localStorage`. Two consequences:

- Anything the user is asked to do by hand must happen in **that** window or it
  cannot be observed. When you genuinely need the user to act, raise it with
  `automation-chrome-focus` (the guard blocks CDP `Page.bringToFront`). Never
  raise it just to make a page render — background windows render fine.
- State a user reports seeing in their own browser (saved settings, lists kept
  in `localStorage`) is absent here, so reproduce it in this profile first.
- **Separate cookies do not mean separate accounts.** When this profile signs in
  as the user, anything that syncs UI state server-side (table columns,
  filters, sort, saved views) writes the user's real saved profile, and a
  "harmless" toggle made to verify a change persists for them everywhere.
  Verify by reading the DOM instead of changing settings. If a change is
  unavoidable, snapshot the stored settings first and restore them after.
- A site logged in on the main profile may not be logged in here. This
  includes login-gated localhost apps, which silently redirect to `/login`.
  Check `page.url()` right after navigating, before a long selector wait that
  can only time out.
  `automation-chrome-sync-cookies` copies sessions over, but avoid it for sites
  behind bot management.

## Driving pages through the MCP

These hold for any site driven through this browser:

- **Coordinates go stale.** The CSS viewport can change size between loads.
  Compute an element's centre from `getBoundingClientRect()` and confirm
  `el.contains(document.elementFromPoint(x, y))` immediately before `click_at`.
- **`scrollIntoView` can scroll the whole document** in app layouts with a
  fixed toolbar and side panel, which pushes controls to a negative `y`. Use
  `el.focus({ preventScroll: true })` for inputs instead.
- **`Meta+A` does not select text inside inputs** when sent with `press_key`.
  Use `el.focus(); el.select()` in `evaluate_script`, then `press_key`
  `Backspace` or `type_text`.
- **Setting `.value` from script is not typing.** Framework-bound inputs (Vue,
  React) can show the new value and still   save the old one. Use real
  keystrokes for anything that must persist. Plain server-rendered forms
  (e.g. WordPress admin textareas without CodeMirror, saved by a normal form
  POST) are the exception: `.value` plus clicking submit persists. Confirm by
  re-reading the field after the post-save reload.
- **`evaluate_script` has no `timeout` argument** and long in-page loops time
  out. Split them into batches.
- **Scripting a cross-origin iframe:** `take_snapshot` includes the iframe's
  accessibility tree. Pass one of its element uids to `evaluate_script`
  (`args: [uid]`), and the function runs in that frame with full DOM and
  framework access.
- **Set viewport width with `emulate`, not `resize_page`.** `resize_page` has
  stopped taking effect mid-session. Use `emulate` with
  `viewport: "<width>x<height>x<dpr>"`. The override stays on that page, and
  CSS-driven layout updates without a reload. Reload when the site sets
  responsive classes from JS.
- **Under `emulate`, media queries match `innerWidth` (which includes the
  scrollbar), and `clientWidth` is about 15 px narrower.** A breakpoint found by
  bisecting emulated widths can be off by the scrollbar width compared with a
  real browser. Read the authored value from the site's CSS and reuse it.
- **A bug that only shows on the remote site is often a load-order race.** Local
  requests finish in a different order than they do over the network.
  Reproduce it locally with `navigate_page`'s `initScript`: wrap
  `window.fetch`, delay the one request by a few seconds, and seed any cache
  it compares against before returning the response. Then run the old build
  and the fixed build under the same script. This proves the cause instead of
  guessing at it.
- **Full-page screenshots are useless on sites with scroll-triggered
  enter/exit animations.** Sections outside the viewport are still in their
  hidden state, so the capture comes out mostly blank. For visual QA, scroll one
  viewport at a time over CDP, wait about 1.3 s, and capture each step. To review
  many shots at once, write an HTML grid of `file://` images, open it in a
  fresh tab, and take a single `captureBeyondViewport` screenshot. Python PIL
  isn't installed, and `sips` only crops.
- **"What size should a replacement image be?" on a live Razz site:** open the
  page, `emulate` 1512x900x2 / 1920x1080x1 / 390x844x3 (mobile,touch), and read
  `getBoundingClientRect()` of the `img` plus `naturalWidth/Height` and
  `currentSrc`. The images use `object-fit: cover; height: 100%`, so the box
  ratio changes with the viewport and with sibling-column content height;
  recommend a size from the largest box (CSS px x2 for retina) and tell the
  client the focal point must survive cropping. Close your tab afterwards.
- **`select_page` takes a numeric `pageId`**, not a string.
- **A tab opened with `PUT /json/new` opens as a background window** (the guard
  forces `background: true, newWindow: true`). The anti-backgrounding Chrome
  flags keep it painting, so its child iframes load and appear in `/json/list`
  without raising it. If an iframe target is slow to appear, poll `/json/list`;
  do not reach for `Page.bringToFront` (the guard blocks it anyway).
- **Per-device visibility needs a real phone emulation.** A desktop UA at
  390 px does not prove a "hide on mobile" setting works or fails. Retest with
  `Emulation.setUserAgentOverride` (iPhone UA), `setTouchEmulationEnabled`, and
  `setDeviceMetricsOverride` with `mobile: true` before drawing a conclusion.
- **Setting an HttpOnly cookie** (for example a locally minted session for a
  login-gated localhost app): `document.cookie` can't do it. Run a Node script
  with `chromium.connectOverCDP('http://127.0.0.1:9333')`, call
  `contexts()[0].addCookies([...])`, then `process.exit(0)` without
  `browser.close()`. That keeps the token out of the transcript and works on
  the live profile.
- **Getting multi-MB page data (a captured request body, app state) into Node
  code:** don't return it from `evaluate_script`. Stash it on `window` from an
  MCP script, then read it in a Node script with `connectOverCDP` and
  `page.evaluate(() => window.__x)`. Run that script from inside the project
  (e.g. `web/scripts/`), not `/tmp`, or `playwright` and the app's modules won't
  resolve.
- **To automate a site far more cheaply than clicking its UI, call its private
  JSON API in-page.** Map it first (devtools network capture + REA), then run the
  real request *inside the signed-in page* with
  `page.evaluate(() => fetch(url, { credentials: 'include', headers: {...} }))`.
  The HttpOnly session cookies ride along automatically — no token extraction, no
  re-auth. Supply only the non-cookie secrets a write needs (a CSRF/anti-forgery
  token is almost always a JS-readable `window.*` global, e.g.
  `window.OfficeFormServerInfo.antiForgeryToken`; read it *fresh per call*, as it
  can rotate). Use `location.origin` as the base so same-origin cookie scoping
  holds. This collapsed a MS Forms copy from dozens of DOM actions + 60s polling
  to ~5 API calls in ~2.5s.
- **To measure one operation's real API cost, don't trust a blanket
  `page.on('request')` count** filtered only by URL prefix: a live SPA fires its
  own background GETs on the shared page, inflating the number (37 "formapi" GETs
  where the operation made 3). The clean signal is the operation's distinctive
  verbs/endpoints (a `POST`/`PATCH` to a specific path), not raw GET totals.
  `connectOverCDP` + `browser.close()` just *detaches* — it never kills the
  managed Chrome — so it is safe to count against the live session and clean up.
- **A site behind SSO or a passkey/MFA wall needs a human hand-off.** When a
  login can only be completed by the person (SSO password, an MFA code, a
  passkey enrollment the automation account can't do), raise the window with
  `automation-chrome-focus <url-substring>` and ask them to finish; do not fall
  back to an API-only check without asking. Read-only REST cross-checks are fine
  once signed in.
- **Verifying a client-side file download** (Blob + `<a download>`): CDP downloads are awkward. With Playwright `connectOverCDP`, `addInitScript` to wrap `URL.createObjectURL` (stash each Blob on `window`) and stub `HTMLAnchorElement.prototype.click` (record `this.download`), then read `await window.__blobs.at(-1).text()`. Run the script from `web/` so `playwright` resolves.
- **A reload that triggers `beforeunload` discarded unsaved work.** Treat it as
  a failed save, not a success.
- **A "Leave site?" prompt raised by a raw CDP `Page.navigate` can freeze the
  tab.** The native dialog blocks the renderer, and every later call to that
  tab times out, including the MCP's `handle_dialog`. `Page.handleJavaScriptDialog`
  answers "No dialog is showing". Recover with `/json/close/<id>`, which skips
  `beforeunload`. When a job visits many pages in an app that sets
  `beforeunload`, use a fresh tab per page and close it that way.
- **Measurements right after a viewport change or reload can read 0.** Lazy
  widgets (maps, carousels) re-render after `Emulation.setDeviceMetricsOverride`
  or a background-tab load. Wait for a non-zero size,   or measure in a later
  call, before reporting a size. Always cross-check with a screenshot.
  A device-metrics override lasts only as long as the CDP connection that
  set it. A screenshot taken right after opening a new connection can show
  the layout from before the resize, even when measurements agree. Set the
  override, wait about 1.5 s, measure, and capture in one connection.
- **Full-page screenshots miss scroll-reveal content.** `captureBeyondViewport`
  (and `fullPage: true`) never scrolls the page, so sections that fade in on
  scroll show up blank below the fold. For a visual QA, step `scrollTo` one
  viewport at a time, wait about 1 s, capture the viewport, and tile the frames
  into a contact sheet (for example `ffmpeg -pattern_type glob -i '*.jpg' -vf tile=5xN`).
- **Synthesized input lands at the window's scale when the emulated viewport is
  taller than the real window.** Chrome shrinks the page to fit, and CDP
  `Input.synthesizeTapGesture` / `synthesizeScrollGesture` coordinates arrive at
  that scale (440×956 in a short window: a tap at (400,800) hit (360,720), 0.9×).
  `devicePixelRatio` stays unchanged, so it isn't page zoom. This shows up as
  "tabs don't switch", Playwright clicks "intercepted" by a neighbor, or swipes
  missing a strip that works on a real phone. Calibrate each session: after
  enabling emulation, tap a blank page at a known point, read the
  `pointerdown` `clientX/Y`, and divide every gesture coordinate by the measured
  ratio. The ratio varies with the window size (1.0 in another run).
- **Touch swipes need `Input.synthesizeScrollGesture`.** Raw
  `Input.dispatchTouchEvent` drags fire DOM touch events but don't scroll the
  compositor, so an overflow container never moves.
- **Styles read right after injecting CSS can be stale.** If the element has a
  `transition`, `getComputedStyle` returns the starting value. Wait longer than the
  transition before comparing.
- **Hover measurement:** `CSS.forcePseudoState` applies `:hover` rules but
  fires no mouse events, so JS-driven hover effects stay invisible. Use
  `Input.dispatchMouseEvent` `mouseMoved` on a point that `elementFromPoint`
  confirms is the target.
- **`Page.captureScreenshot` with a `clip`** uses document coordinates (add
  `scrollY`). It no longer comes back blank for a background window: each page
  opens in its own window (not a background *tab*) and the anti-backgrounding
  flags keep it painting, so capture it where it is. `Page.bringToFront` is
  blocked by the guard and would not help anyway.
- **Bulk visual survey of many sites (compare templates, audit lookalikes):** a
  Node script run from inside the repo using
  `chromium.connectOverCDP('http://127.0.0.1:9333')` and
  `ctx.newPage()` per site beats MCP clicking. Import playwright-core by its
  absolute `node_modules/.pnpm/playwright-core@*/node_modules/playwright-core/index.mjs`
  path (pnpm doesn't hoist it, so a bare import fails with ERR_MODULE_NOT_FOUND).
  Per site: `setViewportSize` 1440x900, scroll 800 px steps with ~1.1 s waits,
  save JPEGs, read nav links from `header,nav` and fonts/colors via
  `getComputedStyle`, then tile with
  `ffmpeg -start_number 0 -i "<site>-home-%d.jpg" -vf "scale=640:-1,tile=3x2" -frames:v 1 sheet.jpg`
  (`-pattern_type glob` with `[0-4]` fails) and view one sheet per site. About
  30 s per site; run 13 sites in one foreground call with a 10 min block.
  Delete the script afterward so it isn't committed.
- **Other agent sessions share this browser.** `pageId` routing keeps each session on its own tab; follow "Sharing the browser with other sessions" below.

For the MyRazz dashboard, also use the `razz-website-editor-automation` skill
and its `references/editor-behaviors.md`.

## Sharing the browser with other sessions (one tab per session)

Several chats and agents use this one Chrome, and `pageId` routing is on
(`--no-page-id-routing` was removed once chrome-devtools-mcp 1.12.0 proved
concurrent calls stay on their own pages). Every page tool therefore takes a
`pageId`. Follow this protocol:

1. **Open your own tab** with `new_page`, and note the `pageId` it returns
   (also visible in `list_pages`). Never reuse a tab you did not open.
2. **Pass that `pageId` on every call** (`navigate_page`, `evaluate_script`,
   `take_screenshot`, `click`, ...). `select_page` is not needed.
3. **Never** navigate, reload, resize, or close a tab you did not open, and never
   close tabs by URL substring. Close your own by `pageId` when done.
4. Keep the host guard (`location.host`) in scripts that edit data. It is cheap
   and catches a wrong id.
5. A page tool that fails with an unknown `pageId` means the tab was closed
   (by you, the user, or a "Leave site?" prompt). Open a new one; do not borrow
   another session's tab.

For raw CDP (a long-running Node script, `Page.navigate` that must skip a
`beforeunload` prompt), open a tab with `curl -s -X PUT "http://127.0.0.1:9333/json/new?<url>"`
and drive `ws://127.0.0.1:9333/devtools/page/<id>`; close it with `/json/close/<id>`.

## On Windows

The same stack runs on Windows 10/11 with the same ports (9333 guard, 9335
Chrome). Only the supervision and the commands differ. Installed by
`windows\install.ps1` in the automation-chrome repo. These notes are not yet
verified on a real Windows machine; correct them from experience.

- **No launchd.** A supervisor (`%USERPROFILE%\.local\bin\automation-chrome-supervise.ps1`)
  keeps Chrome and the guard alive. It is started at logon by the scheduled
  tasks `\AutomationChrome\Chrome` and `\AutomationChrome\FocusGuard`, or by
  `AutomationChrome-*.lnk` shortcuts in the Startup folder if tasks could not be
  created (`supervisor` in `%USERPROFILE%\.cursor\mcp-wrappers\automation-chrome.windows.json`).
- **Restart with `automation-chrome-reset`, never by running `chrome.exe`.** A
  hand-started Chrome isn't supervised; the supervisor just watches the port
  until it dies. As on macOS, a clean quit leaves Chrome down until reset.
- **Commands:** `automation-chrome-health`, `automation-chrome-reset`,
  `automation-chrome-focus [id|url]` (`.cmd` shims in `%USERPROFILE%\.local\bin`).
  Windows can refuse to let a background process take focus; then the taskbar
  button flashes and the user must click it.
- **Use `curl.exe`, not `curl`, in Windows PowerShell 5.1.** There `curl` is an
  alias for `Invoke-WebRequest` and rejects curl flags. Or use
  `Invoke-RestMethod -UseBasicParsing`.
- **Paths:** runtime and logs in `%USERPROFILE%\.cursor\mcp-wrappers`
  (`supervise-chrome.log`, `supervise-guard.log`, `focus-guard.err.log`); profile
  in `%LOCALAPPDATA%\Google\Chrome\CursorAutomation`.
- **Not available on Windows:** `stealth-cdp` and `automation-chrome-sync-cookies`.
- **Verify:** `powershell -ExecutionPolicy Bypass -File windows\verify.ps1` in the
  automation-chrome checkout.

## Session learning loop

At the end of every session that used this browser, before the final summary,
record what was learned. The user has authorized this for every session, so
don't ask first.

- Site-specific lessons (for example the MyRazz editor) go in that site's skill,
  following its own learning loop.
- Browser or MCP lessons that apply to any site go in "Driving pages through
  the MCP" above. Add only behavior verified this session, merge rather than
  duplicate, and keep each entry to a trap plus its fix.
- Tell the user in one sentence what was recorded, or that nothing new was
  learned.

## Helper processes die the same way

Anything started to run alongside the browser — CDP watchers, tunnels, pollers
— is killed with the shell that spawned it, for the same process-group reason.
Give it to launchd, or start it as a managed background job rather than with
`&` or `nohup`.

## Audit for drift, not version lag

"Check automation-chrome for updates" means all seven checks below, not a version
comparison. Every real breakage in this stack has come from something other than
a lagging version number. Report findings first, then apply low-risk fixes and
re-verify.

**1. Running vs installed.** Compare what is *serving* against what is *on disk*,
for both Chrome and the MCP.

```bash
defaults read "/Applications/Google Chrome.app/Contents/Info.plist" CFBundleShortVersionString
curl -s --max-time 5 http://127.0.0.1:9333/json/version | rg Browser   # via the guard
curl -s --max-time 5 http://127.0.0.1:9335/json/version | rg Browser   # Chrome direct
npm ls --prefix ~/.cursor/mcp-wrappers chrome-devtools-mcp --depth=0
npm view chrome-devtools-mcp version
```

Chrome auto-updates on disk underneath a running browser, and the launcher is
idempotent — it exits early when 9335 is listening — so it can never upgrade a
live instance. Only `launchctl kickstart -k` picks up a new build. Health checks
stay green through the entire skew.

If nothing answers on 9335 at all, check `last exit code` in
`launchctl print gui/$(id -u)/com.local.automation-chrome` before assuming a
crash. A clean quit (exit 0 — usually the user closing the window) is *designed*
to stay down, because the plist sets `KeepAlive.SuccessfulExit=false`. Kickstart
it and move on; nothing is wrong.

**1b. The focus guard is up and really proxying.** `9333` is the guard, not
Chrome. Confirm both the proxy and the chain behind it:

```bash
curl -s --max-time 5 http://127.0.0.1:9333/focus-guard/health   # {"ok":true,...}
launchctl print gui/$(id -u)/com.local.automation-chrome-focus-guard | rg -i 'state|pid'
```

If `/focus-guard/health` is silent but something is on 9333, a stale raw Chrome
may be bound there instead of the guard — the symptom is focus-stealing returning.

The opposite case: health is green, but `launchctl print` shows the guard job
with `state = spawn scheduled`, no `pid`, a high `runs` count, and
`last exit code = 1` (the err log ends in `EADDRINUSE ... port: 9333`). An
orphaned guard (`ps -o ppid` = 1, left behind by an earlier bootout/reload) holds
the port, and launchd's copy crash-loops every 10 s. Everything appears to work.
Fix: confirm the pid from `lsof -nP -iTCP:9333 -sTCP:LISTEN` differs from the
job's pid, `kill` it, and KeepAlive respawns the managed copy within seconds.
After any guard reload, check that the job pid and the port owner match.
The guard's `webSocketDebuggerUrl` from `/json/version` must report `:9333`
(rewritten), proving responses are being proxied, not served by Chrome directly.

**2. Flags the config passes.** Confirm every arg in `~/.cursor/mcp.json` still
exists in the target version and was not renamed. Check both spellings before
concluding one is gone: options are documented in camelCase
(`--allowUnrestrictedPaths`) while the config may use kebab-case
(`--allow-unrestricted-paths`). Yargs expands kebab-case automatically, so a
camelCase-only grep produces a false "removed flag".

**3. Flags the config omits.** This is where the only true breakage has come
from, so never skip it. Diff defaults between the pinned and target version.
1.8.0 renamed `--experimentalPageIdRouting` to `--pageIdRouting` *and flipped its
default to true*, which would have made `pageId` required on every page-scoped
tool without a single line of config changing. The stack used to pin the old implicit-selection behaviour with
`--no-page-id-routing`; it now runs with routing on so concurrent sessions can't
redirect each other. The interleaved test in `probe-mcp.mjs` proves it on every upgrade.

```bash
npx -y chrome-devtools-mcp@latest --help | rg -i 'category|experimental|memory|pageId|unrestricted'
```

**4. Read the changelog for behaviour changes, not features.** Renames, flipped
defaults, and newly required arguments matter; new heap-snapshot tools do not.

**5. Prove the chain works.** Boot the wrapper with the exact args from
`mcp.json`, then make one real MCP tool call.

```bash
# hold stdin open — stdio servers exit on EOF, which looks like a rejected flag
(sleep 18 | node ~/.cursor/mcp-wrappers/chrome-devtools-mcp-filtered.mjs \
   <exact args from mcp.json> > /tmp/cdm-probe.out 2>&1) &
sleep 9
pgrep -f chrome-devtools-mcp-filtered >/dev/null && echo "alive"
rg -i 'unknown|unrecognized|error' /tmp/cdm-probe.out
```

A green health check is not proof of the chain. Chrome healthy on 9333 has
coexisted with a real MCP call failing `Not connected`.

**5b. Config and script files are not empty.** On Oct 14 a single event
truncated `~/.cursor/mcp.json`, `mcp-wrappers/chrome-devtools-mcp-filtered.mjs`,
`mcp-wrappers/README.md` and `~/.cursor/rules/ask-user-for-help.mdc` to 0-1
bytes. The browser kept running, so health checks stayed green while the MCP
silently vanished from the tool list and a wrapper probe printed only
`SERVER DID NOT INITIALIZE` with empty stderr. Start every audit with
`find ~/.cursor ~/.local/bin -maxdepth 2 -type f -size -2c -not -path '*/node_modules/*'`.
Recover from Cursor local history
(`~/Library/Application Support/Cursor/User/History/*/entries.json`, match the
`resource` field, take the newest entry over 10 bytes), or from the bundle repo
`~/Development/automation-chrome`, which has the wrapper and probe but is older
than the live setup (no `focus-guard.mjs`). Run `probe-mcp.mjs` after restoring.

**6. Docs and comments.** Flag claims in `~/.local/bin/automation-chrome*` and
`~/.cursor/mcp-wrappers/README.md` that no longer match behaviour — stale port
numbers and version pins have both drifted here before.

### Two traps when reporting

- `automation-chrome-health` lists MCP pids from a `pgrep -f chrome-devtools-mcp`
  that can match its own subshell. Confirm each pid with `ps` before reporting
  stale or duplicate servers.
- Upgrading the package never touches the server already in memory, and the
  wrapper resolves only `~/.cursor/mcp-wrappers/node_modules` (its `createRequire`
  cannot see `npm i -g`). Install locally, then tell the user to reload the
  Cursor window — that last step cannot be done for them.

### State as of chrome-devtools-mcp 1.11.0 (verified 2026-10-15)

All flags in `mcp.json` still parse, `--no-page-id-routing` is still honoured (no longer passed),
and the probe exposes 55 tools. Two deprecations to act on eventually:
`--allowUnrestrictedPaths` (use `--workspace=/`) and `--experimentalScreencast`
plus `--experimentalFfmpegPath` (a built-in ffmpeg-free screencast now ships
by default). Both still work, so they were left alone.
When testing the wrapper from zsh, pass flags as an array (`A=(--flag value)`;
`$A`). An unquoted string variable is not word-split and yields a misleading
`Unknown arguments` error.

## Deeper troubleshooting

`~/.cursor/mcp-wrappers/README.md` covers port collisions, wedged MCP
processes, bot detection, log locations, and `automation-chrome-reset`.
A developer-facing overview (architecture, ports, known gaps) lives in the
Razz-Auditor repo at `docs/automation-chrome.md`; update it when the
architecture, ports, or pinned versions change.
