#!/usr/bin/env node
/**
 * focus-guard.mjs — a CDP proxy that stops the automation Chrome from stealing
 * macOS keyboard focus while an agent drives it.
 *
 * Problem: on macOS, Chrome activates its whole application (pulling focus away
 * from Cursor) whenever any CDP client sends a focus-stealing command:
 *   - `Target.createTarget` in the foreground  (Playwright newPage(),
 *     MCP new_page, PUT /json/new)
 *   - `Page.bringToFront` / `Target.activateTarget` / GET /json/activate
 * The skill used to *tell* agents to raise the window because background tabs
 * don't render (blank screenshots, unloaded iframes).
 *
 * Fix: Chrome listens on an internal port (9335). This proxy listens on the
 * public port (9333) that `~/.cursor/mcp.json` and every workflow already use,
 * and sits between every client and Chrome:
 *   - `Target.createTarget`  -> force { background:true, newWindow:true } so the
 *     page opens as its own *inactive window*. It renders fully (screenshots and
 *     lazy iframes work) without the app ever coming to the front.
 *   - `Page.bringToFront` / `Target.activateTarget` -> answered locally with an
 *     empty result and never forwarded, so callers see success and nothing moves.
 *   - everything else is passed through byte-for-byte.
 * HTTP endpoints are rewritten so advertised WebSocket URLs point back at 9333.
 *
 * A deliberate hand-off to the user (login, MFA) is still possible with
 * `automation-chrome-focus`, which talks straight to Chrome on 9335.
 *
 * Env vars:
 *   FOCUS_GUARD_LISTEN_PORT   public port to serve (default 9333)
 *   FOCUS_GUARD_CHROME_PORT   internal Chrome port to proxy to (default 9335)
 *   FOCUS_GUARD_LOG           set to 0 to silence per-decision logging
 */

import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require('ws');

const LISTEN_PORT = Number(process.env.FOCUS_GUARD_LISTEN_PORT || 9333);
const CHROME_PORT = Number(process.env.FOCUS_GUARD_CHROME_PORT || 9335);
const CHROME_HOST = '127.0.0.1';
const CHROME_HTTP = `http://${CHROME_HOST}:${CHROME_PORT}`;
const LOG_ON = process.env.FOCUS_GUARD_LOG !== '0';

// Commands that, if they reach Chrome, raise the window / steal focus.
const FOCUS_STEALING_METHODS = new Set([
  'Page.bringToFront',
  'Target.activateTarget',
]);

function log(...args) {
  if (LOG_ON) {
    console.error(`[focus-guard ${new Date().toISOString()}]`, ...args);
  }
}

/**
 * Rewrite Chrome's advertised host:port back to the public port so clients
 * keep talking to the proxy, not straight to Chrome. Targets both
 * `webSocketDebuggerUrl` (ws://127.0.0.1:9335/...) and `devtoolsFrontendUrl`
 * (...?ws=127.0.0.1:9335/...) without a blind global port swap.
 */
function rewriteHostPort(text) {
  return text
    .split(`127.0.0.1:${CHROME_PORT}`)
    .join(`127.0.0.1:${LISTEN_PORT}`)
    .split(`localhost:${CHROME_PORT}`)
    .join(`localhost:${LISTEN_PORT}`);
}

/**
 * Transform a client->Chrome CDP frame. Returns one of:
 *   { action: 'forward', data }       send `data` on to Chrome (possibly rewritten)
 *   { action: 'respond', data }       answer the client locally, don't forward
 *   { action: 'forward-raw' }         forward the original frame untouched
 */
function transformClientFrame(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { action: 'forward-raw' };
  }
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    return { action: 'forward-raw' };
  }

  if (FOCUS_STEALING_METHODS.has(msg.method)) {
    const response = { id: msg.id, result: {} };
    if (msg.sessionId !== undefined) {
      response.sessionId = msg.sessionId;
    }
    log('STRIP', msg.method, msg.sessionId ? `(session ${msg.sessionId})` : '');
    return { action: 'respond', data: JSON.stringify(response) };
  }

  if (msg.method === 'Target.createTarget') {
    msg.params = msg.params || {};
    const already = msg.params.background === true && msg.params.newWindow === true;
    msg.params.background = true;
    msg.params.newWindow = true;
    if (!already) {
      log('BG-WINDOW Target.createTarget', msg.params.url || '(no url)');
    }
    return { action: 'forward', data: JSON.stringify(msg) };
  }

  return { action: 'forward-raw' };
}

// --- WebSocket proxying -----------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

function proxyWebSocket(clientWs, chromeUrl) {
  const chromeWs = new WebSocket(chromeUrl, {
    perMessageDeflate: false,
    maxPayload: 512 * 1024 * 1024,
  });

  // Client frames that arrive before Chrome's socket is open are queued.
  const pending = [];
  let chromeOpen = false;

  function sendToChrome(data, isBinary) {
    if (chromeOpen) {
      chromeWs.send(data, { binary: isBinary });
    } else {
      pending.push([data, isBinary]);
    }
  }

  chromeWs.on('open', () => {
    chromeOpen = true;
    for (const [data, isBinary] of pending) {
      chromeWs.send(data, { binary: isBinary });
    }
    pending.length = 0;
  });

  chromeWs.on('message', (data, isBinary) => {
    // Chrome -> client is never altered.
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on('message', (data, isBinary) => {
    if (isBinary) {
      sendToChrome(data, true);
      return;
    }
    const raw = data.toString();
    const verdict = transformClientFrame(raw);
    switch (verdict.action) {
      case 'respond':
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(verdict.data);
        }
        return;
      case 'forward':
        sendToChrome(verdict.data, false);
        return;
      case 'forward-raw':
        sendToChrome(data, false);
        return;
      default: {
        const _exhaustive = verdict.action;
        throw new Error(`unhandled verdict: ${_exhaustive}`);
      }
    }
  });

  const closeBoth = (code, reason) => {
    try {
      if (chromeWs.readyState === WebSocket.OPEN || chromeWs.readyState === WebSocket.CONNECTING) {
        chromeWs.close();
      }
    } catch {}
    try {
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        clientWs.close(code, reason);
      }
    } catch {}
  };

  clientWs.on('close', () => closeBoth());
  chromeWs.on('close', () => closeBoth());
  clientWs.on('error', (err) => {
    log('client ws error', err.message);
    closeBoth();
  });
  chromeWs.on('error', (err) => {
    log('chrome ws error', err.message);
    closeBoth();
  });
}

// --- HTTP proxying ----------------------------------------------------------

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Create a target over a short-lived browser-level CDP connection, forcing a
 * background new window. Returns the matching /json entry (host rewritten),
 * mirroring what Chrome's own PUT /json/new returns.
 */
async function createBackgroundTarget(url) {
  const verRes = await fetch(`${CHROME_HTTP}/json/version`);
  const ver = await verRes.json();
  const browserWsUrl = ver.webSocketDebuggerUrl;

  const targetId = await new Promise((resolve, reject) => {
    const ws = new WebSocket(browserWsUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('timed out creating target'));
    }, 10000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Target.createTarget',
        params: { url: url || 'about:blank', background: true, newWindow: true },
      }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id === 1) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (msg.error) reject(new Error(msg.error.message || 'createTarget failed'));
        else resolve(msg.result.targetId);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  // Fetch the list and return the matching entry, so the response shape (and
  // webSocketDebuggerUrl / devtoolsFrontendUrl) is exactly what a client expects.
  const listRes = await fetch(`${CHROME_HTTP}/json`);
  const list = await listRes.json();
  const entry = list.find((t) => t.id === targetId) || {
    id: targetId,
    type: 'page',
    url: url || 'about:blank',
  };
  return JSON.parse(rewriteHostPort(JSON.stringify(entry)));
}

async function passThroughHttp(req, res) {
  const body = (req.method === 'GET' || req.method === 'HEAD')
    ? undefined
    : await readBody(req);
  const upstream = await fetch(`${CHROME_HTTP}${req.url}`, {
    method: req.method,
    headers: { host: `127.0.0.1:${CHROME_PORT}` },
    body,
  });
  const text = await upstream.text();
  const contentType = upstream.headers.get('content-type') || 'text/plain';
  res.writeHead(upstream.status, { 'content-type': contentType });
  res.end(rewriteHostPort(text));
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  try {
    // Local health probe for automation-chrome-health.
    if (url === '/focus-guard/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, listenPort: LISTEN_PORT, chromePort: CHROME_PORT }));
      return;
    }

    // Create tabs in a background window instead of foreground.
    if (url === '/json/new' || url.startsWith('/json/new?')) {
      const qIndex = url.indexOf('?');
      const target = qIndex >= 0 ? decodeURIComponent(url.slice(qIndex + 1)) : '';
      const entry = await createBackgroundTarget(target);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(entry));
      return;
    }

    // Never activate/raise the window; mimic Chrome's success text.
    if (url.startsWith('/json/activate/')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Target activated');
      return;
    }

    // /json, /json/list, /json/version, /json/close/<id>, /json/protocol, ...
    await passThroughHttp(req, res);
  } catch (err) {
    log('http error', url, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end(`focus-guard upstream error: ${err.message}`);
  }
});

server.on('upgrade', (req, socket, head) => {
  // Chrome serves WS at the same path (/devtools/page/<id>, /devtools/browser/<id>).
  const chromeUrl = `ws://${CHROME_HOST}:${CHROME_PORT}${req.url}`;
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    proxyWebSocket(clientWs, chromeUrl);
  });
});

server.on('clientError', (err, socket) => {
  log('client error', err.message);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(LISTEN_PORT, CHROME_HOST, () => {
  log(`listening on ${CHROME_HOST}:${LISTEN_PORT} -> Chrome ${CHROME_HTTP}`);
  log('stripping', [...FOCUS_STEALING_METHODS].join(', '), '+ foregrounding Target.createTarget');
});
