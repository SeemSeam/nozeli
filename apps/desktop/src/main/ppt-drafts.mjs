import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
const engine='82ecf10040ca8da67832f173b58d3baf5da59887';
const keyOf=(rel,digest)=>'ppt:'+createHash('sha256').update(rel+'\0'+digest).digest('hex');
const indexOf=rel=>'ppt-versions:'+createHash('sha256').update(rel).digest('hex');
const digestOf=bytes=>createHash('sha256').update(bytes).digest('hex');
async function digestFile(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function versions(host,projectId,relPath){const record=await host.storage.getRecovery(projectId,indexOf(relPath));if(!record)return [];if(record.schema!==1||record.relPath!==relPath||!Array.isArray(record.versions))throw Error('PPTX 草稿索引异常；原草稿保留');return record.versions;}
function compatible(record){if(record&&(record.schema!=='nozeli-pptist-draft-v1'||record.engine!==engine||!Array.isArray(record.model?.slides)||!record.model.slides.length))throw Error('PPTX 草稿版本不兼容，原草稿已保留');return record;}
export async function savePptDraft({host,projectId,relPath,digest,absolute,model}){
 return host.fileLock(projectId,relPath)(async()=>{
  const record={schema:'nozeli-pptist-draft-v1',engine,sourceDigest:digest,model,updatedAt:new Date().toISOString()},encoded=JSON.stringify(record);
  if(!Array.isArray(model?.slides)||!model.slides.length||Buffer.byteLength(encoded)>256*1024*1024)throw Error('PPTX 草稿无效或超过 256 MB');
  await host.storage.putRecovery(projectId,keyOf(relPath,digest),record);
  const all=await versions(host,projectId,relPath),next=[{digest,updatedAt:record.updatedAt},...all.filter(row=>row.digest!==digest)];
  await host.storage.putRecovery(projectId,indexOf(relPath),{schema:1,relPath,versions:next});
  const currentDigest=await digestFile(absolute);
  return {saved:true,sourceDigest:digest,currentDigest,sourceChanged:currentDigest!==digest};
 });
}
export async function readPptDraft({host,projectId,relPath,digest,absolute,sourceOnly=false,recoverDigest}){
 return host.fileLock(projectId,relPath)(async()=>{
  const all=await versions(host,projectId,relPath),currentDigest=await digestFile(absolute);
  if(recoverDigest!==undefined&&!all.some(row=>row.digest===recoverDigest))throw Error('所选 PPTX 草稿不属于此文件');
  const recoverable=all.filter(row=>row.digest!==digest),empty={model:null,recoverable,sourceDigest:digest,currentDigest,sourceChanged:currentDigest!==digest};
  if(sourceOnly)return empty;
  let selected=recoverDigest??digest,record=compatible(await host.storage.getRecovery(projectId,keyOf(relPath,selected)));
  if(!record&&all.some(row=>row.digest===selected))throw Error('PPTX 已索引草稿缺失；未替换为当前文件');
  if(!record&&recoverable.length&&digest===currentDigest){selected=recoverable[0].digest;record=compatible(await host.storage.getRecovery(projectId,keyOf(relPath,selected)));if(!record)throw Error('PPTX 保留草稿缺失；未替换为当前文件');}
  if(!record)return empty;
  const changed=record.sourceDigest!==currentDigest,result={model:record.model,sourceDigest:record.sourceDigest,currentDigest,sourceChanged:changed,recoverable:all.filter(row=>row.digest!==record.sourceDigest)};
  if(changed){const bytes=await host.storage.readObject(projectId,record.sourceDigest);if(digestOf(bytes)!==record.sourceDigest)throw Error('PPTX 草稿来源快照校验失败；未替换为当前文件');result.sourceBytes=bytes;}
  return result;
 });
}
