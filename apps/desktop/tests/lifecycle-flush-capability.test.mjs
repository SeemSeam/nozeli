import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';

test('overlapping native flushes serialize callbacks and scope tokens to recovery only',async()=>{
 const ipc=new EventEmitter(),calls=[];let bridge;
 ipc.invoke=async(channel,op,payload)=>{calls.push({op,payload});return {ok:true};};
 const source=await fs.readFile(new URL('../src/preload/preload.cjs',import.meta.url),'utf8');
 vm.runInNewContext(source,{require:()=>({ipcRenderer:ipc,contextBridge:{exposeInMainWorld:(_name,value)=>{bridge=value;}}})});
 let release;const gate=new Promise(resolve=>{release=resolve;});let active=0,max=0,turn=0;
 bridge.subscribe('session.flush',async()=>{active++;max=Math.max(max,active);turn++;if(turn===1)await gate;await bridge.invoke('workspace.recovery',{projectId:'project'});await bridge.invoke('managed.send',{projectId:'project',text:'not authorized'});active--;return {ok:true};});
 ipc.emit('nozeli:flush',{},'first');ipc.emit('nozeli:flush',{},'second');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(turn,1);release();
 for(let i=0;i<10&&calls.filter(c=>c.op==='session.flushed').length<2;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(max,1);assert.deepEqual(calls.filter(c=>c.op==='workspace.recovery').map(c=>c.payload.flushRequestId),['first','second']);
 assert(calls.filter(c=>c.op==='managed.send').every(c=>!Object.hasOwn(c.payload,'flushRequestId')));
});
test('lifecycle recovery authority binds the precise live receipt, sender, generation and hold',()=>{
 const hold={},record={projectId:'p',generation:4},receipt={record,generation:4,lifecycleHold:hold};
 const scope={receipts:new Map([['request',receipt]]),host:{storage:{lifecycleHolds:new Map([['p',hold]])}}};
 const check=(r,id,op)=>WorkspaceNative.prototype.lifecycleFlushOwner.call(scope,r,id,op);
 assert.equal(check(record,'request','workspace.recovery'),hold);
 for(const op of ['managed.send','file.save','state.write','project.remove'])assert.equal(check(record,'request',op),null);
 assert.equal(check({...record},'request','workspace.recovery'),null);assert.equal(check(record,'unknown','workspace.recovery'),null);
 record.generation++;assert.equal(check(record,'request','workspace.recovery'),null);record.generation--;
 scope.host.storage.lifecycleHolds.set('p',{});assert.equal(check(record,'request','workspace.recovery'),null);
});
test('hold rejects receipt-less recovery, exact receipt succeeds, ordinary recovery is unchanged',()=>{
 const hold={},record={projectId:'p',generation:4};
 const scope={receipts:new Map([['request',{record,generation:4,lifecycleHold:hold}]]),host:{storage:{lifecycleHolds:new Map([['p',hold]])}},lifecycleFlushOwner:WorkspaceNative.prototype.lifecycleFlushOwner};
 const admit=payload=>WorkspaceNative.prototype.assertRecoveryAdmission.call(scope,record,'workspace.recovery',payload);
 assert.throws(()=>admit({}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 assert.throws(()=>admit({flushRequestId:'unknown'}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 assert.doesNotThrow(()=>admit({flushRequestId:'request'}));
 scope.host.storage.lifecycleHolds.clear();assert.doesNotThrow(()=>admit({}));
});
