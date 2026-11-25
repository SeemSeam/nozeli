import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createExperimentalProcessJob as create,waitExperimentalJobEmpty as waitEmpty} from '../src/platform/windows/experimental-process-job.mjs';
import {openExperimentalProcessIdentity as openIdentity} from '../src/platform/windows/experimental-process-identity.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:20000};
async function until(fn,{timeoutMs=5000}={}) {
  const end=performance.now()+timeoutMs;
  for(;;){const value=await fn();if(value)return value;if(performance.now()>=end)assert.fail('fixture observation timed out');await delay(20);}
}
async function exists(file){try{await fs.stat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli Job 中文 ')),jobs=[],reads=[];
  t.after(async()=>{
    const failures=[];
    for(const lease of jobs)try{
      if(!lease.snapshot().jobEmptyObserved)lease.terminate();
      await waitEmpty(lease);lease.close();
    }catch(error){if(error.code!=='PROCESS_JOB_CLOSED')failures.push(error);}
    for(const read of reads)read.close();
    if(failures.length)throw new AggregateError(failures,'Keep fixture paths when Job cleanup is unconfirmed');
    await fs.rm(root,{recursive:true,force:true});
  });
  const environment=[`SystemRoot=${process.env.SystemRoot}`,`TEMP=${root}`,`TMP=${root}`,
    ...(process.versions.electron?['ELECTRON_RUN_AS_NODE=1']:[])];
  return {root,environment,
    launchNative(command,args,env=environment){const lease=create({command,args,cwd:root,env});jobs.push(lease);return lease;},
    launch(code,{args=[],command=process.execPath,env=environment,cwd=root,stdio}={}){
      const lease=create({command,args:['-e',code,...args],cwd,env,stdio});jobs.push(lease);return lease;
    },
    read(pid){const lease=openIdentity(pid);reads.push(lease);return lease;},
  };
}
const waitCode=`setInterval(()=>{},1000);`;
const fixtureExecutable=path.resolve(import.meta.dirname,'../native/windows-process/build/Release/nozeli_process_fixture.exe');

test('created process is Job-bound and suspended until explicit resume',native,async t=>{
  const f=await fixture(t),marker=path.join(f.root,'executed.json');
  const lease=f.launch(`require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));`,{args:[marker]});
  const before=lease.snapshot();
  assert.equal(before.state,'prepared');assert.equal(before.resumed,false);
  assert.equal(before.activeProcesses,1);assert.equal(before.totalProcesses,1);
  assert.equal(before.launchMode,'attribute-job-list+suspended');
  assert.equal(before.jobHandleInheritable,false);assert.equal(before.breakawayAllowed,false);
  assert.equal(before.killOnJobClose,true);assert.equal(before.ownerRegistrationVerified,false);
  await delay(100);assert.equal(await exists(marker),false);
  assert.throws(()=>lease.close(),{code:'PROCESS_JOB_ACTIVE'});
  lease.resume();const ended=await waitEmpty(lease);
  assert.equal(ended.leaderExitCode,0);assert.equal(ended.jobEmptyObserved,true);
  assert.equal(JSON.parse(await fs.readFile(marker,'utf8')).pid,before.pid);
  lease.close();lease.close();assert.throws(()=>lease.snapshot(),{code:'PROCESS_JOB_CLOSED'});
  t.diagnostic(JSON.stringify({before,ended}));
});

test('a new console provides real TTYs and exits under retained Job custody',native,async t=>{
  const f=await fixture(t),out=path.join(f.root,'console.json'),release=path.join(f.root,'release');
  const literal='中文 空格 & %PATH% "quote" \\';
  const lease=f.launch(`
    const fs=require('node:fs');
    const tty=process.stdin.isTTY===true&&process.stdout.isTTY===true&&process.stderr.isTTY===true;
    process.stdin.setRawMode(true);
    const raw=process.stdin.isRaw;process.stdin.setRawMode(false);
    fs.writeFileSync(process.argv[1],JSON.stringify({tty,raw,restored:!process.stdin.isRaw,arg:process.argv[3]}),{flag:'wx'});
    const timer=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(timer);},20);
    setTimeout(()=>{if(!fs.existsSync(process.argv[2]))process.exitCode=2;clearInterval(timer);},8000).unref();
  `,{args:[out,release,literal],stdio:'new-console'});
  assert.equal(lease.snapshot().state,'prepared');
  assert.equal(await exists(out),false);
  lease.resume();
  await until(async()=>{
    if(!await exists(out))return false;
    const facts=lease.snapshot();
    return facts.activeProcesses>=2&&facts.allProcessIncarnationsObserved;
  });
  assert.deepEqual(JSON.parse(await fs.readFile(out,'utf8')),{tty:true,raw:true,restored:true,arg:literal});
  assert.throws(()=>lease.close(),{code:'PROCESS_JOB_ACTIVE'});
  await fs.writeFile(release,'',{flag:'wx'});
  const ended=await waitEmpty(lease);
  assert.equal(ended.leaderExitCode,0);
  assert.equal(ended.activeProcesses,0);
  assert.equal(ended.allProcessIncarnationsObserved,true);
  lease.close();
});

test('cancelling a prepared Job executes no user command and refuses later resume',native,async t=>{
  const f=await fixture(t),marker=path.join(f.root,'must-not-run');
  const lease=f.launch(`require('node:fs').writeFileSync(process.argv[1],'bad');`,{args:[marker]});
  lease.terminate();const stopped=await waitEmpty(lease);
  assert.equal(stopped.resumed,false);assert.equal(stopped.jobEmptyObserved,true);
  assert.equal(await exists(marker),false);
  assert.throws(()=>lease.resume(),{code:'PROCESS_JOB_RESUME_REFUSED'});
});

test('terminating a running Job waits for actual leader exit and empty accounting',native,async t=>{
  const f=await fixture(t),lease=f.launch(waitCode),identity=f.read(lease.snapshot().pid);
  lease.resume();lease.terminate();const after=await waitEmpty(lease);
  assert.equal(after.state,'exited');assert.equal(after.activeProcesses,0);
  assert.equal(identity.snapshot().state,'exited');
  assert.equal(after.leaderExitCode,0xe0000001);assert.equal(after.terminationRequested,true);
});

test('timeout keeps an active Job and its HANDLEs; it never reports empty',native,async t=>{
  const f=await fixture(t),lease=f.launch(waitCode);lease.resume();
  await assert.rejects(()=>waitEmpty(lease,{timeoutMs:0}),error=>{
    assert.equal(error.code,'PROCESS_JOB_EXIT_UNCONFIRMED');assert.equal(error.facts.jobEmptyObserved,false);return true;
  });
  assert.throws(()=>lease.close(),{code:'PROCESS_JOB_ACTIVE'});
  assert.equal(lease.snapshot().state,'running');
});

test('resume can execute a prepared primary thread only once',native,async t=>{
  const f=await fixture(t),lease=f.launch(waitCode);lease.resume();
  assert.throws(()=>lease.resume(),{code:'PROCESS_JOB_RESUME_REFUSED'});
});

test('environment is explicit, case-insensitive duplicates and malformed specs refuse',native,async t=>{
  const f=await fixture(t);
  for(const overrides of [{command:'node'},{cwd:'.'},{env:undefined},{env:['PATH=a','Path=b']},
    {env:['=drive']},{env:['missing-equals']},{args:['bad\0arg']},{env:['KEY=bad\0value']}])
    assert.throws(()=>create({command:process.execPath,args:['-e',waitCode],cwd:f.root,env:f.environment,...overrides}),{code:'PROCESS_SPEC_INVALID'});
  assert.throws(()=>create({command:path.join(f.root,'absent.exe'),args:[],cwd:f.root,env:f.environment}),{code:'PROCESS_JOB_LAUNCH_FAILED'});
});

test('CRT quoting preserves empty, Unicode, quotes, trailing slashes and shell metacharacters',native,async t=>{
  const f=await fixture(t),out=path.join(f.root,'arguments.json');
  const args=['','中文 空格','a"b','tail\\','path with space\\','two\\\\"quotes','& | > < $() ` %TEMP%'];
  const lease=f.launch(`require('node:fs').writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),env:process.env.NOZELI_SYNTHETIC}));`,
    {args:[out,...args],env:[...f.environment,'NOZELI_SYNTHETIC=中文 = 空格']});
  lease.resume();await waitEmpty(lease);
  const actual=JSON.parse(await fs.readFile(out,'utf8'));
  assert.deepEqual(actual.argv,args);assert.equal(actual.cwd,f.root);assert.equal(actual.env,'中文 = 空格');
});

test('leader exit leaves a live inherited descendant in this Job until it is terminated',native,async t=>{
  const f=await fixture(t),ready=path.join(f.root,'descendant.json');
  const descendant=`require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);setTimeout(()=>process.exit(88),12000);`;
  const leader=`const {spawn}=require('node:child_process'),fs=require('node:fs');
    spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{stdio:'ignore',detached:true,windowsHide:true}).unref();
    const timer=setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(23);},10);`;
  const lease=f.launch(leader,{args:[ready]});lease.resume();
  await until(()=>exists(ready));const {pid}=JSON.parse(await fs.readFile(ready,'utf8')),read=f.read(pid);
  await until(()=>lease.snapshot().leaderState==='exited');
  const remaining=lease.snapshot();assert.equal(remaining.leaderExitCode,23);
  assert.ok(remaining.activeProcesses>=1);assert.equal(remaining.jobEmptyObserved,false);
  assert.equal(remaining.members.find(member=>member.pid===pid)?.stamp,read.snapshot().stamp);
  assert.equal(read.snapshot().state,'running');assert.throws(()=>lease.close(),{code:'PROCESS_JOB_ACTIVE'});
  lease.terminate();const ended=await waitEmpty(lease);
  assert.equal(read.snapshot().state,'exited');assert.ok(ended.totalProcesses>=2);
  t.diagnostic(JSON.stringify({remaining,ended,descendant:read.snapshot()}));
});

test('terminating one Job preserves an unrelated created Job sentinel',native,async t=>{
  const f=await fixture(t),subject=f.launch(waitCode),sentinel=f.launch(waitCode);
  subject.resume();sentinel.resume();const before=sentinel.snapshot();
  subject.terminate();await waitEmpty(subject);
  const after=sentinel.snapshot();assert.equal(after.stamp,before.stamp);assert.equal(after.state,'running');
  assert.equal(after.jobEmptyObserved,false);assert.equal(after.terminationRequested,false);
  assert.equal(f.read(before.pid).snapshot().state,'running');
});

test('native Job methods reject fabricated, identity and derived receivers',native,async t=>{
  const f=await fixture(t),lease=f.launch(waitCode),read=f.read(lease.snapshot().pid);
  for(const value of [{},Object.create(lease),read,null])
    for(const method of ['snapshot','resume','terminate','close'])
      assert.throws(()=>lease[method].call(value),{code:'PROCESS_JOB_RECEIVER'});
});

test('explicit environment never inherits a synthetic secret from the host',native,async t=>{
  const f=await fixture(t),out=path.join(f.root,'env.json'),key='NOZELI_SYNTHETIC_NOT_FOR_CHILD';
  const prior=process.env[key];process.env[key]='fixture-secret';
  try {
    const lease=f.launch(`require('node:fs').writeFileSync(process.argv[1],JSON.stringify({leaked:process.env.${key}??null}));`,{args:[out]});
    lease.resume();await waitEmpty(lease);
    assert.equal(JSON.parse(await fs.readFile(out,'utf8')).leaked,null);
  }finally{if(prior===undefined)delete process.env[key];else process.env[key]=prior;}
});

test('native executable in a Chinese and space path executes under the same created Job',native,async t=>{
  const f=await fixture(t),copy=path.join(f.root,'辅助 程序.exe'),out=path.join(f.root,'native.json');
  await fs.copyFile(fixtureExecutable,copy);
  const lease=f.launchNative(copy,['record',out]);
  const before=lease.snapshot();lease.resume();await waitEmpty(lease);
  assert.equal(JSON.parse(await fs.readFile(out,'utf8')).pid,before.pid);lease.close();
});

test('native CREATE_BREAKAWAY_FROM_JOB request is actually denied before escaped code executes',native,async t=>{
  const f=await fixture(t),out=path.join(f.root,'breakaway.json'),marker=path.join(f.root,'escaped.json');
  const lease=f.launchNative(fixtureExecutable,['breakaway',out,marker]);
  lease.resume();await waitEmpty(lease);
  const result=JSON.parse(await fs.readFile(out,'utf8'));
  assert.equal(result.created,false);assert.equal(result.win32Code,5);assert.equal(await exists(marker),false);
  t.diagnostic(JSON.stringify(result));lease.close();
});

test('a real nested Job retains parent containment and outer termination stops its child',native,async t=>{
  const f=await fixture(t),out=path.join(f.root,'nested.json'),marker=path.join(f.root,'nested-child.json');
  const lease=f.launchNative(fixtureExecutable,['nested',out,marker]);
  lease.resume();await until(async()=>await exists(out)&&await exists(marker));
  const result=JSON.parse(await fs.readFile(out,'utf8'));
  assert.equal(result.assigned,true);assert.equal(result.created,true);
  const child=f.read(result.childPid),before=lease.snapshot();
  assert.ok(before.activeProcesses>=2);assert.equal(child.snapshot().state,'running');
  assert.equal(before.members.find(member=>member.pid===result.childPid)?.stamp,child.snapshot().stamp);
  lease.terminate();const after=await waitEmpty(lease);
  assert.equal(child.snapshot().state,'exited');assert.equal(after.unexitedObservedMembers,0);
  t.diagnostic(JSON.stringify({result,before,after}));lease.close();
});

async function crashingHost(t,{prepared=false,forced=false,descendant=false}={}) {
  const f=await fixture(t),receipt=path.join(f.root,'host.json'),ready=path.join(f.root,'child.json');
  const moduleUrl=new URL('../src/platform/windows/experimental-process-job.mjs',import.meta.url).href;
  const childCode=descendant?`const {spawn}=require('node:child_process'),fs=require('node:fs');
    spawn(${JSON.stringify(fixtureExecutable)},['hold',process.argv[1]],{stdio:'ignore',detached:true,windowsHide:true}).unref();
    setInterval(()=>{},1000);setTimeout(()=>process.exit(88),12000);`:
    `require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);setTimeout(()=>process.exit(88),12000);`;
  const hostCode=`const fs=require('node:fs');import(${JSON.stringify(moduleUrl)}).then(async({createExperimentalProcessJob:create})=>{
    const lease=globalThis.fixtureLease=create({command:process.execPath,args:['-e',${JSON.stringify(childCode)},${JSON.stringify(ready)}],cwd:${JSON.stringify(f.root)},env:${JSON.stringify(f.environment)}});
    ${prepared?'':'lease.resume();'}
    ${prepared?'':`while(!fs.existsSync(${JSON.stringify(ready)}))await new Promise(resolve=>setTimeout(resolve,10));`}
    fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(lease.snapshot()));
    process.stdin.once('data',()=>process.exit(73));process.stdin.resume();
  }).catch(error=>{process.stderr.write(error.stack);process.exit(92)});`;
  const host=spawn(process.execPath,['-e',hostCode],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exit=once(host,'exit'),closed=once(host,'close');let stderr='';host.stderr.on('data',b=>stderr+=b);
  t.after(async()=>{if(host.exitCode===null&&host.signalCode===null)host.kill();await closed;assert.equal(stderr,'');});
  await until(()=>exists(receipt));const before=JSON.parse(await fs.readFile(receipt,'utf8')),identity=f.read(before.pid);
  const descendantRead=descendant?f.read(JSON.parse(await fs.readFile(ready,'utf8')).pid):null;
  if(descendantRead)assert.equal(descendantRead.snapshot().state,'running');
  assert.equal(identity.snapshot().state,'running');assert.equal(before.state,prepared?'prepared':'running');
  if(forced)host.kill();else host.stdin.end('exit');
  const termination=await exit;await until(()=>identity.snapshot().state==='exited');
  if(descendantRead)await until(()=>descendantRead.snapshot().state==='exited');
  // Node exposes the requested signal for ChildProcess.kill on Windows even
  // though the kernel operation is TerminateProcess, not a POSIX signal.
  assert.deepEqual(termination,forced?[null,'SIGTERM']:[73,null]);
  assert.equal(await exists(ready),!prepared);
  t.diagnostic(JSON.stringify({prepared,forced,descendant,termination,before,after:identity.snapshot(),descendantAfter:descendantRead?.snapshot()}));
}

test('actual host exit closes its Job and stops the running owned leader',native,t=>crashingHost(t));
test('actual forced host termination closes its Job and stops the running owned leader',native,t=>crashingHost(t,{forced:true}));
test('actual host crash before resume never executes the prepared command',native,t=>crashingHost(t,{prepared:true,forced:true}));
test('actual host normal exit also stops its running detached descendant',native,t=>crashingHost(t,{descendant:true}));
test('actual forced host termination also stops its running detached descendant',native,t=>crashingHost(t,{forced:true,descendant:true}));
