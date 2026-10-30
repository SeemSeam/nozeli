import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createGuidedDemoHarness, stepIndex} from './guided-demo-live-helper.mjs';

process.env.NOZELI_TEST_BINARY ??= (await import('node:module')).createRequire(import.meta.url)('electron');
process.env.NOZELI_GUIDED_DEMO_ROOT ??= await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'nozeli-demo-interactions-'));
const h = await createGuidedDemoHarness({kind: 'interactions'});
const r = h.report;
let shell, controls;
console.log('EVIDENCE_ROOT=' + h.root);
const mark = (name, data = {}) => r.checks.push({name, ...data});
const active = async () => (await h.invoke(shell, 'workspace.bootstrap')).projectId;
const state = async id => h.invoke(shell, 'demo.state', {projectId: id ?? await active()});
const model = () => h.invoke(controls, 'workspace.bootstrap').then(value => value.model);
const click = async label => { const match = await h.until(() => controls.$$eval('[data-demo-control]', (nodes, label) => { const found = nodes.findIndex(node => node.textContent === label && !node.disabled); return found >= 0 ? found + 1 : null; }, label), 'enabled ' + label); const buttons = await controls.$$('[data-demo-control]'); await buttons[match - 1].click(); };
const paused = () => h.until(async () => { const value = await state(); const ready = await controls.$eval('[data-demo-control="play"]', node => !node.disabled); return value.session.status === 'paused' && ready ? value : null; }, 'paused settled session');
async function playUntil(predicate, label, timeout = 90000) {
  const act = async intent => { const m = await model(); return h.invoke(controls, 'workspace.demoControls.action', {sessionId: m.sessionId, epoch: m.epoch, controlId: 'play', intent}); };
  if ((await model()).status === 'playing') { await act('pause'); await paused(); }
  await act('play');
  await h.until(async () => (await model()).status === 'playing', 'resumed for ' + label);
  await h.until(predicate, label, timeout);
  await act('pause');
  return paused();
}
async function startFromSettings(){await shell.click('#open-settings');await shell.click('[data-settings-section="settings-help"]');await shell.click('#settings-demo-help');({page:controls}=await h.scope(s=>s.role==='demo-controls'));await h.until(async()=>{const value=await h.invoke(controls,'workspace.bootstrap');return value.visible&&value.model.status==='playing';},'learning starts from settings');return controls;}
async function launch() { await h.launch(); ({page: shell} = await h.scope(s => s.role === 'shell')); if (await shell.$eval('#configuration-setup', e => e.open).catch(() => false)) await shell.click('#configuration-cancel'); }

try {
  const originalRoot = path.join(h.root, 'original-work');
  await fs.mkdir(originalRoot);
  await fs.writeFile(path.join(originalRoot, 'original.txt'), 'ORIGINAL_SENTINEL\n' + Array.from({length: 160}, (_, i) => 'Original line ' + i).join('\n'));
  await h.setPickDirectory(originalRoot);

  await launch();
  controls = await h.startLearning(shell);
  const id = await active();
  await click('暂停');
  const before = await paused();
  const notes = path.join(before.project.rootDisplay, 'research-notes.md');
  const initial = await fs.readFile(notes, 'utf8');
  await h.auditIsolation();
  await h.closeNormally(shell);
  await launch();
  if (await active() !== id) await shell.click('[data-project-id="' + id + '"]');
  ({page: controls} = await h.scope(s => s.role === 'demo-controls'));
  let current = await paused();
  assert.equal(current.session.id, before.session.id, 'restart must keep the same session');
  assert(current.session.epoch > before.session.epoch, 'restart must advance the epoch');
  assert.equal(await fs.readFile(notes, 'utf8'), initial, 'restart must not replay edits');
  mark('normal restart remains paused without replay', {id});

  await h.seek(controls, 0, 'seek back to the opening step');
  current = await playUntil(async () => { const windows = await h.invoke(shell, 'workspace.windows.list', {projectId: id}); return windows.some(window => window.surfaces.some(surface => surface.relPath === 'research-notes.md' && surface.visible)); }, 'research notes surface opens');
  current = await playUntil(async () => (await fs.readFile(notes, 'utf8')).includes('（我的补充）采样时段已核对'), 'human edit lands on disk');
  const edited = await fs.readFile(notes, 'utf8');
  assert.equal((edited.match(/（我的补充）采样时段已核对/g) || []).length, 1, 'human edit must save exactly once');
  mark('human edit saves exactly once');
  await fs.writeFile(path.join(before.project.rootDisplay, 'my-exploration.txt'), 'KEEP_EXPLORATION');
  await h.seek(controls, stepIndex('human-edit'), 'seek back over an already edited step');
  current = await playUntil(async () => (await state(id)).session.stepIndex > stepIndex('human-edit'), 'already executed edit step is skipped, not replayed');
  assert.equal(await fs.readFile(notes, 'utf8'), edited, 'replay must not duplicate or overwrite edits');
  assert.equal(await fs.readFile(path.join(before.project.rootDisplay, 'my-exploration.txt'), 'utf8'), 'KEEP_EXPLORATION');
  mark('seeking back preserves exploration and skips changed-file actions');

  await click('结束演示');
  await h.until(async () => await active() === null && (await h.invoke(shell, 'demo.state', {})).projects.length === 0, 'ending removes demo and restores empty workspace');
  assert.equal(await fs.readFile(path.join(before.project.rootDisplay, 'my-exploration.txt'), 'utf8'), 'KEEP_EXPLORATION');
  mark('ending automatically removes the demo entry and preserves files');

  await shell.click('#pick-project');
  await h.until(async () => await active() !== null, 'normal project selection');
  const normalId = await active();
  assert.equal((await state(normalId)).isDemo, false);
  await shell.waitForSelector('#file-tree button[data-path="original.txt"]');
  await shell.click('#file-tree button[data-path="original.txt"]');
  let original = await h.scope(s => s.projectId === normalId && s.relPath === 'original.txt');
  await original.page.click('#text-host .cm-content');
  await original.page.keyboard.type('KEEP_ORIGINAL_EDIT ');
  const scroll = await original.page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const candidates = ['#reader-scroll', '#text-host .cm-scroller'];
    const selector = candidates.find(selector => { const node = document.querySelector(selector); return node && node.scrollHeight > node.clientHeight + 10; }) || '#text-host .cm-scroller';
    const node = document.querySelector(selector); node.scrollTop = 320; return {selector, top: node.scrollTop};
  });
  const savedScroll = scroll.top, viewId = original.scope.viewId;

  controls=await startFromSettings();
  const learnId = await active();
  assert.notEqual(learnId, normalId, 'learning must use its own project');
  await h.seek(controls, stepIndex('finish'), 'seek to the final step from an original project');
  await h.until(async () => await active() === normalId && !(await h.invoke(controls, 'workspace.bootstrap')).visible, 'finish exits back to the original project', 90000);
  original = await h.scope(s => s.projectId === normalId && s.relPath === 'original.txt');
  assert.equal(original.scope.viewId, viewId, 'original surface identity must survive the demo');
  assert((await original.page.$eval('#text-host .cm-content', e => e.textContent)).includes('KEEP_ORIGINAL_EDIT '), 'unsaved buffer must survive the demo');
  mark('original unsaved buffer is preserved before explicit save', {onDiskBeforeSave: (await fs.readFile(path.join(originalRoot, 'original.txt'), 'utf8')).includes('KEEP_ORIGINAL_EDIT')});
  const restoredScroll = await original.page.$eval(scroll.selector, node => node.scrollTop);
  assert(Math.abs(restoredScroll - savedScroll) <= 2, 'Original reading position changed');
  await original.page.evaluate(() => window.__nozeliInput.focus());
  await original.page.keyboard.down('Control'); await original.page.keyboard.press('s'); await original.page.keyboard.up('Control');
  await h.until(async () => (await fs.readFile(path.join(originalRoot, 'original.txt'), 'utf8')).includes('KEEP_ORIGINAL_EDIT '), 'original edit remains saved');
  mark('original non-demo document and edit restored', {projectId: normalId});
  await h.capture(shell, 'original-work-restored', {projectId: normalId});

  controls=await startFromSettings();
  const resultId = await active();
  await h.seek(controls, stepIndex('task-a-done'), 'seek to the first task completion');
  current = await playUntil(async () => (await state(resultId)).todos.some(todo => todo.kind === 'result'), 'task A enters the todo list');
  const todo = current.todos.find(todo => todo.kind === 'result');
  const source = await h.invoke(shell, 'managed.history.read', {projectId: resultId, objectId: todo.objectId});
  const reportFile = path.join(current.project.rootDisplay, 'report.html');
  await fs.appendFile(reportFile, '<p>USER_EXPLORED_CURRENT_REPORT</p>');
  const frozenReport = await h.invoke(shell, 'managed.history.read', {projectId: resultId, objectId: todo.objectId});
  assert.equal(frozenReport.body, source.body, 'frozen report must not track later edits');
  assert(!frozenReport.body.includes('USER_EXPLORED_CURRENT_REPORT'));

  await h.seek(controls, stepIndex('review-accept'), 'seek to the accept decision');
  current = await playUntil(async () => { const value = await state(resultId); return value.todos.find(item => item.id === todo.id)?.status === 'resolved'; }, 'accept closes the reviewed task');
  assert.equal(current.todos.find(item => item.id === todo.id).resolution.choice, 'accept');
  assert((await fs.readFile(reportFile, 'utf8')).includes('USER_EXPLORED_CURRENT_REPORT'), 'acceptance must not rewrite the explored file');
  mark('acceptance is a real decision and the frozen report preserves original bytes');
  await h.capture(shell, 'accepted-frozen-report');
  await h.auditIsolation();
  assert.deepEqual(r.errors, []);
  await h.closeNormally(shell);
  r.ok = true;
} catch (error) {
  r.failure = error.stack || String(error);
  console.log(r.failure);
  if (shell) { await shell.screenshot({path: path.join(h.root, 'failure.png')}).catch(() => {}); r.visible = await shell.evaluate(() => document.body.innerText.slice(-4000)).catch(() => null); }
  await h.auditIsolation().catch(e => r.auditFailure = String(e));
  await h.cleanupAfterFailure();
  process.exitCode = 1;
} finally {
  await h.save();
  console.log(JSON.stringify({root: h.root, ok: r.ok, checks: r.checks, failure: r.failure, visible: r.visible, errors: r.errors}, null, 2));
}
