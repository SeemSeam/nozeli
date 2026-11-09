// ── Worker worktree 依赖/声明资源供给（provisioning for execution copies）──
// Git worktree 永不携带被忽略的文件：已安装的 node_modules 与项目声明的已准备
// vendor 资源（如 vendor/pptist/dist，由 tools/build-pptist.mjs 产出、被根
// .gitignore 的 dist/ 忽略）不会出现在执行目录。负载走同一安全引擎：
// 仅当源项目仍持有负载、且门文件（package.json+package-lock.json，或被冻结
// 输入跟踪的 vendor/prepared-resources.json；一次性补救路径见文末）在 Worker
// 树与源端都与冻结参照字节完全一致时，才向执行目录写入独立拷贝（reflink
// 优先，绝不创建指向可写源端的符号链接），经 .nozeli 下 marker（workId 精确
// 匹配）门控的暂存目录 + 原子 rename 落盘。全程不运行 npm/钩子/网络、绝不
// 改动源项目目录；目录链与全部暂存/清理写入都经平台文件边界
// （platform/{linux,darwin}/filesystem.mjs chain.*，逐级 O_NOFOLLOW 固定；
// 本模块不自持 fd 路径算法），复制前/后双重核对门文件与负载身份，任一变化
// 即放弃（不出现半成品可用假象）。源端 npm 符号链接一律实体化拷贝（允许并
// 绝不把链接装进执行树）。缺失或不匹配以“风险 + 可执行选项”记入
// manifest.dependencies，绝不伪造可用，也不是永久 cannot。
// node_modules 与 .nozeli 均被 workPath 排除，拷贝永远不会进入候选快照或合入
// 工件。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {defaultFilesystemAdapter} from './file-stream.mjs';

export const DEPENDENCIES_VERSION=1;
export const PREPARED_RESOURCES_REL='vendor/prepared-resources.json';
const WRAPPER='.nozeli';               // workPath 已排除：暂存内容永不进入候选快照
const STAGING_PREFIX='deps-';
const STAGING_MARKER='staging.json';
const MAX_MATERIALIZED=512;            // 病态符号链接扇出保护
const MAX_RESOURCES=32;
// 与 execution-workspace 的 workPath 排除集保持一致（那边无法直接复用：会形成
// 循环依赖）；声明资源路径同样拒绝这些段。
const EXCLUDED_SEGMENTS=new Set(['.git','.nozeli','.ccb','node_modules','.venv','venv','__pycache__']);

const digest=bytes=>bytes===null||bytes===undefined?null:createHash('sha256').update(bytes).digest('hex');
const readBytes=file=>fs.readFile(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const toAbs=(root,rel)=>path.join(root,...(rel?rel.split('/'):[]));

// 依赖候选=冻结输入里成对出现 package.json + package-lock.json 的目录；依赖内
// 部（node_modules 下）绝不成为候选。
export function dependencyCandidates(frozenFiles){
 const files=frozenFiles||{},out=[];
 for(const rel of Object.keys(files)){
  if(rel!=='package.json'&&!rel.endsWith('/package.json'))continue;
  const dir=rel==='package.json'?'':rel.slice(0,-'/package.json'.length);
  if(dir.split('/').includes('node_modules'))continue;
  const lock=dir?dir+'/package-lock.json':'package-lock.json';
  if(!files[lock])continue;
  out.push({dir,manifest:rel,lock});
 }
 return out.sort((a,b)=>a.dir<b.dir?-1:a.dir>b.dir?1:0);
}

// 声明的已准备资源清单：必须是冻结输入跟踪的 vendor/prepared-resources.json，
// schema 严格、路径受限（相对路径、无 node_modules/.git 等段、无遍历），
// 可携带 pinned 上游出处（revision + 源档案 SHA-256）作为供给出处记录。
function validResourcePath(value){
 if(typeof value!=='string'||!value)return false;
 if(value.length>512||value.includes('\\')||value.includes('\0'))return false;
 if(value.split('/').some(part=>!part||part==='.'||part==='..'||EXCLUDED_SEGMENTS.has(part)))return false;
 return !path.isAbsolute(value);
}
export function parsePreparedResources(text){
 let parsed;try{parsed=JSON.parse(text);}catch{return {error:'invalid-json'};}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.version!==1||!Array.isArray(parsed.resources))return {error:'invalid-schema'};
 if(parsed.resources.length>MAX_RESOURCES)return {error:'too-many-resources'};
 const seen=new Set(),resources=[];
 for(const row of parsed.resources){
  if(!row||typeof row!=='object'||Array.isArray(row))return {error:'invalid-resource'};
  if(typeof row.path!=='string'||!validResourcePath(row.path))return {error:'invalid-path',path:typeof row.path==='string'?row.path.slice(0,200):null};
  if(seen.has(row.path))return {error:'duplicate-path',path:row.path};
  seen.add(row.path);
  const tool=typeof row.tool==='string'&&row.tool.trim()?row.tool.trim().slice(0,200):null;
  let upstream=null;
  if(row.upstream!==undefined){
   const u=row.upstream;
   if(!u||typeof u!=='object'||Array.isArray(u)||typeof u.revision!=='string'||!u.revision.trim()||u.revision.length>200||typeof u.sha256!=='string'||!/^[0-9a-f]{64}$/i.test(u.sha256))return {error:'invalid-upstream',path:row.path};
   upstream={revision:u.revision.trim(),sha256:u.sha256.toLowerCase()};
  }
  resources.push({path:row.path,tool,upstream});
 }
 return {resources};
}

// 独立拷贝（源端普通路径读，目标端经 chain.destination 单组件驱动）：
// 符号链接一律实体化（拷贝内容，npm 允许并保留这一语义），绝不重建指向
// 源端的链接；环/断链/特殊文件跳过并记录。stack+materialized 双保护防
// 符号链接无限展开。目标写入全部落在固定目录内（Linux 走 /proc 固定路径
// FICLONE 优先，macOS 走 openat/clonefileat），组合路径永不逃逸锚。只读
// 源端。
async function copyTree(source,dest,rel,ctx,native){
 const stat=await fs.lstat(source);
 if(stat.isSymbolicLink()){
  let real;try{real=await fs.realpath(source);}catch{ctx.skipped.push({kind:'broken-symlink',rel});return;}
  const seen=(ctx.materialized.get(real)||0)+1;ctx.materialized.set(real,seen);
  if(seen>MAX_MATERIALIZED){const error=new Error('符号链接展开超出保护上限：'+rel);error.code='COPY_LIMIT';throw error;}
  if(ctx.stack.has(real)){ctx.skipped.push({kind:'symlink-cycle',rel});return;}
  ctx.stack.add(real);try{await copyTree(real,dest,rel,ctx,native);}finally{ctx.stack.delete(real);}
  return;
 }
 if(stat.isDirectory()){
  await dest.mkdir();await dest.chmod(stat.mode&0o777).catch(()=>{});
  const inner=await dest.openDir();
  try{
   for(const name of (await fs.readdir(source)).sort())await copyTree(path.join(source,name),native.destination(inner,name),rel?rel+'/'+name:name,ctx,native);
  }finally{await inner.close().catch(()=>{});}
  ctx.directories++;return;
 }
 if(stat.isFile()){await dest.copyFile(source);ctx.files++;ctx.bytes+=stat.size;return;}
 ctx.skipped.push({kind:'special-file',rel});
}

async function sourcePayload(payloadPath,missingCode,missingDetail){
 const stat=await fs.lstat(payloadPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(!stat)return {code:missingCode,detail:missingDetail};
 let root=payloadPath;
 if(stat.isSymbolicLink()){
  try{root=await fs.realpath(payloadPath);}catch{return {code:'unsafe-source',detail:'源负载是指向不存在位置的符号链接。'};}
 }
 const target=await fs.stat(root).catch(()=>null);
 if(!target||!target.isDirectory())return {code:'unsafe-source',detail:'源负载不是真实目录。'};
 return {code:null,root,identity:{dev:target.dev,ino:target.ino,real:await fs.realpath(root)}};
}

// marker 必须是常规文件、可解析 JSON 且 workId 与当前工作精确一致；只删除满足
// 全部条件的暂存目录。删除采用固定目录内先 rename 再 rm，路径被换也不误删。
async function stagingMarker(native,stagedHandle){
 const handle=await native.openFile(stagedHandle,STAGING_MARKER).catch(()=>null);
 if(!handle)return null;
 try{
  const stat=await handle.stat();
  if(!stat.isFile()||stat.size>4096)return null;
  const parsed=JSON.parse((await handle.readFile()).toString('utf8'));
  return parsed&&typeof parsed==='object'&&typeof parsed.workId==='string'?parsed:null;
 }catch{return null;}finally{await handle.close().catch(()=>{});}
}
async function cleanStaging(native,workId,wrapperHandle){
 for(const name of await native.readdir(wrapperHandle).catch(() => [])){
  if(!name.startsWith(STAGING_PREFIX)||name.includes('.rm-'))continue;
  const staged=await native.openDirectory(wrapperHandle,name).catch(error=>{if(['ENOENT','ENOTDIR','ELOOP'].includes(error.code))return null;throw error;});
  if(!staged)continue;
  try{
   if((await stagingMarker(native,staged))?.workId!==workId)continue;
   const trash=name+'.rm-'+randomUUID();
   await native.rename(wrapperHandle,name,wrapperHandle,trash);
   await native.removeTree(wrapperHandle,trash);
  }finally{await staged.close().catch(()=>{});}
 }
}
// wrapper 必须是真实目录：仅在真正要暂存时才创建；符号链接（ELOOP）直接拒绝。
async function openWrapper(native,packageHandle,{create=false}={}){
 let handle=await native.openDirectory(packageHandle,WRAPPER).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(!handle&&create){
  await native.mkdir(packageHandle,WRAPPER,0o755).catch(error=>{if(error.code!=='EEXIST')throw error;});
  handle=await native.openDirectory(packageHandle,WRAPPER);
 }
 return handle?{handle,real:await native.realpath(handle)}:null;
}

// 通用供给引擎：spec 描述负载（目标名/所在目录）、门文件（以冻结参照跟踪、
// Worker 与源端都必须与冻结字节一致）与文案。所有负载共用全部安全机制。
async function provisionPayload({workId,sourceRoot,worktreeRoot,frozenFiles,spec,filesystem}){
 const native=filesystem.chain;
 const entry={dir:spec.dir||'.',kind:spec.kind,outcome:null,reason:null,detail:null,...(spec.entryExtra||{})};
 // 1) 先验证再读取：负载父目录链任一环节符号链接/非目录即整体拒绝。
 let chain;
 try{chain=await native.directory(worktreeRoot,spec.dir);}
 catch(error){
  if(error.code==='ELOOP'||error.code==='ENOTDIR'){entry.outcome='unsafe-target-path';entry.detail='目标路径或其父级含符号链接/非目录；拒绝读取、清理与写入。';return entry;}
  if(error.code==='ENOENT'){entry.outcome='worker-file-changed';entry.reason='target-dir-missing';entry.detail='Worker树的目标目录不存在；不供给该负载。';return entry;}
  throw error;
 }
 let wrapper=null;
 try{
  const state={};
  for(const gate of spec.gates)
   state[gate.rel]={frozen:frozenFiles[gate.rel]?.digest??null,worker:digest(await readBytes(toAbs(worktreeRoot,gate.rel)))};
  // 2) Worker 树门文件必须仍是冻结参照：被改过就绝不按旧输入供给。
  for(const gate of spec.gates)
   if(state[gate.rel].worker===null||state[gate.rel].worker!==state[gate.rel].frozen){entry.outcome='worker-file-changed';entry.reason=gate.label;entry.detail=spec.texts.workerChanged(gate);return entry;}
  // 3) 暂存根必须是真实目录；清理仅限 marker+workId 精确匹配的我方目录。
  try{wrapper=await openWrapper(native,chain.handle);}
  catch(error){
   if(error.code==='ELOOP'||error.code==='ENOTDIR'){entry.outcome='unsafe-target-path';entry.reason='staging-root';entry.detail='.nozeli暂存根不是真实目录（可能是符号链接）；拒绝清理与写入，未删除、未跟随任何内容。';return entry;}
   throw error;
  }
  if(wrapper)await cleanStaging(native,workId,wrapper.handle);
  // 4) 已被冻结参照跟踪的资源无需供给；已有目标（含用户自备内容/符号链接）一律保留。
  if(spec.trackedGate&&frozenFiles[spec.payloadRel]){entry.outcome='present';entry.reason='tracked';entry.detail='该资源已在冻结输入中，无需供给。';return entry;}
  const targetName=spec.targetName,existing=await native.lstat(chain.handle,targetName).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(existing){
   if(existing.isSymbolicLink()){entry.outcome='target-symlink';entry.detail='Worker目录已有'+targetName+'符号链接；保留现场，未替换、未跟随。';}
   else if(existing.isDirectory()){entry.outcome='present';entry.detail='Worker目录已有'+targetName+'；未改动（现有内容优先）。';}
   else{entry.outcome='target-not-directory';entry.detail='Worker目录的'+targetName+'不是目录；保留现场。';}
   return entry;
  }
  // 5) 源端必须持有负载，且门文件与冻结参照字节一致；不一致=拒绝错版本拷贝。
  const source=await sourcePayload(toAbs(sourceRoot,spec.payloadRel),spec.missingCode,spec.texts.payloadMissing());
  if(source.code){entry.outcome=source.code;entry.detail=source.detail;return entry;}
  for(const gate of spec.gates){
   const live=digest(await readBytes(toAbs(sourceRoot,gate.rel)));
   if(live===null){entry.outcome='source-'+gate.label+'-missing';entry.detail=spec.texts.sourceMissing(gate);return entry;}
   if(live!==state[gate.rel].frozen){entry.outcome='source-'+gate.label+'-differs';entry.detail=spec.texts.sourceDiffers(gate);return entry;}
  }
  // 6) 独立拷贝：marker 先落盘再复制；rename 前复核门文件与负载身份，任一变化
  //    即放弃（不产生半成品）；目标名先以 mkdir 占位（EEXIST=已出现，保留现有
  //    内容），rename 原子替换我方空占位目录。收尾统一清暂存，wrapper 为空才移除。
  const stagingName=STAGING_PREFIX+randomUUID();
  let staging=null;
  const ctx={files:0,bytes:0,directories:0,skipped:[],stack:new Set(),materialized:new Map()};
  try{
   if(!wrapper){
    try{wrapper=await openWrapper(native,chain.handle,{create:true});}
    catch(error){
     if(error.code==='ELOOP'||error.code==='ENOTDIR'){entry.outcome='unsafe-target-path';entry.reason='staging-root';entry.detail='.nozeli暂存根不是真实目录（可能是符号链接）；拒绝写入，未删除、未跟随任何内容。';return entry;}
     throw error;
    }
   }
   await native.mkdir(wrapper.handle,stagingName,0o755);
   staging=await native.openDirectory(wrapper.handle,stagingName);
   await native.writeExclusive(staging,STAGING_MARKER,JSON.stringify({workId,at:new Date().toISOString()})+'\n');
   await copyTree(source.root,native.destination(staging,targetName),'',ctx,native);
   const changed=async()=>{
    for(const gate of spec.gates)
     if(digest(await readBytes(toAbs(worktreeRoot,gate.rel)))!==state[gate.rel].frozen)return 'worker-'+gate.label;
    for(const gate of spec.gates)
     if(digest(await readBytes(toAbs(sourceRoot,gate.rel)))!==state[gate.rel].frozen)return 'source-'+gate.label;
    const now=await fs.stat(source.root).catch(()=>null);
    if(!now||now.dev!==source.identity.dev||now.ino!==source.identity.ino)return 'source-payload';
    if(await fs.realpath(source.root).catch(()=>null)!==source.identity.real)return 'source-payload';
    return null;
   };
   const drift=await changed();
   if(drift){entry.outcome='changed-during-copy';entry.reason=drift;entry.detail='复制期间'+(drift.startsWith('source')?'源端':'Worker')+'输入或负载身份发生变化；已丢弃暂存，未安装、无半成品。重新执行即可按新状态重试。';return entry;}
   try{await native.mkdir(chain.handle,targetName,0o755);}
   catch(error){
    if(error.code==='EEXIST'){entry.outcome='present';entry.reason='appeared-during-copy';entry.detail='复制期间目标已出现'+targetName+'；保留现有内容，丢弃暂存。';return entry;}
    throw error;
   }
   let appeared=['x'];
   try{const probe=await native.openDirectory(chain.handle,targetName);try{appeared=await native.readdir(probe);}finally{await probe.close().catch(()=>{});}}catch{}
   if(appeared.length){entry.outcome='present';entry.reason='appeared-during-copy';entry.detail='复制期间目标目录出现内容；保留现有内容，丢弃暂存。';return entry;}
   try{await native.rename(staging,targetName,chain.handle,targetName);}
   catch(error){
    if(['EEXIST','ENOTEMPTY','ENOTDIR'].includes(error.code)){entry.outcome='present';entry.reason='appeared-during-copy';entry.detail='安装收尾时目标已出现内容；保留现有内容，丢弃暂存。';return entry;}
    throw error;
   }
   entry.outcome='provisioned';entry.files=ctx.files;entry.bytes=ctx.bytes;entry.directories=ctx.directories;
   entry.detail=spec.texts.provisioned();
   if(ctx.skipped.length){entry.skipped=ctx.skipped.slice(0,20);entry.skippedTotal=ctx.skipped.length;entry.detail+=' 跳过'+ctx.skipped.length+'个符号链接环/断链/特殊文件（见skipped）。';}
   return entry;
  }finally{
   await staging?.close().catch(()=>{});
   if(wrapper)await native.removeTree(wrapper.handle,stagingName).catch(()=>{});
   if(wrapper)await native.removeDirectoryIfEmpty(chain.handle,WRAPPER).catch(()=>{});   // 仅空目录可删
  }
 }catch(error){entry.outcome='copy-failed';entry.reason=error.code||'ERROR';entry.detail='拷贝失败，未供给（目标保持原状）：'+error.message;return entry;}
 finally{await wrapper?.handle.close().catch(()=>{});await chain.close().catch(()=>{});}
}

const DEPS_TEXTS={
 workerChanged:gate=>'Worker树的'+gate.file+'与冻结输入不一致（可能已被Worker修改）；不按旧输入安装依赖，现有模块保持不变。可执行方案：由Worker在执行目录按当前manifest自行管理依赖（用户授权的真实工具），或核对更新环境输入后重新准备。',
 sourceMissing:gate=>'源项目缺少'+gate.file+'；无法证明与冻结输入一致，未安装依赖。可选方案：①在执行目录内按冻结package-lock.json用用户授权的真实工具安装；②核对并更新环境输入后重新prepare。',
 sourceDiffers:gate=>'风险：源端'+gate.file+'与冻结输入不一致，错版本拷贝已被拒绝（避免静默不可用或破坏构建）。可选方案：①在执行目录内按冻结package-lock.json用用户授权的真实工具安装（结果保留，不再依赖源拷贝）；②核对并更新环境输入使源与冻结一致后重新prepare。',
 payloadMissing:()=>'风险：执行目录没有可用依赖，构建/测试会失败。宿主不运行npm/网络、不代改源项目。可选方案：①在执行目录内按冻结package-lock.json用用户授权的真实工具安装（安装结果会被保留为现有模块）；②在源项目安装后重新prepare；③核对并更新环境输入。',
 provisioned:()=>'已从源项目独立拷贝node_modules（reflink优先，非符号链接；源端不受Worker写入影响）。'
};
const RESOURCE_TEXTS=tool=>({
 workerChanged:gate=>'Worker树的'+gate.file+'与冻结输入不一致（可能已被Worker修改）；不按旧清单供给资源。可执行方案：在执行目录用用户授权的真实工具按清单重新准备该资源（结果会被保留），或核对更新环境输入后重新prepare。',
 sourceMissing:gate=>'源项目缺少'+gate.file+'；无法证明声明与冻结输入一致，未供给资源。可执行方案：在源项目恢复该清单后重新prepare，或核对并更新环境输入。',
 sourceDiffers:gate=>'风险：源端'+gate.file+'与冻结输入不一致，按旧声明拷贝已被拒绝。可执行方案：在执行目录用用户授权的真实工具准备该资源（结果保留），或核对并更新环境输入后重新prepare。',
 payloadMissing:()=>'风险：执行目录缺少已声明的准备资源'+(tool?'（由'+tool+'准备）':'')+'，构建会在此失败。宿主不运行网络/npm、不代改源项目。可执行方案：①'+(tool?'在源项目运行 node '+tool+' 重新准备，然后重新prepare；':'在源项目用对应工具重新准备，然后重新prepare；')+'②在执行目录用用户授权的真实工具准备该资源（结果会被保留）；③核对并更新环境输入。',
 provisioned:()=>'已按冻结清单从源项目独立拷贝该准备资源（reflink优先，非符号链接；源端不受Worker写入影响）。'
});

// 声明资源入口：仅在固定名 vendor/prepared-resources.json 出现在项目根或任一
// 冻结包目录（与依赖候选同一目录来源：package.json+package-lock.json 成对，
// 不做任意全树扫描）时生效；Worker/源端清单字节都必须等于冻结值。声明内的
// path/tool 相对声明所在包基目录，报告与拷贝目标均为项目全路径。
async function preparedResourceEntries({workId,sourceRoot,worktreeRoot,frozenFiles,filesystem}){
 const files=frozenFiles||{},entries=[];
 const declarations=[{dir:'',rel:PREPARED_RESOURCES_REL}];
 for(const candidate of dependencyCandidates(files))declarations.push({dir:candidate.dir,rel:candidate.dir?candidate.dir+'/'+PREPARED_RESOURCES_REL:PREPARED_RESOURCES_REL});
 for(const declaration of declarations){
  const gate=files[declaration.rel];
  if(!gate)continue;
  const base={kind:'prepared-resource',dir:declaration.dir||'.',resource:declaration.rel};
  const worker=digest(await readBytes(toAbs(worktreeRoot,declaration.rel)));
  if(worker===null||worker!==gate.digest){entries.push({...base,outcome:'worker-file-changed',reason:'metadata',detail:RESOURCE_TEXTS().workerChanged({file:declaration.rel})});continue;}
  const sourceBytes=await readBytes(toAbs(sourceRoot,declaration.rel));
  if(sourceBytes===null){entries.push({...base,outcome:'source-metadata-missing',reason:'metadata',detail:RESOURCE_TEXTS().sourceMissing({file:declaration.rel})});continue;}
  if(digest(sourceBytes)!==gate.digest){entries.push({...base,outcome:'source-metadata-differs',reason:'metadata',detail:RESOURCE_TEXTS().sourceDiffers({file:declaration.rel})});continue;}
  const parsed=parsePreparedResources(sourceBytes.toString('utf8'));
  if(parsed.error){entries.push({...base,outcome:'invalid-metadata',reason:parsed.error,...(parsed.path?{path:parsed.path}:{}),detail:'准备资源清单无效（'+parsed.error+(parsed.path?'：'+parsed.path:'')+'）；未供给任何资源。请修正清单后重新prepare。'});continue;}
  for(const resource of parsed.resources){
   const fullRel=declaration.dir?declaration.dir+'/'+resource.path:resource.path;
   const fullTool=resource.tool?(declaration.dir?declaration.dir+'/'+resource.tool:resource.tool):null;
   if(!validResourcePath(fullRel)){entries.push({...base,resource:fullRel.slice(0,200),outcome:'invalid-metadata',reason:'invalid-path',path:resource.path,detail:'声明资源路径拼接到包基目录后无效：'+fullRel.slice(0,200)+'；未拷贝。'});continue;}
   entries.push(await provisionPayload({workId,sourceRoot,worktreeRoot,frozenFiles:files,filesystem,spec:{
    kind:'prepared-resource',dir:path.posix.dirname(fullRel),targetName:path.posix.basename(fullRel),payloadRel:fullRel,
    gates:[{rel:declaration.rel,label:'metadata',file:declaration.rel}],
    missingCode:'source-resource-missing',trackedGate:true,
    entryExtra:{resource:fullRel,provenance:{declared:declaration.rel,tool:fullTool,...(resource.upstream?{upstream:resource.upstream}:{})}},
    texts:RESOURCE_TEXTS(fullTool)
   }}));
  }
 }
 return entries;
}

// 计算供给报告；与 previous 内容一致时原样返回 previous，保证重启/重复 prepare
// 对清单零扰动。纯计算+文件系统操作，不写清单（由调用方落账）。
export async function provisionWorktreeDependencies({workId,sourceRoot,worktreeRoot,frozenFiles,previous=null},{filesystem=defaultFilesystemAdapter}={}){
 if(filesystem.supported!==true)throw Object.assign(new Error('provisioning requires a verified native safe-open adapter'),{code:'DEPENDENCY_PLATFORM'});
 if(!path.isAbsolute(sourceRoot||'')||!path.isAbsolute(worktreeRoot||''))throw Object.assign(new Error('provisioning requires absolute roots'),{code:'DEPENDENCY_ROOT'});
 const report={version:DEPENDENCIES_VERSION,at:new Date().toISOString(),source:sourceRoot,entries:[]};
 for(const candidate of dependencyCandidates(frozenFiles))
  report.entries.push(await provisionPayload({workId,sourceRoot,worktreeRoot,frozenFiles,filesystem,spec:{
   kind:'dependencies',dir:candidate.dir,targetName:'node_modules',payloadRel:candidate.dir?candidate.dir+'/node_modules':'node_modules',
   gates:[{rel:candidate.manifest,label:'manifest',file:'package.json'},{rel:candidate.lock,label:'lock',file:'package-lock.json'}],
   missingCode:'source-modules-missing',texts:DEPS_TEXTS
  }}));
 report.entries.push(...await preparedResourceEntries({workId,sourceRoot,worktreeRoot,frozenFiles,filesystem}));
 if(previous&&previous.version===report.version&&JSON.stringify(previous.entries)===JSON.stringify(report.entries))return previous;
 return report;
}
