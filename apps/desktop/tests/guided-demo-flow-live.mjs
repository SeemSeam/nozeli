import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {demoSteps} from '../src/domain/guided-demo.mjs';
import {createGuidedDemoHarness, expectedStepIds, stepIndex} from './guided-demo-live-helper.mjs';

process.env.NOZELI_TEST_BINARY ??= (await import('node:module')).createRequire(import.meta.url)('electron');
process.env.NOZELI_GUIDED_DEMO_ROOT ??= await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'nozeli-demo-flow-'));
const harness = await createGuidedDemoHarness({kind: 'flow'});
const {report} = harness;
let shell, controls;
const mark = (name, evidence = {}) => report.checks.push({name, ...evidence});
const active = async () => (await harness.invoke(shell, 'workspace.bootstrap')).projectId;
const state = async () => harness.invoke(shell, 'demo.state', {projectId: await active()});

try {
  await harness.launch();
  ({page: shell} = await harness.scope(scope => scope.role === 'shell', 'real shell'));
  if (await shell.$eval('#configuration-setup', element => element.open).catch(() => false)) await shell.click('#configuration-cancel');

  controls = await harness.startLearning(shell);
  const projectId = await active();
  report.projectId = projectId;
  assert((await harness.invoke(controls, 'workspace.bootstrap')).model.stepTotal === expectedStepIds.length, 'flow length must match the shipped catalog');
  const {page: hint} = await harness.scope(scope => scope.role === 'demo-hint', 'native step hint');
  await harness.until(async () => { const value = await harness.invoke(hint, 'workspace.bootstrap'); return value.model?.visible ? value : null; }, 'preparation card appears on its own top view');
  const reading0 = await harness.until(async () => {
    const model = (await harness.invoke(hint, 'workspace.bootstrap')).model;
    return model?.visible && model.phase === 'reading' && model.stepIndex === 0 && model.title === demoSteps[0].hintTitle ? model : null;
  }, 'explanation waits for the first real action receipt', 30000);
  assert(await shell.$eval('[data-demo-guide-target]', node => node.dataset.demoGuideTarget === 'project'), 'interface region is highlighted before its explanation');
  await hint.screenshot({path: path.join(harness.root, 'hint-card.png')});
  mark('one entry, direct start, explanation only after the real open', {reading: reading0.title});

  await harness.until(async () => { const value = await harness.invoke(hint, 'workspace.bootstrap'); return value.model?.visible ? value : null; }, 'hint visible before pausing', 30000);
  await controls.click('[data-demo-control="play"]');
  await harness.until(async () => (await harness.invoke(controls, 'workspace.bootstrap')).model.status === 'paused', 'pause during a hint');
  const pausedHint = await harness.until(async () => {
    const model = (await harness.invoke(hint, 'workspace.bootstrap')).model;
    return model?.visible && model.paused ? model : null;
  }, 'paused hint freezes on screen');
  assert.equal(pausedHint.paused, true, 'paused hint must freeze its countdown');

  const frontdesk = stepIndex('frontdesk-ask');
  await harness.seek(controls, frontdesk, 'single seek while paused');
  await harness.until(async () => {
    const model = (await harness.invoke(controls, 'workspace.bootstrap')).model;
    return model.stepIndex === frontdesk && model.status === 'paused' ? model : null;
  }, 'paused seek lands on the target without playing');
  const landedHint = await harness.until(async () => {
    const model = (await harness.invoke(hint, 'workspace.bootstrap')).model;
    return model?.visible && model.phase === 'acting' && model.stepIndex === frontdesk && model.paused ? model : null;
  }, 'paused seek shows only the neutral preparation for the target');
  assert.notEqual(landedHint.title, demoSteps[frontdesk].hintTitle, 'a paused seek must not publish the target explanation early');
  const pausedControls = (await harness.invoke(controls, 'workspace.bootstrap')).model;
  assert.notEqual(pausedControls.title, demoSteps[frontdesk].hintTitle, 'controls title must not lead the content either');
  await controls.click('[data-demo-control="play"]');
  await harness.until(async () => (await harness.invoke(controls, 'workspace.bootstrap')).model.status === 'playing', 'explicit resume after a paused seek');
  await harness.until(async () => (await state()).messages.some(message => message.text.includes('两种方法是否在同一时段观测')), 'frontdesk quick answer appears in conversation');
  const frontdeskReading = await harness.until(async () => {
    const model = (await harness.invoke(hint, 'workspace.bootstrap')).model;
    return model?.visible && model.phase === 'reading' && model.stepIndex === frontdesk && model.title === demoSteps[frontdesk].hintTitle ? model : null;
  }, 'explanation appears only after the answer is on screen');
  await harness.invoke(hint, 'workspace.demoHint.dismiss', {key: frontdeskReading.key});
  await harness.until(async () => (await harness.invoke(controls, 'workspace.bootstrap')).model.stepIndex > frontdesk, 'skipping the reading advances to the next step');
  mark('paused seek withholds the explanation until the real answer lands; reading is skippable', {reading: frontdeskReading.title});

  await harness.until(async () => (await state()).messages.some(message => message.text.includes('已提交后台任务')), 'task handoff appears in conversation');
  mark('the composer submits through the offline background-task route');

  const v1=await harness.until(async()=> (await state()).todos.find(todo=>todo.kind==='result'),'V1 result todo');
  const v2=await harness.until(async()=> (await state()).todos.find(todo=>todo.kind==='result'&&todo.objectId!==v1.objectId),'V2 follows explicit report discussion',120_000);
  assert.ok(v1.workId,'the fixture todo must identify its Work');
  assert.equal(v2.workId,v1.workId);assert.deepEqual([v1.revision,v2.revision],[1,2]);
  await harness.until(async()=> (await state()).todos.find(todo=>todo.id===v2.id)?.status==='resolved','accept resolves V2',90_000);
  const finalTodos=(await state()).todos;
  assert.notEqual(finalTodos.find(todo=>todo.id===v1.id)?.status,'open');
  assert.notEqual(finalTodos.find(todo=>todo.id===v1.id)?.resolution?.choice,'accept');
  assert.equal(finalTodos.find(todo=>todo.id===v2.id)?.resolution?.choice,'accept');
  mark('the original work retains V1 and accepts only the reviewed V2');

  await harness.until(() => shell.$eval('#settings-dialog', dialog => dialog.open), 'settings dialog opens for the tour', 150_000);
  await shell.screenshot({path: path.join(harness.root, 'settings-tour.png')});
  await harness.until(async () => {
    const open = await shell.$eval('#settings-dialog', dialog => dialog.open);
    return !open && (await harness.invoke(controls, 'workspace.bootstrap')).model.stepIndex >= stepIndex('finish');
  }, 'flow closes settings itself and reaches the final step');
  mark('settings tour opens provider section and the flow closes it');

  await harness.until(async () => (await harness.invoke(controls, 'workspace.bootstrap')).visible === false && (await active()) === null, 'finished flow exits by itself', 90_000);
  assert.equal((await harness.invoke(shell, 'demo.state', {})).projects.length, 0, 'exit removes the demo entry');
  await shell.waitForSelector('#start-demo-entry',{visible:true});
  await shell.screenshot({path: path.join(harness.root, 'after-auto-exit.png')});
  mark('completion exits automatically and restores the start page');

  await harness.auditIsolation();
  assert.deepEqual(report.errors, [], 'renderer errors occurred');
  await harness.closeNormally(shell);
  report.ok = true;
} catch (error) {
  report.failure = error.stack || String(error);
  console.log(report.failure);
  if (shell) {
    await shell.screenshot({path: path.join(harness.root, 'failure.png')}).catch(() => {});
    report.visible = await shell.evaluate(() => document.body.innerText.slice(-4000)).catch(() => null);
  }
  if (controls) report.controls = await harness.invoke(controls, 'workspace.bootstrap').catch(() => null);
  await harness.cleanupAfterFailure();
  process.exitCode = 1;
} finally {
  await harness.save();
  console.log(JSON.stringify({root: harness.root, ok: report.ok, checks: report.checks, failure: report.failure, visible: report.visible, errors: report.errors}, null, 2));
}
