import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {workPath} from './execution-workspace.mjs';

const fail=(code,message)=>{const error=new Error(message);error.code=code;throw error;};
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safePath=(rel,root=false)=>{
 if(root&&rel==='')return '';
 const value=workPath(rel);
 if(value.split('/').some(part=>part.startsWith('.')||/^(?:secrets?|tokens?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|.*\.(?:p12|pfx|keystore))$/i.test(part)))fail('PATH_REJECTED','私有目录或凭据文件不可通过前台文档工具访问。');
 return value;
};

// The callback is host-owned: actor, project and operation identities never come
// from a model's arguments. FileChanges remains the durable receipt authority.
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
 async function listing(args){
  const rel=safePath(args.relPath??'',true),project=await host.requireProject(projectId),abs=await directory(project,rel);
  const offset=args.offset??0,limit=args.limit??200;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>500)fail('INVALID_PAYLOAD','列表分页参数无效。');
  const names=(await fs.readdir(abs,{withFileTypes:true})).filter(entry=>{try{safePath(rel?rel+'/'+entry.name:entry.name);return !entry.isSymbolicLink()&&(entry.isDirectory()||entry.isFile());}catch{return false;}}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  return {relPath:rel,entries:names.slice(offset,offset+limit).map(entry=>({name:entry.name,relPath:rel?rel+'/'+entry.name:entry.name,kind:entry.isDirectory()?'directory':'file'})),hasMore:offset+limit<names.length,nextOffset:offset+limit<names.length?offset+limit:null};
 }
 async function* files(project,rel){
  const abs=await directory(project,rel),entries=await fs.readdir(abs,{withFileTypes:true});entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  for(const entry of entries){const child=rel?rel+'/'+entry.name:entry.name;try{safePath(child);}catch{continue;}if(entry.isSymbolicLink())continue;if(entry.isDirectory())yield* files(project,child);else if(entry.isFile())yield child;}
 }
 async function withSync(relPath,hold,check,work){
  if(typeof sync!=='function')fail('SYNC_UNAVAILABLE','文档编辑现场同步不可用，未读取旧磁盘或覆盖草稿。');
  const release=await sync({projectId,relPath,hold});
  try{const project=await host.requireProject(projectId),parent=path.posix.dirname(relPath);try{await directory(project,parent==='.'?'':parent);}catch(error){if(!hold||error.code!=='ENOENT')throw error;}check();return await work();}finally{release?.();}
 }
 async function search(args,actor,check){
  const rel=safePath(args.relPath??'',true),query=args.query;
  if(typeof query!=='string'||!query.length||query.length>4000)fail('INVALID_PAYLOAD','搜索需要1至4000字符的字面文本。');
  const cursor=args.cursor??null;
  if(cursor&&(!cursor||typeof cursor!=='object'||cursor.scope!==rel||cursor.query!==query||typeof cursor.relPath!=='string'||!Number.isSafeInteger(cursor.offset)||cursor.offset<0))fail('INVALID_PAYLOAD','搜索续页不匹配。');
  if(cursor)safePath(cursor.relPath);
  const project=await host.requireProject(projectId),matches=[],skipped=[];let scanned=0,last=null;
  for await(const file of files(project,rel)){
   if(cursor&&file<cursor.relPath)continue;
   check();let read;
   try{read=await withSync(file,false,check,()=>host.readDocument(projectId,file,actor));}
   catch(error){if(!['UNSUPPORTED','TOO_LARGE'].includes(error.code))throw error;skipped.push({relPath:file,code:error.code});}
   scanned++;last={scope:rel,query,relPath:file,offset:0};
   if(read){let at=read.text.indexOf(query,cursor?.relPath===file?cursor.offset:0);while(at!==-1){matches.push({relPath:file,from:at,to:at+query.length,text:read.text.slice(Math.max(0,at-100),Math.min(read.text.length,at+query.length+100)),version:read.version});const next=at+Math.max(1,query.length);if(matches.length>=100)return {matches,skipped,hasMore:true,cursor:{scope:rel,query,relPath:file,offset:next}};at=read.text.indexOf(query,next);}}
   if(scanned>=300)return {matches,skipped,hasMore:true,cursor:{...last,offset:Number.MAX_SAFE_INTEGER}};
  }
  return {matches,skipped,hasMore:false,cursor:null};
 }
 async function execute({op,arguments:args={},actor,operationId,isActive}){
  let check;
  try{
   checkActor(actor);check=activeCheck(isActive);check();
   if(!args||typeof args!=='object'||Array.isArray(args))fail('INVALID_PAYLOAD','工具参数必须为对象。');
   if(op==='list')return {ok:true,value:await listing(args)};
   if(op==='search')return {ok:true,value:await search(args,actor,check)};
   if(op==='read'){const rel=safePath(args.relPath);return {ok:true,value:await withSync(rel,false,check,()=>host.readDocument(projectId,rel,actor))};}
   if(!['apply','create'].includes(op))fail('INVALID_PAYLOAD','未知文档操作。');
   if(typeof operationId!=='string'||!/^\w{64}$/.test(operationId)||!/^[a-f0-9]+$/.test(operationId))fail('INVALID_PAYLOAD','缺少宿主操作标识。');
   const requestFingerprint=fingerprint({op,arguments:args});
   const read=op==='apply'?host.documentReads.get(args.readHandle):null;
   const receiptPath=op==='create'?safePath(args.relPath):read?.projectId===projectId?safePath(read.relPath):null;
   const prior=await host.frontdeskReceipt(projectId,actor,operationId,requestFingerprint,receiptPath);if(prior)return {ok:true,value:prior};
   if(op==='apply'&&(!read||read.projectId!==projectId||read.actorId!==actor.id||read.sessionId!==actor.sessionId||read.sessionInstance!==actor.sessionInstance))fail('READ_HANDLE_REJECTED','请在当前前台会话重新读取。');
   const rel=safePath(op==='create'?args.relPath:read.relPath);
   const value=await withSync(rel,true,check,()=>op==='create'?host.createDocument(projectId,actor,{relPath:rel,text:args.text,operationId,requestFingerprint},{beforeApply:check}):host.applyDocument(projectId,actor,{readHandle:args.readHandle,edits:args.edits,contexts:args.contexts??[],operationId,requestFingerprint},{beforeApply:check}));
   return {ok:true,value:{...value,relPath:rel,operationId,actor}};
  }catch(error){return {ok:false,error:{code:error.code||'DOCUMENT_FAILED',message:error.message,details:error.details||{}}};}
 }
 return operation=>{
  // Concurrent retries share one host effect. Mismatched operation payloads are
  // still checked by the host's durable receipt after the first flight settles.
  const key=['apply','create'].includes(operation.op)?operation.operationId:null;
  if(!key)return execute(operation);
  const previous=flights.get(key),run=(previous||Promise.resolve()).then(()=>execute(operation));flights.set(key,run);run.finally(()=>{if(flights.get(key)===run)flights.delete(key);});return run;
 };
}
