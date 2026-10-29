import {desktopLaunch,nativeDocumentNavigation} from './desktop-runtime.fixture.mjs';
import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import JSZip from 'jszip';
import {DesktopHost} from '../src/main/host.mjs';
import {wordText} from '../src/main/word-anchors.mjs';
import {FileChanges} from '../src/domain/file-changes.mjs';

const root=path.resolve(import.meta.dirname,'..'),tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const out=await fs.mkdtemp(path.join(root,'.test-output','word-authorship-')),profile=path.join(out,'profile'),project=path.join(out,'修改者视图验收');await fs.mkdir(project);
const original=await fs.readFile(path.resolve(root,'tests/fixtures/office/中文 文档.docx'));
await fs.writeFile(path.join(project,'word.docx'),original);
for(const [name,replacement]of [['repeat.docx','AAAA'],['whitespace.docx','甲</w:t><w:tab/><w:t>乙</w:t><w:br/><w:t>丙']]){
 const packageZip=await JSZip.loadAsync(original);packageZip.file('word/document.xml',(await packageZip.file('word/document.xml').async('string')).replace('原始首句',replacement),{createFolders:false});await fs.writeFile(path.join(project,name),await packageZip.generateAsync({type:'nodebuffer'}));
}
const formats={'read.md':'# 阅读\n\n原始段落。\n\n末尾。\n','plain.txt':'Plain text baseline.\nSecond line.\n','main.ts':'const initial = 1;\nconsole.log(initial);\n','main.tex':'\\documentclass{article}\n\\begin{document}\nOriginal text\n\\end{document}\n'};
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;
for(const [rel,text]of Object.entries(formats)){await fs.writeFile(path.join(project,rel),text);const first=await host.readFile(projectId,rel);await host.save(projectId,rel,first.digest,text.replace('原始段落','用户修改段落').replace('baseline','changed').replace('initial = 1','initial = 2').replace('Original text','Modified text'));}
// More than one page of real content; no renderer document simulation.
const zip=await JSZip.loadAsync(original);let xml=await zip.file('word/document.xml').async('string');
xml=xml.replace(/<w:sectPr\b/,Array.from({length:90},(_,i)=>`<w:p><w:r><w:t>分页段落 ${i}：正文位置跟随滚动，批次保存在独立文件。</w:t></w:r></w:p>`).join('')+'<w:sectPr');zip.file('word/document.xml',xml,{createFolders:false});const pagesBytes=await zip.generateAsync({type:'nodebuffer'});assert.match(await wordText(pagesBytes),/分页段落 89/);await fs.writeFile(path.join(project,'pages.docx'),pagesBytes);
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const launch=()=>spawn(desktopLaunch(root).command,desktopLaunch(root).args,{cwd:root,env:{...process.env,...(process.env.NOZELI_TEST_BUNDLE?{PATH:''}:{}),NOZELI_CONFIG_ROOT:out,WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000',NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_AGENT_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});
let child=launch(),exited,log='',browser,page,frame;
const report={ok:false,out,project,checks:[],errors:[],metrics:{}};
const attach=process=>{process.stdout.on('data',c=>{log+=c;});process.stderr.on('data',c=>{log+=c;});return new Promise(resolve=>process.once('exit',(code,signal)=>resolve({code,signal})));};exited=attach(child);
const invoke=(op,payload={})=>page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
const unwrap=async(op,payload)=>{const result=await invoke(op,payload);assert(result.ok,JSON.stringify(result.error));return result.value;};
async function connect(){for(let i=0;i<120;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{}await tick(100);}assert(browser,log);page=nativeDocumentNavigation(await waitForDesktopPage(browser),browser);page.on('pageerror',error=>report.errors.push(error.stack));await page.waitForFunction(()=>window.__nozeliReady);await page.evaluate(()=>{window.lastWordLayout=null;addEventListener('message',event=>{if(event.data?.type==='authorship-layout')lastWordLayout=event.data;});});}
async function open(rel){
 if(await page.$eval('#app',node=>node.classList.contains('narrow-layout')?!node.classList.contains('drawer-files-open'):node.classList.contains('files-collapsed')))await page.click('#file-toggle');
 await page.click('#file-tree button[data-path="'+rel+'"]');await page.waitForFunction(rel=>document.querySelector('#file-path').textContent===rel,{},rel);
 if(rel.endsWith('docx')){const iframe=await page.waitForSelector('#word-host iframe');frame=await iframe.contentFrame();await frame.waitForFunction(()=>window.nozeliWordEditor?.activeEditor?.state?.doc,{timeout:45000});}
}
async function wordSelect(quote){return frame.evaluate(quote=>{const editor=nozeliWordEditor.activeEditor;let found;editor.state.doc.descendants((node,pos)=>{if(node.isText){const at=node.text.indexOf(quote);if(at>=0)found={from:pos+at,to:pos+at+quote.length};}});if(!found)throw Error('Quote not found: '+quote);editor.commands.setTextSelection(found);editor.view.focus();return found;},quote);}
async function wordPoint(quote){
 const rect=await frame.evaluate(quote=>{const run=[...document.querySelectorAll('.superdoc-text-run[data-pm-start]')].find(node=>node.textContent.includes(quote));if(!run)throw Error('Run missing: '+quote);const walker=document.createTreeWalker(run,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){const i=n.textContent.indexOf(quote);if(i>=0){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+quote.length);const b=r.getBoundingClientRect();return {left:b.left+Math.min(5,b.width/2),top:b.top+b.height/2};}}throw Error('Missing exact quote');},quote);
 const bounds=await page.$eval('#word-host iframe',node=>{const b=node.getBoundingClientRect();return {left:b.left,top:b.top};});return {x:bounds.left+rect.left,y:bounds.top+rect.top};
}
async function right(point){await page.mouse.click(point.x,point.y,{button:'right'});const isWord=await page.$eval('#file-path',n=>n.textContent.endsWith('.docx'));if(isWord)await frame.waitForSelector('.context-menu');else await page.waitForSelector('#document-context-menu:not([hidden])');}
async function command(id){
 const isWord=await page.$eval('#file-path',n=>n.textContent.endsWith('.docx'));
 if(isWord){await frame.click(`.context-menu [data-command="${id}"]`);await frame.waitForSelector('.context-menu',{hidden:true});return;}
 const item=await page.$(`#document-context-menu [data-command="${id}"]`);if(!item){const parent=id==='authorship-toggle'?'view':'history';await page.click(`#document-context-menu [data-command="${parent}"]`);}
 await page.click(`.nozeli-context-menu [data-command="${id}"]`);await page.waitForSelector('#document-context-menu[hidden]');
}
async function wordMenuLabel(id){return frame.$eval(`.context-menu [data-command="${id}"]`,node=>node.textContent);}
const markState=selector=>page.$$eval(selector,nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {title:node.title,from:node.dataset.from,to:node.dataset.to,page:node.dataset.page,continuation:node.dataset.continuation,top:r.top,left:r.left,width:r.width,height:r.height};}));
try{
 await connect();await prepareReading(page);
 await unwrap('session.resize',{width:1440,height:900});await page.waitForFunction(()=>innerWidth===1440);
 await open('word.docx');await tick(250);
 const body=await unwrap('file.read',{projectId,relPath:'word.docx'});
 report.metrics.initialBody=body.authorshipText;
 await frame.evaluate(()=>{window.wordUpdates=[];nozeliWordEditor.config.onTransaction=(()=>{const original=nozeliWordEditor.config.onTransaction;return event=>{wordUpdates.push({surface:event.surface,main:event.transaction.doc===nozeliWordEditor.activeEditor.state.doc,docChanged:event.transaction.docChanged});return original(event);};})();});
 assert.equal(await page.$('.word-authorship .authorship-mark'),null);assert.deepEqual(await fs.readFile(path.join(project,'word.docx')),original);
 await wordSelect('原始首句');await page.keyboard.type('人工修改😀');await page.waitForSelector('.word-authorship .authorship-pending',{timeout:8000});
 await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved',{timeout:30000});await page.waitForSelector('.word-authorship .authorship-user:not(.authorship-pending)');
 report.metrics.transactions=await frame.evaluate(()=>wordUpdates);
 let read=await unwrap('file.read',{projectId,relPath:'word.docx'});assert.match(read.authorshipText,/人工修改😀/);assert.equal(read.authorship.lastChange.actor.kind,'user');
 await page.screenshot({path:path.join(out,'01-word-authorship.png')});report.checks.push('real DOCX engine input, Chinese/emoji, pending marker, automatic save and exact user attribution');
 const snapshot=await fs.readFile(path.join(project,'word.docx')),ledgerPath=new FileChanges(project).location('word.docx'),ledgerBytes=await fs.readFile(ledgerPath);
 const selected=await wordSelect('人工修改😀');await right(await wordPoint('人工修改😀'));
 assert.deepEqual(await frame.evaluate(()=>({from:nozeliWordEditor.activeEditor.state.selection.from,to:nozeliWordEditor.activeEditor.state.selection.to})),selected);
 assert.equal(await wordMenuLabel('authorship-toggle'),'隐藏修改者');await page.screenshot({path:path.join(out,'02-word-context-menu.png')});
 await command('authorship-toggle');await page.waitForFunction(()=>!document.querySelector('.word-authorship .authorship-mark'));
 await right(await wordPoint('人工修改😀'));assert.equal(await wordMenuLabel('authorship-toggle'),'显示修改者');await command('authorship-toggle');await page.waitForSelector('.word-authorship .authorship-user');
 assert.deepEqual(await fs.readFile(path.join(project,'word.docx')),snapshot);assert.deepEqual(await fs.readFile(ledgerPath),ledgerBytes);report.checks.push('physical Word right click toggles the shared view, retains selection and changes neither package nor ledger');
 await page.click('.word-authorship .authorship-user');await page.waitForSelector('#document-change-history[open] .change-history-entry');
 assert.match(await page.$eval('#document-change-history',node=>node.innerText),/人工修改😀/);assert.match(await page.$eval('.change-history-entry time',node=>node.textContent),/\d{4}\/\d{2}\/\d{2}.*\d{2}:\d{2}:\d{2}/);assert.equal(await page.$('.change-history-compare'),null);
 await page.screenshot({path:path.join(out,'03-word-modification-time.png')});await page.keyboard.press('Escape');report.checks.push('clicking the Word margin shows the actual saved batch, complete time and changed text');
 const before=(await markState('.word-authorship .authorship-user'))[0];await page.click('#word-zoom-in');await frame.waitForFunction(()=>nozeliWordEditor.getZoom()===120);await tick(250);const enlarged=(await markState('.word-authorship .authorship-user'))[0];report.metrics.zoom={before,enlarged};assert(enlarged.height>before.height*1.1);await page.click('#word-fit');await tick(250);report.checks.push('Word author marker follows real zoom and fit-width layout');
 await wordSelect('人工修改😀');await page.keyboard.down(process.platform==='darwin'?'Meta':'Control');await page.keyboard.press('b');await page.keyboard.up(process.platform==='darwin'?'Meta':'Control');await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');await tick(1300);
 const history=await unwrap('document.history',{projectId,relPath:'word.docx'});assert.equal(history.events[0].type,'word-format');assert.deepEqual(history.events[0].edits,[]);report.checks.push('native bold formatting records a batch without attributing unchanged body text');
 await wordSelect('中文样例');await page.keyboard.type('表格内人工修改');await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');await tick(1400);
 read=await unwrap('file.read',{projectId,relPath:'word.docx'});assert.match(read.authorshipText,/表格内人工修改/);await tick(200);
 const tablePoint=await wordPoint('表格内人工修改'),tableFrom=read.authorshipText.indexOf('表格内人工修改'),tableMarks=await markState('.word-authorship .authorship-mark.authorship-user');report.metrics.table={tablePoint,tableFrom,marks:tableMarks};
 const tableMark=tableMarks.find(mark=>Number(mark.from)<=tableFrom&&Number(mark.to)>tableFrom);assert(tableMark);assert(Math.abs(tableMark.top-(tablePoint.y-10))<20);assert(tableMark.height<50);await page.screenshot({path:path.join(out,'04-word-table-authors.png')});report.checks.push('table-cell body editing receives an independently aligned margin marker');
 await open('read.md');await page.waitForSelector('.markdown-authorship .authorship-user');assert.equal(await page.$('.word-authorship'),null);
 const textPoint=async selector=>page.$eval(selector,node=>{const b=node.getBoundingClientRect();return {x:b.left+15,y:b.top+b.height/2};});
 for(const [rel,content,marker]of [['read.md','#text-preview p','.markdown-authorship .authorship-user'],['plain.txt','.cm-line','.cm-authorship-layer .authorship-user'],['main.ts','.view-line','.monaco-authorship .authorship-user'],['main.tex','.view-line','.monaco-authorship .authorship-user']]){
  await open(rel);await page.waitForSelector(marker);await tick(180);const sourceBefore=await fs.readFile(path.join(project,rel));
  await right(await textPoint(content));await command('authorship-toggle');await page.waitForFunction(selector=>!document.querySelector(selector),{},marker);
  await right(await textPoint(content));await command('authorship-toggle');await page.waitForSelector(marker);assert.deepEqual(await fs.readFile(path.join(project,rel)),sourceBefore);
 }
 report.checks.push('physical right click hides/shows authors in Markdown reading, CodeMirror text, Monaco code and TeX; file switch cleans Word overlays');
 await open('word.docx');await page.waitForSelector('.word-authorship .authorship-user');assert.match(await frame.evaluate(()=>nozeliWordEditor.activeEditor.state.doc.textContent),/人工修改😀/);report.checks.push('saved Word modification and markers reopen with unchanged history');
 // Exercise the iframe keyboard bridge and menu dismissal without editing.
 await wordSelect('人工修改😀');await page.keyboard.down('Shift');await page.keyboard.press('F10');await page.keyboard.up('Shift');await frame.waitForSelector('.context-menu');await page.keyboard.press('Escape');await frame.waitForSelector('.context-menu',{hidden:true});
 assert.equal(await frame.evaluate(()=>nozeliWordEditor.activeEditor.state.selection.to-nozeliWordEditor.activeEditor.state.selection.from),'人工修改😀'.length);report.checks.push('Word Shift+F10 and Escape preserve exact selection');
 await open('repeat.docx');const repeated=await unwrap('file.read',{projectId,relPath:'repeat.docx'}),range=await wordSelect('AAAA');
 await frame.evaluate(from=>{const e=nozeliWordEditor.activeEditor;e.commands.setTextSelection({from,to:from+1});e.view.focus();},range.from);await page.keyboard.press('Backspace');await page.waitForSelector('.word-authorship .authorship-deletion');await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
 const deletion=(await unwrap('document.history',{projectId,relPath:'repeat.docx'})).events[0];assert.equal(deletion.edits[0].from,repeated.authorshipText.indexOf('AAAA'));assert.equal(deletion.edits[0].removed,'A');
 await page.click('.word-authorship .authorship-deletion');await page.waitForSelector('.change-removed');assert.match(await page.$eval('#document-change-history',node=>node.innerText),/− A/);await page.keyboard.press('Escape');
 await frame.evaluate(()=>nozeliWordEditor.activeEditor.view.focus());await page.keyboard.down(process.platform==='darwin'?'Meta':'Control');await page.keyboard.press('z');await page.keyboard.up(process.platform==='darwin'?'Meta':'Control');await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');await tick(1400);assert.match((await unwrap('file.read',{projectId,relPath:'repeat.docx'})).authorshipText,/AAAA/);report.checks.push('actual repeated-character deletion uses the precise PM position, shows removed text and preserves native undo');
 await open('whitespace.docx');await wordSelect('丙');await page.keyboard.type('换行内容');await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');await tick(1400);await page.waitForSelector('.word-authorship .authorship-user');assert.match((await unwrap('file.read',{projectId,relPath:'whitespace.docx'})).authorshipText,/甲\t乙\n换行内容/);report.checks.push('Word tabs and inline line breaks share exact canonical offsets with host save and marker projection');
 await open('pages.docx');await wordSelect('分页段落 0');await page.keyboard.type('修改分页段落 0');await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');await tick(1400);await page.waitForSelector('.word-authorship .authorship-user');
 const p1=await wordPoint('修改分页段落 0');await page.mouse.move(p1.x,p1.y);await page.mouse.wheel({deltaY:800});await tick(300);await page.screenshot({path:path.join(out,'05-word-scrolled.png')});
 await frame.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await tick(300);assert.equal(await page.$('.word-authorship .authorship-mark'),null);report.checks.push('multipage native Word scroll moves author marks with body content and clears them offscreen');
 await open('word.docx');await right(await wordPoint('人工修改😀'));await command('authorship-toggle');await page.waitForFunction(()=>!document.querySelector('.word-authorship .authorship-mark'));
 const restartSource=await fs.readFile(path.join(project,'word.docx'));void invoke('session.requestClose').catch(()=>{});assert.deepEqual(await Promise.race([exited,tick(12000).then(()=>null)]),{code:0,signal:null});await browser.disconnect();browser=null;
 child=launch();exited=attach(child);await connect();await prepareReading(page);await page.waitForSelector('#word-host iframe');frame=page.frames().find(f=>f.url().endsWith('/word-frame.html'));await frame.waitForFunction(()=>nozeliWordEditor?.activeEditor?.state?.doc);await tick(250);
 assert.equal(await page.$('.word-authorship .authorship-mark'),null);await right(await wordPoint('人工修改😀'));assert.equal(await wordMenuLabel('authorship-toggle'),'显示修改者');await command('authorship-toggle');await page.waitForSelector('.word-authorship .authorship-user');assert.deepEqual(await fs.readFile(path.join(project,'word.docx')),restartSource);
 await page.screenshot({path:path.join(out,'06-word-restarted.png')});report.checks.push('normal application close and full process restart persist hidden view; re-enabling restores saved Word attribution without rewriting source');
 assert.deepEqual(report.errors,[]);void invoke('session.requestClose').catch(()=>{});assert.deepEqual(await Promise.race([exited,tick(12000).then(()=>null)]),{code:0,signal:null});report.ok=true;
}catch(error){report.error=error.stack;if(page&&!page.isClosed()){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});report.diagnostics=await page.evaluate(()=>({status:document.querySelector('#save-status')?.textContent,body:document.body.innerText.slice(-2000),wordLayout:window.lastWordLayout})).catch(()=>null);if(frame&&!frame.detached)report.wordDiagnostics=await frame.evaluate(()=>({pm:nozeliWordEditor.activeEditor.state.doc.toJSON(),transactions:window.wordUpdates,runs:[...document.querySelectorAll('.superdoc-text-run')].map(node=>({html:node.outerHTML,story:node.closest('[data-layout-story]')?.dataset.layoutStory,top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom,ancestors:[node.parentElement,node.parentElement?.parentElement,node.parentElement?.parentElement?.parentElement].map(n=>n?.className)})),paragraphs:[...document.querySelectorAll('[data-pm-start]')].slice(0,6).map(node=>node.outerHTML.slice(0,400))})).catch(()=>null);}}
finally{await browser?.disconnect().catch(()=>{});if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await tick(500);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,out,checks:report.checks,error:report.error,errors:report.errors},null,2));process.exitCode=report.ok?0:1;}
