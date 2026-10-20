import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { DesktopHost } from '../src/main/host.mjs';
import { FileChanges } from '../src/domain/file-changes.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
await mkdir(path.join(root, '.test-output'), { recursive:true });
const output = await mkdtemp(path.join(root, '.test-output', 'code-folding-'));
const project = path.join(output, 'project'), profile = path.join(output, 'profile');
await mkdir(project);
const sources = {
  'sample.cpp': `#include <iostream>

class Counter {
public:
  int accumulate(int limit) {
    int total = 0;
    for (int index = 0; index < limit; ++index) {
      if (index % 2 == 0) {
        total += index;
      }
    }
    return total;
  }
};

int main() {
  Counter counter;
  return counter.accumulate(6);
}
`,
  'main.ts': `export class Counter {
  accumulate(limit: number): number {
    let total = 0;
    for (let index = 0; index < limit; index++) {
      if (index % 2 === 0) {
        total += index;
      }
    }
    return total;
  }
}
`,
  'sample.py': `class Counter:
    def accumulate(self, limit):
        total = 0
        for index in range(limit):
            if index % 2 == 0:
                total += index
        return total

def main():
    counter = Counter()
    return counter.accumulate(6)
`,
  'settings.json': `{
  "editor": {
    "folding": true,
    "languages": [
      "cpp",
      "python"
    ]
  }
}
`,
  'read.md': '# Reading\n\nA Markdown document.\n',
  'notes.txt': 'Plain text without a code folding driver.\n',
};
for (const [name, text] of Object.entries(sources)) await writeFile(path.join(project, name), text);
const host = new DesktopHost(profile), projectId = (await host.pick(project)).project.id;
const original = await host.readFile(projectId, 'sample.cpp');
sources['sample.cpp'] = original.text.replace('total = 0', 'total = 1');
await host.save(projectId, 'sample.cpp', original.digest, sources['sample.cpp']);

const port = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'src/main/main.cjs'), '--ozone-platform=wayland'], {
  cwd:root,
  env:{ ...process.env, WAYLAND_DISPLAY:'wayland-0', XDG_RUNTIME_DIR:'/run/user/1000', NOZELI_TEST_INSTANCE:'1', NOZELI_USER_DATA:profile, NOZELI_DEBUG_PORT:String(port), NOZELI_SHOT_DIR:output, NOZELI_AGENT_FIXTURE:'1' },
  stdio:['ignore', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
let log = '', browser, page;
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data; });
const report = { ok:false, output, project, checks:[], errors:[] };
const mark = text => { report.checks.push(text); console.log('PASS ' + text); };
const editor = '#text-host .monaco-editor';
const expanded = editor + ' .codicon-folding-expanded';
const collapsed = editor + ' .codicon-folding-collapsed';
const text = () => page.evaluate(() => __nozeliInput.text());
const invoke = (op, payload = {}) => page.evaluate(({op, payload}) => nozeli.invoke(op, payload), {op, payload});
async function open(name) {
  await page.click('#file-tree button[data-path="' + name + '"]');
  await page.waitForFunction(name => document.querySelector('#file-path').textContent === name && document.querySelector('#save-status').dataset.state === 'saved', {}, name);
}
async function menu() {
  const reading = await page.$eval('#text-preview', node => !node.hidden && node.getBoundingClientRect().width > 0);
  if (!reading) {
    await page.evaluate(() => __nozeliInput.focus());
    await page.waitForFunction(() => document.activeElement?.closest('#text-host .monaco-editor,#text-host .cm-editor'));
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await tick(150);
  const point = reading
    ? await page.$eval('#text-preview', node => { const b=node.getBoundingClientRect(); return {x:b.left+20, y:b.top+20}; })
    : await page.$eval('#text-host .view-line,#text-host .cm-line', node => { const b=node.getBoundingClientRect(); return {x:b.left+8, y:b.top+b.height/2}; });
  await page.mouse.click(point.x, point.y, {button:'right'});
  await page.waitForSelector('#document-context-menu:not([hidden])');
}
async function command(id) {
  await menu();
  await page.click('#document-context-menu [data-command="' + id + '"]');
  await page.waitForSelector('#document-context-menu[hidden]');
}
async function chord(key) {
  await page.evaluate(() => __nozeliInput.focus());
  await page.waitForFunction(() => document.activeElement?.closest('#text-host .monaco-editor'));
  await page.keyboard.down('Control');
  try { await page.keyboard.press('k'); await page.keyboard.press(key); }
  finally { await page.keyboard.up('Control'); }
}
const visible = () => page.$$eval(editor + ' .view-line', nodes => nodes.map(node => node.textContent.replaceAll('\u00a0', ' ')).join('\n'));
try {
  for (let i=0; i<150; i++) {
    if (child.exitCode !== null || child.signalCode) throw Error(log);
    try { browser = await puppeteer.connect({browserURL:'http://127.0.0.1:' + port, defaultViewport:null}); break; } catch {}
    await tick(100);
  }
  assert(browser, 'Electron startup failed');
  page = await waitForDesktopPage(browser);
  page.on('pageerror', error => report.errors.push(error.stack));
  await page.waitForFunction(() => window.__nozeliReady);
  await prepareReading(page);
  await open('sample.cpp'); await page.waitForSelector(expanded);
  await page.mouse.move(10, 10);
  assert.equal(await page.$eval(expanded, node => getComputedStyle(node).opacity), '1');
  assert((await page.$$(expanded)).length >= 4);
  mark('nested C++ folding controls remain visible beside line numbers without hover');

  await page.click(expanded); await page.waitForSelector(collapsed);
  assert(!(await visible()).includes('total += index'));
  assert((await visible()).includes('int main()'));
  await page.click(collapsed); await page.waitForFunction(() => [...document.querySelectorAll('#text-host .view-line')].some(node => node.textContent.replaceAll('\u00a0', ' ').includes('total += index')));
  assert.equal(await text(), sources['sample.cpp']);
  mark('a physical gutter click folds and expands one C++ block without changing text');

  await page.evaluate(() => __nozeliInput.select(0, 0)); await menu();
  for (const id of ['foldAll','unfoldAll']) assert(await page.$('#document-context-menu [data-command="' + id + '"]'));
  await page.screenshot({path:path.join(output, '01-code-menu.png')});
  await page.click('#document-context-menu [data-command=foldAll]'); await page.waitForSelector(collapsed); await tick(700);
  assert(!(await visible()).includes('total += index')); assert(!(await visible()).includes('counter.accumulate(6)'));
  assert(await page.$eval('#selection-menu', node => node.hidden));
  await page.screenshot({path:path.join(output, '02-all-folded.png')});
  await command('unfoldAll'); await page.waitForSelector(collapsed, {hidden:true});
  assert((await visible()).includes('total += index')); assert((await visible()).includes('counter.accumulate(6)'));
  assert.equal(await text(), sources['sample.cpp']);
  mark('right-menu fold all/unfold all covers nested and separate functions without toolbar rebound');

  await chord('0'); await page.waitForSelector(collapsed);
  assert(!(await visible()).includes('total += index'));
  await chord('j'); await page.waitForSelector(collapsed, {hidden:true});
  assert((await visible()).includes('total += index'));
  mark('VS Code Ctrl+K then Ctrl+0 / Ctrl+J chords fold and unfold all');

  const quote = 'total += index;', from = sources['sample.cpp'].indexOf(quote);
  await page.evaluate(({from, length}) => { __nozeliInput.select(from, from + length); __nozeliInput.focus(); }, {from, length:quote.length});
  await page.$eval('#selection-note', node => node.click());
  await page.type('#note-input', 'Folding preserves this code anchor'); await page.click('#add-note');
  await page.waitForSelector('#text-host .tag-note .note-index');
  await page.waitForSelector('#text-host .authorship-user');
  const notePoint = () => page.$eval('#text-host .tag-note .note-index', node => { const b=node.getBoundingClientRect(); return {left:b.left, top:b.top}; });
  const initialPoint = await notePoint();
  const tagPath = (await host.tagStore(projectId)).location('sample.cpp');
  const historyPath = new FileChanges(project).location('sample.cpp');
  const tagsBefore = await readFile(tagPath);
  const historyBefore = await readFile(historyPath);
  await command('foldAll'); await page.waitForSelector(collapsed);
  await tick(200);
  assert.equal(await page.$eval('#text-host .tag-note', node => node.checkVisibility({checkVisibilityCSS:true, checkOpacity:true})), false);
  assert.equal(await page.$('#text-host .monaco-authorship .authorship-user'), null);
  await command('unfoldAll'); await page.waitForSelector(collapsed, {hidden:true}); await tick(250);
  assert.deepEqual(await notePoint(), initialPoint);
  assert(await page.$('#text-host .authorship-user'));
  assert.deepEqual(await readFile(historyPath), historyBefore);
  assert.deepEqual(await readFile(tagPath), tagsBefore);
  mark('code note position, authorship projection and change history survive folding');

  await page.evaluate(() => __nozeliInput.select(0, 0)); await command('foldAll');
  await page.evaluate(() => { __nozeliInput.select(0, 0); __nozeliInput.focus(); });
  await page.keyboard.type('FOLDEDIT');
  assert((await text()).startsWith('FOLDEDIT'));
  await command('undo'); await page.waitForFunction(source => __nozeliInput.text() === source, {}, sources['sample.cpp']);
  await command('unfoldAll'); await page.waitForSelector(collapsed, {hidden:true});
  assert((await visible()).includes('total += index'));
  mark('folded code stays editable and native undo restores the original text');

  for (const name of ['main.ts', 'sample.py', 'settings.json']) {
    await open(name); await page.waitForSelector(expanded);
    const expandedLines = (await page.$$(editor + ' .view-line')).length;
    await command('foldAll'); await page.waitForSelector(collapsed);
    assert((await page.$$(editor + ' .view-line')).length < expandedLines);
    await command('unfoldAll'); await page.waitForSelector(collapsed, {hidden:true});
    assert.equal(await text(), sources[name]);
  }
  mark('TypeScript, Python and JSON use native nested folding with file-specific targets');

  await open('notes.txt'); await menu();
  assert.equal(await page.$('#document-context-menu [data-command=foldAll]'), null);
  assert.equal(await page.$('#document-context-menu [data-command=unfoldAll]'), null);
  await page.keyboard.press('Escape');
  await open('read.md'); await page.click('#text-preview', {button:'right'});
  await page.waitForSelector('#document-context-menu:not([hidden])');
  assert.equal(await page.$('#document-context-menu [data-command=foldAll]'), null);
  await page.keyboard.press('Escape');
  mark('plain text and Markdown reading menus do not advertise unavailable folding');

  await open('sample.cpp'); await page.waitForSelector(expanded); await command('unfoldAll');
  await page.waitForSelector(collapsed, {hidden:true});
  await page.screenshot({path:path.join(output, '03-expanded-with-note.png')});
  for (const [name, source] of Object.entries(sources)) assert.equal(await readFile(path.join(project, name), 'utf8'), source);
  assert.equal(await page.$eval('#save-status', node => node.dataset.state), 'saved');
  assert.deepEqual(report.errors, []);
  await invoke('session.requestClose');
  assert.deepEqual(await Promise.race([exited, tick(15000).then(() => null)]), {code:0, signal:null});
  mark('all source files stay intact and the test instance closes normally');
  report.ok = true;
} catch (error) {
  report.error = error.stack;
  await page?.screenshot({path:path.join(output, 'failure.png')}).catch(() => {});
} finally {
  await browser?.disconnect();
  if (child.exitCode === null && !child.signalCode) {
    child.kill('SIGTERM');
    if (!await Promise.race([exited.then(() => true), tick(3000).then(() => false)])) { child.kill('SIGKILL'); await exited; }
  }
  await writeFile(path.join(output, 'main.log'), log);
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
