import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function fileArguments(argv,{packaged=false,cwd=process.cwd()}={}) {
 const args=argv.slice(packaged?1:2),paths=[];
 for(const arg of args){if(!arg||arg.startsWith('-'))continue;try{const file=arg.startsWith('file:')?fileURLToPath(arg):path.resolve(cwd,arg);if(!paths.includes(file))paths.push(file);}catch{}}
 return paths;
}
export async function externalTarget(host,file){
 const absolute=path.resolve(file),stat=await fs.lstat(absolute);
 if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw Error('只能打开本地普通文件或项目目录。');
 const actual=await fs.realpath(absolute);
 const recent=await host.recent();
 const enclosing=recent.projects.filter(p=>p.available&&p.rootDisplay&&(actual===p.rootDisplay||actual.startsWith(p.rootDisplay+path.sep))).sort((a,b)=>b.rootDisplay.length-a.rootDisplay.length)[0];
 const root=stat.isDirectory()?actual:enclosing?.rootDisplay||path.dirname(actual);
 const {project}=await host.pick(root);
 return {projectId:project.id,relPath:stat.isFile()?path.relative(root,actual).split(path.sep).join('/'):null};
}

// Queue-only helpers. Existing argument/target exports retain their behavior.
export function parseExternalArguments(argv,options={}) {
 const {packaged=false,cwd=process.cwd()}=options,paths=[],errors=[];
 for(const arg of argv.slice(packaged?1:2)){
  if(!arg||arg.startsWith('-'))continue;
  try{
   if(arg.includes('\0'))throw Error('路径包含空字符。');
   const file=arg.startsWith('file:')?fileURLToPath(arg):path.resolve(cwd,arg);
   if(!paths.includes(file))paths.push(file);
  }catch(error){errors.push({argument:arg,code:'BAD_EXTERNAL_ARGUMENT',message:error.message});}
 }
 return {paths,errors};
}
const changed=message=>Object.assign(Error(message),{code:'OPEN_TARGET_CHANGED'});
async function externalIdentity(file,directory=false){
 const stat=await fs.lstat(file,{bigint:true});
 if(stat.isSymbolicLink()||!(directory?stat.isDirectory():stat.isFile()))throw Object.assign(Error('外部目标必须是本地普通文件或目录。'),{code:'OPEN_TARGET_UNAVAILABLE'});
 return {dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtimeNs:String(stat.mtimeNs)};
}
const sameObject=(a,b)=>a.ino!=='0'&&b.ino!=='0'?a.dev===b.dev&&a.ino===b.ino:true;
export async function bindExternalOpen(host,absolutePath){
 const target=await externalTarget(host,absolutePath),project=await host.requireProject(target.projectId);
 const canonicalTarget=await fs.realpath(absolutePath),kind=target.relPath===null?'directory':'file';
 const binding={projectId:project.id,canonicalRoot:project.root,relPath:target.relPath,canonicalTarget,requestedPath:absolutePath,kind,
  rootIdentity:await externalIdentity(project.root,true),targetIdentity:await externalIdentity(canonicalTarget,kind==='directory')};
 return revalidateExternalOpen(host,binding);
}
export async function revalidateExternalOpen(host,binding,{acceptCurrentFile=false}={}){
 const requested=await fs.lstat(binding.requestedPath);
 if(requested.isSymbolicLink()||await fs.realpath(binding.requestedPath)!==binding.canonicalTarget)throw changed('原请求路径已变化；未重绑。');
 const project=await host.requireProject(binding.projectId);
 if(project.root!==binding.canonicalRoot||await fs.realpath(project.root)!==binding.canonicalRoot)throw changed('项目根路径已变化。');
 const rootIdentity=await externalIdentity(project.root,true);
 if(!sameObject(rootIdentity,binding.rootIdentity))throw changed('项目根对象已替换；未重绑。');
 let target;
 if(binding.kind==='file'){
  const located=await host.resolveFile(project,binding.relPath);
  if(located.missing)throw Object.assign(Error('原请求路径不存在；未用保留草稿代替源文件。'),{code:'OPEN_TARGET_UNAVAILABLE'});
  target=located.abs;
 }else target=project.root;
 if(await fs.realpath(target)!==binding.canonicalTarget)throw changed('目标规范路径已变化；未猜测移动目标。');
 const identity=await externalIdentity(target,binding.kind==='directory');
 if(!sameObject(identity,binding.targetIdentity)&&!(acceptCurrentFile&&binding.kind==='file'))throw changed('原路径对象已替换，请明确重试读取当前文件。');
 if(binding.kind==='file'&&!acceptCurrentFile&&(identity.size!==binding.targetIdentity.size||identity.mtimeNs!==binding.targetIdentity.mtimeNs))throw changed('原路径文件版本已变化，请明确重试。');
 return {...binding,targetIdentity:identity};
}
