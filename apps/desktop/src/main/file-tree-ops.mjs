import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validateFileLabel } from '../domain/file-label.mjs';
import { FileTags } from '../domain/file-tags.mjs';
import { FileChanges } from '../domain/file-changes.mjs';

const fail = (message) => { throw new Error(message); };
const exists = async p => { try { await fs.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const inside = (rel, parent) => rel === parent || rel.startsWith(parent + '/');
const key = rel => createHash('sha256').update(rel).digest('hex');
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
  constructor(host, { trash }) { this.host = host; this.trash = trash; this.pending = Promise.resolve(); }
  run(input) {
    // Cross-project operations hold both project locks, acquired in a stable
    // order so they can never deadlock against single-project callers.
    const cross = typeof input?.sourceProjectId === 'string' && input.sourceProjectId && input.sourceProjectId !== input.projectId;
    const locks = cross ? [input.projectId, input.sourceProjectId].sort() : [input.projectId];
    const held = locks.reduceRight((work, id) => () => this.host.projectLock(id)(work), () => this.perform(input));
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
    if (typeof name !== 'string' || !name.trim() || name.startsWith('.') || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) fail('请输入有效的文件名，不含路径分隔符或系统保留名称。');
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
  async perform({ projectId, action, sourceProjectId, source = '', target = '', name }) {
    if (sourceProjectId !== undefined && (typeof sourceProjectId !== 'string' || !sourceProjectId)) fail('跨项目源项目无效。');
    const project = await this.host.requireProject(projectId);
    if (sourceProjectId && sourceProjectId !== projectId) {
      if (action !== 'copy' && action !== 'cut') fail('跨项目仅支持复制或剪切。');
      return this.performCross({ project, projectId, sourceProjectId, action, source, target });
    }
    const store = new FileTags({ storage: this.host.storage, projectId, root: project.root });
    const changes = new FileChanges({ storage: this.host.storage, projectId, root: project.root }), allChanges=await changes.all();
    if (action === 'createFile' || action === 'createFolder') {
      const dir = await this.locate(project, target, true);
      const destination = path.join(dir, this.validName(name));
      const rel = [target, name].filter(Boolean).join('/');
      if ((await store.all()).some(s => inside(s.file.relPath, rel)) || allChanges.some(s=>inside(s.relPath,rel))) fail('该名称保留有标签或修改历史恢复资料，请使用其他名称或先恢复原文件。');
      if (action === 'createFolder') await fs.mkdir(destination);
      else { const handle = await fs.open(destination, 'wx'); await handle.close(); }
      return { relPath: [target, name].filter(Boolean).join('/') };
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
    try {
      if (action !== 'copy') {
        for (const { id, value } of await this.host.storage.listRecovery(projectId)) {
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
  // Cross-project copy/cut: the payload's projectId is the destination and
  // sourceProjectId the origin. Destination entries always get a fresh
  // identity: no tags, change ledgers, provenance, drafts or other source
  // session material is copied or referenced across projects.
  async performCross({ project, projectId, sourceProjectId, action, source, target }) {
    const sourceProject = await this.host.requireProject(sourceProjectId);
    const src = await this.locate(sourceProject, source);
    const stat = await fs.lstat(src);
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
    for (const { id, value } of await this.host.storage.listRecovery(sourceProjectId))
      if (id.startsWith('draft:') && value?.relPath && inside(value.relPath, source) && value.status !== 'saved') fail('源文件存在未保存的草稿，请先打开并保存后再跨项目操作。');
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
