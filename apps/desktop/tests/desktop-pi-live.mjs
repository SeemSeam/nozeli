// Actual Electron + private Pi Node owners + loopback provider. No user profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {serve} from './pi-provider.fixture.mjs';

const appRoot=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-pi-electron-'));
const config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),projectRoot=path.join(out,'project');
await fs.mkdir(projectRoot);await fs.writeFile(path.join(projectRoot,'reading.txt'),'Pi GUI source stays unchanged.\n');
const host=new DesktopHost(profile),project=(await host.pick(projectRoot)).project;await host.storage.db.close();
 let rejectNext=false;
 const provider=await serve(()=>rejectNext?{status:400,error:{message:'Synthetic context acceptance rejection',type:'invalid_request_error',code:'content_policy_violation'}}:{text:'Pi GUI live response.'});
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
const ozone=process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':process.env.WAYLAND_DISPLAY?'wayland':'headless');
Object.assign(env,{NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_HIDDEN:'0',NOZELI_OZONE:ozone});
const binary=process.env.NOZELI_TEST_BINARY;
let child,exited;
let log='',browser,shell;const errors=[],result={ok:false,out,checks:[],scope:'Actual Electron/Pi owners and real private files; loopback scripted provider, no paid model or personal credentials'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function launch(){
 child=spawn(binary||createRequire(import.meta.url)('electron'),[...(binary?[]:[path.join(appRoot,'src/main/main.cjs')]),'--ozone-platform='+ozone],{cwd:projectRoot,env,stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
 exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
}
async function until(fn,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;if(child.exitCode!==null)throw Error('Electron exited: '+log);await pause(80);}throw Error('Timed out: '+label);}
async function call(page,op,payload={}){const response=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(response.ok,true,op+': '+JSON.stringify(response));return response.value;}
async function surface(kind){return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(kind=>window.__nozeliReady&&window.__workspaceScope?.kind===kind,kind).catch(()=>false))return page;},kind+' content surface');}
try{
 launch();
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'ready shell');
 for(const page of await browser.pages())page.on('pageerror',error=>errors.push(error.message));
 await call(shell,'config.initialize',{mode:'independent'});
 if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
 await call(shell,'settings.providers.save',{operation:'create',provider:'gui-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'},{id:'second'}],credential:{action:'replace',value:'local-nonsecret'}});
 await call(shell,'settings.models.save',{frontdesk:{model:{mode:'explicit',selector:'gui-local/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'gui-local/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'gui-local/scripted'},thinking:{mode:'native-default'}}});
 const status=await call(shell,'settings.providers.status');assert.equal(status.sources.find(row=>row.provider==='gui-local').credential.configured,true);assert.equal(JSON.stringify(status).includes('local-nonsecret'),false);assert.equal(status.sources.find(row=>row.provider==='gui-local').revision,1);
 result.checks.push('real settings IPC saves private Pi endpoint and three-role defaults without exposing the test key');
 await shell.click('[data-project-id="'+project.id+'"]');
 await shell.waitForSelector('#workspace-open-conversation:not([disabled])',{visible:true});await shell.click('#workspace-open-conversation');
 const conversation=await surface('conversation');conversation.on('pageerror',error=>errors.push(error.message));
 await conversation.waitForSelector('#managed-collaboration:not([hidden])');
 await conversation.click('#composer');await conversation.type('#composer','KEEP_MODEL_CHANGE_DRAFT');
 await conversation.click('[data-agent-target="frontdesk"] .collaboration-model');await conversation.waitForSelector('.collaboration-dialog[open] input[value="gui-local/second"]');
 await conversation.click('.collaboration-dialog[open] input[value="gui-local/second"]');await conversation.click('.collaboration-dialog[open] .collaboration-model-actions button:last-child');
 await until(async()=>(await call(conversation,'managed.model.options',{projectId:project.id,target:'frontdesk'})).effective?.model==='gui-local/second','target model effective acknowledgement');
 assert.equal(await conversation.$eval('#composer',node=>node.value),'KEEP_MODEL_CHANGE_DRAFT');assert.equal(provider.requests.length,0,'model selection never submits inference');
 await conversation.click('aria/取消');
 const current=await call(conversation,'managed.status',{projectId:project.id}),modelState=await call(conversation,'managed.model.options',{projectId:project.id,target:'frontdesk'});assert.equal(current.state.agents.find(row=>row.target==='frontdesk').model,'gui-local/second');
 const stale=await conversation.evaluate(({projectId,expectedRevision})=>nozeli.invoke('managed.model.set',{projectId,target:'frontdesk',ownerId:'stale-replaced-owner',model:'gui-local/scripted',expectedRevision,requestKey:'stale-native-model-owner'}),{projectId:project.id,expectedRevision:modelState.revision});
 assert.equal(stale.ok,false);assert.equal(stale.error.code,'INTERACTION_STALE');
 assert.equal((await call(conversation,'managed.status',{projectId:project.id})).state.agents.find(row=>row.target==='frontdesk').ownerId,current.state.agents.find(row=>row.target==='frontdesk').ownerId);
 result.checks.push('real conversation target model selection preserves draft and uses confirmed effective model without inference; stale owner is rejected');
 await conversation.click('#composer');await conversation.keyboard.down('Control');await conversation.keyboard.press('a');await conversation.keyboard.up('Control');await conversation.keyboard.press('Backspace');
 const originalInput='  Hello Pi GUI\n\n保留原始空白  ';
 await conversation.click('#composer');await conversation.type('#composer',originalInput);assert.equal(await conversation.$eval('#composer',node=>node.value),originalInput);await conversation.click('#send-message');
 await until(async()=>{const state=(await call(conversation,'managed.status',{projectId:project.id})).state;const job=state.jobs.find(row=>row.text===originalInput);if(job?.status==='failed')throw Error(JSON.stringify(job));return job?.status==='completed';},'Pi GUI exact raw response');
 await conversation.waitForFunction(()=>document.body.textContent.includes('Pi GUI live response.'));
 assert.equal(provider.requests.length,1);assert.equal(provider.errors.length,0);await conversation.screenshot({path:path.join(out,'pi-conversation.png')});
 assert.equal(provider.requests[0].model,'second');const modelHistory=await call(conversation,'managed.timeline.page',{projectId:project.id,limit:100});assert.equal(modelHistory.entries.find(row=>row.speaker==='agent')?.model,'second');
 result.checks.push('real composer input reaches Pi and its original journal reply renders in the native conversation surface');
 const wireText=message=>typeof message.content==='string'?message.content:message.content?.filter(part=>part.type==='text').map(part=>part.text).join('');
 assert.equal(wireText(provider.requests[0].messages.filter(message=>message.role==='user').at(-1)),originalInput,'raw user text must reach the real Pi provider without wrappers');
 const openDetails=async(expectedInput)=>{
  await conversation.$eval('#chat-session-runtime',node=>node.click());
  await conversation.waitForSelector('.session-runtime-dialog[open]');
  await conversation.waitForFunction(()=>!document.querySelector('.session-runtime-actions button:nth-child(4)').disabled);
  assert.equal(await conversation.$eval('.session-context-details',node=>node.open),false);
  await conversation.focus('.session-context-details summary');await conversation.keyboard.press('Enter');
  await conversation.waitForFunction(expected=>document.querySelector('.session-context-details')?.open&&document.querySelector('.session-context-body pre[aria-label="用户原文（已有本地记录）"]')?.textContent===expected,{},expectedInput);
 };
 const closeDetails=async()=>{await conversation.$$eval('.session-runtime-actions button',nodes=>nodes.find(node=>node.textContent==='关闭').click());};
 const assertReadOnly=async(expected)=>{
  for(let i=0;i<3;i++){await conversation.focus('.session-context-details summary');await conversation.keyboard.press('Enter');await conversation.keyboard.press('Enter');}
  await pause(600);
  assert.equal(provider.requests.length,expected,'context inspection must not invoke native inference or provider listing');
  assert.equal(await conversation.$eval('.session-context-body',node=>node.textContent.includes('local-nonsecret')),false,'details must not leak configured credentials');
 };
 await openDetails(originalInput);
 assert.equal(await conversation.$$eval('.session-context-body pre',nodes=>nodes.find(node=>node.getAttribute('aria-label')==='用户原文（已有本地记录）')?.textContent),originalInput);
 assert.ok(await conversation.$eval('.session-context-body',node=>node.textContent.includes('三层证据')&&node.textContent.includes('字节不等于 token')));
 await assertReadOnly(1);await conversation.screenshot({path:path.join(out,'context-details-original-light.png')});await closeDetails();
 result.checks.push('original conversation details preserve raw input and distinguish prepared/native/provider evidence with zero inference on keyboard toggles');
 // Exercise the real mounted composer with a serialized synthetic draft only.
 // No image object is registered, previewed or sent; this checks text separation,
 // not image delivery (the native send checks below use the real reply action).
 const draftBefore=(await call(conversation,'managed.status',{projectId:project.id})).state.drafts;
 const materialSnapshot=await conversation.evaluate(()=>{
  const api=window.__composerMaterials,composer=document.getElementById('composer'),saved=api.snapshotPersist(),savedText=composer.value;
  const raw='  原始问题\n\n保留空白  ',quote='  完整引用\n'+('超过两百字的引用不可截断。'.repeat(30))+'\n结尾  ',question='  请解释标记\n不要混入用户输入  ';
  const seed={pending:[{key:'drawing-snapshot-only',deliveryId:'snapshot-only',source:'drawing',status:'ok',name:'synthetic-snapshot-only.png',mime:'image/png',kind:'image',size:1,frozenText:question,sources:[]}],quote:{role:'assistant',time:'12:34',text:quote},deliveredDrawingIds:['snapshot-only']};
  try{
   api.restore(seed);composer.value=raw;
   const before=JSON.stringify(api.snapshotPersist()),snapshot=api.snapshot(),after=JSON.stringify(api.snapshotPersist());
   // Simulate the existing cold-draft JSON boundary without new persistence.
   api.restore(JSON.parse(before));
   const restored=api.snapshot(),restoredPersist=JSON.stringify(api.snapshotPersist());
   return {raw,quote,question,before,after,snapshot,restored,restoredPersist};
  }finally{api.restore(saved);composer.value=savedText;}
 });
 assert.equal(materialSnapshot.snapshot.text,materialSnapshot.raw);
 assert.deepEqual(materialSnapshot.snapshot.textMaterials,[{kind:'reply-quote',text:materialSnapshot.quote,title:'回复 前台 12:34'},{kind:'drawing-question',text:materialSnapshot.question,title:'涂鸦问题'}]);
 assert.equal(materialSnapshot.before,materialSnapshot.after,'reading snapshot cannot mutate persisted draft shape');
 assert.equal(materialSnapshot.before,materialSnapshot.restoredPersist,'existing serialized draft roundtrip retains full source data');
 assert.deepEqual(materialSnapshot.snapshot,materialSnapshot.restored);
 assert.deepEqual((await call(conversation,'managed.status',{projectId:project.id})).state.drafts,draftBefore,'snapshot inspection leaves durable user draft unchanged');
 assert.equal(provider.requests.length,1,'synthetic snapshot inspection never sends an image or starts inference');
 result.checks.push('production composer separates full quote and drawing question from raw input, preserves serialized draft roundtrip and durable draft, with zero inspection inference');
 // Use the actual original-message reply action, not a fabricated IPC payload.
 await conversation.$$eval('.message-actions',menus=>{const menu=menus.find(node=>node.closest('article')?.textContent.includes('Pi GUI live response.'));if(!menu)throw Error('Original native reply action not found');menu.querySelector('summary')?.click();});
 await conversation.waitForSelector('.message-actions[open] [data-message-action="quote"]');
 await conversation.$$eval('.message-actions[open] [data-message-action="quote"]',buttons=>{const button=buttons.find(node=>node.closest('article')?.textContent.includes('Pi GUI live response.'));if(!button)throw Error('Original native reply action not found');button.click();});
 await conversation.waitForFunction(()=>!document.querySelector('.cm-quote').hidden);
 const quoted=await conversation.evaluate(()=>__composerMaterials.snapshot().textMaterials);
 assert.equal(quoted.length,1);assert.equal(quoted[0].kind,'reply-quote');assert.equal(quoted[0].text,'Pi GUI live response.');
 await conversation.type('#composer','继续');await conversation.click('#send-message');
 await until(async()=>{const state=(await call(conversation,'managed.status',{projectId:project.id})).state;const job=state.jobs.find(row=>row.text==='继续');if(job?.status==='failed')throw Error(JSON.stringify(job));return job?.status==='completed';},'explicit quotation response');
 assert.equal(provider.requests.length,2);
 const quoteRequest=provider.requests[1],plainRequest=provider.requests[0];
 assert.equal(quoteRequest.messages.filter(message=>message.role==='user'&&wireText(message)==='继续').length,1,'quoted material must not wrap or duplicate the raw user input');
 const quoteData=quoteRequest.messages.filter(message=>message.role==='user'&&wireText(message)?.includes('Pi GUI live response.'));
 assert.equal(quoteData.length,1,'explicit quotation enters once as separate native material data');
 assert.deepEqual(quoteRequest.messages.filter(message=>message.role==='system'),plainRequest.messages.filter(message=>message.role==='system'),'quotation cannot become system authority');
 assert.equal(quoteRequest.messages.filter(message=>message.role==='assistant'&&wireText(message)==='Pi GUI live response.').length,1,'original native answer remains in history once');
 await openDetails('继续');await assertReadOnly(2);await closeDetails();
 result.checks.push('actual reply action delivers one explicit quotation separately from raw 继续, preserves original native history and does not elevate material to system authority');
 rejectNext=true;const failedInput='  Synthetic rejected input\nkeep this exact  ';
 await conversation.type('#composer',failedInput);await conversation.click('#send-message');
 await until(async()=>{const state=(await call(conversation,'managed.status',{projectId:project.id})).state;return state.jobs.find(row=>row.text===failedInput)?.status==='failed';},'deterministic provider failure');
 assert.equal(provider.requests.length,3,'provider rejection must not spawn diagnostic model calls');
 assert.equal(wireText(provider.requests[2].messages.filter(message=>message.role==='user').at(-1)),failedInput);
 const failedState=(await call(conversation,'managed.status',{projectId:project.id})).state;
 assert.equal(failedState.jobs.length,3,'only the three explicit sends create jobs');
 await openDetails(failedInput);
 await conversation.waitForFunction(()=>document.querySelector('.session-context-body')?.textContent.includes('failed'));
 assert.equal(await conversation.$$eval('.session-context-body pre',nodes=>nodes.find(node=>node.getAttribute('aria-label')==='用户原文（已有本地记录）')?.textContent),failedInput);
 const failedOptions=await call(conversation,'managed.session.options',{projectId:project.id,target:'frontdesk',ownerId:current.state.agents.find(row=>row.target==='frontdesk').ownerId});
 assert.equal(failedOptions.contextDetails.lastRequest.status,'failed');assert.ok(failedOptions.contextDetails.diagnostics.providerFailures.length>0,'classified failure metadata is available locally');
 assert.notEqual(failedOptions.contextDetails.lastRequest.evidence.stage,'prepared','native/provider rejection is not a claim of unsubmitted input');
 await assertReadOnly(3);
 await call(shell,'settings.appearance.save',{theme:'dark',palette:'sage',font:'system',size:13});
 await conversation.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 for(const width of [390,190]){
  await conversation.setViewport({width,height:844});
  const geometry=await conversation.$eval('.session-runtime-dialog',node=>({width:node.getBoundingClientRect().width,viewport:innerWidth,scroll:node.scrollWidth,client:node.clientWidth,bodyScroll:node.querySelector('.session-context-body').scrollWidth,bodyClient:node.querySelector('.session-context-body').clientWidth}));
  assert.ok(geometry.width<=geometry.viewport&&geometry.scroll<=geometry.client+1&&geometry.bodyScroll<=geometry.bodyClient+1,JSON.stringify(geometry));
  await conversation.screenshot({path:path.join(out,`context-details-failed-dark-${width}.png`)});
 }
 await conversation.setViewport(null);await assertReadOnly(3);await closeDetails();
 assert.deepEqual((await call(conversation,'managed.status',{projectId:project.id})).state.jobs.map(row=>row.id),failedState.jobs.map(row=>row.id));
 result.checks.push('real provider rejection remains a failed request with local metadata, zero diagnosis fanout, secret-free context details and 390/190px dark screenshots');
 assert.equal(await fs.readFile(path.join(projectRoot,'reading.txt'),'utf8'),'Pi GUI source stays unchanged.\n');
 await conversation.click('#composer');await conversation.type('#composer','Unsent Pi GUI draft');
 await conversation.waitForFunction(()=>document.querySelector('#composer').value==='Unsent Pi GUI draft');
 await call(shell,'session.requestClose');await until(async()=>child.exitCode!==null||await shell.$eval('#quit-choice',node=>node.open).catch(()=>false),'native close or explicit cancellation confirmation');if(child.exitCode===null)await shell.click('#quit-cancel');result.exit=await Promise.race([exited,pause(15000).then(()=>null)]);assert.deepEqual(result.exit,{code:0,signal:null});
 result.checks.push('normal Electron close confirms private Pi owner exit and preserves original source');
 await browser.disconnect();browser=null;launch();
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'cold CDP');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'cold shell');
 await shell.click('[data-project-id="'+project.id+'"]');
 await shell.waitForSelector('#workspace-open-conversation:not([disabled])',{visible:true});await shell.click('#workspace-open-conversation');
 const reopened=await surface('conversation');await reopened.waitForFunction(()=>document.querySelector('#composer').value==='Unsent Pi GUI draft');
 assert.equal(provider.requests.length,3,'cold restore must not replay accepted or rejected model input');
 result.checks.push('cold Electron restart restores the unsent native conversation draft without replaying the previous Pi request');
 await call(shell,'session.requestClose');await until(async()=>child.exitCode!==null||await shell.$eval('#quit-choice',node=>node.open).catch(()=>false),'cold native close or explicit cancellation confirmation');if(child.exitCode===null)await shell.click('#quit-cancel');assert.deepEqual(await Promise.race([exited,pause(15000).then(()=>null)]),{code:0,signal:null});
 assert.deepEqual(errors,[]);result.ok=true;
}catch(error){
 result.error=error.stack;process.exitCode=1;
 if(browser)for(const page of await browser.pages()){
  // Synthetic project only; collect allowlisted local facts, never raw options/diagnostics.
  if(await page.evaluate(()=>window.__workspaceScope?.kind==='conversation').catch(()=>false)){
   result.contextFailure=await page.evaluate(async projectId=>{
    const response=await nozeli.invoke('managed.session.options',{projectId,target:'frontdesk'}),value=response.ok?response.value?.contextDetails:null,request=value?.lastRequest;
    return {optionsOk:response.ok,optionsErrorCode:response.error?.code,available:!!value,jobId:request?.jobId,status:request?.status,userText:{chars:request?.userText?.chars,digest:request?.userText?.digest,exactPresent:typeof request?.userText?.exact==='string'},evidence:{stage:request?.evidence?.stage,nativeEntryId:request?.evidence?.nativeEntry?.id,captured:request?.evidence?.nativeContext?.captured,providerObserved:request?.evidence?.providerObserved},detailsOpen:document.querySelector('.session-context-details')?.open,detailsText:document.querySelector('.session-context-body')?.textContent?.replaceAll('local-nonsecret','[redacted fixture credential]')};
   },project.id).catch(snapshotError=>({snapshotError:snapshotError.message}));
  }
  await Promise.race([page.screenshot({path:path.join(out,'failure-'+page.target()._targetId+'.png')}).catch(()=>{}),pause(2000)]);
 }
}
finally{
 await browser?.disconnect();if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 await provider.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify({...result,errors,requests:provider.requests},null,2));await fs.writeFile(path.join(out,'main.log'),log);console.log(JSON.stringify(result,null,2));
}
