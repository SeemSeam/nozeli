import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {platformPersistence} from '../platform/shared/persistence.mjs';

const changed=()=>Object.assign(Error('恢复记录或目标目录已变化；未发布导出文件，原始资料仍保留。'),{code:'RECOVERY_EXPORT_CHANGED'});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
export function recoveryExportName(id){return 'nozeli-recovery-'+String(id).replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100)+'.json';}
export function recoveryReference(value,{reference,receiptId}){
  let item;
  if(reference==='object'&&value?.kind==='object')item={digest:value.digest};
  else if(reference==='report'&&receiptId===value?.receiptId)item=value.report;
  else if(reference==='receipt')item=value?.collections?.managed_receipts?.find(row=>row.id===receiptId)?.value?.report;
  if(!item||! /^[a-f0-9]{64}$/.test(item.digest??''))throw Object.assign(Error('保留材料不属于所选恢复记录。'),{code:'RECOVERY_REFERENCE_DENIED'});
  return item;
}
export async function exportNativeChunks({dialog,scope,defaultName,readChunk,expectedTotal,validateChunk=()=>{},finalize=async()=>{}}){
  platformPersistence.requireSupported();
  if(!Number.isSafeInteger(expectedTotal)||expectedTotal<0)throw changed();
  const generation=scope.generation;
  const alive=()=>!scope.dead&&scope.generation===generation;
  const choice=await dialog.showSaveDialog(scope.win,{title:'导出完整原始记录（不会覆盖已有文件）',defaultPath:defaultName});
  if(choice.canceled||!choice.filePath)return {cancelled:true};
  if(!alive())throw changed();
  const target=path.resolve(choice.filePath),directory=path.dirname(target),parent=await fs.lstat(directory);
  if(!parent.isDirectory()||parent.isSymbolicLink()||await fs.realpath(directory)!==directory)throw changed();
  const temporary=path.join(directory,'.nozeli-recovery-'+randomUUID()+'.tmp');let output,owned;
  try{
    output=await fs.open(temporary,'wx',0o600);owned=await output.stat();let offset=0;
    while(offset<expectedTotal){
      const chunk=await readChunk(offset),bytes=Buffer.from(chunk.bytes);
      if(!alive()||chunk.offset!==offset||chunk.total!==expectedTotal||chunk.nextOffset!==offset+bytes.length||!bytes.length||bytes.length>64*1024)throw changed();
      await validateChunk(chunk,offset);
      let written=0;while(written<bytes.length){const result=await output.write(bytes,written,bytes.length-written,null);if(!result.bytesWritten)throw changed();written+=result.bytesWritten;}
      offset=chunk.nextOffset;
    }
    await finalize({total:expectedTotal,scope});await platformPersistence.syncFileHandle(output);await output.close();output=null;
    const current=await fs.lstat(directory);
    if(!same(parent,current)||current.isSymbolicLink()||await fs.realpath(directory)!==directory||!alive())throw changed();
    await fs.link(temporary,target);
    try{await platformPersistence.syncDirectory(directory);}catch(error){error.committed=true;error.durability='uncertain';throw error;}
    return {exported:true,byteLength:expectedTotal};
  }finally{
    await output?.close();
    if(owned){const stat=await fs.lstat(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});if(stat&&same(owned,stat))await fs.unlink(temporary);}
  }
}
export async function exportRecoveryRecord({storage,dialog,scope,projectId,id,revision,version,reference,receiptId}){
  await storage.requireRegistered(projectId);
  const options={revision,version,offset:0,maxBytes:64*1024,purpose:'recovery-ui'};
  if(reference){
    const record=await storage.readRecoveryRecord(projectId,id,{...options,maxBytes:8*1024*1024});
    if(!record)throw changed();
    const item=recoveryReference(record.value,{reference,receiptId});
    let started=false;
    const run=async({handle,stat})=>{
      started=true;const hash=createHash('sha256');
      return exportNativeChunks({dialog,scope,defaultName:'retained-'+item.digest+(item.format==='html-static'?'.html':item.format==='markdown'?'.md':'.bin'),expectedTotal:stat.size,
        async readChunk(offset){const bytes=Buffer.allocUnsafe(Math.min(64*1024,stat.size-offset)),result=await handle.read(bytes,0,bytes.length,offset),chunk=bytes.subarray(0,result.bytesRead);hash.update(chunk);return {bytes:chunk,offset,nextOffset:offset+chunk.length,total:stat.size};},
        async finalize(){if(hash.digest('hex')!==item.digest)throw changed();await storage.readRecoveryChunk(projectId,id,{...options,maxBytes:1});}});
    };
    try{return await storage.withObject(projectId,item.digest,run);}
    catch(error){if(started)throw error;return storage.withRecoveryObject(projectId,item.digest,run);}
  }
  const first=await storage.readRecoveryChunk(projectId,id,options);if(!first)throw changed();
  const frozen={revision:first.revision,version:first.version,total:first.total};
  return exportNativeChunks({dialog,scope,defaultName:recoveryExportName(id),expectedTotal:frozen.total,
    readChunk:offset=>storage.readRecoveryChunk(projectId,id,{...options,revision:frozen.revision,version:frozen.version,offset}),
    validateChunk:chunk=>{if(chunk.revision!==frozen.revision||chunk.version!==frozen.version)throw changed();},
    finalize:()=>storage.readRecoveryChunk(projectId,id,{...options,revision:frozen.revision,version:frozen.version,maxBytes:1})});
}
