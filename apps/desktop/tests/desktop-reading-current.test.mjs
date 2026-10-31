// Current native-content reading journey. Real files, physical selection,
// immutable annotation material and recoverable unsaved text; no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {installFileTreeClicks} from './file-tree-clicks.fixture.mjs';

const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-reading-native-'));
const configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop'),project=path.join(out,'project');
await fs.mkdir(project);
const original='# Reading lifecycle\n\nA physical selection 中文🧭é keeps this local note anchored.\n\nSecond paragraph stays readable.\n';
await fs.writeFile(path.join(project,'reading.md'),original);await fs.writeFile(path.join(project,'edit.txt'),'Original editable text.\n');
const checks=[],errors=[];let child,browser,shell,page,exited,log='',stage='',projectId;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error(log);await pause(80);}throw Error('Timed out: '+label);}
async function invoke(op,payload={},target=shell){const response=await target.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(response.ok,true,op+': '+JSON.stringify(response));return response.value;}
async function content(kind,relPath){return until(async()=>{for(const target of await browser.pages())if(await target.evaluate(({kind,relPath})=>window.__nozeliReady&&window.__workspaceScope?.kind===kind&&(!relPath||window.__workspaceScope.relPath===relPath),{kind,relPath}).catch(()=>false))return target;},kind+' '+(relPath||''));}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 const ozone=process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':process.env.WAYLAND_DISPLAY?'wayland':'headless');
 const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:configRoot,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_OZONE:ozone,NOZELI_SHOT_DIR:out});
 child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform='+ozone],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const target of await browser.pages())if(await target.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return target;},'ready shell');
 for(const target of await browser.pages())target.on('pageerror',error=>errors.push(error.message));
 if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
 installFileTreeClicks(shell);await invoke('session.resize',{width:1440,height:900});
 if(projectId)await shell.click('[data-project-id="'+projectId+'"]');
 else{await shell.click('#pick-project');projectId=(await until(async()=>(await invoke('project.recent')).projects.find(row=>row.rootDisplay===project),'registered project')).id;}
 assert.equal((await invoke('config.status')).initialized,false);
}
async function close(){await invoke('session.requestClose');assert.deepEqual(await Promise.race([exited,pause(15000).then(()=>null)]),{code:0,signal:null});await browser.disconnect();browser=null;}
async function open(rel){await shell.click('#file-tree button[data-path="'+rel+'"]');page=await content('document',rel);await page.bringToFront();}
try{
 stage='choose project and native Markdown content';await launch();await open('reading.md');
 await page.waitForSelector('#text-preview h1',{visible:true});assert.equal(await page.$eval('#text-preview h1',node=>node.textContent.trim()),'Reading lifecycle');checks.push('native Markdown reading without initializing any provider');
 stage='physical Unicode selection and local annotation';
 const points=await page.evaluate(()=>{const p=[...document.querySelectorAll('#text-preview p')].find(node=>node.textContent.startsWith('A physical'));p.scrollIntoView({block:'center'});const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())&&!node.textContent.includes('physical selection')){}if(!node)throw Error('Selection text not rendered');const start=node.textContent.indexOf('physical selection'),range=document.createRange();range.setStart(node,start);range.setEnd(node,start+'physical selection'.length);const box=range.getBoundingClientRect();return{x:box.left+.2,y:box.top+box.height/2,end:box.right-.2};});
 await page.mouse.move(points.x,points.y);await page.mouse.down();await page.mouse.move(points.end,points.y,{steps:12});await page.mouse.up();await page.waitForSelector('#selection-menu:not([hidden])',{visible:true});
 const quote='physical selection 中文🧭é',initial=await page.evaluate(()=>getSelection().toString());assert(initial.length>0&&quote.startsWith(initial));
 await page.keyboard.down('Shift');for(let count=0;count<quote.length&&await page.evaluate(()=>getSelection().toString())!==quote;count++){await page.keyboard.press('ArrowRight');assert(quote.startsWith(await page.evaluate(()=>getSelection().toString())));}await page.keyboard.up('Shift');assert.equal(await page.evaluate(()=>getSelection().toString()),quote);
 await page.click('#selection-note');await page.waitForSelector('#note-form:not([hidden])',{visible:true});await page.type('#note-input','Current anchored local note');await page.click('#add-note');await page.waitForSelector('#text-preview .tag-note .note-projection',{visible:true});
 const annotations=(await invoke('annotation.list',{projectId,relPath:'reading.md'},page)).annotations,note=annotations.find(row=>row.note==='Current anchored local note');assert(note);
 assert.deepEqual(note.anchor,{start:original.indexOf(quote),end:original.indexOf(quote)+quote.length,quote});assert.equal(note.relPath,'reading.md');
 const inspector=new DesktopHost(profile);try{assert.equal((await inspector.storage.readObject(projectId,note.materialDigest)).toString(),original);}finally{await inspector.storage.db.close();}
 assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),original);assert.equal((await invoke('managed.status',{projectId})).state?.jobs?.length??0,0);checks.push('physical Shift+Arrow Unicode anchor and original immutable material save locally without dispatch');
 stage='native source edit and explicit save';await open('edit.txt');await page.waitForSelector('#text-host .cm-content',{visible:true});await page.click('#text-host .cm-content');await page.keyboard.down('Control');await page.keyboard.press('End');await page.keyboard.up('Control');await page.keyboard.type('Saved current UI edit.');await page.keyboard.down('Control');await page.keyboard.press('s');await page.keyboard.up('Control');
 await until(async()=>(await fs.readFile(path.join(project,'edit.txt'),'utf8')).includes('Saved current UI edit.'),'source saved');checks.push('real native editor typing and explicit save write source');
 stage='unsaved text recovery and normal restart';await page.bringToFront();await page.evaluate(()=>window.__nozeliInput.focus());await page.waitForFunction(()=>document.hasFocus()&&document.activeElement?.closest('#text-host .cm-editor'));await page.keyboard.down('Control');await page.keyboard.press('End');await page.keyboard.up('Control');await page.keyboard.type('Unsent local reading draft');await page.waitForFunction(()=>window.__nozeliInput.text().includes('Unsent local reading draft'));const unsaved=await page.evaluate(()=>window.__nozeliInput.text());await close();await launch();const recovery=await invoke('workspace.recovery.list');assert(recovery.entries.some(row=>row.project.id===projectId&&row.value.relPath==='edit.txt'&&row.value.candidate?.text===unsaved),'exact unsaved bytes retained for explicit recovery');await open('edit.txt');await page.waitForFunction(()=>window.__nozeliInput?.text?.().includes('Saved current UI edit.'));assert.equal(await fs.readFile(path.join(project,'edit.txt'),'utf8'),'Original editable text.\nSaved current UI edit.');checks.push('normal close retains exact unsaved text in the recovery ledger; reopening never silently writes it over source');
 stage='reopen original annotation';await open('reading.md');await page.waitForSelector('#text-preview .tag-note .note-projection',{visible:true});const restored=(await invoke('annotation.list',{projectId,relPath:'reading.md'},page)).annotations.find(row=>row.id===note.id);assert.deepEqual(restored.anchor,note.anchor);assert.equal(restored.materialDigest,note.materialDigest);assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),original);checks.push('annotation anchor and frozen source version survive complete process restart');
 await page.screenshot({path:path.join(out,'reading-current.png')});assert.deepEqual(errors,[]);await close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:true,checks,errors,out},null,2));console.log(JSON.stringify({ok:true,checks,out},null,2));
}catch(error){await Promise.race([page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{}),pause(2000)]);await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:false,stage,error:error.stack,checks,errors,out},null,2));console.error(out,stage,error);throw error;}
finally{await fs.writeFile(path.join(out,'main.log'),log);await browser?.disconnect();if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}}
