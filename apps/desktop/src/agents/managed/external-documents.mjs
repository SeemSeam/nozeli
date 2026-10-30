import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {resolveTextReplacements} from '../../domain/document-collaboration.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const identity=stat=>`${stat.dev}:${stat.ino}`;
const MAX_BYTES=16*1024*1024;
const destinationFlights=new Map();
async function locked(key,run){
 const previous=destinationFlights.get(key)??Promise.resolve();
 const next=previous.catch(()=>{}).then(run);destinationFlights.set(key,next);
 try{return await next;}finally{if(destinationFlights.get(key)===next)destinationFlights.delete(key);}
}
const unchanged=(a,b)=>identity(a)===identity(b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
async function canonicalDestination(filename){
 try{return await fs.realpath(filename);}catch(error){if(error.code!=='ENOENT')throw error;return path.join(await fs.realpath(path.dirname(filename)),path.basename(filename));}
}
// External files have no project metadata. Handles and receipts belong to the
// source instance, never to a newly registered or modified target directory.
export function createExternalDocuments({storage,projectId}){
 const handles=new Map();
 const check=input=>{if(typeof input.isActive!=='function'||!input.isActive())fail('WORK_STOPPED','来源请求已停止。');};
 const owner=actor=>JSON.stringify([actor?.id,actor?.sessionId,actor?.sessionInstance]);
 const protectedWrite=filename=>{const parts=filename.split(path.sep);if(parts.includes('.git')||parts.includes('.nozeli'))fail('PATH_REJECTED','系统元数据不能作为普通文档写入。');};
 async function locate(root,rel){
  if(typeof rel!=='string'||rel.includes('\0'))fail('INVALID_PAYLOAD','需要文件路径。');
  const absolute=path.isAbsolute(rel)?path.normalize(rel):path.resolve(root,rel);
  return {absolute,relPath:path.relative(root,absolute).split(path.sep).join('/')};
 }
 async function readFile(filename){
  const real=await fs.realpath(filename),handle=await fs.open(real,constants.O_RDONLY|(constants.O_NONBLOCK??0));
  try{
   const stat=await handle.stat({bigint:true});
   if(!stat.isFile())fail('UNSUPPORTED','不是普通文件。');
   if(stat.size>BigInt(MAX_BYTES))fail('TOO_LARGE','文本超过读取上限。');
   const bytes=Buffer.alloc(Number(stat.size));let offset=0;
   while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)fail('STALE_DOCUMENT','读取期间文件已变化。');offset+=result.bytesRead;}
   const extra=Buffer.alloc(1);if((await handle.read(extra,0,1,offset)).bytesRead)fail('STALE_DOCUMENT','读取期间文件已增长。');
   const after=await handle.stat({bigint:true}),named=await fs.stat(filename,{bigint:true});
   if(!unchanged(stat,after)||!unchanged(after,named)||await fs.realpath(filename)!==real)fail('STALE_DOCUMENT','读取期间文件或路径身份已变化。');
   if(bytes.includes(0))fail('UNSUPPORTED','不是 UTF-8 文本。');
   const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
   return {real,identity:identity(stat),bytes,text,digest:digest(bytes),mode:Number(stat.mode&0o777n)};
  }finally{await handle.close();}
 }
 async function run(input){
  const {op,arguments:args={},actor,operationId}=input;
  try{
   check(input);if(!actor?.id||!actor.sessionId||!actor.sessionInstance)fail('ACTOR_REJECTED','缺少宿主来源身份。');
   const bound=op==='apply'?handles.get(args.readHandle):null;
   const rootPath=bound?.rootPath??(input.targetRoot?path.resolve(input.targetRoot):null);
   const prior=['apply','create'].includes(op)&&operationId&&storage?.getLocal?await storage.getLocal(projectId,'managed:external-document:'+operationId):null;
   if(prior){
    if(input.targetRoot&&await fs.realpath(input.targetRoot)!==prior.root)fail('OPERATION_COLLISION','操作目标目录不符。');
    if(bound&&bound.real!==prior.path)fail('OPERATION_COLLISION','操作目标文件不符。');
    if(args.relPath!==undefined){const requested=await locate(prior.root,args.relPath);if(await canonicalDestination(requested.absolute)!==prior.path)fail('OPERATION_COLLISION','操作目标文件不符。');}
    const expected=digest(JSON.stringify({op,args,owner:owner(actor),root:prior.root,destination:prior.path}));
    if(prior.fingerprint!==expected)fail('OPERATION_COLLISION','操作身份与内容不符。');
    if(prior.status==='completed')return {ok:true,value:{...prior.value,duplicate:true}};
    fail('EFFECT_RESULT_UNKNOWN','上次写入结果未知，不自动重放。');
   }
   if(!rootPath)fail('INVALID_PAYLOAD','缺少目标目录。');
   const root=await fs.realpath(rootPath),rootIdentity=identity(await fs.stat(root));
   if(bound&&(root!==bound.root||rootIdentity!==bound.rootIdentity))fail('STALE_DOCUMENT','目标目录身份已变化。');
   if(bound&&input.targetRoot&&await fs.realpath(input.targetRoot)!==bound.root)fail('READ_HANDLE_REJECTED','目标目录与读取句柄不符。');
   const location=await locate(root,op==='apply'?bound?.absolute??args.relPath:args.relPath??'');
   if(op==='read'){
    const file=await readFile(location.absolute),readHandle=randomUUID();check(input);
    handles.set(readHandle,{...file,...location,root,rootPath,rootIdentity,owner:owner(actor)});
    return {ok:true,value:{text:file.text,readHandle,version:file.digest,digest:file.digest,relPath:location.relPath}};
   }
   if(op==='list'){
    const offset=args.offset??0,limit=args.limit??200;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>500)fail('INVALID_PAYLOAD','分页无效。');
    const names=(await fs.readdir(location.absolute,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    const entries=[];for(const entry of names.slice(offset,offset+limit)){let stat;try{stat=await fs.stat(path.join(location.absolute,entry.name));}catch{continue;}entries.push({name:entry.name,relPath:path.posix.join(location.relPath,entry.name),kind:stat.isDirectory()?'directory':'file'});}
    return {ok:true,value:{relPath:location.relPath,entries,hasMore:offset+limit<names.length,nextOffset:offset+limit<names.length?offset+limit:null}};
   }
   if(op==='search'){
    if(typeof args.query!=='string'||!args.query||args.query.length>4000)fail('INVALID_PAYLOAD','需要字面搜索文本。');
    const cursor=args.cursor??null,scope=location.relPath;if(cursor&&(cursor.scope!==scope||cursor.query!==args.query||!Number.isSafeInteger(cursor.offset)||cursor.offset<0))fail('INVALID_PAYLOAD','搜索 cursor 不符。');
    const files=[],seen=new Set();async function visit(dir){const real=await fs.realpath(dir);if(seen.has(real))return;seen.add(real);for(const item of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){check(input);const filename=path.join(dir,item.name);if(item.isDirectory())await visit(filename);else if(item.isFile()||item.isSymbolicLink())files.push(filename);}}await visit(location.absolute);
    const matches=[],skipped=[];let scanned=0;for(const filename of files){const relPath=path.relative(root,filename).split(path.sep).join('/');if(cursor&&relPath<cursor.relPath)continue;let file;try{file=await readFile(filename);}catch(error){skipped.push({relPath,code:error.code??'UNSUPPORTED'});continue;}let at=file.text.indexOf(args.query,cursor?.relPath===relPath?cursor.offset:0);while(at!==-1){matches.push({relPath,from:at,to:at+args.query.length,text:file.text.slice(Math.max(0,at-100),at+args.query.length+100),version:file.digest});const next=at+args.query.length;if(matches.length>=100)return {ok:true,value:{matches,skipped,hasMore:true,cursor:{scope,query:args.query,relPath,offset:next}}};at=file.text.indexOf(args.query,next);}if(++scanned>=300)return {ok:true,value:{matches,skipped,hasMore:true,cursor:{scope,query:args.query,relPath,offset:Number.MAX_SAFE_INTEGER}}};}
    return {ok:true,value:{matches,skipped,hasMore:false,cursor:null}};
   }
   if(!['apply','create'].includes(op)||typeof operationId!=='string'||!operationId)fail('INVALID_PAYLOAD','缺少写入操作身份。');
   if(!storage?.getLocal||!storage?.putLocal)fail('STORAGE_UNAVAILABLE','本地操作回执不可用。');
   let before=null,text=args.text;
   if(op==='apply'){
    if(!bound||bound.owner!==owner(actor))fail('READ_HANDLE_REJECTED','请在当前会话重新读取。');
    before=await readFile(bound.absolute);if(before.real!==bound.real||before.identity!==bound.identity||before.digest!==bound.digest)fail('STALE_DOCUMENT','磁盘或路径已变化，请重新读取。');
    const {edits}=resolveTextReplacements(bound.text,args.replacements);text=bound.text;for(const edit of [...edits].sort((a,b)=>b.from-a.from))text=text.slice(0,edit.from)+edit.insert+text.slice(edit.to);
   }
   if(typeof text!=='string'||Buffer.byteLength(text)>16*1024*1024)fail('INVALID_PAYLOAD','需要有效文本。');
   const destination=before?.real??await canonicalDestination(location.absolute);protectedWrite(destination);protectedWrite(location.absolute);check(input);
   if(input.lockedDestination!==destination)fail('STALE_DOCUMENT','等待写入期间目标路径已变化。');
   const key='managed:external-document:'+operationId,fingerprint=digest(JSON.stringify({op,args,owner:owner(actor),root,destination}));
   const parent=await fs.realpath(path.dirname(destination)),parentStat=await fs.stat(parent);
   const aliasParent=await fs.realpath(path.dirname(location.absolute)),aliasParentIdentity=identity(await fs.stat(path.dirname(location.absolute)));
   const recheck=async()=>{
    check(input);
    if(await fs.realpath(rootPath)!==root||identity(await fs.stat(rootPath))!==rootIdentity||identity(await fs.stat(parent))!==identity(parentStat)||await fs.realpath(path.dirname(location.absolute))!==aliasParent||identity(await fs.stat(path.dirname(location.absolute)))!==aliasParentIdentity)fail('STALE_DOCUMENT','目录或路径身份已变化。');
    if(before){const current=await readFile(location.absolute);if(current.real!==before.real||current.identity!==before.identity||current.digest!==before.digest)fail('STALE_DOCUMENT','文件已变化。');}
    else if(await canonicalDestination(location.absolute)!==destination)fail('STALE_DOCUMENT','目标路径已变化。');
   };
   if(op==='create'){try{await fs.lstat(destination);fail('FILE_EXISTS','文件已存在。');}catch(error){if(error.code!=='ENOENT')throw error;}}
   const value={relPath:location.relPath,operationId,digest:digest(text),version:digest(text),beforeDigest:before?.digest??null,actor};
   const receipt={fingerprint,root,path:destination};
   await storage.putLocal(projectId,key,{...receipt,status:'started'});
   let temp=null;
   try{
    temp=path.join(parent,'.nozeli-write-'+randomUUID());
    const temporary=await fs.open(temp,'wx',before?.mode??0o600);
    try{await temporary.writeFile(text);await temporary.sync();}finally{await temporary.close();}
    await recheck();
    if(before){await fs.rename(temp,destination);temp=null;}
    else{await fs.link(temp,destination);await fs.unlink(temp);temp=null;}
    const directory=await fs.open(parent,constants.O_RDONLY|(constants.O_DIRECTORY??0));
    try{await directory.sync();}finally{await directory.close();}
    await storage.putLocal(projectId,key,{...receipt,status:'completed',value});return {ok:true,value};
   }finally{if(temp)await fs.unlink(temp).catch(()=>{});}
  }catch(error){return {ok:false,error:{code:error.code??'DOCUMENT_FAILED',message:error.message}};}
 }
 const operation=async input=>{
  if(!['apply','create'].includes(input.op))return run(input);
  try{return await locked('operation:'+projectId+':'+input.operationId,async()=>{
   const bound=input.op==='apply'?handles.get(input.arguments?.readHandle):null;
   const prior=input.operationId&&storage?.getLocal?await storage.getLocal(projectId,'managed:external-document:'+input.operationId):null;
   let destination=bound?.real??prior?.path;
   if(!destination){const root=await fs.realpath(input.targetRoot),location=await locate(root,input.arguments?.relPath);destination=await canonicalDestination(location.absolute);}
   return locked('destination:'+destination,()=>run({...input,lockedDestination:destination}));
  });}catch(error){return {ok:false,error:{code:error.code??'DOCUMENT_FAILED',message:error.message}};}
 };
 operation.peek=(op,args)=>{const read=op==='apply'?handles.get(args?.readHandle):null;return read?{external:true,root:read.root,relPath:read.relPath}:null;};
 return operation;
}
