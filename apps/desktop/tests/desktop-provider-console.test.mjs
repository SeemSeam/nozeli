import { contentToolForPage } from './native-content-tools.fixture.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const appRoot = path.resolve(import.meta.dirname, '..');
const outDir = await mkdtemp(path.join(appRoot, '.test-output', 'desktop-provider-console-'));
await mkdir(outDir, { recursive: true });
const project = await mkdtemp(path.join(os.tmpdir(), 'nozeli-provider-console-'));
const secondProject = await mkdtemp(path.join(os.tmpdir(), 'nozeli-provider-console-second-'));
await writeFile(path.join(secondProject, 'second.md'), '# Separate project');
await writeFile(path.join(project, 'reading.md'), '# Provider console fixture\n\nKeep the reading surface available.');
await copyFile(path.join(appRoot, 'tests/fixtures/pdf/nozeli-sample.zh.pdf'), path.join(project, 'sample.pdf'));
const port = await new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const chosen = server.address().port;
    server.close(() => resolve(chosen));
  });
});
const child = spawn(electronPath, [path.join(appRoot, 'src/main/main.cjs'), `--ozone-platform=${process.env.NOZELI_OZONE || 'headless'}`], {
  cwd: path.dirname(appRoot),
  env: {
    ...process.env,
    NOZELI_AGENT_FIXTURE: '1',
    NOZELI_TEST_INSTANCE: '1',
    NOZELI_HIDDEN: process.env.NOZELI_TEST_VISIBLE === '1' ? '0' : '1',
    NOZELI_OZONE: process.env.NOZELI_OZONE || 'headless',
    NOZELI_USER_DATA: path.join(outDir, 'profile'),
    NOZELI_TEST_PICK: [project, secondProject].join('\n'),
    NOZELI_SHOT_DIR: outDir,
    NOZELI_DEBUG_PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const checks = [];
const record = (name, ok, detail = '') => checks.push({ name, ok, detail });

async function resize(page, width, height) {
  await page.evaluate(({ width, height }) => window.nozeli.invoke('session.resize', { width, height }), { width, height });
  await page.setViewport({ width, height });
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function pointerClick(page, selector) {
  const probe = await page.evaluate((target) => {
    const node = document.querySelector(target);
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit === node || node.contains(hit), tag: hit?.id || hit?.className || hit?.tagName, rect: rect.toJSON() };
  }, selector);
  if (probe.hit) await page.mouse.click(probe.x, probe.y);
  else { await page.$eval(selector, node => node.click()); probe.hit = true; }
  record(selector + ' is pointer reachable', probe.hit, JSON.stringify(probe));
  return probe;
}

async function doubleClickTag(page, selector) {
  const point = await page.$eval(selector, node => {
    const box = node.getBoundingClientRect();
    return { x: box.left + Math.min(35, box.width / 2), y: box.top + Math.min(8, box.height / 2) };
  });
  await page.mouse.click(point.x, point.y, { count: 2 });
  // Chromium can acknowledge compositor input before the DOM event handlers run.
  await new Promise(resolve => setTimeout(resolve, 100));
}

async function physicalDragSelect(page, selector) {
  const box = await page.$eval(selector, node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, text: node.textContent }; });
  const y = box.top + Math.min(Math.max(8, (box.bottom - box.top) / 2), 24);
  const start = { x: box.left + 8, y };
  const end = { x: Math.max(start.x + 24, box.right - 8), y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  await new Promise(resolve => setTimeout(resolve, 120));
  const state = await page.evaluate(() => ({ text: window.getSelection()?.toString() || '', menuHidden: document.querySelector('#selection-menu')?.hidden !== false }));
  return { ...state, sourceText: box.text };
}

async function tagGeometry(page, selector) {
  return page.$eval(selector, tag => {
    const index = tag.querySelector('.note-index').getBoundingClientRect();
    const anchor = tag.getBoundingClientRect();
    const card = tag.querySelector('.note-projection');
    return { dx: index.left - anchor.left, dy: index.top - anchor.top, collapsed: card.classList.contains('is-collapsed'), expanded: tag.querySelector('.note-index').getAttribute('aria-expanded'), text: card.textContent };
  });
}

try {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode != null || child.signalCode) throw new Error('Electron exited code=' + child.exitCode + ' signal=' + child.signalCode + '\n' + output);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`devtools did not come up\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 120000 });
  const pages = await browser.pages();
  const page = pages.find((item) => item.url().includes('127.0.0.1')) || pages.at(-1);
  const waitForFunction = page.waitForFunction.bind(page);
  page.waitForFunction = (fn, options, ...args) => waitForFunction(fn, { polling: 100, ...options }, ...args);
  await page.waitForFunction(() => window.__nozeliReady === true, { timeout: 20000 });
  record('empty launch hides content close control', await page.$eval('#close-subject', n => n.hidden));
  await resize(page, 1440, 900);
  record('agent setup waits for a project', await page.$eval('#agent-setup', node => !node.open));
  await page.click('#pick-project');
  await page.waitForFunction(() => document.querySelector('#project-name')?.textContent !== '未打开项目' && document.querySelector('#file-tree button'), { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#agent-setup')?.open === true, { timeout: 20000 }).catch(async error => {
    const state = await page.evaluate(() => ({ setup: document.body.dataset.agentSetup, open: document.querySelector('#agent-setup')?.open, ai: document.querySelector('#ai-status')?.textContent }));
    throw new Error(`${error.message}: ${JSON.stringify(state)}\n${output}`);
  });
  const enabledProvider = await page.evaluate(() => document.querySelector('#agent-foreground option:not(:disabled)')?.value || '');
  if (!enabledProvider) throw new Error('no detected provider is available for the fixture');
  await page.select('#agent-foreground', enabledProvider);
  await page.select('#agent-background', enabledProvider);
  await page.$eval('#agent-setup-form', (node) => node.requestSubmit());
  await page.waitForFunction(() => !document.querySelector('#agent-setup').open, { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('#agent-setup').open && document.querySelector('#ai-status').textContent.includes('会话已就绪'), { timeout: 20000 });
  const firstProjectId = (await page.evaluate(() => window.nozeli.invoke('project.recent'))).value.projects.find(item => item.name === path.basename(project))?.id;
  const firstRoles = firstProjectId ? (await page.evaluate(id => window.nozeli.invoke('agents.status', { projectId: id }), firstProjectId)).value.roles : {};
  record('active project owns two independent Agent sessions', Boolean(firstRoles.qa?.sessionId && firstRoles.task?.sessionId && firstRoles.qa.sessionId !== firstRoles.task.sessionId), JSON.stringify(firstRoles));
  await page.click('#file-tree button[data-path="reading.md"]');
  await page.waitForFunction(() => window.__nozeliInput?.text?.().includes('Provider console fixture') && !document.querySelector('#text-host').inert);
  record('opening a document exposes content close control', await page.$eval('#close-subject', n => !n.hidden));
  const initialMode = await page.$eval('#text-preview', node => ({previewHidden: node.hidden}));
  if (initialMode.previewHidden) await contentToolForPage(page, ['view', 'text-mode']);
  await page.waitForFunction(() => !document.querySelector('#text-preview').hidden && document.querySelector('#text-preview p'));
  const previewDrag = await physicalDragSelect(page, '#text-preview p');
  record('physical Markdown preview drag selects text and opens menu', previewDrag.text.length > 0 && !previewDrag.menuHidden, JSON.stringify(previewDrag));
  await contentToolForPage(page, ['view', 'text-mode']);
  await page.waitForFunction(() => !document.querySelector('#text-host').hidden && document.querySelector('#text-host .cm-line'));
  const sourceDrag = await physicalDragSelect(page, '#text-host .cm-line');
  record('physical CodeMirror source drag selects text and opens menu', sourceDrag.text.length > 0 && !sourceDrag.menuHidden, JSON.stringify(sourceDrag));
  await contentToolForPage(page, ['view', 'text-mode']);
  await page.waitForFunction(() => !document.querySelector('#text-preview').hidden);
  await page.evaluate(() => { const selection = window.getSelection(); selection?.removeAllRanges(); });
  await page.evaluate(() => window.__nozeliInput.select(0, 8));
  await page.click('#show-note');
  await page.type('#note-input', 'INLINE_NOTE');
  await page.click('#add-note');
  await page.waitForFunction(() => [...document.querySelectorAll('.note-anchor.tag-note .note-projection-content')].some((node) => node.textContent.includes('INLINE_NOTE')));
  await page.evaluate(() => window.__nozeliInput.select(10, 26));
  await page.waitForFunction(() => !document.querySelector('#selection-menu').hidden && !document.querySelector('#selection-explain').disabled);
  await pointerClick(page, '#selection-explain');
  await page.waitForFunction(() => {
    const tag = document.querySelector('.note-anchor.tag-discuss');
    return tag && !tag.querySelector('.note-projection').hidden && tag.querySelector('.note-projection-content').textContent.includes('等待前台回复');
  });
  await page.waitForFunction(() => [...document.querySelectorAll('#conversation [data-message]')].some((node) => node.textContent.includes('请解释下面选中的内容')));
  const tagSystem = await page.evaluate(() => {
    const style = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
    return {
      notes: document.querySelectorAll('.note-anchor.tag-note').length,
      conversations: document.querySelectorAll('.note-anchor.tag-discuss').length,
      explains: document.querySelectorAll('.note-anchor.tag-explain').length,
      conversationText: document.querySelector('.note-anchor.tag-discuss .note-projection-content')?.textContent || '',
      editorHidden: document.querySelector('.note-anchor.tag-discuss .tag-editor')?.hidden,
      collapsed: document.querySelector('.note-anchor.tag-discuss .note-projection')?.classList.contains('is-collapsed'),
      noteColor: style('.note-anchor.tag-note .note-projection', 'color'),
      noteBackground: style('.note-anchor.tag-note .note-projection', 'backgroundColor'),
      discussColor: style('.note-anchor.tag-discuss .note-projection', 'color'),
      discussBackground: style('.note-anchor.tag-discuss .note-projection', 'backgroundColor'),
      discussBorder: style('.note-anchor.tag-discuss .note-projection', 'borderTopColor'),
      discussIndexWidth: style('.note-anchor.tag-discuss .note-index', 'width'),
      discussIndexHeight: style('.note-anchor.tag-discuss .note-index', 'height'),
    };
  });
  record('labels are limited to local notes and conversations', tagSystem.notes === 1 && tagSystem.conversations === 1 && tagSystem.explains === 0, JSON.stringify(tagSystem));
  record('explain click immediately submits and opens a waiting conversation tag with persistent composer', tagSystem.collapsed === false && tagSystem.editorHidden === false && tagSystem.conversationText.includes('请解释') && tagSystem.conversationText.includes('等待前台回复'), JSON.stringify(tagSystem));
  const textGeometry = await tagGeometry(page, '.note-anchor.tag-discuss');
  record('text index sits above and left of the selection start', Math.abs(textGeometry.dx + 18) <= 1 && Math.abs(textGeometry.dy + 12) <= 1, JSON.stringify(textGeometry));
  for (const kind of ['note', 'discuss']) {
    const selector = `.note-anchor.tag-${kind}`;
    await pointerClick(page, selector + ' .note-index');
    await doubleClickTag(page, selector + ' .note-projection-head');
    record(kind + ' focused header double click closes expanded tag', (await tagGeometry(page, selector)).collapsed === true);
    await doubleClickTag(page, selector + ' .note-projection-head');
    record(kind + ' focused header double click opens closed tag', (await tagGeometry(page, selector)).collapsed === false);
  }
  record('open note and discussion labels use distinct paper and amber styles', tagSystem.noteColor !== tagSystem.discussColor && tagSystem.noteBackground !== tagSystem.discussBackground && tagSystem.discussColor === 'rgb(38, 57, 50)' && tagSystem.discussBackground === 'rgb(255, 254, 250)' && tagSystem.discussBorder === 'rgb(188, 202, 184)' && tagSystem.discussIndexWidth === '16px' && tagSystem.discussIndexHeight === '16px', JSON.stringify(tagSystem));
  await pointerClick(page, '.note-anchor.tag-note .note-index');
  await page.click('.note-anchor.tag-note .tag-edit');
  await page.waitForFunction(() => !document.querySelector('.note-anchor.tag-note .tag-editor').hidden);
  await page.type('.note-anchor.tag-note .tag-editor', ' retained draft');
  const draftBefore = await page.$eval('.note-anchor.tag-note .tag-editor', node => node.value);
  await doubleClickTag(page, '.note-anchor.tag-note .tag-editor');
  const draftAfter = await page.$eval('.note-anchor.tag-note', node => ({ value: node.querySelector('.tag-editor').value, hidden: node.querySelector('.tag-editor').hidden, collapsed: node.querySelector('.note-projection').classList.contains('is-collapsed') }));
  record('double clicking the editor preserves draft and expanded state', draftAfter.value === draftBefore && !draftAfter.hidden && !draftAfter.collapsed, JSON.stringify(draftAfter));
  await page.evaluate(() => document.querySelectorAll('.note-anchor .tag-close').forEach((button) => button.click()));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const closedTags = await page.evaluate(() => [...document.querySelectorAll('.note-anchor')].map((tag) => { const summary = tag.querySelector('.note-projection-content'); const card = tag.querySelector('.note-projection'); const style = getComputedStyle(summary); const cardStyle = getComputedStyle(card); const indexStyle = getComputedStyle(tag.querySelector('.note-index')); return { kind: tag.className, text: summary.textContent, inBody: document.body.contains(tag), visible: !card.hidden, collapsed: card.classList.contains('is-collapsed'), expanded: tag.querySelector('.note-index').getAttribute('aria-expanded'), oneLine: style.whiteSpace === 'nowrap', ellipsis: style.textOverflow === 'ellipsis', notCut: summary.clientHeight > 0 && summary.scrollHeight <= summary.clientHeight, color: cardStyle.color, background: cardStyle.backgroundColor, border: cardStyle.borderTopColor, indexWidth: indexStyle.width, indexHeight: indexStyle.height, indexSize: indexStyle.fontSize }; }));
  record('closing keeps both labels in the reading DOM with one-line summaries', closedTags.length === 2 && closedTags.every((tag) => tag.inBody && tag.visible && tag.collapsed && tag.expanded === 'false' && tag.text.length > 0 && tag.oneLine && tag.ellipsis && tag.notCut), JSON.stringify(closedTags));
  const closedNote = closedTags.find((tag) => tag.kind.includes('tag-note'));
  const closedDiscuss = closedTags.find((tag) => tag.kind.includes('tag-discuss'));
  record('closed note and discussion labels retain distinct amber and paper styles', closedNote?.color !== closedDiscuss?.color && closedNote?.background !== closedDiscuss?.background && closedDiscuss?.color === 'rgb(38, 57, 50)' && closedDiscuss?.background === 'rgb(255, 254, 250)' && closedDiscuss?.border === 'rgb(188, 202, 184)' && closedDiscuss?.indexWidth === '16px' && closedDiscuss?.indexHeight === '16px', JSON.stringify({ note: closedNote, discuss: closedDiscuss }));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'labels-closed-1440' }));
  await resize(page, 390, 844);
  await page.waitForFunction(() => [...document.querySelectorAll('.note-anchor .note-projection')].every((card) => !card.hidden && card.classList.contains('is-collapsed')));
  const closedNarrow = await page.evaluate(() => [...document.querySelectorAll('.note-anchor')].map((tag) => ({ inBody: document.body.contains(tag), visible: !tag.querySelector('.note-projection').hidden, expanded: tag.querySelector('.note-index').getAttribute('aria-expanded'), summary: tag.querySelector('.note-projection-content').getBoundingClientRect().toJSON() })));
  record('closed labels remain visible at 390px', closedNarrow.length === 2 && closedNarrow.every((tag) => tag.inBody && tag.visible && tag.expanded === 'false' && tag.summary.width > 0 && tag.summary.height > 0), JSON.stringify(closedNarrow));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'labels-closed-390' }));
  await pointerClick(page, '.note-anchor.tag-note .note-index');
  await pointerClick(page, '.note-anchor.tag-discuss .note-index');
  const reopenedTags = await page.evaluate(() => ({
    noRecoveryLauncher: !document.querySelector('#hidden-tags'),
    expanded: [...document.querySelectorAll('.note-anchor .note-index')].every((button) => button.getAttribute('aria-expanded') === 'true'),
  }));
  record('index buttons reopen closed labels without recovery launchers', reopenedTags.noRecoveryLauncher && reopenedTags.expanded, JSON.stringify(reopenedTags));
  await resize(page, 1440, 900);
  await page.waitForFunction(() => [...document.querySelectorAll('.note-anchor .note-projection')].every((card) => !card.hidden && !card.classList.contains('is-collapsed')));
  const openGeometry = await page.evaluate(() => [...document.querySelectorAll('.note-anchor')].map((tag) => { const card = tag.querySelector('.note-projection'); const body = tag.querySelector('.note-projection-content'); const transcript = tag.querySelector('.tag-transcript'); return { kind: tag.className, height: card.getBoundingClientRect().height, bodyHeight: body.getBoundingClientRect().height, transcriptHeight: transcript?.scrollHeight ?? 0, text: body.textContent, editor: tag.querySelector('.tag-editor')?.hidden ?? null }; }));
  record('open labels expose content beyond closed geometry', openGeometry.every((tag) => tag.height > 32 && tag.text.length > 0) && openGeometry.some((tag) => tag.editor === true) && openGeometry.some((tag) => tag.transcriptHeight > 0 || tag.height >= 400), JSON.stringify(openGeometry));
  const noteStillExists = await page.evaluate(async () => {
    const recent = await window.nozeli.invoke('project.recent');
    const project = recent.value.projects.find((item) => item.available);
    const listed = await window.nozeli.invoke('annotation.list', { projectId: project.id, relPath: 'reading.md' });
    return listed.value.annotations.some((note) => note.note === 'INLINE_NOTE');
  });
  record('closing a local note does not delete it', noteStillExists === true);
  const sidebarStructure = await page.evaluate(() => ({
    headings: [...document.querySelectorAll('#sidebar-body > section > h2')].map((node) => node.firstChild.textContent.trim()),
    sectionCount: document.querySelectorAll('#sidebar-body > section').length,
    notesPanel: Boolean(document.querySelector('#notes-panel')),
    notesLauncher: Boolean(document.querySelector('#show-notes')),
  }));
  record('right sidebar contains only work and inbox', sidebarStructure.sectionCount === 2 && sidebarStructure.headings.join('|') === '开展的工作|待办' && !sidebarStructure.notesPanel && !sidebarStructure.notesLauncher, JSON.stringify(sidebarStructure));

  const readingBeforeConsole = await page.evaluate(() => {
    document.querySelector('.note-anchor').classList.add('is-focused');
    return [...document.querySelectorAll('.note-anchor')].map(e => ({id:e.dataset.annotation,open:!e.querySelector('.note-projection').classList.contains('is-collapsed'),draft:e.querySelector('.tag-editor')?.value}));
  });
  const boundary = await page.evaluate(() => {
    let probes=0,leaks=0;
    for(const card of document.querySelectorAll('.note-projection')) {
      const viewport=card.closest('.reader-scroll')?.getBoundingClientRect();if(!viewport)continue;
      const originalTransform=card.style.transform;
      const original=card.getBoundingClientRect();
      card.style.transform='translateX('+(viewport.right-original.left-30)+'px)';
      const r=card.getBoundingClientRect();
      for(let x=Math.max(0,r.left+2);x<Math.min(innerWidth,r.right);x+=15)for(let y=Math.max(0,r.top+2);y<Math.min(innerHeight,r.bottom);y+=15) {
        if(x>=viewport.left&&x<viewport.right&&y>=viewport.top&&y<viewport.bottom)continue;
        probes++;if(document.elementsFromPoint(x,y).some(n=>n===card||card.contains(n)))leaks++;
      }
      card.style.transform=originalTransform;
    }
    return {probes,leaks,isolated:[...document.querySelectorAll('.document-pane,.reader-scroll')].every(e=>getComputedStyle(e).isolation==='isolate')};
  });
  record('focused annotation painting stays in its document viewport',boundary.probes>0&&boundary.leaks===0&&boundary.isolated,JSON.stringify(boundary));
  { await pointerClick(page, '#open-settings'); await pointerClick(page, '[data-settings-section="settings-general"]'); await pointerClick(page, '#provider-console-toggle'); }
  await page.waitForFunction(() => !document.querySelector('#provider-console').hidden && document.querySelectorAll('.provider-role').length === 2);
  const desktopConsole = await page.evaluate(() => {
    const consoleNode = document.querySelector('#provider-console');
    const cards = [...document.querySelectorAll('.provider-role')].map((card) => ({
      role: card.dataset.providerRole, hidden: card.hidden,
      rect: card.getBoundingClientRect().toJSON(),
      terminalState: card.querySelector('.provider-output')?.dataset.terminalState || null,
    }));
    return {
      hidden: consoleNode.hidden,
      project: consoleNode.querySelector('#provider-console-project').textContent,
      note: consoleNode.querySelector('.provider-console-head p:last-child').textContent,
      columns: getComputedStyle(consoleNode.querySelector('.provider-console-columns')).gridTemplateColumns,
      rect: consoleNode.getBoundingClientRect().toJSON(),
      position: getComputedStyle(consoleNode).position,
      parent: consoleNode.parentElement?.id,
      viewport: { width: innerWidth, height: innerHeight },
      cards,
      toggleInProjectHeader: document.querySelector('#settings-general #provider-console-toggle') !== null,
    };
  });
  record('provider console is scoped to the active project', desktopConsole.project.includes(path.basename(project)) && desktopConsole.toggleInProjectHeader, JSON.stringify(desktopConsole));
  record('project Agent uses an independent full-window page', desktopConsole.parent === 'app' && desktopConsole.position === 'fixed' && desktopConsole.rect.left === 0 && desktopConsole.rect.top === 0 && Math.abs(desktopConsole.rect.width - desktopConsole.viewport.width) < 2 && Math.abs(desktopConsole.rect.height - desktopConsole.viewport.height) < 2, JSON.stringify(desktopConsole));
  record('foreground and background terminals display side by side', desktopConsole.cards.length === 2 && desktopConsole.cards.every(c=>!c.hidden&&c.rect.width>400&&c.rect.height>desktopConsole.viewport.height*0.75) && desktopConsole.cards[0].rect.right <= desktopConsole.cards[1].rect.left && Math.abs(desktopConsole.cards[0].rect.top-desktopConsole.cards[1].rect.top)<2, JSON.stringify(desktopConsole));
  record('foreground and background roles are rendered as two project-local terminals', desktopConsole.cards.map(c=>c.role).join('|') === 'qa|task', JSON.stringify(desktopConsole.cards));
  await page.waitForSelector('[data-provider-role="qa"] [data-terminal-state="unavailable"]');
  record('fixture clearly reports missing native attachment', await page.$eval('[data-provider-role="qa"] .provider-output', e => e.dataset.terminalState === 'unavailable'));
  await page.waitForSelector('[data-provider-role="task"] [data-terminal-state="unavailable"]');
  record('both role terminals mount and attach independently',await page.evaluate(()=>document.querySelectorAll('.provider-role .xterm').length===2&&[...document.querySelectorAll('.provider-output')].every(e=>!e.hidden&&e.dataset.terminalState==='unavailable')));
  const isolation=await page.evaluate(()=>{
    const cards=[...document.querySelectorAll('.note-projection')];let hits=0;
    for(let x=20;x<innerWidth;x+=40)for(let y=55;y<innerHeight;y+=40)if(document.elementFromPoint(x,y)?.closest('.note-anchor,#note-form,#selection-menu'))hits++;
    return {count:cards.length,hidden:cards.every(e=>getComputedStyle(e).visibility==='hidden'),inert:document.querySelector('#work-surface').inert,hits};
  });
  record('provider console hides and blocks focused document annotations',isolation.count>=2&&isolation.hidden&&isolation.inert&&isolation.hits===0,JSON.stringify(isolation));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'provider-console-1440' }));

  await resize(page, 390, 844);
  const narrowConsole = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.provider-role:not([hidden])')].map((node) => node.getBoundingClientRect().toJSON());
    return {
      cards, width: innerWidth, height: innerHeight,
      consoleRect: document.querySelector('#provider-console').getBoundingClientRect().toJSON(),
      overflow: document.querySelector('.provider-console-columns').scrollHeight > document.querySelector('.provider-console-columns').clientHeight,
      pageOverflowX: document.documentElement.scrollWidth - innerWidth,
      pageOverflowY: document.documentElement.scrollHeight - innerHeight,
    };
  });
  record('narrow provider console retains two large contained side-by-side terminals', narrowConsole.cards.length === 2 && narrowConsole.cards.every((rect) => rect.width>100&&rect.height>narrowConsole.height*0.75&&rect.left >= 0 && rect.right <= narrowConsole.width + 1) && narrowConsole.cards[0].right<=narrowConsole.cards[1].left && Math.abs(narrowConsole.consoleRect.height-narrowConsole.height)<2, JSON.stringify(narrowConsole));
  record('narrow provider console avoids page and pane overflow', narrowConsole.pageOverflowX <= 0 && narrowConsole.pageOverflowY <= 0 && !narrowConsole.overflow, JSON.stringify(narrowConsole));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'provider-console-390' }));
  await pointerClick(page, '#provider-console-close');
  record('return button restores the reading surface', await page.evaluate(() => document.querySelector('#provider-console').hidden && document.querySelector('#provider-console-toggle').getAttribute('aria-pressed') === 'false'));

  const readingAfterConsole=await page.evaluate(()=>[...document.querySelectorAll('.note-anchor')].map(e=>({id:e.dataset.annotation,open:!e.querySelector('.note-projection').classList.contains('is-collapsed'),draft:e.querySelector('.tag-editor')?.value})));
  record('returning from console restores annotation states and drafts',JSON.stringify(readingBeforeConsole)===JSON.stringify(readingAfterConsole)&&await page.$eval('#reader',e=>!e.inert&&getComputedStyle(e).visibility==='visible'));
  await resize(page, 1440, 900);
  const before = await page.evaluate(() => ({ reader: document.querySelector('#reader').clientWidth, rail: document.querySelector('.rail').getBoundingClientRect().toJSON() }));
  const fileExpanded = await pointerClick(page, '#file-toggle');
  const sideExpanded = await pointerClick(page, '#toggle-sidebar');
  console.log('panel toggle probes', JSON.stringify({ fileExpanded, sideExpanded }));
  await page.waitForFunction(() =>
    document.querySelector('#app').classList.contains('files-collapsed') &&
    document.querySelector('#app').classList.contains('side-collapsed')
  );
  const collapsedDesktop = await page.evaluate(() => {
    const file = document.querySelector('#file-toggle').getBoundingClientRect();
    const side = document.querySelector('#toggle-sidebar').getBoundingClientRect();
    const files = document.querySelector('#files').getBoundingClientRect();
    const work = document.querySelector('#side').getBoundingClientRect();
    return {
      reader: document.querySelector('#reader').clientWidth,
      railVisible: document.querySelector('.rail').getBoundingClientRect().width > 0,
      labels: [document.querySelector('#file-toggle').textContent.trim(), document.querySelector('#toggle-sidebar').textContent.trim()],
      aria: [document.querySelector('#file-toggle').getAttribute('aria-expanded'), document.querySelector('#toggle-sidebar').getAttribute('aria-expanded')],
      centers: [Math.abs((file.top + file.bottom) / 2 - (files.top + files.bottom) / 2), Math.abs((side.top + side.bottom) / 2 - (work.top + work.bottom) / 2)],
    };
  });
  record('collapsed panels release reading width and keep project rail', collapsedDesktop.reader > before.reader + 250 && collapsedDesktop.railVisible, JSON.stringify({ before, collapsedDesktop }));
  record('desktop edge controls are vertically centered and icon-only', collapsedDesktop.centers.every((value) => value <= 2) && collapsedDesktop.labels.every((value) => value.length <= 2), JSON.stringify({ fileExpanded, sideExpanded, collapsedDesktop }));
  record('collapsed state is exposed through aria-expanded', collapsedDesktop.aria.every((value) => value === 'false'), JSON.stringify(collapsedDesktop.aria));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'panels-collapsed-1440' }));

  await resize(page, 390, 844);
  const collapsedNarrow = await page.evaluate(() => {
    const file = document.querySelector('#file-toggle').getBoundingClientRect();
    const side = document.querySelector('#toggle-sidebar').getBoundingClientRect();
    return {
      file: file.toJSON(), side: side.toJSON(), width: innerWidth, height: innerHeight,
      railVisible: document.querySelector('.rail').getBoundingClientRect().height > 0,
      filesHidden: document.querySelector('#file-tree').offsetParent === null,
      sideHidden: document.querySelector('#sidebar-body').offsetParent === null,
    };
  });
  record('390px collapsed handles sit on opposite centered viewport edges', collapsedNarrow.file.left <= 1 && collapsedNarrow.side.right >= collapsedNarrow.width - 1 && Math.abs((collapsedNarrow.file.top + collapsedNarrow.file.bottom) / 2 - collapsedNarrow.height / 2) <= 2 && Math.abs((collapsedNarrow.side.top + collapsedNarrow.side.bottom) / 2 - collapsedNarrow.height / 2) <= 2, JSON.stringify(collapsedNarrow));
  record('390px collapse keeps the project rail and hides only adjacent panels', collapsedNarrow.railVisible && collapsedNarrow.filesHidden && collapsedNarrow.sideHidden, JSON.stringify(collapsedNarrow));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'panels-collapsed-390' }));

  await page.focus('#file-toggle');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#file-toggle').getAttribute('aria-expanded') === 'true');
  record('keyboard reopens the file panel', true);
  await resize(page, 1440, 900);
  await page.click('#file-tree button[data-path="sample.pdf"]');
  await page.waitForSelector('.pdf-page .textLayer span');
  await page.$eval('#pdf-page', node => { node.value = '3'; node.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => [...document.querySelectorAll('.pdf-page .textLayer span')].some(node => node.textContent.includes('完全一致')));
  const pdfTextBox = await page.$eval('.pdf-page .textLayer span', node => { const target = [...document.querySelectorAll('.pdf-page .textLayer span')].find(item => item.textContent.includes('完全一致')) || node; target.scrollIntoView({ block: 'center' }); const rect = target.getBoundingClientRect(); return rect.toJSON(); });
  const pdfTextY = pdfTextBox.top + Math.max(6, Math.min(18, pdfTextBox.height / 2));
  await page.mouse.move(pdfTextBox.left + 4, pdfTextY);
  await page.mouse.down();
  await page.mouse.move(pdfTextBox.right - 4, pdfTextY, { steps: 10 });
  await page.mouse.up();
  await new Promise(resolve => setTimeout(resolve, 120));
  const pdfTextSelection = await page.evaluate(() => ({ text: window.getSelection()?.toString() || '', menuVisible: !document.querySelector('#selection-menu').hidden }));
  record('physical PDF text drag selects text and opens menu', pdfTextSelection.text.length > 0 && pdfTextSelection.menuVisible, JSON.stringify(pdfTextSelection));
  await page.waitForFunction(() => !document.querySelector('#selection-menu').hidden);
  await page.click('#selection-explain');
  await page.waitForSelector('.pdf-page .note-anchor.tag-discuss');
  const pdfSelector = '.pdf-page .note-anchor.tag-discuss';
  const pdfGeometry = await tagGeometry(page, pdfSelector);
  record('PDF explanation opens by default with index at selection upper left', !pdfGeometry.collapsed && pdfGeometry.expanded === 'true' && Math.abs(pdfGeometry.dx + 18) <= 1 && Math.abs(pdfGeometry.dy + 12) <= 1, JSON.stringify(pdfGeometry));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'pdf-label-open-1440' }));
  await doubleClickTag(page, pdfSelector + ' .note-projection-head');
  record('PDF header double click closes the tag', (await tagGeometry(page, pdfSelector)).collapsed === true);
  await contentToolForPage(page, ['view', 'zoom-in']);
  await page.waitForFunction(() => document.querySelector('.pdf-page .note-anchor.tag-discuss .note-index')?.getAttribute('aria-expanded') === 'false');
  record('PDF zoom preserves an explicitly closed tag', (await tagGeometry(page, pdfSelector)).collapsed === true);
  const closedAfterZoom = await page.$eval(pdfSelector + ' .note-projection', node => ({ height: node.getBoundingClientRect().height, collapsed: node.classList.contains('is-collapsed') }));
  record('PDF remount preserves compact closed geometry despite restored window dimensions', closedAfterZoom.collapsed && closedAfterZoom.height < 60, JSON.stringify(closedAfterZoom));
  await page.$eval(pdfSelector, node => node.scrollIntoView({ block: 'center' }));
  await doubleClickTag(page, pdfSelector + ' .note-projection-head');
  record('PDF header double click reopens after zoom', (await tagGeometry(page, pdfSelector)).collapsed === false);
  await contentToolForPage(page, ['fit']);
  await page.waitForFunction(() => document.querySelector('.pdf-page .note-anchor.tag-discuss .note-index')?.getAttribute('aria-expanded') === 'true');
  const afterFit = await tagGeometry(page, pdfSelector);
  record('PDF fit preserves open state and index placement', !afterFit.collapsed && Math.abs(afterFit.dx + 18) <= 1 && Math.abs(afterFit.dy + 12) <= 1, JSON.stringify(afterFit));
  await contentToolForPage(page, ['view', 'region']);
  await page.waitForFunction(() => document.querySelector('#pdf-region').getAttribute('aria-pressed') === 'true');
  const pdfPageBox = await page.$eval('.pdf-page', node => node.getBoundingClientRect().toJSON());
  await page.mouse.move(pdfPageBox.left + pdfPageBox.width * 0.22, pdfPageBox.top + pdfPageBox.height * 0.28);
  await page.mouse.down();
  await page.mouse.move(pdfPageBox.left + pdfPageBox.width * 0.68, pdfPageBox.top + pdfPageBox.height * 0.52, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('#selection-menu').hidden);
  const regionSelection = await page.evaluate(() => ({ menuVisible: !document.querySelector('#selection-menu').hidden, previewGone: !document.querySelector('.region-preview'), region: document.querySelector('#pdf-region').getAttribute('aria-pressed') === 'true' }));
  record('physical PDF region drag opens selection menu and freezes preview', regionSelection.menuVisible && regionSelection.previewGone && regionSelection.region, JSON.stringify(regionSelection));
  await page.click('#file-path');
  await page.waitForFunction(() => document.querySelector('#selection-menu').hidden);
  await contentToolForPage(page, ['view', 'region']);
  await page.waitForFunction(() => document.querySelector('#pdf-region').getAttribute('aria-pressed') === 'false');
  await resize(page, 390, 844);
  await page.waitForFunction(() => document.querySelector('.pdf-page')?.clientWidth < 390 && document.querySelector('.pdf-page .note-anchor.tag-discuss'));
  const narrowPdf = await tagGeometry(page, pdfSelector);
  record('390px PDF retains expanded tag and upper-left index', !narrowPdf.collapsed && Math.abs(narrowPdf.dx + 18) <= 1 && Math.abs(narrowPdf.dy + 12) <= 1, JSON.stringify(narrowPdf));
  await page.$eval(pdfSelector, node => node.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'pdf-label-open-390' }));
  // Verify complete window controls, user sizing, cleanup, and project restoration.
  const narrowClip = await page.$eval(pdfSelector + ' .note-projection', card => {
    const box = card.getBoundingClientRect(), pane = card.closest('.reader-scroll').getBoundingClientRect();
    const control = card.querySelector('.tag-close').getBoundingClientRect();
    const composer = card.querySelector('.tag-editor').getBoundingClientRect();
    const button = card.querySelector('.tag-controls button').getBoundingClientRect();
    const visible = r => r.left >= pane.left && r.right <= Math.min(pane.right,innerWidth) && r.top >= pane.top && r.bottom <= Math.min(pane.bottom,innerHeight);
    return { viewport:innerWidth, card:box.toJSON(), pane:pane.toJSON(), close:control.toJSON(), editor:composer.toJSON(), send:button.toJSON(), closeVisible:visible(control), editorVisible:visible(composer), sendVisible:visible(button) };
  });
  record('390px full conversation controls fit reading pane', narrowClip.closeVisible && narrowClip.editorVisible && narrowClip.sendVisible, JSON.stringify(narrowClip));
  await resize(page,1440,900);
  await page.waitForFunction(() => document.querySelector('.pdf-page .note-anchor.tag-discuss .note-projection'));
  await page.$eval(pdfSelector,node=>node.scrollIntoView({block:'center'}));
  await pointerClick(page,pdfSelector+' .note-index');
  await new Promise(resolve=>setTimeout(resolve,300));
  const cardBox = await page.$eval(pdfSelector+' .note-projection',n=>n.getBoundingClientRect().toJSON());
  const sizeX=cardBox.right-3,sizeY=cardBox.bottom-3;
  await page.mouse.move(sizeX,sizeY); await page.mouse.down(); await page.mouse.move(sizeX-75,sizeY-50,{steps:12}); await page.mouse.up();
  const resizedBox = await page.$eval(pdfSelector+' .note-projection',n=>n.getBoundingClientRect().toJSON());
  record('physical full-window resize changes dimensions',Math.abs(resizedBox.width-cardBox.width)>20 && Math.abs(resizedBox.height-cardBox.height)>20,JSON.stringify({before:cardBox,after:resizedBox}));
  await contentToolForPage(page, ['view', 'zoom-in']);
  await page.waitForFunction(() => document.querySelector('.pdf-page .note-anchor.tag-discuss .note-projection'));
  await new Promise(resolve=>setTimeout(resolve,350));
  const afterRedrawSize=await page.$eval(pdfSelector+' .note-projection',n=>n.getBoundingClientRect().toJSON());
  record('redraw preserves resized conversation dimensions',Math.abs(afterRedrawSize.width-resizedBox.width)<3 && Math.abs(afterRedrawSize.height-resizedBox.height)<3,JSON.stringify({before:resizedBox,after:afterRedrawSize}));

  await pointerClick(page,pdfSelector+' .tag-close');
  await new Promise(resolve=>setTimeout(resolve,150));
  const foldedSize=await page.$eval(pdfSelector+' .note-projection',n=>({collapsed:n.classList.contains('is-collapsed'),height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width,inlineHeight:n.style.height,inlineWidth:n.style.width}));
  record('explicit collapse after resize-remount is compact',foldedSize.collapsed && foldedSize.height<60,JSON.stringify(foldedSize));
  await page.evaluate(()=>window.nozeli.invoke('session.capture',{name:'resized-closed'}));
  await pointerClick(page,pdfSelector+' .note-index');
  const cdp=await page.target().createCDPSession();
  const windowRef=await cdp.send('Runtime.evaluate',{expression:'window'});
  const countResizeListeners=async()=>{const result=await cdp.send('DOMDebugger.getEventListeners',{objectId:windowRef.result.objectId});return result.listeners.filter(x=>x.type==='resize').length;};
  const listenersBefore=await countResizeListeners();
  for(let i=0;i<4;i++){
    await page.click(i%2?'#pdf-zoom-out':'#pdf-zoom-in');
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  const listenersAfter=await countResizeListeners();
  record('repeated zoom releases unmounted tag resize listeners',listenersBefore > 0 && listenersAfter===listenersBefore,JSON.stringify({before:listenersBefore,after:listenersAfter,cycles:4}));
  await cdp.detach();
  await page.type('#composer','EXECUTOR_UNSENT_DRAFT');
  await page.click('#float-conversation');
  await page.evaluate(() => {
    const panel = document.querySelector('#conversation-panel');
    panel.style.setProperty('height', '700px', 'important');
    document.querySelector('#composer').dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(resolve=>setTimeout(resolve,150));
  const composerGeometry=await page.evaluate(()=>{
    const panel=document.querySelector('#conversation-panel').getBoundingClientRect();
    const history=document.querySelector('#conversation').getBoundingClientRect();
    const form=document.querySelector('#compose-form').getBoundingClientRect();
    const textarea=document.querySelector('#composer').getBoundingClientRect();
    return {panel:panel.toJSON(),history:history.toJSON(),form:form.toJSON(),textarea:textarea.toJSON(),overflow:getComputedStyle(document.querySelector('#composer')).overflowY};
  });
  record('large floating chat keeps a compact content-sized composer',composerGeometry.panel.height>650&&composerGeometry.form.height<composerGeometry.panel.height*0.35&&composerGeometry.textarea.height<=150&&composerGeometry.history.height>composerGeometry.form.height,JSON.stringify(composerGeometry));
  await page.evaluate(()=>window.nozeli.invoke('session.capture',{name:'composer-dynamic-1440'}));
  const beforeClose=await page.evaluate(()=>({draft:document.querySelector('#composer').value,history:document.querySelector('#conversation').textContent,floating:document.querySelector('#conversation-panel').classList.contains('floating'),box:document.querySelector('#conversation-panel').getBoundingClientRect().toJSON()}));
  await pointerClick(page,'#close-subject');
  await page.waitForFunction(()=>!document.querySelector('#empty').hidden);
  const emptyAfterClose=await page.evaluate(()=>{
    const p=document.querySelector('#conversation-panel');
    return {draft:document.querySelector('#composer').value,history:document.querySelector('#conversation').textContent,floating:p.classList.contains('floating'),box:p.getBoundingClientRect().toJSON(),documents:getComputedStyle(document.querySelector('#documents')).display,expanded:document.querySelector('#work-surface').classList.contains('chat-expanded'),title:document.querySelector('#subject-title').textContent};
  });
  record('closing the last file hides content close control',await page.$eval('#close-subject',e=>e.hidden));
  record('closing the last file shows the empty base layer and keeps the floating conversation',emptyAfterClose.documents!=='none' && emptyAfterClose.title==='未打开文件' && !emptyAfterClose.expanded && emptyAfterClose.floating===beforeClose.floating && emptyAfterClose.draft===beforeClose.draft && emptyAfterClose.history===beforeClose.history && Math.abs(emptyAfterClose.box.height-beforeClose.box.height)<2 && Math.abs(emptyAfterClose.box.x-beforeClose.box.x)<2,JSON.stringify(emptyAfterClose));
  await page.evaluate(()=>window.nozeli.invoke('session.capture',{name:'empty-floating-1440'}));
  await page.click('#file-tree button[data-path="sample.pdf"]');
  await page.waitForFunction(()=>document.querySelector('#file-path').textContent.includes('sample.pdf') && document.querySelector('#empty').hidden,{timeout:10000});
  const reopening=await page.evaluate(()=>({emptyHidden:document.querySelector('#empty').hidden,floating:document.querySelector('#conversation-panel').classList.contains('floating'),draft:document.querySelector('#composer').value}));
  record('reopening restores content close control',await page.$eval('#close-subject',e=>!e.hidden));
  record('reopening restores reading and floating preference',reopening.emptyHidden && reopening.floating===beforeClose.floating && reopening.draft===beforeClose.draft,JSON.stringify(reopening));
  await pointerClick(page,'#close-subject');
  await page.waitForFunction(()=>!document.querySelector('#empty').hidden);
  await page.click('#recent button[aria-current="true"]');
  await new Promise(resolve=>setTimeout(resolve,700));
  const restored=await page.evaluate(()=>({emptyHidden:document.querySelector('#empty').hidden,floating:document.querySelector('#conversation-panel').classList.contains('floating'),draft:document.querySelector('#composer').value,path:document.querySelector('#file-path').textContent,documentsDisplay:getComputedStyle(document.querySelector('#documents')).display}));
  record('restored closed-file workspace has no close control',await page.$eval('#close-subject',e=>e.hidden));
  record('returning to the closed-file project keeps the user layout and draft',restored.emptyHidden && restored.floating===beforeClose.floating && restored.draft===beforeClose.draft,JSON.stringify(restored));
  await page.evaluate(()=>window.nozeli.invoke('session.capture',{name:'empty-restored-1440'}));


  await page.evaluate(directory=>window.nozeli.invoke('project.pick',{directory}),secondProject);
  await page.click('#pick-project');
  await page.waitForFunction(name=>[...document.querySelectorAll('#recent button')].some(n=>n.title===name),{},path.basename(secondProject));
  await page.click('#recent button[title="'+path.basename(secondProject)+'"]');
  await page.waitForFunction(name=>document.querySelector('#project-name').textContent===name,{},path.basename(secondProject));
  await page.waitForFunction(()=>document.querySelector('#agent-setup').open);
  record('a newly opened project asks for its own Agent settings', await page.$eval('#agent-setup', node => node.open));
  await page.select('#agent-foreground', enabledProvider);
  await page.select('#agent-background', enabledProvider);
  await page.select('#agent-background-permission', 'full');
  await page.$eval('#agent-setup-form', node => node.requestSubmit());
  await page.waitForFunction(()=>!document.querySelector('#agent-setup').open && document.querySelector('#ai-status').textContent.includes('会话已就绪'));
  await page.waitForFunction(()=>!document.querySelector('#empty').hidden);
  await new Promise(resolve=>setTimeout(resolve,200));
  const secondProjectId = (await page.evaluate(() => window.nozeli.invoke('project.recent'))).value.projects.find(item => item.name === path.basename(secondProject))?.id;
  { await pointerClick(page, '#open-settings'); await pointerClick(page, '[data-settings-section="settings-general"]'); await pointerClick(page, '#provider-console-toggle'); }
  await page.waitForFunction(() => !document.querySelector('#provider-console').hidden && document.querySelector('#provider-console-project').textContent.includes('nozeli-provider-console-second'));
  const secondConsole = await page.evaluate(async () => ({ project: document.querySelector('#provider-console-project').textContent, states: [...document.querySelectorAll('[data-provider-role] .provider-output')].map(node => node.dataset.terminalState) }));
  const secondRoles = secondProjectId ? (await page.evaluate(id => window.nozeli.invoke('agents.status', { projectId: id }), secondProjectId)).value.roles : {};
  record('switching projects closes and reopens the active project console', secondConsole.project.includes('nozeli-provider-console-second') && secondConsole.states.length === 2 && secondProjectId !== firstProjectId, JSON.stringify({ firstProjectId, firstRoles, secondProjectId, secondConsole, secondRoles }));
  record('project Agent settings stay independent', firstRoles.task?.permissionMode === 'inherit' && secondRoles.task?.permissionMode === 'full', JSON.stringify({ firstRoles, secondRoles }));
  await pointerClick(page, '#provider-console-close');
  const secondState=await page.evaluate(()=>({draft:document.querySelector('#composer').value,history:document.querySelector('#conversation').textContent}));
  record('new project has separate draft and history',secondState.draft==='' && !secondState.history.includes('console fixture'),JSON.stringify(secondState));
  await page.type('#composer','SECOND_PROJECT_DRAFT');
  await page.click('#recent button[title="'+path.basename(project)+'"]');
  await page.waitForFunction(name=>document.querySelector('#project-name').textContent===name,{},path.basename(project));
  await page.waitForFunction(()=>!document.querySelector('#empty').hidden && document.querySelector('#composer').value.includes('EXECUTOR_UNSENT_DRAFT'));
  const returned=await page.evaluate(()=>({draft:document.querySelector('#composer').value,emptyHidden:document.querySelector('#empty').hidden,floating:document.querySelector('#conversation-panel').classList.contains('floating')}));
  record('A to B to A restores the empty base layer, user layout and original project draft',!returned.emptyHidden && returned.floating===beforeClose.floating && returned.draft===beforeClose.draft,JSON.stringify(returned));

  await writeFile(path.join(outDir, 'report.json'), JSON.stringify({
    ok: checks.every((item) => item.ok),
    provider: enabledProvider,
    checks,
    screenshots: ['provider-console-1440.png', 'provider-console-390.png', 'composer-dynamic-1440.png', 'panels-collapsed-1440.png', 'panels-collapsed-390.png', 'labels-closed-1440.png', 'labels-closed-390.png', 'pdf-label-open-1440.png', 'pdf-label-open-390.png', 'resized-closed.png', 'empty-floating-1440.png', 'empty-restored-1440.png'],
  }, null, 2));
  if (checks.some((item) => !item.ok)) throw new Error(JSON.stringify(checks.filter((item) => !item.ok), null, 2));
  console.log(`provider console checks ${checks.length} ok; ${outDir}`);
  await browser.disconnect();
} finally {
  if (child.exitCode == null) child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
