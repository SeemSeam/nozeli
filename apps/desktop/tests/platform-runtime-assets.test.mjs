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

test('assertBundledExecutable rejects links, specials and missing assets with the caller violation', async t => {
  const root = await fixture(t);
  const real = path.join(root, 'node');
  const link = path.join(root, 'node-link');
  await fs.writeFile(real, '#!/bin/sh\n', { mode: 0o755 });
  await fs.symlink(real, link);
  const violation = file => Object.assign(new Error('private asset broken: ' + file), { code: 'ASSET_BROKEN' });
  await assert.equal(await assertBundledExecutable(real, { violation }), real);
  await assert.rejects(assertBundledExecutable(link, { violation }), error => error.code === 'ASSET_BROKEN' && error.message.endsWith('node-link'));
  await assert.rejects(assertBundledExecutable(path.join(root, 'absent'), { violation }), error => error.code === 'ASSET_BROKEN');
  await assert.rejects(assertBundledExecutable(root, { violation }), error => error.code === 'ASSET_BROKEN');
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

test('executable access follows the per-platform rule: F_OK on Windows, X_OK elsewhere', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'tool');
  await fs.writeFile(file, 'x', { mode: 0o644 });
  await assertExecutableAccess(file, { platform: 'win32' });
  await assert.rejects(assertExecutableAccess(file, { platform: 'linux' }), error => error.code === 'EACCES');
  await fs.chmod(file, 0o755);
  await assertExecutableAccess(file, { platform: 'linux' });
  await assertExecutableAccess(file, { platform: 'darwin' });
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
