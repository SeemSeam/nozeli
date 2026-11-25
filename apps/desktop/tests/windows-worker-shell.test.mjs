import {spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { resolveWorkerShell } from '../src/agents/managed/shell-runtime.mjs';
import { resolveBundledPiRuntime } from '../src/agents/managed/pi-runtime.mjs';

const windows = process.platform === 'win32';
const integration = process.env.NOZELI_TEST_PI_ROOT ?? path.resolve(import.meta.dirname, '../../../integrations/pi');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const GNU = { status: 0, stdout: 'GNU bash, version 5.3.15(2)-release\r\n' };

// ── host resolution ─────────────────────────────────────────────────────────

test('resolver follows the SDK location order and verifies GNU bash', () => {
  const run = (file, args) => args[0] === '--version'
    ? (file.toLowerCase().endsWith(path.join('git', 'bin', 'bash.exe')) ? GNU : { status: 1, stdout: '' })
    : { status: 0, stdout: 'C:\\Tools\\bash.exe\r\n' };
  const resolved = resolveWorkerShell({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, run });
  assert.equal(resolved.shell, path.join('C:\\Program Files', 'Git', 'bin', 'bash.exe'));
  assert.equal(resolved.source, 'program-files-git');
  assert.ok(resolved.version.startsWith('GNU bash'));
});

test('resolver falls through ProgramFiles(x86) when the 64-bit install fails verification', () => {
  const run = (file, args) => args[0] === '--version'
    ? (file.startsWith('C:\\Program Files (x86)') ? GNU : { status: 0, stdout: 'some other shell 1.0\r\n' })
    : { status: 1 };
  const resolved = resolveWorkerShell({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    run,
  });
  assert.equal(resolved.source, 'program-files-x86-git');
  assert.equal(resolved.shell, path.join('C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'));
});

test('resolver uses where.exe discovery last and reports nothing when nothing verifies', () => {
  const run = (file, args) => args[0] === '--version'
    ? (file === 'C:\\MSYS2\\usr\\bin\\bash.exe' ? GNU : { status: 1, stdout: '' })
    : { status: 0, stdout: 'C:\\MSYS2\\usr\\bin\\bash.exe\r\n' };
  const resolved = resolveWorkerShell({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, run });
  assert.equal(resolved.source, 'path');
  assert.equal(resolved.shell, 'C:\\MSYS2\\usr\\bin\\bash.exe');
  const absent = resolveWorkerShell({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files' },
    run: () => ({ status: 1, stdout: '', error: Object.assign(new Error('probe failed'), { code: 'ENOENT' }) }),
  });
  assert.equal(absent, null);
});

test('resolver never probes off-Windows platforms', () => {
  let calls = 0;
  const resolved = resolveWorkerShell({ platform: 'linux', env: { ProgramFiles: 'C:\\Program Files' }, run: () => { calls += 1; return GNU; } });
  assert.equal(resolved, null);
  assert.equal(calls, 0);
});

// ── bundled runtime plumbing ────────────────────────────────────────────────

async function syntheticIntegration(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-shell-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'owner.mjs'), 'export {};\n');
  await fs.writeFile(path.join(root, 'src', 'launch.mjs'), [
    "import path from 'node:path';",
    'export async function resolvePiWorkerRuntime({ integrationRoot, nodePath } = {}) {',
    '  return { command: nodePath ?? process.execPath, args: [path.join(integrationRoot, "src", "owner.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };',
    '}',
    '',
  ].join('\n'));
  return root;
}

test('bundled Pi runtime pins the resolved shell without widening the scrubbed environment', async t => {
  const integrationRoot = await syntheticIntegration(t);
  const pinned = { shell: 'C:\\Program Files\\Git\\bin\\bash.exe' };
  let asked = 0;
  const spec = await resolveBundledPiRuntime({
    piHome: path.join(os.tmpdir(), 'nozeli-shell-home'),
    env: { NOZELI_PI_INTEGRATION_ROOT: integrationRoot, OPENAI_API_KEY: 'TEST_ONLY', Path: 'C:\\UserTools' },
    resolveShell: ({ env }) => { asked += 1; assert.equal(env.NOZELI_PI_INTEGRATION_ROOT, integrationRoot); return pinned; },
  });
  assert.equal(asked > 0, windows, 'resolution only runs on Windows');
  assert.equal(spec.env.OPENAI_API_KEY, undefined);
  if (windows) {
    assert.equal(spec.env.NOZELI_PI_SHELL, pinned.shell);
    assert.equal(spec.shell, pinned.shell);
    assert.equal(spec.toolPath, 'C:\\UserTools');
  } else {
    assert.equal(spec.env.NOZELI_PI_SHELL, undefined);
    assert.equal(spec.shell, null);
  }
  const absent = await resolveBundledPiRuntime({
    piHome: path.join(os.tmpdir(), 'nozeli-shell-home'),
    env: { NOZELI_PI_INTEGRATION_ROOT: integrationRoot, NOZELI_PI_SHELL: 'C:\\unverified\\bash.exe' },
    resolveShell: ({ env }) => null,
  });
  assert.equal(absent.env.NOZELI_PI_SHELL, undefined);
  assert.equal(absent.shell, null);
});

// ── worker bash tool ────────────────────────────────────────────────────────

const { pinnedWorkerShell, createWorkerBashToolDefinition } =
  await import(pathToFileURL(path.join(integration, 'src/shell.mjs')));

test('worker keeps the host pin only for absolute paths that still exist', async () => {
  assert.equal(pinnedWorkerShell({}), null);
  assert.equal(pinnedWorkerShell({ NOZELI_PI_SHELL: '' }), null);
  assert.equal(pinnedWorkerShell({ NOZELI_PI_SHELL: 'relative/bash.exe' }), null);
  assert.equal(pinnedWorkerShell({ NOZELI_PI_SHELL: path.join(os.tmpdir(), 'nozeli-shell-missing-bash.exe') }), null);
  assert.equal(pinnedWorkerShell({ NOZELI_PI_SHELL: process.execPath }), process.execPath);
});

test('without a verified shell the bash tool answers with the explicit device prerequisite', async () => {
  const definition = createWorkerBashToolDefinition({ cwd: os.tmpdir(), shell: null });
  assert.equal(definition.name, 'bash');
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['command', 'timeout']);
  const result = await definition.execute('call-1', { command: 'ls' }, undefined);
  assert.equal(result.isError, true);
});

test('with a verified shell the SDK bash tool executes real commands through the pinned executable', async t => {
  const resolved = resolveWorkerShell();
  if (!resolved) { t.skip('no supported Bash on this device'); return; }
  const shell = pinnedWorkerShell({ NOZELI_PI_SHELL: resolved.shell });
  assert.equal(shell, resolved.shell);
  const definition = createWorkerBashToolDefinition({ cwd: os.tmpdir(), shell });
  assert.equal(definition.name, 'bash');
  const result = await definition.execute('call-2', { command: 'printf nozeli-shell-ok' }, undefined);
  assert.equal(result.isError ?? false, false, 'a successful command is not an error result');
  assert.match(result.content.map(block => block.text).join(''), /nozeli-shell-ok/);
});

// ── registered Windows owner environment ────────────────────────────────────

if (windows) {
  const { createExperimentalPiOwnerLaunch } = await import('../src/platform/windows/experimental-pi-owner-launch.mjs');

  test('owner launch validates and pins the shell without widening the fixed environment', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-shell-owner-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'owners', 'frontdesk'), agentDir = path.join(home, 'config');
    const runtime = { command: process.execPath, commandSha256: sha(await fs.readFile(process.execPath)), entry: path.join(root, 'owner.mjs'), entrySha256: 'a'.repeat(64) };
    assert.throws(() => createExperimentalPiOwnerLaunch({ root, home, agentDir, runtime: { ...runtime, shell: 'relative\\bash.exe' }, registry: {}, target: 'frontdesk', isCurrent: () => true }), { code: 'PI_RUNTIME_INVALID' });
    const pinned = { ...runtime, shell: 'C:\\Program Files\\Git\\bin\\bash.exe' };
    const service = createExperimentalPiOwnerLaunch({ root, home, agentDir, runtime: pinned, registry: {}, target: 'frontdesk', isCurrent: () => true });
    const env = service.environment('owner-1');
    assert.equal(env.NOZELI_PI_SHELL, 'C:\\Program Files\\Git\\bin\\bash.exe');
    assert.equal(env.PATH, path.dirname(process.execPath) + path.delimiter + path.join(process.env.SystemRoot, 'System32'), 'fixed worker PATH stays exactly the runtime Node directory plus System32');
    assert.equal(env.ProgramFiles, undefined, 'ambient ProgramFiles never leaks into the worker environment');
    const bare = createExperimentalPiOwnerLaunch({ root, home, agentDir, runtime, registry: {}, target: 'frontdesk', isCurrent: () => true });
    assert.equal(bare.environment('owner-1').NOZELI_PI_SHELL, undefined);
    assert.equal(bare.environment('owner-1').PATH, env.PATH);
  });

  test('ordinary Bash discovers user-installed tools while retaining private homes and excluding ambient credentials', async t => {
    const resolved=resolveWorkerShell();
    if(!resolved){t.skip('supported Bash required');return;}
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-tool-path-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const tools=path.join(root,'user-tools');await fs.mkdir(tools);
    const probe=path.join(tools,'nozeli-path-probe.exe');
    await fs.copyFile(path.join(process.env.SystemRoot,'System32','where.exe'),probe);
    const runtime={command:process.execPath,commandSha256:sha(await fs.readFile(process.execPath)),entry:path.join(root,'owner.mjs'),entrySha256:'a'.repeat(64),shell:resolved.shell,toolPath:tools};
    const service=createExperimentalPiOwnerLaunch({root,home:path.join(root,'owner'),agentDir:path.join(root,'owner','config'),runtime,registry:{},target:'frontdesk',isCurrent:()=>true});
    const env=service.environment('owner-path-probe');
    assert.equal(env.OPENAI_API_KEY,undefined);
    assert.equal(env.HOME,path.join(root,'owner','environment'));
    assert.equal(env.PATH.split(path.delimiter)[0],path.dirname(process.execPath));
    const result=spawnSync(resolved.shell,['--noprofile','--norc','-c','nozeli-path-probe.exe nozeli-path-probe.exe'],{env,cwd:root,encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim().toLowerCase(),probe.toLowerCase());
  });

}
