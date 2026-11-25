import { contentToolForPage } from './native-content-tools.fixture.mjs';
import {prepareReading, waitForDesktopPage, waitForReadingDocument, waitForReadingProject} from './reading-setup.fixture.mjs';
import {clickPreviewControl, openPreviewMenu} from './preview-menu-support.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..');
const windows=process.platform==='win32';
const output=await mkdtemp(path.join(os.tmpdir(),'nozeli-tex-live-'));const project=path.join(output,'中文 论文');await mkdir(path.join(project,'sections'),{recursive:true});
console.log('TeX desktop fixture:',output);
const main=String.raw`\documentclass{article}
\usepackage{fontspec}
\setmainfont{${windows?'SimSun':'Noto Serif CJK SC'}}
\usepackage{graphicx}
\begin{document}
\section{Nozeli 动态编译验收}
中文正文与公式 $E=mc^2$。
\input{sections/body}
\includegraphics[width=3cm]{figure.png}
\cite{demo}
\bibliographystyle{plain}
\bibliography{refs}
\newpage
\section{第二页}保持阅读位置与缩放。
\end{document}
`;
await writeFile(path.join(project,'main.tex'),main);await writeFile(path.join(project,'sections/body.tex'),'InitialAlpha 多文件章节。\n');
await writeFile(path.join(project,'refs.bib'),'@article{demo, title={Synthetic TeX Test}, author={Nozeli, Tester}, journal={Test Journal}, year={2026}}\n');
await writeFile(path.join(project,'figure.png'),await readFile(path.resolve(root,'tests/fixtures/tex/pipeline.png')));
await writeFile(path.join(project,'read.md'),'# Normal file\n');
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const n=server.address().port;server.close(()=>resolve(n));});});
const env={...process.env};
for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||key==='ELECTRON_RUN_AS_NODE')delete env[key];
if(process.platform==='linux')Object.assign(env,{WAYLAND_DISPLAY:env.WAYLAND_DISPLAY||'wayland-0',XDG_RUNTIME_DIR:env.XDG_RUNTIME_DIR||'/run/user/1000'});
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:path.join(output,'config'),NOZELI_USER_DATA:path.join(output,'config','desktop'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1'});
const child=spawn(createRequire(import.meta.url)('electron'),[...(process.platform==='linux'?['--ozone-platform=wayland']:[]),path.join(root,'src/main/main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
let closed=false;let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);let browser,page;const checks=[];
try{
 const deadline=Date.now()+25000;for(;;){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}if(Date.now()>deadline||child.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,100));}
 browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});page=await waitForDesktopPage(browser);
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.stack);});await page.waitForFunction(()=>window.__nozeliReady);
 await prepareReading(page);await page.click('#pick-project');
 // Windows project admission durably initializes the Git repository before
 // the picker resolves. Keep that bound separate from UI and compile waits.
 if(windows)page.setDefaultTimeout(360000);
 const projectId=await waitForReadingProject(page,project).finally(()=>{if(windows)page.setDefaultTimeout(30000);});
 const shell=page;
 const observed=new WeakSet([shell]);
 async function open(name){
   await shell.click('#file-tree button[data-path='+JSON.stringify(name)+']');
   const documentPage=await waitForReadingDocument(browser,projectId,name);
   if(!observed.has(documentPage)){observed.add(documentPage);documentPage.on('pageerror',e=>errors.push(e.message));}
   return documentPage;
 }
 const state=()=>page.evaluate(async projectId=>(await nozeli.invoke('tex.status',{projectId})).value,projectId);
 async function waitForBuild(before, label, phase='success'){
   await page.waitForFunction(async ({projectId,sequence})=>{const s=(await nozeli.invoke('tex.status',{projectId})).value;return s.sequence>sequence&&['success','error','cancelled'].includes(s.phase);},{timeout:45000},{projectId,sequence:before.sequence??0});
   const result=await state();
   assert.equal(result.phase,phase,`${label}: ${result.code??''} ${result.message??''}\n${result.log??''}`);
   if(phase==='success')assert.notEqual(result.lastSuccess.buildId,before.lastSuccess?.buildId);
   return result;
 }
 const beforeOpen=await state();
 page=await open('main.tex');await page.waitForSelector('#tex-build:enabled');
 await new Promise(r=>setTimeout(r,1500));assert.equal((await state()).lastSuccess?.buildId,beforeOpen.lastSuccess?.buildId);assert(!['building','queued'].includes((await state()).phase));assert.equal(await page.$('#tex-auto'),null);await page.click('#tex-build');
 let first=await waitForBuild(beforeOpen,'initial compile');
 assert.equal(await page.$eval('#tex-root',n=>n.value),'main.tex');assert.equal(await page.$eval('#tex-engine',n=>n.value),'xelatex');
 const inferred=await page.evaluate(async projectId=>(await nozeli.invoke('tex.inspect',{projectId,relPath:'sections/body.tex'})).value,projectId);assert.equal(inferred.configuredRoot,'main.tex');assert.equal(inferred.config.engine,'xelatex');checks.push('automatic main and Unicode engine are persisted and retained for chapter');
 await page.waitForSelector('#secondary-pdf canvas',{timeout:30000});
 await page.waitForFunction(()=>document.querySelector('#secondary-pdf').textContent.includes('InitialAlpha'));
  assert.match(await page.$eval('#secondary-pdf',n=>n.textContent),/中文正文/);checks.push('real XeLaTeX Chinese/math/image/BibTeX/multifile PDF renders');
  // Independent page preservation is intentional while source linking is off.
  await clickPreviewControl(page, 'tex-sync');assert.equal(await page.$eval('#tex-sync',n=>n.getAttribute('aria-pressed')),'false');

 const originalSplit=await page.$eval('#documents',n=>n.style.getPropertyValue('--split'));
 for(const split of ['35%','65%','50%']) {
   await page.$eval('#documents',(n,s)=>n.style.setProperty('--split',s),split);
   await new Promise(resolve=>setTimeout(resolve,500));
   const box=await page.evaluate(()=>{const v=document.querySelector('#secondary-scroll'),c=document.querySelector('#secondary-pdf canvas').getBoundingClientRect(),css=getComputedStyle(document.querySelector('#secondary-pdf'));return {w:c.width,h:c.height,aw:v.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight)-2,ah:v.clientHeight-parseFloat(css.paddingTop)-parseFloat(css.paddingBottom)-2};});
   assert.ok(box.w<=box.aw+2&&box.h<=box.ah+2,JSON.stringify(box));
   assert.ok(Math.min(Math.abs(box.w-box.aw),Math.abs(box.h-box.ah))<3,JSON.stringify(box));
 }
 await page.$eval('#documents',(n,s)=>s?n.style.setProperty('--split',s):n.style.removeProperty('--split'),originalSplit);
 await page.click('#secondary-zoom-in');await page.click('#secondary-fit');
 checks.push('PDF fit uses actual pane width and height across 35/65/50 percent splits and resets manual zoom');
 await page.screenshot({path:path.join(output,'01-tex-preview.png')});
 await page.evaluate(()=>__nozeliInput.replace(__nozeliInput.text().replace('中文正文','动态更新 Beta')));
 await new Promise(r=>setTimeout(r,1500));assert.equal((await state()).lastSuccess.buildId,first.lastSuccess.buildId);await page.click('#tex-build');
 const second=await waitForBuild(first,'Beta compile');
 await page.waitForFunction(()=>document.querySelector('#secondary-pdf').textContent.includes('动态更新 Beta'),{timeout:20000});checks.push('editing keeps frozen preview until explicit compile');
 await page.click('#secondary-zoom-in');
 await page.click('#secondary-next');await page.waitForFunction(()=>document.querySelector('#secondary-page').textContent.startsWith('2 /'));
 await page.evaluate(()=>__nozeliInput.replace(__nozeliInput.text().replace('动态更新 Beta','动态更新 Gamma')));
 await page.click('#tex-build');
 const refreshed=await waitForBuild(second,'Gamma compile');
 await page.waitForFunction(id=>document.querySelector('#secondary-pdf').dataset.buildId===id&&document.querySelector('#secondary-page').textContent.startsWith('2 /'),{},refreshed.lastSuccess.buildId);
 checks.push('preview refresh preserves page');
 await page.click('#secondary-prev');
 const beforeExternal=await state();await writeFile(path.join(project,'sections/body.tex'),'ExternalDelta 外部章节更新。\n');
 await new Promise(r=>setTimeout(r,1500));assert.equal((await state()).lastSuccess.buildId,beforeExternal.lastSuccess.buildId);await page.click('#tex-build');
 await waitForBuild(beforeExternal,'external chapter compile');
 await page.waitForFunction(()=>document.querySelector('#secondary-pdf').textContent.includes('ExternalDelta'));checks.push('external chapter changes require explicit compilation');
 const beforeComposition=await state();
 await page.evaluate(()=>{document.querySelector('#text-host .monaco-editor').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));__nozeliInput.replace(__nozeliInput.text().replace('动态更新 Gamma','输入法 Composition'));});
 await new Promise(r=>setTimeout(r,1500));assert.equal((await state()).sequence,beforeComposition.sequence);
 await page.evaluate(()=>document.querySelector('#text-host .monaco-editor').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
 await new Promise(r=>setTimeout(r,1500));assert.equal((await state()).sequence,beforeComposition.sequence);await page.click('#tex-build');
 await waitForBuild(beforeComposition,'post-composition explicit compile');
 await page.waitForFunction(()=>document.querySelector('#secondary-pdf').textContent.includes('输入法 Composition'),{timeout:30000});checks.push('IME composition and completion do not compile automatically');
 let good=await state();
 await page.evaluate(()=>__nozeliInput.replace(__nozeliInput.text().replace('\\end{document}','\\InvalidNozeliCommand\n\\end{document}')));
 await page.click('#tex-build');
 const failed=await waitForBuild(good,'intentional syntax error','error');assert.equal(failed.lastSuccess.buildId,good.lastSuccess.buildId);assert.ok(await page.$('#secondary-pdf canvas'));assert.ok(failed.diagnostics.length);await page.waitForSelector('#tex-diagnostics[open]');
 await page.screenshot({path:path.join(output,'02-tex-error-keeps-preview.png')});checks.push('syntax error retains successful PDF and exposes file/line diagnostics');
 await page.click('#tex-diagnostics button:enabled');await page.waitForFunction(()=>{const {from,to}=__nozeliInput.selection();return __nozeliInput.text().slice(from,to)==='\\InvalidNozeliCommand';});checks.push('diagnostic clicks select the exact offending source line');
 await page.evaluate(()=>__nozeliInput.replace(__nozeliInput.text().replace('\\InvalidNozeliCommand\n','')));
 await contentToolForPage(page, ['texBuild']);await waitForBuild(failed,'syntax recovery compile');
 await clickPreviewControl(page, 'tex-preview');await page.waitForSelector('#secondary-pane[hidden]');await clickPreviewControl(page, 'tex-preview');await page.waitForSelector('#secondary-pdf canvas');
 const markdownPage=await open('read.md');await markdownPage.waitForSelector('#file-path');checks.push('preview toggle closes and reopens the artifact; another file opens in its own document surface');
 page=await open('main.tex');await page.waitForSelector('#tex-build:enabled');
 if(await page.$eval('#secondary-pane',el=>el.hidden))await page.click('#tex-preview');
 await page.waitForSelector('#secondary-pdf canvas');
 const savedBuild=(await state()).lastSuccess.buildId;
 await page.reload();await page.waitForFunction(()=>window.__nozeliReady);await page.waitForSelector('#tex-build:enabled');await page.click('#tex-preview');await page.waitForSelector('#secondary-pdf canvas');
 assert.equal(await page.$('#tex-auto'),null);assert.equal(await page.$eval('#tex-engine',n=>n.value),'xelatex');assert.equal(await page.$eval('#tex-root',n=>n.value),'main.tex');
 await page.waitForFunction(id=>document.querySelector('#secondary-pdf').dataset.buildId===id,{},savedBuild);checks.push('reload preserves manual configuration; explicit preview loads exact frozen artifact');
 await page.screenshot({path:path.join(output,'03-restored-preview.png')});
 const base=await page.evaluate(async projectId=>(await nozeli.invoke('file.read',{projectId,relPath:'main.tex'})).value,projectId);
 await page.evaluate(async ({projectId,base})=>nozeli.invoke('tex.build',{projectId,buffers:[{relPath:'main.tex',baseDigest:base.digest,text:base.text.replace('\\end{document}','\\loop\\iftrue\\repeat\n\\end{document}')}]}),{projectId,base});
 await new Promise(r=>setTimeout(r,400));assert.ok(['building','queued'].includes((await state()).phase));
 await shell.evaluate(()=>nozeli.invoke('session.requestClose'));
 const exit=await Promise.race([exited,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('close left compiler/application running')),10000);t.unref();})]);assert.equal(exit.code,0);closed=true;checks.push('closing real Electron cancels running TeX compiler and exits cleanly');
 assert.deepEqual(errors,[]);
 await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,checks,firstDurationMs:first.lastSuccess.durationMs,engine:first.lastSuccess.engineVersion,output},null,2));console.log(JSON.stringify({passed:true,checks,output},null,2));
} catch(error){if(page){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(await page.evaluate(()=>({status:document.querySelector('#tex-status')?.textContent,preview:document.querySelector('#secondary-pdf')?.dataset,stages:[...document.querySelectorAll('[data-tex-stage]')].map(n=>({id:n.dataset.texStage,text:n.textContent.slice(0,200),rect:n.getBoundingClientRect().toJSON()})),body:document.body.innerText.slice(-1500)})).catch(()=>({})));}throw error;}
finally{await writeFile(path.join(output,'electron.log'),log);if(page&&!closed)await page.evaluate(()=>nozeli.invoke('session.requestClose')).catch(()=>{});await browser?.disconnect();if(child.exitCode===null)setTimeout(()=>child.kill('SIGTERM'),3000).unref();}
