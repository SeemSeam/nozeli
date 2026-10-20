import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

export const digestText = (text) => createHash('sha256').update(text).digest('hex');

export const handoffDigest = (text, tags = []) => tags.length ? digestText(JSON.stringify({ text, tags })) : digestText(text);

export async function writeRuntimeFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

export function startHandoff(onSubmit) {
  const grants = new Map();
  const accepted = new Map();
  const flights = new Map();
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      const raw = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) });
      res.end(raw);
    };
    if (req.method !== 'POST' || req.url !== '/handoff') { send(404, { error: 'not found' }); return; }
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const grant = grants.get(token);
    if (!grant || grant.revoked || grant.role !== 'qa') { send(401, { error: 'handoff grant rejected' }); return; }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) { send(413, { error: 'handoff body is too large' }); return; }
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { send(400, { error: 'invalid handoff body' }); return; }
    if (typeof body?.text !== 'string' || !body.text.trim() || body.digest !== handoffDigest(body.text, Array.isArray(body.tags) ? body.tags : [])) { send(400, { error: 'handoff requires frozen natural-language text' }); return; }
    if (body.role && body.role !== grant.role) { send(403, { error: 'handoff role does not match the granted slot' }); return; }
    if (body.projectId && body.projectId !== grant.projectId) { send(403, { error: 'handoff project does not match the granted project' }); return; }
    if (typeof body.handoffId !== 'string' || !body.handoffId) { send(400, { error: 'handoff identity is missing' }); return; }
    if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > 32 || body.tags.some(tag => !tag || typeof tag.relPath !== 'string' || typeof tag.annotationId !== 'string'))) { send(400, { error: 'invalid tag references' }); return; }
    const key = `${grant.projectId}\0${body.handoffId}`;
    const previous = accepted.get(key);
    if (previous) {
      if (previous.digest !== body.digest) { send(409, { error: 'handoff identity reused with different frozen content' }); return; }
      send(200, { ...previous, duplicate: true }); return;
    }
    const flight = flights.get(key);
    if (flight) { if (flight.digest !== body.digest) { send(409, { error: 'handoff identity reused with different frozen content' }); return; } const result = await flight.promise; send(result.status, result.body); return; }
    const run = (async () => {
      const acceptedRecord = await onSubmit({ id: body.handoffId, projectId: grant.projectId, parentRequestId: grant.parentRequestId, text: body.text, digest: body.digest, tags: body.tags || [] });
      const record = { id: acceptedRecord.id, digest: body.digest, parentRequestId: grant.parentRequestId, duplicate: false, status: acceptedRecord.status };
      accepted.set(key, record);
      return { status: 200, body: record };
    })().catch((error) => ({ status: error.status || 409, body: { error: error.message || 'handoff rejected' } }));
    flights.set(key, { digest: body.digest, promise: run });
    const result = await run;
    flights.delete(key);
    send(result.status, result.body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.unref();
      resolve({
        url: `http://127.0.0.1:${address.port}/handoff`,
        issueGrant({ projectId, parentRequestId, handoffId = randomUUID() }) {
          const token = randomBytes(32).toString('hex');
          grants.set(token, { token, projectId, role: 'qa', parentRequestId, handoffId, revoked: false });
          return { token, handoffId };
        },
        revoke(token) { const grant = grants.get(token); if (grant) grant.revoked = true; },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export async function submitHandoff(runtimeFile, taskFile, { handoffId, tags = [], text: frozenText } = {}) {
  if (!path.isAbsolute(runtimeFile) || !path.isAbsolute(taskFile)) throw new Error('handoff paths must be absolute');
  const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
  if (runtime.role !== 'qa' || typeof runtime.token !== 'string' || typeof runtime.url !== 'string' || typeof runtime.projectId !== 'string') throw new Error('handoff runtime file is not a qa grant');
  const text = frozenText ?? await readFile(taskFile, 'utf8');
  const body = { handoffId: handoffId || randomUUID(), text, tags, digest: handoffDigest(text, tags) };
  if (!body.handoffId) throw new Error('handoff runtime has no stable identity');
  const response = await fetch(runtime.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${runtime.token}` }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `handoff failed (${response.status})`);
  return payload;
}
