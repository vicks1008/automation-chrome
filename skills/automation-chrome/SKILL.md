---
name: automation-chrome
description: Start, verify, and troubleshoot the dedicated automation Chrome (CursorAutomation profile, port 9333) that the chrome-devtools MCP attaches to. Use when the user asks to use automation-chrome or Chrome automation, before driving chrome-devtools MCP tools, or when a browser tool call fails with "Could not connect to Chrome".
---

# Automation Chrome

The chrome-devtools MCP does not launch a browser. It attaches over CDP to an
already-running Chrome at `http://127.0.0.1:9333`, using the dedicated
`CursorAutomation` profile supervised by launchd.

## Start it with launchd, never from a shell

```bash
launchctl kickstart -k gui/$(id -u)/com.local.automation-chrome
```

Running `automation-chrome` directly looks like it works — it prints
`ready on port 9333` and an immediate health check passes — then Chrome dies
the moment the command returns. The launcher backgrounds Chrome inside the
agent shell's process group, which is torn down on completion. `nohup` does not
save it. launchd owns the process independently of any shell, so it survives.

If kickstart reports the service is not loaded:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.automation-chrome.plist
```

## Verify the port, not the launch message

```bash
automation-chrome-health
curl -s --max-time 5 http://127.0.0.1:9333/json/version
```

Confirm 9333 is still listening a few seconds later. A Chrome that already
exited leaves a successful-looking launch message and a stale health check
behind, so treat the port as the only real evidence.

`Could not connect to Chrome` from any MCP browser tool means nothing is on
9333. Start it, verify, then retry the tool call.

## It is a separate profile from the user's own Chrome

`CursorAutomation` keeps its own cookies and sessions. Two consequences:

- Anything the user is asked to do by hand must happen in **that** window or it
  cannot be observed. Focus it with CDP `Page.bringToFront` instead of asking
  the user to find it.
- A site logged in on the main profile may not be logged in here.
  `automation-chrome-sync-cookies` copies sessions over, but avoid it for sites
  behind bot management.

## Helper processes die the same way

Anything started to run alongside the browser — CDP watchers, tunnels, pollers
— is killed with the shell that spawned it, for the same process-group reason.
Give it to launchd, or start it as a managed background job rather than with
`&` or `nohup`.

## Screenshots are not a coordinate source

`take_screenshot` downscales. A page reporting `innerWidth === 1732` comes back
as a 1024px-wide image, so coordinates read off the image are short by ~40% and
`click_at` lands on the wrong element — or on nothing, which reads as a dead
button. Get coordinates from the DOM and confirm the hit before clicking:

```js
const el = [...document.querySelectorAll('button')].find(b => /Save/.test(b.innerText));
const r = el.getBoundingClientRect();
const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
return { x, y, hit: el.contains(document.elementFromPoint(x, y)) };
```

Screenshots are for seeing state, not for deriving input geometry.

## Deeper troubleshooting

`~/.automation-chrome/README.md` covers port collisions, wedged MCP processes,
bot detection, log locations, upgrading the MCP, and `automation-chrome-reset`.
