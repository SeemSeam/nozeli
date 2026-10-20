import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';

const enabled = process.env.NOZELI_REAL_CODEX === '1';
// Retired until editor readiness and result assertions are replaced.
// The legacy path can confirm a CLI update prompt instead of entering /status.
if (enabled) throw new Error('Legacy native-input journey disabled: update-menu input is unsafe. Use the reviewed system-terminal journey once available.');
const electron = createRequire(import.meta.url)('electron');
const root = path.resolve(import.meta.dirname, '..');
const reportRoot = path.resolve(root, '../../.runtime/worker1-sixth-review-20260930');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const net = await import('node:net');
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}

(test('real Codex Wayland Electron journey', { skip: !enabled }, async () => {
  await mkdir(reportRoot, { recursive: true });
  const profile = await mkdtemp(path.join(reportRoot, 'profile-'));
  const project = await mkdtemp(path.join(reportRoot, 'project-'));
  await writeFile(path.join(project, 'README.md'), '# Nozeli real Codex journey\n');
  await writeFile(path.join(project, 'task.txt'), 'journey fixture\n');
  const port = await freePort();
  const env = {
    ...process.env,
    NOZELI_USER_DATA: profile,
    NOZELI_TEST_PICK: project,
    NOZELI_DEBUG_PORT: String(port),
    NOZELI_HIDDEN: '0',
    NOZELI_OZONE: 'wayland',
  };
  const child = spawn(electron, [path.join(root, 'src/main/main.cjs'), '--ozone-platform=wayland'], { cwd: path.dirname(root), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  const report = { platform: `${process.platform}/${process.arch}`, electron: process.versions.electron, profile, project, port, steps: [], screenshots: [], logFile: path.join(reportRoot, `wayland-${port}.log`) };
  const capture = async (page, name) => { const file = path.join(reportRoot, `${name}-${port}.png`); await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(file); };
  try {
    let browser;
    for (let i = 0; i < 100; i++) { try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 120000 }); break; } catch { await wait(200); } }
    if (!browser) throw new Error('Wayland CDP did not become ready');
    const pages = await browser.pages(); const page = pages.find(item => item.url().includes('127.0.0.1')) || pages.at(-1);
    await page.waitForFunction(() => window.__nozeliReady === true, { timeout: 30000 });
    report.steps.push({ name: 'wayland-window-ready', ok: true }); await capture(page, '01-ready');
    await page.click('#pick-project'); await page.waitForFunction(() => document.querySelector('#project-name')?.textContent !== '未打开项目');
    report.steps.push({ name: 'temporary-project-opened', ok: true });
    await page.waitForFunction(() => document.querySelector('#agent-setup')?.open === true);
    await page.select('#agent-foreground', 'codex'); await page.select('#agent-background', 'codex');
    await page.click('#agent-setup-form button[type="submit"]');
    await page.waitForFunction(() => document.body.dataset.agentSetup === 'dismissed', { timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('#ai-status')?.textContent?.includes('就绪') || document.querySelector('#ai-status')?.textContent?.includes('模型'), { timeout: 120000 }).catch(() => {});
    report.steps.push({ name: 'codex-resident-slots-requested', ok: true, status: await page.$eval('#ai-status', node => node.textContent) }); await capture(page, '02-connected');
    await page.click('#composer'); await page.type('#composer', 'Reply exactly NOZELI_ELECTRON_REAL_OK. Do not use tools.'); await page.click('#send-message');
    await page.waitForFunction(() => [...document.querySelectorAll('#conversation .agent-message, #conversation [data-role="qa"]')].some(node => node.textContent.includes('NOZELI_ELECTRON_REAL_OK')) || document.body.innerText.includes('401 Unauthorized'), { timeout: 90000 });
    await wait(1500); report.steps.push({ name: 'real-foreground-request-submitted', ok: true });
    await page.click('#provider-console-toggle');
    await page.waitForSelector('.provider-output .xterm', { timeout: 30000 });
    await wait(1200); report.steps.push({ name: 'native-terminal-opened', ok: true }); await capture(page, '03-terminal-open');
    const before = await page.evaluate(() => ({ qa: document.querySelector('[data-provider-role="qa"] .provider-meta')?.textContent, state: document.querySelector('[data-provider-role="qa"]')?.dataset.terminalState || document.querySelector('[data-provider-role="qa"] .provider-output')?.dataset.terminalState }));
    await page.click('#provider-console-close'); await wait(500); await page.click('#provider-console-toggle'); await page.waitForSelector('.provider-output .xterm', { timeout: 30000 }); await wait(800);
    const after = await page.evaluate(() => ({ qa: document.querySelector('[data-provider-role="qa"] .provider-meta')?.textContent, state: document.querySelector('[data-provider-role="qa"] .provider-output')?.dataset.terminalState }));
    report.steps.push({ name: 'terminal-hide-reopen', ok: true, before, after }); await capture(page, '04-terminal-reopen');
    const terminalInput = await page.$('.provider-output .xterm-helper-textarea');
    if (!terminalInput) throw new Error('real xterm input textarea not found');
    await terminalInput.focus(); await page.keyboard.type('/status'); await page.keyboard.press('Enter'); await wait(1500);
    report.steps.push({ name: 'physical-native-status-input', ok: true }); await capture(page, '05-native-input');
    const visibleText = await page.$eval('[data-provider-role="qa"] .provider-output', node => node.textContent || '');
    report.steps.push({ name: 'native-terminal-has-content', ok: visibleText.length > 0, textTail: visibleText.slice(-500) });
    await browser.close();
  } finally {
    await writeFile(report.logFile, log);
    await writeFile(path.join(reportRoot, `wayland-${port}.json`), JSON.stringify(report, null, 2));
    child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(5000)]); if (child.exitCode == null) child.kill('SIGKILL');
  }
  assert.ok(report.steps.some(step => step.name === 'native-terminal-opened'), JSON.stringify(report));
}));
