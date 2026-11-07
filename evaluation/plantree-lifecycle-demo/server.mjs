import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TreeStore, StoreError } from './engine.mjs';

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const FAULTS = new Set(['afterObject', 'afterDb', 'beforeArchiveCommit', 'afterArchiveCommit', 'beforeGcDelete', 'afterGcDelete']);
function options(argv) {
  const result = { port: 0, fixture: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixture') result.fixture = true;
    else if (arg === '--root') result.root = argv[++i];
    else if (arg === '--port') result.port = Number(argv[++i]);
    else if (arg === '--fault') result.fault = argv[++i];
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!result.root || !Number.isInteger(result.port) || result.port < 0 || result.port > 65535) throw new Error('Usage: node server.mjs --root /tmp/unique-demo [--port 0] [--fixture] [--fault NAME]');
  if (result.fault && !FAULTS.has(result.fault)) throw new Error('Unknown fault point');
  return result;
}

export function fixture(store) {
  if (store.state({ history: true }).nodes.length) return;
  const create = (title, parentId) => store.createNode({ title, parentId });
  const write = (n, type, title, body) => store.writeDocument({ nodeId: n.id, type, title, body });
  const done = n => store.setNodeStatus({ id: n.id, status: 'done', expectedRevision: store.revision });
  const lifecycle = create('目标一 · 动态清理与可恢复历史');
  write(lifecycle, 'plan', '生命周期验收计划', '真实SQLite与内容寻址对象。完成子树默认归档，不丢正文。历史搜索与恢复保持稳定ID。');
  const completed = create('已完成 · 可安全归档', lifecycle.id);
  write(completed, 'report', '完成报告', '归档检索样例：青山数据。This completed report remains available in history after cleanup.'); done(completed);
  const source = create('已完成 · 被外部来源引用', lifecycle.id);
  const sourceDoc = write(source, 'decision', '冻结来源决策', '来源引用必须保护确切文档身份，禁止按标题去重。'); done(source);
  const safety = create('目标二 · 活跃与冲突保护');
  const parent = create('已完成父节点 · 活跃子节点阻止清理', safety.id);
  const child = create('仍在执行的子任务', parent.id);
  const consumer = write(child, 'implementation', '引用来源的实现', 'This active implementation references an exact source document.');
  store.reference({ fromId: consumer.id, toId: sourceDoc.id }); done(parent);
  const conflict = create('冲突待处理', safety.id);
  write(conflict, 'test', '冲突诊断', '冲突状态永远不会被自动清理。');
  store.setNodeStatus({ id: conflict.id, status: 'conflict', expectedRevision: store.revision });
  const knowledge = create('目标三 · 知识与用户固定');
  write(knowledge, 'knowledge', '待审核知识', '知识默认proposed。词法中英文搜索不代表已测试语义清理；当前demo完全不调用模型。');
  const pinned = create('已完成 · 用户固定保留', knowledge.id);
  const pinnedDoc = write(pinned, 'report', '固定报告', 'Pinned report protected from automatic archival and all referenced versions protected from object GC.');
  done(pinned); store.pin({ id: pinnedDoc.id, kind: 'document', pinned: true, expectedRevision: store.revision });
}

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function payload(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new StoreError('CONTENT_TYPE', 'application/json required', 415);
  if (Number(req.headers['content-length']) > 1048576) { req.resume(); throw new StoreError('PAYLOAD_TOO_LARGE', 'Maximum payload is 1 MiB', 413); }
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1048576) { req.resume(); throw new StoreError('PAYLOAD_TOO_LARGE', 'Maximum payload is 1 MiB', 413); }
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new StoreError('INVALID_JSON', 'Valid JSON object required'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new StoreError('INVALID_JSON', 'JSON object required');
  return result;
}

export function createDemoServer(store) {
  const routes = new Map([
    ['/api/node', 'createNode'], ['/api/node/status', 'setNodeStatus'], ['/api/document', 'writeDocument'], ['/api/pin', 'pin'], ['/api/reference', 'reference'],
    ['/api/cleanup/preview', 'previewCleanup'], ['/api/cleanup/apply', 'applyCleanup'], ['/api/restore', 'restore'], ['/api/cache/rebuild', 'rebuild'], ['/api/gc/preview', 'previewGc'], ['/api/gc/apply', 'applyGc'],
  ]);
  const server = http.createServer(async (req, res) => {
    try {
      const address = server.address();
      const host = `127.0.0.1:${address.port}`;
      if (req.headers.host !== host) throw new StoreError('FORBIDDEN_HOST', 'Only the bound loopback Host is accepted', 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new StoreError('FORBIDDEN_ORIGIN', 'Cross-origin access is forbidden', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new StoreError('FORBIDDEN_ORIGIN', 'Cross-site requests are forbidden', 403);
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        let value;
        if (req.method === 'GET') {
          const history = url.searchParams.get('history') === '1';
          if (url.pathname === '/api/state') value = store.state({ history });
          else if (url.pathname === '/api/document') value = store.document(url.searchParams.get('id'), { revision: url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined });
          else if (url.pathname === '/api/search') value = store.search({ q: url.searchParams.get('q') || '', history, offset: url.searchParams.get('offset') ?? 0, limit: url.searchParams.get('limit') ?? 20 });
          else throw new StoreError('NOT_FOUND', 'Unknown endpoint', 404);
        } else if (req.method === 'POST' && routes.has(url.pathname)) {
          const data = await payload(req);
          value = store[routes.get(url.pathname)](data);
        } else throw new StoreError('METHOD_NOT_ALLOWED', 'Unsupported API method or endpoint', 405);
        send(res, 200, { ok: true, value }); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new StoreError('METHOD_NOT_ALLOWED', 'Static resources are read-only', 405);
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { throw new StoreError('INVALID_PATH', 'Malformed path'); }
      if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) throw new StoreError('INVALID_PATH', 'Invalid static path', 403);
      const file = path.resolve(publicRoot, decoded === '/' ? 'index.html' : `.${decoded}`);
      if (!file.startsWith(publicRoot + path.sep)) throw new StoreError('INVALID_PATH', 'Invalid static path', 403);
      let stat;
      try {
        const real = fs.realpathSync(file);
        if (real !== file || !real.startsWith(publicRoot + path.sep)) throw new StoreError('INVALID_PATH', 'Symlink static paths forbidden', 403);
        stat = fs.statSync(file);
      } catch (e) { if (e instanceof StoreError) throw e; throw new StoreError('NOT_FOUND', 'Resource not found', 404); }
      if (!stat.isFile()) throw new StoreError('NOT_FOUND', 'Resource not found', 404);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof StoreError ? error.status : 500, { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error instanceof StoreError ? error.message : 'Internal storage error; inspect server stderr' } });
      else res.destroy();
      if (!(error instanceof StoreError)) console.error(error);
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = options(process.argv.slice(2));
  const faultName = config.fault || process.env.PLANTREE_FAULT;
  if (faultName && !FAULTS.has(faultName)) throw new Error('Unknown PLANTREE_FAULT');
  // Fixtures are initialized without injection; named faults apply to actual test operations.
  const store = new TreeStore(config.root);
  if (config.fixture) fixture(store);
  store.fault = name => {
    if (name === faultName) { fs.writeSync(2, `PLANTREE_FAULT ${name}\n`); process.kill(process.pid, 'SIGKILL'); }
  };
  const server = createDemoServer(store);
  server.listen(config.port, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, root: store.root })));
  const shutdown = () => server.close(() => { store.close(); process.exit(0); });
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  server.on('error', error => { console.error(error); store.close(); process.exitCode = 1; });
}
