// Actual Electron + private Pi owners + real candidate files. Scripted loopback provider, never user data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';

const app=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-approval-discussion-'));
const configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop'),projectRoot=path.join(out,'project');
await fs.mkdir(projectRoot);await fs.writeFile(path.join(projectRoot,'candidate.txt'),'original project baseline\n');
const exec=promisify(execFile);
for(const args of [['init','--initial-branch=main'],['add','.'],['-c','user.name=Review Smoke','-c','user.email=review@example.invalid','commit','-m','isolated baseline']])await exec('git',args,{cwd:projectRoot});
const host=new DesktopHost(profile),project=(await host.pick(projectRoot)).project;
const otherRoot=path.join(out,'other-project');await fs.mkdir(otherRoot);await fs.writeFile(path.join(otherRoot,'readme.md'),'isolated second project');const otherProject=(await host.pick(otherRoot)).project;
for(const p of [project,otherProject]){const registered=await host.storage.requireRegistered(p.id);registered.semanticInitializationEligible=false;await host.storage.db.request(host.storage.catalog,'put',{collection:'instances',id:p.id,value:registered});}
await host.storage.db.close();
const wireText=message=>typeof message?.content==='string'?message.content:message?.content?.filter(part=>part.type==='text').map(part=>part.text).join('')||'';
const trace=[];
let releaseQueuedTurn;
const skillMarker='NOZELI_TEST_FROZEN_SKILL_ALPHA';
const skillWire=[];
const paraPath='skills/paracloud-gpu-capacity/SKILL.md',paraText='Call nozeli_paracloud_capacity for an advisory snapshot. Missing authorization is not proof of capacity.';
const paraResults=[];
const queuedTurnGate=new Promise(resolve=>{releaseQueuedTurn=resolve;});
let releaseIntake;
const intakeGate=new Promise(resolve=>{releaseIntake=resolve;});
const provider=await serve(async request=>{
 const tools=request.tools?.map(tool=>tool.function?.name)||[];
 const messages=request.messages.map(wireText);
 const analysis=messages.find(text=>text.startsWith('使用 nozeli-admin-skill-migration'));
 if(analysis){
  assert(!tools.some(name=>name.startsWith('nozeli_admin_')));
  const candidates=JSON.parse(analysis.slice(analysis.indexOf('\n')+1));
  assert.deepEqual(candidates.map(c=>c.name).sort(),['packaged-reading','reading-checklist','reading-summary']);
  assert.equal(candidates.find(c=>c.name==='packaged-reading').compatibility,'analysis-only');
  assert(!analysis.includes('PRIVATE_UNSELECTED_SKILL_FIXTURE')&&!analysis.includes('PRIVATE_COMPANION_FIXTURE'));
  return {text:JSON.stringify({candidates:candidates.map(c=>({id:c.id,portable:true,analysis:'Self-contained reading checklist',text:`Compare research claims and cite the supplied text. ${skillMarker}`}))})};
 }
 if(messages.some(text=>text.includes(skillMarker)))skillWire.push({tools,text:messages.join('\n')});
 const para=messages.findLast(text=>['PARACLOUD_SCOPE_TEST','PARACLOUD_SKILL_TEST','PARACLOUD_ADVISORY_TEST','PARACLOUD_QUEUE_TEST','PARACLOUD_WRITE_DENIED_TEST'].includes(text));
 if(para&&tools.includes('nozeli_handoff')){
  const last=request.messages.findLast(row=>row.role==='tool'&&row.tool_call_id===para);
  if(!last&&para==='PARACLOUD_QUEUE_TEST')return {tool:'nozeli_paracloud_job',id:para,args:{action:'queue'}};
  if(!last&&para==='PARACLOUD_WRITE_DENIED_TEST')return {tool:'nozeli_paracloud_job',id:para,args:{action:'cancel',requestId:'test-request'}};
  if(!last)return {tool:'nozeli_paracloud_capacity',id:para,args:para==='PARACLOUD_ADVISORY_TEST'?{action:'admission',cpus:8,memoryMiB:8192,gpus:1,gpuType:'a100'}:{action:'snapshot'}};
  paraResults.push(wireText(last));return {text:'PARACLOUD_CHECK_OK'};
 }
 if(tools.includes('nozeli_handoff')&&request.messages.some(row=>row.role==='user'&&wireText(row).includes('FOREGROUND_READ_MARKER'))){trace.push('foreground-read');return {text:'FOREGROUND_REPLY_MARKER: exact foreground native message, no task dispatch.'};}
 if(tools.includes('nozeli_handoff')){trace.push('frontdesk');return {tool:'nozeli_handoff',id:'review-handoff',args:{reason:'Run the explicitly requested isolated candidate task.'}};}
 if(tools.includes('nozeli_dispatch')){trace.push('orchestrator');await intakeGate;return {tool:'nozeli_dispatch',id:'review-dispatch',args:{name:'审批讨论真实接线',brief:'Create candidate.txt with initial candidate content and publish the HTML report for explicit review.'}};}
 const user=request.messages.filter(row=>row.role==='user').map(wireText);
 const phase=user.findLast(text=>['DISCUSS_QUESTION','DISCUSS_MODIFY','DISCUSS_AFTER','DISCUSS_HOLD','DISCUSS_QUEUED'].includes(text.trim()))?.trim()||'initial';
 trace.push(phase);
 if(phase==='DISCUSS_HOLD'){await queuedTurnGate;return {text:'REVIEW_HOLD_REPLY: first queued round completed.'};}
 if(phase==='DISCUSS_QUEUED')return {text:'REVIEW_QUEUED_REPLY: second round ran after the first.'};
 if(phase==='DISCUSS_QUESTION')return {text:'REVIEW_ANSWER_ORIGINAL_THREAD: this explanation does not change the report or files.'};
 if(phase==='DISCUSS_AFTER')return {text:'REVIEW_ANSWER_AFTER_UPDATE: the revised report and candidate are retained in this same task.'};
 if(phase==='DISCUSS_MODIFY'){
  if(!request.messages.some(row=>row.tool_call_id==='review-modify-write'))return {tool:'write',id:'review-modify-write',args:{path:'candidate.txt',content:'updated candidate from approval discussion\n'}};
  if(!request.messages.some(row=>row.tool_call_id==='review-para-write'))return {tool:'write',id:'review-para-write',args:{path:paraPath,content:paraText}};
  return {tool:'nozeli_publish',id:'review-modify-publish',args:{kind:'result',content:staticReport('REVIEW_REPORT_V2 updated after direct Worker discussion.'),files:['candidate.txt',paraPath]}};
 }
 if(!request.messages.some(row=>row.tool_call_id==='review-initial-write'))return {tool:'write',id:'review-initial-write',args:{path:'candidate.txt',content:'initial frozen candidate\n'}};
 return {tool:'nozeli_publish',id:'review-initial-publish',args:{kind:'result',content:staticReport('REVIEW_REPORT_V1 original frozen report.'),files:['candidate.txt']}};
});
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
const ozone=process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':process.env.WAYLAND_DISPLAY?'wayland':'headless');
Object.assign(env,{NOZELI_CONFIG_ROOT:configRoot,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_OZONE:ozone});
 env.HOME=path.join(out,'home');await fs.mkdir(env.HOME);
 env.CLAUDE_CONFIG_DIR=path.join(out,'claude-fixture');
 await fs.mkdir(path.join(env.CLAUDE_CONFIG_DIR,'skills','reading-summary'),{recursive:true});
 await fs.writeFile(path.join(env.CLAUDE_CONFIG_DIR,'skills','reading-summary','SKILL.md'),'Summarize the central argument.');
 env.CODEX_HOME=path.join(out,'codex-fixture');
 await fs.mkdir(path.join(env.CODEX_HOME,'skills','reading-checklist'),{recursive:true});
 await fs.writeFile(path.join(env.CODEX_HOME,'skills','reading-checklist','SKILL.md'),'---\nname: reading-checklist\ndescription: Review reading claims\n---\nCompare claims with their evidence.');
 const unselectedDir=path.join(env.CODEX_HOME,'skills','unselected');await fs.mkdir(unselectedDir);
 await fs.writeFile(path.join(unselectedDir,'SKILL.md'),'PRIVATE_UNSELECTED_SKILL_FIXTURE');
 const packageDir=path.join(env.CODEX_HOME,'skills','packaged-reading');await fs.mkdir(packageDir);
 await fs.writeFile(path.join(packageDir,'SKILL.md'),'Compare the supplied evidence.');
 await fs.writeFile(path.join(packageDir,'reference.md'),'PRIVATE_COMPANION_FIXTURE');
 const bin=path.join(out,'bin');await fs.mkdir(bin);
 await fs.writeFile(path.join(bin,'ssh'),`#!/bin/sh\npty=no\nfor arg do\n if [ "$arg" = '-tt' ]; then pty=yes; fi\n command=$arg\ndone\n[ "$pty" = yes ] || exit 1\nbegin=$(printf '%s' "$command" | grep -oE 'NOZELI_BEGIN_[a-f0-9]{32}')\nend=$(printf '%s' "$command" | grep -oE 'NOZELI_END_[a-f0-9]{32}')\n[ -n "$begin" ] && [ -n "$end" ] || exit 1\ncase "$command" in\n *'python3 -I -c'*) payload='{"ok":{"jobs":[{"jobId":"42","state":"PENDING"}]}}';;\n *) payload='gpu-research|up|fixture-node|1|idle|32|UNLIMITED|65536|gpu:a100:4||no';;\nesac\nprintf '%s\\r\\n' 'Gateway banner' "$begin" "$payload" "$end"\n`,{mode:0o700});
 env.PATH=bin+path.delimiter+env.PATH;
const require=createRequire(import.meta.url),report={ok:false,out,scope:'Real Electron, private Pi native owners and Git files; local scripted provider, no paid model or user profile',checks:[],screenshots:[]};
let child,browser,shell,reviewPage,discussionPage,observer,exit,log='';const errors=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Electron exited '+log);const value=await fn();if(value)return value;await pause(80);}throw Error('Timeout: '+label);}
async function invoke(page,op,payload={}){const r=await page.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
const state=async()=> (await invoke(shell,'managed.status',{projectId:project.id})).state;
const check=name=>{report.checks.push(name);console.log(name);};
async function shot(name){const file=path.join(out,name+'.png');await reviewPage.screenshot({path:file});report.screenshots.push(file);}
async function discussion(){discussionPage=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='review-discussion'&&!window.__workspaceScope.sourceJobId).catch(()=>false))return p;},'trusted native Worker discussion');return discussionPage;}
async function nativeDiscussionState(){return observer.evaluate(`(async()=>{const {BrowserWindow}=process.mainModule.require('electron'),rows=[];for(const win of BrowserWindow.getAllWindows()){if(win.isDestroyed())continue;const scope=await win.webContents.executeJavaScript('window.__workspaceScope').catch(()=>null);if(scope?.role!=='review-discussion'||scope.sourceJobId||scope.projectId!==${JSON.stringify(project.id)})continue;const parent=win.getParentWindow();rows.push({id:win.id,visible:win.isVisible(),focused:win.isFocused(),bounds:win.getBounds(),contentBounds:win.getContentBounds(),zoomFactor:win.webContents.getZoomFactor(),parentVisible:parent?.isVisible(),parentFocused:parent?.isFocused(),scope});}return rows;})()`);}
async function discussionVisible(selector='[data-review-discussion]'){
 return until(async()=>{const rows=await nativeDiscussionState(),native=rows.find(row=>row.visible&&row.parentVisible&&row.bounds.width>0&&row.bounds.height>0);if(!native)return false;const visible=await discussionPage.$eval(selector,node=>{const r=node.getBoundingClientRect(),style=getComputedStyle(node);return !node.hidden&&r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden';}).catch(()=>false);return visible?native:false;},'actual native discussion and control visible: '+selector,6000);
}
async function clickDiscussion(selector,{waitHidden=true}={}){await discussionVisible(selector);await discussionPage.click(selector);if(selector==='[data-local-window-hide]'&&waitHidden)await until(async()=>{const rows=await nativeDiscussionState();return rows.length===1&&rows.every(row=>!row.visible);},'native discussion close acknowledged',6000);}
async function dragDiscussion(selector,dx,dy){
 const start=await discussionVisible(selector),origin=start.contentBounds,zoom=start.zoomFactor;
 const head=await discussionPage.$eval(selector,n=>{const r=n.getBoundingClientRect();return {x:r.left+Math.min(35,r.width/2),y:r.top+r.height/2};});
 await discussionPage.evaluate(()=>{window.__reviewGesture=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])document.addEventListener(type,e=>window.__reviewGesture.push({type,x:e.screenX,y:e.screenY,buttons:e.buttons,hit:e.target?.className,trusted:e.isTrusted}),{capture:true});});
 await discussionPage.mouse.move(head.x,head.y);await discussionPage.mouse.down();
 try{
  for(let step=1;step<=8;step++){
   const here=(await nativeDiscussionState()).find(row=>row.id===start.id).contentBounds;
   await discussionPage.mouse.move(head.x+dx*step/8+(origin.x-here.x)/zoom,head.y+dy*step/8+(origin.y-here.y)/zoom);
  }
 }finally{await discussionPage.mouse.up();(report.gestures??=[]).push({selector,dx,dy,start,trace:await discussionPage.evaluate(()=>window.__reviewGesture)});}
 const gesture=report.gestures.at(-1),press=gesture.trace.find(e=>e.type==='pointerdown'),release=gesture.trace.find(e=>e.type==='pointerup');
 assert(press?.trusted&&press.hit==='tag-window-title'&&release?.trusted,'trusted pointer press on title and release');
 // CDP dispatches in child-local coordinates; the child may move between
 // the last move request and release. Assert the screen delta it delivered.
 const x=release.x-press.x,y=release.y-press.y;
 assert(x<=dx*zoom+4&&y<=dy*zoom+4,`drag must deliver the intended screen motion: ${x}, ${y}`);
 const changed=await until(async()=>{const row=(await nativeDiscussionState()).find(row=>row.id===start.id);return row?.visible&&Math.abs(row.contentBounds.x-origin.x-x)<=2&&Math.abs(row.contentBounds.y-origin.y-y)<=2&&row.contentBounds.width===origin.width&&row.contentBounds.height===origin.height?row:null;},'native discussion moves at unchanged size',5000);
 gesture.end=changed.contentBounds;
}
// CDP clicks alone do not activate the native BaseWindow hosting the shell.
async function activateTestShell(){
 const id=await observer.evaluate(`(async()=>{const {BrowserWindow,BaseWindow}=process.mainModule.require('electron');for(const win of new Set([...BaseWindow.getAllWindows(),...BrowserWindow.getAllWindows()])){if(win.isDestroyed()||!win.webContents)continue;if(await win.webContents.executeJavaScript("window.__workspaceScope?.role==='shell'").catch(()=>false)){if(win.isMinimized())win.restore();win.show();win.focus();return win.id;}}throw Error('Missing fixture shell');})()`);
 await until(()=>observer.evaluate(`Boolean(process.mainModule.require('electron').BaseWindow.fromId(${id})?.isFocused())`),'fixture shell in foreground',5000);
}
async function visibleReport(marker){
 await reviewPage.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 const key=await reviewPage.$eval('.managed-report-body .isolated-viewport',node=>node.dataset.previewKey);
 const snapshot=await invoke(reviewPage,'isolated-preview.snapshot',{key});
 const guest=await until(async()=>{for(const p of await browser.pages())if(p.url().startsWith(snapshot.origin+'/'))return p;},'current native report guest');
 await guest.waitForFunction(marker=>document.body.innerText.includes(marker),{},marker);
 const file=path.join(out,marker+'.png');await guest.screenshot({path:file});report.screenshots.push(file);
 return guest;
}
async function send(text){
 await discussionVisible('[data-review-instruction]');await discussionPage.waitForSelector('[data-review-instruction]:not([disabled])',{visible:true});
 await discussionPage.$eval('[data-review-instruction]',(node,text)=>{node.value=text;node.dispatchEvent(new Event('input',{bubbles:true}));},text);
 await discussionPage.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});
 const input='[data-review-instruction]',shortcut=process.platform==='darwin'?'Meta':'Control';
 await discussionPage.focus(input);await discussionPage.$eval(input,node=>node.setSelectionRange(node.value.length,node.value.length));
 await discussionPage.keyboard.press('Enter');assert.equal(await discussionPage.$eval(input,node=>node.value),text+'\n','plain Enter inserts a native newline');
 await discussionPage.keyboard.press('Backspace');
 await discussionPage.keyboard.down(shortcut);try{await discussionPage.keyboard.press('Enter');}finally{await discussionPage.keyboard.up(shortcut);}
 await until(async()=>{const s=await state(),job=s.jobs.findLast(row=>row.text===text);if(job?.status==='failed'||job?.status==='unknown')throw Error(JSON.stringify(job));return job?.status==='completed'&&s.works.find(work=>work.id===job.target)?.status==='review'&&!s.jobs.some(row=>row.target===job.target&&['queued','running'].includes(row.status));},text+' settles');
}
try{
 child=spawn(process.env.NOZELI_TEST_BINARY||require('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform='+ozone,'--inspect=0'],{cwd:projectRoot,env,stdio:['ignore','pipe','pipe']});
 exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 browser.on('targetcreated',async target=>{const page=await target.page().catch(()=>null);page?.on('pageerror',error=>errors.push(error.message));});
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'native main observer'));
 await invoke(shell,'config.initialize',{mode:'independent'});
 if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
 await invoke(shell,'settings.providers.save',{operation:'create',provider:'approval-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'},{id:'alternate'}],credential:{action:'replace',value:'local-nonsecret'}});
 const model={model:{mode:'explicit',selector:'approval-local/scripted'},thinking:{mode:'native-default'}};
 await invoke(shell,'settings.models.save',{frontdesk:model,orchestrator:model,worker:model});
 await shell.click('[data-project-id="'+project.id+'"]');
 await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,project.id),'project binding');
 await until(()=>shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')==='true'),'project visit opens sidebar');
 await shell.click('#toggle-sidebar');assert.equal(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')),'false');
 await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width:800,height:650});await shell.waitForFunction(()=>document.querySelector('#app').classList.contains('narrow-layout'));
 assert.equal(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')),'false','explicit collapse survives breakpoint');
 await shell.click('[data-project-id="'+otherProject.id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,otherProject.id),'second project visit');await until(()=>shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')==='true'),'second visit opens sidebar');
 await shell.click('[data-project-id="'+project.id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,project.id),'return project visit');await until(()=>shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')==='true'),'return visit opens sidebar');
 await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width:1440,height:900});await shell.waitForFunction(()=>!document.querySelector('#app').classList.contains('narrow-layout'));
 check('Entering and re-entering real projects opens the core sidebar; explicit collapse survives a responsive breakpoint');
 await invoke(shell,'admin.configure',{model:'approval-local/scripted',effort:null,expectedRevision:0});
 const storeAction=async name=>{const selector=`[data-import-action="${name}"]`;await shell.waitForSelector(selector+':not([disabled])',{visible:true});await shell.click(selector);};
 await shell.click('#workspace-store');await shell.waitForSelector('#local-resource-store:not([hidden])');
 await storeAction('sources');await shell.waitForSelector('[data-import-source="codex"]',{visible:true});await shell.click('[data-import-source="codex"]');await shell.click('[data-import-source="claude"]');await storeAction('scan');
 const analysisSelector='[data-import-analysis-candidate]';
 await shell.waitForSelector('[data-import-analysis-candidate="codex:0:unselected"]',{visible:true});
 assert.equal(await shell.$$eval(`${analysisSelector}:checked`,nodes=>nodes.length),0);
 assert(await shell.$eval('[data-import-action="analyze"]',node=>node.disabled));
 for(const id of ['codex:0:reading-checklist','claude:0:reading-summary','codex:0:packaged-reading'])await shell.click(`[data-import-analysis-candidate="${id}"]`);
 await storeAction('analyze');await shell.waitForSelector('#admin-agent[data-store-analysis]:not([hidden])',{visible:true});
 try{await shell.waitForFunction(()=>{const node=document.querySelector('#admin-return-store'),r=node.getBoundingClientRect();return r.width>0&&r.height>0&&node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));},{timeout:4000});}
 catch(error){report.adminPopup=await shell.$eval('#admin-return-store',node=>{const r=node.getBoundingClientRect(),layer=node.closest('.local-window-layer');return {rect:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,200),layer:getComputedStyle(layer).zIndex};});throw error;}
 await shell.waitForFunction(()=>document.querySelector('[data-admin-skill-status]')?.textContent.startsWith('分析完成'));
 await shell.click('#admin-return-store');await shell.waitForSelector('#admin-agent[hidden]');
 await shell.waitForSelector('[data-import-candidate="codex:0:reading-checklist"]',{visible:true});
 assert.equal(await shell.$('[data-import-candidate="codex:0:unselected"]'),null);
 assert.equal(await shell.$('[data-import-candidate="codex:0:packaged-reading"]'),null);
 assert.match(await shell.$eval('.store-import-panel',node=>node.innerText),/packaged-reading[\s\S]*仅可分析/);
 check('Store sends only explicitly checked scan results to the management model');
 await shell.click('[data-import-candidate="codex:0:reading-checklist"]');
 const candidateRole=(id,role)=>shell.click(`fieldset:has(> label > [data-import-candidate="${id}"]) [data-import-role="${role}"]`);
 for(const role of ['frontdesk','orchestrator','worker'])await candidateRole('codex:0:reading-checklist',role);
 await shell.click('[data-import-candidate="claude:0:reading-summary"]');
 await candidateRole('claude:0:reading-summary','frontdesk');
 await shell.click('[data-import-enable]');await storeAction('install');
 const installed=await until(async()=>{const rows=await invoke(shell,'store.imports.list',{projectId:project.id});return rows.find(row=>row.name==='reading-checklist');},'confirmed Store installation');
 assert(installed.roles.every(role=>role.enabled));
 await shell.keyboard.press('Escape');await shell.waitForSelector('#local-resource-store[hidden]');
 const skill={id:installed.id,version:installed.version};
 assert((await invoke(shell,'store.imports.list',{projectId:project.id})).some(row=>row.name==='reading-summary'&&row.roles.length===1&&row.roles[0].id==='frontdesk'));
 const workerGrant={projectId:project.id,...skill,role:'worker'};
 await invoke(shell,'store.imports.disable',workerGrant);
 async function selectSkill(page,role){const selector=`[data-imported-skill="${role}"]`,value=JSON.stringify([skill.id,skill.version]);
  assert.equal(await page.$('#compose-form [data-skill-role]'),null,'Skill choices do not occupy composer rows');
  await page.click('[data-chat-more]');
  await page.click('#conversation-context-menu [data-command="chat-skill-choice"]');
  await page.waitForSelector('#conversation-skill-dialog[open]',{visible:true});
  await page.click(`[data-skill-role="${role}"] summary`);
  await page.waitForFunction((selector,value)=>Array.from(document.querySelector(selector)?.options??[]).some(o=>o.value===value),{},selector,value);
  assert.deepEqual(await page.select(selector,value),[value]);
  await page.click('#conversation-skill-dialog > button');
  await page.waitForSelector('#conversation-skill-dialog:not([open])');
 }
 await invoke(shell,'managed.enable',{projectId:project.id});
 await shell.evaluate(()=>{window.__foregroundPresentations=[];window.nozeli.subscribe('workspace.control',event=>{if(event.type==='attention-presented')window.__foregroundPresentations.push(event);});});
 await shell.click('#workspace-open-conversation');
 const conversationPage=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='conversation').catch(()=>false))return page;},'real foreground conversation');
 await selectSkill(conversationPage,'frontdesk');
 await conversationPage.waitForSelector('#composer:not([disabled])');await conversationPage.$eval('#composer',node=>{node.value='FOREGROUND_READ_MARKER';node.dispatchEvent(new Event('input',{bubbles:true}));});await conversationPage.waitForSelector('#send-message:not([disabled])');await conversationPage.click('#send-message');
 await conversationPage.waitForFunction(()=>document.querySelector('#conversation')?.innerText.includes('FOREGROUND_REPLY_MARKER'));
 await conversationPage.bringToFront();await conversationPage.focus('#composer');
 await conversationPage.$eval('#conversation',node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event('scroll'));});
 await until(()=>shell.evaluate(()=>window.__foregroundPresentations.some(event=>event.messageId&&event.sessionId)),'canonical foreground message presented through native bridge');
 assert.equal((await state()).works.length,0,'foreground reading does not dispatch a Work');check('Real foreground native reply is presented with canonical session/revision identity and reaches the shell without task dispatch');
 await invoke(shell,'managed.task',{projectId:project.id,text:'Create a candidate and HTML report for the isolated approval discussion smoke.',requestKey:'approval-smoke-initial-task',importedSkill:skill});
 const intake=await until(async()=>{const s=await state();return trace.includes('orchestrator')&&s.jobs.find(j=>j.type==='intake'&&j.status==='running');},'held Orchestrator request');
 const intakeSelector=`[data-managed-request="request:${intake.id}"] .managed-work-open`;
 await activateTestShell();
 await shell.waitForSelector(intakeSelector,{visible:true});await shell.click(intakeSelector);
 const intakeLaunchError=await shell.waitForFunction(()=>{const t=document.querySelector('#toast');return !t?.hidden&&/讨论|对话|工作面/.test(t.textContent)?t.textContent:null;},{timeout:1400}).then(handle=>handle.jsonValue()).catch(()=>null);
 if(intakeLaunchError)throw Error('Intake launch: '+intakeLaunchError);
 const intakePage=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(id=>window.__nozeliReady&&window.__workspaceScope?.sourceJobId===id,intake.id).catch(()=>false))return p;},'native Orchestrator window');
 await intakePage.waitForFunction(()=>document.querySelector('[data-review-discussion]')?.innerText.includes('Create a candidate and HTML report'));
 assert.equal(await intakePage.$eval('[data-review-instruction]',node=>node.getClientRects().length),0);
 assert.equal(await intakePage.$('.collaboration-single-agent'),null);
 assert.equal((await state()).works.length,0,'opening the read-only window does not dispatch');
 await intakePage.click('[data-local-window-hide]');
 await shell.waitForFunction(selector=>document.activeElement?.matches(selector),{},intakeSelector);
 check('Running intake opens its own native Orchestrator conversation, without dispatch or send controls');
 releaseIntake();
 const first=await until(async()=>{const s=await state();const w=s.works[0];if(s.jobs.some(j=>j.status==='failed'))throw Error(JSON.stringify(s.jobs.filter(j=>j.status==='failed')));return w?.status==='review'&&!s.jobs.some(j=>['queued','running'].includes(j.status))?s:null;},'initial review');
 const work=first.works[0],originalThread=work.threadId,originalReceipt=first.receipts.find(r=>r.workId===work.id&&r.kind==='result'),todo=first.todos.find(t=>t.workId===work.id&&t.kind==='result'&&t.status==='open');
 assert(todo&&originalReceipt);report.workId=work.id;report.threadId=originalThread;report.initialObjectId=originalReceipt.objectId;
 const sourceBefore=await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8');
 if(await shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true').catch(()=>false))await shell.click('#toggle-sidebar');
 const pendingBeforeOpen=(await state()).todos.filter(t=>t.status==='open').map(t=>t.id);
 const notifiedBeforeOpen=(await state()).attentionNotified;
 await shell.click('#toggle-sidebar');assert.equal(await shell.$('#sidebar-badge'),null);await shell.screenshot({path:path.join(out,'pending-collapsed-rail.png')});
 await shell.click('#toggle-sidebar');assert.deepEqual((await state()).todos.filter(t=>t.status==='open').map(t=>t.id),pendingBeforeOpen);assert.deepEqual((await state()).attentionNotified,notifiedBeforeOpen,'opening never acknowledges pending obligations');
 await shell.waitForSelector('[data-managed-todo="'+todo.id+'"]',{visible:true});await shell.click('[data-managed-todo="'+todo.id+'"]');
 reviewPage=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='report').catch(()=>false))return p;},'native report workspace');
 await reviewPage.waitForSelector('.managed-review');assert.equal(await reviewPage.$('[data-review-discussion]'),null);
 assert.equal(await reviewPage.$eval('[data-review-action="open-discussion"]',node=>node.textContent.trim()),'追加讨论');
 // CDP input does not activate a background X11 window. Establish the same
 // foreground precondition as a user's click, without focusing the popup.
 await activateTestShell();
 assert.equal(await until(async()=>{const pages=await browser.pages();return Promise.all(pages.map(p=>p.evaluate(()=>window.__workspaceScope?.role==='review-discussion'&&!window.__workspaceScope?.sourceJobId).catch(()=>false))).then(values=>!values.some(Boolean));},'cold report has no native Worker discussion'),true);await reviewPage.click('[data-review-action="open-discussion"]');await discussion();await discussionPage.waitForSelector('[data-review-discussion]',{visible:true});await discussionPage.waitForSelector('[data-review-instruction]:not([disabled])',{visible:true});
 const sharedWindow=discussionPage;
 await discussionVisible('[data-local-window-hide]');
 await reviewPage.waitForSelector('[data-review-action="open-discussion"][aria-expanded="true"]');
 if(ozone==='x11'){
  await dragDiscussion('[data-local-window-header] .tag-window-title',-75,-55);
  check('A trusted drag starting on the report discussion title moves the actual native window without resizing it');
 }
 const scopedChip=`.collaboration-single-agent [data-agent-target="${work.id}"]`,mainChip=`#managed-collaboration [data-agent-target="${work.id}"]`,modelDialog='.collaboration-model-dialog[open]';
 assert.deepEqual((await invoke(discussionPage,'managed.collaboration.status',{projectId:project.id,target:work.id})).agents.map(row=>row.target),[work.id]);
 await discussionPage.waitForSelector(scopedChip,{visible:true});
 assert.deepEqual(await discussionPage.$$eval('.collaboration-single-agent [data-agent-target]',nodes=>nodes.map(n=>n.dataset.agentTarget)),[work.id]);
 const modelLayout=await discussionPage.evaluate(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect();const chip=rect('.collaboration-single-agent button'),send=rect('[data-review-action="send"]'),editor=rect('[data-review-instruction]');return {left:chip.left>=editor.left-1&&chip.right<=send.left,aligned:Math.abs((chip.y+chip.height/2)-(send.y+send.height/2))<2,right:send.right<=editor.right+1};});
 assert.deepEqual(modelLayout,{left:true,aligned:true,right:true});
 const beforeModelJobs=(await state()).jobs.map(j=>j.id);
 for(const target of ['frontdesk','orchestrator','another-worker'])for(const op of ['managed.model.options','managed.model.set','managed.collaboration.status']){
  const denied=await discussionPage.evaluate(args=>nozeli.invoke(args.op,args.p),{op,p:{projectId:project.id,target}});assert.equal(denied.error?.code,'REVIEW_SCOPE_DENIED');
 }
 const readModel=async(page,target=work.id)=>invoke(page,'managed.model.options',{projectId:project.id,target});
 const chosen=info=>info.desired?.model??info.override?.model??info.effective?.model;
 const otherModels=await Promise.all(['frontdesk','orchestrator'].map(target=>readModel(shell,target).then(chosen)));
 const modelButton=(page,text)=>page.waitForSelector(`${modelDialog} button::-p-text(${text})`,{visible:true,timeout:5000});
 const dismissModel=async page=>(await modelButton(page,'取消')).click();
 async function saveModel(page,chip,modelId){
  const radio=`${modelDialog} input[value="approval-local/${modelId}"]`;
  await page.waitForSelector(chip,{visible:true});await page.click(chip);
  await page.waitForSelector(radio+':not([disabled])',{visible:true});await page.click(radio);
  const save=await modelButton(page,'保存选择');assert.equal(await save.evaluate(n=>n.disabled),false,'selecting a different model enables save');await save.click();
  await until(async()=>chosen(await readModel(page))==='approval-local/'+modelId,'shared model selection');
  await dismissModel(page);
 }
 await discussionPage.$eval(scopedChip,node=>node.scrollIntoView({block:'nearest'}));
 await discussionPage.screenshot({path:path.join(out,'worker-model-chip.png')});
 await saveModel(discussionPage,scopedChip,'alternate');
 await conversationPage.waitForSelector(mainChip,{visible:true});await conversationPage.click(mainChip);
 await conversationPage.waitForSelector(`${modelDialog} input[value="approval-local/alternate"]:checked`);
 await dismissModel(conversationPage);
 await saveModel(conversationPage,mainChip,'scripted');
 await discussionPage.click(scopedChip);await discussionPage.waitForSelector(`${modelDialog} input[value="approval-local/scripted"]:checked`);
 await dismissModel(discussionPage);
 assert.deepEqual(await Promise.all(['frontdesk','orchestrator'].map(target=>readModel(shell,target).then(chosen))),otherModels);
 assert.deepEqual((await state()).jobs.map(j=>j.id),beforeModelJobs);
 check('The discussion shows only its Worker on the left; the two real model menus share selections without changing other Agents or creating jobs');
 await clickDiscussion('[data-local-window-hide]');
 await reviewPage.waitForSelector('[data-review-action="open-discussion"][aria-expanded="false"]');
 await shell.click('[data-managed-work="'+work.id+'"] .managed-work-open');
 assert.equal(await discussion(),sharedWindow,'right-hand Work reuses the original native child');
 await discussionPage.waitForFunction(()=>window.__workspaceScope.objectId===null);
 const workChat=await invoke(discussionPage,'managed.work.chat.read',{projectId:project.id,workId:work.id});
 assert(workChat.reasons.includes('REVIEW_BINDING_REQUIRED'));
 assert.equal(workChat.canSend,false);
 assert(!await discussionPage.$eval('[data-review-discussion]',node=>node.innerText.includes('请从报告的「追加讨论」进入')));
 await clickDiscussion('[data-local-window-hide]');
 await reviewPage.click('[data-review-action="open-discussion"]');
 await discussionPage.waitForFunction(id=>window.__workspaceScope.objectId===id,{},originalReceipt.objectId);
 assert.equal(await discussion(),sharedWindow,'report entry returns to the exact same native child');
 assert(await reviewPage.$('.managed-report-body'));assert.equal(await discussionPage.$('.managed-report-body'),null);
 await discussionPage.waitForSelector('.session-task-card .session-task-flow');
 assert.equal(await discussionPage.$('[data-review-context]'),null,'the old separate context bucket is retired');
 assert.equal(await discussionPage.$eval('[data-task-toggle]',node=>node.getAttribute('aria-expanded')),'true','review discussion defaults to expanded independently of conversation cards');
 const layoutBeforeInline=await invoke(shell,'workspace.snapshot',{projectId:project.id}),inlineViewIds=Object.keys(layoutBeforeInline.layout.views).sort(),inlinePageCount=(await browser.pages()).length;
 await discussionPage.click('[data-task-action="process"]');await discussionPage.waitForSelector('[data-task-inline-process] [data-task-process]',{visible:true});
 assert.deepEqual(Object.keys((await invoke(shell,'workspace.snapshot',{projectId:project.id})).layout.views).sort(),inlineViewIds,'review process disclosure never creates a split');
 assert.equal((await browser.pages()).length,inlinePageCount,'review process disclosure never opens a new page');
 await discussionPage.click('[data-task-action="process"]');await discussionPage.waitForSelector('[data-task-inline-process]',{hidden:true});
 const taskFrame=await invoke(discussionPage,'managed.review.discussion.read',{projectId:project.id,workId:work.id,objectId:originalReceipt.objectId,limit:100});
 assert.equal(taskFrame.taskState.works.length,1);assert.equal(taskFrame.taskState.works[0].id,work.id);
 const mainTaskFrame=await invoke(shell,'managed.timeline.page',{projectId:project.id,workId:work.id,limit:100});
 const canonical=new Map(mainTaskFrame.entries.map(row=>[row.id,row]));
 for(const entry of taskFrame.taskFrame.entries){const same=canonical.get(entry.id);if(same)assert.equal(entry.text,same.text,'shared source text for '+entry.id);}
 assert(taskFrame.taskFrame.entries.some(entry=>entry.speaker==='user'),'the task reader includes the original accepted input');
 await discussionPage.screenshot({path:path.join(out,'shared-task-reader-open.png')});
 await discussionPage.$eval('.session-task-flow',node=>node.scrollIntoView({block:'start'}));
 await discussionPage.screenshot({path:path.join(out,'shared-task-direction-and-request.png')});
 await visibleReport('REVIEW_REPORT_V1');
 check('Todo opens the original report first; only its bottom button opens the separate nonmodal Work discussion');await shot('approval-open');
 await shell.evaluate(()=>{window.__presentedMessages=[];window.nozeli.subscribe('workspace.control',event=>{if(event.type==='attention-presented')window.__presentedMessages.push(event);});});
 const picker='[data-imported-skill="worker"]',skillValue=JSON.stringify([skill.id,skill.version]);
 await discussionPage.click('[data-skill-role="worker"] summary');
 await discussionPage.waitForFunction(selector=>document.querySelector(selector)?.options.length===1,{},picker);
 assert.equal((await invoke(discussionPage,'managed.skill.options',{projectId:project.id,target:work.id})).length,0);
 await invoke(shell,'store.imports.enable',workerGrant);
 await discussionPage.waitForFunction((selector,value)=>Array.from(document.querySelector(selector)?.options??[]).some(o=>o.value===value),{},picker,skillValue);
 await discussionPage.select(picker,skillValue);
 await send('DISCUSS_QUESTION');await discussionPage.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('REVIEW_ANSWER_ORIGINAL_THREAD'));
 let current=await state();assert.equal(current.works.length,1);assert.equal(current.works[0].threadId,originalThread);assert.equal(current.receipts.filter(r=>r.workId===work.id&&r.kind==='result').length,1);assert.equal(current.works[0].status,'review');
 assert.equal(await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8'),sourceBefore);
 assert(skillWire.some(call=>call.tools.includes('nozeli_handoff')&&call.text.includes('FOREGROUND_READ_MARKER')));
 assert(skillWire.some(call=>call.tools.includes('nozeli_dispatch')&&call.text.includes('Create a candidate')));
 assert(skillWire.some(call=>call.text.includes('DISCUSS_QUESTION')));
 assert(!skillWire.some(call=>call.text.includes('initial frozen candidate')&&!call.text.includes('DISCUSS_QUESTION')),'worker does not inherit the Orchestrator skill');
 const skillJobs=(await state()).jobs.filter(j=>j.context?.importedSkill?.id===skill.id);
 assert.equal(skillJobs.length,3);
 assert(skillJobs.every(j=>j.delivery?.importedSkill?.outboundVerifiedCalls>0));
 check('Store batch installation reaches all three real Pi roles only on explicitly selected requests');
 check('Original Worker answers a pure review question in its original native thread without a new report or project mutation');
 await discussionPage.bringToFront();await observer.evaluate(`(()=>{const{BrowserWindow}=process.mainModule.require('electron');for(const win of BrowserWindow.getAllWindows())if(win.getParentWindow()){win.focus();win.webContents.focus();}})()`);await discussionPage.click('[data-review-instruction]');await discussionPage.waitForFunction(()=>document.hasFocus());
 await discussionPage.$eval('[data-review-discussion-history]',node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event('scroll'));});
 const validMessage=await until(()=>shell.evaluate(()=>window.__presentedMessages?.find(event=>event.messageId&&event.sessionId)),'canonical review message presented through native bridge');
 assert.equal(validMessage.projectId,project.id);assert.equal(validMessage.objectId,originalReceipt.objectId);
 const rejected=await shell.evaluate(detail=>window.nozeli.invoke('workspace.attention.presented',detail),validMessage);assert.equal(rejected.ok,false,'shell cannot claim a message was shown on a child');
 assert.equal((await state()).todos.find(row=>row.id===todo.id).status,'open','reading does not resolve pending review');
 check('Visible exact native message is relayed to shell; shell spoof is denied and pending review stays open');
 await discussionPage.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
 await discussionVisible('[data-review-instruction]');await discussionPage.$eval('[data-review-instruction]',node=>{node.value='DISCUSS_HOLD';node.dispatchEvent(new Event('input',{bubbles:true}));});await discussionPage.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});await clickDiscussion('[data-review-action="send"]');
 await until(()=>trace.includes('DISCUSS_HOLD'),'held native discussion started');
 await discussionPage.waitForFunction(()=>document.querySelector('.session-task-flow')?.dataset.running==='true');
 assert.match(await discussionPage.$eval('.session-task-detail',node=>node.textContent),/./,'real discussion activity is visible while the Task remains in review');
 assert.equal(await discussionPage.$$eval('.session-task-trail[data-returning=true]',nodes=>nodes.length),0,'a question is not fabricated as an approval modification return');
 await discussionPage.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
 await discussionVisible('[data-review-instruction]');await discussionPage.$eval('[data-review-instruction]',node=>{node.value='DISCUSS_QUEUED';node.dispatchEvent(new Event('input',{bubbles:true}));});await discussionPage.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});await clickDiscussion('[data-review-action="send"]');
 await until(async()=>{const s=await state();return s.jobs.some(j=>j.text==='DISCUSS_QUEUED'&&j.status==='queued');},'second discussion durably queued');
 assert(!trace.includes('DISCUSS_QUEUED'),'second provider turn must not overlap held first turn');
 assert.equal(await reviewPage.$eval('[data-review-action="accept"]',node=>node.disabled),true);
 releaseQueuedTurn();
 await until(async()=>{const s=await state();return s.jobs.find(j=>j.text==='DISCUSS_QUEUED')?.status==='completed'&&s.works[0].status==='review';},'native FIFO discussions settle');
 await discussionPage.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('REVIEW_QUEUED_REPLY'));
 check('Busy approval input enters a durable FIFO queue, executes on the same native owner without overlap and blocks acceptance until drained');
 await send('DISCUSS_MODIFY');
 current=await state();assert.equal(current.works.length,1);assert.equal(current.works[0].threadId,originalThread);
 const publications=current.receipts.filter(r=>r.workId===work.id&&r.kind==='result');assert.equal(publications.length,2);const updated=publications.at(-1);assert.notEqual(updated.objectId,originalReceipt.objectId);
 assert.equal(await reviewPage.evaluate(()=>window.__workspaceScope.viewState?.report?.objectId),originalReceipt.objectId,'new publication never silently upgrades the read object');
 assert.equal(await discussionPage.evaluate(()=>window.__workspaceScope.objectId),originalReceipt.objectId,'discussion read binding remains on the original publication');
 const originalReportPage=reviewPage;
 await clickDiscussion('[data-review-action="latest-discussion"]:not([hidden])');
 reviewPage=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(id=>window.__nozeliReady&&window.__workspaceScope?.kind==='report'&&window.__workspaceScope?.viewState?.report?.objectId===id,updated.objectId).catch(()=>false))return page;},'separate latest report workspace');
 assert.notEqual(reviewPage,originalReportPage);
 assert.equal(await originalReportPage.evaluate(()=>window.__workspaceScope.viewState.report.objectId),originalReceipt.objectId);
 assert.equal(await discussionPage.evaluate(()=>window.__workspaceScope.objectId),originalReceipt.objectId,'opening the new report does not rebind the discussion');
 await visibleReport('REVIEW_REPORT_V2');
 assert.equal(await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8'),sourceBefore);
 check('Publishing leaves the old report and conversation pinned; explicit latest opens a separate report without another Work');await shot('approval-updated');
 const updatedGuest=await visibleReport('REVIEW_REPORT_V2');await updatedGuest.waitForSelector('[data-nozeli-endmatter-action="file"]');await updatedGuest.click('[data-nozeli-endmatter-action="file"]');
 const candidatePage=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(objectId=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='candidate.txt'&&window.__workspaceScope.documentSource?.objectId===objectId,updated.objectId).catch(()=>false))return p;},'single candidate native document');
 await candidatePage.waitForFunction(()=>window.__nozeliInput?.text().includes('updated candidate from approval discussion'));
 assert.equal(await reviewPage.$('dialog[open]'),null,'opening the candidate leaves no modal over the review');
 const reportViewId=await reviewPage.evaluate(()=>window.__workspaceScope.viewId),layout=await shell.evaluate(()=>window.__workspaceGroups.snapshot());
 await invoke(shell,'workspace.command',{projectId:project.id,expectedRevision:layout.revision,requestKey:'approval-smoke-return-report',command:{type:'activate',viewId:reportViewId}});
 check('Single-file review directly opens the exact native candidate and returns without a leftover modal or project overwrite');
 assert.equal(await reviewPage.$('[data-review-discussion]'),null);await reviewPage.click('[data-review-action="open-discussion"]');
 await discussionPage.waitForFunction(objectId=>window.__workspaceScope.objectId===objectId,{},updated.objectId);
 await send('DISCUSS_AFTER');await discussionPage.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('REVIEW_ANSWER_AFTER_UPDATE'));
 // Return to the app after the scripted provider/Inspector round trip. A
 // requested popup follows the active parent without reissuing a show.
 if(!(await nativeDiscussionState()).some(row=>row.visible))await activateTestShell();
 await discussionVisible('[data-review-instruction]');await discussionPage.$eval('[data-review-instruction]',node=>{node.value='UNSENT_APPROVAL_DRAFT';node.dispatchEvent(new Event('input',{bubbles:true}));window.__retainedReviewInput=node;});
 await clickDiscussion('[data-local-window-hide]');
 await reviewPage.waitForSelector('[data-review-action="open-discussion"][aria-expanded="false"]');
 await reviewPage.click('[data-review-action="open-discussion"]');await discussionVisible();
 assert.equal(await discussionPage.$eval('[data-review-instruction]',node=>node.value),'UNSENT_APPROVAL_DRAFT');assert.equal(await discussionPage.evaluate(()=>document.querySelector('[data-review-instruction]')===window.__retainedReviewInput),true);
 for(const theme of ['light','dark'])for(const palette of ['sage','slate'])for(const width of [1440,800]){
  await invoke(shell,'settings.appearance.save',{theme,palette,font:'system',size:14});
  await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width,height:width===800?650:900});
  // An open narrow drawer correctly occludes native report/discussion views.
  if(width<=1000&&await shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')==='true'))await shell.click('#toggle-sidebar');
  await reviewPage.waitForFunction(theme=>document.documentElement.dataset.theme===theme,{},theme);
  await reviewPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await discussionVisible('[data-review-instruction]');
  assert.equal(await discussionPage.$eval('[data-review-instruction]',node=>node.value),'UNSENT_APPROVAL_DRAFT');
  const colors=await discussionPage.evaluate(()=>{
   const c=document.createElement('canvas').getContext('2d'),rgb=v=>{c.clearRect(0,0,1,1);c.fillStyle=v;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3);},lum=v=>rgb(v).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0),contrast=(a,b)=>{a=lum(a);b=lum(b);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);},s=getComputedStyle(document.documentElement),read=n=>s.getPropertyValue(n).trim();
   return {theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette,states:['review','decision','running','queued','paused','unknown','danger'].map(name=>({name,ink:read('--status-'+name+'-ink'),bg:read('--status-'+name+'-bg'),textContrast:contrast(read('--status-'+name+'-ink'),read('--status-'+name+'-bg')),borderContrast:contrast(read('--status-'+name+'-border'),read('--paper'))})),inputHeight:document.querySelector('[data-review-instruction]').getBoundingClientRect().height};
  });
  for(const row of colors.states){assert(row.textContrast>=4.5,theme+'/'+palette+'/'+row.name+' readable text');assert(row.borderContrast>=3,theme+'/'+palette+'/'+row.name+' distinct outline');}
  assert(colors.inputHeight>=48);(report.themeMatrix??=[]).push({theme,palette,width,...colors});
  await discussionPage.screenshot({path:path.join(out,'discussion-'+theme+'-'+palette+'-'+width+'.png')});
  await shell.screenshot({path:path.join(out,'sidebar-'+theme+'-'+palette+'-'+width+'.png')});
  await shot('approval-'+theme+'-'+palette+'-'+width);
 }
 for(const size of [{width:654,height:1150},{width:390,height:844},{width:390,height:480},{width:320,height:480}]){
  await invoke(shell,'workspace.control',{type:'window-control',action:'resize',...size});
  await reviewPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await discussionVisible('[data-review-action="send"]');
  await discussionPage.$eval('[data-review-action="send"]',node=>node.scrollIntoView({block:'nearest'}));
  const geometry=await until(async()=>{const native=(await nativeDiscussionState()).find(row=>row.visible);if(!native)return null;const g=await discussionPage.evaluate(()=>{const float=document.querySelector('[data-review-discussion]').getBoundingClientRect(),send=document.querySelector('[data-review-action="send"]').getBoundingClientRect();return {left:float.left,right:float.right,top:float.top,bottom:float.bottom,floatWidth:float.width,floatHeight:float.height,sendWidth:send.width,sendHeight:send.height,sendBottom:send.bottom,width:innerWidth,height:innerHeight};});return g.floatWidth>0&&g.floatHeight>0&&g.sendWidth>0&&g.sendHeight>0&&g.left>=-1&&g.right<=g.width+1&&g.bottom<=g.height+1&&g.sendBottom<=g.height+1&&Math.abs(g.floatWidth-native.contentBounds.width/native.zoomFactor)<=1&&Math.abs(g.floatHeight-native.contentBounds.height/native.zoomFactor)<=1?{...g,native}:null;},'positive discussion controls match actual native client DIP through zoom',6000);
  (report.windowGeometry??=[]).push({requested:size,actual:geometry});
  await shot('approval-'+size.width+'x'+size.height);
 }
 await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width:1280,height:900});
 const zoomReport=async factor=>observer.evaluate(`(async()=>{const{webContents}=process.mainModule.require('electron');for(const wc of webContents.getAllWebContents()){const scope=await wc.executeJavaScript('window.__workspaceScope').catch(()=>null);if(scope?.role==='surface'&&scope.kind==='report'&&scope.projectId===${JSON.stringify(project.id)}){wc.setZoomFactor(${factor});return wc.getZoomFactor();}}throw Error('Report owner missing');})()`);
 assert.equal(await zoomReport(2),2);await until(async()=>{const native=(await nativeDiscussionState()).find(row=>row.visible&&row.zoomFactor===2);return native;},'200 percent native discussion zoom');
 await discussionVisible('[data-review-action="send"]');
 await discussionPage.$eval('[data-review-action="send"]',node=>node.scrollIntoView({block:'nearest'}));
 const zoomGeometry=await until(()=>discussionPage.evaluate(async()=>{const float=document.querySelector('[data-review-discussion]').getBoundingClientRect();if(Math.abs(float.width-innerWidth)>1||Math.abs(float.height-innerHeight)>1||innerWidth<160)return null;document.querySelector('[data-review-action="send"]').scrollIntoView({block:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const send=document.querySelector('[data-review-action="send"]').getBoundingClientRect(),input=document.querySelector('[data-review-instruction]').getBoundingClientRect();if(send.left<0||send.right>innerWidth+1||send.bottom>innerHeight+1||input.left<0||input.right>innerWidth+1||input.bottom>innerHeight+1)return null;return {width:innerWidth,height:innerHeight,send:{left:send.left,right:send.right,top:send.top,bottom:send.bottom},input:{left:input.left,right:input.right,top:input.top,bottom:input.bottom},draft:document.querySelector('[data-review-instruction]').value};}),'settled CSS and reachable single-scroll input through native zoom');
 assert(zoomGeometry.send.left>=0&&zoomGeometry.send.right<=zoomGeometry.width+1&&zoomGeometry.send.bottom<=zoomGeometry.height+1);assert(zoomGeometry.input.left>=0&&zoomGeometry.input.right<=zoomGeometry.width+1&&zoomGeometry.input.bottom<=zoomGeometry.height+1);assert.equal(zoomGeometry.draft,'UNSENT_APPROVAL_DRAFT');report.zoom200=zoomGeometry;await discussionPage.screenshot({path:path.join(out,'discussion-zoom200.png')});await zoomReport(1);await until(async()=>{const native=(await nativeDiscussionState()).find(row=>row.visible&&row.zoomFactor===1);return native;},'normal native discussion zoom');
 check('Actual narrow/short native surfaces retain the movable discussion and reachable input; adoption belongs to the report footer');
 check('Latest report discussion remains in the original thread, and collapsing/reopening retains the Work-scoped unsent draft');
 await clickDiscussion('[data-local-window-hide]');
 await reviewPage.waitForSelector('[data-review-action="accept"]:not([disabled])',{visible:true});await reviewPage.click('[data-review-action="accept"]');await reviewPage.waitForSelector('[data-confirmation-dialog][open]');report.acceptConfirmation=await reviewPage.$eval('[data-confirmation-dialog]',node=>node.innerText);await shot('approval-accept-confirmation');await reviewPage.click('[data-confirmation-cancel]');
 assert.equal((await state()).works[0].status,'review');
 await reviewPage.click('[data-review-action="accept"]');await reviewPage.waitForSelector('[data-confirmation-dialog][open]');await reviewPage.click('[data-confirmation-confirm]');
 await until(async()=>{const w=(await state()).works[0];return ['closing','ended'].includes(w.status)&&w.outcome==='accept';},'exact-version accept recorded');
 await until(async()=>{const w=(await state()).works[0];if(w.closure?.phase==='blocked')throw Error('closure blocked: '+JSON.stringify(w.closure));return w.status==='ended'&&w.closure?.phase==='complete';},'host merge and original task closure',60000);
 assert.equal(await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8'),'updated candidate from approval discussion\n');
 const final=await state();assert.equal(final.works.length,1);assert.equal(final.jobs.filter(j=>j.text==='UNSENT_APPROVAL_DRAFT').length,0);assert.equal(final.works[0].threadId,originalThread);
 check('Footer acceptance supports cancel then explicit exact-version accept, starts original closure and does not dispatch the unsent draft');
 assert.equal(await fs.readFile(path.join(projectRoot,paraPath),'utf8'),paraText);
 const prepared=await invoke(shell,'store.imports.prepareMigration',{projectId:project.id});
 assert.equal(prepared.developmentKind,'skill');assert.equal(prepared.status,'prepared');assert.match(prepared.request,/cluster-ssh.*PTY/);assert.equal((await state()).jobs.length,final.jobs.length);
 check('Store prepares a project-bound migration handoff without launching work');
 await activateTestShell();await shell.click('#workspace-store');await storeAction('reviewedList');await storeAction('reviewed');
 await shell.waitForSelector('[data-import-candidate]',{visible:true});
 const reviewedId=await shell.$eval('[data-import-candidate]',node=>node.dataset.importCandidate);
 await shell.click('[data-import-candidate]');await candidateRole(reviewedId,'frontdesk');await shell.click('[data-import-enable]');await storeAction('install');
 const capacitySkill=await until(async()=>(await invoke(shell,'store.imports.list',{projectId:project.id})).find(row=>row.name==='paracloud-gpu-capacity'),'reviewed capacity skill installed');
 await shell.click('#local-resource-store .store-close');
 const frontOwner=(await state()).agents.find(row=>row.target==='frontdesk');
 for(const [text,selected,expected] of [['PARACLOUD_SCOPE_TEST',false,'CAPACITY_SCOPE'],['PARACLOUD_SKILL_TEST',true,'CAPACITY_NOT_CONFIGURED'],['PARACLOUD_ADVISORY_TEST',true,'eligibility-unverified'],['PARACLOUD_QUEUE_TEST',true,'PENDING'],['PARACLOUD_WRITE_DENIED_TEST',true,'CAPACITY_WRITE_NOT_AUTHORIZED']]){
  if(text==='PARACLOUD_ADVISORY_TEST')await invoke(shell,'store.imports.saveCapacityConfig',{projectId:project.id,config:{sshAlias:'capacity-fixture',partition:'gpu-research'}});
  await invoke(conversationPage,'managed.send',{projectId:project.id,target:'frontdesk',lane:'next',requestKey:text,text,...(selected?{importedSkill:{id:capacitySkill.id,version:capacitySkill.version}}:{})});
  await until(async()=>{const job=(await state()).jobs.find(row=>row.text===text);if(job?.status==='failed')throw Error(job.error||job.errorCode);return job?.status==='completed';},text);
  assert.match(paraResults.at(-1),new RegExp(expected));
  if(text==='PARACLOUD_ADVISORY_TEST'){assert.match(paraResults.at(-1),/"resourceFit"\s*:\s*"fit"/);assert(!paraResults.at(-1).includes('fixture-node'));}
 }
 assert.equal((await state()).agents.find(row=>row.target==='frontdesk').threadId,frontOwner.threadId);
 check('Accepted ParaCloud skill reaches native capacity and queue tools while writes require project authorization');
 assert.deepEqual(provider.errors,[]);assert.deepEqual(errors,[]);report.providerCalls=provider.requests.length;report.trace=trace;report.finalStatus=final.works[0].status;report.ok=true;
 observer.close();observer=null;
 await invoke(shell,'session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;
}catch(error){report.error=error.stack;process.exitCode=1;report.nativeDiscussion=await nativeDiscussionState().catch(()=>null);report.childSurface=await discussionPage?.evaluate(()=>({scope:window.__workspaceScope,html:document.querySelector('[data-review-discussion]')?.outerHTML,body:document.body.innerText})).catch(()=>null);report.surface=await reviewPage?.evaluate(()=>({scope:window.__workspaceScope,text:document.body.innerText.slice(-7000)})).catch(()=>null);await reviewPage?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{
 observer?.close();
 releaseQueuedTurn();
 releaseIntake();
 if(child?.exitCode===null){try{await Promise.race([invoke(shell,'session.requestClose'),pause(10000)]);await Promise.race([exit,pause(10000)]);}catch{}if(child.exitCode===null)child.kill('SIGTERM');}
 await browser?.disconnect().catch(()=>{});await provider.close();report.errors=errors;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));
}
