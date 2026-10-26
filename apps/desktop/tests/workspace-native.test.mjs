import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceNative, restoreBounds } from '../src/main/workspace-native.mjs';
import { createLayout, reduceLayout } from '../src/domain/workspace-layout.mjs';
import {IsolatedPreviewManager} from '../src/main/isolated-preview.mjs';
import {testStorageOptions} from './project-storage.fixture.mjs';
import {WorkspaceCapture} from '../src/main/workspace-capture.mjs';
import {WorkspaceCaptureStore} from '../src/main/workspace-capture-store.mjs';
import {ProjectAttachments} from '../src/main/project-attachments.mjs';
let sequence=0;
class Contents extends EventEmitter {
  constructor(){super();this.id=++sequence;this.mainFrame={url:'http://127.0.0.1:9000/',parent:null};this.sent=[];}
  setWindowOpenHandler(){} send(channel,payload){this.sent.push({channel,payload});this.onSend?.(channel,payload);} async loadURL(){} close(){this.emit('destroyed');} isDestroyed(){return false;}
  setBackgroundThrottling(value){this.backgroundThrottling=value;}
}
class View { constructor(){this.webContents=new Contents();}setVisible(value){this.visible=value;}setBounds(value){this.bounds=value;}getBounds(){return this.bounds||{x:0,y:0,width:500,height:500};} }
class Window extends EventEmitter {
 constructor(options={}){super();this.options=options;this.webContents=new Contents();this.children=[];this.contentView={addChildView:v=>this.children.push(v),removeChildView:v=>{this.children=this.children.filter(x=>x!==v);}};this.bounds={x:0,y:0,width:1000,height:760};}
 async loadURL(){}show(){}focus(){}getBounds(){return this.bounds;}getContentBounds(){return this.bounds;}getContentSize(){return [1000,760];}isAlwaysOnTop(){return false;}isDestroyed(){return !!this.destroyed;}destroy(){this.destroyed=true;this.webContents.emit('destroyed');this.emit('closed');}
 setBounds(bounds){this.bounds={...bounds};this.emit('moved');}
}
async function fixture(t){const directory=await mkdtemp(path.join(os.tmpdir(),'workspace-native-'));t.after(()=>rm(directory,{recursive:true,force:true}));const {storage,projectId}=await testStorageOptions({contentRoot:path.join(directory,'project')});const project=await storage.requireRegistered(projectId);const host={storage,requireProject:async id=>{assert.equal(id,'p');return project;},requireRegisteredProject:async id=>{assert.equal(id,'p');return project;},settled:async()=>{}};
// Native ownership tests deliberately use a stable UI scope; the adapter routes
// its persistence calls to the registered real project, not a JSON sidecar.
host.storage=new Proxy(storage,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?((id,...args)=>value.call(target,id==='p'?projectId:id,...args)):value;}});
const native=new WorkspaceNative({BrowserWindow:Window,WebContentsView:View,screen:{getDisplayMatching:()=>({workArea:{x:-1920,y:0,width:1920,height:1080}})},origin:'http://127.0.0.1:9000/',userDataDir:directory,host});const root=native.registerShell(new Window());root.projectId='p';root.ready=true;native.layouts.set('p',createLayout('p',{workspace:{minimized:true}}));return {native,root};}
function receipt(native,r,ok=true){r.ready=true;r.wc.onSend=(channel,payload)=>{if(channel==='nozeli:flush')queueMicrotask(()=>native.acknowledge(r,{requestId:payload,ok}));};}
test('explicit drawing preparation connects frontdesk without moving content or consuming drafts',async t=>{
 const {native,root}=await fixture(t);
 const layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'conversation',viewState:{draftOnly:true,workspace:{draft:'KEEP MAIN DRAFT'}}}});
 native.layouts.set('p',layout);const view=Object.values(layout.views).find(v=>v.kind==='conversation');
 let admissions=0;native.ensureConversation=async(id,target)=>{assert.equal(id,'p');assert.equal(target,'frontdesk');admissions++;};
 const result=await native.invoke(root,'workspace.control',{projectId:'p',type:'conversation-action',action:'prepare',target:'frontdesk'});
 assert.equal(result.ready,true);assert.equal(admissions,1);
 assert.equal(view.viewState.draftOnly,false);assert.equal(view.viewState.workspace.draft,'KEEP MAIN DRAFT');
 assert.equal(native.surfaces.size,0,'preparation does not activate or create a content surface');
});
test('refused drawing admission preserves draft-only state and allows explicit retry',async t=>{
 const {native,root}=await fixture(t);
 const layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'conversation',viewState:{draftOnly:true}}});native.layouts.set('p',layout);
 native.ensureConversation=async()=>{throw Error('handoff confirmation required');};
 await assert.rejects(native.invoke(root,'workspace.control',{projectId:'p',type:'conversation-action',action:'prepare',target:'frontdesk'}),/handoff confirmation/);
 assert.equal(Object.values(layout.views).find(v=>v.kind==='conversation').viewState.draftOnly,true);
});
test('registered top-frame scope rejects iframe, foreign project and unknown sender',async t=>{const {native,root}=await fixture(t),event={sender:root.wc,senderFrame:root.wc.mainFrame};assert.equal(native.authorize(event,'state.read',{projectId:'p'}),root);assert.throws(()=>native.authorize(event,'state.read',{projectId:'foreign'}),{code:'PROJECT_SCOPE_DENIED'});assert.throws(()=>native.authorize({...event,senderFrame:{url:native.origin,parent:{}}},'state.read',{}),{code:'IPC_DENIED'});assert.throws(()=>native.authorize({sender:new Contents(),senderFrame:root.wc.mainFrame},'state.read',{}),{code:'IPC_DENIED'});});
test('history surfaces can render frozen reports but cannot open executable development previews',async t=>{
 const {native}=await fixture(t),wc=new Contents(),history=native.register(wc,{role:'surface',projectId:'p',viewId:'history',kind:'history'}),event={sender:wc,senderFrame:wc.mainFrame};
 assert.equal(native.authorize(event,'isolated-preview.open',{projectId:'p',profile:'staticReport'}),history);
 assert.equal(native.authorize(event,'isolated-preview.reference',{}),history);
 for(const profile of ['offlineDevelopment',undefined])assert.throws(()=>native.authorize(event,'isolated-preview.update',{projectId:'p',profile}),{code:'IPC_DENIED'});
 assert.throws(()=>native.authorize(event,'isolated-preview.open',{projectId:'other',profile:'staticReport'}),{code:'PROJECT_SCOPE_DENIED'});
});
test('CAS and request-key replay are authoritative',async t=>{const {native,root}=await fixture(t);const payload={projectId:'p',expectedRevision:0,requestKey:'first',command:{type:'split',groupId:native.layouts.get('p').mainRoot.id,axis:'x',side:'after'}};const result=await native.command(root,payload);assert.equal(result.layout.revision,1);assert.equal(await native.command(root,payload),result);await assert.rejects(native.command(root,{...payload,requestKey:'second'}),{code:'LAYOUT_STALE'});});
test('flush receipts cannot be forged by another owner or old generation',async t=>{const {native,root}=await fixture(t),other=native.register(new Contents(),{role:'surface',projectId:'p',viewId:'other'});const pending=native.flushOne(root);const requestId=root.wc.sent.at(-1).payload;assert.deepEqual(native.acknowledge(other,{requestId,ok:true}),{accepted:false});assert.deepEqual(native.acknowledge(root,{requestId,ok:false,error:{code:'UNSAVED'}}),{accepted:true});await assert.rejects(pending,{code:'UNSAVED'});});
test('detach and dock keep the identical live WebContentsView without loading it again',async t=>{const {native,root}=await fixture(t);let layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'a.txt'}});native.layouts.set('p',layout);await native.reconcile(layout);const surface=[...native.surfaces.values()][0],view=surface.view,wc=surface.wc;receipt(native,surface);native.detached=async(_layout,item)=>{let r=native.windows.get(item.id);if(r)return r;r=native.register(new Contents(),{role:'detached',windowId:item.id,projectId:'p',win:new Window()});r.ready=true;native.windows.set(item.id,r);return r;};const detached=await native.command(root,{projectId:'p',expectedRevision:layout.revision,requestKey:'detach',command:{type:'detach',viewId:surface.viewId}});assert.equal(native.surfaces.get(surface.viewId).view,view);assert.equal(native.surfaces.get(surface.viewId).wc,wc);assert.notEqual(surface.windowId,'main');assert.equal(native.windows.get(surface.windowId).win.options.parent,undefined);await native.command(root,{projectId:'p',expectedRevision:detached.layout.revision,requestKey:'dock',command:{type:'dock',windowId:surface.windowId}});assert.equal(surface.windowId,'main');assert.equal(surface.wc,wc);});
test('failed flush leaves layout, native owner and source alive',async t=>{const {native,root}=await fixture(t);let layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'a.txt'}});native.layouts.set('p',layout);await native.reconcile(layout);const surface=[...native.surfaces.values()][0];receipt(native,surface,false);await assert.rejects(native.command(root,{projectId:'p',expectedRevision:layout.revision,requestKey:'close',command:{type:'close',viewId:surface.viewId}}),{code:'FLUSH_FAILED'});assert.equal(native.layouts.get('p'),layout);assert.equal(surface.windowId,'main');assert.equal(surface.dead,false);});
test('shell close preserves detached windows and does not stop project services',async t=>{const {native,root}=await fixture(t);receipt(native,root);const child=native.register(new Contents(),{role:'detached',windowId:'detached',projectId:'p',win:new Window()});native.windows.set('detached',child);native.onClose=()=>assert.fail('must not stop application');await native.closeWindow(root);assert.equal(root.win.destroyed,true);assert.equal(child.win.isDestroyed(),false);assert.equal(native.windows.has('detached'),true);});
for(const failure of ['attachment','persistence'])test(`failed report ${failure} restores the same guest and document owner without closing either`,async t=>{
 const {native,root}=await fixture(t);
 const layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'report',resourceId:'frozen-report'}});
 native.layouts.set('p',layout);await native.reconcile(layout);
 const surface=[...native.surfaces.values()][0];receipt(native,surface);
 const preview=new IsolatedPreviewManager({workspace:native});native.isolatedPreview=preview;
 const guest=new View();root.win.contentView.addChildView(guest);
 const slot={id:'guest',scope:surface,view:guest,parentWindow:root.win,files:new Map()};preview.slots.set('guest',slot);
 native.detached=async(_layout,item)=>{const r=native.register(new Contents(),{role:'detached',windowId:item.id,projectId:'p',win:new Window()});r.ready=true;native.windows.set(item.id,r);if(failure==='attachment'){const add=r.win.contentView.addChildView;r.win.contentView.addChildView=view=>{if(view===guest)throw Error('controlled guest attachment failure');add(view);};}return r;};
 if(failure==='persistence')native.persist=async()=>{assert.notEqual(slot.parentWindow,root.win,'guest was staged into destination before persistence');throw Error('controlled persistence failure');};
 await assert.rejects(native.command(root,{projectId:'p',expectedRevision:layout.revision,requestKey:'report-transfer-rollback',command:{type:'detach',viewId:surface.viewId}}),/controlled .*failure/);
 assert.equal(native.layouts.get('p'),layout);assert.equal(preview.slots.get('guest'),slot);assert.equal(slot.closed,undefined);
 assert.equal(slot.parentWindow,root.win);assert.equal(surface.win,root.win);assert(root.win.children.includes(guest));assert(root.win.children.includes(surface.view));assert.equal(surface.dead,false);
});
for(const rollbackFailure of ['source-add','target-remove','outer-source-add'])test(`multi-guest ${rollbackFailure} rollback failure holds native parents and still restores other guests`,async t=>{
 const {native,root}=await fixture(t),layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'report',resourceId:'frozen-multi-report'}});
 native.layouts.set('p',layout);await native.reconcile(layout);const surface=[...native.surfaces.values()][0];receipt(native,surface);
 const preview=new IsolatedPreviewManager({workspace:native});native.isolatedPreview=preview;
 const guests=[new View(),new View()],slots=guests.map((view,index)=>{root.win.contentView.addChildView(view);const slot={id:'guest-'+index,scope:surface,view,parentWindow:root.win,files:new Map()};preview.slots.set(slot.id,slot);return slot;});
 let target;
 native.detached=async(_layout,item)=>{target=native.register(new Contents(),{role:'detached',windowId:item.id,projectId:'p',win:new Window()});target.ready=true;native.windows.set(item.id,target);const add=target.win.contentView.addChildView,remove=target.win.contentView.removeChildView;target.win.contentView.addChildView=view=>{if(rollbackFailure!=='outer-source-add'&&view===guests[1])throw Error('second guest attach fails');add(view);};target.win.contentView.removeChildView=view=>{if(rollbackFailure==='target-remove'&&view===guests[0])throw Error('guest rollback remove fails');remove(view);};return target;};
 const addSource=root.win.contentView.addChildView;root.win.contentView.addChildView=view=>{if(rollbackFailure!=='target-remove'&&view===guests[1])throw Error('guest rollback add fails');addSource(view);};
 native.persist=async()=>{if(rollbackFailure==='outer-source-add')throw Error('controlled persistence failure');assert.fail('failed attachment must not commit');};
 await assert.rejects(native.command(root,{projectId:'p',expectedRevision:layout.revision,requestKey:'multi-guest-rollback',command:{type:'detach',viewId:surface.viewId}}),rollbackFailure==='outer-source-add'?/controlled persistence failure/:{code:'PREVIEW_ROLLBACK_FAILED'});
 assert.equal(native.layouts.get('p'),layout);assert.equal(surface.win,root.win);assert(root.win.children.includes(surface.view));
 assert.equal(surface.recoveryHeld,true);assert.equal(surface.held,true);assert.equal(surface.previewRecoveryFailed,true);
 assert.equal(target.win.destroyed,undefined);assert.equal(native.windows.get(target.windowId),target);
 assert.equal(preview.slots.size,2);assert(slots.every(slot=>!slot.closed));
 if(rollbackFailure==='source-add'){assert.equal(slots[0].parentWindow,root.win);assert(root.win.children.includes(guests[0]));assert.equal(slots[1].parentWindow,null);}
 else if(rollbackFailure==='target-remove'){assert.equal(slots[1].parentWindow,root.win);assert(root.win.children.includes(guests[1]));assert.equal(slots[0].parentWindow,target.win);assert(target.win.children.includes(guests[0]));}
 else {for(const slot of slots){assert.equal(slot.parentWindow,target.win);assert(target.win.children.includes(slot.view));}}
 assert(preview.holdsWindow(target.win));await native.reconcile(layout);assert.equal(target.win.destroyed,undefined,'later reconciliation must also retain an unconfirmed guest parent');
 await assert.rejects(native.closeWindow(target),{code:'TRANSFER_RECOVERY_REQUIRED'});
 await assert.rejects(native.command(root,{projectId:'p',expectedRevision:layout.revision,requestKey:'must-not-retransfer',command:{type:'detach',viewId:surface.viewId}}),{code:'TRANSFER_RECOVERY_REQUIRED'});
});

test('hidden resident reading state persists without recursively requiring its busy renderer to flush',async t=>{
 const {native,root}=await fixture(t);let layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'resident.txt'}});native.layouts.set('p',layout);await native.reconcile(layout);
 const resident=[...native.surfaces.values()][0];layout=reduceLayout(layout,{type:'open',view:{kind:'document',relPath:'active.txt'}});native.layouts.set('p',layout);await native.reconcile(layout);for(const surface of native.surfaces.values())receipt(native,surface);
 assert.equal(resident.view.visible,false);
 resident.wc.onSend=(channel,requestId)=>{if(channel==='nozeli:flush')queueMicrotask(()=>native.acknowledge(resident,{requestId,ok:false,error:{code:'REENTRANT_FLUSH',message:'Renderer is waiting for this reading-state write.'}}));};
 const state={scrollTop:240,readingSelection:'preserved resident selection'};await native.invoke(resident,'workspace.command',{projectId:'p',requestKey:'resident-state',command:{type:'restoreViewState',viewId:resident.viewId,viewState:state}});
 assert.deepEqual(native.layouts.get('p').views[resident.viewId].viewState,state);assert.equal(native.layouts.get('p').revision,layout.revision);assert.equal(resident.view.visible,false);native.layouts.delete('p');assert.deepEqual((await native.layout('p')).views[resident.viewId].viewState,state);
});

for(const failure of ['attachment','persistence'])test(`acknowledged pending state survives ${failure} and is restored under its original layout`,async t=>{
 const {native,root}=await fixture(t),layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'report',resourceId:'pending-state-report'}});
 native.layouts.set('p',layout);await native.reconcile(layout);const surface=[...native.surfaces.values()][0];receipt(native,surface);
 const first={scrollTop:180,readingSelection:'preserve acknowledged selection'};let writes=0;
 const preview=new IsolatedPreviewManager({workspace:native});native.isolatedPreview=preview;const guest=new View();root.win.contentView.addChildView(guest);preview.slots.set('guest',{scope:surface,view:guest,parentWindow:root.win,files:new Map()});
 native.detached=async(_layout,item)=>{const r=native.register(new Contents(),{role:'detached',windowId:item.id,projectId:'p',win:new Window()});r.ready=true;native.windows.set(item.id,r);await native.invoke(surface,'workspace.command',{projectId:'p',command:{type:'restoreViewState',viewId:surface.viewId,viewState:first}});if(failure==='attachment'){const add=r.win.contentView.addChildView;r.win.contentView.addChildView=view=>{if(view===guest)throw Error('controlled attachment failure');add(view);};}return r;};
 native.persist=async()=>{writes++;if(failure==='persistence'&&writes===1)throw Error('controlled persistence failure');};
 await assert.rejects(native.command(root,{projectId:'p',expectedRevision:layout.revision,requestKey:'pending-state-failure',command:{type:'detach',viewId:surface.viewId}}),/controlled .*failure/);
 await surface.pendingStateFlight;
 const current=native.layouts.get('p');assert.equal(current.revision,layout.revision);assert.equal(current.detached.length,0);assert.equal(surface.windowId,'main');
 assert.deepEqual(current.views[surface.viewId].viewState,first);assert.equal(surface.pendingViewState,null);
});

test('late pending state replaces only its captured predecessor after transfer commit',async t=>{
 const {native,root}=await fixture(t),layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'pending.txt'}});
 native.layouts.set('p',layout);await native.reconcile(layout);const surface=[...native.surfaces.values()][0];receipt(native,surface);
 const first={scrollTop:180},late={scrollTop:240,readingSelection:'newest state'};let release,entered,writes=0;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 native.detached=async(_layout,item)=>{const existing=native.windows.get(item.id);if(existing)return existing;const r=native.register(new Contents(),{role:'detached',windowId:item.id,projectId:'p',win:new Window()});r.ready=true;native.windows.set(item.id,r);await native.invoke(surface,'workspace.command',{projectId:'p',command:{type:'restoreViewState',viewId:surface.viewId,viewState:first}});return r;};
 native.persist=async next=>{writes++;if(writes===1){assert.equal(surface.pendingViewState,first,'capture is retained until persistence succeeds');assert.deepEqual(next.views[surface.viewId].viewState,first);entered();await gate;}};
 const transferring=native.command(root,{projectId:'p',expectedRevision:layout.revision,requestKey:'pending-state-late',command:{type:'detach',viewId:surface.viewId}});
 await started;await native.invoke(surface,'workspace.command',{projectId:'p',command:{type:'restoreViewState',viewId:surface.viewId,viewState:late}});release();
 await transferring;await surface.pendingStateFlight;
 assert.deepEqual(native.layouts.get('p').views[surface.viewId].viewState,late);assert.equal(surface.pendingViewState,null);assert.equal(writes,2);
});
test('a surface stays hidden until its content is ready even when bounds arrive first',async t=>{
  const {native,root}=await fixture(t);
  const layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'first.txt'}});
  native.layouts.set('p',layout);await native.reconcile(layout);
  const surface=[...native.surfaces.values()][0];
  assert.equal(surface.ready,false);
  const bounds={windowId:'main',groups:[{groupId:layout.mainRoot.id,viewId:surface.viewId,rect:{x:0,y:40,width:900,height:600}}]};
  await native.invoke(root,'workspace.bounds',bounds);assert.equal(surface.view.visible,false);
  surface.ready=true;
  await native.invoke(root,'workspace.bounds',bounds);assert.equal(surface.view.visible,true);
});
test('switching panes keeps recent surfaces resident for an instant switch-back',async t=>{
  const {native,root}=await fixture(t);receipt(native,root);
  let layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'a.txt'}});
  native.layouts.set('p',layout);await native.reconcile(layout);
  layout=reduceLayout(layout,{type:'open',view:{kind:'document',relPath:'b.txt'}});
  native.layouts.set('p',layout);await native.reconcile(layout);
  const byPath={};for(const s of native.surfaces.values())byPath[s.relPath]=s;
  assert.ok(byPath['a.txt']&&byPath['b.txt'],'both document surfaces exist');
  assert.equal(native.surfaces.has(byPath['a.txt'].viewId),true,'the previous view stays resident');
  const back=reduceLayout(layout,{type:'open',view:{kind:'document',relPath:'a.txt'}});
  native.layouts.set('p',back);await native.reconcile(back);
  assert.equal(native.surfaces.get(byPath['a.txt'].viewId),byPath['a.txt'],'switching back reuses the same surface');
});
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

test('detached moved and resized events coalesce and persist only the final bounds',async t=>{
  const {native}=await fixture(t);
  let layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'bounds.txt'}});
  layout=reduceLayout(layout,{type:'detach',viewId:Object.keys(layout.views)[0],windowId:'bounds-window'});native.layouts.set('p',layout);
  native.setupWindow=r=>queueMicrotask(()=>native.invoke(r,'workspace.ready',{}));
  const r=await native.detached(layout,layout.detached[0]);
  t.after(()=>{clearTimeout(r.boundsTimer);r.win.destroy();});
  let writes=0;native.persist=async()=>{writes++;};
  for(let x=-1800;x<-1700;x++){r.win.setBounds({x,y:30,width:900,height:700});r.win.emit('resized');}
  assert.equal(writes,0);
  await new Promise(resolve=>setTimeout(resolve,190));
  assert.equal(writes,1);
  assert.deepEqual(native.layouts.get('p').detached[0].boundsDip,r.win.getBounds());
  r.win.emit('moved');await new Promise(resolve=>setTimeout(resolve,190));assert.equal(writes,1);
});

test('replacing, cancelling and expiring drags removes hiding state and broadcasts completion',async t=>{
  const {native,root}=await fixture(t),groupId=native.layouts.get('p').mainRoot.id;
  const first=await native.drag(root,'workspace.drag.begin',{groupId});
  const second=await native.drag(root,'workspace.drag.begin',{groupId});
  assert.equal(native.drags.has(first.sessionId),false);assert.equal(native.drags.size,1);
  assert.ok(root.wc.sent.some(({payload})=>payload.type==='drag-ended'&&payload.sessionId===first.sessionId));
  native.drags.get(second.sessionId).expires=0;
  await assert.rejects(native.drag(root,'workspace.drag.update',{...second,screenX:0,screenY:0}),{code:'INVALID_DRAG'});
  assert.equal(native.drags.size,0);
  const third=await native.drag(root,'workspace.drag.begin',{groupId});
  root.wc.emit('did-start-navigation',{},native.origin,false,true);
  assert.equal(native.drags.size,0);
  assert.ok(root.wc.sent.some(({payload})=>payload.type==='drag-ended'&&payload.sessionId===third.sessionId));
});

test('drag completion stays active until the layout command settles and cleans up failures',async t=>{
  const {native,root}=await fixture(t),layout=native.layouts.get('p');
  const session=await native.drag(root,'workspace.drag.begin',{groupId:layout.mainRoot.id});
  let release,entered;
  const commandEntered=new Promise(resolve=>{entered=resolve;});
  native.command=async()=>{entered();await new Promise(resolve=>{release=resolve;});throw Object.assign(new Error('failed transfer'),{code:'TRANSFER_FAILED'});};
  const ending=native.drag(root,'workspace.drag.end',{...session,cancelled:false});
  await commandEntered;
  assert.equal(native.drags.has(session.sessionId),true);
  assert.equal(root.wc.sent.some(({payload})=>payload.type==='drag-ended'),false);
  await assert.rejects(native.drag(root,'workspace.drag.begin',{groupId:layout.mainRoot.id}),{code:'INVALID_DRAG'});
  await assert.rejects(native.drag(root,'workspace.drag.end',{...session,cancelled:false}),{code:'INVALID_DRAG'});
  release();await assert.rejects(ending,{code:'TRANSFER_FAILED'});
  assert.equal(native.drags.size,0);
  assert.equal(root.wc.sent.filter(({payload})=>payload.type==='drag-ended').length,1);
});

test('drag-ended bounds consumer restores the active native editor after cancellation',async t=>{
  const {native,root}=await fixture(t);
  const layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'visible.txt'}});
  native.layouts.set('p',layout);await native.reconcile(layout);
  const surface=[...native.surfaces.values()][0],group=layout.mainRoot;
  surface.ready=true;
  const bounds={windowId:'main',groups:[{groupId:group.id,viewId:surface.viewId,rect:{x:0,y:40,width:900,height:600}}]};
  await native.invoke(root,'workspace.bounds',bounds);assert.equal(surface.view.visible,true);
  const session=await native.drag(root,'workspace.drag.begin',{viewId:surface.viewId});
  await native.invoke(root,'workspace.bounds',bounds);assert.equal(surface.view.visible,false);
  let consumed;
  root.wc.onSend=(_channel,payload)=>{if(payload.type==='drag-ended')consumed=native.invoke(root,'workspace.bounds',bounds);};
  await native.drag(root,'workspace.drag.cancel',session);await consumed;
  assert.equal(native.drags.size,0);assert.equal(surface.view.visible,true);
});

test('native content resize input is accepted only during its same-window root gesture',async t=>{
 const {native,root}=await fixture(t);const l=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'resize.txt'}});native.layouts.set('p',l);await native.reconcile(l);
 const surface=[...native.surfaces.values()][0];surface.view.setBounds({x:100,y:40,width:600,height:500});
 const input={type:'pane-pointer',eventType:'pointermove',buttons:1,clientX:20,clientY:30};
 await native.invoke(surface,'workspace.control',input);assert.equal(root.wc.sent.some(e=>e.payload.type==='pane-pointer'),false);
 await assert.rejects(native.invoke(surface,'workspace.control',{type:'pane-resize',active:true}),{code:'IPC_DENIED'});
 await native.invoke(root,'workspace.control',{type:'pane-resize',active:true});await native.invoke(surface,'workspace.control',input);
 assert.deepEqual(root.wc.sent.at(-1).payload,{type:'pane-pointer',eventType:'pointermove',buttons:1,clientX:120,clientY:70});
 const count=root.wc.sent.length;await native.invoke(root,'workspace.control',{type:'pane-resize',active:false});await native.invoke(surface,'workspace.control',input);assert.equal(root.wc.sent.length,count);
});

test('a context menu occludes only intersecting content and closing restores native visibility',async t=>{
 const {native,root}=await fixture(t);let layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'left.txt'}});const left=layout.mainRoot.id;
 layout=reduceLayout(layout,{type:'split',groupId:left,axis:'x'});const right=layout.mainRoot.second.id;layout=reduceLayout(layout,{type:'open',groupId:right,view:{kind:'document',relPath:'right.txt'}});native.layouts.set('p',layout);await native.reconcile(layout);
 const surfaces=[...native.surfaces.values()];for(const s of surfaces)s.ready=true;
 const groups=[{groupId:left,viewId:layout.mainRoot.first.activeViewId,rect:{x:0,y:40,width:450,height:600}},{groupId:right,viewId:layout.mainRoot.second.activeViewId,rect:{x:456,y:40,width:450,height:600}}];
 await native.invoke(root,'workspace.bounds',{windowId:'main',groups,overlay:false,overlayRects:[{x:10,y:50,width:200,height:200}]});
 assert.equal(native.surfaces.get(groups[0].viewId).view.visible,false);assert.equal(native.surfaces.get(groups[1].viewId).view.visible,true);
 await native.invoke(root,'workspace.bounds',{windowId:'main',groups,overlay:false,overlayRects:[]});assert(surfaces.every(s=>s.view.visible));
});

test('late layout from before a native resize cannot hide the current visible content',async t=>{
 const {native,root}=await fixture(t);const layout=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'resize-late.txt'}});native.layouts.set('p',layout);await native.reconcile(layout);
 const surface=[...native.surfaces.values()][0];surface.ready=true;root.win.getContentSize=()=>[600,500];
 const groups=[{groupId:layout.mainRoot.id,viewId:surface.viewId,rect:{x:1,y:34,width:598,height:465}}];
 await native.invoke(root,'workspace.bounds',{windowId:'main',viewport:{width:600,height:500},groups});assert.equal(surface.view.visible,true);
 const current=structuredClone(surface.view.bounds);
 const result=await native.invoke(root,'workspace.bounds',{windowId:'main',viewport:{width:1000,height:760},groups:[{...groups[0],rect:{x:1,y:34,width:998,height:725}}]});
 assert.equal(result.stale,true);assert.equal(surface.view.visible,true);assert.deepEqual(surface.view.bounds,current);assert.equal(root.wc.sent.at(-1).payload.type,'viewport-changed');
});

test('a pre-dock layout or out-of-order visibility update cannot blank the current native owner',async t=>{
 const {native,root}=await fixture(t);const l=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'conversation'}});native.layouts.set('p',l);await native.reconcile(l);const s=[...native.surfaces.values()][0];s.ready=true;
 const base={windowId:'main',viewport:{width:1000,height:760},layoutRevision:l.revision,groups:[{groupId:l.mainRoot.id,viewId:s.viewId,rect:{x:0,y:40,width:900,height:600}}],overlay:false};
 await native.invoke(root,'workspace.bounds',{...base,sequence:3});assert.equal(s.view.visible,true);
 const oldLayout=await native.invoke(root,'workspace.bounds',{...base,sequence:4,layoutRevision:l.revision-1,groups:[]});assert.equal(oldLayout.stale,true);assert.equal(s.view.visible,true);
 const oldVisibility=await native.invoke(root,'workspace.bounds',{...base,sequence:2,groups:[],overlay:true});assert.equal(oldVisibility.stale,true);assert.equal(s.view.visible,true);
 await native.invoke(root,'workspace.bounds',{...base,sequence:4,overlay:true});assert.equal(s.view.visible,false);
 await native.invoke(root,'workspace.bounds',{...base,sequence:5});assert.equal(s.view.visible,true);
});

test('conversation admission failure leaves the current document intact and creates no chat surface',async t=>{
 const {native,root}=await fixture(t);const l=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'kept.txt'}});native.layouts.set('p',l);await native.reconcile(l);const original=[...native.surfaces.values()][0];
 native.ensureConversation=async()=>{throw Object.assign(Error('native session missing'),{code:'AGENT_NOT_READY'});};
 await assert.rejects(native.invoke(root,'workspace.control',{type:'conversation-action',target:'frontdesk'}),{code:'AGENT_NOT_READY'});
 assert.deepEqual(native.layouts.get('p'),l);assert.equal(native.surfaces.size,1);assert.equal(native.surfaces.get(original.viewId),original);assert(root.wc.sent.some(e=>e.payload.type==='conversation-unavailable'));
});
test('a disconnected live conversation collapses without deleting its draft view or replaying input',async t=>{
 const {native,root}=await fixture(t);native.ensureConversation=async()=>{};let l=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'return.txt'}});const document=l.mainRoot.activeViewId;
 l=reduceLayout(l,{type:'open',view:{kind:'conversation',viewState:{draft:'keep me',messages:['history']}}});native.layouts.set('p',l);await native.reconcile(l);const chat=[...native.surfaces.values()].find(s=>s.kind==='conversation');receipt(native,chat);const metadata=structuredClone(l.views[chat.viewId]);
 await native.conversationState('p',{agents:[{target:'frontdesk',starting:true,closed:true,phase:'constructed'}]});assert.equal(native.surfaces.get(chat.viewId),chat);assert.equal(native.layouts.get('p').mainRoot.activeViewId,chat.viewId);
 await native.conversationState('p',{agents:[{target:'frontdesk',closed:true,phase:'closed'}]});
 const next=native.layouts.get('p');assert.equal(next.mainRoot.activeViewId,document);assert.deepEqual(next.views[chat.viewId],metadata);assert.equal(native.surfaces.has(chat.viewId),false);assert(root.wc.sent.some(e=>e.payload.type==='conversation-unavailable'));
});

test('cold restore of an unavailable conversation returns the pane to its previous document',async t=>{
 const {native,root}=await fixture(t);let l=reduceLayout(native.layouts.get('p'),{type:'open',view:{kind:'document',relPath:'prior.txt'}});const document=l.mainRoot.activeViewId;l=reduceLayout(l,{type:'open',view:{kind:'conversation',viewState:{draft:'cold draft'}}});const chat=l.mainRoot.activeViewId;native.layouts.set('p',l);
 native.ensureConversation=async()=>{throw Object.assign(Error('configuration missing'),{code:'CONFIG_SETUP_REQUIRED'});};
 const result=await native.bindProject(root,'p');assert.equal(result.layout.mainRoot.activeViewId,document);assert.equal(native.surfaces.has(chat),false);assert.equal(result.layout.views[chat].viewState.draft,'cold draft');
});

for(const edited of [false,true])test(edited?'editing a recovered pending question creates a distinct handoff':'pending drawing recovery survives another crash without duplicating the persisted attachment',async t=>{
 const {native,root}=await fixture(t),project=await native.host.requireProject('p'),projectId=project.id;
 root.projectId=projectId;native.host.requireProject=id=>native.host.storage.requireRegistered(id);native.host.requireRegisteredProject=native.host.requireProject;
 const materials={text:'keep my frontdesk draft',quote:{text:'keep my quote'},pending:[]};
 const viewState={draftOnly:true,conversationInput:{projectId,target:'worker'},conversationMaterials:{frontdesk:materials}},layout=reduceLayout(createLayout(projectId),{type:'open',view:{kind:'conversation'}}),chatId=layout.mainRoot.activeViewId;
 layout.views[chatId].viewState=viewState;
 native.layouts.set(projectId,layout);await native.persist(layout);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=','base64'),dataUrl='data:image/png;base64,'+png.toString('base64');
 const attachments=new ProjectAttachments(native.host.storage);native.host.attachMaterial=input=>attachments.attach(input);
 const attachment=await attachments.attach({projectId,name:'pending.png',mime:'image/png',source:'drawing',size:png.length,bytes:png.toString('base64')});
 const store=new WorkspaceCaptureStore({directory:path.join(await native.host.storage.recoveryDirectory(projectId),'drawing-captures')}),id='pending-receipt-1',drawing={schema:'nozeli.region-drawing-v1',width:1,height:1,strokes:[]},target={regionImage:{dataUrl},card:{message:'original question'}};
 await store.saveFrozen({id,projectId,width:1,height:1,tiles:[{id:'main',width:1,height:1,layers:[{bounds:{x:0,y:0,width:1,height:1},dataUrl}]}]});
 await store.saveDrawing(id,projectId,{drawing,target});await store.saveResult(id,projectId,{attachment,state:'pending-delivery',drawing,card:target.card,sources:[]});
 // Recipient persistence succeeded before the process lost the result acknowledgement.
 await native.deliverDrawing({projectId,window:{windowId:'main'}},{type:'drawing-material',projectId,target:'frontdesk',deliveryId:id,attachment,sources:[],card:target.card});
 root.win.isMinimized=()=>false;root.win.isVisible=()=>true;root.wc.executeJavaScript=async()=>false;
 const makeCapture=()=>new WorkspaceCapture({workspace:native,host:native.host,deliver:(session,event)=>native.deliverDrawing(session,event)});
 const first=makeCapture(),fork=await first.begin(root,{recoverId:id});await first.shutdown();
 // A second crash/restart follows the fork, not the original pending record.
 const restarted=makeCapture(),resumed=await restarted.begin(root,{recoverId:fork.captureId});
 await restarted.invoke({sender:root.wc,senderFrame:root.wc.mainFrame},'commit',{captureId:resumed.captureId,png:dataUrl,drawing,target:{...target,card:{message:edited?'revised question':'original question'}}});
 const state=(await native.layout(projectId)).views[chatId].viewState,frontdesk=state.conversationMaterials.frontdesk;
 assert.equal(state.conversationInput.target,'worker');assert.equal(frontdesk.text,materials.text);assert.deepEqual(frontdesk.quote,materials.quote);
 assert.deepEqual(frontdesk.pending.map(item=>item.frozenText),edited?['original question','revised question']:['original question']);
 assert.equal(frontdesk.pending[0].deliveryId,id);
 if(edited)assert.notEqual(frontdesk.pending[1].deliveryId,id);
 assert.equal((await store.load(id,projectId)).result.state,edited?'pending-delivery':'delivered');
 assert.equal((await store.load(resumed.captureId,projectId)).result.state,'delivered');
});
