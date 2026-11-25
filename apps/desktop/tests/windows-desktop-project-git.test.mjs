import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ensureProjectGit} from '../src/main/project-git.mjs';
import {createWindowsDesktopProjectGitIO} from '../src/platform/windows/desktop-project-git.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
const git=(root,args)=>runGit(root,['-c','core.autocrlf=false','-c','core.hooksPath=NUL','-c','commit.gpgsign=false',...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'},encoding:'utf8'});
async function fixture(t,prepare=({root})=>fs.mkdir(root)){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-desktop-git-')),root=path.join(base,'项目 空格'),profile=path.join(base,'profile');
 let storage;t.after(async()=>{await storage?.db.close();await fs.rm(base,{recursive:true,force:true});});
 await prepare({base,root});await ensureExperimentalPrivateDirectory(base,profile);
 storage=new ProjectStorage(profile,{windowsDesktopProjects:true});const project=await storage.register(root),journal={read:()=>storage.getRecovery(project.id,'git-test'),write:value=>storage.putRecovery(project.id,'git-test',value)};
 return {base,root,storage,project,journal,options:{operationId:'synthetic-git-operation',expectedIdentity:project.identity,journal,ioFactory:createWindowsDesktopProjectGitIO}};
}
test('default Windows Git initialization remains unsupported before any repository effect',native,async t=>{
 const f=await fixture(t);await assert.rejects(ensureProjectGit(f.root,{...f.options,ioFactory:undefined}),{code:'NOZELI_CAPABILITY_UNAVAILABLE'});await assert.rejects(fs.stat(path.join(f.root,'.git')),{code:'ENOENT'});
});
test('native shared initialization captures exact baseline bytes and conservative exclusions with one commit',native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'paper.txt'),'exact\r\n中文 🧭\r\n');await fs.writeFile(path.join(f.root,'.gitignore'),'*.cache\r\n');await fs.writeFile(path.join(f.root,'generated.cache'),'ignored');await fs.writeFile(path.join(f.root,'.env.local'),'synthetic excluded');await fs.mkdir(path.join(f.root,'nested'));await git(path.join(f.root,'nested'),['init','-q']);await fs.writeFile(path.join(f.root,'nested/file'),'nested excluded');
 const acl=security('inspect',path.join(f.root,'.gitignore')),result=await ensureProjectGit(f.root,f.options);assert.equal(result.status,'ready');assert.equal(result.createdRepository,true);assert.deepEqual(result.baseline.included,['.gitignore','paper.txt']);assert.equal(result.baseline.excluded.find(row=>row.path==='.env.local').reason,'sensitive-name');assert.equal(result.baseline.excluded.find(row=>row.path==='nested/').reason,'nested-repository');
 assert.equal(await git(f.root,['show','HEAD:paper.txt']),'exact\r\n中文 🧭\r\n');assert.equal(await fs.readFile(path.join(f.root,'.gitignore'),'utf8'),'*.cache\r\n/.nozeli/\r\n');const after=security('inspect',path.join(f.root,'.gitignore'));for(const key of ['owner','group','protected','rules'])assert.deepEqual(after[key],acl[key]);assert.equal(await git(f.root,['status','--porcelain','--untracked-files=no']),'');
 assert.deepEqual(await ensureProjectGit(f.root,f.options),result);assert.equal((await git(f.root,['rev-list','--count','HEAD'])).trim(),'1');assert.deepEqual(await fs.readdir(path.join(f.root,'.nozeli/git-initialization')),[]);
});
test('an existing dirty repository retains its exact HEAD, index and source bytes',native,async t=>{
 const f=await fixture(t);await git(f.root,['init','-q']);await fs.writeFile(path.join(f.root,'paper.txt'),'baseline');await git(f.root,['add','paper.txt']);await git(f.root,['commit','-qm','Original']);const head=await git(f.root,['rev-parse','HEAD']);await fs.writeFile(path.join(f.root,'paper.txt'),'staged');await git(f.root,['add','paper.txt']);await fs.writeFile(path.join(f.root,'paper.txt'),'unstaged');const index=await fs.readFile(path.join(f.root,'.git/index'));
 const result=await ensureProjectGit(f.root,f.options);assert.equal(result.createdRepository,false);assert.equal(result.initialCommit,null);assert.equal(await git(f.root,['rev-parse','HEAD']),head);assert.deepEqual(await fs.readFile(path.join(f.root,'.git/index')),index);assert.equal(await fs.readFile(path.join(f.root,'paper.txt'),'utf8'),'unstaged');
});
test('a parent repository gets only the exact project-scoped ignore rule and keeps its unborn HEAD',native,async t=>{
 const f=await fixture(t);await git(f.base,['init','-q']);const head=await fs.readFile(path.join(f.base,'.git/HEAD')),result=await ensureProjectGit(f.root,f.options);assert.equal(result.repositoryRoot,f.base);assert.equal(result.createdRepository,false);assert.equal(await fs.readFile(path.join(f.base,'.gitignore'),'utf8'),'/项目\\ 空格/.nozeli/\n');assert.deepEqual(await fs.readFile(path.join(f.base,'.git/HEAD')),head);await assert.rejects(fs.stat(path.join(f.root,'.git')),{code:'ENOENT'});
});
test('existing effective ignore bytes remain untouched and tracked metadata produces a warning',native,async t=>{
 const f=await fixture(t);await git(f.root,['init','-q']);const original=Buffer.from('# custom\r\n.nozeli\r\n');await fs.writeFile(path.join(f.root,'.gitignore'),original);await git(f.root,['add','-f','.nozeli/project.json']);const index=await fs.readFile(path.join(f.root,'.git/index')),result=await ensureProjectGit(f.root,f.options);assert.equal(result.ignore.changed,false);assert.deepEqual(await fs.readFile(path.join(f.root,'.gitignore')),original);assert.equal(result.warnings[0].code,'PROJECT_METADATA_TRACKED');assert.deepEqual(await fs.readFile(path.join(f.root,'.git/index')),index);
});
test('an independent ignore lock is retained and explicit retry succeeds after its owner removes it',native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'.gitignore.lock'),'external winner');await assert.rejects(ensureProjectGit(f.root,f.options),{code:'PROJECT_GIT_IGNORE_BUSY'});assert.equal(await fs.readFile(path.join(f.root,'.gitignore.lock'),'utf8'),'external winner');await fs.unlink(path.join(f.root,'.gitignore.lock'));assert.equal((await ensureProjectGit(f.root,f.options)).status,'ready');
});
for(const phase of ['initialized','ignored','commit-prepared','committed','complete'])test(`native durable ${phase} checkpoint resumes the same shared Git initialization`,native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'paper.txt'),'prepared baseline');let stopped=false;
 const journal={read:f.journal.read,write:async state=>{await f.journal.write(state);if(!stopped&&state.phase===phase){stopped=true;throw Error('synthetic checkpoint interruption');}}};
 await assert.rejects(ensureProjectGit(f.root,{...f.options,journal}),/synthetic checkpoint interruption/);const before=await f.journal.read();if(before.initialCommit){await fs.writeFile(path.join(f.root,'paper.txt'),'later user edit');await fs.writeFile(path.join(f.root,'later.txt'),'later untracked file');}
 const result=await ensureProjectGit(f.root,f.options);assert.equal((await git(f.root,['rev-list','--count','HEAD'])).trim(),'1');if(before.initialCommit){assert.equal(result.initialCommit,before.initialCommit);assert.equal(await git(f.root,['show','HEAD:paper.txt']),'prepared baseline');assert.equal(await fs.readFile(path.join(f.root,'paper.txt'),'utf8'),'later user edit');assert.equal(result.baseline.included.includes('later.txt'),false);}
});
test('foreign directory identities and operation journals refuse repository allocation',native,async t=>{
 const f=await fixture(t);await assert.rejects(ensureProjectGit(f.root,{...f.options,expectedIdentity:{dev:'foreign',ino:'foreign'}}),{code:'PROJECT_IDENTITY_CONFLICT'});await f.journal.write({version:1,operationId:'foreign',root:f.root,identity:f.project.identity});await assert.rejects(ensureProjectGit(f.root,f.options),{code:'PROJECT_GIT_JOURNAL_CONFLICT'});await assert.rejects(fs.stat(path.join(f.root,'.git')),{code:'ENOENT'});
});
test('redirected Git metadata is explicitly refused without changing its pointer or referenced repository',native,async t=>{
 const f=await fixture(t),other=path.join(f.base,'other');await fs.mkdir(other);await git(other,['init','-q']);const pointer='gitdir: ../other/.git\n';await fs.writeFile(path.join(f.root,'.git'),pointer);const head=await fs.readFile(path.join(other,'.git/HEAD'));await assert.rejects(ensureProjectGit(f.root,f.options),{code:'PROJECT_GIT_LAYOUT_UNSUPPORTED'});assert.equal(await fs.readFile(path.join(f.root,'.git'),'utf8'),pointer);assert.deepEqual(await fs.readFile(path.join(other,'.git/HEAD')),head);await assert.rejects(fs.stat(path.join(f.root,'.gitignore')),{code:'ENOENT'});
});

for(const relative of [false,true])test(`a real ${relative?'relative':'absolute'} linked worktree changes only its own ignore rule`,native,async t=>{
 const f=await fixture(t,async({base,root})=>{
  const repo=path.join(base,'common-repo');await fs.mkdir(repo);await git(repo,['init','-q']);
  await fs.writeFile(path.join(repo,'paper.txt'),'baseline');await git(repo,['add','paper.txt']);await git(repo,['commit','-qm','Baseline']);
  await git(repo,['worktree','add',...(relative?['--relative-paths']:[]),'-qb','linked-fixture',root,'HEAD']);
 }),repo=path.join(f.base,'common-repo');
 const file=path.join(f.root,'paper.txt');
 await fs.writeFile(file,'staged');await git(f.root,['add','paper.txt']);await fs.writeFile(file,'unstaged');
 const pointer=path.join(f.root,'.git'),index=(await git(f.root,['rev-parse','--path-format=absolute','--git-path','index'])).trim();
 const refs=()=>git(repo,['for-each-ref','--format=%(refname) %(objectname)']);
 const before={pointer:await fs.readFile(pointer),index:await fs.readFile(index),refs:await refs()};
 const result=await ensureProjectGit(f.root,f.options);
 assert.equal(result.repositoryRoot,f.root);assert.equal(result.createdRepository,false);assert.equal(result.initialCommit,null);
 assert.deepEqual(await fs.readFile(pointer),before.pointer);assert.deepEqual(await fs.readFile(index),before.index);
 assert.equal(await refs(),before.refs);assert.equal(await fs.readFile(file,'utf8'),'unstaged');
 assert.equal(await fs.readFile(path.join(f.root,'.gitignore'),'utf8'),'/.nozeli/\n');
 await assert.rejects(fs.lstat(path.join(repo,'.gitignore')),{code:'ENOENT'});
});

for(const [record,phase] of [['gitdir','initialized'],['commondir','initialized'],['.git','initialized'],['.git','prepared']])test(`linked ${record} stays pinned and a same-byte replacement blocks retry from ${phase}`,native,async t=>{
 const f=await fixture(t,async({base,root})=>{
  const repo=path.join(base,'main');await fs.mkdir(repo);await git(repo,['init','-q']);
  await git(repo,['commit','--allow-empty','-qm','Fixture']);await git(repo,['worktree','add','-qb','fixture',root]);
 });
 const admin=(await git(f.root,['rev-parse','--absolute-git-dir'])).trim();
 const file=record==='.git'?path.join(f.root,record):path.join(admin,record),bytes=await fs.readFile(file);
 const journal={...f.journal,write:async state=>{
  await f.journal.write(state);if(state.phase!==phase)return;
  await assert.rejects(fs.rename(file,file+'.old'),{code:/^(EBUSY|EPERM|EACCES)$/});
  throw Error('fixture stopped while linked ownership was pinned');
 }};
 await assert.rejects(ensureProjectGit(f.root,{...f.options,journal}),/fixture stopped/);
 await fs.rename(file,file+'.old');await fs.writeFile(file,bytes);
 await assert.rejects(ensureProjectGit(f.root,f.options),{code:'PROJECT_GIT_CONFLICT'});
 assert.deepEqual(await fs.readFile(file),bytes);
 await assert.rejects(fs.lstat(path.join(f.root,'.gitignore')),{code:'ENOENT'});
 if(record==='gitdir'){
  await fs.writeFile(file,path.join(f.base,'foreign','.git').replaceAll('\\','/')+'\n');
  await assert.rejects(ensureProjectGit(f.root,f.options),{code:'PROJECT_GIT_LAYOUT_UNSUPPORTED'});
 }
});

test('a non-cooperative ignore writer wins without being overwritten by native digest CAS',native,async t=>{
 const f=await fixture(t),file=path.join(f.root,'.gitignore');await fs.writeFile(file,'original\n');
 const ioFactory=root=>{const io=createWindowsDesktopProjectGitIO(root);return {...io,ensureIgnore:(file,rule,effective,verifyRoot)=>io.ensureIgnore(file,rule,effective,async()=>{await fs.writeFile(file,'external winner\n');await verifyRoot();})};};
 await assert.rejects(ensureProjectGit(f.root,{...f.options,ioFactory}),{code:'FS_VERSION_CONFLICT'});assert.equal(await fs.readFile(file,'utf8'),'external winner\n');await assert.rejects(fs.stat(file+'.lock'),{code:'ENOENT'});assert.equal((await ensureProjectGit(f.root,f.options)).status,'ready');assert.equal(await fs.readFile(file,'utf8'),'external winner\n/.nozeli/\n');
});

test('an index published by another writer during initialization is retained byte for byte',native,async t=>{
 const f=await fixture(t),index=path.join(f.root,'.git/index'),winner=Buffer.from('synthetic external index bytes');
 const ioFactory=root=>{const io=createWindowsDesktopProjectGitIO(root);return {...io,publishInitialIndex:async(...args)=>{await fs.writeFile(index,winner,{flag:'wx'});return io.publishInitialIndex(...args);}};};
 assert.equal((await ensureProjectGit(f.root,{...f.options,ioFactory})).status,'ready');assert.deepEqual(await fs.readFile(index),winner);
});

test('baseline publication preserves a competing Git ref and retains the original prepared commit',native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'paper.txt'),'baseline bytes');
 let winner,prepared;
 const journal={read:f.journal.read,write:async state=>{
  await f.journal.write(state);
  if(state.phase!=='commit-prepared')return;
  prepared=state;
  const tree=(await git(f.root,['rev-parse',`${state.initialCommit}^{tree}`])).trim();
  winner=(await git(f.root,['commit-tree',tree,'-m','Independent Git writer'])).trim();
  assert.notEqual(winner,state.initialCommit);
  await git(f.root,['update-ref','refs/heads/main',winner,'0'.repeat(winner.length)]);
 }};
 await assert.rejects(ensureProjectGit(f.root,{...f.options,journal}),{code:'PROJECT_GIT_HEAD_CONFLICT'});
 assert.deepEqual(await f.journal.read(),prepared);
 assert.equal((await git(f.root,['rev-parse','HEAD'])).trim(),winner);
 await assert.rejects(fs.lstat(path.join(f.root,'.git/index')),{code:'ENOENT'});
 assert.equal(await git(f.root,['show',`${prepared.initialCommit}:paper.txt`]),'baseline bytes');
});

test('Windows baseline publication prevents HEAD switches and ref drift before the index write',native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'paper.txt'),'baseline bytes');
 const attempted=[];
 let contender;
 const branch=()=>git(f.root,['symbolic-ref','HEAD']);
 const switchHead=()=>git(f.root,['symbolic-ref','HEAD','refs/heads/other']);
 const ioFactory=root=>{
  const io=createWindowsDesktopProjectGitIO(root);
  return {...io,beforeGit:async args=>{
   io.beforeGit();
   if(args[0]==='update-ref'){
    attempted.push('ref');
    await assert.rejects(switchHead(),{code:1});
    assert.equal((await branch()).trim(),'refs/heads/main');
   }
  },publishInitialIndex:async (...args)=>{
   attempted.push('index');
   await assert.rejects(switchHead(),{code:1});
   assert.equal((await branch()).trim(),'refs/heads/main');
   const tree=(await git(f.root,['rev-parse','HEAD^{tree}'])).trim();
   contender=(await git(f.root,['commit-tree',tree,'-m','Competing baseline'])).trim();
   await assert.rejects(git(f.root,['update-ref','refs/heads/main',contender]),{code:128});
   await io.publishInitialIndex(...args);
  }};
 };
 const result=await ensureProjectGit(f.root,{...f.options,ioFactory});
 assert.deepEqual(attempted,['ref','index']);
 assert.equal((await branch()).trim(),'refs/heads/main');
 assert.equal((await git(f.root,['rev-parse','HEAD'])).trim(),result.initialCommit);
 assert.equal(await git(f.root,['show','HEAD:paper.txt']),'baseline bytes');
 assert.equal(await git(f.root,['show',':paper.txt']),'baseline bytes');
 await git(f.root,['update-ref','refs/heads/main',contender,result.initialCommit]);
 assert.equal((await git(f.root,['rev-parse','HEAD'])).trim(),contender);
 await switchHead();assert.equal((await branch()).trim(),'refs/heads/other');
});

test('Windows refuses baseline index publication when only a packed ref can be resolved',native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'paper.txt'),'baseline bytes');
 let prepared;
 const journal={read:f.journal.read,write:async state=>{
  await f.journal.write(state);
  if(state.phase!=='commit-prepared')return;
  prepared=state;
  await git(f.root,['update-ref','refs/heads/main',state.initialCommit,'0'.repeat(state.initialCommit.length)]);
  await git(f.root,['pack-refs','--all']);
 }};
 await assert.rejects(ensureProjectGit(f.root,{...f.options,journal}),{code:'PROJECT_GIT_HEAD_CONFLICT'});
 for(const relative of ['.git/refs/heads/main','.git/index'])await assert.rejects(fs.lstat(path.join(f.root,relative)),{code:'ENOENT'});
 assert.equal((await git(f.root,['rev-parse','HEAD'])).trim(),prepared.initialCommit);
 assert.deepEqual(await f.journal.read(),prepared);
});

test('Windows resumes a prepared baseline after the competing index lock owner releases it',native,async t=>{
 const f=await fixture(t),paper=path.join(f.root,'paper.txt');
 const index=path.join(f.root,'.git','index'),lock=index+'.lock',foreign=Buffer.from('independent index lock');
 await fs.writeFile(paper,'prepared bytes');
 const ioFactory=root=>{
  const io=createWindowsDesktopProjectGitIO(root);
  return {...io,async publishInitialIndex(...args){
   await fs.writeFile(lock,foreign,{flag:'wx'});
   return io.publishInitialIndex(...args);
  }};
 };
 await assert.rejects(ensureProjectGit(f.root,{...f.options,ioFactory}),{code:'PROJECT_GIT_INDEX_BUSY'});
 const prepared=await f.journal.read();
 assert.equal(prepared.phase,'commit-prepared');
 assert.equal((await git(f.root,['rev-parse','HEAD'])).trim(),prepared.initialCommit);
 assert.deepEqual(await fs.readFile(lock),foreign);
 await assert.rejects(fs.lstat(index),{code:'ENOENT'});

 await fs.unlink(lock);
 await fs.writeFile(paper,'later user edit');
 const result=await ensureProjectGit(f.root,f.options);
 assert.equal(result.initialCommit,prepared.initialCommit);
 assert.equal((await git(f.root,['rev-parse','HEAD'])).trim(),prepared.initialCommit);
 assert.equal(await git(f.root,['show',':paper.txt']),'prepared bytes');
 assert.equal(await fs.readFile(paper,'utf8'),'later user edit');
 assert.equal((await f.journal.read()).phase,'complete');
});

test('Windows leaves the index unpublished if main advances before the loose ref is pinned',native,async t=>{
 const f=await fixture(t),index=path.join(f.root,'.git','index');
 await fs.writeFile(path.join(f.root,'paper.txt'),'baseline bytes');
 let prepared,winner;
 const ioFactory=root=>{
  const io=createWindowsDesktopProjectGitIO(root);
  return {...io,async exists(file){
   const entry=await io.exists(file);
   if(file!==index||entry||winner)return entry;
   prepared=await f.journal.read();
   assert.equal(prepared.phase,'commit-prepared');
   assert.equal((await git(root,['rev-parse','HEAD'])).trim(),prepared.initialCommit);
   const tree=(await git(root,['rev-parse','HEAD^{tree}'])).trim();
   winner=(await git(root,['commit-tree',tree,'-p',prepared.initialCommit,'-m','Independent Git writer'])).trim();
   await git(root,['update-ref','refs/heads/main',winner,prepared.initialCommit]);
   return entry;
  }};
 };
 await assert.rejects(ensureProjectGit(f.root,{...f.options,ioFactory}),{code:'PROJECT_GIT_HEAD_CONFLICT'});
 assert.equal((await git(f.root,['rev-parse','HEAD'])).trim(),winner);
 await assert.rejects(fs.lstat(index),{code:'ENOENT'});
 assert.deepEqual(await f.journal.read(),prepared);
});
