import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {activateRelease, ownedRelease, planRetention, retainReleases, withInstallationLock, trustedSystemCommand, trustedPamChild} from '../tools/release-retention.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {auditBundledLinks, dependencyIncluded} from '../tools/local-release.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-retention-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const root = path.join(dir, 'installation'), procRoot = path.join(dir, 'proc');
  await fs.mkdir(path.join(root, 'releases'), {recursive: true});
  await fs.mkdir(procRoot);
  const release = async (name, number = 1) => {
    const file = path.join(root, 'releases', name);
    await fs.mkdir(file);
    await fs.writeFile(path.join(file, 'INSTALLATION.json'), JSON.stringify({application: 'Nozeli', kind: 'local-development-snapshot', platform: 'linux', arch: process.arch, installedAt: new Date(1700000000000 + number * 1000).toISOString()}));
    await fs.writeFile(path.join(file, 'nozeli'), 'executable bytes');
    return file;
  };
  return {dir, root, procRoot, release};
}

test('activation retains exactly current and one rollback; dry run does not delete; repeated installs stay bounded', async t => {
  const f = await fixture(t), a = await f.release('a', 1), b = await f.release('b', 2), c = await f.release('c', 3);
  await activateRelease(f.root, a);
  await activateRelease(f.root, b);
  const dry = await retainReleases({...f, dryRun: true});
  assert.deepEqual(dry.remove, [c]);
  assert.equal(dry.freedBytes, 0);
  assert.ok(dry.estimates[0].items >= 3);
  await fs.access(c);
  await activateRelease(f.root, c);
  const result = await retainReleases(f);
  assert.deepEqual(result.removed, [a]);
  assert.ok(result.freedBytes > 0);
  assert.ok(result.freedItems >= 3);
  assert.equal(await fs.realpath(path.join(f.root, 'current')), c);
  assert.equal(await fs.realpath(path.join(f.root, 'previous')), b);
  assert.deepEqual((await fs.readdir(path.join(f.root, 'releases'))).sort(), ['b', 'c']);
  await activateRelease(f.root, c);
  assert.equal(await fs.realpath(path.join(f.root, 'previous')), b);
  const d = await f.release('d', 4);
  await activateRelease(f.root, d);
  await retainReleases(f);
  assert.deepEqual((await fs.readdir(path.join(f.root, 'releases'))).sort(), ['c', 'd']);
});

test('candidate policy keeps only newest pending candidate plus current and rollback', async t => {
  const f = await fixture(t), a = await f.release('a', 1), b = await f.release('b', 2);
  await activateRelease(f.root, a); await activateRelease(f.root, b);
  await f.release('old-candidate', 3);
  const newest = await f.release('new-candidate', 4);
  const plan = await planRetention({...f, mode: 'candidate', protect: [newest]});
  assert.deepEqual(plan.remove.map(file => path.basename(file)), ['old-candidate']);
  await retainReleases({...f, mode: 'candidate', protect: [newest]});
  assert.equal(await fs.realpath(path.join(f.root, 'current')), b);
  assert.equal((await planRetention({...f, mode: 'candidate'})).candidate, newest);
});

test('live kernel exe and absolute command arguments protect old releases until process exits', async t => {
  const f = await fixture(t), live = await f.release('live', 1), args = await f.release('args', 2), a = await f.release('a', 3), b = await f.release('b', 4);
  await activateRelease(f.root, a); await activateRelease(f.root, b);
  for (const pid of ['123', '456']) await fs.mkdir(path.join(f.procRoot, pid));
  await fs.symlink(path.join(live, 'nozeli'), path.join(f.procRoot, '123/exe'));
  await fs.writeFile(path.join(f.procRoot, '123/cmdline'), 'nozeli\0');
  await fs.symlink('/usr/bin/node', path.join(f.procRoot, '456/exe'));
  await fs.writeFile(path.join(f.procRoot, '456/cmdline'), '/usr/bin/node\0--app=' + path.join(args, 'resources/app') + '\0');
  assert.deepEqual((await planRetention(f)).remove, []);
  await fs.rm(path.join(f.procRoot, '123'), {recursive: true});
  assert.deepEqual((await planRetention(f)).remove, [live]);
});

test('unknown directories, external symlinks and symlinked markers are never deleted or activated', async t => {
  const f = await fixture(t), a = await f.release('a'), b = await f.release('b');
  await activateRelease(f.root, a); await activateRelease(f.root, b);
  const outside = path.join(f.dir, 'user-project');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'document'), 'user data');
  await fs.symlink(outside, path.join(f.root, 'releases/external'));
  await fs.mkdir(path.join(f.root, 'releases/unknown'));
  const fake = await f.release('fake');
  await fs.rename(path.join(fake, 'INSTALLATION.json'), path.join(outside, 'INSTALLATION.json'));
  await fs.symlink(path.join(outside, 'INSTALLATION.json'), path.join(fake, 'INSTALLATION.json'));
  const plan = await retainReleases(f);
  assert.equal(plan.skipped.length, 3);
  assert.deepEqual(plan.removed, []);
  await assert.rejects(activateRelease(f.root, path.join(f.root, 'releases/external')));
  await assert.rejects(ownedRelease(f.root, outside));
  assert.equal(await fs.readFile(path.join(outside, 'document'), 'utf8'), 'user data');
});

test('invalid current/previous and symlinked release container fail closed', async t => {
  const f = await fixture(t), a = await f.release('a'), b = await f.release('b');
  await activateRelease(f.root, a);
  await fs.symlink(f.dir, path.join(f.root, 'previous'));
  await assert.rejects(retainReleases(f));
  await assert.rejects(activateRelease(f.root, b));
  assert.equal(await fs.realpath(path.join(f.root, 'current')), a);
  await fs.unlink(path.join(f.root, 'previous'));
  await fs.unlink(path.join(f.root, 'current'));
  await fs.symlink(f.dir, path.join(f.root, 'current'));
  await assert.rejects(retainReleases(f));
  await fs.rename(path.join(f.root, 'releases'), path.join(f.dir, 'elsewhere'));
  await fs.symlink(path.join(f.dir, 'elsewhere'), path.join(f.root, 'releases'));
  await assert.rejects(planRetention(f));
});

test('install lock excludes concurrent tools and is released after failure without deleting versions', async t => {
  const f = await fixture(t), a = await f.release('a');
  await activateRelease(f.root, a);
  await assert.rejects(withInstallationLock(f.root, async () => {
    await assert.rejects(withInstallationLock(f.root, () => {}));
    throw Error('validation failed');
  }), /validation failed/);
  await withInstallationLock(f.root, async () => assert.equal(await fs.realpath(path.join(f.root, 'current')), a));
});

test('release audit rejects escaping links and preserves internal links', async t => {
  const f = await fixture(t), a = await f.release('a');
  await fs.symlink('nozeli', path.join(a, 'internal'));
  await auditBundledLinks(a);
  await fs.symlink(f.dir, path.join(a, 'escape'));
  await assert.rejects(auditBundledLinks(a), /escapes/);
});

test('production filter excludes dev-only trees but keeps shared runtime and nested dependencies', () => {
  const lock = {packages: {'node_modules/devtool': {dev: true}, 'node_modules/@scope/dev': {dev: true}, 'node_modules/shared': {}, 'node_modules/runtime/node_modules/nested': {}}};
  assert.equal(dependencyIncluded(lock, ''), true);
  for (const name of ['devtool', 'devtool/bin/cli.js', '@scope/dev/index.js', 'electron/dist/electron']) assert.equal(dependencyIncluded(lock, name), false);
  for (const name of ['shared/index.js', 'runtime/node_modules/nested/index.js', '@scope/runtime']) assert.equal(dependencyIncluded(lock, name), true);
});

test('real Linux proc command line protects a node-hosted release', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t), live = await f.release('node-runtime', 1), a = await f.release('a', 2), b = await f.release('b', 3);
  await activateRelease(f.root, a); await activateRelease(f.root, b);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(live, 'runtime/worker.mjs')], {stdio: 'ignore'});
  t.after(() => child.kill());
  await once(child, 'spawn');
  const plan = await planRetention({root: f.root});
  assert.ok(plan.kept.includes(live));
  assert.ok(!plan.remove.includes(live));
  const exited = once(child, 'exit'); child.kill(); await exited;
});

test('non-dumpable fallback accepts only matching root-controlled absolute system commands', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t);
  const executable = await fs.realpath('/usr/bin/true');
  assert.equal(await trustedSystemCommand([executable], path.basename(executable), f.root), true);
  assert.equal(await trustedSystemCommand([executable], 'not-the-command', f.root), false);
  assert.equal(await trustedSystemCommand(['true'], 'true', f.root), false);
  const userBinary = path.join(f.dir, 'user-command');
  await fs.writeFile(userBinary, '#!/bin/sh\n', {mode: 0o755});
  assert.equal(await trustedSystemCommand([userBinary], 'user-command', f.root), false);
});

test('PAM fallback requires exact identity and a trusted systemd user-manager parent', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t), child = path.join(f.procRoot, '12'), parent = path.join(f.procRoot, '11');
  await fs.mkdir(child); await fs.mkdir(parent);
  await fs.writeFile(path.join(child, 'status'), 'PPid:\t11\n');
  await fs.writeFile(path.join(parent, 'cmdline'), '/usr/lib/systemd/systemd\0--user\0');
  await fs.writeFile(path.join(parent, 'comm'), 'systemd\n');
  assert.equal(await trustedPamChild(['(sd-pam)'], '(sd-pam)', child, f.procRoot, f.root), true);
  assert.equal(await trustedPamChild(['(sd-pam)', 'extra'], '(sd-pam)', child, f.procRoot, f.root), false);
  await fs.writeFile(path.join(parent, 'cmdline'), '/usr/bin/true\0--user\0');
  assert.equal(await trustedPamChild(['(sd-pam)'], '(sd-pam)', child, f.procRoot, f.root), false);
});
