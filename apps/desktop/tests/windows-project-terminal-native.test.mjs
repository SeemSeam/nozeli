import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, mkdir, rename, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectTerminal, projectTerminalShell, loadProjectConpty } from '../src/platform/windows/project-terminal.mjs';
import { ProjectTerminalHost } from '../src/main/project-terminal.mjs';
import { createLayout, reduceLayout } from '../src/domain/workspace-layout.mjs';
import {DesktopHost} from '../src/main/host.mjs';
const windows = process.platform === 'win32' && process.arch === 'x64';
const commandRuntime=process.versions.electron?process.env.NOZELI_TEST_NODE_EXECUTABLE:process.execPath;
if(windows&&!path.isAbsolute(commandRuntime??''))throw Error('Explicit standalone Node fixture executable required in Electron host');
async function until(work, message, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await work()) return; await delay(20); }
  assert.fail(message);
}
const commandQuote = value => `"${value}"`;
const cleanEnv = () => ({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH ?? process.env.Path ?? '', TEMP: tmpdir(), TERM: 'xterm-256color', NOZELI_SYNTHETIC: '你好 synthetic spaces' });

test('real ConPTY command, Unicode cwd/environment, resize and Ctrl-C preserve the interactive shell', { skip: !windows }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'nozeli 终端 '));
  const script = path.join(cwd, 'synthetic command.cjs');
  await writeFile(script, `process.stdout.write('NATIVE_RESULT:'+JSON.stringify({cwd:process.cwd(),value:process.env.NOZELI_SYNTHETIC})+'\\n');setInterval(()=>{},1000);`);
  const term = createProjectTerminal({ shell: projectTerminalShell(), cwd, env: cleanEnv(), cols: 80, rows: 24 });
  let output = ''; term.onData(text => { output += text; }); term.onExit(() => {});
  try {
    term.start();
    term.write(`${commandQuote(commandRuntime)} ${commandQuote(script)}\r`);
    await until(() => output.includes('NATIVE_RESULT:'), 'native script did not emit output');
    await until(() => output.includes('你好 synthetic spaces'), 'Unicode environment was not preserved');
    assert.ok(output.includes(JSON.stringify(cwd).slice(1, -1)), 'Unicode/spaced cwd was not preserved');
    term.resize(123, 42);
    term.write('\x03');
    await delay(300);
    term.write('set "SURVIVE=VIVED"\recho CTRL_C_SUR%SURVIVE%\r');
    await until(() => output.includes('CTRL_C_SURVIVED'), 'Ctrl-C did not return to the original shell');
    assert.equal((await term.cleanup()).cleanupComplete, true);
    assert.equal((await term.cleanup()).cleanupComplete, true);
  } finally { await term.cleanup(); await rm(cwd, { recursive: true, force: true }); }
});

test('real ConPTY leader-first/background Job cleanup leaves an unrelated sentinel alive', { skip: !windows }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'nozeli tree '));
  const ready = path.join(cwd, 'background.ready');
  const script = path.join(cwd, 'background.cjs');
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(ready)},'synthetic');setInterval(()=>{},1000);`);
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const pin = loadProjectConpty().openProcessIdentity(sentinel.pid);
  const term = createProjectTerminal({ shell: projectTerminalShell(), cwd, env: cleanEnv(), cols: 80, rows: 24 });
  let exit; term.onData(() => {}); term.onExit(value => { exit = value; });
  try {
    term.start();
    term.write(`start "" /b ${commandQuote(commandRuntime)} ${commandQuote(script)}\r`);
    await until(async () => { try { await access(ready); return true; } catch { return false; } }, 'background process did not start');
    term.write('exit\r');
    await until(() => exit, 'leader exit was not observed');
    const receipt = await term.cleanup();
    assert.equal(receipt.descendantsConfirmed, true);
    assert.equal(pin.snapshot().state, 'running', 'unrelated sentinel was terminated');
  } finally { await term.cleanup(); sentinel.kill(); pin.close(); await rm(cwd, { recursive: true, force: true }); }
});

test('real Windows ProjectTerminalHost is cold-explicit, keeps the same docked shell and supports stop/restart', { skip: !windows }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'nozeli host '));
  let layout = reduceLayout(createLayout('synthetic'), { type: 'open', view: { kind: 'project-terminal' } });
  const viewId = Object.values(layout.views).find(view => view.kind === 'project-terminal').id;
  const workspace = {
    lifecycle: new Map(), layouts: new Map(), surfaces: new Map(),
    layout: async () => layout,
    command: async (_r, payload) => { layout = reduceLayout(layout, payload.command); return { layout, windowId: 'main' }; },
    serial: async (_id, fn) => fn(), persist: async () => {}, changed() {}, broadcast() {},
  };
  const host = new ProjectTerminalHost({ workspace, host: { requireProject: async () => ({ root: cwd }) }, env: { ...cleanEnv(), COMSPEC: 'Z:\\not-authorized.exe', lowercase_secret: 'must-not-reach-shell' } });
  const surface = { role: 'surface', kind: 'project-terminal', projectId: 'synthetic', viewId };
  const payload = { projectId: 'synthetic', viewId };
  try {
    assert.equal((await host.attach(surface, payload)).status, 'not-started');
    const first = await host.attach(surface, { ...payload, restart: true });
    assert.match(first.shell.path, /\\System32\\cmd\.exe$/i);
    const rebound = await host.attach(surface, { ...payload, cols: 99, rows: 31 });
    assert.equal(rebound.instanceId, first.instanceId);
    assert.equal(rebound.pid, first.pid);
    await host.write(surface, { ...payload, instanceId: first.instanceId, data: 'set "NATIVE_SUFFIX=OUTPUT"\recho HOST_NATIVE_%NATIVE_SUFFIX%\r' });
    await until(async () => (await host.read(surface, { ...payload, instanceId: first.instanceId, afterSeq: 0 })).frames.some(frame => frame.data.includes('HOST_NATIVE_OUTPUT')), 'host did not retain native output');
    assert.equal((await host.stop(surface, { ...payload, instanceId: first.instanceId })).cleanup.cleanupComplete, true);
    assert.equal((await host.attach(surface, payload)).status, 'not-started');
    const next = await host.attach(surface, { ...payload, restart: true });
    assert.notEqual(next.instanceId, first.instanceId);
    assert.equal((await host.stopProject('synthetic')).cleanup.cleanupComplete, true);
  } finally { await host.stopAll(); await rm(cwd, { recursive: true, force: true }); }
});

test('real ConPTY input failure still permits proven Job cleanup and releases the native lease',{skip:!windows},async()=>{
 const cwd=await mkdtemp(path.join(tmpdir(),'nozeli input failure ')),native=loadProjectConpty();let failed=false;
 const injected={createProjectConpty(...args){const lease=native.createProjectConpty(...args),wrapper={};for(const key of ['snapshot','resume','terminate','readOutput','pollInput','resize','close'])wrapper[key]=lease[key].bind(lease);wrapper.writeInput=()=>{throw Object.assign(Error('Synthetic input failure'),{code:'CONPTY_WRITE_UNKNOWN'});};return wrapper;}};
 const term=createProjectTerminal({shell:projectTerminalShell(),cwd,env:cleanEnv(),cols:80,rows:24,native:injected});term.onData(()=>{});term.onExit(()=>{failed=true;});
 try{term.start();term.write('echo not-delivered\r');await until(()=>failed,'input failure did not fence the terminal');assert.equal((await term.cleanup()).cleanupComplete,true);}
 finally{await term.cleanup();await rm(cwd,{recursive:true,force:true});}
});

test('real Windows terminal refuses a same-path replacement of the registered project before shell startup',{skip:!windows},async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'nozeli cwd identity ')),cwd=path.join(base,'project'),profile=path.join(base,'profile');await mkdir(cwd);
 const initial=new DesktopHost(profile);const {project}=await initial.pick(cwd);await initial.storage.db.close();
 await rename(cwd,cwd+'.original');await mkdir(cwd);await writeFile(path.join(cwd,'winner.txt'),'external-winner');
 const host=new DesktopHost(profile);let layout=reduceLayout(createLayout(project.id),{type:'open',view:{kind:'project-terminal'}});const viewId=Object.values(layout.views).find(view=>view.kind==='project-terminal').id;
 const workspace={lifecycle:new Map(),layouts:new Map(),surfaces:new Map(),layout:async()=>layout,command:async(_r,p)=>{layout=reduceLayout(layout,p.command);return {layout,windowId:'main'};},serial:async(_id,fn)=>fn(),persist:async()=>{},changed(){},broadcast(){}};
 const terminal=new ProjectTerminalHost({workspace,host,env:cleanEnv()});
 try{
  await assert.rejects(terminal.attach({role:'surface',kind:'project-terminal',projectId:project.id,viewId},{projectId:project.id,viewId,restart:true}),{code:'PROJECT_IDENTITY_CONFLICT'});
  assert.equal(await readFile(path.join(cwd,'winner.txt'),'utf8'),'external-winner');assert.equal(terminal.instances.size,0);
 }finally{await terminal.stopAll();await host.storage.db.close();await rm(base,{recursive:true,force:true});}
});
