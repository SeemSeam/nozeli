import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {DesktopHost} from '../src/main/host.mjs';
import {FileTreeOps} from '../src/main/file-tree-ops.mjs';
import {FileTags} from '../src/domain/file-tags.mjs';
import {FileChanges} from '../src/domain/file-changes.mjs';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';
import {createFileTreeIO} from '../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../src/platform/windows/desktop-file-tree.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'},bridge=createRequire(import.meta.url)('../native/windows/build/Release/nozeli_windows_read.node');
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-public-transfer-')),profile=path.join(base,'profile'),root=path.join(base,'项目 空格'),hosts=[];
 await ensureExperimentalPrivateDirectory(base,profile);await fs.mkdir(root);await fs.mkdir(path.join(root,'目标 目录'));await fs.writeFile(path.join(root,'原始 中文.txt'),'原始正文\n');
 const make=()=>{const host=new DesktopHost(profile);hosts.push(host);return host;},host=make(),picked=await host.pick(root),project=await host.requireProject(picked.project.id);
 t.after(async()=>{for(const host of hosts)await host.storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 const ops=options=>new FileTreeOps(host,{trash:()=>assert.fail('native transfers never use path-only trash'),io:{...createFileTreeIO(host),...(options?createWindowsDesktopFileTreeIO(host,options):{})}});
 return {base,root,profile,host,project,make,ops,run:(input,options)=>ops(options).run({projectId:project.id,source:'原始 中文.txt',...input})};
}
async function rows(f,host=f.host){const result=[];for await(const row of host.storage.recoveryRecords(f.project.id,{prefixes:['tree-operation:']}))result.push(row);return result;}
async function absent(file){await assert.rejects(fs.lstat(file),{code:'ENOENT'});}
function child(code,args,{script=false}={}){const result=spawnSync(process.execPath,script?[code,...args]:['--input-type=module','-e',code,...args],{env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},encoding:'utf8',windowsHide:true,timeout:20000});assert.ifError(result.error);assert.equal(result.signal,null);return result;}
test('public regular-file rename and cut preserve native identity, inherited ACL and exact bytes after cold reopen',native,async t=>{
 const f=await fixture(t),before=await fs.stat(path.join(f.root,'原始 中文.txt'),{bigint:true}),acl=security('inspect',path.join(f.root,'原始 中文.txt'));
 const renamed=await f.run({action:'rename',name:'改名 空格.txt'});assert.equal(renamed.from,'原始 中文.txt');assert.equal(renamed.transfer.identity,renamed.transfer.sourceIdentity);assert.equal(renamed.transfer.digest,hash('原始正文\n'));
 const moved=await f.run({action:'cut',source:renamed.relPath,target:'目标 目录'});assert.equal(moved.relPath,'目标 目录/改名 空格.txt');await absent(path.join(f.root,renamed.relPath));
 const after=await fs.stat(path.join(f.root,moved.relPath),{bigint:true});assert.equal(after.ino,before.ino);assert.deepEqual(security('inspect',path.join(f.root,moved.relPath)),acl);
 await f.host.storage.db.close();const cold=f.make();assert.equal((await cold.readFile(f.project.id,moved.relPath)).text,'原始正文\n');assert((await rows(f,cold)).every(row=>row.value.phase==='complete'));
});
test('bounded multichunk copy publishes independent bytes and inherited ACL without modifying source',native,async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(2*1024*1024+37);for(let i=0;i<bytes.length;i++)bytes[i]=(i*31)%251;await fs.writeFile(path.join(f.root,'原始 中文.txt'),bytes);
 const first=await f.run({action:'copy'}),second=await f.run({action:'copy'});assert.equal(first.relPath,'原始 中文 副本.txt');assert.equal(second.relPath,'原始 中文 副本 2.txt');assert.notEqual(first.transfer.sourceIdentity,first.transfer.identity);assert.equal(first.transfer.digest,hash(bytes));assert.equal(first.transfer.byteLength,bytes.length);
 for(const rel of ['原始 中文.txt',first.relPath,second.relPath])assert.deepEqual(await fs.readFile(path.join(f.root,rel)),bytes);assert.equal(security('inspect',path.join(f.root,first.relPath)).protected,false);
});
test('shared tag, label, change-history and provenance identities follow moves; copies get fresh identities',native,async t=>{
 const f=await fixture(t),id=f.project.id,store=new FileTags({storage:f.host.storage,projectId:id,root:f.root});
 const read=await f.host.readFile(id,'原始 中文.txt');await f.host.addAnnotation(id,{relPath:'原始 中文.txt',materialDigest:read.materialDigest,kind:'text-selection',anchor:{start:0,end:4,quote:'原始正文'},note:'保留批注'});
 await f.ops().setLabel({projectId:id,relPath:'原始 中文.txt',colors:['blue'],note:'保留标签',expectedRevision:0});
 const ledger=new FileChanges({storage:f.host.storage,projectId:id,root:f.root});await ledger.observe('原始 中文.txt','原始正文\n',read.digest);const original=await store.read('原始 中文.txt'),originalLedger=await ledger.read('原始 中文.txt');
 await f.host.storage.putProject(id,'provenance','原始 中文.txt',{relPath:'原始 中文.txt',origin:'synthetic'});
 await f.run({action:'rename',name:'保留.txt'});assert.equal(await store.read('原始 中文.txt'),null);const renamed=await store.read('保留.txt');assert.equal(renamed.file.fileId,original.file.fileId);assert.equal(renamed.tags[0].id,original.tags[0].id);assert.equal(renamed.fileLabel.note,'保留标签');assert.equal((await ledger.read('保留.txt')).docId,originalLedger.docId);assert.equal((await f.host.storage.getProject(id,'provenance','保留.txt')).origin,'synthetic');
 await f.run({action:'copy',source:'保留.txt'});const copy=await store.read('保留 副本.txt');assert.notEqual(copy.file.fileId,renamed.file.fileId);assert.notEqual(copy.tags[0].id,renamed.tags[0].id);assert.notEqual((await ledger.read('保留 副本.txt')).docId,originalLedger.docId);assert.equal(copy.tags[0].note,'保留批注');assert.equal(await f.host.storage.getProject(id,'provenance','保留 副本.txt'),null);
});
test('unsaved recovery draft follows a move and remains exact after whole storage reopen',native,async t=>{
 const f=await fixture(t),id=f.project.id,source='原始 中文.txt',destination='草稿 新名.txt',before=await f.host.readFile(id,source);await f.host.draft(id,source,before.digest,'尚未保存的人工草稿');
 const old=await f.host.storage.getRecovery(id,'draft:'+hash(source));await f.run({action:'rename',name:destination});assert.equal(await f.host.storage.getRecovery(id,'draft:'+hash(source)),null);
 await f.host.storage.db.close();const cold=f.make(),draft=await cold.storage.getRecovery(id,'draft:'+hash(destination));assert.deepEqual(draft,{...old,relPath:destination});assert.equal(await fs.readFile(path.join(f.root,destination),'utf8'),'原始正文\n');
});
test('copy refuses a durable unsaved source draft without saving or copying stale bytes',native,async t=>{
 const f=await fixture(t),read=await f.host.readFile(f.project.id,'原始 中文.txt');await f.host.draft(f.project.id,'原始 中文.txt',read.digest,'unsaved human text');await assert.rejects(f.run({action:'copy'}),/未保存/);assert.equal(await fs.readFile(path.join(f.root,'原始 中文.txt'),'utf8'),'原始正文\n');await absent(path.join(f.root,'原始 中文 副本.txt'));assert.equal((await rows(f)).length,0);
});
test('late independent file/directory/case-alias winners survive no-replace move and copy',native,async t=>{
 for(const action of ['rename','copy']){
  const f=await fixture(t),target=action==='rename'?'late.txt':'目标 目录/原始 中文.txt';
  await assert.rejects(f.run({action,name:'late.txt',target:'目标 目录'},{beforePublish:async()=>{const result=child("import fs from 'node:fs';fs.writeFileSync(process.argv[1],'external winner',{flag:'wx'});",[path.join(f.root,target.toUpperCase())]);assert.equal(result.status,0,result.stderr);}}));
  assert.equal(await fs.readFile(path.join(f.root,'原始 中文.txt'),'utf8'),'原始正文\n');assert.equal(await fs.readFile(path.join(f.root,target),'utf8'),'external winner');assert((await rows(f)).every(row=>row.value.phase==='refused'));assert(!(await fs.readdir(path.join(f.root,'目标 目录'))).some(name=>name.endsWith('.pending')));
 }
});
test('pinned public source denies independent write, rename and unlink while transfer is prepared',native,async t=>{
 const f=await fixture(t);let attempted=0;
 await f.run({action:'rename',name:'pinned.txt'},{beforePublish:async()=>{
  for(const operation of ['write','rename','unlink']){const result=child("import fs from 'node:fs';try{const [p,op]=process.argv.slice(1);if(op==='write')fs.writeFileSync(p,'contender');else if(op==='rename')fs.renameSync(p,p+'-outside');else fs.unlinkSync(p);}catch(e){console.log(e.code);process.exitCode=7;}",[path.join(f.root,'原始 中文.txt'),operation]);assert.equal(result.status,7,result.stdout+result.stderr);attempted++;}
 }});assert.equal(attempted,3);assert.equal(await fs.readFile(path.join(f.root,'pinned.txt'),'utf8'),'原始正文\n');
 // NTFS can allow a hardlink despite this lease's sharing mode. The final
 // HANDLE check must detect the new link and retain both external names.
 await assert.rejects(f.run({action:'rename',source:'pinned.txt',name:'not-moved.txt'},{beforePublish:async()=>{const result=child("import fs from 'node:fs';fs.linkSync(process.argv[1],process.argv[1]+'-link');",[path.join(f.root,'pinned.txt')]);assert.equal(result.status,0,result.stderr);}}),{code:'FS_STAGE_CHANGED'});
 assert.equal(await fs.readFile(path.join(f.root,'pinned.txt-link'),'utf8'),'原始正文\n');await absent(path.join(f.root,'not-moved.txt'));
});
test('source and destination ACL drift refuse before publication without repairing external policy',native,async t=>{
 for(const target of ['原始 中文.txt','目标 目录']){const f=await fixture(t);await assert.rejects(f.run({action:'cut',target:'目标 目录'},{beforePublish:async()=>security('add-write',path.join(f.root,target))}),{code:'FS_STAGE_CHANGED'});assert.equal(await fs.readFile(path.join(f.root,'原始 中文.txt'),'utf8'),'原始正文\n');await absent(path.join(f.root,'目标 目录/原始 中文.txt'));}
});
test('hardlinks, ADS, junction parents, cross-project and trash refuse before public effects',native,async t=>{
 const f=await fixture(t);await fs.link(path.join(f.root,'原始 中文.txt'),path.join(f.root,'alias.txt'));await assert.rejects(f.run({action:'rename',name:'no.txt'}),{code:'FS_ENTRY_REJECTED'});await fs.unlink(path.join(f.root,'alias.txt'));
 await fs.writeFile(path.join(f.root,'原始 中文.txt:retained'),'alternate');await assert.rejects(f.run({action:'copy'}),{code:'FS_STREAMS_UNSUPPORTED'});assert.equal(await fs.readFile(path.join(f.root,'原始 中文.txt:retained'),'utf8'),'alternate');
 await fs.symlink(path.join(f.root,'目标 目录'),path.join(f.root,'link'),'junction');await assert.rejects(f.run({action:'cut',target:'link'}));
 for(const input of [{action:'trash'},{action:'copy',sourceProjectId:randomUUID()}])await assert.rejects(f.run(input));await absent(path.join(f.root,'no.txt'));assert.equal(await fs.readFile(path.join(f.root,'原始 中文.txt'),'utf8'),'原始正文\n');
});
test('native lease methods reject forged/read-only receivers and retain parents after caller closes them',native,async t=>{
 const f=await fixture(t),from=bridge.openAnchoredPublicMutationParent(f.root,'原始 中文.txt'),to=bridge.openAnchoredPublicMutationParent(f.root,'目标 目录/copy.txt');let lease;
 try{lease=from.beginPublicFileTransfer('原始 中文.txt',to,'copy.txt',false);from.close();to.close();lease.verify();assert.throws(()=>lease.commit(),{code:'FS_HANDLE_REJECTED'});assert.throws(()=>lease.readAt.call({},0,1),{code:'FS_HANDLE_REJECTED'});for(const args of [[-1,1],[0,0],[0,1048577],[NaN,1]])assert.throws(()=>lease.readAt(...args),{code:'FS_READ_LIMIT'});assert.equal(lease.readAt(0,32).toString(),'原始正文\n');}finally{lease?.close();to.close();from.close();}
 await absent(path.join(f.root,'目标 目录/copy.txt'));
});
test('real postpublication parent barrier failures retain moved/copied files and cold admission blocks further effects',native,async t=>{
 for(const action of ['rename','copy']){const f=await fixture(t);let failure;await assert.rejects(f.run({action,name:'uncertain.txt',target:'目标 目录'},{directorySync:parent=>{parent.close();parent.syncDirectory();}}),error=>{failure=error;return error.committed===true&&error.details.committed===true;});const target=action==='rename'?'uncertain.txt':'目标 目录/原始 中文.txt';assert.equal(await fs.readFile(path.join(f.root,target),'utf8'),'原始正文\n');if(action==='rename')await absent(path.join(f.root,'原始 中文.txt'));
  await f.host.storage.db.close();const cold=f.make(),row=await cold.storage.getRecovery(f.project.id,failure.details.recoveryKey);assert.equal(row.phase,'needs-attention');assert.equal(row.effect.published,true);assert(row.metadata.before&&row.metadata.after);
  const ops=new FileTreeOps(cold,{trash:()=>{}});await assert.rejects(ops.run({projectId:f.project.id,action:'createFile',name:'must-not-create.txt'}),{code:'TREE_RECOVERY_REQUIRED'});await assert.rejects(ops.run({projectId:f.project.id,action:'rename',source:target,name:'again.txt'}),{code:'TREE_RECOVERY_REQUIRED'});
 }
});
test('concurrent metadata winner is preserved after file publication; before/after plans remain recoverable',native,async t=>{
 const f=await fixture(t),replace=f.host.storage.replaceProjectCollections.bind(f.host.storage);f.host.storage.replaceProjectCollections=async(id,collections,options)=>{await f.host.storage.putProject(id,'provenance','external',{winner:true});return replace(id,collections,options);};
 let failure;await assert.rejects(f.run({action:'rename',name:'published.txt'}),error=>{failure=error;return error.committed===true;});assert.deepEqual(await f.host.storage.getProject(f.project.id,'provenance','external'),{winner:true});assert.equal(await fs.readFile(path.join(f.root,'published.txt'),'utf8'),'原始正文\n');assert.equal((await f.host.storage.getRecovery(f.project.id,failure.details.recoveryKey)).phase,'needs-attention');
});
test('shared workspace keeps the original surface held when native publication succeeded but its barrier failed',native,async t=>{
 const f=await fixture(t),manager=new WorkspaceNative({host:f.host,origin:'http://synthetic.local/'}),messages=[],viewId=randomUUID(),surface={role:'surface',kind:'document',generation:1,ready:true,dead:false,viewId,documentSource:{type:'project'},projectId:f.project.id,relPath:'原始 中文.txt',wc:{id:9001,send:(...args)=>messages.push(args)}};
 manager.layout=async()=>({views:{}});manager.surfaces.set(viewId,surface);manager.flush=async()=>{};manager.syncDocument=async()=>()=>{};
 const payload={projectId:f.project.id,action:'rename',source:'原始 中文.txt',name:'published.txt'},ops=new FileTreeOps(f.host,{trash:()=>{},io:{...createFileTreeIO(f.host),...createWindowsDesktopFileTreeIO(f.host,{directorySync:parent=>{parent.close();parent.syncDirectory();}})}});
 await assert.rejects(manager.mutateTree(payload,context=>ops.run(payload,context)),error=>error.committed===true);
 assert.equal(surface.treeRecoveryHolds.size,1);assert.equal(surface.held,true);assert.equal(surface.transferring,false);assert.equal(surface.relPath,'原始 中文.txt');assert.deepEqual(messages.at(-1),['nozeli:workspace-control',{type:'transfer-hold',held:true}]);assert.equal(await fs.readFile(path.join(f.root,'published.txt'),'utf8'),'原始正文\n');
});
test('concurrent destination draft winner is never overwritten after publication',native,async t=>{
 const f=await fixture(t),id=f.project.id,read=await f.host.readFile(id,'原始 中文.txt');await f.host.draft(id,'原始 中文.txt',read.digest,'original unsaved');const put=f.host.storage.putRecoveryRecords.bind(f.host.storage),destination='draft:'+hash('draft.txt');let injected=false;
 f.host.storage.putRecoveryRecords=async(project,records)=>{if(!injected&&records.some(row=>row.id===destination)){injected=true;await f.host.storage.putRecovery(project,destination,{relPath:'draft.txt',text:'external draft'});}return put(project,records);};
 await assert.rejects(f.run({action:'rename',name:'draft.txt'}),error=>error.committed===true);assert(injected);assert.equal((await f.host.storage.getRecovery(id,destination)).text,'external draft');assert((await f.host.storage.getRecovery(id,'draft:'+hash('原始 中文.txt'))));assert((await rows(f)).some(row=>row.value.phase==='needs-attention'&&row.value.drafts.length===1));
});
test('lost intent and completion acknowledgements never replay or roll back public effects',native,async t=>{
 for(const phase of ['intent','complete']){
  const f=await fixture(t),storage=f.host.storage,put=storage.putRecovery.bind(storage),batch=storage.putRecoveryRecords.bind(storage);let lost=false;
  const lose=()=>{lost=true;throw Object.assign(Error('Synthetic lost durable acknowledgement'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:true});};
  storage.putRecovery=async(id,key,value,options)=>{const result=await put(id,key,value,options);if(!lost&&value?.transfer&&value.phase===phase)lose();return result;};
  storage.putRecoveryRecords=async(id,records)=>{const result=await batch(id,records);if(!lost&&records.some(row=>row.value?.transfer&&row.value.phase===phase))lose();return result;};
  await assert.rejects(f.run({action:'rename',name:'result.txt'}),{code:'STORAGE_RESULT_UNKNOWN'});assert(lost);assert.equal(await fs.readFile(path.join(f.root,phase==='intent'?'原始 中文.txt':'result.txt'),'utf8'),'原始正文\n');await storage.db.close();const cold=f.make(),ops=new FileTreeOps(cold,{trash:()=>{}});
  if(phase==='intent')await assert.rejects(ops.run({projectId:f.project.id,action:'createFolder',name:'held'}),{code:'TREE_RECOVERY_REQUIRED'});
  else{assert((await rows(f,cold)).every(row=>row.value.phase==='complete'));assert.equal((await ops.run({projectId:f.project.id,action:'createFolder',name:'after-complete'})).relPath,'after-complete');}
 }
});
test('real child exit before/after native publication preserves durable prepared facts and cold recovery does not replay',native,async t=>{
 const hostModule=new URL('../src/main/host.mjs',import.meta.url).href,opsModule=new URL('../src/main/file-tree-ops.mjs',import.meta.url).href,ioModule=new URL('../src/platform/windows/desktop-file-tree.mjs',import.meta.url).href,selectorModule=new URL('../src/main/file-tree-io.mjs',import.meta.url).href;
 for(const when of ['before','after']){const f=await fixture(t);await f.host.storage.db.close();const script=path.join(f.base,'crash.mjs');await fs.writeFile(script,`import {DesktopHost} from ${JSON.stringify(hostModule)};import {FileTreeOps} from ${JSON.stringify(opsModule)};import {createWindowsDesktopFileTreeIO} from ${JSON.stringify(ioModule)};import {createFileTreeIO} from ${JSON.stringify(selectorModule)};const [profile,id,when]=process.argv.slice(2);const host=new DesktopHost(profile),native=createWindowsDesktopFileTreeIO(host,{beforePublish:async()=>{if(when==='before')process.exit(23);}});const io={...createFileTreeIO(host),...native,transferEntry:(project,source,destination,options)=>native.transferEntry(project,source,destination,{...options,onPublished:async facts=>{if(when==='after')process.exit(23);return options.onPublished(facts);}})};await new FileTreeOps(host,{trash:()=>{},io}).run({projectId:id,action:'rename',source:'原始 中文.txt',name:'crashed.txt'});`);const result=child(script,[f.profile,f.project.id,when],{script:true});assert.equal(result.status,23,result.stderr);
  const cold=f.make(),records=await rows(f,cold);assert.equal(records.length,1);assert.equal(records[0].value.phase,'prepared');assert(records[0].value.effect.sourceIdentity);assert.equal(await fs.readFile(path.join(f.root,when==='after'?'crashed.txt':'原始 中文.txt'),'utf8'),'原始正文\n');await assert.rejects(new FileTreeOps(cold,{trash:()=>{}}).run({projectId:f.project.id,action:'createFile',name:'replayed'}),{code:'TREE_RECOVERY_REQUIRED'});
 }
});
