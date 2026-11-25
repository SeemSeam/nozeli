import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {DesktopHost} from '../src/main/host.mjs';
import {FileTreeOps} from '../src/main/file-tree-ops.mjs';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';
import {createFileTreeIO} from '../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../src/platform/windows/desktop-file-tree.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {openExperimentalSourceDirectory} from '../src/platform/windows/experimental-source-directory.mjs';
import {createRequire} from 'node:module';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'},bridge=createRequire(import.meta.url)('../native/windows/build/Release/nozeli_windows_read.node');
async function recoveryRows(storage,id){const rows=[];for await(const row of storage.recoveryRecords(id,{prefixes:['tree-operation:']}))rows.push(row);return rows;}
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-tree-create-')),profile=path.join(base,'profile'),root=path.join(base,'项目 空格'),hosts=[];
 await ensureExperimentalPrivateDirectory(base,profile);await fs.mkdir(root);
 t.after(async()=>{for(const host of hosts)await host.storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 const make=()=>{const host=new DesktopHost(profile);hosts.push(host);return host;},host=make(),picked=(await host.pick(root)).project,project=await host.requireProject(picked.id);
 const ops=(io)=>new FileTreeOps(host,{trash:()=>{throw Error('Trash must stay unsupported');},...(io?{io}:{})});
 return {base,profile,root,host,project,make,ops,run:(action,name,target='')=>ops().run({projectId:project.id,action,name,target})};
}
function independent(code,args){const child=spawnSync(process.execPath,['--input-type=module','-e',code,...args],{env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},encoding:'utf8',windowsHide:true,timeout:10000});assert.ifError(child.error);assert.equal(child.signal,null);return child;}
test('shared tree creates inherited public folders and empty files; native save/history survive cold reopen',native,async t=>{
 const f=await fixture(t);await f.host.storage.db.close();security('broad-parent',f.root);const host=f.make(),project=await host.requireProject(f.project.id),ops=new FileTreeOps(host,{trash:()=>{}});
 const folder=await ops.run({projectId:project.id,action:'createFolder',name:'新建 资料'});assert.equal(folder.creation.published,true);assert.equal(folder.creation.state,'barriers-completed');
 const file=await ops.run({projectId:project.id,action:'createFile',target:folder.relPath,name:'阅读 中文.txt'});assert.equal((await fs.readFile(path.join(f.root,file.relPath))).length,0);
 for(const rel of [folder.relPath,file.relPath]){const acl=security('inspect',path.join(f.root,rel));assert.equal(acl.protected,false);assert(acl.rules.some(rule=>rule.sid==='S-1-1-0'&&rule.inherited));}
 const read=await host.readFile(project.id,file.relPath);await host.draft(project.id,file.relPath,read.digest,'新文件正文\n');await host.save(project.id,file.relPath,read.digest,'新文件正文\n');await host.storage.db.close();const cold=f.make();assert.equal((await cold.readFile(project.id,file.relPath)).text,'新文件正文\n');
 const rows=(await recoveryRows(cold.storage,project.id)).filter(row=>row.value.creation===true);assert.equal(rows.length,2);assert(rows.every(row=>row.value.phase==='complete'&&row.value.effect.identity));
});
test('file/folder collisions and Windows case aliases preserve independent existing winners',native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'Winner.txt'),'external winner');await fs.mkdir(path.join(f.root,'Existing'));
 for(const [action,name]of [['createFile','winner.TXT'],['createFolder','WINNER.txt'],['createFile','existing'],['createFolder','EXISTING']])await assert.rejects(f.run(action,name));
 assert.equal(await fs.readFile(path.join(f.root,'Winner.txt'),'utf8'),'external winner');assert((await fs.stat(path.join(f.root,'Existing'))).isDirectory());assert((await recoveryRows(f.host.storage,f.project.id)).filter(row=>row.value.creation).every(row=>row.value.phase==='refused'));
});
test('name/path validation and junction parents refuse before outside effects',native,async t=>{
 const f=await fixture(t),outside=path.join(f.base,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(f.root,'link'),'junction');
 for(const name of ['../escape','CON.txt','bad.','.nozeli','x'.repeat(256)])await assert.rejects(f.run('createFile',name));
 await assert.rejects(f.run('createFile','outside.txt','link'));await assert.rejects(f.run('createFolder','escape','../outside'));assert.deepEqual(await fs.readdir(outside),[]);
});
test('read-only public source native receiver cannot borrow public allocation methods',native,async t=>{
 const f=await fixture(t),parent=bridge.openAnchoredPublicMutationParent(f.root,'anchor');parent.close();const source=openExperimentalSourceDirectory(f.base,f.root);
 try{for(const name of ['createPublicExclusive','createPublicDirectoryExclusive'])assert.throws(()=>parent[name].call(source,'forbidden'),{code:'FS_HANDLE_REJECTED'});}finally{source.close();parent.close();}
 await assert.rejects(fs.stat(path.join(f.root,'forbidden')),{code:'ENOENT'});
});
test('fixed parent blocks independent directory replacement during actual file publication',native,async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.root,'parent'));let attempted=false;
 const io={...createFileTreeIO(f.host),...createWindowsDesktopFileTreeIO(f.host,{beforePublish:async()=>{const child=independent("import fs from 'node:fs';try{fs.renameSync(process.argv[1],process.argv[1]+'-replaced');}catch(error){console.log(error.code);process.exitCode=7;}",[path.join(f.root,'parent')]);assert.equal(child.status,7,child.stderr);attempted=true;}})};
 await f.ops(io).run({projectId:f.project.id,action:'createFile',target:'parent',name:'pinned.txt'});assert(attempted);assert.equal((await fs.readFile(path.join(f.root,'parent/pinned.txt'))).length,0);await assert.rejects(fs.stat(path.join(f.root,'parent-replaced')),{code:'ENOENT'});
});
test('native parent ACL drift refuses file publication and retains the changed external policy',native,async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.root,'parent'));const io=createWindowsDesktopFileTreeIO(f.host,{beforePublish:async()=>security('add-write',path.join(f.root,'parent'))});
 await assert.rejects(io.createEntry(f.project,'parent/refused.txt',{kind:'file',operationId:randomUUID()}),error=>error.code==='FS_STAGE_CHANGED');await assert.rejects(fs.stat(path.join(f.root,'parent/refused.txt')),{code:'ENOENT'});assert(security('inspect',path.join(f.root,'parent')).rules.some(rule=>rule.sid==='S-1-1-0'));
});
for(const [kind,action]of [['file','createFile'],['directory','createFolder']])test(kind+' actual post-publication barrier failure preserves original identity and blocks cold retry',native,async t=>{
 const f=await fixture(t);let once=false;
 const io={...createFileTreeIO(f.host),...createWindowsDesktopFileTreeIO(f.host,{directorySync:parent=>{if(!once){once=true;parent.close();}parent.syncDirectory();}})};
 let failure;await assert.rejects(f.ops(io).run({projectId:f.project.id,action,name:'uncertain'}),error=>{failure=error;return error.committed===true&&error.details.committed===true&&error.durability==='uncertain';});
 const stat=await fs.stat(path.join(f.root,'uncertain'));assert.equal(stat.isDirectory(),kind==='directory');const row=await f.host.storage.getRecovery(f.project.id,failure.details.recoveryKey);assert.equal(row.phase,'needs-attention');assert.equal(row.effect.published,true);assert(row.effect.identity);
 await f.host.storage.db.close();const cold=f.make(),ops=new FileTreeOps(cold,{trash:()=>{}});await assert.rejects(ops.run({projectId:f.project.id,action,name:'UNCERTAIN'}),{code:'TREE_RECOVERY_REQUIRED'});assert.deepEqual(await fs.readdir(f.root).then(rows=>rows.filter(name=>name.toLowerCase()==='uncertain')),['uncertain']);
});
test('directory is retained when the prepared-journal callback fails after actual exclusive allocation',native,async t=>{
 const f=await fixture(t),io=createWindowsDesktopFileTreeIO(f.host);let identity;
 await assert.rejects(io.createEntry(f.project,'retained',{kind:'directory',operationId:randomUUID(),onPrepared:async facts=>{identity=facts.identity;throw Object.assign(Error('Synthetic lost journal acknowledgement'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:true});}}),error=>error.committed===true&&error.commitUnknown===true&&error.treeCreation.identity===identity);
 assert((await fs.stat(path.join(f.root,'retained'))).isDirectory());
});
test('late external target winner survives native no-replace file publication',native,async t=>{
 const f=await fixture(t),io=createWindowsDesktopFileTreeIO(f.host,{beforePublish:async()=>{const child=independent("import fs from 'node:fs';fs.writeFileSync(process.argv[1],'late winner',{flag:'wx'});",[path.join(f.root,'late.txt')]);assert.equal(child.status,0,child.stderr);}});
 await assert.rejects(io.createEntry(f.project,'late.txt',{kind:'file',operationId:randomUUID()}),error=>error.committed!==true);assert.equal(await fs.readFile(path.join(f.root,'late.txt'),'utf8'),'late winner');assert(!(await fs.readdir(f.root)).some(name=>name.endsWith('.pending')));
});
test('independent native publishers produce one exclusive winner without replacing or merging',native,async t=>{
 const f=await fixture(t),module=new URL('../src/platform/windows/desktop-file-tree.mjs',import.meta.url).href;
 const code=`import {createWindowsDesktopFileTreeIO} from ${JSON.stringify(module)};import {randomUUID} from 'node:crypto';const host={storage:{nativeRootForPath(){}}};try{const value=await createWindowsDesktopFileTreeIO(host).createEntry({root:process.argv[1]},'race',{kind:process.argv[2],operationId:randomUUID()});console.log(JSON.stringify(value));}catch(error){console.error(error.code);process.exitCode=7;}`;
 for(const kind of ['file','directory']){
  const runs=await Promise.all([1,2].map(()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code,f.root,kind],{env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',chunk=>stdout+=chunk);p.stderr.on('data',chunk=>stderr+=chunk);p.once('error',reject);p.once('exit',(status,signal)=>resolve({status,signal,stdout,stderr}));})));assert.deepEqual(runs.map(run=>run.status).sort(),[0,7]);assert(runs.every(run=>run.signal===null));assert((await fs.stat(path.join(f.root,'race'))).isDirectory()===(kind==='directory'));await fs.rm(path.join(f.root,'race'),{recursive:true});
 }
});
test('unacknowledged completion keeps the created file and original terminal receipt without overwriting it after a stale CAS',native,async t=>{
 const f=await fixture(t),put=f.host.storage.putRecovery.bind(f.host.storage);let failed=false;f.host.storage.putRecovery=async(id,key,value,options)=>{const result=await put(id,key,value,options);if(!failed&&value?.creation&&value.phase==='complete'){failed=true;throw Object.assign(Error('Synthetic lost completion acknowledgement'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:true});}return result;};
 await assert.rejects(f.run('createFile','completed.txt'),error=>error.committed===true&&error.details.commitUnknown===true&&Boolean(error.journalError));
 assert.equal((await fs.readFile(path.join(f.root,'completed.txt'))).length,0);
 const rows=(await recoveryRows(f.host.storage,f.project.id)).filter(row=>row.value.creation);
 assert.equal(rows.length,1);assert.equal(rows[0].value.phase,'complete');assert.equal(rows[0].value.effect.published,true);
 assert.equal(rows[0].value.destination,'completed.txt');assert.equal(failed,true);
});
test('project root transfers, trash and cross-project effects refuse before effects',native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'original.txt'),'original');
 for(const action of ['rename','copy','cut','trash'])await assert.rejects(f.ops().run({projectId:f.project.id,action,source:action==='trash'?'original.txt':'.',name:'other.txt'}));
 await assert.rejects(f.ops().run({projectId:f.project.id,sourceProjectId:randomUUID(),action:'copy',source:'original.txt'}),error=>Boolean(error.code));
 assert.equal(await fs.readFile(path.join(f.root,'original.txt'),'utf8'),'original');assert(!(await fs.readdir(f.root)).includes('other.txt'));
});
test('lost durable intent acknowledgement produces no public effect and survives cold admission checks',native,async t=>{
 const f=await fixture(t),put=f.host.storage.putRecovery.bind(f.host.storage);let lost=false;
 f.host.storage.putRecovery=async(id,key,value,options)=>{const result=await put(id,key,value,options);if(!lost&&value?.creation&&value.phase==='intent'){lost=true;throw Object.assign(Error('Synthetic lost intent acknowledgement'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:true});}return result;};
 await assert.rejects(f.run('createFile','not-created.txt'),{code:'STORAGE_RESULT_UNKNOWN'});await assert.rejects(fs.stat(path.join(f.root,'not-created.txt')),{code:'ENOENT'});
 await f.host.storage.db.close();const cold=f.make(),ops=new FileTreeOps(cold,{trash:()=>{}});await assert.rejects(ops.run({projectId:f.project.id,action:'createFolder',name:'different-name'}),{code:'TREE_RECOVERY_REQUIRED'});assert.equal((await recoveryRows(cold.storage,f.project.id)).filter(row=>row.value.creation).length,1);
});
test('actual shell recovery listing exposes uncertain creation facts and excludes completed/refused operations',native,async t=>{
 const f=await fixture(t);await f.run('createFile','complete.txt');await assert.rejects(f.run('createFile','complete.txt'));
 const io={...createFileTreeIO(f.host),...createWindowsDesktopFileTreeIO(f.host,{directorySync:parent=>{parent.close();parent.syncDirectory();}})};
 await assert.rejects(f.ops(io).run({projectId:f.project.id,action:'createFile',name:'uncertain.txt'}));
 const manager=new WorkspaceNative({host:f.host}),result=await manager.invoke({role:'shell'},'workspace.recovery.list');const entries=result.entries.filter(row=>row.value.recoveryKind==='tree-operation');assert.equal(entries.length,1);assert.equal(entries[0].value.destination,'uncertain.txt');assert.equal(entries[0].value.effect,undefined);const detail=await manager.invoke({role:'shell'},'workspace.recovery.detail',{projectId:f.project.id,id:entries[0].id,revision:entries[0].revision,version:entries[0].version});assert.equal(detail.value.effect.published,true);assert.equal(entries[0].value.phase,'needs-attention');
});

test('alpha.5 paged recovery retains large and future tree facts, binds details and holds new effects',native,async t=>{
 const f=await fixture(t),manager=new WorkspaceNative({host:f.host}),payload='retained-not-projected-'.repeat(10000);
 for(let i=0;i<34;i++)await f.host.storage.putRecovery(f.project.id,'tree-operation:'+String(i).padStart(3,'0'),{creation:true,relPath:'file-'+i,phase:i===33?'future-phase':'needs-attention',operationId:'operation-'+i,destination:'file-'+i,effect:{published:true,proof:payload}});
 for(const phase of ['complete','refused'])await f.host.storage.putRecovery(f.project.id,'tree-operation:settled-'+phase,{creation:true,phase,effect:{proof:payload}});
 let cursor=null,entries=[],first;
 do{const page=await manager.invoke({role:'shell'},'workspace.recovery.list',{cursor});first??=page;assert(page.entries.length<=30);assert(Buffer.byteLength(JSON.stringify(page))<50*1024);assert(page.entries.every(row=>row.value.effect===undefined));entries.push(...page.entries);cursor=page.nextCursor;}while(cursor);
 assert.equal(entries.length,34);assert(entries.some(row=>row.value.phase==='future-phase'));
 const row=entries[0],binding={projectId:f.project.id,id:row.id,revision:row.revision,version:row.version};const detail=await manager.invoke({role:'shell'},'workspace.recovery.detail',binding);assert.equal(detail.value.effect.proof,payload);
 await f.host.storage.putRecovery(f.project.id,row.id,{...detail.value,phase:'new-uncertainty'});
 await assert.rejects(manager.invoke({role:'shell'},'workspace.recovery.detail',binding),{code:'RECOVERY_VERSION_CHANGED'});await assert.rejects(manager.invoke({role:'shell'},'workspace.recovery.list',{cursor:first.nextCursor}),{code:'RECOVERY_CURSOR_INVALID'});
 await assert.rejects(f.run('createFile','must-not-create.txt'),{code:'TREE_RECOVERY_REQUIRED'});await assert.rejects(fs.stat(path.join(f.root,'must-not-create.txt')),{code:'ENOENT'});
});
