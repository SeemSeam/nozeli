import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validateFileLabel } from '../domain/file-label.mjs';
import { FileTags } from '../domain/file-tags.mjs';
import { FileChanges } from '../domain/file-changes.mjs';
import {requireCapability} from '../platform/platform-capabilities.mjs';
import {createFileTreeIO} from './file-tree-io.mjs';
import {assertTreeCopySaved} from './file-clipboard-export.mjs';
import {capturePptTreePlan} from './ppt-tree-recovery.mjs';

const fail = (message) => { throw new Error(message); };
const exists = async p => { try { await fs.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const inside = (rel, parent) => rel === parent || rel.startsWith(parent + '/');
const key = rel => createHash('sha256').update(rel).digest('hex');
const projectBinding = p => key(JSON.stringify([p.id,p.instanceId,p.root,p.identity,p.metadataIdentity]));
const validClosedPath = p => typeof p === 'string' && p.length > 0 && p.length <= 4096 && !p.includes('\\') && p.split('/').every(c => c && c !== '.' && c !== '..');
const validViewPath = p => typeof p === 'string' && p.length > 0 && p.length <= 4096 && !/[\\:\x00-\x1f]/.test(p) && p.split('/').every(c => c && c !== '.' && c !== '..' && !c.startsWith('.') && c !== 'node_modules');
const validateViewPaths = (paths, message, valid = validViewPath) => {
  if (!Array.isArray(paths) || paths.length > 10000 || paths.some(p => !valid(p))) fail(message);
  return [...new Set(paths)];
};
export function treeViewValue(record) {
  if(record!=null&&(typeof record!=='object'||Array.isArray(record)))throw Object.assign(new Error('目录视图状态损坏，原记录未覆盖。'),{code:'TREE_VIEW_INVALID'});
  const closed = validateViewPaths(record?.closed === undefined ? [] : record.closed, '目录折叠状态无效。', validClosedPath);
  const hidden = validateViewPaths(record?.hidden === undefined ? [] : record.hidden, '隐藏路径无效。');
  const expanded=validateViewPaths(record?.expanded===undefined?[]:record.expanded,'目录展开状态无效。');
  if (record?.showHidden !== undefined && typeof record.showHidden !== 'boolean') fail('隐藏文件显示状态无效。');
  return { closed, hidden, expanded, showHidden: record?.showHidden ?? false };
}
export class FileTreeOps {
  constructor(host, { trash, io=createFileTreeIO(host) }) { this.host = host; this.trash = trash; this.io=io; this.pending = Promise.resolve(); }
  run(input, surfaceContext={}) {
    // Cross-project operations hold both project locks, acquired in a stable
    // order so they can never deadlock against single-project callers.
    const cross = typeof input?.sourceProjectId === 'string' && input.sourceProjectId && input.sourceProjectId !== input.projectId;
    const locks = cross ? [input.projectId, input.sourceProjectId].sort() : [input.projectId];
    const held = locks.reduceRight((work, id) => () => this.host.projectLock(id)(work), () => this.io.recoverableTransfer ? this.host.metaLock(()=>this.perform(input,surfaceContext)) : this.perform(input,surfaceContext));
    const task = this.pending.then(held);
    this.pending = task.catch(() => {});
    return this.host.track(task);
  }
  async labels({ projectId }) {
    const project = await this.host.requireProject(projectId);
    const labels = Object.create(null);
    for (const file of await new FileTags({ storage: this.host.storage, projectId, root: project.root }).all()) if (file.fileLabel) {
      if (!Number.isSafeInteger(file.fileLabel.revision) || file.fileLabel.revision < 1) fail('文件标记版本损坏，未覆盖。');
      labels[file.file.relPath] = { ...validateFileLabel(file.fileLabel), revision: file.fileLabel.revision };
    }
    return { labels };
  }
  setLabel(input) {
    const task = this.pending.then(() => this.host.metaLock(async () => {
      const { projectId, relPath, expectedRevision } = input;
      const value = validateFileLabel(input), project = await this.host.requireProject(projectId);
      const abs = await this.locate(project, relPath);
      if (!(await fs.lstat(abs)).isFile()) fail('颜色和备注仅用于现有文件。');
      const store = new FileTags({ storage: this.host.storage, projectId, root: project.root }), old = await store.read(relPath);
      if (old?.fileLabel) { validateFileLabel(old.fileLabel); if (!Number.isSafeInteger(old.fileLabel.revision) || old.fileLabel.revision < 1) fail('文件标记版本损坏，未覆盖。'); }
      const revision = old?.fileLabel?.revision ?? 0;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== revision) fail('文件标记已被其他操作修改，请重新打开后编辑；当前修改未覆盖。');
      const fileLabel = { ...value, revision: revision + 1 };
      await store.write(relPath, { ...old, file: { ...old?.file }, tags: old?.tags || [], nextOrdinal: old?.nextOrdinal || 1, fileLabel }, old?.revision ?? null);
      return { relPath, fileLabel };
    }));
    this.pending = task.catch(() => {});
    return this.host.track(task);
  }
  async view({ projectId, closed, hidden, expanded, showHidden }) {
    const project = await this.host.storage.requireRegistered(projectId);
    return this.host.track(this.host.metaLock(async () => {
      const previous = await this.host.storage.getLocal(projectId, 'file-tree-view');
      const value = treeViewValue(previous);
      if (closed !== undefined) value.closed = validateViewPaths(closed, '目录折叠状态无效。', validClosedPath);
      if(expanded!==undefined)value.expanded=validateViewPaths(expanded,'目录展开状态无效。');
      if (hidden !== undefined) {
        value.hidden = validateViewPaths(hidden, '隐藏路径无效。');
        for (const rel of value.hidden) await this.locate(project, rel);
      }
      if (showHidden !== undefined) {
        if (typeof showHidden !== 'boolean') fail('隐藏文件显示状态无效。');
        value.showHidden = showHidden;
      }
      if (closed !== undefined || hidden !== undefined || expanded !== undefined || showHidden !== undefined) await this.host.storage.putLocal(projectId, 'file-tree-view', { ...previous, ...value });
      return value;
    }));
  }
  async locate(project, rel, rootAllowed = false) {
    if (rel === '' && rootAllowed) return project.root;
    if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes(':') || /[\x00-\x1f]/.test(rel) || rel.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) fail('路径无效，不能操作项目元数据或隐藏文件。');
    let current = project.root;
    for (const part of rel.split('/')) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (stat?.isSymbolicLink()) fail('不支持通过符号链接操作文件。');
    }
    return current;
  }
  validName(name) {
    if (typeof name !== 'string' || !name.trim() || name.length>255 || name.startsWith('.') || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) fail('请输入有效的文件名，不含路径分隔符或系统保留名称。');
    return name;
  }
  // Reject nested links and independent project metadata before moving or
  // copying a whole directory.
  async assertTransferable(src, stat) {
    const walk = async dir => { for (const entry of await fs.readdir(dir, { withFileTypes:true })) {
      if (entry.isSymbolicLink()) fail('目录包含符号链接，未执行操作。');
      if (entry.name === '.nozeli' || entry.name === '.git') fail('目录包含独立项目元数据，未执行操作。');
      if (entry.isDirectory()) await walk(path.join(dir, entry.name));
    } };
    if (stat.isDirectory()) await walk(src);
  }
  async perform({ projectId, action, sourceProjectId, source = '', target = '', name }, surfaceContext={}) {
    this.io.requireAction(action,{cross:Boolean(sourceProjectId&&sourceProjectId!==projectId)});
    if (sourceProjectId !== undefined && (typeof sourceProjectId !== 'string' || !sourceProjectId)) fail('跨项目源项目无效。');
    const project = await this.host.requireProject(projectId);
    if (sourceProjectId && sourceProjectId !== projectId) {
      if (action !== 'copy' && action !== 'cut') fail('跨项目仅支持复制或剪切。');
      return this.performCross({ project, projectId, sourceProjectId, action, source, target },surfaceContext);
    }
    const store = new FileTags({ storage: this.host.storage, projectId, root: project.root });
    const changes = new FileChanges({ storage: this.host.storage, projectId, root: project.root }), allChanges=await changes.all();
    if (action === 'createFile' || action === 'createFolder') {
      const dir = await this.locate(project, target, true);
      const destination = path.join(dir, this.validName(name));
      const rel = [target, name].filter(Boolean).join('/');
      if ((await store.all()).some(s => inside(s.file.relPath, rel)) || allChanges.some(s=>inside(s.relPath,rel))) fail('该名称保留有标签或修改历史恢复资料，请使用其他名称或先恢复原文件。');
      if(this.io.recoverableCreation)return this.createEntry(project,{projectId,action,rel});
      await this.io.createEntry(project,rel,{kind:action==='createFolder'?'directory':'file'});
      return { relPath: rel };
    }
    const src = await this.locate(project, source);
    const stat = await fs.lstat(src);
    await this.assertTransferable(src, stat);
    if (action === 'trash') {
      await this.trash(src);
      // Keep metadata and recovery drafts so a recycle-bin restore retains tags.
      return { removed: source };
    }
    if (!['copy', 'cut', 'rename'].includes(action)) fail('不支持的文件操作。');
    this.io.requireTransferKind?.(stat);
    if(this.io.recoverableTransfer&&action==='copy')await assertTreeCopySaved(this,project,[source]);
    const dir = action === 'rename' ? path.posix.dirname(source).replace(/^\.$/, '') : target;
    const parent = await this.locate(project, dir, true);
    let base = action === 'rename' ? this.validName(name) : path.basename(src);
    let destination = [dir, base].filter(Boolean).join('/');
    if (action !== 'copy' && destination === source) return { relPath: source, from: source };
    if (action === 'copy' && destination === source) {
      const ext = stat.isDirectory() ? '' : path.extname(base), stem = base.slice(0, base.length-ext.length);
      for (let i = 1; ; i++) {
        base = `${stem} 副本${i === 1 ? '' : ' ' + i}${ext}`;
        destination = [dir, base].filter(Boolean).join('/');
        if (!await exists(path.join(parent, base))) break;
      }
    }
    if (stat.isDirectory() && inside(destination, source)) fail('不能将文件夹放入自身或子目录。');
    const dest = path.join(parent, base);
    if (await exists(dest)) fail('目标已存在，未覆盖。请先重命名。');
    const allTags = await store.all();
    if (allTags.some(s => inside(s.file.relPath, destination))) fail('目标位置保留有标签恢复资料，请使用其他名称。');
    if(allChanges.some(s=>inside(s.relPath,destination)))fail('目标位置保留有修改历史，请使用其他名称。');
    const changePlan=allChanges.filter(s=>inside(s.relPath,source)).map(old=>({old,rel:destination+old.relPath.slice(source.length)}));
    if(changePlan.some(item=>item.old.pending))fail('文档有待恢复的修改批次，请先重新打开文档后操作。');
    const sidecars = allTags.filter(s => inside(s.file.relPath, source));
    const plan = sidecars.map(old => ({ old, rel: destination + old.file.relPath.slice(source.length) }));
    for (const item of plan) if (await store.read(item.rel)) fail('目标位置保留有标签记录，请使用其他名称。');
    const tagRows = await this.host.storage.listProject(projectId, 'file_tags');
    const changeRows = await this.host.storage.listProject(projectId, 'file_changes');
    const nextTags = tagRows.map(({ id, value }) => ({ id, value }));
    const nextChanges = changeRows.map(({ id, value }) => ({ id, value }));
    const provenanceRows = await this.host.storage.listProject(projectId, 'provenance');
    const nextProvenance = provenanceRows.map(({ id, value }) => ({ id, value }));
    const recovery = [];
    let sourceMoved = false, destinationCreated = false;
    for (const {old,rel} of changePlan) {
      const value = {...old,relPath:rel,docId:action==='copy'?randomUUID():old.docId,...(action==='copy'?{copiedFrom:{docId:old.docId,relPath:old.relPath}}:{})};
      nextChanges.push({id:key(rel),value});
    }
    for (const {old,rel} of plan) {
      const copy = action === 'copy';
      const value = { ...old, file: { ...old.file, relPath: rel, fileId: copy ? randomUUID() : old.file.fileId }, tags: old.tags.map(t => ({ ...t, relPath: rel, id: copy ? randomUUID() : t.id, ...(copy && t.projection ? { projection: { ...t.projection, removed: true, requestId: null, messageId: null } } : {}) })) };
      store.validate(value, rel); nextTags.push({id:key(rel),value});
    }
    if(this.io.recoverableTransfer){
      if(action!=='copy')for(const {id,value}of provenanceRows)if(inside(id,source))nextProvenance.push({id:destination+id.slice(source.length),value:{...value,relPath:destination+id.slice(source.length)}});
      const moved=id=>action!=='copy'&&inside(id,source);
      return this.transferEntry(project,{projectId,action,source,destination,
        expectedCollections:{file_tags:tagRows.map(({id,value})=>({id,value})),file_changes:changeRows.map(({id,value})=>({id,value})),provenance:provenanceRows.map(({id,value})=>({id,value}))},
        collections:{file_tags:nextTags.filter(row=>!moved(row.value.file.relPath)),file_changes:nextChanges.filter(row=>!moved(row.value.relPath)),provenance:nextProvenance.filter(row=>!moved(row.id))}},surfaceContext);
    }
    try {
      if (action !== 'copy') {
        const drafts=[];
        for await(const row of this.host.storage.recoveryRecords(projectId,{prefixes:['draft:']}))if(row.value?.relPath&&inside(row.value.relPath,source))drafts.push(row);
        for (const { id, value } of drafts) {
          if (!id.startsWith('draft:') || !value?.relPath || !inside(value.relPath, source)) continue;
          const rel = destination + value.relPath.slice(source.length), next = 'draft:' + key(rel);
          if (await this.host.storage.getRecovery(projectId,next)) fail('目标位置保留有草稿，请使用其他名称。');
          await this.host.storage.putRecovery(projectId,next,{...value,relPath:rel}); recovery.push({old:id,next});
        }
        for (const { id, value } of provenanceRows) if (inside(id,source)) {
          const rel = destination + id.slice(source.length);
          nextProvenance.push({id:rel,value:{...value,relPath:rel}});
        }
      }
      if (action === 'copy') {
        // Reserve the destination; never merge into another writer's directory.
        if (stat.isDirectory()) { await fs.mkdir(dest); destinationCreated = true; for (const entry of await fs.readdir(src)) await fs.cp(path.join(src,entry), path.join(dest,entry), {recursive:true, force:false, errorOnExist:true}); }
        else { await fs.copyFile(src, dest, 1); destinationCreated = true; }
      } else {
        // Reserve then rename for directories; regular files use an exclusive link.
        if (stat.isDirectory()) { await fs.mkdir(dest); destinationCreated = true; await fs.rename(src,dest); }
        else { await fs.link(src,dest); destinationCreated = true; await fs.unlink(src); }
        sourceMoved = true;
      }
      const moved = id => action !== 'copy' && inside(id,source);
      await this.host.storage.replaceProjectCollections(projectId, {
        file_tags: nextTags.filter(row => !moved(row.value.file.relPath)),
        file_changes: nextChanges.filter(row => !moved(row.value.relPath)),
        provenance: nextProvenance.filter(row => !moved(row.id)),
      });
    } catch (error) {
      if(error.commitUnknown||error.code==='STORAGE_RESULT_UNKNOWN'){await this.host.storage.putRecovery(projectId,'tree-operation:'+randomUUID(),{source,destination,action,sourceMoved,destinationCreated,phase:'needs-attention',operationId:error.operationId??null}).catch(()=>{});throw error;}
      if (sourceMoved) {
        await fs.rename(dest, src); sourceMoved = false; destinationCreated = false;
      } else if (destinationCreated) await fs.rm(dest,{recursive:true,force:true});
      for (const r of recovery) await this.host.storage.putRecovery(projectId,r.next,null);
      throw error;
    }
    if (action !== 'copy') {
      for (const r of recovery) await this.host.storage.putRecovery(projectId,r.old,null);
    }
    return { relPath: destination, ...(action !== 'copy' ? { from: source } : {}) };
  }
  async assertTreeAdmission(projectId){
    const storage=this.host.storage;
    if(this.io.recoverableCrossTransfer){
      const cross=await storage.pendingCrossTreeTransfer(projectId);
      if(cross)throw Object.assign(Error('项目有待核对的跨项目文件操作，两个项目的现场均已保留。'),{code:'TREE_RECOVERY_REQUIRED',details:{operationId:cross.value.operationId,sourceProjectId:cross.value.sourceProjectId,projectId:cross.value.projectId,phase:cross.value.phase}});
    }
    const pending=await storage.recoveryPage(projectId,{prefixes:['tree-operation:'],pendingOnly:true,limit:1,maxBytes:8192,purpose:'tree-mutation-admission'});
    if(pending.entries.length){const row=pending.entries[0];throw Object.assign(Error('项目有待核对的文件操作，已保留现场，请先检查恢复记录。'),{code:'TREE_RECOVERY_REQUIRED',details:{operationId:row.value.operationId,destination:row.value.destination,phase:row.value.phase}});}
  }
  async transferEntry(project,{projectId,action,source,destination,expectedCollections,collections},surfaceContext={}){
    const storage=this.host.storage;await this.assertTreeAdmission(projectId);
    const drafts=[];
    if(action!=='copy')for await(const row of storage.recoveryRecords(projectId,{prefixes:['draft:']})){
      if(!row.value?.relPath||!inside(row.value.relPath,source))continue;
      const rel=destination+row.value.relPath.slice(source.length),next='draft:'+key(rel);
      const prior=await storage.readRecoveryRecord(projectId,next);
      if(prior?.value)fail('目标位置保留有草稿，请使用其他名称。');
      drafts.push({id:row.id,revision:row.revision,value:row.value,next,nextRevision:prior?.revision??0,nextValue:{...row.value,relPath:rel}});
    }
    const pptDrafts=await capturePptTreePlan(storage,projectId,source,destination,action);
    const operationId=randomUUID(),journal='tree-operation:'+operationId;
    let record={schema:1,kind:'record',sameProject:true,projectBinding:projectBinding(project),transfer:true,projectId,operationId,action,source,relPath:source,destination,phase:'intent',createdAt:new Date().toISOString(),metadata:{before:expectedCollections,after:collections},drafts,...(pptDrafts.length?{pptDrafts}:{}),...(surfaceContext.descriptors?.length?{surfaceRecovery:surfaceContext.descriptors}:{})},effect,revision=0;
    const write=async value=>{const result=await storage.putRecovery(projectId,journal,value,{expectedRevision:revision});revision=result.revision;};
    if(Buffer.byteLength(JSON.stringify(record))>8*1024*1024)throw Object.assign(Error('文件操作恢复资料超过 8 MiB，原文件未修改。'),{code:'TREE_RECOVERY_LIMIT'});
    await write(record);
    try{
      await surfaceContext.beforeTreeEffect?.(record);
      effect=await this.io.transferEntry(project,source,destination,{action,operationId,onPrepared:async facts=>{
        const prepared={...record,phase:'prepared',effect:facts};
        if(Buffer.byteLength(JSON.stringify(prepared))>8*1024*1024)throw Object.assign(Error('文件操作恢复资料超过 8 MiB，已保留当前现场。'),{code:'TREE_RECOVERY_LIMIT'});
        record=prepared;await write(record);
      },onPublished:async facts=>{
        effect=facts;record={...record,phase:'published',effect};await write(record);
        // Sources remain pinned until the checked metadata/draft commit joins.
        // Any failure retains both plans; public names are never rolled back.
        await storage.replaceProjectCollections(projectId,collections,{expectedCollections});
        record={...record,phase:'metadata-committed'};await write(record);
        record={...record,phase:'complete'};
        const result=await storage.putRecoveryRecords(projectId,[...[...drafts,...pptDrafts].flatMap(draft=>[
          {id:draft.next,value:draft.nextValue,expectedRevision:draft.nextRevision},
          {id:draft.id,value:null,expectedRevision:draft.revision},
        ]),{id:journal,value:record,expectedRevision:revision}]);
        revision=result.revisions.find(row=>row.id===journal).revision;
      }});
      return {relPath:destination,...(action!=='copy'?{from:source}:{}),operationId,transfer:effect};
    }catch(error){
      const facts=effect??error.treeTransfer??record.effect;
      const published=Boolean(facts?.published||error.committed),unknown=Boolean(error.commitUnknown||error.code==='STORAGE_RESULT_UNKNOWN');
      // A stage cleanup failure also needs human reconciliation; never claim
      // an orphan was removed solely because no public destination appeared.
      const retained={...record,phase:published||unknown||facts?.retainedStage||error.cleanupErrors?.length?'needs-attention':'refused',effect:facts??null,error:{code:error.code??'TREE_TRANSFER_FAILED',message:error.message,committed:published,commitUnknown:unknown}};
      try{await write(retained);}catch(journalError){error.journalError={code:journalError.code,message:journalError.message};}
      if(published){error.committed=true;error.durability='uncertain';}
      error.details={...error.details,operationId,source,destination,recoveryKey:journal,transfer:facts??null,...(published?{committed:true,durability:'uncertain'}:{}),...(unknown?{commitUnknown:true}:{})};throw error;
    }
  }
  async createEntry(project,{projectId,action,rel}){
    const storage=this.host.storage;await this.assertTreeAdmission(projectId);
    const operationId=randomUUID(),journal='tree-operation:'+operationId;
    let record={schema:1,kind:'record',sameProject:true,projectBinding:projectBinding(project),creation:true,projectId,operationId,action,relPath:rel,destination:rel,phase:'intent',createdAt:new Date().toISOString()},effect,revision=0;
    const write=async value=>{const result=await storage.putRecovery(projectId,journal,value,{expectedRevision:revision});revision=result.revision;};
    // An acknowledged intent always precedes a public namespace effect.
    await write(record);
    try{
      effect=await this.io.createEntry(project,rel,{kind:action==='createFolder'?'directory':'file',operationId,onPrepared:async facts=>{
        record={...record,phase:'allocated',effect:facts};await write(record);
      }});
      record={...record,phase:'complete',effect};await write(record);
      return {relPath:rel,operationId,creation:effect};
    }catch(error){
      const facts=effect??error.treeCreation??record.effect;
      const published=Boolean(facts?.published||error.committed),unknown=Boolean(error.commitUnknown||error.code==='STORAGE_RESULT_UNKNOWN');
      const retained={...record,phase:published||unknown?'needs-attention':'refused',effect:facts??null,error:{code:error.code??'TREE_CREATE_FAILED',message:error.message,committed:published,commitUnknown:unknown}};
      try{await write(retained);}catch(journalError){error.journalError={code:journalError.code,message:journalError.message};}
      if(published){error.committed=true;error.durability='uncertain';}
      error.details={...error.details,operationId,destination:rel,recoveryKey:journal,creation:facts??null,...(published?{committed:true,durability:'uncertain'}:{}),...(unknown?{commitUnknown:true}:{})};
      throw error;
    }
  }
  // Cross-project copy/cut: the payload's projectId is the destination and
  // sourceProjectId the origin. Destination entries always get a fresh
  // identity: no tags, change ledgers, provenance, drafts or other source
  // session material is copied or referenced across projects.
  async assertCrossDestination(project,destination){
    const storage=this.host.storage,id=project.id;
    if((await new FileTags({storage,projectId:id,root:project.root}).all()).some(row=>inside(row.file.relPath,destination)))fail('目标位置保留有标签恢复资料，请使用其他名称。');
    if((await new FileChanges({storage,projectId:id,root:project.root}).all()).some(row=>inside(row.relPath,destination)))fail('目标位置保留有修改历史，请使用其他名称。');
    if((await storage.listProject(id,'provenance')).some(row=>inside(row.id,destination)))fail('目标位置保留有来源恢复资料，请使用其他名称。');
    for await(const row of storage.recoveryRecords(id,{prefixes:['draft:','workspace:'],relPaths:[destination]}))if(row.value?.relPath&&inside(row.value.relPath,destination))fail('目标位置保留有草稿或工作面恢复资料，请先恢复或使用其他名称。');
  }
  async importClipboardEntry(project,item,destination,{beforeCommit=async()=>{}}={}){
    if(process.platform!=='win32'||!this.io.recoverableTransfer)throw Object.assign(Error('Native clipboard import unavailable'),{code:'TREE_IMPORT_UNSUPPORTED'});
    const storage=this.host.storage,projectId=project.id;await this.assertTreeAdmission(projectId);await this.assertCrossDestination(project,destination);
    const {openWindowsClipboardSource}=await import('../platform/windows/clipboard-source.mjs');
    const operationId=randomUUID(),journal='tree-operation:'+operationId,record={schema:1,kind:'record',transfer:true,clipboardImport:true,operationId,projectId,action:'copy',source:item.source,sourceIdentity:item.nativeIdentity,sourceVersion:item.identity,destination,relPath:destination,phase:'intent',createdAt:new Date().toISOString(),metadataPolicy:'fresh-target; source-unchanged'},sourceProject={root:path.dirname(item.source),id:null};
    let revision=0,effect,lease;
    const write=async(phase,extra={})=>{const value={...record,phase,effect:effect??null,...extra};if(Buffer.byteLength(JSON.stringify(value))>8*1024*1024)throw Object.assign(Error('复制恢复计划超过 8 MiB，已保留现场。'),{code:'TREE_RECOVERY_LIMIT'});const result=await storage.putRecovery(projectId,journal,value,{expectedRevision:revision});revision=result.revision;};
    try{
      await write('intent');lease=await openWindowsClipboardSource(item.source,item);
      effect=await this.io.transferEntry(project,lease.relative,destination,{sourceProject,sourceLease:lease,action:'copy',operationId,
        onPrepared:async facts=>{effect=facts;await write('prepared');},
        beforeCommit:async()=>{await lease.verify();storage.assertActive(projectId);await beforeCommit();await this.assertCrossDestination(project,destination);},
        onPublished:async facts=>{effect=facts;await write('published');await this.assertCrossDestination(project,destination);await write('complete');}});
      return {relPath:destination,operationId,transfer:effect};
    }catch(error){
      effect=error.treeTransfer??effect;const published=Boolean(effect?.published||error.committed),unknown=Boolean(error.commitUnknown||error.code==='STORAGE_RESULT_UNKNOWN'),attention=published||unknown||effect?.retainedStage||effect?.stagingName||error.cleanupErrors?.length;
      try{await write(attention?'needs-attention':'refused',{error:{code:error.code??'TREE_IMPORT_FAILED',message:String(error.message).slice(0,2000),committed:published,commitUnknown:unknown}});}catch(failure){
        error.journalError={code:failure.code,message:failure.message};
        // A lost final acknowledgement can leave the winner already complete.
        // Keep that CAS winner intact and reserve an independent uncertainty
        // receipt so cold admission cannot silently release this host's hold.
        const hold='tree-operation:'+randomUUID();try{await storage.putRecovery(projectId,hold,{schema:1,kind:'record',clipboardImport:true,operationId,relatedRecoveryKey:journal,projectId,destination,relPath:destination,phase:'needs-attention',published,commitUnknown:unknown,retainedAt:new Date().toISOString()},{expectedRevision:0});error.uncertaintyRecoveryKey=hold;}catch(holdError){error.uncertaintyJournalError={code:holdError.code,message:holdError.message};}
      }
      if(published){error.committed=true;error.durability='uncertain';}error.details={...error.details,operationId,recoveryKey:journal,projectId,destination,transfer:effect??null};throw error;
    }finally{lease?.close();}
  }
  async transferCrossEntry({project,sourceProject,projectId,sourceProjectId,action,source,destination},surfaceContext={}){
    const storage=this.host.storage;
    await this.assertTreeAdmission(sourceProjectId);await this.assertTreeAdmission(projectId);
    await assertTreeCopySaved(this,sourceProject,[source]);await this.assertCrossDestination(project,destination);
    const operationId=randomUUID(),journal='tree-operation:'+operationId,createdAt=new Date().toISOString();
    const revisions=new Map([[sourceProjectId,0],[projectId,0]]);let globalRevision=0,effect,globalWritten=false;
    const base={schema:1,kind:'record',transfer:true,crossTransfer:true,operationId,action,source,sourceProjectId,destination,destinationProjectId:projectId,createdAt,
      sourceBinding:{instanceId:sourceProject.instanceId,identity:sourceProject.identity},destinationBinding:{instanceId:project.instanceId,identity:project.identity},
      metadataPolicy:'fresh-destination-document-identities; source-metadata-and-recovery-retained',sourceDisposition:action==='cut'?'same-volume-native-move':'unchanged',
      ...(surfaceContext.descriptors?.length?{surfaceRecovery:surfaceContext.descriptors}:{})};
    let phase='intent';
    const writePair=async(next,extra={})=>{
      phase=next;
      for(const id of [sourceProjectId,projectId]){
        const value={...base,projectId:id,role:id===sourceProjectId?'source':'destination',relPath:id===sourceProjectId?source:destination,phase:next,effect:effect??null,...extra};
        if(Buffer.byteLength(JSON.stringify(value))>8*1024*1024)throw Object.assign(Error('跨项目操作恢复资料超过 8 MiB，已保留现场。'),{code:'TREE_RECOVERY_LIMIT'});
        const result=await storage.putRecovery(id,journal,value,{expectedRevision:revisions.get(id)});revisions.set(id,result.revision);
      }
    };
    const writeGlobal=async(next,settled=false,extra={})=>{
      const value={schema:1,kind:'record',crossTransfer:true,operationId,projectId,sourceProjectId,createdAt,action,source:source.slice(0,128),destination:destination.slice(0,128),phase:next,settled,
        sourceInstanceId:sourceProject.instanceId,destinationInstanceId:project.instanceId,sourceIdentity:effect?.sourceIdentity??null,identity:effect?.identity??null,digest:effect?.digest??null,
        published:effect?.published===true,sourceReceipt:next==='complete'?'acknowledged':null,destinationReceipt:next==='complete'?'acknowledged':null,...extra};
      const result=await storage.putCrossTreeTransfer(journal,value,{expectedRevision:globalRevision});globalRevision=result.revision;globalWritten=true;
    };
    try{
      // No effect starts until both local receipts and the common guard exist.
      await writePair('intent');await writeGlobal('intent');
      await surfaceContext.beforeCrossEffect?.(base);
      effect=await this.io.transferEntry(project,source,destination,{sourceProject,action,operationId,
        onPrepared:async facts=>{effect=facts;await writePair('prepared');await writeGlobal('prepared');},
        beforeCommit:async()=>{storage.assertActive(sourceProjectId);storage.assertActive(projectId);await assertTreeCopySaved(this,sourceProject,[source]);await this.assertCrossDestination(project,destination);},
        onPublished:async facts=>{
          effect=facts;await writeGlobal('published');await writePair('published');
          await this.assertCrossDestination(project,destination);
          // Neither project's annotations, drafts or history are rewritten.
          // The registry commits only after both scopes acknowledge the facts.
          await writePair('acknowledged');await writeGlobal('complete',true);await writePair('complete');
        }});
      return {relPath:destination,sourceProjectId,operationId,transfer:effect,...(action==='cut'?{sourceFrom:source,moved:true}:{})};
    }catch(error){
      effect=error.treeTransfer??effect;const published=Boolean(effect?.published||error.committed),unknown=Boolean(error.commitUnknown||error.code==='STORAGE_RESULT_UNKNOWN');
      const attention=published||unknown||effect?.retainedStage||error.cleanupErrors?.length;
      const errorFacts={code:error.code??'TREE_TRANSFER_FAILED',message:String(error.message).slice(0,2000),committed:published,commitUnknown:unknown},journalErrors=[];
      if(attention)try{await writeGlobal('needs-attention',false,{error:errorFacts});}catch(failure){journalErrors.push({scope:'catalog',code:failure.code,message:failure.message});}
      try{await writePair(attention?'needs-attention':'refused',{error:errorFacts});}catch(failure){journalErrors.push({scope:'paired-receipts',code:failure.code,message:failure.message});}
      if(!attention||journalErrors.length)try{await writeGlobal(journalErrors.length?'needs-attention':'refused',!journalErrors.length,{error:errorFacts});}catch(failure){journalErrors.push({scope:'catalog-final',code:failure.code,message:failure.message});}
      if(journalErrors.length)error.journalErrors=journalErrors;
      if(published){error.committed=true;error.durability='uncertain';}
      error.details={...error.details,operationId,recoveryKey:journal,projectId,sourceProjectId,source,destination,phase,registryWritten:globalWritten,transfer:effect??null,
        ...(published?{committed:true,durability:'uncertain',sourceRemoved:action==='cut'}:{}),...(unknown?{commitUnknown:true}:{})};
      throw error;
    }
  }
  async performCross({ project, projectId, sourceProjectId, action, source, target },surfaceContext={}) {
    if(!this.io.recoverableCrossTransfer){requireCapability('safe-file-io');requireCapability('durable-persistence');}
    const sourceProject = await this.host.requireProject(sourceProjectId);
    const src = await this.locate(sourceProject, source);
    const stat = await fs.lstat(src);
    this.io.requireTransferKind?.(stat);
    await this.assertTransferable(src, stat);
    const parent = await this.locate(project, target, true);
    const base = path.basename(src);
    const destination = [target, base].filter(Boolean).join('/');
    const dest = path.join(parent, base);
    // A destination physically inside the copied subtree would recurse into itself.
    const nested = path.relative(src, dest);
    if (nested === '' || (!nested.startsWith('..') && !path.isAbsolute(nested))) fail('不能把项目内容复制到自身内部。');
    if (await exists(dest)) fail('目标已存在，未覆盖。请先重命名。');
    const destTags = new FileTags({ storage: this.host.storage, projectId, root: project.root });
    if ((await destTags.all()).some(s => inside(s.file.relPath, destination))) fail('目标位置保留有标签恢复资料，请使用其他名称。');
    const destChanges = new FileChanges({ storage: this.host.storage, projectId, root: project.root });
    if ((await destChanges.all()).some(s => inside(s.relPath, destination))) fail('目标位置保留有修改历史，请使用其他名称。');
    const srcChanges = new FileChanges({ storage: this.host.storage, projectId: sourceProjectId, root: sourceProject.root });
    if ((await srcChanges.all()).some(s => inside(s.relPath, source) && s.pending)) fail('文档有待恢复的修改批次，请先重新打开文档后操作。');
    // A durable unsaved draft means the disk bytes are not the user's content:
    // refuse instead of snapshotting stale bytes.
    for await (const { id, value } of this.host.storage.recoveryRecords(sourceProjectId,{prefixes:['draft:']}))
      if (id.startsWith('draft:') && value?.relPath && inside(value.relPath, source) && value.status !== 'saved') fail('源文件存在未保存的草稿，请先打开并保存后再跨项目操作。');
    if(this.io.recoverableCrossTransfer)return this.transferCrossEntry({project,sourceProject,projectId,sourceProjectId,action,source,destination},surfaceContext);
    let destinationCreated = false, sourceRemoved = false, copyComplete = false;
    try {
      // Reserve the destination, then fill it; exclusive flags keep another
      // writer from merging into the same path.
      if (stat.isDirectory()) {
        await fs.mkdir(dest); destinationCreated = true;
        for (const entry of await fs.readdir(src)) await fs.cp(path.join(src, entry), path.join(dest, entry), { recursive: true, force: false, errorOnExist: true });
      } else { await fs.copyFile(src, dest, 1); destinationCreated = true; }
      copyComplete = true;
      // Cut removes the source only after the destination is durable; the
      // source's own tags and recovery material stay behind so a restore from
      // the system trash keeps its history.
      if (action === 'cut') { await this.trash(src); sourceRemoved = true; }
    } catch (error) {
      if(action==='cut'&&copyComplete){
        const recoveryKey='tree-operation:'+randomUUID();
        await this.host.storage.putRecovery(projectId,recoveryKey,{action,sourceProjectId,source,destination,phase:'needs-attention',destinationRetained:true,error:{message:error.message}});
        error.message+='；目标副本已保留，请核对源路径与系统回收站，未删除任何恢复资料。';
      }else if(destinationCreated&&!sourceRemoved){
        try{await fs.rm(dest,{recursive:true,force:true});}
        catch(rollbackError){await this.host.storage.putRecovery(projectId,'tree-operation:'+randomUUID(),{action,sourceProjectId,source,destination,phase:'needs-attention',destinationRetained:true,error:{message:error.message},rollbackError:{message:rollbackError.message}});}
      }
      throw error;
    }
    // No `from`/`removed` keys: the generic same-project UI would otherwise
    // remap a same-named destination path that never was the source file.
    return { relPath: destination, sourceProjectId, ...(action === 'cut' ? { sourceFrom: source, moved: true } : {}) };
  }
}
