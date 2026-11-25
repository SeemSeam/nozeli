import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {createFrontdeskDocuments} from '../src/agents/managed/frontdesk-documents.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {windowsProductionManagedEntry} from '../src/agents/managed/windows-production-entry.mjs';
import {managedRuntime} from '../src/agents/managed/managed-storage.mjs';
import {staticReport} from './static-report.fixture.mjs';

// Native Windows tool-contract regressions: the default production managed
// entry on the registered Windows desktop storage, with a fake session
// factory, so every tool call below still crosses the real workspace I/O
// (real document reads) and the real restricted-admission boundary.
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:120000};
const wait=async fn=>{const end=Date.now()+15000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('condition timeout');};

class FakeSession{constructor(spec,target){Object.assign(this,spec,{target,closed:false,busy:false,interactions:[],contextEpoch:'compaction:0:root',hasPrompted:false,phase:'idle',toolsDigest:'fixture-native-schema'});}async preflightToolsDigest(){}async assertToolsDigest(){}async start(id){this.threadId=id||randomUUID();return this;}async prompt(text,opts={}){this.hasPrompted=true;this.busy=true;this.phase='prompting';const requestId=randomUUID(),contentDigest=createHash('sha256').update(text,'utf8').digest('hex');const transport=status=>this.onTransportFact?.({status,kind:'prompt',sessionId:this.threadId,epoch:this.contextEpoch,requestId,jobId:opts.job?.id,attempt:1,contentDigest});try{await transport('prepared');await new Promise(r=>setTimeout(r,15));const tool=(name,args)=>this.onTool({tool:name,arguments:args,threadId:this.threadId,callId:randomUUID()});if(this.target==='frontdesk'&&!text.startsWith('light'))await tool('nozeli_handoff',{reason:'specialist'});else if(this.target==='orchestrator'&&opts.job?.type!=='backstage'){const input=text.split('\n\n').at(-1);if(input.startsWith('light manual answer'))await tool('nozeli_manage',{action:'clarify',text:'fixture routing clarification'});else await tool('nozeli_dispatch',{name:'worker '+randomUUID().slice(0,4),brief:text});}else if(!['frontdesk','orchestrator'].includes(this.target))await tool('nozeli_publish',{kind:'result',content:staticReport('Verified fixture report'),files:[]});await transport('native-record-confirmed');await transport('settled');return {text:'fixture response',threadId:this.threadId,turnId:randomUUID()};}finally{this.busy=false;this.phase='idle';}}async stop(){this.closed=true;return {confirmationComplete:true};}}

// Real registered Windows desktop project storage plus the default native
// production managed entry; only the model session is faked.
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-windows-contract-'));
 const profile=path.join(root,'profile'),content=path.join(root,'content');
 await fs.mkdir(content,{recursive:true});
 const host=new DesktopHost(profile),storage=host.storage;
 const projectId=(await host.pick(content)).project.id;
 const entry=await windowsProductionManagedEntry({storage,projectId});
 assert.equal(entry.native,true,'default Windows production entry selects the native adapters');
 const c=await Controller.open({storage,projectId,runtimeRoot:await managedRuntime(storage,projectId),contentRoot:content,
  workspaceIO:entry.workspaceIO,ownerLaunchFactory:entry.ownerLaunchFactory,
  frontdeskDocuments:createFrontdeskDocuments({host,projectId,sync:async()=>()=>{}}),
  sessionFactory:(spec,target)=>new FakeSession(spec,target)});
 t.after(async()=>{
  await c.stop();
  for(const service of entry.services)service.close();
  await storage.db.close();
  await fs.rm(root,{recursive:true,force:true});
 });
 await c.start();await wait(()=>!c.kicking);
 return {c,root,content};
}

test('ordinary orchestrator session keeps working document reads and drops initialization-only tools',native,async t=>{
 const {c,content}=await fixture(t);
 await fs.writeFile(path.join(content,'notes.md'),'ORDINARY_NOTES_SENTINEL first page\n');
 const receipt=await c.enqueue('orchestrator','intake','ordinary bounded read');
 const job=c.store.state.jobs.find(row=>row.id===receipt.jobId);
 await c.store.mutate(()=>{job.status='running';job.promptStartedAt=Date.now();});
 c.current.set('orchestrator',job);
 await c.session('orchestrator');
 const page=await c.onTool('orchestrator',{tool:'nozeli_document_read',arguments:{relPath:'notes.md'},callId:randomUUID()});
 assert.equal(page.ok,true,JSON.stringify(page.error));
 assert(page.value.text.includes('ORDINARY_NOTES_SENTINEL'));
 const session=await c.session('orchestrator');
 const names=session.tools.map(item=>item.name);
 assert(names.includes('nozeli_document_read'),'ordinary orchestrator keeps the bounded document read');
 for(const name of ['nozeli_project_inventory','nozeli_project_read','nozeli_project_map'])assert(!names.includes(name),'initialization-only tool must not be advertised in an ordinary session: '+name);
});

test('restricted diagnosis schema omits bugId, binds it from the host event, and keeps foreign-scope refusals',native,async t=>{
 const {c}=await fixture(t);
 const diagnosis=c.restrictedPromptOptions({context:{restrictedMode:'project-diagnosis',bugId:'bug:bound-diagnostic'}});
 const maintenance=diagnosis.tools.find(item=>item.name==='nozeli_maintenance');
 assert(maintenance,'restricted diagnosis exposes the scoped maintenance tool');
 assert.deepEqual(maintenance.inputSchema.properties.action.enum,['debug','debug.inspect','debug.report','debug.continue']);
 assert.deepEqual(maintenance.inputSchema.required,['action'],'only the action is required');
 assert(!('bugId' in maintenance.inputSchema.properties),'restricted schema never asks the model for the host-owned bugId');
 const initialization=c.restrictedPromptOptions({context:{restrictedMode:'project-initialization'}});
 assert(initialization.tools.some(item=>item.name==='nozeli_project_read'),'initialization events keep their own restricted catalogue');
 // Real maintenance bug bound to a real original job revision, so the debug
 // protocol's identity/saved-job guards run against an actual bug record.
 const intake=await c.enqueue('orchestrator','intake','bounded diagnostic event source');
 const original=c.store.state.jobs.find(row=>row.id===intake.jobId);
 await c.store.mutate(()=>{original.revision=original.revision??1;original.promptStartedAt=Date.now();});
 const bug=await c.maintenance.record({phase:'tool',jobId:original.id,revision:original.revision,error:{code:'INTERNAL_FAILURE'}});
 await c.maintenanceEvent(bug,{schedule:false});
 const job=c.store.state.jobs.find(item=>item.type==='maintenance'&&item.context?.bugId===bug.id);
 assert(job,'maintenance event created the restricted diagnosis job');
 await c.store.mutate(()=>{job.status='running';});
 c.current.set('orchestrator',job);
 // The model/native calls carry NO bugId at all; the host derives it from the
 // exact restricted event context and never mutates the caller's arguments.
 const openArgs={action:'debug'};
 const opened=await c.onTool('orchestrator',{tool:'nozeli_maintenance',arguments:openArgs,callId:randomUUID()});
 assert(opened.attemptId,'host-bound debug opened the event attempt without any supplied bugId');
 assert(!('bugId' in openArgs),'caller arguments are forwarded as a copy, never mutated');
 assert.equal(opened.evidence.originalJob.id,original.id,'debug evidence is bound to the actual original job');
 const source=opened.evidence.sources[0];
 const inspectArgs={action:'debug.inspect',attemptId:opened.attemptId,sourceId:source.sourceId,startLine:1,lineCount:4};
 const page=await c.onTool('orchestrator',{tool:'nozeli_maintenance',arguments:inspectArgs,callId:randomUUID()});
 assert.equal(page.ok,true,JSON.stringify(page.error));
 assert.equal(page.value.sourceId,source.sourceId);
 assert(!('bugId' in inspectArgs));
 const savedBug=(await c.maintenance.read()).bugs.find(row=>row.id===bug.id);
 assert.equal(savedBug.debug.eventJobId,job.id,'the exact bound diagnostic event was inspected');
 assert(savedBug.debug.inspections.some(r=>r.sourceId===source.sourceId&&r.startLine===1&&r.endLine===page.value.endLine),'inspection receipt recorded on the exact event');
 // Admission boundary unchanged: foreign bugId, non-debug action and
 // out-of-scope tools still reject before any effect.
 await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_maintenance',arguments:{action:'debug',bugId:'bug:foreign-project'},callId:randomUUID()}),{code:'PROJECT_DIAGNOSIS_TOOL_REJECTED'});
 await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_maintenance',arguments:{action:'debug.inspect',attemptId:opened.attemptId,sourceId:source.sourceId,startLine:1,lineCount:4,bugId:'bug:foreign-project'},callId:randomUUID()}),{code:'PROJECT_DIAGNOSIS_TOOL_REJECTED'});
 await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_maintenance',arguments:{action:'status',bugId:bug.id},callId:randomUUID()}),{code:'PROJECT_DIAGNOSIS_TOOL_REJECTED'});
 await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_project_read',arguments:{relPath:'README.md'},callId:randomUUID()}),{code:'PROJECT_DIAGNOSIS_TOOL_REJECTED'});
});
