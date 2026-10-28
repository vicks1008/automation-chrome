#!/usr/bin/env node
/**
 * Boot chrome-devtools-mcp with a candidate flag set and report the resulting
 * tool surface. A rejected flag makes the server exit at launch, so this is the
 * cheapest way to validate ~/.cursor/mcp.json before reloading Cursor.
 *
 * Usage: node probe-mcp.mjs -- <flags...>
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const flags = process.argv.slice(2);
const child = spawn('node', ['./chrome-devtools-mcp-filtered.mjs', ...flags], {
  // fileURLToPath, not URL.pathname: on Windows the pathname is "/C:/..." which
  // is not a valid working directory.
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));

let buffer = '';
const seen = new Map();
child.stdout.on('data', (d) => {
  buffer += d.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id) seen.set(msg.id, msg);
    } catch {
      /* non-JSON banner line */
    }
  }
});

const write = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

write({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'probe', version: '1.0.0' },
  },
});
await sleep(4000);
write({ jsonrpc: '2.0', method: 'notifications/initialized' });

// The browser connection is lazy: flag-gated tools only register once the MCP
// has actually attached, so call a browser tool before listing.
write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_pages', arguments: {} } });
await sleep(8000);
write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
await sleep(4000);

const init = seen.get(1);
const list = seen.get(2);

// Concurrency check: with pageId routing on, two sessions that each own a tab
// must never see the other's page. Open two tabs, then call evaluate_script on
// them in interleaved order and require each to report its own hash.
const toolList = list?.result?.tools ?? [];
const evalTool = toolList.find((t) => t.name === 'evaluate_script');
const routingOn = Boolean(evalTool?.inputSchema?.properties?.pageId);
let routingResult = routingOn ? 'on (concurrency test not run)' : 'off (all sessions share one selected page)';
let routingOk = true;
if (routingOn) {
  const textOf = (id) => seen.get(id)?.result?.content?.map((c) => c.text).join('\n') ?? '';
  const base = 'http://127.0.0.1:9333/json/version';
  const open = async (id, tag) => {
    write({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'new_page', arguments: { url: `${base}#${tag}` } } });
    await sleep(3000);
  };
  await open(10, 'probe-a');
  await open(11, 'probe-b');
  const idFor = (id, tag) => {
    const m = new RegExp(`(\\d+): [^\\n]*#${tag}`).exec(textOf(id));
    return m ? Number(m[1]) : undefined;
  };
  // The second new_page lists both pages; page A's id is in that listing.
  const pageA = idFor(11, 'probe-a');
  const pageB = idFor(11, 'probe-b');
  if (pageA === undefined || pageB === undefined) {
    routingOk = false;
    routingResult = `on, but could not read page ids from new_page output:\n${textOf(11)}`;
  } else {
    const order = [pageA, pageB, pageA, pageB, pageB, pageA];
    let n = 20;
    const asked = [];
    for (const pageId of order) {
      const id = n++;
      asked.push({ id, pageId });
      write({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'evaluate_script', arguments: { pageId, function: '() => location.hash' } },
      });
      await sleep(1200);
    }
    const bad = asked.filter(({ id, pageId }) => !textOf(id).includes(pageId === pageA ? '#probe-a' : '#probe-b'));
    routingOk = bad.length === 0;
    routingResult = routingOk
      ? `on, ${asked.length} interleaved calls each hit their own page`
      : `on, but ${bad.length} of ${asked.length} calls hit the wrong page`;
    for (const pageId of [pageA, pageB]) {
      write({ jsonrpc: '2.0', id: 40 + pageId, method: 'tools/call', params: { name: 'close_page', arguments: { pageId } } });
    }
    await sleep(1500);
  }
}

if (!init) {
  console.log('SERVER DID NOT INITIALIZE');
  console.log(stderr.split('\n').slice(-25).join('\n'));
  child.kill();
process.exit(routingOk ? 0 : 1);
  process.exit(1);
}

console.log(`server: ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}`);
const pages = seen.get(3)?.result?.content?.[0]?.text ?? '(list_pages produced nothing)';
console.log(`--- list_pages ---\n${pages.trim()}\n---`);
const tools = list?.result?.tools ?? [];
console.log(`tools:  ${tools.length}`);
console.log(
  tools
    .map((t) => t.name)
    .sort()
    .join(', '),
);

console.log(`page-id routing: ${routingResult}`);

if (stderr.trim()) {
  console.log(`\n--- stderr ---\n${stderr.split('\n').slice(-20).join('\n')}`);
}

child.kill();
process.exit(routingOk ? 0 : 1);
