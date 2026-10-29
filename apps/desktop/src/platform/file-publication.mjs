import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {entry,openAt,statAt,renameAt,unlinkAt,retainEntryAt} from './directory-fs.mjs';
const conflict=(message,temporary)=>Object.assign(Error(message+'；编辑与恢复文件已保留：'+temporary.name),{code:'SOURCE_CHANGED',retainTemp:true,recoveryName:temporary.name});
export async function inspectEntry(ref){
 const h=await openAt(ref,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await h.stat({bigint:true});if(!before.isFile()||before.nlink!==1n)throw conflict('不是独立普通文件',ref);
  const hash=createHash('sha256');for await(const chunk of h.createReadStream({start:0,autoClose:false}))hash.update(chunk);
  const after=await h.stat({bigint:true}),current=await statAt(ref,{bigint:true});
  for(const s of [after,current])if(s.dev!==before.dev||s.ino!==before.ino||s.size!==before.size||s.mtimeNs!==before.mtimeNs||s.ctimeNs!==before.ctimeNs||s.nlink!==1n)throw conflict('核对期间文件变化',ref);
  return {digest:hash.digest('hex'),mode:Number(before.mode)&0o111?'100755':'100644',identity:before};
 }finally{await h.close();}
}
// macOS exchange preserves the object removed from the target name, allowing us
// to detect the final check-to-rename race without discarding either version.
export async function publishFileAt(temp,target,{expectedDigest,expectedMode}={}){
 if(expectedDigest==null)return renameAt(temp,target,{exclusive:true});
 if(process.platform!=='darwin')return renameAt(temp,target);
 await renameAt(temp,target,{exchange:true});
 try{
  const displaced=await inspectEntry(temp);
  if(displaced.digest!==expectedDigest||expectedMode&&displaced.mode!==expectedMode)throw conflict('发布期间原文件被并发修改',temp);
 }catch(error){
  // Another writer may have changed target again: swapping it back preserves
  // that newest object at temp as well. Never delete temp on a disputed result.
  try{await renameAt(temp,target,{exchange:true});}catch(restore){throw conflict('发布冲突且恢复名称被占用（'+restore.code+'）',temp);}
  throw conflict('发布冲突（'+error.message+'）',temp);
 }
 await retainEntryAt(temp);
}
export async function deleteFileAt(target,{expectedDigest,expectedMode}={}){
 if(process.platform!=='darwin')return unlinkAt(target);
 const backup=entry(target.directoryFd,target.name+'.nozeli-removed-'+randomUUID());
 await renameAt(target,backup,{exclusive:true});
 try{
  const removed=await inspectEntry(backup);
  if(removed.digest!==expectedDigest||expectedMode&&removed.mode!==expectedMode)throw conflict('删除期间原文件被并发修改',backup);
 }catch(error){
  try{await renameAt(backup,target,{exclusive:true});}catch{throw conflict('删除冲突，目标已出现新内容',backup);}
  throw conflict('删除冲突，原文件已恢复',backup);
 }
 await retainEntryAt(backup);
}
