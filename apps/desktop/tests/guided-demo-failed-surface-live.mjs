// Live evidence: a legacy demo copy whose active sample.tex is missing must
// surface its init failure honestly (never content-ready) and still retire
// onto the current template when learning starts again, ending with a normal
// exit 0. Regression for the installed PROJECT_FLUSH_FAILED deadlock where
// closeProject waited ten seconds for a surface that can never become ready.
// Usage: node apps/desktop/tests/guided-demo-failed-surface-live.mjs
// (Linux-only live evidence; see guided-demo-live-helper.mjs for isolation.)
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createGuidedDemoHarness } from './guided-demo-live-helper.mjs';

process.env.NOZELI_TEST_BINARY ??= createRequire(path.join(import.meta.dirname, '..', 'package.json'))('electron');
process.env.NOZELI_TEST_APP_ROOT ??= path.resolve(import.meta.dirname, '..');
process.env.NOZELI_GUIDED_DEMO_ROOT ??= await fs.mkdtemp(path.join(tmpdir(), 'nozeli-demo-failed-surface-'));

const h = await createGuidedDemoHarness({ kind: 'demo-failed-surface-exit' });
const r = h.report;
let shell, controls;
console.log('EVIDENCE_ROOT=' + h.root);
const controlsState = () => h.invoke(controls, 'workspace.bootstrap');
const activeProject = async () => (await h.invoke(shell, 'workspace.bootstrap')).projectId;

async function launch() {
  await h.launch();
  ({ page: shell } = await h.scope(scope => scope.role === 'shell'));
}

function firstGroup(node) {
  return node.kind === 'group' ? node.id : firstGroup(node.first) || firstGroup(node.second);
}

try {
  // Run 1: fresh isolated demo, pause it, then open sample.tex as a user
  // layout command (expectedRevision/requestKey/groupId/view) and close the
  // window normally — the project must flush and exit 0 with real content.
  await launch();
  controls = await h.startLearning(shell);
  const oldId = (await controlsState()).model.projectId;
  const oldRoot = (await h.invoke(shell, 'demo.state', { projectId: oldId })).project.rootDisplay;
  await controls.click('[data-demo-control="play"]');
  await h.until(async () => (await controlsState()).model.status === 'paused', 'demo pauses on user request');
  const snapshot = await h.invoke(shell, 'workspace.snapshot', { projectId: oldId });
  const groupId = firstGroup(snapshot.layout.mainRoot);
  await h.invoke(shell, 'workspace.command', {
    projectId: oldId,
    expectedRevision: snapshot.layout.revision,
    requestKey: 'failed-surface-live-open-sample-tex',
    command: { type: 'open', groupId, view: { kind: 'document', relPath: 'sample.tex' } },
  });
  const tex = await h.scope(scope => scope.projectId === oldId && scope.relPath === 'sample.tex');
  await tex.page.waitForFunction(() => document.body.innerText.includes('documentclass'), { timeout: 45_000 });
  r.checks.push('Paused demo opens sample.tex through a real workspace.command and renders TeX content');
  await h.closeNormally(shell);
  assert.deepEqual(r.normalExit, { code: 0, signal: null }, 'closing real TeX content must exit 0');
  r.checks.push('Normal window close with a ready TeX surface flushes and exits 0');

  // Degrade the retired copy to a stale template with a missing expected file.
  const registryFile = path.join(h.root, 'config/desktop/guided-demo/registry.json');
  const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  const row = registry.projects[oldId];
  assert.equal(row.expectedFiles['sample.tex'] !== undefined, true, 'v2 template must ship sample.tex in expectedFiles');
  row.templateVersion = '1';
  row.templateDigest = 'legacy-v1-digest';
  delete row.expectedFiles['sample.tex'];
  await fs.rm(path.join(oldRoot, 'sample.tex'));
  await fs.writeFile(path.join(oldRoot, 'my-note.txt'), 'KEEP OLD EXPLORATION');
  await fs.writeFile(registryFile, JSON.stringify(registry));
  r.checks.push('Registry degraded to templateVersion 1 without expectedFiles.sample.tex; disk copy loses sample.tex and keeps my-note.txt');

  // Run 2: reopen the legacy project. The persisted layout still opens
  // sample.tex, so its surface must fail init and stay honestly unready.
  await launch();
  await shell.waitForSelector(`[data-project-id="${oldId}"]`, { visible: true });
  await shell.click(`[data-project-id="${oldId}"]`);
  await h.until(async () => await activeProject() === oldId, 'legacy project is open again');
  const broken = await h.until(async () => {
    for (const page of await h.browser.pages()) {
      const identity = await page.evaluate(async () => {
        if (!window.nozeli) return null;
        const result = await window.nozeli.invoke('workspace.bootstrap', {});
        return result.ok ? result.value : null;
      }).catch(() => null);
      if (identity?.projectId === oldId && identity.relPath === 'sample.tex' && identity.contentFailed === true) return { page, scope: identity };
    }
    return null;
  }, 'missing sample.tex surface reports its terminal init failure');
  const brokenText = await broken.page.evaluate(() => document.body.innerText);
  assert(brokenText.includes('原项目内容未能载入'), 'the failure surface must tell the user content never loaded');
  const focus = await shell.evaluate(viewId => window.nozeli.invoke('workspace.focus', { viewId }), broken.scope.viewId);
  assert.equal(focus.ok, false, 'a failed surface must not gain ready-gated admission');
  assert.equal(focus.error.code, 'SURFACE_NOT_READY');
  await broken.page.screenshot({ path: path.join(h.root, 'legacy-missing-tex.png') });
  r.scenes.push({ name: 'legacy-missing-tex', file: 'legacy-missing-tex.png', projectId: oldId, viewId: broken.scope.viewId });
  r.checks.push('Missing-file surface shows the honest failure text, reports contentFailed and stays SURFACE_NOT_READY for focus');

  // Starting learning again must retire the stale copy (real retention chain,
  // no ten-second stall, no PROJECT_FLUSH_FAILED) and create a fresh v2 copy.
  await shell.click('#open-settings');
  await shell.click('[data-settings-section="settings-help"]');
  await shell.click('#settings-demo-help');
  ({ page: controls } = await h.scope(scope => scope.role === 'demo-controls'));
  const fresh = await h.until(async () => {
    const model = (await controlsState()).model;
    return model?.projectId !== oldId && model?.status === 'playing' ? model : null;
  }, 'starting learning retires the legacy copy and plays the new template', 90_000);
  const newId = fresh.projectId;
  const newState = await h.invoke(shell, 'demo.state', { projectId: newId });
  assert.equal(newState.templateVersion, '2');
  assert((await fs.readFile(path.join(newState.project.rootDisplay, 'sample.tex'), 'utf8')).includes('documentclass'));
  assert.equal(await fs.readFile(path.join(oldRoot, 'my-note.txt'), 'utf8'), 'KEEP OLD EXPLORATION');
  await assert.rejects(fs.stat(path.join(oldRoot, 'sample.tex')), { code: 'ENOENT' });
  assert.equal((await h.invoke(shell, 'demo.state', { projectId: oldId })).isDemo, false);
  assert(!(await h.invoke(shell, 'project.recent')).projects.some(project => project.id === oldId));
  r.checks.push('Retirement closes the failed-surface project through the real retention chain, creates v2 and preserves old exploration');

  // End the demo and leave through the front door: exit 0.
  await controls.click('[data-demo-control="stop"]');
  await h.until(async () => await activeProject() === null && !(await controlsState()).visible, 'demo end returns to the start workspace');
  assert.equal((await h.invoke(shell, 'demo.state', {})).projects.length, 0);
  r.checks.push('Demo end removes the v2 entry and returns to the start workspace');
  assert.deepEqual(r.errors, []);
  await h.auditIsolation();
  await h.closeNormally(shell);
  assert.deepEqual(r.normalExit, { code: 0, signal: null }, 'final close after ending the demo must exit 0');
  r.checks.push('Second normal close exits 0 after the demo ended');
  r.ok = true;
} catch (error) {
  r.failure = error.stack;
  console.log(r.failure);
  if (shell) {
    await shell.screenshot({ path: path.join(h.root, 'failure.png') }).catch(() => {});
    console.log(await shell.evaluate(() => document.body.innerText.slice(-2500)).catch(() => null));
  }
  if (controls) console.log('CONTROLS', JSON.stringify(await controlsState().catch(() => null)));
  await h.cleanupAfterFailure();
  process.exitCode = 1;
} finally {
  await h.save();
  console.log(JSON.stringify({ ok: r.ok, root: h.root, checks: r.checks, normalExit: r.normalExit, errors: r.errors, failure: r.failure }, null, 2));
}
