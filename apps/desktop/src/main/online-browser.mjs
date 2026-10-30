import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {webPageCaptureScript} from './web-page-capture.mjs';
import {normalizeWebUrl, webTitle} from '../domain/web-url.mjs';

const denied = message => Object.assign(new Error(message), {code:'WEB_BROWSER_DENIED'});
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);

export class OnlineBrowserManager {
  constructor({WebContentsView, session, workspace, dialog, hostdialog, onNavigate, downloadDirectory, Menu, discussion}) {
    Object.assign(this, {WebContentsView, session, workspace, dialog:dialog ?? hostdialog, onNavigate, downloadDirectory, Menu, discussion});
    this.slots = new Map();
    this.generations = new Map();
    this.recoveryScopes = new Set();
  }
  owner(scope, payload) {
    if (!scope || scope.dead || scope.wc.isDestroyed() || scope.role !== 'surface' || scope.kind !== 'web' || payload.viewId !== scope.viewId || !identity(payload.key)) throw denied('网站页面身份无效。');
    const descriptor = this.workspace.layouts.get(scope.projectId)?.views[scope.viewId];
    if (descriptor?.kind !== 'web') throw denied('网站页面已关闭。');
    return `${scope.wc.id}:${payload.key}`;
  }
  require(scope, payload) {
    const slot = this.slots.get(this.owner(scope, payload));
    if (!slot || !this.alive(slot) || slot.generation !== payload.generation) throw denied('网站页面版本已失效。');
    return slot;
  }
  alive(slot) {
    return !slot.closed && !slot.scope.dead && !slot.scope.wc.isDestroyed() && slot.scope.generation === slot.ownerGeneration && slot.scope.projectId === slot.projectId && this.slots.get(slot.id) === slot;
  }
  allowed(raw, socket = false) {
    try {
      const url = new URL(raw);
      if (!(socket ? ['http:','https:','ws:','wss:'] : ['http:','https:']).includes(url.protocol) || url.username || url.password) return false;
      // WebSockets share the HTTP origin's trust boundary, including loopback.
      if (url.protocol === 'ws:') url.protocol = 'http:';
      if (url.protocol === 'wss:') url.protocol = 'https:';
      const app = this.workspace.origin && new URL(this.workspace.origin);
      if (!app) return true;
      const loopback = host => host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d+){3}$/.test(host) || host === '[::1]' || /^\[::ffff:(?:127\.|7f[\da-f]{2}:)/i.test(host);
      const port = value => value.port || (value.protocol === 'https:' ? '443' : '80');
      return url.origin !== app.origin && !(loopback(url.hostname) && loopback(app.hostname) && port(url) === port(app));
    } catch { return false; }
  }
  resourceAllowed(raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'data:') return true;
      if (url.protocol === 'blob:') return this.allowed(url.pathname);
      return this.allowed(raw, true);
    } catch { return false; }
  }
  browserSession() {
    if (this.onlineSession) return this.onlineSession;
    const ses = this.session.fromPartition('persist:nozeli-online-web');
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    ses.webRequest.onBeforeRequest((details, callback) => callback({cancel:!(details.resourceType === 'mainFrame' ? this.allowed(details.url) : this.resourceAllowed(details.url))}));
    ses.on('will-download', (event, item, wc) => {
      const slot = [...this.slots.values()].find(s => s.view.webContents === wc && this.alive(s));
      if (!slot || typeof item?.setSaveDialogOptions !== 'function') {
        event.preventDefault();
        if (slot) this.emit(slot, {error:'下载已阻止：原生文件另存对话框不可用。', download:'blocked'});
        return;
      }
      // Suggested names never become paths, and no file is written until the
      // user explicitly accepts Electron's native Save As dialog.
      const safeName = String(item.getFilename() || 'download').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || 'download';
      item.setSaveDialogOptions({title:'下载网站文件', defaultPath:this.downloadDirectory ? path.join(this.downloadDirectory, safeName) : safeName, properties:['showOverwriteConfirmation']});
      item.once('done', (_event, state) => {
        if (state === 'completed') this.emit(slot, {download:'completed', message:'文件已保存。'});
        else if (state === 'cancelled') this.emit(slot, {download:'cancelled', message:'已取消下载。'});
        else this.emit(slot, {download:'error', error:'网站文件下载失败：' + state});
      });
    });
    this.onlineSession = ses;
    return ses;
  }
  snapshot(slot) {
    const wc = slot.view.webContents, history = wc.navigationHistory;
    return {viewId:slot.scope.viewId, key:slot.key, generation:slot.generation, url:slot.url, title:slot.title, loading:!!wc.isLoading?.(), canGoBack:!!(history?.canGoBack?.() ?? wc.canGoBack?.()), canGoForward:!!(history?.canGoForward?.() ?? wc.canGoForward?.()), error:slot.error ?? null};
  }
  emit(slot, detail = {}) {
    if (!this.alive(slot)) return;
    slot.scope.wc.send('nozeli:web-state', {...this.snapshot(slot), ...detail});
  }
  committed(slot, raw) {
    if (!this.alive(slot) || !this.allowed(raw)) return;
    slot.url = normalizeWebUrl(raw);
    slot.committed = true;
    // A refresh or return to this exact committed address retains its thread.
    // Never move another page's binding, draft, or history to the new address.
    for (const binding of slot.discussionBindings?.values() ?? []) if (binding.url === slot.url) binding.epoch = slot.navigationEpoch;
    slot.title = webTitle(slot.url);
    slot.error = null;
    // Only host-observed committed URLs cross back into trusted layout state.
    slot.persist = (slot.persist ?? Promise.resolve()).then(() => {
      if (this.alive(slot)) return this.onNavigate?.(slot.scope, this.snapshot(slot));
    }).catch(error => this.emit(slot, {error:'网站地址保存失败：' + error.message}));
    this.emit(slot);
  }
  open(scope, payload) {
    const id = this.owner(scope, payload);
    if (!Number.isSafeInteger(payload.generation) || payload.generation < 1 || payload.generation <= (this.generations.get(id) ?? 0)) throw denied('网站页面版本已失效。');
    // An existing live guest must be explicitly closed; never discard its forms.
    if ([...this.slots.values()].some(s => s.scope === scope && !s.closed)) throw denied('请先关闭现有网站页面。');
    const url = normalizeWebUrl(this.workspace.layouts.get(scope.projectId).views[scope.viewId].url);
    if (!this.allowed(url)) throw denied('不能在网站页面中打开 Nozeli 内部地址。');
    const view = new this.WebContentsView({webPreferences:{session:this.browserSession(), sandbox:true, contextIsolation:true, javascript:true, nodeIntegration:false, nodeIntegrationInWorker:false, nodeIntegrationInSubFrames:false, webviewTag:false, webSecurity:true, allowRunningInsecureContent:false, devTools:false, navigateOnDragDrop:false, safeDialogs:true}});
    const slot = {id, scope, key:payload.key, generation:payload.generation, ownerGeneration:scope.generation, projectId:scope.projectId, url, title:webTitle(url), view, bounds:{x:0,y:0,width:0,height:0}, parentWindow:scope.previewWindow ?? scope.win};
    this.generations.set(id, payload.generation);
    this.slots.set(id, slot);
    const wc = view.webContents;
    view.setVisible(false);
    wc.setWindowOpenHandler(({url}) => {
      if (this.alive(slot) && this.allowed(url)) this.load(slot, url);
      else this.emit(slot, {error:'已阻止非 HTTP(S) 弹出地址。'});
      return {action:'deny'};
    });
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) { slot.navigationEpoch = (slot.navigationEpoch ?? 0) + 1; slot.navigating = true; } });
    wc.on('did-stop-loading', () => { slot.navigating = false; });
    wc.on('context-menu', (_event, params) => {
      if (!this.alive(slot) || !slot.committed || slot.navigating) return;
      const epoch = slot.navigationEpoch, url = slot.url;
      this.Menu?.buildFromTemplate([{label:'讨论此网页', click:() => {
        if (!this.alive(slot) || slot.navigationEpoch !== epoch || slot.url !== url || slot.navigating) return;
        slot.discussionBinding = {token:randomUUID(), url, epoch, quote:!params.isEditable && params.inputFieldType !== 'password' ? String(params.selectionText ?? '').slice(0, 16000) : ''};
        slot.discussionBindings ??= new Map();
        slot.discussionBindings.set(slot.discussionBinding.token,slot.discussionBinding);
        this.emit(slot, {discussionOpen:{token:slot.discussionBinding.token,url}});
      }}]).popup({window:slot.parentWindow});
    });
    const gate = (event, raw) => {
      const url = typeof raw === 'string' ? raw : event.url;
      const allowed = event.isMainFrame === false ? this.resourceAllowed(url) : this.allowed(url);
      if (!allowed) { event.preventDefault(); this.emit(slot, {error:'已阻止非网站地址或 Nozeli 内部地址。'}); }
    };
    wc.on('will-navigate', gate);
    wc.on('will-frame-navigate', gate);
    wc.on('will-redirect', gate);
    wc.on('will-prevent-unload', event => {
      const leave = this.dialog?.showMessageBoxSync?.(slot.parentWindow, {type:'warning', title:'离开网站？', message:'网站可能有尚未保存的内容。', detail:'离开或关闭后，网站中的未提交表单可能丢失。', buttons:['留在此页','离开'], defaultId:0, cancelId:0}) === 1;
      // Electron's preventDefault here means ignore the site's cancellation.
      if (leave) event.preventDefault();
      else { slot.closeResolve?.({closed:false,cancelled:true}); slot.closeResolve = null; this.emit(slot, {error:'已保留网站中尚未保存的内容。'}); }
    });
    wc.on('did-navigate', (_event, raw) => this.committed(slot, raw));
    wc.on('did-navigate-in-page', (_event, raw, isMainFrame) => { if (isMainFrame) this.committed(slot, raw); });
    for (const name of ['did-start-loading','did-stop-loading','page-title-updated']) wc.on(name, () => this.emit(slot));
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { slot.error = description || '网站加载失败'; this.emit(slot); }
    });
    wc.on('render-process-gone', (_event, detail) => { slot.error = '网站进程已退出：' + detail.reason; this.emit(slot); });
    wc.once('destroyed', () => this.release(slot));
    try {
      slot.parentWindow.contentView.addChildView(view);
      this.bounds(scope, {...payload, rect:payload.rect ?? payload.bounds ?? slot.bounds});
      this.load(slot, url);
      return this.snapshot(slot);
    } catch (error) { this.dispose(slot); throw error; }
  }
  load(slot, url) {
    slot.error = null;
    void slot.view.webContents.loadURL(url).catch(error => {
      if (error.code !== 'ERR_ABORTED' && error.errno !== -3) { slot.error = error.message; this.emit(slot); }
    });
  }
  navigate(scope, payload) {
    const slot = this.require(scope, payload), url = normalizeWebUrl(payload.url);
    if (!this.allowed(url)) throw denied('不能打开 Nozeli 内部地址。');
    this.load(slot, url);
    return this.snapshot(slot);
  }
  action(scope, payload) {
    const slot = this.require(scope, payload), wc = slot.view.webContents, history = wc.navigationHistory ?? wc;
    switch (payload.action) {
      case 'back': if (history.canGoBack()) history.goBack(); break;
      case 'forward': if (history.canGoForward()) history.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'stop': wc.stop(); break;
      default: throw denied('未知浏览器操作。');
    }
    return this.snapshot(slot);
  }
  async discussionAction(scope, payload) {
    const slot = this.require(scope, payload), binding = slot.discussionBindings?.get(payload.token);
    if (!binding || payload.token !== binding.token || payload.url !== binding.url) throw denied('网页讨论身份已失效，请从网页菜单重新打开。');
    if (!['read','draft','send','task'].includes(payload.action)) throw denied('未知网页讨论操作。');
    if (typeof this.discussion !== 'function') throw denied('网页讨论服务不可用。');
    const request = {action:payload.action,url:binding.url};
    if (payload.action !== 'read') {
      if (typeof payload.text !== 'string' || payload.text.length > 100000) throw denied('讨论内容无效。');
      request.text = payload.text;
      if (payload.action !== 'draft') {
        if (!identity(payload.messageId) || !payload.text.trim()) throw denied('讨论消息身份或内容无效。');
        request.messageId = payload.messageId;
        const captureEpoch = slot.navigationEpoch;
        const valid = () => this.alive(slot) && !slot.navigating && slot.navigationEpoch === captureEpoch && binding.epoch === captureEpoch && slot.url === binding.url && normalizeWebUrl(slot.view.webContents.getURL()) === binding.url;
        if (!valid()) throw denied('网页已导航或仍在加载，原讨论仍保留；返回原网页并等待加载完成后可继续发送。');
        const captured = await slot.view.webContents.executeJavaScriptInIsolatedWorld(999, [{code:webPageCaptureScript}]);
        if (!valid() || captured?.url !== binding.url) throw denied('提取网页时发生导航，未发送讨论。');
        request.assertLive = () => { if (!valid()) throw denied('网页在发送前已导航，未派发讨论。'); };
        const text = String(captured.text ?? '').slice(0,200000);
        request.material = {url:binding.url,title:String(captured.title ?? '').slice(0,2000),text,quote:binding.quote && text.includes(binding.quote) ? binding.quote : '',capturedAt:new Date().toISOString()};
      }
    }
    return this.discussion(slot.projectId, request);
  }
  bounds(scope, payload) {
    const slot = this.require(scope, payload), rect = payload.rect ?? payload.bounds;
    if (!rect || !['x','y','width','height'].every(k => Number.isFinite(rect[k])) || rect.width < 0 || rect.height < 0) throw denied('网站区域无效。');
    slot.bounds = {...rect}; slot.overlay = !!payload.overlay;
    this.refreshScope(scope);
    return {updated:true};
  }
  refreshScope(scope) {
    for (const slot of this.slots.values()) {
      if (slot.scope !== scope || slot.closed) continue;
      const parent = scope.view.getBounds(), zoom = scope.wc.getZoomFactor?.() ?? 1, b = slot.bounds;
      const x = Math.min(parent.width, Math.max(0, Math.round(b.x * zoom))), y = Math.min(parent.height, Math.max(0, Math.round(b.y * zoom)));
      const width = Math.max(0, Math.min(Math.round(b.width * zoom), parent.width - x)), height = Math.max(0, Math.min(Math.round(b.height * zoom), parent.height - y));
      slot.view.setBounds({x:parent.x+x,y:parent.y+y,width,height});
      slot.view.setVisible(this.alive(slot) && !scope.transferring && !scope.recoveryHeld && !scope.previewRecoveryFailed && !slot.overlay && scope.view.getVisible() && width > 0 && height > 0);
    }
  }
  release(slot) {
    if (slot.closed) return;
    slot.closed = true;
    try { slot.parentWindow?.contentView.removeChildView(slot.view); } catch {}
    if (this.slots.get(slot.id) === slot) this.slots.delete(slot.id);
    slot.closeResolve?.({closed:true}); slot.closeResolve = null;
  }
  dispose(slot) {
    this.release(slot);
    if (!slot.view.webContents.isDestroyed()) slot.view.webContents.close({waitForBeforeUnload:false});
  }
  close(scope, payload) {
    const slot = this.require(scope, payload);
    if (slot.closing) return slot.closing;
    const promise = new Promise(resolve => { slot.closeResolve = resolve; });
    slot.closing = promise;
    slot.view.webContents.close({waitForBeforeUnload:true});
    if (slot.view.webContents.isDestroyed()) this.release(slot);
    return promise.finally(() => { slot.closing = null; });
  }
  async closeScope(scope) {
    for (const slot of [...this.slots.values()]) {
      if (slot.scope !== scope) continue;
      if (!this.alive(slot)) this.dispose(slot);
      else if (!(await this.close(scope, {viewId:scope.viewId,key:slot.key,generation:slot.generation})).closed) return {closed:false,cancelled:true};
    }
    this.recoveryScopes.delete(scope);
    return {closed:true};
  }
  // Only for an irrecoverable wrapper crash/navigation/destruction. Normal
  // user close must await closeScope so website beforeunload can retain forms.
  forceCloseScope(scope) {
    for (const slot of [...this.slots.values()]) if (slot.scope === scope) this.dispose(slot);
    this.recoveryScopes.delete(scope);
    return {closed:true};
  }
  async closeAll() {
    for (const scope of new Set([...this.slots.values()].map(slot => slot.scope))) {
      if (!(await this.closeScope(scope)).closed) return {closed:false,cancelled:true};
    }
    return {closed:true};
  }
  reparentScope(scope, destination) {
    const moved = [];
    try {
      for (const slot of this.slots.values()) {
        if (slot.scope !== scope || slot.closed || slot.parentWindow === destination) continue;
        const source = slot.parentWindow;
        slot.view.setVisible(false);
        source.contentView.removeChildView(slot.view); slot.parentWindow = null;
        moved.push({slot,source});
        destination.contentView.addChildView(slot.view); slot.parentWindow = destination;
      }
    } catch (error) {
      const failures = [];
      for (const {slot,source} of moved.reverse()) try {
        slot.parentWindow?.contentView.removeChildView(slot.view); slot.parentWindow = null;
        source.contentView.addChildView(slot.view); slot.parentWindow = source;
      } catch (failure) { failures.push(failure); }
      if (failures.length) { this.holdScope(scope, [destination,...moved.map(m => m.source)]); throw Object.assign(new AggregateError([error,...failures], '网站迁移回滚失败；已保留窗口。'), {previewRollbackFailed:true}); }
      throw error;
    }
  }
  holdScope(scope, parents) {
    scope.recoveryHeld = true;
    scope.previewRecoveryFailed = true;
    scope.previewRecoveryParents ??= new Set();
    for (const parent of parents) if (parent) scope.previewRecoveryParents.add(parent);
    this.recoveryScopes.add(scope);
    for (const slot of this.slots.values()) if (slot.scope === scope) slot.view.setVisible(false);
  }
  holdsWindow(win) {
    return [...this.recoveryScopes].some(scope => scope.previewRecoveryParents.has(win));
  }
}
