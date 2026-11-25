import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openExperimentalPersistenceParent as open, createExperimentalWindowsPersistence as create} from '../src/platform/windows/experimental-persistence.mjs';
import {openExperimentalWriteParent} from '../src/platform/windows/experimental-write.mjs';
import {createPersistenceAdapter} from '../src/platform/shared/persistence.mjs';
import {security} from './fixtures/windows-security.mjs';

const native = {skip:process.platform !== 'win32' || process.arch !== 'x64'};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-native-persistence-'));
  const parents = [], stages = [];
  t.after(async () => {
    for (const stage of stages) stage.close();
    for (const parent of parents) parent.close();
    await fs.rm(root, {recursive:true, force:true});
  });
  return {root, file:relative => path.join(root, relative),
    parent(relative = 'target') {const p = open(root, relative);parents.push(p);return p;},
    stage(parent) {const s = parent.createPrivateExclusive('owned.pending');stages.push(s);return s;},
  };
}
function competitor(operation, ...args) {
  const child = spawnSync(process.execPath, ['-e', `try {require('node:fs')[process.argv[1]](...process.argv.slice(2));
    console.log('ok');}catch(e){console.log(e.code);process.exitCode=7;}`, operation, ...args], {
    encoding:'utf8', windowsHide:true, timeout:10000,
  });
  assert.ifError(child.error);assert.equal(child.signal, null);assert.equal(child.stderr, '');
  return {status:child.status, output:child.stdout.trim()};
}

test('directory flush uses the existing pinned writable parent and close releases directory guards', native, async t => {
  const f = await fixture(t), parent = f.parent();
  parent.syncDirectory();
  const blocked = competitor('renameSync', f.root, f.root + '-moved');
  assert.equal(blocked.status, 7);
  assert.match(blocked.output, /^(EPERM|EACCES|EBUSY)$/);
  const stage = f.stage(parent);stage.write(Buffer.from('synthetic'));stage.sync();stage.publishNew('target');
  parent.syncDirectory();stage.close();parent.close();parent.close();
  assert.throws(() => parent.syncDirectory(), {code:'FS_HANDLE_CLOSED'});
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'synthetic');
  await fs.rename(f.root, f.root + '-moved');await fs.rename(f.root + '-moved', f.root);
});

test('ordinary parent cannot silently gain flush rights while an explicit flush pin can coexist', native, async t => {
  const f = await fixture(t), ordinary = openExperimentalWriteParent(f.root, 'target');
  try {
    assert.throws(() => ordinary.syncDirectory(), {code:'FS_DIRECTORY_SYNC_UNSUPPORTED'});
    const flushParent = f.parent();flushParent.syncDirectory();flushParent.close();
  } finally {ordinary.close();}
  const parent = f.parent();parent.syncDirectory();parent.close();
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('missing parents and reparse ancestry fail before directory creation or staging', native, async t => {
  const f = await fixture(t);
  assert.throws(() => f.parent('missing/deep/target'), e => e.code === 'WIN32_IO_ERROR' && [2, 3].includes(e.win32Code));
  assert.deepEqual(await fs.readdir(f.root), []);
  await fs.mkdir(f.file('outside'));
  await fs.symlink(f.file('outside'), f.file('junction'), 'junction');
  assert.throws(() => f.parent('junction/target'), {code:'FS_REPARSE_REJECTED'});
  assert.deepEqual(await fs.readdir(f.file('outside')), []);
  assert.throws(() => open(path.parse(f.root).root, 'target'), {code:'FS_VOLUME_UNSUPPORTED'});
});

test('create-only publication completes file and directory flushes with a private published file', native, async t => {
  const f = await fixture(t), adapter = create(f.root);
  const result = await adapter.writeAtomic('正文 空格.txt', 'synthetic 中文');
  assert.deepEqual(result, {schema:1, platform:'win32', state:'barriers-completed', published:true,
    durability:'namespace-not-qualified', barriers:{file:'flushed', directory:'flushed'}});
  assert.equal(adapter.supported, false);
  assert.equal(await fs.readFile(f.file('正文 空格.txt'), 'utf8'), 'synthetic 中文');
  assert.deepEqual(await fs.readdir(f.root), ['正文 空格.txt']);
  const policy = security('inspect', f.file('正文 空格.txt'));
  assert.equal(policy.protected, true);assert.equal(policy.owner, policy.currentSid);
  assert.ok(policy.rules.every(rule => rule.sid === policy.currentSid && rule.type === 'Allow'));
});

test('existing version replacement flushes the pinned directory and preserves permissions without stale retries', native, async t => {
  const f = await fixture(t), adapter = create(f.root);
  await adapter.writeAtomic('target', 'original');
  const policy = security('inspect', f.file('target')).sddl;
  await adapter.writeAtomic('target', Buffer.from('candidate'), {expectedSha256:digest('original')});
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'candidate');
  assert.equal(security('inspect', f.file('target')).sddl, policy);
  await assert.rejects(adapter.writeAtomic('target', 'stale', {expectedSha256:digest('original')}), e =>
    e.code === 'FS_VERSION_CONFLICT' && !e.committed && e.actualSha256 === digest('candidate'));
  await assert.rejects(adapter.writeAtomic('target', 'clobber'), {code:'FS_TARGET_EXISTS'});
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'candidate');
  assert.deepEqual(await fs.readdir(f.root), ['target']);
});

test('post-publication real closed-handle barrier failure reports committed/uncertain and retains new bytes', native, async t => {
  const f = await fixture(t);
  let barriers = 0;
  const adapter = create(f.root, {directorySync:parent => {
    barriers++;parent.close();parent.syncDirectory();
  }});
  for (const [bytes, expectedSha256] of [['first', null], ['second', digest('first')]]) {
    await assert.rejects(adapter.writeAtomic('target', bytes, {expectedSha256}), e =>
      e.code === 'FS_HANDLE_CLOSED' && e.committed === true && e.durability === 'uncertain');
    assert.equal(await fs.readFile(f.file('target'), 'utf8'), bytes);
    assert.deepEqual(await fs.readdir(f.root), ['target']);
  }
  assert.equal(barriers, 2, 'Unknown durability must never trigger automatic replay');
});

test('unpublished conflicts never invoke the directory barrier or alter an external winner or recovery draft', native, async t => {
  const f = await fixture(t);let barriers = 0;
  const adapter = create(f.root, {directorySync:parent => {barriers++;parent.syncDirectory();}});
  await fs.writeFile(f.file('target'), 'outside');
  await fs.writeFile(f.file('draft.recovery'), 'candidate');
  await assert.rejects(adapter.writeAtomic('target', 'candidate'), {code:'FS_TARGET_EXISTS'});
  await assert.rejects(adapter.writeAtomic('target', 'candidate', {expectedSha256:digest('old')}), {code:'FS_VERSION_CONFLICT'});
  assert.equal(barriers, 0);
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'outside');
  assert.equal(await fs.readFile(f.file('draft.recovery'), 'utf8'), 'candidate');
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['draft.recovery', 'target']);
});

test('invalid input and unsafe relative paths fail before namespace effects', native, async t => {
  const f = await fixture(t), adapter = create(f.root);
  for (const bytes of [3, new Uint16Array(2), new DataView(new ArrayBuffer(4)),
      new Uint8Array(new SharedArrayBuffer(4)), Buffer.alloc(1048577)])
    await assert.rejects(adapter.writeAtomic('target', bytes), {code:'FS_WRITE_LIMIT'});
  await assert.rejects(adapter.writeAtomic('target', 'x', {expectedSha256:'bad'}), {code:'FS_VERSION_REJECTED'});
  for (const relative of ['', '../outside', '/absolute', 'a//b', 'x:stream', 'a\\b'])
    await assert.rejects(adapter.writeAtomic(relative, 'x'), {code:'FS_PATH_REJECTED'});
  const parent = f.parent();
  assert.throws(() => parent.syncDirectory.call({}), {code:'FS_HANDLE_REJECTED'});parent.close();
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('persistence directory pins support Unicode paths beyond MAX_PATH without creating missing ancestors', native, async t => {
  const f = await fixture(t);
  const directories = Array.from({length:4}, (_, i) => `中文-${i}-` + 'x'.repeat(70)).join('/');
  await fs.mkdir(f.file(directories), {recursive:true});
  assert.ok(f.file(directories).length > 260);
  await create(f.root).writeAtomic(directories + '/target', 'long synthetic');
  assert.equal(await fs.readFile(f.file(directories + '/target'), 'utf8'), 'long synthetic');
});

test('production shared persistence remains rejected before touching files despite experimental barrier success', native, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file('target'), 'original');
  const shared = createPersistenceAdapter();
  assert.equal(shared.capabilities.durableAtomicReplace, false);
  await assert.rejects(shared.writeAtomic(f.file('target'), 'unsafe'), {code:'PERSISTENCE_UNSUPPORTED'});
  await assert.rejects(shared.syncDirectory(f.root), {code:'PERSISTENCE_UNSUPPORTED'});
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(f.root), ['target']);
});
