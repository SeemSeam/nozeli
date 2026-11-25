import {createHash,randomUUID} from 'node:crypto';
import {inspectWindowsCrossRecovery} from '../platform/windows/cross-tree-recovery.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code});
const changed=()=>fail('TREE_RECOVERY_CHANGED','跨项目记录或文件现场已变化，请重新核对；原资料保留。');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const key=value=>typeof value==='string'&&value.startsWith('tree-operation:')&&uuid(value.slice(15));
const relative=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&value.split('/').length<=128&&!/[\\:\x00-\x1f]/.test(value)&&value.split('/').every(c=>c&&c!=='.'&&c!=='..'&&!c.startsWith('.'));
const sum=value=>createHash('sha256').update(JSON.stringify(value)??'undefined').digest('hex');
const binding=p=>sum([p.id,p.instanceId,p.root,p.identity,p.metadataIdentity]);
const phases=new Set(['intent','prepared','published','acknowledged','needs-attention','complete','refused']);
const acknowledged=(value,phase)=>value.phase===phase&&(phase==='complete'||value.reconciliation?.schema===1&&value.reconciliation.decision?.startsWith('retain-aborted-')&&value.reconciliation.namespaceChanged===false);
const publishedClaim=value=>value.published===true||value.effect?.published===true||value.error?.committed===true||['published','acknowledged','complete'].includes(value.phase);

export class CrossTreeRecovery {
 constructor(host,{inspect=inspectWindowsCrossRecovery,now=()=>Date.now(),workspace}={}){Object.assign(this,{host,inspect,now,workspace});this.tokens=new Map();}
 owns(token){return this.tokens.has(token);}
 locked(ids,run){
  const ordered=[...new Set(ids)].sort();
  const locks=ordered.reduceRight((work,id)=>()=>this.host.projectLock(id)(work),()=>this.host.metaLock(run));
  const tracked=ordered.reduceRight((work,id)=>()=>this.host.storage.withProjectOperation(id,work),locks);
  const serial=this.workspace?ordered.reduceRight((work,id)=>()=>this.workspace.serial(id,work),tracked):tracked;
  return this.host.track(serial());
 }
 async group(projectId,id,options={},{allowTerminal=false}={}){
  const storage=this.host.storage,selected=await storage.readRecoveryRecord(projectId,id,{...options,purpose:'recovery-ui',maxBytes:8*1024*1024}),value=selected?.value;
  if(!value||value.schema!==1||value.kind!=='record'||value.crossTransfer!==true||value.transfer!==true||!uuid(value.operationId)||id!=='tree-operation:'+value.operationId||!uuid(value.sourceProjectId)||!uuid(value.destinationProjectId)||value.sourceProjectId===value.destinationProjectId||![value.sourceProjectId,value.destinationProjectId].includes(projectId))throw fail('TREE_RECOVERY_UNSUPPORTED','这条跨项目记录尚不能核对结算，请保留或导出完整记录。');
  const sourceProject=await this.host.requireProject(value.sourceProjectId),project=await this.host.requireProject(value.destinationProjectId),sourceRow=projectId===sourceProject.id?selected:await storage.readRecoveryRecord(sourceProject.id,id,{maxBytes:8*1024*1024,purpose:'cross-tree-recovery'}),destinationRow=projectId===project.id?selected:await storage.readRecoveryRecord(project.id,id,{maxBytes:8*1024*1024,purpose:'cross-tree-recovery'}),registry=await storage.readCrossTreeTransfer(id,{maxBytes:8*1024*1024});
  if(!sourceRow||!destinationRow||!registry)throw changed();
  const canonical=v=>[v.schema,v.kind,v.transfer,v.crossTransfer,v.operationId,v.action,v.source,v.sourceProjectId,v.destination,v.destinationProjectId,v.sourceBinding,v.destinationBinding,v.metadataPolicy,v.sourceDisposition,v.createdAt,v.surfaceRecovery];
  for(const [row,p,role,rel]of [[sourceRow,sourceProject,'source',value.source],[destinationRow,project,'destination',value.destination]]){
   const v=row.value;
   if(sum(canonical(v))!==sum(canonical(value))||v.projectId!==p.id||v.role!==role||v.relPath!==rel||v.clipboardImport!==undefined||v.creation!==undefined||!phases.has(v.phase))throw changed();
  }
  if(!['copy','cut'].includes(value.action)||!relative(value.source)||!relative(value.destination)||value.metadataPolicy!=='fresh-destination-document-identities; source-metadata-and-recovery-retained'||value.sourceDisposition!==(value.action==='cut'?'same-volume-native-move':'unchanged')||typeof value.createdAt!=='string'||value.createdAt.length>64||value.sourceBinding?.instanceId!==sourceProject.instanceId||sum(value.sourceBinding?.identity)!==sum(sourceProject.identity)||value.destinationBinding?.instanceId!==project.instanceId||sum(value.destinationBinding?.identity)!==sum(project.identity))throw changed();
  const g=registry.value;
  if(g?.schema!==1||g.kind!=='record'||g.crossTransfer!==true||g.operationId!==value.operationId||g.projectId!==project.id||g.sourceProjectId!==sourceProject.id||g.sourceInstanceId!==sourceProject.instanceId||g.destinationInstanceId!==project.instanceId||g.action!==value.action||g.source!==value.source.slice(0,128)||g.destination!==value.destination.slice(0,128)||g.createdAt!==value.createdAt||!phases.has(g.phase)||typeof g.published!=='boolean'||typeof g.settled!=='boolean')throw changed();
  const finalRegistry=g.settled===true&&(g.phase==='complete'&&g.published===true&&g.sourceReceipt==='acknowledged'&&g.destinationReceipt==='acknowledged'||g.phase==='refused'&&g.published===false);
  if(g.settled&&!finalRegistry)throw changed();
  if(!allowTerminal&&finalRegistry&&[sourceRow,destinationRow].every(row=>['complete','refused'].includes(row.value.phase)))throw changed();
  // Phase-skew is expected after interruption, conflicting physical identities
  // or complete manifests are not. Choose the fullest compatible observation.
  const effects=[sourceRow.value.effect,destinationRow.value.effect].filter(e=>e!=null);
  for(const field of ['kind','identity','sourceIdentity','digest','byteLength','stagingName']){
   const values=effects.map(e=>e[field]).filter(v=>v!=null);if(new Set(values.map(sum)).size>1)throw changed();
  }
  for(const field of ['manifest','stageManifest']){
   const values=effects.map(e=>e[field]?.sha256).filter(v=>v!=null);if(new Set(values).size>1)throw changed();
  }
  for(const e of effects)if(e.schema!==1||e.action!==value.action||e.operationId!==value.operationId||e.projectId!==project.id||e.sourceProjectId!==sourceProject.id||e.source!==value.source||e.destination!==value.destination||typeof e.published!=='boolean')throw changed();
  const score=e=>Number(e.published)*100+Number(e.stageManifest!=null)*20+Number(e.digest!=null)*10+Number(e.identity!=null);
  effects.sort((a,b)=>score(b)-score(a));const effect=effects[0]??null;
  for(const field of ['identity','sourceIdentity','digest'])if(g[field]!=null&&g[field]!==effect?.[field])throw changed();
  const total=sourceRow.byteLength+destinationRow.byteLength+registry.byteLength;if(total>24*1024*1024)throw fail('TREE_RECOVERY_LIMIT','跨项目恢复资料超过本次核对预算，原记录保留。');
  return {sourceProject,project,sourceRow,destinationRow,registry,finalRegistry,record:{...value,projectId:project.id,effect}};
 }
 references(group){return [group.sourceRow,group.destinationRow,group.registry].map(row=>({id:row.id,revision:row.revision,digest:sum(row.value)}));}
 async reconcileSurfaces(projectId,operationId){
  if(!this.workspace||!uuid(operationId))throw changed();
  const id='tree-operation:'+operationId,first=await this.group(projectId,id,{},{allowTerminal:true});
  return this.locked([first.sourceProject.id,first.project.id],async()=>{
   const group=await this.group(projectId,id,{},{allowTerminal:true});
   if(!group.finalRegistry||![group.sourceRow,group.destinationRow].every(row=>row.value.phase===group.registry.value.phase&&(group.registry.value.phase==='refused'&&!row.value.effect||acknowledged(row.value,group.registry.value.phase))))throw fail('RECOVERY_UNAVAILABLE','原文件操作仍待核对，请先在本机恢复设置中确认。');
   // A fully refused intent with no native prepared effect can only release
   // exact original source observations. No namespace action is inferred.
   const emptyRefusal=group.registry.value.phase==='refused'&&!group.record.effect;
   const custody=emptyRefusal?{proof:{destinationOwned:false,decision:'retain-aborted-intent'},verify:async()=>{},close:()=>{}}:await this.inspect(this.host,group.sourceProject,group.project,group.record);let surfaces;
   try{
    if((custody.proof.destinationOwned?'complete':'refused')!==group.registry.value.phase)throw changed();
    surfaces=await this.workspace.treeRecovery.prepare(group,custody);await custody.verify();await surfaces.verify();
    if(sum(this.references(await this.group(projectId,id,{},{allowTerminal:true})))!==sum(this.references(group)))throw changed();
    return await surfaces.apply();
   }finally{try{surfaces?.close();}finally{custody.close();}}
  });
 }
 async preview(input,owner,guard=()=>{}){
  const first=await this.group(input.projectId,input.id,{revision:input.revision,version:input.version}),ids=[first.sourceProject.id,first.project.id];
  return this.locked(ids,async()=>{
   await guard();const group=await this.group(input.projectId,input.id,{revision:input.revision,version:input.version});
   if(sum(this.references(group))!==sum(this.references(first)))throw changed();
   const custody=await this.inspect(this.host,group.sourceProject,group.project,group.record);
   try{
    await custody.verify();await guard();const published=custody.proof.destinationOwned;
    if(!published&&[group.sourceRow.value,group.destinationRow.value,group.registry.value].some(publishedClaim))throw changed();
    for(const [id,token]of this.tokens)if(token.expiresAt<=this.now())this.tokens.delete(id);
    if(this.tokens.size>=32)throw fail('TREE_RECOVERY_LIMIT','核对窗口较多，请关闭旧核对后重试。');
    const token=randomUUID(),expiresAt=this.now()+300000;
    this.tokens.set(token,{owner,expiresAt,ids,selected:input.projectId,id:input.id,bindings:[binding(group.sourceProject),binding(group.project)],references:this.references(group),proofDigest:custody.proofDigest,decision:custody.proof.decision});
    return {token,expiresAt,destination:group.record.destination,decision:custody.proof.decision,records:3,stageRetained:custody.proof.stageRetained,message:published?'已核对跨项目操作的原对象身份和完整内容。确认后保留当前结果，结束两个项目的所选记录及共同总账。':'本次跨项目操作不再继续。确认后保留原对象、当前目标和全部暂存数据，结束两个项目的所选记录及共同总账。',namespaceChanged:false};
   }finally{custody.close();}
  });
 }
 async settle(input,owner,guard=()=>{}){
  if(!input||Object.keys(input).some(k=>!['token','confirmed'].includes(k))||input.confirmed!==true)throw fail('INVALID_RECOVERY_CONFIRMATION','需要明确确认核对结果。');
  const plan=this.tokens.get(input.token);if(!plan||plan.owner!==owner||plan.expiresAt<=this.now())throw fail('TREE_RECOVERY_EXPIRED','核对已失效，请重新查看。');this.tokens.delete(input.token);
  return this.locked(plan.ids,async()=>{
   await guard();const group=await this.group(plan.selected,plan.id);
   if(sum([binding(group.sourceProject),binding(group.project)])!==sum(plan.bindings)||sum(this.references(group))!==sum(plan.references))throw changed();
   const custody=await this.inspect(this.host,group.sourceProject,group.project,group.record);
   let surfaces;
   try{
    if(custody.proofDigest!==plan.proofDigest)throw changed();await custody.verify();
    surfaces=await this.workspace?.treeRecovery.prepare(group,custody);
    const verify=async()=>{await custody.verify();await surfaces?.verify();};
    const published=custody.proof.destinationOwned,phase=published?'complete':'refused',reconciledAt=new Date(this.now()).toISOString(),rows=[];
    const audit=row=>({schema:1,requestId:input.token,decision:plan.decision,terminalPhase:phase,receiptAcknowledged:true,previousPhase:row.value.phase,previousRevision:row.revision,previousDigest:sum(row.value),proof:custody.proof,reconciledAt,namespaceChanged:false});
    for(const [row,p]of [[group.sourceRow,group.sourceProject],[group.destinationRow,group.project]]){
     await verify();await guard();for(const id of plan.ids)this.host.storage.assertActive(id);
     const prior=row.value.reconciliation;
     if(acknowledged(row.value,phase)||row.value.phase==='needs-attention'&&prior?.schema===1&&prior.receiptAcknowledged===true&&prior.terminalPhase===phase&&prior.decision===plan.decision&&sum(prior.proof)===sum(custody.proof)){rows.push({projectId:p.id,row});continue;}
     const value={...row.value,phase:'needs-attention',reconciliation:audit(row)},result=await this.host.storage.putRecovery(p.id,row.id,value,{expectedRevision:row.revision});
     rows.push({projectId:p.id,row:{id:row.id,revision:result.revision,value}});
    }
    // Acknowledged local rows stay pending/visible until the common registry
    // commits. Afterwards each terminal local CAS releases its own root.
    for(const {projectId,row}of rows){const current=await this.host.storage.readRecoveryRecord(projectId,row.id,{maxBytes:8*1024*1024,purpose:'cross-tree-recovery'});if(!current||current.revision!==row.revision||sum(current.value)!==sum(row.value))throw changed();}
    await verify();await guard();for(const id of plan.ids)this.host.storage.assertActive(id);
    if(!group.finalRegistry)await this.host.storage.putCrossTreeTransfer(plan.id,{...group.registry.value,phase,settled:true,published,sourceReceipt:published?'acknowledged':group.registry.value.sourceReceipt,destinationReceipt:published?'acknowledged':group.registry.value.destinationReceipt,reconciliation:audit(group.registry)},{expectedRevision:group.registry.revision});
    else{const current=await this.host.storage.readCrossTreeTransfer(plan.id,{maxBytes:8*1024*1024});if(current?.revision!==group.registry.revision||sum(current.value)!==sum(group.registry.value))throw changed();}
    for(const {projectId,row}of rows){
     if(acknowledged(row.value,phase))continue;
     await verify();await guard();for(const id of plan.ids)this.host.storage.assertActive(id);
     await this.host.storage.putRecovery(projectId,row.id,{...row.value,phase},{expectedRevision:row.revision});
    }
    const surfaceRecovery=surfaces?await surfaces.apply():{resumed:0,moved:0,retained:0};
    return {settled:true,projectId:group.project.id,sourceProjectId:group.sourceProject.id,destination:group.record.destination,decision:plan.decision,records:3,stageRetained:custody.proof.stageRetained,namespaceChanged:false,surfaceRecovery};
   }finally{try{surfaces?.close();}finally{custody.close();}}
  });
 }
}
