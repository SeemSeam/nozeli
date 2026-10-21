import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLayout, validateLayout, reduceLayout, singleContentLayout, layoutGroups, findView } from '../domain/workspace-layout.mjs';
import {WorkspaceLayoutStore} from './workspace-layout-store.mjs';

const fail = (code, message = code) => Object.assign(new Error(message), { code });
const writes = new Set(['file.save','file.draft','file.retain','sheet.save','sheet.recover','word.save','word.import','document.image.put','annotation.add','annotation.update','annotation.remove','annotation.drawing','tag.put','tag.view','tag.reanchor','tag.material']);
const surfaceOps = /^(file\.|document\.|annotation\.|tag\.|material\.|word\.|sheet\.|ppt\.|formatter\.|lsp\.(sync|request|status)$|tex\.|managed\.|report\.|project\.(open|list|children|search)$|agents\.(messages|reports)$|config\.status$|links\.openExternal$|state\.(read|write)$|view\.authorship$|session\.(flushed|requestClose|capture|resize|quitChoice)$)/;

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
    this.directory = path.join(userDataDir, 'nozeli', 'workspace-v2');
    this.senders = new Map(); this.windows = new Map(); this.surfaces = new Map(); this.layouts = new Map(); this.queues = new Map(); this.receipts = new Map(); this.requests = new Map(); this.drags = new Map(); this.leases = new Map(); this.epoch = 0;
    this.buffers=new Map();
    this.namedLayouts=new WorkspaceLayoutStore({directory:path.join(userDataDir,'nozeli','named-layouts')});
    this.preferences = { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false, preload };
  }
  register(wc, scope) {
    const record = { ...scope, wc, generation: 0, ready: false, dead: false };
    this.senders.set(wc.id, record);
    wc.on('focus',()=>{if(record.role==='surface'){const root=this.windows.get(record.windowId);if(root&&!root.dead)root.wc.send('nozeli:workspace-control',{type:'surface-focus',viewId:record.viewId,projectId:record.projectId});}});
    wc.on('before-input-event',(event,input)=>{if(record.role!=='surface'||input.type!=='keyDown'||input.isComposing)return;const numbered=(input.control||input.meta)&&!input.alt&&!input.shift&&/^[1-9]$/.test(input.key),cycle=input.key==='F6'&&!input.control&&!input.meta&&!input.alt;if(!numbered&&!cycle)return;const root=this.windows.get(record.windowId);if(!root||root.dead||root.projectId!==record.projectId)return;event.preventDefault();root.wc.send('nozeli:workspace-control',{type:'group-focus',projectId:record.projectId,viewId:record.viewId,...(numbered?{index:Number(input.key)-1}:{direction:input.shift?-1:1})});});
    wc.on('before-input-event',(event,input)=>{if(record.role!=='surface'||input.type!=='keyDown'||input.isComposing)return;const quick=(input.control||input.meta)&&!input.alt&&!input.shift&&input.key.toLowerCase()==='p';if(!quick)return;const root=this.windows.get(record.windowId);if(!root||root.dead)return;event.preventDefault();root.wc.send('nozeli:workspace-control',{type:'quick-open',projectId:record.projectId,viewId:record.viewId});});
    wc.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => { if (url !== this.origin) event.preventDefault(); });
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('did-start-navigation', (_event, _url, _inPlace, main) => {
      if (!main) return;
      record.generation++; record.ready = false;
      if (record.role !== 'surface') for (const surface of this.projectRecords(record.projectId, record.windowId)) surface.view.setVisible(false);
      for (const [id, receipt] of this.receipts) if (receipt.record === record) { receipt.reject(fail('SURFACE_RELOADED')); this.receipts.delete(id); }
    });
    wc.on('render-process-gone', (_event, details) => {
      if(record.role!=='surface')for(const surface of this.projectRecords(record.projectId,record.windowId))surface.view.setVisible(false);
      record.ready = false; record.generation++;
      for (const [id, receipt] of this.receipts) if (receipt.record === record) { receipt.reject(fail('RENDERER_GONE')); this.receipts.delete(id); }
      this.recover?.(record, details);
    });
    wc.once('destroyed', () => {
      record.dead = true; this.senders.delete(wc.id);
      for (const [id, receipt] of this.receipts) if (receipt.record === record) { receipt.reject(fail('SURFACE_DESTROYED')); this.receipts.delete(id); }
      for (const [id, drag] of this.drags) if (drag.source === record || drag.target?.record === record) this.drags.delete(id);
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
    if (!r || r.dead || !frame || frame.parent != null || frame !== event.sender.mainFrame || frame.url !== this.origin) throw fail('IPC_DENIED');
    if (typeof op !== 'string') throw fail('UNKNOWN_OP');
    if (payload.projectId && payload.projectId !== r.projectId && !(r.role === 'shell' && ['workspace.project','project.open'].includes(op))) throw fail('PROJECT_SCOPE_DENIED');
    if (r.role !== 'shell' && !op.startsWith('workspace.') && !surfaceOps.test(op)) throw fail('IPC_DENIED');
    if (r.role === 'detached' && !op.startsWith('workspace.') && !['project.open','project.list','project.children','project.search','config.status','session.flushed','session.requestClose','session.quitChoice','state.read','view.authorship'].includes(op)) throw fail('IPC_DENIED');
    if (r.role === 'surface' && (writes.has(op) || op === 'ppt.export' || op === 'ppt.draft' && payload.model !== undefined)) {
      const lease = this.leases.get(this.resource(r.projectId, r.relPath));
      if (!lease || lease.viewId !== r.viewId || payload.relPath !== r.relPath || lease.generation !== r.generation) throw fail('EDIT_LEASE_DENIED');
    }
    if (writes.has(op) && r.role !== 'surface' && payload.relPath && this.leases.has(this.resource(r.projectId,payload.relPath))) throw fail('EDIT_LEASE_DENIED');
    const mutatesDocument=writes.has(op)||op==='ppt.export'||op==='ppt.draft'&&payload.model!==undefined;
    if ((r.held||r.recoveryHeld||r.syncHolds?.size) && mutatesDocument) throw fail('TRANSFER_HELD');
    if (r.held && op.startsWith('managed.') && !['managed.status','managed.history.list','managed.history.read','managed.artifact.read','managed.artifact.list','managed.timeline.page','managed.timeline.read'].includes(op)) throw fail('TRANSFER_HELD');
    if (r.role === 'surface' && op === 'managed.draft' && r.kind !== 'conversation') throw fail('CONVERSATION_OWNER_REQUIRED');
    if(op==='managed.frontdesk.context.clear'&&r.role!=='shell'&&!(r.role==='surface'&&r.kind==='conversation'&&payload.projectId===r.projectId))throw fail('CONVERSATION_OWNER_REQUIRED');
    if (r.role !== 'shell' && op === 'managed.enable') throw fail('IPC_DENIED');
    return r;
  }
  resource(projectId, relPath) { return `${projectId}\0${relPath}`; }
  async layout(projectId) {
    if (!projectId || typeof projectId !== 'string') throw fail('INVALID_PROJECT');
    await this.host.requireProject(projectId);
    if (this.layouts.has(projectId)) return this.layouts.get(projectId);
    let value;
    try { value = JSON.parse(await fs.readFile(this.filename(projectId), 'utf8')); validateLayout(value); if (value.projectId !== projectId) throw fail('INVALID_LAYOUT'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; const legacy=await this.host.readState(projectId);value = createLayout(projectId, legacy?.state??{}); }
    value=singleContentLayout(value);
    this.layouts.set(projectId, value); return value;
  }
  filename(projectId) { return path.join(this.directory, createHash('sha256').update(projectId).digest('hex') + '.json'); }
  async persist(layout) {
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.filename(layout.projectId), temporary = target + '.' + randomUUID() + '.tmp';
    validateLayout(layout);
    try { const handle=await fs.open(temporary,'wx');try{await handle.writeFile(JSON.stringify(layout));await handle.sync();}finally{await handle.close();}await fs.rename(temporary,target);const directory=await fs.open(this.directory,'r');try{await directory.sync();}finally{await directory.close();} }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }
  serial(projectId, work) {
    const next = (this.queues.get(projectId) || Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(projectId, next); return next.finally(() => { if (this.queues.get(projectId) === next) this.queues.delete(projectId); });
  }
  bootstrap(r) {
    const descriptor=this.layouts.get(r.projectId)?.views[r.viewId];
    if (r.role === 'surface' && r.relPath && !descriptor?.readOnly) {
      const key = this.resource(r.projectId, r.relPath), lease = this.leases.get(key);
      if (!lease || lease.viewId === r.viewId && lease.generation !== r.generation) this.leases.set(key, { resourceId: key, viewId: r.viewId, windowId: r.windowId, generation: r.generation, epoch: ++this.epoch });
      r.readOnly = this.leases.get(key)?.viewId !== r.viewId;
    }else if(descriptor?.readOnly)r.readOnly=true;
    const viewState=this.layouts.get(r.projectId)?.views[r.viewId]?.viewState;
    return { role: r.role, projectId: r.projectId, viewId: r.viewId, kind: r.kind, relPath: r.relPath, windowId: r.windowId, generation: r.generation, readOnly: !!r.readOnly, viewState, lease: r.relPath ? this.leases.get(this.resource(r.projectId, r.relPath)) : null };
  }
  flush(records) { return Promise.all([...new Set(records)].filter(r => !r.dead).map(r => this.flushOne(r))).then(() => this.host.settled()); }
  async flushOne(record, channel = 'nozeli:flush', detail = {}) {
    if(!record.ready&&record.role==='surface'&&!record.dead){await new Promise((resolve,reject)=>{const generation=record.generation,timer=setTimeout(()=>{record.wc.removeListener('nozeli-content-ready',ready);reject(fail('SURFACE_NOT_READY'));},10000);const ready=()=>{clearTimeout(timer);record.dead||record.generation!==generation?reject(fail('SURFACE_CHANGED')):resolve();};record.wc.once('nozeli-content-ready',ready);});}
    if (!record.ready) throw fail('SURFACE_NOT_READY');
    const requestId = randomUUID(), generation = record.generation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.receipts.delete(requestId); reject(Object.assign(fail('FLUSH_TIMEOUT'),{requestId})); }, 10000);
      this.receipts.set(requestId, { record, generation, hold:channel==='nozeli:document-sync'&&detail.hold, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer);error.requestId=requestId; reject(error); } });
      try { record.wc.send(channel, channel === 'nozeli:flush' ? requestId : { ...detail, requestId }); }
      catch (error) { this.receipts.get(requestId)?.reject(error); this.receipts.delete(requestId); }
    });
  }
  acknowledge(record, payload, result = payload) {
    const p = this.receipts.get(payload?.requestId);
    if (!p || p.record !== record || p.generation !== record.generation) return { accepted: false };
    this.receipts.delete(payload.requestId);
    if (result?.ok && !result?.composing) {if(p.hold)(record.syncHolds??=new Set()).add(payload.requestId);p.resolve({...result,requestId:payload.requestId});}else p.reject(fail(result?.composing ? 'COMPOSITION_ACTIVE' : result?.error?.code || 'FLUSH_FAILED', result?.error?.message));
    return { accepted: true };
  }
  async syncDocument({ projectId, relPath, hold }) {
    const owner = [...this.surfaces.values()].find(r => r.projectId === projectId && r.relPath === relPath && this.leases.get(this.resource(projectId, relPath))?.viewId === r.viewId);
    if (!owner) return () => {};
    let requestId;
    const release=()=>{if(requestId){owner.syncHolds?.delete(requestId);if(!owner.dead)owner.wc.send('nozeli:document-release',requestId);}};
    try{const result=await this.flushOne(owner,'nozeli:document-sync',{projectId,relPath,hold});requestId=result.requestId;return release;}
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
  async bindProject(r, projectId) {
    if (r.role !== 'shell') throw fail('IPC_DENIED');
    const work=async()=>{
      const generation=r.generation;
      if(r.projectId&&r.projectId!==projectId)await this.flush(this.projectRecords(r.projectId));
      const layout=await this.layout(projectId);
      if(r.dead||r.generation!==generation)throw fail('SHELL_CHANGED');
      for(const surface of [...this.surfaces.values()])if(surface.windowId==='main'){if(surface.projectId!==projectId)this.destroySurface(surface);else surface.view.setVisible(false);}
      r.projectId=projectId;await this.reconcile(layout);this.projectVisibility(projectId);this.changed(layout);return {layout,windowId:r.windowId};
    };
    const pending=(r.bindPending||Promise.resolve()).catch(()=>{}).then(work);r.bindPending=pending;
    return pending.finally(()=>{if(r.bindPending===pending)r.bindPending=null;});
  }
  projectVisibility(projectId){this.activeProjectId=projectId;for(const root of this.windows.values()){if(root.windowId==='main'||root.dead||root.win.isDestroyed())continue;const visible=root.projectId===projectId;root.projectHidden=!visible;if(!visible)root.win.hide();else if(!this.hidden){if(typeof root.win.showInactive==='function')root.win.showInactive();else root.win.show();}}}
  currentWindowCount(){const projectId=this.shell&&!this.shell.dead?this.shell.projectId:this.activeProjectId;return [...this.windows.values()].filter(root=>!root.dead&&(root.windowId==='main'||!projectId||root.projectId===projectId)).length;}
  async detached(layout, item) {
    const old = this.windows.get(item.id); if (old) return old;
    const win = new this.BrowserWindow({ ...restoreBounds(item.boundsDip, this.screen), frame:false, icon:this.icon, show: false, title: 'Nozeli', alwaysOnTop: !!item.alwaysOnTop, webPreferences: this.preferences });
    win.setMenu?.(null);win.setMenuBarVisibility?.(false);
    const r = this.register(win.webContents, { role: 'detached', projectId: layout.projectId, windowId: item.id, win });
    this.windows.set(item.id, r);
    this.setupWindow?.(r);
    win.on('close', event => { if (r.closing) return; event.preventDefault(); void this.closeWindow(r).catch(this.onError); });
    const saveBounds=()=>{if(r.closing||!r.ready)return;void this.serial(r.projectId,async()=>{const current=await this.layout(r.projectId);if(!current.detached.some(w=>w.id===r.windowId))return;const next=reduceLayout(current,{type:'windowBounds',windowId:r.windowId,boundsDip:win.getBounds(),alwaysOnTop:win.isAlwaysOnTop()});await this.persist(next);this.layouts.set(r.projectId,next);this.changed(next);}).catch(this.onError);};
    win.on('moved',saveBounds);win.on('resized',saveBounds);
    win.on('closed', () => this.windows.delete(item.id));
    let timer;
    const ready = new Promise((resolve, reject) => { r.readyResolve = resolve; timer = setTimeout(() => reject(fail('WINDOW_NOT_READY')), 10000); });
    try { await win.loadURL(this.origin); await ready; const active=this.shell&&!this.shell.dead?this.shell.projectId:layout.projectId;r.projectHidden=active!==layout.projectId;const committed=this.layouts.get(layout.projectId)?.detached.some(w=>w.id===item.id);if(committed&&!this.hidden&&!r.projectHidden)win.show();return r; }
    catch (error) { r.closing = true; win.destroy(); throw error; }
    finally { clearTimeout(timer); }
  }
  async reconcile(layout) {
    for (const item of layout.detached) await this.detached(layout, item);
    for (const view of Object.values(layout.views)) {
      const found = findView(layout, view.id);if(!found)continue;const destination = this.windows.get(found.windowId);
      if (!destination || destination.projectId !== layout.projectId) continue;
      let r = this.surfaces.get(view.id);
      if (!r) {
        const nativeView = new this.WebContentsView({ webPreferences: this.preferences });
        r = this.register(nativeView.webContents, { role: 'surface', viewId: view.id, projectId: layout.projectId, kind: view.kind, relPath: view.relPath, windowId: found.windowId, win: destination.win, view: nativeView });
        r.loading=true;
        this.surfaces.set(view.id, r); nativeView.setVisible(false);
        destination.win.contentView.addChildView(nativeView);
        const [initialWidth,initialHeight]=destination.win.getContentSize();nativeView.setBounds({x:0,y:0,width:Math.max(280,initialWidth),height:Math.max(180,initialHeight)});
        void nativeView.webContents.loadURL(this.origin).catch(error=>{r.ready=false;this.onError(error);});
      } else if (r.windowId !== found.windowId) {
        r.view.setVisible(false); r.win.contentView.removeChildView(r.view); destination.win.contentView.addChildView(r.view);
        r.win = destination.win; r.windowId = found.windowId;
        const lease = this.leases.get(this.resource(r.projectId, r.relPath)); if (lease?.viewId === r.viewId) lease.windowId = r.windowId;
        r.wc.send('nozeli:workspace-control', { type: 'host', ...this.bootstrap(r) });
      }
    }
    for (const [id, r] of this.surfaces) if (r.projectId === layout.projectId && (!layout.views[id]||!findView(layout,id))) this.destroySurface(r);
    for (const [id, r] of this.windows) if (id !== 'main' && r.projectId === layout.projectId && !layout.detached.some(w => w.id === id)) { r.closing = true; r.win.destroy(); this.windows.delete(id); }
  }
  destroySurface(r) {
    r.view.setVisible(false); if (!r.win.isDestroyed()) r.win.contentView.removeChildView(r.view);
    r.wc.close(); this.surfaces.delete(r.viewId);
    const key = this.resource(r.projectId, r.relPath); if (this.leases.get(key)?.viewId === r.viewId) this.leases.delete(key);
    if(!this.projectRecords(r.projectId).some(surface=>surface.relPath===r.relPath))this.buffers.delete(key);
  }
  async command(r, payload) {
    if (r.role === 'surface' && payload.command?.type !== 'restoreViewState') throw fail('IPC_DENIED');
    if (payload.projectId !== r.projectId || r.role === 'surface' && payload.command.viewId !== r.viewId) throw fail('PROJECT_SCOPE_DENIED');
    return this.serial(payload.projectId, async () => {
      let layout = await this.layout(payload.projectId);
      if(r.role==='surface'&&r.transferring&&payload.command?.type==='restoreViewState'){r.pendingViewState=payload.command.viewState;return {layout,windowId:r.windowId};}
      if (!payload.requestKey || typeof payload.requestKey !== 'string' || payload.requestKey.length > 160) throw fail('INVALID_REQUEST_KEY');
      const requestId = `${r.wc.id}:${r.generation}:${payload.requestKey}`;
      const previous = this.requests.get(requestId);
      if (previous) { if (previous.input !== JSON.stringify(payload)) throw fail('REQUEST_KEY_REUSED'); return previous.result; }
      if (payload.expectedRevision !== layout.revision && !(r.role==='surface'&&payload.command?.type==='restoreViewState'&&payload.expectedRevision===undefined)) throw fail('LAYOUT_STALE');
      const command = { ...payload.command };
      if(command.type==='open'&&command.view?.kind==='document'){
        const existing=Object.values(layout.views).find(v=>v.kind==='document'&&v.relPath===command.view.relPath&&!v.readOnly);
        if(existing){const target=command.groupId;for(const key of Object.keys(command))delete command[key];command.type='activate';command.viewId=existing.id;command.groupId=target;const owner=this.surfaces.get(existing.id);if(owner){owner.win.show();owner.win.focus();}}
      }
      if(command.type==='floatOpen')command.type='detach';
      if (command.type === 'detach') command.windowId = randomUUID();
      if (command.type === 'dock') {
        if(!this.shell||this.shell.dead)await this.restoreShell?.();
        if(!this.shell||this.shell.dead)throw fail('MAIN_WINDOW_UNAVAILABLE');
        if(this.shell.projectId!==layout.projectId){await this.bindProject(this.shell,layout.projectId);this.shell.wc.send('nozeli:workspace-control',{type:'project',projectId:layout.projectId});}
      }
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
        for(const windowId of ['main',...next.detached.map(window=>window.id)])for(const pane of layoutGroups(next,windowId)){pane.views=pane.views.map(id=>remapped.get(id)??id);pane.activeViewId=remapped.get(pane.activeViewId)??pane.activeViewId;}
        for(const view of Object.values(next.views))if(view.sourceViewId)view.sourceViewId=remapped.get(view.sourceViewId)??view.sourceViewId;
        next.closedViews=structuredClone(layout.closedViews??[]);
        next.revision=layout.revision+1;validateLayout(next);
      }else next=reduceLayout(layout, command);
      if(command.type==='restoreViewState')next.revision=layout.revision;
      const affected = this.projectRecords(layout.projectId).filter(s => {
        const before = findView(layout, s.viewId), after = findView(next, s.viewId);
        return command.type==='restoreLayout' || !after || before?.windowId !== after.windowId;
      });
      for(const s of affected){s.transferring=true;s.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:true});}
      const generations=new Map(affected.map(s=>[s,s.generation]));
      try { await this.flush(affected);for(const s of affected)s.held=true; }
      catch(error){for(const s of affected){s.transferring=false;if(!s.dead)s.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:false});}throw error;}
      const prepared = [], staged = [];
      try {
        for (const item of next.detached) if (!this.windows.has(item.id)) { await this.detached(next, item); prepared.push(item.id); }
        for(const s of affected)if(s.pendingViewState&&next.views[s.viewId]){next.views[s.viewId].viewState=s.pendingViewState;s.pendingViewState=null;}
        if(r.dead||affected.some(s=>s.dead||s.generation!==generations.get(s)))throw fail('TRANSFER_SOURCE_CHANGED');
        for(const item of next.detached){const destination=this.windows.get(item.id);if(!destination||destination.dead||destination.win.isDestroyed())throw fail('TRANSFER_TARGET_CHANGED');}
        for(const s of affected){
          const location=findView(next,s.viewId);if(!location||location.windowId===s.windowId)continue;
          const destination=this.windows.get(location.windowId);
          if(!destination||destination.dead||destination.win.isDestroyed())throw fail('TRANSFER_TARGET_CHANGED');
          const move={surface:s,source:s.win,sourceWindowId:s.windowId,destination:destination.win,destinationWindowId:location.windowId,bounds:s.view.getBounds(),removed:false,attached:false};
          staged.push(move);destination.staging=(destination.staging||0)+1;
          s.view.setVisible(false);s.win.contentView.removeChildView(s.view);move.removed=true;
          destination.win.contentView.addChildView(s.view);move.attached=true;
        }
        await this.persist(next);
      } catch (error) {
        let rollbackFailed=false;
        for(const move of staged.reverse()){
          const s=move.surface;
          try{
            if(move.removed){try{move.destination.contentView.removeChildView(s.view);}catch(removeError){if(move.attached)throw removeError;}
              move.source.contentView.addChildView(s.view);}
            s.win=move.source;s.windowId=move.sourceWindowId;s.view.setBounds(move.bounds);
          }catch(rollbackError){rollbackFailed=true;s.recoveryHeld=true;this.onError(rollbackError);}
          const target=this.windows.get(move.destinationWindowId);if(target)target.staging=Math.max(0,(target.staging||1)-1);
        }
        // Never destroy a prepared parent if native rollback could not confirm that its live child returned.
        if(!rollbackFailed)for(const id of prepared){const w=this.windows.get(id);if(w){w.closing=true;w.win.destroy();this.windows.delete(id);}}
        for(const s of affected){s.transferring=false;s.held=!!s.recoveryHeld;if(!s.dead)s.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:s.held});}
        this.changed(layout);throw error;
      }
      this.layouts.set(layout.projectId, next);
      for(const move of staged){
        const s=move.surface;s.win=move.destination;s.windowId=move.destinationWindowId;
        const lease=this.leases.get(this.resource(s.projectId,s.relPath));if(lease?.viewId===s.viewId)lease.windowId=s.windowId;
        const target=this.windows.get(move.destinationWindowId);if(target)target.staging=Math.max(0,(target.staging||1)-1);
        s.wc.send('nozeli:workspace-control',{type:'host',...this.bootstrap(s)});
      }
      const result = { layout: next, windowId: r.windowId };
      this.requests.set(requestId, { input: JSON.stringify(payload), result }); if (this.requests.size > 512) this.requests.delete(this.requests.keys().next().value);
      try{await this.reconcile(next);}finally{for(const s of affected){s.transferring=false;s.held=false;if(!s.dead)s.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:false});}}
      this.projectVisibility(this.shell&&!this.shell.dead?this.shell.projectId:this.activeProjectId??layout.projectId);
      this.changed(next);
      return result;
    });
  }
  async closeWindow(r) {
    if (r.closePending) return;
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
    if (op === 'workspace.bootstrap') return this.bootstrap(r);
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
      const layout=this.layouts.get(r.projectId);if(layout?.views[r.viewId]){layout.views[r.viewId].viewState={...layout.views[r.viewId].viewState,documentStatus:{dirty:value.dirty,missing:value.missing,readOnly:false}};if(value.dirty)layout.views[r.viewId].preview=false;}
      for(const surface of this.projectRecords(r.projectId))if(surface.relPath===r.relPath&&surface.viewId!==r.viewId&&surface.readOnly&&!surface.dead)surface.wc.send('nozeli:workspace-control',{type:'document-buffer',...value,model:p.model});if(layout)this.changed(layout);return {revision:value.revision};
    }
    if(op==='workspace.settings')return this.serial('settings:'+r.projectId,async()=>{
      if(!r.projectId||p.projectId!==r.projectId||!p.workspace||typeof p.workspace!=='object'||Object.keys(p.workspace).some(key=>!['fontSize','conversationFontSize','readingWidth'].includes(key)))throw fail('INVALID_SETTINGS');
      if(Object.values(p.workspace).some(value=>!Number.isFinite(value))||p.projectSettings!==undefined&&(!p.projectSettings||Object.keys(p.projectSettings).some(key=>key!=='focusMode')||typeof p.projectSettings.focusMode!=='boolean'))throw fail('INVALID_SETTINGS');
      const prior=(await this.host.readState(r.projectId)).state??{};
      const value=await this.host.writeState(r.projectId,{...prior,workspace:{...prior.workspace,...p.workspace},projectSettings:p.projectSettings??prior.projectSettings});
      this.broadcast('nozeli:workspace-control',{type:'settings',projectId:r.projectId,workspace:value.state.workspace,projectSettings:value.state.projectSettings},r.projectId);return value;
    });
    if (op === 'workspace.ready') {
      r.ready=r.role!=='surface'||p.contentReady===true;r.readyResolve?.();const result=this.bootstrap(r);const layout=this.layouts.get(r.projectId);
      if(r.ready)r.loading=false;
      if(r.ready)r.wc.emit('nozeli-content-ready');
      if(layout)this.changed(layout);if(r.ready){for(const control of r.pendingControls||[])r.wc.send('nozeli:workspace-control',control);r.pendingControls=[];}return result;
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
      for (const surface of this.projectRecords(r.projectId, r.windowId)) {
        const item = p.groups?.find(item => item.viewId === surface.viewId && groups.some(g => g.id === item.groupId && g.activeViewId === surface.viewId));
        const rect = item?.rect;
        const [width, height] = r.win.getContentSize();
        const valid = rect && ['x','y','width','height'].every(k => Number.isFinite(rect[k])) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1;
        if (valid) surface.view.setBounds(Object.fromEntries(Object.entries(rect).map(([k,v]) => [k,Math.round(v)])));
        surface.view.setVisible(!!valid && !p.overlay && (surface.ready||surface.loading) && ![...this.drags.values()].some(d=>d.projectId===r.projectId));
      }
      return {};
    }
    if (op === 'workspace.control') {
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
        const conversation=Object.values(layout.views).find(v=>v.kind==='conversation');
        const root=this.windows.get(r.windowId)||this.windows.get('main');if(!root)throw fail('NO_ROOT');
        const result=await this.command(root,{projectId:r.projectId,expectedRevision:layout.revision,requestKey:randomUUID(),command:conversation?{type:'activate',viewId:conversation.id}:{type:'open',groupId:layoutGroups(layout,root.windowId)[0]?.id,view:{kind:'conversation'}}});
        const owner=this.surfaces.get(Object.values(result.layout.views).find(v=>v.kind==='conversation').id);if(!owner)throw fail('NO_ACTIVE_VIEW');
        if(owner.ready)owner.wc.send('nozeli:workspace-control',p);else(owner.pendingControls??=[]).push(p);owner.win.show();owner.win.focus();return {};
      }
      if(r.role==='surface'){
        const root=this.windows.get(r.windowId)||this.windows.get('main');if(!root)throw fail('NO_ROOT');root.wc.send('nozeli:workspace-control',{...p,sourceViewId:r.viewId,projectId:r.projectId});return {};
      }
      const group=layoutGroups(layout,r.windowId).find(g=>g.activeViewId),surface=this.surfaces.get(p.viewId||group?.activeViewId);
      if(!surface||surface.projectId!==r.projectId)throw fail('NO_ACTIVE_VIEW');surface.wc.send('nozeli:workspace-control',p);return {};
    }
    if (op === 'workspace.windows.list') return [...this.windows.values()].filter(w => w.projectId === r.projectId).map(w => ({ id:w.windowId, nativeWindowId:w.win.id,projectId:w.projectId,visible:!w.projectHidden&&typeof w.win.isVisible==='function'?w.win.isVisible():!w.projectHidden,projectHidden:!!w.projectHidden,surfaces:this.projectRecords(w.projectId,w.windowId).map(s=>({viewId:s.viewId,webContentsId:s.wc.id,relPath:s.relPath})) }));
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
      const sessionId = randomUUID();
      this.drags.set(sessionId,{source:r,projectId:r.projectId,viewId:p.viewId,groupId:p.groupId,revision:layout.revision,topology:topology(layout),generation:r.generation,expires:Date.now()+30000});
      const drag=this.drags.get(sessionId);drag.start={x:p.screenX,y:p.screenY,bounds:r.win.getBounds()};
      for(const surface of this.projectRecords(r.projectId))surface.view.setVisible(false);
      this.broadcast('nozeli:workspace-control',{type:'drag-session',sessionId,projectId:r.projectId},r.projectId); return {sessionId};
    }
    const d = this.drags.get(p.sessionId);
    if (!d || d.projectId !== r.projectId || d.expires < Date.now() || d.source.generation !== d.generation) throw fail('INVALID_DRAG');
    if (op === 'workspace.drag.target') {
      const layout = await this.layout(r.projectId);
      if (p.targetGroupId && !layoutGroups(layout,r.windowId).some(g => g.id === p.targetGroupId)) throw fail('IPC_DENIED');
      if(p.targetGroupId){if(!d.target||r!==d.source||d.target.record===d.source)d.target={record:r,groupId:p.targetGroupId,axis:p.axis,side:p.side,index:p.index};}else if(d.target?.record===r)d.target=null;return {};
    }
    if (d.source !== r) throw fail('IPC_DENIED');
    if(op==='workspace.drag.update'){
      if(!Number.isFinite(p.screenX)||!Number.isFinite(p.screenY))throw fail('INVALID_DRAG');
      d.target=null;d.screenX=p.screenX;d.screenY=p.screenY;
      this.dragPoint(d,p);return {};
    }
    if(op==='workspace.drag.end'&&p.cancelled===false){
      d.target=null;this.dragPoint(d,p);
      await new Promise(resolve=>setTimeout(resolve,60));
      if(this.drags.get(p.sessionId)!==d||d.source.dead)throw fail('INVALID_DRAG');
    }
    this.drags.delete(p.sessionId);
    this.broadcast('nozeli:workspace-control',{type:'drag-ended',sessionId:p.sessionId},r.projectId);
    if (op === 'workspace.drag.cancel' || p.cancelled === true) return {};
    if (op !== 'workspace.drag.end' || p.cancelled !== false) throw fail('INVALID_DRAG');
    const target = d.target;
    if(!target&&r.role==='detached'&&Number.isFinite(p.screenX)&&Number.isFinite(p.screenY)&&Number.isFinite(d.start.x)&&Number.isFinite(d.start.y)){
      const b=d.start.bounds;r.win.setBounds(restoreBounds({...b,x:b.x+p.screenX-d.start.x,y:b.y+p.screenY-d.start.y},this.screen));
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
  }
}
