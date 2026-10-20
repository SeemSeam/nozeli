import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'code-project-'));
const project = path.join(output, 'project');
await mkdir(path.join(project, 'src'), { recursive: true });
const main = `import { formatUser } from './utils';

interface User { name: string; active: boolean; }
function greet(user: User): string { return formatUser(user); }
const current: User = { name: 'Nozeli', active: true };
console.log(greet(current));
`;
const utils = `export function formatUser(user: { name: string; active: boolean }): string {
  return user.active ? user.name : 'inactive';
}
`;
const cpp = `#include <string>
int main() {
  std::string value = "Nozeli";
  return static_cast<int>(value.size());
}
`;
await writeFile(path.join(project, 'src', 'main.ts'), main);
await writeFile(path.join(project, 'src', 'utils.ts'), utils);
await writeFile(path.join(project, 'src', 'sample.cc'), cpp + Array.from({length: 180}, (_, i) => '// scrolling row ' + i + '\n').join(''));
await mkdir(path.join(project, 'src', 'nested'), {recursive: true});
await writeFile(path.join(project, 'src', 'nested', 'child.cc'), cpp);
await mkdir(path.join(project, 'other'));
await writeFile(path.join(project, 'other', 'peer.cc'), cpp);
await writeFile(path.join(project, 'src', 'data.json'), '{"name":"Nozeli","active":true}\n');
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const electron = createRequire(import.meta.url)('electron');
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(electron, ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
const exited = new Promise(resolve => child.once('exit', resolve));
let browser;
const checks = [];
let screenshot;
let completionScreenshot;
try {
  const deadline = Date.now() + 20000;
  for (;;) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error('startup timeout\n' + log); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const page = (await browser.pages()).find(item => item.url().includes('127.0.0.1'));
  page.on('pageerror', error => console.error('RENDERER', error.stack));
  await page.waitForFunction(() => window.__nozeliReady, { polling: 100 });
  await page.setViewport({ width: 1440, height: 900 });
  const waitForMonacoLayout = () => page.waitForFunction(() => {
    const lines = [...document.querySelectorAll('#text-host .monaco-editor .view-line')];
    const tops = lines.map(node => node.getBoundingClientRect().top).sort((a, b) => a - b);
    return tops.every((top, index) => index === 0 || top > tops[index - 1] + 4);
  }, { timeout: 5000 });
  await page.click('#pick-project');
  await page.waitForFunction(() => document.querySelectorAll('#file-tree button').length > 0);
  await page.waitForSelector('#agent-setup[open]');
  const provider = await page.$eval('#agent-foreground option:not(:disabled)', n => n.value);
  await page.select('#agent-foreground', provider);
  await page.select('#agent-background', provider);
  await page.$eval('#agent-setup-form', n => n.requestSubmit());
  await page.waitForFunction(() => !document.querySelector('#agent-setup').open && !document.querySelector('#selection-explain').disabled);
  await page.click('#file-tree button[data-path="src/main.ts"]');
  await page.waitForFunction(() => window.__nozeliInput.text().includes('formatUser'));
  await waitForMonacoLayout();
  const language = await page.$eval('#text-host .monaco-editor', node => ({ className: node.className, codeSpans: node.querySelectorAll('.view-line span').length, text: node.textContent }));
  assert.match(language.className, /monaco-editor/); assert.ok(language.codeSpans > 0); assert.ok((await page.evaluate(() => window.__nozeliInput.text())).includes('interface User')); checks.push('TypeScript file opens with real Monaco syntax spans');

  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('F11'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('focus-mode'));
  await page.waitForFunction(() => {
    const scroll = document.querySelector('#reader-scroll');
    const editor = document.querySelector('#text-host .monaco-editor');
    const lines = [...document.querySelectorAll('#text-host .monaco-editor .view-line')];
    const tops = lines.map(node => node.getBoundingClientRect().top).sort((a, b) => a - b);
    return scroll && editor && Math.abs(editor.getBoundingClientRect().height - scroll.clientHeight) <= 1
      && tops.every((top, index) => index === 0 || top > tops[index - 1] + 4);
  });
  checks.push('focus mode relayout keeps Monaco line layers aligned');
  await page.click('#focus-exit');
  await page.waitForFunction(() => !document.querySelector('#app')?.classList.contains('focus-mode'));

  const partial = main.lastIndexOf('greet(current)');
  await page.evaluate(pos => { window.__nozeliInput.select(pos, pos + 5); }, partial);
  await page.evaluate(() => window.__nozeliInput.focus());
  await page.keyboard.type('gre');
  await page.keyboard.down('Control'); await page.keyboard.press('Space'); await page.keyboard.up('Control');
  await page.waitForSelector('.suggest-widget');
  await page.waitForFunction(() => document.querySelectorAll('.suggest-widget .monaco-list-row').length > 0);
  const suggestions = await page.$$eval('.suggest-widget .monaco-list-row', nodes => nodes.map(node => node.textContent));
  assert.ok(suggestions.some(value => value.includes('greet')), JSON.stringify(suggestions)); checks.push('current-file symbols and keywords appear in completion popup');
  completionScreenshot = path.join(output, 'code-completion.png');
  await waitForMonacoLayout();
  await page.screenshot({ path: completionScreenshot, fullPage: false });
  await page.keyboard.press('Tab');
  const completedText = await page.evaluate(() => window.__nozeliInput.text());
  assert.ok(completedText.includes('greet(current)'), `completion accepts a selected option: ${completedText}`); checks.push('completion accepts selected option');

  const current = await page.evaluate(() => window.__nozeliInput.text());
  const call = current.lastIndexOf('greet(current)');
  await page.evaluate(pos => window.__nozeliInput.select(pos, pos + 5), call);
  await page.$eval('#code-jump', node => node.click());
  await page.waitForFunction(() => document.querySelector('#code-status').textContent.includes('跳转到'));
  assert.ok((await page.evaluate(() => window.__nozeliInput.text())).includes('function greet'), 'definition jump keeps source intact'); checks.push('current-file definition jump reports target');

  await page.evaluate(() => window.__nozeliInput.select(0, 0));
  await page.evaluate(() => window.__nozeliInput.focus());
  await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press('g'); await page.keyboard.up('Alt'); await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('src/utils.ts'));
  assert.equal(await page.evaluate(() => window.__nozeliInput.text()), utils); checks.push('import navigation opens the correct project file');
  assert.equal(await page.$$eval('#text-host .monaco-editor', nodes => nodes.length), 1, 'only the active Monaco editor remains mounted');
  await waitForMonacoLayout();
  await page.click('#file-tree button[data-path="src/sample.cc"]');
  await page.waitForFunction(() => window.__nozeliInput.text().includes('#include <string>'));
  await waitForMonacoLayout();
  await page.evaluate(() => window.__nozeliInput.select(0, 0));
  await page.focus('#text-host .monaco-editor textarea.inputarea');
  await page.keyboard.type('Visible', { delay: 80 });
  await page.waitForFunction(() => window.__nozeliInput.text().startsWith('Visible'));
  const typedToken = await page.$eval('#text-host .monaco-editor .view-line span span', node => ({
    text: node.textContent,
    color: getComputedStyle(node).color,
    opacity: getComputedStyle(node).opacity,
    visibility: getComputedStyle(node).visibility,
  }));
  assert.match(typedToken.text, /^Visible/);
  assert.notEqual(typedToken.color, 'rgba(0, 0, 0, 0)', 'typed token must not be transparent');
  assert.equal(typedToken.opacity, '1');
  assert.equal(typedToken.visibility, 'visible');
  checks.push('typed C++ characters remain visible in Monaco token layer');
  const points = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('#text-host .view-line')];
    return [lines[0], lines[2]].map(line => {
      const text = document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode();
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1);
      const r = range.getBoundingClientRect(); return { x: r.left + 1, y: r.top + r.height / 2 };
    });
  });
  await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
  await page.mouse.move(points[1].x + 45, points[1].y, { steps: 15 }); await page.mouse.up();
  const selected = await page.evaluate(() => { const s = window.__nozeliInput.selection(); return window.__nozeliInput.text().slice(s.from, s.to); });
  assert.ok(selected.length > 10 && selected.includes('\n'), 'mouse drag selects multiple characters across lines');
  await page.waitForSelector('#selection-menu:not([hidden])');
  await page.click('#selection-explain');
  await page.waitForSelector('#text-host .note-anchor.tag-discuss');
  const recent = await page.evaluate(() => window.nozeli.invoke('project.recent'));
  const projectId = recent.value.projects[0].id;
  await page.waitForFunction(async id => {
    const r = await window.nozeli.invoke('agents.messages', { projectId: id });
    return r.ok && r.value.messages.some(m => m.text?.includes('请解释'));
  }, {}, projectId);
  checks.push('physical cross-line selection creates explanation tag and reaches Agent IPC (fixture)');
  await page.click('#file-tree button[data-path="src"]');
  assert.equal(await page.$eval('#file-tree button[data-path="src/sample.cc"]', n => n.hidden), true);
  await page.click('#file-tree button[data-path="src"]');
  assert.equal(await page.$eval('#file-tree button[data-path="src/sample.cc"]', n => n.hidden), false);
  checks.push('directory collapse hides children and expansion restores them');
  const order = await page.$$eval('#file-tree button', nodes => nodes.map(n=>n.dataset.path));
  assert.equal(order[order.indexOf('src/nested') + 1], 'src/nested/child.cc');
  await page.click('#file-tree button[data-path="src/nested"]');
  await page.click('#file-tree button[data-path="src"]');
  await page.click('#file-tree button[data-path="src"]');
  assert.equal(await page.$eval('#file-tree button[data-path="src/nested/child.cc"]', n=>n.hidden), true);
  assert.equal(await page.$eval('#file-tree button[data-path="other/peer.cc"]', n=>n.hidden), false);
  await page.type('#file-filter', 'child.cc');
  for (const rel of ['src', 'src/nested', 'src/nested/child.cc']) {
    assert.equal(await page.$eval(`#file-tree button[data-path="${rel}"]`, n=>n.hidden), false, 'search retains ancestors');
  }
  await page.click('#file-tree button[data-path="src/nested"]');
  assert.equal(await page.$eval('#file-tree button[data-path="src/nested/child.cc"]', n=>n.hidden), true, 'search result can collapse');
  await page.$eval('#file-filter', n=>{n.value='';n.dispatchEvent(new Event('input', {bubbles:true}));});
  assert.equal(await page.$eval('#file-tree button[data-path="src/nested"]', n=>n.getAttribute('aria-expanded')), 'false');
  assert.equal(await page.$eval('#file-tree button[data-path="other/peer.cc"]', n=>n.hidden), false);
  await page.click('#file-tree button[data-path="other"]');
  assert.equal(await page.$eval('#file-tree button[data-path="src/sample.cc"]', n=>n.hidden), false, 'sibling folder remains expanded');
  await page.click('#file-tree button[data-path="other"]');
  checks.push('search preserves folder ancestry and collapse controls, clearing restores independent folder states');
  // A recycled line must retain its real top after scrolling and mouse hit-testing.
  const previousEditor = await page.$('#text-host .monaco-editor');
  await page.click('#file-tree button[data-path="src/sample.cc"]');
  await page.waitForFunction(node=>!node.isConnected, {}, previousEditor);
  await waitForMonacoLayout();
  await page.waitForSelector('#text-host .tag-close');
  await page.click('#text-host .tag-close');
  // Scroll the code surface itself, clear of floating annotation cards.
  const bounds = await page.$eval('#text-host .monaco-editor .scrollbar.vertical', n=>n.getBoundingClientRect().toJSON());
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  for(let i=0;i<8;i++){await page.mouse.wheel({deltaY: 500}); await new Promise(r=>setTimeout(r,100));}
  await page.waitForFunction(() => [...document.querySelectorAll('#text-host .view-line')].some(n => /scrolling.row.(?:[5-9][0-9]|1[0-7][0-9])/.test(n.textContent)));
  await waitForMonacoLayout();
  const rows = await page.$$eval('#text-host .view-line', nodes=>nodes.map(n=>({text:n.textContent,top:n.style.top,actual:getComputedStyle(n).top})));
  assert.ok(rows.every(row=>row.top === row.actual), 'CSP permits native Monaco row styles');
  checks.push('nested directory ordering/state and recycled Monaco row positions');

  const cppLayout = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('#text-host .monaco-editor .view-line')]
      .map(node => node.getBoundingClientRect()).filter(rect => rect.height > 0);
    return lines.length > 0 && lines.every((rect, index) => index === 0 || rect.top > lines[index - 1].top + 4);
  });
  assert.equal(cppLayout, true, 'C++ Monaco token rows remain separated on first open'); checks.push('C++ source opens without token overlap');
  screenshot = path.join(output, 'code-project.png');
  await page.screenshot({ path: screenshot, fullPage: false });
  assert.equal((await page.evaluate(() => window.__nozeliInput.text())).includes('#include <string>'), true);
  const oldTree = await page.$('#file-tree button');
  await page.click('#recent button[aria-current="true"]');
  await page.waitForFunction(n=>!n.isConnected, {}, oldTree);
  await page.waitForSelector('#file-tree button[data-path="src/nested"]');
  assert.equal(await page.$eval('#file-tree button[data-path="src/nested"]', n=>n.getAttribute('aria-expanded')), 'false');
  assert.equal(await page.$eval('#file-tree button[data-path="src/nested/child.cc"]', n=>n.hidden), true);
  checks.push('project reactivation retains its folder collapse state');

} finally {
  await browser?.disconnect();
  if (child.exitCode === null) child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
}
console.log(JSON.stringify({ ok: true, output, checks, screenshot, completionScreenshot }));
