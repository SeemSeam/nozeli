import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const app=await fs.realpath(process.env.NOZELI_OPEN_MAIN_APP||'');assert(app.startsWith('/tmp/nozeli-open-main-'));
const {ExternalOpenIntake}=createRequire(import.meta.url)(path.join(app,'src/main/external-open-intake.cjs'));
const {DesktopHost}=await import(pathToFileURL(path.join(app,'src/main/host.mjs')));
const {ExternalOpenQueue}=await import(pathToFileURL(path.join(app,'src/main/external-open-queue.mjs')));
const out=await fs.mkdtemp(path.join(os.homedir(),'.local/state/nozeli-runtime-tests/open-main-intake-'));
console.log('Evidence retained: '+out);
const error=()=>Object.assign(Error('OWN_IO_FAILED'),{code:'EIO'});
async function make(name){const dir=path.join(out,name);await fs.mkdir(dir);const h=new DesktopHost(path.join(dir,'profile')),q=new ExternalOpenQueue({host:h});const reports=[];let notifications=0;const i=new ExternalOpenIntake({report:e=>reports.push(e.code),notify:()=>notifications++});return {dir,h,q,i,reports,notifications:()=>notifications};}

test('128 early requests have stable identities; overflow is rejected and gated until explicit acknowledgment',async()=>{
 const {dir,h,q,i,reports}=await make('bounded');const ids=[];for(let n=0;n<128;n++)ids.push(i.capture(path.join(dir,String(n)),'argv'));assert.equal(new Set(ids).size,128);assert.equal(i.capture(path.join(dir,'overflow'),'argv'),null);assert.equal(i.buffer.length,128);assert.equal(i.rejected,1);assert.deepEqual(reports,['OPEN_QUEUE_FULL']);await i.attach(q);assert.equal(i.buffer.length,0);const state=await i.query();assert.deepEqual(state.requests.map(r=>r.requestId),ids);assert(state.requests.slice(1).every(r=>r.requiresUserAction));await assert.rejects(i.settle(h),{code:'OPEN_ADMISSION_REJECTED'});i.acknowledgeRejected();await i.settle(h);assert(i.canClose());await fs.writeFile(path.join(dir,'snapshot.json'),JSON.stringify(state,null,2));
});
test('invalid early paths are never accepted as recoverable memory; safe close rejects unresolved refusal',async()=>{
 const {h,q,i}=await make('invalid');assert.equal(i.capture('relative','open-file'),null);assert.equal(i.capture('/bad\0path','open-file'),null);assert.equal(i.buffer.length,0);assert.equal(i.rejected,2);await i.attach(q);await assert.rejects(i.settle(h),{code:'OPEN_ADMISSION_REJECTED'});i.acknowledgeRejected();await i.settle(h);assert(i.canClose());
});
test('pre-rename admission error is retained, repeated query/new admission never retries silently',async()=>{
 const {dir,h,q,i,reports,notifications}=await make('before-rename');await i.attach(q);let faults=0;q.storage.fault=async stage=>{if(stage==='create'){faults++;throw error();}};const first=i.capture(path.join(dir,'one'),'open-file');await i.chain;assert.equal(faults,1);assert.equal(notifications(),0);assert.equal((await i.query()).status,'paused');const second=i.capture(path.join(dir,'two'),'second-instance');for(let n=0;n<3;n++)await i.query();assert.equal(faults,1);assert.equal(i.buffer.length,2);assert.equal(reports.length,1);await assert.rejects(i.settle(h),{code:'OPEN_PERSISTENCE_UNCONFIRMED'});q.storage.fault=async()=>{};const state=await i.query({retryPersistence:true});assert.deepEqual(state.requests.map(r=>r.requestId),[first,second]);assert.equal(notifications(),2);assert.equal(i.buffer.length,0);await i.settle(h);assert(i.canClose());await fs.writeFile(path.join(dir,'snapshot.json'),JSON.stringify(state,null,2));
});
test('post-rename admission error is reconciled to one request; neither query nor settle silently sync',async()=>{
 const {dir,h,q,i}=await make('after-rename');await i.attach(q);let faults=0;q.storage.fault=async stage=>{if(stage==='directory-sync'){faults++;throw error();}};const id=i.capture(path.join(dir,'one'),'argv');await i.chain;const raw=JSON.parse(await fs.readFile(q.storage.file,'utf8'));assert.equal(raw.requests[0].requestId,id);assert.equal((await i.query()).status,'paused');await assert.rejects(i.settle(h),{code:'OPEN_PERSISTENCE_UNCONFIRMED'});assert.equal(faults,1);q.storage.fault=async()=>{};await i.query({retryPersistence:true});const state=await i.query();assert.equal(state.requests.length,1);assert.equal(state.requests[0].requestId,id);assert.equal(i.buffer.length,0);
});
test('buffer during Host settle cannot produce a successful close ticket',async()=>{
 const {dir,h,q,i}=await make('settle-race');await i.attach(q);let release,entered=false;const real=h.settled.bind(h);h.settled=()=>{entered=true;return new Promise(r=>release=r);};const settling=i.settle(h);while(!entered)await new Promise(r=>setTimeout(r,1));q.storage.fault=async stage=>{if(stage==='create')throw error();};i.capture(path.join(dir,'during'),'open-file');release();await assert.rejects(settling,e=>['OPEN_UNDURABLE','OPEN_PERSISTENCE_UNCONFIRMED'].includes(e.code));assert(!i.canClose());h.settled=real;await i.chain;q.storage.fault=async()=>{};await i.query({retryPersistence:true});await i.settle(h);assert(i.canClose());
});
test('navigation revocation has immediate effect and async failure is caught and blocks close',async()=>{
 const {dir,h,q,i,reports}=await make('invalidate');await i.attach(q);await fs.writeFile(path.join(dir,'one'),'material');const id=i.capture(path.join(dir,'one'),'argv');await i.chain;const wc={isDestroyed:()=>false},win={isDestroyed:()=>false,webContents:wc},owner={window:win,webContents:wc,generation:4,bootId:q.bootId};const state=await q.openQueue();const c=await q.claimOpen(owner,{requestId:id,expectedRevision:state.revision,mode:'fresh'});q.storage.fault=async stage=>{if(stage==='create')throw error();};i.revoke(owner);await assert.rejects(q.readClaimedOpen(owner,{requestId:id,attemptId:c.attemptId,claimToken:c.claimToken,generation:4}),{code:'OPEN_PERSISTENCE_UNCONFIRMED'});assert.equal(reports.at(-1),'OPEN_PERSISTENCE_UNCONFIRMED');await assert.rejects(i.settle(h),{code:'OPEN_PERSISTENCE_UNCONFIRMED'});q.storage.fault=async()=>{};await i.query({retryPersistence:true});assert.equal((await i.query()).requests[0].state,'blocked');await assert.rejects(q.claimOpen(owner,{requestId:id,expectedRevision:(await q.openQueue()).revision,mode:'retry'}),{code:'STALE_OPEN'});
});
test('corrupt original freezes queue; new requests remain buffered and explicit retry cannot overwrite original',async()=>{
 const {dir,h,q,i}=await make('corrupt');await q.storage.directories();const bytes='{BROKEN';await fs.writeFile(q.storage.file,bytes);i.capture(path.join(dir,'request'),'argv');await i.attach(q);assert.equal((await i.query()).status,'frozen');assert.equal(i.buffer.length,1);await assert.rejects(i.settle(h),{code:'OPEN_QUEUE_CORRUPT'});await assert.rejects(i.query({retryPersistence:true}),{code:'OPEN_QUEUE_CORRUPT'});assert.equal(await fs.readFile(q.storage.file,'utf8'),bytes);
});
test('query explicitly validates all fields; new admission invalidates settled marker',async()=>{
 const {dir,h,q,i}=await make('query');await i.attach(q);for(const p of [{owner:{}},{retryPersistence:'true'},{absolutePath:dir},[],null])await assert.rejects(i.query(p),{code:'OPEN_INVALID'});await i.settle(h);assert(i.canClose());i.capture(path.join(dir,'new'),'argv');assert(!i.canClose());await i.chain;await i.settle(h);assert(i.canClose());
});
test('refusal confirmation acknowledges only the visible batch, preserves concurrent later refusal',async()=>{
 const {i}=await make('rejection-race');i.reject(error());const seen=i.rejected;i.reject(error());i.acknowledgeRejected(seen);assert.equal(i.rejected,1);await assert.rejects(async()=>i.acknowledgeRejected(-1),{code:'OPEN_INVALID'});
});
test('durable plus early capacity does not silently drop or retry the overflow buffer',async()=>{
 const {dir,h,i}=await make('shared-capacity'),q=new ExternalOpenQueue({host:h,limits:{requests:2}});await i.attach(q);i.capture(path.join(dir,'one'),'argv');i.capture(path.join(dir,'two'),'argv');await i.chain;const overflow=i.capture(path.join(dir,'three'),'argv');await i.chain;assert.equal(i.buffer[0].requestId,overflow);assert.equal((await i.query()).requests.length,2);assert.equal(i.error.code,'OPEN_QUEUE_FULL');await assert.rejects(i.settle(h),{code:'OPEN_QUEUE_FULL'});const wc={isDestroyed:()=>false},window={isDestroyed:()=>false,webContents:wc},owner={window,webContents:wc,bootId:q.bootId,generation:0};const state=await q.openQueue();await q.removeOpen(owner,{requestId:state.requests[0].requestId,expectedRevision:state.revision,confirmed:true});assert.equal(i.buffer.length,1);assert.equal((await i.query()).requests.length,1);assert.equal(i.buffer.length,1);await i.query({retryPersistence:true});assert.equal(i.buffer.length,0);assert.equal((await i.query()).requests.at(-1).requestId,overflow);await i.settle(h);assert(i.canClose());
});
