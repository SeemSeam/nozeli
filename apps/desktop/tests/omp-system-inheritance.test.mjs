import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { resolveNozeliPaths, initializeNozeliConfiguration, readNozeliConfiguration, completeNozeliConfiguration } from '../src/agents/managed/nozeli-config.mjs';
import { createNozeliOmpSource, sanitizeOmpConfig } from '../src/agents/managed/omp-system-source.mjs';
import { prepareOmpPrivateHome } from '../src/agents/managed/omp-provider-home.mjs';
import { scrubProviderEnv } from '../src/agents/managed/omp-credentials.mjs';
import { processStamp } from '../src/agents/managed/process-ownership.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-independent-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const paths = resolveNozeliPaths({ home: base, env: {} });
  const legacyDesktop = path.join(base, 'legacy');
  return { base, paths, legacyDesktop };
}
async function put(file, bytes) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
const read = file => fs.readFile(file, 'utf8');

test('production roots ignore inherited HOME/provider/profile overrides, tests retain explicit desktop', () => {
  const paths = resolveNozeliPaths({ home: '/actual-home', env: { HOME: '/sandbox', NOZELI_CONFIG_ROOT: '/bad', NOZELI_USER_DATA: '/bad/desktop', PI_CONFIG_DIR: '/bad', OMP_PROFILE: 'bad' } });
  assert.deepEqual(paths, { root: '/actual-home/.Nozeli', desktop: '/actual-home/.Nozeli/desktop', omp: '/actual-home/.Nozeli/omp', migrations: '/actual-home/.Nozeli/migrations' });
  assert.equal(resolveNozeliPaths({ env: { NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: '/test/root', NOZELI_USER_DATA: '/test/root/profile' } }).desktop, '/test/root/profile');
  assert.throws(() => resolveNozeliPaths({ env: { NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: '/test/root', NOZELI_USER_DATA: '/outside' } }), { code: 'CONFIG_ROOT_INVALID' });
});

test('migration retains IDs, byte-identical drafts and accepted jobs while relocating host references once', async t => {
  const { paths, legacyDesktop } = await fixture(t);
  const rel = 'nozeli/managed-v1/stable-id/runtime/state.json';
  const state = { workspaceId: 'same', works: [{ id: 'work', threadId: 'thread', execution: { directory: path.join(legacyDesktop, 'execution/work') } }], receipts: [{ id: 'report', snapshot: { artifactDirectory: path.join(legacyDesktop, 'artifacts') } }], jobs: [{ id: 'accepted', status: 'running', text: legacyDesktop }], drafts: { frontdesk: legacyDesktop } };
  await put(path.join(legacyDesktop, rel), JSON.stringify(state));
  await put(path.join(legacyDesktop, 'nozeli/v1/registry.json'), '{"projects":[{"id":"stable"}]}');
  await put(path.join(legacyDesktop, 'nozeli/v1/projects/stable/drafts/dirty.json'), '{"text":"unsent","baseDigest":"original","status":"conflict"}');
  await put(path.join(legacyDesktop, 'nozeli/managed-v1/stable-id/runtime/agents/worker/sessions/native.jsonl'), '{"type":"draft","text":"never replay"}\n');
  assert.equal((await initializeNozeliConfiguration(paths, { legacyDesktop })).choiceRequired, true);
  const migrated = JSON.parse(await read(path.join(paths.desktop, rel)));
  assert.equal(migrated.workspaceId, 'same'); assert.equal(migrated.works[0].threadId, 'thread');
  assert.equal(migrated.works[0].execution.directory, path.join(paths.desktop, 'execution/work'));
  assert.equal(migrated.receipts[0].snapshot.artifactDirectory, path.join(paths.desktop, 'artifacts'));
  assert.deepEqual(migrated.jobs, state.jobs); assert.deepEqual(migrated.drafts, state.drafts);
  assert.equal(await read(path.join(paths.desktop, 'nozeli/v1/projects/stable/drafts/dirty.json')), '{"text":"unsent","baseDigest":"original","status":"conflict"}');
  assert.equal(await read(path.join(paths.desktop, 'nozeli/managed-v1/stable-id/runtime/agents/worker/sessions/native.jsonl')), '{"type":"draft","text":"never replay"}\n');
  await assert.rejects(fs.lstat(legacyDesktop), { code: 'ENOENT' });
  await initializeNozeliConfiguration(paths, { legacyDesktop });
  assert.deepEqual(JSON.parse(await read(path.join(paths.desktop, rel))), migrated);
});

test('conflicting desktops preserve both draft versions without merging', async t => {
  const { paths, legacyDesktop } = await fixture(t);
  await put(path.join(legacyDesktop, 'draft'), 'legacy unsent'); await put(path.join(paths.desktop, 'draft'), 'new unsent');
  await assert.rejects(initializeNozeliConfiguration(paths, { legacyDesktop }), { code: 'MIGRATION_TARGET_CONFLICT' });
  assert.equal(await read(path.join(legacyDesktop, 'draft')), 'legacy unsent'); assert.equal(await read(path.join(paths.desktop, 'draft')), 'new unsent');
});

test('migration refuses symlink source data and live source owners without changing originals', async t => {
  const { paths, legacyDesktop, base } = await fixture(t);
  await put(path.join(base, 'outside'), 'untouched'); await fs.mkdir(legacyDesktop);
  await fs.symlink(path.join(base, 'outside'), path.join(legacyDesktop, 'linked'));
  await assert.rejects(initializeNozeliConfiguration(paths, { legacyDesktop }), { code: 'MIGRATION_UNSAFE' });
  await fs.unlink(path.join(legacyDesktop, 'linked'));
  await put(path.join(legacyDesktop, 'runtime/host.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(initializeNozeliConfiguration(paths, { legacyDesktop }), { code: 'MIGRATION_SOURCE_LIVE' });
  assert.equal(await read(path.join(base, 'outside')), 'untouched');
});

test('interrupted rename journal resumes metadata relocation, refuses concurrent changed metadata', async t => {
  const { paths, legacyDesktop } = await fixture(t);
  await fs.mkdir(paths.migrations, { recursive: true }); await fs.mkdir(paths.desktop);
  const journal = { version: 1, phase: 'prepared', source: legacyDesktop, target: paths.desktop, edits: [], worktrees: [], automaticReplay: false };
  await put(path.join(paths.migrations, 'desktop-v1.json'), JSON.stringify(journal));
  await initializeNozeliConfiguration(paths, { legacyDesktop });
  assert.equal(JSON.parse(await read(path.join(paths.migrations, 'desktop-v1.json'))).phase, 'complete');
  journal.phase = 'moved'; journal.edits = [{ rel: 'state.json', before: 'original', after: 'relocated', digest: 'wrong' }];
  await put(path.join(paths.migrations, 'desktop-v1.json'), JSON.stringify(journal)); await put(path.join(paths.desktop, 'state.json'), 'concurrent draft');
  await assert.rejects(initializeNozeliConfiguration(paths), { code: 'MIGRATION_METADATA_CONFLICT' });
  assert.equal(await read(path.join(paths.desktop, 'state.json')), 'concurrent draft');
});

test('independent choice never opens official source and can be made only once', async t => {
  const { paths } = await fixture(t);
  await initializeNozeliConfiguration(paths);
  assert.equal((await readNozeliConfiguration(paths)).initialized, false);
  const source = { get agentDir() { throw Error('official source read'); } };
  await completeNozeliConfiguration(paths, { choice: 'independent', source });
  assert.equal((await readNozeliConfiguration(paths)).choice, 'independent');
  await assert.rejects(completeNozeliConfiguration(paths, { choice: 'import', source }), { code: 'CONFIG_ALREADY_INITIALIZED' });
});

test('explicit import strips execution/trust and OAuth, stays independent from subsequent official mutations', async t => {
  const { paths, base } = await fixture(t); await initializeNozeliConfiguration(paths);
  const agentDir = path.join(base, 'official');
  await put(path.join(agentDir, 'config.yml'), stringify({ modelRoles: { default: 'provider/model' }, extensions: ['evil.js'], hooks: { start: 'exec' }, trustedPaths: ['/'], 'auth.broker.url': 'remote', shell: 'bad', theme: 'dark' }));
  await put(path.join(agentDir, 'models.yml'), stringify({ providers: { p: { baseUrl: 'https://example.invalid', apiKey: 'synthetic-key', headers: { Authorization: 'synthetic-token' }, models: [{ id: 'model' }] } } }));
  await put(path.join(agentDir, 'auth.json'), 'oauth must not be copied');
  await completeNozeliConfiguration(paths, { choice: 'import', source: { agentDir } });
  const doc = parse(await read(path.join(paths.omp, 'config.yml')));
  assert.deepEqual(doc, { modelRoles: { default: 'provider/model' }, theme: 'dark' });
  const models = parse(await read(path.join(paths.omp, 'models.yml'))); assert.equal(models.providers.p.apiKey, undefined); assert.equal(models.providers.p.headers, undefined);
  await assert.rejects(fs.access(path.join(paths.omp, 'auth.json')));
  const ownBytes = await read(path.join(paths.omp, 'config.yml'));
  await put(path.join(agentDir, 'config.yml'), 'theme: official-mutated\n');
  const source = createNozeliOmpSource(paths); assert.equal((await source.describe()).agentDir, paths.omp);
  assert.equal(await read(path.join(source.agentDir, 'config.yml')), ownBytes);
  await put(path.join(source.agentDir, 'config.yml'), 'theme: private-mutated\n');
  assert.equal(await read(path.join(agentDir, 'config.yml')), 'theme: official-mutated\n');
});

test('API-key consent copies static keys only, never command credentials or OAuth', async t => {
  const { paths, base } = await fixture(t); await initializeNozeliConfiguration(paths);
  const agentDir = path.join(base, 'official');
  await put(path.join(agentDir, 'models.yml'), stringify({ providers: { static: { apiKey: 'synthetic-key' }, command: { apiKey: '!do-not-execute' } } }));
  await completeNozeliConfiguration(paths, { choice: 'import', includeApiKeys: true, source: { agentDir } });
  const models = parse(await read(path.join(paths.omp, 'models.yml')));
  assert.equal(models.providers.static.apiKey, 'synthetic-key'); assert.equal(models.providers.command.apiKey, undefined);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(paths.omp, 'models.yml'))).mode & 0o777, 0o600);
});

test('provider identifiers and role names are data, not executable or credential fields', () => {
  const input = {
    providers: {
      command: { baseUrl: 'https://command.invalid', apiKey: '!never-execute', command: 'forbidden' },
      token: { baseUrl: 'https://token.invalid', apiKey: 'synthetic-key', hooks: ['forbidden'] },
      'custom.auth': { baseUrl: 'https://custom.invalid', apiKey: 'synthetic-key' },
      headers: { baseUrl: 'https://headers.invalid', apiKey: 'synthetic-key', description: 'ordinary field' },
    },
    modelRoles: { command: 'command/model', token: 'token/model' },
  };
  const result = sanitizeOmpConfig(input);
  assert.deepEqual(result.providers, {
    command: { baseUrl: 'https://command.invalid' },
    token: { baseUrl: 'https://token.invalid' },
    'custom.auth': { baseUrl: 'https://custom.invalid' },
    headers: { baseUrl: 'https://headers.invalid', description: 'ordinary field' },
  });
  assert.deepEqual(result.modelRoles, input.modelRoles);
  assert.equal(sanitizeOmpConfig(input, { includeApiKeys: true }).providers.token.apiKey, 'synthetic-key');
  assert.equal(sanitizeOmpConfig(input, { includeApiKeys: true }).providers.command.apiKey, undefined);
});

test('role seed persists all config/models edits and deletions, not only model role choices', async t => {
  const { paths } = await fixture(t); await initializeNozeliConfiguration(paths);
  await put(path.join(paths.omp, 'config.yml'), 'theme: original\nmodelRoles:\n  default: p/model\n');
  await put(path.join(paths.omp, 'models.yml'), 'providers: {}\n');
  const home = path.join(paths.desktop, 'nozeli/managed-v1/id/runtime/agents/resident');
  const source = createNozeliOmpSource(paths);
  await prepareOmpPrivateHome(home, { system: source });
  await put(path.join(home, 'config.yml'), 'theme: native\ncustomSetting:\n  nested: retained\n');
  await put(path.join(home, 'models.yml'), 'providers:\n  private:\n    baseUrl: https://private.invalid\n');
  await put(path.join(paths.omp, 'config.yml'), 'theme: later-default\n');
  await prepareOmpPrivateHome(home, { system: source, legacyNativeSeed: { model: 'must-not-overwrite' } });
  assert.deepEqual(parse(await read(path.join(home, 'config.yml'))), { theme: 'native', customSetting: { nested: 'retained' } });
  assert.equal(parse(await read(path.join(home, 'models.yml'))).providers.private.baseUrl, 'https://private.invalid');
  await fs.unlink(path.join(home, 'models.yml'));
  await prepareOmpPrivateHome(home, { system: source });
  await assert.rejects(fs.access(path.join(home, 'models.yml')));
  await assert.rejects(prepareOmpPrivateHome(home, { system: { agentDir: '/official' } }), /Nozeli-owned/);
});

test('ambient root/runtime selectors and credential values are scrubbed without changing HOME', () => {
  const result = scrubProviderEnv({ HOME: '/real-home', NOZELI_CONFIG_ROOT: '/ambient', NOZELI_AGENT_DIR: '/ambient', PI_CODING_AGENT_DIR: '/official', OPENAI_API_KEY: 'synthetic', OMP_AUTH_BROKER_TOKEN: 'synthetic', NODE_OPTIONS: '--require=bad', PATH: '/bin' });
  assert.deepEqual(result.env, { HOME: '/real-home', PATH: '/bin' });
});

test('confirmed dead local Electron singleton artifacts migrate without manual removal', async t => {
  if (process.platform === 'win32') return t.skip('Electron POSIX singleton symlinks');
  const { paths, legacyDesktop } = await fixture(t);
  await fs.mkdir(legacyDesktop);
  await fs.symlink(os.hostname() + '-2147483647', path.join(legacyDesktop, 'SingletonLock'));
  await fs.symlink('/nonexistent/nozeli-old-socket', path.join(legacyDesktop, 'SingletonSocket'));
  await fs.symlink('old-cookie', path.join(legacyDesktop, 'SingletonCookie'));
  await put(path.join(legacyDesktop, 'draft'), 'unsent');
  await initializeNozeliConfiguration(paths, { legacyDesktop });
  assert.equal(await read(path.join(paths.desktop, 'draft')), 'unsent');
  await assert.rejects(fs.lstat(path.join(paths.desktop, 'SingletonLock')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(paths.desktop, 'SingletonSocket')), { code: 'ENOENT' });
});

test('invalid imported and private YAML errors never expose source snippets or credentials', async t => {
  const { paths, base } = await fixture(t); await initializeNozeliConfiguration(paths);
  const agentDir = path.join(base, 'official');
  const invalid = 'providers: { p: { apiKey: synthetic-secret-never-in-errors, broken: [ }';
  await put(path.join(agentDir, 'models.yml'), invalid);
  const safeError = code => error => {
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message + error.stack, /synthetic-secret-never-in-errors|broken:|apiKey/);
    assert.equal(error.cause, undefined);
    return true;
  };
  await assert.rejects(completeNozeliConfiguration(paths, { choice: 'import', includeApiKeys: true, source: { agentDir } }), safeError('CONFIG_IMPORT_INVALID'));
  assert.equal(await read(path.join(agentDir, 'models.yml')), invalid);
  const home = path.join(paths.desktop, 'nozeli/managed-v1/id/runtime/agents/resident');
  await put(path.join(home, 'config.yml'), invalid);
  await assert.rejects(prepareOmpPrivateHome(home, { system: createNozeliOmpSource(paths) }), safeError('CONFIG_INVALID'));
  assert.equal(await read(path.join(home, 'config.yml')), invalid);
});

for (const consented of [false, true]) test(`old projected credentials ${consented ? 'rebind only from consented private base' : 'are removed with explicit login requirement'}`, async t => {
  const { paths } = await fixture(t); await initializeNozeliConfiguration(paths);
  const home = path.join(paths.desktop, 'nozeli/managed-v1/id/runtime/agents/old-role');
  const opaque = 'NOZELI_OMP_CONFIG_' + 'A'.repeat(64);
  const originalModels = stringify({ providers: { custom: { apiKey: opaque, headers: { Authorization: opaque, 'X-Explicit': 'native-choice' }, baseUrl: 'https://native-choice.invalid', models: [{ id: 'native-model' }] } } });
  const originalConfig = 'theme: native-choice\nmodelRoles:\n  default: custom/native-model\n';
  await put(path.join(home, 'models.yml'), originalModels);
  await put(path.join(home, 'config.yml'), originalConfig);
  await put(path.join(home, '.nozeli-omp-projection.json'), '{"files":{"models.yml":{"digest":"old"}}}');
  if (consented) await put(path.join(paths.omp, 'models.yml'), stringify({ providers: { custom: { apiKey: 'synthetic-private-key', headers: { Authorization: 'synthetic-private-header' }, baseUrl: 'https://must-not-overwrite.invalid' } } }));
  const result = await prepareOmpPrivateHome(home, { system: createNozeliOmpSource(paths) });
  const settings = parse(await read(path.join(home, 'models.yml'))).providers.custom;
  assert.equal(settings.apiKey, consented ? 'synthetic-private-key' : undefined);
  assert.equal(settings.headers.Authorization, consented ? 'synthetic-private-header' : undefined);
  assert.equal(settings.headers['X-Explicit'], 'native-choice');
  assert.equal(settings.baseUrl, 'https://native-choice.invalid');
  assert.deepEqual(settings.models, [{ id: 'native-model' }]);
  assert.equal(result.loginRequired, !consented);
  assert.deepEqual(result.unresolvedProviders, consented ? [] : ['custom']);
  assert.doesNotMatch(await read(path.join(home, 'models.yml')), /NOZELI_OMP_CONFIG_/);
  assert.equal(await read(path.join(home, 'config.yml')), originalConfig);
  assert.equal(await read(path.join(home, '.nozeli-omp-credential-migration/models.yml.original')), originalModels);
  const repeated = await prepareOmpPrivateHome(home, { system: createNozeliOmpSource(paths) });
  assert.equal(repeated.loginRequired, !consented);
});

test('legacy projection strips official executable capabilities once, preserves bridge and native choices', async t => {
  const { paths, base } = await fixture(t); await initializeNozeliConfiguration(paths);
  const home = path.join(paths.desktop, 'nozeli/managed-v1/id/runtime/agents/old-role');
  const bridge = path.join(home, 'nozeli-terminal-bridge.mjs');
  const official = path.join(base, '.omp/agent/sentinel-extension.mjs');
  const original = stringify({
    extensions: [official, bridge], hooks: { start: 'sentinel' }, commands: ['sentinel'], mcpServers: { old: { command: 'sentinel' } },
    trustedPaths: [base], 'auth.broker.url': 'https://old.invalid', schemaPath: path.join(base, '.omp/agent/schema.json'),
    theme: 'native-theme', modelRoles: { default: 'custom/native-model' },
  });
  await put(official, 'throw new Error("must not be loaded");');
  await put(path.join(home, 'config.yml'), original);
  await put(path.join(home, '.nozeli-omp-projection.json'), '{"files":{"config.yml":{"digest":"old"}}}');
  await prepareOmpPrivateHome(home, { system: createNozeliOmpSource(paths) });
  const cleaned = parse(await read(path.join(home, 'config.yml')));
  assert.deepEqual(cleaned, { extensions: [bridge], theme: 'native-theme', modelRoles: { default: 'custom/native-model' } });
  assert.equal(await read(path.join(home, '.nozeli-omp-capability-migration/config.yml.original')), original);
  assert.equal(await read(official), 'throw new Error("must not be loaded");');
  cleaned.hooks = { start: 'later-deliberate-private-choice' };
  await put(path.join(home, 'config.yml'), stringify(cleaned));
  await prepareOmpPrivateHome(home, { system: createNozeliOmpSource(paths) });
  assert.deepEqual(parse(await read(path.join(home, 'config.yml'))).hooks, cleaned.hooks);
});

for (const identity of ['matching', 'unknown', 'reused']) test(`legacy provider ${identity} live PID fences migration without signaling or moving data`, async t => {
  const { paths, legacyDesktop } = await fixture(t);
  const runtime = path.join(legacyDesktop, 'nozeli/managed-v1/stable/runtime');
  const stamp = identity === 'matching' ? await processStamp(process.pid) : identity === 'reused' ? 'different-boot:old-pid' : null;
  const original = JSON.stringify({ providers: { worker: { pid: process.pid, stamp, home: path.join(runtime, 'agents/worker'), kind: 'omp-tui' } }, drafts: { worker: 'unsent draft' }, jobs: [{ id: 'accepted', status: 'running' }] });
  const file = path.join(runtime, 'state.json'); await put(file, original);
  await assert.rejects(initializeNozeliConfiguration(paths, { legacyDesktop }), error => {
    assert.equal(error.code, identity === 'reused' && process.platform === 'linux' ? 'MIGRATION_SOURCE_LOCKED' : 'MIGRATION_SOURCE_LIVE');
    return true;
  });
  assert.equal(await read(file), original);
  await assert.rejects(fs.lstat(paths.desktop), { code: 'ENOENT' });
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});
