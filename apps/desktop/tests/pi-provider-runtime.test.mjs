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
