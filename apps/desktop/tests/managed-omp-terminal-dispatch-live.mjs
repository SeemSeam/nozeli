// managed-omp-terminal-dispatch-live.mjs — P4 TUI-native：真实可见 Electron 验证 OMP 终端。
// OMP 角色 = OmpTuiSession（唯一 PTY/session owner）；attach 是同一 PTY 的真实视图（replay/resize/input）；
// 零 codex 派生；草稿路径健康；正常关闭 exit 0。运行：NOZELI_OMP_BIN=<omp> node tests/managed-omp-terminal-dispatch-live.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const appRoot = path.resolve(import.meta.dirname, '..');
const OMP_BIN = process.env.NOZELI_OMP_BIN;
if (!OMP_BIN) { console.error('需要 NOZELI_OMP_BIN'); process.exit(2); }
const pidOf = root => createHash('sha256').update(root).digest('hex');
const MODELS_YML = ['providers:', '  synthetic-omp:', '    api: openai-completions', '    baseUrl: http://127.0.0.1:9/', '    auth: none',
  '    models:', '      - id: model', '        reasoning: true', ''].join('\n');

const profile = await mkdtemp(path.join(os.tmpdir(), 'p4td-'));
const projectA = path.join(profile, 'projA');
await mkdir(projectA, { recursive: true, mode: 0o700 }); await writeFile(path.join(projectA, 'readme.md'), '# synthetic\n');
for (const d of ['home', 'tmp']) await mkdir(path.join(profile, d), { recursive: true });
await mkdir(path.join(profile, 'userData'), { recursive: true, mode: 0o700 });
await writeFile(path.join(profile, 'userData', 'omp-service.json'), JSON.stringify({ modelsYml: MODELS_YML, envReferences: [] }));

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, ...(detail ? { detail } : {}) }); console.error(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ' ' + JSON.stringify(detail ?? null)}`); };
const waitFor = async (fn, timeoutMs = 30000, label = 'condition') => { const end = Date.now() + timeoutMs; for (;;) { try { const v = await fn(); if (v) return v; } catch { } if (Date.now() > end) throw new Error('timeout: ' + label); await new Promise(r => setTimeout(r, 200)); } };
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// 数 app 子进程树内的 codex 二进制进程（/proc 父链限定本 Electron 实例，证据为实进程 cmdline）
async function codexProcesses(rootPid) {
  const children = new Map();
  for (const entry of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = (await readFile(`/proc/${entry}/stat`)).toString();
      const m = stat.match(/^\d+ \(.*\) (?:\S+ )?(\d+)/);
      if (m) { const ppid = Number(m[1]); if (!children.has(ppid)) children.set(ppid, []); children.get(ppid).push(Number(entry)); }
    } catch { /* 进程退出竞态 */ }
  }
  const tree = new Set([rootPid]);
  for (let queue = [rootPid]; queue.length;) {
    const next = [];
    for (const pid of queue) for (const c of (children.get(pid) ?? [])) if (!tree.has(c)) { tree.add(c); next.push(c); }
    queue = next;
  }
  const found = [];
  for (const pid of tree) {
    try {
      const cmdline = (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0').filter(Boolean);
      if (cmdline.some(a => /(^|\/)codex$/.test(a))) found.push({ pid: String(pid), argv: cmdline.join(' ').slice(0, 120) });
    } catch { /* 进程退出竞态 */ }
  }
  return found;
}

async function launchApp(pickList) {
  const port = await freePort();
  const child = spawn(electronPath, ['--ozone-platform=wayland', path.join(appRoot, 'src/main/main.cjs')], {
    cwd: path.dirname(appRoot),
    env: { ...process.env, HOME: path.join(profile, 'home'), TMPDIR: path.join(profile, 'tmp'), LANG: 'C.UTF-8',
      NOZELI_HIDDEN: '0', NOZELI_OZONE: 'wayland', NOZELI_TEST_INSTANCE: String(++launchApp.seq),
      NOZELI_USER_DATA: path.join(profile, 'userData'), NOZELI_DEBUG_PORT: String(port),
      NOZELI_TEST_PICK: pickList, NOZELI_SHOT_DIR: path.join(profile, 'shots'), NOZELI_OMP_BIN: OMP_BIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, 40000, 'devtools');
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 60000 });
  const page = (await browser.pages()).find(p => p.url().includes('127.0.0.1'));
  await waitFor(() => page.evaluate(() => window.__nozeliReady === true), 30000, 'ready');
  return { child, browser, page, port, readOutput: () => output };
}
launchApp.seq = 0;
async function stopApp(app) {
  const exited = new Promise(resolve => app.child.once('close', (code, signal) => resolve({ code, signal })));
  await app.page.evaluate(() => window.nozeli.invoke('session.requestClose')).catch(() => {});
  const result = await Promise.race([exited, new Promise(r => setTimeout(() => r({ code: 'HANG', output: app.readOutput().slice(-2000) }), 60000))]);
  await app.browser.disconnect().catch(() => {});
  return result;
}

async function enableOmp(page, pid) {
  await page.evaluate(() => document.querySelector('#pick-project')?.click());
  await page.click('#open-settings');
  await page.click('[data-settings-section="settings-general"]');
  await page.click('#provider-console-toggle');
  await new Promise(r => setTimeout(r, 800));
  await page.waitForFunction(async pid=>(await window.nozeli.invoke('managed.status',{projectId:pid})).value?.ready,{},pid);
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const ready = await page.evaluate(async (pid) => {
      if (document.querySelector('#settings-dialog')?.open) return false;
      try { const s = await window.nozeli.invoke('managed.status', { projectId: pid }); return s?.value?.ready === true; } catch { return false; }
    }, pid).catch(() => false);
    if (ready) return { ok: true };
  }
  const statusText = await page.evaluate(() => document.querySelector('#ai-status')?.textContent ?? '').catch(() => '');
  return { ok: false, reason: 'timeout waiting ready', statusText };
}

let app;
try {
  app = await launchApp(projectA);
  record('app ready (visible)', true);
  const pid = pidOf(projectA);
  // 订阅 managed-error 事件（绑定失败原因透传）
  await app.page.evaluate(() => { window.__managedErrors = []; window.nozeli.subscribe('agent', e => { if (e?.kind === 'managed-error') window.__managedErrors.push(e.text); }); });
  const enabled = await enableOmp(app.page, pid);
  if (!enabled.ok) {
    await new Promise(r => setTimeout(r, 1000));
    enabled.managedErrors = await app.page.evaluate(() => (window.__managedErrors ?? []).slice(0, 8)).catch(() => []);
  }
  record('project A OMP enabled (three roles)', enabled.ok, enabled);

  // 等 renderer 自动 attach 尝试走完（autoAttachAttempted 后失败显示原因）
  await new Promise(r => setTimeout(r, 6000));

  // 1) OMP TUI-native：terminal.attach 成功返回真实终端（会话同 threadId；唯一 PTY owner）
  const attach = await app.page.evaluate(async pid => {
    try { const r = await window.nozeli.invoke('managed.terminal.attach', { projectId: pid, target: 'frontdesk' }); return { ok: r?.ok, value: r?.value ?? null, error: r?.error?.message ?? null }; }
    catch (e) { return { thrown: e.message }; }
  }, pid);
  const attachValue = attach?.value ?? {};
  const status1 = await app.page.evaluate(async pid => (await window.nozeli.invoke('managed.status', { projectId: pid }))?.value, pid);
  const sessionThreadId = status1?.state?.residents?.frontdesk?.threadId ?? null;
  record('OMP TUI terminal.attach returns real view (same session threadId)',
    attach?.ok === true && Boolean(attachValue.terminalId) && (attachValue.threadId === sessionThreadId || !attachValue.threadId),
    { terminalId: attachValue.terminalId ?? null, threadId: attachValue.threadId ?? null, sessionThreadId, error: attach?.error ?? attach?.thrown ?? null });

  // 2) PTY 视图有真实 TUI 输出（replay/screen 非空——官方渲染）
  const screen = await app.page.evaluate(async pid => {
    const r = await window.nozeli.invoke('managed.terminal.screen', { projectId: pid, target: 'frontdesk' });
    return r?.ok ? r.value : { err: r?.error?.message };
  }, pid).catch(() => null);
  // 自动 attach 在会话启动窗口早期失败（autoAttachAttempted 不重试）——点产品"重新连接"按钮走真实用户路径
  await app.page.evaluate(() => document.querySelector('#managed-terminal-grid [data-terminal-recovery]')?.click()).catch(() => {});
  await new Promise(r => setTimeout(r, 5000));   // 重连 + replay 写入 xterm
  const card = await app.page.evaluate(() => {
    const out = document.querySelector('#managed-terminal-grid article[data-managed-terminal="frontdesk"] .provider-output');
    if (!out) return { state: null, textLen: 0 };
    const text = out.textContent ?? '';
    return { state: out.dataset.terminalState ?? null, textLen: text.trim().length, sample: text.trim().slice(0, 60) };
  }).catch(() => ({ state: null, textLen: 0 }));
  const reason = await app.page.evaluate(() => {
    const out = document.querySelector('#managed-terminal-grid article[data-managed-terminal="frontdesk"] .provider-output');
    const text = out?.textContent ?? '';
    const m = text.match(/\[原生终端不可用\][^\n]{0,160}/);
    return m ? m[0] : null;
  }).catch(() => null);
  record('TUI PTY view renders real TUI content in terminal card',
    card.state !== 'unavailable' && card.state !== 'exited' && card.textLen > 0, { ...card, reason });

  // 3) resize 生效（会话 PTY 唯一 owner）
  const resized = await app.page.evaluate(async ({ pid, terminalId }) => {
    const r = await window.nozeli.invoke('managed.terminal.resize', { projectId: pid, target: 'frontdesk', terminalId, cols: 100, rows: 30 });
    return r?.ok === true;
  }, { pid, terminalId: attachValue.terminalId }).catch(() => false);
  record('TUI terminal resize accepted', resized === true);

  // 4) 进程身份：providers 记录 kind omp-tui 且为 omp 进程（无 codex）
  const identities = await app.page.evaluate(async pid => {
    const s = (await window.nozeli.invoke('managed.status', { projectId: pid }))?.value;
    return Object.entries(s?.state?.providers ?? {}).map(([k, v]) => ({ role: k, kind: v.kind, pid: v.pid }));
  }, pid);
  record('provider records kind omp-tui', identities.filter(i => i.role !== 'worker').every(i => i.kind === 'omp-tui'), { identities: identities.slice(0, 4) });

  // 4) 真实进程观察：整个 app 子树下无 codex 进程（/proc cmdline 证据）
  const codex = await codexProcesses(app.child.pid);
  record('no codex process spawned anywhere', codex.length === 0, { codex });

  // 5) OMP RPC 会话仍健康（ready、居民身份、无 busy）
  const health = await app.page.evaluate(async pid => {
    const s = (await window.nozeli.invoke('managed.status', { projectId: pid }))?.value;
    return { ready: s?.ready, residents: Object.keys(s?.state?.residents ?? {}), threadId: s?.state?.residents?.frontdesk?.threadId ?? null, busy: s?.state?.busyTargets ?? [] };
  }, pid);
  record('OMP TUI sessions healthy', health.ready === true && Boolean(health.threadId) && (health.busy?.length ?? 0) === 0, health);

  // 6) 草稿路径不受影响：draft 写入/清除经 RPC 正常（无终端参与）
  const draft = await app.page.evaluate(async pid => {
    const r = await window.nozeli.invoke('managed.draft', { projectId: pid, target: 'frontdesk', text: 'p4 dispatch probe draft' });
    return { ok: r?.ok === true };
  }, pid);
  record('RPC draft path unaffected', draft.ok, draft);

  // 系统终端接管/接回（P4 输入所有权）：同一原子序内 接管→输入被拒→接回
  const sysResult = await app.page.evaluate(async ({ pid, terminalId }) => {
    const out = { takeover: null, inputRejected: false, inputErr: null, externalDuring: false, returned: false };
    try { const r = await window.nozeli.invoke('managed.terminal.system', { projectId: pid, target: 'frontdesk' }); out.takeover = r?.ok === true; } catch (e) { out.takeoverErr = String(e.message); return out; }
    try { const s = (await window.nozeli.invoke('managed.status', { projectId: pid }))?.value; out.externalDuring = s?.state?.externalTerminalTargets?.includes('frontdesk') ?? false; } catch {}
    const inputR = await window.nozeli.invoke('managed.terminal.input', { projectId: pid, target: 'frontdesk', terminalId, data: 'x' }).catch(e => ({ ok: false, error: { message: String(e.message ?? '') } }));
    if (inputR?.ok !== true) { out.inputErr = String(inputR?.error?.message ?? ''); out.inputRejected = /系统终端/.test(out.inputErr); }
    try { const r = await window.nozeli.invoke('managed.terminal.return', { projectId: pid, target: 'frontdesk' }); out.returned = r?.ok === true; } catch (e) { out.returnErr = String(e.message); }
    return out;
  }, { pid, terminalId: attachValue.terminalId }).catch(e => ({ evalError: String(e.message) }));
  record('system terminal takeover/return (external owns input while taken)',
    sysResult?.takeover === true && sysResult?.externalDuring === true && sysResult?.inputRejected === true && sysResult?.returned === true,
    { ...sysResult, appDbg: app.readOutput().split('\n').filter(l => l.includes('dbg-sys')).slice(-4) });

  // 截图（终端卡片拒绝原因 + Agent 状态）
  await app.page.evaluate(async () => { await window.nozeli.invoke('session.resize', { width: 1280, height: 800 }); await window.nozeli.invoke('session.capture', { name: 'p4td-dispatch' }); });
  record('dispatch-state screenshot captured', true);

  const exit = await stopApp(app);
  record('normal close exit 0', exit.code === 0, exit);
} catch (error) {
  record('dispatch flow', false, { message: String(error.message).slice(0, 400) });
  try { if (app) await stopApp(app); } catch {}
}
const pass = results.every(r => r.pass);
console.error(JSON.stringify({ finishedAt: new Date().toISOString(), platform: process.platform, ompBin: OMP_BIN, profile, pass, results }, null, 2));
process.exit(pass ? 0 : 1);
