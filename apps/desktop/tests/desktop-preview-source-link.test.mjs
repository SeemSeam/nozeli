import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import {clickPreviewControl, openPreviewMenu} from './preview-menu-support.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import { DesktopHost } from '../src/main/host.mjs';

const root=path.resolve(import.meta.dirname,'..');await mkdir(path.join(root,'.test-output'),{recursive:true});
const output=await mkdtemp(path.join(root,'.test-output/preview-source-link-')),profile=path.join(output,'profile'),project=path.join(output,'中文 source project');
await mkdir(path.join(project,'章节'),{recursive:true});
const markdown=Array.from({length:48},(_,i)=>`## 第${i+1}节\n\n段落${i+1}，按源位置联动，重复内容不会用全文百分比来定位。\n\n`+(i<14?'$$\\begin{aligned}a_1&=1\\\\a_2&=2\\\\a_3&=3\\\\a_4&=4\\\\a_5&=5\\\\a_6&=6\\end{aligned}$$\n\n':i%3===0?'| 项目 | 状态 |\n| --- | --- |\n| 测试 | 正常 |\n\n':i%3===1?'```cpp\nint example() {\n  return 42;\n}\n```\n\n':'' )).join('');
const main='\\documentclass{article}\n\\begin{document}\n'+Array.from({length:36},(_,i)=>`MainOne paragraph ${i+1}.\\par\n`).join('')+'\\newpage\n\\input{章节/内容}\n\\newpage\n'+Array.from({length:36},(_,i)=>`MainThree paragraph ${i+1}.\\par\n`).join('')+'\\end{document}\n';
const included=Array.from({length:36},(_,i)=>`ChildTwo paragraph ${i+1}.\\par\n`).join('');
const sources={'阅读.md':markdown,'other.md':'# Other file\n\nOnly this file.\n','main.tex':main,'章节/内容.tex':included};
for(const [name,text] of Object.entries(sources))await writeFile(path.join(project,name),text);
const host=new DesktopHost(profile),id=(await host.pick(project)).project.id;
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,exited,browser,page,log='';const report={ok:false,output,checks:[],errors:[]};
const mark=value=>{report.checks.push(value);console.log('PASS '+value);};
const call=(op,payload={})=>page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
async function launch(){
 child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform=wayland'],{cwd:root,env:{...process.env,WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000',NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:output,NOZELI_AGENT_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});
 exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{}await tick(100);}assert(browser,log);
 page=await waitForDesktopPage(browser);page.on('pageerror',error=>report.errors.push(String(error.stack)));await page.waitForFunction(()=>window.__nozeliReady);
 await prepareReading(page);await tick(200);
}
async function close(){await call('session.requestClose');const result=await Promise.race([exited,tick(15000).then(()=>({code:'timeout'}))]);assert.equal(result.code,0);await browser.disconnect();browser=null;}
async function resize(width,height){const result=await call('session.resize',{width,height});assert(result.ok,JSON.stringify(result));await page.waitForFunction(n=>innerWidth===n,{},width);await tick(150);}
async function open(name){
 if(await page.$eval('#app',el=>el.classList.contains('narrow-layout')&&!el.classList.contains('drawer-files-open')))await page.click('#file-toggle');
 await page.click('#file-tree button[data-path="'+name+'"]');await page.waitForFunction(name=>document.querySelector('#file-path').textContent===name&&document.querySelector('#save-status').dataset.state==='saved',{},name);await tick(250);
}
async function wheel(selector,delta){const box=await page.$eval(selector,el=>{const b=el.getBoundingClientRect();return{x:b.left+b.width*.6,y:b.top+b.height*.4};});await page.mouse.move(box.x,box.y);await page.mouse.wheel({deltaY:delta});await tick(350);}
async function dragScrollbar(selector,delta){const point=await page.$eval(selector,el=>{const b=el.getBoundingClientRect(),thumb=Math.max(24,el.clientHeight/el.scrollHeight*b.height);return{x:b.left+(b.width+el.clientWidth)/2,y:b.top+(b.height-thumb)*el.scrollTop/(el.scrollHeight-el.clientHeight)+thumb/2};});await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x,point.y+delta,{steps:15});await page.mouse.up();await tick(400);}
const sourceTop=()=>page.$eval('#text-host .cm-scroller',el=>el.scrollTop);
const previewTop=()=>page.$eval('#markdown-preview-scroll',el=>el.scrollTop);
const texPage=()=>page.$eval('#secondary-page',el=>Number(el.textContent.split('/')[0]));
async function nativeNavigate(offset){await page.evaluate(offset=>{__nozeliInput.select(offset,offset);__nozeliInput.focus();},offset);await page.keyboard.press('ArrowRight');await tick(500);}
async function undoTo(original){for(let i=0;i<5;i++){if(await page.evaluate(()=>__nozeliInput.text())===original)return;await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await tick(50);}assert.equal(await page.evaluate(()=>__nozeliInput.text()),original);}
try{
 await launch();await resize(1440,950);await open('阅读.md');await page.click('#text-mode-toggle');await page.waitForSelector('#markdown-divider:not([hidden])');await tick(350);
 assert.equal(await page.$eval('#markdown-sync',el=>el.getAttribute('aria-pressed')),'true');
 assert(await page.$eval('#document-view-commands',el=>el.hidden&&el.getClientRects().length===0));
 await openPreviewMenu(page,'markdown-sync','source');
 assert.equal(await page.$eval('.nozeli-submenu [data-command="preview-link"]',el=>el.getAttribute('aria-checked')),'true');
 await page.screenshot({path:path.join(output,'00-markdown-context-menu.png')});await page.keyboard.press('Escape');
 await wheel('#text-host .cm-scroller',900);assert(await previewTop()>500);
 const selection=await page.evaluate(()=>__nozeliInput.selection());await wheel('#markdown-preview-scroll',850);assert(await sourceTop()>900);assert.deepEqual(await page.evaluate(()=>__nozeliInput.selection()),selection);mark('default linked Markdown follows real wheels in both directions without moving the source selection');
 const headingOffset=markdown.indexOf('## 第25节');await nativeNavigate(headingOffset);
 const landmark=await page.evaluate(()=>{const heading=[...document.querySelectorAll('#text-preview h2')].find(n=>n.textContent.trim()==='第25节'),view=document.querySelector('#markdown-preview-scroll'),source=document.querySelector('#text-host .cm-scroller'),h=heading.getBoundingClientRect(),v=view.getBoundingClientRect();return{visible:h.bottom>v.top&&h.top<v.bottom,sourceRatio:source.scrollTop/(source.scrollHeight-source.clientHeight),previewRatio:view.scrollTop/(view.scrollHeight-view.clientHeight)};});
 assert(landmark.visible,JSON.stringify(landmark));assert(Math.abs(landmark.sourceRatio-landmark.previewRatio)>.04,JSON.stringify(landmark));report.landmark=landmark;mark('unequal-height display math maps the exact later heading rather than a full-document percentage');
 await page.screenshot({path:path.join(output,'01-markdown-linked.png')});
 const dragSelection=await page.evaluate(()=>__nozeliInput.selection()),dragStart={a:await sourceTop(),b:await previewTop()};await dragScrollbar('#text-host .cm-scroller',70);assert(await sourceTop()>dragStart.a+50);assert(await previewTop()>dragStart.b+50);
 const reverseStart={a:await sourceTop(),b:await previewTop()};await dragScrollbar('#markdown-preview-scroll',-65);assert(await previewTop()<reverseStart.b-50);assert(await sourceTop()<reverseStart.a-50);assert.deepEqual(await page.evaluate(()=>__nozeliInput.selection()),dragSelection);mark('physical source and preview scrollbar dragging follows both ways without the old cursor pulling the view back');
 for(const [selector,delta]of [['#text-host .cm-scroller',300],['#markdown-preview-scroll',220],['#markdown-preview-scroll',-120],['#text-host .cm-scroller',150]]){const b=await page.$eval(selector,el=>{const r=el.getBoundingClientRect();return{x:r.left+r.width*.6,y:r.top+r.height*.4};});await page.mouse.move(b.x,b.y);await page.mouse.wheel({deltaY:delta});}
 await tick(600);const fast={a:await sourceTop(),b:await previewTop()};await tick(600);assert(Math.abs(await sourceTop()-fast.a)<3&&Math.abs(await previewTop()-fast.b)<3);mark('fast alternating real wheel gestures settle at the latest position without oscillation');
 const before=await sourceTop();await clickPreviewControl(page, 'markdown-sync');await wheel('#markdown-preview-scroll',700);assert(Math.abs(await sourceTop()-before)<3);await clickPreviewControl(page, 'markdown-sync');await tick(350);
 const stable=await page.evaluate(()=>({a:document.querySelector('#text-host .cm-scroller').scrollTop,b:document.querySelector('#markdown-preview-scroll').scrollTop}));await tick(800);const after=await page.evaluate(()=>({a:document.querySelector('#text-host .cm-scroller').scrollTop,b:document.querySelector('#markdown-preview-scroll').scrollTop}));assert(Math.abs(stable.a-after.a)<3&&Math.abs(stable.b-after.b)<3);mark('link toggle permits independent reading and rejoining settles without a scroll feedback loop');
 const divider=await page.$eval('#markdown-divider',el=>{const b=el.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2};});await page.mouse.move(divider.x,divider.y);await page.mouse.down();await page.mouse.move(divider.x-90,divider.y,{steps:12});await page.mouse.up();await tick(400);assert(await page.$eval('#markdown-divider',el=>Number(el.getAttribute('aria-valuenow'))<50));
 await wheel('#markdown-preview-scroll',-500);assert(await sourceTop()<after.a);mark('dragging the divider recalculates actual wrapping before reverse scrolling');
 await nativeNavigate(markdown.indexOf('段落25'));await page.keyboard.type('LIVE_LINK_');await page.waitForFunction(()=>document.querySelector('#text-preview').textContent.includes('LIVE_LINK_'));await undoTo(markdown);await page.waitForFunction(()=>!document.querySelector('#text-preview').textContent.includes('LIVE_LINK_'));await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
 await resize(700,900);await wheel('#markdown-preview-scroll',250);const overflow=await page.$eval('#reader-scroll',el=>el.scrollWidth-el.clientWidth);assert(overflow<=1);report.narrow=await page.evaluate(()=>({width:innerWidth,height:innerHeight,sourceWidth:document.querySelector('#text-host').clientWidth,previewWidth:document.querySelector('#markdown-preview-scroll').clientWidth}));await page.screenshot({path:path.join(output,'02-narrow-linked.png')});await resize(1440,950);await tick(150);mark('live native typing/undo and narrow layout keep both views valid with no horizontal pane overflow');
 await clickPreviewControl(page, 'markdown-sync');
 const inheritedSelection=await page.evaluate(()=>__nozeliInput.selection());
 await open('other.md');assert(await page.$eval('#markdown-sync',el=>el.hidden));
 const retainedView=(await page.evaluate(async projectId=>nozeli.invoke('state.read',{projectId}),id)).value.files['阅读.md'].fileView;
 assert.equal(retainedView.textMode,'split');assert.equal(retainedView.markdownPreview.linked,false);
 await open('阅读.md');await page.waitForSelector('#markdown-divider:not([hidden])');
 assert.deepEqual(await page.evaluate(()=>__nozeliInput.selection()),inheritedSelection);
 assert.equal(await page.$eval('#markdown-sync',el=>el.getAttribute('aria-pressed')),'false');await clickPreviewControl(page, 'markdown-sync');mark('Markdown split mode, selection and linking are per-file and restored after switching away');

 await open('main.tex');await page.waitForSelector('#tex-toolbar:not([hidden])');await page.waitForFunction(async id=>(await nozeli.invoke('tex.status',{projectId:id})).value.phase==='success',{timeout:45000},id);await page.waitForSelector('#secondary-pdf .textLayer');await tick(350);
 assert.equal(await texPage(),1);assert.equal(await page.$eval('#tex-sync',el=>el.getAttribute('aria-pressed')),'true');
 assert(await page.$eval('#tex-view-commands',el=>el.hidden&&el.getClientRects().length===0));
 await openPreviewMenu(page,'tex-sync','source');assert.equal(await page.$eval('.nozeli-submenu [data-command="preview-link"]',el=>el.getAttribute('aria-checked')),'true');
 await page.screenshot({path:path.join(output,'00-tex-context-menu.png')});await page.keyboard.press('Escape');
 await nativeNavigate(main.indexOf('MainThree paragraph 28'));await page.waitForFunction(()=>document.querySelector('#secondary-page').textContent.startsWith('3 /'),{timeout:10000});assert(await page.$eval('#secondary-pdf',el=>el.textContent.includes('MainThree')));mark('real XeLaTeX and native SyncTeX source scrolling opens the correct third PDF page');
 await page.screenshot({path:path.join(output,'03-tex-forward.png')});
 await page.click('#secondary-prev');await page.waitForFunction(()=>document.querySelector('#secondary-page').textContent.startsWith('2 /'));await page.waitForFunction(()=>document.querySelector('#tex-sync').dataset.state==='other-source');assert.equal(await page.$eval('#file-path',el=>el.textContent),'main.tex');
 const target=await page.evaluate(()=>{const node=[...document.querySelectorAll('#secondary-pdf .textLayer span')].find(n=>n.textContent.includes('ChildTwo paragraph 7'));const b=node.getBoundingClientRect();return{x:b.left+b.width*.35,y:b.top+b.height*.5};});
 await page.keyboard.down('Control');await page.mouse.click(target.x,target.y);await page.keyboard.up('Control');await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='章节/内容.tex');await page.waitForSelector('#secondary-pdf .textLayer');await tick(450);
 assert((await page.evaluate(()=>__nozeliInput.selection())).head>0);mark('PDF page in an included file keeps the current editor until real Ctrl-click explicitly navigates its exact source');
 await page.click('#secondary-next');await page.waitForFunction(()=>document.querySelector('#secondary-page').textContent.startsWith('3 /'));await tick(150);await open('main.tex');await page.waitForSelector('#secondary-pdf .textLayer');await tick(250);
 await page.click('#secondary-prev');await page.click('#secondary-prev');await page.waitForFunction(()=>document.querySelector('#secondary-page').textContent.startsWith('1 /'));await tick(350);
 const visible=await page.$eval('#text-host .view-lines',el=>el.textContent);assert(visible.includes('MainOne'));mark('PDF page buttons use inverse native line locations to scroll the current source into view');
 await page.click('#secondary-zoom-in');await page.click('#secondary-zoom-in');await tick(250);
 // Monaco recycles virtual line nodes; DOM child order is not visual line order.
 const firstVisible=()=>page.evaluate(()=>{const box=document.querySelector('#text-host').getBoundingClientRect();return [...document.querySelectorAll('#text-host .view-line')].map(n=>({text:n.textContent,top:n.getBoundingClientRect().top})).filter(n=>n.top>=box.top&&n.top<box.bottom).sort((a,b)=>a.top-b.top)[0]?.text;});
 const wheelGeometry=()=>page.evaluate(()=>({sourceContentTop:document.querySelector('#text-host .view-lines').getBoundingClientRect().top,pdf:document.querySelector('#secondary-scroll').scrollTop}));
 const inverseAtViewport=async()=>{const point=await page.evaluate(()=>{const wrap=document.querySelector('#secondary-pdf .pdf-page'),rect=wrap.getBoundingClientRect(),viewport=document.querySelector('#secondary-scroll'),box=viewport.getBoundingClientRect(),scale=Number.parseFloat(wrap.style.getPropertyValue('--total-scale-factor'));return{page:Number(document.querySelector('#secondary-page').textContent.split('/')[0]),x:rect.width*.3/scale,y:Math.max(0,Math.min(rect.height,box.top+viewport.clientHeight*.25-rect.top))/scale};});const synced=await call('tex.sync',{projectId:id,buildId:await page.$eval('#secondary-pdf',el=>el.dataset.buildId),relPath:'main.tex',text:main,direction:'inverse',...point});assert(synced.ok,JSON.stringify(synced));return{point,...synced.value};};
 const beforeWheel=await firstVisible(),beforeGeometry=await wheelGeometry(),beforeInverse=await inverseAtViewport();await wheel('#secondary-scroll',180);const afterWheel=await firstVisible(),afterGeometry=await wheelGeometry(),afterInverse=await inverseAtViewport();
 const stateAfterWheel=await page.$eval('#tex-sync',el=>el.dataset.state);report.texWheel={before:beforeWheel,after:afterWheel,beforeGeometry,afterGeometry,beforeInverse,afterInverse};assert.equal(stateAfterWheel,'ready');assert(afterGeometry.pdf>beforeGeometry.pdf,JSON.stringify(report.texWheel));assert.equal(afterInverse.relPath,'main.tex');assert(afterInverse.line>beforeInverse.line,JSON.stringify(report.texWheel));assert.notEqual(afterWheel,beforeWheel,JSON.stringify(report.texWheel));mark('PDF zoom and real page-local wheel reuse PDF coordinates and move the source lines');
 await clickPreviewControl(page, 'tex-auto');await page.waitForFunction(()=>!document.querySelector('#tex-auto').checked&&document.querySelector('#tex-status').textContent==='设置已保存');
 await nativeNavigate(main.length-1);await page.keyboard.type('\n% UI_STALE_LINK');await tick(250);const frozenPage=await texPage();await wheel('#text-host .monaco-scrollable-element',-500);assert.equal(await texPage(),frozenPage);assert.equal(await page.$eval('#tex-sync',el=>el.dataset.state),'paused');
 await undoTo(main);await page.click('#tex-build');await page.waitForFunction(async id=>(await nozeli.invoke('tex.status',{projectId:id})).value.phase==='success',{timeout:30000},id);await page.waitForFunction(()=>document.querySelector('#tex-sync').dataset.state==='ready',{timeout:10000});mark('stale source pauses navigation; native undo and a matching successful build restore linking');
 await clickPreviewControl(page, 'tex-sync');await open('阅读.md');await page.waitForSelector('#markdown-divider:not([hidden])');assert.equal(await page.$eval('#markdown-sync',el=>el.getAttribute('aria-pressed')),'true');await close();await launch();await page.waitForSelector('#markdown-divider:not([hidden])');assert.equal(await page.$eval('#markdown-sync',el=>el.getAttribute('aria-pressed')),'true');
 await open('main.tex');await page.waitForSelector('#secondary-pdf .textLayer');assert.equal(await page.$eval('#tex-sync',el=>el.getAttribute('aria-pressed')),'false');assert.equal(await page.$eval('#tex-auto',el=>el.checked),false);await clickPreviewControl(page, 'tex-sync');await tick(300);await page.screenshot({path:path.join(output,'04-restored-linking.png')});mark('full native app close/relaunch preserves Markdown per-file and TeX per-root link preferences');
 for(const [name,source]of Object.entries(sources))assert.equal(await readFile(path.join(project,name),'utf8'),source,name);
 assert.deepEqual(report.errors,[]);await close();mark('original sources stay byte-identical and native close exits normally without renderer errors');report.ok=true;
}catch(error){report.error=String(error.stack);await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(report.error);}
finally{if(browser){await call('session.requestClose').catch(()=>{});await Promise.race([exited,tick(5000)]);await browser.disconnect();}if(child?.exitCode===null)child.kill('SIGTERM');await writeFile(path.join(output,'main.log'),log);await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({ok:report.ok,output,checks:report.checks,error:report.error},null,2));process.exit(report.ok?0:1);
