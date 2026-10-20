import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-quota-recovery-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const manager=new ManagedProjects({userDataDir:root,host:{requireProject:async id=>({id,name:'Recovery project'})},legacy:{projects:new Map()}});
 const runtime=path.join(manager.root,'project','runtime'),home=path.join(runtime,'agents','legacy');
 await fs.mkdir(home,{recursive:true});
 return {root,manager,runtime,home,save:providers=>fs.writeFile(path.join(runtime,'state.json'),JSON.stringify({providers}))};
}
async function ownedProcess(t,home){
 const child=spawn(process.execPath,['-e','process.stdout.write("ready\\n");setInterval(()=>{},1000);','codex','app-server'],{detached:true,env:{...process.env,CODEX_HOME:home},stdio:['ignore','pipe','ignore']});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
 await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);});
 return {child,exited,record:{pid:child.pid,stamp:await processStamp(child.pid),home}};
}
test('dead legacy and native-terminal records release their cold-inventory reservations',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t),p=await ownedProcess(t,f.home);p.child.kill('SIGTERM');await p.exited;
 await f.save({frontdesk:p.record,'terminal:frontdesk':{...p.record,kind:'native-terminal'}});
 const s=await f.manager.resourceStatus();assert.equal(s.globalUsed,0);assert.equal(s.agents.length,0);
});
test('verified live legacy orphan is reaped and its capacity is released',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t),p=await ownedProcess(t,f.home);await f.save({frontdesk:p.record});
 const s=await f.manager.resourceStatus();await p.exited;assert.equal(await processStamp(p.child.pid),null);assert.equal(s.globalUsed,0);
});
test('previous-boot records cannot reserve capacity or signal a reused current PID',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t),current=await processStamp(process.pid),[boot,tick]=current.split(':'),previous=(boot[0]==='0'?'1':'0')+boot.slice(1);
 await f.save({frontdesk:{pid:process.pid,stamp:previous+':'+tick,home:f.home},orchestrator:{pid:process.pid,stamp:previous+':'+tick,home:f.home,kind:'omp-tui'}});
 assert.equal((await f.manager.resourceStatus()).globalUsed,0);assert.equal(await processStamp(process.pid),current);
});
test('same-boot PID reuse and invalid ownership remain blocked without signalling the unrelated process',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t),current=await processStamp(process.pid),[boot,tick]=current.split(':');
 await f.save({frontdesk:{pid:process.pid,stamp:boot+':'+(BigInt(tick)+1n),home:f.home},orchestrator:{pid:process.pid,stamp:'corrupt-stamp',home:f.home,kind:'omp-tui'}});
 const s=await f.manager.resourceStatus();assert.equal(s.globalUsed,2);assert(s.agents.every(a=>a.state==='unconfirmed'));assert.equal(await processStamp(process.pid),current);
});
