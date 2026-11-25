// Explicit local acceptance; optional test of the installed executable.
// OMP generates a real journal for an isolated snapshot of the product repository.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {serve,prepare} from './pi-provider.fixture.mjs';
import {DesktopHost} from '../src/main/host.mjs';

const source=path.resolve(import.meta.dirname,'..');
const app=process.env.NOZELI_TEST_APP_ROOT||source;
const demo=process.argv.includes('--demo')||process.argv.includes('--demo-check');
const interactive=process.argv.includes('--demo');
const sourceDemo=demo&&process.argv.includes('--demo-source');
const slashDemo=sourceDemo||(demo&&process.argv.includes('--demo-slash'));
const branchDemo=sourceDemo||(demo&&process.argv.includes('--demo-branch'));
const binary=process.env.NOZELI_TEST_BINARY||(demo&&!sourceDemo?path.join(os.userInfo().homedir,'.local/opt/nozeli/current/nozeli'):createRequire(import.meta.url)('electron'));
const omp=process.env.NOZELI_TEST_OMP;
// Optional acceptance against existing journals. The caller supplies a private
// writable project mount at the original canonical cwd, with journals bound read-only.
const realProject=process.env.NOZELI_TEST_MEMORY_PROJECT;
const demoRows=[
 {provider:'codex', id:'demo-release-decision', text:'已决定：下周三先向 10 位试用者开放离线批注；不自动分享任何批注。'},
 {provider:'omp', id:'demo-acceptance-notes', text:'待核实：发布前验证断网重开后，批注仍能定位到原段落；负责人：林。'},
];
const realIds=demo?demoRows.map(row=>row.id):process.env.NOZELI_TEST_MEMORY_IDS?.split(',');
assert(!(demo&&realProject),'Demo must not access existing projects');
if(realProject)assert(realIds?.length===2&&new Set(realIds).size===2);
const expectedAgents=process.env.NOZELI_TEST_MEMORY_AGENTS?JSON.parse(process.env.NOZELI_TEST_MEMORY_AGENTS):null;
if(!realProject&&!demo)assert(omp&&path.isAbsolute(omp),'Provide the standalone executable with NOZELI_TEST_OMP');
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-memory-live-'));
const project=realProject||path.join(tmp,demo?'离线批注 · 工作记忆 Demo':'Nozeli-project'),projectName=path.basename(project),config=path.join(tmp,'config'),profile=path.join(config,'desktop'),home=path.join(tmp,'home');
if(!realProject)await fs.mkdir(project);await fs.mkdir(home);
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
if(demo){
 await fs.writeFile(path.join(project,'README.md'),'# 离线批注演示项目\n\n合成日志用于演示工作记忆；不含日常会话。\n');
 await fs.writeFile(path.join(project,'.gitignore'),'/.ccb/\n');
 const sessions=interactive?demoRows:[...demoRows,...Array.from({length:19},(_,i)=>({provider:'omp',id:`older-session-${i}`,text:'Earlier acceptance context'}))];
 for(const [index,{provider,id,text}] of sessions.entries()){
  const codex=provider==='codex', timestamp=new Date(Date.now()-index*86400000).toISOString();
  const dir=codex?path.join(project,'.ccb/agents/frontdesk/provider-state/codex/home/sessions'):path.join(home,'.omp/agent/sessions');
  await fs.mkdir(dir,{recursive:true});
  const rows=codex?[{type:'session_meta',timestamp,payload:{id,cwd:project}}, {type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}]
   :[{type:'session',version:3,id,cwd:project,timestamp},{type:'message',id:'a',parentId:null,timestamp,message:{role:'user',content:[{type:'text',text}]}}];
  if(provider==='omp'&&id===demoRows[1].id)rows.push(
   {type:'message',id:'b',parentId:'a',timestamp,message:{role:'assistant',content:[{type:'text',text:'断网重开验证尚未执行；先保存离线批注，再检查原段落锚点。'}]}},
   {type:'message',id:'c',parentId:'b',timestamp,message:{role:'user',content:[{type:'text',text:'验证通过前，不扩大试用范围。'}]}});
  if(branchDemo&&codex)rows.push({type:'event_msg',timestamp,payload:{type:'thread_rolled_back'}});
  const file=path.join(dir,id+'.jsonl');await fs.writeFile(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  await fs.utimes(file,new Date(timestamp),new Date(timestamp));
 }
}else if(!realProject)for(const file of ['README.md','apps/desktop/package.json']){
 const dest=path.join(project,file);await fs.mkdir(path.dirname(dest),{recursive:true});
 await fs.writeFile(dest,execFileSync('git',['show',revision+':'+file],{cwd:source}));
}
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const readme=path.join(project,'README.md'),readmeHash=realProject?null:await hash(readme);
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;
await host.storage.db.close();
const env={...process.env};
for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
Object.assign(env,{HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_CACHE_HOME:path.join(home,'.cache'),NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_PICK:project,NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_HIDDEN:'0'});
const fact='DOC-DECISION-'+randomUUID(),draft='UNSENT-'+randomUUID();
const prompt='Document this decision for the current repository: '+fact+'. The next contributor should check whether README instructions match package.json. Do not change anything.';
let journal,journalHash;
if(!realProject&&!demo){
const journalProvider=await serve(()=>({text:'Recorded '+fact+'. README/package.json consistency remains unverified.'}));
const sessions=path.join(home,'.omp/agent/sessions');await fs.mkdir(sessions,{recursive:true});
const setup=await prepare(journalProvider.url);
async function findJournal(root){for(const ent of await fs.readdir(root,{withFileTypes:true})){const file=path.join(root,ent.name);if(ent.isDirectory()){const nested=await findJournal(file);if(nested)return nested;}else if(ent.name.endsWith('.jsonl'))return file;}}
try{
 const ompEnv={...env,PI_CODING_AGENT_DIR:setup.agentDir};
 for(const k of Object.keys(ompEnv))if(k.startsWith('NOZELI_'))delete ompEnv[k];
 const running=promisify(execFile)(omp,['--cwd',project,'--session-dir',sessions,'--no-tools','--no-extensions','--no-skills','--model','local-fixture/scripted','--print',prompt],{env:ompEnv,timeout:30000});
 running.child.stdin.end();
 await running;
 journal=await findJournal(sessions);
 assert(journal,'OMP saved a standalone journal');assert.equal(journalProvider.errors.length,0);
}finally{await journalProvider.close();await fs.rm(setup.root,{recursive:true,force:true});}
 journalHash=await hash(journal);
}
let importCalls=0,phase='import',ranges,selectedEvidence,reportSource;
let correctedEvidenceRead=false;
let analysisRecords,readIndex,rejectedEarlyReport=false;
const reportMarker='HANDOFF-REPORT-EVIDENCE';
const escapeHtml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const provider=await serve((request,round)=>{
 const names=request.tools?.map(t=>t.function?.name)??[];
 const lastUser=request.messages.findLastIndex(row=>row.role==='user');
 const recallStart=request.messages.findLastIndex(row=>row.role==='user'&&JSON.stringify(row.content).includes(reportMarker));
 const currentText=JSON.stringify(request.messages[lastUser]?.content??'');
 const activeCalls=new Set(request.messages.slice(recallStart>=0?recallStart+1:0).flatMap(row=>(row.tool_calls??[]).filter(call=>names.includes(call.function?.name)).map(call=>call.id)));
 const raw=request.messages.findLast(row=>row.role==='tool'&&activeCalls.has(row.tool_call_id));
 const value=raw?JSON.parse(raw.content):null;
 const call=(tool,args={})=>({tool,id:'handoff-'+round,args});
 if(names.includes('nozeli_project_inventory')){
  assert.equal(phase,'import','Reopen must not replay initialization');
  return !value?call('nozeli_project_inventory'):call('nozeli_project_map',{expectedVersion:value.map.expectedVersion,text:'Isolated acceptance project.'});
 }
 if(slashDemo&&currentText.includes('SLASH-ACTIVATION-CHECK')){
  assert(currentText.includes('User-selected bundled Frontdesk skill (nozeli-frontdesk-project-analysis)'));
  return {text:'Explicit project analysis skill received.'};
 }
 assert(!names.includes('nozeli_handoff_dispatch'),'confirmed handoff routing must not depend on model output');
 if(names.length===2&&names.includes('nozeli_publish')&&names.includes('nozeli_frontdesk_work_memory')){
  ++importCalls;
  const evidence=(action,args={})=>call('nozeli_frontdesk_work_memory',{action,...args});
  const publish=content=>call('nozeli_publish',{kind:'result',files:[],content});
  if(!value){selectedEvidence=[];return evidence('prepare');}
  if(value.saved)return {text:'已发布工作交接报告。'};
  if(value.error?.code==='HANDOFF_ANALYSIS_EVIDENCE_REQUIRED'){
   assert.equal(value.continueTurn,true);assert.deepEqual(value.error.remainingRecords,analysisRecords);
   rejectedEarlyReport=true;
   return evidence('read',{...(branchDemo?{id:ranges[0].sessionId}:{}),record:readIndex});
  }
  if(value.ok===false){
   assert.equal(value.error.code,'INVALID_PAYLOAD');assert.equal(value.effect,'none');assert.equal(value.continueTurn,true);
   assert.match(value.correction,/可省略 id/);
   assert.equal(correctedEvidenceRead,false);correctedEvidenceRead=true;
   return evidence('read',{record:readIndex});
  }
  if(value.kind!=='evidence'){
   ranges=value.sources??[{provider:value.provider,agent:value.agent,sessionId:value.sessionId,recordCount:value.recordCount,startRecord:0}];
   if(realIds)assert.deepEqual(ranges.map(row=>row.sessionId).sort(),[...realIds].sort());
   if(expectedAgents)for(const {agent,sessionId,provider,agentStatus} of ranges)assert.deepEqual({agent,provider,agentStatus},expectedAgents[sessionId]);
   analysisRecords=value.analysisRecords;readIndex=analysisRecords[0];
   if(demo){assert.deepEqual(analysisRecords,[0,1,2,3]);return publish('<h1>不应发布的来源清单</h1>');}
   return evidence('read',{record:readIndex});
  }
  const source=ranges.find(row=>row.startRecord<=readIndex&&readIndex<row.startRecord+row.recordCount);
  assert.equal(value.sessionId,source.sessionId);
  if(value.nextOffset!==null)return evidence('read',{record:readIndex,offset:value.nextOffset});
  assert(value.record.text.trim());selectedEvidence.push({source,location:value.record.location,time:value.record.time,text:value.record.text,index:readIndex});
  readIndex=analysisRecords[selectedEvidence.length];if(readIndex!==undefined)return evidence('read',{record:readIndex});
  const refs=selectedEvidence.map(({source,location,index})=>`<li>[${index}] ${escapeHtml(source.agent??source.provider)} · ${escapeHtml(source.sessionId)} · ${location.lineOrdinal==null?'字节偏移 '+location.byteOffset:'原日志第 '+location.lineOrdinal+' 行'}</li>`).join('');
  if(demo){
   assert(selectedEvidence[0].text.includes('10 位试用者'));
   assert(selectedEvidence[1].text.includes('批注仍能定位'));
   assert(selectedEvidence[2].text.includes('尚未执行'));
   assert(selectedEvidence[3].text.includes('不扩大试用范围'));
  }
  const content=demo?'<h2>任务背景</h2><p>离线批注计划先开放给 10 位试用者，不自动共享批注 [0]。</p><h2>进展与决策</h2><p>试用范围已决定，但发布前的断网恢复验证尚未执行 [1–2]。</p><h2>未决与接续建议</h2><p>先保存离线批注、断网重开并核对原段落锚点；在验证通过前不扩大试用范围 [2–3]。</p>':`<h2>本次验收读取的实际对话</h2><ul>${selectedEvidence.map(({index,text})=>`<li>[${index}] ${escapeHtml(text.slice(0,180))}</li>`).join('')}</ul><p>脚本验收不判断这些陈述是否仍有效。</p>`;
  return publish(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>工作状态继承</title></head><body><main><h1>工作状态继承</h1>${content}<h2>证据与覆盖范围</h2><p>仅基于所读冻结记录；历史陈述不代表当前已验证。</p><ul>${refs}</ul><p>${reportMarker}</p></main></body></html>`);
 }
 if(recallStart>=0&&names.includes('nozeli_memory_search')){
  if(!value)return call('nozeli_memory_search',{query:reportMarker});
  if(value.matches){
   if(phase==='before-review'){assert.deepEqual(value.matches,[]);return {text:'待审报告未入库。'};}
   assert.equal(value.matches.length,1);reportSource=value.matches[0].source;
   return call('nozeli_memory_read',{source:reportSource});
  }
  assert(value.text.includes(reportMarker));return {text:'已读回采纳后的 Worker 报告。'};
 }
 throw Error('Unexpected model round '+phase+'/'+round+': '+names.join(','));
});
let child,browser,shell,chat,exited,log='';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=45000){
 const end=Date.now()+ms;
 while(Date.now()<end){if(provider.errors.length)throw provider.errors[0];if(child?.exitCode!==null)throw Error('Electron exited: '+log);const result=await fn();if(result)return result;await pause(100);}
 throw Error('Timeout: '+label+'\n'+log.slice(-1600));
}
async function invoke(page,op,payload={}){
 const r=await page.evaluate((op,payload)=>window.nozeli.invoke(op,payload),op,payload);
 assert.equal(r.ok,true,op+': '+JSON.stringify(r.error));return r.value;
}
const state=async ()=>(await invoke(shell,'managed.status',{projectId})).state;
async function launch(){
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 child=spawn(binary,[...(!sourceDemo&&(demo||process.env.NOZELI_TEST_BINARY)?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform='+ (process.env.NOZELI_OZONE||(demo?'x11':'wayland'))],{env:{...env,NOZELI_DEBUG_PORT:String(port)},cwd:app,stdio:['ignore','pipe','pipe']});
 exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 for(const s of [child.stdout,child.stderr])s.on('data',c=>log+=c);
 await until(async()=>fetch('http://127.0.0.1:'+port+'/json/version').then(r=>r.ok).catch(()=>false),'DevTools');
 browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 await shell.waitForFunction(()=>window.__nozeliReady);
}
async function openChat(){
 await shell.waitForFunction(()=>!document.querySelector('#workspace-open-conversation').disabled);
 await shell.click('#workspace-open-conversation');
 chat=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.kind==='conversation').catch(()=>false))return p;},'Frontdesk conversation');
 await chat.waitForFunction(()=>window.__nozeliReady);
 await until(async()=>(await invoke(shell,'managed.status',{projectId})).ready,'native residents');
 await until(async()=>{const s=await state();return s.jobs.some(j=>j.type==='project-initialization'&&['completed','cancelled','failed','interrupted'].includes(j.status))&&!s.busyTargets.length;},'project initialization settled');
}
async function setDraft(text){await chat.$eval('#composer',(n,value)=>{n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));},text);}
async function send(text){
 const before=(await state()).jobs.length;
 await setDraft(text);await chat.waitForFunction(()=>!document.querySelector('#send-message').disabled);await chat.click('#send-message');
 await until(async()=>{const s=await state();const current=s.jobs.slice(before).filter(j=>j.type!=='project-initialization');assert(current.every(j=>j.target==='frontdesk'&&!['failed','unknown','interrupted'].includes(j.status)),JSON.stringify(current.map(j=>({target:j.target,status:j.status,error:j.error}))));return current.some(j=>j.status==='completed')&&!s.busyTargets.length;},text);
}
async function close(){
 await invoke(shell,'session.requestClose').catch(e=>{if(!String(e).includes('Target closed'))throw e;});
 const result=await Promise.race([exited,pause(16000).then(()=>null)]);assert.deepEqual(result,{code:0,signal:null});await browser.disconnect();browser=null;
}
try{
 console.log('MEMORY_EVIDENCE_ROOT='+tmp);
 await launch();
 if((await invoke(shell,'config.status')).choiceRequired)await invoke(shell,'config.initialize',{mode:'independent'});
 await invoke(shell,'settings.providers.save',{operation:'create',provider:'memory-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-only'}});
 await shell.click('#open-settings');await shell.click('[data-settings-section="settings-models"]');
 await shell.waitForSelector('[data-default-role="frontdesk"] option[value="memory-local/scripted"]');
 for(const role of ['frontdesk','orchestrator','worker'])await shell.select('[data-default-role="'+role+'"]','memory-local/scripted');
 await shell.click('[data-role-model-form] button[type="submit"]');
 await shell.waitForFunction(()=>document.querySelector('[data-model-status]').textContent.includes('已保存'));
 await shell.click('#settings-close');await shell.click('#pick-project');
 await shell.waitForFunction(name=>document.querySelector('#project-name').textContent===name,{},projectName);
 await openChat();
 if(slashDemo&&!interactive){
  const checkpoint=provider.requests.length;
  await chat.bringToFront();await chat.focus('#composer');await chat.keyboard.sendCharacter('/skills');
  await chat.waitForSelector('#frontdesk-skill-list button',{visible:true,timeout:5000}).catch(async error=>{throw Error(JSON.stringify(await chat.$eval('#composer',n=>({value:n.value,active:document.activeElement?.id,disabled:n.disabled,readOnly:n.readOnly,selection:n.selectionEnd,picker:n.getAttribute('aria-controls'),visible:!document.getElementById('frontdesk-skill-list')?.hidden,status:document.getElementById('compose-status').textContent}))),{cause:error});});
  assert(await chat.$$eval('#frontdesk-skill-list button',nodes=>nodes.some(n=>n.textContent.includes('分析项目'))&&nodes.every(n=>!n.textContent.includes('history-handoff'))));
  await chat.keyboard.press('Escape');
  assert.equal(provider.requests.length,checkpoint);
  await chat.$eval('#composer',n=>n.select());await chat.keyboard.sendCharacter('/skill:project-analysis');
  await chat.waitForFunction(()=>document.querySelector('#frontdesk-skill-list button code')?.textContent==='/skill:project-analysis'&&!document.querySelector('#frontdesk-skill-list').hidden);
  await chat.keyboard.press('Enter');
  assert.equal(await chat.$eval('#composer',n=>n.value),'/skill:project-analysis ');
  assert.equal(provider.requests.length,checkpoint);
  await send('/skill:project-analysis SLASH-ACTIVATION-CHECK');
  console.log('DEMO_CHECK: project analysis skill delivered');
 }
 const unsent=demo?'请读回我已采纳的离线批注交接。':draft;
 await setDraft(unsent);await pause(500);
 let before=await state();
 const checkpoint=provider.requests.length,skillId='nozeli-context-transfer',role='frontdesk';
 const denied=async(page,op,p,code)=>assert.equal((await page.evaluate((a,b)=>window.nozeli.invoke(a,b),op,p)).error?.code,code);
 await denied(shell,'store.memory.sources',{projectId},'STORE_SKILL_NOT_ENABLED');
 await denied(shell,'store.memory.sources',{projectId:'not-the-active-project'},'PROJECT_SCOPE_DENIED');
 await denied(shell,'store.memory.extra.sources',{projectId},'UNKNOWN_OP');
 for(const role of ['worker','orchestrator','future-role'])await denied(shell,'store.skills.install',{skillId,role},'STORE_ROLE_INCOMPATIBLE');
 await denied(chat,'store.skills.install',{skillId,role},'IPC_DENIED');
 await denied(chat,'managed.frontdesk.memory.sources',{projectId},'IPC_DENIED');
 await chat.click('#chat-more');assert.equal(await chat.$('[data-command="chat-frontdesk-memory"]'),null);
 await chat.keyboard.press('Escape');await shell.bringToFront();
 const action=name=>shell.click(`#local-resource-store button[data-action="${name}"]`);
 const closeStore=()=>action('close-view');
 await shell.setViewport({width:1440,height:900});
 await shell.waitForSelector('#files-divider',{visible:true});
 await shell.click('#workspace-store');await shell.waitForSelector('[data-action="install"]',{visible:true});
 assert(await shell.$$eval('body > .panel-splitter',nodes=>nodes.length>0&&nodes.every(node=>node.getClientRects().length===0)));
 const storeSearch='#local-resource-store input[type=search]';
 const tab=page=>shell.click(`#local-resource-store [data-page="${page}"]`);
 await tab('library');
 assert.match(await shell.$eval('.store-results',node=>node.textContent),/还没有已安装的技能/);
 await tab('discover');
 const section=name=>shell.click(`#local-resource-store [data-category="${name}"]`);
 for(const [key,empty] of [['engine',/暂无可安装的引擎或驱动/],['template',/暂无可安装的角色模板/]]){
  await section(key);
  assert.match(await shell.$eval('.store-results',node=>node.textContent),empty);
  assert.equal(await shell.$('.store-card'),null);
 }
 await tab('create');
 assert.match(await shell.$eval('.store-results',node=>node.textContent),/自开发尚未开放/);
 await tab('discover');await section('skill');
 await shell.type(storeSearch,'no-such-skill');
 assert.match(await shell.$eval('.store-results',node=>node.textContent),/没有匹配的技能/);
 await shell.keyboard.press('Escape');
 assert(await shell.$eval('#local-resource-store',node=>node.hidden));
 assert.equal(await shell.evaluate(()=>document.activeElement.id),'workspace-store');
 await shell.click('#workspace-store');await shell.waitForSelector('[data-action="install"]:enabled',{visible:true});
 assert.equal(await shell.$eval(storeSearch,input=>input.value),'');
 await shell.$eval('#local-resource-store .store-close',node=>node.blur());
 await shell.keyboard.press('Escape');
 assert(await shell.$eval('#local-resource-store',node=>node.hidden));
 await shell.click('#workspace-store');await shell.waitForSelector('[data-action="install"]:enabled',{visible:true});
 await shell.type(storeSearch,'frontdesk');
 assert.equal(await shell.$eval('.store-card h2',node=>node.textContent),'工作状态继承');
 assert.equal(await shell.$eval('.store-card .store-role',node=>node.textContent),'前台');
 assert.deepEqual(await shell.$$eval('.store-card [data-action=install]',nodes=>nodes.map(n=>n.dataset.role)),['frontdesk']);
 if(process.env.NOZELI_MEMORY_SCREENSHOTS)await (await shell.$('#local-resource-store')).screenshot({path:path.join(process.env.NOZELI_MEMORY_SCREENSHOTS,'store.png')});
 await shell.setViewport({width:390,height:720});
 const originalTheme=await shell.evaluate(()=>{const root=document.documentElement;const theme=root.getAttribute('data-theme');root.setAttribute('data-theme','dark');return theme;});
 assert(await shell.evaluate(()=>{
  const view=document.querySelector('.store-view'),card=view.querySelector('.store-card');
  return matchMedia('(max-width:560px)').matches&&view.scrollWidth===view.clientWidth&&getComputedStyle(card.querySelector('.store-skill-controls')).gridColumnStart==='2';
 }));
 if(process.env.NOZELI_MEMORY_SCREENSHOTS)await shell.screenshot({path:path.join(process.env.NOZELI_MEMORY_SCREENSHOTS,'store-narrow-dark.png')});
 await shell.evaluate(theme=>{if(theme===null)document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',theme);},originalTheme);
 await shell.setViewport(null);
 await action('install');await shell.waitForSelector('.store-card .store-meta',{visible:true});
 await shell.waitForFunction(()=>document.querySelector('.store-card .store-meta')?.textContent.includes('已安装'));
 assert.equal(await shell.$('#local-resource-store [data-page="projects"], #local-resource-store [data-action="memory"], #local-resource-store [data-action="settings"]'),null);
 await closeStore();
 await shell.click('#open-settings');await shell.click('[data-settings-section="settings-project-agents"]');
 const storeToggle='#settings-project-agents [data-project-store-skill]';
 const roleSummary=role=>`#settings-project-agents [data-project-role="${role}"] > summary`;
 await shell.waitForSelector(roleSummary('frontdesk'),{visible:true});
 assert.equal(await shell.$eval(storeToggle,node=>node.getClientRects().length),0);
 await shell.focus(roleSummary('frontdesk'));await shell.keyboard.press('Enter');
 await shell.waitForSelector(storeToggle,{visible:true});
 await shell.waitForSelector('#settings-project-agents [data-project-role-save=frontdesk]',{visible:true});
 const progressSkill='#settings-project-agents input[value="nozeli-frontdesk-project-progress"]';
 if(await shell.$eval(progressSkill,input=>input.checked))await shell.click(progressSkill);
 await shell.click(roleSummary('worker'));
 assert(await shell.$eval('#settings-project-agents input[value="nozeli-worker-task-boundary"]',input=>input.getClientRects().length&&input.checked&&input.disabled));
 assert.equal(await shell.$eval(progressSkill,input=>input.getClientRects().length),0);
 await shell.click(roleSummary('frontdesk'));
 assert.equal(await shell.$eval(progressSkill,input=>input.checked),false);
 await shell.click('[data-settings-section="settings-project-reading"]');
 await shell.click('[data-settings-section="settings-project-agents"]');
 await shell.waitForSelector(progressSkill,{visible:true});
 assert.equal(await shell.$eval(progressSkill,input=>input.checked),false);
 await shell.click('#settings-project-agents [data-project-role-save=frontdesk]');
 await shell.waitForFunction(()=>document.querySelector('#settings-project-agents [role=status]').textContent.includes('已保存'));
 assert.equal((await state()).bindings.frontdesk.skills.includes('nozeli-frontdesk-project-progress'),false);
 await shell.click(storeToggle);
 await shell.waitForFunction(selector=>document.querySelector(selector)?.textContent==='恢复',{},storeToggle);
 await denied(shell,'store.memory.sources',{projectId},'STORE_SKILL_NOT_ENABLED');
 await shell.click(storeToggle);
 await shell.waitForFunction(selector=>document.querySelector(selector)?.textContent==='关闭',{},storeToggle);
 assert.equal(await shell.$('[data-project-handoff]'),null);
 await shell.click('#settings-close');
 await chat.bringToFront();await chat.focus('#composer');
 await chat.keyboard.down('Control');await chat.keyboard.press('Home');await chat.keyboard.up('Control');
 await chat.keyboard.sendCharacter('/skill:work-handoff\n');
 await chat.keyboard.down('Control');await chat.keyboard.press('Home');await chat.keyboard.up('Control');
 await chat.$eval('#composer',node=>node.dispatchEvent(new Event('input',{bubbles:true})));
 const handoffEntry='#frontdesk-skill-list button';
 await chat.waitForFunction(selector=>[...document.querySelectorAll(selector)].some(node=>node.textContent.includes('工作状态继承')&&node.getClientRects().length),{},handoffEntry);
 await chat.$$eval(handoffEntry,nodes=>nodes.find(node=>node.textContent.includes('工作状态继承')).click());
 await chat.waitForSelector('#frontdesk-memory-dialog[open]');
 assert.equal(provider.requests.length,checkpoint);
 const picker='#frontdesk-memory-sources',catalog='.frontdesk-memory-catalog';
 await chat.waitForSelector(catalog+' input:enabled',{visible:true});
 assert.equal(await chat.$(catalog+' input:checked'),null);
 assert(await chat.$eval(picker+' button[aria-describedby]',button=>button.disabled));
 if(demo){
  const cards=await chat.$$eval(catalog+' li',rows=>rows.map(row=>row.textContent));
  assert(cards.some(text=>text.includes('CCB · frontdesk · Codex')&&text.includes('下周三先向 10 位试用者')));
  const card=await chat.$$eval(catalog+' li',rows=>{
   const row=rows.find(item=>item.innerText.includes('CCB · frontdesk · Codex'));
   return {text:row.innerText,details:row.querySelector('details').open};
  });
  assert.match(card.text,/最近请求：/);
  assert.doesNotMatch(card.text,/demo-release-decision|\.ccb\/agents/);
  assert.equal(card.details,false);
  assert(cards.some(text=>text.includes('独立会话 · OMP')&&text.includes('不扩大试用范围')));
  if(!interactive){
   const visible=()=>chat.$$eval(catalog+' li:not([hidden])',rows=>rows.map(row=>row.querySelector('details strong').textContent));
   const recent=await visible();
   assert.equal(recent.length,10);
   assert.deepEqual(recent.slice(0,2),demoRows.map(row=>'会话 '+row.id));
   const more=await chat.waitForSelector('#frontdesk-memory-sources button::-p-text(显示更多)',{visible:true});
   await more.click();
   const expanded=await visible();
   assert.equal(expanded.length,20);
   assert.deepEqual(expanded.slice(0,10),recent);
   await chat.type('#frontdesk-memory-source-filter','older-session-18');
   assert.deepEqual(await visible(),['会话 older-session-18']);
   await chat.$eval('#frontdesk-memory-source-filter',input=>{input.value='';input.dispatchEvent(new Event('input'));});
   assert.deepEqual(await visible(),recent);
  }
 }
 assert.equal(await chat.$('#frontdesk-memory-review'),null);
 if(interactive){
  console.log('DEMO_READY：选择会话并提交，在项目任务列表审查 Worker 报告。');await exited;
 }else{
  if(realIds){
   for(const id of realIds){
    const found=await chat.$eval(catalog,(ul,id)=>{const row=[...ul.children].find(li=>li.querySelector('details strong')?.textContent==='会话 '+id);if(row)row.querySelector('input').click();return !!row;},id);
    assert(found,'Expected real catalog session');
   }
  }else await chat.click(catalog+' input:enabled');
  assert.equal(importCalls,0);assert.equal((await state()).jobs.length,before.jobs.length);
  const taskDescription='核对离线批注的未决验证事项。';
  await chat.$eval('#frontdesk-memory-task-description',(input,text)=>{input.value=text;},taskDescription);
  await chat.click(picker+' button[aria-describedby]');
  if(branchDemo){
   const consent=await chat.waitForSelector('#frontdesk-memory-sources label input[type=checkbox]:not(.frontdesk-memory-catalog input)',{visible:true});
   assert.equal((await state()).jobs.length,before.jobs.length);
   assert.equal(await consent.evaluate(input=>input.checked),false);
   await consent.click();
   await chat.click(picker+' button[aria-describedby]');
  }
  const work=await until(async()=>{
   const error=await chat.$eval(picker+' [role="alert"]',n=>n.textContent);assert(!error,error);
   const s=await state(),failed=s.jobs.slice(before.jobs.length).find(job=>['failed','unknown','interrupted'].includes(job.status));assert(!failed,JSON.stringify(failed));
   return s.works.find(w=>w.name==='工作状态继承'&&w.status==='review'&&!s.busyTargets.includes(w.id));
  },'Worker published a report');
  const snapshot=await state(),handoff=snapshot.jobs.find(job=>job.id===work.sourceJob),receipt=snapshot.receipts.findLast(row=>row.workId===work.id&&row.kind==='result');
  assert(work.request.includes(taskDescription));
  if(branchDemo)assert.equal(ranges.find(row=>row.provider==='codex').coverage.limitScope,'preview-excerpts-only');
  if(branchDemo)assert.equal(correctedEvidenceRead,true);
  if(demo)assert.equal(rejectedEarlyReport,true);
  const dispatches=snapshot.jobs.filter(row=>row.context?.restrictedMode==='handoff-dispatch'&&row.routing?.action==='dispatch').length;
  assert.equal(handoff.target,'orchestrator');assert.equal(handoff.routing.workId,work.id);assert.equal(handoff.completion,'host-control');assert.equal(dispatches,1);
  await chat.click(picker+' button[aria-describedby]');
  await chat.waitForFunction(id=>[...document.querySelectorAll('#frontdesk-memory-sources [role="status"]')].some(n=>n.textContent.includes(id)),{},handoff.id);
  assert.equal((await state()).works.length,1);
  await chat.keyboard.press('Escape');
  await chat.waitForFunction(()=>document.activeElement.id==='composer');
  assert.equal(await chat.$eval('#composer',n=>n.value),unsent);
  phase='before-review';await send('Search project result memory for '+reportMarker);
  const todo=snapshot.todos.find(row=>row.objectId===receipt.objectId);assert(todo);
  await shell.bringToFront();
  if(await shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true').catch(()=>false))await shell.click('#toggle-sidebar');
  const pending=`[data-managed-todo="${todo.id}"][data-todo-kind="result"]`;
  await shell.waitForSelector(pending,{visible:true});
  await shell.click(pending);
  const report=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(id=>window.__nozeliReady&&window.__workspaceScope?.kind==='report'&&window.__workspaceScope?.viewState?.report?.todoId===id,todo.id).catch(()=>false))return page;},'native review window');
  await report.waitForSelector('[data-review-action="accept"]',{visible:true});
  await report.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
  const previewKey=await report.$eval('.managed-report-body .isolated-viewport',node=>node.dataset.previewKey);
  const preview=await invoke(report,'isolated-preview.snapshot',{key:previewKey});
  const guest=await until(async()=> (await browser.pages()).find(page=>page.url().startsWith(preview.origin+'/')),'native HTML report guest');
  await guest.waitForFunction(marker=>document.body.innerText.includes(marker),{},reportMarker);
  if(demo){
   assert(await guest.$eval('main',body=>body.innerText.includes('断网恢复验证尚未执行')&&body.innerText.includes('在验证通过前不扩大试用范围')));
   assert.equal(await guest.$eval('main h1',heading=>heading.textContent),'工作状态继承');
  }
  if(process.env.NOZELI_MEMORY_SCREENSHOTS){
   await report.screenshot({path:path.join(process.env.NOZELI_MEMORY_SCREENSHOTS,'review.png')});
   await guest.screenshot({path:path.join(process.env.NOZELI_MEMORY_SCREENSHOTS,'report-body.png')});
  }
  if(process.env.NOZELI_HANDOFF_SHOW_REVIEW){await report.bringToFront();console.log('HANDOFF_REVIEW_VISIBLE');await exited;}
  else{
   await report.click('[data-review-action="accept"]');await report.waitForSelector('[data-confirmation-confirm]',{visible:true});await report.click('[data-confirmation-confirm]');
   await until(async()=>{const settled=(await state()).works.find(row=>row.id===work.id);return settled.outcome==='accept'&&settled.closure?.phase==='complete';},'accepted Work closure');
   await close();phase='recall';
   const {createLayout,reduceLayout}=await import('../src/domain/workspace-layout.mjs');
   const restoredHost=new DesktopHost(profile);
   try{await restoredHost.storage.putLocal(projectId,'workspace:layout',reduceLayout(createLayout(projectId),{type:'open',view:{kind:'conversation',viewState:{draftOnly:true,conversationInput:{projectId,target:'frontdesk'}}}}));}
   finally{await restoredHost.storage.db.close();}
   await launch();
   if(await shell.$eval('#project-name',n=>n.textContent)!==projectName)await shell.click('#pick-project');
   await shell.waitForFunction(name=>document.querySelector('#project-name').textContent===name,{},projectName);
   const restored=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='conversation'&&(window.__workspaceScope.draftOnly||window.__workspaceScope.viewState?.draftOnly)).catch(()=>false))return page;},'restored unconnected conversation');
   const requestsBeforeDiscovery=provider.requests.length;
   await restored.bringToFront();await restored.focus('#composer');await restored.$eval('#composer',node=>node.select());await restored.keyboard.sendCharacter('/');
   await restored.waitForFunction(()=>[...document.querySelectorAll('#frontdesk-skill-list button')].some(node=>node.getClientRects().length&&node.textContent.includes('工作状态继承')));
   assert.equal(provider.requests.length,requestsBeforeDiscovery);
   await restored.$$eval('#frontdesk-skill-list button',nodes=>nodes.find(node=>node.textContent.includes('工作状态继承')).click());
   await restored.waitForSelector(catalog+' input:enabled',{visible:true});
   assert.equal(await restored.$(catalog+' input:checked'),null);
   assert.equal(await restored.$eval('#frontdesk-memory-source-root',node=>node.textContent),`当前项目目录：${await fs.realpath(project)}`);
   assert(await restored.evaluate(()=>window.__workspaceScope.draftOnly||window.__workspaceScope.viewState?.draftOnly));
   // The shell may have connected the project controller independently; the restored conversation must stay draft-only.
   assert.equal(provider.requests.length,requestsBeforeDiscovery);
   if(realIds){
    for(const id of realIds)await restored.$eval(catalog,(list,id)=>[...list.children].find(row=>row.querySelector('details strong')?.textContent==='会话 '+id).querySelector('input').click(),id);
   }else await restored.click(catalog+' input:enabled');
   await restored.$eval('#frontdesk-memory-task-description',(input,text)=>{input.value=text;},taskDescription);
   await restored.click(picker+' button[aria-describedby]');
   if(branchDemo){
    const consent=await restored.waitForSelector('#frontdesk-memory-sources label input[type=checkbox]:not(.frontdesk-memory-catalog input)',{visible:true});
    await consent.click();
    await restored.click(picker+' button[aria-describedby]');
   }
   await restored.waitForFunction(id=>[...document.querySelectorAll('#frontdesk-memory-sources [role="status"]')].some(node=>node.textContent.includes(id)),{},handoff.id);
   assert.equal((await state()).works.length,1);
   await restored.keyboard.press('Escape');
   await openChat();
   await send('Search project result memory for '+reportMarker+' and read the accepted report');
   assert.equal(reportSource?.workId,work.id);assert.equal(reportSource.objectId,receipt.objectId);
   if(!realProject&&!demo){assert.equal(await hash(journal),journalHash);assert.equal(await hash(readme),readmeHash);}
   await close();console.log(JSON.stringify({ok:true,revision,dispatches,importCalls,workId:work.id,reportSource,sources:ranges.map(({agent,provider,recordCount})=>({agent,provider,recordCount})),model:'scripted loopback',binary}));
  }
 }
}catch(error){
 if(sourceDemo)console.error(error);
 throw error;
}finally{
 if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}
 await browser?.disconnect();await provider.close();
 if(realProject||demo)await fs.rm(tmp,{recursive:true,force:true,maxRetries:4,retryDelay:100});
 else await fs.writeFile(path.join(tmp,'electron.log'),log,{mode:0o600});
}
