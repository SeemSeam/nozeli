import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {exportNativeChunks} from './recovery-export.mjs';

const changed=()=>Object.assign(Error('原生历史或工作面身份已变化；未发布导出文件。'),{code:'TIMELINE_VERSION'});
export async function exportTimelineOriginal({managed,dialog,scope,projectId,id,version}){
  const generation=scope.generation;
  const current=()=>!scope.dead&&scope.generation===generation&&scope.projectId===projectId;
  const source=await managed.projectionSource(projectId);
  const record=source.index.records().find(row=>row.id===id);
  if(!current()||!record||! /^[a-f0-9]{64}$/.test(record.objectId)||version!==record.objectId)throw changed();
  const file=path.join(source.index.root,record.objectId+'.json'),before=await fs.lstat(file);
  if(!before.isFile()||before.isSymbolicLink()||!Number.isSafeInteger(before.size))throw changed();
  const input=await fs.open(file,'r');
  const same=stat=>stat.isFile()&&stat.dev===before.dev&&stat.ino===before.ino&&stat.size===before.size&&stat.mtimeMs===before.mtimeMs&&stat.ctimeMs===before.ctimeMs;
  try{
    if(!same(await input.stat()))throw changed();
    const hash=createHash('sha256');
    return await exportNativeChunks({dialog,scope,defaultName:'nozeli-native-'+record.objectId.slice(0,16)+'.json',expectedTotal:before.size,
      async readChunk(offset){
        if(!current())throw changed();
        const bytes=Buffer.allocUnsafe(Math.min(64*1024,before.size-offset)),read=await input.read(bytes,0,bytes.length,offset),chunk=bytes.subarray(0,read.bytesRead);
        hash.update(chunk);return {bytes:chunk,offset,nextOffset:offset+chunk.length,total:before.size};
      },
      async finalize(){
        if(!current()||!same(await input.stat())||!same(await fs.lstat(file))||hash.digest('hex')!==record.objectId)throw changed();
        const latest=await managed.projectionSource(projectId);
        if(!current()||latest.index.records().find(row=>row.id===id)?.objectId!==record.objectId)throw changed();
      }});
  }finally{await input.close();}
}
