// Workspace file effects. Business state, admission and recovery stay in the
// shared Workspace/Controller; explicit native adapters supply only these I/O.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {processStamp,ownerAlive} from './process-ownership.mjs';
import {platformPersistence} from '../../platform/shared/persistence.mjs';
const issued=new WeakSet();
const fail=(code,message)=>Object.assign(Error(message),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function defineWorkspaceIO(io){
  for(const name of ['acquire','ensureDirectory','ensurePlan','readFile','writeVersioned','writeImmutable','syncDirectory','requirePersistence'])
    if(typeof io?.[name]!=='function')throw fail('WORKSPACE_IO_INVALID','Workspace I/O requires '+name);
  const value=Object.freeze(io);issued.add(value);return value;
}
export const isWorkspaceIO=value=>issued.has(value);
export const legacyWorkspaceIO=defineWorkspaceIO({
  requirePersistence:()=>platformPersistence.requireSupported(),
  async acquire({project,runtimeRoot,recoverStale}){
    // Refuse before creating a lock on platforms with no ownership identity.
    const stamp=await processStamp(process.pid);
    if(!stamp)throw fail('PROCESS_OWNERSHIP_UNSUPPORTED','Workspace host ownership is unavailable on this platform');
    await fs.mkdir(runtimeRoot,{recursive:true,mode:0o700});
    const runtime=await fs.realpath(runtimeRoot),lock=path.join(runtime,'host.lock');let handle;
    const inside=(a,b)=>a===b||(!path.isAbsolute(path.relative(a,b))&&!path.relative(a,b).split(path.sep).includes('..'));
    if(inside(runtime,project.root)||inside(project.root,runtime))throw Error('runtime and content roots overlap');
    try{handle=await fs.open(lock,'wx',0o600);}catch(error){
      if(error.code!=='EEXIST')throw error;
      if(!recoverStale)throw Error('workspace owned or stale lock requires recovery');
      const gate=path.join(runtime,'recovery.lock'),guard=await fs.open(gate,'wx',0o600);
      try{const before=await fs.readFile(lock,'utf8'),old=JSON.parse(before);if(await ownerAlive(old))throw Error('workspace owned by live host');if(await fs.readFile(lock,'utf8')!==before)throw Error('workspace owner changed');await fs.unlink(lock);handle=await fs.open(lock,'wx',0o600);}
      finally{await guard.close();await fs.unlink(gate);}
    }
    const owner=JSON.stringify({pid:process.pid,hostId:randomUUID(),stamp});
    try{await handle.writeFile(owner);}finally{await handle.close();}
    return {runtime,content:project.root,lock,owner,async release(){if(await fs.readFile(lock,'utf8')!==owner)throw Error('workspace owner changed');await fs.unlink(lock);}};
  },
  ensureDirectory:directory=>fs.mkdir(directory,{recursive:true,mode:0o700}),
  async ensurePlan(file,bytes){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,bytes,{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});},
  async readFile(file,{maxBytes=64*1024*1024,limitCode='WORKSPACE_FILE_INVALID'}={}){
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw fail('WORKSPACE_FILE_INVALID','Unsafe workspace file');
    if(stat.size>maxBytes)throw fail(limitCode,'Workspace file exceeds its byte bound');
    const handle=await fs.open(file,'r');
    try{
      const opened=await handle.stat();
      if(!opened.isFile()||opened.size!==stat.size||opened.dev!==stat.dev||opened.ino!==stat.ino)throw fail('WORKSPACE_FILE_INVALID','Workspace file changed during open');
      const buffer=Buffer.allocUnsafe(stat.size+1);let length=0;
      while(length<buffer.length){const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);if(!bytesRead)break;length+=bytesRead;}
      const after=await handle.stat();
      if(length!==stat.size||after.size!==stat.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw fail('WORKSPACE_FILE_INVALID','Workspace file changed during read');
      return buffer.subarray(0,length);
    }finally{await handle.close();}
  },
  async writeVersioned(file,bytes,{expectedSha256}){
    const temporary=file+'.'+randomUUID()+'.tmp',handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(bytes);await platformPersistence.syncFileHandle(handle);}finally{await handle.close();}
    if(sha(await fs.readFile(file))!==expectedSha256){await fs.rm(temporary,{force:true});throw fail('FS_VERSION_CONFLICT','Plan Tree changed; preserve external edits');}
    await fs.rename(temporary,file);await platformPersistence.syncDirectory(path.dirname(file));
  },
  async writeImmutable(file,bytes){
    let handle;try{handle=await fs.open(file,'wx',0o600);}catch(error){if(error.code==='EEXIST')return false;throw error;}
    try{await handle.writeFile(bytes);await platformPersistence.syncFileHandle(handle);}finally{await handle.close();}return true;
  },
  syncDirectory:directory=>platformPersistence.syncDirectory(directory),
});
