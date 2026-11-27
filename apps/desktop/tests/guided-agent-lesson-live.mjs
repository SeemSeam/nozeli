// Live evidence: the separate interactive offline elective lesson #guided-agent-lesson,
// launched by the [data-agent-lesson] buttons on the start page and in Settings →
// 帮助与演示. The exercise must answer an explicitly sent management message from a
// fixed offline reply, reuse the local skill-import view (source → scan → explicit
// analysis → per-role grant → install kept separate from project enable), keep the
// installed skill unusable until the explicit project enable, answer the first
// explicit use from a fixed offline sample, reset honestly, never touch the real
// skill store or start models/network, and leave the app closing normally with
// exit 0. Usage: node apps/desktop/tests/guided-agent-lesson-live.mjs
// (Linux-only live evidence; see guided-demo-live-helper.mjs for isolation.)
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createGuidedDemoHarness} from './guided-demo-live-helper.mjs';

process.env.NOZELI_TEST_BINARY ??= (await import('node:module')).createRequire(import.meta.url)('electron');
process.env.NOZELI_GUIDED_DEMO_ROOT ??= await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'nozeli-agent-lesson-'));
const harness = await createGuidedDemoHarness({kind: 'agent-lesson'});
const {report} = harness;
let shell;
console.log('EVIDENCE_ROOT=' + harness.root);
const mark = (name, evidence = {}) => report.checks.push({name, ...evidence});
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

const DIALOG = '#guided-agent-lesson';
const action = key => `${DIALOG} [data-agent-lesson-action="${key}"]`;
const input = key => `${DIALOG} [data-agent-lesson-input="${key}"]`;
const storeAction = async key => {
  const selector = `${DIALOG} [data-import-action="${key}"]`;
  await shell.waitForSelector(selector + ':not([disabled])', {visible: true});
  await shell.click(selector);
};
const dialogText = () => shell.$eval(DIALOG, node => node.innerText);
const dialogOpen = () => shell.$eval(DIALOG, node => node.open === true);
const focusIs = selector => shell.evaluate(selector => document.activeElement === document.querySelector(selector), selector);
const realSkillStore = () => harness.invoke(shell, 'store.imports.list', {}); // read-only app query, never a scan or install
const realStoreFile = path.join(harness.root, 'config', 'desktop', 'local-skill-imports.json');
const realStoreFileState = async () => fs.access(realStoreFile).then(() => 'present', error => error.code);

try {
  await harness.launch();
  ({page:shell}=await harness.scope(scope=>scope.role==='shell','lesson shell'));
  if (await shell.$eval('#configuration-setup', element => element.open).catch(() => false)) await shell.click('#configuration-cancel');

  // The real local skill store must start and stay untouched; the elective runs on
  // its own in-memory fixtures and must never install, enable or persist for real.
  assert.deepEqual(await realSkillStore(), [], 'real skill store must start empty');
  assert.equal(await realStoreFileState(), 'ENOENT', 'no real skill store file may exist');

  // Entrance 1: the elective launcher on the start page.
  await shell.waitForSelector('#start-page [data-agent-lesson]', {visible: true});
  await harness.capture(shell, 'lesson-launcher-start-page');
  await shell.click('#start-page [data-agent-lesson]');
  await harness.until(dialogOpen, 'lesson dialog opens from the start page');
  await shell.waitForSelector(input('admin'), {visible: true});
  const banner = await dialogText();
  assert(/[离线]|本地|不联网|未连接/.test(banner), 'the lesson must present itself as offline in its own words');
  report.bannerSample = banner.split('\n').slice(0, 3);
  await harness.capture(shell, 'lesson-open', {entrance: 'start-page'});

  // Explicit send in the management exercise: typing alone must not send anything.
  await shell.type(input('admin'), '请离线盘点当前登记的项目与全局配置状态');
  const beforeAdminSend = await dialogText();
  await settle(700);
  assert.equal(await dialogText(), beforeAdminSend, 'typing in the management composer must not send by itself');
  await shell.click(action('admin-send'));
  const adminReply = await harness.until(async () => {
    const text = await dialogText();
    return text !== beforeAdminSend ? text : null;
  }, 'fixed offline management reply appears only after the explicit send');
  report.adminReplySample = adminReply.slice(-400);
  mark('explicit admin send receives a fixed offline reply', {replyTail: adminReply.slice(-160)});

  // Skill migration inside the lesson reuses the local skill-import controls.
  await shell.waitForSelector(action('migration') + ':not([disabled])', {visible: true});
  await shell.click(action('migration'));
  await storeAction('sources');
  await shell.waitForSelector(`${DIALOG} [data-import-source]`, {visible: true});
  const sourceIds = await shell.$$eval(`${DIALOG} [data-import-source]`, nodes => nodes.map(node => node.dataset.importSource));
  report.lessonSources = sourceIds;
  await shell.click(`${DIALOG} [data-import-source]`);
  await storeAction('scan');
  const candidateId = await harness.until(async () => shell.$eval(`${DIALOG} [data-import-analysis-candidate]:not(:disabled)`, node => node.dataset.importAnalysisCandidate), 'scan lists analysable candidates');
  assert(await shell.$eval(`${DIALOG} [data-import-action="analyze"]`, node => node.disabled), 'analysis must wait for an explicit candidate choice');
  await shell.click(`${DIALOG} [data-import-analysis-candidate]:not(:disabled)`);
  await storeAction('analyze');
  await shell.waitForSelector(`${DIALOG} [data-import-candidate]`, {visible: true});
  await harness.capture(shell, 'lesson-analysis-proposal', {candidateId});
  await shell.click(`${DIALOG} details summary`);
  assert.match(await dialogText(),/先用一句话概括材料/);

  // Install is explicit and separate from the project enable: grant the role, do
  // not check "同时为当前项目启用", and install.
  assert(await shell.$eval(`${DIALOG} [data-import-action="install"]`,node=>node.disabled));
  await shell.click(`${DIALOG} [data-import-candidate="${candidateId}"]`);
  assert(await shell.$eval(`${DIALOG} [data-import-action="install"]`,node=>node.disabled),'checking install is not role authorization');
  await shell.click(`${DIALOG} fieldset:has(> label > [data-import-candidate="${candidateId}"]) [data-import-role]`);
  const roleGranted = await shell.$eval(`${DIALOG} fieldset:has(> label > [data-import-candidate="${candidateId}"]) [data-import-role]:checked`, node => node.dataset.importRole);
  report.lessonRole = roleGranted;
  assert.equal(await shell.$(`${DIALOG} [data-import-enable]:checked`), null, 'the install must not silently carry a project enable');
  await storeAction('install');
  mark('skill source, scan, explicit analysis, role grant and install run inside the lesson', {sourceIds, candidateId, roleGranted});

  // No use until the explicit project enable: the use composer cannot run yet.
  const blocked = await shell.evaluate(() => {
    const dialog = document.querySelector('#guided-agent-lesson');
    const send = dialog?.querySelector('[data-agent-lesson-action="use-send"]');
    const skill = dialog?.querySelector('[data-agent-lesson-skill]');
    return {sendDisabled: send ? send.disabled : null, skillOptions: skill ? skill.options.length : null};
  });
  report.useBlocked = blocked;
  assert(blocked.sendDisabled === true || blocked.skillOptions === 0, `before the explicit project enable the use composer must not be usable: ${JSON.stringify(blocked)}`);
  await harness.capture(shell, 'lesson-use-blocked-before-enable');

  // The explicit project enable is its own step in the reused store controls.
  await storeAction('enable');
  const skillValue = await harness.until(async () => shell.$eval(`${DIALOG} [data-agent-lesson-skill]`, node => node.options.length ? node.options[node.options.length - 1].value : null), 'the enabled skill becomes selectable');
  await shell.select(`${DIALOG} [data-agent-lesson-skill]`, skillValue);
  mark('explicit project enable makes the installed skill selectable', {skillValue});

  // First explicit use: typing alone must still not send anything.
  await shell.type(input('use'), '用刚启用的技能处理当前材料');
  const beforeUseSend = await dialogText();
  await settle(700);
  assert.equal(await dialogText(), beforeUseSend, 'typing in the use composer must not send by itself');
  await shell.click(action('use-send'));
  const useReply = await harness.until(async () => {
    const text = await dialogText();
    return text !== beforeUseSend ? text : null;
  }, 'fixed offline use sample appears only after the first explicit use');
  report.useReplySample = useReply.slice(-400);
  mark('first explicit use answers from the fixed offline sample', {replyTail: useReply.slice(-160)});
  await harness.capture(shell, 'lesson-use-reply');

  // The elective is a simulation: the real store stays empty and unpersisted.
  assert.deepEqual(await realSkillStore(), [], 'the lesson must not install into the real skill store');
  assert.equal(await realStoreFileState(), 'ENOENT', 'the lesson must not persist a real skill store file');

  // Restart resets the exercise honestly.
  await shell.click(action('restart'));
  await harness.until(async () => {
    const fresh = await shell.evaluate(() => {
      const dialog = document.querySelector('#guided-agent-lesson');
      return {
        admin: dialog?.querySelector('[data-agent-lesson-input="admin"]')?.value ?? null,
        use: dialog?.querySelector('[data-agent-lesson-input="use"]')?.value ?? null,
        candidates: dialog?.querySelectorAll('[data-import-candidate]').length ?? null,
        options: dialog?.querySelector('[data-agent-lesson-skill]')?.options.length ?? null,
      };
    });
    return fresh.admin === '' && fresh.use === '' && fresh.candidates===0 && fresh.options===1 ? fresh : null;
  }, 'restart clears the exercise back to its first stage');
  await harness.capture(shell, 'lesson-after-restart');
  mark('restart resets drafts and the migration progress');

  // Close restores the start-page launcher.
  await shell.click(action('close'));
  await harness.until(async () => !(await dialogOpen()), 'close dismisses the lesson');
  assert(await focusIs('#start-page [data-agent-lesson]'), 'close must return focus to the start-page launcher');
  await shell.waitForSelector('#start-page [data-agent-lesson]', {visible: true});
  mark('close leaves the start page usable and focus returns to its launcher');

  // Entrance 2: Settings → 帮助与演示 opens the same elective over settings and
  // restores focus to that launcher on close. No other settings are toured.
  await shell.click('#open-settings');
  await shell.click('[data-settings-section="settings-help"]');
  const helpLauncher = '#settings-help [data-agent-lesson]';
  await shell.waitForSelector(helpLauncher, {visible: true});
  await shell.click(helpLauncher);
  await harness.until(dialogOpen, 'lesson opens over the settings dialog');
  assert(await shell.$eval('#settings-dialog', node => node.open), 'settings stay open underneath the lesson');
  await shell.waitForSelector(input('admin'), {visible: true});
  await harness.capture(shell, 'lesson-over-settings', {entrance: 'settings-help'});
  await shell.click(action('close'));
  await harness.until(async () => !(await dialogOpen()), 'close dismisses the lesson opened over settings');
  assert(await focusIs(helpLauncher), 'close must return focus to the settings launcher');
  assert(await shell.$eval('#settings-dialog', node => node.open), 'closing the lesson must not close settings');
  await shell.click('#settings-close');
  await harness.until(async () => !(await shell.$eval('#settings-dialog', node => node.open)), 'settings closed directly');
  mark('settings entrance opens over settings, restores launcher focus, keeps settings open');

  // The singleton still opens cleanly after both entrances were used.
  await shell.click('#start-page [data-agent-lesson]');
  await harness.until(dialogOpen, 'lesson reopens after both entrances were used');
  await shell.click(action('close'));
  await harness.until(async () => !(await dialogOpen()), 'reopen closes again');
  mark('the single lesson dialog survives repeated entrances');

  await harness.auditIsolation();
  assert.deepEqual(report.errors, [], 'renderer errors occurred');
  await harness.closeNormally(shell);
  report.ok = true;
} catch (error) {
  report.failure = error.stack || String(error);
  console.log(report.failure);
  if (shell) {
    await shell.screenshot({path: path.join(harness.root, 'failure.png')}).catch(() => {});
    report.visible = await shell.evaluate(() => document.querySelector('#guided-agent-lesson')?.innerText.slice(-4000) ?? document.body.innerText.slice(-4000)).catch(() => null);
  }
  await harness.auditIsolation().catch(error => report.auditFailure = String(error));
  await harness.cleanupAfterFailure();
  process.exitCode = 1;
} finally {
  await harness.save();
  console.log(JSON.stringify({ok: report.ok, root: harness.root, checks: report.checks, errors: report.errors, failure: report.failure}, null, 2));
}
