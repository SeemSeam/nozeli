import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveBundledOmpRuntime } from '../src/agents/managed/omp-runtime.mjs';
import { OmpAuthBrokerHost } from '../src/agents/managed/omp-auth-broker.mjs';
import { isolatedLaunch } from '../src/agents/managed/process-isolation.mjs';
const execute = promisify(execFile);

test('real standalone runtime ignores official directory/profile/PATH settings', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { command } = await resolveBundledOmpRuntime();
  const official = path.join(root, 'official');
  await fs.mkdir(official);
  await fs.writeFile(path.join(official, 'sentinel'), 'untouched');
  const privateRoot = path.join(root, '.Nozeli');
  const env = { ...process.env, PATH: '', HOME: official, PI_CONFIG_DIR: official, PI_CODING_AGENT_DIR: official, OMP_PROFILE: '../invalid', XDG_DATA_HOME: official, XDG_CACHE_HOME: official, XDG_STATE_HOME: official, PI_NATIVES_DIR: official, OMP_AUTH_BROKER_SNAPSHOT_CACHE: path.join(official, 'snapshot'), NOZELI_CONFIG_ROOT: privateRoot };
  delete env.NOZELI_AGENT_DIR;
  const result = await execute(command, ['--nozeli-paths'], { env });
  const locations = JSON.parse(result.stdout);
  for (const value of Object.values(locations)) assert.ok(value === privateRoot || value.startsWith(privateRoot + path.sep), value);
  assert.equal(locations.agent, path.join(privateRoot, 'omp'));
  assert.deepEqual(await fs.readdir(official), ['sentinel']);
  const role = path.join(privateRoot, 'desktop/managed/agent');
  const roleResult = await execute(command, ['--nozeli-paths'], { env: { ...env, NOZELI_AGENT_DIR: role } });
  assert.equal(JSON.parse(roleResult.stdout).agent, role);
  const rolePaths = JSON.parse(roleResult.stdout);
  assert.ok(rolePaths.project.startsWith(path.join(role, 'projects') + path.sep));
  for (const [name, value] of Object.entries(rolePaths)) if (name !== 'root') assert.ok(value === role || value.startsWith(role + path.sep), `${name}: ${value}`);
  await assert.rejects(execute(command, ['--nozeli-paths'], { env: { ...env, NOZELI_AGENT_DIR: official } }));
  await fs.mkdir(privateRoot, { recursive: true });
  await fs.symlink(official, path.join(privateRoot, 'escape'));
  await assert.rejects(execute(command, ['--nozeli-paths'], { env: { ...env, NOZELI_AGENT_DIR: path.join(privateRoot, 'escape/role') } }));
});

test('standalone broker creates only private vault and enforces bearer authorization', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-broker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { command } = await resolveBundledOmpRuntime();
  const official = path.join(root, 'official');
  const privateRoot = path.join(root, '.Nozeli');
  await fs.mkdir(official); await fs.mkdir(privateRoot);
  await fs.writeFile(path.join(official, 'sentinel'), 'untouched');
  const host = new OmpAuthBrokerHost({ command, source: { root: privateRoot, describe: async () => ({ root: privateRoot }) }, sourceEnv: { ...process.env, PATH: '', HOME: official, PI_CODING_AGENT_DIR: official, OPENAI_API_KEY: 'synthetic-ambient-key-not-imported', ANTHROPIC_API_KEY: 'synthetic-ambient-key-not-imported', AWS_ACCESS_KEY_ID: 'synthetic-ambient-key-not-imported', AWS_SECRET_ACCESS_KEY: 'synthetic-ambient-key-not-imported' } });
  t.after(() => host.stop());
  const grant = await host.acquire();
  assert.ok(grant.token);
  const denied = await fetch(new URL('/v1/snapshot', grant.url));
  assert.equal(denied.status, 401);
  const allowed = await fetch(new URL('/v1/snapshot', grant.url), { headers: { Authorization: `Bearer ${grant.token}` } });
  assert.equal(allowed.status, 200);
  const snapshot = await allowed.json();
  assert.equal(Array.isArray(snapshot.credentials), true);
  assert.equal(snapshot.credentials.length, 0, 'Fresh private broker must not inherit ambient provider credentials');
  assert.ok((await fs.stat(path.join(privateRoot, 'omp/agent.db'))).isFile());
  assert.deepEqual(await fs.readdir(official), ['sentinel']);
  await host.stop();
});

test('resolver rejects tampered shipped artifacts rather than using system OMP', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-bundle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'runtime/omp');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'omp'), 'not the pinned executable');
  await fs.writeFile(path.join(dir, 'runtime.json'), JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch, command: 'omp', capabilities: ['nozeli-private-auth-broker','nozeli-native-collab-runtime-v1'], provenance: { commit: '0'.repeat(40), patches: { private: '0'.repeat(64) } }, files: { omp: '0'.repeat(64) } }));
  await assert.rejects(resolveBundledOmpRuntime({ appRoot: root }), /integrity mismatch/);
});

test('actual RPC starts with only role home writable and preserves shell HOME', { skip: process.platform !== 'linux' }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-role-sandbox-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, '.Nozeli');
  const role = path.join(root, 'desktop/role');
  const { command } = await resolveBundledOmpRuntime();
  const launch = await isolatedLaunch({ command, args: ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-rules', '--no-lsp'], home: role, cwd: workspace });
  const env = { PATH: '', HOME: process.env.HOME, NOZELI_CONFIG_ROOT: root, NOZELI_AGENT_DIR: role, OPENAI_API_KEY: 'nozeli-test-no-provider-request', ...launch.env };
  assert.equal(env.HOME, process.env.HOME);
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/bwrap', launch.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      child.once('exit', () => error ? reject(error) : resolve());
      if (child.exitCode !== null || child.signalCode !== null) error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('Private isolated RPC startup timed out: ' + errors)), 30000);
    child.on('error', finish);
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('"command":"get_state"')) finish();
    });
    child.once('exit', code => { if (!settled) finish(new Error(`Private isolated RPC exited ${code}: ${errors}`)); });
    child.stdin.write(JSON.stringify({ id: 'isolation-state', type: 'get_state' }) + '\n');
  });
  assert.ok((await fs.stat(path.join(role, 'natives'))).isDirectory());
  assert.ok((await fs.stat(path.join(role, 'run'))).isDirectory());
  await assert.rejects(fs.stat(path.join(root, 'natives')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'run')), { code: 'ENOENT' });
});

test('private runtime refuses self update before package managers execute', { skip: process.platform === 'win32' }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-update-denied-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const bin = path.join(workspace, 'bin');
  const root = path.join(workspace, '.Nozeli');
  const marker = path.join(workspace, 'manager-invoked');
  await fs.mkdir(bin);
  await fs.mkdir(root);
  for (const name of ['npm', 'bun', 'brew', 'mise']) {
    await fs.writeFile(path.join(bin, name), '#!/bin/sh\nprintf invoked > "$NOZELI_TEST_UPDATE_MARKER"\nexit 99\n', { mode: 0o755 });
  }
  const { command } = await resolveBundledOmpRuntime();
  for (const args of [['update'], ['update', '--check'], ['update', '--force'], ['update', '--canary']]) {
    await assert.rejects(execute(command, args, { cwd: workspace, env: { PATH: bin, HOME: workspace, NOZELI_CONFIG_ROOT: root, NOZELI_TEST_UPDATE_MARKER: marker }, timeout: 15000 }), error => {
      assert.match(error.stdout + error.stderr, /由Nozeli整体更新/);
      return true;
    });
  }
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});
