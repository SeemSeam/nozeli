import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

export const digest=value=>createHash('sha256').update(value).digest('hex');
export class OpenQueueError extends Error {
 constructor(code,message,details={}){super(message);this.name='OpenQueueError';this.code=code;this.details=details;}
}
export const fail=(code,message,details)=>{throw new OpenQueueError(code,message,details);};

// One owning main process, one module lock. Fault hooks are test-only and run
// immediately before the named real operation; no fake persistence receipts.
export class OpenQueueStorage {
 constructor(host,{fault=async()=>{},maxBytes=2*1024*1024}={}){
  this.host=host;this.dir=path.join(host.userDataDir,'nozeli','external-open-v1');this.file=path.join(this.dir,'queue.json');this.fault=fault;this.maxBytes=maxBytes;
 }
 async directories(){
  const root=this.host.userDataDir;await fs.mkdir(root,{recursive:true,mode:0o700});
  if(await fs.realpath(root)!==root)fail('OPEN_QUEUE_UNSAFE','Profile path is not canonical.');
  let dir=root;
  for(const name of ['nozeli','external-open-v1']){
   dir=path.join(dir,name);await fs.mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
   const stat=await fs.lstat(dir);if(stat.isSymbolicLink()||!stat.isDirectory())fail('OPEN_QUEUE_UNSAFE','Queue directory is not a plain directory.');
  }
 }
 async read(ignoreTemp=null){
  await this.directories();let handle;
  try{
   const stat=await fs.lstat(this.file);
   if(stat.isSymbolicLink()||!stat.isFile())fail('OPEN_QUEUE_UNSAFE','Queue is not a plain file.');
   handle=await fs.open(this.file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
   const opened=await handle.stat();if(!opened.isFile()||opened.size>this.maxBytes)fail('OPEN_QUEUE_CORRUPT','Queue exceeds its bounded file format.');
   const buffer=Buffer.alloc(this.maxBytes+1);let used=0;
   while(used<buffer.length){const {bytesRead}=await handle.read(buffer,used,buffer.length-used,null);if(!bytesRead)break;used+=bytesRead;}
   if(used>this.maxBytes)fail('OPEN_QUEUE_CORRUPT','Queue grew beyond its limit.');const bytes=buffer.subarray(0,used);
   return {bytes,hash:digest(bytes)};
  }catch(error){
   if(error.code!=='ENOENT')throw error;
   const remnants=(await fs.readdir(this.dir)).filter(n=>n!==ignoreTemp&&(n.startsWith('.tmp-open-')||n.startsWith('queue.')));
   if(remnants.length)fail('OPEN_QUEUE_CORRUPT','Queue is missing but recovery remnants exist; originals retained.');
   return {bytes:null,hash:null};
  }finally{await handle?.close();}
 }
 async sync(){
  await this.read();const handle=await fs.open(this.file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{await this.fault('file-sync');await handle.sync();}finally{await handle.close();}
  await this.syncDirectory();
 }
 async syncDirectory(){
  await this.fault('directory-sync');if(process.platform==='win32')return;
  const handle=await fs.open(this.dir,constants.O_RDONLY);try{await handle.sync();}finally{await handle.close();}
 }
 async write(value,expectedHash,beforeRename=()=>{}){
  const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>this.maxBytes)fail('OPEN_QUEUE_FULL','Queue serialization exceeds capacity.');
  await this.directories();const before=await this.read();if(before.hash!==expectedHash)fail('OPEN_QUEUE_CHANGED','Queue changed externally; refusing overwrite.');
  const dirStat=await fs.lstat(this.dir),tmp=path.join(this.dir,'.tmp-open-'+randomUUID());let handle;
  try{
   await this.fault('create');handle=await fs.open(tmp,'wx',0o600);
   await this.fault('write');await handle.writeFile(bytes);
   await this.fault('file-sync');await handle.sync();await handle.close();handle=null;
   await this.fault('rename');
   const current=await this.read(path.basename(tmp)),again=await fs.lstat(this.dir);
   if(current.hash!==expectedHash||again.isSymbolicLink()||again.dev!==dirStat.dev||again.ino!==dirStat.ino)fail('OPEN_QUEUE_CHANGED','Queue or parent changed before rename.');
   beforeRename();
   await fs.rename(tmp,this.file);await this.syncDirectory();return digest(bytes);
  }finally{await handle?.close();await fs.unlink(tmp).catch(()=>{});}
 }
}
