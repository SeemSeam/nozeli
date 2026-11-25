import { contentToolForPage } from './native-content-tools.fixture.mjs';
import {prepareReading, waitForDesktopPage, waitForReadingDocument} from './reading-setup.fixture.mjs';
import {clickPreviewControl, openPreviewMenu} from './preview-menu-support.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';
import { DesktopHost } from '../src/main/host.mjs';

const root=path.resolve(import.meta.dirname,'..');
const texOnly=process.argv.includes('--tex-only'),markdownOnly=process.argv.includes('--markdown-only'),diagnosticOnly=process.argv.includes('--diagnostic-only'),styOnly=process.argv.includes('--sty-diagnostic');
const clsOnly=process.argv.includes('--cls-diagnostic');
const cancelOnly=process.argv.includes('--win-cancel');
const recoveryOnly=process.argv.includes('--syntax-recovery');
assert([texOnly,markdownOnly,diagnosticOnly,styOnly,clsOnly,cancelOnly,recoveryOnly].filter(Boolean).length<=1,'Choose at most one isolated preview scenario');
assert(!cancelOnly||process.platform==='win32','The native Job cancellation scenario requires Windows');
const output=await mkdtemp(path.join(os.tmpdir(),'nozeli-preview-source-link-')),profile=path.join(output,'profile'),project=path.join(output,'中文 source project');
console.log('Preview source link fixture:',output);
await mkdir(path.join(project,'章节'),{recursive:true});
const markdown=Array.from({length:48},(_,i)=>`## 第${i+1}节\n\n段落${i+1}，按源位置联动，重复内容不会用全文百分比来定位。\n\n`+(i<14?'$$\\begin{aligned}a_1&=1\\\\a_2&=2\\\\a_3&=3\\\\a_4&=4\\\\a_5&=5\\\\a_6&=6\\end{aligned}$$\n\n':i%3===0?'| 项目 | 状态 |\n| --- | --- |\n| 测试 | 正常 |\n\n':i%3===1?'```cpp\nint example() {\n  return 42;\n}\n```\n\n':'' )).join('');
const main='\\documentclass{article}\n\\begin{document}\n'+Array.from({length:36},(_,i)=>`MainOne paragraph ${i+1}.\\par\n`).join('')+'\\newpage\n\\input{章节/内容}\n\\newpage\n'+Array.from({length:36},(_,i)=>`MainThree paragraph ${i+1}.\\par\n`).join('')+'\\end{document}\n';
const diagnosticLine='\\NozeliSyntheticInvalidCommand';
const included=diagnosticOnly?`Marker before.\n${diagnosticLine}\nMarker after.\n`:Array.from({length:36},(_,i)=>`ChildTwo paragraph ${i+1}.\\par\n`).join('');
// Keep package and class errors in separate real compiles: halt-on-error stops at the first.
const extension=clsOnly?'cls':styOnly?'sty':null;
const probePath=extension?`nozeliprobe.${extension}`:null;
const probeLine='\\NozeliSyntheticPackageOrClassInvalid';
const probe=clsOnly?`\\ProvidesClass{nozeliprobe}\n${probeLine}\n\\LoadClass{article}\n`:styOnly?`\\ProvidesPackage{nozeliprobe}\n${probeLine}\n`:null;
const rootDeclaration=clsOnly?'\\documentclass{nozeliprobe}':styOnly?'\\documentclass{article}\n\\usepackage{nozeliprobe}':null;
const sources={'阅读.md':markdown,'other.md':'# Other file\n\nOnly this file.\n','main.tex':rootDeclaration?main.replace('\\documentclass{article}',rootDeclaration):main,'章节/内容.tex':included,...(probePath?{[probePath]:probe}:{})};
for(const [name,text] of Object.entries(sources))await writeFile(path.join(project,name),text);
await mkdir(profile);
const host=new DesktopHost(path.join(profile,'desktop')),id=(await host.pick(project)).project.id;
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,exited,browser,page,log='';const report={ok:false,output,checks:[],errors:[]};
const mark=value=>{report.checks.push(value);console.log('PASS '+value);};
const call=(op,payload={})=>page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
async function launch(){
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||key==='ELECTRON_RUN_AS_NODE')delete env[key];
 if(process.platform==='linux')Object.assign(env,{WAYLAND_DISPLAY:env.WAYLAND_DISPLAY||'wayland-0',XDG_RUNTIME_DIR:env.XDG_RUNTIME_DIR||'/run/user/1000'});
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:profile,NOZELI_USER_DATA:path.join(profile,'desktop'),NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:output,NOZELI_AGENT_FIXTURE:'1'});
 child=spawn(createRequire(import.meta.url)('electron'),[...(process.platform==='linux'?['--ozone-platform=wayland']:[]),path.join(root,'src/main/main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{}await tick(100);}assert(browser,log);
 page=await waitForDesktopPage(browser);await prepareReading(page);shell=page;observe(shell);
 const recent=`#recent button[data-project-id="${id}"]`;
 await page.waitForSelector(recent,{visible:true});await page.click(recent);
 await page.waitForSelector(`${recent}[aria-current="true"]`);
}
let shell;
const observed=new WeakSet();
function observe(target){if(!observed.has(target)){observed.add(target);target.on('pageerror',error=>report.errors.push(String(error.stack)));}}
async function close(){await shell.evaluate(()=>nozeli.invoke('session.requestClose'));const result=await Promise.race([exited,tick(15000).then(()=>({code:'timeout'}))]);assert.equal(result.code,0);await browser.disconnect();browser=null;}
async function resize(width,height){const result=await shell.evaluate(({width,height})=>nozeli.invoke('session.resize',{width,height}),{width,height});assert(result.ok,JSON.stringify(result));await shell.waitForFunction(n=>innerWidth===n,{},width);await tick(150);}
async function open(name){
 await shell.click('#file-tree button[data-path='+JSON.stringify(name)+']');
 page=await waitForReadingDocument(browser,id,name);observe(page);
 await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
}
async function wheel(selector,delta){const box=await page.$eval(selector,el=>{const b=el.getBoundingClientRect();return{x:b.left+b.width*.6,y:b.top+b.height*.4};});await page.mouse.move(box.x,box.y);await page.mouse.wheel({deltaY:delta});await tick(350);}
async function dragScrollbar(selector,delta){
 const geometry=await page.$eval(selector,el=>{
  const b=el.getBoundingClientRect(), {clientHeight,clientWidth,scrollHeight,scrollTop}=el;
  const thumb=Math.max(24,clientHeight/scrollHeight*b.height),x=b.left+(b.width+clientWidth)/2;
  const y=b.top+(b.height-thumb)*scrollTop/(scrollHeight-clientHeight)+thumb/2;
  const hit=document.elementFromPoint(x,y);
  // Chromium exposes the scroller, not the individual native scrollbar parts.
  return {rect:b.toJSON(),clientHeight,clientWidth,scrollHeight,scrollTop,thumb,x,y,hit:{tag:hit?.tagName,scroller:hit===el}};
 });
 const {x,y}=geometry, drag={selector,delta,geometry,before:{source:await sourceTop(),preview:await previewTop()}};
 (report.scrollbarDrags??=[]).push(drag);
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y+delta,{steps:15});await page.mouse.up();await tick(400);
 drag.after={source:await sourceTop(),preview:await previewTop()};
}
const sourceTop=()=>page.$eval('#text-host .cm-scroller',el=>el.scrollTop);
const previewTop=()=>page.$eval('#markdown-preview-scroll',el=>el.scrollTop);
const texPage=()=>page.$eval('#secondary-page',el=>Number(el.textContent.split('/')[0]));
const waitTexPage=expected=>page.waitForFunction(expected=>Number(document.querySelector('#secondary-page').textContent.split('/')[0])===expected&&document.querySelector('#secondary-pdf .textLayer'),{timeout:10000},expected);
async function nativeNavigate(offset){await page.evaluate(offset=>{__nozeliInput.select(offset,offset);__nozeliInput.focus();},offset);await page.keyboard.press('ArrowRight');await tick(500);}
async function undoTo(original){for(let i=0;i<5;i++){if(await page.evaluate(()=>__nozeliInput.text())===original)return;await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await tick(50);}assert.equal(await page.evaluate(()=>__nozeliInput.text()),original);}
async function verifyColdMarkdown() {
 await open('阅读.md');
 await page.waitForSelector('#markdown-divider:not([hidden])');
 assert.equal(await page.$eval('#markdown-sync',el=>el.getAttribute('aria-pressed')),'true');
 mark('cold relaunch preserves Markdown per-file linking');
}
async function verifyCrossFileDiagnostic(relPath='章节/内容.tex',wanted=diagnosticLine){
 await open('main.tex');await page.waitForSelector('#tex-build:enabled');await page.click('#tex-build');
 await page.waitForFunction(async projectId=>{const r=await nozeli.invoke('tex.status',{projectId});return r.ok&&['success','error','cancelled'].includes(r.value.phase);},{timeout:45000},id);
 const status=(await call('tex.status',{projectId:id})).value;
 report.diagnostic={phase:status.phase,code:status.code,diagnostics:status.diagnostics,log:status.log};
 assert.equal(status.code,'TEX_COMPILE',status.log||status.message);
 const clickDiagnostic=async()=>{
  const button=await page.waitForFunction(rel=>[...document.querySelectorAll('#tex-diagnostics button:enabled')].find(n=>n.textContent.startsWith(`${rel}:2 · `)),{timeout:5000},relPath);
  try{await button.asElement().click();}finally{await button.dispose();}
 };
 await clickDiagnostic();
 page=await waitForReadingDocument(browser,id,relPath);observe(page);
 await page.waitForFunction(want=>{const s=__nozeliInput.selection(),text=__nozeliInput.text();return s.from===text.indexOf(want)&&text.slice(s.from,s.to)===want;},{timeout:5000},wanted);
 mark(`TeX diagnostic opens ${relPath} and selects its exact frozen error line`);
 if(!diagnosticOnly)return;
 const original=sources[relPath], changed=`% shifted after compilation\n${original}`;
 await page.evaluate(text=>__nozeliInput.replace(text),changed);
 await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
 assert.equal(await readFile(path.join(project,relPath),'utf8'),changed);
 await page.evaluate(()=>__nozeliInput.select(0,0));
 const before=await page.evaluate(()=>__nozeliInput.selection());
 assert.equal(before.from,0);assert.equal(before.to,0);
 await open('main.tex');
 assert.equal((await call('tex.status',{projectId:id})).value.sequence,status.sequence);
 await clickDiagnostic();
 page=await waitForReadingDocument(browser,id,relPath);observe(page);
 await page.waitForFunction(()=>document.querySelector('#tex-status')?.textContent.includes('目标源码已变化'),{timeout:5000});
 const after=await page.evaluate(()=>__nozeliInput.selection());
 report.staleDiagnostic={before,after};assert.deepEqual(after,before);
 assert.equal(await page.evaluate(()=>__nozeliInput.text()),changed);
 await page.evaluate(text=>__nozeliInput.replace(text),original);
 await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
 mark('a stale cross-file diagnostic opens the changed file but leaves its selection undisturbed');
}
async function compilerCensus(){
 const script=`Get-CimInstance Win32_Process -Filter "Name='latexmk.exe' or Name='runscript.exe' or Name='perl.exe' or Name='xelatex.exe' or Name='cmd.exe'" | Select-Object Name,ProcessId,ParentProcessId,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`;
 const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000});
 const rows=stdout.trim()?JSON.parse(stdout):[];
 return Array.isArray(rows)?rows:[rows];
}
async function verifyGuiCancel(){
 await open('main.tex');await page.waitForSelector('#tex-build:enabled');await page.click('#tex-build');
 await page.waitForFunction(async id=>['success','error'].includes((await nozeli.invoke('tex.status',{projectId:id})).value?.phase),{timeout:45000},id);
 const baseline=(await call('tex.status',{projectId:id})).value;assert.equal(baseline.phase,'success',baseline.log);
 await page.waitForSelector('#secondary-pdf .textLayer');
 const loop=main.replace('\\end{document}','\\loop\\iftrue\\repeat\n\\end{document}');
 await page.evaluate(text=>__nozeliInput.replace(text),loop);
 await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
 assert.equal(await readFile(path.join(project,'main.tex'),'utf8'),loop);
 await page.click('#tex-build');
 const deadline=Date.now()+15000;let processes=[];
 do{
  const rows=await compilerCensus(), pids=new Set([child.pid]);let size;
  do{size=pids.size;for(const row of rows)if(pids.has(row.ParentProcessId))pids.add(row.ProcessId);}while(pids.size!==size);
  processes=rows.filter(row=>pids.has(row.ProcessId));
  if(processes.some(row=>row.Name.toLowerCase()==='xelatex.exe'))break;
  await tick(150);
 }while(Date.now()<deadline);
 report.cancel={processes};assert(processes.some(row=>row.Name.toLowerCase()==='xelatex.exe'),'real XeLaTeX descendant must be running before clicking Cancel');
 assert.equal((await call('tex.status',{projectId:id})).value.phase,'building');
 await page.waitForSelector('#tex-cancel:not([hidden])',{visible:true});await page.click('#tex-cancel');
 await page.waitForFunction(async id=>(await nozeli.invoke('tex.status',{projectId:id})).value?.phase==='cancelled',{timeout:15000},id);
 const status=(await call('tex.status',{projectId:id})).value;
 report.cancel.treeExitVerified=status.treeExitVerified;assert.equal(status.treeExitVerified,true);
 assert.equal(status.lastSuccess.buildId,baseline.lastSuccess.buildId);
 assert.equal(await page.$eval('#secondary-pdf',el=>el.dataset.buildId),baseline.lastSuccess.buildId);
 report.cancel.survivors=(await compilerCensus()).filter(row=>processes.some(before=>before.ProcessId===row.ProcessId&&before.Created===row.Created));
 assert.deepEqual(report.cancel.survivors,[]);
 assert.equal(await readFile(path.join(project,'main.tex'),'utf8'),loop);
 await page.evaluate(text=>__nozeliInput.replace(text),main);
 await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
 mark('clicking Cancel on a live XeLaTeX build receives native Job-empty proof and keeps the prior PDF');
}
async function verifySyntaxRecovery(){
 await open('main.tex');await page.waitForSelector('#tex-build:enabled');
 const status=async()=>{const result=await call('tex.status',{projectId:id});assert(result.ok,JSON.stringify(result));return result.value;};
 async function compile(expected){
  const {sequence}=await status();await page.click('#tex-build');
  await page.waitForFunction(async (id,sequence)=>{const state=(await nozeli.invoke('tex.status',{projectId:id})).value;return state?.sequence>sequence&&['success','error'].includes(state.phase);},{timeout:45000},id,sequence);
  const state=await status();assert.equal(state.phase,expected,state.log);return state;
 }
 async function replace(text){
  await page.evaluate(text=>__nozeliInput.replace(text),text);
  await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
  assert.equal(await readFile(path.join(project,'main.tex'),'utf8'),text);
 }
 async function preview(buildId,marker){
  await page.waitForSelector('#tex-build:enabled');
  if(await page.$eval('#tex-preview',el=>el.getAttribute('aria-pressed'))!=='true')await page.click('#tex-preview');
  await waitTexPage(1);
  await page.waitForFunction((id,marker)=>{const pdf=document.querySelector('#secondary-pdf');return pdf?.dataset.buildId===id&&pdf.textContent.includes(marker);},{timeout:20000},buildId,marker);
 }
 const first=(await compile('success')).lastSuccess.buildId;
 await preview(first,'MainOne');
 await replace(main.replace('\\end{document}',`${diagnosticLine}\n\\end{document}`));
 const failure=await compile('error');assert.equal(failure.lastSuccess.buildId,first);
 assert(failure.diagnostics.some(d=>d.relPath==='main.tex'&&d.message.includes('Undefined control sequence')));
 await preview(first,'MainOne');
 await replace(main.replaceAll('MainOne','RecoveredOne'));
 const restored=(await compile('success')).lastSuccess.buildId;assert.notEqual(restored,first);
 report.syntaxRecovery={first,restored};await preview(restored,'RecoveredOne');
 await replace(main);
 // Restore the original fixture bytes without rebuilding. Reload and cold
 // reopen must still read the frozen artifact, not compile current source.
 await page.reload();await page.waitForFunction(()=>window.__nozeliReady);
 await preview(restored,'RecoveredOne');assert.equal((await status()).lastSuccess.buildId,restored);
 await close();await launch();await open('main.tex');
 await preview(restored,'RecoveredOne');assert.equal((await status()).lastSuccess.buildId,restored);
 mark('syntax recovery publishes a new real PDF; reload and cold reopen read that exact frozen artifact');
}
try{
 report.scenario=recoveryOnly?'syntax-recovery':cancelOnly?'win-cancel':extension?`${extension}-diagnostic`:diagnosticOnly?'diagnostic-only':texOnly?'tex-only':markdownOnly?'markdown-only':'markdown-and-tex';
 await launch();await resize(1440,950);
 if(!texOnly&&!diagnosticOnly&&!probePath&&!cancelOnly&&!recoveryOnly){
 await open('阅读.md');await contentToolForPage(page, ['view', 'text-mode']);await page.waitForSelector('#markdown-divider:not([hidden])');await tick(350);
 assert.equal(await page.$eval('#markdown-sync',el=>el.getAttribute('aria-pressed')),'true');
 assert(await page.$eval('#document-view-commands',el=>el.hidden&&el.getClientRects().length===0));
 await openPreviewMenu(page,'markdown-sync','source');
 assert.equal(await page.$eval('.nozeli-submenu [data-command="preview-link"]',el=>el.getAttribute('aria-checked')),'true');
 await page.screenshot({path:path.join(output,'00-markdown-context-menu.png')});await page.keyboard.press('Escape');
 const markdownGeometry=()=>page.evaluate(()=>Object.fromEntries(['#text-host .cm-scroller','#markdown-preview-scroll'].map(selector=>{const el=document.querySelector(selector),b=el.getBoundingClientRect(),hit=document.elementFromPoint(b.left+b.width*.6,b.top+b.height*.4);return[selector,{top:el.scrollTop,height:el.clientHeight,extent:el.scrollHeight,hit:hit?.className,inside:el.contains(hit)}];})));
 const beforeMarkdownWheel=await markdownGeometry();await wheel('#text-host .cm-scroller',900);
 try{await page.waitForFunction(()=>document.querySelector('#markdown-preview-scroll').scrollTop>500,{timeout:5000});}finally{report.markdownWheel={before:beforeMarkdownWheel,after:await markdownGeometry()};}
 const selection=await page.evaluate(()=>__nozeliInput.selection()),reverseSource=await sourceTop(),reversePreview=await previewTop();
 await wheel('#markdown-preview-scroll',850);
 try{await page.waitForFunction(({source,preview})=>document.querySelector('#text-host .cm-scroller').scrollTop>source&&document.querySelector('#markdown-preview-scroll').scrollTop>preview,{timeout:5000},{source:reverseSource,preview:reversePreview});}finally{report.markdownReverseWheel={before:{source:reverseSource,preview:reversePreview},after:await markdownGeometry()};}
 assert.deepEqual(await page.evaluate(()=>__nozeliInput.selection()),selection);mark('default linked Markdown follows real wheels in both directions without moving the source selection');
 const headingOffset=markdown.indexOf('## 第25节');await nativeNavigate(headingOffset);
 const landmark=await page.evaluate(()=>{const heading=[...document.querySelectorAll('#text-preview h2')].find(n=>n.textContent.trim()==='第25节'),view=document.querySelector('#markdown-preview-scroll'),source=document.querySelector('#text-host .cm-scroller'),h=heading.getBoundingClientRect(),v=view.getBoundingClientRect();return{visible:h.bottom>v.top&&h.top<v.bottom,sourceRatio:source.scrollTop/(source.scrollHeight-source.clientHeight),previewRatio:view.scrollTop/(view.scrollHeight-view.clientHeight)};});
 assert(landmark.visible,JSON.stringify(landmark));assert(Math.abs(landmark.sourceRatio-landmark.previewRatio)>.04,JSON.stringify(landmark));report.landmark=landmark;mark('unequal-height display math maps the exact later heading rather than a full-document percentage');
 await page.screenshot({path:path.join(output,'01-markdown-linked.png')});
 const dragSelection=await page.evaluate(()=>__nozeliInput.selection()),dragStart={a:await sourceTop(),b:await previewTop()};await dragScrollbar('#text-host .cm-scroller',70);assert(await sourceTop()>dragStart.a+50);assert(await previewTop()>dragStart.b+50);
 const reverseStart={a:await sourceTop(),b:await previewTop()};await dragScrollbar('#markdown-preview-scroll',-65);assert(await previewTop()<reverseStart.b-50);assert(await sourceTop()<reverseStart.a-50);assert.deepEqual(await page.evaluate(()=>__nozeliInput.selection()),dragSelection);mark('CDP pointer drags on source and preview scrollbars follow both ways without the old cursor pulling the view back');
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
 const retainedView=await shell.evaluate(()=>Object.values(window.__workspaceGroups.snapshot().views).find(view=>view.relPath==='阅读.md')?.viewState?.fileView);
 assert(retainedView,'Native workspace retained the inactive Markdown view');
 assert.equal(retainedView.textMode,'split');assert.equal(retainedView.markdownPreview.linked,false);
 await open('阅读.md');await page.waitForSelector('#markdown-divider:not([hidden])');
 assert.deepEqual(await page.evaluate(()=>__nozeliInput.selection()),inheritedSelection);
 assert.equal(await page.$eval('#markdown-sync',el=>el.getAttribute('aria-pressed')),'false');await clickPreviewControl(page, 'markdown-sync');mark('Markdown split mode, selection and linking are per-file and restored after switching away');
 }

 if(probePath)await verifyCrossFileDiagnostic(probePath,probeLine);
 else if(diagnosticOnly)await verifyCrossFileDiagnostic();
 else if(cancelOnly)await verifyGuiCancel();
 else if(recoveryOnly)await verifySyntaxRecovery();
 else if(markdownOnly){await close();await launch();await verifyColdMarkdown();}
 else {
 await open('main.tex');await page.waitForSelector('#tex-build:enabled');await page.click('#tex-build');
 await page.waitForFunction(async id=>['success','error'].includes((await nozeli.invoke('tex.status',{projectId:id})).value.phase),{timeout:45000},id);
 const firstBuild=(await call('tex.status',{projectId:id})).value;assert.equal(firstBuild.phase,'success',firstBuild.log||firstBuild.message);
 await page.waitForSelector('#secondary-pdf .textLayer');await tick(350);
 assert.equal(await texPage(),1);assert.equal(await page.$eval('#tex-sync',el=>el.getAttribute('aria-pressed')),'true');
 assert(await page.$eval('#tex-view-commands',el=>el.hidden&&el.getClientRects().length===0));
 await openPreviewMenu(page,'tex-sync','source');assert.equal(await page.$eval('.nozeli-submenu [data-command="preview-link"]',el=>el.getAttribute('aria-checked')),'true');
 await page.screenshot({path:path.join(output,'00-tex-context-menu.png')});await page.keyboard.press('Escape');
 await nativeNavigate(main.indexOf('MainThree paragraph 28'));await page.waitForFunction(()=>document.querySelector('#secondary-page').textContent.startsWith('3 /'),{timeout:10000});assert(await page.$eval('#secondary-pdf',el=>el.textContent.includes('MainThree')));mark('real XeLaTeX and native SyncTeX source scrolling opens the correct third PDF page');
 await page.screenshot({path:path.join(output,'03-tex-forward.png')});
 await page.click('#secondary-prev');await page.waitForFunction(()=>document.querySelector('#secondary-page').textContent.startsWith('2 /'));await page.waitForFunction(()=>document.querySelector('#tex-sync').dataset.state==='other-source');assert.equal(await page.$eval('#file-path',el=>el.textContent),'main.tex');
 const target=await page.evaluate(()=>{const node=[...document.querySelectorAll('#secondary-pdf .textLayer span')].find(n=>n.textContent.includes('ChildTwo paragraph 7'));const b=node.getBoundingClientRect();return{x:b.left+b.width*.35,y:b.top+b.height*.5};});
 await page.keyboard.down('Control');await page.mouse.click(target.x,target.y);await page.keyboard.up('Control');
 page=await waitForReadingDocument(browser,id,'章节/内容.tex');observe(page);
 const expectedLine=included.split('\n').findIndex(line=>line.includes('ChildTwo paragraph 7'))+1;
 await page.waitForFunction(line=>{const {head}=__nozeliInput.selection();return __nozeliInput.text().slice(0,head).split('\n').length===line;},{timeout:10000},expectedLine);
 await page.screenshot({path:path.join(output,'03-tex-inverse.png')});
 mark('PDF page in an included file keeps the current editor until Ctrl-click explicitly navigates to its exact source line');
 await page.waitForSelector('#tex-build:enabled');await page.click('#tex-preview');await page.waitForSelector('#secondary-pdf .textLayer');
 mark('the included source can reopen the configured root’s compiled PDF');
 const goToThree=async()=>{for(let i=0;i<2;i++){const current=await texPage();if(current===3)return;assert(current===1||current===2);await page.click('#secondary-next');await waitTexPage(current+1);}assert.equal(await texPage(),3);};
 await goToThree();await open('main.tex');await page.waitForSelector('#secondary-pdf .textLayer');
 const snapshotTexLink=()=>page.evaluate(()=>({page:document.querySelector('#secondary-page').textContent,sync:document.querySelector('#tex-sync').dataset.state,reason:document.querySelector('#tex-sync').title,linked:document.querySelector('#tex-sync').getAttribute('aria-pressed'),status:document.querySelector('#tex-status').textContent,buildId:document.querySelector('#secondary-pdf').dataset.buildId,selection:__nozeliInput.selection(),focus:document.activeElement?.className}));
 report.reopenedTexLink={before:await snapshotTexLink()};
 const sourceHit=await page.waitForFunction(()=>{
   const host=document.querySelector('#text-host');
   const line=[...host.querySelectorAll('.view-line')].find(n=>n.textContent.replace(/\u00a0/g,' ').includes('MainThree paragraph 28'));
   if(!line)return false;
   const rect=line.getBoundingClientRect(),x=rect.left+20,y=rect.top+rect.height/2;
   return line.contains(document.elementFromPoint(x,y))&&{x,y};
 });
 const sourcePoint=await sourceHit.jsonValue();await sourceHit.dispose();
 await page.mouse.click(sourcePoint.x,sourcePoint.y);
 await page.waitForFunction(()=>__nozeliInput.text().slice(0,__nozeliInput.selection().head).split('\n').length===69);
 try{await waitTexPage(3);}finally{report.reopenedTexLink.after=await snapshotTexLink();}
 await page.click('#secondary-prev');await waitTexPage(2);
 await page.waitForFunction(()=>document.querySelector('#tex-sync').dataset.state==='other-source');
 await page.evaluate(()=>__nozeliInput.focus());
 const keyboardBefore=await snapshotTexLink();assert.match(keyboardBefore.page,/^2 \//);
 const targetLine=main.slice(0,main.indexOf('MainThree paragraph 28')).split('\n').length;
 await page.keyboard.down('Control');
 try{await page.keyboard.press('End');}finally{await page.keyboard.up('Control');}
 for(let line=main.split('\n').length;line>targetLine;line--)await page.keyboard.press('ArrowUp');
 try{
  await page.waitForFunction(line=>__nozeliInput.text().slice(0,__nozeliInput.selection().head).split('\n').length===line,{timeout:5000},targetLine);
  await waitTexPage(3);
 }finally{report.keyboardTexLink={before:keyboardBefore,after:await snapshotTexLink()};}
 mark('keyboard caret navigation on the reactivated TeX surface moves the PDF from page 2 to page 3');
 await page.click('#secondary-prev');await waitTexPage(2);
 await page.waitForFunction(()=>document.querySelector('#tex-sync').dataset.state==='other-source');
 await page.click('#secondary-prev');await waitTexPage(1);await tick(350);
 const visible=await page.$eval('#text-host .view-lines',el=>el.textContent);assert(visible.includes('MainOne'));mark('PDF page buttons use inverse native line locations to scroll the current source into view');
 const pageScale=()=>page.$eval('#secondary-pdf .pdf-page',el=>Number(el.style.getPropertyValue('--total-scale-factor')));
 for(let i=0;i<8;i++){
   if(await page.$eval('#secondary-scroll',el=>el.scrollHeight-el.clientHeight>=180))break;
   const scale=await pageScale();assert(scale>0);
   await page.click('#secondary-zoom-in');
   await page.waitForFunction(scale=>{const wrap=document.querySelector('#secondary-pdf .pdf-page');return wrap?.querySelector('.textLayer')&&Number(wrap.style.getPropertyValue('--total-scale-factor'))>scale;},{},scale);
 }
 assert(await page.$eval('#secondary-scroll',el=>el.scrollHeight-el.clientHeight>=180),'Zoomed PDF must have room for the test wheel');
 // Monaco recycles virtual line nodes; DOM child order is not visual line order.
 const firstVisible=()=>page.evaluate(()=>{const box=document.querySelector('#text-host').getBoundingClientRect();return [...document.querySelectorAll('#text-host .view-line')].map(n=>({text:n.textContent,top:n.getBoundingClientRect().top})).filter(n=>n.top>=box.top&&n.top<box.bottom).sort((a,b)=>a.top-b.top)[0]?.text;});
 const wheelGeometry=()=>page.evaluate(()=>({sourceContentTop:document.querySelector('#text-host .view-lines').getBoundingClientRect().top,pdf:document.querySelector('#secondary-scroll').scrollTop}));
 const inverseAtViewport=async()=>{const point=await page.evaluate(()=>{const wrap=document.querySelector('#secondary-pdf .pdf-page'),rect=wrap.getBoundingClientRect(),viewport=document.querySelector('#secondary-scroll'),box=viewport.getBoundingClientRect(),scale=Number.parseFloat(wrap.style.getPropertyValue('--total-scale-factor'));return{page:Number(document.querySelector('#secondary-page').textContent.split('/')[0]),x:rect.width*.3/scale,y:Math.max(0,Math.min(rect.height,box.top+viewport.clientHeight*.25-rect.top))/scale};});const synced=await call('tex.sync',{projectId:id,buildId:await page.$eval('#secondary-pdf',el=>el.dataset.buildId),relPath:'main.tex',text:main,direction:'inverse',...point});assert(synced.ok,JSON.stringify(synced));return{point,...synced.value};};
 const beforeWheel=await firstVisible(),beforeGeometry=await wheelGeometry(),beforeInverse=await inverseAtViewport();await wheel('#secondary-scroll',180);const afterWheel=await firstVisible(),afterGeometry=await wheelGeometry(),afterInverse=await inverseAtViewport();
 const stateAfterWheel=await page.$eval('#tex-sync',el=>el.dataset.state);report.texWheel={before:beforeWheel,after:afterWheel,beforeGeometry,afterGeometry,beforeInverse,afterInverse};assert.equal(stateAfterWheel,'ready');assert(afterGeometry.pdf>beforeGeometry.pdf,JSON.stringify(report.texWheel));assert.equal(afterInverse.relPath,'main.tex');assert(afterInverse.line>beforeInverse.line,JSON.stringify(report.texWheel));assert.notEqual(afterWheel,beforeWheel,JSON.stringify(report.texWheel));mark('PDF zoom and real page-local wheel reuse PDF coordinates and move the source lines');
 await nativeNavigate(main.length-1);await page.keyboard.type('\n% UI_STALE_LINK');await tick(250);const frozenPage=await texPage();await wheel('#text-host .monaco-scrollable-element',-500);assert.equal(await texPage(),frozenPage);assert.equal(await page.$eval('#tex-sync',el=>el.dataset.state),'paused');
 // Settle the prior edit so this exercises just the undo's save, not two
 // successive saves with different bytes racing the same snapshot.
 await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
 assert.match(await readFile(path.join(project,'main.tex'),'utf8'),/% UI_STALE_LINK/);
 const previousSequence=(await call('tex.status',{projectId:id})).value.sequence;
 await undoTo(main);
 report.undoBuild={saveAtClick:await page.$eval('#save-status',el=>el.dataset.state)};
 await page.click('#tex-build');
 await page.waitForFunction(async(id,previous)=>{const r=await nozeli.invoke('tex.status',{projectId:id});return r.ok&&r.value.sequence>previous&&['success','error','cancelled'].includes(r.value.phase);},{timeout:45000},id,previousSequence);
 const rebuilt=(await call('tex.status',{projectId:id})).value;
 assert.equal(rebuilt.phase,'success',rebuilt.log||rebuilt.message);
 await page.waitForFunction(buildId=>document.querySelector('#secondary-pdf').dataset.buildId===buildId&&document.querySelector('#tex-sync').dataset.state==='ready',{timeout:10000},rebuilt.lastSuccess.buildId);
 await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
 assert.equal(await readFile(path.join(project,'main.tex'),'utf8'),main);
 mark('stale source pauses navigation; native undo and a matching successful build restore linking');
 await clickPreviewControl(page, 'tex-sync', 'source');
 assert.equal(await page.$eval('#tex-sync',el=>el.getAttribute('aria-pressed')),'false');
 await page.waitForFunction(async projectId=>{const r=await nozeli.invoke('tex.view',{projectId,root:'main.tex'});return r.ok&&r.value.linked===false;},{timeout:10000},id);
 if(!texOnly){await open('阅读.md');await page.waitForSelector('#markdown-divider:not([hidden])');assert.equal(await page.$eval('#markdown-sync',el=>el.getAttribute('aria-pressed')),'true');}
 await close();await launch();
 if(!texOnly)await verifyColdMarkdown();
 await open('main.tex');await page.waitForSelector('#tex-build:enabled');
 if(await page.$eval('#tex-preview',el=>el.getAttribute('aria-pressed'))!=='true')await page.click('#tex-preview');
 await page.waitForSelector('#secondary-pdf .textLayer');
 assert.equal(await page.$eval('#secondary-pdf',el=>el.dataset.buildId),rebuilt.lastSuccess.buildId);
 assert.equal(await page.$eval('#tex-sync',el=>el.getAttribute('aria-pressed')),'false');
 await clickPreviewControl(page, 'tex-sync', 'pdf');
 assert.equal(await page.$eval('#tex-sync',el=>el.getAttribute('aria-pressed')),'true');
 await page.waitForFunction(async projectId=>{const r=await nozeli.invoke('tex.view',{projectId,root:'main.tex'});return r.ok&&r.value.linked===true;},{timeout:10000},id);
 await page.screenshot({path:path.join(output,'04-restored-linking.png')});mark('cold relaunch preserves TeX per-root linking and the PDF context menu re-enables it');
 }
 for(const [name,source]of Object.entries(sources))assert.equal(await readFile(path.join(project,name),'utf8'),source,name);
 assert.deepEqual(report.errors,[]);await close();mark('original sources stay byte-identical and native close exits normally without renderer errors');report.ok=true;
}catch(error){report.error=String(error.stack);try{report.surfaces=await Promise.all((await browser.pages()).map(p=>p.evaluate(()=>({scope:window.__workspaceScope??null,ready:window.__nozeliReady??null,filePath:document.querySelector('#file-path')?.textContent??null,save:document.querySelector('#save-status')?.dataset.state??null,statusText:document.querySelector('#save-status')?.textContent??null,markdownLink:document.querySelector('#markdown-sync')?.getAttribute('aria-pressed')??null,matchingMarkdown:document.querySelector('#text-preview')?._markdownSourceText===window.__nozeliInput?.text?.()})).catch(e=>String(e))));}catch{}await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(report.error);}
finally{if(browser){await shell?.evaluate(()=>nozeli.invoke('session.requestClose')).catch(()=>{});await Promise.race([exited,tick(5000)]);await browser.disconnect();}if(child?.exitCode===null)child.kill('SIGTERM');await writeFile(path.join(output,'main.log'),log);await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({ok:report.ok,output,checks:report.checks,error:report.error},null,2));process.exit(report.ok?0:1);
