import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

// Real-Electron acceptance for the empty-workspace base layer: closing the last
// file (or every tab, or a report) must reveal #empty without touching the
// user's conversation layout, draft, composer node or background work.
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'empty-workspace-'));
const root = path.join(output, 'app');
await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) await cp(path.join(source, item), path.join(root, item), { recursive: true });
for (const item of ['node_modules', 'vendor', 'assets']) await symlink(path.join(source, item), path.join(root, item), 'dir');
const build = spawn(process.execPath, [path.join(root, 'tools/build-renderer.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let buildLog = '';
build.stdout.on('data', chunk => { buildLog += chunk; }); build.stderr.on('data', chunk => { buildLog += chunk; });
if (await new Promise(resolve => build.once('exit', resolve)) !== 0) { console.error(buildLog); process.exit(1); }

const projectA = path.join(output, 'project-a');
const projectB = path.join(output, 'project-b');
await mkdir(projectA); await mkdir(projectB);
for (const name of ['a.md', 'b.md', 'c.md']) await writeFile(path.join(projectA, name), `# ${name}\n\nReal document ${name}.\n`);
await writeFile(path.join(projectB, 'b-only.md'), '# B\n');

const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolve(chosen === 8876 ? 8877 : chosen)); }); });
const ozone = process.env.NOZELI_OZONE || 'wayland';
const spawnApp = debugPort => spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: projectA + '\n' + projectB, NOZELI_SHOT_DIR: output, NOZELI_DEBUG_PORT: String(debugPort), NOZELI_AGENT_FIXTURE: '1', NOZELI_AGENT_FIXTURE_REPLY: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail }); if (!ok) console.error('FAIL:', name, detail); };
const wait = async (page, fn, timeout = 15000, ...args) => page.waitForFunction(fn, { polling: 100, timeout }, ...args);
const settleConfirm = async page => { if (await page.waitForSelector('#action-confirmation[open]', { timeout: 1500 }).catch(() => null)) await page.click('#action-confirmation-accept'); };
const snap = page => page.evaluate(() => ({
  emptyHidden: document.querySelector('#empty').hidden,
  emptyTitle: document.querySelector('#empty-title')?.textContent,
  browseHidden: document.querySelector('#empty-browse')?.hidden,
  welcomeHidden: document.querySelector('#welcome-open')?.hidden,
  subject: document.querySelector('#subject-title').textContent,
  label: document.querySelector('#file-section-label').textContent,
  filePath: document.querySelector('#file-path').textContent,
  panelHidden: document.querySelector('#conversation-panel').hidden,
  launcherHidden: document.querySelector('#conversation-launcher').hidden,
  dock: document.querySelector('#work-surface').dataset.dock,
  floating: document.querySelector('#conversation-panel').classList.contains('floating'),
  compact: document.querySelector('#conversation-panel').classList.contains('compact-composer'),
  expanded: document.querySelector('#work-surface').classList.contains('chat-expanded'),
  documents: getComputedStyle(document.querySelector('#documents')).display,
  draft: document.querySelector('#composer').value,
  sameComposer: window.__emptyComposerRef === undefined ? null : window.__emptyComposerRef === document.querySelector('#composer'),
  closeHidden: document.querySelector('#close-subject').hidden,
  workItems: document.querySelector('#work-items').children.length,
  inbox: document.querySelector('#inbox-count').textContent,
  consoleHidden: document.querySelector('#provider-console').hidden,
}));
const layoutOf = state => ({ panelHidden: state.panelHidden, launcherHidden: state.launcherHidden, dock: state.dock, floating: state.floating, compact: state.compact, expanded: state.expanded });
const panelAction = async (page, selector, label) => {
  const visible = await page.evaluate(target => { const node = document.querySelector(target); return Boolean(node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0); }, selector);
  if (visible) { await page.click(selector); return; }
  await page.click('#chat-more');
  await page.waitForSelector('#conversation-context-menu:not([hidden])');
  await mouseClickText(page, '#conversation-context-menu', label);
};
const closeCurrent = async page => { await page.click('#close-subject'); await settleConfirm(page); };
const openFile = async (page, rel) => { await page.click(`#file-tree button[data-path="${rel}"]`); await wait(page, rel => document.querySelector('#empty').hidden && document.querySelector('#file-path').textContent === rel, 15000, rel); };
const resize = async (page, width, height) => { await page.evaluate(({ width, height }) => window.nozeli.invoke('session.resize', { width, height }), { width, height }); await page.setViewport({ width, height }); await wait(page, width => innerWidth === width, 15000, width); };
const mouseClickText = async (page, selector, text) => {
  const point = await page.$eval(selector, (node, text) => {
    const target = [...node.querySelectorAll('button')].find(button => button.textContent.includes(text));
    if (!target) return null;
    const box = target.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, text);
  if (!point) throw new Error(`no button "${text}" inside ${selector}`);
  await page.mouse.click(point.x, point.y);
};
const connectPage = async debugPort => {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: null, protocolTimeout: 120000 });
  const pages = await browser.pages();
  const page = pages.find(item => item.url().includes('127.0.0.1')) || pages.at(-1);
  page.on('pageerror', error => checks.push({ name: 'renderer error', ok: false, detail: error.message }));
  await wait(page, () => window.__nozeliReady === true, 30000);
  return { browser, page };
};

const debugPort = await port();
const child = spawnApp(debugPort);
let output2 = '';
child.stdout.on('data', chunk => { output2 += chunk; }); child.stderr.on('data', chunk => { output2 += chunk; });
const stopped = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
let page, browser;
try {
  const deadline = Date.now() + 30000;
  for (;;) { if (child.exitCode !== null || child.signalCode) throw new Error(`Electron exited ${child.exitCode}/${child.signalCode}: ${output2}`); try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break; } catch { /* booting */ } if (Date.now() > deadline) throw new Error('devtools timeout: ' + output2); await new Promise(resolve => setTimeout(resolve, 150)); }
  ({ browser, page } = await connectPage(debugPort));
  await resize(page, 1440, 900);
  const registered = await page.evaluate(directory => window.nozeli.invoke('project.pick', { directory }), projectA);
  const projectId = registered.value.project.id;
  const projectAName = registered.value.project.name;
  const projectState = path.join(output, 'profile', 'nozeli', 'v1', 'projects', projectId);
  await mkdir(projectState, { recursive: true });
  await writeFile(path.join(projectState, 'agent-binding.json'), JSON.stringify({ foreground: { provider: 'omp', permissionMode: 'inherit' }, background: { provider: 'claude', permissionMode: 'inherit' } }));
  await writeFile(path.join(projectState, 'agent-log.json'), JSON.stringify({ schemaVersion: 1, seq: 1, messages: [], requests: [], reports: [{ id: 'seeded-report', projectId, title: '关闭行为验证报告', success: true, text: 'REPORT-BODY 关闭报告后应回到空工作区。', status: 'completed' }] }));
  const projectBName = (await page.evaluate(directory => window.nozeli.invoke('project.pick', { directory }), projectB)).value.project.name;
  const welcome = await snap(page);
  check('no-project welcome shows the picker entry', welcome.emptyHidden === false && welcome.emptyTitle === '从一份材料开始' && welcome.welcomeHidden === false && welcome.browseHidden === true, JSON.stringify(welcome));

  await page.click('#pick-project');
  await wait(page, name => document.querySelector('#project-name').textContent === name, 20000, projectAName);
  await wait(page, () => document.querySelector('#file-tree button'), 20000);
  if (await page.waitForSelector('#agent-setup[open]', { timeout: 3000 }).catch(() => null)) await page.click('#agent-skip');

  const base = await snap(page);
  check('project empty base layer with honest copy', base.emptyHidden === false && base.emptyTitle === '工作区暂无打开的文件' && base.browseHidden === false && base.welcomeHidden === true && base.subject === '未打开文件' && base.label === '文件' && base.documents !== 'none' && base.closeHidden === true, JSON.stringify(base));
  check('default conservative layout is the compact bottom composer', base.panelHidden === false && base.launcherHidden === true && base.dock === 'bottom' && base.compact === true && base.floating === false && base.expanded === false, JSON.stringify(base));
  await page.evaluate(() => { window.__emptyComposerRef = document.querySelector('#composer'); });

  // Browse action: real keyboard activation expands a collapsed tree and focuses the filter.
  await page.click('#file-toggle');
  await wait(page, () => document.querySelector('#file-toggle').getAttribute('aria-expanded') === 'false');
  await page.focus('#empty-browse');
  await page.keyboard.press('Enter');
  const browseState = await page.evaluate(() => ({ expanded: document.querySelector('#file-toggle').getAttribute('aria-expanded'), focus: document.activeElement && document.activeElement.id }));
  check('browse button expands the file tree and focuses the filter from the keyboard', browseState.expanded === 'true' && browseState.focus === 'file-filter', JSON.stringify(browseState));

  // Minimized survives closing the last file; draft and composer node stay.
  await openFile(page, 'a.md');
  await page.type('#composer', 'DRAFT-A');
  const inboxBeforeClose = (await snap(page)).inbox;
  await wait(page, () => document.querySelector('#compose-status').textContent.includes('已保存'));
  await page.click('#chat-minimize');
  await wait(page, () => document.querySelector('#conversation-panel').hidden && !document.querySelector('#conversation-launcher').hidden);
  await closeCurrent(page);
  await wait(page, () => !document.querySelector('#empty').hidden);
  const minimizedEmpty = await snap(page);
  const minimizedLayout = layoutOf(minimizedEmpty);
  check('closing the last file keeps the conversation minimized (launcher only)', minimizedEmpty.emptyHidden === false && minimizedLayout.panelHidden === true && minimizedLayout.launcherHidden === false && minimizedEmpty.subject === '未打开文件', JSON.stringify(minimizedEmpty));
  check('draft, composer node and file bytes survive the close', minimizedEmpty.sameComposer === true && minimizedEmpty.draft === 'DRAFT-A' && (await readFile(path.join(projectA, 'a.md'), 'utf8')).startsWith('# a.md'), JSON.stringify(minimizedEmpty));
  check('closing a file spawns no work, inbox entry or agent console', minimizedEmpty.workItems === 0 && minimizedEmpty.inbox === inboxBeforeClose && minimizedEmpty.consoleHidden === true, JSON.stringify({ before: inboxBeforeClose, after: minimizedEmpty }));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'empty-minimized-1440' }));
  await resize(page, 390, 844);
  const narrow = await snap(page);
  check('narrow empty workspace keeps launcher-only conversation', narrow.emptyHidden === false && narrow.panelHidden === true && narrow.launcherHidden === false, JSON.stringify(narrow));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'empty-minimized-390' }));
  await resize(page, 1440, 900);
  await page.click('#conversation-launcher');
  await wait(page, () => !document.querySelector('#conversation-panel').hidden);
  const afterLauncher = await page.evaluate(() => ({ focus: document.activeElement && document.activeElement.id, draft: document.querySelector('#composer').value }));
  check('launcher restores input focus without losing the draft', afterLauncher.focus === 'composer' && afterLauncher.draft === 'DRAFT-A', JSON.stringify(afterLauncher));

  // Compact input bar survives close/reopen cycles.
  await page.click('#chat-history-toggle');
  await wait(page, () => document.querySelector('#conversation-panel').classList.contains('compact-composer'));
  await openFile(page, 'a.md');
  await closeCurrent(page);
  await wait(page, () => !document.querySelector('#empty').hidden);
  const compactEmpty = await snap(page);
  check('compact composer survives closing the last file', compactEmpty.compact === true && compactEmpty.dock === 'bottom' && compactEmpty.panelHidden === false, JSON.stringify(compactEmpty));

  // Side docking survives.
  await openFile(page, 'a.md');
  await page.click('#chat-layout summary');
  await wait(page, () => document.querySelector('#chat-layout-menu').matches(':popover-open'));
  await page.click('#chat-layout-menu [data-dock="right"]');
  await wait(page, () => document.querySelector('#work-surface').dataset.dock === 'right');
  await closeCurrent(page);
  await wait(page, () => !document.querySelector('#empty').hidden);
  const dockedEmpty = await snap(page);
  check('right-docked conversation survives closing the last file', dockedEmpty.dock === 'right' && dockedEmpty.floating === false && dockedEmpty.emptyHidden === false, JSON.stringify(dockedEmpty));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'empty-dock-right-1440' }));

  // Floating window and its dragged position survive.
  await openFile(page, 'a.md');
  await panelAction(page, '#float-conversation', '悬浮对话');
  await wait(page, () => document.querySelector('#conversation-panel').classList.contains('floating'));
  const headPoint = await page.$eval('#conversation-head', node => { const box = node.getBoundingClientRect(); return { x: box.left + 60, y: box.top + 8 }; });
  await page.mouse.move(headPoint.x, headPoint.y); await page.mouse.down();
  await page.mouse.move(headPoint.x - 120, headPoint.y + 60, { steps: 8 }); await page.mouse.up();
  const floatingBefore = await page.$eval('#conversation-panel', node => node.getBoundingClientRect().toJSON());
  await closeCurrent(page);
  await wait(page, () => !document.querySelector('#empty').hidden);
  const floatingEmpty = await snap(page);
  const floatingAfter = await page.$eval('#conversation-panel', node => node.getBoundingClientRect().toJSON());
  check('floating conversation keeps its window and position on close', floatingEmpty.floating === true && floatingEmpty.emptyHidden === false && Math.abs(floatingAfter.x - floatingBefore.x) < 2 && Math.abs(floatingAfter.y - floatingBefore.y) < 2 && Math.abs(floatingAfter.width - floatingBefore.width) < 2, JSON.stringify({ before: floatingBefore, after: floatingAfter }));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'empty-floating-1440' }));

  // Explicit full conversation stays full and keeps working controls.
  await openFile(page, 'a.md');
  await panelAction(page, '#chat-maximize', '放大对话窗口');
  await wait(page, () => document.querySelector('#work-surface').classList.contains('chat-expanded') && getComputedStyle(document.querySelector('#documents')).display === 'none');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyW'); await page.keyboard.up('Control'); await settleConfirm(page);
  await wait(page, () => document.querySelector('#file-path').textContent === '选择文件开始阅读');
  const expandedEmpty = await snap(page);
  check('explicit full conversation stays full after closing the file', expandedEmpty.expanded === true && expandedEmpty.documents === 'none', JSON.stringify(expandedEmpty));
  check('minimize stays available inside the full conversation', await page.$eval('#chat-minimize', node => node.offsetParent !== null));
  await page.click('#chat-minimize');
  await wait(page, () => document.querySelector('#conversation-panel').hidden && !document.querySelector('#conversation-launcher').hidden);
  await page.click('#conversation-launcher');
  await wait(page, () => !document.querySelector('#conversation-panel').hidden);
  const reexpanded = await snap(page);
  check('minimize ends the explicit expansion and the launcher restores the underlying window', reexpanded.expanded === false && reexpanded.panelHidden === false && reexpanded.emptyHidden === false, JSON.stringify(reexpanded));
  check('leaving the explicit full conversation reveals the empty base layer again', reexpanded.documents !== 'none', JSON.stringify(reexpanded));

  // Tab batch closes: closing another tab keeps the active file; close-all ends on the empty layer.
  await openFile(page, 'a.md'); await openFile(page, 'b.md'); await openFile(page, 'c.md');
  const beforeBatch = layoutOf(await snap(page));
  const bPoint = await page.$eval('#open-files .open-file-item[data-path="b.md"] .open-file-select', node => { const box = node.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });
  await page.mouse.click(bPoint.x, bPoint.y, { button: 'middle' });
  await wait(page, () => ![...document.querySelectorAll('#open-files .open-file-item')].some(node => node.dataset.path === 'b.md'));
  const afterOther = await snap(page);
  check('middle-click closing another tab keeps the active file and layout', afterOther.emptyHidden === true && afterOther.filePath === 'c.md' && JSON.stringify(layoutOf(afterOther)) === JSON.stringify(beforeBatch), JSON.stringify(afterOther));
  const activeRow = await page.$eval('#open-files .open-file-item[data-active="true"]', node => { const box = node.getBoundingClientRect(); return { x: box.left + 40, y: box.top + box.height / 2 }; });
  await page.mouse.click(activeRow.x, activeRow.y, { button: 'right' });
  await page.waitForSelector('#file-tab-menu:not([hidden])');
  await mouseClickText(page, '#file-tab-menu', '关闭全部');
  await wait(page, () => !document.querySelector('#empty').hidden && !document.querySelector('#open-files .open-file-item'));
  const afterAll = await snap(page);
  check('close-all lands on the empty base layer with the layout untouched', afterAll.emptyHidden === false && JSON.stringify(layoutOf(afterAll)) === JSON.stringify(beforeBatch), JSON.stringify(afterAll));

  // Comparison pane closing changes nothing else.
  await openFile(page, 'a.md');
  await page.click('#open-beside'); await page.waitForSelector('#beside-dialog[open]');
  await page.select('#beside-file', 'b.md'); await page.click('#beside-form button[type="submit"]');
  await wait(page, () => document.querySelector('#reader').classList.contains('document-dual'));
  const beforeBeside = layoutOf(await snap(page));
  await page.click('#secondary-close'); await settleConfirm(page);
  await wait(page, () => !document.querySelector('#reader').classList.contains('document-dual'));
  const afterBeside = await snap(page);
  check('closing the comparison pane keeps the file and conversation layout', afterBeside.emptyHidden === true && afterBeside.filePath === 'a.md' && JSON.stringify(layoutOf(afterBeside)) === JSON.stringify(beforeBeside), JSON.stringify(afterBeside));

  // A failing save refuses to close and keeps the input.
  await page.click('#text-mode-toggle');
  await wait(page, () => !document.querySelector('#text-host').hidden);
  await chmod(path.join(projectA, 'a.md'), 0o444);
  await page.click('#text-host .cm-content');
  await page.keyboard.type('unsaved closing barrier');
  await closeCurrent(page);
  await wait(page, () => !document.querySelector('#save-failure').hidden, 20000);
  const refused = await snap(page);
  const editorText = await page.evaluate(() => window.__nozeliInput ? window.__nozeliInput.text() : document.querySelector('#text-host .cm-content').textContent);
  check('failed save refuses to close and keeps the draft text', refused.emptyHidden === true && refused.filePath === 'a.md' && editorText.includes('unsaved closing barrier'), JSON.stringify(refused));
  await chmod(path.join(projectA, 'a.md'), 0o644);
  await page.click('#retry-save');
  await wait(page, () => document.querySelector('#save-status').dataset.state === 'saved', 20000);
  await closeCurrent(page);
  await wait(page, () => !document.querySelector('#empty').hidden);
  check('close succeeds after the save recovers', (await snap(page)).emptyHidden === false);

  // Report (real IPC + GUI) closes back to the empty layer with layout intact.
  if (await page.$eval('#toggle-sidebar', node => node.getAttribute('aria-expanded') === 'false')) await page.click('#toggle-sidebar');
  await wait(page, () => document.querySelector('#inbox-reports').getBoundingClientRect().width > 0);
  await page.evaluate(id => window.nozeli.invoke('agents.connect', { projectId: id }), projectId);
  await wait(page, () => document.querySelector('#inbox-reports button'), 20000);
  const beforeReport = layoutOf(await snap(page));
  await mouseClickText(page, '#inbox-reports', '关闭行为验证报告');
  await wait(page, () => !document.querySelector('#managed-doc').hidden && document.querySelector('#managed-doc').textContent.includes('REPORT-BODY'));
  const reportOpen = await snap(page);
  check('inbox report opens as the current subject', reportOpen.emptyHidden === true && reportOpen.subject.includes('关闭行为验证报告'), JSON.stringify(reportOpen));
  await closeCurrent(page);
  await wait(page, () => !document.querySelector('#empty').hidden && document.querySelector('#managed-doc').hidden);
  const reportClosed = await snap(page);
  check('closing the report returns to the empty base layer with layout and draft', reportClosed.emptyHidden === false && JSON.stringify(layoutOf(reportClosed)) === JSON.stringify(beforeReport) && reportClosed.draft === 'DRAFT-A', JSON.stringify(reportClosed));

  // A background reply only records facts; it never reopens or expands anything.
  await panelAction(page, '#chat-reset-layout', '恢复默认布局');
  await wait(page, () => document.querySelector('#work-surface').dataset.dock === 'bottom' && !document.querySelector('#conversation-panel').classList.contains('floating'));
  const replyBaseline = await snap(page);
  await page.click('#composer');
  await page.type('#composer', ' background-check');
  await page.evaluate(() => document.querySelector('#compose-form').requestSubmit());
  await wait(page, () => document.querySelector('#conversation').textContent.includes('Word Agent 测试回复'), 30000);
  const afterReply = await snap(page);
  check('background reply does not reopen content or change the conversation layout', afterReply.emptyHidden === false && JSON.stringify(layoutOf(afterReply)) === JSON.stringify(layoutOf(replyBaseline)), JSON.stringify({ before: replyBaseline, after: afterReply }));
  check('reply keeps the draft that was sent available in the composer', (await snap(page)).draft.includes('background-check') || (await page.$eval('#conversation', node => node.textContent.includes('background-check'))), '');

  // A -> B -> A keeps per-project layouts and drafts.
  await page.click('#recent button[title="' + projectBName + '"]');
  await wait(page, name => document.querySelector('#project-name').textContent === name, 20000, projectBName);
  const bEmpty = await snap(page);
  check('project B opens on its own empty base layer', bEmpty.emptyHidden === false && bEmpty.emptyTitle === '工作区暂无打开的文件' && bEmpty.draft === '', JSON.stringify(bEmpty));
  await page.click('#chat-layout summary');
  await wait(page, () => document.querySelector('#chat-layout-menu').matches(':popover-open'));
  await page.click('#chat-layout-menu [data-dock="top"]');
  await wait(page, () => document.querySelector('#work-surface').dataset.dock === 'top');
  await page.click('#recent button[title="' + projectAName + '"]');
  await wait(page, name => document.querySelector('#project-name').textContent === name, 20000, projectAName);
  await wait(page, () => document.querySelector('#work-surface').dataset.dock === 'bottom' && !document.querySelector('#conversation-panel').classList.contains('floating'), 10000);
  const backA = await snap(page);
  check('returning to A restores its own layout and empty layer without leaking B', backA.emptyHidden === false && backA.dock === 'bottom' && backA.floating === false && backA.sameComposer === true, JSON.stringify(backA));

  // Cold start: minimize, then relaunch the same profile.
  await page.click('#chat-minimize');
  await wait(page, () => document.querySelector('#conversation-panel').hidden);
  await wait(page, () => !document.querySelector('#empty').hidden);
  await page.evaluate(() => { const composer = document.querySelector('#composer'); composer.value = 'COLD-START-DRAFT'; composer.dispatchEvent(new Event('input', { bubbles: true })); });
  await wait(page, () => document.querySelector('#compose-status').textContent.includes('已保存'));
  await browser.disconnect();
  child.kill('SIGTERM');
  await stopped;

  const debugPort2 = await port();
  const child2 = spawnApp(debugPort2);
  let output3 = '';
  child2.stdout.on('data', chunk => { output3 += chunk; }); child2.stderr.on('data', chunk => { output3 += chunk; });
  try {
    const deadline = Date.now() + 30000;
    for (;;) { if (child2.exitCode !== null || child2.signalCode) throw new Error(`Electron exited ${child2.exitCode}/${child2.signalCode}: ${output3}`); try { if ((await fetch(`http://127.0.0.1:${debugPort2}/json/version`)).ok) break; } catch { /* booting */ } if (Date.now() > deadline) throw new Error('devtools timeout: ' + output3); await new Promise(resolve => setTimeout(resolve, 150)); }
    const second = await connectPage(debugPort2);
    page = second.page; browser = second.browser;
    await wait(page, () => document.querySelector('#project-name').textContent.length > 0 && document.querySelector('#file-tree button'), 30000);
    await wait(page, () => !document.querySelector('#empty').hidden, 30000);
    const cold = await snap(page);
    check('cold start restores the empty layer with the minimized conversation and draft', cold.emptyHidden === false && cold.subject === '未打开文件' && cold.panelHidden === true && cold.launcherHidden === false && cold.draft === 'COLD-START-DRAFT', JSON.stringify(cold));
    check('cold start did not reopen the closed file', cold.emptyHidden === false && cold.closeHidden === true, JSON.stringify(cold));
    await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'cold-start-empty-1440' }));
    await browser.disconnect();
  } finally {
    if (child2.exitCode === null && !child2.signalCode) child2.kill('SIGTERM');
    await new Promise(resolve => { const timer = setTimeout(() => { child2.kill('SIGKILL'); resolve(); }, 5000); child2.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }

  const failed = checks.filter(item => !item.ok);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: failed.length === 0, checks, screenshots: ['empty-minimized-1440', 'empty-minimized-390', 'empty-dock-right-1440', 'empty-floating-1440', 'cold-start-empty-1440'] }, null, 2));
  console.log(`empty workspace checks ${checks.length - failed.length}/${checks.length} ok; ${output}`);
  if (failed.length) throw new Error(JSON.stringify(failed, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: false, checks, failure: error.stack }, null, 2));
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  await browser?.disconnect().catch(() => {});
  if (child.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); }
}
