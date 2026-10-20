import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, symlink, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'renderer-collaboration-'));
const root = path.join(output, 'app'); await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) await cp(path.join(source, item), path.join(root, item), { recursive: true });
for (const item of ['node_modules', 'vendor', 'assets']) await symlink(path.join(source, item), path.join(root, item), 'dir');
// The fixture owns its app/profile/project and exposes production collaboration
// operations without starting a Provider or opening a user project.
const app = path.join(root, 'src/renderer/app.mjs');
await writeFile(app, (await readFile(app, 'utf8')) + `\nwindow.__collaborationFixture = {
  snapshot: () => ({ text:ui.editor.adapter.getText(), digest:ui.baseDigest, selection:ui.editor.adapter.getSelection(), scroll:ui.editor.adapter.getScrollTop(), dirty:ui.dirty, authorship:ui.file.authorship }),
  prepare(edits) {
    const changes=ChangeSet.of(edits,ui.lastSavedText.length),text=changes.apply(ui.editor.state.doc).toString();
    return {projectId:ui.project.id,relPath:ui.file.relPath,beforeDigest:ui.baseDigest,digest:ui.baseDigest+'-agent',materialDigest:ui.materialDigest,text,changes:changes.toJSON(),authorship:{...ui.file.authorship,digest:ui.baseDigest+'-agent'}};
  },
  accept:event=>enqueue(()=>applyDocumentEvent(event)),
  edit:edit=>{ui.editor.adapter.applyEdit(edit);clearTimeout(ui.timer);clearTimeout(ui.maxTimer);},
  flush:()=>flushCurrent(),
  undo:()=>{ui.editor.adapter.undo();clearTimeout(ui.timer);clearTimeout(ui.maxTimer);},
  select:(a,b)=>ui.editor.adapter.setSelection(a,b),
  scroll:n=>ui.editor.adapter.setScrollTop(n)
};\n`);
const build = spawn(process.execPath, [path.join(root, 'tools/build-renderer.mjs')], { cwd: root, stdio: 'inherit' });
assert.equal(await new Promise(resolve => build.once('exit', resolve)), 0);
const project = path.join(output, 'project'); await mkdir(project);
const original = '# Collaboration\n\nremove me\n\nfirst target\n\nsecond target\n\n' + Array.from({ length: 120 }, (_, i) => `paragraph ${i}\n`).join('\n');
await writeFile(path.join(project, 'sample.md'), original);
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const electron = createRequire(import.meta.url)('electron'), ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(electron, ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root, env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_OZONE: ozone }, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const exited = new Promise(resolve => child.once('exit', resolve)); let browser;
try {
  const deadline = Date.now() + 25000;
  for (;;) { if (child.exitCode !== null) throw new Error(logs); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error(logs); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  const page = await waitForDesktopPage(browser);
  await page.waitForFunction(() => window.__nozeliReady);
  await prepareReading(page);
  await page.click('#pick-project'); await page.waitForSelector('#file-tree button'); await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-toggle').click(); });
  await page.click('#file-tree button[data-path="sample.md"]'); await page.waitForFunction(() => window.__nozeliInput?.text().includes('first target'));
  await page.click('#text-mode-toggle');
  const observation = await page.evaluate(async () => {
    const fixture = __collaborationFixture, base = fixture.snapshot().text;
    const dom = document.querySelector('#text-host .cm-editor');
    const event = fixture.prepare([{from:base.indexOf('first'),to:base.indexOf('first')+5,insert:'AGENT ONE'},{from:base.indexOf('second'),to:base.indexOf('second')+6,insert:'AGENT TWO'}]);
    fixture.edit({from:0,insert:'human prefix\n'});
    const deletion = fixture.snapshot().text.indexOf('remove me');
    fixture.edit({from:deletion,to:deletion+'remove me\n'.length,insert:''});
    const start = fixture.snapshot().text.indexOf('paragraph 20'); fixture.select(start,start+9); fixture.scroll(300);
    const before = fixture.snapshot(); await fixture.accept(event); const merged = fixture.snapshot();
    const retained = dom === document.querySelector('#text-host .cm-editor');
    fixture.undo(); fixture.undo(); const undone = fixture.snapshot();
    // Native composition events exercise the production app's composition gate.
    const content = document.querySelector('#text-host .cm-content');
    content.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'}));
    const imeEvent = fixture.prepare([{from:0,to:0,insert:'IME AGENT\n'}]);
    await fixture.accept(imeEvent); const deferred = fixture.snapshot().text === undone.text;
    content.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}));
    await new Promise(resolve=>setTimeout(resolve,100));
    return {before,merged,undone,retained,deferred,afterIME:fixture.snapshot(),preview:document.querySelector('#text-preview').textContent};
  });
  assert.equal(observation.retained, true, 'existing editor DOM is retained');
  assert.match(observation.merged.text, /^human prefix/);
  assert.doesNotMatch(observation.merged.text, /remove me/);
  assert.match(observation.merged.text, /AGENT ONE target\n\nAGENT TWO target/);
  assert.equal(observation.merged.selection.anchor, observation.before.selection.anchor + 7);
  assert.equal(observation.merged.selection.head, observation.before.selection.head + 7);
  assert.ok(Math.abs(observation.merged.scroll-observation.before.scroll)<2, 'scroll remains stable for changes below/near viewport');
  assert.equal(observation.merged.authorship.digest, observation.merged.digest);
  assert.equal(observation.undone.text, original.replace('first','AGENT ONE').replace('second','AGENT TWO'));
  assert.equal(observation.deferred, true, 'remote event is deferred during composition');
  assert.match(observation.afterIME.text, /^IME AGENT/);
  await page.click('#text-mode-toggle');
  await page.waitForFunction(() => document.querySelector('#text-preview').textContent.includes('AGENT ONE'));
  await writeFile(path.join(output, 'observations.json'), JSON.stringify(observation, null, 2));
  await page.screenshot({ path: path.join(output, 'collaboration.png') });
  console.log(JSON.stringify({ output, passed: true }));
} finally {
  await browser?.disconnect(); if (child.exitCode === null) child.kill('SIGTERM');
  if (!await Promise.race([exited.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),3000))])) { child.kill('SIGKILL'); await exited; }
}
