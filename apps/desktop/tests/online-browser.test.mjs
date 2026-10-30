import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {OnlineBrowserManager} from '../src/main/online-browser.mjs';
import {normalizeWebUrl, webTitle} from '../src/domain/web-url.mjs';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';

test('web addresses normalize HTTP(S), host ports and IDNs without accepting privileged schemes', () => {
  assert.equal(normalizeWebUrl(' example.com/a?q=1#x '), 'https://example.com/a?q=1#x');
  assert.equal(normalizeWebUrl('localhost:8080/path'), 'https://localhost:8080/path');
  assert.equal(normalizeWebUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(webTitle('https://例子.测试/path'), 'xn--fsqu00a.xn--0zwm56d');
  for (const input of ['', null, 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'nozeli://main', 'https://user:pass@example.com', 'https://example.com\n', 'https://exam ple.com', 'https:\\example.com']) assert.throws(() => normalizeWebUrl(input), {code:'WEB_URL_INVALID'});
});

function harness() {
  const views = [], events = [], sessions = [], navigated = [];
  const window = () => {
    const children = new Set();
    return {children, contentView:{addChildView(view) { children.add(view); }, removeChildView(view) { children.delete(view); }}};
  };
  class View {
    constructor(options) {
      this.options = options; this.visible = false;
      const wc = this.webContents = new EventEmitter();
      wc.id = 900 + views.length; wc.dead = false; wc.formDirty = false;
      wc.isDestroyed = () => wc.dead;
      wc.isLoading = () => !!wc.loading;
      wc.setWindowOpenHandler = fn => wc.popup = fn;
      wc.loadURL = async url => { wc.loading = true; wc.requested = url; };
      wc.navigationHistory = {canGoBack:() => true, canGoForward:() => false, goBack:() => wc.back = true, goForward:() => wc.forward = true};
      wc.reload = () => wc.reloaded = true; wc.stop = () => wc.loading = false;
      wc.close = options => {
        wc.closeOptions = options;
        if (wc.formDirty && options.waitForBeforeUnload) {
          let leave = false;
          wc.emit('will-prevent-unload', {preventDefault() { leave = true; }});
          if (!leave) return;
        }
        wc.dead = true; wc.emit('destroyed');
      };
      this.setBounds = rect => this.rect = rect;
      this.setVisible = visible => this.visible = visible;
      views.push(this);
    }
  }
  const session = {fromPartition(partition) {
    const ses = new EventEmitter(); ses.partition = partition;
    ses.setPermissionRequestHandler = fn => ses.permission = fn;
    ses.setPermissionCheckHandler = fn => ses.check = fn;
    ses.setDevicePermissionHandler = fn => ses.device = fn;
    ses.setDisplayMediaRequestHandler = fn => ses.capture = fn;
    ses.webRequest = {onBeforeRequest(fn) { ses.request = fn; }};
    sessions.push(ses); return ses;
  }};
  const scope = {role:'surface', kind:'web', viewId:'web-1', projectId:'p', generation:4, win:window(), wc:{id:1, isDestroyed:() => false, getZoomFactor:() => 1.5, send:(channel, value) => events.push({channel,value})}, view:{getBounds:() => ({x:100,y:50,width:600,height:400}), getVisible:() => true}};
  const descriptor = {kind:'web', url:'https://example.org/'};
  const workspace = {origin:'http://127.0.0.1:31415/', layouts:new Map([['p',{views:{'web-1':descriptor}}]]), senders:new Map()};
  const dialog = {response:0, showMessageBoxSync() { return this.response; }};
  const manager = new OnlineBrowserManager({WebContentsView:View, session, workspace, dialog, onNavigate:(_scope,state) => navigated.push(state)});
  const payload = {viewId:scope.viewId, key:'nonce-1', generation:1, url:'https://untrusted-argument.example/', rect:{x:10,y:20,width:300,height:200}};
  return {manager,scope,payload,views,events,sessions,workspace,descriptor,dialog,navigated,window};
}

test('real manager creates an isolated persistent unprivileged browser from host descriptor', () => {
  const h = harness(); const state = h.manager.open(h.scope,h.payload), wc = h.views[0].webContents, prefs = h.views[0].options.webPreferences;
  assert.equal(wc.requested,h.descriptor.url); assert.equal(state.url,h.descriptor.url);
  assert.equal(h.sessions[0].partition,'persist:nozeli-online-web');
  for (const key of ['nodeIntegration','nodeIntegrationInWorker','nodeIntegrationInSubFrames','webviewTag','devTools','allowRunningInsecureContent']) assert.equal(prefs[key],false);
  for (const key of ['sandbox','contextIsolation','webSecurity','javascript']) assert.equal(prefs[key],true);
  assert.equal(prefs.preload,undefined); assert.equal(h.workspace.senders.size,0);
  const workspace = Object.create(WorkspaceNative.prototype); workspace.senders = new Map(); workspace.origin = h.workspace.origin;
  const frame = {url:'https://example.org/',parent:null}; wc.mainFrame = frame;
  for (const op of ['file.read','workspace.bootstrap','managed.send','web.open']) assert.throws(() => workspace.authorize({sender:wc,senderFrame:frame},op,{}), {code:'IPC_DENIED'});
});

test('permissions, network subresources, downloads and popup gates enforce the host boundary', () => {
  const h = harness(); h.manager.open(h.scope,h.payload); const ses = h.sessions[0], wc = h.views[0].webContents;
  for (const name of ['media','geolocation','clipboard-read','usb','serial','bluetooth','display-capture']) ses.permission(wc,name,value => assert.equal(value,false));
  assert.equal(ses.check(),false); assert.equal(ses.device(),false); ses.capture({},value => assert.deepEqual(value,{}));
  for (const url of ['file:///etc/passwd','nozeli://main','devtools://x',h.workspace.origin+'api','ws://127.0.0.1:31415/socket','http://localhost:31415/api','https://[::1]:31415/api','ws://127.1:31415/socket','blob:http://localhost:31415/id']) ses.request({url},value => assert.equal(value.cancel,true,url));
  for (const url of ['https://example.org/script.js','http://localhost:8080/app','ws://localhost:8080/socket','wss://example.org/socket','data:image/png;base64,aGVsbG8=','blob:https://example.org/id']) ses.request({url,resourceType:'image'},value => assert.equal(value.cancel,false,url));
  for (const url of ['data:text/html,x','blob:https://example.org/id']) ses.request({url,resourceType:'mainFrame'},value => assert.equal(value.cancel,true,url));
  let prevented = false; ses.emit('will-download',{preventDefault() { prevented = true; }},{},wc);
  assert.equal(prevented,true); assert.match(h.events.at(-1).value.error,/下载/);
  assert.equal(wc.popup({url:'https://other.example/'}).action,'deny'); assert.equal(wc.requested,'https://other.example/');
  wc.popup({url:'file:///etc/passwd'}); assert.equal(wc.requested,'https://other.example/');
  for (const name of ['will-navigate','will-frame-navigate','will-redirect']) {
    let blocked = false; wc.emit(name,{url:h.workspace.origin,preventDefault() { blocked = true; }}); assert.equal(blocked,true);
    blocked = false; wc.emit(name,{url:'https://example.org/',preventDefault() { blocked = true; }}); assert.equal(blocked,false);
  }
});

test('scope, key, generation and ownership reject cross-pane or stale operations', async () => {
  const h = harness(); h.manager.open(h.scope,h.payload);
  for (const change of [{viewId:'other'},{key:'other'},{generation:0},{generation:2}]) assert.throws(() => h.manager.navigate(h.scope,{...h.payload,...change,url:'https://safe.example/'}));
  assert.throws(() => h.manager.open(h.scope,{...h.payload,key:'second',generation:2}));
  assert.throws(() => h.manager.navigate(h.scope,{...h.payload,url:h.workspace.origin}));
  assert.throws(() => h.manager.open({...h.scope,role:'shell'},h.payload));
  await h.manager.close(h.scope,h.payload);
  assert.equal(h.manager.slots.size,0);
  assert.throws(() => h.manager.open(h.scope,h.payload));
  h.manager.open(h.scope,{...h.payload,generation:2}); assert.equal(h.sessions.length,1);
  h.scope.generation++; assert.throws(() => h.manager.action(h.scope,{...h.payload,generation:2,action:'reload'}));
  await h.manager.closeScope(h.scope); assert.equal(h.manager.slots.size,0); assert.equal(h.views[1].webContents.dead,true);
});

test('committed browser URLs persist without website IPC and stale events cannot update host state', async () => {
  const h = harness(); h.manager.open(h.scope,h.payload); const wc = h.views[0].webContents;
  wc.emit('did-navigate',{},'https://redirect.example/path');
  await Promise.resolve(); assert.equal(h.navigated.at(-1).url,'https://redirect.example/path'); assert.equal(h.navigated.at(-1).title,'redirect.example');
  wc.emit('did-navigate',{},h.workspace.origin); await Promise.resolve(); assert.equal(h.navigated.length,1);
  h.manager.action(h.scope,{...h.payload,action:'back'}); assert.equal(wc.back,true);
  h.manager.action(h.scope,{...h.payload,action:'reload'}); assert.equal(wc.reloaded,true);
  wc.emit('did-fail-load',{},-202,'Certificate invalid','https://redirect.example/',true); assert.equal(h.events.at(-1).value.error,'Certificate invalid');
  await h.manager.close(h.scope,h.payload);
  const count = h.events.length; wc.emit('did-navigate',{},'https://stale.example/'); await Promise.resolve(); assert.equal(h.events.length,count); assert.equal(h.navigated.length,1);
});

test('geometry uses wrapper zoom, occlusion and reversible parent transfer without orphan guests', async () => {
  const h = harness(); h.manager.open(h.scope,h.payload); const view = h.views[0], original = h.scope.win, destination = h.window();
  assert.deepEqual(view.rect,{x:115,y:80,width:450,height:300}); assert.equal(view.visible,true);
  h.manager.bounds(h.scope,{...h.payload,rect:h.payload.rect,overlay:true}); assert.equal(view.visible,false);
  h.manager.bounds(h.scope,{...h.payload,rect:h.payload.rect,overlay:false});
  h.manager.reparentScope(h.scope,destination); assert.equal(original.children.size,0); assert.equal(destination.children.has(view),true); assert.equal(view.visible,false);
  h.manager.refreshScope(h.scope); assert.equal(view.visible,true);
  const broken = {contentView:{addChildView() { throw Error('attach failed'); },removeChildView() {}}};
  assert.throws(() => h.manager.reparentScope(h.scope,broken),/attach failed/); assert.equal(destination.children.has(view),true);
  h.manager.holdScope(h.scope,[original,destination]); assert.equal(view.visible,false); assert.equal(h.manager.holdsWindow(destination),true);
  h.scope.dead = true; await h.manager.closeScope(h.scope); assert.equal(destination.children.size,0); assert.equal(view.webContents.dead,true); assert.equal(h.manager.holdsWindow(destination),false);
});

test('beforeunload cancellation retains forms and explicit confirmation permits pane close', async () => {
  const h = harness(); h.manager.open(h.scope,h.payload); const wc = h.views[0].webContents; wc.formDirty = true;
  assert.deepEqual(await h.manager.closeScope(h.scope),{closed:false,cancelled:true});
  assert.equal(wc.dead,false); assert.equal(h.manager.slots.size,1); assert.equal(h.scope.win.children.size,1);
  assert.equal(wc.closeOptions.waitForBeforeUnload,true);
  h.dialog.response = 1; assert.deepEqual(await h.manager.closeAll(),{closed:true}); assert.equal(wc.dead,true); assert.equal(h.manager.slots.size,0);
});

test('irrecoverable wrapper cleanup disposes guests without mutating owner state', () => {
  const h = harness(); h.manager.open(h.scope,h.payload); const wc = h.views[0].webContents; wc.formDirty = true;
  assert.deepEqual(h.manager.forceCloseScope(h.scope),{closed:true});
  assert.equal(h.scope.dead,undefined); assert.equal(wc.dead,true);
  assert.equal(wc.closeOptions.waitForBeforeUnload,false); assert.equal(h.manager.slots.size,0); assert.equal(h.scope.win.children.size,0);
});

test('owned website downloads use native Save As without implicit filesystem writes or auto-open', () => {
  const h = harness(); h.manager.downloadDirectory = '/user/downloads'; h.manager.open(h.scope,h.payload);
  const wc = h.views[0].webContents, ses = h.sessions[0];
  for (const state of ['completed','cancelled','interrupted']) {
    const item = new EventEmitter(); let options, prevented = false;
    item.getFilename = () => '../../report?.txt';
    item.setSaveDialogOptions = value => options = value;
    item.setSavePath = () => assert.fail('must require the native Save As dialog');
    ses.emit('will-download',{preventDefault() { prevented = true; }},item,wc);
    assert.equal(prevented,false);
    assert.deepEqual(options,{title:'下载网站文件',defaultPath:'/user/downloads/report_.txt',properties:['showOverwriteConfirmation']});
    item.emit('done',{},state);
    assert.equal(h.events.at(-1).value.download,state === 'interrupted' ? 'error' : state);
  }
  let blocked = false;
  const foreignItem = {setSaveDialogOptions() { assert.fail('unknown guest cannot download'); }};
  ses.emit('will-download',{preventDefault() { blocked = true; }},foreignItem,{id:9999});
  assert.equal(blocked,true);
});

test('native website discussion binds committed URL and rejects forged tokens and navigation capture races', async () => {
  const h=harness(),requests=[];let menu;
  h.manager.Menu={buildFromTemplate(items){menu=items;return {popup(){}};}};
  h.manager.discussion=async(projectId,request)=>{requests.push({projectId,request});return {draft:''};};
  h.manager.open(h.scope,h.payload);const wc=h.views[0].webContents;
  wc.getURL=()=>h.manager.slots.values().next().value.url;
  wc.emit('context-menu',{},{});assert.equal(menu,undefined);
  wc.emit('did-navigate',{},'https://example.org/a');
  wc.emit('context-menu',{},{isEditable:true,inputFieldType:'password',selectionText:'secret'});menu[0].click();
  const binding=h.events.at(-1).value.discussionOpen;
  assert.equal(binding.url,'https://example.org/a');assert.equal(requests.length,0);
  await assert.rejects(h.manager.discussionAction(h.scope,{...h.payload,...binding,token:'forged',action:'read'}));
  await h.manager.discussionAction(h.scope,{...h.payload,...binding,action:'draft',text:'original draft'});
  assert.equal(requests[0].request.url,binding.url);
  wc.executeJavaScriptInIsolatedWorld=async()=>({url:binding.url,title:'Title',text:'public text'});
  await h.manager.discussionAction(h.scope,{...h.payload,...binding,action:'send',messageId:'message-123',text:'question'});
  assert.equal(requests.at(-1).request.material.quote,'');
  wc.executeJavaScriptInIsolatedWorld=async()=>{wc.emit('did-start-navigation',{},'https://example.org/b',false,true);return {url:binding.url,text:'stale'};};
  const count=requests.length;
  await assert.rejects(h.manager.discussionAction(h.scope,{...h.payload,...binding,action:'send',messageId:'message-456',text:'question'}),/导航/);
  assert.equal(requests.length,count);
  wc.emit('did-navigate',{},'https://example.org/b');
  await h.manager.discussionAction(h.scope,{...h.payload,...binding,action:'draft',text:'still A'});
  assert.equal(requests.at(-1).request.url,'https://example.org/a');
});

test('same-page refresh and exact URL return reuse binding without admitting in-flight stale captures', async()=>{
  const h=harness(),requests=[];let menu;
  h.manager.Menu={buildFromTemplate(items){menu=items;return {popup(){}};}};
  h.manager.discussion=async(projectId,request)=>{request.assertLive?.();requests.push(request);return {draft:''};};
  h.manager.open(h.scope,h.payload);const wc=h.views[0].webContents;
  wc.getURL=()=>h.manager.slots.values().next().value.url;
  const commit=url=>{wc.emit('did-start-navigation',{},url,false,true);wc.emit('did-navigate',{},url);wc.emit('did-stop-loading');};
  commit('https://example.org/a');wc.emit('context-menu',{},{});menu[0].click();const binding=h.events.at(-1).value.discussionOpen;
  const send=()=>h.manager.discussionAction(h.scope,{...h.payload,...binding,action:'send',messageId:'refresh-message-1',text:'question'});
  wc.executeJavaScriptInIsolatedWorld=async()=>({url:wc.getURL(),title:'Refreshed',text:'new page text'});
  commit(binding.url);await send();assert.equal(requests.length,1);assert.equal(requests[0].material.text,'new page text');
  commit('https://example.org/b');await assert.rejects(send(),/导航/);assert.equal(requests.length,1);
  commit(binding.url);await send();assert.equal(requests.length,2);assert.equal(requests[1].url,binding.url);
  wc.executeJavaScriptInIsolatedWorld=async()=>{commit(binding.url);return {url:binding.url,title:'Old',text:'stale capture'};};
  await assert.rejects(send(),/导航/);assert.equal(requests.length,2);
});
