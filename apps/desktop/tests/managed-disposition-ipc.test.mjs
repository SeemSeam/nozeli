import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';

const main = await fs.readFile(new URL('../src/main/main.cjs', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
class HostError extends Error { constructor(code,message){super(message);this.code=code;} }
function productionBlock(start,end,args){
  const from=main.indexOf(start),to=main.indexOf(end,from);
  assert.ok(from>=0&&to>from,'production IPC block exists');
  return new AsyncFunction(...args,main.slice(from,to));
}
const managed=productionBlock("      if(typeof op==='string'&&op.startsWith('managed.')){",'      if (Object.hasOwn(agentHandlers', ['op','payload','ompRuntimeError','readNozeliConfiguration','nozeliPaths','HostError','managedAgents']);
const copySource=productionBlock("      if(op==='report.copySource'){","      if(op==='report.export'){",['op','payload','HostError','managedAgents','clipboard']);

test('local disposition bypasses runtime/config prerequisites without exempting recovery or Git retry',async()=>{
  const error=new HostError('OMP_RUNTIME_UNAVAILABLE','missing'),payload={projectId:'p'},calls=[];
  const agents={invoke:async(op,p)=>{calls.push([op,p]);return op;}};
  for(const op of ['managed.disposition','managed.end','managed.retry']){
    assert.equal((await managed(op,payload,error,()=>{throw Error('must not read configuration');},{},HostError,agents)).value,op);
    assert.equal((await managed(op,payload,null,()=>{throw Error('must not read configuration');},{},HostError,agents)).value,op);
  }
  for(const op of ['managed.git.retry','managed.recovery.resolve','managed.send']){
    await assert.rejects(managed(op,payload,error,async()=>({choiceRequired:true}),{},HostError,agents),{code:'OMP_RUNTIME_UNAVAILABLE'});
    await assert.rejects(managed(op,payload,null,async()=>({choiceRequired:true}),{},HostError,agents),{code:'CONFIG_SETUP_REQUIRED'});
  }
  assert.equal(calls.length,6);
});

function authorization(role,kind){
  const native=Object.create(WorkspaceNative.prototype),frame={url:'https://app.invalid/',parent:null};
  const sender={id:1,mainFrame:frame},record={role,kind,projectId:'p'};
  native.origin=frame.url;native.senders=new Map([[1,record]]);native.leases=new Map();native.projectHolds=new Map();native.lifecycle=new Map();
  return {native,record,event:{sender,senderFrame:frame}};
}
test('disposition remains readable while held and mutations retain their authorization',()=>{
  const {native,record,event}=authorization('surface','report');record.held=true;
  assert.equal(native.authorize(event,'managed.disposition',{projectId:'p'}),record);
  for(const op of ['managed.end','managed.retry'])assert.throws(()=>native.authorize(event,op,{projectId:'p'}),{code:'TRANSFER_HELD'});
  assert.throws(()=>native.authorize(event,'managed.disposition',{projectId:'foreign'}),{code:'PROJECT_SCOPE_DENIED'});
});
test('source copy authorizes only registered shell/report/history senders in the same project',()=>{
  for(const [role,kind] of [['shell',null],['surface','report'],['surface','history']]){
    const {native,record,event}=authorization(role,kind);
    assert.equal(native.authorize(event,'report.copySource',{projectId:'p'}),record);
    assert.throws(()=>native.authorize(event,'report.copySource',{projectId:'foreign'}),{code:'PROJECT_SCOPE_DENIED'});
    assert.throws(()=>native.authorize({...event,sender:{id:2}},'report.copySource',{projectId:'p'}),{code:'IPC_DENIED'});
  }
  for(const [role,kind] of [['surface','document'],['surface','conversation'],['detached',null]]){
    const {native,event}=authorization(role,kind);
    assert.throws(()=>native.authorize(event,'report.copySource',{projectId:'p'}),{code:'IPC_DENIED'});
  }
});
test('source copy uses verified frozen UTF-8 bytes, returns metadata only, and fails closed',async()=>{
  const payload={projectId:'p',objectId:'object'},writes=[];
  for(const format of ['markdown','html-static']){
    const text='\ufeff原始 '+format+'\n',bytes=Buffer.from(text);
    const agents={reportSource:async(projectId,objectId)=>{assert.equal(projectId,'p');assert.equal(objectId,'object');return {report:{format},read:async()=>bytes};}};
    assert.deepEqual(await copySource('report.copySource',payload,HostError,agents,{writeText:async text=>writes.push(text)}),{ok:true,value:{copied:true,byteLength:bytes.length,format}});
    assert.equal(writes.at(-1),text);
  }
  const clipboard={writeText:()=>assert.fail('must not copy unverified source')};
  await assert.rejects(copySource('report.copySource',{...payload,text:'renderer source'},HostError,{},clipboard),{code:'INVALID_PAYLOAD'});
  await assert.rejects(copySource('report.copySource',payload,HostError,{reportSource:async()=>({read:async()=>{throw new HostError('REPORT_CHANGED','changed');}})},clipboard),{code:'REPORT_CHANGED'});
  await assert.rejects(copySource('report.copySource',payload,HostError,{reportSource:async()=>({read:async()=>Buffer.from([0xff])})},clipboard),{code:'REPORT_INVALID'});
});
