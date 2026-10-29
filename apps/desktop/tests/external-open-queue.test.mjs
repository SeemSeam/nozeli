import {processInfo} from '../src/platform/process-query.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fork} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {ExternalOpenQueue} from '../src/main/external-open-queue.mjs';
import {externalTarget,parseExternalArguments} from '../src/main/external-open.mjs';

const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-open-queue-'));
console.log('OPEN_QUEUE_EVIDENCE '+out);
const hashes=v=>createHash('sha256').update(v).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const payload=c=>{const {requestId,attemptId,claimToken,generation}=c;return {requestId,attemptId,claimToken,generation};};
const owner=(generation=0,wc={})=>({window:{webContents:wc},webContents:wc,generation});
const code=value=>e=>e.code===value;
let sequence=0;
async function fixture(options={}){
 const dir=path.join(out,String(++sequence)),project=path.join(dir,'project'),profile=path.join(dir,'profile');await fs.mkdir(project,{recursive:true});
 const file=path.join(project,'A.txt');await fs.writeFile(file,'Source original\n');
 const host=new DesktopHost(profile);await host.pick(project);
 const f={dir,project,profile,file,host,owner:owner(),failStage:null,faultLog:[],limits:options.limits};
 f.make=()=>new ExternalOpenQueue({host,limits:f.limits,fault:async stage=>{
  f.faultLog.push(stage);if(f.failStage===stage){f.failStage=null;await fs.writeFile(path.join(dir,'faults.json'),JSON.stringify(f.faultLog));throw Object.assign(Error('Injected before real '+stage),{code:'EIO'});}
 }});f.q=f.make();f.owner.bootId=f.q.bootId;return f;
}
async function enqueue(f,file=f.file){return f.q.enqueue({absolutePath:file,source:'argv'});}
async function claim(f,requestId,mode='fresh',o=f.owner){return f.q.claimOpen(o,{requestId,expectedRevision:(await f.q.openQueue()).revision,mode});}
async function displayed(f,c,o=f.owner){const r=await f.q.readClaimedOpen(o,payload(c));return {...payload(c),outcome:'opened',readReceipt:r.readReceipt,display:{opened:true,surfaceReady:true,surfaceEpoch:1,projectId:r.projectId,relPath:r.relPath,display:r.file?.draft?'draft':r.file?'source':'directory',digest:r.digest,materialDigest:r.materialDigest,draftDigest:r.draftDigest}};}
const disk=f=>fs.readFile(f.q.storage.file);
async function finish(f,c){const p=await displayed(f,c);return f.q.resolveOpen(f.owner,p);}

test('parse errors stay explicit and Unicode file/directory requests bind to the existing project',async()=>{
 const f=await fixture(),name=path.join(f.project,'中文 空格.txt');await fs.writeFile(name,'Unicode');
 const parsed=parseExternalArguments(['app','中文 空格.txt','file://%invalid'],{packaged:true,cwd:f.project});assert.deepEqual(parsed.paths,[name]);assert.equal(parsed.errors.length,1);
 const p=await f.host.pick(f.project);assert.deepEqual(await externalTarget(f.host,name),{projectId:p.project.id,relPath:'中文 空格.txt'});
 const a=await enqueue(f,name),c=await claim(f,a.requestId);assert.equal(c.target.relPath,'中文 空格.txt');await finish(f,c);
 const d=await enqueue(f,f.project),cd=await claim(f,d.requestId);assert.equal(cd.target.relPath,null);await finish(f,cd);assert.equal((await f.q.openQueue()).requests.length,0);
});
test('concurrent receive preserves FIFO; single claim/idempotent claim, explicit next and removal protects bytes',async()=>{
 const f=await fixture(),items=await Promise.all(Array.from({length:8},()=>enqueue(f)));const list=await f.q.openQueue();assert.deepEqual(list.requests.map(r=>r.requestId),items.map(r=>r.requestId));
 await assert.rejects(claim(f,items[1].requestId,'retry'),code('OPEN_FIFO'));const c=await claim(f,items[0].requestId);
 assert.deepEqual(await claim(f,c.requestId),c);await assert.rejects(claim(f,items[1].requestId,'retry'),code('OPEN_BUSY'));await finish(f,c);
 await assert.rejects(claim(f,items[1].requestId),code('OPEN_RETRY_REQUIRED'));const cc=await claim(f,items[1].requestId,'retry');
 await f.q.resolveOpen(f.owner,{...payload(cc),outcome:'deferred',error:{code:'COMPOSING',message:'IME still composing'}});
 const before=hashes(await fs.readFile(f.file));const q=await f.q.openQueue();await assert.rejects(f.q.removeOpen(f.owner,{requestId:cc.requestId,expectedRevision:q.revision,confirmed:false}),code('OPEN_CONFIRM_REQUIRED'));
 await f.q.removeOpen(f.owner,{requestId:cc.requestId,expectedRevision:q.revision,confirmed:true});assert.equal(hashes(await fs.readFile(f.file)),before);
});
test('opened needs exact read/display result; no Host/invoke success shortcut; repeated ack and reordered fields are idempotent',async()=>{
 const f=await fixture(),a=await enqueue(f),c=await claim(f,a.requestId);
 await assert.rejects(f.q.resolveOpen(f.owner,{...payload(c),outcome:'opened'}),code('OPEN_UNCONFIRMED'));
 const p=await displayed(f,c);await assert.rejects(f.q.resolveOpen(f.owner,{...p,display:{...p.display,surfaceReady:false}}),code('OPEN_UNCONFIRMED'));
 await assert.rejects(f.q.resolveOpen(f.owner,{...p,display:{...p.display,relPath:'other.txt'}}),code('OPEN_UNCONFIRMED'));
 assert.equal((await f.q.openQueue()).requests.length,1);const r=await f.q.resolveOpen(f.owner,p);assert.equal(r.duplicate,false);
 assert.equal((await f.q.resolveOpen(f.owner,{...p,display:Object.fromEntries(Object.entries(p.display).reverse())})).duplicate,true);
 await assert.rejects(f.q.resolveOpen(f.owner,{...p,display:{...p.display,surfaceEpoch:2}}),code('STALE_OPEN'));
});
test('wrong owner/token/generation and stale late ack cannot consume a newer close-independent attempt',async()=>{
 const f=await fixture(),a=await enqueue(f),c=await claim(f,a.requestId),p=await displayed(f,c);
 await assert.rejects(f.q.resolveOpen(owner(),p),code('STALE_OPEN'));await assert.rejects(f.q.readClaimedOpen(f.owner,{...payload(c),claimToken:randomUUID()}),code('STALE_OPEN'));
 await assert.rejects(f.q.resolveOpen(f.owner,{...p,generation:1}),code('STALE_OPEN'));
 await f.q.invalidateOwner(f.owner);f.owner={...f.owner,generation:1};const n=await claim(f,a.requestId,'retry');
 await assert.rejects(f.q.resolveOpen(f.owner,p),code('STALE_OPEN'));assert.equal((await f.q.openQueue()).requests[0].state,'claimed');await finish(f,n);
});
test('owner boot belongs to this module instance, never to a delayed old main context',async()=>{
 const f=await fixture(),a=await enqueue(f),c=await claim(f,a.requestId);
 await assert.rejects(f.q.readClaimedOpen({...f.owner,bootId:randomUUID()},payload(c)),code('STALE_OPEN'));
 assert.equal((await f.q.openQueue()).requests[0].state,'claimed');
});
for(const boundary of ['binding','read','resolve'])test('owner invalidated across awaited '+boundary+' cannot publish success',async()=>{
 const f=await fixture(),a=await enqueue(f),gate=deferred(),started=deferred();let c,p,run;
 if(boundary==='binding'){
  const real=f.host.pick.bind(f.host);f.host.pick=async(...args)=>{started.resolve();await gate.promise;return real(...args);};run=claim(f,a.requestId);
 }else{
  c=await claim(f,a.requestId);
  if(boundary==='read'){const real=f.host.readFile.bind(f.host);f.host.readFile=async(...args)=>{started.resolve();await gate.promise;return real(...args);};run=f.q.readClaimedOpen(f.owner,payload(c));}
  else{p=await displayed(f,c);const real=f.host.readSource.bind(f.host);f.host.readSource=async(...args)=>{started.resolve();await gate.promise;return real(...args);};run=f.q.resolveOpen(f.owner,p);}
 }
 await started.promise;const rejected=assert.rejects(run,code('STALE_OPEN')),invalid=f.q.invalidateOwner(f.owner);gate.resolve();await rejected;await invalid;
 assert.equal((await f.q.openQueue()).requests[0].requiresUserAction,true);assert.equal((await f.q.openQueue()).requests[0].state,'blocked');
});
test('destroyed-owner invalidation is idempotent and releases claim for a replacement owner',async()=>{
 const f=await fixture(),a=await enqueue(f);await claim(f,a.requestId);f.owner.window.isDestroyed=()=>true;await f.q.invalidateOwner(f.owner);await f.q.invalidateOwner(f.owner);
 f.owner={...owner(),bootId:f.q.bootId};await finish(f,await claim(f,a.requestId,'retry'));
});
test('deferred IME/CAS stays queued; only explicit retry, duplicate defer never replays',async()=>{
 const f=await fixture(),a=await enqueue(f),c=await claim(f,a.requestId),p={...payload(c),outcome:'deferred',error:{code:'CONFLICT',message:'External source and dirty draft retained'}};
 const before=await fs.readFile(f.file,'utf8');await f.q.resolveOpen(f.owner,p);assert.equal((await f.q.resolveOpen(f.owner,p)).duplicate,true);
 await assert.rejects(claim(f,a.requestId),code('OPEN_RETRY_REQUIRED'));assert.equal(await fs.readFile(f.file,'utf8'),before);await finish(f,await claim(f,a.requestId,'retry'));
});
test('draft may be displayed explicitly, but disappeared source cannot be satisfied by retained draft',async()=>{
 const f=await fixture(),project=(await f.host.recent()).projects[0],source=await f.host.readFile(project.id,'A.txt');await f.host.draft(project.id,'A.txt',source.digest,'Retained user draft');
 const a=await enqueue(f),c=await claim(f,a.requestId),p=await displayed(f,c);assert.equal(p.display.display,'draft');await f.q.resolveOpen(f.owner,p);
 const b=await enqueue(f),cc=await claim(f,b.requestId);await fs.unlink(f.file);await assert.rejects(f.q.readClaimedOpen(f.owner,payload(cc)));
 assert.equal((await f.q.openQueue()).requests[0].state,'blocked');assert.equal((await f.host.readFile(project.id,'A.txt')).diskPresent,false);
});
test('missing initial target and unsupported format remain visible requests',async()=>{
 const f=await fixture(),missing=await enqueue(f,path.join(f.project,'missing.txt'));await assert.rejects(claim(f,missing.requestId));assert.equal((await f.q.openQueue()).requests[0].state,'blocked');
 await f.q.removeOpen(f.owner,{requestId:missing.requestId,expectedRevision:(await f.q.openQueue()).revision,confirmed:true});
 const binary=path.join(f.project,'unsupported.bin');await fs.writeFile(binary,Buffer.from([0,1,2]));const a=await enqueue(f,binary),c=await claim(f,a.requestId);await assert.rejects(f.q.readClaimedOpen(f.owner,payload(c)),code('OPEN_NOT_DISPLAYABLE'));
});
test('file replacement requires explicit retry of fixed path; source version changes reject ack',async()=>{
 const f=await fixture(),a=await enqueue(f),c=await claim(f,a.requestId),p=await displayed(f,c);
 await fs.writeFile(f.file,'Changed after read');await assert.rejects(f.q.resolveOpen(f.owner,p),code('OPEN_TARGET_CHANGED'));await f.q.resolveOpen(f.owner,{...payload(c),outcome:'deferred',error:{code:'OPEN_TARGET_CHANGED',message:'changed'}});
 await fs.rename(f.file,f.file+'.old');await fs.writeFile(f.file,'Replacement at original path');const n=await claim(f,a.requestId,'retry');assert.equal(n.target.projectId,c.target.projectId);assert.equal(n.target.relPath,c.target.relPath);await finish(f,n);assert.equal(await fs.readFile(f.file+'.old','utf8'),'Changed after read');
});
test('root replacement and symlink/parent escape never rebind or guess a moved target',async()=>{
 const f=await fixture(),a=await enqueue(f),c=await claim(f,a.requestId);await f.q.resolveOpen(f.owner,{...payload(c),outcome:'deferred',error:{code:'COMPOSING',message:'wait'}});
 await fs.rename(f.project,f.project+'.old');await fs.mkdir(f.project);await fs.writeFile(f.file,'different root');await assert.rejects(claim(f,a.requestId,'retry'));assert.equal((await f.q.openQueue()).requests[0].state,'blocked');assert.equal(await fs.readFile(f.file,'utf8'),'different root');
 const g=await fixture(),link=path.join(g.project,'link.txt');await fs.symlink(g.file,link);const b=await enqueue(g,link);await assert.rejects(claim(g,b.requestId));assert.equal((await g.q.openQueue()).requests[0].state,'blocked');
 const h=await fixture(),sub=path.join(h.project,'sub');await fs.mkdir(sub);const nested=path.join(sub,'N.txt');await fs.writeFile(nested,'Nested');const e=await enqueue(h,nested),ce=await claim(h,e.requestId);await h.q.resolveOpen(h.owner,{...payload(ce),outcome:'deferred',error:{code:'COMPOSING',message:'wait'}});
 await fs.rename(sub,sub+'.old');const outside=path.join(h.dir,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'N.txt'),'outside');await fs.symlink(outside,sub);await assert.rejects(claim(h,e.requestId,'retry'));assert.equal((await h.q.openQueue()).requests[0].state,'blocked');
});
test('restart pending and claimed all require explicit action, old boot receipt cannot consume',async()=>{
 const f=await fixture(),a=await enqueue(f);f.q=f.make();f.owner={...f.owner,bootId:f.q.bootId};assert.equal((await f.q.openQueue()).requests[0].requiresUserAction,true);await assert.rejects(claim(f,a.requestId),code('OPEN_RETRY_REQUIRED'));
 const c=await claim(f,a.requestId,'retry'),p=await displayed(f,c);f.q=f.make();f.owner={...f.owner,bootId:f.q.bootId};const restarted=await f.q.openQueue();assert.equal(restarted.requests[0].state,'blocked');assert.equal(restarted.requests[0].lastError.code,'OPEN_INTERRUPTED');await assert.rejects(f.q.resolveOpen(f.owner,p),code('STALE_OPEN'));await finish(f,await claim(f,a.requestId,'retry'));
});
for(const stage of ['create','write','file-sync','rename','directory-sync'])test('receive persistence failure at '+stage+' retains/reconciles and explicitly retries',async()=>{
 const f=await fixture(),first=await enqueue(f),before=await disk(f);f.failStage=stage;const id=randomUUID();let error;
 try{await f.q.enqueue({absolutePath:f.file,source:'argv',requestId:id});assert.fail('expected fault');}catch(e){error=e;}
 assert.equal(error.code,'OPEN_PERSISTENCE_UNCONFIRMED');assert.equal(error.details.requestId,id);assert.equal(error.details.committed,stage==='directory-sync');
 if(stage!=='directory-sync')assert.deepEqual(await disk(f),before);else{const committed=JSON.parse(await disk(f));assert.equal(committed.commitId,error.details.commitId);assert.equal(committed.revision,error.details.revision);}
 assert.equal((await f.q.openQueue()).status,'paused');await assert.rejects(enqueue(f),code('OPEN_PERSISTENCE_UNCONFIRMED'));
 assert.equal((await f.q.openQueue({retryPersistence:true})).status,'ready');assert.equal((await f.q.enqueue({absolutePath:f.file,source:'argv',requestId:id})).duplicate,true);assert.deepEqual((await f.q.openQueue()).requests.map(r=>r.requestId),[first.requestId,id]);
});
for(const stage of ['write','file-sync','rename','directory-sync'])test('opened ack fault at '+stage+' retries only receipt and never Host re-read/open',async()=>{
 const f=await fixture(),a=await enqueue(f),c=await claim(f,a.requestId),p=await displayed(f,c);let reads=0;const real=f.host.readFile.bind(f.host);f.host.readFile=(...args)=>{reads++;return real(...args);};f.failStage=stage;
 await assert.rejects(f.q.resolveOpen(f.owner,p),code('OPEN_PERSISTENCE_UNCONFIRMED'));await f.q.openQueue({retryPersistence:true});assert.equal((await f.q.resolveOpen(f.owner,p)).duplicate,true);assert.equal(reads,0);assert.equal((await f.q.openQueue()).requests.length,0);
 const fresh=f.make();assert.equal((await fresh.openQueue()).requests.length,0);await assert.rejects(fresh.resolveOpen({...f.owner,bootId:fresh.bootId},p),code('STALE_OPEN'));
});
test('owner expires during uncertain claim save; persistence retry cannot revive stale lease',async()=>{
 const f=await fixture(),a=await enqueue(f);f.failStage='directory-sync';await assert.rejects(claim(f,a.requestId),code('OPEN_PERSISTENCE_UNCONFIRMED'));
 await assert.rejects(f.q.invalidateOwner(f.owner),code('OPEN_PERSISTENCE_UNCONFIRMED'));await f.q.openQueue({retryPersistence:true});f.owner={...f.owner,generation:1};const c=await claim(f,a.requestId,'retry');await finish(f,c);
});
test('unknown commit/external queue change freezes original instead of overwriting old memory',async()=>{
 const f=await fixture();await enqueue(f);const d=JSON.parse(await disk(f));d.revision++;d.commitId=randomUUID();const changed=Buffer.from(JSON.stringify(d));await fs.writeFile(f.q.storage.file,changed);
 await assert.rejects(enqueue(f),code('OPEN_QUEUE_UNCERTAIN'));assert.equal((await f.q.openQueue()).status,'frozen');assert.deepEqual(await disk(f),changed);
 const g=await fixture();await enqueue(g);g.failStage='directory-sync';await assert.rejects(enqueue(g));const unknown=Buffer.from('{not our commit');await fs.writeFile(g.q.storage.file,unknown);await assert.rejects(g.q.openQueue({retryPersistence:true}),code('OPEN_QUEUE_UNCERTAIN'));assert.deepEqual(await disk(g),unknown);
});
for(const kind of ['json','schema','duplicate','binding','oversize','symlink','remnant'])test('corrupt/unsafe '+kind+' freezes without replacing original',async()=>{
 const f=await fixture();await enqueue(f);const file=f.q.storage.file,valid=JSON.parse(await disk(f));let bytes;
 if(kind==='json')bytes=Buffer.from('{bad json');
 if(kind==='schema'){valid.schemaVersion=99;bytes=Buffer.from(JSON.stringify(valid));}
 if(kind==='duplicate'){valid.requests.push(valid.requests[0]);bytes=Buffer.from(JSON.stringify(valid));}
 if(kind==='binding'){valid.requests[0].binding={projectId:'fake'};bytes=Buffer.from(JSON.stringify(valid));}
 if(kind==='oversize')bytes=Buffer.alloc(2*1024*1024+1,32);
 if(bytes)await fs.writeFile(file,bytes);
 if(kind==='symlink'){await fs.rename(file,file+'.original');await fs.symlink(file+'.original',file);}
 if(kind==='remnant'){await fs.rename(file,file+'.original');await fs.writeFile(path.join(path.dirname(file),'.tmp-open-owned-evidence'),'unfinished');}
 const q=f.make();assert.equal((await q.openQueue()).status,'frozen');await assert.rejects(q.enqueue({absolutePath:f.file,source:'argv'}));
 if(bytes)assert.deepEqual(await fs.readFile(file),bytes);if(kind==='symlink')assert((await fs.lstat(file)).isSymbolicLink());if(kind==='remnant')await assert.rejects(fs.stat(file),code('ENOENT'));
});
test('actual 128 pending limit; invalid/oversized paths rejected without truncation',async()=>{
 const f=await fixture();await Promise.all(Array.from({length:128},()=>enqueue(f)));const before=await disk(f);await assert.rejects(enqueue(f),code('OPEN_QUEUE_FULL'));assert.deepEqual(await disk(f),before);
 for(const absolutePath of ['../escape',f.file+'\0',path.join(f.project,'x'.repeat(16*1024))])await assert.rejects(f.q.enqueue({absolutePath,source:'argv'}),code('OPEN_INVALID'));
 assert.equal((await f.q.openQueue()).requests.length,128);
});
test('receipt retention expires old ack; error text bounded; serialized capacity not truncated',async()=>{
 const f=await fixture({limits:{receipts:2}});let oldest;
 for(let i=0;i<3;i++){const a=await enqueue(f),c=await claim(f,a.requestId),p=await displayed(f,c);oldest??=p;await f.q.resolveOpen(f.owner,p);}
 await assert.rejects(f.q.resolveOpen(f.owner,oldest),code('ACK_EXPIRED'));assert.equal(JSON.parse(await disk(f)).receipts.length,2);
 const a=await enqueue(f),c=await claim(f,a.requestId);await f.q.resolveOpen(f.owner,{...payload(c),outcome:'deferred',error:{code:'CONFLICT',message:'x'.repeat(800)}});assert.equal((await f.q.openQueue()).requests[0].lastError.message.length,512);
 const g=await fixture({limits:{bytes:300}});await assert.rejects(enqueue(g),code('OPEN_QUEUE_FULL'));assert.equal((await g.q.openQueue()).requests.length,0);
});
test('owner invalidated during pre-rename ack write must retain interrupted request',async()=>{
 const f=await fixture(),a=await enqueue(f),c=await claim(f,a.requestId),p=await displayed(f,c),gate=deferred(),started=deferred();let once=true;
 f.q.storage.fault=async stage=>{if(stage==='rename'&&once){once=false;started.resolve();await gate.promise;}};
 const run=f.q.resolveOpen(f.owner,p),rejected=assert.rejects(run,code('STALE_OPEN'));await started.promise;const invalid=f.q.invalidateOwner(f.owner);gate.resolve();await rejected;await invalid;
 const list=await f.q.openQueue();assert.equal(list.requests.length,1,'stale ack must not remove the request');assert.equal(list.requests[0].state,'blocked');assert.equal(JSON.parse(await disk(f)).receipts.length,0);
});
test('fixed binding survives later recent-root changes; receipt rejects changed draft',async()=>{
 const f=await fixture(),sub=path.join(f.project,'nested');await fs.mkdir(sub);const file=path.join(sub,'N.txt');await fs.writeFile(file,'Nested source');
 const a=await enqueue(f,file),c=await claim(f,a.requestId);await f.q.resolveOpen(f.owner,{...payload(c),outcome:'deferred',error:{code:'COMPOSING',message:'wait'}});await f.host.pick(sub);
 const n=await claim(f,a.requestId,'retry');assert.equal(n.target.projectId,c.target.projectId);assert.equal(n.target.relPath,'nested/N.txt');const p=await displayed(f,n);await f.host.draft(n.target.projectId,n.target.relPath,p.display.digest,'New draft after read');await assert.rejects(f.q.resolveOpen(f.owner,p),code('OPEN_TARGET_CHANGED'));assert.equal((await f.q.openQueue()).requests.length,1);
});
test('repeated persistence retry failure reconciles rename commit and then confirms only its receipt',async()=>{
 const f=await fixture(),a=await enqueue(f),c=await claim(f,a.requestId),p=await displayed(f,c);f.failStage='write';await assert.rejects(f.q.resolveOpen(f.owner,p),code('OPEN_PERSISTENCE_UNCONFIRMED'));
 f.failStage='directory-sync';let error;try{await f.q.openQueue({retryPersistence:true});assert.fail('expected repeated failure');}catch(e){error=e;}
 assert.equal(error.code,'OPEN_PERSISTENCE_UNCONFIRMED');assert.equal(error.details.committed,true);const diskCommit=JSON.parse(await disk(f));assert.equal(error.details.commitId,diskCommit.commitId);assert.equal(error.details.revision,diskCommit.revision);
 await f.q.openQueue({retryPersistence:true});assert.equal((await f.q.resolveOpen(f.owner,p)).duplicate,true);assert.equal((await f.q.openQueue()).requests.length,0);
});
test('uncommitted ack cannot be replayed after owner expiry during persistence pause',async()=>{
 const f=await fixture(),a=await enqueue(f),c=await claim(f,a.requestId),p=await displayed(f,c);f.failStage='file-sync';await assert.rejects(f.q.resolveOpen(f.owner,p));await assert.rejects(f.q.invalidateOwner(f.owner),code('OPEN_PERSISTENCE_UNCONFIRMED'));
 const list=await f.q.openQueue({retryPersistence:true});assert.equal(list.requests.length,1);assert.equal(list.requests[0].state,'blocked');assert.equal(JSON.parse(await disk(f)).receipts.length,0);
 f.owner={...f.owner,generation:1};await finish(f,await claim(f,a.requestId,'retry'));
});
test('status data cannot mutate queue internals; queue directory link and real unreadable source rejected',async()=>{
 const f=await fixture(),a=await enqueue(f),c=await claim(f,a.requestId);await f.q.resolveOpen(f.owner,{...payload(c),outcome:'deferred',error:{code:'COMPOSING',message:'safe'}});const list=await f.q.openQueue();list.requests[0].lastError.code='tampered';assert.equal((await f.q.openQueue()).requests[0].lastError.code,'COMPOSING');
 const oldDir=f.q.storage.dir;await fs.rename(oldDir,oldDir+'.original');await fs.symlink(oldDir+'.original',oldDir);const before=await fs.readFile(path.join(oldDir+'.original','queue.json'));assert.equal((await f.make().openQueue()).status,'frozen');assert.deepEqual(await fs.readFile(path.join(oldDir+'.original','queue.json')),before);
 const g=await fixture(),b=await enqueue(g),cc=await claim(g,b.requestId);assert.notEqual(process.getuid(),0,'permission test requires unprivileged user');await fs.chmod(g.file,0);try{await assert.rejects(g.q.readClaimedOpen(g.owner,payload(cc)));assert.equal((await g.q.openQueue()).requests[0].state,'blocked');}finally{await fs.chmod(g.file,0o600);}
});
for(const phase of ['claim','terminal'])test('real own child SIGKILL after '+phase+' commit; disk survives and no replay',async()=>{
 const f=await fixture(),fixturePath=path.resolve(import.meta.dirname,'external-open-queue-crash.fixture.mjs');
 const child=fork(fixturePath,[f.dir,phase],{cwd:f.dir,stdio:['ignore','pipe','pipe','ipc']});let log='',exited=false;for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
 const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});}));let timer;
 try{
  const row=await Promise.race([new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);exit.then(r=>reject(Error('early exit '+JSON.stringify(r)+log)));}),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('child timeout')),20000))]);clearTimeout(timer);
  assert.equal(row.pid,child.pid);const info=await processInfo(child.pid),start=info.stamp,argv=child.spawnargs; // kernel identity + the exact arguments of our own fork; no environment query needed
  const exe=await fs.realpath(argv[0]),cwd=f.dir;
  assert.equal(exe,await fs.realpath(process.execPath));assert.equal(info.ppid,process.pid);assert(argv.includes(fixturePath)&&argv.includes(f.dir));assert.equal((await processInfo(child.pid)).stamp,start);
  child.kill('SIGKILL');assert.deepEqual(await exit,{code:null,signal:'SIGKILL'});await fs.writeFile(path.join(f.dir,'child-audit.json'),JSON.stringify({pid:child.pid,start,exe,cwd,argv,phase,signal:'SIGKILL',only:'identity-verified own child',row,exit:{code:null,signal:'SIGKILL'}},null,2));
  f.q=f.make();f.owner={...f.owner,bootId:f.q.bootId};const restored=await f.q.openQueue();if(phase==='claim'){assert.equal(restored.requests.length,1);assert.equal(restored.requests[0].lastError.code,'OPEN_INTERRUPTED');assert.equal(restored.requests[0].requiresUserAction,true);await finish(f,await claim(f,row.requestId,'retry'));}else{assert.equal(restored.requests.length,0);assert.equal(JSON.parse(await disk(f)).receipts[0].outcome,'opened');}
  assert.equal(await processInfo(child.pid),null);assert.equal(await fs.readFile(f.file,'utf8'),'Source original\n');
 }finally{clearTimeout(timer);if(!exited){child.send('finish');await Promise.race([exit,new Promise(r=>setTimeout(r,1000))]);if(!exited)throw Error('Own child cleanup incomplete; preserved PID '+child.pid);}await fs.writeFile(path.join(f.dir,'child.log'),log);}
});
test('fresh Host and queue inherit the bound project and retained draft after recent-root changes',async()=>{
 const f=await fixture(),sub=path.join(f.project,'nested');await fs.mkdir(sub);const file=path.join(sub,'N.txt');await fs.writeFile(file,'Nested source\n');
 const a=await enqueue(f,file),c=await claim(f,a.requestId),source=await f.host.readFile(c.target.projectId,c.target.relPath);
 await f.host.draft(c.target.projectId,c.target.relPath,source.digest,'UNSAVED USER DRAFT\n');
 await f.q.resolveOpen(f.owner,{...payload(c),outcome:'deferred',error:{code:'COMPOSING',message:'Keep the current editor'}});
 const nested=await f.host.pick(sub);assert.notEqual(nested.project.id,c.target.projectId);
 f.host=new DesktopHost(f.profile);f.q=new ExternalOpenQueue({host:f.host});f.owner={...owner(),bootId:f.q.bootId};
 const restored=await f.q.openQueue();assert.equal(restored.requests.length,1);assert.equal(restored.requests[0].requestId,a.requestId);assert.equal(restored.requests[0].requiresUserAction,true);
 await assert.rejects(claim(f,a.requestId),code('OPEN_RETRY_REQUIRED'));
 const retry=await claim(f,a.requestId,'retry');assert.equal(retry.target.projectId,c.target.projectId);assert.equal(retry.target.relPath,'nested/N.txt');
 const read=await f.q.readClaimedOpen(f.owner,payload(retry));assert.equal(read.projectId,c.target.projectId);assert.equal(read.file.draft.text,'UNSAVED USER DRAFT\n');
 const receipt=await displayed(f,retry);assert.equal(receipt.display.display,'draft');await f.q.resolveOpen(f.owner,receipt);
 assert.equal((await f.q.openQueue()).requests.length,0);assert.equal(await fs.readFile(file,'utf8'),'Nested source\n');assert.equal((await f.host.readDraftRecord(c.target.projectId,c.target.relPath)).text,'UNSAVED USER DRAFT\n');
});
