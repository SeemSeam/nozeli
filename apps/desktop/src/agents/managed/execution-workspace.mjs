import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {atomicJson} from './workspace.mjs';
import {resolveTextReplacements} from '../../domain/document-collaboration.mjs';
import {git,str,read,repository,commitTree,fail,acceptanceCommit,gitStream,gitRecords,gitEntries,blobDigest,blobFile,blobFiles,updateIndexRows,gitEnv} from './git-service.mjs';
import {runGit} from './git-runtime.mjs';
import {inspectFile,readSafeBytes,safeRelativePath,TEXT_MAX_BYTES} from './file-stream.mjs';
import {Readable,Writable} from 'node:stream';
import {DIR_FLAGS,entry,openAt,statAt,readDirectory,renameAt,unlinkAt,retainEntryAt,writeAt,openDirectoryChain} from '../../platform/directory-fs.mjs';
import {publishFileAt,deleteFileAt} from '../../platform/file-publication.mjs';
import {assertUniqueTargets,assertManagedEntry} from '../../platform/filename-policy.mjs';
import {provisionWorktreeDependencies} from './worktree-dependencies.mjs';
export const byteDigest=bytes=>bytes===null?null:createHash('sha256').update(bytes).digest('hex');
export const workPath=safeRelativePath;
// Whole-body reads are reserved for bounded document/review text APIs.
export async function safeBytes(root,rel){const value=await readSafeBytes(root,rel);return value?.bytes??null;}
const safeFile=readSafeBytes;
const indexDigest=async file=>(await inspectFile(path.dirname(file),path.basename(file)))?.digest??null;
async function copyToHandle(file,handle){const source=await fs.open(file,'r');try{await handle.writeFile(source.createReadStream({autoClose:false}));}finally{await source.close();}}
function documentText(bytes){if(bytes===null)return '';let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('UNSUPPORTED','文档操作仅支持UTF-8文本');}if(text.includes('\0'))fail('UNSUPPORTED','文档操作不支持二进制文件');return text.replace(/\r\n?/g,'\n');}
async function documentParent(root,rel){
 workPath(rel);await assertUniqueTargets(root,[rel]);
 return openDirectoryChain(root,rel.split('/').slice(0,-1).join('/'),{create:true,validateName:assertManagedEntry});
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
  const changed=new Set(await gitRecords(m.repo,['diff','--name-only','-z',m.targetHead,head]));if(m.candidate?.files.some(rel=>changed.has(rel)))fail('TARGET_OVERLAP','其他工作修改了同一文件，请核对候选');
  m.targetHistory??=[];m.targetHistory.push({from:m.targetHead,to:head,managedWorks:chain.map(row=>row.workId)});m.targetHead=head;await this.save(m);
 }
 async identity(m,{target=true,worker=true}={}){
  if(worker){const directory=await fs.lstat(m.directory),pointer=await fs.lstat(path.join(m.directory,'.git'));if(directory.isSymbolicLink()||!directory.isDirectory()||pointer.isSymbolicLink()||!pointer.isFile()||await fs.realpath(m.directory)!==m.directory)fail('IDENTITY_CHANGED','执行目录或Git指针被替换');}
  const repo=await repository(m.repo);for(const key of ['repo','gitDir','commonDir','targetRef'])if(repo[key]!==m[key])fail('IDENTITY_CHANGED','仓库身份或目标分支变化：'+key);
  if(target&&repo.targetHead!==m.targetHead&&repo.targetHead!==m.finishIntent?.commit)fail('HEAD_DRIFT','目标HEAD已变化；请保留候选并核对');
  if(worker){if((await read(path.join(m.directory,'.git')))?.toString()!==m.gitPointer)fail('IDENTITY_CHANGED','Worker Git指针变化');
   if(await fs.realpath(await str(m.directory,['rev-parse','--absolute-git-dir']))!==m.workerGitDir||await fs.realpath(path.resolve(m.directory,await str(m.directory,['rev-parse','--git-common-dir'])))!==m.commonDir||await str(m.directory,['symbolic-ref','HEAD'])!==m.branchRef)fail('IDENTITY_CHANGED','Worker Git身份变化');
   const registered=await gitRecords(m.repo,['worktree','list','--porcelain','-z']);if(!registered.includes('worktree '+m.directory)||!registered.includes('branch '+m.branchRef))fail('IDENTITY_CHANGED','受管worktree注册变化');
   if(await str(m.repo,['rev-parse',m.branchRef])!==(m.candidate?.commit||m.inputCommit||m.baseCommit))fail('WORKER_REF_CHANGED','Worker分支被外部修改');
   if((await read(path.join(m.workerGitDir,'gitdir')))?.toString().trim()!==path.join(m.directory,'.git'))fail('IDENTITY_CHANGED','Worker反向注册变化');
  }return repo;
 }
 async blob(cwd,bytes){return (await runGit(cwd,['hash-object','-w','--no-filters','--stdin'],{env:gitEnv(),input:Readable.from([bytes])})).toString().trim();}
 async snapshot(m,root,parent,label){
  const index=path.join(this.store.root,'evidence','index-'+randomUUID()),env={GIT_INDEX_FILE:index};await fs.mkdir(path.dirname(index),{recursive:true});
  try{
   await git(m.repo,['read-tree',parent],env);
   const tracked=await gitEntries(m.repo,['ls-tree','-r','-z',parent]),selected=new Set([...tracked.keys(),...await gitRecords(root,['ls-files','-co','--exclude-standard','-z'])]),files={},batch=[],rows=[],format=await str(m.repo,['rev-parse','--show-object-format']);
   const flush=async()=>{if(!batch.length)return;const captured=await blobFiles(m.repo,root,batch,tracked,format);for(const rel of batch){const file=captured.get(rel);if(file){files[rel]=file;const old=tracked.get(rel);if(old?.[0]===file.mode&&old?.[2]===file.oid)continue;rows.push({rel,...file});}else if(tracked.has(rel))rows.push({rel,oid:null});}batch.length=0;};
   for(const rel of [...selected].sort()){try{workPath(rel);}catch(error){if(tracked.has(rel))throw error;continue;}batch.push(rel);if(batch.length===16)await flush();}await flush();await updateIndexRows(m.repo,index,rows);
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
  if(existingHead){if(prior?.status==='ready'&&prior.commit===existingHead&&prior.created){const targetIndex=path.resolve(root,await str(root,['rev-parse','--git-path','index'])),saved=path.join(evidence,'initial.index');if(!await fs.stat(saved).catch(()=>null))fail('INIT_RECOVERY','初始索引恢复材料缺失');if(!await fs.stat(targetIndex).catch(()=>null)){const h=await fs.open(targetIndex+'.lock','wx',0o600);try{if(await fs.stat(targetIndex).catch(()=>null))fail('INDEX_CHANGED','恢复期间索引变化');await copyToHandle(saved,h);await h.sync();await h.close();await fs.rename(targetIndex+'.lock',targetIndex);}catch(error){await h.close().catch(()=>{});await fs.rm(targetIndex+'.lock',{force:true});throw error;}}await atomicJson(intentFile,{...prior,status:'complete'});}return;}
  const ref=await str(root,['symbolic-ref','HEAD']),index=path.join(evidence,'initial.index'),env={GIT_INDEX_FILE:index};
  const created=!top||prior?.created===true;await atomicJson(intentFile,{repo:root,ref,created,status:'baseline-requested'});await git(root,['read-tree','--empty'],env);
  const batch=[],rows=[],format=await str(root,['rev-parse','--show-object-format']);const flush=async()=>{if(!batch.length)return;const captured=await blobFiles(root,root,batch,new Map(),format);for(const [rel,file] of captured)if(file)rows.push({rel,...file});batch.length=0;};
  for(const rel of await gitRecords(root,['ls-files','-co','--exclude-standard','-z'])){try{workPath(rel);}catch{continue;}batch.push(rel);if(batch.length===16)await flush();}await flush();await updateIndexRows(root,index,rows);
  const tree=await str(root,['write-tree'],env),commit=await commitTree(root,tree,[],'Nozeli project baseline',evidence);await atomicJson(intentFile,{repo:root,ref,commit,created,status:'ready'});
  await git(root,['update-ref',ref,commit,'0'.repeat(commit.length)]);
  if(created){const targetIndex=path.resolve(root,await str(root,['rev-parse','--git-path','index'])),lock=targetIndex+'.lock';const h=await fs.open(lock,'wx',0o600);try{if(await fs.stat(targetIndex).catch(()=>null))fail('INDEX_CHANGED','初始化期间索引出现，未覆盖');await copyToHandle(index,h);await h.sync();await h.close();await fs.rename(lock,targetIndex);}catch(error){await h.close().catch(()=>{});await fs.rm(lock,{force:true});throw error;}}
  await atomicJson(intentFile,{repo:root,ref,commit,status:'complete'});await fs.rm(index,{force:true});
 }
 async prepareInner(id){
  await this.store.storage.requireOnline(this.store.projectId);
  let m=await this.readManifest(id);
 if(m?.schema>=2&&m.preparation==='complete'){await this.reconcilePublication(m);await this.reconcileFreeze(m);await this.identity(m,{target:false});await this.reconcileDocument(m);await this.provisionDependencies(m);await this.save(m);return m;}
  if(!m||m.schema<2){
   await this.initializeRepository();const legacy=m,dir=this.directory(id),repo=await repository(this.store.content),branchRef='refs/heads/nozeli/work-'+id+'-'+randomUUID();
   const exists=await fs.lstat(dir).catch(()=>null);if(exists&&!legacy)fail('BASELINE_MISSING','执行目录已有内容但缺少基线，已保留');
   m={schema:2,workId:id,...repo,directory:dir,branchRef,baseCommit:repo.targetHead,preparation:'requested',legacy:legacy?{manifest:legacy,directory:dir+'.legacy-'+randomUUID()}:undefined};await this.save(m);
  }
  if(m.preparation==='requested'){
   await this.identity(m,{worker:false});
   if(m.legacy&&!await fs.lstat(m.legacy.directory).catch(()=>null))await fs.rename(m.directory,m.legacy.directory);
   if(!await read(path.join(m.directory,'.git'))){await fs.mkdir(path.dirname(m.directory),{recursive:true});await assertUniqueTargets(path.dirname(m.directory),[...(await gitEntries(m.repo,['ls-tree','-r','-z',m.baseCommit])).keys()],{checkExisting:false});await fs.mkdir(path.dirname(m.directory),{recursive:true});const exists=await str(m.repo,['rev-parse','--verify',m.branchRef]).catch(()=>null);if(exists&&exists!==m.baseCommit)fail('WORKER_REF_CHANGED','准备中的分支已变化');await git(m.repo,['worktree','add',...(exists?[]:['-b',m.branchRef.slice(11)]),m.directory,exists?m.branchRef:m.baseCommit]);}
   m.gitPointer=(await fs.readFile(path.join(m.directory,'.git'))).toString();m.workerGitDir=await fs.realpath(await str(m.directory,['rev-parse','--absolute-git-dir']));m.preparation='registered';await this.save(m);
  }
  if(m.preparation==='registered'){
   await this.identity(m);const input=await this.snapshot(m,m.repo,m.baseCommit,'Nozeli input baseline');m.inputCommit=input.commit;m.inputTree=input.tree;m.files=input.files;m.inputProvenance={kind:'disk',head:m.baseCommit,at:new Date().toISOString(),indexDigest:await indexDigest(m.index)};m.preparation='input-frozen';await this.save(m);
  }
  if(m.preparation==='input-frozen'){
   if((await read(path.join(m.directory,'.git')))?.toString()!==m.gitPointer)fail('IDENTITY_CHANGED','执行目录Git指针变化');
   const head=await str(m.repo,['rev-parse',m.branchRef]);if(![m.baseCommit,m.inputCommit].includes(head))fail('WORKER_REF_CHANGED','准备中的分支变化');
   await assertUniqueTargets(m.directory,[...(await gitEntries(m.repo,['ls-tree','-r','-z',m.inputCommit])).keys()]);
   await git(m.directory,['reset','--hard',m.inputCommit]);m.preparation='input-installed';await this.save(m);
  }
  await this.provisionDependencies(m);
  if(m.preparation==='input-installed'&&m.legacy){
   const source=m.legacy.directory,selected=new Set(Object.keys(m.legacy.manifest.files||{}));
   const visit=async(dir,rel='')=>{for(const row of await fs.readdir(dir,{withFileTypes:true})){const name=rel?rel+'/'+row.name:row.name;workPath(name);if(row.isDirectory())await visit(path.join(dir,row.name),name);else{if(!row.isFile()||row.isSymbolicLink())fail('LEGACY_UNSAFE','旧候选含特殊文件，已保留：'+name);selected.add(name);}}};await visit(source);
   for(const rel of selected){workPath(rel);const file=await blobFile(m.repo,source,rel),before=await inspectFile(m.directory,rel);await this.installFile({...m,repo:m.directory},{rel,before:before?.digest??null,after:file?.digest??null,mode:file?.mode??null,oid:file?.oid??null},false);}m.legacy.importedPaths=[...selected];
  }
  m.preparation='complete';await this.save(m);return m;
 }
 // Worker依赖供给：被忽略的node_modules不随worktree迁移。源项目模块与冻结
 // 输入的package.json/package-lock.json字节一致时，向执行目录独立拷贝一份
 // （固定源目录后流式复制，不链接到可写源端）；已有模块一律保留。缺失/不匹配
 // 把可读原因记入manifest.dependencies，绝不伪造依赖可用。
 async provisionDependencies(m){
  if(!m||!m.files)return null;
  const report=await provisionWorktreeDependencies({workId:m.workId,sourceRoot:m.repo,worktreeRoot:m.directory,frozenFiles:m.files,previous:m.dependencies??null});
  if(report!==m.dependencies){m.dependencies=report;await this.save(m);}
  return report;
 }
 async reconcileFreeze(m){if(!m.freezeIntent)return;const head=await str(m.repo,['rev-parse',m.branchRef]);if(head===m.freezeIntent.commit){m.candidate=m.freezeIntent.candidate;delete m.freezeIntent;await this.save(m);}else if(head===m.freezeIntent.before){await git(m.repo,['update-ref',m.branchRef,m.freezeIntent.commit,head]);m.candidate=m.freezeIntent.candidate;delete m.freezeIntent;await this.save(m);}else fail('WORKER_REF_CHANGED','冻结意图与分支不一致');}
 async reconcileDocument(m){
  const intent=m.documentIntent;if(!intent)return;workPath(intent.value.relPath);const digest=byteDigest(await safeBytes(m.directory,intent.value.relPath));
  const cleanup=async expected=>{
   const rel=path.relative(m.directory,intent.temp).split(path.sep).join('/');workPath(rel);
   if(path.posix.dirname(rel)!==path.posix.dirname(intent.value.relPath))fail('DOCUMENT_RECOVERY','编辑临时文件路径不属于原目录');
   const temporary=await inspectFile(m.directory,rel);
   if(!temporary)return;
   if(temporary.digest!==expected)fail('DOCUMENT_RECOVERY','发布中断，临时文件含未核验内容；原件、编辑与恢复意图已保留');
   const parent=await documentParent(m.directory,rel);try{await parent.verify();await deleteFileAt(entry(parent.directory.fd,path.posix.basename(rel)),{expectedDigest:expected,expectedMode:temporary.mode});}finally{await parent.close();}
  };
  if(digest===intent.value.digest){await cleanup(intent.value.beforeDigest);m.documentCalls??={};if(intent.callId)m.documentCalls[intent.callId]={fingerprint:intent.fingerprint,value:intent.value};delete m.documentIntent;await this.save(m);}
  else if(digest===intent.value.beforeDigest){await cleanup(intent.value.digest);delete m.documentIntent;await this.save(m);}
  else fail('DOCUMENT_RECOVERY','执行文件与持久化编辑意图不一致，已保留现场');
 }
 async publicationCommitted(intent){
  const row=await this.store.storage.getProject(this.store.projectId,'managed_receipts',intent.receiptId);if(!row)return false;
  if(row.workId!==intent.workId||row.revision!==intent.candidate.revision||row.snapshot?.candidate?.commit!==intent.candidate.commit)fail('PUBLICATION_RECOVERY_HELD','报告提交身份冲突');return true;
 }
 async restorePublication(m,intent,committed){
  const head=await str(m.repo,['rev-parse',m.branchRef]),desired=committed?intent.candidate.commit:intent.before;
  if(head!==desired){const expected=committed?intent.before:intent.candidate.commit;if(head!==expected)fail('PUBLICATION_RECOVERY_HELD','候选分支已变化；保留报告提交意图');await git(m.repo,['update-ref',m.branchRef,desired,expected]);}
  if(committed)m.candidate=intent.candidate;else if(intent.previousCandidate)m.candidate=intent.previousCandidate;else delete m.candidate;
  delete m.publicationIntent;try{await this.save(m);}catch(error){m.publicationIntent=intent;throw error;}
 }
 async reconcilePublication(m){if(!m.publicationIntent)return;const intent=m.publicationIntent;await this.identity(m,{target:false,worker:false});await this.restorePublication(m,intent,await this.publicationCommitted(intent));}
 async publish(work,job,isActive=()=>true,retainCandidate=null,{receiptId}={}){return this.locked(work.id,async()=>{
  const m=await this.prepareInner(work.id);await this.identity(m,{target:false});if(!isActive())fail('WORK_STOPPED','工作已停止');
  const candidate=await this.snapshot(m,m.directory,m.inputCommit,'Nozeli Worker checkpoint '+work.id);candidate.revision=work.revision;candidate.jobId=job?.id;
  candidate.fileDigests=Object.fromEntries(Object.entries(candidate.files).map(([rel,file])=>[rel,file.digest]));
  candidate.files=await gitRecords(m.repo,['diff-tree','--no-commit-id','--name-only','-r','-z',m.inputCommit,candidate.commit]);
  if(receiptId){
   const intent={receiptId,workId:work.id,before:m.candidate?.commit||m.inputCommit,previousCandidate:structuredClone(m.candidate||null),candidate};m.publicationIntent=intent;await this.save(m);
   try{await git(m.repo,['update-ref',m.branchRef,candidate.commit,intent.before]);m.candidate=candidate;await this.save(m);if(!isActive())fail('WORK_STOPPED','工作已停止');const retained=retainCandidate?await retainCandidate(m,candidate):null;await this.restorePublication(m,intent,true);return {applied:[],conflicts:[],candidate,...(retained?{changeSet:retained}:{})};}
   catch(error){let committed;try{committed=await this.publicationCommitted(intent);if(!committed)await this.restorePublication(m,intent,false);}catch(recoveryError){throw Object.assign(new AggregateError([error,recoveryError],'报告提交无法确认；保留候选和恢复意图'),{code:'PUBLICATION_RECOVERY_HELD'});}if(committed)throw Object.assign(new Error('报告已持久化但候选提交收尾失败；保留恢复意图',{cause:error}),{code:'PUBLICATION_COMMIT_UNKNOWN'});throw error;}
  }
  m.freezeIntent={commit:candidate.commit,before:m.candidate?.commit||m.inputCommit,candidate};await this.save(m);
  await git(m.repo,['update-ref',m.branchRef,candidate.commit,m.freezeIntent.before]);m.candidate=candidate;delete m.freezeIntent;await this.save(m);const retained=retainCandidate?await retainCandidate(m,candidate):null;return {applied:[],conflicts:[],candidate,...(retained?{changeSet:retained}:{})};
 });}
 // ── 人工审校（managed.review）：不可变版本读取 + 受控worktree写入 ──────────
 // 基线=候选的父提交（即Worker输入基线inputCommit）；候选=冻结发布提交。
 // 读取只走Git对象，正文与发布快照摘要一致，永不把live磁盘当作版本。
 async reviewSnapshot(m,receipt){
  if(!m?.repo)fail('CANDIDATE_REQUIRED','缺少冻结候选，无法审校');
  // 历史读取以回执冻结的候选提交为准：不随当前候选/后续发布漂移，worktree
  // 清理后对象仍在主仓库，读取身份稳定。
  const candidateCommit=receipt?.snapshot?.candidate?.commit||m.candidate?.commit;
  if(!candidateCommit)fail('CANDIDATE_REQUIRED','缺少冻结候选，无法审校');
  const baselineCommit=await str(m.repo,['rev-parse','--verify',candidateCommit+'^']);
  const treeOf=async commit=>gitEntries(m.repo,['ls-tree','-r','-l','-z',commit]);
  const [base,cand]=await Promise.all([treeOf(baselineCommit),treeOf(candidateCommit)]);
  const changed=await gitRecords(m.repo,['diff-tree','--no-commit-id','--name-only','-r','-z',baselineCommit,candidateCommit]);
  const rels=[...new Set([...changed,...(receipt?.snapshot?.files||[]).map(f=>f.relPath)])].filter(rel=>base.has(rel)||cand.has(rel)).sort();
  const digestBlob=async row=>row?blobDigest(m.repo,row[2]):null;
  const out=[];
  for(const rel of rels){
   const b=base.get(rel),c=cand.get(rel);
   out.push({relPath:rel,baselineDigest:await digestBlob(b),candidateDigest:await digestBlob(c),baselineMode:b?b[0]:null,candidateMode:c?c[0]:null,baselineSize:b?Number(b[3]):null,candidateSize:c?Number(c[3]):null});
  }
  return {baselineCommit,candidateCommit,targetRef:m.targetRef??null,files:out};
 }
 async reviewBlob(m,commit,relPath){
  workPath(relPath);const row=(await gitEntries(m.repo,['ls-tree','-r','-l','-z',commit,'--',relPath])).get(relPath);
  if(!row||Number(row[3])>2*1024*1024)return null;
  return runGit(m.repo,['cat-file','blob',row[2]],{env:gitEnv(),maxBuffer:2*1024*1024});
 }
 // 受控应用人工草稿：先验证整个计划（任一文件drift即整体拒绝，零写入），
 // 再逐文件写入——documentParent逐级O_NOFOLLOW固定父目录（父目录不可被换
 // 成symlink逃逸），原子temp+sync+rename+复核，残留temp始终清理。
 async applyReviewedFiles(m,plan){
  if(!plan||!plan.length)return;
  try{await assertUniqueTargets(m.directory,plan.map(item=>item.relPath));}catch(error){if(['ELOOP','ENOTDIR','SOURCE_CHANGED'].includes(error.code))fail('WORKTREE_DRIFT','执行目录不可安全访问；人工草稿已保留');throw error;}
  const steps=[];
  for(const item of plan){
   workPath(item.relPath);
   let captured;
   try{captured=await inspectFile(m.directory,item.relPath);}
   catch(error){fail('WORKTREE_DRIFT','执行文件不可安全读取：'+item.relPath);}
   const current=captured?.digest??null;
   if(current!==item.toDigest&&current!==item.fromDigest)fail('WORKTREE_DRIFT','执行目录与冻结候选不一致，未写入人工审校：'+item.relPath);
   steps.push({item,captured,current});
  }
  for(const {item,captured,current} of steps){
   if(current===item.toDigest)continue;   // 幂等重放
   const parent=await documentParent(m.directory,item.relPath);
   const temp=entry(parent.directory.fd,path.posix.basename(item.relPath)+'.nozeli-review-'+randomUUID());
   let retainTemp=false;
   try{
    const handle=await openAt(temp,'wx',captured?parseInt(captured.mode,8)&0o777:0o644);
    try{await handle.writeFile(item.bytes);await handle.sync();}finally{await handle.close();}
    if((await inspectFile(m.directory,item.relPath))?.digest!==captured?.digest)fail('WORKTREE_DRIFT','写入期间执行文件变化：'+item.relPath);
    await parent.verify();await publishFileAt(temp,entry(parent.directory.fd,path.posix.basename(item.relPath)),{expectedDigest:captured?.digest,expectedMode:captured?.mode});
    if((await inspectFile(m.directory,item.relPath))?.digest!==item.toDigest)fail('WORKTREE_DRIFT','人工审校写入校验失败：'+item.relPath);
   }catch(error){retainTemp=error.retainTemp===true;throw error;}finally{if(!retainTemp)await retainEntryAt(temp);await parent.close();}
  }
 }
 async refresh(){fail('INPUT_FROZEN','输入基线已冻结；继续工作会保留原工作目录，不自动覆盖Worker文件');}
 async documentOperation({work,op,arguments:a,callId,isActive=()=>true}){return this.locked(work.id,async()=>{try{
  const m=await this.prepareInner(work.id);await this.identity(m,{target:false});
  const fingerprint=byteDigest(Buffer.from(JSON.stringify({threadId:work.threadId,op,arguments:a}))),prior=m.documentCalls?.[callId];if(op!=='read'&&prior){if(prior.fingerprint!==fingerprint)fail('CONFLICT','调用标识已用于不同编辑');return {ok:true,continueTurn:true,value:{...prior.value,duplicate:true}};}
  if(op==='read'){const rel=workPath(a.relPath),bytes=await safeBytes(m.directory,rel),text=documentText(bytes),digest=byteDigest(bytes),handle=randomUUID();this.handles.set(handle,{workId:work.id,threadId:work.threadId,rel,digest});return {ok:true,readOnly:true,continueTurn:true,value:{relPath:rel,text,digest,version:{digest},readHandle:handle}};}
  const h=this.handles.get(a.readHandle);if(!h||h.workId!==work.id||h.threadId!==work.threadId)fail('READ_HANDLE_REJECTED','需要当前Worker的读取凭据');
  const before=await safeBytes(m.directory,h.rel);if(byteDigest(before)!==h.digest)fail('STALE_VERSION','执行文件已变化，请重新读取');
  // Same model contract as the frontdesk: quote exact text, host resolves offsets.
  const original=documentText(before),{edits}=resolveTextReplacements(original,a.replacements);
  const ordered=edits.sort((x,y)=>y.from-x.from);
  let text=original;for(const e of ordered){if(Buffer.byteLength(text)-Buffer.byteLength(text.slice(e.from,e.to))+Buffer.byteLength(e.insert)>TEXT_MAX_BYTES)fail('TEXT_LIMIT','文档编辑超过32MiB文本边界');text=text.slice(0,e.from)+e.insert+text.slice(e.to);}
  if(!isActive())fail('WORK_STOPPED','工作已停止');const parent=await documentParent(m.directory,h.rel),name=path.posix.basename(h.rel),tempName=name+'.'+randomUUID(),temp=entry(parent.directory.fd,tempName),file=entry(parent.directory.fd,name);
  let retainTemp=false;
  try{const captured=await safeFile(m.directory,h.rel);if(byteDigest(captured?.bytes??null)!==h.digest)fail('STALE_VERSION','文件已变化');await writeAt(temp,text,{mode:captured?parseInt(captured.mode,8)&0o777:0o644});if(!isActive())fail('WORK_STOPPED','工作已停止');if(byteDigest(await safeBytes(m.directory,h.rel))!==h.digest)fail('STALE_VERSION','文件已变化');const value={relPath:h.rel,beforeDigest:h.digest,digest:byteDigest(Buffer.from(text)),eventId:callId,version:{digest:byteDigest(Buffer.from(text))}};m.documentIntent={callId,fingerprint,value,temp:path.join(m.directory,path.posix.dirname(h.rel),tempName),file:path.join(m.directory,h.rel)};await this.save(m);if(!isActive())fail('WORK_STOPPED','工作已停止');if(byteDigest(await safeBytes(m.directory,h.rel))!==h.digest)fail('STALE_VERSION','文件已变化');await parent.verify();await publishFileAt(temp,file,{expectedDigest:h.digest,expectedMode:captured?.mode});m.documentCalls??={};if(callId)m.documentCalls[callId]={fingerprint,value};delete m.documentIntent;await this.save(m);this.handles.delete(a.readHandle);return {ok:true,continueTurn:true,value};}catch(error){retainTemp=error.retainTemp===true;throw error;}finally{if(!retainTemp)await retainEntryAt(temp);await parent.close();}
 }catch(e){return {ok:false,continueTurn:true,error:{code:e.code||'DOCUMENT_FAILED',message:e.message}};}});}
 async finish(work,{decision,reportPersisted,isActive=()=>false,validateAcceptance,reviewed=null,mergeAuthorization=null}={}){return this.locked(work.id,()=>this.repositoryLocked(async()=>{
  await this.store.storage.requireOnline(this.store.projectId);
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
  if(decision==='accept'){if(validateAcceptance)await validateAcceptance(work,[...new Set([...(m.candidate?.files||[]),...(reviewed?.files||[]).map(f=>f.relPath)])]);if(!m.cleanupStarted){const current=await this.snapshot(m,m.directory,m.inputCommit,'Nozeli acceptance verification');if(current.tree!==m.candidate?.tree)fail('UNPUBLISHED_CHANGES','执行目录有报告后变更，必须先发布当前候选');}await this.integrate(m,work,reviewed,mergeAuthorization);}
  else if(!m.finishIntent){m.finishIntent={decision:'discard',status:'authorized',at:new Date().toISOString()};await this.save(m);}
  if(isActive())fail('WORK_ACTIVE','Worker仍在运行，未清理');
  m.cleanupStarted=true;await this.save(m);await this.removeOwned(m);
  m.receipt={status:decision==='accept'?'merged':'discarded',cleaned:true,...(decision==='accept'?{commit:m.finishIntent.commit,files:m.finishIntent.files.map(f=>f.rel),operations:m.finishIntent.files.map(f=>({relPath:f.rel,beforeDigest:f.before,afterDigest:f.after,workId:work.id,commit:m.finishIntent.commit}))}:{})};await this.save(m);return m.receipt;
 }));}
 async integrate(m,work,reviewed=null,mergeAuthorization=null){
  if(!m.candidate||m.candidate.revision!==work.revision)fail('CANDIDATE_REQUIRED','缺少当前版本的冻结候选');
  // 结构化合入授权门（取代旧的原始文本永久veto）：接受路径强制要求与决定
  // 同事务落账的完整类型化授权——精确候选/审校版本令牌/objectId/仓库/
  // commonDir/目标ref/targetHead，缺字段或null不允许跳过（无授权不合入）；
  // never-commit覆盖未批准时零写入阻断；身份不匹配（含篡改）拒绝。
  if(!mergeAuthorization||typeof mergeAuthorization!=='object'||Array.isArray(mergeAuthorization))fail('MERGE_AUTHORIZATION_REQUIRED','缺少与接受决定同事务落账的合入授权；不合入，资源保留');
  if(mergeAuthorization.consentRequired&&mergeAuthorization.consent?.status!=='approved')fail('MERGE_CONSENT_REQUIRED','此工作带有明确的“不提交Git”约束；本地合入需在专门待办中一次性批准（绑定当前候选），原请求未改写');
  {
   const exact={workId:work.id,revision:work.revision,objectId:work.result?.objectId??null,candidateCommit:m.candidate.commit,reviewVersion:reviewed?.version??null,repo:m.repo,commonDir:m.commonDir,targetRef:m.targetRef};
   for(const [key,value] of Object.entries(exact)){
    const bound=mergeAuthorization[key];
    if(key==='reviewVersion'){if(bound!==value)fail('MERGE_AUTHORIZATION_STALE','合入授权审校版本令牌与当前人工版本集不一致；未合入，保留现场待核对');continue;}
    if(key==='revision'){if(!Number.isSafeInteger(bound)||bound!==value)fail('MERGE_AUTHORIZATION_STALE','合入授权与当前候选不一致（revision无效）；未合入，保留现场待核对');continue;}
    if(typeof bound!=='string'||!bound||bound!==value)fail('MERGE_AUTHORIZATION_STALE','合入授权与当前候选不一致（'+key+(bound==null?'缺失':typeof bound!=='string'?'类型错误':'不匹配')+'）；未合入，保留现场待核对');
   }
   // targetHead：接受时绑定。之后目标分支的受管推进（reconcileTarget已验证的
   // 其他工作整合链，receipt chain）是唯一允许的合法漂移——沿m.targetHistory
   // 从授权head逐步可证推进到当前head才放行；任何不可证漂移拒绝。
   if(mergeAuthorization.targetHead!==m.targetHead){
    let cursor=mergeAuthorization.targetHead,guard=0;
    if(typeof cursor==='string'&&cursor){
     let advanced=true;
     while(cursor!==m.targetHead&&advanced&&guard++<=((m.targetHistory||[]).length)){
      advanced=false;
      for(const step of m.targetHistory||[])if(step.from===cursor){cursor=step.to;advanced=true;break;}
     }
    }
    if(cursor!==m.targetHead)fail('MERGE_AUTHORIZATION_STALE','合入授权targetHead与当前目标不符且无受管推进链可证；未合入，保留现场待核对');
   }
   m.mergeAuthorization??=structuredClone(mergeAuthorization);await this.save(m);
  }
  let intent=m.finishIntent;
  if(!intent){
   // 人工审校文件并入整合集合：未被Worker修改的候选文件也可被人工修订并合入。
   const reviewedFiles=reviewed&&Array.isArray(reviewed.files)?new Map(reviewed.files.map(f=>[f.relPath,f])):null;
   const files=[],base=await gitEntries(m.repo,['ls-tree','-r','-z',m.baseCommit]),input=await gitEntries(m.repo,['ls-tree','-r','-z',m.inputCommit]),candidate=await gitEntries(m.repo,['ls-tree','-r','-z',m.candidate.commit]),staged=await gitEntries(m.repo,['ls-files','--stage','-z']);
   for(const rel of [...new Set([...m.candidate.files,...(reviewedFiles?[...reviewedFiles.keys()]:[])])]){workPath(rel);const b=base.get(rel),i=input.get(rel),c=candidate.get(rel),s=staged.get(rel);
    const attrs=names(await git(m.repo,['check-attr','-z','filter','working-tree-encoding','text','eol','--',rel]));for(let at=2;at<attrs.length;at+=3)if(!['unspecified','unset',''].includes(attrs[at]))fail('FILTER_UNSUPPORTED','受管文件有转换属性：'+rel);
    const disk=await fs.lstat(path.join(m.repo,rel)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(b&&disk&&((disk.mode&0o111?'100755':'100644')!==b[0]))fail('USER_DIRTY','Worker文件权限有用户修改：'+rel);
    const reconciliation=reviewed?.reconciliation?.find(row=>row.relPath===rel);
    const approvedReconciliation=reconciliation&&reconciliation.candidateCommit===m.candidate.commit&&reconciliation.inputCommit===m.inputCommit&&reconciliation.targetHead===m.targetHead&&reviewedFiles?.has(rel);
    if(JSON.stringify(b)!==JSON.stringify(i)&&!approvedReconciliation)fail('INPUT_OVERLAP','Worker修改了含用户输入覆盖的文件，需用户核对：'+rel);
    if((s?.[0]??null)!==(b?.[0]??null)||(s?.[1]??null)!==(b?.[2]??null)||s&&s[2]!=='0')fail('USER_STAGED','Worker文件有用户暂存：'+rel);
    const captured=await inspectFile(m.repo,rel),before=approvedReconciliation?(captured?.digest??null):await blobDigest(m.repo,b?.[2]),after=await blobDigest(m.repo,c?.[2]);
    if(approvedReconciliation&&before!==reconciliation.targetDigest)fail('USER_DIRTY','用户核对后的目标正文再次变化：'+rel);
    if((captured?.digest??null)!==before)fail('USER_DIRTY','Worker文件有用户修改：'+rel);
    if(c&&!['100644','100755'].includes(c[0])||b&&!['100644','100755'].includes(b[0]))fail('PATH_REJECTED','受管文件不是普通Git文件：'+rel);
    const reviewedEntry=reviewedFiles?.get(rel)||null;
    const reconciledBlob=approvedReconciliation?await blobFile(m.repo,m.repo,rel):null;if(approvedReconciliation&&(reconciledBlob?.digest??null)!==before)fail('USER_DIRTY','用户核对后的目标正文再次变化：'+rel);
    files.push({rel,before,after:reviewedEntry?reviewedEntry.digest:after,beforeMode:b?.[0]||null,beforeOid:approvedReconciliation?(reconciledBlob?.oid??null):(b?.[2]||null),mode:reviewedEntry?(reviewedEntry.mode??(c?.[0]||b?.[0])):(c?.[0]||b?.[0]),oid:reviewedEntry?reviewedEntry.oid:c?.[2]||null});
   }
   const directory=path.join(this.store.root,'evidence','integration-'+work.id);await fs.mkdir(directory,{recursive:true});const beforeIndex=path.join(directory,'before.index');await fs.copyFile(m.index,beforeIndex);
   const index=path.join(directory,'tree.index'),env={GIT_INDEX_FILE:index};await git(m.repo,['read-tree',m.targetHead],env);
   await updateIndexRows(m.repo,index,files);const tree=await str(m.repo,['write-tree'],env);if(m.acceptancePreparation&&(m.acceptancePreparation.tree!==tree||m.acceptancePreparation.parent!==m.targetHead||m.acceptancePreparation.candidate!==m.candidate.commit))fail('HOOK_BASELINE_CHANGED','原钩子执行基线变化，已保留恢复现场');m.acceptancePreparation??={directory,tree,parent:m.targetHead,candidate:m.candidate.commit,status:'hooks-requested'};await this.save(m);const commit=files.length?await acceptanceCommit(m.repo,tree,m.targetHead,'Nozeli accepted Work '+work.id,directory,m.acceptancePreparation,async attempt=>{m.acceptancePreparation=attempt;await this.save(m);}):m.targetHead;
   const afterIndex=path.join(directory,'after.index');await fs.copyFile(beforeIndex,afterIndex);await updateIndexRows(m.repo,afterIndex,files);
   intent={decision:'accept',status:'prepared',directory,commit,files,beforeIndexDigest:await indexDigest(beforeIndex),afterIndexDigest:await indexDigest(afterIndex),token:'nozeli:'+randomUUID()};m.finishIntent=intent;await this.save(m);
  }
  if(intent.status==='integrated')return;
  await assertUniqueTargets(m.repo,intent.files.map(f=>f.rel));
  await this.identity(m);const currentIndex=await indexDigest(m.index);if(![intent.beforeIndexDigest,intent.afterIndexDigest].includes(currentIndex))fail('INDEX_CHANGED','用户索引已变化，保留恢复意图');
  const format=await str(m.repo,['rev-parse','--show-ref-format']).catch(()=>'files');if(!['files','--show-ref-format'].includes(format))fail('REF_FORMAT','仅支持Git files引用后端');
  const refFile=path.join(m.commonDir,m.targetRef),refLock=refFile+'.lock',lock=m.index+'.lock',headLock=m.headFile+'.lock',owned=[];let published=false;
  try{
   await fs.mkdir(path.dirname(refFile),{recursive:true});for(const file of [refLock,lock,headLock]){const prior=await read(file);if(prior){const stat=await fs.lstat(file),saved=intent.locks?.[file];if(prior.toString()!==intent.token&&!(file===refLock&&prior.toString()===intent.commit+'\n'&&saved?.ino===stat.ino&&saved?.dev===stat.dev))fail('GIT_LOCKED','Git锁不属于本次整合：'+file);}else{const h=await fs.open(file,'wx',0o600);await h.writeFile(intent.token);await h.sync();const stat=await h.stat();intent.locks??={};intent.locks[file]={ino:stat.ino,dev:stat.dev};await h.close();}owned.push(file);}await this.save(m);
   await this.identity(m);if(![intent.beforeIndexDigest,intent.afterIndexDigest].includes(await indexDigest(m.index)))fail('INDEX_CHANGED','加锁期间用户索引变化');
   const head=await str(m.repo,['rev-parse',m.targetRef]);if(head!==m.targetHead&&head!==intent.commit)fail('HEAD_DRIFT','目标分支变化');published=head===intent.commit;
   for(const f of intent.files){const disk=await inspectFile(m.repo,f.rel),digest=disk?.digest??null;if(digest!==f.before&&digest!==f.after)fail('SOURCE_CHANGED','文件在恢复/整合时变化：'+f.rel);if(disk&&![f.beforeMode,f.mode].includes(disk.mode))fail('SOURCE_CHANGED','文件权限在整合时变化：'+f.rel);}
   if(!published){intent.status='applying';await this.save(m);}
   for(const f of intent.files)await this.installFile(m,f,false);
   if(await indexDigest(m.index)===intent.beforeIndexDigest){const temp=m.index+'.nozeli-'+randomUUID();await fs.copyFile(path.join(intent.directory,'after.index'),temp);await fs.rename(temp,m.index);}else if(await indexDigest(m.index)!==intent.afterIndexDigest)fail('INDEX_CHANGED','发布后索引变化；未覆盖');
   if(!published){intent.status='files-installed';await this.save(m);const h=await fs.open(refLock,'r+');await h.truncate(0);await h.writeFile(intent.commit+'\n');await h.sync();await h.close();await fs.rename(refLock,refFile);const directory=await fs.open(path.dirname(refFile),constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}published=true;}
   intent.status='ref-published';await this.save(m);intent.status='integrated';await this.save(m);
  }catch(error){
   if(!published&&await str(m.repo,['rev-parse',m.targetRef]).catch(()=>null)===intent.commit)published=true;
   if(!published&&['applying','files-installed'].includes(intent.status)){
    try{for(const f of [...intent.files].reverse())await this.installFile(m,f,true);const digest=await indexDigest(m.index);if(digest===intent.afterIndexDigest){const temp=m.index+'.rollback-'+randomUUID();await fs.copyFile(path.join(intent.directory,'before.index'),temp);await fs.rename(temp,m.index);}else if(digest!==intent.beforeIndexDigest)fail('INDEX_CHANGED','回滚遇到外部索引变化');intent.status='prepared';await this.save(m);}catch(rollback){intent.status='rollback-blocked';intent.error=rollback.message;await this.save(m);throw Object.assign(Error('整合失败且回滚被外部变化阻止：'+rollback.message),{code:'ROLLBACK_BLOCKED'});}
   }throw error;
  }finally{if(intent.status!=='rollback-blocked')for(const file of owned){const bytes=await read(file);if(bytes?.toString()===intent.token||file===refLock&&bytes?.toString()===intent.commit+'\n'&&(await fs.lstat(file)).ino===intent.locks?.[file]?.ino)await fs.unlink(file);}}
 }
 async installFile(m,f,rollback){
  const oid=rollback?f.beforeOid:f.oid,mode=rollback?f.beforeMode:f.mode,expected=rollback?f.after:f.before,wanted=rollback?f.before:f.after,disk=await inspectFile(m.repo,f.rel),digest=disk?.digest??null;
  if(digest===wanted&&(!disk||disk.mode===mode))return;if(digest!==expected&&digest!==wanted)fail('SOURCE_CHANGED','文件在替换前变化：'+f.rel);
  const parent=await documentParent(m.repo,f.rel),target=entry(parent.directory.fd,path.posix.basename(f.rel)),temp=entry(parent.directory.fd,target.name+'.nozeli-'+randomUUID());
  let retainTemp=false;
  try{
   if(!oid){if((await inspectFile(m.repo,f.rel))?.digest!==disk?.digest)fail('SOURCE_CHANGED','删除前文件变化：'+f.rel);if(disk){await parent.verify();await deleteFileAt(target,{expectedDigest:disk.digest,expectedMode:disk.mode});};return;}
   const handle=await openAt(temp,'wx',parseInt(mode,8)&0o777);
   try{await gitStream(m.repo,['cat-file','blob',oid],{output:new Writable({write(chunk,encoding,done){handle.writeFile(chunk).then(()=>done(),done);}})});await handle.chmod(parseInt(mode,8)&0o777);await handle.sync();}finally{await handle.close();}
   const temporary=await inspectFile(m.repo,path.posix.join(path.posix.dirname(f.rel),temp.name));if(temporary?.digest!==wanted)fail('SOURCE_CHANGED','Git对象写入校验失败：'+f.rel);
   if((await inspectFile(m.repo,f.rel))?.digest!==disk?.digest)fail('SOURCE_CHANGED','写入前文件变化：'+f.rel);await parent.verify();await publishFileAt(temp,target,{expectedDigest:disk?.digest,expectedMode:disk?.mode});
  }catch(error){retainTemp=error.retainTemp===true;throw error;}finally{if(!retainTemp)await retainEntryAt(temp);await parent.close();}
 }
 async retainRecoveries(m){
  if(process.platform!=='darwin')return;
  const destination=path.join(this.store.root,'recovered-files',m.workId);await fs.mkdir(destination,{recursive:true,mode:0o700});
  const root=await openDirectoryChain(m.directory),saved=await openDirectoryChain(destination);
  const visit=async(fd,rel='')=>{
   for(const name of await readDirectory(fd)){
    const ref=entry(fd,name),stat=await statAt(ref,{bigint:true});if(!stat.isDirectory()||name==='.git'||name==='node_modules')continue;
    const dir=await openAt(ref,DIR_FLAGS);try{
     const reserved=await statAt(entry(fd,'.nozeli'),{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
     if(reserved?.dev===stat.dev&&reserved.ino===stat.ino){
      const recovery=entry(dir.fd,'recovery');const exists=await statAt(recovery,{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(exists){const id=randomUUID();m.retainedRecoveries??=[];m.retainedRecoveries.push({source:rel?rel+'/'+name+'/recovery':name+'/recovery',destination:path.join(destination,id)});await this.save(m);await renameAt(recovery,entry(saved.directory.fd,id),{exclusive:true});}
     }
     await visit(dir.fd,rel?rel+'/'+name:name);
    }finally{await dir.close();}
   }
  };
  try{await visit(root.directory.fd);await root.verify();await saved.verify();}finally{await root.close();await saved.close();}
 }
 async removeOwned(m){
  const exists=await fs.lstat(m.directory).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(exists){await this.identity(m,{target:false});if(m.finishIntent.decision==='accept'){const current=await this.snapshot(m,m.directory,m.inputCommit,'Nozeli cleanup verification');if(current.tree!==m.candidate.tree)fail('UNPUBLISHED_CHANGES','接受后执行目录又变化，未删除候选');}await this.retainRecoveries(m);await git(m.repo,['worktree','remove','--force',m.directory]);}
  const ref=await str(m.repo,['rev-parse','--verify',m.branchRef]).catch(()=>null);if(ref){const expected=m.candidate?.commit||m.inputCommit||m.baseCommit;if(ref!==expected)fail('WORKER_REF_CHANGED','分支不再属于受管候选，未删除');await git(m.repo,['update-ref','-d',m.branchRef,expected]);}
 }
 async recoverOperations(){
  // Cold open only reconciles durable evidence; it never infers a user decision.
  for(const work of this.store.state?.works||[]){const m=await this.readManifest(work.id);if(m?.freezeIntent){await this.identity(m,{target:false,worker:false});const head=await str(m.repo,['rev-parse',m.branchRef]);if(head===m.freezeIntent.commit){m.candidate=m.freezeIntent.candidate;delete m.freezeIntent;await this.save(m);}else if(head!==m.freezeIntent.before)fail('WORKER_REF_CHANGED','冻结意图与分支不一致');}}
  return [];
 }
}
