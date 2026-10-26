if (process.argv.includes('--nozeli-terminal-client')) { require('../agents/system-terminal-entry.cjs'); return; }
// Packaged helper dispatch must precede profile and singleton initialization.
if (process.argv.includes('--nozeli-handoff')) {
  require('../agents/handoff-entry.cjs');
  return;
}
if (process.argv.includes('--nozeli-document')) {
  require('../agents/document-entry.cjs');
  return;
}
const { app, BaseWindow, WebContentsView, screen, ipcMain, Menu, shell, clipboard, nativeTheme } = require('electron');
const {WorkspaceWindow} = require('./workspace-window.cjs');
let dialog, session;
let DesktopHost, HostError, ops, agents, managedAgents, agentHandlers, lspManager, formatterService, texManager, texLanguage, guidedDemo;
const http = require('node:http');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {WindowRecovery,forWindow:windowRecovery} = require('./window-recovery.cjs');

const APP_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ROOT = path.join(APP_ROOT, 'dist/renderer');
const HIDDEN = process.env.NOZELI_HIDDEN === '1';
const FORCE_VISIBLE = process.env.NOZELI_FORCE_VISIBLE === '1';
const DEBUG_PORT = process.env.NOZELI_DEBUG_PORT || '';
const externalFiles=[];
app.on('open-file',(event,file)=>{event.preventDefault();externalFiles.push(file);void revealNavigation().catch(error=>console.error('external open routing failed',error));});
const ISOLATED_TEST_INSTANCE = process.env.NOZELI_TEST_INSTANCE === '1';
if (HIDDEN) {
  app.commandLine.appendSwitch('ozone-platform', process.env.NOZELI_OZONE || 'headless');
  app.disableHardwareAcceleration();
}
if (DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', DEBUG_PORT);
// Wayland + this Electron's Vulkan backend crashes the GPU process during
// startup (exit 133), which kills renderer module evaluation before the shell
// reports ready; --disable-vulkan alone does not stop the cascade. Composite in
// software on Wayland, matching Chromium's own post-crash fallback.
if (process.platform === 'linux' && process.argv.some(arg => arg.includes('ozone-platform=wayland'))) app.commandLine.appendSwitch('disable-gpu');
// Speculative DNS has no resource request to fence in an isolated session.
app.commandLine.appendSwitch('dns-prefetch-disable');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/octet-stream',
};

function startStatic() {
  const styleNonce = randomBytes(24).toString('base64');
  const root = path.resolve(RENDERER_ROOT);
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405).end();
          return;
        }
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        let rel = decodeURIComponent(url.pathname);
        if (rel === '/' || rel === '') rel = process.env.NOZELI_EDITOR_LAB === '1' && ISOLATED_TEST_INSTANCE ? '/editor-lab.html' : '/index.html';
        if (rel.startsWith('/editor-lab')) { if (process.env.NOZELI_EDITOR_LAB !== '1' || !ISOLATED_TEST_INSTANCE) { res.writeHead(404).end(); return; } }
        if (rel.includes('\0') || rel.includes('\\') || !rel.startsWith('/')) {
          res.writeHead(400).end();
          return;
        }
        const abs = path.resolve(root, rel.slice(1));
        if (abs !== root && !abs.startsWith(root + path.sep)) {
          res.writeHead(403).end();
          return;
        }
        const body = rel === '/index.html' || rel === '/editor-lab.html'
          ? (await fs.readFile(abs, 'utf8')).replaceAll('__NOZELI_STYLE_NONCE__', styleNonce)
          : await fs.readFile(abs);
        res.writeHead(200, {
          'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          ...(rel.startsWith('/ppt-vendor/') ? {'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: data:; media-src 'self' blob: data:; object-src 'none'; frame-src 'none'"} : {}),
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch (error) {
        res.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

let host, fileTreeOps, treeMenuItems;
let workspaceNative, isolatedPreview, workspaceCapture, projectLifecycle;
async function finishDrawing({windowId,projectId}={}){
  const active=workspaceCapture?.active;
  if(windowId&&active?.windowId!==windowId||projectId&&active?.projectId!==projectId)return;
  if(active){const owner=workspaceNative.senders.get(active.ownerWc.id);if(owner&&!owner.dead)await workspaceNative.flush([owner]);}
  await workspaceCapture?.shutdown();
}
let projectWatcher;
let allowClose = false;
let quitting = false;
let quitPending=false;
let origin = '';
async function syncDocument(payload) {
  if (!workspaceNative) throw new HostError('NOT_READY','编辑界面尚未就绪。');
  return workspaceNative.syncDocument(payload);
}
let restoringNavigation=null;
async function revealNavigation(){
  if(!workspaceNative)return;
  let root=workspaceNative.windows.get('main');
  if(!root||root.dead){restoringNavigation??=Promise.resolve().then(()=>workspaceNative.restoreShell?.()).finally(()=>{restoringNavigation=null;});await restoringNavigation;root=workspaceNative.windows.get('main');}
  if(root&&!root.dead){revealWindow(root.win);root.wc.send('nozeli:open-request');}
}

function revealWindow(win) {
  if (!win || HIDDEN || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (typeof win.moveTop === 'function') win.moveTop();
  if (FORCE_VISIBLE) {
    win.setAlwaysOnTop(true, 'floating');
    setTimeout(() => {
      if (!win.isDestroyed()) win.setAlwaysOnTop(false);
    }, 2500).unref?.();
  }
}

function trusted(event, op, payload) {
  return workspaceNative.authorize(event, op, payload);
}

  function testPickPaths() {
    return (process.env.NOZELI_TEST_PICK || '').split('\n').filter(Boolean);
  }
  function showDirectoryDialog(owner, options) {
    // Native Wayland parent export can stall before the portal receives a request.
    // The unparented overload avoids xdg-foreign; other backends retain modality.
    const ozone=app.commandLine.getSwitchValue('ozone-platform');
    const wayland=process.platform==='linux'&&(ozone==='wayland'||(!ozone&&Boolean(process.env.WAYLAND_DISPLAY)));
    return wayland ? dialog.showOpenDialog(options) : dialog.showOpenDialog(owner, options);
  }
  async function pickDirectory(win, requested) {
    const picks = testPickPaths();
    if (picks.length) return picks.includes(requested) ? requested : picks[0];
    const result = await showDirectoryDialog(win, { properties: ['openDirectory'], title: '选择项目目录' });
    if (result.canceled || !result.filePaths?.[0]) return null;
    return result.filePaths[0];
  }

function respond(error) {
  return {
    ok: false,
    error: {
      code: error.code || 'ERROR',
      message: error.message || String(error),
      details: error.details || {},
    },
  };
}

async function createWindow(server) {
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}/`;
  const win = new WorkspaceWindow({
    width: 1440,
    height: 900,
    show: !HIDDEN,
    frame: false,
    title: '选择项目',
    icon: path.join(APP_ROOT,'assets/nozeli.png'),
    backgroundColor: '#f3f4f0',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(APP_ROOT, 'src/preload/preload.cjs'),
    },
  });
  const menuAction = action => win.webContents.send('nozeli:menu-action', action);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{role:'appMenu'}] : []),
    {label:'文件',submenu:[{label:'打开项目…',accelerator:'CmdOrCtrl+O',click:()=>menuAction('open-project')},{type:'separator'},{label:'关闭窗口',click:()=>win.close()}]},
    {label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]},
    {label:'视图',submenu:[{label:'专注模式',accelerator:'CmdOrCtrl+Shift+F11',click:()=>menuAction('focus')},{id:'view.authorship',label:'显示修改者',type:'checkbox',checked:true,click:()=>menuAction('authorship-toggle')},{label:'当前文件修改记录…',click:()=>menuAction('authorship-history')},{role:'togglefullscreen',label:'全屏'}]},
    {label:'窗口',submenu:[{role:'minimize',label:'最小化'},{role:'zoom',label:'缩放窗口'}]},
  ]));
  if(process.platform !== 'darwin'){win.setMenu(null);win.setMenuBarVisibility(false);}
  win.webContents.once('did-finish-load', () => revealWindow(win));
  const scope = workspaceNative.registerShell(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const recovery=new WindowRecovery(win,{
    dialog,settle:async()=>{await workspaceNative.flush([...workspaceNative.senders.values()].filter(r=>r.role==='surface'));await host.settled();},busy:()=>agents?.busy()||managedAgents?.busy(),
    stop:async()=>{await managedAgents?.stop();await agents?.stopIdle?.();},
    reveal:()=>revealWindow(win),onClose:()=>{allowClose=true;quitting=true;for(const s of [...workspaceNative.surfaces.values()])workspaceNative.destroySurface(s);for(const r of workspaceNative.windows.values()){r.closing=true;r.win.close();}},
  });
  win.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)recovery.navigation();});
  win.webContents.on('render-process-gone',(_event,details)=>{console.error('renderer gone',details);recovery.rendererGone(details);});
  win.on('closed',()=>recovery.destroyed());
  win.on('close',event=>{
    if(workspaceCapture?.active?.windowId===scope.windowId){event.preventDefault();void finishDrawing({windowId:scope.windowId}).then(()=>win.close()).catch(error=>console.error('drawing close failed',error));return;}
    if(allowClose||quitting||scope.closing)return;
    event.preventDefault();
    if(workspaceNative.currentWindowCount()>1)void workspaceNative.closeWindow(scope).catch(error=>console.error('window close failed',error));
    else recovery.requestClose();
  });
  win.webContents.on('did-finish-load', () => {
    recovery.loaded();
    revealWindow(win);
    console.log(`NOZELI_DESKTOP_READY ${origin} hidden=${HIDDEN} debugPort=${DEBUG_PORT || 'none'}`);
  });
  await win.loadURL(origin);
  return win;
}

async function main() {
  const {acquireApplicationSingleton}=require('./application-singleton.cjs');
  const pendingLaunches=[];
  let routeLaunch=null;
  app.on('second-instance',(_event,argv,cwd)=>{
    if(routeLaunch)routeLaunch(argv,cwd);else pendingLaunches.push({argv,cwd});
  });
  // No profile resolution, migration, host or Agent creation before this lock.
  // Isolated test instances run synthetic profiles in parallel; they must not
  // kill each other over the OS-account singleton, which guards real launches.
  if(!ISOLATED_TEST_INSTANCE && !acquireApplicationSingleton(app)){app.exit(0);return;}
  const {fileArguments, externalTarget}=await import('./external-open.mjs');
  routeLaunch=(argv,cwd)=>{
    externalFiles.push(...fileArguments(argv,{packaged:app.isPackaged,cwd}).filter(file=>file!==__filename&&file!==APP_ROOT));
    void revealNavigation().catch(error=>console.error('external open routing failed',error));
  };
  routeLaunch(process.argv,process.cwd());
  for(const launch of pendingLaunches)routeLaunch(launch.argv,launch.cwd);
  const {resolveNozeliPaths,initializeNozeliConfiguration,readNozeliConfiguration,completeNozeliConfiguration}=await import('../agents/managed/nozeli-config.mjs');
  const nozeliPaths=resolveNozeliPaths();
  await initializeNozeliConfiguration(nozeliPaths);
  // The temporary lock path was already restored synchronously. Chromium's
  // session must now use the initialized profile, never the lock directory.
  app.setPath('userData',nozeliPaths.desktop);
  app.setPath('sessionData',nozeliPaths.desktop);
  await app.whenReady();
  app.setName('Nozeli');
  ({ dialog, session } = require('electron'));
  ({ DesktopHost, HostError, ops } = await import('./host.mjs'));
  const { LanguageServiceManager } = await import('./language-service-manager.mjs');
  const { FormatterService } = await import('./formatter-service.mjs');
  const { AgentRuntime } = await import('../agents/runtime.mjs');
  const { agentOps } = await import('../agents/ipc.mjs');
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  host = new DesktopHost(app.getPath('userData'),{onDocumentChange:payload=>workspaceNative?.broadcast('nozeli:document',payload,payload.projectId)});
  const { FileTreeOps } = await import('./file-tree-ops.mjs');
  ({ treeMenuItems } = await import('./file-tree-menu.mjs'));
  fileTreeOps = new FileTreeOps(host, { trash: p => shell.trashItem(p) });
  formatterService = new FormatterService({ host });
  const { TexLanguageService } = await import('./tex-language-service.mjs');
  texLanguage = new TexLanguageService({host, onEvent: payload => workspaceNative?.broadcast('nozeli:lsp',payload,payload.projectId)});
  const { TexBuildManager } = await import('./tex-build-manager.mjs');
  texManager = new TexBuildManager({ host, onEvent: payload => workspaceNative?.broadcast('nozeli:tex',payload,payload.projectId) });
  lspManager = new LanguageServiceManager({ host, userDataDir: app.getPath('userData'), onEvent: payload => workspaceNative?.broadcast('nozeli:lsp',payload,payload.projectId) });
  // Previous two-slot transcripts are read-only records, never another backend.
  agents = new AgentRuntime({userDataDir:app.getPath('userData')});
  agents.onEvent(event => workspaceNative?.broadcast('nozeli:agent',event,event.projectId));
  agentHandlers = agentOps(agents);
  const {ManagedProjects}=await import('../agents/managed-projects.mjs');
  const {resolveBundledOmpRuntime}=await import('../agents/managed/omp-runtime.mjs');
  const {createNozeliOmpSource}=await import('../agents/managed/omp-system-source.mjs');
  const {OmpAuthBrokerHost}=await import('../agents/managed/omp-auth-broker.mjs');
  let ompRuntime=null,ompRuntimeError=null;
  try { ompRuntime=await resolveBundledOmpRuntime({appRoot:APP_ROOT}); }
  catch { ompRuntimeError=new HostError('OMP_RUNTIME_UNAVAILABLE','Nozeli 私有 OMP 缺失、不兼容或校验失败；请修复安装。本地阅读与历史仍可用，不会改用系统 OMP。'); }
  const ompSystemSource=createNozeliOmpSource(nozeliPaths);
  let ompAuthBrokerHost=null;
  const ompAuthBroker={acquire:async()=>{
    if(ompRuntimeError)throw ompRuntimeError;
    const setup=await readNozeliConfiguration(nozeliPaths);
    if(setup.choiceRequired)throw Object.assign(Error('请先完成Nozeli独立配置初始化。'),{code:'CONFIG_SETUP_REQUIRED'});
    ompAuthBrokerHost??=new OmpAuthBrokerHost({command:ompRuntime.command,source:ompSystemSource,sourceEnv:process.env});
    return ompAuthBrokerHost.acquire();
  }};
  const {ProviderSettings,hasProviderReferences}=await import('../agents/managed/provider-settings.mjs');
  const providerSettings=new ProviderSettings({source:ompSystemSource,broker:ompAuthBroker,command:ompRuntime?.command,onDefaultsSaved:next=>managedAgents.applyModelDefaults(next),getModelSync:()=>managedAgents.modelSync(),isReferenced:async provider=>{
    for(const controller of managedAgents?.controllers?.values()??[]){
      if(controller.starting?.size)return true;
      for(const session of controller.sessions.values())if(!session.model||session.model.startsWith(provider+'/'))return true;
    }
    return hasProviderReferences({storage:host.storage},provider);
  }});
  ompSystemSource.modelFor=role=>providerSettings.modelFor(role);
  managedAgents=new ManagedProjects({userDataDir:app.getPath('userData'),host,legacy:agents,beforeDocumentOperation:syncDocument,ompSystemSource,ompAuthBroker,ompCommand:ompRuntime?.command});
  managedAgents.onEvent(event=>{workspaceNative?.broadcast('nozeli:agent',event,event.projectId);if(event.kind==='managed-state'&&workspaceNative?.shell&&!workspaceNative.shell.dead&&workspaceNative.shell.projectId!==event.projectId)workspaceNative.shell.wc.send('nozeli:agent',event);if(event.kind==='managed-state'&&(managedAgents.activeProjectId===null||managedAgents.activeProjectId===event.projectId))void workspaceNative?.conversationState(event.projectId,event.state).catch(error=>console.error('conversation connection state',error));});
  const server = await startStatic();
  const {WorkspaceNative}=await import('./workspace-native.mjs');
  const {ProjectWatcher}=await import('./project-watcher.mjs');
  projectWatcher=new ProjectWatcher({onChange:event=>workspaceNative?.broadcast('nozeli:workspace-control',{type:'file-tree-changed',...event},event.projectId),onError:error=>workspaceNative?.broadcast('nozeli:workspace-control',{type:'file-tree-watch-error',...error},error.projectId)});
  const address=server.address();origin=`http://127.0.0.1:${address.port}/`;
  workspaceNative=new WorkspaceNative({BrowserWindow:WorkspaceWindow,WebContentsView,screen,origin,preload:path.join(APP_ROOT,'src/preload/preload.cjs'),icon:path.join(APP_ROOT,'assets/nozeli.png'),userDataDir:app.getPath('userData'),host,hidden:HIDDEN,onClose:async r=>{const recovery=windowRecovery(r.win);if(recovery){recovery.requestClose();return;}await workspaceNative.flush([...workspaceNative.senders.values()]);if(agents?.busy()||managedAgents?.busy()){r.wc.send('nozeli:quit-confirm');return;}await managedAgents?.stop();await agents?.stopIdle?.();r.closing=true;for(const s of workspaceNative.projectRecords(r.projectId,r.windowId))workspaceNative.destroySurface(s);r.win.close();}});
  const {IsolatedPreviewManager}=await import('./isolated-preview.mjs');
  isolatedPreview=new IsolatedPreviewManager({WebContentsView,session,workspace:workspaceNative,host,managedAgents});
  try{const saved=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'appearance.json'),'utf8'));if(['light','dark'].includes(saved.theme))nativeTheme.themeSource=saved.theme;isolatedPreview.setAppearance({palette:saved.palette,mode:nativeTheme.shouldUseDarkColors?'dark':'light'});}catch{}
  nativeTheme.on('updated',()=>{isolatedPreview.setAppearance({palette:isolatedPreview.appearance?.palette??'sage',mode:nativeTheme.shouldUseDarkColors?'dark':'light'});});
  workspaceNative.isolatedPreview=isolatedPreview;
  const {WorkspaceCapture}=await import('./workspace-capture.mjs');
  workspaceCapture=new WorkspaceCapture({workspace:workspaceNative,host,deliver:async(session,event)=>{await workspaceNative.deliverDrawing(session,event);}});
  const {ProjectLifecycle}=await import('./project-lifecycle.mjs');
  const {reconcileManagedPending}=await import('../agents/managed/managed-storage.mjs');
  projectLifecycle=new ProjectLifecycle({host,workspace:workspaceNative,managed:managedAgents,reconcileManaged:(id,options)=>reconcileManagedPending(host.storage,id,options),trashItem:target=>shell.trashItem(target),beforeStop:async id=>{projectWatcher?.unwatchProject(id);await texManager?.stopProject(id);await texLanguage?.stopProject(id);await lspManager?.stopProject(id);},protectedRoots:[APP_ROOT,path.dirname(APP_ROOT),nozeliPaths.root]});
  const {createGuidedDemo}=await import('./guided-demo.mjs');
  guidedDemo=await createGuidedDemo({host,workspace:workspaceNative,userDataDir:app.getPath('userData'),appRoot:APP_ROOT,examplesRoot:process.env.NOZELI_GUIDED_DEMO_ROOT||path.join(app.getPath('documents'),'Nozeli Examples')});
  guidedDemo.lifecycle=projectLifecycle;workspaceNative.guidedDemo=guidedDemo;host.guidedDemo=guidedDemo;managedAgents.guidedDemo=guidedDemo;
  const stopManagedUnavailable=host.storage.onUnavailable;
  host.storage.onUnavailable=(id,error)=>{workspaceNative.unavailableProjects??=new Set();if(workspaceNative.unavailableProjects.has(id))return;workspaceNative.unavailableProjects.add(id);const stopped=stopManagedUnavailable(id,error);void Promise.allSettled([stopped,projectLifecycle.beforeStop(id)]).then(results=>{if(results.some(result=>result.status==='rejected'))workspaceNative.broadcast('nozeli:workspace-control',{type:'project-stop-pending',projectId:id,error:{code:'OMP_EXIT_UNCONFIRMED',message:'原生停稳尚未确认，未允许继续执行或清理。'}},id);});workspaceNative.broadcast('nozeli:workspace-control',{type:'project-unavailable',projectId:id,error:{code:error.code,message:error.message}},id);};
  workspaceNative.restoreShell=()=>createWindow(server);
  workspaceNative.ensureConversation=async(projectId,target)=>{
    if(guidedDemo.isDemo(projectId)){await guidedDemo.verify(projectId);return;}
    try{
    const configuration=await readNozeliConfiguration(nozeliPaths);if(configuration.choiceRequired)throw Object.assign(Error('请先完成 Agent 配置，再打开对话。'),{code:'CONFIG_SETUP_REQUIRED'});
    let status=await managedAgents.connect(projectId,{enable:true});
    if(status.handoff)throw Object.assign(Error('原会话需要确认接手，请在连接与历史中处理。'),{code:'AGENT_HANDOFF_REQUIRED'});
    if(!['frontdesk','orchestrator'].includes(target)){const controller=managedAgents.controllers.get(projectId);await controller.session(target);status=await managedAgents.status(projectId);}
    const starting=managedAgents.controllers.get(projectId)?.starting?.get(target);if(starting){await starting;status=await managedAgents.status(projectId);}
    const agent=status.state?.agents?.find(a=>a.target===target);
    if(!status.ready||!agent||agent.closed||agent.restarting||!['ready','idle','prompt-inflight'].includes(agent.phase))throw Object.assign(Error(status.connectionError?.message||'当前 Agent 会话尚未就绪，请重试连接。'),{code:'AGENT_NOT_READY'});
    }catch(error){await managedAgents.reportConnectionError(projectId,error);throw error;}
  };
  workspaceNative.setupWindow=r=>{
    const recovery=new WindowRecovery(r.win,{dialog,settle:async()=>{await workspaceNative.flush([...workspaceNative.surfaces.values()]);await host.settled();},busy:()=>agents?.busy()||managedAgents?.busy(),stop:async()=>{await managedAgents?.stop();await agents?.stopIdle?.();},reveal:()=>revealWindow(r.win),onClose:()=>{allowClose=true;quitting=true;for(const s of [...workspaceNative.surfaces.values()])workspaceNative.destroySurface(s);for(const w of workspaceNative.windows.values()){w.closing=true;w.win.close();}}});
    r.wc.on('did-start-navigation',(_e,_url,_inPlace,isMain)=>{if(isMain)recovery.navigation();});
    r.wc.on('did-finish-load',()=>recovery.loaded());r.wc.on('render-process-gone',(_e,details)=>recovery.rendererGone(details));r.win.on('closed',()=>recovery.destroyed());
  };
  workspaceNative.recover=async(r,details)=>{
    if(r.role!=='surface'||r.recovering)return;r.recovering=true;
    try{const choice=await dialog.showMessageBox(r.win,{type:'warning',title:'内容页面恢复',message:'内容页面已退出，已持久化的文件和草稿保留。',detail:'原因：'+String(details.reason||'未知')+'。重新加载可能丢失尚未收讫的输入，不会重放任务或发送消息。',buttons:['保留现场','重新加载…'],defaultId:0,cancelId:0});if(choice.response!==1||r.dead)return;const confirm=await dialog.showMessageBox(r.win,{type:'warning',message:'确认重新加载内容？未保存的输入可能丢失。',buttons:['取消','重新加载'],defaultId:0,cancelId:0});if(confirm.response===1&&!r.dead){await host.settled();r.wc.reload();}}
    finally{r.recovering=false;}
  };
  app.on('before-quit',event=>{
    if(quitting)return;event.preventDefault();if(quitPending)return;quitPending=true;
    const r=workspaceNative.windows.get('main')||workspaceNative.windows.values().next().value;
    if(!r){quitPending=false;return;}
    void workspaceNative.flush([...workspaceNative.senders.values()]).then(()=>finishDrawing()).then(()=>{const recovery=windowRecovery(r.win);if(recovery)recovery.requestClose();else return workspaceNative.onClose(r);}).catch(error=>console.error('quit flush failed',error)).finally(()=>{quitPending=false;});
  });
  ipcMain.handle('nozeli:invoke', async (event, op, payload) => {
    try {
      const scope=trusted(event,'workspace.bootstrap',{});
      if (payload != null && (typeof payload !== 'object' || Array.isArray(payload))) {
        throw new HostError('INVALID_PAYLOAD', 'Payload must be an object.');
      }
      if(typeof op!=='string')throw new HostError('UNKNOWN_OP','Unknown host operation.');
      payload=await workspaceNative.resolvePayload(scope,op,payload??{});
      if(['material.attach','material.attachPath'].includes(op))payload={...payload,projectId:scope.projectId};
      if(op==='material.read'&&payload.projectId!==scope.projectId)throw new HostError('PROJECT_SCOPE_DENIED','附件不属于当前项目');
      const admissionProject=payload?.projectId??scope.projectId;
      const execute=async()=>{
      trusted(event,op,payload??{});
      if(op.startsWith('workspace.demoControls.'))return {ok:true,value:await workspaceNative.invoke(scope,op,payload??{})};
      // Admission is established before asynchronous business work begins.
      if(op.startsWith('demo.'))return {ok:true,value:await guidedDemo.invoke(scope,op,payload??{})};
      if(admissionProject&&guidedDemo.isDemo(admissionProject)){
        await guidedDemo.verify(admissionProject);
        if(op==='config.status')return {ok:true,value:{choiceRequired:false,source:'demo-fixture',demo:true}};
        if(op.startsWith('managed.'))return {ok:true,value:await guidedDemo.managed(op,{...payload,projectId:admissionProject})};
        if(op.startsWith('agents.')&&!['agents.messages','agents.reports'].includes(op))throw new HostError('DEMO_NATIVE_DISABLED','演示副本禁止原生 Agent、模型及终端启动。');
        if(['report.copySource','report.export'].includes(op))throw new HostError('DEMO_NATIVE_DISABLED','演示报告请从示例项目文件读取或另存。');
      }
      if(admissionProject&&!['workspace.recovery','workspace.recovery.list','workspace.recovery.object','session.flushed','workspace.bootstrap','project.lifecycle.reconcile'].includes(op))host.storage.assertActive(admissionProject);
      if(['project.lifecycle.preview','project.lifecycle.execute','project.lifecycle.reconcile'].includes(op)){if(scope.role!=='shell')throw new HostError('IPC_DENIED','只能在主窗口管理项目');await finishDrawing({projectId:payload.projectId});if(op.endsWith('preview'))return {ok:true,value:await projectLifecycle.preview(payload)};if(op.endsWith('reconcile'))return {ok:true,value:await projectLifecycle.reconcile(payload)};return {ok:true,value:await projectLifecycle.execute(payload)};}
      if(op==='project.retry'){if(scope.role!=='shell')throw new HostError('IPC_DENIED','仅主窗可重试项目');await managedAgents.stopProject(payload.projectId);const value=await host.storage.retry(payload.projectId);workspaceNative.unavailableProjects?.delete(payload.projectId);return {ok:true,value};}
      if(op==='workspace.recovery.settle'){if(scope.role!=='shell')throw new HostError('IPC_DENIED','仅主窗可明确结算保留成果');return {ok:true,value:await projectLifecycle.settleManaged(payload)};}
      if(op==='workspace.capture.begin')return {ok:true,value:await workspaceCapture.begin(scope,payload??{})};
      if(op.startsWith('workspace.capture.'))return {ok:true,value:await workspaceCapture.invoke(event,op.slice('workspace.capture.'.length),payload??{})};
      if(op==='settings.appearance.read'||op==='settings.appearance.save'){
        const file=path.join(app.getPath('userData'),'appearance.json');
        if(op==='settings.appearance.read'){
          try{return {ok:true,value:JSON.parse(await fs.readFile(file,'utf8'))};}catch(error){if(error.code==='ENOENT')return {ok:true,value:null};throw error;}
        }
        if(!payload||Object.keys(payload).some(k=>!['theme','palette','font','size'].includes(k))||!['system','light','dark'].includes(payload.theme)||(Object.hasOwn(payload,'palette')&&!['sage','slate'].includes(payload.palette))||!['system','sans','serif','mono'].includes(payload.font)||!Number.isInteger(payload.size)||payload.size<12||payload.size>20)throw new HostError('INVALID_PAYLOAD','外观配置无效。');
        if(!Object.hasOwn(payload,'palette')){
          let palette='sage';
          try{const previous=JSON.parse(await fs.readFile(file,'utf8'));if(['sage','slate'].includes(previous?.palette))palette=previous.palette;}catch(error){if(error.code!=='ENOENT')throw error;}
          payload={...payload,palette};
        }
        const temporary=file+'.'+randomUUID()+'.tmp';
        try{await fs.writeFile(temporary,JSON.stringify(payload),{flag:'wx',mode:0o600});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}
        workspaceNative.broadcast('nozeli:workspace-control',{type:'appearance',value:payload});
        // The explicit appearance choice is also Chromium's preferred scheme:
        // every renderer (including isolated report views) then resolves
        // prefers-color-scheme and light-dark() consistently with the app
        // theme, and live setting changes propagate without per-page work.
        if(nativeTheme.themeSource!==payload.theme)nativeTheme.themeSource=payload.theme;
        isolatedPreview?.setAppearance({palette:payload.palette,mode:nativeTheme.shouldUseDarkColors?'dark':'light'});
        return {ok:true,value:payload};
      }
      if(op.startsWith('workspace.')){
        const priorProject=scope.projectId;
        const value=await workspaceNative.invoke(scope,op,payload??{});
        if(op==='workspace.project'){
          if(priorProject&&priorProject!==scope.projectId)projectWatcher?.unwatchProject(priorProject);
          const activatedProjectId=scope.projectId;
          if(!guidedDemo.isDemo(activatedProjectId))void managedAgents.setActiveProject(activatedProjectId).catch(error=>workspaceNative.broadcast('nozeli:agent',{projectId:activatedProjectId,kind:'managed-error',text:'Agent 资源状态未能更新，文件仍可打开：'+error.message},activatedProjectId));
        }
        return {ok:true,value};
      }
      if(op.startsWith('isolated-preview.'))return {ok:true,value:await isolatedPreview.invoke(scope,op,payload??{})};
      if(op==='project.watch'){if(scope.role==='surface')throw new HostError('IPC_DENIED','Only project navigation can watch directories.');const project=await host.requireProject(scope.projectId);return {ok:true,value:await projectWatcher.watch(scope.projectId,project.root,payload.parentRelPath??'')};}
      if(op==='project.unwatch'){if(scope.role==='surface')throw new HostError('IPC_DENIED','Only project navigation can unwatch directories.');projectWatcher.unwatchProject(scope.projectId);return {ok:true,value:{unwatched:true}};}
      if(op==='project.open'&&scope.role!=='shell')return {ok:true,value:{project:host.publicProject(await host.requireProject(scope.projectId))}};
      if(op==='state.write'&&scope.role!=='shell')throw new HostError('IPC_DENIED','Surface state is owned by the workspace host.');
      if(op==='state.write'){
        const projectId=scope.projectId;
        return workspaceNative.serial('settings:'+projectId,async()=>{
          const previous=(await host.readState(projectId)).state??{},incoming=payload?.state??{};
          const workspace={...(previous.workspace??{}),...(incoming.workspace??{})};
          for(const key of ['draft','noteDrafts','noteOffsets','retainedNoteDrafts','composerMaterials','confirmationSkips'])if(Object.hasOwn(previous.workspace??{},key))workspace[key]=previous.workspace[key];else delete workspace[key];
          const value=await host.writeState(projectId,{...previous,...incoming,workspace});
          workspaceNative.broadcast('nozeli:workspace-control',{type:'settings',projectId,projectSettings:value.state.projectSettings,workspace:value.state.workspace},projectId);
          return {ok:true,value};
        });
      }
      if(op==='config.status')return {ok:true,value:await readNozeliConfiguration(nozeliPaths)};
      if(op==='config.initialize'){
        if(!payload||Object.keys(payload).some(key=>!['mode','includeApiKeys'].includes(key))||!['independent','import'].includes(payload.mode)||payload.includeApiKeys!==undefined&&typeof payload.includeApiKeys!=='boolean')throw new HostError('INVALID_PAYLOAD','请选择独立设置或一次性导入。');
        const value=await completeNozeliConfiguration(nozeliPaths,{choice:payload.mode,includeApiKeys:payload.includeApiKeys===true});
        await managedAgents.configurationReady();
        return {ok:true,value};
      }
      if(op==='settings.agents.status'){
        if(payload&&Object.keys(payload).some(key=>key!=='projectId'))throw new HostError('INVALID_PAYLOAD','Agent额度查询无效。');
        return {ok:true,value:await managedAgents.resourceStatus(payload?.projectId)};
      }
      if(op==='settings.agents.save')return {ok:true,value:await managedAgents.saveResourceLimits(payload)};
      if(op==='managed.project.active'){
        if(!payload||Object.keys(payload).some(key=>key!=='projectId')||(payload.projectId!==null&&typeof payload.projectId!=='string'))throw new HostError('INVALID_PAYLOAD','当前项目无效。');
        return {ok:true,value:await managedAgents.setActiveProject(payload.projectId)};
      }
      if(typeof op==='string'&&op.startsWith('settings.')){
        if(ompRuntimeError)throw ompRuntimeError;
        try {
          let value;
          if(op==='settings.providers.status')value=await providerSettings.status();
          else if(op==='settings.providers.save')value=await providerSettings.saveApi(payload);
          else if(op==='settings.providers.remove')value=await providerSettings.remove(payload);
          else if(op==='settings.models.save')value=await providerSettings.saveDefaults(payload);
          else if(op==='settings.login.providers')value=await providerSettings.loginProviders();
          else if(op==='settings.login.start')value=await providerSettings.startLogin(payload);
          else if(op==='settings.login.status')value=providerSettings.loginStatus();
          else if(op==='settings.login.input')value=providerSettings.inputLogin(payload);
          else if(op==='settings.login.cancel')value=await providerSettings.cancelLogin(payload);
          else throw new HostError('UNKNOWN_OPERATION','未知设置操作。');
          return {ok:true,value};
        } catch(error){
          if(error.code==='SETTINGS_INVALID')throw error;
          throw new HostError('SETTINGS_FAILED','OMP设置操作未完成；原有会话保持不变。请检查私有运行环境或源配置。');
        }
      }
      if (op==='document.synced') return {ok:true,value:workspaceNative.acknowledge(scope,payload,{...payload?.result,requestId:payload?.requestId})};
      if(op==='view.authorship'){const value=await host.viewAuthorship(payload?.visible);const item=Menu.getApplicationMenu()?.getMenuItemById('view.authorship');if(item)item.checked=value.visible;if(payload?.visible!==undefined)workspaceNative.broadcast('nozeli:workspace-control',{type:'authorship-visibility',visible:value.visible});return {ok:true,value};}
      if(op==='annotation.capture'){
        const r=payload.rect;if(!r||!['left','top','right','bottom'].every(k=>Number.isFinite(r[k]))||r.right<=r.left||r.bottom<=r.top)throw Error('区域截图坐标无效');
        const {width:w,height:h}=scope.role==='surface'?scope.view.getBounds():{width:scope.win.getContentSize()[0],height:scope.win.getContentSize()[1]};
        const x=Math.max(0,Math.floor(r.left)),y=Math.max(0,Math.floor(r.top)),right=Math.min(w,Math.ceil(r.right)),bottom=Math.min(h,Math.ceil(r.bottom));
        if(right<=x||bottom<=y)throw Error('选区不在可见窗口，请重新框选');
        const image=await event.sender.capturePage({x,y,width:right-x,height:bottom-y});
        return {ok:true,value:{dataUrl:image.toDataURL(),captureMode:'visible-window-region',clipped:r.left<0||r.top<0||r.right>w||r.bottom>h}};
      }
      if (op === 'links.openExternal') {
        const url = new URL(payload?.url);
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new HostError('INVALID_LINK', '此链接类型不支持外部打开。');
        await shell.openExternal(url.href);
        return {ok:true,value:{opened:true}};
      }
      if (op === 'session.takeOpen') { const file=externalFiles.shift();return {ok:true,value:file?await externalTarget(host,file):null}; }
      if (op === 'session.requestClose') {
        await finishDrawing({windowId:scope.windowId});
        scope.win.close();
        return { ok: true, value: { closing: true } };
      }
      if (op === 'material.pickDirectory') {
        const owner = scope.win;
        if (!owner) throw new Error('当前窗口不可用，无法选择目录。');
        const picks = testPickPaths();
        if (picks.length) return { ok: true, value: { path: picks[0] } };
        const result = await showDirectoryDialog(owner, { title: '选择引用文件所在目录', properties: ['openDirectory'], ...(typeof payload?.path === 'string' && path.isAbsolute(payload.path) ? { defaultPath: payload.path } : {}) });
        return { ok: true, value: result.canceled || !result.filePaths?.[0] ? { canceled: true } : { path: result.filePaths[0] } };
      }
      if (op === 'session.capture' && process.env.NOZELI_SHOT_DIR) {
        const name = typeof payload?.name === 'string' && /^[a-z0-9-]+$/.test(payload.name) ? payload.name : 'shot';
        const image = await event.sender.capturePage();
        await fs.mkdir(process.env.NOZELI_SHOT_DIR, { recursive: true });
        await fs.writeFile(path.join(process.env.NOZELI_SHOT_DIR, `${name}.png`), image.toPNG());
        return { ok: true, value: { name } };
      }
      if (op === 'session.resize' && process.env.NOZELI_SHOT_DIR) {
        const width = Number(payload?.width);
        const height = Number(payload?.height);
        if (width >= 320 && width <= 1920 && height >= 480 && height <= 1400) {
          scope.win.setContentSize(width, height);
        }
        return { ok: true, value: { width, height } };
      }
      if (op === 'session.flushed') {
        if(workspaceNative.receipts.has(payload?.requestId))return {ok:true,value:workspaceNative.acknowledge(scope,payload)};
        const recovery=windowRecovery(scope.win);
        return {ok:true,value:recovery?await recovery.acknowledge(event.sender,payload):{accepted:false}};
      }
      if (op === 'project.pick') {
        const selected = await pickDirectory(scope.win, payload?.directory);
        const value = await host.pick(selected,{confirmRecovery:async()=>{
          const answer=await dialog.showMessageBox(scope.win,{type:'warning',title:'重新登记已移除的项目',message:'此目录的 Nozeli 身份已被另一实例替换。是否在当前位置建立新的项目身份？',detail:'旧本机实例、草稿与恢复记录及当前项目元数据副本会保留，不合并旧待处理工作。请先正常退出使用此目录的其他 Nozeli 实例。本机核验仅限同用户 Linux 实例，不能排除其他用户或不合作进程；取消不会改动项目。',buttons:['取消','建立新身份并打开'],defaultId:0,cancelId:0,noLink:true});
          return answer.response===1;
        }});
        return { ok: true, value };
      }
      if (op === 'session.quitChoice') {
        if (payload?.choice === 'stay') {
          allowClose = false;
          return { ok: true, value: { stayed: true } };
        }
        if (payload?.choice === 'cancel') {
          try {
            await workspaceNative.flush([...workspaceNative.senders.values()]);
            await managedAgents?.stop();
            await agents.cancelAllAndStop();
            allowClose = true;
            quitting = true;
            for(const s of [...workspaceNative.surfaces.values()])workspaceNative.destroySurface(s);
            for(const r of workspaceNative.windows.values()){r.closing=true;r.win.close();}
            return { ok: true, value: { closing: true } };
          } catch (error) {
            allowClose = false;
            return respond(error);
          }
        }
        throw new HostError('INVALID_PAYLOAD', 'Quit choice must be stay or cancel.');
      }
      if (op === 'tree.labels') return { ok:true, value:await fileTreeOps.labels(payload ?? {}) };
      if (op === 'tree.label') return { ok:true, value:await fileTreeOps.setLabel(payload ?? {}) };
      if (op === 'tree.view') return { ok:true, value:await fileTreeOps.view(payload ?? {}) };
      if (op === 'tree.mutate') return { ok:true, value:await workspaceNative.mutateTree(payload??{},()=>fileTreeOps.run(payload??{})) };
      if(op==='ppt.draft'||op==='ppt.export'){
        const project=await host.requireProject(payload?.projectId);
        const abs=await fileTreeOps.locate(project,payload?.relPath,false);
        if(path.extname(abs).toLowerCase()!=='.pptx'||!/^[a-f0-9]{64}$/.test(payload?.digest||''))throw Error('PPTX 参数无效');
        const key='ppt:'+require('node:crypto').createHash('sha256').update(payload.relPath+'\0'+payload.digest).digest('hex');
        if(op==='ppt.draft'){
          if(payload.model!==undefined){
            const text=JSON.stringify({schema:'nozeli-pptist-draft-v1',engine:'82ecf10040ca8da67832f173b58d3baf5da59887',sourceDigest:payload.digest,model:payload.model});if(!Array.isArray(payload.model?.slides)||!payload.model.slides.length||Buffer.byteLength(text)>256*1024*1024)throw Error('PPTX 草稿无效或超过 256 MB');
            await host.storage.putRecovery(project.id,key,JSON.parse(text));return {ok:true,value:{saved:true}};
          }
          const record=await host.storage.getRecovery(project.id,key);if(record&&(record.schema!=='nozeli-pptist-draft-v1'||record.engine!=='82ecf10040ca8da67832f173b58d3baf5da59887'))throw Error('PPTX 草稿版本不兼容，原草稿已保留');return {ok:true,value:record?.model??null};
        }
        const bytes=Buffer.from(payload.bytes||[]);if(bytes.length<4||bytes.length>128*1024*1024||bytes.readUInt32LE(0)!==0x04034b50)throw Error('PPTX 导出数据无效');
        const choice=await dialog.showSaveDialog(scope.win,{title:'导出 PPTX 副本（格式可能变化）',defaultPath:abs.replace(/\.pptx$/i,'-Nozeli.pptx'),filters:[{name:'PowerPoint',extensions:['pptx']}]});
        if(choice.canceled||!choice.filePath)return {ok:true,value:{cancelled:true}};
        // Also reject symlink/hardlink aliases of the source.
        const sourceStat=await fs.stat(abs);let destStat;try{destStat=await fs.stat(choice.filePath);}catch(e){if(e.code!=='ENOENT')throw e;}
        if(path.resolve(choice.filePath)===path.resolve(abs)||(destStat&&destStat.dev===sourceStat.dev&&destStat.ino===sourceStat.ino))throw Error('请另存副本，不能覆盖 PPTX 原件');
        // Exclusive creation avoids overwriting another document or a raced symlink.
        await fs.writeFile(choice.filePath,bytes,{flag:'wx'});return {ok:true,value:{path:choice.filePath}};
      }
      if (op === 'tree.menu' || op === 'tree.path') {
        const project = await host.requireProject(payload?.projectId);
        const rel = payload?.relPath ?? '';
        const abs = await fileTreeOps.locate(project, rel, true);
        if (op === 'tree.path') {
          if (payload.action === 'openExternal') {
            if(!(await fs.lstat(abs)).isFile())throw new Error('请选择一个现有文件。');
            const error=await shell.openPath(abs);if(error)throw new Error('系统默认应用未能打开文件：'+error);
          }
          else if (payload.action === 'reveal') shell.showItemInFolder(abs);
          else if (payload.action === 'relativePath') await clipboard.writeText(rel || '.');
          else if (payload.action === 'absolutePath') await clipboard.writeText(abs);
          else throw new Error('不支持的路径操作。');
          return {ok:true,value:{}};
        }
        const stat = await fs.lstat(abs);
        const value = await new Promise(resolve => {
          let selected = null;
          const template = treeMenuItems({directory:stat.isDirectory(), root:rel === '', canPaste:payload.canPaste === true});
          const menu = Menu.buildFromTemplate(template.map(item => item.id ? {...item, click:()=>{selected=item.id;}} : item));
          menu.popup({window:scope.win, callback:()=>resolve(selected)});
        });
        return {ok:true,value};
      }
      if (op === 'lsp.sync') return { ok: true, value: await (/\.(tex|bib|sty|cls)$/i.test(payload?.relPath) ? texLanguage : lspManager).sync(payload ?? {}) };
      if (op === 'lsp.request') return { ok: true, value: await (/\.(tex|bib|sty|cls)$/i.test(payload?.relPath) ? texLanguage : lspManager).request(payload ?? {}) };
      if (op === 'lsp.status') return { ok: true, value: lspManager.status() };
      if (op === 'lsp.stop') { await texLanguage.stopAll(); await lspManager.stopAll(); return { ok: true, value: { stopped: true } }; }
      if (op.startsWith('tex.')) {
        const method = { 'tex.inspect':'inspect', 'tex.view':'view', 'tex.configure':'configure', 'tex.build':'request', 'tex.status':'status', 'tex.cancel':'cancel', 'tex.artifact':'artifact', 'tex.sync':'sync' }[op];
        if (!method) throw new HostError('UNKNOWN_OP', 'Unknown TeX operation.');
        const value=await texManager[method](payload??{});if(op==='tex.configure')workspaceNative.broadcast('nozeli:workspace-control',{type:'tex-configuration',projectId:payload.projectId,config:value},payload.projectId);return {ok:true,value};
      }
      if (op === 'formatter.format') return { ok: true, value: await formatterService.format(payload ?? {}) };
      if (op === 'document.clipboard') {
        if(payload?.action==='readRich'){
          const items=await clipboard.read();let text='',html='';
          for(const item of items){
            for(const type of ['text/plain','text/html'])if(item.types.includes(type)){
              const blob=await item.getType(type);if(blob.size>8*1024*1024)throw new HostError('INVALID_PAYLOAD','剪贴板内容过大。');
              const content=await blob.text();if(type==='text/plain'&&!text)text=content;if(type==='text/html'&&!html)html=content;
            }
          }
          if(Buffer.byteLength(text)+Buffer.byteLength(html)>8*1024*1024)throw new HostError('INVALID_PAYLOAD','Clipboard content exceeds 8 MB.');
          return {ok:true,value:{text,html}};
        }
        if (payload?.action === 'read') { const text=String((await clipboard.readText())||'');if(Buffer.byteLength(text)>8*1024*1024)throw new HostError('INVALID_PAYLOAD','剪贴板内容过大。');return {ok:true,value:text}; }
        if (payload?.action !== 'write' || typeof payload.text !== 'string' || payload.text.length > 8 * 1024 * 1024) throw new HostError('INVALID_PAYLOAD', 'Invalid clipboard text.');
        await clipboard.writeText(payload.text); return { ok: true, value: null };
      }
      if(op==='report.copySource'){
        if(Object.keys(payload).some(key=>!['projectId','objectId'].includes(key))||typeof payload.projectId!=='string'||typeof payload.objectId!=='string')throw new HostError('INVALID_PAYLOAD','报告身份无效。');
        const source=await managedAgents.reportSource(payload.projectId,payload.objectId);
        const bytes=await source.read();
        let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new HostError('REPORT_INVALID','报告不是有效的UTF-8源文件。');}
        await clipboard.writeText(text);
        return {ok:true,value:{copied:true,byteLength:bytes.length,format:source.report.format}};
      }
      if(op==='report.export'){
        const {ManagedReportExporter}=await import('./managed-report-export.mjs');
        return {ok:true,value:await new ManagedReportExporter({host,managedAgents,beforeOperation:syncDocument}).export(payload??{})};
      }
      if(typeof op==='string'&&op.startsWith('managed.')){
        const historyOnly=['managed.status','managed.history.list','managed.history.read','managed.artifact.read','managed.artifact.list','managed.timeline.page','managed.timeline.read','managed.timeline.request','managed.changes.list','managed.changes.read','managed.worker.history','managed.resident.history','managed.draft','managed.disposition','managed.terminal.screen'].includes(op);
        // Local disposition still passes sender/project/mutation authorization above.
        const localDisposition=['managed.end','managed.retry','managed.todo.manage','managed.attention.ack','managed.attention.respond','managed.attention.draft.read','managed.attention.draft.write'].includes(op);
        let blocked=ompRuntimeError&&!historyOnly&&!localDisposition?ompRuntimeError:null;
        if(!blocked&&!historyOnly&&!localDisposition&&(await readNozeliConfiguration(nozeliPaths)).choiceRequired)blocked=new HostError('CONFIG_SETUP_REQUIRED','请先完成Nozeli独立配置初始化；本地阅读不受影响。');
        if(blocked){if(payload.projectId){await host.requireRegisteredProject(payload.projectId);await managedAgents.reportConnectionError(payload.projectId,blocked);}throw blocked;}
        return {ok:true,value:await managedAgents.invoke(op,payload??{})};
      }
      if (Object.hasOwn(agentHandlers, op)) return { ok: true, value: await agentHandlers[op](payload ?? {}) };
      const handler = Object.hasOwn(ops, op) ? ops[op] : null;
      if (!handler || op === 'project.pick') throw new HostError('UNKNOWN_OP', 'Unknown host operation.');
      if(op==='project.remove'){await finishDrawing({projectId:payload.projectId});return {ok:true,value:await projectLifecycle.removeProject(payload.projectId,{operationId:payload.operationId})};}
      const value = await handler(host, payload ?? {});
      if(['file.save','word.save','sheet.save'].includes(op)&&guidedDemo.isDemo(payload.projectId))await guidedDemo.recordTutorialSave(scope,op,payload,value);
      return { ok: true, value };
      };
      workspaceNative.assertRecoveryAdmission(scope,op,payload);
      const flushOwner=workspaceNative.lifecycleFlushOwner(scope,payload?.flushRequestId,op);
      if(flushOwner)return await host.storage.withLifecycleOwner(scope.projectId,flushOwner,execute);
      const control=op.startsWith('session.')||op.startsWith('project.lifecycle.')||['project.pick','project.remove','project.retry','project.recent','workspace.closeProject','workspace.recovery.settle','workspace.bootstrap','workspace.recovery','workspace.recovery.list','workspace.recovery.object'].includes(op);
      return admissionProject&&!control ? await host.storage.withProjectOperation(admissionProject,execute) : await execute();
    } catch (error) {
      if(['PROJECT_ROOT_MISSING','PROJECT_METADATA_MISSING','PROJECT_METADATA_CONFLICT','PROJECT_IDENTITY_CONFLICT'].includes(error.code)&&payload?.projectId)host.storage.onUnavailable(payload.projectId,error);
      return respond(error);
    }
  });
  await createWindow(server);
  app.on('activate', async () => {
    if (quitting || BaseWindow.getAllWindows().length > 0) return;
    allowClose = false;
    await createWindow(server);
  });
  app.on('window-all-closed', async () => {
    await texManager?.stopAll();
    await texLanguage?.stopAll();
    await lspManager?.stopAll();
    quitting = true;
    await host.settled();
    await managedAgents?.stop().catch(error=>console.error('managed cleanup failed',error.message));
    projectWatcher?.close();
    await providerSettings.stop();
    await ompAuthBrokerHost?.stop().catch(error=>console.error('omp auth broker stop failed',error.message));   // 认证继承收尾：自有 serve 子进程正常退出
    server.close();
    app.quit();
  });
}

main().catch((error) => {
  const code=error?.code||'STARTUP_FAILED';
  console.error('desktop host failed:',code,error?.message);
  if(!ISOLATED_TEST_INSTANCE){
    const message=String(code).startsWith('MIGRATION_')
      ? 'Nozeli 数据迁移尚未完成。请先正常退出旧版 Nozeli，再重新打开；原项目与草稿没有被丢弃。若仍失败，请保留迁移记录并报告错误代码。'
      : 'Nozeli 初始化失败，原配置和项目已保留。请报告错误代码，不要删除用户数据。';
    require('electron').dialog.showErrorBox('Nozeli 未能启动',message+'\n错误代码：'+code);
  }
  app.exit(1);
});
