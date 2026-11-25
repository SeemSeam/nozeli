import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {prepareExperimentalProcessTransport as prepare} from '../src/platform/windows/experimental-process-transport.mjs';
import {createExperimentalProcessJob as create,waitExperimentalJobEmpty} from '../src/platform/windows/experimental-process-job.mjs';
import {createJsonlReader} from '../src/agents/managed/jsonl-reader.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {spawn} from 'node:child_process';
import {openExperimentalProcessIdentity} from '../src/platform/windows/experimental-process-identity.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:20000};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function until(fn){const end=performance.now()+7000;for(;;){const value=await fn();if(value)return value;if(performance.now()>=end)assert.fail('fixture observation timeout');await delay(10);}}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli stdio 中文 ')),transports=[],cleanups=[],reads=[];
  const env=[`SystemRoot=${process.env.SystemRoot}`,`TEMP=${root}`,`TMP=${root}`,...(process.versions.electron?['ELECTRON_RUN_AS_NODE=1']:[])];
  t.after(async()=>{
    const errors=[];
    for(const cleanup of cleanups)try{await cleanup();}catch(error){errors.push(error);}
    for(const transport of transports)try{
      if(!transport.lease.snapshot().jobEmptyObserved)transport.terminate();
      await transport.waitForJobEmpty();transport.close();
    }catch(error){if(error.code!=='PROCESS_JOB_CLOSED')errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Retain fixture on unconfirmed transport cleanup');
    for(const read of reads)read.close();
    await fs.rm(root,{recursive:true,force:true});
  });
  const launchExecutable=(command,args)=>{const transport=prepare({command,args,cwd:root,env});transports.push(transport);return transport;};
  return {root,env,launchExecutable,cleanup:fn=>cleanups.push(fn),read(pid){const read=openExperimentalProcessIdentity(pid);reads.push(read);return read;},launch(code,args=[]){return launchExecutable(process.execPath,['-e',code,...args]);}};
}
async function collect(stream){const bytes=[];for await(const part of stream)bytes.push(part);return Buffer.concat(bytes);}
const ignore=stream=>{stream.resume();return finished(stream);};
const waitCode='setInterval(()=>{},1000);setTimeout(()=>process.exit(88),12000);';

test('joint exit requires actual stdout and stderr EOF and never discards unread diagnostics',native,async t=>{
  const f=await fixture(t),child=f.launch(`process.stdout.write('out');process.stderr.write('tail diagnostic');`),output=collect(child.stdout);child.resume();child.stdin.end();
  await child.waitForJobEmpty();await assert.rejects(child.waitForExitAndDrain({timeoutMs:20}),{code:'PROCESS_DRAIN_UNCONFIRMED'});
  assert.equal(child.stderr.readableEnded,false);const diagnostic=await collect(child.stderr);assert.equal(diagnostic.toString(),'tail diagnostic');assert.equal((await output).toString(),'out');
  const facts=await child.waitForExitAndDrain();assert.equal(facts.stdoutEOF,true);assert.equal(facts.stderrEOF,true);assert.equal(facts.inputDrained,true);
});

test('shared pending reply survives leader exit until the final native pipe frame is consumed',native,async t=>{
  const f=await fixture(t),child=f.launch(`require('readline').createInterface({input:process.stdin}).once('line',line=>{const request=JSON.parse(line);process.stdout.write(JSON.stringify({id:request.id,result:{tail:true}})+'\\n',()=>process.exit(0));});`),session=new PiSession({role:'worker',home:f.root,cwd:f.root});session.child=child;session.observeOwnerChild(child);
  child.stdout.pause();child.resume();const reply=session.request('tail',{},5000);reply.catch(()=>{});await session.exitPromise;assert.equal(session.pending.size,1);
  child.stdout.resume();assert.deepEqual(await reply,{tail:true});await child.waitForExitAndDrain();assert.equal(session.protocolReader.completed,true);
});

test('prepared standard pipes transfer Unicode input and separate stdout/stderr only after resume',native,async t=>{
  const f=await fixture(t),child=f.launch(`process.stdin.on('data',b=>{process.stdout.write(b);process.stderr.write('诊断\\n');});`);
  const output=collect(child.stdout),diagnostic=collect(child.stderr);
  const text='synthetic 中文 😀\n';child.stdin.end(text);
  assert.equal(child.lease.snapshot().state,'prepared');
  child.resume();assert.equal((await output).toString(),text);assert.equal((await diagnostic).toString(),'诊断\n');
  const facts=await child.waitForJobEmpty();assert.equal(facts.stdio,'explicit-handle-list');assert.equal(facts.leaderExitCode,0);
  child.close();child.close();assert.equal(child.errors.length,0);
});

test('binary input larger than native chunks roundtrips exactly and obeys writable backpressure',native,async t=>{
  const f=await fixture(t),child=f.launch('process.stdin.pipe(process.stdout);');
  const bytes=Buffer.alloc(4*1024*1024+17);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  const output=collect(child.stdout),stderr=ignore(child.stderr);child.resume();
  const accepted=child.stdin.write(bytes);assert.equal(accepted,false);child.stdin.end();
  const received=await output;await stderr;await child.waitForJobEmpty();
  assert.equal(received.length,bytes.length);assert.equal(hash(received),hash(bytes));assert.equal(child.errors.length,0);
});

test('large simultaneous stdout/stderr drain without blocking the JS event loop or each other',native,async t=>{
  const f=await fixture(t),size=2*1024*1024+31;
  const child=f.launch(`process.stdout.write(Buffer.alloc(${size},65));process.stderr.write(Buffer.alloc(${size},66));`);
  const output=collect(child.stdout),error=collect(child.stderr);let ticks=0;
  const interval=setInterval(()=>ticks++,1);t.after(()=>clearInterval(interval));child.resume();child.stdin.end();
  const [a,b]=await Promise.all([output,error]);await child.waitForJobEmpty();
  assert.equal(a.length,size);assert.equal(b.length,size);assert.ok(a.every(byte=>byte===65));assert.ok(b.every(byte=>byte===66));assert.ok(ticks>1);
});

test('empty writes and explicit stdin EOF finish normally without a phantom input byte',native,async t=>{
  const f=await fixture(t),child=f.launch(`let size=0;process.stdin.on('data',b=>size+=b.length);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({size})));`);
  const output=collect(child.stdout),stderr=ignore(child.stderr);child.resume();child.stdin.write(Buffer.alloc(0));child.stdin.end();
  assert.deepEqual(JSON.parse((await output).toString()),{size:0});await stderr;await child.waitForJobEmpty();
});

test('readable backpressure limits buffered output until the consumer resumes',native,async t=>{
  const f=await fixture(t),size=3*1024*1024;
  const child=f.launch(`process.stdout.write(Buffer.alloc(${size},90));`);const stderr=ignore(child.stderr);child.resume();child.stdin.end();
  child.stdout.read(0);await delay(100);
  assert.ok(child.stdout.readableLength<=128*1024,`buffered=${child.stdout.readableLength}`);
  const bytes=await collect(child.stdout);assert.equal(bytes.length,size);assert.ok(bytes.every(byte=>byte===90));
  await stderr;await child.waitForJobEmpty();
});

test('leader exit does not close output still held by a live inherited descendant',native,async t=>{
  const f=await fixture(t),helper=path.resolve(import.meta.dirname,'../native/windows-process/build/Release/nozeli_process_fixture.exe');
  const child=f.launchExecutable(helper,['spawn-stdio-tail',path.join(f.root,'tail-ready')]),output=collect(child.stdout),stderr=ignore(child.stderr),exit=once(child,'exit');
  child.resume();child.stdin.end();await exit;
  assert.equal(child.stdout.readableEnded,false);
  assert.equal((await output).toString(),'leader head\ndescendant tail');await stderr;await child.waitForJobEmpty();
});

test('terminating a process with a pending stdout read yields EOF and confirmed Job exit',native,async t=>{
  const f=await fixture(t),child=f.launch(waitCode);const out=collect(child.stdout),err=collect(child.stderr);
  child.resume();await delay(40);child.terminate();
  assert.equal((await out).length,0);assert.equal((await err).length,0);
  assert.equal((await child.waitForJobEmpty()).leaderState,'exited');
});

test('a blocked stdin write fails on termination and never reports successful replay',native,async t=>{
  const f=await fixture(t),child=f.launch(waitCode);const out=ignore(child.stdout),err=ignore(child.stderr);
  child.resume();const completion=new Promise(resolve=>child.stdin.write(Buffer.alloc(2*1024*1024,1),error=>resolve(error)));
  await delay(80);child.terminate();const error=await completion;
  assert.ok(error);assert.match(error.code,/PROCESS_STDIN_WRITE_FAILED/);assert.equal(error.transferUnconfirmed,true);
  await Promise.all([out,err]);await child.waitForJobEmpty();
});

test('destroying a blocked input cancels its exact operation and callback without blocking timers',native,async t=>{
  const f=await fixture(t),child=f.launch(waitCode);child.stdout.resume();child.stderr.resume();child.resume();
  const completion=new Promise(resolve=>child.stdin.write(Buffer.alloc(1024*1024),error=>resolve(error)));
  await delay(40);let tick=false;const timer=setTimeout(()=>tick=true,10);t.after(()=>clearTimeout(timer));
  child.stdin.destroy();const error=await completion;
  assert.equal(error.code,'PROCESS_STDIN_ABORTED');assert.equal(error.transferUnconfirmed,true);
  await delay(20);assert.equal(tick,true);child.terminate();await child.waitForJobEmpty();
});

test('closing output explicitly breaks the actual child writer while preserving the Job lease',native,async t=>{
  const f=await fixture(t),marker=path.join(f.root,'broken.json');
  const code=`const fs=require('node:fs');process.stdout.on('error',e=>{fs.writeFileSync(process.argv[1],JSON.stringify({code:e.code}));process.exit(0);});
    setInterval(()=>process.stdout.write(Buffer.alloc(65536)),10);`;
  const child=f.launch(code,[marker]);child.stderr.resume();child.resume();child.stdin.end();child.stdout.destroy();
  await until(async()=>{try{return JSON.parse(await fs.readFile(marker,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return false;throw error;}});
  const facts=await child.waitForJobEmpty();assert.equal(facts.leaderExitCode,0);assert.ok(['EPIPE','EOF'].includes(JSON.parse(await fs.readFile(marker,'utf8')).code));
});

test('pipe operations on an unpiped Job refuse without enabling implicit stdio',native,async t=>{
  const f=await fixture(t),lease=create({command:process.execPath,args:['-e',waitCode],cwd:f.root,env:f.env});
  try{
    assert.throws(()=>lease.readOutput(1),{code:'PROCESS_STDIO_DISABLED'});
    assert.throws(()=>lease.writeInput(Buffer.from('x')),{code:'PROCESS_STDIO_DISABLED'});
  }finally{lease.terminate();await waitExperimentalJobEmpty(lease);lease.close();}
});

test('native pipe API validates channels, buffer budget and receiver tags',native,async t=>{
  const f=await fixture(t),child=f.launch(waitCode),lease=child.lease;
  for(const channel of [0,3,1.5,'1',undefined])assert.throws(()=>lease.readOutput(channel),{code:'PROCESS_STDIO_CHANNEL'});
  for(const bytes of [Buffer.alloc(0),Buffer.alloc(65537),'text',null])assert.throws(()=>lease.writeInput(bytes),{code:'PROCESS_STDIO_BUFFER'});
  for(const name of ['readOutput','writeInput','pollInput','closeInput','abortInput','closeOutput'])
    assert.throws(()=>lease[name].call({}),{code:'PROCESS_JOB_RECEIVER'});
});

test('actual native pipes deliver fragmented UTF-8 replies through shared PiSession request correlation',native,async t=>{
  const f=await fixture(t),code=`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line),reply=Buffer.from(JSON.stringify({id:request.id,result:{text:request.params.text}})+'\\r\\n');
    let offset=0;const timer=setInterval(()=>{if(offset===reply.length){clearInterval(timer);process.exit(0);return;}process.stdout.write(reply.subarray(offset,++offset));},1);
    process.stdout.write(JSON.stringify({id:'late-unknown',result:'must-not-win'})+'\\n');});`;
  const child=f.launch(code),session=new PiSession({role:'worker',home:f.root,cwd:f.root});session.child=child;
  const failures=[],reader=createJsonlReader(child.stdout,{onFrame:frame=>session.receiveFrame(frame),onError:error=>failures.push(error)});
  t.after(()=>reader.close());child.stderr.resume();child.resume();
  const result=await session.request('synthetic-inspect',{text:'中文 😀 分帧'},5000);
  assert.deepEqual(result,{text:'中文 😀 分帧'});assert.equal(session.pending.size,0);
  await child.waitForJobEmpty();assert.equal(failures.length,0);
  // This invokes shared request/receive methods, not PiSession.start/owner admission.
});

for(const [name,code,reason] of [
  ['malformed then late valid frame',`process.stdout.write('{bad}\\n{"late":true}\\n');setInterval(()=>{},1000);`,'json'],
  ['oversized unfinished frame',`process.stdout.write('x'.repeat(257));setInterval(()=>{},1000);`,'frame-too-large'],
  ['truncated frame at natural exit',`process.stdout.write('{"partial":true}');`,'truncated'],
  ['invalid UTF-8',`process.stdout.write(Buffer.from([123,34,120,34,58,34,255,34,125,10]));setInterval(()=>{},1000);`,'utf8'],
])test('actual native JSONL '+name+' fences input and preserves an explicit error',native,async t=>{
  const f=await fixture(t),child=f.launch(code),frames=[],failures=[];
  const reader=createJsonlReader(child.stdout,{maxFrameBytes:256,onFrame:frame=>frames.push(frame),onError:error=>{failures.push(error);child.terminate();}});
  t.after(()=>reader.close());child.stderr.resume();child.resume();child.stdin.end();
  await until(()=>failures.length);await child.waitForJobEmpty();
  assert.equal(failures.length,1);assert.equal(failures[0].reason,reason);assert.equal(frames.length,0);
});

test('cancelling an actual partial-output process reports truncated JSONL rather than a complete reply',native,async t=>{
  const f=await fixture(t),child=f.launch(`process.stdout.write('{"id":"interrupted"');setInterval(()=>{},1000);`),failures=[];
  const reader=createJsonlReader(child.stdout,{onFrame:()=>assert.fail('partial output must not settle a reply'),onError:error=>failures.push(error)});
  t.after(()=>reader.close());child.stderr.resume();child.resume();child.stdin.end();
  await until(()=>reader.bufferedBytes>0);child.terminate();await child.waitForJobEmpty();await until(()=>failures.length);
  assert.equal(failures[0].reason,'truncated');assert.equal(failures.length,1);
});

for(const forced of [false,true])test('actual '+(forced?'forced':'normal')+' host exit with pending stdio closes the Job and running child',native,async t=>{
  const f=await fixture(t),receipt=path.join(f.root,'host.json');
  const moduleUrl=new URL('../src/platform/windows/experimental-process-transport.mjs',import.meta.url).href;
  const childCode=`process.stdout.write('ready');process.stdin.resume();setInterval(()=>process.stderr.write('diagnostic'),50);setTimeout(()=>process.exit(88),12000);`;
  const hostCode=`import(${JSON.stringify(moduleUrl)}).then(async({prepareExperimentalProcessTransport:prepare})=>{
    const fs=await import('node:fs');const child=globalThis.fixtureChild=prepare({command:process.execPath,args:['-e',${JSON.stringify(childCode)}],cwd:${JSON.stringify(f.root)},env:${JSON.stringify(f.env)}});
    child.stdout.once('data',()=>fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(child.lease.snapshot())));
    child.stderr.resume();child.resume();process.stdin.once('data',()=>process.exit(75));process.stdin.resume();
  }).catch(error=>{process.stderr.write(error.stack);process.exit(91);});`;
  const host=spawn(process.execPath,['-e',hostCode],{windowsHide:true,stdio:['pipe','pipe','pipe']}),exited=once(host,'exit'),closed=once(host,'close');
  let stderr='';host.stderr.on('data',bytes=>stderr+=bytes);
  f.cleanup(async()=>{if(host.exitCode===null&&host.signalCode===null)host.kill();await closed;assert.equal(stderr,'');});
  const before=await until(async()=>{try{return JSON.parse(await fs.readFile(receipt,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return false;throw error;}});
  const read=f.read(before.pid);assert.equal(read.snapshot().state,'running');assert.equal(before.stdio,'explicit-handle-list');
  if(forced)host.kill();else host.stdin.end('exit');
  const outcome=await exited;assert.deepEqual(outcome,forced?[null,'SIGTERM']:[75,null]);
  await until(()=>read.snapshot().state==='exited');t.diagnostic(JSON.stringify({forced,outcome,before,after:read.snapshot()}));
});
