# Master prompt

Paste everything below the line into Claude Code on the new machine. Run it from
an empty directory; it will clone this repo itself.

---

You are setting up **automation-chrome** on this MacBook: a dedicated,
always-running Google Chrome that AI agents drive over the Chrome DevTools
Protocol, supervised by launchd and wired into both Claude Code and Cursor
through the `chrome-devtools` MCP server.

Everything you need is in this private repo:

    https://github.com/vicks1008/automation-chrome

It contains the launcher and health/reset scripts, the LaunchAgent, the MCP
wrapper with a pinned `chrome-devtools-mcp`, the `automation-chrome` skill, the
`stealth-cdp` driver and bot-detection tools, an idempotent `install.sh`, and a
`verify.sh` that proves the result actually works. The README explains why each
piece is shaped the way it is. Read it before you change anything.

## How to work

Act first, ask only when genuinely blocked. Run the commands, read the logs,
diagnose failures, fix them, and re-verify. Do not hand me a list of commands to
run myself.

Escalate only for things you literally cannot do: an admin password or `sudo`
prompt, an interactive keychain or MFA prompt, or a macOS GUI permission dialog
(Screen Recording, Accessibility, an "Allow" on a security prompt). When you do,
give me the exact command or click path in one code block, say in one sentence
why you can't do it yourself, and keep working on anything still unblocked.

## Phase 1 — install

1. Clone the repo to `~/Development/automation-chrome` (or `git pull` if it is
   already there).
2. Read `README.md` end to end.
3. Satisfy the prerequisites, installing whatever is missing: Google Chrome,
   Node 20+, ffmpeg, Xcode Command Line Tools. Use Homebrew. If Homebrew itself
   is not installed, or a formula needs an admin password, that is an escalation.
4. Run `./install.sh`. It is idempotent — re-run it rather than hand-editing
   anything it installed. Pass `--no-cursor` if Cursor is not on this machine
   and you don't want its config written.
5. Run `./verify.sh` and get every check green.

## Invariants — do not "improve" these

Each of these is the conclusion of a lot of wasted time. When something fails,
fix the failure without breaking them:

- **Start Chrome through launchd, never from a shell.** A shell-started Chrome
  prints `ready on port 9333`, passes an immediate health check, and then dies
  the moment the command returns — it was backgrounded inside the shell's
  process group, which gets torn down. `nohup` does not save it. Use
  `launchctl kickstart -k gui/$(id -u)/com.local.automation-chrome`. The same
  applies to any helper process you start alongside the browser.
- **The listening port is the only evidence.** Never conclude Chrome is up from
  a launch message or from a health check run in the same second. Confirm
  `http://127.0.0.1:9333/json/version` still answers several seconds later.
- **`chrome-devtools-mcp` stays pinned locally** in
  `~/.automation-chrome/node_modules`. The wrapper resolves it with
  `createRequire` from its own directory and cannot see a global `npm i -g`.
- **Port 9333, not 9222.** 9222 is commonly squatted by a main Chrome that
  answers slowly or not at all.
- **The MCP's browser connection is lazy.** Flag-gated tools only register after
  it has attached, so a `tools/list` issued right after `initialize`
  under-reports — 29 instead of 51. Force a browser call first; `probe-mcp.mjs`
  already does this.
- **A rejected MCP flag makes the server exit at launch.** If you change the
  flag set, re-verify the tool count.
- Do not point the MCP at my everyday Chrome profile, do not weaken the
  profile's isolation, and do not remove the launchd `KeepAlive` throttle.
- **The stealth browser stays a separate browser.** `stealth-cdp` exists because
  puppeteer's `Runtime.enable` is directly detectable by bot-management vendors,
  and a URL exclude filter alone is not airtight — a tab is briefly
  `about:blank` between creation and navigation, and puppeteer can attach in
  that window. Do not "simplify" it onto port 9333, and do not add
  `Runtime.enable` to it. It is on-demand and correctly needs no LaunchAgent:
  it spawns `detached`, which makes it a process-group leader via `setsid`,
  unlike the main launcher's `nohup`.

## Phase 2 — prove it actually works

`verify.sh` passing is necessary but not sufficient — it tests the stack from
the outside. The real test is a round trip through your own tools.

MCP servers are registered at session start, so you will not see
`chrome-devtools` until Claude Code restarts. Once `verify.sh` is green, tell me
to restart, and give me `/mcp` as the way to confirm the server connected.

In the new session, run this acceptance test and report the result:

1. `list_pages` — the automation Chrome's targets come back.
2. `navigate_page` to `https://example.com`.
3. `take_snapshot` — the snapshot contains "Example Domain".
4. `take_screenshot` — an image comes back.
5. Confirm the visible Chrome window's profile pill reads `CursorAutomation`.

If a step fails, diagnose with `automation-chrome-health`,
`automation-chrome-reset`, and the logs in `~/.automation-chrome/`, then fix and
re-run. Read the README's Troubleshooting section before guessing.

## Phase 3 — report

Briefly tell me:

- What was already present versus what you installed, with versions (Chrome,
  Node, `chrome-devtools-mcp`) and the final tool count.
- Anything you had to change to make it work on this machine, and whether that
  change belongs back in the repo. If it does, commit and push it.
- Anything still degraded — for example, screencast tools missing because
  ffmpeg isn't installed.

Do not tell me it is working until the Phase 2 acceptance test has actually
passed in a live session.
