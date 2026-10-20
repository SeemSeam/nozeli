import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {HostError} from '../main/host.mjs';

const REPORT_LIMIT=8*1024*1024,STATE_LIMIT=32*1024*1024;
const fail=(code,message)=>new HostError(code,message+'，未另存。');
const unavailable=()=>fail('REPORT_UNAVAILABLE','报告来源缺失、过大或不是安全的普通文件');
const invalid=()=>fail('REPORT_INVALID','历史报告快照损坏或不属于当前项目');
const changed=()=>fail('REPORT_CHANGED','报告来源或历史快照已变化');

// Check every ancestor, not just the final file. No mkdir, repair, Workspace
// open, binding/provider lookup, or unbounded read is permitted on this path.
async function directories(dir) {
  const chain=[];
  for(let current=path.resolve(dir);;current=path.dirname(current)) {
    chain.push(current);if(path.dirname(current)===current)break;
  }
  for(const current of chain.reverse()) {
    const stat=await fs.lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw unavailable();
  }
}
function same(a,b) {
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
}
async function readRegular(file,limit) {
  let handle;
  try {
    await directories(path.dirname(file));
    const entry=await fs.lstat(file,{bigint:true});
    if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1n||entry.size>BigInt(limit))throw unavailable();
    handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
    const before=await handle.stat({bigint:true});
    if(!before.isFile()||!same(entry,before)||before.nlink!==1n)throw unavailable();
    const buffer=Buffer.alloc(Number(before.size)+1);
    let count=0;
    while(count<buffer.length) {
      const {bytesRead}=await handle.read(buffer,count,buffer.length-count,count);
      if(!bytesRead)break;count+=bytesRead;
    }
    const after=await handle.stat({bigint:true});
    await directories(path.dirname(file));
    const current=await fs.lstat(file,{bigint:true});
    if(count!==Number(before.size)||!same(before,after)||!same(after,current)||current.nlink!==1n)throw changed();
    return buffer.subarray(0,count);
  } catch(error) {
    if(error instanceof HostError)throw error;
    throw unavailable();
  } finally {await handle?.close();}
}
function receiptFor(state,project,objectId) {
  if(!state||state.schema!==2||state.contentRoot!==project.root||
     !Array.isArray(state.works)||!Array.isArray(state.todos)||!Array.isArray(state.receipts)||
     !Array.isArray(state.memoryPending)||!Number.isInteger(state.limit)||state.limit<1||
     typeof state.workspaceId!=='string')throw invalid();
  const rows=state.receipts.filter(row=>row?.objectId===objectId);
  if(!rows.length)throw fail('REPORT_MISSING','当前项目没有这份历史报告');
  if(rows.length!==1)throw invalid();
  const row=rows[0],works=state.works.filter(work=>work?.id===row.workId);
  if(works.length!==1||!Number.isInteger(works[0].revision)||!Number.isInteger(row.revision)||row.revision<1||row.revision>works[0].revision||
     typeof row.id!=='string'||!['result','problem'].includes(row.kind)||typeof row.text!=='string'||Buffer.byteLength(row.text)>REPORT_LIMIT)throw invalid();
  if(row.snapshot?.reportDigest&&row.snapshot.reportDigest!==createHash('sha256').update(row.text).digest('hex'))throw invalid();
  return row;
}

// The source is a capability with a revalidated read, never renderer paths/text.
// A controller in the map is authoritative even while starting or stopping.
export async function managedReportSource({project,runtime,objectId,controller,currentController=()=>controller}) {
  let snapshot,offlineState;
  if(!controller) {
    snapshot=await readRegular(path.join(runtime,'state.json'),STATE_LIMIT);
    try{offlineState=JSON.parse(snapshot.toString('utf8'));}catch{throw invalid();}
  }
  const state=()=>controller?controller.store?.state:offlineState;
  const checkRoot=()=>{
    if(controller&&(typeof controller.store?.root!=='string'||path.resolve(controller.store.root)!==path.resolve(runtime)))throw invalid();
  };
  checkRoot();
  const receipt=receiptFor(state(),project,objectId),text=receipt.text;
  const identity=row=>JSON.stringify([row.id,row.workId,row.revision,row.kind,row.text]);
  const frozenIdentity=identity(receipt);
  return {mode:controller?'active':'offline',objectId,read:async()=>{
    if(currentController()!==controller)throw changed();
    if(!controller) {
      const current=await readRegular(path.join(runtime,'state.json'),STATE_LIMIT);
      if(!current.equals(snapshot))throw changed();
    }
    checkRoot();
    if(identity(receiptFor(state(),project,objectId))!==frozenIdentity)throw changed();
    const bytes=await readRegular(path.join(runtime,'objects',objectId+'.md'),REPORT_LIMIT);
    if(!bytes.equals(Buffer.from(text,'utf8'))||currentController()!==controller)throw changed();
    return bytes;
  }};
}

const OBJECT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const payloadError=()=>new HostError('INVALID_PAYLOAD','历史报告查询参数无效。');

// Missing runtime is empty history, but a present runtime with missing/bad
// state is an error. Inspect existing ancestors even when the leaf is absent.
async function runtimeExists(runtime) {
  let exists=true;
  for(let current=path.resolve(runtime);;current=path.dirname(current)) {
    try {
      const stat=await fs.lstat(current);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw unavailable();
    } catch(error) {
      if(error.code!=='ENOENT')throw error;
      exists=false;
    }
    if(path.dirname(current)===current)break;
  }
  return exists;
}

async function historySnapshot({project,runtime,controller,currentController}) {
  let bytes,state;
  if(controller) {
    if(typeof controller.store?.root!=='string'||path.resolve(controller.store.root)!==path.resolve(runtime))throw invalid();
    try {bytes=Buffer.from(JSON.stringify(controller.store.state));}catch{throw invalid();}
    if(bytes.length>STATE_LIMIT)throw unavailable();
  } else {
    if(!await runtimeExists(runtime)) {
      if(currentController()!==controller)throw changed();
      return {state:null,version:createHash('sha256').update(project.root+'\0absent').digest('hex')};
    }
    bytes=await readRegular(path.join(runtime,'state.json'),STATE_LIMIT);
  }
  try {state=JSON.parse(bytes.toString('utf8'));}catch{throw invalid();}
  if(!state||state.schema!==2||state.contentRoot!==project.root||
     !Array.isArray(state.works)||!Array.isArray(state.todos)||!Array.isArray(state.receipts)||
     !Array.isArray(state.memoryPending)||!Number.isInteger(state.limit)||state.limit<1||typeof state.workspaceId!=='string')throw invalid();
  const works=new Map(),objects=new Set(),receipts=new Set();
  for(const work of state.works) {
    if(!work||typeof work.id!=='string'||!OBJECT_ID.test(work.id)||works.has(work.id)||!Number.isInteger(work.revision)||work.revision<0||typeof work.status!=='string')throw invalid();
    works.set(work.id,work);
  }
  for(const row of state.receipts) {
    const work=works.get(row?.workId);
    if(!row||typeof row.objectId!=='string'||!OBJECT_ID.test(row.objectId)||objects.has(row.objectId)||typeof row.id!=='string'||receipts.has(row.id)||
       !work||!Number.isInteger(row.revision)||row.revision<1||row.revision>work.revision||
       !['result','problem'].includes(row.kind)||typeof row.text!=='string'||Buffer.byteLength(row.text)>REPORT_LIMIT||
       typeof row.at!=='string'||row.at.length>64||!Number.isFinite(Date.parse(row.at)))throw invalid();
    if(row.snapshot?.reportDigest&&row.snapshot.reportDigest!==createHash('sha256').update(row.text).digest('hex'))throw invalid();
    objects.add(row.objectId);receipts.add(row.id);
  }
  if(currentController()!==controller)throw changed();
  return {state,works,version:createHash('sha256').update(controller?'active\0':'offline\0').update(bytes).digest('hex')};
}

// Serializable, metadata-only pages. A version is mandatory beyond page one;
// any state change requires a reload, never a silent splice of snapshots.
export async function managedHistory(options,{objectId,version,offset=0,limit=50}={}) {
  if(version!==undefined&&!(typeof version==='string'&&/^[a-f0-9]{64}$/.test(version)))throw payloadError();
  if(objectId!==undefined&&!OBJECT_ID.test(objectId))throw payloadError();
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100||offset>0&&!version)throw payloadError();
  const snapshot=await historySnapshot(options);
  if(version!==undefined&&version!==snapshot.version)throw changed();
  const mode=options.controller?'active':'offline';
  if(objectId!==undefined) {
    if(!snapshot.state)throw fail('REPORT_MISSING','当前项目没有这份历史报告');
    const source=await managedReportSource({...options,objectId});
    const bytes=await source.read();
    if((await historySnapshot(options)).version!==snapshot.version)throw changed();
    return {projectId:options.project.id,objectId,mode,version:snapshot.version,text:bytes.toString('utf8'),byteLength:bytes.length,objectVerified:true};
  }
  const rows=[...(snapshot.state?.receipts||[])].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||(a.objectId<b.objectId?-1:a.objectId>b.objectId?1:0));
  if(offset>rows.length)throw payloadError();
  const items=rows.slice(offset,offset+limit).map(row=>{
    const work=snapshot.works.get(row.workId);
    return {objectId:row.objectId,workId:row.workId,workName:typeof work.name==='string'?work.name.slice(0,110):'工作',revision:row.revision,kind:row.kind,at:row.at,workStatus:work.status.slice(0,64),excerpt:row.text.slice(0,512),objectVerified:false};
  });
  return {projectId:options.project.id,mode,version:snapshot.version,offset,limit,total:rows.length,nextOffset:offset+items.length<rows.length?offset+items.length:null,items};
}

// Immutable artifact bytes share report provenance, bounded no-follow reads and
// state CAS with history. Renderer paths never choose a filesystem root.
export async function managedArtifact(options,{objectId,relPath}={}) {
  if(typeof objectId!=='string'||!OBJECT_ID.test(objectId))throw payloadError();
  const snapshot=await historySnapshot(options);if(!snapshot.state)throw fail('REPORT_MISSING','当前项目没有这份历史报告');
  const receipt=receiptFor(snapshot.state,options.project,objectId),files=receipt.snapshot?.files||[],seen=new Set();
  const safePath=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!value.includes('\\')&&!path.posix.isAbsolute(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..');
  if(!Array.isArray(files))throw invalid();
  for(const file of files){if(!file||!safePath(file.relPath)||seen.has(file.relPath)||typeof file.digest!=='string'||!/^[a-f0-9]{64}$/.test(file.digest)||!Number.isSafeInteger(file.size)||file.size<0)throw invalid();seen.add(file.relPath);}
  const metadata=files.map(({relPath,digest,size})=>({relPath,digest,size}));
  if(relPath===undefined)return {projectId:options.project.id,objectId,files:metadata,readOnly:true};
  if(!safePath(relPath))throw payloadError();const file=metadata.find(file=>file.relPath===relPath);if(!file)throw new HostError('ARTIFACT_UNAVAILABLE','报告没有此成果快照；未读取原项目同名文件。');
  const source=await managedReportSource({...options,objectId});await source.read();
  const bytes=await readRegular(path.join(options.runtime,'objects','artifacts',objectId,relPath),64*1024*1024);
  if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.digest)throw new HostError('ARTIFACT_CHANGED','成果快照摘要变化，未以原项目文件替代。');
  if((await historySnapshot(options)).version!==snapshot.version)throw changed();
  let text=null;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\u0000'))text=null;}catch{}
  return {projectId:options.project.id,objectId,relPath,digest:file.digest,size:bytes.length,text,base64:bytes.toString('base64'),readOnly:true};
}
