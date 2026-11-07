import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MARKER = '.plantree-demo-owned.json';
const DIGEST = /^[a-f0-9]{64}$/;
const TYPES = new Set(['plan', 'decision', 'implementation', 'test', 'report', 'knowledge']);
export class StoreError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new StoreError(code, message, status); };
function text(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_INPUT', `${name} must be a nonempty string of at most ${max} characters`);
  return value.trim();
}
function noSymlinks(target) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('UNSAFE_PATH', 'Symlink paths are not allowed');
  }
}
function regular(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) fail('UNSAFE_OBJECT', 'Expected a singly-linked regular owned file');
  return s;
}
function tokenize(value) {
  const parts = value.toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) || [];
  return parts.flatMap(part => {
    if (!/^\p{Script=Han}+$/u.test(part)) return [part];
    const chars = [...part];
    return [...chars, ...chars.slice(1).map((c, i) => chars[i] + c)];
  });
}

export class TreeStore {
  constructor(root, { clock = () => Date.now(), fault = () => {} } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('UNSAFE_ROOT', 'An absolute isolated demo root is required');
    this.root = path.resolve(root);
    if (this.root.split(path.sep).includes('.nozeli') || this.root === path.parse(this.root).root) fail('UNSAFE_ROOT', 'Product roots are forbidden');
    noSymlinks(this.root);
    const marker = path.join(this.root, MARKER);
    if (fs.existsSync(this.root)) {
      if (!fs.statSync(this.root).isDirectory() || !fs.existsSync(marker)) fail('UNSAFE_ROOT', 'Existing directory is not an owned demo root');
      regular(marker);
      let value;
      try { value = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { fail('UNSAFE_ROOT', 'Invalid ownership marker'); }
      if (value.kind !== 'plantree-lifecycle-demo' || value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.id)) fail('UNSAFE_ROOT', 'Invalid ownership marker');
      this.owner = value.id;
    } else {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      this.owner = randomUUID();
      fs.writeFileSync(marker, JSON.stringify({ kind: 'plantree-lifecycle-demo', version: 1, id: this.owner }), { flag: 'wx', mode: 0o600 });
    }
    this.clock = clock; this.fault = fault; this.plans = new Map();
    this.objects = path.join(this.root, 'objects', 'sha256');
    noSymlinks(this.objects);
    fs.mkdirSync(this.objects, { recursive: true, mode: 0o700 });
    const dbPath = path.join(this.root, 'tree.sqlite');
    for (const name of ['tree.sqlite', 'tree.sqlite-wal', 'tree.sqlite-shm']) {
      const file = path.join(this.root, name); noSymlinks(file); if (fs.existsSync(file)) regular(file);
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('revision',0);
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, parentId TEXT REFERENCES nodes(id), title TEXT NOT NULL, status TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, archivedAt INTEGER, archiveRevision INTEGER, archiveBatch TEXT, restoredAt INTEGER, restoreRevision INTEGER);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, nodeId TEXT NOT NULL REFERENCES nodes(id), type TEXT NOT NULL, title TEXT NOT NULL, digest TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS versions (docId TEXT NOT NULL REFERENCES documents(id), revision INTEGER NOT NULL, digest TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(docId,revision));
      CREATE TABLE IF NOT EXISTS refs (fromId TEXT NOT NULL REFERENCES documents(id), toId TEXT NOT NULL REFERENCES documents(id), PRIMARY KEY(fromId,toId));
      CREATE INDEX IF NOT EXISTS node_parent ON nodes(parentId);
      CREATE INDEX IF NOT EXISTS document_node ON documents(nodeId);
      CREATE INDEX IF NOT EXISTS version_digest ON versions(digest);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_cache USING fts5(docId UNINDEXED, tokens);
    `);
    // Canonical writes and their projection update share a transaction. Reopen does
    // not rewrite a valid cache; explicit rebuild also recovers damaged contents.
    if (this.db.prepare('SELECT count(*) n FROM search_cache').get().n !== this.db.prepare('SELECT count(*) n FROM documents').get().n) this.rebuild();
  }
  get revision() { return this.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value; }
  now() { const n = this.clock(); return n instanceof Date ? n.getTime() : Number(n); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  bump() { this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run(); return this.revision; }
  expected(value) { if (!Number.isSafeInteger(value) || value !== this.revision) fail('STALE_REVISION', `Expected current global revision ${this.revision}`, 409); }
  node(id) { const n = this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id ?? ''); if (!n) fail('NOT_FOUND', 'Node not found', 404); return n; }
  doc(id) { const d = this.db.prepare('SELECT * FROM documents WHERE id=?').get(id ?? ''); if (!d) fail('NOT_FOUND', 'Document not found', 404); return d; }
  activeNode(id) { const n = this.node(id); if (n.archived) fail('ARCHIVED', 'Restore node before editing', 409); return n; }
  objectPath(digest) { if (!DIGEST.test(digest)) fail('INVALID_DIGEST', 'Invalid object digest'); noSymlinks(this.objects); return path.join(this.objects, digest); }
  readObject(digest) {
    const file = this.objectPath(digest); regular(file);
    const body = fs.readFileSync(file, 'utf8');
    if (createHash('sha256').update(body).digest('hex') !== digest) fail('CORRUPT_OBJECT', 'Object checksum mismatch', 500);
    return body;
  }
  putObject(body) {
    const digest = createHash('sha256').update(body).digest('hex');
    const file = this.objectPath(digest);
    if (fs.existsSync(file)) { if (this.readObject(digest) !== body) fail('CORRUPT_OBJECT', 'Object content mismatch', 500); }
    else {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // Filesystem directory entry must be durable before SQLite can refer to it.
      const dir = fs.openSync(this.objects, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      fs.utimesSync(file, this.now() / 1000, this.now() / 1000);
    }
    this.fault('afterObject'); return digest;
  }
  metadata(d) { const n = this.node(d.nodeId); return { ...d, pinned: !!d.pinned, archived: !!n.archived }; }
  state({ history = false } = {}) {
    const nodes = this.db.prepare(`SELECT * FROM nodes ${history ? '' : 'WHERE archived=0'} ORDER BY rowid`).all().map(n => ({ ...n, pinned: !!n.pinned, archived: !!n.archived }));
    const documents = this.db.prepare(`SELECT d.* FROM documents d JOIN nodes n ON n.id=d.nodeId ${history ? '' : 'WHERE n.archived=0'} ORDER BY d.rowid`).all().map(d => this.metadata(d));
    const counts = this.db.prepare('SELECT count(*) totalNodes, sum(CASE WHEN archived=0 THEN 1 ELSE 0 END) activeNodes, sum(archived) archivedNodes FROM nodes').get();
    return { revision: this.revision, nodes, documents, stats: { ...counts, activeNodes: counts.activeNodes || 0, archivedNodes: counts.archivedNodes || 0, documents: this.db.prepare('SELECT count(*) n FROM documents').get().n, versions: this.db.prepare('SELECT count(*) n FROM versions').get().n, references: this.db.prepare('SELECT count(*) n FROM refs').get().n, searchMode: 'lexical FTS5; Han characters/bigrams; no semantic model' } };
  }
  document(id, { revision } = {}) {
    const d = this.doc(id);
    let selected = { revision: d.revision, digest: d.digest, title: d.title };
    if (revision !== undefined) {
      if (!Number.isSafeInteger(revision) || revision < 1) fail('INVALID_REVISION', 'Positive document revision required');
      selected = this.db.prepare('SELECT revision,digest,title,createdAt FROM versions WHERE docId=? AND revision=?').get(id, revision);
      if (!selected) fail('NOT_FOUND', 'Document version not found', 404);
    }
    return { ...this.metadata(d), ...selected, currentRevision: d.revision, body: this.readObject(selected.digest), versions: this.db.prepare('SELECT revision,digest,title,createdAt FROM versions WHERE docId=? ORDER BY revision DESC').all(id), references: this.db.prepare('SELECT toId FROM refs WHERE fromId=?').all(id).map(r => r.toId) };
  }
  search({ q = '', history = false, offset = 0, limit = 20 } = {}) {
    if (typeof q !== 'string' || q.length > 256) fail('INVALID_QUERY', 'Query is limited to 256 characters');
    offset = Number(offset); limit = Number(limit);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_QUERY', 'offset 0..100000 and limit 1..100 required');
    const tokens = [...new Set(tokenize(q))].slice(0, 64);
    const match = tokens.map(t => `"${t.replaceAll('"', '""')}"`).join(' AND ');
    const where = `${history ? '1' : 'n.archived=0'}${match ? ' AND search_cache MATCH ?' : ''}`;
    const from = `FROM search_cache JOIN documents d ON d.id=search_cache.docId JOIN nodes n ON n.id=d.nodeId WHERE ${where}`;
    const args = match ? [match] : [];
    const total = this.db.prepare(`SELECT count(*) n ${from}`).get(...args).n;
    const rows = this.db.prepare(`SELECT d.*, n.archived ${from} ORDER BY d.rowid LIMIT ? OFFSET ?`).all(...args, limit, offset).map(d => {
      const body = this.readObject(d.digest);
      let position = q ? body.toLowerCase().indexOf(q.toLowerCase()) : 0;
      position = Math.max(0, position - 50);
      return { docId: d.id, nodeId: d.nodeId, title: d.title, type: d.type, status: d.status, archived: !!d.archived, excerpt: body.slice(position, position + 240) };
    });
    return { revision: this.revision, total, rows, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }
  index(d, body) {
    this.db.prepare('DELETE FROM search_cache WHERE docId=?').run(d.id);
    this.db.prepare('INSERT INTO search_cache(docId,tokens) VALUES (?,?)').run(d.id, tokenize(`${d.title} ${body}`).join(' '));
  }
  createNode({ parentId = null, title } = {}) {
    title = text(title, 'title');
    return this.transaction(() => {
      if (parentId !== null) this.activeNode(parentId);
      const id = randomUUID(), revision = this.bump();
      this.db.prepare('INSERT INTO nodes(id,parentId,title,status,revision) VALUES (?,?,?,?,?)').run(id, parentId, title, 'active', revision);
      return this.node(id);
    });
  }
  setNodeStatus({ id, status, expectedRevision } = {}) {
    if (!['active', 'done', 'conflict'].includes(status)) fail('INVALID_STATUS', 'Invalid node status');
    return this.transaction(() => { this.expected(expectedRevision); const n = this.activeNode(id); if (n.status !== status) this.db.prepare('UPDATE nodes SET status=?,revision=? WHERE id=?').run(status, this.bump(), id); return this.node(id); });
  }
  writeDocument({ nodeId, type, title, body, existingId, expectedDocumentRevision } = {}) {
    if (!TYPES.has(type)) fail('INVALID_TYPE', 'Unsupported document type');
    title = text(title, 'title');
    if (typeof body !== 'string' || Buffer.byteLength(body) > 1000000) fail('INVALID_BODY', 'Body must be a string up to 1000000 UTF-8 bytes');
    // Serialize publication with archival and GC across every SQLite connection.
    // File durability precedes the DB reference, but both share this write lock.
    const value = this.transaction(() => {
      this.activeNode(nodeId);
      let existing = existingId ? this.doc(existingId) : null;
      if (existing && (existing.nodeId !== nodeId || existing.type !== type)) fail('DOCUMENT_ROLE_MISMATCH', 'Document belongs to a different node or role', 409);
      if (!existing) {
        const matches = this.db.prepare('SELECT * FROM documents WHERE nodeId=? AND type=?').all(nodeId, type);
        if (matches.length > 1) fail('AMBIGUOUS_ROLE', 'Specify existingId for this role', 409);
        existing = matches[0];
      }
      if (existing && (!Number.isSafeInteger(expectedDocumentRevision) || expectedDocumentRevision !== existing.revision)) fail('STALE_DOCUMENT', `Expected document revision ${existing.revision}`, 409);
      const digest = this.putObject(body);
      const revision = existing ? existing.revision + 1 : 1;
      const id = existing?.id || randomUUID();
      if (existing) this.db.prepare('UPDATE documents SET title=?,digest=?,revision=? WHERE id=?').run(title, digest, revision, id);
      else this.db.prepare('INSERT INTO documents(id,nodeId,type,title,digest,revision,status) VALUES (?,?,?,?,?,?,?)').run(id, nodeId, type, title, digest, revision, type === 'knowledge' ? 'proposed' : 'active');
      this.db.prepare('INSERT INTO versions VALUES (?,?,?,?,?)').run(id, revision, digest, title, this.now());
      this.bump(); const d = this.doc(id); this.index(d, body); return this.metadata(d);
    });
    this.fault('afterDb'); return value;
  }
  pin({ id, kind, pinned, expectedRevision } = {}) {
    if (!['node', 'document'].includes(kind) || typeof pinned !== 'boolean') fail('INVALID_INPUT', 'kind and boolean pinned are required');
    return this.transaction(() => {
      this.expected(expectedRevision); const item = kind === 'node' ? this.node(id) : this.doc(id);
      if (!!item.pinned !== pinned) this.db.prepare(`UPDATE ${kind === 'node' ? 'nodes' : 'documents'} SET pinned=? WHERE id=?`).run(Number(pinned), id), this.bump();
      return kind === 'node' ? this.node(id) : this.metadata(this.doc(id));
    });
  }
  reference({ fromId, toId } = {}) {
    return this.transaction(() => { this.doc(fromId); this.doc(toId); const r = this.db.prepare('INSERT OR IGNORE INTO refs VALUES (?,?)').run(fromId, toId); if (r.changes) this.bump(); return { fromId, toId, revision: this.revision }; });
  }
  subtree(id, allNodes) {
    const children = new Map();
    for (const n of allNodes) { if (!children.has(n.parentId)) children.set(n.parentId, []); children.get(n.parentId).push(n); }
    const result = [], seen = new Set(), queue = [this.node(id)];
    while (queue.length) { const n = queue.pop(); if (seen.has(n.id)) fail('TREE_CYCLE', 'Canonical tree contains a cycle', 409); seen.add(n.id); result.push(n); queue.push(...(children.get(n.id) || [])); }
    return result;
  }
  cleanupAnalysis() {
    const nodes = this.db.prepare('SELECT * FROM nodes').all();
    const docs = this.db.prepare('SELECT * FROM documents').all();
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const docById = new Map(docs.map(d => [d.id, d]));
    const refs = this.db.prepare('SELECT * FROM refs').all();
    // Build the tree once. Rebuilding it and scanning every document for each
    // finished node made the common flat-history workload quadratic.
    const children = new Map(), reasons = new Map(nodes.map(n => [n.id, new Set()]));
    for (const n of nodes) {
      if (!children.has(n.parentId)) children.set(n.parentId, []);
      children.get(n.parentId).push(n);
      if (n.status !== 'done') reasons.get(n.id).add(`${n.status} descendant: ${n.title}`);
      if (n.pinned) reasons.get(n.id).add(`pinned node: ${n.title}`);
    }
    for (const d of docs) if (d.pinned) reasons.get(d.nodeId).add(`pinned document: ${d.title}`);
    const order = [], entry = new Map(), end = new Map(), inheritedPin = new Map();
    const stack = (children.get(null) || []).map(n => [n, false, false]);
    while (stack.length) {
      const [n, leaving, ancestorPin] = stack.pop();
      if (leaving) { end.set(n.id, order.length); continue; }
      if (entry.has(n.id)) fail('TREE_CYCLE', 'Canonical tree contains a cycle', 409);
      entry.set(n.id, order.length); order.push(n); inheritedPin.set(n.id, ancestorPin);
      stack.push([n, true, ancestorPin]);
      for (const child of children.get(n.id) || []) stack.push([child, false, ancestorPin || !!n.pinned]);
    }
    if (order.length !== nodes.length) fail('TREE_CYCLE', 'Canonical tree has an unreachable cycle', 409);
    const contains = (ancestor, id) => entry.get(id) >= entry.get(ancestor) && entry.get(id) < end.get(ancestor);
    // Bounded explanations avoid copying every descendant title up the tree.
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i], own = reasons.get(n.id);
      if (n.parentId) for (const reason of own) {
        const parentReasons = reasons.get(n.parentId);
        if (parentReasons.size < 8) parentReasons.add(reason);
      }
    }
    // A live consumer protects each source ancestor until their common subtree.
    for (const r of refs) {
      const from = docById.get(r.fromId), to = docById.get(r.toId);
      if (nodeById.get(from.nodeId).archived) continue;
      let at = to.nodeId;
      while (at && !contains(at, from.nodeId)) {
        reasons.get(at).add(`live source reference: ${from.title} → ${to.title}`);
        at = nodeById.get(at).parentId;
      }
    }
    const eligible = new Set(), blocked = [];
    for (const n of nodes.filter(n => !n.archived && n.status === 'done')) {
      const why = reasons.get(n.id);
      if (inheritedPin.get(n.id)) why.add('pinned ancestor protects this branch');
      if (why.size) blocked.push({ nodeId: n.id, title: n.title, reasons: [...why].slice(0, 8) });
      else eligible.add(n.id);
    }
    const candidates = nodes.filter(n => eligible.has(n.id) && !eligible.has(n.parentId)).map(n => ({ nodeId: n.id, title: n.title, reason: 'done subtree without active/conflict/pin/live external source references' }));
    const selected = new Set(candidates.map(c => c.nodeId)), archived = new Set();
    const under = new Map();
    for (const n of order) { const included = selected.has(n.id) || under.get(n.parentId) === true; under.set(n.id, included); if (included && !n.archived) archived.add(n.id); }
    return { candidates, blocked, estimatedActiveAfter: nodes.filter(n => !n.archived).length - archived.size, nodeIds: [...archived].sort() };
  }
  remember(kind, value) {
    const id = randomUUID(); this.plans.set(id, { kind, ...value });
    while (this.plans.size > 32) this.plans.delete(this.plans.keys().next().value);
    return id;
  }
  previewCleanup() {
    const analysis = this.cleanupAnalysis(), revision = this.revision;
    const id = this.remember('cleanup', { revision, nodeIds: analysis.nodeIds });
    const { nodeIds, ...visible } = analysis;
    return { id, revision, ...visible };
  }
  plan(id, kind, expectedRevision) {
    this.expected(expectedRevision); const p = this.plans.get(id);
    if (!p || p.kind !== kind) fail('INVALID_PLAN', 'Preview plan missing or expired', 409);
    if (p.revision !== this.revision) fail('STALE_PLAN', 'State changed since preview', 409);
    return p;
  }
  applyCleanup({ id, expectedRevision } = {}) {
    const value = this.transaction(() => {
      const p = this.plan(id, 'cleanup', expectedRevision), current = this.cleanupAnalysis();
      if (JSON.stringify(p.nodeIds) !== JSON.stringify(current.nodeIds)) fail('STALE_PLAN', 'Cleanup protection changed', 409);
      if (p.nodeIds.length) {
        const revision = this.bump(), archivedAt = this.now();
        const update = this.db.prepare('UPDATE nodes SET archived=1,revision=?,archivedAt=?,archiveRevision=?,archiveBatch=? WHERE id=?');
        for (const nodeId of p.nodeIds) update.run(revision, archivedAt, revision, id, nodeId);
      }
      this.fault('beforeArchiveCommit');
      return { revision: this.revision, archived: p.nodeIds, archivedCount: p.nodeIds.length };
    });
    this.plans.delete(id); this.fault('afterArchiveCommit'); return value;
  }
  restore({ nodeId, expectedRevision } = {}) {
    return this.transaction(() => {
      this.expected(expectedRevision); const n = this.node(nodeId);
      if (!n.archived) fail('NOT_ARCHIVED', 'Node is already active', 409);
      if (n.parentId && this.node(n.parentId).archived) fail('ARCHIVED_PARENT', `Restore archived ancestor first: ${n.parentId}`, 409);
      const nodes = this.subtree(nodeId, this.db.prepare('SELECT * FROM nodes').all());
      // IDs are stable, so title collisions are not identity conflicts and do not merge.
      const revision = this.bump(), restoredAt = this.now(), update = this.db.prepare('UPDATE nodes SET archived=0,revision=?,restoredAt=?,restoreRevision=? WHERE id=?');
      for (const child of nodes) update.run(revision, restoredAt, revision, child.id);
      return { revision, restored: nodes.map(c => c.id), previousArchives: nodes.map(c => ({ nodeId: c.id, archiveRevision: c.archiveRevision, archiveBatch: c.archiveBatch, archivedAt: c.archivedAt })), diagnostics: nodes.filter(c => c.status === 'conflict').map(c => ({ nodeId: c.id, code: 'UNRESOLVED_CONFLICT' })) };
    });
  }
  rebuild() {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM search_cache').run();
      for (const d of this.db.prepare('SELECT * FROM documents').all()) this.index(d, this.readObject(d.digest));
      return { revision: this.revision, rebuilt: this.db.prepare('SELECT count(*) n FROM documents').get().n };
    });
  }
  referencedDigests() { return new Set(this.db.prepare('SELECT digest FROM versions UNION SELECT digest FROM documents').all().map(r => r.digest)); }
  gcAnalysis() {
    noSymlinks(this.objects);
    const protectedDigests = this.referencedDigests(), candidates = [];
    for (const name of fs.readdirSync(this.objects)) {
      if (!DIGEST.test(name) || protectedDigests.has(name)) continue;
      const file = this.objectPath(name);
      let s; try { s = regular(file); } catch (e) { if (e.code === 'UNSAFE_OBJECT') continue; throw e; }
      if (this.now() - s.mtimeMs < 60000) continue;
      // Unknown files are never deleted solely because their name looks like a digest.
      const bytes = fs.readFileSync(file);
      if (createHash('sha256').update(bytes).digest('hex') !== name) continue;
      candidates.push({ digest: name, bytes: s.size, dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
    }
    candidates.sort((a, b) => a.digest.localeCompare(b.digest));
    return { candidates, protectedCount: protectedDigests.size };
  }
  previewGc() {
    const analysis = this.gcAnalysis(), revision = this.revision;
    const id = this.remember('gc', { revision, candidates: analysis.candidates });
    return { id, revision, candidates: analysis.candidates.map(({ digest, bytes }) => ({ digest, bytes })), protectedCount: analysis.protectedCount };
  }
  applyGc({ id, expectedRevision } = {}) {
    return this.transaction(() => {
      const p = this.plan(id, 'gc', expectedRevision), current = this.gcAnalysis();
      if (JSON.stringify(p.candidates) !== JSON.stringify(current.candidates)) fail('STALE_PLAN', 'Object identity, age, or references changed', 409);
      this.fault('beforeGcDelete');
      const protectedDigests = this.referencedDigests();
      for (const c of p.candidates) {
        if (protectedDigests.has(c.digest)) fail('STALE_PLAN', 'Object acquired a reference', 409);
        const file = this.objectPath(c.digest), s = regular(file);
        if (s.dev !== c.dev || s.ino !== c.ino || s.size !== c.bytes || s.mtimeMs !== c.mtimeMs || s.ctimeMs !== c.ctimeMs || this.now() - s.mtimeMs < 60000) fail('STALE_PLAN', 'Object identity changed', 409);
        fs.unlinkSync(file);
        this.fault('afterGcDelete');
      }
      this.plans.delete(id);
      return { revision: this.revision, deleted: p.candidates.map(c => c.digest), bytes: p.candidates.reduce((n, c) => n + c.bytes, 0) };
    });
  }
  close() { this.db.close(); }
}
