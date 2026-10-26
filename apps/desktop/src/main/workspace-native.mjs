import { randomUUID } from 'node:crypto';
import { createLayout, validateLayout, reduceLayout, singleContentLayout, layoutGroups, findView } from '../domain/workspace-layout.mjs';
import {WorkspaceLayoutStore} from './workspace-layout-store.mjs';
import {mergeDrawingMaterials} from '../domain/drawing-delivery.mjs';
import {normalizeOfficeRecovery} from './office-recovery.mjs';
import {listManagedPending,readManagedObject} from '../agents/managed/managed-storage.mjs';
import {GuidedDemoControls} from './guided-demo-controls.mjs';

const fail = (code, message = code) => Object.assign(new Error(message), { code });
const writes = new Set(['file.save','file.draft','file.retain','sheet.save','sheet.recover','word.save','word.import','document.image.put','annotation.add','annotation.update','annotation.remove','annotation.drawing','tag.put','tag.view','tag.reanchor','tag.material']);
const surfaceOps = /^(file\.|document\.|annotation\.|tag\.|material\.|word\.|sheet\.|ppt\.|formatter\.|lsp\.(sync|request|status)$|tex\.|managed\.|report\.|project\.(open|list|children|search)$|agents\.(messages|reports)$|config\.status$|settings\.appearance\.read$|links\.openExternal$|state\.(read|write)$|view\.authorship$|session\.(flushed|requestClose|capture|resize|quitChoice)$)/;

const topology=layout=>JSON.stringify({mainRoot:layout.mainRoot,detached:layout.detached.map(({id,root})=>({id,root})),views:Object.values(layout.views).map(({id,kind,resourceId,relPath})=>({id,kind,resourceId,relPath}))});
export function restoreBounds(bounds, screen) {
  const fallback = { x: 80, y: 80, width: 1000, height: 760 };
  const b = bounds && ['x','y','width','height'].every(k => Number.isFinite(bounds[k])) ? bounds : fallback;
  const area = screen.getDisplayMatching(b).workArea;
  const width = Math.min(area.width, Math.max(320, Math.round(b.width)));
  const height = Math.min(area.height, Math.max(240, Math.round(b.height)));
  return { x: Math.round(Math.max(area.x, Math.min(b.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(b.y, area.y + area.height - height))), width, height };
}

export class WorkspaceNative {
  constructor({ BrowserWindow, WebContentsView, screen, origin, preload, icon, userDataDir, host, hidden = false, onClose, onError = console.error, recover }) {
    Object.assign(this, { BrowserWindow, WebContentsView, screen, origin, preload, icon, host, hidden, onClose, onError, recover });
    this.senders = new Map(); this.windows = new Map(); this.surfaces = new Map(); this.layouts = new Map(); this.queues = new Map(); this.receipts = new Map(); this.requests = new Map(); this.drags = new Map(); this.leases = new Map(); this.epoch = 0;
    this.buffers=new Map();
    this.namedLayouts=new WorkspaceLayoutStore({storage:host.storage});
    this.lifecycle = new Map();
    this.preferences = { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false, preload };
    this.demoControls=new GuidedDemoControls(this);
  }
  async performDemoAction(scope,payload,{manager,row}){
    const candidates=this.projectRecords(payload.projectId).filter(record=>!record.dead&&record.ready&&!record.transferring&&(!payload.viewId||record.viewId===payload.viewId)&&(!payload.relPath||record.relPath===payload.relPath));
    const reportCommand=payload.command==='report.open'||['decision-accept','decision-discard'].includes(payload.args?.semantic);
    const conversationCommand=payload.command==='conversation.ask'||['task-a','task-b','progress','decision-continue'].includes(payload.args?.semantic);
    const shellCommand=['workspace.split','workspace.resize','workspace.detach','workspace.dock'].includes(payload.command)||payload.command==='notification.show'&&!reportCommand&&!conversationCommand;
    const layout=reportCommand?await this.layout(payload.projectId):null;
    const record=shellCommand?this.shell:reportCommand?candidates.find(record=>record.kind==='report'&&layout.views[record.viewId]?.resourceId===payload.args.todoId):conversationCommand?candidates.find(record=>record.kind==='conversation'):candidates.find(record=>payload.viewId?record.viewId===payload.viewId:payload.relPath?record.relPath===payload.relPath:record.kind==='document')??(!payload.viewId&&!payload.relPath?candidates[0]:null);
    if(!record||record.projectId!==scope.projectId)throw fail('DEMO_SURFACE_NOT_READY','请先打开当前章节对应的真实内容面。');
    if(reportCommand){
      // Single-content mode backgrounds earlier views instead of tabbing them;
      // 'activate' re-attaches an orphaned report view instead of failing.
      const found=findView(layout,record.viewId),groups=layoutGroups(layout,'main');
      const groupId=found?.group.id??groups.find(group=>group.activeViewId)?.id??groups[0]?.id;
      if(!groupId)throw fail('DEMO_SURFACE_NOT_READY','没有可用的主工作区分区。');
      await manager.bound(payload,{playing:true});
      await this.command(scope,{projectId:payload.projectId,expectedRevision:layout.revision,requestKey:randomUUID(),command:{type:'activate',viewId:record.viewId,groupId}});
    }
    const requestId=randomUUID(),generation=record.generation,sessionId=row.session.id,epoch=row.session.epoch;
    this.demoRequests??=new Map();
    await manager.acceptAction(row,{requestId,command:payload.command,viewId:record.viewId,generation,sessionId,epoch,relPath:payload.relPath});
    if(row.session.status!=='playing'||row.session.epoch!==epoch||record.dead||record.generation!==generation){await manager.settleAction(row,requestId,{ok:false,error:{code:'DEMO_PAUSED',message:'发送动作前会话已暂停或内容面已变化。'}});throw fail('DEMO_PAUSED');}
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.demoRequests.delete(requestId);void manager.settleAction(row,requestId,{ok:false,error:{code:'DEMO_ACTION_TIMEOUT',message:'真实内容面未确认动作，未自动重放。'}}).finally(()=>reject(fail('DEMO_ACTION_TIMEOUT','真实内容面未确认动作。')));},15000);
      this.demoRequests.set(requestId,{record,generation,sessionId,epoch,manager,row,resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      try{record.wc.send('nozeli:workspace-control',{type:'demo-action',projectId:record.projectId,viewId:record.viewId,generation,sessionId,epoch,requestId,command:payload.command,args:payload.args??{},relPath:payload.relPath});}
      catch(error){clearTimeout(timer);this.demoRequests.delete(requestId);void manager.settleAction(row,requestId,{ok:false,error:{code:'DEMO_SURFACE_GONE',message:error.message}}).finally(()=>reject(error));}
    });
  }
  async demoActionResult(scope,payload,manager){
    const pending=this.demoRequests?.get(payload.requestId);
    if(!pending||pending.manager!==manager||pending.record!==scope||pending.generation!==scope.generation||pending.sessionId!==payload.sessionId||pending.epoch!==payload.epoch||scope.projectId!==payload.projectId||scope.dead)throw fail('DEMO_RECEIPT_DENIED','动作回执不属于原内容面、项目或演示会话。');
    if(typeof payload.ok!=='boolean'||Buffer.byteLength(JSON.stringify(payload))>131072)throw fail('DEMO_RECEIPT_INVALID','演示动作回执无效。');
    this.demoRequests.delete(payload.requestId);
    const result={ok:payload.ok,source:'demo-fixture',projectId:scope.projectId,sessionId:payload.sessionId,epoch:payload.epoch,viewId:scope.viewId,generation:scope.generation,requestId:payload.requestId,value:payload.value,error:payload.error};
    await manager.settleAction(pending.row,payload.requestId,result);pending.resolve(result);return {accepted:true};
  }
  async requireConversation(projectId,target='frontdesk',{notify=true}={}){
    if(!this.ensureConversation)return;
    try{await this.ensureConversation(projectId,target);}
    catch(error){if(notify)this.broadcast('nozeli:workspace-control',{type:'conversation-unavailable',projectId,target,error:{code:error.code||'AGENT_NOT_READY',message:error.message}},projectId);throw error;}
  }
  async conversationState(projectId,state){
    if(this.guidedDemo?.isDemo(projectId))return;
    const owner=[...this.surfaces.values()].find(s=>s.projectId===projectId&&s.kind==='conversation'&&s.conversationAdmitted&&!s.dead);
    if(!owner||owner.transferring||this.conversationClosing?.has(projectId))return;
    if(this.windows.get(owner.windowId)?.projectHidden)return;
    if(state?.configuringTargets?.includes(owner.conversationTarget||'frontdesk'))return;
    const agent=state?.agents?.find(a=>a.target===(owner.conversationTarget||'frontdesk'));
    if(agent?.starting)return;
    if(agent&&!agent.closed&&!agent.restarting&&['ready','idle','prompt-inflight'].includes(agent.phase))return;
    this.conversationClosing??=new Set();this.conversationClosing.add(projectId);
    const error={code:'AGENT_DISCONNECTED',message:'当前会话连接已中断；草稿保留，未发送。请重试连接。'};
    owner.conversationBlocked=true;owner.view.setVisible(false);owner.wc.send('nozeli:workspace-control',{type:'conversation-unavailable',projectId,error});
    try{const root=this.windows.get(owner.windowId);if(root&&!root.dead){await this.command(root,{projectId,expectedRevision:(await this.layout(projectId)).revision,requestKey:randomUUID(),command:{type:'closeContent',viewId:owner.viewId}});}}
    catch(failure){this.onError(failure);}
    finally{this.conversationClosing.delete(projectId);if((!this.shell||this.shell.dead)&&this.restoreShell)await this.restoreShell();this.broadcast('nozeli:workspace-control',{type:'conversation-unavailable',projectId,error},projectId);}
  }
  register(wc, scope) {
    const record = { ...scope, wc, generation: 0, recoveryOwner:randomUUID(), ready: false, dead: false };
    this.senders.set(wc.id, record);
    wc.on('before-input-event',(_event,input)=>{if(!['shell','demo-controls'].includes(record.role)&&input.type==='keyDown')void this.guidedDemo?.pauseProject(record.projectId,'用户操作了真实内容面，演示已暂停。').catch(this.onError);});
    wc.on('focus',()=>{if(record.role==='surface'){const root=this.windows.get(record.windowId);if(root&&!root.dead)root.wc.send('nozeli:workspace-control',{type:'surface-focus',viewId:record.viewId,projectId:record.projectId});}});
    wc.on('before-input-event',(event,input)=>{if(record.role!=='surface'||input.type!=='keyDown'||input.isComposing)return;const numbered=(input.control||input.meta)&&!input.alt&&!input.shift&&/^[1-9]$/.test(input.key),cycle=input.key==='F6'&&!input.control&&!input.meta&&!input.alt;if(!numbered&&!cycle)return;const root=this.windows.get(record.windowId);if(!root||root.dead||root.projectId!==record.projectId)return;event.preventDefault();root.wc.send('nozeli:workspace-control',{type:'group-focus',projectId:record.projectId,viewId:record.viewId,...(numbered?{index:Number(input.key)-1}:{direction:input.shift?-1:1})});});
    wc.on('before-input-event',(event,input)=>{if(record.role!=='surface'||input.type!=='keyDown'||input.isComposing)return;const quick=(input.control||input.meta)&&!input.alt&&!input.shift&&input.key.toLowerCase()==='p';if(!quick)return;const root=this.windows.get(record.windowId);if(!root||root.dead)return;event.preventDefault();root.wc.send('nozeli:workspace-control',{type:'quick-open',projectId:record.projectId,viewId:record.viewId});});
    wc.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => { if (url !== (record.role==='demo-controls'?this.origin+'guided-demo-controls.html':this.origin)) event.preventDefault(); });
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('did-start-navigation', (_event, _url, _inPlace, main) => {
      if (!main) return;
      this.isolatedPreview?.closeScope(record);
      if(record.role==='demo-controls'&&record.ready)this.demoControls.reloading(record);
      record.generation++; record.ready = false;
      if(record.role==='shell'){this.demoControls.record?.view.setVisible(false);this.demoControls.hintRecord?.view.setVisible(false);}
      record.boundsSequence=0;
      this.cancelDrags(record);
      if (record.role !== 'surface') for (const surface of this.projectRecords(record.projectId, record.windowId)) surface.view.setVisible(false);
      for (const [id, receipt] of this.receipts) if (receipt.record === record) { receipt.reject(fail('SURFACE_RELOADED')); this.receipts.delete(id); }
    });
    wc.on('render-process-gone', (_event, details) => {
      if(record.role==='demo-controls'){this.demoControls.failed(record,Error('演示控制区进程已退出：'+details.reason));return;}
      if(record.role==='demo-hint'){this.demoControls.hintFailed(record,Error('演示提示进程已退出：'+details.reason));return;}
      if(record.role!=='surface')for(const surface of this.projectRecords(record.projectId,record.windowId))surface.view.setVisible(false);
      record.ready = false; record.generation++;
      this.cancelDrags(record);
      for (const [id, receipt] of this.receipts) if (receipt.record === record) { receipt.reject(fail('RENDERER_GONE')); this.receipts.delete(id); }
      this.recover?.(record, details);
    });
    wc.once('destroyed', () => {
      this.isolatedPreview?.closeScope(record);
      record.dead = true; this.senders.delete(wc.id);
      for (const [id, receipt] of this.receipts) if (receipt.record === record) { receipt.reject(fail('SURFACE_DESTROYED')); this.receipts.delete(id); }
      this.cancelDrags(record);
    });
    return record;
  }
  registerShell(win) {
    this.shell = this.register(win.webContents, { role: 'shell', windowId: 'main', projectId: null, win });
    this.windows.set('main', this.shell);
    return this.shell;
  }
  async resolvePayload(record,op,payload){
    if(record.role!=='surface'||!['annotation.remove','annotation.update'].includes(op))return payload;
    if(payload.projectId!==record.projectId)throw fail('PROJECT_SCOPE_DENIED');
    const store=await this.host.tagStore(record.projectId),sidecar=(await store.all()).find(file=>file.tags.some(tag=>tag.id===payload.annotationId));
    if(!sidecar)throw fail('NOT_FOUND','Annotation was not found.');
    const relPath=sidecar.file.relPath;
    if(relPath!==record.relPath||payload.relPath!==undefined&&payload.relPath!==relPath)throw fail('EDIT_LEASE_DENIED');
    return {...payload,relPath};
  }
  authorize(event, op, payload = {}) {
    const r = this.senders.get(event.sender?.id), frame = event.senderFrame;
    const expected=r?.role==='demo-controls'?this.origin+'guided-demo-controls.html':r?.role==='demo-hint'?this.origin+'guided-demo-hint.html':this.origin;
    if (!r || r.dead || !frame || frame.parent != null || frame !== event.sender.mainFrame || frame.url !== expected) throw fail('IPC_DENIED');
    if (typeof op !== 'string') throw fail('UNKNOWN_OP');
    if(r.role==='demo-controls'){if(!this.demoControls.owns(r)||!this.demoControls.allowed(op))throw fail('IPC_DENIED');return r;}
    if(r.role==='demo-hint'){if(!this.demoControls.hintOwns(r)||!this.demoControls.hintAllowed(op))throw fail('IPC_DENIED');return r;}
    if (payload.projectId && payload.projectId !== r.projectId && !(r.role === 'shell' && (['demo.state','demo.exit','managed.status','managed.attention.ack','workspace.project','workspace.closeProject','workspace.recovery.object','workspace.recovery.settle','project.open','project.remove','project.retry','project.lifecycle.preview','project.lifecycle.reconcile'].includes(op)||op==='demo.transition'&&payload.action==='stop'))) throw fail('PROJECT_SCOPE_DENIED');
    if(op.startsWith('demo.')){if(op==='demo.result'){if(!['surface','shell','detached'].includes(r.role))throw fail('IPC_DENIED');}else if(!['demo.state','demo.send','demo.interrupt'].includes(op)&&r.role!=='shell')throw fail('IPC_DENIED');return r;}
    if(r.role==='surface'&&r.kind==='terminal'&&op.startsWith('managed.')&&(op!=='managed.terminal.screen'||payload.target!==this.layouts.get(r.projectId)?.views[r.viewId]?.viewState?.workId))throw fail('IPC_DENIED');
    if (this.lifecycle.has(r.projectId) && !this.lifecycleFlushOwner(r,payload.flushRequestId,op) && (writes.has(op) || op === 'managed.send' || ['managed.attention.respond','managed.attention.draft.write'].includes(op) || op === 'workspace.project' || op === 'workspace.command'&&payload.command?.type!=='restoreViewState')) throw fail('PROJECT_LIFECYCLE_ACTIVE', '项目正在保留并关闭，请等待操作结果。');
    if(op==='report.copySource'&&!(r.role==='shell'||r.role==='surface'&&['report','history'].includes(r.kind)))throw fail('IPC_DENIED');
    if(op.startsWith('isolated-preview.')&&r.role==='surface'&&(!['report','document','history'].includes(r.kind)||r.kind==='history'&&['isolated-preview.open','isolated-preview.update'].includes(op)&&payload.profile!=='staticReport'))throw fail('IPC_DENIED');
    if (r.role !== 'shell' && !op.startsWith('workspace.') && !op.startsWith('isolated-preview.') && !surfaceOps.test(op)) throw fail('IPC_DENIED');
    if (r.role === 'detached' && !op.startsWith('workspace.') && !['project.open','project.list','project.children','project.search','config.status','settings.appearance.read','session.flushed','session.requestClose','session.quitChoice','state.read','view.authorship','managed.status','managed.timeline.request','managed.timeline.read'].includes(op) && !(op==='managed.send'&&payload.target==='frontdesk'&&r.drawingConversationProject===r.projectId)) throw fail('IPC_DENIED');
    if (r.role === 'surface' && (writes.has(op) || op === 'ppt.export' || op === 'ppt.draft' && payload.model !== undefined)) {
      const lease = this.leases.get(this.resource(r.projectId, r.relPath));
      if (!lease || lease.viewId !== r.viewId || payload.relPath !== r.relPath || lease.generation !== r.generation) throw fail('EDIT_LEASE_DENIED');
    }
    if (writes.has(op) && r.role !== 'surface' && payload.relPath && this.leases.has(this.resource(r.projectId,payload.relPath))) throw fail('EDIT_LEASE_DENIED');
    const mutatesDocument=writes.has(op)||op==='ppt.export'||op==='ppt.draft'&&payload.model!==undefined;
    if ((r.held||r.recoveryHeld||r.syncHolds?.size) && mutatesDocument) throw fail('TRANSFER_HELD');
    if (r.held && op.startsWith('managed.') && !['managed.status','managed.history.list','managed.history.read','managed.artifact.read','managed.artifact.list','managed.timeline.page','managed.timeline.read','managed.disposition'].includes(op)) throw fail('TRANSFER_HELD');
    if (r.role === 'surface' && op === 'managed.draft' && r.kind !== 'conversation') throw fail('CONVERSATION_OWNER_REQUIRED');
    if(op==='managed.frontdesk.context.clear'&&r.role!=='shell'&&!(r.role==='surface'&&r.kind==='conversation'&&payload.projectId===r.projectId))throw fail('CONVERSATION_OWNER_REQUIRED');
    if (r.role !== 'shell' && op === 'managed.enable') throw fail('IPC_DENIED');
    return r;
  }
  resource(projectId, relPath) { return `${projectId}\0${relPath}`; }
  async layout(projectId) {
    if (!projectId || typeof projectId !== 'string') throw fail('INVALID_PROJECT');
    await this.host.requireRegisteredProject(projectId);
    if (this.layouts.has(projectId)) return this.layouts.get(projectId);
    const saved = await this.host.storage.getLocal(projectId, 'workspace:layout');
    const value = saved ? singleContentLayout(saved) : createLayout(projectId);
    if (value.projectId !== projectId) throw fail('INVALID_LAYOUT');
    this.layouts.set(projectId, value); return value;
  }
  async persist(layout) {
    await this.host.requireRegisteredProject(layout.projectId);
    validateLayout(layout);
    await this.host.storage.putLocal(layout.projectId, 'workspace:layout', layout);
  }
  serial(projectId, work) {
    const next = (this.queues.get(projectId) || Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(projectId, next); return next.finally(() => { if (this.queues.get(projectId) === next) this.queues.delete(projectId); });
  }
  bootstrap(r) {
    if(r.role==='demo-controls')return this.demoControls.state();
    if(r.role==='demo-hint')return this.demoControls.hintState();
    const descriptor=this.layouts.get(r.projectId)?.views[r.viewId];
    if (r.role === 'surface' && r.relPath && !descriptor?.readOnly) {
      const key = this.resource(r.projectId, r.relPath), lease = this.leases.get(key);
      if (!lease || lease.viewId === r.viewId && lease.generation !== r.generation) this.leases.set(key, { resourceId: key, viewId: r.viewId, windowId: r.windowId, generation: r.generation, epoch: ++this.epoch });
      r.readOnly = this.leases.get(key)?.viewId !== r.viewId;
    }else if(descriptor?.readOnly)r.readOnly=true;
    const viewState=this.layouts.get(r.projectId)?.views[r.viewId]?.viewState;
    return { role: r.role, projectId: r.projectId, viewId: r.viewId, kind: r.kind, relPath: r.relPath, windowId: r.windowId, generation: r.generation, readOnly: !!r.readOnly, draftOnly:viewState?.draftOnly===true, viewState, lease: r.relPath ? this.leases.get(this.resource(r.projectId, r.relPath)) : null };
  }
  flush(records) { return Promise.all([...new Set(records)].filter(r => !r.dead&&!['demo-controls','demo-hint'].includes(r.role)).map(r => this.flushOne(r))).then(() => this.host.settled()); }
  async flushOne(record, channel = 'nozeli:flush', detail = {}) {
    if(!record.ready&&record.role==='surface'&&!record.dead){await new Promise((resolve,reject)=>{const generation=record.generation,timer=setTimeout(()=>{record.wc.removeListener('nozeli-content-ready',ready);reject(fail('SURFACE_NOT_READY'));},10000);const ready=()=>{clearTimeout(timer);record.dead||record.generation!==generation?reject(fail('SURFACE_CHANGED')):resolve();};record.wc.once('nozeli-content-ready',ready);});}
    if (!record.ready) throw fail('SURFACE_NOT_READY');
    const requestId = randomUUID(), generation = record.generation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.receipts.delete(requestId); reject(Object.assign(fail('FLUSH_TIMEOUT'),{requestId})); }, 10000);
      const lifecycleHold=this.host.storage.lifecycleHolds.get(record.projectId);
      this.receipts.set(requestId, { record, generation, lifecycleHold, hold:channel==='nozeli:document-sync'&&detail.hold, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer);error.requestId=requestId; reject(error); } });
      try { record.wc.send(channel, channel === 'nozeli:flush' ? requestId : { ...detail, requestId }); }
      catch (error) { this.receipts.get(requestId)?.reject(error); this.receipts.delete(requestId); }
    });
  }
  lifecycleFlushOwner(record,requestId,op){
    if(op!=='workspace.recovery')return null;
    const receipt=this.receipts.get(requestId);
    if(!receipt||receipt.record!==record||receipt.generation!==record.generation||record.dead||!receipt.lifecycleHold||this.host.storage.lifecycleHolds.get(record.projectId)!==receipt.lifecycleHold)return null;
    return receipt.lifecycleHold;
  }
  assertRecoveryAdmission(record,op,payload){
    if(op==='workspace.recovery'&&this.host.storage.lifecycleHolds.has(record.projectId)&&!this.lifecycleFlushOwner(record,payload?.flushRequestId,op))throw fail('PROJECT_LIFECYCLE_ACTIVE','项目停稳期间仅接受当前保存回执的恢复内容。');
  }
  acknowledge(record, payload, result = payload) {
    const p = this.receipts.get(payload?.requestId);
    if (!p || p.record !== record || p.generation !== record.generation) return { accepted: false };
    this.receipts.delete(payload.requestId);
    if (result?.ok && !result?.composing) {if(p.hold)(record.syncHolds??=new Set()).add(payload.requestId);p.resolve({...result,requestId:payload.requestId});}else p.reject(fail(result?.composing ? 'COMPOSITION_ACTIVE' : result?.error?.code || 'FLUSH_FAILED', result?.error?.message));
    return { accepted: true };
  }
  async syncDocument({ projectId, relPath, hold, captureBuffer = false }) {
    const owner = [...this.surfaces.values()].find(r => r.projectId === projectId && r.relPath === relPath && this.leases.get(this.resource(projectId, relPath))?.viewId === r.viewId);
    if (!owner) return () => {};
    let requestId;
    const release=()=>{if(requestId){owner.syncHolds?.delete(requestId);if(!owner.dead)owner.wc.send('nozeli:document-release',requestId);}};
    try{const result=await this.flushOne(owner,'nozeli:document-sync',{projectId,relPath,hold,captureBuffer});requestId=result.requestId;return release;}
    catch(error){requestId=error.requestId;release();throw error;}
  }
  projectRecords(projectId, windowId) { return [...this.surfaces.values()].filter(r => r.projectId === projectId && (windowId === undefined || r.windowId === windowId)); }
  broadcast(channel, payload, projectId) {
    for (const r of this.senders.values()) if (!r.dead && (!projectId || r.projectId === projectId)) r.wc.send(channel, payload);
  }
  changed(layout) { for (const r of this.windows.values()) if (r.projectId === layout.projectId && !r.dead) r.wc.send('nozeli:workspace-changed', { layout, windowId: r.windowId }); }
  async mutateTree(payload, operation) {
    if(!['rename','cut','trash'].includes(payload.action))return operation();
    return this.serial(payload.projectId,async()=>{
      const layout=await this.layout(payload.projectId),inside=rel=>rel===payload.source||rel.startsWith(payload.source+'/');
      const affected=this.projectRecords(payload.projectId).filter(s=>s.relPath&&inside(s.relPath));
      for(const s of affected){s.transferring=true;s.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:true});}
      let moved=false;
      try{
        await this.flush(affected);for(const s of affected)s.held=true;
        if(payload.action==='trash')for(const s of affected){
          const file=await this.host.readFile(s.projectId,s.relPath);
          if(file.diskPresent===false||typeof file.digest!=='string'||!file.digest)throw fail('RESOURCE_MISSING','Cannot verify the original file before moving it to trash.');
          s.missingDigest=file.digest;
        }
        const result=await operation();moved=true;
        let next=layout;
        if(payload.action==='trash'){
          for(const s of affected){s.recoveryHeld=true;s.wc.send('nozeli:workspace-control',{type:'document-missing',projectId:s.projectId,viewId:s.viewId,relPath:s.relPath});}
        }else if(result.from&&result.relPath)next=reduceLayout(layout,{type:'renameResource',from:result.from,to:result.relPath});
        for(const s of affected){
          const view=next.views[s.viewId];if(!view)continue;
          const old=s.relPath,key=this.resource(s.projectId,old),lease=this.leases.get(key);
          s.relPath=view.relPath;if(lease?.viewId===s.viewId){this.leases.delete(key);lease.resourceId=this.resource(s.projectId,s.relPath);this.leases.set(lease.resourceId,lease);}
          if(s.pendingViewState&&next.views[s.viewId]){next.views[s.viewId].viewState=s.pendingViewState;s.pendingViewState=null;}
          s.wc.send('nozeli:workspace-control',{type:'document-renamed',from:old,relPath:s.relPath,projectId:s.projectId,viewId:s.viewId});
        }
        this.layouts.set(payload.projectId,next);await this.persist(next);await this.reconcile(next);this.changed(next);return result;
      }catch(error){if(moved){for(const s of affected)s.recoveryHeld=true;}throw error;}
      finally{for(const s of affected){s.transferring=false;s.held=!!s.recoveryHeld;if(!s.dead)s.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:s.held});}}
    });
  }
  async closeProject(projectId, {operationId = randomUUID()} = {}) {
    if (typeof operationId !== 'string' || !operationId || operationId.length > 160) throw fail('INVALID_OPERATION_ID');
    await this.guidedDemo?.pauseProject(projectId,'演示项目正在关闭，已暂停自动动作。');
    const input = JSON.stringify({action:'close-project',projectId,operationId});
    const previous = this.lifecycle.get(projectId);
    if (previous) {
      if (previous.operationId !== operationId || previous.input !== input) throw fail('PROJECT_LIFECYCLE_ACTIVE', '该项目已有不同的生命周期操作。');
      return previous.promise;
    }
    const operation = {operationId,input};
    operation.promise = (async () => {
      await this.host.requireRegisteredProject(projectId);
      const key = `lifecycle:close:${operationId}`;
      const prior = await this.host.storage.getRecovery(projectId,key);
      if (prior) {
        if (prior.input !== input) throw fail('OPERATION_ID_REUSED');
        if (prior.phase === 'complete') return prior.result;
        throw fail(prior.error?.code || 'PROJECT_CLOSE_PENDING', prior.error?.message || '已有关闭操作尚待核查；未重复冲刷。');
      }
      await this.host.storage.putRecovery(projectId,key,{action:'close-project',projectId,operationId,input,phase:'preparing'});
      const records = this.projectRecords(projectId);
      if (records.some(record => record.previewRecoveryFailed)) throw fail('TRANSFER_RECOVERY_REQUIRED', '报告恢复未确认，不能关闭项目。');
      const shell = this.shell?.projectId === projectId ? this.shell : null;
      // Hold input while capturing; restore it if any owner cannot persist.
      for (const record of [...records, ...(shell ? [shell] : [])]) record.wc.send('nozeli:workspace-control', {type:'lifecycle-hold', held:true, operationId});
      try {
        const results = await Promise.allSettled([...records, ...(shell ? [shell] : [])].map(record => this.flushOne(record)));
        const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{viewId:records[index]?.viewId ?? 'shell', code:result.reason.code, message:result.reason.message}] : []);
        if (failures.length) throw Object.assign(fail('PROJECT_FLUSH_FAILED', '部分内容未能保存到本机，项目保持打开。'), {failures});
        await this.host.settled();
        await this.host.storage.putRecovery(projectId,key,{action:'close-project',projectId,operationId,input,phase:'captured',receipts:results.map((result,index)=>({owner:records[index]?.viewId??'shell',result:result.value}))});
        for (const record of records) this.destroySurface(record);
        for (const [id, root] of this.windows) if (id !== 'main' && root.projectId === projectId) { root.closing = true; root.win.destroy(); this.windows.delete(id); }
        if (shell) { this.isolatedPreview?.closeScope(shell); shell.projectId = null; shell.wc.send('nozeli:workspace-control', {type:'project-closed', projectId, operationId}); }
        if (this.activeProjectId === projectId) this.activeProjectId = null;
        const result = {closed:true, projectId, operationId};
        await this.host.storage.putRecovery(projectId,key,{action:'close-project',projectId,operationId,input,phase:'complete',result});
        return result;
      } catch (error) {
        await this.host.storage.putRecovery(projectId,key,{action:'close-project',projectId,operationId,input,phase:'needs-attention',error:{code:error.code||'ERROR',message:error.message}}).catch(()=>{});
        for (const record of [...records, ...(shell ? [shell] : [])]) if (!record.dead) record.wc.send('nozeli:workspace-control', {type:'lifecycle-hold', held:false, operationId});
        throw error;
      }
    })();
    this.lifecycle.set(projectId, operation);
    try { return await operation.promise; } finally { if (this.lifecycle.get(projectId) === operation) this.lifecycle.delete(projectId); }
  }
  async saveRecovery(record, payload) {
    if (payload.projectId !== record.projectId || record.role === 'surface' && payload.viewId !== record.viewId) throw fail('PROJECT_SCOPE_DENIED');
    if (record.role === 'surface' && record.readOnly) throw fail('EDIT_LEASE_DENIED');
    await this.host.requireRegisteredProject(payload.projectId);
    if (!Number.isSafeInteger(payload.generation) || payload.generation < 0) throw fail('INVALID_RECOVERY_GENERATION');
    const key = `workspace:${record.viewId || record.role}`;
    const generation = record.generation;
    const snapshot=structuredClone(payload);
    snapshot.candidate=await normalizeOfficeRecovery(snapshot.kind,snapshot.candidate);
    return this.serial(`recovery:${record.projectId}`, async () => {
      const prior = await this.host.storage.getRecovery(record.projectId, key);
      if (record.dead || record.generation !== generation) throw fail('SURFACE_CHANGED');
      const ownerGeneration = `${record.recoveryOwner}:${record.generation}`;
      if (prior?.ownerGeneration === ownerGeneration && prior.generation > payload.generation) return {retained:true, generation:prior.generation};
      if (prior && prior.ownerGeneration !== ownerGeneration) await this.host.storage.putRecovery(record.projectId, `${key}:retained:${prior.ownerGeneration}`, prior);
      await this.host.storage.putRecovery(record.projectId, key, {...snapshot, ownerGeneration, retainedAt:new Date().toISOString()});
      return {retained:true, generation:payload.generation};
    });
  }
  async bindProject(r, projectId) {
    if (r.role !== 'shell') throw fail('IPC_DENIED');
    this.host.storage.assertActive(projectId);
    const work=async()=>{
      const generation=r.generation, previousProjectId=r.projectId;
      if(previousProjectId&&previousProjectId!==projectId)await this.guidedDemo?.pauseProject(previousProjectId,'离开演示项目，自动操作已暂停。');
      const owners=previousProjectId&&previousProjectId!==projectId?[r,...this.projectRecords(previousProjectId)]:[];
      if(owners.some(owner=>owner.previewRecoveryFailed))throw fail('TRANSFER_RECOVERY_REQUIRED','报告恢复未确认，原项目保持打开。');
      const originalSurfaces=new Set(this.surfaces.values()), originalWindows=new Set(this.windows.values());
      try{
      for(const owner of owners)owner.wc.send('nozeli:workspace-control',{type:'lifecycle-hold',held:true});
      const saved=await Promise.allSettled(owners.map(owner=>this.flushOne(owner)));
      await this.host.settled();
      const refused=saved.find(result=>result.status==='rejected');if(refused)throw refused.reason;
      let layout=await this.layout(projectId);
      for(const view of Object.values(layout.views))if(view.kind==='conversation'&&!view.viewState?.draftOnly&&findView(layout,view.id)){
        try{await this.requireConversation(projectId,'frontdesk');}catch{layout=reduceLayout(layout,{type:'closeContent',viewId:view.id});await this.persist(layout);this.layouts.set(projectId,layout);}
      }
      if(r.dead||r.generation!==generation)throw fail('SHELL_CHANGED');
      this.host.storage.assertActive(projectId);
      // Stage destination views without changing the shell identity or destroying
      // source renderers. A failed native attachment leaves the entire A scene alive.
      await this.reconcile(layout,{binding:r});
      if(r.dead||r.generation!==generation||r.projectId!==previousProjectId)throw fail('SHELL_CHANGED');
      this.host.storage.assertActive(projectId);
      // Recovery receipts protect durability; keep the actual editing scene too.
      // Returning to A must reuse its unsaved editor, not reopen only disk bytes.
      for(const surface of this.surfaces.values())if(surface.windowId==='main'){
        surface.view.setVisible(false);
        for(const slot of this.isolatedPreview?.slots.values()??[])if(slot.scope===surface)slot.view.setVisible(false);
      }
      if(previousProjectId!==projectId)this.isolatedPreview?.closeScope(r);
      r.projectId=projectId;this.projectVisibility(projectId);this.changed(layout);return {layout,windowId:r.windowId};
      }catch(error){
        for(const surface of [...this.surfaces.values()])if(!originalSurfaces.has(surface))this.destroySurface(surface);
        for(const [id,root] of this.windows)if(!originalWindows.has(root)){root.closing=true;root.win.destroy();this.windows.delete(id);}
        throw error;
      }finally{
        for(const owner of owners)if(!owner.dead)try{owner.wc.send('nozeli:workspace-control',{type:'lifecycle-hold',held:false});}catch(error){this.onError(error);}
      }
    };
    const pending=(r.bindPending||Promise.resolve()).catch(()=>{}).then(work);r.bindPending=pending;
    return pending.finally(()=>{if(r.bindPending===pending)r.bindPending=null;});
  }
  projectVisibility(projectId){this.activeProjectId=projectId;for(const root of this.windows.values()){if(root.windowId==='main'||root.dead||root.win.isDestroyed())continue;const visible=root.projectId===projectId;root.projectHidden=!visible;if(!visible)root.win.hide();else if(!this.hidden){if(typeof root.win.showInactive==='function')root.win.showInactive();else root.win.show();}}}
  currentWindowCount(){const projectId=this.shell&&!this.shell.dead?this.shell.projectId:this.activeProjectId;return [...this.windows.values()].filter(root=>!root.dead&&(root.windowId==='main'||!projectId||root.projectId===projectId)).length;}
  scheduleBounds(r) {
    if(r.closing||r.dead||!r.ready||r.win.isDestroyed())return;
    r.boundsDirty=true;
    clearTimeout(r.boundsTimer);
    r.boundsTimer=setTimeout(()=>{r.boundsTimer=null;void this.saveBounds(r).catch(this.onError);},150);
    r.boundsTimer.unref?.();
  }
  async saveBounds(r) {
    if(r.boundsSaving||!r.boundsDirty)return;
    r.boundsDirty=false;r.boundsSaving=true;
    try {
      await this.serial(r.projectId,async()=>{
        if(r.closing||r.dead||!r.ready||r.win.isDestroyed())return;
        const current=await this.layout(r.projectId),item=current.detached.find(w=>w.id===r.windowId);
        if(!item)return;
        const boundsDip=r.win.getBounds(),alwaysOnTop=r.win.isAlwaysOnTop();
        if(item.alwaysOnTop===alwaysOnTop&&['x','y','width','height'].every(key=>item.boundsDip?.[key]===boundsDip[key]))return;
        const next=reduceLayout(current,{type:'windowBounds',windowId:r.windowId,boundsDip,alwaysOnTop});
        await this.persist(next);this.layouts.set(r.projectId,next);this.changed(next);
      });
    } finally {
      r.boundsSaving=false;
      if(r.boundsDirty)this.scheduleBounds(r);
    }
  }
  async detached(layout, item) {
    const old = this.windows.get(item.id); if (old) return old;
    const win = new this.BrowserWindow({ ...restoreBounds(item.boundsDip, this.screen), frame:false, icon:this.icon, show: false, title: 'Nozeli', alwaysOnTop: !!item.alwaysOnTop, webPreferences: this.preferences });
    win.setMenu?.(null);win.setMenuBarVisibility?.(false);
    const r = this.register(win.webContents, { role: 'detached', projectId: layout.projectId, windowId: item.id, win });
    this.windows.set(item.id, r);
    this.setupWindow?.(r);
    win.on('close', event => { if (r.closing) return; event.preventDefault(); void this.closeWindow(r).catch(this.onError); });
    const saveBounds=()=>this.scheduleBounds(r);
    win.on('moved',saveBounds);win.on('resized',saveBounds);
    win.on('resize',()=>{if(!r.dead)r.wc.send('nozeli:workspace-control',{type:'viewport-changed'});});
    win.on('closed', () => { clearTimeout(r.boundsTimer); this.windows.delete(item.id); });
    let timer;
    const ready = new Promise((resolve, reject) => { r.readyResolve = resolve; timer = setTimeout(() => reject(fail('WINDOW_NOT_READY')), 10000); });
    try { await win.loadURL(this.origin); await ready; const active=this.shell&&!this.shell.dead?this.shell.projectId:layout.projectId;r.projectHidden=active!==layout.projectId;const committed=this.layouts.get(layout.projectId)?.detached.some(w=>w.id===item.id);if(committed&&!this.hidden&&!r.projectHidden)win.show();return r; }
    catch (error) { r.closing = true; win.destroy(); throw error; }
    finally { clearTimeout(timer); }
  }
  async reconcile(layout,{binding}={}) {
    // Binding admits a scene; layout commands own resident transfers and rollback.
    // Reject stale target parents before changing existing guests or visibility.
    if(binding)for(const surface of this.projectRecords(layout.projectId)){
      const found=findView(layout,surface.viewId);
      if(found&&surface.windowId!==found.windowId)throw fail('SURFACE_LOCATION_CHANGED','目标项目的工作面位置已变化，原项目保持打开；请重试切换。');
    }
    for (const item of layout.detached) await this.detached(layout, item);
    for (const view of Object.values(layout.views)) {
      const found = findView(layout, view.id);if(!found)continue;const destination = this.windows.get(found.windowId);
      if (!destination || destination.projectId !== layout.projectId && destination !== binding) continue;
      if(view.kind==='conversation'&&!view.viewState?.draftOnly&&!this.surfaces.has(view.id)){
        try{await this.requireConversation(layout.projectId,'frontdesk');}catch{continue;}
      }
      let r = this.surfaces.get(view.id);
      if (!r) {
        const nativeView = new this.WebContentsView({ webPreferences: this.preferences });
        r = this.register(nativeView.webContents, { role: 'surface', viewId: view.id, projectId: layout.projectId, kind: view.kind, relPath: view.relPath, windowId: found.windowId, win: destination.win, view: nativeView });
        if(view.kind==='conversation'){r.conversationAdmitted=!view.viewState?.draftOnly;r.conversationTarget='frontdesk';}
        r.loading=true;
        this.surfaces.set(view.id, r); nativeView.setVisible(false);
        destination.win.contentView.addChildView(nativeView);
        const [initialWidth,initialHeight]=destination.win.getContentSize();nativeView.setBounds({x:0,y:0,width:Math.max(280,initialWidth),height:Math.max(180,initialHeight)});
        void nativeView.webContents.loadURL(this.origin).catch(error=>{r.ready=false;this.onError(error);});
      } else if (r.windowId !== found.windowId) {
        const previousWindow=r.win;
        r.view.setVisible(false); previousWindow.contentView.removeChildView(r.view); destination.win.contentView.addChildView(r.view);
        this.isolatedPreview?.reparentScope(r,destination.win);
        r.win = destination.win; r.windowId = found.windowId;
        const lease = this.leases.get(this.resource(r.projectId, r.relPath)); if (lease?.viewId === r.viewId) lease.windowId = r.windowId;
        r.wc.send('nozeli:workspace-control', { type: 'host', ...this.bootstrap(r) });
      }
    }
    if(binding)return;
    // Views pushed to a group's recent history stay resident (bounded) so switching back
    // reuses the same renderer; only closed or aged-out views release their surface.
    const resident=new Set();
    for(const windowId of ['main',...layout.detached.map(w=>w.id)])for(const g of layoutGroups(layout,windowId)){if(g.activeViewId)resident.add(g.activeViewId);for(const id of (g.historyViewIds||[]).slice(0,3))resident.add(id);}
    for (const [id, r] of this.surfaces) if (r.projectId === layout.projectId && !r.previewRecoveryFailed && (!layout.views[id]||!resident.has(id))) this.destroySurface(r);
    for (const [id, r] of this.windows) if (id !== 'main' && r.projectId === layout.projectId && !layout.detached.some(w => w.id === id) && !this.isolatedPreview?.holdsWindow(r.win)) { r.closing = true; r.win.destroy(); this.windows.delete(id); }
  }
  destroySurface(r) {
    if(r.previewRecoveryFailed)throw fail('TRANSFER_RECOVERY_REQUIRED','报告正文回滚未确认；不能销毁原生承载。');
    this.isolatedPreview?.closeScope(r);
    r.view.setVisible(false); if (!r.win.isDestroyed()) r.win.contentView.removeChildView(r.view);
    r.wc.close(); this.surfaces.delete(r.viewId);
    const key = this.resource(r.projectId, r.relPath); if (this.leases.get(key)?.viewId === r.viewId) this.leases.delete(key);
    if(!this.projectRecords(r.projectId).some(surface=>surface.relPath===r.relPath)){const retained=this.buffers.get(key);if(!retained?.dirty)this.buffers.delete(key);}
  }
  async command(r, payload) {
    if (r.role === 'surface' && payload.command?.type !== 'restoreViewState') throw fail('IPC_DENIED');
    if (payload.projectId !== r.projectId || r.role === 'surface' && payload.command.viewId !== r.viewId) throw fail('PROJECT_SCOPE_DENIED');
    if(payload.command?.type==='dock'){
      if(!this.shell||this.shell.dead)await this.restoreShell?.();
      if(!this.shell||this.shell.dead)throw fail('MAIN_WINDOW_UNAVAILABLE');
      if(this.shell.projectId!==payload.projectId){
        const shell=this.shell;
        // Do not hold serial(B) while the renderer restores B and writes its view.
        await new Promise((resolve,reject)=>{
          const activated=id=>{if(id===payload.projectId){clearTimeout(timer);shell.wc.removeListener('nozeli-project-activated',activated);resolve();}};
          const timer=setTimeout(()=>{shell.wc.removeListener('nozeli-project-activated',activated);reject(fail('PROJECT_SWITCH_UNCONFIRMED','原项目尚未确认保存与切换，未停靠。请检查主窗口保存提示后重试。'));},10000);
          shell.wc.on('nozeli-project-activated',activated);
          try{shell.wc.send('nozeli:workspace-control',{type:'project',projectId:payload.projectId});}catch(error){clearTimeout(timer);shell.wc.removeListener('nozeli-project-activated',activated);reject(error);}
        });
      }
    }
    return this.serial(payload.projectId, async () => {
      let layout = await this.layout(payload.projectId);
      if(r.role==='surface'&&r.transferring&&payload.command?.type==='restoreViewState'){r.pendingViewState=payload.command.viewState;return {layout,windowId:r.windowId};}
      if (!payload.requestKey || typeof payload.requestKey !== 'string' || payload.requestKey.length > 160) throw fail('INVALID_REQUEST_KEY');
      const requestId = `${r.wc.id}:${r.generation}:${payload.requestKey}`;
      const previous = this.requests.get(requestId);
      if (previous) { if (previous.input !== JSON.stringify(payload)) throw fail('REQUEST_KEY_REUSED'); return previous.result; }
      if (payload.expectedRevision !== layout.revision && !(r.role==='surface'&&payload.command?.type==='restoreViewState'&&payload.expectedRevision===undefined)) throw fail('LAYOUT_STALE');
      const command = { ...payload.command };
      if(command.type==='restoreViewState'&&layout.views[command.viewId]?.kind==='conversation'){
        const saved=layout.views[command.viewId].viewState??{},incoming=command.viewState??{};
        command.viewState={...incoming,draftOnly:saved.draftOnly,conversationMaterials:{...incoming.conversationMaterials,frontdesk:mergeDrawingMaterials(incoming.conversationMaterials?.frontdesk,saved.conversationMaterials?.frontdesk)}};
      }
      if(command.type==='open'&&command.view?.kind==='document'){
        const existing=Object.values(layout.views).find(v=>v.kind==='document'&&v.relPath===command.view.relPath&&!v.readOnly);
        if(existing){const target=command.groupId;for(const key of Object.keys(command))delete command[key];command.type='activate';command.viewId=existing.id;command.groupId=target;const owner=this.surfaces.get(existing.id);if(owner){owner.win.show();owner.win.focus();}}
      }
      if(command.type==='floatOpen')command.type='detach';
      if (command.type === 'detach') command.windowId = randomUUID();
      let next;
      if(command.type==='restoreLayout'){
        if(r.role==='surface')throw fail('IPC_DENIED');
        next=singleContentLayout(command.layout);
        if(next.projectId!==layout.projectId)throw fail('PROJECT_SCOPE_DENIED');
        const currentViews=structuredClone(layout.views),byResource=new Map(Object.values(currentViews).filter(view=>!view.sourceViewId).map(view=>[view.resourceId,view])),remapped=new Map(),savedViews={};
        for(const [id,view]of Object.entries(next.views)){
          const current=currentViews[id]??(!view.sourceViewId?byResource.get(view.resourceId):null);
          remapped.set(id,current?.id??id);savedViews[current?.id??id]=current??view;
        }
        next.views={...savedViews,...currentViews};
        for(const windowId of ['main',...next.detached.map(window=>window.id)])for(const pane of layoutGroups(next,windowId)){pane.views=pane.views.map(id=>remapped.get(id)??id);pane.activeViewId=remapped.get(pane.activeViewId)??pane.activeViewId;if(pane.historyViewIds)pane.historyViewIds=[...new Set(pane.historyViewIds.map(id=>remapped.get(id)??id))].filter(id=>next.views[id]&&!pane.views.includes(id));}
        for(const view of Object.values(next.views))if(view.sourceViewId)view.sourceViewId=remapped.get(view.sourceViewId)??view.sourceViewId;
        next.closedViews=structuredClone(layout.closedViews??[]);
        next.revision=layout.revision+1;validateLayout(next);
      }else next=reduceLayout(layout, command);
      if(command.type==='restoreViewState')next.revision=layout.revision;
      for(const view of Object.values(next.views))if(view.kind==='conversation'&&!view.viewState?.draftOnly&&findView(next,view.id)&&!findView(layout,view.id))await this.requireConversation(next.projectId,'frontdesk');
      const affected = this.projectRecords(layout.projectId).filter(s => {
        // Reading metadata cannot move or close a surface; flushing here can wait on the renderer that is awaiting this write.
        if(command.type==='restoreViewState')return false;
        const before = findView(layout, s.viewId), after = findView(next, s.viewId);
        return command.type==='restoreLayout' || !after || before?.windowId !== after.windowId;
      });
      if(affected.some(s=>s.previewRecoveryFailed))throw fail('TRANSFER_RECOVERY_REQUIRED','报告正文迁移回滚尚未确认；保留窗口与阅读现场，禁止继续迁移。');
      for(const s of affected){s.transferring=true;s.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:true});}
      const generations=new Map(affected.map(s=>[s,s.generation]));
      try { await this.flush(affected);for(const s of affected)s.held=true; }
      catch(error){for(const s of affected){s.transferring=false;if(!s.dead)s.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:!!s.recoveryHeld});this.persistPendingViewState(s);}throw error;}
      const prepared = [], staged = [], pendingStates=new Map();
      try {
        for (const item of next.detached) if (!this.windows.has(item.id)) { await this.detached(next, item); prepared.push(item.id); }
        for(const s of affected)if(s.pendingViewState&&next.views[s.viewId]){const state=s.pendingViewState;pendingStates.set(s,state);next.views[s.viewId].viewState=state;}
        if(r.dead||affected.some(s=>s.dead||s.generation!==generations.get(s)))throw fail('TRANSFER_SOURCE_CHANGED');
        for(const item of next.detached){const destination=this.windows.get(item.id);if(!destination||destination.dead||destination.win.isDestroyed())throw fail('TRANSFER_TARGET_CHANGED');}
        for(const s of affected){
          const location=findView(next,s.viewId);if(!location||location.windowId===s.windowId)continue;
          const destination=this.windows.get(location.windowId);
          if(!destination||destination.dead||destination.win.isDestroyed())throw fail('TRANSFER_TARGET_CHANGED');
          const move={surface:s,source:s.win,sourceWindowId:s.windowId,destination:destination.win,destinationWindowId:location.windowId,bounds:s.view.getBounds(),removed:false,attached:false};
          staged.push(move);destination.staging=(destination.staging||0)+1;
          s.view.setVisible(false);s.win.contentView.removeChildView(s.view);move.removed=true;
          destination.win.contentView.addChildView(s.view);move.attached=true;this.isolatedPreview?.reparentScope(s,destination.win);move.previewMoved=true;
        }
        await this.persist(next);
      } catch (error) {
        let rollbackFailed=error.previewRollbackFailed===true;const rollbackErrors=[];
        for(const move of staged.reverse()){
          const s=move.surface;
          try{
            if(move.removed){try{move.destination.contentView.removeChildView(s.view);}catch(removeError){if(move.attached)throw removeError;}
              move.source.contentView.addChildView(s.view);if(move.previewMoved)this.isolatedPreview?.reparentScope(s,move.source);}
            s.win=move.source;s.windowId=move.sourceWindowId;s.view.setBounds(move.bounds);
          }catch(rollbackError){rollbackFailed=true;s.recoveryHeld=true;this.isolatedPreview?.holdScope(s,[move.source,move.destination]);rollbackErrors.push(rollbackError);this.onError(rollbackError);}
          const target=this.windows.get(move.destinationWindowId);if(target)target.staging=Math.max(0,(target.staging||1)-1);
        }
        // Never destroy a prepared parent if native rollback could not confirm that its live child returned.
        if(!rollbackFailed)for(const id of prepared){const w=this.windows.get(id);if(w&&!this.isolatedPreview?.holdsWindow(w.win)){w.closing=true;w.win.destroy();this.windows.delete(id);}}
        for(const s of affected){s.transferring=false;s.held=!!s.recoveryHeld;if(!s.dead)s.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:s.held});this.persistPendingViewState(s);}
        this.changed(layout);if(rollbackErrors.length){const failure=new AggregateError([error,...rollbackErrors],'工作区迁移失败且回滚未确认；原生窗口和阅读现场已保留。原因：'+error.message,{cause:error});failure.code='TRANSFER_ROLLBACK_FAILED';throw failure;}throw error;
      }
      for(const [surface,state]of pendingStates)if(surface.pendingViewState===state)surface.pendingViewState=null;
      this.layouts.set(layout.projectId, next);
      for(const move of staged){
        const s=move.surface;s.win=move.destination;s.windowId=move.destinationWindowId;
        const lease=this.leases.get(this.resource(s.projectId,s.relPath));if(lease?.viewId===s.viewId)lease.windowId=s.windowId;
        const target=this.windows.get(move.destinationWindowId);if(target)target.staging=Math.max(0,(target.staging||1)-1);
        s.wc.send('nozeli:workspace-control',{type:'host',...this.bootstrap(s)});
      }
      const result = { layout: next, windowId: r.windowId };
      this.requests.set(requestId, { input: JSON.stringify(payload), result }); if (this.requests.size > 512) this.requests.delete(this.requests.keys().next().value);
      try{await this.reconcile(next);}finally{for(const s of affected){s.transferring=false;s.held=!!s.recoveryHeld;if(!s.dead)s.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:s.held});this.persistPendingViewState(s);}}
      this.projectVisibility(this.shell&&!this.shell.dead?this.shell.projectId:this.activeProjectId??layout.projectId);
      this.changed(next);
      if(command.type==='closeContent'){
        const prior=findView(layout,command.viewId),group=prior&&layoutGroups(next,prior.windowId).find(group=>group.id===prior.group.id),owner=group?.activeViewId&&this.surfaces.get(group.activeViewId);
        if(owner){const focus=()=>{if(!owner.dead&&owner.ready&&owner.view.getVisible()&&findView(this.layouts.get(layout.projectId),owner.viewId)?.group.activeViewId===owner.viewId){owner.returnFocus=null;owner.wc.focus();owner.wc.send('nozeli:workspace-control',{type:'focus-content'});}};owner.returnFocus=focus;focus();}
      }
      for(const move of staged){const target=this.windows.get(move.destinationWindowId);if(target&&!target.dead)target.wc.send('nozeli:workspace-control',{type:'surface-focus',viewId:move.surface.viewId,projectId:next.projectId});}
      return result;
    });
  }
  persistPendingViewState(surface) {
    if(surface.dead||!surface.pendingViewState||surface.pendingStateFlight)return;
    surface.pendingStateFlight=this.serial(surface.projectId,async()=>{
      if(surface.dead||surface.transferring||!surface.pendingViewState)return;
      const layout=await this.layout(surface.projectId),state=surface.pendingViewState;
      if(!layout.views[surface.viewId])return;
      const next=reduceLayout(layout,{type:'restoreViewState',viewId:surface.viewId,viewState:state});next.revision=layout.revision;
      await this.persist(next);this.layouts.set(surface.projectId,next);
      if(surface.pendingViewState===state)surface.pendingViewState=null;
      this.changed(next);
    }).catch(error=>this.onError(error)).finally(()=>{surface.pendingStateFlight=null;});
  }
  async deliverDrawing(session,event){
    const projectId=session.projectId;
    const question=typeof event.card?.message==='string'?event.card.message.trim():'';
    if(question)event={...event,attachment:{...event.attachment,frozenText:question,note:'涂鸦问题：'+question}};
    const liveOwner=this.projectRecords(projectId).find(s=>s.kind==='conversation'&&!s.dead);
    if(liveOwner?.ready)await this.flush([liveOwner]);
    let alreadyDelivered=false;
    await this.serial(projectId,async()=>{
      const layout=await this.layout(projectId);let conversation=Object.values(layout.views).find(v=>v.kind==='conversation');
      if(!conversation){const next=reduceLayout(layout,{type:'open',view:{kind:'conversation',viewState:{draftOnly:true}}});conversation=Object.values(next.views).find(v=>v.kind==='conversation');await this.persist(next);this.layouts.set(projectId,next);}
      if(!liveOwner){conversation.viewState={...conversation.viewState,draftOnly:true};}
      const current=await this.layout(projectId),descriptor=current.views[conversation.id],state=descriptor.viewState??={},materials=state.conversationMaterials??{},frontdesk=materials.frontdesk??{pending:[],quote:null};
      const key='drawing-'+event.deliveryId;
      const delivered=frontdesk.deliveredDrawingIds??[];
      alreadyDelivered=delivered.includes(event.deliveryId);
      if(!alreadyDelivered){
        descriptor.viewState={...state,conversationMaterials:{...materials,frontdesk:{...frontdesk,pending:[...(frontdesk.pending??[]),{...event.attachment,key,deliveryId:event.deliveryId,status:'ok'}],deliveredDrawingIds:[...delivered,event.deliveryId]}},conversationInput:state.conversationInput??{projectId,target:'frontdesk'}};
        await this.persist(current);
      }
    });
    const saved=await this.layout(projectId),recipient=Object.values(saved.views).find(v=>v.kind==='conversation');
    if(alreadyDelivered){
      const owner=recipient&&this.surfaces.get(recipient.id);
      if(owner?.ready)owner.wc.send('nozeli:workspace-control',event);else if(owner)(owner.pendingControls??=[]).push(event);
      return;
    }
    if(this.shell?.projectId!==projectId||recipient?.viewState?.conversationInput?.target!=='frontdesk'){this.broadcast('nozeli:workspace-control',{type:'drawing-saved',projectId},projectId);return;}
    const root=this.windows.get(session.window.windowId)??this.shell,layout=await this.layout(projectId),conversation=Object.values(layout.views).find(v=>v.kind==='conversation');
    await this.command(root,{projectId,expectedRevision:layout.revision,requestKey:'drawing-open-'+event.deliveryId,command:{type:'activate',viewId:conversation.id}});
    const owner=this.surfaces.get(conversation.id);if(!owner)throw fail('DRAFT_UNAVAILABLE');
    if(owner.ready)owner.wc.send('nozeli:workspace-control',event);else(owner.pendingControls??=[]).push(event);
    owner.win.show();owner.wc.focus();
  }
  async closeWindow(r) {
    if (r.closePending) return;
    if(this.isolatedPreview?.holdsWindow(r.win))throw fail('TRANSFER_RECOVERY_REQUIRED','此窗口仍承载尚未确认回滚的报告正文；现场已保留。');
    if(r.staging||[...this.surfaces.values()].some(s=>s.windowId===r.windowId&&s.transferring))throw fail('TRANSFER_IN_PROGRESS');
    r.closePending = true;
    try {
      if (this.currentWindowCount() === 1) { await this.onClose(r); return; }
      await this.flush([r, ...[...this.surfaces.values()].filter(s=>s.windowId===r.windowId)]);
      if (r.windowId !== 'main') {
        await this.serial(r.projectId, async () => {
          let next = await this.layout(r.projectId);
          for (const group of layoutGroups(next,r.windowId)) next=reduceLayout(next,{type:next.singleContent?'closePane':'closeGroup',groupId:group.id});
          await this.persist(next); this.layouts.set(r.projectId, next); await this.reconcile(next); this.changed(next);
        });
      } else {
        // The navigation shell may close independently; detached project windows remain alive.
        for (const s of [...this.surfaces.values()].filter(s=>s.windowId==='main')) this.destroySurface(s);
        r.closing = true; this.windows.delete('main'); r.win.destroy();
      }
    } finally { r.closePending = false; }
  }
  async invoke(r, op, p = {}) {
    if(r.role==='demo-controls')return this.demoControls.invoke(r,op,p);
    if(r.role==='demo-hint')return this.demoControls.invoke(r,op,p);
    if(op==='workspace.demoControls.update')return this.demoControls.update(r,p.model);
    if(op==='workspace.demoControls.readyForPlay')return this.demoControls.readyForPlay(r,p.sessionId);
    if(op==='workspace.demoHint.update')return this.demoControls.hintUpdate(r,p.hint);
    if (op === 'workspace.bootstrap') return this.bootstrap(r);
    if (op === 'workspace.closeProject') {
      if (r.role !== 'shell') throw fail('IPC_DENIED');
      return this.closeProject(p.projectId, {operationId:p.operationId});
    }
    if (op === 'workspace.recovery.list') {
      if (r.role !== 'shell') throw fail('IPC_DENIED');
      const projects = await this.host.storage.list(), entries = [];
      for (const project of projects) {
        const descriptor={id:project.id,name:project.name,root:project.root,removed:project.removed};
        for (const item of await this.host.storage.listRecovery(project.id)) if (item.id.startsWith('workspace:')) entries.push({project:descriptor,id:item.id,value:item.value});
        for (const pending of await listManagedPending(this.host.storage,project.id)) entries.push({project:descriptor,id:pending.id,value:{...pending,projectId:project.id,recoveryKind:'managed'}});
        const hold=this.host.storage.lifecycleHolds.get(project.id);if(hold)entries.push({project:descriptor,id:'lifecycle:'+hold.operationId,value:{projectId:project.id,recoveryKind:'lifecycle',operationId:hold.operationId,action:hold.action}});
      }
      return {entries};
    }
    if(op==='workspace.recovery.object'){
      if(r.role!=='shell'||typeof p.digest!=='string'||! /^[a-f0-9]{64}$/.test(p.digest))throw fail('IPC_DENIED');
      await this.host.requireRegisteredProject(p.projectId);
      const bytes=await readManagedObject(this.host.storage,p.projectId,p.digest);
      return {digest:p.digest,bytes:{encoding:'base64',byteLength:bytes.length,data:bytes.toString('base64')}};
    }
    if (op === 'workspace.recovery') return this.saveRecovery(r, p);
    if(op.startsWith('workspace.layouts.')){
      if(r.role==='surface'||p.projectId!==r.projectId)throw fail('IPC_DENIED');
      if(op.endsWith('.list'))return this.namedLayouts.list(r.projectId);
      if(op.endsWith('.save')){await this.flush(this.projectRecords(r.projectId));return this.namedLayouts.save(r.projectId,p.name,await this.layout(r.projectId));}
      if(op.endsWith('.rename'))return this.namedLayouts.rename(r.projectId,p.name,p.newName);
      if(op.endsWith('.delete'))return this.namedLayouts.delete(r.projectId,p.name);
      if(op.endsWith('.load')){const saved=await this.namedLayouts.load(r.projectId,p.name),current=await this.layout(r.projectId);return this.command(r,{projectId:r.projectId,expectedRevision:current.revision,requestKey:randomUUID(),command:{type:'restoreLayout',layout:saved}});}
      throw fail('UNKNOWN_OP');
    }
    if(op==='workspace.document.snapshot'){
      if(p.projectId!==r.projectId||r.role==='surface'&&p.relPath!==r.relPath)throw fail('PROJECT_SCOPE_DENIED');return this.buffers.get(this.resource(r.projectId,p.relPath))??await this.host.readFile(r.projectId,p.relPath);
    }
    if(op==='workspace.document.publish'){
      const lease=this.leases.get(this.resource(r.projectId,r.relPath));if(r.role!=='surface'||r.readOnly||p.projectId!==r.projectId||p.relPath!==r.relPath||lease?.viewId!==r.viewId||lease.generation!==r.generation)throw fail('EDIT_LEASE_DENIED');if(p.text!==undefined&&(typeof p.text!=='string'||Buffer.byteLength(p.text)>8*1024*1024))throw fail('INVALID_BUFFER');
      if(p.model!==undefined&&(!p.model||typeof p.model!=='object'||Buffer.byteLength(JSON.stringify(p.model))>32*1024*1024))throw fail('INVALID_BUFFER');
      const key=this.resource(r.projectId,r.relPath),previous=this.buffers.get(key),value={projectId:r.projectId,relPath:r.relPath,text:p.text,model:p.model??previous?.model,dirty:p.dirty===true,missing:p.missing===true,digest:p.digest,kind:p.kind,revision:(previous?.revision??0)+1,sourceViewId:r.viewId};this.buffers.set(key,value);
      if(previous?.text!==value.text||previous?.missing!==value.missing||previous?.dirty!==value.dirty)for(const slot of this.isolatedPreview?.slots.values()??[])if(slot.projectId===r.projectId&&slot.profile==='offlineDevelopment')this.isolatedPreview.emit(slot,'buffers-changed',{relPath:r.relPath});
      const layout=this.layouts.get(r.projectId);if(layout?.views[r.viewId]){layout.views[r.viewId].viewState={...layout.views[r.viewId].viewState,documentStatus:{dirty:value.dirty,missing:value.missing,readOnly:false}};if(value.dirty)layout.views[r.viewId].preview=false;}
      for(const surface of this.projectRecords(r.projectId))if(surface.relPath===r.relPath&&surface.viewId!==r.viewId&&surface.readOnly&&!surface.dead)surface.wc.send('nozeli:workspace-control',{type:'document-buffer',...value,model:p.model});if(layout)this.changed(layout);return {revision:value.revision};
    }
    if(op==='workspace.settings')return this.serial('settings:'+r.projectId,async()=>{
      if(!r.projectId||p.projectId!==r.projectId||!p.workspace||typeof p.workspace!=='object'||Object.keys(p.workspace).some(key=>!['fontSize','conversationFontSize','readingWidth','confirmationSkips'].includes(key)))throw fail('INVALID_SETTINGS');
      const skips=p.workspace.confirmationSkips;
      if(Object.entries(p.workspace).some(([key,value])=>key!=='confirmationSkips'&&!Number.isFinite(value))||skips!==undefined&&(!skips||typeof skips!=='object'||Array.isArray(skips)||Object.entries(skips).some(([key,value])=>!['closeDocument','closeCompare','removeTag','deleteNote'].includes(key)||typeof value!=='boolean'))||p.projectSettings!==undefined&&(!p.projectSettings||Object.keys(p.projectSettings).some(key=>key!=='focusMode')||typeof p.projectSettings.focusMode!=='boolean'))throw fail('INVALID_SETTINGS');
      const prior=(await this.host.readState(r.projectId)).state??{};
      const value=await this.host.writeState(r.projectId,{...prior,workspace:{...prior.workspace,...p.workspace},projectSettings:p.projectSettings??prior.projectSettings});
      this.broadcast('nozeli:workspace-control',{type:'settings',projectId:r.projectId,workspace:value.state.workspace,projectSettings:value.state.projectSettings},r.projectId);return value;
    });
    if (op === 'workspace.ready') {
      // Reapply after the renderer exists: a hidden WCV otherwise retains hidden
      // page visibility despite the constructor preference, blocking PDF.js rAF.
      if(r.role==='surface'&&p.contentReady!==true)r.wc.setBackgroundThrottling(false);
      r.ready=r.role!=='surface'||p.contentReady===true;r.readyResolve?.();const result=this.bootstrap(r);const layout=this.layouts.get(r.projectId);
      if(r.ready)r.loading=false;
      if(r.ready)r.wc.emit('nozeli-content-ready');
      if(r.ready)r.returnFocus?.();
      if(layout)this.changed(layout);if(r.ready){for(const control of r.pendingControls||[])r.wc.send('nozeli:workspace-control',control);r.pendingControls=[];}return result;
    }
    if(op==='workspace.activated'){
      if(r.role!=='shell'||p.projectId!==r.projectId)throw fail('PROJECT_SCOPE_DENIED');
      r.wc.emit('nozeli-project-activated',r.projectId);return {activated:true};
    }
    if(op==='workspace.focus'){
      if(r.role==='surface')throw fail('IPC_DENIED');const layout=await this.layout(r.projectId),found=findView(layout,p.viewId);if(!found||found.windowId!==r.windowId)throw fail('IPC_DENIED');const surface=this.surfaces.get(p.viewId);if(!surface||!surface.ready)throw fail('SURFACE_NOT_READY');surface.wc.focus();surface.wc.send('nozeli:workspace-control',{type:'focus-content'});return {};
    }
    if (op === 'workspace.project') return this.bindProject(r, p.projectId);
    if (op === 'workspace.snapshot') return { layout: await this.layout(p.projectId), windowId: r.windowId };
    if(op==='workspace.recoverResource'){
      if(r.role!=='surface'||p.projectId!==r.projectId||p.relPath!==r.relPath)throw fail('PROJECT_SCOPE_DENIED');
      return this.serial(r.projectId,async()=>{
        if(!r.recoveryHeld||!r.missingDigest)throw fail('RECOVERY_UNAVAILABLE','This surface has no verified missing-resource baseline.');
        if(r.transferring||r.syncHolds?.size)throw fail('TRANSFER_IN_PROGRESS');
        const generation=r.generation,relPath=r.relPath,digest=r.missingDigest;
        const file=await this.host.readFile(r.projectId,relPath);
        if(r.dead||r.generation!==generation||r.relPath!==relPath)throw fail('SURFACE_CHANGED');
        if(file.diskPresent===false||typeof file.digest!=='string'||!file.digest)throw fail('RESOURCE_MISSING','Restore the original file before resuming editing.');
        if(file.digest!==digest)throw fail('CONFLICT','The restored path contains different content; the retained reader remains read-only.');
        r.recoveryHeld=false;r.held=false;delete r.missingDigest;
        r.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:false});
        return file;
      });
    }
    if (op === 'workspace.command') {
      if(r.role==='surface'&&p.command?.type==='restoreViewState'&&r.transferring){if(p.command.viewId!==r.viewId)throw fail('IPC_DENIED');r.pendingViewState=p.command.viewState;return {layout:await this.layout(r.projectId),windowId:r.windowId};}
      return this.command(r,p);
    }
    if (op === 'workspace.bounds') {
      if (r.role === 'surface' || p.windowId !== r.windowId) throw fail('IPC_DENIED');
      const layout = await this.layout(r.projectId), groups = layoutGroups(layout, r.windowId);
      if(p.layoutRevision!==undefined&&p.layoutRevision!==layout.revision){this.changed(layout);return {stale:true};}
      if(p.sequence!==undefined){if(!Number.isSafeInteger(p.sequence)||p.sequence<1)throw fail('INVALID_BOUNDS');if(p.sequence<=(r.boundsSequence??0))return {stale:true};}
      const [currentWidth,currentHeight]=r.win.getContentSize();
      if(p.viewport&&(Math.abs(p.viewport.width-currentWidth)>1||Math.abs(p.viewport.height-currentHeight)>1)){
        r.wc.send('nozeli:workspace-control',{type:'viewport-changed',width:currentWidth,height:currentHeight});return {stale:true};
      }
      if(p.sequence!==undefined)r.boundsSequence=p.sequence;
      for (const surface of this.projectRecords(r.projectId, r.windowId)) {
        const item = p.groups?.find(item => item.viewId === surface.viewId && groups.some(g => g.id === item.groupId && g.activeViewId === surface.viewId));
        const rect = item?.rect;
        const [width, height] = r.win.getContentSize();
        const valid = rect && ['x','y','width','height'].every(k => Number.isFinite(rect[k])) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1;
        const occluded=valid&&Array.isArray(p.overlayRects)&&p.overlayRects.some(b=>b&&['x','y','width','height'].every(k=>Number.isFinite(b[k]))&&b.width>0&&b.height>0&&b.x<rect.x+rect.width&&b.x+b.width>rect.x&&b.y<rect.y+rect.height&&b.y+b.height>rect.y);
        if (valid) surface.view.setBounds(Object.fromEntries(Object.entries(rect).map(([k,v]) => [k,Math.round(v)])));
        surface.view.setVisible(!!valid && !surface.conversationBlocked && !p.overlay && !occluded && surface.ready && ![...this.drags.values()].some(d=>d.projectId===r.projectId&&!(d.source.role==='detached'&&d.source.windowId===r.windowId)));
        for(const slot of this.isolatedPreview?.slots.values()??[])if(slot.scope===surface)this.isolatedPreview.bounds(slot,slot.bounds);
        surface.returnFocus?.();
      }
      this.demoControls.raise();
      return {};
    }
    if (op === 'workspace.control') {
      if(p.type==='open-settings'){
        if(!['settings-appearance','settings-reading-display','settings-provider','settings-models','settings-agents','settings-recovery','settings-help'].includes(p.section))throw fail('INVALID_SETTINGS');
        if((!this.shell||this.shell.dead)&&this.restoreShell)await this.restoreShell();
        if(!this.shell||this.shell.dead)throw fail('MAIN_WINDOW_UNAVAILABLE');
        const control={type:'open-settings',section:p.section,projectId:r.projectId};if(this.shell.ready)this.shell.wc.send('nozeli:workspace-control',control);else(this.shell.pendingControls??=[]).push(control);this.shell.win.show();this.shell.win.focus();return {};
      }
      if(p.type==='pane-resize'){
        if(r.role==='surface')throw fail('IPC_DENIED');r.resizing=p.active===true;
        for(const surface of this.projectRecords(r.projectId,r.windowId))surface.wc.send('nozeli:workspace-control',{type:'pane-resize-session',active:r.resizing});return {};
      }
      if(p.type==='pane-pointer'){
        if(r.role!=='surface')throw fail('IPC_DENIED');const root=this.windows.get(r.windowId);if(!root||root.projectId!==r.projectId||!root.resizing)return {};
        if(!['pointermove','pointerup','pointercancel'].includes(p.eventType))throw fail('INVALID_COMMAND');const b=r.view.getBounds();
        if(p.eventType!=='pointercancel'&&(!Number.isFinite(p.clientX)||!Number.isFinite(p.clientY)))throw fail('INVALID_COMMAND');
        root.wc.send('nozeli:workspace-control',{type:'pane-pointer',eventType:p.eventType,buttons:p.buttons,clientX:b.x+(p.clientX??0),clientY:b.y+(p.clientY??0)});return {};
      }
      if(p.type==='window-control'){
        if(!['shell','detached','surface'].includes(r.role))throw fail('IPC_DENIED');
        if(p.action==='minimize')r.win.minimize();
        else if(p.action==='maximize'){if(r.win.isMaximized())r.win.unmaximize();else r.win.maximize();}
        else if(p.action==='close')r.win.close();
        else throw fail('INVALID_COMMAND');
        return {};
      }
      const layout = await this.layout(r.projectId);
      if(p.type==='focus-document-owner'){if(r.role==='surface'&&p.relPath!==r.relPath)throw fail('PROJECT_SCOPE_DENIED');const lease=this.leases.get(this.resource(r.projectId,p.relPath)),owner=lease&&this.surfaces.get(lease.viewId);if(!owner)throw fail('NO_ACTIVE_VIEW');const root=this.windows.get(owner.windowId);if(!root)throw fail('NO_ROOT');await this.command(root,{projectId:r.projectId,expectedRevision:layout.revision,requestKey:randomUUID(),command:{type:'activate',viewId:owner.viewId}});owner.win.show();owner.win.focus();owner.wc.focus();owner.wc.send('nozeli:workspace-control',{type:'focus-content'});return {};}
      if(p.type==='conversation-action'){
        const projectId=r.projectId,generation=r.generation;
        if(p.action==='prepare'&&p.target!=='frontdesk')throw fail('INVALID_COMMAND');
        await this.requireConversation(projectId,p.target||'frontdesk',{notify:p.action!=='prepare'});
        if(r.dead||r.projectId!==projectId||r.generation!==generation)throw fail('PROJECT_SCOPE_DENIED');
        const current=await this.layout(projectId);
        const conversation=Object.values(current.views).find(v=>v.kind==='conversation');
        if(conversation?.viewState?.draftOnly){conversation.viewState={...conversation.viewState,draftOnly:false};await this.persist(current);const live=this.surfaces.get(conversation.id);if(live)live.wc.send('nozeli:workspace-control',{type:'drawing-connect',projectId});}
        if(this.guidedDemo?.isDemo(projectId)&&conversation){const live=this.surfaces.get(conversation.id);if(live){live.conversationAdmitted=true;live.conversationBlocked=false;live.conversationTarget='frontdesk';}}
        if(p.action==='prepare'){if(this.guidedDemo?.isDemo(projectId))return {projectId,target:'frontdesk',ready:true,demo:true,source:'demo-fixture'};r.drawingConversationProject=projectId;return {projectId,target:'frontdesk',ready:true};}
        const root=this.windows.get(r.windowId)||this.windows.get('main');if(!root)throw fail('NO_ROOT');
        const localGroups=layoutGroups(layout,root.windowId),source=r.role==='surface'?findView(layout,r.viewId)?.group:null;
        const target=p.groupId?localGroups.find(g=>g.id===p.groupId):source||localGroups[0];
        if(!target)throw fail('INVALID_GROUP');
        const found=conversation&&findView(layout,conversation.id);
        const action=conversation?(p.groupId&&found&&found.group.id!==target.id?{type:'move',viewId:conversation.id,targetGroupId:target.id}:{type:'activate',viewId:conversation.id,groupId:target.id}):{type:'open',groupId:target.id,view:{kind:'conversation'}};
        const result=await this.command(root,{projectId:r.projectId,expectedRevision:layout.revision,requestKey:randomUUID(),command:action});
        const owner=this.surfaces.get(Object.values(result.layout.views).find(v=>v.kind==='conversation').id);if(!owner)throw fail('NO_ACTIVE_VIEW');
        owner.conversationAdmitted=true;owner.conversationBlocked=false;owner.conversationTarget=p.target||'frontdesk';
        if(owner.ready)owner.wc.send('nozeli:workspace-control',p);else(owner.pendingControls??=[]).push(p);owner.win.show();owner.win.focus();return {};
      }
      if(r.role==='surface'){
        const root=this.windows.get(r.windowId)||this.windows.get('main');if(!root)throw fail('NO_ROOT');root.wc.send('nozeli:workspace-control',{...p,sourceViewId:r.viewId,projectId:r.projectId});return {};
      }
      const group=layoutGroups(layout,r.windowId).find(g=>g.activeViewId),surface=this.surfaces.get(p.viewId||group?.activeViewId);
      if(!surface||surface.projectId!==r.projectId)throw fail('NO_ACTIVE_VIEW');surface.wc.send('nozeli:workspace-control',p);return {};
    }
    if (op === 'workspace.windows.list') return [...this.windows.values()].filter(w => w.projectId === r.projectId).map(w => ({ id:w.windowId, nativeWindowId:w.win.id,projectId:w.projectId,visible:!w.projectHidden&&typeof w.win.isVisible==='function'?w.win.isVisible():!w.projectHidden,projectHidden:!!w.projectHidden,surfaces:this.projectRecords(w.projectId,w.windowId).map(s=>({viewId:s.viewId,webContentsId:s.wc.id,relPath:s.relPath,visible:s.view.getVisible?.()??null,bounds:s.view.getBounds()})) }));
    if (op === 'workspace.windows.focus' || op === 'workspace.windows.recall' || op === 'workspace.windows.topmost') {
      const w = this.windows.get(p.windowId); if (!w || w.projectId !== r.projectId) throw fail('IPC_DENIED');
      if (op.endsWith('recall')) w.win.setBounds(restoreBounds(w.win.getBounds(), this.screen));
      if (op.endsWith('topmost')) {
        if (w.windowId === 'main') throw fail('INVALID_WINDOW');
        const layout = await this.layout(r.projectId);
        await this.command(r, { projectId:r.projectId, expectedRevision:layout.revision, requestKey:randomUUID(), command:{type:'windowBounds',windowId:w.windowId,boundsDip:w.win.getBounds(),alwaysOnTop:!!p.value} });
        w.win.setAlwaysOnTop(!!p.value);
      }
      w.win.show(); w.win.focus(); return {};
    }
    if (op.startsWith('workspace.drag.')) return this.drag(r, op, p);
    throw fail('UNKNOWN_OP');
  }
  finishDrag(sessionId, d, cancelled = false) {
    if(this.drags.get(sessionId)!==d)return;
    clearTimeout(d.timer);
    this.drags.delete(sessionId);
    this.broadcast('nozeli:workspace-control',{type:'drag-ended',sessionId},d.projectId);
  }
  cancelDrags(record) {
    for(const [id,d] of this.drags){
      // Docking can destroy the source window; the ending command owns its final visibility broadcast.
      if(d.source===record){if(!d.ending)this.finishDrag(id,d,true);}
      else if(d.target?.record===record)d.target=null;
    }
  }
  dragPoint(d, p) {
    for(const r of this.windows.values())if(r.projectId===d.projectId&&!r.dead){
      const bounds=r.win.getContentBounds();
      r.wc.send('nozeli:workspace-control',{type:'drag',sessionId:p.sessionId,screenX:p.screenX,screenY:p.screenY,clientX:p.screenX-bounds.x,clientY:p.screenY-bounds.y});
    }
  }
  async drag(r, op, p) {
    if (r.role === 'surface') throw fail('IPC_DENIED');
    if (op === 'workspace.drag.begin') {
      const layout = await this.layout(r.projectId);
      if (!!p.viewId === !!p.groupId) throw fail('INVALID_DRAG');
      if (p.viewId ? findView(layout,p.viewId)?.windowId !== r.windowId : !layoutGroups(layout,r.windowId).some(g => g.id === p.groupId)) throw fail('IPC_DENIED');
      for(const [id,d] of this.drags)if(d.projectId===r.projectId){if(d.ending)throw fail('INVALID_DRAG');this.finishDrag(id,d,true);}
      const sessionId = randomUUID();
      this.drags.set(sessionId,{source:r,projectId:r.projectId,viewId:p.viewId,groupId:p.groupId,revision:layout.revision,topology:topology(layout),generation:r.generation,expires:Date.now()+30000});
      const drag=this.drags.get(sessionId);drag.start={x:p.screenX,y:p.screenY,bounds:r.win.getBounds()};
      drag.timer=setTimeout(()=>this.finishDrag(sessionId,drag,true),30000);drag.timer.unref?.();
      for(const surface of this.projectRecords(r.projectId))if(r.role!=='detached'||surface.windowId!==r.windowId)surface.view.setVisible(false);
      this.broadcast('nozeli:workspace-control',{type:'drag-session',sessionId,projectId:r.projectId},r.projectId); return {sessionId};
    }
    const d = this.drags.get(p.sessionId);
    if (!d || d.projectId !== r.projectId) throw fail('INVALID_DRAG');
    if(d.expires<Date.now()||d.source.dead||d.source.generation!==d.generation){this.finishDrag(p.sessionId,d,true);throw fail('INVALID_DRAG');}
    if (op === 'workspace.drag.target') {
      const layout = await this.layout(r.projectId);
      if (p.targetGroupId && !layoutGroups(layout,r.windowId).some(g => g.id === p.targetGroupId)) throw fail('IPC_DENIED');
      if(p.targetGroupId){if(!d.target||r!==d.source||d.target.record===d.source)d.target={record:r,groupId:p.targetGroupId,axis:p.axis,side:p.side,index:p.index};}else if(d.target?.record===r)d.target=null;return {};
    }
    if (d.source !== r) throw fail('IPC_DENIED');
    if(op==='workspace.drag.cancel'||p.cancelled===true){if(d.ending)throw fail('INVALID_DRAG');this.finishDrag(p.sessionId,d,true);return {};}
    if(d.ending)throw fail('INVALID_DRAG');
    if(op==='workspace.drag.update'){
      if(!Number.isFinite(p.screenX)||!Number.isFinite(p.screenY))throw fail('INVALID_DRAG');
      d.target=null;d.screenX=p.screenX;d.screenY=p.screenY;
      this.dragPoint(d,p);return {};
    }
    try {
    if(op==='workspace.drag.end'&&p.cancelled===false){
      d.ending=true;clearTimeout(d.timer);
      if(Number.isFinite(d.screenX)&&Number.isFinite(d.screenY))p={...p,screenX:d.screenX,screenY:d.screenY};
      d.target=null;this.dragPoint(d,p);
      await new Promise(resolve=>setTimeout(resolve,60));
      if(this.drags.get(p.sessionId)!==d||d.source.dead)throw fail('INVALID_DRAG');
    }
    if (op !== 'workspace.drag.end' || p.cancelled !== false) throw fail('INVALID_DRAG');
    const target = d.groupId&&!layoutGroups(await this.layout(r.projectId),r.windowId).find(g=>g.id===d.groupId)?.activeViewId?null:d.target;
    if(!target&&r.role==='detached'&&Number.isFinite(p.screenX)&&Number.isFinite(p.screenY)&&Number.isFinite(d.start.x)&&Number.isFinite(d.start.y)){
      return {layout:await this.layout(r.projectId),windowId:r.windowId};
    }
    const command = target ? d.groupId ? {type:'moveGroup',groupId:d.groupId,targetGroupId:target.groupId,axis:target.axis,side:target.side} : target.axis ? {type:'split',groupId:target.groupId,axis:target.axis,side:target.side,moveViewId:d.viewId} : {type:'move',viewId:d.viewId,targetGroupId:target.groupId,index:target.index} : {type:'detach',viewId:d.viewId,groupId:d.groupId};
    if(command.type==='move'&&Number.isInteger(command.index)){
      const source=findView(await this.layout(r.projectId),d.viewId);
      if(source?.group.id===target.groupId&&source.group.views.indexOf(d.viewId)<command.index)command.index--;
    }
    const current=await this.layout(r.projectId);if(topology(current)!==d.topology)throw fail('LAYOUT_STALE');
    const result = await this.command(r,{projectId:r.projectId,expectedRevision:current.revision,requestKey:p.sessionId,command});
    if (!target && Number.isFinite(p.screenX) && Number.isFinite(p.screenY)) {
      const item = result.layout.detached.at(-1), window = this.windows.get(item?.id);
      if (window) window.win.setBounds(restoreBounds({x:p.screenX,y:p.screenY,width:1000,height:760},this.screen));
    }
    return result;
    } finally { this.finishDrag(p.sessionId,d); }
  }
}
