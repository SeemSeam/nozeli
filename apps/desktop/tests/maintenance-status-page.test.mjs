import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {maintenanceFacts} from '../src/main/storage-maintenance.mjs';
import {collaborationProjection} from '../src/agents/managed/collaboration-status.mjs';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-maintenance-page-'));const directory=path.join(root,'project');await fs.mkdir(directory);const host=new DesktopHost(path.join(root,'profile')),registered=await host.registerDirectory(directory),manager=new ManagedProjects({userDataDir:path.join(root,'profile'),host,legacy:{projects:new Map()},openController:()=>{throw Error('status must never start Controller');}});t.after(async()=>{await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});return {host,manager,id:registered.id};}
const bug=(projectId,i,status='needs-version-fix')=>({id:'bug:'+i,projectId,fingerprint:'fingerprint:'+i,phase:'publication',jobId:'job:'+i,workId:'work:'+i,revision:1,status,error:{code:'HOST_INTERNAL_FAILURE',message:'private credential',frames:['private frame']},attempts:[]});
test('large cold ledger is worker-paged metadata with global counts and no starts',async t=>{const f=await fixture(t),bugs=Array.from({length:111},(_,i)=>({...bug(f.id,i,i===110?'repaired':i===109?'repairing':'needs-version-fix'),payload:'private credential '+ 'x'.repeat(100000)}));await f.host.storage.putLocal(f.id,'managed:maintenance',{schema:1,bugs});const original=f.host.storage.getLocal.bind(f.host.storage);f.host.storage.getLocal=(id,key)=>{assert.notEqual(key,'managed:maintenance');return original(id,key);};let cursor=null,count=0;do{const page=await f.manager.invoke('managed.maintenance.status',{projectId:f.id,limit:7,...(cursor?{cursor}:{})});assert.equal(page.summary.repaired,1);assert.equal(page.summary.inFlight,0);assert.equal(page.summary.blocked,110);assert.equal(page.total,111);assert(page.rows.length<=7);assert(Buffer.byteLength(JSON.stringify(page))<=65536);assert(!JSON.stringify(page).includes('private'));assert(page.rows.every(row=>row.capabilities.retry===false));count+=page.rows.length;cursor=page.nextCursor;}while(cursor);assert.equal(count,111);assert.equal(f.manager.controllers.size,0);assert.equal(f.manager.processBudget.used,0);await assert.rejects(f.manager.invoke('managed.maintenance.retry',{projectId:f.id,bugId:bugs[0].id,binding:{}}),{code:'MAINTENANCE_OWNER_UNAVAILABLE'});});
test('worker corruption is safe and cursor binds revision project and instance',()=>{const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE records(collection TEXT,id TEXT,value TEXT)');const insert=db.prepare('INSERT INTO records VALUES(?,?,?)');insert.run('ui','managed:maintenance','{broken');let page=maintenanceFacts(db,'identity',{projectId:'p',instanceId:'i'});assert.equal(page.summary.blocked,1);assert.equal(page.bugs.length,0);db.prepare('UPDATE records SET value=?').run(JSON.stringify({schema:1,bugs:[bug('p',0),null,'bad',bug('p',3)]}));page=maintenanceFacts(db,'identity',{projectId:'p',instanceId:'i',limit:1});assert(page.nextCursor);assert.throws(()=>maintenanceFacts(db,'identity',{projectId:'other',instanceId:'i',limit:1,cursor:page.nextCursor}),{code:'MAINTENANCE_CURSOR_STALE'});assert.throws(()=>maintenanceFacts(db,'identity',{projectId:'p',instanceId:'new',limit:1,cursor:page.nextCursor}),{code:'MAINTENANCE_CURSOR_STALE'});db.prepare('UPDATE records SET value=?').run(JSON.stringify({schema:1,bugs:[]}));assert.throws(()=>maintenanceFacts(db,'identity',{projectId:'p',instanceId:'i',limit:1,cursor:page.nextCursor}),{code:'MAINTENANCE_CURSOR_STALE'});for(const limit of [0,51,1.2,'1'])assert.throws(()=>maintenanceFacts(db,'identity',{projectId:'p',instanceId:'i',limit}),{code:'MAINTENANCE_PAGE_INVALID'});}finally{db.close();}});
test('live page delegates capability using exact facts and retry requires binding',async t=>{const f=await fixture(t),bugs=[bug(f.id,0),bug(f.id,1)],c={store:{state:{works:[],jobs:[]}},maintenanceActions:new Map(),maintenanceFlights:new Map(),hostOperations:new Map(),maintenanceCapability(value){assert.equal(value.error.code,'HOST_INTERNAL_FAILURE');return {retry:value.id===bugs[0].id,retryReason:value.id===bugs[0].id?null:'held'};},async maintenanceRetry(id,{binding}){assert.equal(id,bugs[0].id);assert.deepEqual(binding,{projectId:f.id,bugId:id,fingerprint:bugs[0].fingerprint,phase:'publication',jobId:'job:0',workId:'work:0',revision:1});throw Object.assign(Error('stale'),{code:'MAINTENANCE_BINDING_STALE'});}};f.manager.controllers.set(f.id,c);await f.host.storage.putLocal(f.id,'managed:maintenance',{schema:1,bugs});const page=await f.manager.invoke('managed.maintenance.status',{projectId:f.id,limit:1});assert.equal(page.rows[0].capabilities.retry,true);await assert.rejects(f.manager.invoke('managed.maintenance.retry',{projectId:f.id,bugId:bugs[0].id}),{code:'MAINTENANCE_BINDING_INVALID'});await assert.rejects(f.manager.invoke('managed.maintenance.retry',{projectId:f.id,bugId:bugs[0].id,binding:page.rows[0].binding}),{code:'MAINTENANCE_BINDING_STALE'});c.maintenanceFlights.set('outside-page',Promise.resolve());await assert.rejects(f.manager.invoke('managed.maintenance.status',{projectId:f.id,limit:1,cursor:page.nextCursor}),{code:'MAINTENANCE_CURSOR_STALE'});c.stopping=true;const stopped=await f.manager.invoke('managed.maintenance.status',{projectId:f.id});assert(stopped.rows.every(row=>!row.capabilities.retry));});
test('host transactions and repair flights keep project active without any native owner on every page',()=>{const c={store:{state:{works:[{id:'a',status:'queued'},{id:'z',status:'queued'}],jobs:[]}},hostOperations:new Map([['op',{target:'z',phase:'publication'}]]),maintenanceFlights:new Map([['bug:z',Promise.resolve()]])};let cursor=null;do{const page=collaborationProjection({projectId:'p',instanceId:'i',controller:c,limit:1,cursor});assert.equal(page.project.pendingTechnicalOperations,2);assert.equal(page.project.projectKeepsRunning,true);assert.equal(page.project.protectedCount,0);cursor=page.nextCursor;}while(cursor);});
test('valid envelope classifies invalid metadata as blocked on every page, never repaired or active',async t=>{
 const f=await fixture(t),invalid=[
  JSON.stringify(bug(f.id,15,'repaired')),
  JSON.stringify(bug(f.id,16,'repairing')),
  {...bug(f.id,17,'repaired'),attempts:[JSON.stringify({status:'verified'})]},
  {...bug(f.id,18,'repairing'),attempts:[JSON.stringify({status:'started'})]},
  {...bug(f.id,19,'queued'),attempts:[JSON.stringify({status:'unverified'})]},
  {...bug(f.id,20,'repaired'),revision:-Number.MAX_SAFE_INTEGER-1},
  {...bug(f.id,1,'repaired'),attempts:undefined},
  {...bug(f.id,2,'repairing'),attempts:{}},
  {...bug(f.id,3,'queued'),attempts:[null]},
  {...bug('other-project',4,'repaired')},
  {...bug(f.id,5,'repaired'),fingerprint:''},
  {...bug(f.id,6,'repairing'),id:'x'.repeat(257)},
  {...bug(f.id,7,'detected'),phase:null},
  {...bug(f.id,8,'repaired'),jobId:42},
  {...bug(f.id,9,'repairing'),workId:{}},
  {...bug(f.id,10,'queued'),revision:Number.MAX_SAFE_INTEGER+1},
  {...bug(f.id,11,'repaired'),attempts:[{status:'unknown'}]},
  {...bug(f.id,12,'repaired'),attempts:[{status:'verified'},{status:'verified'},{status:'verified'}]}
 ];
 const valid=[bug(f.id,0,'repaired'),bug(f.id,13,'repairing'),bug(f.id,14,'queued')];
 await f.host.storage.putLocal(f.id,'managed:maintenance',{schema:1,bugs:[valid[0],...invalid,...valid.slice(1)]});
 // A live owner may not override missing/corrupt metadata, even if it would offer an action.
 const c={store:{state:{works:[],jobs:[]}},maintenanceFlights:new Map([[valid[1].id,Promise.resolve()]]),maintenanceCapability(){return {retry:false,retryReason:'test-no-action'};}};f.manager.controllers.set(f.id,c);
 for(const record of invalid)c.maintenanceFlights.set(record.id,Promise.resolve());
 let cursor=null,index=0;do{
  const page=await f.manager.invoke('managed.maintenance.status',{projectId:f.id,limit:1,...(cursor?{cursor}:{})});
  assert.deepEqual(page.summary,{inFlight:1,queued:1,blocked:invalid.length,repaired:1});
  assert.equal(page.total,invalid.length+valid.length);assert.equal(page.rows.length,1);
  if(index>0&&index<=invalid.length){assert.equal(page.rows[0].status,'unknown');assert.equal(page.rows[0].capabilities.retry,false);}
  index++;cursor=page.nextCursor;
 }while(cursor);
 assert.equal(index,invalid.length+valid.length);
});
test('finalization receipts retain exact safe attempt facts without exposing attempt bodies',async t=>{
 const f=await fixture(t),record={...bug(f.id,0,'finalizing'),finalizationPending:true,lastOutcome:{verified:true,payload:'private receipt'},attempts:[{status:'unverified',payload:'private attempt'},{status:'verified',payload:'private attempt'}]};
 await f.host.storage.putLocal(f.id,'managed:maintenance',{schema:1,bugs:[record]});
 const facts=await f.host.storage.managedMaintenancePage(f.id);
 assert.equal(facts.bugs[0].metadataUnknown,false);assert.deepEqual(facts.bugs[0].attempts,[{status:'unverified'},{status:'verified'}]);assert.equal(facts.bugs[0].finalizationPending,true);assert.deepEqual(facts.bugs[0].lastOutcome,{verified:true});assert(!JSON.stringify(facts).includes('private'));
 const page=await f.manager.invoke('managed.maintenance.status',{projectId:f.id});assert.equal(page.rows[0].status,'finalizing');assert.deepEqual(page.summary,{inFlight:0,queued:0,blocked:1,repaired:0});assert.equal(page.rows[0].capabilities.retry,false);
});
test('debug continuation labels follow ledger facts and never claim active processing cold',async t=>{
 const f=await fixture(t),bugs=[
  {...bug(f.id,0),debug:{schema:1,state:'continued-with-known-fault',eventJobId:'event-0',attemptId:'a0'}},
  {...bug(f.id,1),debug:{schema:1,state:'running',eventJobId:'event-1',attemptId:'a1'}},
  {...bug(f.id,2),debug:{schema:1,state:'awaiting-fix',eventJobId:'event-2',attemptId:'a2'}},
  {...bug(f.id,3),debug:{schema:1,state:'continuing',eventJobId:'event-3',attemptId:'a3'}},
  {...bug(f.id,4),debug:{schema:1,state:'model-unavailable',eventJobId:'event-4',attemptId:'a4'}}
 ];
 await f.host.storage.putLocal(f.id,'managed:maintenance',{schema:1,bugs});
 const labelMap=page=>Object.fromEntries(page.rows.map(row=>[row.id,row.stateLabel]));
 // Cold read: only settled ledger facts; stopped/cold events never show active work.
 const cold=labelMap(await f.manager.invoke('managed.maintenance.status',{projectId:f.id}));
 assert.match(cold['bug:0'],/临时恢复/);assert.match(cold['bug:0'],/待修复/);
 assert.doesNotMatch(cold['bug:1'],/正在/,'cold controller cannot claim active debugging');
 assert.match(cold['bug:2'],/待修复/);
 assert.doesNotMatch(cold['bug:3'],/执行中|正在/);
 assert.match(cold['bug:4'],/模型不可用/);
 // A live owner with the exact registered event job queued/running is the only active claim.
 const c={store:{state:{works:[],jobs:[{id:'event-1',type:'maintenance',target:'orchestrator',status:'running'},{id:'event-3',type:'maintenance',target:'orchestrator',status:'queued'}]}},maintenanceActions:new Map(),maintenanceFlights:new Map(),hostOperations:new Map(),maintenanceCapability(){return {retry:false,retryReason:'test-no-action'};}};
 f.manager.controllers.set(f.id,c);
 const live=labelMap(await f.manager.invoke('managed.maintenance.status',{projectId:f.id}));
 assert.match(live['bug:1'],/正在debug/);
 assert.match(live['bug:3'],/临时恢复执行中/);
 // The stopped event on the live owner still reads as waiting, and no row ever claims a verified fix.
 const rows=(await f.manager.invoke('managed.maintenance.status',{projectId:f.id})).rows;
 assert.equal(rows.every(row=>!row.debug||row.debug.verifiedFix===false),true);
 for(const row of rows)if(['bug:0','bug:2','bug:4'].includes(row.id))assert.equal(row.debug.active,false,row.id);
});
