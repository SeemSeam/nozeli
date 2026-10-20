import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..');await mkdir(path.join(root,'.test-output'),{recursive:true});
const output=await mkdtemp(path.join(root,'.test-output','fixture-close-'));const project=path.join(output,'中文 论文');await mkdir(path.join(project,'sections'),{recursive:true});
await writeFile(path.join(project,'read.md'),'# Other document\n');
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const n=server.address().port;server.close(()=>resolve(n));});});
const child=spawn(createRequire(import.meta.url)('electron'),['--ozone-platform=wayland',path.join(root,'src/main/main.cjs')],{cwd:root,env:{...process.env,WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000',NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:path.join(output,'profile'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
let closed=false;let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);let browser,page;const checks=[];
try{
 const deadline=Date.now()+25000;for(;;){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}if(Date.now()>deadline||child.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,100));}
 browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});page=(await browser.pages()).find(p=>p.url().includes('127.0.0.1'));
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.stack);});await page.waitForFunction(()=>window.__nozeliReady);

 const images=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1200;c.height=800;const x=c.getContext('2d');x.fillStyle='#ffffff';x.fillRect(0,0,1200,800);x.fillStyle='#ff0000';x.fillRect(0,0,600,800);x.fillStyle='#0000ff';x.fillRect(600,0,600,800);x.fillStyle='#ffffff';x.font='100px sans-serif';x.fillText('ALPHA',60,250);x.fillText('BETA',650,250);return ['png','jpeg','webp'].map(t=>({type:t,data:c.toDataURL('image/'+t).split(',')[1]}));});
 for(const im of images)await writeFile(path.join(project,'sample.'+im.type),Buffer.from(im.data,'base64'));
 await page.click('#pick-project');await page.waitForSelector('#agent-setup[open]');const provider=await page.$eval('#agent-foreground option:not(:disabled)',n=>n.value);await page.select('#agent-foreground',provider);await page.select('#agent-background',provider);await page.$eval('#agent-setup-form',n=>n.requestSubmit());await page.waitForFunction(()=>!document.querySelector('#agent-setup').open);
 const projectId=await page.evaluate(async()=>(await nozeli.invoke('project.recent')).value.projects[0].id);


 await page.evaluate(async projectId=>{const r=await nozeli.invoke('agents.send',{projectId,text:'fixture pending close verification'});if(!r.ok)throw Error(r.error.message);},projectId);
 await page.evaluate(()=>nozeli.invoke('session.requestClose'));await page.waitForSelector('#quit-choice[open]');await page.click('#quit-cancel');
 const result=await Promise.race([exited,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('busy fixture failed to exit')),10000);t.unref();})]);assert.equal(result.code,0);closed=true;
 console.log(JSON.stringify({passed:true,check:'pending in-process fixture cancels and Electron exits normally',output}));
} catch(error){if(page){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(await page.evaluate(()=>({status:document.querySelector('#tex-status')?.textContent,preview:document.querySelector('#secondary-pdf')?.dataset,stages:[...document.querySelectorAll('[data-tex-stage]')].map(n=>({id:n.dataset.texStage,text:n.textContent.slice(0,200),rect:n.getBoundingClientRect().toJSON()})),body:document.body.innerText.slice(-1500)})).catch(()=>({})));}throw error;}
finally{await writeFile(path.join(output,'electron.log'),log);if(page&&!closed)await page.evaluate(()=>nozeli.invoke('session.requestClose')).catch(()=>{});await browser?.disconnect();if(child.exitCode===null)setTimeout(()=>child.kill('SIGTERM'),3000).unref();}
