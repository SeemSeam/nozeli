import {createHash} from 'node:crypto';
import {isProjectDocumentSource} from '../domain/document-source.mjs';
import {decodeRecoveryBytes} from '../domain/office-recovery.mjs';
import {normalizeOfficeRecovery} from './office-recovery.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const failed = () => Object.assign(Error('原文档恢复资料无法完整核验；原资料保留，未读取当前路径。'), {code:'TREE_SURFACE_RECOVERY_CHANGED'});
const binding = p => hash([p.id,p.instanceId,p.root,p.identity,p.metadataIdentity]);
const protectedValue=value=>{const {relocatedTo,...rest}=value;return {...rest,status:'protected'};};

// Host-only descriptors point at immutable objects in the existing private
// recovery store. They describe document protection, never process ownership.
export class CrossTreeSurfaceJournal {
  constructor(surfaces) { this.surfaces=surfaces;this.workspace=surfaces.workspace; }
  get storage() { return this.workspace.host.storage; }
  async remember(entry, observation) {
    const r=entry.record, projectId=r.projectId;
    const file=await this.workspace.host.readFile(projectId,entry.relative);
    await observation.verify();
    if(file.digest!==entry.snapshot.digest||file.byteLength!==entry.snapshot.byteLength)throw failed();
    const bytesObject=file.bytes ? (await this.storage.putRecoveryObject(projectId,Buffer.from(file.bytes))).digest : null;
    const recovery=(await this.storage.readRecoveryRecord(projectId,'workspace:'+r.viewId,{maxBytes:8*1024*1024,purpose:'tree-surface-capture'}))?.value??null;
    if(recovery&&(recovery.projectId!==projectId||recovery.viewId!==r.viewId||recovery.relPath!==r.relPath))throw failed();
    const annotations=await this.workspace.host.listAnnotations(projectId,entry.relative);
    const capsule={schema:1,file:{...file,bytes:null},bytesObject,recovery,annotations,
      buffer:this.workspace.buffers.get(this.workspace.resourceOfRecord(r))??null,
      viewState:this.workspace.layouts.get(projectId)?.views[r.viewId]?.viewState??null};
    const object=await this.storage.putRecoveryObject(projectId,Buffer.from(JSON.stringify(capsule)));
    await observation.verify();
    if(r.dead||r.generation!==entry.generation||r.relPath!==entry.relative)throw failed();
    entry.descriptor={schema:1,viewId:r.viewId,relative:entry.relative,snapshot:entry.snapshot,
      sourceBinding:entry.sourceBinding,targetBinding:entry.targetBinding,capsuleDigest:object.digest};
    entry.coldFile=file;entry.coldCapsule=capsule;
  }
  async arm(entries, base) {
    if(!entries.length)return;
    if(!uuid(base.operationId)||hash(base.surfaceRecovery)!==hash(entries.map(e=>e.descriptor)))throw failed();
    for(const entry of entries){
      if(base.sameProject===true){
        if(base.projectId!==entry.sourceProjectId||base.projectId!==entry.projectId||base.source!==entry.source||base.action!==entry.action||typeof base.destination!=='string')throw failed();
        entry.destination=base.destination;
      }
      const r=entry.record,key='tree-surface:'+r.viewId+':'+base.operationId;
      const value={schema:1,kind:'record',projectId:r.projectId,relPath:r.relPath,viewId:r.viewId,
        operationId:base.operationId,status:'protected',descriptor:entry.descriptor,receipt:'tree-operation:'+base.operationId};
      // Establish the in-memory denial before an ambiguous storage response.
      entry.journalKey=key;entry.journalValue=value;entry.operationId=base.operationId;
      this.surfaces.retain([entry],base);
      const result=await this.storage.putRecovery(r.projectId,key,value,{expectedRevision:0});
      entry.journalRevision=result.revision;
      const hold=r.treeRecoveryHolds?.get(base.operationId);if(hold)hold.journalRevision=result.revision;
    }
  }
  async release(hold,{allowMissing=false,relocatedTo}={}) {
    if(!hold.journalKey)return; // Compatibility with pre-journal live holds.
    const row=await this.storage.readRecoveryRecord(hold.sourceProjectId,hold.journalKey,{maxBytes:65536,purpose:'tree-surface-release'});
    if(!row&&allowMissing&&!hold.journalRevision)return;
    if(!row||!['protected','released','relocated'].includes(row.value.status)||hash(protectedValue(row.value))!==hash(protectedValue(hold.journalValue)))throw failed();
    if(relocatedTo!==undefined){
      if(typeof relocatedTo!=='string'||!relocatedTo||row.value.status==='released'||row.value.status==='relocated'&&row.value.relocatedTo!==relocatedTo)throw failed();
      if(row.value.status==='relocated')return;
    }else if(row.value.status==='released')return; // Prior CAS succeeded; response lost.
    // A relocated view can still be reopened through an older saved layout.
    // Keep its original capsule authoritative for that original identity.
    await this.storage.putRecovery(hold.sourceProjectId,hold.journalKey,{...protectedValue(row.value),status:relocatedTo===undefined?'released':'relocated',...(relocatedTo===undefined?{}:{relocatedTo})},{expectedRevision:row.revision});
  }
  async ensure(record) {
    if(process.platform!=='win32'||record.role!=='surface'||record.kind!=='document'||!record.relPath||!isProjectDocumentSource(record.documentSource)){record.treeRecoveryLoaded=true;return;}
    if(record.treeRecoveryLoaded)return;
    if(record.treeRecoveryLoading)return record.treeRecoveryLoading;
    const generation=record.generation;
    record.treeRecoveryLoading=this.load(record,generation);
    try{await record.treeRecoveryLoading;record.treeRecoveryLoaded=true;}
    catch(error){record.held=true;throw error;}
    finally{delete record.treeRecoveryLoading;}
  }
  async load(record,generation) {
    const project=await this.workspace.host.requireProject(record.projectId), entries=[];let examined=0;
    // Exact original view prefix avoids unbounded historical operation scans.
    for await(const row of this.storage.recoveryRecords(record.projectId,{prefixes:['tree-surface:'+record.viewId+':'],maxBytes:65536})){
      if(++examined>4096)throw failed();
      const v=row.value,d=v?.descriptor;
      if(v?.schema!==1||v.kind!=='record'||v.projectId!==record.projectId||v.viewId!==record.viewId||!uuid(v.operationId)||row.id!=='tree-surface:'+record.viewId+':'+v.operationId||v.receipt!=='tree-operation:'+v.operationId||!['protected','released','relocated'].includes(v.status)||d?.schema!==1||d.viewId!==record.viewId||d.relative!==v.relPath||d.sourceBinding!==binding(project)||!digest(d.targetBinding)||!digest(d.capsuleDigest)||!digest(d.snapshot?.digest)||typeof d.snapshot?.identity!=='string'||!Number.isSafeInteger(d.snapshot?.byteLength)||d.snapshot.byteLength<0)throw failed();
      if(v.status==='released')continue;
      if(entries.length>=1024)throw failed();
      const receipt=(await this.storage.readRecoveryRecord(record.projectId,v.receipt,{maxBytes:8*1024*1024,purpose:'tree-surface-restore'}))?.value;
      const sameProject=receipt?.sameProject===true&&receipt.transfer===true&&receipt.crossTransfer===undefined&&receipt.projectId===record.projectId&&receipt.projectBinding===binding(project)&&d.targetBinding===binding(project)&&['copy','cut','rename'].includes(receipt.action)&&['intent','prepared','published','metadata-committed','needs-attention','refused','complete'].includes(receipt.phase);
      const cross=receipt?.crossTransfer===true&&receipt.sourceProjectId===record.projectId&&receipt.role==='source'&&['copy','cut'].includes(receipt.action)&&uuid(receipt.destinationProjectId);
      if(!receipt||receipt.schema!==1||!sameProject&&!cross||receipt.operationId!==v.operationId||!Array.isArray(receipt.surfaceRecovery)||receipt.surfaceRecovery.filter(item=>hash(item)===hash(d)).length!==1)throw failed();
      if(typeof receipt.source!=='string'||!(d.relative===receipt.source||d.relative.startsWith(receipt.source+'/'))||typeof receipt.destination!=='string')throw failed();
      const relocated=sameProject&&receipt.phase==='complete'&&receipt.action!=='copy'&&record.relPath===receipt.destination+d.relative.slice(receipt.source.length);
      if(v.status==='relocated'&&(!sameProject||receipt.phase!=='complete'||receipt.action==='copy'||v.relocatedTo!==receipt.destination+d.relative.slice(receipt.source.length)))throw failed();
      if(record.relPath!==d.relative){
        // A later rename may have moved this same view again. A completed
        // relocation no longer governs its current non-original identity.
        if(v.status==='relocated')continue;
        if(!relocated)throw failed();
        const observation=await this.surfaces.observe(this.workspace.host,project,record.relPath);
        try{await observation.verify();if(hash(observation.snapshot)!==hash(d.snapshot))throw failed();await this.release({sourceProjectId:record.projectId,journalKey:row.id,journalValue:v,journalRevision:row.revision},{relocatedTo:record.relPath});}finally{observation.close();}
        continue;
      }
      const capsule=JSON.parse((await this.storage.readRecoveryObject(record.projectId,d.capsuleDigest)).toString('utf8'));
      if(capsule.schema!==1||capsule.file?.relPath!==record.relPath||capsule.file.digest!==d.snapshot.digest||capsule.file.byteLength!==d.snapshot.byteLength||capsule.bytesObject!==null&&!digest(capsule.bytesObject))throw failed();
      const file={...capsule.file,bytes:capsule.bytesObject?await this.storage.readRecoveryObject(record.projectId,capsule.bytesObject):null};
      const latest=(await this.storage.readRecoveryRecord(record.projectId,'workspace:'+record.viewId,{maxBytes:8*1024*1024,purpose:'tree-surface-latest'}))?.value;
      if(latest?.projectId===record.projectId&&latest.viewId===record.viewId&&latest.relPath===record.relPath&&latest.treeSurfaceOperations?.[v.operationId]===hash(d))capsule.recovery=latest;
      else if(sameProject&&latest?.treeRelocation?.operationId===v.operationId&&latest.treeRelocation.from===d.relative&&latest.treeRelocation.to===receipt.destination+d.relative.slice(receipt.source.length)&&latest.treeSurfaceOperations?.[v.operationId]===hash(d))capsule.recovery={...latest,relPath:d.relative};
      if(file.bytes&&createHash('sha256').update(file.bytes).digest('hex')!==file.digest)throw failed();
      entries.push({record,generation,relative:d.relative,snapshot:d.snapshot,sourceBinding:d.sourceBinding,targetBinding:d.targetBinding,
        sourceProjectId:record.projectId,projectId:sameProject?record.projectId:receipt.destinationProjectId,source:receipt.source,destination:receipt.destination,action:receipt.action,
        operationId:v.operationId,settled:false,status:'pending',journalKey:row.id,journalValue:v,journalRevision:row.revision,
        descriptor:d,coldFile:file,coldCapsule:capsule});
    }
    if(record.dead||record.generation!==generation)throw failed();
    for(const hold of entries)(record.treeRecoveryHolds??=new Map()).set(hold.operationId,hold);
    if(entries.length){
      record.held=true;record.treeColdCapsule=entries.at(-1).coldCapsule;
      const key=this.workspace.resourceOfRecord(record),buffer=record.treeColdCapsule.buffer;
      const latestText=record.treeColdCapsule.recovery?.candidate?.text;
      if(!this.workspace.buffers.has(key)&&(buffer||typeof latestText==='string'))this.workspace.buffers.set(key,{...buffer,...(typeof latestText==='string'?{text:latestText,dirty:true}:{}),sourceViewId:record.viewId});
    }
  }
  async read(record) {
    const holds=[...(record.treeRecoveryHolds?.values()??[])];
    const hold=holds.findLast(h=>h.coldFile);
    if(!hold)return null;
    const file=structuredClone(hold.coldFile),capsule=hold.coldCapsule;
    if(file.kind==='text'){
      const text=capsule.recovery?.candidate?.text??capsule.buffer?.text;
      if(typeof text==='string')file.draft={text,baseDigest:capsule.recovery?.baseDigest??file.digest,status:'retained'};
    }
    const recovery=capsule.recovery;
    if(['word','sheet','ppt'].includes(file.kind)&&recovery?.candidate){
      if(recovery.kind!==file.kind||recovery.projectId!==record.projectId||recovery.viewId!==record.viewId||recovery.relPath!==record.relPath)throw failed();
      // Revalidate persisted packages/models on every consumer boundary. The
      // original digest still identifies notes/source CAS, never edited bytes.
      const candidate=await normalizeOfficeRecovery(file.kind,recovery.candidate);
      if(candidate.bytes){
        file.bytes=decodeRecoveryBytes(candidate.bytes);
        file.treeRecoveryCandidateDigest=createHash('sha256').update(file.bytes).digest('hex');
      }else if(candidate.sheetSnapshot){
        const snapshot=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decodeRecoveryBytes(candidate.sheetSnapshot)));
        file.bytes=Uint8Array.from(snapshot.original);
        file.treeRecoverySheetSnapshot=snapshot.sheets;
      }
    }
    return {...file,treeRecoveryRetained:true,treeRecoverySnapshot:capsule.recovery??null};
  }
}
