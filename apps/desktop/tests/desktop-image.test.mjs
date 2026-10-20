import {prepareReading, waitForDesktopPage, waitForReadingProject} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..');await mkdir(path.join(root,'.test-output'),{recursive:true});
const output=await mkdtemp(path.join(root,'.test-output','image-reader-'));const project=path.join(output,'中文 论文');await mkdir(path.join(project,'sections'),{recursive:true});
await writeFile(path.join(project,'read.md'),'# Other document\n');
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const n=server.address().port;server.close(()=>resolve(n));});});
const child=spawn(createRequire(import.meta.url)('electron'),['--ozone-platform=wayland',path.join(root,'src/main/main.cjs')],{cwd:root,env:{...process.env,WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000',NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:path.join(output,'profile'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1',NOZELI_AGENT_FIXTURE_REPLY:'1'},stdio:['ignore','pipe','pipe']});
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
let closed=false;let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);let browser,page;const checks=[];
try{
 const deadline=Date.now()+25000;for(;;){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}if(Date.now()>deadline||child.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,100));}
 browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});page=await waitForDesktopPage(browser);
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.stack);});await page.waitForFunction(()=>window.__nozeliReady);

 const images=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1200;c.height=800;const x=c.getContext('2d');x.fillStyle='#ffffff';x.fillRect(0,0,1200,800);x.fillStyle='#ff0000';x.fillRect(0,0,600,800);x.fillStyle='#0000ff';x.fillRect(600,0,600,800);x.fillStyle='#ffffff';x.font='100px sans-serif';x.fillText('ALPHA',60,250);x.fillText('BETA',650,250);return ['png','jpeg','webp'].map(t=>({type:t,data:c.toDataURL('image/'+t).split(',')[1]}));});
 for(const im of images)await writeFile(path.join(project,'sample.'+im.type),Buffer.from(im.data,'base64'));
 await prepareReading(page);await page.click('#pick-project');
 const projectId=await waitForReadingProject(page,project);

 const invoke=(op,payload)=>page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
 const select=async(left=.1,top=.4,right=.4,bottom=.7)=>{await page.click('#image-region');const b=await page.$eval('.image-page',n=>n.getBoundingClientRect().toJSON());await page.mouse.move(b.left+b.width*left,b.top+b.height*top);await page.mouse.down();await page.mouse.move(b.left+b.width*right,b.top+b.height*bottom,{steps:12});await page.mouse.up();await page.waitForSelector('#selection-menu:not([hidden])');};
 for(const ext of ['png','jpeg','webp']){await page.click(`#file-tree button[data-path="sample.${ext}"]`);await page.waitForSelector('#image-host canvas');await page.waitForFunction(ext=>document.querySelector('#file-path').textContent==='sample.'+ext,{},ext);}
 checks.push('PNG JPEG WebP decode from real files');
 await page.click('#file-tree button[data-path="sample.png"]');await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='sample.png');await page.waitForSelector('#image-host canvas');
 const fit=await page.evaluate(()=>{const b=document.querySelector('.image-page').getBoundingClientRect(),v=document.querySelector('#reader-scroll');return {w:b.width,h:b.height,vw:v.clientWidth,vh:v.clientHeight};});assert.ok(fit.w<=fit.vw&&fit.h<=fit.vh);await page.click('#image-actual');assert.equal(await page.$eval('.image-page',n=>Math.round(n.getBoundingClientRect().width)),1200);await page.click('#image-fit');checks.push('fit and 100 percent use real image dimensions');
 await select();await page.click('#selection-note');await page.type('#note-input','Red area note');await page.click('#add-note');await page.waitForSelector('#image-host .note-anchor');
 let records=(await invoke('annotation.list',{projectId,relPath:'sample.png'})).value.annotations;assert.equal(records.length,1);let record=records[0];assert.equal(record.kind,'image-region');assert.ok(Math.abs(record.anchor.rects[0][0]-.1)<.01);assert.equal(record.information.assets.length,1);
 const asset=await readFile(path.join(project,record.information.assets[0].relPath));const color=await page.evaluate(async data=>{const im=new Image();im.src='data:image/png;base64,'+data;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;c.getContext('2d').drawImage(im,0,0);return [...c.getContext('2d').getImageData(2,2,1,1).data];},asset.toString('base64'));assert.deepEqual(color,[255,0,0,255]);checks.push('physical region drag saves normalized position, source pixels and uncontaminated red screenshot');
 await page.click('#image-in');const anchor=await page.evaluate(()=>{const p=document.querySelector('.image-page').getBoundingClientRect(),n=document.querySelector('.image-region-mark').getBoundingClientRect();return [(n.left-p.left)/p.width,(n.top-p.top)/p.height];});assert.ok(Math.abs(anchor[0]-.1)<.01&&Math.abs(anchor[1]-.4)<.01);await page.click('#image-fit');
 await page.click('#file-tree button[data-path="read.md"]');await page.waitForSelector('#image-host[hidden]');assert.equal(await page.$eval('#image-toolbar',n=>n.hidden),true);
 await page.click('#file-tree button[data-path="sample.png"]');await page.waitForSelector('#image-host .note-anchor');checks.push('zoom and file switch preserve image-local floating notes');
 const first='#image-host .note-anchor .note-index';await page.click(first,{count:2});await page.waitForFunction(()=>document.querySelector('#image-host .note-index').getAttribute('aria-expanded')==='false');await page.click('#image-in');assert.equal(await page.$eval(first,n=>n.getAttribute('aria-expanded')),'false');await page.click(first,{count:2});await page.waitForFunction(()=>document.querySelector('#image-host .note-index').getAttribute('aria-expanded')==='true');checks.push('double-click collapse/expand survives image zoom');
 await page.reload();await page.waitForFunction(()=>window.__nozeliReady);await prepareReading(page);await page.waitForSelector('#image-host .note-anchor');assert.equal(await page.$$eval('#image-host .note-anchor',nodes=>nodes.length),1);checks.push('reload restores local image annotation');

 await page.screenshot({path:path.join(output,'image-notes.png')});
 await page.click('#file-tree button[data-path="read.md"]');
 await writeFile(path.join(project,'sample.png'),Buffer.concat([await readFile(path.join(project,'sample.png')),Buffer.from('changed-test-version')]));
 await page.click('#file-tree button[data-path="sample.png"]');await page.waitForSelector('#image-host canvas');await page.waitForSelector('#unlocated-tags:not([hidden])');assert.equal(await page.$$eval('#image-host .note-anchor',nodes=>nodes.length),0);checks.push('changed image does not silently reattach old annotations');
 assert.deepEqual(errors,[]);
 await page.evaluate(()=>nozeli.invoke('session.requestClose'));await Promise.race([exited,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('close timeout')),10000);t.unref();})]);closed=true;
 await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,checks,output},null,2));console.log(JSON.stringify({passed:true,checks,output},null,2));
} catch(error){if(page){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(await page.evaluate(()=>({status:document.querySelector('#tex-status')?.textContent,preview:document.querySelector('#secondary-pdf')?.dataset,stages:[...document.querySelectorAll('[data-tex-stage]')].map(n=>({id:n.dataset.texStage,text:n.textContent.slice(0,200),rect:n.getBoundingClientRect().toJSON()})),body:document.body.innerText.slice(-1500)})).catch(()=>({})));}throw error;}
finally{await writeFile(path.join(output,'electron.log'),log);if(page&&!closed)await page.evaluate(()=>nozeli.invoke('session.requestClose')).catch(()=>{});await browser?.disconnect();if(child.exitCode===null)setTimeout(()=>child.kill('SIGTERM'),3000).unref();}
