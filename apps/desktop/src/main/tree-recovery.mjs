import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {inspectWindowsCopyRecovery} from '../platform/windows/tree-recovery.mjs';
import {CrossTreeRecovery} from './cross-tree-recovery.mjs';
import {SameTreeRecovery} from './same-tree-recovery.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const key=value=>typeof value==='string'&&value.startsWith('tree-operation:')&&uuid(value.slice(15));
const relative=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&value.split('/').length<=128&&!/[\\:\x00-\x1f]/.test(value)&&value.split('/').every(c=>c&&c!=='.'&&c!=='..'&&!c.startsWith('.'));
const sum=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const changed=()=>fail('TREE_RECOVERY_CHANGED','记录或文件现场已变化，请重新核对；原资料保留。');
const binding=project=>sum([project.id,project.instanceId,project.root,project.identity,project.metadataIdentity]);
export class TreeRecovery {
 constructor(host,{inspect=inspectWindowsCopyRecovery,now=()=>Date.now(),workspace}={}){Object.assign(this,{host,inspect,now});this.tokens=new Map();this.cross=new CrossTreeRecovery(host,{now,workspace});this.same=new SameTreeRecovery(host,{now,workspace});if(workspace)workspace.treeRecovery.reconcile=async(projectId,operationId)=>{const row=await host.storage.readRecoveryRecord(projectId,'tree-operation:'+operationId,{maxBytes:8*1024*1024,purpose:'tree-surface-terminal'});return row?.value.sameProject===true?this.same.reconcileSurfaces(projectId,operationId):this.cross.reconcileSurfaces(projectId,operationId);};}
 locked(projectId,run){return this.host.track(this.host.storage.withProjectOperation(projectId,()=>this.host.projectLock(projectId)(()=>this.host.metaLock(run))));}
 async group(projectId,selected,{revision,version}={}){
  const storage=this.host.storage;
  const first=await storage.readRecoveryRecord(projectId,selected,{revision,version,purpose:'recovery-ui',maxBytes:8*1024*1024});
  if(!first)throw changed();
  const primaryId=first.value?.relatedRecoveryKey??selected;
  if(!key(primaryId))throw changed();
  const primary=primaryId===selected?first:await storage.readRecoveryRecord(projectId,primaryId,{purpose:'tree-recovery',maxBytes:8*1024*1024});
  const value=primary?.value;
  if(!value||value.schema!==1||value.kind!=='record'||value.clipboardImport!==true||value.transfer!==true||value.action!=='copy'||value.projectId!==projectId||!uuid(value.operationId)||primaryId!=='tree-operation:'+value.operationId||!relative(value.destination)||value.crossTransfer!==undefined||!['intent','prepared','published','needs-attention','complete','refused'].includes(value.phase))throw fail('TREE_RECOVERY_UNSUPPORTED','这条文件操作尚不能自动核对结算，请保留或导出完整记录。');
  if(value.phase==='refused'&&(value.reconciliation?.schema!==1||value.reconciliation.decision!=='retain-aborted-copy'||value.reconciliation.namespaceChanged!==false))throw changed();
  if(value.metadataPolicy!=='fresh-target; source-unchanged'||value.creation!==undefined||typeof value.source!=='string'||!path.isAbsolute(value.source)||!/^\w:\\/.test(value.source)||typeof value.sourceIdentity!=='string'||!/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(value.sourceIdentity)||!value.sourceVersion||typeof value.sourceVersion!=='object')throw changed();
  const rows=new Map([[primary.id,primary]]);let cursor=null,seen=0,total=primary.byteLength;
  do{
   const page=await storage.recoveryPage(projectId,{cursor,prefixes:['tree-operation:'],pendingOnly:true,limit:50,maxBytes:64*1024,purpose:'tree-recovery'});
   for(const entry of page.entries){
    if(++seen>256)throw fail('TREE_RECOVERY_LIMIT','待核对记录较多，请先导出检查；本次未结算。');
    if(entry.id===primary.id||entry.value.operationId!==value.operationId)continue;
    const row=await storage.readRecoveryRecord(projectId,entry.id,{revision:entry.revision,version:page.version,purpose:'tree-recovery',maxBytes:8*1024*1024}),hold=row?.value;
    if(!row||!key(row.id)||hold.schema!==1||hold.kind!=='record'||hold.clipboardImport!==true||hold.relatedRecoveryKey!==primary.id||hold.operationId!==value.operationId||hold.projectId!==projectId||hold.destination!==value.destination||hold.phase!=='needs-attention'||typeof hold.published!=='boolean'||typeof hold.commitUnknown!=='boolean')throw changed();
    total+=row.byteLength;if(total>16*1024*1024)throw fail('TREE_RECOVERY_LIMIT','恢复资料超过本次核对预算，原记录保留。');rows.set(row.id,row);
   }
   cursor=page.nextCursor;
  }while(cursor);
  if(!rows.has(selected)||[...rows.values()].every(row=>['complete','refused'].includes(row.value.phase)))throw changed();
  return {primary,rows:[...rows.values()].sort((a,b)=>a.id===primary.id?-1:b.id===primary.id?1:a.id.localeCompare(b.id))};
 }
 references(group){return group.rows.map(row=>({id:row.id,revision:row.revision,digest:sum(row.value)}));}
 async preview(input,owner,guard=()=>{}){
  if(!input||Object.keys(input).some(k=>!['projectId','id','revision','version'].includes(k))||!uuid(input.projectId)||!key(input.id)||!Number.isSafeInteger(input.revision)||input.revision<1||typeof input.version!=='string'||!/^[a-f0-9]{64}$/.test(input.version)||typeof owner!=='string'||!owner)throw fail('INVALID_RECOVERY_CONFIRMATION','需要选择当前恢复记录。');
  const selected=await this.host.storage.readRecoveryRecord(input.projectId,input.id,{revision:input.revision,version:input.version,purpose:'recovery-ui',maxBytes:8*1024*1024});
  if(selected?.value.crossTransfer===true)return this.cross.preview(input,owner,guard);
  if(selected?.value.sameProject===true)return this.same.preview(input,owner,guard);
  return this.locked(input.projectId,async()=>{
   await guard();
   const project=await this.host.requireProject(input.projectId),group=await this.group(input.projectId,input.id,input),custody=await this.inspect(this.host,project,group.primary.value);
   try{
    await custody.verify();await guard();if(custody.proof.decision==='retain-aborted-copy'&&group.rows.some(row=>row.value.published===true||row.value.error?.committed===true))throw changed();const token=randomUUID(),expiresAt=this.now()+300000;
    for(const [id,item]of this.tokens)if(item.expiresAt<=this.now())this.tokens.delete(id);
    if(this.tokens.size>=32)throw fail('TREE_RECOVERY_LIMIT','核对窗口较多，请关闭旧核对后重试。');
    this.tokens.set(token,{owner,expiresAt,projectId:project.id,selected:input.id,binding:binding(project),references:this.references(group),proofDigest:custody.proofDigest,decision:custody.proof.decision});
    const published=custody.proof.decision==='keep-published-copy';
    return {token,expiresAt,destination:group.primary.value.destination,decision:custody.proof.decision,records:group.rows.length,stageRetained:custody.proof.stageRetained,message:published?'已核对原副本的文件身份和完整内容。确认后保留该副本并结束所选待核对记录。':'本次复制不再继续。确认后保留当前目标和全部暂存数据，并结束所选待核对记录。',namespaceChanged:false};
   }finally{custody.close();}
  });
 }
 async settle(input,owner,guard=()=>{}){
  if(!input||Object.keys(input).some(k=>!['token','confirmed'].includes(k))||input.confirmed!==true)throw fail('INVALID_RECOVERY_CONFIRMATION','需要明确确认核对结果。');
  if(this.cross.owns(input.token))return this.cross.settle(input,owner,guard);
  if(this.same.owns(input.token))return this.same.settle(input,owner,guard);
  const plan=this.tokens.get(input.token);if(!plan||plan.owner!==owner||plan.expiresAt<=this.now())throw fail('TREE_RECOVERY_EXPIRED','核对已失效，请重新查看。');
  this.tokens.delete(input.token);
  return this.locked(plan.projectId,async()=>{
   await guard();
   const project=await this.host.requireProject(plan.projectId);if(binding(project)!==plan.binding)throw changed();
   const group=await this.group(plan.projectId,plan.selected);
   if(sum(this.references(group))!==sum(plan.references))throw changed();
   const custody=await this.inspect(this.host,project,group.primary.value);
   try{
    if(custody.proofDigest!==plan.proofDigest)throw changed();await custody.verify();
    const phase=plan.decision==='keep-published-copy'?'complete':'refused',reconciledAt=new Date(this.now()).toISOString(),settled=[];
    for(const row of group.rows){
     if(row.value.phase===phase)continue;
     await custody.verify();await guard();this.host.storage.assertActive(project.id);
     await this.host.storage.putRecovery(project.id,row.id,{...row.value,phase,reconciliation:{schema:1,requestId:input.token,decision:plan.decision,previousPhase:row.value.phase,previousRevision:row.revision,previousDigest:sum(row.value),proof:custody.proof,reconciledAt,namespaceChanged:false}},{expectedRevision:row.revision});settled.push(row.id);
    }
    return {settled:true,projectId:project.id,destination:group.primary.value.destination,decision:plan.decision,records:settled.length,stageRetained:custody.proof.stageRetained,namespaceChanged:false};
   }finally{custody.close();}
  });
 }
}
