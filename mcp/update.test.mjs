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
  sharedChanges,
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

test('pullRepo leaves a dirty checkout alone', () => {
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

test('shared skills: notify on a changed repo copy, never write to local copies', () => {
  const root = tmp('upd-skills');
  const repo = path.join(root, 'repo', 'skills', 's');
  const local = path.join(root, 'home', 's');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(repo, 'SKILL.md'), 'v1');
  fs.writeFileSync(path.join(local, 'SKILL.md'), 'v1 plus a local lesson');
  const entries = [{ name: 'skill:s', repoPath: repo, localPaths: [local, path.join(root, 'absent')] }];

  // Seed: nothing is reported the first time (no previous hashes).
  const first = sharedChanges(entries, undefined);
  assert.deepEqual(first.names, []);
  // Unchanged repo copy: no notice, even though the local copy differs.
  assert.deepEqual(sharedChanges(entries, first.seen).names, []);
  // Repo copy changes: notice.
  fs.writeFileSync(path.join(repo, 'SKILL.md'), 'v2');
  const second = sharedChanges(entries, first.seen);
  assert.deepEqual(second.names, ['skill:s']);
  // Local copy is untouched.
  assert.equal(fs.readFileSync(path.join(local, 'SKILL.md'), 'utf8'), 'v1 plus a local lesson');
  // A skill that is not installed locally is skipped.
  assert.deepEqual(sharedChanges([{ ...entries[0], localPaths: [path.join(root, 'absent')] }], first.seen).names, []);
});
