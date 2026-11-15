import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {AdminMaintenance,validateRepair,repairVersion} from '../src/agents/admin-maintenance.mjs';
import {AdminAgent,ADMIN_TOOLS} from '../src/agents/admin-agent.mjs';
import {ProviderSettings} from '../src/agents/managed/provider-settings.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-admin-maintenance-')),profile=path.join(root,'profile');
 const host=new DesktopHost(profile),ids=[];
 for(const name of ['A','B']){const dir=path.join(root,name);await fs.mkdir(dir);ids.push((await host.registerDirectory(dir)).id);}
 const managed=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()}});
 const c=await managed.loadLocal(ids[0]);c.kick=()=>{};
 let now=1000;const maintenance=new AdminMaintenance({host,managed,now:()=>now,ttl:100});
 const options={userDataDir:profile,host,maintenance,providerSettings:new ProviderSettings({source:{agentDir:path.join(profile,'pi')},worker:null})};
 const agent=new AdminAgent(options);await agent.start();
 const receiptFile=path.join(root,'repair-receipt');let effects=0;
 async function fault({phase='publication',error=Error('PRIVATE token=SECRET https://user:password@example.test'),jobId,workId,revision}={}){
  const bug=await c.maintenance.record({phase,error,jobId,workId,revision});
  c.maintenanceActions.set(bug.id,async()=>{effects++;await fs.appendFile(receiptFile,bug.id+'\n');return true;});return bug;
 }
 t.after(async()=>{await agent.stop();await managed.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 const diagnostics=(id=ids[0],extra={})=>agent.tool('nozeli_admin_diagnostics',{projectId:id,cursor:null,limit:null,...extra});
 const prepare=async bug=>{const page=await diagnostics();const row=page.rows.find(row=>row.id===bug.id);assert(row?.source,JSON.stringify(page));return (await agent.tool('nozeli_admin_prepare_repair',{source:row.source})).proposal;};
 return {root,profile,host,managed,c,maintenance,options,agent,ids,receiptFile,fault,diagnostics,prepare,effects:()=>effects,expire:()=>now+=101};
}
const confirm=(agent,p)=>agent.invoke('confirm',{id:p.id,expectedVersion:p.expectedVersion});

test('real ManagedProjects and Controller repair writes a receipt only after trusted confirm, exact project stays bound and repeat is inert',async t=>{
 const f=await fixture(t),bug=await f.fault(),proposal=await f.prepare(bug);
 assert.equal(proposal.kind,'repair');assert.equal(proposal.project.id,f.ids[0]);assert.equal(proposal.action.mode,'repair');assert.equal(f.effects(),0);
 assert(!JSON.stringify(proposal).includes('fingerprint'));assert(!Object.hasOwn(proposal,'binding'));
 await f.agent.invoke('openProject',{projectId:f.ids[1]});
 const result=await confirm(f.agent,proposal);assert.equal(result.receipt.status,'repaired');assert.equal(result.receipt.repaired,true);assert(!Object.hasOwn(result.receipt,'saved'));
 assert.equal(result.receipt.projectId,f.ids[0]);assert.equal(await fs.readFile(f.receiptFile,'utf8'),bug.id+'\n');
 assert.equal((await f.diagnostics()).rows.find(r=>r.id===bug.id).status,'repaired');
 await confirm(f.agent,proposal);assert.equal(f.effects(),1);
});

test('strict nullable diagnostics, opaque TTL, safe pagination and cross-project cursor reject without loading an owner',async t=>{
 const f=await fixture(t);for(let i=0;i<27;i++)await f.fault({phase:'publication',revision:i});
 const page=await f.diagnostics(f.ids[0],{limit:7});assert.equal(page.rows.length,7);assert(page.nextCursor);assert(Buffer.byteLength(JSON.stringify(page))<=16000);
 assert(!/SECRET|password|PRIVATE|fingerprint|jobId|workId/.test(JSON.stringify(page)));
 assert.equal(f.managed.controllers.has(f.ids[1]),false);
 const crossed=await f.diagnostics(f.ids[1],{cursor:page.nextCursor,limit:7});assert.equal(crossed.supported,false);assert.equal(f.managed.controllers.has(f.ids[1]),false);
 const next=await f.diagnostics(f.ids[0],{cursor:page.nextCursor,limit:7});assert.equal(next.rows.length,7);assert(!next.rows.some(row=>page.rows.some(first=>first.id===row.id)));
 f.expire();await assert.rejects(f.agent.tool('nozeli_admin_prepare_repair',{source:page.rows[0].source}),{code:'ADMIN_MAINTENANCE_STALE'});
 for(const args of [{projectId:f.ids[0]}, {projectId:f.ids[0],cursor:null,limit:25},{projectId:f.ids[0],cursor:null,limit:null,root:'/tmp'}])await assert.rejects(f.agent.tool('nozeli_admin_diagnostics',args),{code:'ADMIN_INVALID_PAYLOAD'});
 assert.equal(f.effects(),0);
});

test('prepare rechecks live evidence and no source advertises cold, busy, held, human or unknown effects',async t=>{
 const f=await fixture(t),bug=await f.fault(),page=await f.diagnostics(),source=page.rows[0].source;
 f.c.store.lifecycleHold={action:'test'};
 await assert.rejects(f.agent.tool('nozeli_admin_prepare_repair',{source}),{code:'ADMIN_MAINTENANCE_STALE'});
 assert.equal((await f.diagnostics()).rows[0].source,null);delete f.c.store.lifecycleHold;
 f.c.maintenanceFlights.set(bug.id,Promise.resolve());assert.equal((await f.diagnostics()).rows[0].source,null);f.c.maintenanceFlights.delete(bug.id);
 const human=await f.fault({phase:'closure',error:Object.assign(Error('PRIVATE'),{code:'PERMISSION_REQUIRED'})});assert.equal((await f.diagnostics()).rows.find(r=>r.id===human.id).source,null);
 await f.c.maintenance.attempt(bug.id);assert.equal((await f.diagnostics()).rows.find(r=>r.id===bug.id).source,null);
 f.managed.controllers.delete(f.ids[0]);try{const cold=await f.diagnostics();assert(cold.rows.every(r=>r.source===null));}finally{f.managed.controllers.set(f.ids[0],f.c);}
 assert.equal(f.effects(),0);
});

test('execute refuses stale instance, root, binding, state, revision, mode and lost capability',async t=>{
 const f=await fixture(t),bug=await f.fault();
 for(const change of [p=>p.projectInstanceId='other',p=>{p.projectRoot+='/other';p.project.root=p.projectRoot;},p=>p.binding.fingerprint='changed',p=>p.faultStatus=p.fault.status='queued',p=>p.expectedRevision='other',p=>p.retryMode=p.action.mode='finalize']){
  // Each case starts from current host evidence, not a fabricated repair implementation.
  const dto=await f.prepare(bug),frozen=structuredClone(f.agent.state.proposals.find(p=>p.id===dto.id));change(frozen);frozen.expectedVersion=repairVersion(frozen);validateRepair(frozen);
  assert.equal((await f.maintenance.execute(frozen)).status,'blocked');
 }
 const proposal=await f.prepare(bug);f.c.maintenanceActions.delete(bug.id);assert.equal((await confirm(f.agent,proposal)).receipt.status,'blocked');assert.equal(f.effects(),0);
});

test('dismiss, admin busy and cold executing journal do not replay repair',async t=>{
 const f=await fixture(t),bug=await f.fault(),dismissed=await f.prepare(bug);await f.agent.invoke('dismiss',{id:dismissed.id});const result=await confirm(f.agent,dismissed);assert.equal(result.receipt.status,'dismissed');assert(!Object.hasOwn(result.receipt,'saved'));
 const proposal=await f.prepare(bug);f.agent.flight=Promise.resolve();await assert.rejects(confirm(f.agent,proposal),{code:'ADMIN_BUSY'});f.agent.flight=null;
 const state=structuredClone(f.agent.state);state.proposals.find(p=>p.id===proposal.id).status='executing';await fs.writeFile(f.agent.file,JSON.stringify(state));
 const recovered=new AdminAgent(f.options);try{const status=await recovered.invoke('status',{});assert.equal(status.pendingChanges.find(p=>p.id===proposal.id).status,'unknown');assert.equal((await confirm(recovered,proposal)).receipt.repaired,null);assert.equal(f.effects(),0);}finally{await recovered.stop();}
});

test('false host verification is not repaired and unexpected invoke failures expose no raw error',async t=>{
 const f=await fixture(t),bug=await f.fault();f.c.maintenanceActions.set(bug.id,async()=>false);
 const p=await f.prepare(bug),result=await confirm(f.agent,p);assert.equal(result.receipt.status,'not-repaired');assert.equal(result.receipt.repaired,false);
 const second=await f.prepare(bug),original=f.managed.invoke;f.managed.invoke=async()=>{throw Error('PRIVATE token=SECRET');};try{const unknown=await confirm(f.agent,second);assert.equal(unknown.receipt.status,'unknown');assert(!JSON.stringify(unknown.receipt).includes('SECRET'));await confirm(f.agent,second);assert.equal(f.effects(),0);}finally{f.managed.invoke=original;}
});

test('manual pause, human decision and cold original job remain closed through real Controller capabilities',async t=>{
 const f=await fixture(t),work=await f.c.store.submit('synthetic request','synthetic brief');
 const bug=await f.fault({workId:work.id,revision:work.revision});
 await f.c.store.mutate(()=>{f.c.store.state.works.find(w=>w.id===work.id).manualControl={pause:{id:'test-pause'}};});
 let row=(await f.diagnostics()).rows.find(r=>r.id===bug.id);assert.equal(row.source,null);assert.equal(row.capabilities.retryReason,'manual-control-held');
 await f.c.store.mutate(()=>{const w=f.c.store.state.works.find(w=>w.id===work.id);delete w.manualControl;w.readOnly=true;});
 row=(await f.diagnostics()).rows.find(r=>r.id===bug.id);assert.equal(row.source,null);assert.equal(row.capabilities.retryReason,'human-decision-required');
 await f.c.store.mutate(()=>{const w=f.c.store.state.works.find(w=>w.id===work.id);w.readOnly=false;w.status='running';});
 const accepted=await f.c.enqueue(work.id,'initial','synthetic input'),job=f.c.store.state.jobs.find(j=>j.id===accepted.jobId);
 const cold=await f.fault({phase:'input-preparation',jobId:job.id,workId:work.id,revision:job.revision});f.c.coldJobs??=new Set();f.c.coldJobs.add(job.id);
 row=(await f.diagnostics()).rows.find(r=>r.id===cold.id);assert.equal(row.source,null);assert.equal(row.capabilities.retryReason,'original-effect-unknown');assert.equal(f.effects(),0);
});

test('oversized single-page summary explicitly fails bounded and missing adapter preserves registry/configuration',async t=>{
 const f=await fixture(t),host={requireRegisteredProject:async id=>({...await f.host.requireRegisteredProject(id),name:'x'.repeat(20000)}),recent:()=>f.host.recent()};
 const adapter=new AdminMaintenance({host,managed:f.managed});const result=await adapter.read({projectId:f.ids[0]});assert.equal(result.reason,'maintenance-page-too-large');assert(Buffer.byteLength(JSON.stringify(result))<16000);
 const unavailable=new AdminAgent({...f.options,userDataDir:path.join(f.root,'unavailable'),maintenance:undefined});try{
  assert.equal((await unavailable.tool('nozeli_admin_diagnostics',{projectId:f.ids[0],cursor:null,limit:null})).supported,false);
  assert.equal((await unavailable.tool('nozeli_admin_registry',{})).projects.length,2);
  assert.equal((await unavailable.tool('nozeli_admin_configuration',{})).readOnly,true);
  await assert.rejects(unavailable.tool('nozeli_admin_prepare_repair',{source:'invented'}),{code:'ADMIN_MAINTENANCE_UNAVAILABLE'});
 }finally{await unavailable.stop();}
});
