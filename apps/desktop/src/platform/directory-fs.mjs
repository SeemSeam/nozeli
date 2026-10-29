// A child entry is a capability under a held directory, never a fabricated path.
import fs from 'node:fs/promises';
import nodefs,{constants} from 'node:fs';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {platformNative} from './native.mjs';
export const DIR_FLAGS=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
export function entry(fd,name){
  if(!Number.isInteger(fd)||fd<0||typeof name!=='string'||!name||name==='.'||name==='..'||name.includes('/')||name.includes('\0'))throw Object.assign(Error('Expected one child entry under an open directory'),{code:'PATH_REJECTED'});
  return Object.freeze({directoryFd:fd,name});
}
const isEntry=value=>value&&typeof value==='object'&&Number.isInteger(value.directoryFd);
const linuxPath=ref=>'/proc/self/fd/'+ref.directoryFd+'/'+ref.name;
const call=(fn,...args)=>promisify(fn)(...args);
function statMethods(s,bigint=true){
  const mode=Number(s.mode);
  const result={...s,isFile:()=>((mode&constants.S_IFMT)===constants.S_IFREG),isDirectory:()=>((mode&constants.S_IFMT)===constants.S_IFDIR),isSymbolicLink:()=>((mode&constants.S_IFMT)===constants.S_IFLNK)};
  if(!bigint)for(const key of Object.keys(s))result[key]=Number(s[key]);
  return result;
}
class NativeHandle {
  constructor(fd){this.fd=fd;}
  async close(){if(this.fd<0)return;const fd=this.fd;this.fd=-1;await call(nodefs.close,fd);}
  async stat(options){return call(nodefs.fstat,this.fd,options??{});}
  createReadStream(options={}){return nodefs.createReadStream(null,{...options,fd:this.fd,autoClose:false});}
  async readFile(options){return call(nodefs.readFile,this.fd,options??{});}
  async read(buffer,offset,length,position){return new Promise((resolve,reject)=>nodefs.read(this.fd,buffer,offset,length,position,(error,bytesRead)=>error?reject(error):resolve({bytesRead,buffer})));}
  async writeFile(data,options){
    if(typeof data==='string'||Buffer.isBuffer(data)||ArrayBuffer.isView(data))return call(nodefs.writeFile,this.fd,data,options??{});
    for await(const chunk of data)await call(nodefs.writeFile,this.fd,chunk,options??{});
  }
  async chmod(mode){await call(nodefs.fchmod,this.fd,mode);}
  async sync(){await call(nodefs.fsync,this.fd);}
}
const flags=value=>typeof value==='number'?value:({r:constants.O_RDONLY,'r+':constants.O_RDWR,wx:constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL})[value]??(()=>{throw Error('Unsupported relative open mode: '+value);})();
export async function openAt(ref,mode='r',permissions=0o666){
  if(!isEntry(ref))return fs.open(ref,mode,permissions);
  if(process.platform==='linux')return fs.open(linuxPath(ref),flags(mode)|constants.O_NOFOLLOW,permissions);
  return new NativeHandle(platformNative().openAt(ref.directoryFd,ref.name,flags(mode),permissions));
}
export async function statAt(ref,options={}){
  if(!isEntry(ref))return fs.lstat(ref,options);
  if(process.platform==='linux')return fs.lstat(linuxPath(ref),options);
  return statMethods(platformNative().statAt(ref.directoryFd,ref.name),options.bigint===true);
}
export async function mkdirAt(ref,{mode=0o777}={}){
  if(!isEntry(ref))return fs.mkdir(ref,{mode});
  if(process.platform==='linux')return fs.mkdir(linuxPath(ref),{mode});
  platformNative().mkdirAt(ref.directoryFd,ref.name,mode);
}
export async function readDirectory(fd){
  if(process.platform==='linux')return fs.readdir('/proc/self/fd/'+fd);
  return platformNative().readDir(fd);
}
export async function renameAt(from,to,{exclusive=false,exchange=false}={}){
  if(!isEntry(from)||!isEntry(to))throw Error('rename requires two held directory entries');
  if(process.platform==='linux'){
    if(exchange)throw Object.assign(Error('Atomic exchange unavailable'),{code:'ENOTSUP'});
    // Directory publication retains the Linux reservation protocol. Files use
    // link/unlink for exclusive publication (same filesystem, no overwrite).
    if(exclusive){await fs.link(linuxPath(from),linuxPath(to));await fs.unlink(linuxPath(from));return;}
    return fs.rename(linuxPath(from),linuxPath(to));
  }
  platformNative().renameAt(from.directoryFd,from.name,to.directoryFd,to.name,exchange?2:exclusive?1:0);
}
export async function unlinkAt(ref,{directory=false,force=false}={}){
  try{
    if(process.platform==='linux')return directory?await fs.rmdir(linuxPath(ref)):await fs.unlink(linuxPath(ref));
    platformNative().unlinkAt(ref.directoryFd,ref.name,directory?1:0);
  }catch(error){if(force&&error.code==='ENOENT')return;throw error;}
}
// An entry in a writable parent can be replaced between checking its inode and
// unlinking its name. Move leftovers to reserved recovery storage instead of
// irreversibly deleting whichever object happens to occupy that name.
export async function retainEntryAt(ref){
 if(process.platform!=='darwin')return unlinkAt(ref,{force:true});
 const handles=[];let directoryFd=ref.directoryFd;
 try{
  for(const name of ['.nozeli','recovery']){
   const next=entry(directoryFd,name);await mkdirAt(next,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
   const handle=await openAt(next,DIR_FLAGS);handles.push(handle);directoryFd=handle.fd;
  }
  const name=randomUUID();
  try{await renameAt(ref,entry(directoryFd,name),{exclusive:true});return '.nozeli/recovery/'+name;}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
 }finally{for(const h of handles.reverse())await h.close();}
}
export async function removeTreeAt(ref,{expected}={}){
  const stat=await statAt(ref,{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!stat)return;
  if(!expected||stat.dev!==expected.dev||stat.ino!==expected.ino)throw Object.assign(Error('Cleanup ownership changed; retained entry'),{code:'SOURCE_CHANGED'});
  if(process.platform==='darwin')return retainEntryAt(ref);
  if(!stat.isDirectory())return unlinkAt(ref);
  const dir=await openAt(ref,DIR_FLAGS);
  try{
    const opened=await dir.stat({bigint:true});if(opened.dev!==stat.dev||opened.ino!==stat.ino)throw Object.assign(Error('Cleanup entry changed'),{code:'SOURCE_CHANGED'});
    for(const name of await readDirectory(dir.fd)){const child=entry(dir.fd,name),identity=await statAt(child,{bigint:true});await removeTreeAt(child,{expected:identity});}
    const current=await statAt(ref,{bigint:true});if(current.dev!==stat.dev||current.ino!==stat.ino)throw Object.assign(Error('Cleanup directory changed'),{code:'SOURCE_CHANGED'});
    await unlinkAt(ref,{directory:true});
  }finally{await dir.close();}
}
export async function writeAt(ref,data,{mode=0o600}={}){const h=await openAt(ref,'wx',mode);try{await h.writeFile(data);await h.sync();}finally{await h.close();}}
export async function openDirectoryChain(root,relative='',{create=false,validateName}={}){
  const handles=[],ancestors=[];
  try{
    let directory=await fs.open(root,DIR_FLAGS);handles.push(directory);ancestors.push({ref:root,stat:await directory.stat({bigint:true})});
    for(const part of relative?relative.split('/'):[]){
      if(validateName)await validateName(directory.fd,part);
      const ref=entry(directory.fd,part);if(create)await mkdirAt(ref).catch(e=>{if(e.code!=='EEXIST')throw e;});
      directory=await openAt(ref,DIR_FLAGS);handles.push(directory);ancestors.push({ref,stat:await directory.stat({bigint:true})});
    }
    return {directory,handles,ancestors,verify:async()=>{for(const {ref,stat} of ancestors){const now=await statAt(ref,{bigint:true});if(!now.isDirectory()||now.dev!==stat.dev||now.ino!==stat.ino)throw Object.assign(Error('Parent directory changed'),{code:'SOURCE_CHANGED'});}},close:async()=>{for(const h of [...handles].reverse())await h.close();}};
  }catch(error){for(const h of handles.reverse())await h.close().catch(()=>{});throw error;}
}
