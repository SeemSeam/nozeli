// Permanent real-package display acceptance: one sequential journey opens
// Markdown, a long code file, PNG, PDF, DOCX, XLSX, PPTX, a local HTML entry
// (default offline web-preview guest, then 源码 source, then 对照 split) and
// one loopback online page in the real app, at two native window sizes, and
// captures the ACTUAL content surface (office iframe frames, the online guest
// WebContentsView and the local .invalid preview guest over raw CDP — never
// the wrapper only).
//
// Display risks (horizontal overflow, clipped boxes, flat syntax colors,
// near-blank canvases, low contrast, guest/wrapper bounds mismatch) are
// MEASURED and recorded in report.risks — never blanket-asserted as fine.
//
// Mac real bundle (no Ozone switch on darwin):
//   NOZELI_TEST_BINARY=/Users/bfly/nozeli/dist/macos-final-20261106/Nozeli.app \
//     node apps/desktop/tests/desktop-display-matrix-live.mjs
// Development tree (from apps/desktop):
//   node tests/desktop-display-matrix-live.mjs
//
// Fixtures are synthesized at runtime into a canonical temporary root; profile
// and config live outside that project. No credentials, no model calls, no
// business-source changes. Artifacts: report.json, electron-session-logs.json,
// per-case PNG screenshots (the wrapper shot of the online case intentionally
// excludes the native guest pixels; online-guest-*.png carries the content).
import assert from 'node:assert/strict';
import {contentToolForPage} from './native-content-tools.fixture.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import JSZip from 'jszip';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const tmp = await fs.realpath(os.tmpdir()); // macOS /tmp is a symlink; fixtures must sit on the real path.
const out = await fs.mkdtemp(path.join(tmp, 'nozeli-display-matrix-'));
const project = path.join(out, 'project'), config = path.join(out, '.Nozeli'), profile = path.join(config, 'desktop');
await fs.mkdir(project, {recursive: true});

// ---------------------------------------------------------------- fixtures --
const MD_NAME = '显示矩阵 文档.md';
const MD_TITLE = '显示矩阵 · 中文 Markdown';
const MD_MARKER = '显示矩阵关键中文段落_7414';
const CODE_NAME = 'matrix_long_code.py';
const CODE_MARKER = '显示矩阵_长代码_7415';
const PNG_NAME = '显示矩阵 图片.png';
const IMG_W = 320, IMG_H = 200;
const QUADRANTS = {
  topLeft: [214, 57, 80], topRight: [58, 118, 214],
  bottomLeft: [235, 184, 52], bottomRight: [38, 160, 92],
};
const PDF_NAME = '显示矩阵 文档.pdf';
const PDF_TEXT_1 = 'NOZELI DISPLAY MATRIX PDF', PDF_ONE = 'MARKER_PDF_ONE_7416', PDF_TWO = 'MARKER_PDF_TWO_7417';
const DOCX_NAME = '显示矩阵 文档.docx';
const DOCX_MARKER = '显示矩阵_中文文档_7418', DOCX_SCROLL = '显示矩阵滚动段落';
const XLSX_NAME = '显示矩阵 表格.xlsx';
const XLSX_MARKER = '显示矩阵_中文表格_7419';
const PPT_NAME = '显示矩阵 幻灯.pptx';
const PPT_MARKER = '显示矩阵_中文幻灯_7420';
const HTML_NAME = '本地页面.html';
const HTML_TITLE = '显示矩阵 · 本地页面', HTML_MARKER = '显示矩阵_本地页面_7421';
const WEB_TITLE = '显示矩阵 · 在线网页', WEB_H1 = '在线网页真实内容_7422', WEB_MARKER = '关键中文内容_显示矩阵在线_7423';

// Minimal deterministic PNG encoder (RGBA, filter 0) — no image dependencies.
const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1; return c; });
const crc32 = buf => { let c = ~0; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
function pngChunk(type, data) {
  const head = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head, data])));
  return Buffer.concat([len, head, data, crc]);
}
function quadrant(x, y) {
  if (x < IMG_W / 2) return y < IMG_H / 2 ? QUADRANTS.topLeft : QUADRANTS.bottomLeft;
  return y < IMG_H / 2 ? QUADRANTS.topRight : QUADRANTS.bottomRight;
}
function synthesizePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(IMG_W, 0); ihdr.writeUInt32BE(IMG_H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const rows = [];
  for (let y = 0; y < IMG_H; y++) {
    const row = Buffer.alloc(1 + IMG_W * 4); row[0] = 0;
    for (let x = 0; x < IMG_W; x++) { const [r, g, b] = quadrant(x, y); row.set([r, g, b, 255], 1 + x * 4); }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Minimal two-page PDF (Helvetica, ASCII markers) with a correct xref.
function synthesizePdf() {
  const escape = text => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = lines => {
    const body = lines.map(([size, dy, text], index) => `/F1 ${size} Tf 0 ${index ? dy : 0} Td (${escape(text)}) Tj`).join('\n');
    return `BT 60 700 Td\n${body}\nET`;
  };
  const contents1 = stream([[22, 0, PDF_TEXT_1], [14, -34, 'PAGE 1 OF 2 synthesized fixture'], [14, -24, PDF_ONE]]);
  const contents2 = stream([[22, 0, 'SECOND PAGE'], [14, -34, 'PAGE 2 OF 2 synthesized fixture'], [14, -24, PDF_TWO]]);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${contents1.length} >>\nstream\n${contents1}\nendstream`,
    `<< /Length ${contents2.length} >>\nstream\n${contents2}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// Office fixtures: runtime-synthesized derivatives of the known-good package
// fixtures (unique Chinese markers + a long DOCX tail for real scrolling).
async function synthesizeDocx() {
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'tests/fixtures/office/中文 文档.docx')));
  let xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /中文结构与保存检查/, 'DOCX fixture anchor paragraph missing');
  xml = xml.replace('中文结构与保存检查', DOCX_MARKER);
  const tail = Array.from({length: 70}, (_, i) =>
    `<w:p><w:r><w:t>${DOCX_SCROLL} 第 ${i + 1} 段：这是一段很长的中文内容，用于推动真实滚动并观察排版、换行与裁切表现。</w:t></w:r></w:p>`).join('');
  xml = xml.includes('<w:sectPr') ? xml.replace('<w:sectPr', tail + '<w:sectPr') : xml.replace('</w:body>', tail + '</w:body>');
  zip.file('word/document.xml', xml);
  return zip.generateAsync({type: 'nodebuffer'});
}
async function synthesizeXlsx() {
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'tests/fixtures/office/中文 表格.xlsx')));
  let xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const patched = xml.replace(/(<c r="A1"[^>]*><is><t>)[^<]*(<\/t>)/, `$1${XLSX_MARKER}$2`);
  assert.notEqual(patched, xml, 'XLSX fixture A1 inline cell missing');
  zip.file('xl/worksheets/sheet1.xml', patched);
  return zip.generateAsync({type: 'nodebuffer'});
}
async function synthesizePptx() {
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'tests/fixtures/ppt/compatibility.pptx')));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(xml, /NOZELI_PPTIST_TITLE/, 'PPTX fixture title missing');
  zip.file('ppt/slides/slide1.xml', xml.replace('NOZELI_PPTIST_TITLE 中文报告', `NOZELI_PPTIST_TITLE ${PPT_MARKER}`));
  return zip.generateAsync({type: 'nodebuffer'});
}

function synthesizeMarkdown() {
  const lines = [`# ${MD_TITLE}`, '',
    `${MD_MARKER}：本文档由显示矩阵验收在运行期合成，用于检查真实阅读面的中文标题、正文、表格与代码排版。`, '',
    '## 中文标题层级', ''];
  for (let i = 1; i <= 110; i++) lines.push(`第 ${i} 段：显示矩阵滚动内容——检查阅读滚动、段落间距与长中文句子的换行表现，避免水平溢出或裁切。`, '');
  lines.push('## 数据表格', '', '| 项目 | 数值 | 说明 |', '| --- | ---: | --- |',
    '| 显示矩阵 | 7414 | 中文表格单元格 |', `| 宽列单元格 | 1 | ${'很宽的中文列内容'.repeat(12)} |`, '',
    '## 代码块', '', '```python', '# CODE_FENCE 显示矩阵', 'def matrix_entry(value):', '    return value + 1',
    `long_line = "${'x'.repeat(240)}"  # 超长行观察内部滚动`, '```', '');
  return lines.join('\n');
}
function synthesizeLongCode() {
  const lines = [`# ${CODE_MARKER}`, '# 显示矩阵 · 长代码回归（运行期合成）', '"""Module docstring with 显示矩阵 Chinese marker."""', ''];
  for (let i = 1; i <= 760; i++) {
    lines.push(`def matrix_step_${String(i).padStart(4, '0')}(scale, offset=0):`, `    """第 ${i} 步：中文文档字符串，用于滚动与语法着色检查。"""`,
      `    return scale * ${i} + offset + len("${CODE_MARKER}")`, '');
    if (i % 120 === 0) lines.push(`# ${'—'.repeat(200)} 超长注释行观察水平方向处理`, '');
  }
  return lines.join('\n');
}
function synthesizeHtml() {
  const lines = ['<!doctype html>', '<html lang="zh-CN">', '<head>', '<meta charset="utf-8">',
    `<title>${HTML_TITLE}</title>`, '</head>', '<body>', `<h1 id="local-head">${HTML_MARKER}</h1>`,
    `<img id="local-shot" src="${PNG_NAME}" alt="合成图片">`,
    `<p>${HTML_TITLE}：本地 HTML 默认以隔离网页预览打开，检查真实 guest 的标题、图像与滚动；源码与对照模式随后切换。</p>`, '<main>'];
  for (let i = 1; i <= 320; i++) lines.push(`  <section id="block-${i}"><h2>段落 ${i} · 中文标题</h2><p>本地页面正文第 ${i} 段，用于推动编辑器真实滚动。</p></section>`);
  lines.push(`  <p class="long">${'本地页面超长行内容'.repeat(60)}</p>`, '</main>', '</body>', '</html>');
  return lines.join('\n');
}

const pngBytes = synthesizePng();
const webPageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${WEB_TITLE}</title>
<style>body{font-family:system-ui,"PingFang SC","Noto Sans CJK SC",sans-serif;margin:0;padding:24px}h1{font-size:28px}img{display:block;width:240px;border:1px solid #999}p{line-height:1.8}</style></head>
<body><h1 id="guest-head">${WEB_H1}</h1><img id="guest-img" src="/matrix.png" alt="合成图片">
<p id="guest-marker">${WEB_MARKER}：在线网页由回环服务器提供，检查真实 guest 内容而非外壳。</p>
${Array.from({length: 220}, (_, i) => `<p>在线正文第 ${i + 1} 段：真实 guest 滚动内容，用于观察网页显示、换行与字体。</p>`).join('\n')}
</body></html>`;

await fs.writeFile(path.join(project, MD_NAME), synthesizeMarkdown());
await fs.writeFile(path.join(project, CODE_NAME), synthesizeLongCode());
await fs.writeFile(path.join(project, PNG_NAME), pngBytes);
await fs.writeFile(path.join(project, PDF_NAME), synthesizePdf());
await fs.writeFile(path.join(project, DOCX_NAME), await synthesizeDocx());
await fs.writeFile(path.join(project, XLSX_NAME), await synthesizeXlsx());
await fs.writeFile(path.join(project, PPT_NAME), await synthesizePptx());
await fs.writeFile(path.join(project, HTML_NAME), synthesizeHtml());

// Loopback online origin (never a real network site, never credentials).
const webPort = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
const webOrigin = `http://127.0.0.1:${webPort}`;
const webServer = http.createServer((request, response) => {
  if (request.url === '/matrix.png') { response.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': pngBytes.length}).end(pngBytes); return; }
  response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end(webPageHtml);
});
await new Promise(resolve => webServer.listen(webPort, '127.0.0.1', resolve));

// ---------------------------------------------------------------- harness --
async function resolveBinary() {
  const requested = process.env.NOZELI_TEST_BINARY;
  if (!requested) return {binary: createRequire(import.meta.url)('electron'), packaged: false};
  const stat = await fs.stat(requested);
  if (stat.isDirectory()) {
    // macOS .app bundle: honor CFBundleExecutable instead of guessing a name.
    const plist = await fs.readFile(path.join(requested, 'Contents', 'Info.plist'), 'utf8');
    const name = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? 'Nozeli';
    const binary = path.join(requested, 'Contents', 'MacOS', name);
    await fs.access(binary, fs.constants.X_OK);
    return {binary, packaged: true};
  }
  await fs.access(requested, fs.constants.X_OK);
  return {binary: requested, packaged: true};
}
const {binary, packaged} = await resolveBinary();

const port = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
assert.notEqual(port, webPort, 'debug port must differ from the loopback origin port');
const env = {...process.env};
for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key) || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
const ozone = process.env.NOZELI_OZONE; // darwin never receives an Ozone switch.
Object.assign(env, {NOZELI_TEST_INSTANCE: '1', NOZELI_TEST_PICK: project, NOZELI_CONFIG_ROOT: config, NOZELI_USER_DATA: profile, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0'});
const args = [...(packaged ? [] : [path.join(root, 'src/main/main.cjs')]), '--inspect=0',
  ...(process.platform === 'darwin' ? [] : ['--ozone-platform=' + (ozone || 'wayland')])];

let child, browser, exited, log = '';
const logs = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw Error(label + ' aborted: main exited ' + JSON.stringify(await exited) + '\n' + log);
    let value;
    try { value = await check(); } catch {}
    if (value) return value;
    if (Date.now() > deadline) throw Error(label + ' timeout\n' + log.slice(-8000));
    await pause(150);
  }
}
function launch() {
  child = spawn(binary, args, {cwd: out, env, stdio: ['ignore', 'pipe', 'pipe']});
  const session = {text: ''};
  logs.push(session);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {session.text += bytes; log = session.text;});
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
}
async function connect() {
  await until(async () => {try {browser = await puppeteer.connect({browserURL: `http://127.0.0.1:${port}`, defaultViewport: null}); return true;} catch {return false;}}, 'Electron debug endpoint');
}
async function scope(predicate) {
  return until(async () => {
    for (const page of await browser.pages()) {
      const state = await page.evaluate(async () => (await window.nozeli.invoke('workspace.bootstrap', {})).value).catch(() => null);
      if (state && predicate(state)) {await page.waitForFunction(() => window.__nozeliReady, {timeout: 30000}).catch(() => {}); return page;}
    }
  }, 'Workspace scope ' + predicate);
}
async function call(page, op, payload = {}) {
  const result = await page.evaluate((op, payload) => window.nozeli.invoke(op, payload), op, payload);
  assert.equal(result.ok, true, op + ': ' + JSON.stringify(result.error));
  return result.value;
}
async function dismiss(page) {
  if (await page.$eval('#configuration-setup', node => node.open).catch(() => false)) await page.click('#configuration-cancel');
}
// Bounded teardown: SIGTERM, bounded wait, SIGKILL; never an unbounded exit await.
async function stop(signal = 'SIGTERM') {
  try { await browser?.disconnect(); } catch {}
  browser = null;
  if (!child || child.exitCode !== null) return child ? await exited : null;
  child.kill(signal);
  let exit = await Promise.race([exited, pause(8000).then(() => null)]);
  if (!exit && child.exitCode === null) {
    child.kill('SIGKILL');
    exit = await Promise.race([exited, pause(3000).then(() => null)]) ?? {code: child.exitCode, signal: child.signalCode, forced: true};
  }
  return exit;
}

// Raw CDP client for the online guest WebContentsView: puppeteer target typing
// is not guaranteed for child views; /json plus a private socket always is.
class GuestCdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {socket.once('open', resolve); socket.once('error', reject);});
    return new GuestCdp(socket);
  }
  constructor(socket) {
    this.socket = socket; this.pending = new Map(); this.seq = 0;
    this.socket.on('message', raw => {const message = JSON.parse(raw); const waiter = this.pending.get(message.id);
      if (waiter) {this.pending.delete(message.id); message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result);}});
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {const id = ++this.seq; this.pending.set(id, {resolve, reject});
      this.socket.send(JSON.stringify({id, method, params}));});
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }
  async screenshot() { const response = await this.send('Page.captureScreenshot', {format: 'png'}); return Buffer.from(response.data, 'base64'); }
  close() { try { this.socket.close(); } catch {} }
}

// ------------------------------------------------------------- measurement --
const SIZES = [{label: 'standard', width: 1180, height: 820}, {label: 'narrow', width: 660, height: 520}];
const report = {ok: false, out, project, config, profile, binary, packaged, platform: process.platform, port,
  loopback: {origin: webOrigin, title: WEB_TITLE}, sizes: SIZES, cases: {}, risks: [], checks: [], errors: []};
const risk = entry => report.risks.push(entry);
const mark = text => report.checks.push(text);
const parseRgb = value => (value?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/) || []).slice(1, 4).map(Number);
const colorDistance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

async function resizeTo(page, size) {
  // window-control resize always acts on the whole native window; only the
  // shell spans it fully. Content views sit beside the rail/sidebar, so the
  // shell owns the size wait and content pages only wait for stability.
  await call(shell, 'workspace.control', {type: 'window-control', action: 'resize', width: size.width, height: size.height});
  await shell.waitForFunction(([width, height]) => Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2,
    {timeout: 20000, polling: 200}, [size.width, size.height]);
  if (page !== shell) await stableViewport(page);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await pause(420); // PDF re-render debounce, engine relayout, guest bounds round trip.
}
async function stableViewport(page) {
  let previous = null, stable = 0;
  for (let attempt = 0; attempt < 80; attempt++) {
    const current = await page.evaluate(() => `${innerWidth}x${innerHeight}`).catch(() => null);
    if (current && current === previous) { if (++stable >= 3) return current; } else stable = 0;
    previous = current;
    await pause(180);
  }
  return previous;
}
const box = (ctx, selector) => ctx.evaluate(sel => {const el = document.querySelector(sel); if (!el) return null;
  const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)};}, selector);
const textMetrics = (ctx, selector) => ctx.evaluate(sel => {const el = document.querySelector(sel); if (!el) return null;
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  let background = null, node = el;
  while (node && node.nodeType === 1) {const c = getComputedStyle(node).backgroundColor; if (c && !/rgba\(.+,\s*0\)$/.test(c)) {background = c; break;} node = node.parentElement;}
  const range = document.createRange(); range.selectNodeContents(el); const tr = range.getBoundingClientRect();
  return {rect: {x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)},
    textWidth: Math.round(tr.width), textHeight: Math.round(tr.height), font: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight,
    color: cs.color, background};}, selector);
const canvasProbe = (ctx, selector, points) => ctx.evaluate((sel, pts) => {const el = document.querySelector(sel); if (!el) return null;
  const context = el.getContext && el.getContext('2d');
  const base = {width: el.width, height: el.height, cssWidth: el.clientWidth, cssHeight: el.clientHeight};
  if (!context) return {...base, readable: false};
  const at = (x, y) => Array.from(context.getImageData(Math.min(x, el.width - 1), Math.min(y, el.height - 1), 1, 1).data.slice(0, 3));
  const unique = new Set();
  const pixels=context.getImageData(0,0,el.width,el.height).data;
  for(let index=0;index<pixels.length;index+=4)unique.add(`${pixels[index]},${pixels[index+1]},${pixels[index+2]}`);
  return {...base, readable: true, points: Object.fromEntries(Object.entries(pts).map(([name, [x, y]]) => [name, at(x, y)])), uniqueColors: unique.size};}, selector, points);
const pageOverflow = page => page.evaluate(() => ({innerW: innerWidth, innerH: innerHeight,
  pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  pageY: document.documentElement.scrollHeight - document.documentElement.clientHeight}));
const scrollerMetrics = (ctx, selectors) => ctx.evaluate(sels => Object.fromEntries(sels.map(sel => {const el = document.querySelector(sel);
  return el ? [sel, {scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop}] : [sel, null];})), selectors);
const tokenColors = (ctx, selector) => ctx.evaluate(sel => new Set([...document.querySelectorAll(sel)].map(node => getComputedStyle(node).color)).size, selector);
const joinedText = (ctx, selector) => ctx.evaluate(sel => document.querySelector(sel)?.textContent ?? '', selector);
// Scroll evidence is a snapshot vector: every scrollable container's
// scrollTop plus the first content line's visual top (Monaco can translate
// lines; a frame's scroller is discovered generically, never guessed).
const scrollVector = (ctx, selectors, visualSelector) => ctx.evaluate((sels, visual) => {
  const named = sels.map(sel => document.querySelector(sel)).filter(Boolean).filter(el => el.scrollHeight > el.clientHeight + 4);
  const found = [...document.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight + 8 && el.clientHeight > 60).slice(0, 80);
  const els = [...new Set([...named, ...found])];
  const anchor = visual ? document.querySelector(visual) : document.querySelector('.ProseMirror p, .ProseMirror h1, p, h1');
  return {tops: els.map(el => Math.round(el.scrollTop)), anchor: anchor ? Math.round(anchor.getBoundingClientRect().top) : null};
}, selectors, visualSelector);
// Real wheel first; a focused PageDown is the bounded fallback if the host
// drops CDP wheel events.
async function driveScroll(page, point, ctx, visualSelector) {
  const snap = () => scrollVector(ctx, [], visualSelector);
  const deltaOf = (before, after) => Math.max(
    Math.max(0, ...before.tops.map((top, index) => Math.abs((after.tops[index] ?? top) - top))),
    before.anchor !== null && after.anchor !== null ? Math.abs(after.anchor - before.anchor) : 0);
  const before = await snap();
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel({deltaY: 900});
  await pause(380);
  const afterWheel = await snap();
  const wheelDelta = deltaOf(before, afterWheel);
  if (wheelDelta > 2) return {path: 'wheel', delta: wheelDelta};
  await page.mouse.click(point.x, point.y);
  await pause(120);
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await pause(380);
  const afterKey = await snap();
  const keyDelta = deltaOf(before, afterKey);
  return {path: keyDelta > 2 ? 'keyboard' : 'none', delta: keyDelta};
}


function recordTextRisks(entry, metrics, viewport) {
  if (!metrics) return;
  if (metrics.textWidth === 0 || metrics.rect.width === 0) risk({case: entry, kind: 'text-not-rendered', detail: JSON.stringify(metrics)});
  const fg = parseRgb(metrics.color), bg = parseRgb(metrics.background);
  if (fg && bg && colorDistance(fg, bg) < 60) risk({case: entry, kind: 'low-contrast', detail: `color ${metrics.color} on ${metrics.background}`});
  if (viewport && metrics.rect.right > viewport.innerW + 1) risk({case: entry, kind: 'text-exceeds-viewport', detail: `right ${metrics.rect.right} > ${viewport.innerW}`});
  if (metrics.rect.height === 0) risk({case: entry, kind: 'zero-height-text', detail: metrics.font});
}
const recordPageRisks = (entry, overflow) => {
  if (overflow.pageX > 2) risk({case: entry, kind: 'page-horizontal-overflow', detail: `${overflow.pageX}px beyond ${overflow.innerW}`});
  if (overflow.pageY > 2) risk({case: entry, kind: 'page-vertical-overflow', detail: `${overflow.pageY}px beyond ${overflow.innerH}`});
};

async function clipShot(page, selector, file) {
  const rect = await box(page, selector);
  if (!rect || rect.width <= 0 || rect.height <= 0) {risk({case: path.basename(file), kind: 'empty-content-box', detail: selector}); return;}
  await page.screenshot({path: file, captureBeyondViewport:false, clip: {x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height}});
}

// ------------------------------------------------------------------- cases --
let shell;
const pages = [];
const track = page => { page.on('pageerror', error => report.errors.push(page.url() + ': ' + error.message)); pages.push(page); return page; };
const guestSockets = [];
async function openDoc(name) {
  await resizeTo(shell,SIZES[0]);
  await shell.bringToFront();
  const hidden=await shell.$eval('#app',node=>node.classList.contains('narrow-layout')?!node.classList.contains('drawer-files-open'):node.classList.contains('files-collapsed'));
  if(hidden)await shell.click('#file-toggle');
  await shell.waitForSelector(`#file-tree button[data-path="${name}"]`, {timeout: 60000});
  await shell.click(`#file-tree button[data-path="${name}"]`);
  const page = track(await until(async () => {
    for (const candidate of await browser.pages()) {
      if (candidate === shell) continue;
      const state = await candidate.evaluate(async () => (await window.nozeli.invoke('workspace.bootstrap', {})).value).catch(() => null);
      if (state && state.kind === 'document' && state.relPath === name) return candidate;
    }
  }, 'document page for ' + name));
  await page.waitForFunction(() => window.__nozeliReady, {timeout: 30000}).catch(() => {});
  await page.waitForFunction(expected => document.querySelector('#file-path')?.textContent === expected &&
    document.querySelector('#save-status')?.dataset?.state === 'saved', {timeout: 45000, polling: 200}, name);
  await page.bringToFront().catch(() => {});
  return page;
}
const centerOf = rect => ({x: rect.x + rect.width / 2, y: rect.y + rect.height / 2});
async function captureEachSize(name, page, perSize, key = 'sizes') {
  const sizes = [];
  for (const size of SIZES) {
    await resizeTo(page, size);
    const entry = {size: `${size.width}x${size.height}`, screenshot: path.join(out, `${name}-${size.label}.png`)};
    await perSize(entry, size);
    entry.contentViewport = await page.evaluate(() => ({innerW: innerWidth, innerH: innerHeight})).catch(() => null); // actual, never assumed equal to the window
    sizes.push(entry);
  }
  report.cases[name][key] = sizes;
}

try {
  launch(); await connect();
  shell = track(await scope(state => state.role === 'shell')); await dismiss(shell);
  const picked = await call(shell, 'project.pick'); report.projectId = picked.project.id;
  await shell.reload({waitUntil: 'domcontentloaded'}); await shell.waitForFunction(() => window.__nozeliReady); await dismiss(shell);
  await shell.waitForSelector(`#recent [data-project-id="${report.projectId}"]`); await shell.click(`#recent [data-project-id="${report.projectId}"]`);

  // ---- Markdown reading surface: title, key Chinese, table, scroll. ----
  {
    const page = await openDoc(MD_NAME);
    report.cases.markdown = {file: MD_NAME};
    if (await page.$eval('#text-preview', node => node.hidden).catch(() => true)) await page.click('#text-mode-toggle');
    await until(async () => (await page.$eval('#text-preview h1', node => node.textContent.trim()).catch(() => null)) === MD_TITLE, 'markdown rendered h1');
    assert.equal(await page.$eval('#text-preview h1', node => node.textContent.trim()), MD_TITLE, 'MD rendered title');
    const body = await joinedText(page, '#text-preview');
    assert.ok(body.includes(MD_MARKER), 'MD key Chinese paragraph missing');
    assert.ok((await page.$$('#text-preview table')).length >= 1, 'MD table missing');
    assert.ok((await page.$eval('#text-preview table', node => node.textContent)).includes('中文表格单元格'), 'MD table Chinese cell missing');
    assert.ok((await page.$$('#text-preview pre code')).length >= 1, 'MD code fence missing');
    await captureEachSize('markdown', page, async entry => {
      const overflow = await pageOverflow(page);
      const h1 = await textMetrics(page, '#text-preview h1');
      const para = await textMetrics(page, '#text-preview p');
      const tableBox = await box(page, '#text-preview table');
      const reader = await box(page, '#reader-scroll');
      const scrollers = await scrollerMetrics(page, ['#reader-scroll', '#text-preview', '#text-host']);
      const scroll = await driveScroll(page, centerOf(reader), page);
      assert.ok(scroll.delta > 2, `MD reader must really scroll (${scroll.path}, delta ${scroll.delta})`);
      const label = `markdown@${entry.size}`;
      recordPageRisks(label, overflow);
      recordTextRisks(label, h1, overflow); recordTextRisks(label, para, overflow);
      if (tableBox && reader && tableBox.width > reader.width + 2) risk({case: label, kind: 'table-wider-than-reader', detail: `table ${tableBox.width}px vs reader ${reader.width}px`});
      if (scrollers['#text-preview']?.scrollWidth - scrollers['#text-preview']?.clientWidth > 2)
        risk({case: label, kind: 'preview-horizontal-overflow', detail: `${scrollers['#text-preview'].scrollWidth - scrollers['#text-preview'].clientWidth}px`});
      await clipShot(page, '#reader-scroll', entry.screenshot);
      entry.metrics = {overflow, h1, para, tableBox, reader, scroll: {path: scroll.path, delta: scroll.delta}};
    });
    mark('Markdown: rendered Chinese title/paragraph/table at two native sizes with real reader scroll');
  }

  // ---- Long code: Monaco content, token colors, real editor scroll. ----
  {
    const page = await openDoc(CODE_NAME);
    report.cases['long-code'] = {file: CODE_NAME};
    await page.waitForSelector('#text-host .monaco-editor', {timeout: 60000});
    await page.waitForSelector('#text-host .view-line', {timeout: 60000});
    const modelText = await page.evaluate(() => window.__nozeliInput.text());
    assert.ok(modelText.includes(CODE_MARKER), 'code model missing Chinese marker');
    assert.ok(modelText.length > 20000, 'code fixture must be long enough to scroll');
    await captureEachSize('long-code', page, async entry => {
      const overflow = await pageOverflow(page);
      const lineText = await page.evaluate(() => [...document.querySelectorAll('#text-host .view-line')].slice(0, 6).map(n => n.textContent).join(''));
      assert.ok(lineText.includes(CODE_MARKER), 'rendered Monaco lines missing the Chinese marker');
      const editorBox = await box(page, '#text-host .monaco-editor');
      const colors = await tokenColors(page, '#text-host .view-line span');
      const scroll = await driveScroll(page, centerOf(editorBox), page, '#text-host .view-line');
      assert.ok(scroll.delta > 2, `Monaco must really scroll (${scroll.path}, delta ${scroll.delta})`);
      const label = `long-code@${entry.size}`;
      recordPageRisks(label, overflow);
      if (colors < 3) risk({case: label, kind: 'syntax-colors-flat', detail: `${colors} token colors`});
      recordTextRisks(label, await textMetrics(page, '#text-host .view-line'), overflow);
      await clipShot(page, '#text-host', entry.screenshot);
      entry.metrics = {overflow, editorBox, tokenColors: colors, scroll: {path: scroll.path, delta: scroll.delta}};
    });
    mark('Long code: Monaco renders Chinese content with token colors and real scroll at two sizes');
  }

  // ---- PNG: naturalSize + exact synthesized pixels on the display canvas. ----
  {
    const page = await openDoc(PNG_NAME);
    report.cases.image = {file: PNG_NAME};
    await page.waitForSelector('#image-host canvas', {timeout: 60000});
    await page.waitForFunction(([width,height]) => document.querySelector('#image-size')?.textContent.startsWith(`${width} × ${height}`), {timeout: 30000},[IMG_W,IMG_H]);
    await captureEachSize('image', page, async entry => {
      const overflow = await pageOverflow(page);
      const probe = await canvasProbe(page, '#image-host canvas',
        {topLeft: [60, 50], topRight: [260, 50], bottomLeft: [60, 150], bottomRight: [260, 150]});
      assert.ok(probe, 'image canvas present');
      assert.equal(probe.width, IMG_W, 'image canvas backing width must equal natural width');
      assert.equal(probe.height, IMG_H, 'image canvas backing height must equal natural height');
      for (const [name, expected] of Object.entries(QUADRANTS)) {
        const actual = probe.points[name];
        assert.ok(actual && colorDistance(actual, expected) <= 3, `quadrant ${name} pixels ${actual} != ${expected}`);
      }
      assert.ok(probe.uniqueColors >= 4, 'image canvas must show all four quadrants');
      const label = `image@${entry.size}`;
      recordPageRisks(label, overflow);
      if (probe.cssWidth < 40 || probe.cssHeight < 25) risk({case: label, kind: 'image-tiny-on-screen', detail: `${probe.cssWidth}x${probe.cssHeight} css px`});
      await clipShot(page, '#image-host', entry.screenshot);
      entry.metrics = {overflow, probe, sizeLabel: await page.$eval('#image-size', node => node.textContent)};
    });
    mark('PNG: naturalSize 320x200 honored, canvas pixels match the synthesized quadrants at two sizes');
  }

  // ---- PDF: page canvas + text layer, real page-two navigation. ----
  {
    const page = await openDoc(PDF_NAME);
    report.cases.pdf = {file: PDF_NAME};
    await page.waitForSelector('.pdf-page canvas', {timeout: 60000});
    await page.waitForFunction(() => document.querySelector('#pdf-count')?.textContent === '2', {timeout: 30000});
    await captureEachSize('pdf', page, async entry => {
      const overflow = await pageOverflow(page);
      const probe = await canvasProbe(page, '.pdf-page canvas', {top: [150, 40]});
      assert.ok(probe && probe.width > 0 && probe.height > 0, 'PDF page canvas present');
      assert.ok(probe.readable && probe.uniqueColors >= 5, `PDF canvas must show rendered text (${probe?.uniqueColors} colors)`);
      const textLayer = await page.evaluate(() => [...document.querySelectorAll('.pdf-page .textLayer span')].map(node => node.textContent).join(''));
      assert.ok(textLayer.includes(PDF_ONE), 'PDF page 1 text layer marker missing');
      const pageBox = await box(page, '.pdf-page');
      const reader = await box(page, '#reader-scroll');
      if (pageBox && reader && pageBox.width > reader.width + 2) risk({case: `pdf@${entry.size}`, kind: 'pdf-page-wider-than-reader', detail: `${pageBox.width} vs ${reader.width}`});
      recordPageRisks(`pdf@${entry.size}`, overflow);
      await clipShot(page, '#reader-scroll', entry.screenshot);
      entry.metrics = {overflow, canvas: {width: probe.width, height: probe.height, uniqueColors: probe.uniqueColors}, pageBox, text: textLayer.slice(0, 120)};
    });
    // Page navigation happens once, at the current (narrow) size.
    await shell.bringToFront();
    await shell.click('[data-workspace-command="content-page-next"]');
    await page.waitForFunction(() => document.querySelector('#pdf-page')?.value === '2', {timeout: 30000});
    await until(async () => (await page.evaluate(() => [...document.querySelectorAll('.pdf-page .textLayer span')].map(node => node.textContent).join(''))).includes(PDF_TWO), 'PDF page 2 text layer');
    const probe2 = await canvasProbe(page, '.pdf-page canvas', {top: [150, 40]});
    assert.ok(probe2.readable && probe2.uniqueColors >= 5, 'PDF page 2 canvas must render text');
    await clipShot(page, '#reader-scroll', path.join(out, 'pdf-narrow-page2.png'));
    report.cases.pdf.page2 = {screenshot: path.join(out, 'pdf-narrow-page2.png'), canvas: {width: probe2.width, height: probe2.height, uniqueColors: probe2.uniqueColors}};
    mark('PDF: two pages each render a real canvas + text layer; explicit page-two navigation works');
  }

  // ---- DOCX: office iframe engine ready, Chinese text, real scroll. ----
  {
    const page = await openDoc(DOCX_NAME);
    report.cases.docx = {file: DOCX_NAME};
    const frame = await until(() => page.frames().find(f => f.url().endsWith('/word-frame.html')), 'Word frame');
    await frame.waitForFunction(() => window.nozeliWordEditor?.activeEditor, {timeout: 90000});
    await frame.waitForSelector('.ProseMirror', {timeout: 60000});
    assert.ok((await frame.evaluate(() => window.nozeliWordEditor.activeEditor.state.doc.textContent)).includes(DOCX_MARKER),
      'Word engine document missing Chinese marker');
    await captureEachSize('docx', page, async entry => {
      const overflow = await pageOverflow(page);
      const domText = await joinedText(frame, '.ProseMirror');
      assert.ok(domText.includes(DOCX_MARKER), 'Word DOM missing Chinese marker');
      assert.ok(domText.includes(DOCX_SCROLL), 'Word DOM missing scroll paragraphs');
      const metrics = await textMetrics(frame, '.ProseMirror');
      const iframe = await box(page, 'iframe[src*="word-frame"]');
      assert.ok(iframe && iframe.width > 100 && iframe.height > 100, 'Word iframe must have a real layout box');
      const scroll = await driveScroll(page, centerOf(iframe), frame);
      assert.ok(scroll.delta > 2, `Word document must really scroll (${scroll.path}, delta ${scroll.delta})`);
      const label = `docx@${entry.size}`;
      recordPageRisks(label, overflow);
      recordTextRisks(label, metrics, overflow);
      await clipShot(page, 'iframe[src*="word-frame"]', entry.screenshot);
      entry.metrics = {overflow, iframe, scroll: {path: scroll.path, delta: scroll.delta}, font: metrics?.font, fontSize: metrics?.fontSize};
    });
    mark('DOCX: word engine ready, Chinese marker + long tail rendered, real document scroll at two sizes');
  }

  // ---- XLSX: sheet engine ready, marker cell, rendered sheet canvas. ----
  {
    const page = await openDoc(XLSX_NAME);
    report.cases.xlsx = {file: XLSX_NAME};
    const frame = await until(() => page.frames().find(f => f.url().endsWith('/sheet-frame.html')), 'Sheet frame');
    await frame.waitForFunction(() => window.nozeliSheetEditor?.getAllSheets()?.length, {timeout: 90000});
    await frame.waitForFunction(() => !document.querySelector('#sheet')?.inert, {timeout: 90000});
    const a1 = await frame.evaluate(() => nozeliSheetEditor.getCellValue(0, 0));
    assert.ok(String(a1).includes(XLSX_MARKER), `Sheet A1 must hold the marker, got ${JSON.stringify(a1)}`);
    await captureEachSize('xlsx', page, async entry => {
      const overflow = await pageOverflow(page);
      let probe = await canvasProbe(frame, '#sheet canvas', {center: [400, 40]});
      if (!probe) probe = await canvasProbe(frame, 'canvas', {center: [400, 40]});
      assert.ok(probe && probe.width > 0, 'Sheet canvas present');
      const iframe = await box(page, 'iframe[src*="sheet-frame"]');
      assert.ok(iframe && iframe.width > 100 && iframe.height > 100, 'Sheet iframe must have a real layout box');
      if (!probe.readable) risk({case: `xlsx@${entry.size}`, kind: 'sheet-canvas-not-2d-readable', detail: `${probe.width}x${probe.height}`});
      else if (probe.uniqueColors < 2) risk({case: `xlsx@${entry.size}`, kind: 'sheet-canvas-near-blank', detail: `${probe.uniqueColors} colors`});
      const bars = await frame.evaluate(() => ['.luckysheet-scrollbar-x', '.luckysheet-scrollbar-y'].map(sel => Boolean(document.querySelector(sel))));
      if (!bars.some(Boolean)) risk({case: `xlsx@${entry.size}`, kind: 'sheet-scroll-affordance-missing', detail: JSON.stringify(bars)});
      recordPageRisks(`xlsx@${entry.size}`, overflow);
      await clipShot(page, 'iframe[src*="sheet-frame"]', entry.screenshot);
      entry.metrics = {overflow, iframe, canvas: probe && {width: probe.width, height: probe.height, readable: probe.readable, uniqueColors: probe.uniqueColors}, scrollbars: bars};
    });
    mark('XLSX: sheet engine ready with marker cell rendered on a live canvas at two sizes');
  }

  // ---- PPTX: pptist engine ready, Chinese slide title, real canvas box. ----
  {
    const page = await openDoc(PPT_NAME);
    report.cases.pptx = {file: PPT_NAME};
    const frame = await until(() => page.frames().find(f => f.url().includes('/ppt-vendor/')), 'PPT frame');
    await frame.waitForFunction(() => window.__nozeliPptist?.store?.slides?.length === 3, {timeout: 90000});
    await captureEachSize('pptx', page, async entry => {
      const overflow = await pageOverflow(page);
      const domText = await joinedText(frame, 'body');
      assert.ok(domText.includes(PPT_MARKER), 'PPT DOM missing Chinese slide title');
      const canvasBox = await box(frame, '.canvas');
      assert.ok(canvasBox && canvasBox.width > 80 && canvasBox.height > 60, 'PPT canvas must have a real layout box');
      const editable = await frame.$$eval('.ProseMirror', nodes => nodes.length);
      assert.ok(editable >= 1, 'PPT editable text surfaces missing');
      const metrics = await textMetrics(frame, '.ProseMirror');
      const label = `pptx@${entry.size}`;
      recordPageRisks(label, overflow);
      recordTextRisks(label, metrics, overflow);
      await clipShot(page, 'iframe[src*="/ppt-vendor/"]', entry.screenshot);
      entry.metrics = {overflow, canvasBox, editable, font: metrics?.font, fontSize: metrics?.fontSize};
    });
    mark('PPTX: pptist engine ready (3 slides), Chinese slide title rendered at two sizes');
  }

  // ---- Local HTML: default offline web-preview guest, then source, then split. ----
  {
    const page = await openDoc(HTML_NAME);
    report.cases['local-html'] = {file: HTML_NAME};
    const guestEntrySuffix = encodeURIComponent(HTML_NAME);
    const localGuest = async label => {
      const target = await until(async () => {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        // Mode switches replace the guest; wait until exactly one live target remains.
        const matches = list.filter(item => item.url.includes('.invalid/') && item.url.endsWith(guestEntrySuffix) && item.webSocketDebuggerUrl);
        return matches.length === 1 ? matches[0] : null;
      }, 'local preview guest target ' + label);
      const socket = await GuestCdp.connect(target.webSocketDebuggerUrl);
      guestSockets.push(socket);
      return socket;
    };

    // Phase 1 — the real guest preview (default mode 网页), never the wrapper.
    await page.waitForSelector('#web-preview-toolbar:not([hidden])', {timeout: 30000});
    await page.waitForFunction(() => document.querySelector('#web-mode-web')?.getAttribute('aria-pressed') === 'true', {timeout: 30000});
    const previewBox = () => box(page, '.isolated-viewport');
    await until(async () => (await previewBox())?.width > 50, 'local preview viewport box');
    {
      const cdp = await localGuest('web');
      await until(async () => (await cdp.evaluate('document.readyState')) === 'complete', 'local guest load');
      await until(async () => (await cdp.evaluate("(() => document.querySelector('#local-shot')?.complete)()")) === true,
        'local guest image decode', 15000).catch(() => {});
      const info = await cdp.evaluate(`(() => ({ title: document.title, h1: document.querySelector('#local-head')?.textContent.trim(),
        img: (() => { const i = document.querySelector('#local-shot'); return i ? {complete: i.complete, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight} : null; })(),
        scrollHeight: document.documentElement.scrollHeight, innerHeight, innerWidth }))()`);
      assert.equal(info.title, HTML_TITLE, 'local preview guest title');
      assert.equal(info.h1, HTML_MARKER, 'local preview guest h1 Chinese marker');
      if (info.img?.complete && (info.img.naturalWidth || info.img.naturalHeight))
        assert.ok(info.img.naturalWidth === IMG_W && info.img.naturalHeight === IMG_H,
          `local guest img naturalSize must be ${IMG_W}x${IMG_H}, got ${JSON.stringify(info.img)}`);
      else risk({case: 'local-html@preview', kind: 'local-preview-image-not-served', detail: JSON.stringify(info.img)});
      assert.ok(info.scrollHeight > info.innerHeight + 200, 'local guest page must be tall enough to scroll');
      report.cases['local-html'].preview = {guest: {title: info.title, h1: info.h1, image: info.img}, sizes: []};
      for (const size of SIZES) {
        await resizeTo(page, size);
        const viewport = await previewBox();
        const guestView = await cdp.evaluate('(() => ({innerWidth, innerHeight}))()');
        const scrollY = await cdp.evaluate('(() => { scrollTo(0, 400); return scrollY; })()');
        assert.equal(scrollY, 400, 'local guest must really scroll');
        if (viewport && Math.abs(viewport.width - guestView.innerWidth) > 6)
          risk({case: `local-html@preview@${size.label}`, kind: 'guest-bounds-mismatch', detail: `viewport ${viewport.width}px vs guest ${guestView.innerWidth}px`});
        await fs.writeFile(path.join(out, `local-guest-${size.label}.png`), await cdp.screenshot());
        await clipShot(page, '.isolated-viewport', path.join(out, `local-preview-${size.label}.png`));
        report.cases['local-html'].preview.sizes.push({size: `${size.width}x${size.height}`, viewport, guestView,
          guestScreenshot: path.join(out, `local-guest-${size.label}.png`), screenshot: path.join(out, `local-preview-${size.label}.png`)});
      }
      cdp.close();
    }

    // Phase 2 — explicit 源码 mode: the Monaco source checks.
    await page.click('#web-mode-source');
    await page.waitForFunction(() => document.querySelector('#web-mode-source')?.getAttribute('aria-pressed') === 'true', {timeout: 30000});
    await page.waitForSelector('#text-host .monaco-editor', {timeout: 60000});
    await page.waitForSelector('#text-host .view-line', {timeout: 60000});
    const modelText = await page.evaluate(() => window.__nozeliInput.text());
    assert.ok(modelText.includes(HTML_MARKER) && modelText.includes('<title>'), 'HTML model missing content');
    await captureEachSize('local-html', page, async entry => {
      const overflow = await pageOverflow(page);
      const lineText = await page.evaluate(() => [...document.querySelectorAll('#text-host .view-line')].slice(0, 10).map(n => n.textContent).join(''));
      assert.ok(lineText.includes(HTML_MARKER), 'rendered HTML lines missing the Chinese marker');
      const editorBox = await box(page, '#text-host .monaco-editor');
      const colors = await tokenColors(page, '#text-host .view-line span');
      const scroll = await driveScroll(page, centerOf(editorBox), page, '#text-host .view-line');
      assert.ok(scroll.delta > 2, `HTML source must really scroll (${scroll.path}, delta ${scroll.delta})`);
      const label = `local-html@source@${entry.size}`;
      recordPageRisks(label, overflow);
      if (colors < 3) risk({case: label, kind: 'syntax-colors-flat', detail: `${colors} token colors`});
      entry.screenshot = path.join(out, `local-source-${entry.size.split('x')[0]}.png`);
      await clipShot(page, '#text-host', entry.screenshot);
      entry.metrics = {overflow, editorBox, tokenColors: colors, scroll: {path: scroll.path, delta: scroll.delta}};
    }, 'source');

    // Phase 3 — 对照 split: real boxes on both sides and the split guest size.
    await page.click('#web-mode-split');
    await page.waitForFunction(() => document.querySelector('#web-mode-split')?.getAttribute('aria-pressed') === 'true', {timeout: 30000});
    await until(async () => (await box(page, '#web-preview-pane .isolated-viewport'))?.width > 50, 'split preview viewport box');
    const splitCdp = await localGuest('split');
    await until(async () => (await splitCdp.evaluate('document.readyState')) === 'complete', 'split guest load');
    await captureEachSize('local-html', page, async entry => {
      const left = await box(page, '#text-host');
      const right = await box(page, '#web-preview-pane .isolated-viewport');
      assert.ok(left && left.width > 80 && left.height > 80, 'split source pane must have a real box');
      assert.ok(right && right.width > 80 && right.height > 80, 'split preview pane must have a real box');
      if(left&&right&&Math.min(left.x+left.width,right.x+right.width)-Math.max(left.x,right.x)>2&&Math.min(left.y+left.height,right.y+right.height)-Math.max(left.y,right.y)>2)
        risk({case:`local-html@split@${entry.size}`,kind:'split-panes-overlap',detail:JSON.stringify({source:left,preview:right})});
      const guestView = await splitCdp.evaluate('(() => ({innerWidth, innerHeight}))()');
      if (right && Math.abs(right.width - guestView.innerWidth) > 6)
        risk({case: `local-html@split@${entry.size}`, kind: 'guest-bounds-mismatch', detail: `pane ${right.width}px vs guest ${guestView.innerWidth}px`});
      entry.screenshot = path.join(out, `local-split-${entry.size.split('x')[0]}.png`);
      await clipShot(page, '#reader-scroll', entry.screenshot);
      entry.metrics = {sourcePane: left, previewPane: right, guestView};
    }, 'split');
    splitCdp.close();
    mark('Local HTML: default guest preview (title/img naturalSize/scroll, wide+narrow), then source mode checks, then split pane boxes + guest size');
  }

  // ---- Loopback online page: the REAL guest, not the wrapper. ----
  {
    await shell.bringToFront().catch(() => {});
    await shell.click('#workspace-open-website');
    await shell.waitForSelector('dialog[open] input[aria-label="网站地址"]', {timeout: 30000});
    await shell.type('dialog[open] input[aria-label="网站地址"]', webOrigin + '/');
    await shell.keyboard.press('Enter');
    await shell.waitForSelector('dialog[open]', {hidden: true, timeout: 30000});
    const wrapper = track(await scope(state => state.role === 'surface' && state.kind === 'web'));
    await wrapper.waitForFunction(() => window.__nozeliReady, {timeout: 60000});
    await wrapper.waitForSelector('.online-browser-toolbar input', {timeout: 30000});
    report.cases.online = {url: webOrigin + '/'};

    const guest = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find(target => target.url.startsWith(webOrigin) && target.webSocketDebuggerUrl);
    }, 'online guest CDP target');
    let cdp; guestSockets.push(cdp = await GuestCdp.connect(guest.webSocketDebuggerUrl));
    await until(async () => (await cdp.evaluate('document.readyState')) === 'complete', 'guest load');
    const guestInfo = await cdp.evaluate(`(() => ({ title: document.title, h1: document.querySelector('#guest-head')?.textContent.trim(),
      marker: document.body.textContent.includes('${WEB_MARKER}'),
      img: (() => { const i = document.querySelector('#guest-img'); return i ? {complete: i.complete, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight, src: i.currentSrc} : null; })(),
      scrollHeight: document.documentElement.scrollHeight, innerHeight, innerWidth }))()`);
    assert.equal(guestInfo.title, WEB_TITLE, 'guest document title');
    assert.equal(guestInfo.h1, WEB_H1, 'guest h1 key Chinese content');
    assert.ok(guestInfo.marker, 'guest key Chinese paragraph missing');
    assert.ok(guestInfo.img?.complete && guestInfo.img.naturalWidth === IMG_W && guestInfo.img.naturalHeight === IMG_H,
      `guest image naturalSize must be ${IMG_W}x${IMG_H}, got ${JSON.stringify(guestInfo.img)}`);
    assert.ok(guestInfo.scrollHeight > guestInfo.innerHeight + 400, 'guest page must be tall enough to scroll');

    await until(async()=>(await wrapper.$eval('.online-browser-toolbar input',node=>node.value).catch(()=>null))===webOrigin+'/','online address reflects the committed page');
    await captureEachSize('online', wrapper, async (entry, size) => {
      const overflow = await pageOverflow(wrapper);
      const heading = await wrapper.$eval('.online-browser-toolbar input', node => node.value);
      assert.equal(heading,webOrigin+'/','address bar retains the committed URL independently of guest title');
      const errored = await wrapper.$eval('.online-browser-status', node => node.classList.contains('is-error')).catch(() => false);
      assert.equal(errored, false, 'guest load must not surface an error status');
      const viewport = await box(wrapper, '.online-browser-viewport');
      const toolbar = await box(wrapper, '.online-browser-toolbar');
      const guestView = await cdp.evaluate('(() => ({innerWidth, innerHeight, scrollY}))()');
      const label = `online@${entry.size}`;
      recordPageRisks(label, overflow);
      if (toolbar && toolbar.width > overflow.innerW + 2) risk({case: label, kind: 'toolbar-wider-than-window', detail: `${toolbar.width} vs ${overflow.innerW}`});
      if (viewport && Math.abs(viewport.width - guestView.innerWidth) > 6)
        risk({case: label, kind: 'guest-bounds-mismatch', detail: `wrapper viewport ${viewport.width}px vs guest ${guestView.innerWidth}px`});
      const scrollY = await cdp.evaluate('(() => { scrollTo(0, 600); return scrollY; })()');
      assert.equal(scrollY, 600, 'guest must really scroll');
      const font = await cdp.evaluate(`(() => { const el = document.querySelector('#guest-head'); const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
        return {font: cs.fontFamily, fontSize: cs.fontSize, color: cs.color, width: Math.round(r.width), height: Math.round(r.height)}; })()`);
      if (font.width === 0) risk({case: label, kind: 'guest-h1-zero-box', detail: JSON.stringify(font)});
      await fs.writeFile(path.join(out, `online-guest-${size.label}.png`), await cdp.screenshot());
      await clipShot(wrapper, '.online-browser-content', entry.screenshot);
      entry.guestScreenshot = path.join(out, `online-guest-${size.label}.png`);
      entry.metrics = {overflow, heading, viewport, toolbar, guestView, guestFont: font};
    });
    const guestWidths = report.cases.online.sizes.map(sizeEntry => sizeEntry.metrics.guestView.innerWidth);
    assert.ok(Math.abs(guestWidths[0] - guestWidths[1]) > 200,
      `native window resize must re-layout the guest (widths ${guestWidths.join(' -> ')})`);
    report.cases.online.guest = {title: guestInfo.title, h1: guestInfo.h1, image: guestInfo.img,
      screenshots: report.cases.online.sizes.map(sizeEntry => ({size: sizeEntry.size, guest: sizeEntry.guestScreenshot, wrapper: sizeEntry.screenshot}))};
    cdp.close();
    mark('Online page: real guest captured over CDP — Chinese title/h1, img naturalSize 320x200, real scroll, guest re-layout across both native sizes');
  }

  // ---- Graceful quit with an exact exit receipt. ----
  await call(shell, 'session.requestClose');
  const graceful = await Promise.race([exited, pause(20000).then(() => null)]);
  if (!graceful) {
    report.exits = await stop();
    throw Error('Graceful close did not exit in 20s; forced exit receipt ' + JSON.stringify(report.exits));
  }
  report.exits = graceful;
  assert.deepEqual(graceful, {code: 0, signal: null}, 'graceful close must exit cleanly');
  report.ok = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  try { await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); } catch {}
  try { await fs.writeFile(path.join(out, 'electron-session-logs.json'), JSON.stringify(logs.map(session => session.text), null, 2)); } catch {}
  if (process.exitCode && child.exitCode === null) await stop();
  else if (child.exitCode === null) await stop();
  for (const socket of guestSockets) socket.close();
  console.log(JSON.stringify({ok: report.ok, out, risks: report.risks, riskCount: report.risks.length,
    checks: report.checks, error: report.error ? String(report.error).split('\n')[0] : null, projectId: report.projectId}));
  process.exit(process.exitCode ?? 0); // undici keep-alive sockets must not hold the run open.
}
