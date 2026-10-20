import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'conversation-controls-'));
const root = path.join(output, 'app');
await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) await cp(path.join(source, item), path.join(root, item), { recursive: true });
for(const item of ['node_modules','vendor','assets'])await symlink(path.join(source,item),path.join(root,item),'dir');
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
  env: { ...process.env, WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000', NOZELI_TEST_INSTANCE: '1', NOZELI_SHOT_DIR: output, NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => child.once('exit', resolve));
let log = '', browser, page;
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
const report = { checks: [], errors: [] };
async function resize(width,height){const result=await page.evaluate(({width,height})=>nozeli.invoke('session.resize',{width,height}),{width,height});assert(result.ok,JSON.stringify(result));await page.waitForFunction(width=>innerWidth===width&&document.querySelector('#app').classList.contains('narrow-layout')===(width<=1000),{},width);}
try {
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw new Error(log);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Startup timeout: ' + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport:null });
  page = (await browser.pages()).find(page => page.url().includes('127.0.0.1'));
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.__nozeliReady);
  await resize(1440,900);
  await page.click('#pick-project'); if (await page.waitForSelector('#agent-setup[open]', { timeout: 4000 }).catch(() => null)) await page.click('#agent-skip');
  await page.click('#file-tree button[data-path="sample.md"]');
  await page.waitForFunction(() => !document.querySelector('#text-preview').hidden);
  await page.type('#composer', 'Draft remains unchanged');
  await page.evaluate(() => { window.__controlsComposer = document.querySelector('#composer'); window.__controlsHistory = document.querySelector('#conversation'); });
  const preserve = async name => {
    assert.equal(await page.evaluate(() => window.__controlsComposer === document.querySelector('#composer') && window.__controlsHistory === document.querySelector('#conversation') && document.querySelector('#composer').value === 'Draft remains unchanged' && document.querySelector('#file-path').textContent === 'sample.md'), true, name);
  };
  let menuFocus;
  const isVisible=selector=>page.$eval(selector,n=>n.getBoundingClientRect().width>0);
  const menuSelector='#chat-layout-menu:popover-open,.nozeli-submenu';
  const open = async () => {
    await new Promise(resolve=>setTimeout(resolve,150));
    menuFocus=await page.evaluateHandle(()=>document.activeElement);
    if(await isVisible('#chat-layout')){await page.click('#chat-layout summary');await page.waitForFunction(()=>document.querySelector('#chat-layout-menu').matches(':popover-open'));}
    else {await page.click('#chat-more');await page.waitForSelector('#conversation-context-menu:not([hidden])');await page.click('#conversation-context-menu [data-command=chat-docking]');await page.waitForSelector('.nozeli-submenu');}
  };
  const dockCommand=async dock=>{const visible=await isVisible('#chat-layout');await page.click(visible?'#chat-layout-menu [data-dock="'+dock+'"]':'.nozeli-submenu [data-command="chat-dock-'+dock+'"]');};
  const panelAction=async(selector,command)=>{if(await isVisible(selector))await page.click(selector);else{await page.click('#chat-more');await page.waitForSelector('#conversation-context-menu:not([hidden])');await page.click('#conversation-context-menu [data-command="'+command+'"]');}};
  const inspectMenu = async () => page.evaluate(() => {
    const menu = document.querySelector('#chat-layout-menu:popover-open,.nozeli-submenu'), r = menu.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight, hit: [...menu.querySelectorAll('button')].every(button => { const b = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); }), selected: menu.querySelector('[aria-checked="true"]')?.dataset.dock||menu.querySelector('[aria-checked="true"]')?.dataset.command?.replace('chat-dock-','') };
  });
  for (const dock of ['top', 'right', 'left', 'bottom']) {
    await open();
    const bounds = await inspectMenu();
    assert.ok(bounds.hit && bounds.x >= 6 && bounds.y >= 6 && bounds.right <= bounds.width - 6 && bounds.bottom <= bounds.height - 6, JSON.stringify(bounds));
    await dockCommand(dock);
    assert.equal(await page.$eval('#work-surface', node => node.dataset.dock), dock);
    assert.equal(await page.$eval('#chat-layout-menu', node => node.matches(':popover-open')), false);
    await preserve(dock);
    report.checks.push(`${dock}: pointer docking and draft/DOM preservation`);
  }
  await open(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.$eval('#work-surface', node => node.dataset.dock), 'right');
  await open(); assert.equal((await inspectMenu()).selected, 'right');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(previous => document.activeElement===previous||document.activeElement===document.querySelector('#chat-layout summary'),menuFocus), true);
  await open(); await page.click('#file-filter');
  assert.equal(await page.$eval('#chat-layout-menu', node => node.matches(':popover-open')), false);
  report.checks.push('keyboard navigation, selected state, Escape focus and outside dismissal');
  await panelAction('#float-conversation','chat-floating');
  await page.waitForFunction(() => document.querySelector('#conversation-panel').classList.contains('floating'));
  const floating = await page.$eval('#conversation-panel', node => node.getBoundingClientRect().toJSON());
  await panelAction('#chat-maximize','chat-expand');
  assert.equal(await page.$eval('#work-surface', node => node.classList.contains('chat-expanded')), true);
  assert.equal(await page.$eval('#documents', node => getComputedStyle(node).display), 'none');
  assert.equal(await page.$eval('#reader > .desk-header',node=>getComputedStyle(node).display),'none','full conversation must hide document title and commands');
  await preserve('maximize');
  await page.screenshot({ path: path.join(output, 'maximized-1440.png') });
  await panelAction('#chat-maximize','chat-expand');
  assert.notEqual(await page.$eval('#reader > .desk-header',node=>getComputedStyle(node).display),'none','restored document shows its own header');
  const restored = await page.$eval('#conversation-panel', node => node.getBoundingClientRect().toJSON());
  assert.ok(Math.abs(restored.width - floating.width) < 1 && Math.abs(restored.height - floating.height) < 1 && Math.abs(restored.x - floating.x) < 1 && Math.abs(restored.y - floating.y) < 1);
  report.checks.push('floating maximize/restore retains exact window bounds and document');
  await page.focus('#chat-resize');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowUp');
  await page.focus('#conversation-head');
  for (let i = 0; i < 85; i++) await page.keyboard.press('ArrowDown');
  await open();
  const edge = await inspectMenu(); assert.ok(edge.hit && edge.bottom <= edge.height - 7, JSON.stringify(edge));
  assert.ok(edge.bottom < await page.evaluate(()=>{const n=document.querySelector('#chat-layout');return (n.getBoundingClientRect().width?n.querySelector('summary'):document.querySelector('#chat-more')).getBoundingClientRect().top;}), 'bottom-edge menu must flip above its anchor');
  await page.screenshot({ path: path.join(output, 'bottom-edge-menu-1440.png') });
  await page.keyboard.press('Escape');
  report.checks.push('bottom-edge floating menu opens above and all entries remain clickable');
  for (const width of [800, 390]) {
    await resize(width,width===390?844:900);
    await page.focus('#conversation-head');
    for (let i = 0; i < 85; i++) await page.keyboard.press('ArrowUp');
    await open(); const bounds = await inspectMenu();
    assert.ok(bounds.hit && bounds.x >= 6 && bounds.right <= bounds.width - 6 && bounds.y >= 6 && bounds.bottom <= bounds.height - 6, JSON.stringify(bounds));
    await page.screenshot({ path: path.join(output, `floating-menu-${width}.png`), fullPage: false });
    await page.keyboard.press('Escape'); await preserve(String(width));
    report.checks.push(`${width}: floating toolbar/menu stays usable in viewport`);
  }
  await page.click('#chat-minimize');
  assert.equal(await page.$eval('#conversation-panel', node => node.hidden), true);
  await page.click('#conversation-launcher'); await preserve('reopen');
  assert.equal(await page.$('#chat-focus-input'), null);
  await page.click('#composer');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'composer');
  await open(); if(await isVisible('#chat-layout'))await page.click('#chat-reset-layout');else await page.click('#conversation-context-menu [data-command=chat-reset-layout]'); await preserve('reset');
  assert.equal(await page.$eval('#work-surface', node => node.dataset.dock), 'bottom');
  assert.equal(await page.$eval('#conversation-panel', node => node.classList.contains('floating')), false);
  report.checks.push('minimize/reopen, direct composer focus and reset preserve content');
  await resize(1440,900);
  await page.waitForFunction(() => document.querySelector('#compose-status').textContent.includes('已保存'));
  await page.reload(); await page.waitForFunction(() => window.__nozeliReady);
  assert.equal(await page.$eval('#composer', node => node.value), 'Draft remains unchanged');
  await page.evaluate(() => { window.__controlsComposer = document.querySelector('#composer'); window.__controlsHistory = document.querySelector('#conversation'); });
  await page.click('#close-subject');
  await page.waitForSelector('#action-confirmation[open]');await page.click('#action-confirmation-accept');
  await page.waitForFunction(() => !document.querySelector('#empty').hidden);
  const emptyState = await page.evaluate(() => ({
    title: document.querySelector('#subject-title').textContent,
    documents: getComputedStyle(document.querySelector('#documents')).display,
    header: getComputedStyle(document.querySelector('#reader > .desk-header')).display,
    layoutMenu: getComputedStyle(document.querySelector('#chat-layout')).display,
    panelHidden: document.querySelector('#conversation-panel').hidden,
    launcherHidden: document.querySelector('#conversation-launcher').hidden,
    compact: document.querySelector('#conversation-panel').classList.contains('compact-composer'),
    sameComposer: window.__controlsComposer === document.querySelector('#composer'),
    draft: document.querySelector('#composer').value,
  }));
  assert.equal(emptyState.title, '未打开文件');
  assert.notEqual(emptyState.documents, 'none');
  assert.notEqual(emptyState.header, 'none', 'empty workspace keeps its own header');
  assert.notEqual(emptyState.layoutMenu, 'none', 'conversation layout controls stay available on the empty workspace');
  assert.equal(emptyState.panelHidden, false);
  assert.equal(emptyState.launcherHidden, true);
  assert.equal(emptyState.compact, true, 'reset layout keeps the compact bottom composer');
  assert.equal(emptyState.sameComposer, true);
  assert.equal(emptyState.draft, 'Draft remains unchanged');
  assert.equal(await page.$('#chat-focus-input'), null);
  await page.click('#composer'); assert.equal(await page.evaluate(() => document.activeElement.id), 'composer');
  await page.screenshot({ path: path.join(output, 'empty-workspace-1440.png') });
  report.checks.push('persisted draft survives reload; closing the last file shows the empty base layer with the user layout untouched');
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
