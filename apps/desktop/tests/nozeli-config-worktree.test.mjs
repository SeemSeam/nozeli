import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveNozeliPaths, initializeNozeliConfiguration, completeNozeliConfiguration } from '../src/agents/managed/nozeli-config.mjs';

test('interrupted import completes only its staged snapshot and preserves conflicting private edits', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-import-crash-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const paths = resolveNozeliPaths({ home: base, env: {} }); await initializeNozeliConfiguration(paths);
  const stage = path.join(paths.migrations, 'import-interrupted'); await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, 'config.yml'), 'theme: imported\n');
  await fs.writeFile(path.join(paths.migrations, 'setup-v1.json'), JSON.stringify({ version: 1, phase: 'staged', choice: 'import', stage }));
  await fs.writeFile(path.join(paths.omp, 'config.yml'), 'theme: native-concurrent-edit\n');
  await assert.rejects(completeNozeliConfiguration(paths, { choice: 'import', source: { get agentDir() { throw Error('must not reread official'); } } }), { code: 'CONFIG_IMPORT_CONFLICT' });
  assert.equal(await fs.readFile(path.join(paths.omp, 'config.yml'), 'utf8'), 'theme: native-concurrent-edit\n');
  // Deliberate recovery restores the staged bytes; retry never rereads the source.
  await fs.writeFile(path.join(paths.omp, 'config.yml'), 'theme: imported\n');
  const status = await completeNozeliConfiguration(paths, { choice: 'import', source: { get agentDir() { throw Error('must not reread official'); } } });
  assert.equal(status.initialized, true); assert.equal(status.choice, 'import');
});
