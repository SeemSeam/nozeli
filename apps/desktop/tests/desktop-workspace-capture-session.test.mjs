// Regressions for the 2026-10-24 simplified drawing capture rework
// (main/workspace-capture.mjs): bounded cancellable single-window capture with
// an operation token, generation-bound session auth, per-session store,
// device-pixel budgeting, and commit validated against captured dimensions.
// Pure unit level: real WorkspaceCaptureStore on a temp directory, mocked
// workspace/host. No Electron, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceCapture} from '../src/main/workspace-capture.mjs';
import {WorkspaceCaptureStore} from '../src/main/workspace-capture-store.mjs';

const PNG_SIG=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const commitPng=(width,height)=>{const b=Buffer.alloc(33);PNG_SIG.copy(b,0);b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);return b;};
const deferred=()=>{let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

let wcSeq=0;
function makeView({dip=[100,50],scale=2,hang=null}={}){
  const [w,h]=dip;
  // Electron NativeImage subset production uses: isEmpty() and toPNG(). The PNG
  // IHDR carries the authoritative device-pixel dimensions.
  const png=()=>{const b=Buffer.alloc(33);PNG_SIG.copy(b,0);b.writeUInt32BE(Math.round(w*scale),16);b.writeUInt32BE(Math.round(h*scale),20);return b;};
  // Property must be named webContents — that is what production reads.
  const webContents={id:'wc-view-'+(++wcSeq),isDestroyed:()=>false,capturePage:async()=>{if(hang)await hang.promise;return {isEmpty:()=>false,toPNG:png};}};
  return {visible:true,bounds:{x:0,y:0,width:w,height:h},webContents,
    getVisible(){return this.visible;},getBounds(){return this.bounds;}};
}
function makeRoot({projectId='p1',windowId='main',views,contentSize=[100,50]}){
  const wc={id:'wc-root-'+(++wcSeq),mainFrame:{},isDestroyed:()=>false,executeJavaScript:async()=>false,send(type,detail){(this.sent??=[]).push({type,detail});}};
  return {role:windowId==='main'?'shell':'detached',windowId,projectId,generation:0,dead:false,wc,
    win:{getContentSize:()=>contentSize,isMinimized:()=>false,isVisible:()=>true,getBounds:()=>({x:0,y:0,width:contentSize[0],height:contentSize[1]}),getTitle:()=>('窗口-'+windowId),contentView:{children:views}}};
}
async function makeCapture({root,isolatedPreview=null,attachCalls=[],deliveries=[],timeout=10000}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-capture-test-'));
  const workspace={windows:new Map([[root.windowId,root]]),senders:new Map([[root.wc.id,root]]),screen:{getDisplayMatching:()=>({id:42,scaleFactor:2,bounds:{x:0,y:0,width:root.win.getBounds().width,height:root.win.getBounds().height}})},projectRecords:()=>[],layout:async()=>({revision:1}),isolatedPreview};
  for(const view of root.win.contentView.children)if(view.webContents.senderScope)workspace.senders.set(view.webContents.id,view.webContents.senderScope);
  const host={storage:{async recoveryDirectory(id){return path.join(directory,'recovery',id);}},async attachMaterial(input){attachCalls.push(input);return {digest:'a'.repeat(64),mime:'image/png',size:input.size,kind:'image'};}};
  const capture=new WorkspaceCapture({workspace,host,deliver:async(session,event)=>{deliveries.push({session,event});},prepareTimeoutMs:timeout});
  return {capture,workspace,host,attachCalls,deliveries,directory,
    owner:(generation=root.generation)=>({wc:root.wc,projectId:root.projectId,windowId:root.windowId,generation}),
    event:()=>({sender:root.wc,senderFrame:root.wc.mainFrame}),
    cleanup:()=>fs.rm(directory,{recursive:true,force:true})};
}
const surfaceScope=(view,over={})=>({role:'surface',projectId:'p1',viewId:over.viewId??('view-'+view.webContents.id),kind:over.kind??'document',relPath:over.relPath??'docs/a.md',generation:0,dead:false});

test('begin freezes the initiating window and describes the full contract',async t=>{
  const view=makeView();view.webContents.senderScope=surfaceScope(view);
  const root=makeRoot({views:[view]});
  const {capture,owner,event,cleanup,workspace}=await makeCapture({root});
  t.after(cleanup);
  // Metadata-only count of same-project windows excluded from the freeze.
  workspace.windows.set('side',makeRoot({projectId:'p1',windowId:'side',views:[]}));
  workspace.windows.set('elsewhere',makeRoot({projectId:'other-project',windowId:'elsewhere',views:[]}));
  const described=await capture.begin(owner(),{});
  assert.equal(described.projectId,'p1');
  assert.equal(described.omittedWindowCount,1);
  assert.equal(described.width,200);assert.equal(described.height,100); // device pixels = DIP × DPR 2
  assert.equal(described.tiles.length,1);
  assert.equal(described.tiles[0].width,200);assert.equal(described.tiles[0].height,100);
  assert.equal(described.tiles[0].layers.length,1);
  assert.equal(described.sources.length,1);
  assert.equal(described.sources[0].locationStatus,'viewport-only');
  assert.deepEqual(described.sources[0].version,{kind:'unknown'}); // never a fabricated file version
  assert.equal(described.drawingDraft,null);
  assert.deepEqual(described.recoverable.map(r=>r.id),[described.captureId]);
  // Frozen evidence persisted before the dialog may draw.
  const record=await capture.active.store.load(described.captureId,'p1');
  assert.equal(record.state,'frozen');assert.equal(record.tiles.length,1);
  // Re-entry from the same owner generation is idempotent.
  const again=await capture.begin(owner(),{});
  assert.equal(again.captureId,described.captureId);
});

test('window pre-check rejects an oversized window on device pixels without capturing',async t=>{
  const view=makeView(); // window itself oversized: 6000×6000 DIP × DPR 2 = 144M device px
  const root=makeRoot({views:[view],contentSize:[6000,6000]});
  const {capture,owner,cleanup}=await makeCapture({root});
  t.after(cleanup);
  await assert.rejects(()=>capture.begin(owner(),{}),error=>error.code==='CAPTURE_PIXEL_BUDGET');
  // No-capture invariant: nothing published, entry immediately free again.
  assert.equal(capture.active,null);
  assert.equal(capture.preparing,false);
});

test('per-layer device-pixel budget rejects oversized layers without publishing',async t=>{
  const view=makeView({dip:[6000,6000],scale:2}); // 12000×12000 device px layer inside a small window
  const root=makeRoot({views:[view]});
  const {capture,owner,cleanup}=await makeCapture({root});
  t.after(cleanup);
  await assert.rejects(()=>capture.begin(owner(),{}),error=>error.code==='CAPTURE_PIXEL_BUDGET');
  assert.equal(capture.active,null);
  assert.equal(capture.preparing,false);
});

test('static report keeps immutable digest identity, no version fabrication',async t=>{
  const view=makeView();
  const slot={view,entry:'entry',profile:'staticReport',files:new Map([['entry',{digest:'b'.repeat(64)}]]),source:{objectId:'obj-1'},scope:{role:'surface',projectId:'p1',viewId:'report-1',kind:'report',relPath:null}};
  const root=makeRoot({views:[view]});
  const {capture,owner,cleanup}=await makeCapture({root,isolatedPreview:{slots:new Map([['s1',slot]])}});
  t.after(cleanup);
  const described=await capture.begin(owner(),{});
  assert.equal(described.sources.length,1);
  assert.equal(described.sources[0].version.kind,'material');
  assert.equal(described.sources[0].version.digest,'b'.repeat(64));
});

test('session auth is captureId and owner-generation bound',async t=>{
  const view=makeView();view.webContents.senderScope=surfaceScope(view);
  const root=makeRoot({views:[view]});
  const {capture,owner,event,cleanup}=await makeCapture({root});
  t.after(cleanup);
  const described=await capture.begin(owner(),{});
  await capture.invoke(event(),'save',{captureId:described.captureId,drawing:{schema:'nozeli.region-drawing-v1',width:200,height:100,strokes:[]},target:{card:{message:'看这里',rect:[0.1,0.2,0.3,0.3]}}});
  // Reload/crash bumps the generation: same captureId must stop working.
  root.generation++;
  await assert.rejects(()=>capture.invoke(event(),'save',{captureId:described.captureId,drawing:null}),/涂鸦会话无效/);
  // Wrong captureId from the live owner is rejected too.
  await assert.rejects(()=>capture.invoke(event(),'save',{captureId:'not-the-session',drawing:null}),/涂鸦会话无效/);
  // A foreign sender never gains authority.
  await assert.rejects(()=>capture.invoke({sender:view.webContents,senderFrame:view.webContents},'cancel',{captureId:described.captureId}),/涂鸦会话无效/);
});

test('timeout bumps the operation token and truly invalidates the late capture',async t=>{
  const hang=deferred();
  const view=makeView({hang});
  const root=makeRoot({views:[view]});
  const {capture,owner,cleanup}=await makeCapture({root,timeout:40});
  t.after(cleanup);
  await assert.rejects(()=>capture.begin(owner(),{}),error=>error.code==='CAPTURE_TIMEOUT');
  assert.equal(capture.preparing,false);
  assert.equal(capture.active,null);
  hang.resolve(); // late continuation must die at its next checkpoint, never publish
  await flush();
  assert.equal(capture.active,null);
  // Entry is free again and no orphaned frozen record was published.
  const next=await capture.begin(owner(),{});
  assert.deepEqual(next.recoverable.filter(record=>record.id!==next.captureId),[],'late cancelled capture never leaves another record');
  assert.ok(capture.active);
});

test('cancel ends the session but keeps frozen evidence recoverable',async t=>{
  const view=makeView();view.webContents.senderScope=surfaceScope(view);
  const root=makeRoot({views:[view]});
  const {capture,owner,event,cleanup}=await makeCapture({root});
  t.after(cleanup);
  const first=await capture.begin(owner(),{});
  const cancelled=await capture.invoke(event(),'cancel',{captureId:first.captureId});
  assert.equal(cancelled.cancelled,true);
  assert.equal(capture.active,null);
  const second=await capture.begin(owner(),{});
  assert.notEqual(second.captureId,first.captureId);
  assert.ok(second.recoverable.some(r=>r.id===first.captureId&&r.state==='frozen'));
  // Recovery preserves the old tiles/baseline under the same id.
  const resumed=await capture.invoke(event(),'recover',{captureId:second.captureId,id:first.captureId});
  assert.equal(resumed.captureId,first.captureId);
  assert.deepEqual(resumed.tiles,first.tiles);
  assert.equal(capture.active.id,first.captureId);
});

test('recovering a record with a saved result forks a new persisted baseline',async t=>{
  const view=makeView();
  const root=makeRoot({views:[view]});
  const {capture,owner,event,cleanup}=await makeCapture({root});
  t.after(cleanup);
  const first=await capture.begin(owner(),{});
  await capture.invoke(event(),'commit',{captureId:first.captureId,png:'data:image/png;base64,'+commitPng(200,100).toString('base64'),local:true});
  assert.equal(capture.active,null);
  const second=await capture.begin(owner(),{});
  assert.ok(second.recoverable.some(r=>r.id===first.captureId&&r.state==='local'));
  const resumed=await capture.invoke(event(),'recover',{captureId:second.captureId,id:first.captureId});
  assert.notEqual(resumed.captureId,first.captureId); // forked
  const original=await capture.active.store.load(first.captureId,'p1');
  assert.ok(original.result); // immutable evidence retained
  const fork=await capture.active.store.load(resumed.captureId,'p1');
  assert.deepEqual(fork.tiles,original.tiles); // old tiles/baseline preserved
  assert.equal(fork.result,null);
  assert.equal(fork.width,original.width);assert.equal(fork.height,original.height);
});

test('commit validates pixels against captured dimensions and delivers idempotently',async t=>{
  const view=makeView();
  const root=makeRoot({views:[view]});
  const {capture,owner,event,deliveries,attachCalls,cleanup}=await makeCapture({root});
  t.after(cleanup);
  const described=await capture.begin(owner(),{});
  await assert.rejects(()=>capture.invoke(event(),'commit',{captureId:described.captureId,png:'data:image/png;base64,'+commitPng(200,99).toString('base64'),local:true}),/尺寸与已捕获画面不一致/);
  await assert.rejects(()=>capture.invoke(event(),'commit',{captureId:described.captureId,png:'data:image/png;base64,'+commitPng(200,100).toString('base64'),drawing:{schema:'nozeli.region-drawing-v1',width:99,height:99,strokes:[]},local:true}),/画布与捕获画面不一致/);
  const local=await capture.invoke(event(),'commit',{captureId:described.captureId,png:'data:image/png;base64,'+commitPng(200,100).toString('base64'),local:true,target:{card:{message:'本地卡片',rect:null}}});
  assert.deepEqual(local,{saved:true,attached:false,captureId:described.captureId});
  assert.equal(deliveries.length,0); // local save never activates the conversation
  assert.equal(attachCalls.length,1);
  assert.equal(attachCalls[0].projectId,'p1');
  // Delivering commit reaches the frontdesk via session.window.windowId.
  const second=await capture.begin(owner(),{});
  const delivered=await capture.invoke(event(),'commit',{captureId:second.captureId,png:'data:image/png;base64,'+commitPng(200,100).toString('base64'),target:{card:{message:'讨论这张图',rect:[0.2,0.2,0.4,0.4]}}});
  assert.equal(delivered.attached,true);
  assert.equal(deliveries.length,1);
  assert.deepEqual(deliveries[0].session,{projectId:'p1',window:{windowId:'main'}});
  assert.equal(deliveries[0].event.deliveryId,second.captureId);
  assert.equal(deliveries[0].event.type,'drawing-material');
  assert.deepEqual(deliveries[0].event.card,{message:'讨论这张图',rect:[0.2,0.2,0.4,0.4]});
  assert.equal(capture.active,null); // session ended after commit
});

test('shutdown invalidates prepares and refuses to tear an in-flight commit',async t=>{
  const hang=deferred();
  const view=makeView({hang});
  const root=makeRoot({views:[view]});
  const {capture,owner,event,cleanup}=await makeCapture({root,timeout:40});
  t.after(cleanup);
  // A prepare in flight is invalidated by shutdown's token bump.
  const starting=capture.begin(owner(),{});const invalidated=assert.rejects(starting,error=>error.code==='CAPTURE_INVALIDATED');
  await flush();await capture.shutdown();hang.resolve();await invalidated;
  await flush();
  // Active session: shutdown closes it and notifies the owner renderer.
  const described=await capture.begin(owner(),{});
  await capture.shutdown();
  assert.equal(capture.active,null);
  assert.deepEqual(root.wc.sent.at(-1).detail,{type:'capture-closed',projectId:'p1',captureId:described.captureId,reason:'shutdown'});
  // An in-flight commit must not be torn: shutdown refuses to run.
  const slow=deferred();
  capture.host.attachMaterial=async()=>slow.promise;
  const next=await capture.begin(owner(),{});
  const commit=capture.invoke(event(),'commit',{captureId:next.captureId,png:'data:image/png;base64,'+commitPng(200,100).toString('base64'),local:true});
  await flush(); // let commit reach the attachment await
  await assert.rejects(()=>capture.shutdown(),/正在保存/);
  assert.equal(capture.active.id,next.captureId);
  slow.resolve({digest:'a'.repeat(64),mime:'image/png',size:33,kind:'image'});
  assert.deepEqual(await commit,{saved:true,attached:false,captureId:next.captureId});
  assert.equal(capture.active,null);
});

test('occluded parent provenance is excluded and partial coverage clipped',async t=>{
  // A fully covered parent surface never appears in sources.
  const coveredParent=makeView();coveredParent.webContents.senderScope=surfaceScope(coveredParent,{viewId:'view-parent'});
  const guest=makeView();guest.webContents.senderScope=surfaceScope(guest,{viewId:'view-guest'});
  const full=await makeCapture({root:makeRoot({views:[coveredParent,guest]})});
  t.after(full.cleanup);
  const fullShown=await full.capture.begin(full.owner(),{});
  assert.deepEqual(fullShown.sources.map(s=>s.sourceId),['view-guest']);
  assert.equal(fullShown.sources[0].outputRegion.width,200);
  // A partially visible parent is clipped to its visible pieces (device px out, DIP capture).
  const parent=makeView();parent.webContents.senderScope=surfaceScope(parent,{viewId:'view-parent'});
  const upper=makeView();upper.webContents.senderScope=surfaceScope(upper,{viewId:'view-guest'});
  upper.bounds={x:50,y:0,width:50,height:50};
  const partial=await makeCapture({root:makeRoot({views:[parent,upper]})});
  t.after(partial.cleanup);
  const shown=await partial.capture.begin(partial.owner(),{});
  assert.deepEqual(shown.sources.map(s=>s.sourceId),['view-parent','view-guest']);
  const clipped=shown.sources.find(s=>s.sourceId==='view-parent');
  assert.deepEqual(clipped.outputRegion,{x:0,y:0,width:100,height:100}); // device px, visible piece only
  assert.deepEqual(clipped.captureRegion,{x:0,y:0,width:50,height:50}); // DIP
  assert.equal(clipped.version.kind,'unknown'); // occlusion clipping fabricates nothing
  assert.equal(shown.sources.find(s=>s.sourceId==='view-guest').outputRegion.width,100);
});

test('unrelated project revision churn never aborts; owner layer stack changes do',async t=>{
  // Background layout revision churn (other windows, read-state) must not abort.
  const view=makeView();view.webContents.senderScope=surfaceScope(view);
  const root=makeRoot({views:[view]});
  const churn=await makeCapture({root});
  t.after(churn.cleanup);
  let revision=0;churn.workspace.layout=async()=>({revision:++revision});
  const described=await churn.capture.begin(churn.owner(),{});
  assert.ok(described.captureId);
  // A sibling layer resized/reparented mid-freeze aborts this window's capture.
  const v1=makeView(),v2=makeView({dip:[50,50]});
  const sized=await makeCapture({root:makeRoot({views:[v1,v2]})});
  t.after(sized.cleanup);
  const sizedCapture=v1.webContents.capturePage;
  v1.webContents.capturePage=async()=>{v2.bounds={x:50,y:0,width:50,height:50};return sizedCapture();};
  await assert.rejects(()=>sized.capture.begin(sized.owner(),{}),/捕获期间本窗口内容改变/);
  // A surface switch/reload (generation bump) mid-freeze aborts too.
  const v3=makeView();v3.webContents.senderScope=surfaceScope(v3,{viewId:'view-surface'});
  const reloaded=await makeCapture({root:makeRoot({views:[v3]})});
  t.after(reloaded.cleanup);
  const surfaceCapture=v3.webContents.capturePage;
  v3.webContents.capturePage=async()=>{v3.webContents.senderScope.generation++;return surfaceCapture();};
  await assert.rejects(()=>reloaded.capture.begin(reloaded.owner(),{}),/捕获期间本窗口内容改变/);
});

test('same window switching project ends the stale binding and never re-serves A',async t=>{
  const view=makeView();
  const root=makeRoot({views:[view]});
  const {capture,owner,event,cleanup}=await makeCapture({root});
  t.after(cleanup);
  const first=await capture.begin(owner(),{});
  const storeA=capture.active.store;
  root.projectId='p2'; // root record switches projects without a generation bump
  const second=await capture.begin(owner(),{});
  assert.equal(second.projectId,'p2');
  assert.notEqual(second.captureId,first.captureId); // A is never returned as the live session
  // A's captureId no longer authorizes ops from the switched root.
  await assert.rejects(()=>capture.invoke(event(),'cancel',{captureId:first.captureId}),/涂鸦会话无效/);
  // A's disk evidence is preserved, not deleted by the rebind.
  assert.equal((await storeA.load(first.captureId,'p1')).state,'frozen');
});

test('legacy DIP baseline resumes on verified draft dims and commits on fork',async t=>{
  const view=makeView();
  const root=makeRoot({views:[view]});
  const {capture,owner,event,cleanup,directory}=await makeCapture({root});
  t.after(cleanup);
  // Craft legacy records directly: record dims are old DIP layout dims, the
  // retained drawing lives on a device-pixel (possibly cropped) region image.
  const legacyDirectory=path.join(directory,'recovery','p1','drawing-captures');
  const legacy=new WorkspaceCaptureStore({directory:legacyDirectory});
  const legacyTile=(id,layers)=>({id,title:'旧窗口',width:100,height:50,layers,displayId:'42',displayBounds:{x:0,y:0,width:100,height:50},windowBounds:{x:0,y:0,width:100,height:50}});
  const legacyLayer=dataPng=>'data:image/png;base64,'+dataPng.toString('base64');
  const source={sourceId:'legacy-view',projectId:'p1',viewId:'legacy-view',kind:'document',relPath:'docs/old.md',locationStatus:'viewport-only',version:{kind:'unknown'},bounds:{x:0,y:0,width:100,height:50},summary:'文档视图 · docs/old.md · 版本未核验'};
  await legacy.saveFrozen({id:'legacyfull1',projectId:'p1',createdAt:'2026-01-01T00:00:00.000Z',state:'frozen',width:100,height:50,tiles:[legacyTile('legacy-window',[{bounds:{x:0,y:0,width:100,height:50},dataUrl:legacyLayer(commitPng(200,100)),source}])],sources:[source],ownerGeneration:0});
  await legacy.saveDrawing('legacyfull1','p1',{drawing:{schema:'nozeli.region-drawing-v1',width:200,height:100,strokes:[]},target:{regionImage:{dataUrl:legacyLayer(commitPng(200,100)),captureMode:'visible-window-region',clipped:false},scopeMode:'window',windowId:'legacy-window',pixelScale:2}});
  await legacy.saveFrozen({id:'legacycrop1',projectId:'p1',createdAt:'2026-01-01T00:00:00.000Z',state:'frozen',width:100,height:50,tiles:[legacyTile('legacy-window',[{bounds:{x:0,y:0,width:100,height:50},dataUrl:legacyLayer(commitPng(200,100)),source}])],sources:[source],ownerGeneration:0});
  await legacy.saveDrawing('legacycrop1','p1',{drawing:{schema:'nozeli.region-drawing-v1',width:120,height:80,strokes:[]},target:{regionImage:{dataUrl:legacyLayer(commitPng(120,80)),captureMode:'visible-window-region',clipped:true},scopeMode:'window',windowId:'legacy-window',pixelScale:2}});
  await legacy.saveFrozen({id:'legacybad01',projectId:'p1',createdAt:'2026-01-01T00:00:00.000Z',state:'frozen',width:100,height:50,tiles:[legacyTile('legacy-window',[{bounds:{x:0,y:0,width:100,height:50},dataUrl:legacyLayer(commitPng(200,100)),source}])],sources:[source],ownerGeneration:0});
  await legacy.saveDrawing('legacybad01','p1',{drawing:{schema:'nozeli.region-drawing-v1',width:200,height:100,strokes:[]},target:{regionImage:{dataUrl:legacyLayer(commitPng(180,90)),captureMode:'visible-window-region',clipped:false},scopeMode:'window',windowId:'legacy-window',pixelScale:2}});
  // Full-window legacy: editable canvas aligns to the retained 200×100 draft.
  const full=await capture.begin(owner(),{recoverId:'legacyfull1'});
  assert.equal(full.captureId,'legacyfull1');
  assert.equal(full.width,200);assert.equal(full.height,100);
  assert.equal(full.tiles[0].id,'legacy-window'); // baseline preserved, never recaptured
  assert.equal(full.sources[0].sourceId,'legacy-view');
  assert.equal(full.sources[0].summary,'文档视图 · docs/old.md · 版本未核验');
  assert.equal(full.drawingDraft.drawing.width,200);
  // Commit with the exact retained device-pixel composite is accepted.
  const done=await capture.invoke(event(),'commit',{captureId:'legacyfull1',png:'data:image/png;base64,'+commitPng(200,100).toString('base64'),drawing:full.drawingDraft.drawing,target:full.drawingDraft.target,local:true});
  assert.equal(done.saved,true);
  assert.equal(capture.active,null);
  // Cropped legacy: resumable canvas is the smaller stored crop, committed exactly.
  const crop=await capture.begin(owner(),{recoverId:'legacycrop1'});
  assert.equal(crop.width,120);assert.equal(crop.height,80);
  const cropDone=await capture.invoke(event(),'commit',{captureId:'legacycrop1',png:'data:image/png;base64,'+commitPng(120,80).toString('base64'),drawing:crop.drawingDraft.drawing,target:crop.drawingDraft.target,local:true});
  assert.equal(cropDone.saved,true);
  // The committed legacy record now has a result: resuming it forks, and the
  // forked baseline keeps the aligned 200×100 editable canvas.
  const forked=await capture.begin(owner(),{recoverId:'legacyfull1'});
  assert.notEqual(forked.captureId,'legacyfull1');
  assert.equal(forked.width,200);assert.equal(forked.height,100);
  await capture.invoke(event(),'cancel',{captureId:forked.captureId});
  const picker=await capture.begin(owner(),{});
  const selected=await capture.invoke(event(),'recover',{captureId:picker.captureId,id:'legacyfull1'});
  assert.notEqual(selected.captureId,'legacyfull1');
  assert.equal(selected.width,200);assert.equal(selected.height,100);
  const persisted=await capture.active.store.load(selected.captureId,'p1');
  assert.equal(persisted.drawingDraft.drawing.width,200);
  assert.equal(persisted.drawingDraft.target.regionImage.dataUrl,full.drawingDraft.target.regionImage.dataUrl);
  assert.equal((await legacy.load('legacyfull1','p1')).result.state,'local');
  await capture.invoke(event(),'cancel',{captureId:selected.captureId});
  // Corrupted draft (drawing contradicts stored region image) rejects the
  // resume and preserves every record byte.
  await assert.rejects(()=>capture.begin(owner(),{recoverId:'legacybad01'}),/涂鸦与原区域图像尺寸不一致/);
  const intact=await legacy.load('legacybad01','p1');
  assert.equal(intact.drawingDraft.drawing.width,200);
  assert.equal(intact.tiles[0].width,100);
  // Fresh capture validation untouched: normal freeze still pins its own dims.
  const fresh=await capture.begin(owner(),{});
  assert.equal(fresh.width,200);assert.equal(fresh.height,100);
  await assert.rejects(()=>capture.invoke(event(),'commit',{captureId:fresh.captureId,png:'data:image/png;base64,'+commitPng(180,90).toString('base64'),local:true}),/尺寸与已捕获画面不一致/);
});

test('a reloaded owner is orphaned: begin supersedes only the dead session',async t=>{
  const view=makeView();
  const root=makeRoot({views:[view]});
  const other=makeRoot({projectId:'p1',windowId:'side',views:[]});
  const {capture,owner,workspace,cleanup}=await makeCapture({root});
  t.after(cleanup);
  workspace.windows.set('side',other);workspace.senders.set(other.wc.id,other);
  const first=await capture.begin(owner(),{});
  // A live foreign window may neither take over nor kill the session.
  await assert.rejects(()=>capture.begin({wc:other.wc,projectId:'p1',windowId:'side',generation:0}),/另一窗口正在涂鸦/);
  assert.equal(capture.active.id,first.captureId);
  await assert.rejects(()=>capture.begin({wc:other.wc,projectId:'p2',windowId:'side',generation:0}),/另一项目正在涂鸦/);
  assert.equal(capture.active.id,first.captureId);
  // Owner reload bumps its generation: the session is orphaned and superseded.
  root.generation++;
  const resumed=await capture.begin(owner(),{});
  assert.notEqual(resumed.captureId,first.captureId);
  assert.ok(resumed.recoverable.some(r=>r.id===first.captureId));
  assert.equal(capture.active.ownerGeneration,root.generation);
});

test('foreign-project surface is rejected before reading any of its pixels',async t=>{
  const view=makeView();view.webContents.senderScope={...surfaceScope(view),projectId:'p2'};
  let reads=0;view.webContents.capturePage=async()=>{reads++;throw Error('must not read');};
  const root=makeRoot({views:[view]});const {capture,owner,cleanup}=await makeCapture({root});t.after(cleanup);
  await assert.rejects(capture.begin(owner()),error=>error.code==='CAPTURE_SCOPE_DENIED');
  assert.equal(reads,0);assert.equal(capture.active,null);
});

// Production passes the live sender record to begin (main.cjs) and bindProject
// mutates it in place, so these regressions pass the mutable root itself — the
// owner() helper returns copies and would hide the mutation hazard.
test('project switch while recoveryDirectory awaits aborts before any store or pixel use',async t=>{
  const view=makeView();
  const root=makeRoot({views:[view]});
  const {capture,host,cleanup}=await makeCapture({root});
  t.after(cleanup);
  let reads=0;const originalCapture=view.webContents.capturePage;
  view.webContents.capturePage=async(...a)=>{reads++;return originalCapture(...a);};
  const gate=deferred();const dirs=[];
  const originalDirectory=host.storage.recoveryDirectory;
  host.storage.recoveryDirectory=async id=>{dirs.push(id);await gate.promise;return originalDirectory(id);};
  const beginning=capture.begin(root,{});
  await flush();
  assert.deepEqual(dirs,['p1']); // flight is parked inside recoveryDirectory
  root.projectId='p2'; // bindProject mutates the live record mid-await
  gate.resolve();
  await assert.rejects(beginning,error=>error.code==='CAPTURE_INVALIDATED');
  assert.equal(reads,0); // no pixel read after the preparation boundary
  assert.equal(capture.active,null);assert.equal(capture.preparing,false);
  // A fresh begin under the new project uses the new store: the aborted flight
  // never mixed old-project recovery storage with new-project pixels.
  const next=await capture.begin(root,{});
  assert.equal(next.projectId,'p2');
  assert.deepEqual(next.recoverable.map(r=>r.id),[next.captureId]);
});

test('a reload during the settings check aborts before any pixel read',async t=>{
  const view=makeView();
  const root=makeRoot({views:[view]});
  const {capture,cleanup}=await makeCapture({root});
  t.after(cleanup);
  let reads=0;const originalCapture=view.webContents.capturePage;
  view.webContents.capturePage=async(...a)=>{reads++;return originalCapture(...a);};
  const gate=deferred();let entered=false;
  root.wc.executeJavaScript=async()=>{entered=true;await gate.promise;return false;};
  const beginning=capture.begin(root,{});
  await flush();
  assert.ok(entered);assert.equal(reads,0); // settings check precedes any capturePage
  root.generation++; // reload bumps the live generation mid-check
  gate.resolve();
  await assert.rejects(beginning,error=>error.code==='CAPTURE_INVALIDATED');
  assert.equal(reads,0);
  assert.equal(capture.active,null);assert.equal(capture.preparing,false);
  const next=await capture.begin(root,{});
  assert.deepEqual(next.recoverable.map(r=>r.id),[next.captureId]); // nothing published by the orphaned flight
});

const failOnceDeliver=(capture,deliveries)=>{const blocked=new Set();capture.deliver=async(session,event)=>{
  if(blocked.has(event.deliveryId)){blocked.delete(event.deliveryId);throw Error('激活对话失败');}
  deliveries.push({session,event});};return blocked;};

test('failed delivery keeps the dialog: unchanged live retry reuses the original receipt',async t=>{
  const view=makeView();
  const root=makeRoot({views:[view]});
  const {capture,owner,event,attachCalls,deliveries,cleanup}=await makeCapture({root});
  t.after(cleanup);
  const blocked=failOnceDeliver(capture,deliveries);
  const stroke={color:'#ff0000',width:0.05,points:[[0.1,0.1],[0.2,0.2]]};
  const drawing=()=>({schema:'nozeli.region-drawing-v1',width:200,height:100,strokes:[{...stroke,points:stroke.points.slice()}]});
  const png='data:image/png;base64,'+commitPng(200,100).toString('base64');
  const card={message:'问题一',rect:[0.1,0.1,0.2,0.2]};
  const first=await capture.begin(owner(),{});
  const captureId=first.captureId;
  blocked.add(captureId);
  await assert.rejects(()=>capture.invoke(event(),'commit',{captureId,png,target:{card},drawing:drawing()}),/激活对话失败/);
  // The receipt persisted before delivery failed, and the session stays live
  // and authorized under its original captureId.
  assert.equal(capture.active.id,captureId);
  await capture.invoke(event(),'save',{captureId,drawing:drawing()});
  const store=capture.active.store;
  const receipt=await store.load(captureId,'p1');
  assert.equal(receipt.result.state,'pending-delivery');
  assert.equal(attachCalls.length,1);
  // Unchanged retry: the original delivery identity and attachment are reused,
  // no second attachment and no forked record.
  const done=await capture.invoke(event(),'commit',{captureId,png,target:{card},drawing:drawing()});
  assert.deepEqual(done,{saved:true,attached:true,captureId});
  assert.equal(capture.active,null);
  assert.equal(deliveries.length,1);
  assert.equal(deliveries[0].event.deliveryId,captureId);
  assert.deepEqual(deliveries[0].event.card,card);
  assert.equal(attachCalls.length,1);
  const delivered=await store.load(captureId,'p1');
  assert.equal(delivered.result.state,'delivered');
  assert.equal(delivered.result.attachment.digest,receipt.result.attachment.digest);
  assert.equal(delivered.result.card.message,'问题一');
});

test('edited live retry after a failed delivery forks a distinct intent, preserving the original receipt',async t=>{
  const view=makeView();
  const root=makeRoot({views:[view]});
  const {capture,owner,event,attachCalls,deliveries,cleanup}=await makeCapture({root});
  t.after(cleanup);
  const blocked=failOnceDeliver(capture,deliveries);
  const drawing=color=>({schema:'nozeli.region-drawing-v1',width:200,height:100,strokes:[{color,width:0.05,points:[[0.1,0.1],[0.2,0.2]]}]});
  const png='data:image/png;base64,'+commitPng(200,100).toString('base64');
  const first=await capture.begin(owner(),{});
  const captureId=first.captureId;
  blocked.add(captureId);
  await assert.rejects(()=>capture.invoke(event(),'commit',{captureId,png,target:{card:{message:'问题二',rect:[0.1,0.1,0.2,0.2]}},drawing:drawing('#ff0000')}),/激活对话失败/);
  const store=capture.active.store;
  const original=await store.load(captureId,'p1');
  assert.equal(original.result.state,'pending-delivery');
  assert.equal(original.result.card.message,'问题二');
  // Post-receipt live saves never touch the original record: autosave lands on
  // a durable editable fork, the original .drawing bytes stay identical, and
  // the next edited commit reuses that fork as its distinct intent.
  const originalDraftBytes=await fs.readFile(store.file(captureId,'.drawing'));
  await capture.invoke(event(),'save',{captureId,drawing:drawing('#00aa00')});
  const editFork=(await store.listRecoverable('p1')).map(r=>r.id).find(id=>id!==captureId);
  assert.ok(editFork);
  assert.deepEqual(await fs.readFile(store.file(captureId,'.drawing')),originalDraftBytes);
  assert.equal((await store.load(editFork,'p1')).drawingDraft.drawing.strokes[0].color,'#00aa00');
  // Same live dialog: public session auth still answers to the original captureId.
  const done=await capture.invoke(event(),'commit',{captureId,png,target:{card:{message:'问题三',rect:[0.15,0.15,0.2,0.2]}},drawing:drawing('#00aa00')});
  assert.deepEqual(done,{saved:true,attached:true,captureId});
  assert.equal(capture.active,null);
  assert.equal(deliveries.length,1);
  const forkId=deliveries[0].event.deliveryId;
  assert.equal(forkId,editFork); // the autosave fork is reused as the intent
  assert.notEqual(forkId,captureId); // distinct intent: never reuses the persisted delivery id
  assert.equal(deliveries[0].event.card.message,'问题三');
  assert.equal(attachCalls.length,2);
  // The already-persisted original receipt is untouched: question, ink,
  // attachment digest, pending state and the original .drawing bytes.
  const after=await store.load(captureId,'p1');
  assert.equal(after.result.state,'pending-delivery');
  assert.equal(after.result.card.message,'问题二');
  assert.deepEqual(after.result.drawing,original.result.drawing);
  assert.equal(after.result.attachment.digest,original.result.attachment.digest);
  assert.deepEqual(await fs.readFile(store.file(captureId,'.drawing')),originalDraftBytes);
  // The fork is a fully persisted record carrying the edited delivered result.
  const fork=await store.load(forkId,'p1');
  assert.equal(fork.state,'frozen');
  assert.equal(fork.result.state,'delivered');
  assert.equal(fork.result.card.message,'问题三');
  assert.equal(fork.pendingDeliveryId,captureId);
  // Recovery listing: the original stays offerable, the delivered fork does not.
  const picker=await capture.begin(owner(),{});
  assert.ok(picker.recoverable.some(r=>r.id===captureId&&r.state==='pending-delivery'));
  assert.ok(!picker.recoverable.some(r=>r.id===forkId));
});

test('recovering the original after an edited retry opens the original baseline and idempotently re-delivers the original receipt',async t=>{
  const view=makeView();
  const root=makeRoot({views:[view]});
  const {capture,owner,event,attachCalls,deliveries,cleanup}=await makeCapture({root});
  t.after(cleanup);
  const blocked=failOnceDeliver(capture,deliveries);
  const drawing=color=>({schema:'nozeli.region-drawing-v1',width:200,height:100,strokes:[{color,width:0.05,points:[[0.1,0.1],[0.2,0.2]]}]});
  const png='data:image/png;base64,'+commitPng(200,100).toString('base64');
  const originalCard={message:'问题二',rect:[0.1,0.1,0.2,0.2]};
  const first=await capture.begin(owner(),{});
  const captureId=first.captureId;
  blocked.add(captureId);
  await assert.rejects(()=>capture.invoke(event(),'commit',{captureId,png,target:{card:originalCard},drawing:drawing('#ff0000')}),/激活对话失败/);
  const store=capture.active.store;
  const originalDigest=(await store.load(captureId,'p1')).result.attachment.digest;
  // The edited retry in the same dialog delivers as a distinct forked intent.
  const edited=await capture.invoke(event(),'commit',{captureId,png,target:{card:{message:'问题三',rect:[0.15,0.15,0.2,0.2]}},drawing:drawing('#00aa00')});
  assert.equal(edited.attached,true);
  assert.notEqual(deliveries[0].event.deliveryId,captureId);
  // Recovering the ORIGINAL pending record opens its own preserved baseline —
  // never the edited fork's ink.
  const resumed=await capture.begin(owner(),{recoverId:captureId});
  assert.notEqual(resumed.captureId,captureId);
  assert.equal(resumed.drawingDraft.drawing.strokes[0].color,'#ff0000');
  // Committing the unchanged original re-delivers the ORIGINAL receipt id.
  const done=await capture.invoke(event(),'commit',{captureId:resumed.captureId,png,target:{card:originalCard},drawing:drawing('#ff0000')});
  assert.deepEqual(done,{saved:true,attached:true,captureId:resumed.captureId});
  assert.equal(deliveries.length,2);
  assert.equal(deliveries[1].event.deliveryId,captureId); // original delivery identity, idempotent
  assert.deepEqual(deliveries[1].event.card,originalCard);
  const final=await store.load(captureId,'p1');
  assert.equal(final.result.state,'delivered');
  assert.equal(final.result.attachment.digest,originalDigest);
  assert.equal(final.result.card.message,'问题二');
  assert.equal((await store.load(resumed.captureId,'p1')).result.state,'delivered'); // fork mirror marked delivered
  assert.equal(attachCalls.length,2); // the unchanged original never re-attaches
});

test('awaited descriptors are revalidated against the live binding before returning',async t=>{
  // Existing-active re-entry: a rebind during the awaited listRecoverable is
  // never re-served the old session descriptor.
  const view=makeView();
  const root=makeRoot({views:[view]});
  const entry=await makeCapture({root});
  t.after(entry.cleanup);
  const described=await entry.capture.begin(root,{});
  const gate=deferred();const store=entry.capture.active.store;
  const originalList=store.listRecoverable.bind(store);
  store.listRecoverable=async id=>{await gate.promise;return originalList(id);};
  const reentry=entry.capture.begin(root,{});
  await flush();
  root.projectId='p2';
  gate.resolve();
  await assert.rejects(reentry,error=>error.code==='CAPTURE_INVALIDATED');
  assert.equal(entry.capture.active.id,described.captureId); // left for supersede, never re-served
  const rebound=await entry.capture.begin(root,{});
  assert.equal(rebound.projectId,'p2');
  // Fresh publication: the descriptor is assembled before the session is
  // published, so drift during the awaited read publishes nothing.
  const view2=makeView();
  const root2=makeRoot({views:[view2]});
  const fresh=await makeCapture({root:root2});
  t.after(fresh.cleanup);
  const proto=WorkspaceCaptureStore.prototype;
  const originalProtoList=proto.listRecoverable;
  t.after(()=>{proto.listRecoverable=originalProtoList;});
  let release;const gate2=new Promise(r=>{release=r;});
  proto.listRecoverable=async function(id){await gate2;return originalProtoList.call(this,id);};
  const publishing=fresh.capture.begin(root2,{});
  await flush();
  root2.generation++;
  release();
  await assert.rejects(publishing,error=>error.code==='CAPTURE_INVALIDATED');
  assert.equal(fresh.capture.active,null);
  const next=await fresh.capture.begin(root2,{});
  assert.ok(next.captureId);
  // Recovery: a drift during the awaited descriptor blocks activation.
  const view3=makeView();
  const root3=makeRoot({views:[view3]});
  const picking=await makeCapture({root:root3});
  t.after(picking.cleanup);
  const firstRec=await picking.capture.begin(picking.owner(),{});
  await picking.capture.invoke(picking.event(),'cancel',{captureId:firstRec.captureId});
  const secondRec=await picking.capture.begin(picking.owner(),{});
  const gate3=deferred();const store3=picking.capture.active.store;
  const originalList3=store3.listRecoverable.bind(store3);
  store3.listRecoverable=async id=>{await gate3.promise;return originalList3(id);};
  const recovering=picking.capture.invoke(picking.event(),'recover',{captureId:secondRec.captureId,id:firstRec.captureId});
  await flush();
  root3.generation++;
  gate3.resolve();
  await assert.rejects(recovering,/涂鸦会话无效或已过期/);
  assert.equal(picking.capture.active.id,secondRec.captureId); // activation never happened
});

test('repeated failures chain: autosave after a forked failure links the newest receipt and an unchanged restart retries it',async t=>{
  const view=makeView();
  const root=makeRoot({views:[view]});
  const {capture,owner,event,attachCalls,deliveries,cleanup}=await makeCapture({root});
  t.after(cleanup);
  let failures=2; // A's delivery and B's delivery both fail
  capture.deliver=async(session,ev)=>{
    if(failures>0){failures--;throw Error('激活对话失败');}
    deliveries.push({session,event:ev});
  };
  const drawing=color=>({schema:'nozeli.region-drawing-v1',width:200,height:100,strokes:[{color,width:0.05,points:[[0.1,0.1],[0.2,0.2]]}]});
  const png='data:image/png;base64,'+commitPng(200,100).toString('base64');
  const first=await capture.begin(owner(),{});
  const captureId=first.captureId;
  await assert.rejects(()=>capture.invoke(event(),'commit',{captureId,png,target:{card:{message:'问题A',rect:[0.1,0.1,0.2,0.2]}},drawing:drawing('#ff0000')}),/激活对话失败/);
  const store=capture.active.store;
  assert.equal((await store.load(captureId,'p1')).result.state,'pending-delivery');
  // Edited B also fails: its receipt lands on the editable fork.
  await assert.rejects(()=>capture.invoke(event(),'commit',{captureId,png,target:{card:{message:'问题B',rect:[0.12,0.12,0.2,0.2]}},drawing:drawing('#00aa00')}),/激活对话失败/);
  const forkB=(await store.listRecoverable('p1')).map(r=>r.id).find(id=>id!==captureId);
  assert.ok(forkB);
  assert.equal((await store.load(forkB,'p1')).result.state,'pending-delivery');
  // Autosave C after the forked failure creates a new durable fork linked to
  // the CURRENT pending receipt (B), not the original one.
  await capture.invoke(event(),'save',{captureId,drawing:drawing('#0000cc')});
  const forkC=(await store.listRecoverable('p1')).map(r=>r.id).find(id=>id!==captureId&&id!==forkB);
  assert.ok(forkC);
  assert.equal((await store.load(forkC,'p1')).pendingDeliveryId,forkB);
  // Restart: recover the autosaved fork C, then retry UNCHANGED B content.
  await capture.invoke(event(),'cancel',{captureId});
  const resumed=await capture.begin(owner(),{recoverId:forkC});
  assert.equal(resumed.captureId,forkC); // no result yet: resumed in place
  assert.equal(resumed.drawingDraft.drawing.strokes[0].color,'#0000cc');
  const done=await capture.invoke(event(),'commit',{captureId:forkC,png,target:{card:{message:'问题B',rect:[0.12,0.12,0.2,0.2]}},drawing:drawing('#00aa00')});
  assert.deepEqual(done,{saved:true,attached:true,captureId:forkC});
  // The unchanged B retry re-delivers B's own receipt identity — not A's and
  // not a fourth intent — without re-attaching.
  assert.equal(deliveries.length,1);
  assert.equal(deliveries[0].event.deliveryId,forkB);
  assert.deepEqual(deliveries[0].event.card,{message:'问题B',rect:[0.12,0.12,0.2,0.2]});
  assert.equal(attachCalls.length,2);
  assert.equal((await store.load(forkB,'p1')).result.state,'delivered');
  assert.equal((await store.load(forkC,'p1')).result.state,'delivered'); // fork mirror
  assert.equal((await store.load(captureId,'p1')).result.state,'pending-delivery'); // original A preserved
  assert.equal((await store.load(captureId,'p1')).drawingDraft.drawing.strokes[0].color,'#ff0000');
});
