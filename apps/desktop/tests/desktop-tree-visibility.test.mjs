import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
const appRoot=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-tree-visibility-')),root=path.join(out,'.Nozeli'),project=path.join(out,'project');
await fs.mkdir(path.join(project,'bulk'),{recursive:true});await fs.mkdir(path.join(project,'notes'));
await Promise.all(Array.from({length:2050},(_,i)=>fs.writeFile(path.join(project,'bulk',String(i).padStart(4,'0')+'.txt'),'bulk')));
await fs.writeFile(path.join(project,'notes','keep.txt'),'Keep this material');
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(appRoot,'src/main/main.cjs'),'--ozone-platform=wayland'],{cwd:appRoot,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:root,NOZELI_USER_DATA:path.join(root,'desktop'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'},stdio:['ignore','pipe','pipe']});
let log='',browser,page;for(const s of [child.stdout,child.stderr])s.on('data',c=>log+=c);const exited=new Promise(r=>child.once('exit',r)),pause=ms=>new Promise(r=>setTimeout(r,ms));
const sel=rel=>'#file-tree button[data-path="'+rel+'"]';let checks=0;
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await pause(100);}}
 page=await(await browser.waitForTarget(t=>t.type()==='page'&&t.url().startsWith('http://127.0.0.1:'),{timeout:90000})).page();await page.waitForFunction(()=>window.__nozeliReady);await page.waitForSelector('#configuration-setup[open]');await page.click('#configuration-cancel');await page.click('#pick-project');await page.waitForSelector(sel('bulk'));await page.waitForSelector(sel('notes/keep.txt'));
 await page.click(sel('notes/keep.txt'));await page.waitForFunction(()=>window.__nozeliInput?.text()==='Keep this material');await page.waitForSelector('#save-status[data-state="saved"]');checks++;
 const menu=async(rel,command)=>{await page.locator(sel(rel)).click({button:'right'});await page.waitForSelector('#file-tree-menu:not([hidden])');await page.locator('#file-tree-menu [data-command="'+command+'"]').click();};
 await menu('bulk','hide');await page.waitForFunction(()=>!document.querySelector('#file-tree button[data-path="bulk"]'));checks++;
 assert.equal(await page.$eval('#file-tree',e=>e.querySelectorAll('button[data-path]').length),2);assert.equal(await fs.readFile(path.join(project,'bulk','2049.txt'),'utf8'),'bulk');checks++;
 await menu('notes/keep.txt','hide');await page.waitForFunction(()=>!document.querySelector('#file-tree button[data-path="notes/keep.txt"]'));assert.equal(await page.evaluate(()=>window.__nozeliInput.text()),'Keep this material');checks++;
 await page.click('#file-tree-more');await page.click('#file-tree-menu [data-command="toggleHidden"]');await page.waitForSelector(sel('bulk'));await page.waitForSelector(sel('notes/keep.txt'));
 assert.equal(await page.$eval(sel('bulk'),e=>e.dataset.hiddenRoot),'true');assert.equal(await page.$eval(sel('notes/keep.txt'),e=>e.classList.contains('tree-hidden-item')),true);checks++;
 await page.screenshot({path:path.join(out,'hidden-inspection.png')});
 await page.reload();await page.waitForFunction(()=>window.__nozeliReady);if(await page.$eval('#configuration-setup',e=>e.open))await page.click('#configuration-cancel');await page.waitForSelector(sel('notes/keep.txt'));assert.equal(await page.$eval(sel('notes/keep.txt'),e=>e.dataset.hiddenRoot),'true');checks++;
 await menu('notes/keep.txt','unhide');await page.waitForFunction(()=>document.querySelector('#file-tree button[data-path="notes/keep.txt"]')?.dataset.hiddenRoot==='false');checks++;
 await page.click('#file-tree-more');await page.click('#file-tree-menu [data-command="toggleHidden"]');await page.waitForFunction(()=>!document.querySelector('#file-tree button[data-path="bulk"]'));assert(await page.$(sel('notes/keep.txt')));checks++;
 console.log(JSON.stringify({checks,out,scope:'real Electron right-click, 2050 real files, no model requests'}));
}catch(e){console.error(log,out);await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw e;}
finally{if(page&&!page.isClosed())await Promise.race([page.evaluate(()=>nozeli.invoke('session.requestClose',{})).catch(()=>{}),pause(2000)]);await Promise.race([exited,pause(5000)]);if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}await browser?.disconnect();await fs.writeFile(path.join(out,'electron.log'),log);}
