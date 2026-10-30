import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createForceQuit, snapshotDescendants, killSnapshot} = require('../src/main/force-quit.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function alive(pid) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return false; }
}
async function until(fn) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { if (await fn()) return; await pause(20); }
  throw Error('owned descendant did not exit');
}
function child(t, code, args = []) {
  const process = spawn(globalThis.process.execPath, ['-e', code, ...args], {stdio:['ignore','pipe','pipe','ipc']});
  const exited = once(process, 'exit');
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
    await exited;
  });
  return process;
}

test('recursive Linux snapshot kills owned descendants, not unrelated same-user process', {skip:process.platform !== 'linux', timeout:10000}, async t => {
  const leafCode = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send({ready:true});";
  const middleCode = `const {spawn}=require('node:child_process');const leaf=spawn(process.execPath,['-e',${JSON.stringify(leafCode)}],{stdio:['ignore','ignore','ignore','ipc']});leaf.on('message',()=>process.send({pid:leaf.pid,middle:process.pid}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const root = child(t, `const {spawn}=require('node:child_process');const middle=spawn(process.execPath,['-e',${JSON.stringify(middleCode)}],{stdio:['ignore','ignore','ignore','ipc']});middle.on('message',message=>process.send(message));setInterval(()=>{},1000);`);
  const unrelated = child(t, leafCode);
  const [[message]] = await Promise.all([once(root,'message'), once(unrelated,'message')]);
  t.after(async () => { for (const pid of [message.pid,message.middle]) if (await alive(pid)) { try { process.kill(pid,'SIGKILL'); } catch {} } });
  const snapshot = await snapshotDescendants(root.pid);
  assert(snapshot.some(row => row.pid === message.pid), 'grandchild captured recursively');
  assert(snapshot.some(row => row.pid === message.middle), 'intermediate parent captured');
  assert(!snapshot.some(row => row.pid === unrelated.pid || row.pid === process.pid || row.pid === root.pid));
  await killSnapshot(snapshot);
  await until(async () => !await alive(message.pid));
  await until(async () => !await alive(message.middle));
  assert(await alive(unrelated.pid), 'unrelated real process survives');
  assert(await alive(root.pid), 'snapshot never signals root itself');
});

test('PID birth and uid mismatch prevent signalling a real captured child', {skip:process.platform !== 'linux', timeout:10000}, async t => {
  const target = child(t, "setInterval(()=>{},1000);process.send({ready:true});");
  await once(target,'message');
  const captured = (await snapshotDescendants()).find(row => row.pid === target.pid);
  assert(captured);
  await killSnapshot([{...captured, start:String(BigInt(captured.start) + 1n)}]);
  assert(await alive(target.pid), 'reused PID birth identity is rejected');
  await killSnapshot([{...captured, uid:captured.uid + 1}]);
  assert(await alive(target.pid), 'different owner is rejected');
  await killSnapshot([captured]);
  await until(async () => !await alive(target.pid));
});

test('Chromium-like argv never exempts a native child from owned termination', {skip:process.platform !== 'linux', timeout:10000}, async t => {
  const target = child(t, "setInterval(()=>{},1000);process.send({ready:true});", ['--','--type=gpu-process']);
  await once(target,'message');
  const captured = (await snapshotDescendants()).find(row => row.pid === target.pid);
  assert(captured);
  assert.equal(captured.chromium,false, 'native Node is not an Electron Chromium process');
  await killSnapshot([captured]);
  await until(async () => !await alive(target.pid));
});

test('force exit ignores permanently hanging cleanup and coalesces duplicate force choices', {timeout:4000}, async () => {
  let calls = 0;
  const started = Date.now();
  const exited = new Promise(resolve => {
    const quit = createForceQuit({app:{exit(code) { calls++; resolve({code, elapsed:Date.now()-started}); }}, cleanup:() => new Promise(() => {})});
    quit(); quit();
  });
  const result = await exited;
  assert.equal(result.code, 0);
  assert(result.elapsed < 3000, `exit took ${result.elapsed}ms`);
  assert.equal(calls, 1);
});

test('cleanup rejection and synchronous failure still exit without normal lifecycle work', async () => {
  for (const cleanup of [() => Promise.reject(Error('failed')), () => { throw Error('failed'); }]) {
    let calls = 0;
    await new Promise(resolve => createForceQuit({app:{exit(code) { assert.equal(code,0); calls++; resolve(); }}, cleanup})());
    assert.equal(calls,1);
  }
});
