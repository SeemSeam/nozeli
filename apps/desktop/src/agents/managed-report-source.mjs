import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {HostError} from '../main/host.mjs';
import {decodeReportState,validReportDescriptor} from './managed/report-descriptor.mjs';
import {readManagedState,readManagedObject,verifyManagedObject} from './managed/managed-storage.mjs';

const STATE_LIMIT=32*1024*1024;
const fail=(code,message)=>new HostError(code,message+'，未另存。');
const unavailable=()=>fail('REPORT_UNAVAILABLE','报告来源缺失、过大或不是安全的普通文件');
const invalid=()=>fail('REPORT_INVALID','历史报告快照损坏或不属于当前项目');
const changed=()=>fail('REPORT_CHANGED','报告来源或历史快照已变化');

function receiptFor(state,project,objectId) {
  if(!state||state.schema!==2||state.workspaceId!==project.id||
     !Array.isArray(state.works)||!Array.isArray(state.todos)||!Array.isArray(state.receipts)||
     !Array.isArray(state.memoryPending)||!Number.isInteger(state.limit)||state.limit<1||
     typeof state.workspaceId!=='string')throw invalid();
  const rows=state.receipts.filter(row=>row?.objectId===objectId);
  if(!rows.length)throw fail('REPORT_MISSING','当前项目没有这份历史报告');
  if(rows.length!==1)throw invalid();
  const row=rows[0],works=state.works.filter(work=>work?.id===row.workId);
  if(works.length!==1||!Number.isInteger(works[0].revision)||!Number.isInteger(row.revision)||row.revision<1||row.revision>works[0].revision||
     typeof row.id!=='string'||!['result','problem'].includes(row.kind)||!validReportDescriptor(row.report)||row.report.objectId!==objectId)throw invalid();
  if(row.snapshot?.reportDigest&&row.snapshot.reportDigest!==row.report.digest)throw invalid();
  return row;
}

// The source is a capability with a revalidated read, never renderer paths/text.
// A controller in the map is authoritative even while starting or stopping.
export async function managedReportSource({project,storage,runtime,objectId,controller,currentController=()=>controller}) {
  if(typeof objectId!=='string'||!OBJECT_ID.test(objectId))throw payloadError();
  const offlineState=controller?null:await readManagedState(storage,project.id);
  const state=()=>{
    try{return controller?decodeReportState(controller.store?.state):offlineState;}catch{throw invalid();}
  };
  const checkRoot=()=>{
    if(controller&&(typeof controller.store?.root!=='string'||path.resolve(controller.store.root)!==path.resolve(runtime)))throw invalid();
  };
  checkRoot();
  const receipt=receiptFor(state(),project,objectId),report=Object.freeze(structuredClone(receipt.report));
  const identity=row=>JSON.stringify([row.id,row.workId,row.revision,row.kind,row.report]);
  const frozenIdentity=identity(receipt);
  const source={mode:controller?'active':'offline',objectId,report,read:async()=>{
    if(currentController()!==controller)throw changed();
    if(!controller&&identity(receiptFor(await readManagedState(storage,project.id),project,objectId))!==frozenIdentity)throw changed();
    checkRoot();
    if(identity(receiptFor(state(),project,objectId))!==frozenIdentity)throw changed();
    const bytes=await readManagedObject(storage,project.id,report.digest,{maxBytes:report.byteLength});
    if(bytes.length!==report.byteLength||createHash('sha256').update(bytes).digest('hex')!==report.digest||currentController()!==controller)throw changed();
    return bytes;
  },readManifest:async()=>{
    await source.read();
    if(report.manifestDigest===null)return {version:1,assets:[],references:[]};
    const bytes=await readManagedObject(storage,project.id,report.manifestDigest);
    if(createHash('sha256').update(bytes).digest('hex')!==report.manifestDigest)throw changed();
    let manifest;try{manifest=JSON.parse(bytes.toString('utf8'));}catch{throw invalid();}
    await source.read();return manifest;
  },readReference:async id=>{
    const manifest=await source.readManifest(),ref=manifest.references.find(r=>String(r.id)===String(id));
    if(!ref)throw invalid();if(ref.kind==='external')return {kind:'external',url:ref.url};
    const result=await managedArtifact({project,storage,runtime,controller,currentController},{objectId,relPath:ref.relPath});
    if(result.digest!==ref.digest||result.size!==ref.byteLength)throw changed();
    return {...ref,bytes:result.base64===null?null:Buffer.from(result.base64,'base64'),availability:result.availability??'available',reason:result.reason??null};
  },copyReference:async(id,destination)=>{
    const manifest=await source.readManifest(),ref=manifest.references.find(row=>String(row.id)===String(id));
    if(!ref||ref.kind!=='artifact'||!path.isAbsolute(destination))throw invalid();
    const temporary=path.join(path.dirname(destination),'.nozeli-artifact-'+randomUUID());let handle;
    try{
      handle=await fs.open(temporary,'wx',0o600);
      const copy=async file=>{
        if(file.stat.size!==ref.byteLength)throw changed();
        const hash=createHash('sha256');let size=0;
        for await(const chunk of file.stream()){hash.update(chunk);size+=chunk.length;await handle.writeFile(chunk);}
        if(size!==ref.byteLength||hash.digest('hex')!==ref.digest)throw changed();
      };
      let online=true;try{await storage.requireOnline(project.id);}catch{online=false;}
      if(online){try{await storage.withObject(project.id,ref.digest,copy);}catch(error){if(error.code!=='MATERIAL_MISSING')throw error;await storage.withRecoveryObject(project.id,ref.digest,copy);}}
      else await storage.withRecoveryObject(project.id,ref.digest,copy);
      await handle.sync();await handle.close();handle=null;
      await source.readManifest();
      await fs.link(temporary,destination);
      const directory=await fs.open(path.dirname(destination),'r');try{await directory.sync();}finally{await directory.close();}
      return {saved:true,digest:ref.digest,byteLength:ref.byteLength,relPath:ref.relPath};
    }finally{await handle?.close();await fs.rm(temporary,{force:true});}
  }};
  return source;
}

const OBJECT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const payloadError=()=>new HostError('INVALID_PAYLOAD','历史报告查询参数无效。');


async function historySnapshot({project,storage,runtime,controller,currentController}) {
  const raw=controller?controller.store?.state:await readManagedState(storage,project.id);
  let state;try{state=decodeReportState(structuredClone(raw));}catch{throw invalid();}
  const bytes=Buffer.from(JSON.stringify(state));
  if(bytes.length>STATE_LIMIT)throw unavailable();
  if(!state||state.schema!==2||state.workspaceId!==project.id||
     !Array.isArray(state.works)||!Array.isArray(state.todos)||!Array.isArray(state.receipts)||
     !Array.isArray(state.memoryPending)||!Number.isInteger(state.limit)||state.limit<1)throw invalid();
  const works=new Map(),objects=new Set(),receipts=new Set();
  for(const work of state.works) {
    if(!work||typeof work.id!=='string'||!OBJECT_ID.test(work.id)||works.has(work.id)||!Number.isInteger(work.revision)||work.revision<0||typeof work.status!=='string')throw invalid();
    works.set(work.id,work);
  }
  for(const row of state.receipts) {
    const work=works.get(row?.workId);
    if(!row||typeof row.objectId!=='string'||!OBJECT_ID.test(row.objectId)||objects.has(row.objectId)||typeof row.id!=='string'||receipts.has(row.id)||
       !work||!Number.isInteger(row.revision)||row.revision<1||row.revision>work.revision||
       !['result','problem'].includes(row.kind)||!validReportDescriptor(row.report)||row.report.objectId!==row.objectId||
       typeof row.at!=='string'||row.at.length>64||!Number.isFinite(Date.parse(row.at)))throw invalid();
    if(row.snapshot?.reportDigest&&row.snapshot.reportDigest!==row.report.digest)throw invalid();
    objects.add(row.objectId);receipts.add(row.id);
  }
  if(currentController()!==controller)throw changed();
  return {state,works,version:createHash('sha256').update(controller?'active\0':'offline\0').update(bytes).digest('hex')};
}

// Serializable, metadata-only pages. A version is mandatory beyond page one;
// any state change requires a reload, never a silent splice of snapshots.
export async function managedHistory(options,{objectId,version,offset=0,limit=50}={}) {
  if(version!==undefined&&!(typeof version==='string'&&/^[a-f0-9]{64}$/.test(version)))throw payloadError();
  if(objectId!==undefined&&(typeof objectId!=='string'||!OBJECT_ID.test(objectId)))throw payloadError();
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100||offset>0&&!version)throw payloadError();
  const snapshot=await historySnapshot(options);
  if(version!==undefined&&version!==snapshot.version)throw changed();
  const mode=options.controller?'active':'offline';
  if(objectId!==undefined) {
    if(!snapshot.state)throw fail('REPORT_MISSING','当前项目没有这份历史报告');
    const source=await managedReportSource({...options,objectId});
    const bytes=await source.read();
    // 单对象无version读取：不可变receipt/report/controller身份已由source.read()
    // 严格复验，不再以全state哈希拒绝窗口内无关的后台状态变化（runtime/review等）。
    // 显式version分页仍保持严格CAS：任何state变化都要求调用方重载。
    if(version!==undefined&&(await historySnapshot(options)).version!==snapshot.version)throw changed();
    return {projectId:options.project.id,objectId,mode,version:snapshot.version,report:source.report,byteLength:bytes.length,objectVerified:true,...(source.report.format==='markdown'?{bodyAvailability:'inline',body:bytes.toString('utf8')}:{bodyAvailability:'isolated-source-only'})};
  }
  const rows=[...(snapshot.state?.receipts||[])].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||(a.objectId<b.objectId?-1:a.objectId>b.objectId?1:0));
  if(offset>rows.length)throw payloadError();
  const items=rows.slice(offset,offset+limit).map(row=>{
    const work=snapshot.works.get(row.workId);
    return {objectId:row.objectId,workId:row.workId,workName:typeof work.name==='string'?work.name.slice(0,110):'工作',revision:row.revision,kind:row.kind,at:row.at,workStatus:work.status.slice(0,64),report:row.report,excerpt:row.report.excerpt,objectVerified:false};
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
  for(const file of files){if(!file||!safePath(file.relPath)||seen.has(file.relPath)||!Number.isSafeInteger(file.size)||file.size<0||!(file.digest===null?file.size===0:typeof file.digest==='string'&&/^[a-f0-9]{64}$/.test(file.digest)))throw invalid();seen.add(file.relPath);}
  const metadata=files.map(({relPath,digest,size})=>({relPath,digest,size}));
  if(relPath===undefined)return {projectId:options.project.id,objectId,files:metadata,readOnly:true};
  if(!safePath(relPath))throw payloadError();const file=metadata.find(file=>file.relPath===relPath);if(!file)throw new HostError('ARTIFACT_UNAVAILABLE','报告没有此成果快照；未读取原项目同名文件。');
  const source=await managedReportSource({...options,objectId});await source.read();
  if(file.digest===null){if((await historySnapshot(options)).version!==snapshot.version)throw changed();return {projectId:options.project.id,objectId,relPath,digest:null,size:0,availability:'absent',text:null,base64:null,readOnly:true};}
  if(file.size>2*1024*1024){
    const verified=await verifyManagedObject(options.storage,options.project.id,file.digest);
    if(verified.byteLength!==file.size)throw new HostError('ARTIFACT_CHANGED','成果快照尺寸变化，未以原项目文件替代。');
    if((await historySnapshot(options)).version!==snapshot.version)throw changed();
    return {projectId:options.project.id,objectId,relPath,digest:file.digest,size:file.size,availability:'unavailable',reason:'byte-budget',text:null,base64:null,readOnly:true};
  }
  const bytes=await readManagedObject(options.storage,options.project.id,file.digest,{maxBytes:2*1024*1024});
  if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.digest)throw new HostError('ARTIFACT_CHANGED','成果快照摘要变化，未以原项目文件替代。');
  if((await historySnapshot(options)).version!==snapshot.version)throw changed();
  let text=null;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\u0000'))text=null;}catch{}
  return {projectId:options.project.id,objectId,relPath,digest:file.digest,size:bytes.length,text,base64:bytes.toString('base64'),readOnly:true};
}
