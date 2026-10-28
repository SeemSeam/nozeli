import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {workPath} from './execution-workspace.mjs';


const fail=(code,message,details)=>{const error=new Error(message);error.code=code;if(details)error.details=details;throw error;};
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safePath=(rel,root=false)=>{
 if(root&&rel==='')return '';
 const value=workPath(rel);
 if(value.split('/').some(part=>part.startsWith('.')||/^(?:secrets?|tokens?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|.*\.(?:p12|pfx|keystore))$/i.test(part)))fail('PATH_REJECTED','私有目录或凭据文件不可通过前台文档工具访问。');
 return value;
};

// The callback is host-owned: actor, project and operation identities never come
// from a model's arguments. FileChanges remains the durable receipt authority.
// Cross-project operations carry a host-resolved targetProjectId plus the exact
// task-bound grant that authorized them; the model never supplies either. The
// same safePath/credential exclusions apply on the target project, and the
// actor stays the source session identity so target receipts stay attributable.
export function createFrontdeskDocuments({host,projectId,sync}) {
 const flights=new Map();
 const checkActor=actor=>{
  if(!actor||!actor.id?.startsWith('nozeli:frontdesk:')||actor.kind!=='agent1'||actor.role!=='frontdesk'||actor.mark!=='F'||!actor.sessionId||!actor.sessionInstance||!actor.requestId||actor.sourceJobId!==actor.requestId)fail('ACTOR_REJECTED','需要宿主绑定的前台来源身份。');
 };
 const activeCheck=isActive=>()=>{if(typeof isActive!=='function'||!isActive())fail('WORK_STOPPED','前台请求已停止，未继续写入。');};
 async function directory(project,rel){
  let abs=project.root;
  for(const part of rel?rel.split('/'):[]){abs=path.join(abs,part);const stat=await fs.lstat(abs);if(stat.isSymbolicLink()||!stat.isDirectory())fail('PATH_REJECTED','目录不可为链接。');}
  if(await fs.realpath(abs)!==abs)fail('PATH_REJECTED','目录身份已变化。');
  return abs;
 }
 async function listing(args,effective,verifyIo){
  const rel=safePath(args.relPath??'',true),project=await host.requireProject(effective),abs=await directory(project,rel);
  if(verifyIo)await verifyIo();
  const offset=args.offset??0,limit=args.limit??200;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>500)fail('INVALID_PAYLOAD','列表分页参数无效。');
  const names=(await fs.readdir(abs,{withFileTypes:true})).filter(entry=>{try{safePath(rel?rel+'/'+entry.name:entry.name);return !entry.isSymbolicLink()&&(entry.isDirectory()||entry.isFile());}catch{return false;}}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  return {relPath:rel,entries:names.slice(offset,offset+limit).map(entry=>({name:entry.name,relPath:rel?rel+'/'+entry.name:entry.name,kind:entry.isDirectory()?'directory':'file'})),hasMore:offset+limit<names.length,nextOffset:offset+limit<names.length?offset+limit:null};
 }
 async function* files(project,rel){
  const abs=await directory(project,rel),entries=await fs.readdir(abs,{withFileTypes:true});entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  for(const entry of entries){const child=rel?rel+'/'+entry.name:entry.name;try{safePath(child);}catch{continue;}if(entry.isSymbolicLink())continue;if(entry.isDirectory())yield* files(project,child);else if(entry.isFile())yield child;}
 }
 async function withSync(relPath,hold,check,work,effective){
  if(typeof sync!=='function')fail('SYNC_UNAVAILABLE','文档编辑现场同步不可用，未读取旧磁盘或覆盖草稿。');
  const release=await sync({projectId:effective,relPath,hold});
  try{const project=await host.requireProject(effective),parent=path.posix.dirname(relPath);try{await directory(project,parent==='.'?'':parent);}catch(error){if(!hold||error.code!=='ENOENT')throw error;}check();return await work();}finally{release?.();}
 }
 async function search(args,actor,check,effective,verifyIo){
  const rel=safePath(args.relPath??'',true),query=args.query;
  if(typeof query!=='string'||!query.length||query.length>4000)fail('INVALID_PAYLOAD','搜索需要1至4000字符的字面文本。');
  const cursor=args.cursor===undefined||args.cursor===null?null:args.cursor;
  if(cursor!==null){
   const problems=[];
   if(!cursor||typeof cursor!=='object'||Array.isArray(cursor))problems.push('cursor必须是上次搜索返回的原样对象');
   else{
    if(Object.keys(cursor).length!==4||!['scope','query','relPath','offset'].every(key=>key in cursor))problems.push('cursor字段必须恰为scope/query/relPath/offset');
    if(cursor.scope!==rel)problems.push(`scope应为本次relPath参数“${rel===''?'(空字符串=根目录)':rel}”，实际为${JSON.stringify(cursor.scope===undefined?null:cursor.scope)}`);
    if(cursor.query!==query)problems.push(`query应为本次查询${JSON.stringify(query.slice(0,60))}`);
    if(typeof cursor.relPath!=='string')problems.push('relPath必须是字符串');
    if(!Number.isSafeInteger(cursor.offset)||cursor.offset<0)problems.push('offset必须是非负整数');
   }
   if(problems.length)fail('INVALID_PAYLOAD','搜索cursor无效：'+problems.join('；')+'。首次搜索必须完全省略cursor（或传null）；续页只能把上次结果返回的cursor对象原样传回，不能自造或复用其他查询/范围的cursor。',{problems,expectedScope:rel,query});
  }
  if(cursor)safePath(cursor.relPath);
  const project=await host.requireProject(effective),matches=[],skipped=[];let scanned=0,last=null;
  await directory(project,rel);if(verifyIo)await verifyIo();
  for await(const file of files(project,rel)){
   if(cursor&&file<cursor.relPath)continue;
   check();let read;
   try{read=await withSync(file,false,check,async()=>{if(verifyIo)await verifyIo();return host.readDocument(effective,file,actor);},effective);}
   catch(error){if(!['UNSUPPORTED','TOO_LARGE'].includes(error.code))throw error;skipped.push({relPath:file,code:error.code});}
   scanned++;last={scope:rel,query,relPath:file,offset:0};
   if(read){let at=read.text.indexOf(query,cursor?.relPath===file?cursor.offset:0);while(at!==-1){matches.push({relPath:file,from:at,to:at+query.length,text:read.text.slice(Math.max(0,at-100),Math.min(read.text.length,at+query.length+100)),version:read.version});const next=at+Math.max(1,query.length);if(matches.length>=100)return {matches,skipped,hasMore:true,cursor:{scope:rel,query,relPath:file,offset:next}};at=read.text.indexOf(query,next);}}
   if(scanned>=300)return {matches,skipped,hasMore:true,cursor:{...last,offset:Number.MAX_SAFE_INTEGER}};
  }
  return {matches,skipped,hasMore:false,cursor:null};
 }
 async function execute({op,arguments:args={},actor,operationId,isActive,targetProjectId}){
  let check;
  try{
   checkActor(actor);check=activeCheck(isActive);check();
   if(!args||typeof args!=='object'||Array.isArray(args))fail('INVALID_PAYLOAD','工具参数必须为对象。');
   // Host authority only: apply targets come from the read handle's project;
   // other ops use the host-resolved targetProjectId. args.projectPath is
   // never trusted here. Ordinary cross-project access needs no extra grant —
   // but registered-target resolution, actor binding, receipts, safePath and
   // credential exclusions always apply on the target project.
   const opBinding=['apply','create'].includes(op)&&typeof operationId==='string'?['managed:frontdesk-op-target',projectId,operationId].join(':'):null;
   const readHandle=op==='apply'?host.documentReads.get(args.readHandle):null;
   let binding=null;
   if(opBinding&&host.storage?.getLocal){try{binding=await host.storage.getLocal(projectId,opBinding)??null;}catch{binding=null;}}
   let effective=op==='apply'?(readHandle?.projectId??binding?.projectId??projectId):(typeof targetProjectId==='string'&&targetProjectId?targetProjectId:binding?.projectId??projectId);
   // Receipt-only replay: the live handle is gone but the durable operation
   // binding points at the target that actually executed. Resolve the stored
   // receipt (actor + fingerprint checked by the host) — recovery is never
   // permission to execute another write.
   if(opBinding&&binding?.projectId&&binding.projectId!==projectId&&effective===binding.projectId&&(op==='apply'?!readHandle:!targetProjectId)){
    const replay=await host.frontdeskReceipt(binding.projectId,actor,operationId,fingerprint({op,arguments:args}),binding.relPath??null);
    if(replay)return {ok:true,value:replay};
    if(op==='apply'&&!readHandle)fail('READ_HANDLE_REJECTED','请在当前前台会话重新读取。');
   }
   if(op==='list')return {ok:true,value:await listing(args,effective)};
   if(op==='search')return {ok:true,value:await search(args,actor,check,effective)};
   if(op==='read'){const rel=safePath(args.relPath);return {ok:true,value:await withSync(rel,false,check,async()=>host.readDocument(effective,rel,actor),effective)};}
   if(!['apply','create'].includes(op))fail('INVALID_PAYLOAD','未知文档操作。');
   if(typeof operationId!=='string'||!/^\w{64}$/.test(operationId)||!/^[a-f0-9]+$/.test(operationId))fail('INVALID_PAYLOAD','缺少宿主操作标识。');
   const requestFingerprint=fingerprint({op,arguments:args});
   const read=op==='apply'?host.documentReads.get(args.readHandle):null;
   const receiptPath=op==='create'?safePath(args.relPath):read?.projectId===effective?safePath(read.relPath):binding?.projectId===effective?binding.relPath:null;
   const prior=await host.frontdeskReceipt(effective,actor,operationId,requestFingerprint,receiptPath);if(prior)return {ok:true,value:prior};
  if(op==='apply'&&(!read||read.projectId!==effective||read.actorId!==actor.id||read.sessionId!==actor.sessionId||read.sessionInstance!==actor.sessionInstance))fail('READ_HANDLE_REJECTED','请在当前前台会话重新读取。');
  if(op==='apply'&&args.replacements===undefined)fail('INVALID_PAYLOAD','apply必须提供replacements（1至1000项{oldText,newText,contextBefore?,contextAfter?}精确文本替换）；UTF-16偏移edits已停用，匹配位置由宿主按readHandle读取文本计算。',{reason:'legacy-edits'});
  const rel=safePath(op==='create'?args.relPath:read.relPath);
  const value=await withSync(rel,true,check,async()=>{
    // Durable operation→target binding, persisted BEFORE execution and
    // fail-closed: if the binding cannot be stored, the cross-project write
    // does not happen.
    if(opBinding&&effective!==projectId){
      if(!host.storage?.putLocal)fail('STORAGE_UNAVAILABLE','跨项目写入需要持久化操作目标绑定，存储不可用，未执行。');
      try{await host.storage.putLocal(projectId,opBinding,{projectId:effective,relPath:rel,at:new Date().toISOString()});}
      catch(error){fail('STORAGE_UNAVAILABLE','跨项目写入的目标绑定未能持久化，未执行：'+error.message);}
    }
    return op==='create'?host.createDocument(effective,actor,{relPath:rel,text:args.text,operationId,requestFingerprint},{beforeApply:check}):host.applyDocument(effective,actor,{readHandle:args.readHandle,replacements:args.replacements,operationId,requestFingerprint},{beforeApply:check});
  },effective);
   return {ok:true,value:{...value,relPath:rel,operationId,actor}};
  }catch(error){return {ok:false,error:{code:error.code||'DOCUMENT_FAILED',message:error.message,details:error.details||{}}};}
 }
 const operation=op=>{
  // Concurrent retries share one host effect. Mismatched operation payloads are
  // still checked by the host's durable receipt after the first flight settles.
  const key=['apply','create'].includes(op.op)?op.operationId:null;
  if(!key)return execute(op);
  const previous=flights.get(key),run=(previous||Promise.resolve()).then(()=>execute(op));flights.set(key,run);run.finally(()=>{if(flights.get(key)===run)flights.delete(key);});return run;
 };
 // Read-only peek for the controller gate: which registered project (and exact
 // path) an apply readHandle belongs to. Exposes nothing else.
 operation.peek=(op,args)=>op==='apply'&&host.documentReads.get(args?.readHandle)?{projectId:host.documentReads.get(args.readHandle).projectId,relPath:host.documentReads.get(args.readHandle).relPath}:null;
 return operation;
}
