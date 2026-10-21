import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceNative, restoreBounds } from '../src/main/workspace-native.mjs';
import { createLayout, reduceLayout } from '../src/domain/workspace-layout.mjs';
let sequence=0;
class Contents extends EventEmitter {
  constructor(){super();this.id=++sequence;this.mainFrame={url:'http://127.0.0.1:9000/',parent:null};this.sent=[];}
  setWindowOpenHandler(){} send(channel,payload){this.sent.push({channel,payload});this.onSend?.(channel,payload);} async loadURL(){} close(){this.emit('destroyed');} isDestroyed(){return false;}
}
class View { constructor(){this.webContents=new Contents();}setVisible(value){this.visible=value;}setBounds(value){this.bounds=value;}getBounds(){return this.bounds||{x:0,y:0,width:500,height:500};} }
class Window extends EventEmitter {
 constructor(options={}){super();this.options=options;this.webContents=new Contents();this.children=[];this.contentView={addChildView:v=>this.children.push(v),removeChildView:v=>{this.children=this.children.filter(x=>x!==v);}};this.bounds={x:0,y:0,width:1000,height:760};}
 async loadURL(){}show(){}focus(){}getBounds(){return this.bounds;}getContentBounds(){return this.bounds;}getContentSize(){return [1000,760];}isAlwaysOnTop(){return false;}isDestroyed(){return !!this.destroyed;}destroy(){this.destroyed=true;this.webContents.emit('destroyed');this.emit('closed');}
}
async function fixture(t){const directory=await mkdtemp(path.join(os.tmpdir(),'workspace-native-'));t.after(()=>rm(directory,{recursive:true,force:true}));const host={requireProject:async id=>({id}),readState:async()=>({workspace:{minimized:true}}),settled:async()=>{}};const native=new WorkspaceNative({BrowserWindow:Window,WebContentsView:View,screen:{getDisplayMatching:()=>({workArea:{x:-1920,y:0,width:1920,height:1080}})},origin:'http://127.0.0.1:9000/',userDataDir:directory,host});const root=native.registerShell(new Window());root.projectId='p';root.ready=true;native.layouts.set('p',createLayout('p',{workspace:{minimized:true}}));return {native,root};}
function receipt(native,r,ok=true){r.ready=true;r.wc.onSend=(channel,payload)=>{if(channel==='nozeli:flush')queueMicrotask(()=>native.acknowledge(r,{requestId:payload,ok}));};}
test('registered top-frame scope rejects iframe, foreign project and unknown sender',async t=>{const {native,root}=await fixture(t),event={sender:root.wc,senderFrame:root.wc.mainFrame};assert.equal(native.authorize(event,'state.read',{projectId:'p'}),root);assert.throws(()=>native.authorize(event,'state.read',{projectId:'foreign'}),{code:'PROJECT_SCOPE_DENIED'});assert.throws(()=>native.authorize({...event,senderFrame:{url:native.origin,parent:{}}},'state.read',{}),{code:'IPC_DENIED'});assert.throws(()=>native.authorize({sender:new Contents(),senderFrame:root.wc.mainFrame},'state.read',{}),{code:'IPC_DENIED'});});
test('CAS and request-key replay are authoritative',async t=>{const {native,root}=await fixture(t);const payload={projectId:'p',expectedRevision:0,requestKey:'first',command:{type:'split',groupId:native.layouts.get('p').mainRoot.id,axis:'x',side:'after'}};const result=await native.command(root,payload);assert.equal(result.layout.revision,1);assert.equal(await native.command(root,payload),result);await assert.rejects(native.command(root,{...payload,requestKey:'second'}),{code:'LAYOUT_STALE'});});
test('flush receipts cannot be forged by another owner or old generation',async t=>{const {native,root}=await fixture(t),other=native.register(new Contents(),{role:'surface',projectId:'p',viewId:'other'});const pending=native.flushOne(root);const requestId=root.wc.sent.at(-1).payload;assert.deepEqual(native.acknowledge(other,{requestId,ok:true}),{accepted:false});assert.deepEqual(native.acknowledge(root,{requestId,ok:false,error:{code:'UNSAVED'}}),{accepted:true});await assert.rejects(pending,{code:'UNSAVED'});});
test('detach and dock keep the identical live WebContentsView without loading it again',async t=>{const {native,root}=await fixture(t);let layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'a.txt'}});native.layouts.set('p',layout);await native.reconcile(layout);const surface=[...native.surfaces.values()][0],view=surface.view,wc=surface.wc;receipt(native,surface);native.detached=async(_layout,item)=>{let r=native.windows.get(item.id);if(r)return r;r=native.register(new Contents(),{role:'detached',windowId:item.id,projectId:'p',win:new Window()});r.ready=true;native.windows.set(item.id,r);return r;};const detached=await native.command(root,{projectId:'p',expectedRevision:layout.revision,requestKey:'detach',command:{type:'detach',viewId:surface.viewId}});assert.equal(native.surfaces.get(surface.viewId).view,view);assert.equal(native.surfaces.get(surface.viewId).wc,wc);assert.notEqual(surface.windowId,'main');assert.equal(native.windows.get(surface.windowId).win.options.parent,undefined);await native.command(root,{projectId:'p',expectedRevision:detached.layout.revision,requestKey:'dock',command:{type:'dock',windowId:surface.windowId}});assert.equal(surface.windowId,'main');assert.equal(surface.wc,wc);});
test('failed flush leaves layout, native owner and source alive',async t=>{const {native,root}=await fixture(t);let layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'a.txt'}});native.layouts.set('p',layout);await native.reconcile(layout);const surface=[...native.surfaces.values()][0];receipt(native,surface,false);await assert.rejects(native.command(root,{projectId:'p',expectedRevision:layout.revision,requestKey:'close',command:{type:'close',viewId:surface.viewId}}),{code:'FLUSH_FAILED'});assert.equal(native.layouts.get('p'),layout);assert.equal(surface.windowId,'main');assert.equal(surface.dead,false);});
test('shell close preserves detached windows and does not stop project services',async t=>{const {native,root}=await fixture(t);receipt(native,root);const child=native.register(new Contents(),{role:'detached',windowId:'detached',projectId:'p',win:new Window()});native.windows.set('detached',child);native.onClose=()=>assert.fail('must not stop application');await native.closeWindow(root);assert.equal(root.win.destroyed,true);assert.equal(child.win.isDestroyed(),false);assert.equal(native.windows.has('detached'),true);});
test('saved negative desktop coordinates remain in DIP work area',()=>{assert.deepEqual(restoreBounds({x:-1800,y:40,width:900,height:700},{getDisplayMatching:()=>({workArea:{x:-1920,y:0,width:1920,height:1080}})}),{x:-1800,y:40,width:900,height:700});});
test('edit lease belongs to exact document sender and survives another view bootstrap',async t=>{const {native,root}=await fixture(t);const owner=native.register(new Contents(),{role:'surface',projectId:'p',viewId:'owner',windowId:'main',relPath:'a.txt',kind:'document'}),other=native.register(new Contents(),{role:'surface',projectId:'p',viewId:'other',windowId:'main',relPath:'a.txt',kind:'document'});native.bootstrap(owner);assert.equal(native.bootstrap(other).readOnly,true);const event=r=>({sender:r.wc,senderFrame:r.wc.mainFrame});assert.equal(native.authorize(event(owner),'file.save',{projectId:'p',relPath:'a.txt'}),owner);assert.throws(()=>native.authorize(event(other),'file.save',{projectId:'p',relPath:'a.txt'}),{code:'EDIT_LEASE_DENIED'});assert.throws(()=>native.authorize(event(root),'file.save',{projectId:'p',relPath:'a.txt'}),{code:'EDIT_LEASE_DENIED'});});
test('annotation ID mutation resolves persisted resource, rejecting foreign documents',async t=>{const {native}=await fixture(t);native.host.tagStore=async()=>({all:async()=>[{file:{relPath:'a.txt'},tags:[{id:'note-a'}]},{file:{relPath:'b.txt'},tags:[{id:'note-b'}]}]});const r=native.register(new Contents(),{role:'surface',projectId:'p',viewId:'owner',windowId:'main',relPath:'a.txt',kind:'document'});native.bootstrap(r);const payload=await native.resolvePayload(r,'annotation.remove',{projectId:'p',annotationId:'note-a'});assert.equal(payload.relPath,'a.txt');assert.equal(native.authorize({sender:r.wc,senderFrame:r.wc.mainFrame},'annotation.remove',payload),r);await assert.rejects(native.resolvePayload(r,'annotation.update',{projectId:'p',annotationId:'note-b'}),{code:'EDIT_LEASE_DENIED'});});
test('surface flushing waits for content initialization before requesting a save',async t=>{const {native}=await fixture(t);const r=native.register(new Contents(),{role:'surface',projectId:'p',viewId:'owner',windowId:'main',kind:'document',relPath:'a.txt'});await native.invoke(r,'workspace.ready',{});assert.equal(r.ready,false);const pending=native.flushOne(r);await Promise.resolve();assert.equal(r.wc.sent.some(entry=>entry.channel==='nozeli:flush'),false);receipt(native,r);await native.invoke(r,'workspace.ready',{contentReady:true});await pending;assert.equal(r.ready,true);assert.equal(r.wc.sent.filter(entry=>entry.channel==='nozeli:flush').length,1);});
test('recovery hold rejects Office draft/export and annotation mutations',async t=>{const {native}=await fixture(t);const r=native.register(new Contents(),{role:'surface',projectId:'p',viewId:'owner',windowId:'main',kind:'document',relPath:'a.pptx'});native.bootstrap(r);r.recoveryHeld=true;const event={sender:r.wc,senderFrame:r.wc.mainFrame};for(const [op,extra]of [['ppt.draft',{model:{slides:[]}}],['ppt.export',{}],['tag.view',{}],['annotation.remove',{}]])assert.throws(()=>native.authorize(event,op,{projectId:'p',relPath:'a.pptx',...extra}),{code:'TRANSFER_HELD'});});
for(const failure of ['attach','persist'])test(`failed ${failure} rolls native parent back without committing layout or destroying editor`,async t=>{
  const {native,root}=await fixture(t);
  const layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'a.txt'}});
  native.layouts.set('p',layout);await native.reconcile(layout);
  const surface=[...native.surfaces.values()][0],view=surface.view,wc=surface.wc;
  surface.view.setBounds({x:40,y:70,width:600,height:400});native.bootstrap(surface);receipt(native,surface);
  let target,persistCalls=0;
  native.detached=async(_layout,item)=>{
    const existing=native.windows.get(item.id);if(existing)return existing;
    target=new Window();
    if(failure==='attach')target.contentView.addChildView=()=>{throw Object.assign(new Error('Native attachment failed'),{code:'ATTACH_FAILED'});};
    const r=native.register(target.webContents,{role:'detached',windowId:item.id,projectId:'p',win:target});r.ready=true;native.windows.set(item.id,r);return r;
  };
  native.persist=async()=>{
    persistCalls++;
    assert.equal(target.children.includes(view),true,'same live native view staged before persistence');
    assert.equal(root.win.children.includes(view),false);
    assert.equal(surface.windowId,'main','ownership remains source until durable commit');
    throw Object.assign(new Error('Disk unavailable'),{code:'PERSIST_FAILED'});
  };
  await assert.rejects(native.command(root,{projectId:'p',expectedRevision:layout.revision,requestKey:'detach-failure',command:{type:'detach',viewId:surface.viewId}}),{code:failure==='attach'?'ATTACH_FAILED':'PERSIST_FAILED'});
  assert.equal(persistCalls,failure==='attach'?0:1);
  assert.equal(native.layouts.get('p'),layout);assert.equal(surface.view,view);assert.equal(surface.wc,wc);
  assert.equal(surface.win,root.win);assert.equal(surface.windowId,'main');assert.equal(surface.dead,false);
  assert.equal(root.win.children.filter(child=>child===view).length,1);assert.equal(target.children.includes(view),false);
  assert.deepEqual(surface.view.getBounds(),{x:40,y:70,width:600,height:400});
  assert.equal(native.leases.get(native.resource('p','a.txt')).windowId,'main');
  assert.equal(wc.sent.some(event=>event.channel==='nozeli:workspace-control'&&event.payload.type==='host'),false);
  assert.equal(target.isDestroyed(),true);assert.equal(surface.held,false);assert.equal(surface.transferring,false);
});
test('trash records host digest after flush and explicit recovery only accepts identical restored source',async t=>{
  const {native,root}=await fixture(t);
  const layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'a.txt'}});
  native.layouts.set('p',layout);await native.reconcile(layout);
  const surface=[...native.surfaces.values()][0];receipt(native,surface);native.bootstrap(surface);
  let disk={relPath:'a.txt',digest:'retained-digest',diskPresent:true,text:'retained'},readCount=0;
  native.host.readFile=async(projectId,relPath)=>{assert.equal(projectId,'p');assert.equal(relPath,'a.txt');assert.equal(surface.held,true);readCount++;return disk;};
  await native.mutateTree({projectId:'p',action:'trash',source:'a.txt'},async()=>{
    assert.equal(readCount,1);assert.equal(surface.missingDigest,'retained-digest');disk={relPath:'a.txt',diskPresent:false,digest:null};return {removed:'a.txt'};
  });
  assert.equal(surface.recoveryHeld,true);assert.equal(surface.held,true);assert.equal(native.surfaces.get(surface.viewId),surface);
  const payload={projectId:'p',relPath:'a.txt'};
  await assert.rejects(native.invoke(root,'workspace.recoverResource',payload),{code:'PROJECT_SCOPE_DENIED'});
  await assert.rejects(native.invoke(surface,'workspace.recoverResource',{...payload,relPath:'b.txt'}),{code:'PROJECT_SCOPE_DENIED'});
  await assert.rejects(native.invoke(surface,'workspace.recoverResource',payload),{code:'RESOURCE_MISSING'});
  disk={relPath:'a.txt',digest:'different-digest',diskPresent:true,text:'other'};
  await assert.rejects(native.invoke(surface,'workspace.recoverResource',payload),{code:'CONFLICT'});
  assert.equal(surface.recoveryHeld,true);assert.equal(surface.held,true);assert.equal(surface.missingDigest,'retained-digest');
  disk={relPath:'a.txt',digest:'retained-digest',diskPresent:true,text:'retained'};
  assert.equal(await native.invoke(surface,'workspace.recoverResource',payload),disk);
  assert.equal(surface.recoveryHeld,false);assert.equal(surface.held,false);assert.equal(surface.missingDigest,undefined);
  assert.deepEqual(surface.wc.sent.at(-1),{channel:'nozeli:workspace-control',payload:{type:'transfer-hold',held:false}});
  assert.equal(native.authorize({sender:surface.wc,senderFrame:surface.wc.mainFrame},'file.save',payload),surface);
});
test('loading a named arrangement preserves reopened resource identities, navigation and extra opened files',async t=>{
  const {native,root}=await fixture(t);
  const saved=createLayout('p',{openFiles:['a.txt']});
  await native.namedLayouts.save('p','Reading',saved);
  const current=createLayout('p',{openFiles:['a.txt','extra.txt']});
  const reopened=Object.values(current.views).find(view=>view.relPath==='a.txt'),extra=Object.values(current.views).find(view=>view.relPath==='extra.txt'),conversation=Object.values(current.views).find(view=>view.kind==='conversation');
  reopened.viewState={scrollTop:314,selection:{anchor:7,head:12}};
  const before=structuredClone(current);
  native.layouts.set('p',current);await native.reconcile(current);
  for(const surface of native.surfaces.values())receipt(native,surface);
  const restored=(await native.invoke(root,'workspace.layouts.load',{projectId:'p',name:'Reading'})).layout;
  assert.equal(restored.mainRoot.activeViewId,reopened.id);
  assert.deepEqual(restored.views[reopened.id].viewState,reopened.viewState);
  assert.deepEqual(restored.views[extra.id],extra);
  assert.deepEqual(Object.values(restored.views).filter(view=>view.kind==='conversation').map(view=>view.id),[conversation.id]);
  assert.deepEqual(current,before,'loading cannot mutate the previous layout while committing a replacement');
});

test('frontdesk context clear is limited to shell or same-project conversation surface',async t=>{
 const {native,root}=await fixture(t),op='managed.frontdesk.context.clear',event=r=>({sender:r.wc,senderFrame:r.wc.mainFrame});
 assert.equal(native.authorize(event(root),op,{projectId:'p'}),root);
 const conversation=native.register(new Contents(),{role:'surface',projectId:'p',viewId:'conversation',windowId:'main',kind:'conversation'});assert.equal(native.authorize(event(conversation),op,{projectId:'p'}),conversation);
 const document=native.register(new Contents(),{role:'surface',projectId:'p',viewId:'document',windowId:'main',kind:'document',relPath:'a.txt'});assert.throws(()=>native.authorize(event(document),op,{projectId:'p'}),{code:'CONVERSATION_OWNER_REQUIRED'});assert.throws(()=>native.authorize(event(conversation),op,{projectId:'foreign'}),{code:'PROJECT_SCOPE_DENIED'});
});
