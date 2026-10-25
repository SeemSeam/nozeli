// Serial UI evidence only; no model request. Run from any cwd with an absolute script path.
// NOZELI_DESIGN_PHASE=before|after NOZELI_TEST_BINARY=/release/nozeli node /source/apps/desktop/tests/desktop-settings-design-live.mjs
// S1/S2 only (six host-shell captures; prior sY0OUh before evidence stays untouched): NOZELI_DESIGN_MODE=precision NOZELI_DESIGN_PHASE=after ...
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {contentTool} from './native-content-tools.fixture.mjs';
import {configureNativeConversation} from './native-conversation-ready.fixture.mjs';

const source = path.resolve(import.meta.dirname, '..');
const phase = process.env.NOZELI_DESIGN_PHASE || 'before';
assert(['before', 'after'].includes(phase));
const mode = process.env.NOZELI_DESIGN_MODE || 'full';
assert(['full', 'precision'].includes(mode));
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const lock = path.join(os.tmpdir(), 'nozeli-ui-design-live.lock');
await fs.mkdir(lock); // Shared exclusive lock: never remove another process's lock.
const out = await fs.mkdtemp(path.join(os.tmpdir(), `nozeli-settings-${phase}-`));
const project = path.join(out, 'Synthetic settings'), config = path.join(out, '.Nozeli'), profile = path.join(config, 'desktop');
const report = {phase, out, binary, evidence: 'actual Electron shell and separate native WCV; never a composite window', scenes: [], checks: [], errors: []};
report.mode = mode;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, shell, cleanupConversation, log = '', launchError;
async function until(fn, label) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    if (launchError) throw launchError;
    if (child && (child.exitCode !== null || child.signalCode)) throw Error('Electron exited: ' + log);
    const value = await fn(); if (value) return value;
    await pause(80);
  }
  throw Error('Timed out: ' + label);
}
async function call(page, op, payload = {}) {
  const result = await page.evaluate((op, payload) => nozeli.invoke(op, payload), op, payload);
  assert.equal(result.ok, true, op + ': ' + JSON.stringify(result.error)); return result.value;
}
async function scoped(predicate) {
  return until(async () => {
    for (const page of await browser.pages()) {
      const scope = await page.evaluate(() => window.__workspaceScope).catch(() => null);
      if (scope && predicate(scope) && await page.evaluate(() => window.__nozeliReady === true)) return {page, scope};
    }
  }, 'native surface');
}
async function computed() {
  return shell.evaluate(() => {
    const rect = node => {const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};};
    const rgba = value => {const values = value.match(/[\d.]+/g)?.map(Number); return values ? [...values.slice(0,3),values[3] ?? 1] : [0,0,0,0];};
    const blend = (a,b) => {const alpha = a[3]+b[3]*(1-a[3]); return [0,1,2].map(i => alpha ? (a[i]*a[3]+b[i]*b[3]*(1-a[3]))/alpha : 255).concat(alpha);};
    const background = node => {let color=[0,0,0,0]; for(let current=node;current;current=current.parentElement) color=blend(color,rgba(getComputedStyle(current).backgroundColor)); return blend(color,[255,255,255,1]);};
    const lum = rgb => rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    const dialog=document.querySelector('#settings-dialog'), content=dialog.querySelector('.settings-content'), clip=content.getBoundingClientRect();
    return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},theme:document.documentElement.dataset.theme,chromeFont:getComputedStyle(dialog).fontSize,dialog:rect(dialog),scroll:{top:content.scrollTop,height:content.scrollHeight,clientHeight:content.clientHeight},focus:document.activeElement?.outerHTML.slice(0,400),nodes:[...dialog.querySelectorAll('h2,h3,h4,label,p,button,select,input,.settings-scope-label,.settings-scope-divider')].filter(node=>{const r=node.getBoundingClientRect();return node.getClientRects().length&&r.bottom>0&&r.top<innerHeight&&(!content.contains(node)||(r.bottom>clip.top&&r.top<clip.bottom));}).map(node=>{const s=getComputedStyle(node),bg=background(node),fg=blend(rgba(s.color),bg),a=lum(fg),b=lum(bg);return {tag:node.tagName,text:(node.textContent||node.getAttribute('aria-label')||'').trim().slice(0,150),action:node.dataset.uiAction||'neutral',disabled:!!node.disabled,bounds:rect(node),fontSize:s.fontSize,fontFamily:s.fontFamily,fontWeight:s.fontWeight,lineHeight:s.lineHeight,color:s.color,background:s.backgroundColor,compositedBackground:bg,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),outline:{style:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor},overflow:{width:node.scrollWidth>node.clientWidth+1,height:node.scrollHeight>node.clientHeight+1}};})};
  });
}
async function capture(name) {
  const state = await computed();
  const file = `${name}.png`;
  await shell.screenshot({path:path.join(out,file)});
  report.scenes.push({name,file,surface:'host shell',...state});
}
async function precisionSettings() {
  report.evidence = 'Actual Electron host shell only; not a full-window/WCV composite. Isolated synthetic settings configuration; no model inference.';
  const current = '[data-settings-section="settings-appearance"]';
  const other = '[data-settings-section="settings-provider"]';
  async function appearance(width, theme, size) {
    await call(shell,'session.resize',{width,height:900});
    await shell.waitForFunction(width=>innerWidth===width&&innerHeight===900,{},width);
    await shell.click('#open-settings');
    await shell.waitForSelector('#settings-dialog[open]');
    await shell.click(current);
    await shell.select('[data-appearance="theme"]',theme);
    await shell.select('[data-appearance="size"]',String(size));
    await shell.select('[data-appearance="font"]','serif');
    await shell.waitForFunction((theme,size)=>document.documentElement.dataset.theme===theme&&getComputedStyle(document.documentElement).getPropertyValue('--chrome-font-size').trim()===size+'px',{},theme,size);
  }
  async function navState() {
    const state = await shell.evaluate(() => {
      const nodes = [...document.querySelectorAll('.settings-nav button')];
      return {current:nodes.filter(node=>node.getAttribute('aria-current')==='page').map(node=>node.dataset.settingsSection),buttons:nodes.filter(node=>node.dataset.settingsSection).map(node=>{const css=getComputedStyle(node),rect=node.getBoundingClientRect();return {section:node.dataset.settingsSection,hover:node.matches(':hover'),focusVisible:node.matches(':focus-visible'),background:css.backgroundColor,color:css.color,outline:{style:css.outlineStyle,width:css.outlineWidth,color:css.outlineColor,offset:css.outlineOffset},bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};})};
    });
    assert.deepEqual(state.current,['settings-appearance']);
    return state;
  }
  for (const theme of ['light','dark']) {
    await appearance(1200,theme,13);
    await shell.click(current);
    await shell.hover(other);
    const hover = await navState();
    assert(hover.buttons.find(node=>node.section==='settings-provider').hover);
    assert.notEqual(hover.buttons.find(node=>node.section==='settings-provider').background,hover.buttons.find(node=>node.section==='settings-appearance').background);
    await capture(`precision-${theme}-current-appearance-hover-provider`);
    report.checks.push({scene:'navigation-hover',theme,...hover});
    await shell.hover('.settings-heading h2');
    await shell.keyboard.down('Shift');
    try {await shell.keyboard.press('Tab');await shell.keyboard.press('Tab');}
    finally {await shell.keyboard.up('Shift');}
    const focus = await navState();
    assert.equal(await shell.$eval(other,node=>node===document.activeElement),true);
    const focused = focus.buttons.find(node=>node.section==='settings-provider');
    assert(focused.focusVisible);
    assert.notEqual(focused.outline.style,'none');
    assert(parseFloat(focused.outline.width)>0);
    await capture(`precision-${theme}-keyboard-provider`);
    report.checks.push({scene:'navigation-keyboard',theme,navigation:'click current, Shift+Tab twice; no scripted focus',...focus});
    await shell.keyboard.press('Escape');
    await shell.waitForFunction(()=>!document.querySelector('#settings-dialog').open);
  }
  for (const [width,size] of [[1200,13],[390,20]]) {
    await appearance(width,'dark',size);
    await shell.click('[data-settings-section="settings-models"]');
    await shell.waitForFunction(()=>!document.querySelector('[data-model-refresh]').disabled);
    await shell.$eval('[data-model-refresh]',node=>node.parentElement.scrollIntoView({block:'center'}));
    await shell.hover('.settings-heading h2');
    const group = await shell.$eval('[data-model-refresh]',node=>{
      const parent=node.parentElement,css=getComputedStyle(parent),clip=document.querySelector('.settings-content').getBoundingClientRect();
      return {display:css.display,wrap:css.flexWrap,gap:css.gap,buttons:[...parent.children].map(button=>{const r=button.getBoundingClientRect();return {text:button.textContent,x:r.x,y:r.y,width:r.width,height:r.height,visible:r.width>0&&r.height>0&&r.left>=clip.left&&r.right<=clip.right&&r.top>=clip.top&&r.bottom<=clip.bottom};})};
    });
    assert.equal(group.display,'flex');assert.equal(group.wrap,'wrap');assert.equal(group.gap,'8px');
    assert.equal(group.buttons.length,2);assert(group.buttons.every(button=>button.visible));
    const [first,second]=group.buttons;
    group.wrapped=second.y>=first.y+first.height;
    group.measuredGap=group.wrapped?second.y-first.y-first.height:second.x-first.x-first.width;
    assert(Math.abs(group.measuredGap-8)<1);
    // Wrapping is capacity-driven; two fully visible independent buttons may fit.
    assert(group.wrapped||second.x>=first.x+first.width+7,'Independent actions remain separated without clipping');
    await capture(`precision-${width}-${size}-model-actions`);
    report.checks.push({scene:'model-actions',width,size,...group});
    await shell.keyboard.press('Escape');
    await shell.waitForFunction(()=>!document.querySelector('#settings-dialog').open);
  }
  report.checks.push('S1/S2 only; no save, refresh, configure-source, send, or dangerous action invoked; no complete settings matrix.');
}
try {
  await fs.mkdir(project);
  await fs.copyFile(path.join(source,'tests/fixtures/reading-report.txt'),path.join(project,'paper.md'));
  const original = await fs.readFile(path.join(project,'paper.md'),'utf8');
  const projectId=(await new DesktopHost(profile).pick(project)).project.id;
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
  const env={...process.env};
  for(const key of Object.keys(env)) if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/i.test(key)) delete env[key];
  Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_TEST_PICK:project,NOZELI_SHOT_DIR:out});
  child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(source,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{cwd:os.tmpdir(),env,stdio:['ignore','pipe','pipe']});
  child.on('error',error=>{launchError=error;});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
  await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'debug connection');
  shell=(await scoped(s=>s.role==='shell')).page;
  shell.on('pageerror',error=>report.errors.push(error.message));
  if(await shell.$eval('#configuration-setup',node=>node.open)){await shell.click('#configuration-independent');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
  await configure();
  async function configure(){cleanupConversation=await configureNativeConversation(shell);}
  if(mode==='precision') {
    await precisionSettings();
  } else {
  await shell.waitForSelector('#file-tree [data-path="paper.md"]',{visible:true});
  await shell.click('#file-tree [data-path="paper.md"]');
  const doc=await scoped(s=>s.role==='surface'&&s.relPath==='paper.md'&&!s.readOnly);
  await contentTool(shell,doc.page,doc.scope.viewId,['view','text-mode']);
  await doc.page.waitForSelector('#text-host .cm-content',{visible:true});
  await doc.page.evaluate(()=>{__nozeliInput.select(0,0);__nozeliInput.focus();});
  await doc.page.keyboard.type('SETTINGS_EDIT_SENTINEL ');
  await doc.page.evaluate(()=>{__nozeliInput.select(2,9);window.__settingsEditor=document.querySelector('#text-host .cm-editor');});
  const documentState=()=>doc.page.evaluate(()=>({text:__nozeliInput.text(),selection:__nozeliInput.selection(),sameEditor:window.__settingsEditor===document.querySelector('#text-host .cm-editor')}));
  const before=await documentState();
  // This editor autosaves; preserve its real settled edit rather than inventing an unsaved state.
  await until(async()=>await fs.readFile(path.join(project,'paper.md'),'utf8')===before.text,'existing editor autosave');
  const persistedBefore=await fs.readFile(path.join(project,'paper.md'),'utf8');
  report.editorPersistence='Actual production autosave settled before settings; text/selection/editor instance remain protected throughout.';
  const documentPane='.workspace-pane:has([data-view-id="'+doc.scope.viewId+'"])';
  const documentGroup=await shell.$eval(documentPane,node=>node.dataset.workspaceGroup);
  await shell.locator(documentPane+' .workspace-pane-header').click({button:'right'});
  await shell.waitForSelector('#workspace-title-menu:not([hidden]) [data-command="split-x"]');
  await shell.click('#workspace-title-menu [data-command="split-x"]');
  await shell.waitForFunction(group=>[...document.querySelectorAll('.workspace-pane')].some(node=>node.dataset.workspaceGroup!==group),{},documentGroup);
  const emptyPane=await shell.$eval('.workspace-pane:not([data-workspace-group="'+documentGroup+'"])',node=>node.dataset.workspaceGroup);
  await shell.click('[data-workspace-group="'+emptyPane+'"] .workspace-pane-header');
  await shell.waitForSelector('#workspace-open-conversation:not([disabled])');await shell.click('#workspace-open-conversation');
  const chat=(await scoped(s=>s.kind==='conversation'&&s.projectId===projectId)).page;
  await chat.waitForSelector('#composer',{visible:true});
  await chat.$eval('#composer',node=>{node.value='SETTINGS_UNSENT_DRAFT';node.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await shell.$eval('[data-workspace-group="'+documentGroup+'"] [data-view-id]',node=>node.dataset.viewId),doc.scope.viewId);
  assert.equal(await doc.page.evaluate(()=>window.__settingsEditor===document.querySelector('#text-host .cm-editor')),true);
  assert.deepEqual(await documentState(),before);
  const managedBefore=(await call(shell,'managed.status',{projectId})).state;
  const matrix=[['wide-light',1200,'light'],['wide-dark',1200,'dark'],['390-dark',390,'dark'],...(phase==='after'?[['390-light',390,'light']]:[])];
  for(const [label,width,theme]of matrix){
    await call(shell,'session.resize',{width,height:900});
    await shell.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,{}, {width,height:900});
    for(const size of [13,20]){
      await shell.click('#open-settings');await shell.waitForSelector('#settings-dialog[open]');
      await shell.click('[data-settings-section="settings-appearance"]');
      await shell.select('[data-appearance="theme"]',theme);await shell.select('[data-appearance="size"]',String(size));
      await shell.select('[data-appearance="font"]','serif');
      await shell.waitForFunction((theme,size)=>document.documentElement.dataset.theme===theme&&getComputedStyle(document.documentElement).getPropertyValue('--chrome-font-size').trim()===size+'px',{},theme,size);
      await capture(`${label}-${size}-appearance`);
      for(const section of ['settings-provider','settings-models','settings-agents']){
        await shell.click(`[data-settings-section="${section}"]`);
        if(section==='settings-provider')await shell.waitForSelector('[data-provider-row="native-ui-local"]');
        if(section==='settings-models')await shell.waitForFunction(()=>!document.querySelector('[data-role-model-form] button').disabled);
        if(section==='settings-agents')await shell.waitForFunction(()=>!document.querySelector('[data-agent-limits-save]').disabled);
        await capture(`${label}-${size}-${section}`);
        await shell.$eval('.settings-content',node=>{node.scrollTop=node.scrollHeight;});
        await capture(`${label}-${size}-${section}-bottom`);
      }
      await shell.focus('#settings-close');await shell.keyboard.press('Tab');
      const forward=await shell.evaluate(()=>({id:document.activeElement.id,inside:!!document.activeElement.closest('#settings-dialog')}));
      assert(forward.inside);await capture(`${label}-${size}-keyboard-focus`);
      await shell.keyboard.down('Shift');await shell.keyboard.press('Tab');await shell.keyboard.up('Shift');assert.equal(await shell.evaluate(()=>document.activeElement.id),'settings-close');
      await shell.keyboard.press('Escape');await shell.waitForFunction(()=>!document.querySelector('#settings-dialog').open);
      assert.equal(await shell.evaluate(()=>document.activeElement.id),'open-settings');
      assert.deepEqual(await documentState(),before);
      assert.equal(await chat.$eval('#composer',node=>node.value),'SETTINGS_UNSENT_DRAFT');
      report.checks.push({label,size,tab:forward,escapeFocus:'open-settings',documentSelectionAndUnsavedText:true,draft:true});
    }
  }
  report.saveContracts=[];
  await shell.click('#open-settings');await shell.waitForSelector('#settings-dialog[open]');
  for(const contract of [
    {name:'models',section:'settings-models',button:'[data-role-model-form] button[type="submit"]',status:'[data-model-status]'},
    {name:'limits',section:'settings-agents',button:'[data-agent-limits-save]',status:'[data-agent-limits-status]'},
  ]){
    try{
      await shell.click(`[data-settings-section="${contract.section}"]`);
      // Selecting the section starts an async refresh and disables submit; never click before it settles.
      await shell.waitForFunction(selector=>!document.querySelector(selector).disabled,{},contract.button);
      await shell.click(contract.button);
      await shell.waitForFunction(({button,status})=>!document.querySelector(button).disabled&&document.querySelector(status).textContent.includes('已保存'),{},contract);
      report.saveContracts.push({name:contract.name,pass:true,status:await shell.$eval(contract.status,node=>node.textContent)});
    }catch(error){
      report.saveContracts.push({name:contract.name,pass:false,error:error.message,status:await shell.$eval(contract.status,node=>node.textContent).catch(()=>null),button:await shell.$eval(contract.button,node=>({disabled:node.disabled,text:node.textContent})).catch(()=>null)});
    }
    await capture(`save-contract-${contract.name}`);
  }
  await shell.keyboard.press('Escape');await shell.waitForFunction(()=>!document.querySelector('#settings-dialog').open);
  assert.deepEqual(await documentState(),before);
  assert.equal(await chat.$eval('#composer',node=>node.value),'SETTINGS_UNSENT_DRAFT');
  if(phase==='after')assert(report.saveContracts.every(contract=>contract.pass),'after save contracts must pass: '+JSON.stringify(report.saveContracts));
  const managedAfter=(await call(shell,'managed.status',{projectId})).state;
  assert.deepEqual(managedAfter.jobs,managedBefore.jobs);
  assert.deepEqual(managedAfter.agents.map(a=>[a.target,a.threadId]),managedBefore.agents.map(a=>[a.target,a.threadId]));
  assert.equal(await fs.readFile(path.join(project,'paper.md'),'utf8'),persistedBefore);
  assert.equal(await fs.readFile(path.join(source,'tests/fixtures/reading-report.txt'),'utf8'),original);
  report.checks.push('zero new jobs; same native threads; settled project edit and original source fixture bytes unchanged by settings; no send action');
  report.nativeBounds=await call(shell,'workspace.windows.list',{projectId});
  await doc.page.screenshot({path:path.join(out,'retained-editor-wcv.png')});
  await chat.screenshot({path:path.join(out,'retained-draft-wcv.png')});
  }
  report.pass=true;
} catch(error){report.pass=false;report.failure=error.stack;throw error;}
finally {
  if(shell&&!shell.isClosed())await Promise.race([shell.evaluate(()=>nozeli.invoke('session.requestClose',{})).catch(()=>{}),pause(1500)]);
  if(child&&child.exitCode===null&&!child.signalCode){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(7000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');}
  await browser?.disconnect();
  try{await cleanupConversation?.();}catch(error){report.pass=false;report.inferenceFailure=error.message;process.exitCode=1;}
  await fs.writeFile(path.join(out,'electron.log'),log);
  await fs.writeFile(path.join(out,'evidence.json'),JSON.stringify(report,null,2));
  await fs.rmdir(lock);
  console.log(JSON.stringify({pass:report.pass,phase,out,failure:report.failure,inferenceFailure:report.inferenceFailure}));
}
