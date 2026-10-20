import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {atomicJson} from './workspace.mjs';
import {git,str,read,entries,repository,commitTree,fail,acceptanceCommit} from './git-service.mjs';
export const byteDigest=bytes=>bytes===null?null:createHash('sha256').update(bytes).digest('hex');
const excluded=new Set(['.git','.nozeli','.ccb','node_modules','.venv','venv','__pycache__']);
export function workPath(rel){
 if(typeof rel!=='string'||!rel||rel.length>1024||rel.includes('\\')||/[\x00-\x1f\x7f:*?\[\]]/.test(rel)||rel.split('/').some(p=>!p||p==='.'||p==='..'||excluded.has(p))||path.isAbsolute(rel)||/(^|\/)(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|[^/]+\.(?:pem|key))$/i.test(rel))fail('PATH_REJECTED','路径不可用于Worker：'+rel);return rel;
}
export async function safeBytes(root,rel){const value=await safeFile(root,rel);return value?.bytes??null;}
async function safeFile(root,rel){
 workPath(rel);if(process.platform!=='linux')fail('SAFE_OPEN_UNSUPPORTED','此平台尚无安全逐级文件打开实现');const handles=[];
 try{let directory=await fs.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(directory);
  const parts=rel.split('/');for(const part of parts.slice(0,-1)){directory=await fs.open('/proc/self/fd/'+directory.fd+'/'+part,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(directory);}
  const file=await fs.open('/proc/self/fd/'+directory.fd+'/'+parts.at(-1),constants.O_RDONLY|constants.O_NOFOLLOW);handles.push(file);const stat=await file.stat();if(!stat.isFile()||stat.size>32*1024*1024)fail('PATH_REJECTED','非普通文件或超过32MiB：'+rel);return {bytes:await file.readFile(),mode:stat.mode&0o111?'100755':'100644'};
 }catch(error){if(error.code==='ENOENT')return null;throw error;}finally{for(const handle of handles.reverse())await handle.close();}
}
function documentText(bytes){if(bytes===null)return '';let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('UNSUPPORTED','文档操作仅支持UTF-8文本');}if(text.includes('\0'))fail('UNSUPPORTED','文档操作不支持二进制文件');return text.replace(/\r\n?/g,'\n');}
const splitsSurrogate=(text,at)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at]);
async function documentParent(root,rel){
 workPath(rel);const handles=[];try{let directory=await fs.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(directory);for(const part of rel.split('/').slice(0,-1)){const next='/proc/self/fd/'+directory.fd+'/'+part;await fs.mkdir(next).catch(error=>{if(error.code!=='EEXIST')throw error;});directory=await fs.open(next,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(directory);}return {directory,prefix:'/proc/self/fd/'+directory.fd+'/',close:async()=>{for(const handle of handles.reverse())await handle.close();}};}catch(error){for(const handle of handles.reverse())await handle.close();throw error;}
}
const names=buffer=>buffer.toString().split('\0').filter(Boolean);
const repositoryQueues=new Map();
export class ExecutionWorkspace {
 constructor(store){this.store=store;this.serial=new Map();this.handles=new Map();}
 directory(id){if(!/^[a-zA-Z0-9_-]+$/.test(id))fail('WORK_ID','非法工作标识');return path.join(this.store.root,'execution',id);}
 manifest(id){return path.join(this.store.root,'evidence','execution-'+id+'.json');}
 async readManifest(id){const bytes=await read(this.manifest(id));return bytes?JSON.parse(bytes):null;}
 async save(m){await fs.mkdir(path.dirname(this.manifest(m.workId)),{recursive:true,mode:0o700});await atomicJson(this.manifest(m.workId),m);const work=this.store.state?.works?.find(w=>w.id===m.workId);if(work)work.execution={repo:m.repo,commonDir:m.commonDir,directory:m.directory,branchRef:m.branchRef,baseCommit:m.baseCommit,targetRef:m.targetRef,targetHead:m.targetHead,candidate:m.candidate};}
 locked(id,fn){const action=(this.serial.get(id)||Promise.resolve()).then(fn);this.serial.set(id,action.catch(()=>{}));return action;}
 repositoryLocked(fn){const key=this.store.content,action=(repositoryQueues.get(key)||Promise.resolve()).then(fn);repositoryQueues.set(key,action.catch(()=>{}));return action;}
 async reconcileTarget(m){
  if(m.finishIntent)return;const head=await str(m.repo,['rev-parse',m.targetRef]);if(head===m.targetHead)return;
  const known=new Map();for(const work of this.store.state?.works||[]){const other=await this.readManifest(work.id);if(other?.repo===m.repo&&other.targetRef===m.targetRef&&other.finishIntent?.status==='integrated')known.set(other.finishIntent.commit,other);}
  let cursor=head;const chain=[];while(cursor!==m.targetHead){const other=known.get(cursor);if(!other)fail('HEAD_DRIFT','目标分支有非受管提交，未自动猜测合入');chain.push(other);cursor=other.targetHead;if(chain.length>known.size)fail('HEAD_DRIFT','受管提交证明链无效');}
  const changed=new Set(names(await git(m.repo,['diff','--name-only','-z',m.targetHead,head])));if(m.candidate?.files.some(rel=>changed.has(rel)))fail('TARGET_OVERLAP','其他工作修改了同一文件，请核对候选');
  m.targetHistory??=[];m.targetHistory.push({from:m.targetHead,to:head,managedWorks:chain.map(row=>row.workId)});m.targetHead=head;await this.save(m);
 }
 async identity(m,{target=true,worker=true}={}){
  if(worker){const directory=await fs.lstat(m.directory),pointer=await fs.lstat(path.join(m.directory,'.git'));if(directory.isSymbolicLink()||!directory.isDirectory()||pointer.isSymbolicLink()||!pointer.isFile()||await fs.realpath(m.directory)!==m.directory)fail('IDENTITY_CHANGED','执行目录或Git指针被替换');}
  const repo=await repository(m.repo);for(const key of ['repo','gitDir','commonDir','targetRef'])if(repo[key]!==m[key])fail('IDENTITY_CHANGED','仓库身份或目标分支变化：'+key);
  if(target&&repo.targetHead!==m.targetHead&&repo.targetHead!==m.finishIntent?.commit)fail('HEAD_DRIFT','目标HEAD已变化；请保留候选并核对');
  if(worker){if((await read(path.join(m.directory,'.git')))?.toString()!==m.gitPointer)fail('IDENTITY_CHANGED','Worker Git指针变化');
   if(await fs.realpath(await str(m.directory,['rev-parse','--absolute-git-dir']))!==m.workerGitDir||await fs.realpath(path.resolve(m.directory,await str(m.directory,['rev-parse','--git-common-dir'])))!==m.commonDir||await str(m.directory,['symbolic-ref','HEAD'])!==m.branchRef)fail('IDENTITY_CHANGED','Worker Git身份变化');
   const registered=names(await git(m.repo,['worktree','list','--porcelain','-z']));if(!registered.includes('worktree '+m.directory)||!registered.includes('branch '+m.branchRef))fail('IDENTITY_CHANGED','受管worktree注册变化');
   if(await str(m.repo,['rev-parse',m.branchRef])!==(m.candidate?.commit||m.inputCommit||m.baseCommit))fail('WORKER_REF_CHANGED','Worker分支被外部修改');
   if((await read(path.join(m.workerGitDir,'gitdir')))?.toString().trim()!==path.join(m.directory,'.git'))fail('IDENTITY_CHANGED','Worker反向注册变化');
  }return repo;
 }
 async blob(cwd,bytes){const file=path.join(this.store.root,'evidence','blob-'+randomUUID());await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});try{return await str(cwd,['hash-object','-w','--no-filters',file]);}finally{await fs.unlink(file);}}
 async snapshot(m,root,parent,label){
  const index=path.join(this.store.root,'evidence','index-'+randomUUID());const env={GIT_INDEX_FILE:index};await fs.mkdir(path.dirname(index),{recursive:true});
  try{await git(m.repo,['read-tree',parent],env);const tracked=entries(await git(m.repo,['ls-tree','-r','-z',parent])),selected=new Set([...tracked.keys(),...names(await git(root,['ls-files','-co','--exclude-standard','-z']))]);let total=0;const files={};
   for(const rel of [...selected].sort()){
    try{workPath(rel);}catch(error){if(tracked.has(rel))throw error;continue;}
    const captured=await safeFile(root,rel),bytes=captured?.bytes??null;if(bytes===null){await git(m.repo,['update-index','--force-remove','--',rel],env);continue;}
    total+=bytes.length;if(total>256*1024*1024||Object.keys(files).length>=10000)fail('SNAPSHOT_LIMIT','候选超过256MiB/10000文件边界');
    const mode=captured.mode,oid=await this.blob(m.repo,bytes);
    if(byteDigest(await safeBytes(root,rel))!==byteDigest(bytes))fail('SOURCE_CHANGED','文件在快照期间变化：'+rel);
    await git(m.repo,['update-index','--add','--cacheinfo',mode,oid,rel],env);files[rel]={digest:byteDigest(bytes),mode,oid};
   }
   const tree=await str(m.repo,['write-tree'],env),commit=await commitTree(m.repo,tree,[parent],label,path.dirname(this.manifest(m.workId)));return {tree,commit,files};
  }finally{await fs.rm(index,{force:true});}
 }
 async prepare(id){return this.locked(id,()=>this.repositoryLocked(()=>this.prepareInner(id)));}
 async initializeRepository(){
  const root=await fs.realpath(this.store.content);let top=await str(root,['rev-parse','--show-toplevel']).catch(()=>null);
  if(top&&await fs.realpath(top)!==root)fail('REPO_BOUNDARY','所选项目位于另一个仓库内，请选择仓库根目录');
  const evidence=path.join(this.store.root,'evidence');await fs.mkdir(evidence,{recursive:true});
  const intentFile=path.join(evidence,'repository-init.json');
  if(!top){await atomicJson(intentFile,{repo:root,created:true,status:'requested'});await git(root,['init','--initial-branch=main']);}
  const priorBytes=await read(intentFile),prior=priorBytes?JSON.parse(priorBytes):null,existingHead=await str(root,['rev-parse','--verify','HEAD']).catch(()=>null);
  if(existingHead){if(prior?.status==='ready'&&prior.commit===existingHead&&prior.created){const targetIndex=path.resolve(root,await str(root,['rev-parse','--git-path','index'])),saved=await read(path.join(evidence,'initial.index'));if(!saved)fail('INIT_RECOVERY','初始索引恢复材料缺失');if(!await read(targetIndex)){const h=await fs.open(targetIndex+'.lock','wx',0o600);try{if(await read(targetIndex))fail('INDEX_CHANGED','恢复期间索引变化');await h.writeFile(saved);await h.sync();await h.close();await fs.rename(targetIndex+'.lock',targetIndex);}catch(error){await h.close().catch(()=>{});await fs.rm(targetIndex+'.lock',{force:true});throw error;}}await atomicJson(intentFile,{...prior,status:'complete'});}return;}
  const ref=await str(root,['symbolic-ref','HEAD']),index=path.join(evidence,'initial.index'),env={GIT_INDEX_FILE:index};
  const created=!top||prior?.created===true;await atomicJson(intentFile,{repo:root,ref,created,status:'baseline-requested'});await git(root,['read-tree','--empty'],env);
  for(const rel of names(await git(root,['ls-files','-co','--exclude-standard','-z']))){try{workPath(rel);}catch{continue;}const captured=await safeFile(root,rel);if(!captured)continue;const oid=await this.blob(root,captured.bytes);await git(root,['update-index','--add','--cacheinfo',captured.mode,oid,rel],env);}
  const tree=await str(root,['write-tree'],env),commit=await commitTree(root,tree,[],'Nozeli project baseline',evidence);await atomicJson(intentFile,{repo:root,ref,commit,created,status:'ready'});
  await git(root,['update-ref',ref,commit,'0'.repeat(commit.length)]);
  if(created){const targetIndex=path.resolve(root,await str(root,['rev-parse','--git-path','index'])),lock=targetIndex+'.lock';const h=await fs.open(lock,'wx',0o600);try{if(await read(targetIndex))fail('INDEX_CHANGED','初始化期间索引出现，未覆盖');await h.writeFile(await fs.readFile(index));await h.sync();await h.close();await fs.rename(lock,targetIndex);}catch(error){await h.close().catch(()=>{});await fs.rm(lock,{force:true});throw error;}}
  await atomicJson(intentFile,{repo:root,ref,commit,status:'complete'});await fs.rm(index,{force:true});
 }
 async prepareInner(id){
  let m=await this.readManifest(id);
  if(m?.schema>=2&&m.preparation==='complete'){await this.reconcileFreeze(m);await this.identity(m,{target:false});await this.reconcileDocument(m);await this.save(m);return m;}
  if(!m||m.schema<2){
   await this.initializeRepository();const legacy=m,dir=this.directory(id),repo=await repository(this.store.content),branchRef='refs/heads/nozeli/work-'+id+'-'+randomUUID();
   const exists=await fs.lstat(dir).catch(()=>null);if(exists&&!legacy)fail('BASELINE_MISSING','执行目录已有内容但缺少基线，已保留');
   m={schema:2,workId:id,...repo,directory:dir,branchRef,baseCommit:repo.targetHead,preparation:'requested',legacy:legacy?{manifest:legacy,directory:dir+'.legacy-'+randomUUID()}:undefined};await this.save(m);
  }
  if(m.preparation==='requested'){
   await this.identity(m,{worker:false});
   if(m.legacy&&!await fs.lstat(m.legacy.directory).catch(()=>null))await fs.rename(m.directory,m.legacy.directory);
   if(!await read(path.join(m.directory,'.git'))){await fs.mkdir(path.dirname(m.directory),{recursive:true});const exists=await str(m.repo,['rev-parse','--verify',m.branchRef]).catch(()=>null);if(exists&&exists!==m.baseCommit)fail('WORKER_REF_CHANGED','准备中的分支已变化');await git(m.repo,['worktree','add',...(exists?[]:['-b',m.branchRef.slice(11)]),m.directory,exists?m.branchRef:m.baseCommit]);}
   m.gitPointer=(await fs.readFile(path.join(m.directory,'.git'))).toString();m.workerGitDir=await fs.realpath(await str(m.directory,['rev-parse','--absolute-git-dir']));m.preparation='registered';await this.save(m);
  }
  if(m.preparation==='registered'){
   await this.identity(m);const input=await this.snapshot(m,m.repo,m.baseCommit,'Nozeli input baseline');m.inputCommit=input.commit;m.inputTree=input.tree;m.files=input.files;m.inputProvenance={kind:'disk',head:m.baseCommit,at:new Date().toISOString(),indexDigest:byteDigest(await read(m.index))};m.preparation='input-frozen';await this.save(m);
  }
  if(m.preparation==='input-frozen'){
   if((await read(path.join(m.directory,'.git')))?.toString()!==m.gitPointer)fail('IDENTITY_CHANGED','执行目录Git指针变化');
   const head=await str(m.repo,['rev-parse',m.branchRef]);if(![m.baseCommit,m.inputCommit].includes(head))fail('WORKER_REF_CHANGED','准备中的分支变化');
   await git(m.directory,['reset','--hard',m.inputCommit]);m.preparation='input-installed';await this.save(m);
  }
  if(m.preparation==='input-installed'&&m.legacy){
   const source=m.legacy.directory,selected=new Set(Object.keys(m.legacy.manifest.files||{}));
   const visit=async(dir,rel='')=>{for(const row of await fs.readdir(dir,{withFileTypes:true})){const name=rel?rel+'/'+row.name:row.name;workPath(name);if(row.isDirectory())await visit(path.join(dir,row.name),name);else{if(!row.isFile()||row.isSymbolicLink())fail('LEGACY_UNSAFE','旧候选含特殊文件，已保留：'+name);selected.add(name);}}};await visit(source);
   for(const rel of selected){workPath(rel);const bytes=await safeBytes(source,rel),target=path.join(m.directory,rel);if(bytes===null)await fs.rm(target,{force:true});else{await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}}m.legacy.importedPaths=[...selected];
  }
  m.preparation='complete';await this.save(m);return m;
 }
 async reconcileFreeze(m){if(!m.freezeIntent)return;const head=await str(m.repo,['rev-parse',m.branchRef]);if(head===m.freezeIntent.commit){m.candidate=m.freezeIntent.candidate;delete m.freezeIntent;await this.save(m);}else if(head===m.freezeIntent.before){await git(m.repo,['update-ref',m.branchRef,m.freezeIntent.commit,head]);m.candidate=m.freezeIntent.candidate;delete m.freezeIntent;await this.save(m);}else fail('WORKER_REF_CHANGED','冻结意图与分支不一致');}
 async reconcileDocument(m){
  const intent=m.documentIntent;if(!intent)return;workPath(intent.value.relPath);const digest=byteDigest(await safeBytes(m.directory,intent.value.relPath));
  const cleanup=async()=>{const rel=path.relative(m.directory,intent.temp).split(path.sep).join('/');workPath(rel);if(path.posix.dirname(rel)!==path.posix.dirname(intent.value.relPath))fail('DOCUMENT_RECOVERY','编辑临时文件路径不属于原目录');const parent=await documentParent(m.directory,rel);try{await fs.rm(parent.prefix+path.posix.basename(rel),{force:true});}finally{await parent.close();}};
  if(digest===intent.value.digest){m.documentCalls??={};if(intent.callId)m.documentCalls[intent.callId]={fingerprint:intent.fingerprint,value:intent.value};await cleanup();delete m.documentIntent;await this.save(m);}
  else if(digest===intent.value.beforeDigest){await cleanup();delete m.documentIntent;await this.save(m);}
  else fail('DOCUMENT_RECOVERY','执行文件与持久化编辑意图不一致，已保留现场');
 }
 async publish(work,job,isActive=()=>true,retainCandidate=null){return this.locked(work.id,async()=>{
  const m=await this.prepareInner(work.id);await this.identity(m,{target:false});if(!isActive())fail('WORK_STOPPED','工作已停止');
  const candidate=await this.snapshot(m,m.directory,m.inputCommit,'Nozeli Worker checkpoint '+work.id);candidate.revision=work.revision;candidate.jobId=job?.id;
  candidate.files=names(await git(m.repo,['diff-tree','--no-commit-id','--name-only','-r','-z',m.inputCommit,candidate.commit]));
  m.freezeIntent={commit:candidate.commit,before:m.candidate?.commit||m.inputCommit,candidate};await this.save(m);
  await git(m.repo,['update-ref',m.branchRef,candidate.commit,m.freezeIntent.before]);m.candidate=candidate;delete m.freezeIntent;await this.save(m);const retained=retainCandidate?await retainCandidate(m,candidate):null;return {applied:[],conflicts:[],candidate,...(retained?{changeSet:retained}:{})};
 });}
 async refresh(){fail('INPUT_FROZEN','输入基线已冻结；继续工作会保留原工作目录，不自动覆盖Worker文件');}
 async documentOperation({work,op,arguments:a,callId,isActive=()=>true}){return this.locked(work.id,async()=>{try{
  const m=await this.prepareInner(work.id);await this.identity(m,{target:false});
  const fingerprint=byteDigest(Buffer.from(JSON.stringify({threadId:work.threadId,op,arguments:a}))),prior=m.documentCalls?.[callId];if(op!=='read'&&prior){if(prior.fingerprint!==fingerprint)fail('CONFLICT','调用标识已用于不同编辑');return {ok:true,continueTurn:true,value:{...prior.value,duplicate:true}};}
  if(op==='read'){const rel=workPath(a.relPath),bytes=await safeBytes(m.directory,rel),text=documentText(bytes),digest=byteDigest(bytes),handle=randomUUID();this.handles.set(handle,{workId:work.id,threadId:work.threadId,rel,digest});return {ok:true,readOnly:true,continueTurn:true,value:{relPath:rel,text,digest,version:{digest},readHandle:handle}};}
  const h=this.handles.get(a.readHandle);if(!h||h.workId!==work.id||h.threadId!==work.threadId)fail('READ_HANDLE_REJECTED','需要当前Worker的读取凭据');
  const before=await safeBytes(m.directory,h.rel);if(byteDigest(before)!==h.digest)fail('STALE_VERSION','执行文件已变化，请重新读取');let text=documentText(before),end=text.length;const original=text,edits=[...(a.edits||[])].sort((x,y)=>y.from-x.from);
  for(const e of edits){if(!Number.isInteger(e.from)||!Number.isInteger(e.to)||e.from<0||e.to<e.from||e.to>end||typeof e.insert!=='string'||splitsSurrogate(original,e.from)||splitsSurrogate(original,e.to))fail('INVALID_EDIT','编辑范围无效或切断UTF-16字符');if(e.expected!==undefined&&e.expected!==original.slice(e.from,e.to))fail('CONFLICT','编辑原文与读取版本不符');text=text.slice(0,e.from)+e.insert.replace(/\r\n?/g,'\n')+text.slice(e.to);end=e.from;}
  if(!isActive())fail('WORK_STOPPED','工作已停止');const parent=await documentParent(m.directory,h.rel),name=path.posix.basename(h.rel),tempName=name+'.'+randomUUID(),temp=parent.prefix+tempName,file=parent.prefix+name;
  try{const captured=await safeFile(m.directory,h.rel);if(byteDigest(captured?.bytes??null)!==h.digest)fail('STALE_VERSION','文件已变化');await fs.writeFile(temp,text,{flag:'wx',mode:captured?parseInt(captured.mode,8)&0o777:0o644});if(!isActive())fail('WORK_STOPPED','工作已停止');if(byteDigest(await safeBytes(m.directory,h.rel))!==h.digest)fail('STALE_VERSION','文件已变化');const value={relPath:h.rel,beforeDigest:h.digest,digest:byteDigest(Buffer.from(text)),eventId:callId,version:{digest:byteDigest(Buffer.from(text))}};m.documentIntent={callId,fingerprint,value,temp:path.join(m.directory,path.posix.dirname(h.rel),tempName),file:path.join(m.directory,h.rel)};await this.save(m);if(!isActive())fail('WORK_STOPPED','工作已停止');if(byteDigest(await safeBytes(m.directory,h.rel))!==h.digest)fail('STALE_VERSION','文件已变化');await fs.rename(temp,file);m.documentCalls??={};if(callId)m.documentCalls[callId]={fingerprint,value};delete m.documentIntent;await this.save(m);this.handles.delete(a.readHandle);return {ok:true,continueTurn:true,value};}finally{await fs.rm(temp,{force:true});await parent.close();}
 }catch(e){return {ok:false,continueTurn:true,error:{code:e.code||'DOCUMENT_FAILED',message:e.message}};}});}
 async finish(work,{decision,reportPersisted,isActive=()=>false,validateAcceptance}={}){return this.locked(work.id,()=>this.repositoryLocked(async()=>{
  if(!['accept','discard'].includes(decision))fail('DECISION_REQUIRED','需要用户明确选择接受或放弃');if(!reportPersisted)fail('REPORT_REQUIRED','报告必须先持久化');if(isActive())fail('WORK_ACTIVE','必须先停止Worker');
  let m=await this.readManifest(work.id);
  if(!m&&decision==='discard'&&work.revision===0&&!await fs.lstat(this.directory(work.id)).catch(e=>{if(e.code==='ENOENT')return null;throw e;})){
   const refs=await str(this.store.content,['for-each-ref','--format=%(refname)','refs/heads/nozeli/work-'+work.id+'-']).catch(()=>null);if(refs)fail('OWNERSHIP_UNKNOWN','未启动工作仍有分支，保留资源待核对');
   m={schema:2,workId:work.id,preparation:'never-started',directory:this.directory(work.id),finishIntent:{decision,status:'authorized'},receipt:{status:'discarded',cleaned:true,reason:'never-started'}};await this.save(m);return m.receipt;
  }
  if(!m||m.schema<2)fail('LEGACY_DISPOSITION','旧执行副本必须先安全迁移并发布候选；旧force不授权删除');
  if(m.receipt){if(m.receipt.status!==(decision==='accept'?'merged':'discarded'))fail('DECISION_CHANGED','已完成的用户决定不可更改');return m.receipt;}
  if(m.finishIntent&&m.finishIntent.decision!==decision)fail('DECISION_CHANGED','已保存的用户决定不可更改');
  if(decision==='accept'&&!m.cleanupStarted)await this.reconcileTarget(m);
  if(!m.cleanupStarted)await this.identity(m,{target:decision==='accept'});
  if(decision==='accept'){if(validateAcceptance)await validateAcceptance(work,m.candidate?.files||[]);if(!m.cleanupStarted){const current=await this.snapshot(m,m.directory,m.inputCommit,'Nozeli acceptance verification');if(current.tree!==m.candidate?.tree)fail('UNPUBLISHED_CHANGES','执行目录有报告后变更，必须先发布当前候选');}await this.integrate(m,work);}
  else if(!m.finishIntent){m.finishIntent={decision,status:'authorized',at:new Date().toISOString()};await this.save(m);}
  if(isActive())fail('WORK_ACTIVE','Worker仍在运行，未清理');
  m.cleanupStarted=true;await this.save(m);await this.removeOwned(m);
  m.receipt={status:decision==='accept'?'merged':'discarded',cleaned:true,...(decision==='accept'?{commit:m.finishIntent.commit,files:m.candidate.files,operations:m.finishIntent.files.map(f=>({relPath:f.rel,beforeDigest:f.before,afterDigest:f.after,workId:work.id,commit:m.finishIntent.commit}))}:{})};await this.save(m);return m.receipt;
 }));}
 async integrate(m,work){
  if(!m.candidate||m.candidate.revision!==work.revision)fail('CANDIDATE_REQUIRED','缺少当前版本的冻结候选');
  const requests=[work.request,...(work.inputs||[]).map(i=>i.text)];if((work.inputs||[]).some(i=>i.userAction==='no-commit')||/(?:不(?:要|得|许|必)?|禁止|别)\s*(?:提交|commit|做\s*git)|(?:do\s+not|don't|no)\s+(?:git\s+)?commit/i.test(requests.filter(Boolean).join('\n')))fail('USER_NO_COMMIT','此工作明确要求不提交Git；请先明确更新这一约束，再选择接受');
  let intent=m.finishIntent;
  if(!intent){
   const files=[],base=entries(await git(m.repo,['ls-tree','-r','-z',m.baseCommit])),input=entries(await git(m.repo,['ls-tree','-r','-z',m.inputCommit])),candidate=entries(await git(m.repo,['ls-tree','-r','-z',m.candidate.commit])),staged=entries(await git(m.repo,['ls-files','--stage','-z']));
   for(const rel of m.candidate.files){workPath(rel);const b=base.get(rel),i=input.get(rel),c=candidate.get(rel),s=staged.get(rel);
    const attrs=names(await git(m.repo,['check-attr','-z','filter','working-tree-encoding','text','eol','--',rel]));for(let at=2;at<attrs.length;at+=3)if(!['unspecified','unset',''].includes(attrs[at]))fail('FILTER_UNSUPPORTED','受管文件有转换属性：'+rel);
    const disk=await fs.lstat(path.join(m.repo,rel)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(b&&disk&&((disk.mode&0o111?'100755':'100644')!==b[0]))fail('USER_DIRTY','Worker文件权限有用户修改：'+rel);
    if(JSON.stringify(b)!==JSON.stringify(i))fail('INPUT_OVERLAP','Worker修改了含用户输入覆盖的文件，需用户核对：'+rel);
    if((s?.[0]??null)!==(b?.[0]??null)||(s?.[1]??null)!==(b?.[2]??null)||s&&s[2]!=='0')fail('USER_STAGED','Worker文件有用户暂存：'+rel);
    const before=b?await git(m.repo,['cat-file','blob',b[2]]):null,after=c?await git(m.repo,['cat-file','blob',c[2]]):null;
    if(byteDigest(await safeBytes(m.repo,rel))!==byteDigest(before))fail('USER_DIRTY','Worker文件有用户修改：'+rel);
    if(c&&!['100644','100755'].includes(c[0])||b&&!['100644','100755'].includes(b[0]))fail('PATH_REJECTED','受管文件不是普通Git文件：'+rel);
    files.push({rel,before:byteDigest(before),after:byteDigest(after),beforeMode:b?.[0]||null,beforeOid:b?.[2]||null,mode:c?.[0]||b?.[0],oid:c?.[2]||null});
   }
   const directory=path.join(this.store.root,'evidence','integration-'+work.id);await fs.mkdir(directory,{recursive:true});const beforeIndex=await read(m.index);await fs.writeFile(path.join(directory,'before.index'),beforeIndex);
   const index=path.join(directory,'tree.index'),env={GIT_INDEX_FILE:index};await git(m.repo,['read-tree',m.targetHead],env);
   for(const f of files)await this.indexFile(m,index,f);const tree=await str(m.repo,['write-tree'],env);if(m.acceptancePreparation&&(m.acceptancePreparation.tree!==tree||m.acceptancePreparation.parent!==m.targetHead||m.acceptancePreparation.candidate!==m.candidate.commit))fail('HOOK_BASELINE_CHANGED','原钩子执行基线变化，已保留恢复现场');m.acceptancePreparation??={directory,tree,parent:m.targetHead,candidate:m.candidate.commit,status:'hooks-requested'};await this.save(m);const commit=files.length?await acceptanceCommit(m.repo,tree,m.targetHead,'Nozeli accepted Work '+work.id,directory,m.acceptancePreparation,async attempt=>{m.acceptancePreparation=attempt;await this.save(m);}):m.targetHead;
   const afterIndex=path.join(directory,'after.index');await fs.writeFile(afterIndex,beforeIndex);for(const f of files)await this.indexFile(m,afterIndex,f);
   intent={decision:'accept',status:'prepared',directory,commit,files,beforeIndexDigest:byteDigest(beforeIndex),afterIndexDigest:byteDigest(await read(afterIndex)),token:'nozeli:'+randomUUID()};m.finishIntent=intent;await this.save(m);
  }
  if(intent.status==='integrated')return;
  await this.identity(m);const currentIndex=byteDigest(await read(m.index));if(![intent.beforeIndexDigest,intent.afterIndexDigest].includes(currentIndex))fail('INDEX_CHANGED','用户索引已变化，保留恢复意图');
  const format=await str(m.repo,['rev-parse','--show-ref-format']).catch(()=>'files');if(!['files','--show-ref-format'].includes(format))fail('REF_FORMAT','仅支持Git files引用后端');
  const refFile=path.join(m.commonDir,m.targetRef),refLock=refFile+'.lock',lock=m.index+'.lock',headLock=m.headFile+'.lock',owned=[];let published=false;
  try{
   await fs.mkdir(path.dirname(refFile),{recursive:true});for(const file of [refLock,lock,headLock]){const prior=await read(file);if(prior){const stat=await fs.lstat(file),saved=intent.locks?.[file];if(prior.toString()!==intent.token&&!(file===refLock&&prior.toString()===intent.commit+'\n'&&saved?.ino===stat.ino&&saved?.dev===stat.dev))fail('GIT_LOCKED','Git锁不属于本次整合：'+file);}else{const h=await fs.open(file,'wx',0o600);await h.writeFile(intent.token);await h.sync();const stat=await h.stat();intent.locks??={};intent.locks[file]={ino:stat.ino,dev:stat.dev};await h.close();}owned.push(file);}await this.save(m);
   await this.identity(m);if(![intent.beforeIndexDigest,intent.afterIndexDigest].includes(byteDigest(await read(m.index))))fail('INDEX_CHANGED','加锁期间用户索引变化');
   const head=await str(m.repo,['rev-parse',m.targetRef]);if(head!==m.targetHead&&head!==intent.commit)fail('HEAD_DRIFT','目标分支变化');published=head===intent.commit;
   for(const f of intent.files){const disk=await safeFile(m.repo,f.rel),digest=byteDigest(disk?.bytes??null);if(digest!==f.before&&digest!==f.after)fail('SOURCE_CHANGED','文件在恢复/整合时变化：'+f.rel);if(disk&&![f.beforeMode,f.mode].includes(disk.mode))fail('SOURCE_CHANGED','文件权限在整合时变化：'+f.rel);}
   if(!published){intent.status='applying';await this.save(m);}
   for(const f of intent.files)await this.installFile(m,f,false);
   if(byteDigest(await read(m.index))===intent.beforeIndexDigest){const temp=m.index+'.nozeli-'+randomUUID();await fs.copyFile(path.join(intent.directory,'after.index'),temp);await fs.rename(temp,m.index);}else if(byteDigest(await read(m.index))!==intent.afterIndexDigest)fail('INDEX_CHANGED','发布后索引变化；未覆盖');
   if(!published){intent.status='files-installed';await this.save(m);const h=await fs.open(refLock,'r+');await h.truncate(0);await h.writeFile(intent.commit+'\n');await h.sync();await h.close();await fs.rename(refLock,refFile);const directory=await fs.open(path.dirname(refFile),constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}published=true;}
   intent.status='ref-published';await this.save(m);intent.status='integrated';await this.save(m);
  }catch(error){
   if(!published&&await str(m.repo,['rev-parse',m.targetRef]).catch(()=>null)===intent.commit)published=true;
   if(!published&&['applying','files-installed'].includes(intent.status)){
    try{for(const f of [...intent.files].reverse())await this.installFile(m,f,true);const digest=byteDigest(await read(m.index));if(digest===intent.afterIndexDigest){const temp=m.index+'.rollback-'+randomUUID();await fs.copyFile(path.join(intent.directory,'before.index'),temp);await fs.rename(temp,m.index);}else if(digest!==intent.beforeIndexDigest)fail('INDEX_CHANGED','回滚遇到外部索引变化');intent.status='prepared';await this.save(m);}catch(rollback){intent.status='rollback-blocked';intent.error=rollback.message;await this.save(m);throw Object.assign(Error('整合失败且回滚被外部变化阻止：'+rollback.message),{code:'ROLLBACK_BLOCKED'});}
   }throw error;
  }finally{if(intent.status!=='rollback-blocked')for(const file of owned){const bytes=await read(file);if(bytes?.toString()===intent.token||file===refLock&&bytes?.toString()===intent.commit+'\n'&&(await fs.lstat(file)).ino===intent.locks?.[file]?.ino)await fs.unlink(file);}}
 }
 async installFile(m,f,rollback){
  const oid=rollback?f.beforeOid:f.oid,mode=rollback?f.beforeMode:f.mode,expected=rollback?f.after:f.before,wanted=rollback?f.before:f.after,disk=await safeFile(m.repo,f.rel),digest=byteDigest(disk?.bytes??null);
  if(digest===wanted&&(!disk||disk.mode===mode))return;if(digest!==expected&&digest!==wanted)fail('SOURCE_CHANGED','文件在替换前变化：'+f.rel);
  const target=path.join(m.repo,f.rel);if(!oid){if(disk)await fs.unlink(target);return;}
  const bytes=await git(m.repo,['cat-file','blob',oid]);await fs.mkdir(path.dirname(target),{recursive:true});const temp=target+'.nozeli-'+randomUUID();await fs.writeFile(temp,bytes,{flag:'wx',mode:parseInt(mode,8)&0o777});await fs.chmod(temp,parseInt(mode,8)&0o777);if(byteDigest(await safeBytes(m.repo,f.rel))!==digest){await fs.unlink(temp);fail('SOURCE_CHANGED','写入前文件变化：'+f.rel);}await fs.rename(temp,target);
 }
 async indexFile(m,index,f){const env={GIT_INDEX_FILE:index};if(f.oid)await git(m.repo,['update-index','--add','--cacheinfo',f.mode,f.oid,f.rel],env);else await git(m.repo,['update-index','--force-remove','--',f.rel],env);}
 async removeOwned(m){
  const exists=await fs.lstat(m.directory).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(exists){await this.identity(m,{target:false});if(m.finishIntent.decision==='accept'){const current=await this.snapshot(m,m.directory,m.inputCommit,'Nozeli cleanup verification');if(current.tree!==m.candidate.tree)fail('UNPUBLISHED_CHANGES','接受后执行目录又变化，未删除候选');}await git(m.repo,['worktree','remove','--force',m.directory]);}
  const ref=await str(m.repo,['rev-parse','--verify',m.branchRef]).catch(()=>null);if(ref){const expected=m.candidate?.commit||m.inputCommit||m.baseCommit;if(ref!==expected)fail('WORKER_REF_CHANGED','分支不再属于受管候选，未删除');await git(m.repo,['update-ref','-d',m.branchRef,expected]);}
 }
 async recoverOperations(){
  // Cold open only reconciles durable evidence; it never infers a user decision.
  for(const work of this.store.state?.works||[]){const m=await this.readManifest(work.id);if(m?.freezeIntent){await this.identity(m,{target:false,worker:false});const head=await str(m.repo,['rev-parse',m.branchRef]);if(head===m.freezeIntent.commit){m.candidate=m.freezeIntent.candidate;delete m.freezeIntent;await this.save(m);}else if(head!==m.freezeIntent.before)fail('WORKER_REF_CHANGED','冻结意图与分支不一致');}}
  return [];
 }
}
