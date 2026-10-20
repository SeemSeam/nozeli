import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, symlink, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'markdown-tag-stability-'));
// Isolated copy; fixture agents only, no paid Providers.
const root = path.join(output, 'app'); await mkdir(root);
for (const item of ['src','tools','package.json']) await cp(path.join(source,item),path.join(root,item),{recursive:true});
for (const item of ['node_modules','vendor','assets']) await symlink(path.join(source,item),path.join(root,item),'dir');
const panel = path.join(root,'src/renderer/agent-panel.mjs');
await writeFile(panel,(await readFile(panel,'utf8')).replace('async function loadProjectSettings(id, gen) {','async function loadProjectSettings(id, gen) { return;'));
const build = spawn(process.execPath,[path.join(root,'tools/build-renderer.mjs')],{cwd:root,stdio:'ignore'});
assert.equal(await new Promise(resolve=>build.once('exit',resolve)),0);
const project = path.join(output, 'project');
await mkdir(path.join(project, 'src'), { recursive: true });
await mkdir(path.join(project, 'dest'));
await writeFile(path.join(project,'sample.md'),'# Example\n\nTarget annotated paragraph.\n\nAnother paragraph for typing.\n');
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const electron = createRequire(import.meta.url)('electron');
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(electron, ['--inspect=0', '--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-0', NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
const exited = new Promise(resolve => child.once('exit', resolve));
let browser;
const checks = [];
try {
  const deadline = Date.now() + 20000;
  for (;;) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error('startup timeout\n' + log); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport:null });
  const page = (await browser.pages()).find(item => item.url().includes('127.0.0.1'));
  page.on('pageerror', error => console.error('RENDERER', error.stack));
  await page.waitForFunction(() => window.__nozeliReady, { polling: 100 });

  await page.click('#pick-project');
  await page.waitForSelector('#file-tree button');await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-toggle').click(); });
  const selector = rel => '#file-tree button[data-path="' + rel + '"]';
  await page.click(selector('sample.md'));
  await page.waitForFunction(()=>window.__nozeliInput?.text().includes('Target annotated'));
  await page.click('#text-mode-toggle'); // read -> split (default edit mode)
  await page.waitForSelector('#text-host .cm-content');
  await page.waitForSelector('#text-preview:not([hidden])');
  const splitNote = async () => {
    await page.evaluate(()=>{const t=__nozeliInput.text(),from=t.indexOf('Target');__nozeliInput.focus();__nozeliInput.select(from,from+6);});
    await page.waitForSelector('#selection-note',{visible:true});await page.click('#selection-note');
    await page.type('#note-input','Persistent note content');await page.click('#note-form button[type=submit]');
  };
  await splitNote();
  await page.waitForSelector('#text-host .note-anchor');
  await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
  await page.evaluate(()=>new Promise(r=>setTimeout(r,250)));
  const ownership = await page.evaluate(() => ({ left: document.querySelectorAll('#text-host .note-anchor').length, right: document.querySelectorAll('#text-preview .note-anchor').length }));
  assert.equal(ownership.left, 1, 'split keeps exactly one interactive card on the source editor');
  assert.equal(ownership.right, 0, 'split preview must not mount interactive cards');
  checks.push('split: single interactive note card lives on the left source editor only');

  // Typing + autosave must keep the unchanged left card identity and never
  // resurrect a right-side card through preview re-render.
  await page.evaluate(()=>{
    window.__tagBefore=document.querySelector('#text-host .note-anchor');
    window.__tagRemoved=0;
    window.__tagMutationObserver=new MutationObserver(records=>{for(const record of records)for(const removed of record.removedNodes)if(removed===__tagBefore||removed.contains?.(__tagBefore))__tagRemoved++;});
    __tagMutationObserver.observe(document.querySelector('#reader-scroll'),{childList:true,subtree:true});
    const n=__nozeliInput.text().length;__nozeliInput.select(n,n);__nozeliInput.focus();
  });
  await page.keyboard.type('typing while notes stay visible',{delay:30});
  await page.waitForFunction(()=>document.querySelector('#text-preview').textContent.includes('notes stay visible'));
  await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
  const typing=await page.evaluate(()=>({retained:__tagBefore===document.querySelector('#text-host .note-anchor'),removed:__tagRemoved,right:document.querySelectorAll('#text-preview .note-anchor').length}));
  assert.equal(typing.retained,true,'Unchanged left note card must survive typing/autosave');
  assert.equal(typing.removed,0,'Left note card must not be rebuilt by preview refresh');
  assert.equal(typing.right,0,'Preview must stay free of interactive cards after re-render');
  checks.push('typing/autosave keeps the left card identity; preview never mounts a card');

  // Anchor-change paths before the anchor: same single-owner expectations.
  await page.evaluate(()=>{
    window.__pathBefore=document.querySelector('#text-host .note-anchor');
    window.__pathState={removed:0,right:0};
    window.__pathObserver=new MutationObserver(records=>{for(const record of records)for(const removed of record.removedNodes)if(removed===__pathBefore||removed.contains?.(__pathBefore))__pathState.removed++;});
    __pathObserver.observe(document.querySelector('#reader-scroll'),{childList:true,subtree:true});
  });
  const identity=()=>page.evaluate(()=>({source:__pathBefore===document.querySelector('#text-host .note-anchor'),sourceNode:document.querySelector('#text-host .note-anchor')!==null,right:document.querySelectorAll('#text-preview .note-anchor').length}));
  const settle=async marker=>{await page.waitForFunction(m=>document.querySelector('#text-preview').textContent.includes(m),{},marker);await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');await page.evaluate(()=>new Promise(r=>setTimeout(r,250)));};
  await page.evaluate(()=>{window.__pathText=window.__nozeliInput.text();window.__nozeliInput.select(0,0);window.__nozeliInput.focus();});
  await page.keyboard.type('Inserted before anchor\n\n',{delay:15});
  await settle('Inserted before anchor');
  const afterInsert=await identity();
  assert.equal(afterInsert.source&&afterInsert.sourceNode&&afterInsert.right===0,true,'Insert before anchor keeps only the left card');
  await page.evaluate(()=>{window.__nozeliInput.select(0,'Inserted before anchor\n\n'.length);window.__nozeliInput.focus();});
  await page.keyboard.press('Delete');
  await settle('Target annotated');
  const afterDelete=await identity();
  assert.equal(afterDelete.source&&afterDelete.sourceNode&&afterDelete.right===0,true,'Delete before anchor keeps only the left card');
  let restored=false;
  for(let i=0;i<40&&!restored;i++){await page.keyboard.down('Control');await page.keyboard.press('z');await page.keyboard.up('Control');restored=await page.evaluate(t=>window.__nozeliInput.text()===t,await page.evaluate(()=>window.__pathText));}
  assert.ok(restored,'Undo must restore the pre-insert document text');
  await settle('Target annotated');
  const afterUndo=await identity();
  assert.equal(afterUndo.source&&afterUndo.sourceNode&&afterUndo.right===0,true,'Undo keeps only the left card');
  checks.push('anchor insert/delete/undo keep the single left card stable');
  await page.screenshot({path:path.join(output,'split-single-owner.png')});

  // Read mode owns the interactive projection on the reading surface.
  await page.click('#text-mode-toggle'); // split -> read
  await page.waitForSelector('#text-preview .note-anchor');
  const readState=await page.evaluate(()=>({leftHidden:document.querySelector('#text-host').hidden,leftVisibleCard:[...document.querySelectorAll('#text-host .note-anchor')].every(n=>n.offsetParent===null),right:document.querySelectorAll('#text-preview .note-anchor').length}));
  assert.equal(readState.leftHidden,true,'read mode hides the source editor');
  assert.ok(readState.leftVisibleCard,'left cards must not be visible in read mode');
  assert.equal(readState.right,1,'read mode shows exactly one interactive card');
  await page.screenshot({path:path.join(output,'read-single-owner.png')});
  checks.push('read mode shows the single interactive card on the reading surface');

  // Back to split: the right-side card must not survive the switch and the
  // left card returns with its collapsed/open state intact.
  const collapsedInRead=await page.evaluate(() => { const card=document.querySelector('#text-preview .note-anchor .note-projection'); return card ? card.classList.contains('is-collapsed') : null; });
  await page.click('#text-mode-toggle'); // read -> split
  await page.waitForSelector('#text-host .note-anchor');
  await page.waitForFunction(()=>document.querySelectorAll('#text-preview .note-anchor').length===0);
  const backToSplit=await page.evaluate(() => ({ left: document.querySelectorAll('#text-host .note-anchor').length, collapsed: document.querySelector('#text-host .note-anchor .note-projection')?.classList.contains('is-collapsed') }));
  assert.equal(backToSplit.left,1);
  assert.equal(backToSplit.collapsed, collapsedInRead, 'collapse state must transfer with the tag, not reset');
  checks.push('read->split removes right-side cards and restores the left card with its collapse state');

  // Discussion draft in split: type an unsent draft, cycle to read and back;
  // the draft text must survive on the same stable tag.
  await page.evaluate(()=>{const t=__nozeliInput.text(),from=t.indexOf('Another');__nozeliInput.focus();__nozeliInput.select(from,from+7);});
  await page.waitForSelector('#selection-discuss',{visible:true});await page.click('#selection-discuss');
  await page.waitForSelector('#text-host .tag-discuss .tag-editor');
  await page.type('#text-host .tag-discuss .tag-editor','Unsent split discussion draft');
  await page.click('#text-mode-toggle'); // split -> read
  await page.waitForSelector('#text-preview .tag-discuss .tag-editor');
  const readDraft=await page.evaluate(()=>document.querySelector('#text-preview .tag-discuss .tag-editor').value);
  assert.equal(readDraft,'Unsent split discussion draft','draft must appear in read mode');
  await page.click('#text-mode-toggle'); // read -> split
  await page.waitForSelector('#text-host .tag-discuss .tag-editor');
  const splitDraft=await page.evaluate(()=>({value:document.querySelector('#text-host .tag-discuss .tag-editor').value,right:document.querySelectorAll('#text-preview .tag-discuss').length}));
  assert.equal(splitDraft.value,'Unsent split discussion draft','draft must survive the mode round-trip');
  assert.equal(splitDraft.right,0,'no discussion card on the preview in split');
  checks.push('discussion draft survives split->read->split on the same tag with single ownership');

  // New note created from a right-preview selection in split mode must open
  // its editor on the left with an accurate source anchor.
  await page.evaluate(() => { const preview=document.querySelector('#text-preview'); const walker=document.createTreeWalker(preview,NodeFilter.SHOW_TEXT); let node; while((node=walker.nextNode())){ if(node.textContent.includes('Target annotated')){ const range=document.createRange(); const at=node.textContent.indexOf('Target'); range.setStart(node,at); range.setEnd(node,at+6); const sel=getSelection(); sel.removeAllRanges(); sel.addRange(range); preview.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0})); return true; } } return false; });
  await page.waitForSelector('#selection-note',{visible:true});await page.click('#selection-note');
  await page.type('#note-input','From preview selection');await page.click('#note-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelectorAll('#text-host .note-anchor').length===2);
  const previewOrigin=await page.evaluate(()=>({right:document.querySelectorAll('#text-preview .note-anchor').length,quotes:[...document.querySelectorAll('#text-host .note-anchor .tag-source blockquote')].map(n=>n.textContent)}));
  assert.equal(previewOrigin.right,0);
  assert.ok(previewOrigin.quotes.some(q=>q.includes('Target')),'preview-origin note anchors the selected source text');
  checks.push('note from a split preview selection anchors correctly and opens only on the left');

  await page.screenshot({path:path.join(output,'final-split.png')});
  const tagDir=path.join(project,'.nozeli','tags');const tagFiles=await readdir(tagDir).catch(()=>[]);
  let tagCount=0;for(const f of tagFiles){const data=JSON.parse(await readFile(path.join(tagDir,f),'utf8'));tagCount+=(data.tags||[]).length;}
  console.log(JSON.stringify({output,checks,tagRecords:tagCount}));
} finally {
  await browser?.disconnect();
  if(child.exitCode===null)child.kill('SIGTERM');
  const stopped=await Promise.race([exited.then(()=>true),new Promise(r=>setTimeout(()=>r(false),3000))]);
  if(!stopped){child.kill('SIGKILL');await exited;}
}
