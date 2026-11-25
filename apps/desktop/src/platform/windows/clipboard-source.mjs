// Explicit native clipboard source custody. No project registration, source
// writes, ACL repair, or path-based fallback. Absolute paths remain in main.
import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileIdentity,sameFileIdentity} from '../../main/file-clipboard.mjs';
import {openExperimentalSourceTree} from './experimental-private-tree.mjs';
const require=createRequire(import.meta.url),fold=value=>value.normalize('NFKC').toUpperCase().toLowerCase();
const fail=(code,message)=>Object.assign(Error(message),{code});
export async function openWindowsClipboardSource(source,{identity,nativeIdentity}={}){
 if(process.platform!=='win32'||process.arch!=='x64')throw fail('FS_PLATFORM_UNSUPPORTED','Native Windows x64 required');
 if(typeof source!=='string'||!path.isAbsolute(source)||!/^\w:\\/.test(source)||source.includes('\0')||source.split(/[\\/]/).some(part=>['.git','.nozeli'].includes(fold(part))))throw fail('FS_PATH_REJECTED','不能复制链接、卷根目录或项目运行元数据。');
 const root=path.dirname(source),relative=path.basename(source);if(!relative||root===source)throw fail('FS_PATH_REJECTED','不能复制卷根目录。');
 const bridge=require('../../../native/windows/build/Release/nozeli_windows_read.node');let parent,entry,closed=false;
 try{
  parent=bridge.openAnchoredSourceDirectory(root,'__clipboard_source_anchor__');
  const before=await fs.lstat(source);if(identity&&!sameFileIdentity(identity,fileIdentity(before)))throw fail('FS_SOURCE_CHANGED','源文件已变化，请重新复制。');
  if(before.isSymbolicLink()||!before.isFile()&&!before.isDirectory())throw fail('FS_ENTRY_REJECTED','仅支持普通文件和目录。');
  const directory=before.isDirectory();entry=directory?parent.openDirectory(relative):parent.openFile(relative);
  const id=directory?entry.identity():entry.stat().identity;
  if(nativeIdentity&&nativeIdentity!==id)throw fail('FS_SOURCE_CHANGED','源文件身份已变化，请重新复制。');
  const verify=async()=>{if(closed)throw fail('FS_HANDLE_CLOSED','Clipboard source closed');parent.verify();entry.verify();if(!sameFileIdentity(fileIdentity(before),fileIdentity(await fs.lstat(source))))throw fail('FS_SOURCE_CHANGED','源文件已变化，请重新复制。');};
  await verify();
  return {root,relative,parent,entry,directory,identity:id,verify,close(){if(closed)return;closed=true;try{entry.close();}finally{parent.close();}}};
 }catch(error){try{entry?.close();}finally{parent?.close();}throw error;}
}
export async function windowsClipboardIdentity(source){
 const lease=await openWindowsClipboardSource(source);try{return lease.identity;}finally{lease.close();}
}
export async function windowsClipboardSnapshot(source){
 const lease=await openWindowsClipboardSource(source);let tree;
 try{
  let digest,byteLength;
  if(lease.directory){tree=await openExperimentalSourceTree(lease.root,source,{sourceLease:lease.entry,maxEntries:1024,maxBytes:512*1024*1024});
   for(const row of tree.manifest.entries)if(row.relative.split('/').some(part=>['.git','.nozeli'].includes(fold(part))))throw fail('TREE_METADATA_REJECTED','目录包含独立项目元数据，未复制。');
   digest=tree.manifest.sha256;byteLength=tree.manifest.totalBytes;
  }else{
   const size=lease.entry.stat().size;if(size<0n||size>512n*1024n*1024n)throw fail('TREE_FILE_LIMIT','当前 Windows 文件复制上限为 512 MiB。');byteLength=Number(size);
   const hash=createHash('sha256');for(let offset=0;offset<byteLength;){const chunk=lease.entry.readAt(offset,Math.min(1024*1024,byteLength-offset));if(!chunk.length)throw fail('FS_SOURCE_CHANGED','源文件长度已变化。');hash.update(chunk);offset+=chunk.length;await new Promise(resolve=>setImmediate(resolve));}digest=hash.digest('hex');
  }
  await lease.verify();return {identity:lease.identity,directory:lease.directory,digest,byteLength};
 }finally{try{tree?.close();}finally{lease.close();}}
}
