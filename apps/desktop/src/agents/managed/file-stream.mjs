import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {entry,openAt,statAt,openDirectoryChain} from '../../platform/directory-fs.mjs';
import {reservedSegment,assertManagedEntry} from '../../platform/filename-policy.mjs';

const reject=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const TEXT_MAX_BYTES=32*1024*1024;
const excluded=new Set(['.git','.nozeli','.ccb','node_modules','.venv','venv','__pycache__']);
export function safeRelativePath(rel){
 if(typeof rel!=='string'||!rel||rel.length>1024||rel.includes('\\')||/[\x00-\x1f\x7f:*?\[\]]/.test(rel)||rel.split('/').some(p=>!p||p==='.'||p==='..'||reservedSegment(p))||path.isAbsolute(rel)||/(^|\/)(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|[^/]+\.(?:pem|key))$/i.test(rel))reject('PATH_REJECTED','路径不可用于Worker：'+rel);return rel;
}
// Pin every ancestor, never follow links, and verify both the open inode and
// its directory entry after the consumer has finished streaming.
export async function withSafeFile(root,rel,consume){
 safeRelativePath(rel);const handles=[];let opened=false,chain;
 try{
  chain=await openDirectoryChain(root,rel.split('/').slice(0,-1).join('/'),{validateName:assertManagedEntry});
  const directory=chain.directory,name=rel.split('/').at(-1),entryPath=entry(directory.fd,name);
  await assertManagedEntry(directory.fd,name);
  let handle;try{handle=await openAt(entryPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if(error.code==='ENOENT')return null;throw error;}handles.push(handle);opened=true;
  const stat=await handle.stat({bigint:true});if(!stat.isFile()||stat.nlink!==1n)reject('PATH_REJECTED','非安全普通文件：'+rel);
  const value=await consume({handle,stat,mode:Number(stat.mode)&0o111?'100755':'100644',stream:()=>handle.createReadStream({start:0,autoClose:false,highWaterMark:256*1024})});
  const after=await handle.stat({bigint:true}),entryStat=await statAt(entryPath,{bigint:true});
  for(const current of [after,entryStat])if(current.dev!==stat.dev||current.ino!==stat.ino||current.size!==stat.size||current.mtimeNs!==stat.mtimeNs||current.ctimeNs!==stat.ctimeNs||current.nlink!==1n)reject('SOURCE_CHANGED','文件读取期间变化：'+rel);
  await chain.verify();
  return value;
 }catch(error){if(error.code==='ENOENT'){if(!opened)return null;reject('SOURCE_CHANGED','文件读取期间消失：'+rel);}throw error;}finally{for(const handle of handles.reverse())await handle.close();await chain?.close();}
}
export async function inspectFile(root,rel){return withSafeFile(root,rel,async file=>{const hash=createHash('sha256');let size=0;for await(const chunk of file.stream()){hash.update(chunk);size+=chunk.length;}if(BigInt(size)!==file.stat.size)reject('SOURCE_CHANGED','文件读取期间变化：'+rel);return {digest:hash.digest('hex'),size,mode:file.mode};});}
// Text/document APIs deliberately remain bounded; binary execution never uses it.
export async function readSafeBytes(root,rel,{maxBytes=TEXT_MAX_BYTES}={}){return withSafeFile(root,rel,async file=>{if(file.stat.size>BigInt(maxBytes))reject('TEXT_LIMIT','文档文本读取超过'+maxBytes+'字节：'+rel);const chunks=[];let size=0;for await(const chunk of file.stream()){size+=chunk.length;if(size>maxBytes)reject('TEXT_LIMIT','文档文本读取超过边界：'+rel);chunks.push(chunk);}if(BigInt(size)!==file.stat.size)reject('SOURCE_CHANGED','文件读取期间变化：'+rel);return {bytes:Buffer.concat(chunks,size),mode:file.mode};});}
