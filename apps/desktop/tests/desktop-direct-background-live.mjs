// Real Electron + native Pi + loopback scripted provider. Synthetic isolated project only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {serve} from './pi-provider.fixture.mjs';
const source=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-direct-background-')),project=path.join(out,'project'),config=path.join(out,'config'),profile=path.join(config,'desktop');
await fs.mkdir(project);await fs.writeFile(path.join(project,'input.txt'),'USER INPUT MUST REMAIN UNCHANGED\n');
const host=new DesktopHost(profile),projectId=(await host.registerDirectory(project)).id;await host.storage.db.close();
let workerCalls=0;const requests=[];
const provider=await serve(request=>{
 const names=request.tools.map(tool=>tool.function?.name||tool.name),role=names.includes('nozeli_dispatch')?'orchestrator':names.includes('nozeli_publish')?'worker':'frontdesk';requests.push(role);
 if(role==='orchestrator')return {id:'dispatch-direct',tool:'nozeli_dispatch',args:{name:'DIRECT_BACKGROUND',brief:'Create result.txt containing exactly DIRECT_BACKGROUND in the execution worktree, then publish a complete static HTML result and result.txt.'}};
 if(role==='worker'&&workerCalls++===0)return {id:'write-direct',tool:'bash',args:{command:"printf DIRECT_BACKGROUND > result.txt"}};
 if(role==='worker')return {id:'publish-direct',tool:'nozeli_publish',args:{kind:'result',content:'<!doctype html><html><head><title>Direct background result</title></head><body><main><h1>DIRECT_BACKGROUND complete</h1><p>Real isolated native task result.</p></main></body></html>',files:['result.txt']}};
 return {text:'FRONTDESK_MUST_NOT_BE_CALLED'};
});
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)))delete env[key];
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:out});
const report={ok:false,out,checks:[],scope:'Actual source Electron, native Pi owners, real files/Git; localhost scripted provider, no paid model or user data'};
let child,browser,shell,chat,log='';const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(child&&child.exitCode!==null)throw Error('App exited '+log);const result=await fn();if(result)return result;await pause(40);}throw Error('Timeout '+label);}
async function call(page,op,args={}){const result=await page.evaluate((op,args)=>window.nozeli.invoke(op,args),op,args);assert(result.ok,op+': '+JSON.stringify(result.error));return result.value;}
async function scoped(kind){return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(kind=>window.__nozeliReady&&(kind==='shell'?window.__workspaceScope?.role==='shell':window.__workspaceScope?.kind===kind),kind).catch(()=>false))return page;},kind);}
async function state(){return (await call(shell,'managed.status',{projectId})).state;}
async function workspaceCommand(command){const {layout}=await call(shell,'workspace.snapshot',{projectId});return call(shell,'workspace.command',{projectId,expectedRevision:layout.revision,requestKey:crypto.randomUUID(),command});}
async function conversationGeometry(){return chat.evaluate(()=>{
 const panel=document.querySelector('#conversation-panel'),style=getComputedStyle(panel),form=document.querySelector('#compose-form'),timeline=document.querySelector('.session-timeline'),status=document.querySelector('.collaboration-status'),scroll=document.querySelector('#conversation');
 return {viewport:innerWidth,available:panel.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),form:form.getBoundingClientRect().width,timeline:timeline.getBoundingClientRect().width,scroll:scroll.clientWidth,status:status.getBoundingClientRect().width,draft:document.querySelector('#composer').value,selection:[document.querySelector('#composer').selectionStart,document.querySelector('#composer').selectionEnd],sameComposer:document.querySelector('#composer')===window.__widthComposer,sameTimeline:timeline===window.__widthTimeline,selectedText:getSelection()?.toString()||'',expectedSelectedText:window.__widthSelectedText,horizontalOverflow:document.documentElement.scrollWidth>innerWidth};
 });}
async function checkConversationWidth(label){
 const value=await conversationGeometry();
 assert(value.form>=value.available*.94&&value.form<=value.available+2,label+' composer uses the pane width: '+JSON.stringify(value));
 assert(value.status>=value.available*.94&&value.status<=value.available+2,label+' execution summary follows composer width');
 assert(value.timeline>=value.scroll*.94&&value.timeline<=value.scroll+2,label+' messages use the scroll pane width');
 assert.equal(value.horizontalOverflow,false,label+' no horizontal overflow');
 assert.equal(value.draft,'WIDTH_DRAFT_KEEP: 输入和材料不能因调整布局而丢失。');assert.equal(value.sameComposer,true);assert.equal(value.sameTimeline,true);assert.deepEqual(value.selection,[6,18]);assert.equal(value.selectedText,value.expectedSelectedText,label+' message selection remains intact');
 report.widths??=[];report.widths.push({label,...value});return value;
}
try{
 child=spawn(createRequire(import.meta.url)('electron'),[path.join(source,'src/main/main.cjs'),'--ozone-platform=x11'],{cwd:source,env,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'CDP');shell=await scoped('shell');
 const cfg=await call(shell,'config.status');if(cfg.choiceRequired)await call(shell,'config.initialize',{mode:'independent'});
 await call(shell,'settings.providers.save',{operation:'create',provider:'direct-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'nonsecret-local-fixture'}});
 await call(shell,'settings.models.save',Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'explicit',selector:'direct-local/scripted'},thinking:{mode:'native-default'}}])));
 await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id,{},projectId);await call(shell,'managed.enable',{projectId});await call(shell,'workspace.control',{type:'conversation-action',projectId,action:'open',target:'frontdesk'});chat=await scoped('conversation');
 await chat.waitForSelector('#submit-background:not([disabled])',{visible:true});assert.equal(await chat.$eval('#submit-background',n=>n.type),'button');
 await chat.locator('#composer').fill('KEEP_DRAFT_ON_MATERIAL_FAILURE');
 await chat.evaluate(projectId=>window.__composerMaterials.restore({pending:[{key:'failed',source:'file',name:'unread.txt',status:'error',note:'Synthetic unavailable source'}],quote:{role:'user',text:'保留引用。'}},{projectId,target:'frontdesk'}),projectId);
 const materialBefore=await chat.evaluate(()=>window.__composerMaterials.snapshotPersist());await chat.click('#submit-background');
 await chat.waitForFunction(()=>document.querySelector('#compose-status').textContent.includes('材料未就绪'));
 assert.equal(await chat.$eval('#composer',n=>n.value),'KEEP_DRAFT_ON_MATERIAL_FAILURE');assert.deepEqual(await chat.evaluate(()=>window.__composerMaterials.snapshotPersist()),materialBefore);assert.equal((await state()).jobs.length,0);assert.equal(requests.length,0);report.checks.push('failed validation retains exact draft/materials and dispatches nothing');
 await chat.evaluate(projectId=>window.__composerMaterials.restore({pending:[],quote:null},{projectId,target:'frontdesk'}),projectId);
 await chat.locator('#composer').fill('Create DIRECT_BACKGROUND result.txt in the dedicated execution worktree, publish result.txt and a static HTML report.');
 await chat.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await chat.screenshot({path:path.join(out,'button-before.png')});
 await chat.evaluate(()=>{window.__taskEvents=[];for(const type of ['pointerdown','click'])document.querySelector('#submit-background').addEventListener(type,event=>window.__taskEvents.push({type,trusted:event.isTrusted}),true);});
 await chat.click('#submit-background');await chat.click('#submit-background');
 const work=await until(async()=>{const s=await state();return s.works.find(w=>w.name==='DIRECT_BACKGROUND'&&w.status==='review');},'real direct background result',60000);
 const s=await state();assert.equal(s.works.length,1);assert.equal(s.jobs.filter(j=>j.type==='intake'&&j.target==='orchestrator').length,1);assert.equal(s.jobs.filter(j=>j.type==='front').length,0);assert.equal(s.jobs.filter(j=>j.target===work.id&&j.type==='initial').length,1);assert.equal(requests.filter(role=>role==='frontdesk').length,0);
 assert.equal(await fs.readFile(path.join(work.execution.directory,'result.txt'),'utf8'),'DIRECT_BACKGROUND');await assert.rejects(fs.stat(path.join(project,'result.txt')),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(project,'input.txt'),'utf8'),'USER INPUT MUST REMAIN UNCHANGED\n');
 await chat.waitForFunction(()=>document.querySelector('#composer').value==='');report.events=await chat.evaluate(()=>window.__taskEvents);assert(report.events.some(event=>event.type==='click'&&event.trusted));report.checks.push('visible repeated clicks create one orchestrator intake and one real native Worker, never a foreground message');report.checks.push('accepted snapshot clears and actual Worker result stays isolated pending review');
 assert.equal(await chat.$eval('#toast',node=>node.hidden||!node.textContent.startsWith('发送未发出')),true,'a corrected accepted submission does not retain its obsolete failure notice');
 const submitted=s.messages.find(message=>message.speaker==='user'&&message.taskRequestId===s.jobs.find(job=>job.type==='intake').id);
 await chat.waitForSelector('[data-message="'+submitted.id+'"] [data-input-route="background"]');
 assert.equal(await chat.$eval('[data-message="'+submitted.id+'"]',node=>node.querySelector('header').textContent.includes('后台任务')&&![...node.querySelectorAll('.message-actions button')].some(button=>button.textContent==='转为后台任务')),true,'accepted direct task is visibly background, never offered as an unsent conversation to convert again');
 report.checks.push('accepted background input carries its task badge and removes the duplicate conversion action');
 const taskCard='[data-workflow-work="'+work.id+'"].session-task-card';
 await chat.waitForSelector(taskCard);
 const cardGeometry=await chat.$eval(taskCard,node=>{window.__directTaskCard=node;const r=node.getBoundingClientRect(),p=node.parentElement.getBoundingClientRect();return {width:r.width,available:p.width,tone:node.dataset.taskTone,inputInside:!!node.querySelector('[data-input-route="background"]')};});
 assert(cardGeometry.width>=Math.min(560,cardGeometry.available)-2&&cardGeometry.width<=cardGeometry.available+1);assert(cardGeometry.tone);assert.equal(cardGeometry.inputInside,true);
 await chat.screenshot({path:path.join(out,'button-after.png')});
 await chat.locator('#composer').fill('WIDTH_DRAFT_KEEP: 输入和材料不能因调整布局而丢失。');
 await chat.evaluate(()=>{window.__widthComposer=document.querySelector('#composer');window.__widthTimeline=document.querySelector('.session-timeline');window.__widthComposer.setSelectionRange(6,18);window.__widthComposer.blur();const text=document.querySelector('.session-timeline .session-markdown p');const range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);window.__widthSelectedText=getSelection().toString();});
 for(const width of [1440,980,590,1440]){
  const before=await conversationGeometry(),rootWidth=await shell.evaluate(()=>innerWidth);await call(shell,'session.resize',{width,height:900});await shell.waitForFunction(width=>innerWidth===width,{},width);
  if(rootWidth!==width)await until(async()=>Math.abs((await conversationGeometry()).viewport-before.viewport)>1,'native conversation resize '+width);
  await chat.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await checkConversationWidth('window-'+width);await chat.screenshot({path:path.join(out,'fluid-window-'+width+'.png')});
 }
 assert(report.widths[0].form>report.widths[2].form*1.5,'wide conversation expands instead of staying capped at the old fixed column');
 const viewId=await chat.evaluate(()=>window.__workspaceScope.viewId),groupId=await shell.$eval('[data-view-id="'+viewId+'"]',node=>node.closest('[data-workspace-group]').dataset.workspaceGroup);
 const fullPaneWidth=(await conversationGeometry()).viewport;
 await workspaceCommand({type:'split',groupId,axis:'x',side:'after'});
 await shell.waitForSelector('.workspace-divider',{visible:true});
 await until(async()=>(await conversationGeometry()).viewport<fullPaneWidth-100,'native split bounds settle before dragging');
 const splitBefore=await checkConversationWidth('split-before-drag'),divider=await shell.$('.workspace-divider'),box=await divider.boundingBox();assert(box);
 await shell.bringToFront();await shell.mouse.move(box.x+box.width/2,box.y+box.height/2);await shell.mouse.down();await shell.mouse.move(box.x+box.width/2+100,box.y+box.height/2,{steps:20});
 await until(async()=>Math.abs((await conversationGeometry()).viewport-splitBefore.viewport)>30,'native pane width changes during divider drag');
 await shell.mouse.up();await checkConversationWidth('split-after-drag');
 await workspaceCommand({type:'floatOpen',viewId});
 const detached=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.role==='detached'&&window.__nozeliReady).catch(()=>false))return p;},'detached conversation chrome');
 await until(()=>chat.evaluate(()=>window.__workspaceScope.windowId!=='main'),'same conversation moved to detached window');
 for(const width of [1120,680]){
  const previous=await conversationGeometry();await call(chat,'session.resize',{width,height:800});await detached.waitForFunction(width=>innerWidth===width,{},width);
  await until(async()=>Math.abs((await conversationGeometry()).viewport-previous.viewport)>40,'detached content responds '+width);
  await checkConversationWidth('detached-'+width);await chat.screenshot({path:path.join(out,'fluid-detached-'+width+'.png')});
 }
 await detached.click('[data-workspace-command="dock"]');await until(()=>detached.isClosed(),'detached chrome closes after dock');await until(()=>chat.evaluate(()=>window.__workspaceScope.windowId==='main'),'same conversation returns to main');await checkConversationWidth('docked');
 report.checks.push('messages, execution summary and composer follow native window, live divider and detached pane widths without replacing the input or losing its draft/selection');
 await call(shell,'session.resize',{width:590,height:800});
 await chat.waitForFunction(()=>innerWidth<=590);
 assert.equal(await chat.evaluate(()=>['submit-background','send-message'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth;})),true,'both direct submission actions stay visible in a narrow native surface');
 await chat.screenshot({path:path.join(out,'button-narrow.png')});
 const afterLayout=await state();assert.deepEqual(afterLayout.jobs.map(job=>job.id),s.jobs.map(job=>job.id));assert.deepEqual(requests,['orchestrator','worker','worker']);assert.equal(afterLayout.drafts.frontdesk,'WIDTH_DRAFT_KEEP: 输入和材料不能因调整布局而丢失。');
 assert.equal(await chat.$eval(taskCard,node=>node===window.__directTaskCard),true,'original card DOM survives layout actions');
 assert.equal((await state()).works.find(row=>row.id===work.id).status,'review','delivery is not automatic acceptance');
 const binding={workId:work.id,revision:work.revision,objectId:work.result.objectId,candidateCommit:work.execution.candidate.commit};
 await call(shell,'managed.end',{projectId,workId:work.id,revision:work.revision,decision:'discard',binding,requestKey:'direct-visible-discard-closeout'});
 await until(async()=>{const latest=(await state()).works.find(w=>w.id===work.id);return latest?.status==='ended'&&latest.closure?.phase==='complete';},'real discard closeout');
 await until(()=>chat.$eval(taskCard,node=>node.dataset.state==='ended'),'original card reflects actual ended state');
 await assert.rejects(fs.stat(path.join(project,'result.txt')),{code:'ENOENT'});assert.deepEqual(requests,['orchestrator','worker','worker'],'closeout never creates another model turn');
 await chat.reload({waitUntil:'domcontentloaded'});await chat.waitForFunction(()=>window.__nozeliReady);await chat.waitForSelector(taskCard);
 assert.equal(await chat.$eval('#composer',node=>node.value),'WIDTH_DRAFT_KEEP: 输入和材料不能因调整布局而丢失。');
 await chat.$eval(taskCard,node=>node.scrollIntoView({block:'center'}));await chat.screenshot({path:path.join(out,'discard-task-card.png')});report.checks.push('actual discard closes original Work and survives reload without model replay or draft loss');
 const settledWork=(await state()).works.find(w=>w.id===work.id);report.work={id:work.id,status:settledWork.status,revision:settledWork.revision,closurePhase:settledWork.closure.phase};report.jobs=s.jobs.map(j=>({id:j.id,type:j.type,target:j.target,status:j.status}));report.requests=requests;
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));await call(shell,'session.requestClose');report.exit=await Promise.race([exited,pause(30000).then(()=>null)]);assert.deepEqual(report.exit,{code:0,signal:null});
 await browser.disconnect();browser=null;
 child=spawn(createRequire(import.meta.url)('electron'),[path.join(source,'src/main/main.cjs'),'--ozone-platform=x11'],{cwd:source,env,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'cold main-process CDP');shell=await scoped('shell');
 await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id,{},projectId);await call(shell,'workspace.control',{type:'conversation-action',projectId,action:'open',target:'frontdesk'});chat=await scoped('conversation');
 await chat.waitForSelector('[data-workflow-work="'+work.id+'"].session-task-card');
 assert.equal(await chat.$$eval('[data-workflow-work="'+work.id+'"].session-task-card',nodes=>nodes.length),1,'cold process shows one original task card');
 assert.deepEqual((await state()).jobs.map(job=>job.id),s.jobs.map(job=>job.id));assert.deepEqual(requests,['orchestrator','worker','worker']);
 await chat.screenshot({path:path.join(out,'cold-task-card.png')});report.checks.push('cold restart preserves one original task card and exact jobs without model replay');
 const coldExit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));await call(shell,'session.requestClose');report.coldExit=await Promise.race([coldExit,pause(30000).then(()=>null)]);assert.deepEqual(report.coldExit,{code:0,signal:null});report.ok=true;
}catch(error){report.error=error.stack;report.ui=await chat?.evaluate(()=>({text:document.body.innerText.slice(-1500),events:window.__taskEvents,button:document.querySelector('#submit-background')?.outerHTML})).catch(()=>null);await chat?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{await browser?.disconnect();if(child?.exitCode===null)child.kill('SIGTERM');await provider.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
