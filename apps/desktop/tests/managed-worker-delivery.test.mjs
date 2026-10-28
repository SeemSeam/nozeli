import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {openTestController,readTestObject} from './project-storage.fixture.mjs';import {workDisposition} from '../src/domain/work-disposition.mjs';

for(const failed of [false,true])test('unreported Worker turn retains actionable host problem; failed='+failed,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-missing-delivery-'));
 class Session{constructor(spec){Object.assign(this,spec,{closed:false,busy:false});}async preflightToolsDigest(){}async assertToolsDigest(){}async start(thread){this.threadId=thread??randomUUID();return this;}async stop(){this.closed=true;return{confirmationComplete:true};}async prompt(){if(failed)throw Error('Observed execution prerequisite missing');return{text:'I finished',threadId:this.threadId,completion:'provider-completed'};}}
 const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),sessionFactory:spec=>new Session(spec),projectHome:home=>fs.mkdir(home,{recursive:true})});
 t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
 const w=await c.store.submit('Produce a verified deliverable','Do not substitute chat for a report');await c.store.activate(w.id);await c.execution.prepare(w.id);await fs.writeFile(path.join(c.execution.directory(w.id),'unfinished.txt'),'retained progress');
 const job=await c.enqueue(w.id,'initial','Do the admitted task');await c.runJob(c.store.state.jobs.find(j=>j.id===job.jobId));
 const current=c.store.find(w.id);assert.equal(current.status,'paused');assert.equal(current.result,undefined);assert.equal(workDisposition(c.store.state,current).accept.allowed,false);
 const issue=c.store.state.receipts.find(r=>r.workId===w.id&&r.kind==='problem');assert(issue);assert.equal(issue.jobId,job.jobId);assert.equal(issue.origin,'host-diagnostic');assert.equal(c.store.state.messages.find(m=>m.objectId===issue.objectId).speaker,'system');assert.equal(c.store.state.jobs.find(j=>j.id===job.jobId).status,failed?'failed':'completed');
 assert.equal(c.store.state.todos.filter(t=>t.workId===w.id&&t.kind==='problem'&&t.status==='open').length,1);assert.equal(await fs.readFile(path.join(c.execution.directory(w.id),'unfinished.txt'),'utf8'),'retained progress');
});
