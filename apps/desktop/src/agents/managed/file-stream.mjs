import {createHash} from 'node:crypto';
import path from 'node:path';
import {selectFilesystemAdapter,FILESYSTEM_CAPABILITY} from '../../platform/shared/filesystem.mjs';

const reject=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const TEXT_MAX_BYTES=32*1024*1024;
const snapshotExcluded=new Set(['.git','.nozeli','.ccb','node_modules','.venv','venv','__pycache__']);
const credentials=/(^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|credentials(?:\.[^/]*)?|secrets?|tokens?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx|keystore))(?:\/|$)/i;
export function safeRelativePath(rel){
 if(typeof rel!=='string'||!rel||rel.length>1024||rel.includes('\\')||/[\x00-\x1f\x7f:*?\[\]]/.test(rel)||rel.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(rel))reject('PATH_REJECTED','非法相对路径：'+rel);return rel;
}
export function writablePath(rel){safeRelativePath(rel);if(rel.split('/').some(p=>p==='.git'||p==='.nozeli')||credentials.test(rel))reject('PATH_REJECTED','受保护的元数据或凭据路径：'+rel);return rel;}
export function capturePath(rel){writablePath(rel);if(rel.split('/').some(p=>snapshotExcluded.has(p)))reject('PATH_REJECTED','路径不自动进入执行快照：'+rel);return rel;}
const defaultAdapter=selectFilesystemAdapter();
export {defaultAdapter as defaultFilesystemAdapter};
// Pin every ancestor, never follow links, and verify both the open inode and
// its directory entry after the consumer has finished streaming. Policy
// (path rules, byte budgets, mode mapping, error codes) lives here; the
// native anchoring mechanics live in the selected platform adapter
// (platform/linux/filesystem.mjs, platform/darwin/filesystem.mjs).
// Platforms without a verified adapter reject with structured
// FS_PLATFORM_UNSUPPORTED evidence before any I/O.
export function createFileStream({filesystem=defaultAdapter}={}){
 const withSafeFile=async(root,rel,consume)=>{
  safeRelativePath(rel);
  const file=await filesystem.openAnchoredFile(root,rel);
  if(file===null)return null;
  try{
   if(!file.stat.isFile()||file.stat.nlink!==1n)reject('PATH_REJECTED','非安全普通文件：'+rel);
   const value=await consume({stat:file.stat,mode:Number(file.stat.mode)&0o111?'100755':'100644',stream:file.stream});
   const check=await file.verify();
   if(!check.stable)reject('SOURCE_CHANGED',check.reason==='ancestor'?'文件读取期间父目录变化：'+rel:check.reason==='missing'?'文件读取期间消失：'+rel:'文件读取期间变化：'+rel);
   return value;
  }catch(error){
   if(error.code==='ENOENT')reject('SOURCE_CHANGED','文件读取期间消失：'+rel);
   throw error;
  }finally{await file.close();}
 };
 const inspectFile=(root,rel)=>withSafeFile(root,rel,async file=>{const hash=createHash('sha256');let size=0;for await(const chunk of file.stream()){hash.update(chunk);size+=chunk.length;}if(BigInt(size)!==file.stat.size)reject('SOURCE_CHANGED','文件读取期间变化：'+rel);return {digest:hash.digest('hex'),size,mode:file.mode};});
 // Text/document APIs deliberately remain bounded; binary execution never uses it.
 const readSafeBytes=(root,rel,{maxBytes=TEXT_MAX_BYTES}={})=>withSafeFile(root,rel,async file=>{if(file.stat.size>BigInt(maxBytes))reject('TEXT_LIMIT','文档文本读取超过'+maxBytes+'字节：'+rel);const chunks=[];let size=0;for await(const chunk of file.stream()){size+=chunk.length;if(size>maxBytes)reject('TEXT_LIMIT','文档文本读取超过边界：'+rel);chunks.push(chunk);}if(BigInt(size)!==file.stat.size)reject('SOURCE_CHANGED','文件读取期间变化：'+rel);return {bytes:Buffer.concat(chunks,size),mode:file.mode};});
 const safeBytes=async(root,rel)=>(await readSafeBytes(root,rel))?.bytes??null;
 const openWriteParent=async(root,rel)=>{writablePath(rel);return filesystem.openWriteParent(root,rel);};
 return {adapter:filesystem,capability:FILESYSTEM_CAPABILITY,withSafeFile,inspectFile,readSafeBytes,safeBytes,openWriteParent};
}
const stream=createFileStream();
export const withSafeFile=stream.withSafeFile;
export const inspectFile=stream.inspectFile;
export const readSafeBytes=stream.readSafeBytes;
export const safeBytes=stream.safeBytes;
export const openWriteParent=stream.openWriteParent;
// Platform fact for Git hook gating (git-service acceptanceCommit): Linux
// (verified) runs a hook when any exec bit is set; a native adapter may
// declare that Git executes every hook file regardless of mode bits
// (Windows). Without a verified adapter the semantics are unknown — assume
// any present hook would run so acceptance always routes through the
// verified shadow-commit path instead of guessing a skip.
export function hookWouldExecute(stat,{filesystem=defaultAdapter}={}){
 if(!stat)return false;
 if(filesystem?.supported===false)return true;
 if(filesystem?.capabilities?.hooksExecuteRegardlessOfModeBits===true)return true;
 return (stat.mode&0o111)!==0;
}
