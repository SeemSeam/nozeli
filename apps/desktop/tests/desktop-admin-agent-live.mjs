// Actual production Electron + native Pi + localhost scripted provider.
// Explicit manual integration gate; no paid provider or personal profile.
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
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';
const require=createRequire(import.meta.url),appRoot=path.resolve(import.meta.dirname,'..');
const installedBinary=process.env.NOZELI_TEST_BINARY?await fs.realpath(process.env.NOZELI_TEST_BINARY):null;
const testedApp=installedBinary?path.resolve(path.dirname(installedBinary),process.platform==='darwin'?'../Resources/app':'resources/app'):appRoot;
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-admin-electron-')),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop');
const secret='DO_NOT_DELIVER_PROJECT_CONTENT_93f824',key='DO_NOT_DELIVER_CREDENTIAL_185a9f';
const host=new DesktopHost(profile),ids=[];
for(const name of ['project-a','project-b']){const root=path.join(out,name);await fs.mkdir(root);await fs.writeFile(path.join(root,'paper.txt'),secret+' '+name);const p=await host.storage.register(root);await host.storage.putLocal(p.id,'managed:draft:frontdesk',secret+' unsent '+name);ids.push(p.id);}
await host.storage.db.close();
let child,browser,shell,exit,log='',phase=0,observer,repairBug,repairSource;
const report={ok:false,out,testedApp,installedBinary,checks:[],errors:[],scope:'Actual Electron/main/UI, private native Pi, localhost scripted replies; isolated config/project data; no paid model comprehension claim'};
const skillRoot=path.join(testedApp,'src/agents/admin/roles/admin/skills');
const provider=await serve(async(request,round)=>{
 assert(!JSON.stringify(request).includes(secret),'project contents or draft must never enter global management model input');
 assert(!JSON.stringify(request).includes(key),'stored credential must never enter model input');
 phase=round;
 if(round===1)return {tool:'read',id:'admin-skill-project',args:{path:path.join(skillRoot,'nozeli-admin-project-management/SKILL.md')}};
 if(round===2)return {tool:'read',id:'admin-skill-config',args:{path:path.join(skillRoot,'nozeli-admin-configuration/SKILL.md')}};
 if(round===3)return {tools:[{tool:'nozeli_admin_registry',id:'registry',args:{}},{tool:'nozeli_admin_configuration',id:'config',args:{}}]};
 if(round===4)return {tool:'nozeli_admin_prepare_defaults',id:'prepare',args:{role:'worker',model:'admin-local/scripted',effort:'low'}};
 if(round===5)return {text:'已准备 Worker 全局默认模型方案；尚未应用，请在管理页面确认。未读取项目内容。'};
 if(round===6)return {tool:'read',id:'admin-skill-maintenance',args:{path:path.join(skillRoot,'nozeli-admin-nozeli-maintenance/SKILL.md')}};
 if(round===7)return {tool:'nozeli_admin_diagnostics',id:'diagnostics',args:{projectId:ids[0],cursor:null,limit:24}};
 if(round===8){const result=JSON.parse(request.messages.findLast(row=>row.role==='tool').content);const row=result.rows?.find(row=>row.id===repairBug);assert(row?.source,'actual fault page must issue opaque repair source');repairSource=row.source;return {tool:'nozeli_admin_prepare_repair',id:'prepare-repair',args:{source:repairSource}};}
 assert.equal(round,9);return {text:'已读取 Nozeli 维修技能并准备技术修复方案；尚未执行，请明确确认。'};
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('app exited '+log);if(provider.errors.length)throw provider.errors[0];const value=await fn();if(value)return value;await pause(80);}throw Error('Timed out '+label+' '+log.slice(-2000));}
async function invoke(op,payload={},page=shell){const r=await page.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
 const env={...process.env};for(const k of Object.keys(env))if(k!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(k)))delete env[k];
 Object.assign(env,{NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_OZONE:process.env.NOZELI_OZONE||'x11'});
 child=spawn(installedBinary||require('electron'),[...(!installedBinary?[path.join(appRoot,'src/main/main.cjs')]:[]),...(process.platform==='linux'?['--ozone-platform='+env.NOZELI_OZONE]:[]),'--inspect=0'],{cwd:out,env,stdio:['ignore','pipe','pipe']});
 exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'ready shell');
 shell.on('pageerror',e=>report.errors.push(e.message));
 if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');
}
async function close(){observer?.close();observer=null;await invoke('session.requestClose');const result=await Promise.race([exit,pause(15000).then(()=>null)]);assert.deepEqual(result,{code:0,signal:null});await browser.disconnect();browser=null;return result;}
try{
 await launch();
 const initial=await invoke('admin.status');assert.equal(initial.busy,false);assert.equal(provider.requests.length,0);assert(!JSON.stringify(initial).includes(secret));
 await invoke('config.initialize',{mode:'independent'});
 await invoke('settings.providers.save',{operation:'create',provider:'admin-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted',reasoning:false}],credential:{action:'replace',value:key}});
 const legacyView=(await invoke('admin.view.read')).state;await invoke('admin.view.write',{expectedRevision:legacyView.revision,next:{...legacyView,placement:{mode:'manual',x:240,y:16},size:{width:560,height:640}},reason:'move'});
 await shell.evaluate(()=>window.dispatchEvent(new Event('nozeli-open-admin')));await until(()=>shell.$('#admin-agent:not([hidden])'),'global assistant');
 assert.equal(await shell.$eval('#admin-agent .admin-title',el=>el.textContent),'nozeli 全局助手');assert.equal(await shell.$('#admin-config'),null);assert.equal(await shell.$('.admin-scope'),null);assert.equal(await shell.$eval('#admin-projects',el=>el.open),false);
 const beforeDrag=await shell.$eval('#admin-agent',el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y};});
 const titleBox=await shell.$eval('#admin-agent [data-local-window-header]',el=>{const r=el.getBoundingClientRect();return {x:r.x+80,y:r.y+14};});
 const nativeBefore=await shell.evaluate(()=>({x:window.screenX,y:window.screenY}));
 assert(await shell.evaluate(p=>Boolean(document.elementFromPoint(p.x,p.y)?.closest('#admin-agent [data-local-window-header]')),titleBox),'assistant drag title must be above the application native title region');
 await shell.mouse.move(titleBox.x,titleBox.y);await shell.mouse.down();await shell.mouse.move(titleBox.x+95,titleBox.y+85,{steps:12});await shell.mouse.up();
 await until(async()=>{const v=(await invoke('admin.view.read')).state;return v.placement.mode==='manual'&&v.placement.x>beforeDrag.x+60&&v.placement.y>beforeDrag.y+60;},'real pointer drag persists position');
 report.checks.push('actual mouse drag hits floating title above app chrome and persists moved geometry');
 const nativeAfter=await shell.evaluate(()=>({x:window.screenX,y:window.screenY}));assert.deepEqual(nativeAfter,nativeBefore,'pointer dragging must move only the local conversation window');
 const resizeBox=await shell.$eval('#admin-agent [data-local-window-resize]',el=>{const r=el.getBoundingClientRect();return {x:r.x+12,y:r.y+12};});await shell.mouse.move(resizeBox.x,resizeBox.y);await shell.mouse.down();await shell.mouse.move(resizeBox.x+35,resizeBox.y+30,{steps:8});await shell.mouse.up();await until(async()=>(await invoke('admin.view.read')).state.size.width>=590,'actual pointer resize persists');
 report.checks.push('actual mouse resize preserves shared floating geometry without moving the application');
 await shell.waitForSelector('#admin-quick-actions');await shell.$eval('#admin-input',el=>{el.value='保留已有草稿';el.dispatchEvent(new Event('input',{bubbles:true}));});await until(async()=>(await invoke('admin.status')).draft==='保留已有草稿','initial quick-action draft');await shell.click('#admin-quick-config');await until(async()=>(await invoke('admin.status')).draft.startsWith('保留已有草稿\n\n请查看当前 Nozeli'),'configuration shortcut appends without overwriting');assert.equal(provider.requests.filter(row=>!row.listing).length,0);report.checks.push('visible configuration shortcut appends to retained draft without inference or configuration mutation');
 await shell.click('#admin-quick-models');await shell.waitForSelector('#settings-dialog[open] [data-admin-default-model]');
 await shell.waitForFunction(()=>[...document.querySelectorAll('[data-admin-default-model] option')].some(o=>o.value==='admin-local/scripted'));
 await shell.select('[data-admin-default-model]','admin-local/scripted');await shell.select('[data-admin-default-effort]','');await shell.click('[data-admin-default-save]');
 await until(async()=>(await invoke('admin.status')).model==='admin-local/scripted','global assistant independent model in defaults page');await shell.click('#settings-close');
 assert.equal(provider.requests.filter(row=>!row.listing).length,0);report.checks.push('reading admin status and saving its independent model do not infer');
 let s;
 s=await invoke('admin.status');await invoke('admin.draft',{text:'管理草稿独立保留',expectedRevision:s.draftRevision});
 for(const id of ids){await shell.click('[data-project-id="'+id+'"]');await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id,{},id);const current=await invoke('admin.status');assert.equal(current.draft,'管理草稿独立保留');assert(!JSON.stringify(current).includes(secret));}
 report.checks.push('switching real projects preserves application draft and does not inject project drafts or content');
 await shell.evaluate(()=>window.dispatchEvent(new Event('nozeli-open-admin')));await until(()=>shell.$('#admin-agent:not([hidden])'),'management project navigation');
 await shell.click('#admin-quick-projects');await shell.waitForSelector('#admin-projects[open]');
 await shell.click('[data-admin-open-project="'+ids[0]+'"]');await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id&&!document.querySelector('[data-project-id][aria-busy="true"]')&&!document.querySelector('#admin-agent:not([hidden])'),{},ids[0]);
 assert.equal((await invoke('admin.status')).draft,'管理草稿独立保留');report.checks.push('management project-open button navigates exact registry ID before any global default enables project inference');
 // UI selector supplied by the production component; no injected mock view.
 await shell.evaluate(()=>window.dispatchEvent(new Event('nozeli-open-admin')));
 await until(()=>shell.$('#admin-agent:not([hidden])'),'management surface');
 await shell.$eval('#admin-projects',el=>{el.open=false;});
 const activeHeader=await shell.$eval('#admin-agent [data-local-window-header]',el=>{const r=el.getBoundingClientRect();return {x:r.x+70,y:r.y+14};});const oldY=(await invoke('admin.view.read')).state.placement.y;await shell.mouse.move(activeHeader.x,activeHeader.y);await shell.mouse.down();await shell.mouse.move(activeHeader.x-40,activeHeader.y+35,{steps:8});await shell.mouse.up();await until(async()=>(await invoke('admin.view.read')).state.placement.y>oldY+20,'mouse drag with actual project open');
 await shell.click('#admin-agent [data-local-window-collapse]');await shell.waitForFunction(()=>document.getElementById('admin-agent').classList.contains('is-collapsed'));await shell.click('#admin-agent [data-local-window-collapse]');await shell.waitForFunction(()=>!document.getElementById('admin-agent').classList.contains('is-collapsed'));report.checks.push('mouse dragging still works with project open; collapse and expand preserve the conversation');
 await shell.screenshot({path:path.join(out,'admin-before.png')});
 await shell.$eval('#admin-input',(el)=>{el.value='请查看已登记项目和配置，并准备将 Worker 全局默认改为 admin-local/scripted low；不要应用。';el.dispatchEvent(new Event('input',{bubbles:true}));});
 await shell.click('#admin-send');
 await until(async()=>{const v=await invoke('admin.status');return !v.busy&&v.pendingChanges?.length?v:null;},'real native skill and config proposal',90000);
 s=await invoke('admin.status');assert.equal(phase,5);assert.equal(s.pendingChanges.length,1);assert(!JSON.stringify(s).includes(key));assert(!JSON.stringify(s).includes(secret));
 report.checks.push('native Pi reads both admin skills and restricted host tools prepare a proposal without applying');
 const proposal=s.pendingChanges[0];await until(()=>shell.$('[data-admin-confirm="'+proposal.id+'"]'),'proposal confirm control');await shell.waitForFunction(()=>document.querySelector('#admin-messages')?.textContent.includes('已准备 Worker 全局默认模型方案'));
 await shell.$eval('[data-admin-proposal="'+proposal.id+'"]',el=>el.scrollIntoView({block:'end'}));await shell.screenshot({path:path.join(out,'admin-proposal.png')});await shell.click('[data-admin-confirm="'+proposal.id+'"]');
 await until(async()=>(await invoke('settings.providers.status')).defaults.worker.model.selector==='admin-local/scripted','confirmed default persistence');
 const settings=await invoke('settings.providers.status');assert.equal(settings.defaults.worker.model.selector,'admin-local/scripted');assert.equal(settings.defaults.worker.thinking.level,'low');
 report.checks.push('trusted confirmation applies exact global Worker default through the production configuration service');
 await shell.waitForFunction(()=>document.querySelector('#admin-proposals')?.textContent.includes('全局配置已保存'));await shell.$eval('#admin-proposals',el=>el.scrollIntoView({block:'end'}));await shell.screenshot({path:path.join(out,'admin-receipt.png')});
 // Test setup only: pause this owned main at the existing admin dispatcher,
 // seed one real host fault/action through the actual Controller, then resume.
 // No production test hook, provider response or model supplies a repair action.
 observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'main Inspector'));
 await observer.rpc('Debugger.enable',{});const mainSource=await fs.readFile(path.join(testedApp,'src/main/main.cjs'),'utf8'),lineNumber=mainSource.split('\n').findIndex(line=>line.includes("if(op.startsWith('admin.'))"));assert(lineNumber>=0);
 let pausedResolve;const paused=new Promise(resolve=>pausedResolve=resolve),listener=event=>{const frame=JSON.parse(String(event.data));if(frame.method==='Debugger.paused')pausedResolve(frame.params);};observer.socket.addEventListener('message',listener);
 const bp=await observer.rpc('Debugger.setBreakpointByUrl',{lineNumber,urlRegex:'[/\\\\]main\\.cjs$'});const pendingStatus=invoke('admin.status');const pauseInfo=await paused;const repairFile=path.join(out,'host-repair-receipt.txt');
 const setup=await observer.rpc('Debugger.evaluateOnCallFrame',{callFrameId:pauseInfo.callFrames[0].callFrameId,expression:`globalThis.__adminRepairSeed=(async()=>{const c=await managedAgents.loadLocal(${JSON.stringify(ids[0])});const bug=await c.maintenance.record({phase:'publication',error:{code:'INTERNAL_ADMIN_FIXTURE'}});c.maintenanceActions.set(bug.id,async()=>{await process.mainModule.require('node:fs/promises').appendFile(${JSON.stringify(repairFile)},'verified\\n');return true;});return bug.id;})();true`,returnByValue:true});assert(!setup.exceptionDetails,JSON.stringify(setup.exceptionDetails));await observer.rpc('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await observer.rpc('Debugger.resume',{});await pendingStatus;repairBug=await observer.evaluate('globalThis.__adminRepairSeed');observer.socket.removeEventListener('message',listener);await observer.rpc('Debugger.disable',{});
 assert.equal(await fs.readFile(repairFile,'utf8').catch(e=>e.code==='ENOENT'?null:Promise.reject(e)),null);
 await shell.click('#admin-quick-diagnostics');await shell.waitForSelector('#admin-projects[open]');await shell.click('[data-admin-diagnose-project="'+ids[0]+'"]');await until(async()=>(await invoke('admin.status')).draft.includes(ids[0]),'explicit diagnostic draft target');assert.equal(phase,5,'diagnostic shortcut must not infer');await shell.click('#admin-send');
 await until(async()=>{const value=await invoke('admin.status');return !value.busy&&value.pendingChanges.some(p=>p.kind==='repair');},'native diagnostic repair proposal',90000);const repair=(await invoke('admin.status')).pendingChanges.find(p=>p.kind==='repair');assert.equal(phase,9);assert.equal(await fs.readFile(repairFile,'utf8').catch(e=>e.code==='ENOENT'?null:Promise.reject(e)),null,'preparation cannot repair');
 await until(()=>shell.$('[data-admin-confirm="'+repair.id+'"]'),'repair confirmation');await shell.$eval('[data-admin-proposal="'+repair.id+'"]',el=>el.scrollIntoView({block:'end'}));await shell.screenshot({path:path.join(out,'admin-repair-proposal.png')});await shell.click('[data-admin-confirm="'+repair.id+'"]');await until(async()=>{const value=await invoke('admin.status');return value.pendingChanges.find(p=>p.id===repair.id)?.receipt?.repaired===true;},'verified real host repair');assert.equal(await fs.readFile(repairFile,'utf8'),'verified\n');await invoke('admin.confirm',{id:repair.id,expectedVersion:repair.expectedVersion});assert.equal(await fs.readFile(repairFile,'utf8'),'verified\n','repeat confirmation cannot replay action');
 await shell.waitForFunction(()=>document.querySelector('#admin-proposals')?.textContent.includes('已修复'));await shell.$eval('[data-admin-proposal="'+repair.id+'"]',el=>el.scrollIntoView({block:'end'}));await shell.screenshot({path:path.join(out,'admin-repair-receipt.png')});report.checks.push('third native maintenance skill and opaque fault sources prepare only; explicit UI confirmation executes the existing verified Controller repair once');
 const roots=await fs.readdir(path.join(profile,'nozeli/storage-v2/instances'));assert.equal(roots.length,2,'no fake admin project registered');
 // A real project document surface cannot access application admin control.
 await shell.click('#admin-agent [data-local-window-hide]');if(await shell.$('[data-start-browse]'))await shell.click('[data-start-browse]');await shell.click('#file-tree [data-path="paper.txt"]');
 const doc=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__workspaceScope?.role==='surface'&&window.__workspaceScope?.kind==='document').catch(()=>false))return page;},'real project document');
 const denied=await doc.evaluate(()=>window.nozeli.invoke('admin.status',{}));assert.equal(denied.ok,false);report.checks.push('real project document surface denied global admin access');
 s=await invoke('admin.status');const historyBefore=s.messages.map(m=>m.text).join('\n');await invoke('admin.draft',{text:'重启后仍属全局的未发送草稿',expectedRevision:s.draftRevision});
 report.firstExit=await close();
 const requestsBefore=provider.requests.length;await launch();const restored=await invoke('admin.status');assert.equal(restored.draft,'重启后仍属全局的未发送草稿');assert.equal(restored.model,'admin-local/scripted');assert.equal(restored.messages.map(m=>m.text).join('\n'),historyBefore);assert.equal(provider.requests.length,requestsBefore);
 report.checks.push('normal cold restart restores global draft, model and native management history without replay');
 await shell.evaluate(()=>window.dispatchEvent(new Event('nozeli-open-admin')));await until(()=>shell.$('#admin-agent:not([hidden])'),'restored floating assistant');await shell.screenshot({path:path.join(out,'admin-restored.png')});
 await shell.waitForFunction(()=>document.querySelector('#admin-messages')?.textContent.includes('已准备 Worker 全局默认模型方案'));assert(await shell.$$eval('#admin-messages .tag-message',nodes=>nodes.every(el=>el.children[1]?.textContent.trim())),'tool-only native entries must not render empty bubbles');
 const header=await shell.$('#admin-agent [data-local-window-header]');await header.focus();await shell.keyboard.press('ArrowRight');await until(async()=>(await invoke('admin.view.read')).state.placement.mode==='manual','shared floating drag keyboard persistence');
 await shell.setViewport({width:390,height:844,deviceScaleFactor:1});await shell.waitForFunction(()=>innerWidth===390);assert(await shell.$eval('#admin-agent',el=>el.scrollWidth<=el.clientWidth+1),'floating assistant must not horizontally overflow');await shell.screenshot({path:path.join(out,'admin-narrow.png')});await shell.$eval('#admin-input',el=>el.focus());await shell.keyboard.press('Escape');await shell.waitForFunction(()=>!document.querySelector('#admin-agent:not([hidden])'));report.checks.push('shared floating movement persists; 390px layout fits and Escape hides without deleting context');
 report.secondExit=await close();assert.deepEqual(provider.errors,[]);assert.deepEqual(report.errors,[]);report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await browser?.disconnect().catch(()=>{});if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exit,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}await provider.close();await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
