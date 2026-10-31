// Real-Electron interaction regression for the settings model menu: with a
// loaded catalog, a refresh must never disable the three native role selects,
// the menus must open from real clicks (:open / AX expanded), models are picked
// with Home/End/Arrow+Enter (never page.select), the save is a real button
// click, and the three role defaults persist across a cold start while staying
// independent per role. An empty catalog must be explicitly not savable.
//
// The same script serves as failing-before on an old package (a pending refresh
// re-disables the loaded selects; the MutationObserver audit records it) and as
// passing-after on the fixed source tree or a new package.
//
// Two launch modes (convention: tests/failed-surface-exit-check.mjs):
//   node tests/model-menu-interaction-check.mjs --app-root <repo>/apps/desktop
//     Spawns the source tree with the dev Electron binary (needs
//     `npm run build:renderer` first).
//   node tests/model-menu-interaction-check.mjs --release <releases>/<timestamp>
//     Spawns <release>/nozeli directly (installed acceptance).
//
// Isolation: sanitized HOME/XDG_*, dedicated NOZELI_CONFIG_ROOT/NOZELI_USER_DATA
// under a throwaway root, NOZELI_TEST_INSTANCE, a dedicated CDP port, and
// Chromium host-resolver rules that black-hole every non-loopback name. The two
// model sources are synthetic: loopback HTTP servers carrying throwaway keys;
// no user profile, no real credentials, no model inference and no paid request
// is possible or claimed — only the local /v1/models listing is ever answered.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const puppeteer=(await import(require.resolve('puppeteer-core'))).default;
const arguments_=process.argv.slice(2);
const option=name=>{const index=arguments_.indexOf(name);return index>=0?arguments_[index+1]:null;};
const appRootOption=option('--app-root'),releaseOption=option('--release');
assert(appRootOption||releaseOption,'pass --app-root <apps/desktop> or --release <release-dir>');
assert(!(appRootOption&&releaseOption),'pass exactly one of --app-root / --release');
const mode=appRootOption?'source':'installed';
const appRoot=appRootOption?path.resolve(appRootOption):null;
const release=releaseOption?path.resolve(releaseOption):null;
const binary=appRoot?createRequire(path.join(appRoot,'package.json'))('electron'):path.join(release,'nozeli');
const appArguments=appRoot?[path.join(appRoot,'src/main/main.cjs')]:[];

const root=await fs.mkdtemp(path.join(os.tmpdir(),`nozeli-model-menu-${mode}-`));
const report={ok:false,kind:'model-menu-interaction-check',mode,root,binary,appRoot,release,
  coverage:'Synthetic loopback-only model sources with throwaway keys; sanitized HOME/XDG_* and NOZELI_CONFIG_ROOT/NOZELI_USER_DATA under a throwaway root; NOZELI_TEST_INSTANCE plus a dedicated CDP port; Chromium host-resolver rules black-hole non-loopback names; no user profile is read and no model inference or paid request happens. Not full syscall isolation and not claimed as such.',
  checks:[],scenes:[],normalExits:[],errors:[],serverHits:[],observerAudit:[],defaultsTimeline:[]};
console.log('EVIDENCE_ROOT='+root);
let child,exited,browser,log='',shell;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=60_000){
  const deadline=Date.now()+timeout;
  do{
    if(child&&(child.exitCode!==null||child.signalCode))throw Error('Electron exited while waiting for '+label+'\n'+log.slice(-4000));
    const value=await fn();
    if(value)return value;
    await sleep(80);
  }while(Date.now()<deadline);
  throw Error('Timed out: '+label);
}
async function invoke(page,operation,payload={}){
  const result=await page.evaluate(({operation,payload})=>window.nozeli.invoke(operation,payload),{operation,payload});
  assert(result.ok,`${operation}: ${JSON.stringify(result.error)}`);
  return result.value;
}
async function scope(predicate,label){
  return until(async()=>{
    for(const page of await browser.pages()){
      const identity=await page.evaluate(async()=>{
        if(!window.nozeli)return null;
        const result=await window.nozeli.invoke('workspace.bootstrap',{});
        return result.ok?result.value:null;
      }).catch(()=>null);
      if(identity&&predicate(identity)&&await page.evaluate(()=>window.__nozeliReady===true).catch(()=>false))return {page,scope:identity};
    }
    return null;
  },label);
}
function isolatedEnvironment(port){
  const env={...process.env};
  for(const key of Object.keys(env)){
    if(/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)||/^(?:CCB_|CODEX_|OMP_|PI_|ANTHROPIC_|OPENAI_|NOZELI_)/.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
  }
  return Object.assign(env,{
    HOME:path.join(root,'home'),
    XDG_CONFIG_HOME:path.join(root,'home','.config'),
    XDG_DATA_HOME:path.join(root,'home','.local','share'),
    XDG_CACHE_HOME:path.join(root,'home','.cache'),
    NOZELI_TEST_INSTANCE:'1',
    NOZELI_CONFIG_ROOT:path.join(root,'config'),
    NOZELI_USER_DATA:path.join(root,'config','desktop'),
    NOZELI_DEBUG_PORT:String(port),
    NOZELI_HIDDEN:'0',
  });
}
async function freePort(){
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
let sessionCount=0;
async function launch(){
  const port=await freePort();
  const env=isolatedEnvironment(port);
  await fs.mkdir(env.HOME,{recursive:true,mode:0o700});
  sessionCount++;
  log+=`\n=== session ${sessionCount} on CDP ${port} ===\n`;
  child=spawn(binary,[...appArguments,`--ozone-platform=${process.env.NOZELI_OZONE||'wayland'}`,'--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'],{cwd:'/tmp',env,stdio:['ignore','pipe','pipe']});
  exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;});
  browser=await until(()=>puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null}).catch(()=>null),'CDP endpoint');
  const observe=page=>page.on('pageerror',error=>report.errors.push(String(error.stack||error)));
  for(const page of await browser.pages())observe(page);
  browser.on('targetcreated',async target=>{const page=await target.page().catch(()=>null);if(page)observe(page);});
  ({page:shell}=(await scope(scopeValue=>scopeValue.role==='shell','shell window')));
}
async function requestCloseExpectZero(scene){
  const response=await shell.evaluate(()=>window.nozeli.invoke('session.requestClose',{}));
  assert(response.ok,`${scene}: session.requestClose: ${JSON.stringify(response.error)}`);
  const result=await Promise.race([exited,sleep(25_000).then(()=>null)]);
  assert.deepEqual(result,{code:0,signal:null},scene+': normal close must exit 0');
  report.normalExits.push({scene,...result});
  await browser?.disconnect();
  browser=null;
}
// Two synthetic API model sources. Each answers only its own /v1/models listing
// on loopback; any other traffic is recorded and refused. The throwaway key
// never leaves this process's config and is not a credential of any real host.
const sources=[];
for(const [provider,model] of [['menu-a','menu-a-model'],['menu-b','menu-b-model']]){
  const hits=[];
  const server=http.createServer((request,response)=>{
    hits.push({method:request.method,url:request.url});
    if(request.method==='GET'&&request.url==='/v1/models'){
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({object:'list',data:[{id:model,object:'model',created:0,owned_by:provider}]}));
      return;
    }
    response.writeHead(404);response.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  sources.push({provider,model,hits,server,baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',key:'synthetic-local-only-not-a-secret'});
}
const ROLES=['frontdesk','orchestrator','worker'];
const menuState=()=>shell.evaluate(()=>{
  const pick=role=>document.querySelector(`[data-default-role="${role}"]`);
  const openState=select=>{try{return select.matches(':open');}catch{return null;}};
  return {
    selects:Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>{const select=pick(role);return [role,{disabled:select.disabled,value:select.value,options:[...select.options].map(option=>option.value),open:openState(select)}];})),
    saveDisabled:document.querySelector('[data-role-model-form] button[type="submit"]').disabled,
    refreshDisabled:document.querySelector('[data-model-refresh]').disabled,
    catalog:document.querySelector('[data-model-catalog-status]').textContent,
  };
});
const catalogBaseline=()=>shell.evaluate(()=>document.querySelector('[data-model-catalog-status]')?.textContent??'');
// Public disabled-state observer: records every disabled transition of the
// three role selects, the save button and the refresh button, plus named
// timeline marks, so no sub-perceptual re-disable can escape the audit.
async function installObserver(){
  await shell.evaluate(()=>{
    if(window.__menuProbe)return;
    window.__menuProbe={records:[]};
    window.__menuProbe.mark=label=>window.__menuProbe.records.push({mark:label});
    for(const [name,selector] of [['frontdesk','[data-default-role="frontdesk"]'],['orchestrator','[data-default-role="orchestrator"]'],['worker','[data-default-role="worker"]'],['save','[data-role-model-form] button[type="submit"]'],['modelRefresh','[data-model-refresh]']]){
      const element=document.querySelector(selector);
      if(!element)continue;
      new MutationObserver(()=>window.__menuProbe.records.push({target:name,disabled:element.disabled})).observe(element,{attributes:true,attributeFilter:['disabled']});
    }
  });
}
const mark=label=>shell.evaluate(label=>window.__menuProbe.mark(label),label);
const probeRecords=()=>shell.evaluate(()=>structuredClone(window.__menuProbe?.records??[]));
const defaults=async()=>(await invoke(shell,'settings.providers.status')).defaults;
const openSettings=async()=>{
  await shell.bringToFront();
  await shell.click('#open-settings');
  await shell.waitForSelector('#settings-dialog[open]',{timeout:30_000});
  if(await shell.$('#configuration-setup[open]')){await shell.click('#configuration-independent');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open,{timeout:30_000});}
};
const openModelsSection=async()=>{await shell.click('[data-settings-section="settings-models"]');await shell.waitForFunction(()=>document.querySelector('#settings-dialog').open&&!document.querySelector('#settings-models').hidden&&document.querySelector('[data-settings-section="settings-models"]').getAttribute('aria-current')==='page');};
async function settleModels({values=null,options=3,enabled=true,label}){
  return until(async()=>{
    const state=await menuState();
    const shapeOk=ROLES.every(role=>state.selects[role].options.length===options&&(values?state.selects[role].value===values[role]:true)&&state.selects[role].disabled===!enabled);
    if(!shapeOk)return null;
    await sleep(400);
    const again=await menuState();
    return ROLES.every(role=>again.selects[role].options.length===options&&JSON.stringify(again.selects[role])===JSON.stringify(state.selects[role]))?state:null;
  },label,60_000);
}
async function menuOpenState(role){
  const pseudo=await shell.evaluate(role=>{const select=document.querySelector(`[data-default-role="${role}"]`);try{return select.matches(':open');}catch{return null;}},role);
  if(pseudo!==null)return {open:pseudo,via:':open'};
  const cdp=await shell.createCDPSession();await cdp.send('Accessibility.enable');const tree=await cdp.send('Accessibility.getFullAXTree');await cdp.detach();
  const labels={frontdesk:'前台',orchestrator:'编排',worker:'Worker'};
  const node=tree.nodes.find(candidate=>candidate.role?.value==='combobox'&&String(candidate.name?.value??'').includes(labels[role]));
  return {open:node?node.properties?.find(property=>property.name==='expanded')?.value?.value===true:null,via:'ax-expanded'};
}
async function axMenuEvidence(label){
  const cdp=await shell.createCDPSession();await cdp.send('Accessibility.enable');
  const tree=await cdp.send('Accessibility.getFullAXTree');await cdp.detach();
  report.scenes.push({name:'ax-'+label,comboboxes:tree.nodes.filter(node=>node.role?.value==='combobox').map(node=>({name:node.name?.value,expanded:node.properties?.find(property=>property.name==='expanded')?.value?.value??null,focused:node.properties?.find(property=>property.name==='focused')?.value?.value??null}))});
}
// Real user pick: real click opens the native menu (verified open), keyboard
// Home/End/Arrow navigation, Enter commits. page.select is never used.
async function pickModel(role,keyList,expected,label,axLabel){
  await mark(`pick:${role}:${label}:start`);
  await shell.click(`[data-default-role="${role}"]`);
  await until(async()=>(await menuOpenState(role)).open===true,label+`: native menu opens for ${role}`);
  if(axLabel)await axMenuEvidence(axLabel);
  for(const key of keyList){await shell.keyboard.press(key);await sleep(60);}
  await until(async()=>{const state=await menuState();return state.selects[role].value===expected&&state.selects[role].open!==true;},label+`: ${role} commits ${expected}`);
  await mark(`pick:${role}:${label}:settled`);
  const state=await menuState();
  assert.equal(state.selects[role].value,expected,label+': '+role+' holds the picked model');
  return state;
}
async function realSave(expected,label){
  await mark(`save:${label}:start`);
  await shell.click('[data-role-model-form] button[type="submit"]');
  await until(async()=>JSON.stringify(await defaults())===JSON.stringify(expected),label+': defaults persisted');
  await until(async()=>{const state=await menuState();return ROLES.every(role=>!state.selects[role].disabled)&&!state.saveDisabled;},label+': surface restored after save');
  await mark(`save:${label}:settled`);
  report.defaultsTimeline.push({label,defaults:await defaults()});
}
// Audit: after a session's catalog is loaded, and inside every observed refresh
// window, no role select and no save button may be disabled (a save window is
// the only legitimate freeze).
function auditRecords(records,session){
  const windows=[];let openWindow=null;
  records.forEach((record,index)=>{
    if(typeof record.mark!=='string')return;
    if(record.mark.endsWith(':start'))openWindow={name:record.mark.slice(0,-':start'.length),start:index};
    else if(record.mark.endsWith(':settled')&&openWindow&&record.mark.slice(0,-':settled'.length)===openWindow.name){windows.push({...openWindow,end:index});openWindow=null;}
  });
  const loaded=records.findIndex(record=>record.mark==='loaded');
  const inWindow=(index,prefix)=>windows.some(window=>window.name.startsWith(prefix)&&index>=window.start&&index<=window.end);
  const violations=[];
  records.forEach((record,index)=>{
    if(typeof record.mark==='string')return;
    if(!['frontdesk','orchestrator','worker','save'].includes(record.target)||record.disabled!==true)return;
    if(inWindow(index,'save'))return;
    if(inWindow(index,'refresh')){violations.push({...record,session,window:'refresh'});return;}
    if(loaded>=0&&index>loaded)violations.push({...record,session,window:'after-loaded'});
  });
  report.observerAudit.push({session,loaded,refreshWindows:windows.filter(window=>window.name.startsWith('refresh')).length,saveWindows:windows.filter(window=>window.name.startsWith('save')).length,disabledRecords:records.filter(record=>record.disabled!==undefined).length,violations});
  return violations;
}
const shot=async name=>{await shell.screenshot({path:path.join(root,name+'.png')});report.scenes.push({name:'screenshot',file:name+'.png'});};
try{
  // ===== session one: empty catalog, real menus, real save, independence =====
  await launch();
  await invoke(shell,'config.initialize',{mode:'independent'});
  await openSettings();
  await installObserver();
  const loadingText=await catalogBaseline();
  await openModelsSection();
  // 1. fresh config has an empty catalog: explicitly not savable, selects not operable.
  await until(async()=>{const state=await menuState();return state.catalog!==loadingText&&ROLES.every(role=>state.selects[role].disabled)&&state.saveDisabled;},'empty catalog settles');
  const emptyStatus=await invoke(shell,'settings.providers.status');
  assert.equal(emptyStatus.models.length,0,'isolated config starts with no models');
  assert.equal(emptyStatus.sources.length,0,'isolated config starts with no sources');
  const emptyState=await menuState();
  for(const role of ROLES){assert.equal(emptyState.selects[role].disabled,true,role+' disabled with an empty catalog');assert.equal(emptyState.selects[role].options.length,1,role+' shows only the placeholder');}
  assert.equal(emptyState.saveDisabled,true,'save explicitly unavailable with an empty catalog');
  assert.deepEqual(await defaults(),{},'an empty catalog must leave defaults unchanged');
  await shot('empty-catalog-not-savable');
  report.checks.push('empty catalog: selects and save disabled, defaults remain unchanged');
  // 2. add the two synthetic sources and refresh through the real button.
  for(const source of sources)await invoke(shell,'settings.providers.save',{operation:'create',provider:source.provider,baseUrl:source.baseUrl,api:'openai-completions',models:[{id:source.model}],credential:{action:'replace',value:source.key}});
  await openModelsSection();
  await mark('refresh:first-loaded:start');
  await shell.click('[data-model-refresh]');
  const loadedState=await settleModels({options:3,enabled:true,label:'catalog with two synthetic models'});
  const firstModel=loadedState.selects.frontdesk.options[1],secondModel=loadedState.selects.frontdesk.options[2];
  assert.notEqual(firstModel,secondModel,'the two synthetic sources contribute distinct models');
  await mark('loaded');
  await mark('refresh:first-loaded:settled');
  await shot('loaded-catalog');
  report.checks.push('loaded catalog: '+firstModel+' / '+secondModel);
  // 3. real menu interaction on all three roles with distinct picks.
  await pickModel('frontdesk',['Home','ArrowDown','Enter'],firstModel,'first pick');
  await pickModel('orchestrator',['Home','End','Enter'],secondModel,'first pick','orchestrator menu open');
  await pickModel('worker',['Home','ArrowDown','Enter'],firstModel,'first pick');
  const trioA={frontdesk:firstModel,orchestrator:secondModel,worker:firstModel};
  await realSave(trioA,'initial trio');
  await shot('saved-initial-trio');
  assert.deepEqual(await defaults(),trioA,'backend defaults carry the three picked models');
  report.checks.push('real click + keyboard picks saved: '+JSON.stringify(trioA));
  // 4. reopen the settings surface: the section click refreshes again; values stay.
  await shell.click('#settings-close');
  await openSettings();
  await mark('refresh:reopen:start');
  await openModelsSection();
  await settleModels({values:trioA,options:3,enabled:true,label:'reopen keeps the saved trio across a refresh'});
  await mark('refresh:reopen:settled');
  // 5. independence: change only the worker role.
  await pickModel('worker',['Home','End','Enter'],secondModel,'worker switch');
  await realSave({frontdesk:firstModel,orchestrator:secondModel,worker:secondModel},'worker only');
  const afterSwitch=await menuState();
  assert.equal(afterSwitch.selects.frontdesk.value,firstModel,'frontdesk untouched by the worker save');
  assert.equal(afterSwitch.selects.orchestrator.value,secondModel,'orchestrator untouched by the worker save');
  assert.equal(afterSwitch.selects.worker.value,secondModel,'worker holds its new model');
  await shot('independent-roles');
  report.checks.push('role independence: worker-only save left frontdesk/orchestrator untouched');
  await shell.click('#settings-close');
  const sessionOneRecords=await probeRecords();
  await requestCloseExpectZero('session one');
  // ===== session two: cold start persistence and refresh stability =====
  await launch();
  await openSettings();
  await installObserver();
  const coldLoadingText=await catalogBaseline();
  await openModelsSection();
  const coldState=await until(async()=>{
    const state=await menuState();
    if(state.catalog===coldLoadingText)return null;
    return ROLES.every(role=>state.selects[role].options.length===3&&!state.selects[role].disabled&&state.selects[role].value)?state:null;
  },'cold start restores the persisted trio',60_000);
  await settleModels({values:{frontdesk:firstModel,orchestrator:secondModel,worker:secondModel},options:3,enabled:true,label:'cold start settles on persisted defaults'});
  await mark('loaded');
  assert.equal(coldState.selects.frontdesk.value,firstModel,'cold start restores frontdesk default');
  assert.equal(coldState.selects.orchestrator.value,secondModel,'cold start restores orchestrator default');
  assert.equal(coldState.selects.worker.value,secondModel,'cold start restores worker default');
  assert.deepEqual(await defaults(),{frontdesk:firstModel,orchestrator:secondModel,worker:secondModel},'cold-start backend defaults match the UI');
  await shot('cold-start-persisted-trio');
  report.checks.push('cold start persisted the distinct trio through the UI');
  // 6. refresh stability: the loaded catalog must never be re-disabled.
  await mark('refresh:cold:start');
  await shell.click('[data-model-refresh]');
  await settleModels({values:{frontdesk:firstModel,orchestrator:secondModel,worker:secondModel},options:3,enabled:true,label:'refresh keeps the loaded catalog operable'});
  await mark('refresh:cold:settled');
  await shot('refresh-stability');
  await shell.click('#settings-close');
  const sessionTwoRecords=await probeRecords();
  await requestCloseExpectZero('session two');
  // ===== audits =====
  const violations=[...auditRecords(sessionOneRecords,'one'),...auditRecords(sessionTwoRecords,'two')];
  report.ok=violations.length===0&&report.errors.length===0;
  assert.deepEqual(violations,[],'no role select or save button may be disabled during refresh or after load (observer audit)');
  for(const source of sources)assert.ok(source.hits.every(hit=>hit.method==='GET'&&hit.url==='/v1/models'),'synthetic source '+source.provider+' must never receive inference traffic');
}catch(error){
  report.ok=false;report.failure=String(error.stack||error);console.log(report.failure);
}finally{
  report.serverHits=sources.map(source=>({provider:source.provider,hits:source.hits}));
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(root,'main.log'),log);
  console.log(JSON.stringify(report,null,2));
  if(child&&child.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([exited,sleep(4000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exited;}}
  await browser?.disconnect().catch(()=>{});
  for(const source of sources){source.server.closeAllConnections?.();await new Promise(resolve=>source.server.close(resolve));}

  if(report.ok!==true)process.exitCode=1;
}
