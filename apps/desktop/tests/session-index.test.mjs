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

test('direct background and converted foreground inputs keep their actual task binding after reopening',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-input-route-')),runtimeRoot=path.join(root,'runtime'),contentRoot=path.join(root,'project');
 const c=await openTestController({runtimeRoot,contentRoot});c.kick=()=>{};
 t.after(async()=>{await c.stop();if(!c.store.closed)await c.store.close();await fs.rm(root,{recursive:true,force:true});});
 await c.start();
 const task=await c.submitTask('帮我继续美化一下 html界面',{requestKey:'direct-background-route'});
 const front=await c.send('frontdesk','先讨论页面配色',{requestKey:'foreground-route'});
 const ordinary=await c.send('frontdesk','这条仍只在前台讨论',{requestKey:'ordinary-foreground-route'});
 const source=c.store.state.messages.find(message=>message.jobId===front.jobId&&message.speaker==='user');
 const converted=await c.convertMessage(source.id,'把讨论中的页面调整交给后台',{requestKey:'convert-background-route'});
 const before=c.timeline.frame().entries;
 assert.equal(before.find(entry=>entry.jobId===task.jobId&&entry.speaker==='user').taskRequestId,task.jobId);
 assert.equal(before.find(entry=>entry.id===source.id).taskRequestId,converted.jobId);
 assert.equal(before.find(entry=>entry.jobId===ordinary.jobId&&entry.speaker==='user').taskRequestId,undefined);
 assert.equal(before.find(entry=>entry.id===source.id).text,'先讨论页面配色');
 await c.stop();await c.store.close();
 const restored=await openTestWorkspace(runtimeRoot,contentRoot),index=new SessionIndex(restored);await index.initialize();
 try{
  const after=index.frame().entries;
  assert.equal(after.find(entry=>entry.jobId===task.jobId&&entry.speaker==='user').taskRequestId,task.jobId);
  assert.equal(after.find(entry=>entry.id===source.id).taskRequestId,converted.jobId);
  assert.equal(after.find(entry=>entry.jobId===ordinary.jobId&&entry.speaker==='user').taskRequestId,undefined);
 }finally{await restored.close();}
});

test('oversized background input remains task-bound when its body requires separate reading',async t=>{
 const {store,index}=await fixture(t);
 await store.mutate(()=>{Object.assign(store.state.messages[0],{taskRequestId:'accepted-background',text:'长篇HTML材料。'.repeat(20000)});});
 const clipped=index.frame().entries.find(entry=>entry.id==='user-a');
 assert.equal(clipped.availability,'read-required');assert.equal(clipped.taskRequestId,'accepted-background');
 assert.equal(clipped.speaker,'user');assert.equal(clipped.target,'frontdesk');
});

test('ingested native metadata stays archived through cold reopen and cache eviction while originals remain readable',async t=>{
 const {root,store,index}=await fixture(t);
 const metaFact=(type,id,body)=>({sessionId:'native-session',entry:{type,id,...body}});
 const modelChange=metaFact('model_change','meta-model',{model:'provider/model'});
 const thinkingChange=metaFact('thinking_level_change','meta-thinking',{level:'high'});
 const sessionInfo=metaFact('session_info','meta-info',{facts:['native session facts']});
 await index.recordBatch([fact('classified-answer','Real worker answer'),modelChange,thinkingChange,sessionInfo],'frontdesk');
 for(const [entryId,type] of [['meta-model','model_change'],['meta-thinking','thinking_level_change'],['meta-info','session_info']]){
  const row=index.records().find(r=>r.entryId===entryId);
  assert.equal(row.entryType,type);assert.equal(row.recordKind,'metadata');
  assert.equal(row.jobId,null);assert.equal(row.speaker,undefined);
 }
 assert.equal(index.records().find(r=>r.entryId==='classified-answer').recordKind,'conversation');
 assert.equal(index.frame().entries.some(e=>String(e.entryId||'').startsWith('meta-')),false);
 const cold=new SessionIndex(store);await cold.initialize();
 const page=await cold.page();
 assert.equal(page.entries.some(e=>String(e.entryId||'').startsWith('meta-')),false,'cold metadata never becomes a system conversation row');
 assert.equal(page.entries.find(e=>e.entryId==='classified-answer').text,'Real worker answer');
 cold.cache.clear();cold.deferred.clear();
 assert.equal(cold.frame().entries.some(e=>String(e.entryId||'').startsWith('meta-')),false,'persisted kinds survive cache eviction without hydration');
 const metaRow=cold.records().find(r=>r.entryId==='meta-model');
 assert.deepEqual(await cold.object(metaRow),modelChange.entry,'raw archive body is untouched');
 const discovery=await cold.read(metaRow.id);
 assert.equal(discovery.recordKind,'metadata');assert.equal(discovery.availability,'read-required');
 assert.deepEqual(discovery.read.fields.map(f=>f.field),['text']);
 const firstPage=await cold.read(metaRow.id,{version:discovery.read.version,field:'text',offset:0,limit:128});
 assert.equal(firstPage.totalBytes,Buffer.byteLength(JSON.stringify(modelChange.entry)));
 assert.equal(JSON.stringify(modelChange.entry).startsWith(firstPage.content),true);
 const target=path.join(root,'exported-metadata.json'),scope={projectId:'synthetic-project',generation:1,dead:false};
 await exportTimelineOriginal({managed:{projectionSource:async()=>({index:cold})},dialog:{showSaveDialog:async()=>({filePath:target})},scope,projectId:scope.projectId,id:metaRow.id,version:metaRow.objectId});
 assert.deepEqual(await fs.readFile(target),Buffer.from(JSON.stringify(modelChange.entry)));
});

test('legacy records without an indexed kind classify bounded on read without changing identity or bodies',async t=>{
 const {store,index}=await fixture(t);
 const future={sessionId:'native-session',entry:{type:'future_control',id:'legacy-future',payload:'unclassified native fact'}};
 await index.recordBatch([fact('legacy-answer','Legacy answer'),{sessionId:'native-session',entry:{type:'model_change',id:'legacy-meta',model:'provider/model'}},future],'frontdesk');
 const before=index.records().map(r=>({id:r.id,entryId:r.entryId,sequence:r.sequence,objectId:r.objectId}));
 const bodies=await Promise.all(before.map(r=>fs.readFile(path.join(index.root,r.objectId+'.json'))));
 await store.mutate(()=>{for(const row of store.state.sessionIndex.entries){delete row.entryType;delete row.recordKind;}});
 const replay=new SessionIndex(store);
 const coldRows=replay.frame().entries.filter(e=>e.source==='native');
 assert.equal(coldRows.find(e=>e.entryId==='legacy-answer').recordKind,'conversation','old speaker evidence still classifies conversation');
 for(const entryId of ['legacy-meta','legacy-future']){
  const row=coldRows.find(e=>e.entryId===entryId);
  assert.equal(row.recordKind,'unclassified');assert.equal(row.speaker,'system');assert.equal(row.availability,'read-required');assert.equal(row.read.discoveryRequired,true);
  assert.equal(row.status,undefined);assert.equal(row.complete,undefined,'unclassified is pending, never an invented execution');
 }
 const page=await replay.page();
 assert.equal(page.entries.some(e=>e.entryId==='legacy-meta'),false,'known metadata classifies from its bounded body once hydrated');
 const unknown=page.entries.find(e=>e.entryId==='legacy-future');
 assert.equal(unknown.recordKind,'unclassified');assert.equal(unknown.availability,'read-required');
 assert.equal(unknown.text.includes('unclassified native fact'),true,'unknown kinds stay readable with their own body');
 assert.equal(page.entries.find(e=>e.entryId==='legacy-answer').text,'Legacy answer');
 const after=replay.records().map(r=>({id:r.id,entryId:r.entryId,sequence:r.sequence,objectId:r.objectId}));
 assert.deepEqual(after,before,'enrichment keeps the same entry identity');
 assert.deepEqual(await Promise.all(after.map(r=>fs.readFile(path.join(replay.root,r.objectId+'.json')))),bodies,'immutable bodies are never rewritten');
 for(const [entryId,kind] of [['legacy-answer','conversation'],['legacy-meta','metadata'],['legacy-future','unclassified']])assert.equal(replay.records().find(r=>r.entryId===entryId).recordKind,kind);
 assert.equal(replay.messages().some(e=>e.entryId==='legacy-future'),false,'unclassified native rows never enter model context');
 assert.equal(replay.messages().some(e=>e.text==='Legacy answer'),true);
 replay.cache.clear();replay.deferred.clear();
 assert.equal(replay.frame().entries.some(e=>e.entryId==='legacy-meta'),false,'enriched kinds survive eviction');
});

test('verified user echo suppression holds without hydration while genuine native input remains',async t=>{
 const {store,index}=await fixture(t);
 const bound={sessionId:'native-session',epoch:'native-session#0',requestId:'request-a',jobId:'job-a',entry:{type:'message',id:'echo-user',message:{role:'user',content:[{type:'text',text:'Original question'}]}}};
 const free={sessionId:'native-session',entry:{type:'message',id:'free-user',message:{role:'user',content:[{type:'text',text:'Standalone native input'}]}}};
 await index.recordBatch([bound,free],'frontdesk');
 const cold=new SessionIndex(store);await cold.initialize();
 cold.cache.clear();cold.deferred.clear();
 const rows=cold.frame().entries;
 assert.equal(rows.some(e=>e.entryId==='echo-user'),false,'a bound journal echo stays suppressed even unhydrated');
 const freeRow=rows.find(e=>e.entryId==='free-user');
 assert.equal(freeRow.speaker,'user');assert.equal(freeRow.recordKind,'conversation');assert.equal(freeRow.availability,'not-loaded');
 const page=await cold.page();
 assert.equal(page.entries.some(e=>e.entryId==='echo-user'),false);
 assert.equal(page.entries.find(e=>e.entryId==='free-user').text,'Standalone native input');
 assert.equal(page.entries.some(e=>e.id==='user-a'),true);
});

test('real native failure stays visible after cold reopen instead of being hidden with the metadata kinds',async t=>{
 const {store,index}=await fixture(t);
 const failure=fact('failed-answer','Partial work then error');failure.entry.message.isError=true;failure.entry.message.stopReason='error';
 await index.recordBatch([failure],'frontdesk');
 const cold=new SessionIndex(store);await cold.initialize();
 const pending=cold.frame().entries.find(e=>e.entryId==='failed-answer');
 assert.equal(pending.speaker,'agent');assert.equal(pending.recordKind,'conversation');
 const row=(await cold.page()).entries.find(e=>e.entryId==='failed-answer');
 assert.equal(row.status,'failed');assert.equal(row.failed,true);assert.equal(row.text,'Partial work then error');
});

test('re-ingesting a legacy row enriches its indexed kind without rewriting the immutable body',async t=>{
 const {store,index}=await fixture(t);
 const metadata={sessionId:'native-session',entry:{type:'session_info',id:'replay-meta',facts:['native session facts']}};
 await index.recordBatch([fact('replay-answer','Replay answer'),metadata],'frontdesk');
 const record=index.records().find(r=>r.entryId==='replay-meta'),file=path.join(index.root,record.objectId+'.json'),body=await fs.readFile(file);
 await store.mutate(()=>{for(const row of store.state.sessionIndex.entries){delete row.entryType;delete row.recordKind;}});
 await index.recordBatch([metadata],'frontdesk');
 const enriched=index.records().find(r=>r.entryId==='replay-meta');
 assert.equal(enriched.entryType,'session_info');assert.equal(enriched.recordKind,'metadata');
 assert.equal(enriched.objectId,record.objectId);
 assert.deepEqual(await fs.readFile(file),body);
 assert.equal(index.records().filter(r=>r.entryId==='replay-meta').length,1);
 assert.equal(index.frame().entries.some(e=>e.entryId==='replay-meta'),false);
});

test('read-only replay of legacy rows stays classified without any store writes',async t=>{
 const {store}=await fixture(t);
 const scratch=new SessionIndex(store);await scratch.initialize();
 await scratch.recordBatch([fact('replay-answer','Replay answer'),{sessionId:'native-session',entry:{type:'model_change',id:'replay-meta',model:'provider/model'}}],'frontdesk');
 await store.mutate(()=>{for(const row of store.state.sessionIndex.entries){delete row.entryType;delete row.recordKind;}});
 const readOnly={root:store.root,state:structuredClone(store.state)};
 const replay=new SessionIndex(readOnly);
 const coldRows=replay.frame().entries.filter(e=>e.source==='native');
 assert.equal(coldRows.find(e=>e.entryId==='replay-answer').recordKind,'conversation');
 assert.equal(coldRows.find(e=>e.entryId==='replay-meta').recordKind,'unclassified','no ghost execution while cold');
 const page=await replay.page();
 assert.equal(page.entries.some(e=>e.entryId==='replay-meta'),false,'hydrated metadata disappears without a store write');
 assert.equal(page.entries.find(e=>e.entryId==='replay-answer').text,'Replay answer');
 assert.equal(readOnly.state.sessionIndex.entries.find(r=>r.entryId==='replay-meta').recordKind,undefined,'read-only classification does not mutate retained index state');
 assert.equal(replay.records().find(r=>r.entryId==='replay-meta').recordKind,undefined);
});

test('legacy classification persistence failure remains visible instead of silently succeeding',async t=>{
 const {store,index}=await fixture(t);
 await index.recordBatch([{sessionId:'native-session',entry:{type:'model_change',id:'classify-write-failure',model:'synthetic/model'}}],'frontdesk');
 await store.mutate(()=>{for(const row of store.state.sessionIndex.entries){delete row.entryType;delete row.recordKind;}});
 const replay=new SessionIndex({root:store.root,state:structuredClone(store.state),mutateNative:async()=>{throw Object.assign(Error('classification persistence unavailable'),{code:'STORAGE_RESULT_UNKNOWN'});}});
 await assert.rejects(replay.page(),{code:'STORAGE_RESULT_UNKNOWN'});
});

test('native system instructions are metadata while explicit native system errors remain inspectable',async t=>{
 const {store,index}=await fixture(t);
 const instruction={sessionId:'native-session',entry:{type:'message',id:'native-base-instructions',message:{role:'system',content:'Synthetic execution base instructions'}}};
 const failure={sessionId:'native-session',entry:{type:'message',id:'native-system-error',message:{role:'system',content:'Synthetic real system failure',isError:true}}};
 await index.recordBatch([instruction,failure],'frontdesk');
 const cold=new SessionIndex(store);assert(!cold.frame().entries.some(e=>e.entryId==='native-base-instructions'));
 const page=await cold.page();assert(!page.entries.some(e=>e.entryId==='native-base-instructions'));
 const error=page.entries.find(e=>e.entryId==='native-system-error');assert.equal(error.recordKind,'unclassified');assert.equal(error.availability,'read-required');assert.match(error.text,/Synthetic real system failure/);
 const raw=await cold.read(cold.records().find(r=>r.entryId==='native-base-instructions').id);assert.equal(raw.recordKind,'metadata');assert.match(raw.text,/Synthetic execution base instructions/);
});

test('review decisions, blocked application, application completion and cleanup remain separate durable scoped facts',async t=>{
 const {store,index}=await fixture(t),created=await store.submit('Review facts','Host fixture');
 const work=store.find(created.id);
 await store.mutate(()=>{work.status='review';work.revision=1;work.result={objectId:'frozen-review-object',revision:1};});
 await store.mutate(()=>{
  work.status='closing';work.outcome='accept';
  work.closure={decision:'accept',revision:1,requestKey:'decision-fact-001',binding:{workId:work.id,revision:1,objectId:work.result.objectId,candidateCommit:null},phase:'requested'};
 });
 await store.mutate(()=>{work.closure.phase='integrating';});
 await store.mutate(()=>{work.closure.phase='blocked';work.closure.error='Merge paused; api_key=PRIVATE';});
 const blocked=structuredClone(store.state.sessionIndex.deltas.find(row=>row.kind==='review-application-blocked'));
 assert.ok(blocked);assert.equal(blocked.reason.includes('PRIVATE'),false);
 await store.mutate(()=>{});
 await store.mutate(()=>{work.closure.phase='integrating';delete work.closure.error;});
 await store.mutate(()=>{work.closure.git={complete:true,status:'merged',commit:'frozen-commit'};work.closure.phase='cleanup';});
 await store.mutate(()=>{work.closure.phase='complete';work.closure.completedAt='2026-11-09T00:00:00Z';work.status='ended';});
 await store.mutate(()=>{});
 const facts=store.state.sessionIndex.deltas.filter(row=>row.workId===work.id&&row.kind.startsWith('review-'));
 assert.deepEqual(facts.map(row=>row.kind),['review-decision-registered','review-application-blocked','review-application-completed','review-cleanup-completed']);
 assert.deepEqual(facts[1],blocked,'later success never overwrites the earlier blocked event');
 assert.equal(new Set(facts.map(row=>row.id)).size,4);
 assert.ok(facts.every((row,i)=>row.source==='host'&&row.objectId==='frozen-review-object'&&row.revision===1&&(!i||row.sequence>facts[i-1].sequence)));
 const rows=[];let cursor=null;
 do{const frame=await index.page({workId:work.id,cursor,limit:1});rows.unshift(...frame.deltas);cursor=frame.nextCursor;}while(cursor);
 assert.deepEqual(rows.filter(row=>row.kind.startsWith('review-')),facts);
 const restored=new SessionIndex(store);assert.deepEqual((await restored.page({workId:work.id})).deltas.filter(row=>row.kind.startsWith('review-')),facts);
});

test('existing legacy closures are not backfilled into invented review history',async t=>{
 const {store}=await fixture(t),created=await store.submit('Legacy closure','Host fixture'),work=store.find(created.id);
 await store.mutate(()=>{
  work.status='ended';work.outcome='accept';work.revision=1;work.result={objectId:'legacy-object',revision:1};
  work.closure={decision:'accept',revision:1,requestKey:'legacy-decision-001',binding:{workId:work.id,revision:1,objectId:'legacy-object',candidateCommit:null},phase:'complete',git:{complete:true}};
 });
 // Simulate an old ledger which retained only its current closure snapshot.
 await store.mutate(()=>{store.state.sessionIndex.deltas=store.state.sessionIndex.deltas.filter(row=>!row.kind.startsWith('review-'));});
 await store.mutate(()=>{});
 assert.equal(store.state.sessionIndex.deltas.some(row=>row.kind.startsWith('review-')),false);
});

test('unindexed ledger rows keep their retained position in frames and reads instead of sequence zero',async()=>{
 // Degraded ledger: rows exist without durable messageSequences (lost local
 // index, imported or portable history). ordered() kept the retained position;
 // frames and reads must agree instead of flattening every row to 0 and
 // letting random id ties float a new conversation to the top.
 const state={jobs:[],works:[],messages:[
  {id:'older',target:'frontdesk',speaker:'user',text:'older conversation'},
  {id:'older-reply',target:'frontdesk',speaker:'agent',text:'older answer'},
  {id:'newer',target:'frontdesk',speaker:'user',text:'new conversation'},
 ],sessionIndex:{version:1,sequence:0,entries:[],messageSequences:{},deltas:[]}};
 const index=Object.create(SessionIndex.prototype);index.store={state};index.streams=new Map();
 assert.deepEqual(index.ordered().map(row=>[row.id,row.sequence]),[['older',1],['older-reply',2],['newer',3]]);
 const page=index.frame();
 assert.deepEqual(page.entries.map(entry=>[entry.id,entry.sequence]),[['older',1],['older-reply',2],['newer',3]],'a new conversation appends after older history, never jumps to the top');
 assert.equal(index.legacyDTO(state.messages[2]).sequence,3);
 assert.equal((await index.read('newer')).sequence,3);
});

test('task rows carry the durable first-submission anchor across supplements, worker rounds and updates',async t=>{
 const {store,index}=await fixture(t);
 await store.mutate(()=>{
  store.state.messages.push({id:'plain-later',target:'frontdesk',speaker:'user',text:'ordinary chat',jobId:'job-a'});
  store.state.jobs.push(
   {id:'a-root',target:'orchestrator',type:'intake',status:'completed'},
   {id:'a-next',target:'orchestrator',type:'intake',routing:{action:'continue',workId:'a'},status:'completed'},
   {id:'a-worker',target:'a',type:'supplement',revision:2,context:{sourceJobId:'a-next'},status:'running',collabAttempts:[{requestId:'request-a',sessionId:'native-session',epoch:'native-session#0'}]});
  store.state.works.push({id:'a',sourceJob:'a-root',sourceInputJobIds:['a-root','a-next'],revision:2,status:'running'});
  store.state.messages.push({id:'a-input',target:'orchestrator',speaker:'user',text:'first task',jobId:'a-root',taskRequestId:'a-root'});
  store.state.messages.push({id:'plain-after',target:'frontdesk',speaker:'user',text:'ordinary after',jobId:'job-a'});
  store.state.messages.push({id:'a-more',target:'orchestrator',speaker:'user',text:'supplement',jobId:'a-next',taskRequestId:'a-next'});
 });
 const anchor=store.state.sessionIndex.messageSequences['a-input'];
 assert.ok(Number.isSafeInteger(anchor));
 const row=id=>index.frame().entries.find(entry=>entry.id===id);
 assert.equal(row('a-input').firstSubmissionSequence,anchor);
 assert.equal(row('a-more').firstSubmissionSequence,anchor,'a supplement re-states the first submission position, never its own latest sequence');
 assert.equal(row('plain-after').firstSubmissionSequence,undefined,'ordinary conversations carry no task anchor');
 const delta=index.frame().deltas.find(item=>item.kind==='work-created'&&item.workId==='a');
 assert.equal(delta.firstSubmissionSequence,anchor,'work-created facts stay anchored to the same first submission');
 const retainedDelta=store.state.sessionIndex.deltas.find(item=>item.id===delta.id);
 delete retainedDelta.firstSubmissionSequence;
 assert.equal(index.frame().deltas.find(item=>item.id===delta.id).firstSubmissionSequence,anchor,'older stored facts receive the same read-only anchor without rewriting history');
 assert.equal(retainedDelta.firstSubmissionSequence,undefined);
 await index.recordBatch([fact('a-round','A worker output',{jobId:'a-worker'})],'a');
 const native=index.frame().entries.find(entry=>entry.entryId==='a-round');
 assert.equal(native.firstSubmissionSequence,anchor);
 assert.ok(native.sequence>anchor,'the row keeps its own durable sequence for paging and boundary filters');
 const scoped=await index.page({workId:'a'});
 assert.ok(scoped.entries.length>0);
 assert.ok(scoped.entries.every(item=>item.firstSubmissionSequence===anchor),'scoped task pages stay pinned through cold recovery');
});

test('converted foreground input anchors at its original accounting sequence',async t=>{
 const {store,index}=await fixture(t);
 await store.mutate(()=>{
  store.state.jobs.push({id:'front',target:'frontdesk',type:'front',status:'completed'});
  store.state.messages.push({id:'front-user',target:'frontdesk',speaker:'user',text:'discuss colors',jobId:'front'});
 });
 const original=store.state.sessionIndex.messageSequences['front-user'];
 await store.mutate(()=>{
  store.state.jobs.push({id:'conv',target:'orchestrator',type:'intake',status:'completed',context:{frontJobId:'front'}});
  const source=store.state.messages.find(message=>message.id==='front-user');source.taskRequestId='conv';
  store.state.messages.push({id:'conv-input',target:'frontdesk',speaker:'user',text:'move to background',jobId:'conv',taskRequestId:'conv'});
 });
 const row=id=>index.frame().entries.find(entry=>entry.id===id);
 assert.equal(row('front-user').firstSubmissionSequence,original,'the anchor keeps the original foreground accounting, not the background intake creation');
 assert.equal(row('conv-input').firstSubmissionSequence,original);
 assert.ok(row('conv-input').sequence>original,'the conversion instruction itself still appends in its own turn');
});

test('live streams keep their start order with distinct sequences instead of hash-id ties',async t=>{
 const {index}=await fixture(t);
 const live=(stream,text)=>index.event({sessionId:'native-session',epoch:'native-session#0',requestId:'request-a',jobId:'job-a',streamId:stream,event:{type:'message_update',message:{role:'assistant',content:[{type:'text',text}]}}},'frontdesk');
 live('stream-b','first started');live('stream-a','second started');
 const rows=index.frame().entries.filter(entry=>entry.streaming);
 assert.deepEqual(rows.map(entry=>entry.text),['first started','second started']);
 assert.ok(rows[0].sequence<rows[1].sequence,'start order decides the live order, not the stream id hash');
 assert.ok(rows[0].sequence>Number.MAX_SAFE_INTEGER-16,'live rows still sort after every durable row');
});
