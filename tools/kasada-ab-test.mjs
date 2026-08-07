#!/usr/bin/env node
/**
 * Kasada / CDP isolation harness.
 *
 * Launches a throwaway Chrome, loads GoDaddy SSO, types a username with real
 * `Input.dispatchKeyEvent` events, blurs the field to fire the Kasada-protected
 * `POST /v1/api/idp/user/checkusername`, then reports that call's HTTP status.
 *
 *   429 -> Kasada rejected the client
 *   200 -> Kasada accepted the client
 *
 * One variant per invocation so each run gets a pristine process and profile.
 *
 * Usage:
 *   node kasada-ab-test.mjs --username=you@example.com --variant=clean
 *   node kasada-ab-test.mjs --username=you@example.com --variant=runtime
 *   node kasada-ab-test.mjs --username=you@example.com --variant=clean --flags=vanilla
 *
 *   --username=  required; the value typed into the login field
 *   --variant=   clean | noisy | runtime | network | log | dom | evaluate
 *                clean   nothing but Page enabled (stealthy)
 *                noisy   Runtime + Network + Log (what puppeteer does)
 *                others  one domain at a time, to isolate the trigger
 *   --flags=     automation (mirrors the real automation Chrome) | vanilla
 *   --url=       page under test; defaults to GoDaddy SSO
 *   --port=      CDP port for the throwaway browser
 *
 * The result probe is shaped for GoDaddy SSO — it looks for
 * `input[name=username]`, `#browser-error-modal` and the `checkusername` XHR.
 * Point --url elsewhere and you will need to adjust those selectors too.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const VARIANT = flag('variant', 'clean');
const FLAG_SET = flag('flags', 'automation');
const PORT = Number(flag('port', String(9440 + Math.floor(Math.random() * 40))));
const USERNAME = flag('username');
if (!USERNAME) {
  console.error('kasada-ab-test: --username=<value> is required (typed into the login field)');
  process.exit(2);
}
const URL_UNDER_TEST = flag(
  'url',
  'https://sso.godaddy.com/?realm=idp&app=venture-redirector&path=%2F%3Freferrer%3Dsso',
);
const OUT_DIR = path.join(
  process.env.AUTOMATION_CHROME_HOME || path.join(os.homedir(), '.automation-chrome'),
  'kasada-ab',
);

const AUTOMATION_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-features=ChromeWhatsNewUI,OptimizationGuideModelDownloading',
  // Kept identical to bin/automation-chrome so the harness measures the real
  // automation browser rather than an approximation of it.
  '--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport',
  '--hide-crash-restore-bubble',
  '--disable-session-crashed-bubble',
  '--disable-infobars',
  '--disable-background-networking',
];
const VANILLA_FLAGS = ['--no-first-run', '--no-default-browser-check'];

fs.mkdirSync(OUT_DIR, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasada-ab-'));

const chrome = spawn(
  CHROME_BIN,
  [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    ...(FLAG_SET === 'vanilla' ? VANILLA_FLAGS : AUTOMATION_FLAGS),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('Chrome never exposed a CDP endpoint');
}

let id = 0;
const pending = new Map();
let ws;
const send = (method, params = {}, sessionId) => {
  const mid = ++id;
  const payload = { id: mid, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(mid)) reject(new Error(`${method} timed out`));
    }, 30000);
  });
};

async function typeText(sessionId, text) {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sessionId);
    await sleep(30 + Math.random() * 60);
  }
}

try {
  const wsUrl = await browserWsUrl();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Page.enable', {}, sessionId);
  const DOMAINS = {
    clean: [],
    noisy: ['Runtime', 'Network', 'Log'],
    runtime: ['Runtime'],
    network: ['Network'],
    log: ['Log'],
    dom: ['DOM'],
    // No domains enabled, but Runtime.evaluate is polled throughout the page
    // lifetime. `Runtime.evaluate` is a one-shot command and, unlike
    // `Runtime.enable`, does not switch the renderer into "a debugger is
    // watching" mode -- this variant proves whether that distinction holds.
    evaluate: [],
  }[VARIANT];
  if (!DOMAINS) throw new Error(`unknown variant: ${VARIANT}`);
  for (const domain of DOMAINS) {
    await send(`${domain}.enable`, {}, sessionId);
  }

  const pollEval = VARIANT === 'evaluate';
  const settle = async (ms) => {
    if (!pollEval) return sleep(ms);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await sleep(1000);
      await send(
        'Runtime.evaluate',
        { expression: 'document.readyState + ":" + document.title', returnByValue: true },
        sessionId,
      ).catch(() => {});
    }
  };

  await send('Page.navigate', { url: URL_UNDER_TEST }, sessionId);
  await settle(9000);

  // The username field is autofocused by GoDaddy, so real key events land
  // without needing DOM coordinates (which would mean enabling more domains).
  await typeText(sessionId, USERNAME);
  await sleep(400);
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    sessionId,
  );
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    sessionId,
  );
  await settle(6000);

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const shotPath = path.join(OUT_DIR, `${FLAG_SET}-${VARIANT}.png`);
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

  const probe = await send(
    'Runtime.evaluate',
    {
      expression: `JSON.stringify({
        typedValue: (document.querySelector('input[name=username]') || {}).value || null,
        blocked: !!document.querySelector('#browser-error-modal'),
        calls: performance.getEntriesByType('resource')
          .filter(e => /checkusername|\\/fp\\?|\\/tl$/.test(e.name))
          .map(e => ({ u: e.name.replace('https://sso.godaddy.com','').slice(0,60), s: e.responseStatus }))
      })`,
      returnByValue: true,
    },
    sessionId,
  );

  const result = JSON.parse(probe.result.value);
  const check = result.calls.find((c) => c.u.includes('checkusername'));

  console.log(`\n=== variant=${VARIANT} flags=${FLAG_SET} ===`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`\ncheckusername status: ${check ? check.s : 'NOT FIRED'}`);
  console.log(`blocked modal:        ${result.blocked}`);
  console.log(`screenshot:           ${shotPath}`);
  ws.close();
} finally {
  chrome.kill();
  await sleep(1500);
  fs.rmSync(profileDir, { recursive: true, force: true });
}
