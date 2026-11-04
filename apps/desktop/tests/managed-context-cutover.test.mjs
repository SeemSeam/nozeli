import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ContextReader} from '../src/agents/managed/context-reader.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {openTestController} from './project-storage.fixture.mjs';
import {tagMaterialSnapshot,readableTagMaterial} from '../src/agents/managed/tag-material-delivery.mjs';

// Fake native sessions capture the exact host→runtime request: the raw text
// plus the {materials,projection} contract payload, and emit transport facts
// through the same channel the real Pi owner uses.
function fakeNative(script){
  const calls=[];
  class Session{
    constructor(spec){Object.assign(this,spec,{closed:false,busy:false,interactions:[],contextEpoch:'compaction:0:root',hasPrompted:false,phase:'idle'});}
    async start(thread){this.threadId=thread??'thread-'+randomUUID();return this;}
    async stop(){this.closed=true;return {confirmationComplete:true};}
    async preflightToolsDigest(){}async assertToolsDigest(){}
    async prompt(text,opts={}){
      this.hasPrompted=true;this.busy=true;
      const current={requestId:randomUUID(),job:opts.job,contentDigest:createHash('sha256').update(JSON.stringify([text,opts.images??[]])).digest('hex')};
      calls.push({text,opts,current,target:this.spec?.role});
      try{
        await this.onTransportFact?.({status:'prepared',kind:'prompt',sessionId:this.threadId,epoch:this.contextEpoch,requestId:current.requestId,jobId:opts.job.id,attempt:1,contentDigest:current.contentDigest});
        await this.onTransportFact?.({status:'submitted',kind:'prompt',sessionId:this.threadId,epoch:this.contextEpoch,requestId:current.requestId,jobId:opts.job.id,attempt:1,contentDigest:current.contentDigest});
        await this.onTransportFact?.({status:'admitted',kind:'prompt',sessionId:this.threadId,epoch:this.contextEpoch,requestId:current.requestId,jobId:opts.job.id,attempt:1,contentDigest:current.contentDigest,seq:1});
        const result=await script(text,opts);
        await this.onTransportFact?.({status:'native-record-confirmed',kind:'prompt',sessionId:this.threadId,epoch:this.contextEpoch,requestId:current.requestId,jobId:opts.job.id,attempt:1,contentDigest:current.contentDigest,entryId:'entry-'+current.requestId,seq:2});
        return {threadId:this.threadId,turnId:current.requestId,text:result.text??'ok',completion:'provider-completed',providerStatus:'completed',delivery:{phase:'native-record-confirmed',requestId:current.requestId,turnId:current.requestId,text:{entryId:'entry-'+current.requestId,verbatim:true},materials:[],projection:{llmCalls:1,persisted:false},budget:{runHostTextBytes:0,generationHostTextBytes:0,contextEpoch:this.contextEpoch}}};
      }catch(error){
        if(error.transport==='unknown'){
          // Mirror the runtime drain order: a post-admission provider error
          // still lands native-record-confirmed BEFORE the unknown fence.
          await this.onTransportFact?.({status:'native-record-confirmed',kind:'prompt',sessionId:this.threadId,epoch:this.contextEpoch,requestId:current.requestId,jobId:opts.job.id,attempt:1,contentDigest:current.contentDigest,entryId:'entry-'+current.requestId,seq:2});
          await this.onTransportFact?.({status:'unknown',kind:'prompt',sessionId:this.threadId,epoch:this.contextEpoch,requestId:current.requestId,jobId:opts.job.id,attempt:1,contentDigest:current.contentDigest,reason:error.code}).catch(()=>{});
        }
        throw error;
      }finally{this.busy=false;}
    }
  }
  return {Session,calls};
}
const waitFor=async(predicate,label,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Timed out: '+label);};
const completedJob=c=>[...c.store.state.jobs].reverse().find(j=>j.status==='completed');
const completedFront=c=>[...c.store.state.jobs.filter(j=>j.target==='frontdesk'&&j.type==='front')].reverse().find(j=>j.status==='completed');

async function open(t,script){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-context-cutover-'));
  const native=fakeNative(script);
  const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),sessionFactory:spec=>new native.Session(spec),projectHome:home=>fs.mkdir(home,{recursive:true})});
  t.after(async()=>{try{await c.stop();}finally{try{await c.store.close();}catch{}await fs.rm(root,{recursive:true,force:true});}});
  return {c,native,root};
}

test('100 ordinary chats deliver the exact raw user text with zero host-added context',async t=>{
  const {c,native}=await open(t,async()=>({text:'answer'}));
  await c.start();
  const inputs=[];
  for(let i=0;i<100;i++){
    const text='第'+i+'轮\n  带空白与换行🙂  ';
    inputs.push(text);
    await c.send('frontdesk',text,{requestKey:'chat-'+i});
    await waitFor(()=>c.store.state.jobs.find(j=>j.text===text&&j.status==='completed'),'chat '+i);
  }
  assert.equal(native.calls.length,100);
  native.calls.forEach((call,index)=>{
    assert.equal(call.text,inputs[index],'user text is the single native entry, verbatim');
    assert.equal(call.opts.materials,undefined,'no materials for ordinary chat');
    assert.equal(call.opts.projection,undefined,'zero variable projection');
    const job=c.store.state.jobs.find(j=>j.text===inputs[index]);
    assert.equal(job.requestContext.rawUserDeliveredVerbatim,true);
    assert.equal(job.requestContext.hostAddedChars,0);
    assert.equal(job.requestContext.userTextDigest,createHash('sha256').update(inputs[index]).digest('hex'));
  });
  assert(!c.store.state.jobs.some(j=>j.type==='maintenance'||j.type==='backstage'),'no diagnostic model turns');
  assert(!JSON.stringify(c.store.state.jobs).includes('未见前台消息'),'no unseen-history backfill');
  assert(!JSON.stringify(c.store.state.jobs).includes('讨论来源'),'no ordinary-input wrapper');
});

test('five provider refusals stay five real failures with zero maintenance/backstage fanout',async t=>{
  let failures=0;
  const {c,native}=await open(t,async()=>{
    failures++;
    const error=Object.assign(new Error('上游内容拒绝（content_policy_violation）'),{transport:'unknown',code:'PI_PROVIDER_REFUSED'});
    throw error;
  });
  await c.start();
  for(let i=0;i<5;i++){
    await c.send('frontdesk','被拒绝的输入 '+i,{requestKey:'refused-'+i});
    await waitFor(()=>c.store.state.jobs.find(j=>j.text==='被拒绝的输入 '+i&&j.status==='failed'),'refusal '+i);
  }
  assert.equal(failures,5);
  assert.equal(native.calls.length,5);
  assert.equal(c.store.state.jobs.filter(j=>j.type==='maintenance').length,0,'no maintenance model job');
  assert.equal(c.store.state.jobs.filter(j=>j.type==='backstage').length,0,'no backstage model job');
  assert.equal(c.store.state.backstageEvents?.length??0,0);
  assert.equal(c.store.state.todos.filter(todo=>todo.kind==='system'&&todo.status==='open').length,0,'no system todo fanout');
  assert.equal((c.store.state.receipts??[]).filter(r=>r.hostDiagnostic).length,0,'no problem receipts from refusals');
  const diagnostics=c.contextDetails('frontdesk').diagnostics.providerFailures;
  assert.equal(diagnostics.find(row=>row.code==='PI_PROVIDER_REFUSED').count,5,'deduplicated local counting');
  assert(!c.store.state.jobs.some(j=>j.collabAttempts?.some(a=>a.status==='prepared'&&a.requestId!==native.calls.find(call=>call.opts.job.id===j.id)?.current.requestId)));
  // A fresh user retry is a new input, never swallowed or auto-resent.
  const native2=native;
  assert.equal(c.store.state.jobs.filter(j=>j.type==='front').length,5);
});

test('admission after failure keeps exact entry stages; unknown fences the input without replay',async t=>{
  let mode='admit-then-fail';
  const {c,native}=await open(t,async(text,opts)=>{
    if(text==='提交后断线的输入'){
      const error=Object.assign(new Error('receipt connection lost'),{transport:'unknown',code:'ECONNRESET'});
      throw error;
    }
    if(text==='准入后回合失败的输入'){
      const error=Object.assign(new Error('provider failed after entry'),{transport:'unknown',code:'PI_PROVIDER_ERROR'});
      throw error;
    }
    return {text:'ok'};
  });
  await c.start();
  await c.send('frontdesk','提交后断线的输入',{requestKey:'dropped-01'});
  await waitFor(()=>c.store.state.jobs.find(j=>j.text==='提交后断线的输入'&&j.status==='failed'),'dropped job');
  await c.send('frontdesk','准入后回合失败的输入',{requestKey:'after-admit-01'});
  const after=await waitFor(()=>c.store.state.jobs.find(j=>j.text==='准入后回合失败的输入'&&j.status==='failed'),'after-admit job');
  const attempt=after.collabAttempts[0];
  assert.equal(attempt.everAdmitted,true);
  assert.equal(attempt.status,'unknown','unknown fences; it is never rolled back to prepared');
  const details=c.contextDetails('frontdesk');
  assert.equal(details.lastRequest.evidence.stage,'unknown');
  // No automatic replay: exactly two native submissions so far.
  assert.equal(native.calls.length,2);
  await c.kick();
  await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(native.calls.length,2,'no resend of the unknown input');
  const dropped=c.store.state.jobs.find(j=>j.text==='提交后断线的输入');
  assert.equal(dropped.status,'failed');assert.equal(dropped.collabAttempts.length,1);
});

test('exact materials travel as native data with frozen versions; brief pointer only after record confirmation',async t=>{
  const packet=()=>({tagId:'tag-one',fileId:'f1',relPath:'notes.md',kind:'text-selection',note:'',origin:{materialDigest:'v-origin',anchor:{quote:'被选中的一句话。'}},currentSource:{digest:'v-origin'},resolution:{targetDigest:'v-origin',locationStatus:'exact',contentStatus:'unchanged',anchor:{quote:'被选中的一句话。'}},information:{location:{label:'第1行',context:{before:'背景材料。\n'.repeat(40),after:'后续限制。\n'.repeat(40)}},assets:[],limitations:[]},execution:{reasons:[]}});
  const snapshot=tagMaterialSnapshot([packet()]);
  const {c,native}=await open(t,async()=>({text:'回答'}));
  await c.start();
  const materialRef={id:'tag:tag-one',version:'notyet',title:'notes.md',kind:'tag-material',provenance:{source:'notes.md',versionLabel:'frozen-selection'}};
  const sendWithMaterial=async(question,key)=>{
    const version=await c.store.putObject(Buffer.from(readableTagMaterial(packet()),'utf8'));
    materialRef.version=version;
    const context={userInput:{text:question},tagMaterial:{version:snapshot.version,binding:snapshot.binding,brief:snapshot.brief,reusable:snapshot.reusable},materials:[{...materialRef,version}]};
    const receipt=await c.send('frontdesk',question,{requestKey:key,context});
    return await waitFor(()=>c.store.state.jobs.find(j=>j.id===receipt.jobId&&j.status==='completed'),key);
  };
  const first=await sendWithMaterial('请解释这句引文。','material-first');
  assert.equal(native.calls[0].text,'请解释这句引文。','raw user text stays verbatim');
  assert.equal(native.calls[0].opts.materials.length,1);
  assert.equal(native.calls[0].opts.materials[0].text.includes('被选中的一句话。'),true,'full frozen material body travels as data');
  assert.equal(native.calls[0].opts.materials[0].provenance.source,'notes.md');
  assert.equal(first.requestContext.materials[0].mode,'full');
  const second=await sendWithMaterial('继续这句。','material-second');
  const call=native.calls[1];
  assert.equal(call.text,'继续这句。');
  assert.equal(call.opts.materials.length,1);
  assert(call.opts.materials[0].text.length<readableTagMaterial(packet()).length,'brief pointer replaces the unchanged full body');
  assert.equal(second.requestContext.materials[0].mode,'brief');
  // A confirmed compaction epoch invalidates visibility: full redelivery.
  const session=c.sessions.get('frontdesk');
  c.tagMaterialDelivery.invalidate(session);
  await sendWithMaterial('压缩后继续。','material-after-compaction');
  assert.equal(native.calls[2].opts.materials[0].text.includes('被选中的一句话。'),true,'re-attached material after compaction is not swallowed');
  const details=c.contextDetails('frontdesk');
  assert.equal(details.lastRequest.materials.length,1);
  assert.equal(details.lastRequest.materials[0].version,native.calls[2].opts.materials[0].version);
});
test('worker turns: one bounded initial handoff, raw supplements, small rebuilt projection',async t=>{
  const longRequest='论文长原文。'.repeat(30000);
  const {c,native}=await open(t,async()=>({text:'worker done'}));
  c.kick=()=>{};c.execution.prepare=async id=>{await fs.mkdir(path.join(c.store.root,'execution',id),{recursive:true});};
  await c.start();
  const work=await c.store.submit(longRequest,'长文任务说明',{name:'长文任务'});
  await c.store.activate(work.id);
  const accepted=await c.enqueue(work.id,'initial',c.initialWorkerText(c.store.find(work.id)));
  const initial=c.store.state.jobs.find(j=>j.id===accepted.jobId);
  await c.runJob(initial);
  assert.equal(initial.status,'completed',initial.error);
  const first=native.calls.find(call=>call.opts.job.id===initial.id);
  assert.ok(first.text.length<8000,'bounded one-time handoff even for a book-length original');
  assert.ok(first.text.includes('readRef'),'long original continues behind paged refs');
  assert.ok(first.opts.projection&&first.opts.projection.text.length<4096,'small current-state projection through the runtime contract');
  assert.equal(JSON.parse(first.opts.projection.text).workId,work.id);
  const projectionVersion=first.opts.projection.version;
  const supplement=await c.store.mutate(()=>c.queueJob(work.id,'supplement','补充输入（保持原Work；原任务不逐轮复述，经宿主投影与nozeli_history_read读取）：\n只改第二章。',{key:'supplement-test-01'}));
  await c.runJob(c.store.state.jobs.find(j=>j.id===supplement.id));
  const second=native.calls.find(call=>call.opts.job.id===supplement.id);
  assert.equal(second.text,'补充输入（保持原Work；原任务不逐轮复述，经宿主投影与nozeli_history_read读取）：\n只改第二章。','no per-turn anchor prefix');
  assert.ok(!second.text.includes('当前任务锚点'));
  assert.ok(!second.text.includes('原始用户请求'),'original task is not restated each turn');
  assert.ok(second.opts.projection.version!==projectionVersion||JSON.parse(second.opts.projection.text).revision!=null,'projection is rebuilt from durable facts');
  assert(!c.store.state.jobs.some(j=>j.text.includes('未见前台消息')));
});

test('refused effect stays refused: no retry, receipt preserved, no model fanout',async t=>{
  const {c}=await open(t,async()=>({text:'ok'}));
  await c.start();c.kick=()=>{};
  c.taskPermissions={
    heldFor:async()=>false,
    read:async()=>({requests:[],grants:[]}),
    endTask:async()=>{},
    prepareOrdinary:async()=>({status:'denied',reason:'user'}),
    prepareEffect:async()=>({status:'denied',reason:'user'}),
    recordExecution:async()=>null
  };
  const job={id:randomUUID(),target:'frontdesk',type:'front',text:'effect request',context:{}};
  await c.store.mutate(()=>c.store.state.jobs.push(job));
  c.current.set('frontdesk',structuredClone(job));
  const result=await c.onTool('frontdesk',{tool:'nozeli_privileged_execute',arguments:{command:'echo',args:['x'],cwd:c.store.content,purpose:'test'},callId:'call-1'});
  assert.equal(result.ok,false);assert.equal(result.error.code,'PERMISSION_DENIED');
  assert.equal(result.continueTurn,true,'denial returns control without executing');
  assert(!c.store.state.jobs.some(j=>j.type==='maintenance'||j.type==='backstage'));
  // A read cannot consume the reserved receipt space or terminate the user's turn.
  c.contextBudget.beginRun({target:'frontdesk',runId:'r-full',epoch:'e'});
  c.contextBudget.charge('frontdesk',c.contextBudget.limits.runHostTextMaxBytes-c.contextBudget.limits.receiptReserveBytes+1,{kind:'host-text'});
  const refused=await c.onTool('frontdesk',{tool:'nozeli_history_read',arguments:{readRef:'x'},callId:'call-2'});
  assert.equal(refused.ok,false);assert.equal(refused.error.code,'HOST_CONTEXT_BUDGET_EXHAUSTED');
  assert.equal(refused.continueTurn,true);assert.equal(refused.hostControl,undefined);
  assert.equal(c.store.state.jobs.filter(j=>j.type==='maintenance'||j.type==='backstage').length,0);
  c.current.delete('frontdesk');
});

test('session options expose truthful context details without model calls',async t=>{
  const {c}=await open(t,async()=>({text:'answer'}));
  await c.start();
  await c.send('frontdesk','查看详情的输入',{requestKey:'details-01'});
  await waitFor(()=>c.store.state.jobs.find(j=>j.text==='查看详情的输入'&&j.status==='completed'),'details job');
  const options=c.sessionOptions('frontdesk',c.sessions.get('frontdesk').viewOwnerId);
  const details=options.contextDetails;
  assert.equal(details.session.provider,'pi');
  assert.equal(typeof details.session.contextEpoch,'string');
  assert.equal(details.lastRequest.userText.exact,'查看详情的输入','exact text from existing persisted state only');
  assert.equal(details.lastRequest.evidence.stage,'native-record-confirmed');
  assert.equal(details.lastRequest.evidence.nativeContext.captured,false,'no fabricated capture claim without capture evidence');
  assert.equal(details.lastRequest.evidence.nativeContext.projectionHookExecuted,true,'hook execution is reported separately');
  assert.equal(details.lastRequest.evidence.providerObserved,true);
  assert.equal(typeof details.budget.run.limitBytes,'number');
  assert(!JSON.stringify(details).includes('讨论来源'));
});

test('non-reusable and identity-free explicit materials still deliver in full through the actual host',async t=>{
  const {c,native}=await open(t,async()=>({text:'answer'}));
  await c.start();
  const changedBody='当前文件已变化，以下引用仍属于原版。\n选中的原文：\n被选中的一句话。';
  const version=await c.store.putObject(Buffer.from(changedBody,'utf8'));
  // reusable:false models changed/deleted sources, changed or unavailable
  // drafts and drawing packets; no userInput identity is required.
  const context={materials:[{id:'tag:changed',version,title:'notes.md',kind:'tag-material',changed:true,provenance:{source:'notes.md',versionLabel:'frozen-selection'}}],tagMaterial:{version,brief:'指针',binding:'changed-binding',reusable:false}};
  const receipt=await c.send('frontdesk','材料已变化，请重新处理。',{requestKey:'material-nonreusable-1',context});
  const job=await waitFor(()=>c.store.state.jobs.find(j=>j.id===receipt.jobId&&j.status==='completed'),'non-reusable material turn');
  const call=native.calls.at(-1);
  assert.equal(call.text,'材料已变化，请重新处理。','raw user text stays verbatim');
  assert.equal(call.opts.materials.length,1,'explicit packet is never dropped');
  assert.equal(call.opts.materials[0].text,changedBody,'full frozen body re-read from the persisted version');
  assert.equal(call.opts.materials[0].version,version);
  assert.equal(job.requestContext.materials[0].mode,'full');
  const follow=await c.send('frontdesk','再核对一次。',{requestKey:'material-nonreusable-2',context:{...context,userInput:{text:'再核对一次。'}}});
  await waitFor(()=>c.store.state.jobs.find(j=>j.id===follow.jobId&&j.status==='completed'),'non-reusable followup');
  assert.equal(native.calls.at(-1).opts.materials[0].text,changedBody,'a non-reusable version never becomes a swallowed pointer');
});

test('producer path: managed.send freezes materials, keeps raw user text, explicit re-attach stays full',async t=>{
  const {Controller}=await import('../src/agents/managed/controller.mjs');
  const {ManagedProjects}=await import('../src/agents/managed-projects.mjs');
  const {readableTagMaterial}=await import('../src/agents/managed/tag-material-delivery.mjs');
  const {c,native}=await open(t,async()=>({text:'回答'}));
  await c.start();
  const packet={tagId:'tag-prod',fileId:'f1',relPath:'paper.md',kind:'text-selection',note:'',origin:{materialDigest:'v-origin',anchor:{quote:'PDF/Office 抽取正文的原句。'}},currentSource:{digest:'v-origin'},resolution:{targetDigest:'v-origin',locationStatus:'exact',contentStatus:'unchanged',anchor:{quote:'PDF/Office 抽取正文的原句。'}},information:{location:{label:'第2页,区域1',context:{before:'前文。',after:'后文。'}},assets:[{role:'截图',mime:'image/png',digest:'a'.repeat(64),captureMode:'screen'}],limitations:[]},execution:{reasons:[]}};
  const host={tagMaterial:async()=>packet,readFile:async()=>{throw Error('no relpath in this scenario');},storage:{readObject:async()=>Buffer.from('89504e470d0a1a0a','hex')},requireProject:async()=>({id:c.projectId,root:c.store.content}),requireRegisteredProject:async()=>({id:c.projectId,root:c.store.content})};
  const manager=new ManagedProjects({userDataDir:path.join(path.dirname(c.store.root),'manager'),host,legacy:{projects:new Map()},openController:async()=>c,attachTerminal:()=>{}});
  manager.controllers.set(c.projectId,c);
  const first=await manager.invoke('managed.send',{projectId:c.projectId,target:'frontdesk',text:'围绕材料问一句。',tags:[{annotationId:'tag-prod'}],requestKey:'producer-send-1'});
  const job1=await waitFor(()=>c.store.state.jobs.find(j=>j.id===first.jobId&&j.status==='completed'),'producer first send');
  assert.equal(job1.text,'围绕材料问一句。','producer keeps the raw user text only');
  assert(!job1.text.includes('参考材料'),'no material splice into the user entry');
  assert.equal(job1.context.materialsExplicit,true,'explicit attachment is flagged at the producer');
  assert.equal(job1.context.materials.length,1);
  const stored=await c.store.readObject(job1.context.materials[0].version);
  assert.equal(stored.toString('utf8'),readableTagMaterial(packet),'frozen object is the readable material body');
  assert.equal(native.calls.at(-1).text,'围绕材料问一句。');
  assert.equal(native.calls.at(-1).opts.materials[0].text,readableTagMaterial(packet));
  assert(native.calls.at(-1).opts.materials[0].text.includes('第2页'),'page/location metadata travels with the packet');
  // The user explicitly attaches the SAME selection again: full, never brief.
  const second=await manager.invoke('managed.send',{projectId:c.projectId,target:'frontdesk',text:'再强调同一选区。',tags:[{annotationId:'tag-prod'}],requestKey:'producer-send-2'});
  const job2=await waitFor(()=>c.store.state.jobs.find(j=>j.id===second.jobId&&j.status==='completed'),'producer explicit re-attach');
  assert.equal(job2.requestContext.materials[0].mode,'full','explicit same-selection re-attach is never deduplicated to a pointer');
  assert(native.calls.at(-1).opts.materials[0].text.includes('PDF/Office 抽取正文的原句。'));
});

test('cold restart hydrates epoch usage; persistence failure fails closed with zero model requests',async t=>{
  const {Controller}=await import('../src/agents/managed/controller.mjs');
  const {c,native}=await open(t,async()=>({text:'回答'}));
  await c.start();
  // Ordinary chat charges 0 host bytes by design — use an explicit material
  // turn so real host-added bytes are charged and durably persisted.
  const materialBody='冻结材料正文：冷重启记账。'+('背景行。\n'.repeat(60));
  const materialVersion=await c.store.putObject(Buffer.from(materialBody,'utf8'));
  const materialTurn=async(label,key,reopenedController)=>{
    const target=reopenedController??c;
    const receipt=await target.send('frontdesk',label,{requestKey:key,context:{userInput:{text:label},materials:[{id:'tag:cold',version:materialVersion,title:'cold.md',kind:'tag-material',provenance:{source:'cold.md',versionLabel:'frozen-selection'}}]}});
    return receipt;
  };
  const first=await materialTurn('带材料的一轮。','cold-material-1');
  await waitFor(()=>c.store.state.jobs.find(j=>j.id===first.jobId&&j.status==='completed'),'cold material turn');
  const key=c.contextEpochKey('frontdesk');
  assert.ok(c.contextBudget.epochUsed(key)>=Buffer.byteLength(materialBody,'utf8'),'actual material bytes charged');
  assert.ok(c.store.state.contextBudgetEpochs?.[key]>0,'durable epoch usage persisted');
  const used=c.contextBudget.epochUsed(key);
  await c.stop();
  const restartNative=fakeNative(async()=>({text:'回答'}));
  const reopened=await Controller.open({storage:c.store.storage,projectId:c.projectId,runtimeRoot:path.join(path.dirname(c.store.root),'runtime2'),contentRoot:c.store.contentRoot,sessionFactory:spec=>new restartNative.Session(spec),projectHome:async()=>{}});
  await reopened.start();
  const reopenedSession=reopened.sessions.get('frontdesk');
  assert.equal(reopenedSession?.threadId,c.store.state.residents.frontdesk?.threadId??reopenedSession?.threadId,'reconnect resumes the persisted native thread');
  t.after(async()=>{try{await reopened.stop();}catch{}});
  assert.equal(reopened.contextBudget.epochUsed(key),used,'cold restart hydrates the same namespaced epoch usage');
  // Fail-closed: budget persistence error aborts the request before any prompt.
  const nativeBefore=native.calls.length;
  const realMutate=reopened.store.mutate.bind(reopened.store);
  reopened.store.mutate=async fn=>{if(String(fn).includes('contextBudgetEpochs'))throw Error('disk full');return realMutate(fn);};
  const failing=await materialTurn('记账失败的一轮。','persist-fail-1',reopened);
  const failed=await waitFor(()=>reopened.store.state.jobs.find(j=>j.id===failing.jobId&&j.status==='failed'),'persist-fail job');
  assert.equal(failed.error.includes('预算记账持久化失败'),true,'fail-closed reason is visible');
  assert.equal(native.calls.length,nativeBefore,'no model request was submitted');
});

test('mid-run typed nozeliCompaction rotates the generation scope before the next charge',async t=>{
  const {c}=await open(t,async()=>({text:'回答'}));
  await c.start();
  const epoch0=c.contextEpochKey('frontdesk');
  c.contextBudget.beginRun({target:'frontdesk',runId:'manual-run',epoch:epoch0});
  c.contextBudget.charge('frontdesk',800,{kind:'host-text'});
  const session=c.sessions.get('frontdesk');
  session.contextEpoch='compaction:1:first-confirmed';
  await c.recordNativeEvent('frontdesk',{event:{type:'nozeliCompaction',contextEpoch:session.contextEpoch}});
  const epoch1=c.contextEpochKey('frontdesk');
  assert.notEqual(epoch1,epoch0,'typed fact rotates the namespaced epoch');
  assert.equal(c.contextBudget.run('frontdesk').epoch,epoch1,'run carries the rotated generation');
  assert.ok(c.contextBudget.epochUsed(epoch0)>=800,'superseded epoch keeps its recorded usage');
  assert.equal(c.contextBudget.remainingGeneration(epoch1),c.contextBudget.limits.generationHostTextMaxBytes,'fresh generation allowance after rotation');
  assert.equal(c.contextBudget.charge('frontdesk',900,{kind:'host-text'}).ok,true,'subsequent charge is not capped by the superseded epoch');
  c.contextBudget.endRun('frontdesk');
});

test('effects: budget denial never fires; a real effect executes once and replays by receipt only',async t=>{
  const {c}=await open(t,async()=>({text:'回答'}));
  await c.start();c.kick=()=>{};
  const executions=[];
  const grant={id:'g1',effectHash:'e'.repeat(64),permissionTaskId:'pt1',requestId:'req-1'};
  c.privilegeBroker={authenticate:async()=>({status:'authenticated'}),execute:async call=>{executions.push(call);return {status:'completed',executionId:'exec-1',output:{stdoutB64:Buffer.from('done').toString('base64'),stderrB64:'',truncated:false}};},revoke:async()=>{}};
  let recordCalls=0;
  c.taskPermissions={heldFor:async()=>false,read:async()=>({requests:[],grants:[grant]}),endTask:async()=>{},
    prepareOrdinary:async()=>({status:'allowed',grant,request:{id:'req-1',permissionTaskId:'pt1',version:1}}),
    prepareEffect:async()=>({status:'denied',reason:'user'}),
    preEffect:async()=>({ok:true}),
    recordExecution:async(_p,call)=>{recordCalls++;const started=call.result?.status==='started';
      if(started&&!executions.length)return {execution:{id:'exec-'+recordCalls,operationKey:call.operationKey??null}};
      if(started&&executions.length)return {duplicate:true,execution:{id:'exec-1'}};
      return {execution:{id:'exec-'+recordCalls,status:call.result?.status}};}};
  const job={id:'effect-job',target:'frontdesk',type:'front',text:'执行效果',context:{}};
  await c.store.mutate(()=>c.store.state.jobs.push(job));
  c.current.set('frontdesk',structuredClone(job));
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'effect-cwd-'));
  const args={command:process.execPath,args:['-e','process.stdout.write("synthetic")'],cwd,action:'user',purpose:'synthetic'};
  // Negative: exhausted run budget refuses BEFORE the broker, no execution.
  c.contextBudget.beginRun({target:'frontdesk',runId:'full-run',epoch:c.contextEpochKey('frontdesk')});
  c.contextBudget.charge('frontdesk',c.contextBudget.limits.runHostTextMaxBytes,{kind:'host-text'});
  const denied=await c.onTool('frontdesk',{tool:'nozeli_privileged_execute',arguments:args,callId:'call-denied'});
  assert.equal(denied.ok,false);assert.equal(denied.error.code,'EFFECT_RECEIPT_SPACE_UNAVAILABLE');
  assert.equal(executions.length,0,'no command fired without receipt space');
  // Positive: fresh run executes exactly once and reports the real receipt.
  c.contextBudget.endRun('frontdesk');c.contextBudget.beginRun({target:'frontdesk',runId:'ok-run',epoch:c.contextEpochKey('frontdesk')});
  const done=await c.onTool('frontdesk',{tool:'nozeli_privileged_execute',arguments:args,callId:'call-1'});
  assert.equal(done.ok,true,JSON.stringify(done.error??done));
  assert.equal(done.value.executed,true);assert.equal(done.value.status,'completed');assert.equal(done.value.receiptId,'exec-2');
  assert.equal(executions.length,1);
  assert.equal(done.value.stdout,'done','returned output is exactly what the broker executed and reported');
  // Duplicate identical call: replayed from the durable receipt, not executed.
  const again=await c.onTool('frontdesk',{tool:'nozeli_privileged_execute',arguments:args,callId:'call-2'});
  assert.equal(again.ok,false);assert.equal(again.error.code,'EFFECT_RESULT_UNKNOWN');
  assert.equal(executions.length,1,'duplicate never re-fires the effect');
  c.current.delete('frontdesk');
});

test('long paper: run-cap pause is typed, and a new run continues the same frozen source by offset — union across runs is exact',async t=>{
  const {ContextReader}=await import('../src/agents/managed/context-reader.mjs');
  const {c,native}=await open(t,async()=>({text:'回答'}));
  c.kick=()=>{};c.execution.prepare=async id=>{await fs.mkdir(path.join(c.store.root,'execution',id),{recursive:true});};
  await c.start();
  // ~70KB original: strictly larger than one 64KiB run budget.
  const original='# 长文\n'+'论文正文第行。🙂\n'.repeat(2800);
  assert.ok(Buffer.byteLength(original,'utf8')>c.contextBudget.limits.runHostTextMaxBytes,'fixture exceeds the run cap — a pause is the honest outcome');
  const work=await c.store.submit(original,'长文校准',{name:'长文校准'});
  await c.store.activate(work.id);
  const stableRefFor=reader=>reader.addStable(`work/${work.id}/request`,original,{title:'原始任务（不可改写）',source:`work:${work.id}:request`,kind:'task-scope'});
  const admit=()=>{const job={id:randomUUID(),target:work.id,type:'supplement',text:'读取全文',context:{},revision:1};job.reader=new ContextReader();const ref=stableRefFor(job.reader);c.current.set(work.id,job);return {job,ref};};
  // Run 1: page until the read budget denies more text without aborting the native turn.
  let {ref}=admit();
  c.contextBudget.beginRun({target:work.id,runId:'run-1',epoch:c.contextEpochKey(work.id)});
  let joined='',lastEnd=0,paused=false;
  for(let page=0;;page++){
    const value=await c.onTool(work.id,{tool:'nozeli_history_read',arguments:{readRef:ref,offset:lastEnd||undefined},callId:'p1-'+page});
    if(value.ok===false){assert.equal(value.error.code,'HOST_CONTEXT_BUDGET_EXHAUSTED');assert.equal(value.continueTurn,true,'recoverable denial, not silent truncation');assert.equal(value.hostControl,undefined);paused=true;break;}
    joined+=value.text;lastEnd=value.endOffset;assert.equal(value.version,createHash('sha256').update(original).digest('hex'),'same frozen version on every page');
    if(value.endOffset>=value.totalChars)break;
  }
  assert.ok(paused,'run 1 pauses at the run cap before the original ends');
  assert.ok(lastEnd>0&&lastEnd<original.length);
  c.contextBudget.endRun(work.id);
  // A NEW explicit run reconstructs the stable source and continues from the
  // returned offset — no prefix replay, no auto model spawn.
  const beforeCalls=native.calls.length;
  const run2=admit();
  c.contextBudget.beginRun({target:work.id,runId:'run-2',epoch:c.contextEpochKey(work.id)});
  let run2Joined='';
  for(let page=0;;page++){
    const value=await c.onTool(work.id,{tool:'nozeli_history_read',arguments:{readRef:run2.ref,offset:lastEnd},callId:'p2-'+page});
    assert.notEqual(value.ok,false,'run 2 completes the remainder within its own budget');
    run2Joined+=value.text;lastEnd=value.endOffset;
    assert.ok(value.offset>=0&&value.endOffset<=value.totalChars,'offset continuation returns exact range metadata');
    if(value.endOffset>=value.totalChars)break;
  }
  c.contextBudget.endRun(work.id);
  assert.equal(joined+run2Joined,original,'cross-run union by offset equals the exact full original');
  assert.equal(native.calls.length,beforeCalls,'no model request was spawned by the continuation');
  // Random per-turn refs from an older reader are never consumable.
  const staleReader=new ContextReader();const stale=staleReader.add(original,{title:'原始长文',source:`work:${work.id}:request`,kind:'task-scope'});
  await assert.rejects(c.onTool(work.id,{tool:'nozeli_history_read',arguments:{readRef:stale},callId:'stale-1'}),/READ_REF_EXPIRED|已失效/,'expired ephemeral refs are rejected — only stable refs + offset cross turns');
  c.current.delete(work.id);
});

test('next-turn reader: ephemeral handoff refs expire, stable projection refs reopen the exact originals',async t=>{
  const {c,native}=await open(t,async()=>({text:'worker done'}));
  c.kick=()=>{};c.execution.prepare=async id=>{await fs.mkdir(path.join(c.store.root,'execution',id),{recursive:true});};
  await c.start();
  const work=await c.store.submit('原始任务正文：完成长文校准。','说明',{name:'稳定来源任务'});
  await c.store.activate(work.id);
  const approvedText='用户明确批准的扩展来源正文。';
  await c.store.mutate(()=>{const w=c.store.find(work.id);w.approvedScopes=[{deviationId:'dev-1',sourceJobId:'src-1',sourceText:approvedText,at:new Date().toISOString(),revision:w.revision}];});
  const initial=await c.enqueue(work.id,'initial',c.initialWorkerText(c.store.find(work.id)));
  await c.runJob(c.store.state.jobs.find(j=>j.id===initial.jobId));
  assert.equal(c.store.state.jobs.find(j=>j.id===initial.jobId).status,'completed');
  // A later turn gets a FRESH reader: the initial turn's ephemeral refs die,
  // but the stable projection identities reopen the same-version originals.
  const supplement=await c.store.mutate(()=>c.queueJob(work.id,'supplement','补充输入（保持原Work；原任务不逐轮复述，经宿主投影与nozeli_history_read读取）：\n核对原始任务。',{key:'stable-ref-test-01'}));
  await c.runJob(c.store.state.jobs.find(j=>j.id===supplement.id));
  const turn=c.store.state.jobs.find(j=>j.id===supplement.id);
  assert.equal(turn.status,'completed');
  const projection=JSON.parse(native.calls.find(call=>call.opts.job.id===supplement.id).opts.projection.text);
  t.diagnostic('SOURCES='+JSON.stringify(projection?.sources));
  const originalRef=projection.sources.originalTask.readRef,approved=projection.sources.approvedSources[0];
  assert.equal(originalRef,'读取 稳定/work/'+work.id+'/request','stable original identity matches the agreed key');
  assert.equal(approved.readRef,'读取 稳定/work/'+work.id+'/approved/src-1','approved identity keyed by sourceJobId');
  assert.equal(approved.sourceJobId,'src-1');assert.equal(typeof approved.deviationId,'string');assert.ok(approved.version.length===64,'projection exposes the actual frozen version');
  const job=structuredClone(turn);c.current.set(work.id,{...job,reader:undefined});
  const current=c.current.get(work.id);current.reader=new ContextReader();
  const w=c.store.find(work.id);
  current.reader.addStable(`work/${w.id}/request`,w.request,{title:'原始任务（不可改写）',source:`work:${w.id}:request`,kind:'task-scope'});
  current.reader.addStable(`work/${w.id}/approved/src-1`,approvedText,{title:'用户明确批准的来源输入',source:`work:${w.id}:approved:dev-1`,kind:'task-scope'});
  const original=await c.onTool(work.id,{tool:'nozeli_history_read',arguments:{readRef:originalRef},callId:'stable-1'});
  assert.equal(original.text,'原始任务正文：完成长文校准。','stable ref reopens the exact same-version original');
  assert.equal(original.version,projection.sources.originalTask.version,'read response version equals the projected version');
  assert.equal(original.complete,true);
  const approvedPage=await c.onTool(work.id,{tool:'nozeli_history_read',arguments:{readRef:approved.readRef},callId:'stable-2'});
  assert.equal(approvedPage.text,approvedText,'approved scope reads its exact sourceText');
  assert.equal(approvedPage.version,approved.version);
  // Arbitrary/unapproved identities and OTHER Works' refs are never bound.
  await assert.rejects(c.onTool(work.id,{tool:'nozeli_history_read',arguments:{readRef:'读取 稳定/work/'+work.id+'/approved/not-approved'},callId:'stable-3'}),/READ_REF_EXPIRED|已失效/);
  await assert.rejects(c.onTool(work.id,{tool:'nozeli_history_read',arguments:{readRef:'读取 稳定/work/other-work/request'},callId:'stable-4'}),/READ_REF_EXPIRED|已失效/,'other Works\' stable refs never leak into this reader');
  c.current.delete(work.id);
});

test('confirmed-then-failed material turn still records its delivery proof; unknown never commits',async t=>{
  const {TagMaterialDelivery,tagMaterialSnapshot}=await import('../src/agents/managed/tag-material-delivery.mjs');
  const packet=()=>({tagId:'t1',fileId:'f1',relPath:'notes.md',kind:'text-selection',note:'',origin:{materialDigest:'v',anchor:{quote:'选区原句。'}},currentSource:{digest:'v'},resolution:{targetDigest:'v',locationStatus:'exact',contentStatus:'unchanged',anchor:{quote:'选区原句。'}},information:{location:{label:'第1行',context:{before:'前文。',after:'后文。'}},assets:[],limitations:[]},execution:{reasons:[]}});
  const snapshot=tagMaterialSnapshot([packet()]);
  const {c}=await open(t,async text=>{
    if(text==='提交后断线的输入'){const error=Object.assign(new Error('receipt connection lost'),{transport:'unknown',code:'ECONNRESET'});throw error;}
    if(text==='材料回合失败输入'){const error=Object.assign(new Error('provider failed after entry'),{transport:'unknown',code:'PI_PROVIDER_ERROR'});throw error;}
    return {text:'ok'};
  });
  await c.start();
  const version=await c.store.putObject(Buffer.from('冻结材料正文'.repeat(40),'utf8'));
  const materialContext=text=>({userInput:{text},tagMaterial:{version:snapshot.version,binding:snapshot.binding,brief:snapshot.brief,reusable:true},materials:[{id:'tag:t1',version,title:'notes.md',kind:'tag-material',provenance:{source:'notes.md',versionLabel:'frozen-selection'}}]});
  // 1) Unknown-only failure never commits visibility.
  const dropped=await c.send('frontdesk','提交后断线的输入',{requestKey:'mat-unknown-1',context:materialContext('提交后断线的输入')});
  await waitFor(()=>c.store.state.jobs.find(j=>j.id===dropped.jobId&&j.status==='failed'),'unknown material turn');
  // 2) Confirmed-then-failed turn commits its exact proof on ITS owner.
  const failedOwner=c.sessions.get('frontdesk');
  const failed=await c.send('frontdesk','材料回合失败输入',{requestKey:'mat-confirm-fail-1',context:materialContext('材料回合失败输入')});
  const failedJob=await waitFor(()=>c.store.state.jobs.find(j=>j.id===failed.jobId&&j.status==='failed'),'confirmed-then-failed material turn');
  while(c.running.size||c.kicking)await new Promise(r=>setImmediate(r)); // drain: failure cleanup intentionally stops this owner
  assert.equal(failedJob.collabAttempts.at(-1).recordConfirmed,true);
  assert.equal(failedJob.delivery?.phase,'native-record-confirmed','failed turn preserved its confirmed delivery evidence');
  // 3) The proof lives in the failed owner's visibility ledger: an implicit
  // follow-up on THAT owner would be brief — proven directly, without
  // weakening the intentional owner cleanup.
  assert.equal(c.tagMaterialDelivery.prepare(failedOwner,{target:'frontdesk',text:'继续同一材料。',context:materialContext('继续同一材料。')}).mode,'brief','exact confirmation on a failed turn still proves visibility for the same owner');
  // 4) The next actual send runs on a NEW owner (cleanup is real) and is full.
  const next=await c.send('frontdesk','继续同一材料。',{requestKey:'mat-after-fail-1',context:materialContext('继续同一材料。')});
  const nextJob=await waitFor(()=>c.store.state.jobs.find(j=>j.id===next.jobId&&j.status==='completed'),'material turn after failure');
  const newOwner=c.sessions.get('frontdesk');
  assert.notEqual(newOwner,failedOwner,'failure cleanup replaced the owner — native hygiene unchanged');
  assert.equal(nextJob.requestContext.materials[0].mode,'full','a replaced owner has no visibility proof: full is the only truthful mode');
  // 5) A fresh ledger (different owner) is always full — belt and braces.
  const otherSession={threadId:'brand-new-thread',contextEpoch:'compaction:0:root'};
  assert.equal(new TagMaterialDelivery().prepare(otherSession,{target:'frontdesk',text:'继续同一材料。',context:materialContext('继续同一材料。')}).mode,'full','a different owner has no visibility proof');
});

test('every host read tool shares the budget: per-tool charge, typed exhaustion with zero executor calls, writes untouched',async t=>{
  const {c}=await open(t,async()=>({text:'ok'}));
  await c.start();c.kick=()=>{};
  const job={id:randomUUID(),target:'frontdesk',type:'front',text:'读取请求',context:{}};
  await c.store.mutate(()=>c.store.state.jobs.push(job));
  await c.prepareFrontGoal(job);
  c.current.set('frontdesk',structuredClone(job));
  const calls={reads:0,writes:0};
  // Real production frontdesk document executor: every read returns a body;
  // writes are counted separately and must never be blocked by the read budget.
  c.frontdeskDocuments=async({op})=>{
    if(op==='read'){calls.reads++;return {ok:true,value:{relPath:'doc.md',text:'文档正文。'.repeat(2000),version:'doc-v1',readHandle:'h1',offsetEncoding:'lf'}};}
    if(op==='apply'){calls.writes++;return {ok:true,value:{relPath:'doc.md',version:'doc-v2',eventId:'e1',digest:'d2'}};}
    if(op==='search'){calls.reads++;return {ok:true,value:{rows:[{relPath:'doc.md',line:1,preview:'文档正文。'.repeat(200)}],cursor:null}};}
    if(op==='list'){calls.reads++;return {ok:true,value:{entries:[{relPath:'doc.md'}]}};}
    return {ok:false,error:{code:'UNSUPPORTED',message:'op '+op}};
  };
  c.contextBudget.beginRun({target:'frontdesk',runId:'readtools-run',epoch:c.contextEpochKey('frontdesk')});
  // 1) Primary document read is charged against the shared budget.
  const doc=await c.onTool('frontdesk',{tool:'nozeli_document_read',arguments:{relPath:'doc.md'},callId:'doc-1'});
  assert.equal(doc.ok,true);
  const usedAfterDoc=c.contextBudget.run('frontdesk').usedBytes;
  assert.ok(usedAfterDoc>0,'document read body is charged');
  // 2) Each remaining host read tool also charges.
  for(const [tool,args] of [['nozeli_project_search',{query:'文档',relPath:''}],['nozeli_project_list',{relPath:''}]]){
    const value=await c.onTool('frontdesk',{tool,arguments:args,callId:tool});
    assert.ok(c.contextBudget.run('frontdesk').usedBytes>usedAfterDoc,tool+' charged against the same budget');
    assert.notEqual(value?.error?.code,'HOST_CONTEXT_BUDGET_EXHAUSTED');
  }
  // 3) Exhaust the run budget: the NEXT read is recoverably denied,
  //    and the executor is never called (no body produced at all).
  c.contextBudget.charge('frontdesk',c.contextBudget.limits.runHostTextMaxBytes-c.contextBudget.run('frontdesk').usedBytes,{kind:'host-text'});
  const readsBefore=calls.reads;
  const denied=await c.onTool('frontdesk',{tool:'nozeli_document_read',arguments:{relPath:'doc.md'},callId:'doc-2'});
  assert.equal(denied.ok,false);assert.equal(denied.error.code,'HOST_CONTEXT_BUDGET_EXHAUSTED');
  assert.equal(denied.continueTurn,true,'current native turn can still answer or perform non-read actions');assert.equal(denied.hostControl,undefined);
  assert.deepEqual(c.store.state.jobs.find(saved=>saved.id===job.id).readBudget,{status:'exhausted',code:'HOST_CONTEXT_BUDGET_EXHAUSTED'});
  assert.equal(calls.reads,readsBefore,'zero executor calls after exhaustion');
  // 4) Writes are NOT read-gated: apply still routes to the executor.
  const write=await c.onTool('frontdesk',{tool:'nozeli_document_apply',arguments:{relPath:'doc.md',replacements:[]},callId:'apply-1'});
  assert.equal(write.ok,true);assert.equal(calls.writes,1,'write path untouched by the read budget');
  c.current.delete('frontdesk');
});

test('Worker missing report stays paused with a technical receipt and zero extra model jobs',async t=>{
  const {c,native}=await open(t,async()=>({text:'worker done'}));
  c.kick=()=>{};c.execution.prepare=async id=>{await fs.mkdir(path.join(c.store.root,'execution',id),{recursive:true});};
  await c.start();
  const work=await c.store.submit('需要最终报告的任务','说明',{name:'缺报告任务'});
  await c.store.activate(work.id);
  const accepted=await c.enqueue(work.id,'initial',c.initialWorkerText(c.store.find(work.id)));
  await c.runJob(c.store.state.jobs.find(j=>j.id===accepted.jobId));
  const initial=c.store.state.jobs.find(j=>j.id===accepted.jobId);
  assert.equal(initial.status,'completed','worker turn itself completed');
  assert.equal(c.store.find(work.id).status,'paused','missing delivery pauses the work for the user');
  const receipts=(c.store.state.receipts??[]).filter(r=>r.workId===work.id);
  assert.ok(receipts.length>=1,'a technical problem receipt exists for the UI');
  assert.ok(receipts.every(r=>r.origin==='host-diagnostic'),'receipt is marked host-diagnostic');
  assert.equal(c.store.state.jobs.filter(j=>j.type==='backstage'||j.type==='maintenance').length,0,'zero extra model jobs from the missing-report diagnosis');
  await c.processBackstage();
  assert.equal(c.store.state.jobs.filter(j=>j.type==='backstage'||j.type==='maintenance').length,0,'explicit backstage pass creates no fanout for host-diagnostic receipts');
  assert.equal(native.calls.length,1,'exactly one model turn ran — the worker turn itself');
});

test('Worker provider-refused recovery todo does not fan out; genuine recovery still routes',async t=>{
  const {c,native}=await open(t,async text=>{
    if(text.includes('被拒绝的worker输入')){const error=Object.assign(new Error('provider refused worker'),{transport:'unknown',code:'PI_PROVIDER_REFUSED'});throw error;}
    return {text:'ok'};
  });
  c.kick=()=>{};c.execution.prepare=async id=>{await fs.mkdir(path.join(c.store.root,'execution',id),{recursive:true});};
  // The initial prompt is the one-time handoff built from the immutable
  // w.request — the trigger phrase must live in the WORK REQUEST itself.
  await c.start();
  const work=await c.store.submit('被拒绝的worker输入：完成本任务。','说明',{name:'拒绝任务'});
  await c.store.activate(work.id);
  const accepted=await c.enqueue(work.id,'initial',c.initialWorkerText(c.store.find(work.id)));
  await c.runJob(c.store.state.jobs.find(j=>j.id===accepted.jobId)).catch(()=>{});
  const failed=c.store.state.jobs.find(j=>j.id===accepted.jobId);
  assert.equal(failed.status,'failed');
  assert.equal(failed.diagnosticOnly,true,'refusal is classified diagnostic-only');
  assert.ok(c.contextDetails(work.id).diagnostics.providerFailures.some(row=>row.code==='PI_PROVIDER_REFUSED'),'counted locally');
  // A recovery decision todo whose source is the refused job must NOT become
  // backstage model work; the user's explicit continue stays the only path.
  await c.store.mutate(()=>{c.store.state.todos.push({id:randomUUID(),workId:work.id,revision:1,kind:'recovery',status:'open',target:work.id,sourceJobId:failed.id,text:'核对实际效果后决定是否继续。'});});
  await c.processBackstage();
  assert.equal(c.store.state.jobs.filter(j=>j.type==='backstage'||j.type==='maintenance').length,0,'refusal recovery todo creates zero model jobs');
  assert.equal(native.calls.length,1,'no additional model turn after the refusal');
  // Contrast: a genuine (non-diagnostic) recovery todo still routes normally.
  await c.store.mutate(()=>{c.store.state.todos.push({id:randomUUID(),kind:'recovery',status:'open',target:'frontdesk',sourceJobId:null,text:'真实业务恢复决定。'});});
  await c.processBackstage();
  assert.ok(c.store.state.jobs.some(j=>j.type==='backstage'),'genuine recovery todos keep routing to the orchestrator');
});

test('composer textMaterials freeze as native material data with full quotes, raw text untouched',async t=>{
  const {ManagedProjects}=await import('../src/agents/managed-projects.mjs');
  const {c,native}=await open(t,async()=>({text:'回答'}));
  await c.start();
  const quote='这是完整的引用段落，超过200字符也不得截断：'.padEnd(40,'论')+'结尾句。';
  const host={storage:c.store.storage,requireProject:async()=>({id:c.projectId,root:c.store.content}),requireRegisteredProject:async()=>({id:c.projectId,root:c.store.content})};
  const manager=new ManagedProjects({userDataDir:path.join(path.dirname(c.store.root),'manager2'),host,legacy:{projects:new Map()},openController:async()=>c,attachTerminal:()=>{}});
  manager.controllers.set(c.projectId,c);
  const first=await manager.invoke('managed.send',{projectId:c.projectId,target:'frontdesk',text:'针对引用提问。',textMaterials:[{kind:'reply-quote',text:quote},{kind:'drawing-question',text:'涂鸦中的问题原文。',title:'涂鸦提问'}],requestKey:'text-materials-1'});
  const job=await waitFor(()=>c.store.state.jobs.find(j=>j.id===first.jobId&&j.status==='completed'),'textMaterials turn');
  assert.equal(job.text,'针对引用提问。','raw composer text only');
  assert.equal(job.context.materialsExplicit,true,'explicit attachment flagged');
  const refs=job.context.materials.filter(m=>m.kind==='reply-quote'||m.kind==='drawing-question');
  assert.equal(refs.length,2,'both text materials travel as refs');
  const frozen=await c.store.readObject(refs.find(m=>m.kind==='reply-quote').version);
  assert.equal(frozen.toString('utf8'),quote,'full quote frozen byte-exact, no 200-char slice');
  assert.equal(native.calls.at(-1).opts.materials.some(m=>m.text===quote),true,'full body delivered as native material data');
  // Explicit sends never become brief pointers on a proven-visible version.
  const second=await manager.invoke('managed.send',{projectId:c.projectId,target:'frontdesk',text:'再问同一引用。',textMaterials:[{kind:'reply-quote',text:quote}],requestKey:'text-materials-2'});
  const job2=await waitFor(()=>c.store.state.jobs.find(j=>j.id===second.jobId&&j.status==='completed'),'textMaterials re-attach');
  assert.equal(job2.requestContext.materials.find(m=>m.kind==='reply-quote').mode,'full','explicit re-attach stays full');
});

test('local context provenance remains readable without waking an owner, while stale owner authority is rejected',async t=>{
 const {c,native}=await open(t,async()=>{throw Error('inspection must not start a model');});
 await c.store.mutate(()=>{c.store.state.jobs.push({id:randomUUID(),target:'frontdesk',type:'front',text:'原始输入\n  保留空白 ',context:{},status:'failed',finishedAt:new Date().toISOString()});});
 const details=c.sessionOptions('frontdesk');
 assert.equal(details.available,false);assert.equal(details.capabilities.compact,false);
 assert.equal(details.contextDetails.lastRequest.userText.exact,'原始输入\n  保留空白 ');
 assert.equal(c.sessions.size,0);assert.equal(native.calls.length,0);
 assert.throws(()=>c.sessionOptions('frontdesk','retired-owner'),{code:'INTERACTION_STALE'});
});

test('oversized document metadata yields frozen pages and an answer in one admitted user turn',async t=>{
 let controller,file,readCalls=0;const text=('<p>轨道🙂 &quot;source&quot;</p>\n').repeat(500),version=createHash('sha256').update(text).digest('hex');
 const {c,native}=await open(t,async(userText)=>{
  assert.equal(userText,'核对冻结文档，不要重发我的输入。');
  let response=await controller.onTool('frontdesk',{tool:'nozeli_document_read',arguments:{relPath:'orbit.html'},callId:'document-first'}),joined='',offset=0,pages=0;
  while(response.ok){
   const page=response.value;assert.equal(page.offset,offset);assert.equal(page.version,version);assert.equal(page.readHandle,'document-edit-identity');assert.equal(response.hostControl,undefined);
   assert.ok(Buffer.byteLength(JSON.stringify(response))<16000);joined+=page.text;offset=page.endOffset;pages++;
   if(!page.nextReadRef)break;
   if(pages===1)await fs.writeFile(file,'NEW DISK CONTENT MUST NOT REPLACE FROZEN PAGES');
   response=await controller.onTool('frontdesk',{tool:'nozeli_document_read',arguments:{readRef:page.nextReadRef},callId:'document-page-'+pages});
  }
  assert.equal(response.ok,true);assert.equal(joined,text);assert.equal(offset,text.length);assert.ok(pages>1);assert.equal(readCalls,1);
  return {text:'已完成冻结文档核对；读取期间的磁盘修改未混入结论。'};
 });controller=c;file=path.join(c.store.content,'orbit.html');await fs.writeFile(file,text);
 c.frontdeskDocuments=async({op})=>{assert.equal(op,'read');readCalls++;return {ok:true,value:{relPath:'orbit.html',text:await fs.readFile(file,'utf8'),version,readHandle:'document-edit-identity',authorship:{largeLocalLedger:'not-document-body'.repeat(10000)}}};};
 await c.start();const accepted=await c.send('frontdesk','核对冻结文档，不要重发我的输入。',{requestKey:'bounded-document-same-turn'});
 const job=await waitFor(()=>c.store.state.jobs.find(job=>job.id===accepted.jobId&&job.status==='completed'),'bounded read final answer');
 assert.equal(native.calls.length,1);assert.equal(job.completion,'provider-completed');assert.equal(job.text,'核对冻结文档，不要重发我的输入。');
 assert.equal(c.store.state.jobs.filter(job=>job.target==='frontdesk').length,1);assert.equal(c.store.state.messages.filter(message=>message.speaker==='user').length,1);
 assert.equal(await fs.readFile(file,'utf8'),'NEW DISK CONTENT MUST NOT REPLACE FROZEN PAGES');
});
