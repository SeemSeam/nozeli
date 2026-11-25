import {createHash} from 'node:crypto';
import {validatePptDraftRecord} from './ppt-drafts.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const indexKey=rel=>'ppt-versions:'+hash(rel);
const modelKey=(rel,digest)=>'ppt:'+hash(rel+'\0'+digest);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const relative=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\\:\x00-\x1f]/.test(value)&&value.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!p.startsWith('.'));
const changed=()=>Object.assign(Error('PPT 草稿迁移资料已变化，原稿和目标均保留。'),{code:'TREE_RECOVERY_CHANGED'});
// Reuse the tree receipt and its atomic recovery CAS. No PPT model is silently
// rebound to a new source version, and an independent target is never replaced.
export function validatePptTreePlan(plans,source,destination,action){
 if(!Array.isArray(plans)||plans.length>10000||action==='copy'&&plans.length)throw changed();
 const seen=new Set(),expected=new Map();
 for(const row of plans){
  if(!row||typeof row.id!=='string'||seen.has(row.id)||seen.has(row.next)||!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.nextRevision)||row.nextRevision<0)throw changed();
  seen.add(row.id);seen.add(row.next);
  if(row.id.startsWith('ppt-versions:')){
   const v=row.value,rel=v?.relPath;
   if(!relative(rel)||!(rel===source||rel.startsWith(source+'/'))||v.schema!==1||row.id!==indexKey(rel)||row.next!==indexKey(destination+rel.slice(source.length))||!Array.isArray(v.versions)||!v.versions.length||v.versions.length>10000||!same(row.nextValue,{...v,relPath:destination+rel.slice(source.length)}))throw changed();
   const versions=new Set();for(const version of v.versions){if(!digest(version.digest)||versions.has(version.digest))throw changed();versions.add(version.digest);expected.set(modelKey(rel,version.digest),{next:modelKey(destination+rel.slice(source.length),version.digest),digest:version.digest});}
  }else if(!row.id.startsWith('ppt:'))throw changed();
 }
 for(const row of plans.filter(row=>row.id.startsWith('ppt:'))){const target=expected.get(row.id),v=row.value;if(!target||row.next!==target.next||v?.sourceDigest!==target.digest||!same(row.nextValue,v))throw changed();try{validatePptDraftRecord(v);}catch{throw changed();}expected.delete(row.id);}
 if(expected.size)throw changed();
}
export async function capturePptTreePlan(storage,projectId,source,destination,action){
 if(action==='copy')return [];
 const plans=[];
 const add=async(row,next,nextValue)=>{const target=await storage.readRecoveryRecord(projectId,next);if(target?.value!=null)throw changed();plans.push({id:row.id,revision:row.revision,value:row.value,next,nextRevision:target?.revision??0,nextValue});};
 for await(const row of storage.recoveryRecords(projectId,{prefixes:['ppt-versions:']})){
  const rel=row.value?.relPath;if(typeof rel!=='string'||!(rel===source||rel.startsWith(source+'/')))continue;
  const v=row.value,newRel=destination+rel.slice(source.length);if(!Array.isArray(v.versions))throw changed();
  await add(row,indexKey(newRel),{...v,relPath:newRel});
  for(const version of v.versions){if(!digest(version.digest))throw changed();const model=await storage.readRecoveryRecord(projectId,modelKey(rel,version.digest));if(!model?.value)throw changed();await add({...model,id:modelKey(rel,version.digest)},modelKey(newRel,version.digest),model.value);}
  if(plans.length>10000)throw changed();
 }
 validatePptTreePlan(plans,source,destination,action);return plans;
}
