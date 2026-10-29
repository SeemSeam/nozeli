import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultApp = fileURLToPath(new URL('../', import.meta.url));
const app = await fs.realpath(process.env.NOZELI_SAVE_APP || defaultApp);
const { DesktopHost } = await import(pathToFileURL(path.join(app, 'src/main/host.mjs')));

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-user-save-feedback-'));
  const project = path.join(root, 'project'), profile = path.join(root, 'profile');
  await fs.mkdir(project);
  const file = path.join(project, 'text.txt');
  await fs.writeFile(file, 'original');
  const host = new DesktopHost(profile);
  const id = (await host.pick(project)).project.id;
  const read = await host.readFile(id, 'text.txt');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { project, file, host, id, read };
}

async function rejectSave(f, text) {
  let error;
  await assert.rejects(f.host.save(f.id, 'text.txt', f.read.digest, text), failure => {
    error = failure;
    return true;
  });
  return error;
}

test('directory permission failure retains original and candidate; retry saves after permissions recover', async t => {
  // Real POSIX directory-denial coverage, not a Windows ACL or privileged-user claim.
  assert.ok(['linux','darwin'].includes(process.platform), 'This real chmod scenario requires a tested POSIX platform; unsupported platforms are not a passing skip.');
  assert.notEqual(process.getuid(), 0, 'This real chmod scenario requires a non-root user.');
  const f = await setup(t);
  await fs.chmod(f.project, 0o555);
  let error;
  try {
    error = await rejectSave(f, 'permission candidate');
  } finally {
    await fs.chmod(f.project, 0o755);
  }
  assert.equal(error.code, 'ACCESS_DENIED');
  assert(['EACCES', 'EPERM'].includes(error.details.cause));
  assert.equal(error.details.draftKept, true);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'original');
  assert.equal((await f.host.readDraftRecord(f.id, 'text.txt')).text, 'permission candidate');

  const saved = await f.host.save(f.id, 'text.txt', f.read.digest, 'permission candidate');
  assert.equal((await f.host.readFile(f.id, 'text.txt')).digest, saved.digest);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'permission candidate');
});

test('deleted source stays absent until explicit confirmed recovery writes the retained candidate', async t => {
  const f = await setup(t);
  await fs.unlink(f.file);
  const error = await rejectSave(f, 'deleted candidate');
  assert.equal(error.code, 'DELETED');
  assert.equal(error.details.diskPresent, false);
  assert.equal(error.details.diskDigest, null);
  assert.equal(error.details.draftKept, true);
  await assert.rejects(fs.access(f.file), failure => failure.code === 'ENOENT');
  assert.equal((await f.host.readDraftRecord(f.id, 'text.txt')).text, 'deleted candidate');

  const saved = await f.host.save(f.id, 'text.txt', f.read.digest, 'deleted candidate', { confirmOverwrite: true });
  assert.equal(await fs.readFile(f.file, 'utf8'), 'deleted candidate');
  assert.equal((await f.host.readFile(f.id, 'text.txt')).digest, saved.digest);
});

test('external modification after actual replacement remains CONFLICT and retains the candidate', async t => {
  const f = await setup(t), replace = f.host.replaceFile.bind(f.host);
  let replacementObserved = null;
  // Deterministic external-write boundary after real rename; no mocked save receipt.
  f.host.replaceFile = async (...args) => {
    await replace(...args);
    replacementObserved = await fs.readFile(f.file, 'utf8');
    await fs.writeFile(f.file, 'external after actual replacement');
  };
  const error = await rejectSave(f, 'replaced candidate');
  assert.equal(replacementObserved, 'replaced candidate');
  assert.equal(error.code, 'CONFLICT');
  assert(error.details.cause);
  assert.equal(error.details.draftKept, true);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'external after actual replacement');
  assert.equal((await f.host.readDraftRecord(f.id, 'text.txt')).text, 'replaced candidate');
});
