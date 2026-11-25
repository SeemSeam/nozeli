// Real native stdin custody. All processes/files are isolated synthetic fixtures.
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
import {startExperimentalProcessSupervisor as start,connectExperimentalProcessSupervisor as connect,experimentalSupervisorEndpoint as endpoint} from '../src/platform/windows/experimental-process-supervisor.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:90000};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const environment=root=>({SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})});
async function until(fn){const deadline=performance.now()+25000;for(;;){const value=await fn();if(value)return value;if(performance.now()>deadline)assert.fail('Input custody fixture timeout');await delay(5);}}
async function retained(pin){const rows=[];let offset=0;for(;;){const range=pin.readInput(offset);if(range.state==='eof')return Buffer.concat(rows);assert.equal(range.state,'data');rows.push(range.bytes);offset+=range.bytes.length;}}
async function collect(stream){const bytes=[];for await(const chunk of stream)bytes.push(chunk);return Buffer.concat(bytes);}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli input 中文 ')),children=[],transports=[],pins=[];
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'close');child.kill();await ended;}
    for(const child of transports){try{if(!child.lease.snapshot().jobEmptyObserved)child.terminate();await child.waitForJobEmpty();child.close();}catch(error){if(error.code!=='PROCESS_JOB_CLOSED')throw error;}}
    const unique=new Map();for(const pin of pins){const record=endpoint(pin);unique.set(record.supervisorPid+':'+record.supervisorCreationTime100ns,pin);}
    for(const pin of unique.values())await until(()=>{try{pin.shutdown();return true;}catch(error){if(error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===170)return false;throw error;}});
    for(const pin of pins)pin.close();await fs.rm(root,{recursive:true,force:true});
  });
  const launch=code=>{const child=prepare({command:process.execPath,args:['-e',code],cwd:root,env:Object.entries(environment(root)).map(([k,v])=>k+'='+v)});transports.push(child);return child;};
  const supervise=child=>{const pin=start(child.lease);pins.push(pin);child.attachSupervisor(pin);return pin;};
  return {root,children,transports,pins,launch,supervise};
}

test('original helper retains exact multiMiB Unicode/binary input and confirmed native byte counts',native,async t=>{
  const f=await fixture(t),child=f.launch('process.stdin.pipe(process.stdout)'),pin=f.supervise(child);
  assert.equal(endpoint(pin).inputCustodyVerified,true);
  for(const name of ['writeInput','pollInput','closeInput','abortInput'])assert.throws(()=>child.lease[name](Buffer.from('bypass')),{code:'PROCESS_INPUT_SUPERVISED'});
  for(const value of [-1,0.5,NaN,'0',67108865])assert.throws(()=>pin.readInput(value),{code:'SUPERVISOR_INPUT_RANGE'});
  for(const value of [null,'text',Buffer.alloc(0),Buffer.alloc(65537)])assert.throws(()=>pin.writeInput(value),{code:'SUPERVISOR_INPUT_RANGE'});
  assert.throws(()=>pin.readInput.call({},0),{code:'SUPERVISOR_RECEIVER'});
  const bytes=Buffer.concat([Buffer.from('原宿主输入 😀\n'),Buffer.alloc(2*1024*1024+37,91)]),output=collect(child.stdout),error=collect(child.stderr);
  child.resume();child.stdin.end(bytes);assert.equal(sha(await output),sha(bytes));await error;await child.waitForExitAndDrain();
  const facts=pin.snapshot();assert.equal(facts.inputClosed,true);assert.equal(facts.inputPending,false);assert.equal(facts.inputError,0);
  assert.equal(facts.inputBytes,bytes.length);assert.equal(facts.inputCompletedBytes,bytes.length);assert.equal(facts.inputSha256,sha(bytes));
  assert.equal(sha(await retained(pin)),sha(bytes));const second=connect(endpoint(pin));f.pins.push(second);assert.equal(sha(await retained(second)),sha(bytes));
  assert.throws(()=>connect({...endpoint(pin),inputCustodyVerified:false}),{code:'SUPERVISOR_INPUT_UNVERIFIED'});
});

test('handoff refuses any prior direct stdin write or close',native,async t=>{
  const f=await fixture(t);
  const written=f.launch('process.stdin.resume()');written.lease.writeInput(Buffer.from('before custody'));
  assert.throws(()=>start(written.lease),{code:'SUPERVISOR_INPUT_UNVERIFIED'});
  const closed=f.launch('process.stdin.resume()');closed.lease.closeInput();assert.throws(()=>start(closed.lease),{code:'SUPERVISOR_INPUT_UNVERIFIED'});
});

test('backpressured original writes retain UNKNOWN on abort and cannot be duplicated',native,async t=>{
  const f=await fixture(t),child=f.launch("process.stdin.pause();setInterval(()=>process.stdout.write('tick'),10)"),pin=f.supervise(child);child.stdout.resume();child.stderr.resume();child.resume();
  let result;for(let turn=0;turn<16;turn++){result=pin.writeInput(Buffer.alloc(65536,70));if(result.state==='pending')break;}
  assert.equal(result.state,'pending');assert.throws(()=>pin.writeInput(Buffer.from('duplicate')),{code:'SUPERVISOR_INPUT_UNCONFIRMED'});
  const before=pin.snapshot();assert.equal(before.inputPending,true);await until(()=>pin.snapshot().stdoutBytes>0);
  pin.abortInput();const after=pin.snapshot();assert.equal(after.inputClosed,true);assert.notEqual(after.inputError,0);assert.ok(after.inputBytes>=after.inputCompletedBytes);
  assert.throws(()=>pin.writeInput(Buffer.from('retry')),{code:'SUPERVISOR_INPUT_UNCONFIRMED'});
  child.terminate();await child.waitForJobEmpty();assert.throws(()=>pin.readInput(after.inputBytes),{code:'SUPERVISOR_INPUT_UNCONFIRMED'});
});

test('the input lifetime bound terminates the original Job and never turns overflow into a complete stream',native,async t=>{
  const f=await fixture(t),child=f.launch('process.stdin.resume();setInterval(()=>{},1000)'),pin=f.supervise(child);child.stdout.resume();child.stderr.resume();child.resume();
  const chunk=Buffer.alloc(65536,64);let admitted=0;
  while(admitted<67108864){let result=pin.writeInput(chunk);while(result.state==='pending'){await delay(1);result=pin.pollInput();}assert.equal(result.bytes,chunk.length);admitted+=result.bytes;}
  assert.throws(()=>pin.writeInput(Buffer.from('overflow')),error=>error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===111);
  await child.waitForJobEmpty();const facts=pin.snapshot();assert.equal(facts.inputBytes,67108864);assert.equal(facts.inputError,111);
  assert.throws(()=>pin.readInput(facts.inputBytes),error=>error.code==='SUPERVISOR_INPUT_UNCONFIRMED'&&error.win32Code===111);
});

test('a different process can inspect input but cannot write, close or abort even with the original endpoint',native,async t=>{
  const f=await fixture(t),child=f.launch('process.stdin.pipe(process.stdout)'),pin=f.supervise(child),script=path.join(f.root,'observer.mjs');child.stdout.resume();child.stderr.resume();child.resume();
  const module=new URL('../src/platform/windows/experimental-process-supervisor.mjs',import.meta.url).href;
  await fs.writeFile(script,`import assert from 'node:assert/strict';import {connectExperimentalProcessSupervisor as connect} from ${JSON.stringify(module)};
    const record=JSON.parse(process.argv[2]);for(const method of ['writeInput','closeInput','abortInput']){const pin=connect(record);try{assert.equal(pin.snapshot().inputCustodyVerified,true);assert.throws(()=>pin[method](Buffer.from('foreign')),e=>e.code==='SUPERVISOR_REQUEST_REFUSED'&&e.win32Code===5);}finally{pin.close();}}console.log('foreign controls refused');`);
  const observer=spawn(process.execPath,[script,JSON.stringify(endpoint(pin))],{env:environment(f.root),stdio:['ignore','pipe','pipe'],windowsHide:true});f.children.push(observer);
  let stdout='',stderr='';observer.stdout.on('data',b=>stdout+=b);observer.stderr.on('data',b=>stderr+=b);const result=await once(observer,'close');assert.equal(result[0],0,stderr);assert.match(stdout,/foreign controls refused/);
  assert.equal(pin.snapshot().inputBytes,0);child.stdin.end('original only');await child.waitForExitAndDrain();assert.equal((await retained(pin)).toString(),'original only');
});

test('a lost input IPC reply leaves original bytes once and refuses stale-offset resend',native,async t=>{
  const f=await fixture(t),marker=path.join(f.root,'received'),child=f.launch(`let value='';process.stdin.on('data',b=>{value+=b.toString();require('fs').writeFileSync(${JSON.stringify(marker)},value)});setInterval(()=>{},1000);`),pin=f.supervise(child);
  const peer=net.createConnection(endpoint(pin).pipe);peer.on('error',()=>{});t.after(()=>peer.destroy());await once(peer,'connect');
  const bytes=Buffer.from('one original request\n'),request=Buffer.alloc(32);request.writeUInt32LE(0x4e5a5331,0);request.writeUInt32LE(10,4);request.writeUInt32LE(5,8);request.writeUInt32LE(bytes.length,20);
  await new Promise((resolve,reject)=>peer.write(request,error=>error?reject(error):resolve()));await new Promise((resolve,reject)=>peer.write(bytes,error=>error?reject(error):resolve()));peer.destroy();
  child.stdout.resume();child.stderr.resume();child.resume();
  await until(async()=>{try{return (await fs.readFile(marker)).equals(bytes);}catch(error){if(error.code!=='ENOENT')throw error;}});
  assert.throws(()=>pin.writeInput(bytes),error=>error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===87);
  assert.throws(()=>pin.writeInput(bytes),{code:'SUPERVISOR_INPUT_UNCONFIRMED'});assert.equal(pin.snapshot().inputBytes,bytes.length);
  child.terminate();await child.waitForJobEmpty();await until(()=>pin.snapshot().inputClosed);assert.equal((await retained(pin)).toString(),bytes.toString());assert.equal((await fs.readFile(marker)).toString(),bytes.toString());
});

for(const mode of ['normal','forced'])test(`${mode} host death seals original input and refuses cold observer control writes`,native,async t=>{
  const f=await fixture(t),script=path.join(f.root,'host.mjs'),ready=path.join(f.root,'ready.json'),exit=path.join(f.root,'exit'),module=relative=>new URL(relative,import.meta.url).href;
  await fs.writeFile(script,`import fs from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';import {prepareExperimentalProcessTransport as prepare} from ${JSON.stringify(module('../src/platform/windows/experimental-process-transport.mjs'))};
    import {startExperimentalProcessSupervisor as start,experimentalSupervisorEndpoint as endpoint} from ${JSON.stringify(module('../src/platform/windows/experimental-process-supervisor.mjs'))};
    const i=JSON.parse(process.argv[2]),child=prepare({command:process.execPath,args:['-e',"process.stdin.resume();setInterval(()=>{},1000)"],cwd:i.root,env:i.env}),pin=start(child.lease);child.attachSupervisor(pin);child.stdout.resume();child.stderr.resume();child.resume();
    await new Promise((resolve,reject)=>child.stdin.write('original host 中文 😀\\n',e=>e?reject(e):resolve()));await fs.writeFile(i.ready,JSON.stringify(endpoint(pin)));for(;;){try{await fs.stat(i.exit);process.exit(91);}catch(e){if(e.code!=='ENOENT')throw e;}await delay(5);}`);
  const env=environment(f.root),host=spawn(process.execPath,[script,JSON.stringify({root:f.root,ready,exit,env:Object.entries(env).map(([k,v])=>k+'='+v)})],{env,stdio:['ignore','ignore','pipe'],windowsHide:true});f.children.push(host);let diagnostics='';host.stderr.on('data',b=>diagnostics+=b);
  const record=await until(async()=>{try{return JSON.parse(await fs.readFile(ready,'utf8'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;assert.equal(host.exitCode,null,diagnostics);}});
  const ended=once(host,'close');if(mode==='normal')await fs.writeFile(exit,'exit');else host.kill();await ended;
  const pin=connect(record);f.pins.push(pin);await until(()=>{const facts=pin.snapshot();return facts.hostExited&&facts.jobEmptyObserved&&facts.inputClosed;});
  const facts=pin.snapshot();assert.equal(facts.inputError,0);assert.equal(facts.inputBytes,facts.inputCompletedBytes);assert.equal((await retained(pin)).toString(),'original host 中文 😀\n');assert.equal(facts.inputSha256,sha(await retained(pin)));
  assert.throws(()=>pin.closeInput(),e=>e.code==='SUPERVISOR_REQUEST_REFUSED'&&e.win32Code===5);
  assert.throws(()=>pin.writeInput(Buffer.from('cold replay')),e=>e.code==='SUPERVISOR_REQUEST_REFUSED'&&e.win32Code===5);
  assert.equal(pin.snapshot().inputBytes,facts.inputBytes);assert.equal(facts.coldRecoveryQualified,false);
});
