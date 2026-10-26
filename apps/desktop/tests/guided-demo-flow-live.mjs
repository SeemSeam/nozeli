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
  const buttons = await shell.$$eval('#start-page button', nodes => nodes.map(node => node.textContent));
  assert.deepEqual(buttons, ['演示学习'], `start page must offer exactly one learning entry, saw ${JSON.stringify(buttons)}`);

  controls = await harness.startLearning(shell);
  const projectId = await active();
  report.projectId = projectId;
  assert((await harness.invoke(controls, 'workspace.bootstrap')).model.stepTotal === expectedStepIds.length, 'flow length must match the shipped catalog');
  const {page: hint} = await harness.scope(scope => scope.role === 'demo-hint', 'native step hint');
  await harness.until(async () => { const value = await harness.invoke(hint, 'workspace.bootstrap'); return value.model?.visible ? value : null; }, 'big hint appears on its own top view');
  const hintModel = (await harness.invoke(hint, 'workspace.bootstrap')).model;
  assert(hintModel.title && hintModel.detail.length > 10, 'big hint card must explain the current step');
  await hint.screenshot({path: path.join(harness.root, 'hint-card.png')});
  mark('one entry, direct start, big hint on top of any content', {hint: hintModel.title});

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
    return model?.visible && model.title === demoSteps[frontdesk].hintTitle && model.paused ? model : null;
  }, 'target hint appears immediately after a paused seek');
  assert.equal(landedHint.stepIndex, frontdesk, 'target hint must carry the seeked step');
  await controls.click('[data-demo-control="play"]');
  await harness.until(async () => (await harness.invoke(controls, 'workspace.bootstrap')).model.status === 'playing', 'explicit resume after a paused seek');
  await harness.until(async () => (await state()).messages.some(message => message.text.includes('两种方法是否在同一时段观测')), 'frontdesk quick answer appears in conversation');
  mark('paused seek shows the target hint; explicit resume runs the target step');

  await harness.seek(controls, stepIndex('task-progress'), 'single seek while playing');
  await harness.until(async () => {
    const model = (await harness.invoke(controls, 'workspace.bootstrap')).model;
    return model.status === 'playing' && model.stepIndex >= stepIndex('task-progress') ? model : null;
  }, 'playing seek keeps playing at the target');
  await harness.until(async () => (await state()).messages.some(message => message.text.includes('后台进展')), 'concurrency notices appear');
  mark('two background tasks show staged progress');

  await harness.seek(controls, stepIndex('task-a-done'), 'seek to the first task completion');
  await harness.until(async () => (await state()).todos.some(todo => todo.kind === 'result'), 'task A enters the todo list');
  await harness.until(async () => {
    const windows = await harness.invoke(shell, 'workspace.windows.list', {projectId});
    return windows.some(window => window.surfaces.some(surface => surface.visible));
  }, 'review report opens on a real surface', 90_000);
  await harness.until(async () => {
    const demo = await state();
    const accepted = demo.todos.find(todo => todo.title.includes('任务 A'));
    const discarded = demo.todos.find(todo => todo.title.includes('任务 B'));
    return accepted?.status === 'resolved' && discarded?.status === 'cancelled' ? {accepted, discarded} : null;
  }, 'accept closes task A and discard closes task B', 90_000);
  mark('review decisions close both tasks: accept resolves A, discard cancels B');

  await harness.until(() => shell.$eval('#settings-dialog', dialog => dialog.open), 'settings dialog opens for the tour', 150_000);
  await shell.screenshot({path: path.join(harness.root, 'settings-tour.png')});
  await harness.until(async () => {
    const open = await shell.$eval('#settings-dialog', dialog => dialog.open);
    return !open && (await harness.invoke(controls, 'workspace.bootstrap')).model.stepIndex >= stepIndex('finish');
  }, 'flow closes settings itself and reaches the final step');
  mark('settings tour opens provider section and the flow closes it');

  await harness.until(async () => (await harness.invoke(controls, 'workspace.bootstrap')).visible === false && (await active()) === null, 'finished flow exits by itself', 90_000);
  assert.equal((await harness.invoke(shell, 'demo.state', {})).projects.length, 0, 'exit removes the demo entry');
  assert.equal(await shell.$eval('#start-page button', node => node.textContent), '演示学习', 'back to the single-entry start page');
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
