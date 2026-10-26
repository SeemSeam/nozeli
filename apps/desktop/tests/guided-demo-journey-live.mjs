import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createGuidedDemoHarness, expectedChapterIds} from './guided-demo-live-helper.mjs';

const evidenceRoot = process.env.NOZELI_GUIDED_DEMO_CHAPTER_EVIDENCE;
assert(evidenceRoot && path.isAbsolute(evidenceRoot), 'NOZELI_GUIDED_DEMO_CHAPTER_EVIDENCE must contain the twelve chapter evidence directories');
const harness = await createGuidedDemoHarness({kind: 'journey'});
const {report} = harness;
let shell, controls;
const mark = (name, evidence = {}) => report.checks.push({name, ...evidence});

async function gateChapterEvidence() {
  const reports = [];
  for (const chapterId of expectedChapterIds) {
    const file = path.join(evidenceRoot, chapterId, 'report.json');
    const chapter = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(chapter.ok, true, `${chapterId} chapter evidence did not pass`);
    assert.equal(chapter.kind, 'chapter', `${chapterId} is not chapter evidence`);
    assert.equal(chapter.version?.gate, harness.version.gate, `${chapterId} evidence belongs to a different source/assets/binary bundle`);
    assert.deepEqual(chapter.chapters?.map(item => item.id), expectedChapterIds, `${chapterId} recorded a different live catalog`);
    assert.equal(chapter.session?.state === 'playing' || chapter.session?.state === 'paused', true, `${chapterId} has no live player session evidence`);
    reports.push({chapterId, file, projectId: chapter.projectId, sessionId: chapter.session.sessionId, version: chapter.version.gate});
  }
  assert.equal(new Set(reports.map(item => item.sessionId)).size, reports.length, 'Chapter reports must come from independent live sessions');
  report.chapterGate = reports;
  mark('all chapter reports gate this exact bundle', {version: harness.version.gate, count: reports.length});
}

async function player() {
  return controls.$eval('#guided-demo-player', element => ({state: element.dataset.demoState, sessionId: element.dataset.sessionId, epoch: Number(element.dataset.epoch), chapterId: element.querySelector('select[aria-label="演示章节"]')?.value, subtitle: document.querySelector('#demo-subtitle')?.textContent}));
}

async function startJourney() {
  ({page: shell} = await harness.scope(scope => scope.role === 'shell', 'real shell'));
  if (await shell.$eval('#configuration-setup', element => element.open).catch(() => false)) await shell.click('#configuration-cancel');
  await harness.enumerateChapters(shell);
  await shell.select('#guided-demo-disclosure select[aria-label="从章节开始"]', 'intro');
  await shell.click('#demo-create-confirm');
  ({page:controls}=await harness.scope(scope=>scope.role==='demo-controls','native demo controls'));
  await controls.waitForSelector('#guided-demo-player:not([hidden])', {timeout: 30_000});
  const projectId = await harness.until(async () => (await harness.invoke(shell, 'workspace.bootstrap')).projectId, 'journey demo project');
  const initial = await player();
  assert(initial.sessionId && initial.chapterId === 'intro');
  report.projectId = projectId;
  report.sessionId = initial.sessionId;
  return {projectId, initial};
}

async function continuousJourney(projectId, initial) {
  const timeline = [{event: 'created', ...initial}];
  const seen = new Set([initial.chapterId]);
  let previous = initial;
  await harness.until(async () => {
    const current = await player();
    if (current.epoch !== previous.epoch || current.chapterId !== previous.chapterId || current.state !== previous.state) {
      assert.equal(current.sessionId, initial.sessionId, 'Journey replaced its session instead of continuing');
      assert(current.epoch >= previous.epoch, 'Journey epoch regressed');
      timeline.push({event: 'transition', ...current});
      seen.add(current.chapterId);
      previous = current;
    }
    return current.state === 'ended' || (current.chapterId === 'finish' && current.subtitle?.includes('本章已完成'));
  }, 'one uninterrupted cross-chapter journey', 240_000);
  assert.deepEqual([...seen], expectedChapterIds, 'Continuous journey did not traverse every chapter in catalog order');
  report.timeline = timeline;
  mark('one session traversed every chapter in catalog order', {sessionId: initial.sessionId, transitions: timeline.length});

  const roots = await fs.readdir(path.join(harness.root, 'examples'), {withFileTypes: true});
  assert.equal(roots.filter(entry => entry.isDirectory()).length, 1, 'Continuous journey must retain one project copy, not create per-chapter copies');
  const currentProject = await harness.invoke(shell, 'workspace.bootstrap');
  assert.equal(currentProject.projectId, projectId, 'Journey changed project ownership');
  mark('cross-chapter state retained one project and one session', {projectId, roots: roots.map(entry => entry.name)});

  const finish = await player();
  assert.equal(finish.sessionId, initial.sessionId);
  assert(['ended', 'finished'].includes(finish.state) || finish.subtitle?.includes('本章已完成'), 'Journey finish did not reach a terminal retained state');
  await shell.evaluate(() => { window.__guidedCleanup = null; window.addEventListener('nozeli-demo-cleanup', event => { window.__guidedCleanup = event.detail; }, {once: true}); });
  await controls.click('#demo-more summary');
  await controls.click('[data-demo-control="cleanup"]');
  const preview = await harness.until(async () => shell.evaluate(() => window.__guidedCleanup || null), 'real cleanup preview event', 10_000);
  assert.equal(preview.projectId, projectId);
  assert.equal(preview.preview.requiresUserConfirmation, true);
  assert.equal(preview.preview.canAutomaticallyDelete, false);
  report.cleanupPreview = preview;
  mark('visible cleanup control produced preview without destructive confirmation');
}

try {
  await gateChapterEvidence();
  await harness.launch();
  const {projectId, initial} = await startJourney();
  await continuousJourney(projectId, initial);
  await harness.capture(shell, 'journey-finish', {projectId, sessionId: initial.sessionId});
  await harness.auditIsolation();
  assert.deepEqual(report.errors, []);
  await harness.closeNormally(shell);
  report.ok = true;
} catch (error) {
  report.failure = error.stack || String(error);
  await shell?.screenshot({path: path.join(harness.root, 'failure.png')}).catch(() => {});
  await harness.auditIsolation().catch(audit => { report.auditFailure = audit.stack || String(audit); });
  await harness.cleanupAfterFailure();
  process.exitCode = 1;
} finally {
  await harness.save();
}
