// Consumer boundaries call the imported production class, never a copied class or
// the removed bridge.prompt transport. Actual CLI + Collab coverage lives in
// omp-collab-native-tools-live.mjs, omp-tui-images-live.mjs and omp-tui-attach-races.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmpTuiSession } from '../src/agents/managed/omp-tui-session.mjs';

const spec = overrides => ({ role: 'frontdesk', home: path.join(os.tmpdir(), 'session-boundary-no-start'), cwd: os.tmpdir(), model: 'stale/model', effort: 'stale', tools: [], ...overrides });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=';

// Only dependencies already consumed through the public instance surface are
// injected. These tests do not claim native completion or manufacture agent_end.
function consumer(overrides = {}) {
  const session = new OmpTuiSession(spec(overrides));
  session.phase = 'ready';
  return session;
}

function unchangedAdmission(session) {
  assert.equal(session.currentTicket, null);
  assert.equal(session.blockedTicket, null);
  assert.equal(session.hasPrompted, false);
  assert.equal(session.promptsDelivered, 0);
}

test('construction requires a private absolute home and never applies stale host model selection', async () => {
  for (const home of [undefined, '', 'relative']) assert.throws(() => new OmpTuiSession(spec({ home })), { code: 'OMP_HOME_REQUIRED' });
  const session = new OmpTuiSession(spec());
  assert.equal(session.phase, 'constructed');
  assert.equal(session.model, null);
  assert.equal(session.effort, null);
  assert.equal(session.ownerGeneration, 1);
  assert.equal(session.snapshot().capabilities.v2Framing, 'managed Collab AES-GCM chunks; private extension bridge is safety/control only');
  await assert.rejects(session.prompt('not started'), { code: 'OMP_NOT_DISPATCHABLE' });
  await assert.rejects(session.start({ id: 'not-a-pinned-session-id' }), { code: 'OMP_RESUME_INVALID' });
  assert.equal(session.phase, 'constructed');
  unchangedAdmission(session);
});

for (const phase of ['constructed', 'connecting', 'prompt-inflight', 'blocked-unresolved-turn', 'manual-unresolved', 'settlement-pending', 'closed']) {
  test(`prompt in ${phase} never reaches Collab or replaces an owner`, async () => {
    const session = consumer(); let calls = 0;
    session.phase = phase;
    session.collab = { dispatch: async () => { calls++; throw Error('unexpected dispatch'); } };
    const ticket = { promptId: 'existing', ownerGeneration: 1 };
    session.currentTicket = ticket;
    await assert.rejects(session.prompt('must not dispatch'), { code: 'OMP_NOT_DISPATCHABLE' });
    assert.equal(session.currentTicket, ticket);
    assert.equal(session.phase, phase);
    assert.equal(calls, 0);
    assert.equal(session.ownerGeneration, 1);
  });
}

test('manual ticket and stopping gates precede prompt validation and preserve their owner', async () => {
  const session = consumer();
  const ticket = { promptId: 'manual-1', manual: true, ownerGeneration: 1, jobReady: false };
  session.currentTicket = ticket;
  await assert.rejects(session.prompt('host cannot join manual input'), { code: 'OMP_MANUAL_TURN_OPEN' });
  assert.equal(session.currentTicket, ticket);
  session.currentTicket = null; session.stopRequested = true;
  await assert.rejects(session.prompt('host cannot join stop'), { code: 'OMP_STOPPING' });
  unchangedAdmission(session);
});

test('invalid text/images and native visual capability fail before ticket creation or Collab dispatch', async () => {
  const session = consumer(); let reads = 0, deliveries = 0;
  session.bridge = { getState: async () => { reads++; return { model: 'native/text-only', modelInput: ['text'] }; } };
  session.collab = { dispatch: async () => { deliveries++; throw Error('unexpected dispatch'); } };
  for (const text of [null, {}, '', '  ']) await assert.rejects(session.prompt(text), { code: 'OMP_PROMPT_INVALID' });
  for (const images of [null, {}, [''], ['https://example.invalid/a.png'], ['data:image/png;base64,not-base64'], ['data:image/png;base64,YWJj'], [{ source: { kind: 'base64' }, apiKey: 'x' }], [{ type: 'image', data: png, mimeType: 'image/png' }], Array(9).fill(png)]) {
    await assert.rejects(session.prompt('invalid image', { images }), { code: 'OMP_IMAGE_INVALID' });
    unchangedAdmission(session);
  }
  assert.equal(reads, 0, 'malformed input does not even query the native bridge');
  await assert.rejects(session.prompt('text only', { images: [png] }), { code: 'OMP_IMAGE_UNSUPPORTED' });
  session.bridge.getState = async () => ({ model: 'native/unknown' });
  await assert.rejects(session.prompt('unknown capability', { images: [png] }), { code: 'OMP_IMAGE_CAPABILITY_UNKNOWN' });
  unchangedAdmission(session);
  assert.equal(deliveries, 0);
});

for (const change of ['manual', 'phase', 'stop']) test(`image capability await rechecks ${change} ownership before dispatch`, async () => {
  const session = consumer(); let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  session.bridge = { getState: () => { entered(); return new Promise(resolve => { release = resolve; }); } };
  const pending = session.prompt('image', { images: [png] });
  const rejected = assert.rejects(pending, { code: { manual: 'OMP_MANUAL_TURN_OPEN', phase: 'OMP_NOT_DISPATCHABLE', stop: 'OMP_STOPPING' }[change] });
  await reading;
  const ticket = { promptId: 'new-manual', manual: true, ownerGeneration: 1 };
  if (change === 'manual') session.currentTicket = ticket;
  if (change === 'phase') session.phase = 'blocked-unresolved-turn';
  if (change === 'stop') session.stopRequested = true;
  release({ model: 'native/visual', modelInput: ['text', 'image'] });
  await rejected;
  assert.equal(session.currentTicket, change === 'manual' ? ticket : null);
  assert.equal(session.hasPrompted, false);
});

for (const code of ['OMP_COLLAB_REJECTED', 'NATIVE_DRAFT_PENDING']) test(`${code} resolves rejected admission without replay or an unresolved ticket`, async () => {
  const session = consumer(); let calls = 0;
  const job = { id: 'host-job', revision: 1, type: 'work' };
  session.collab = { dispatch: async (text, images, actualJob) => {
    calls++;
    assert.equal(text, 'host request'); assert.deepEqual(images, []); assert.equal(actualJob, job);
    assert.equal(session.currentTicket.ownerGeneration, session.ownerGeneration);
    assert.equal(session.currentTicket.admitted, false);
    assert.equal(session.phase, 'prompt-inflight');
    throw Object.assign(Error('explicitly refused'), { code });
  } };
  await assert.rejects(session.prompt('host request', { job }), { code });
  assert.equal(calls, 1);
  assert.equal(session.phase, 'idle');
  assert.equal(session.currentTicket, null);
  assert.equal(session.blockedTicket, null);
  assert.equal(session.busy, false);
  assert.equal(session.promptsDelivered, 0);
  assert.equal(session.resolvedTickets.size, 1);
});

test('lost Collab admission ack retains the same host job and blocks replay even if native state looks idle', async () => {
  const session = consumer({ settleTimeoutMs: 0 }); let calls = 0, reads = 0;
  const job = { id: 'lost-ack-job', revision: 1 };
  session.bridge = { getState: async () => { reads++; return { isIdle: true, hasPending: false }; } };
  session.collab = { dispatch: async () => { calls++; throw Object.assign(Error('ack lost'), { code: 'OMP_COLLAB_UNKNOWN' }); } };
  await assert.rejects(session.prompt('first', { job }), { code: 'OMP_COLLAB_UNKNOWN' });
  assert.equal(session.phase, 'blocked-unresolved-turn');
  assert.equal(session.currentTicket, null);
  assert.equal(session.blockedTicket.job, job);
  assert.equal(session.blockedTicket.ownerGeneration, session.ownerGeneration);
  assert.equal(session.blockedTicket.admitted, false);
  assert.equal(session.promptsDelivered, 0);
  await assert.rejects(session.prompt('must not replay', { job }), { code: 'OMP_NOT_DISPATCHABLE' });
  assert.equal(calls, 1);
  assert.equal(reads, 0, 'idle alone is never queried as substitute for missing agent_end');
});

test('interrupt invalidates the owner before awaiting authoritative Collab cancellation; timeout preserves ticket', async () => {
  const session = consumer(); const job = { id: 'cancel-job' };
  const ticket = { promptId: 'host-ticket', ownerGeneration: 1, job, collab: { requestId: 'native-request' } };
  session.phase = 'prompt-inflight'; session.currentTicket = ticket;
  let cancelCalls = 0;
  session.collab = { cancel: async (actualJob, requestId) => {
    cancelCalls++;
    assert.equal(actualJob, job); assert.equal(requestId, 'native-request');
    assert.equal(session.ownerGeneration, 2);
    assert.equal(ticket.interrupted.code, 'OMP_INTERRUPTED');
  } };
  await assert.rejects(session.interrupt({ timeout: 0 }), { code: 'OMP_INTERRUPT_TIMEOUT' });
  assert.equal(cancelCalls, 1);
  assert.equal(session.currentTicket, ticket);
  assert.equal(session.resolvedTickets.size, 0, 'cancel acknowledgement is not terminal settlement');
  assert.equal(session.phase, 'prompt-inflight');
});

test('stopIdle refuses tickets and provider activity; snapshot retains owner and receipt evidence', async () => {
  const session = consumer(); let reads = 0;
  session.bridge = { getState: async () => { reads++; return { isIdle: false }; } };
  session.blockedTicket = { promptId: 'blocked', ownerGeneration: 1 };
  await assert.rejects(session.stopIdle(), { code: 'OMP_NOT_IDLE' });
  assert.equal(reads, 0);
  assert.equal(session.snapshot().blockedTicket, session.blockedTicket);
  session.blockedTicket = null;
  await assert.rejects(session.stopIdle(), { code: 'OMP_NOT_IDLE' });
  assert.equal(reads, 1);
  assert.equal(session.stopRequested, false);
  assert.equal(session.ownerGeneration, 1);
});

test('native refresh observes model/effort/draft but closed owners cannot query the bridge', async () => {
  const session = consumer(); const drafts = []; let reads = 0;
  session.on('native-draft', draft => drafts.push(draft));
  session.bridge = { getState: async () => { reads++; return { model: 'native/selection', thinkingLevel: 'high', editorDraft: { known: true, hasText: true } }; } };
  assert.equal(await session.refreshNativeDraft(), true);
  assert.equal(session.model, 'native/selection'); assert.equal(session.effort, 'high');
  assert.equal(session.effective.selectionOwner, 'native'); assert.deepEqual(drafts, [true]);
  session.closed = true;
  assert.equal(await session.refreshNativeDraft(), undefined);
  assert.equal(reads, 1);
});

test('historical tools digest never substitutes for actual registration evidence', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tui-tools-boundary-'));
  const session = new OmpTuiSession(spec({ home, tools: [{ name: 'nozeli_probe', description: 'probe', inputSchema: { type: 'object', properties: { k: { type: 'string' } } } }] }));
  assert.throws(() => session.assertToolsDigest(session.toolsDigest), { code: 'OMP_TOOLS_DIGEST_MISMATCH' });
  await assert.rejects(session.preflightToolsDigest(session.toolsDigest), { code: 'OMP_TOOLS_DIGEST_MISMATCH' });
  assert.deepEqual(await session.preflightToolsDigest(null), { expectedDigest: null, toolsDigest: session.toolsDigest, compatible: true });
});

test('failed Collab close still disposes screen and records native exit without inventing descendant proof', async () => {
  const session = consumer(), order = [];
  const failure = Object.assign(Error('collab-hold: collab-close-failed'), { code: 'OMP_COLLAB_HOLD' });
  session.protocolEnded = true;
  session.exitPromise = Promise.resolve({ exitCode: 1, signal: 1 });
  session.bridge = { shutdown: async () => {}, close: async () => { order.push('bridge'); } };
  session.collab = { hold: failure, closeReport: { recoverySafe: false }, close: async () => { order.push('collab'); throw failure; } };
  session.screen = { dispose: async () => { order.push('screen'); } };
  await assert.rejects(session.stop(), error => error === failure);
  assert.deepEqual(order, ['bridge', 'collab', 'screen']);
  assert.equal(session.lastExitReceipt.exited, true);
  assert.equal(session.lastExitReceipt.confirmationComplete, false);
  assert.equal(session.lastExitReceipt.cleanupComplete, false);
  assert.equal(failure.exitReceipt, session.lastExitReceipt);
  await assert.rejects(session.stop({ recover: true }), error => error === failure);
  assert.deepEqual(order, ['bridge', 'collab', 'screen']);
});

test('explicit recovery requires both durable close and native owner proof and never clears cached evidence', async () => {
  for (const [confirmed, safe, recoverable] of [[true, true, true], [false, true, true], [true, false, true], [true, true, false]]) {
    const session = consumer();
    const error = session.stopFailure = Object.assign(Error('cleanup failed'), { code: 'OMP_COLLAB_HOLD' });
    session.stopPromise = Promise.reject(error); session.stopPromise.catch(() => {});
    session.lastExitReceipt = { confirmationComplete: confirmed, recoverableCleanup: recoverable, cleanupComplete: false };
    session.collab = { closeReport: { recoverySafe: safe } };
    await assert.rejects(session.stop(), cause => cause === error);
    if (confirmed && safe && recoverable) {
      const receipt = await session.stop({ recover: true });
      assert.equal(receipt.recovered, true); assert.equal(receipt.cleanupComplete, false);
    } else await assert.rejects(session.stop({ recover: true }), cause => cause === error);
    await assert.rejects(session.stop(), cause => cause === error);
  }
});

test('cleanup evidence exposes bounded stages and confirmation without raw error or receipt layers', () => {
  const session = consumer();
  session.lastExitReceipt = { exited: true, confirmationComplete: true, cleanupComplete: false, layers: { private: 'secret endpoint' } };
  session.collab = { closeReport: { recoverySafe: false, stages: [{ stage: 'journal-drain', ok: false, category: 'journal-drain', failure: 'native-entry-mutated' }] }, diagnostics: () => ({ failure: { category: 'native-entry-mutated' } }) };
  const snapshot = session.snapshot();
  assert.equal(snapshot.cleanupEvidence.exit.confirmationComplete, true);
  assert.equal(snapshot.cleanupEvidence.closeReport.stages[0].failure, 'native-entry-mutated');
  assert.equal(JSON.stringify(snapshot.cleanupEvidence).includes('secret endpoint'), false);
  assert.equal(JSON.stringify(snapshot.lastExitReceipt).includes('secret endpoint'), false);
});
