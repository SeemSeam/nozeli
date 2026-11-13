import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {serveStaticAsset} from '../src/main/static-assets.cjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-static-stream-'));
  const server = http.createServer(async (req, res) => {
    try {
      await serveStaticAsset(req, res, path.join(root, req.url.slice(1)), {
        'content-type': req.url.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream',
        'x-content-type-options': 'nosniff',
      }, {template: req.url.endsWith('.html'), styleNonce: 'test-nonce'});
    } catch (error) {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); }
      else res.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, {recursive: true, force: true}); });
  return {root, url: 'http://127.0.0.1:' + server.address().port};
}

test('streamed engine assets preserve all binary bytes; HEAD reports length without a body', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await fs.writeFile(path.join(f.root, 'engine.bin'), bytes);
  const response = await fetch(f.url + '/engine.bin');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  const received = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(received).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  const head = await fetch(f.url + '/engine.bin', {method: 'HEAD'});
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(await head.text(), '');
  assert.equal((await fetch(f.url + '/missing.bin')).status, 404);
});

test('HTML nonce rewrite retains Unicode content and truthful byte length', async t => {
  const f = await fixture(t), original = '<meta content="__NOZELI_STYLE_NONCE__"><p>正文✓</p><style nonce="__NOZELI_STYLE_NONCE__"></style>';
  await fs.writeFile(path.join(f.root, 'index.html'), original);
  const expected = original.replaceAll('__NOZELI_STYLE_NONCE__', 'test-nonce'), response = await fetch(f.url + '/index.html');
  assert.equal(await response.text(), expected);
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(expected)));
  const head = await fetch(f.url + '/index.html', {method: 'HEAD'});
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(expected))); assert.equal(await head.text(), '');
});

test('aborting an asset stream does not prevent a subsequent complete read', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(8 * 1024 * 1024, 37);
  await fs.writeFile(path.join(f.root, 'large.bin'), bytes);
  await new Promise((resolve, reject) => {
    const request = http.get(f.url + '/large.bin', response => {
      response.once('data', () => { response.destroy(); request.destroy(); resolve(); });
      response.on('error', () => {});
    });
    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  const response = await fetch(f.url + '/large.bin');
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});
