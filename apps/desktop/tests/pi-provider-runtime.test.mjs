import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createNozeliPiSource} from '../src/agents/managed/pi-source.mjs';
import {resolveBundledPiRuntime} from '../src/agents/managed/pi-runtime.mjs';
import {PiSettingsWorker} from '../src/agents/managed/pi-auth.mjs';

async function integrationTree(t, { withLaunch = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-pi-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'owner.mjs'), 'export {};\n');
  if (withLaunch) await fs.writeFile(path.join(root, 'src', 'launch.mjs'), [
    "import path from 'node:path';",
    'export async function resolvePiWorkerRuntime({ integrationRoot, nodePath } = {}) {',
    "  if (!integrationRoot) throw Error('integrationRoot required');",
    '  return { command: nodePath ?? process.execPath, args: [path.join(integrationRoot, "src", "owner.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };',
    '}',
    ''
  ].join('\n'));
  return root;
}

test('private Pi source is pinned beneath the Nozeli root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-pi-source-'));
  const source = createNozeliPiSource({ root });
  assert.equal(source.agentDir, path.join(root, 'pi'));
  assert.equal(source.configRoot, root);
  assert.equal(source.private, true);
  assert.equal(source.profile, null);
  const described = await source.describe();
  assert.equal(described.agentDir, path.join(root, 'pi'));
  assert.throws(() => createNozeliPiSource({ root: 'relative/path' }));
});

test('bundled Pi runtime resolves the vendored entry with a scrubbed environment', async t => {
  const integration = await integrationTree(t);
  const home = path.join(os.tmpdir(), 'nozeli-pi-home');
  const spec = await resolveBundledPiRuntime({
    piHome: home,
    env: {
      NOZELI_PI_INTEGRATION_ROOT: integration,
      NOZELI_PI_NODE: '/opt/test-node/bin/node',
      NOZELI_PI_OWNER_HOME: '/role/home',
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'TEST_ONLY',
      PI_CONFIG_DIR: '/ambient/.pi',
      NODE_OPTIONS: '--require /ambient.js',
      OMP_AUTH_BROKER_TOKEN: 'TEST_ONLY'
    }
  });
  assert.equal(spec.command, '/opt/test-node/bin/node');
  assert.equal(spec.entry, path.join(integration, 'src', 'owner.mjs'));
  assert.deepEqual(spec.args, [path.join(integration, 'src', 'owner.mjs')]);
  assert.equal(spec.env.NOZELI_PI_HOME, home);
  assert.equal(spec.env.NOZELI_PI_OWNER_HOME, '/role/home');
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spec.env.PATH, '/usr/bin');
  for (const removed of ['OPENAI_API_KEY', 'PI_CONFIG_DIR', 'NODE_OPTIONS', 'OMP_AUTH_BROKER_TOKEN']) assert.equal(spec.env[removed], undefined);
  assert.equal(spec.agentDir, home);
});

test('missing vendored integration fails loudly without fallback discovery', async t => {
  const integration = await integrationTree(t, { withLaunch: false });
  await assert.rejects(resolveBundledPiRuntime({ piHome: path.join(os.tmpdir(), 'nozeli-pi-home'), env: { NOZELI_PI_INTEGRATION_ROOT: integration } }));
  await assert.rejects(resolveBundledPiRuntime({ piHome: path.join(os.tmpdir(), 'nozeli-pi-home'), env: { NOZELI_PI_INTEGRATION_ROOT: path.join(integration, 'missing') } }));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.written = [];
  child.stdin = { write: line => { child.written.push(line); } };
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => {
    if (child.exitCode != null || child.signalCode != null) return false;
    child.signalCode = signal ?? 'SIGTERM';
    queueMicrotask(() => child.emit('exit', null, child.signalCode));
    return true;
  };
  queueMicrotask(() => child.emit('spawn'));
  return child;
}
const lastRequest = child => JSON.parse(child.written[child.written.length - 1]);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('settings worker speaks the JSONL protocol and routes auth events', async t => {
  let child;
  const spawns = [];
  const worker = new PiSettingsWorker({ runtime: { command: '/fake/node', args: ['/fake/owner.mjs'], env: {} }, source: { root: '/nozeli', agentDir: '/nozeli/pi' }, spawnFn: () => { child = fakeChild(); spawns.push(child); return child; } });
  t.after(async () => {
    if (!worker.running) return;
    const exiting = worker.stop();
    const live = spawns[spawns.length - 1];
    const pending = live.written.map(line => JSON.parse(line)).find(message => message.method === 'stop');
    if (pending) {
      live.stdout.write(JSON.stringify({ id: pending.id, result: { confirmationComplete: true } }) + '\n');
      await new Promise(resolve => setImmediate(resolve));
    }
    live.exitCode = 0;
    live.emit('exit', 0, null);
    await exiting;
  });

  const models = worker.request('models');
  await flush();
  const request = lastRequest(child);
  assert.equal(request.method, 'models');
  child.stdout.write(JSON.stringify({ id: request.id, result: { models: [{ provider: 'official', modelId: 'm1' }] } }) + '\n');
  assert.deepEqual(await models, { models: [{ provider: 'official', modelId: 'm1' }] });

  const failure = worker.request('providerList');
  await flush();
  const failing = lastRequest(child);
  child.stdout.write(JSON.stringify({ id: failing.id, error: { code: 'busy', message: 'occupied' } }) + '\n');
  await assert.rejects(failure, error => error.code === 'busy' && /occupied/.test(error.message));

  const interactions = [];
  worker.events.on('interaction', interaction => interactions.push(interaction));
  child.stdout.write(JSON.stringify({ event: 'interaction', interaction: { id: 'w-1', kind: 'select', options: [{ id: 'a', label: 'A' }] } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].id, 'w-1');

  // Reverse tool calls are refused: the settings worker exposes no tools.
  child.stdout.write(JSON.stringify({ event: 'tool', id: 'w-9', tool: 'shell', arguments: {} }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  const refusal = child.written.map(line => JSON.parse(line)).find(message => message.method === 'respond');
  assert.equal(refusal.params.id, 'w-9');
  assert.equal(refusal.params.answer.isError, true);

  // Unexpected exit fails pending requests and the next call respawns.
  const hanging = worker.request('authList');
  child.emit('exit', 1, null);
  await assert.rejects(hanging, error => error.code === 'PI_RUNTIME_UNAVAILABLE');
  const retry = worker.request('authList');
  await flush();
  const respawned = lastRequest(spawns[spawns.length - 1]);
  child.stdout.write(JSON.stringify({ id: respawned.id, result: { credentials: [] } }) + '\n');
  assert.deepEqual(await retry, { credentials: [] });
});

test('settings worker stop asks the worker first and forces exit after', async () => {
  let child;
  const worker = new PiSettingsWorker({ runtime: { command: '/fake/node', args: ['/fake/owner.mjs'], env: {} }, source: { root: '/nozeli', agentDir: '/nozeli/pi' }, spawnFn: () => { child = fakeChild(); return child; } });
  const stopped = worker.request('authList');
  await flush();
  const seeded = lastRequest(child);
  child.stdout.write(JSON.stringify({ id: seeded.id, result: { credentials: [] } }) + '\n');
  await stopped;
  const exiting = worker.stop();
  const stopRequest = child.written.map(line => JSON.parse(line)).find(message => message.method === 'stop');
  child.stdout.write(JSON.stringify({ id: stopRequest.id, result: { confirmationComplete: true } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.deepEqual(await exiting, { exited: true });
  await assert.rejects(worker.request('models'), error => error.code === 'PI_RUNTIME_UNAVAILABLE');
});

const runtimeStub = { command: '/fake/node', args: ['/fake/owner.mjs'], env: {} };
const sourceStub = { root: '/nozeli', agentDir: '/nozeli/pi' };

function settingsWorkerForIdle(idleMs) {
  const spawns = [];
  const worker = new PiSettingsWorker({ runtime: runtimeStub, source: sourceStub, idleMs, spawnFn: () => { const child = fakeChild(); spawns.push(child); return child; } });
  return { worker, spawns };
}
const requestsOf = (child, method) => child.written.map(line => JSON.parse(line)).filter(message => message.method === method);
const answer = (child, request, result) => child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
const exitChild = child => { if (child.exitCode == null && child.signalCode == null) { child.exitCode = 0; child.emit('exit', 0, null); } };
const soon = (predicate, label, timeoutMs = 3000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + timeoutMs;
  const check = () => {
    let ready = false;
    try { ready = predicate(); } catch (error) { reject(error); return; }
    if (ready) { resolve(); return; }
    if (Date.now() > deadline) { reject(new Error('timed out waiting for ' + label)); return; }
    setTimeout(check, 5);
  };
  check();
});
// Delivery-based wait: request() may spawn the child synchronously, but the
// JSONL line is only written after the acquire/start microtask chain settles —
// never assume a fixed setImmediate tick covers it.
const awaitRequest = async (child, method, timeoutMs = 3000) => {
  await soon(() => requestsOf(child, method).length > 0, method + ' request delivered', timeoutMs);
  return requestsOf(child, method)[0];
};
async function cleanStop(worker, spawns) {
  if (worker.stopped) return;
  const exiting = worker.stop();
  const live = spawns[spawns.length - 1];
  if (live) {
    for (const request of requestsOf(live, 'stop')) live.stdout.write(JSON.stringify({ id: request.id, result: { confirmationComplete: true } }) + '\n');
    await flush();
    exitChild(live);
  }
  await exiting;
}

test('idle retire delay defaults to 30s and rejects invalid configuration', () => {
  const worker = new PiSettingsWorker({ runtime: runtimeStub, source: sourceStub, spawnFn: () => fakeChild() });
  assert.equal(worker.idleMs, 30000);
  const immediate = new PiSettingsWorker({ runtime: runtimeStub, source: sourceStub, idleMs: 0, spawnFn: () => fakeChild() });
  assert.equal(immediate.idleMs, 0);
  assert.throws(() => new PiSettingsWorker({ runtime: runtimeStub, source: sourceStub, idleMs: -1, spawnFn: () => fakeChild() }), TypeError);
  assert.throws(() => new PiSettingsWorker({ runtime: runtimeStub, source: sourceStub, idleMs: Number.NaN, spawnFn: () => fakeChild() }), TypeError);
});

test('idle settings worker retires via the stop protocol and respawns on demand', async t => {
  const { worker, spawns } = settingsWorkerForIdle(15);
  t.after(async () => cleanStop(worker, spawns));

  const first = worker.request('authList');
  assert.equal(spawns.length, 1);
  answer(spawns[0], await awaitRequest(spawns[0], 'authList'), { credentials: [] });
  assert.deepEqual(await first, { credentials: [] });

  // Back-to-back requests reuse the live child; the idle clock never preempts them.
  const second = worker.request('models');
  assert.equal(spawns.length, 1);
  answer(spawns[0], await awaitRequest(spawns[0], 'models'), { models: [{ provider: 'official', modelId: 'm1' }] });
  assert.deepEqual(await second, { models: [{ provider: 'official', modelId: 'm1' }] });

  // Quiescent for the idle delay: retired through the protocol, no respawn yet.
  await soon(() => requestsOf(spawns[0], 'stop').length === 1, 'idle stop request');
  answer(spawns[0], requestsOf(spawns[0], 'stop')[0], { confirmationComplete: true });
  await soon(() => worker.child === null && !worker.running, 'idle retire');
  assert.equal(spawns.length, 1);

  // Idle retire is not a permanent stop: the next request respawns.
  const third = worker.request('authList');
  assert.equal(spawns.length, 2);
  answer(spawns[1], await awaitRequest(spawns[1], 'authList'), { credentials: [{ provider: 'official' }] });
  assert.deepEqual(await third, { credentials: [{ provider: 'official' }] });
});

test('long in-flight auth requests postpone idle reclaim until they settle', async t => {
  const { worker, spawns } = settingsWorkerForIdle(15);
  t.after(async () => cleanStop(worker, spawns));

  const login = worker.request('authLogin', { provider: 'official' }, { timeoutMs: 5000 });
  const seeded = await awaitRequest(spawns[0], 'authLogin');

  // Well past the idle delay: the pending auth request keeps the child alive.
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(spawns.length, 1);
  assert.ok(worker.running);
  assert.equal(requestsOf(spawns[0], 'stop').length, 0);

  // Once it settles, the idle clock reclaims the child through the protocol.
  answer(spawns[0], seeded, { done: true });
  assert.deepEqual(await login, { done: true });
  await soon(() => requestsOf(spawns[0], 'stop').length === 1, 'post-login stop request');
  answer(spawns[0], requestsOf(spawns[0], 'stop')[0], { confirmationComplete: true });
  await soon(() => worker.child === null, 'retire after auth settles');
});

test('requests racing an idle retire wait for the handoff and respawn once', async t => {
  const { worker, spawns } = settingsWorkerForIdle(15);
  t.after(async () => cleanStop(worker, spawns));

  const first = worker.request('authList');
  answer(spawns[0], await awaitRequest(spawns[0], 'authList'), { credentials: [] });
  await first;
  await soon(() => requestsOf(spawns[0], 'stop').length === 1, 'idle stop request');

  // Two concurrent requests land while the retire handshake is still open.
  const racingA = worker.request('models');
  const racingB = worker.request('providerList');
  await new Promise(resolve => setTimeout(resolve, 40));
  // They were never sent to the dying child and nothing respawned yet.
  assert.equal(requestsOf(spawns[0], 'models').length, 0);
  assert.equal(requestsOf(spawns[0], 'providerList').length, 0);
  assert.equal(spawns.length, 1);

  // Complete the retire: both waiting requests share a single respawn.
  answer(spawns[0], requestsOf(spawns[0], 'stop')[0], { confirmationComplete: true });
  await soon(() => spawns.length === 2, 'single replacement child');
  const listA = await awaitRequest(spawns[1], 'models');
  const listB = await awaitRequest(spawns[1], 'providerList');
  assert.equal(spawns.length, 2); // both racing requests shared a single respawn
  assert.equal(requestsOf(spawns[1], 'models').length, 1); // delivered exactly once, never replayed
  assert.equal(requestsOf(spawns[1], 'providerList').length, 1);
  answer(spawns[1], listA, { models: [] });
  answer(spawns[1], listB, { providers: [] });
  assert.deepEqual(await racingA, { models: [] });
  assert.deepEqual(await racingB, { providers: [] });
});

test('a child crashing mid retire-handshake never blocks the next request', async t => {
  const { worker, spawns } = settingsWorkerForIdle(15);
  t.after(async () => cleanStop(worker, spawns));

  const first = worker.request('authList');
  answer(spawns[0], await awaitRequest(spawns[0], 'authList'), { credentials: [] });
  await first;
  await soon(() => requestsOf(spawns[0], 'stop').length === 1, 'idle stop request');

  // The child dies before answering the retire's stop request.
  spawns[0].exitCode = 1;
  spawns[0].emit('exit', 1, null);
  await soon(() => worker.child === null && worker.retiring === null, 'retire settled after crash');

  const second = worker.request('authList');
  assert.equal(spawns.length, 2);
  answer(spawns[1], await awaitRequest(spawns[1], 'authList'), { credentials: [] });
  assert.deepEqual(await second, { credentials: [] });
});

test('stale output from a retired child is ignored by its replacement', async t => {
  const { worker, spawns } = settingsWorkerForIdle(15);
  t.after(async () => cleanStop(worker, spawns));
  const interactions = [];
  worker.events.on('interaction', interaction => interactions.push(interaction));

  const first = worker.request('authList');
  answer(spawns[0], await awaitRequest(spawns[0], 'authList'), { credentials: [] });
  await first;
  await soon(() => requestsOf(spawns[0], 'stop').length === 1, 'idle stop request');
  const retireStop = requestsOf(spawns[0], 'stop')[0];
  answer(spawns[0], retireStop, { confirmationComplete: true });
  await soon(() => worker.child === null, 'idle retire');

  const second = worker.request('authList');
  assert.equal(spawns.length, 2);
  const delivered = await awaitRequest(spawns[1], 'authList');

  // Belated lines from the retired child: a duplicate stop ack and an interaction.
  spawns[0].stdout.write(JSON.stringify({ id: retireStop.id, result: {} }) + '\n');
  spawns[0].stdout.write(JSON.stringify({ event: 'interaction', interaction: { id: 'w-stale', kind: 'text' } }) + '\n');
  await flush();
  assert.equal(interactions.length, 0); // stale events never surface
  assert.ok(worker.running); // replacement unaffected

  answer(spawns[1], delivered, { credentials: [{ provider: 'official' }] });
  assert.deepEqual(await second, { credentials: [{ provider: 'official' }] });
});

test('stop after an idle retire rejects further requests without hanging', async () => {
  const { worker, spawns } = settingsWorkerForIdle(15);
  const first = worker.request('authList');
  answer(spawns[0], await awaitRequest(spawns[0], 'authList'), { credentials: [] });
  await first;
  await soon(() => requestsOf(spawns[0], 'stop').length === 1, 'idle stop request');
  answer(spawns[0], requestsOf(spawns[0], 'stop')[0], { confirmationComplete: true });
  await soon(() => worker.child === null, 'idle retire');
  assert.deepEqual(await worker.stop(), { exited: true });
  assert.equal(spawns.length, 1); // stop never respawns
  await assert.rejects(worker.request('models'), error => error.code === 'PI_RUNTIME_UNAVAILABLE');
});

test('cancel terminates the child immediately and the next request respawns', async t => {
  const { worker, spawns } = settingsWorkerForIdle(15);
  t.after(async () => cleanStop(worker, spawns));

  const login = worker.request('authLogin', { provider: 'official' }, { timeoutMs: 5000 });
  await flush();
  assert.deepEqual(await worker.request('cancel', {}), { stopped: true });
  await assert.rejects(login, error => error.code === 'PI_AUTH_CANCELLED');
  assert.equal(worker.child, null);
  assert.ok(!worker.running);

  // No idle-path resurrection while quiet.
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(spawns.length, 1);
  assert.equal(worker.child, null);

  const next = worker.request('authList');
  assert.equal(spawns.length, 2);
  answer(spawns[1], await awaitRequest(spawns[1], 'authList'), { credentials: [] });
  assert.deepEqual(await next, { credentials: [] });
});

test('a timed-out call blocks idle reclaim until its late answer lands', async t => {
  const { worker, spawns } = settingsWorkerForIdle(15);
  t.after(async () => cleanStop(worker, spawns));

  const slow = worker.request('providerDiscover', { provider: 'official' }, { timeoutMs: 20 });
  const seeded = await awaitRequest(spawns[0], 'providerDiscover');
  await assert.rejects(slow, error => error.code === 'PI_TIMEOUT');
  // The unknown-effect operation may still be executing: no reclaim even past the idle delay.
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(worker.running);
  assert.equal(requestsOf(spawns[0], 'stop').length, 0);

  // The late answer only clears the unconfirmed marker: nothing settles twice, nothing is replayed.
  spawns[0].stdout.write(JSON.stringify({ id: seeded.id, error: { code: 'late', message: 'late failure' } }) + '\n');
  await flush();
  assert.equal(requestsOf(spawns[0], 'providerDiscover').length, 1); // never resent
  await soon(() => requestsOf(spawns[0], 'stop').length === 1, 'stop after late answer');
  answer(spawns[0], requestsOf(spawns[0], 'stop')[0], { confirmationComplete: true });
  await soon(() => worker.child === null, 'retire after late answer');
});

test('a child exit clears unconfirmed timed-out markers without settling twice', async t => {
  const { worker, spawns } = settingsWorkerForIdle(15);
  t.after(async () => cleanStop(worker, spawns));

  const slow = worker.request('authSetKey', { provider: 'official', apiKey: 'k' }, { timeoutMs: 20 });
  await awaitRequest(spawns[0], 'authSetKey');
  await assert.rejects(slow, error => error.code === 'PI_TIMEOUT');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(worker.running); // the unconfirmed marker held the idle clock off

  spawns[0].exitCode = 1;
  spawns[0].emit('exit', 1, null);
  await soon(() => worker.child === null, 'child removed');
  const next = worker.request('authList');
  assert.equal(spawns.length, 2);
  answer(spawns[1], await awaitRequest(spawns[1], 'authList'), { credentials: [] });
  assert.deepEqual(await next, { credentials: [] });
});

test('late error and exit signals from a retired child spare the replacement', async t => {
  const { worker, spawns } = settingsWorkerForIdle(15);
  t.after(async () => cleanStop(worker, spawns));

  const first = worker.request('authList');
  answer(spawns[0], await awaitRequest(spawns[0], 'authList'), { credentials: [] });
  await first;
  await soon(() => requestsOf(spawns[0], 'stop').length === 1, 'idle stop request');
  answer(spawns[0], requestsOf(spawns[0], 'stop')[0], { confirmationComplete: true });
  await soon(() => worker.child === null, 'idle retire');

  const second = worker.request('authList');
  assert.equal(spawns.length, 2);
  const delivered = await awaitRequest(spawns[1], 'authList');
  // Belated failure/exit reports from the retired child arrive while the
  // replacement has a live request: neither may reject it or clear identity.
  spawns[0].emit('error', Object.assign(new Error('late stdio failure'), { code: 'EPIPE' }));
  spawns[0].emit('exit', 1, null);
  await flush();
  assert.ok(worker.running);
  assert.equal(worker.child, spawns[1]);
  answer(spawns[1], delivered, { credentials: [{ provider: 'official' }] });
  assert.deepEqual(await second, { credentials: [{ provider: 'official' }] });
});

test('stop during an idle retire awaits the handoff instead of sending a second stop', async () => {
  const { worker, spawns } = settingsWorkerForIdle(15);

  const first = worker.request('authList');
  answer(spawns[0], await awaitRequest(spawns[0], 'authList'), { credentials: [] });
  await first;
  await soon(() => requestsOf(spawns[0], 'stop').length === 1, 'retire stop request');

  // stop() lands mid-handshake: it must ride the retire's own stop/terminate.
  const exiting = worker.stop();
  answer(spawns[0], requestsOf(spawns[0], 'stop')[0], { confirmationComplete: true });
  await soon(() => worker.stopped && worker.child === null, 'stop settled with the retire');
  assert.deepEqual(await exiting, { exited: true });
  assert.equal(requestsOf(spawns[0], 'stop').length, 1); // exactly one stop ever written
  assert.equal(spawns.length, 1);
});
