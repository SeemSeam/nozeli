import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';

const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-frozen-files-'));
const report={out,scope:'renderer-component-only: actual Electron BrowserWindow with production timeline/FrozenFiles and synthetic changes.list DTOs; not production host/WCV, real Worker execution, Git provenance, or model evidence.',states:[],screenshots:[],modelRequests:0};
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`
 import {mountSessionTimeline} from './src/renderer/session-timeline.mjs';
 import {createSessionStore} from './src/renderer/session-store.mjs';
 import './src/renderer/conversation-rendering.css';
 import './src/renderer/settings-appearance.css';
 const store=createSessionStore();store.reset('fixture-project-a');
 const state={works:[{id:'fixture-worker',name:'冻结清单状态精准fixture'}],receipts:[]},calls=[],pending=new Map();
 let projectId='fixture-project-a';
 const call=(op,args)=>{
  if(op!=='changes.list')throw Error('Unexpected fixture request '+op);
  calls.push({op,args,projectId});
  return new Promise((resolve,reject)=>pending.set(args.changeSetId+':'+args.offset,{resolve,reject}));
 };
 const view=mountSessionTimeline(document.querySelector('#timeline'),{store,state,projectId,call,navigationContainer:document.querySelector('.session-navigation-slot'),context:{},onPage:()=>{},onLatest:()=>{}});
 store.apply(projectId,{version:1,entries:[{id:'fixture-entry',speaker:'agent',target:'fixture-worker',workId:'fixture-worker',jobId:'fixture-job',revision:1,sequence:1,text:'仅组件fixture，不执行Worker。'}],deltas:[]});
 const boundary=(changeSetId,nextProject=projectId)=>{projectId=nextProject;state.receipts=[{id:'stable-receipt',workId:'fixture-worker',jobId:'fixture-job',revision:1,changeSetId}];view.render({state:{...state},projectId});};
 const settle=(changeSetId,offset,result,error)=>{const key=changeSetId+':'+offset,request=pending.get(key);if(!request)throw Error('No pending fixture request '+key);pending.delete(key);if(error)request.reject(Error(error));else request.resolve(result);};
 window.frozenFixture={boundary,settle,calls};boundary('initial-failure');
 `},bundle:true,format:'iife',platform:'browser',outfile:path.join(out,'entry.js'),loader:{'.css':'css','.ttf':'file','.woff':'file','.woff2':'file'}});
await fs.writeFile(path.join(out,'index.html'),'<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="entry.css"><style>*{box-sizing:border-box}body{margin:0;background:var(--paper);height:100vh;display:flex;flex-direction:column}aside{padding:12px;font:12px system-ui}#conversation{flex:1;min-height:0;overflow:auto}.session-navigation-slot{flex:none}</style><body class="session-surface"><aside>renderer-component-only · 冻结清单状态fixture · 非真实Worker / Git / 模型证据</aside><div id="conversation"><div id="timeline"></div></div><div class="session-navigation-slot"></div><script src="entry.js"></script></body></html>');
await fs.writeFile(path.join(out,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:${process.env.NOZELI_TEST_VISIBLE==='1'},width:680,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.join(out,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(out,'main.cjs'),'--remote-debugging-port='+port,'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland'),'--user-data-dir='+path.join(out,'profile')],{cwd:root,stdio:['ignore','pipe','pipe']});
let log='',browser;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
const exited=new Promise(resolve=>child.once('exit',resolve));
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await new Promise(resolve=>setTimeout(resolve,100));}}
 assert(browser,log);
 const target=await browser.waitForTarget(target=>target.type()==='page'&&target.url().endsWith('/index.html')),page=await target.page();
 await page.waitForFunction(()=>window.frozenFixture?.calls.length===1);
 const region='.session-frozen-files',alert=region+' [role="alert"]',status=region+' [role="status"]',nav=region+' nav';
 const snapshot=()=>page.$eval(region,node=>({title:node.querySelector('h4').textContent,files:[...node.querySelectorAll('[data-frozen-file]')].map(n=>n.dataset.frozenFile),error:node.querySelector('[role="alert"]')?.textContent??null,loading:!!node.querySelector('[role="status"]'),pagination:node.querySelector('nav').textContent}));
 const settle=(id,offset,result,error)=>page.evaluate(({id,offset,result,error})=>window.frozenFixture.settle(id,offset,result,error),{id,offset,result,error});
 const boundary=async(id,project)=>{const before=await page.evaluate(()=>window.frozenFixture.calls.length);await page.evaluate(({id,project})=>window.frozenFixture.boundary(id,project),{id,project});await page.waitForFunction(({id,before})=>window.frozenFixture.calls.length===before+1&&window.frozenFixture.calls.at(-1).args.changeSetId===id,{}, {id,before});await page.waitForSelector(status);const s=await snapshot();assert.match(s.title,/文件数量未知/);assert.doesNotMatch(s.title,/\d+ 个文件/);assert.deepEqual(s.files,[]);assert.equal(s.pagination,'');return s;};
 const capture=async name=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const screenshot='renderer-component-only-frozen-files-'+name+'.png';await page.screenshot({path:path.join(out,screenshot)});report.screenshots.push(screenshot);report.states.push({name,...await snapshot()});};
 await settle('initial-failure',0,null,'fixture: 冻结清单首次读取失败');await page.waitForSelector(alert);
 let s=await snapshot();assert.match(s.title,/文件数量未知/);assert.doesNotMatch(s.title,/0 个文件/);assert.deepEqual(s.files,[]);await capture('initial-failed');
 await page.click(alert+' button');await page.waitForSelector(status);assert.equal(await page.evaluate(()=>window.frozenFixture.calls.at(-1).args.offset),0);
 await settle('initial-failure',0,{files:[],total:0,nextOffset:null});await page.waitForFunction(()=>!document.querySelector('.session-frozen-files [role="status"]'));
 s=await snapshot();assert.match(s.title,/0 个文件/);assert.equal(s.error,null);assert.deepEqual(s.files,[]);await capture('successful-empty');
 await boundary('paged');
 // The first page has the protocol's full 100 entries. Only its compact error snapshot is captured below.
 const first=Array.from({length:100},(_,i)=>({fileId:'file-'+i,path:'fixture/source-'+i+'.md',status:'modified',added:1,deleted:0}));
 await settle('paged',0,{files:first,total:101,nextOffset:100});await page.waitForSelector('[data-frozen-file="file-99"]');
 s=await snapshot();assert.match(s.title,/101 个文件/);assert.equal(s.files.length,100);
 await page.click(nav+' button');await page.waitForSelector(status);s=await snapshot();assert.equal(s.files.length,100);assert.match(s.title,/101 个文件/);
 await settle('paged',100,null,'fixture: 冻结清单翻页读取失败');await page.waitForSelector(alert);
 s=await snapshot();assert.deepEqual(s.files,first.map(f=>f.fileId));assert.match(s.title,/101 个文件/);assert.match(s.pagination,/第 1–100 \/ 101 个文件/);
 // Preserve all 100 DOM entries but bound the list visually so the title, retained files and error share one screenshot.
 await page.addStyleTag({content:'.session-frozen-files ul{max-height:340px;overflow:auto}'});
 report.presentation='Page-failure and retry screenshots bound the fixture list to 340px with internal scrolling; all 100 retained file buttons remain in DOM and are asserted. This is fixture-only presentation, not production viewport/layout evidence.';
 await page.$eval(region,node=>node.scrollIntoView({block:'start'}));await capture('page-failed-retained');
 await page.click(alert+' button');await page.waitForSelector(status);
 assert.deepEqual(await page.evaluate(()=>window.frozenFixture.calls.filter(c=>c.args.changeSetId==='paged').map(c=>c.args.offset)),[0,100,100],'Retry targets the failed page, not the retained successful page');
 s=await snapshot();assert.equal(s.files.length,100);assert.match(s.title,/101 个文件/);
 await settle('paged',100,{files:[{fileId:'file-100',path:'fixture/source-100.md',status:'added',added:2,deleted:0}],total:101,nextOffset:null});
 await page.waitForSelector('[data-frozen-file="file-100"]');s=await snapshot();assert.deepEqual(s.files,['file-100']);assert.match(s.pagination,/第 101–101 \/ 101 个文件/);assert.equal(s.error,null);await capture('retry-succeeded');
 // Previous-page failures must likewise retry offset 0 while keeping the last successful offset 100.
 await page.click(nav+' button');await page.waitForSelector(status);await settle('paged',0,null,'fixture: 上一页读取失败');await page.waitForSelector(alert);
 s=await snapshot();assert.deepEqual(s.files,['file-100']);assert.match(s.title,/101 个文件/);await page.click(alert+' button');await page.waitForSelector(status);
 assert.equal(await page.evaluate(()=>window.frozenFixture.calls.at(-1).args.offset),0);
 // Reusing the same receipt must reset counts/files and ignore an old request resolved after a changeset switch.
 report.changeSetReset=await boundary('next-set');await settle('paged',0,{files:first,total:101,nextOffset:100});
 await settle('next-set',0,null,'fixture: 新变更集读取失败');await page.waitForSelector(alert);s=await snapshot();assert.match(s.title,/文件数量未知/);assert.deepEqual(s.files,[]);
 await page.click(alert+' button');await page.waitForSelector(status);await settle('next-set',0,{files:[],total:0,nextOffset:null});await page.waitForFunction(()=>!document.querySelector('.session-frozen-files [role="status"]'));
 // Same changeset, new project: known zero must not cross the project boundary either.
 report.projectReset=await boundary('next-set','fixture-project-b');await settle('next-set',0,null,'fixture: 新项目读取失败');await page.waitForSelector(alert);s=await snapshot();assert.match(s.title,/文件数量未知/);assert.deepEqual(s.files,[]);
 report.calls=await page.evaluate(()=>window.frozenFixture.calls);report.ok=true;console.log(JSON.stringify(report,null,2));
}catch(error){report.failure=error.stack;throw error;}finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'main.log'),log);if(browser)await browser.close().catch(()=>{});if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}}
