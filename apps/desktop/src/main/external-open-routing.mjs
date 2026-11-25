import {randomUUID,createHash} from 'node:crypto';
import {ExternalOpenQueue} from './external-open-queue.mjs';
import {findView} from '../domain/workspace-layout.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code});
const errorRecord=error=>({code:String(error?.code||'OPEN_FAILED').slice(0,64),message:String(error?.message||error).slice(0,512)});
const hash=value=>createHash('sha256').update(value).digest('hex');
const strict=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail('OPEN_INVALID','外部打开请求格式无效。');};
const claimPayload=claim=>Object.fromEntries(['requestId','attemptId','claimToken','generation'].map(key=>[key,claim[key]]));

// Main owns admission, queue leases and display challenges. Renderer payloads
// can request work, but never choose an owner or assert a terminal receipt.
export class ExternalOpenRouting {
 constructor({host,workspace,queue=new ExternalOpenQueue({host}),notify=()=>{},displayTimeout=15000}){
  Object.assign(this,{host,workspace,queue,notify,displayTimeout});
  this.admissions=new Map();this.refused=0;this.admissionChain=Promise.resolve();
  this.operations=Promise.resolve();this.observed=new WeakSet();this.challenges=new Map();this.transaction=null;
 }
 _serial(fn){const task=this.operations.then(fn);this.operations=task.catch(()=>{});return task;}
 _signal(){try{this.notify();}catch{/* A closed renderer cannot discard durable requests. */}}
 _owner(scope){
  if(scope?.role!=='shell'||scope.dead||this.workspace.shell!==scope||this.workspace.senders.get(scope.wc.id)!==scope)throw fail('IPC_DENIED','外部打开仅允许当前主窗口操作。');
  return {window:scope.win,webContents:scope.wc,generation:scope.generation,bootId:this.queue.bootId};
 }
 observe(scope){
  if(this.observed.has(scope))return;this.observed.add(scope);let generation=scope.generation;
  const invalidate=()=>{
   const owner={window:scope.win,webContents:scope.wc,generation,bootId:this.queue.bootId};generation=scope.generation;
  for(const [id,pending] of this.challenges)if(pending.record===scope||pending.ownerScope===scope){this.challenges.delete(id);pending.reject(fail('OPEN_INTERRUPTED','原显示窗口已重载或关闭。'));}
   if(scope.role==='shell'){
    if(this.transaction?.owner.webContents===scope.wc)this.transaction=null;
    void this.queue.invalidateOwner(owner).catch(()=>{}).finally(()=>this._signal());
   }
  };
  // WorkspaceNative registered its generation listeners before these.
  scope.wc.on('did-start-navigation',(_event,_url,_inPlace,main)=>{if(main)invalidate();});
  scope.wc.on('render-process-gone',invalidate);scope.wc.once('destroyed',invalidate);
 }
 admit(paths,source){
  for(const absolutePath of paths){
   if(this.admissions.size>=128){this.refused++;continue;}
   const requestId=randomUUID();this.admissions.set(requestId,{requestId,absolutePath,source,error:null});
  }
  const task=this.admissionChain.then(()=>this._admitPending());this.admissionChain=task.catch(()=>{});return task;
 }
 async _admitPending(){
  for(const [id,row] of this.admissions){
   // An unresolved earlier admission keeps FIFO; retries are explicit.
   if(row.error)break;
   try{await this.queue.enqueue({requestId:id,absolutePath:row.absolutePath,source:row.source});this.admissions.delete(id);}
   catch(error){row.error=errorRecord(error);break;}
  }
  this._signal();
 }
 async status(scope){
  this._owner(scope);await this.admissionChain;const status=await this.queue.openQueue();
  return {...status,unaccepted:[...this.admissions.values()].map(row=>({...row})),refused:this.refused,
   terminalPending:Boolean(this.transaction?.terminal)};
 }
 async invoke(scope,op,payload={}){
  if(op==='workspace.externalDisplayed')return this.displayed(scope,payload);
  this._owner(scope);
  if(op==='session.external.status'){strict(payload,[]);return this.status(scope);}
  return this._serial(async()=>{
   const owner=this._owner(scope);
   if(op==='session.external.retryPersistence'){
    strict(payload,[]);await this.admissionChain;await this.queue.openQueue({retryPersistence:true});
    const transaction=this.transaction;
    if(transaction?.terminal){await this.queue.resolveOpen(owner,transaction.terminal);this.transaction=null;}
    this._signal();return this.status(scope);
   }
   if(op==='session.external.retryAdmissions'){
    strict(payload,[]);await this.admissionChain;
    for(const row of this.admissions.values())row.error=null;
    this.admissionChain=this._admitPending();await this.admissionChain;return this.status(scope);
   }
   if(op==='session.external.remove'){
    strict(payload,['requestId','expectedRevision','confirmed']);
    const result=await this.queue.removeOpen(owner,payload);this._signal();return result;
   }
   if(op==='session.external.begin'){
    strict(payload,['requestId','expectedRevision','mode']);
    if(this.transaction?.terminal)throw fail('OPEN_PERSISTENCE_UNCONFIRMED','请先确认上一结果的持久保存。');
    const claim=await this.queue.claimOpen(owner,payload);
    const read=this.transaction?.claim.attemptId===claim.attemptId?this.transaction.read:await this.queue.readClaimedOpen(owner,claimPayload(claim));
    this._ownerCurrent(scope,owner);
    this.transaction={scope,owner,claim,read,terminal:null};
    return {...claimPayload(claim),projectId:read.projectId,relPath:read.relPath};
   }
   if(op==='session.external.confirm'||op==='session.external.defer'){
    strict(payload,op.endsWith('defer')?['requestId','attemptId','claimToken','generation','error']:['requestId','attemptId','claimToken','generation']);
    const transaction=this._transaction(scope,payload);
    if(transaction.terminal)throw fail('OPEN_PERSISTENCE_UNCONFIRMED','显示结果已生成，请显式重试保存结果。');
    if(op.endsWith('defer'))return this._settle(transaction,{outcome:'deferred',error:errorRecord(payload.error||fail('OPEN_DEFERRED','打开尚未完成。'))});
    try{
     const display=await this._display(transaction);this._ownerCurrent(scope,owner);
     return await this._settle(transaction,{outcome:'opened',readReceipt:transaction.read.readReceipt,display});
    }catch(error){
     // A terminal persistence uncertainty already retains the exact result;
     // never replace it with a second read, rendering or deferred result.
     if(transaction.terminal||error.code==='STALE_OPEN')throw error;
     await this._settle(transaction,{outcome:'deferred',error:errorRecord(error)});throw error;
    }
   }
   throw fail('UNKNOWN_OP','未知外部打开操作。');
  });
 }
 _ownerCurrent(scope,owner){const now=this._owner(scope);if(now.generation!==owner.generation)throw fail('STALE_OPEN','原主窗口已重载。');}
 _transaction(scope,payload){
  const t=this.transaction;this._ownerCurrent(scope,t?.owner||{generation:-1});
  if(!t||t.scope!==scope||['requestId','attemptId','claimToken','generation'].some(key=>payload[key]!==t.claim[key]))throw fail('STALE_OPEN','打开回执不属于原请求。');return t;
 }
 async _settle(t,result){
  const payload={...claimPayload(t.claim),...result};t.terminal=payload;
  try{const value=await this.queue.resolveOpen(t.owner,payload);this.transaction=null;this._signal();return value;}
  catch(error){if(!this.queue.paused&&!this.queue.frozen)t.terminal=null;this._signal();throw error;}
 }
 async _visible(record,read){
  if(!record||record.dead||this.workspace.senders.get(record.wc.id)!==record||!record.ready||record.contentFailed||record.transferring||record.projectId!==read.projectId||record.win.isDestroyed()||!record.win.isVisible()||record.win.isMinimized())throw fail('OPEN_UNCONFIRMED','目标窗口尚未显示或已变化。');
  if(read.relPath===null){if(record!==this.workspace.shell)throw fail('OPEN_UNCONFIRMED','原项目导航尚未显示。');return;}
  if(record.role!=='surface'||record.kind!=='document'||record.relPath!==read.relPath||record.readOnly||record.documentSource&&record.documentSource.type!=='project'||!record.view?.getVisible())throw fail('OPEN_UNCONFIRMED','原文件的可编辑文档面尚未显示。');
  const found=findView(await this.workspace.layout(read.projectId),record.viewId);
  if(!found||found.windowId!==record.windowId||found.group.activeViewId!==record.viewId)throw fail('OPEN_UNCONFIRMED','目标文件不是当前分区的活动文档。');
 }
 async _display(t){
  const read=t.read,deadline=Date.now()+this.displayTimeout;
  let record;
  // Opening creates a native surface before its renderer is ready. Wait for
  // real readiness/geometry, bounded by this presentation attempt only.
  for(;;){
   this._ownerCurrent(t.scope,t.owner);
   if(t.scope.projectId!==read.projectId)throw fail('OPEN_UNCONFIRMED','原项目尚未在导航窗口激活。');
   const candidates=read.relPath===null?[t.scope]:[...this.workspace.surfaces.values()].filter(row=>row.projectId===read.projectId&&row.relPath===read.relPath&&!row.readOnly&&(!row.documentSource||row.documentSource.type==='project')&&!row.dead);
   let error=fail('OPEN_UNCONFIRMED','原文件尚未显示。');record=null;
   for(const candidate of candidates){try{await this._visible(candidate,read);record=candidate;break;}catch(reason){error=reason;}}
   if(record)break;
   if(candidates.length&&candidates.every(row=>row.contentFailed)||Date.now()>=deadline)throw error;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  this.observe(record);const generation=record.generation,requestId=randomUUID();
  const snapshot=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.challenges.delete(requestId);reject(fail('OPEN_DISPLAY_TIMEOUT','实际文档未确认显示，请显式重试。'));},this.displayTimeout);
   this.challenges.set(requestId,{record,generation,ownerScope:t.scope,resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
   try{record.wc.send('nozeli:workspace-control',{type:'external-open-display',requestId,projectId:read.projectId,relPath:read.relPath});}
   catch(error){const pending=this.challenges.get(requestId);this.challenges.delete(requestId);pending.reject(error);}
  });
  this._ownerCurrent(t.scope,t.owner);await this._visible(record,read);
  if(t.scope.projectId!==read.projectId)throw fail('OPEN_UNCONFIRMED','确认期间项目已切换。');
  if(record.generation!==generation||snapshot.projectId!==read.projectId||snapshot.relPath!==read.relPath||snapshot.ready!==true)throw fail('OPEN_UNCONFIRMED','实际显示身份与原读取不一致。');
  if(read.relPath!==null){
   if(snapshot.digest!==read.digest||snapshot.materialDigest!==read.materialDigest||snapshot.draftDigest!==read.draftDigest||snapshot.kind!==read.file.kind)throw fail('OPEN_TARGET_CHANGED','实际显示的版本与原读取不一致。');
   if(read.file.kind==='text'&&snapshot.textDigest!==hash(read.file.draft?.text??read.file.text))throw fail('OPEN_DISPLAY_CHANGED','编辑器当前正文与读取正文不一致，已保留编辑。');
   if(read.file.kind!=='text'&&snapshot.dirty)throw fail('OPEN_DISPLAY_CHANGED','文档存在未确认的模型编辑，已保留原窗口。');
  }
  return {opened:true,surfaceReady:true,surfaceEpoch:generation,projectId:read.projectId,relPath:read.relPath,
   digest:read.digest,materialDigest:read.materialDigest,draftDigest:read.draftDigest,
   display:read.relPath===null?'directory':read.draftDigest?'draft':'source'};
 }
 displayed(scope,payload){
  strict(payload,['requestId','ok','snapshot','error']);const pending=this.challenges.get(payload.requestId);
  if(!pending||pending.record!==scope||scope.dead||pending.generation!==scope.generation||this.workspace.senders.get(scope.wc.id)!==scope)throw fail('OPEN_DISPLAY_DENIED','显示确认不属于原文档窗口或已过期。');
  if(typeof payload.ok!=='boolean'||Buffer.byteLength(JSON.stringify(payload))>4096)throw fail('OPEN_INVALID','显示确认无效。');
  this.challenges.delete(payload.requestId);
  if(payload.ok)pending.resolve(payload.snapshot??{});else pending.reject(fail(payload.error?.code||'OPEN_UNCONFIRMED',String(payload.error?.message||'文档未能显示。').slice(0,512)));
  return {accepted:true};
 }
 async settled(){await this.admissionChain;await this.operations;await this.queue.chain;}
}
