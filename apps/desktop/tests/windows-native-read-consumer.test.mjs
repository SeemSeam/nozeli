import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createFileStream} from '../src/agents/managed/file-stream.mjs';
import {blobFile,blobFiles,blobDigest,git} from '../src/agents/managed/git-service.mjs';
import {openExperimentalAnchoredRead as open} from '../src/platform/windows/experimental-read.mjs';
import {experimentalWindowsReadFilesystem as filesystem} from '../src/platform/windows/experimental-filesystem.mjs';
import {selectFilesystemAdapter} from '../src/platform/shared/filesystem.mjs';

const native = {skip:process.platform !== 'win32' || process.arch !== 'x64'};
const boundary = createFileStream({filesystem});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const collect = async stream => {const chunks=[]; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks);};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-native-consumer-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  await fs.mkdir(path.join(root, '中文 空格'));
  return root;
}
function mutate(operation, ...args) {
  const result = spawnSync(process.execPath, ['-e', `try {require('node:fs')[process.argv[1]](...process.argv.slice(2));}
    catch(error) {console.log(error.code); process.exitCode=7;}`, operation, ...args],
    {encoding:'utf8', timeout:10000, windowsHide:true});
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  return result;
}

test('native read facts and absolute offsets come from the retained file and reject invalid calls', native, async t => {
  const root = await fixture(t), file = path.join(root, 'data.bin');
  await fs.writeFile(file, '0123456789');
  const pin = open(root, 'data.bin');
  try {
    const facts = pin.stat();
    assert.equal(facts.size, 10n); assert.equal(facts.nlink, 1n);
    assert.equal(typeof facts.attributes, 'number');
    assert.equal(pin.readAt(5, 3).toString(), '567');
    assert.equal(pin.readAt(0, 4).toString(), '0123');
    assert.equal(pin.readAt(9, 4).toString(), '9');
    assert.equal(pin.readAt(10, 4).length, 0);
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', 1n])
      assert.throws(() => pin.readAt(offset, 1), {code:'FS_READ_LIMIT'});
    for (const size of [0, -1, 0.5, NaN, Infinity, 1048577, '1'])
      assert.throws(() => pin.readAt(0, size), {code:'FS_READ_LIMIT'});
    assert.throws(() => pin.readAt(0), {code:'FS_READ_LIMIT'});
    for (const method of ['readAt', 'stat'])
      assert.throws(() => pin[method].call({}, 0, 1), {code:'FS_HANDLE_REJECTED'});
  } finally {pin.close();}
  assert.throws(() => pin.stat(), {code:'FS_HANDLE_CLOSED'});
  assert.throws(() => pin.readAt(0, 1), {code:'FS_HANDLE_CLOSED'});
  await fs.writeFile(file, 'released');
});

test('shared file reader preserves Unicode, binary bytes and concurrent stream cursors', native, async t => {
  const root = await fixture(t), relative = '中文 空格/正文.bin';
  const bytes = Buffer.concat([Buffer.from('中文\r\n\0'), Buffer.alloc(600000, 0xa5)]);
  await fs.writeFile(path.join(root, relative), bytes);
  assert.deepEqual(await boundary.inspectFile(root, relative), {digest:sha(bytes),size:bytes.length,mode:'100644'});
  assert.deepEqual((await boundary.readSafeBytes(root, relative)).bytes, bytes);
  await boundary.withSafeFile(root, relative, async file => {
    assert.equal(file.fdSourcePath, undefined);
    const [a,b] = await Promise.all([collect(file.stream()), collect(file.stream())]);
    assert.deepEqual(a, bytes); assert.deepEqual(b, bytes);
    assert.deepEqual(await collect(file.stream()), bytes);
  });
  await fs.writeFile(path.join(root, relative), 'after close');
});

test('shared reader maps only missing entries to null and refuses junction, directory and hard-link entries', native, async t => {
  const root = await fixture(t);
  assert.equal(await boundary.safeBytes(root, 'missing'), null);
  assert.equal(await boundary.safeBytes(root, 'missing/child'), null);
  assert.equal(await boundary.safeBytes(path.join(root, 'absent-root'), 'child'), null);
  await fs.writeFile(path.join(root, '中文 空格', 'file'), 'sentinel');
  await fs.symlink(path.join(root, '中文 空格'), path.join(root, 'junction'), 'junction');
  await assert.rejects(boundary.safeBytes(root, 'junction/file'), {code:'FS_REPARSE_REJECTED'});
  await assert.rejects(boundary.safeBytes(root, '中文 空格'), {code:'WIN32_IO_ERROR'});
  await fs.link(path.join(root, '中文 空格', 'file'), path.join(root, 'alias'));
  await assert.rejects(boundary.safeBytes(root, 'alias'), {code:'FS_ENTRY_REJECTED'});
  await fs.unlink(path.join(root, 'alias'));
  assert.equal((await boundary.safeBytes(root, '中文 空格/file')).toString(), 'sentinel');
});

test('shared text limits, callback errors and partial stream consumption release all native guards', native, async t => {
  const root = await fixture(t), file = path.join(root, 'data');
  await fs.writeFile(file, Buffer.alloc(600000, 3));
  await assert.rejects(boundary.readSafeBytes(root, 'data', {maxBytes:10}), {code:'TEXT_LIMIT'});
  await fs.writeFile(file, Buffer.alloc(600000, 4));
  await assert.rejects(boundary.withSafeFile(root, 'data', async pinned => {
    for await (const chunk of pinned.stream()) {assert.ok(chunk.length); break;}
    throw Object.assign(new Error('synthetic consumer stopped'), {code:'CONSUMER_STOPPED'});
  }), {code:'CONSUMER_STOPPED'});
  await fs.writeFile(file, 'released after error');
  await boundary.withSafeFile(root, 'data', async pinned => {
    for await (const chunk of pinned.stream()) {assert.ok(chunk.length); break;}
  });
  await fs.rename(file, path.join(root, 'released'));
});

test('shared read keeps ancestor and file guards during the consumer, then releases them', native, async t => {
  const root = await fixture(t), relative = '中文 空格/file', file = path.join(root, relative);
  await fs.writeFile(file, 'pinned');
  await boundary.withSafeFile(root, relative, async pinned => {
    for (const [operation,...args] of [
      ['writeFileSync', file, 'racer'],
      ['renameSync', file, path.join(root, 'moved-file')],
      ['renameSync', path.dirname(file), path.join(root, 'moved-dir')],
    ]) {
      const result = mutate(operation, ...args);
      assert.equal(result.status, 7);
      assert.match(result.stdout.trim(), /^(?:EPERM|EACCES|EBUSY)$/);
    }
    assert.equal((await collect(pinned.stream())).toString(), 'pinned');
  });
  assert.equal(mutate('writeFileSync', file, 'after close').status, 0);
  await fs.rename(path.dirname(file), path.join(root, 'released-dir'));
});

test('post-consumption hard-link change rejects the shared result and releases retained handles', native, async t => {
  const root = await fixture(t), file = path.join(root, 'data'), alias = path.join(root, 'alias');
  await fs.writeFile(file, 'sentinel');
  await assert.rejects(boundary.withSafeFile(root, 'data', async pinned => {
    assert.equal((await collect(pinned.stream())).toString(), 'sentinel');
    assert.equal(mutate('linkSync', file, alias).status, 0);
    return 'must never return';
  }), {code:'SOURCE_CHANGED'});
  assert.equal(await fs.readFile(file, 'utf8'), 'sentinel');
  await fs.unlink(alias);
  await fs.writeFile(file, 'released');
});

test('shared Git capture streams HANDLE bytes into actual SHA-1 and SHA-256 objects without changing refs', native, async t => {
  const root = await fixture(t), bytes = Buffer.from('exact 中文\r\n\0\xff', 'utf8');
  for (const format of ['sha1', 'sha256']) {
    const repo = path.join(root, format); await fs.mkdir(repo);
    await git(repo, ['init', '--initial-branch=synthetic', '--object-format=' + format]);
    await fs.writeFile(path.join(repo, '中文 空格.bin'), bytes);
    await fs.writeFile(path.join(repo, 'empty'), '');
    const result = await blobFiles(repo, repo, ['中文 空格.bin','empty'], new Map(), format, {filesystem});
    for (const [relative,data] of [['中文 空格.bin',bytes], ['empty',Buffer.alloc(0)]]) {
      const row = result.get(relative);
      assert.equal(row.oid, createHash(format).update('blob ' + data.length + '\0').update(data).digest('hex'));
      assert.equal(row.digest, sha(data)); assert.equal(row.size, data.length); assert.equal(row.mode, '100644');
      assert.deepEqual(await git(repo, ['cat-file','blob',row.oid]), data);
    }
    assert.equal((await git(repo, ['for-each-ref'])).length, 0);
  }
});

test('33 MiB binary capture reaches shared Git while bounded document reads refuse it', native, async t => {
  const root = await fixture(t); await git(root, ['init','--initial-branch=synthetic']);
  const file = await fs.open(path.join(root, 'large.bin'), 'wx'), chunk = Buffer.alloc(1024*1024, 0xa5);
  const digest = createHash('sha256');
  try {for (let i=0;i<33;i++) {await file.writeFile(chunk); digest.update(chunk);}} finally {await file.close();}
  const row = await blobFile(root, root, 'large.bin', {filesystem});
  assert.equal(row.size, 33*1024*1024); assert.equal(row.digest, digest.digest('hex'));
  assert.equal(await blobDigest(root, row.oid), row.digest);
  await assert.rejects(boundary.readSafeBytes(root, 'large.bin'), {code:'TEXT_LIMIT'});
  await fs.rename(path.join(root, 'large.bin'), path.join(root, 'released.bin'));
});

test('known Git object capture hashes once and missing files remain explicit null entries', native, async t => {
  const root = await fixture(t); await git(root, ['init','--initial-branch=synthetic']);
  await fs.writeFile(path.join(root, 'data'), 'known bytes');
  const first = await blobFile(root, root, 'data', {filesystem});
  let streams = 0;
  const counting = {...filesystem, async openAnchoredFile(...args) {
    const file = await filesystem.openAnchoredFile(...args);
    return file && {...file, stream:() => {streams++; return file.stream();}};
  }};
  const rows = await blobFiles(root, root, ['data','missing'], new Map([['data',['100644','blob',first.oid]]]), 'sha1', {filesystem:counting});
  assert.equal(streams, 1); assert.deepEqual(rows.get('data'), first); assert.equal(rows.get('missing'), null);
});

test('Git stream error or mismatching bytes reject capture and release all guards; production stays disabled', native, async t => {
  const root = await fixture(t); await git(root, ['init','--initial-branch=synthetic']);
  for (const fault of ['error','mismatch']) {
    const target = path.join(root, fault); await fs.writeFile(target, 'source bytes');
    const injected = {...filesystem, async openAnchoredFile(...args) {
      const file = await filesystem.openAnchoredFile(...args); let streams=0;
      return {...file, stream:() => {
        if (++streams === 1) return file.stream();
        return Readable.from((async function* () {
          if (fault === 'error') throw Object.assign(new Error('synthetic transport fault'), {code:'READ_FAULT'});
          yield Buffer.from('different bytes');
        })());
      }};
    }};
    await assert.rejects(blobFile(root, root, fault, {filesystem:injected}), {code:fault==='error'?'READ_FAULT':'SOURCE_CHANGED'});
    assert.equal(await fs.readFile(target, 'utf8'), 'source bytes');
    await fs.writeFile(target, 'released');
  }
  assert.equal((await git(root, ['for-each-ref'])).length, 0);
  assert.equal(selectFilesystemAdapter().supported, false);
  await assert.rejects(blobFile(root, root, 'error'), {code:'FS_PLATFORM_UNSUPPORTED'});
  await assert.rejects(boundary.openWriteParent(root, 'new'), {code:'FS_PLATFORM_UNSUPPORTED'});
});
