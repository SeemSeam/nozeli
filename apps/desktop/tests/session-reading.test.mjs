import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-reading-'));
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`
 import * as reading from './src/renderer/session-reading.mjs';
 import {mountSessionTimeline} from './src/renderer/session-timeline.mjs';
 import {createSessionStore} from './src/renderer/session-store.mjs';
 import {renderTagMarkdown} from './src/renderer/tag-markdown.mjs';
 const store=createSessionStore();store.reset('reading-a');
 const view=mountSessionTimeline(document.querySelector('#timeline'),{store,state:{works:[],receipts:[]},projectId:'reading-a',context:{filePaths:new Set(['term.md'])}});
 view.render({});window.reading={...reading,store,view,renderTagMarkdown};
 `},bundle:true,format:'iife',platform:'browser',outfile:path.join(out,'entry.js'),loader:{'.css':'css','.ttf':'file','.woff':'file','.woff2':'file'}});
await fs.writeFile(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="entry.css"><style>:root{--ink:#263932;--paper:#fdfdfb;--muted:#65766d;--line:#ddd}*{box-sizing:border-box}body{margin:0}#conversation{width:100%;height:100vh;overflow:auto}</style><div id="conversation"><div id="timeline"></div></div><div id="fixture"></div><script src="entry.js"></script>');
await fs.writeFile(path.join(out,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:${process.env.NOZELI_TEST_VISIBLE==='1'},width:390,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.join(out,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(out,'main.cjs'),'--remote-debugging-port='+port,'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland'),'--user-data-dir='+path.join(out,'profile')],{cwd:root,stdio:['ignore','pipe','pipe']});
let log='',browser;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
const exited=new Promise(resolve=>child.once('exit',resolve));
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await new Promise(resolve=>setTimeout(resolve,100));}}
 assert(browser,log);
 const target=await browser.waitForTarget(target=>target.type()==='page'&&target.url().endsWith('/index.html'));const page=await target.page();await page.waitForFunction(()=>window.reading);
 const boundaries=await page.evaluate(()=>{
  const r=window.reading,root=document.querySelector('#fixture');
  const terms=r.normalizeReadingTerms([' term ','term','x'.repeat(81),'',...Array.from({length:100},(_,i)=>'entry'+i)]);
  r.renderTagMarkdown(root,'`term` **term** *term* [term](https://example.com) `term.md`\n\nterm term <img src=x onerror=alert(1)>',{filePaths:new Set(['term.md'])});
  const before=root.textContent;
  r.highlightReadingTerms(root,{enabled:true,terms:['term']});
  const first=[root.querySelectorAll('mark').length,root.querySelector('mark')?.textContent,root.querySelector('mark')?.parentElement.tagName];
  r.highlightReadingTerms(root,{enabled:true,terms:['term']});const idempotent=root.querySelectorAll('mark').length;
  const excluded=document.createElement('div');excluded.innerHTML='<code>blocked</code><pre>blocked</pre><a>blocked</a><strong>blocked</strong><em>blocked</em><mark>blocked</mark><input value="blocked"><textarea>blocked</textarea><div contenteditable>blocked</div><div data-streaming="true">blocked</div><button class="conversation-file-link">blocked</button><p>blocked blocked</p>';root.append(excluded);
  r.highlightReadingTerms(excluded,{enabled:true,terms:['blocked']});
  const skip=[excluded.querySelectorAll('mark[data-session-term]').length,excluded.querySelector('mark[data-session-term]')?.parentElement.tagName];
  r.highlightReadingTerms(root,{enabled:false,terms:['term','blocked']});const preserved=before===root.textContent.slice(0,before.length);
  const stream=document.createElement('p');stream.textContent='term';r.highlightReadingTerms(stream,{enabled:true,terms:['term'],settled:false});
  const storage=new Map(),adapter={getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
  r.saveReadingPreferences(adapter,'one',{enabled:true,terms:['term']});
  return {terms:terms.length,first,idempotent,skip,preserved,unsafe:!!root.querySelector('img,script'),stream:stream.querySelectorAll('mark').length,one:r.loadReadingPreferences(adapter,'one'),two:r.loadReadingPreferences(adapter,'two'),unavailable:r.saveReadingPreferences(null,'one',{terms:[]})};
 });
 assert.equal(boundaries.terms,64);assert.deepEqual(boundaries.first.slice(0,2),[1,'term']);assert.equal(boundaries.idempotent,1);assert.deepEqual(boundaries.skip,[1,'P']);assert(boundaries.preserved);assert.equal(boundaries.unsafe,false);assert.equal(boundaries.stream,0);assert.deepEqual(boundaries.one,{enabled:true,terms:['term']});assert.deepEqual(boundaries.two,{enabled:false,terms:[]});assert.equal(boundaries.unavailable,false);
 const deferred=await page.evaluate(()=>{
  const root=document.querySelector('#fixture');root.textContent='selected term';const scheduler=window.reading.createReadingScheduler(root),node=root.firstChild,selection=getSelection(),range=document.createRange();range.selectNodeContents(node);selection.removeAllRanges();selection.addRange(range);
  scheduler.update(()=>root.textContent='changed');const same=root.firstChild===node&&selection.toString()==='selected term';selection.removeAllRanges();document.dispatchEvent(new Event('selectionchange'));const resumed=root.textContent==='changed';
  document.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));scheduler.update(()=>root.textContent='stale');scheduler.update(()=>root.textContent='latest');const during=root.textContent;document.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));const after=root.textContent;scheduler.dispose();return {same,resumed,during,after};
 });
 assert.deepEqual(deferred,{same:true,resumed:true,during:'changed',after:'latest'});
 await page.evaluate(()=>{document.querySelector('#fixture').replaceChildren();const r=window.reading;r.store.apply('reading-a',{version:1,entries:[{id:'m1',speaker:'agent',target:'frontdesk',source:'native',sequence:1,text:'Mercury Mercury'},{id:'m2',speaker:'agent',target:'frontdesk',source:'native',sequence:2,text:'Mercury Mercury'}],deltas:[]});});
 await page.waitForSelector('[data-message="m2"]');assert.equal(await page.$$eval('.session-term',nodes=>nodes.length),0);
 await page.click('.session-reading summary');await page.type('.session-reading textarea','Mercury');await page.$$eval('.session-reading button',nodes=>nodes.find(node=>node.textContent==='保存术语').click());await page.click('.session-reading input');await page.waitForFunction(()=>document.querySelectorAll('.session-term').length===2);
 assert.deepEqual(await page.$$eval('[data-message]',nodes=>nodes.map(node=>node.querySelectorAll('.session-term').length)),[1,1]);
 const mountedSelection=await page.evaluate(async()=>{
  const body=document.querySelector('[data-message="m1"] .session-markdown'),node=body.firstChild,selection=getSelection(),range=document.createRange();range.selectNodeContents(body);selection.removeAllRanges();selection.addRange(range);document.querySelector('.session-reading input').click();await new Promise(resolve=>requestAnimationFrame(resolve));const preserved=body.firstChild===node&&selection.toString()==='Mercury Mercury';selection.removeAllRanges();document.dispatchEvent(new Event('selectionchange'));return preserved;
 });
 assert.equal(mountedSelection,true);await page.waitForFunction(()=>document.querySelectorAll('.session-term').length===0);
 await page.evaluate(async()=>{document.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));document.querySelector('.session-reading input').click();await new Promise(resolve=>requestAnimationFrame(resolve));});
 assert.equal(await page.$$eval('.session-term',nodes=>nodes.length),0);await page.evaluate(()=>document.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));await page.waitForFunction(()=>document.querySelectorAll('.session-term').length===2);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.evaluate(()=>window.reading.view.render({projectId:'reading-b'}));await page.waitForFunction(()=>document.querySelector('.session-reading textarea').value==='');assert.equal(await page.$$eval('.session-term',nodes=>nodes.length),0);
 await page.evaluate(()=>window.reading.view.render({projectId:'reading-a'}));await page.waitForFunction(()=>document.querySelectorAll('.session-term').length===2);
 await page.click('.session-reading summary');await page.$$eval('.session-reading button',nodes=>nodes.find(node=>node.textContent==='清除术语与高亮').click());await page.waitForFunction(()=>document.querySelectorAll('.session-term').length===0);
 console.log('session reading: explicit project controls, safe first occurrence, selection / IME, persistence and narrow layout passed');
}finally{if(browser)await browser.close().catch(()=>{});if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}await fs.rm(out,{recursive:true,force:true});}
