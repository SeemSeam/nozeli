import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareExperimentalProcessTransport as prepare} from '../src/platform/windows/experimental-process-transport.mjs';
import {createExperimentalProcessJob as create,waitExperimentalJobEmpty as wait} from '../src/platform/windows/experimental-process-job.mjs';
import {startExperimentalProcessSupervisor as start,connectExperimentalProcessSupervisor as connect,experimentalSupervisorEndpoint as endpoint} from '../src/platform/windows/experimental-process-supervisor.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:45000};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const environment=root=>({SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})});
async function until(fn){const deadline=performance.now()+20000;for(;;){const value=await fn();if(value)return value;if(performance.now()>deadline)assert.fail('Output fixture observation timeout');await delay(5);}}
async function collect(stream){const bytes=[];for await(const chunk of stream)bytes.push(chunk);return Buffer.concat(bytes);}
async function retained(pin,channel){
  const bytes=[];let offset=0;
  await until(()=>{const result=pin.readOutput(channel,offset);if(result.state==='eof')return true;if(result.state==='data'){bytes.push(result.bytes);offset+=result.bytes.length;}return false;});
  return Buffer.concat(bytes);
}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli output 中文 ')),children=[],transports=[],pins=[],jobs=[];
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}
    for(const child of transports){try{if(!child.lease.snapshot().jobEmptyObserved)child.terminate();await child.waitForJobEmpty();child.close();}catch(error){if(error.code!=='PROCESS_JOB_CLOSED')throw error;}}
    for(const job of jobs){job.terminate();await wait(job);job.close();}
    const endpoints=new Map(pins.map(pin=>[pin,endpoint(pin)])),stopped=new Set();
    for(const pin of pins.reverse()){
      const record=endpoints.get(pin),key=record.supervisorPid+':'+record.supervisorCreationTime100ns;
      if(!stopped.has(key)){await until(()=>{try{pin.shutdown();return true;}catch(error){if(error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===170)return false;throw error;}});stopped.add(key);}
      pin.close();
    }
    await fs.rm(root,{recursive:true,force:true});
  });
  const launch=(code,args=[])=>{const child=prepare({command:process.execPath,args:['-e',code,...args],cwd:root,env:Object.entries(environment(root)).map(([k,v])=>k+'='+v)});transports.push(child);return child;};
  const supervise=child=>{const pin=start(child.lease);pins.push(pin);child.attachSupervisor(pin);return pin;};
  return {root,children,transports,pins,jobs,launch,supervise};
}

test('supervised transport preserves Unicode/binary streams, exact EOF/digests and independent immutable range readers',native,async t=>{
  const f=await fixture(t),size=4*1024*1024+17,child=f.launch(`process.stdin.pipe(process.stdout);process.stderr.write('诊断 😀\\n');`),pin=f.supervise(child);
  assert.equal(endpoint(pin).outputCustodyVerified,true);
  assert.throws(()=>child.lease.readOutput(1),{code:'PROCESS_OUTPUT_SUPERVISED'});
  const bytes=Buffer.alloc(size);for(let i=0;i<size;i++)bytes[i]=i%251;
  const output=collect(child.stdout),diagnostic=collect(child.stderr);child.resume();child.stdin.end(bytes);
  assert.equal(sha(await output),sha(bytes));assert.equal((await diagnostic).toString(),'诊断 😀\n');await child.waitForExitAndDrain();
  const facts=pin.snapshot();assert.equal(facts.outputError,0);assert.equal(facts.stdoutEOF,true);assert.equal(facts.stderrEOF,true);
  assert.equal(facts.stdoutBytes,size);assert.equal(facts.stdoutSha256,sha(bytes));assert.equal(facts.stderrSha256,sha(Buffer.from('诊断 😀\n')));
  assert.equal(sha(await retained(pin,1)),sha(bytes));
  const second=connect(endpoint(pin));f.pins.push(second);
  assert.equal(sha(await retained(second,1)),sha(bytes));assert.equal((await retained(second,2)).toString(),'诊断 😀\n');
});

test('supervisor drains both outputs without a host consumer and closes neither early',native,async t=>{
  const f=await fixture(t),size=2*1024*1024+31,child=f.launch(`process.stdout.write(Buffer.alloc(${size},65));process.stderr.write(Buffer.alloc(${size},66));`),pin=f.supervise(child);
  child.resume();child.stdin.end();await child.waitForJobEmpty();
  await until(()=>{const facts=pin.snapshot();return facts.stdoutEOF&&facts.stderrEOF;});
  assert.equal(child.stdout.readableEnded,false);assert.equal(child.stderr.readableEnded,false);
  const [out,err]=await Promise.all([collect(child.stdout),collect(child.stderr)]);
  assert.equal(out.length,size);assert.ok(out.every(byte=>byte===65));assert.equal(err.length,size);assert.ok(err.every(byte=>byte===66));
  await child.waitForExitAndDrain();
});

test('a descendant-held output remains pending after leader exit and retains its actual tail',native,async t=>{
  const f=await fixture(t),helper=path.resolve(import.meta.dirname,'../native/windows-process/build/Release/nozeli_process_fixture.exe');
  const child=prepare({command:helper,args:['spawn-stdio-tail',path.join(f.root,'tail-ready')],cwd:f.root,env:Object.entries(environment(f.root)).map(([k,v])=>k+'='+v)});f.transports.push(child);const pin=f.supervise(child);
  child.resume();child.stdin.end();await until(()=>child.lease.snapshot().leaderState==='exited');
  const early=pin.snapshot();assert.equal(early.stdoutEOF,false);assert.equal(early.jobEmptyObserved,false);
  assert.throws(()=>pin.shutdown(),error=>error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===170);
  assert.equal((await collect(child.stdout)).toString(),'leader head\ndescendant tail');await collect(child.stderr);await child.waitForExitAndDrain();
  assert.equal(pin.snapshot().stdoutSha256,sha(Buffer.from('leader head\ndescendant tail')));
});

for(const mode of ['normal','forced'])test(`${mode} host death preserves unread output and exact EOF in the original helper without replay`,native,async t=>{
  const f=await fixture(t),script=path.join(f.root,'host.mjs'),ready=path.join(f.root,'ready.json'),marker=path.join(f.root,'written'),stop=path.join(f.root,'stop');
  const module=relative=>new URL(relative,import.meta.url).href;
  await fs.writeFile(script,`import fs from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
    import {prepareExperimentalProcessTransport as prepare} from ${JSON.stringify(module('../src/platform/windows/experimental-process-transport.mjs'))};
    import {startExperimentalProcessSupervisor as start,experimentalSupervisorEndpoint as endpoint} from ${JSON.stringify(module('../src/platform/windows/experimental-process-supervisor.mjs'))};
    const i=JSON.parse(process.argv[2]),child=prepare({command:process.execPath,args:['-e',"process.stdout.write('tail 中文 😀');process.stderr.write('unread diagnostic');require('fs').writeFileSync(process.argv[1],'written');setInterval(()=>{},1000);",i.marker],cwd:i.root,env:i.env}),pin=start(child.lease);child.attachSupervisor(pin);child.resume();
    await fs.writeFile(i.ready,JSON.stringify(endpoint(pin)));for(;;){try{await fs.stat(i.stop);process.exit(91);}catch(e){if(e.code!=='ENOENT')throw e;}await delay(5);}`);
  const env=environment(f.root),child=spawn(process.execPath,[script,JSON.stringify({root:f.root,ready,marker,stop,env:Object.entries(env).map(([k,v])=>k+'='+v)})],{env,stdio:['ignore','ignore','pipe'],windowsHide:true});f.children.push(child);
  let diagnostics='';child.stderr.on('data',bytes=>diagnostics+=bytes);
  const record=await until(async()=>{try{await fs.stat(marker);return JSON.parse(await fs.readFile(ready,'utf8'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;assert.equal(child.exitCode,null,diagnostics);}});
  const end=once(child,'exit');if(mode==='normal')await fs.writeFile(stop,'stop');else child.kill();await end;
  const pin=connect(record);f.pins.push(pin);await until(()=>{const facts=pin.snapshot();return facts.hostExited&&facts.jobEmptyObserved&&facts.stdoutEOF&&facts.stderrEOF;});
  assert.equal((await retained(pin,1)).toString(),'tail 中文 😀');assert.equal((await retained(pin,2)).toString(),'unread diagnostic');
  const before=pin.snapshot();await retained(pin,1);assert.equal(pin.snapshot().stdoutBytes,before.stdoutBytes);assert.equal(before.coldRecoveryQualified,false);
});

test('output handoff rejects prior reads, forged endpoints, invalid ranges and duplicate attachment',native,async t=>{
  const f=await fixture(t),child=f.launch('setInterval(()=>{},1000)'),pin=f.supervise(child);
  assert.throws(()=>child.attachSupervisor(pin),{code:'PROCESS_OUTPUT_SUPERVISED'});
  assert.throws(()=>connect({...endpoint(pin),outputCustodyVerified:false}),{code:'SUPERVISOR_OUTPUT_UNVERIFIED'});
  for(const [channel,offset] of [[0,0],[3,0],['1',0],[1,-1],[1,0.5],[1,NaN],[1,67108865]])
    assert.throws(()=>pin.readOutput(channel,offset),{code:'SUPERVISOR_OUTPUT_RANGE'});
  assert.throws(()=>pin.readOutput(1,1),{code:'SUPERVISOR_REQUEST_REFUSED'});
  assert.throws(()=>pin.readOutput.call({},1,0),{code:'SUPERVISOR_RECEIVER'});
  const other=f.launch('setInterval(()=>{},1000)');assert.equal(other.lease.readOutput(1).state,'pending');
  assert.throws(()=>start(other.lease),{code:'SUPERVISOR_OUTPUT_UNVERIFIED'});
  const job=create({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:f.root,env:Object.entries(environment(f.root)).map(([k,v])=>k+'='+v)});f.jobs.push(job);
  const noOutput=start(job);f.pins.push(noOutput);assert.equal(noOutput.snapshot().outputCustodyVerified,false);
  assert.throws(()=>noOutput.readOutput(1,0),{code:'SUPERVISOR_OUTPUT_UNAVAILABLE'});
});

test('the lifetime output bound stops the original Job and never claims complete output after overflow',native,async t=>{
  const f=await fixture(t),child=f.launch(`let count=0;function send(){while(count<1025){count++;if(!process.stdout.write(Buffer.alloc(65536,90)))return process.stdout.once('drain',send);}setInterval(()=>{},1000);}send();`),pin=f.supervise(child);
  child.resume();child.stdin.end();await until(()=>pin.snapshot().outputError!==0);await child.waitForJobEmpty();
  const facts=pin.snapshot();assert.equal(facts.outputError,111);assert.ok(facts.stdoutBytes<=facts.outputLimitBytes);assert.ok(BigInt(facts.stdoutObservedBytes)>BigInt(facts.stdoutBytes));
  assert.throws(()=>pin.readOutput(1,facts.stdoutBytes),error=>error.code==='SUPERVISOR_OUTPUT_UNCONFIRMED'&&error.win32Code===111);
  assert.equal(facts.coldRecoveryQualified,false);
});

test('empty retained streams have real EOF and the SHA-256 of zero bytes',native,async t=>{
  const f=await fixture(t),child=f.launch('process.exit(0)'),pin=f.supervise(child);child.resume();child.stdin.end();
  await child.waitForJobEmpty();await until(()=>{const facts=pin.snapshot();return facts.stdoutEOF&&facts.stderrEOF;});
  const facts=pin.snapshot();assert.equal(facts.stdoutBytes,0);assert.equal(facts.stderrBytes,0);assert.equal(facts.stdoutSha256,sha(Buffer.alloc(0)));assert.equal(facts.stderrSha256,facts.stdoutSha256);assert.equal(facts.outputError,0);
});

test('a stalled IPC peer cannot block output draining or the actual child exit',native,async t=>{
  const f=await fixture(t),size=2*1024*1024,child=f.launch(`process.stdout.write(Buffer.alloc(${size},77));process.stderr.write('tail');`),pin=f.supervise(child);
  const peer=net.createConnection(endpoint(pin).pipe);peer.on('error',()=>{});t.after(()=>peer.destroy());await once(peer,'connect');
  child.resume();child.stdin.end();await child.waitForJobEmpty({timeoutMs:1500});peer.destroy();
  await until(()=>{const facts=pin.snapshot();return facts.stdoutEOF&&facts.stderrEOF;});
  const facts=pin.snapshot();assert.equal(facts.stdoutBytes,size);assert.equal(facts.stderrSha256,sha(Buffer.from('tail')));assert.equal(facts.outputError,0);
});

test('helper loss refuses output confirmation and retains transport errors even after the original Job exits',native,async t=>{
  const f=await fixture(t),child=f.launch('setInterval(()=>{},1000)'),pin=f.supervise(child),record=endpoint(pin);child.resume();
  process.kill(record.supervisorPid);
  await until(()=>{try{pin.snapshot();return false;}catch(error){return error.code==='SUPERVISOR_IDENTITY_UNVERIFIED';}});
  child.stdout.resume();child.stderr.resume();await until(()=>child.errors.length>0);
  child.terminate();await child.waitForJobEmpty();
  await assert.rejects(child.waitForExitAndDrain(),{code:'PROCESS_TRANSPORT_UNCONFIRMED'});
  assert.equal(child.stdout.readableEnded,false);assert.equal(child.stderr.readableEnded,false);
  pin.close();f.pins.splice(f.pins.indexOf(pin),1);
});
