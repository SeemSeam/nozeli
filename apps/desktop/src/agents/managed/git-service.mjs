import fs from 'node:fs/promises';
import path from 'node:path';
import {runGit,runGitStream,ensureGit} from './git-runtime.mjs';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {withSafeFile} from './file-stream.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {optionalIsolatedLaunch} from './process-isolation.mjs';
export const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
export function gitEnv(extra={}){const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];return {...env,GIT_LITERAL_PATHSPECS:'1',GIT_CONFIG_NOSYSTEM:'1',...extra};}
export const git=(cwd,args,extra={})=>runGit(cwd,args,{env:gitEnv(extra)});
export const str=async(cwd,args,extra)=>(await git(cwd,args,extra)).toString().trim();
export const read=async file=>fs.readFile(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
export const entries=buffer=>new Map(buffer.toString().split('\0').filter(Boolean).map(row=>{const at=row.indexOf('\t');return [row.slice(at+1),row.slice(0,at).split(' ')];}));
export const gitStream=(cwd,args,options={},extra={})=>runGitStream(cwd,args,{...options,env:gitEnv(extra)});
export async function gitRecords(cwd,args,extra={}){const rows=[];let pending=Buffer.alloc(0);await gitStream(cwd,args,{onStdout:chunk=>{const data=pending.length?Buffer.concat([pending,chunk]):chunk;let start=0,at;while((at=data.indexOf(0,start))!==-1){if(at>start)rows.push(data.toString('utf8',start,at));start=at+1;}pending=Buffer.from(data.subarray(start));}},extra);if(pending.length)rows.push(pending.toString());return rows;}
export async function gitEntries(cwd,args,extra={}){return new Map((await gitRecords(cwd,args,extra)).map(row=>{const at=row.indexOf('\t');return [row.slice(at+1),row.slice(0,at).trim().split(/\s+/)];}));}
export async function blobDigest(cwd,oid){if(!oid)return null;const hash=createHash('sha256');await gitStream(cwd,['cat-file','blob',oid],{onStdout:chunk=>hash.update(chunk)});return hash.digest('hex');}
export async function gitHasOutput(cwd,args){let any=false;await gitStream(cwd,args,{onStdout:chunk=>{any||=chunk.length>0;}});return any;}
// A small descriptor batch avoids one Git process per file without keeping an
// unbounded set of descriptors or any file bodies in memory.
export async function blobFiles(cwd,root,rels,known=new Map(),format='sha1'){
 const results=new Map(),opened=[];
 const capture=async at=>{if(at===rels.length){
   const changed=opened.filter(row=>row.oid!==known.get(row.rel)?.[2]);
   if(changed.length){const ids=(await runGit(cwd,['hash-object','-w','--no-filters','--stdin-paths'],{env:gitEnv(),input:Readable.from(changed.map(row=>'/proc/'+process.pid+'/fd/'+row.file.handle.fd+'\n'))})).toString().trim().split('\n');
    if(ids.length!==changed.length||ids.some((oid,i)=>oid!==changed[i].oid))fail('SOURCE_CHANGED','Git对象与文件流摘要不一致');}
   for(const {rel,file,digest,size,oid} of opened)results.set(rel,{oid,digest,size,mode:file.mode});return;
  }
  const rel=rels[at];let entered=false;const value=await withSafeFile(root,rel,async file=>{entered=true;const hash=createHash('sha256'),objectHash=createHash(format).update('blob '+file.stat.size+'\0');let size=0;for await(const chunk of file.stream()){hash.update(chunk);objectHash.update(chunk);size+=chunk.length;}if(BigInt(size)!==file.stat.size)fail('SOURCE_CHANGED','文件读取期间变化：'+rel);opened.push({rel,file,digest:hash.digest('hex'),oid:objectHash.digest('hex'),size});await capture(at+1);return true;});if(!entered){results.set(rel,null);await capture(at+1);}return value;
 };await capture(0);return results;
}
export async function blobFile(cwd,root,rel){return (await blobFiles(cwd,root,[rel],new Map(),await str(cwd,['rev-parse','--show-object-format']))).get(rel);}
export async function updateIndexRows(cwd,index,rows){if(!rows.length)return;const format=await str(cwd,['rev-parse','--show-object-format']);const zero='0'.repeat(format==='sha256'?64:40);await gitStream(cwd,['update-index','-z','--index-info'],{input:Readable.from((function*(){for(const {rel,mode,oid} of rows)yield (oid?mode+' '+oid:'0 '+zero)+'\t'+rel+'\0';})())},{GIT_INDEX_FILE:index});}
export async function acceptanceCommit(repo,tree,parent,message,directory,attempt={},persist=async()=>{}){
 const configured=await str(repo,['config','--get','core.hooksPath']).catch(()=>null),hooks=configured?path.resolve(repo,configured):path.resolve(repo,await str(repo,['rev-parse','--git-path','hooks']));
 let enabled=false;for(const name of ['pre-commit','prepare-commit-msg','commit-msg','post-commit']){const stat=await fs.stat(path.join(hooks,name)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(stat&&(process.platform==='win32'||stat.mode&0o111))enabled=true;}
 if(attempt.commit)return attempt.commit;
 if(!enabled&&!attempt.shadow){const commit=await commitTree(repo,tree,[parent],message,directory);attempt.commit=commit;await persist(attempt);return commit;}
 const shadow=attempt.shadow||path.join(directory,'hook-candidate-'+globalThis.crypto.randomUUID()),home=path.join(directory,'hook-home');
 const verify=async commit=>{if(await str(shadow,['show','-s','--format=%T',commit])!==tree||await str(shadow,['show','-s','--format=%P',commit])!==parent||await gitHasOutput(shadow,['status','--porcelain','--untracked-files=all']))fail('HOOK_CHANGED','钩子修改了批准候选；已保留候选');await git(repo,['fetch','--no-write-fetch-head','--no-tags',shadow,commit]);attempt.commit=commit;attempt.status='complete';await persist(attempt);return commit;};
 if(attempt.shadow){const head=await str(shadow,['rev-parse','HEAD']).catch(()=>null);if(head&&head!==parent)return verify(head);if(attempt.status==='running')fail('HOOK_UNCERTAIN','钩子执行中断且无完成提交；保留现场，不重复执行可能有副作用的钩子');}
 attempt.shadow=shadow;attempt.status='preparing';await persist(attempt);await fs.mkdir(shadow,{recursive:true});await git(shadow,['init','--initial-branch=acceptance']);
 const common=await fs.realpath(path.resolve(repo,await str(repo,['rev-parse','--git-common-dir'])));await fs.copyFile(path.join(common,'config'),path.join(shadow,'.git','config'));
 await git(shadow,['config','core.bare','false']);await git(shadow,['config','core.worktree',shadow]);await git(shadow,['config','core.hooksPath',hooks]);await git(shadow,['config','commit.gpgSign','false']);await fs.mkdir(path.join(shadow,'.git','objects','info'),{recursive:true});await fs.writeFile(path.join(shadow,'.git','objects','info','alternates'),path.join(common,'objects')+'\n');
 await git(shadow,['update-ref','refs/heads/acceptance',parent]);await git(shadow,['symbolic-ref','HEAD','refs/heads/acceptance']);await git(shadow,['read-tree','--reset','-u',tree]);
 const runtime=await ensureGit();
 // Explicit sandbox opt-in can use these read domains; ordinary hooks run as the current user.
 // The shadow repository preserves the accepted candidate, not an OS access boundary.
 const execPath=await fs.realpath(String(runtime.env.GIT_EXEC_PATH));
 const templateDir=runtime.env.GIT_TEMPLATE_DIR?await fs.realpath(String(runtime.env.GIT_TEMPLATE_DIR)):null;
 const gitRoot=path.dirname(path.dirname(execPath));
 const readable=[gitRoot,common];
 const inside=(p,roots)=>roots.some(root=>p===root||p.startsWith(root+path.sep));
 if(templateDir&&!inside(templateDir,readable))readable.push(templateDir);
 if(!inside(hooks,readable)&&await fs.stat(hooks).catch(()=>null))readable.push(await fs.realpath(hooks));
 // No mandatory bubblewrap dependency; hooks retain the current user's OS capabilities.
 const {launch}=await optionalIsolatedLaunch({command:runtime.command,args:['-c','user.name=Nozeli','-c','user.email=work@nozeli.local','commit','--allow-empty','-m',message],cwd:shadow,home,writable:[shadow],readable});
 const hookEnv={...runtime.env};for(const key of Object.keys(hookEnv))if(key.startsWith('GIT_')&&!['GIT_EXEC_PATH','GIT_TEMPLATE_DIR'].includes(key))delete hookEnv[key];
 attempt.status='running';await persist(attempt);
 try{await promisify(execFile)(launch.command,launch.args,{cwd:shadow,env:{...hookEnv,...launch.env,HOME:home,GIT_EXEC_PATH:execPath,...(templateDir?{GIT_TEMPLATE_DIR:templateDir}:{}),GIT_LITERAL_PATHSPECS:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Nozeli',GIT_AUTHOR_EMAIL:'work@nozeli.local',GIT_COMMITTER_NAME:'Nozeli',GIT_COMMITTER_EMAIL:'work@nozeli.local'},timeout:60000,maxBuffer:4*1024*1024});}catch(error){
  // A normal nonzero exit is a completed rejection, not an interrupted hook.
  // Keep timeouts, signals and transport errors uncertain: they cannot authorize replay.
  if(Number.isInteger(error.code)&&!error.signal&&!error.killed){attempt.status='rejected';await persist(attempt);}
  fail('HOOK_REJECTED','接受提交钩子失败；候选已保留：'+(error.stderr||error.stdout||error.message));
 }
 return verify(await str(shadow,['rev-parse','HEAD']));
}
export async function repository(cwd){
 const root=await fs.realpath(cwd);let top;try{top=await str(root,['rev-parse','--show-toplevel']);}catch{fail('REPOSITORY_REQUIRED','项目Git尚未初始化');}
 if(await fs.realpath(top)!==root)fail('REPO_BOUNDARY','项目必须是Git仓库根目录');
 const gitDir=await fs.realpath(await str(root,['rev-parse','--absolute-git-dir'])),commonDir=await fs.realpath(path.resolve(root,await str(root,['rev-parse','--git-common-dir'])));
 const targetRef=await str(root,['symbolic-ref','HEAD']).catch(()=>null),targetHead=await str(root,['rev-parse','--verify','HEAD']).catch(()=>null);
 if(!targetRef?.startsWith('refs/heads/')||!targetHead)fail('HEAD_UNSUPPORTED','需要已有提交的普通分支');
 if(await str(root,['config','--get','core.sparseCheckout']).catch(()=>'false')==='true')fail('GIT_LAYOUT','不支持稀疏检出');
 if(await str(root,['config','--get-regexp','^filter\\.']).catch(()=>'')||!['false',''].includes(await str(root,['config','--get','core.autocrlf']).catch(()=>'false')))fail('FILTER_UNSUPPORTED','Git转换配置需要先关闭');
 if(await gitHasOutput(root,['ls-files','-u']))fail('GIT_BUSY','Git索引有冲突');
 for(const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply'])if(await read(path.join(gitDir,marker)).catch(()=>Buffer.from('busy')))fail('GIT_BUSY','存在未完成Git操作');
 return {repo:root,gitDir,commonDir,targetRef,targetHead,index:path.join(gitDir,'index'),headFile:path.join(gitDir,'HEAD')};
}
export async function commitTree(cwd,tree,parents,message,directory){
 await fs.mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'message-'+globalThis.crypto.randomUUID()+'.txt');await fs.writeFile(file,message+'\n');
 try{return await str(cwd,['commit-tree',tree,...parents.flatMap(p=>['-p',p]),'-F',file],{GIT_AUTHOR_NAME:'Nozeli',GIT_AUTHOR_EMAIL:'work@nozeli.local',GIT_COMMITTER_NAME:'Nozeli',GIT_COMMITTER_EMAIL:'work@nozeli.local'});}finally{await fs.unlink(file);}
}
