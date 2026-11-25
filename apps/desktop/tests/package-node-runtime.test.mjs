import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import {packageNodeRuntime} from '../tools/package-node-runtime.mjs';

async function fixture(t, entries = [['node-fixture/node.exe', 'synthetic PE placeholder']]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-package-node-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), application = path.join(root, 'application');
  await fs.mkdir(path.join(source, 'tools'), {recursive: true});
  const zip = new JSZip();
  for (const [name, bytes, options] of entries) zip.file(name, bytes, options);
  const bytes = await zip.generateAsync({type: 'nodebuffer', platform: 'UNIX'});
  const archive = path.join(root, 'node-fixture.zip');
  await fs.writeFile(archive, bytes);
  const lock = {schema: 1, version: 'fixture', platform: process.platform, arch: process.arch,
    archive: 'node-fixture.zip', archivePrefix: 'node-fixture', executable: 'node.exe',
    sha256Archive: createHash('sha256').update(bytes).digest('hex')};
  const lockFile = path.join(source, 'tools', 'node-runtime.lock.json');
  await fs.writeFile(lockFile, JSON.stringify(lock));
  return {root, source, application, archive, lock, lockFile, directory: path.join(application, 'runtime', 'node')};
}

test('Node packaging refuses a digest mismatch before publishing or changing existing assets', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, {recursive: true});
  await fs.writeFile(path.join(f.directory, 'keep.txt'), 'previous runtime');
  await fs.appendFile(f.archive, 'tampered');
  await assert.rejects(packageNodeRuntime(f), /integrity mismatch/);
  assert.equal(await fs.readFile(path.join(f.directory, 'keep.txt'), 'utf8'), 'previous runtime');
  assert.deepEqual(await fs.readdir(path.dirname(f.directory)), ['node']);
});

test('Node packaging refuses an architecture mismatch before creating output', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.lockFile, JSON.stringify({...f.lock, arch: process.arch === 'x64' ? 'arm64' : 'x64'}));
  await assert.rejects(packageNodeRuntime(f), /No pinned standalone Node/);
  await assert.rejects(fs.stat(f.application), {code: 'ENOENT'});
});

test('Multi-platform Node locks refuse an absent host without using a foreign runtime', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.lockFile, JSON.stringify({schema: 2, version: 'fixture', platforms: {foreign: f.lock}}));
  await assert.rejects(packageNodeRuntime(f), /No pinned standalone Node/);
  await assert.rejects(fs.stat(f.application), {code: 'ENOENT'});
});

test('Multi-platform Node locks validate the selected entry platform before creating output', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.lockFile, JSON.stringify({schema: 2, version: 'fixture', platforms: {
    [`${process.platform}-${process.arch}`]: {...f.lock, platform: 'foreign'},
  }}));
  await assert.rejects(packageNodeRuntime(f), /No pinned standalone Node/);
  await assert.rejects(fs.stat(f.application), {code: 'ENOENT'});
});

test('Node packaging refuses an existing destination and preserves its exact contents', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, {recursive: true});
  await fs.writeFile(path.join(f.directory, 'keep.txt'), 'previous runtime');
  await assert.rejects(packageNodeRuntime(f), {code: 'EEXIST'});
  assert.deepEqual(await fs.readdir(f.directory), ['keep.txt']);
  assert.equal(await fs.readFile(path.join(f.directory, 'keep.txt'), 'utf8'), 'previous runtime');
});

// These exercise the real host ZIP extractor. Synthetic bytes only test
// packaging; the official node.exe execution is a separate native evidence run.
test('Windows Node ZIP publishes the locked layout and a digest of the extracted executable', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t, [['node-fixture/node.exe', 'synthetic executable'], ['node-fixture/LICENSE', 'synthetic license']]);
  const {schema, version, ...entry} = f.lock;
  await fs.writeFile(f.lockFile, JSON.stringify({schema: 2, version, platforms: {[`${process.platform}-${process.arch}`]: entry}}));
  const result = await packageNodeRuntime(f);
  assert.equal(result.directory, f.directory);
  const manifest = JSON.parse(await fs.readFile(path.join(f.directory, 'NODE-RUNTIME.json'), 'utf8'));
  assert.equal(manifest.sha256Archive, f.lock.sha256Archive);
  assert.equal(manifest.sha256Executable, createHash('sha256').update('synthetic executable').digest('hex'));
  assert.equal(manifest.executable, 'node.exe');
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.version, version);
  assert.equal(manifest.platform, process.platform);
  assert.equal(await fs.readFile(path.join(f.directory, 'LICENSE'), 'utf8'), 'synthetic license');
  assert.deepEqual(await fs.readdir(path.dirname(f.directory)), ['node']);
});

for (const [reason, entries, message] of [
  ['wrong prefix', [['another-node/node.exe', 'x']], /Unsafe standalone Node ZIP entry/],
  ['traversal', [['node-fixture/../../escape.txt', 'x']], /Unsafe standalone Node ZIP entry/],
  ['alternate stream', [['node-fixture/node.exe:payload', 'x']], /Unsafe standalone Node ZIP entry/],
  ['backslash', [['node-fixture/sub\\escape.txt', 'x']], /Unsafe standalone Node ZIP entry/],
  ['symlink', [['node-fixture/node.exe', 'outside', {unixPermissions: 0o120777}]], /contains a symlink/],
  ['missing executable', [['node-fixture/LICENSE', 'x']], /missing or not a regular file/],
]) {
  test(`Windows Node ZIP rejects ${reason} and removes only its own staging`, {skip: process.platform !== 'win32'}, async t => {
    const f = await fixture(t, entries);
    await fs.mkdir(path.join(f.application, 'runtime'), {recursive: true});
    await fs.writeFile(path.join(f.application, 'runtime', 'unrelated.txt'), 'keep');
    await assert.rejects(packageNodeRuntime(f), message);
    assert.deepEqual(await fs.readdir(path.dirname(f.directory)), ['unrelated.txt']);
    assert.equal(await fs.readFile(path.join(f.application, 'runtime', 'unrelated.txt'), 'utf8'), 'keep');
    await assert.rejects(fs.stat(path.join(f.root, 'escape.txt')), {code: 'ENOENT'});
  });
}
