import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { syncOmpSelectedProvider } from '../src/agents/managed/omp-provider-home.mjs';
import { OmpTuiSession } from '../src/agents/managed/omp-tui-session.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'defaults-behavior-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'role'), agentDir = path.join(root, 'source');
  await fs.mkdir(home); await fs.mkdir(agentDir);
  return { root, home, source: { private: true, root, agentDir } };
}

test('selected provider refresh preserves unrelated native providers and configuration', async t => {
  const { home, source } = await fixture(t);
  await fs.writeFile(path.join(source.agentDir, 'models.yml'), stringify({ providers: { selected: { api: 'openai-completions', baseUrl: 'http://127.0.0.1', auth: 'none', models: [{ id: 'added' }] }, other: { marker: 'global' } } }));
  await fs.writeFile(path.join(home, 'models.yaml'), stringify({ providers: { native: { marker: 'local' }, other: { marker: 'edited locally' } }, localOption: true }));
  await fs.writeFile(path.join(home, 'config.yml'), 'native: unchanged\n');
  await syncOmpSelectedProvider(home, source, 'selected/added');
  const value = parse(await fs.readFile(path.join(home, 'models.yaml'), 'utf8'));
  assert.equal(value.providers.selected.models[0].id, 'added');
  assert.equal(value.providers.other.marker, 'edited locally');
  assert.equal(value.providers.native.marker, 'local');
  assert.equal(value.localOption, true);
  assert.equal(await fs.readFile(path.join(home, 'config.yml'), 'utf8'), 'native: unchanged\n');
});

test('starting session stores latest target without spawn; idle result uses verified native state; errors stay observable', async t => {
  const { home } = await fixture(t);
  const session = new OmpTuiSession({ home, role: 'worker' });
  assert.deepEqual(await session.applyDefaultModel('local/b'), { pending: true, model: null });
  assert.equal(session.desiredModel, 'local/b');
  assert.equal(session.pty, undefined);
  await session.applyDefaultModel('');
  assert.equal(session.pendingModel, null);
  session.phase = 'idle'; session.model = 'local/a';
  let calls = 0;
  session.bridge = { applyDefaultModel: async selector => { calls++; return { model: selector || 'local/a', pending: false, pendingModel: null, modelError: null }; } };
  assert.deepEqual(await session.applyDefaultModel('local/b'), { pending: false, model: 'local/b' });
  assert.equal(session.snapshot().model, 'local/b');
  assert.equal(session.snapshot().desiredModel, 'local/b');
  assert.equal(calls, 1);
  session.bridge.applyDefaultModel = async () => { throw Object.assign(Error('native failed'), { code: 'NATIVE_FAILURE' }); };
  await assert.rejects(session.applyDefaultModel('local/missing'), /native failed/);
  assert.equal(session.model, 'local/b');
  assert.equal(session.pendingModel, 'local/missing');
  assert.equal(session.snapshot().modelError.code, 'NATIVE_FAILURE');
});
