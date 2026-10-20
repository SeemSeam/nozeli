import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';

// Reopen retained completed real-zai history. No prompt or paid model request.
// Usage: node tests/omp-native-recovery-live.mjs RELEASE PROFILE PROJECT EVIDENCE
const [release,profile,project,evidence]=process.argv.slice(2).map(p=>p&&path.resolve(p));
assert(release&&profile&&project&&evidence,'release profile project evidence required');
await fs.mkdir(evidence,{recursive:true});
const projectId=createHash('sha256').update(project).digest('hex');
const facts=[];const record=(name,detail)=>{facts.push({name,...detail});console.log(name,JSON.stringify(detail));};
const wait=async(fn,label,ms=60000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,200));}throw Error('timeout: '+label);};
const invoke=async(page,op,payload={})=>{const r=await page.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});if(!r?.ok)throw Object.assign(Error(r?.error?.message||op+' failed'),{code:r?.error?.code});return r.value;};
const get=page=>invoke(page,'managed.status',{projectId});
async function launch(){
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>r(n));});});
 // No HOME, service, model, key, or OMP source injection. OS account home is used.
 const env={PATH:process.env.PATH,DISPLAY:process.env.DISPLAY||':0',LANG:'C.UTF-8',XAUTHORITY:process.env.XAUTHORITY,
  XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:evidence,NOZELI_TEST_PICK:project+'\n'+path.join(evidence,'project-b'),NOZELI_TEST_INSTANCE:'1',NOZELI_HIDDEN:'0'};
 const child=spawn(path.join(release,'nozeli'),['--ozone-platform=x11'],{env,cwd:os.userInfo().homedir,stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',d=>{log=(log+d).slice(-8000);});child.stderr.on('data',d=>{log=(log+d).slice(-8000);});
 const exit=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 await wait(async()=>{try{return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'visible Electron devtools');
 const browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null,protocolTimeout:60000});
 const page=(await browser.pages()).find(p=>p.url().includes('127.0.0.1'));
 try{
 await page.waitForFunction(()=>window.__nozeliReady===true);
 await page.evaluate(id=>{const item=document.querySelector(`[data-project-id="${id}"]`);if(item)item.click();},projectId);
 await invoke(page,'project.open',{projectId});
 await invoke(page,'managed.connect',{projectId});
 await wait(async()=>{const s=await get(page);return s.ready&&s.state? s:null;},'retained project ready',120000);
 return {child,exit,browser,page,log:()=>log};
 }catch(error){
  try{await invoke(page,'session.requestClose');await Promise.race([exit,new Promise(r=>setTimeout(r,5000))]);}finally{await browser.disconnect();}
  throw error;
 }
}
async function close(app){
 const owned=[];
 const collect=async pid=>{let children='';try{children=await fs.readFile(`/proc/${pid}/task/${pid}/children`,'utf8');}catch{return;}for(const child of children.trim().split(/\s+/).filter(Boolean).map(Number)){owned.push({pid:child,stamp:await processStamp(child)});await collect(child);}};
 await collect(app.child.pid);
 await invoke(app.page,'session.requestClose');
 let deadline;let result;try{result=await Promise.race([app.exit,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('normal close timeout')),45000);})]);}finally{clearTimeout(deadline);}assert.equal(result.code,0);
 await wait(async()=>{for(const child of owned)if(child.stamp&&await processStamp(child.pid)===child.stamp)return false;return true;},'owned provider and broker descendants reaped');
 await app.browser.disconnect();return {...result,ownedDescendants:owned.length,descendantsExited:true};
}
let app;
try{
 app=await launch();const first=await get(app.page);const baseline=first.state;
 assert.equal(baseline.quotaUsed,0);assert(baseline.works.length&&baseline.works.every(w=>w.status==='ended'));
 assert(baseline.jobs.every(j=>!['running','queued'].includes(j.status)),'recovery must not admit or replay unresolved jobs');
 const jobs=baseline.jobs.map(j=>j.id);const ids=Object.fromEntries(['frontdesk','orchestrator'].map(r=>[r,baseline.residents[r].threadId]));
 record('retained-real-closure',{jobs:jobs.length,quota:baseline.quotaUsed,works:baseline.works.map(w=>({id:w.id,status:w.status,revision:w.revision}))});
 await app.page.evaluate(()=>window.dispatchEvent(new CustomEvent('nozeli-open-settings',{detail:'settings-agents'})));
 await app.page.waitForSelector('#settings-dialog[open] #settings-agents:not([hidden])');
 const surface=await app.page.evaluate(()=>({limits:document.querySelectorAll('#settings-agents input[type=number]').length,legacy:document.querySelectorAll('[data-managed-provider],[data-managed-model],[data-managed-effort],#managed-load-models,#managed-omp-service,#agent-omp-service-config').length}));
 assert.equal(surface.limits,2);assert.equal(surface.legacy,0);
 await invoke(app.page,'session.capture',{name:'unified-agent-quota-settings'});
 await app.page.evaluate(()=>document.querySelector('#settings-close').click());record('provider-only-visible-surface',surface);
 const projectB=path.join(evidence,'project-b');await fs.mkdir(projectB,{recursive:true});await fs.writeFile(path.join(projectB,'readme.md'),'Independent native restart isolation project.\n');
 const idB=createHash('sha256').update(projectB).digest('hex');
 await invoke(app.page,'project.pick',{directory:projectB});
 await invoke(app.page,'managed.enable',{projectId:idB,provider:'omp'});
 await app.page.reload({waitUntil:'domcontentloaded'});await app.page.waitForFunction(()=>window.__nozeliReady===true);
 for(const id of [idB,projectId]){await app.page.waitForSelector(`[data-project-id="${id}"]`);await app.page.evaluate(id=>document.querySelector(`[data-project-id="${id}"]`).click(),id);await wait(()=>app.page.evaluate(id=>document.querySelector(`[data-project-id="${id}"]`)?.getAttribute('aria-current')==='true',id),'project rail switch');}
 const b=await invoke(app.page,'managed.status',{projectId:idB});const a=await get(app.page);
 assert.notEqual(a.runtimeRoot,b.runtimeRoot);assert.equal(b.state.jobs.length,0);assert.deepEqual(a.state.jobs.map(j=>j.id),jobs);
 assert.equal(a.state.residents.frontdesk.threadId,ids.frontdesk);
 record('project-rail-roundtrip-isolation',{distinctRoots:true,projectBZeroModelJobs:true,projectAHistoryPreserved:true});
 for(const target of ['frontdesk','orchestrator']){
  for(const mode of ['normal','abnormal']){
   let s=await get(app.page);const owner=s.state.providers[target];assert(owner?.pid&&owner.home.startsWith(profile+path.sep));
   const oldStamp=await processStamp(owner.pid);assert(oldStamp);
   const terminal=await invoke(app.page,'managed.terminal.attach',{projectId,target});
   if(target==='frontdesk'&&mode==='normal'){
    await invoke(app.page,'managed.terminal.input',{projectId,target,terminalId:terminal.terminalId,data:'/switch zai/glm-4.7:medium\r'});
    await wait(async()=>{const x=await get(app.page);const native=x.state.agents.find(a=>a.target===target);return native?.effective?.model==='zai/glm-4.7'&&native?.effective?.effort==='medium';},'native selection observed');
    assert.deepEqual((await get(app.page)).state.jobs.map(j=>j.id),jobs,'native slash must not dispatch a model turn');
   }
   if(mode==='normal')await invoke(app.page,'managed.terminal.input',{projectId,target,terminalId:terminal.terminalId,data:'\x04'});
   else process.kill(owner.pid,'SIGKILL');
   await wait(async()=>{const next=await get(app.page);return next.state.agents.find(a=>a.target===target)?.closed;},target+' exit');
   await assert.rejects(invoke(app.page,'managed.terminal.input',{projectId,target,terminalId:terminal.terminalId,data:'stale'}));
   if(mode==='normal'){
    await wait(()=>app.page.evaluate(target=>Boolean(document.querySelector(`[data-managed-terminal="${target}"] [data-terminal-recovery]`)),target),'visible restart action');
    await invoke(app.page,'session.capture',{name:target+'-native-exit-restart-action'});
    await app.page.click(`[data-managed-terminal="${target}"] [data-terminal-recovery]`);
    await wait(async()=>{const next=await get(app.page);const agent=next.state.agents.find(a=>a.target===target);return next.state.providers[target]?.pid&&next.state.providers[target].pid!==owner.pid&&agent&&!agent.closed&&!agent.restarting;},'visible restart completed');
   }else{
    const receipts=await Promise.all([invoke(app.page,'managed.restart',{projectId,target}),invoke(app.page,'managed.restart',{projectId,target})]);
    assert.equal(receipts[0].threadId,ids[target]);assert.equal(receipts[1].threadId,ids[target]);
   }
   s=await get(app.page);assert.equal(s.state.residents[target].threadId,ids[target]);assert.notEqual(s.state.providers[target].pid,owner.pid);
   assert.notEqual(await processStamp(owner.pid),oldStamp);
   assert.deepEqual(s.state.jobs.map(j=>j.id),jobs);
   if(target==='frontdesk'){assert.equal(s.state.agents.find(a=>a.target===target)?.effective?.model,'zai/glm-4.7');assert.equal(s.state.agents.find(a=>a.target===target)?.effective?.effort,'medium','old low binding must not override native selection');}
   record(target+'-'+mode+'-restart',{sameThread:true,oldOwnerGone:true,jobsUnchanged:true});
  }
 }
 const ended=baseline.works[0];await assert.rejects(invoke(app.page,'managed.restart',{projectId,target:ended.id}));
 const preview=await invoke(app.page,'managed.terminal.screen',{projectId,target:ended.id});assert.equal(preview.available,false);
 record('ended-worker-not-revived',{workId:ended.id});
 await invoke(app.page,'session.capture',{name:'provider-only-native-recovery'});
 const beforeClose=await get(app.page);assert.deepEqual(beforeClose.state.jobs.map(j=>j.id),jobs);
 record('normal-close',await close(app));app=null;
 app=await launch();const reopened=await get(app.page);assert.deepEqual(reopened.state.jobs.map(j=>j.id),jobs);assert.equal(reopened.state.quotaUsed,0);
 for(const target of ['frontdesk','orchestrator'])assert.equal(reopened.state.residents[target].threadId,ids[target]);
 assert.equal(reopened.state.agents.find(a=>a.target==='frontdesk')?.effective?.effort,'medium');
 record('cold-reopen-zero-replay',{jobs:jobs.length,quota:0,sameThreads:true});
 record('second-normal-close',await close(app));app=null;
 await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({pass:true,release,facts},null,2));
}catch(error){await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({pass:false,release,facts,error:String(error.stack||error)},null,2));if(app){try{await close(app);}catch{ /* leave owned failure for precise inspection; no global kill */ }}throw error;}
