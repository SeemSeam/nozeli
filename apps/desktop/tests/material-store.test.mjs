import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MaterialStore, digestBytes } from '../src/domain/material-store.mjs';

async function fixture(t, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-material-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new MaterialStore(path.join(root, 'materials'), options) };
}

test('persists exact bytes, including an empty file, across new store instances', async t => {
  const { store } = await fixture(t);
  for (const input of [Buffer.alloc(0), Buffer.from('中文材料\r\n正文'), Buffer.from([0, 255, 42])]) {
    const ref = await store.put(input);
    assert.equal(ref.digest, digestBytes(input));
    assert.equal(ref.byteLength, input.length);
    assert.deepEqual(await new MaterialStore(store.directory).get(ref.digest), input);
  }
});

test('freezes submitted bytes before asynchronous work begins', async t => {
  const { store } = await fixture(t);
  const input = Buffer.from('original'), promise = store.put(input);
  input.fill(120);
  const ref = await promise;
  assert.equal((await store.get(ref.digest)).toString(), 'original');
});

test('new content never rewrites an older material reference', async t => {
  const { store } = await fixture(t);
  const old = await store.put(Buffer.from('before'));
  const next = await store.put(Buffer.from('after'));
  assert.notEqual(old.digest, next.digest);
  assert.equal((await store.get(old.digest)).toString(), 'before');
  assert.equal((await store.get(next.digest)).toString(), 'after');
});

test('concurrent writers publish one complete object without leftover temporary files', async t => {
  const { store } = await fixture(t);
  const payload = Buffer.alloc(512 * 1024, 157);
  const refs = await Promise.all(Array.from({ length: 12 }, () => new MaterialStore(store.directory).put(payload)));
  assert.equal(new Set(refs.map(r => r.digest)).size, 1);
  assert.deepEqual(await fs.readdir(store.directory), [refs[0].digest]);
  assert.deepEqual(await store.get(refs[0].digest), payload);
});

test('missing or invalid references fail without reading outside the store', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.get('a'.repeat(64)), { code: 'MATERIAL_MISSING' });
  for (const invalid of ['../private', '/tmp/private', 'A'.repeat(64), '', null, 'a'.repeat(63)]) {
    await assert.rejects(store.get(invalid), { code: 'INVALID_DIGEST' });
  }
});

test('corruption is reported and a subsequent put never silently repairs evidence', async t => {
  const { store } = await fixture(t);
  const payload = Buffer.from('valid');
  const ref = await store.put(payload);
  await fs.writeFile(store.location(ref.digest), 'corrupt');
  await assert.rejects(store.get(ref.digest), { code: 'MATERIAL_CORRUPT' });
  await assert.rejects(store.put(payload), { code: 'MATERIAL_CORRUPT' });
  assert.equal(await fs.readFile(store.location(ref.digest), 'utf8'), 'corrupt');
});

test('enforces limits for publication and for modified objects on disk', async t => {
  const { store } = await fixture(t, { maxBytes: 4 });
  const ref = await store.put(Buffer.from('four'));
  await assert.rejects(store.put(Buffer.from('large')), { code: 'MATERIAL_TOO_LARGE' });
  await fs.writeFile(store.location(ref.digest), 'larger on disk');
  await assert.rejects(store.get(ref.digest), { code: 'MATERIAL_TOO_LARGE' });
  await assert.rejects(store.put('not bytes'), { code: 'INVALID_BYTES' });
});

test('rejects linked entries and linked material directories', { skip: process.platform === 'win32' }, async t => {
  const { root, store } = await fixture(t);
  const payload = Buffer.from('outside'), digest = digestBytes(payload);
  const outside = path.join(root, 'outside');
  await fs.writeFile(outside, payload);
  await store.ensureDirectory();
  await fs.symlink(outside, store.location(digest));
  await assert.rejects(store.get(digest), { code: 'INVALID_MATERIAL' });
  await assert.rejects(store.put(payload), { code: 'INVALID_MATERIAL' });
  const linked = path.join(root, 'linked');
  await fs.symlink(store.directory, linked, 'dir');
  await assert.rejects(new MaterialStore(linked).put(Buffer.from('new')), { code: 'INVALID_DIRECTORY' });
});

test('rejects directories used as content entries', async t => {
  const { store } = await fixture(t);
  await store.ensureDirectory();
  await fs.mkdir(store.location(digestBytes(Buffer.from('content'))));
  await assert.rejects(store.put(Buffer.from('content')), { code: 'INVALID_MATERIAL' });
});

test('requires an absolute application directory and a bounded byte limit', () => {
  assert.throws(() => new MaterialStore('relative'), { code: 'INVALID_DIRECTORY' });
  for (const maxBytes of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(() => new MaterialStore(os.tmpdir(), { maxBytes }), { code: 'INVALID_LIMIT' });
  }
});

test('streams large immutable objects independently of bounded reader limits', async t => {
  const {store}=await fixture(t,{maxBytes:4});
  const chunk=Buffer.alloc(256*1024,37),count=129;
  async function* input(){for(let i=0;i<count;i++)yield chunk;}
  const ref=await store.putStream(input());
  assert.equal(ref.byteLength,chunk.length*count);
  assert.deepEqual(await store.verify(ref.digest),ref);
  await assert.rejects(store.get(ref.digest),{code:'MATERIAL_TOO_LARGE'});
  const copied=new MaterialStore(path.join(path.dirname(store.directory),'copied'),{maxBytes:4});
  assert.deepEqual(await store.withObject(ref.digest,file=>copied.putStream(file.stream(),{digest:ref.digest})),ref);
  assert.deepEqual(await copied.verify(ref.digest),ref);
  await assert.rejects(store.putStream([Buffer.from('wrong')],{digest:ref.digest}),{code:'MATERIAL_CORRUPT'});
  assert.deepEqual(await fs.readdir(store.directory),[ref.digest]);
});
