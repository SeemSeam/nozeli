import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { FileTags } from '../src/domain/file-tags.mjs';

const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, '.test-output'), { recursive: true });
const output = await mkdtemp(path.join(root, '.test-output', 'tag-stability-'));
const project = path.join(output, 'project'); await mkdir(project);
const source = '前言\n目标😀文字\n结尾';
await writeFile(path.join(project, 'test.txt'), source);
await writeFile(path.join(project, 'other.txt'), 'another file');
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const require = createRequire(import.meta.url), ozone = process.env.NOZELI_OZONE || (process.env.WAYLAND_DISPLAY ? 'wayland' : 'headless');
const child = spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], { cwd: root, env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone }, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(resolve => child.once('exit', resolve)); let log = '', browser; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
const checks = [];
try {
  const deadline = Date.now() + 20000;
  for (;;) { if (child.exitCode !== null || child.signalCode) throw new Error(log); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error('Startup timeout: ' + log); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }); const page = await waitForDesktopPage(browser);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__nozeliReady); await page.setViewport({ width: 1200, height: 800 });await prepareReading(page);await page.click('#pick-project');
  await page.click('#file-tree button[data-path="test.txt"]'); await page.waitForFunction(() => window.__nozeliInput.text().includes('目标'));
  // Create through the real selection / note UI, not a simulated annotation layer.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => { document.querySelector('.cm-content').focus(); window.__nozeliInput.select(3, 9); });

  await page.waitForSelector('#selection-note', { visible: true });
  await page.click('#selection-note'); await page.type('#note-input', '稳定备注'); await page.click('#note-form button[type="submit"]');
  await page.waitForSelector('.note-anchor.tag-note');
  const noteId = await page.$eval('.note-anchor.tag-note', el => el.dataset.annotation);
  const store = new FileTags(project);
  const waitTag = async predicate => {
    const deadline = Date.now() + 10000;
    for (;;) { const file = await store.read('test.txt'); const tag = file?.tags.find(tag => tag.id === noteId); if (predicate(tag, file)) return tag; if (Date.now() > deadline) throw new Error('Tag persistence timeout: ' + JSON.stringify(tag)); await new Promise(resolve => setTimeout(resolve, 50)); }
  };
  const before = await waitTag(tag => tag?.note === '稳定备注'); checks.push('real text selection creates project sidecar');
  await page.evaluate(() => { document.querySelector('.cm-content').focus(); window.__nozeliInput.select(0, 0); }); await page.keyboard.type('prefix'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved' && window.__nozeliInput.text().startsWith('prefix'));
  const shifted = await waitTag(tag => Object.values(tag?.resolutions || {}).some(r => r.anchor?.start === 10));
  assert.equal(shifted.anchor.start, before.anchor.start); assert.equal(shifted.materialDigest, before.materialDigest);
  assert.equal(await page.$eval('.text-note', el => el.textContent), '目标😀文字'); checks.push('keyboard insertion shifts label while preserving original anchor');
  // Delete the annotated span through CodeMirror's real keyboard handling.
  await page.evaluate(() => { document.querySelector('.cm-content').focus(); window.__nozeliInput.select(10, 16); }); await page.keyboard.press('Backspace');
  await page.waitForFunction(() => !document.querySelector('#unlocated-tags').hidden);
  assert.match(await page.$eval('#unlocated-tags', el => el.textContent), /稳定备注/); assert.equal(await page.$('.text-note'), null);
  await page.click('#unlocated-tags summary'); await page.screenshot({ path: path.join(output, 'deleted-range.png'), fullPage: true });
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved'); checks.push('deleted range remains readable without attaching to neighbour');
  await page.evaluate(() => document.querySelector('.cm-content').focus()); await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('.text-note')?.textContent === '目标😀文字');
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved'); checks.push('undo restores same tag and position');
  await page.evaluate(() => window.__nozeliInput.select(10, 16)); await page.click('#selection-discuss'); await page.waitForSelector('.note-anchor.tag-discuss');
  const discussionId = await page.$eval('.note-anchor.tag-discuss', el => el.dataset.annotation);
  await page.$eval(`.note-anchor[data-annotation="${discussionId}"] .tag-editor`, el => { el.value = '持久讨论草稿'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const noteSelectorBeforeReload = `.note-anchor[data-annotation="${noteId}"]`;
  await page.click(noteSelectorBeforeReload + ' .note-index');
  await page.click(noteSelectorBeforeReload + ' .tag-edit');
  await page.type(noteSelectorBeforeReload + ' .tag-editor', ' UNSENT_LOCAL_NOTE_ALPHA');
  const localEditDraft = await page.$eval(noteSelectorBeforeReload + ' .tag-editor', el => el.value);
  const assertDistinctSourceIndices = async () => {
    const targets = await page.evaluate(ids => ids.map(id => {
      const node = document.querySelector(`#text-host .note-anchor[data-annotation="${id}"] .note-index`);
      const rect = node.getBoundingClientRect();
      return {left:rect.left,right:rect.right,hit:document.elementFromPoint(rect.left + rect.width / 2,rect.top + rect.height / 2) === node};
    }), [noteId, discussionId]);
    assert(targets.every(target => target.hit), 'Each same-offset source index receives its own physical click');
    assert(targets[0].right <= targets[1].left || targets[1].right <= targets[0].left, 'Same-offset source indices do not overlap');
  };
  await assertDistinctSourceIndices();
  await page.click(`.note-anchor[data-annotation="${discussionId}"] .note-index`);
  assert.equal(await page.$eval(`.note-anchor[data-annotation="${discussionId}"] .tag-editor`, el => el.value), '持久讨论草稿');
  // Double click collapse persists for both tag forms.
  for (const id of [noteId, discussionId]) await page.$eval(`.note-anchor[data-annotation="${id}"] .note-projection-head`, el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  const deadline2 = Date.now() + 10000;
  for (;;) { const file = await store.read('test.txt'); if (file.tags.find(t => t.id === noteId)?.view?.collapsed && file.tags.find(t => t.id === discussionId)?.projection?.open === false && file.tags.find(t => t.id === discussionId)?.projection?.draftText === '持久讨论草稿') break; if (Date.now() > deadline2) throw new Error('Collapsed state not persisted'); await new Promise(resolve => setTimeout(resolve, 50)); }
  await page.reload(); await prepareReading(page); await page.waitForSelector(`.note-anchor[data-annotation="${noteId}"]`);
  for (const id of [noteId, discussionId]) assert.equal(await page.$eval(`.note-anchor[data-annotation="${id}"] .note-projection`, el => el.classList.contains('is-collapsed')), true);
  assert.equal((await store.read('test.txt')).tags.find(t => t.id === discussionId).projection.draftText, '持久讨论草稿'); checks.push('renderer restart restores notes, discussion draft and collapsed state');
  await assertDistinctSourceIndices();
  await page.click(noteSelectorBeforeReload + ' .note-index');
  await page.click(noteSelectorBeforeReload + ' .tag-edit');
  assert.equal(await page.$eval(noteSelectorBeforeReload + ' .tag-editor', el => el.value), localEditDraft);
  await page.click(noteSelectorBeforeReload + ' .tag-close');
  await page.click(`.note-anchor[data-annotation="${discussionId}"] .note-index`);
  assert.equal(await page.$eval(`.note-anchor[data-annotation="${discussionId}"] .tag-editor`, el => el.value), '持久讨论草稿');
  await page.click(`.note-anchor[data-annotation="${discussionId}"] .tag-close`);
  checks.push('same-offset source indices remain physically distinct and restore local/discussion drafts after restart');
  await page.screenshot({ path: path.join(output, 'restored.png'), fullPage: true });
  assert.equal(await readFile(path.join(project, 'test.txt'), 'utf8'), 'prefix\n' + source);
  await writeFile(path.join(project, 'test.txt'), '目标😀文字 / 目标😀文字');
  await page.reload(); await prepareReading(page);
  await page.waitForFunction(() => document.querySelector('#unlocated-tags') && !document.querySelector('#unlocated-tags').hidden);
  assert.equal(await page.$('.text-note'), null); await page.click('#unlocated-tags summary');
  await page.evaluate(() => { document.querySelector('.cm-content').focus(); window.__nozeliInput.select(0, 6); });
  await page.click('#unlocated-tags .tag-relocate'); await page.waitForSelector('.text-note');
  const relocated = (await store.read('test.txt')).tags.find(tag => tag.id === noteId);
  assert.equal(relocated.anchor.quote, '目标😀文字'); assert.equal(Object.values(relocated.resolutions).some(r => r.method === 'manual' && r.anchor.start === 0), true);
  checks.push('external duplicate quotes require verified manual relocation');
  const activeProject=await page.evaluate(async()=>(await nozeli.invoke('project.recent')).value.projects[0].id);
  const noteSelector=`.note-anchor[data-annotation="${noteId}"]`;
  if(await page.$eval(noteSelector+' .note-projection',el=>el.classList.contains('is-collapsed')))await page.click(noteSelector+' .note-index');
  await page.click(noteSelector+' .tag-edit');
  await page.type(noteSelector+' .tag-editor',' DELETE_DRAFT');
  await page.waitForFunction(async({projectId,id})=>(await nozeli.invoke('state.read',{projectId})).value.state.workspace.noteDrafts.some(d=>d.annotationId===id),{}, {projectId:activeProject,id:noteId});
  await page.click(noteSelector+' .tag-delete');
  await page.waitForSelector('#action-confirmation[open]');
  await page.click('#action-confirmation-accept');
  await page.waitForFunction(async({projectId,id})=>{const a=await nozeli.invoke('annotation.list',{projectId,relPath:'test.txt'}),v=await nozeli.invoke('state.read',{projectId});return !a.value.annotations.some(n=>n.id===id)&&!v.value.state.workspace.noteDrafts.some(d=>d.annotationId===id);},{},{projectId:activeProject,id:noteId});
  checks.push('explicit note deletion removes its durable edit draft only after annotation removal');
  await page.evaluate(()=>{document.querySelector('.cm-content').focus();__nozeliInput.select(0,6);});
  await page.click('#selection-note');await page.type('#note-input','capacity note');await page.click('#note-form button[type="submit"]');
  await page.waitForSelector('.note-anchor.tag-note');
  const capacityId=await page.$eval('.note-anchor.tag-note',el=>el.dataset.annotation);
  const frozen=await page.evaluate(async({projectId,id})=>(await nozeli.invoke('annotation.list',{projectId,relPath:'test.txt'})).value.annotations.find(n=>n.id===id),{projectId:activeProject,id:capacityId});
  const capacityState=await page.evaluate(async({projectId,note})=>{const view=(await nozeli.invoke('state.read',{projectId})).value.state;view.workspace.noteDrafts=Array.from({length:40},(_,i)=>({projectId,annotationId:crypto.randomUUID(),baselineUpdatedAt:note.updatedAt,relPath:note.relPath,materialDigest:note.materialDigest,kind:note.kind,anchor:note.anchor,text:'capacity '+i,updatedAt:i}));const saved=await nozeli.invoke('state.write',{projectId,state:view});if(!saved.ok)throw Error(saved.error.message);return view.workspace.noteDrafts;},{projectId:activeProject,note:frozen});
  await page.reload();await prepareReading(page);await page.waitForSelector('.note-anchor.tag-note .tag-edit');
  await page.click('.note-anchor.tag-note .tag-edit');await page.type('.note-anchor.tag-note .tag-editor',' MEMORY_ONLY_CAPACITY');
  await page.waitForFunction(()=>document.body.textContent.includes('备注编辑草稿未持久化'));
  assert((await page.$eval('.note-anchor.tag-note .tag-editor',el=>el.value)).includes('MEMORY_ONLY_CAPACITY'));
  const afterCapacity=await page.evaluate(async projectId=>(await nozeli.invoke('state.read',{projectId})).value.state.workspace.noteDrafts,activeProject);
  assert.deepEqual(afterCapacity,capacityState);assert.equal((await store.read('test.txt')).tags.find(t=>t.id===capacityId).note,'capacity note');
  await page.type('#composer','MAIN_DRAFT_WITH_OVERFLOW');
  await page.waitForFunction(async projectId=>(await nozeli.invoke('state.read',{projectId})).value.state.workspace.draft==='MAIN_DRAFT_WITH_OVERFLOW',{},activeProject);
  await page.click('#file-tree button[data-path="other.txt"]');
  await page.waitForFunction(()=>window.__lastOpen?.step==='flush-failed'&&window.__lastOpen?.error?.code==='NOTE_DRAFT_CAPACITY');
  assert.equal(await page.$eval('#file-path',el=>el.textContent),'test.txt');
  assert((await page.$eval('.note-anchor.tag-note .tag-editor',el=>el.value)).includes('MEMORY_ONLY_CAPACITY'));
  const overflowText=await page.$eval('.note-anchor.tag-note .tag-editor',el=>el.value);
  const saveButton=await page.$$('.note-anchor.tag-note .tag-composer .tag-send');
  await saveButton[0].click();
  await waitTag((_tag,file)=>file.tags.find(t=>t.id===capacityId)?.note===overflowText);
  await page.click('#file-tree button[data-path="other.txt"]');
  await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='other.txt');
  const recovered=await page.evaluate(async projectId=>(await nozeli.invoke('state.read',{projectId})).value.state,activeProject);
  assert.deepEqual(recovered.workspace.noteDrafts,capacityState);assert.equal(recovered.workspace.draft,'MAIN_DRAFT_WITH_OVERFLOW');
  checks.push('overflow edit does not poison main draft persistence, blocks file switching until explicit save, and preserves all durable drafts');
  checks.push('40-draft capacity reports persistence failure, preserves memory input and evicts no durable draft');
  assert.deepEqual(errors, []); console.log(JSON.stringify({ output, checks }));
} finally {
  await browser?.disconnect(); if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  let timer; const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]); clearTimeout(timer); if (!stopped) { child.kill('SIGKILL'); await exited; }
}
