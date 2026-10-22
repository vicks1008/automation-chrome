#!/usr/bin/env node
// Write the resolved MCP flag set and register the chrome-devtools server in
// Cursor's mcp.json, preserving any other servers. Used by windows/install.ps1.
//
// Usage: node register-mcp.mjs <runtimeDir> <mcpJsonPath|-> -- <wrapper> <flags...>
//   Pass "-" as mcpJsonPath to skip Cursor registration.

import fs from 'node:fs';
import path from 'node:path';

const [runtimeDir, mcpJsonPath, sep, ...args] = process.argv.slice(2);
if (!runtimeDir || !mcpJsonPath || sep !== '--' || args.length === 0) {
  console.error('usage: node register-mcp.mjs <runtimeDir> <mcpJsonPath|-> -- <wrapper> <flags...>');
  process.exit(2);
}

fs.writeFileSync(path.join(runtimeDir, 'mcp-args.json'), `${JSON.stringify(args, null, 2)}\n`);
console.log(`    wrote ${path.join(runtimeDir, 'mcp-args.json')}`);

if (mcpJsonPath !== '-') {
  let config = {};
  if (fs.existsSync(mcpJsonPath)) {
    fs.copyFileSync(mcpJsonPath, `${mcpJsonPath}.bak`);
    try {
      config = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    } catch {
      console.error('    existing mcp.json is not valid JSON; backed up to .bak, starting fresh');
    }
  }
  fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true });
  config.mcpServers = config.mcpServers || {};
  config.mcpServers['chrome-devtools'] = {
    command: 'node',
    args,
    env: { CDM_PATCH_LOG: '1', CDM_EXCLUDE_URL_PATTERNS: 'godaddy.com' },
  };
  fs.writeFileSync(mcpJsonPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`    wrote ${mcpJsonPath} (other servers preserved)`);
}
