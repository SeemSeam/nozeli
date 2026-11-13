import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rename, rm, readdir, stat, symlink, link } from 'node:fs/promises';
import { createProviderHistoryReader } from '../src/agents/managed/provider-history.mjs';

const timestamp = '2026-01-01T00:00:00Z';
const header = (provider, cwd, id = 'synthetic') => provider === 'codex'
  ? { type: 'session_meta', timestamp, payload: { id, cwd, timestamp } }
  : provider === 'pi' ? { type: 'session', version: 3, id, cwd, timestamp }
    : { type: 'user', cwd, sessionId: id, timestamp, message: { role: 'user', content: [] } };
const message = (provider, text, role = 'user') => provider === 'codex'
  ? { type: 'response_item', timestamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }
  : { type: provider === 'pi' ? 'message' : role, timestamp, message: { role, content: [{ type: 'text', text }] } };
async function setup(t, options = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'nozeli-provider-history-'));
  const readers = [];
  t.after(async () => { await Promise.all(readers.map(reader => reader.close())); await rm(temp, { recursive: true, force: true }); });
  const project = path.join(temp, 'one', 'same-name');
  const other = path.join(temp, 'two', 'same-name');
  await mkdir(project, { recursive: true }); await mkdir(other, { recursive: true });
  const roots = Object.fromEntries(['codex', 'claude', 'pi'].map(p => [p, path.join(temp, 'providers', p)]));
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

test('default home layout discovers all three providers without internal options', async t => {
  const f = await setup(t);
  const home = path.join(f.temp, 'home');
  const dirs = { codex: '.codex/sessions/2026/01/01', claude: '.claude/projects/encoded-project', pi: '.pi/agent/sessions/--encoded-project--' };
  for (const [provider, dir] of Object.entries(dirs)) {
    const folder = path.join(home, dir); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'session.jsonl'), [header(provider, f.project), message(provider, 'default synthetic')].map(JSON.stringify).join('\n') + '\n');
  }
  const reader = createProviderHistoryReader({ projectRoot: f.project, home });
  t.after(() => reader.close());
  assert.deepEqual((await searchAll(reader)).items.map(i => i.provider).sort(), ['claude', 'codex', 'pi']);
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
  assert.ok(result.pages.some(p => p.coverage.budgetExhausted));
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

test('close revokes capabilities and empty-string cursors are not accepted as new scans', async t => {
  const f = await setup(t);
  await f.fixture('pi', 'session.jsonl', [header('pi', f.project), message('pi', 'synthetic')]);
  assert.equal((await f.reader.search({ cursor: '' })).status, 'invalid_cursor');
  const page = await f.reader.search({ provider: 'pi', limit: 1 });
  const source = page.items[0].source;
  assert.equal((await f.reader.read({ source, cursor: '' })).status, 'invalid_cursor');
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
