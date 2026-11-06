import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {previewPath,previewDependencies,previewUrlMember,previewCsp,OFFLINE_BOOTSTRAP,IsolatedPreviewManager,capturePreview} from '../src/main/isolated-preview.mjs';
import {createHash} from 'node:crypto';
import {documentResourceId} from '../src/domain/document-source.mjs';
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
  assert.deepEqual(previewDependencies('index.html','<img src="http://127.0.0.1:8000/a.png">'),[]);
});
test('external hyperlinks and remote resources stay inert instead of failing the snapshot',()=>{
  const html='<!doctype html><html><head><link rel="stylesheet" href="https://cdn.invalid/reset.css"><script src="https://cdn.invalid/app.js"></script></head><body><a href="https://example.invalid/offline">External</a><a href="//cdn.invalid/mirror">Protocol</a><a href="mailto:x@example.invalid">Mail</a><a href="javascript:void(0)">Void</a><a href="?page=2">Query</a><a href="#top">Top</a><img src="https://cdn.invalid/logo.png" srcset="https://cdn.invalid/logo.png 2x, img/%E5%9B%BE%20%E6%A0%87.png 1x"><img src="/media/poster.png"><style>@import "https://cdn.invalid/font.css";a{background:url("//cdn.invalid/bg.png")}</style><script type="module">import "https://cdn.invalid/mod.mjs";fetch("http://127.0.0.1:9/data.json")</script></body></html>';
  assert.deepEqual(new Set(previewDependencies('site/index.html',html)),new Set(['media/poster.png','site/img/图 标.png']));
  for(const value of ['%2e%2e/x.png','a%2fb.png','bad%zz.png','weird%.png','x%252e.png'])assert.deepEqual(previewDependencies('index.html','<img src="'+value+'">'),[]);
});
test('srcset tokenization keeps embedded URL commas and treats separator commas browser-style',()=>{
  assert.deepEqual(previewDependencies('index.html','<img srcset="https://cdn.invalid/a,b.png 1x">'),[]);
  assert.deepEqual(previewDependencies('index.html','<img srcset="images/a,b.png 1x">'),['images/a,b.png']);
  assert.deepEqual(previewDependencies('index.html','<img srcset="a.png 1x, images/b,c.png 2x, ,d.png">'),['a.png','images/b,c.png','d.png']);
  assert.deepEqual(previewDependencies('index.html','<img srcset="a.png 1x,b.png 2x">'),['a.png','b.png']);
  assert.deepEqual(previewDependencies('index.html','<img srcset="a.png 1x,">'),['a.png']);
});
test('navigable hrefs settle only on captured local HTML while resources may use any supported type',()=>{
  const html='<a href="next.html">Page</a><a href="docs/manual.pdf">Manual</a><a href="https://example.invalid/">External</a><area href="map.html"><link href="style.css"><img src="logo.png">';
  assert.deepEqual(new Set(previewDependencies('site/index.html',html)),new Set(['site/next.html','site/map.html','site/style.css','site/logo.png']));
});
test('traversal beyond the project root still rejects the whole capture',()=>{
  assert.throws(()=>previewDependencies('index.html','<script src="../outside-project.js"></script>'),/逃逸/);
  assert.throws(()=>previewDependencies('site/index.html','<link href="../../escape.css">'),/逃逸/);
  assert.deepEqual(previewDependencies('site/index.html','<a href="../root.html">'),['root.html']);
});
test('spaces and Chinese filenames capture and round-trip URL encoding for .htm and .html',()=>{
  assert.equal(previewPath('中文 页面.htm'),'中文 页面.htm');
  assert.equal(previewPath('my file.html'),'my file.html');
  assert.deepEqual(previewDependencies('中文 页面.htm','<img src="图 标.svg"><a href="下一 页.html">'),['图 标.svg','下一 页.html']);
  const origin='https://preview.invalid';
  for(const rel of ['中文 页面.htm','图 标.svg','my file.html']){
    const files=new Map([[rel,{}]]),url=origin+'/'+rel.split('/').map(encodeURIComponent).join('/');
    assert.equal(previewUrlMember(url,origin,files),rel);
  }
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
function harness({load,host,workspace}={}){
  const calls=[],sessions=[],views=[];
  class ClipView{constructor(){this.children=[];this.visible=false;}addChildView(view){this.children.push(view);}removeChildView(view){this.children=this.children.filter(child=>child!==view);}setBorderRadius(){}setBounds(bounds){this.bounds=bounds;}getBounds(){return this.bounds;}setVisible(value){this.visible=value;}getVisible(){return this.visible;}}
  class View{constructor(options){this.options=options;this.visible=false;this.webContents=new EventEmitter();const wc=this.webContents;wc.id=900+views.length;wc.dead=false;wc.isDestroyed=()=>wc.dead;wc.forcefullyCrashRenderer=()=>{wc.crashed=true;};wc.close=()=>{wc.dead=true;};wc.setWebRTCIPHandlingPolicy=value=>calls.push(['rtc',value]);wc.setWindowOpenHandler=fn=>wc.popup=fn;wc.loadURL=async url=>{wc.url=url;return load?.(wc);};this.setBounds=b=>this.bounds=b;this.setVisible=b=>this.visible=b;views.push(this);}}
  const session={fromPartition(partition){const s=new EventEmitter();s.partition=partition;s.protocol={handle:(_scheme,fn)=>s.handler=fn,unhandle:()=>{}};s.webRequest={onBeforeRequest:fn=>s.request=fn};s.setPermissionRequestHandler=fn=>s.permission=fn;s.setPermissionCheckHandler=fn=>s.check=fn;s.setDevicePermissionHandler=fn=>s.device=fn;s.setDisplayMediaRequestHandler=fn=>s.display=fn;s.setProxy=async value=>s.proxy=value;s.setSpellCheckerEnabled=()=>{};sessions.push(s);return s;}};
  const scope={wc:{id:1,isDestroyed:()=>false,send:(...args)=>calls.push(args)},projectId:'p',generation:1,windowId:'main',role:'shell',win:{contentView:{addChildView:()=>{},removeChildView:()=>{}},getContentSize:()=>[800,600]}};
  let rejectRead=false;const source={report:{format:'html-static'},read:async()=>{if(rejectRead)throw Error('changed');return Buffer.from('<h1>Immutable</h1>');},readManifest:async()=>({references:[{id:'0',href:'old.txt'}]}),readReference:async()=>({kind:'artifact',bytes:Buffer.from('frozen'),mediaType:'text/plain',relPath:'old.txt'})};
  const manager=new IsolatedPreviewManager({View:ClipView,WebContentsView:View,session,workspace:workspace??{},host:host??{},managedAgents:{reportSource:async()=>source}});
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

test('offline development opens spaced Chinese .htm entries with external links, prints and gates guests',async()=>{
  const texts=new Map([['中文 页面.htm','<!doctype html><p>页面</p><a href="https://example.invalid/offline">External</a><img src="图 标.svg">'],['图 标.svg','<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' ]]);
  const workspace={buffers:new Map(),projectRecords:()=>[...texts.keys()].map(relPath=>({relPath})),resource:(p,r)=>p+'\0'+r,syncDocument:async()=>()=>{}};
  for(const [relPath,text]of texts)workspace.buffers.set(workspace.resource('p',relPath),{projectId:'p',relPath,text,revision:2,dirty:false});
  const host={requireProject:async()=>({root:'/bounded-project'}),resolveFile:()=>{throw Error('Buffer preview must not save/read disk');}};
  const h=harness({host,workspace});
  const snapshot=await h.manager.invoke(h.scope,'isolated-preview.open',{key:'web',projectId:'p',profile:'offlineDevelopment',generation:1,entryPath:'中文 页面.htm',bounds:{x:0,y:0,width:400,height:300}});
  assert.equal(snapshot.entryPath,'中文 页面.htm');
  const wc=h.views[0].webContents,origin=new URL(wc.url).origin;
  assert.equal(wc.url,origin+'/'+encodeURIComponent('中文 页面.htm'));
  h.sessions[0].request({url:wc.url,method:'GET',resourceType:'mainFrame'},result=>assert.equal(result.cancel,false));
  for(const details of [{url:'https://example.invalid/x',resourceType:'subFrame'},{url:origin+'/missing.png',resourceType:'image'},{url:'file:///etc/passwd',resourceType:'mainFrame'}])h.sessions[0].request(details,result=>assert.equal(result.cancel,true));
  let prevented=0;wc.emit('will-navigate',{url:'https://example.invalid/offline',preventDefault(){prevented++;}});
  wc.emit('will-navigate',{url:wc.url+'#anchor',preventDefault(){prevented++;}});
  assert.equal(prevented,1,'external navigation is blocked, captured member HTML is not');
  wc.print=(options,callback)=>{assert.equal(options.printBackground,true);callback(true,'ok');};
  assert.deepEqual(await h.manager.invoke(h.scope,'isolated-preview.print',{key:'web',generation:1,silent:true}),{printed:true});
});

test('capture of a .htm graph rejects root escapes loudly while externals never fail it',async()=>{
  const texts=new Map([['index.htm','<script src="../outside-project.js"></script>'],['中文 页面.htm','<p>页面</p>']]);
  const workspace={buffers:new Map(),projectRecords:()=>[...texts.keys()].map(relPath=>({relPath})),resource:(p,r)=>p+'\0'+r,syncDocument:async()=>()=>{}};
  for(const [relPath,text]of texts)workspace.buffers.set(workspace.resource('p',relPath),{projectId:'p',relPath,text,revision:1,dirty:false});
  const host={requireProject:async()=>({root:'/bounded-project'}),resolveFile:()=>{throw Error('Buffer preview must not save/read disk');}};
  await assert.rejects(capturePreview({host,workspace,projectId:'p',entryPath:'index.htm'}),/逃逸/);
  const snapshot=await capturePreview({host,workspace,projectId:'p',entryPath:'中文 页面.htm'});
  assert.deepEqual([...snapshot.files.keys()],['中文 页面.htm']);
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
 else {await opening;const slot=[...h.manager.slots.values()][0],owner=outcome==='commit'?destination:source,other=outcome==='commit'?source:destination;assert.equal(slot.view.webContents,wc);assert.equal(slot.parentWindow,owner);assert(owner.children.has(slot.container));assert.equal(other.children.size,0);assert.equal(wc.dead,false);assert.equal(h.manager.pending.size,0);}
});

test('report requested bounds survive an initially zero-sized native surface and later shrink/grow',async()=>{
 const h=harness();let parent={x:20,y:30,width:0,height:0};
 h.scope.role='surface';h.scope.view={getBounds:()=>parent,getVisible:()=>true};
 await h.manager.invoke(h.scope,'isolated-preview.open',h.payload);
 const slot=[...h.manager.slots.values()][0];
 assert.equal(slot.view.visible,false);assert.deepEqual(slot.bounds,h.payload.bounds);
 parent={x:20,y:30,width:800,height:600};h.manager.bounds(slot,slot.bounds);
 assert.equal(slot.view.visible,true);assert.deepEqual(slot.container.bounds,{x:30,y:50,width:300,height:200});assert.deepEqual(slot.view.bounds,{x:0,y:0,width:300,height:200});
 parent.width=100;h.manager.bounds(slot,slot.bounds);assert.equal(slot.container.bounds.width,90);assert.equal(slot.view.bounds.width,300);
 parent.width=800;h.manager.bounds(slot,slot.bounds);assert.equal(slot.view.bounds.width,300);
 assert.deepEqual(slot.bounds,h.payload.bounds);
});

test('moving the visible report mask never resizes or reloads its HTML viewport',async()=>{
 const h=harness();await h.manager.invoke(h.scope,'isolated-preview.open',h.payload);const slot=[...h.manager.slots.values()][0],wc=slot.view.webContents;
 h.manager.bounds(slot,{...h.payload.bounds,clip:{x:110,y:20,width:200,height:200}});
 assert.deepEqual(slot.container.bounds,{x:110,y:20,width:200,height:200});assert.deepEqual(slot.view.bounds,{x:-100,y:0,width:300,height:200});
 h.manager.bounds(slot,{...h.payload.bounds,clip:{x:10,y:20,width:70,height:200}});
 assert.equal(slot.container.bounds.width,70);assert.equal(slot.view.bounds.width,300);assert.equal(slot.view.webContents,wc);
 h.manager.bounds(slot,h.payload.bounds);assert.deepEqual(slot.view.bounds,{x:0,y:0,width:300,height:200});assert.equal(wc.dead,false);
});

test('late host-window and out-of-order clipping cannot uncover a local discussion',async()=>{
 const h=harness();await h.manager.invoke(h.scope,'isolated-preview.open',h.payload);
 const slot=[...h.manager.slots.values()][0],guest=slot.view.webContents;
 const update=(windowId,boundsSequence,clip)=>h.manager.invoke(h.scope,'isolated-preview.bounds',{key:'report',generation:1,windowId,surfaceGeneration:1,boundsSequence,bounds:{...h.payload.bounds,clip}});
 const first={x:110,y:20,width:200,height:200};await update('main',2,first);
 await update('main',1,h.payload.bounds);assert.deepEqual(slot.container.bounds,first);
 const destination={contentView:{addChildView(){},removeChildView(){}},getContentSize:()=>[800,600]};
 h.manager.reparentScope(h.scope,destination);h.scope.win=destination;h.scope.windowId='detached';
 const current={x:10,y:20,width:70,height:200};await update('detached',1,current);
 await update('main',99,h.payload.bounds);assert.deepEqual(slot.container.bounds,current);
 assert.equal(slot.view.bounds.width,300);assert.equal(slot.view.webContents,guest);
 h.manager.closeScope(h.scope);
});

test('fully scrolled-out report hides without covering review controls',async()=>{
 const h=harness();await h.manager.invoke(h.scope,'isolated-preview.open',h.payload);
 const slot=[...h.manager.slots.values()][0];
 h.manager.bounds(slot,{x:10,y:-300,width:300,height:200});assert.equal(slot.view.visible,false);
 h.manager.bounds(slot,h.payload.bounds);assert.equal(slot.view.visible,true);
});

test('document-end links expose only frozen artifacts and explicit scoped review intent without changing source',async()=>{
 const h=harness(),original='<html><body><p>Final paragraph</p></body></html>',relPath='source<&>.txt';
 h.manager.managedAgents.reportSource=async()=>({report:{format:'html-static'},read:async()=>Buffer.from(original),readManifest:async()=>({references:[]}),listArtifacts:async()=>({files:[{relPath}]})});
 await h.manager.invoke(h.scope,'isolated-preview.open',{...h.payload,endMatter:true});const slot=[...h.manager.slots.values()][0],wc=h.views[0].webContents;
 const served=await(await h.sessions[0].handler({url:wc.url,method:'GET'})).text();assert(served.indexOf('Final paragraph')<served.indexOf('data-nozeli-report-endmatter'));assert(served.includes('source&lt;&amp;&gt;.txt'));assert.equal(slot.files.get('report.html').bytes.toString(),original);assert.equal(h.views[0].options.webPreferences.javascript,false);
 const event={isMainFrame:true,preventDefault(){}};wc.emit('will-frame-navigate',event,slot.endBase+'review');wc.emit('will-frame-navigate',event,slot.endBase+'file/0');
 assert.deepEqual(h.calls.filter(row=>row[1]?.type==='end-matter').map(row=>({action:row[1].action,relPath:row[1].relPath})),[{action:'review',relPath:undefined},{action:'file',relPath}]);
 wc.emit('will-frame-navigate',event,slot.endBase+'file/1');wc.emit('will-frame-navigate',event,slot.origin+'/__nozeli_report_end__/forged/review');assert.equal(h.calls.filter(row=>row[1]?.type==='end-matter').length,2);
});

test('read-only end matter cannot expose review commands and ordinary previews have no footer',async()=>{
 for(const endMatter of ['files',undefined]){const h=harness(),source=await h.manager.managedAgents.reportSource();source.listArtifacts=async()=>({files:[{relPath:'frozen.txt'}]});h.manager.managedAgents.reportSource=async()=>source;await h.manager.invoke(h.scope,'isolated-preview.open',{...h.payload,endMatter});const slot=[...h.manager.slots.values()][0],wc=h.views[0].webContents,served=await(await h.sessions[0].handler({url:wc.url,method:'GET'})).text();assert.equal(served.includes('data-nozeli-endmatter-action="review"'),false);wc.emit('will-frame-navigate',{isMainFrame:true,preventDefault(){}},slot.endBase+'review');assert.equal(h.calls.filter(row=>row[1]?.type==='end-matter').length,0);}
});

test('review document capture freezes the source-scoped buffer and frozen dependencies, never project disk',async()=>{
 const sha=value=>createHash('sha256').update(value).digest('hex');
 const reviewSource={type:'review',workId:'work-1',objectId:'object-1'};
 const unsaved='<!doctype html><html><body><h1>UNSAVED_REVIEW_HTML</h1><script src="candidate.js"></script></body></html>';
 const frozen='document.body.dataset.source="FROZEN_CANDIDATE";';
 let drift=false,adapterUsed=false;
 const adapter={
   async read({relPath}){
     if(relPath==='candidate.js')return {text:frozen,digest:sha(Buffer.from(frozen,'utf8'))};
     if(relPath==='gone.css')return {text:null,bytes:null,unsupportedReason:'frozen-size'};
     throw Object.assign(Error('此文件不在该发布的审校清单中；未读取项目源文件。'),{code:'NOT_FOUND'});},
   async currentBytes({relPath}){return relPath==='candidate.js'?Buffer.from(drift?'DRIFTED':frozen,'utf8'):null;}
 };
 const workspace={buffers:new Map(),synced:[],projectRecords:()=>[{relPath:'candidate.html',documentSource:reviewSource},{relPath:'other.html',documentSource:reviewSource},{relPath:'candidate.html'}],resource:(project,rel,source)=>project+'\0'+documentResourceId(project,source,rel),syncDocument:async call=>{workspace.synced.push(call);return ()=>{};}};
 workspace.buffers.set(workspace.resource('p','candidate.html',reviewSource),{projectId:'p',relPath:'candidate.html',documentSource:structuredClone(reviewSource),text:unsaved,revision:4,dirty:true});
 workspace.buffers.set(workspace.resource('p','broken.html',reviewSource),{projectId:'p',relPath:'broken.html',documentSource:structuredClone(reviewSource),text:'<link href="gone.css">',revision:1,dirty:false});
 workspace.buffers.set(workspace.resource('p','candidate.html'),{projectId:'p',relPath:'candidate.html',text:'PROJECT_SAME_PATH_MUST_NOT_PREVIEW',revision:9,dirty:true});
 const host={requireProject:async()=>({root:'/bounded-project'}),requireReviewDocuments:()=>{adapterUsed=true;return adapter;},resolveFile:()=>{throw Error('review preview must never read project disk');}};
 const snapshot=await capturePreview({host,workspace,projectId:'p',entryPath:'candidate.html',documentSource:reviewSource});
 assert.equal(adapterUsed,true);
 assert.equal(snapshot.files.get('candidate.html').bytes.toString(),unsaved);
 assert.equal(snapshot.files.get('candidate.html').version,4);assert.equal(snapshot.files.get('candidate.html').dirty,true);
 assert.equal(snapshot.files.get('candidate.js').bytes.toString(),frozen);assert.equal(snapshot.files.get('candidate.js').version,null);
 assert.deepEqual(workspace.synced.map(call=>call.relPath+'@'+call.documentSource.workId),['candidate.html@work-1','other.html@work-1']);
 await assert.rejects(capturePreview({host,workspace,projectId:'p',entryPath:'candidate.html',documentSource:reviewSource,buffers:[{path:'candidate.html',version:3}]}),/编辑缓冲版本/);
 await assert.rejects(capturePreview({host,workspace,projectId:'p',entryPath:'broken.html',documentSource:reviewSource}),/预览依赖缺失：gone\.css（frozen-size）/);
 await assert.rejects(capturePreview({host,workspace,projectId:'p',entryPath:'missing.html',documentSource:reviewSource}),/此文件不在该发布的审校清单中/);
 drift=true;await assert.rejects(capturePreview({host,workspace,projectId:'p',entryPath:'candidate.html',documentSource:reviewSource}),/捕获期间审校文档已变化/);drift=false;
 adapterUsed=false;
 const projectPreview=await capturePreview({host,workspace,projectId:'p',entryPath:'candidate.html'});assert.equal(projectPreview.files.get('candidate.html').bytes.toString(),'PROJECT_SAME_PATH_MUST_NOT_PREVIEW');
 assert.equal(adapterUsed,false);assert.deepEqual(workspace.synced.at(-1).documentSource,{type:'project'});
});

test('preview open binds to the owning surface document source and rejects foreign publication redirection',async()=>{
 const reviewSource={type:'review',workId:'work-1',objectId:'object-1'};
 const entry='<!doctype html><html><body><p>REVIEW_ONLY</p></body></html>';
 const workspace={buffers:new Map(),projectRecords:()=>[{relPath:'candidate.html',documentSource:reviewSource}],resource:(project,rel,source)=>project+'\0'+documentResourceId(project,source,rel),syncDocument:async()=>()=>{}};
 workspace.buffers.set(workspace.resource('p','candidate.html',reviewSource),{projectId:'p',relPath:'candidate.html',documentSource:structuredClone(reviewSource),text:entry,revision:2,dirty:false});
 const host={requireProject:async()=>({root:'/bounded-project'}),requireReviewDocuments:()=>({read:async()=>{throw Error('unused');},currentBytes:async()=>Buffer.from(entry,'utf8')}),resolveFile:()=>{throw Error('no project read');}};
 const h=harness({host,workspace});
 h.scope.role='surface';h.scope.kind='document';h.scope.documentSource=reviewSource;h.scope.view={getBounds:()=>({x:0,y:0,width:800,height:600}),getVisible:()=>true};
 h.scope.relPath='candidate.html';
 const open={key:'web',projectId:'p',profile:'offlineDevelopment',generation:1,entryPath:'candidate.html',bounds:{x:0,y:0,width:400,height:300},documentSource:structuredClone(reviewSource)};
 const snapshot=await h.manager.invoke(h.scope,'isolated-preview.open',open);
 assert.equal(snapshot.unsaved,false);assert.equal(snapshot.files.find(file=>file.path==='candidate.html').version,2);
 await assert.rejects(h.manager.invoke(h.scope,'isolated-preview.update',{...open,generation:2,documentSource:{type:'review',workId:'other-work',objectId:reviewSource.objectId}}),/预览来源与当前文档不一致/);
 await assert.rejects(h.manager.invoke(h.scope,'isolated-preview.update',{...open,generation:3,documentSource:{type:'project'}}),/预览来源与当前文档不一致/);
 await assert.rejects(h.manager.invoke(h.scope,'isolated-preview.update',{...open,generation:4,documentSource:{type:'review',workId:'work-1',objectId:'object-1',extra:1}}),/预览来源无效/);
 assert.equal([...h.manager.slots.values()][0].generation,1);
});

test('baseline sibling grant stays within owning project publication side and entry',async()=>{
 const owner={type:'review',workId:'work-1',objectId:'object-1'},baseline={...owner,type:'review-version',version:{kind:'baseline'}};
 const bytes=Buffer.from('<h1>Frozen before</h1>');
 const workspace={buffers:new Map(),projectRecords:()=>[],resource:(p,rel,source)=>documentResourceId(p,source,rel)};
 const host={requireProject:async()=>({root:'/bounded'}),requireReviewDocuments:()=>({read:async()=>({text:bytes.toString()}),currentBytes:async()=>bytes})};
 const h=harness({host,workspace});Object.assign(h.scope,{role:'surface',kind:'document',relPath:'candidate.html',documentSource:owner,view:{getBounds:()=>({x:0,y:0,width:800,height:600}),getVisible:()=>true}});
 const open={key:'before',projectId:'p',profile:'offlineDevelopment',generation:1,entryPath:'candidate.html',documentSource:baseline,bounds:{x:0,y:0,width:300,height:200}};
 await h.manager.invoke(h.scope,'isolated-preview.open',open);
 const denied=[{projectId:'other-project'},{documentSource:{...baseline,workId:'foreign'}},{documentSource:{...baseline,objectId:'foreign'}},{documentSource:{...baseline,version:{kind:'candidate'}}},{documentSource:{...baseline,version:{kind:'draft',revision:1}}},{documentSource:{type:'project'}},{entryPath:'other.html'}];
 for(const change of denied)await assert.rejects(h.manager.invoke(h.scope,'isolated-preview.update',{...open,generation:2,...change}),{code:'PREVIEW_DENIED'});
 assert.equal(h.views.length,1);assert.equal(h.manager.slots.values().next().value.generation,1);
 h.scope.documentSource={...baseline,version:{kind:'candidate'}};
 await h.manager.invoke(h.scope,'isolated-preview.update',{...open,generation:2});
 h.scope.documentSource=baseline;
 await h.manager.invoke(h.scope,'isolated-preview.update',{...open,generation:3});
 h.scope.documentSource={type:'project'};
 await assert.rejects(h.manager.invoke(h.scope,'isolated-preview.update',{...open,generation:4}),{code:'PREVIEW_DENIED'});
});

test('capture tolerates identical source-buffer republish but refuses changed content during dependency loading',async()=>{
 const source={type:'review',workId:'work-1',objectId:'object-1'},key='p-review-entry';let change=false;
 const html='<script src="candidate.js"></script>',buffer={projectId:'p',text:html,revision:1,digest:'source-base'};
 const workspace={buffers:new Map([[key,buffer]]),projectRecords:()=>[],resource:(_id,rel)=>rel==='entry.html'?key:rel};
 const adapter={read:async()=>{const current=workspace.buffers.get(key);workspace.buffers.set(key,{...current,revision:current.revision+1,text:change?html+'changed':html});return {text:'const candidate=1;'};},currentBytes:async()=>Buffer.from('const candidate=1;')};
 const host={requireProject:async()=>({root:'/source'}),requireReviewDocuments:()=>adapter};
 assert.equal((await capturePreview({host,workspace,projectId:'p',entryPath:'entry.html',documentSource:source})).files.get('entry.html').bytes.toString(),html);
 change=true;await assert.rejects(capturePreview({host,workspace,projectId:'p',entryPath:'entry.html',documentSource:source}),/编辑缓冲已变化/);
});
