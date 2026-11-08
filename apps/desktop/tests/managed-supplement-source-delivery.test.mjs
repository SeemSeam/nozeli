import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {openTestController,readTestState} from './project-storage.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';

// Real host/storage and native request boundary; only inference is synthetic.
async function open(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-supplement-source-')),calls=[];let c;
 class Session{
  constructor(spec,target){Object.assign(this,spec,{target,closed:false,busy:false,hasPrompted:false,contextEpoch:'compaction:0:root'});}
  async start(id){this.threadId=id??randomUUID();return this;}
  async preflightToolsDigest(){}async assertToolsDigest(){}
  async stop(){this.closed=true;return {confirmationComplete:true};}
  async prompt(text,options){
   this.hasPrompted=true;this.busy=true;const job=c.current.get(this.target),requestId=randomUUID(),contentDigest=createHash('sha256').update(text).digest('hex');
   const fact={kind:'prompt',sessionId:this.threadId,epoch:this.contextEpoch,requestId,jobId:job.id,attempt:1,contentDigest};
   try{
    for(const status of ['prepared','submitted','admitted'])await this.onTransportFact?.({...fact,status});
    calls.push({text,options,target:this.target,jobId:job.id,threadId:this.threadId});
    if(this.target!=='frontdesk'&&this.target!=='orchestrator')await this.onTool({tool:'nozeli_publish',arguments:{kind:'result',content:staticReport('Read-only source delivered'),files:[]},callId:randomUUID()});
    await this.onTransportFact?.({...fact,status:'native-record-confirmed',entryId:'entry-'+requestId,seq:2});
    await this.onTransportFact?.({...fact,status:'settled',seq:3});
    return {threadId:this.threadId,turnId:requestId,text:'Source read',completion:'provider-completed',providerStatus:'completed',delivery:{phase:'native-record-confirmed',requestId,turnId:requestId,text:{entryId:'entry-'+requestId,verbatim:true},materials:[],projection:{llmCalls:1,persisted:false},budget:{runHostTextBytes:0,generationHostTextBytes:0,contextEpoch:this.contextEpoch}}};
   }finally{this.busy=false;}
  }
 }
 const options={runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),projectHome:home=>fs.mkdir(home,{recursive:true}),sessionFactory:(spec,target)=>new Session(spec,target)};
 c=await openTestController(options);c.kick=()=>{};await c.start();
 t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
 async function intake(text){const receipt=await c.enqueue('orchestrator','intake',text);const job=c.store.state.jobs.find(j=>j.id===receipt.jobId);c.current.set('orchestrator',job);return job;}
 async function route(work,text,note,omit=false){const input=await intake(text),args={action:'continue',workId:work.id,expectedRevision:c.store.find(work.id).revision,...(!omit?{text:note}:{})};const r=await c.onTool('orchestrator',{tool:'nozeli_manage',arguments:args,callId:randomUUID()});c.current.delete('orchestrator');return {input,args,r};}
 return {get c(){return c;},calls,intake,route,async reopen(){await c.stop();c=await openTestController(options);c.kick=()=>{};await c.start();return c;}};
}

test('continue delivers exact current user source with empty/whitespace/omitted and distinct routing notes',async t=>{
 const f=await open(t),c=f.c;const work=await c.store.submit('Original Work request MUST NOT REPLAY','Original brief',{name:'Source consumer'});await c.store.activate(work.id);
 for(const [i,note,omit] of [[0,'',false],[1,' \n ',false],[2,undefined,true],[3,'Only verify the requested evidence',false]]){
  const original=`  Supplement ${i} 中文😀\nKeep exact whitespace.  `;
  const {input,args,r}=await f.route(work,original,note,omit);
  c.current.set('orchestrator',input);assert.deepEqual(await c.onTool('orchestrator',{tool:'nozeli_manage',arguments:args,callId:randomUUID()}),r);c.current.delete('orchestrator');
  const job=c.store.state.jobs.find(j=>j.key===`supplement:${input.id}`);assert(job);
  await c.runJob(job);const delivered=f.calls.find(call=>call.jobId===job.id);assert(delivered);
  assert(delivered.text.includes(original),'entire exact original source is delivered');assert.equal(delivered.text.split(original).length-1,1);
  assert(!delivered.text.includes('Original Work request MUST NOT REPLAY'));
  if(note?.trim())assert(delivered.text.includes(note));
  assert.equal(c.store.state.jobs.filter(j=>j.key===`supplement:${input.id}`).length,1);
  assert.equal(c.store.find(work.id).inputs.find(i=>i.sourceJobId===input.id).text,original);
 }
 assert.equal(new Set(f.calls.filter(call=>call.target===work.id).map(call=>call.threadId)).size,1);
});

test('queued and cold-restored supplements retain originals once instead of routing-note substitutes',async t=>{
 const f=await open(t);let c=f.c;const work=await c.store.submit('Original queued source','brief',{name:'Queued consumer'});
 const first='  queued original 😀\nnot the route note  ',second='Second exact queued requirement';
 await f.route(work,first,'');await f.route(work,second,'A distinct routing note');
 assert.equal(c.store.state.jobs.filter(j=>j.target===work.id).length,0);
 const persisted=await readTestState(c.store);assert.equal(persisted.works.find(w=>w.id===work.id).inputs.length,2);
 c=await f.reopen();assert.equal(f.calls.filter(call=>call.target===work.id).length,0);
 await c.store.activate(work.id);const initial=await c.enqueue(work.id,'initial',c.initialWorkerText(c.store.find(work.id)));await c.runJob(c.store.state.jobs.find(j=>j.id===initial.jobId));
 const delivered=f.calls.find(call=>call.jobId===initial.jobId);for(const text of [first,second,'A distinct routing note'])assert.equal(delivered.text.split(text).length-1,1);
 const third='Cold supplement current original\n  Preserve me 😀';const routed=await f.route(work,third,'');
 c=await f.reopen();const held=c.store.state.jobs.find(j=>j.key===`supplement:${routed.input.id}`);assert.equal(held.status,'interrupted');assert(held.text.includes(third));assert.equal(f.calls.filter(call=>call.jobId===held.id).length,0,'cold restore retains but never automatically replays the pending round');
 const fresh=await f.route(work,third,'');const job=c.store.state.jobs.find(j=>j.key===`supplement:${fresh.input.id}`);await c.runJob(job);
 const actual=f.calls.filter(call=>call.jobId===job.id);assert.equal(actual.length,1);assert(actual[0].text.includes(third));assert(!actual[0].text.includes(first));assert.equal(c.store.find(work.id).id,work.id);
});
