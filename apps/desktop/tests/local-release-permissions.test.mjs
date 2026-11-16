import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {normalizeReleaseModes} from '../tools/local-release.mjs';
import {extractPackage} from '../src/main/auto-update-files.mjs';

const version = '1.0.1', commit = 'a'.repeat(40);
const label = `Nozeli-${version}-linux-x64`;
const mode = async file => (await fs.stat(file)).mode & 0o7777;

test('copied CI sandbox and all payload special modes are removed without changing originals', {skip: process.platform !== 'linux' || process.arch !== 'x64'}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-release-permissions-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), release = path.join(root, label);
  const app = 'resources/app';
  await fs.mkdir(path.join(source, app, 'src/main'), {recursive: true});
  await fs.mkdir(path.join(source, app, 'dist/renderer'), {recursive: true});
  await fs.mkdir(path.join(source, app, 'node_modules/special'), {recursive: true});
  const metadata = {application: 'Nozeli', version, platform: 'linux', arch: 'x64', state: 'validated', format: 'portable-tar.gz', commit};
  for (const file of ['INSTALLATION.json', 'RELEASE.json']) await fs.writeFile(path.join(source, file), JSON.stringify(metadata));
  await fs.writeFile(path.join(source, app, 'package.json'), JSON.stringify({name: 'nozeli-desktop', version, main: 'src/main/main.cjs'}));
  for (const file of ['src/main/main.cjs', 'src/main/auto-update-helper.mjs', 'src/main/auto-update-extract.mjs', 'dist/renderer/app.js']) await fs.writeFile(path.join(source, app, file), '');
  // Real filesystem modes, not a mocked stat or a tar header with fabricated bits.
  const files = new Map([
    ['chrome-sandbox', 0o4755],
    [`${app}/node_modules/special/helper`, 0o2755],
    [`${app}/dist/renderer/read-only`, 0o4640],
    ['AppRun', 0o755],
  ]);
  for (const [file, bits] of files) {
    await fs.writeFile(path.join(source, file), 'fixture');
    await fs.chmod(path.join(source, file), bits);
  }
  const elf = Buffer.alloc(20); elf.write('7f454c46', 0, 'hex'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
  await fs.writeFile(path.join(source, 'nozeli'), elf, {mode: 0o755});
  const specialDirectory = path.join(app, 'node_modules/special');
  await fs.chmod(path.join(source, specialDirectory), 0o3755);
  const outside = path.join(root, 'host-helper');
  await fs.writeFile(outside, 'must not chmod through a symlink');
  await fs.chmod(outside, 0o4755);
  await fs.symlink(outside, path.join(source, 'external-link'));
  await fs.symlink('chrome-sandbox', path.join(source, 'sandbox-link'));
  await fs.cp(source, release, {recursive: true, verbatimSymlinks: true});
  assert.equal(await mode(path.join(release, 'chrome-sandbox')), 0o4755);
  await normalizeReleaseModes(release);
  for (const [file, bits] of files) {
    assert.equal(await mode(path.join(source, file)), bits, `source ${file} unchanged`);
    assert.equal(await mode(path.join(release, file)), bits & 0o777, `copy ${file} normalized`);
  }
  assert.equal(await mode(path.join(source, specialDirectory)), 0o3755);
  assert.equal(await mode(path.join(release, specialDirectory)), 0o755);
  assert.equal(await mode(outside), 0o4755);
  assert.equal(await fs.readlink(path.join(release, 'sandbox-link')), 'chrome-sandbox');
  // The escaping link is intentionally only a chmod boundary probe, never a
  // distributable payload. The unchanged updater still rejects escaping links.
  await fs.unlink(path.join(release, 'external-link'));
  await normalizeReleaseModes(release); // Idempotent; executable/read-only bits survive.
  const archive = path.join(root, 'release.tar.gz');
  // Match package-portable's real tar invocation, including its stored modes.
  execFileSync('tar', ['-czf', archive, '-C', root, label]);
  const extracted = await extractPackage(archive, path.join(root, 'stage'), version, undefined, commit);
  assert.equal((await mode(path.join(extracted, 'chrome-sandbox'))) & 0o7000, 0);
  assert.equal((await mode(path.join(extracted, 'chrome-sandbox'))) & 0o100, 0o100);
  assert.equal((await mode(path.join(extracted, app, 'node_modules/special/helper'))) & 0o7000, 0);
  assert.equal((await mode(path.join(extracted, app, 'node_modules/special/helper'))) & 0o100, 0o100);
  for (const bits of [0o4755, 0o2755]) {
    await fs.chmod(path.join(release, 'chrome-sandbox'), bits);
    execFileSync('tar', ['-czf', archive, '-C', root, label]);
    const rejected = path.join(root, `rejected-${bits}`);
    await assert.rejects(extractPackage(archive, rejected, version, undefined, commit), /Unsafe archive entry type\/mode/);
    await assert.rejects(fs.access(rejected), {code: 'ENOENT'});
  }
});
