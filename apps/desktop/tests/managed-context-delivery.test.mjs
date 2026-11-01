import test from 'node:test';import assert from 'node:assert/strict';
import {explicitHandoffFacts,workerStateProjection,workerInitialHandoff,deliveryMaterials,PROJECTION_MAX_BYTES} from '../src/agents/managed/context-delivery.mjs';
import {ContextReader} from '../src/agents/managed/context-reader.mjs';

const work=()=>({id:'w1',name:'Alpha',status:'running',revision:3,request:'R'.repeat(20000),approvedScopes:[{deviationId:'d1',sourceJobId:'j9',sourceText:'批准原文',at:'2026-01-01T00:00:00Z',revision:2}]});

test('explicit handoff keeps only explicit-event facts: no history scan, work table or quota dump',()=>{
  const state={todos:[{id:'q1',kind:'routing',status:'open',text:'选哪个任务？'}],works:[work(),{id:'w2',name:'Beta',status:'running',revision:1}],jobs:[],messages:[{id:'m1',jobId:'old',target:'frontdesk',speaker:'user',text:'unseen front text'}]};
  const facts=explicitHandoffFacts(state,{id:'i1',target:'orchestrator',type:'intake',text:'原始输入',context:{routingQuestionId:'q1'}});
  assert.equal(facts.length,1);assert.equal(facts[0].label,'所回答的问题');assert.equal(facts[0].text,'选哪个任务？');
  const text=JSON.stringify(facts);
  assert(!text.includes('unseen front text'),'no unseen-history backfill');
  assert(!text.includes('Beta'),'no work-table dump');
  assert(!text.includes('quota'),'no quota preload');
});
test('routing-question answer fact disappears once the question is closed',()=>{
  const state={todos:[{id:'q1',kind:'routing',status:'resolved',text:'done'}],works:[],jobs:[]};
  assert.deepEqual(explicitHandoffFacts(state,{id:'i1',target:'orchestrator',type:'intake',text:'x',context:{routingQuestionId:'q1'}}),[]);
});
test('frontdesk route authority and original-request continuation remain explicit one-time facts',()=>{
  const state={frontdeskRoutes:[{id:'r1',version:2,sourceJobId:'f1',decision:{action:'cancel',authority:'user-choice'}}],todos:[],works:[],jobs:[]};
  const cancel=explicitHandoffFacts(state,{id:'i1',target:'orchestrator',type:'intake',text:'x',context:{frontdeskRouteId:'r1'}});
  assert.equal(cancel[0].label,'用户已完成的处理方式决定');assert(cancel[0].text.includes('不得自动重试或另行派工'));
  const cont=explicitHandoffFacts({todos:[],works:[],jobs:[]},{id:'i2',target:'orchestrator',type:'intake',text:'x',context:{handoffAuthority:'original-request',frontJobId:'f2'}});
  assert.equal(cont[0].label,'原任务后台延续');assert(cont[0].text.includes('不重放既有效果'));
});
test('worker state projection is small, rebuilt from durable facts, never a system authority',()=>{
  const w=work();w.deviation={status:'pending'};
  const first=workerStateProjection(w,{unknownEffects:[{kind:'recovery-decision',at:'2026-01-01T00:00:00Z',workRef:'@work:w1',summary:'效果未知，先核对回执'}]});
  const parsed=JSON.parse(first.text);
  assert.equal(parsed.workId,'w1');assert.equal(parsed.revision,3);assert.equal(parsed.deviationHeld,true);
  assert.deepEqual(parsed.scope.approvedDeviationIds,['d1']);
  assert.equal(parsed.effects.unknown[0].kind,'recovery-decision');assert(parsed.effects.instruction.includes('不自动重放'));
  assert(parsed.note.includes('非聊天历史'));
  assert(first.bytes<=PROJECTION_MAX_BYTES,'projection fits the per-request cap');
  const second=workerStateProjection(work(),{unknownEffects:[]});
  assert.notEqual(first.version,second.version,'version tracks content');
  assert(!('taskAnchor' in parsed),'no per-turn task anchor payload');
});
test('one-time worker handoff bounds the original behind paged refs and never repeats approved-source bodies',()=>{
  const reader=new ContextReader(),packet=workerInitialHandoff(work(),reader,{previewChars:400});
  assert(packet.includes('原始用户请求'));assert(packet.includes('R'.repeat(400)));
  assert(!packet.includes('R'.repeat(401)),'preview is bounded');
  assert(packet.includes('nozeli_history_read'),'long original stays behind paged refs');
  assert(!packet.includes('批准原文'),'approved scope originals are not re-delivered per handoff');
  const longInputs=work();longInputs.inputs=[{sourceJobId:'s1',text:'补充'.repeat(9000),brief:'要点'}];
  const withSupplement=workerInitialHandoff(longInputs,reader,{previewChars:400});
  assert(withSupplement.length<6000);assert(withSupplement.includes('readRef'));
});
test('delivery materials are re-read from frozen persisted versions, never from stale in-memory copies',async()=>{
  const store=new Map();
  const job={context:{materials:[{id:'tag:t1',version:'a'.repeat(64),title:'README.md',provenance:{source:'README.md',versionLabel:'frozen-selection'}}]}};
  store.set('a'.repeat(64),Buffer.from('冻结正文'));
  const materials=await deliveryMaterials(job,{readObject:async version=>store.get(version)});
  assert.equal(materials.length,1);assert.equal(materials[0].text,'冻结正文');
  assert.equal(materials[0].provenance.source,'README.md');
  store.set('a'.repeat(64),Buffer.from('changed'));
  const again=await deliveryMaterials(job,{readObject:async version=>store.get(version)});
  assert.equal(again[0].text,'changed'),'source of truth is the frozen object store';
});

test('invalid selected material identity blocks delivery instead of silently dropping the selection',async()=>{
 for(const materials of [{id:'not-an-array'},[null],[{id:'selection',version:'invalid'}],[{id:'',version:'a'.repeat(64)}]]){
  await assert.rejects(deliveryMaterials({context:{materials}},{readObject:()=>{throw Error('invalid identity must not be read');}}),{code:'HOST_MATERIAL_REFERENCE_INVALID'});
 }
});
