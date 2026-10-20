import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import { DesktopHost } from '../src/main/host.mjs';
import { FileChanges } from '../src/domain/file-changes.mjs';
import { agentActor } from '../src/domain/document-changes.mjs';
import { digestBytes } from '../src/domain/material-store.mjs';

const root = path.resolve(import.meta.dirname, '..'), tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = await fs.mkdtemp(path.join(root, '.test-output', 'document-versions-'));
const profile = path.join(out, 'profile'), project = path.join(out, '历史对比验收'), second = path.join(out, '另一个项目');
await fs.mkdir(project); await fs.mkdir(second); await fs.writeFile(path.join(second, 'other.md'), '# 另一个项目\n');
const baseline = '# 文档对比\n\n这里是**最初内容**，公式 $E=mc^2$。\n\n旧段落。\n\n```cpp\nint count = 0;\n```\n\n末尾。\n';
const saved = [baseline, baseline.replace('最初内容', '人工修订').replace('旧段落。', '用户补充：有完整上下文。'), baseline.replace('最初内容', '人工修订').replace('旧段落。', 'Agent1 补充：另一个段落。').replace('count = 0', 'count = 1')];
await fs.writeFile(path.join(project, '阅读.md'), baseline);
await fs.writeFile(path.join(project, '对照.md'), saved[1] + '\n对照文件独有的尾注。\n');
await fs.writeFile(path.join(project, 'sample.cc'), '#include <iostream>\nint main() {\n  int value = 0;\n  return value;\n}\n');
await fs.writeFile(path.join(project, 'sample.tex'), '\\documentclass{article}\n\\begin{document}\nOld $E=mc^2$\n\\end{document}\n');
await fs.writeFile(path.join(project, 'history.md'), 'v0');
await fs.writeFile(path.join(project, 'bad-history.md'), '正文保留，损坏的记录不能用来猜测版本。');
const longLeft = Array.from({ length: 1400 }, (_, i) => `共同上下文 ${String(i).padStart(4, '0')}\n`).join('');
const longRight = longLeft.replace('共同上下文 0030\n', '不同内容 0030\n').replace('共同上下文 0200\n', '共同上下文 0200\n' + '对照新增行\n'.repeat(320)).replace(Array.from({ length: 130 }, (_, i) => `共同上下文 ${String(i + 600).padStart(4, '0')}\n`).join(''), '');
await fs.writeFile(path.join(project, 'long.txt'), longLeft); await fs.writeFile(path.join(project, 'long-other.txt'), longRight);
const host = new DesktopHost(profile); await host.pick(second); const projectId = (await host.pick(project)).project.id;
async function save(rel, text) { const read = await host.readFile(projectId, rel); await host.save(projectId, rel, read.digest, text); }
await host.readFile(projectId, '阅读.md'); await save('阅读.md', saved[1]);
const actor = agentActor(projectId, 'qa', { sessionInstance: 'version-fixture' }), read = await host.readDocument(projectId, '阅读.md', actor);
await host.applyDocument(projectId, actor, { readHandle: read.readHandle, edits: [{ from: 0, to: read.text.length, insert: saved[2] }], operationId: digestBytes(Buffer.from('seed-version')) });
for (const [rel, find, replace] of [['sample.cc', 'value = 0', 'value = 42'], ['sample.tex', 'Old', 'New']]) {
  const read = await host.readFile(projectId, rel); await save(rel, read.text.replace(find, replace));
}
await host.readFile(projectId, 'history.md'); for (let i = 1; i <= 103; i++) await save('history.md', 'v' + i);
await host.readFile(projectId,'bad-history.md');const brokenStore=new FileChanges(project),broken=await brokenStore.read('bad-history.md');broken.docId='invalid';await fs.writeFile(brokenStore.location('bad-history.md'),JSON.stringify(broken));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const launch = () => spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'src/main/main.cjs'), '--ozone-platform=wayland'], {
  cwd: root, env: { ...process.env, WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000', NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: profile, NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_SHOT_DIR: out, NOZELI_AGENT_FIXTURE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let child, exited, browser, page, log = '';
const report = { out, project, checks: [], errors: [], metrics: {} };
function attach() { for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => log += chunk); exited = new Promise(resolve => child.once('exit', resolve)); }
const invoke = (op, payload = {}) => page.evaluate(({ op, payload }) => nozeli.invoke(op, payload), { op, payload });
async function connect() {
  for (let i = 0; i < 180; i++) { try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port, defaultViewport: null }); break; } catch {} if (child.exitCode != null) throw Error(log); await tick(100); }
  assert(browser, log); page = await waitForDesktopPage(browser); page.on('pageerror', e => report.errors.push(e.stack)); await page.waitForFunction(() => window.__nozeliReady);
  await prepareReading(page);
}
async function resize(width) { await invoke('session.resize', { width, height: 900 }); await page.waitForFunction(w => innerWidth === w, {}, width); await tick(120); }
async function open(rel) {
  if (await page.$eval('#app', node => node.classList.contains('narrow-layout') ? !node.classList.contains('drawer-files-open') : node.classList.contains('files-collapsed'))) await page.click('#file-toggle');
  await page.click('#file-tree button[data-path="' + rel + '"]'); await page.waitForFunction(rel => document.querySelector('#file-path').textContent === rel, {}, rel); await tick(180);
  if (await page.$eval('#app', node => node.classList.contains('drawer-files-open'))) await page.click('#file-toggle');
}
async function chooser(history = false) { await page.click('#open-beside'); await page.waitForSelector('#beside-dialog[open]'); if (history) await page.click('#beside-source-history'); await page.waitForFunction(() => !document.querySelector('#beside-open').disabled); }
async function historical(revision) { await chooser(true); await page.select('#beside-version', String(revision)); await page.click('#beside-diff'); await page.waitForSelector('.document-diff .cm-mergeView'); await tick(150); }
const diffText = () => page.$$eval('.document-diff-body .cm-content', nodes => nodes.map(node => node.cmTile.root.view.state.doc.toString()));
async function closeDiff() { await page.click('#secondary-close');await page.waitForSelector('#action-confirmation[open]');await page.click('#action-confirmation-accept'); await page.waitForFunction(() => !document.querySelector('.document-diff') && document.querySelector('#secondary-pane').hidden); }
async function shot(name) { await page.screenshot({ path: path.join(out, name + '.png') }); }
try {
  child = launch(); attach(); await connect(); await resize(1440);
  await open('阅读.md'); const sourceBefore = await fs.readFile(path.join(project, '阅读.md')), ledgerBefore = await fs.readFile(new FileChanges(project).location('阅读.md'));
  await historical(0); assert.deepEqual(await diffText(), [saved[2], baseline]);
  assert.match(await page.$eval('#secondary-path', n => n.textContent), /v0.*开始记录/);
  assert((await page.$$eval('.cm-changedLine', n => n.length)) > 0); await shot('01-baseline-diff-wide');
  await page.click('#diff-next'); assert.match(await page.$eval('#diff-count', n => n.textContent), /^1\//); await page.click('#diff-previous');
  assert.equal(await page.$$eval('.document-diff .cm-content', nodes => nodes.every(n => n.getAttribute('contenteditable') === 'false')), true);
  await page.click('.document-diff .cm-content');await page.keyboard.type('FORBIDDEN');assert.deepEqual(await diffText(),[saved[2],baseline]);
  report.checks.push('baseline and saved version with immutable readonly editors, labels and bidirectional difference navigation');
  await page.click('#compare-mode'); await page.waitForFunction(() => !document.querySelector('.document-diff'));
  assert.equal(await page.evaluate(() => __nozeliInput.text()), saved[2]); await page.click('#diff-mode'); await page.waitForSelector('.document-diff');
  await page.click('#comparison-change'); await page.waitForSelector('#beside-dialog[open]'); await page.waitForFunction(() => !document.querySelector('#beside-open').disabled);
  await page.select('#beside-version', '1'); await page.click('#beside-diff'); await page.waitForFunction(() => document.querySelector('#secondary-path').textContent.includes('v1'));
  assert.deepEqual(await diffText(), [saved[2], saved[1]]); await shot('02-saved-history-diff'); await closeDiff();
  assert.deepEqual(await fs.readFile(path.join(project, '阅读.md')), sourceBefore); assert.deepEqual(await fs.readFile(new FileChanges(project).location('阅读.md')), ledgerBefore);
  report.checks.push('switch between ordinary compare and diff; change selected version; comparisons leave source and ledger unchanged');
  await page.click('#font-settings'); await page.click('#authorship-history'); await page.waitForSelector('#document-change-history[open] .change-history-compare');
  await page.click('.change-history-entry[data-event-id] .change-history-compare'); await page.waitForSelector('.document-diff');
  assert(await page.$eval('#document-change-history', n => !n.open)); assert.match(await page.$eval('#diff-count', n => n.textContent), /内容相同/); await closeDiff();
  report.checks.push('click a save batch in the existing modification history to compare it directly');
  await chooser(); await page.select('#beside-file', '对照.md'); await page.click('#beside-diff'); await page.waitForSelector('.document-diff');
  assert.deepEqual(await diffText(), [saved[2], saved[1] + '\n对照文件独有的尾注。\n']); await shot('03-other-file-diff');
  await open('sample.cc'); assert.equal(await page.$('.document-diff'), null); assert(await page.$eval('#secondary-pane', n => n.hidden));
  await historical(0); assert((await diffText())[0].includes('value = 42')); assert((await diffText())[1].includes('value = 0')); assert((await page.$$eval('.document-diff .cm-line span', n => n.length)) > 0); await closeDiff();
  await open('sample.tex'); await historical(0); assert((await diffText())[0].includes('New')); assert((await diffText())[1].includes('Old')); await closeDiff();
  report.checks.push('other project text comparison remains supported; primary switch cleans comparison; C++ highlighting and TeX version comparison');
  await open('bad-history.md');await page.click('#open-beside');await page.waitForSelector('#beside-dialog[open]');await page.click('#beside-source-history');
  await page.waitForFunction(()=>document.querySelector('#beside-status').textContent.includes('损坏'));assert.equal(await page.$$eval('#beside-version option',n=>n.length),0);
  assert(await page.$eval('#beside-open',n=>n.disabled));assert(await page.$eval('#beside-diff',n=>n.disabled));await shot('09-corrupt-history-refused');await page.keyboard.press('Escape');
  report.checks.push('switch to a corrupt history clears previous file versions and disables comparison without changing the source');
  await open('history.md'); await chooser(true); assert.equal(await page.$$eval('#beside-version option', n => n.length), 50);
  for (const count of [100, 104]) { await page.click('#beside-more'); await page.waitForFunction(n => document.querySelector('#beside-version').options.length === n, {}, count); }
  await page.select('#beside-version', '0'); await page.click('#beside-diff'); await page.waitForSelector('.document-diff'); assert.deepEqual(await diffText(), ['v103', 'v0']); await closeDiff();
  report.checks.push('104 versions load in bounded pages through baseline, with no lost early versions');
  await open('long.txt'); await chooser(); await page.select('#beside-file', 'long-other.txt'); await page.click('#beside-diff'); await page.waitForSelector('.document-diff'); await tick(350);
  // Position in unchanged context, then use actual wheel input in each editor.
  await page.evaluate(() => { const node = document.querySelector('.document-diff-body .cm-content'), view = node.cmTile.root.view; const from = view.state.doc.toString().indexOf('共同上下文 0900'); view.scrollDOM.scrollTop = view.lineBlockAt(from).top; });
  await tick(200);
  const contextLines = () => page.$$eval('.document-diff-body .cm-content', nodes => nodes.map(n => { const v = n.cmTile.root.view, b = v.lineBlockAtHeight(v.scrollDOM.scrollTop); return { text: v.state.doc.lineAt(b.from).text, top: v.scrollDOM.scrollTop }; }));
  const located=await contextLines();assert(located.every(line=>line.top>2000),JSON.stringify(located));assert.equal(located[0].text,located[1].text,JSON.stringify(located));
  for (const side of [0, 1]) {
    const box = await page.$eval('.document-diff-body .cm-mergeViewEditors', (n, side) => { const b = n.children[side].getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, side);
    await page.mouse.move(box.x, box.y); await page.mouse.wheel({ deltaY: side ? -370 : 470 }); await tick(350);
    const lines = await contextLines(); assert.equal(lines[0].text, lines[1].text, JSON.stringify(lines));assert(lines.every(line=>line.top>2000),JSON.stringify(lines));assert(Math.abs(lines[side].top-located[side].top)>50,JSON.stringify(lines)); report.metrics['wheelSide' + side] = lines;
  }
  await shot('04-long-context-aligned-scroll'); await closeDiff(); report.checks.push('actual wheel input from both sides keeps unchanged context aligned across 320 insertions and 130 deletions');
  await open('阅读.md'); await historical(1); await resize(520); await shot('05-history-diff-narrow');
  for (const id of ['diff-next', 'compare-mode', 'diff-mode', 'secondary-close', 'secondary-more']) {
    const b = await page.$eval('#' + id, n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }); assert(b.left >= 0 && b.right <= 520 && b.bottom <= 900, id + JSON.stringify(b));
  }
  await page.click('#secondary-more');await page.waitForSelector('#document-context-menu:not([hidden])');await page.click('#document-context-menu [data-command="comparison"]');await page.click('.nozeli-submenu [data-command="comparison-change"]');await page.waitForSelector('#beside-dialog[open]'); await page.waitForFunction(() => !document.querySelector('#beside-open').disabled); await shot('06-version-chooser-narrow'); await page.keyboard.press('Escape'); await closeDiff(); await resize(1440);
  report.checks.push('520px real native window has visible usable comparison controls and version chooser');
  await historical(0); const otherButton = await page.$('#recent button[title="另一个项目"]'); assert(otherButton); await otherButton.click();
  await page.waitForFunction(() => document.querySelector('#project-name').textContent === '另一个项目'); assert.equal(await page.$('.document-diff'), null);
  await page.click('#recent button[title="历史对比验收"]'); await page.waitForFunction(() => document.querySelector('#project-name').textContent === '历史对比验收'); await open('阅读.md');
  report.checks.push('project switch removes historical views and keeps each project independent');
  await page.click('#text-mode-toggle'); await page.waitForFunction(() => !document.querySelector('#text-host').hidden);
  await page.evaluate(() => __nozeliInput.select(10, 12)); const selectionBefore = await page.evaluate(() => __nozeliInput.selection());
  // A genuine external conflict leaves an unsaved buffer for comparison.
  await fs.writeFile(path.join(project, '阅读.md'), saved[2] + '\n外部进程修改\n');
  const draft = saved[2] + '\n尚未落盘的草稿\n'; await page.evaluate(text => __nozeliInput.replace(text), draft);
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'conflict');
  const selectionDraft = await page.evaluate(() => __nozeliInput.selection()); await historical(1); assert.deepEqual(await diffText(), [draft, saved[1]]);
  await shot('07-current-conflict-draft-diff'); await closeDiff(); assert.equal(await page.evaluate(() => __nozeliInput.text()), draft); assert.deepEqual(await page.evaluate(() => __nozeliInput.selection()), selectionDraft);
  await page.evaluate(() => __nozeliInput.focus()); await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  assert.equal(await page.evaluate(() => __nozeliInput.text()), saved[2]); await fs.writeFile(path.join(project, '阅读.md'), saved[2]);
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const resolvedDraft=await invoke('file.read',{projectId,relPath:'阅读.md'});assert.equal(resolvedDraft.ok,true);assert.equal(resolvedDraft.value.text,saved[2]);
  assert(!resolvedDraft.value.draft||resolvedDraft.value.draft.status==='saved');
  if(resolvedDraft.value.draft)assert.equal(resolvedDraft.value.draft.text,saved[2]);
  report.checks.push('conflicting unsaved draft is the left input; comparison preserves exact buffer, selection and undo while external file stays intact'); report.metrics.selectionBefore = selectionBefore;
  const beforeRestart = (await invoke('document.versions', { projectId, relPath: '阅读.md' })).value.total;
  await invoke('session.requestClose'); await Promise.race([exited, tick(12000).then(() => { throw Error('Normal close timed out'); })]); await browser.disconnect(); browser = null;
  child = launch(); attach(); await connect(); await resize(1440); await open('阅读.md');
  assert.equal((await invoke('document.versions', { projectId, relPath: '阅读.md' })).value.total, beforeRestart); await historical(1); assert.deepEqual(await diffText(), [saved[2], saved[1]]); await shot('08-restarted-history-diff'); await closeDiff();
  report.checks.push('normal application close and full process restart retain historical versions and comparison access');
  assert.deepEqual(report.errors, []); report.status = 'passed'; console.log(JSON.stringify(report));
} catch (error) { report.status = 'failed'; report.failure = error.stack; try { await shot('failed'); } catch {} throw error; }
finally {
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await fs.writeFile(path.join(out, 'electron.log'), log);
  try { if (browser && child.exitCode == null) await invoke('session.requestClose'); } catch {}
  await browser?.disconnect(); if (child?.exitCode == null) { let stopped = false; exited.then(() => stopped = true); await tick(1200); if (!stopped) child.kill('SIGTERM'); }
}
