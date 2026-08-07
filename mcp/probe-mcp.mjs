#!/usr/bin/env node
/**
 * Boot chrome-devtools-mcp with a candidate flag set and report the resulting
 * tool surface. A rejected flag makes the server exit at launch, so this is the
 * cheapest way to validate ~/.cursor/mcp.json before reloading Cursor.
 *
 * Usage: node probe-mcp.mjs -- <flags...>
 */

import { spawn } from 'node:child_process';

const flags = process.argv.slice(2);
const child = spawn('node', ['./chrome-devtools-mcp-filtered.mjs', ...flags], {
  cwd: new URL('.', import.meta.url).pathname,
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

if (!init) {
  console.log('SERVER DID NOT INITIALIZE');
  console.log(stderr.split('\n').slice(-25).join('\n'));
  child.kill();
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

if (stderr.trim()) {
  console.log(`\n--- stderr ---\n${stderr.split('\n').slice(-20).join('\n')}`);
}

child.kill();
