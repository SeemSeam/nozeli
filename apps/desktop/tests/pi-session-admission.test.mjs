// Session admission-boundary regressions: the shared queue must be RESERVED
// SYNCHRONOUSLY (a snapshot `await previous` is not serialization), deferred
// configuration must never fail a settled turn, and clearing must supersede
// queued choices. Pure unit scope: no Pi owner process is spawned.
// Run: node --test tests/pi-session-admission.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {Writable} from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const spec=()=>({role:'worker',home:'/tmp/nozeli-admission-test',cwd:'/tmp',tools:[]});
const session=()=>new PiSession(spec());

test('admission slots are reserved synchronously and run one at a time',async()=>{
  const s=session();
  const first=s.beginAdmission();
  const second=s.beginAdmission();
  let order=[];
  const runFirst=async()=>{await new Promise(resolve=>setTimeout(resolve,20));order.push('first');first.end();};
  const runSecond=async()=>{await second.previous;order.push('second');second.end();};
  await Promise.all([runFirst(),runSecond()]);
  assert.deepEqual(order,['first','second'],'the second caller must not resume before the first slot ends');
  const third=s.beginAdmission();
  await third.previous; // tail settles after second.end()
  third.end();
});

test('a settled prompt is not converted into failure by a deferred model application',async()=>{
  const s=session();
  s.busy=false;s.phase='idle';s.threadId='t';s.pendingModel={selector:'p/m'};
  let applied=0;
  s.applyDefaultModel=async()=>{applied++;throw Object.assign(new Error('native model refused'),{code:'PI_NO_MODEL'});};
  const transport=[];
  s.spec.onTransportFact=async fact=>transport.push({...fact});
  s.request=async method=>{
    if(method==='prompt')return {text:'ok',completion:'provider-completed',metrics:null,effective:{model:'p/m',effort:'off'},nativeEntry:{id:'entry-7',contentDigest:'deadbeef',persisted:true},delivery:{phase:'native-record-confirmed',materials:[{id:'paper',version:'v3',sha256:'x',bytes:2,entryId:'entry-8'}]},contextEpoch:'compaction:0:root'};
    if(method==='flush')return {};
    throw Error('unexpected '+method);
  };
  s.current=null;s.busy=false;
  const result=await s.prompt('hello',{job:{id:'job-1'}});
  assert.equal(result.completion,'provider-completed');
  assert.deepEqual(transport.map(row=>row.status),['prepared','submitted','native-record-confirmed','settled'],'record confirmation lands between submission and settlement');
  // The transport binding tuple is immutable across every stage: the native
  // entry's raw-text digest rides nativeEntryDigest and can never rewrite the
  // request contentDigest the host bound at admission.
  for(const fact of transport){
    assert.equal(fact.requestId,transport[0].requestId);
    assert.equal(fact.jobId,'job-1');
    assert.equal(fact.attempt,1);
  }
  assert.equal(new Set(transport.map(fact=>fact.contentDigest)).size,1,'contentDigest never changes between stages');
  const confirmed=transport.find(fact=>fact.status==='native-record-confirmed');
  assert.equal(confirmed.entryId,'entry-7');
  assert.equal(confirmed.nativeEntryDigest,'deadbeef','native entry digest is an additional field, not the binding digest');
  assert.equal(result.nativeEntry.id,'entry-7');
  assert.equal(result.contextEpoch,'compaction:0:root');
  assert.equal(applied,1,'deferred application was attempted');
  assert.equal(s.modelError.code,'PI_NO_MODEL','failure stays visible on modelError instead of rejecting the turn');
});

test('busy sessions queue configuration; an explicit clear supersedes the queued choice',async()=>{
  const s=session();
  s.busy=true;s.model='p/current';
  const queued=await s.applyDefaultModel({selector:'p/next',effort:'low'});
  assert.equal(queued.state,'pending');
  assert.deepEqual(queued.desired,{selector:'p/next',effort:'low'});
  const cleared=await s.applyDefaultModel({clear:true});
  assert.deepEqual(cleared,{state:'unchanged',cleared:true});
  assert.equal(s.pendingModel,null,'queued choice is cancelled');
  assert.equal(s.desiredModel,null);
  const refresh=await s.refreshProviderSource('p');
  assert.equal(refresh.state,'pending');
  assert.deepEqual(refresh.desired,{selector:'p/current',refreshProvider:true},'refresh keeps the current selector and only adds the refresh flag');
});

test('rotation refresh never replaces a concurrently queued desired selector',async()=>{
  const s=session();
  s.busy=true;s.model='p/a';s.pendingModel={selector:'p/b',effort:'high'};
  const result=await s.refreshProviderSource('p');
  assert.equal(result.state,'pending');
  assert.deepEqual(result.desired,{selector:'p/b',effort:'high',refreshProvider:true},'pending selector B is preserved, only gaining the refresh');
});

test('an acknowledged clear invalidates a queued-but-not-submitted configuration change',async()=>{
  const s=session();
  s.phase='idle';s.threadId='admission-session';s.acceptActivity({ownerId:s.viewOwnerId,ownerGeneration:'admission-generation',sessionId:s.threadId,activityRevision:1,known:true,busy:false});
  s.model='p/a';
  const sent=[];
  let releaseA;
  s.request=async(method,params)=>{sent.push({method,params});return new Promise(resolve=>{releaseA=resolve;});};
  const a=s.applyDefaultModel({selector:'p/a',effort:'low'}); // A submits and holds its admission slot
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(sent.length,1);
  const b=s.applyDefaultModel({selector:'p/b'});               // B queues behind A, not yet submitted
  const cleared=await s.applyDefaultModel({clear:true});
  assert.equal(cleared.cleared,true);
  assert.equal(s.desiredModel,null);
  releaseA({model:{provider:'p',modelId:'a'},effort:'low',effective:{model:'p/a',effort:'low'}});
  const [ra,rb]=await Promise.all([a,b]);
  assert.equal(ra.state,'applied','an already submitted mutation is reported accurately, not claimed cancelled');
  assert.equal(rb.state,'cancelled','the superseded queued change must not execute after the clear');
  assert.equal(rb.superseded,true);
  assert.equal(sent.length,1,'only A reached the native runtime');
  assert.equal(s.model,'p/a');
});

test('a hold committed during transport preparation prevents the native write and later resumes the original input once',async()=>{
  const s=session();s.threadId='dispatch-boundary';s.phase='idle';
  const wire=[],facts=[];let hold=null,release,entered;
  const prepared=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
  s.spec.onTransportFact=async fact=>{facts.push(fact);if(fact.status==='submitted'&&!hold){entered();await blocked;}};
  s.child={stdin:{writable:true,write:line=>{
    const message=JSON.parse(line);wire.push(message);
    queueMicrotask(()=>s.receive(JSON.stringify({id:message.id,result:message.method==='prompt'?{text:'settled',completion:'provider-completed'}:{}})));
  }}};
  const job={id:'original-boundary-job'},pending=s.prompt('original frozen input',{job,admissionCheck:()=>hold});
  pending.catch(()=>{});
  await prepared;hold='WORK_CONTROL_HELD';release();
  await assert.rejects(pending,{code:'WORK_CONTROL_HELD'});
  assert.equal(wire.length,0,'no native request is written after the hold commits');
  assert.equal(facts.at(-1).status,'rejected','definitive non-dispatch remains durable, not unknown');
  hold=null;
  await s.prompt('original frozen input',{job,admissionCheck:()=>hold});
  const prompts=wire.filter(message=>message.method==='prompt');
  assert.equal(prompts.length,1);
  assert.equal(prompts[0].params.job.id,job.id);
  assert.equal(prompts[0].params.text,'original frozen input');
});

// Use the existing JSONL write/receive seam and node:test clock: admission
// acknowledges dispatch, while the same RPC remains pending for the turn.
function deadlineSession(t){
  t.mock.timers.enable({apis:['setTimeout']});
  const s=session(),wire=[],facts=[];
  s.threadId='deadline-session';s.phase='idle';
  s.acceptActivity({ownerId:s.viewOwnerId,ownerGeneration:'deadline-generation',sessionId:s.threadId,activityRevision:1,known:true,busy:false});
  s.spec.onTransportFact=fact=>facts.push(fact);
  let promptSent,flushSent;
  const submitted=new Promise(resolve=>{promptSent=resolve;}),flushing=new Promise(resolve=>{flushSent=resolve;});
  s.write=message=>{wire.push(message);if(message.method==='prompt')promptSent(message);if(message.method==='flush')flushSent(message);};
  const receive=message=>s.receive(JSON.stringify(message));
  const admit=(rpc,overrides={})=>receive({event:'admitted',requestId:rpc.params.requestId,ownerId:s.viewOwnerId,sessionId:s.threadId,ownerGeneration:'deadline-generation',...overrides});
  return {s,wire,facts,submitted,flushing,receive,admit};
}

test('native admission disarms only the prompt acknowledgement deadline; completion still drains and settles once',async t=>{
  const {s,wire,facts,submitted,flushing,receive,admit}=deadlineSession(t);
  const turn=s.prompt('slow admitted turn',{timeout:100,job:{id:'deadline-job'}});
  const rpc=await submitted;
  let releaseDrain;
  s.nativeDrain=new Promise(resolve=>{releaseDrain=resolve;});
  t.mock.timers.tick(99);admit(rpc);admit(rpc);
  t.mock.timers.tick(1000);
  assert.equal(s.pending.has(rpc.id),true,'admission does not resolve or delete the turn RPC');
  assert.equal(s.pending.get(rpc.id).timer,null);
  assert.equal(facts.some(fact=>fact.status==='admitted'),false,'timer clears synchronously even while the native transport drain is blocked');
  releaseDrain();
  receive({id:rpc.id,result:{text:'finished after admission deadline'}});
  const flush=await flushing;
  receive({id:flush.id,result:{}});
  assert.equal((await turn).text,'finished after admission deadline');
  assert.deepEqual(facts.map(fact=>fact.status),['prepared','submitted','admitted','settled']);
  assert.equal(s.pending.size,0);assert.equal(s.busy,false);
  assert.equal(wire.filter(message=>message.method==='prompt').length,1,'never replay');
});

for(const mismatch of ['unadmitted','requestId','ownerId','sessionId','ownerGeneration','missing-owner','missing-session','missing-generation','current','pending-request','pending-method','stale-activity']){
  test('prompt deadline remains armed for '+mismatch,async t=>{
    const {s,wire,facts,submitted,receive,admit}=deadlineSession(t);
    const turn=s.prompt('unconfirmed turn',{timeout:100,job:{id:'unconfirmed-job'}});
    const failure=assert.rejects(turn,{code:'PI_REQUEST_TIMEOUT'}),rpc=await submitted;
    if(mismatch==='current')s.pending.get(rpc.id).current={...s.current};
    else if(mismatch==='pending-request')s.pending.get(rpc.id).requestId='other-request';
    else if(mismatch==='pending-method')s.pending.get(rpc.id).method='flush';
    if(mismatch!=='unadmitted'){
      const overrides=mismatch.startsWith('missing-')?{[{ 'missing-owner':'ownerId','missing-session':'sessionId','missing-generation':'ownerGeneration'}[mismatch]]:undefined}:
        ['requestId','ownerId','sessionId','ownerGeneration'].includes(mismatch)?{[mismatch]:'wrong-identity'}:{};
      if(mismatch==='stale-activity')Object.assign(overrides,{activity:{...s.nativeActivity},activityRevision:1});
      admit(rpc,overrides);
    }
    t.mock.timers.tick(100);await failure;
    assert.equal(s.pending.size,0);assert.equal(s.activityUnknown,true);
    const observed=['current','pending-request','pending-method'].includes(mismatch);
    assert.deepEqual(facts.map(fact=>fact.status),['prepared','submitted',...(observed?['admitted']:[]),'unknown']);
    admit(rpc);receive({id:rpc.id,result:{text:'late result'}});
    assert.equal(wire.length,1,'late frames cannot replay or settle an expired input');
  });
}

test('admission leaves concurrent cancel and subsequent flush deadlines intact',async t=>{
  const {s,submitted,flushing,receive,admit}=deadlineSession(t);
  const turn=s.prompt('admitted',{timeout:100,job:{id:'deadline-job'}}),rpc=await submitted;
  const cancel=s.request('cancel',{requestId:rpc.params.requestId},100);
  const cancelled=assert.rejects(cancel,{code:'PI_REQUEST_TIMEOUT'});
  admit(rpc);t.mock.timers.tick(100);await cancelled;
  assert.equal(s.pending.has(rpc.id),true);
  const failure=assert.rejects(turn,{code:'PI_REQUEST_TIMEOUT'});
  receive({id:rpc.id,result:{text:'provider finished'}});await flushing;
  admit(rpc);t.mock.timers.tick(29999);
  assert.equal(s.pending.size,1,'flush retains its independent 30-second deadline');
  t.mock.timers.tick(1);await failure;
  assert.equal(s.pending.size,0);
});

test('post-admission provider failure and cancellation still settle their original RPCs',async t=>{
  const {s,submitted,receive,admit,wire}=deadlineSession(t);
  const turn=s.prompt('cancel admitted input',{timeout:100,job:{id:'cancel-job'}}),rpc=await submitted;
  admit(rpc);t.mock.timers.tick(1000);
  const interrupted=s.interrupt(),cancel=wire.at(-1);
  assert.equal(cancel.method,'cancel');
  receive({id:cancel.id,result:{stopped:true}});await interrupted;
  assert.equal(s.current.cancelled,true);
  const failure=assert.rejects(turn,error=>error.code==='PI_PROVIDER_FAILED'&&error.deliveryPhase==='native-record-confirmed');
  receive({id:rpc.id,error:{code:'PI_PROVIDER_FAILED',message:'scripted failure',deliveryPhase:'native-record-confirmed'}});
  await failure;assert.equal(s.pending.size,0);assert.equal(s.busy,false);
});

test('response before admission preserves late evidence without disarming another RPC',async t=>{
  const {s,facts,submitted,flushing,receive,admit}=deadlineSession(t);
  const turn=s.prompt('fast provider',{timeout:100,job:{id:'fast-job'}}),rpc=await submitted;
  receive({id:rpc.id,result:{text:'already finished'}});
  const flush=await flushing;
  admit(rpc);
  assert.notEqual(s.pending.get(flush.id).timer,null);
  receive({id:flush.id,result:{}});await turn;
  assert.deepEqual(facts.map(fact=>fact.status),['prepared','submitted','admitted','settled']);
  t.mock.timers.tick(30000);assert.equal(s.pending.size,0);
});

test('exact admission after timeout during blocked drain records evidence without reviving the expired prompt',async t=>{
  const {s,wire,facts,submitted,receive,admit}=deadlineSession(t);
  const turn=s.prompt('late native admission',{timeout:100,job:{id:'late-admission-job'}}),rpc=await submitted;
  let releaseDrain,enteredCatch;
  s.nativeDrain=new Promise(resolve=>{releaseDrain=resolve;});
  const catching=new Promise(resolve=>{enteredCatch=resolve;});
  s.on('activity',()=>{if(s.activityUnknown)enteredCatch();});
  const failure=assert.rejects(turn,{code:'PI_REQUEST_TIMEOUT'});
  t.mock.timers.tick(100);await catching;
  assert.equal(s.pending.has(rpc.id),false);
  assert.equal(s.current.requestId,rpc.params.requestId,'the expired turn still owns its blocked drain');
  for(const overrides of [{ownerId:'wrong-owner'},{sessionId:'wrong-session'},{ownerGeneration:'wrong-generation'},{requestId:'wrong-request'}])admit(rpc,overrides);
  assert.notEqual(s.current.admissionObserved,true,'mismatches do not record evidence');
  admit(rpc);admit(rpc);
  assert.equal(s.current.admissionObserved,true);
  assert.equal(s.pending.size,0,'late admission must not recreate the expired RPC');
  receive({id:rpc.id,result:{text:'ignored late result'}});
  releaseDrain();await failure;await s.nativeDrain;
  assert.equal(facts.filter(fact=>fact.status==='admitted').length,1);
  assert.equal(facts.filter(fact=>fact.status==='unknown').length,1);
  assert.equal(facts.some(fact=>fact.status==='settled'),false);
  assert.equal(s.activityUnknown,true);assert.equal(s.pending.size,0);
  assert.equal(wire.length,1,'no flush or automatic replay after timeout');
  for(const fact of facts){
    assert.equal(fact.requestId,rpc.params.requestId);assert.equal(fact.jobId,'late-admission-job');
    assert.equal(fact.contentDigest,facts[0].contentDigest);assert.equal(fact.epoch,facts[0].epoch);
  }
});

test('recovery host-tool gate preserves projection failure without executing effects',async()=>{
 const s=session(),frames=[];
 s.current={requestId:'original-request',job:{id:'original-job'},recoveryAttemptId:'recovery-attempt',cancelled:false};
 s.spec.onTool=()=>assert.fail('projection failure must fence tool effects');
 s.write=frame=>frames.push(frame);
 s.enqueueNative(()=>{throw Object.assign(Error('Native entry does not match a durable attempt'),{code:'TIMELINE_OWNER'});});
 await s.handleTool({id:'tool-rpc',requestId:'original-request',tool:'nozeli_dispatch',arguments:{}});
 assert.deepEqual(frames,[{id:'tool-rpc',error:{code:'TIMELINE_OWNER',message:'Native entry does not match a durable attempt'}}]);
 assert.equal(s.nativeError.code,'TIMELINE_OWNER');
});

test('asynchronous owner stdin EPIPE rejects all pending RPCs without replay or uncaught error',async()=>{
 const s=session();let rejectWrite;
 const input=new Writable({write(chunk,encoding,callback){rejectWrite=callback;}});
 s.child={stdin:input};s.bindOwnerInput(s.child);
 const prompt=s.request('recover',{requestId:'original-request'}),stop=s.request('stop');
 const failedPrompt=assert.rejects(prompt,error=>error.code==='PI_RUNTIME_PIPE_FAILED'&&error.cause.code==='EPIPE');
 const failedStop=assert.rejects(stop,{code:'PI_RUNTIME_PIPE_FAILED'});
 rejectWrite(Object.assign(Error('write EPIPE'),{code:'EPIPE'}));
 await Promise.all([failedPrompt,failedStop]);
 assert.equal(s.pending.size,0);assert.equal(s.activityUnknown,true);
 await assert.rejects(s.request('recover'),{code:'PI_RUNTIME_PIPE_FAILED'});
 s.current={requestId:'original-request',job:{id:'job'}};
 s.spec.onTool=()=>assert.fail('broken transport cannot admit new tool effects');
 await s.handleTool({id:'tool-after-pipe-error',requestId:'original-request',tool:'effect'});
});

test('owner errors preserve only bounded host origin and original tool code',async()=>{
 for(const facts of [
  {failureOrigin:'host',hostToolCode:'HOST_INTERNAL_FAILURE'},
  {failureOrigin:'private document',hostToolCode:'private document'},
 ]){
  const s=session();let rejected;
  s.pending.set('failed-prompt',{timer:setTimeout(()=>{},10000),reject:error=>{rejected=error;}});
  s.receive(JSON.stringify({id:'failed-prompt',error:{code:'PI_HOST_TOOL_FAILED',message:'failed tool',...facts}}));
  assert.equal(rejected.code,'PI_HOST_TOOL_FAILED');
  assert.equal(rejected.failureOrigin,facts.failureOrigin==='host'?'host':undefined);
  assert.equal(rejected.hostToolCode,facts.failureOrigin==='host'?'HOST_INTERNAL_FAILURE':undefined);
 }
});

test('host tool error response carries origin without copying arbitrary exception properties',async()=>{
 const s=session(),frames=[];
 s.current={requestId:'request',job:{id:'job'},cancelled:false};s.write=frame=>frames.push(frame);
 s.spec.onTool=async()=>{throw Object.assign(Error('failed host operation'),{code:'HOST_INTERNAL_FAILURE',failureOrigin:'host',privateBody:'not a wire field'});};
 await s.handleTool({id:'tool',requestId:'request',tool:'host-tool'});
 assert.equal(frames.length,1);assert.equal(frames[0].error.failureOrigin,'host');assert.equal(frames[0].error.code,'HOST_INTERNAL_FAILURE');assert.equal(frames[0].error.privateBody,undefined);
});

// Tool-schema admission on a resumed native conversation: a changed digest
// is diagnostic evidence (the native owner re-verifies identity during
// start), the pinned durable metadata is kept untouched until a verified
// start republishes it, and only genuine persisted-metadata or lineage
// errors refuse. Pure unit scope: no Pi owner process is spawned.
test('a changed historical tools digest never refuses and keeps the pinned metadata untouched',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'pi-session-admission-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const metadata={schema:1,threadId:'original-thread',sessionFile:path.join(home,'sessions','original.jsonl'),toolsDigest:'old-schema-digest'};
 await fs.mkdir(path.dirname(metadata.sessionFile),{recursive:true});
 await fs.writeFile(path.join(home,'nozeli-session-tools.json'),JSON.stringify(metadata));
 const s=new PiSession({role:'orchestrator',home,cwd:'/tmp',tools:[{name:'nozeli_new_debug'}]});
 await s.preflightToolsDigest('old-schema-digest');
 assert.equal(s.sessionFile,metadata.sessionFile,'pinned native file stays loaded for the resume');
 assert.equal(s.pinnedThreadId,'original-thread');
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'nozeli-session-tools.json'),'utf8')),metadata,'preflight never writes or upgrades the pinned record; only a verified native start republishes it');
});

test('uninterpretable persisted tools metadata still refuses the resume',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'pi-session-admission-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const metadataFile=path.join(home,'nozeli-session-tools.json');
 for(const [label,bytes] of [['future schema',JSON.stringify({schema:2,threadId:'t',sessionFile:'/t.jsonl',toolsDigest:'d'})],['missing thread identity',JSON.stringify({schema:1,sessionFile:'/t.jsonl',toolsDigest:'d'})],['non-string pinned file',JSON.stringify({schema:1,threadId:'t',sessionFile:7,toolsDigest:'d'})],['scalar record','123']]){
  await fs.writeFile(metadataFile,bytes);
  const s=new PiSession({role:'orchestrator',home,cwd:'/tmp',tools:[]});
  await assert.rejects(s.preflightToolsDigest('d'),{code:'PI_TOOLS_METADATA_SCHEMA'},label);
  assert.equal(s.sessionFile,undefined,label+' never pins metadata');
 }
 await fs.writeFile(metadataFile,'{not json');
 await assert.rejects(new PiSession({role:'orchestrator',home,cwd:'/tmp',tools:[]}).preflightToolsDigest('d'),SyntaxError,'malformed metadata is a genuine persisted error, not a silent fresh session');
});

test('post-start lineage assertion refuses only an unknown digest',()=>{
 const s=session();s.toolsDigest='new-schema';s.pinnedToolsDigest='old-schema';
 s.assertToolsDigest('new-schema');
 s.assertToolsDigest('old-schema');   // historical schema of the resumed conversation: an ordinary upgrade, not a handoff
 assert.throws(()=>s.assertToolsDigest('unknown-schema'),{code:'PI_TOOLS_DIGEST_MISMATCH'});
});

test('lineage assertion stays pure and leaves the pending tool protocol untouched',()=>{
 const s=session();s.toolsDigest='new-schema';s.pinnedToolsDigest='old-schema';
 s.sessionFile='/pinned/original.jsonl';s.pinnedThreadId='original-thread';
 const waiter={resolve(){},reject(){},timer:null,method:'prompt',requestId:'request'};
 s.pending.set('live-rpc',waiter);
 s.assertToolsDigest('old-schema');s.assertToolsDigest('new-schema');
 assert.equal(s.pending.size,1);assert.equal(s.pending.get('live-rpc'),waiter,'no pending RPC is settled or dropped by the assertion');
 assert.equal(s.sessionFile,'/pinned/original.jsonl');assert.equal(s.pinnedThreadId,'original-thread');assert.equal(s.pinnedToolsDigest,'old-schema','pinned state is never repinned in memory');
 assert.throws(()=>s.assertToolsDigest('third-schema'),{code:'PI_TOOLS_DIGEST_MISMATCH'});
 assert.equal(s.pending.size,1,'even the refusal leaves the pending protocol untouched');
});

test('start refuses a resume whose pinned metadata names another thread before any side effect',async()=>{
 const s=session();s.pinnedThreadId='pinned-thread';s.sessionFile='/pinned/original.jsonl';
 await assert.rejects(s.start('different-thread'),{code:'PI_SESSION_IDENTITY'});
 assert.equal(s.child,undefined,'no owner process is spawned for a mismatched pinned identity');
 assert.equal(s.phase,'new','no lifecycle state advances past the refusal');
});
