import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadDemoTemplate,createDemoDirectory,demoDirectoryIdentity,sameDemoDirectory,compareDemoFiles} from '../src/main/guided-demo-files.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {ProjectLifecycle} from '../src/main/project-lifecycle.mjs';
import {createGuidedDemo} from '../src/main/guided-demo.mjs';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';
import {EventEmitter} from 'node:events';


const appRoot=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const closers=new Map();
async function scratch(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-demo-host-safety-'));
 closers.set(directory,[]);
 t.after(async()=>{try{for(const close of closers.get(directory)||[])await close();}finally{closers.delete(directory);await fs.rm(directory,{recursive:true,force:true});}});
 return directory;
}
async function copyTemplate(t){
 const directory=await scratch(t),root=path.join(directory,'app');
 await fs.mkdir(path.join(root,'assets'),{recursive:true});
 await fs.cp(path.join(appRoot,'assets','guided-demo'),path.join(root,'assets','guided-demo'),{recursive:true});
 return {directory,root,assets:path.join(root,'assets','guided-demo')};
}
async function materialCopy(t){
 const directory=await scratch(t),template=await loadDemoTemplate(appRoot);
 const copy=await createDemoDirectory({template,examplesRoot:path.join(directory,'examples')});
 return {directory,template,...copy};
}

test('packaged template is hash-checked and every copy has separate real files and directory identity',async t=>{
 const f=await materialCopy(t),second=await createDemoDirectory({template:f.template,examplesRoot:path.join(f.directory,'examples')});
 assert.notEqual(f.root,second.root);
 assert.equal(sameDemoDirectory(f.identity,second.identity),false);
 assert.deepEqual(await compareDemoFiles(f.root,f.expectedFiles),[]);
 assert.deepEqual(Object.keys(f.expectedFiles).sort(),f.template.manifest.files.map(item=>item.path).sort());
 for(const item of f.template.files){
  const copied=await fs.readFile(path.join(f.root,item.path));
  assert.equal(hash(copied),item.sha256);
  assert.equal(copied.length,item.bytes.length);
 }
 const rel=f.template.files[0].path;
 await fs.writeFile(path.join(f.root,rel),'exploration retained in first copy');
 assert.equal(hash(await fs.readFile(path.join(second.root,rel))),f.expectedFiles[rel]);
 assert.equal(hash(await fs.readFile(path.join(f.template.directory,rel))),f.expectedFiles[rel]);
});

test('template byte corruption is rejected before material can be consumed',async t=>{
 const f=await copyTemplate(t),manifest=JSON.parse(await fs.readFile(path.join(f.assets,'manifest.json'),'utf8'));
 const file=path.join(f.assets,manifest.files[0].path),bytes=await fs.readFile(file);
 bytes[0]^=1;await fs.writeFile(file,bytes);
 await assert.rejects(loadDemoTemplate(f.root),{code:'DEMO_TEMPLATE_INVALID'});
});

test('template traversal, duplicate entries and hidden source paths are rejected',async t=>{
 for(const relative of ['../outside.txt','/outside.txt','nested/../../outside.txt','nested\\outside.txt','.hidden.txt']){
  const f=await copyTemplate(t),manifestPath=path.join(f.assets,'manifest.json'),manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  manifest.files[0].path=relative;await fs.writeFile(manifestPath,JSON.stringify(manifest));
  await assert.rejects(loadDemoTemplate(f.root),{code:'DEMO_TEMPLATE_INVALID'},relative);
 }
 const f=await copyTemplate(t),manifestPath=path.join(f.assets,'manifest.json'),manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
 manifest.files.push({...manifest.files[0]});await fs.writeFile(manifestPath,JSON.stringify(manifest));
 await assert.rejects(loadDemoTemplate(f.root),{code:'DEMO_TEMPLATE_INVALID'});
});

test('template source and manifest symlinks never become trusted copy inputs',async t=>{
 for(const kind of ['source','manifest']){
  const f=await copyTemplate(t),manifest=JSON.parse(await fs.readFile(path.join(f.assets,'manifest.json'),'utf8'));
  const file=path.join(f.assets,kind==='manifest'?'manifest.json':manifest.files[0].path),outside=path.join(f.directory,'outside');
  await fs.rename(file,outside);await fs.symlink(outside,file);
  await assert.rejects(loadDemoTemplate(f.root),{code:'DEMO_TEMPLATE_INVALID'});
 }
});

test('retention preview sees user hidden content, changed and removed files, and never follows links',async t=>{
 const f=await materialCopy(t),[modified,missing]=f.template.files;
 await fs.writeFile(path.join(f.root,modified.path),'user exploration');
 await fs.unlink(path.join(f.root,missing.path));
 await fs.writeFile(path.join(f.root,'.user-notes'),'private user content');
 await fs.mkdir(path.join(f.root,'.research'));
 await fs.writeFile(path.join(f.root,'.research','draft.md'),'hidden user draft');
 await fs.mkdir(path.join(f.root,'.nozeli'));
 await fs.writeFile(path.join(f.root,'.nozeli','metadata'),'business metadata');
 const outside=path.join(f.directory,'outside.txt');await fs.writeFile(outside,'outside must survive');
 await fs.symlink(outside,path.join(f.root,'external-link'));
 const changes=await compareDemoFiles(f.root,f.expectedFiles),byPath=new Map(changes.map(row=>[row.path,row.kind]));
 assert.equal(byPath.get(modified.path),'modified');assert.equal(byPath.get(missing.path),'missing');
 assert.equal(byPath.get('.user-notes'),'added');assert.equal(byPath.get('.research/draft.md'),'added');
 assert.equal(byPath.get('external-link'),'link');assert.equal(changes.some(row=>row.path.startsWith('.nozeli')),false);
 assert.equal(await fs.readFile(outside,'utf8'),'outside must survive');
 assert.equal(await fs.readFile(path.join(f.root,modified.path),'utf8'),'user exploration');
 assert.equal(f.expectedFiles[modified.path],modified.sha256,'preview cannot bless current disk bytes as a new baseline');
});

test('preview reports incomplete inspection instead of treating bounded or deep content as clean',async t=>{
 const f=await materialCopy(t);
 await fs.mkdir(path.join(f.root,...Array(10).fill('deep')),{recursive:true});
 await fs.writeFile(path.join(f.root,...Array(10).fill('deep'),'user.txt'),'must retain');
 assert.equal((await compareDemoFiles(f.root,f.expectedFiles)).some(row=>row.kind==='uninspected'),true);
 assert.equal((await compareDemoFiles(f.root,f.expectedFiles,{maxEntries:1})).some(row=>row.kind==='uninspected'),true);
});

test('directory identity distinguishes a replacement and refuses symbolic directory aliases',async t=>{
 const f=await materialCopy(t),original=path.join(f.directory,'original');
 await fs.rename(f.root,original);await fs.mkdir(f.root);
 await fs.writeFile(path.join(f.root,'replacement.txt'),'not tutorial owned');
 assert.equal(sameDemoDirectory(f.identity,await demoDirectoryIdentity(f.root)),false);
 await fs.unlink(path.join(f.root,'replacement.txt'));await fs.rmdir(f.root);
 await fs.symlink(original,f.root,'dir');
 await assert.rejects(demoDirectoryIdentity(f.root),{code:'DEMO_ROOT_CHANGED'});
 await assert.rejects(compareDemoFiles(f.root,f.expectedFiles),{code:'DEMO_ROOT_CHANGED'});
});

// Production host, SQLite storage and lifecycle. Only stop/view boundaries and
// trash are controlled dependencies; rename is NOT OS recycle-bin acceptance.
async function lifecycleCopy(t){
 const f=await materialCopy(t),host=new DesktopHost(path.join(f.directory,'profile'));
 closers.get(f.directory).push(()=>host.storage.db.close());
 const project=await host.storage.register(f.root),events=[],trash=path.join(f.directory,'controlled-trash');
 await fs.mkdir(trash);
 const workspace={layouts:new Map(),closeProject:async(projectId,{operationId})=>{events.push('close');return {closed:true,projectId,operationId};}};
 const managed={stopProject:async projectId=>{events.push('stop');return {projectId,confirmationComplete:true};}};
 const lifecycle=new ProjectLifecycle({host,workspace,managed,trashItem:async root=>{events.push('trash');await fs.rename(root,path.join(trash,path.basename(root)));}});
 return {...f,host,project,events,trash,lifecycle};
}

test('real lifecycle preview is non-destructive and only explicit confirmation invokes controlled trash',async t=>{
 const f=await lifecycleCopy(t);
 const preview=await f.lifecycle.preview({projectId:f.project.id,action:'delete-project'});
 assert.equal(preview.permanentDelete,false);assert.deepEqual(preview.removeDirectories,[f.root]);
 assert.deepEqual(f.events,[]);assert.equal((await fs.stat(f.root)).isDirectory(),true);
 assert.equal((await f.host.storage.requireRegistered(f.project.id)).removed,false);
 await assert.rejects(f.lifecycle.execute({token:'renderer-invented-token'}),{code:'LIFECYCLE_CONFIRMATION_EXPIRED'});
 assert.deepEqual(f.events,[]);
 const receipt=await f.lifecycle.execute({token:preview.token});
 assert.equal(receipt.complete,true);assert.equal(receipt.trashed,true);
 assert.deepEqual(f.events,['stop','close','trash']);
 const moved=path.join(f.trash,path.basename(f.root));
 assert.equal(hash(await fs.readFile(path.join(moved,f.template.files[0].path))),f.template.files[0].sha256);
 await assert.rejects(f.lifecycle.execute({token:preview.token}),{code:'LIFECYCLE_CONFIRMATION_EXPIRED'});
 assert.equal(f.events.filter(value=>value==='trash').length,1);
});

test('real lifecycle confirmation rejects manifest changes and replaced root before stopping or trashing',async t=>{
 for(const replacement of ['manifest','root']){
  const f=await lifecycleCopy(t),preview=await f.lifecycle.preview({projectId:f.project.id,action:'delete-project'});
  if(replacement==='manifest'){
   const file=path.join(f.root,'.nozeli','project.json'),manifest=JSON.parse(await fs.readFile(file,'utf8'));
   await fs.writeFile(file,JSON.stringify({...manifest,userChanged:true}));
  }else{
   await fs.rename(f.root,path.join(f.directory,'original-project'));
   await fs.mkdir(f.root);await fs.writeFile(path.join(f.root,'user.txt'),'replacement must survive');
  }
  await assert.rejects(f.lifecycle.execute({token:preview.token}),{code:'PROJECT_IDENTITY_CONFLICT'});
  assert.deepEqual(f.events,[]);
  if(replacement==='root')assert.equal(await fs.readFile(path.join(f.root,'user.txt'),'utf8'),'replacement must survive');
 }
});

test('unavailable trash preserves real tutorial copy and reports needs-attention without permanent fallback',async t=>{
 const f=await lifecycleCopy(t),preview=await f.lifecycle.preview({projectId:f.project.id,action:'delete-project'});
 let attempts=0;f.lifecycle.trashItem=async()=>{attempts++;throw Object.assign(Error('controlled unavailable trash'),{code:'EACCES'});};
 await assert.rejects(f.lifecycle.execute({token:preview.token}),{code:'EACCES'});
 assert.equal(attempts,1);assert.equal((await fs.stat(f.root)).isDirectory(),true);
 assert.equal((await f.host.storage.requireRegistered(f.project.id)).removed,false);
 assert.equal((await f.host.storage.getRecovery(f.project.id,'lifecycle:'+preview.operationId)).phase,'needs-attention');
 assert.equal(hash(await fs.readFile(path.join(f.root,f.template.files[0].path))),f.template.files[0].sha256);
});

let contentsId=0;
// Electron transport boundary only: the manager, workspace owner registry,
// host, project storage, file writes and lifecycle are production modules.
class BoundaryContents extends EventEmitter{
 constructor(){super();this.id=++contentsId;this.sent=[];this.mainFrame={url:'http://127.0.0.1:9000/',parent:null};}
 setWindowOpenHandler(){}
 send(channel,payload){this.sent.push({channel,payload});this.onSend?.(channel,payload);}
 isDestroyed(){return false;}
}
async function demoFixture(t){
 const directory=await scratch(t),userDataDir=path.join(directory,'profile'),examplesRoot=path.join(directory,'examples'),host=new DesktopHost(userDataDir);
 closers.get(directory).push(()=>host.storage.db.close());
 const workspace=new WorkspaceNative({host,userDataDir,origin:'http://127.0.0.1:9000/'});
 const events=[],manager=await createGuidedDemo({host,userDataDir,examplesRoot,appRoot,workspace,onEvent:event=>events.push(event)});
 workspace.guidedDemo=manager;host.guidedDemo=manager;
 manager.lifecycle=new ProjectLifecycle({host,workspace:{layouts:new Map(),closeProject:async()=>{throw Error('preview must never close a project');}},managed:{stopProject:async()=>{throw Error('preview must never stop writers');}},trashItem:async()=>{throw Error('preview must never trash files');}});
 const created=await manager.create({confirmed:true}),scope=workspace.register(new BoundaryContents(),{role:'shell',projectId:created.project.id,windowId:'main'});
 scope.ready=true;
 return {directory,userDataDir,examplesRoot,host,workspace,manager,created,scope,events};
}
const binding=value=>({projectId:value.project.id,sessionId:value.session.id,epoch:value.session.epoch});
async function bounded(promise,label,ms=3000){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);}
 finally{clearTimeout(timer);}
}
async function settlePending(f){
 for(const [requestId,pending] of f.workspace.demoRequests||[]){
  await f.manager.result(pending.record,{projectId:pending.record.projectId,sessionId:pending.sessionId,epoch:pending.epoch,requestId,ok:false,error:{code:'QA_ABORTED',message:'Test cleanup'}});
 }
}

test('manager requires explicit creation, stores private ownership, and stopped manual sends stay fixed offline content',async t=>{
 const f=await demoFixture(t),id=f.created.project.id;
 await assert.rejects(f.manager.create({confirmed:false}),{code:'DEMO_CONFIRM_REQUIRED'});
 assert.equal(f.created.session.status,'paused');assert.equal(f.created.source,'demo-fixture');
 const stopped=await f.manager.invoke(f.scope,'demo.transition',{...binding(f.created),action:'stop'});
 assert.equal(f.manager.isDemo(id),true);assert.equal(stopped.session.status,'stopped');
 const first=await f.manager.managed('managed.send',{projectId:id,text:'offline question',requestKey:'same-send'});
 const again=await f.manager.managed('managed.send',{projectId:id,text:'offline question',requestKey:'same-send'});
 assert.deepEqual(again,first);assert.equal(first.source,'demo-fixture');
 await assert.rejects(f.manager.managed('managed.send',{projectId:id,text:'different question',requestKey:'same-send'}),{code:'DEMO_REQUEST_COLLISION'});
 const status=await f.manager.managed('managed.status',{projectId:id});
 assert.equal(status.ready,false);assert.equal(status.source,'demo-fixture');
 assert.deepEqual(status.state.agents,[]);assert.deepEqual(status.state.works,[]);
 assert.equal(status.state.messages.length,2);assert.equal(status.state.messages[1].requestId,first.requestId);
 assert.equal(status.state.messages.every(message=>message.source==='demo-fixture'),true);
 for(const op of ['managed.restart','managed.terminal.attach','managed.binding','managed.models'])await assert.rejects(f.manager.managed(op,{projectId:id}),{code:'DEMO_NATIVE_DISABLED'});
});

test('copying project metadata never copies private demo ownership or cleanup authority',async t=>{
 const f=await demoFixture(t),original=await f.host.requireProject(f.created.project.id),copy=path.join(f.directory,'user-copy');
 await f.host.storage.closeProjectHandles(original.id);
 await fs.cp(original.root,copy,{recursive:true});
 const copied=await f.host.storage.register(copy);
 assert.notEqual(copied.id,original.id);assert.equal(f.manager.isDemo(copied.id),false);
 await assert.rejects(f.manager.cleanupPreview({...binding(f.created),projectId:copied.id}),{code:'DEMO_NOT_OWNED'});
 assert.equal((await fs.stat(copy)).isDirectory(),true);
});

test('manager refuses changed root and manifest authority and never routes replacement content',async t=>{
 for(const kind of ['root','manifest']){
  const f=await demoFixture(t),id=f.created.project.id,project=await f.host.requireProject(id);
  if(kind==='root'){
   const retained=path.join(f.directory,'retained-original');
   await fs.rename(project.root,retained);await fs.mkdir(project.root);
   assert.equal(hash(await fs.readFile(path.join(retained,'research-notes.txt'))),hash(await fs.readFile(path.join(appRoot,'assets','guided-demo','research-notes.txt'))));
   await fs.writeFile(path.join(project.root,'user.txt'),'replacement user content');
  }else{
   const manifest=path.join(project.root,'.nozeli','project.json');
   await fs.appendFile(manifest,' ');
  }
  const state=await f.manager.state({projectId:id});assert.equal(state.available,false);
  await assert.rejects(f.manager.send({projectId:id,text:'must not fall back'}),{code:'DEMO_IDENTITY_CHANGED'});
  await assert.rejects(f.manager.cleanupPreview(binding(f.created)),{code:'DEMO_IDENTITY_CHANGED'});
  assert.equal(f.manager.isDemo(id),true,'invalid ownership remains a fail-closed native tombstone');
  assert.equal([...f.workspace.senders.values()].some(record=>record.wc.sent.some(event=>event.payload?.type==='demo-action')),false);
  if(kind==='root')assert.equal(await fs.readFile(path.join(project.root,'user.txt'),'utf8'),'replacement user content');
 }
});

test('restart persists paused status and invalidates previous epochs without replaying sends or edits',async t=>{
 const f=await demoFixture(t),playing=await f.manager.transition({...binding(f.created),action:'play'});
 await f.manager.send({...binding(playing),text:'preserved request',requestKey:'before-restart'});
 const restarted=await createGuidedDemo({host:f.host,userDataDir:f.userDataDir,examplesRoot:f.examplesRoot,appRoot,workspace:f.workspace});
 const recovered=await restarted.state({projectId:playing.project.id});
 assert.equal(recovered.session.status,'paused');assert.equal(recovered.session.recovered,true);
 assert.ok(recovered.session.epoch>playing.session.epoch);
 await assert.rejects(restarted.transition({...binding(playing),action:'play'}),{code:'DEMO_SESSION_STALE'});
 assert.equal((await restarted.managed('managed.status',{projectId:playing.project.id})).state.messages.length,2);
});

test('replay and cleanup preserve simultaneous visible and hidden user changes instead of blessing baseline',async t=>{
 const f=await demoFixture(t),project=await f.host.requireProject(f.created.project.id);
 const before=await f.host.readFile(project.id,'research-notes.txt');
 await f.host.save(project.id,'research-notes.txt',before.digest,before.text+'\nUser exploration\n');
 await fs.writeFile(path.join(project.root,'.user-draft'),'concurrent hidden user content');
 await assert.rejects(f.manager.transition({...binding(f.created),action:'restart'}),{code:'DEMO_COPY_REQUIRED'});
 await assert.rejects(f.manager.guardLifecycle(project.id),{code:'DEMO_USER_CONTENT_RETAINED'});
 const preview=await f.manager.cleanupPreview({...binding(f.created),action:'delete-project'}),changes=preview.changes;
 assert.equal(preview.preserveByDefault,true);assert.equal(preview.canAutomaticallyDelete,false);
 assert.ok(changes.some(row=>row.path==='research-notes.txt'&&row.kind==='modified'));
 assert.ok(changes.some(row=>row.path==='.user-draft'&&row.kind==='added'));
 assert.equal(await fs.readFile(path.join(project.root,'.user-draft'),'utf8'),'concurrent hidden user content');
});

test('real workspace relay binds sender and generation; paused late atomic save stays paused on original session',async t=>{
 const f=await demoFixture(t),playing=await f.manager.transition({...binding(f.created),action:'play'}),projectId=playing.project.id;
 const surface=f.workspace.register(new BoundaryContents(),{role:'surface',kind:'document',projectId,viewId:'notes',relPath:'research-notes.txt',windowId:'main'});
 surface.ready=true;
 f.workspace.surfaces.set(surface.viewId,surface);
 let accept;const dispatched=new Promise(resolve=>{accept=resolve;});
 surface.wc.onSend=(channel,payload)=>{if(channel==='nozeli:workspace-control'&&payload.type==='demo-action')accept(payload);};
 const operation=f.manager.perform(f.scope,{...binding(playing),command:'document.edit',viewId:surface.viewId,relPath:surface.relPath});
 operation.catch(()=>{});
 try{
 const action=await bounded(Promise.race([dispatched,operation.then(()=>{throw Error('perform settled without a relay');})]),'relay dispatch');
 const other=f.workspace.register(new BoundaryContents(),{role:'surface',kind:'document',projectId,viewId:'other',windowId:'main'});
 const receipt={projectId,sessionId:action.sessionId,epoch:action.epoch,requestId:action.requestId,ok:true};
 await assert.rejects(f.manager.result(other,receipt),{code:'DEMO_RECEIPT_DENIED'});
 await assert.rejects(f.manager.result(surface,{...receipt,epoch:receipt.epoch+1}),{code:'DEMO_RECEIPT_DENIED'});
 await assert.rejects(f.manager.result(surface,{...receipt,sessionId:'forged-session'}),{code:'DEMO_RECEIPT_DENIED'});
 await assert.rejects(f.manager.result(surface,{...receipt,projectId:'foreign-project'}),{code:'DEMO_RECEIPT_DENIED'});
 const generation=surface.generation;
 try{surface.generation++;await assert.rejects(f.manager.result(surface,receipt),{code:'DEMO_RECEIPT_DENIED'});}
 finally{surface.generation=generation;}
 const paused=await f.manager.transition({...binding(playing),action:'pause'});
 await assert.rejects(f.manager.perform(f.scope,{...binding(paused),command:'document.edit'}),{code:'DEMO_PAUSED'});
 await assert.rejects(f.manager.transition({...binding(paused),action:'advance'}),{code:'DEMO_PAUSED'});
 const file=await f.host.readFile(projectId,surface.relPath);
 const saved=await f.host.save(projectId,surface.relPath,file.digest,file.text+'\nAccepted atomic save\n');
 await f.manager.result(surface,{...receipt,value:{digest:saved.digest}});
 const result=await bounded(operation,'relay settlement');assert.equal(result.projectId,projectId);assert.equal(result.epoch,playing.session.epoch);
 const state=await f.manager.state({projectId});assert.equal(state.session.status,'paused');assert.equal(state.session.epoch,paused.session.epoch);
 assert.equal((await f.host.readFile(projectId,surface.relPath)).text.endsWith('Accepted atomic save\n'),true);
 await assert.rejects(f.manager.result(surface,receipt),{code:'DEMO_RECEIPT_DENIED'});
 await assert.rejects(f.manager.transition({...binding(playing),action:'advance'}),{code:'DEMO_SESSION_STALE'});
 await assert.rejects(f.manager.transition({...binding(paused),action:'advance'}));
 const resumed=await f.manager.transition({...binding(state),action:'play'});
 assert.equal(resumed.session.stepIndex,playing.session.stepIndex+1,'A confirmed original save must not be dispatched again after explicit continue');
 }finally{await settlePending(f);await bounded(operation.catch(()=>{}),'relay cleanup');}
});

test('concurrent same-key sends expose one accepted request and exactly one user/reply pair',async t=>{
 const f=await demoFixture(t),projectId=f.created.project.id;
 const payload={projectId,text:'one concurrent request',requestKey:'concurrent-consumer-key'};
 const [first,second]=await Promise.all([f.manager.managed('managed.send',payload),f.manager.managed('managed.send',payload)]);
 assert.equal(first.requestId,second.requestId);
 const page=await f.manager.managed('managed.timeline.page',{projectId});
 assert.equal(page.entries.length,2);
 assert.deepEqual(page.entries.map(row=>row.speaker),['user','agent']);
 assert.equal(new Set(page.entries.map(row=>row.requestId)).size,1);
});

test('foreign-project sender cannot interrupt a known demo session',async t=>{
 const f=await demoFixture(t),playing=await f.manager.transition({...binding(f.created),action:'play'});
 const foreign=f.workspace.register(new BoundaryContents(),{role:'surface',kind:'document',projectId:'unrelated-project',viewId:'foreign'});
 await assert.rejects(f.manager.invoke(foreign,'demo.interrupt',{...binding(playing),reason:'foreign interruption'}),{code:'DEMO_SCOPE_DENIED'});
 const state=await f.manager.state({projectId:playing.project.id});
 assert.equal(state.session.status,'playing');assert.equal(state.session.epoch,playing.session.epoch);
});

test('automatic advance cannot restart paused or stopped sessions and old epochs are rejected',async t=>{
 for(const action of ['pause','stop']){
  const f=await demoFixture(t),playing=await f.manager.transition({...binding(f.created),action:'play'});
  const settled=await f.manager.transition({...binding(playing),action});
  await assert.rejects(f.manager.transition({...binding(playing),action:'advance'}),{code:'DEMO_SESSION_STALE'});
  await assert.rejects(f.manager.transition({...binding(settled),action:'advance'}));
  const state=await f.manager.state({projectId:playing.project.id});
  assert.equal(state.session.status,settled.session.status);assert.equal(state.session.stepIndex,settled.session.stepIndex);
 }
});

test('same-byte manifest inode replacement invalidates operation authority but retains the offline tombstone',async t=>{
 const f=await demoFixture(t),projectId=f.created.project.id,project=await f.host.requireProject(projectId);
 const manifest=path.join(project.root,'.nozeli','project.json'),bytes=await fs.readFile(manifest),retained=manifest+'.retained';
 await fs.rename(manifest,retained);await fs.writeFile(manifest,bytes);
 const oldStat=await fs.stat(retained,{bigint:true}),newStat=await fs.stat(manifest,{bigint:true});
 assert.notEqual(String(oldStat.ino),String(newStat.ino));
 await assert.rejects(f.manager.verify(projectId),{code:'DEMO_IDENTITY_CHANGED'});
 await assert.rejects(f.manager.cleanupPreview(binding(f.created)),{code:'DEMO_IDENTITY_CHANGED'});
 assert.equal(f.manager.isDemo(projectId),true);
 assert.deepEqual(await fs.readFile(manifest),bytes);assert.deepEqual(await fs.readFile(retained),bytes);
});

test('replacing a tutorial file with a link is retained as unknown content without reading or overwriting its target',async t=>{
 const f=await demoFixture(t),projectId=f.created.project.id,project=await f.host.requireProject(projectId);
 const relPath='research-notes.txt',original=path.join(f.directory,'original-notes'),outside=path.join(f.directory,'user-notes');
 const bytes=await fs.readFile(path.join(project.root,relPath));
 await fs.rename(path.join(project.root,relPath),original);await fs.writeFile(outside,'private unrelated content');
 await fs.symlink(outside,path.join(project.root,relPath));
 await assert.rejects(f.manager.guardLifecycle(projectId),{code:'DEMO_USER_CONTENT_RETAINED'});
 await assert.rejects(f.manager.transition({...binding(f.created),action:'restart'}),{code:'DEMO_COPY_REQUIRED'});
 assert.equal(await fs.readFile(outside,'utf8'),'private unrelated content');assert.deepEqual(await fs.readFile(original),bytes);
});

test('a same-path regular-file replacement is user content rather than an approved tutorial mutation',async t=>{
 const f=await demoFixture(t),projectId=f.created.project.id,project=await f.host.requireProject(projectId);
 const file=path.join(project.root,'research-notes.txt'),retained=path.join(f.directory,'retained-notes');
 await fs.rename(file,retained);await fs.writeFile(file,'replacement user document');
 await assert.rejects(f.manager.guardLifecycle(projectId),{code:'DEMO_USER_CONTENT_RETAINED'});
 assert.equal(await fs.readFile(file,'utf8'),'replacement user document');
 assert.equal(hash(await fs.readFile(retained)),hash(await fs.readFile(path.join(appRoot,'assets','guided-demo','research-notes.txt'))));
});

test('manager cleanup previews real lifecycle range without authorizing automatic final deletion',async t=>{
 const f=await demoFixture(t),projectId=f.created.project.id;
 const preview=await f.manager.invoke(f.scope,'demo.cleanupPreview',{...binding(f.created),action:'delete-project'});
 assert.equal(preview.requiresUserConfirmation,true);assert.equal(preview.canAutomaticallyDelete,false);
 assert.equal(preview.lifecycle.projectId,projectId);assert.equal(preview.lifecycle.permanentDelete,false);
 assert.deepEqual(preview.lifecycle.removeDirectories,[f.created.project.rootDisplay]);
 assert.equal((await fs.stat(f.created.project.rootDisplay)).isDirectory(),true);
 assert.equal((await f.host.storage.requireRegistered(projectId)).removed,false);
});

test('semantic perform denies foreign sender, unlisted command and non-template file before dispatch',async t=>{
 const f=await demoFixture(t),playing=await f.manager.transition({...binding(f.created),action:'play'});
 const foreign=f.workspace.register(new BoundaryContents(),{role:'shell',projectId:'other-project'});
 await assert.rejects(f.manager.invoke(foreign,'demo.perform',{...binding(playing),command:'document.edit'}),{code:'DEMO_SCOPE_DENIED'});
 await assert.rejects(f.manager.perform(f.scope,{...binding(playing),command:'javascript.eval',args:{code:'anything'}}),{code:'DEMO_COMMAND_DENIED'});
 await assert.rejects(f.manager.perform(f.scope,{...binding(playing),command:'document.edit',relPath:'user-private.txt'}),{code:'DEMO_FILE_DENIED'});
 assert.equal([...f.workspace.senders.values()].some(record=>record.wc.sent.some(event=>event.payload?.type==='demo-action')),false);
});

test('example directory cannot contain or descend from the application profile',async t=>{
 const directory=await scratch(t),userDataDir=path.join(directory,'profile'),host=new DesktopHost(userDataDir);
 closers.get(directory).push(()=>host.storage.db.close());
 for(const examplesRoot of [userDataDir,path.join(userDataDir,'examples'),directory]){
  await assert.rejects(createGuidedDemo({host,userDataDir,examplesRoot,appRoot}),{code:'DEMO_ROOT_DENIED'});
 }
});

test('demo deletion defaults to retention and explicit whole-copy consent is invalidated by later user edits',async t=>{
 const f=await demoFixture(t),projectId=f.created.project.id,root=f.created.project.rootDisplay,events=[],trash=path.join(f.directory,'consented-trash');
 await fs.mkdir(trash);await fs.mkdir(path.join(root,'my-empty-folder'));
 const note=path.join(root,'my-exploration.txt');await fs.writeFile(note,'User exploration A');
 const lifecycle=new ProjectLifecycle({host:f.host,workspace:{layouts:new Map(),closeProject:async()=>{events.push('close');return {closed:true};}},managed:{stopProject:async()=>{events.push('stop');return {confirmationComplete:true};}},trashItem:async directory=>{events.push('trash');await fs.rename(directory,path.join(trash,path.basename(directory)));}});
 f.manager.lifecycle=lifecycle;
 const first=await lifecycle.preview({projectId,action:'delete-project'});
 assert.equal(first.preserveByDefault,true);assert(first.demoChanges.some(change=>change.path==='my-empty-folder'));
 await assert.rejects(lifecycle.execute({token:first.token}),{code:'DEMO_USER_CONTENT_RETAINED'});assert.deepEqual(events,[]);
 const second=await lifecycle.preview({projectId,action:'delete-project'});await fs.appendFile(note,' plus B');
 await assert.rejects(lifecycle.execute({token:second.token,allowDemoChanges:true}),{code:'DEMO_CONTENT_CHANGED'});assert.deepEqual(events,[]);assert.equal(await fs.readFile(note,'utf8'),'User exploration A plus B');
 const final=await lifecycle.preview({projectId,action:'delete-project'}),receipt=await lifecycle.execute({token:final.token,allowDemoChanges:true});
 assert.equal(receipt.complete,true);assert.equal(receipt.trashed,true);assert.deepEqual(events,['stop','close','trash']);
 assert.equal(await fs.readFile(path.join(trash,path.basename(root),'my-exploration.txt'),'utf8'),'User exploration A plus B');
 assert.equal((await fs.stat(path.join(trash,path.basename(root),'my-empty-folder'))).isDirectory(),true);
 assert.equal((await f.manager.state({projectId})).session.status,'removed');
});
