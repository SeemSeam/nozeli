import { contentToolForPage } from './native-content-tools.fixture.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';

// Owned copied renderer: inject notification timing/failure only. Files and IPC are real.
const source=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(source,'.test-output/agent-files-')),root=path.join(out,'app'),profile=path.join(out,'profile');
await fs.mkdir(root);for(const item of ['src','tools','package.json'])await fs.cp(path.join(source,item),path.join(root,item),{recursive:true});
for(const item of ['node_modules','vendor','assets'])await fs.symlink(path.join(source,item),path.join(root,item),'dir');
const appFile=path.join(root,'src/renderer/app.mjs');let app=await fs.readFile(appFile,'utf8');
app=app.replace("function invoke(op, payload) {\n  return window.nozeli.invoke(op, payload ?? {});\n}",`async function invoke(op,payload){
 window.__fileOps??=[];window.__fileOps.push({op,payload});
 if(op==='project.list'){
   if(window.__listFailure){window.__listFailure=false;return {ok:false,error:{message:'受控目录读取失败'}};}
   const result=await window.nozeli.invoke(op,payload??{});
   if(window.__holdList){window.__holdList=false;await new Promise(resolve=>window.__releaseList=resolve);}
   return result;
 }
 return window.nozeli.invoke(op,payload??{});
}`);
app=app.replace("mountProjectFileRefresh({subscribe:fn=>window.nozeli.subscribe('agent',fn)","mountProjectFileRefresh({subscribe:fn=>{window.__fileNotify=fn;return window.nozeli.subscribe('agent',fn);}");
await fs.writeFile(appFile,app);
const panel=path.join(root,'src/renderer/agent-panel.mjs');await fs.writeFile(panel,(await fs.readFile(panel,'utf8')).replace('async function loadProjectSettings(id, gen) {','async function loadProjectSettings(id, gen) { return;'));
const build=spawn(process.execPath,[path.join(root,'tools/build-renderer.mjs')],{cwd:root,stdio:['ignore','pipe','pipe']});let buildLog='';build.stdout.on('data',c=>buildLog+=c);build.stderr.on('data',c=>buildLog+=c);assert.equal(await new Promise(r=>build.once('exit',r)),0,buildLog);
const projects=[];const host=new DesktopHost(profile);
for(const name of ['甲','乙']){const dir=path.join(out,name);await fs.mkdir(path.join(dir,'folded'),{recursive:true});await fs.writeFile(path.join(dir,'folded/old.txt'),'old');await fs.writeFile(path.join(dir,'note.txt'),'original note\n');for(let i=0;i<65;i++)await fs.writeFile(path.join(dir,'row-'+String(i).padStart(2,'0')+'.txt'),'row');projects.push({dir,id:(await host.pick(dir)).project.id,name});}
const [a,b]=projects;
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform=wayland'],{cwd:root,env:{...process.env,XDG_RUNTIME_DIR:'/run/user/1000',WAYLAND_DISPLAY:'wayland-0',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus',NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_AGENT_FIXTURE:'1',NOZELI_DEBUG_PORT:String(port)},stdio:['ignore','pipe','pipe']});
let log='',browser,page,failure;const exited=new Promise(r=>child.once('exit',r)),checks=[],errors=[],pause=ms=>new Promise(r=>setTimeout(r,ms));child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
const check=name=>{checks.push(name);console.log(name);};
const notify=async(id=b.id,count=1)=>page.evaluate(({id,count})=>{for(let i=0;i<count;i++)window.__fileNotify({kind:'managed-files-changed',projectId:id,reason:'worker-turn-settled'});},{id,count});
const scans=()=>page.evaluate(()=>window.__fileOps.filter(x=>x.op==='project.list').length);
const tree=()=>page.$$eval('#file-tree button',ns=>ns.map(n=>({path:n.dataset.path,hidden:n.hidden,expanded:n.getAttribute('aria-expanded')})));
async function switchTo(project){await page.click('#recent button[title="'+project.name+'"]');await page.waitForFunction(n=>document.querySelector('#project-name').textContent===n,{},project.name);await page.waitForFunction(()=>document.querySelector('#file-tree [data-path="note.txt"]'));}
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:{width:1440,height:900}});break;}catch{}await pause(100);}assert(browser,log);page=(await browser.pages())[0];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.__nozeliReady);await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });
 await page.click('#file-tree [data-path="note.txt"]');await page.waitForFunction(()=>window.__nozeliInput?.text()==='original note\n');await contentToolForPage(page, ['view', 'text-mode']);await page.waitForSelector('.cm-editor');
 await page.evaluate(()=>{document.querySelector('.cm-editor').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));window.__nozeliInput.selectAll();window.__nozeliInput.insert('unsaved editor draft\n');window.__nozeliInput.select(2,8);document.querySelector('#composer').value='unsent conversation draft';document.querySelector('#composer').dispatchEvent(new Event('input',{bubbles:true}));});
 const before=await page.evaluate(()=>({text:window.__nozeliInput.text(),selection:window.__nozeliInput.selection(),writes:window.__fileOps.filter(x=>x.op==='file.write').length}));
 await page.click('#file-tree [data-path="folded"]');await page.$eval('#file-tree',n=>n.scrollTop=390);await page.evaluate(()=>document.querySelector('#file-tree [data-path="row-25.txt"]').focus({preventScroll:true}));const scroll=await page.$eval('#file-tree',n=>n.scrollTop),count=await scans();
 await fs.mkdir(path.join(b.dir,'generated'));await fs.writeFile(path.join(b.dir,'generated/new.md'),'# Real new result\n');await notify(b.id,8);await page.waitForSelector('#file-tree [data-path="generated/new.md"]');await pause(220);
 assert.equal(await scans(),count+1);check('burst notifications produce one authoritative scan and nested real file appears');
 assert.equal((await tree()).find(n=>n.path==='folded/old.txt').hidden,true);assert.equal(await page.$eval('#file-tree',n=>n.scrollTop),scroll);assert.equal(await page.evaluate(()=>document.activeElement.dataset.path),'row-25.txt');check('normal collapse, scroll and retained row focus survive automatic refresh');
 const after=await page.evaluate(()=>({text:window.__nozeliInput.text(),selection:window.__nozeliInput.selection(),writes:window.__fileOps.filter(x=>x.op==='file.write').length}));assert.deepEqual(after,before);assert.equal(await page.$eval('#composer',n=>n.value),'unsent conversation draft');assert.equal(await fs.readFile(path.join(b.dir,'note.txt'),'utf8'),'original note\n');assert.equal(await page.$eval('#file-tree [data-path="note.txt"]',n=>n.getAttribute('aria-current')),'true');check('editor buffer, selection, disk original, composer and current file remain untouched');
 await page.$eval('#file-filter',n=>{n.value='folded';n.dispatchEvent(new Event('input',{bubbles:true}));});await page.click('#file-tree [data-path="folded"]');await fs.writeFile(path.join(b.dir,'folded/new.txt'),'new');await notify();await page.waitForSelector('#file-tree [data-path="folded/new.txt"]');assert.equal(await page.$eval('#file-filter',n=>n.value),'folded');assert.equal((await tree()).find(n=>n.path==='folded/new.txt').hidden,true);check('search query and independent search collapse survive refresh');
 await page.$eval('#file-filter',n=>{n.value='';n.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal((await tree()).find(n=>n.path==='folded/new.txt').hidden,true);check('returning from search retains normal collapse');
 await fs.rename(path.join(b.dir,'generated/new.md'),path.join(b.dir,'generated/moved.md'));await fs.rm(path.join(b.dir,'folded/old.txt'));await notify();await page.waitForSelector('#file-tree [data-path="generated/moved.md"]');assert.equal((await tree()).some(n=>n.path==='generated/new.md'||n.path==='folded/old.txt'),false);check('unreported moves and deletes converge from real directory listing');
 let n=await scans();await notify(a.id,5);await pause(350);assert.equal(await scans(),n);check('inactive project notifications are ignored');
 await fs.writeFile(path.join(b.dir,'retry.txt'),'retry');const oldTree=await tree();await page.evaluate(()=>window.__listFailure=true);await notify();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('受控目录读取失败'));assert.deepEqual(await tree(),oldTree);await notify();await page.waitForSelector('#file-tree [data-path="retry.txt"]');check('listing failure retains tree, shows error and next event retries');
 n=await scans();await page.evaluate(()=>window.__holdList=true);await notify();await page.waitForFunction(()=>Boolean(window.__releaseList));await fs.writeFile(path.join(b.dir,'late.txt'),'late');await notify(b.id,6);await page.evaluate(()=>{window.__releaseList();window.__releaseList=null;});await page.waitForSelector('#file-tree [data-path="late.txt"]');await pause(200);assert.equal(await scans(),n+2);check('notification during held scan produces one trailing scan');
 await page.evaluate(()=>document.querySelector('.cm-editor').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存'));assert.equal(await fs.readFile(path.join(b.dir,'note.txt'),'utf8'),before.text);check('normal autosave resumes after composition without refresh writing the draft');
 await page.click('#file-tree [data-path="generated/moved.md"]');await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='generated/moved.md');assert.match(await page.evaluate(()=>window.__nozeliInput.text()),/Real new result/);check('automatically discovered generated file opens in workspace');
 await page.screenshot({path:path.join(out,'generated-open.png')});
 await fs.writeFile(path.join(b.dir,'queued-old.txt'),'old project only');await notify();await switchTo(a);await pause(300);assert.equal((await tree()).some(n=>n.path==='queued-old.txt'||n.path==='generated/moved.md'),false);check('queued old-project notification cannot overwrite new project tree');
 await notify(b.id);await pause(200);assert.equal((await tree()).some(n=>n.path==='queued-old.txt'),false);await switchTo(b);await page.waitForSelector('#file-tree [data-path="queued-old.txt"]');check('returning to project lists latest real contents');
 assert.deepEqual(errors,[]);check('no renderer errors');await page.evaluate(()=>nozeli.invoke('session.requestClose'));await exited;
}catch(e){failure=e;console.error(e.stack);if(page){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'failure-state.json'),JSON.stringify(await page.evaluate(()=>({status:document.querySelector('#save-status').textContent,error:document.querySelector('#save-error').textContent,tree:document.querySelector('#file-tree').textContent})).catch(()=>({})),null,2));}}
finally{await browser?.disconnect();if(child.exitCode===null)child.kill();await fs.writeFile(path.join(out,'electron.log'),log);await fs.writeFile(path.join(out,'result.json'),JSON.stringify({status:failure?'FAIL':'PASS',checks,errors,out,failure:failure?.message},null,2));console.log(JSON.stringify({out,status:failure?'FAIL':'PASS',checks:checks.length}));if(failure)process.exitCode=1;}
