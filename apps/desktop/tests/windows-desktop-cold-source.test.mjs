import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fixture} from './fixtures/windows-live-surface-host.mjs';
import {recoveryHeld} from '../src/main/workspace-recovery-state.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'},text='活源正文 中文😀\n';
async function restart(f,{action,viewId=f.surface.viewId}={}){
  await f.host.settled();await f.host.storage.db.close();
  const input=path.join(f.base,'cold-input-'+Date.now()+'.json'),output=input+'.output.json';
  await fs.writeFile(input,JSON.stringify({profile:f.profile,projectId:f.source.id,relative:f.surface.relPath,viewId,action}));
  const child=spawn(process.execPath,[path.join(import.meta.dirname,'fixtures/windows-cold-source-child.mjs'),input,output],{env:{...process.env},windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
  const result=JSON.parse(await fs.readFile(output,'utf8'));assert.equal(exit.signal,null);return {...result,exit,stderr};
}

test('complete process restart restores the moved original reader, original buffer and unsent notes instead of a same-byte foreign source',native,async t=>{
  const f=await fixture(t);
  await f.workspace.saveRecovery(f.surface,{projectId:f.source.id,viewId:f.surface.viewId,relPath:f.surface.relPath,generation:1,kind:'text',sourceDigest:null,candidate:{text},workspace:{draft:'未发送备注'}});
  await f.run('cut');await fs.writeFile(path.join(f.a,'文件.txt'),text);
  f.workspace.layouts.set(f.source.id,{projectId:f.source.id});
  await assert.rejects(f.workspace.mutateTree({projectId:f.source.id,source:f.surface.relPath,action:'rename'},()=>assert.fail('a protected source path must not be renamed')),{code:'TRANSFER_HELD'});
  const cold=await restart(f,{action:'destination'});assert(cold.ok,cold.error?.message);assert.notEqual(cold.pid,process.pid);
  assert.equal(cold.before.text,text);assert.equal(cold.before.draft.text,text);assert.equal(cold.bootstrap.viewState.workspace.draft,'未发送备注');assert.equal(cold.writeCode,'TRANSFER_HELD');assert(cold.held);
  assert.equal(cold.state.status,'moved');assert.equal(cold.actionError,null);assert.equal(cold.messages.filter(m=>m.shell).length,1);
  assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),text);assert.equal(await fs.readFile(path.join(f.b,'文件.txt'),'utf8'),text);
});

test('a moved source that has no current path still opens its retained original file after restart',native,async t=>{
  const f=await fixture(t);await f.run('cut');const cold=await restart(f);assert(cold.ok,cold.error?.message);assert.equal(cold.before.text,text);assert(cold.before.treeRecoveryRetained);assert(cold.held);await assert.rejects(fs.stat(path.join(f.a,'文件.txt')),{code:'ENOENT'});
});

test('published copy restart keeps protection until paired settlement and exact source verification',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));const cold=await restart(f,{action:'resume'});assert(cold.ok,cold.error?.message);assert(cold.held);assert.equal(cold.actionError.code,'RECOVERY_UNAVAILABLE');assert.equal(cold.before.draft.text,'UNSAVED LATE BUFFER');
});

test('successful copy durably releases only its own protection before restart',native,async t=>{
  const f=await fixture(t);await f.run('copy');assert(!recoveryHeld(f.surface));const cold=await restart(f);assert(cold.ok,cold.error?.message);assert.equal(cold.held,false);assert.equal(cold.writeCode,null);assert.equal(cold.before.treeRecoveryRetained,undefined);
  const review={role:'surface',kind:'document',relPath:f.surface.relPath,documentSource:{type:'review',workId:'synthetic-work',objectId:'synthetic-report'},treeRecoveryLoaded:false};
  await f.workspace.treeRecovery.journal.ensure(review);assert.equal(review.treeRecoveryLoaded,true);assert.equal(review.treeRecoveryHolds,undefined);
});

test('settled copy source replacement with identical bytes remains protected in the next process',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));await fs.rename(path.join(f.a,'文件.txt'),path.join(f.a,'原对象.txt'));await fs.writeFile(path.join(f.a,'文件.txt'),text);await f.settle();
  const cold=await restart(f,{action:'resume'});assert(cold.ok,cold.error?.message);assert(cold.held);assert(cold.actionError);assert.equal(cold.before.draft.text,'UNSAVED LATE BUFFER');assert.equal(await fs.readFile(path.join(f.a,'原对象.txt'),'utf8'),text);
});

test('paired receipt mismatch refuses cold path reads while keeping the foreign source and retained objects',native,async t=>{
  const f=await fixture(t);await f.run('cut');await fs.writeFile(path.join(f.a,'文件.txt'),'FOREIGN');
  const id='tree-operation:'+f.input().operationId,row=await f.host.storage.readRecoveryRecord(f.source.id,id);await f.host.storage.putRecovery(f.source.id,id,{...row.value,surfaceRecovery:[]},{expectedRevision:row.revision});
  const cold=await restart(f);assert.equal(cold.ok,false);assert.equal(cold.error.code,'TREE_SURFACE_RECOVERY_CHANGED');assert(cold.held);assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),'FOREIGN');assert.equal(await fs.readFile(path.join(f.b,'文件.txt'),'utf8'),text);
});

test('a later retained note snapshot bound by the host to the original operation survives restart',native,async t=>{
  const f=await fixture(t);await f.run('cut');await f.workspace.saveRecovery(f.surface,{projectId:f.source.id,viewId:f.surface.viewId,relPath:f.surface.relPath,generation:2,kind:'text',candidate:{text:'LATER RETAINED'},workspace:{draft:'稍后保留的备注'},treeSurfaceOperations:{guessed:'untrusted'}});
  const cold=await restart(f);assert(cold.ok,cold.error?.message);assert.equal(cold.before.draft.text,'LATER RETAINED');assert.equal(cold.exported.text,'LATER RETAINED');assert.equal(cold.snapshot.text,'LATER RETAINED');assert.equal(cold.bootstrap.viewState.workspace.draft,'稍后保留的备注');assert(cold.held);
});

test('a durable release with a lost reply can be explicitly retried without deleting evidence or replaying effects',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));const put=f.host.storage.putRecovery.bind(f.host.storage);let injected=false;
  f.host.storage.putRecovery=async(id,key,value,options)=>{const result=await put(id,key,value,options);if(!injected&&key.startsWith('tree-surface:')&&value.status==='released'){injected=true;throw Object.assign(Error('lost source release response'),{code:'STORAGE_RESULT_UNKNOWN'});}return result;};
  await assert.rejects(f.settle());assert(injected);assert(recoveryHeld(f.surface));f.host.storage.putRecovery=put;
  await f.workspace.invoke(f.surface,'workspace.resumeTreeSource',f.input());assert(!recoveryHeld(f.surface));assert.equal(await fs.readFile(path.join(f.b,'文件.txt'),'utf8'),text);
});

test('failure to persist source protection refuses every native file effect and permits exact-original intent recovery',native,async t=>{
  const f=await fixture(t),put=f.host.storage.putRecovery.bind(f.host.storage);let injected=false;
  f.host.storage.putRecovery=async(id,key,value,options)=>{if(!injected&&key.startsWith('tree-surface:')){injected=true;throw Error('source protection write refused');}return put(id,key,value,options);};
  await assert.rejects(f.run('cut'));f.host.storage.putRecovery=put;assert(injected);assert(recoveryHeld(f.surface));await assert.rejects(fs.stat(path.join(f.b,'文件.txt')),{code:'ENOENT'});
  await f.workspace.invoke(f.surface,'workspace.resumeTreeSource',f.input());assert(!recoveryHeld(f.surface));assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),text);
});

test('a source protection write whose reply is lost is reconstructed and explicitly resolved from its refused original intent',native,async t=>{
  const f=await fixture(t),put=f.host.storage.putRecovery.bind(f.host.storage);let injected=false;
  f.host.storage.putRecovery=async(id,key,value,options)=>{const result=await put(id,key,value,options);if(!injected&&key.startsWith('tree-surface:')){injected=true;throw Error('lost source protection reply');}return result;};
  await assert.rejects(f.run('cut'));f.host.storage.putRecovery=put;assert(injected);const cold=await restart(f,{action:'resume'});assert(cold.ok,cold.error?.message);assert.equal(cold.actionError,null);assert.equal(cold.held,false);await assert.rejects(fs.stat(path.join(f.b,'文件.txt')),{code:'ENOENT'});
});

test('late replacement of the destination with identical bytes cannot be opened as the original moved object after restart',native,async t=>{
  const f=await fixture(t);await f.run('cut');await fs.rename(path.join(f.b,'文件.txt'),path.join(f.b,'原目标.txt'));await fs.writeFile(path.join(f.b,'文件.txt'),text);
  const cold=await restart(f,{action:'destination'});assert(cold.ok,cold.error?.message);assert(cold.held);assert(cold.actionError);assert.equal(cold.messages.filter(m=>m.shell).length,0);assert.equal(await fs.readFile(path.join(f.b,'原目标.txt'),'utf8'),text);
});

test('a settled exact-source copy release remains released in a subsequent independent process',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));await f.settle();assert(!recoveryHeld(f.surface));
  const cold=await restart(f);assert(cold.ok,cold.error?.message);assert.equal(cold.held,false);assert.equal(cold.before.treeRecoveryRetained,undefined);assert.equal(cold.writeCode,null);
});

test('killing the actual source host at its native prepared checkpoint preserves protection and original input in the next process',native,async t=>{
  const f=await fixture(t);await f.host.settled();await f.host.storage.db.close();
  const input=path.join(f.base,'crash-input.json'),output=input+'.ready.json';
  await fs.writeFile(input,JSON.stringify({profile:f.profile,projectId:f.source.id,targetId:f.target.id,relative:f.surface.relPath,viewId:f.surface.viewId,mutate:true}));
  const child=spawn(process.execPath,[path.join(import.meta.dirname,'fixtures/windows-cold-source-child.mjs'),input,output],{env:{...process.env},windowsHide:true,stdio:'ignore'});
  const exited=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}});
  const deadline=Date.now()+45000;let ready;
  while(Date.now()<deadline){ready=await fs.readFile(output,'utf8').then(JSON.parse,()=>null);if(ready)break;if(child.exitCode!==null)assert.fail('checkpoint child exited early');await new Promise(resolve=>setTimeout(resolve,100));}
  assert(ready?.ready);assert.equal(ready.pid,child.pid);child.kill('SIGKILL');await exited;
  const cold=await restart(f);assert(cold.ok,cold.error?.message);assert(cold.held);assert.equal(cold.writeCode,'TRANSFER_HELD');assert.equal(cold.before.draft.text,'CRASH RETAINED INPUT');
  assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),text);await assert.rejects(fs.stat(path.join(f.b,'文件.txt')),{code:'ENOENT'});
});

test('an unknown concurrent source protection status prevents release and preserves its original record',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));const hold=[...f.surface.treeRecoveryHolds.values()][0],row=await f.host.storage.readRecoveryRecord(f.source.id,hold.journalKey),winner={...row.value,status:'future-status'};
  await f.host.storage.putRecovery(f.source.id,row.id,winner,{expectedRevision:row.revision});await assert.rejects(f.settle(),{code:'TREE_SURFACE_RECOVERY_CHANGED'});assert(recoveryHeld(f.surface));assert.deepEqual((await f.host.storage.readRecoveryRecord(f.source.id,row.id)).value,winner);
});

test('cold readers without a published buffer export and mirror retained source bytes, never a foreign current path',native,async t=>{
  const f=await fixture(t);f.workspace.buffers.delete(f.key);await f.run('cut');await fs.writeFile(path.join(f.a,'文件.txt'),'FOREIGN CURRENT PATH');const cold=await restart(f);
  assert(cold.ok,cold.error?.message);assert.equal(cold.before.text,text);assert.equal(cold.exported.text,text);assert.equal(cold.snapshot.text,text);assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),'FOREIGN CURRENT PATH');assert(cold.held);
});

test('normal recursive copy and cut with no open source surfaces do not require a source-reader descriptor',native,async t=>{
  for(const action of ['copy','cut']){
    const f=await fixture(t,'目录/文件.txt');f.workspace.surfaces.clear();f.workspace.buffers.clear();await f.run(action,{},'目录');
    assert.equal(await fs.readFile(path.join(f.b,'目录/文件.txt'),'utf8'),text);
    if(action==='copy')assert.equal(await fs.readFile(path.join(f.a,'目录/文件.txt'),'utf8'),text);else await assert.rejects(fs.stat(path.join(f.a,'目录')),{code:'ENOENT'});
    const page=await f.host.storage.recoveryPage(f.source.id,{prefixes:['tree-surface:']});assert.equal(page.entries.length,0);
  }
});
