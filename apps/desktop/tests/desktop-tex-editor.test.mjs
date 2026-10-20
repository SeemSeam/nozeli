import {prepareReading, waitForDesktopPage, waitForReadingProject} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..');await mkdir(path.join(root,'.test-output'),{recursive:true});
const output=await mkdtemp(path.join(root,'.test-output','tex-editor-'));const project=path.join(output,'中文 论文');await mkdir(path.join(project,'sections'),{recursive:true});
const main=String.raw`\documentclass{article}
\usepackage{fontspec}
\setmainfont{Noto Serif CJK SC}
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
const child=spawn(createRequire(import.meta.url)('electron'),['--ozone-platform=wayland',path.join(root,'src/main/main.cjs')],{cwd:root,env:{...process.env,WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000',NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:path.join(output,'profile'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
let closed=false;let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);let browser,page;const checks=[];
try{
 const deadline=Date.now()+25000;for(;;){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}if(Date.now()>deadline||child.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,100));}
 browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});page=await waitForDesktopPage(browser);
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.stack);});await page.waitForFunction(()=>window.__nozeliReady);
 await prepareReading(page);await page.click('#pick-project');
 const projectId=await waitForReadingProject(page,project);
 const state=()=>page.evaluate(async projectId=>(await nozeli.invoke('tex.status',{projectId})).value,projectId);

 await page.evaluate(async projectId=>nozeli.invoke('tex.configure',{projectId,root:'main.tex',engine:'xelatex',automatic:false}),projectId);
 await page.click('#file-tree button[data-path="main.tex"]');await page.waitForSelector('#text-host .monaco-editor');
 const set=async text=>{await page.evaluate(text=>{__nozeliInput.replace(text);__nozeliInput.select(text.length,text.length);__nozeliInput.focus();},text);};
 const suggest=async()=>{await page.keyboard.down('Control');await page.keyboard.press('Space');await page.keyboard.up('Control');await page.waitForSelector('.suggest-widget.visible');};
 await set('\\frac');await suggest();await page.keyboard.press('Tab');
 await page.waitForFunction(()=>__nozeliInput.text().includes('numerator'));
 await page.keyboard.type('a+b');await page.keyboard.press('Tab');await page.keyboard.type('c');await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>__nozeliInput.text()),'\\frac{a+b}{c}');checks.push('physical Ctrl+Space/Tab accepts fraction snippet and navigates placeholders');
 await page.keyboard.press('Escape');await set('\\begin');await suggest();
 await page.waitForFunction(()=>[...document.querySelectorAll('.suggest-widget .monaco-list-row')].some(n=>n.textContent.includes('begin equation')));
 const rows=await page.$$('.suggest-widget .monaco-list-row');for(const row of rows){if((await row.evaluate(n=>n.textContent)).includes('begin equation')){await row.click();break;}}
 await page.keyboard.press('Tab');await page.waitForFunction(()=>__nozeliInput.text().includes('\\end{equation}'));
 await page.keyboard.type('E=mc^2');assert.match(await page.evaluate(()=>__nozeliInput.text()),/E=mc\^2/);checks.push('environment snippet inserts matching begin/end and editable body');
 await page.keyboard.press('Escape');await set('% comment\n\\section{Title}\n$x^2 + 1$');
 await page.waitForFunction(()=>new Set([...document.querySelectorAll('#text-host .view-line span')].map(n=>getComputedStyle(n).color)).size>=3);
 await page.screenshot({path:path.join(output,'01-tex-highlight.png')});checks.push('real rendered LaTeX commands, comments and math use distinct token colors');
 await set('plain');await page.keyboard.press('Escape');await page.keyboard.press('Tab');await page.waitForFunction(()=>/^plain\s+$/.test(__nozeliInput.text()));checks.push('ordinary Tab retains indentation');
 await writeFile(path.join(project,'sections/body.tex'),'\\section{Demo}\n\\label{sec:demo}\n');
 await set('\\documentclass{article}\n\\begin{document}\n\\input{sections/body}\n\\bibliography{refs}\n\\ref{sec:}\n\\end{document}');
 await page.evaluate(()=>{const n=__nozeliInput.text().indexOf('sec:')+4;__nozeliInput.select(n,n);__nozeliInput.focus();});await suggest();
 await page.waitForFunction(()=>document.querySelector('.suggest-widget')?.textContent.includes('sec:demo'));await page.keyboard.press('Tab');
 await page.waitForFunction(()=>__nozeliInput.text().includes('\\ref{sec:demo}'));checks.push('real TexLab label completion preserves command braces');
 await page.keyboard.press('Escape');await page.evaluate(()=>{const n=__nozeliInput.text().indexOf('sec:demo')+5;__nozeliInput.select(n,n);__nozeliInput.focus();});await page.keyboard.press('F12');
 await page.waitForFunction(()=>__nozeliInput.text().includes('\\label{sec:demo}'));
 await page.waitForFunction(()=>{const s=__nozeliInput.selection();return __nozeliInput.text().slice(s.from,s.to)==='sec:demo';});checks.push('physical F12 opens nested source and selects exact label');

 await page.evaluate(()=>{__nozeliInput.select(0,14);__nozeliInput.focus();});await page.waitForSelector('#selection-menu:not([hidden])');await page.click('#selection-note');await page.type('#note-input','TeX anchored note');await page.click('#add-note');await page.waitForSelector('#text-host .note-anchor');checks.push('TeX selection retains unified local floating notes without Agent dispatch');
 await page.click('#file-tree button[data-path="refs.bib"]');await page.waitForFunction(()=>__nozeliInput.text().startsWith('@article'));
 await page.waitForFunction(()=>new Set([...document.querySelectorAll('#text-host .view-line span')].map(n=>getComputedStyle(n).color)).size>=2);checks.push('BibTeX opens in Monaco with token colors');
 assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,'02-bibtex-highlight.png')});
 await page.evaluate(()=>nozeli.invoke('session.requestClose'));await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('application did not close')),10000);timer.unref();})]);closed=true;
 await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,checks,output},null,2));console.log(JSON.stringify({passed:true,checks,output},null,2));
} catch(error){if(page){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(await page.evaluate(()=>({status:document.querySelector('#tex-status')?.textContent,preview:document.querySelector('#secondary-pdf')?.dataset,stages:[...document.querySelectorAll('[data-tex-stage]')].map(n=>({id:n.dataset.texStage,text:n.textContent.slice(0,200),rect:n.getBoundingClientRect().toJSON()})),body:document.body.innerText.slice(-1500)})).catch(()=>({})));}throw error;}
finally{await writeFile(path.join(output,'electron.log'),log);if(page&&!closed)await page.evaluate(()=>nozeli.invoke('session.requestClose')).catch(()=>{});await browser?.disconnect();if(child.exitCode===null)setTimeout(()=>child.kill('SIGTERM'),3000).unref();}
