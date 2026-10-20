import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, symlink, writeFile, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'work-preview-'));
const root = path.join(output, 'app');
await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) await cp(path.join(source, item), path.join(root, item), { recursive: true });
for(const item of ['node_modules','vendor','assets'])await symlink(path.join(source,item),path.join(root,item),'dir');
const panelPath=path.join(root,'src/renderer/managed-agent-panel.mjs');
let panel=await readFile(panelPath,'utf8');
panel=panel.replace(" const call=async(op,p={},id=projectId)=>{",` const call=async(op,p={},id=projectId)=>{window.__previewCalls??=[];window.__previewCalls.push(op);if(op==='terminal.screen'){if(window.__previewDelay)await new Promise(r=>setTimeout(r,window.__previewDelay));return window.__previewScreens[p.target]||{available:false,reason:'Worker 终端尚未就绪'};}`);
panel=panel.replace("subscribe:fn=>window.nozeli.subscribe('agent',fn)","subscribe:fn=>{window.__previewNotify=fn;return ()=>{window.__previewNotify=null;};}");
panel=panel.replace(' return {get active()',` window.__previewTest=(s,id='preview-project')=>{projectId=id;state=s;ready=true;show(true);render();}; window.__previewClear=clear; return {get active()`);
await writeFile(panelPath,panel);
const projectionPath=path.join(root,'src/renderer/work-terminal-preview.mjs');
await writeFile(projectionPath,(await readFile(projectionPath,'utf8')).replace('function close(){',`function close(){if(current){window.__previewTrace??=[];window.__previewTrace.push({stack:new Error().stack,hover:current.anchor.parentElement.matches(':hover'),app:doc.querySelector('#app').className,rect:current.anchor.getBoundingClientRect().toJSON()});}`));
// Layout coverage owns injected state and must not auto-start real Providers.
const agentPanelPath=path.join(root,'src/renderer/agent-panel.mjs');
await writeFile(agentPanelPath,(await readFile(agentPanelPath,'utf8')).replace('async function loadProjectSettings(id, gen) {','async function loadProjectSettings(id, gen) { return;'));
const build = spawn(process.execPath, [path.join(root, 'tools/build-renderer.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let buildLog = '';
build.stdout.on('data', chunk => { buildLog += chunk; });
build.stderr.on('data', chunk => { buildLog += chunk; });
assert.equal(await new Promise(resolve => build.once('exit', resolve)), 0, buildLog);
const project = path.join(output, 'project');
await mkdir(project);
await writeFile(path.join(project, 'sample.md'), '# Reading\n\nA real project document.\n');
const port = await new Promise(resolve => {
  const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const require = createRequire(import.meta.url);
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => child.once('exit', resolve));
let log = '', browser, page;
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
const report = { checks: [], errors: [] };
try {
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw new Error(log);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Startup timeout: ' + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  page = (await browser.pages()).find(page => page.url().includes('127.0.0.1'));
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.__nozeliReady);
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('#pick-project'); await page.waitForFunction(()=>document.querySelector('#project-name').textContent==='project');
  await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });
  if(await page.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await page.click('#toggle-sidebar');
  const state=count=>({works:Array.from({length:count},(_,i)=>({id:'worker-'+i,name:'核对 '+(i+1),status:'review',binding:{model:'gpt-6.1-sol',effort:'low'}})),quotaUsed:count,limit:16,busyTargets:['frontdesk','orchestrator',...Array.from({length:count},(_,i)=>'worker-'+i)],bindings:{frontdesk:{model:'gpt-6.1-sol',effort:'low'},orchestrator:{model:'gpt-6.1-sol',effort:'high'}},messages:[],todos:[],jobs:[],receipts:[],drafts:{},agents:[],contentRoot:project});
  const screens={};for(let i=0;i<6;i++)screens['worker-'+i]={available:true,terminalId:'pty-'+i,threadId:'thread-'+i,seq:1,version:1,cols:100,rows:24,lines:Array.from({length:24},(_,y)=>[{text:y===0?'Worker '+(i+1)+' 红字 ANSI':'屏幕内容 '+y,cells:100,fg:y===0?'#cd0000':null,bg:null}])};
  await page.evaluate(s=>{window.__previewScreens=s;document.querySelector('#composer').value='未发送草稿';},screens);
  const preview='.work-terminal-preview:not([hidden])',trigger=i=>'[data-managed-work="worker-'+i+'"] .managed-work-preview';
  const check=name=>report.checks.push(name);
  for(const count of [2,4,6]){
   await page.evaluate(s=>window.__previewTest(s),state(count));
   for(let i=0;i<count;i++){
    await page.click(trigger(i));await page.waitForSelector(preview+' .work-terminal-preview-line');
    assert.match(await page.$eval(preview,n=>n.textContent),new RegExp('Worker '+(i+1)));
    assert.equal(await page.$eval(preview+' .work-terminal-preview-line span',n=>getComputedStyle(n).color),'rgb(205, 0, 0)');
    assert.equal(await page.$eval(preview,n=>Boolean(n.querySelector('input,textarea,button,a'))),false);
    await page.keyboard.press('Escape');assert.equal(await page.$(preview),null);
   }
   check(count+' Workers switch without mixing screen or controls');
  }
  const s=state(2);await page.evaluate(s=>window.__previewTest(s),s);await page.click(trigger(0));await page.waitForSelector(preview+' .work-terminal-preview-line');
  await page.evaluate(()=>window.__retained=document.querySelector('[data-managed-work="worker-0"]'));
  s.works[0].name='重新命名';await page.evaluate(s=>window.__previewTest(s),s);
  assert.equal(await page.evaluate(()=>window.__retained===document.querySelector('[data-managed-work="worker-0"]')),true);assert.match(await page.$eval(preview+' header',n=>n.textContent),/重新命名/);check('state refresh retains row and open preview');
  const rect=await page.$eval(preview,n=>{const r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+30};});await page.mouse.move(rect.x,rect.y,{steps:10});await new Promise(r=>setTimeout(r,200));assert(await page.$(preview));check('pointer crosses row gap into preview without closing');
  await page.mouse.move(20,20);await page.waitForFunction(()=>document.querySelector('.work-terminal-preview').hidden);check('leaving both regions closes');
  await page.click(trigger(0));await page.waitForSelector(preview);await page.click('#project-name');assert.equal(await page.$(preview),null);check('outside click closes');
  await page.click(trigger(0));await page.waitForSelector(preview);await page.evaluate(()=>window.__previewNotify({projectId:'preview-project',target:'worker-1',kind:'managed-terminal-screen'}));await new Promise(r=>setTimeout(r,200));assert.match(await page.$eval(preview,n=>n.textContent),/Worker 1/);check('other Worker events cannot change selected screen');
  for(let version=2;version<=3;version++){await page.evaluate(version=>{window.__previewScreens['worker-0'].version=version;window.__previewScreens['worker-0'].lines[0][0].text='实时更新'+version;window.__previewNotify({projectId:'preview-project',target:'worker-0',kind:'managed-terminal-screen'});},version);await page.waitForFunction(version=>document.querySelector('.work-terminal-preview').textContent.includes('实时更新'+version),{},version);}check('successive notifications refresh without timer starvation');
  await page.evaluate(()=>window.__previewNotify({projectId:'preview-project',target:'worker-0',kind:'managed-terminal',terminalId:'pty-0',ended:true}));assert.match(await page.$eval(preview,n=>n.textContent),/停止更新/);check('disconnected screen labelled stale');await page.keyboard.press('Escape');
  for(const width of [1440,1000,600]){
   await page.setViewport({width,height:800});await page.waitForFunction(()=>document.querySelector('#app').classList.contains('narrow-layout')===(innerWidth<=1000));if(await page.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await page.click('#toggle-sidebar');await page.evaluate(s=>window.__previewTest(s),state(2));await page.click(trigger(0));await page.waitForSelector(preview);
   const bounds=await page.$eval(preview,n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});assert(bounds.left>=0&&bounds.top>=0&&bounds.right<=bounds.width&&bounds.bottom<=bounds.height,JSON.stringify(bounds));await page.mouse.move(bounds.left+30,bounds.top+20);await page.screenshot({path:path.join(output,'preview-'+width+'.png')});await page.$eval(preview,n=>n.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})));assert(await page.$(preview));assert.equal(await page.$eval(trigger(0),n=>n.getBoundingClientRect().width>100),true);await page.keyboard.press('Escape');check(width+'px preview fits viewport and preserves drawer; readable work title');
  }
  await page.setViewport({width:1440,height:900});await page.evaluate(s=>window.__previewTest(s),state(2));await page.click(trigger(0));await page.waitForSelector(preview);await page.evaluate(()=>document.querySelector('#app').classList.add('side-collapsed'));await page.waitForFunction(()=>document.querySelector('.work-terminal-preview').hidden);await page.evaluate(()=>document.querySelector('#app').classList.remove('side-collapsed'));check('sidebar collapse closes');
  await page.click(trigger(0));await page.waitForSelector(preview);const ended=state(2);ended.works[0].status='ended';await page.evaluate(s=>window.__previewTest(s),ended);assert.equal(await page.$(preview),null);check('ending work closes existing projection');
  await page.evaluate(s=>window.__previewTest(s),state(2));await page.click(trigger(0));await page.waitForSelector(preview);await page.evaluate(s=>window.__previewTest(s,'other-project'),state(2));assert.equal(await page.$(preview),null);check('project change closes');
  await page.evaluate(s=>window.__previewTest(s),state(2));await page.evaluate(()=>delete window.__previewScreens['worker-0']);await page.click(trigger(0));await page.waitForFunction(()=>document.querySelector('.work-terminal-preview').textContent.includes('尚未就绪'));check('missing terminal honest placeholder without attach');await page.keyboard.press('Escape');
  await page.evaluate(()=>window.__previewDelay=180);await page.click(trigger(1));await page.keyboard.press('Escape');await new Promise(r=>setTimeout(r,300));assert.equal(await page.$(preview),null);await page.evaluate(()=>window.__previewDelay=0);check('late snapshot cannot reopen closed preview');
  assert.equal(await page.$eval('#composer',n=>n.value),'未发送草稿');assert.equal(await page.evaluate(()=>window.__previewCalls.some(c=>c!=='terminal.screen')),false,JSON.stringify(await page.evaluate(()=>window.__previewCalls)));check('no attach/input/resize/close/ACK; composer draft unchanged');
  assert.deepEqual(report.errors,[]);await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report}));
} catch (error) {
  report.failure = error.stack;report.trace=await page?.evaluate(()=>window.__previewTrace?.slice(-5)).catch(()=>null);
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error('Evidence: ' + output);
  throw error;
} finally {
  await browser?.disconnect();
  if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
  clearTimeout(timer);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
}
