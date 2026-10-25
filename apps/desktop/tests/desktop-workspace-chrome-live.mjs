// Run serially from apps/desktop: node tests/desktop-workspace-chrome-live.mjs
// Installed run: NOZELI_TEST_APP_ROOT=/installation NOZELI_TEST_BINARY=/installation/nozeli
// All project bytes come from repository fixtures; no model request is submitted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {contentTool, openContentTools} from './native-content-tools.fixture.mjs';
import {configureNativeConversation} from './native-conversation-ready.fixture.mjs';

const source = path.resolve(import.meta.dirname, '..');
const appRoot = path.resolve(process.env.NOZELI_TEST_APP_ROOT || source);
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-workspace-chrome-'));
const project = path.join(out, 'Synthetic chrome'), config = path.join(out, '.Nozeli'), profile = path.join(config, 'desktop');
await fs.mkdir(project);
for (const [name, fixture] of [['paper.md', 'reading-report.txt'], ['comparison.txt', 'reading-report.txt'], ['sample.pdf', 'pdf/nozeli-sample.zh.pdf'], ['sample.pptx', 'ppt/compatibility.pptx']]) {
  await fs.copyFile(path.join(source, 'tests/fixtures', fixture), path.join(project, name));
}
const projectId = (await new DesktopHost(profile).pick(project)).project.id;
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const env = {...process.env};
for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/i.test(key)) delete env[key];
Object.assign(env, {NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: config, NOZELI_USER_DATA: profile, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_TEST_PICK: project});
const report = {out, checks: [], errors: []}, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, shell, log = '', launchError;
let cleanupConversation;
async function until(fn, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child && (child.exitCode !== null || child.signalCode)) throw Error('Electron exited: ' + log);
    const value = await fn(); if (value) return value;
    await pause(75);
  }
  throw Error('Timed out: ' + label);
}
async function call(page, op, payload = {}) {
  const result = await page.evaluate((op, payload) => window.nozeli.invoke(op, payload), op, payload);
  assert.equal(result.ok, true, op + ': ' + JSON.stringify(result.error)); return result.value;
}
async function scoped(predicate) {
  return until(async () => {
    for (const page of await browser.pages()) {
      const scope = await page.evaluate(() => window.__workspaceScope).catch(() => null);
      if (scope && predicate(scope) && await page.evaluate(() => window.__nozeliReady === true)) {
        page.on('pageerror', error => report.errors.push(error.message)); return {page, scope};
      }
    }
  }, 'ready native content');
}
const visible = (page, selector) => page.$$eval(selector, nodes => nodes.filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden').length);
async function openFile(relPath) {
  await shell.waitForSelector('#file-tree [data-path="' + relPath + '"]', {visible: true});
  await shell.click('#file-tree [data-path="' + relPath + '"]');
  return scoped(scope => scope.role === 'surface' && scope.projectId === projectId && scope.relPath === relPath && !scope.readOnly);
}
try {
  child = spawn(binary, [...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(appRoot, 'src/main/main.cjs')]), '--ozone-platform=' + (process.env.NOZELI_OZONE || 'wayland')], {cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe']});
  child.on('error', error => { launchError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; });
  await until(async () => { try { browser = await puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null}); return true; } catch { return false; } }, 'debug endpoint');
  shell = (await scoped(scope => scope.role === 'shell')).page;
  if (await shell.$eval('#configuration-setup', node => node.open)) {
    await shell.click('#configuration-independent');
    await shell.waitForFunction(() => !document.querySelector('#configuration-setup').open);
  }
  await shell.waitForFunction(()=>window.__nozeliReady&&window.__workspaceGroups?.snapshot());
  assert.equal(await visible(shell, '#workspace-layout-menu'), 0);
  report.checks.push('no top-level layout menu; layout actions use pane context menu');

  const doc = await openFile('paper.md'), page = doc.page, viewId = doc.scope.viewId;
  assert.equal(await shell.$eval('#project-name',node=>node.textContent),'Synthetic chrome');
  assert.equal(await shell.$eval('.nozeli-window-logo',node=>node.complete&&node.naturalWidth>0),true);
  assert.equal(await shell.$$eval('.workspace-toolbar',nodes=>nodes.length),0);
  await shell.locator('[data-window-action="maximize"]').click();await shell.locator('[data-window-action="maximize"]').click();
  await page.waitForSelector('#text-preview', {visible: true});
  assert.equal(await visible(page, '.desk-header'), 0);
  assert.equal(await visible(page, '#reader-bar'), 0);
  assert.equal(await visible(page, '.workspace-heading,.workspace-toolbar'), 0);
  assert.equal(await visible(page,'#workspace-open-conversation'),0);
  assert.equal(await visible(shell,'#workspace-open-conversation'),1);
  const launcherPosition=await shell.$eval('#workspace-open-conversation',node=>{const b=node.getBoundingClientRect();return {right:Math.round(innerWidth-b.right),bottom:Math.round(innerHeight-b.bottom)};});
  assert(launcherPosition.bottom>=0&&launcherPosition.bottom<12);
  await shell.click('[data-workspace-command="content-document-font-larger"]');
  await page.waitForFunction(()=>document.getElementById('font-size-label').textContent==='15px');
  await shell.click('[data-workspace-command="content-document-font-smaller"]');
  await page.waitForFunction(()=>document.getElementById('font-size-label').textContent==='14px');
  assert.equal(await shell.$$eval('.workspace-pane-title', nodes => nodes.filter(node => node.getClientRects().length && node.textContent.includes('paper.md')).length), 1);
  await openContentTools(shell, page, viewId);
  assert.equal(await page.$$eval('#document-context-menu [data-command]', nodes => nodes.some(node => /workspace|layout|split|maximize/.test(node.dataset.command))), false);
  await page.keyboard.press('Escape');
  await contentTool(shell, page, viewId, ['view', 'text-mode']);
  await page.waitForSelector('#text-host .cm-content', {visible: true});
  const fontBefore = await page.$eval('#font-size-label', node => node.textContent);
  await contentTool(shell, page, viewId, ['view', 'document-font', 'document-font-larger']);
  await page.waitForFunction(before => document.querySelector('#font-size-label').textContent !== before, {}, fontBefore);
  await contentTool(shell, page, viewId, ['history', 'compareFile']);
  await page.waitForSelector('#beside-dialog[open]', {visible: true});
  await page.waitForSelector('#beside-file option[value="comparison.txt"]');
  await page.select('#beside-file', 'comparison.txt');
  await page.click('#beside-open');
  await page.waitForSelector('#secondary-pane', {visible: true});
  await page.waitForFunction(() => document.querySelector('#secondary-path').textContent.includes('comparison.txt'));
  await page.click('#secondary-close');
  report.checks.push('one pane title; hidden content rows; native tools trigger editor, font and actual comparison');
  await shell.screenshot({path:path.join(out,'main-two-level-chrome.png')});
  await page.screenshot({path:path.join(out,'content-without-file-toolbar.png')});

  const original = await page.evaluate(() => __nozeliInput.text());
  await page.evaluate(() => { window.__chromeEditorNode = document.querySelector('#text-host .cm-editor'); __nozeliInput.select(0, 0); __nozeliInput.focus(); });
  await page.keyboard.type('CHROME_UNDO_SENTINEL ');
  await page.evaluate(() => __nozeliInput.select(2, 6));
  const beforeTransfer = await page.evaluate(() => ({text: __nozeliInput.text(), selection: __nozeliInput.selection()}));
  const bootstrap = await call(page, 'workspace.bootstrap');
  const surfaceBefore = (await call(shell, 'workspace.windows.list', {projectId})).flatMap(window => window.surfaces).find(surface => surface.viewId === viewId);
  await shell.click('.workspace-pane-header [data-workspace-command="floatOpen"]');
  const detached = await scoped(scope => scope.role === 'detached' && scope.projectId === projectId);
  await until(async () => (await call(page, 'workspace.bootstrap')).windowId === detached.scope.windowId, 'same content floated');
  assert.equal(await detached.page.$eval('#toast',n=>n.textContent.includes('IPC_DENIED')),false);
  assert.equal(await visible(detached.page, '.workspace-toolbar'), 0);
  assert.equal(await visible(detached.page, '#workspace-layout-menu'), 0);
  assert.equal(await visible(detached.page,'.workspace-pane-header button,.workspace-pane-header img'),0);
  assert.equal(await visible(detached.page,'#workspace-open-conversation'),0);
  assert.deepEqual(await shell.$eval('#workspace-open-conversation',node=>{const b=node.getBoundingClientRect();return {right:Math.round(innerWidth-b.right),bottom:Math.round(innerHeight-b.bottom)};}),launcherPosition);
  const titleAction=async(root,action)=>{await root.locator('.workspace-pane-header .workspace-pane-title').click({button:'right'});await root.waitForSelector('#workspace-title-menu:not([hidden]) [data-command="'+action+'"]');await root.locator('#workspace-title-menu:not([hidden]) [data-command="'+action+'"]').click();};
  await titleAction(detached.page,'maximize');await titleAction(detached.page,'maximize');
  const second=await openFile('comparison.txt');
  await shell.click('.workspace-pane-header [data-workspace-command="floatOpen"]');
  const other=await scoped(s=>s.role==='detached'&&s.projectId===projectId&&s.windowId!==detached.scope.windowId);
  const floatingWindows=(await call(shell,'workspace.windows.list',{projectId})).filter(w=>w.id!=='main');
  assert.equal(floatingWindows.length,2);assert(floatingWindows.every(w=>w.visible));
  assert.equal(await visible(other.page,'.workspace-pane-header button,.workspace-pane-header img'),0);
  await titleAction(other.page,'dock');
  await detached.page.screenshot({path:path.join(out,'detached-single-title.png')});
  await contentTool(detached.page, page, viewId, ['view', 'document-font', 'document-font-smaller']);
  const from=await detached.page.$eval('.workspace-pane-title',el=>{const b=el.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,sx:screenX,sy:screenY};});
  const target=await shell.$eval('.workspace-pane',el=>{const b=el.getBoundingClientRect();return {x:screenX+b.left+b.width/2,y:screenY+b.top+b.height/2};});
  await detached.page.mouse.move(from.x,from.y);await detached.page.mouse.down();
  await detached.page.mouse.move(from.x+20,from.y,{steps:4});
  const movedOrigin=await detached.page.evaluate(()=>({x:screenX,y:screenY}));
  await detached.page.mouse.move(target.x-movedOrigin.x,target.y-movedOrigin.y);
  await shell.waitForSelector('[data-drop-side]',{visible:true});
  await detached.page.mouse.up();
  await until(async () => (await call(page, 'workspace.bootstrap')).windowId === 'main', 'same content docked');
  assert.equal(await page.evaluate(() => document.querySelector('#text-host .cm-editor') === window.__chromeEditorNode), true);
  assert.deepEqual(await page.evaluate(() => ({text: __nozeliInput.text(), selection: __nozeliInput.selection()})), beforeTransfer);
  assert.equal((await call(page, 'workspace.bootstrap')).generation, bootstrap.generation);
  const surfaceAfter = (await call(shell, 'workspace.windows.list', {projectId})).flatMap(window => window.surfaces).find(surface => surface.viewId === viewId);
  assert.equal(surfaceAfter.webContentsId, surfaceBefore.webContentsId);
  await page.evaluate(() => __nozeliInput.focus());
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await page.waitForFunction(original => __nozeliInput.text() === original, {}, original);
  report.checks.push('detached has no global toolbar; float/dock retains editor, WebContents, selection and real undo stack');

  const pdf = await openFile('sample.pdf');
  await pdf.page.waitForSelector('.pdf-page canvas', {visible: true});
  assert.equal(await visible(pdf.page, '.desk-header,#reader-bar'), 0);
  const pages = Number(await pdf.page.$eval('#pdf-count', node => node.textContent));
  assert(pages >= 1);
  const destination = Math.min(2, pages);
  await contentTool(shell, pdf.page, pdf.scope.viewId, ['page']);
  await pdf.page.waitForSelector('#document-page-dialog[open]', {visible: true});
  await pdf.page.click('#document-page-dialog input', {clickCount: 3});
  await pdf.page.keyboard.down('Control');await pdf.page.keyboard.press('a');await pdf.page.keyboard.up('Control');
  await pdf.page.type('#document-page-dialog input', String(destination));
  await pdf.page.click('#document-page-dialog button[type="submit"]');
  report.pdfJump=await pdf.page.evaluate(destination=>({destination,input:document.querySelector('#document-page-dialog input')?.value,max:document.querySelector('#document-page-dialog input')?.max,valid:document.querySelector('#document-page-dialog input')?.checkValidity(),open:document.querySelector('#document-page-dialog')?.open,current:document.querySelector('#pdf-page')?.value}),destination);
  await pdf.page.waitForFunction(value => Number(document.querySelector('#pdf-page').value) === value, {}, destination);
  const widthBefore = await pdf.page.$eval('.pdf-page', node => node.getBoundingClientRect().width);
  await shell.click('[data-workspace-command="content-zoom-in"]');
  await pdf.page.waitForFunction(width => document.querySelector('.pdf-page').getBoundingClientRect().width > width, {}, widthBefore);
  await shell.click('[data-workspace-command="content-zoom-out"]');
  await pdf.page.waitForFunction(width => document.querySelector('.pdf-page').getBoundingClientRect().width < width, {}, widthBefore * 1.19);
  report.checks.push('PDF page command opens a visible validated dialog and zoom commands operate without hidden toolbar');
  const ppt=await openFile('sample.pptx');
  await ppt.page.waitForFunction(()=>document.querySelector('#ppt-frame')?.contentWindow?.__nozeliPptist?.ready===true,{timeout:60000});
  await shell.click('[data-workspace-command="content-region"]');
  await ppt.page.waitForFunction(()=>document.querySelector('#ppt-frame').contentDocument.documentElement.style.cursor==='crosshair');
  await shell.click('[data-workspace-command="content-region"]');
  await ppt.page.waitForFunction(()=>document.querySelector('#ppt-frame').contentDocument.documentElement.style.cursor==='');
  report.checks.push('PPT content menu controls the real iframe annotation region mode without a duplicate file toolbar');

  const targetPane=await shell.$$eval('.workspace-pane',els=>els.at(-1).dataset.workspaceGroup);
  await shell.locator('[data-workspace-group="'+targetPane+'"] .workspace-pane-title').click();
  cleanupConversation=await configureNativeConversation(shell);
  await until(async()=>(await call(shell,'managed.status',{projectId})).ready,'real native conversation owner ready');
  await shell.click('#workspace-open-conversation');
  const chat = await scoped(scope => scope.role === 'surface' && scope.kind === 'conversation' && scope.projectId === projectId);
  await chat.page.waitForSelector('#conversation-head', {visible: true});
  const conversationId = (await call(chat.page, 'workspace.bootstrap')).viewId;
  assert.equal(await shell.$eval('[data-view-id="'+conversationId+'"]',el=>el.closest('[data-workspace-group]').dataset.workspaceGroup),targetPane);
  await shell.waitForFunction(id => !document.querySelector(`[data-editor-view="${id}"]`), {}, conversationId);
  await shell.screenshot({path:path.join(out,'opened-project-separator.png')});
  assert.equal(await visible(chat.page, '#conversation-head'), 1);
  assert.equal(await visible(shell, '.workspace-pane:has([data-view-id="'+conversationId+'"]) .workspace-pane-header'), 0);
  await chat.page.click('#conversation-head',{button:'right'});
  await chat.page.waitForSelector('#conversation-context-menu:not([hidden])', {visible: true});
  const actions = await chat.page.$$eval('#conversation-context-menu [data-command^="chat-workspace-"]', nodes => nodes.map(node => node.dataset.command).sort());
  assert.deepEqual(actions, ['chat-workspace-close', 'chat-workspace-detach','chat-workspace-split-x','chat-workspace-split-y']);
  await chat.page.keyboard.press('Escape');
  await chat.page.evaluate(()=>{window.__splitComposer=document.querySelector('#composer');});
  for(const axis of ['x','y']){
    const splitRevision=(await call(shell,'workspace.snapshot',{projectId})).layout.revision;
    await chat.page.locator('#composer').click({button:'right'});
    await chat.page.locator('#conversation-context-menu:not([hidden]) [data-command="chat-workspace-split-'+axis+'"]').click();
    await until(async()=>{const l=(await call(shell,'workspace.snapshot',{projectId})).layout;return l.revision>splitRevision&&await shell.$$eval('.workspace-divider',(nodes,axis)=>nodes.some(n=>n.parentElement.dataset.axis===axis),axis);},'conversation context split '+axis);
    assert.equal(await chat.page.evaluate(()=>document.querySelector('#composer')===window.__splitComposer),true);
    assert.equal(Object.values((await call(shell,'workspace.snapshot',{projectId})).layout.views).filter(v=>v.kind==='conversation').length,1);
  }
  assert.equal(await visible(chat.page, '#chat-clear-frontdesk-context'), 0);
  await chat.page.click('[data-chat-window-action="chat-workspace-close"]');
  await shell.waitForSelector('#workspace-open-conversation.conversation-minimized',{visible:true});
  assert.equal(Object.values((await call(shell,'workspace.snapshot',{projectId})).layout.views).find(v=>v.kind==='conversation').id,conversationId);
  const bottom=await shell.$eval('#workspace-open-conversation',node=>({bottom:node.getBoundingClientRect().bottom,height:innerHeight}));assert(bottom.height-bottom.bottom<12);
  await shell.click('#workspace-open-conversation');
  const restoredChat=await scoped(s=>s.kind==='conversation'&&s.viewId===conversationId);
  await restoredChat.page.waitForSelector('[data-chat-window-action="chat-workspace-detach"]',{visible:true});
  const beforeConversationSplit=(await call(shell,'workspace.snapshot',{projectId})).layout;
  await call(shell,'workspace.command',{projectId,expectedRevision:beforeConversationSplit.revision,requestKey:crypto.randomUUID(),command:{type:'split',groupId:await shell.$eval('[data-view-id="'+conversationId+'"]',el=>el.closest('[data-workspace-group]').dataset.workspaceGroup),axis:'x',side:'after'}});
  await shell.waitForSelector('.workspace-pane-title',{visible:true});
  const alternatePane=await shell.$$eval('.workspace-pane',els=>els.find(el=>el.querySelector('.workspace-pane-title'))?.dataset.workspaceGroup);
  assert(alternatePane);assert.notEqual(alternatePane,targetPane);
  await restoredChat.page.evaluate(()=>{window.__paneComposer=document.querySelector('#composer');});
  await shell.locator('[data-workspace-group="'+alternatePane+'"] .workspace-pane-title').click();await shell.click('#workspace-open-conversation');
  await shell.waitForFunction(({id,group})=>document.querySelector('[data-view-id="'+id+'"]')?.closest('[data-workspace-group]')?.dataset.workspaceGroup===group,{}, {id:conversationId,group:alternatePane});
  assert.equal(await restoredChat.page.evaluate(()=>document.querySelector('#composer')===window.__paneComposer),true);
  assert.equal(Object.values((await call(shell,'workspace.snapshot',{projectId})).layout.views).filter(v=>v.kind==='conversation').length,1);
  report.checks.push('new and existing unique conversation open in the clicked active pane; existing live composer is moved, not copied');
  report.checks.push('minimal conversation header; close minimizes to sole bottom launcher and restores same conversation identity');
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  report.failure = error.stack;
  for(const p of await browser?.pages()||[]){const scope=await p.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope?.kind==='document'&&scope.relPath==='sample.pdf')await p.screenshot({path:path.join(out,'failure-pdf.png')}).catch(()=>{});}
  if (shell && !shell.isClosed()) await shell.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  throw error;
} finally {
  await browser?.disconnect();
  if (child && child.exitCode === null && child.signalCode === null) { const stopped=new Promise(resolve=>child.once('exit',resolve)); child.kill('SIGTERM'); await pause(1000); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await stopped; }
  await cleanupConversation?.();
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(out, 'main.log'), log);
  console.log(JSON.stringify(report, null, 2));
}
