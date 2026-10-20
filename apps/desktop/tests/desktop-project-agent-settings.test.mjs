import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const appRoot=path.resolve(import.meta.dirname,'..'),root=await mkdtemp(path.join(os.tmpdir(),'nozeli-project-quotas-'));
const projectA=path.join(root,'a'),projectB=path.join(root,'b');
const {mkdir}=await import('node:fs/promises');for(const directory of [projectA,projectB]){await mkdir(directory);await writeFile(path.join(directory,'readme.md'),'Project quota isolation');}
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(appRoot,'src/main/main.cjs'),'--ozone-platform='+(process.env.NOZELI_OZONE||'headless')],{cwd:appRoot,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_PICK:[projectA,projectB,projectA].join('\n'),NOZELI_CONFIG_ROOT:path.join(root,'.Nozeli'),NOZELI_USER_DATA:path.join(root,'.Nozeli','desktop'),NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:process.env.NOZELI_TEST_VISIBLE==='1'?'0':'1'},stdio:['ignore','pipe','pipe']});
let browser,page,log='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),exited=new Promise(resolve=>child.once('exit',resolve));
try{
 for(let i=0;i<200;i++){try{browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await pause(100);}}
 assert(browser,log);page=await(await browser.waitForTarget(t=>t.type()==='page'&&t.url().startsWith('http://127.0.0.1:'),{timeout:90000})).page();await page.waitForFunction(()=>window.__nozeliReady);
 await page.waitForSelector('#configuration-setup[open]');await page.click('#configuration-independent');await page.waitForFunction(()=>!document.querySelector('#configuration-setup').open);
 const invoke=async(op,payload={})=>{const result=await page.evaluate((op,payload)=>window.nozeli.invoke(op,payload),op,payload);assert(result.ok,result.error?.message);return result.value;};
 await invoke('settings.providers.save',{provider:'quota-local',model:'scripted',baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',key:'synthetic-local-only'});
 await invoke('settings.models.save',{frontdesk:'quota-local/scripted',orchestrator:'quota-local/scripted',worker:'quota-local/scripted'});
 await invoke('project.pick',{directory:projectB});
 const open=async()=>{await page.evaluate(()=>window.dispatchEvent(new CustomEvent('nozeli-open-settings',{detail:'settings-agents'})));await page.waitForFunction(()=>!document.querySelector('[data-agent-limits-save]').disabled);};
 const pick=async directory=>{const project=(await invoke('project.recent')).projects.find(p=>p.name===path.basename(directory)),selector=project?`#recent [data-project-id="${project.id}"]`:null;if(selector&&await page.$(selector))await page.click(selector);else await page.click('#pick-project');await page.waitForFunction(name=>document.querySelector('#project-name').textContent===name,{},path.basename(directory));};
 await pick(projectA);await open();await page.waitForFunction(()=>!document.querySelector('[data-agent-project-limit]').disabled);
 const recent=(await invoke('project.recent')).projects,idA=recent.find(p=>p.path===projectA||p.name==='a').id;
 const before=await invoke('settings.agents.status',{projectId:idA});
 await page.$eval('[data-agent-project-limit]',e=>{e.value='5';});await page.click('[data-agent-limits-save]');await page.waitForFunction(()=>document.querySelector('[data-agent-limits-status]').textContent.includes('已保存'));
 assert.equal((await invoke('settings.agents.status',{projectId:idA})).projectLimit,5);await page.click('#settings-close');
 await pick(projectB);await open();const idB=(await invoke('project.recent')).projects.find(p=>p.path===projectB||p.name==='b').id;
 await page.$eval('[data-agent-project-limit]',e=>{e.value='6';});await page.click('[data-agent-limits-save]');await page.waitForFunction(()=>document.querySelector('[data-agent-limits-status]').textContent.includes('已保存'));
 assert.equal((await invoke('settings.agents.status',{projectId:idB})).projectLimit,6);assert.equal((await invoke('settings.agents.status',{projectId:idA})).projectLimit,5,'B save must not change A quota');
 assert.equal((await invoke('settings.agents.status')).globalLimit,before.globalLimit,'project edits preserve global quota');
 await page.click('#settings-close');await pick(projectA);await open();assert.equal(await page.$eval('[data-agent-project-limit]',e=>e.value),'5','returning to A restores its quota');
 assert.equal(await page.$$eval('#managed-settings,#managed-terminal-settings,#agent-settings,[data-managed-provider]',els=>els.length),0,'legacy Agent settings are removed');
 await page.click('#settings-close');await page.click('#open-settings');await page.click('#provider-console-toggle');await page.waitForFunction(()=>!document.querySelector('#provider-console').hidden);
 assert(await page.$('#provider-console-close'),'terminal retains return-to-reading');await page.click('#provider-console-close');await page.waitForFunction(()=>document.querySelector('#provider-console').hidden);
 console.log(JSON.stringify({pass:true,root,scope:'real isolated Electron project quota save and project isolation'}));
}finally{
 if(page&&!page.isClosed())await Promise.race([page.evaluate(()=>window.nozeli.invoke('session.requestClose',{})).catch(()=>{}),pause(2000)]);
 if(child.exitCode===null){await Promise.race([exited,pause(5000)]);if(child.exitCode===null)child.kill('SIGTERM');await Promise.race([exited,pause(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 await browser?.disconnect();await writeFile(path.join(root,'electron.log'),log);
}
