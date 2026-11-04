// Opt-in real Electron + private Pi manual task-control scenario: production
// work menu, control dialog, capability gating, real bash side effects, real
// 402 service fault with the top banner (including a native drag), release and
// queue re-kick. Scripted loopback provider only; no paid model, no real
// accounts, no browser-fake acceptance — every check clicks the shipped UI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {DesktopHost} from '../src/main/host.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
import {serve} from './pi-provider.fixture.mjs';

const appRoot=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-agent-control-ui-'));
const root=path.join(out,'project'),config=path.join(out,'private'),profile=path.join(config,'desktop');
await fs.mkdir(root,{recursive:true});
await fs.writeFile(path.join(root,'paper.txt'),'Original synthetic source.\n');
await fs.writeFile(path.join(root,'.gitignore'),'/.nozeli/\n/build/\n');
const git=async(...args)=>(await runGit(root,args)).toString().trim();
await git('init','-b','main');await git('config','user.name','Synthetic Control UI');await git('config','user.email','control-ui@localhost');await git('add','--all');await git('commit','-m','Synthetic baseline');
const seed=new DesktopHost(profile),registered=await seed.requireRegisteredProject((await seed.pick(root)).project.id),projectId=registered.id,instanceId=registered.instanceId;
await seed.storage.db.close();
const lineDelayMs=70;
const longScript=`i=0; while [ ! -f control-release ]; do i=$((i+1)); printf 'ui progress %s\\n' $i >> ui-progress.log; sleep ${(lineDelayMs/1000).toFixed(3)}; done`;
const port=await new Promise(resolve=>{const socket=net.createServer();socket.listen(0,'127.0.0.1',()=>{const value=socket.address().port;socket.close(()=>resolve(value));});});
let child,exited,browser,shell,conversation,log='';
const errors=[],checks=[];
const result={ok:false,out,checks,scope:'Actual Electron production host/UI, real private Pi owners, real bash side effects and a real loopback 402 service fault; no paid model or personal credentials'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){if(provider.errors.length)throw provider.errors[0];const value=await fn();if(value)return value;if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Electron exited: '+log.slice(-1500));await pause(60);}throw Error('Timed out: '+label);}
async function call(op,payload={},page=shell){const reply=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(reply.ok,true,op+': '+JSON.stringify(reply.error));return reply.value;}
const state=async()=>(await call('managed.status',{projectId},conversation)).state;
const controlStatus=async workId=>call('managed.work.control.status',{projectId,workId},conversation);
async function openControlDialog(page,workId,command){
  if(await page.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')==='false'))await page.click('#toggle-sidebar');
  result.stage='right-click '+command;
  await page.locator('[data-managed-work="'+workId+'"] .managed-work-open').click({button:'right'});
  result.stage='wait menu '+command;
  await page.waitForSelector('#managed-work-menu:not([hidden])',{visible:true});
  result.stage='choose '+command;
  await page.locator('#managed-work-menu [data-command="'+command+'"]').click();
  result.stage='wait dialog '+command;
  await page.waitForSelector('[aria-label="任务执行控制"][open]',{visible:true});
}
let failUiFault=true;
const uiSteps=new Map();const step=key=>uiSteps.set(key,(uiSteps.get(key)??0)+1);
const provider=await serve(async request=>{
  assert(provider.requests.length<64,'bounded native/model flow');
  const text=request.messages.map(message=>typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('\n')).join('\n');
  const names=request.tools?.map(tool=>tool.function?.name)??[];
  if(names.includes('nozeli_dispatch')&&/UI-CONTROL/.test(text)){
    const marker=[...text.matchAll(/UI-CONTROL (UI-LONG|UI-FAULT|UI-GATE):/g)].at(-1)?.[1];
    return {id:'dispatch-'+marker,tool:'nozeli_dispatch',args:{name:'Work '+marker,brief:`Scenario ${marker}: use native bash for the assigned real file work, then publish once. Marker ${marker} identifies this Work.`}};
  }
  if(names.includes('nozeli_publish')){
    const marker=[...text.matchAll(/Marker (UI-LONG|UI-FAULT|UI-GATE)/g)].map(row=>row[1]).at(-1);
    if(marker==='UI-FAULT'||marker==='UI-GATE'){
      if(marker==='UI-FAULT'&&failUiFault)return {status:402,error:{message:'insufficient balance',type:'insufficient_balance'}};
      step('ui-fault');
      if(uiSteps.get('ui-fault')===1)return {id:'ui-fault-recover-bash',tool:'bash',args:{command:"printf 'ui fault recovered\\n' > ui-recovered.txt"}};
      return {id:'ui-fault-publish',tool:'nozeli_publish',args:{kind:'result',content:'<h1>Recovered after release</h1><p>The original queued input resumed without any synthesized prompt.</p>',files:[]}};
    }
    if(marker==='UI-LONG'){
      step('ui-long');
      if(uiSteps.get('ui-long')===1)return {id:'ui-long-bash',tool:'bash',args:{command:longScript}};
      throw Error('UI-LONG worker must never get a second turn after the manual stop');
    }
  }
  return {text:'Host receipts are authoritative. No new business input is synthesized.'};
});
try{
  const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
  Object.assign(env,{NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_HIDDEN:'0',NOZELI_OZONE:process.env.NOZELI_OZONE||'x11'});
  child=spawn(createRequire(import.meta.url)('electron'),[path.join(appRoot,'src/main/main.cjs'),'--ozone-platform='+env.NOZELI_OZONE],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
  browser=await until(()=>import('puppeteer-core').then(module=>module.default.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null})).catch(()=>null),'Electron CDP');
  shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'ready shell');
  for(const page of await browser.pages())page.on('pageerror',error=>errors.push(error.message));
  shell.on('dialog',dialog=>dialog.accept().catch(()=>{}));
  await call('config.initialize',{mode:'independent'});
  if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
  await call('settings.providers.save',{operation:'create',provider:'control-ui-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret'}});
  await call('settings.models.save',Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'explicit',selector:'control-ui-local/scripted'},thinking:{mode:'native-default'}}])));
  await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForSelector('#workspace-open-conversation:not([disabled])');await shell.click('#workspace-open-conversation');
  conversation=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='conversation').catch(()=>false))return page;},'conversation');
  conversation.on('pageerror',error=>errors.push(error.message));
  conversation.on('dialog',dialog=>dialog.accept().catch(()=>{}));
  await conversation.waitForSelector('#managed-collaboration:not([hidden])');
  await conversation.type('#composer','KEEP_UNSENT_CONTROL_DRAFT');

  await call('managed.limit',{projectId,limit:4},conversation);
  // ── 1. capability-gated dialog: pause an admitted tool-running Work ─────
  await call('managed.task',{projectId,text:'UI-CONTROL UI-LONG: run the long real progress script through native bash, then publish.',requestKey:'ui-control-long'},conversation);
  const longWork=await until(async()=>{const value=await state();return value.works.find(work=>work.name==='Work UI-LONG');},'work appears');
  const progressDirectory=await until(async()=>(await state()).works.find(work=>work.id===longWork.id)?.execution?.directory,'Worker execution directory');
  await until(async()=>(await fs.readFile(path.join(progressDirectory,'ui-progress.log'),'utf8').then(value=>value.trim().split('\n').length).catch(()=>0))>=8,'real side effect running');
  const capabilities=await controlStatus(longWork.id);
  assert.equal(capabilities.pause.allowed,true);
  if(!Number.isSafeInteger(capabilities.controlVersion))throw Error('control.status must expose an integer controlVersion');
  await openControlDialog(shell,longWork.id,'control-pause');
  await shell.locator('[aria-label="任务执行控制"] [data-work-control-action="pause"]').click();
  await until(async()=>(await controlStatus(longWork.id)).paused===true,'pause persisted');
  await shell.keyboard.press('Escape');
  const paused=await controlStatus(longWork.id);
  assert.equal(typeof paused.paused,'boolean','status DTO must expose the paused gate as a boolean');
  assert.equal(paused.paused,true,'pause applied through the shipped menu');
  assert.equal(await conversation.$eval('#composer',node=>node.value),'KEEP_UNSENT_CONTROL_DRAFT','draft preserved across control actions');
  checks.push('production work menu pauses a tool-running Work through the control dialog with capabilities and drafts intact');

  // ── 2. stop-current through the dialog with confirm; frozen evidence ────
  await openControlDialog(shell,longWork.id,'control-stop-current');
  await shell.locator('[aria-label="任务执行控制"] [data-work-control-action="stop-current"]').click();
  await until(async()=>{const status=await controlStatus(longWork.id);return status.stop?.state==='confirmed'||status.manualControl?.stop?.state==='confirmed';},'stop confirmed');
  const stopStatus=await controlStatus(longWork.id);
  const stopRecord=stopStatus.stop;
  assert.ok(stopRecord&&stopRecord.exit,'confirmed live stop must carry exit evidence');
  assert.equal(stopRecord.exit.confirmed,true);
  await shell.keyboard.press('Escape');
  const frozen=(await fs.readFile(path.join(progressDirectory,'ui-progress.log'),'utf8')).trim().split('\n').length;
  assert.equal(await fs.stat(path.join(progressDirectory,'control-release')).then(()=>true,()=>false),false,'the producer barrier never opened');
  await pause(3*lineDelayMs);
  assert.equal((await fs.readFile(path.join(progressDirectory,'ui-progress.log'),'utf8')).trim().split('\n').length,frozen,'side effects frozen after confirmed stop');
  const stopped=(await state()).works.find(work=>work.id===longWork.id);
  assert.equal(stopped.status,'paused');
  assert.ok(!(await state()).receipts.some(row=>row.workId===longWork.id&&row.origin==='host-diagnostic'),'no fabricated missing-report recovery');
  checks.push('stop-current confirms exit in the real UI and freezes real side effects without recovery fabrication');

  // ── 3. stale dialog window: late mutation has zero double effect ────────
  await openControlDialog(shell,longWork.id,'control-resume');
  const externalCaps=await controlStatus(longWork.id);
  await call('managed.work.control',{projectId,workId:longWork.id,action:'resume',requestKey:'ui-control-resume-external',expectedProjectInstanceId:instanceId,expectedControlVersion:(()=>{if(!Number.isSafeInteger(externalCaps.controlVersion))throw Error('control.status must expose an integer controlVersion');return externalCaps.controlVersion;})(),expectedWorkRevision:externalCaps.workRevision},conversation);
  await shell.locator('[aria-label="任务执行控制"] [data-work-control-action="resume"]').click().catch(()=>{});
  const afterStale=await controlStatus(longWork.id);
  assert.equal(afterStale.paused,false,'resume applied exactly once');
  await shell.keyboard.press('Escape').catch(()=>{});
  checks.push('a stale control window never double-applies an action already settled elsewhere');

  await shell.locator('[data-managed-work="'+longWork.id+'"] .managed-work-open').click({button:'right'});
  await shell.waitForSelector('#managed-work-menu:not([hidden])',{visible:true});
  await shell.click('#managed-work-menu [data-command="discard"]');
  await shell.waitForSelector('[data-confirmation-dialog][open]',{visible:true});
  assert.match(await shell.$eval('[data-confirmation-dialog]',node=>node.textContent),/Work UI-LONG/);
  await shell.click('[data-confirmation-confirm]');
  await until(async()=>(await state()).works.find(work=>work.id===longWork.id)?.closure?.phase==='complete','task menu discard persists the exact decision and completes cleanup');
  const afterDiscard=await state(),ended=afterDiscard.works.find(work=>work.id===longWork.id);
  assert.equal(ended.outcome,'discard');
  assert.equal(afterDiscard.quotaUsed,0,'complete discard cleanup releases the occupied quota before the Work becomes history');
  assert.equal(uiSteps.get('ui-long'),1,'ending a stopped task never replays its tool-running input');
  checks.push('task menu forwards the explicit discard decision, confirms it and releases quota only after complete cleanup');
  const workFilters=await shell.$$eval('.managed-work-categories>button',nodes=>nodes.filter(node=>node.checkVisibility()).map(node=>node.getBoundingClientRect().top));
  assert.equal(workFilters.length,3,'only the two common filters and overflow are visible');
  assert(Math.max(...workFilters)-Math.min(...workFilters)<2,'common work filters stay in one row');
  await shell.screenshot({path:path.join(out,'compact-work-toolbar.png'),fullPage:true});
  await shell.click('#managed-work-category-more');
  await shell.waitForSelector('#managed-work-filter-menu:not([hidden])',{visible:true});
  await shell.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await shell.$eval('#managed-work-filter-menu',node=>{if(!node.checkVisibility())throw Error('Overflow menu is not visible');});
  await shell.screenshot({path:path.join(out,'work-toolbar-more.png')});
  assert(await shell.$eval('#managed-work-filter-menu',node=>node.checkVisibility()),'capturing the menu must not dismiss it through auto-scroll');
  await shell.keyboard.press('Escape');

  const callsBeforeOverview=provider.requests.length;
  // The discarded Work is history: the active list correctly drops it, so the
  // real user path to its read-only overview is the shipped 历史 category.
  await until(async()=>!(await shell.$('[data-managed-work="'+longWork.id+'"]')),'ended work leaves the active work list');
  result.stage='open ended work overview';
  await shell.click('[data-managed-category="ended"]');
  await shell.waitForSelector('[data-managed-work="'+longWork.id+'"] .managed-work-open',{visible:true});
  await shell.click('[data-managed-work="'+longWork.id+'"] .managed-work-open');
  await shell.waitForSelector('#managed-agent-details[data-mode="work"][open] .managed-work-overview',{visible:true});
  assert.equal(await shell.$eval('.managed-work-overview-title',node=>node.textContent),longWork.name);
  assert.equal(await shell.$('[data-managed-work-report="'+longWork.id+'"]'),null,'a stopped task without a result offers no invented report');
  assert.equal(await shell.$eval('[data-work-overview-technical]',node=>node.open),false,'internal diagnostics are not expanded by default');
  assert.equal(provider.requests.length,callsBeforeOverview,'opening task overview never wakes a model');
  const overviewViewport=await shell.evaluate(()=>({width:innerWidth,height:innerHeight}));
  await shell.setViewport({width:390,height:844});
  assert.equal(await shell.$eval('#managed-agent-details',node=>node.scrollWidth<=node.clientWidth+1),true,'task overview fits the narrow viewport');
  await shell.screenshot({path:path.join(out,'work-overview-390.png'),fullPage:true});
  await shell.setViewport(overviewViewport);
  await shell.keyboard.press('Escape');
  checks.push('ended task without a result opens a truthful compact overview, keeps diagnostics collapsed and spends no model call');

  // ── 4. real 402 fault: top banner, native drag, release, queue re-kick ──
  await call('managed.task',{projectId,text:'UI-CONTROL UI-FAULT: publish the recovered marker file.',requestKey:'ui-control-fault'},conversation);
  await until(async()=>{const status=await call('managed.fault.status',{},conversation);return status.faults.some(fault=>fault.projects.some(row=>row.projectId===projectId));},'real 402 fault aggregated');
  const queued=await call('managed.task',{projectId,text:'UI-CONTROL UI-GATE: publish the safely queued original input.',requestKey:'ui-control-gate'},conversation);
  await until(async()=>(await call('managed.fault.status',{},conversation)).faults.some(fault=>fault.projects.some(member=>member.blockedJobs?.includes(queued.jobId))),'new input gated before native dispatch');
  await shell.waitForSelector('.managed-service-faults',{visible:true});
  await until(async()=>/2项输入/.test(await shell.$eval('.managed-service-faults',node=>node.textContent)),'fault impact refreshes for the newly queued input');
  await shell.click('#managed-work-category-more');
  await shell.waitForSelector('#managed-work-filter-menu:not([hidden])',{visible:true});
  await shell.click('#managed-work-filter-menu [data-command="filter-fault"]');
  await until(async()=>/UI-GATE/.test(await shell.$eval('#work-items',node=>node.textContent)),'queued input belongs to the service-fault category');
  await shell.click('#managed-work-category-more');
  await shell.waitForSelector('#managed-work-filter-menu:not([hidden])',{visible:true});
  await shell.click('#managed-work-filter-menu [data-command="filter-all"]');
  await shell.focus('#managed-work-category-more');
  await shell.keyboard.press('Enter');
  await shell.waitForSelector('#managed-work-filter-menu:not([hidden])',{visible:true});
  await shell.keyboard.press('Escape');
  assert.equal(await shell.$eval('#managed-work-category-more',node=>document.activeElement===node&&node.getAttribute('aria-expanded')==='false'),true,'overflow dismissal restores keyboard focus');
  const originalViewport=await shell.evaluate(()=>({width:innerWidth,height:innerHeight}));
  await shell.setViewport({width:390,height:844});
  await until(()=>shell.evaluate(()=>{const filters=document.querySelector('.managed-work-categories'),r=filters.getBoundingClientRect(),buttons=[...filters.children].map(node=>node.getBoundingClientRect());return filters.scrollWidth<=filters.clientWidth+1&&r.right<=innerWidth+1&&Math.max(...buttons.map(box=>box.top))-Math.min(...buttons.map(box=>box.top))<2;}),'390px work filters fit on one row without horizontal overflow');
  await until(()=>shell.evaluate(()=>{const box=document.querySelector('.managed-service-faults').getBoundingClientRect();return box.left>=0&&box.right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth+1;}),'390px fault banner fits the native renderer viewport');
  await shell.screenshot({path:path.join(out,'control-fault-390.png'),fullPage:true});
  await shell.setViewport(originalViewport);
  checks.push('new gated input updates impact and fault classification; 390px Electron renderer has no horizontal overflow');
  const banner=await shell.$('.managed-service-faults');
  const box=await banner.boundingBox();
  // Native drag of the top banner must not swallow the release affordance.
  await shell.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await shell.mouse.down();
  await shell.mouse.move(box.x+box.width/2+180,box.y+box.height/2+12,{steps:8});
  await shell.mouse.up();
  await shell.waitForSelector('[data-fault-release]',{visible:true});
  await shell.click('[data-fault-details]');
  const detailText=await shell.$eval('[aria-label="服务故障详情"]',node=>node.textContent);
  assert.match(detailText,/来源|故障证据/);
  await shell.keyboard.press('Escape');
  failUiFault=false;
  await shell.click('[data-fault-release]');
  const recovered=await until(async()=>(await state()).works.find(work=>work.name==='Work UI-GATE'&&work.status==='review'),'original gated input resumes and publishes');
  await until(async()=>(await fs.readFile(path.join(recovered.execution.directory,'ui-recovered.txt'),'utf8').catch(()=>''))==='ui fault recovered\n','native recovery side effect real');
  const failed=(await state()).works.find(work=>work.name==='Work UI-FAULT');
  assert.notEqual(failed.status,'review','the admitted failed input was not replayed');
  await shell.waitForSelector('[data-fault-receipt]',{visible:true});
  await shell.locator('[data-fault-receipt] button').filter(button=>button.textContent==='查看批次详情').click();
  await until(async()=>/已接受继续请求/.test(await shell.$eval('[aria-label="服务故障详情"]',node=>node.textContent)),'durable batch receipt read through shipped UI');
  const receipt=await shell.$eval('[aria-label="服务故障详情"]',node=>node.textContent);
  assert.match(receipt,/原执行效果待核查/);
  await shell.keyboard.press('Escape');
  assert.equal(await conversation.$eval('#composer',node=>node.value),'KEEP_UNSENT_CONTROL_DRAFT','draft preserved across fault release');
  checks.push('real 402 banner survives native drag; release executes only a frozen pre-prompt input, retains admitted failure for reconciliation and reads durable batch details');
  // Capture the conversation while it is still the visible native surface.
  await conversation.screenshot({path:path.join(out,'conversation-draft-final.png'),fullPage:true});

  const publishedReceipt=(await state()).receipts.find(receipt=>receipt.workId===recovered.id&&receipt.kind==='result');
  assert(publishedReceipt,'the real publication has a frozen result identity');
  await shell.click('[data-managed-work="'+recovered.id+'"] .managed-work-open',{button:'right'});
  await shell.waitForSelector('#managed-work-menu:not([hidden])',{visible:true});
  await shell.click('#managed-work-menu [data-command="discard"]');
  await shell.waitForSelector('[data-confirmation-dialog][open]',{visible:true});
  await shell.click('[data-confirmation-confirm]');
  await until(async()=>(await state()).works.find(work=>work.id===recovered.id)?.closure?.phase==='complete','published test work cleanup');
  const requestsBeforeReport=provider.requests.length;
  await shell.click('[data-managed-work="'+recovered.id+'"] .managed-work-open',{button:'right'});
  await shell.waitForSelector('#managed-work-menu:not([hidden])',{visible:true});
  await shell.click('#managed-work-menu [data-command="details"]');
  await shell.waitForSelector('#managed-agent-details[data-mode="work"][open] .managed-work-overview',{visible:true});
  await shell.screenshot({path:path.join(out,'work-overview-with-report.png'),fullPage:true});
  await shell.keyboard.press('Escape');
  await shell.click('[data-managed-work="'+recovered.id+'"] .managed-work-open');
  const historicalSurface=await until(async()=>{for(const page of await browser.pages()){const matches=await page.evaluate(objectId=>window.__workspaceScope?.kind==='history'&&window.__workspaceScope.viewState?.report?.objectId===objectId,publishedReceipt.objectId).catch(()=>false);if(matches)return page;}return null;},'ended task directly opens the exact original frozen report');
  const openedReport=await historicalSurface.evaluate(()=>window.__workspaceScope.viewState.report);
  assert.equal(openedReport.objectId,publishedReceipt.objectId);
  assert.equal(openedReport.report.digest,publishedReceipt.report.digest);
  assert.match(openedReport.version,/^[a-f0-9]{64}$/,'direct history open retains the host-issued snapshot version');
  await until(async()=>{for(const page of await browser.pages())if(await page.$eval('body',node=>node.textContent.includes('Recovered after release')).catch(()=>false))return true;return false;},'original HTML remains readable after Work cleanup');
  assert.equal(await shell.$eval('#managed-agent-details',node=>node.open),false,'the primary ended-task click does not substitute work details for the report');
  assert.equal(provider.requests.length,requestsBeforeReport,'report navigation performs no inference or original-input replay');
  checks.push('ended task with a result opens its exact frozen report and version without a prior history-list page, model call or work-detail detour');
  await shell.screenshot({path:path.join(out,'control-ui-final.png'),fullPage:true});

  assert.deepEqual(errors,[]);
  assert.equal(provider.errors.length,0);
  await call('session.requestClose');
  await until(async()=>child.exitCode!==null||await shell.$eval('#quit-choice',node=>node.open).catch(()=>false),'normal close or explicit shutdown confirmation');
  if(child.exitCode===null)await shell.click('#quit-cancel');
  result.exit=await Promise.race([exited,pause(15000).then(()=>null)]);
  assert.deepEqual(result.exit,{code:0,signal:null});
  checks.push('real Electron normal exit after manual control and fault release');
  result.ok=true;result.requests=provider.requests.length;result.faultDetail=detailText;
}catch(error){
  result.error=error.stack;result.providerErrors=provider.errors.map(error=>error.stack);process.exitCode=1;
  await conversation?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});
  await shell?.screenshot({path:path.join(out,'failure-shell.png'),fullPage:true}).catch(()=>{});
  result.ui=await shell?.evaluate(()=>({scope:window.__workspaceScope,workRows:[...document.querySelectorAll('[data-managed-work]')].map(node=>({id:node.dataset.managedWork,text:node.textContent,rect:node.getBoundingClientRect().toJSON()})),menu:document.querySelector('#managed-work-menu')?.outerHTML,dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>node.outerHTML)})).catch(()=>null);
  result.state=await state().catch(()=>null);
}finally{
  await browser?.disconnect();
  if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(4000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  await provider.close();
  await fs.writeFile(path.join(out,'electron.log'),log);
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
