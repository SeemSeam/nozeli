import {openTestController,openTestWorkspace} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {SessionIndex} from '../src/agents/managed/session-index.mjs';
import {NativeCollabRuntime} from '../src/agents/managed/collab/runtime.mjs';
import {exportTimelineOriginal} from '../src/main/timeline-export.mjs';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-session-index-'));
  const store=await openTestWorkspace(path.join(root,'runtime'),path.join(root,'project'));
  await store.mutate(()=>{store.state.jobs=[{id:'job-a',target:'frontdesk',status:'running',context:{},collabAttempts:[{requestId:'request-a',sessionId:'native-session',epoch:'native-session#0'},{requestId:'request-a',sessionId:'session-two',epoch:'session-two#0'}]},{id:'job-b',target:'other-work',revision:2,status:'running',context:{}}];store.state.messages=[{id:'user-a',target:'frontdesk',speaker:'user',text:'Original question',jobId:'job-a'}];});
  const index=new SessionIndex(store);await index.initialize();
  t.after(async()=>{if(!store.closed)await store.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,store,index};
}
const fact=(id,text,extra={})=>({sessionId:'native-session',epoch:'native-session#0',requestId:'request-a',jobId:'job-a',entry:{type:'message',id,parentId:null,message:{role:'assistant',content:[{type:'text',text}]}},...extra});

test('publication messages expose descriptor summary without copying report body into conversation',async t=>{
 const {store,index}=await fixture(t),report={format:'html-static',mediaType:'text/html',objectId:'frozen-report',digest:'a'.repeat(64),byteLength:100,title:'Conclusion',excerpt:'Verified frozen summary',manifestDigest:'b'.repeat(64)};
 store.state.receipts=[{id:'publication',workId:'work',objectId:report.objectId,revision:4,report}];
 const row=index.legacyDTO({id:'publication-message',target:'work',speaker:'agent',publication:'result',objectId:report.objectId});
 assert.equal(row.text,report.excerpt);assert.deepEqual(row.report,report);assert.equal(row.workId,'work');assert.equal(row.revision,4);assert.equal(row.source,'host');assert.equal(row.objectId,report.objectId);
});

test('context clear starts an empty current view while explicit history and subsequent messages survive',async t=>{
 const {store,index}=await fixture(t);
 await index.recordBatch([fact('before-clear','Archived answer')],'frontdesk');
 const boundary=store.state.sessionIndex.sequence;
 await store.mutate(()=>{store.state.frontdeskContextEpoch={sequence:boundary};});
 assert.deepEqual(index.frame().entries,[]);assert.deepEqual(index.frame().deltas,[]);assert.equal(index.frame().hasMore,false);
 assert(index.messages().some(e=>e.text==='Archived answer'));
 assert((await index.page({cursor:'before:'+Number.MAX_SAFE_INTEGER})).entries.some(e=>e.text==='Archived answer'));
 await index.recordBatch([fact('after-clear','New answer')],'frontdesk');
 assert.deepEqual(index.frame().entries.map(e=>e.text),['New answer']);
 const restored=new SessionIndex(store);await restored.initialize();
  assert.deepEqual((await restored.page()).entries.map(e=>e.text),['New answer']);
});

test('durable entry replaces its exact native stream, duplicate snapshot cannot repeat the answer',async t=>{
  const {index}=await fixture(t);
  index.event({sessionId:'native-session',epoch:'native-session#0',requestId:'request-a',jobId:'job-a',streamId:'native-stream-7',event:{type:'message_update',message:{role:'assistant',content:[{type:'text',text:'Partial'}]}}},'frontdesk');
  const stream=index.frame().entries.find(e=>e.streaming);assert.equal(stream.text,'Partial');
  index.event({sessionId:'native-session',epoch:'native-session#0',requestId:'request-a',jobId:'job-a',streamId:'native-stream-7',event:{type:'message_update',message:{role:'assistant',content:[{type:'text',text:'Complete live snapshot'}]},assistantMessageEvent:{type:'text_delta',delta:' snapshot'}}},'frontdesk');
  assert.equal(index.frame().entries.find(e=>e.streaming).text,'Complete live snapshot','The cumulative snapshot replaces prior text; skipped deltas are not required or appended');assert.equal(index.frame().entries.find(e=>e.streaming).id,stream.id);
  await index.recordBatch([fact('entry-1','Complete answer',{streamId:'native-stream-7'})],'frontdesk');
  await index.recordBatch([fact('entry-1','Complete answer',{streamId:'native-stream-7'})],'frontdesk');
  const page=index.frame(),answers=page.entries.filter(e=>e.speaker==='agent');
  assert.equal(answers.length,1);assert.equal(answers[0].text,'Complete answer');assert.equal(answers[0].replacesId,stream.id);assert.equal(page.entries.some(e=>e.streaming),false);
});

test('accepted input remains singular through native live echo and durable admission while repeated text stays distinct',async t=>{
 const {store,index}=await fixture(t);
 const nativeUser={type:'message',id:'native-user-a',message:{role:'user',content:[{type:'text',text:'Original question'}]}};
 for(const type of ['message_start','message_update'])index.event({sessionId:'native-session',epoch:'native-session#0',requestId:'request-a',jobId:'job-a',entryId:nativeUser.id,event:{type,message:nativeUser.message}},'frontdesk');
 assert.deepEqual(index.frame().entries.filter(e=>e.speaker==='user').map(e=>({id:e.id,text:e.text,streaming:e.streaming})),[{id:'user-a',text:'Original question',streaming:undefined}]);
 await index.recordBatch([{...fact(nativeUser.id,''),entry:nativeUser}],'frontdesk');
 assert.equal(index.records().find(e=>e.entryId===nativeUser.id).jobId,'job-a');
 assert.deepEqual(index.frame().entries.filter(e=>e.speaker==='user').map(e=>e.id),['user-a']);
 await store.mutate(()=>{store.state.jobs.push({id:'job-repeat',target:'frontdesk',status:'running',context:{},collabAttempts:[{requestId:'request-repeat',sessionId:'native-session',epoch:'native-session#0'}]});store.state.messages.push({id:'user-repeat',target:'frontdesk',speaker:'user',text:'Original question',jobId:'job-repeat'});});
 index.event({sessionId:'native-session',epoch:'native-session#0',requestId:'request-repeat',jobId:'job-repeat',entryId:'native-repeat',event:{type:'message_start',message:nativeUser.message}},'frontdesk');
 await index.recordBatch([{sessionId:'native-session',epoch:'native-session#0',requestId:'request-repeat',jobId:'job-repeat',entry:{...nativeUser,id:'native-repeat'}}],'frontdesk');
 assert.deepEqual(index.frame().entries.filter(e=>e.speaker==='user').map(e=>e.id),['user-a','user-repeat']);
 index.event({sessionId:'native-session',epoch:'native-session#0',requestId:'request-repeat',jobId:'job-repeat',streamId:'agent-after-repeat',event:{type:'message_update',message:{role:'assistant',content:[{type:'text',text:'Actual assistant output'}]}}},'frontdesk');
 assert.equal(index.frame().entries.find(e=>e.streaming)?.speaker,'agent');
});

test('equal entry IDs from different native sessions stay distinct; changed immutable content is rejected',async t=>{
  const {index}=await fixture(t);
  await index.recordBatch([fact('same-id','Session one')],'frontdesk');
  await index.recordBatch([fact('same-id','Session two',{sessionId:'session-two',epoch:'session-two#0'})],'frontdesk');
  assert.deepEqual(index.frame().entries.filter(e=>e.speaker==='agent').map(e=>e.text),['Session one','Session two']);
  await assert.rejects(index.recordBatch([fact('same-id','Changed content')],'frontdesk'),{code:'TIMELINE_COLLISION'});
  assert.deepEqual(index.frame().entries.filter(e=>e.speaker==='agent').map(e=>e.text),['Session one','Session two']);
  await assert.rejects(index.recordBatch([fact('foreign-job','Wrong work',{jobId:'job-b'})],'frontdesk'),{code:'TIMELINE_OWNER'});
});

test('failed index persistence never publishes an uncommitted native answer and permits exact recovery',async t=>{
  const {store,index}=await fixture(t),persistNativeFacts=store.persistNativeFacts.bind(store);
  store.persistNativeFacts=async()=>{throw Error('storage unavailable');};
  await assert.rejects(index.recordBatch([fact('entry-save','Recoverable answer')],'frontdesk'),/storage unavailable/);
  assert.equal(index.frame().entries.some(e=>e.text==='Recoverable answer'),false);
  store.persistNativeFacts=persistNativeFacts;
  await index.recordBatch([fact('entry-save','Recoverable answer')],'frontdesk');
  assert.equal(index.frame().entries.filter(e=>e.text==='Recoverable answer').length,1);
});

test('native manual binding retroactively identifies only its accepted user entry without a duplicate timeline input',async t=>{
  const {store,index}=await fixture(t);
  await store.mutate(()=>{store.state.jobs.push({id:'manual-job',target:'frontdesk',manual:true,manualPromptId:'manual-123',status:'running',context:{}});store.state.messages.push({id:'manual-user',target:'frontdesk',speaker:'user',text:'Human native input',jobId:'manual-job'});});
  const user={sessionId:'native-session',epoch:'native-session#0',entry:{type:'message',id:'manual-input-entry',message:{role:'user',content:'Human native input'}}};
  await index.recordBatch([user],'frontdesk');
  await index.recordBatch([{sessionId:'native-session',epoch:'native-session#0',entry:{type:'custom',id:'binding-entry',customType:'nozeli-manual-binding',data:{jobId:'manual-job',requestId:'manual-123',epoch:'native-session#0',inputEntryId:'manual-input-entry'}}}],'frontdesk');
  assert.equal(index.frame().entries.filter(e=>e.text==='Human native input').length,1);
  assert.equal(index.records().find(e=>e.entryId==='manual-input-entry').jobId,'manual-job');
  await assert.rejects(index.recordBatch([{sessionId:'native-session',entry:{type:'custom',id:'invalid-binding',customType:'nozeli-manual-binding',data:{jobId:'job-a',requestId:'manual-123',inputEntryId:'manual-input-entry'}}}],'frontdesk'),{code:'TIMELINE_OWNER'});
});

test('cold history survives without a native process and reports corrupt archive rather than substituting another body',async t=>{
  const {store,index}=await fixture(t);
  await index.recordBatch([fact('cold-entry','Original native history')],'frontdesk');
  const saved=index.records()[0],cold=new SessionIndex(store);
  const page=await cold.page();assert.equal(page.entries.find(e=>e.entryId==='cold-entry').text,'Original native history');
  await fs.writeFile(path.join(index.root,saved.objectId+'.json'),'{}');
  const damaged=new SessionIndex(store),bad=await damaged.page();
  assert.equal(bad.entries.find(e=>e.entryId==='cold-entry').availability,'unavailable');
  assert.equal(bad.entries.some(e=>e.text==='Original native history'),false);
});

test('ten thousand historical messages stay paged and retain ordering without changing their accepted text',async t=>{
  const {store,index}=await fixture(t);
  await store.mutate(()=>{store.state.messages=Array.from({length:10000},(_,i)=>({id:'history-'+i,target:'frontdesk',speaker:i%2?'agent':'user',text:'Historical '+i}));});
  const latest=index.frame(null,100);assert.equal(latest.entries.length,100);assert.equal(latest.entries.at(-1).text,'Historical 9999');assert.equal(latest.hasMore,true);
  const older=await index.page({cursor:latest.nextCursor,limit:100});assert.equal(older.entries[0].text,'Historical 9800');assert.equal(older.entries.at(-1).text,'Historical 9899');
  assert.equal(older.entries.some(e=>latest.entries.some(n=>n.id===e.id)),false);
  const first=await index.read('history-0');assert.equal(first.text,'Historical 0');
  assert.equal(store.state.messages[0].text,'Historical 0');
});

test('routing query produces no invented delta; committed clarification remains visible without model prose',async t=>{
  const {store,index}=await fixture(t);
  await store.mutate(()=>{store.state.jobs[0].routing={action:'status',facts:{works:[]}};});
  assert.equal(index.frame().deltas.length,0);
  await store.mutate(()=>{store.state.jobs[1].routing={action:'clarify',question:'Which input version should remain frozen?'};});
  const questions=index.frame().deltas.filter(d=>d.needsAnswer);assert.equal(questions.length,1);assert.equal(questions[0].jobId,'job-b');assert.equal(questions[0].text,'Which input version should remain frozen?');
});

test('cold native errorId zero enrichment keeps original archive bytes but nonzero errors still collide',async t=>{
  const {index}=await fixture(t),original=fact('reload-entry','Exact original message');
  await index.recordBatch([original],'frontdesk');
  const record=index.records().find(r=>r.entryId==='reload-entry'),file=path.join(index.root,record.objectId+'.json'),before=await fs.readFile(file);
  const reloaded=structuredClone(original);reloaded.entry.message.errorId=0;
  await index.recordBatch([reloaded],'frontdesk');
  assert.deepEqual(await fs.readFile(file),before);assert.equal(index.records().filter(r=>r.entryId==='reload-entry').length,1);
  reloaded.entry.message.errorId=42;
  await assert.rejects(index.recordBatch([reloaded],'frontdesk'),{code:'TIMELINE_COLLISION'});
});

test('cold snapshot accepts only exact payload-backed signature elision and preserves immutable journals',async t=>{
  const {index,root}=await fixture(t),original=fact('signed-entry','Exact original answer');
  const reasoning={type:'reasoning',id:'reasoning-1',encrypted_content:'self-owned-encrypted-reasoning'};
  original.entry.message.providerPayload={type:'openaiResponsesHistory',items:[reasoning]};
  original.entry.message.content.unshift({type:'thinking',thinking:'',thinkingSignature:JSON.stringify(reasoning),summary:false});
  await index.recordBatch([original],'frontdesk');
  const record=index.records().find(r=>r.entryId==='signed-entry'),file=path.join(index.root,record.objectId+'.json'),before=await fs.readFile(file);
  const evidenceRoot=path.join(root,'collab-evidence');await fs.mkdir(evidenceRoot);
  const runtime=new NativeCollabRuntime({onEntry:batch=>index.recordBatch(batch.entries,'frontdesk')});
  runtime.sessionId=original.sessionId;runtime.guest={epoch:'native-session#1'};runtime.evidenceRoot=evidenceRoot;
  const deliver=entry=>runtime.receive({t:'nozeli-entry-part',id:entry.id,index:0,final:true,data:Buffer.from(JSON.stringify(entry)).toString('base64')});
  const reloaded=structuredClone(original.entry);delete reloaded.message.content[0].thinkingSignature;reloaded.message.errorId=0;
  await deliver(reloaded);await runtime.receive({t:'snapshot-chunk',final:true});
  assert.deepEqual(await fs.readFile(file),before);assert.equal(index.records().filter(r=>r.entryId==='signed-entry').length,1);
  assert.equal(runtime.answerState,null);assert.equal(runtime.attempts.size,0);assert.equal((await runtime.stored(reloaded.id)).projected,true);
  assert.deepEqual((await runtime.stored(reloaded.id)).entry,reloaded);
  await deliver(original.entry);
  for(const change of [entry=>{entry.message.content[0].thinkingSignature=JSON.stringify({...reasoning,extra:true});},entry=>{entry.message.providerPayload.items[0].encrypted_content='changed';},entry=>{entry.message.content[1].text='changed';},entry=>{entry.message.content[0].thinking='changed';}]){
    const changed=structuredClone(original);change(changed.entry);
    await assert.rejects(index.recordBatch([changed],'frontdesk'),{code:'TIMELINE_COLLISION'});
    await assert.rejects(deliver(changed.entry),/native-entry-mutated/);
  }
  const unbacked=fact('unbacked-entry','No matching provider payload');unbacked.entry.message.content.unshift({type:'thinking',thinking:'',thinkingSignature:JSON.stringify(reasoning)});
  await index.recordBatch([unbacked],'frontdesk');const missingSignature=structuredClone(unbacked);delete missingSignature.entry.message.content[0].thinkingSignature;
  await assert.rejects(index.recordBatch([missingSignature],'frontdesk'),{code:'TIMELINE_COLLISION'});
});

test('metadata requires the complete durable job target request session epoch tuple',async t=>{
  const {index}=await fixture(t);
  for(const extra of [{epoch:'native-session#9'},{requestId:'other-request'},{sessionId:'unknown-session'},{jobId:null},{epoch:null},{jobId:'job-b'}]){
    await assert.rejects(index.recordBatch([fact('bad-'+JSON.stringify(extra),'Must not publish',extra)],'frontdesk'),{code:'TIMELINE_OWNER'});
  }
  await index.recordBatch([fact('old-attempt','Historical exact attempt')],'frontdesk');
  await index.recordBatch([fact('unowned','Unknown native history',{jobId:null,requestId:null})],'frontdesk');
  assert.equal(index.frame().entries.find(e=>e.entryId==='unowned').ownership,'unknown');
  assert.equal(index.frame().entries.some(e=>e.text==='Must not publish'),false);
});

test('manual binding freezes its tuple and old epoch events cannot mutate a current stream',async t=>{
  const {store,index}=await fixture(t);
  await store.mutate(()=>{store.state.jobs.push({id:'manual-job',target:'frontdesk',manual:true,manualPromptId:'manual-request',status:'running'});});
  const binding=(epoch,input)=>({sessionId:'native-session',epoch,entry:{type:'custom',id:'binding-'+input,customType:'nozeli-manual-binding',data:{jobId:'manual-job',requestId:'manual-request',epoch,inputEntryId:input}}});
  await index.recordBatch([binding('epoch-old','input-old'),binding('epoch-new','input-new')],'frontdesk');
  const event=(epoch,type,text)=>({sessionId:'native-session',epoch,jobId:'manual-job',requestId:'manual-request',streamId:'shared-stream',event:{type,message:{role:'assistant',content:text}}});
  index.event(event('epoch-new','message_update','Current output'),'frontdesk');
  index.event(event('epoch-old','message_update','Stale output'),'frontdesk');
  index.event(event('epoch-old','agent_end'),'frontdesk');
  assert.equal(index.frame().entries.find(e=>e.streaming).text,'Current output');
  const wrong=binding('epoch-other','input-new');
  await assert.rejects(index.recordBatch([wrong],'frontdesk'),{code:'TIMELINE_OWNER'});
  await index.recordBatch([fact('late-old','Historical manual answer',{epoch:'epoch-old',jobId:'manual-job',requestId:'manual-request',streamId:'shared-stream'})],'frontdesk');
  assert.equal(index.frame().entries.find(e=>e.streaming).text,'Current output');
  index.event(event('epoch-new','agent_end'),'frontdesk');
  assert.equal(index.frame().entries.some(e=>e.streaming),false);
});

test('entries and every committed delta share a complete nonoverlapping history cursor',async t=>{
  const {store,index}=await fixture(t);
  await store.mutate(()=>{const s=store.state.sessionIndex;for(let i=0;i<237;i++)s.deltas.push({id:'business-'+i,sequence:++s.sequence,kind:'scope',text:'Change '+i});});
  await index.recordBatch([fact('last-answer','Newest answer')],'frontdesk');
  const seen=new Set();let cursor=null;
  do {const page=await index.page({cursor,limit:7});for(const item of [...page.entries,...page.deltas]){assert.equal(seen.has(item.id),false);seen.add(item.id);}assert.ok(page.entries.length+page.deltas.length<=7);if(page.hasMore)assert.ok(page.nextCursor);cursor=page.nextCursor;}while(cursor);
  for(let i=0;i<237;i++)assert.ok(seen.has('business-'+i));
  assert.ok(seen.has('user-a'));assert.equal(seen.size,239);
});

test('tool public projection recursively removes secrets but preserves full public tool body and raw archive',async t=>{
  const {index}=await fixture(t);
  const output={body:'Full user document body '.repeat(1000),nested:{readHandle:'write-capability',credentials:{password:'secret-value'},transport:{roomKey:'room-secret'},file:'/private/runtime/file',public:'visible'},items:[{apiKey:'key-secret',value:42}]};
  const tool=fact('tool-result','');tool.entry.message={role:'toolResult',toolName:'document-read',content:[{type:'text',text:JSON.stringify(output)}]};
  const call=fact('tool-call','');call.entry.message.content=[{type:'toolCall',id:'call-a',name:'document-read',arguments:{query:'keep query',nested:{readHandle:'cap-secret',token:'token-secret',path:'/home/private/object',public:'keep value'}}}];
  await index.recordBatch([tool,call],'frontdesk');
  const dto=await index.read(index.records().find(r=>r.entryId==='tool-result').id),visible=JSON.stringify(dto);
  for(const hidden of ['write-capability','secret-value','room-secret','key-secret','/private/runtime/file'])assert.equal(visible.includes(hidden),false);
  assert.equal(JSON.parse(dto.text).body,output.body);assert.equal(JSON.parse(dto.tool.output).nested.public,'visible');
  const callDTO=await index.read(index.records().find(r=>r.entryId==='tool-call').id);
  assert.equal(callDTO.toolCalls[0].input.query,'keep query');assert.equal(callDTO.toolCalls[0].input.nested.public,'keep value');assert.equal(JSON.stringify(callDTO).includes('cap-secret'),false);
  const raw=await index.object(index.records().find(r=>r.entryId==='tool-result'));
  assert.deepEqual(raw,tool.entry);
});

test('large originals page immutable UTF-8 fields within the encoded IPC bound without lost bytes',async t=>{
  const {index}=await fixture(t),text=('😺汉字\u0000\\" public text\n').repeat(18000);
  const original=fact('huge-entry',text);original.entry.message.content.push({type:'thinking',thinking:'Reasoning '.repeat(20000)},{type:'toolCall',id:'large-call',name:'read',arguments:{body:'Public body '.repeat(20000),readHandle:'hidden'}});
  await index.recordBatch([original],'frontdesk');
  const id=index.records().find(r=>r.entryId==='huge-entry').id,discovery=await index.read(id);
  assert.equal(discovery.availability,'read-required');assert.equal(discovery.text,'');assert.ok(Buffer.byteLength(JSON.stringify({entry:discovery}))<=128*1024);
  assert.deepEqual(discovery.read.fields.map(f=>f.field),['text','reasoning','toolCalls']);
  const expected={text,reasoning:'Reasoning '.repeat(20000),toolCalls:JSON.stringify([{id:'large-call',name:'read',input:{body:'Public body '.repeat(20000)}}])};
  for(const {field,totalBytes} of discovery.read.fields){let offset=0,body='';do{const page=await index.read(id,{version:discovery.read.version,field,offset,limit:65536});assert.ok(Buffer.byteLength(JSON.stringify({entry:page}))<=128*1024);assert.equal(page.offset,offset);assert.equal(page.totalBytes,totalBytes);assert.equal(page.content.includes('\ufffd'),false);body+=page.content;offset=page.nextOffset;}while(offset!==null);assert.equal(body,expected[field]);}
  await assert.rejects(index.read(id,{version:'old',field:'text'}),{code:'TIMELINE_VERSION'});
  for(const options of [{field:'missing'},{field:'text',offset:1},{field:'text',offset:-1},{field:'text',limit:65537},{field:'text',limit:1}])await assert.rejects(index.read(id,{version:discovery.read.version,...options}),{code:'TIMELINE_PAGE'});
  assert.equal((await index.read(id)).read.version,discovery.read.version);
});

test('oversized failed native original retains failure metadata across bounded discovery',async t=>{
  const {index}=await fixture(t);const value=fact('large-failure','failure detail '.repeat(20000));value.entry.message.stopReason='error';
  await index.recordBatch([value],'frontdesk');const record=index.records().find(row=>row.entryId==='large-failure'),entry=await index.read(record.id);
  assert.equal(entry.availability,'read-required');assert.equal(entry.status,'failed');assert.equal(entry.failed,true);assert.equal(entry.durable,true);
  const page=await index.read(record.id,{version:entry.read.version,field:'text',offset:0,limit:16384});assert.equal(page.content,'failure detail '.repeat(20000).slice(0,page.content.length));
});

test('original above the explicit parse budget remains exactly exportable after cold discovery',async t=>{
 const {root,store,index}=await fixture(t),original=fact('export-only','界'.repeat(3*1024*1024));
 await index.recordBatch([original],'frontdesk');const record=index.records().find(row=>row.entryId==='export-only'),cold=new SessionIndex(store);await cold.initialize();
 const page=await cold.page(),placeholder=page.entries.find(row=>row.id===record.id);assert.equal(placeholder.availability,'read-required');assert.equal(placeholder.read.discoveryRequired,true);
 const discovery=await cold.read(record.id);assert.equal(discovery.availability,'read-required');assert.deepEqual(discovery.read.fields,[]);
 const target=path.join(root,'exported-original.json'),scope={projectId:'synthetic-project',generation:1,dead:false};
 const result=await exportTimelineOriginal({managed:{projectionSource:async()=>({index:cold})},dialog:{showSaveDialog:async()=>({filePath:target})},scope,projectId:scope.projectId,id:record.id,version:record.objectId});
 const bytes=await fs.readFile(target);assert.deepEqual(bytes,Buffer.from(JSON.stringify(original.entry)));assert.equal(result.byteLength,bytes.length);
 assert.equal(cold.records().find(row=>row.id===record.id).objectId,record.objectId);
});

test('message model facts survive streams, cold pagination, portable copies and immutable archives',async t=>{
 const {store,index}=await fixture(t);
 const original=fact('model-a','First answer');Object.assign(original.entry.message,{provider:'provider-a',model:'family/model-a'});
 const bytes=JSON.stringify(original.entry);
 index.event({...original,entry:undefined,streamId:'model-stream',event:{type:'message_update',message:original.entry.message}},'frontdesk');
 const stream=index.frame().entries.find(e=>e.streaming);assert.equal(stream.provider,'provider-a');assert.equal(stream.model,'family/model-a');
 await index.recordBatch([{...original,streamId:'model-stream'}],'frontdesk');
 const second=fact('model-b','Second answer');Object.assign(second.entry.message,{provider:'provider-b',model:'model-b'});
 await index.recordBatch([second,fact('no-model','Unrecorded')],'frontdesk');
 const record=index.records().find(e=>e.entryId==='model-a');
 assert.equal(await fs.readFile(path.join(index.root,record.objectId+'.json'),'utf8'),bytes);
 assert.equal(JSON.stringify(original.entry),bytes);
 const cold=new SessionIndex(store),latest=await cold.page({limit:1});assert.equal(latest.entries[0].modelStatus,'not-recorded');
 const prior=await cold.page({cursor:latest.nextCursor,limit:1});assert.equal(prior.entries[0].model,'model-b');
 const oldest=await cold.page({cursor:prior.nextCursor,limit:1});assert.equal(oldest.entries[0].model,'family/model-a');assert.equal(oldest.entries[0].provider,'provider-a');
 const portable=store.state.sessionIndex.portableMessages.find(e=>e.id===record.id);
 assert.equal(index.legacyDTO(portable).model,'family/model-a');assert.equal(index.legacyDTO(portable).source,'portable');
 const user={sessionId:'native-session',entry:{type:'message',id:'user-model',message:{role:'user',content:'User',provider:'not-evidence',model:'not-evidence'}}};
 await index.recordBatch([user],'frontdesk');assert.equal(index.frame().entries.find(e=>e.entryId==='user-model').model,undefined);
});

test('bounded discovery retains new oversized model evidence without reading old huge originals',async t=>{
 const {store,index}=await fixture(t),large=fact('large-model','x'.repeat(9*1024*1024));
 Object.assign(large.entry.message,{provider:'large-provider',model:'large-model'});
 await index.recordBatch([large],'frontdesk');
 const record=index.records().find(e=>e.entryId==='large-model'),cold=new SessionIndex(store);
 cold.object=async()=>{throw Error('Oversized original must not be parsed');};
 const page=await cold.page(),preview=page.entries.find(e=>e.id===record.id);
 assert.equal(preview.availability,'read-required');assert.equal(preview.speaker,'agent');assert.equal(preview.provider,'large-provider');assert.equal(preview.model,'large-model');
 delete record.provider;delete record.model;delete record.modelStatus;delete record.speaker;
 const old=new SessionIndex(store);old.object=cold.object;
 const unknown=(await old.page()).entries.find(e=>e.id===record.id);assert.equal(unknown.model,undefined);assert.equal(unknown.speaker,'system');assert.equal(unknown.read.discoveryRequired,true);
});

test('DTO clipping preserves bounded identity and redacts secret-shaped model metadata',async t=>{
 const {index}=await fixture(t),entry=fact('clipped-model','x'.repeat(160*1024));
 Object.assign(entry.entry.message,{provider:'provider',model:'secret=private-value'});
 await index.recordBatch([entry],'frontdesk');
 const preview=index.frame().entries.find(e=>e.entryId==='clipped-model');
 assert.equal(preview.availability,'read-required');assert.equal(preview.provider,'provider');assert.equal(preview.model,'secret: [redacted]');assert.equal(preview.modelStatus,'recorded');assert(!JSON.stringify(preview).includes('private-value'));
 const discovery=await index.read(preview.id);assert.equal(discovery.model,preview.model);
 const invalid=fact('invalid-model','Answer');Object.assign(invalid.entry.message,{provider:{token:'private'},model:'x'.repeat(513)});
 await index.recordBatch([invalid],'frontdesk');const unknown=index.frame().entries.find(e=>e.entryId==='invalid-model');assert.equal(unknown.model,null);assert.equal(unknown.provider,null);assert.equal(unknown.modelStatus,'not-recorded');
});

test('persisted model metadata survives workspace reopen and portable history without local archives',async t=>{
 const {root,store,index}=await fixture(t),original=fact('persisted-model','Persisted answer');
 Object.assign(original.entry.message,{provider:'native-provider',model:'native-model'});
 await index.recordBatch([original],'frontdesk');await store.close();
 const restored=await openTestWorkspace(path.join(root,'runtime'),path.join(root,'project'));try{
 const cold=new SessionIndex(restored);await cold.initialize();
 const entry=(await cold.page()).entries.find(e=>e.entryId==='persisted-model');assert.equal(entry.provider,'native-provider');assert.equal(entry.model,'native-model');
 const portable=restored.state.sessionIndex.portableMessages.find(e=>e.id===entry.id);
 const imported=new SessionIndex({root:path.join(root,'portable-without-archives'),state:{messages:[structuredClone(portable)],sessionIndex:{entries:[],messageSequences:{},deltas:[]}}});
 const copy=imported.frame().entries[0];assert.equal(copy.provider,'native-provider');assert.equal(copy.model,'native-model');assert.equal(copy.source,'portable');
 }finally{await restored.close();}
});

test('recovery journal facts require the exact durable new owner admission without rewriting original epoch',async t=>{
 const {store,index}=await fixture(t);
 await store.mutate(()=>{const job=store.state.jobs[0],attempt=job.collabAttempts[0];attempt.kind='prompt';attempt.nativeEntryId='original-user';job.restartRecovery={kind:'native-continuation',sourceJobId:job.id,threadId:'native-session',requestId:'request-a',userEntryId:'original-user',originalEpoch:'native-session#0',ownerEpoch:'recovery-epoch',ownerId:'recovery-owner',expectedLeafId:'original-leaf',recoveryAttemptId:'recovery-attempt'};});
 const recovered=fact('recovered-assistant','Original task continues',{epoch:'recovery-epoch',ownerId:'recovery-owner',recoveryAttemptId:'recovery-attempt'});
 for(const patch of [{epoch:'native-session#0'},{ownerId:'wrong-owner'},{recoveryAttemptId:'wrong-attempt'},{recoveryAttemptId:undefined},{sessionId:'session-two'},{requestId:'other-request'}])await assert.rejects(index.recordBatch([{...recovered,...patch}],'frontdesk'),{code:'TIMELINE_OWNER'});
 await index.recordBatch([recovered],'frontdesk');
 const record=store.state.sessionIndex.entries.find(row=>row.entryId==='recovered-assistant');assert.equal(record.ownership,'verified');assert.equal(record.epoch,'recovery-epoch');assert.equal(record.recoveryAttemptId,'recovery-attempt');
 assert.equal(store.state.jobs[0].collabAttempts[0].epoch,'native-session#0');assert.equal(store.state.jobs[0].collabAttempts[0].nativeEntryId,'original-user');
});

test('host delivery history uses its settled native model after reopen, never current configuration or another turn',async t=>{
 const {root,store,index}=await fixture(t),message={id:'host-delivery',target:'frontdesk',speaker:'agent',jobId:'job-a',text:'Delivered native answer'};
 await store.mutate(()=>{Object.assign(store.state.jobs[0],{status:'completed',effective:{provider:'observed-provider',modelId:'observed-model',model:'observed-provider/observed-model'}});store.state.messages.push(message);store.state.residents={frontdesk:{effective:{provider:'current-provider',modelId:'current-model'}}};});
 assert.equal(index.frame().entries.find(entry=>entry.id===message.id).model,'observed-model');assert.equal(message.model,undefined,'projection does not rewrite original history');
 assert.equal(index.legacyDTO({...message,model:'message-model',provider:'message-provider'}).model,'message-model','per-message generation evidence wins');
 assert.equal(index.legacyDTO({...message,target:'other-work'}).modelStatus,'not-recorded');assert.equal(index.legacyDTO({...message,revision:99}).modelStatus,'not-recorded');assert.equal(index.legacyDTO({...message,jobId:'missing'}).modelStatus,'not-recorded');
 for(const status of ['running','failed','unknown']){store.state.jobs[0].status=status;assert.equal(index.legacyDTO(message).modelStatus,'not-recorded');}store.state.jobs[0].status='completed';
 await store.close();const restored=await openTestWorkspace(path.join(root,'runtime'),path.join(root,'project'));
 try{const cold=new SessionIndex(restored);await cold.initialize();const entry=(await cold.page()).entries.find(entry=>entry.id===message.id);assert.equal(entry.provider,'observed-provider');assert.equal(entry.model,'observed-model');assert.equal(entry.modelStatus,'recorded');}finally{await restored.close();}
});
