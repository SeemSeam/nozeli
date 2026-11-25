import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {openExperimentalAnchoredRead as open} from '../src/platform/windows/experimental-read.mjs';

const native = {skip:process.platform !== 'win32' || process.arch !== 'x64'};
const ownedPins = new Map();
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-native-read-'));
  ownedPins.set(root, []);
  t.after(async () => {
    for (const read of ownedPins.get(root)) read.close();
    ownedPins.delete(root);
    await fs.rm(root, {recursive:true, force:true});
    await fs.rm(root + '-moved', {recursive:true, force:true});
  });
  await fs.mkdir(path.join(root, '中文 空格'));
  await fs.writeFile(path.join(root, '中文 空格', '正文.txt'), 'synthetic 中文\n');
  return root;
}
function competitor(operation, ...args) {
  // This child only runs a fixed fs operation on this test's synthetic paths.
  const code = `try { require('node:fs')[process.argv[1]](...process.argv.slice(2)); console.log('ok'); }
    catch (error) { console.log(error.code); process.exitCode = 7; }`;
  const child = spawnSync(process.execPath, ['-e', code, operation, ...args], {
    encoding:'utf8', timeout:10000, windowsHide:true,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, '');
  return {status:child.status, output:child.stdout.trim()};
}
function pin(t, root) {
  const read = open(root, '中文 空格/正文.txt');
  ownedPins.get(root).push(read);
  return read;
}

test('native read preserves Unicode bytes and identity, reaches EOF and closes idempotently', native, async t => {
  const root = await fixture(t), read = pin(t, root);
  const chunks = [];
  for (;;) {const bytes = read.read(3); if (!bytes.length) break; chunks.push(bytes);}
  assert.equal(Buffer.concat(chunks).toString(), 'synthetic 中文\n');
  const id = read.identity();
  assert.match(id, /^[0-9a-f]{16}:[0-9a-f]{32}$/);
  assert.equal(read.verify(), true);
  read.close(); read.close();
  assert.throws(() => read.read(1), {code:'FS_HANDLE_CLOSED'});
  assert.throws(() => read.verify(), {code:'FS_HANDLE_CLOSED'});
  assert.throws(() => read.identity(), {code:'FS_HANDLE_CLOSED'});
  const reopened = pin(t, root);
  assert.equal(reopened.identity(), id);
});

test('independent process cannot mutate pinned file or rename its ancestors; close releases guards', native, async t => {
  const root = await fixture(t); let read = pin(t, root);
  for (const [operation, ...args] of [
    ['writeFileSync', path.join(root, '中文 空格', '正文.txt'), 'competitor'],
    ['renameSync', path.join(root, '中文 空格', '正文.txt'), path.join(root, 'moved.txt')],
    ['renameSync', path.join(root, '中文 空格'), path.join(root, 'moved-dir')],
    ['renameSync', root, root + '-moved'],
  ]) {
    const result = competitor(operation, ...args);
    assert.equal(result.status, 7, JSON.stringify(result));
    assert.match(result.output, /^(?:EPERM|EACCES|EBUSY)$/);
  }
  // A hard-link publication may succeed without requesting FILE_WRITE access
  // on the source handle; the post-read identity check must catch its nlink
  // change. Remove the synthetic link before continuing the guard test.
  const hardLink = path.join(root, 'new-hard-link.txt');
  const linkResult = competitor('linkSync', path.join(root, '中文 空格', '正文.txt'), hardLink);
  assert.deepEqual(linkResult, {status:0, output:'ok'});
  assert.equal(read.verify(), false);
  await fs.unlink(hardLink);
  read.close();
  read = pin(t, root);
  assert.equal(read.verify(), true);
  assert.equal(read.verify(), true);
  read.close();
  assert.deepEqual(competitor('writeFileSync', path.join(root, '中文 空格', '正文.txt'), 'after close'), {status:0, output:'ok'});
  await fs.rename(path.join(root, '中文 空格'), path.join(root, 'released'));
});

test('junction in relative ancestry or absolute root is refused and partial opens release guards', native, async t => {
  const root = await fixture(t);
  await fs.symlink(path.join(root, '中文 空格'), path.join(root, 'junction'), 'junction');
  assert.throws(() => open(root, 'junction/正文.txt'), {code:'FS_REPARSE_REJECTED'});
  assert.throws(() => open(path.join(root, 'junction'), '正文.txt'), {code:'FS_REPARSE_REJECTED'});
  assert.deepEqual(competitor('writeFileSync', path.join(root, '中文 空格', '正文.txt'), 'after refusal'), {status:0, output:'ok'});
  await fs.rename(root, root + '-moved');
  await fs.rename(root + '-moved', root);
});

test('missing entries, directories and hard links fail without retained locks', native, async t => {
  const root = await fixture(t);
  assert.throws(() => open(root, 'missing/file.txt'), error => error.code === 'WIN32_IO_ERROR' && [2,3].includes(error.win32Code));
  assert.throws(() => open(root, '中文 空格'), {code:'WIN32_IO_ERROR'});
  await fs.link(path.join(root, '中文 空格', '正文.txt'), path.join(root, 'alias.txt'));
  assert.throws(() => open(root, 'alias.txt'), {code:'FS_ENTRY_REJECTED'});
  await fs.unlink(path.join(root, 'alias.txt'));
  const read = pin(t, root);
  assert.equal(read.verify(), true);
});

test('unsafe path forms and invalid JS receivers are refused', native, async t => {
  const root = await fixture(t);
  for (const relative of ['', '../out', './out', '中文 空格\\正文.txt', '/absolute', 'a//b', 'a/', 'a:stream', 'a\0b', 'a./b', 'a /b'])
    assert.throws(() => open(root, relative), {code:'FS_PATH_REJECTED'}, JSON.stringify(relative));
  for (const badRoot of ['D:relative', '\\\\server\\share', '\\\\?\\D:\\path', root + '\\..', root + '\\'])
    assert.throws(() => open(badRoot, 'file'), {code:'FS_PATH_REJECTED'});
  const read = pin(t, root);
  for (const size of [0, -1, 1.5, NaN, Infinity, 1048577, '1'])
    assert.throws(() => read.read(size), {code:'FS_READ_LIMIT'});
  for (const method of ['close', 'read', 'verify', 'identity'])
    assert.throws(() => read[method].call({}, 1), {code:'FS_HANDLE_REJECTED'});
});

test('an existing write handle causes refusal before returning a read pin', native, async t => {
  const root = await fixture(t);
  const writer = await fs.open(path.join(root, '中文 空格', '正文.txt'), 'r+');
  try {
    assert.throws(() => open(root, '中文 空格/正文.txt'), error => error.code === 'WIN32_IO_ERROR' && error.win32Code === 32);
  } finally {await writer.close();}
  const read = pin(t, root);
  assert.equal(read.verify(), true);
});

test('a naturally exiting independent host releases its native guards without explicit close', native, async t => {
  const root = await fixture(t);
  const loader = new URL('../src/platform/windows/experimental-read.mjs', import.meta.url).href;
  const code = `const {openExperimentalAnchoredRead:open} = await import(process.argv[1]);
    globalThis.pin = open(process.argv[2], '中文 空格/正文.txt'); console.log(globalThis.pin.verify());`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, loader, root], {
    encoding:'utf8', timeout:10000, windowsHide:true,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'true');
  assert.deepEqual(competitor('writeFileSync', path.join(root, '中文 空格', '正文.txt'), 'after host exit'), {status:0, output:'ok'});
});

test('Node-API finalizer releases unreachable handles while the host remains alive', native, async t => {
  const root = await fixture(t);
  const loader = new URL('../src/platform/windows/experimental-read.mjs', import.meta.url).href;
  const code = `const {openExperimentalAnchoredRead:open} = await import(process.argv[1]);
    const fs = await import('node:fs'); const path = await import('node:path');
    let pin = open(process.argv[2], '中文 空格/正文.txt');
    if (!pin.verify()) throw Error('pin unstable'); pin = null;
    let released = false;
    for (let i = 0; i < 30; i++) {
      global.gc(); await new Promise(resolve => setTimeout(resolve, 100));
      try {fs.writeFileSync(path.join(process.argv[2], '中文 空格', '正文.txt'), 'after finalizer'); released = true; break;}
      catch (error) {if (!['EPERM','EACCES','EBUSY'].includes(error.code)) throw error;}
    }
    if (!released) throw Error('Native finalizer did not release guards'); console.log('released');`;
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', code, loader, root], {
    encoding:'utf8', timeout:10000, windowsHide:true,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'released');
});

test('handle-relative traversal reads paths longer than MAX_PATH without changing registry policy', native, async t => {
  const root = await fixture(t);
  const relative = Array.from({length:4}, (_, i) => `segment-${i}-` + 'x'.repeat(70)).join('/') + '/long.txt';
  await fs.mkdir(path.dirname(path.join(root, relative)), {recursive:true});
  await fs.writeFile(path.join(root, relative), 'long synthetic path');
  assert.ok(path.join(root, relative).length > 260);
  const read = open(root, relative);
  ownedPins.get(root).push(read);
  assert.equal(read.read(1024).toString(), 'long synthetic path');
  assert.equal(read.verify(), true);
});
