import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';

// Real production consumers, synthetic IPC, manually advanced animation frames.
const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-projection-'));
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
await build({absWorkingDir:root,stdin:{resolveDir:root,contents:String.raw`
import {mountManagedAgent} from './src/renderer/managed-agent-panel.mjs';
import {mountFileNavigator} from './src/renderer/file-navigator.mjs';
const listeners=new Map(),frames=new Map();let frameId=0;
window.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;};
window.cancelAnimationFrame=id=>frames.delete(id);
const flush=()=>{const batch=[...frames.values()];frames.clear();for(const fn of batch)fn();};
window.nozeli={subscribe:(name,fn)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);return()=>{};}};
const emit=(name,event)=>{for(const fn of listeners.get(name)||[])fn(event);};
let project='p',layout={projectId:'p',views:{doc:{id:'doc',kind:'document',relPath:'old.txt'}}};
const calls=[],pending=[],errors=[];let activeReads=0,maxReads=0;
const invoke=async(op,args)=>{
 if(op==='file.availability'){
  calls.push({projectId:args.projectId,paths:args.paths});activeReads++;maxReads=Math.max(maxReads,activeReads);
  return new Promise(resolve=>pending.push(value=>{activeReads--;resolve(value);}));
 }
 if(op==='managed.enable'||op==='managed.status')return {ok:true,value:{enabled:true,ready:true,state}};
 if(op==='managed.history.list')return {ok:true,value:{projectId:args.projectId,items:[],total:0,nextOffset:null,version:'fixture',mode:'offline'}};
 if(op==='managed.draft')return {ok:true,value:{}};
 throw Error('Unexpected fixture IPC '+op);
};
document.documentElement.dataset.workspaceRole='shell';
mountFileNavigator({invoke,projectId:()=>project,open:()=>{},workspaceGroups:()=>({snapshot:()=>layout}),toast:e=>errors.push(e)});
const editorList=document.querySelector('.workspace-open-editor-list');let paints=0;
const observer=new MutationObserver(records=>{paints+=records.filter(r=>r.target===editorList&&r.removedNodes.length>0).length;});observer.observe(editorList,{childList:true});
const state={works:[],jobs:[],requests:[],todos:[],receipts:[],agents:[],drafts:{},timeline:{version:1,entries:[{id:'reply',sequence:1,target:'frontdesk',speaker:'agent',text:'original',durable:true}],deltas:[]}};
window.__workspaceScope={role:'surface',kind:'conversation',projectId:'p',viewState:{conversationInput:{projectId:'p',target:'frontdesk'}}};
const panel=mountManagedAgent({invoke,toast:e=>errors.push(e),onConversation:()=>{},onMessages:()=>{},openManaged:()=>{}});
window.fixture={flush,emit,calls,errors,enable:()=>panel.enable('p'),
 state:update=>{Object.assign(state,update);emit('agent',{projectId:'p',kind:'managed-state',state});},
 change:(relPath,nextProject=project)=>{project=nextProject;layout={projectId:project,views:{doc:{id:'doc',kind:'document',relPath}}};emit('workspace.changed',{});},
 settle:(status='missing')=>{const call=calls[pending.length?calls.length-1:0];const done=pending.shift();if(!done)throw Error('No availability read pending');done({ok:true,value:{entries:call.paths.map(relPath=>({relPath,status}))}});},
 stats:()=>({activeReads,maxReads,paints,pending:pending.length,frames:frames.size}),
 resetPaints:()=>{paints=0;},
};
`},bundle:true,format:'iife',platform:'browser',outfile:path.join(out,'entry.js'),loader:{'.css':'css','.ttf':'file','.woff':'file','.woff2':'file'}});
let html=await fs.readFile(path.join(root,'src/renderer/index.html'),'utf8');
html=html.replace(/<link[^>]+rel="stylesheet"[^>]*>/g,'').replace('<script type="module" src="./app.js"></script>','<script src="./entry.js"></script>');
await fs.writeFile(path.join(out,'index.html'),html);
await fs.writeFile(path.join(out,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.join(out,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(out,'main.cjs'),'--remote-debugging-port='+port,'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland'),'--user-data-dir='+path.join(out,'profile')],{cwd:root,stdio:['ignore','pipe','pipe']});
let browser,log='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
const exited=new Promise(resolve=>child.once('exit',resolve));
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await new Promise(resolve=>setTimeout(resolve,100));}}
 assert(browser,log);const target=await browser.waitForTarget(t=>t.type()==='page'&&t.url().endsWith('/index.html')),page=await target.page();
 const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));await page.waitForFunction(()=>window.fixture);
 await page.evaluate(()=>window.fixture.enable());
 await page.evaluate(()=>{for(let i=0;i<20;i++)fixture.change('old.txt');fixture.flush();});
 assert.equal(await page.evaluate(()=>fixture.calls.length),1,'one availability read for an event burst');
 await page.evaluate(()=>{fixture.resetPaints();for(let i=0;i<20;i++)fixture.change('new.txt');fixture.flush();});
 assert.equal(await page.evaluate(()=>fixture.calls.length),1,'new visual state does not overlap an in-flight read');
 assert.equal(await page.evaluate(()=>fixture.stats().paints),1,'one editor list replacement for an event burst');
 await page.evaluate(()=>fixture.settle('missing'));
 await page.waitForFunction(()=>fixture.calls.length===2);
 assert.equal(await page.$eval('[data-editor-view="doc"]',node=>node.dataset.missing||null),null,'old path response cannot mark reused view id missing');
 await page.evaluate(()=>fixture.settle('unavailable'));
 await page.waitForFunction(()=>document.querySelector('[data-editor-view="doc"]').dataset.missing==='unavailable');
 await page.evaluate(()=>{fixture.change('next.txt','q');fixture.flush();fixture.change('back.txt','p');fixture.flush();});
 assert.equal(await page.evaluate(()=>fixture.stats().activeReads),1);
 await page.evaluate(()=>fixture.settle('missing'));await page.waitForFunction(()=>fixture.calls.length===4);
 assert.equal(await page.$eval('[data-editor-view="doc"]',node=>node.dataset.missing||null),null,'old project generation cannot annotate the returning project');
 await page.evaluate(()=>fixture.settle('present'));await page.waitForFunction(()=>fixture.stats().activeReads===0);
 assert.equal(await page.evaluate(()=>fixture.stats().maxReads),1);
 assert.deepEqual(await page.evaluate(()=>fixture.errors),[]);assert.deepEqual(pageErrors,[]);
 console.log('Renderer projection coalescing: panel publishes immediately; visual bursts coalesce; availability is single-flight and latest-generation safe.');
}finally{
 if(browser)await browser.close().catch(()=>{});
 if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}
}
