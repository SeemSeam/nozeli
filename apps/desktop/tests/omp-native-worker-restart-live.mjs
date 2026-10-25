// Real active Worker lifecycle, no model prompt/API request, using official system inheritance.
// node tests/omp-native-worker-restart-live.mjs EVIDENCE
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {openTestController} from './project-storage.fixture.mjs'
import {resolveSystemOmpSource} from '../src/agents/managed/omp-system-source.mjs';
import {OmpAuthBrokerHost,resolveSystemBrokerGrant} from '../src/agents/managed/omp-auth-broker.mjs';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';
const root=path.resolve(process.argv[2]);await fs.mkdir(root,{recursive:true});
const source=resolveSystemOmpSource({}),broker=new OmpAuthBrokerHost({command:'omp',source,sourceEnv:process.env});
const auth={acquire:async()=>{const remote=await resolveSystemBrokerGrant(source,process.env,{command:'omp'});return remote?broker.acquire(()=>remote):broker.acquire();}};
const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),ompSystemSource:source,ompAuthBroker:auth,projectHome:async()=>{}});
const facts=[];const wait=async(fn)=>{const until=Date.now()+30000;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Worker exit timeout');};
try{
 await c.setBinding('worker',{provider:'omp'});
 const work=await c.store.submit('Native Worker restart without model input','Lifecycle only');await c.store.activate(work.id);
 await c.setDraft(work.id,'unsent worker draft');
 for(const mode of ['normal','abnormal']){
  const s=await c.session(work.id);const oldPid=s.pid,stamp=await processStamp(oldPid),id=s.threadId;
  const attachment=s.terminalAttachment(c,work.id);
  if(mode==='normal')attachment.input('\x04');else process.kill(oldPid,'SIGKILL');
  await wait(()=>s.closed);await assert.rejects(async()=>attachment.input('stale'));
  const [a,b]=await Promise.all([c.restart(work.id),c.restart(work.id)]);assert.equal(a,b);assert.notEqual(a.pid,oldPid);assert.notEqual(await processStamp(oldPid),stamp);
  assert.equal(c.store.state.drafts[work.id],'unsent worker draft');assert.equal(c.store.state.jobs.length,0);
  const renewal=c.store.state.recoveryEvents.filter(e=>e.type==='omp-zero-activity-restarted'&&e.target===work.id).at(-1);
  assert(a.threadId===id||renewal,'new identity requires durable proven-zero-activity renewal');
  facts.push({mode,oldOwnerGone:true,sameThread:a.threadId===id,explicitZeroActivityRenewal:!!renewal,zeroModelJobs:true,draftPreserved:true});
 }
 await c.stop();const stopped=await broker.stop();assert.equal(stopped.exited,true);
 await fs.writeFile(path.join(root,'result.json'),JSON.stringify({pass:true,facts},null,2));console.log(JSON.stringify({pass:true,facts}));
}catch(error){await c.stop().catch(()=>{});await broker.stop().catch(()=>{});await fs.writeFile(path.join(root,'result.json'),JSON.stringify({pass:false,facts,error:String(error.stack||error)},null,2));throw error;}
