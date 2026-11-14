import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openTestController} from './project-storage.fixture.mjs';
import {FRONTDESK_DEFAULT_SKILLS,FRONTDESK_LEGACY_DEFAULT_SKILLS} from '../src/agents/managed/runtime.mjs';
import {createProviderHistoryReader} from '../src/agents/managed/provider-history.mjs';
import {HostContextBudget} from '../src/agents/managed/context-budget.mjs';
import {normalizeHostTools,createHostToolBridge} from '../../../integrations/pi/src/tools.mjs';
const {makeStrictJsonSchema}=await import('../../../integrations/pi/node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js');
const {validateToolArguments}=await import('../../../integrations/pi/node_modules/@earendil-works/pi-ai/dist/utils/validation.js');
import {DesktopHost} from '../src/main/host.mjs';
import {createFrontdeskDocuments} from '../src/agents/managed/frontdesk-documents.mjs';

// A transport fixture only: no prompt/model/network is ever permitted.
class IdleSession {
 constructor(spec){Object.assign(this,spec,{closed:false,busy:false,toolsDigest:'fixture-schema',viewOwnerId:randomUUID()});}
 async start(threadId){this.threadId=threadId??randomUUID();}
 async preflightToolsDigest(){}
 async assertToolsDigest(){}
 async stop(){this.closed=true;return {confirmationComplete:true};}
 async prompt(){throw Error('read-only regression must not prompt');}
}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-progress-'));
 const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),sessionFactory:spec=>new IdleSession(spec)});
 t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});return {c,root};
}
async function admit(c,target='frontdesk'){
 const accepted=await c.enqueue(target,target==='frontdesk'?'front':'intake','只读查询');
 const job=c.store.state.jobs.find(j=>j.id===accepted.jobId);c.current.set(target,job);return job;
}
const invoke=(c,tool,args,target='frontdesk')=>c.onTool(target,{tool,arguments:args,callId:randomUUID()});
const progress=(c,args)=>invoke(c,'nozeli_project_progress',args);

// Exercise the actual Pi schema adapter, pinned strict provider conversion,
// argument validator and reverse-RPC receipt, without a model or network.
async function strictTransport(c){
 const bridge=createHostToolBridge({send:frame=>{
  invoke(c,frame.tool,frame.arguments).then(result=>bridge.resolveReverse(frame.id,{result}),error=>bridge.resolveReverse(frame.id,{error:{code:error.code,message:error.message}}));
 }});
 const names=['nozeli_project_progress','nozeli_provider_history_search','nozeli_provider_history_read','nozeli_document_read'];
 const definitions=bridge.definitionsFor(normalizeHostTools((await c.session('frontdesk')).tools.filter(tool=>names.includes(tool.name))));
 const wire=new Map(definitions.map(tool=>[tool.name,{...tool,parameters:makeStrictJsonSchema(tool.parameters)}]));
 for(const tool of wire.values()){
  assert.deepEqual(tool.parameters.required,Object.keys(tool.parameters.properties));
  assert.equal(tool.parameters.additionalProperties,false);
  for(const [key,schema] of Object.entries(tool.parameters.properties))if(!['action','source'].includes(key))assert(schema.anyOf.some(branch=>branch.type==='null'),key+' permits strict null');
 }
 return {wire,call:async(name,args)=>{
  const tool=definitions.find(tool=>tool.name===name);
  validateToolArguments(wire.get(name),{name,arguments:args});
  const reply=await tool.execute(randomUUID(),validateToolArguments(tool,{name,arguments:args}));
  assert.equal(reply.terminate,undefined,'read receipt continues the native turn');
  return JSON.parse(reply.content[0].text);
 }};
}

test('strict nullable progress transport reads actual lists and exact details; blank legacy selectors are omitted',async t=>{
 const {c}=await fixture(t);for(let i=0;i<3;i++)await c.store.submit('request '+i,'brief',{name:'same display name'});await admit(c);
 const transport=await strictTransport(c),name='nozeli_project_progress';
 for(const placeholder of [null,'']){
  const first=await transport.call(name,{action:'list',cursor:placeholder,limit:1,workId:placeholder});
  assert.equal(first.rows[0].workId,c.store.state.works[0].id);assert(first.nextCursor);
  const next=await transport.call(name,{action:'list',cursor:first.nextCursor,limit:1,workId:placeholder});assert.equal(next.rows[0].workId,c.store.state.works[1].id);
  const detail=await transport.call(name,{action:'detail',cursor:placeholder,limit:null,workId:first.rows[0].workId});assert.equal(detail.work.workId,first.rows[0].workId);
 }
 assert.equal((await transport.call(name,{action:'list',cursor:null,limit:null,workId:null})).rows.length,3);
 for(const [args,code] of [[{action:'list',cursor:null,limit:1,workId:c.store.state.works[0].id},'INVALID_PAYLOAD'],[{action:'detail',cursor:null,limit:null,workId:null},'INVALID_PAYLOAD'],[{action:'detail',cursor:null,limit:null,workId:'same display name'},'WORK_NOT_FOUND'],[{action:'list',cursor:'forged',limit:1,workId:null},'INVALID_CURSOR']])assert.equal((await transport.call(name,args)).error.code,code);
 assert.throws(()=>validateToolArguments(transport.wire.get(name),{name,arguments:{action:'list',cursor:null,limit:null,workId:null,unknown:null}}));
 assert.equal((await progress(c,{action:'list',unknown:null})).error.code,'INVALID_PAYLOAD');
});

test('frontdesk pages more than forty Works and every pending todo without dispatch or writes',async t=>{
 const {c}=await fixture(t);for(let i=0;i<93;i++)await c.store.submit('request '+i,'brief',{name:'Work '+i});
 await c.store.mutate(()=>{for(let i=0;i<87;i++)c.store.state.todos.push({id:'todo-'+i,kind:'problem',status:'open',workId:c.store.state.works[i].id,text:'decision '+i});});
 await admit(c);const before=structuredClone(c.store.state),rows=[],todos=[];let cursor;
 do{const page=await progress(c,{action:'list',...(cursor?{cursor}:{})});assert(page.readOnly&&page.continueTurn);assert(page.rows.length<=40);assert(page.pendingTodos.length<=40);rows.push(...page.rows);todos.push(...page.pendingTodos);cursor=page.nextCursor;}while(cursor);
 assert.deepEqual(rows.map(r=>r.workId),before.works.map(w=>w.id));assert.deepEqual(todos.map(r=>r.id),before.todos.filter(t=>t.status==='open').map(t=>t.id));assert.equal(new Set(todos.map(r=>r.id)).size,todos.length);assert.equal(rows[0].blockReason.code,'PROBLEM_AWAITING_DECISION');assert.deepEqual(c.store.state,before);
});

test('detail stays project-scoped; status and decision changes invalidate continuation; mutation payloads reject',async t=>{
 const {c}=await fixture(t);for(let i=0;i<45;i++)await c.store.submit('request '+i,'brief');await admit(c);
 const work=c.store.state.works[0],first=await progress(c,{action:'list'});
 await c.store.mutate(()=>{work.status='paused';c.store.state.todos.push({id:'decision',workId:work.id,status:'open',kind:'problem',text:'await user'});});
 const changed=await progress(c,{action:'list',cursor:first.nextCursor});assert(changed.resyncRequired);assert.equal(changed.offset,0);
 const detail=await progress(c,{action:'detail',workId:work.id});assert.equal(detail.work.status,'paused');assert(detail.pendingTodos.some(todo=>todo.id==='decision'));assert.equal(detail.blockReason.code,'PROBLEM_AWAITING_DECISION');
 await c.store.mutate(()=>{c.store.state.todos.find(t=>t.id==='decision').status='resolved';});
 assert((await progress(c,{action:'list',cursor:changed.nextCursor})).resyncRequired,'todo-only changes invalidate the snapshot');
 for(const [args,code] of [[{action:'detail',workId:'foreign-project-work'},'WORK_NOT_FOUND'],[{action:'pause',workId:work.id},'INVALID_PAYLOAD'],[{action:'list',projectPath:'/other'},'INVALID_PAYLOAD'],[{action:'list',cursor:'broken'},'INVALID_CURSOR']]){
  const result=await progress(c,args);assert.equal(result.ok,false);assert.equal(result.error.code,code);assert(result.continueTurn);assert.equal(result.hostControl,undefined);
 }
 const beforeJobChange=await progress(c,{action:'list'});await c.store.mutate(()=>{c.store.state.jobs[0].status='completed';});
 assert((await progress(c,{action:'list',cursor:beforeJobChange.nextCursor})).resyncRequired,'job-only state changes invalidate continuation');
 assert.equal(c.store.state.jobs.some(job=>job.type==='maintenance'),false,'correctable reads never schedule diagnostics');
 await admit(c,'orchestrator');for(const tool of ['nozeli_project_progress','nozeli_provider_history_search','nozeli_provider_history_read'])await assert.rejects(invoke(c,tool,{action:'list'},'orchestrator'),{code:'FRONTDESK_READ_FORBIDDEN'});
 const accepted=await c.enqueue(work.id,'manual','只读查询');c.current.set(work.id,c.store.state.jobs.find(j=>j.id===accepted.jobId));
 for(const tool of ['nozeli_project_progress','nozeli_provider_history_search','nozeli_provider_history_read'])await assert.rejects(invoke(c,tool,{action:'list'},work.id),{code:'FRONTDESK_READ_FORBIDDEN'});
});

test('old ambiguous defaults and custom selections stay unchanged; proven defaults archive and migrate',async t=>{
 const {c}=await fixture(t);assert.deepEqual(c.store.state.bindings.frontdesk.skills,[...FRONTDESK_DEFAULT_SKILLS]);
 for(const selected of [[...FRONTDESK_LEGACY_DEFAULT_SKILLS],['nozeli-frontdesk-read-material']]){
  await c.store.mutate(()=>{Object.assign(c.store.state.bindings.frontdesk,{skills:selected});delete c.store.state.bindings.frontdesk.skillSelection;});
  await c.initializeBindings();assert.deepEqual(c.store.state.bindings.frontdesk.skills,selected);assert.equal(c.store.state.frontdeskSkillUpgrade.status,'available');
 }
 await c.store.mutate(()=>{Object.assign(c.store.state.bindings.frontdesk,{skills:[...FRONTDESK_LEGACY_DEFAULT_SKILLS],skillSelection:'default'});c.store.state.residents.frontdesk={provider:'pi',threadId:'old-thread'};});
 await c.initializeBindings();assert.deepEqual(c.store.state.bindings.frontdesk.skills,[...FRONTDESK_DEFAULT_SKILLS]);assert.equal(c.store.state.residents.frontdesk.threadId,'old-thread');assert(c.store.state.bindingArchive.some(r=>r.reason==='frontdesk-project-skills-default-v2'));
});

test('setBinding applies at idle on the same native thread, preserves history and never replays input',async t=>{
 const {c}=await fixture(t);await c.store.mutate(()=>{c.store.state.residents.frontdesk={provider:'pi',threadId:'existing-thread',toolsDigest:'fixture-schema',zeroActivity:false};c.store.state.messages.push({id:'old-message',target:'frontdesk',speaker:'agent',text:'old history'});});
 const old=await c.session('frontdesk');old.busy=true;await assert.rejects(c.setBinding('frontdesk',{skills:[...FRONTDESK_DEFAULT_SKILLS]}),/idle/);assert.equal(c.sessions.get('frontdesk'),old);old.busy=false;
 const before=structuredClone(c.store.state.messages),jobs=c.store.state.jobs.length;
 const result=await c.setBinding('frontdesk',{skills:[...FRONTDESK_DEFAULT_SKILLS]});assert.equal(result.appliesTo,'resident-same-thread');assert(old.closed);assert.equal(c.sessions.get('frontdesk').threadId,'existing-thread');assert.deepEqual(c.store.state.messages,before);assert.equal(c.store.state.jobs.length,jobs);assert.equal(c.store.state.bindings.frontdesk.skillSelection,'user');
 await c.setBinding('frontdesk',{skills:[...FRONTDESK_LEGACY_DEFAULT_SKILLS]});await c.initializeBindings();assert.deepEqual(c.store.state.bindings.frontdesk.skills,[...FRONTDESK_LEGACY_DEFAULT_SKILLS]);
 const additions=FRONTDESK_DEFAULT_SKILLS.filter(name=>!FRONTDESK_LEGACY_DEFAULT_SKILLS.includes(name));await c.setBinding('frontdesk',{skills:additions});await c.initializeBindings();assert.deepEqual(c.store.state.bindings.frontdesk.skills,additions);assert.equal(c.store.state.frontdeskSkillUpgrade.status,'enabled');
 const frontTools=c.sessions.get('frontdesk').tools.map(t=>t.name);for(const name of ['nozeli_project_progress','nozeli_provider_history_search','nozeli_provider_history_read'])assert(frontTools.includes(name));
 const orchestrator=await c.session('orchestrator');assert(!orchestrator.tools.some(t=>['nozeli_project_progress','nozeli_provider_history_search','nozeli_provider_history_read'].includes(t.name)));
});

test('history tool consumers route actual synthetic provider files without automatic historical injection',async t=>{
 const {c,root}=await fixture(t),history=path.join(root,'history');await fs.mkdir(history);await fs.writeFile(path.join(history,'session.jsonl'),[
  {type:'session',version:3,id:'fixture',cwd:c.store.content,timestamp:'2026-01-01T00:00:00Z'},
  {type:'message',id:'m1',parentId:null,timestamp:'2026-01-01T00:00:01Z',message:{role:'user',content:[{type:'text',text:'synthetic history unique-token '+('escape\\\"\n尾'.repeat(12000))}]}}
 ].map(row=>JSON.stringify(row)).join('\n')+'\n');
 c.providerHistory=createProviderHistoryReader({projectRoot:c.store.content,projectIdentity:c.projectId,home:path.join(root,'empty-home'),providerRoots:{pi:history,codex:path.join(root,'absent-codex'),claude:path.join(root,'absent-claude')}});
 await admit(c);const before=structuredClone(c.store.state),found=await invoke(c,'nozeli_provider_history_search',{query:'unique-token',provider:'pi'});assert(found.readOnly&&found.continueTurn);assert(found.items.length>0);
 const body=await invoke(c,'nozeli_provider_history_read',{source:found.items[0].source,maxBytes:12000});assert(body.readOnly&&body.continueTurn);assert(JSON.stringify(body).includes('unique-token'));assert.deepEqual(c.store.state,before);
 assert(body.nextCursor);const args={source:found.items[0].source,cursor:body.nextCursor};
 c.contextBudget=new HostContextBudget({runHostTextMaxBytes:12000,generationHostTextMaxBytes:100000,receiptReserveBytes:1000});
 c.contextBudget.beginRun({target:'frontdesk',runId:'low',epoch:'low'});c.contextBudget.charge('frontdesk',10000);
 const denied=await invoke(c,'nozeli_provider_history_read',args);assert.equal(denied.error.code,'HOST_CONTEXT_BUDGET_EXHAUSTED');assert(denied.continueTurn);
 c.contextBudget.beginRun({target:'frontdesk',runId:'retry',epoch:'retry'});
 const delivered=await invoke(c,'nozeli_provider_history_read',args);assert.equal(delivered.status,'ok');assert(delivered.records.length);assert(Buffer.byteLength(JSON.stringify(delivered))<=11000);assert(delivered.nextCursor,'undelivered-budget refusal did not consume the cursor');
 const nextArgs={source:found.items[0].source,cursor:delivered.nextCursor},mutate=c.store.mutate.bind(c.store);let fail=true;
 c.store.mutate=async fn=>{if(fail){fail=false;throw Error('synthetic budget persistence failure');}return mutate(fn);};
 const withheld=await invoke(c,'nozeli_provider_history_read',nextArgs);assert.equal(withheld.error.code,'HOST_BUDGET_PERSIST_FAILED');c.store.mutate=mutate;
 c.contextBudget.beginRun({target:'frontdesk',runId:'persist-retry',epoch:'persist-retry'});
 const replay=await invoke(c,'nozeli_provider_history_read',nextArgs);assert.equal(replay.status,'ok');assert(replay.records.length,'prepared but undelivered page remains retryable');
});

test('strict history consumers accept omitted, null and blank initial cursors without repairing bad tickets',async t=>{
 const {c,root}=await fixture(t),history=path.join(root,'history');await fs.mkdir(history);
 for(const id of ['one','two'])await fs.writeFile(path.join(history,id+'.jsonl'),[
  {type:'session',version:3,id,cwd:c.store.content},
  {type:'message',message:{role:'user',content:[{type:'text',text:'history '+id+' '+('正文😀'.repeat(5000))}]}}
 ].map(JSON.stringify).join('\n')+'\n');
 c.providerHistory=createProviderHistoryReader({projectRoot:c.store.content,home:path.join(root,'empty-home'),providerRoots:{pi:history}});
 await admit(c);const transport=await strictTransport(c),search='nozeli_provider_history_search',read='nozeli_provider_history_read';
 const omitted=await invoke(c,search,{});assert.equal(omitted.status,'ok');assert.equal(omitted.items.length,2);
 for(const placeholder of [null,'']){
  const found=await transport.call(search,{query:null,provider:null,cursor:placeholder,limit:1});assert.equal(found.status,'ok');assert.equal(found.items.length,1);assert(found.nextCursor);
  const next=await transport.call(search,{query:null,provider:null,cursor:found.nextCursor,limit:1});assert.equal(next.status,'ok');assert.notEqual(next.items[0].sessionId,found.items[0].sessionId);
  const source=found.items[0].source,body=await transport.call(read,{source,cursor:placeholder,maxBytes:null});assert.equal(body.status,'ok');assert(body.records.some(record=>record.text.includes('history')));assert(body.nextCursor);
  assert.equal(body.coverage.pageLimitReached,true);
  const budget=c.contextBudget.snapshot('frontdesk');assert(budget.run.usedBytes<budget.run.limitBytes);
  const continued=await transport.call(read,{source,cursor:body.nextCursor,maxBytes:12000});assert.equal(continued.status,'ok');assert(continued.records.length);
  assert.equal(continued.records[0].location.textStart,body.records.at(-1).location.textEnd);
  assert.equal((await transport.call(read,{source,cursor:'forged',maxBytes:null})).status,'invalid_cursor');
 }
 assert.equal((await transport.call(search,{query:null,provider:null,cursor:'forged',limit:null})).status,'invalid_cursor');
 for(const source of [null,'',path.join(history,'one.jsonl'),'forged']){
  const result=await invoke(c,read,{source,cursor:null,maxBytes:null});assert.equal(result.status,'invalid_source');assert.deepEqual(result.records,[]);
 }
 assert.equal((await invoke(c,search,{cursor:null,unknown:null})).error.code,'INVALID_PAYLOAD');
 assert.equal((await invoke(c,read,{source:omitted.items[0].source,unknown:null})).error.code,'INVALID_PAYLOAD');
 const filename=path.join(history,omitted.items[0].sessionId+'.jsonl');await fs.appendFile(filename,'{}\n');
 assert.equal((await transport.call(read,{source:omitted.items[0].source,cursor:null,maxBytes:null})).status,'stale');
 // A non-empty query is user text, not an optional selector to trim away.
 assert.equal((await transport.call(search,{query:'  ',provider:'pi',cursor:null,limit:null})).items.length,0);
});

test('strict document read selectors preserve real snapshot identity and deny foreign refs and private files',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-strict-document-')),contentRoot=path.join(root,'project');await fs.mkdir(contentRoot);
 const host=new DesktopHost(path.join(root,'host-profile')),project=await host.storage.register(contentRoot);
 const c=await openTestController({storage:host.storage,projectId:project.id,runtimeRoot:path.join(root,'runtime'),contentRoot,sessionFactory:spec=>new IdleSession(spec)});
 t.after(async()=>{await c.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 const original='actual document 😀\n'+('body 正文\n'.repeat(5000));
 await fs.writeFile(path.join(c.store.content,'notes.md'),original);await fs.writeFile(path.join(c.store.content,'.env'),'PRIVATE-CREDENTIAL');
 c.frontdeskDocuments=createFrontdeskDocuments({host,projectId:project.id,sync:async()=>{}});await admit(c);
 const transport=await strictTransport(c),name='nozeli_document_read';
 for(const placeholder of [null,'']){
  const first=await transport.call(name,{relPath:'notes.md',readRef:placeholder,projectPath:placeholder,access:null});assert.equal(first.ok,true);assert(first.value.text.startsWith('actual document'));assert(first.value.nextReadRef);
  const next=await transport.call(name,{relPath:placeholder,readRef:first.value.nextReadRef,projectPath:placeholder,access:null});assert.equal(next.ok,true);assert.equal(next.value.readHandle,first.value.readHandle);assert.deepEqual(next.value.version,first.value.version);assert.equal(next.value.offset,first.value.endOffset);
 }
 const first=await invoke(c,name,{relPath:'notes.md'});await fs.writeFile(path.join(c.store.content,'notes.md'),'changed on disk');
 const frozen=await transport.call(name,{relPath:null,readRef:first.value.nextReadRef,projectPath:null,access:null});assert.equal(frozen.ok,true);assert.equal(frozen.value.text,original.slice(frozen.value.offset,frozen.value.endOffset));assert.deepEqual(frozen.value.version,first.value.version);
 const mixed=await transport.call(name,{relPath:'notes.md',readRef:frozen.value.nextReadRef,projectPath:null,access:null});assert.equal(mixed.error.code,'INVALID_PAYLOAD');
 assert.equal((await invoke(c,name,{relPath:'notes.md',readRef:null,unknown:null})).error.code,'INVALID_PAYLOAD');
 const denied=await transport.call(name,{relPath:'.env',readRef:null,projectPath:null,access:'read'});assert.equal(denied.ok,false);assert(!JSON.stringify(denied).includes('PRIVATE-CREDENTIAL'));
 await admit(c);const foreign=await transport.call(name,{relPath:null,readRef:first.value.nextReadRef,projectPath:null,access:null});assert.equal(foreign.error.code,'READ_REF_EXPIRED');
});
