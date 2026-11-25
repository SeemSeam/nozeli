import {exportTimelineOriginal} from './timeline-export.mjs';
import {isDeepStrictEqual} from 'node:util';
import {managedWorkRecords} from '../domain/managed-work-records.mjs';

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
const modelOps=new Set(['managed.collaboration.status','managed.model.options','managed.model.set']);
for(const op of modelOps)childOps.add(op);
childOps.add('managed.skill.options');
childOps.add('workspace.attention.presented');
childOps.add('workspace.reviewDiscussion.navigate');
childOps.add('workspace.reviewDiscussion.materialRead');
childOps.add('workspace.reviewDiscussion.processRead');
childOps.add('workspace.reviewDiscussion.exportOriginal');
childOps.add('workspace.reviewDiscussion.readingState.read');
childOps.add('workspace.reviewDiscussion.readingState.write');
const workChatOps=new Set(['managed.work.chat.read','managed.work.chat.send']);
for(const op of workChatOps)childOps.add(op);
const instructionOps=new Set(['managed.review.instruction.read','managed.review.instruction.save']);
const queueOps=new Set(['managed.work.chat.retract','managed.work.chat.dispatch']);
for(const op of queueOps)childOps.add(op);
const intakeOps=new Set(['workspace.bootstrap','workspace.ready','session.flushed','settings.appearance.read','workspace.displayView.read','workspace.displayView.write','workspace.reviewDiscussion.bounds','workspace.reviewDiscussion.intakeRead','workspace.reviewDiscussion.processRead','workspace.reviewDiscussion.exportOriginal','workspace.reviewDiscussion.materialRead','workspace.reviewDiscussion.readingState.read','workspace.reviewDiscussion.readingState.write','managed.timeline.read']);
childOps.add('workspace.reviewDiscussion.intakeRead');
childOps.add('workspace.reviewDiscussion.requestHide');intakeOps.add('workspace.reviewDiscussion.requestHide');
const taskBinding=row=>row.sourceJobId?{sourceJobId:row.sourceJobId}:{workId:row.workId};
const sendOps=new Set(['managed.review.discussion.send','managed.work.chat.send',...queueOps]);
sendOps.add('managed.model.set');
const receiptKey=p=>JSON.stringify([p.projectId,p.workId,p.objectId,p.reviewVersion,p.requestKey,p.text,p.applyDrafts===true,p.lane??null,p.importedSkill??null]);
const workSurfaceId='work-discussion';
const validWorkId=id=>typeof id==='string'&&id.length>0&&id.length<=512&&!/[\x00-\x1f]/.test(id);
const disclosureKey=id=>typeof id==='string'&&id.length>0&&id.length<=512&&!/[\x00-\x1f]/.test(id)&&!['__proto__','constructor','prototype'].includes(id);
const validReadDescriptor=read=>Boolean(read)&&typeof read==='object'&&!Array.isArray(read)&&Object.keys(read).every(key=>['version','field','offset'].includes(key))&&/^[a-f0-9]{64}$/.test(read.version)&&typeof read.field==='string'&&read.field.length>0&&read.field.length<=128&&!/[\x00-\x1f]/.test(read.field)&&Number.isSafeInteger(read.offset)&&read.offset>=0;
const validDisclosures=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=400&&Buffer.byteLength(JSON.stringify(value))<=65536&&Object.entries(value).every(([id,entry])=>disclosureKey(id)&&(entry===true||entry===false||entry&&typeof entry==='object'&&!Array.isArray(entry)&&Object.keys(entry).every(key=>['cursor','read'].includes(key))&&(entry.cursor===undefined||typeof entry.cursor==='string'&&entry.cursor.length>0&&entry.cursor.length<=512&&!/[\x00-\x1f]/.test(entry.cursor))&&(entry.read===undefined||validReadDescriptor(entry.read))));
const deferred=reason=>({shown:false,deferred:true,reason});
function openingStep(from,stage,start){
 if(!from?.deadline)return start();
 from.stage=stage;
 const {signal}=from.deadline;
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>{signal.throwIfAborted();return start();}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
export class NativeReviewDiscussionManager {
 constructor({workspace,BrowserWindow,preload,managed,dialog,openTimeoutMs=15000}){Object.assign(this,{workspace,BrowserWindow,preload,managed,dialog,openTimeoutMs});this.rows=new Map();this.workRows=new Map();this.workCommands=new Map();this.presentationIntents=new Map();this.launcherMoves=new WeakMap();}
 owns(row){return row&&!row.owner.dead&&row.owner.generation===row.ownerGeneration&&!row.win.isDestroyed()&&row.record&&!row.record.dead&&(!row.workMode||row.owner.projectId===row.projectId);}
 workRowsForOwner(owner){return [...this.workRows.values()].filter(row=>row.owner===owner&&row.projectId===owner.projectId&&this.owns(row));}
 workRecords(projectId,workId){return [...this.workRows.values()].filter(row=>row.projectId===projectId&&(workId===undefined||row.workId===workId)&&this.owns(row)).map(row=>row.record);}
 workKey(projectInstanceId,workId){return JSON.stringify([projectInstanceId,workId]);}
 serialWork(key,run){const next=(this.workCommands.get(key)??Promise.resolve()).catch(()=>{}).then(run);this.workCommands.set(key,next);return next.finally(()=>{if(this.workCommands.get(key)===next)this.workCommands.delete(key);});}
 rowForOwner(owner){return this.rows.get(owner.wc.id);}
 authorize(record,op,p){const row=record.discussionRow;if(!this.owns(row)||row.record!==record||!childOps.has(op))throw denied();
  if(row.sourceJobId&&!intakeOps.has(op))throw denied();
  if(op==='settings.appearance.read')return record;
  if(op==='managed.skill.options'&&(p?.projectId!==row.projectId||p.target!==row.workId||row.readOnly||row.sourceJobId))throw denied();
  if(modelOps.has(op)){
   if(p?.projectId!==row.projectId||p.target!==row.workId||typeof row.workId!=='string'||['frontdesk','orchestrator'].includes(row.workId)||row.readOnly)throw denied();
   if(op==='managed.model.set'&&(!this.visible(row)||row.viewportOwner?.held||row.viewportOwner?.transferring||row.viewportOwner?.bindPending))throw denied();
  }
  if(workChatOps.has(op)||queueOps.has(op)){
   if(!row.workMode||p.projectId!==row.projectId||p.workId!==row.workId)throw denied();
   if(op==='managed.work.chat.send'&&row.objectId!==null)throw denied();
  }
  if(op.startsWith('managed.review.')){
   const signature=op==='managed.review.discussion.send'&&receiptKey(p);
   const sameReceipt=signature&&row.receipts?.get(p.requestKey)===signature;
   const matchesReport=typeof p.objectId==='string'&&(p.objectId===row.objectId||p.objectId===row.bindingObjectId);
   const workDraft=row.workMode&&instructionOps.has(op)&&p.objectId==null&&(row.objectId==null||row.bindingObjectId===null);
   if(p.projectId!==row.projectId||p.workId!==row.workId||(!sameReceipt&&!matchesReport&&!workDraft))throw denied();
   if(op==='managed.review.instruction.save'&&row.readOnly)throw denied();
  }
  if(op==='managed.timeline.read'&&(p.projectId!==row.projectId||!row.originalIds?.has(p.id)))throw denied();
  if(op==='workspace.attention.presented'&&(p.projectId!==row.projectId||p.objectId!==row.objectId||!row.originalIds?.has(p.messageId)||!this.visible(row)))throw denied();
  if(op.startsWith('workspace.displayView.')){if(p.projectId!==row.projectId||p.key?.ownerKind!=='review'||p.key?.ownerId!==row.workId||p.key?.surfaceId!==row.ownerSurfaceId)throw denied();}
  if(this.workspace.lifecycle.has(row.projectId)&&['managed.review.instruction.save','workspace.displayView.write','workspace.reviewDiscussion.readingState.write'].includes(op)&&!this.workspace.lifecycleFlushOwner(record,p.flushRequestId,op,p))throw denied();
  if((record.held||row.owner.held||row.owner.transferring||row.owner.bindPending||row.suspended||row.readOnly||this.workspace.lifecycle.has(row.projectId)||[...(this.workspace.reviewBarriers??[])].some(barrier=>barrier.projectId===row.projectId&&barrier.workId===row.workId)||row.switchingBinding)&&sendOps.has(op))throw denied();
  if(op==='managed.review.discussion.send'&&!row.receipts?.has(p.requestKey)){
   row.receipts??=new Map();row.receipts.set(p.requestKey,receiptKey(p));
  }
  return record;
 }
 capture(record,op,value){
  if(record.role!=='review-discussion'||!['managed.review.discussion.read','managed.work.chat.read'].includes(op))return;
  const row=record.discussionRow;
  if(!this.owns(row)||row.record!==record||value?.workId!==row.workId)return;
  if(op==='managed.review.discussion.read'&&![row.objectId,row.bindingObjectId].includes(value.objectId))return;
  if(op==='managed.work.chat.read'&&!row.workMode)return;
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
  if(row.workMode&&project.instanceId!==row.projectInstanceId)throw denied();
  const key=surfaceId=>'reading-state:'+JSON.stringify({projectInstanceId:project.instanceId,ownerKind:'review',ownerId:row.workId,surfaceId});
  return {storage,storageKey:key(row.ownerSurfaceId),legacyKey:row.legacyReadingSurfaceId?key(row.legacyReadingSurfaceId):null};
 }
 geometry(row){const viewport=row.viewportOwner??row.owner,parent=row.win?.getParentWindow()||viewport.win,content=parent.getContentBounds(),view=viewport.view?.getBounds(),zoomFactor=viewport.wc.getZoomFactor?.()||1;const origin={x:content.x+(view?.x||0),y:content.y+(view?.y||0)};return {bounds:{x:0,y:0,width:(view?.width??content.width)/zoomFactor,height:(view?.height??content.height)/zoomFactor},origin,zoomFactor,epoch:row.epoch};}
 bootstrap(record){const row=record.discussionRow;return {role:'review-discussion',kind:'review-discussion',workMode:!!row.workMode&&!row.sourceJobId,projectId:row.projectId,workId:row.workId,...(row.sourceJobId?{sourceJobId:row.sourceJobId}:{}),objectId:row.objectId,reviewVersion:row.reviewVersion??null,workName:row.workName,ownerSurfaceId:row.ownerSurfaceId,generation:record.generation,readOnly:row.readOnly,geometry:this.geometry(row)};}
 launcherVisible(owner,projectId,parent=owner.win){
  return !owner.dead&&owner.projectId===projectId&&!owner.transferring&&!owner.held&&!owner.bindPending&&!parent.isDestroyed?.()&&!parent.isMinimized()&&parent.isVisible()&&(!owner.view||owner.view.getVisible())&&(!this.workspace.activeProjectId||this.workspace.activeProjectId===projectId);
 }
 familyFocused(parent,child){return parent.isFocused()||Boolean(child?.getParentWindow()===parent&&child.isFocused());}
 eligible(row){
  if(!this.owns(row)||!row.requested||row.suspended)return false;
  const viewport=row.viewportOwner??row.owner,parent=row.win.getParentWindow()||viewport.win;
  return this.currentLauncher(row.launcher)&&row.launcher.owner===viewport&&row.launcher.objectId===row.objectId&&this.launcherVisible(viewport,row.projectId,parent);
 }
 visible(row){return this.eligible(row)&&row.win.isVisible();}
 notifyVisibility(row){
  const from=row.launcher;
  if(from?.kind!=='report')return;
  const shown=this.visible(row);
  if(from.shown===shown)return;
  from.shown=shown;
  if(!from.owner.dead&&from.owner.generation===from.generation&&from.owner.projectId===row.projectId)from.owner.wc.send('nozeli:workspace-control',{type:'review-discussion-visibility',projectId:row.projectId,workId:row.workId,objectId:from.objectId,shown});
 }
 conceal(row){if(!row.win.isDestroyed()&&row.win.isVisible?.())row.win.hide();this.notifyVisibility(row);}
 refreshRow(row){
  if(!this.owns(row)){this.conceal(row);return;}
  const geometry=this.geometry(row),signature=JSON.stringify([geometry.bounds,geometry.origin,geometry.zoomFactor]);
  if(row.record.wc.getZoomFactor()!==geometry.zoomFactor)row.record.wc.setZoomFactor(geometry.zoomFactor);
  if(signature!==row.geometrySignature){row.geometrySignature=signature;row.epoch++;if(row.record.ready)row.record.wc.send('nozeli:workspace-control',{type:'review-discussion-geometry',geometry:this.geometry(row)});}
  if(!row.activating){
   if(!this.eligible(row)||(!row.boundsVisible&&row.commandAction!=='hide'))this.conceal(row);
   else if(!row.win.isVisible()&&row.boundsVisible&&row.appliedEpoch===row.epoch)row.win.showInactive();
  }
  if(!row.activating)this.notifyVisibility(row);
 }
 refreshScope(owner){const row=this.rowForOwner(owner);if(row)this.refreshRow(row);for(const live of this.workRows.values())if(live.viewportOwner===owner)this.refreshRow(live);}
 refreshWorkWindows(){for(const row of this.workRows.values())this.refreshRow(row);}
 reparentScope(owner,parent){
  this.launcherMoves.set(owner,(this.launcherMoves.get(owner)??0)+1);
  const own=this.rowForOwner(owner);if(own){this.moveParent(own,parent);this.refreshRow(own);}
  for(const row of this.workRows.values())if((row.viewportOwner??row.owner)===owner){this.moveParent(row,parent);this.refreshRow(row);}
 }
 moveParent(row,parent){
  const old=row.win.getParentWindow(),oldWindowId=row.record.windowId;
  if(parent===old)return;
  const destination=[...this.workspace.windows.values()].find(root=>root.win===parent&&!root.dead);
  if(!destination)throw denied();
  try{
   this.conceal(row);row.win.setParentWindow(parent);
   if(row.win.getParentWindow()!==parent)throw Error('讨论父窗口迁移未确认');
   this.listenParent(row,parent);row.record.windowId=destination.windowId;row.epoch++;row.geometrySignature=null;
  }catch(error){row.win.setParentWindow(old);row.record.windowId=oldWindowId;this.listenParent(row,old);throw error;}
 }
 setViewport(row,viewport){
  if(!row.workMode||(row.viewportOwner??row.owner)===viewport)return;
  const before=row.viewportOwner,parent=row.win.getParentWindow();
  row.viewportOwner=viewport;
  try{this.moveParent(row,viewport.win);this.listenParent(row,viewport.win);this.refreshRow(row);}
  catch(error){row.viewportOwner=before;this.listenParent(row,parent??row.owner.win);throw error;}
 }
 listenParent(row,parent){row.parentCleanup?.();const viewport=row.viewportOwner??row.owner,update=()=>this.refreshRow(row),zoom=()=>{clearImmediate(row.zoomRefresh);row.zoomRefresh=setImmediate(update);};const events=['move','resize','show','hide','minimize','restore','focus'];for(const name of events)parent.on(name,update);viewport.wc.on('zoom-changed',zoom);row.parentCleanup=()=>{clearImmediate(row.zoomRefresh);viewport.wc.removeListener('zoom-changed',zoom);for(const name of events)parent.removeListener(name,update);};}
 async create(owner,p,from){const w=this.workspace,report=w.layouts.get(owner.projectId)?.views[owner.viewId]?.viewState?.report;
  if(owner.role!=='surface'||!['report','history'].includes(owner.kind)||p.projectId!==owner.projectId||!w.reviewReportOwns(owner,p.objectId))throw denied();
  const source=await openingStep(from,'核对报告归属',()=>this.managed.reportSource(p.projectId,p.objectId));
  if(source.workId!==p.workId||source.objectId!==p.objectId)throw denied();
  const row={owner,ownerGeneration:owner.generation,projectId:owner.projectId,workId:p.workId,objectId:p.objectId,workName:String(p.workName||'审核讨论'),ownerSurfaceId:owner.viewId,epoch:1,requested:false,sequence:0,readOnly:owner.kind==='history'||!!report?.history||!!report?.historyMode};
  return this.createWindow(row,from);
 }
 async createWindow(row,from){const {owner}=row,w=this.workspace;
  const geometry=this.geometry(row);row.geometrySignature=JSON.stringify([geometry.bounds,geometry.origin,geometry.zoomFactor]);
  const win=new this.BrowserWindow({parent:owner.win,modal:false,type:'utility',show:false,skipTaskbar:true,frame:false,resizable:false,movable:false,minimizable:false,maximizable:false,fullscreenable:false,webPreferences:{preload:this.preload,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
  const rows=row.workMode?this.workRows:this.rows,key=row.workMode?row.workKey:owner.wc.id;
  row.win=win;row.record=w.register(win.webContents,{role:'review-discussion',kind:'review-discussion',projectId:row.projectId,windowId:owner.windowId,win,discussionRow:row});rows.set(key,row);this.listenParent(row,owner.win);
  win.webContents.setZoomFactor(geometry.zoomFactor);
  win.webContents.on('zoom-changed',()=>{clearImmediate(row.zoomRefresh);row.zoomRefresh=setImmediate(()=>this.refreshRow(row));});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event,url)=>{if(url!==w.origin)event.preventDefault();});
  win.on('close',event=>{event.preventDefault();void this.hideFromChild(row).catch(w.onError);});
  win.on('show',()=>{if(!row.activating)this.notifyVisibility(row);});
  win.on('hide',()=>{if(!row.activating)this.notifyVisibility(row);});
  win.on('focus',()=>this.refreshRow(row));
  win.on('closed',()=>{row.parentCleanup?.();this.notifyVisibility(row);if(rows.get(key)===row)rows.delete(key);});
  try{
   await openingStep(from,'加载讨论页面',()=>win.loadURL(w.origin));
   await openingStep(from,'等待讨论页面就绪',()=>new Promise((resolve,reject)=>{
    const settled=()=>{dispose();if(row.record.ready)resolve();else reject(Object.assign(Error(row.record.initError?.message||'讨论页面尚未准备好'),{code:row.record.initError?.code||'SURFACE_NOT_READY'}));};
    const closed=()=>{dispose();reject(denied());};
    const dispose=()=>{clearTimeout(timer);for(const event of ['nozeli-content-ready','nozeli-init-settled'])win.webContents.removeListener(event,settled);win.removeListener('closed',closed);};
    const timer=setTimeout(settled,10000);
    if(!this.owns(row))return closed();
    if(row.record.ready||row.record.contentFailed)return settled();
    for(const event of ['nozeli-content-ready','nozeli-init-settled'])win.webContents.once(event,settled);
    win.once('closed',closed);
   }));
   return row;
  }catch(error){row.requested=false;this.conceal(row);if(!row.record.ready)this.closeRow(row);throw error;}
 }
 async readReceipt(record,p){
  const row=record.discussionRow;
  if(!this.owns(row)||row.record!==record||p.projectId!==row.projectId||p.workId!==row.workId||row.readOnly)throw denied();
  if(p.objectId==null){
   if(!row.workMode||Object.keys(p).some(key=>!['projectId','workId','objectId','revision','requestKey','text','lane','importedSkill'].includes(key)))throw denied();
   const {projectId,workId,revision,requestKey,text,lane,importedSkill}=p;
   const receipt=await this.managed.workChatReceipt({projectId,workId,revision,requestKey,text,lane,importedSkill});
   if(!this.owns(row))throw denied();
   return receipt;
  }
  const receipt=await this.managed.reviewDiscussionReceipt(p);
  if(!this.owns(row))throw denied();
  if(!receipt)throw Object.assign(Error('原报告未记录此发送；请核对最新报告后再发送。'),{code:'REVIEW_CANDIDATE_STALE'});
  return receipt;
 }
 reportOwns(owner,{projectId,workId,objectId}){
  const report=this.workspace.layouts.get(projectId)?.views[owner.viewId]?.viewState?.report;
  return typeof objectId==='string'&&owner.projectId===projectId&&this.workspace.reviewReportOwns(owner,objectId)&&(!report?.objectId||report.objectId===objectId)&&(!report?.workId||report.workId===workId);
 }
 currentLauncher(from){
  return from&&!from.owner.dead&&from.owner.generation===from.generation&&from.owner.projectId===from.projectId&&(from.kind==='report'?this.reportOwns(from.owner,from):this.workspace.shell===from.owner);
 }
 launcher(row){const from=row.launcher;return this.currentLauncher(from)&&this.launcherVisible(from.owner,row.projectId)?from:{owner:row.owner,kind:row.workMode?'work':'report',objectId:row.objectId};}
 returnFocus(row,from){
  if(!this.owns(row)||!this.currentLauncher(from)||!this.launcherVisible(from.owner,row.projectId))return;
  from.owner.wc.focus();from.owner.wc.send('nozeli:workspace-control',{type:'review-discussion-focus',projectId:row.projectId,workId:row.workId,objectId:from.objectId??null,launcher:from.kind});
 }
 presentationKey(owner,p,kind){return JSON.stringify(kind==='surface'?['surface',owner.wc.id]:[kind,p.projectId,p.workId]);}
 intent(owner,p,kind,action,key,run,openDeadline){
  const previous=this.presentationIntents.get(key),generation=owner.generation,move=this.launcherMoves.get(owner);
  const from={...p,owner,kind,generation,move,parent:owner.win,action,key};
  if(action==='show'&&previous?.action===action&&previous.owner===owner&&previous.generation===generation&&previous.move===move&&previous.objectId===from.objectId&&previous.workId===from.workId)return previous.flight;
  if(action==='show'){const focused=this.BrowserWindow?.getFocusedWindow?.();from.startedActive=owner.win.isFocused()||[...this.workRows.values(),...this.rows.values()].some(row=>row.win===focused&&this.owns(row)&&this.familyFocused(owner.win,row.win));from.deadline=new AbortController();from.stage='核对项目身份';}
  this.presentationIntents.set(key,from);
  const operation=Promise.resolve().then(()=>run(from));
  let timer;
  const completion=from.deadline?Promise.race([operation,new Promise((_,reject)=>{
   timer=setTimeout(()=>{
    const error=Object.assign(Error('打开讨论超时：'+from.stage+'。请重试'),{code:'REVIEW_OPEN_TIMEOUT',stage:from.stage});
    from.deadline.abort(error);reject(error);
   },Math.min(this.openTimeoutMs,openDeadline===undefined?Infinity:Math.max(0,openDeadline-performance.now())));
  })]):operation;
  from.flight=completion.finally(()=>{clearTimeout(timer);if(this.presentationIntents.get(key)===from)this.presentationIntents.delete(key);});
  return from.flight;
 }
 isCurrent(from){return !from.deadline?.signal.aborted&&this.presentationIntents.get(from.key)===from;}
 assertPresentation(from){
  this.assertLauncher(from.owner,from.projectId,from.generation);
  if(!this.currentLauncher(from)||from.parent!==from.owner.win||from.move!==this.launcherMoves.get(from.owner))throw denied();
 }
 async command(row,action,binding={}){
  row.commandAction=action;
  try{await this.workspace.flushOne(row.record,'nozeli:review-discussion-command',{action,...binding});}
  finally{row.commandAction=null;}
 }
 commitHide(row){
  const from=row.launcher,parent=row.win.getParentWindow()||(row.viewportOwner??row.owner).win;
  const restore=row.requested&&(parent.isFocused()||row.win.isFocused());
  row.requested=false;this.conceal(row);
  if(restore)this.returnFocus(row,from);
 }
 async hide(row,from){
  if(!this.owns(row)||!this.isCurrent(from))return {absent:true};
  await this.command(row,'hide');
  if(!this.owns(row)||!this.isCurrent(from)||from.owner.generation!==from.generation||from.parent!==from.owner.win||from.move!==this.launcherMoves.get(from.owner))return {superseded:true};
  this.commitHide(row);return {ok:true};
 }
 hideFromChild(row){
  const launcher=row.launcher;
  if(!this.owns(row)||!launcher)return Promise.resolve({absent:true});
  const pending=this.presentationIntents.get(launcher.key);
  if(pending&&(pending.owner!==launcher.owner||pending.generation!==launcher.generation||pending.objectId!==launcher.objectId))return Promise.resolve({superseded:true});
  return this.intent(launcher.owner,launcher,launcher.kind,'hide',launcher.key,from=>this.serialWork(row.workKey??from.key,()=>this.hide(row,from)));
 }
 async invoke(owner,op,p,openDeadline){const action=op.slice('workspace.reviewDiscussion.'.length);
  if(action==='intakeShow')return this.openIntake(owner,p);
  if(action==='intakeRead'){
   const row=owner.discussionRow;
   if(owner.role!=='review-discussion'||!row?.sourceJobId||!this.owns(row)||row.record!==owner||p.projectId!==row.projectId||p.workId!==row.workId||Object.keys(p).some(k=>!['projectId','workId','cursor','limit'].includes(k))||p.cursor!=null&&(typeof p.cursor!=='string'||p.cursor.length>512)||p.limit!=null&&(!Number.isSafeInteger(p.limit)||p.limit<1||p.limit>100))throw denied();
   const binding=taskBinding(row),{index,scope,state}=await this.workspace.taskSource(row.projectId,binding);
   const taskFrame=await index.page({...binding,cursor:p.cursor??null,limit:p.limit??50});
   if(!this.owns(row)||row.record!==owner)throw denied();
   this.captureFrame(row,taskFrame);
   const record=managedWorkRecords(state).find(record=>record.id==='request:'+row.sourceJobId);
   const jobs=(state.jobs??[]).filter(job=>scope.matches({jobId:job.id})).map(({id,type,target,status,routing,at,startedAt,finishedAt,context})=>({id,type,target,status,routing,at,startedAt,finishedAt,context:{retryOf:context?.retryOf,routingQuestionId:context?.routingQuestionId,pendingIntakeId:context?.pendingIntakeId}}));
   const linked=(state.works??[]).find(work=>work.id===record?.workId);
   return {taskFrame,taskState:{works:[],jobs,receipts:[],todos:[],agents:[]},canSend:false,phase:linked?'已派工 · 后续请从工作追踪打开 Worker 对话':record?.phase||'主控处理记录',active:!linked&&jobs.some(j=>j.status==='running')};
  }
  if(owner.role==='review-discussion'&&action==='receipt')return this.readReceipt(owner,p);
  if(owner.role==='review-discussion'&&action==='latest')return this.openLatest(owner.discussionRow);
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
   const binding=taskBinding(row),{index,scope}=await this.workspace.taskSource(row.projectId,binding);
   const location=p.messageId===undefined?null:this.workspace.taskLocateCursor(index,scope,p.messageId);
   const frame=await index.page({cursor:location?location.cursor:p.cursor??null,limit:p.limit??50,...binding});
   if(!this.owns(row)||row.record!==owner)throw denied();
   this.captureFrame(row,frame);
   return {frame,taskScope:row.sourceJobId?binding:{workId:row.workId,sourceJobId:null},...(location?{location}:{})};
  }
  if(owner.role==='review-discussion'&&action==='exportOriginal'){
   const row=owner.discussionRow;
   if(!this.owns(row)||row.record!==owner||p.projectId!==row.projectId||p.workId!==row.workId||Object.keys(p).some(key=>!['projectId','workId','id','version'].includes(key))||typeof p.id!=='string'||!p.id||p.id.length>512||typeof p.version!=='string'||!/^[a-f0-9]{64}$/.test(p.version)||!row.originalIds?.has(p.id))throw denied();
   const {index,scope}=await this.workspace.taskSource(row.projectId,taskBinding(row));
   const entry=index.records().find(record=>record.id===p.id);
   if(!entry||!scope.matches(entry)||entry.objectId!==p.version)throw Object.assign(Error('原生历史版本已变化；请重新读取后再导出。'),{code:'TIMELINE_VERSION'});
   if(!this.owns(row)||row.record!==owner)throw denied();
   return exportTimelineOriginal({managed:this.managed,dialog:this.dialog,scope:owner,projectId:row.projectId,id:p.id,version:p.version});
  }
  if(owner.role==='review-discussion'&&(action==='readingState.read'||action==='readingState.write')){
   const row=owner.discussionRow;
   if(!this.owns(row)||row.record!==owner||p.projectId!==row.projectId||p.workId!==row.workId)throw denied();
   const {storage,storageKey,legacyKey}=await this.readingStateStore(row);
   const readStored=async()=>await storage.getLocal(row.projectId,storageKey)??(legacyKey?await storage.getLocal(row.projectId,legacyKey):null);
   if(action==='readingState.read'){
    if(Object.keys(p).some(key=>!['projectId','workId'].includes(key)))throw denied();
    const stored=await readStored();
    if(!this.owns(row)||row.record!==owner)throw denied();
    return {state:stored?.state??null};
   }
   if(Object.keys(p).some(key=>!['projectId','workId','expectedRevision','disclosures','flushRequestId'].includes(key))||!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<0||!validDisclosures(p.disclosures))throw Object.assign(Error('披露状态无效。'),{code:'INVALID_PAYLOAD'});
   this.readingStateWrites??=new Map();
   const previous=this.readingStateWrites.get(storageKey)??Promise.resolve();
   const flight=previous.catch(()=>{}).then(async()=>{
    if(!this.owns(row)||row.record!==owner)throw denied();
    const stored=await readStored(),current=stored?.state??null;
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
   const root=this.workspace.windows.get(owner.windowId),parent=row.win.getParentWindow(),generation=root?.generation;
   if(!root||root.win!==parent||root.dead||root.projectId!==row.projectId)throw denied();
   await this.workspace.flushOne(owner);
   if(!this.owns(row)||row.record!==owner||root.dead||root.generation!==generation||root.projectId!==row.projectId||this.workspace.windows.get(owner.windowId)!==root||row.win.getParentWindow()!==parent)throw denied();
   const publication=row.publications?.get(p.objectId);
   if(!publication||!['result','problem'].includes(publication.kind))throw denied();
   const report={id:'history:'+p.objectId,objectId:p.objectId,projectId:row.projectId,workId:row.workId,revision:publication.revision,kind:publication.kind,workName:row.workName,history:true};
   const control={type:'report',projectId:row.projectId,report};
   if(root.ready)root.wc.send('nozeli:workspace-control',control);else(root.pendingControls??=[]).push(control);
   if(this.familyFocused(parent,row.win)){root.win.show();root.win.focus();}return {routed:true,objectId:p.objectId};
  }
  if(owner.role==='review-discussion'){
   const row=owner.discussionRow;
   if(action==='requestHide'&&this.owns(row)&&row.record===owner&&Object.keys(p).length===0)return this.hideFromChild(row);
   if(action!=='bounds'||!this.owns(row)||p.generation!==owner.generation)throw denied();
   this.refreshRow(row);
   if(p.epoch!==row.epoch)return {stale:true,geometry:this.geometry(row)};
   if(!Number.isSafeInteger(p.sequence)||p.sequence<=row.sequence)return {stale:true};
   const r=p.rect,frame=this.geometry(row),b={x:frame.origin.x,y:frame.origin.y,width:frame.bounds.width*frame.zoomFactor,height:frame.bounds.height*frame.zoomFactor};
   if(!r||!['x','y','width','height'].every(k=>Number.isFinite(r[k]))||r.width<1||r.height<1||r.x<b.x-1||r.y<b.y-1||r.x+r.width>b.x+b.width+1||r.y+r.height>b.y+b.height+1)throw denied();
   row.sequence=p.sequence;
   const rect=Object.fromEntries(Object.entries(r).map(([k,v])=>[k,Math.round(v)])),signature=JSON.stringify(rect);
   if(signature!==row.appliedGeometry){row.win.setContentBounds(rect);row.appliedGeometry=signature;}
   row.appliedEpoch=p.epoch;row.boundsVisible=p.visible===true;
   this.refreshRow(row);
   return {sequence:p.sequence,contentBounds:row.win.getContentBounds()};
  }
  if(action==='workShow')return this.openWork(owner,p);
  if(!['show','hide','flush','bind','release','modal','refresh'].includes(action)||owner.role!=='surface'||!['report','history'].includes(owner.kind))throw denied();
  if(p.projectId!==owner.projectId||!validWorkId(p.workId))throw denied();
  const report=this.workspace.layouts.get(owner.projectId)?.views[owner.viewId]?.viewState?.report;
  if(owner.kind==='report'&&this.workspace.shell?.projectId===owner.projectId&&!this.workspace.shell.dead&&!report?.history&&!report?.historyMode&&!this.rowForOwner(owner))return this.reportWork(owner,p,action,openDeadline);
  let row=this.rowForOwner(owner);
  if(row&&(row.workId!==p.workId||row.projectId!==p.projectId||row.objectId!==p.objectId))throw denied();
  if(action==='refresh'){if(!row)return {absent:true};this.refreshRow(row);return {geometry:this.geometry(row)};}
  if(action==='modal')return row?this.modal(row,owner,p.held===true):{absent:true};
  if(action==='flush'){if(!row)return {absent:true};await this.workspace.flushOne(row.record);return {saved:true};}
  const key=this.presentationKey(owner,p,'surface'),binding={...p,objectId:action==='bind'?p.nextObjectId:p.objectId};
  if(action==='show'||action==='bind'){
   if(!this.reportOwns(owner,binding))throw denied();
   this.assertLauncher(owner,p.projectId,owner.generation);
  }
 
  return this.intent(owner,binding,'report',action,key,from=>this.serialWork(key,async()=>{
   if(!this.isCurrent(from))return action==='show'?deferred('superseded'):{superseded:true};
   row=this.rowForOwner(owner);
   if(action==='release'){if(row){await this.workspace.flushOne(row.record);if(this.isCurrent(from))this.closeRow(row);}return {released:true};}
   if(action==='hide')return row?this.hide(row,from):{absent:true};
   this.assertPresentation(from);
   if(!row&&action==='show')row=await this.create(owner,p,from);
   if(!row)return {absent:true};
   if(action==='show')return this.show(row,{objectId:from.objectId},from);
   return await this.setBinding(row,{objectId:from.objectId},from)?{bound:true}:{superseded:true};
  }),openDeadline);
 }
 async openLatest(row){
  if(!this.owns(row))throw denied();
  await this.workspace.flushOne(row.record);
  if(!this.owns(row))throw denied();
  const from=this.launcher(row);
  if(from.kind==='report'){
   from.owner.wc.send('nozeli:workspace-control',{type:'review-discussion-latest',projectId:row.projectId,workId:row.workId,objectId:row.objectId});
   return {requested:true};
  }
  const {projectId,workId}=row,{state}=await this.managed.projectionSource(projectId);
  const work=state.works?.find(item=>item.id===workId),objectId=work?.result?.objectId;
  const receipt=state.receipts?.find(item=>item.workId===workId&&item.objectId===objectId&&item.kind==='result'&&!item.stale);
  if(!this.owns(row)||!receipt)throw Object.assign(Error('没有可打开的最新任务报告。'),{code:'REVIEW_UNAVAILABLE'});
  const todo=state.todos?.find(item=>item.kind==='result'&&item.status==='open'&&item.workId===workId&&item.objectId===objectId);
  if(!(await this.hideFromChild(row)).ok)return {requested:false};
  if(!this.owns(row))throw denied();
  row.owner.wc.send('nozeli:workspace-control',{type:'report',projectId,report:{id:todo?.id??objectId,todoId:todo?.id,projectId,workId,objectId,revision:receipt.revision,kind:'result',workName:row.workName,title:receipt.report?.title||'最新任务报告'}});
  return {requested:true,objectId};
 }
 modal(row,owner,held){
  if(held)row.modalOwner=owner;else if(row.modalOwner!==owner)return {held:row.suspended===true};
  row.suspended=held;if(!held)row.modalOwner=null;
  row.record.wc.send('nozeli:workspace-control',{type:'transfer-hold',held});this.refreshRow(row);return {held};
 }
 async setBinding(row,binding,from){
  // Save the old draft and acknowledge the new binding before presentation.
  const changed=row.objectId!==binding.objectId;
  if(changed){from.stage='保存原讨论草稿';await this.workspace.flushOne(row.record);}
  from.stage='等待讨论窗口回执';
  if(!this.owns(row))throw denied();
  if(!this.isCurrent(from))return false;
  this.assertPresentation(from);
  if(row.workMode)this.assertWorkBindingAvailable(row.projectId,row.workId);
  row.switchingBinding=changed;
  row.bindingObjectId=binding.objectId;
  try{await this.command(row,'bind',binding);row.objectId=binding.objectId;row.reviewVersion=binding.reviewVersion??null;}
  finally{row.bindingObjectId=undefined;row.switchingBinding=false;}
  if(changed){row.requested=false;this.conceal(row);}
  return this.isCurrent(from);
 }
 async show(row,binding,from){
  if(!this.isCurrent(from))return deferred('superseded');
  this.assertPresentation(from);
  if(!this.owns(row)||!row.record.ready)throw denied();
  if(row.workMode)this.assertWorkBindingAvailable(row.projectId,row.workId);
  const {owner,parent}=from,old=row.launcher,previousViewport=row.viewportOwner??row.owner;
  const same=old?.owner===owner&&old.generation===from.generation&&old.kind===from.kind&&old.objectId===binding.objectId&&old.reviewVersion===(binding.reviewVersion??null)&&row.objectId===binding.objectId&&row.reviewVersion===(binding.reviewVersion??null);
  const admitted=()=>!row.suspended&&this.launcherVisible(owner,row.projectId,parent);
  const inactive=!from.startedActive||!this.familyFocused(parent,row.win);
  if(inactive||!admitted()){
   return deferred(inactive?'inactive':'launcher-hidden');
  }
  const sameVisible=same&&this.visible(row);
  const alreadyShown=sameVisible&&row.boundsVisible&&row.appliedEpoch===row.epoch;
  const wasRequested=row.requested;
  if(!alreadyShown){
   // Renderer readiness/bounds alone never open a native window. Disable
   // passive restoration before changing the viewport or sending "show".
   if(!sameVisible){row.requested=false;this.conceal(row);}
   const locatePublication=from.kind==='report'&&!(same&&old.presented);
   try{
    this.setViewport(row,owner);
    if(row.objectId!==binding.objectId&&!await this.setBinding(row,binding,from))return deferred('superseded');
    if(!this.isCurrent(from)||!this.familyFocused(parent,row.win))return deferred(this.isCurrent(from)?'inactive':'superseded');
    from.stage='等待讨论窗口回执';
    await this.command(row,'show',from.kind==='report'?{...binding,locatePublication}:binding);
    row.reviewVersion=binding.reviewVersion??null;
   }catch(error){
    if(this.owns(row)&&this.isCurrent(from)&&from.move===this.launcherMoves.get(owner)){
     this.setViewport(row,previousViewport);row.requested=wasRequested;this.refreshRow(row);
    }
    throw error;
   }
  }
  if(!this.isCurrent(from))return deferred('superseded');
  this.assertPresentation(from);
  if(!this.owns(row)||!row.record.ready||row.win.getParentWindow()!==parent)throw denied();
  if(row.workMode)this.assertWorkBindingAvailable(row.projectId,row.workId);
  this.refreshRow(row);
  const reason=!this.familyFocused(parent,row.win)?'inactive':!admitted()?'launcher-hidden':!row.boundsVisible||row.appliedEpoch!==row.epoch?'geometry':null;
  if(reason){row.requested=false;this.conceal(row);return deferred(reason);}
  row.launcher=same?old:{owner,kind:from.kind,projectId:row.projectId,workId:row.workId,objectId:binding.objectId,generation:from.generation,key:from.key,shown:false};
  row.requested=true;row.activating=true;
  try{
   if(!row.win.isVisible())row.win.show();
   if(this.familyFocused(parent,row.win)&&!row.win.isFocused())row.win.focus();
  }catch(error){row.requested=false;this.conceal(row);throw error;}
  finally{row.activating=false;}
  if(!this.visible(row)){
   row.requested=false;this.conceal(row);return deferred('native-not-shown');
  }
  row.launcher.presented=true;row.launcher.reviewVersion=binding.reviewVersion??null;this.notifyVisibility(row);return {shown:true};
 }
 assertLauncher(owner,projectId,generation){
  if(owner.dead||owner.generation!==generation||owner.projectId!==projectId||owner.held||owner.transferring||owner.bindPending||this.workspace.lifecycle.has(projectId))throw denied();
 }
 assertWorkBindingAvailable(projectId,workId){
  for(const barrier of this.workspace.reviewBarriers??[])if(barrier.projectId===projectId&&barrier.workId===workId)throw denied();
 }
 async openIntake(owner,p){
  if(owner!==this.workspace.shell||owner.role!=='shell'||p.projectId!==owner.projectId||!validWorkId(p.sourceJobId)||Object.keys(p).some(k=>!['projectId','sourceJobId'].includes(k)))throw denied();
  const {projectId,sourceJobId}=p,generation=owner.generation,binding={projectId,workId:sourceJobId,objectId:null};
  return this.intent(owner,binding,'intake','show',this.presentationKey(owner,binding,'intake'),async from=>{
   const project=await openingStep(from,'核对项目身份',()=>this.workspace.host.storage.requireRegistered(projectId)),key=JSON.stringify([project.instanceId,'intake',sourceJobId]);
   from.stage='等待同一任务的窗口操作';
   return this.serialWork(key,async()=>{
    if(!this.isCurrent(from))return deferred('superseded');
    this.assertPresentation(from);
    const {state}=await openingStep(from,'读取原请求',()=>this.workspace.taskSource(projectId,{sourceJobId}));
    const source=state.jobs?.find(job=>job.id===sourceJobId&&job.type==='intake'&&job.target==='orchestrator');
    const record=source&&managedWorkRecords(state).find(item=>item.id==='request:'+sourceJobId);
    if(!record)throw denied();
    if(!this.isCurrent(from))return deferred('superseded');
    this.assertPresentation(from);
    if(record.workId)return from.startedActive&&owner.win.isFocused()?this.openWork(owner,{projectId,workId:record.workId}):deferred('inactive');
    let row=this.workRows.get(key);
    if(!row)row=await this.createWindow({owner,ownerGeneration:generation,projectId,projectInstanceId:project.instanceId,sourceJobId,workId:sourceJobId,workKey:key,objectId:null,workName:record.name,ownerSurfaceId:'intake-discussion',epoch:1,requested:false,sequence:0,workMode:true,readOnly:true},from);
    return this.show(row,{objectId:null},from);
   });
  });
 }
 async openWork(owner,p){
  if(owner!==this.workspace.shell||owner.role!=='shell'||p.projectId!==owner.projectId||!validWorkId(p.workId)||Object.keys(p).some(k=>!['projectId','workId'].includes(k)))throw denied();
  const {projectId,workId}=p,generation=owner.generation,binding={...p,objectId:null};
  return this.intent(owner,binding,'work','show',this.presentationKey(owner,p,'work'),async from=>{
   const project=await openingStep(from,'核对项目身份',()=>this.workspace.host.storage.requireRegistered(projectId)),key=this.workKey(project.instanceId,workId);
   from.stage='等待同一任务的窗口操作';
   return this.serialWork(key,async()=>{
    if(!this.isCurrent(from))return deferred('superseded');
    this.assertPresentation(from);
    const {state}=await openingStep(from,'读取工作记录',()=>this.managed.projectionSource(projectId));
    const work=state.works?.find(item=>item.id===workId);
    if(!work)throw Object.assign(Error('本地工作账本身份无效'),{code:'WORK_NOT_FOUND'});
    if(!this.isCurrent(from))return deferred('superseded');
    this.assertPresentation(from);
    this.assertWorkBindingAvailable(projectId,workId);
    let row=this.workRows.get(key);
    if(!row)row=await this.createWorkWindow(owner,project,workId,work.name,{objectId:null},undefined,from);
    return this.show(row,{objectId:null},from);
   });
  });
 }
 async createWorkWindow(shell,project,workId,workName,binding,legacyReadingSurfaceId,from){
  return this.createWindow({owner:shell,ownerGeneration:shell.generation,projectId:shell.projectId,projectInstanceId:project.instanceId,workId,workKey:this.workKey(project.instanceId,workId),objectId:binding.objectId,reviewVersion:binding.reviewVersion??null,workName:String(workName||'任务对话').slice(0,512),ownerSurfaceId:workSurfaceId,legacyReadingSurfaceId,epoch:1,requested:false,sequence:0,workMode:true,readOnly:false},from);
 }
 async reportWork(owner,p,action,openDeadline){
  const shell=this.workspace.shell,{projectId,workId}=p,generation=owner.generation,shellGeneration=shell.generation;
  if(owner.projectId!==projectId||!validWorkId(workId))throw denied();
  const intentKey=this.presentationKey(owner,p,'work'),requested={...p,objectId:action==='bind'?p.nextObjectId:p.objectId};
  const report=this.workspace.layouts.get(projectId)?.views[owner.viewId]?.viewState?.report;
  const assertReport=()=>{
   const current=this.workspace.layouts.get(projectId)?.views[owner.viewId]?.viewState?.report;
   if(!this.reportOwns(owner,requested)||current?.history||current?.historyMode)throw denied();
  };
  const lookup=async()=>this.workKey((await this.workspace.host.storage.requireRegistered(projectId)).instanceId,workId);
  // Flush is also invoked from the report renderer inside a review barrier.
  // Never queue that acknowledgement behind a show waiting on a child flush.
  if(action==='flush'){
   const key=await lookup();
   const row=this.workRows.get(key),report=this.workspace.layouts.get(projectId)?.views[owner.viewId]?.viewState?.report;
   if(!row||!this.owns(row)||!this.workspace.reviewReportOwns(owner,p.objectId)||report?.workId&&report.workId!==workId)return {absent:true};
   await this.workspace.flushOne(row.record);return {saved:true};
  }
  if(action==='refresh'||action==='modal'){
   this.assertLauncher(owner,projectId,generation);
   const row=this.workRows.get(await lookup());
   this.assertLauncher(owner,projectId,generation);assertReport();
   if(!row)return {absent:true};
   if(!this.owns(row))throw denied();
   if(action==='modal')return this.modal(row,owner,p.held===true);
   this.refreshRow(row);return {geometry:this.geometry(row)};
  }
  const matches=launcher=>launcher?.owner===owner&&launcher.objectId===p.objectId;
  if(action==='hide'||action==='release'){
   const pending=this.presentationIntents.get(intentKey);
   const live=[...this.workRows.values()].find(row=>row.projectId===projectId&&row.workId===workId&&this.owns(row));
   if(pending?!matches(pending):!matches(live?.launcher)&&!(action==='release'&&live?.modalOwner===owner))return action==='release'?{released:true}:{absent:true};
  }else{
   assertReport();
   this.assertLauncher(owner,projectId,generation);this.assertLauncher(shell,projectId,shellGeneration);
  }
  return this.intent(owner,requested,'report',action,intentKey,async from=>{
   const project=await openingStep(from,'核对项目身份',()=>this.workspace.host.storage.requireRegistered(projectId)),key=this.workKey(project.instanceId,workId);
   from.stage='等待同一任务的窗口操作';
   return this.serialWork(key,async()=>{
    if(!this.isCurrent(from))return action==='show'?deferred('superseded'):{superseded:true};
    let row=this.workRows.get(key);
    if(action==='release'){
     if(row&&(row.launcher?.owner===owner||row.viewportOwner===owner||row.modalOwner===owner))this.clearLauncher(row,owner);
     return {released:true};
    }
    this.assertLauncher(owner,projectId,generation);this.assertLauncher(shell,projectId,shellGeneration);
    if(action==='hide')return row&&(matches(row.launcher)||!row.launcher)?this.hide(row,from):{absent:true};
    this.assertPresentation(from);assertReport();
    if(row&&!this.owns(row))throw denied();
    if(action==='bind'&&(!row||row.objectId!==p.objectId))return {absent:true};
    this.assertWorkBindingAvailable(projectId,workId);
    const reportSource=await openingStep(from,'核对报告归属',()=>this.managed.reportSource(projectId,from.objectId));
    if(!this.isCurrent(from))return action==='show'?deferred('superseded'):{superseded:true};
    if(reportSource.workId!==workId||reportSource.objectId!==from.objectId)throw denied();
    this.assertPresentation(from);this.assertLauncher(shell,projectId,shellGeneration);assertReport();
    this.assertWorkBindingAvailable(projectId,workId);
    const binding={objectId:from.objectId};
    if(!row)row=await this.createWorkWindow(shell,project,workId,report?.workName??p.workName,binding,owner.viewId,from);
    row.legacyReadingSurfaceId??=owner.viewId;
    if(action==='show')return this.show(row,binding,from);
    return await this.setBinding(row,binding,from)?{bound:true}:{superseded:true};
   });
  },openDeadline);
 }
 clearLauncher(row,owner){
  if(row.launcher?.owner===owner){row.requested=false;this.conceal(row);row.launcher=null;}
  if(row.viewportOwner===owner){row.requested=false;if(this.owns(row))this.setViewport(row,row.owner);}
  if(row.modalOwner===owner&&this.owns(row))this.modal(row,owner,false);
 }
 closeRow(row){const rows=row.workMode?this.workRows:this.rows,key=row.workMode?row.workKey:row.owner.wc.id;row.parentCleanup?.();if(rows.get(key)===row)rows.delete(key);if(!row.win.isDestroyed())row.win.destroy();}
 closeScope(owner){const row=this.rowForOwner(owner);if(row)this.closeRow(row);for(const row of this.workRows.values())if(row.owner===owner)this.closeRow(row);else this.clearLauncher(row,owner);}
 closeProject(projectId){for(const row of this.workRows.values())if(row.projectId===projectId)this.closeRow(row);}
}
