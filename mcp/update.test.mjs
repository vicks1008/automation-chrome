import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  compareVersions,
  idleDecision,
  mcpUpgradeDecision,
  migrateMcpArgs,
  missingFlags,
  normalizeFlag,
  pullRepo,
  syncSharedSkills,
} from './update.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `${p}-`));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

test('version comparison and the major-version gate', () => {
  assert.equal(compareVersions('1.12.0', '1.9.3'), 1);
  assert.equal(compareVersions('1.12.0', '1.12.0'), 0);
  assert.equal(compareVersions('156.0.8078.48', '156.0.8078.74'), -1);
  assert.equal(mcpUpgradeDecision('1.12.0', '1.12.0'), 'current');
  assert.equal(mcpUpgradeDecision('1.12.0', '1.11.0'), 'current');
  assert.equal(mcpUpgradeDecision('1.12.0', '1.13.2'), 'apply');
  assert.equal(mcpUpgradeDecision('1.12.0', '2.0.0'), 'major');
  assert.equal(mcpUpgradeDecision('1.12.0', ''), 'current');
});

test('flag names normalise across camelCase, kebab-case and =value', () => {
  assert.equal(normalizeFlag('--allowUnrestrictedPaths'), 'allow-unrestricted-paths');
  assert.equal(normalizeFlag('--allow-unrestricted-paths'), 'allow-unrestricted-paths');
  assert.equal(normalizeFlag('--experimentalFfmpegPath=/x'), 'experimental-ffmpeg-path');
  assert.equal(normalizeFlag('http://127.0.0.1:9333'), null);
});

test('missingFlags accepts either spelling and --no- negations, and spots a removed flag', () => {
  const help = '--browserUrl  --allowUnrestrictedPaths  --usageStatistics  --memoryDebugging';
  const args = [
    '/x/wrapper.mjs',
    '--browserUrl',
    'http://127.0.0.1:9333',
    '--allow-unrestricted-paths',
    '--no-usage-statistics',
    '--memoryDebugging=true',
    '--experimentalScreencast=true',
  ];
  assert.deepEqual(missingFlags(help, args), ['--experimental-screencast']);
});

test('migration removes only --no-page-id-routing and leaves everything else', () => {
  const args = ['w.mjs', '--browserUrl', 'u', '--no-page-id-routing', '--no-usage-statistics'];
  const m = migrateMcpArgs(args);
  assert.equal(m.changed, true);
  assert.deepEqual(m.args, ['w.mjs', '--browserUrl', 'u', '--no-usage-statistics']);
  assert.equal(migrateMcpArgs(m.args).changed, false);
});

test('Chrome restarts only when newer on disk AND agents have been idle long enough', () => {
  const base = { running: '156.0.1.1', installed: '156.0.1.9', minIdle: 900 };
  assert.equal(idleDecision({ ...base, idleSeconds: 901 }), 'restart');
  assert.equal(idleDecision({ ...base, idleSeconds: 60 }), 'wait');
  assert.equal(idleDecision({ ...base, idleSeconds: undefined }), 'wait');
  assert.equal(idleDecision({ ...base, installed: '156.0.1.1', idleSeconds: 5000 }), 'current');
  assert.equal(idleDecision({ ...base, running: undefined, idleSeconds: 5000 }), 'unknown');
});

function makeRepoPair() {
  const root = tmp('upd-repo');
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'config', 'user.email', 't@t');
  git(work, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(work, 'a.txt'), '1');
  fs.writeFileSync(path.join(work, 'b.txt'), 'b');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'one');
  git(work, 'push', '-q', 'origin', 'HEAD');
  git(root, 'clone', '-q', origin, other);
  git(other, 'config', 'user.email', 't@t');
  git(other, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(other, 'a.txt'), '2');
  git(other, 'commit', '-qam', 'two');
  git(other, 'push', '-q', 'origin', 'HEAD');
  return { work };
}

test('pullRepo fast-forwards a clean checkout and reports the changed files', () => {
  const { work } = makeRepoPair();
  const r = pullRepo(work);
  assert.equal(r.status, 'pulled');
  assert.deepEqual(r.files, ['a.txt']);
  assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), '2');
  assert.equal(pullRepo(work).status, 'current');
});

test('pullRepo fast-forwards past uncommitted edits to unrelated files', () => {
  const { work } = makeRepoPair();
  fs.writeFileSync(path.join(work, 'b.txt'), 'another session is editing this');
  const r = pullRepo(work);
  assert.equal(r.status, 'pulled');
  assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), '2');
  assert.equal(fs.readFileSync(path.join(work, 'b.txt'), 'utf8'), 'another session is editing this');
});

test('pullRepo leaves a checkout alone when the incoming commits touch an edited file', () => {
  const { work } = makeRepoPair();
  fs.writeFileSync(path.join(work, 'a.txt'), 'local edit');
  assert.equal(pullRepo(work).status, 'dirty');
  assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'local edit');
});

test('pullRepo --dry-run changes nothing, and a missing checkout is reported', () => {
  const { work } = makeRepoPair();
  assert.equal(pullRepo(work, undefined, { dryRun: true }).status, 'would-pull');
  assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), '1');
  assert.equal(pullRepo(path.join(os.tmpdir(), 'no-such-repo-xyz')).status, 'missing');
});

test('shared skills: runs the repo sync script and reports its result', () => {
  const razzDir = tmp('upd-razz');
  const ctx = { razzDir, bundleDir: '/bundle' };
  // A checkout that predates the script is skipped, not an error.
  assert.equal(syncSharedSkills(ctx).status, 'no-script');

  fs.mkdirSync(path.join(razzDir, 'scripts'));
  fs.writeFileSync(path.join(razzDir, 'scripts', 'sync-skills.mjs'), '');
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { ok: true, status: 0, stdout: `noise\n${JSON.stringify({ installed: 1, updated: 2, diverged: 0, ok: 3, backups: [] })}\n`, stderr: '' };
  };
  const r = syncSharedSkills(ctx, exec);
  assert.equal(r.status, 'ok');
  assert.equal(r.result.updated, 2);
  assert.deepEqual(calls[0].args.slice(1), ['--json']);
  assert.equal(calls[0].opts.env.AUTOMATION_CHROME_BUNDLE_DIR, '/bundle');

  // Dry run asks for --check, and a non-zero exit (drift found) still parses.
  const drift = () => ({ ok: false, status: 1, stdout: JSON.stringify({ differs: [{ name: 's' }], backups: [] }), stderr: '' });
  const d = syncSharedSkills(ctx, drift, { dryRun: true });
  assert.equal(d.status, 'ok');
  assert.equal(d.result.differs.length, 1);

  // Unparseable output is a failure with detail, never a crash.
  const bad = () => ({ ok: false, status: 2, stdout: '', stderr: 'boom' });
  assert.equal(syncSharedSkills(ctx, bad).status, 'failed');
});
