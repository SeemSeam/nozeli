import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {openExperimentalSourceDirectory} from '../src/platform/windows/experimental-source-directory.mjs';
import {openExperimentalSourceTree,openExperimentalPrivateTree} from '../src/platform/windows/experimental-private-tree.mjs';
import {openExperimentalPersistenceParent} from '../src/platform/windows/experimental-persistence.mjs';
import {ensureExperimentalPrivateDirectory as ensure} from '../src/platform/windows/experimental-directories.mjs';
import {experimentalWindowsVersionedFilesystem as filesystem} from '../src/platform/windows/experimental-filesystem.mjs';
import {createExperimentalWindowsProvisioning} from '../src/platform/windows/experimental-provisioning.mjs';
import {createExperimentalExecutionWorkspaceIO} from '../src/platform/windows/experimental-execution-workspace.mjs';
import {provisionWorktreeDependencies as provision} from '../src/agents/managed/worktree-dependencies.mjs';
import {ExecutionWorkspace} from '../src/agents/managed/execution-workspace.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {git,str,commitTree} from '../src/agents/managed/git-service.mjs';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'},sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest='{"name":"synthetic","version":"1.0.0","type":"module"}\n',lock='{"lockfileVersion":3,"packages":{}}\n';
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-provision-')),source=path.join(root,'来源 空格'),target=path.join(root,'执行 空格'),resources=[];
 await fs.mkdir(source);await ensure(root,target);
 t.after(async()=>{for(const resource of resources.reverse())await (resource.db??resource).close();await fs.rm(root,{recursive:true,force:true});});
 const files={};
 const gate=async(rel,bytes)=>{for(const dir of [source,target]){await fs.mkdir(path.dirname(path.join(dir,rel)),{recursive:true});await fs.writeFile(path.join(dir,rel),bytes);}files[rel]={digest:sha(bytes)};};
 await gate('package.json',manifest);await gate('package-lock.json',lock);
 const modules=async(dir=source,label='source')=>{await fs.mkdir(path.join(dir,'node_modules','probe'),{recursive:true});await fs.writeFile(path.join(dir,'node_modules','probe','index.mjs'),`export const probe=${JSON.stringify(label)};\n`);};
 const run=async(options={})=>provision({workId:'synthetic-work',sourceRoot:source,worktreeRoot:target,frozenFiles:files},options);
 return {root,source,target,files,gate,modules,run,hold(value){resources.push(value);return value;}};
}
const injected=hooks=>({filesystem:{...filesystem,provisioning:createExperimentalWindowsProvisioning(hooks)}});
const entry=report=>report.entries.find(row=>row.kind==='dependencies'&&row.dir==='.');
const absent=file=>assert.rejects(fs.lstat(file),{code:'ENOENT'});
function child(code,args){const result=spawnSync(process.execPath,['--input-type=module','-e',code,...args],{encoding:'utf8',windowsHide:true,timeout:15000});assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return result.stdout.trim();}

async function recoveryFixture(t){
 const f=await fixture(t);await f.modules();const evidence=path.join(f.root,'evidence');await ensure(f.root,evidence);
 const file=path.join(evidence,'provisioning.json'),input={workId:'synthetic-work',sourceRoot:f.source,worktreeRoot:f.target,frozenFiles:f.files};
 const open=async()=>{
  const io=createExperimentalExecutionWorkspaceIO(f.root);let value=await io.readJson(file)||{operations:{}};
  const journal={read:async key=>structuredClone(value.operations[key]??null),pending:async()=>structuredClone(Object.values(value.operations).filter(row=>row.phase!=='done')),write:async(key,row)=>{const next={operations:{...value.operations,[key]:row}};await io.writeJson(file,next);value=next;}};
  return {journal,run:({previous,...options}={})=>provision({...input,previous},{filesystem,journal,...options}),value:()=>structuredClone(value)};
 };
 const crash=(point,extra={})=>{
  const code=`import {provisionWorktreeDependencies as provision} from ${JSON.stringify(new URL('../src/agents/managed/worktree-dependencies.mjs',import.meta.url).href)};
   import {experimentalWindowsVersionedFilesystem as filesystem} from ${JSON.stringify(new URL('../src/platform/windows/experimental-filesystem.mjs',import.meta.url).href)};
   import {createExperimentalWindowsProvisioning} from ${JSON.stringify(new URL('../src/platform/windows/experimental-provisioning.mjs',import.meta.url).href)};
   import {createExperimentalExecutionWorkspaceIO} from ${JSON.stringify(new URL('../src/platform/windows/experimental-execution-workspace.mjs',import.meta.url).href)};
   import fs from 'node:fs';import path from 'node:path';
   const {root,file,input,point,extra}=JSON.parse(process.argv[1]),io=createExperimentalExecutionWorkspaceIO(root);let value=await io.readJson(file)||{operations:{}};
   const journal={read:async key=>value.operations[key]??null,write:async(key,row)=>{value={operations:{...value.operations,[key]:row}};await io.writeJson(file,value);}};
   const hooks={afterCheckpoint:fact=>{if(fact.phase===point)process.exit(83);},afterPublish:()=>{if(point==='after-publish')process.exit(83);},beforeCopyEntry:()=>{if(point==='partial-copy')process.exit(83);},beforePublish:()=>{if(extra.winner){fs.mkdirSync(path.join(input.worktreeRoot,'node_modules'));fs.writeFileSync(path.join(input.worktreeRoot,'node_modules/keep'),'foreign winner');}if(point==='before-move')process.exit(83);},afterCleanupEntry:relative=>{if(point==='cleanup-entry'&&relative===extra.relative)process.exit(83);}};
   await provision(input,{filesystem:{...filesystem,provisioning:createExperimentalWindowsProvisioning(hooks)},journal});`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code,JSON.stringify({root:f.root,file,input,point,extra})],{encoding:'utf8',windowsHide:true,timeout:30000});assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,83,result.stdout+result.stderr);
 };
 return {...f,file,input,open,crash};
}

test('public source native type observes ordinary ACLs and cannot borrow private mutators or acquire write authority',native,async t=>{
 const f=await fixture(t);await f.modules();const directory=f.hold(openExperimentalSourceDirectory(f.root,path.join(f.source,'node_modules'))),childDir=f.hold(directory.openDirectory('probe')),file=f.hold(childDir.openFile('index.mjs'));
 assert.equal(file.readAt(0,1000).toString(),'export const probe="source";\n');assert.equal(file.sync,undefined);assert.equal(file.remove,undefined);assert.equal(directory.createPrivateExclusive,undefined);
 const writer=f.hold(openExperimentalPersistenceParent(f.target,'writer-anchor'));
 for(const name of ['createPrivateExclusive','createPrivateDirectoryExclusive','beginPrivateDirectoryMove','openPrivateTreeFile','inspectEntry'])assert.throws(()=>writer[name].call(directory,'intruder'),{code:'FS_HANDLE_REJECTED'});
 directory.close();childDir.close();file.verify();assert.equal(child(`import fs from 'node:fs';let denied=0;for(const op of [()=>fs.writeFileSync(process.argv[1],'changed'),()=>fs.renameSync(process.argv[2],process.argv[2]+'-changed')])try{op();}catch{denied++;}console.log(denied);`,[path.join(f.source,'node_modules','probe','index.mjs'),path.join(f.source,'node_modules')]),'2');
 file.close();await fs.rename(path.join(f.source,'node_modules'),path.join(f.source,'released'));
});

test('public source tree copies ordinary nested ACLs, Unicode/empty directories and 33 MiB bytes into independent private objects',native,async t=>{
 const f=await fixture(t);await f.modules();await fs.mkdir(path.join(f.source,'node_modules','空目录'));const bytes=Buffer.alloc(33*1024*1024,0x64);await fs.writeFile(path.join(f.source,'node_modules','large.bin'),bytes);
 const before=security('inspect',path.join(f.source,'node_modules')),source=f.hold(await openExperimentalSourceTree(f.source,path.join(f.source,'node_modules')));
 assert.equal(source.publishTo,undefined);assert.equal(source.remove,undefined);assert.equal(source.sync,undefined);assert.equal(source.manifest.totalBytes,bytes.length+Buffer.byteLength('export const probe="source";\n'));
 const result=await source.copyTo(path.join(f.target,'copy'),{destinationRoot:f.target});assert.equal(result.state,'barriers-completed');assert.equal(result.durability,'namespace-not-qualified');assert.deepEqual(await fs.readFile(path.join(f.target,'copy','large.bin')),bytes);assert.deepEqual(security('inspect',path.join(f.source,'node_modules')),before);
 const captured=f.hold(await openExperimentalPrivateTree(f.target,path.join(f.target,'copy')));assert.equal(captured.manifest.entries.find(row=>row.relative==='large.bin').sha256,sha(bytes));captured.close();
 await fs.writeFile(path.join(f.target,'copy','probe','index.mjs'),'worker');assert.equal(await fs.readFile(path.join(f.source,'node_modules','probe','index.mjs'),'utf8'),'export const probe="source";\n');
});

test('public source membership and retained ancestor/file ACL changes invalidate the manifest without permission repair',native,async t=>{
 const f=await fixture(t);await f.modules();const source=f.hold(await openExperimentalSourceTree(f.source,path.join(f.source,'node_modules')));
 await fs.writeFile(path.join(f.source,'node_modules','late'),'external');await assert.rejects(source.verify(),{code:'FS_TREE_CHANGED'});await absent(path.join(f.target,'copy'));source.close();await fs.unlink(path.join(f.source,'node_modules','late'));
 const next=f.hold(await openExperimentalSourceTree(f.source,path.join(f.source,'node_modules')));security('add-write',path.join(f.source,'node_modules','probe','index.mjs'));const changed=security('inspect',path.join(f.source,'node_modules','probe','index.mjs'));await assert.rejects(next.verify(),{code:'FS_STAGE_CHANGED'});assert.deepEqual(security('inspect',path.join(f.source,'node_modules','probe','index.mjs')),changed);next.close();
 const ancestor=f.hold(await openExperimentalSourceTree(f.source,path.join(f.source,'node_modules')));security('add-write',f.source);await assert.rejects(ancestor.verify(),{code:'FS_STAGE_CHANGED'});
});

test('shared provisioning installs actual importable module copies, records barriers and preserves existing modules on repeat',native,async t=>{
 const f=await fixture(t);await f.modules();const result=await f.run({filesystem});assert.equal(entry(result).outcome,'provisioned',JSON.stringify(result));assert.equal(entry(result).files,1);assert.equal(entry(result).copy.durability,'namespace-not-qualified');
 assert.equal((await import(pathToFileURL(path.join(f.target,'node_modules','probe','index.mjs')).href)).probe,'source');assert.deepEqual(await fs.readdir(path.join(f.target,'.nozeli')),[]);
 await fs.writeFile(path.join(f.target,'node_modules','probe','index.mjs'),'worker winner');assert.equal(entry(await f.run({filesystem})).outcome,'present');assert.equal(await fs.readFile(path.join(f.target,'node_modules','probe','index.mjs'),'utf8'),'worker winner');assert.equal(await fs.readFile(path.join(f.source,'node_modules','probe','index.mjs'),'utf8'),'export const probe="source";\n');
});

test('shared frozen manifest/lock policy rejects source and Worker drift and reports missing payload without creating a wrapper',native,async t=>{
 const f=await fixture(t);assert.equal(entry(await f.run({filesystem})).outcome,'source-modules-missing');await absent(path.join(f.target,'.nozeli'));await f.modules();
 await fs.writeFile(path.join(f.source,'package-lock.json'),'source drift');assert.equal(entry(await f.run({filesystem})).outcome,'source-lock-differs');await absent(path.join(f.target,'node_modules'));
 await fs.writeFile(path.join(f.source,'package-lock.json'),lock);await fs.writeFile(path.join(f.target,'package.json'),'worker drift');assert.equal(entry(await f.run({filesystem})).outcome,'worker-file-changed');await absent(path.join(f.target,'.nozeli'));
});

test('existing target directories/files/junctions are observed without following, replacing or privatizing them',native,async t=>{
 const f=await fixture(t);await f.modules();await fs.writeFile(path.join(f.target,'node_modules'),'file winner');assert.equal(entry(await f.run({filesystem})).outcome,'target-not-directory');assert.equal(await fs.readFile(path.join(f.target,'node_modules'),'utf8'),'file winner');await fs.unlink(path.join(f.target,'node_modules'));
 const outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'keep'),'external');await fs.symlink(outside,path.join(f.target,'node_modules'),'junction');assert.equal(entry(await f.run({filesystem})).outcome,'target-symlink');assert.equal(await fs.readFile(path.join(outside,'keep'),'utf8'),'external');assert.equal((await fs.lstat(path.join(f.target,'node_modules'))).isSymbolicLink(),true);
});

test('unqualified source junctions/hardlinks and a linked staging wrapper refuse before payload publication',native,async t=>{
 const f=await fixture(t);await f.modules();await fs.mkdir(path.join(f.root,'outside'));await fs.symlink(path.join(f.root,'outside'),path.join(f.source,'node_modules','link'),'junction');assert.equal(entry(await f.run({filesystem})).outcome,'unsupported-source');await absent(path.join(f.target,'.nozeli'));await fs.unlink(path.join(f.source,'node_modules','link'));
 await fs.link(path.join(f.source,'node_modules','probe','index.mjs'),path.join(f.root,'alias'));assert.equal(entry(await f.run({filesystem})).outcome,'unsupported-source');await fs.unlink(path.join(f.root,'alias'));
 await fs.symlink(path.join(f.root,'outside'),path.join(f.target,'.nozeli'),'junction');assert.equal(entry(await f.run({filesystem})).outcome,'unsafe-target-path');assert.deepEqual(await fs.readdir(path.join(f.root,'outside')),[]);
});

test('source additions during real copying invalidate the shared gate and retain partial allocations for explicit recovery',native,async t=>{
 const f=await fixture(t);await f.modules();let added=false;
 const result=await f.run(injected({beforeCopyEntry:async()=>{if(!added){added=true;await fs.writeFile(path.join(f.source,'node_modules','late'),'external source winner');}}}));
 assert.equal(entry(result).outcome,'copy-result-unknown',JSON.stringify(result));assert.equal(entry(result).reason,'FS_TREE_CHANGED');assert.ok(entry(result).copy.partialCopy.createdCount>0);await absent(path.join(f.target,'node_modules'));assert.equal(await fs.readFile(path.join(f.source,'node_modules','late'),'utf8'),'external source winner');
 assert.equal((await fs.readdir(path.join(f.target,'.nozeli'))).length,1,'partial copy remains for explicit recovery');
 const cold=await f.run({filesystem});assert.equal(entry(cold).outcome,'copy-result-unknown');assert.equal(entry(cold).reason,'DEPENDENCY_RECOVERY_REQUIRED');assert.equal((await fs.readdir(path.join(f.target,'.nozeli'))).length,1,'even a caller missing the previous report cannot allocate a second matching stage');
});

test('late target winners survive the actual no-replace publication and the original staging copy is safely removed',native,async t=>{
 const f=await fixture(t);await f.modules();const result=await f.run(injected({beforePublish:async()=>{await fs.mkdir(path.join(f.target,'node_modules'));await fs.writeFile(path.join(f.target,'node_modules','keep'),'late winner');}}));
 assert.equal(entry(result).outcome,'present',JSON.stringify(result));assert.equal(entry(result).reason,'appeared-during-copy');assert.equal(await fs.readFile(path.join(f.target,'node_modules','keep'),'utf8'),'late winner');assert.deepEqual(await fs.readdir(path.join(f.target,'.nozeli')),[]);
});

test('real publication followed by a lost callback retains UNKNOWN facts and a normal retry never repeats the effect',native,async t=>{
 const f=await fixture(t);await f.modules();let moves=0;const result=await f.run(injected({afterPublish:()=>{moves++;throw Error('synthetic lost publication callback');}}));
 assert.equal(entry(result).outcome,'copy-result-unknown',JSON.stringify(result));assert.equal(entry(result).copy.publication.moved,true);assert.equal(moves,1);assert.equal(await fs.readFile(path.join(f.target,'node_modules','probe','index.mjs'),'utf8'),'export const probe="source";\n');
 const held=await provision({workId:'synthetic-work',sourceRoot:f.source,worktreeRoot:f.target,frozenFiles:f.files,previous:result},injected({beforePublish:()=>{moves++;}}));assert.equal(held,result);assert.equal(entry(held).outcome,'copy-result-unknown');assert.equal(moves,1);
});

test('a foreign staging addition during cleanup is retained alongside the winner and is never deleted on retry',native,async t=>{
 const f=await fixture(t);await f.modules();let retained;
 const result=await f.run(injected({beforeCleanup:async fact=>{retained=path.join(fact.stage,'foreign');await fs.writeFile(retained,'external staging winner');}}));
 assert.equal(entry(result).outcome,'provisioned');assert.equal(entry(result).cleanup.state,'retained');assert.equal(await fs.readFile(retained,'utf8'),'external staging winner');assert.equal(entry(await f.run({filesystem})).outcome,'present');assert.equal(await fs.readFile(retained,'utf8'),'external staging winner');
});

test('retained source and Worker gate HANDLEs deny independent writers throughout actual copying and release afterward',native,async t=>{
 const f=await fixture(t);await f.modules();let checked=false;
 const result=await f.run(injected({beforeCopyEntry:()=>{if(checked)return;checked=true;assert.equal(child(`import fs from 'node:fs';let denied=0;for(const file of process.argv.slice(1))try{fs.writeFileSync(file,'external');}catch{denied++;}console.log(denied);`,[path.join(f.source,'package-lock.json'),path.join(f.target,'package.json'),path.join(f.source,'node_modules/probe/index.mjs')]),'3');}}));
 assert.equal(entry(result).outcome,'provisioned');assert.ok(checked);await fs.writeFile(path.join(f.target,'package.json'),'external after close');assert.equal(await fs.readFile(path.join(f.target,'package.json'),'utf8'),'external after close');
});

test('a source membership change immediately before publication is refused and only the exact staged copy is removed',native,async t=>{
 const f=await fixture(t);await f.modules();const result=await f.run(injected({beforePublish:()=>fs.writeFile(path.join(f.source,'node_modules/late'),'late source winner')}));
 assert.equal(entry(result).outcome,'copy-failed',JSON.stringify(result));assert.equal(entry(result).reason,'DEPENDENCY_SOURCE_CHANGED');await absent(path.join(f.target,'node_modules'));assert.deepEqual(await fs.readdir(path.join(f.target,'.nozeli')),[]);assert.equal(await fs.readFile(path.join(f.source,'node_modules/late'),'utf8'),'late source winner');
});

test('an actual provisioning host exits mid-copy and a cold caller preserves its marked stage without starting a second copy',native,async t=>{
 const f=await fixture(t);await f.modules();
 const code=`import {provisionWorktreeDependencies as provision} from ${JSON.stringify(new URL('../src/agents/managed/worktree-dependencies.mjs',import.meta.url).href)};
 import {experimentalWindowsVersionedFilesystem as filesystem} from ${JSON.stringify(new URL('../src/platform/windows/experimental-filesystem.mjs',import.meta.url).href)};
 import {createExperimentalWindowsProvisioning} from ${JSON.stringify(new URL('../src/platform/windows/experimental-provisioning.mjs',import.meta.url).href)};
 const input=JSON.parse(process.argv[1]);await provision(input,{filesystem:{...filesystem,provisioning:createExperimentalWindowsProvisioning({beforeCopyEntry:()=>process.exit(83)})}});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,JSON.stringify({workId:'synthetic-work',sourceRoot:f.source,worktreeRoot:f.target,frozenFiles:f.files})],{encoding:'utf8',windowsHide:true,timeout:30000});assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,83,child.stdout+child.stderr);
 const before=await fs.readdir(path.join(f.target,'.nozeli'));assert.equal(before.length,1);const marker=await fs.readFile(path.join(f.target,'.nozeli',before[0],'staging.json'));
 const result=await f.run({filesystem});assert.equal(entry(result).outcome,'copy-result-unknown');assert.equal(entry(result).reason,'DEPENDENCY_RECOVERY_REQUIRED');assert.deepEqual(await fs.readdir(path.join(f.target,'.nozeli')),before);assert.deepEqual(await fs.readFile(path.join(f.target,'.nozeli',before[0],'staging.json')),marker);await absent(path.join(f.target,'node_modules'));assert.equal(await fs.readFile(path.join(f.source,'node_modules/probe/index.mjs'),'utf8'),'export const probe="source";\n');
});

test('a real copied-file edit during the NTFS descendant release window yields UNKNOWN and preserves the published bytes',native,async t=>{
 const f=await fixture(t);await f.modules();const result=await f.run(injected({beforePublish:fact=>fs.writeFile(path.join(fact.stage,'node_modules/probe/index.mjs'),'independent release-window winner')}));
 assert.equal(entry(result).outcome,'copy-result-unknown',JSON.stringify(result));assert.equal(entry(result).copy.publication.moved,true);assert.equal(await fs.readFile(path.join(f.target,'node_modules/probe/index.mjs'),'utf8'),'independent release-window winner');
 const held=await provision({workId:'synthetic-work',sourceRoot:f.source,worktreeRoot:f.target,frozenFiles:f.files,previous:result},{filesystem});assert.equal(held,result);
});

test('a declared resource target ancestor junction refuses without touching the external directory',native,async t=>{
 const f=await fixture(t);await f.gate('vendor/prepared-resources.json','{"version":1,"resources":[{"path":"vendor/engine/dist"}]}');await fs.mkdir(path.join(f.source,'vendor/engine/dist'),{recursive:true});await fs.writeFile(path.join(f.source,'vendor/engine/dist/content'),'source');const outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'keep'),'external');await fs.symlink(outside,path.join(f.target,'vendor/engine'),'junction');
 const result=await f.run({filesystem}),resource=result.entries.find(row=>row.kind==='prepared-resource');assert.equal(resource.outcome,'unsafe-target-path',JSON.stringify(result));assert.deepEqual(await fs.readdir(outside),['keep']);assert.equal(await fs.readFile(path.join(outside,'keep'),'utf8'),'external');
});

test('root/nested prepared resources reuse shared metadata validation, provenance and frozen byte gates',native,async t=>{
 const f=await fixture(t);await f.gate('apps/desktop/package.json',manifest);await f.gate('apps/desktop/package-lock.json',lock);
 await f.modules();await f.modules(path.join(f.source,'apps/desktop'),'nested');
 for(const base of ['', 'apps/desktop/']){
  const declaration=base+'vendor/prepared-resources.json',resource=base+'vendor/engine/dist';
  await f.gate(declaration,JSON.stringify({version:1,resources:[{path:'vendor/engine/dist',tool:'tools/prepare.mjs',upstream:{revision:'synthetic-rev',sha256:'f'.repeat(64)}}]})+'\n');
  await fs.mkdir(path.join(f.source,resource),{recursive:true});await fs.writeFile(path.join(f.source,resource,'index.html'),'prepared '+base);
  await fs.mkdir(path.join(f.target,base,'vendor','engine'),{recursive:true});
 }
 const result=await f.run({filesystem}),resources=result.entries.filter(row=>row.kind==='prepared-resource');assert.equal(result.entries.length,4);assert.equal(resources.length,2);assert.ok(result.entries.every(row=>row.outcome==='provisioned'),JSON.stringify(result));assert.equal(resources[1].provenance.tool,'apps/desktop/tools/prepare.mjs');assert.equal(await fs.readFile(path.join(f.target,'apps/desktop/vendor/engine/dist/index.html'),'utf8'),'prepared apps/desktop/');assert.equal((await import(pathToFileURL(path.join(f.target,'apps/desktop/node_modules/probe/index.mjs')).href)).probe,'nested');
 await fs.writeFile(path.join(f.target,'vendor/prepared-resources.json'),'invalid drift');const repeated=await f.run({filesystem});assert.equal(repeated.entries.find(row=>row.kind==='prepared-resource').outcome,'worker-file-changed');
});

test('invalid frozen resource declarations and tracked resources follow shared policy without creating payload copies',native,async t=>{
 const f=await fixture(t);await f.gate('vendor/prepared-resources.json','{"version":1,"resources":[{"path":"../escape"}]}');let result=await f.run({filesystem});assert.equal(result.entries.find(row=>row.kind==='prepared-resource').outcome,'invalid-metadata');
 await f.gate('vendor/prepared-resources.json','{"version":1,"resources":[{"path":"vendor/engine/dist"}]}');await fs.mkdir(path.join(f.target,'vendor/engine'),{recursive:true});f.files['vendor/engine/dist']={digest:sha('tracked')};result=await f.run({filesystem});assert.equal(result.entries.find(row=>row.kind==='prepared-resource').reason,'tracked');await absent(path.join(f.target,'vendor/engine/dist'));
});

test('actual shared Work prepare supplies dependencies/resources, imports them and excludes both payloads from a real published Git candidate',native,async t=>{
 const f=await fixture(t);await f.modules();await f.gate('vendor/prepared-resources.json','{"version":1,"resources":[{"path":"vendor/engine/dist"}]}');await fs.mkdir(path.join(f.source,'vendor/engine/dist'),{recursive:true});await fs.writeFile(path.join(f.source,'vendor/engine/dist/index.html'),'prepared');await fs.writeFile(path.join(f.source,'vendor/engine/README.md'),'frozen parent');
 await fs.writeFile(path.join(f.source,'.gitignore'),'node_modules/\n.nozeli/\ndist/\n');await fs.writeFile(path.join(f.source,'正文.md'),'baseline');
 await git(f.source,['init','--initial-branch=main']);await git(f.source,['config','core.autocrlf','false']);await git(f.source,['add','.']);const tree=await str(f.source,['write-tree']),commit=await commitTree(f.source,tree,[],'synthetic provision baseline',path.join(f.root,'seed'));await git(f.source,['update-ref','refs/heads/main',commit,'0'.repeat(commit.length)]);
 const storage=f.hold(new ProjectStorage(path.join(f.root,'profile'),{experimentalWindowsRoot:f.root,experimentalWindowsInitialization:true})),project=await storage.register(f.source),runtime=path.join(f.root,'runtime');await ensure(f.root,runtime);
 let lost=false;
 const work={id:'synthetic-work',revision:1,result:{objectId:'synthetic-report'}},store={root:runtime,content:f.source,storage,projectId:project.id,state:{works:[work]}},execution=new ExecutionWorkspace(store,{...injected({afterPublish:()=>{if(!lost){lost=true;throw Error('synthetic Work publication response lost');}}}),experimentalWindowsRoot:f.root});
 const interrupted=await execution.prepare(work.id);assert.equal(interrupted.dependencies.entries[0].outcome,'copy-result-unknown');assert.equal(Object.values(interrupted.provisioning.operations).find(row=>row.binding.kind==='dependencies').phase,'published');
 const recovery=new ExecutionWorkspace(store,{filesystem,experimentalWindowsRoot:f.root}),[reconciled,repeat]=await Promise.all([recovery.reconcileDependencies(work.id),recovery.reconcileDependencies(work.id)]);assert.equal(reconciled.entries[0].outcome,'provisioned',JSON.stringify(reconciled));assert.equal(reconciled.entries[1].outcome,'present','already completed resource remains an ordinary existing target');assert.ok(repeat.entries.every(row=>row.outcome==='present'),'concurrent explicit calls serialize without another effect');
 const prepared=await recovery.readManifest(work.id);assert.ok(prepared.dependencies.entries.every(row=>row.outcome==='present'),JSON.stringify(prepared.dependencies));assert.equal((await import(pathToFileURL(path.join(prepared.directory,'node_modules/probe/index.mjs')).href)).probe,'source');assert.equal(await fs.readFile(path.join(prepared.directory,'vendor/engine/dist/index.html'),'utf8'),'prepared');
 assert.equal(Object.values(prepared.provisioning.operations).length,2);assert.ok(Object.values(prepared.provisioning.operations).every(row=>row.phase==='done'&&row.effect.payloadManifest.sha256));
 await fs.writeFile(path.join(prepared.directory,'正文.md'),'worker content');await fs.writeFile(path.join(prepared.directory,'node_modules/probe/index.mjs'),'worker-only dependency change');await fs.writeFile(path.join(prepared.directory,'vendor/engine/dist/index.html'),'worker-only resource change');
 const published=await recovery.publish(work,{id:'job'},()=>true);assert.deepEqual(published.candidate.files,['正文.md']);assert.equal(await fs.readFile(path.join(f.source,'vendor/engine/dist/index.html'),'utf8'),'prepared');assert.equal(await fs.readFile(path.join(f.source,'正文.md'),'utf8'),'baseline');
 const cold=new ExecutionWorkspace(store,{filesystem,experimentalWindowsRoot:f.root});assert.equal((await cold.prepare(work.id)).dependencies.entries[0].outcome,'present');assert.equal(await fs.readFile(path.join(prepared.directory,'node_modules/probe/index.mjs'),'utf8'),'worker-only dependency change');
});

for(const point of ['copied','before-move','after-publish'])test(`durable original copy reconciles a real host exit at ${point} without another allocation or duplicate move`,native,async t=>{
 const f=await recoveryFixture(t);f.crash(point);const cold=await f.open(),original=Object.values(cold.value().operations)[0],stageName=original.effect.name;
 const held=await cold.run();assert.equal(entry(held).outcome,'copy-result-unknown');assert.equal(entry(held).reason,'DEPENDENCY_RECOVERY_REQUIRED');
 let allocations=0,moves=0;const resumed=await cold.run({previous:held,reconcile:true,...injected({beforeCopyEntry:()=>allocations++,beforePublish:()=>moves++})});
 assert.equal(entry(resumed).outcome,'provisioned',JSON.stringify(resumed));assert.equal(allocations,0);assert.equal(moves,point==='after-publish'?0:1);
 assert.equal(Object.values(cold.value().operations)[0].effect.name,stageName);assert.equal(Object.values(cold.value().operations)[0].phase,'done');assert.deepEqual(await fs.readdir(path.join(f.target,'.nozeli')),[]);
 assert.equal(await fs.readFile(path.join(f.target,'node_modules/probe/index.mjs'),'utf8'),'export const probe="source";\n');
});

for(const relative of ['staging.json',''])test(`durable exact cleanup reconciles a real host exit after deleting ${relative||'the stage root'}`,native,async t=>{
 const f=await recoveryFixture(t);f.crash('cleanup-entry',{relative});const cold=await f.open(),record=Object.values(cold.value().operations)[0];
 assert.equal(record.phase,'cleaning');assert.equal(record.effect.cleanup.pending,relative);
 const result=await cold.run({reconcile:true,...injected({beforeCopyEntry:()=>assert.fail('must not recopy'),beforePublish:()=>assert.fail('must not republish')})});
 assert.equal(entry(result).outcome,'provisioned',JSON.stringify(result));assert.equal(Object.values(cold.value().operations)[0].phase,'done');assert.deepEqual(await fs.readdir(path.join(f.target,'.nozeli')),[]);
});

test('durable complete copy preserves a late independent winner and reconciles interrupted cleanup of only original allocations',native,async t=>{
 const f=await recoveryFixture(t);f.crash('cleanup-entry',{relative:'staging.json',winner:true});const cold=await f.open();
 const result=await cold.run({reconcile:true});assert.equal(entry(result).outcome,'present',JSON.stringify(result));assert.equal(await fs.readFile(path.join(f.target,'node_modules/keep'),'utf8'),'foreign winner');assert.deepEqual(await fs.readdir(path.join(f.target,'.nozeli')),[]);
});

test('cold recovery rejects changed bytes, same-byte replacement IDs, added members and binding drift without deleting winners',native,async t=>{
 for(const change of ['bytes','identity','addition','binding']){
  const f=await recoveryFixture(t);f.crash('after-publish');const file=path.join(f.target,'node_modules/probe/index.mjs'),original=await fs.readFile(file);
  if(change==='bytes')await fs.writeFile(file,'foreign bytes');
  if(change==='identity'){await fs.rename(file,file+'.original');await fs.writeFile(file,original);}
  if(change==='addition')await fs.writeFile(path.join(f.target,'node_modules/foreign'),'foreign member');
  const cold=await f.open();let result;
  if(change==='binding'){const altered=structuredClone(f.input);altered.frozenFiles['package.json'].digest='f'.repeat(64);result=await provision(altered,{filesystem,journal:cold.journal,reconcile:true});}
  else result=await cold.run({reconcile:true});
  assert.equal(entry(result).outcome,'copy-result-unknown',change+JSON.stringify(result));assert.notEqual(Object.values(cold.value().operations)[0].phase,'done');assert.equal((await fs.readdir(path.join(f.target,'.nozeli'))).length,1);
  assert.deepEqual(await fs.readFile(file),change==='bytes'?Buffer.from('foreign bytes'):original);
 }
});

test('partial-copy cold exit stays UNKNOWN even with its intent and cannot allocate another stage',native,async t=>{
 const f=await recoveryFixture(t);f.crash('partial-copy');const cold=await f.open(),before=await fs.readdir(path.join(f.target,'.nozeli'));
 const result=await cold.run({reconcile:true,...injected({beforeCopyEntry:()=>assert.fail('must not recopy')})});assert.equal(entry(result).outcome,'copy-result-unknown');assert.equal(entry(result).reason,'DEPENDENCY_RECOVERY_REQUIRED');assert.deepEqual(await fs.readdir(path.join(f.target,'.nozeli')),before);await absent(path.join(f.target,'node_modules'));
});

test('unacknowledged durable checkpoint fences publication, cleanup and the next payload, including a commit with a lost response',native,async t=>{
 for(const committed of [false,true]){
  const f=await recoveryFixture(t);await f.gate('vendor/prepared-resources.json','{"version":1,"resources":[{"path":"vendor/engine/dist"}]}');await fs.mkdir(path.join(f.source,'vendor/engine/dist'),{recursive:true});await fs.writeFile(path.join(f.source,'vendor/engine/dist/content'),'prepared');await fs.mkdir(path.join(f.target,'vendor/engine'),{recursive:true});
  const first=await f.open();let moves=0;
  const journal={read:first.journal.read,write:async(key,row)=>{if(row.phase==='copied'){if(committed)await first.journal.write(key,row);throw Object.assign(Error('synthetic checkpoint response lost'),{committed});}await first.journal.write(key,row);}};
  await assert.rejects(first.run({journal,...injected({beforePublish:()=>moves++})}),{code:'DEPENDENCY_CHECKPOINT_UNKNOWN'});assert.equal(moves,0);await absent(path.join(f.target,'node_modules'));await absent(path.join(f.target,'vendor/engine/.nozeli'));assert.equal((await fs.readdir(path.join(f.target,'.nozeli'))).length,1);
  const cold=await f.open(),result=await cold.run({reconcile:true});assert.equal(entry(result).outcome,committed?'provisioned':'copy-result-unknown',JSON.stringify(result));
 }
});

test('cold copied intent refuses source/gate drift and replacement staging parents without touching the original copy',native,async t=>{
 for(const change of ['source','gate','wrapper','resource-metadata']){
  const f=await recoveryFixture(t);let staging=path.join(f.target,'.nozeli');
  if(change==='resource-metadata'){
   delete f.files['package.json'];delete f.files['package-lock.json'];await f.gate('vendor/prepared-resources.json','{"version":1,"resources":[{"path":"vendor/engine/dist"}]}');await fs.mkdir(path.join(f.source,'vendor/engine/dist'),{recursive:true});await fs.writeFile(path.join(f.source,'vendor/engine/dist/content'),'prepared');await fs.mkdir(path.join(f.target,'vendor/engine'),{recursive:true});staging=path.join(f.target,'vendor/engine/.nozeli');
  }
  f.crash('copied');const names=await fs.readdir(staging);
  if(change==='source')await fs.writeFile(path.join(f.source,'node_modules/probe/index.mjs'),'source changed');
  if(change==='gate')await fs.writeFile(path.join(f.target,'package-lock.json'),'worker gate changed');
  if(change==='wrapper'){await fs.rename(path.join(f.target,'.nozeli'),path.join(f.target,'original-wrapper'));await ensure(f.root,path.join(f.target,'.nozeli'));}
  if(change==='resource-metadata')await fs.writeFile(path.join(f.source,'vendor/prepared-resources.json'),'{"version":1,"resources":[]}');
  const cold=await f.open(),result=await cold.run({reconcile:true});assert.ok(result.entries.some(row=>row.outcome==='copy-result-unknown'),JSON.stringify(result));assert.notEqual(Object.values(cold.value().operations)[0].phase,'done');await absent(path.join(f.target,'node_modules'));
  assert.deepEqual(await fs.readdir(change==='wrapper'?path.join(f.target,'original-wrapper'):staging),names);
  if(change==='resource-metadata'){const held=await cold.run({previous:result});assert.equal(held,result,'changed declarations cannot erase the prior UNKNOWN');}
 }
});

test('cold cleanup refuses new staging members after an interrupted original deletion',native,async t=>{
 const f=await recoveryFixture(t);f.crash('cleanup-entry',{relative:'staging.json'});const cold=await f.open(),record=Object.values(cold.value().operations)[0],stage=path.join(f.target,'.nozeli',record.effect.name);await fs.writeFile(path.join(stage,'foreign'),'foreign cleanup winner');
 const result=await cold.run({reconcile:true});assert.equal(entry(result).outcome,'copy-result-unknown');assert.equal(await fs.readFile(path.join(stage,'foreign'),'utf8'),'foreign cleanup winner');assert.equal(Object.values(cold.value().operations)[0].phase,'cleaning');
});
