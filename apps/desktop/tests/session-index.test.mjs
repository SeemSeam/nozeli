import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {SessionIndex} from '../src/agents/managed/session-index.mjs';
import {NativeCollabRuntime} from '../src/agents/managed/collab/runtime.mjs';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-session-index-'));
  const store=await Workspace.open(path.join(root,'runtime'),path.join(root,'project'));
  await store.mutate(()=>{store.state.jobs=[{id:'job-a',target:'frontdesk',status:'running',context:{},collabAttempts:[{requestId:'request-a',sessionId:'native-session',epoch:'native-session#0'},{requestId:'request-a',sessionId:'session-two',epoch:'session-two#0'}]},{id:'job-b',target:'other-work',revision:2,status:'running',context:{}}];store.state.messages=[{id:'user-a',target:'frontdesk',speaker:'user',text:'Original question',jobId:'job-a'}];});
  const index=new SessionIndex(store);await index.initialize();
  t.after(async()=>{if(!store.closed)await store.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,store,index};
}
const fact=(id,text,extra={})=>({sessionId:'native-session',epoch:'native-session#0',requestId:'request-a',jobId:'job-a',entry:{type:'message',id,parentId:null,message:{role:'assistant',content:[{type:'text',text}]}},...extra});

test('durable entry replaces its exact native stream, duplicate snapshot cannot repeat the answer',async t=>{
  const {index}=await fixture(t);
  index.event({sessionId:'native-session',epoch:'native-session#0',requestId:'request-a',jobId:'job-a',streamId:'native-stream-7',event:{type:'message_update',message:{role:'assistant',content:[{type:'text',text:'Partial'}]}}},'frontdesk');
  const stream=index.frame().entries.find(e=>e.streaming);assert.equal(stream.text,'Partial');
  await index.recordBatch([fact('entry-1','Complete answer',{streamId:'native-stream-7'})],'frontdesk');
  await index.recordBatch([fact('entry-1','Complete answer',{streamId:'native-stream-7'})],'frontdesk');
  const page=index.frame(),answers=page.entries.filter(e=>e.speaker==='agent');
  assert.equal(answers.length,1);assert.equal(answers[0].text,'Complete answer');assert.equal(answers[0].replacesId,stream.id);assert.equal(page.entries.some(e=>e.streaming),false);
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
  const {store,index}=await fixture(t),save=store.save.bind(store);
  store.save=async()=>{throw Error('storage unavailable');};
  await assert.rejects(index.recordBatch([fact('entry-save','Recoverable answer')],'frontdesk'),/storage unavailable/);
  assert.equal(index.frame().entries.some(e=>e.text==='Recoverable answer'),false);
  store.save=save;
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
