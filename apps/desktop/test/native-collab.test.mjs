import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLocalRelay } from '../src/agents/managed/collab/local-relay.mjs';
import { sealFrame, openFrame, ManagedCollabGuest } from '../src/agents/managed/collab/guest.mjs';
import { NativeCollabRuntime } from '../src/agents/managed/collab/runtime.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('encrypted frames reject altered authentication and foreign peer envelopes', () => {
  const key = randomBytes(32), encrypted = sealFrame(key, { t: 'action-query', rid: 'request-1', ep: 'session#0' });
  assert.equal(openFrame(key, encrypted).rid, 'request-1');
  const tampered = Buffer.from(encrypted); tampered[18] ^= 1;
  assert.throws(() => openFrame(key, tampered));
  const foreign = Buffer.from(encrypted); foreign.writeUInt32BE(1); assert.throws(() => openFrame(key, foreign), /invalid-host-envelope/);
});

test('relay capability and target fencing prevent unauthorized room traffic', async () => {
  const relay = await startLocalRelay();
  try {
    const denied = new WebSocket(relay.url + '/r/testroom1?role=host'); denied.on('error', () => {});
    await new Promise(resolve => denied.once('close', resolve));
    const host = new WebSocket(relay.url + '/r/testroom1?role=host&cap=' + relay.capability); await once(host, 'open');
    const guest = new WebSocket(relay.url + '/r/testroom1?role=guest&cap=' + relay.capability); await once(guest, 'open');
    const frame = Buffer.alloc(32); frame.writeUInt32BE(9); guest.send(frame);
    const [code] = await once(guest, 'close'); assert.equal(code, 1008);
    host.terminate();
  } finally { await relay.close(); }
});

test('lossless native entries follow parent identity; mutation and invalid chunks reject', async () => {
  const facts = [];
  const runtime = new NativeCollabRuntime({ home: '/unused', context: {}, onEntry: fact => facts.push(fact) });
  runtime.sessionId = 'session'; runtime.guest = { epoch: 'session#0' };
  const deliver = async entry => runtime.receive({ t: 'nozeli-entry-part', id: entry.id, index: 0, final: true, data: Buffer.from(JSON.stringify(entry)).toString('base64') });
  await deliver({ id: 'input', parentId: null, type: 'custom_message', details: { requestId: 'request-1', jobId: 'job-1', epoch: 'session#0' } });
  await runtime.receive({ t: 'snapshot-chunk', final: true });
  await deliver({ id: 'output', parentId: 'input', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } });
  assert.equal(facts.length, 2); assert.equal(facts[1].jobId, 'job-1'); assert.equal(runtime.answer('request-1'), 'answer');
  await assert.rejects(deliver({ id: 'output', parentId: 'input', type: 'message', message: { role: 'assistant', content: [] } }), /native-entry-mutated/);
  await assert.rejects(runtime.receive({ t: 'nozeli-entry-part', id: 'other', index: 2, final: true, data: 'YQ==' }), /native-entry-chunk-order/);
});

test('unknown draft denies before durable handoff and no business job is synthesized', async () => {
  const facts = [];
  const runtime = new NativeCollabRuntime({ home: '/unused', context: {}, nativeState: async () => ({ editorDraft: { known: false } }), onFact: fact => facts.push(fact) });
  runtime.guest = { generation: 1 }; runtime.epoch = 'session#0';
  await assert.rejects(runtime.dispatch('text', [], null), /collab-durable-job-required/);
  await assert.rejects(runtime.dispatch('text', [], { id: 'job-1' }), { code: 'NATIVE_DRAFT_PENDING' });
  assert.deepEqual(facts, []); assert.equal(runtime.attempts.size, 0);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function transportFixture(options = {}) {
  const facts = [], grants = [], revoked = [], sent = [];
  const runtime = new NativeCollabRuntime({ home: '/unused', context: { ownerId: 'owner' },
    nativeState: async () => ({ editorDraft: { known: true, hasText: false } }),
    eligibility: async () => ({ scopeAllowed: true, workOpen: true, hostAdmitted: true }),
    onFact: fact => facts.push(fact), ...options });
  runtime.sessionId = 'session'; runtime.epoch = 'session#0';
  runtime.snapshotting = false;
  runtime.grants = { issue: async grant => { grants.push(grant); }, revoke: async nonce => { revoked.push(nonce); }, revokeJob: async () => {}, revokeOwner: async () => {}, close: async () => {} };
  runtime.guest = { generation: 1, epoch: runtime.epoch, upload: async () => [],
    async send(frame, generation, hooks = {}) {
      await hooks.beforeSend?.(); hooks.onHandoff?.(); sent.push(frame);
      if (frame.t === 'prompt' || frame.t === 'abort') await runtime.receive({ t: 'action-receipt', rid: frame.rid, ep: frame.ep, ar: frame.ar, kind: frame.t, status: frame.t === 'prompt' ? 'admitted' : 'executed', seq: sent.length });
    }, drain: async () => {}, close: async () => {} };
  return { runtime, facts, grants, revoked, sent };
}

test('ticket changes during upload revoke the grant without handing off a prompt', async () => {
  let allowed = true;
  const f = transportFixture({ eligibility: async () => ({ scopeAllowed: allowed, workOpen: allowed, hostAdmitted: true }) });
  f.runtime.guest.upload = async () => { allowed = false; return []; };
  await assert.rejects(f.runtime.dispatch('original', [{ data: 'a' }], { id: 'job' }), { code: 'OMP_COLLAB_NOT_SUBMITTED' });
  assert.equal(f.grants.length, 1); assert.deepEqual(f.revoked, [f.grants[0].nonce]); assert.deepEqual(f.sent, []);
  assert.equal(f.facts.at(-1).status, 'rejected'); assert.equal(f.facts.at(-1).reason, 'not-submitted');
});

test('prepared and partial issue failures revoke and hold before any handoff', async () => {
  for (const stage of ['prepared', 'issue']) {
    const f = transportFixture(stage === 'prepared' ? { onFact: async fact => { if (fact.status === 'prepared') throw Error('disk-full'); } } : {});
    if (stage === 'issue') f.runtime.grants.issue = async grant => { f.grants.push(grant); throw Error('rename-uncertain'); };
    await assert.rejects(f.runtime.dispatch('x', [], { id: 'job' }), { code: 'OMP_COLLAB_HOLD' });
    assert.equal(f.revoked.length, 1); assert.deepEqual(f.sent, []);
    await assert.rejects(f.runtime.dispatch('retry', [], { id: 'job' }), { code: 'OMP_COLLAB_HOLD' });
  }
});

test('socket handoff uncertainty differs from explicit non-delivery and never retries', async () => {
  for (const handoff of [false, true]) {
    const f = transportFixture(); let calls = 0;
    f.runtime.guest.send = async (_frame, _generation, hooks) => { calls++; await hooks.beforeSend(); if (handoff) hooks.onHandoff(); throw Error('socket-failure'); };
    await assert.rejects(f.runtime.dispatch('x', [], { id: 'job' }), { code: handoff ? 'OMP_COLLAB_UNKNOWN' : 'OMP_COLLAB_NOT_SUBMITTED' });
    assert.equal(calls, 1); assert.equal(f.revoked.length, 1); assert.equal(f.facts.at(-1).status, handoff ? 'unknown' : 'rejected');
  }
});

test('revocation failure holds runtime even when send was provably not submitted', async () => {
  const f = transportFixture();
  f.runtime.guest.upload = async () => { throw Error('upload-failure'); };
  f.runtime.grants.revoke = async () => { throw Error('revoke-disk-full'); };
  await assert.rejects(f.runtime.dispatch('x', [{ data: 'x' }], { id: 'job' }), { code: 'OMP_COLLAB_HOLD' });
  await assert.rejects(f.runtime.dispatch('retry', [], { id: 'job' }), { code: 'OMP_COLLAB_HOLD' });
  assert.deepEqual(f.sent, []);
});

test('cancellation during upload and concurrent dispatch cannot submit stale work', async () => {
  const entered = deferred(), release = deferred(), f = transportFixture();
  f.runtime.guest.upload = async () => { entered.resolve(); await release.promise; return []; };
  const dispatch = f.runtime.dispatch('x', [{ data: 'x' }], { id: 'job' });
  await entered.promise;
  await assert.rejects(f.runtime.dispatch('second', [], { id: 'other' }), { code: 'OMP_COLLAB_NOT_SUBMITTED' });
  const requestId = f.grants[0].rid;
  await assert.rejects(f.runtime.cancel({ id: 'other' }, requestId), /target-mismatch/);
  assert.deepEqual(await f.runtime.cancel({ id: 'job' }, requestId), { notSubmitted: true });
  release.resolve(); await assert.rejects(dispatch, { code: 'OMP_COLLAB_NOT_SUBMITTED' });
  assert.deepEqual(f.sent, []);
});

test('abort remains available after Work closes but binds exact job, owner and original request', async () => {
  let open = true;
  const f = transportFixture({ eligibility: async (_job, kind) => ({ scopeAllowed: true, hostAdmitted: true, workOpen: kind === 'abort' ? false : open }) });
  const admitted = await f.runtime.dispatch('x', [], { id: 'job' });
  open = false;
  f.runtime.nativeState = async () => ({ editorDraft: { known: false } });
  await f.runtime.cancel({ id: 'job' }, admitted.collab.requestId);
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].t, 'abort'); assert.equal(f.sent[1].tr, admitted.collab.requestId);
  assert.equal(f.grants[1].jobId, 'job'); assert.equal(f.grants[1].binding.ownerId, 'owner');
  assert.equal(f.facts.at(-1).seq, 2);
  const frame = f.sent[1];
  await f.runtime.receive({ t: 'action-receipt', rid: frame.rid, ep: frame.ep, ar: frame.ar, kind: 'abort', status: 'executed', seq: 2 });
  await assert.rejects(f.runtime.receive({ t: 'action-receipt', rid: frame.rid, ep: frame.ep, ar: frame.ar, kind: 'abort', status: 'rejected', seq: 2 }), /receipt-mutated/);
});

test('snapshot evidence is bounded in memory without losing old ancestry or mutation detection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-evidence-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = new NativeCollabRuntime({ home: '/unused', context: {}, onEntry: async () => {} });
  runtime.evidenceRoot = root; runtime.sessionId = 'session'; runtime.guest = { epoch: 'session#0' };
  const deliver = entry => runtime.receive({ t: 'nozeli-entry-part', id: entry.id, index: 0, final: true, data: Buffer.from(JSON.stringify(entry)).toString('base64') });
  const first = { id: 'root', type: 'custom_message', details: { requestId: 'request', jobId: 'job', epoch: 'session#0' } };
  await deliver(first);
  for (let i = 0; i < 2050; i++) await deliver({ id: 'entry-' + i, parentId: 'root', type: 'custom', data: {} });
  assert.equal(runtime.entries.size, 2048); assert.equal(runtime.identities.size, 2048); assert.equal(runtime.identities.has('root'), false);
  await runtime.receive({ t: 'snapshot-chunk', final: true });
  await deliver({ id: 'answer', parentId: 'root', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'preserved' }] } });
  assert.equal(runtime.identities.get('answer').jobId, 'job'); assert.equal(runtime.answer('request'), 'preserved');
  await assert.rejects(deliver({ ...first, details: { ...first.details, jobId: 'forged' } }), /native-entry-mutated/);
  await runtime.receive({ t: 'snapshot-chunk', final: true }); assert.equal(runtime.snapshot.length, 0);
});

test('close drains queued native callbacks and surfaces persistence failures while closing every resource', async () => {
  const f = transportFixture(), order = [], gate = deferred();
  f.runtime.guest.close = async () => { await gate.promise; order.push('persisted'); throw Error('persistence-failed'); };
  f.runtime.guest.drain = async () => { order.push('guest'); };
  f.runtime.grants.close = async () => { order.push('grants'); };
  f.runtime.relay = { close: async () => { order.push('relay'); } };
  const closing = f.runtime.close(); assert.deepEqual(order, []);
  gate.resolve(); await assert.rejects(closing, { code: 'OMP_COLLAB_HOLD' });
  assert.deepEqual(order, ['persisted', 'guest', 'grants', 'relay']);
});

test('only socket cleanup failure with successful durable stages permits explicit recovery', async () => {
  for (const stage of ['transport', 'journal', 'truncation', 'snapshot', 'revoke', 'grant-close', 'relay']) {
    const f = transportFixture();
    const transport = Object.assign(Error('private socket detail'), { code: 'ECONNRESET' });
    f.runtime.guest.close = async () => { throw transport; };
    if (stage === 'journal') f.runtime.guest.drain = async () => { throw Error('private journal detail'); };
    if (stage === 'truncation') f.runtime.parts = {};
    if (stage === 'snapshot') f.runtime.flushSnapshot = async () => { throw Error('private snapshot detail'); };
    if (stage === 'revoke') f.runtime.grants.revokeOwner = async () => { throw Error('private grant detail'); };
    if (stage === 'grant-close') f.runtime.grants.close = async () => { throw Error('private lease detail'); };
    f.runtime.relay = { close: async () => { if (stage === 'relay') throw Error('private relay detail'); } };
    await assert.rejects(f.runtime.close(), { code: 'OMP_COLLAB_HOLD' });
    assert.equal(f.runtime.closeReport.recoverySafe, stage === 'transport');
    assert.equal(f.runtime.closeReport.stages.length, 7);
    assert.equal(JSON.stringify(f.runtime.closeReport).includes('private'), false);
    await assert.rejects(f.runtime.close(), { code: 'OMP_COLLAB_HOLD' });
  }
});

test('successful resource shutdown never clears an earlier durable hold', async () => {
  const f = transportFixture();
  f.runtime.relay = { close: async () => {} };
  const held = f.runtime.failHold(Error('earlier persistence failure'));
  await assert.rejects(f.runtime.close(), error => error === held);
  assert.equal(f.runtime.closeReport.recoverySafe, false);
  assert.equal(f.runtime.closeReport.stages.every(stage => stage.ok), true);
});

test('bounded answer never silently truncates or mixes requests', () => {
  const f = transportFixture();
  f.runtime.bindManual('one', 'job');
  f.runtime.collectAnswer({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024 + 1) }] } }, { requestId: 'one' });
  assert.throws(() => f.runtime.answer('one'), { code: 'OMP_COLLAB_ANSWER_LIMIT' });
  f.runtime.bindManual('two', 'job2'); assert.equal(f.runtime.answer('two'), '');
  assert.throws(() => f.runtime.answer('one'), /not-current/);
});

test('real encrypted guest rejects replay and drains a pre-close accepted callback', async () => {
  const relay = await startLocalRelay(), key = randomBytes(32), token = randomBytes(16), secret = Buffer.concat([key, token]).toString('base64url');
  const host = new WebSocket(relay.url + '/r/securetest?role=host&cap=' + relay.capability);
  const entered = deferred(), release = deferred(); let calls = 0;
  const guest = new ManagedCollabGuest({ capability: relay.capability, onFrame: async frame => { if (frame.t === 'probe') { calls++; entered.resolve(); await release.promise; } } });
  try {
    await once(host, 'open');
    host.on('message', (data, binary) => {
      if (!binary) return;
      const peer = data.readUInt32BE(0), envelope = Buffer.from(data); envelope.writeUInt32BE(0);
      const frame = openFrame(key, envelope);
      if (frame.t === 'hello') {
        for (const outgoing of [{ t: 'welcome', header: { id: 'session' }, nozeli: { managedCollab: 1, admission: 'rid-required', epoch: 'session#0' } }, { t: 'snapshot-chunk', final: true }]) {
          const packet = sealFrame(key, outgoing); packet.writeUInt32BE(peer); host.send(packet);
        }
      }
    });
    await guest.connect(relay.url + '/r/securetest.' + secret);
    const packet = sealFrame(key, { t: 'probe' }); packet.writeUInt32BE(1); host.send(packet);
    await entered.promise;
    host.send(packet); // Same authenticated nonce, not a second callback.
    release.resolve();
    await once(guest.ws, 'close');
    await assert.rejects(guest.drain(), /frame-replay/); assert.equal(calls, 1);
  } finally { release.resolve(); await guest.close().catch(() => {}); host.terminate(); await relay.close(); }
});

test('real guest close waits for accepted callback before wiping its encryption key', async () => {
  const relay = await startLocalRelay(), key = randomBytes(32), secret = Buffer.concat([key, randomBytes(16)]).toString('base64url');
  const host = new WebSocket(relay.url + '/r/closetest?role=host&cap=' + relay.capability);
  const entered = deferred(), release = deferred(); let persisted = false, lost = false;
  const guest = new ManagedCollabGuest({ capability: relay.capability,
    onFrame: async frame => { if (frame.t === 'probe') { entered.resolve(); await release.promise; persisted = true; } },
    onLost: async () => { assert.equal(persisted, true); lost = true; } });
  try {
    await once(host, 'open');
    host.on('message', (data, binary) => {
      if (!binary) return;
      const peer = data.readUInt32BE(0), incoming = Buffer.from(data); incoming.writeUInt32BE(0);
      if (openFrame(key, incoming).t !== 'hello') return;
      for (const frame of [{ t: 'welcome', header: { id: 'session' }, nozeli: { managedCollab: 1, admission: 'rid-required', epoch: 'session#0' } }, { t: 'snapshot-chunk', final: true }]) {
        const packet = sealFrame(key, frame); packet.writeUInt32BE(peer); host.send(packet);
      }
    });
    await guest.connect(relay.url + '/r/closetest.' + secret);
    const packet = sealFrame(key, { t: 'probe' }); packet.writeUInt32BE(1); host.send(packet);
    await entered.promise;
    const closing = guest.close(); assert.equal(persisted, false); assert.deepEqual(guest.key, key);
    release.resolve(); await closing;
    assert.equal(persisted, true); assert.equal(lost, true); assert.deepEqual(guest.key, Buffer.alloc(32));
  } finally { release.resolve(); await guest.close().catch(() => {}); host.terminate(); await relay.close(); }
});

test('current native draft changes during upload cannot consume the already issued grant', async () => {
  const f = transportFixture();
  f.runtime.guest.upload = async () => { f.runtime.nativeState = async () => ({ editorDraft: { known: true, hasText: true } }); return []; };
  await assert.rejects(f.runtime.dispatch('x', [{ data: 'x' }], { id: 'job' }), { code: 'NATIVE_DRAFT_PENDING' });
  assert.equal(f.revoked.length, 1); assert.deepEqual(f.sent, []); assert.equal(f.facts.at(-1).status, 'rejected');
});

test('settlement requires matching terminal evidence and survives disconnect without unknown facts', async () => {
  const f = transportFixture();
  const { collab } = await f.runtime.dispatch('x', [], { id: 'job' });
  const evidence = { ...collab, agentEnd: true, idle: true, noPending: true };
  for (const patch of [{ epoch: 'old' }, { sessionId: 'foreign' }, { requestId: 'other' }, { agentEnd: false }, { idle: false }, { noPending: false }]) {
    await assert.rejects(f.runtime.settled(collab.requestId, { ...evidence, ...patch }), /settlement-identity/);
  }
  await f.runtime.settled(collab.requestId, evidence);
  await f.runtime.settled(collab.requestId, evidence);
  await f.runtime.lost();
  assert.equal(f.facts.filter(fact => fact.status === 'settled').length, 1);
  assert.equal(f.facts.some(fact => fact.status === 'unknown'), false);
});

test('drain races host EOF but still holds on failed callbacks and truncated entries', async () => {
  const f = transportFixture(), ended = deferred(), persisted = deferred(); let drained = false;
  f.runtime.guest.ws = { readyState: 1 }; f.runtime.guest.ended = ended.promise;
  f.runtime.guest.send = async () => { ended.resolve(); };
  f.runtime.guest.drain = async () => { await persisted.promise; drained = true; };
  const draining = f.runtime.drain();
  assert.equal(drained, false); persisted.resolve(); await draining;
  assert.equal(drained, true); assert.equal(f.runtime.syncWaiters.size, 0);
  f.runtime.parts = { id: 'truncated' };
  await assert.rejects(f.runtime.drain(), /native-entry-truncated/);
  f.runtime.parts = null;
  f.runtime.guest.drain = async () => { throw Error('callback-disk-full'); };
  await assert.rejects(f.runtime.close(), error => error.code === 'OMP_COLLAB_HOLD' && error.cause.errors.some(cause => cause.message === 'callback-disk-full'));
});

test('close after native host exit never syncs and waits for all local persistence', async () => {
  const f = transportFixture(), persisted = deferred(); let completed = false;
  f.runtime.guest.ws = { readyState: 1 };
  f.runtime.guest.send = async () => { throw Error('must-not-sync-exited-host'); };
  f.runtime.guest.close = async () => { await persisted.promise; completed = true; };
  const closing = f.runtime.close(); assert.equal(completed, false);
  persisted.resolve(); await closing; assert.equal(completed, true); assert.equal(f.runtime.hold, undefined);
});

test('cold native snapshot preserves old attribution without creating answers or accepting old receipts', async () => {
  const facts = [], runtime = new NativeCollabRuntime({ home: '/unused', context: {}, onEntry: fact => facts.push(fact) });
  runtime.sessionId = 'session'; runtime.epoch = 'session#1'; runtime.guest = { epoch: runtime.epoch };
  const deliver = entry => runtime.receive({ t: 'nozeli-entry-part', id: entry.id, index: 0, final: true, data: Buffer.from(JSON.stringify(entry)).toString('base64') });
  const old = { id: 'old-input', type: 'custom_message', details: { requestId: 'old-request', jobId: 'old-job', epoch: 'session#0' } };
  await deliver(old);
  const answer = { id: 'old-output', parentId: old.id, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'historical' }] } };
  await deliver(answer);
  await deliver({ ...answer, message: { ...answer.message, errorId: 0 } });
  await runtime.receive({ t: 'snapshot-chunk', final: true });
  assert.equal(facts[0].entries[1].requestId, 'old-request'); assert.equal(facts[0].entries[1].epoch, 'session#0');
  assert.equal(Object.hasOwn(facts[0].entries[1].entry.message, 'errorId'), false);
  assert.equal(runtime.answerState, null); assert.equal(runtime.attempts.size, 0);
  await assert.rejects(runtime.receive({ t: 'action-receipt', rid: 'old-request', ep: 'session#0', status: 'executed' }), /receipt-identity/);
  await assert.rejects(deliver({ ...answer, message: { ...answer.message, errorId: 7 } }), /native-entry-mutated/);
});

test('real host EOF drains accepted callbacks and never masks persistence, authentication or identity errors', async t => {
  for (const failure of [null, 'persistence', 'authentication', 'identity']) await t.test(failure ?? 'normal EOF', async () => {
    const relay = await startLocalRelay(), key = randomBytes(32), secret = Buffer.concat([key, randomBytes(16)]).toString('base64url');
    const host = new WebSocket(relay.url + '/r/eoftest1?role=host&cap=' + relay.capability);
    const entered = deferred(), release = deferred(); let persisted = false;
    const runtime = new NativeCollabRuntime({ home: '/unused', context: {}, onEntry: async () => { entered.resolve(); await release.promise; if (failure === 'persistence') throw Error('callback-persistence-failed'); persisted = true; } });
    const guest = runtime.guest = new ManagedCollabGuest({ capability: relay.capability, onFrame: frame => runtime.receive(frame), onLost: () => runtime.lost() });
    runtime.sessionId = 'session';
    const outgoing = frame => { const packet = sealFrame(key, frame); packet.writeUInt32BE(1); host.send(packet); };
    try {
      await once(host, 'open');
      host.on('message', (data, binary) => {
        if (!binary) return;
        const incoming = Buffer.from(data); incoming.writeUInt32BE(0);
        if (openFrame(key, incoming).t !== 'hello') return;
        outgoing({ t: 'welcome', header: { id: 'session' }, nozeli: { managedCollab: 1, admission: 'rid-required', epoch: 'session#0' } });
        outgoing({ t: 'snapshot-chunk', final: true });
      });
      await guest.connect(relay.url + '/r/eoftest1.' + secret);
      const entry = { id: 'entry', type: 'custom', data: {} };
      outgoing({ t: 'nozeli-entry-part', id: 'entry', index: 0, final: true, data: Buffer.from(JSON.stringify(entry)).toString('base64') });
      await entered.promise;
      if (failure === 'authentication') {
        const packet = sealFrame(key, { t: 'probe' }); packet[20] ^= 1; packet.writeUInt32BE(1); host.send(packet);
      } else if (failure === 'identity') outgoing({ t: 'action-receipt', rid: 'old-request', ep: 'old-epoch' });
      outgoing({ t: 'bye' });
      const closed = once(guest.ws, 'close'); guest.ws.close();
      await closed;
      const draining = runtime.drain(); let done = false; draining.then(() => { done = true; }, () => {});
      assert.equal(done, false); release.resolve();
      if (failure) {
        await assert.rejects(draining);
        const diagnostics = runtime.diagnostics();
        assert.equal(typeof diagnostics.disconnect.code, 'number');
        assert.ok(diagnostics.failure);
        assert.equal(JSON.stringify(diagnostics).includes(secret), false);
        assert.equal(JSON.stringify(diagnostics).includes(relay.capability), false);
        if (failure === 'identity') assert.equal(diagnostics.failure.category, 'collab-receipt-identity');
        await assert.rejects(runtime.close(), { code: 'OMP_COLLAB_HOLD' });
      } else {
        await draining; await runtime.close(); assert.equal(persisted, true);
      }
    } finally { release.resolve(); await guest.close().catch(() => {}); host.terminate(); await relay.close(); }
  });
});

test('missing Session eligibility refuses any grant rather than fabricating admission', async () => {
  const f = transportFixture({ eligibility: undefined });
  await assert.rejects(f.runtime.dispatch('x', [], { id: 'job' }), { code: 'OMP_COLLAB_NOT_SUBMITTED' });
  assert.deepEqual(f.grants, []); assert.deepEqual(f.sent, []);
});

test('native string and non-array assistant content persists unchanged without poisoning answer collection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-string-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const facts = [], f = transportFixture({ onEntry: fact => facts.push(fact) });
  f.runtime.evidenceRoot = root;
  f.runtime.identities.set('parent', { requestId: 'request', jobId: 'job', epoch: f.runtime.epoch });
  const contents = ['plain native text', [{ type: 'text', text: 'array ' }, { type: 'thinking', thinking: 'private' }, { type: 'text', text: 'text' }], null, {}, 7];
  for (const [index, content] of contents.entries()) {
    const entry = { id: 'content-' + index, parentId: 'parent', type: 'message', message: { role: 'assistant', content } };
    const frame = { t: 'nozeli-entry-part', id: entry.id, index: 0, final: true, data: Buffer.from(JSON.stringify(entry)).toString('base64') };
    await f.runtime.receive(frame); await f.runtime.receive(frame);
    assert.equal((await f.runtime.stored(entry.id)).projected, true);
  }
  assert.deepEqual(facts.map(fact => fact.entry.message.content), contents);
  assert.equal(f.runtime.answer('request'), 'plain native text\narray text\n\n\n');
  await f.runtime.close();
});

test('archived exact entry is not acknowledged until consumer persistence succeeds', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-projection-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let fail = true, calls = 0;
  const f = transportFixture({ onEntry: async () => { calls++; if (fail) throw Object.assign(Error('disk failure'), { code: 'ENOSPC' }); } });
  f.runtime.evidenceRoot = root;
  f.runtime.identities.set('parent', { requestId: 'request', jobId: 'job', epoch: f.runtime.epoch });
  const entry = { id: 'pending-projection', parentId: 'parent', type: 'message', message: { role: 'assistant', content: 'original' } };
  const frame = value => ({ t: 'nozeli-entry-part', id: value.id, index: 0, final: true, data: Buffer.from(JSON.stringify(value)).toString('base64') });
  await assert.rejects(f.runtime.receive(frame(entry)), { code: 'ENOSPC' });
  assert.equal((await f.runtime.stored(entry.id)).projected, false);
  assert.equal(f.runtime.entries.has(entry.id), false);
  await assert.rejects(f.runtime.receive(frame({ ...entry, message: { ...entry.message, content: 'changed' } })), /native-entry-mutated/);
  fail = false;
  await f.runtime.receive(frame(entry)); await f.runtime.receive(frame(entry));
  assert.equal(calls, 2);
  assert.equal(f.runtime.answer('request'), 'original');
  assert.equal((await f.runtime.stored(entry.id)).projected, true);
});

test('fresh runtime projects legacy unacknowledged archive without changing immutable evidence or creating an answer', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-legacy-projection-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = transportFixture({ onEntry: async () => { throw Error('consumer unavailable'); } });
  original.runtime.evidenceRoot = root;
  original.runtime.identities.set('parent', { requestId: 'old-request', jobId: 'old-job', epoch: original.runtime.epoch });
  const entry = { id: 'legacy-unacknowledged', parentId: 'parent', type: 'message', message: { role: 'assistant', content: 'historical original' } };
  const frame = { t: 'nozeli-entry-part', id: entry.id, index: 0, final: true, data: Buffer.from(JSON.stringify(entry)).toString('base64') };
  await assert.rejects(original.runtime.receive(frame), /consumer unavailable/);
  const [file] = await fs.readdir(root), legacy = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
  delete legacy.projected;
  await fs.writeFile(path.join(root, file), JSON.stringify(legacy));
  const facts = [], recovered = transportFixture({ onEntry: fact => facts.push(fact) });
  recovered.runtime.evidenceRoot = root; recovered.runtime.snapshotting = true;
  await recovered.runtime.receive(frame);
  await recovered.runtime.receive({ t: 'snapshot-chunk', final: true });
  assert.deepEqual(facts[0].entries[0].entry, entry);
  assert.equal(facts[0].entries[0].requestId, 'old-request');
  assert.equal(recovered.runtime.answerState, null);
  assert.deepEqual((await recovered.runtime.stored(entry.id)).entry, entry);
  assert.equal((await recovered.runtime.stored(entry.id)).projected, true);
  await recovered.runtime.receive(frame);
  assert.equal(facts.length, 1);
});
