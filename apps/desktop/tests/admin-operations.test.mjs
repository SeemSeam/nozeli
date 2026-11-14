import test from 'node:test';
import assert from 'node:assert/strict';
import {adminOperation} from '../src/main/admin-operations.mjs';
import {createUpdateLifecycle} from '../src/main/update-lifecycle.mjs';

test('application admin rejects project surfaces, injected context and model-style generic operations',async()=>{
 const calls=[],admin={invoke:async(...args)=>{calls.push(args);return {draft:'independent'};}};
 for(const role of ['surface','detached','review-discussion',undefined])await assert.rejects(adminOperation({scope:{role},op:'admin.status',admin}),{code:'IPC_DENIED'});
 await assert.rejects(adminOperation({scope:{role:'shell'},op:'admin.send',payload:{text:'x',projectId:'project-a'},admin}),{code:'ADMIN_SCOPE_DENIED'});
 await assert.rejects(adminOperation({scope:{role:'shell'},op:'admin.invoke',payload:{op:'file.read'},admin}),{code:'INVALID_PAYLOAD'});
 assert.deepEqual(calls,[]);
 const first=await adminOperation({scope:{role:'shell',projectId:'a'},op:'admin.status',admin});
 const second=await adminOperation({scope:{role:'shell',projectId:'b'},op:'admin.status',admin});
 assert.deepEqual(first,second);assert.deepEqual(calls,[['status',{}],['status',{}]]);
});

test('management settings navigation is bounded and sending is held during shutdown',async()=>{
 let prepared=0,sent=0;const scope={role:'shell'},admin={invoke:async(action,payload)=>{sent++;return {action,payload};}};
 assert.deepEqual(await adminOperation({scope,op:'admin.openSettings',payload:{section:'settings-provider'},admin}),{section:'settings-provider'});
 await assert.rejects(adminOperation({scope,op:'admin.openSettings',payload:{section:'settings-provider',projectId:'a'},admin}),{code:'ADMIN_SCOPE_DENIED'});
 await assert.rejects(adminOperation({scope,op:'admin.openSettings',payload:{section:'shell'},admin}),{code:'INVALID_SETTINGS'});
 await assert.rejects(adminOperation({scope,op:'admin.send',payload:{text:'x'},frozen:true,admin,prepareSend:async()=>prepared++}),{code:'APPLICATION_CLOSING'});
 assert.equal(prepared,0);assert.equal(sent,0);
 await adminOperation({scope,op:'admin.send',payload:{text:'original'},admin,prepareSend:async()=>prepared++});assert.equal(prepared,1);assert.equal(sent,1);
});

test('application admin inference prevents automatic update and idle shutdown confirms its stop',async()=>{
 let busy=true,stopped=0,quit=0;
 const workspace={senders:new Map([[1,{role:'shell',ready:true,wc:{executeJavaScript:async()=>({ready:true,dirty:false,blocked:false})}}]]),receipts:new Map(),lifecycle:new Map(),drags:new Map(),flush:async()=>{}};
 const gate=createUpdateLifecycle({workspace,host:{active:0,settled:async()=>{}},managedAgents:{controllers:new Map(),busy:()=>false,stop:async()=>{}},adminAgent:{lifecycleBusy:()=>busy,stop:async()=>stopped++},powerMonitor:{getSystemIdleTime:()=>120},isClosing:()=>false,freeze:()=>{},quit:async()=>quit++});
 assert.equal((await gate.canInstall()).ready,false);assert.equal(await gate.prepareShutdown(),false);assert.equal(stopped,0);
 busy=false;assert.equal(await gate.prepareShutdown(),true);await gate.quit();assert.equal(stopped,1);assert.equal(quit,1);
});
