import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const reject=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const TEXT_MAX_BYTES=32*1024*1024;
const snapshotExcluded=new Set(['.git','.nozeli','.ccb','node_modules','.venv','venv','__pycache__']);
const credentials=/(^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|credentials(?:\.[^/]*)?|secrets?|tokens?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx|keystore))(?:\/|$)/i;
export function safeRelativePath(rel){
 if(typeof rel!=='string'||!rel||rel.length>1024||rel.includes('\\')||/[\x00-\x1f\x7f:*?\[\]]/.test(rel)||rel.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(rel))reject('PATH_REJECTED','非法相对路径：'+rel);return rel;
}
export function writablePath(rel){safeRelativePath(rel);if(rel.split('/').some(p=>p==='.git'||p==='.nozeli')||credentials.test(rel))reject('PATH_REJECTED','受保护的元数据或凭据路径：'+rel);return rel;}
export function capturePath(rel){writablePath(rel);if(rel.split('/').some(p=>snapshotExcluded.has(p)))reject('PATH_REJECTED','路径不自动进入执行快照：'+rel);return rel;}
// Pin every ancestor, never follow links, and verify both the open inode and
// its directory entry after the consumer has finished streaming.
export async function withSafeFile(root,rel,consume){
 safeRelativePath(rel);if(process.platform!=='linux')reject('SAFE_OPEN_UNSUPPORTED','此平台尚无安全逐级文件打开实现');const handles=[],ancestors=[];let opened=false;
 try{
  let directory=await fs.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(directory);ancestors.push({entryPath:root,stat:await directory.stat({bigint:true})});
  for(const part of rel.split('/').slice(0,-1)){const entryPath='/proc/self/fd/'+directory.fd+'/'+part;directory=await fs.open(entryPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(directory);ancestors.push({entryPath,stat:await directory.stat({bigint:true})});}
  const entryPath='/proc/self/fd/'+directory.fd+'/'+rel.split('/').at(-1);
  let handle;try{handle=await fs.open(entryPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if(error.code==='ENOENT')return null;throw error;}handles.push(handle);opened=true;
  const stat=await handle.stat({bigint:true});if(!stat.isFile()||stat.nlink!==1n)reject('PATH_REJECTED','非安全普通文件：'+rel);
  const value=await consume({handle,stat,mode:Number(stat.mode)&0o111?'100755':'100644',stream:()=>handle.createReadStream({start:0,autoClose:false,highWaterMark:256*1024})});
  const after=await handle.stat({bigint:true}),entry=await fs.lstat(entryPath,{bigint:true});
  for(const current of [after,entry])if(current.dev!==stat.dev||current.ino!==stat.ino||current.size!==stat.size||current.mtimeNs!==stat.mtimeNs||current.ctimeNs!==stat.ctimeNs||current.nlink!==1n)reject('SOURCE_CHANGED','文件读取期间变化：'+rel);
  for(const ancestor of ancestors){const current=await fs.lstat(ancestor.entryPath,{bigint:true});if(!current.isDirectory()||current.dev!==ancestor.stat.dev||current.ino!==ancestor.stat.ino)reject('SOURCE_CHANGED','文件读取期间父目录变化：'+rel);}
  return value;
 }catch(error){if(error.code==='ENOENT'){if(!opened)return null;reject('SOURCE_CHANGED','文件读取期间消失：'+rel);}throw error;}finally{for(const handle of handles.reverse())await handle.close();}
}
export async function inspectFile(root,rel){return withSafeFile(root,rel,async file=>{const hash=createHash('sha256');let size=0;for await(const chunk of file.stream()){hash.update(chunk);size+=chunk.length;}if(BigInt(size)!==file.stat.size)reject('SOURCE_CHANGED','文件读取期间变化：'+rel);return {digest:hash.digest('hex'),size,mode:file.mode};});}
// Text/document APIs deliberately remain bounded; binary execution never uses it.
export async function readSafeBytes(root,rel,{maxBytes=TEXT_MAX_BYTES}={}){return withSafeFile(root,rel,async file=>{if(file.stat.size>BigInt(maxBytes))reject('TEXT_LIMIT','文档文本读取超过'+maxBytes+'字节：'+rel);const chunks=[];let size=0;for await(const chunk of file.stream()){size+=chunk.length;if(size>maxBytes)reject('TEXT_LIMIT','文档文本读取超过边界：'+rel);chunks.push(chunk);}if(BigInt(size)!==file.stat.size)reject('SOURCE_CHANGED','文件读取期间变化：'+rel);return {bytes:Buffer.concat(chunks,size),mode:file.mode};});}
