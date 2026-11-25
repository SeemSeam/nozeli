import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createExperimentalProcessJob as create,waitExperimentalJobEmpty as wait} from '../src/platform/windows/experimental-process-job.mjs';
import {startExperimentalProcessSupervisor as start} from '../src/platform/windows/experimental-process-supervisor.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:120000};
const helper=path.resolve(import.meta.dirname,'../native/windows-process/build/Release/nozeli_process_fixture.exe');
// Actual userland short-lived descendants: the fixture spawns each child with
// CreateProcessW, waits for its exit and closes the HANDLE immediately.
const churn=48;
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli member churn 中文 ')),jobs=[],pins=[];
  t.after(async()=>{
    for(const pin of pins.reverse())try{if(pin.shutdown)pin.shutdown();}catch(error){if(!['SUPERVISOR_IDENTITY_UNVERIFIED','SUPERVISOR_CLOSED'].includes(error.code))throw error;}finally{pin.close();}
    for(const job of jobs){
      try{if(!job.snapshot().jobEmptyObserved)job.terminate();}catch(error){if(error.code!=='PROCESS_JOB_CLOSED')throw error;}
      try{await wait(job);}catch(error){if(error.code!=='PROCESS_JOB_CLOSED')throw error;}
      try{job.close();}catch(error){if(!['PROCESS_JOB_ACTIVE','PROCESS_JOB_CLOSED'].includes(error.code))throw error;}
    }
    await fs.rm(root,{recursive:true,force:true});
  });
  const env=[`SystemRoot=${process.env.SystemRoot}`,`TEMP=${root}`,`TMP=${root}`];
  return {root,env,jobs,pins};
}
async function settled(want,snapshot,label){
  const deadline=performance.now()+20000;
  for(;;){
    const facts=snapshot();
    if(want(facts))return facts;
    if(performance.now()>deadline)assert.fail(`${label}: ${JSON.stringify(facts)}`);
    await delay(10);
  }
}
const churnJob=(f,record)=>{const job=create({command:helper,args:['churn',record,String(churn)],cwd:f.root,env:f.env});f.jobs.push(job);return job;};

test('notification capture observes every short-lived churn descendant of a plain lease',native,async t=>{
  const f=await fixture(t),record=path.join(f.root,'churn.json');
  const job=churnJob(f,record);
  job.resume();
  const facts=await settled(g=>g.jobEmptyObserved&&g.allProcessIncarnationsObserved,()=>job.snapshot(),'plain lease capture');
  const proof=JSON.parse(await fs.readFile(record,'utf8'));
  // Independent sources: the fixture recorded the exact descendants it created;
  // kernel accounting and the collector ledger must both account for them.
  // Incidental OS descendants (e.g. conhost) may also join the Job, so the
  // exact total is not pinned: every recorded descendant must be captured and
  // the kernel/ledger totals must agree and cover at least the fixture set.
  assert.equal(proof.spawned,churn);
  assert.equal(proof.children.length,churn);
  assert.equal(facts.totalProcesses,facts.observedMembers+1);
  assert.ok(facts.totalProcesses>=churn+1,JSON.stringify(facts));
  assert.ok(facts.observedMembers>=churn,JSON.stringify(facts));
  const stamps=new Set(facts.members.map(member=>member.stamp));
  assert.equal(stamps.size,facts.observedMembers);
  for(const pid of proof.children)
    assert.ok(facts.members.some(member=>member.pid===pid),`descendant ${pid} missing from ledger`);
  // Stopping authority is independent of completeness certification: the
  // terminate path validates Job policy only and never queries the ledger.
  const stopping=create({command:helper,args:['hold',path.join(f.root,'hold.json')],cwd:f.root,env:f.env});
  f.jobs.push(stopping);
  stopping.resume();
  assert.equal(stopping.terminate().terminationRequested,true);
  await wait(stopping);
});

test('helper collector keeps lease and supervisor counters aligned through churn',native,async t=>{
  const f=await fixture(t),record=path.join(f.root,'churn.json');
  const job=churnJob(f,record);
  const pin=start(job);f.pins.push(pin);
  job.resume();
  await settled(g=>g.jobEmptyObserved,()=>pin.snapshot(),'helper drained job');
  const helperFacts=await settled(g=>g.allProcessIncarnationsObserved,()=>pin.snapshot(),'helper capture');
  const lease=await settled(g=>g.allProcessIncarnationsObserved,()=>job.snapshot(),'lease alignment');
  const proof=JSON.parse(await fs.readFile(record,'utf8'));
  assert.equal(proof.spawned,churn);
  assert.equal(lease.totalProcesses,helperFacts.totalProcesses);
  assert.equal(lease.observedMembers,helperFacts.observedMembers);
  assert.equal(lease.unexitedObservedMembers,helperFacts.unexitedObservedMembers);
  assert.equal(lease.allProcessIncarnationsObserved,true);
  assert.ok(lease.totalProcesses>=churn+1,JSON.stringify({lease,helperFacts}));
  for(const pid of proof.children){
    assert.ok(lease.members.some(member=>member.pid===pid),`descendant ${pid} missing from lease ledger`);
    assert.ok(helperFacts.members.some(member=>member.pid===pid),`descendant ${pid} missing from helper ledger`);
  }
  pin.shutdown();pin.close();f.pins.splice(f.pins.indexOf(pin),1);
  await wait(job);job.close();
});
