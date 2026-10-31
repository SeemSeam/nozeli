import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import * as tar from 'tar';
import {AutoUpdater, selectRelease, manifestChecksum} from '../src/main/auto-update.mjs';
import {compareVersions, semver, atomicJson, extractPackage, downloadFile, processIdentity} from '../src/main/auto-update-files.mjs';
import {acquireInstallLock, runUpdateHelper} from '../src/main/auto-update-helper.mjs';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-update-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true})); return root;
}
async function packageFixture(directory, version) {
  await fs.mkdir(path.join(directory, 'resources/app/src/main'), {recursive: true});
  await fs.mkdir(path.join(directory, 'resources/app/dist/renderer'), {recursive: true});
  const metadata = {application: 'Nozeli', version, platform: 'linux', arch: 'x64', state: 'validated', format: 'portable-tar.gz', commit: 'a'.repeat(40)};
  await atomicJson(path.join(directory, 'RELEASE.json'), metadata);
  await atomicJson(path.join(directory, 'INSTALLATION.json'), metadata);
  await atomicJson(path.join(directory, 'resources/app/package.json'), {name: 'nozeli-desktop', version, main: 'src/main/main.cjs'});
  for (const file of ['resources/app/src/main/main.cjs', 'resources/app/src/main/auto-update-helper.mjs', 'resources/app/src/main/auto-update-extract.mjs', 'resources/app/dist/renderer/app.js', 'AppRun']) await fs.writeFile(path.join(directory, file), '', {mode: 0o755});
  const elf = Buffer.alloc(20); elf.write('7f454c46', 0, 'hex'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
  await fs.writeFile(path.join(directory, 'nozeli'), elf, {mode: 0o755});
}
function release(version) {
  return {tag_name: 'v' + version, assets: [{name: 'Nozeli-' + version + '-linux-x64.tar.gz', browser_download_url: 'https://github.com/SeemSeam/nozeli/releases/download/v' + version + '/archive', size: 100}, {name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/SeemSeam/nozeli/releases/download/v' + version + '/SHA256SUMS.txt', size: 100}]};
}
test('semantic ordering includes alpha and ignores draft/missing-asset releases and downgrades', () => {
  assert.equal(selectRelease([release('1.0.0-alpha.9'), release('1.0.0-alpha.10'), {...release('2.0.0'), draft: true}, {tag_name: '9.0.0', assets: []}], '1.0.0-alpha.8').version, '1.0.0-alpha.10');
  assert.equal(selectRelease([release('1.0.0')], '1.0.0'), null);
  assert.equal(compareVersions('1.0.0', '1.0.0-alpha.99'), 1);
  assert.equal(compareVersions('1.0.0-alpha.99999999999999999999999', '1.0.0-alpha.99999999999999999999998'), 1);
  assert.equal(semver('1.0.0-alpha.01'), null);
});
test('checksum requires one exact filename and streaming download verifies bytes', async t => {
  const root = await temporary(t), data = Buffer.from('release bytes'), checksum = crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(manifestChecksum(checksum + '  archive.tar.gz\n', 'archive.tar.gz'), checksum);
  assert.throws(() => manifestChecksum((checksum + '  archive.tar.gz\n').repeat(2), 'archive.tar.gz'));
  const file = path.join(root, 'download'); let progress;
  await downloadFile({response: new Response(data), file, expected: checksum, onProgress: value => { progress = value; }});
  assert.equal(progress.received, data.length);
  await assert.rejects(downloadFile({response: new Response(data), file: file + '-bad', expected: '0'.repeat(64)}), /SHA256/);
  await assert.rejects(fs.access(file + '-bad'));
  await assert.rejects(downloadFile({response: new Response(data), file: file + '-large', expected: checksum, max: 2}), /limit/);
});
test('archive staging validates native metadata and rejects root and escaping links', async t => {
  const root = await temporary(t), label = 'Nozeli-1.0.1-linux-x64', source = path.join(root, label);
  await packageFixture(source, '1.0.1');
  const archive = path.join(root, 'release.tar.gz');
  await tar.c({cwd: root, gzip: true, file: archive}, [label]);
  assert.equal(await extractPackage(archive, path.join(root, 'stage'), '1.0.1'), path.join(root, 'stage', label));
  await assert.rejects(extractPackage(archive, path.join(root, 'wrong-version'), '1.0.2'), /root/);
  await fs.symlink('../../../outside', path.join(source, 'escape'));
  await tar.c({cwd: root, gzip: true, file: archive}, [label]);
  await assert.rejects(extractPackage(archive, path.join(root, 'unsafe'), '1.0.1'), /link/);
  await assert.rejects(fs.access(path.join(root, 'unsafe')), {code: 'ENOENT'});
});
test('disabled startup makes no network requests; source explicit checks are check-only', async t => {
  const root = await temporary(t); let calls = 0;
  const updater = new AutoUpdater({currentVersion: '1.0.0', appRoot: root, stateDir: path.join(root, 'state'), enabled: false, dependencies: {fetch: async () => { calls++; return new Response(JSON.stringify([release('1.0.1-alpha.1')])); }}});
  await updater.start(); assert.equal(calls, 0);
  const status = await updater.check(); assert.equal(calls, 1); assert.equal(status.phase, 'unsupported'); assert.equal(status.availableVersion, '1.0.1-alpha.1');
  updater.stop(); await updater.persist;
});
test('host readiness is mandatory and unsaved work never reaches shutdown', async t => {
  const root = await temporary(t); let prepared = 0;
  const updater = new AutoUpdater({currentVersion: '1.0.0', appRoot: root, stateDir: path.join(root, 'state'), canInstall: async () => ({ready: false, reason: 'unsaved edits'}), prepareShutdown: async () => { prepared++; return true; }, quit: () => { throw Error('must not quit'); }});
  await updater.initialize(); updater.candidate = {path: '/unused', version: '1.0.1'};
  const state = await updater.installIfIdle(); assert.equal(state.phase, 'waiting-idle'); assert.equal(state.message, 'unsaved edits'); assert.equal(prepared, 0);
  await updater.persist;
});
for (const kind of ['managed', 'portable']) for (const healthy of [true, false]) test(kind + ' promotion ' + (healthy ? 'health success' : 'startup rollback'), async t => {
  const root = await temporary(t), base = kind === 'managed' ? path.join(root, 'releases') : root;
  await fs.mkdir(base, {recursive: true});
  const old = path.join(base, 'old'), candidate = path.join(base, 'candidate');
  await packageFixture(old, '1.0.0'); await packageFixture(candidate, '1.0.1');
  if (kind === 'managed') await fs.symlink(old, path.join(root, 'current'));
  const state = path.join(root, 'state'); await fs.mkdir(state, {mode: 0o700});
  const token = crypto.randomBytes(32).toString('hex'), parent = await processIdentity(process.pid);
  await acquireInstallLock(root, token);
  const journal = path.join(state, 'handoff.json');
  await atomicJson(journal, {token, parent, version: '1.0.1', expectedCommit: 'a'.repeat(40), candidate, installation: {kind, root, release: old}});
  let inspections = 0, now = 0, launches = 0;
  const spawnProcess = (binary, args, options) => {
    launches++;
    const child = new EventEmitter(); child.pid = 2147483647; child.unref = () => {};
    if (healthy && options.env.NOZELI_UPDATE_RECEIPT) void atomicJson(options.env.NOZELI_UPDATE_RECEIPT, {token, release: path.dirname(binary), version: '1.0.1', pid: child.pid});
    return child;
  };
  const promise = runUpdateHelper(journal, {identity: async () => ++inspections === 1 ? parent : null, spawnProcess, now: () => now, pause: async () => { now += 100; await new Promise(resolve => setImmediate(resolve)); }, healthTimeout: 5000});
  if (healthy) assert.equal((await promise).phase, 'installed'); else await assert.rejects(promise, /startup health/);
  assert.equal((await readJsonLocal(journal)).phase, healthy ? 'installed' : 'rolled-back');
  const active = kind === 'managed' ? await fs.realpath(path.join(root, 'current')) : old;
  assert.equal((await readJsonLocal(path.join(active, 'RELEASE.json'))).version, healthy ? '1.0.1' : '1.0.0');
  assert.equal(launches, healthy ? 1 : 2);
  await assert.rejects(fs.access(path.join(root, '.installer-lock')));
});
async function readJsonLocal(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
test('annotated tags peel only bounded fixed repository API identities', async t => {
  const root = await temporary(t), calls = [];
  const updater = new AutoUpdater({currentVersion: '1.0.0', appRoot: root, stateDir: path.join(root, 'state'), dependencies: {fetch: async url => {
    calls.push(String(url));
    if (String(url).endsWith('/git/ref/tags/v1.0.1')) return new Response(JSON.stringify({ref: 'refs/tags/v1.0.1', object: {type: 'tag', sha: 'b'.repeat(40), url: 'https://evil.invalid/ignored'}}));
    return new Response(JSON.stringify({sha: 'b'.repeat(40), object: {type: 'commit', sha: 'a'.repeat(40)}}));
  }}});
  assert.equal(await updater.resolveTagCommit('v1.0.1'), 'a'.repeat(40));
  assert.deepEqual(calls, ['https://api.github.com/repos/SeemSeam/nozeli/git/ref/tags/v1.0.1', 'https://api.github.com/repos/SeemSeam/nozeli/git/tags/' + 'b'.repeat(40)]);
  updater.fetch = async () => new Response(JSON.stringify({ref: 'refs/tags/v1.0.1', object: {type: 'tag', sha: 'b'.repeat(40)}, sha: 'b'.repeat(40)}));
  await assert.rejects(updater.resolveTagCommit('v1.0.1'), /cyclic/);
});
test('checksum-valid version-correct archive with wrong release tag commit is rejected before promotion', async t => {
  const root = await temporary(t), installation = path.join(root, 'installation'), releases = path.join(installation, 'releases');
  await fs.mkdir(releases, {recursive: true});
  const old = path.join(releases, 'old'); await packageFixture(old, '1.0.0');
  await fs.symlink(old, path.join(installation, 'current'));
  const publish = path.join(root, 'publish'), label = 'Nozeli-1.0.1-linux-x64';
  await packageFixture(path.join(publish, label), '1.0.1');
  const archive = path.join(root, 'archive.tar.gz');
  await tar.c({cwd: publish, gzip: true, file: archive}, [label]);
  const bytes = await fs.readFile(archive), checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  let downloaded = false, quit = false;
  const updater = new AutoUpdater({currentVersion: '1.0.0', appRoot: path.join(old, 'resources/app'), stateDir: path.join(root, 'state'), canInstall: async () => ({ready: true}), prepareShutdown: async () => true, quit: () => { quit = true; }, dependencies: {fetch: async value => {
    const url = String(value);
    if (url.includes('/git/ref/tags/')) return new Response(JSON.stringify({ref: 'refs/tags/v1.0.1', object: {type: 'commit', sha: 'b'.repeat(40)}}));
    if (url.endsWith('/SHA256SUMS.txt')) return new Response(checksum + '  ' + label + '.tar.gz\n');
    if (url.endsWith('/archive')) { downloaded = true; return new Response(bytes); }
    return new Response(JSON.stringify([release('1.0.1')]));
  }}});
  const status = await updater.check();
  assert.equal(downloaded, true); assert.equal(quit, false);
  assert.equal(status.phase, 'error'); assert.match(status.message, /commit.*GitHub release tag/);
  assert.equal(await fs.realpath(path.join(installation, 'current')), old);
  assert.deepEqual(await fs.readdir(releases), ['old']);
  await updater.persist;
});
test('automatic checks quarantine rolled-back version, allow higher versions, and explicit checks retry', async t => {
  const root = await temporary(t), stateDir = path.join(root, 'state'); await fs.mkdir(stateDir);
  await atomicJson(path.join(stateDir, 'handoff.json'), {phase: 'rolled-back', version: '1.0.1'});
  let versions = [release('1.0.1')];
  const updater = new AutoUpdater({currentVersion: '1.0.0', appRoot: root, stateDir, dependencies: {fetch: async () => new Response(JSON.stringify(versions))}});
  let status = await updater.check({automatic: true});
  assert.equal(status.phase, 'error'); assert.match(status.message, /automatic retry is paused/); assert.equal(status.failedVersion, '1.0.1');
  assert.equal(updater.candidate, undefined);
  versions.push(release('1.0.2'));
  status = await updater.check({automatic: true}); assert.equal(status.availableVersion, '1.0.2');
  versions = [release('1.0.1')];
  status = await updater.check(); assert.equal(status.availableVersion, '1.0.1'); assert.equal(status.phase, 'unsupported');
  assert.equal(updater.quarantinedVersion, null);
  await updater.persist;
});
for (const damage of ['preferences', 'cache-directory']) test('updater startup contains ' + damage + ' failure without network or installation', async t => {
  const root = await temporary(t), stateDir = path.join(root, 'state');
  if (damage === 'preferences') {
    await fs.mkdir(stateDir);
    await fs.writeFile(path.join(stateDir, 'preferences.json'), '{damaged preference bytes');
  } else await fs.writeFile(stateDir, 'not a writable updater directory');
  let network = 0, installation = 0;
  const updater = new AutoUpdater({currentVersion: '1.0.0', appRoot: root, stateDir, enabled: true, canInstall: async () => { installation++; return {ready: true}; }, prepareShutdown: async () => { installation++; return true; }, quit: () => { installation++; }, dependencies: {fetch: async () => { network++; throw Error('must not access network'); }}});
  const status = await updater.start();
  assert.equal(status.phase, 'error'); assert.equal(status.enabled, false);
  assert.match(status.message, /Automatic updates disabled:/);
  assert.equal(updater.timer, null); assert.equal(updater.idleTimer, null);
  assert.equal(network, 0); assert.equal(installation, 0);
  assert.equal(updater.status().phase, 'error');
  if (damage === 'preferences') assert.equal(await fs.readFile(path.join(stateDir, 'preferences.json'), 'utf8'), '{damaged preference bytes');
  else assert.equal(await fs.readFile(stateDir, 'utf8'), 'not a writable updater directory');
  await updater.persist;
});
test('repeated checks revalidate and reuse identical staged version and tag commit while idle guard blocks', async t => {
  const root = await temporary(t), installation = path.join(root, 'installation'), releases = path.join(installation, 'releases');
  await fs.mkdir(releases, {recursive: true});
  const old = path.join(releases, 'old'); await packageFixture(old, '1.0.0');
  await fs.symlink(old, path.join(installation, 'current'));
  const publish = path.join(root, 'publish'), label = 'Nozeli-1.0.1-linux-x64';
  await packageFixture(path.join(publish, label), '1.0.1');
  const archive = path.join(root, 'archive.tar.gz');
  await tar.c({cwd: publish, gzip: true, file: archive}, [label]);
  const bytes = await fs.readFile(archive), checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  let archives = 0, manifests = 0, tags = 0;
  const updater = new AutoUpdater({currentVersion: '1.0.0', appRoot: path.join(old, 'resources/app'), stateDir: path.join(root, 'state'), canInstall: async () => ({ready: false, reason: 'busy'}), prepareShutdown: async () => { throw Error('busy guard must prevent shutdown'); }, quit: () => { throw Error('busy guard must prevent quit'); }, dependencies: {fetch: async value => {
    const url = String(value);
    if (url.includes('/git/ref/tags/')) { tags++; return new Response(JSON.stringify({ref: 'refs/tags/v1.0.1', object: {type: 'commit', sha: 'a'.repeat(40)}})); }
    if (url.endsWith('/SHA256SUMS.txt')) { manifests++; return new Response(checksum + '  ' + label + '.tar.gz\n'); }
    if (url.endsWith('/archive')) { archives++; return new Response(bytes); }
    return new Response(JSON.stringify([release('1.0.1')]));
  }}});
  assert.equal((await updater.check()).phase, 'waiting-idle');
  const candidate = updater.candidate.path;
  assert.equal((await updater.check()).phase, 'waiting-idle');
  assert.equal(updater.candidate.path, candidate); assert.equal(archives, 1); assert.equal(manifests, 1); assert.equal(tags, 2);
  assert.deepEqual((await fs.readdir(releases)).sort(), [path.basename(candidate), 'old'].sort());
  // Reuse is conditional on current package invariants, not only cached identity.
  await fs.chmod(path.join(candidate, 'nozeli'), 0o644);
  assert.equal((await updater.check()).phase, 'error');
  assert.equal(archives, 1);
  await updater.persist;
});
