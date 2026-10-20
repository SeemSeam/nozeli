import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {prepareReading,waitForDesktopPage} from './reading-setup.fixture.mjs';

// Real root renderer and native host, using an already built renderer. No model calls.
const root=path.resolve(import.meta.dirname,'..'),output=await mkdtemp(path.join(os.tmpdir(),'workspace-management-')),project=path.join(output,'project');
for(const parent of ['north','south']){await mkdir(path.join(project,parent),{recursive:true});await writeFile(path.join(project,parent,'same.txt'),parent+' document\n');}
await writeFile(path.join(project,'last.txt'),'last document\n');
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const ozone=process.env.NOZELI_OZONE||'wayland',child=spawn(createRequire(import.meta.url)('electron'),['--ozone-platform='+ozone,path.join(root,'src/main/main.cjs')],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_PICK:project,NOZELI_CONFIG_ROOT:path.join(output,'.Nozeli'),NOZELI_USER_DATA:path.join(output,'.Nozeli','desktop'),NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1',NOZELI_OZONE:ozone},stdio:['ignore','pipe','pipe']});
let browser,log='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
const row=id=>'#workspace-open-editors [data-editor-view="'+id+'"]';
try{
 for(let attempt=0;attempt<150;attempt++){try{browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert(browser,log);
 const page=await waitForDesktopPage(browser),errors=[];page.on('pageerror',error=>errors.push(error.message));await prepareReading(page);await page.click('#pick-project');await page.waitForFunction(()=>window.__workspaceGroups?.snapshot()?.projectId);
 await page.waitForSelector('#file-tree [data-path="north"]',{visible:true});
 await page.evaluate(async()=>{await window.__workspaceGroups.command({type:'preset',windowId:'main',preset:'single'});for(const relPath of ['north/same.txt','south/same.txt'])await window.__workspaceGroups.open({kind:'document',relPath});});
 const views=await page.evaluate(()=>Object.values(window.__workspaceGroups.snapshot().views));const north=views.find(v=>v.relPath==='north/same.txt').id,south=views.find(v=>v.relPath==='south/same.txt').id;
 await page.waitForSelector(row(north));await page.waitForSelector(row(south));assert.match(await page.$eval(row(north),n=>n.textContent),/same\.txt.*north/);assert.match(await page.$eval(row(south),n=>n.textContent),/same\.txt.*south/);
 async function context(id,key){await page.click(row(id),{button:'right'});const selector='.nozeli-context-menu:not([hidden]) [data-command="'+key+'"]';await page.waitForSelector(selector);await page.click(selector);}
 async function layoutMenu(){if(!await page.$eval('#workspace-layout-menu',n=>n.open))await page.click('#workspace-layout-menu summary');await page.waitForSelector('#workspace-layout-menu[open]');}
 async function rootCommand(key){await layoutMenu();await page.click('#workspace-layout-menu [data-workspace-command="'+key+'"]');}
 async function name(value){await page.waitForSelector('.workspace-name-dialog[open]');await page.$eval('.workspace-name-dialog input',(n,value)=>{n.value=value;},value);await page.click('.workspace-name-dialog button[type="submit"]');await page.waitForFunction(()=>!document.querySelector('.workspace-name-dialog'));}
 async function surface(id){for(let attempt=0;attempt<150;attempt++){for(const content of await browser.pages()){if(content===page||!content.url().startsWith('http://127.0.0.1:'))continue;const ready=await content.evaluate(async id=>{const r=await window.nozeli.invoke('workspace.bootstrap',{});return r.ok&&r.value.viewId===id&&window.__nozeliReady===true&&Boolean(window.__nozeliInput);},id).catch(()=>false);if(ready)return content;}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Content did not become ready: '+id);}
 await page.click(row(north));await page.waitForFunction(id=>document.querySelector('[data-workspace-content][data-view-id="'+id+'"]'),{},north);
 await context(north,'split-x');await page.waitForFunction(id=>Object.values(window.__workspaceGroups.snapshot().views).some(v=>v.sourceViewId===id&&v.readOnly),{},north);
 const mirror=await page.evaluate(id=>Object.values(window.__workspaceGroups.snapshot().views).find(v=>v.sourceViewId===id&&v.readOnly).id,north);await page.waitForSelector(row(mirror));assert.match(await page.$eval(row(mirror),n=>n.textContent),/只读/);const mirrorPage=await surface(mirror);assert.equal(await mirrorPage.evaluate(async()=>{const r=await window.nozeli.invoke('workspace.bootstrap',{});return r.value.readOnly;}),true);
 assert.equal((await page.$$('[data-workspace-group]')).length,2);
 await rootCommand('split-x');await page.waitForFunction(()=>document.querySelectorAll('[data-workspace-group]').length===3);
 await rootCommand('split-y');await page.waitForFunction(()=>document.querySelectorAll('[data-workspace-group]').length===4);
 const savedRoot=await page.evaluate(()=>window.__workspaceGroups.snapshot().mainRoot);
 await rootCommand('layout-save');await name('Reading layout');
 await rootCommand('layout-rename');await name('Renamed layout');
 await page.waitForFunction(async()=>{const p=window.__workspaceGroups.snapshot().projectId,r=await window.nozeli.invoke('workspace.layouts.list',{projectId:p});return r.ok&&r.value.layouts.some(l=>l.name==='Renamed layout')&&!r.value.layouts.some(l=>l.name==='Reading layout');});
 // A later opened file and edited document must survive restoring navigation.
 const source=await surface(north);await source.evaluate(()=>{window.__nozeliInput.insert('\nEdited after saving named layout\n');window.__nozeliInput.select(3,9);});const edited=await source.evaluate(()=>window.__nozeliInput.text());
 await page.evaluate(()=>window.__workspaceGroups.open({kind:'document',relPath:'last.txt'}));const last=await page.evaluate(()=>Object.values(window.__workspaceGroups.snapshot().views).find(v=>v.relPath==='last.txt').id);await page.waitForSelector(row(last));
 await rootCommand('closePane');await page.waitForFunction(()=>document.querySelectorAll('[data-workspace-group]').length===3);
 await rootCommand('layout-load');await page.waitForFunction(root=>JSON.stringify(window.__workspaceGroups.snapshot().mainRoot)===JSON.stringify(root),{},savedRoot);
 assert(await page.$(row(last)),'loading an arrangement keeps later opened metadata');assert.equal(await readFile(path.join(project,'north/same.txt'),'utf8'),edited,'loading an arrangement does not restore saved document content');
 const restoredSource=await surface(north);assert.equal(await restoredSource.evaluate(()=>window.__nozeliInput.text()),edited);assert.deepEqual(await restoredSource.evaluate(()=>window.__nozeliInput.selection()),{anchor:3,head:9,from:3,to:9},'current navigation wins over saved navigation');assert.equal(await readFile(path.join(project,'south/same.txt'),'utf8'),'south document\n');
 assert.equal(await page.evaluate(()=>{const walk=node=>node.kind==='group'?node.views.length<=1:walk(node.first)&&walk(node.second);return walk(window.__workspaceGroups.snapshot().mainRoot);}),true);
 await page.reload();await prepareReading(page);await page.waitForFunction(()=>window.__workspaceGroups?.snapshot()?.projectId);await page.waitForSelector(row(last));assert.deepEqual(await page.evaluate(()=>window.__workspaceGroups.snapshot().mainRoot),savedRoot,'pane arrangement persists across renderer reload');
 await layoutMenu();await page.waitForFunction(()=>[...document.querySelectorAll('.workspace-menu-section>strong')].some(n=>n.textContent==='Renamed layout'));await page.click('#workspace-layout-menu [data-workspace-command="layout-delete"]');await page.waitForFunction(async()=>{const p=window.__workspaceGroups.snapshot().projectId,r=await window.nozeli.invoke('workspace.layouts.list',{projectId:p});return r.ok&&!r.value.layouts.some(l=>l.name==='Renamed layout');});
 await page.reload();await prepareReading(page);await page.waitForFunction(()=>window.__workspaceGroups?.snapshot()?.projectId);await layoutMenu();assert.equal(await page.evaluate(async()=>{const p=window.__workspaceGroups.snapshot().projectId,r=await window.nozeli.invoke('workspace.layouts.list',{projectId:p});if(!r.ok)throw Error(r.error.message);return r.value.layouts.some(l=>l.name==='Renamed layout');}),false,'named-layout deletion persists across reload');
 assert.deepEqual(errors,[]);
}catch(error){console.error('Workspace management evidence',output,log);for(const p of await browser?.pages()??[]){if(p.url().startsWith('http://127.0.0.1:'))console.error(await p.evaluate(()=>({scope:window.__workspaceScope,toast:document.querySelector('#toast')?.textContent,layout:window.__workspaceGroups?.snapshot()})).catch(()=>null));}throw error;}finally{await browser?.disconnect();if(child.exitCode===null)child.kill();}
