#!/usr/bin/env node
/**
 * chrome-devtools-mcp wrapper for Cursor / Claude Code.
 *
 * Adds target filtering via env vars so --autoConnect doesn't hang when
 * the user's Chrome has many suspended tabs (see upstream issues #775, #1156).
 *
 * Env vars:
 *   CDM_INCLUDE_URL_PATTERNS  comma-separated URL substrings; if set, ONLY
 *                             targets whose URL contains one of these are
 *                             attached (Puppeteer's Network.enable is never
 *                             called on other tabs).
 *   CDM_EXCLUDE_URL_PATTERNS  comma-separated URL substrings to always skip.
 *   CDM_PATCH_LOG             set to 1 to log filter decisions to stderr.
 *
 * This wrapper:
 *   1. Dynamically resolves the real chrome-devtools-mcp package.
 *   2. Monkey-patches `puppeteer.connect` to wrap the user-supplied
 *      `targetFilter` with our pattern-based filter.
 *   3. Delegates to the MCP's real CLI entrypoint.
 *
 * Install chrome-devtools-mcp LOCALLY in this folder so `createRequire` can
 * resolve it deterministically (a global `npm i -g` is NOT visible here):
 *     cd ~/.automation-chrome && npm install chrome-devtools-mcp@latest
 * (Falls back to a `npx`-cached copy if no local/global install is found.)
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const req = createRequire(import.meta.url);

function log(...args) {
  if (process.env.CDM_PATCH_LOG) {
    console.error('[cdm-wrapper]', ...args);
  }
}

function parsePatterns(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function findMcpPackageRoot() {
  // 1. Try normal require resolution (works if installed globally or locally).
  try {
    return path.dirname(req.resolve('chrome-devtools-mcp/package.json'));
  } catch {
    // fall through
  }

  // 2. Fall back to scanning the npx cache.
  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  if (!fs.existsSync(npxRoot)) {
    throw new Error(
      'chrome-devtools-mcp not installed. Run `npm i -g chrome-devtools-mcp@latest` or `npx chrome-devtools-mcp@latest` once.',
    );
  }
  const candidates = [];
  for (const entry of fs.readdirSync(npxRoot)) {
    const pkgJson = path.join(npxRoot, entry, 'node_modules', 'chrome-devtools-mcp', 'package.json');
    if (fs.existsSync(pkgJson)) {
      candidates.push({
        dir: path.dirname(pkgJson),
        mtime: fs.statSync(pkgJson).mtimeMs,
      });
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      'chrome-devtools-mcp not found in ~/.npm/_npx. Run `npx chrome-devtools-mcp@latest --help` once to seed the cache.',
    );
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].dir;
}

const mcpPkgRoot = findMcpPackageRoot();
log('resolved chrome-devtools-mcp at', mcpPkgRoot);

const thirdPartyUrl = pathToFileURL(
  path.join(mcpPkgRoot, 'build/src/third_party/index.js'),
).href;
const thirdParty = await import(thirdPartyUrl);

const includePatterns = parsePatterns(process.env.CDM_INCLUDE_URL_PATTERNS);
const excludePatterns = parsePatterns(process.env.CDM_EXCLUDE_URL_PATTERNS);

if (includePatterns.length > 0 || excludePatterns.length > 0) {
  log('patterns', { includePatterns, excludePatterns });

  const puppeteer = thirdParty.puppeteer;
  const originalConnect = puppeteer.connect.bind(puppeteer);

  puppeteer.connect = async function patchedConnect(options = {}) {
    const userFilter = options.targetFilter;
    options.targetFilter = function combinedTargetFilter(target) {
      let url;
      try {
        url = target.url();
      } catch (err) {
        log('target.url() threw', err);
        return false;
      }

      if (userFilter && !userFilter(target)) {
        log('filtered by upstream filter', url);
        return false;
      }

      if (excludePatterns.some((p) => url.includes(p))) {
        log('EXCLUDE', url);
        return false;
      }

      if (includePatterns.length > 0) {
        const match = includePatterns.some((p) => url.includes(p));
        log(match ? 'INCLUDE' : 'skip-not-in-include', url);
        return match;
      }

      return true;
    };

    log('puppeteer.connect invoked; filtered targetFilter installed');
    return originalConnect(options);
  };
} else {
  log('no CDM_*_URL_PATTERNS set; running unmodified');
}

// Hand off to the real MCP CLI. It reads process.argv directly, which still
// contains our own script path as argv[1] — the MCP uses yargs' hideBin()
// which strips the first two entries, so positional alignment is preserved
// as long as we don't inject extra args.
const mcpEntry = pathToFileURL(
  path.join(mcpPkgRoot, 'build/src/bin/chrome-devtools-mcp.js'),
).href;

log('starting MCP entrypoint', mcpEntry);
await import(mcpEntry);
