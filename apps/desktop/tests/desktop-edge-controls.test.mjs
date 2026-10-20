import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.test-output', 'edge-controls');
await mkdir(output, { recursive: true });
const userData = await mkdtemp(path.join(os.tmpdir(), 'nozeli-edge-controls-'));
const port = 19000 + Math.floor(Math.random() * 1000);
const ozone = process.env.NOZELI_OZONE || 'headless';
const child = spawn(electronPath, ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: path.dirname(root),
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: userData, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
const exited = new Promise(resolve => child.once('exit', resolve));
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
const waitFor = async (url, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Electron readiness timeout: ${log}`);
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let browser;
try {
  await waitFor(`http://127.0.0.1:${port}/json/version`);
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 600000 });
  const page = (await browser.pages()).find(item => item.url().includes('127.0.0.1')) || (await browser.pages()).at(-1);
  await page.waitForFunction(() => window.__nozeliReady === true, { timeout: 20000 });
  if (await page.$eval('#agent-setup', node => node.open)) {
    await page.click('#agent-skip');
    await page.waitForFunction(() => document.body.dataset.agentSetup === 'dismissed');
  }
  const inspect = async () => page.evaluate(() => {
    const pseudoBounds = (button, rect) => {
      const style = getComputedStyle(button, '::before');
      const width = parseFloat(style.width) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      const height = parseFloat(style.height) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const matrix = style.transform.match(/^matrix\(([^)]+)\)$/)?.[1].split(',').map(Number) || [1, 0, 0, 1, 0, 0];
      const points = [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]];
      const transformed = points.map(([x, y]) => [matrix[0] * x + matrix[2] * y, matrix[1] * x + matrix[3] * y]);
      const left = rect.left + rect.width / 2 + Math.min(...transformed.map(point => point[0]));
      const right = rect.left + rect.width / 2 + Math.max(...transformed.map(point => point[0]));
      const top = rect.top + rect.height / 2 + Math.min(...transformed.map(point => point[1]));
      const bottom = rect.top + rect.height / 2 + Math.max(...transformed.map(point => point[1]));
      return { left, right, top, bottom, width: right - left, height: bottom - top };
    };
    const read = id => {
      const button = document.querySelector(id);
      const rect = button.getBoundingClientRect();
      const panel = button.closest('.files, .side').getBoundingClientRect();
      const pseudo = getComputedStyle(button, '::before');
      const chevron = pseudoBounds(button, rect);
      const clip = bounds => ({ left: Math.max(0, bounds.left), right: Math.min(document.documentElement.clientWidth, bounds.right), top: Math.max(0, bounds.top), bottom: Math.min(innerHeight, bounds.bottom) });
      const handleVisible = clip(rect);
      const chevronVisible = clip(chevron);
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return { text: button.textContent, expanded: button.getAttribute('aria-expanded'), label: button.getAttribute('aria-label'), panelWidth: panel.width, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }, center, panelCenter: panel.top + panel.height / 2, opacity: getComputedStyle(button).backgroundColor, glyph: pseudo.content, border: pseudo.borderRightWidth, transform: pseudo.transform, handleVisible, chevron, chevronVisible, hit: document.elementFromPoint(center.x, center.y) === button, hitTarget: document.elementFromPoint(center.x, center.y)?.id || document.elementFromPoint(center.x, center.y)?.className || document.elementFromPoint(center.x, center.y)?.tagName };
    };
    return { width: innerWidth, clientWidth: document.documentElement.clientWidth, height: innerHeight, file: read('#file-toggle'), side: read('#toggle-sidebar'), sideBody: document.querySelector('#sidebar-body').textContent };
  });
  const assertVisible = (control, state, key, name) => {
    const intersectWidth = bounds => Math.max(0, bounds.right - bounds.left);
    assert(control.hit, `${name}: ${key} center does not hit button ${JSON.stringify({ center: control.center, rect: control.rect, hitTarget: control.hitTarget, clientWidth: state.clientWidth, width: state.width })}`);
    assert(intersectWidth(control.handleVisible) / control.rect.width > .98, `${name}: ${key} handle is clipped ${JSON.stringify(control)}`);
    assert(intersectWidth(control.chevronVisible) / control.chevron.width > .98, `${name}: ${key} chevron is clipped ${JSON.stringify(control)}`);
    if (state.width < 721 && key === 'side') assert(Math.abs(control.rect.right - state.clientWidth) < 2, `${name}: side right=${control.rect.right} clientWidth=${state.clientWidth}`);
  };
  const verify = async (expected, name) => {
    const state = await inspect();
    for (const key of ['file', 'side']) {
      const control = state[key];
      const expanded = typeof expected === 'boolean' ? expected : expected[key];
      assert(control.expanded === String(expanded), `${name}: ${key} aria-expanded=${control.expanded}`);
      assert(control.text.trim() === '', `${name}: ${key} has button text ${JSON.stringify(control.text)}`);
      assert(control.glyph === '""', `${name}: ${key} pseudo glyph is ${control.glyph}`);
      assert(Math.abs(parseFloat(control.border) - 3) < .6, `${name}: ${key} chevron border is ${control.border}`);
      const expectedTransform = key === 'file' ? (expanded ? 'matrix(-0.707107, 0.707107, -0.707107, -0.707107, 0, 0)' : 'matrix(0.707107, -0.707107, 0.707107, 0.707107, 0, 0)') : (expanded ? 'matrix(0.707107, -0.707107, 0.707107, 0.707107, 0, 0)' : 'matrix(-0.707107, 0.707107, -0.707107, -0.707107, 0, 0)');
      assert(control.transform === expectedTransform, `${name}: ${key} direction transform=${control.transform}`);
      assert(control.opacity.startsWith('rgba(') && Number(control.opacity.match(/,\s*([\d.]+)\)/)?.[1] || 0) < 1, `${name}: ${key} is not translucent (${control.opacity})`);
      assert(Math.abs(control.center.y - (state.width >= 721 ? control.panelCenter : state.height / 2)) < 2, `${name}: ${key} is not vertically centered`);
      assert(Math.abs(control.rect.width - 28) < 1 && Math.abs(control.rect.height - 64) < 1, `${name}: ${key} handle size changed`);
      if (!expanded && state.width >= 721) assert(Math.abs(control.panelWidth - 28) < 1, `${name}: ${key} collapsed rail still occupies empty space`);
      if (state.width >= 721) assert(control.rect.left >= 0 && control.rect.right <= state.clientWidth, `${name}: ${key} leaves viewport`);
      else if (key === 'file') assert(Math.abs(control.rect.left) < 2, `${name}: file is not at left viewport edge ${JSON.stringify({ rect: control.rect, width: state.clientWidth })}`);
      assertVisible(control, state, key, name);
    }
    assert(state.sideBody.includes('开展的工作') && state.sideBody.includes('待办'), `${name}: side content contract changed`);
    return state;
  };
  await page.setViewport({ width: 1440, height: 900 });
  await verify(true, '1440 expanded');
  const readingWidth = await page.$eval('#reader', node => node.clientWidth);
  await page.screenshot({ path: path.join(output, 'before-1440.png'), fullPage: false });
  for (const id of ['#file-toggle', '#toggle-sidebar']) {
    const box = await page.$eval(id, node => { const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(box.x, box.y);
  }
  await verify(false, '1440 pointer collapsed');
  assert(await page.$eval('#reader', (node, before) => node.clientWidth > before + 350, readingWidth), 'both rails must release reading space');
  await page.screenshot({ path: path.join(output, 'collapsed-1440.png'), fullPage: false });
  await page.click('#file-toggle');
  await verify({ file: true, side: false }, '1440 left restored independently');
  await page.click('#file-toggle');
  await page.focus('#file-toggle'); await page.keyboard.press('Enter');
  await page.focus('#toggle-sidebar'); await page.keyboard.press('Space');
  await verify(true, '1440 keyboard restored');
  for (const width of [1100, 800]) {
    await page.setViewport({ width, height: 900 });
    await page.click('#toggle-sidebar');
    await verify({ file: true, side: false }, `${width} right collapsed independently`);
    await page.click('#file-toggle');
    await verify(false, `${width} both collapsed`);
    await page.click('#file-toggle'); await page.click('#toggle-sidebar');
    await verify(true, `${width} both restored`);
  }
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await verify(true, '390 expanded');
  await page.screenshot({ path: path.join(output, 'expanded-390.png'), fullPage: false, fromSurface: false });
  await page.click('#file-toggle'); await page.click('#toggle-sidebar');
  await verify(false, '390 collapsed');
  await page.screenshot({ path: path.join(output, 'collapsed-390.png'), fullPage: false, fromSurface: false });
  console.log(JSON.stringify({ ok: true, screenshots: output, viewports: ['1440x900', '1100x900', '800x900', '390x844'], checks: 'independent and simultaneous collapse, 28x64 handles, no empty rails, reading width recovery, pointer click, Enter/Space, viewport-safe chevrons and center hit' }));
} finally {
  await browser?.disconnect().catch(() => {});
  if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
  clearTimeout(timer);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
  await rm(userData, { recursive: true, force: true });
}
