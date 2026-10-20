import test from 'node:test';import assert from 'node:assert/strict';import {prepareDelivery,compactFacts,factDelta} from '../src/agents/managed/context-delivery.mjs';
import {workerTaskAnchor} from '../src/agents/managed/context-delivery.mjs';
import {ContextReader} from '../src/agents/managed/context-reader.mjs';
const initial=()=>({limit:2,works:[{id:'w',name:'Alpha',status:'review',revision:1,request:'R'.repeat(20000)}],todos:[],messages:[{id:'u1',jobId:'j1',target:'frontdesk',speaker:'user',text:'first'},{id:'a1',jobId:'j1',target:'frontdesk',speaker:'agent',text:'answer'},{id:'r1',jobId:'route1',target:'orchestrator',audience:'frontdesk',speaker:'system',text:'Alpha created'},{id:'u2',jobId:'j2',target:'frontdesk',speaker:'user',text:'continue'}]});
test('frontdesk omits native history and sees new host reply only once, including after restore',()=>{
 const state=initial();const first=prepareDelivery(state,{target:'frontdesk',threadId:'t',job:{id:'j2'},used:1});assert.equal(first.stats.externalMessages,1);assert(!JSON.stringify(first).includes('answer'));assert(!JSON.stringify(first).includes('R'.repeat(100)));assert.equal(first.checkpoint.facts.works[0].id,'w');state.contextDelivery={frontdesk:first.checkpoint};const restored=JSON.parse(JSON.stringify(state));restored.messages.push({id:'u3',jobId:'j3',target:'frontdesk',speaker:'user',text:'next'});const next=prepareDelivery(restored,{target:'frontdesk',threadId:'t',job:{id:'j3'},used:1});assert.equal(next.stats.externalMessages,0);assert.equal(next.stats.stateMode,'unchanged');assert.deepEqual(next.sections,[]);
});
test('ended Work remains addressable by stable identity with outcome and technical next action',()=>{
 const s=initial(),facts=compactFacts(s,1);s.works[0].revision=2;s.works[0].status='paused';const delta=factDelta(facts,compactFacts(s,1));assert.equal(delta.works.updated[0].status,'paused');assert(!JSON.stringify(delta).includes('RRRR'));s.works[0].status='ended';s.works[0].outcome='accept';s.works[0].closure={phase:'blocked'};const ended=factDelta(facts,compactFacts(s,0)).works;assert(!ended.removed?.includes('w'));assert.equal(ended.updated[0].id,'w');assert.equal(ended.updated[0].outcome,'accept');assert.equal(ended.updated[0].nextAction.kind,'technical-retry');
});
test('new thread and compaction invalidate delivery snapshot; exact routing question retained',()=>{
 const s=initial();s.contextDelivery={frontdesk:{threadId:'old',generation:0,facts:compactFacts(s,1),messageId:'r1'}};s.todos=[{id:'q',kind:'routing',status:'open',text:'Which task?'}];for(const [threadId,generation] of [['new',0],['old',1]]){const p=prepareDelivery(s,{target:'frontdesk',threadId,generation,job:{id:'j2',context:{routingQuestionId:'q'}},used:1});assert.equal(p.stats.stateMode,'snapshot');assert(p.sections.some(([title,text])=>title==='所回答的问题'&&text==='Which task?'));}
});
test('orchestrator receives cross-role dialogue and excludes current request duplicate',()=>{
 const s=initial();s.messages.push({id:'intake',jobId:'intake',target:'orchestrator',speaker:'user',text:'continue'});const p=prepareDelivery(s,{target:'orchestrator',threadId:'o',job:{id:'intake',context:{frontJobId:'j2'}},used:1});assert.equal(p.stats.externalMessages,2);const text=JSON.stringify(p.sections);assert(text.includes('answer'));assert(!text.includes('continue'));assert(!text.includes('Alpha created'));
});
test('large unseen dialogue remains bounded and exposes lookup instead of silently claiming complete history',()=>{
 const s=initial();s.messages=Array.from({length:20},(_,i)=>({id:'m'+i,jobId:'j'+i,target:'frontdesk',speaker:'user',text:'x'.repeat(2000)}));const p=prepareDelivery(s,{target:'orchestrator',threadId:'o',job:{id:'current'},used:1});assert.equal(p.stats.externalMessages,3);assert.equal(p.stats.omittedMessages,17);assert(p.sections.some(([,value])=>value.includes('@conversation')));assert(p.sections.flat().join('').length<4400);
});
test('memory change sends only version invalidation while unchanged memory adds no repeated index',()=>{
 const s=initial(),job={id:'intake'};const first=prepareDelivery(s,{target:'orchestrator',threadId:'o',job,used:1,memoryVersion:'v1'});s.contextDelivery={orchestrator:first.checkpoint};const same=prepareDelivery(s,{target:'orchestrator',threadId:'o',job,used:1,memoryVersion:'v1'});assert.equal(same.stats.stateMode,'unchanged');const changed=prepareDelivery(s,{target:'orchestrator',threadId:'o',job,used:1,memoryVersion:'v2'});assert.equal(changed.stats.stateMode,'delta');assert(changed.sections.some(([,text])=>text==='{"memoryVersion":"v2"}'));
});
test('unbound manual intake is bounded once then changes and disappears as a delta',()=>{const s=initial();s.jobs=[{id:'new',type:'intake',target:'orchestrator',text:'N'.repeat(12000),status:'queued',context:{manual:true}}];const first=compactFacts(s,1);assert.equal(first.requests.length,1);assert(first.requests[0].name.length<=56);assert(!JSON.stringify(first).includes('N'.repeat(100)));assert.equal(factDelta(first,compactFacts(s,1)),null);s.jobs[0].routing={action:'status'};assert.deepEqual(factDelta(first,compactFacts(s,1)).requests.removed,['request:new']);});
const completedHistory=()=>Array.from({length:200},(_,i)=>({id:'ended-'+i,name:'History '+i,status:'ended',revision:3,outcome:'accept',result:{objectId:'report-'+i,revision:3},closure:{phase:'complete'}}));
test('completed history does not grow active facts; active and technical identities are never capped',()=>{
 const state=initial();state.works.push({id:'queued',name:'Queued',status:'queued',revision:1},{id:'blocked',name:'Blocked',status:'ended',revision:2,outcome:'discard',closure:{phase:'blocked',error:'cleanup failed',report:{objectId:'blocked-report',revision:2}}},{id:'cleanup',name:'Cleanup',status:'ended',revision:2,closure:{phase:'cleanup'}},{id:'legacy',name:'Legacy',status:'ended',revision:1});
 const before=compactFacts(state,1);state.works.push(...completedHistory());const durable=JSON.stringify(state);
 assert.deepEqual(compactFacts(state,1),before);assert.equal(JSON.stringify(state),durable);
 assert.deepEqual(before.works.map(w=>w.id),['w','queued','blocked','cleanup','legacy']);assert.equal(before.works.find(w=>w.id==='blocked').closureError,'cleanup failed');assert.equal(before.works.find(w=>w.id==='blocked').report.objectId,'blocked-report');
 state.works.push(...Array.from({length:250},(_,i)=>({id:'active-'+i,name:'Active '+i,status:'paused',revision:1})));assert.equal(compactFacts(state,1).works.length,255);
});
test('both residents retain explicit ended identities and routing-question source without mutating history',()=>{
 for(const target of ['orchestrator','frontdesk']){
  const state=initial();state.works.push(...completedHistory());state.jobs=[{id:'original',target:'orchestrator',context:{boundWorkId:'ended-42'}}];state.todos=[{id:'question',kind:'routing',status:'open',workId:'ended-41',sourceJobId:'original',text:'Exact original question?'}];
  const job={id:'answer',target,context:{boundWorkId:'ended-40',routingQuestionId:'question'}};const durable=JSON.stringify(state);
  const delivery=prepareDelivery(state,{target,threadId:'t',job,used:1});assert.deepEqual(delivery.checkpoint.facts.works.map(w=>w.id),['w','ended-40','ended-41','ended-42']);assert.equal(delivery.checkpoint.facts.works[1].report.objectId,'report-40');assert.equal(delivery.checkpoint.facts.works[1].nextAction,null);assert(delivery.sections.some(([title,text])=>title==='所回答的问题'&&text==='Exact original question?'));assert.equal(JSON.stringify(state),durable);
 }
});
test('old all-history checkpoint removes projection membership, and related history can return',()=>{
 const state=initial();state.works.push(...completedHistory());const works=state.works.map(w=>compactFacts({...state,works:[w]},1,{target:w.id}).works[0]);state.contextDelivery={orchestrator:{threadId:'t',generation:0,facts:{...compactFacts(state,1),works},messageId:'u2'}};
 const first=prepareDelivery(state,{target:'orchestrator',threadId:'t',job:{id:'next'},used:1});const delta=JSON.parse(first.sections.find(([title])=>title==='程序状态变化')[1]);assert.equal(delta.works.removed.length,200);assert.equal(state.works.length,201);assert.equal(state.contextDelivery.orchestrator.facts.works.length,201);
 state.contextDelivery.orchestrator=first.checkpoint;const referenced=prepareDelivery(state,{target:'orchestrator',threadId:'t',job:{id:'bound',context:{boundWorkId:'ended-7'}},used:1});assert.deepEqual(JSON.parse(referenced.sections[0][1]).works.updated.map(w=>w.id),['ended-7']);assert.equal(state.works[8].status,'ended');
});
test('explicit source lineage and direct Work target retain completed history without prose guessing',()=>{
 const state=initial();state.works.push(...completedHistory());state.works[6].sourceJob='root';state.jobs=[{id:'root',target:'orchestrator',context:{boundWorkId:'ended-6'}}];
 const facts=compactFacts(state,1,{job:{id:'retry',text:'History 100',context:{retryOf:'root'}},target:'ended-7'});assert.deepEqual(facts.works.map(w=>w.id),['w','ended-5','ended-6','ended-7']);assert.equal(state.works.length,201);
});
test('explicit frontend discussion keeps its bound intake Work after completion',()=>{
 const state=initial();state.works.push(...completedHistory());state.jobs=[{id:'old-intake',target:'orchestrator',routing:{workId:'ended-9'},context:{}}];state.frontGoals=[{id:'discussion',intakeJobId:'old-intake',jobIds:[]}];const before=JSON.stringify(state);
 const facts=compactFacts(state,1,{job:{id:'followup',target:'frontdesk',context:{frontGoalId:'discussion'}},target:'frontdesk'});assert.deepEqual(facts.works.map(w=>w.id),['w','ended-9']);assert.equal(JSON.stringify(state),before);
});
test('technical blocker errors are faithful bounded previews with full-source lookup metadata',()=>{
 for(const error of ['x'.repeat(239)+'😀'+'trace'.repeat(500),{code:'CLEANUP_FAILED',trace:'provider trace '.repeat(500)}]){
  const state=initial();state.works[0].status='ended';state.works[0].closure={phase:'blocked',error};const durable=JSON.stringify(state),full=typeof error==='string'?error:JSON.stringify(error),row=compactFacts(state,0).works[0];
  assert(row.closureError.length<=240);assert(full.startsWith(row.closureError));assert(!/[\uD800-\uDBFF]$/.test(row.closureError));assert.deepEqual(row.closureErrorSource,{workName:'Alpha',workRef:'@work:w',field:'closure.error',totalChars:full.length,truncated:true});assert.equal(JSON.stringify(state),durable);
 }
});
test('Worker scope anchor preserves exact original and approved sources behind bounded paged refs',()=>{
 const request='R'.repeat(799)+'😀'+' original '.repeat(4000),sourceText='Approved exact input\n'.repeat(3000);
 const work={id:'w',revision:4,request,approvedScopes:[{deviationId:'d',sourceJobId:'input',sourceText,at:'2026-10-19',revision:3}],queuedInputs:[{text:'unapproved new task'}]};
 const before=JSON.stringify(work),reader=new ContextReader(),anchor=JSON.parse(workerTaskAnchor(work,reader));
 assert.equal(anchor.workId,'w');assert.equal(anchor.revision,4);assert.equal(anchor.originalTask.totalChars,request.length);
 assert.equal(anchor.approvedSources.length,1);assert.equal(anchor.approvedSources[0].sourceJobId,'input');
 const entries=[anchor.originalTask,...anchor.approvedSources];assert(entries.reduce((n,row)=>n+row.preview.length,0)<=1600);
 for(const [index,row] of entries.entries()){
  const expected=index===0?request:sourceText;assert(expected.startsWith(row.preview));assert(!/[\uD800-\uDBFF]$/.test(row.preview));assert.equal(row.truncated,true);
  let text='',ref=row.readRef;while(ref){const page=reader.read(ref);text+=page.text;ref=page.nextReadRef;}
  assert.equal(text,expected);
 }
 assert(!JSON.stringify(anchor).includes('unapproved new task'));assert.equal(JSON.stringify(work),before);
});
test('restored or compacted Worker gets fresh readable anchors including later user approvals',()=>{
 const work={id:'w',revision:1,request:'Original immutable task',approvedScopes:[]},oldReader=new ContextReader(),old=JSON.parse(workerTaskAnchor(work,oldReader));
 const restored=JSON.parse(JSON.stringify(work));restored.revision=2;restored.approvedScopes.push({deviationId:'d',sourceJobId:'j',sourceText:'User-approved added scope',revision:2});
 const reader=new ContextReader(),current=JSON.parse(workerTaskAnchor(restored,reader));
 assert.equal(reader.read(current.originalTask.readRef).text,work.request);assert.equal(reader.read(current.approvedSources[0].readRef).text,'User-approved added scope');
 assert.throws(()=>reader.read(old.originalTask.readRef),/unknown read reference/);assert.deepEqual(work.approvedScopes,[]);
});
test('soft Work routing hint restores relevant history without hard-binding the intake',()=>{
 const state=initial();state.works.push(...completedHistory());const job={id:'fresh',target:'orchestrator',context:{workHintId:'ended-14'}};
 const before=JSON.stringify(job),facts=compactFacts(state,1,{job,target:'orchestrator'});
 assert(facts.works.some(w=>w.id==='ended-14'));assert.equal(job.context.boundWorkId,undefined);assert.equal(JSON.stringify(job),before);
 const delivery=prepareDelivery(state,{target:'orchestrator',threadId:'o',job,used:1});
 const hint=delivery.sections.map(([,text])=>{try{return JSON.parse(text);}catch{return null;}}).find(row=>row?.workHintId);
 assert.equal(hint.workHintId,'ended-14');assert.equal(hint.binding,false);assert.equal(hint.boundWorkId,undefined);
 assert.equal(JSON.stringify(job),before);
});
