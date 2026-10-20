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
const { app, BrowserWindow, ipcMain, Menu, shell, clipboard } = require('electron');
let dialog, session;
let DesktopHost, HostError, ops, agents, managedAgents, agentHandlers, lspManager, formatterService, texManager, texLanguage;
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
app.on('open-file',(event,file)=>{event.preventDefault();externalFiles.push(file);const win=BrowserWindow.getAllWindows()[0];if(win){revealWindow(win);win.webContents.send('nozeli:open-request');}});
const ISOLATED_TEST_INSTANCE = process.env.NOZELI_TEST_INSTANCE === '1';
if (HIDDEN) {
  app.commandLine.appendSwitch('ozone-platform', process.env.NOZELI_OZONE || 'headless');
  app.disableHardwareAcceleration();
}
if (DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', DEBUG_PORT);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
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
let allowClose = false;
let quitting = false;
let trustedId = null;
let origin = '';
const documentSyncs = new Map();
async function syncDocument({projectId,relPath,hold}) {
  const win=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());
  if (!win) throw new HostError('NOT_READY','编辑界面尚未就绪。');
  const requestId=randomUUID();
  const release=()=>{if(!win.isDestroyed())win.webContents.send('nozeli:document-release',requestId);};
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{documentSyncs.delete(requestId);reject(new HostError('DOCUMENT_SYNC_TIMEOUT','编辑区同步超时，未应用Agent修改。'));},10000);
      documentSyncs.set(requestId,result=>{clearTimeout(timer);documentSyncs.delete(requestId);result?.ok?resolve():reject(new HostError(result?.error?.code||'UNSAVED',result?.error?.message||'用户输入尚未成功保存。'));});
      win.webContents.send('nozeli:document-sync',{requestId,projectId,relPath,hold});
    });
    return release;
  } catch (error) { release();throw error; }
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

function trusted(event) {
  const frame = event.senderFrame;
  if (!frame || frame.parent != null) throw new HostError('IPC_DENIED', 'Only the top-level page may call the host.');
  if (!origin || !frame.url.startsWith(origin)) throw new HostError('IPC_DENIED', 'Unexpected page origin.');
  if (!event.sender || event.sender.id !== trustedId) throw new HostError('IPC_DENIED', 'Unexpected sender.');
}

  function testPickPaths() {
    return (process.env.NOZELI_TEST_PICK || '').split('\n').filter(Boolean);
  }
  async function pickDirectory(win, requested) {
    const picks = testPickPaths();
    if (picks.length) return picks.includes(requested) ? requested : picks[0];
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择项目目录' });
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
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: !HIDDEN,
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
  if(process.platform !== 'darwin'){win.setAutoHideMenuBar(true);win.setMenuBarVisibility(false);}
  win.once('ready-to-show', () => revealWindow(win));
  trustedId = win.webContents.id;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const recovery=new WindowRecovery(win,{
    dialog,settle:()=>host.settled(),busy:()=>agents?.busy()||managedAgents?.busy(),
    stop:async()=>{await managedAgents?.stop();await agents?.stopIdle?.();},
    reveal:()=>revealWindow(win),onClose:()=>{allowClose=true;quitting=true;win.close();},
  });
  win.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)recovery.navigation();});
  win.webContents.on('render-process-gone',(_event,details)=>{console.error('renderer gone',details);recovery.rendererGone(details);});
  win.on('closed',()=>recovery.destroyed());
  win.on('close',event=>{
    if(allowClose||quitting)return;
    event.preventDefault();recovery.requestClose();
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
  const {resolveNozeliPaths,initializeNozeliConfiguration,readNozeliConfiguration,completeNozeliConfiguration}=await import('../agents/managed/nozeli-config.mjs');
  const nozeliPaths=resolveNozeliPaths();
  await initializeNozeliConfiguration(nozeliPaths,{legacyDesktop:ISOLATED_TEST_INSTANCE?null:path.join(app.getPath('appData'),'Nozeli')});
  app.setPath('userData',nozeliPaths.desktop);
  await app.whenReady();
  app.setName('Nozeli');
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  const {fileArguments, externalTarget}=await import('./external-open.mjs');
  externalFiles.push(...fileArguments(process.argv,{packaged:app.isPackaged}).filter(file=>file!==__filename&&file!==APP_ROOT));
  app.on('second-instance', (_event,argv,cwd) => {
    externalFiles.push(...fileArguments(argv,{packaged:app.isPackaged,cwd}).filter(file=>file!==__filename&&file!==APP_ROOT));
    const win = BrowserWindow.getAllWindows()[0];
    revealWindow(win);
    win?.webContents.send('nozeli:open-request');
  });
  ({ dialog, session } = require('electron'));
  ({ DesktopHost, HostError, ops } = await import('./host.mjs'));
  const { LanguageServiceManager } = await import('./language-service-manager.mjs');
  const { FormatterService } = await import('./formatter-service.mjs');
  const { AgentRuntime } = await import('../agents/runtime.mjs');
  const { agentOps } = await import('../agents/ipc.mjs');
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  host = new DesktopHost(app.getPath('userData'),{onDocumentChange:payload=>{for(const w of BrowserWindow.getAllWindows())if(!w.isDestroyed())w.webContents.send('nozeli:document',payload);}});
  const { FileTreeOps } = await import('./file-tree-ops.mjs');
  ({ treeMenuItems } = await import('./file-tree-menu.mjs'));
  fileTreeOps = new FileTreeOps(host, { trash: p => shell.trashItem(p) });
  formatterService = new FormatterService({ host });
  const { TexLanguageService } = await import('./tex-language-service.mjs');
  texLanguage = new TexLanguageService({host, onEvent: payload => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('nozeli:lsp', payload); }});
  const { TexBuildManager } = await import('./tex-build-manager.mjs');
  texManager = new TexBuildManager({ host, onEvent: payload => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('nozeli:tex', payload); } });
  lspManager = new LanguageServiceManager({ host, userDataDir: app.getPath('userData'), onEvent: payload => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('nozeli:lsp', payload); } });
  // Previous two-slot transcripts are read-only records, never another backend.
  agents = new AgentRuntime({userDataDir:app.getPath('userData')});
  agents.onEvent((event) => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('nozeli:agent', event); });
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
  managedAgents=new ManagedProjects({userDataDir:app.getPath('userData'),host,legacy:agents,beforeDocumentOperation:syncDocument,ompSystemSource,ompAuthBroker,ompCommand:ompRuntime?.command});
  managedAgents.onEvent(event=>{for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send('nozeli:agent',event);});
  const server = await startStatic();
  ipcMain.handle('nozeli:invoke', async (event, op, payload) => {
    try {
      trusted(event);
      if (payload != null && (typeof payload !== 'object' || Array.isArray(payload))) {
        throw new HostError('INVALID_PAYLOAD', 'Payload must be an object.');
      }
      if(op==='config.status')return {ok:true,value:await readNozeliConfiguration(nozeliPaths)};
      if(op==='config.initialize'){
        if(!payload||Object.keys(payload).some(key=>!['mode','includeApiKeys'].includes(key))||!['independent','import'].includes(payload.mode)||payload.includeApiKeys!==undefined&&typeof payload.includeApiKeys!=='boolean')throw new HostError('INVALID_PAYLOAD','请选择独立设置或一次性导入。');
        const value=await completeNozeliConfiguration(nozeliPaths,{choice:payload.mode,includeApiKeys:payload.includeApiKeys===true});
        return {ok:true,value};
      }
      if (op==='document.synced') { documentSyncs.get(payload?.requestId)?.(payload?.result);return {ok:true}; }
      if(op==='view.authorship'){const value=await host.viewAuthorship(payload?.visible);const item=Menu.getApplicationMenu()?.getMenuItemById('view.authorship');if(item)item.checked=value.visible;return {ok:true,value};}
      if(op==='annotation.capture'){
        const r=payload.rect;if(!r||!['left','top','right','bottom'].every(k=>Number.isFinite(r[k]))||r.right<=r.left||r.bottom<=r.top)throw Error('区域截图坐标无效');
        const window=BrowserWindow.fromWebContents(event.sender),[w,h]=window.getContentSize();
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
        BrowserWindow.fromWebContents(event.sender)?.close();
        return { ok: true, value: { closing: true } };
      }
      if (op === 'material.pickDirectory') {
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner) throw new Error('当前窗口不可用，无法选择目录。');
        const picks = testPickPaths();
        if (picks.length) return { ok: true, value: { path: picks[0] } };
        const result = await dialog.showOpenDialog(owner, { title: '选择引用文件所在目录', properties: ['openDirectory'], ...(typeof payload?.path === 'string' && path.isAbsolute(payload.path) ? { defaultPath: payload.path } : {}) });
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
          BrowserWindow.fromWebContents(event.sender)?.setContentSize(width, height);
        }
        return { ok: true, value: { width, height } };
      }
      if (op === 'session.flushed') {
        const recovery=windowRecovery(BrowserWindow.fromWebContents(event.sender));
        return {ok:true,value:recovery?await recovery.acknowledge(event.sender,payload):{accepted:false}};
      }
      if (op === 'project.pick') {
        const selected = await pickDirectory(BrowserWindow.fromWebContents(event.sender), payload?.directory);
        const value = await host.pick(selected);
        return { ok: true, value };
      }
      if (op === 'session.quitChoice') {
        if (payload?.choice === 'stay') {
          allowClose = false;
          return { ok: true, value: { stayed: true } };
        }
        if (payload?.choice === 'cancel') {
          try {
            await managedAgents?.stop();
            await agents.cancelAllAndStop();
            allowClose = true;
            quitting = true;
            BrowserWindow.fromWebContents(event.sender)?.close();
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
      if (op === 'tree.mutate') return { ok:true, value:await fileTreeOps.run(payload ?? {}) };
      if(op==='ppt.draft'||op==='ppt.export'){
        const project=await host.requireProject(payload?.projectId);
        const abs=await fileTreeOps.locate(project,payload?.relPath,false);
        if(path.extname(abs).toLowerCase()!=='.pptx'||!/^[a-f0-9]{64}$/.test(payload?.digest||''))throw Error('PPTX 参数无效');
        const key=require('node:crypto').createHash('sha256').update(project.id+'\0'+payload.relPath+'\0'+payload.digest).digest('hex');
        const folder=path.join(app.getPath('userData'),'ppt-drafts'),target=path.join(folder,key+'.json');
        if(op==='ppt.draft'){
          if(payload.model!==undefined){
            const text=JSON.stringify({schema:'nozeli-pptist-draft-v1',engine:'82ecf10040ca8da67832f173b58d3baf5da59887',sourceDigest:payload.digest,model:payload.model});if(!Array.isArray(payload.model?.slides)||!payload.model.slides.length||Buffer.byteLength(text)>256*1024*1024)throw Error('PPTX 草稿无效或超过 256 MB');
            await fs.mkdir(folder,{recursive:true});const temp=target+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,text);await fs.rename(temp,target);return {ok:true,value:{saved:true}};
          }
          let value=null;try{const record=JSON.parse(await fs.readFile(target,'utf8'));if(record.schema!=='nozeli-pptist-draft-v1'||record.engine!=='82ecf10040ca8da67832f173b58d3baf5da59887')throw Error('PPTX 草稿版本不兼容，原草稿已保留');value=record.model;}catch(e){if(e.code!=='ENOENT')throw e;}return {ok:true,value};
        }
        const bytes=Buffer.from(payload.bytes||[]);if(bytes.length<4||bytes.length>128*1024*1024||bytes.readUInt32LE(0)!==0x04034b50)throw Error('PPTX 导出数据无效');
        const choice=await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender),{title:'导出 PPTX 副本（格式可能变化）',defaultPath:abs.replace(/\.pptx$/i,'-Nozeli.pptx'),filters:[{name:'PowerPoint',extensions:['pptx']}]});
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
          menu.popup({window:BrowserWindow.fromWebContents(event.sender), callback:()=>resolve(selected)});
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
        return { ok: true, value: await texManager[method](payload ?? {}) };
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
      if(op==='report.export'){
        const {ManagedReportExporter}=await import('./managed-report-export.mjs');
        return {ok:true,value:await new ManagedReportExporter({host,managedAgents,beforeOperation:syncDocument}).export(payload??{})};
      }
      if(typeof op==='string'&&op.startsWith('managed.')){
        const historyOnly=['managed.status','managed.history.list','managed.history.read','managed.artifact.read','managed.artifact.list','managed.timeline.page','managed.timeline.read','managed.changes.list','managed.changes.read','managed.worker.history','managed.resident.history','managed.draft'].includes(op);
        if(ompRuntimeError&&!historyOnly)throw ompRuntimeError;
        if(!historyOnly&&(await readNozeliConfiguration(nozeliPaths)).choiceRequired)throw new HostError('CONFIG_SETUP_REQUIRED','请先完成Nozeli独立配置初始化；本地阅读不受影响。');
        return {ok:true,value:await managedAgents.invoke(op,payload??{})};
      }
      if (Object.hasOwn(agentHandlers, op)) return { ok: true, value: await agentHandlers[op](payload ?? {}) };
      const handler = Object.hasOwn(ops, op) ? ops[op] : null;
      if (!handler || op === 'project.pick') throw new HostError('UNKNOWN_OP', 'Unknown host operation.');
      const value = await handler(host, payload ?? {});
      return { ok: true, value };
    } catch (error) {
      return respond(error);
    }
  });
  await createWindow(server);
  app.on('activate', async () => {
    if (quitting || BrowserWindow.getAllWindows().length > 0) return;
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
