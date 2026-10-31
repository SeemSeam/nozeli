import {randomUUID, createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {parser as htmlParser} from '@lezer/html';
import {parser as javascriptParser} from '@lezer/javascript';
import {parser as cssParser} from '@lezer/css';
import { withReportReaderStyle, upgradeReportReaderStyle, reportAccentCss } from '../agents/managed/report-reader-style.mjs';

export const PREVIEW_LIMITS=Object.freeze({files:128,fileBytes:8*1024*1024,totalBytes:32*1024*1024});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>Object.assign(Error(message),{code:'PREVIEW_DENIED'});
const types={'.html':'text/html','.htm':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml'};
export function previewPath(value){
  if(typeof value!=='string'||value.length>1024||/[\\\x00-\x20\x7f:%?#]/.test(value)||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)))throw fail('预览路径无效。');
  if(!types[path.posix.extname(value).toLowerCase()]||value.split('/').some(p=>p.startsWith('.')))throw fail('不支持的预览资源。');
  return value;
}
function local(base,value){
  if(!value||value.startsWith('#')||value.startsWith('data:'))return null;
  if(/[\\\x00-\x20]/.test(value)||/^[a-z][a-z\d+.-]*:/i.test(value)||value.startsWith('/'))throw fail('离线预览不允许外部或绝对资源：'+value.slice(0,100));
  const raw=value.split(/[?#]/)[0];let decoded;try{decoded=decodeURIComponent(raw);}catch{throw fail('资源编码无效。');}
  return previewPath(path.posix.normalize(path.posix.join(path.posix.dirname(base),decoded)));
}
function checkedSyntax(parser,text,label){const tree=parser.parse(text);let count=0;tree.iterate({enter(node){if(node.type.isError)throw fail('预览 '+label+' 语法不受支持或无效。');if(++count>200000)throw fail('预览语法复杂度超过预算。');}});return tree;}
function jsLiteral(text,node){
  if(!node||!['String','TemplateString'].includes(node.name)||node.getChild('Interpolation'))throw fail('离线预览 import/fetch 路径必须是无插值的字面量。');
  const raw=text.slice(node.from+1,node.to-1);let value='';
  for(let i=0;i<raw.length;i++){
    if(raw[i]!=='\\'){value+=raw[i];continue;}
    const char=raw[++i];if(char==='\n')continue;if(char==='\r'){if(raw[i+1]==='\n')i++;continue;}
    if(char==='x'||char==='u'){
      const braced=char==='u'&&raw[i+1]==='{',start=i+(braced?2:1),end=braced?raw.indexOf('}',start):start+(char==='x'?2:4),hex=raw.slice(start,end);
      if(end<start||!hex||!/^[\da-f]+$/i.test(hex)||parseInt(hex,16)>0x10ffff)throw fail('预览路径字符串转义无效。');
      value+=String.fromCodePoint(parseInt(hex,16));i=braced?end:end-1;continue;
    }
    if(/[0-9]/.test(char))throw fail('预览路径不支持旧式八进制转义。');
    value+=({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v'})[char]??char;
  }
  return value;
}
const cssUnescape=value=>value.replace(/\\([\da-f]{1,6})(?:\r\n|[\t\n\r\f ])?|\\([^\n\r\f\da-f])/gi,(_,hex,char)=>hex?String.fromCodePoint(Math.min(parseInt(hex,16)||0xfffd,0x10ffff)):char);
export function previewDependencies(name,text){
  const result=new Set(),add=value=>{const rel=local(name,value);if(rel)result.add(rel);};
  const css=(input,inline=false)=>{
    const text=inline?'x{'+input+'}':input;
    checkedSyntax(cssParser,text,'CSS').iterate({enter(ref){
      const node=ref.node;
      if(node.name==='ImportStatement'){const literal=node.getChild('StringLiteral');if(literal)add(cssUnescape(text.slice(literal.from+1,literal.to-1)));}
      if(node.name==='CallLiteral'||node.name==='CallExpression'){
        const callee=node.getChild('CallTag')??node.getChild('Callee');if(!callee||cssUnescape(text.slice(callee.from,callee.to)).toLowerCase()!=='url')return;
        const literal=node.getChild('StringLiteral'),content=node.getChild('ParenthesizedContent'),args=node.getChild('ArgList');
        let value=literal?text.slice(literal.from+1,literal.to-1):content?text.slice(content.from,content.to):args?text.slice(args.from+1,args.to-1).trim():'';
        if(args&&/^['"]/.test(value))value=value.slice(1,-1);if(value)add(cssUnescape(value));
      }
    }});
  };
  const js=text=>checkedSyntax(javascriptParser,text,'JavaScript').iterate({enter(ref){
    const node=ref.node;
    if(node.name==='ImportDeclaration'||node.name==='ExportDeclaration'){
      const strings=node.getChildren('String');if(strings.length&&(node.name==='ImportDeclaration'||node.getChild('from')))add(jsLiteral(text,strings[strings.length-1]));
    }
    if(node.name==='DynamicImport')add(jsLiteral(text,node.getChild('String')??node.getChild('TemplateString')));
    if(node.name==='CallExpression'){
      const callee=node.firstChild,member=callee?.name==='MemberExpression',base=member?callee.firstChild:null,property=member?callee.getChild('PropertyName'):null;
      const fetch=callee?.name==='VariableName'&&text.slice(callee.from,callee.to)==='fetch'||member&&base?.name==='VariableName'&&['window','globalThis','self'].includes(text.slice(base.from,base.to))&&property&&text.slice(property.from,property.to)==='fetch';
      if(fetch){const args=node.getChild('ArgList');let first=args?.firstChild;while(first&&['(','LineComment','BlockComment'].includes(first.name))first=first.nextSibling;add(jsLiteral(text,first));}
    }
  }});
  if(/\.html?$/i.test(name)){
    const decode=value=>value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi,entity=>{const known={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'};return known[entity.toLowerCase()]??String.fromCodePoint(entity[2].toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):parseInt(entity.slice(2,-1),10));});
    htmlParser.parse(text).iterate({enter(node){
      if(node.name==='TagName'&&text.slice(node.from,node.to).toLowerCase()==='base')throw fail('离线预览不支持 base。');
      if(node.name==='Attribute'){
        const attr=node.node,nameNode=attr.getChild('AttributeName'),valueNode=attr.getChild('AttributeValue')??attr.getChild('UnquotedAttributeValue');if(!nameNode||!valueNode)return;
        const key=text.slice(nameNode.from,nameNode.to).toLowerCase(),raw=text.slice(valueNode.from,valueNode.to),value=decode(/^['"]/.test(raw)?raw.slice(1,-1):raw);
        if(key==='src'||key==='href')add(value);if(key==='srcset')throw fail('预览暂不支持 srcset；请使用明确 src。');if(key==='style')css(value,true);
      }
      if(node.name==='StyleText')css(text.slice(node.from,node.to));
      if(node.name==='ScriptText'){
        const attrs=node.node.parent?.getChild('OpenTag')?.getChildren('Attribute')??[];let type='',external=false;
        for(const attr of attrs){const keyNode=attr.getChild('AttributeName'),valueNode=attr.getChild('AttributeValue')??attr.getChild('UnquotedAttributeValue'),key=keyNode?text.slice(keyNode.from,keyNode.to).toLowerCase():'';if(key==='src')external=true;if(key==='type'&&valueNode){const raw=text.slice(valueNode.from,valueNode.to);type=decode(/^['"]/.test(raw)?raw.slice(1,-1):raw).toLowerCase();}}
        if(!['','module','text/javascript','application/javascript','application/json','application/ld+json'].includes(type))throw fail('预览不支持此脚本类型：'+type);
        if(!external&&!['application/json','application/ld+json'].includes(type))js(text.slice(node.from,node.to));
      }
    }});
  }else if(/\.css$/i.test(name))css(text);else if(/\.[mc]?js$/i.test(name))js(text);
  return [...result];
}
async function diskRead(host,project,rel){
  const located=await host.resolveFile(project,rel);if(located.missing)throw fail('预览依赖缺失：'+rel);
  const entry=await fs.lstat(located.abs,{bigint:true});if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1n||entry.size>BigInt(PREVIEW_LIMITS.fileBytes))throw fail('预览资源不是有界普通文件。');
  const handle=await fs.open(located.abs,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
  try{const before=await handle.stat({bigint:true});if(before.ino!==entry.ino||before.dev!==entry.dev||before.size!==entry.size)throw fail('预览资源已变化。');const bytes=Buffer.alloc(Number(before.size)+1);let count=0;while(count<bytes.length){const r=await handle.read(bytes,count,bytes.length-count,count);if(!r.bytesRead)break;count+=r.bytesRead;}const after=await handle.stat({bigint:true}),current=await fs.lstat(located.abs,{bigint:true});if(count!==Number(before.size)||['dev','ino','size','mtimeNs','ctimeNs','nlink'].some(k=>before[k]!==after[k]||after[k]!==current[k]))throw fail('预览资源已变化。');await host.resolveFile(project,rel);return bytes.subarray(0,count);}finally{await handle.close();}
}
export async function capturePreview({host,workspace,projectId,entryPath,buffers=[]}){
  const project=await host.requireProject(projectId),entry=previewPath(entryPath);if(!/\.html?$/i.test(entry))throw fail('请选择 HTML 入口。');
  const releases=[];
  try{
    for(const owner of workspace.projectRecords(projectId).filter(r=>!r.dead&&r.relPath&&types[path.posix.extname(r.relPath).toLowerCase()]))releases.push(await workspace.syncDocument({projectId,relPath:owner.relPath,hold:true,captureBuffer:true}));
    const saved=new Map([...workspace.buffers].filter(([,v])=>v.projectId===projectId).map(([k,v])=>[k,{...v}]));
    for(const assertion of buffers){const value=saved.get(workspace.resource(projectId,assertion.path));if(!value||value.revision!==assertion.version)throw fail('编辑缓冲版本已变化。');}
    const files=new Map(),pending=[entry];let total=0;
    while(pending.length){const rel=pending.shift();if(files.has(rel))continue;if(files.size>=PREVIEW_LIMITS.files)throw fail('预览依赖超过 128 项。');const buffer=saved.get(workspace.resource(projectId,rel));if(buffer?.missing)throw fail('预览依赖已删除：'+rel);const bytes=typeof buffer?.text==='string'?Buffer.from(buffer.text):await diskRead(host,project,rel);total+=bytes.length;if(bytes.length>PREVIEW_LIMITS.fileBytes||total>PREVIEW_LIMITS.totalBytes)throw fail('预览快照超过资源预算。');const mediaType=types[path.posix.extname(rel).toLowerCase()];files.set(rel,{bytes,mediaType,digest:hash(bytes),version:buffer?.revision??null,dirty:buffer?.dirty===true});if(/\.(html?|css|m?js)$/i.test(rel))pending.push(...previewDependencies(rel,bytes.toString('utf8')));}
    for(const [rel,file]of files){const current=workspace.buffers.get(workspace.resource(projectId,rel)),savedValue=saved.get(workspace.resource(projectId,rel));if(current?.revision!==savedValue?.revision)throw fail('捕获期间编辑缓冲已变化。');if(file.version===null&&hash(await diskRead(host,project,rel))!==file.digest)throw fail('捕获期间磁盘依赖已变化。');}
    if((await host.requireProject(projectId)).root!==project.root)throw fail('项目目录已变化。');return {entry,files,projectId};
  }finally{for(const release of releases.reverse())release();}
}

export function previewCsp(profile,origin="'self'"){const development=profile==='offlineDevelopment';return `default-src 'none'; sandbox${development?' allow-scripts':''}; base-uri 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; frame-ancestors 'none'; script-src ${development?origin+" 'unsafe-inline'":"'none'"}; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; font-src 'none'; media-src 'none'; connect-src ${development?origin:"'none'"}; manifest-src 'none'`;}
// This is the first parser-executed script, not a preload and has no host bridge.
// CSP sandbox omits allow-same-origin: fresh about:blank/srcdoc realms cannot
// be synchronously borrowed to recover constructors. CORS is snapshot-only.
export const OFFLINE_BOOTSTRAP=`(()=>{'use strict';for(const name of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebSocket','WebTransport','Worker','SharedWorker','open','alert','confirm','prompt','showOpenFilePicker','showSaveFilePicker','showDirectoryPicker'])Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});Object.defineProperty(Navigator.prototype,'serviceWorker',{value:undefined,writable:false,configurable:false});})();`;
export function previewUrlMember(raw,origin,files){try{const url=new URL(raw);if(url.origin!==origin||url.username||url.password||url.search||/%(?:2e|2f|5c|25)/i.test(url.pathname))return null;const rel=previewPath(decodeURIComponent(url.pathname.slice(1)));return files.has(rel)?rel:null;}catch{return null;}}

export class IsolatedPreviewManager{
  constructor({WebContentsView,session,workspace,host,managedAgents,dialog}){Object.assign(this,{WebContentsView,session,workspace,host,managedAgents,dialog});this.slots=new Map();this.pending=new Map();this.generations=new Map();this.recoveryScopes=new Set();}
  id(scope,key){if(typeof key!=='string'||key.length<1||key.length>256||/[\x00-\x1f\x7f]/.test(key))throw fail('预览身份无效。');return `${scope.wc.id}:${key}`;}
  emit(slot,type,detail={}){if(slot.closed||slot.scope.dead||slot.scope.wc.isDestroyed())return;slot.scope.wc.send('nozeli:isolated-preview',{key:slot.key,generation:slot.generation,type,...detail});}
  closeScope(scope){for(const slot of new Set([...this.slots.values(),...this.pending.values()]))if(slot.scope===scope)this.close(slot);this.recoveryScopes.delete(scope);for(const key of this.generations.keys())if(key.startsWith(scope.wc.id+':'))this.generations.set(key,this.generations.get(key)+1);}
  reparentScope(scope, destination) {
    const previous = scope.previewWindow ?? scope.win;
    const moved = [];
    try {
      for (const slot of this.slots.values()) {
        if (slot.scope !== scope || slot.closed || !slot.view || !slot.parentWindow || slot.parentWindow===destination) continue;
        const entry = {slot, source:slot.parentWindow};
        moved.push(entry);
        slot.view.setVisible(false);
        entry.source.contentView.removeChildView(slot.view);slot.parentWindow=null;
        destination.contentView.addChildView(slot.view);slot.parentWindow=destination;
      }
      scope.previewWindow=destination;
    } catch (error) {
      const failures=[];
      for (const entry of moved.reverse()) {
        try {
          if(entry.slot.parentWindow===entry.source)continue;
          if(entry.slot.parentWindow){entry.slot.parentWindow.contentView.removeChildView(entry.slot.view);entry.slot.parentWindow=null;}
          entry.source.contentView.addChildView(entry.slot.view);entry.slot.parentWindow=entry.source;
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      scope.previewWindow=previous;
      if(failures.length){this.holdScope(scope,[previous,destination,...moved.map(entry=>entry.source)]);const failure=new AggregateError([error,...failures],'报告正文迁移失败，部分回滚尚未确认；原生窗口与阅读现场已保留。',{cause:error});failure.code='PREVIEW_ROLLBACK_FAILED';failure.previewRollbackFailed=true;throw failure;}
      throw error;
    }
  }
  holdScope(scope,parents){scope.recoveryHeld=true;scope.previewRecoveryFailed=true;scope.previewRecoveryParents??=new Set();for(const parent of parents)if(parent)scope.previewRecoveryParents.add(parent);this.recoveryScopes.add(scope);}
  holdsWindow(win){for(const scope of this.recoveryScopes)if(scope.previewRecoveryParents.has(win))return true;return false;}
  close(slot){
    if(slot.closed)return;slot.closed=true;slot.cancel?.(fail('预览请求已取消。'));
    if(this.slots.get(slot.id)===slot)this.slots.delete(slot.id);if(this.pending.get(slot.id)===slot)this.pending.delete(slot.id);
    if(slot.view){try{(slot.parentWindow??slot.scope.previewWindow??slot.scope.win).contentView.removeChildView(slot.view);}catch{}const wc=slot.view.webContents;if(!wc.isDestroyed())wc.close({waitForBeforeUnload:false});}
    if(slot.protocolHandled)slot.session.protocol.unhandle('https');slot.files.clear();
  }
  bounds(slot,bounds){
    if(!bounds||!['x','y','width','height'].every(k=>Number.isFinite(bounds[k])))throw fail('预览区域无效。');
    // Retain the renderer's requested rectangle, not the temporary clipping
    // against a hidden/initially zero-sized owner. Native layout reuses it.
    slot.bounds={x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height};
    const parent=slot.scope.role==='surface'?slot.scope.view.getBounds():{x:0,y:0,width:slot.scope.win.getContentSize()[0],height:slot.scope.win.getContentSize()[1]};
    const x=Math.max(0,Math.round(bounds.x)),y=Math.max(0,Math.round(bounds.y)),width=Math.max(0,Math.min(Math.round(bounds.x+bounds.width),parent.width)-x),height=Math.max(0,Math.min(Math.round(bounds.y+bounds.height),parent.height)-y);
    slot.view.setBounds({x:parent.x+x,y:parent.y+y,width,height});
    slot.view.setVisible(!slot.scope.transferring&&!slot.scope.previewRecoveryFailed&&width>0&&height>0&&(slot.scope.role!=='surface'||slot.scope.view.getVisible()));
  }
  snapshot(slot){const unsaved=[...slot.files.values()].some(f=>f.dirty);return {key:slot.key,generation:slot.generation,profile:slot.profile,projectId:slot.projectId,entryPath:slot.entry,origin:slot.origin,files:[...slot.files].map(([path,f])=>({path,digest:f.digest,version:f.version,dirty:f.dirty})),dirty:unsaved,unsaved};}
  // Enum-only appearance injection for live static reports: values come from the
  // fixed accent map; the frozen object and its export bytes never change.
  setAppearance(value) {
    this.appearance = { palette: value?.palette === 'slate' ? 'slate' : 'sage', mode: value?.mode === 'dark' ? 'dark' : 'light' };
    for (const slot of this.slots.values()) if (slot.profile === 'staticReport' && slot.view && !slot.closed) void this.injectReportAppearance(slot);
  }
  injectReportAppearance(slot) {
    // Serialize per slot: concurrent did-finish-load and setAppearance callers must
    // not race key removal/insertion or only the last key would be tracked.
    slot.accentChain = (slot.accentChain ?? Promise.resolve()).then(async () => {
      const wc = slot.view?.webContents;
      if (slot.closed || !wc || wc.isDestroyed()) return;
      const css = reportAccentCss(this.appearance?.palette ?? 'sage', this.appearance?.mode ?? 'light');
      for (const key of slot.accentKeys ?? []) await wc.removeInsertedCSS(key).catch(() => {});
      try { slot.accentKeys = [await wc.insertCSS(css, { cssOrigin: 'user' })]; }
      catch (error) { slot.accentKeys = [];if(!slot.closed&&!wc.isDestroyed())this.emit(slot,'error',{message:'报告配色更新失败：'+error.message}); }
    });
    return slot.accentChain;
  }
  async invoke(scope,op,p){
    const id=this.id(scope,p.key),old=this.slots.get(id);
    if(op==='isolated-preview.close'){this.generations.set(id,(this.generations.get(id)||0)+1);const pending=this.pending.get(id);if(pending)this.close(pending);if(old)this.close(old);return {closed:true};}
    if(!['isolated-preview.open','isolated-preview.update'].includes(op)){
      if(!old||p.generation!==undefined&&p.generation!==old.generation)throw fail('预览版本已失效。');
      if(op==='isolated-preview.bounds'){this.bounds(old,p.bounds);return {updated:true};}
      if(op==='isolated-preview.snapshot')return this.snapshot(old);
      if(op==='isolated-preview.reference.save'){
        const reference=old.manifest?.references?.find(ref=>String(ref.id)===String(p.referenceId));
        if(old.profile!=='staticReport'||p.generation!==old.generation||reference?.kind!=='artifact'||typeof old.source.copyReference!=='function'||!this.dialog)throw fail('冻结工件另存不可用。');
        const choice=await this.dialog.showSaveDialog(scope.win,{title:'另存完整冻结工件（不会覆盖已有文件）',defaultPath:path.posix.basename(reference.relPath)});
        if(choice.canceled||!choice.filePath)return {cancelled:true};
        if(this.slots.get(id)!==old||scope.dead)throw fail('冻结引用已过期。');
        return old.source.copyReference(String(p.referenceId),choice.filePath);
      }
      if(op==='isolated-preview.reference'){
        if(old.profile!=='staticReport'||p.generation!==old.generation||!old.manifest.references.some(ref=>String(ref.id)===String(p.referenceId)))throw fail('冻结引用无效。');
        const reference=await old.source.readReference(String(p.referenceId));if(this.slots.get(id)!==old)throw fail('冻结引用已过期。');
        if(reference.kind==='external')return reference;
        if(!reference.bytes)return {...reference,bytes:undefined,text:'此冻结文件为 '+reference.byteLength+' 字节，超出内嵌预览预算；摘要与完整不可变工件已验证，接受成果不受预览限制。'};
        let text;
        const textReference=reference.mediaType?.startsWith('text/')||reference.mediaType==='application/json'||reference.mediaType==='application/octet-stream'&&/\.(?:[cm]?[jt]sx?|json|md|txt|css|html?|ya?ml|toml|xml|csv|tex|bib|py|rs|go|[ch](?:pp)?|sh)$/i.test(reference.relPath||'');
        if(textReference){try{const decoded=new TextDecoder('utf-8',{fatal:true}).decode(reference.bytes);if(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded))text=decoded;}catch{}}
        return {...reference,bytes:undefined,text,dataUrl:reference.mediaType?.startsWith('image/')?'data:'+reference.mediaType+';base64,'+reference.bytes.toString('base64'):undefined};
      }
      if(op==='isolated-preview.print'){if(old.profile==='offlineDevelopment'&&old.entry.split('.').pop().toLowerCase()!=='html')throw fail('仅 HTML 预览支持打印。');return new Promise((resolve,reject)=>old.view.webContents.print({silent:p.silent===true,printBackground:true},(ok,reason)=>ok?resolve({printed:true}):reject(fail(reason))));}
      throw fail('未知预览操作。');
    }
    if(p.projectId!==scope.projectId||!['staticReport','offlineDevelopment'].includes(p.profile)||!Number.isSafeInteger(p.generation)||p.generation<1||p.generation<=(this.generations.get(id)||0))throw fail('预览项目、配置或版本无效。');
    const generation=p.generation;this.generations.set(id,generation);const ownerGeneration=scope.generation;
    const previousPending=this.pending.get(id);if(previousPending)this.close(previousPending);
    const alive=()=>!scope.dead&&scope.generation===ownerGeneration&&scope.projectId===p.projectId&&this.generations.get(id)===generation;
    let snapshot,source,manifest;
    try{
      if(p.profile==='staticReport'){source=await this.managedAgents.reportSource(p.projectId,p.objectId);if(source.report?.format!=='html-static')throw fail('此报告不是静态 HTML。');const bytes=await source.read();manifest=await source.readManifest();snapshot={entry:'report.html',projectId:p.projectId,files:new Map([['report.html',{bytes,mediaType:'text/html',digest:hash(bytes),version:null,dirty:false}]])};}
      else snapshot=await capturePreview({host:this.host,workspace:this.workspace,projectId:p.projectId,entryPath:p.entryPath,buffers:p.buffers});
      if(!alive())throw fail('预览请求已过期。');
      const ses=this.session.fromPartition('isolated-preview-'+randomUUID(),{cache:false}),origin='https://'+randomUUID()+'.invalid',nonce=randomUUID().replaceAll('-','');
      const slot={...snapshot,id,key:p.key,profile:p.profile,generation,scope,session:ses,origin,nonce,source,manifest};
      const referenceTargets=new Map((manifest?.references||[]).map(ref=>[origin+'/__nozeli_report_reference__/'+encodeURIComponent(ref.id),ref]));
      slot.cancelled=new Promise(resolve=>slot.cancel=resolve);this.pending.set(id,slot);
      const cancellable=operation=>Promise.race([operation,slot.cancelled.then(error=>{throw error;})]);
      try{
      ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);ses.setDevicePermissionHandler(()=>false);ses.setDisplayMediaRequestHandler((_request,callback)=>callback({}));ses.on('will-download',event=>event.preventDefault());await cancellable(ses.setProxy({mode:'fixed_servers',proxyRules:'http=127.0.0.1:9;https=127.0.0.1:9',proxyBypassRules:'<-loopback>'}));if(!alive()||slot.closed)throw fail('预览请求已过期。');ses.setSpellCheckerEnabled(false);
      const member=url=>previewUrlMember(url,origin,slot.files);
      ses.webRequest.onBeforeRequest((details,callback)=>{const rel=member(details.url),dataImage=details.resourceType==='image'&&/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(details.url)&&details.url.length<=12*1024*1024,allowed=dataImage||!!rel&&['GET','HEAD'].includes(details.method)&&!['webSocket','other','subFrame'].includes(details.resourceType);callback({cancel:!allowed});if(!allowed)this.emit(slot,'resource-error',{url:details.url.slice(0,500),message:'未登记或禁止的离线资源请求'});});
      ses.protocol.handle('https',request=>{
        const rel=member(request.url);if(!rel||!['GET','HEAD'].includes(request.method))return new Response(null,{status:403});
        const file=slot.files.get(rel);let bytes=file.bytes;
        if(slot.profile==='offlineDevelopment'&&file.mediaType==='text/html'){
          const text=bytes.toString('utf8'),doctype=/^\s*<!doctype\s+html\s*>/i.exec(text),offset=doctype?.[0].length??0;
          bytes=Buffer.from(text.slice(0,offset)+`<script nonce="${nonce}">${OFFLINE_BOOTSTRAP}</script>`+text.slice(offset));
        }
        if(slot.profile==='staticReport'&&file.mediaType==='text/html'){
          // Only served bytes change: use an intercepted same-origin navigation,
          // not a custom external protocol blocked by CSP sandbox.
          let text=upgradeReportReaderStyle(withReportReaderStyle(bytes.toString('utf8')));
          for(const [target,ref]of referenceTargets)text=text.replaceAll('href="nozeli-report-ref:'+ref.id+'"','href="'+target+'"');
          bytes=Buffer.from(text);
        }
        return new Response(request.method==='HEAD'?null:bytes,{headers:{'content-type':file.mediaType+'; charset=utf-8','content-security-policy':previewCsp(slot.profile,origin),'x-content-type-options':'nosniff','cache-control':'no-store','cross-origin-resource-policy':'cross-origin','access-control-allow-origin':'*','permissions-policy':'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), bluetooth=(), payment=()'}});
      });
      slot.protocolHandled=true;
        slot.view=new this.WebContentsView({webPreferences:{session:ses,javascript:p.profile==='offlineDevelopment',nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,disableDialogs:true,safeDialogs:true,devTools:false,navigateOnDragDrop:false}});
        const wc=slot.view.webContents;wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');wc.setWindowOpenHandler(()=>({action:'deny'}));wc.on('will-attach-webview',e=>e.preventDefault());wc.on('will-redirect',e=>e.preventDefault());
        // Static reports follow the app theme natively: nativeTheme.themeSource
        // drives prefers-color-scheme and the host baseline declares
        // color-scheme:light dark, so no pin may override it. Development
        // previews keep their original explicit pin.
        if(slot.profile==='offlineDevelopment'&&['light','dark'].includes(p.theme))wc.on('did-finish-load',()=>{void wc.insertCSS(':root{color-scheme:'+p.theme+'!important}',{cssOrigin:'user'}).catch(error=>this.emit(slot,'error',{message:error.message}));});
        if(slot.profile==='staticReport')wc.on('did-finish-load',()=>{void this.injectReportAppearance(slot);});
        const navigation=(event,url)=>{const target=typeof url==='string'?url:url?.url??event.url;if(slot.profile==='offlineDevelopment'&&member(target)&&slot.files.get(member(target)).mediaType==='text/html')return;if(slot.profile==='staticReport'&&target?.startsWith(origin+'/report.html#'))return;event.preventDefault();if(slot.profile==='staticReport'){const ref=referenceTargets.get(target);if(ref)this.emit(slot,'reference',{reference:ref,referenceId:String(ref.id),objectId:p.objectId});}};
        wc.on('will-navigate',navigation);wc.on('will-frame-navigate',(event,url,_inPlace,legacyMainFrame)=>{const mainFrame=event.isMainFrame??legacyMainFrame;if(!mainFrame)event.preventDefault();else navigation(event,url??event.url);});
        wc.on('console-message',(_event,details,...legacy)=>this.emit(slot,'console',{level:details?.level??details,message:String(details?.message??legacy[0]??'').slice(0,2000)}));wc.on('render-process-gone',(_e,details)=>this.emit(slot,'error',{message:'预览进程已退出：'+details.reason}));wc.on('unresponsive',()=>this.emit(slot,'error',{message:'预览无响应；可关闭或刷新，编辑缓冲保留。'}));
        await cancellable(wc.loadURL(origin+'/'+slot.entry.split('/').map(encodeURIComponent).join('/')));if(!alive()||slot.closed)throw fail('预览请求已过期。');slot.parentWindow=scope.previewWindow??scope.win;slot.parentWindow.contentView.addChildView(slot.view);this.bounds(slot,p.bounds??old?.bounds??{x:0,y:0,width:0,height:0});this.workspace.demoControls?.raise();this.pending.delete(id);this.slots.set(id,slot);if(old)this.close(old);this.emit(slot,'ready',this.snapshot(slot));return this.snapshot(slot);
      }catch(error){this.close(slot);throw error;}
    }catch(error){if(alive())scope.wc.send('nozeli:isolated-preview',{key:p.key,generation,type:'error',message:error.message,previousPreserved:!!old});throw error;}
  }
}
