import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource } from 'vscode-jsonrpc/node';

const supported = /\.(tex|bib|sty|cls)$/i;
const error = (message, code = 'TEXLAB_UNAVAILABLE') => Object.assign(new Error(message), { code });
const settings = { texlab: { build: { onSave: false, forwardSearchAfter: false }, chktex: { onOpenAndSave: false, onEdit: false }, diagnosticsDelay: 150, latexFormatter: 'none', bibtexFormatter: 'none' } };
export async function findTexlab() {
  const home = os.homedir(), data = process.platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(home,'AppData','Local')) : process.platform === 'darwin' ? path.join(home,'Library','Application Support') : path.join(home,'.local','share');
  const name = process.platform === 'win32' ? 'texlab.exe' : 'texlab';
  const files = [process.env.NOZELI_TEXLAB, ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir,name)), path.join(data,'nozeli','toolchains','texlab',name)];
  for (const file of files.filter(Boolean)) { try { await fs.access(file, process.platform === 'win32' ? 0 : 1); return file; } catch {} }
  throw error('未安装 TexLab；TeX 高亮和本地模板仍可用。');
}
export function texLocation(value, root) {
  if (Array.isArray(value)) return value.map(v => texLocation(v, root)).filter(Boolean);
  if (!value) return value;
  const uri = value.targetUri || value.uri;
  if (!uri) return value;
  try {
    const relative = path.relative(root, fileURLToPath(uri));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return { ...value, relPath: relative.split(path.sep).join('/'), range: value.targetSelectionRange || value.range };
  } catch { return null; }
}
async function request(connection, method, params, ms = 5000) {
  const token = new CancellationTokenSource(); let timer;
  try { return await Promise.race([connection.sendRequest(method, params, token.token), new Promise((_,reject) => { timer=setTimeout(() => { token.cancel(); reject(error('TexLab 请求超时：'+method,'TEXLAB_TIMEOUT')); },ms); })]); }
  finally { clearTimeout(timer); token.dispose(); }
}
export class TexLanguageService {
  constructor({ host, onEvent = () => {}, executable = findTexlab } = {}) { this.host = host; this.onEvent = onEvent; this.executable = executable; this.sessions = new Map(); this.stopping = false; }
  emit(value) { this.onEvent({ server: 'texlab', ...value }); }
  start(projectId) {
    if (this.stopping) return Promise.reject(error('TexLab 正在退出。'));
    if (!this.sessions.has(projectId)) {
      const pending = this.launch(projectId);
      this.sessions.set(projectId, pending);
      pending.catch(() => { if (this.sessions.get(projectId) === pending) this.sessions.delete(projectId); });
    }
    return this.sessions.get(projectId);
  }
  async launch(projectId) {
    const project = await this.host.requireProject(projectId), executable = await this.executable();
    const child = spawn(executable, [], { cwd: project.root, stdio: ['pipe','pipe','pipe'], windowsHide: true });
    child.stdin.on('error', () => {}); let log = '';
    child.stderr.on('data', bytes => { log = (log + bytes.toString()).slice(-65536); });
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    connection.onError(() => {});
    const session = { projectId, root:project.root, child, connection, docs:new Map(), ready:false, serial:Promise.resolve(), log:()=>log };
    session.exited = new Promise(resolve => child.once('exit', resolve));
    child.on('error', e => { connection.dispose(); this.emit({projectId,type:'exit',message:e.message}); });
    child.once('exit', () => { session.ready=false; connection.dispose(); const pending=this.sessions.get(projectId); pending?.then(current => {if(current===session&&this.sessions.get(projectId)===pending)this.sessions.delete(projectId);}).catch(()=>{}); this.emit({ projectId,type:'exit',message:'TexLab 已退出。' }); });
    connection.onRequest('workspace/configuration', ({items}) => items.map(item => item.section?.split('.').reduce((v,k)=>v?.[k], settings) || settings.texlab));
    connection.onRequest('client/registerCapability', () => null);
    connection.onNotification('textDocument/publishDiagnostics', value => {
      const doc = session.docs.get(value.uri); if (!doc || (value.version != null && value.version !== doc.version)) return;
      this.emit({ projectId, type:'diagnostics', relPath:doc.relPath, text:doc.text, diagnostics:value.diagnostics || [] });
    });
    connection.listen();
    try {
      const initialized = await request(connection,'initialize',{ processId:process.pid,clientInfo:{name:'Nozeli',version:'0.1.0'}, rootUri:pathToFileURL(project.root).href,workspaceFolders:[{uri:pathToFileURL(project.root).href,name:project.name}],capabilities:{general:{positionEncodings:['utf-16']},workspace:{configuration:true,workspaceFolders:true},textDocument:{completion:{completionItem:{snippetSupport:true}},hover:{contentFormat:['markdown','plaintext']},definition:{linkSupport:true},publishDiagnostics:{versionSupport:true}}}},10000);
      if (initialized.capabilities?.positionEncoding && initialized.capabilities.positionEncoding !== 'utf-16') throw error('TexLab 返回了不支持的位置编码。');
      await connection.sendNotification('initialized',{}); await connection.sendNotification('workspace/didChangeConfiguration',{settings});
      session.ready=true; this.emit({projectId,type:'ready',cwd:project.root}); return session;
    } catch (e) { child.kill(); connection.dispose(); throw e; }
  }
  async document(session, relPath, text) {
    if (!supported.test(relPath || '') || typeof text !== 'string' || Buffer.byteLength(text)>8*1024*1024) throw error('无效 TeX/BibTeX 文档。','TEXLAB_DOCUMENT');
    const project=await this.host.requireProject(session.projectId), file=await this.host.resolveFile(project,relPath);
    if(file.missing)throw error('语言服务目标文件不存在。','TEXLAB_DOCUMENT');
    const uri=pathToFileURL(file.abs).href, old=session.docs.get(uri);
    if(old?.text===text)return {uri};
    const version=(old?.version||0)+1;
    session.docs.set(uri,{relPath,text,version});
    if(old)await session.connection.sendNotification('textDocument/didChange',{textDocument:{uri,version},contentChanges:[{text}]});
    else await session.connection.sendNotification('textDocument/didOpen',{textDocument:{uri,version,languageId:/\.bib$/i.test(relPath)?'bibtex':'latex',text}});
    return {uri};
  }
  async run(input, action) {
    const session=await this.start(input.projectId);
    const job=session.serial.then(async()=>{
      // Include unopened dependencies and their retained drafts. This is bounded by the existing project listing.
      const listed=await this.host.list(input.projectId);
      const files=listed.entries.filter(f=>f.kind!=='dir'&&supported.test(f.relPath));
      if(listed.truncated||files.length>250)throw error('TeX 语言服务首包最多同步 250 个源文件。','TEXLAB_LIMIT');
      const paths=new Set(files.map(f=>f.relPath));
      for(const [uri,doc] of session.docs)if(!paths.has(doc.relPath)){await session.connection.sendNotification('textDocument/didClose',{textDocument:{uri}});session.docs.delete(uri);}
      let bytes=Buffer.byteLength(input.text||'');
      for(const file of files)if(file.relPath!==input.relPath){
        const read=await this.host.readFile(input.projectId,file.relPath),text=read.draft?.text??read.text;
        bytes+=Buffer.byteLength(text||'');if(bytes>16*1024*1024)throw error('TeX 语言服务源文件总量超过 16 MiB。','TEXLAB_LIMIT');
        await this.document(session,file.relPath,text);
      }
      const document=await this.document(session,input.relPath,input.text);
      if(!action)return {ready:true,server:'texlab'};
      const lines=input.text.split('\n'),line=Math.max(0,Math.min(lines.length-1,input.line||0)),character=Math.max(0,Math.min(lines[line].length,input.column||0));
      const params={textDocument:document,position:{line,character}};
      if(action==='completion')params.context={triggerKind:1};
      if(action==='references')params.context={includeDeclaration:true};
      if(!['completion','hover','definition','references'].includes(action))throw error('此 TeX 语言操作尚未开放。','TEXLAB_ACTION');
      const value=await request(session.connection,'textDocument/'+action,params);
      if(action==='definition'||action==='references'){
        const normalized=texLocation(value,session.root),items=Array.isArray(normalized)?normalized:normalized?[normalized]:[];
        const safe=[];for(const item of items){try{const p=await this.host.requireProject(input.projectId);if(!(await this.host.resolveFile(p,item.relPath)).missing)safe.push(item);}catch{}}
        return safe;
      }
      return value;
    });
    session.serial=job.catch(()=>{});return job;
  }
  sync(input) { return this.run(input); }
  request(input) { return this.run(input,input.action); }
  async stopProject(projectId){const pending=this.sessions.get(projectId);if(!pending)return;const s=await pending;try{await request(s.connection,'shutdown',undefined,1000);await s.connection.sendNotification('exit');}catch{}s.connection.dispose();s.child.kill();await Promise.race([s.exited,new Promise(resolve=>{const t=setTimeout(()=>{s.child.kill('SIGKILL');resolve();},1000);t.unref();})]);this.sessions.delete(projectId);}
  async stopAll() {
    this.stopping=true;
    await Promise.allSettled([...this.sessions.values()].map(async pending=>{const s=await pending;try{await request(s.connection,'shutdown',undefined,1000);await s.connection.sendNotification('exit');}catch{}s.connection.dispose();s.child.kill();await Promise.race([s.exited,new Promise(resolve=>{const t=setTimeout(()=>{s.child.kill('SIGKILL');resolve();},1000);t.unref();})]);}));
    this.sessions.clear();this.stopping=false;
  }
}
