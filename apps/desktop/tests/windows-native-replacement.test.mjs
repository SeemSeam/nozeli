import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {openExperimentalReplacement as open} from '../src/platform/windows/experimental-replacement.mjs';
import {openExperimentalWriteParent} from '../src/platform/windows/experimental-write.mjs';

const native = {skip:process.platform !== 'win32' || process.arch !== 'x64'};
const loader = new URL('../src/platform/windows/experimental-replacement.mjs', import.meta.url).href;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, relative = 'target.txt', original = 'original') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-native-cas-'));
  const target = path.join(root, relative), transactions = [];
  await fs.mkdir(path.dirname(target), {recursive:true});
  await fs.writeFile(target, original);
  t.after(async () => {
    for (const tx of transactions) tx.close();
    await fs.rm(root, {recursive:true, force:true});
  });
  return {root, target, relative, tx(expected = digest(original)) {
    const tx = open(root, relative, expected); transactions.push(tx); return tx;
  }};
}
function compete(operation, ...args) {
  const child = spawnSync(process.execPath, ['-e', `try {
    require('node:fs')[process.argv[1]](...process.argv.slice(2)); console.log('ok');
  } catch (error) { console.log(error.code); process.exitCode = 7; }`, operation, ...args], {
    encoding:'utf8', timeout:10000, windowsHide:true,
  });
  assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.stderr, '');
  return {status:child.status, output:child.stdout.trim()};
}
function blocked(result) {
  assert.equal(result.status, 7, JSON.stringify(result));
  assert.match(result.output, /^(EPERM|EACCES|EBUSY|UNKNOWN)$/);
}

test('CAS compares locked bytes, prepares invisibly, commits and reopens Unicode content', native, async t => {
  const f = await fixture(t, '中文 空格/正文.txt'), tx = f.tx();
  assert.equal(tx.read().toString(), 'original');
  assert.throws(() => tx.commit(), {code:'FS_TRANSACTION_STATE'});
  tx.prepare(Buffer.from('candidate 中文'), '候选.pending');
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), ['正文.txt']);
  assert.throws(() => tx.read(), {code:'FS_TRANSACTION_STATE'});
  assert.deepEqual(tx.commit(), {committed:true, durability:'namespace-not-qualified'});
  tx.close(); tx.close();
  assert.equal(await fs.readFile(f.target, 'utf8'), 'candidate 中文');
  assert.throws(() => tx.commit(), {code:'FS_HANDLE_CLOSED'});
});

test('stale versions preserve the external winner and a separately retained candidate', native, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'draft.recovery'), 'candidate');
  await fs.writeFile(f.target, 'external winner');
  assert.throws(() => f.tx(), error => error.code === 'FS_VERSION_CONFLICT' &&
    error.actualSha256 === digest('external winner') && error.expectedSha256 === digest('original'));
  assert.equal(await fs.readFile(f.target, 'utf8'), 'external winner');
  assert.equal(await fs.readFile(path.join(f.root, 'draft.recovery'), 'utf8'), 'candidate');
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['draft.recovery', 'target.txt']);
});

test('independent writes/deletes/renames are refused before and after transactional handles close', native, async t => {
  const f = await fixture(t), tx = f.tx();
  await fs.writeFile(path.join(f.root, 'contender.txt'), 'external winner');
  for (const prepared of [false, true]) {
    if (prepared) tx.prepare(Buffer.from('candidate'), 'owned.pending');
    blocked(compete('writeFileSync', f.target, 'outside'));
    blocked(compete('unlinkSync', f.target));
    blocked(compete('renameSync', f.target, path.join(f.root, 'stolen')));
    blocked(compete('renameSync', path.join(f.root, 'contender.txt'), f.target));
    blocked(compete('renameSync', f.root, f.root + '-moved'));
  }
  tx.commit();
  assert.equal(await fs.readFile(f.target, 'utf8'), 'candidate');
  assert.equal(await fs.readFile(path.join(f.root, 'contender.txt'), 'utf8'), 'external winner');
});

test('rollback at either phase retains original bytes and removes transactional staging', native, async t => {
  const f = await fixture(t);
  for (const prepared of [false, true]) {
    const tx = f.tx();
    if (prepared) tx.prepare(Buffer.from('candidate'), 'owned.pending');
    tx.close(); tx.close();
    assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(f.root), ['target.txt']);
    assert.deepEqual(compete('writeFileSync', f.target, 'original'), {status:0, output:'ok'});
  }
});

test('exclusive staging refuses an existing name and aborts without removing the contender', native, async t => {
  const f = await fixture(t), tx = f.tx();
  await fs.writeFile(path.join(f.root, 'owned.pending'), 'external stage');
  assert.throws(() => tx.prepare(Buffer.from('candidate'), 'owned.pending'), {code:'FS_TRANSACTION_REFUSED'});
  assert.throws(() => tx.commit(), {code:'FS_HANDLE_CLOSED'});
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(f.root, 'owned.pending'), 'utf8'), 'external stage');
});

test('a competing transaction cannot acquire the locked base and stale retry is refused after commit', native, async t => {
  const f = await fixture(t), tx = f.tx();
  const code = `const {openExperimentalReplacement:open}=await import(process.argv[1]);
    try {const tx=open(process.argv[2],'target.txt',process.argv[3]);tx.close();console.log('unexpected');}
    catch(e) {console.log(e.code);}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, loader, f.root, digest('original')], {
    encoding:'utf8', timeout:10000, windowsHide:true,
  });
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'FS_TRANSACTION_REFUSED');
  tx.prepare(Buffer.from('winner'), 'owned.pending'); tx.commit();
  assert.throws(() => f.tx(), {code:'FS_VERSION_CONFLICT'});
  assert.equal(await fs.readFile(f.target, 'utf8'), 'winner');
});

test('hard links, directories and junction targets are refused without mutation', native, async t => {
  const f = await fixture(t);
  await fs.link(f.target, path.join(f.root, 'alias'));
  assert.throws(() => f.tx(), {code:'FS_ENTRY_REJECTED'});
  await fs.unlink(path.join(f.root, 'alias'));
  await fs.mkdir(path.join(f.root, 'directory'));
  await fs.writeFile(path.join(f.root, 'directory/sentinel'), 'outside');
  await fs.symlink(path.join(f.root, 'directory'), path.join(f.root, 'junction'), 'junction');
  for (const name of ['directory', 'junction'])
    assert.throws(() => open(f.root, name, digest('original')), e =>
      ['FS_TRANSACTION_REFUSED', 'FS_ENTRY_REJECTED', 'FS_REPARSE_REJECTED'].includes(e.code));
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(f.root, 'directory/sentinel'), 'utf8'), 'outside');
});

test('validation rejects unsafe stage names, invalid receivers, shared buffers and oversized candidates', native, async t => {
  const f = await fixture(t), tx = f.tx();
  for (const hash of ['', 'x'.repeat(64), digest('original').toUpperCase(), null])
    assert.throws(() => open(f.root, 'target.txt', hash), {code:'FS_VERSION_REJECTED'});
  for (const name of ['', '..', 'sub/file', 'x:stream', 'tail.', 'TARGET.TXT'])
    assert.throws(() => tx.prepare(Buffer.from('x'), name), {code:'FS_NAME_REJECTED'});
  for (const bytes of ['text', new Uint16Array(2), new DataView(new ArrayBuffer(4)),
      new Uint8Array(new SharedArrayBuffer(4)), Buffer.alloc(1048577)])
    assert.throws(() => tx.prepare(bytes, 'stage'), {code:'FS_WRITE_LIMIT'});
  for (const method of ['read', 'prepare', 'commit', 'close'])
    assert.throws(() => tx[method].call({}), {code:'FS_HANDLE_REJECTED'});
  tx.prepare(new Uint8Array([0, 1, 2, 3]).subarray(1, 3), 'stage'); tx.commit();
  assert.deepEqual(await fs.readFile(f.target), Buffer.from([1, 2]));
});

test('transaction pin outlives the JS parent and supports paths beyond MAX_PATH', native, async t => {
  const relative = Array.from({length:4}, (_, i) => `segment-${i}-` + 'x'.repeat(70)).join('/') + '/target.txt';
  const f = await fixture(t, relative);
  assert.ok(f.target.length > 260);
  const parent = openExperimentalWriteParent(f.root, relative);
  const tx = parent.beginReplacement('target.txt'); parent.close();
  try {tx.prepare(Buffer.alloc(0), 'stage'); tx.commit();} finally {tx.close();}
  assert.equal((await fs.readFile(f.target)).length, 0);
});

test('forced owned-child termination rolls back an invisible replacement and preserves recovery candidate', native, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'draft.recovery'), 'candidate');
  const code = `const {openExperimentalReplacement:open}=await import(process.argv[1]);
    globalThis.tx=open(process.argv[2],'target.txt',process.argv[3]);
    tx.prepare(Buffer.from('candidate'),'owned.pending');console.log('prepared');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, loader, f.root, digest('original')], {
    windowsHide:true, timeout:10000, stdio:['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {if (child.exitCode === null && child.signalCode === null) child.kill();});
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => {stderr += chunk;});
  const done = new Promise((resolve, reject) => {child.once('error', reject);child.once('close', (code, signal) => resolve({code, signal}));});
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {stdout += chunk;if (stdout.includes('prepared')) resolve();});
    child.once('error', reject);child.once('close', () => {if (!stdout.includes('prepared')) reject(Error(stderr));});
  });
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
  child.kill(); await done;
  assert.equal(stderr, '');
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(f.root, 'draft.recovery'), 'utf8'), 'candidate');
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['draft.recovery', 'target.txt']);
  const tx = f.tx(); tx.prepare(Buffer.from('retry after explicit recovery'), 'retry'); tx.commit();
});

test('live GC and natural host exit roll back abandoned transactions', native, async t => {
  const f = await fixture(t);
  for (const gc of [false, true]) {
    const code = `const {openExperimentalReplacement:open}=await import(process.argv[1]);
      let tx=open(process.argv[2],'target.txt',process.argv[3]);
      tx.prepare(Buffer.from('candidate'),'owned.pending');
      ${gc ? `tx=null;let released=false;for(let i=0;i<30;i++){
        global.gc();await new Promise(r=>setTimeout(r,40));
        try {const check=open(process.argv[2],'target.txt',process.argv[3]);check.close();released=true;break;}
        catch(e){if(e.code!=='FS_TRANSACTION_REFUSED')throw e;}
      }if(!released)throw Error('GC did not release the transaction in a live host');` : 'globalThis.abandoned=tx;'}
    `;
    const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', code, loader, f.root, digest('original')], {
      encoding:'utf8', timeout:10000, windowsHide:true,
    });
    assert.ifError(child.error);assert.equal(child.status, 0, child.stderr);assert.equal(child.stderr, '');
    assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(f.root), ['target.txt']);
    const tx = f.tx();tx.close();
  }
});

test('pre-existing writable handles cause refusal and oversized base reads release transaction locks', native, async t => {
  const f = await fixture(t);
  const writer = await fs.open(f.target, 'r+');
  try {assert.throws(() => f.tx(), {code:'FS_TRANSACTION_REFUSED'});} finally {await writer.close();}
  await fs.writeFile(f.target, Buffer.alloc(1048577));
  assert.throws(() => open(f.root, f.relative, digest(Buffer.alloc(1048577))), {code:'FS_READ_LIMIT'});
  assert.deepEqual(compete('writeFileSync', f.target, 'original'), {status:0, output:'ok'});
  const tx = f.tx();tx.close();
});

test('hard-link creation cannot bypass a live replacement transaction', native, async t => {
  const f = await fixture(t), tx = f.tx();
  for (const prepared of [false, true]) {
    if (prepared) tx.prepare(Buffer.from('candidate'), 'stage');
    blocked(compete('linkSync', f.target, path.join(f.root, 'outside-alias')));
  }
  tx.commit();
  assert.equal(await fs.readFile(f.target, 'utf8'), 'candidate');
  assert.deepEqual(await fs.readdir(f.root), ['target.txt']);
});

test('real KTM timeout reports an aborted commit without publishing or replaying the candidate', native, async t => {
  const f = await fixture(t), tx = f.tx();
  await fs.writeFile(path.join(f.root, 'draft.recovery'), 'candidate');
  tx.prepare(Buffer.from('candidate'), 'stage');
  // The native experiment uses a bounded 30-second transaction, not a mock.
  await new Promise(resolve => setTimeout(resolve, 31000));
  assert.throws(() => tx.commit(), error => error.code === 'FS_TRANSACTION_ABORTED' &&
    error.transactionOutcome === 'aborted' && error.committed === undefined);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
  assert.deepEqual(compete('writeFileSync', f.target, 'external winner'), {status:0, output:'ok'});
  tx.close();
  assert.equal(await fs.readFile(f.target, 'utf8'), 'external winner');
  assert.equal(await fs.readFile(path.join(f.root, 'draft.recovery'), 'utf8'), 'candidate');
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['draft.recovery', 'target.txt']);
});
