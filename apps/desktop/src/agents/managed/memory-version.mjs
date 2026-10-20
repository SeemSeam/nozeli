import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {safeBytes} from './execution-workspace.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

// Root-linked topics are the shared memory dependency set. Stat identities are
// checked each delivery; unchanged files reuse their content digest, not a scan.
export class MemoryVersion {
 constructor(root){this.root=root;this.cache=new Map();}
 async file(rel){
  const file=path.join(this.root,rel);let stat;
  try{stat=await fs.lstat(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return {path:rel,digest:null,text:null};throw error;}
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('记忆来源必须是普通文件：'+rel);
  const identity=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
  const cached=this.cache.get(rel);if(cached?.identity===identity)return cached.value;
  const bytes=await safeBytes(this.root,rel);if(bytes===null)throw Error('记忆来源读取期间变化：'+rel);
  const after=await fs.lstat(file,{bigint:true});
  if([after.dev,after.ino,after.size,after.mtimeNs,after.ctimeNs].join(':')!==identity)throw Error('记忆来源读取期间变化：'+rel);
  const value={path:rel,digest:digest(bytes),text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
  this.cache.set(rel,{identity,value});return value;
 }
 async snapshot(){
  const root=await this.file('plan-tree.md');
  const paths=[...new Set([...String(root.text??'').matchAll(/\]\((topics\/[A-Za-z0-9_-]+\.md)\)/g)].map(m=>m[1]))].sort();
  const topics=await Promise.all(paths.map(rel=>this.file(rel)));
  const version=digest(JSON.stringify([root,...topics].map(({path,digest})=>({path,digest}))));
  return {version,root,topics};
 }
}
