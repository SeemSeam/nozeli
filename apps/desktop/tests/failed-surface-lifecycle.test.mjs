import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceNative } from '../src/main/workspace-native.mjs';
import { createLayout, reduceLayout } from '../src/domain/workspace-layout.mjs';
import { testStorageOptions } from './project-storage.fixture.mjs';
let sequence = 0;
class Contents extends EventEmitter {
  constructor(){ super(); this.id = ++sequence; this.mainFrame = { url: 'http://127.0.0.1:9000/', parent: null }; this.sent = []; }
  setWindowOpenHandler(){} send(channel,payload){ this.sent.push({channel,payload}); this.onSend?.(channel,payload); } async loadURL(){} close(){ this.emit('destroyed'); } isDestroyed(){ return false; }
  setBackgroundThrottling(value){ this.backgroundThrottling = value; }
}
class View { constructor(){ this.webContents = new Contents(); } setVisible(value){ this.visible = value; } setBounds(value){ this.bounds = value; } getBounds(){ return this.bounds || {x:0,y:0,width:500,height:500}; } }
class Window extends EventEmitter {
  constructor(options = {}){ super(); this.options = options; this.webContents = new Contents(); this.children = []; this.contentView = { addChildView: v => this.children.push(v), removeChildView: v => { this.children = this.children.filter(x => x !== v); } }; this.bounds = {x:0,y:0,width:1000,height:760}; }
  async loadURL(){} show(){} focus(){} getBounds(){ return this.bounds; } getContentBounds(){ return this.bounds; } getContentSize(){ return [1000,760]; } isAlwaysOnTop(){ return false; } isDestroyed(){ return !!this.destroyed; } destroy(){ this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); }
  setBounds(bounds){ this.bounds = {...bounds}; this.emit('moved'); }
}
async function fixture(t){
  const directory = await mkdtemp(path.join(os.tmpdir(),'failed-surface-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const {storage,projectId} = await testStorageOptions({contentRoot:path.join(directory,'project')});
  const project = await storage.requireRegistered(projectId);
  const host = {storage, requireProject: async id => { assert.equal(id,'p'); return project; }, requireRegisteredProject: async id => { assert.equal(id,'p'); return project; }, settled: async () => {}};
  host.storage = new Proxy(storage,{ get(target,key){ const value = Reflect.get(target,key); return typeof value === 'function' ? ((id,...args) => value.call(target, id === 'p' ? projectId : id, ...args)) : value; } });
  const native = new WorkspaceNative({BrowserWindow: Window, WebContentsView: View, screen: {getDisplayMatching: () => ({workArea:{x:-1920,y:0,width:1920,height:1080}})}, origin:'http://127.0.0.1:9000/', userDataDir: directory, host});
  const root = native.registerShell(new Window());
  root.projectId = 'p'; root.ready = true;
  native.layouts.set('p', createLayout('p',{workspace:{minimized:true}}));
  return {native, root};
}
async function openSurface(native, relPath = 'a.txt'){
  const layout = reduceLayout(native.layouts.get('p'), {type:'open', view:{kind:'document', relPath}});
  native.layouts.set('p', layout);
  await native.reconcile(layout);
  const view = Object.values(layout.views).find(entry => entry.relPath === relPath);
  return native.surfaces.get(view.id);
}
function receipt(native, record, ok = true){
  record.ready = true;
  record.wc.onSend = (channel, requestId) => {
    if(channel === 'nozeli:flush') queueMicrotask(() => native.acknowledge(record, {requestId, ok, ...(!ok ? {error:{code:'UNSAVED', message:'Draft recovery failed'}} : {})}));
  };
}
// The renderer's honest receipt for a surface whose document never loaded:
// retention ran through the real flush channel but preserved nothing.
function honestEmptyReceipt(native, r, reason = 'document-not-loaded'){
  r.wc.onSend = (channel,payload) => { if(channel === 'nozeli:flush') queueMicrotask(() => native.acknowledge(r,{requestId:payload, ok:true}, {ok:true, retained:false, reason})); };
}
const settleFailure = (native, surface, error = {code:'DOCUMENT_NOT_FOUND', message:'原项目内容未能载入，未发布工作面就绪。'}) =>
  native.invoke(surface, 'workspace.ready', {contentFailed:true, error});
const flushSent = surface => surface.wc.sent.filter(entry => entry.channel === 'nozeli:flush');

test('terminal init failure settles honestly, flushes through the real chain and closes the project without the ten-second stall', async t => {
  const {native, root} = await fixture(t);
  const surface = await openSurface(native, 'a.txt');
  let readyWakes = 0, settledWakes = 0;
  surface.wc.on('nozeli-content-ready', () => readyWakes++);
  surface.wc.on('nozeli-init-settled', () => settledWakes++);
  const settled = await settleFailure(native, surface);
  assert.equal(surface.ready, false, 'a failed surface must never claim readiness');
  assert.equal(surface.contentFailed, true);
  assert.deepEqual(surface.initError, {code:'DOCUMENT_NOT_FOUND', message:'原项目内容未能载入，未发布工作面就绪。'});
  assert.equal(settled.contentFailed, true, 'bootstrap must expose the failure instead of pretending ready');
  assert.equal(settled.initError?.code, 'DOCUMENT_NOT_FOUND');
  assert.equal(settled.role, 'surface');
  assert.equal(readyWakes, 0, 'failure must not emit nozeli-content-ready');
  assert.equal(settledWakes, 1, 'failure wakes waiting flushers via nozeli-init-settled');
  honestEmptyReceipt(native, surface);
  const started = Date.now();
  const value = await native.flushOne(surface);
  assert(Date.now() - started < 2500, 'a settled failure must not pay the ten-second not-ready wait');
  assert.equal(flushSent(surface).length, 1, 'flush is really sent, never skipped');
  assert.equal(value.ok, true);
  assert.equal(value.retained, false);
  assert.equal(value.reason, 'document-not-loaded');
  receipt(native, root);
  const closed = await native.closeProject('p');
  assert.equal(closed.closed, true);
  assert.equal(native.surfaces.size, 0, 'the failed host is only destroyed after capture completes');
  assert.equal(root.projectId, null);
  assert.equal(root.dead, false);
});

test('a still-loading surface is never treated as draft-less: flush waits for readiness and then really saves', async t => {
  const {native, root} = await fixture(t);
  const surface = await openSurface(native, 'a.txt');
  surface.wc.onSend = (channel,payload) => { if(channel === 'nozeli:flush') queueMicrotask(() => native.acknowledge(surface,{requestId:payload, ok:true})); };
  const pending = native.flushOne(surface);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(flushSent(surface).length, 0, 'no flush request may precede content readiness');
  assert.equal(surface.contentFailed, false);
  const ready = await native.invoke(surface, 'workspace.ready', {contentReady:true});
  const value = await pending;
  assert.equal(flushSent(surface).length, 1);
  assert.equal(value.ok, true);
  assert.equal(value.retained, undefined, 'the normal path carries no empty-retention marker');
  assert.equal(surface.ready, true);
  assert.equal(ready.contentFailed, false);
  assert.equal(ready.initError, null);
  receipt(native, root);
  assert.equal((await native.closeProject('p')).closed, true);
});

test('the failed-state admission is reserved for the retention flush; document sync still refuses', async t => {
  const {native} = await fixture(t);
  const surface = await openSurface(native, 'a.txt');
  await settleFailure(native, surface);
  native.bootstrap(surface); // the failed surface owns the edit lease
  const started = Date.now();
  await assert.rejects(native.flushOne(surface, 'nozeli:document-sync', {projectId:'p', relPath:'a.txt'}), {code:'SURFACE_NOT_READY'});
  assert(Date.now() - started < 2500, 'the business-channel refusal is immediate, not another ten-second stall');
  await assert.rejects(native.syncDocument({projectId:'p', relPath:'a.txt', hold:true}), {code:'SURFACE_NOT_READY'});
  assert.equal(flushSent(surface).length, 0, 'no document-sync request may leave for a failed surface');
  // The retention channel stays admitted: the same surface still flushes.
  honestEmptyReceipt(native, surface);
  assert.equal((await native.flushOne(surface)).reason, 'document-not-loaded');
  assert.equal(flushSent(surface).length, 1);
});

test('during a demo project close a still-loading surface is held, not destroyed', async t => {
  const {native, root} = await fixture(t);
  native.guidedDemo = {isDemo: () => true, pauseProject: async () => {}};
  const surface = await openSurface(native, 'a.txt');
  receipt(native, root);
  const closing = native.closeProject('p');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(surface.dead, false, 'an unresolved surface owns possible drafts and must not be destroyed on close');
  assert.equal(native.surfaces.has(surface.viewId), true);
  assert.equal(flushSent(surface).length, 0);
  honestEmptyReceipt(native, surface);
  await settleFailure(native, surface);
  assert.equal((await closing).closed, true);
});

test('a surface that never settles still refuses close with SURFACE_NOT_READY and releases the lifecycle hold', async t => {
  const {native, root} = await fixture(t);
  const surface = await openSurface(native, 'a.txt');
  const layout = native.layouts.get('p');
  receipt(native, root);
  await assert.rejects(native.closeProject('p'), error => error.code === 'PROJECT_FLUSH_FAILED'
    && error.failures.some(failure => failure.viewId === surface.viewId && failure.code === 'SURFACE_NOT_READY'));
  assert.equal(surface.dead, false, 'refusal keeps the surface and its potential drafts alive');
  assert.equal(native.surfaces.has(surface.viewId), true);
  assert.equal(native.layouts.get('p'), layout, 'refusal commits no layout change');
  const controls = surface.wc.sent.filter(entry => entry.channel === 'nozeli:workspace-control');
  assert.equal(controls.at(-1).payload.type, 'lifecycle-hold');
  assert.equal(controls.at(-1).payload.held, false, 'input hold is restored after refusal');
});

test('a real retention failure still refuses close even beside an honestly-settled failed surface', async t => {
  const {native, root} = await fixture(t);
  const failed = await openSurface(native, 'a.txt');
  await settleFailure(native, failed);
  honestEmptyReceipt(native, failed);
  const broken = await openSurface(native, 'b.txt');
  receipt(native, broken, false);
  receipt(native, root);
  await assert.rejects(native.closeProject('p'), error => error.code === 'PROJECT_FLUSH_FAILED'
    && error.failures.some(failure => failure.viewId === broken.viewId && failure.code === 'UNSAVED'));
  assert.equal(failed.dead, false);
  assert.equal(broken.dead, false, 'the failing owner keeps its live host for recovery');
  assert.equal(native.surfaces.size, 2);
  for (const surface of [failed, broken]) {
    const controls = surface.wc.sent.filter(entry => entry.channel === 'nozeli:workspace-control');
    assert.equal(controls.at(-1).payload.held, false);
  }
});

test('reload resets a settled failure under generation protection and demands a fresh report', async t => {
  const {native} = await fixture(t);
  const surface = await openSurface(native, 'a.txt');
  await settleFailure(native, surface);
  const generation = surface.generation;
  const inFlight = native.flushOne(surface); // sent, awaiting the renderer receipt
  surface.wc.emit('did-start-navigation', {}, 'http://127.0.0.1:9000/', false, true);
  await assert.rejects(inFlight, {code:'SURFACE_RELOADED'});
  assert.equal(surface.generation, generation + 1);
  assert.equal(surface.contentFailed, false, 'reload clears the terminal failure marker');
  assert.equal(surface.initError, null);
  assert.equal(surface.ready, false);
  // The new generation must re-settle: flush waits again instead of trusting the stale state.
  const waiting = native.flushOne(surface);
  let flushed = false; waiting.then(() => { flushed = true; }, () => { flushed = true; });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(flushed, false, 'the reloaded generation must re-settle before any flush proceeds');
  assert.equal(flushSent(surface).length, 1, 'no second flush may leave before the fresh generation settles');
  honestEmptyReceipt(native, surface);
  await settleFailure(native, surface);
  assert.equal((await waiting).reason, 'document-not-loaded');
});

test('a renderer crash equally resets the settled failure for the next generation', async t => {
  const {native} = await fixture(t);
  const surface = await openSurface(native, 'a.txt');
  await settleFailure(native, surface);
  const generation = surface.generation;
  surface.wc.emit('render-process-gone', {}, {reason:'crashed'});
  assert.equal(surface.generation, generation + 1);
  assert.equal(surface.contentFailed, false);
  assert.equal(surface.initError, null);
  assert.equal(surface.ready, false);
  await settleFailure(native, surface, {code:'RENDERER_GONE_RETAINED', message:'内容未载入。'});
  honestEmptyReceipt(native, surface, 'project-not-loaded');
  assert.equal((await native.flushOne(surface)).reason, 'project-not-loaded');
});

test('workspace.ready rejects a payload claiming both readiness and failure', async t => {
  const {native} = await fixture(t);
  const surface = await openSurface(native, 'a.txt');
  await assert.rejects(native.invoke(surface, 'workspace.ready', {contentReady:true, contentFailed:true, error:{code:'X', message:'x'}}), {code:'INVALID_READY'});
  assert.equal(surface.ready, false);
  assert.equal(surface.contentFailed, false, 'a rejected report must not be recorded');
});

test('a settled failure surface never gains ready-gated admission', async t => {
  const {native, root} = await fixture(t);
  const surface = await openSurface(native, 'a.txt');
  await settleFailure(native, surface);
  await assert.rejects(native.invoke(root, 'workspace.focus', {viewId:surface.viewId}), {code:'SURFACE_NOT_READY'});
  const groupId = native.layouts.get('p').mainRoot.id;
  await native.invoke(root, 'workspace.bounds', {windowId:'main', viewport:{width:1000,height:760}, groups:[{groupId, viewId:surface.viewId, rect:{x:0,y:34,width:1000,height:700}}]});
  assert.equal(surface.view.visible, true, 'the error page must remain visible without granting business readiness');
});
