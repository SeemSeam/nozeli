import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const [beforeApp,afterApp,out]=process.argv.slice(2);
if(![beforeApp,afterApp,out].every(p=>path.isAbsolute(p||'')))throw Error('usage: node compare-orchestrator-efficiency.mjs <before-app> <after-app> <owned-output>');
await fs.mkdir(out,{recursive:true});
const clone=v=>JSON.parse(JSON.stringify(v));
function scenario(completed){return {limit:2,works:[{id:'active',name:'Active Work',status:'review',revision:1,result:{objectId:'active-report',revision:1}},{id:'blocked',name:'Blocked cleanup',status:'ended',revision:1,outcome:'accept',closure:{phase:'blocked',error:'actual blocker excerpt'}},...Array.from({length:completed},(_,i)=>({id:'old-'+i,name:'Completed '+i,status:'ended',revision:1,outcome:'discard',closure:{phase:'complete'},result:{objectId:'report-'+i,revision:1}}))],todos:[],messages:[],jobs:[]};}
async function measure(app,label){
 const runtime=await import(pathToFileURL(app+'/src/agents/managed/runtime.mjs'));
 const context=await import(pathToFileURL(app+'/src/agents/managed/context-delivery.mjs'));
 const {Controller}=await import(pathToFileURL(app+'/src/agents/managed/controller.mjs'));
 const root=path.join(out,label),project=path.join(root,'project');await fs.mkdir(project,{recursive:true});await fs.writeFile(project+'/material.txt','measurement input, not a real model task\n');
 const {OmpTuiSession}=await import(pathToFileURL(app+'/src/agents/managed/omp-tui-session.mjs'));let nativeInstructions='';const c=await Controller.open({runtimeRoot:root+'/runtime',contentRoot:project,sessionFactory:s=>{const native=new OmpTuiSession(s);nativeInstructions=native.instructions;return native;}});
 try{
  await c.makeSession('orchestrator',{preflightOnly:true});
  const inputs=[];for(const [kind,options]of [['intake',{}],['followup',{boundWork:true}],['clarification',{routingQuestion:true}]]){const event=await runtime.eventSkill('orchestrator','intake',options);inputs.push({kind,skillChars:event.length,residentInstructionChars:nativeInstructions.length,totalInstructionAndSkillChars:nativeInstructions.length+event.length});}
  const scoped=[];for(const count of [0,200,1000]){const s=scenario(count),snapshot=clone(s),job={id:'current',target:'orchestrator',context:{}};const delivery=context.prepareDelivery(s,{target:'orchestrator',threadId:'measurement-thread',job,used:1});assert.deepEqual(s,snapshot,'projection must not mutate durable history');const facts=delivery.checkpoint.facts;assert(facts.works.some(w=>w.id==='active'));assert(facts.works.some(w=>w.id==='blocked'));scoped.push({completedHistory:count,deliveredRows:facts.works.length,deliveryChars:delivery.sections.flat().join('\n').length});}
  const raw='CANONICAL_SOURCE_SENTINEL '+('User requirement with exact scope and provenance. '.repeat(20));const w=await c.store.submit(raw,raw,{name:'Payload measurement'});c.configuring.add(w.id);await c.pump();const initial=c.store.state.jobs.find(j=>j.target===w.id&&j.type==='initial');assert(initial,'actual pump must create initial payload');const occurrences=initial.text.split('CANONICAL_SOURCE_SENTINEL').length-1;
  const probes=[];for(const opts of [{routingQuestion:true,skills:['handoff.md']},{routingQuestion:true,skills:['clarification.md']},{boundWork:true,skills:['followup.md']}]){const text=await runtime.eventSkill('orchestrator','intake',opts);probes.push({options:opts,loaded:text.length>0,title:text.split('\n')[0]||null});}
  return {label,app,inputs,scoped,initialWorker:{requestChars:raw.length,promptChars:initial.text.length,canonicalSourceOccurrences:occurrences},grantProbes:probes,modelsInvoked:0,unit:'UTF-16 character counts; NOT tokens or money',scaleFixture:'synthetic completed history, actual production projection code'};
 }finally{await c.stop();}
}
const before=await measure(beforeApp,'before'),after=await measure(afterApp,'after');
const result={before,after,changes:{instructions:before.inputs.map((v,i)=>({kind:v.kind,before:v.totalInstructionAndSkillChars,after:after.inputs[i].totalInstructionAndSkillChars,reduction:v.totalInstructionAndSkillChars-after.inputs[i].totalInstructionAndSkillChars})),history:before.scoped.map((v,i)=>({completedHistory:v.completedHistory,before:v.deliveryChars,after:after.scoped[i].deliveryChars,reduction:v.deliveryChars-after.scoped[i].deliveryChars})),initialWorker:{before:before.initialWorker,after:after.initialWorker}},claims:'Deterministic host replay only; real installed HTTP/model/latency results recorded separately'};
assert.equal(after.initialWorker.canonicalSourceOccurrences,1,'canonical original must be delivered once');assert.equal(after.scoped[1].deliveredRows,2,'unrelated completed history must not inflate active view');assert(after.grantProbes[0].loaded===false&&after.grantProbes[1].loaded&&after.grantProbes[2].loaded,'actual selected skill grant must govern delivery');
await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result.changes,null,2));
