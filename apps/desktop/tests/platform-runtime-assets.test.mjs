import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  assertBundledExecutable, assertExecutableAccess, manifestExecutable, runtimeExecutableName, sha256File, validateRuntimeManifest,
} from '../src/platform/shared/runtime-assets.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-runtime-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('assertBundledExecutable rejects non-files and missing assets with the caller violation', async t => {
  const root = await fixture(t);
  const real = path.join(root, 'node');
  await fs.writeFile(real, '#!/bin/sh\n', { mode: 0o755 });
  const violation = file => Object.assign(new Error('private asset broken: ' + file), { code: 'ASSET_BROKEN' });
  await assert.equal(await assertBundledExecutable(real, { violation }), real);
  await assert.rejects(assertBundledExecutable(path.join(root, 'absent'), { violation }), error => error.code === 'ASSET_BROKEN');
  await assert.rejects(assertBundledExecutable(root, { violation }), error => error.code === 'ASSET_BROKEN');
});

test('assertBundledExecutable rejects file symlinks when the host permits creating them', async t => {
  const root = await fixture(t), real = path.join(root, 'node'), link = path.join(root, 'node-link');
  await fs.writeFile(real, 'synthetic executable', { mode: 0o755 });
  try { await fs.symlink(real, link, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows file-symlink creation requires a privilege unavailable to this ordinary-user test; junction coverage is separate');
    throw error;
  }
  await assert.rejects(assertBundledExecutable(link), /missing or not a regular file/);
});

test('assertBundledExecutable rejects a native Windows junction without elevated privileges', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), target = path.join(root, 'target'), link = path.join(root, 'junction');
  await fs.mkdir(target);
  await fs.symlink(target, link, 'junction');
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  await assert.rejects(assertBundledExecutable(link), /missing or not a regular file/);
});

test('assertBundledExecutable follow mode surfaces transport errors and keeps relocatable semantics', async t => {
  const root = await fixture(t);
  const executable = path.join(root, 'git');
  await fs.writeFile(executable, 'git-bytes', { mode: 0o755 });
  const violation = file => Error('Bundled Git executable is not a file: ' + file);
  await assertBundledExecutable(executable, { follow: true, violation, access: false });
  await assert.rejects(assertBundledExecutable(path.join(root, 'missing'), { follow: true, violation }), error => error.code === 'ENOENT');
  await assert.rejects(assertBundledExecutable(root, { follow: true, violation }), error => error.message === 'Bundled Git executable is not a file: ' + root);
});

test('executable access exercises the host permission model without emulating POSIX on Windows', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'tool');
  await fs.writeFile(file, 'x', { mode: 0o644 });
  if (process.platform === 'win32') await assertExecutableAccess(file);
  else {
    await assert.rejects(assertExecutableAccess(file), error => error.code === 'EACCES');
    await fs.chmod(file, 0o755);
    await assertExecutableAccess(file);
  }
  await assert.rejects(assertExecutableAccess(path.join(root, 'absent')), error => error.code === 'ENOENT');
});

test('bundled executable naming is per-platform and manifest-declared names win', () => {
  assert.equal(runtimeExecutableName('win32'), 'node.exe');
  assert.equal(runtimeExecutableName('linux'), 'bin/node');
  assert.equal(runtimeExecutableName('darwin'), 'bin/node');
  assert.equal(runtimeExecutableName('win32', { win32: 'git.exe', posix: 'bin/git' }), 'git.exe');
  assert.equal(manifestExecutable({}, 'win32'), 'node.exe');
  assert.equal(manifestExecutable({ executable: 'custom/node.exe' }, 'linux'), 'custom/node.exe');
});

test('runtime manifests must match schema, platform and arch exactly', () => {
  const rejection = () => Error('Bundled Node runtime platform mismatch');
  const manifest = { schema: 1, platform: 'linux', arch: 'x64' };
  assert.equal(validateRuntimeManifest(manifest, { platform: 'linux', arch: 'x64', rejection }), manifest);
  assert.throws(() => validateRuntimeManifest({ ...manifest, platform: 'win32' }, { platform: 'linux', arch: 'x64', rejection }), /platform mismatch/);
  assert.throws(() => validateRuntimeManifest({ ...manifest, schema: 2 }, { platform: 'linux', arch: 'x64', rejection }), /platform mismatch/);
  assert.throws(() => validateRuntimeManifest({ ...manifest, arch: 'arm64' }, { platform: 'linux', arch: 'x64', rejection }), /platform mismatch/);
  assert.throws(() => validateRuntimeManifest(null, { rejection }), /platform mismatch/);
});

test('sha256File streams the same digest as a one-shot hash', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'payload.bin');
  const bytes = Buffer.alloc(1024 * 1024 + 7);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  await fs.writeFile(file, bytes);
  assert.equal(await sha256File(file), createHash('sha256').update(bytes).digest('hex'));
});
