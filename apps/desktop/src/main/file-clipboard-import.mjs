import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {FileTags} from '../domain/file-tags.mjs';
import {FileChanges} from '../domain/file-changes.mjs';
import {fileIdentity,sameFileIdentity} from './file-clipboard.mjs';

const inside=(file,root)=>{const rel=path.relative(root,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
const under=(rel,parent)=>rel===parent||rel.startsWith(parent+'/');
const fail=message=>{throw Error(message);};
async function noLinks(file){if(await fs.realpath(file)!==path.resolve(file))fail('不支持通过符号链接读取或写入文件。');const stat=await fs.lstat(file);if(stat.isSymbolicLink())fail('不支持符号链接。');return stat;}
async function sameDirectory(file,identity){const stat=await noLinks(file);if(!stat.isDirectory()||stat.dev!==identity.dev||stat.ino!==identity.ino)fail('目标目录已被其他操作替换，未继续写入。');return stat;}

// Roll back only unchanged nodes created by this import, leaf first. Never
// recursively remove a reserved directory: another writer's entries survive.
async function rollback(created){let retained=false;for(const node of created.reverse()){
  try{const stat=await fs.lstat(node.file),identity=fileIdentity(stat);if(node.directory?stat.dev!==node.identity.dev||stat.ino!==node.identity.ino||!stat.isDirectory():Object.keys(node.identity).some(key=>key!=='ctimeMs'&&node.identity[key]!==identity[key])){retained=true;continue;}if(node.directory)await fs.rmdir(node.file);else await fs.unlink(node.file);}
  catch(error){if(error.code!=='ENOENT')retained=true;}
}return retained;}
async function copyNode(source,dest,created,expected,parentIdentity){
  await sameDirectory(path.dirname(dest),parentIdentity);
  const before=await noLinks(source);
  if(expected&&!sameFileIdentity(expected,fileIdentity(before)))fail('源文件已变化，未复制。');
  if(before.isDirectory()){
    await fs.mkdir(dest);const owned={file:dest,directory:true,identity:fileIdentity(await fs.lstat(dest))};created.push(owned);
    for(const entry of await fs.readdir(source)){
      if(entry==='.nozeli'||entry==='.git')fail('目录包含独立项目元数据，未执行操作。');
      await sameDirectory(dest,owned.identity);await copyNode(path.join(source,entry),path.join(dest,entry),created,undefined,owned.identity);
    }
    await sameDirectory(dest,owned.identity);
    if(!sameFileIdentity(fileIdentity(before),fileIdentity(await noLinks(source))))fail('源目录已变化，未完成复制。');
  }else if(before.isFile()){
    const input=await fs.open(source,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let output,temporaryOwned;
    const temporary=path.join(path.dirname(dest),'.nozeli-import-'+randomUUID());
    try{
      if(!sameFileIdentity(fileIdentity(before),fileIdentity(await input.stat())))fail('源文件已变化，未复制。');
      await sameDirectory(path.dirname(dest),parentIdentity);
      output=await fs.open(temporary,'wx',0o600);temporaryOwned=fileIdentity(await output.stat());
      const buffer=Buffer.allocUnsafe(64*1024);for(;;){const {bytesRead}=await input.read(buffer,0,buffer.length,null);if(!bytesRead)break;let written=0;while(written<bytesRead){const result=await output.write(buffer,written,bytesRead-written,null);written+=result.bytesWritten;}}
      if(!sameFileIdentity(fileIdentity(before),fileIdentity(await input.stat()))||!sameFileIdentity(fileIdentity(before),fileIdentity(await noLinks(source))))fail('源文件已变化，未完成复制。');
      // Preserve executable/read-only bits without importing setuid/setgid.
      await output.chmod(before.mode & 0o777);
      await output.sync();
      const identity=fileIdentity(await output.stat());
      await sameDirectory(path.dirname(dest),parentIdentity);
      await fs.link(temporary,dest);created.push({file:dest,directory:false,identity});
    }finally{
      await output?.close();await input.close();
      if(temporaryOwned){const stat=await fs.lstat(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});if(stat&&stat.dev===temporaryOwned.dev&&stat.ino===temporaryOwned.ino)await fs.unlink(temporary);}
    }
  }else fail('仅支持普通文件和文件夹，不支持链接或特殊文件。');
}
async function recoveryGuard(host,project,rel,source){
  const changes=await new FileChanges({storage:host.storage,projectId:project.id,root:project.root}).all();
  if(changes.some(row=>under(row.relPath,rel)&&(!source||row.pending)))fail(source?'源文件有待恢复的修改批次。':'目标位置保留有修改历史，请使用其他名称。');
  if(!source&&(await new FileTags({storage:host.storage,projectId:project.id,root:project.root}).all()).some(row=>under(row.file.relPath,rel)))fail('目标位置保留有标签恢复资料，请使用其他名称。');
  for(const {value} of await host.storage.listRecovery(project.id))if(value?.relPath&&under(value.relPath,rel)&&(!source||value.status!=='saved'))fail(source?'源文件存在未保存的草稿，请保存后再复制。':'目标位置保留有草稿恢复资料，请使用其他名称。');
}
export function importClipboardFiles(ops,items,{projectId,target=''}){
  const task=ops.pending.then(async()=>{
    const registered=await ops.host.storage.list();
    const sources=registered.filter(project=>!project.removed&&items.some(item=>inside(item.source,project.root)));
    const ids=[...new Set([projectId,...sources.map(project=>project.id)])].sort();
    const execute=async()=>{
      const project=await ops.host.requireProject(projectId),parent=await ops.locate(project,target,true);
      const parentIdentity=fileIdentity(await noLinks(parent));if(!(await fs.lstat(parent)).isDirectory())fail('目标不是文件夹。');
      const results=[];
      for(const item of items){const created=[];let relPath;
        try{
          ops.validName(item.name);relPath=[target,item.name].filter(Boolean).join('/');const dest=path.join(parent,item.name);
          const currentParent=await noLinks(parent);if(currentParent.dev!==parentIdentity.dev||currentParent.ino!==parentIdentity.ino)fail('目标目录已变化。');
          if(inside(dest,item.source))fail('不能将文件夹放入自身或子目录。');
          const stat=await noLinks(item.source);if(!sameFileIdentity(item.identity,fileIdentity(stat)))fail('源文件已变化，请重新复制。');
          if(path.resolve(item.source).split(path.sep).some(part=>part==='.nozeli'||part==='.git'))fail('不能复制项目运行元数据。');
          await ops.assertTransferable(item.source,stat);
          await recoveryGuard(ops.host,project,relPath,false);
          for(const source of sources)if(inside(item.source,source.root)){
            await ops.host.requireProject(source.id);const rel=path.relative(source.root,item.source).split(path.sep).join('/');
            if(!rel)fail('不能复制包含项目元数据的项目根目录。');await recoveryGuard(ops.host,source,rel,true);
          }
          await copyNode(item.source,dest,created,item.identity,parentIdentity);
          results.push({name:item.name,ok:true,relPath});
        }catch(error){const retained=await rollback(created),message=error.code==='EEXIST'?'目标已存在，未覆盖，请先重命名。':error.message;results.push({name:item.name,ok:false,error:message+(retained?'；目标含并发修改或未清理内容，已保留，请检查。':'' )});}
      }
      return {items:results,files:results.filter(item=>item.ok).map(item=>item.relPath)};
    };
    const locked=ids.reduceRight((work,id)=>()=>ops.host.storage.withProjectOperation(id,()=>ops.host.projectLock(id)(work)),execute);
    return locked();
  });
  ops.pending=task.catch(()=>{});return ops.host.track(task);
}
