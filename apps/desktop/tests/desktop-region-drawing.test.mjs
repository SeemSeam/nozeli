// Selection drawing → exact local discussion acceptance (2026-10-24).
// Real Electron, isolated profile, NOZELI_TEST_PICK project, no model:
// for image/PDF/PPT — physical region select → physical pen → 完成 creates
// exactly one persisted discuss tag at the original anchor, opens its local
// tag card editable; the main draft is not replaced, no job is created, and
// the original file bytes are unchanged. Cold reopen preserves tag + ink.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {mkdir, mkdtemp, copyFile, readFile, writeFile} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer-core';
import {observeProcessResources} from './process-resources.fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const ozone = process.env.NOZELI_OZONE || 'wayland';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Deterministic synthetic PNG (96×72 RGB gradient) — no fixture dependency.
function crc32(buffer) {
  let table = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  let crc = -1;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
  return Buffer.concat([length, Buffer.from(type), data, crc]);
}
function pngBytes(width, height) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (1 + width * 3) + 1 + x * 3;
    raw[offset] = (x * 4) % 256; raw[offset + 1] = (y * 5) % 256; raw[offset + 2] = ((x + y) * 3) % 256;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const output = await mkdtemp(path.join(root, '.test-output', 'selection-drawing-discussion-'));
const project = path.join(output, 'project');
await mkdir(project, {recursive: true});
const files = {image: 'shot.png', pdf: 'sample.pdf', ppt: 'deck.pptx'};
await writeFile(path.join(project, files.image), pngBytes(96, 72));
await copyFile(path.resolve(root, 'tests/fixtures/pdf/nozeli-sample.zh.pdf'), path.join(project, files.pdf));
await copyFile(path.resolve(root, 'tests/fixtures/ppt/compatibility.pptx'), path.join(project, files.ppt));
const originalDigests = {};
for (const [kind, rel] of Object.entries(files)) originalDigests[kind] = sha256(await readFile(path.join(project, rel)));

const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const report = {output, port, project, checks: [], scenes: [], cold: [], errors: [], notCovered: ['Real model turn / tag.material delivery (explicit send is out of scope here)', 'Other platforms']};
let child, browser, shell, log = '', exit;
const savedDraft = {};
const REGULAR_RESOURCES=process.env.NOZELI_REGULAR_RESOURCES==='1';let resourceSampler=null;
async function stopResources(){if(!resourceSampler)return;(report.regularResources??=[]).push(await resourceSampler.stop());resourceSampler=null;}
async function regularIdle(label,seconds){if(!REGULAR_RESOURCES)return;resourceSampler.mark(label);console.log(JSON.stringify({phase:label,seconds,output}));await pause(seconds*1000);}
async function mark(stage){report.stage=stage;await writeFile(path.join(output,'progress.json'),JSON.stringify({stage,checks:report.checks,scenes:report.scenes,errors:report.errors},null,2));console.log(JSON.stringify({stage,output}));}

// ---- Opt-in responsiveness profiling (NOZELI_RESPONSIVENESS=1). ----------------------------
// Default runs are unchanged: profile() is a pass-through unless the flag is set, and it only
// wraps existing awaits with the shared test helper (no browser/IPC/clock overrides).
const PROFILE = process.env.NOZELI_RESPONSIVENESS === '1';
const responsiveness = {records: [], profilerErrors: [], nodeElapsedMs: {}};
let measureResponsiveness, summarizeResponsiveness, observeProcessMemory;
if (PROFILE) ({measureResponsiveness, summarizeResponsiveness, observeProcessMemory} = await import('./responsiveness-metrics.fixture.mjs').catch(error => {
  throw Error('NOZELI_RESPONSIVENESS=1 requires tests/responsiveness-metrics.fixture.mjs: ' + error.message);
}));
async function profile(context, label, action) {
  if (!PROFILE) return action();
  const started = performance.now(), before = responsiveness.records.length;
  try {
    const returned = await measureResponsiveness(context, label, action, responsiveness.records);
    if(responsiveness.records.length===before)throw Error('responsiveness helper produced no record for '+label);
    return returned;
  } catch (error) {
    if (responsiveness.records.length > before && responsiveness.records.at(-1)?.label === label) responsiveness.records.at(-1).profilerError = String(error?.message || error);
    responsiveness.profilerErrors.push({label, error: String(error?.stack || error)});
    throw error;
  } finally {
    if (responsiveness.records.length > before) responsiveness.nodeElapsedMs[label] = Math.round(performance.now() - started);
  }
}
const isColdLabel = label => /cold|restart|shutdown/i.test(label);
async function attachResponsiveness(extra = {}) {
  if (!PROFILE) return;
  const by = fn => { const map = {}; for (const r of responsiveness.records) (map[fn(r.label)] ??= []).push(r); return map; };
  const group = rows => rows.length ? summarizeResponsiveness(rows) : null;
  report.responsiveness = {
    enabled: true, flag: 'NOZELI_RESPONSIVENESS=1', measurements: responsiveness.records.length,
    summaries: {overall: group(responsiveness.records), cold: group(responsiveness.records.filter(r => isColdLabel(r.label))), warm: group(responsiveness.records.filter(r => !isColdLabel(r.label)))},
    phases: Object.fromEntries(Object.entries(by(l => l.split('/')[0])).map(([k, v]) => [k, summarizeResponsiveness(v)])),
    records: responsiveness.records, nodeElapsedMsByLabel: responsiveness.nodeElapsedMs,
    errors: {renderer: report.errors, profiler: responsiveness.profilerErrors, ...extra},
    limits: ['Node elapsedMs includes CDP round trips and wait polling; it is not pure paint latency.', 'Linux Wayland software rendering, single display; other platforms out of scope.', 'Heap/DOM columns are descriptive observations, not a leak verdict; no leak absence is claimed.', 'No hard performance thresholds are asserted; p50/p95/max are reported for human comparison.'],
  };
  // Profiler results are recorded in report.json as well as the driver's own result.json.
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report.responsiveness, null, 2));
}

function launch() {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)) delete env[key];
  Object.assign(env, {
    NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output,'.Nozeli','desktop'), NOZELI_CONFIG_ROOT:path.join(output,'.Nozeli'), NOZELI_TEST_PICK: project,
    NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_OZONE: ozone,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1000',
  });
  const childProcess = spawn(binary, [...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(root, 'src/main/main.cjs')]), '--ozone-platform=' + ozone], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
  if(REGULAR_RESOURCES)resourceSampler=observeProcessResources(childProcess.pid);
  childProcess.on('error', error => { log += 'spawn-error: ' + error.stack; });
  for (const stream of [childProcess.stdout, childProcess.stderr]) stream.on('data', chunk => { log += chunk; });
  return childProcess;
}
async function connect() {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Product exited during startup:\n' + log.slice(-4000));
    try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) break; } catch {}
    if (Date.now() > deadline) throw Error('startup timeout:\n' + log.slice(-4000));
    await pause(100);
  }
  browser = await puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null,protocolTimeout:20000});
  browser.on('targetcreated',target=>{void target.page().then(page=>page?.on('pageerror',error=>report.errors.push(error.stack||error.message))).catch(()=>{});});
}
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  do {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw Error('Product exited (' + label + '):\n' + log.slice(-4000));
    const value = await fn();
    if (value) return value;
    await pause(80);
  } while (Date.now() < end);
  throw Error('Timeout: ' + label);
}
const call = async (page, op, payload = {}) => {
  const result = await page.evaluate((op, payload) => window.nozeli.invoke(op, payload), op, payload);
  assert.ok(result.ok, op + ': ' + JSON.stringify(result.error));
  return result.value;
};
async function closeProduct(){
  await stopResources();
  const normalExit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  await call(shell,'session.requestClose').catch(error=>{if(!/Target closed|Session closed|Connection closed|TargetCloseError/.test(error.name+': '+error.message))throw error;});
  const outcome=await Promise.race([normalExit,pause(15000).then(()=>null)]);
  assert.deepEqual(outcome,{code:0,signal:null},'normal product shutdown retains all document drafts');
  (report.normalExits??=[]).push(outcome);await browser.disconnect();return outcome;
}
const scopeOf = page => page.evaluate(() => ({scope: window.__workspaceScope || null, ready: window.__nozeliReady === true})).catch(() => null);

async function setupShell(knowProjectId) {
  shell = await until(async()=>{
    for (const page of await browser.pages()) {
      const state = await scopeOf(page);
      if(state?.ready&&state.scope?.role==='shell')return page;
    }
    return null;
  },'ready shell root');
  shell.on('pageerror', error => report.errors.push('shell: ' + error.message));
  await shell.waitForFunction(() => window.__nozeliReady === true);
  report.runtime={binary,userAgent:await browser.userAgent(),platform:process.platform,arch:process.arch,devicePixelRatio:await shell.evaluate(()=>devicePixelRatio)};
  if (await shell.$('#configuration-setup[open]')) {
    await shell.click('#configuration-cancel');
    await shell.waitForFunction(() => !document.querySelector('#configuration-setup').open);
  }
  if (knowProjectId) {
    await shell.waitForSelector('[data-project-id="'+knowProjectId+'"]',{visible:true});
    await shell.click('[data-project-id="'+knowProjectId+'"]');
  } else await shell.click('#pick-project');
  await until(async () => {
    const bootstrap = await shell.evaluate(async () => (await window.nozeli.invoke('workspace.bootstrap', {})).value).catch(() => null);
    return bootstrap?.projectId || null;
  }, 'project bound', 30000);
  return (await shell.evaluate(async () => (await window.nozeli.invoke('workspace.bootstrap', {})).value)).projectId;
}
async function documentPage(rel) {
  return until(async () => {
    for (const page of await browser.pages()) {
      const state = await scopeOf(page);
      if (!(state?.ready && state.scope?.role === 'surface' && state.scope.kind === 'document')) continue;
      if (state.scope.relPath === rel) return page;
      const shown = await page.evaluate(() => document.querySelector('#file-path')?.textContent?.trim()).catch(() => null);
      if (shown === rel) return page;
    }
    return null;
  }, 'document surface ' + rel, 30000);
}
async function openFile(rel) {
  await shell.waitForSelector('#file-tree button[data-path="' + rel + '"]', {visible: true});
  await shell.click('#file-tree button[data-path="' + rel + '"]');
  const page = await documentPage(rel);
  page.on('pageerror', error => report.errors.push(rel + ': ' + error.message));
  await until(async () => {
    const windows = await call(shell, 'workspace.windows.list', {projectId});
    return windows.some(w => w.surfaces.some(s => s.visible && s.bounds.width > 100 && s.bounds.height > 100));
  }, 'visible native content ' + rel, 30000);
  return page;
}
const pressed = async (page, selector) => (await page.$eval(selector, node => node.getAttribute('aria-pressed'))) === 'true';
async function drag(page, from, to) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], {steps: 14});
  await page.mouse.up();
}
async function regionSelect(page, kind) {
  await mark(kind+':content-tools');
  const button = {image: '#image-region', pdf: '#pdf-region', ppt: '#word-region'}[kind];
  if (kind === 'pdf') await page.waitForSelector('#pdf-host .textLayer span', {timeout: 40000});
  const {scope}=await scopeOf(page);
  await shell.click('.workspace-pane:has([data-view-id="'+scope.viewId+'"]) .workspace-pane-header',{button:'right'});
  await shell.waitForSelector('.nozeli-context-menu:not([hidden]) [data-command="tools"]',{visible:true});
  await shell.click('.nozeli-context-menu:not([hidden]) [data-command="tools"]');
  await page.waitForSelector('#document-context-menu:not([hidden]) [data-command="view"]',{visible:true});
  await page.click('#document-context-menu [data-command="view"]');
  await page.waitForSelector('.nozeli-submenu [data-command="region"]',{visible:true});
  await page.click('.nozeli-submenu [data-command="region"]');
  await until(() => pressed(page, button), 'region mode on ' + kind);
  await mark(kind+':region-geometry');
  if(kind==='pdf'){
    await page.waitForFunction(()=>{const node=document.querySelector('#pdf-host .pdf-page');if(!node)return false;const rect=node.getBoundingClientRect(),previous=window.__pdfRegionLayout,now=performance.now();if(!previous||previous.node!==node||previous.width!==rect.width||previous.height!==rect.height){window.__pdfRegionLayout={node,width:rect.width,height:rect.height,at:now};return false;}return now-previous.at>=250&&Boolean(node.querySelector('.textLayer span'));},{timeout:20000});
    await page.evaluate(()=>delete window.__pdfRegionLayout);
  }
  let box;
  if (kind === 'ppt') {
    const frame=await until(async()=>page.frames().find(candidate=>candidate.url().includes('/ppt-vendor/')),'PPT engine frame');
    await frame.waitForSelector('.canvas .viewport-wrapper',{visible:true});
    const inner=await frame.$eval('.canvas .viewport-wrapper',node=>node.getBoundingClientRect().toJSON());
    const frameRect=await page.$eval('#ppt-frame',node=>node.getBoundingClientRect().toJSON());
    box={x:frameRect.x+inner.x,y:frameRect.y+inner.y,width:inner.width,height:inner.height};
  } else {
    const selector = kind === 'image' ? '#image-host .image-page' : '#pdf-host .pdf-page';
    await page.waitForSelector(selector, {visible: true, timeout: 40000});
    box = await page.$eval(selector, node => { const r = node.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height}; });
  }
  const originalBox=box;
  box=await page.evaluate(rect=>{const x=Math.max(0,rect.x),y=Math.max(0,rect.y);return{x,y,width:Math.min(innerWidth,rect.x+rect.width)-x,height:Math.min(innerHeight,rect.y+rect.height)-y};},box);
  const point = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  await mark(kind+':region-gesture');
  const from=point(.25,.3),to=point(.65,.6);
  const geometry={rect:[(from[0]-originalBox.x)/originalBox.width,(from[1]-originalBox.y)/originalBox.height,(to[0]-from[0])/originalBox.width,(to[1]-from[1])/originalBox.height],tolerance:[2/originalBox.width,2/originalBox.height,2/originalBox.width,2/originalBox.height]};
  if(kind==='ppt'){const frame=page.frames().find(candidate=>candidate.url().includes('/ppt-vendor/'));geometry.slideId=await frame.evaluate(()=>{const store=window.__nozeliPptist.store;return store.slides[store.slideIndex].id;});}
  (report.regions??={})[kind]=geometry;
  const dragContext = kind === 'ppt' ? page.frames().find(candidate => candidate.url().includes('/ppt-vendor/')) : page;
  await profile(dragContext, kind + '/region-gesture', () => drag(page, from, to));
  await profile(page, kind + '/region-menu', async () => {
    await page.waitForSelector('#selection-menu:not([hidden])', {visible: true, timeout: 15000});
    await page.waitForSelector('#selection-draw:not([hidden])', {visible: true});
  });
  report.scenes.push({stage: 'region-selected', kind});
}
async function drawAndFinish(page, kind, host) {
  await mark(kind+':drawing');
  await profile(page, kind + '/editor-entry', async () => {
    await page.click('#selection-draw');
    await page.waitForSelector('#region-drawing:not([hidden])', {visible: true, timeout: 20000});
  });
  const area = await page.$eval('#region-drawing .drawing-area', node => { const r = node.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height}; });
  const inkCount=expected=>page.waitForFunction(expected=>document.querySelectorAll('#region-drawing .drawing-area svg polyline').length===expected,{},expected);
  await profile(page, kind + '/pen-stroke', async () => {
    await page.click('#drawing-pen');
    await drag(page, [area.x + area.width * .2, area.y + area.height * .3], [area.x + area.width * .7, area.y + area.height * .6]);
    await inkCount(1);
  });
  await profile(page, kind + '/undo-redo-eraser', async () => {
    await page.click('#drawing-undo');await inkCount(0);
    await page.click('#drawing-redo');await inkCount(1);
    await page.click('#drawing-eraser');await page.mouse.click(area.x+area.width*.2,area.y+area.height*.3);await inkCount(0);
    await page.click('#drawing-undo');await inkCount(1);await page.click('#drawing-pen');
  });
  await page.screenshot({path: path.join(output, 'ink-' + kind + '.png')});
  let existingQuestion='';
  if(kind==='image'){
    await mark('image:unfinished-selection-restart');await closeProduct();
    child=launch();await connect();await setupShell(projectId);page=await openFile(files.image);
    await profile(page, 'image/unfinished-restart-offer', () => page.waitForSelector('#note-form:not([hidden]) #note-resume-drawing:not([hidden])',{visible:true}));
    existingQuestion='进入涂鸦前已有的选区问题。';const mod=process.platform==='darwin'?'Meta':'Control';
    await page.click('#note-input');await page.keyboard.down(mod);await page.keyboard.press('a');await page.keyboard.up(mod);await page.keyboard.type(existingQuestion);
    await profile(page, 'image/unfinished-resume-editor', async () => {
      await page.click('#note-resume-drawing');await page.waitForSelector('#region-drawing:not([hidden]) .drawing-area',{visible:true});await inkCount(1);
    });
  }
  await mark(kind+':discussion-card');
  await profile(page, kind + '/finish-card', async () => {
    await page.click('#drawing-finish');
    // The marker span has no box; the actual discussion editor must be visible.
    await page.waitForSelector(host + ' .note-anchor.tag-discuss .tag-editor:not([hidden])', {visible: true, timeout: 15000});
  });
  const tagId = await page.$eval(host + ' .note-anchor.tag-discuss', node => node.dataset.annotation);
  assert.equal(await page.$eval(host+' .note-anchor.tag-discuss .tag-editor',node=>node.value),existingQuestion,'existing selection question transfers before consuming the old draft');
  await page.click(host + ' .note-anchor.tag-discuss .tag-editor');
  await page.keyboard.press('End');
  await page.keyboard.type('本地讨论草稿 ' + kind);
  const typed = await page.$eval(host + ' .note-anchor.tag-discuss .tag-editor', node => node.value);
  const expectedQuestion=existingQuestion+'本地讨论草稿 '+kind;
  assert.equal(typed,expectedQuestion,'local tag card editor preserves prior text and accepts new text '+kind);
  assert.equal(await page.$eval('#selection-menu', node => node.hidden), true, 'selection menu closed after finish ' + kind);
  report.scenes.push({stage: 'discussion-card', kind, tagId});
  return {page,tagId,expectedQuestion};
}
const drawingOf = record => record.information?.drawing || record.projection?.drawing || null;
const assetOf = (record, role) => (record.information?.assets || []).find(asset => asset.role === role) || null;

async function assertTagPersisted(rel, kind, expectedTagId, expectedQuestion) {
  const tag=await until(async()=>{
    const {annotations}=await call(shell,'annotation.list',{projectId,relPath:rel});
    const discussions=annotations.filter(record=>record.projection?.kind==='discuss');
    if(!discussions.length)return null;
    assert.equal(discussions.length,1,'exactly one discuss tag for '+rel);
    const value=discussions[0];return expectedQuestion===undefined||(value.projection.draftText||value.projection.text||'')===expectedQuestion?value:null;
  },'persisted local discussion question '+rel);
  if (expectedTagId) assert.equal(tag.id, expectedTagId, 'same tag id across reopen ' + rel);
  assert.equal(tag.kind, kind + '-region', 'anchor kind ' + rel);
  assert.equal(tag.resolution?.locationStatus, 'exact', 'exact original anchor ' + rel);
  const expected=report.regions[kind];assert.equal(tag.anchor.rects.length,1,'one physical rectangle is bound to the tag');
  for(let i=0;i<4;i++)assert(Math.abs(tag.anchor.rects[0][i]-expected.rect[i])<=expected.tolerance[i],'stored anchor matches the actual visible selection '+rel);
  if(kind==='ppt')assert.equal(tag.anchor.slideId,expected.slideId,'the tag belongs to the visible selected slide');
  const drawing = drawingOf(tag);
  assert.equal(drawing?.strokes?.length,1,'the complete physical stroke is persisted '+rel);
  const region = assetOf(tag, 'region-screenshot'), annotated = assetOf(tag, 'annotated-region');
  const raw=await readFile(path.join(project,region.relPath)),painted=await readFile(path.join(project,annotated.relPath));
  assert.equal(sha256(raw),region.digest);assert.equal(sha256(painted),annotated.digest);assert.notDeepEqual(painted,raw,'the persisted composite contains the drawn modification '+rel);
  if (kind === 'image') assert.equal(tag.anchor.space, 'image-normalized', 'image normalized anchor');
  if (kind === 'pdf') assert.equal(tag.anchor.space, 'rendered-page-normalized', 'pdf page anchor');
  if (kind === 'ppt') assert.ok(tag.anchor.slideId && Array.isArray(tag.anchor.rects), 'ppt slide anchor');
  return {tagId: tag.id, drawing: JSON.stringify(drawing.strokes), region: region.digest, annotated: annotated.digest,question:tag.projection.draftText||tag.projection.text||''};
}
async function assertNoDraftNoJob(label) {
  const {layout: projectLayout} = await call(shell, 'workspace.snapshot', {projectId});
  const conversation = Object.values(projectLayout.views).find(view => view.kind === 'conversation');
  const materials = conversation?.viewState?.conversationMaterials?.frontdesk;
  assert.ok(!materials?.pending?.length && !materials?.deliveredDrawingIds?.length, 'no drawing material entered the main draft ' + label);
  assert.ok(!conversation?.viewState?.conversationInput?.text, 'conversation draft text untouched ' + label);
  const status = await call(shell, 'managed.status', {projectId});
  assert.equal((status.state?.jobs || []).length, 0, 'no job created ' + label);
  assert.equal((status.state?.agents || []).length, 0, 'no agent admitted ' + label);
}

let projectId;
try {
  await mark('launch');
  child = launch();
  await connect();
  projectId = await setupShell(null);
  report.projectId = projectId;

  for (const [kind, rel] of Object.entries(files)) {
    const host = {image: '#image-host', pdf: '#pdf-host', ppt: '#word-host'}[kind];
    await mark(kind+':open-file');
    if(REGULAR_RESOURCES)resourceSampler.mark('open-'+kind);
    let page = await profile(shell, 'open/' + kind, () => openFile(rel));
    const pptFrame=kind==='ppt'?await until(async()=>page.frames().find(frame=>frame.url().includes('/ppt-vendor/')),'ready PPT model frame'):null;
    if(pptFrame)await profile(pptFrame, 'ppt/frame-ready', () => pptFrame.waitForFunction(()=>window.__nozeliPptist?.ready));
    const pptBefore=pptFrame?await pptFrame.evaluate(()=>JSON.stringify(window.__nozeliPptist.store.slides)):null;
    if(REGULAR_RESOURCES){
      await page.bringToFront();await regularIdle('reading-idle-'+kind,20);
      if(kind==='pdf'){resourceSampler.mark('reading-scroll-pdf');await profile(page,'regular PDF reading scroll',async()=>{await page.mouse.move(400,350);for(let step=0;step<6;step++){await page.mouse.wheel({deltaY:step<3?180:-180});await pause(400);}});}
      resourceSampler.mark('annotation-'+kind);
    }
    await regionSelect(page, kind);
    const finished = await drawAndFinish(page, kind, host);page=finished.page;const tagId=finished.tagId;
    await mark(kind+':verify-persisted-tag');
    const persisted = await assertTagPersisted(rel, kind, tagId, finished.expectedQuestion);
    await assertNoDraftNoJob(kind);
    assert.equal(sha256(await readFile(path.join(project, rel))), originalDigests[kind], 'original bytes unchanged ' + rel);
    if(pptFrame)assert.equal(await pptFrame.evaluate(()=>JSON.stringify(window.__nozeliPptist.store.slides)),pptBefore,'region selection and drawing never edit underlying slide content');
    savedDraft[kind] = {rel, tagId, ...persisted};
    report.checks.push(kind + ': region select → pen → 完成 created one persisted discuss tag at the exact anchor, local card editable, no draft/job, original unchanged');
    await page.screenshot({path: path.join(output, 'tag-' + kind + '.png')}).catch(() => {});
  }

  // Cold reopen: same profile, same project — tag, ink and frozen bytes survive.
  await mark('cold-restart');
  exit=await closeProduct();
  log += '\n--- cold restart ---\n';
  child = launch();
  await connect();
  await setupShell(projectId);
  for (const [kind, saved] of Object.entries(savedDraft)) {
    const persisted = await profile(shell, 'cold/verify-' + kind, () => assertTagPersisted(saved.rel, kind, saved.tagId, saved.question));
    assert.equal(persisted.drawing, saved.drawing, 'ink strokes byte-identical after cold reopen ' + kind);
    assert.equal(persisted.region, saved.region, 'frozen region asset unchanged after cold reopen ' + kind);
    assert.equal(persisted.annotated, saved.annotated, 'annotated composite unchanged after cold reopen ' + kind);
    assert.equal(sha256(await readFile(path.join(project, saved.rel))), originalDigests[kind], 'original still unchanged after cold reopen ' + kind);
    report.cold.push({kind, tagId: persisted.tagId});
    if (kind === 'image') {
      const page = await profile(shell, 'cold/open-image', () => openFile(files.image));
      const tagSelector='#image-host .note-anchor[data-annotation="'+saved.tagId+'"]';
      await page.waitForSelector(tagSelector);
      await page.waitForSelector('#image-host .region-drawing-projection', {visible:true,timeout:15000});
      if(await page.$eval(tagSelector+' .tag-editor',node=>node.hidden))await page.click(tagSelector+' .note-index');
      await page.waitForSelector(tagSelector+' .tag-editor:not([hidden])',{visible:true});
      assert.equal(await page.$eval(tagSelector+' .tag-editor',node=>node.value),saved.question,'the original local question survives normal restart');
      await profile(page, 'cold/tag-card-edit', async () => {
        await page.click(tagSelector+' .tag-editor');
        await page.keyboard.type('重启后仍可编辑');
        const value = await page.$eval(tagSelector+' .tag-editor', node => node.value);
        assert.ok(value.includes('重启后仍可编辑'), 'cold tag card stays editable');
      });
      await page.screenshot({path: path.join(output, 'cold-image-tag.png')}).catch(() => {});
    }
  }
  report.checks.push('cold reopen: tag id, ink strokes, region and annotated assets preserved; image tag card still editable');
  await regularIdle('idle-after-format-reopen',30);
  await closeProduct();
  await attachResponsiveness({status: 'passed', exit});
  await writeFile(path.join(output, 'result.json'), JSON.stringify({...report, ok: true}, null, 2));
  console.log(JSON.stringify({ok: true, output, projectId, checks: report.checks, scenes: report.scenes.length}));
} catch (error) {
  report.failure = error.stack;
  await stopResources();
  report.pages=await Promise.all((await browser?.pages()||[]).map(async page=>page.evaluate(()=>({url:location.href,scope:window.__workspaceScope,ready:window.__nozeliReady,text:document.body?.innerText.slice(-1200)})).catch(error=>({error:error.message}))));
  await attachResponsiveness({status: 'failed', failure: report.failure});
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  await shell?.screenshot({path: path.join(output, 'failure-shell.png')}).catch(() => {});
  for (const page of await browser?.pages?.() || []) await page.screenshot({path: path.join(output, 'failure-page-' + (await scopeOf(page))?.scope?.relPath?.replace(/[^\w.-]/g, '_') + '.png')}).catch(() => {});
  console.error(error.stack);
  console.error('output: ' + output);
  process.exitCode = 1;
} finally {
  await stopResources();
  await browser?.disconnect();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000).then(() => child.kill('SIGKILL'))]);
  }
  await writeFile(path.join(output, 'electron.log'), log || '').catch(() => {});
}
