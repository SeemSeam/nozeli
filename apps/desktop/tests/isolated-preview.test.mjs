import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {previewPath,previewDependencies,previewUrlMember,previewCsp,OFFLINE_BOOTSTRAP,IsolatedPreviewManager,capturePreview} from '../src/main/isolated-preview.mjs';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';

test('manifest path authority rejects traversal, devices, alternate separators and encodings',()=>{
  for(const value of ['../x.html','/x.html','a/../x.html','a\\x.html','x.html:stream','%2e%2e/x.html','a//b.html','CON.html','.nozeli/x.html','a./x.html','http://localhost/x.html'])assert.throws(()=>previewPath(value));
  assert.equal(previewPath('site/index.html'),'site/index.html');
  const files=new Map([['site/index.html',{}]]),origin='https://preview.invalid';
  assert.equal(previewUrlMember(origin+'/site/index.html',origin,files),'site/index.html');
  for(const url of ['file:///site/index.html','http://127.0.0.1/site/index.html','https://other.invalid/site/index.html',origin+'/site/index.html?other',origin+'/site/%2569ndex.html',origin+'/missing.json'])assert.equal(previewUrlMember(url,origin,files),null);
});
test('HTML CSS modules and literal local JSON fetch form one bounded graph',()=>{
  assert.deepEqual(new Set(previewDependencies('site/index.html','<link href="style.css" rel="stylesheet"><script src="app.js"></script><a href="next.html">Next</a><script type="module">import "./module.mjs"; fetch("data.json")</script>')),new Set(['site/style.css','site/app.js','site/next.html','site/module.mjs','site/data.json']));
  assert.deepEqual(previewDependencies('site/a.css','@import "b.css";a{background:url(../image.png)}'),['site/b.css','image.png']);
  assert.deepEqual(previewDependencies('site/a.mjs','import {a} from "./b.mjs"; export {x} from "./c.mjs"; fetch("data.json")'),['site/b.mjs','site/c.mjs','site/data.json']);
  assert.throws(()=>previewDependencies('index.html','<img src="http://127.0.0.1:8000/a.png">'));
});
test('dependency parsing ignores inert strings comments and decodes real escaped literals',()=>{
  const source=String.raw`// import "absent.mjs"; fetch("absent.json")
    const prose='fetch("also-absent.json")';
    import './\u0062.mjs';import('./\x63.mjs');`+'const template=`import "not-code.mjs"`;fetch(`data.json`);';
  assert.deepEqual(previewDependencies('a.js',source),['b.mjs','c.mjs','data.json']);
  assert.deepEqual(previewDependencies('a.css',String.raw`/* @import "absent.css"; url(absent.png) */
    @import "\62.css";a{content:'url(no.png)';background:url("\69 mage.png")}`),['b.css','image.png']);
  assert.deepEqual(previewDependencies('index.html','<script type="application/json">{"prose":"fetch(unknown)"}</script>'),[]);
  assert.throws(()=>previewDependencies('a.js','fetch(prefix+".json")'),/字面量/);
  assert.throws(()=>previewDependencies('a.mjs','import(`./${name}.mjs`)'),/字面量/);
});
test('host CSP denies frames workers forms and static execution independently of document meta',()=>{
  for(const profile of ['staticReport','offlineDevelopment'])for(const directive of ["worker-src 'none'","frame-src 'none'","object-src 'none'","form-action 'none'","base-uri 'none'"])assert.ok(previewCsp(profile).includes(directive));
  assert.ok(previewCsp('staticReport').includes("script-src 'none'"));
  assert.ok(previewCsp('staticReport').includes("connect-src 'none'"));
  assert.ok(previewCsp('offlineDevelopment').includes('sandbox allow-scripts;'));
  assert.ok(!previewCsp('offlineDevelopment').includes('allow-same-origin'));
});
test('first-parser offline bootstrap permanently removes RTC STUN data-channel and other escape constructors',()=>{
  class Navigator{};
  const context=vm.createContext({Navigator,navigator:new Navigator()});
  const denied=['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebSocket','WebTransport','Worker','SharedWorker','open','alert','confirm','prompt'];
  for(const name of denied)context[name]=function(){throw Error('network must not be reached');};
  vm.runInContext(OFFLINE_BOOTSTRAP,context);
  for(const name of denied){assert.equal(vm.runInContext(`typeof ${name}`,context),'undefined');assert.equal(vm.runInContext(`Reflect.set(globalThis,${JSON.stringify(name)},function(){})`,context),false);assert.equal(vm.runInContext(`Reflect.deleteProperty(globalThis,${JSON.stringify(name)})`,context),false);}
  assert.equal(vm.runInContext('navigator.serviceWorker',context),undefined);
});
function harness({load}={}){
  const calls=[],sessions=[],views=[];
  class View{constructor(options){this.options=options;this.visible=false;this.webContents=new EventEmitter();const wc=this.webContents;wc.id=900+views.length;wc.dead=false;wc.isDestroyed=()=>wc.dead;wc.forcefullyCrashRenderer=()=>{wc.crashed=true;};wc.close=()=>{wc.dead=true;};wc.setWebRTCIPHandlingPolicy=value=>calls.push(['rtc',value]);wc.setWindowOpenHandler=fn=>wc.popup=fn;wc.loadURL=async url=>{wc.url=url;return load?.(wc);};this.setBounds=b=>this.bounds=b;this.setVisible=b=>this.visible=b;views.push(this);}}
  const session={fromPartition(partition){const s=new EventEmitter();s.partition=partition;s.protocol={handle:(_scheme,fn)=>s.handler=fn,unhandle:()=>{}};s.webRequest={onBeforeRequest:fn=>s.request=fn};s.setPermissionRequestHandler=fn=>s.permission=fn;s.setPermissionCheckHandler=fn=>s.check=fn;s.setDevicePermissionHandler=fn=>s.device=fn;s.setDisplayMediaRequestHandler=fn=>s.display=fn;s.setProxy=async value=>s.proxy=value;s.setSpellCheckerEnabled=()=>{};sessions.push(s);return s;}};
  const scope={wc:{id:1,isDestroyed:()=>false,send:(...args)=>calls.push(args)},projectId:'p',generation:1,windowId:'main',role:'shell',win:{contentView:{addChildView:()=>{},removeChildView:()=>{}},getContentSize:()=>[800,600]}};
  let rejectRead=false;const source={report:{format:'html-static'},read:async()=>{if(rejectRead)throw Error('changed');return Buffer.from('<h1>Immutable</h1>');},readManifest:async()=>({references:[{id:'0',href:'old.txt'}]}),readReference:async()=>({kind:'artifact',bytes:Buffer.from('frozen'),mediaType:'text/plain',relPath:'old.txt'})};
  const manager=new IsolatedPreviewManager({WebContentsView:View,session,workspace:{},host:{},managedAgents:{reportSource:async()=>source}});
  const payload={key:'report',projectId:'p',objectId:'object',profile:'staticReport',generation:1,bounds:{x:10,y:20,width:300,height:200}};
  return {manager,scope,payload,calls,sessions,views,reject:()=>rejectRead=true};
}
test('actual manager enforces no privileged sender profile and request permission popup download gates',async()=>{
  const h=harness();await h.manager.invoke(h.scope,'isolated-preview.open',h.payload);const view=h.views[0],s=h.sessions[0],prefs=view.options.webPreferences;
  assert.equal(prefs.javascript,false);for(const key of ['nodeIntegration','nodeIntegrationInWorker','nodeIntegrationInSubFrames','webviewTag'])assert.equal(prefs[key],false);assert.equal(prefs.preload,undefined);assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);
  assert.equal(view.webContents.popup().action,'deny');assert.equal(s.check(),false);assert.equal(s.device(),false);s.permission(null,'camera',allowed=>assert.equal(allowed,false));let prevented=false;s.emit('will-download',{preventDefault(){prevented=true;}});assert.ok(prevented);
  for(const url of ['https://example.org','http://127.0.0.1:8080','ws://127.0.0.1:80','file:///etc/passwd','https://app.invalid/index.html'])s.request({url,method:'GET',resourceType:'xhr'},result=>assert.equal(result.cancel,true));
  s.request({url:view.webContents.url,method:'POST',resourceType:'xhr'},result=>assert.equal(result.cancel,true));
  assert.equal((await s.handler({url:view.webContents.url,method:'GET'})).headers.get('content-security-policy'),previewCsp('staticReport',new URL(view.webContents.url).origin));
  const workspace=Object.create(WorkspaceNative.prototype);workspace.senders=new Map();workspace.origin='https://app.invalid/';
  const frame={url:workspace.origin,parent:null};const sender={id:view.webContents.id,mainFrame:frame};for(const op of ['file.read','managed.status','workspace.bootstrap','isolated-preview.open'])assert.throws(()=>workspace.authorize({sender,senderFrame:frame},op,{projectId:'p'}),{code:'IPC_DENIED'});
});
test('failed refresh preserves immutable prior view and frozen reference, close fences future stale generations',async()=>{
  const h=harness();await h.manager.invoke(h.scope,'isolated-preview.open',h.payload);const first=h.views[0];
  const ref=await h.manager.invoke(h.scope,'isolated-preview.reference',{key:'report',generation:1,referenceId:'0'});assert.equal(ref.text,'frozen');
  await assert.rejects(h.manager.invoke(h.scope,'isolated-preview.reference',{key:'report',generation:1,referenceId:'fake'}));
  h.reject();await assert.rejects(h.manager.invoke(h.scope,'isolated-preview.update',{...h.payload,generation:2}));assert.equal(first.webContents.dead,false);assert.equal(h.manager.slots.size,1);
  await h.manager.invoke(h.scope,'isolated-preview.close',{key:'report'});assert.equal(first.webContents.dead,true);assert.equal(h.manager.slots.size,0);await assert.rejects(h.manager.invoke(h.scope,'isolated-preview.open',{...h.payload,generation:2}));
});
test('frozen source references with generic MIME display UTF-8 text, never binary replacements',async()=>{
 const h=harness();let bytes=Buffer.from('export const 结论 = "原冻结版本";\n');
 h.manager.managedAgents.reportSource=async()=>({report:{format:'html-static'},read:async()=>Buffer.from('<h1>Report</h1>'),readManifest:async()=>({references:[{id:'0'}]}),readReference:async()=>({kind:'artifact',relPath:'source.mjs',mediaType:'application/octet-stream',bytes})});
 await h.manager.invoke(h.scope,'isolated-preview.open',h.payload);
 const read=()=>h.manager.invoke(h.scope,'isolated-preview.reference',{key:'report',generation:1,referenceId:'0'});
 assert.equal((await read()).text,bytes.toString('utf8'));
 bytes=Buffer.from([0xff,0xfe,0x00]);assert.equal((await read()).text,undefined);
 bytes=Buffer.from('a\u0000b');assert.equal((await read()).text,undefined);
});
test('report source anchors use intercepted local navigation and only registered references emit',async()=>{
 const h=harness(),original='<a href="nozeli-report-ref:0">Frozen source</a>';
 h.manager.managedAgents.reportSource=async()=>({report:{format:'html-static'},read:async()=>Buffer.from(original),readManifest:async()=>({references:[{id:'0',href:'source.mjs'}]})});
 await h.manager.invoke(h.scope,'isolated-preview.open',h.payload);const wc=h.views[0].webContents,origin=new URL(wc.url).origin;
 const served=await(await h.sessions[0].handler({url:wc.url,method:'GET'})).text();assert(served.includes('href="'+origin+'/__nozeli_report_reference__/0"'));
 let prevented=0;wc.emit('will-frame-navigate',{url:origin+'/__nozeli_report_reference__/0',isMainFrame:true,preventDefault(){prevented++;}});
 assert.equal(prevented,1);assert.equal(h.calls.filter(c=>c[1]?.type==='reference').length,1);
 wc.emit('will-frame-navigate',{url:origin+'/__nozeli_report_reference__/fake',isMainFrame:true,preventDefault(){prevented++;}});
 assert.equal(prevented,2);assert.equal(h.calls.filter(c=>c[1]?.type==='reference').length,1);assert.equal([...h.manager.slots.values()][0].files.get('report.html').bytes.toString(),original);
 wc.emit('will-frame-navigate',{url:origin+'/__nozeli_report_reference__/0',isMainFrame:true,preventDefault(){prevented++;}},origin+'/__nozeli_report_reference__/0',false,true,8,4);
 assert.equal(h.calls.filter(c=>c[1]?.type==='reference').length,2);
 wc.emit('will-frame-navigate',{url:origin+'/__nozeli_report_reference__/0',isMainFrame:false,preventDefault(){prevented++;}},origin+'/__nozeli_report_reference__/0',false,false,8,5);
 assert.equal(h.calls.filter(c=>c[1]?.type==='reference').length,2);
});

test('authoritative buffer capture freezes multi-page CSS JS ESM and JSON without saving',async()=>{
  const texts=new Map([['index.html','<!doctype html><link href="style.css"><script src="app.js"></script><a href="next.html">Next</a>'],['style.css','body{color:red}'],['app.js','import("./module.mjs");fetch("data.json")'],['module.mjs','export const value=1'],['data.json','{"current":true}'],['next.html','<h1>Same snapshot</h1>']]);
  const workspace={buffers:new Map(),projectRecords:()=>[...texts.keys()].map(relPath=>({relPath})),resource:(p,r)=>p+'\0'+r,syncDocument:async()=>()=>{}};
  for(const [relPath,text]of texts)workspace.buffers.set(workspace.resource('p',relPath),{projectId:'p',relPath,text,revision:7,dirty:true});
  const host={requireProject:async()=>({root:'/bounded-project'}),resolveFile:()=>{throw Error('Buffer preview must not save/read disk');}};
  const snapshot=await capturePreview({host,workspace,projectId:'p',entryPath:'index.html'});
  assert.deepEqual(new Set(snapshot.files.keys()),new Set(texts.keys()));
  assert.equal(snapshot.files.get('data.json').version,7);assert.equal(snapshot.files.get('data.json').dirty,true);
  workspace.buffers.get(workspace.resource('p','data.json')).text='{"current":false}';
  assert.equal(snapshot.files.get('data.json').bytes.toString(),'{"current":true}');
  await assert.rejects(capturePreview({host,workspace,projectId:'p',entryPath:'index.html',buffers:[{path:'data.json',version:6}]}));
});

test('owner destruction during async open fences late completion before session creation',async()=>{
  const h=harness();let release;h.manager.managedAgents.reportSource=async()=>new Promise(resolve=>release=resolve);
  const pending=h.manager.invoke(h.scope,'isolated-preview.open',h.payload);h.manager.closeScope(h.scope);h.scope.dead=true;
  release({report:{format:'html-static'},read:async()=>Buffer.from('<h1>Late</h1>'),readManifest:async()=>({references:[]})});
  await assert.rejects(pending);assert.equal(h.sessions.length,0);assert.equal(h.manager.slots.size,0);
});

test('explicit close and owner invalidation cancel pending loads without reviving their guest',async()=>{
  for(const action of ['close','invalidate']){
    let entered;const started=new Promise(resolve=>entered=resolve),h=harness({load:wc=>{entered(wc);return new Promise(()=>{});}});
    const opening=h.manager.invoke(h.scope,'isolated-preview.open',h.payload),rejected=assert.rejects(opening,/取消|过期/);
    const wc=await started;assert.equal(h.manager.pending.size,1);assert.equal(h.manager.slots.size,0);
    if(action==='close')await h.manager.invoke(h.scope,'isolated-preview.close',{key:'report'});else h.manager.closeScope(h.scope);
    await rejected;assert.equal(wc.dead,true);assert.equal(h.manager.pending.size,0);assert.equal(h.manager.slots.size,0);
  }
});

test('new generation cancels stalled replacement while preserving last successful preview',async()=>{
  let loads=0,entered;const started=new Promise(resolve=>entered=resolve),h=harness({load:wc=>{if(++loads===2){entered(wc);return new Promise(()=>{});}}});
  await h.manager.invoke(h.scope,'isolated-preview.open',h.payload);const committed=h.views[0];
  const replacement=h.manager.invoke(h.scope,'isolated-preview.update',{...h.payload,generation:2}),rejected=assert.rejects(replacement,/取消|过期/);
  const pending=await started;h.reject();await assert.rejects(h.manager.invoke(h.scope,'isolated-preview.update',{...h.payload,generation:3}));await rejected;
  assert.equal(pending.dead,true);assert.equal(committed.webContents.dead,false);assert.equal(h.manager.slots.size,1);assert.equal(h.manager.pending.size,0);
});

for(const outcome of ['commit','rollback','close'])test(`pending report load completing after transfer ${outcome} uses only its valid parent`,async()=>{
 let releaseLoad,entered;
 const loaded=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>releaseLoad=resolve);
 const h=harness({load:wc=>{entered(wc);return gate;}});
 const parent=()=>{const children=new Set();return {children,contentView:{addChildView:view=>children.add(view),removeChildView:view=>children.delete(view)},getContentSize:()=>[800,600]};};
 const source=parent(),destination=parent();h.scope.win=source;h.scope.role='surface';h.scope.view={getBounds:()=>({x:5,y:40,width:700,height:500}),getVisible:()=>true};
 const opening=h.manager.invoke(h.scope,'isolated-preview.open',h.payload);
 const rejected=outcome==='close'?assert.rejects(opening,/取消|过期/):null;
 const wc=await loaded;assert.equal(h.manager.pending.size,1);h.scope.transferring=true;
 h.manager.reparentScope(h.scope,destination);
 if(outcome==='commit'){h.scope.win=destination;h.scope.windowId='floating';}
 if(outcome==='rollback')h.manager.reparentScope(h.scope,source);
 if(outcome==='close'){h.manager.closeScope(h.scope);h.scope.dead=true;}
 h.scope.transferring=false;releaseLoad();
 if(outcome==='close'){await rejected;assert.equal(wc.dead,true);assert.equal(h.manager.slots.size,0);assert.equal(h.manager.pending.size,0);assert.equal(source.children.size,0);assert.equal(destination.children.size,0);}
 else {await opening;const slot=[...h.manager.slots.values()][0],owner=outcome==='commit'?destination:source,other=outcome==='commit'?source:destination;assert.equal(slot.view.webContents,wc);assert.equal(slot.parentWindow,owner);assert(owner.children.has(slot.view));assert.equal(other.children.size,0);assert.equal(wc.dead,false);assert.equal(h.manager.pending.size,0);}
});

test('report requested bounds survive an initially zero-sized native surface and later shrink/grow',async()=>{
 const h=harness();let parent={x:20,y:30,width:0,height:0};
 h.scope.role='surface';h.scope.view={getBounds:()=>parent,getVisible:()=>true};
 await h.manager.invoke(h.scope,'isolated-preview.open',h.payload);
 const slot=[...h.manager.slots.values()][0];
 assert.equal(slot.view.visible,false);assert.deepEqual(slot.bounds,h.payload.bounds);
 parent={x:20,y:30,width:800,height:600};h.manager.bounds(slot,slot.bounds);
 assert.equal(slot.view.visible,true);assert.deepEqual(slot.view.bounds,{x:30,y:50,width:300,height:200});
 parent.width=100;h.manager.bounds(slot,slot.bounds);assert.equal(slot.view.bounds.width,90);
 parent.width=800;h.manager.bounds(slot,slot.bounds);assert.equal(slot.view.bounds.width,300);
 assert.deepEqual(slot.bounds,h.payload.bounds);
});

test('fully scrolled-out report hides without covering review controls',async()=>{
 const h=harness();await h.manager.invoke(h.scope,'isolated-preview.open',h.payload);
 const slot=[...h.manager.slots.values()][0];
 h.manager.bounds(slot,{x:10,y:-300,width:300,height:200});assert.equal(slot.view.visible,false);
 h.manager.bounds(slot,h.payload.bounds);assert.equal(slot.view.visible,true);
});
