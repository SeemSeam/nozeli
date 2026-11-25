import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {Controller} from '../src/agents/managed/controller.mjs';
import {restoreExecutionIntents} from '../src/agents/managed/restart-recovery.mjs';

for(const target of ['frontdesk','orchestrator','worker'])for(const admitted of [false,true])test(`${target} explicit recovery hold survives repeated restore, admitted=${admitted}`,()=>{
 const job={id:'original',target,type:'manual',status:'running',text:'original input',recoveryRequiresExplicitInput:true,...(admitted?{promptStartedAt:1}:{})};
 const next={id:'next',target,type:'manual',status:'queued',text:'explicit later input',explicitInput:true};
 const state={jobs:[job,next],works:target==='worker'?[{id:target,status:'running'}]:[]};
 restoreExecutionIntents(state);restoreExecutionIntents(state);
 assert.equal(job.status,'interrupted');assert.equal(next.status,'interrupted');
 assert.equal(job.text,'original input');assert.equal(next.text,'explicit later input');
 assert.notEqual(job.restartRecovery?.kind,'native-continuation');
});

for(const source of ['job','work','bound-work','peer'])test(`Controller pump and direct run preserve ${source} recovery hold without opening session`,async()=>{
 const job={id:'next',target:source==='bound-work'?'orchestrator':'worker',type:'manual',status:'queued',text:'later input',explicitInput:true};
 const work={id:'worker',status:'paused',revision:1};
 const state={jobs:[job],works:[work],drafts:{},limit:1};
 if(source==='job')job.recoveryRequiresExplicitInput=true;
 if(source==='work'||source==='bound-work')work.recoveryRequiresExplicitInput=true;
 if(source==='bound-work')job.context={boundWorkId:work.id};
 if(source==='peer')state.jobs.push({id:'old',target:job.target,status:'interrupted',recoveryRequiresExplicitInput:true});
 const root=path.join(os.tmpdir(),'nozeli-pure-recovery-gate');
 const storage=Object.fromEntries(['putObject','readObject','getProject','putProject','listProject'].map(key=>[key,()=>{throw Error('held input attempted storage effect');}]));
 const store={state,root,storage,projectId:'synthetic-project',plan:path.join(root,'plan.json'),requireOnline:async()=>{},workSlotFacts:()=>({verificationRequired:false}),used:()=>1,
  find:id=>state.works.find(row=>row.id===id),deviationHeld:()=>false,mutate:async fn=>fn()};
 const c=new Controller(store);let prepared=0,opened=0;
 c.serviceSourcePrepare=async()=>{prepared++;};c.session=async()=>{opened++;throw Error('held input opened session');};
 await c.pump();await c.runJob(job);
 assert.equal(job.status,'queued');assert.equal(opened,0);assert.equal(prepared,0);assert.equal(c.current.size,0);
});

test('unheld accepted native continuation and never admitted queue remain eligible',()=>{
 const state={works:[{id:'worker',status:'running',threadId:'original-thread'}],jobs:[
  {id:'native',target:'worker',status:'running',promptStartedAt:1,revision:4},
  {id:'new',target:'orchestrator',status:'queued'}]};
 restoreExecutionIntents(state);
 assert.equal(state.jobs[0].restartRecovery.kind,'native-continuation');assert.equal(state.jobs[0].restartRecovery.threadId,'original-thread');
 assert.equal(state.jobs[1].restartRecovery.kind,'never-admitted');
});

test('a held queued Work cannot prepare service or activate before the in-transaction gate',async()=>{
 const state={works:[{id:'worker',status:'queued',recoveryRequiresExplicitInput:true}],jobs:[],drafts:{},limit:1};
 const root=path.join(os.tmpdir(),'nozeli-pure-recovery-gate');
 const storage=Object.fromEntries(['putObject','readObject','getProject','putProject','listProject'].map(key=>[key,()=>{}]));
 const store={state,root,storage,projectId:'synthetic-project',plan:path.join(root,'plan.json'),requireOnline:async()=>{},
  workSlotFacts:()=>({verificationRequired:false}),used:()=>0,find:()=>state.works[0],
  activateNext:()=>{throw Error('held Work activated');}};
 const c=new Controller(store);c.serviceSourcePrepare=()=>{throw Error('held Work prepared service');};
 await c.pump();assert.equal(state.works[0].status,'queued');
});
