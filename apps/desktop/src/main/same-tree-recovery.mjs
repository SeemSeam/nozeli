import {createHash,randomUUID} from 'node:crypto';
import {inspectWindowsSameRecovery} from '../platform/windows/same-tree-recovery.mjs';
import {validatePptTreePlan} from './ppt-tree-recovery.mjs';
const sum=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pathKey=value=>createHash('sha256').update(value).digest('hex');
const changed=()=>Object.assign(Error('文件操作、元数据或草稿已变化，请重新核对；当前赢家和原恢复资料保留。'),{code:'TREE_RECOVERY_CHANGED'});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const relative=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\\:\x00-\x1f]/.test(value)&&value.split('/').length<=128&&value.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!p.startsWith('.'));
const binding=p=>sum([p.id,p.instanceId,p.root,p.identity,p.metadataIdentity]);
const collections=['file_tags','file_changes','provenance'];
const rows=value=>{
 if(!Array.isArray(value)||value.length>100000)throw changed();
 const map=new Map();for(const row of value){if(!row||typeof row.id!=='string'||!row.id||map.has(row.id)||row.value===undefined)throw changed();map.set(row.id,row.value);}return map;
};
const same=(a,b)=>sum(a??null)===sum(b??null);
export class SameTreeRecovery{
 constructor(host,{now=()=>Date.now(),inspect=inspectWindowsSameRecovery,workspace}={}){Object.assign(this,{host,now,inspect,workspace});this.tokens=new Map();}
 owns(token){return this.tokens.has(token);}
 locked(id,run){const work=()=>this.host.storage.withProjectOperation(id,()=>this.host.projectLock(id)(()=>this.host.metaLock(run)));return this.host.track(this.workspace?this.workspace.serial(id,work):work());}
 async group(id,key,options,{allowTerminal=false}={}){
  const row=await this.host.storage.readRecoveryRecord(id,key,{...options,maxBytes:8*1024*1024,purpose:options?.version?'recovery-ui':'same-tree-recovery'}),v=row?.value,p=await this.host.requireProject(id);
  if(!v||v.schema!==1||v.kind!=='record'||v.sameProject!==true||v.projectId!==id||!uuid(v.operationId)||key!=='tree-operation:'+v.operationId||v.projectBinding!==binding(p)||!relative(v.destination)||v.clipboardImport!==undefined||v.crossTransfer!==undefined||!['intent','prepared','allocated','published','metadata-committed','needs-attention',...(allowTerminal?['complete','refused']:[])].includes(v.phase))throw changed();
  if(v.creation===true){if(v.transfer!==undefined||!['createFile','createFolder'].includes(v.action)||v.relPath!==v.destination||v.metadata!==undefined||v.drafts!==undefined||v.pptDrafts!==undefined)throw changed();}
  else{
   if(v.transfer!==true||v.creation!==undefined||!['copy','cut','rename'].includes(v.action)||!relative(v.source)||v.relPath!==v.source||v.source===v.destination||!Array.isArray(v.drafts)||v.drafts.length>10000||!v.metadata||Object.keys(v.metadata.before??{}).sort().join()!==collections.slice().sort().join()||Object.keys(v.metadata.after??{}).sort().join()!==collections.slice().sort().join())throw changed();
   const seen=new Set();for(const draft of v.drafts){const rel=draft.value?.relPath;if(!relative(rel)||!(rel===v.source||rel.startsWith(v.source+'/'))||draft.id!=='draft:'+pathKey(rel)||draft.next!=='draft:'+pathKey(v.destination+rel.slice(v.source.length))||!same(draft.nextValue,{...draft.value,relPath:v.destination+rel.slice(v.source.length)})||!Number.isSafeInteger(draft.revision)||draft.revision<1||!Number.isSafeInteger(draft.nextRevision)||draft.nextRevision<0||seen.has(draft.id)||seen.has(draft.next))throw changed();seen.add(draft.id);seen.add(draft.next);}
   if(v.action==='copy'&&v.drafts.length)throw changed();
   if(v.pptDrafts!==undefined)validatePptTreePlan(v.pptDrafts,v.source,v.destination,v.action);
   for(const c of collections){
    const before=rows(v.metadata.before[c]),after=rows(v.metadata.after[c]);
    for(const id of new Set([...before.keys(),...after.keys()])){
     if(same(before.get(id),after.get(id)))continue;
     const old=before.get(id),next=after.get(id),rel=old?(c==='file_tags'?old.file?.relPath:old.relPath):(c==='file_tags'?next?.file?.relPath:next?.relPath);
     if(!relative(rel)||id!==(c==='provenance'?rel:pathKey(rel)))throw changed();
     if(old&&(!(rel===v.source||rel.startsWith(v.source+'/'))||v.action==='copy'||next!==undefined)||next&&(!(rel===v.destination||rel.startsWith(v.destination+'/'))||old!==undefined)||v.action==='copy'&&c==='provenance')throw changed();
    }
   }
  }
  return {row,record:v,project:p,sourceProject:p};
 }
 async reconcileSurfaces(id,operationId){
  if(!this.workspace||!uuid(operationId))throw changed();
  return this.locked(id,async()=>{
   const group=await this.group(id,'tree-operation:'+operationId,undefined,{allowTerminal:true});
   if(!['complete','refused'].includes(group.record.phase))throw Object.assign(Error('原文件操作仍待核对，请先在本机恢复设置中确认。'),{code:'RECOVERY_UNAVAILABLE'});
   const emptyRefusal=group.record.phase==='refused'&&!group.record.effect;
   const custody=emptyRefusal?{proof:{decision:'retain-aborted-intent'},verify:async()=>{},close:()=>{}}:await this.inspect(this.host,group.project,group.record);let surfaces;
   try{
    if(custody.proof.decision.startsWith('keep-published-')!==(group.record.phase==='complete'))throw changed();
    surfaces=await this.workspace.treeRecovery.prepare(group,custody);await custody.verify();await surfaces.verify();
    const current=await this.group(id,group.row.id,undefined,{allowTerminal:true});if(current.row.revision!==group.row.revision||sum(current.record)!==sum(group.record))throw changed();
    return await surfaces.apply();
   }finally{try{surfaces?.close();}finally{custody.close();}}
  });
 }
 async plan(group,published){
  const v=group.record,storage=this.host.storage,expected={},next={},drafts=[];
  if(v.transfer){
   for(const c of collections){
    const before=rows(v.metadata.before[c]),after=rows(v.metadata.after[c]),current=rows((await storage.listProject(v.projectId,c)).map(({id,value})=>({id,value}))),desired=new Map(current);
    for(const id of new Set([...before.keys(),...after.keys()])){
     if(same(before.get(id),after.get(id)))continue;
     const now=current.get(id);
     if(published){if(!same(now,before.get(id))&&!same(now,after.get(id)))throw changed();if(after.has(id))desired.set(id,after.get(id));else desired.delete(id);}
     else if(!same(now,before.get(id)))throw changed();
    }
    const sorted=m=>[...m].sort(([a],[b])=>a.localeCompare(b)).map(([id,value])=>({id,value}));expected[c]=sorted(current);next[c]=sorted(desired);
   }
   for(const d of [...v.drafts,...(v.pptDrafts??[])]){
    const source=await storage.readRecoveryRecord(v.projectId,d.id),target=await storage.readRecoveryRecord(v.projectId,d.next);
    if(published){
     if(source?.value!=null&&!same(source.value,d.value)||target?.value!=null&&!same(target.value,d.nextValue)||source?.value==null&&target?.value==null)throw changed();
     if(source?.value!=null&&source.revision!==d.revision||target?.value!=null&&target.revision!==d.nextRevision+1||source?.value==null&&source&&source.revision!==d.revision+1||target?.value==null&&(target?.revision??0)!==d.nextRevision)throw changed();
    }else if(!same(source?.value,d.value)||source?.revision!==d.revision||target?.value!=null||(target?.revision??0)!==d.nextRevision)throw changed();
    drafts.push({id:d.id,next:d.next,sourceRevision:source?.revision??0,targetRevision:target?.revision??0,sourceValue:source?.value??null,targetValue:target?.value??null,nextValue:d.nextValue});
   }
  }
  return {expected,next,drafts};
 }
 async preview(input,owner,guard=()=>{}){
  return this.locked(input.projectId,async()=>{
   await guard();const group=await this.group(input.projectId,input.id,{revision:input.revision,version:input.version}),custody=await this.inspect(this.host,group.project,group.record);
   try{
    const published=custody.proof.decision.startsWith('keep-published-');if(!published&&(group.record.effect?.published||group.record.error?.committed))throw changed();
    const metadata=await this.plan(group,published);await custody.verify();await guard();const token=randomUUID(),expiresAt=this.now()+300000;
    for(const [id,p]of this.tokens)if(p.expiresAt<=this.now())this.tokens.delete(id);
    if(this.tokens.size>=32)throw Object.assign(Error('核对窗口较多，请关闭旧核对后重试。'),{code:'TREE_RECOVERY_LIMIT'});
    this.tokens.set(token,{owner,expiresAt,input:{projectId:input.projectId,id:input.id},revision:group.row.revision,recordDigest:sum(group.record),proofDigest:custody.proofDigest,planDigest:sum(metadata),published});
    return {token,expiresAt,destination:group.record.destination,decision:custody.proof.decision,records:1,stageRetained:custody.proof.stageRetained,namespaceChanged:false,metadataChanged:published&&group.record.transfer===true,message:published?(group.record.transfer?'已核对原操作的文件身份和完整内容。确认后补齐原计划中的标签、历史和草稿迁移，保留其他内容并结束所选记录；不会再次移动或复制文件。':'已核对原新建对象的身份及空内容。确认后保留该对象并结束所选记录。'):'本次文件操作不再继续。确认后保留原文件、当前目标、元数据、草稿和全部暂存数据，并结束所选记录。'};
   }finally{custody.close();}
  });
 }
 async settle(input,owner,guard=()=>{}){
  const token=this.tokens.get(input.token);if(!token||token.owner!==owner||token.expiresAt<=this.now())throw Object.assign(Error('核对已失效，请重新查看。'),{code:'TREE_RECOVERY_EXPIRED'});this.tokens.delete(input.token);
  return this.locked(token.input.projectId,async()=>{
   await guard();const group=await this.group(token.input.projectId,token.input.id);if(group.row.revision!==token.revision||sum(group.record)!==token.recordDigest)throw changed();
   const custody=await this.inspect(this.host,group.project,group.record);let surfaces;
   try{
    const plan=await this.plan(group,token.published);if(custody.proofDigest!==token.proofDigest||sum(plan)!==token.planDigest)throw changed();await custody.verify();await guard();
    surfaces=await this.workspace?.treeRecovery.prepare(group,custody);
    const verify=async()=>{await custody.verify();await surfaces?.verify();};
    const storage=this.host.storage,id=group.project.id;
    const updates=[];
    if(token.published&&group.record.transfer){
     await storage.replaceProjectCollections(id,plan.next,{expectedCollections:plan.expected});
     for(const d of plan.drafts){
      await verify();await guard();
      // Include unchanged target/source rows in the CAS read set as well.
      updates.push({id:d.next,value:d.nextValue,expectedRevision:d.targetRevision},{id:d.id,value:null,expectedRevision:d.sourceRevision});
     }
    }
    await verify();await guard();storage.assertActive(id);
    updates.push({id:group.row.id,value:{...group.record,phase:token.published?'complete':'refused',reconciliation:{schema:1,requestId:input.token,decision:custody.proof.decision,previousRevision:group.row.revision,previousDigest:sum(group.record),proof:custody.proof,reconciledAt:new Date(this.now()).toISOString(),namespaceChanged:false}},expectedRevision:group.row.revision});
    await storage.putRecoveryRecords(id,updates);
    const surfaceRecovery=surfaces?await surfaces.apply():{resumed:0,moved:0,retained:0};
    return {settled:true,projectId:id,destination:group.record.destination,decision:custody.proof.decision,records:1,stageRetained:custody.proof.stageRetained,namespaceChanged:false,surfaceRecovery};
   }finally{try{surfaces?.close();}finally{custody.close();}}
  });
 }
}
