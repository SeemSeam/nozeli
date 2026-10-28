import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {ExecutionWorkspace} from '../src/agents/managed/execution-workspace.mjs';
import {git} from '../src/agents/managed/git-service.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {openTestWorkspace} from './project-storage.fixture.mjs';

// 被忽略的 node_modules 不随 worktree 迁移：当源项目模块与冻结输入的
// package.json/package-lock.json 完全一致时，prepare 必须向执行目录供给一份
// 独立可写的拷贝（真实 Node import 可用、写入不影响源端）；不一致时拒绝并
// 在 manifest.dependencies 暴露原因，绝不伪造可用，也绝不覆盖/删除现有模块。
const manifestJson=name=>JSON.stringify({name,version:'1.0.0',type:'module'},null,2)+'\n';
const lockJson=()=>JSON.stringify({name:'probe-project',version:'1.0.0',lockfileVersion:3,packages:{"":{name:'probe-project',version:'1.0.0'}}},null,2)+'\n';
const importProbe=async dir=>(await import(pathToFileURL(path.join(dir,'nozeli-probe','index.mjs')).href)).probe;
async function installProbe(dir,label){
 await fs.mkdir(path.join(dir,'nozeli-probe'),{recursive:true});
 await fs.writeFile(path.join(dir,'nozeli-probe','package.json'),JSON.stringify({name:'nozeli-probe',version:'1.0.0',type:'module',main:'index.mjs'}));
 await fs.writeFile(path.join(dir,'nozeli-probe','index.mjs'),`export const probe='${label}';\n`);
}
async function installDist(dir){
 await fs.mkdir(path.join(dir,'assets'),{recursive:true});
 await fs.writeFile(path.join(dir,'index.html'),'<html>pptist</html>\n');
 await fs.writeFile(path.join(dir,'assets','app.mjs'),'export const pptist="vendor";\n');
}
const pptistReadme='# PPTist fixture engine\n\nRevision: `fixedfixture` (2.0.0)\nSHA-256: '+'f'.repeat(64)+'\n`dist/` 由 pinned 工具本地构建。\n';
const pptistLock=JSON.stringify({name:'pptist',version:'2.0.0',lockfileVersion:3},null,2)+'\n';
async function fixture(t,{modules=false,lockFile=true,sub=false,vendor=null}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-worktree-deps-')),project=path.join(root,'project');await fs.mkdir(project);
 let store;t.after(async()=>{await store?.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(path.join(project,'worker.txt'),'base\n');
 await fs.writeFile(path.join(project,'.gitignore'),'node_modules/\n.nozeli/\nvendor/pptist/dist/\napps/desktop/vendor/pptist/dist/\n');
 await fs.writeFile(path.join(project,'package.json'),manifestJson('probe-project'));
 if(lockFile)await fs.writeFile(path.join(project,'package-lock.json'),lockJson());
 if(modules)await installProbe(path.join(project,'node_modules'),'source');
 if(vendor==='declared'||vendor==='bare'){
  await fs.mkdir(path.join(project,'vendor','pptist'),{recursive:true});
  await fs.writeFile(path.join(project,'vendor','pptist','README.md'),pptistReadme);
  await fs.writeFile(path.join(project,'vendor','pptist','package-lock.json'),pptistLock);
  await installDist(path.join(project,'vendor','pptist','dist'));
  if(vendor==='declared')await fs.writeFile(path.join(project,'vendor','prepared-resources.json'),JSON.stringify({version:1,resources:[{path:'vendor/pptist/dist',tool:'tools/build-pptist.mjs',upstream:{revision:'fixedfixture',sha256:'f'.repeat(64)}}]},null,2)+'\n');
 }
 if(vendor==='mono-declared'){
  const desktop=path.join(project,'apps','desktop');
  await fs.mkdir(path.join(desktop,'vendor','pptist'),{recursive:true});
  await fs.writeFile(path.join(desktop,'package.json'),manifestJson('probe-desktop'));
  await fs.writeFile(path.join(desktop,'package-lock.json'),lockJson());
  await fs.writeFile(path.join(desktop,'vendor','pptist','README.md'),pptistReadme);
  await installDist(path.join(desktop,'vendor','pptist','dist'));
  await fs.writeFile(path.join(desktop,'vendor','prepared-resources.json'),JSON.stringify({version:1,resources:[{path:'vendor/pptist/dist',tool:'tools/build-pptist.mjs',upstream:{revision:'fixedfixture',sha256:'f'.repeat(64)}}]},null,2)+'\n');
 }
 if(sub){
  await fs.mkdir(path.join(project,'packages','sub'),{recursive:true});
  await fs.writeFile(path.join(project,'packages','sub','package.json'),manifestJson('probe-sub'));
  await fs.writeFile(path.join(project,'packages','sub','package-lock.json'),lockJson());
  if(modules)await installProbe(path.join(project,'packages','sub','node_modules'),'sub');
 }
 await git(project,['init','--initial-branch=main']);await git(project,['add','.']);await git(project,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','initial']);
 store=await openTestWorkspace(path.join(root,'runtime'),project);
 const execution=new ExecutionWorkspace(store),work={id:'work-deps',revision:1,threadId:'thread-a',result:{objectId:'fixture-report-deps',revision:1}};store.state.works.push(work);
 return {root,project,store,execution,work,directory:execution.directory(work.id)};
}

test('provisions independent module copies that really import and never touch the source',async t=>{
 const f=await fixture(t,{modules:true});
 const m=await f.execution.prepare(f.work.id);
 assert.deepEqual(m.dependencies.entries.map(e=>[e.dir,e.outcome]),[['.','provisioned']]);
 const workerModules=path.join(f.directory,'node_modules'),stat=await fs.lstat(workerModules);
 assert.equal(stat.isSymbolicLink(),false);assert.ok(stat.isDirectory());
 assert.equal(await importProbe(workerModules),'source');
 // 写入隔离：改写/新增 Worker 拷贝中的模块文件，源项目逐字节不变。
 const sourceIndex=path.join(f.project,'node_modules','nozeli-probe','index.mjs'),sourceBytes=await fs.readFile(sourceIndex);
 await fs.writeFile(path.join(workerModules,'nozeli-probe','index.mjs'),'export const probe="worker-write";\n');
 await fs.writeFile(path.join(workerModules,'nozeli-probe','worker-only.mjs'),'worker\n');
 assert.deepEqual(await fs.readFile(sourceIndex),sourceBytes);
 await assert.rejects(fs.stat(path.join(f.project,'node_modules','nozeli-probe','worker-only.mjs')));
 // 重复 prepare：已有模块一律保留（outcome=present），不覆盖不删除。
 const again=await f.execution.prepare(f.work.id);
 assert.equal(again.dependencies.entries[0].outcome,'present');
 assert.equal(await fs.readFile(path.join(workerModules,'nozeli-probe','worker-only.mjs'),'utf8'),'worker\n');
 assert.equal((await f.execution.readManifest(f.work.id)).dependencies.entries[0].outcome,'present');
});

test('refuses on source or worker mismatch with explicit reasons instead of faking availability',async t=>{
 const f=await fixture(t,{modules:true});
 let m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries[0].outcome,'provisioned');
 // 源端 lock 漂移：拒绝供给，执行目录保持没有 node_modules，原因可见。
 await fs.writeFile(path.join(f.project,'package-lock.json'),lockJson().replaceAll('probe-project','probe-project-drifted'));
 await fs.rm(path.join(f.directory,'node_modules'),{recursive:true,force:true});
 m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries[0].outcome,'source-lock-differs');
 assert.ok(m.dependencies.entries[0].detail.length>0);
 await assert.rejects(fs.stat(path.join(f.directory,'node_modules')));
 // 源端恢复一致后可供给；Worker 自己改过 manifest 则拒绝且不动现有模块。
 await fs.writeFile(path.join(f.project,'package-lock.json'),lockJson());
 m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries[0].outcome,'provisioned');
 await fs.writeFile(path.join(f.directory,'package.json'),manifestJson('probe-project-worker-edit'));
 m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries[0].outcome,'worker-file-changed');
 assert.ok((await fs.stat(path.join(f.directory,'node_modules'))).isDirectory());
 // 依赖拷贝永不进入候选：发布差异只有 Worker 真正改过的 package.json。
 const result=await f.execution.publish(f.work,{id:'job-1'},()=>true);
 assert.deepEqual(result.candidate.files,['package.json']);
});

test('provisions already-prepared worktrees later and clears only marker-gated staging leftovers',async t=>{
 const f=await fixture(t,{modules:false});
 let m=await f.execution.prepare(f.work.id);
 assert.deepEqual(m.dependencies.entries.map(e=>[e.dir,e.outcome]),[['.','source-modules-missing']]);
 await assert.rejects(fs.stat(path.join(f.directory,'node_modules')));
 // 源端后来装好模块（manifest/lock 未变）：已完成的 worktree 在 prepare 时获得供给。
 await installProbe(path.join(f.project,'node_modules'),'source');
 m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries[0].outcome,'provisioned');
 assert.equal(await importProbe(path.join(f.directory,'node_modules')),'source');
 // 崩溃残留清理：只删带 staging.json marker 的暂存目录，其余 .nozeli 内容保留。
 const stale=path.join(f.directory,'.nozeli','deps-stale'),foreign=path.join(f.directory,'.nozeli','deps-keep');
 await fs.mkdir(path.join(stale,'node_modules','junk'),{recursive:true});
 await fs.writeFile(path.join(stale,'staging.json'),JSON.stringify({workId:'work-deps'})+'\n');
 await fs.mkdir(foreign,{recursive:true});
 m=await f.execution.prepare(f.work.id);
 await assert.rejects(fs.stat(stale));
 assert.ok((await fs.stat(foreign)).isDirectory());
 assert.ok((await fs.stat(path.join(f.directory,'node_modules','nozeli-probe'))).isDirectory());
 // 用户自装模块保留；删除后再次 prepare 按同一冻结输入重新供给。
 await fs.writeFile(path.join(f.directory,'node_modules','user-pkg.txt'),'keep');
 m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries[0].outcome,'present');
 assert.equal(await fs.readFile(path.join(f.directory,'node_modules','user-pkg.txt'),'utf8'),'keep');
 await fs.rm(path.join(f.directory,'node_modules'),{recursive:true,force:true});
 m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries[0].outcome,'provisioned');
});

test('materializes symlinked sources into real independent directories and preserves target symlinks',async t=>{
 const f=await fixture(t,{modules:false});
 await f.execution.prepare(f.work.id);
 const external=path.join(f.root,'external-modules');
 await installProbe(external,'linked');
 await fs.symlink(external,path.join(f.project,'node_modules'),'dir');
 let m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries[0].outcome,'provisioned');
 const workerModules=path.join(f.directory,'node_modules'),stat=await fs.lstat(workerModules);
 assert.equal(stat.isSymbolicLink(),false);assert.ok(stat.isDirectory());
 assert.equal(await importProbe(workerModules),'linked');
 // 源端（符号链接目标）后续变化不影响已独立拷贝。
 const workerIndex=path.join(workerModules,'nozeli-probe','index.mjs'),frozen=await fs.readFile(workerIndex);
 await fs.writeFile(path.join(external,'nozeli-probe','index.mjs'),'export const probe="mutated";\n');
 assert.deepEqual(await fs.readFile(workerIndex),frozen);
 // 目标已是指向源端的符号链接：保留现场，绝不替换、绝不跟随写入。
 await fs.rm(workerModules,{recursive:true,force:true});
 await fs.symlink(external,workerModules,'dir');
 m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries[0].outcome,'target-symlink');
 assert.equal(await fs.readlink(workerModules),external);
 assert.equal((await importProbe(external)),'mutated');
});

test('provisions nested workspace packages and ignores manifests without a lock',async t=>{
 const f=await fixture(t,{modules:true,sub:true});
 const m=await f.execution.prepare(f.work.id);
 assert.deepEqual(m.dependencies.entries.map(e=>[e.dir,e.outcome]),[['.','provisioned'],['packages/sub','provisioned']]);
 assert.equal(await importProbe(path.join(f.directory,'node_modules')),'source');
 assert.equal(await importProbe(path.join(f.directory,'packages','sub','node_modules')),'sub');
 const g=await fixture(t,{modules:true,lockFile:false});
 const n=await g.execution.prepare(g.work.id);
 assert.deepEqual(n.dependencies.entries,[]);
 await assert.rejects(fs.stat(path.join(g.directory,'node_modules')));
});

test('refuses when the staging root is a symlink and never deletes or writes through it',async t=>{
 const f=await fixture(t,{modules:true});
 let m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries[0].outcome,'provisioned');
 await fs.rm(path.join(f.directory,'node_modules'),{recursive:true,force:true});
 // 即使 marker 携带精确 workId，也绝不透过符号链接化的 .nozeli 清理或写入。
 const outside=path.join(f.root,'outside-nozeli'),fake=path.join(outside,'deps-fake');
 await fs.mkdir(path.join(fake,'node_modules','payload'),{recursive:true});
 await fs.writeFile(path.join(fake,'staging.json'),JSON.stringify({workId:'work-deps'})+'\n');
 await fs.symlink(outside,path.join(f.directory,'.nozeli'),'dir');
 m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries[0].outcome,'unsafe-target-path');
 assert.equal(m.dependencies.entries[0].reason,'staging-root');
 assert.ok((await fs.stat(path.join(fake,'node_modules','payload'))).isDirectory());
 assert.equal(await fs.readlink(path.join(f.directory,'.nozeli')),outside);
 await assert.rejects(fs.stat(path.join(f.directory,'node_modules')));
});

test('discards the copy with an explicit reason when the source changes during provisioning',async t=>{
 const f=await fixture(t,{modules:true});
 // 加重源树拉长复制窗口；暂存目录一出现就改写源端 lock，收尾复核必须放弃。
 const heavy=path.join(f.project,'node_modules','heavy-pkg');
 for(let i=0;i<2000;i++){await fs.mkdir(path.join(heavy,'d'+i),{recursive:true});await fs.writeFile(path.join(heavy,'d'+i,'f.js'),'export default '+i+';\n');}
 let flipped=false;
 const flip=(async()=>{for(;;){if(await fs.stat(path.join(f.directory,'.nozeli')).then(()=>true,()=>false)){await fs.writeFile(path.join(f.project,'package-lock.json'),lockJson().replaceAll('probe-project','probe-project-flipped'));flipped=true;return;}await delay(2);}})();
 const m=await f.execution.prepare(f.work.id);
 await flip;
 assert.ok(flipped);
 assert.equal(m.dependencies.entries[0].outcome,'changed-during-copy');
 assert.equal(m.dependencies.entries[0].reason,'source-lock');
 await assert.rejects(fs.stat(path.join(f.directory,'node_modules')));
 const leftovers=await fs.readdir(path.join(f.directory,'.nozeli')).catch(() => []);
 assert.equal(leftovers.filter(name=>name.startsWith('deps-')).length,0);
 // 源端恢复一致后重新 prepare 可正常供给，无半成品残留阻断。
 await fs.writeFile(path.join(f.project,'package-lock.json'),lockJson());
 const again=await f.execution.prepare(f.work.id);
 assert.equal(again.dependencies.entries[0].outcome,'provisioned');
 assert.equal(await importProbe(path.join(f.directory,'node_modules')),'source');
});

test('provisions declared prepared vendor resources with provenance and full safety',async t=>{
 const f=await fixture(t,{modules:false,lockFile:false,vendor:'declared'});
 let m=await f.execution.prepare(f.work.id);
 const resource=m.dependencies.entries.find(e=>e.kind==='prepared-resource');
 assert.ok(resource);
 assert.equal(resource.outcome,'provisioned');
 assert.equal(resource.resource,'vendor/pptist/dist');
 assert.deepEqual(resource.provenance,{declared:'vendor/prepared-resources.json',tool:'tools/build-pptist.mjs',upstream:{revision:'fixedfixture',sha256:'f'.repeat(64)}});
 const workerDist=path.join(f.directory,'vendor','pptist','dist');
 assert.equal((await fs.lstat(workerDist)).isSymbolicLink(),false);
 assert.equal(await fs.readFile(path.join(workerDist,'index.html'),'utf8'),'<html>pptist</html>\n');
 assert.equal((await import(pathToFileURL(path.join(workerDist,'assets','app.mjs')).href)).pptist,'vendor');
 // 写入隔离：Worker 拷贝新增文件，源端不变。
 await fs.writeFile(path.join(workerDist,'worker-only.txt'),'x');
 await assert.rejects(fs.stat(path.join(f.project,'vendor','pptist','dist','worker-only.txt')));
 // 重复 prepare 保留现有内容；清单被 Worker 改动则拒绝且不动现有资源。
 m=await f.execution.prepare(f.work.id);
 assert.equal(m.dependencies.entries.find(e=>e.kind==='prepared-resource').outcome,'present');
 await fs.writeFile(path.join(f.directory,'vendor','prepared-resources.json'),'{"version":1,"resources":[]}\n');
 m=await f.execution.prepare(f.work.id);
 const drifted=m.dependencies.entries.find(e=>e.kind==='prepared-resource');
 assert.equal(drifted.outcome,'worker-file-changed');
 assert.equal(drifted.reason,'metadata');
 assert.ok((await fs.stat(workerDist)).isDirectory());
 // 源端 dist 缺失：删除 Worker 端后给出可执行原因，不伪造可用。
 await fs.writeFile(path.join(f.directory,'vendor','prepared-resources.json'),await fs.readFile(path.join(f.project,'vendor','prepared-resources.json')));
 await fs.rm(workerDist,{recursive:true,force:true});
 await fs.rm(path.join(f.project,'vendor','pptist','dist'),{recursive:true,force:true});
 m=await f.execution.prepare(f.work.id);
 const missing=m.dependencies.entries.find(e=>e.kind==='prepared-resource');
 assert.equal(missing.outcome,'source-resource-missing');
 assert.ok(missing.detail.includes('build-pptist'));
 await assert.rejects(fs.stat(workerDist));
});

test('rejects invalid declarations and leaves undeclared or tracked resources untouched',async t=>{
 const bad=await fixture(t,{modules:false,lockFile:false,vendor:'declared'});
 // 坏清单在冻结时即存在（Worker==源==冻结），解析失败必须在拷贝前拒绝。
 await fs.writeFile(path.join(bad.project,'vendor','prepared-resources.json'),JSON.stringify({version:1,resources:[{path:'../escape',tool:'x'}]},null,2)+'\n');
 let m=await bad.execution.prepare(bad.work.id);
 const invalid=m.dependencies.entries.find(e=>e.kind==='prepared-resource');
 assert.equal(invalid.outcome,'invalid-metadata');
 assert.equal(invalid.reason,'invalid-path');
 await assert.rejects(fs.stat(path.join(bad.directory,'vendor','pptist','dist')));
 const tracked=await fixture(t,{modules:false,lockFile:false,vendor:'declared'});
 await fs.writeFile(path.join(tracked.project,'vendor','prepared-resources.json'),JSON.stringify({version:1,resources:[{path:'worker.txt'}]},null,2)+'\n');
 m=await tracked.execution.prepare(tracked.work.id);
 const present=m.dependencies.entries.find(e=>e.kind==='prepared-resource');
 assert.equal(present.outcome,'present');
 assert.equal(present.reason,'tracked');
 assert.equal(await fs.readFile(path.join(tracked.directory,'worker.txt'),'utf8'),'base\n');
 const bare=await fixture(t,{modules:false,lockFile:false,vendor:'bare'});
 m=await bare.execution.prepare(bare.work.id);
 assert.deepEqual(m.dependencies.entries.filter(e=>e.kind==='prepared-resource'),[]);
 await assert.rejects(fs.stat(path.join(bare.directory,'vendor','pptist','dist')));
});

test('discovers monorepo package declarations and provisions project-relative resources',async t=>{
 const f=await fixture(t,{modules:false,lockFile:true,vendor:'mono-declared'});
 const m=await f.execution.prepare(f.work.id);
 // 根包与 apps/desktop 包都是依赖候选（均无模块）；声明仅在包目录被命中。
 assert.deepEqual(m.dependencies.entries.filter(e=>e.kind==='dependencies').map(e=>[e.dir,e.outcome]),[['.','source-modules-missing'],['apps/desktop','source-modules-missing']]);
 const resource=m.dependencies.entries.find(e=>e.kind==='prepared-resource');
 assert.ok(resource);
 assert.equal(resource.outcome,'provisioned');
 assert.equal(resource.resource,'apps/desktop/vendor/pptist/dist');
 assert.equal(resource.dir,'apps/desktop/vendor/pptist');
 assert.deepEqual(resource.provenance,{declared:'apps/desktop/vendor/prepared-resources.json',tool:'apps/desktop/tools/build-pptist.mjs',upstream:{revision:'fixedfixture',sha256:'f'.repeat(64)}});
 // 拷贝落在 worktree 的包目录下，绝不是项目根 vendor。
 const workerDist=path.join(f.directory,'apps','desktop','vendor','pptist','dist');
 assert.equal(await fs.readFile(path.join(workerDist,'index.html'),'utf8'),'<html>pptist</html>\n');
 assert.equal((await import(pathToFileURL(path.join(workerDist,'assets','app.mjs')).href)).pptist,'vendor');
 await assert.rejects(fs.stat(path.join(f.directory,'vendor')));
 await assert.rejects(fs.stat(path.join(f.directory,'vendor','pptist','dist')));
 // 源端包目录保持只读：声明与 dist 原样。
 assert.ok((await fs.stat(path.join(f.project,'apps','desktop','vendor','pptist','dist','index.html'))).isFile());
});
