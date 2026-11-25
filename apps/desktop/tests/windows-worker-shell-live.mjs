// Live shell-adapter proof against a packaged candidate (host resolution ->
// pinned SDK bash tool -> real execution under the fixed owner environment).
// This is not the full bridge: full worker/bridge integration is proven by the
// qualification suites and the real task run.
//   NOZELI_TEST_APP_ROOT=<packaged resources/app> node tests/windows-worker-shell-live.mjs
// Resolves the supported Bash exactly as the production host does, then spawns
// the bundled Node under the FIXED owner environment (PATH = runtime Node
// directory + System32, no ProgramFiles, no user PATH) and executes real
// commands through the packaged worker's native bash tool with the pinned
// shell. Documents the fixed-PATH limitation for git: the bundled MinGit is
// host-side custody and is deliberately not on the worker PATH.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32', 'Windows packaged-shell proof');
const appRootArgument = process.env.NOZELI_TEST_APP_ROOT?.trim();
assert.ok(appRootArgument, 'Set NOZELI_TEST_APP_ROOT to the packaged resources/app directory');
const appRoot = path.resolve(appRootArgument);

const { resolveWorkerShell } = await import(pathToFileURL(path.join(appRoot, 'src/agents/managed/shell-runtime.mjs')).href);
const resolved = resolveWorkerShell();
if (!resolved) {
  console.error('SMOKE-FAIL no supported Bash on this device: install Git for Windows (bash.exe under %ProgramFiles%\\Git\\bin or on PATH) and restart Nozeli');
  process.exit(1);
}
console.log(`shell resolved: ${resolved.shell} [${resolved.source}] ${resolved.version}`);

let nodeExecutable = process.execPath;
const nodeManifest = path.join(appRoot, 'runtime', 'node', 'NODE-RUNTIME.json');
if (await fs.access(nodeManifest).then(() => true, () => false)) {
  ({ executable: nodeExecutable } = await (await import(pathToFileURL(path.join(appRoot, 'src/agents/managed/pi-runtime.mjs')).href)).readBundledNode(appRoot));
  console.log(`bundled node: ${nodeExecutable}`);
} else {
  console.log(`bundled node runtime absent in this app root; fixed PATH uses the running node: ${nodeExecutable}`);
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-shell-smoke-'));
const integration = path.join(appRoot, 'integrations', 'pi');
const environmentRoot = path.join(temporary, 'environment');
const env = {
  SystemRoot: process.env.SystemRoot,
  windir: process.env.SystemRoot,
  PATH: path.dirname(nodeExecutable) + path.delimiter + path.join(process.env.SystemRoot, 'System32'),
  HOME: environmentRoot, USERPROFILE: environmentRoot, APPDATA: environmentRoot, LOCALAPPDATA: environmentRoot,
  TEMP: temporary, TMP: temporary,
  NOZELI_PI_SHELL: resolved.shell,
  NOZELI_PI_SHELL_MODULE: pathToFileURL(path.join(integration, 'src/shell.mjs')).href,
  NO_COLOR: '1', FORCE_COLOR: '0',
};

const childScript = `
const { createWorkerBashToolDefinition } = await import(process.env.NOZELI_PI_SHELL_MODULE);
const tool = createWorkerBashToolDefinition({ cwd: process.env.TMP, shell: process.env.NOZELI_PI_SHELL });
if (tool.name !== 'bash') throw Error('worker bash tool missing');
for (const command of [
  'printf packaged-shell-ok',
  'command -v node >/dev/null && printf node-found || printf node-missing',
  'command -v git >/dev/null && printf git-on-path || printf git-absent-fixed-path',
]) {
  const result = await tool.execute('smoke', { command });
  process.stdout.write((result.content ?? []).map(block => block.text ?? '').join('') + ' [isError=' + (result.isError === true) + ']\\n');
}
`;
const child = spawn(nodeExecutable, ['-e', childScript], { env, windowsHide: true });
let out = '', err = '';
child.stdout.on('data', chunk => { out += chunk; });
child.stderr.on('data', chunk => { err += chunk; });
const code = await new Promise(resolve => child.on('close', resolve));
console.log(out.trim());
if (err.trim()) console.error('stderr: ' + err.trim());
assert.equal(code, 0, 'fixed-environment worker exited cleanly');
assert.match(out, /packaged-shell-ok/, 'bash executed a real command through the pinned shell');
assert.match(out, /node-found/, 'the fixed worker PATH resolves the bundled runtime Node');
console.log(out.includes('git-absent-fixed-path')
  ? 'limitation stated: git is not on the fixed worker PATH (bundled MinGit is host-side custody; the worker never runs git)'
  : 'note: a git executable was reachable on the fixed worker PATH');
console.log('SMOKE-PASS shell adapter exercised: host resolution -> pinned SDK bash tool -> real execution under the fixed owner environment');
