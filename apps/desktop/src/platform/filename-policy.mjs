// Compare target names using the target filesystem itself, not Unicode folding.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {platformNative} from './native.mjs';
import {DIR_FLAGS,entry,openAt,statAt,mkdirAt,readDirectory,removeTreeAt,openDirectoryChain} from './directory-fs.mjs';
const reject=(code,message)=>{throw Object.assign(Error(message),{code});};
export function reservedSegment(name){return ['.git','.nozeli','.ccb','node_modules','.venv','venv','__pycache__'].includes(name.normalize('NFC').toLowerCase());}
export async function assertExactEntry(fd,name){
  if(process.platform!=='darwin')return;
  const wanted=await statAt(entry(fd,name),{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!wanted)return;
  const names=await readDirectory(fd);if(names.includes(name))return;
  for(const actual of names){const stat=await statAt(entry(fd,actual),{bigint:true});if(stat.dev===wanted.dev&&stat.ino===wanted.ino)reject('PATH_ALIAS','文件名拼写与现存目录项不同，已保留原文件：'+name+' / '+actual);}
  reject('SOURCE_CHANGED','目录在文件名检查期间变化');
}
export async function assertManagedEntry(fd,name){
  if(reservedSegment(name))reject('PATH_REJECTED','受限目录：'+name);
  await assertExactEntry(fd,name);
  if(process.platform!=='darwin')return;
  const wanted=await statAt(entry(fd,name),{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!wanted)return;
  for(const reserved of ['.git','.nozeli','.ccb','node_modules','.venv','venv','__pycache__']){
    const current=await statAt(entry(fd,reserved),{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(current?.dev===wanted.dev&&current.ino===wanted.ino)reject('PATH_REJECTED','受限目录的文件系统别名：'+name);
  }
}
// Probe an entire plan before writing any target. Scratch is private, empty at
// creation, descriptor-relative, and removed without following substituted links.
export async function assertUniqueTargets(root,paths,{checkExisting=true}={}){
  if(process.platform!=='darwin')return;
  const chain=await openDirectoryChain(root),probeName='.nozeli-names-'+randomUUID(),probeRef=entry(chain.directory.fd,probeName);let probe,probeIdentity;
  try{
    const volume=platformNative().volume(chain.directory.fd);
    if(volume.type!=='apfs'||!volume.exclusiveRename)reject('FILENAME_SEMANTICS_UNVERIFIED','此目标卷的文件名与原子发布语义尚未验证：'+volume.type);
    await mkdirAt(probeRef,{mode:0o700});probe=await openAt(probeRef,DIR_FLAGS);probeIdentity=await probe.stat({bigint:true});
    const seen=new Map(),exact=new Set();
    try{
      for(const rel of paths){
        if(typeof rel!=='string'||path.isAbsolute(rel)||rel.split('/').some(p=>!p||p==='.'||p==='..'||p.includes('\0')))reject('PATH_REJECTED','非法目标路径');
        if(exact.has(rel))reject('TARGET_NAME_CONFLICT','目标重复：'+rel);exact.add(rel);
        let fd=probe.fd;const parts=rel.split('/'),opened=[];
        try{
        for(let i=0;i<parts.length;i++){
          const name=parts[i],ref=entry(fd,name),directory=i<parts.length-1;
          try{if(directory)await mkdirAt(ref,{mode:0o700});else{const f=await openAt(ref,'wx',0o600);await f.close();}}
          catch(error){if(error.code!=='EEXIST')throw error;}
          const stat=await statAt(ref,{bigint:true}),key=stat.dev+':'+stat.ino,spelling=parts.slice(0,i+1).join('/'),prior=seen.get(key);
          if(prior&&prior!==spelling||stat.isDirectory()!==directory)reject('TARGET_NAME_CONFLICT','目标卷不能区分这些路径：'+(prior??spelling)+' / '+spelling);
          seen.set(key,spelling);
          if(directory){const dir=await openAt(ref,DIR_FLAGS);opened.push(dir);fd=dir.fd;}
        }
        }finally{for(const h of opened.reverse())await h.close();}
        if(checkExisting){
          const current=[];let dir=chain.directory;
          try{for(let i=0;i<parts.length;i++){await assertExactEntry(dir.fd,parts[i]);if(i<parts.length-1){let child;try{child=await openAt(entry(dir.fd,parts[i]),DIR_FLAGS);}catch(error){if(error.code==='ENOENT')break;throw error;}current.push(child);dir=child;}}}
          finally{for(const h of current.reverse())await h.close();}
        }
      }
      await chain.verify();
    }finally{await probe.close();probe=null;}
  }finally{if(probe)await probe.close();try{if(probeIdentity)await removeTreeAt(probeRef,{expected:probeIdentity});}finally{await chain.close();}}
}
