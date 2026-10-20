import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAcceptanceCollector, installAcceptanceControl } from './acceptance-request-control.mjs';

const endpoint = 'http://127.0.0.1:12345';
function sdk() {
  const handlers = new Map();
  return { handlers, on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); }, async emit(name, event, ctx = { abort() {} }) { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); } };
}
function controls(fn = () => ({ allowed: true })) {
  const records = [];
  return { records, fetch: async (url, init) => { const value = JSON.parse(init.body); records.push({ url, value }); return Response.json(await fn(url, value)); } };
}

test('duplicate registration and disposal never stack fetch or SDK handlers', async () => {
  const pi = sdk(), collector = controls(); let calls = 0;
  const original = async () => { calls++; return new Response('ok'); };
  const target = { fetch: original }, options = { endpoint, roleInstance: 'worker:original-work', target, controlFetch: collector.fetch };
  const first = installAcceptanceControl(pi, options);
  assert.equal(installAcceptanceControl(pi, options), first);
  assert.throws(() => installAcceptanceControl(sdk(), options), /different/);
  const message = { role: 'assistant', usage: { input: 5, output: 2, cost: { total: 999 }, secret: 'do-not-store' } };
  await pi.emit('message_end', { message }); await pi.emit('message_end', { message });
  await target.fetch('https://provider.invalid/messages', { body: '{"model":"original","max_tokens":8192}' });
  assert.equal(calls, 1); assert.equal(collector.records.filter(r => r.url.endsWith('/admit')).length, 1);
  assert.equal(collector.records.filter(r => r.value.kind === 'usage').length, 1);
  assert.deepEqual(collector.records.find(r => r.value.kind === 'usage').value.usage, { input: 5, output: 2 });
  first.dispose(); assert.equal(target.fetch, original);
  const second = installAcceptanceControl(pi, options);
  assert.equal(pi.handlers.get('message_end').length, 1);
  await pi.emit('message_end', { message });
  assert.equal(collector.records.filter(r => r.value.kind === 'usage').length, 2);
  second.dispose();
});

test('observer failure does not mask real HTTP rejection or read its body', async () => {
  const pi = sdk(), response = new Response('raw provider failure', { status: 429 });
  const collector = controls(url => { if (url.endsWith('/event')) throw new Error('observer broken'); return { allowed: true }; });
  const target = { fetch: async () => response };
  const handle = installAcceptanceControl(pi, { endpoint, roleInstance: 'front', target, controlFetch: collector.fetch });
  assert.equal(await target.fetch('https://provider.invalid/messages'), response);
  assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), 'raw provider failure');
  assert.equal(handle.stopped, true);
  await assert.rejects(target.fetch('https://provider.invalid/messages'), { name: 'AbortError' });
  handle.dispose();
});

test('transport error identity and safe codes survive failed observer', async () => {
  const error = Object.assign(new Error('secret provider message'), { code: 'ECONNRESET', cause: { code: 'ETIMEDOUT' } });
  const collector = controls(url => { if (url.endsWith('/event')) throw new Error('collector failed'); return { allowed: true }; });
  const target = { fetch: async () => { throw error; } }, handle = installAcceptanceControl(sdk(), { endpoint, roleInstance: 'worker', target, controlFetch: collector.fetch });
  await assert.rejects(target.fetch('https://provider.invalid/messages'), e => e === error);
  const record = collector.records.find(r => r.value.kind === 'transport-error').value;
  assert.equal(record.code, 'ECONNRESET'); assert.equal(record.causeCode, 'ETIMEDOUT');
  assert.equal(JSON.stringify(collector.records).includes('secret provider message'), false);
  handle.dispose();
});

test('parallel fetch keeps signals isolated and preserves exact payload and Request signal', async () => {
  const collector = controls(), pi = sdk(), calls = [];
  const target = { fetch: async (input, init) => { calls.push({ input, init }); return new Response('ok'); } };
  const handle = installAcceptanceControl(pi, { endpoint, roleInstance: 'background', target, controlFetch: collector.fetch });
  const one = new AbortController(), two = new AbortController();
  const payload = '{"model":"untouched","max_tokens":12345,"messages":[{"content":"paper-secret"}]}';
  const request = new Request('https://provider.invalid/native', { signal: two.signal });
  await Promise.all([target.fetch('https://provider.invalid/messages', { signal: one.signal, body: payload }), target.fetch(request)]);
  one.abort();
  assert.equal(calls[0].init.signal.aborted, true); assert.equal(calls[1].init.signal.aborted, false);
  two.abort(); assert.equal(calls[1].init.signal.aborted, true);
  assert.equal(calls[0].init.body, payload); assert.equal(calls[1].input, request);
  const admissions = collector.records.filter(r => r.url.endsWith('/admit'));
  assert.notEqual(admissions[0].value.id, admissions[1].value.id);
  assert.equal(admissions.length, 2); // no before_provider_request necessary for native fetch
  assert.equal(JSON.stringify(collector.records).includes('paper-secret'), false);
  handle.dispose();
});

test('failed admission is fail-closed with explicit AbortError and latched no retry', async () => {
  let upstream = 0, stopped = 0;
  const target = { fetch: async () => { upstream++; return new Response('bad'); } };
  const handle = installAcceptanceControl(sdk(), { endpoint, roleInstance: 'worker', target, controlFetch: async () => { throw new Error('offline'); }, onStop() { stopped++; } });
  for (let n = 0; n < 3; n++) await assert.rejects(target.fetch('https://provider.invalid/messages'), { name: 'AbortError' });
  assert.equal(upstream, 0); assert.equal(stopped, 1); handle.dispose();
});

test('collector serializes concurrent admission, deduplicates usage and inherits durable budget', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-control-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const options = { ledgerPath: path.join(dir, 'ledger.json'), maxAttempts: 2, maxInputOutput: 100, deadlineAt: Date.now() + 60000, allowedDestinations: ['https://provider.invalid/messages'] };
  let collector = await createAcceptanceCollector(options);
  const instance = 'a'.repeat(64);
  const post = async (route, value) => (await fetch(collector.endpoint + route, { method: 'POST', body: JSON.stringify({ instance, ...value }) })).json();
  try {
    const granted = await Promise.all(['first', 'second', 'third'].map(id => post('/admit', { id, destination: 'https://provider.invalid/messages' })));
    assert.equal(granted.filter(r => r.allowed).length, 2);
    await post('/event', { id: 'usage1', kind: 'usage', usage: { input: 5, output: 3 } });
    await post('/event', { id: 'usage1', kind: 'usage', usage: { input: 5, output: 3 } });
    assert.equal(collector.snapshot().inputOutput, 8);
    assert.equal(collector.snapshot().usage.usage1.attribution, 'unattributed');
  } finally { await collector.close(); }
  collector = await createAcceptanceCollector(options);
  try { assert.equal(collector.snapshot().stopped, 'attempt-budget'); assert.equal((await post('/admit', { id: 'fourth', destination: 'https://provider.invalid/messages' })).allowed, false); }
  finally { await collector.close(); }
  await assert.rejects(createAcceptanceCollector({ ...options, maxAttempts: 3 }), /policy mismatch/);
});

test('explicit null limits preserve accounting across reopen without disabling deliberate stop', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-control-unlimited-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const options = { ledgerPath: path.join(dir, 'ledger.json'), maxAttempts: null, maxInputOutput: null, deadlineAt: null, allowedDestinations: ['https://provider.invalid/messages'] };
  let collector = await createAcceptanceCollector(options);
  const post = async (route, value) => (await fetch(collector.endpoint + route, { method: 'POST', body: JSON.stringify({ instance: 'a'.repeat(64), ...value }) })).json();
  try {
    assert.equal((await post('/admit', { id: 'first', destination: 'https://provider.invalid/messages' })).allowed, true);
    await post('/event', { id: 'usage', kind: 'usage', usage: { input: 123, output: 45 } });
  } finally { await collector.close(); }
  collector = await createAcceptanceCollector(options);
  try {
    assert.equal(collector.snapshot().inputOutput, 168);
    assert.equal((await post('/admit', { id: 'second', destination: 'https://provider.invalid/messages' })).allowed, true);
    assert.equal(collector.snapshot().stopped, null);
    await collector.stop('operator-no-progress');
    assert.equal((await post('/admit', { id: 'after-stop', destination: 'https://provider.invalid/messages' })).allowed, false);
    assert.equal(collector.snapshot().stopped, 'operator-no-progress');
  } finally { await collector.close(); }
});

test('unauthorized background destination stops the shared collector before upstream', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-control-deny-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const collector = await createAcceptanceCollector({ ledgerPath: path.join(dir, 'ledger.json'), maxAttempts: 5, deadlineAt: Date.now() + 60000, allowedDestinations: ['https://provider.invalid/messages'] });
  let calls = 0;
  const target = { fetch: async () => { calls++; return new Response('no'); } };
  const handle = installAcceptanceControl(sdk(), { endpoint: collector.endpoint, roleInstance: 'native-background', target, controlFetch: fetch });
  try {
    await assert.rejects(target.fetch('https://other.invalid/unhooked'), { name: 'AbortError' });
    assert.equal(calls, 0); assert.equal(collector.snapshot().stopped, 'unauthorized-destination');
    assert.equal(Object.keys(collector.snapshot().attempts).length, 0);
  } finally { handle.dispose(); await collector.close(); }
});


test('exact broker control requests bypass admission without inspecting credentials', async () => {
  const collector = controls(), calls = [];
  const target = { fetch: async (input, init) => { calls.push({ input, init }); return new Response('opaque'); } };
  const handle = installAcceptanceControl(sdk(), { endpoint, roleInstance: 'front', brokerURL: 'http://127.0.0.1:23456', target, controlFetch: collector.fetch });
  const init = { method: 'GET', headers: { authorization: 'synthetic-secret' } };
  await target.fetch('http://127.0.0.1:23456/v1/snapshot?wait=100', init);
  assert.equal(calls[0].init, init);
  assert.equal(collector.records.length, 0);
  await target.fetch('http://127.0.0.1:23457/v1/snapshot');
  await target.fetch('http://127.0.0.1:23456/arbitrary');
  assert.equal(collector.records.filter(r => r.url.endsWith('/admit')).length, 2);
  assert.equal(JSON.stringify(collector.records).includes('synthetic-secret'), false);
  handle.dispose();
});

test('usage threshold is separate from hard attempt admission and persisted stop', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-control-usage-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const collector = await createAcceptanceCollector({ ledgerPath: path.join(dir, 'ledger.json'), maxAttempts: 80, maxInputOutput: 10, deadlineAt: Date.now() + 60000, allowedDestinations: ['https://provider.invalid/messages'] });
  try {
    const response = await fetch(collector.endpoint + '/event', { method: 'POST', body: JSON.stringify({ instance: 'a'.repeat(64), id: 'official-usage', kind: 'usage', usage: { input: 8, output: 4, totalTokens: 200, cacheRead: 188 } }) });
    assert.equal((await response.json()).allowed, false);
    assert.equal(collector.snapshot().inputOutput, 12);
    assert.equal(collector.snapshot().stopped, 'observed-input-output');
    assert.equal(Object.keys(collector.snapshot().attempts).length, 0);
  } finally { await collector.close(); }
});

test('model allowlist rejects without changing the caller payload', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-control-model-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const collector = await createAcceptanceCollector({ ledgerPath: path.join(dir, 'ledger.json'), maxAttempts: 80, allowedModels: ['glm-4.7'], deadlineAt: Date.now() + 60000, allowedDestinations: ['https://provider.invalid/messages'] });
  let upstream = 0;
  const target = { fetch: async () => { upstream++; return new Response('bad'); } };
  const handle = installAcceptanceControl(sdk(), { endpoint: collector.endpoint, roleInstance: 'worker', target, controlFetch: fetch });
  const init = { body: '{"model":"not-authorized","max_tokens":16384}' };
  try {
    await assert.rejects(target.fetch('https://provider.invalid/messages', init), { name: 'AbortError' });
    assert.equal(init.body, '{"model":"not-authorized","max_tokens":16384}');
    assert.equal(upstream, 0); assert.equal(collector.snapshot().stopped, 'unauthorized-model');
  } finally { handle.dispose(); await collector.close(); }
});

test('one ledger permits only one concurrent local authority and idempotent close', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-control-owner-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const options = { ledgerPath: path.join(dir, 'ledger.json'), maxAttempts: 1, deadlineAt: Date.now() + 60000, allowedDestinations: ['https://provider.invalid/messages'] };
  const results = await Promise.allSettled([createAcceptanceCollector(options), createAcceptanceCollector(options)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const collector = results.find(r => r.status === 'fulfilled').value;
  try {
    await assert.rejects(createAcceptanceCollector({ ...options, recoverStaleOwner: true }), /owned|active/);
    const moduleURL = new URL('./acceptance-request-control.mjs', import.meta.url).href;
    const script = `import {createAcceptanceCollector} from ${JSON.stringify(moduleURL)}; try { const c=await createAcceptanceCollector(${JSON.stringify(options)}); await c.close(); process.exitCode=2; } catch(e) { if(!/owned|active/.test(e.message)) throw e; }`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
    const result = await fetch(collector.endpoint + '/admit', { method: 'POST', body: JSON.stringify({ instance: 'a'.repeat(64), id: 'first', destination: 'https://provider.invalid/messages' }) });
    assert.equal((await result.json()).allowed, true);
  } finally { await Promise.all([collector.close(), collector.close()]); }
  const reopened = await createAcceptanceCollector(options);
  try {
    const result = await fetch(reopened.endpoint + '/admit', { method: 'POST', body: JSON.stringify({ instance: 'a'.repeat(64), id: 'second', destination: 'https://provider.invalid/messages' }) });
    assert.equal((await result.json()).allowed, false);
    assert.equal(Object.keys(reopened.snapshot().attempts).length, 1);
  } finally { await reopened.close(); }
});

test('proven crashed owner requires explicit recovery and failed initialization releases ownership', { skip: process.platform !== 'linux' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-control-stale-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const options = { ledgerPath: path.join(dir, 'ledger.json'), maxAttempts: 1, deadlineAt: Date.now() + 60000, allowedDestinations: [] };
  const moduleURL = new URL('./acceptance-request-control.mjs', import.meta.url).href;
  const script = `import {createAcceptanceCollector} from ${JSON.stringify(moduleURL)}; await createAcceptanceCollector(${JSON.stringify(options)}); process.exit(0);`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
  await assert.rejects(createAcceptanceCollector(options), /owned|staleness/);
  const recovered = await createAcceptanceCollector({ ...options, recoverStaleOwner: true });
  await recovered.close();
  await assert.rejects(createAcceptanceCollector({ ...options, maxAttempts: 2 }), /policy mismatch/);
  await assert.rejects(fs.access(options.ledgerPath + '.owner'), { code: 'ENOENT' });
  await assert.rejects(fs.access(options.ledgerPath + '.owner.gate'), { code: 'ENOENT' });
  const reopened = await createAcceptanceCollector(options);
  await reopened.close();
});
