// Visible packaged Electron + real Codex/OMP, no prompts or injected model services/keys/HOME.
// node tests/omp-provider-view-roundtrip-live.mjs RELEASE EVIDENCE
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
const [release,root]=process.argv.slice(2).map(p=>path.resolve(p));await fs.mkdir(root,{recursive:true});
const project=path.join(root,'project');await fs.mkdir(project,{recursive:true});await fs.writeFile(path.join(project,'readme.md'),'Provider view lease acceptance. No model request.\n');
const projectId=createHash('sha256').update(project).digest('hex'),profile=path.join(root,'profile');
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>r(n));});});
const env={PATH:process.env.PATH,DISPLAY:process.env.DISPLAY||':0',XAUTHORITY:process.env.XAUTHORITY,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,LANG:'C.UTF-8',NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:profile,NOZELI_HIDDEN:'0',NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:root};
const child=spawn(path.join(release,'nozeli'),['--ozone-platform=x11'],{env,cwd:os.userInfo().homedir,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',d=>log=(log+d).slice(-10000));child.stderr.on('data',d=>log=(log+d).slice(-10000));const exit=new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));
const wait=async(fn,label,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,200));}throw Error('timeout: '+label);};
const facts=[];let browser,page;
const invoke=async(op,payload={})=>{const r=await page.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});if(!r?.ok)throw Object.assign(Error(r?.error?.message),{code:r?.error?.code});return r.value;};
const status=()=>invoke('managed.status',{projectId});
const lease=target=>page.evaluate(target=>{const out=document.querySelector(`[data-managed-terminal="${target}"] .provider-output`);return out?.dataset.terminalState==='attached'?out.dataset.connectionId:null;},target);
try{
 await wait(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'devtools');
 browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null,protocolTimeout:60000});page=(await browser.pages()).find(p=>p.url().includes('127.0.0.1'));
 await page.waitForFunction(()=>window.__nozeliReady===true);await page.click('#pick-project');await wait(async()=>{const s=await status().catch(()=>null);return s?.ready;},'project ready');
 if(await page.$eval('#provider-console',node=>node.hidden)){await page.click('#open-settings');await page.click('[data-settings-section="settings-general"]');await page.click('#provider-console-toggle');}
 let previous=await wait(()=>lease('frontdesk'),'initial terminal attached');
 for(const round of [1,2,3]){
  const before=await status(),oldOwner=before.state.agents.find(a=>a.target==='frontdesk')?.ownerId;
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('nozeli-open-settings',{detail:'settings-agents'})));await page.waitForSelector('#settings-dialog[open] #settings-agents:not([hidden])');
  await page.waitForFunction(()=>!document.querySelector('[data-agent-limits-save]').disabled);await page.click('[data-agent-limits-save]');
  await page.waitForFunction(()=>document.querySelector('[data-agent-limits-status]').textContent.includes('已保存'));
  assert.equal((await status()).state.agents.find(a=>a.target==='frontdesk')?.ownerId,oldOwner,'quota save preserves existing native process');
  await invoke('managed.restart',{projectId,target:'frontdesk'});
  await wait(async()=>{const s=await status();const a=s.state.agents.find(a=>a.target==='frontdesk');return a?.ownerId!==oldOwner&&!a?.closed;},'native restart '+round);
  await page.evaluate(()=>document.querySelector('#settings-close').click());
  const next=await wait(async()=>{const id=await lease('frontdesk');return id&&id!==previous?id:null;},'new view attached '+round);
  await assert.rejects(invoke('managed.terminal.input',{projectId,target:'frontdesk',terminalId:previous,data:'not-replayed'}),e=>e.code==='TERMINAL_STALE');
  await invoke('managed.terminal.input',{projectId,target:'frontdesk',terminalId:next,data:'\x15'});
  if(round!==2){
   await invoke('managed.terminal.input',{projectId,target:'frontdesk',terminalId:next,data:'/switch zai/glm-4.7:low\r'});
   await wait(async()=>{const s=await status();return s.state.agents.find(a=>a.target==='frontdesk')?.effective?.model==='zai/glm-4.7';},'native config command');
   await invoke('managed.terminal.input',{projectId,target:'frontdesk',terminalId:next,data:'\x15'});
  }
  const now=await status();assert.equal(now.state.jobs.length,0);assert.equal(now.state.works.length,0);
  await invoke('session.capture',{name:'quota-native-roundtrip-'+round});
  facts.push({round,quotaSavePreservedOwner:true,oldLeaseRejected:true,newLease:next,ownerChanged:true,noModelJobs:true});previous=next;
 }
 await invoke('session.requestClose');let timer;let closed;try{closed=await Promise.race([exit,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('exit timeout')),45000))]);}finally{clearTimeout(timer);}assert.equal(closed.code,0);await browser.disconnect();browser=null;
 await fs.writeFile(path.join(root,'result.json'),JSON.stringify({pass:true,release,facts,exit:closed},null,2));console.log(JSON.stringify({pass:true,facts,exit:closed}));
}catch(error){await fs.writeFile(path.join(root,'result.json'),JSON.stringify({pass:false,release,facts,error:String(error.stack||error),log},null,2));if(page)try{await invoke('session.requestClose');}catch{}if(browser)await browser.disconnect();throw error;}
