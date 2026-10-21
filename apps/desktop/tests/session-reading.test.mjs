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
 const deferred=await page.evaluate(()=>{
  const root=document.querySelector('#fixture');root.textContent='selected term';const scheduler=window.reading.createReadingScheduler(root),node=root.firstChild,selection=getSelection(),range=document.createRange();range.selectNodeContents(node);selection.removeAllRanges();selection.addRange(range);
  scheduler.update(()=>root.textContent='changed');const same=root.firstChild===node&&selection.toString()==='selected term';selection.removeAllRanges();document.dispatchEvent(new Event('selectionchange'));const resumed=root.textContent==='changed';
  document.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));scheduler.update(()=>root.textContent='stale');scheduler.update(()=>root.textContent='latest');const during=root.textContent;document.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));const after=root.textContent;scheduler.dispose();return {same,resumed,during,after};
 });
 assert.deepEqual(deferred,{same:true,resumed:true,during:'changed',after:'latest'});
 await page.evaluate(()=>{document.querySelector('#fixture').replaceChildren();const r=window.reading;r.store.apply('reading-a',{version:1,entries:[{id:'m1',speaker:'agent',target:'frontdesk',source:'native',sequence:1,text:'Mercury Mercury'},{id:'m2',speaker:'agent',target:'frontdesk',source:'native',sequence:2,text:'Mercury Mercury'}],deltas:[]});});
 await page.waitForSelector('[data-message="m2"]');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.evaluate(()=>window.reading.store.apply('reading-a',{version:1,entries:[{id:'readable-user',speaker:'user',target:'frontdesk',sequence:3,text:'请围绕人的主体性重新设计README。',materialSources:[{annotationId:'tag-1',relPath:'README.md',location:'第16–21行',materialDigest:'frozen-origin',quote:'人可以以任何粒度介入工作。'}]}],deltas:[]}));
 await page.waitForSelector('[data-message="readable-user"]');
 assert.equal(await page.$eval('[data-message="readable-user"] .agent-message-body',node=>node.textContent.trim()),'请围绕人的主体性重新设计README。');
 assert.equal(await page.$eval('[data-message="readable-user"]',node=>node.textContent.includes('人可以以任何粒度介入工作。')),false);
 await page.click('[data-message="readable-user"] .session-tool summary');await page.waitForFunction(()=>document.querySelector('[data-message="readable-user"]').textContent.includes('人可以以任何粒度介入工作。'));
 assert(await page.$eval('[data-message="readable-user"]',node=>node.textContent.includes('README.md')&&node.textContent.includes('frozen-origin')));
 console.log('session Markdown: selection / IME protection, readable messages and frozen material sources passed');
}finally{if(browser)await browser.close().catch(()=>{});if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}await fs.rm(out,{recursive:true,force:true});}
