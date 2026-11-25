import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {openExperimentalWriteParent as open} from '../src/platform/windows/experimental-write.mjs';

const native = {skip:process.platform !== 'win32' || process.arch !== 'x64'};
const loader = new URL('../src/platform/windows/experimental-write.mjs', import.meta.url).href;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-native-write-'));
  const parents = [], stages = [];
  t.after(async () => {
    for (const stage of stages) stage.close();
    for (const parent of parents) parent.close();
    await fs.rm(root, {recursive:true, force:true});
    await fs.rm(root + '-moved', {recursive:true, force:true});
  });
  return {
    root,
    parent(relative = 'new.txt') {const parent = open(root, relative); parents.push(parent); return parent;},
    stage(parent, name = 'owned.pending') {const stage = parent.createExclusive(name); stages.push(stage); return stage;},
  };
}
function competitor(operation, ...args) {
  const child = spawnSync(process.execPath, ['-e', `try {
    require('node:fs')[process.argv[1]](...process.argv.slice(2)); console.log('ok');
  } catch (error) {console.log(error.code); process.exitCode = 7;}`, operation, ...args], {
    encoding:'utf8', timeout:10000, windowsHide:true,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, '');
  return {status:child.status, output:child.stdout.trim()};
}
function independentHost(code, root) {
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', code, loader, root], {
    encoding:'utf8', timeout:10000, windowsHide:true,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

test('staged Unicode chunks are flushed and published through the pinned parent without namespace durability claims', native, async t => {
  const f = await fixture(t), parent = f.parent('中文 空格/deep/正文.txt'), stage = f.stage(parent);
  const bytes = Buffer.from('synthetic 中文\n');
  for (let start = 0; start < bytes.length; start += 3)
    assert.equal(stage.write(bytes.subarray(start, start + 3)), Math.min(3, bytes.length - start));
  stage.sync();
  assert.equal(stage.verify(), true);
  assert.deepEqual(stage.publishNew('正文.txt'), {published:true, durability:'namespace-not-qualified'});
  assert.equal(stage.verify(), true);
  assert.throws(() => stage.write(Buffer.from('late')), {code:'FS_STAGE_PUBLISHED'});
  assert.throws(() => stage.sync(), {code:'FS_STAGE_PUBLISHED'});
  assert.throws(() => stage.publishNew('twice.txt'), {code:'FS_STAGE_PUBLISHED'});
  stage.close(); stage.close(); parent.close(); parent.close();
  assert.deepEqual(await fs.readFile(path.join(f.root, '中文 空格/deep/正文.txt')), bytes);
  assert.deepEqual(await fs.readdir(path.join(f.root, '中文 空格/deep')), ['正文.txt']);
});

test('exclusive creation preserves existing files and junction entries, without truncation or cleanup of contenders', native, async t => {
  const f = await fixture(t), parent = f.parent();
  await fs.writeFile(path.join(f.root, 'existing'), 'external winner');
  assert.throws(() => parent.createExclusive('existing'), e =>
    e.code === 'WIN32_IO_ERROR' && [80, 183].includes(e.win32Code));
  await fs.mkdir(path.join(f.root, 'outside'));
  await fs.symlink(path.join(f.root, 'outside'), path.join(f.root, 'junction'), 'junction');
  assert.throws(() => parent.createExclusive('junction'), e => e.code === 'WIN32_IO_ERROR');
  parent.close();
  assert.equal(await fs.readFile(path.join(f.root, 'existing'), 'utf8'), 'external winner');
  assert.equal((await fs.lstat(path.join(f.root, 'junction'))).isSymbolicLink(), true);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'outside')), []);
});

test('a competitor target created after staging survives refused publication and owned-stage cleanup', native, async t => {
  const f = await fixture(t), parent = f.parent(), stage = f.stage(parent);
  stage.write(Buffer.from('candidate')); stage.sync();
  assert.deepEqual(competitor('writeFileSync', path.join(f.root, 'target.txt'), 'external winner'), {status:0, output:'ok'});
  assert.throws(() => stage.publishNew('target.txt'), {code:'FS_TARGET_EXISTS'});
  assert.equal(stage.verify(), true);
  assert.equal(await fs.readFile(path.join(f.root, 'owned.pending'), 'utf8'), 'candidate');
  stage.close(); parent.close();
  assert.equal(await fs.readFile(path.join(f.root, 'target.txt'), 'utf8'), 'external winner');
  assert.deepEqual(await fs.readdir(f.root), ['target.txt']);
});

test('publication preserves case-equivalent files, hard-link targets, directories and junction targets', native, async t => {
  const f = await fixture(t), stage = f.stage(f.parent());
  await fs.writeFile(path.join(f.root, 'WINNER.TXT'), 'external winner');
  await fs.link(path.join(f.root, 'WINNER.TXT'), path.join(f.root, 'hard-target'));
  await fs.mkdir(path.join(f.root, 'directory'));
  await fs.writeFile(path.join(f.root, 'directory/sentinel'), 'outside');
  await fs.symlink(path.join(f.root, 'directory'), path.join(f.root, 'junction'), 'junction');
  stage.write(Buffer.from('candidate')); stage.sync();
  for (const name of ['winner.txt', 'hard-target', 'directory', 'junction']) {
    assert.throws(() => stage.publishNew(name), error =>
      error.code === 'FS_TARGET_EXISTS' || (error.code === 'WIN32_IO_ERROR' && error.win32Code === 5), name);
    assert.equal(stage.verify(), true);
  }
  stage.close();
  assert.equal(await fs.readFile(path.join(f.root, 'WINNER.TXT'), 'utf8'), 'external winner');
  assert.equal(await fs.readFile(path.join(f.root, 'hard-target'), 'utf8'), 'external winner');
  assert.equal((await fs.lstat(path.join(f.root, 'junction'))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(f.root, 'directory/sentinel'), 'utf8'), 'outside');
});

test('external write/delete/rename and ancestor replacement are refused while the owned stage is alive', native, async t => {
  const f = await fixture(t), parent = f.parent(), stage = f.stage(parent);
  stage.write(Buffer.from('candidate'));
  for (const [operation, ...args] of [
    ['writeFileSync', path.join(f.root, 'owned.pending'), 'competitor'],
    ['unlinkSync', path.join(f.root, 'owned.pending')],
    ['renameSync', path.join(f.root, 'owned.pending'), path.join(f.root, 'stolen')],
    ['renameSync', f.root, f.root + '-moved'],
  ]) {
    const result = competitor(operation, ...args);
    assert.equal(result.status, 7, JSON.stringify(result));
    assert.match(result.output, /^(?:EPERM|EACCES|EBUSY)$/);
  }
  stage.close(); parent.close();
  assert.deepEqual(await fs.readdir(f.root), []);
  await fs.rename(f.root, f.root + '-moved');
  await fs.rename(f.root + '-moved', f.root);
});

test('closing the JS parent retains directory guards until the live stage finishes', native, async t => {
  const f = await fixture(t), parent = f.parent(), stage = f.stage(parent);
  parent.close();
  assert.throws(() => parent.createExclusive('another'), {code:'FS_HANDLE_CLOSED'});
  const blocked = competitor('renameSync', f.root, f.root + '-moved');
  assert.equal(blocked.status, 7);
  stage.write(Buffer.from('still owned')); stage.sync(); stage.publishNew('published.txt'); stage.close();
  await fs.rename(f.root, f.root + '-moved');
  await fs.rename(f.root + '-moved', f.root);
  assert.equal(await fs.readFile(path.join(f.root, 'published.txt'), 'utf8'), 'still owned');
});

test('every write invalidates the explicit file flush prerequisite for publication', native, async t => {
  const f = await fixture(t), stage = f.stage(f.parent());
  assert.throws(() => stage.publishNew('target.txt'), {code:'FS_STAGE_NOT_SYNCED'});
  stage.sync(); stage.write(Buffer.from('first'));
  assert.throws(() => stage.publishNew('target.txt'), {code:'FS_STAGE_NOT_SYNCED'});
  stage.sync(); stage.write(Buffer.from('second')); stage.sync();
  stage.publishNew('target.txt'); stage.close();
  assert.equal(await fs.readFile(path.join(f.root, 'target.txt'), 'utf8'), 'firstsecond');
});

test('additional hard links invalidate a stage and cannot cause publication or deletion of the external alias', native, async t => {
  const f = await fixture(t), stage = f.stage(f.parent());
  stage.write(Buffer.from('candidate')); stage.sync();
  assert.deepEqual(competitor('linkSync', path.join(f.root, 'owned.pending'), path.join(f.root, 'external-alias')), {status:0, output:'ok'});
  assert.equal(stage.verify(), false);
  assert.throws(() => stage.publishNew('target.txt'), {code:'FS_STAGE_CHANGED'});
  assert.throws(() => stage.write(Buffer.from('more')), {code:'FS_STAGE_CHANGED'});
  stage.close();
  assert.equal(await fs.readFile(path.join(f.root, 'external-alias'), 'utf8'), 'candidate');
  assert.deepEqual(await fs.readdir(f.root), ['external-alias']);
});

test('unsafe path/name forms, invalid receivers, chunk overflow and closed handles are rejected', native, async t => {
  const f = await fixture(t);
  for (const relative of ['', '../out', 'a/../out', 'a\\out', '/absolute', 'a//b', 'a/', 'a:stream', 'a./b', 'a /b'])
    assert.throws(() => open(f.root, relative), {code:'FS_PATH_REJECTED'});
  const parent = f.parent();
  for (const name of ['', '.', '..', '../out', 'sub/file', 'sub\\file', 'x:stream', 'bad\0name', 'tail.', 'tail ', 3])
    assert.throws(() => parent.createExclusive(name), {code:'FS_NAME_REJECTED'});
  const stage = f.stage(parent);
  for (const bytes of ['text', 3, new Uint16Array(2), new DataView(new ArrayBuffer(4)),
      new Uint8Array(new SharedArrayBuffer(4)), Buffer.alloc(1048577)])
    assert.throws(() => stage.write(bytes), {code:'FS_WRITE_LIMIT'});
  assert.equal(stage.write(new Uint8Array([1, 2, 3, 4]).subarray(1, 3)), 2);
  assert.equal(stage.write(Buffer.alloc(1048576)), 1048576);
  for (const method of ['write', 'sync', 'verify', 'publishNew', 'close'])
    assert.throws(() => stage[method].call({}, Buffer.from('x')), {code:'FS_HANDLE_REJECTED'});
  for (const method of ['createExclusive', 'close'])
    assert.throws(() => parent[method].call({}, 'x'), {code:'FS_HANDLE_REJECTED'});
  stage.sync();
  assert.throws(() => stage.publishNew('OWNED.PENDING'), {code:'FS_NAME_REJECTED'});
  stage.close(); stage.close();
  for (const method of ['write', 'sync', 'verify', 'publishNew'])
    assert.throws(() => stage[method](Buffer.from('x')), {code:'FS_HANDLE_CLOSED'});
});

test('junction ancestors are rejected before a staged file can be created and failed opens release guards', native, async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'outside'));
  await fs.symlink(path.join(f.root, 'outside'), path.join(f.root, 'junction'), 'junction');
  assert.throws(() => open(f.root, 'junction/target.txt'), {code:'FS_REPARSE_REJECTED'});
  assert.throws(() => open(path.join(f.root, 'junction'), 'target.txt'), {code:'FS_REPARSE_REJECTED'});
  await fs.rename(f.root, f.root + '-moved'); await fs.rename(f.root + '-moved', f.root);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'outside')), []);
});

test('a live-host finalizer discards only its owned stage and releases retained directory guards', native, async t => {
  const f = await fixture(t);
  assert.equal(independentHost(`
    const {openExperimentalWriteParent:open} = await import(process.argv[1]);
    const fs = await import('node:fs'); const path = await import('node:path');
    let parent = open(process.argv[2], 'target.txt');
    let stage = parent.createExclusive('owned.pending'); stage.write(Buffer.from('abandoned'));
    parent.close(); parent = null; stage = null;
    for (let i = 0; i < 30; i++) {
      global.gc(); await new Promise(resolve => setTimeout(resolve, 100));
      if (!fs.existsSync(path.join(process.argv[2], 'owned.pending'))) {console.log('discarded'); break;}
    }
    if (fs.existsSync(path.join(process.argv[2], 'owned.pending'))) throw Error('Stage not finalized');
    fs.renameSync(process.argv[2], process.argv[2] + '-moved');
    fs.renameSync(process.argv[2] + '-moved', process.argv[2]);
  `, f.root), 'discarded');
});

test('natural host exit discards an abandoned stage but retains a published file', native, async t => {
  const f = await fixture(t);
  independentHost(`
    const {openExperimentalWriteParent:open} = await import(process.argv[1]);
    globalThis.parent = open(process.argv[2], 'published.txt');
    globalThis.abandoned = parent.createExclusive('abandoned.pending'); abandoned.write(Buffer.from('abandoned'));
    globalThis.published = parent.createExclusive('published.pending'); published.write(Buffer.from('published'));
    published.sync(); published.publishNew('published.txt');
  `, f.root);
  assert.deepEqual(await fs.readdir(f.root), ['published.txt']);
  assert.equal(await fs.readFile(path.join(f.root, 'published.txt'), 'utf8'), 'published');
  await fs.rename(f.root, f.root + '-moved'); await fs.rename(f.root + '-moved', f.root);
});

test('new-file publication supports handle-relative paths beyond MAX_PATH', native, async t => {
  const f = await fixture(t);
  const relative = Array.from({length:4}, (_, i) => `segment-${i}-` + 'x'.repeat(70)).join('/') + '/target.txt';
  assert.ok(path.join(f.root, relative).length > 260);
  const stage = f.stage(f.parent(relative));
  stage.write(Buffer.from('long synthetic path')); stage.sync(); stage.publishNew('target.txt'); stage.close();
  assert.equal(await fs.readFile(path.join(f.root, relative), 'utf8'), 'long synthetic path');
});

function racer(t, root, name) {
  const code = `const {openExperimentalWriteParent:open} = await import(process.argv[1]);
    const parent = open(process.argv[2], 'target.txt'); const stage = parent.createExclusive(process.argv[3] + '.pending');
    stage.write(Buffer.from(process.argv[3])); stage.sync(); console.log('ready');
    process.stdin.once('data', () => {
      try {stage.publishNew('target.txt'); console.log('won');}
      catch (error) {if (error.code !== 'FS_TARGET_EXISTS') throw error; console.log(error.code);}
      finally {stage.close(); parent.close(); process.stdin.destroy();}
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, loader, root, name], {
    windowsHide:true, timeout:10000, stdio:['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {if (child.exitCode === null && child.signalCode === null) child.kill();});
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => {stderr += chunk;});
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal, stdout, stderr}));
  });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {stdout += chunk; if (stdout.includes('ready\n')) resolve();});
    child.once('error', reject);
    child.once('close', () => {if (!stdout.includes('ready\n')) reject(new Error('Racer exited before ready: ' + stderr));});
  });
  return {child, ready, done, name};
}
test('two independent publishers racing to one absent name retain exactly one winner without clobbering it', native, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'unrelated.txt'), 'sentinel');
  const racers = [racer(t, f.root, 'one'), racer(t, f.root, 'two')];
  await Promise.all(racers.map(r => r.ready));
  for (const r of racers) r.child.stdin.end('go\n');
  const results = await Promise.all(racers.map(r => r.done));
  for (const r of results) {assert.equal(r.code, 0, r.stderr); assert.equal(r.signal, null); assert.equal(r.stderr, '');}
  const winners = results.map((r, i) => ({...r, name:racers[i].name})).filter(r => r.stdout.trim() === 'ready\nwon');
  assert.equal(winners.length, 1);
  assert.equal(results.filter(r => r.stdout.trim() === 'ready\nFS_TARGET_EXISTS').length, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'target.txt'), 'utf8'), winners[0].name);
  assert.equal(await fs.readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'sentinel');
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['target.txt', 'unrelated.txt']);
});
