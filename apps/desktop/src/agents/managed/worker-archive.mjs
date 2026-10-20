import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const privateKey=/^(?:readHandle|token|apiKey|authorization|headers|collabAttempts|providers|sessionFile|home|artifactDirectory|directory|commonDir|repo|gitDir|workerGitDir|binding|transport|nonce)$/i;
export function publicArchive(value){
 if(Array.isArray(value))return value.map(publicArchive);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>!privateKey.test(key)).map(([key,item])=>[key,publicArchive(item)]));
}
export async function loadWorkerArchive(runtime,work,archiveId){
 const archive=work?.threadArchive?.find(row=>row.id===archiveId);
 if(!archive||!(/^[a-f0-9-]{36}$/i.test(archive.dossierObjectId)||/^[a-f0-9]{64}$/.test(archive.dossierObjectId)))fail('ARCHIVE_IDENTITY','Invalid Worker history identity');
 const file=path.join(runtime,'objects',archive.dossierObjectId+'.json');const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024*1024)fail('ARCHIVE_UNSAFE','Worker history is unsafe or exceeds the archive budget');
 const bytes=await fs.readFile(file),expected=archive.dossierDigest??(/^[a-f0-9]{64}$/.test(archive.dossierObjectId)?archive.dossierObjectId:null);
 if(!expected)fail('ARCHIVE_UNVERIFIED','Historical dossier has no original content digest; retained for explicit recovery');
 if(digest(bytes)!==expected)fail('ARCHIVE_CORRUPT','Worker handoff archive changed; original source retained');
 const dossier=JSON.parse(bytes);
 if(dossier.workId!==work.id||dossier.archiveId!==archiveId)fail('ARCHIVE_IDENTITY','Worker archive ownership mismatch');
 return {archive,dossier,digest:expected};
}
export async function readWorkerArchive(runtime,work,{archiveId,offset=0,version}={}){
 const saved=await loadWorkerArchive(runtime,work,archiveId);
 const text=JSON.stringify(publicArchive(saved.dossier),null,2),publicVersion=digest(text);
 if(version&&version!==publicVersion)fail('ARCHIVE_CHANGED','History version changed; reload the original page');
 if(!Number.isSafeInteger(offset)||offset<0||offset>text.length||offset&&/[\uDC00-\uDFFF]/.test(text[offset]))fail('ARCHIVE_OFFSET','Invalid Worker history offset');
 let end=Math.min(text.length,offset+10000);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
 return {readOnly:true,workId:work.id,archiveId,version:publicVersion,text:text.slice(offset,end),offset,endOffset:end,totalChars:text.length,nextOffset:end<text.length?end:null};
}
