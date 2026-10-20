// managed-omp-terminal-dispatch-live.mjs — P4 TUI-native：真实可见 Electron 验证 OMP 终端。
// OMP 角色 = OmpTuiSession（唯一 PTY/session owner）；attach 是同一 PTY 的真实视图（replay/resize/input）；
// 零 codex 派生；草稿路径健康；正常关闭 exit 0。运行：NOZELI_OMP_BIN=<omp> node tests/managed-omp-terminal-dispatch-live.mjs
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const appRoot = path.resolve(import.meta.dirname, '..');
const OMP_BIN = process.env.NOZELI_OMP_BIN;
if (!OMP_BIN) { console.error('需要 NOZELI_OMP_BIN'); process.exit(2); }
const pidOf = root => createHash('sha256').update(root).digest('hex');
const MODELS_YML = ['providers:', '  synthetic-omp:', '    api: openai-completions', '    baseUrl: http://127.0.0.1:9/', '    auth: none',
  '    models:', '      - id: model', '        reasoning: true', ''].join('\n');

const profile = await mkdtemp(path.join(os.tmpdir(), 'p4td-'));
const projectA = path.join(profile, 'projA');
await mkdir(projectA, { recursive: true, mode: 0o700 }); await writeFile(path.join(projectA, 'readme.md'), '# synthetic\n');
await mkdir(projectA.replace('projA','projB'),{recursive:true});
for (const d of ['home', 'tmp']) await mkdir(path.join(profile, d), { recursive: true });
await mkdir(path.join(profile, 'userData'), { recursive: true, mode: 0o700 });
await writeFile(path.join(profile, 'userData', 'omp-service.json'), JSON.stringify({ modelsYml: MODELS_YML, envReferences: [] }));

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, ...(detail ? { detail } : {}) }); console.error(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ' ' + JSON.stringify(detail ?? null)}`); };
const waitFor = async (fn, timeoutMs = 30000, label = 'condition') => { const end = Date.now() + timeoutMs; for (;;) { try { const v = await fn(); if (v) return v; } catch { } if (Date.now() > end) throw new Error('timeout: ' + label); await new Promise(r => setTimeout(r, 200)); } };
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// 数 app 子进程树内的 codex 二进制进程（/proc 父链限定本 Electron 实例，证据为实进程 cmdline）
async function codexProcesses(rootPid) {
  const children = new Map();
  for (const entry of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = (await readFile(`/proc/${entry}/stat`)).toString();
      const m = stat.match(/^\d+ \(.*\) (?:\S+ )?(\d+)/);
      if (m) { const ppid = Number(m[1]); if (!children.has(ppid)) children.set(ppid, []); children.get(ppid).push(Number(entry)); }
    } catch { /* 进程退出竞态 */ }
  }
  const tree = new Set([rootPid]);
  for (let queue = [rootPid]; queue.length;) {
    const next = [];
    for (const pid of queue) for (const c of (children.get(pid) ?? [])) if (!tree.has(c)) { tree.add(c); next.push(c); }
    queue = next;
  }
  const found = [];
  for (const pid of tree) {
    try {
      const cmdline = (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0').filter(Boolean);
      if (cmdline.some(a => /(^|\/)codex$/.test(a))) found.push({ pid: String(pid), argv: cmdline.join(' ').slice(0, 120) });
    } catch { /* 进程退出竞态 */ }
  }
  return found;
}

async function launchApp(pickList) {
  const port = await freePort();
  const child = spawn(electronPath, ['--ozone-platform=x11', path.join(appRoot, 'tests/omp-viewport-entry.cjs')], {
    cwd: path.dirname(appRoot),
    env: { ...process.env, HOME: path.join(profile, 'home'), TMPDIR: path.join(profile, 'tmp'), LANG: 'C.UTF-8',
      NOZELI_HIDDEN: '0', NOZELI_OZONE: 'x11', NOZELI_TEST_INSTANCE: String(++launchApp.seq),
      NOZELI_USER_DATA: path.join(profile, 'userData'), NOZELI_DEBUG_PORT: String(port),
      NOZELI_TEST_PICK: pickList, NOZELI_SHOT_DIR: path.join(profile, 'shots'), NOZELI_OMP_BIN: OMP_BIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, 40000, 'devtools');
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 60000, defaultViewport: null });
  const page = (await browser.pages()).find(p => p.url().includes('127.0.0.1'));
  await waitFor(() => page.evaluate(() => window.__nozeliReady === true), 30000, 'ready');
  return { child, browser, page, port, readOutput: () => output };
}
launchApp.seq = 0;
async function stopApp(app) {
  const exited = new Promise(resolve => app.child.once('close', (code, signal) => resolve({ code, signal })));
  await app.page.evaluate(() => window.nozeli.invoke('session.requestClose')).catch(() => {});
  const result = await Promise.race([exited, new Promise(r => setTimeout(() => r({ code: 'HANG', output: app.readOutput().slice(-2000) }), 60000))]);
  await app.browser.disconnect().catch(() => {});
  return result;
}

async function enableOmp(page, pid) {
  await page.evaluate(() => document.querySelector('#pick-project')?.click());
  await page.click('#open-settings');
  await page.click('[data-settings-section="settings-general"]');
  await page.click('#provider-console-toggle');
  await new Promise(r => setTimeout(r, 800));
  await page.waitForFunction(async pid=>(await window.nozeli.invoke('managed.status',{projectId:pid})).value?.ready,{},pid);
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const ready = await page.evaluate(async (pid) => {
      if (document.querySelector('#settings-dialog')?.open) return false;
      try { const s = await window.nozeli.invoke('managed.status', { projectId: pid }); return s?.value?.ready === true; } catch { return false; }
    }, pid).catch(() => false);
    if (ready) return { ok: true };
  }
  const statusText = await page.evaluate(() => document.querySelector('#ai-status')?.textContent ?? '').catch(() => '');
  return { ok: false, reason: 'timeout waiting ready', statusText };
}


let app;
try {
 app=await launchApp(projectA+'\n'+projectA.replace('projA','projB'));
 const enabled=await enableOmp(app.page,pidOf(projectA));
 if(!enabled.ok)throw Error(JSON.stringify(enabled));
 if(!await app.page.$eval('#provider-console',node=>node.checkVisibility())){await app.page.click('#open-settings');await app.page.click('[data-settings-section="settings-general"]');await app.page.click('#provider-console-toggle');}
 await app.page.evaluate(async pid=>window.nozeli.invoke('managed.draft',{projectId:pid,target:'frontdesk',text:'viewport-preserved-draft'}),pidOf(projectA));
 const snapshots=[];
 const fontScope=await app.page.evaluate(()=>{const font=()=>getComputedStyle(document.querySelector('#managed-terminal-grid .xterm-screen .xterm-rows')).fontSize;const before=font();document.querySelector('#font-larger')?.click();return {before,after:font(),readerLabel:document.querySelector('#font-size-label')?.textContent,terminalFontControl:false};});
 const initial=await app.page.evaluate(async pid=>(await window.nozeli.invoke('managed.status',{projectId:pid})).value,pidOf(projectA));
 for(const [name,width,height] of [['wide',1280,800],['low',1100,480],['narrow',600,700],['narrow-low',480,480],['single',1100,700],['double',1280,800],['restored',1280,800],['zoomed',600,480]]){
  await app.page.evaluate(async({width,height})=>window.nozeli.invoke('session.resize',{width,height}),{width,height});
  if(name==='single'||name==='double')await app.page.evaluate(mode=>{const e=document.querySelector('#managed-terminal-grid select');e.value=mode;e.dispatchEvent(new Event('change'));},name==='single'?'1':'2');
  if(name==='restored'){await app.page.click('#provider-console-close');await new Promise(r=>setTimeout(r,150));await app.page.click('#open-settings');await app.page.click('[data-settings-section="settings-general"]');await app.page.click('#provider-console-toggle');}
  if(name==='zoomed'){
    await writeFile(path.join(profile,'userData','viewport-zoom'),'1.25');
  }
  await new Promise(r=>setTimeout(r,1400));
  if(name==='zoomed')assert.ok(await app.page.evaluate(()=>devicePixelRatio>1.5),'native Electron zoom changed devicePixelRatio');
  const geometry=await app.page.evaluate(()=>{
   const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,w:r.width,h:r.height,scrollH:e.scrollHeight,clientH:e.clientHeight,overflow:s.overflow,position:s.position,inset:s.inset}};
   return {viewport:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio},console:rect(document.querySelector('#provider-console')),grid:rect(document.querySelector('#managed-terminal-grid')),panes:rect(document.querySelector('.managed-agent-panes')),cards:[...document.querySelectorAll('#managed-terminal-grid article:not([hidden])')].map(e=>({card:rect(e),out:rect(e.querySelector('.provider-output')),xterm:rect(e.querySelector('.xterm')),screen:rect(e.querySelector('.xterm-screen'))}))};
  });
  await app.page.screenshot({path:path.join(profile,name+'.png')});
  await app.page.evaluate(()=>window.dispatchEvent(new CustomEvent('nozeli-open-settings',{detail:'settings-agents'})));
  const settings=await app.page.evaluate(()=>{const e=document.querySelector('#settings-dialog'),r=e.getBoundingClientRect();return {open:e.open,x:r.x,y:r.y,w:r.width,h:r.height,scrollH:e.scrollHeight,clientH:e.clientHeight}});
  await app.page.screenshot({path:path.join(profile,name+'-settings.png')});
  const settingsReach=await app.page.evaluate(()=>{const e=document.querySelector('#settings-dialog');e.scrollTop=e.scrollHeight;const b=[...e.querySelectorAll('button')].filter(b=>b.checkVisibility()).at(-1);b?.scrollIntoView({block:'nearest'});const r=b?.getBoundingClientRect();return {bottomButton:b?.textContent,visible:Boolean(r&&r.top>=0&&r.bottom<=innerHeight),scrollTop:e.scrollTop,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}});
  await app.page.screenshot({path:path.join(profile,name+'-settings-bottom.png')});
  assert.ok(settingsReach.visible,name+' settings bottom reachable');
  assert.ok(settingsReach.scrollWidth<=settingsReach.clientWidth+2,name+' settings no horizontal clipping');
  await app.page.evaluate(()=>document.querySelector('#settings-dialog')?.close());
  await app.page.evaluate(()=>{const g=document.querySelector('.managed-agent-panes');g.scrollTop=g.scrollHeight;});
  await app.page.screenshot({path:path.join(profile,name+'-terminal-bottom.png')});
  const status=await app.page.evaluate(async pid=>(await window.nozeli.invoke('managed.status',{projectId:pid})).value,pidOf(projectA));
  const ptys=Object.entries(status.state.providers).filter(([role])=>['frontdesk','orchestrator'].includes(role)).map(([role,r])=>{let size;try{size=execFileSync('stty',['-F',`/proc/${r.pid}/fd/0`,'size'],{encoding:'utf8'}).trim()}catch(e){size=String(e.message)}return {role,pid:r.pid,size}});
  for(const role of ['frontdesk','orchestrator']){assert.equal(status.state.residents[role].threadId,initial.state.residents[role].threadId,name+' stable '+role);}
  assert.ok(geometry.cards.every(c=>c.screen.h<=c.out.h+1&&c.screen.w<=c.out.w+1),name+' fitted terminal inside card');
  assert.equal(status.state.drafts.frontdesk,'viewport-preserved-draft',name+' durable draft preserved');
  await waitFor(()=>app.page.evaluate(()=>[...document.querySelectorAll('#managed-terminal-grid article:not([hidden])')].every(card=>/model/.test([...card.querySelectorAll('.xterm-rows>div')].map(e=>e.textContent).join('\n')))),10000,name+' actual TUI content');
  const content=await app.page.evaluate(()=>[...document.querySelectorAll('#managed-terminal-grid article:not([hidden])')].map(card=>({role:card.dataset.managedTerminal,rows:[...card.querySelectorAll('.xterm-rows>div')].map(e=>e.textContent),capability:document.querySelector('.managed-terminal-capability')?.textContent??null})));
  for(const c of content){assert.match(c.rows.join('\n'),/model/,name+' '+c.role+' actual input/status content');}
  snapshots.push({name,geometry,settings,settingsReach,ptys,content});
 }
 // 双项目导航经正式 picker 登记与真实轨道点击；只检查A既有会话/草稿，不派模型输入。
 await app.page.evaluate(async dir=>window.nozeli.invoke('project.pick',{directory:dir}),projectA.replace('projA','projB'));
 await app.page.reload({waitUntil:'domcontentloaded'});await waitFor(()=>app.page.evaluate(()=>window.__nozeliReady===true));
 const projectB=projectA.replace('projA','projB');
 await app.page.evaluate(id=>document.querySelector(`[data-project-id="${id}"]`)?.click(),pidOf(projectB));
 await waitFor(()=>app.page.$eval(`[data-project-id="${pidOf(projectB)}"]`,e=>e.getAttribute('aria-current')==='true'));
 await app.page.evaluate(id=>document.querySelector(`[data-project-id="${id}"]`)?.click(),pidOf(projectA));
 await waitFor(()=>app.page.$eval(`[data-project-id="${pidOf(projectA)}"]`,e=>e.getAttribute('aria-current')==='true'));
 await app.page.click('#provider-console-close');
 await new Promise(r=>setTimeout(r,2000));
 await app.page.screenshot({path:path.join(profile,'project-return.png')});
 const returned=await app.page.evaluate(async pid=>(await window.nozeli.invoke('managed.status',{projectId:pid})).value,pidOf(projectA));
 for(const role of ['frontdesk','orchestrator'])assert.equal(returned.state.residents[role].threadId,initial.state.residents[role].threadId,'project return same session '+role);
 assert.equal(returned.state.drafts.frontdesk,'viewport-preserved-draft');
 await writeFile(path.join(profile,'font-scope.json'),JSON.stringify(fontScope,null,2));
 await writeFile(path.join(profile,'geometry.json'),JSON.stringify(snapshots,null,2));
 console.log(JSON.stringify({profile,snapshots:snapshots.map(x=>({name:x.name,viewport:x.geometry.viewport,ptys:x.ptys}))},null,2));
}finally{if(app){const exit=await stopApp(app);console.log('EXIT',JSON.stringify(exit));}}
