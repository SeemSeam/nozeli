import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DesktopHost} from '../src/main/host.mjs';
import {FileTreeOps} from '../src/main/file-tree-ops.mjs';
import {FileTags} from '../src/domain/file-tags.mjs';
import {FileChanges} from '../src/domain/file-changes.mjs';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';
import {recoveryHeld} from '../src/main/workspace-recovery-state.mjs';
import {createFileTreeIO} from '../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../src/platform/windows/desktop-file-tree.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'},hash=value=>createHash('sha256').update(value).digest('hex');
const text='跨项目原始正文\n',file='中文😀.txt';
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-cross-native-')),profile=path.join(base,'profile'),a=path.join(base,'源 项目'),b=path.join(base,'目标 项目'),hosts=[];
 await ensureExperimentalPrivateDirectory(base,profile);await fs.mkdir(a);await fs.mkdir(b);await fs.writeFile(path.join(a,file),text);await fs.mkdir(path.join(a,'目录/嵌套 空目录'),{recursive:true});await fs.writeFile(path.join(a,'目录',file),text);
 const make=()=>{const host=new DesktopHost(profile);hosts.push(host);return host;},host=make(),pickedA=await host.pick(a),pickedB=await host.pick(b),source=await host.requireProject(pickedA.project.id),destination=await host.requireProject(pickedB.project.id);
 t.after(async()=>{for(const host of hosts)await host.storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 const ops=(options,owner=host)=>new FileTreeOps(owner,{trash:()=>assert.fail('native cross-project operations never use path-only trash'),io:{...createFileTreeIO(owner),...(options?createWindowsDesktopFileTreeIO(owner,options):{})}});
 return {base,profile,a,b,source,destination,host,make,ops,run:(input,options,context)=>ops(options).run({projectId:destination.id,sourceProjectId:source.id,source:file,...input},context)};
}
async function absent(p){await assert.rejects(fs.stat(p),{code:'ENOENT'});}
async function records(f,id,owner=f.host){const result=[];for await(const row of owner.storage.recoveryRecords(id,{prefixes:['tree-operation:']}))result.push(row);return result;}
async function blocked(f,owner=f.host){for(const id of [f.source.id,f.destination.id])await assert.rejects(f.ops(null,owner).run({projectId:id,action:'createFile',name:'must-not-replay'}),{code:'TREE_RECOVERY_REQUIRED'});}
function child(script,args){const result=spawnSync(process.execPath,[script,...args],{env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},windowsHide:true,encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.signal,null);return result;}

test('public cross-project file copy and cut preserve source metadata and allocate new logical destination identities',native,async t=>{
 const f=await fixture(t),aid=f.source.id,bid=f.destination.id,store=id=>new FileTags({storage:f.host.storage,projectId:id,root:id===aid?f.a:f.b}),read=await f.host.readFile(aid,file);
 await f.host.addAnnotation(aid,{relPath:file,materialDigest:read.materialDigest,kind:'text-selection',anchor:{start:0,end:3,quote:'跨项目'},note:'不跨项目携带'});const original=await store(aid).read(file);
 const ledger=new FileChanges({storage:f.host.storage,projectId:aid,root:f.a});await ledger.observe(file,text,read.digest);const history=await ledger.read(file);await f.host.storage.putProject(aid,'provenance',file,{relPath:file,origin:'synthetic'});
 const copied=await f.run({action:'copy'});assert.equal(copied.from,undefined);assert.equal(copied.sourceFrom,undefined);assert.notEqual(copied.transfer.identity,copied.transfer.sourceIdentity);assert.equal(await store(bid).read(file),null);assert.equal((await f.host.readFile(bid,file)).text,text);const targetTags=await store(bid).write(file,{file:{},nextOrdinal:1,tags:[]});assert.notEqual(targetTags.file.fileId,original.file.fileId);assert.deepEqual(targetTags.tags,[]);
 await fs.mkdir(path.join(f.b,'移动目标'));const moved=await f.run({action:'cut',target:'移动目标'});assert.equal(moved.sourceFrom,file);assert.equal(moved.moved,true);assert.equal(moved.from,undefined);assert.equal(moved.transfer.identity,moved.transfer.sourceIdentity);await absent(path.join(f.a,file));assert.equal(await fs.readFile(path.join(f.b,'移动目标',file),'utf8'),text);
 assert.deepEqual(await store(aid).read(file),original);assert.equal((await ledger.read(file)).docId,history.docId);assert.equal((await f.host.storage.getProject(aid,'provenance',file)).origin,'synthetic');assert.equal(await store(bid).read('移动目标/'+file),null);assert.equal((await f.host.readFile(bid,'移动目标/'+file)).text,text);const movedTags=await store(bid).write('移动目标/'+file,{file:{},nextOrdinal:1,tags:[]});assert.notEqual(movedTags.file.fileId,original.file.fileId);assert.notEqual(movedTags.file.fileId,targetTags.file.fileId);
 for(const id of [aid,bid])assert((await records(f,id)).every(row=>row.value.phase==='complete'));assert.equal((await f.host.storage.crossTreeTransferPage()).entries.length,0);
});

test('recursive cross-project copy and native cut preserve bytes and empty directories with distinct copy ACLs',native,async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(1024*1024+37,71);await fs.writeFile(path.join(f.a,'目录/large.bin'),bytes);await fs.mkdir(path.join(f.b,'副本位置'));const sourceAcl=security('inspect',path.join(f.a,'目录'));
 const copied=await f.run({action:'copy',source:'目录',target:'副本位置'});assert.equal(copied.transfer.kind,'directory');assert.notEqual(copied.transfer.identity,copied.transfer.sourceIdentity);assert.deepEqual(await fs.readFile(path.join(f.b,copied.relPath,'large.bin')),bytes);assert.deepEqual(await fs.readdir(path.join(f.b,copied.relPath,'嵌套 空目录')),[]);assert.equal(security('inspect',path.join(f.b,copied.relPath)).protected,false);
 const moved=await f.run({action:'cut',source:'目录'});assert.equal(moved.transfer.identity,moved.transfer.sourceIdentity);assert.deepEqual(security('inspect',path.join(f.b,'目录')),sourceAcl);await absent(path.join(f.a,'目录'));assert.equal(await fs.readFile(path.join(f.b,'目录',file),'utf8'),text);
 await f.host.storage.db.close();const cold=f.make();assert.equal((await cold.readFile(f.destination.id,'目录/'+file)).text,text);assert.equal((await cold.storage.crossTreeTransferPage()).entries.length,0);
});

test('same-relative and late destination filesystem winners never overwrite or merge across project roots',native,async t=>{
 for(const kind of ['file','directory'])for(const action of ['copy','cut']){
  const f=await fixture(t),source=kind==='file'?file:'目录';
  await assert.rejects(f.run({action,source},{beforePublish:async()=>fs.writeFile(path.join(f.b,source),'external winner',{flag:'wx'})}));
  assert.equal(await fs.readFile(path.join(f.b,source),'utf8'),'external winner');assert.equal(await fs.readFile(path.join(f.a,kind==='file'?file:'目录/'+file),'utf8'),text);
  if(kind==='directory'&&action==='copy'){const row=(await records(f,f.destination.id)).at(-1);assert(row.value.effect.retainedStage);await blocked(f);}else assert.equal((await f.host.storage.crossTreeTransferPage()).entries.length,0);
 }
});

test('destination tags, history, provenance, drafts and workspace reservations reject before any native transfer',native,async t=>{
 for(const kind of ['tags','history','provenance','draft','workspace']){
  const f=await fixture(t),id=f.destination.id;
  if(kind==='tags')await new FileTags({storage:f.host.storage,projectId:id,root:f.b}).write(file,{file:{fileId:randomUUID()},nextOrdinal:1,tags:[]});
  if(kind==='history')await new FileChanges({storage:f.host.storage,projectId:id,root:f.b}).observe(file,'old bytes',hash('old bytes'));
  if(kind==='provenance')await f.host.storage.putProject(id,'provenance',file,{relPath:file,winner:true});
  if(kind==='draft'||kind==='workspace')await f.host.storage.putRecovery(id,(kind==='draft'?'draft:':'workspace:')+hash(file),{relPath:file,status:'saved',text:'retained candidate'});
  await assert.rejects(f.run({action:'cut'}),/恢复资料|修改历史|草稿|标签/);assert.equal(await fs.readFile(path.join(f.a,file),'utf8'),text);await absent(path.join(f.b,file));assert.equal((await records(f,f.source.id)).length,0);
 }
});

test('durable unsaved source text and workspace candidates refuse both cross-project actions without copying stale disk bytes',native,async t=>{
 for(const kind of ['draft','workspace']){
  const f=await fixture(t),id=f.source.id,read=await f.host.readFile(id,file);
  if(kind==='draft')await f.host.draft(id,file,read.digest,'unsaved source');else await f.host.storage.putRecovery(id,'workspace:source',{relPath:file,kind:'text',dirty:true,candidate:{text:'unsaved source'}});
  for(const action of ['copy','cut'])await assert.rejects(f.run({action}),/未保存|冲突/);assert.equal(await fs.readFile(path.join(f.a,file),'utf8'),text);await absent(path.join(f.b,file));assert.equal((await records(f,id)).length,0);
 }
});

test('late destination metadata winners are preserved both before and after native publication',native,async t=>{
 for(const when of ['before','after']){
  const f=await fixture(t),put=f.host.storage.putCrossTreeTransfer.bind(f.host.storage);let once=false;
  if(when==='after')f.host.storage.putCrossTreeTransfer=async(key,value,options)=>{if(!once&&value.phase==='published'){once=true;await f.host.storage.putProject(f.destination.id,'provenance',file,{relPath:file,winner:true});}return put(key,value,options);};
  await assert.rejects(f.run({action:'cut'},when==='before'?{beforePublish:async()=>f.host.storage.putProject(f.destination.id,'provenance',file,{relPath:file,winner:true})}:undefined),error=>when==='after'?error.committed===true:/来源/.test(error.message));
  assert.equal((await f.host.storage.getProject(f.destination.id,'provenance',file)).winner,true);if(when==='after'){await absent(path.join(f.a,file));assert.equal(await fs.readFile(path.join(f.b,file),'utf8'),text);await blocked(f);}else{assert.equal(await fs.readFile(path.join(f.a,file),'utf8'),text);await absent(path.join(f.b,file));}
 }
});

test('both selected project root leases reject replacement and retain external ACL changes without repair',native,async t=>{
 const f=await fixture(t);
 await f.run({action:'copy'},{beforePublish:async()=>{for(const root of [f.a,f.b])await assert.rejects(fs.rename(root,root+'-replacement'));}});
 for(const side of ['source','destination']){const g=await fixture(t);await assert.rejects(g.run({action:'cut'},{beforePublish:async()=>security('add-write',side==='source'?g.a:g.b)}),{code:'FS_STAGE_CHANGED'});assert.equal(await fs.readFile(path.join(g.a,file),'utf8'),text);await absent(path.join(g.b,file));}
});

test('partial recursive copy and a lost allocation receipt retain the stage and fence both projects after cold reopen',native,async t=>{
 const f=await fixture(t),put=f.host.storage.putRecovery.bind(f.host.storage);let once=false;
 f.host.storage.putRecovery=async(id,key,value,options)=>{const result=await put(id,key,value,options);if(!once&&value.crossTransfer&&value.role==='source'&&value.phase==='prepared'&&value.effect?.allocated?.some(row=>row.type==='file')){once=true;throw Object.assign(Error('Synthetic lost allocation acknowledgement'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:true});}return result;};
 await assert.rejects(f.run({action:'copy',source:'目录'}),{code:'STORAGE_RESULT_UNKNOWN'});const row=(await records(f,f.source.id)).at(-1);assert(row.value.effect.manifest.sha256);assert(row.value.effect.identity);assert(row.value.effect.retainedStage);assert((await fs.stat(path.join(f.b,row.value.effect.stagingName))).isDirectory());await absent(path.join(f.b,'目录'));await f.host.storage.db.close();await blocked(f,f.make());
});

test('actual postpublication barrier failures retain cross-project files and directories and cold dual admission',native,async t=>{
 for(const source of [file,'目录']){const f=await fixture(t);await assert.rejects(f.run({action:'cut',source},{directorySync:parent=>{parent.close();parent.syncDirectory();}}),error=>error.committed===true&&error.details.sourceRemoved===true);await absent(path.join(f.a,source));assert.equal(await fs.readFile(path.join(f.b,source===file?file:'目录/'+file),'utf8'),text);await f.host.storage.db.close();await blocked(f,f.make());}
});

test('lost registry and final paired acknowledgements retain completed public effects without replay',native,async t=>{
 for(const checkpoint of ['registry','source','destination']){
  const f=await fixture(t),put=f.host.storage.putRecovery.bind(f.host.storage),global=f.host.storage.putCrossTreeTransfer.bind(f.host.storage);let once=false;
  if(checkpoint==='registry')f.host.storage.putCrossTreeTransfer=async(key,value,options)=>{const result=await global(key,value,options);if(!once&&value.phase==='complete'){once=true;throw Object.assign(Error('Synthetic lost completion acknowledgement'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:true});}return result;};
  else f.host.storage.putRecovery=async(id,key,value,options)=>{const result=await put(id,key,value,options);if(!once&&value.crossTransfer&&value.phase==='complete'&&value.role===checkpoint){once=true;throw Object.assign(Error('Synthetic lost completion acknowledgement'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:true});}return result;};
  await assert.rejects(f.run({action:'cut'}),error=>error.committed===true&&error.code==='STORAGE_RESULT_UNKNOWN');await absent(path.join(f.a,file));assert.equal(await fs.readFile(path.join(f.b,file),'utf8'),text);await f.host.storage.db.close();await blocked(f,f.make());
 }
});

test('real abrupt exits before, after, and during completion of recursive cross-project effects preserve cold no-replay facts',native,async t=>{
 const modules=Object.fromEntries(['host','file-tree-ops','file-tree-io'].map(name=>[name,new URL('../src/main/'+name+'.mjs',import.meta.url).href])),nativeModule=new URL('../src/platform/windows/desktop-file-tree.mjs',import.meta.url).href;
 for(const action of ['copy','cut'])for(const checkpoint of ['before','after','complete']){
  const f=await fixture(t);await f.host.storage.db.close();const script=path.join(f.base,'crash.mjs');await fs.writeFile(script,`import {DesktopHost} from ${JSON.stringify(modules.host)};import {FileTreeOps} from ${JSON.stringify(modules['file-tree-ops'])};import {createFileTreeIO} from ${JSON.stringify(modules['file-tree-io'])};import {createWindowsDesktopFileTreeIO} from ${JSON.stringify(nativeModule)};const [profile,a,b,action,checkpoint]=process.argv.slice(2),host=new DesktopHost(profile),native=createWindowsDesktopFileTreeIO(host,{beforePublish:async()=>{if(checkpoint==='before')process.exit(23);}}),io={...createFileTreeIO(host),...native,transferEntry:(p,s,d,o)=>native.transferEntry(p,s,d,{...o,onPublished:async facts=>{if(checkpoint==='after')process.exit(23);return o.onPublished(facts);}})};const put=host.storage.putCrossTreeTransfer.bind(host.storage);host.storage.putCrossTreeTransfer=async(k,v,o)=>{const r=await put(k,v,o);if(checkpoint==='complete'&&v.phase==='complete')process.exit(23);return r;};await new FileTreeOps(host,{trash:()=>{},io}).run({projectId:b,sourceProjectId:a,action,source:'目录'});`);
  const result=child(script,[f.profile,f.source.id,f.destination.id,action,checkpoint]);assert.equal(result.status,23,result.stderr);const cold=f.make();for(const id of [f.source.id,f.destination.id])assert((await records(f,id,cold)).at(-1).value.effect.manifest.sha256);if(checkpoint!=='before')assert.equal(await fs.readFile(path.join(f.b,'目录',file),'utf8'),text);if(action==='copy'||checkpoint==='before')assert.equal(await fs.readFile(path.join(f.a,'目录',file),'utf8'),text);else await absent(path.join(f.a,'目录'));await blocked(f,cold);
 }
});

test('bounded registry admission retains huge future and unowned records even with a nominal complete phase',native,async t=>{
 for(const future of [true,false]){const f=await fixture(t),operationId=randomUUID();await f.host.storage.putCrossTreeTransfer('tree-operation:'+operationId,{schema:future?2:1,kind:future?'record':'future-protocol',crossTransfer:true,settled:true,published:true,operationId,projectId:randomUUID(),sourceProjectId:randomUUID(),phase:'complete',unused:'z'.repeat(2*1024*1024)});const page=await f.host.storage.crossTreeTransferPage({limit:1,maxBytes:8192});assert.equal(page.entries.length,1);assert(page.entries[0].byteLength>2*1024*1024);assert.equal(page.entries[0].value.unused,undefined);await blocked(f);await absent(path.join(f.b,file));}
});

test('registry paging ignores only qualified settled rows and finds a related pending operation beyond another page',native,async t=>{
 const f=await fixture(t);for(let i=0;i<55;i++){const operationId=randomUUID();await f.host.storage.putCrossTreeTransfer('tree-operation:'+operationId,{schema:1,kind:'record',crossTransfer:true,operationId,projectId:randomUUID(),sourceProjectId:randomUUID(),phase:'intent'});}
 const operationId=randomUUID();await f.host.storage.putCrossTreeTransfer('tree-operation:'+operationId,{schema:1,kind:'record',crossTransfer:true,operationId,projectId:f.destination.id,sourceProjectId:f.source.id,phase:'intent'});assert((await f.host.storage.pendingCrossTreeTransfer(f.source.id)));await blocked(f);
});

test('raw registry JSON types and missing kind never inherit UI defaults for unrelated ownership',native,async t=>{
 const f=await fixture(t),operationId=randomUUID(),key='tree-operation:'+operationId,valid={schema:1,kind:'record',crossTransfer:true,operationId,projectId:randomUUID(),sourceProjectId:randomUUID(),phase:'intent'};
 for(const changed of [{kind:undefined},{schema:true},{crossTransfer:1}]){
  await f.host.storage.putCrossTreeTransfer(key,{...valid,...changed});const page=await f.host.storage.crossTreeTransferPage({limit:1,maxBytes:8192});assert.equal(page.entries[0].value.registryScopeValid,false);await blocked(f);
 }
 await f.host.storage.putCrossTreeTransfer(key,valid);assert.equal(await f.host.storage.pendingCrossTreeTransfer(f.source.id),null);assert.equal(await f.host.storage.pendingCrossTreeTransfer(f.destination.id),null);
});

test('concurrent registry CAS winner is not overwritten before or after the public move',native,async t=>{
 for(const checkpoint of ['prepared','published']){const f=await fixture(t),put=f.host.storage.putCrossTreeTransfer.bind(f.host.storage);let once=false,key;
  f.host.storage.putCrossTreeTransfer=async(k,v,options)=>{key=k;if(!once&&v.phase===checkpoint){once=true;await put(k,{...v,schema:77,externalWinner:true,phase:'future'});}return put(k,v,options);};
  await assert.rejects(f.run({action:'cut'}),error=>checkpoint==='published'?error.committed===true:true);const winner=await f.host.storage.db.request(f.host.storage.catalog,'get',{collection:'tree_cross_transfers',id:key});assert.equal(winner.schema,77);assert.equal(winner.externalWinner,true);assert.equal(await fs.readFile(path.join(checkpoint==='published'?f.b:f.a,file),'utf8'),text);await blocked(f);
 }
});

test('shared cross-project workspace holds the original source on committed failure and rejects an open destination',native,async t=>{
 const f=await fixture(t),manager=new WorkspaceNative({host:f.host}),messages=[],surface={viewId:randomUUID(),generation:1,role:"surface",kind:"document",projectId:f.source.id,relPath:file,wc:{send:(...args)=>messages.push(args)}};manager.projectRecords=id=>id===f.source.id?[surface]:[];manager.flush=async()=>{};manager.syncDocument=async()=>()=>{};
 await assert.rejects(manager.mutateTreeCross({projectId:f.destination.id,sourceProjectId:f.source.id,source:file,action:'cut'},context=>f.run({action:'cut'},{directorySync:parent=>{parent.close();parent.syncDirectory();}},context)),error=>error.committed===true);assert.equal(surface.relPath,file);assert.equal(recoveryHeld(surface),true);assert.equal(surface.treeRecoveryHolds.size,1);assert.equal(surface.held,true);assert.deepEqual(messages.at(-1),['nozeli:workspace-control',{type:'transfer-hold',held:true}]);
 const g=await fixture(t),open=new WorkspaceNative({host:g.host});open.projectRecords=id=>id===g.destination.id?[{projectId:id,relPath:file}]:[];await assert.rejects(open.mutateTreeCross({projectId:g.destination.id,sourceProjectId:g.source.id,source:file,action:'copy'},()=>assert.fail('open destination cannot be replaced')),{code:'TREE_DESTINATION_OPEN'});
});

test('concurrent paired recovery winner survives a published cross-project cut and the registry keeps both scopes held',native,async t=>{
 const f=await fixture(t),put=f.host.storage.putRecovery.bind(f.host.storage);let once=false,key;
 f.host.storage.putRecovery=async(id,k,value,options)=>{if(!once&&value.crossTransfer&&value.role==='source'&&value.phase==='published'){once=true;key=k;await put(id,k,{...value,schema:99,phase:'future',externalWinner:true});}return put(id,k,value,options);};
 await assert.rejects(f.run({action:'cut'}),error=>error.committed===true);const winner=await f.host.storage.getRecovery(f.source.id,key);assert.equal(winner.schema,99);assert.equal(winner.externalWinner,true);assert.equal(await fs.readFile(path.join(f.b,file),'utf8'),text);await blocked(f);
});
