import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {bindExternalOpen,revalidateExternalOpen} from './external-open.mjs';
import {OpenQueueStorage,OpenQueueError,digest,fail} from './external-open-queue-storage.mjs';

export {OpenQueueError};
export const OPEN_QUEUE_LIMITS=Object.freeze({requests:128,receipts:128,bytes:2*1024*1024,pathBytes:16*1024,errorChars:512});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const copy=v=>structuredClone(v);
const stable=v=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
const fields=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>names.includes(k));
function absolute(v){return typeof v==='string'&&path.isAbsolute(v)&&!v.includes('\0')&&Buffer.byteLength(v)<=OPEN_QUEUE_LIMITS.pathBytes&&path.normalize(v)===v;}
function errorRecord(error){return {code:String(error?.code||'OPEN_FAILED').slice(0,64),message:String(error?.message||error).slice(0,OPEN_QUEUE_LIMITS.errorChars)};}
const stamp=v=>fields(v,['dev','ino','size','mtimeNs'])&&['dev','ino','size','mtimeNs'].every(k=>typeof v[k]==='string'&&(k==='mtimeNs'?/^-?\d+$/:/^\d+$/).test(v[k]));
function bindingValid(b){
 return fields(b,['projectId','canonicalRoot','relPath','canonicalTarget','requestedPath','kind','rootIdentity','targetIdentity'])&&hex(b.projectId)&&absolute(b.canonicalRoot)&&b.projectId===digest(b.canonicalRoot)&&absolute(b.canonicalTarget)&&absolute(b.requestedPath)&&stamp(b.rootIdentity)&&stamp(b.targetIdentity)&&
  (b.kind==='directory'?b.relPath===null&&b.canonicalRoot===b.canonicalTarget:b.kind==='file'&&typeof b.relPath==='string'&&b.relPath.length>0&&b.relPath.length<=1024&&!/[\\:\0]/.test(b.relPath)&&b.relPath.split('/').every(p=>p&&p!=='.'&&p!=='..')&&!path.posix.isAbsolute(b.relPath)&&path.resolve(b.canonicalRoot,...b.relPath.split('/'))===b.canonicalTarget);
}
function validate(data,limits){
 const bad=()=>fail('OPEN_QUEUE_CORRUPT','Invalid queue record; original retained.');
 if(!fields(data,['schemaVersion','revision','commitId','nextSequence','requests','receipts'])||data.schemaVersion!==1){if(data?.schemaVersion!==1)fail('OPEN_QUEUE_SCHEMA','Unsupported queue schema; original retained.');bad();}
 if(!integer(data.revision)||!uuid(data.commitId)||!integer(data.nextSequence)||!Array.isArray(data.requests)||!Array.isArray(data.receipts)||data.requests.length>limits.requests||data.receipts.length>limits.receipts)bad();
 const ids=new Set(),sequences=new Set();
 for(const r of data.requests){
  if(!fields(r,['requestId','sequence','receivedAt','source','absolutePath','state','requiresUserAction','binding','lastError'])||!uuid(r.requestId)||ids.has(r.requestId)||!integer(r.sequence)||r.sequence>=data.nextSequence||sequences.has(r.sequence)||!integer(r.receivedAt)||!['argv','open-file','second-instance'].includes(r.source)||!absolute(r.absolutePath)||!['pending','claimed','blocked'].includes(r.state)||typeof r.requiresUserAction!=='boolean'||!(r.binding===null||bindingValid(r.binding))||!(r.lastError===null||fields(r.lastError,['code','message'])&&typeof r.lastError.code==='string'&&r.lastError.code.length<=64&&typeof r.lastError.message==='string'&&r.lastError.message.length<=512))bad();
  if(r.state==='claimed'&&!r.binding||r.state==='blocked'&&(!r.requiresUserAction||!r.lastError))bad();
  ids.add(r.requestId);sequences.add(r.sequence);
 }
 for(let i=1;i<data.requests.length;i++)if(data.requests[i-1].sequence>=data.requests[i].sequence)bad();
 const attempts=new Set();
 for(const r of data.receipts){
  if(!fields(r,['requestId','attemptId','bootId','generation','tokenHash','readReceipt','resultHash','outcome','at'])||!uuid(r.requestId)||ids.has(r.requestId)||!uuid(r.attemptId)||attempts.has(r.attemptId)||!uuid(r.bootId)||!integer(r.generation)||!hex(r.tokenHash)||!(r.readReceipt===null||uuid(r.readReceipt))||!hex(r.resultHash)||!['opened','removed'].includes(r.outcome)||!integer(r.at)||r.outcome==='opened'&&!uuid(r.readReceipt))bad();
  ids.add(r.requestId);attempts.add(r.attemptId);
 }
 return data;
}

// The caller is trusted main code. Owner objects NEVER come from IPC payloads.
// No window, Provider, renderer or singleton is created by this module.
export class ExternalOpenQueue {
 constructor({host,fault,limits={}}){
  this.host=host;this.bootId=randomUUID();this.limits={...OPEN_QUEUE_LIMITS,...limits};
  if(Object.keys(limits).some(k=>!['requests','receipts','bytes'].includes(k)))fail('OPEN_INVALID','Only reduced test capacities may be configured.');
  for(const key of Object.keys(this.limits))if(!integer(this.limits[key])||this.limits[key]<1||this.limits[key]>OPEN_QUEUE_LIMITS[key])fail('OPEN_INVALID','Invalid queue limit.');
  this.storage=new OpenQueueStorage(host,{fault,maxBytes:this.limits.bytes});this.chain=Promise.resolve();this.loaded=false;this.diskHash=null;this.data=null;this.paused=null;this.frozen=null;this.lease=null;this.revoked=new WeakMap();this.terminals=new Map();
 }
 _run(fn){const task=this.chain.then(async()=>{await this._load();return fn();});this.chain=task.catch(()=>{});return task;}
 _healthy(){if(this.frozen)throw this.frozen;if(this.paused)fail('OPEN_PERSISTENCE_UNCONFIRMED','Queue write needs explicit persistence retry.',{commitId:this.paused.next.commitId,revision:this.paused.next.revision});}
 async _load(){
  if(this.loaded)return;this.loaded=true;
  try{
   const raw=await this.storage.read();this.diskHash=raw.hash;
   this.data=raw.bytes?validate(JSON.parse(raw.bytes),this.limits):{schemaVersion:1,revision:0,commitId:randomUUID(),nextSequence:0,requests:[],receipts:[]};
   if(this.data.requests.some(r=>r.state==='claimed'||!r.requiresUserAction)){
    const next=copy(this.data);
    for(const r of next.requests){r.requiresUserAction=true;if(r.state==='claimed'){r.state='blocked';r.lastError={code:'OPEN_INTERRUPTED',message:'Opening was interrupted; explicitly retry.'};}}
    await this._commit(next);
   }
  }catch(error){if(this.paused)return;this.frozen=error instanceof OpenQueueError?error:new OpenQueueError('OPEN_QUEUE_CORRUPT','Queue could not be loaded; original retained.',errorRecord(error));}
 }
 async _commit(next,{guard=()=>{}}={}){
  next.revision=this.data.revision+1;next.commitId=randomUUID();validate(next,this.limits);
  if(Buffer.byteLength(JSON.stringify(next))>this.limits.bytes)fail('OPEN_QUEUE_FULL','Queue serialization exceeds capacity.');
  const plan={next,priorHash:this.diskHash,nextHash:digest(JSON.stringify(next)),committed:false,guard};
  try{await this.storage.write(next,plan.priorHash,guard);this.data=next;this.diskHash=plan.nextHash;}
  catch(error){
   try{
    const raw=await this.storage.read();
    if(raw.hash===plan.nextHash){const observed=validate(JSON.parse(raw.bytes),this.limits);if(observed.commitId!==next.commitId||observed.revision!==next.revision)throw Error('commit mismatch');plan.committed=true;}
    else if(raw.hash!==plan.priorHash)throw Error('unknown on-disk commit');
    if(error.code==='STALE_OPEN'&&raw.hash===plan.priorHash)throw error;
    if(error.code==='OPEN_QUEUE_CHANGED'||error.code==='OPEN_QUEUE_UNSAFE')throw error;
    this.paused=plan;
   }catch(reconcile){if(reconcile.code==='STALE_OPEN')throw reconcile;this.frozen=new OpenQueueError('OPEN_QUEUE_UNCERTAIN','Cannot establish on-disk commit; queue frozen, originals retained.',errorRecord(reconcile));throw this.frozen;}
   fail('OPEN_PERSISTENCE_UNCONFIRMED','Persistence failed; explicit retry required.',{commitId:next.commitId,revision:next.revision,committed:plan.committed,cause:error.code||'IO_ERROR'});
  }
 }
 async _resume(){
  if(this.frozen)throw this.frozen;if(!this.paused)return;
  const p=this.paused;
  try{
   const raw=await this.storage.read();
   if(raw.hash===p.nextHash){const disk=validate(JSON.parse(raw.bytes),this.limits);if(disk.commitId!==p.next.commitId||disk.revision!==p.next.revision)throw Error('commit identity mismatch');await this.storage.sync();}
   else if(raw.hash===p.priorHash&&!p.committed)await this.storage.write(p.next,p.priorHash,p.guard);
   else fail('OPEN_QUEUE_UNCERTAIN','On-disk commit changed during persistence retry.');
   const after=await this.storage.read();if(after.hash!==p.nextHash)fail('OPEN_QUEUE_UNCERTAIN','Commit changed while syncing.');
   this.data=p.next;this.diskHash=p.nextHash;this.paused=null;
   if(this.lease){let stale=false;try{this._owner(this.lease.owner);}catch{stale=true;}if(stale){const id=this.lease.requestId;this.lease=null;await this._block(id,{code:'OPEN_INTERRUPTED',message:'Owner expired while saving; explicitly retry.'});}}
  }catch(error){
   if(error.code==='STALE_OPEN'&&!p.committed){
    const raw=await this.storage.read();if(raw.hash===p.priorHash){this.paused=null;const lease=this.lease;this.lease=null;if(lease){this.terminals.delete(lease.attemptId);await this._block(lease.requestId,{code:'OPEN_INTERRUPTED',message:'Owner expired before commit; explicitly retry.'});}return;}
   }
   if(['OPEN_QUEUE_UNCERTAIN','OPEN_QUEUE_CHANGED','OPEN_QUEUE_UNSAFE','OPEN_QUEUE_CORRUPT'].includes(error.code)){this.frozen=new OpenQueueError('OPEN_QUEUE_UNCERTAIN','Persistence retry cannot establish commit; originals retained.',errorRecord(error));throw this.frozen;}
   try{
    const raw=await this.storage.read();
    if(raw.hash===p.nextHash){const disk=validate(JSON.parse(raw.bytes),this.limits);if(disk.commitId!==p.next.commitId||disk.revision!==p.next.revision)throw Error('retry commit mismatch');p.committed=true;}
    else if(raw.hash!==p.priorHash||p.committed)throw Error('unknown retry commit');
   }catch(reconcile){this.frozen=new OpenQueueError('OPEN_QUEUE_UNCERTAIN','Cannot reconcile failed persistence retry; originals retained.',errorRecord(reconcile));throw this.frozen;}
   fail('OPEN_PERSISTENCE_UNCONFIRMED','Persistence still unconfirmed.',{commitId:p.next.commitId,revision:p.next.revision,committed:p.committed,cause:error.code||'IO_ERROR'});
  }
 }
 _owner(owner){
  if(!owner||typeof owner.window!=='object'||!owner.window||typeof owner.webContents!=='object'||!owner.webContents||!integer(owner.generation))fail('OPEN_INVALID','Main owner requires window, webContents and generation.');
  if(owner.bootId!==this.bootId||owner.window.isDestroyed?.()||owner.webContents.isDestroyed?.()||owner.window.webContents&&owner.window.webContents!==owner.webContents||(this.revoked.get(owner.webContents)??-1)>=owner.generation)fail('STALE_OPEN','Opening owner is no longer current.');
 }
 _sameOwner(a,b){return a.window===b.window&&a.webContents===b.webContents&&a.generation===b.generation;}
 _active(p){this._owner(p.owner);if(this.lease!==p)fail('STALE_OPEN','Claim was replaced before commit.');}
 _claim(owner,payload){
  this._owner(owner);const p=this.lease;
  if(!p||p.requestId!==payload?.requestId||p.attemptId!==payload?.attemptId||p.claimToken!==payload?.claimToken||payload?.generation!==owner.generation||!this._sameOwner(p.owner,owner))fail('STALE_OPEN','Opening claim does not match this owner/attempt.');
  return p;
 }
 _publicClaim(p){return {requestId:p.requestId,attemptId:p.attemptId,claimToken:p.claimToken,generation:p.owner.generation,target:copy(p.binding)};}
 _revision(v){if(v!==this.data.revision)fail('OPEN_REVISION','Queue changed; query it again.');}
 _payload(value,keys){if(!fields(value,keys))fail('OPEN_INVALID','Invalid opening payload.');}
 _request(id){const r=this.data.requests.find(r=>r.requestId===id);if(!r)fail('ACK_EXPIRED','Request or receipt is no longer retained.');return r;}
 async _block(id,error){
  if(!this.data.requests.some(r=>r.requestId===id))return;
  const next=copy(this.data),r=next.requests.find(r=>r.requestId===id);r.state='blocked';r.requiresUserAction=true;r.lastError=errorRecord(error);await this._commit(next);
 }
 _remember(key,value){this.terminals.set(key,value);while(this.terminals.size>this.limits.receipts)this.terminals.delete(this.terminals.keys().next().value);}
 async openQueue({retryPersistence=false}={}){
  if(typeof retryPersistence!=='boolean')fail('OPEN_INVALID','Persistence retry must be explicit boolean.');
  return this._run(async()=>{
   if(retryPersistence)await this._resume();
   const data=this.paused?.next||this.data;
   return {protocol:1,status:this.frozen?'frozen':this.paused?'paused':'ready',revision:data?.revision??0,error:this.frozen?errorRecord(this.frozen):this.paused?{code:'OPEN_PERSISTENCE_UNCONFIRMED',message:'Explicit persistence retry required.'}:null,
    requests:(data?.requests||[]).map(r=>({requestId:r.requestId,sequence:r.sequence,absolutePath:r.absolutePath,state:r.state,requiresUserAction:r.requiresUserAction,target:r.binding?{projectId:r.binding.projectId,relPath:r.binding.relPath,kind:r.binding.kind}:null,lastError:copy(r.lastError)}))};
  });
 }
 async enqueue({absolutePath,source,requestId=randomUUID()}){
  if(!absolute(absolutePath)||!['argv','open-file','second-instance'].includes(source)||!uuid(requestId))fail('OPEN_INVALID','Invalid external request path/source/id.');
  return this._run(async()=>{
   this._healthy();const existing=this.data.requests.find(r=>r.requestId===requestId),receipt=this.data.receipts.find(r=>r.requestId===requestId);
   if(existing){if(existing.absolutePath!==absolutePath||existing.source!==source)fail('OPEN_INVALID','Request id was reused with another target.');return {requestId,durable:true,duplicate:true};}
   if(receipt)fail('ACK_EXPIRED','Completed request id cannot be enqueued again.');
   if(this.data.requests.length>=this.limits.requests||this.data.nextSequence===Number.MAX_SAFE_INTEGER)fail('OPEN_QUEUE_FULL','Pending request capacity exhausted; request not accepted.');
   const next=copy(this.data);next.requests.push({requestId,sequence:next.nextSequence++,receivedAt:Date.now(),source,absolutePath,state:'pending',requiresUserAction:next.requests.length!==0,binding:null,lastError:null});
   // Leave space for a concrete blocked reason, even when binding itself would
   // exceed the file cap. A failure must never leave an auto-retryable head.
   if(Buffer.byteLength(JSON.stringify(next))+2048>this.limits.bytes)fail('OPEN_QUEUE_FULL','Queue needs error-record reserve; request not accepted.');
   try{await this._commit(next);}catch(error){error.details={...error.details,requestId};throw error;}
   return {requestId,durable:true,duplicate:false};
  });
 }
 async claimOpen(owner,payload){
  this._payload(payload,['requestId','expectedRevision','mode']);
  return this._run(async()=>{
   this._healthy();this._owner(owner);
   if(this.lease){
    const p=this.lease;
    if(p.requestId===payload.requestId&&this._sameOwner(p.owner,owner)&&this.data.requests.some(r=>r.requestId===p.requestId&&r.state==='claimed'))return this._publicClaim(p);
    fail('OPEN_BUSY','Another request is currently claimed.');
   }
   this._revision(payload.expectedRevision);const r=this._request(payload.requestId);
   if(this.data.requests[0]!==r)fail('OPEN_FIFO','Only the head request can be opened.');
   if(!['fresh','retry'].includes(payload.mode)||r.requiresUserAction&&payload.mode!=='retry')fail('OPEN_RETRY_REQUIRED','User must explicitly retry this request.');
   const p={requestId:r.requestId,attemptId:randomUUID(),claimToken:randomUUID(),owner:{...owner},binding:null,read:null};this.lease=p;
   try{
    p.binding=r.binding?await revalidateExternalOpen(this.host,r.binding,{acceptCurrentFile:payload.mode==='retry'}):await bindExternalOpen(this.host,r.absolutePath);
    this._owner(owner);const next=copy(this.data),claimed=next.requests.find(x=>x.requestId===r.requestId);claimed.binding=p.binding;claimed.state='claimed';claimed.lastError=null;claimed.requiresUserAction=true;
    await this._commit(next,{guard:()=>this._active(p)});this._owner(owner);return this._publicClaim(p);
   }catch(error){
    if(this.paused||this.frozen)throw error;
    this.lease=null;await this._block(r.requestId,error);throw error;
   }
  });
 }
 async readClaimedOpen(owner,payload){
  this._payload(payload,['requestId','attemptId','claimToken','generation']);
  return this._run(async()=>{
   this._healthy();const p=this._claim(owner,payload);
   try{
    await revalidateExternalOpen(this.host,p.binding);this._claim(owner,payload);
    const file=p.binding.kind==='file'?await this.host.readFile(p.binding.projectId,p.binding.relPath):null;
    this._claim(owner,payload);await revalidateExternalOpen(this.host,p.binding);this._claim(owner,payload);
    if(file&&(!file.diskPresent||file.draftError||file.kind==='unsupported'||file.kind==='legacy-word'))fail('OPEN_NOT_DISPLAYABLE','A missing source, unreadable draft or unsupported format is not an opened source.');
    p.read={readReceipt:randomUUID(),projectId:p.binding.projectId,relPath:p.binding.relPath,digest:file?.digest??null,materialDigest:file?.materialDigest??null,draftDigest:file?.draft?digest(file.draft.text):null};
    const project=p.binding.kind==='directory'?this.host.publicProject(await this.host.requireProject(p.binding.projectId)):null;this._claim(owner,payload);
    return {file,project,...copy(p.read)};
   }catch(error){if(!this.paused&&!this.frozen){this.lease=null;await this._block(p.requestId,error);}throw error;}
  });
 }
 async resolveOpen(owner,payload){
  this._payload(payload,['requestId','attemptId','claimToken','generation','outcome','readReceipt','display','error']);
  return this._run(async()=>{
   this._healthy();this._owner(owner);const resultHash=digest(stable({outcome:payload.outcome,readReceipt:payload.readReceipt??null,display:payload.display??null,error:payload.error?errorRecord(payload.error):null}));
   const prior=this.terminals.get(payload.attemptId),disk=this.data.receipts.find(r=>r.attemptId===payload.attemptId);
   if(prior||disk){
    const receipt=prior?.receipt||disk;
    if(prior?.receipt.outcome==='opened'&&!disk)fail('ACK_EXPIRED','Terminal receipt aged out.');
    if(!prior||!this._sameOwner(prior.owner,owner)||receipt.bootId!==this.bootId||receipt.generation!==owner.generation||receipt.requestId!==payload.requestId||receipt.tokenHash!==digest(payload.claimToken||'')||receipt.resultHash!==resultHash||payload.generation!==owner.generation)fail('STALE_OPEN','Terminal receipt belongs to another attempt or result.');
    if(this.lease?.attemptId===payload.attemptId)this.lease=null;
    return {accepted:true,durable:true,requestId:payload.requestId,outcome:receipt.outcome,duplicate:true};
   }
   if(!this.data.requests.some(r=>r.requestId===payload.requestId))fail('ACK_EXPIRED','Request and terminal receipt aged out.');
   const p=this._claim(owner,payload);
   if(!['opened','deferred'].includes(payload.outcome))fail('OPEN_INVALID','Unknown opening outcome.');
   if(payload.outcome==='opened'){
    const d=payload.display;
    if(!p.read||payload.readReceipt!==p.read.readReceipt||!fields(d,['opened','surfaceReady','surfaceEpoch','projectId','relPath','display','digest','materialDigest','draftDigest'])||d.opened!==true||d.surfaceReady!==true||!integer(d.surfaceEpoch)||!['source','draft','directory','already-open'].includes(d.display)||['projectId','relPath','digest','materialDigest','draftDigest'].some(k=>d[k]!==p.read[k])||p.binding.kind==='directory'&&d.display!=='directory'||p.binding.kind==='file'&&d.display==='directory'||d.display==='draft'&&!p.read.draftDigest)fail('OPEN_UNCONFIRMED','Actual display result/read receipt is required.');
    await revalidateExternalOpen(this.host,p.binding);this._claim(owner,payload);
    if(p.binding.kind==='file'){
     const bytes=await this.host.readSource(p.binding.canonicalTarget);this._claim(owner,payload);
     if(digest(bytes)!==p.read.digest)fail('OPEN_TARGET_CHANGED','Source version changed after reading.');
     const draft=await this.host.readDraftRecord(p.binding.projectId,p.binding.relPath);this._claim(owner,payload);
     if((draft&&draft.status!=='saved'?digest(draft.text):null)!==p.read.draftDigest)fail('OPEN_TARGET_CHANGED','Retained draft changed after reading.');
    }
    await revalidateExternalOpen(this.host,p.binding);this._claim(owner,payload);
   }else if(!payload.error||typeof payload.error.code!=='string'||typeof payload.error.message!=='string')fail('OPEN_INVALID','Deferred opening needs a concrete error.');
   const receipt={requestId:p.requestId,attemptId:p.attemptId,bootId:this.bootId,generation:owner.generation,tokenHash:digest(p.claimToken),readReceipt:payload.readReceipt??null,resultHash,outcome:payload.outcome,at:Date.now()};
   const next=copy(this.data);
   if(payload.outcome==='opened'){
    next.requests=next.requests.filter(r=>r.requestId!==p.requestId);next.receipts.push(receipt);next.receipts=next.receipts.slice(-this.limits.receipts);
   }else{const r=next.requests.find(r=>r.requestId===p.requestId);r.state='blocked';r.requiresUserAction=true;r.lastError=errorRecord(payload.error);}
   // Retain exact attempt in memory even if the durable write fails. Recovery
   // confirms this result; it must not read/render the document a second time.
   this._remember(p.attemptId,{receipt,owner:{...owner}});
   try{await this._commit(next,{guard:()=>this._active(p)});}catch(error){if(!this.paused&&!this.frozen)this.terminals.delete(p.attemptId);throw error;}
   this.lease=null;this._owner(owner);
   return {accepted:true,durable:true,requestId:p.requestId,outcome:payload.outcome,duplicate:false};
  });
 }
 async removeOpen(owner,payload){
  this._payload(payload,['requestId','expectedRevision','confirmed']);
  return this._run(async()=>{
   this._healthy();this._owner(owner);this._revision(payload.expectedRevision);
   if(payload.confirmed!==true)fail('OPEN_CONFIRM_REQUIRED','Explicit request-removal confirmation required.');
   if(this.lease?.requestId===payload.requestId)fail('OPEN_BUSY','Defer the active claim before removing it.');
   this._request(payload.requestId);const next=copy(this.data);next.requests=next.requests.filter(r=>r.requestId!==payload.requestId);
   next.receipts.push({requestId:payload.requestId,attemptId:randomUUID(),bootId:this.bootId,generation:owner.generation,tokenHash:digest('removed'),readReceipt:null,resultHash:digest('removed'),outcome:'removed',at:Date.now()});next.receipts=next.receipts.slice(-this.limits.receipts);
   await this._commit(next);return {accepted:true,durable:true,requestId:payload.requestId,outcome:'removed'};
  });
 }
 invalidateOwner(owner){
  if(!owner||!owner.webContents||typeof owner.webContents!=='object'||!integer(owner.generation))fail('OPEN_INVALID','Invalid main owner.');
  if(owner.bootId!==this.bootId)fail('STALE_OPEN','Owner belongs to another main boot.');
  this.revoked.set(owner.webContents,Math.max(this.revoked.get(owner.webContents)??-1,owner.generation));
  return this._run(async()=>{
   this._healthy();const p=this.lease;if(p&&this._sameOwner(p.owner,owner)){this.lease=null;await this._block(p.requestId,{code:'OPEN_INTERRUPTED',message:'Renderer owner changed; explicitly retry.'});}
  });
 }
}
