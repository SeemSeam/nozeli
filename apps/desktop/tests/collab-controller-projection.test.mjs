import {openTestController,openTestWorkspace} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Controller} from '../src/agents/managed/controller.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {managedRuntime} from '../src/agents/managed/managed-storage.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-collab-owner-'));
 const options={projectId:'project-a',runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project')};
 const controller=await openTestController(options);
 Object.assign(options,{storage:controller.store.storage,projectId:controller.projectId});
 await controller.store.mutate(()=>controller.store.state.jobs.push({id:'accepted-job',target:'frontdesk',type:'front',status:'running',text:'Original input',context:{}}));
 const controllers=[controller];
 t.after(async()=>{for(const c of controllers)if(!c.store.closed)await c.stop();await fs.rm(root,{recursive:true,force:true});});
 return {root,controller,options,controllers};
}
const transport=(status,extra={})=>({jobId:'accepted-job',requestId:'request-identity-01',sessionId:'native-owner-session',epoch:'native-owner-session#0',attempt:1,kind:'prompt',contentDigest:'a'.repeat(64),status,...extra});

test('unknown delivery preserves its admission facts and forbids a new request ID before and after cold recovery',async t=>{
 const {controller:c,options,controllers}=await fixture(t);
 await c.recordTransport('frontdesk',transport('prepared'));
 await c.recordTransport('frontdesk',transport('submitted'));
 await c.recordTransport('frontdesk',transport('admitted',{seq:2}));
 await c.recordTransport('frontdesk',transport('pending',{seq:1}));
 assert.equal(c.store.state.jobs[0].collabAttempts[0].status,'admitted');
 await c.recordTransport('frontdesk',transport('unknown',{reason:'receipt connection lost'}));
 await assert.rejects(c.recordTransport('frontdesk',transport('prepared',{requestId:'second-request-02',attempt:2})),/cannot be dispatched again/);
 await c.stop();
 const recovered=await openTestController(options);controllers.push(recovered);
 const job=recovered.store.state.jobs.find(j=>j.id==='accepted-job');
 assert.equal(job.status,'interrupted');assert.equal(job.collabAttempts[0].status,'unknown');assert.equal(job.collabAttempts[0].everAdmitted,true);
 await assert.rejects(recovered.recordTransport('frontdesk',transport('prepared',{requestId:'second-request-02',attempt:2})),/cannot be dispatched again/);
 assert.equal(job.collabAttempts.length,1);
});

test('only a proved pre-admission rejection permits another attempt of the same accepted input',async t=>{
 const {controller:c}=await fixture(t);
 await c.recordTransport('frontdesk',transport('prepared'));
 await c.recordTransport('frontdesk',transport('rejected',{seq:1,reason:'busy'}));
 await c.recordTransport('frontdesk',transport('prepared',{requestId:'second-request-02',attempt:2}));
 assert.equal(c.store.state.jobs[0].collabAttempts.length,2);
 await c.store.mutate(()=>{c.store.state.jobs[0].status='completed';});
 await assert.rejects(c.recordTransport('frontdesk',transport('prepared',{requestId:'third-request-003',attempt:3})),/cannot be dispatched again/);
 await assert.rejects(c.recordTransport('frontdesk',transport('admitted',{contentDigest:'b'.repeat(64)})),/immutable binding/);
});

test('canonical native answer can become an explicitly requested task without a legacy transcript copy',async t=>{
 const {controller:c}=await fixture(t);
 await c.recordTransport('frontdesk',transport('prepared'));
 await c.recordNativeEntries('frontdesk',{sessionId:'native-owner-session',epoch:'native-owner-session#0',jobId:'accepted-job',requestId:'request-identity-01',entry:{type:'message',id:'answer-entry',message:{role:'assistant',content:[{type:'text',text:'Discussion result that should become a new task.'}]}}});
 const answer=c.snapshot().timeline.entries.find(e=>e.entryId==='answer-entry');
 assert.equal(c.store.state.messages.some(m=>m.id===answer.id),false);
 // Do not start provider scheduling in this archive/source conversion test.
 c.kick=()=>{};
 const converted=await c.convertMessage(answer.id,'Make a separate result file',{requestKey:'explicit-conversion-01'});
 const intake=c.store.state.jobs.find(j=>j.id===converted.jobId);
 assert.equal(intake.context.sourceMessageId,answer.id);
 assert.match(intake.text,/Discussion result that should become a new task\./);
 assert.equal(c.store.state.messages.filter(m=>m.speaker==='agent').length,0);
});

test('read-only timeline and changes queries do not connect a controller and reject forged cross-project changes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-collab-readonly-'));
 const projectRoot=path.join(root,'project');await fs.mkdir(projectRoot);
 let starts=0;
 const host=new DesktopHost(root),{project}=await host.pick(projectRoot),projectId=project.id;
 t.after(async()=>{await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 const projects=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()},openController:async()=>{starts++;throw Error('must not start');}});
 const runtime=await managedRuntime(host.storage,projectId),store=await openTestWorkspace(runtime,projectRoot,{storage:host.storage,projectId});
 await store.mutate(()=>{store.state.jobs??=[];store.state.messages??=[];store.state.messages.push({id:'old-msg',target:'frontdesk',speaker:'agent',text:'Read-only historical answer'});});await store.close();
 const timeline=await projects.invoke('managed.timeline.page',{projectId,limit:100});
 assert.equal(timeline.entries[0].text,'Read-only historical answer');
 assert.equal((await projects.invoke('managed.timeline.read',{projectId,id:'old-msg'})).entry.id,'old-msg');
 await assert.rejects(projects.invoke('managed.changes.list',{projectId,changeSetId:'b'.repeat(64)}),{code:'CHANGES_BINDING'});
 await Promise.all([projects.invoke('managed.draft',{projectId,target:'frontdesk',text:'Earlier unsent input'}),projects.invoke('managed.draft',{projectId,target:'frontdesk',text:'Newest unsent input'})]);
 assert.equal((await host.storage.getRecovery(projectId,'managed:drafts')).frontdesk,'Newest unsent input');
 await assert.rejects(projects.invoke('managed.draft',{projectId,target:'foreign-work',text:'not admitted'}),{code:'INVALID_PAYLOAD'});
 assert.equal(starts,0);assert.equal(projects.controllers.size,0);await projects.stop();
});

test('controller projection refuses partial native metadata but retains exact historical attempt identity',async t=>{
 const {controller:c}=await fixture(t);
 await c.recordTransport('frontdesk',transport('prepared'));
 const native={sessionId:'native-owner-session',epoch:'native-owner-session#0',jobId:'accepted-job',requestId:'request-identity-01',entry:{type:'message',id:'bound-answer',message:{role:'assistant',content:'Exact historical answer'}}};
 for(const mismatch of [{requestId:'foreign-request'},{epoch:'native-owner-session#1'},{jobId:null}])await assert.rejects(c.recordNativeEntries('frontdesk',{...native,...mismatch}),{code:'TIMELINE_OWNER'});
 await c.recordNativeEntries('frontdesk',native);
 assert.equal(c.snapshot().timeline.entries.find(e=>e.entryId==='bound-answer').text,'Exact historical answer');
 assert.equal(c.store.state.jobs[0].collabAttempts.length,1);
});

test('offline timeline original IPC forwards immutable bounded field pages',async t=>{
 const {controller:c,options,root}=await fixture(t);
 await c.recordTransport('frontdesk',transport('prepared'));
 const text='A public historical native body. '.repeat(15000);
 await c.recordNativeEntries('frontdesk',{sessionId:'native-owner-session',epoch:'native-owner-session#0',jobId:'accepted-job',requestId:'request-identity-01',entry:{type:'message',id:'long-original',message:{role:'assistant',content:text}}});
 const id=c.snapshot().timeline.entries.find(e=>e.entryId==='long-original').id;
 await c.stop();
 const storage=c.store.storage,projects=new ManagedProjects({userDataDir:root,host:{storage,requireProject:id=>storage.requireOnline(id),requireRegisteredProject:id=>storage.requireRegistered(id)},legacy:{projects:new Map()}});
 projects.projectionSource=async()=>({index:c.timeline});
 const discovery=await projects.invoke('managed.timeline.read',{projectId:options.projectId,id});
 assert.equal(discovery.entry.availability,'read-required');
 let offset=0,body='';do{const result=await projects.invoke('managed.timeline.read',{projectId:options.projectId,id,version:discovery.entry.read.version,field:'text',offset,limit:65536});assert.ok(Buffer.byteLength(JSON.stringify(result))<=128*1024);body+=result.entry.content;offset=result.entry.nextOffset;}while(offset!==null);
 assert.equal(body,text);
 await assert.rejects(projects.invoke('managed.timeline.read',{projectId:options.projectId,id,version:'stale',field:'text',offset:0,limit:100}),{code:'TIMELINE_VERSION'});
});
