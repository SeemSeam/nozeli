import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {FileChanges} from '../domain/file-changes.mjs';
import {decodeRecoveryBytes} from '../domain/office-recovery.mjs';
import {fileIdentity,sameFileIdentity} from './file-clipboard.mjs';

const under=(rel,parent)=>rel===parent||rel.startsWith(parent+'/');
const fail=message=>{throw Error(message);};
const unsafeCapture=value=>value.dirty||value.conflict||value.offline||value.missing||value.documentStatus?.dirty||value.documentStatus?.missing||value.documentStatus?.composing||value.documentStatus?.conflict||value.documentStatus?.offline;
function cleanOfficeCapture(value,disk){
  const proof=value.cleanOfficeBaseline,status=value.documentStatus;
  return !unsafeCapture(value)&&['word','sheet','ppt'].includes(value.kind)&&proof?.schemaVersion===1&&
    typeof proof.sourceDigest==='string'&&/^[a-f0-9]{64}$/.test(proof.sourceDigest)&&
    proof.sourceDigest===value.sourceDigest&&proof.sourceDigest===value.baseDigest&&
    status?.dirty===false&&status.composing===false&&status.conflict===false&&status.missing===false&&
    createHash('sha256').update(disk).digest('hex')===proof.sourceDigest;
}
async function durableGuard(ops,project,paths){
  const host=ops.host;
  const changes=await new FileChanges({storage:host.storage,projectId:project.id,root:project.root}).all();
  if(changes.some(row=>row.pending&&paths.some(rel=>under(row.relPath,rel))))fail('源文件有待恢复的修改批次，请先恢复后再复制。');
  const recovery=await host.storage.listRecovery(project.id),cleanCanonical=new Map();
  for(const {id,value} of recovery){
    if(!id.startsWith('workspace:')||id.includes(':retained:')||!value?.relPath||
      !paths.some(rel=>under(value.relPath,rel))||value.documentSource&&value.documentSource.type!=='project')continue;
    const retainedAt=Date.parse(value.retainedAt);
    if(!Number.isFinite(retainedAt)||!value.cleanOfficeBaseline)continue;
    const source=await ops.locate(project,value.relPath);
    if(cleanOfficeCapture(value,await fs.readFile(source)))cleanCanonical.set(value.relPath,Math.max(cleanCanonical.get(value.relPath)??-Infinity,retainedAt));
  }
  for(const {id,value} of recovery){
    if(!value?.relPath||!paths.some(rel=>under(value.relPath,rel)))continue;
    // Provenance and other journals are not drafts. Workspace capture also
    // runs for clean readers, so status absence is not evidence of dirty input.
    if(id.startsWith('draft:')){
      if(value.status!=='saved')fail('源文件存在未保存的草稿，请先保存后再复制。');
    }else if(id.startsWith('workspace:')){
      if(value.documentSource&&value.documentSource.type!=='project')continue;
      // A newer canonical host-verified clean capture supersedes only archived
      // workspace history, never active captures, drafts or pending changes.
      const archivedAt=Date.parse(value.retainedAt),canonicalAt=cleanCanonical.get(value.relPath);
      if(id.includes(':retained:')&&['word','sheet','ppt'].includes(value.kind)&&Number.isFinite(archivedAt)&&canonicalAt>archivedAt)continue;
      if(unsafeCapture(value))fail('源文件存在未保存或冲突的本机编辑，请先处理后再复制。');
      if(!value.candidate)continue;
      const source=await ops.locate(project,value.relPath);
      const disk=await fs.readFile(source);
      // Office exporters may rewrite an unchanged ZIP. Only a host-issued
      // capture receipt can establish that this is serialization, not editing.
      // Old snapshots and stale nested viewState flags provide no such proof.
      if(cleanOfficeCapture(value,disk))continue;
      let candidate;
      if(typeof value.candidate.text==='string')candidate=Buffer.from(value.candidate.text,'utf8');
      else if(value.candidate.bytes)candidate=Buffer.from(decodeRecoveryBytes(value.candidate.bytes));
      else fail('源文件的本机恢复内容无法核对，请先恢复后再复制。');
      if(!candidate.equals(disk))fail('源文件存在未写回的本机编辑，请先保存后再复制。');
    }
  }
}
async function sourceSnapshot(ops,project,paths){
  const nodes=new Map(),sources=[];
  const walk=async file=>{
    const stat=await fs.lstat(file);
    if(stat.isSymbolicLink()||await fs.realpath(file)!==path.resolve(file))fail('不支持通过符号链接复制文件。');
    if(!stat.isFile()&&!stat.isDirectory())fail('仅支持普通文件和文件夹，不支持特殊文件。');
    nodes.set(file,fileIdentity(stat));
    if(stat.isDirectory())for(const entry of (await fs.readdir(file)).sort()){
      if(entry==='.nozeli'||entry==='.git')fail('目录包含独立项目元数据，未复制。');
      await walk(path.join(file,entry));
    }
    if(!sameFileIdentity(nodes.get(file),fileIdentity(await fs.lstat(file))))fail('源文件已变化，请重新复制。');
  };
  for(const rel of paths){
    const source=await ops.locate(project,rel),stat=await fs.lstat(source);
    await ops.assertTransferable(source,stat);
    sources.push(source);await walk(source);
  }
  return {sources,nodes};
}
// Only validated relative paths enter this API. Absolute native paths stay in
// the host. The mandatory guard rejects stale shell scope and live dirty edits;
// it must never save the user's source file as a side effect of Copy.
export function exportClipboardFiles(ops,clipboard,{owner,projectId,paths,action='copy',guard}){
  if(typeof guard!=='function')throw Error('文件复制缺少源状态保护。');
  if(!['copy','cut'].includes(action)||!Array.isArray(paths)||!paths.length||paths.length>1024||paths.some(rel=>typeof rel!=='string'||!rel))throw Error('文件复制选择无效。');
  const unique=[...new Set(paths)];
  const selected=unique.filter(rel=>!unique.some(parent=>parent!==rel&&under(rel,parent)));
  const execute=async()=>{
    const project=await ops.host.requireProject(projectId);
    // Validate every submitted path, including a child removed by deduplication.
    for(const rel of unique)await ops.locate(project,rel);
    await guard();
    if(action==='cut')return clipboard.mark(owner,projectId,{action,beforeWrite:guard});
    await durableGuard(ops,project,selected);
    const prepared=await sourceSnapshot(ops,project,selected);
    return clipboard.mark(owner,projectId,{action,paths:prepared.sources,beforeWrite:async()=>{
      const current=await ops.host.requireProject(projectId);
      if(current.root!==project.root)fail('源项目已变化，请重新复制。');
      await guard();
      await durableGuard(ops,current,selected);
      const next=await sourceSnapshot(ops,current,selected);
      if(next.nodes.size!==prepared.nodes.size||[...prepared.nodes].some(([file,identity])=>!sameFileIdentity(identity,next.nodes.get(file))))fail('源文件已变化，请重新复制。');
      await guard();
    }});
  };
  const task=ops.pending.then(()=>ops.host.storage.withProjectOperation(projectId,()=>ops.host.projectLock(projectId)(execute)));
  ops.pending=task.catch(()=>{});
  return ops.host.track(task);
}
