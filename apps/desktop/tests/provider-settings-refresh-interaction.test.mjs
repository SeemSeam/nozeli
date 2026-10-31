// Component-only browser regression (convention: tests/attention-notifications.test.mjs).
// A real Electron window runs the production renderer module
// src/renderer/provider-settings.mjs unchanged, against a scripted invoke double
// whose settings.providers.status replies are caller-controlled promises and
// values. Scope: UI interaction units only — slow refresh and refresh failure
// are simulated at the declared IPC status boundary, so this file explicitly
// does NOT exercise the private OMP CLI, host persistence, or any model request
// and claims no CLI/backend evidence (tests/model-menu-interaction-check.mjs is
// the real-app script, and backend save validation stays in
// tests/provider-settings.test.mjs).
// User-visible regressions covered:
//  1. first load stays loading: native selects cannot be opened, save unavailable;
//  2. first-load failure keeps the surface explicit (status text changes) and
//     retryable, then a good catalog recovers it;
//  3. success with an empty catalog keeps selects and save disabled and a real
//     save click persists nothing;
//  4. pending refresh over an already-loaded catalog keeps the native selects
//     clickable and keyboard-editable (the reported settings regression);
//  5. releasing the SAME catalog while a native menu is open keeps that menu
//     open until the user presses Enter/Escape;
//  6. a failed refresh preserves the loaded catalog, every dirty selection and
//     an operable save;
//  7. a later successful refresh with a different catalog never clobbers dirty
//     input (kept via an in-list fallback option) and rebuilds a focused select
//     only after it loses focus;
//  8. save captures the full three-role payload before freezing the selects,
//     blocks duplicate submits and external refresh while busy, and restores;
//  9. save started while a refresh is pending still submits exactly the frozen
//     snapshot, after that refresh settles, exactly once.
// Run: node --test tests/provider-settings-refresh-interaction.test.mjs
// (needs a display; NOZELI_TEST_OZONE overrides the wayland default,
//  NOZELI_TEST_VISIBLE=0 hides the window but native menu scenes need it shown).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';

const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-provider-refresh-'));
const report={out,kind:'provider-settings-refresh-interaction',scope:'renderer-component-only: real Electron window, production provider-settings module, scripted invoke double; not CLI/host/model evidence',scenes:[],screenshots:[],errors:[]};
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const moduleUrl=pathToFileURL(path.join(root,'src','renderer','provider-settings.mjs')).href;

// The page below owns the scripted invoke double. statusState is the current
// truthful reply; holdStatus() defers the next status reply until the Node side
// resolves or rejects it, which is how slow/failed refreshes are made
// deterministic. armSave() holds settings.models.save in flight the same way.
const pageScript=`
import {mountProviderSettings} from ${JSON.stringify(moduleUrl)};
const state={catalog:[],defaults:{},sources:[]};
const log=[];
window.__ps={calls:log,mounts:[],armed:null,saveHold:null,
  setState(value){Object.assign(state,value);},
  holdStatus(){window.__ps.armed=new Promise((resolve,reject)=>{window.__ps.resolveStatus=value=>{window.__ps.armed=null;resolve(value);};window.__ps.rejectStatus=message=>{window.__ps.armed=null;reject(new Error(message));};});},
  armSave(){window.__ps.saveHold=new Promise(resolve=>{window.__ps.releaseSave=()=>resolve();});}};
const invoke=async(op,p={})=>{
  log.push({op,args:structuredClone(p),seq:log.length});
  if(op==='settings.providers.status'){
    if(window.__ps.armed)await window.__ps.armed;
    return {ok:true,value:{sources:structuredClone(state.sources),models:structuredClone(state.catalog),defaults:structuredClone(state.defaults),modelSync:{applied:0,pending:0,failed:[]},login:null}};
  }
  if(op==='settings.models.save'){
    state.defaults=structuredClone(p);
    if(window.__ps.saveHold)await window.__ps.saveHold;
    return {ok:true,value:{saved:true,modelSync:{applied:0,pending:0,failed:[],sessions:[]}}};
  }
  return {ok:false,error:{message:'unexpected operation '+op}};
};
window.__ps.mount=()=>{
  for(const mounted of window.__ps.mounts){mounted.providers.remove();mounted.models.remove();}
  const providers=document.createElement('section'),models=document.createElement('section');
  document.body.append(providers,models);
  const api=mountProviderSettings({invoke,providers,models});
  window.__ps.mounts.push({providers,models,api});
};
window.__psReady=true;`;
await fs.writeFile(path.join(out,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>provider-settings 组件交互回归</title><script>window.__earlyErrors=[];window.addEventListener("error",e=>window.__earlyErrors.push(String(e.error&&e.error.stack||e.message)));window.addEventListener("unhandledrejection",e=>window.__earlyErrors.push(String(e.reason&&e.reason.stack||e.reason)));</script><style>body{font:14px/1.6 system-ui;margin:12px}section{border:1px solid #999;padding:10px;margin:8px 0}label{display:block;margin:6px 0}select,button{font:inherit;padding:4px 10px;min-width:220px}button{min-width:120px}</style><button id="focus-sink" type="button">focus sink</button><script type="module">'+pageScript+'</script></body></html>','utf8');
await fs.writeFile(path.join(out,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:${process.env.NOZELI_TEST_VISIBLE!=='0'},width:980,height:780,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.join(out,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
// Wayland + this Electron's Vulkan backend crashes the GPU process before any
// module evaluates (the product app composites in software for the same
// reason); the window stays shown by default because the native select menu
// scenes need a realized window.
const logFile=createWriteStream(path.join(out,'main.log'));
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(out,'main.cjs'),'--remote-debugging-port='+port,'--ozone-platform='+(process.env.NOZELI_TEST_OZONE||'wayland'),'--user-data-dir='+path.join(out,'profile'),'--disable-gpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'],{cwd:root,stdio:['ignore','pipe','pipe']});
let mainLog='',browser,page;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{mainLog+=chunk;logFile.write(chunk);});
const exited=new Promise(resolve=>child.once('exit',resolve));
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=8000){const end=Date.now()+timeout;do{if(child.exitCode!==null||child.signalCode)throw Error('Electron exited during '+label+'\n'+mainLog);const value=await fn();if(value)return value;await tick(60);}while(Date.now()<end);throw Error('timeout: '+label);}
const quiet=async(ms=160)=>{await tick(ms);};
const ROLES=['frontdesk','orchestrator','worker'];
const dom=()=>page.evaluate(()=>{
  const pick=role=>document.querySelector('[data-default-role="'+role+'"]');
  const openState=select=>{try{return select.matches(':open');}catch{return null;}};
  return {calls:window.__ps.calls.map(call=>({op:call.op,seq:call.seq,args:call.args})),
    selects:Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>{const select=pick(role);return [role,{disabled:select.disabled,value:select.value,labels:[...select.options].map(option=>option.textContent),options:[...select.options].map(option=>option.value),open:openState(select),focused:document.activeElement===select}];})),
    saveDisabled:document.querySelector('[data-role-model-form] button[type="submit"]').disabled,
    refreshDisabled:document.querySelector('[data-model-refresh]').disabled,
    catalog:document.querySelector('[data-model-catalog-status]').textContent};
});
const counts=state=>({status:state.calls.filter(call=>call.op==='settings.providers.status').length,save:state.calls.filter(call=>call.op==='settings.models.save').length});
const setState=value=>page.evaluate(value=>window.__ps.setState(value),{...value,...(value.defaults?{defaults:Object.fromEntries(Object.entries(value.defaults).map(([role,entry])=>[role,typeof entry==='string'?{model:entry?{mode:'explicit',selector:entry}:{mode:'native-default'},thinking:{mode:'native-default'}}:entry]))}:{})});
const holdStatus=()=>page.evaluate(()=>window.__ps.holdStatus());
const resolveStatus=payload=>page.evaluate(payload=>window.__ps.resolveStatus(payload),payload);
const rejectStatus=message=>page.evaluate(message=>window.__ps.rejectStatus(message),message);
const armSave=()=>page.evaluate(()=>window.__ps.armSave());
const releaseSave=()=>page.evaluate(()=>window.__ps.releaseSave());
const freshMount=async state=>{await setState(state);await page.evaluate(()=>window.__ps.mount());await quiet(60);return dom();};
const menuOpenState=async role=>{
  const pseudo=await page.evaluate(role=>{const select=document.querySelector('[data-default-role="'+role+'"]');try{return select.matches(':open');}catch{return null;}},role);
  if(pseudo!==null)return {open:pseudo,via:':open'};
  const cdp=await page.createCDPSession();await cdp.send('Accessibility.enable');const tree=await cdp.send('Accessibility.getFullAXTree');await cdp.detach();
  const labels={frontdesk:'前台',orchestrator:'编排',worker:'Worker'};
  const node=tree.nodes.find(candidate=>candidate.role?.value==='combobox'&&String(candidate.name?.value??'').includes(labels[role]));
  return {open:node?node.properties?.find(property=>property.name==='expanded')?.value?.value===true:null,via:'ax-expanded'};
};
const clickSelect=async role=>{await page.click('[data-default-role="'+role+'"]');};
const keys=async list=>{for(const key of list){await page.keyboard.press(key);await tick(50);}};
// Real user pick: click the native select, confirm the popup is actually open,
// navigate with the keyboard, commit with Enter, then confirm the committed value.
const pick=async(role,list,expected,label)=>{
  await clickSelect(role);
  await until(async()=>(await menuOpenState(role)).open===true,label+': menu opens for '+role);
  await keys(list);
  await until(async()=>{const state=await dom();return state.selects[role].value===expected&&state.selects[role].open!==true;},label+': committed '+role+'='+expected);
  const state=await dom();assert.equal(state.selects[role].value,expected,label+': '+role+' value');return state;
};
const clickSave=()=>page.click('[data-role-model-form] button[type="submit"]');
const clickRefresh=()=>page.click('[data-model-refresh]');
const blurFocus=()=>page.click('#focus-sink');
const shot=async name=>{await page.screenshot({path:path.join(out,name+'.png')});report.screenshots.push(name+'.png');};

const entry=(selector,provider,id)=>({selector,provider,id,name:id,credentialConfigured:true,catalogSource:'native',entitlement:'unknown',thinking:{supported:false,levels:null,source:'native-model-definition'}});
const ALPHA=['alpha/m-one','alpha/m-two','alpha/m-three'].map(id=>entry(id,'alpha',id.slice(6)));
const BETA=['beta/b-one','beta/b-two'].map(id=>entry(id,'beta',id.slice(5)));
const SOURCES_ALPHA=[{provider:'alpha',revision:1,type:'api',credential:{configured:true,kind:'api-key'},baseUrl:'https://alpha.invalid/v1',models:[],discovery:{status:'none'}}];
const SOURCES_BETA=[{provider:'beta',revision:1,type:'api',credential:{configured:true,kind:'api-key'},baseUrl:'https://beta.invalid/v1',models:[],discovery:{status:'none'}}];
const payload=(catalog,defaults,sources)=>({sources,models:catalog,defaults:Object.fromEntries(Object.entries(defaults).map(([role,selector])=>[role,{model:selector?{mode:'explicit',selector}:{mode:'native-default'},thinking:{mode:'native-default'}}])),modelSync:{applied:0,pending:0,failed:[],sessions:[]},login:null});
try{
  const nestedDefaults=flat=>Object.fromEntries(Object.entries(flat).map(([role,selector])=>[role,{model:selector?{mode:'explicit',selector}:{mode:'native-default'},thinking:{mode:'native-default'}}]));  for(let attempt=0;attempt<150&&!browser;attempt++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null,protocolTimeout:15000});}catch{if(child.exitCode!==null)throw Error(mainLog);await tick(100);}}
  assert(browser,'debug connection');
  page=await until(async()=>{for(const candidate of await browser.pages()){if(await candidate.evaluate(()=>document.readyState==='complete').catch(()=>false))return candidate;}return null;},'fixture page loaded');
  page.on('pageerror',error=>report.errors.push(String(error.stack||error)));
  await until(async()=>await page.evaluate(()=>window.__psReady===true&&!window.__earlyErrors.length).catch(()=>false),'production module mounted');
  // 1. first load: loading placeholders, nothing openable, save unavailable.
  let state=await freshMount({catalog:ALPHA,defaults:{frontdesk:'alpha/m-one',orchestrator:'',worker:'alpha/m-two'},sources:SOURCES_ALPHA});
  for(const role of ROLES){assert.equal(state.selects[role].disabled,true,role+' disabled while first load pending');assert.deepEqual(state.selects[role].options,[''],role+' has only the loading option');}
  assert.equal(state.saveDisabled,true,'save unavailable before the first catalog');
  const loadingText=state.catalog;assert.ok(loadingText.length>0,'catalog status announces the initial load');
  await clickSelect('frontdesk');await quiet();
  state=await dom();assert.notEqual(state.selects.frontdesk.open,true,'a disabled native select cannot be opened');
  await holdStatus();await clickRefresh();
  state=await dom();for(const role of ROLES)assert.equal(state.selects[role].disabled,true,role+' stays disabled while the very first refresh is pending');
  // 2. first-load failure is explicit and retryable, then recovers.
  await rejectStatus('SYNTHETIC_FIRST_STATUS_FAILURE');
  await quiet();
  state=await dom();
  for(const role of ROLES)assert.equal(state.selects[role].disabled,true,role+' still disabled after a first-load failure');
  assert.equal(state.saveDisabled,true,'save stays unavailable after a first-load failure');
  assert.notEqual(state.catalog,loadingText,'failure replaces the loading announcement');
  assert.equal(state.refreshDisabled,false,'retry stays available after a first-load failure');
  await shot('first-load-failure');
  await clickRefresh();await until(async()=>{const current=await dom();return current.selects.frontdesk.options.length===4;},'good catalog recovers the surface');
  state=await dom();
  // 3. good catalog: defaults applied, native selects operable, save available.
  assert.deepEqual(state.selects.frontdesk.options,['','alpha/m-one','alpha/m-two','alpha/m-three']);
  assert.equal(state.selects.frontdesk.value,'alpha/m-one','frontdesk adopts the saved default');
  assert.equal(state.selects.orchestrator.value,'','orchestrator keeps the follow-native placeholder');
  assert.equal(state.selects.worker.value,'alpha/m-two','worker adopts the saved default');
  assert.ok(state.selects.frontdesk.labels[1].includes('alpha'),'option text shows its provider');
  for(const role of ROLES)assert.equal(state.selects[role].disabled,false,role+' operable with a loaded catalog');
  assert.equal(state.saveDisabled,false,'save available with a loaded catalog');
  const loadedText=state.catalog;
  // 4. pending refresh over the loaded catalog keeps selects clickable/editable.
  await holdStatus();const beforeStatus=counts(state).status;await clickRefresh();
  state=await dom();
  for(const role of ROLES)assert.equal(state.selects[role].disabled,false,role+' must stay clickable while a refresh is pending');
  assert.equal(state.saveDisabled,false,'save must stay available while a refresh is pending');
  assert.equal(counts(state).status,beforeStatus+1,'exactly one pending status request');
  await pick('frontdesk',['Home','End','Enter'],'alpha/m-three','pending refresh edit');
  await shot('pending-refresh-edit');
  // 5. same-catalog reply while a native menu is open keeps the menu open.
  await clickSelect('orchestrator');
  await until(async()=>(await menuOpenState('orchestrator')).open===true,'menu opens for orchestrator during pending refresh');
  await resolveStatus(payload(ALPHA,{frontdesk:'alpha/m-one',orchestrator:'',worker:'alpha/m-two'},SOURCES_ALPHA));
  await quiet();
  state=await dom();
  assert.equal(state.selects.orchestrator.open,true,'an identical catalog reply must not close the open native menu');
  assert.equal(state.selects.orchestrator.disabled,false,'select stays operable across the identical reply');
  await keys(['Home','ArrowDown','Enter']);
  await until(async()=>{const current=await dom();return current.selects.orchestrator.value==='alpha/m-one'&&current.selects.orchestrator.open!==true;},'user commits the still-open menu');
  await shot('same-catalog-menu-survives');
  // 6. failed refresh preserves the loaded catalog and dirty selections.
  await holdStatus();await clickRefresh();
  await pick('worker',['Home','ArrowDown','Enter'],'alpha/m-one','edit before failure');
  await rejectStatus('SYNTHETIC_REFRESH_FAILURE');
  await quiet();
  state=await dom();
  for(const role of ROLES)assert.equal(state.selects[role].disabled,false,role+' must stay operable after a failed refresh over a loaded catalog');
  assert.equal(state.saveDisabled,false,'save must stay available after a failed refresh');
  assert.deepEqual(state.selects.frontdesk.options,['','alpha/m-one','alpha/m-two','alpha/m-three'],'failed refresh keeps the loaded catalog options');
  assert.equal(state.selects.frontdesk.value,'alpha/m-three','dirty frontdesk choice survives the failure');
  assert.equal(state.selects.orchestrator.value,'alpha/m-one','dirty orchestrator choice survives the failure');
  assert.equal(state.selects.worker.value,'alpha/m-one','dirty worker choice survives the failure');
  assert.notEqual(state.catalog,loadedText,'failure is announced');
  assert.equal(state.refreshDisabled,false,'retry stays available after a failed refresh');
  await shot('failed-refresh-keeps-catalog');
  // 7. later success with a different catalog: dirty input kept, focused select rebuilt only after blur.
  await setState({catalog:BETA,defaults:{frontdesk:'alpha/m-one',orchestrator:'',worker:'alpha/m-two'},sources:SOURCES_BETA});
  await holdStatus();
  await clickRefresh();
  await clickSelect('worker');
  await keys(['Escape']);
  await resolveStatus(payload(BETA,{frontdesk:'alpha/m-one',orchestrator:'',worker:'alpha/m-two'},SOURCES_BETA));
  await until(async()=>{const current=await dom();return current.selects.frontdesk.options.includes('beta/b-one');},'changed catalog repaints the unfocused selects');
  await quiet();
  state=await dom();
  assert.deepEqual(state.selects.frontdesk.options,['','beta/b-one','beta/b-two','alpha/m-three'],'dirty frontdesk value is kept via an in-list fallback option');
  assert.equal(state.selects.frontdesk.value,'alpha/m-three','dirty frontdesk value survives the catalog change');
  assert.deepEqual(state.selects.orchestrator.options,['','beta/b-one','beta/b-two','alpha/m-one'],'dirty orchestrator value is kept via an in-list fallback option');
  assert.equal(state.selects.orchestrator.value,'alpha/m-one','dirty orchestrator value survives the catalog change');
  assert.equal(state.selects.worker.focused,true,'worker still holds focus after its keyboard pick');
  assert.deepEqual(state.selects.worker.options,['','alpha/m-one','alpha/m-two','alpha/m-three'],'a focused select is not rebuilt mid-interaction');
  await blurFocus();await quiet();
  state=await dom();
  assert.deepEqual(state.selects.worker.options,['','beta/b-one','beta/b-two','alpha/m-one'],'the focused select adopts the new catalog after blur');
  assert.equal(state.selects.worker.value,'alpha/m-one','dirty worker value still kept after the deferred rebuild');
  for(const role of ROLES)assert.equal(state.selects[role].disabled,false,role+' operable after the successful refresh');
  await shot('refresh-keeps-dirty');
  // 8. save freezes the submitted payload, blocks duplicates and refresh, restores.
  const submitted={frontdesk:'alpha/m-three',orchestrator:'alpha/m-one',worker:'alpha/m-one'};
  const statusBeforeSave=counts(state).status;
  await armSave();await clickSave();
  await until(async()=>counts(await dom()).save===1,'save request starts');
  state=await dom();
  for(const role of ROLES)assert.equal(state.selects[role].disabled,true,role+' frozen while the save is in flight');
  assert.equal(state.saveDisabled,true,'save button disabled while busy');
  const saveCall=state.calls.filter(call=>call.op==='settings.models.save')[0];
  assert.deepEqual(saveCall.args,nestedDefaults(submitted),'the payload carries all three role model+thinking values captured before the freeze');
  await clickSave();await clickRefresh();await quiet();
  state=await dom();
  assert.equal(counts(state).save,1,'a real second submit during busy flight is refused');
  assert.equal(counts(state).status,statusBeforeSave,'an external refresh during a busy save is refused');
  await releaseSave();await quiet();
  state=await dom();
  for(const role of ROLES)assert.equal(state.selects[role].disabled,false,role+' restored after the save settles');
  assert.equal(state.saveDisabled,false,'save button restored after the save settles');
  assert.equal(state.refreshDisabled,false,'refresh button restored after the save settles');
  assert.deepEqual({frontdesk:state.selects.frontdesk.value,orchestrator:state.selects.orchestrator.value,worker:state.selects.worker.value},submitted,'committed values remain after the save');
  await shot('save-busy-restored');
  // 9. save started during a pending refresh submits the frozen snapshot, once, after the refresh.
  await holdStatus();await clickRefresh();
  const savesBeforePending=counts(state).save;
  await pick('frontdesk',['Home','ArrowDown','ArrowDown','Enter'],'beta/b-two','edit during pending refresh before save');
  await armSave();await clickSave();
  await quiet();
  state=await dom();
  assert.equal(counts(state).save,savesBeforePending,'the save waits for the in-flight refresh instead of racing it');
  for(const role of ROLES)assert.equal(state.selects[role].disabled,true,role+' frozen while save waits for the refresh');
  await resolveStatus(payload(BETA,{frontdesk:'alpha/m-three',orchestrator:'alpha/m-one',worker:'alpha/m-one'},SOURCES_BETA));
  await until(async()=>counts(await dom()).save===savesBeforePending+1,'save runs after the refresh settles');
  state=await dom();
  const lateSave=state.calls.filter(call=>call.op==='settings.models.save').at(-1);
  assert.deepEqual(lateSave.args,nestedDefaults({frontdesk:'beta/b-two',orchestrator:'alpha/m-one',worker:'alpha/m-one'}),'the frozen snapshot is submitted, not the refreshed defaults');
  await releaseSave();await quiet();
  state=await dom();
  assert.deepEqual({frontdesk:state.selects.frontdesk.value,orchestrator:state.selects.orchestrator.value,worker:state.selects.worker.value},{frontdesk:'beta/b-two',orchestrator:'alpha/m-one',worker:'alpha/m-one'},'saved values are what the user submitted');
  for(const role of ROLES)assert.equal(state.selects[role].disabled,false,role+' restored after the sequenced save');
  await shot('save-waits-refresh');
  // 10. empty catalog on a fresh surface: selects stay closed; a save click can only clear to native-default and never invents a selection.
  state=await freshMount({catalog:[],defaults:{},sources:SOURCES_ALPHA});
  const callsAtMount=state.calls.length;
  const savesAtMount=counts(state).save;
  await clickRefresh();
  await until(async()=>{const current=await dom();return current.catalog!==loadingText&&current.selects.frontdesk.disabled;},'empty catalog settles');
  await quiet();
  state=await dom();
  for(const role of ROLES){assert.equal(state.selects[role].disabled,true,role+' disabled with an empty catalog');assert.deepEqual(state.selects[role].options,[''],role+' keeps only the placeholder with an empty catalog');}
  assert.equal(state.saveDisabled,true,'no catalog or stored defaults means nothing can be submitted');
  await clickSave();await quiet();
  state=await dom();
  assert.equal(state.calls.length,callsAtMount+1,'an empty-catalog save click sends only the status refresh read plus nothing hidden');
  assert.equal(counts(state).save,savesAtMount,'no model selection is ever submitted from an empty catalog (user did not change any role)');
  await shot('empty-catalog-not-savable');
  const capabilityCatalog=[{...ALPHA[0],thinking:{supported:true,levels:['off','low'],source:'native-model-definition'}},{...ALPHA[1],thinking:{supported:true,levels:['off','high'],source:'native-model-definition'}}];
  await freshMount({catalog:capabilityCatalog,defaults:{frontdesk:'alpha/m-one',orchestrator:'',worker:''},sources:SOURCES_ALPHA});await clickRefresh();await quiet();
  await page.focus('[data-default-role="frontdesk"]');
  await setState({defaults:{frontdesk:'alpha/m-two',orchestrator:'',worker:''}});
  await page.evaluate(()=>window.__ps.mounts.at(-1).api.refresh());
  assert.equal((await dom()).selects.frontdesk.value,'alpha/m-one','focused picker defers incoming saved model change');
  const thinkingValues=()=>page.$$eval('[data-default-thinking="frontdesk"] option',options=>options.filter(option=>!option.disabled).map(option=>option.value));
  assert.deepEqual(await thinkingValues(),['','off','low']);
  await blurFocus();await quiet();assert.equal((await dom()).selects.frontdesk.value,'alpha/m-two');assert.deepEqual(await thinkingValues(),['','off','high'],'blur applies the deferred model and its own native thinking capabilities together');
  await page.select('[data-default-role="frontdesk"]','alpha/m-one');await page.$eval('[data-default-role="frontdesk"]',select=>select.dispatchEvent(new Event('change',{bubbles:true})));
  await page.evaluate(()=>window.__ps.mounts.at(-1).api.refresh());assert.equal((await dom()).selects.frontdesk.value,'alpha/m-one');assert.deepEqual(await thinkingValues(),['','off','low'],'refresh preserves dirty model and matching native thinking capabilities');
  await shot('model-bound-thinking-refresh');
  // Contract guard: the component never asked the double for anything else.
  state=await dom();
  assert.ok(state.calls.every(call=>['settings.providers.status','settings.models.save'].includes(call.op)),'no unexpected IPC operations');
  report.ok=report.errors.length===0;
}catch(error){
  report.failure=String(error.stack||error);console.log(report.failure);
  if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
}finally{
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(out,'main.log'),mainLog).catch(()=>{});
  console.log(JSON.stringify({ok:report.ok===true,out,scenes:report.scenes.map(scene=>scene.name),errors:report.errors},null,2));
  if(child.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([exited,tick(3000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exited;}}
  await browser?.disconnect().catch(()=>{});
  if(report.ok!==true)process.exitCode=1;
}
