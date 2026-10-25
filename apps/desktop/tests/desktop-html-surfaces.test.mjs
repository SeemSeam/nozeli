import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {prepareReading,waitForDesktopPage} from './reading-setup.fixture.mjs';
import {createHash} from 'node:crypto';
import {REPORT_READER_STYLE_ID,REPORT_VIEWPORT_META} from '../src/agents/managed/report-reader-style.mjs';

// Actual files, actual host publication and actual isolated Electron renderers.
// No provider/model, rewritten renderer sources, IPC echoes or installed profile.
const root=path.resolve(import.meta.dirname,'..');
await mkdir(path.join(root,'.test-output'),{recursive:true});
const output=await mkdtemp(path.join(root,'.test-output/html-surfaces-'));
const profile=path.join(output,'profile'),project=path.join(output,'project');await mkdir(project);
const sources={
  'index.html':'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><h1>Real source preview</h1><p id="classic"></p><p id="module"></p><p id="json"></p><script src="classic.js"></script><script type="module" src="module.js"></script><button id="keyboard">Keyboard</button></body></html>',
  'style.css':'body { color: rgb(20, 50, 80); }',
  'classic.js':'document.querySelector("#classic").textContent="CLASSIC_DISK";',
  'module.js':'import {value} from "./dependency.js"; document.querySelector("#module").textContent=value;fetch("./data.json").then(r=>r.json()).then(v=>document.querySelector("#json").textContent=v.value);',
  'dependency.js':'export const value="MODULE_DISK";',
  'data.json':'{"value":"JSON_DISK"}',
  'other.html':'<!doctype html><h1>Other entry</h1>',
};
for(const [name,text]of Object.entries(sources))await writeFile(path.join(project,name),text);
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;
const store=await Workspace.open(path.join(profile,'nozeli','managed-v1',projectId,'runtime'),project,{storage:host.storage,projectId});
const work=await store.submit('html surface smoke','Read the actual frozen report',{name:'真实静态报告'});await store.activate(work.id);
let workRevision=1;
const publish=async(slug,html)=>{if(workRevision>1)await store.continue(work.id);const row=await store.publish(work.id,workRevision,'result',html,slug,{files:[]});await store.settle(work.id);workRevision++;return row;};
const legacyHtml='<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Real frozen report</title><style>:root{color-scheme:light dark}body{max-width:76ch;margin:auto;padding:1rem}pre{overflow:auto}@media print{body{color:black;background:white}}</style></head><body><h1>Real frozen report</h1><p>完成：真实不可变报告。</p><details><summary>Keyboard details</summary><p id="detail">Frozen evidence</p></details><table><tr><th>Result</th><th>Evidence</th></tr><tr><td>Complete</td><td>Actual bytes</td></tr></table><pre>Long code '+ 'wide '.repeat(70)+'</pre></body></html>';
const shortHtml='<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>短报：登录提示文案修订</title></head><body><h1 id="top">短报：登录提示文案已修订</h1><p>结论：三处登录失败提示改为可操作表述，行为无回归；改动仍为 worktree 候选，未采用。</p><p>验证：node --test tests/login-copy.test.mjs 通过 12/12；未覆盖英文界面。</p><p><a href="#top">返回结论</a>。</p></body></html>';
const longHtml='<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>长报：静态报告阅读排版实测</title><style>pre{border-radius:0}</style></head><body><main><h1>长报：静态报告阅读排版实测</h1><p><strong>结论</strong>：新发布的静态报告由宿主注入自包含基础阅读样式；旧对象仅在显示层补样式，不改冻结字节。本页为无主题语义 HTML 长样例，本表数值与本报告实测截图同源。</p><section id="zhengju"><h2>证据</h2><table><caption>正文对比度实测（浅色 / 深色）</caption><thead><tr><th scope="col">元素</th><th scope="col">浅色</th><th scope="col">深色</th></tr></thead><tbody><tr><td>正文段落</td><td>14.7:1</td><td>13.8:1</td></tr><tr><td>图注</td><td>6.9:1</td><td>8.3:1</td></tr><tr><td>链接</td><td>6.0:1</td><td>8.9:1</td></tr></tbody></table></section><section><h2>关键代码</h2><p>显示层注入只改写服务字节，冻结对象保持原摘要：</p><pre><code>export function withReportReaderStyle(html) {\n  if (html.includes(\'&lt;style id="nozeli-reader-style"&gt;\')) return html; // frozen bytes unchanged\n  return injected + html;\n}</code></pre></section><section><h2>图表</h2><figure><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" width="320" height="120" role="img" lang="zh"><title>发布链路</title><desc>准备、校验、冻结三段流程</desc><g font-family="sans-serif" font-size="13" text-anchor="middle"><rect x="6" y="42" width="64" height="36" rx="6" fill="#f5c26b" stroke="#8a5a00"/><text x="38" y="64" fill="#4a3000">准备</text><path d="M72 60 L96 60" stroke="#8a5a00" stroke-width="2"/><rect x="100" y="42" width="64" height="36" rx="6" fill="#b9e0a5" stroke="#2f6b1f"/><text x="132" y="64" fill="#1e440f">校验</text><path d="M166 60 L190 60" stroke="#2f6b1f" stroke-width="2"/><rect x="194" y="42" width="64" height="36" rx="6" fill="#a8d5f2" stroke="#1f5a8a"/><text x="226" y="64" fill="#0f3a5f">冻结</text></g></svg><figcaption>作者图表配色与几何保持原样；宿主不全局覆盖 SVG。</figcaption></figure></section><section><h2>补充细节</h2><details><summary>验收口径</summary><p>正文与图注对比度不低于 4.5:1；390px 窄宽不产生页面级横向溢出；details 可键盘操作。</p></details><p><a href="#zhengju">回到证据表</a></p></section></main></body></html>';
const receipt=await publish('html-smoke-report',legacyHtml);
const shortReceipt=await publish('html-short-report',shortHtml);
const longReceipt=await publish('html-long-report',longHtml);
// The first object becomes a genuine pre-baseline report: strip the baked
// host nodes and keep state digests consistent, so the whole run below serves
// real old bytes through the real offline source and protocol paths.
const styleOpen='<style id="'+REPORT_READER_STYLE_ID+'">',publishedText=(await store.readObject(receipt.report.digest)).toString('utf8'),styleAt=publishedText.indexOf(styleOpen);
assert(styleAt>0,'legacy publication bakes the host baseline before conversion');
const styleEnd=publishedText.indexOf('</style>',styleAt);
const legacyBytes=Buffer.from(publishedText.slice(0,styleAt)+publishedText.slice(styleEnd+8).split(REPORT_VIEWPORT_META).join(''));
await store.putObject(legacyBytes);
const legacyRow=store.state.receipts.find(entry=>entry.objectId===receipt.objectId);
legacyRow.report.digest=createHash('sha256').update(legacyBytes).digest('hex');legacyRow.report.byteLength=legacyBytes.length;legacyRow.snapshot.reportDigest=legacyRow.report.digest;
receipt.report=legacyRow.report;
await store.save();await store.close();
const original=legacyBytes;
const shortOriginal=await store.readObject(shortReceipt.report.digest),longOriginal=await store.readObject(longReceipt.report.digest);
assert(shortOriginal.includes(styleOpen)&&longOriginal.includes(styleOpen),'new publications embed the host baseline for self-contained export');
assert(!legacyBytes.includes(styleOpen),'converted legacy bytes are genuinely pre-baseline');
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));let child,browser,page,rootPage,exited,log='';
const report={ok:false,output,checks:[]};
const call=(op,payload={})=>page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
async function isolatedPage(marker,exclude){if(exclude){const end=Date.now()+15000;for(;;){const pages=await browser.pages();const found=[];for(const p of pages){if(/^http:\/\/127\.0\.0\.1:/.test(p.url()))continue;try{if(p!==exclude&&await p.evaluate(marker=>document.body?.textContent.includes(marker),marker))found.push(p);}catch{}}if(found.length)return found[found.length-1];if(Date.now()>end)throw Error('no isolated page for marker: '+marker);await new Promise(r=>setTimeout(r,300));}}const target=await browser.waitForTarget(async target=>{if(target.type()!=='page'||/^http:\/\/127\.0\.0\.1:/.test(target.url()))return false;try{return await(await target.page()).evaluate(marker=>document.body?.textContent.includes(marker),marker);}catch{return false;}},{timeout:20000});return target.page();}
async function assertNoSetupCover(){for(const candidate of new Set([page,rootPage]))if(candidate)await candidate.waitForFunction(()=>!document.querySelector('#configuration-setup[open]'),{timeout:5000});}
async function open(name){await assertNoSetupCover();await rootPage.click('#file-tree button[data-path="'+name+'"]');const end=Date.now()+30000;for(;;){for(const candidate of await browser.pages()){try{if(await candidate.evaluate(name=>window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath===name&&window.__nozeliInput&&document.querySelector('#file-path')?.textContent===name,name)){page=candidate;await page.waitForFunction(()=>window.__nozeliReady);await assertNoSetupCover();return;}}catch{}}if(Date.now()>end)throw Error('document surface did not open: '+name);await tick(200);}}
const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(?:NOZELI|CCB|API_KEY|AUTH|TOKEN|SECRET|PASSWORD|OPENAI|ANTHROPIC)/i.test(key)));
try{
  child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform=wayland'],{cwd:root,env:{...cleanEnv,WAYLAND_DISPLAY:process.env.WAYLAND_DISPLAY||'wayland-0',NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:output,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:output},stdio:['ignore','pipe','pipe']});
  exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of[child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
  for(let n=0;n<120;n++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null,protocolTimeout:60000});break;}catch{await tick(100);}}
  assert(browser,log);rootPage=await waitForDesktopPage(browser);page=rootPage;await prepareReading(rootPage);
  await open('index.html');await page.waitForSelector('#web-preview-toggle:not([hidden])');
  const editorBefore=await page.evaluate(()=>({text:__nozeliInput.text(),selection:__nozeliInput.selection?.()}));
  await page.click('#web-preview-toggle');let preview=await isolatedPage('Real source preview');
  await preview.waitForFunction(()=>document.querySelector('#classic').textContent==='CLASSIC_DISK'&&document.querySelector('#module').textContent==='MODULE_DISK'&&document.querySelector('#json').textContent==='JSON_DISK');
  assert.equal(await preview.evaluate(()=>typeof window.nozeli),'undefined');assert.equal(await preview.evaluate(()=>typeof process),'undefined');assert.equal(await preview.evaluate(()=>typeof require),'undefined');
  assert.equal(await preview.$eval('body',node=>getComputedStyle(node).color),'rgb(20, 50, 80)');
  assert.equal(await page.evaluate(()=>__nozeliInput.text()),editorBefore.text);report.checks.push('Actual HTML/CSS/classic JS/ES modules/JSON fetch; no App bridge or Node');
  for(const scheme of ['light','dark']){await preview.emulateMediaFeatures([{name:'prefers-color-scheme',value:scheme}]);await preview.screenshot({path:path.join(output,'source-'+scheme+'.png')});}
  await preview.focus('#keyboard');await preview.keyboard.press('Tab');assert.equal(await page.evaluate(()=>__nozeliInput.text()),editorBefore.text);
  await call('session.resize',{width:760,height:900});await page.waitForFunction(()=>document.querySelector('#web-preview-pane').getBoundingClientRect().width>0);await page.screenshot({path:path.join(output,'source-narrow.png')});
  await call('session.resize',{width:1440,height:1000});report.checks.push('Source mode light/dark/narrow actual surfaces and keyboard focus leave editor bytes intact');
  await preview.emulateMediaType('print');const previewKey=await page.$eval('#web-preview-pane .isolated-viewport',n=>n.dataset.previewKey);const previewSnapshot=await call('isolated-preview.snapshot',{key:previewKey});assert.equal(previewSnapshot.ok,true,'preview snapshot');const printed=await call('isolated-preview.print',{key:previewKey,generation:previewSnapshot.value.generation,silent:true});if(printed.ok)report.printCapable=true;else{assert.match(printed.error?.message||'',/Failed to enumerate printers|default printer/i,'host print must fail only on missing system printers');report.printCapable=false;report.printEnvironmentLimit='No CUPS default printer on this host; print media + layout still verified';}await preview.emulateMediaType('screen');await page.screenshot({path:path.join(output,'source-print-mode.png')});
  const entryPage=page;
  for(const [name,replacement]of Object.entries({'style.css':'body { color: rgb(90, 30, 70); }','classic.js':'document.querySelector("#classic").textContent="CLASSIC_BUFFER";','dependency.js':'export const value="MODULE_BUFFER";','data.json':'{"value":"JSON_BUFFER"}'})){
    await open(name);await page.evaluate(replacement=>window.__nozeliInput.replace(replacement),replacement);
  }
  await open('index.html');await page.waitForSelector('#web-preview-toggle:not([hidden])');
  await page.click('#web-preview-toggle');
  await page.waitForSelector('#web-preview-refresh',{timeout:8000});
  preview=await isolatedPage('Real source preview',preview);
  await preview.waitForFunction(()=>document.querySelector('#classic').textContent==='CLASSIC_BUFFER'&&document.querySelector('#module').textContent==='MODULE_BUFFER'&&document.querySelector('#json').textContent==='JSON_BUFFER');
  assert.equal(await preview.$eval('body',node=>getComputedStyle(node).color),'rgb(90, 30, 70)');report.checks.push('Snapshot synchronizes actual CSS/classic JS/module/JSON editor owners before capture');
  const escape=await preview.evaluate(async()=>{const blocked=async url=>{try{await fetch(url);return false;}catch{return true;}};return {network:await blocked('https://example.invalid/nozeli-smoke'),loopback:await blocked('http://127.0.0.1:9/'),file:await blocked('file:///etc/passwd'),app:await blocked('http://127.0.0.1:'+location.port+'/'),worker:(()=>{try{new Worker('./classic.js');return false;}catch{return true;}})()};});
  assert.deepEqual(escape,{network:true,loopback:true,file:true,app:true,worker:true});report.checks.push('Actual isolated development renderer cannot fetch network/loopback/files/App or create workers');
  const stun=dgram.createSocket('udp4'),stunPackets=[];stun.on('message',bytes=>stunPackets.push(bytes.length));await new Promise(resolve=>stun.bind(0,'127.0.0.1',resolve));
  let realms;
  try{realms=await preview.evaluate(async stunPort=>{
    const initial=document.createElement('iframe');document.body.append(initial);
    // Access the fresh initial-about:blank realm synchronously, before any await.
    const found=[],reasons={},peers=[];
    for(const [name,read]of [['direct',()=>initial.contentWindow.RTCPeerConnection],['function',()=>initial.contentWindow.Function('return RTCPeerConnection')()],['constructor',()=>initial.contentWindow.Object.constructor('return RTCPeerConnection')()]]){
      try{const RTC=read();reasons[name]=typeof RTC;if(typeof RTC==='function'){found.push(name);const pc=new RTC({iceServers:[{urls:'stun:127.0.0.1:'+stunPort}]});pc.createDataChannel('actual-escape-probe');peers.push(pc);}}catch(error){reasons[name]=error.name+': '+error.message;}
    }
    const blocked={};for(const name of ['Worker','SharedWorker','WebSocket','WebTransport','RTCPeerConnection','webkitRTCPeerConnection'])blocked[name]=typeof globalThis[name];blocked.serviceWorker=typeof navigator.serviceWorker;
    const original=globalThis.RTCPeerConnection;let redefinitionRejected=false;try{Object.defineProperty(globalThis,'RTCPeerConnection',{value:function UntrustedRTC(){},configurable:true});}catch{redefinitionRejected=true;}redefinitionRejected&&=globalThis.RTCPeerConnection===original;
    const offers=[];for(const pc of peers){try{await pc.setLocalDescription(await pc.createOffer());offers.push('local-description-set');}catch(error){offers.push(error.name+': '+error.message);}}
    if(peers.length)await new Promise(resolve=>setTimeout(resolve,600));for(const pc of peers)pc.close();
    const frame=document.createElement('iframe');frame.srcdoc='<script>parent.__escaped=true<\/script>';document.body.append(frame);await new Promise(resolve=>setTimeout(resolve,80));
    const object=document.createElement('object');object.data='https://example.invalid/escape';document.body.append(object);const embed=document.createElement('embed');embed.src='https://example.invalid/escape';document.body.append(embed);
    return {found,reasons,offers,blocked,redefinitionRejected,srcdocEscaped:window.__escaped===true,popup:(()=>{try{return window.open('https://example.invalid/escape')!==null;}catch{return false;}})()};
  },stun.address().port);}finally{stun.close();}
  report.realmProbe={...realms,stunPackets};
  assert.deepEqual(realms.found,[],'Synchronous initial-about:blank realm exposes no recoverable WebRTC constructor');
  assert(realms.redefinitionRejected,'Top-level denied WebRTC constructor must be immutable');
  for(const [name,value]of Object.entries(realms.blocked))assert.equal(value,'undefined',name+' capability denied');
  assert.equal(realms.srcdocEscaped,false);assert.equal(realms.popup,false,'window.open must be deleted or throw: no window handle returned');assert.deepEqual(stunPackets,[],'No actual STUN escape reaches controlled listener');report.checks.push('Synchronous initial-about:blank direct/Function/constructor recovery, immutable top-level denial, denied worker/network capabilities and separate srcdoc probes');
  await page.evaluate(()=>{window.__previewEvents=[];window.__resourceError=new Promise(resolve=>{const unsubscribe=window.nozeli.subscribe('isolated-preview',event=>{window.__previewEvents.push(event);if(event.type==='resource-error'){clearTimeout(timer);unsubscribe();resolve(event);}});const timer=setTimeout(()=>{unsubscribe();resolve(null);},5000);});});
  const imageFailure=await preview.evaluate(()=>new Promise(resolve=>{const image=document.createElement('img');image.onload=()=>resolve({loaded:true,url:image.src});image.onerror=()=>resolve({loaded:false,url:image.src});image.src='missing-real-resource.png';document.body.append(image);}));
  const resourceEvent=await page.evaluate(()=>window.__resourceError);report.resourceProbe={imageFailure,events:await page.evaluate(()=>window.__previewEvents)};assert(resourceEvent,'host must emit resource-error for missing snapshot resource');
  await page.waitForFunction(()=>document.querySelector('#web-preview-pane .isolated-status').dataset.state==='error');report.checks.push('Real resource failure reaches trusted preview diagnostics');
  // Modify the real editor through its normal input adapter, not preview DOM.
  await page.evaluate(()=>{const n=__nozeliInput.text().length;__nozeliInput.select(n,n);__nozeliInput.focus();__nozeliInput.insert('<p>UNSAVED_BUFFER</p>');document.querySelector('#web-preview-refresh').click();});
  assert.equal(await readFile(path.join(project,'index.html'),'utf8'),sources['index.html'],'Buffer capture begins while source is genuinely unsaved');
  preview=await isolatedPage('UNSAVED_BUFFER');
  await page.waitForFunction(()=>document.querySelector('#web-preview-pane .isolated-status').textContent.includes('未保存'));
  assert.equal(await page.$eval('#web-preview-auto',node=>node.checked),false);report.checks.push('Explicit current-buffer refresh captures unsaved text without writing files; auto preview opt-in');
  await page.click('#web-preview-auto');await page.evaluate(()=>__nozeliInput.focus());await page.keyboard.type('<p>AUTO_BUFFER</p>');await isolatedPage('AUTO_BUFFER');
  await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');
  await page.waitForFunction(()=>!__nozeliInput.text().includes('AUTO_BUFFER'));report.checks.push('Real editor undo remains intact while isolated preview updates');
  await page.click('#web-preview-auto');await page.click('#web-preview-toggle');await rootPage.evaluate(()=>nozeli.invoke('session.resize',{width:1920,height:1000}));await page.waitForFunction(()=>innerWidth>=920);
  page=rootPage;
  const setTheme=async value=>{await rootPage.click('#open-settings');await rootPage.click('[data-settings-section="settings-appearance"]');await rootPage.select('[data-appearance="theme"]',value);await rootPage.click('#settings-close');await rootPage.waitForFunction(v=>document.documentElement.dataset.theme===v,{},value);};
  await setTheme('light');
  const openStatic=async(key,objectId,marker)=>{const opened=await call('isolated-preview.open',{key,profile:'staticReport',projectId,objectId,generation:1,bounds:{x:20,y:80,width:600,height:600}});assert.equal(opened.ok,true,JSON.stringify(opened));const found=await isolatedPage(marker);assert.equal(await found.evaluate(()=>typeof window.nozeli),'undefined');return found;};
  const fitWidth=async(key,handle,width)=>{const boundsResult=await call('isolated-preview.bounds',{key,bounds:{x:20,y:80,width,height:600}});assert.equal(boundsResult.ok,true,JSON.stringify(boundsResult));const deadline=Date.now()+5000;let actual;do{actual=await handle.evaluate(()=>innerWidth);if(actual===width)break;await tick(100);}while(Date.now()<deadline);assert.equal(actual,width,'native static-report viewport width '+key+' '+width);};
  const shoot=async(handle,file)=>{for(let attempt=0;;attempt++){try{return await handle.screenshot({path:file,captureBeyondViewport:true});}catch(error){if(attempt>=1)throw error;await tick(1000);}}};
  const contrastOf=handle=>handle.evaluate(()=>{
    const lum=color=>{const m=String(color).match(/[\d.]+/g).map(Number);const c=m.slice(0,3).map(v=>{v/=255;return v<0.03928?v/12.92:((v+0.055)/1.055)**2.4;});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];};
    const effBg=node=>{for(let n=node;n;n=n.parentElement){const c=getComputedStyle(n).backgroundColor;if(c&&!/transparent/.test(c)&&!/rgba\(\s*0+,\s*0+,\s*0+,\s*0+\s*\)/.test(c))return c;}return 'rgb(255, 255, 255)';};
    const one=sel=>{const n=document.querySelector(sel);if(!n)return null;const a=lum(getComputedStyle(n).color),b=lum(effBg(n));return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);};
    // Chart glyphs are author SVG artwork; reading contrast applies to document text.
    return {body:one('p'),heading:one('h1'),caption:one('figcaption'),link:one('a')};
  });
  const noOverflow=async handle=>{const geo=await handle.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));assert(geo.scroll<=geo.client+1,'page-level horizontal overflow '+JSON.stringify(geo));};
  const darkBody='rgb(16, 21, 28)',lightBody='rgb(255, 255, 255)';
  const legacyPage=await openStatic('smoke-report',receipt.objectId,'Real frozen report');
  const shortPage=await openStatic('short-report',shortReceipt.objectId,'短报：登录提示文案已修订');
  const longPage=await openStatic('long-report',longReceipt.objectId,'长报：静态报告阅读排版实测');
  // Legacy bytes are pre-baseline: the display layer supplies the reader style.
  for(const handle of[legacyPage,shortPage,longPage])assert(await handle.$eval('#nozeli-reader-style',node=>node instanceof HTMLStyleElement),'host reader style present');
  assert(!(await store.readObject(receipt.report.digest)).includes(styleOpen),'legacy frozen bytes stay pre-baseline on disk');
  const visualReport=[];
  for(const[theme,background]of[['light',lightBody],['dark',darkBody]]){
    // Real settings change: nativeTheme.themeSource makes every renderer,
    // including the isolated static reports, resolve the app theme natively.
    await setTheme(theme);
    for(const handle of[legacyPage,shortPage,longPage])await handle.waitForFunction(color=>getComputedStyle(document.body).backgroundColor===color,{},background);
    for(const[key,handle]of[['smoke-report',legacyPage],['short-report',shortPage],['long-report',longPage]]){
      for(const width of[900,390]){
        await fitWidth(key,handle,width);
        await handle.waitForFunction(color=>getComputedStyle(document.body).backgroundColor===color,{},background);
        const contrast=await contrastOf(handle);
        for(const[subject,value]of Object.entries(contrast))if(value!==null)assert(value>=4.5,theme+' '+key+' '+subject+' contrast '+value.toFixed(2));
        await noOverflow(handle);
        if(handle===legacyPage)assert(await handle.$eval('h1',node=>node.getBoundingClientRect().right)<=width);
        await shoot(handle,path.join(output,'report-'+key+'-'+theme+'-'+width+'.png'));
        visualReport.push({theme,key,width,contrast});
      }
    }
  }
  report.visual=visualReport;
  // Author intent wins the cascade: the long sample overrides the host radius.
  assert.equal(await longPage.$eval('pre',node=>getComputedStyle(node).borderBottomRightRadius),'0px','author style overrides host baseline');
  // Author SVG colors and geometry survive the host baseline untouched.
  const chart=await longPage.$eval('figure svg',node=>{const box=node.getBoundingClientRect();const view=node.getAttribute('viewBox').split(/\s+/).map(Number);return {rendered:box.width/box.height,intrinsic:view[2]/view[3],fill:getComputedStyle(node.querySelector('rect')).fill};});
  assert(Math.abs(chart.rendered-chart.intrinsic)<0.02,'SVG geometry preserved '+JSON.stringify(chart));
  assert.equal(chart.fill,'rgb(245, 194, 107)','author SVG fill preserved');
  // Keyboard: disclosure toggles and link focus receives a visible outline.
  await longPage.focus('summary');await longPage.keyboard.press('Enter');assert(await longPage.$eval('details',node=>node.open));
  for(let step=0;step<12&&await longPage.evaluate(()=>document.activeElement!==document.querySelector('a'));step++)await longPage.keyboard.press('Tab');
  assert(await longPage.evaluate(()=>{const node=document.activeElement;return node instanceof HTMLAnchorElement&&parseFloat(getComputedStyle(node).outlineWidth)>0;}),'keyboard focus outline visible on report link');
  report.checks.push('Real light/dark (app settings) + 390/900px screenshots, measured contrast >=4.5, no horizontal overflow, keyboard focus/disclosure, cascade and author SVG preservation for legacy/short/long reports');
  await legacyPage.emulateMediaType('print');assert.equal(await legacyPage.$eval('body',node=>getComputedStyle(node).color),'rgb(0, 0, 0)');const staticPrint=await call('isolated-preview.print',{key:'smoke-report',silent:true});if(report.printCapable)assert.equal(staticPrint.ok,true,'host print of frozen report');else{assert.match(staticPrint.error?.message||'',/Failed to enumerate printers|default printer/i);report.printEnvironmentLimit='No CUPS default printer on this host; print media + layout still verified';}await legacyPage.emulateMediaType('screen');
  // Real export: the new-format object leaves the app self-contained.
  const exported=await rootPage.evaluate(({projectId,objectId})=>nozeli.invoke('report.export',{projectId,objectId,relPath:'长报导出.html'}),{projectId,objectId:longReceipt.objectId});
  assert.equal(exported.ok,true,JSON.stringify(exported));
  const exportedBytes=await readFile(path.join(project,'长报导出.html'));
  assert.deepEqual(exportedBytes,longOriginal);assert(exportedBytes.includes(styleOpen),'exported report is the self-contained object');
  assert.deepEqual(await store.readObject(receipt.report.digest),original);assert.deepEqual(await store.readObject(shortReceipt.report.digest),shortOriginal);assert.deepEqual(await store.readObject(longReceipt.report.digest),longOriginal);
  report.checks.push('Print media behavior (host print bounded by system printers); real export equals frozen self-contained bytes');
  for(const [index,attack]of ['<script>document.title="attack"</script>','<img src="https://example.invalid/attack">','<iframe src="file:///etc/passwd"></iframe>','<p onclick="alert(1)">attack</p>'].entries()){const attempt=await Workspace.open(path.join(output,'attack-runtime-'+index),project,{storage:host.storage,projectId});try{const rejected=await attempt.submit('attack-'+index,'Real invalid publication');await attempt.activate(rejected.id);await assert.rejects(()=>attempt.publish(rejected.id,1,'result','<!doctype html><html><body>'+attack+'</body></html>','attack-'+index,{files:[]}));}finally{await attempt.close();}}
  assert.deepEqual(await store.readObject(receipt.report.digest),original);report.checks.push('Real publication rejects HTML script/network/file/event attacks and preserves frozen bytes');
  report.step='closing-static-slots';
  for(const key of['smoke-report','short-report','long-report'])await call('isolated-preview.close',{key});
  report.step='opening-agent-details';
  await rootPage.evaluate(()=>window.dispatchEvent(new Event('nozeli-agent-details')));await rootPage.waitForSelector('#managed-agent-details[open]');
  report.step='opening-work-archive';
  await rootPage.$eval('#managed-work-archive',n=>n.open=true);
  const historyButton='[data-managed-history-object="'+receipt.objectId+'"]';
  await rootPage.waitForSelector(historyButton);
  for(let attempt=0;;attempt++){try{await rootPage.click(historyButton);break;}catch(error){if(attempt>=3)throw error;await tick(500);}}
  report.step='waiting-history-surface';
  let readerPage;const historyDeadline=Date.now()+30000;while(!readerPage&&Date.now()<historyDeadline){for(const candidate of await browser.pages()){if(!candidate.url().startsWith('http://127.0.0.1:'))continue;const match=await candidate.evaluate(async id=>{if(!window.__nozeliReady)return false;const r=await nozeli.invoke('workspace.bootstrap');return r.ok&&r.value.kind==='history'&&r.value.viewState?.report?.objectId===id;},receipt.objectId).catch(()=>false);if(match){readerPage=candidate;break;}}if(!readerPage)await tick(100);}assert(readerPage,'actual HTML history surface ready');
  await readerPage.waitForSelector('.isolated-viewport');const actualReport=await isolatedPage('Real frozen report');await actualReport.waitForSelector('h1');assert.equal(await actualReport.$eval('h1',n=>n.textContent),'Real frozen report');assert.equal(await readerPage.$eval('#compose-form',n=>n.inert),true);assert.equal(await actualReport.evaluate(()=>typeof window.nozeli),'undefined');await shoot(actualReport,path.join(output,'report-from-history.png'));assert.deepEqual(await store.readObject(receipt.report.digest),original);report.checks.push('Real persisted HTML report opens from actual history entry in isolated read-only surface, with original bytes intact');
  // The details dialog overlays the shell; close it before driving settings.
  await rootPage.$eval('#managed-agent-details',node=>node.close());
  // The history surface is the real UI surface: its observer must follow the
  // app theme live without reopening or rebuilding the frozen report.
  await setTheme('light');
  report.historyTheme={readerTheme:await readerPage.evaluate(()=>document.documentElement.dataset.theme).catch(error=>String(error)),reportBg:await actualReport.evaluate(()=>getComputedStyle(document.body).backgroundColor).catch(error=>String(error)),status:await readerPage.$eval('.isolated-status',node=>node.textContent).catch(()=>null)};
  await actualReport.waitForFunction(color=>getComputedStyle(document.body).backgroundColor===color,{},lightBody);
  await shoot(actualReport,path.join(output,'report-from-history-light.png'));
  await setTheme('dark');
  await actualReport.waitForFunction(color=>getComputedStyle(document.body).backgroundColor===color,{},darkBody);
  assert.equal(await actualReport.$eval('h1',n=>n.textContent),'Real frozen report');
  report.checks.push('Real UI surface follows live app theme switches on the frozen report without reopening');
  await rootPage.evaluate(()=>nozeli.invoke('session.requestClose'));assert.equal((await Promise.race([exited,tick(15000).then(()=>({code:'timeout'}))])).code,0);report.ok=true;
}catch(error){report.error=String(error.stack);report.pages=browser?await Promise.all((await browser.pages()).map(async p=>({url:p.url(),state:await p.evaluate(async()=>({scope:(await window.nozeli?.invoke('workspace.bootstrap'))?.value,text:document.body?.innerText.slice(-2500)})).catch(e=>({error:e.message}))}))):[];process.exitCode=1;}finally{
  if(child&&child.exitCode===null&&browser){try{const closer=rootPage||page;const response=await closer.evaluate(()=>nozeli.invoke('session.requestClose'));report.cleanupClose=response;const closed=await Promise.race([exited,tick(15000).then(()=>null)]);if(!closed)report.preservedProcess={pid:child.pid,reason:'Normal close did not complete; retained for diagnosis'};}catch(error){report.preservedProcess={pid:child.pid,reason:String(error)};}}
  if(browser)await browser.disconnect();
  if(child&&child.exitCode===null){report.preservedProcess??={pid:child.pid,reason:'Retained for diagnosis; no force termination'};child.stdout.unref?.();child.stderr.unref?.();child.unref();}
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await writeFile(path.join(output,'electron.log'),log);console.log(JSON.stringify(report,null,2));
}
