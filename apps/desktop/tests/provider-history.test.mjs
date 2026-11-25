import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rename, rm, readdir, stat, symlink, link, utimes } from 'node:fs/promises';
import { createProviderHistoryReader } from '../src/agents/managed/provider-history.mjs';

const timestamp = '2026-01-01T00:00:00Z';
const header = (provider, cwd, id = 'synthetic') => provider === 'codex'
  ? { type: 'session_meta', timestamp, payload: { id, cwd, timestamp } }
  : ['pi', 'omp'].includes(provider) ? { type: 'session', version: 3, id, cwd, timestamp }
    : { type: 'user', cwd, sessionId: id, timestamp, message: { role: 'user', content: [] } };
const message = (provider, text, role = 'user') => provider === 'codex'
  ? { type: 'response_item', timestamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }
  : { type: ['pi', 'omp'].includes(provider) ? 'message' : role, timestamp, message: { role, content: [{ type: 'text', text }] } };
async function setup(t, options = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'nozeli-provider-history-'));
  const readers = [];
  t.after(async () => { await Promise.all(readers.map(reader => reader.close())); await rm(temp, { recursive: true, force: true }); });
  const project = path.join(temp, 'one', 'same-name');
  const other = path.join(temp, 'two', 'same-name');
  await mkdir(project, { recursive: true }); await mkdir(other, { recursive: true });
  const roots = Object.fromEntries(['codex', 'claude', 'pi', 'omp'].map(p => [p, path.join(temp, 'providers', p)]));
  for (const root of Object.values(roots)) await mkdir(root, { recursive: true });
  const makeReader = extra => {
    const instance = createProviderHistoryReader({ projectRoot: project, projectIdentity: 'host-project-id', providerRoots: roots, ...options, ...extra });
    readers.push(instance);
    return instance;
  };
  const reader = makeReader();
  async function fixture(provider, name, rows) {
    const file = path.join(roots[provider], name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
    return file;
  }
  return { temp, project, other, roots, reader, makeReader, fixture };
}
async function searchAll(reader, args = {}) {
  const items = []; const pages = []; let cursor;
  for (let count = 0; count < 2000; count++) {
    const page = await reader.search({ ...args, cursor }); pages.push(page); items.push(...page.items);
    assert.equal(page.status, 'ok');
    if (!page.hasMore) return { items, pages };
    assert.ok(page.nextCursor); cursor = page.nextCursor;
  }
  assert.fail('Search did not terminate within bounded fixture pages');
}
async function readAll(reader, source, maxBytes = 32768) {
  const records = []; const pages = []; let cursor;
  for (let count = 0; count < 2000; count++) {
    const page = await reader.read({ source, cursor, maxBytes }); pages.push(page);
    assert.equal(page.status, 'ok'); records.push(...page.records);
    assert.ok(page.records.reduce((sum, record) => sum + Buffer.byteLength(record.text), 0) <= maxBytes);
    if (!page.hasMore) return { records, pages };
    cursor = page.nextCursor;
  }
  assert.fail('Read did not terminate within bounded fixture pages');
}

for (const provider of ['codex', 'claude', 'pi']) test(`${provider}: actual transcript envelopes, scoped search and categorized read`, async t => {
  const f = await setup(t);
  const rows = [header(provider, f.project), message(provider, 'synthetic 用户 request'), message(provider, 'answer', 'assistant')];
  if (provider === 'codex') rows.push({ type: 'response_item', timestamp, payload: { type: 'function_call_output', output: 'tool output' } });
  if (provider === 'pi') rows.push({ type: 'message', timestamp, message: { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] } });
  if (provider === 'claude') rows.push({ type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] } });
  rows.push(message(provider, 'SYSTEM-SECRET', 'system'), { type: 'credentials', apiKey: 'NEVER-EXPOSE' });
  await f.fixture(provider, 'bucket/session.jsonl', rows);
  await f.fixture(provider, 'other.jsonl', [header(provider, f.other, 'other'), message(provider, `synthetic mentions ${f.project}`)]);
  const found = await searchAll(f.reader, { provider, query: 'synthetic' });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].sessionId, 'synthetic');
  assert.equal(typeof found.items[0].source, 'string');
  assert.equal(found.items[0].untrusted, true);
  const read = await readAll(f.reader, found.items[0].source);
  assert.deepEqual(read.records.map(r => [r.role, r.category, r.text]), [['user', 'message', 'synthetic 用户 request'], ['assistant', 'message', 'answer'], ['tool', 'tool_result', 'tool output']]);
  assert.ok(read.records.every(r => r.time === timestamp && r.untrusted));
  assert.ok(!JSON.stringify(read).includes('SECRET'));
  assert.ok(!JSON.stringify(read).includes('NEVER-EXPOSE'));
  assert.ok(found.pages.reduce((n, p) => n + p.coverage.unconfirmed, 0) >= 1);
});

test('direct and budgeted history consumers share nullable optionals without weakening tickets or unknown fields',async t=>{
 const f=await setup(t);
 for(const name of ['one','two'])await f.fixture('pi',name+'.jsonl',[header('pi',f.project,name),message('pi','actual history '+name)]);
 for(const host of [undefined,{maxBytes:12000}]){
  const omitted=await f.reader.search({},host);assert.equal(omitted.status,'ok');assert.equal(omitted.items.length,2);
  for(const cursor of [null,'']){
   const first=await f.reader.search({query:null,provider:null,cursor,limit:1},host);assert.equal(first.status,'ok');assert(first.nextCursor);
   const next=await f.reader.search({query:null,provider:null,cursor:first.nextCursor,limit:1},host);assert.equal(next.status,'ok');assert.notEqual(next.items[0].sessionId,first.items[0].sessionId);
   const body=await f.reader.read({source:first.items[0].source,cursor,maxBytes:null},host);assert.equal(body.status,'ok');assert.match(body.records[0].text,/actual history/);
  }
  assert.equal((await f.reader.search({provider:'',cursor:null,limit:null},host)).items.length,2);
  assert.equal((await f.reader.search({cursor:'forged'},host)).status,'invalid_cursor');
  assert.equal((await f.reader.read({source:omitted.items[0].source,cursor:'forged'},host)).status,'invalid_cursor');
  assert.equal((await f.reader.read({source:null,cursor:null},host)).status,'invalid_source');
  assert.throws(()=>f.reader.search({cursor:null,unknown:null},host),{code:'INVALID_PAYLOAD'});
  assert.throws(()=>f.reader.read({source:omitted.items[0].source,unknown:null},host),{code:'INVALID_PAYLOAD'});
 }
});

test('default home layout discovers all four providers without internal options', async t => {
  const f = await setup(t);
  const home = path.join(f.temp, 'home');
  const dirs = { codex: '.codex/sessions/2026/01/01', claude: '.claude/projects/encoded-project', pi: '.pi/agent/sessions/--encoded-project--', omp: '.omp/agent/sessions/--encoded-project--' };
  for (const [provider, dir] of Object.entries(dirs)) {
    const folder = path.join(home, dir); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'session.jsonl'), [header(provider, f.project), message(provider, 'default synthetic')].map(JSON.stringify).join('\n') + '\n');
  }
  const reader = createProviderHistoryReader({ projectRoot: f.project, home });
  t.after(() => reader.close());
  assert.deepEqual((await searchAll(reader)).items.map(i => i.provider).sort(), ['claude', 'codex', 'omp', 'pi']);
  const catalog = await reader.catalog();
  assert.equal(catalog.limited, false);
  assert.deepEqual(catalog.items.map(i => i.provider).sort(), ['claude', 'codex', 'omp', 'pi']);
});

test('source and continuation tickets reject forgery, cross-reader reuse, expiry and replay', async t => {
  let clock = 1000;
  const f = await setup(t, { now: () => clock, ticketTtlMs: 10000 });
  for (const n of ['a', 'b']) await f.fixture('pi', `${n}.jsonl`, [header('pi', f.project, n), message('pi', 'abcdef')]);
  assert.equal((await f.reader.read({ source: path.join(f.roots.pi, 'a.jsonl') })).status, 'invalid_source');
  assert.equal((await f.reader.search({ cursor: 'forged' })).status, 'invalid_cursor');
  const page = await f.reader.search({ provider: 'pi', limit: 1 });
  assert.ok(page.nextCursor);
  const source = page.items[0].source;
  assert.equal((await f.makeReader().read({ source })).status, 'invalid_source');
  assert.equal((await f.makeReader({ projectRoot: f.other }).read({ source })).status, 'invalid_source');
  assert.equal((await f.reader.read({ source, cursor: page.nextCursor })).status, 'invalid_cursor');
  assert.equal((await f.reader.search({ provider: 'pi', cursor: page.nextCursor, query: 'changed' })).status, 'invalid_cursor');
  await f.reader.search({ provider: 'pi', cursor: page.nextCursor });
  assert.equal((await f.reader.search({ provider: 'pi', cursor: page.nextCursor })).status, 'invalid_cursor');
  const first = await f.reader.read({ source, maxBytes: 2 });
  assert.ok(first.hasMore);
  await f.reader.read({ source, cursor: first.nextCursor });
  assert.equal((await f.reader.read({ source, cursor: first.nextCursor })).status, 'invalid_cursor');
  clock += 10001;
  assert.equal((await f.reader.read({ source })).status, 'invalid_source');
});

test('Unicode text round trips across tiny byte pages and scanner chunks', async t => {
  const f = await setup(t, { budgets: { bytes: 37, records: 2 } });
  const text = '中🙂é𐐀\n'.repeat(40);
  await f.fixture('pi', 'unicode.jsonl', [header('pi', f.project), message('pi', text)]);
  const found = await searchAll(f.reader, { provider: 'pi', query: '🙂' });
  assert.equal(found.items.length, 1);
  const read = await readAll(f.reader, found.items[0].source, 7);
  assert.equal(read.records.map(r => r.text).join(''), text);
  assert.ok(!read.records.some(r => r.text.includes('\uFFFD')));
  assert.ok(read.pages.length > 10);
  await f.fixture('pi', 'emoji.jsonl', [header('pi', f.project, 'emoji'), message('pi', '🙂')]);
  const all = await searchAll(f.reader, { provider: 'pi' });
  const source = all.items.find(i => i.sessionId === 'emoji').source;
  let cursor; let small;
  do { small = await f.reader.read({ source, cursor, maxBytes: 1 }); cursor = small.nextCursor; } while (small.status === 'ok' && small.hasMore);
  assert.equal(small.status, 'byte_budget_too_small');
  assert.equal(small.requiredBytes, 4);
  const recovered = await readAllFromCursor(f.reader, source, small.nextCursor);
  assert.equal(recovered.records.map(r => r.text).join(''), '🙂');
});
async function readAllFromCursor(reader, source, cursor) {
  const page = await reader.read({ source, cursor, maxBytes: 32 });
  assert.equal(page.status, 'ok'); return page;
}

for (const change of ['append', 'rotate', 'delete', 'truncate']) test(`changed source is explicitly stale: ${change}`, async t => {
  const f = await setup(t);
  const file = await f.fixture('pi', 'session.jsonl', [header('pi', f.project), message('pi', 'abcdef')]);
  const source = (await searchAll(f.reader, { provider: 'pi' })).items[0].source;
  const first = await f.reader.read({ source, maxBytes: 2 });
  if (change === 'append') await appendFile(file, JSON.stringify(message('pi', 'append')) + '\n');
  if (change === 'rotate') { await rename(file, `${file}.old`); await writeFile(file, 'replacement\n'); }
  if (change === 'delete') await rm(file);
  if (change === 'truncate') await writeFile(file, '');
  assert.equal((await f.reader.read({ source, cursor: first.nextCursor })).status, 'stale');
  assert.equal((await f.reader.read({ source })).status, 'stale');
});

test('unknown/corrupt/missing inputs report coverage rather than claiming no history', async t => {
  const f = await setup(t);
  await f.fixture('pi', 'unknown.jsonl', [{ type: 'session', version: 999, id: 'future', cwd: f.project }, message('pi', 'future body')]);
  await f.fixture('pi', 'broken.jsonl', ['{not json', { type: 'unrecognized', text: f.project }]);
  const result = await searchAll(f.reader, { provider: 'pi' });
  assert.equal(result.items.length, 0);
  assert.ok(result.pages.some(p => p.coverage.unsupported.some(e => e.reason === 'missing_supported_metadata')));
  assert.ok(result.pages.some(p => p.coverage.errors.some(e => e.code === 'malformed_jsonl')));
  const missing = f.makeReader({ providerRoots: { pi: path.join(f.temp, 'missing') } });
  assert.ok((await missing.search({ provider: 'pi' })).coverage.errors.some(e => e.code === 'ENOENT'));
  assert.equal((await f.reader.search({ provider: 'unknown' })).status, 'unsupported');
});

test('bounded file, entry, record and byte scans resume without loss, oversized records are explicit', async t => {
  const f = await setup(t, { budgets: { files: 1, entries: 2, records: 1, bytes: 64, lineBytes: 300 } });
  for (let i = 0; i < 5; i++) await f.fixture('codex', `date/${i}.jsonl`, [header('codex', f.project, String(i)), message('codex', 'no match'), message('codex', 'found')]);
  await f.fixture('codex', 'large.jsonl', [header('codex', f.project, 'large'), message('codex', 'x'.repeat(2000)), message('codex', 'found')]);
  const result = await searchAll(f.reader, { provider: 'codex', query: 'found', limit: 2 });
  assert.equal(result.items.length, 6);
  for (const page of result.pages) {
    assert.ok(page.coverage.files <= 1); assert.ok(page.coverage.entries <= 2);
    assert.ok(page.coverage.records <= 1); assert.ok(page.coverage.bytes <= 64);
  }
  assert.ok(result.pages.some(p => p.coverage.pageLimitReached));
  assert.ok(result.pages.some(p => p.coverage.unsupported.some(e => e.reason === 'record_too_large')));
});

test('metadata, not encoded directory or body mentions, owns project; aliases are unconfirmed', async t => {
  const f = await setup(t);
  const alias = path.join(f.temp, 'alias'); await symlink(f.project, alias, 'dir');
  for (const [name, cwd] of [['same-name', f.other], ['alias', alias], ['missing', path.join(f.temp, 'removed')], ['subdir', path.join(f.project, 'child')]]) {
    await f.fixture('claude', `${name}.jsonl`, [header('claude', cwd, name), message('claude', `mentions ${f.project}`)]);
  }
  const found = await searchAll(f.reader, { provider: 'claude' });
  assert.equal(found.items.length, 0);
  assert.ok(found.pages.some(p => p.coverage.unconfirmed >= 1));
  assert.equal((await f.makeReader({ projectRoot: alias }).search()).status, 'unconfirmed_project');
  await f.fixture('pi', 'linked-target.jsonl', [header('pi', f.project), message('pi', 'target')]);
  await symlink(path.join(f.roots.pi, 'linked-target.jsonl'), path.join(f.roots.pi, 'symlink.jsonl'));
  assert.equal((await searchAll(f.reader, { provider: 'pi' })).items.length, 1);
});

test('search and read never modify source files or create a ledger', async t => {
  const f = await setup(t);
  const file = await f.fixture('pi', 'session.jsonl', [header('pi', f.project), message('pi', 'read only')]);
  async function snapshot(dir) {
    const entries = await readdir(dir, { withFileTypes: true }); const result = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) result.push(...await snapshot(full));
      else { const s = await stat(full); result.push([path.relative(f.temp, full), s.size, s.mtimeMs, await readFile(full, 'utf8')]); }
    }
    return result.sort((a, b) => a[0].localeCompare(b[0]));
  }
  const before = await snapshot(f.temp);
  const source = (await searchAll(f.reader, { provider: 'pi' })).items[0].source;
  assert.equal((await readAll(f.reader, source)).records[0].text, 'read only');
  assert.deepEqual(await snapshot(f.temp), before);
  assert.equal(await readFile(file, 'utf8'), before.find(row => row[0] === path.relative(f.temp, file))[3]);
});

test('project directory replacement invalidates old source and search tickets', async t => {
  const f = await setup(t);
  for (const id of ['a', 'b']) await f.fixture('pi', `${id}.jsonl`, [header('pi', f.project, id), message('pi', 'synthetic')]);
  const first = await f.reader.search({ provider: 'pi', limit: 1 });
  assert.ok(first.items.length && first.nextCursor);
  await rename(f.project, `${f.project}-original`);
  await mkdir(f.project);
  assert.equal((await f.reader.read({ source: first.items[0].source })).status, 'stale_project');
  assert.equal((await f.reader.search({ provider: 'pi', cursor: first.nextCursor })).status, 'stale_project');
  assert.equal((await f.reader.search({ provider: 'pi' })).status, 'stale_project');
});

test('missing Claude cwd and system/credential envelopes never establish project ownership', async t => {
  const f = await setup(t);
  await f.fixture('claude', 'missing-cwd.jsonl', [
    { type: 'user', sessionId: 'missing', timestamp, message: { role: 'user', content: f.project } },
    message('claude', 'not associated'),
  ]);
  await f.fixture('claude', 'system.jsonl', [
    { type: 'system', cwd: f.project, sessionId: 'system', message: { role: 'system', content: 'do something' } },
    { type: 'credentials', cwd: f.project, sessionId: 'credentials', token: 'synthetic-not-a-token' },
    message('claude', 'not associated'),
  ]);
  const result = await searchAll(f.reader, { provider: 'claude' });
  assert.equal(result.items.length, 0);
  assert.ok(result.pages.some(p => p.coverage.unconfirmed || p.coverage.unsupported.length));
});

test('close revokes source and continuation capabilities', async t => {
  const f = await setup(t);
  await f.fixture('pi', 'session.jsonl', [header('pi', f.project), message('pi', 'synthetic')]);
  const page = await f.reader.search({ provider: 'pi', limit: 1 });
  const source = page.items[0].source;
  f.reader.close();
  assert.equal((await f.reader.read({ source })).status, 'invalid_source');
  assert.equal((await f.reader.search({ provider: 'pi' })).status, 'closed');
  if (page.nextCursor) assert.equal((await f.reader.search({ provider: 'pi', cursor: page.nextCursor })).status, 'invalid_cursor');
});

test('host serialized-response budgets retain search and read pages for exact retry', async t => {
  const f = await setup(t);
  const text = ('中🙂\n\t"\\\u0000').repeat(100);
  for (const id of ['a', 'b']) await f.fixture('pi', `${id}.jsonl`, [header('pi', f.project, id), message('pi', text)]);
  const searchArgs = { provider: 'pi', limit: 1 };
  const narrowSearch = await f.reader.search(searchArgs, { maxBytes: 128, requestId: 'search-1' });
  assert.equal(narrowSearch.status, 'response_budget_too_small');
  assert.ok(Buffer.byteLength(JSON.stringify(narrowSearch)) <= 128);
  const found = await f.reader.search(searchArgs, { maxBytes: narrowSearch.requiredBytes, requestId: 'search-1' });
  assert.equal(found.status, 'ok');
  assert.equal(Buffer.byteLength(JSON.stringify(found)), narrowSearch.requiredBytes);
  assert.deepEqual(await f.reader.search(searchArgs, { maxBytes: 100000, requestId: 'search-1' }), found);
  const nextArgs = { ...searchArgs, cursor: found.nextCursor };
  const nextNarrow = await f.reader.search(nextArgs, { maxBytes: 128, requestId: 'search-2' });
  assert.equal(nextNarrow.status, 'response_budget_too_small');
  const next = await f.reader.search(nextArgs, { maxBytes: nextNarrow.requiredBytes, requestId: 'search-2' });
  assert.equal(next.status, 'ok');
  assert.notEqual(next.items[0].sessionId, found.items[0].sessionId);
  assert.deepEqual(await f.reader.search(nextArgs, { maxBytes: 100000, requestId: 'search-2' }), next);
  const source = found.items[0].source;
  const readArgs = { source, maxBytes: 100 };
  const narrowRead = await f.reader.read(readArgs, { maxBytes: 128, requestId: 'read-1' });
  assert.equal(narrowRead.status, 'response_budget_too_small');
  const first = await f.reader.read(readArgs, { maxBytes: narrowRead.requiredBytes, requestId: 'read-1' });
  assert.equal(first.status, 'ok');
  assert.equal(Buffer.byteLength(JSON.stringify(first)), narrowRead.requiredBytes);
  assert.deepEqual(await f.reader.read(readArgs, { maxBytes: 100000, requestId: 'read-1' }), first);
  const readNextArgs = { ...readArgs, cursor: first.nextCursor };
  const readNextNarrow = await f.reader.read(readNextArgs, { maxBytes: 128, requestId: 'read-2' });
  const second = await f.reader.read(readNextArgs, { maxBytes: readNextNarrow.requiredBytes, requestId: 'read-2' });
  assert.equal(second.status, 'ok');
  assert.deepEqual(await f.reader.read(readNextArgs, { maxBytes: 100000, requestId: 'read-2' }), second);
  const allText = [...first.records, ...second.records].map(r => r.text).join('');
  assert.equal(allText, text.slice(0, allText.length));
  // Consumer mutation must not affect the cached prepared page.
  first.records[0].text = 'consumer modification';
  assert.notEqual((await f.reader.read(readArgs, { maxBytes: 100000, requestId: 'read-1' })).records[0].text, 'consumer modification');
});

test('host request identity distinguishes a new initial search from a delivery retry', async t => {
  const f = await setup(t);
  await f.fixture('pi', 'a.jsonl', [header('pi', f.project, 'a'), message('pi', 'first')]);
  const args = { provider: 'pi' }; const host = { maxBytes: 100000, requestId: 'first-search' };
  const first = await f.reader.search(args, host);
  await f.fixture('pi', 'b.jsonl', [header('pi', f.project, 'b'), message('pi', 'second')]);
  assert.deepEqual(await f.reader.search(args, host), first);
  const fresh = await f.reader.search(args, { ...host, requestId: 'fresh-search' });
  assert.equal(fresh.items.length, 2);
  await assert.rejects(f.reader.search(args, { maxBytes: 20 }), /at least 128 bytes/);
  await rename(f.project, `${f.project}-old`); await mkdir(f.project);
  assert.equal((await f.reader.search(args, host)).status, 'stale_project');
});

test('durable source descriptors locate JSONL records and decoded text fragments without exposing home', async t => {
  const f = await setup(t, { budgets: { bytes: 37 } });
  const text = '中🙂é𐐀'.repeat(10);
  const file = await f.fixture('pi', 'project-bucket/history.jsonl', [header('pi', f.project), message('pi', text)]);
  const found = (await searchAll(f.reader, { provider: 'pi' })).items[0];
  assert.equal(found.descriptor.provider, 'pi');
  assert.equal(found.descriptor.sourcePath, 'project-bucket/history.jsonl');
  assert.ok(found.descriptor.sourceVersion);
  assert.match(found.descriptor.versionKind, /not-a-content-digest/);
  assert.ok(!JSON.stringify(found.descriptor).includes(f.temp));
  const bytes = await readFile(file);
  const expectedOffset = bytes.indexOf(10) + 1;
  assert.equal(found.location.byteOffset, expectedOffset);
  assert.equal(found.location.lineOrdinal, 2);
  const result = await readAll(f.reader, found.source, 7);
  let nextTextOffset = 0;
  for (const page of result.pages) assert.deepEqual(page.descriptor, found.descriptor);
  for (const record of result.records) {
    assert.equal(record.location.byteOffset, expectedOffset);
    assert.equal(record.location.lineOrdinal, 2);
    assert.equal(record.location.textStart, nextTextOffset);
    assert.equal(record.text, text.slice(record.location.textStart, record.location.textEnd));
    nextTextOffset = record.location.textEnd;
  }
  assert.equal(nextTextOffset, text.length);
  const oldVersion = found.descriptor.sourceVersion;
  await appendFile(file, JSON.stringify(message('pi', 'new record')) + '\n');
  assert.equal((await f.reader.read({ source: found.source })).status, 'stale');
  const fresh = (await searchAll(f.reader, { provider: 'pi' })).items[0];
  assert.equal(fresh.descriptor.sourcePath, found.descriptor.sourcePath);
  assert.notEqual(fresh.descriptor.sourceVersion, oldVersion);
  assert.equal(found.descriptor.sourceVersion, oldVersion);
});

for (const damage of ['malformed', 'oversized', 'unknown-envelope', 'unknown-content']) test(`read completion remembers earlier ${damage} diagnostics`, async t => {
  const f = await setup(t, { budgets: { records: 1, lineBytes: 400 } });
  const bad = damage === 'malformed' ? '{broken json'
    : damage === 'oversized' ? message('pi', 'DO-NOT-EXPOSE'.repeat(100))
      : damage === 'unknown-envelope' ? { type: 'future_record', body: 'DO-NOT-EXPOSE' }
        : { type: 'message', message: { role: 'user', content: [{ type: 'future_content', text: 'DO-NOT-EXPOSE' }] } };
  await f.fixture('pi', 'history.jsonl', [header('pi', f.project), message('pi', 'known start'), bad, message('pi', 'known end long enough to page')]);
  const source = (await searchAll(f.reader, { provider: 'pi' })).items[0].source;
  const result = await readAll(f.reader, source, 4);
  assert.ok(result.pages.some(p => p.coverage.errors.length || p.coverage.unsupported.length));
  const last = result.pages.at(-1);
  assert.equal(last.coverage.traversalComplete, true);
  assert.equal(last.coverage.incomplete, true);
  assert.equal(last.coverage.exhaustive, false);
  assert.equal(last.coverage.errors.length, 0);
  assert.equal(last.coverage.unsupported.length, 0);
  assert.ok(!JSON.stringify(result).includes('DO-NOT-EXPOSE'));
});

test('intentional system and credential omissions do not masquerade as unknown formats', async t => {
  const f = await setup(t);
  await f.fixture('pi', 'history.jsonl', [header('pi', f.project), message('pi', 'known'),
    message('pi', 'SYSTEM-DO-NOT-EXPOSE', 'system'), { type: 'credentials', token: 'DO-NOT-EXPOSE' }]);
  const source = (await searchAll(f.reader, { provider: 'pi' })).items[0].source;
  const result = await readAll(f.reader, source);
  assert.equal(result.pages.at(-1).coverage.exhaustive, true);
  assert.ok(result.pages.every(p => !p.coverage.unsupported.length));
  assert.equal(result.records.map(r => r.text).join(''), 'known');
});

for (const phase of ['before-open', 'after-read']) test(`ancestor replacement at ${phase} cannot expose an outside transcript`, async t => {
  const f = await setup(t);
  const file = await f.fixture('pi', 'bucket/history.jsonl', [header('pi', f.project), message('pi', 'inside synthetic')]);
  const outside = path.join(f.temp, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'history.jsonl'), [header('pi', f.project), message('pi', 'OUTSIDE-DO-NOT-EXPOSE')].map(row => JSON.stringify(row)).join('\n') + '\n');
  let injected = false;
  const reader = f.makeReader({ budgets: { files: 1 }, fault: async event => {
    if (!injected && event.phase === phase && event.file === file) {
      injected = true;
      await rename(path.dirname(file), `${path.dirname(file)}-original`);
      await symlink(outside, path.dirname(file), 'dir');
    }
  } });
  const page = await reader.search({ provider: 'pi' });
  const result = { items: page.items, pages: [page] };
  assert.equal(injected, true);
  assert.equal(result.items.length, 0);
  assert.ok(result.pages.some(p => p.coverage.errors.some(e => e.code === 'SOURCE_CHANGED')));
  assert.ok(!JSON.stringify(result).includes('OUTSIDE-DO-NOT-EXPOSE'));
});

test('entry replacement between capture and open is rejected by actual descriptor identity', async t => {
  const f = await setup(t);
  const file = await f.fixture('pi', 'history.jsonl', [header('pi', f.project), message('pi', 'inside')]);
  let injected = false;
  const reader = f.makeReader({ budgets: { files: 1 }, fault: async event => {
    if (!injected && event.phase === 'before-open' && event.file === file) {
      injected = true; await rename(file, `${file}.original`);
      await writeFile(file, [header('pi', f.project), message('pi', 'REPLACEMENT-DO-NOT-EXPOSE')].map(row => JSON.stringify(row)).join('\n') + '\n');
    }
  } });
  const page = await reader.search({ provider: 'pi' });
  const result = { items: page.items, pages: [page] };
  assert.equal(result.items.length, 0);
  assert.ok(result.pages.some(p => p.coverage.errors.some(e => e.code === 'SOURCE_CHANGED')));
  assert.ok(!JSON.stringify(result).includes('REPLACEMENT-DO-NOT-EXPOSE'));
});

test('hard-linked history files are rejected rather than trusted across provider boundaries', async t => {
  const f = await setup(t);
  const file = await f.fixture('pi', 'history.jsonl', [header('pi', f.project), message('pi', 'LINKED-DO-NOT-EXPOSE')]);
  await link(file, path.join(f.temp, 'outside-hardlink.jsonl'));
  const result = await searchAll(f.reader, { provider: 'pi' });
  assert.equal(result.items.length, 0);
  assert.ok(result.pages.some(p => p.coverage.errors.some(e => e.code === 'SOURCE_CHANGED')));
});

test('host replay does not revive a source version changed after its page was prepared', async t => {
  const f = await setup(t);
  const file = await f.fixture('pi', 'history.jsonl', [header('pi', f.project), message('pi', 'synthetic')]);
  const source = (await searchAll(f.reader, { provider: 'pi' })).items[0].source;
  const args = { source }; const host = { maxBytes: 100000 };
  assert.equal((await f.reader.read(args, host)).status, 'ok');
  await appendFile(file, JSON.stringify(message('pi', 'append')) + '\n');
  assert.equal((await f.reader.read(args, host)).status, 'stale');
});

test('multiple normalized tool results in one JSONL row have distinct record indexes', async t => {
  const f = await setup(t);
  await f.fixture('claude', 'history.jsonl', [header('claude', f.project), {
    type: 'user', cwd: f.project, sessionId: 'synthetic', timestamp,
    message: { role: 'user', content: [{ type: 'tool_result', content: 'first result' }, { type: 'tool_result', content: 'second result' }] },
  }]);
  const found = (await searchAll(f.reader, { provider: 'claude', query: 'second' })).items[0];
  assert.equal(found.location.recordIndex, 1);
  const read = await readAll(f.reader, found.source);
  assert.deepEqual(read.records.map(r => r.location.recordIndex), [0, 1]);
  assert.equal(read.records[0].location.byteOffset, read.records[1].location.byteOffset);
  assert.equal(read.records[0].location.lineOrdinal, read.records[1].location.lineOrdinal);
});

for (const provider of ['codex', 'claude']) test(`${provider}: associated unknown body formats report unsupported without exposing body`, async t => {
  const f = await setup(t);
  const unknown = provider === 'codex'
    ? { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'future_content', text: 'UNKNOWN-DO-NOT-EXPOSE' }] } }
    : { type: 'assistant', message: { role: 'assistant', content: [{ type: 'future_content', text: 'UNKNOWN-DO-NOT-EXPOSE' }] } };
  await f.fixture(provider, 'history.jsonl', [header(provider, f.project), message(provider, 'known'), unknown]);
  const source = (await searchAll(f.reader, { provider })).items[0].source;
  const read = await readAll(f.reader, source, 4);
  assert.equal(read.pages.at(-1).coverage.exhaustive, false);
  assert.ok(read.pages.some(p => p.coverage.unsupported.some(e => e.reason === 'unknown_content')));
  assert.ok(!JSON.stringify(read).includes('UNKNOWN-DO-NOT-EXPOSE'));
});

test('oversized final record without newline never restores exhaustive coverage at EOF',async t=>{
 const f=await setup(t,{budgets:{bytes:1,lineBytes:400}});
 const base=JSON.stringify(message('pi',''));const tail=JSON.stringify(message('pi','x'.repeat(401-Buffer.byteLength(base))));assert.equal(Buffer.byteLength(tail),401);
 await writeFile(path.join(f.roots.pi,'tail.jsonl'),JSON.stringify(header('pi',f.project))+'\n'+JSON.stringify(message('pi','known'))+'\n'+tail);
 const source=(await searchAll(f.reader,{provider:'pi'})).items[0].source;
 const result=await readAll(f.reader,source,10);
 assert.equal(result.pages.at(-1).coverage.traversalComplete,true);assert.equal(result.pages.at(-1).coverage.exhaustive,false);
 assert.equal(result.pages.flatMap(p=>p.coverage.unsupported).filter(e=>e.reason==='record_too_large').length,1);
 assert.equal(result.records.map(r=>r.text).join(''),'known');
});

const linked = (provider, id, parentId, text, role = 'user') => ({ ...message(provider, text, role), id, parentId });
const omissionCounts = frozen => Object.fromEntries(frozen.coverage.omissions.map(({ reason, count }) => [reason, count]));

test('OMP reads its native title slot and linked records from its own root', async t => {
  const f = await setup(t);
  const title = { type: 'title', v: 1, updatedAt: timestamp, title: 'OMITTED-TITLE', pad: '' };
  const titleSlot = { ...title, pad: ' '.repeat(256 - Buffer.byteLength(JSON.stringify(title) + '\n')) };
  await f.fixture('omp', 'bucket/session.jsonl', [titleSlot, header('omp', f.project),
    { type: 'session_init', id: 'init', parentId: null, systemPrompt: 'OMITTED-SYSTEM' },
    linked('omp', 'turn', 'init', 'OMP request'),
    { type: 'credential_pin', id: 'pin', parentId: 'turn', hash: 'OMITTED-HASH' },
    linked('omp', 'answer', 'pin', 'response', 'assistant')]);
  await f.fixture('omp', 'bucket/foreign.jsonl', [header('omp', f.other), linked('omp', 'a', null, 'OMP request')]);
  await f.fixture('pi', 'bucket/session.jsonl', [header('pi', f.project), message('pi', 'Pi only')]);
  const pi = await searchAll(f.reader, { provider: 'pi' });
  assert.deepEqual(pi.items.map(item => item.preview), ['Pi only']);
  const omp = await searchAll(f.reader, { provider: 'omp', query: 'OMP request' });
  assert.equal(omp.items.length, 1);
  const [found] = omp.items;
  assert.equal(found.descriptor.sourcePath, 'bucket/session.jsonl');
  const read = await readAll(f.reader, found.source);
  assert.deepEqual(read.records.map(r => r.text), ['OMP request', 'response']);
  assert.match(read.pages.at(-1).coverage.branchScope, /not-a-selected-branch/);
  const frozen = await f.reader.freeze(found.source);
  assert.deepEqual(Object.keys(frozen).sort(), ['coverage', 'descriptor', 'provider', 'records', 'sessionId']);
  assert.equal(frozen.provider, 'omp');
  assert.equal(frozen.sessionId, 'synthetic');
  assert.deepEqual(frozen.descriptor, found.descriptor);
  assert.deepEqual(frozen.records, read.records);
  assert.deepEqual(frozen.records[0].location, found.location);
  assert.match(frozen.coverage.branchScope, /single-linked-chain/);
  assert.equal(omissionCounts(frozen).system_or_credentials, 2);
  assert.doesNotMatch(JSON.stringify(frozen), /OMITTED|bucket\/foreign/);
});

for (const provider of ['codex', 'claude', 'pi']) test(`freeze normalizes ${provider} independently of page budgets`, async t => {
  const f = await setup(t, { budgets: { records: 1, bytes: 17 } });
  await f.fixture(provider, 'linear.jsonl', [header(provider, f.project), message(provider, 'request'), message(provider, 'answer', 'assistant')]);
  const [found] = (await searchAll(f.reader, { provider })).items;
  const frozen = await f.reader.freeze(found.source);
  assert.deepEqual(frozen.descriptor, found.descriptor);
  assert.deepEqual(frozen.records.map(row => row.text), ['request', 'answer']);
  assert.ok(frozen.records.every(row => !row.continued && row.untrusted));
  assert.equal(frozen.coverage.textBytes, 13);
  assert.equal(frozen.coverage.traversalComplete, true);
});

test('freeze enforces the decoded UTF-8 limit without splitting a row and reports omissions', async t => {
  const f = await setup(t);
  const exact = '🦋'.repeat(32 * 1024);
  const first = JSON.stringify(message('pi', exact)).replace('🦋', '\\ud83e\\udd8b');
  // The first butterfly occupies twelve source bytes but only four decoded bytes.
  const file = await f.fixture('pi', 'budget.jsonl', [header('pi', f.project), first,
    message('pi', 'over budget'), message('pi', 'also omitted'), '{bad json',
    { type: 'future', content: 'OMITTED-UNKNOWN' }, { type: 'credentials', token: 'OMITTED-SECRET' },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'image', data: 'OMITTED-IMAGE' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'OMITTED-TEXT' }, { type: 'image', data: 'OMITTED-IMAGE' }] } }]);
  await appendFile(file, JSON.stringify(message('pi', 'OMITTED-UNTERMINATED')));
  const before = await readFile(file);
  const [found] = (await searchAll(f.reader, { provider: 'pi' })).items;
  const frozen = await f.reader.freeze(found.source);
  assert.equal(frozen.records.length, 1);
  assert.equal(frozen.records[0].text, exact);
  assert.equal(frozen.records[0].location.textEnd, exact.length);
  assert.equal(frozen.coverage.textBytes, 128 * 1024);
  assert.equal(frozen.coverage.textLimitReached, true);
  assert.equal(frozen.coverage.exhaustive, false);
  assert.equal(frozen.coverage.branchScanComplete, false);
  assert.deepEqual(omissionCounts(frozen), { decoded_text_limit: 3, system_or_credentials: 1,
    nontext_content: 2, malformed_jsonl: 1, unterminated_record: 1, unknown_envelope: 1 });
  assert.doesNotMatch(JSON.stringify(frozen), /OMITTED|over budget|also omitted/);
  assert.deepEqual(await readFile(file), before);
});

test('freeze does not split a JSONL row with both user text and tool results', async t => {
  const f = await setup(t);
  const first = 'x'.repeat(128 * 1024 - 6);
  await f.fixture('claude', 'atomic.jsonl', [header('claude', f.project), message('claude', first), {
    type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fits' }, { type: 'tool_result', content: 'does not fit' }] },
  }]);
  const [found] = (await searchAll(f.reader, { provider: 'claude' })).items;
  const frozen = await f.reader.freeze(found.source);
  assert.deepEqual(frozen.records.map(r => r.text), [first]);
  assert.equal(omissionCounts(frozen).decoded_text_limit, 1);
});

test('valid JSON without a final newline cannot be searched or frozen as a complete row', async t => {
  const f = await setup(t);
  const file = await f.fixture('pi', 'tail.jsonl', [header('pi', f.project), message('pi', 'complete')]);
  await appendFile(file, JSON.stringify(message('pi', 'tail only')));
  assert.equal((await searchAll(f.reader, { provider: 'pi', query: 'tail only' })).items.length, 0);
  const [found] = (await searchAll(f.reader, { provider: 'pi' })).items;
  const frozen = await f.reader.freeze(found.source);
  assert.deepEqual(frozen.records.map(row => row.text), ['complete']);
  assert.equal(omissionCounts(frozen).unterminated_record, 1);
});

test('freeze rejects raw paths, foreign/expired source tickets, and replaced projects', async t => {
  let time = 0;
  const f = await setup(t, { now: () => time, ticketTtlMs: 60_000 });
  const file = await f.fixture('pi', 'stable.jsonl', [header('pi', f.project), message('pi', 'stable')]);
  const [found] = (await searchAll(f.reader, { provider: 'pi' })).items;
  for (const token of [undefined, found.descriptor, file, { source: found.source }]) {
    await assert.rejects(f.reader.freeze(token), { code: 'INVALID_PAYLOAD' });
  }
  await assert.rejects(f.makeReader().freeze(found.source), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(f.makeReader({ projectRoot: f.other }).freeze(found.source), { code: 'INVALID_PAYLOAD' });
  time = 60_000;
  await assert.rejects(f.reader.freeze(found.source), { code: 'INVALID_PAYLOAD' });
  const [fresh] = (await searchAll(f.reader, { provider: 'pi' })).items;
  await rename(f.project, `${f.project}-original`);
  await mkdir(f.project);
  await assert.rejects(f.reader.freeze(fresh.source), { code: 'STALE_SOURCE' });
  await f.reader.close();
  await assert.rejects(f.reader.freeze(fresh.source), { code: 'INVALID_PAYLOAD' });
});

for (const phase of ['before-freeze', 'before-open', 'after-read']) test(`freeze rejects source mutations at ${phase}`, async t => {
  let armed = false;
  let fired = false;
  const f = await setup(t, { fault: async ({ phase: observed, file }) => {
    if (armed && !fired && observed === phase) {
      fired = true;
      await appendFile(file, JSON.stringify(message('pi', 'not in searched version')) + '\n');
    }
  } });
  const file = await f.fixture('pi', 'changing.jsonl', [header('pi', f.project), message('pi', 'stable')]);
  const [found] = (await searchAll(f.reader, { provider: 'pi' })).items;
  if (phase === 'before-freeze') await appendFile(file, '\n');
  else armed = true;
  await assert.rejects(f.reader.freeze(found.source), { code: 'STALE_SOURCE' });
  if (armed) assert.equal(fired, true);
});

for (const provider of ['pi', 'omp', 'claude', 'codex']) test(`freeze rejects ${provider} divergence after the preview and text budget`, async t => {
  const f = await setup(t);
  const text = 'x'.repeat(128 * 1024);
  const meta = header(provider, f.project);
  const rows = provider === 'codex' ? [meta, message(provider, text), message(provider, 'past cap'),
    { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }]
    : provider === 'claude' ? [{ ...meta, ...message(provider, text), uuid: 'a', parentUuid: null },
      { ...message(provider, 'past cap', 'assistant'), uuid: 'b', parentUuid: 'a' },
      { ...message(provider, 'alternative'), uuid: 'c', parentUuid: 'a' }]
      : [meta, linked(provider, 'a', null, text), linked(provider, 'b', 'a', 'past cap'), linked(provider, 'c', 'a', 'alternative')];
  await f.fixture(provider, 'divergent.jsonl', rows);
  const [found] = (await searchAll(f.reader, { provider })).items;
  await assert.rejects(f.reader.freeze(found.source), { code: 'AMBIGUOUS_HISTORY' });
});

test('freeze rejects conflicting cwd, session ids, dangling parents and unverifiable scan sizes', async t => {
  const f = await setup(t);
  await f.fixture('claude', 'mixed-project.jsonl', [header('claude', f.project), message('claude', 'known'),
    { ...message('claude', 'different project'), cwd: f.other }]);
  await f.fixture('pi', 'mixed-session.jsonl', [header('pi', f.project), message('pi', 'known'), header('pi', f.project, 'different-id')]);
  await f.fixture('omp', 'multi-workspace.jsonl', [{ ...header('omp', f.project), additionalDirectories: [f.other] }, linked('omp', 'a', null, 'known')]);
  await f.fixture('omp', 'dangling.jsonl', [header('omp', f.project), linked('omp', 'a', null, 'known'), linked('omp', 'b', 'missing', 'bad')]);
  await f.fixture('pi', 'many-rows.jsonl', [header('pi', f.project), message('pi', 'known'), ...Array(20_001).fill('{}')]);
  const { items } = await searchAll(f.reader);
  assert.equal(items.length, 5);
  for (const found of items) {
    await assert.rejects(f.reader.freeze(found.source), {
      code: found.descriptor.sourcePath === 'many-rows.jsonl' ? 'HISTORY_SCAN_LIMIT' : 'AMBIGUOUS_HISTORY',
    });
  }
});

const ccbSessions = (project, agent, provider) => path.join(project, '.ccb', 'agents', agent, 'provider-state',
  ...(provider === 'omp' ? ['omp', 'sessions'] : ['codex', 'home', 'sessions']));
async function ccbFixture(f, agent, provider, name, rows) {
  const file = path.join(ccbSessions(f.project, agent, provider), name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
  return file;
}

test('picker previews recent dialogue by message time rather than touched file time', async t => {
  const f = await setup(t);
  const old = await ccbFixture(f, 'worker', 'codex', 'older.jsonl', [header('codex', f.project, 'older'),
    {...message('codex', 'old work'), timestamp:'2025-01-01T00:00:00Z'}]);
  const next = await f.fixture('codex', 'newer.jsonl', [header('codex', f.project, 'newer'),
    ...Array.from({length:6}, (_, index)=>({...message('codex', `dialogue ${index}`), timestamp:`2026-01-0${index+1}T00:00:00Z`})),
    {type:'response_item',payload:{type:'function_call_output',output:'tool-only text'}}]);
  await utimes(old,new Date('2027-01-01'),new Date('2027-01-01'));
  await utimes(next,new Date('2026-01-07'),new Date('2026-01-07'));
  const {items}=await f.reader.catalog({previews:true});
  assert.deepEqual(items.map(({sessionId,time})=>[sessionId,time]),[['newer','2026-01-06T00:00:00.000Z'],['older','2025-01-01T00:00:00.000Z']]);
  assert.deepEqual(items[0].recent.map(row=>row.text),['dialogue 2','dialogue 3','dialogue 4','dialogue 5']);
});

test('picker keeps readable prose and limitations without Markdown tables or paths', async t => {
  const f=await setup(t);
  const body='**隔离包已完成，尚未提交 GPU 作业。**\n## 验证细节\n| 作业 | 编号 | 状态 |\n- 审核入口：`tmp/output/READINESS.md`\n```sh\nignored command\n```\n现有结果不代表精度已验证。';
  await f.fixture('codex','review.jsonl',[header('codex',f.project,'review'),message('codex',body)]);
  const {items:[item]}=await f.reader.catalog({previews:true});
  assert.match(item.recent[0].text,/尚未提交 GPU 作业。.*不代表精度已验证。/);
  assert.doesNotMatch(item.recent[0].text,/\*\*|##|\||tmp\/|ignored command/);
  const frozen=await f.reader.freezeSelected(item.source);
  assert.equal(frozen.records[0].text,body);
});

test('CCB worktree journals are scoped to their owning Agent and large current Codex logs freeze only recent dialogue', async t=>{
  const f=await setup(t),agent='agent2',id='current';
  const cwd=path.join(f.project,'.ccb','workspaces',agent);
  await mkdir(cwd,{recursive:true});
  const file=await ccbFixture(f,agent,'codex','current.jsonl',[header('codex',cwd,id),message('codex','old history')]);
  const config=path.join(f.project,'.ccb','agents',agent);
  await writeFile(path.join(config,'agent.json'),JSON.stringify({schema_version:2,record_type:'agent_spec',name:agent,workspace_mode:'git-worktree'}));
  const runtime={schema_version:2,record_type:'agent_runtime',agent_name:agent,workspace_path:cwd,provider:'codex',session_id:id};
  await writeFile(path.join(config,'runtime.json'),JSON.stringify(runtime));
  const tail=JSON.stringify(message('codex','recent request'))+'\n';
  await appendFile(file,'x'.repeat(9*1024*1024)+'\n'+tail+JSON.stringify(message('codex','incomplete row')));
  await ccbFixture(f,agent,'codex','small.jsonl',[header('codex',cwd,'small'),message('codex','old valid worktree context')]);
  await ccbFixture(f,'other','codex','foreign.jsonl',[header('codex',cwd,'foreign'),message('codex','wrong owner')]);
  await f.fixture('codex','outside.jsonl',[header('codex',cwd,'standalone'),message('codex','wrong source')]);
  const {items}=await f.reader.catalog({previews:true});
  assert.deepEqual(items.map(row=>row.sessionId).sort(),['current','small']);
  const current=items.find(row=>row.sessionId===id),small=items.find(row=>row.sessionId==='small');
  assert.equal(current.descriptor.workspacePath,'.ccb/workspaces/agent2');
  assert.equal(current.descriptor.selectionScope,'recent-dialogue-only');
  assert.deepEqual(current.recent.map(row=>row.text),['recent request']);
  const frozen=await f.reader.freezeSelected(current.source);
  assert.deepEqual(frozen.records.map(row=>row.text),['recent request']);
  assert.equal(frozen.coverage.exhaustive,false);
  const offset=frozen.records[0].location.byteOffset;
  assert.equal((await readFile(file)).subarray(offset,offset+Buffer.byteLength(tail)).toString(),tail);
  assert.deepEqual((await f.reader.freezeSelected(small.source)).records.map(row=>row.text),['old valid worktree context']);
  await writeFile(path.join(config,'runtime.json'),JSON.stringify({...runtime,session_id:'replaced'}));
  await assert.rejects(f.reader.freezeSelected(current.source),{code:'STALE_SOURCE'});
});


test('catalog ranks standalone and project-local sessions by mtime and exposes only metadata', async t => {
  const f = await setup(t);
  const title = { type: 'title', v: 1, title: 'PRIVATE-TITLE', updatedAt: timestamp, pad: '' };
  const omp = await ccbFixture(f, 'frontdesk', 'omp', 'bucket/session.jsonl', [title,
    { ...header('omp', f.project, 'omp-id'), title: 'PRIVATE-HEADER-TITLE' }, linked('omp', 'a', null, 'PRIVATE-TEXT')]);
  const codex = await ccbFixture(f, 'worker', 'codex', '2026/01/01/session.jsonl', [header('codex', f.project, 'codex-id'), message('codex', 'PRIVATE-CODEX')]);
  const pi = await f.fixture('pi', 'first.jsonl', [header('pi', f.project, 'pi-id'), '{unparseable transcript body', linked('pi', 'a', null, 'PRIVATE-PI')]);
  const claude = await f.fixture('claude', 'first.jsonl', [{ type: 'summary', summary: 'PRIVATE-SUMMARY' }, header('claude', f.project, 'claude-id')]);
  const times = [omp, codex, pi, claude].map((_, index) => new Date(Date.UTC(2026, 1, 4 - index)));
  await Promise.all([omp, codex, pi, claude].map((file, index) => utimes(file, times[index], times[index])));
  const invalid = [
    await f.fixture('codex', 'newer-foreign.jsonl', [header('codex', f.other, 'foreign'), message('codex', f.project)]),
    await f.fixture('omp', 'wrong-order.jsonl', [title, message('omp', 'not a header'), header('omp', f.project, 'not-leading')]),
    await f.fixture('codex', 'cwd-alias.jsonl', [header('codex', `${f.project}${path.sep}.`, 'not-exact')]),
  ];
  const newer = new Date(Date.UTC(2026, 1, 5));
  await Promise.all(invalid.map(file => utimes(file, newer, newer)));

  const result = await f.reader.catalog();
  assert.deepEqual(Object.keys(result).sort(), ['items', 'limited']);
  assert.equal(result.limited, false);
  assert.deepEqual(result.items.map(item => [item.provider, item.agent, item.sessionId, item.time]), [
    ['omp', 'frontdesk', 'omp-id', times[0].toISOString()], ['codex', 'worker', 'codex-id', times[1].toISOString()],
    ['pi', null, 'pi-id', times[2].toISOString()], ['claude', null, 'claude-id', times[3].toISOString()],
  ]);
  for (const item of result.items) {
    assert.deepEqual(Object.keys(item).sort(), ['agent', 'descriptor', 'provider', 'sessionId', 'source', 'time']);
    assert.equal(typeof item.source, 'string');
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|unparseable/);
  const [selected] = result.items;
  assert.equal(selected.descriptor.sourcePath, '.ccb/agents/frontdesk/provider-state/omp/sessions/bucket/session.jsonl');
  const frozen = await f.reader.freezeSelected(selected.source);
  assert.equal(frozen.agent, 'frontdesk');
  assert.deepEqual(frozen.descriptor, selected.descriptor);
  assert.deepEqual(frozen.records.map(row => row.text), ['PRIVATE-TEXT']);
  assert.equal((await f.reader.freezeSelected(result.items[1].source)).agent, 'worker');
  assert.equal((await f.reader.freezeSelected(result.items[2].source)).agent, null);

  const shortlist = await f.reader.catalog({ limit: 2 });
  assert.equal(shortlist.limited, true);
  assert.deepEqual(shortlist.items.map(item => item.sessionId), ['omp-id', 'codex-id']);
  await Promise.all(invalid.map(file => utimes(file, times[3], times[3])));
  const boundedReader = f.makeReader({ budgets: { files: 1 } });
  const boundedCatalog = await boundedReader.catalog();
  assert.equal(boundedCatalog.limited, true);
  assert.deepEqual(boundedCatalog.items.map(item => item.sessionId), ['omp-id']);
});

test('catalog ignores symlink files and ancestors in both source layouts', async t => {
  const f = await setup(t);
  const foreign = await f.fixture('pi', 'untrusted.jsonl', [header('omp', f.project, 'symlinked')]);
  const outside = path.join(path.dirname(f.roots.pi), 'outside-catalog.jsonl');
  await rename(foreign, outside);
  const safe = await ccbFixture(f, 'worker', 'omp', 'safe.jsonl', [header('omp', f.project, 'safe')]);
  const dir = path.dirname(safe);
  const agents = path.join(f.project, '.ccb', 'agents');
  try {
    await symlink(outside, path.join(f.roots.omp, 'alias.jsonl'), 'file');
    await symlink(outside, path.join(dir, 'alias.jsonl'), 'file');
    await symlink(dir, path.join(f.roots.codex, 'alias-dir'), 'junction');
    await symlink(path.join(agents, 'worker'), path.join(agents, 'alias-agent'), 'junction');
    const otherState = path.join(agents, 'other', 'provider-state');
    await mkdir(path.dirname(otherState));
    await symlink(path.join(agents, 'worker', 'provider-state'), otherState, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('symlinks unavailable');
    throw error;
  }
  const { items } = await f.reader.catalog();
  assert.deepEqual(items.map(item => [item.agent, item.sessionId]), [['worker', 'safe']]);
  await rename(dir, `${dir}-original`);
  await symlink(`${dir}-original`, dir, 'junction');
  await assert.rejects(f.reader.freezeSelected(items[0].source), { code: 'STALE_SOURCE' });
});

test('freezeSelected accepts only current catalog tickets from this reader', async t => {
  let time = 0;
  const f = await setup(t, { now: () => time, ticketTtlMs: 60_000 });
  const file = await f.fixture('omp', 'stable.jsonl', [header('omp', f.project), linked('omp', 'a', null, 'stable')]);
  const [preview] = (await searchAll(f.reader, { provider: 'omp' })).items;
  const { items: [selected] } = await f.reader.catalog();
  for (const source of [preview.source, selected.descriptor, file, { source: selected.source }, null]) {
    await assert.rejects(f.reader.freezeSelected(source), { code: 'INVALID_PAYLOAD' });
  }
  await assert.rejects(f.makeReader().freezeSelected(selected.source), { code: 'INVALID_PAYLOAD' });
  time = 60_000;
  await assert.rejects(f.reader.freezeSelected(selected.source), { code: 'INVALID_PAYLOAD' });
  const { items: [fresh] } = await f.reader.catalog();
  await appendFile(file, '\n');
  await assert.rejects(f.reader.freezeSelected(fresh.source), { code: 'STALE_SOURCE' });
  const { items: [current] } = await f.reader.catalog();
  await rename(f.project, `${f.project}-original`);
  await mkdir(f.project);
  await assert.rejects(f.reader.freezeSelected(current.source), { code: 'STALE_SOURCE' });
});

test('freezeSelected does not treat OMP forks or continuations as standalone transcripts', async t => {
  const f = await setup(t);
  await f.fixture('omp', 'fork.jsonl', [{ ...header('omp', f.project, 'fork'), parentSession: '/parent.jsonl' }, linked('omp', 'a', null, 'fork')]);
  await f.fixture('omp', 'continuation.jsonl', [{ ...header('omp', f.project, 'continuation'), parentSession: 'parent', continuationOf: 'parent' }, linked('omp', 'a', null, 'continuation')]);
  const { items } = await f.reader.catalog();
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.unavailable, 'AMBIGUOUS_HISTORY');assert.equal(item.source, null);
    await assert.rejects(f.reader.freezeSelected(item.source), { code: 'INVALID_PAYLOAD' });
  }
});
