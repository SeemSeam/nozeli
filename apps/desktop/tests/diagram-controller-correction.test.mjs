import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Controller} from '../src/agents/managed/controller.mjs';

function host(){
 const job={id:'original-job',type:'initial',target:'original-work',revision:1,status:'running'};
 const work={id:'original-work',revision:1,status:'running'};
 const controller=Object.assign(Object.create(Controller.prototype),{projectId:'p',current:new Map([[work.id,job]]),stopping:false,contextBudget:{run:()=>null}});
 controller.store={state:{jobs:[job],works:[work],todos:[]},deviationHeld:()=>false,find:id=>{assert.equal(id,work.id);return work;},requireOnline:async()=>{},mutate:async fn=>fn()};
 return {controller,job,work};
}

test('invalid diagram returns correction in the original turn; corrected spec renders without maintenance or new Work',async()=>{
 const {controller,job,work}=host();
 const spec=JSON.parse(await fs.readFile(new URL('./fixtures/archify/workflow.json',import.meta.url),'utf8'));
 const invalid=structuredClone(spec);invalid.nodes[0].col=-1;
 const rejected=await controller.onTool(work.id,{tool:'nozeli_diagram',arguments:{type:'workflow',spec:invalid},callId:'bad-diagram'});
 assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'DIAGRAM_INPUT_INVALID');assert.equal(rejected.continueTurn,true);assert.equal(rejected.effect,'none');
 assert.equal(work.status,'running');assert.equal(work.maintenance,undefined);assert.equal(job.hostToolFailure,undefined);
 const rendered=await controller.onTool(work.id,{tool:'nozeli_diagram',arguments:{type:'workflow',spec},callId:'corrected-diagram'});
 assert.equal(rendered.validation.ok,true);assert.match(rendered.svg,/<svg/);assert.equal(rendered.continueTurn,true);
 assert.equal(controller.store.state.works.length,1);assert.equal(controller.store.state.jobs.length,1);assert.equal(job.status,'running');
});

test('unexpected host failure retains technical tool provenance without raw input and still fails closed',async()=>{
 const {controller,job,work}=host();
 controller.handleTool=async()=>{throw new TypeError('PRIVATE_DOCUMENT token=PRIVATE_CREDENTIAL');};
 await assert.rejects(controller.onTool(work.id,{tool:'nozeli_diagram',arguments:{spec:{private:'PRIVATE_DOCUMENT'}},callId:'original-call'}),TypeError);
 assert.deepEqual(job.hostToolFailure,{schema:1,tool:'nozeli_diagram',callId:'original-call',stage:'render',effect:'none',code:'HOST_TOOL_ERROR'});
 assert.equal(JSON.stringify(job.hostToolFailure).includes('PRIVATE'),false);assert.equal(work.status,'running');
});

test('queued diagram recovery cannot rebase onto a changed Work revision or native thread',()=>{
 const {controller,job,work}=host();work.threadId='original-thread';
 job.diagramRecovery={id:'receipt',bugId:'bug',jobId:job.id,workId:work.id,revision:1,threadId:work.threadId,supplementJobId:'supplement'};
 const supplement={id:'supplement',target:work.id,context:{sourceJobId:job.id,diagramRecoveryReceiptId:'receipt',diagramRecoveryBugId:'bug',diagramRecoveryRevision:1,diagramRecoveryThreadId:work.threadId}};
 controller.assertDiagramRecoveryAdmission(supplement,{threadId:work.threadId});
 work.revision=2;assert.throws(()=>controller.assertDiagramRecoveryAdmission(supplement),{code:'RESTART_RECONCILIATION_REQUIRED'});
 work.revision=1;work.threadId='new-thread';assert.throws(()=>controller.assertDiagramRecoveryAdmission(supplement),{code:'RESTART_RECONCILIATION_REQUIRED'});
 work.threadId='original-thread';assert.throws(()=>controller.assertDiagramRecoveryAdmission(supplement,{threadId:'other-owner-thread'}),{code:'RESTART_RECONCILIATION_REQUIRED'});
 assert.equal(job.diagramRecovery.revision,1);assert.equal(controller.store.state.jobs.length,1);
});

test('malformed report HTML is correctable before artifact capture or publication effects',async()=>{
 const {controller,job,work}=host();let captured=0;
 controller.recordArtifacts=async()=>{captured++;throw Error('must not capture invalid report');};
 const result=await controller.onTool(work.id,{tool:'nozeli_publish',arguments:{kind:'result',content:'<!doctype html><html><body><p>broken</div></body></html>',files:[]},callId:'bad-report'});
 assert.equal(result.ok,false);assert.equal(result.error.code,'HTML_REPORT_INVALID');assert.equal(result.continueTurn,true);assert.equal(result.effect,'none');assert.equal(captured,0);assert.equal(job.status,'running');assert.equal(work.status,'running');
});
