import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {detectInstallation} from '../src/main/auto-update-files.mjs';
import {withInstallationLock} from '../tools/release-retention.mjs';

// Regression scope: the real ~/.local/opt/nozeli layout was created by tooling
// with the packaging umask applied, leaving group-writable root/releases
// directories (0775) that detectInstallation silently collapsed into the
// "source installation" label (supported:false). Validated installations must
// fail diagnosably instead, layout creation must be private, and detection
// must never rewrite a legacy layout.
const SKIP = process.platform !== 'linux' || process.arch !== 'x64' ? 'requires the Linux x64 installation layout; not Mac updater qualification' : false;

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-installation-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}
const mode = async directory => (await fs.stat(directory)).mode & 0o777;
async function snapshot(release, version = '0.1.0-alpha.6', extra = {}) {
  await fs.mkdir(path.join(release, 'resources/app'), {recursive: true});
  await fs.writeFile(path.join(release, 'INSTALLATION.json'), JSON.stringify({application: 'Nozeli', version, installedAt: '2026-11-11T01:42:41.136Z', kind: 'local-development-snapshot', platform: 'linux', arch: 'x64', state: 'validated', ...extra}));
}
async function managedLayout(t, {layoutMode = 0o700} = {}) {
  const root = path.join(await temporary(t), 'nozeli'), releases = path.join(root, 'releases');
  await fs.mkdir(releases, {recursive: true, mode: layoutMode});
  await fs.chmod(root, layoutMode); await fs.chmod(releases, layoutMode);
  return {root, releases};
}
test('legacy group-writable installation fails diagnosably and is never rewritten', {skip: SKIP}, async t => {
  const {root, releases} = await managedLayout(t, {layoutMode: 0o775});
  const release = path.join(releases, 'review-recovery-20261111-local-01');
  await fs.mkdir(release, {mode: 0o700});
  await snapshot(release);
  await fs.symlink(release, path.join(root, 'current'));
  await assert.rejects(detectInstallation(path.join(release, 'resources/app')), error => {
    assert.match(error.message, /Unsafe updater directory: /);
    assert.ok(error.message.endsWith(root), error.message);
    return true;
  });
  assert.equal(await mode(root), 0o775);
  assert.equal(await mode(releases), 0o775);
});
test('validated local-development-snapshot stays a managed installation that can adopt public packages', {skip: SKIP}, async t => {
  const {root, releases} = await managedLayout(t);
  const release = path.join(releases, 'review-recovery-20261111-local-01');
  await fs.mkdir(release, {mode: 0o700});
  await snapshot(release);
  await fs.symlink(release, path.join(root, 'current'));
  assert.deepEqual(await detectInstallation(path.join(release, 'resources/app')), {kind: 'managed', root, release});
  assert.equal(await mode(root), 0o700);
});
test('directories without an installation marker remain check-only source installations', {skip: SKIP}, async t => {
  const appRoot = path.join(await temporary(t), 'apps/desktop');
  await fs.mkdir(appRoot, {recursive: true});
  assert.equal(await detectInstallation(appRoot), null);
});
test('markers that are not validated linux x64 Nozeli installs are not auto-installable', {skip: SKIP}, async t => {
  const scratch = await temporary(t);
  for (const [index, extra] of [{state: 'building'}, {platform: 'darwin'}, {arch: 'arm64'}].entries()) {
    const release = path.join(scratch, 'case' + index);
    await fs.mkdir(path.join(release, 'resources/app'), {recursive: true});
    await snapshot(release, '1.0.0', extra);
    assert.equal(await detectInstallation(path.join(release, 'resources/app')), null, JSON.stringify(extra));
  }
});
test('managed layout whose current reference selects another release is reported, not relabelled', {skip: SKIP}, async t => {
  const {root, releases} = await managedLayout(t);
  const active = path.join(releases, 'active'), running = path.join(releases, 'running');
  for (const release of [active, running]) { await fs.mkdir(release, {mode: 0o700}); await snapshot(release); }
  await fs.symlink(active, path.join(root, 'current'));
  await assert.rejects(detectInstallation(path.join(running, 'resources/app')), /current does not select this release/);
});
test('symlinked installation root is rejected without loosening the ownership boundary', {skip: SKIP}, async t => {
  const {root, releases} = await managedLayout(t);
  const release = path.join(releases, 'r1');
  await fs.mkdir(release, {mode: 0o700}); await snapshot(release);
  await fs.symlink(release, path.join(root, 'current'));
  const link = path.join(path.dirname(root), 'link');
  await fs.symlink(root, link);
  await assert.rejects(detectInstallation(path.join(link, 'releases', 'r1', 'resources/app')), /Unsafe updater directory: .*link/);
});
test('portable installations need their executable entrypoint and report when it is missing', {skip: SKIP}, async t => {
  const root = path.join(await temporary(t), 'portable-root');
  await fs.mkdir(root, {mode: 0o700});
  const release = path.join(root, 'Nozeli-1.0.0-linux-x64'), broken = path.join(root, 'broken');
  for (const directory of [release, broken]) {
    await fs.mkdir(path.join(directory, 'resources/app'), {recursive: true});
    await fs.chmod(directory, 0o700);
    await snapshot(directory, '1.0.0');
  }
  await fs.writeFile(path.join(release, 'AppRun'), '#!/bin/sh\n', {mode: 0o755});
  assert.deepEqual(await detectInstallation(path.join(release, 'resources/app')), {kind: 'portable', root, release});
  await assert.rejects(detectInstallation(path.join(broken, 'resources/app')), /entrypoint is not executable/);
});
test('installation layout creation is private under a permissive umask and never tightens existing directories', {skip: SKIP}, async t => {
  const scratch = await temporary(t);
  const previous = process.umask(0o002);
  let ran;
  try { ran = await withInstallationLock(path.join(scratch, 'nozeli'), async () => 'ran'); }
  finally { process.umask(previous); }
  assert.equal(ran, 'ran');
  assert.equal(await mode(path.join(scratch, 'nozeli')), 0o700);
  assert.equal(await mode(path.join(scratch, 'nozeli', 'releases')), 0o700);
  const legacy = path.join(scratch, 'legacy');
  await fs.mkdir(path.join(legacy, 'releases'), {recursive: true});
  await fs.chmod(legacy, 0o775); await fs.chmod(path.join(legacy, 'releases'), 0o775);
  await withInstallationLock(legacy, async () => {});
  assert.equal(await mode(legacy), 0o775);
  assert.equal(await mode(path.join(legacy, 'releases')), 0o775);
});
