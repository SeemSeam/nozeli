import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {serve,prepare} from './pi-provider.fixture.mjs';
const journal=async file=>(await fs.readFile(file,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
for(const role of ['worker','orchestrator'])test('native journal continuation preserves settled effects and identities: '+role,{timeout:90000},async t=>{
 let waiting,release;const entered=new Promise(resolve=>waiting=resolve),hold=new Promise(resolve=>release=resolve);
 const provider=await serve(async(request,round)=>{
  if(round===1)return {tool:'durable_effect',id:'original-effect',args:{}};
  if(round===2){waiting();await hold;return {text:'Discard killed connection'};}
  if(round===3){assert.ok(request.messages.some(row=>row.tool_call_id==='original-effect'));assert.ok(request.messages.some(row=>row.role==='system'&&JSON.stringify(row.content).includes('Preserve original role rules')));return {tool:'inspect_after_restart',id:'recovery-inspect',args:{}};}
  assert.equal(round,4);return {text:'Original context completed'};
 });
 const dirs=await prepare(provider.url),facts=[],tools=['durable_effect','inspect_after_restart'].map(name=>({name,inputSchema:{type:'object',properties:{}}}));
 let effects=0;const calls=[];
 const spec={...dirs,role,instructions:'Preserve original role rules',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools,onNativeEntry:fact=>facts.push(fact),onTool:async call=>{calls.push(call);if(call.tool==='durable_effect'){effects++;await fs.appendFile(path.join(dirs.cwd,'effect.txt'),'ONE\n');}return {readOnly:true,text:'durably finished'};}};
 let session=new PiSession(spec);
 t.after(async()=>{release();try{await session.stop();}finally{await provider.close();await fs.rm(dirs.root,{recursive:true,force:true});}});
 await session.start();const threadId=session.threadId,job={id:'original-'+role,target:role,revision:1,type:'work'};
 const pending=session.prompt('Continue this original task after restart.',{job});pending.catch(()=>{});await entered;
 const before=await journal(session.sessionFile),user=before.find(row=>row.message?.role==='user');
 assert.ok(before.some(row=>row.message?.toolCallId==='original-effect'));
 await session.nativeDrain;
 assert.ok(facts.some(fact=>fact.entry?.id===user.id&&fact.requestId===session.current.requestId&&fact.jobId===job.id),'durable user identity is projected while provider turn is held');
 assert.ok(facts.some(fact=>fact.entry?.message?.toolCallId==='original-effect'&&fact.requestId===session.current.requestId&&fact.jobId===job.id),'durable tool result is projected before next provider response');
 const requestId=session.current.requestId;session.child.kill('SIGKILL');await assert.rejects(pending,{code:'PI_RUNTIME_EXITED'});await session.stop();release();
 session=new PiSession(spec);await session.preflightToolsDigest(session.toolsDigest);await session.start(threadId);
 const identity={sessionId:threadId,requestId,jobId:job.id,userEntryId:user.id};
 const inspection=await session.inspectRecovery(identity);assert.equal(inspection.state,'resumable');assert.equal(inspection.userEntryCount,1);assert.equal(inspection.settledToolCalls.length,1);
 await assert.rejects(session.recover({...identity,expectedLeafId:'stale-leaf',recoveryAttemptId:randomUUID(),job}),{code:'RESTART_RECONCILIATION_REQUIRED'});
 const recoveryAttemptId=randomUUID(),result=await session.recover({...identity,expectedLeafId:inspection.leafId,recoveryAttemptId,job});
 assert.equal(result.text,'Original context completed');assert.equal(result.threadId,threadId);assert.equal(result.recovery.nativeAdmitted,true);assert.deepEqual(result.settlement,{observed:true,persisted:true});
 assert.equal(effects,1);assert.equal(await fs.readFile(path.join(dirs.cwd,'effect.txt'),'utf8'),'ONE\n');assert.equal((await journal(session.sessionFile)).filter(row=>row.message?.role==='user').length,1);
 assert.equal(calls.at(-1).promptId,requestId);assert.equal(calls.at(-1).recoveryAttemptId,recoveryAttemptId);assert.ok(facts.some(fact=>fact.recoveryAttemptId===recoveryAttemptId&&fact.jobId===job.id));
 await assert.rejects(session.recover({...identity,expectedLeafId:inspection.leafId,recoveryAttemptId:randomUUID(),job}),{code:'RESTART_RECONCILIATION_REQUIRED'});
 const completed=await session.inspectRecovery(identity);assert.equal(completed.state,'completed');const count=provider.requests.length;
 const done=await session.recover({...identity,expectedLeafId:completed.leafId,recoveryAttemptId:randomUUID(),job});assert.equal(done.recovery.nativeAdmitted,false);assert.equal(done.text,result.text);assert.equal(provider.requests.length,count);
 assert.deepEqual(provider.errors,[]);
});

test('dangling native tool effect blocks recovery without dispatch',{timeout:90000},async t=>{
 let executing;const entered=new Promise(resolve=>executing=resolve);let release;const hold=new Promise(resolve=>release=resolve);
 const provider=await serve(()=>({tool:'unknown_effect',id:'unknown-call',args:{}}));const dirs=await prepare(provider.url);
 const spec={...dirs,role:'worker',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[{name:'unknown_effect'}],onTool:async()=>{executing();await hold;return {readOnly:true};}};
 let session=new PiSession(spec);t.after(async()=>{release();try{await session.stop();}finally{await provider.close();await fs.rm(dirs.root,{recursive:true,force:true});}});
 await session.start();const threadId=session.threadId,job={id:'unknown-job'};const pending=session.prompt('Unknown effect task',{job});pending.catch(()=>{});await entered;
 const requestId=session.current.requestId,file=session.sessionFile,user=(await journal(file)).find(row=>row.message?.role==='user');session.child.kill('SIGKILL');await assert.rejects(pending);release();await session.stop();
 session=new PiSession({...spec,onTool:()=>assert.fail('unknown effect must not execute')});await session.preflightToolsDigest(session.toolsDigest);await session.start(threadId);
 const identity={sessionId:threadId,requestId,jobId:job.id,userEntryId:user.id},inspection=await session.inspectRecovery(identity);
 assert.equal(inspection.state,'needs-reconciliation');assert.equal(inspection.reason,'pending-tool-effect-unknown');assert.equal(inspection.pendingToolCalls[0].callId,'unknown-call');
 await assert.rejects(session.recover({...identity,expectedLeafId:inspection.leafId,recoveryAttemptId:randomUUID(),job}),{code:'RESTART_RECONCILIATION_REQUIRED'});assert.equal(provider.requests.length,1);
});

for(const tail of ['user','aborted'])test('original '+tail+' tail continues and durable intent fences a crashed recovery',{timeout:90000},async t=>{
 let firstEntered,secondEntered,release;
 const first=new Promise(resolve=>firstEntered=resolve),second=new Promise(resolve=>secondEntered=resolve),hold=new Promise(resolve=>release=resolve);
 const provider=await serve(async(request,round)=>{if(round===1)firstEntered();else secondEntered();await hold;return {text:'Never replay uncertain dispatch'};});
 const dirs=await prepare(provider.url),spec={...dirs,role:'worker',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[]};let session=new PiSession(spec);
 t.after(async()=>{release();try{await session.stop();}finally{await provider.close();await fs.rm(dirs.root,{recursive:true,force:true});}});
 await session.start();const threadId=session.threadId,job={id:'fence-'+tail};const pending=session.prompt('Continue original context only',{job});pending.catch(()=>{});await first;
 const requestId=session.current.requestId,user=(await journal(session.sessionFile)).find(row=>row.message?.role==='user');
 if(tail==='aborted'){await session.interrupt();assert.equal((await pending).completion,'aborted');await session.stop();}
 else{session.child.kill('SIGKILL');await assert.rejects(pending);await session.stop();}
 session=new PiSession(spec);await session.preflightToolsDigest(session.toolsDigest);await session.start(threadId);
 const identity={sessionId:threadId,requestId,jobId:job.id,userEntryId:user.id},inspection=await session.inspectRecovery(identity);assert.equal(inspection.state,'resumable');
 const recoveryAttemptId=randomUUID();const recovering=session.recover({...identity,expectedLeafId:inspection.leafId,recoveryAttemptId,job,timeout:1000});recovering.catch(()=>{});await second;
 await new Promise(resolve=>setTimeout(resolve,1100));assert.equal([...session.pending.values()].find(row=>row.method==='recover').timer,null);
 session.child.kill('SIGKILL');await assert.rejects(recovering,{code:'PI_RUNTIME_EXITED'});await session.stop();
 session=new PiSession(spec);await session.preflightToolsDigest(session.toolsDigest);await session.start(threadId);
 const fenced=await session.inspectRecovery(identity);if(tail==='user')assert.equal(fenced.leafId,inspection.leafId);assert.equal(fenced.state,'needs-reconciliation');assert.equal(fenced.reason,'recovery-intent-already-dispatched');
 await assert.rejects(session.recover({...identity,expectedLeafId:inspection.leafId,recoveryAttemptId:randomUUID(),job}),{code:'RESTART_RECONCILIATION_REQUIRED'});
 assert.equal(provider.requests.length,2);assert.equal((await journal(session.sessionFile)).filter(row=>row.message?.role==='user').length,1);
});
