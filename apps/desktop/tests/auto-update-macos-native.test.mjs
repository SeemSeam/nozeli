import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
const native = process.platform === 'darwin' && process.arch === 'arm64';
for (const scenario of ['success', 'failure', 'interrupted']) test('real Mac .app UI update: ' + scenario, {skip: !native ? 'Requires native darwin arm64 and built full app; not qualified by Linux' : false, timeout: 900000}, async t => {
  assert(process.env.NOZELI_MAC_UPDATE_APP, 'Set NOZELI_MAC_UPDATE_APP to freshly built Nozeli.app; native CI must not silently skip a missing product');
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'desktop-auto-update-macos-live.mjs')], {env: {...process.env, NOZELI_MAC_UPDATE_SCENARIO: scenario}, stdio: ['ignore', 'pipe', 'pipe']});
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({code, signal})); });
  console.log(output); assert.deepEqual(result, {code: 0, signal: null}, output);
});
