import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createExternalOpenPrototype,strictActionLane} from './external-open-renderer.prototype.mjs';

// All passes are independent prototype contracts, NOT app/Host/queue integration passes.
// Real temp source reads are limited fixture IO, not production Host identity validation.
const audit=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-external-renderer-contract-'));
console.log('PROTOTYPE_EVIDENCE='+audit);
const evidence=[];
const failure=(code,message=code)=>({ok:false,error:{code,message}});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),release:value=>resolve(value)};};
async function fixture(t,{kind='text',target={projectId:'project-b',relPath:'same.md'}}={}){
 const root=await fs.mkdtemp(path.join(audit,'case-')),file=path.join(root,'source'),bytes=Buffer.from('REAL_TEMP_SOURCE\n');await fs.writeFile(file,bytes);
 const events=[],effects={activations:0,mounts:0,acks:0,defers:0,reads:0},faults=new Map(),hooks=new Map();
 const ui={projectId:'project-a',relPath:'same.md',draft:'USER_UNSAVED_SOURCE',composer:'USER_UNSENT_COMPOSER',note:'USER_UNSENT_NOTE',healthy:true,surfaceEpoch:1,unsafe:null},receipts=[];
 let c;
 const step=async(name,fn)=>{events.push(name);await hooks.get(name)?.();if(faults.has(name)){const error=faults.get(name);if(error instanceof Error)throw error;return error;}return fn();};
 const ports={
  schedule:strictActionLane(),unsafe:()=>ui.unsafe,currentSurfaceEpoch:()=>ui.surfaceEpoch,
  persistNote:()=>step('persistNote',()=>({ok:true})),persistTexPosition:()=>step('persistTexPosition',()=>({ok:true})),flushSource:()=>step('flushSource',()=>({ok:true})),writeLeavingView:()=>step('writeLeavingView',()=>({ok:true})),
  activateNow:(address,{restoreCurrent,guard})=>step('activateNow',()=>{assert.equal(restoreCurrent,false);guard();if(ui.projectId!==address.projectId){effects.activations++;ui.projectId=address.projectId;ui.relPath=null;ui.surfaceEpoch++;}return {ok:true};}),
  readClaim:claim=>step('readClaim',async()=>{effects.reads++;let data;try{data=await fs.readFile(file);}catch(e){return {ok:true,value:{identity:target,source:{kind,diskPresent:false,draftText:ui.draft},readProof:claim}};}return {ok:true,value:{identity:target,source:{kind,diskPresent:true,digest:digest(data),text:data.toString()},readProof:claim}};}),
  displayNow:(loaded,{guard})=>step('displayNow',()=>{guard();const alreadyOpen=ui.projectId===target.projectId&&ui.relPath===target.relPath&&ui.healthy;if(!alreadyOpen){effects.mounts++;ui.relPath=target.relPath;ui.surfaceEpoch++;}return {ok:true,value:{...target,sourceDigest:loaded.source.digest,surfaceEpoch:ui.surfaceEpoch,healthy:ui.healthy,mode:alreadyOpen?'already-open':'mounted'}};}),
  writeTargetView:()=>step('writeTargetView',()=>({ok:true})),confirmVisible:()=>step('confirmVisible',()=>({ok:true})),
  acknowledgeDisplayed:(claim,readProof,display)=>step('acknowledgeDisplayed',()=>{effects.acks++;assert.equal(readProof,claim);receipts.push(display);return {confirmed:true};}),
  defer:(claim,result)=>step('defer',()=>{effects.defers++;return {retained:true};})
 };
 c=createExternalOpenPrototype(ports);const claim=Object.freeze({opaqueFixtureHandle:'not-an-IPC-payload'});
 t.after(async()=>{const result={name:t.name,root,kind,target,events,effects,ui,receipts,production:false};await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));evidence.push(result);await fs.writeFile(path.join(audit,'results.json'),JSON.stringify(evidence,null,2));});
 return {root,file,target,ui,events,effects,ports,c,claim,faults,hooks,attempt:()=>c.attempt(claim,target)};
}

test('explicit successful text handoff preserves user buffers and acknowledges only after verified surface/view',async t=>{
 const f=await fixture(t),before={draft:f.ui.draft,composer:f.ui.composer,note:f.ui.note},result=await f.attempt();
 assert.equal(result.outcome,'opened');assert.equal(result.receipt,'confirmed');assert.equal(result.display.projectId,f.target.projectId);assert.equal(f.effects.acks,1);assert.equal(f.effects.mounts,1);assert.equal(f.effects.defers,0);assert(f.events.indexOf('writeTargetView')<f.events.indexOf('acknowledgeDisplayed'));assert(f.events.indexOf('confirmVisible')<f.events.indexOf('acknowledgeDisplayed'));assert.deepEqual({draft:f.ui.draft,composer:f.ui.composer,note:f.ui.note},before);
});
for(const [port,code] of [['persistNote','NOTE_SAVE_FAILED'],['persistTexPosition','TEX_VIEW_FAILED'],['flushSource','COMPOSING'],['flushSource','CONFLICT'],['flushSource','DRAFT_WRITE_FAILED'],['flushSource','WORD_SAVE_FAILED'],['flushSource','SHEET_SAVE_FAILED'],['flushSource','PPT_DRAFT_FAILED'],['writeLeavingView','VIEW_UNREADABLE'],['writeLeavingView','STATE_WRITE_FAILED'],['activateNow','TARGET_STATE_READ_FAILED']])test('strict '+port+' '+code+' defers without displaying/acknowledging',async t=>{
 const f=await fixture(t);f.faults.set(port,failure(code));const result=await f.attempt();assert.equal(result.outcome,'deferred');assert.equal(result.error.code,code);assert.equal(result.requestRetained,true);assert.equal(f.effects.acks,0);assert.equal(f.effects.mounts,0);assert.equal(f.ui.draft,'USER_UNSAVED_SOURCE');assert.equal(f.ui.projectId,'project-a');
 f.c.notice();f.ui.unsafe=null;f.c.notice();assert.equal(f.effects.defers,1); // notification/composition ending is not a retry.
});
for(const code of ['COMPOSING','DOCUMENT_HOLD','VIEW_UNREADABLE'])test('pre-existing '+code+' blocks all save/surface mutations',async t=>{
 const f=await fixture(t);f.ui.unsafe={code,message:code};const result=await f.attempt();assert.equal(result.error.code,code);assert.deepEqual(f.events,['defer']);assert.equal(f.effects.activations,0);assert.equal(f.effects.acks,0);
});
for(const kind of ['pdf','word','sheet','ppt','image'])test(kind+' preview failure cannot be replaced by successful file-read or UI target assignment',async t=>{
 const f=await fixture(t,{kind});f.faults.set('displayNow',failure('MOUNT_FAILED',kind+' mount failed'));const result=await f.attempt();assert.equal(result.outcome,'deferred');assert.equal(result.stage,'mount');assert.equal(result.error.code,'MOUNT_FAILED');assert.equal(f.effects.reads,1);assert.equal(f.effects.acks,0);assert.equal(f.ui.projectId,'project-b');assert.equal(f.ui.draft,'USER_UNSAVED_SOURCE');
});
for(const kind of ['unsupported','legacy-word'])test(kind+' capability/import notice is not an opened surface',async t=>{
 const f=await fixture(t,{kind}),result=await f.attempt();assert.equal(result.error.code,'UNSUPPORTED_SURFACE');assert.equal(f.effects.mounts,0);assert.equal(f.effects.acks,0);
});
test('old undefined success result is explicitly unconfirmed instead of silently consuming request',async t=>{
 const f=await fixture(t);f.faults.set('displayNow',undefined);const result=await f.attempt();assert.equal(result.error.code,'OPEN_UNCONFIRMED');assert.equal(f.effects.acks,0);assert.equal(result.requestRetained,true);
});
test('target state write failure after mounting keeps actual UI, preserves source and defers rather than rollback/ack',async t=>{
 const f=await fixture(t);f.faults.set('writeTargetView',failure('STATE_WRITE_FAILED'));const result=await f.attempt();assert.equal(result.outcome,'deferred');assert.equal(f.effects.mounts,1);assert.equal(f.ui.projectId,'project-b');assert.equal(f.effects.acks,0);assert.equal((await fs.readFile(f.file)).toString(),'REAL_TEMP_SOURCE\n');
});
test('same file is read/version-checked and saved, but a healthy surface need not remount',async t=>{
 const f=await fixture(t,{target:{projectId:'project-a',relPath:'same.md'}}),result=await f.attempt();assert.equal(result.outcome,'opened');assert.equal(result.display.mode,'already-open');assert.equal(f.effects.activations,0);assert.equal(f.effects.mounts,0);assert.equal(f.effects.reads,1);assert(f.events.includes('writeTargetView'));assert.equal(f.effects.acks,1);
});
test('equal relative path in another project must activate/mount the distinct target',async t=>{
 const f=await fixture(t),result=await f.attempt();assert.equal(result.outcome,'opened');assert.equal(f.effects.activations,1);assert.equal(f.effects.mounts,1);assert.equal(result.display.projectId,'project-b');
});
test('missing source with retained draft never reports opened, even for same current path',async t=>{
 const f=await fixture(t,{target:{projectId:'project-a',relPath:'same.md'}});await fs.unlink(f.file);const result=await f.attempt();assert.equal(result.error.code,'SOURCE_UNAVAILABLE');assert.equal(f.ui.draft,'USER_UNSAVED_SOURCE');assert.equal(f.effects.mounts,0);assert.equal(f.effects.acks,0);
});
for(const defect of ['wrong-project','wrong-path','disposed','wrong-version','stale-surface'])test('confirmed surface rejects '+defect,async t=>{
 const f=await fixture(t);const real=f.ports.displayNow;f.ports.displayNow=async(...args)=>{const result=await real(...args);if(defect==='wrong-project')result.value.projectId='foreign';if(defect==='wrong-path')result.value.relPath='foreign.md';if(defect==='disposed')result.value.healthy=false;if(defect==='wrong-version')result.value.sourceDigest='old';if(defect==='stale-surface')result.value.surfaceEpoch--;return result;};const result=await f.attempt();assert.equal(result.error.code,'SURFACE_UNCONFIRMED');assert.equal(f.effects.acks,0);
});
for(const [stage,action] of [['flushSource','composer'],['writeLeavingView','note'],['activateNow','navigation'],['readClaim','source-editor'],['displayNow','office-input'],['writeTargetView','selection-navigation'],['confirmVisible','compositionstart']])test('new '+action+' while awaiting '+stage+' revokes handoff without losing new input',async t=>{
 const f=await fixture(t),entered=gate(),release=gate();f.hooks.set(stage,async()=>{entered.release();await release.promise;});const promise=f.attempt();await entered.promise;f.ui.composer='NEW_USER_INPUT';f.c.interaction();release.release();const result=await promise;assert.equal(result.error.code,'USER_INTERACTION');assert.equal(result.requestRetained,true);assert.equal(f.effects.acks,0);assert.equal(f.ui.composer,'NEW_USER_INPUT');if(['flushSource','writeLeavingView','activateNow'].includes(stage))assert.equal(f.effects.activations,0);
});
test('input after notification but before action lane starts invalidates captured epoch',async t=>{
 const f=await fixture(t),lane=gate();f.ports.schedule=fn=>lane.promise.then(fn);const promise=f.attempt();f.c.interaction();f.ui.note='NEW_NOTE_BEFORE_QUEUE';lane.release();const result=await promise;assert.equal(result.error.code,'USER_INTERACTION');assert.equal(f.effects.activations,0);assert.equal(f.ui.note,'NEW_NOTE_BEFORE_QUEUE');
});
test('source edits arriving during save stay visible even if save reports success',async t=>{
 const f=await fixture(t);f.hooks.set('flushSource',()=>{f.ui.draft='EDIT_DURING_SAVE';f.c.interaction();});const result=await f.attempt();assert.equal(result.error.code,'USER_INTERACTION');assert.equal(f.ui.draft,'EDIT_DURING_SAVE');assert.equal(f.effects.activations,0);assert.equal(f.effects.acks,0);
});
test('displayed then failed/lost ack reply retries only same receipt, not read/mount/save',async t=>{
 const f=await fixture(t);let committed=false;f.ports.acknowledgeDisplayed=async(claim,readProof,display)=>{f.events.push('acknowledgeDisplayed');f.effects.acks++;assert.equal(readProof,claim);if(!committed){committed=true;throw Error('reply lost AFTER synthetic receipt commit');}return {confirmed:true};};
 const first=await f.attempt();assert.equal(first.outcome,'opened');assert.equal(first.receipt,'pending');assert.equal(f.c.receiptPending,true);const mounts=f.effects.mounts,reads=f.effects.reads;assert.equal((await f.attempt()).error.code,'ACK_REQUIRED');f.c.interaction();f.ui.composer='NEW_INPUT_AFTER_DISPLAY';const final=await f.c.retryReceipt();assert.equal(final.outcome,'opened');assert.equal(final.receipt,'confirmed');assert.equal(f.effects.mounts,mounts);assert.equal(f.effects.reads,reads);assert.equal(f.effects.acks,2);assert.equal(f.ui.composer,'NEW_INPUT_AFTER_DISPLAY');assert.equal(f.c.receiptPending,false);
});
test('stale/unconfirmed ack retains receipt-only action without falsely claiming durable success',async t=>{
 const f=await fixture(t);f.ports.acknowledgeDisplayed=async()=>({confirmed:false,error:{code:'STALE_OWNER',message:'fixture owner is no longer valid'}});const result=await f.attempt();assert.equal(result.receipt,'pending');assert.equal(result.error.code,'STALE_OWNER');assert.equal(f.c.receiptPending,true);assert.equal(f.effects.mounts,1);assert.equal((await f.c.retryReceipt()).receipt,'pending');assert.equal(f.effects.mounts,1);
});
test('defer persistence failure never advertises durable retention',async t=>{
 const f=await fixture(t);f.faults.set('flushSource',failure('CONFLICT'));f.faults.set('defer',new Error('queue persistence failed'));const result=await f.attempt();assert.equal(result.outcome,'deferred');assert.equal(result.requestRetained,false);assert.equal(result.retentionError.code,'DEFER_UNCONFIRMED');assert.equal(f.effects.acks,0);
});
test('duplicate attempt shares in-flight action and does not open a second item automatically',async t=>{
 const f=await fixture(t),hold=gate(),started=gate();f.hooks.set('readClaim',async()=>{started.release();await hold.promise;});const a=f.attempt(),b=f.attempt();assert.equal(a,b);await started.promise;f.c.notice();hold.release();await a;assert.equal(f.effects.mounts,1);assert.equal(f.effects.acks,1);assert.equal(f.effects.reads,1);
});
test('recovered requests require explicit handling and no retry follows notice/composition end',async t=>{
 const f=await fixture(t),result=await f.c.attempt(f.claim,f.target,{explicit:false,recovered:true});assert.equal(result.error.code,'EXPLICIT_REQUIRED');assert.deepEqual(f.events,[]);f.c.notice();f.ui.unsafe=null;f.c.notice();assert.deepEqual(f.events,[]);assert.equal((await f.attempt()).outcome,'opened');
});
test('Now port scheduling again is caught as a nested-action error instead of a deadlock',async t=>{
 const f=await fixture(t);f.ports.activateNow=()=>f.ports.schedule(async()=>({ok:true}));const result=await f.attempt();assert.equal(result.error.code,'NESTED_ACTION');assert.equal(result.requestRetained,true);assert.equal(f.effects.acks,0);
});
test('input during queue-query await invalidates the original notice intent instead of resampling a safe epoch',async t=>{
 const f=await fixture(t),notice=f.c.notice();f.ui.composer='NEW_INPUT_DURING_QUEUE_QUERY';f.c.interaction();
 const result=await f.c.attempt(f.claim,f.target,{explicit:false,intentEpoch:notice.intentEpoch});assert.equal(result.error.code,'USER_INTERACTION');assert.equal(f.effects.activations,0);assert.equal(f.effects.mounts,0);assert.equal(f.ui.composer,'NEW_INPUT_DURING_QUEUE_QUERY');
});
test('read result belonging to another project cannot authorize mounting even after activation',async t=>{
 const f=await fixture(t),original=f.ports.readClaim;f.ports.readClaim=async claim=>{const result=await original(claim);result.value.identity={projectId:'foreign',relPath:f.target.relPath};return result;};
 const result=await f.attempt();assert.equal(result.error.code,'TARGET_MISMATCH');assert.equal(f.effects.mounts,0);assert.equal(f.effects.acks,0);
});
