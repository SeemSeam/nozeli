// Filesystem primitives for managed tutorial copies. Ownership/permissions live
// in the host's private registry, never in a marker supplied by the project.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const failure=(code,message)=>Object.assign(new Error(message),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const validRelative=value=>typeof value==='string'&&value.length>0&&value.length<240&&!value.includes('\\')&&!path.posix.isAbsolute(value)&&path.posix.normalize(value)===value&&!value.split('/').some(part=>!part||part==='..'||part==='.'||part.startsWith('.'));
export async function demoDirectoryIdentity(directory){
 const absolute=path.resolve(directory),stat=await fs.lstat(absolute,{bigint:true});
 if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(absolute)!==absolute)throw failure('DEMO_ROOT_CHANGED','演示目录实体或链接已变化，操作已停止。');
 return {dev:String(stat.dev),ino:String(stat.ino)};
}
export function sameDemoDirectory(a,b){return Boolean(a&&b&&a.dev===b.dev&&a.ino===b.ino);}
export async function loadDemoTemplate(appRoot){
 const directory=path.join(appRoot,'assets','guided-demo');
 await demoDirectoryIdentity(directory);
 const manifestPath=path.join(directory,'manifest.json'),metadata=await fs.lstat(manifestPath);
 if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>65536)throw failure('DEMO_TEMPLATE_INVALID','演示模板清单无效。');
 const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
 if(manifest.schemaVersion!==1||typeof manifest.id!=='string'||typeof manifest.version!=='string'||!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>64)throw failure('DEMO_TEMPLATE_INVALID','演示模板版本或文件列表无效。');
 const seen=new Set(),files=[];
 for(const item of manifest.files){
  if(!validRelative(item.path)||seen.has(item.path)||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>32*1024*1024||!/^[a-f0-9]{64}$/.test(item.sha256??''))throw failure('DEMO_TEMPLATE_INVALID','演示模板包含不安全的文件条目。');
  seen.add(item.path);
  const file=path.join(directory,...item.path.split('/')),stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(file)!==file||stat.size!==item.bytes)throw failure('DEMO_TEMPLATE_INVALID','演示材料实体或大小不匹配：'+item.path);
  const bytes=await fs.readFile(file);
  if(sha(bytes)!==item.sha256)throw failure('DEMO_TEMPLATE_INVALID','演示材料已损坏：'+item.path);
  files.push({...item,bytes});
 }
 return {directory,manifest,files};
}
export async function createDemoDirectory({template,examplesRoot}){
 const requested=path.resolve(examplesRoot);
 await fs.mkdir(requested,{recursive:true});
 await demoDirectoryIdentity(requested);
 const root=await fs.mkdtemp(path.join(requested,'Nozeli-demo-'));
 const identity=await demoDirectoryIdentity(root);
 try{
  for(const item of template.files){
   if(!validRelative(item.path)||sha(item.bytes)!==item.sha256)throw failure('DEMO_TEMPLATE_INVALID','复制前演示模板校验失败。');
   const destination=path.join(root,...item.path.split('/'));
   await fs.mkdir(path.dirname(destination),{recursive:true});
   await fs.writeFile(destination,item.bytes,{flag:'wx'});
  }
  if(!sameDemoDirectory(identity,await demoDirectoryIdentity(root)))throw failure('DEMO_ROOT_CHANGED','创建期间演示目录被替换。');
  return {root,identity,templateId:template.manifest.id,templateVersion:template.manifest.version,expectedFiles:Object.fromEntries(template.files.map(item=>[item.path,item.sha256]))};
 }catch(error){error.incompleteDemoRoot=root;throw error;}
}
// This is a preview, never deletion authority. Unknown content is reported,
// not read or overwritten. The ordinary project lifecycle owns final cleanup.
export async function compareDemoFiles(root,expectedFiles,{maxEntries=2048}={}){
 await demoDirectoryIdentity(root);
 const changes=[],seen=new Set(),directories=new Set();let entries=0;
 for(const file of Object.keys(expectedFiles))for(let parent=path.posix.dirname(file);parent!=='.';parent=path.posix.dirname(parent))directories.add(parent);
 const version=stat=>({dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)});
 async function walk(relative,depth){
  if(depth>8){changes.push({path:relative,kind:'uninspected'});return;}
  for(const item of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
   if(relative===''&&['.nozeli','.git'].includes(item.name))continue;
   const rel=relative?relative+'/'+item.name:item.name;
   if(++entries>maxEntries){changes.push({path:relative||'.',kind:'uninspected'});return;}
   const file=path.join(root,...rel.split('/')),stat=await fs.lstat(file,{bigint:true});
   if(stat.isSymbolicLink()){changes.push({path:rel,kind:'link',version:version(stat)});continue;}
   if(stat.isDirectory()){if(!directories.has(rel))changes.push({path:rel,kind:'added-directory',version:version(stat)});await walk(rel,depth+1);continue;}
   if(!stat.isFile()){changes.push({path:rel,kind:'special',version:version(stat)});continue;}
   seen.add(rel);
   if(!Object.hasOwn(expectedFiles,rel)){changes.push({path:rel,kind:'added',version:version(stat)});continue;}
   if(stat.size>32*1024*1024||sha(await fs.readFile(file))!==expectedFiles[rel])changes.push({path:rel,kind:'modified',version:version(stat)});
  }
 }
 await walk('',0);
 for(const rel of Object.keys(expectedFiles))if(!seen.has(rel))changes.push({path:rel,kind:'missing'});
 return changes.sort((a,b)=>a.path.localeCompare(b.path)||a.kind.localeCompare(b.kind));
}
