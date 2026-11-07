import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {openTestController,readTestState} from './project-storage.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {memorySourceManifest} from '../src/agents/managed/memory-source-manifest.mjs';

// Synthetic sessions only replace model inference. Dispatch, admission, SQLite,
// immutable report objects, publication and no-file user closure remain real.
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-memory-multitask-'));
  let c;
  const turns=[],failures=[],commands=new Map(),sources=[];
  let peakQuota=0;
  const call=async(target,tool,args)=>{
    // A scheduler commit may invalidate a read-only memory snapshot while the
    // synthetic model is selecting sources. Retry only that explicit refusal;
    // routing tools retain their real persisted-intent idempotency checks.
    for(let attempt=0;;attempt++){
      try{return await c.onTool(target,{tool,arguments:args,callId:randomUUID()});}
      catch(error){
        if(error.code!=='RESULT_MEMORY_STALE'||attempt>=8)throw error;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    }
  };
  class Session{
    constructor(spec,target){Object.assign(this,spec,{target,closed:false,busy:false,contextEpoch:'compaction:0:root'});}
    async start(thread){this.threadId=thread??randomUUID();return this;}
    async preflightToolsDigest(){}
    async assertToolsDigest(){}
    async stop(){this.closed=true;this.release?.();return {confirmationComplete:true};}
    async prompt(text,opts={}){
      this.busy=true;
      const job=c.current.get(this.target),requestId=randomUUID();
      const fact={kind:'prompt',sessionId:this.threadId,epoch:this.contextEpoch,requestId,jobId:job.id,attempt:1,contentDigest:createHash('sha256').update(JSON.stringify([text,opts.images??[]])).digest('hex')};
      try{
        for(const status of ['prepared','submitted','admitted'])await this.onTransportFact?.({...fact,status,...(status==='admitted'?{seq:1}:{})});
        if(this.target==='orchestrator'){
          const command=commands.get(job.text);
          assert.ok(command,'every intake has an explicit synthetic routing command');
          if(command.action==='new'){
            const args={name:command.name,memorySources:command.sources??[]};
            const first=await call(this.target,'nozeli_dispatch',args);
            const second=await call(this.target,'nozeli_dispatch',args);
            assert.equal(second.workId,first.workId,'same intake dispatch cannot create another Work');
            await assert.rejects(call(this.target,'nozeli_dispatch',{...args,name:command.name+' collision'}),{code:'INTENT_MISMATCH'});
          }else{
            const work=c.store.find(command.workId);
            const args={action:'continue',workId:work.id,expectedRevision:work.revision,text:job.text,...(command.sources!==undefined?{memorySources:command.sources}:{})};
            const first=await call(this.target,'nozeli_manage',args);
            assert.deepEqual(await call(this.target,'nozeli_manage',args),first,'management replay cannot append another input');
          }
        }else if(this.target==='frontdesk'){
          throw Error('explicit background intake must not need a frontdesk model turn');
        }else{
          const turn={target:this.target,jobId:job.id,type:job.type,threadId:this.threadId,text,opts,reads:[],denied:[]};
          const gate=new Promise(resolve=>{turn.release=resolve;this.release=resolve;});
          const work=c.store.find(this.target),selected=structuredClone(work.memorySources??[]);
          turn.selected=selected;
          const projection=JSON.parse(opts.projection.text);
          assert.equal(projection.workId,this.target);
          assert.equal(projection.memorySourceManifest.readRef,memorySourceManifest(work).readRef);
          let manifestText='',manifestOffset=0;
          for(let ref=projection.memorySourceManifest.readRef;ref;){
            const page=await call(this.target,'nozeli_history_read',{readRef:ref});
            assert.equal(page.offset,manifestOffset);
            assert(page.endOffset>page.offset,'manifest paging makes forward progress');
            manifestText+=page.text;manifestOffset=page.endOffset;ref=page.nextReadRef;
          }
          const manifest=JSON.parse(manifestText);
          assert.deepEqual(manifest.current,selected);
          assert.deepEqual(manifest.bindings,work.memorySourceBindings);
          turn.manifest=manifest;
          turns.push(turn);
          await gate;
          if(this.closed)return {threadId:this.threadId,turnId:requestId,text:'stopped'};
          // Navigation may replace/clear, but immutable input-bound evidence is
          // still required by this same Work. Never authorize another Work's union.
          const retained=[...new Map(manifest.bindings.flatMap(binding=>binding.sources).map(source=>[JSON.stringify(source),source])).values()];
          turn.retained=structuredClone(retained);
          for(const source of retained){
            const read=await call(this.target,'nozeli_memory_read',{source,maxBytes:1800});
            assert.deepEqual(read.source,source);
            turn.reads.push(read);
          }
          const authorized=(c.store.find(this.target).memorySourceBindings??[]).flatMap(binding=>binding.sources);
          for(const source of sources.filter(source=>!authorized.some(chosen=>chosen.objectId===source.objectId))){
            await assert.rejects(call(this.target,'nozeli_memory_read',{source}),{code:'MEMORY_SOURCE_FORBIDDEN'});
            turn.denied.push(source);
          }
          if(sources.length)await assert.rejects(call(this.target,'nozeli_memory_search',{query:'conflict-policy'}),{code:'MEMORY_SOURCE_FORBIDDEN'});
          await call(this.target,'nozeli_publish',{kind:'result',content:staticReport(commands.get(work.request)?.report??('Consumer result '+work.name)),files:[]});
        }
        await this.onTransportFact?.({...fact,status:'native-record-confirmed',entryId:'entry-'+requestId,seq:2});
        // Native-record confirmation proves delivery, not successful turn
        // settlement. Mirror PiSession's final transport stage before return.
        await this.onTransportFact?.({...fact,status:'settled',seq:3});
        return {threadId:this.threadId,turnId:requestId,text:'Synthetic completed turn',completion:'provider-completed',providerStatus:'completed',delivery:{phase:'native-record-confirmed',requestId,turnId:requestId,text:{entryId:'entry-'+requestId,verbatim:true},materials:[],projection:{llmCalls:1,persisted:false},budget:{runHostTextBytes:0,generationHostTextBytes:0,contextEpoch:this.contextEpoch}}};
      }catch(error){failures.push(error);throw error;}finally{this.busy=false;this.release=null;}
    }
  }
  const options={runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),projectHome:home=>fs.mkdir(home,{recursive:true}),sessionFactory:(spec,target)=>new Session(spec,target)};
  const observe=host=>host.on('state',state=>{peakQuota=Math.max(peakQuota,state.quotaUsed);});
  c=await openTestController(options);
  await c.store.mutate(()=>{c.store.state.limit=2;for(const binding of Object.values(c.store.state.bindings))binding.provider='pi';});
  observe(c);
  await c.start();
  t.after(async()=>{try{await c.stop();}finally{await fs.rm(root,{recursive:true,force:true});}});
  const wait=async(predicate,label)=>{
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      if(failures.length)throw failures[0];
      const value=predicate();if(value)return value;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw Error('Timed out: '+label);
  };
  const intake=async(text,command,key=text)=>{
    commands.set(text,command);
    const receipt=await c.submitTask(text,{requestKey:key});
    await wait(()=>c.store.state.jobs.find(job=>job.id===receipt.jobId)?.status==='completed'&&!c.kicking,'intake '+text);
    return {receipt,work:c.store.find(c.store.state.jobs.find(job=>job.id===receipt.jobId).routing.workId)};
  };
  const finish=async(id,type='initial')=>{
    const turn=await wait(()=>turns.find(turn=>turn.target===id&&turn.type===type&&!turn.released),'worker admission '+id+' '+type);
    await wait(()=>!c.kicking,'scheduler admission settled');
    turn.released=true;turn.release();
    await wait(()=>c.store.state.jobs.find(job=>job.id===turn.jobId)?.status==='completed'&&!c.kicking&&(!c.running.has(id)||turns.some(next=>next.target===id&&next.jobId!==turn.jobId&&!next.released)),'worker publication '+id);
    if(!c.store.state.jobs.some(job=>job.target===id&&['queued','running'].includes(job.status)))assert.equal(c.store.find(id).status,'review');
    return turn;
  };
  const close=async(id,decision='accept')=>{
    const result=await c.endWork(id,{revision:c.store.find(id).revision,decision});
    assert.equal(result.status,'ended');assert.equal(result.closure.phase,'complete');
    assert.equal(c.store.find(id).outcome,decision);
    await wait(()=>!c.kicking,'closure scheduling');
    return result;
  };
  return {get c(){return c;},turns,sources,intake,finish,close,wait,get peakQuota(){return peakQuota;},reopen:async()=>{
    await c.stop();c=await openTestController(options);observe(c);await c.start();
    await wait(()=>!c.kicking,'cold scheduler settled');return c;
  }};
}

async function seedHistory(f){
  const definitions=[
    ['Policy legacy','conflict-policy legacy: choose RED; valid only for legacy clients.','accept'],
    ['Policy current','conflict-policy current: choose BLUE; supersedes legacy for new clients.','accept'],
    ['Policy rejected','conflict-policy rejected: choose GREEN; unsafe proposal, explicitly discarded.','discard']
  ];
  for(const [name,report,decision] of definitions){
    const {work}=await f.intake('Create historical '+name,{action:'new',name,report});
    await f.finish(work.id);await f.close(work.id,decision);
  }
  const accepted=await f.c.resultMemory.search({query:'conflict-policy'});
  const history=await f.c.resultMemory.search({query:'conflict-policy',includeHistory:true});
  assert.equal(accepted.totalMatches,2);assert.equal(history.totalMatches,3);
  assert.equal(accepted.coverage.complete,true);assert.equal(history.coverage.complete,true);
  assert.deepEqual(new Set(accepted.matches.map(match=>match.outcome)),new Set(['accept']));
  const pick=name=>history.matches.find(match=>f.c.store.find(match.source.workId).name===name).source;
  const legacy=pick('Policy legacy'),current=pick('Policy current'),rejected=pick('Policy rejected');
  f.sources.push(legacy,current,rejected);
  assert.equal(history.matches.find(match=>match.source.workId===rejected.workId).outcome,'discard');
  assert(!accepted.matches.some(match=>match.source.workId===rejected.workId));
  for(const [source,word] of [[legacy,'RED'],[current,'BLUE'],[rejected,'GREEN']])assert((await f.c.resultMemory.read(source)).text.includes(word));
  return {legacy,current,rejected};
}

test('six quota-two Workers retain exact conflicting/history source choices through supplements, idempotency and cold restart',async t=>{
  const f=await fixture(t),{legacy,current,rejected}=await seedHistory(f);
  const names=['Alpha','Beta','Gamma','Delta','Epsilon','Zeta'];
  const choices=[[legacy],[current],[legacy,current],[rejected],[current],[]];
  const tasks=[];
  for(let i=0;i<names.length;i++)tasks.push(await f.intake('New bounded task '+names[i],{action:'new',name:names[i],sources:choices[i]}));
  await f.wait(()=>f.turns.filter(turn=>names.includes(f.c.store.find(turn.target).name)).length===2&&!f.c.kicking,'first two worker admissions');
  const [alpha,beta,gamma,delta,epsilon,zeta]=tasks.map(task=>task.work);
  assert.equal(f.c.store.used(),2);assert.equal(f.peakQuota,2);
  assert.equal(f.turns.filter(turn=>names.includes(f.c.store.find(turn.target).name)).length,2);
  for(const work of [gamma,delta,epsilon,zeta]){
    assert.equal(f.c.store.find(work.id).status,'queued');
    assert.equal(f.c.store.state.jobs.filter(job=>job.target===work.id).length,0,'quota-full Work has not run');
  }
  const alphaInitial=structuredClone(alpha.memorySourceBindings[0]);
  const busy=await f.intake('Alpha busy source replacement',{action:'continue',workId:alpha.id,sources:[current]});
  const queued=await f.intake('Gamma queued source replacement',{action:'continue',workId:gamma.id,sources:[rejected]});
  const cleared=await f.intake('Gamma clear selected sources',{action:'continue',workId:gamma.id,sources:[]});
  const preserved=await f.intake('Delta queued omitted sources preserve history',{action:'continue',workId:delta.id});
  const deltaFirst=await f.intake('Delta queued input requires legacy RED evidence',{action:'continue',workId:delta.id,sources:[legacy]});
  const deltaSecond=await f.intake('Delta queued input also requires current BLUE evidence',{action:'continue',workId:delta.id,sources:[current]});
  assert.deepEqual(f.c.store.find(alpha.id).memorySources,[current]);
  assert.deepEqual(f.c.store.find(alpha.id).memorySourceBindings[0],alphaInitial);
  assert.equal(f.c.store.find(alpha.id).inputs.length,1);
  assert.equal(f.c.store.find(gamma.id).inputs.length,2);
  assert.deepEqual(f.c.store.find(gamma.id).memorySources,[]);
  assert.deepEqual(f.c.store.find(gamma.id).memorySourceBindings.map(binding=>binding.sources),[[legacy,current],[rejected],[]]);
  assert.deepEqual(f.c.store.find(delta.id).memorySources,[current]);
  assert.deepEqual(f.c.store.find(delta.id).memorySourceBindings.map(binding=>binding.sources),[[rejected],[legacy],[current]],'two queued inputs retain distinct required sources');
  assert.equal(f.turns.filter(turn=>turn.target===alpha.id).length,1,'busy supplement waits on original thread');
  assert.equal(f.c.store.state.jobs.filter(job=>job.target===gamma.id).length,0,'queued supplements do not consume worker turns');

  // A bound-send duplicate has a durable host receipt and adds no resident turn.
  const boundText='  Gamma exact queued supplement\n保持来源原文 😀  ',boundContext={source:'synthetic-multitask-origin'};
  const beforeResident=new Set(f.c.store.state.jobs.filter(job=>job.target==='orchestrator').map(job=>job.id));
  const [bound,repeated]=await Promise.all([f.c.send(gamma.id,boundText,{requestKey:'gamma-bound',context:boundContext}),f.c.send(gamma.id,boundText,{requestKey:'gamma-bound',context:boundContext})]);
  assert.deepEqual(repeated,bound);assert.equal(bound.hostResolved,true);
  const addedResident=f.c.store.state.jobs.filter(job=>job.target==='orchestrator'&&!beforeResident.has(job.id));
  const residentDiagnostics=JSON.stringify(addedResident.map(job=>({id:job.id,type:job.type,status:job.status,hostResolved:job.hostResolved,completion:job.completion,promptStartedAt:job.promptStartedAt,context:job.context,routing:job.routing})));
  assert.deepEqual(addedResident.map(job=>job.id),[bound.jobId],'only the explicit host-bound receipt may be added: '+residentDiagnostics);
  const boundJob=addedResident[0];
  assert.equal(boundJob.type,'intake');assert.equal(boundJob.status,'completed');
  assert.equal(boundJob.context.boundWorkId,gamma.id);
  assert.equal(boundJob.hostResolved,true);assert.equal(boundJob.completion,'host-bound-input');
  assert.equal(boundJob.promptStartedAt,null,'host receipt must not prompt the orchestrator: '+residentDiagnostics);
  assert.equal(boundJob.routing.workId,gamma.id);
  assert.equal(f.c.store.find(gamma.id).inputs.filter(input=>input.text===boundText).length,1);
  const alphaTurn=await f.finish(alpha.id);
  const alphaSupplement=await f.finish(alpha.id,'supplement');
  const betaTurn=await f.finish(beta.id);
  assert.equal(alphaTurn.threadId,alphaSupplement.threadId);
  assert.deepEqual(alphaSupplement.selected,[current]);
  assert(alphaSupplement.reads.some(read=>read.text.includes('BLUE')));
  assert(alphaSupplement.reads.some(read=>read.source.workId===legacy.workId),'earlier input evidence remains readable after replacement');
  assert(alphaSupplement.denied.some(source=>source.workId===rejected.workId),'another Work history source stays forbidden');
  assert.deepEqual(betaTurn.selected,[current]);
  assert.equal(f.c.store.used(),2,'review results retain quota until explicit closure');

  const persisted=await readTestState(f.c.store);
  const frozenGamma=structuredClone(persisted.works.find(work=>work.id===gamma.id));
  const threads=[f.c.store.find(alpha.id).threadId,f.c.store.find(beta.id).threadId];
  const turnCount=f.turns.length,jobCount=f.c.store.state.jobs.length;
  await f.reopen();
  assert.equal(f.turns.length,turnCount,'cold start cannot replay completed or quota-blocked turns');
  assert.equal(f.c.store.state.jobs.length,jobCount);
  assert.equal(f.c.store.state.limit,2);assert.equal(f.c.store.used(),2);
  assert.deepEqual([f.c.store.find(alpha.id).threadId,f.c.store.find(beta.id).threadId],threads);
  assert.deepEqual(f.c.store.find(gamma.id).memorySourceBindings,frozenGamma.memorySourceBindings);
  assert.deepEqual(f.c.store.find(gamma.id).inputs,frozenGamma.inputs);
  assert.deepEqual(await f.c.send(gamma.id,boundText,{requestKey:'gamma-bound',context:boundContext}),bound);
  for(const task of [...tasks,busy,queued,cleared,preserved,deltaFirst,deltaSecond]){
    const original=f.c.store.state.jobs.find(job=>job.id===task.receipt.jobId);
    assert.deepEqual(await f.c.submitTask(original.text,{requestKey:original.key.slice('task:'.length)}),task.receipt);
  }
  assert.equal(f.c.store.state.jobs.length,jobCount,'cold duplicate submissions add no jobs');
  assert.equal(f.c.store.state.works.length,9,'three historical plus six independent Works');
  const acceptedCold=await f.c.resultMemory.search({query:'conflict-policy'});
  const historyCold=await f.c.resultMemory.search({query:'conflict-policy',includeHistory:true});
  assert.deepEqual(new Set(acceptedCold.matches.map(match=>match.source.objectId)),new Set([legacy.objectId,current.objectId]));
  assert.equal(historyCold.totalMatches,3);

  await f.close(alpha.id);
  const gammaTurn=await f.finish(gamma.id);
  assert.deepEqual(gammaTurn.selected,[]);assert.equal(gammaTurn.reads.length,3);assert.equal(gammaTurn.denied.length,0);
  assert.deepEqual(new Set(gammaTurn.reads.map(read=>read.source.objectId)),new Set([legacy.objectId,current.objectId,rejected.objectId]),'clearing navigation does not erase input-bound authority');
  for(const text of ['Gamma queued source replacement','Gamma clear selected sources',boundText])assert.equal(gammaTurn.text.split(text).length-1,1,'queued exact input delivered once');
  await f.close(beta.id,'discard');
  const deltaTurn=await f.finish(delta.id);
  assert.deepEqual(deltaTurn.selected,[current]);
  assert.deepEqual(new Set(deltaTurn.reads.map(read=>read.source.objectId)),new Set([legacy.objectId,current.objectId,rejected.objectId]),'both queued supplement sources must remain readable at initial activation');
  for(const word of ['RED','BLUE','GREEN'])assert(deltaTurn.reads.some(read=>read.text.includes(word)));
  for(const text of ['Delta queued input requires legacy RED evidence','Delta queued input also requires current BLUE evidence'])assert.equal(deltaTurn.text.split(text).length-1,1);
  assert(betaTurn.denied.some(source=>source.workId===legacy.workId),'a source bound to a different Work does not confer authority');
  await f.close(gamma.id);
  const epsilonTurn=await f.finish(epsilon.id);
  assert.deepEqual(epsilonTurn.selected,[current]);
  await f.close(delta.id);
  const zetaTurn=await f.finish(zeta.id);
  assert.deepEqual(zetaTurn.selected,[]);assert.equal(zetaTurn.denied.length,3);
  await f.close(epsilon.id);await f.close(zeta.id);
  assert.equal(f.c.store.used(),0);assert.equal(f.peakQuota,2);
  for(const work of tasks.map(task=>f.c.store.find(task.work.id))){
    assert.equal(work.status,'ended');assert.equal(work.closure.phase,'complete');
    assert.equal(f.c.store.state.jobs.filter(job=>job.target===work.id&&job.type==='initial').length,1);
    assert.equal(f.c.store.state.jobs.filter(job=>job.target===work.id&&job.type==='supplement').length,work.id===alpha.id?1:0);
  }
  assert(!f.c.store.state.jobs.some(job=>['maintenance','backstage'].includes(job.type)),'no hidden model fanout');
});
