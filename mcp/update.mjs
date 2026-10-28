#!/usr/bin/env node
/**
 * Daily guarded updater for the automation Chrome stack (macOS and Windows).
 *
 * Runs from the bundle checkout (so pulling the bundle also updates this file).
 * Scheduled hourly by launchd / Task Scheduler; the first full pass of each day
 * does the work and later runs exit at once, unless something is still pending
 * (for example a Chrome restart waiting for agents to go idle).
 *
 * What it does, in order:
 *   1. Fast-forward pull the bundle and Razz-Auditor checkouts (skips dirty or
 *      diverged ones).
 *   2. Refresh the installed scripts when the bundle changed (install --update).
 *   3. Migrate flags in the chrome-devtools entry of mcp.json (never touches
 *      other servers).
 *   4. Upgrade chrome-devtools-mcp within the same major version, but only if
 *      its flags still parse and probe-mcp.mjs passes (two-tab pageId test).
 *      A failure rolls back and is remembered so it is not retried daily.
 *   5. Restart Chrome onto a newer on-disk build, only when no agent has sent a
 *      command for MIN_IDLE_SECONDS.
 *   6. Tell the user when shared skills/rules changed in the repos. Local copies
 *      are never overwritten (they hold lessons learned on this machine).
 *   7. Notify only when a person needs to act.
 *
 * Usage: node update.mjs [--dry-run] [--force] [--min-idle <seconds>]
 *   --dry-run  report what would change, change nothing
 *   --force    ignore the "already done today" stamp
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_IDLE_SECONDS = 15 * 60;
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

// Flag migrations applied to the chrome-devtools entry in mcp.json. Each entry
// removes an argument that is no longer wanted. Add to the end, never edit.
export const FLAG_MIGRATIONS = [
  // 2026-10: page-id routing keeps concurrent agent sessions on their own tabs.
  { remove: '--no-page-id-routing' },
];

// ------------------------------------------------------------ pure helpers

export function parseVersion(v) {
  return String(v ?? '')
    .replace(/^[^\d]*/, '')
    .split(/[.\-+]/)
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n));
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** 'current' | 'apply' (same major, newer) | 'major' (notify only) */
export function mcpUpgradeDecision(current, latest) {
  if (!parseVersion(current).length || !parseVersion(latest).length) return 'current';
  if (compareVersions(latest, current) <= 0) return 'current';
  return parseVersion(latest)[0] === parseVersion(current)[0] ? 'apply' : 'major';
}

/** `--allowUnrestrictedPaths=x` and `--allow-unrestricted-paths` both -> `allow-unrestricted-paths`. */
export function normalizeFlag(arg) {
  if (typeof arg !== 'string' || !arg.startsWith('--')) return null;
  return arg
    .slice(2)
    .split('=')[0]
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/** Flags in `args` that the `--help` text of a candidate version does not mention. */
export function missingFlags(helpText, args) {
  const help = String(helpText).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const missing = [];
  for (const arg of args) {
    const name = normalizeFlag(arg);
    if (!name) continue;
    const bare = name.replace(/^no-/, '');
    if (!help.includes(`--${name}`) && !help.includes(`--${bare}`) && !help.includes(`--no-${bare}`)) {
      missing.push(`--${name}`);
    }
  }
  return missing;
}

export function migrateMcpArgs(args, migrations = FLAG_MIGRATIONS) {
  let next = [...args];
  for (const m of migrations) {
    if (m.remove) next = next.filter((a) => a !== m.remove);
  }
  return { args: next, changed: next.length !== args.length };
}

/** 'unknown' | 'current' | 'restart' | 'wait' */
export function idleDecision({ running, installed, idleSeconds, minIdle = MIN_IDLE_SECONDS }) {
  if (!running || !installed) return 'unknown';
  if (compareVersions(installed, running) <= 0) return 'current';
  if (typeof idleSeconds !== 'number') return 'wait';
  return idleSeconds >= minIdle ? 'restart' : 'wait';
}

export function hashPath(p) {
  const h = crypto.createHash('sha1');
  const walk = (cur, rel) => {
    const st = fs.statSync(cur);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(cur).sort()) walk(path.join(cur, name), path.posix.join(rel, name));
    } else {
      h.update(rel);
      h.update('\0');
      h.update(fs.readFileSync(cur));
      h.update('\0');
    }
  };
  walk(p, '');
  return h.digest('hex');
}

/**
 * Shared skills/rules whose repo copy changed since we last looked AND differs
 * from the local copy. Pure: reads files, writes nothing. Entries whose local
 * copy is absent are skipped (not installed there). `lastSeen` is name -> hash.
 */
export function sharedChanges(entries, lastSeen) {
  const names = [];
  const seen = {};
  for (const e of entries) {
    if (!fs.existsSync(e.repoPath)) continue;
    const local = e.localPaths.find((p) => fs.existsSync(p));
    if (!local) continue;
    const repoHash = hashPath(e.repoPath);
    seen[e.name] = repoHash;
    if (lastSeen && lastSeen[e.name] !== repoHash && hashPath(local) !== repoHash) names.push(e.name);
  }
  return { names, seen };
}

export function defaultExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    timeout: opts.timeout ?? 120_000,
    shell: process.platform === 'win32' && ['npm', 'npx', 'pnpm'].includes(cmd),
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}`,
  };
}

/** Fast-forward a checkout. Never merges, never discards local work. */
export function pullRepo(dir, exec = defaultExec, { dryRun = false } = {}) {
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return { status: 'missing' };
  const git = (...args) => exec('git', args, { cwd: dir, timeout: 60_000 });
  const fetched = git('fetch', '--quiet');
  if (!fetched.ok) return { status: 'fetch-failed', detail: fetched.stderr.trim() };
  const counts = git('rev-list', '--left-right', '--count', 'HEAD...@{u}');
  if (!counts.ok) return { status: 'no-upstream' };
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  if (!behind) return { status: 'current' };
  const dirty = git('status', '--porcelain', '--untracked-files=no').stdout.trim();
  if (dirty) return { status: 'dirty', behind };
  if (ahead) return { status: 'diverged', ahead, behind };
  if (dryRun) return { status: 'would-pull', behind };
  const files = git('diff', '--name-only', 'HEAD', '@{u}').stdout.split('\n').filter(Boolean);
  const merged = git('merge', '--ff-only', '@{u}');
  if (!merged.ok) return { status: 'merge-failed', detail: merged.stderr.trim() };
  return { status: 'pulled', behind, files };
}

// ----------------------------------------------------------------- context

const isWin = process.platform === 'win32';

export function defaultContext(env = process.env) {
  const home = os.homedir();
  const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runtime = path.join(home, '.cursor', 'mcp-wrappers');
  const logFile = isWin
    ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'automation-chrome', 'update.log')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Logs', 'automation-chrome-update.log')
      : path.join(home, '.local', 'state', 'automation-chrome-update.log');
  return {
    home,
    bundleDir,
    razzDir: env.RAZZ_AUDITOR_DIR || path.join(home, 'Development', 'Razz-Auditor'),
    runtime,
    stateFile: path.join(runtime, 'update-state.json'),
    lockFile: path.join(runtime, 'update.lock'),
    logFile,
    mcpJson: path.join(home, '.cursor', 'mcp.json'),
    copilotMcp: path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'mcp-config.json'),
    chromeUrl: 'http://127.0.0.1:9335',
    guardUrl: 'http://127.0.0.1:9333',
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

export function notifyUser(message, exec = defaultExec) {
  const title = 'automation-chrome updater';
  if (process.platform === 'darwin') {
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    exec('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`]);
  } else if (isWin) {
    const esc = (s) => s.replace(/'/g, "''");
    const ps =
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;' +
      '$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;' +
      `$n.ShowBalloonTip(15000,'${esc(title)}','${esc(message)}',[System.Windows.Forms.ToolTipIcon]::Info);Start-Sleep -Seconds 16;$n.Dispose()`;
    exec('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { timeout: 30_000 });
  }
}

function chromeOnDiskVersion(exec) {
  if (process.platform === 'darwin') {
    const r = exec('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :CFBundleShortVersionString',
      '/Applications/Google Chrome.app/Contents/Info.plist',
    ]);
    return r.ok ? r.stdout.trim() : undefined;
  }
  if (isWin) {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      const exe = path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
      if (!fs.existsSync(exe)) continue;
      const r = exec('powershell.exe', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`]);
      if (r.ok && r.stdout.trim()) return r.stdout.trim();
    }
  }
  return undefined;
}

// --------------------------------------------------------------------- run

export async function run(options = {}, ctx = defaultContext(), exec = defaultExec) {
  const dryRun = Boolean(options.dryRun);
  const minIdle = options.minIdle ?? MIN_IDLE_SECONDS;
  const lines = [];
  const notes = [];
  let pending = false;
  let changedSomething = false;

  const log = (msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    lines.push(line);
    console.log(msg);
  };
  const flush = () => {
    try {
      fs.mkdirSync(path.dirname(ctx.logFile), { recursive: true });
      fs.appendFileSync(ctx.logFile, `${lines.join('\n')}\n`);
      // Keep the log small: one rotation at 1 MB.
      if (fs.statSync(ctx.logFile).size > 1_000_000) fs.renameSync(ctx.logFile, `${ctx.logFile}.1`);
    } catch {
      /* logging must never fail the run */
    }
  };

  const state = readJson(ctx.stateFile, {});
  if (!options.force && !dryRun && state.doneDate === today()) return { skipped: 'done-today', notes };

  // Lock so an hourly tick cannot overlap a long run.
  if (!dryRun) {
    try {
      fs.mkdirSync(ctx.runtime, { recursive: true });
      const age = fs.existsSync(ctx.lockFile) ? Date.now() - fs.statSync(ctx.lockFile).mtimeMs : 0;
      if (age > LOCK_STALE_MS) fs.rmSync(ctx.lockFile, { force: true });
      fs.closeSync(fs.openSync(ctx.lockFile, 'wx'));
    } catch {
      return { skipped: 'locked', notes };
    }
  }

  try {
    log(`update start${dryRun ? ' (dry run)' : ''}`);

    // 1. Repos.
    const pulls = {};
    for (const [name, dir] of [['bundle', ctx.bundleDir], ['razz-auditor', ctx.razzDir]]) {
      const r = pullRepo(dir, exec, { dryRun });
      pulls[name] = r;
      log(`repo ${name}: ${r.status}${r.behind ? ` (${r.behind} behind)` : ''}${r.detail ? ` ${r.detail}` : ''}`);
      if (r.status === 'fetch-failed') pending = true; // offline: try again next hour
      if (r.status === 'dirty') notes.push(`${name} has local changes, so it was not updated.`);
      if (r.status === 'diverged') notes.push(`${name} has unpushed commits and is behind; update it by hand.`);
    }
    if (pulls['razz-auditor'].status === 'pulled' && pulls['razz-auditor'].files.includes('pnpm-lock.yaml')) {
      const r = exec('pnpm', ['install', '--frozen-lockfile'], { cwd: ctx.razzDir, timeout: 300_000 });
      log(`pnpm install: ${r.ok ? 'ok' : `failed ${r.stderr.trim().slice(-200)}`}`);
    }

    // 2. Refresh installed scripts when the bundle moved.
    const head = exec('git', ['rev-parse', 'HEAD'], { cwd: ctx.bundleDir }).stdout.trim();
    const needRefresh = pulls.bundle.status === 'pulled' || (state.installedHead && state.installedHead !== head);
    // The authoring machine's live scripts differ from the packaged copies on
    // purpose (personal values, newer drafts). Never overwrite them from here.
    const authorMachine = fs.existsSync(path.join(ctx.runtime, 'razz-recorder'));
    if (needRefresh && authorMachine) {
      log('refresh installed scripts: skipped (authoring machine keeps its live copies)');
      state.installedHead = head;
    } else if (needRefresh && !dryRun) {
      const r = isWin
        ? exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.bundleDir, 'windows', 'install.ps1'), '-Update'], { timeout: 300_000, env: { AUTOMATION_CHROME_UPDATER: '1' } })
        : exec('bash', [path.join(ctx.bundleDir, 'install.sh'), '--update'], { timeout: 300_000, env: { AUTOMATION_CHROME_UPDATER: '1' } });
      log(`refresh installed scripts: ${r.ok ? 'ok' : `FAILED ${r.stderr.trim().slice(-300)}`}`);
      if (r.ok) {
        state.installedHead = head;
        changedSomething = true;
      } else {
        notes.push('Refreshing the installed scripts failed; see the update log.');
      }
    } else if (!state.installedHead && head) {
      state.installedHead = head;
    }

    // 3. mcp.json flag migrations (chrome-devtools entry only).
    for (const file of [ctx.mcpJson, ctx.copilotMcp]) {
      const cfg = readJson(file);
      const entry = cfg?.mcpServers?.['chrome-devtools'];
      if (!entry?.args) continue;
      const m = migrateMcpArgs(entry.args);
      if (!m.changed) continue;
      log(`${dryRun ? 'would migrate' : 'migrated'} flags in ${file}`);
      if (dryRun) continue;
      fs.copyFileSync(file, `${file}.bak`);
      entry.args = m.args;
      fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
      notes.push('MCP settings changed; reload Cursor (or VS Code) to pick them up.');
      changedSomething = true;
    }

    // verify.sh reads the resolved flag set from mcp-args.json; keep it in step.
    const argsFile = path.join(ctx.runtime, 'mcp-args.json');
    const resolved = readJson(argsFile);
    if (Array.isArray(resolved)) {
      const m = migrateMcpArgs(resolved);
      if (m.changed) {
        log(`${dryRun ? 'would migrate' : 'migrated'} flags in ${argsFile}`);
        if (!dryRun) fs.writeFileSync(argsFile, `${JSON.stringify(m.args, null, 2)}\n`);
      }
    }

    // 4. chrome-devtools-mcp upgrade, gated.
    const guardHealth = await getJson(`${ctx.guardUrl}/focus-guard/health`);
    const mcpPkg = readJson(path.join(ctx.runtime, 'node_modules', 'chrome-devtools-mcp', 'package.json'));
    const mcpArgs = readJson(ctx.mcpJson)?.mcpServers?.['chrome-devtools']?.args ?? [];
    if (mcpPkg?.version) {
      const latest = exec('npm', ['view', 'chrome-devtools-mcp', 'version'], { timeout: 60_000 }).stdout.trim();
      const decision = mcpUpgradeDecision(mcpPkg.version, latest);
      log(`chrome-devtools-mcp ${mcpPkg.version}, latest ${latest || '?'}: ${decision}`);
      if (!latest) pending = true;
      if (decision === 'major' && state.mcpNotified !== latest) {
        notes.push(`chrome-devtools-mcp ${latest} is a new major version; not applied automatically.`);
        state.mcpNotified = latest;
      } else if (decision === 'apply' && state.mcpRejected !== latest) {
        if (!guardHealth) {
          log('skip MCP upgrade: focus guard not reachable');
          pending = true;
        } else if (dryRun) {
          log(`would test and upgrade chrome-devtools-mcp to ${latest}`);
        } else {
          const outcome = upgradeMcp({ ctx, exec, from: mcpPkg.version, to: latest, mcpArgs, log });
          if (outcome.ok) {
            notes.push(`chrome-devtools-mcp ${mcpPkg.version} -> ${latest}; reload Cursor to use it.`);
            changedSomething = true;
          } else {
            state.mcpRejected = latest;
            notes.push(`chrome-devtools-mcp ${latest} failed checks (${outcome.reason}); staying on ${mcpPkg.version}.`);
          }
        }
      }
    }

    // 5. Chrome restart onto a newer on-disk build, only when idle.
    const running = (await getJson(`${ctx.chromeUrl}/json/version`))?.Browser?.replace(/^Chrome\//, '');
    const installed = chromeOnDiskVersion(exec);
    const verdict = idleDecision({ running, installed, idleSeconds: guardHealth?.idleSeconds, minIdle });
    log(`chrome running ${running ?? '?'}, on disk ${installed ?? '?'}, agents idle ${guardHealth?.idleSeconds ?? '?'}s: ${verdict}`);
    if (verdict === 'wait') pending = true;
    if (verdict === 'restart') {
      if (dryRun) {
        log('would restart Chrome');
      } else {
        const reset = isWin
          ? exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.home, '.local', 'bin', 'automation-chrome-reset.ps1')], { timeout: 180_000 })
          : exec(path.join(ctx.home, '.local', 'bin', 'automation-chrome-reset'), [], { timeout: 180_000 });
        log(`chrome restart: ${reset.ok ? 'ok' : 'FAILED'}`);
        if (reset.ok) changedSomething = true;
        else notes.push('Restarting Chrome for its update failed; run automation-chrome-reset.');
      }
    }

    // 6. Shared skills and rules: tell, never overwrite.
    const entries = sharedEntries(ctx);
    const { names, seen } = sharedChanges(entries, state.sharedSeen);
    if (names.length) notes.push(`Shared skills/rules changed in the repo: ${names.join(', ')}. Ask your agent to merge them into your local copies.`);
    log(`shared skills/rules changed: ${names.length ? names.join(', ') : 'none'}`);
    if (!dryRun) state.sharedSeen = { ...(state.sharedSeen ?? {}), ...seen };

    // 7. Health check; the full verify only when something changed.
    const after = await getJson(`${ctx.guardUrl}/focus-guard/health`);
    const chromeUp = await getJson(`${ctx.chromeUrl}/json/version`);
    if (!after || !chromeUp) {
      notes.push('Chrome or the focus guard is not answering; run automation-chrome-reset.');
      log('health: DOWN');
    } else if (changedSomething && !dryRun) {
      const v = isWin
        ? exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.bundleDir, 'windows', 'verify.ps1')], { timeout: 240_000 })
        : exec('bash', [path.join(ctx.bundleDir, 'verify.sh')], { timeout: 240_000 });
      log(`verify: ${v.ok ? 'ok' : 'FAILED'}`);
      if (!v.ok) notes.push('verify failed after the update; see the update log.');
    } else {
      log('health: ok');
    }

    if (!dryRun) {
      state.doneDate = pending ? undefined : today();
      state.lastRun = new Date().toISOString();
      fs.writeFileSync(ctx.stateFile, `${JSON.stringify(state, null, 2)}\n`);
      if (notes.length) notifyUser(notes.join(' '), exec);
    }
    log(`update end${pending ? ' (pending: will retry)' : ''}${notes.length ? `; notes: ${notes.join(' | ')}` : ''}`);
    return { notes, pending, pulls };
  } finally {
    if (!dryRun) fs.rmSync(ctx.lockFile, { force: true });
    flush();
  }
}

function sharedEntries(ctx) {
  const home = ctx.home;
  const out = [];
  const skillRoots = [path.join(home, '.cursor', 'skills'), path.join(home, '.claude', 'skills')];
  for (const repo of [ctx.bundleDir, ctx.razzDir]) {
    const skillsDir = path.join(repo, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const name of fs.readdirSync(skillsDir)) {
        out.push({ name: `skill:${name}`, repoPath: path.join(skillsDir, name), localPaths: skillRoots.map((r) => path.join(r, name)) });
      }
    }
  }
  const rulesDir = path.join(ctx.razzDir, 'cursor-rules');
  if (fs.existsSync(rulesDir)) {
    for (const file of fs.readdirSync(rulesDir).filter((f) => f.endsWith('.mdc'))) {
      out.push({ name: `rule:${file}`, repoPath: path.join(rulesDir, file), localPaths: [path.join(home, '.cursor', 'rules', file)] });
    }
  }
  return out;
}

/** Install into the runtime dir, probe, and roll back on any failure. */
function upgradeMcp({ ctx, exec, from, to, mcpArgs, log }) {
  // 1. Stage: do the candidate's flags still parse?
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-stage-'));
  try {
    const inst = exec('npm', ['install', `chrome-devtools-mcp@${to}`, '--prefix', stage, '--no-audit', '--no-fund', '--loglevel=error'], { timeout: 300_000 });
    if (!inst.ok) return { ok: false, reason: 'install failed' };
    const pkgDir = path.join(stage, 'node_modules', 'chrome-devtools-mcp');
    const pkg = readJson(path.join(pkgDir, 'package.json'), {});
    const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
    if (!bin) return { ok: false, reason: 'no bin entry' };
    const help = exec('node', [path.join(pkgDir, bin), '--help'], { timeout: 60_000 });
    const missing = missingFlags(`${help.stdout}\n${help.stderr}`, mcpArgs);
    if (missing.length) return { ok: false, reason: `flags no longer listed: ${missing.join(' ')}` };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  // 2. Install for real, then run the probe (tool surface plus the two-tab pageId test).
  const live = exec('npm', ['install', `chrome-devtools-mcp@${to}`, '--save-exact', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: ctx.runtime, timeout: 300_000 });
  if (!live.ok) return { ok: false, reason: 'install into runtime failed' };
  const probe = exec('node', [path.join(ctx.runtime, 'probe-mcp.mjs'), ...mcpArgs.slice(1)], { cwd: ctx.runtime, timeout: 240_000 });
  const passed = probe.ok && /page-id routing: on,/.test(probe.stdout);
  log(`probe ${to}: ${passed ? 'pass' : 'FAIL'}`);
  if (passed) return { ok: true };

  const back = exec('npm', ['install', `chrome-devtools-mcp@${from}`, '--save-exact', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: ctx.runtime, timeout: 300_000 });
  log(`rollback to ${from}: ${back.ok ? 'ok' : 'FAILED'}`);
  const reason = !probe.ok ? 'probe failed' : 'page-id routing test did not pass';
  return { ok: false, reason: back.ok ? reason : `${reason}; rollback also failed, run npm install in ${ctx.runtime}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const idleIdx = argv.indexOf('--min-idle');
  const result = await run({
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
    minIdle: idleIdx >= 0 ? Number(argv[idleIdx + 1]) : undefined,
  });
  if (result.skipped) console.log(`skipped: ${result.skipped}`);
}
