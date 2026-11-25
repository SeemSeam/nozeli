import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawnTool,stopTool} from '../src/main/tool-process.mjs';
import {prepareExperimentalProcessTransport} from '../src/platform/windows/experimental-process-transport.mjs';
const require=createRequire(import.meta.url);
const cleanup=require.resolve('../src/main/force-quit.cjs');
const bindingPath=fileURLToPath(new URL('../native/windows-process/build/Release/nozeli_windows_process.node',import.meta.url));
const windows={skip:process.platform!=='win32',timeout:15000};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fixtureNode=process.versions.electron?process.env.NOZELI_TEST_NODE_EXECUTABLE:process.execPath;
async function exited(pin){for(let i=0;i<200;i++){if(pin.snapshot().state==='exited')return;await pause(20);}assert.fail('retained process HANDLE did not signal');}

test('Windows captured descendants terminate by retained HANDLE while sibling sentinel survives',windows,async t=>{
  const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  t.after(()=>sentinel.kill());
  const worker=spawn(process.execPath,['-e',`
    const {spawn}=require('node:child_process');
    const {snapshotDescendants,killSnapshot}=require(${JSON.stringify(cleanup)});
    const root=spawn(${JSON.stringify(fixtureNode)},['-e',\`const {spawn}=require('node:child_process');const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.send({grand:grand.pid});setInterval(()=>{},1000);\`],{stdio:['ignore','ignore','ignore','ipc']});
    root.once('message',async value=>{const captured=await snapshotDescendants();let stopping;const stop=()=>stopping??=(async()=>killSnapshot(captured))();process.send({root:root.pid,grand:value.grand});process.on('message',async command=>{const result=await stop();if(command==='exit')process.exit(0);else process.send({result});});process.once('disconnect',()=>void stop().finally(()=>process.exit(0)));});
    setInterval(()=>{},1000);
  `],{stdio:['ignore','ignore','inherit','ipc']});
  t.after(async()=>{if(worker.exitCode===null&&worker.connected){worker.send('exit');await Promise.race([once(worker,'close'),pause(2000)]);}if(worker.exitCode===null)worker.kill();});
  const [ready]=await once(worker,'message');
  const native=require(bindingPath),root=native.openProcessIdentity(ready.root),grand=native.openProcessIdentity(ready.grand),outside=native.openProcessIdentity(sentinel.pid);
  t.after(()=>{root.close();grand.close();outside.close();});
  const response=once(worker,'message');worker.send('terminate');const [done]=await response;
  assert.equal(done.result.treeExitVerified,false);
  await exited(root);await exited(grand);
  assert.equal(outside.snapshot().state,'running');
});

test('Windows conservative same-image browser exclusion closes original capture deterministically',windows,async t=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>child.kill());
  const native=require(bindingPath),capture=native.captureForceQuitDescendants(process.pid,true);
  try { const result=capture.terminate();assert(result.browserSkipped>=1);assert.equal(result.treeExitVerified,false);assert.equal(child.exitCode,null); }
  finally { capture.close(); }
  capture.close();
  assert.throws(()=>capture.terminate(),{code:'PROCESS_HANDLE_CLOSED'});
  assert.throws(()=>native.captureForceQuitDescendants(child.pid,false),{code:'PROCESS_ROOT_INVALID'});
});

test('Windows tool Job stops a real grandchild without touching unrelated sentinel',windows,async t=>{
  const native=require(bindingPath);
  const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>sentinel.kill());
  const tool=spawnTool(process.execPath,['-e',`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);`],{cwd:process.cwd(),env:{...process.env}});
  tool.on('error',()=>{});tool.stderr.resume();
  let text='';const grandPid=await new Promise(resolve=>tool.stdout.on('data',bytes=>{text+=bytes; if(text.includes('\n'))resolve(Number(text.trim()));}));
  const grand=native.openProcessIdentity(grandPid),outside=native.openProcessIdentity(sentinel.pid);t.after(()=>{grand.close();outside.close();tool.kill();});
  const closed=once(tool,'close');const facts=await stopTool(tool);
  assert.equal(facts.jobEmptyObserved,true);assert.equal(facts.treeExitVerified,true);
  await closed;await exited(grand);assert.equal(outside.snapshot().state,'running');
});

test('Windows default force quit exits its actual process, stops a known child and leaves an unrelated sentinel',windows,async t=>{
 const native=require(bindingPath),sentinel=spawn(fixtureNode,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});t.after(()=>sentinel.kill());
 const source=`const {spawn}=require('node:child_process');const {createForceQuit}=require(${JSON.stringify(cleanup)});const child=spawn(${JSON.stringify(fixtureNode)},['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});child.once('spawn',()=>process.stdout.write(JSON.stringify({childPid:child.pid})+'\\n'));process.stdin.once('data',()=>{const quit=createForceQuit({app:{exit:code=>process.exit(code)}});quit();quit();});setInterval(()=>{},1000);`;
 const environment={SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})};
 const root=prepareExperimentalProcessTransport({command:process.execPath,args:['-e',source],cwd:process.cwd(),env:Object.entries(environment).filter(([,v])=>v!==undefined).map(([k,v])=>k+'='+v)});root.stderr.resume();
 t.after(async()=>{root.terminate();await root.waitForJobEmpty({timeoutMs:5000});root.close();});
 let text='';const ready=new Promise(resolve=>root.stdout.on('data',bytes=>{text+=bytes;if(text.includes('\n'))resolve(JSON.parse(text.slice(0,text.indexOf('\n'))));}));root.resume();const {childPid}=await ready;
 const child=native.openProcessIdentity(childPid),outside=native.openProcessIdentity(sentinel.pid);t.after(()=>{child.close();outside.close();});
 const started=performance.now();root.stdin.end('quit\n');const facts=await root.waitForExitAndDrain({timeoutMs:5000});
 assert.equal(facts.jobEmptyObserved,true);assert.equal(facts.leaderExitCode,0);assert.ok(performance.now()-started<4000,'force exit exceeded its independent deadline');await exited(child);assert.equal(outside.snapshot().state,'running');
});
