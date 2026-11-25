import {createHash} from 'node:crypto';
import path from 'node:path';
import {observeWindowsTreeSurface} from '../platform/windows/tree-surface-observation.mjs';
import {recoveryHeld} from './workspace-recovery-state.mjs';
import {CrossTreeSurfaceJournal} from './cross-tree-surface-journal.mjs';

const fail = (code, message) => Object.assign(Error(message), {code});
const sum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = p => sum([p.id,p.instanceId,p.root,p.identity,p.metadataIdentity]);
const same = (a,b) => a?.identity === b?.identity && a?.digest === b?.digest && a?.byteLength === b?.byteLength;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

export class CrossTreeSurfaces {
  constructor(workspace, {observe = observeWindowsTreeSurface} = {}) { this.workspace=workspace; this.observe=observe;this.journal=new CrossTreeSurfaceJournal(this); }
  async capture(payload, records) {
    const host=this.workspace.host, source=await host.requireProject(payload.sourceProjectId??payload.projectId), target=await host.requireProject(payload.projectId), entries=[];
    if(records.length>1024)throw fail('TREE_RECOVERY_LIMIT','打开的源文档超过本次核对上限，未执行文件操作。');
    let totalBytes=0;
    for (const record of records) {
      await this.journal.ensure(record);
      if (record.dead || recoveryHeld(record) || record.transferring && record.treeRecoveryHolds?.size) throw fail('TRANSFER_HELD','请先处理源文档的恢复保护。');
      const generation=record.generation, relative=record.relPath, observation=await this.observe(host,source,relative);
      try {
        await observation.verify();
        totalBytes+=observation.snapshot.byteLength;
        if(totalBytes>512*1024*1024)throw fail('TREE_RECOVERY_LIMIT','源文档核对超过 512 MiB，未执行文件操作。');
        if(record.dead || record.generation!==generation || record.relPath!==relative) throw fail('SURFACE_CHANGED','源文档已变化，未执行文件操作。');
        const entry={record,generation,relative,snapshot:observation.snapshot,sourceBinding:binding(source),targetBinding:binding(target),
          sourceProjectId:source.id,projectId:target.id,source:payload.source,destination:payload.action==='rename'?[path.posix.dirname(payload.source).replace(/^\.$/,''),payload.name].filter(Boolean).join('/'):[payload.target,path.posix.basename(payload.source)].filter(Boolean).join('/'),action:payload.action};
        await this.journal.remember(entry,observation);
        entries.push(entry);
      } finally { observation.close(); }
    }
    return entries;
  }
  retain(entries, facts, {settled=false}={}) {
    const operationId=facts?.operationId;
    if (!uuid(operationId)) return false;
    for (const entry of entries) {
      const r=entry.record;
      if(r.dead)continue;
      const hold={...entry,operationId,settled,status:settled?'moved':'pending',decision:settled?'keep-published-move':null};
      (r.treeRecoveryHolds??=new Map()).set(operationId,hold);
      this.notify(r,hold);
    }
    return true;
  }
  async completeCopy(entries) {
    for(const entry of entries){
      const r=entry.record,hold=r.treeRecoveryHolds?.get(entry.operationId);
      if(!hold||r.dead)continue;
      const project=await this.workspace.host.requireProject(r.projectId),observation=await this.observe(this.workspace.host,project,hold.relative);
      try{
        await observation.verify();
        if(r.generation!==hold.generation||!same(observation.snapshot,hold.snapshot)){hold.status='changed';hold.settled=true;this.notify(r,hold);continue;}
        await this.journal.release(hold);r.treeRecoveryHolds.delete(hold.operationId);this.notify(r,r.treeRecoveryHolds?.values().next().value??null);
      }finally{observation.close();}
    }
  }
  state(hold) {
    const messages={pending:'文件操作结果待核对。当前文档和未发送内容保留，只读；请在本机恢复设置中核对这次操作。',
      moved:'文件已移动。原文档、批注和未发送内容保留，只读；可另行打开目标文件。',
      changed:'文件操作记录已核对，原文档身份或内容尚不匹配。当前编辑内容保留，只读；恢复原文件后可重新核验。'};
    return {operationId:hold.operationId,status:hold.status,settled:hold.settled,message:messages[hold.status],canOpenDestination:hold.status==='moved'&&hold.settled,canResume:true};
  }
  current(record) { const holds=[...(record.treeRecoveryHolds?.values()??[])]; return holds.length ? this.state(holds.at(-1)) : null; }
  notify(record, hold) {
    record.held=recoveryHeld(record);
    if(!record.treeRecoveryHolds?.size)delete record.treeColdCapsule;
    if(record.dead)return;
    try {
      record.wc.send('nozeli:workspace-control',{type:'tree-recovery-state',projectId:record.projectId,viewId:record.viewId,state:hold?this.state(hold):null});
      record.wc.send('nozeli:workspace-control',{type:'transfer-hold',held:record.held});
    } catch(error) { this.workspace.onError(error); }
  }
  async prepare(group, custody) {
    const w=this.workspace, entries=[], observations=[];
    const close=()=>{for(const observation of observations.reverse())observation.close();};
    try {
      for(const r of w.projectRecords(group.sourceProject.id)) {
        const hold=r.treeRecoveryHolds?.get(group.record.operationId);
        if(!hold||r.dead)continue;
        if(hold.descriptor&&group.record.surfaceRecovery?.filter(value=>sum(value)===sum(hold.descriptor)).length!==1)throw fail('TREE_SURFACE_CHANGED','原文档保护与文件操作回执不匹配。');
        const matched=hold.sourceProjectId===group.sourceProject.id&&hold.projectId===group.project.id&&hold.action===group.record.action&&hold.source===group.record.source&&hold.destination===group.record.destination&&hold.sourceBinding===binding(group.sourceProject)&&hold.targetBinding===binding(group.project)&&r.generation===hold.generation&&r.relPath===hold.relative;
        const moved=custody.proof.decision==='keep-published-move', relative=moved?hold.destination+hold.relative.slice(hold.source.length):hold.relative;
        let observation=null;
        if(matched)try { observation=await this.observe(w.host,moved?group.project:group.sourceProject,relative); observations.push(observation); } catch(error) {
          if(error.cleanupErrors?.length)throw error;
        }
        const status=matched&&observation&&same(observation.snapshot,hold.snapshot)?(moved?'moved':'resumed'):'changed';
        entries.push({r,hold,status,relative,snapshot:observation?.snapshot??null});
      }
      const verify=async()=>{for(const observation of observations)await observation.verify();for(const {r,hold}of entries)if(!r.dead&&r.treeRecoveryHolds?.get(hold.operationId)!==hold)throw fail('TREE_SURFACE_CHANGED','源文档的恢复保护已变化，请重新核对。');};
      await verify();
      return {verify,close,apply:async()=>{
        const result={resumed:0,moved:0,retained:0};
        for(const {r,hold,status,relative,snapshot}of entries){
          if(r.dead)continue;
          // Navigation/reload never grants a new generation the old buffer's
          // write permission. No editor reload, source migration or draft write.
          const nextStatus=r.generation===hold.generation&&r.relPath===hold.relative?status:'changed';
          if(nextStatus==='resumed'){await this.journal.release(hold,{allowMissing:custody.proof.decision==='retain-aborted-intent'});r.treeRecoveryHolds.delete(hold.operationId);result.resumed++;}
          else{Object.assign(hold,{settled:true,status:nextStatus,decision:custody.proof.decision,destinationRelative:relative,destinationSnapshot:nextStatus==='moved'?snapshot:null});result[nextStatus==='moved'?'moved':'retained']++;}
          this.notify(r,r.treeRecoveryHolds?.values().next().value??null);
        }
        return result;
      }};
    } catch(error) { close(); throw error; }
  }
  selected(record, input, {allowPending=false}={}) {
    if(record.role!=='surface'||record.kind!=='document'||record.dead||input?.projectId!==record.projectId||input.relPath!==record.relPath||!uuid(input.operationId)||Object.keys(input).some(key=>!['projectId','relPath','operationId'].includes(key)))throw fail('PROJECT_SCOPE_DENIED','恢复入口不属于当前原文档。');
    const hold=record.treeRecoveryHolds?.get(input.operationId);
    if(!hold||!hold.settled&&!allowPending||record.transferring||record.syncHolds?.size)throw fail('RECOVERY_UNAVAILABLE','请先核对原文件操作。');
    return hold;
  }
  async resume(record,input) {
    const selected=this.selected(record,input,{allowPending:true});
    if(!selected.settled){
      if(!this.reconcile)throw fail('RECOVERY_UNAVAILABLE','请先在本机恢复设置中核对原文件操作。');
      await this.reconcile(record.projectId,selected.operationId);
      if(!record.treeRecoveryHolds?.has(selected.operationId))return {resumed:true,held:recoveryHeld(record)};
      if(record.treeRecoveryHolds.get(selected.operationId).status==='moved')return {resumed:false,sourceRetained:true,held:true};
    }
    return this.workspace.serial(record.projectId,async()=>{
      const hold=this.selected(record,input),project=await this.workspace.host.requireProject(record.projectId);
      if(binding(project)!==hold.sourceBinding)throw fail('TREE_SURFACE_CHANGED','原项目绑定已变化。');
      const observation=await this.observe(this.workspace.host,project,record.relPath),generation=record.generation;
      try{
        await observation.verify();
        if(!same(observation.snapshot,hold.snapshot)||record.dead||record.generation!==generation)throw fail('TREE_SURFACE_CHANGED','原文档身份或内容不匹配；编辑现场保留。');
        await this.journal.release(hold);
        record.treeRecoveryHolds.delete(hold.operationId);
        this.notify(record,record.treeRecoveryHolds?.values().next().value??null);
        return {resumed:true,held:recoveryHeld(record)};
      }finally{observation.close();}
    });
  }
  async openDestination(record,input) {
    const hold=this.selected(record,input);
    if(hold.status!=='moved')throw fail('RECOVERY_UNAVAILABLE','这次操作没有已核验的移动目标。');
    const w=this.workspace,project=await w.host.requireProject(hold.projectId);
    if(binding(project)!==hold.targetBinding)throw fail('TREE_SURFACE_CHANGED','目标项目绑定已变化。');
    const relative=hold.destinationRelative??hold.destination+hold.relative.slice(hold.source.length),expected=hold.destinationSnapshot??hold.snapshot;
    const generation=record.generation,observation=await this.observe(w.host,project,relative);
    try{
      await observation.verify();
      if(!same(observation.snapshot,expected)||record.dead||record.generation!==generation||record.treeRecoveryHolds?.get(hold.operationId)!==hold)throw fail('TREE_SURFACE_CHANGED','目标文件已变化；原阅读面保留。');
      const root=w.windows.get('main');if(!root||root.dead)throw fail('NO_ROOT','请先打开主窗口。');
      root.wc.send('nozeli:workspace-control',{type:'open-file',projectId:project.id,relPath:relative,documentSource:{type:'project'}});
      return {opened:true,sourceRetained:true};
    }finally{observation.close();}
  }
}
