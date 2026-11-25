import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {copyFile,mkdir,mkdtemp} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {prepareReading,waitForDesktopPage} from './reading-setup.fixture.mjs';

const root=path.resolve(import.meta.dirname,'..'),out=await mkdtemp(path.join(os.tmpdir(),'nozeli-pdf-wheel-'));
const config=path.join(out,'config'),profile=path.join(config,'desktop'),project=path.join(out,'project');
await mkdir(project);
await copyFile(path.join(root,'tests/fixtures/pdf/nozeli-sample.zh.pdf'),path.join(project,'sample.pdf'));
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;await host.storage.db.close();
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key==='XAUTHORITY'||!/(?:NOZELI|CCB|API_KEY|AUTH|TOKEN|SECRET|PASSWORD)/i.test(key)));
const binary=process.env.NOZELI_TEST_BINARY;
const child=spawn(binary||createRequire(import.meta.url)('electron'),[...(binary?[]:[path.join(root,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||'x11')],{cwd:root,env:{...env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port)},stdio:['ignore','ignore','pipe']});
const exited=new Promise(resolve=>child.once('exit',resolve));let log='',browser;child.stderr.on('data',bytes=>log+=bytes);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 for(let i=0;i<150&&!browser;i++){assert.equal(child.exitCode,null,log);browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null);if(!browser)await pause(100);}
 assert(browser,log);const shell=await waitForDesktopPage(browser);await prepareReading(shell);await shell.click(`[data-project-id="${projectId}"]`);
 await shell.waitForSelector('#file-tree [data-path="sample.pdf"]',{visible:true});await shell.click('#file-tree [data-path="sample.pdf"]');
 let pdf;for(let i=0;i<100&&!pdf;i++){for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.relPath==='sample.pdf').catch(()=>false))pdf=p;if(!pdf)await pause(100);}
 assert(pdf);const errors=[];pdf.on('pageerror',error=>errors.push(error.message));
 const scroller='#reader-scroll',read=()=>pdf.$eval(scroller,n=>({top:n.scrollTop,bottom:n.scrollHeight-n.clientHeight,height:n.clientHeight,page:Number(document.querySelector('#pdf-page').value)}));
 const page=number=>pdf.waitForFunction(n=>document.querySelector('#pdf-page')?.value===String(n)&&Boolean(document.querySelector(`.pdf-page[data-page="${n}"] .textLayer span`)),{timeout:10000},number);
 await page(1);assert(await pdf.$eval('#pdf-prev',n=>n.disabled));
 const box=await pdf.$eval(scroller,n=>n.getBoundingClientRect().toJSON());await pdf.mouse.move(box.left+box.width/2,box.top+box.height/2);
 assert((await read()).bottom>100,'fixture has a scrollable first page');
 await pdf.mouse.wheel({deltaY:70});await pdf.waitForFunction(()=>document.querySelector('#reader-scroll').scrollTop>0);assert.equal((await read()).page,1);
 await pdf.mouse.wheel({deltaY:10000});await pdf.waitForFunction(()=>{const n=document.querySelector('#reader-scroll');return n.scrollHeight-n.clientHeight-n.scrollTop<=1;});assert.equal((await read()).page,1);
 await pdf.mouse.wheel({deltaY:120});await page(2);assert.equal((await read()).top,0);
 await pause(400);await pdf.mouse.wheel({deltaY:-120});await page(1);const back=await read();assert(Math.abs(back.top-back.bottom)<=1,'reverse paging lands at the previous page bottom');
 await pdf.locator('#pdf-page').fill('3');await pdf.focus('#pdf-page');await pdf.keyboard.press('Enter');await page(3);assert.equal((await read()).top,0);assert(await pdf.$eval('#pdf-next',n=>n.disabled));
 await pdf.mouse.move(box.left+box.width/2,box.top+box.height/2);await pdf.mouse.wheel({deltaY:10000});await pdf.mouse.wheel({deltaY:120});assert.equal((await read()).page,3);
 await pdf.click('#pdf-prev');await page(2);assert.equal((await read()).top,0);
 await pdf.click('#pdf-next');await page(3);assert.equal((await read()).top,0);
 assert.deepEqual(errors,[]);await pdf.screenshot({path:path.join(out,'pdf-reader.png')});
 await shell.evaluate(()=>nozeli.invoke('session.requestClose'));assert.equal(await Promise.race([exited,pause(8000).then(()=>null)]),0);
 console.log('PASS: native PDF wheel, page-edge navigation, page-number jump and document bounds; '+out);
}finally{await browser?.disconnect();if(child.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await exited;}}
