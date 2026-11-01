import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import net from 'node:net';import http from 'node:http';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import puppeteer from 'puppeteer-core';
// Actual visible Electron switch smoke. Distinct GPT-like and GLM-like source
// IDs mirror the reported case (a saved GLM frontdesk default that still
// displayed GPT). Asserts the real current UI labels (role selects and the
// settings sync status), the read-only session facts model, unchanged old
// conversation history, the exact next HTTP request model, and a cold reopen
// that must not revert the saved frontdesk model. All model traffic goes to a
// loopback-only synthetic server: no real provider, no paid request.
const GPT='gpt-paratera/gpt-6.1-sol',GLM='glm-bingxing/GLM-5.3-Flash';
const reply=model=>'Native verified reply from '+model+'.';
const appRoot=path.resolve(import.meta.dirname,'..'),root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-defaults-electron-')),project=path.join(root,'paper');await fs.mkdir(project);await fs.writeFile(path.join(project,'paper.md'),'# Keep original paper\n');
const pause=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,label,ms=60000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(50);}throw Error('Timeout '+label);}
const requests=[];let held=true,pending=[];const answer=(res,model)=>{res.writeHead(200,{'content-type':'text/event-stream'});for(const delta of [{role:'assistant',content:reply(model)},{}])res.write('data: '+JSON.stringify({id:'native-ui',model,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:delta.content?null:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');};
const server=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{const data=JSON.parse(body);requests.push(data);if(held)pending.push([res,data.model]);else answer(res,data.model);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
let log='',browser,page,projectId,thread;const env={...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_PICK:project,NOZELI_CONFIG_ROOT:path.join(root,'.Nozeli'),NOZELI_USER_DATA:path.join(root,'.Nozeli','desktop'),NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'};
async function startApp(){
 const child=spawn(createRequire(import.meta.url)('electron'),[path.join(appRoot,'src/main/main.cjs'),'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{cwd:appRoot,env,stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',c=>log+=c);
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{if(child.exitCode!==null)throw Error(log);return false;}},'Electron debug connection');
 page=await(await browser.waitForTarget(t=>t.type()==='page'&&t.url().startsWith('http://127.0.0.1:'),{timeout:90000})).page();await page.waitForFunction(()=>window.__nozeliReady);
 return {child,exited:new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})))};
}
async function stopApp(handle){
 held=false;for(const [res,model]of pending.splice(0))answer(res,model);
 if(page&&!page.isClosed())await Promise.race([page.evaluate(()=>nozeli.invoke('session.requestClose',{})).catch(()=>{}),pause(2000)]);
 if(handle){
  const {child,exited}=handle;
  if(child.exitCode===null){await Promise.race([exited,pause(8000)]);if(child.exitCode===null)child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 }
 await browser?.disconnect();browser=null;page=null;
}
let app;try{
 app=await startApp();
 const invoke=async(op,payload={})=>{const r=await page.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);assert(r.ok,r.error?.message);return r.value;};
 // Current startup never assumes the configuration wizard (autoOpen:false in
 // agent-panel): initialize through the same IPC the dialog uses, then only
 // cancel the dialog if one is actually open (desktop-pi-live convention).
 await invoke('config.initialize',{mode:'independent'});
 if(await page.$eval('#configuration-setup',node=>node.open).catch(()=>false)){await page.click('#configuration-cancel');await page.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
 const add=async(provider,model)=>{await invoke('settings.providers.save',{operation:'create',provider,baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',api:'openai-completions',models:[{id:model}],credential:{action:'replace',value:'synthetic-local-only'}});};
 const openModels=async()=>{await page.click('#open-settings');await page.waitForSelector('#settings-dialog[open]');await page.click('[data-settings-section="settings-models"]');};
 const choose=async selector=>{await page.waitForSelector('[data-default-role="frontdesk"] option[value="'+selector+'"]');for(const role of ['frontdesk','orchestrator','worker'])await page.select('[data-default-role="'+role+'"]',selector);await page.click('[data-role-model-form] button[type="submit"]');await page.waitForFunction(()=>document.querySelector('[data-model-status]').textContent.includes('已保存'));};
 const state=async()=>(await invoke('managed.status',{projectId})).state;
 const conversationPage=async()=>{for(const candidate of await browser.pages()){if(!candidate.url().startsWith('http://127.0.0.1:'))continue;const scope=await candidate.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope?.kind==='conversation'&&scope.projectId===projectId)return candidate;}throw Error('conversation surface unavailable');};
 const send=async text=>{const chat=await conversationPage();await chat.waitForFunction(()=>!document.querySelector('#send-message').disabled);await chat.$eval('#composer',(e,text)=>{e.value=text;e.dispatchEvent(new Event('input',{bubbles:true}));},text);await chat.click('#send-message');};

 const historyText=async()=>{const chat=await conversationPage();return chat.evaluate(()=>document.body.textContent);};
 const occurrences=async model=>((await historyText()).split(reply(model)).length-1);
 const selectLabel=async role=>page.$eval('[data-default-role="'+role+'"]',e=>e.selectedOptions[0]?.textContent||'');
 const modelStatus=async()=>page.$eval('[data-model-status]',e=>e.textContent);
 const assertCurrentUiLabelsGlm=async where=>{for(const role of ['frontdesk','orchestrator','worker']){assert.equal(await page.$eval('[data-default-role="'+role+'"]',e=>e.value),GLM,where+': '+role+' select holds the GLM selector');assert.match(await selectLabel(role),/GLM-5\.3-Flash/,where+': '+role+' visible label shows GLM');assert.doesNotMatch(await selectLabel(role),/gpt-6\.1-sol/,where+': '+role+' visible label must not show the old GPT model');}const status=await modelStatus();assert.doesNotMatch(status,/gpt-6\.1-sol/,where+': settings status must not present GPT as current');await page.screenshot({path:path.join(root,where+'-glm-ui-label.png')});return status;};
 await openModels();await page.waitForFunction(()=>/尚无(可用|目录)模型/.test(document.querySelector('[data-model-catalog-status]').textContent));assert.equal(await page.$eval('[data-default-role="frontdesk"]',e=>e.disabled),true);assert.equal(await page.$eval('[data-role-model-form] button[type="submit"]',e=>e.disabled),true);await page.screenshot({path:path.join(root,'empty-model-catalog.png')});await page.click('[data-model-configure-source]');await page.waitForFunction(()=>!document.querySelector('#settings-provider').hidden);await page.click('#settings-close');
 await add('gpt-paratera','gpt-6.1-sol');await openModels();await choose(GPT);await page.click('#settings-close');await page.click('#pick-project');await page.waitForFunction(()=>document.querySelector('#project-name').textContent==='paper');projectId=(await invoke('project.recent')).projects.find(p=>p.name==='paper').id;
 // Current behavior: opening a project never auto-starts Agents — the
 // conversation must be explicitly opened first (desktop-pi-live convention),
 // and only then do residents become ready.
 await page.waitForSelector('#workspace-open-conversation:not([disabled])',{visible:true});await page.click('#workspace-open-conversation');
 await until(async()=>{try{return Boolean(await conversationPage());}catch{return false;}},'conversation surface mount');
 await until(async()=>(await invoke('managed.status',{projectId})).ready,'native residents');
 const initial=await state();thread=initial.agents.find(a=>a.target==='frontdesk').threadId;assert(initial.agents.filter(a=>['frontdesk','orchestrator'].includes(a.target)).every(a=>a.model===GPT));
 await send('仅回复确认，不使用工具。');await until(()=>requests.length===1,'real GPT request');assert.equal(requests[0].model,'gpt-6.1-sol');const chat=await conversationPage();await chat.$eval('#composer',e=>{e.value='KEEP_UNSENT_DRAFT';e.dispatchEvent(new Event('input',{bubbles:true}));});

 await add('glm-bingxing','GLM-5.3-Flash');await openModels();await choose(GLM);await until(async()=>{const s=await state();return s.agents.find(a=>a.target==='orchestrator')?.model===GLM&&s.agents.find(a=>a.target==='frontdesk')?.pendingModel;},'idle verified switch and busy pending');const during=await state();assert.equal(during.agents.find(a=>a.target==='frontdesk').model,GPT);assert.equal(during.jobs[0].status,'running');assert.equal(during.agents.find(a=>a.target==='frontdesk').threadId,thread);assert.equal(await chat.$eval('#composer',e=>e.value),'KEEP_UNSENT_DRAFT');assert.match(await modelStatus(),/待/);await page.screenshot({path:path.join(root,'pending-model-switch.png')});
 held=false;for(const [res,model]of pending.splice(0))answer(res,model);await until(async()=>{const s=await state();return s.jobs[0].status==='completed'&&s.agents.find(a=>a.target==='frontdesk')?.model===GLM&&!s.busyTargets.length;},'safe GLM application');await page.click('#settings-close');assert.equal(await chat.$eval('#composer',e=>e.value),'KEEP_UNSENT_DRAFT');
 // Old GPT history stays identical after the switch: still present, exactly
 // once, never replayed, rewritten or relabeled by the model change.
 assert.equal(await occurrences('gpt-6.1-sol'),1,'old GPT reply preserved exactly once after switch');
 await send('再次仅回复确认，不使用工具。');await until(async()=>{const s=await state();return s.jobs.length===2&&s.jobs.every(j=>j.status==='completed')&&!s.busyTargets.length;},'second native round');const after=await state();assert.equal(requests.length,2);assert.deepEqual(requests.map(r=>r.model),['gpt-6.1-sol','GLM-5.3-Flash']);assert.equal(after.agents.find(a=>a.target==='frontdesk').threadId,thread);assert.deepEqual(after.jobs.map(j=>j.effective?.model),[GPT,GLM]);assert.equal(await fs.readFile(path.join(project,'paper.md'),'utf8'),'# Keep original paper\n');
 await until(async()=>(await occurrences('GLM-5.3-Flash'))===1,'GLM reply rendered in history');assert.equal(await occurrences('gpt-6.1-sol'),1,'old GPT reply unchanged after the GLM round');
 await openModels();await until(async()=>!(await modelStatus()).includes('待当前'),'pending state refresh');const appliedStatus=await assertCurrentUiLabelsGlm('applied');assert.match(appliedStatus,/GLM-5\.3-Flash/,'settings status presents GLM as the current model');await page.click('#settings-close');
 // Read-only session facts (会话管理) must report the live model, not the
 // pre-switch one, without waking or mutating the session.
 await chat.click('#chat-session-runtime');await chat.waitForSelector('.session-runtime-dialog[open]');
 await until(async()=>(await chat.$eval('.session-runtime-dialog pre',e=>e.textContent)).includes(GLM),'session facts report the GLM model');
 const facts=await chat.$eval('.session-runtime-dialog pre',e=>e.textContent);assert.ok(!facts.includes(GPT),'session facts must not report the stale GPT model');await chat.screenshot({path:path.join(root,'session-runtime-model-facts.png')});
 await chat.$$eval('.session-runtime-actions button',bs=>bs.find(b=>b.textContent==='关闭')?.click());await chat.waitForFunction(()=>!document.querySelector('.session-runtime-dialog')?.open);
 // ===== cold reopen: the saved GLM default must not revert to GPT =====
 await stopApp(app);
 app=await startApp();
 if(await page.$eval('#configuration-setup',node=>node.open).catch(()=>false)){await page.click('#configuration-cancel');await page.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
 await page.click('#pick-project');await page.waitForFunction(()=>document.querySelector('#project-name').textContent==='paper');projectId=(await invoke('project.recent')).projects.find(p=>p.name==='paper').id;
 await page.waitForSelector('#workspace-open-conversation:not([disabled])',{visible:true});await page.click('#workspace-open-conversation');
 await until(async()=>{try{return Boolean(await conversationPage());}catch{return false;}},'cold conversation surface mount');
 await until(async()=>(await invoke('managed.status',{projectId})).ready,'cold residents',90000);
 const coldFront=(await state()).agents.find(a=>a.target==='frontdesk');assert.equal(coldFront.model,GLM,'cold reopen keeps GLM as the frontdesk model (no GPT revert)');assert.equal(coldFront.threadId,thread,'cold reopen preserves the original native thread');
 await until(async()=>(await occurrences('gpt-6.1-sol'))===1&&(await occurrences('GLM-5.3-Flash'))===1,'cold reopen keeps both historical replies exactly once');await page.screenshot({path:path.join(root,'cold-reopen-history.png')});
 await openModels();await page.waitForSelector('[data-default-role="frontdesk"] option[value="'+GLM+'"]');await until(async()=>!(await modelStatus()).includes('待当前'),'cold pending refresh');await assertCurrentUiLabelsGlm('cold-reopen');await page.click('#settings-close');
 assert.equal(requests.length,2,'cold reopen sends no model request');
 console.log(JSON.stringify({pass:true,root,requests:requests.map(r=>r.model),thread,coldReopen:{frontdeskModel:coldFront.model,historyGptPreserved:true},scope:'actual visible Electron save with distinct GPT/GLM-like IDs, real UI label assertions (role selects, sync status, read-only session facts), old GPT history unchanged, exact GLM next request, cold reopen without GPT revert, original native thread, unsent GUI draft and original file retained'}));
 }catch(error){
  console.error(error);process.exitCode=1;
  // Redacted host DTOs only: allowlisted scalar fields from managed.status
  // plus visible UI status text; never raw native output, never secrets.
  let diagnostics=null;
  try{
   diagnostics=page&&!page.isClosed()?await page.evaluate(async projectId=>{
    const managed=await nozeli.invoke('managed.status',{projectId}).catch(error=>({ok:false,error:{code:error?.code??null,message:error?.message??String(error)}}));
    return {managed:managed.ok?{ready:managed.value?.ready??null,enabled:managed.value?.enabled??null,agents:(managed.value?.state?.agents??[]).map(agent=>({target:agent.target,phase:agent.phase??null,starting:agent.starting??false,busy:agent.busy??false,closed:agent.closed??false,model:agent.model??null,desiredModel:agent.desiredModel??null,pendingModel:agent.pendingModel??null,modelError:agent.modelError??null}))}:managed.error,ui:{modelStatus:document.querySelector('[data-model-status]')?.textContent??null,catalog:document.querySelector('[data-model-catalog-status]')?.textContent??null,aiStatus:document.querySelector('#ai-status')?.textContent??null}};
   },projectId).catch(capture=>({captureError:String(capture?.message??capture)})):null;
  }catch{}
  await fs.writeFile(path.join(root,'failure.txt'),JSON.stringify({stack:String(error?.stack||error),diagnostics},null,2));
}finally{
 await stopApp(app).catch(()=>{});
 server.closeAllConnections();await new Promise(r=>server.close(r));await fs.writeFile(path.join(root,'electron.log'),log);
}
