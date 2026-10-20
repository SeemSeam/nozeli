// Run manually with no other updated Nozeli instance running. Uses real Electron
// and production main.cjs; does not start Agents or contact a provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const electron = require('electron');
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-singleton-'));
const children = new Set();
function launch(name, args = [], alteredHome = false) {
  const profileRoot = path.join(root, name);
  const env = { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: profileRoot,
    NOZELI_USER_DATA: path.join(profileRoot, 'desktop') };
  delete env.ELECTRON_RUN_AS_NODE;
  if (alteredHome) {
    env.HOME = path.join(root, 'alternate-home');
    env.XDG_CONFIG_HOME = path.join(root, 'alternate-config');
    env.XDG_CACHE_HOME = path.join(root, 'alternate-cache');
  }
  const child = spawn(electron, [path.join(directory, 'singleton-electron-entry.cjs'), ...args], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  const messages = [];
  let diagnostics = '';
  child.stdout.on('data', data => { diagnostics = (diagnostics + data).slice(-12000); });
  child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-12000); });
  const waiters = new Set();
  child.on('message', message => { messages.push(message); for (const wake of waiters) wake(); });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    children.delete(child); resolve({ code, signal }); for (const wake of waiters) wake();
  }));
  child.on('error', error => { diagnostics += error.message; });
  async function message(event) {
    const deadline = Date.now() + 90000;
    while (true) {
      const found = messages.find(value => value.event === event);
      if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
        throw new Error(`No ${event} from ${name}: ${diagnostics}`);
      }
      await new Promise(resolve => { const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); }; const timer = setTimeout(wake, 250); waiters.add(wake); });
    }
  }
  return { child, exit, message, messages, profileRoot };
}
async function exited(instance, expected) {
  let timer;
  try {
    const result = await Promise.race([instance.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Electron did not exit')), 20000); })]);
    if (expected !== undefined) assert.equal(result.code, expected);
    return result;
  } finally { clearTimeout(timer); }
}
try {
  const a = launch('A');
  const ready = await a.message('window-ready');
  assert.equal(ready.userData, path.join(a.profileRoot, 'desktop'));
  assert.equal(ready.sessionData, ready.userData);
  const requested = path.join(root, 'open-me.md');
  await fs.writeFile(requested, '# Synthetic singleton smoke\n');
  const b = launch('B', [requested], true);
  await exited(b, 0);
  const routed = await a.message('second-instance');
  assert.ok(routed.argv.includes(requested), 'native second-instance delivers file to A');
  await assert.rejects(fs.stat(b.profileRoot), { code: 'ENOENT' });
  a.child.send('extra-window');
  assert.ok((await a.message('window-count')).count >= 2, 'one product process permits multiple BrowserWindows');
  for (const flag of ['--nozeli-terminal-client', '--nozeli-handoff', '--nozeli-document']) {
    const before = a.messages.filter(value => value.event === 'second-instance').length;
    const helper = launch('helper-' + flag.slice(2), [flag]);
    await exited(helper); // Missing IPC payload is a client error, not a product launch.
    assert.equal(a.messages.filter(value => value.event === 'second-instance').length, before, `${flag} bypasses product lock`);
    await assert.rejects(fs.stat(helper.profileRoot), { code: 'ENOENT' });
  }
  a.child.send('wake-count');
  assert.ok((await a.message('wake-count')).count >= 1, 'existing production renderer receives external.open wake');
  a.child.send('exit');
  await exited(a, 0);
  const restarted = launch('B', [], true);
  await restarted.message('window-ready');
  restarted.child.kill('SIGKILL');
  await exited(restarted);
  const recovered = launch('C');
  await recovered.message('window-ready');
  recovered.child.send('exit');
  await exited(recovered, 0);
  console.log('PASS: cross-profile native singleton, file handoff, multiwindow, helpers, normal exit and crash recovery');
} finally {
  await Promise.all([...children].map(child => { child.kill('SIGKILL'); return new Promise(resolve => child.once('exit', resolve)); }));
  // Keep synthetic profiles and diagnostics inputs for inspection; no user data.
  console.log(`Singleton smoke artifacts: ${root}`);
}
