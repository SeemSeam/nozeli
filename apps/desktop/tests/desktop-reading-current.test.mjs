import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {prepareReading} from './reading-setup.fixture.mjs';
import {FileTags} from '../src/domain/file-tags.mjs';

// Current public reading UI only. Historical page-level #show-note workflows
// remain in desktop-electron.test.mjs; they are not current UI acceptance.
const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-reading-current-'));
const configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop'),project=path.join(out,'project');
await fs.mkdir(project);
const original='# Reading lifecycle\n\nA physical selection 中文🧭é keeps this local note anchored.\n\nSecond paragraph stays readable.\n';
await fs.writeFile(path.join(project,'reading.md'),original);
await fs.writeFile(path.join(project,'edit.txt'),'Original editable text.\n');
const checks=[],errors=[];let child,browser,page,exited,log='',stage='';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function step(name){stage=name;console.log('reading smoke: '+name);}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 const ozone=process.env.NOZELI_OZONE||'headless';
 child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform='+ozone],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:configRoot,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:process.env.NOZELI_TEST_VISIBLE==='1'?'0':'1',NOZELI_OZONE:ozone},stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await pause(100);}}
 assert(browser,log);const target=await browser.waitForTarget(target=>target.type()==='page'&&target.url().startsWith('http://127.0.0.1:'),{timeout:30000});page=await target.page();page.on('pageerror',error=>errors.push(error.stack));
 await prepareReading(page);
 await page.evaluate(()=>nozeli.invoke('session.resize',{width:1440,height:900}));
 await page.waitForFunction(()=>innerWidth===1440);
}
async function close(){
 void page.evaluate(()=>nozeli.invoke('session.requestClose',{})).catch(()=>{});
 assert.deepEqual(await Promise.race([exited,pause(12000).then(()=>null)]),{code:0,signal:null});
 await browser.disconnect();browser=null;page=null;
}
async function open(rel){await page.click('#file-tree button[data-path="'+rel+'"]');await page.waitForFunction(rel=>document.querySelector('#file-path').textContent===rel,{},rel);}
try{
 step('launch and choose project without initializing OMP');await launch();await page.click('#pick-project');await open('reading.md');
 await page.waitForSelector('#text-preview h1',{visible:true});assert.equal(await page.$eval('#text-preview h1',node=>node.textContent.trim()),'Reading lifecycle');
 assert.equal(await page.$eval('#configuration-setup',node=>node.open),false);checks.push('real Markdown reading, app setup cancellation and no repeated project chooser');
 step('physical drag followed by native Unicode keyboard selection and anchored local note');
 const points=await page.evaluate(()=>{const p=[...document.querySelectorAll('#text-preview p')].find(node=>node.textContent.startsWith('A physical'));p.scrollIntoView({block:'center'});const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())&&!node.textContent.includes('physical selection')){}if(!node)throw Error('Selection text not rendered');const start=node.textContent.indexOf('physical selection'),range=document.createRange();range.setStart(node,start);range.setEnd(node,start+'physical selection'.length);const box=range.getBoundingClientRect();return{x:box.left+.2,y:box.top+box.height/2,end:box.right-.2};});
 await page.mouse.move(points.x,points.y);await page.mouse.down();await page.mouse.move(points.end,points.y,{steps:12});await page.mouse.up();await page.waitForSelector('#selection-menu:not([hidden])',{visible:true});
 const quote='physical selection 中文🧭é';
 const initialSelection=await page.evaluate(()=>getSelection().toString());
 assert(initialSelection.length>0&&quote.startsWith(initialSelection),'Physical drag must start at the exact quote origin');
 // Extend only with native keys after the mouse button is up. No synthetic
 // mouseup may refresh the product's cached preview anchor for this regression.
 await page.keyboard.down('Shift');
 for(let count=0;count<quote.length&&await page.evaluate(()=>getSelection().toString())!==quote;count++){
  await page.keyboard.press('ArrowRight');
  assert(quote.startsWith(await page.evaluate(()=>getSelection().toString())));
 }
 await page.keyboard.up('Shift');
 assert.equal(await page.evaluate(()=>getSelection().toString()),quote);
 await page.click('#selection-note');await page.waitForSelector('#note-form:not([hidden])',{visible:true});await page.type('#note-input','Current anchored local note');await page.click('#add-note');await page.waitForSelector('#text-preview .tag-note .note-projection',{visible:true});
 const projectId=await page.evaluate(async()=>(await nozeli.invoke('project.recent')).value.projects[0].id);
 const annotations=await page.evaluate(async projectId=>(await nozeli.invoke('annotation.list',{projectId,relPath:'reading.md'})).value.annotations,projectId);
 const note=annotations.find(note=>note.note==='Current anchored local note');assert(note);
 assert.deepEqual(note.anchor,{start:original.indexOf(quote),end:original.indexOf(quote)+quote.length,quote});
 assert.equal(note.relPath,'reading.md');
 assert.equal((await new FileTags(project).materials.get(note.materialDigest)).toString(),original);
 assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),original);assert.equal((await page.evaluate(async projectId=>nozeli.invoke('agents.messages',{projectId}),projectId)).value.messages.length,0);checks.push('native Shift+Arrow preview selection saves exact Unicode offsets, quote, source file and frozen version without dispatch or source rewrite');
 step('edit and save actual source');await open('edit.txt');await page.waitForSelector('#text-host .cm-content',{visible:true});
 await page.click('#text-host .cm-content');await page.keyboard.down('Control');await page.keyboard.press('End');await page.keyboard.up('Control');await page.keyboard.type('Saved current UI edit.');
 await page.keyboard.down('Control');await page.keyboard.press('s');await page.keyboard.up('Control');
 await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
 assert.match(await fs.readFile(path.join(project,'edit.txt'),'utf8'),/Saved current UI edit\./);checks.push('physical editor typing and save write real source');
 step('local draft and normal restart');await page.click('#composer');await page.type('#composer','Unsent local reading draft');await close();await launch();
 await page.waitForFunction(()=>window.__nozeliInput?.text?.().includes('Saved current UI edit.'));assert.equal(await page.$eval('#composer',node=>node.value),'Unsent local reading draft');checks.push('normal close/restart restores source and unsent local draft');
 step('reopen anchored note');await open('reading.md');await page.waitForSelector('#text-preview .tag-note .note-projection',{visible:true});assert.match(await page.$eval('#text-preview .tag-note .note-projection',node=>node.textContent),/Current anchored local note/);assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),original);
 const reopened=await page.evaluate(async projectId=>(await nozeli.invoke('annotation.list',{projectId,relPath:'reading.md'})).value.annotations,projectId);
 const restored=reopened.find(item=>item.id===note.id);assert.deepEqual(restored.anchor,note.anchor);assert.equal(restored.materialDigest,note.materialDigest);assert.equal(restored.relPath,note.relPath);checks.push('keyboard-selected Unicode anchor and frozen origin survive full process restart');
 assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'reading-current.png')});await close();
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:true,checks,errors,out},null,2));console.log(JSON.stringify({ok:true,checks,out},null,2));
}catch(error){console.error('Reading smoke failed at '+stage+'; '+out+'\n'+log);await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:false,stage,error:error.stack,checks,errors,out},null,2));throw error;
}finally{await fs.writeFile(path.join(out,'main.log'),log);await browser?.disconnect();if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null){child.kill('SIGKILL');await exited;}}}
