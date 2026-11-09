import {exportTimelineOriginal} from './timeline-export.mjs';
import {isDeepStrictEqual} from 'node:util';

// Discard uses its existing disposition/end protocol, not review.decide accept.
// Both preparation and submission save every associated document and child
// discussion before reading the binding that the user is asked to confirm.
export async function runReviewDiscard({workspace,managed,scope,payload,prepare=false}){
 const {projectId,workId,objectId,revision,binding,requestKey}=payload;
 if(scope.role!=='surface'||scope.kind!=='report'||scope.projectId!==projectId||!workspace.reviewReportOwns(scope,objectId))throw denied();
 if(!prepare&&(!binding||typeof binding!=='object'||typeof requestKey!=='string'||!requestKey))throw Object.assign(Error('放弃确认身份无效。'),{code:'INVALID_PAYLOAD'});
 const end=()=>managed.invoke('managed.end',{projectId,workId,binding,requestKey,revision:binding.revision,decision:'discard'});
 let controller=null;
 async function recorded(){
  if(prepare)return false;
  controller??=managed.controllers.get(projectId)??await managed.loadLocal(projectId,workId);
  const work=controller.store.find(workId),closure=work.closure;
  if(!['closing','ended'].includes(work.status)||!work.outcome&&!closure?.decision)return false;
  if(work.outcome!=='discard'||closure?.decision!=='discard'||closure.requestKey!==requestKey||!isDeepStrictEqual(closure.binding,binding))throw Object.assign(Error('已登记决定与此放弃确认身份不一致；未发起新决定。'),{code:'WORK_DISCARD_RECEIPT_MISMATCH'});
  return true;
 }
 if(await recorded())return end();
 const initial=await managed.invoke('managed.disposition',{projectId,workId});
 if(initial.binding?.objectId!==objectId||prepare&&initial.binding?.revision!==revision)throw Object.assign(Error('报告版本已变化，请重新核对后放弃。'),{code:'REVIEW_TOKEN_CHANGED'});
 const review=await managed.invoke('managed.review.read',{projectId,workId,objectId});
 return workspace.runReviewBarrier(projectId,{workId,objectId,paths:(review.files||[]).map(file=>file.relPath)},async()=>{
  const current=await managed.invoke('managed.disposition',{projectId,workId});
  if(await recorded())return end();
  if(current.binding?.objectId!==objectId||prepare&&current.binding?.revision!==revision||!prepare&&!isDeepStrictEqual(current.binding,binding))throw Object.assign(Error('保存后放弃版本已变化，请返回重新核对与确认。'),{code:'REVIEW_TOKEN_CHANGED'});
  if(!current.discard?.allowed)throw Object.assign(Error(current.discard?.message||'宿主当前不允许放弃此工作。'),{code:'WORK_DISCARD_DENIED'});
  if(prepare)return current;
  return end();
 });
}

const denied=()=>Object.assign(Error('讨论窗口不属于当前报告或操作超出讨论权限。'),{code:'REVIEW_SCOPE_DENIED'});
const childOps=new Set(['workspace.bootstrap','workspace.ready','session.flushed','managed.review.read','managed.review.instruction.read','managed.review.instruction.save','managed.review.discussion.read','managed.review.discussion.send','managed.timeline.read','workspace.displayView.read','workspace.displayView.write','workspace.reviewDiscussion.bounds','workspace.reviewDiscussion.latest']);
childOps.add('settings.appearance.read');
childOps.add('workspace.reviewDiscussion.receipt');
childOps.add('workspace.attention.presented');
childOps.add('workspace.reviewDiscussion.navigate');
childOps.add('workspace.reviewDiscussion.materialRead');
childOps.add('workspace.reviewDiscussion.processRead');
childOps.add('workspace.reviewDiscussion.exportOriginal');
childOps.add('workspace.reviewDiscussion.readingState.read');
childOps.add('workspace.reviewDiscussion.readingState.write');
const disclosureKey=id=>typeof id==='string'&&id.length>0&&id.length<=512&&!/[\x00-\x1f]/.test(id)&&!['__proto__','constructor','prototype'].includes(id);
const validReadDescriptor=read=>Boolean(read)&&typeof read==='object'&&!Array.isArray(read)&&Object.keys(read).every(key=>['version','field','offset'].includes(key))&&/^[a-f0-9]{64}$/.test(read.version)&&typeof read.field==='string'&&read.field.length>0&&read.field.length<=128&&!/[\x00-\x1f]/.test(read.field)&&Number.isSafeInteger(read.offset)&&read.offset>=0;
const validDisclosures=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=400&&Buffer.byteLength(JSON.stringify(value))<=65536&&Object.entries(value).every(([id,entry])=>disclosureKey(id)&&(entry===true||entry===false||entry&&typeof entry==='object'&&!Array.isArray(entry)&&Object.keys(entry).every(key=>['cursor','read'].includes(key))&&(entry.cursor===undefined||typeof entry.cursor==='string'&&entry.cursor.length>0&&entry.cursor.length<=512&&!/[\x00-\x1f]/.test(entry.cursor))&&(entry.read===undefined||validReadDescriptor(entry.read))));
export class NativeReviewDiscussionManager {
 constructor({workspace,BrowserWindow,preload,managed,dialog}){Object.assign(this,{workspace,BrowserWindow,preload,managed,dialog});this.rows=new Map();}
 owns(row){return row&&!row.owner.dead&&row.owner.generation===row.ownerGeneration&&!row.win.isDestroyed()&&row.record&&!row.record.dead;}
 rowForOwner(owner){return this.rows.get(owner.wc.id);}
 authorize(record,op,p){const row=record.discussionRow;if(!this.owns(row)||row.record!==record||!childOps.has(op))throw denied();
  if(op==='settings.appearance.read')return record;
  if(op.startsWith('managed.review.')){
   const receipt=op==='managed.review.discussion.send'&&row.receipts?.get(p.requestKey);
   const sameReceipt=receipt&&receipt===JSON.stringify([p.projectId,p.workId,p.objectId,p.reviewVersion,p.requestKey,p.text,p.applyDrafts===true]);
   if(p.projectId!==row.projectId||p.workId!==row.workId||(!sameReceipt&&p.objectId!==row.objectId&&p.objectId!==row.bindingObjectId))throw denied();
   if(op==='managed.review.discussion.send'&&!sameReceipt){row.receipts??=new Map();row.receipts.set(p.requestKey,JSON.stringify([p.projectId,p.workId,p.objectId,p.reviewVersion,p.requestKey,p.text,p.applyDrafts===true]));}
  }
  if(op==='managed.timeline.read'&&(p.projectId!==row.projectId||!row.originalIds?.has(p.id)))throw denied();
  if(op==='workspace.attention.presented'&&(p.projectId!==row.projectId||p.objectId!==row.objectId||!row.originalIds?.has(p.messageId)||!this.visible(row)))throw denied();
  if(op.startsWith('workspace.displayView.')){if(p.projectId!==row.projectId||p.key?.ownerKind!=='review'||p.key?.ownerId!==row.workId||p.key?.surfaceId!==row.ownerSurfaceId)throw denied();}
  if(this.workspace.lifecycle.has(row.projectId)&&['managed.review.instruction.save','workspace.displayView.write','workspace.reviewDiscussion.readingState.write'].includes(op)&&!this.workspace.lifecycleFlushOwner(record,p.flushRequestId,op,p))throw denied();
  if((record.held||row.owner.held||row.owner.transferring||row.suspended||row.readOnly||this.workspace.lifecycle.has(row.projectId))&&op==='managed.review.discussion.send')throw denied();
  return record;
 }
 capture(record,op,value){
  if(record.role!=='review-discussion'||op!=='managed.review.discussion.read')return;
  const row=record.discussionRow;
  if(!this.owns(row)||row.record!==record||value?.workId!==row.workId||![row.objectId,row.bindingObjectId].includes(value.objectId))return;
  row.publications??=new Map();
  this.captureFrame(row,value.taskFrame);
  for(const receipt of value.taskState?.receipts||[])if(receipt.workId===row.workId&&typeof receipt.objectId==='string')row.publications.set(receipt.objectId,{revision:receipt.revision,kind:receipt.kind});
 }
 // Delivered discussion/process frames grant original-field and frozen-material
 // reads for exactly the records that page actually disclosed.
 captureFrame(row,frame){
  row.originalIds??=new Set();row.materials??=new Map();
  for(const entry of frame?.entries||[])if(typeof entry.id==='string'){
   row.originalIds.add(entry.id);
   row.materials.set(entry.id,(entry.attachments||[]).map(ref=>ref?.projectId===row.projectId&&typeof ref.digest==='string'&&['project','recovery'].includes(ref.storage)?structuredClone(ref):null));
  }
 }
 // Review reading disclosures live in the existing per-instance ui.sqlite as
 // their own record; geometry displayView state and its CAS stay untouched.
 async readingStateStore(row){
  const storage=this.workspace.host.storage,project=await storage.requireRegistered(row.projectId);
  return {storage,storageKey:'reading-state:'+JSON.stringify({projectInstanceId:project.instanceId,ownerKind:'review',ownerId:row.workId,surfaceId:row.ownerSurfaceId})};
 }
 geometry(row){const parent=row.win?.getParentWindow()||row.owner.win,content=parent.getContentBounds(),view=row.owner.view?.getBounds(),zoomFactor=row.owner.wc.getZoomFactor?.()||1;const origin={x:content.x+(view?.x||0),y:content.y+(view?.y||0)};return {bounds:{x:0,y:0,width:(view?.width??content.width)/zoomFactor,height:(view?.height??content.height)/zoomFactor},origin,zoomFactor,epoch:row.epoch};}
 bootstrap(record){const row=record.discussionRow;return {role:'review-discussion',kind:'review-discussion',projectId:row.projectId,workId:row.workId,objectId:row.objectId,workName:row.workName,ownerSurfaceId:row.ownerSurfaceId,generation:record.generation,readOnly:row.readOnly,geometry:this.geometry(row)};}
 visible(row){const p=row.win.getParentWindow()||row.owner.win;return this.owns(row)&&row.requested&&!row.suspended&&!row.owner.transferring&&!row.owner.held&&!p.isMinimized()&&p.isVisible()&&(!row.owner.view||row.owner.view.getVisible())&&(p.isFocused()||row.win.isFocused())&&(!this.workspace.activeProjectId||this.workspace.activeProjectId===row.projectId);}
 refreshScope(owner){const row=this.rowForOwner(owner);if(!row)return;const geometry=this.geometry(row),signature=JSON.stringify([geometry.bounds,geometry.origin,geometry.zoomFactor]);if(row.record.wc.getZoomFactor()!==geometry.zoomFactor)row.record.wc.setZoomFactor(geometry.zoomFactor);if(signature!==row.geometrySignature){row.geometrySignature=signature;row.epoch++;if(row.record.ready)row.record.wc.send('nozeli:workspace-control',{type:'review-discussion-geometry',geometry:this.geometry(row)});}if(this.visible(row)){if(!row.win.isVisible())row.win.showInactive();}else row.win.hide();}
 reparentScope(owner,parent){
  const row=this.rowForOwner(owner);if(!row)return;
  const old=row.win.getParentWindow(),oldWindowId=row.record.windowId;
  const destination=[...this.workspace.windows.values()].find(root=>root.win===parent&&!root.dead);
  if(!destination)throw denied();
  try{
   row.win.hide();row.win.setParentWindow(parent);
   if(row.win.getParentWindow()!==parent)throw Error('讨论父窗口迁移未确认');
   this.listenParent(row,parent);row.record.windowId=destination.windowId;row.epoch++;row.geometrySignature=null;
  }catch(error){row.win.setParentWindow(old);row.record.windowId=oldWindowId;this.listenParent(row,old);throw error;}
 }
 listenParent(row,parent){row.parentCleanup?.();const update=()=>this.refreshScope(row.owner),blur=()=>{clearTimeout(row.deactivateTimer);row.deactivateTimer=setTimeout(update,0);},zoom=()=>{clearImmediate(row.zoomRefresh);row.zoomRefresh=setImmediate(update);};for(const name of ['move','resize','show','hide','minimize','restore','focus'])parent.on(name,update);parent.on('blur',blur);row.owner.wc.on('zoom-changed',zoom);row.parentCleanup=()=>{clearTimeout(row.deactivateTimer);clearImmediate(row.zoomRefresh);row.owner.wc.removeListener('zoom-changed',zoom);for(const name of ['move','resize','show','hide','minimize','restore','focus'])parent.removeListener(name,update);parent.removeListener('blur',blur);};}
 async create(owner,p){const w=this.workspace,report=w.layouts.get(owner.projectId)?.views[owner.viewId]?.viewState?.report;
  if(owner.role!=='surface'||!['report','history'].includes(owner.kind)||p.projectId!==owner.projectId||!w.reviewReportOwns(owner,p.objectId))throw denied();
  if(report?.workId!==p.workId){const review=await this.managed.invoke('managed.review.read',{projectId:owner.projectId,workId:p.workId,objectId:p.objectId});if(review.workId!==p.workId||review.objectId!==p.objectId)throw denied();}
  const row={owner,ownerGeneration:owner.generation,projectId:owner.projectId,workId:p.workId,objectId:p.objectId,workName:String(p.workName||'审核讨论'),ownerSurfaceId:owner.viewId,epoch:1,requested:false,sequence:0,readOnly:owner.kind==='history'};
  const geometry=this.geometry(row);row.geometrySignature=JSON.stringify([geometry.bounds,geometry.origin,geometry.zoomFactor]);
  const win=new this.BrowserWindow({parent:owner.win,modal:false,type:'utility',show:false,skipTaskbar:true,frame:false,resizable:false,movable:false,minimizable:false,maximizable:false,fullscreenable:false,webPreferences:{preload:this.preload,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
  row.win=win;row.record=w.register(win.webContents,{role:'review-discussion',kind:'review-discussion',projectId:owner.projectId,windowId:owner.windowId,win,discussionRow:row});this.rows.set(owner.wc.id,row);this.listenParent(row,owner.win);
  win.webContents.setZoomFactor(geometry.zoomFactor);
  win.webContents.on('zoom-changed',()=>{clearImmediate(row.zoomRefresh);row.zoomRefresh=setImmediate(()=>this.refreshScope(owner));});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event,url)=>{if(url!==w.origin)event.preventDefault();});
  win.on('close',event=>{event.preventDefault();void this.command(row,'hide').catch(w.onError);});win.on('focus',()=>{clearTimeout(row.deactivateTimer);this.refreshScope(owner);});win.on('blur',()=>{clearTimeout(row.deactivateTimer);row.deactivateTimer=setTimeout(()=>this.refreshScope(owner),0);});win.on('closed',()=>{row.parentCleanup?.();if(this.rows.get(owner.wc.id)===row)this.rows.delete(owner.wc.id);});
  try{await win.loadURL(w.origin);await new Promise((resolve,reject)=>{if(row.record.ready)return resolve();const timer=setTimeout(()=>{win.webContents.removeListener('nozeli-content-ready',ready);reject(Error('讨论页面尚未准备好'));},10000);const ready=()=>{clearTimeout(timer);resolve();};win.webContents.once('nozeli-content-ready',ready);});return row;}catch(error){row.requested=false;win.hide();if(!row.record.ready)this.closeScope(owner);throw error;}
 }
 async command(row,action,objectId){await this.workspace.flushOne(row.record,'nozeli:review-discussion-command',{action,objectId});if(action==='hide'){row.requested=false;row.win.hide();if(!row.owner.dead)row.owner.wc.focus();}return {ok:true};}
 async invoke(owner,op,p){const action=op.slice('workspace.reviewDiscussion.'.length);
  if(owner.role==='review-discussion'&&action==='receipt'){const row=owner.discussionRow;if(!this.owns(row)||p.projectId!==row.projectId||p.workId!==row.workId)throw denied();const receipt=await this.managed.reviewDiscussionReceipt(p);if(!receipt)throw Object.assign(Error('原报告未记录此发送；请核对最新报告后再发送。'),{code:'REVIEW_CANDIDATE_STALE'});return receipt;}
  if(owner.role==='review-discussion'&&action==='latest'){const row=owner.discussionRow;if(!this.owns(row))throw denied();await this.workspace.flushOne(owner);row.owner.wc.send('nozeli:workspace-control',{type:'review-discussion-latest',projectId:row.projectId,workId:row.workId});return {requested:true};}
  if(owner.role==='review-discussion'&&action==='materialRead'){
   const row=owner.discussionRow;
   if(!this.owns(row)||row.record!==owner||p.projectId!==row.projectId||p.workId!==row.workId||Object.keys(p).some(key=>!['projectId','workId','messageId','index'].includes(key))||!Number.isSafeInteger(p.index)||p.index<0)throw denied();
   const ref=row.materials?.get(p.messageId)?.[p.index];
   if(!ref)throw denied();
   const result=await this.workspace.host.readMaterialAttachment(ref);
   if(!this.owns(row)||row.record!==owner)throw denied();
   return result;
  }
  if(owner.role==='review-discussion'&&action==='processRead'){
   const row=owner.discussionRow;
   if(!this.owns(row)||row.record!==owner||p.projectId!==row.projectId||p.workId!==row.workId||Object.keys(p).some(key=>!['projectId','workId','cursor','limit','messageId'].includes(key))||p.cursor!==undefined&&p.cursor!==null&&(typeof p.cursor!=='string'||p.cursor.length>512)||p.limit!==undefined&&p.limit!==null&&(!Number.isSafeInteger(p.limit)||p.limit<1||p.limit>100))throw denied();
   const {index,scope}=await this.workspace.taskSource(row.projectId,{workId:row.workId});
   const location=p.messageId===undefined?null:this.workspace.taskLocateCursor(index,scope,p.messageId);
   const frame=await index.page({cursor:location?location.cursor:p.cursor??null,limit:p.limit??50,workId:row.workId});
   if(!this.owns(row)||row.record!==owner)throw denied();
   this.captureFrame(row,frame);
   return {frame,taskScope:{workId:row.workId,sourceJobId:null},...(location?{location}:{})};
  }
  if(owner.role==='review-discussion'&&action==='exportOriginal'){
   const row=owner.discussionRow;
   if(!this.owns(row)||row.record!==owner||p.projectId!==row.projectId||p.workId!==row.workId||Object.keys(p).some(key=>!['projectId','workId','id','version'].includes(key))||typeof p.id!=='string'||!p.id||p.id.length>512||typeof p.version!=='string'||!/^[a-f0-9]{64}$/.test(p.version)||!row.originalIds?.has(p.id))throw denied();
   const {index,scope}=await this.workspace.taskSource(row.projectId,{workId:row.workId});
   const entry=index.records().find(record=>record.id===p.id);
   if(!entry||!scope.matches(entry)||entry.objectId!==p.version)throw Object.assign(Error('原生历史版本已变化；请重新读取后再导出。'),{code:'TIMELINE_VERSION'});
   if(!this.owns(row)||row.record!==owner)throw denied();
   return exportTimelineOriginal({managed:this.managed,dialog:this.dialog,scope:owner,projectId:row.projectId,id:p.id,version:p.version});
  }
  if(owner.role==='review-discussion'&&(action==='readingState.read'||action==='readingState.write')){
   const row=owner.discussionRow;
   if(!this.owns(row)||row.record!==owner||p.projectId!==row.projectId||p.workId!==row.workId)throw denied();
   const {storage,storageKey}=await this.readingStateStore(row);
   if(action==='readingState.read'){
    if(Object.keys(p).some(key=>!['projectId','workId'].includes(key)))throw denied();
    const stored=await storage.getLocal(row.projectId,storageKey);
    if(!this.owns(row)||row.record!==owner)throw denied();
    return {state:stored?.state??null};
   }
   if(Object.keys(p).some(key=>!['projectId','workId','expectedRevision','disclosures','flushRequestId'].includes(key))||!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<0||!validDisclosures(p.disclosures))throw Object.assign(Error('披露状态无效。'),{code:'INVALID_PAYLOAD'});
   this.readingStateWrites??=new Map();
   const previous=this.readingStateWrites.get(storageKey)??Promise.resolve();
   const flight=previous.catch(()=>{}).then(async()=>{
    if(!this.owns(row)||row.record!==owner)throw denied();
    const stored=await storage.getLocal(row.projectId,storageKey),current=stored?.state??null;
    if(current&&(current.schema!==1||!Number.isSafeInteger(current.revision)||current.revision<0||!validDisclosures(current.disclosures)))throw Object.assign(Error('阅读状态记录版本未知或损坏，原记录已保留。'),{code:'DISPLAY_SCHEMA_UNKNOWN'});
    if((current?.revision??0)!==p.expectedRevision)return {conflict:true,current};
    const state={schema:1,revision:p.expectedRevision+1,disclosures:p.disclosures};
    if(!this.owns(row)||row.record!==owner)throw denied();
    await storage.putLocal(row.projectId,storageKey,{state});
    return {revision:state.revision};
   });
   this.readingStateWrites.set(storageKey,flight);
   try{return await flight;}finally{if(this.readingStateWrites.get(storageKey)===flight)this.readingStateWrites.delete(storageKey);}
  }
  if(owner.role==='review-discussion'&&action==='navigate'){
   const row=owner.discussionRow;
   if(!this.owns(row)||row.record!==owner||p.projectId!==row.projectId||p.workId!==row.workId||p.kind!=='report'||Object.keys(p).some(key=>!['projectId','workId','kind','objectId'].includes(key)))throw denied();
   await this.workspace.flushOne(owner);
   if(!this.owns(row)||row.record!==owner)throw denied();
   const root=this.workspace.windows.get(row.owner.windowId)??this.workspace.shell;
   if(!root||root.dead||root.projectId!==row.projectId)throw denied();
   const publication=row.publications?.get(p.objectId);
   if(!publication||!['result','problem'].includes(publication.kind))throw denied();
   const report={id:'history:'+p.objectId,objectId:p.objectId,projectId:row.projectId,workId:row.workId,revision:publication.revision,kind:publication.kind,workName:row.workName,history:true};
   const control={type:'report',projectId:row.projectId,report};
   if(root.ready)root.wc.send('nozeli:workspace-control',control);else(root.pendingControls??=[]).push(control);
   root.win.show();root.win.focus();return {routed:true,objectId:p.objectId};
  }
  if(owner.role==='review-discussion'){
   const row=owner.discussionRow;
   if(action!=='bounds'||!this.owns(row)||p.generation!==owner.generation)throw denied();
   this.refreshScope(row.owner);
   if(p.epoch!==row.epoch)return {stale:true,geometry:this.geometry(row)};
   if(!Number.isSafeInteger(p.sequence)||p.sequence<=row.sequence)return {stale:true};
   const r=p.rect,frame=this.geometry(row),b={x:frame.origin.x,y:frame.origin.y,width:frame.bounds.width*frame.zoomFactor,height:frame.bounds.height*frame.zoomFactor};
   if(!r||!['x','y','width','height'].every(k=>Number.isFinite(r[k]))||r.width<1||r.height<1||r.x<b.x-1||r.y<b.y-1||r.x+r.width>b.x+b.width+1||r.y+r.height>b.y+b.height+1)throw denied();
   row.sequence=p.sequence;
   const rect=Object.fromEntries(Object.entries(r).map(([k,v])=>[k,Math.round(v)])),signature=JSON.stringify(rect);
   if(signature!==row.appliedGeometry){row.win.setContentBounds(rect);row.appliedGeometry=signature;}
   if(!p.visible){row.requested=false;row.win.hide();if(!row.owner.dead)row.owner.wc.focus();}else this.refreshScope(row.owner);
   return {sequence:p.sequence,contentBounds:row.win.getContentBounds()};
  }
  if(!['show','hide','flush','bind','release','modal','refresh'].includes(action))throw denied();let row=this.rowForOwner(owner);
  if(row&&(row.workId!==p.workId||row.projectId!==p.projectId||row.objectId!==p.objectId))throw denied();
  if(!row){if(action!=='show')return {absent:true};row=await this.create(owner,p);}
  if(!this.owns(row))throw denied();
  if(action==='refresh'){this.refreshScope(owner);return {geometry:this.geometry(row)};}
  if(action==='modal'){row.suspended=p.held===true;row.record.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:row.suspended});this.refreshScope(owner);return {held:row.suspended};}
  if(action==='flush'){await this.workspace.flushOne(row.record);return {saved:true};}
  if(action==='release'){await this.workspace.flushOne(row.record);this.closeScope(owner);return {released:true};}
  if(action==='show'){await this.command(row,'show');row.requested=true;this.refreshScope(owner);if(this.visible(row))row.win.focus();return {shown:row.win.isVisible()};}
  if(action==='hide')return this.command(row,'hide');
  if(action==='bind'){if(!this.workspace.reviewReportOwns(owner,p.nextObjectId))throw denied();await this.workspace.flushOne(row.record);row.bindingObjectId=p.nextObjectId;try{await this.command(row,'bind',p.nextObjectId);row.objectId=p.nextObjectId;}finally{row.bindingObjectId=null;}return {bound:true};}
 }
 closeScope(owner){const row=this.rowForOwner(owner);if(!row)return;row.parentCleanup?.();this.rows.delete(owner.wc.id);row.win.destroy();}
}
