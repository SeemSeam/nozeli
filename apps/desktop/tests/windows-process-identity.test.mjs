import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {openExperimentalProcessIdentity as open} from '../src/platform/windows/experimental-process-identity.mjs';
import {processStamp,ownerAlive,hostProcessTree} from '../src/agents/managed/process-ownership.mjs';
import {capabilityStatus} from '../src/platform/platform-capabilities.mjs';

const native = {skip:process.platform !== 'win32' || process.arch !== 'x64',timeout:15000};
const childCode = `process.stdout.write('ready\\n');process.stdin.setEncoding('utf8');
process.stdin.once('data', code => process.exit(Number(code)));process.stdin.resume();`;
async function ownedChild(t) {
  const child = spawn(process.execPath, ['-e', childCode], {
    stdio:['pipe','pipe','pipe'],windowsHide:true,
  });
  const exit = once(child, 'exit');
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', bytes=>stderr+=bytes);
  t.after(async()=>{
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    assert.equal(stderr, '');
  });
  const [ready] = await once(child.stdout,'data');
  assert.equal(ready.toString(),'ready\n');
  return {child,exit,closed,async finish(code=0){child.stdin.end(String(code));return exit;}};
}
function pin(t,pid) {const lease=open(pid);t.after(()=>lease.close());return lease;}
function validate(facts,pid) {
  assert.equal(facts.schema,1);
  assert.equal(facts.pid,pid);
  assert.match(facts.creationTime100ns,/^\d+$/);
  assert.ok(BigInt(facts.creationTime100ns)>BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(facts.stamp,`win32:${pid}:${facts.creationTime100ns}`);
  assert.equal(facts.inheritable,false);
  assert.equal(facts.treeExitVerified,false);
  assert.equal(facts.scope,'single-process-observation-only');
  assert.ok(path.isAbsolute(facts.imagePath));
}

test('current process identity uses an exact FILETIME string and a non-inheritable HANDLE', native, t=>{
  const lease=pin(t,process.pid),facts=lease.snapshot();validate(facts,process.pid);
  assert.equal(facts.state,'running');
  assert.equal(facts.exitCode,undefined);
  assert.equal(facts.exitTime100ns,undefined);
  assert.equal(facts.imagePath.toLowerCase(),process.execPath.toLowerCase());
});

test('two independently opened HANDLEs observe the same current incarnation', native, t=>{
  const first=pin(t,process.pid),second=pin(t,process.pid);
  assert.deepEqual(first.snapshot(),second.snapshot());
  first.close();assert.equal(second.snapshot().state,'running');
});

test('invalid PIDs are rejected before an OpenProcess call', native, ()=>{
  for (const value of [undefined,null,'1',1n,{},[],0,-1,1.5,NaN,Infinity,2**32])
    assert.throws(()=>open(value),{code:'PROCESS_PID_INVALID'});
});

test('unopenable PID produces no missing-process or tree-stopped verdict', native, ()=>{
  assert.throws(()=>open(0xffffffff),error=>{
    assert.equal(error.code,'PROCESS_OPEN_UNVERIFIED');
    assert.ok(Number.isInteger(error.win32Code)&&error.win32Code>0);
    assert.equal(error.verified,undefined);assert.equal(error.treeExitVerified,undefined);
    return true;
  });
});

test('native receiver type tags reject fabricated and other lease receivers', native, t=>{
  const lease=pin(t,process.pid);
  for (const receiver of [{},Object.create(lease),null,1]) {
    assert.throws(()=>lease.snapshot.call(receiver),{code:'PROCESS_HANDLE_RECEIVER'});
    assert.throws(()=>lease.close.call(receiver),{code:'PROCESS_HANDLE_RECEIVER'});
  }
  assert.equal(lease.snapshot().state,'running');
});

test('close is idempotent and querying a closed identity refuses', native, ()=>{
  const lease=open(process.pid);lease.close();lease.close();
  assert.throws(()=>lease.snapshot(),{code:'PROCESS_HANDLE_CLOSED'});
});

test('retained HANDLE observes actual normal exit without losing the incarnation', native, async t=>{
  const child=await ownedChild(t),lease=pin(t,child.child.pid),before=lease.snapshot();
  validate(before,child.child.pid);assert.equal(before.state,'running');
  assert.deepEqual(await child.finish(17),[17,null]);
  const after=lease.snapshot();validate(after,child.child.pid);
  assert.equal(after.state,'exited');assert.equal(after.exitCode,17);
  assert.equal(after.stamp,before.stamp);assert.equal(after.imagePath,before.imagePath);
  assert.ok(BigInt(after.exitTime100ns)>=BigInt(after.creationTime100ns));
  await child.closed;
  assert.deepEqual(lease.snapshot(),after);
});

test('real exit code STILL_ACTIVE (259) is distinguished by the signaled HANDLE', native, async t=>{
  const child=await ownedChild(t),lease=pin(t,child.child.pid);
  assert.equal(lease.snapshot().state,'running');
  assert.deepEqual(await child.finish(259),[259,null]);
  const after=lease.snapshot();assert.equal(after.state,'exited');assert.equal(after.exitCode,259);
  assert.equal(after.treeExitVerified,false);
});

test('two actual child incarnations retain distinct identities while both are running', native, async t=>{
  const first=await ownedChild(t),second=await ownedChild(t);
  const a=pin(t,first.child.pid).snapshot(),b=pin(t,second.child.pid).snapshot();
  assert.notEqual(a.pid,b.pid);assert.notEqual(a.stamp,b.stamp);
  assert.equal(a.state,'running');assert.equal(b.state,'running');
  await first.finish();await second.finish();
});

test('observing one actual exit leaves an unrelated owned sentinel alive', native, async t=>{
  const subject=await ownedChild(t),sentinel=await ownedChild(t);
  const subjectLease=pin(t,subject.child.pid),sentinelLease=pin(t,sentinel.child.pid);
  const before=sentinelLease.snapshot();await subject.finish();
  assert.equal(subjectLease.snapshot().state,'exited');
  assert.deepEqual(sentinelLease.snapshot(),before);
  await sentinel.finish();assert.equal(sentinelLease.snapshot().state,'exited');
});

test('actual leader exit leaves its grandchild running and never certifies tree exit', native, async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-process-identity-'));
  const stop=path.join(root,'stop'),ready=path.join(root,'ready');let descendantLease;
  const grandchild=`const fs=require('node:fs');fs.writeFileSync(process.argv[2],String(process.pid));
    const timer=setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(0);},20);
    setTimeout(()=>process.exit(88),12000);`;
  const parent=`const {spawn}=require('node:child_process'),fs=require('node:fs');
    const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)},${JSON.stringify(stop)},${JSON.stringify(ready)}],{stdio:'ignore',detached:true,windowsHide:true});
    child.unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){
      clearInterval(timer);process.stdout.write(JSON.stringify({pid:child.pid})+'\\n');}},10);
    process.stdin.once('data',()=>process.exit(0));`;
  const leader=spawn(process.execPath,['-e',parent],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exit=once(leader,'exit'),closed=once(leader,'close');
  let stderr='';leader.stderr.on('data',bytes=>stderr+=bytes);
  t.after(async()=>{
    await fs.writeFile(stop,'stop');
    if(leader.exitCode===null&&leader.signalCode===null)leader.kill();
    await closed;
    if(descendantLease){
      for(let attempt=0;attempt<200&&descendantLease.snapshot().state!=='exited';attempt++)await delay(20);
      assert.equal(descendantLease.snapshot().state,'exited','fixture descendant must exit through its own stop file');
      descendantLease.close();
    }
    assert.equal(stderr,'');await fs.rm(root,{recursive:true,force:true});
  });
  const [bytes]=await once(leader.stdout,'data'),descendant=JSON.parse(bytes.toString());
  const leaderLease=pin(t,leader.pid);descendantLease=open(descendant.pid);
  assert.equal(descendantLease.snapshot().state,'running',JSON.stringify(descendantLease.snapshot()));
  leader.stdin.end('exit');await exit;
  const ended=leaderLease.snapshot();assert.equal(ended.state,'exited');assert.equal(ended.treeExitVerified,false);
  assert.equal(descendantLease.snapshot().state,'running');
  await fs.writeFile(stop,'stop');
});

test('repeated open/close does not mutate another current process observation', native, t=>{
  const held=pin(t,process.pid),expected=held.snapshot();
  for(let i=0;i<256;i++){const lease=open(process.pid);assert.deepEqual(lease.snapshot(),expected);lease.close();}
  assert.deepEqual(held.snapshot(),expected);
});

test('experimental observation cannot enable shared process ownership or release its fence', native, async t=>{
  pin(t,process.pid).snapshot();
  assert.equal(capabilityStatus('verified-process-ownership').status,'unsupported');
  assert.equal(capabilityStatus('recovery-source-ownership').status,'unsupported');
  assert.equal(await processStamp(process.pid),null);
  await assert.rejects(()=>ownerAlive({pid:process.pid}),{code:'PROCESS_OWNERSHIP_UNSUPPORTED'});
  const tree=hostProcessTree();assert.equal(tree.verified,false);
  assert.throws(()=>tree.spawn({command:process.execPath,args:['-e','process.exit(91)']}),{code:'PROCESS_OWNERSHIP_UNSUPPORTED'});
});
