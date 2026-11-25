// Per-owner original-HANDLE persistence; no SDK global monkey patch.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {windowsBridge} from './journal-io.mjs';
const hash=b=>createHash('sha256').update(b).digest();
const limit=64*1024*1024;
export async function createOwnerJournalStorage({agentDir,privateRoot=process.env.NOZELI_PI_PRIVATE_ROOT}={}){
 if(process.platform!=='win32'||!privateRoot)return null;
 const native=await windowsBridge(),leases=new Map();let closed=false,poisoned;
 const fail=()=>Object.assign(Error('Original journal custody requires reconciliation; no replay'),{code:'PI_JOURNAL_UNVERIFIED'});
 const check=()=>{if(poisoned)throw poisoned;if(closed)throw fail();};
 const entry=(file,createOnly=false)=>{
  check();const rel=path.relative(agentDir,file),rootRel=path.relative(privateRoot,file);
  if(!rel||path.isAbsolute(rel)||rel.split(path.sep).includes('..')||!file.endsWith('.jsonl')||path.isAbsolute(rootRel)||rootRel.split(path.sep).includes('..'))throw fail();
  let row=leases.get(file);if(row){if(createOnly)throw Object.assign(fail(),{code:'FS_TARGET_EXISTS'});row.lease.verify();return row;}
  let parent,lease;try{parent=native.openAnchoredPersistenceParent(privateRoot,rootRel.split(path.sep).join('/'));lease=parent.openPrivateJournal(path.basename(file),createOnly);row={parent,lease};leases.set(file,row);return row;}catch(error){lease?.close();parent?.close();throw error;}
 };
 const bytes=row=>{const size=row.lease.stat().size;if(size>BigInt(limit))throw fail();const result=Buffer.alloc(Number(size));for(let offset=0;offset<result.length;){const chunk=row.lease.readAt(offset,Math.min(262144,result.length-offset));if(!chunk.length)throw fail();result.set(chunk,offset);offset+=chunk.length;}row.lease.verify();return result;};
 const mutate=fn=>{check();try{return fn();}catch(error){poisoned=fail();poisoned.cause=error;poisoned.committed=error.committed===true;throw poisoned;}};
 return Object.freeze({
  read(file){try{return bytes(entry(file)).toString('utf8');}catch(error){if(error.code==='WIN32_IO_ERROR'&&error.win32Code===2)return undefined;throw error;}},
  write(file,text,{createOnly=false}={}){return mutate(()=>{const candidate=Buffer.from(text);if(candidate.length>limit)throw fail();let row;try{row=entry(file,createOnly);}catch(error){if(createOnly||error.code!=='WIN32_IO_ERROR'||error.win32Code!==2)throw error;row=entry(file,true);}row.lease.rewrite(candidate,hash(bytes(row)));row.lease.sync();row.parent.syncDirectory();});},
  append(file,text){return mutate(()=>{const row=entry(file),candidate=Buffer.from(text);let size=row.lease.stat().size;if(size+BigInt(candidate.length)>BigInt(limit))throw fail();for(let offset=0;offset<candidate.length;offset+=262144){const chunk=candidate.subarray(offset,offset+262144);row.lease.append(chunk,size);size+=BigInt(chunk.length);}row.lease.sync();});},
  async withFlushed(file,callback){const row=entry(file),content=bytes(row);row.lease.sync();row.parent.syncDirectory();const result=await callback(content,{mechanism:'windows-private-file-handle',file:'flushed',directory:'flushed',namespace:'not-qualified',identity:row.lease.stat().identity,journalLifetimeCustody:true});row.lease.verify();row.parent.verify();return result;},
  snapshot(){check();return {schema:1,mechanism:'original-native-journal-writer',files:[...leases].map(([file,row])=>({file,identity:row.lease.stat().identity,byteLength:Number(row.lease.stat().size)})),fullRecoveryClosureQualified:false};},
  close(){if(closed)return;closed=true;let error;for(const row of [...leases.values()].reverse())for(const pin of [row.lease,row.parent])try{pin.close();}catch(cause){error??=cause;}leases.clear();if(error)throw error;}
 });
}
