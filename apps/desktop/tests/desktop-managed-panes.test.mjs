import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, symlink, writeFile, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'managed-panes-'));
const root = path.join(output, 'app');
await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) await cp(path.join(source, item), path.join(root, item), { recursive: true });
for(const item of ['node_modules','vendor','assets'])await symlink(path.join(source,item),path.join(root,item),'dir');
const panelPath=path.join(root,'src/renderer/managed-agent-panel.mjs');
await writeFile(panelPath,(await readFile(panelPath,'utf8')).replace(' return {get active()', ` window.__paneTest=s=>{projectId='layout-test';state=s;show(true);renderTerminals();}; return {get active()`));
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
  { await page.click('#open-settings'); await page.click('[data-settings-section="settings-general"]'); await page.click('#provider-console-toggle'); }
  const state=count=>({works:Array.from({length:count-2},(_,i)=>({id:'worker-'+i,name:'工作 '+(i+1),status:['running','paused','review'][i%3],binding:{model:'gpt-6.1-sol',effort:'high'}})),quotaUsed:count-2,limit:16,busyTargets:[],bindings:{frontdesk:{model:'gpt-6-luna',effort:'medium'},orchestrator:{model:'gpt-6.1-sol',effort:'high'}}});
  for(const width of [1440,1000,600]){
   await page.setViewport({width,height:900});
   for(const count of [2,3,4,5,6,8,10,18]){
    await page.evaluate(s=>window.__paneTest(s),state(count));
    await new Promise(r=>setTimeout(r,100));
    const result=await page.evaluate(()=>{const g=document.querySelector('.managed-agent-panes'),r=g.getBoundingClientRect(),cards=[...g.children];return {count:cards.length,overflow:g.scrollWidth>g.clientWidth+1,columns:getComputedStyle(g).gridTemplateColumns.split(' ').length,namesOnly:cards.every(c=>c.querySelector('header').textContent===c.dataset.name&&!c.querySelector('header button,header small,.managed-agent-status')&&c.querySelector('header').getBoundingClientRect().height<=32),valid:cards.filter(c=>!c.hidden).every(c=>{const b=c.getBoundingClientRect();return b.width>200&&b.height>=279&&b.left>=r.left&&b.right<=r.right+1;})};});
    assert.equal(result.count,count);assert.equal(result.overflow,false);assert.ok(result.valid,JSON.stringify(result));
    assert.equal(result.namesOnly,true,'pane header contains only its agent name');
    report.checks.push(width+'px / '+count+' panes / '+result.columns+' columns');
    if([2,4,6,18].includes(count))await page.screenshot({path:path.join(output,'panes-'+width+'-'+count+'.png')});
   }
  }
  await page.evaluate(s=>window.__paneTest(s),state(18));
  for(let group=0;group<3;group++){await page.click('.managed-pane-pages button:nth-child('+(group+1)+')');assert.equal(await page.$$eval('.managed-agent-pane:not([hidden])',els=>els.length),6);}
  report.checks.push('three groups accessible without removing hidden panes');
  await page.setViewport({width:1440,height:900});await page.evaluate(s=>window.__paneTest(s),state(6));
  await page.evaluate(()=>window.__retained=document.querySelector('[data-managed-terminal=frontdesk]'));
  await page.select('.managed-terminal-actions select','1');
  await page.select('.managed-terminal-actions select','auto');
  assert.equal(await page.$$eval('.managed-agent-pane:not([hidden])',els=>els.length),6);
  const changed=state(3);changed.works[0].name='重新命名';changed.works.push({id:'queued',name:'排队任务',status:'queued'});
  await page.evaluate(s=>window.__paneTest(s),changed);
  assert.equal(await page.$$eval('.managed-agent-pane',els=>els.length),3);
  assert.equal(await page.evaluate(()=>window.__retained===document.querySelector('[data-managed-terminal=frontdesk]')),true);
  assert.equal(await page.$eval('[data-managed-terminal=worker-0] strong',n=>n.textContent),'重新命名');
  changed.works[0].status='ended';await page.evaluate(s=>window.__paneTest(s),changed);
  assert.equal(await page.$$eval('.managed-agent-pane',els=>els.length),2);
  report.checks.push('columns, name-only headers, stable resident identity, rename, queue exclusion and unconnected worker removal');
  assert.deepEqual(report.errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
} catch (error) {
  report.failure = error.stack;
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
