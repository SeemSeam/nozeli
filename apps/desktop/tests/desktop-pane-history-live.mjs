// Real Electron pane-local file history, isolated synthetic files; no model input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
const source=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-pane-history-'));
const project=path.join(out,'Project'),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop');await fs.mkdir(project);
const originals=Object.fromEntries(['a.txt','b.txt','c.txt','d.txt'].map(name=>[name,'File '+name+'\nKeep original bytes\n']));
for(const [name,text]of Object.entries(originals))await fs.writeFile(path.join(project,name),text);
const projectId=(await new DesktopHost(profile).pick(project)).project.id;
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
const report={out,checks:[],errors:[]};let child,browser,shell,log='';const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+45000;do{const value=await fn();if(value)return value;if(child&&child.exitCode!==null)throw Error('Application exited: '+log);await pause(40);}while(Date.now()<end);throw Error('Timeout: '+label);}
async function call(page,op,payload={}){const r=await page.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function scoped(test){return until(async()=>{for(const page of await browser.pages()){const scope=await page.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&test(scope)&&await page.evaluate(()=>__nozeliReady))return {page,scope};}},'registered ready content');}
const snapshot=async()=>(await call(shell,'workspace.snapshot',{projectId})).layout;
async function open(name){await shell.locator('#file-tree [data-path="'+name+'"]').click();return scoped(s=>s.kind==='document'&&s.relPath===name&&!s.readOnly);}
async function current(groupId,name){return until(async()=>{const layout=await snapshot();const find=n=>n?.kind==='group'?(n.id===groupId?n:null):n?.kind==='split'?(find(n.first)||find(n.second)):null;const group=find(layout.mainRoot)||layout.detached.map(w=>find(w.root)).find(Boolean),view=layout.views[group?.activeViewId];return view?.relPath===name?view:false;},'pane restores '+name);}
async function closeFile(root,groupId){await root.locator('[data-workspace-group="'+groupId+'"] [data-workspace-command="close"]').click();}
function launch(){const binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(source,'src/main/main.cjs')]),'--ozone-platform=wayland'],{cwd:source,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);}
async function connect(){await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'debug endpoint');shell=(await scoped(s=>s.role==='shell')).page;shell.on('pageerror',error=>report.errors.push(error.message));}
try{
 launch();await connect();
 if(await shell.$eval('#configuration-setup',n=>n.open))await shell.click('#configuration-cancel');await shell.waitForSelector('#file-tree [data-path="a.txt"]',{visible:true});
 const firstGroup=(await snapshot()).mainRoot.id;
 const a=await open('a.txt');await a.page.evaluate(()=>__nozeliInput.select(3,7));await open('b.txt');await open('c.txt');
 await closeFile(shell,firstGroup);await current(firstGroup,'b.txt');const b=await scoped(s=>s.kind==='document'&&s.relPath==='b.txt');assert.equal(await b.page.evaluate(()=>__nozeliInput.text()),originals['b.txt']);
 await closeFile(shell,firstGroup);await current(firstGroup,'a.txt');const restoredA=await scoped(s=>s.kind==='document'&&s.relPath==='a.txt');assert.equal(await restoredA.page.evaluate(()=>__nozeliInput.text()),originals['a.txt']);assert.deepEqual(await restoredA.page.evaluate(()=>__nozeliInput.selection()),{anchor:3,head:7,from:3,to:7});
 report.checks.push('A→B→C title close restores B then A in the same pane with exact text and prior selection');
 await open('b.txt');await open('a.txt');await closeFile(shell,firstGroup);await current(firstGroup,'b.txt');report.checks.push('revisiting A after B deduplicates history; closing A returns B');
 const beforeSplit=await snapshot();await call(shell,'workspace.command',{projectId,expectedRevision:beforeSplit.revision,requestKey:crypto.randomUUID(),command:{type:'split',groupId:firstGroup,axis:'x',side:'after'}});
 const split=await snapshot(),other=split.mainRoot.second.id;await shell.locator('[data-workspace-group="'+other+'"] .workspace-pane-title').click();await open('c.txt');await open('d.txt');
 await closeFile(shell,other);await current(other,'c.txt');await current(firstGroup,'b.txt');report.checks.push('a second pane has its own C→D stack; closing D leaves first pane B untouched');
 await shell.locator('[data-workspace-group="'+firstGroup+'"] .workspace-pane-title').click();await shell.click('#workspace-open-conversation');const chat=await scoped(s=>s.kind==='conversation');await chat.page.waitForFunction(()=>!document.querySelector('#composer').disabled);await chat.page.locator('#composer').fill('Unsent history smoke draft');
 await chat.page.locator('[data-chat-window-action="chat-workspace-close"]').click();await current(firstGroup,'b.txt');await shell.waitForSelector('#workspace-open-conversation.conversation-minimized',{visible:true});await shell.click('#workspace-open-conversation');const chatRestored=await scoped(s=>s.kind==='conversation'&&s.viewId===chat.scope.viewId);await chatRestored.page.waitForFunction(()=>document.querySelector('#composer').value==='Unsent history smoke draft');
 report.checks.push('conversation minimize restores that pane previous file; unique conversation and unsent draft reopen intact');
 await chatRestored.page.locator('[data-chat-window-action="chat-workspace-close"]').click();await current(firstGroup,'b.txt');
 const bId=Object.values((await snapshot()).views).find(v=>v.relPath==='b.txt'&&!v.readOnly).id;await shell.locator('#workspace-open-editors [data-editor-view="'+bId+'"]').click({button:'right'});await shell.locator('#navigator-editor-menu:not([hidden]) [data-command="float"]').click();
 const floating=await scoped(s=>s.role==='detached');const floatGroup=(await snapshot()).detached.find(w=>w.id===floating.scope.windowId).root.id;
 for(const name of ['a.txt','d.txt']){const l=await snapshot();await call(floating.page,'workspace.command',{projectId,expectedRevision:l.revision,requestKey:crypto.randomUUID(),command:{type:'open',groupId:floatGroup,view:{kind:'document',relPath:name}}});await current(floatGroup,name);await scoped(s=>s.kind==='document'&&s.relPath===name);}
 const floatClose=async()=>{await floating.page.locator('.workspace-pane-title').click({button:'right'});await floating.page.locator('#workspace-title-menu:not([hidden]) [data-command="closeContentView"]').click();};
 await floatClose();await current(floatGroup,'a.txt');await floatClose();await current(floatGroup,'b.txt');await current(other,'c.txt');report.checks.push('independent native window D→A→B file close restores its own stack without changing main pane C');
 for(const name of ['a.txt','d.txt']){const l=await snapshot();await call(floating.page,'workspace.command',{projectId,expectedRevision:l.revision,requestKey:crypto.randomUUID(),command:{type:'open',groupId:floatGroup,view:{kind:'document',relPath:name}}});await current(floatGroup,name);await scoped(s=>s.kind==='document'&&s.relPath===name);}
 const coldBefore=(await snapshot()).detached.find(w=>w.id===floating.scope.windowId).root;
 const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;await browser.disconnect();browser=null;launch();await connect();
 if(await shell.$eval('#configuration-setup',n=>n.open))await shell.click('#configuration-cancel');await shell.locator('#recent [data-project-id="'+projectId+'"]').click();
 const coldFloat=await scoped(s=>s.role==='detached'&&s.windowId===floating.scope.windowId);await current(floatGroup,'d.txt');
 assert.deepEqual((await snapshot()).detached.find(w=>w.id===floating.scope.windowId).root,coldBefore);
 for(const name of ['a.txt','b.txt']){await coldFloat.page.locator('.workspace-pane-title').click({button:'right'});await coldFloat.page.locator('#workspace-title-menu:not([hidden]) [data-command="closeContentView"]').click();await current(floatGroup,name);const doc=await scoped(s=>s.kind==='document'&&s.relPath===name);assert.equal(await doc.page.evaluate(()=>__nozeliInput.text()),originals[name]);}
 report.checks.push('cold native restart retains the floating pane stack and restores D→A→B with original file bytes');
 for(const [name,text]of Object.entries(originals))assert.equal(await fs.readFile(path.join(project,name),'utf8'),text);assert.deepEqual(report.errors,[]);report.ok=true;console.log(JSON.stringify(report,null,2));
}catch(error){report.failure=error.stack;console.error(JSON.stringify(report,null,2));throw error;}
finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'main.log'),log);await browser?.disconnect();if(child&&child.exitCode===null){child.kill('SIGTERM');await pause(600);if(child.exitCode===null)child.kill('SIGKILL');}}
