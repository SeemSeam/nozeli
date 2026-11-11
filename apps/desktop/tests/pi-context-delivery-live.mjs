// Live context-cutover contract against the REAL vendored Pi runtime and a
// credential-free loopback provider (docs/context-delivery-design.md §6/§13):
//   - raw user text is the only user entry and reaches the provider verbatim;
//   - explicit materials ride ONE journaled custom message with provenance,
//     atomically bound to the same run/job as the raw text;
//   - the per-request projection rides the native `context` hook on every LLM
//     call of the run, is present in provider requests and NEVER in the
//     journal (no display:false fallback, no accumulation across tool loops);
//   - duplicate request identities are refused without resend;
//   - over-budget projections block the request before any provider call;
//   - REAL native auto compaction (small contextWindow + private fixture
//     settings) changes the context epoch and resets generation accounting
//     without resurrecting old projections; manual compaction does the same;
//   - reload/resume replays nothing.
// Run: NOZELI_TEST_LIVE=1 node --test tests/pi-context-delivery-live.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {serve,prepare} from './pi-provider.fixture.mjs';

const PROJECTION_OPEN='<nozeli-context-projection';
const ownerEntry=path.resolve(import.meta.dirname,'../../../integrations/pi/src/owner.mjs');
const rawUserText='  raw leading space\nsecond line  ';

const textOf=message=>Array.isArray(message.content)?message.content.filter(block=>block?.type==='text').map(block=>block.text).join(''):message.content;
const projectionHits=request=>textOf({content:[{type:'text',text:request.messages.map(textOf).join('\n')}]}).split(PROJECTION_OPEN).length-1;

// Direct owner JSONL client: the delivery ledger is keyed on the host request
// identity, which PiSession mints per call — the duplicate guard is a bridge
// contract and is exercised here against the real worker entry.
class OwnerClient{
  constructor(dirs){this.dirs=dirs;this.pending=new Map();this.events=[];}
  async start(){
    this.child=spawn(process.execPath,[ownerEntry],{cwd:this.dirs.cwd,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NOZELI_PI_OWNER_HOME:this.dirs.home,PI_CODING_AGENT_DIR:this.dirs.agentDir,PATH:process.env.PATH},stdio:['pipe','pipe','ignore']});
    // Registered at spawn: the owner may exit while a request is still being
    // awaited, and a late once('exit') would then wait forever.
    this.exited=new Promise(resolve=>this.child.once('exit',resolve));
    this.child.stdout.setEncoding('utf8');let buffer='';
    this.child.stdout.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;const frame=JSON.parse(line);if(frame.event){this.events.push(frame);continue;}const waiting=this.pending.get(frame.id);if(!waiting)continue;this.pending.delete(frame.id);clearTimeout(waiting.timer);frame.error?waiting.reject(Object.assign(Error(frame.error.message),{code:frame.error.code,deliveryPhase:frame.error.deliveryPhase})):waiting.resolve(frame.result);}});
    await this.request('start',{cwd:this.dirs.cwd,home:this.dirs.home,agentDir:this.dirs.agentDir,instructions:'Stable role rules only.',tools:[]},60000);
  }
  request(method,params={},timeout=60000){
    const id=randomUUID();
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(Error('owner request timeout'),{code:'PI_TIMEOUT'}));},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  }
  async stop(){try{await this.request('stop',{},15000);}catch{}this.child.kill('SIGKILL');await this.exited;}
}

test('raw text, journaled materials and ephemeral projection share one native run; tool loops never journal the projection',{timeout:180000},async t=>{
  const provider=await serve((request,index)=>{
    if(index===1)return {tool:'read',id:'read-note',args:{path:'note.txt'}};
    return {text:'Turn complete after the tool loop.'};
  });
  t.after(()=>provider.close());
  const dirs=await prepare(provider.url);
  await fs.writeFile(path.join(dirs.cwd,'note.txt'),'fixture note used by the native read tool');
  const nativeEvents=[];
  const session=new PiSession({...dirs,role:'worker',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[],onNativeEvent:fact=>nativeEvents.push(fact.event)});
  t.after(async()=>{try{await session.stop();}finally{await provider.close();await fs.writeFile(path.join(dirs.root,'context-delivery-evidence.json'),JSON.stringify({requests:provider.requests,nativeEvents:nativeEvents.filter(event=>String(event.type).startsWith('nozeli'))},null,2));}});
  await session.start();
  const materials=[{id:'paper',version:'v3',mediaType:'text/markdown',provenance:{source:'frontdesk selection',versionLabel:'frozen revision 3'},text:'Exact frozen material body, page 1.\nPage 2 continues here.'}];
  const answer=await session.prompt(rawUserText,{job:{id:'ctx-job-1',target:'worker',revision:1,type:'work'},materials,projection:{text:'Bound Work W rev 1; no pending effects.',sources:[{id:'work',version:'1'}]}});
  assert.equal(answer.text,'Turn complete after the tool loop.');
  // Provider saw the RAW text as the only fresh user input, verbatim.
  const userTexts=provider.requests.flatMap(request=>request.messages.filter(message=>message.role==='user').map(message=>textOf(message)??''));
  assert.ok(userTexts.includes(rawUserText),'raw user text must reach the provider byte-identical');
  assert.equal(provider.requests.filter(request=>request.messages.some(message=>(textOf(message)??'').includes('Exact frozen material body'))).length,2,'materials envelope rides both LLM calls of the tool loop');
  // Delivery evidence: exact native entries, separate from turn success.
  assert.equal(answer.nativeEntry.persisted,true);
  assert.equal(answer.delivery.phase,'native-record-confirmed');
  assert.equal(answer.delivery.text.verbatim,true);
  assert.equal(answer.delivery.text.fidelity,'exact','confirmation requires exact raw-text fidelity');
  assert.equal(answer.delivery.text.sha256,await import('node:crypto').then(crypto=>crypto.createHash('sha256').update(rawUserText).digest('hex')));
  assert.equal(answer.delivery.materials[0].id,'paper');
  assert.equal(answer.delivery.materials[0].entryId!==null,true);
  assert.equal(answer.delivery.projection.llmCalls,2);
  assert.equal(answer.delivery.projection.persisted,false);
  assert.equal(answer.contextEpoch,'compaction:0:root');
  const journal=await fs.readFile(session.sessionFile,'utf8');
  assert.ok(journal.includes('"nozeli-materials"'),'materials are a real journaled custom entry');
  assert.ok(journal.includes('"requestId"'),'material entry carries its delivery identity');
  assert.equal(journal.includes(PROJECTION_OPEN),false,'the projection must never enter the native journal');
  assert.equal(nativeEvents.filter(event=>event.type==='nozeliDelivery').length>=3,true,'prepared/submitted/record-confirmed delivery facts are observable');
  // Reload keeps the journal byte-identical and replays nothing.
  const requestsBefore=provider.requests.length;
  await session.reload();
  assert.equal(provider.requests.length,requestsBefore,'reload must not issue model calls');
  const threadId=session.threadId,file=session.sessionFile;
  await session.stop();
  const resumed=new PiSession({...dirs,role:'worker',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[]});
  await resumed.preflightToolsDigest(resumed.toolsDigest);await resumed.start(threadId);
  assert.equal(await fs.readFile(file,'utf8'),journal,'resume must not rewrite native history');
  assert.equal(provider.requests.length,requestsBefore,'cold resume must not replay any user input');
  await resumed.stop();
  t.diagnostic('Context delivery evidence: '+dirs.root);
});

test('a delivered or unknown request identity is never resent; identical text under a new identity is new input',{timeout:120000},async t=>{
  const provider=await serve(()=>({text:'ack'}));
  t.after(()=>provider.close());
  const dirs=await prepare(provider.url);
  const owner=new OwnerClient(dirs);
  t.after(()=>owner.stop());
  await owner.start();
  const materials=[{id:'paper-a',version:'v1',text:'first frozen material body'},{id:'paper-b',version:'v2',provenance:{source:'selection'},text:'second frozen material body'}];
  const first=await owner.request('prompt',{text:'send once',requestId:'identity-1',job:{id:'dup-job'},images:[],materials});
  assert.equal(first.nativeEntry.persisted,true);
  assert.equal(first.delivery.materials.length,2);
  assert.equal(first.delivery.materials[0].entryId!==null&&first.delivery.materials[0].entryId===first.delivery.materials[1].entryId,true,'all materials of one transaction share the single journaled envelope entry');
  await assert.rejects(owner.request('prompt',{text:'send once',requestId:'identity-1',job:{id:'dup-job'},images:[]}),error=>error.code==='PI_DUPLICATE_REQUEST'&&error.deliveryPhase==='native-record-confirmed');
  const second=await owner.request('prompt',{text:'send once',requestId:'identity-2',job:{id:'dup-job'},images:[]});
  assert.equal(second.nativeEntry.persisted,true);
  // Honest durability scope: the runtime duplicate guard is per-owner memory
  // ONLY — a cold owner process must NOT pretend durable knowledge (agentDir
  // is shared across role owners, so a runtime-side ledger file would race
  // and leak cross-session evidence). Durable cold-replay prevention is the
  // HOST job/collabAttempts ledger's contract (covered by the host cutover
  // suites), which reconciles against the native entry evidence above.
  await owner.stop();
  const cold=await (async()=>{const client=new OwnerClient(dirs);await client.start();t.after(()=>client.stop());return client;})();
  const coldStatus=await cold.request('status');
  assert.equal(coldStatus.contextDelivery.deliveryRecords.length,0,'a cold owner claims no remembered deliveries');
  await assert.rejects(fs.stat(path.join(dirs.agentDir,'nozeli-delivery-ledger.json')),{code:'ENOENT'},'the runtime writes no shared delivery ledger file');
  const sent=provider.requests.filter(request=>request.messages.some(message=>(textOf(message)??'')==='send once'));
  assert.equal(sent.length,2,'same text under a new explicit identity is delivered, never content-deduped');
  assert.equal(sent.length,provider.requests.length,'no hidden retry of any duplicate identity');
  t.diagnostic('Duplicate identity evidence: '+dirs.root);
});

test('an over-budget projection blocks the request before any provider call',{timeout:120000},async t=>{
  const provider=await serve(()=>({text:'must not be reached'}));
  t.after(()=>provider.close());
  const dirs=await prepare(provider.url);
  const session=new PiSession({...dirs,role:'worker',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[]});
  t.after(async()=>{try{await session.stop();}catch{}finally{await provider.close();}});
  await session.start();
  await assert.rejects(session.prompt('control facts',{job:{id:'ctx-job-budget',target:'worker',revision:1,type:'work'},projection:{text:'x'.repeat(4097)}}),{code:'PI_PROJECTION_OVER_BUDGET'});
  assert.equal(provider.requests.length,0,'a blocked projection must not reach the provider');
  assert.equal((await fs.readFile(session.sessionFile,'utf8')).includes('control facts'),false,'nothing was journaled for the blocked request');
  await session.stop();
  t.diagnostic('Projection budget evidence: '+dirs.root);
});

test('real native auto compaction bumps the context epoch, resets generation accounting and never resurrects old projections',{timeout:240000},async t=>{
  const provider=await serve(()=>({text:'summary of the earlier conversation for the native compaction entry '.repeat(40)+' '+ 'long assistant body '.repeat(600)}));
  t.after(()=>provider.close());
  const dirs=await prepare(provider.url);
  // REAL native auto-compaction thresholds: a small declared contextWindow and
  // private fixture compaction settings drive Pi's own shouldCompact path. No
  // mock claims compaction — the journal entry below is created by Pi.
  await fs.writeFile(path.join(dirs.agentDir,'models.json'),JSON.stringify({providers:{'local-fixture':{baseUrl:provider.url,api:'openai-completions',apiKey:'local-nonsecret',models:[{id:'scripted',name:'Scripted local fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:2048,maxTokens:1024}]}}}),{mode:0o600});
  await fs.writeFile(path.join(dirs.agentDir,'settings.json'),JSON.stringify({compaction:{enabled:true,reserveTokens:0,keepRecentTokens:200}}),{mode:0o600});
  const nativeEvents=[],epochs=[];
  const session=new PiSession({...dirs,role:'worker',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[],onNativeEvent:fact=>nativeEvents.push(fact.event)});
  t.after(async()=>{try{await session.stop();}catch{}finally{await provider.close();await fs.writeFile(path.join(dirs.root,'compaction-evidence.json'),JSON.stringify({requests:provider.requests.length,nativeEvents:nativeEvents.filter(event=>String(event.type).startsWith('nozeli')||String(event.type).startsWith('compaction'))},null,2));}});
  await session.start();
  const first=await session.prompt('first long turn',{job:{id:'ctx-job-compaction',target:'worker',revision:1,type:'work'},materials:[{id:'paper',version:'v3',text:'frozen material body for the compaction generation'}],projection:{text:'Work W rev 1 projection.',sources:[{id:'work',version:'1'}]}});
  assert.equal(first.delivery.phase,'native-record-confirmed');
  assert.equal(first.delivery.budget.generationHostTextBytes,first.delivery.materials[0].bytes,'material bytes are accounted to the compaction generation');
  epochs.push(first.contextEpoch);
  const generationBefore=provider.requests.length;
  const second=await session.prompt('second turn after growth',{job:{id:'ctx-job-compaction',target:'worker',revision:2,type:'work'},projection:{text:'Work W rev 2 projection after compaction.',sources:[{id:'work',version:'2'}]}});
  epochs.push(second.contextEpoch);
  assert.notEqual(second.contextEpoch,epochs[0],'a confirmed native compaction must change the context epoch');
  assert.ok(second.delivery.budget.generationHostTextBytes<first.delivery.budget.generationHostTextBytes,'generation accounting resets only on confirmed compaction');
  const journalLines=(await fs.readFile(session.sessionFile,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const compactionEntries=journalLines.filter(entry=>entry.type==='compaction');
  assert.ok(compactionEntries.length>=1,'Pi itself created a native compaction entry (auto path)');
  assert.equal(second.contextEpoch.endsWith(compactionEntries.at(-1).id),true,'the epoch names the newest native compaction entry');
  assert.ok(nativeEvents.some(event=>event.type==='nozeliCompaction'&&event.contextEpoch===second.contextEpoch),'compaction facts are observable with entry identity');
  const journalText=JSON.stringify(journalLines);
  assert.equal(journalText.includes(PROJECTION_OPEN),false,'no projection ever entered the journal');
  // Visibility vs delivery: the epoch change invalidates visibility claims,
  // never the recorded delivery of the first turn.
  const ownerStatus=await session.request('status');
  const record=ownerStatus.contextDelivery.deliveryRecords.find(row=>row.phase==='native-record-confirmed');
  assert.ok(record,'delivery records survive compaction');
  // The post-compaction run still carries its own projection; the native
  // compaction summarization calls themselves carry none.
  const postCompactionRequests=provider.requests.slice(generationBefore);
  assert.ok(postCompactionRequests.length>=2,'the auto compaction summary and the second run both reached the provider');
  const isTurnTwo=request=>request.messages.some(message=>(textOf(message)??'').includes('second turn after growth'));
  const projectionCarriers=postCompactionRequests.filter(request=>request.messages.some(message=>(textOf(message)??'').includes(PROJECTION_OPEN)));
  assert.ok(projectionCarriers.length>=1,'the next run re-projects its current state');
  for(const request of projectionCarriers){
    assert.equal(isTurnTwo(request),true,'only the admitted turn-two run may carry the projection');
  }
  for(const request of postCompactionRequests){
    if(isTurnTwo(request))continue;
    assert.equal(request.messages.some(message=>(textOf(message)??'').includes(PROJECTION_OPEN)),false,'a native compaction summary request carries no host projection');
  }
  // Further growth repeats the discipline: each confirmed native compaction
  // advances the epoch again (manual compact follows the same journal path;
  // at this window every new turn re-compacts automatically, and Pi refuses
  // compacting an already-compacted leaf).
  const third=await session.prompt('third turn',{job:{id:'ctx-job-compaction',target:'worker',revision:3,type:'work'},projection:{text:'Work W rev 3 projection.',sources:[{id:'work',version:'3'}]}});
  assert.notEqual(third.contextEpoch,second.contextEpoch);
  assert.equal((await fs.readFile(session.sessionFile,'utf8')).includes(PROJECTION_OPEN),false,'still no projection in the journal after further compactions');
  t.diagnostic('Auto compaction evidence: '+dirs.root);
});

test('a post-settlement journal flush failure fences the reserved identity as unknown, never replayable',{timeout:120000},async t=>{
  const provider=await serve(()=>({text:'ack'}));
  t.after(()=>provider.close());
  const dirs=await prepare(provider.url);
  const owner=new OwnerClient(dirs);
  t.after(()=>owner.stop());
  await owner.start();
  const status0=await owner.request('status');
  assert.ok(status0.sessionFile,'owner exposes the native session file');
  // Deterministic fs fault injection into the REAL final flush: while the
  // provider is answering, append a journal line without a native id. The
  // bridge's post-settlement flush must reject it (PI_JOURNAL_INVALID), and
  // the reserved delivery identity must end 'unknown' — fenced against any
  // same-requestId replay through this owner.
  const requestsBefore=provider.requests.length;
  const promptPromise=owner.request('prompt',{text:'flush will fail',requestId:'flush-fail-1',job:{id:'flush-job'},images:[]});
  const deadline=Date.now()+30000;
  while(provider.requests.length<=requestsBefore&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  await fs.appendFile(status0.sessionFile,'\n{"type":"injected-fs-fault"}\n');
  await assert.rejects(promptPromise,error=>error.code==='PI_JOURNAL_INVALID'||error.code==='PI_RUNTIME_ERROR');
  const status=await owner.request('status');
  const record=status.contextDelivery.deliveryRecords.find(row=>row.requestId==='flush-fail-1');
  assert.equal(record?.phase,'unknown','a failed final flush leaves the reserved identity unknown, not confirmed');
  await assert.rejects(owner.request('prompt',{text:'flush will fail',requestId:'flush-fail-1',job:{id:'flush-job'},images:[]}),error=>error.code==='PI_DUPLICATE_REQUEST'&&error.deliveryPhase==='unknown','the unknown identity cannot be replayed through the same owner');
  t.diagnostic('Flush failure fence evidence: '+dirs.root);
});

test('a provider failure after admission still confirms the journaled delivery with materials and reports it on the error',{timeout:180000},async t=>{
  const provider=await serve(()=>({status:400,error:{message:'scripted upstream rejection'}}));
  t.after(()=>provider.close());
  const dirs=await prepare(provider.url);
  const transport=[];
  const session=new PiSession({...dirs,role:'worker',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[],onTransportFact:fact=>transport.push({...fact})});
  t.after(async()=>{try{await session.stop();}catch{}finally{await provider.close();}});
  await session.start();
  const error=await session.prompt('deliver then fail',{job:{id:'ctx-job-fail',target:'worker',revision:1,type:'work'},materials:[{id:'paper',version:'v1',text:'frozen material delivered before the failure'}],projection:{text:'Work W rev 1.',sources:[{id:'work',version:'1'}]}}).then(()=>null,error=>error);
  assert.ok(error,'the provider turn must fail');
  assert.equal(error.code,'PI_PROVIDER_FAILED');
  const stages=transport.map(fact=>fact.status);
  assert.equal(stages.indexOf('native-record-confirmed')>-1&&stages.indexOf('native-record-confirmed')<stages.indexOf('unknown'),true,'record confirmation lands before the unknown outcome fact even on failure');
  const confirmed=transport.find(fact=>fact.status==='native-record-confirmed');
  assert.ok(confirmed.entryId,'the native user entry identity is reported');
  assert.equal(confirmed.materials[0].id,'paper');
  assert.equal(confirmed.materials[0].entryId!==null,true,'the journaled materials envelope identity is reported');
  assert.notEqual(confirmed.nativeEntryDigest,transport[0].contentDigest,'nativeEntryDigest is its own evidence field, distinct from the request digest');
  assert.equal(error.delivery?.phase,'native-record-confirmed','the failure carries the truthful last delivery fact');
  assert.equal(error.delivery?.materials[0].entryId!==null,true);
  // The failure never rewinds the journal: raw text and materials persisted.
  const journal=await fs.readFile(session.sessionFile,'utf8');
  assert.ok(journal.includes('"nozeli-materials"'),'materials were journaled before the provider failure');
  assert.ok(journal.includes('deliver then fail'),'the raw user entry was journaled');
  assert.equal(journal.includes(PROJECTION_OPEN),false,'no projection ever enters the journal, success or failure');
  assert.equal(session.contextEpoch,'compaction:0:root','the epoch identity is tracked without compaction');
  t.diagnostic('Failure delivery evidence: '+dirs.root);
});

test('real native manual compaction advances the epoch once without duplicating input or resurrecting projections',{timeout:180000},async t=>{
  const provider=await serve((request,index)=>({text:index===1?'large first history body '.repeat(3000):'manual compaction summary body'}));
  t.after(()=>provider.close());
  const dirs=await prepare(provider.url);
  // A real manual compaction needs compactable mass: a large prior assistant
  // body plus a small keepRecent window let Pi's own prepareCompaction cut.
  await fs.writeFile(path.join(dirs.agentDir,'settings.json'),JSON.stringify({compaction:{enabled:true,reserveTokens:0,keepRecentTokens:200}}),{mode:0o600});
  const session=new PiSession({...dirs,role:'worker',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[]});
  t.after(async()=>{try{await session.stop();}catch{}finally{await provider.close();}});
  await session.start();
  await session.prompt('history turn',{job:{id:'ctx-job-manual',target:'worker',revision:0,type:'work'}});
  const first=await session.prompt('manual compaction turn',{job:{id:'ctx-job-manual',target:'worker',revision:1,type:'work'},materials:[{id:'paper',version:'v2',text:'frozen manual-compaction material'}],projection:{text:'Work W rev 1.',sources:[{id:'work',version:'1'}]}});
  assert.equal(first.delivery.phase,'native-record-confirmed');
  assert.equal(first.delivery.materials[0].entryId!==null,true);
  const firstEntryId=first.nativeEntry.id,firstEpoch=first.contextEpoch;
  const requestsBefore=provider.requests.length;
  await session.compact();
  // The manual compaction is a REAL native entry: one summarization model
  // call, one journal compaction entry, no host projection inside it.
  assert.equal(provider.requests.length-requestsBefore,1,'manual compaction issues exactly one native summarization call');
  assert.equal(provider.requests.at(-1).messages.some(message=>(textOf(message)??'').includes(PROJECTION_OPEN)),false,'the manual compaction summary carries no host projection');
  const journalLines=(await fs.readFile(session.sessionFile,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const compaction=journalLines.filter(entry=>entry.type==='compaction');
  assert.equal(compaction.length,1,'Pi itself journaled the manual compaction entry');
  const second=await session.prompt('after manual compaction',{job:{id:'ctx-job-manual',target:'worker',revision:2,type:'work'},projection:{text:'Work W rev 2.',sources:[{id:'work',version:'2'}]}});
  assert.notEqual(second.contextEpoch,firstEpoch,'the epoch advances only on the confirmed manual compaction');
  assert.equal(second.contextEpoch.endsWith(compaction[0].id),true,'the epoch names the manual compaction entry');
  assert.equal(session.contextEpoch,second.contextEpoch,'the session tracks the confirmed epoch');
  // No input duplication and no receipt reuse: the original user entry and
  // materials envelope exist exactly once; the new delivery carries the NEW
  // epoch, and the pre-compaction entry keeps its own identity.
  const afterLines=(await fs.readFile(session.sessionFile,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.equal(afterLines.filter(entry=>entry.type==='message'&&entry.message?.role==='user'&&textOf(entry.message)==='manual compaction turn').length,1,'the original user entry is never re-sent');
  assert.equal(afterLines.filter(entry=>entry.customType==='nozeli-materials').length,1,'the materials envelope is journaled exactly once');
  assert.equal(second.nativeEntry.id!==firstEntryId,true,'the new turn claims its own native entry, not the old receipt');
  assert.equal(JSON.stringify(afterLines).includes(PROJECTION_OPEN),false,'no projection ever enters the native history');
  t.diagnostic('Manual compaction evidence: '+dirs.root);
});

test('real provider overflow triggers native compaction and retry without duplicating input or materials',{timeout:240000},async t=>{
  // Deterministic overflow shape straight from the SDK's own detection table
  // (pi-ai utils/overflow.js, OpenAI pattern). The SDK's overflow recovery
  // needs compactable history BEFORE the overflowing turn (prepareCompaction
  // cannot summarize a session's only turn), so a large first turn runs
  // first; then the scripted provider rejects the first request of the
  // second turn with that exact message. Pi must omit the failed attempt,
  // run its native overflow compaction (summary call) and retry the run
  // itself. Loopback only, no effects, no paid model.
  let phase=0;
  const provider=await serve(()=>{
    phase+=1;
    if(phase===2)return {status:400,error:{message:'Requested token count exceeds the model\'s maximum context length of 2048 tokens.'}};
    return {text:phase===1?'large first history body '.repeat(3000):phase===3?'native overflow summary body':'retry completed after native overflow compaction'};
  });
  t.after(()=>provider.close());
  const dirs=await prepare(provider.url);
  await fs.writeFile(path.join(dirs.agentDir,'settings.json'),JSON.stringify({compaction:{enabled:true,reserveTokens:0,keepRecentTokens:200}}),{mode:0o600});
  const session=new PiSession({...dirs,role:'worker',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[]});
  t.after(async()=>{try{await session.stop();}catch{}finally{await provider.close();}});
  await session.start();
  await session.prompt('history turn',{job:{id:'ctx-job-overflow',target:'worker',revision:0,type:'work'}});
  const answer=await session.prompt('overflow recovery turn',{job:{id:'ctx-job-overflow',target:'worker',revision:1,type:'work'},materials:[{id:'paper',version:'v1',text:'frozen overflow material'}],projection:{text:'Work W rev 1 newest task.',sources:[{id:'work',version:'1'}]}});
  assert.equal(answer.text,'retry completed after native overflow compaction');
  assert.equal(answer.delivery.phase,'native-record-confirmed');
  assert.ok(provider.requests.length>=4,'history, overflow rejection, native compaction summary and native retry all reached the provider');
  const [history,rejection,summary,retry]=provider.requests;
  assert.equal(rejection.messages.some(message=>(textOf(message)??'').includes('overflow recovery turn')),true);
  assert.equal(summary.messages.some(message=>(textOf(message)??'').includes(PROJECTION_OPEN)),false,'the overflow compaction summary carries no host projection');
  assert.equal(retry.messages.some(message=>(textOf(message)??'').includes(PROJECTION_OPEN)),true,'the retried run still carries the CURRENT task projection');
  assert.equal(retry.messages.some(message=>(textOf(message)??'')==='history turn'),false,'the summarized pre-compaction user input is not re-sent verbatim on retry (native retention of the cut-point entry itself is Pi\'s own choice)');
  assert.equal(retry.messages.filter(message=>(textOf(message)??'').includes('overflow recovery turn')).length,1,'the original user text is delivered exactly once on retry');
  assert.equal(retry.messages.filter(message=>(textOf(message)??'').includes('frozen overflow material')).length,1,'the materials envelope is not duplicated on retry');
  const journalLines=(await fs.readFile(session.sessionFile,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.ok(journalLines.some(entry=>entry.type==='compaction'),'the overflow recovery journaled a native compaction entry');
  assert.equal(journalLines.filter(entry=>entry.type==='message'&&entry.message?.role==='user'&&textOf(entry.message)==='overflow recovery turn').length,1,'no duplicate user entry from the retry');
  assert.equal(journalLines.filter(entry=>entry.customType==='nozeli-materials').length,1,'no duplicate materials envelope from the retry');
  assert.notEqual(answer.contextEpoch,'compaction:0:root','the epoch advanced through the overflow compaction');
  assert.equal(JSON.stringify(journalLines).includes(PROJECTION_OPEN),false,'no projection entered the native history during overflow recovery');
  t.diagnostic('Overflow recovery evidence: '+dirs.root);
});

test('a text-only native model refuses attached images before inference, while later explicit text input still works',{timeout:90000},async t=>{
 const provider=await serve(()=>({text:'TEXT_ONLY_RECEIPT'}));t.after(()=>provider.close());
 const dirs=await prepare(provider.url),modelsFile=path.join(dirs.agentDir,'models.json');
 const config=JSON.parse(await fs.readFile(modelsFile,'utf8'));config.providers['local-fixture'].models[0].input=['text'];await fs.writeFile(modelsFile,JSON.stringify(config));
 const session=new PiSession({...dirs,role:'frontdesk',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[]});
 t.after(()=>session.stop());await session.start();
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=';
 await assert.rejects(session.prompt('IMAGE_MUST_NOT_BE_SILENTLY_REMOVED',{images:[image],job:{id:'image-refused',target:'frontdesk',type:'front'}}),error=>error.code==='PI_IMAGE_UNSUPPORTED');
 assert.equal(provider.requests.filter(request=>!request.listing).length,0,'no text-only downgrade reaches inference');
 const answer=await session.prompt('EXPLICIT_TEXT_AFTER_REFUSAL',{job:{id:'text-after-image-refusal',target:'frontdesk',type:'front'}});
 assert.equal(answer.text,'TEXT_ONLY_RECEIPT');
 assert.equal(provider.requests.filter(request=>!request.listing).length,1);
 assert.equal(provider.requests[0].messages.some(message=>(textOf(message)||'').includes('IMAGE_MUST_NOT_BE_SILENTLY_REMOVED')),false,'rejected image input is not inserted or replayed as text');
});
