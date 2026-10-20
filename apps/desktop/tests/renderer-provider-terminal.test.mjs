import {isTerminalProtocolInput} from '../src/domain/terminal-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import xterm from '@xterm/xterm';
const { Terminal: RealTerminal } = xterm;

// Exercise the production controller with xterm's real parser and buffer.
// Only browser layout/open and IPC delivery are controlled in these tests.
const source = await readFile(new URL('../src/renderer/provider-terminal.mjs', import.meta.url), 'utf8');
const makeController = new Function('Terminal', 'FitAddon', 'ResizeObserver', 'isTerminalProtocolInput',
  source.split('\n').filter(line => !line.startsWith('import ')).join('\n')
    .replace('export function', 'function') + ';return createProviderTerminal;');
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(check) {
  for (let i = 0; i < 500; i++) { if (check()) return; await tick(); }
  assert.fail('Timed out waiting for controlled terminal operation');
}
const response = (projectId) => ({ ok: true, value: { available: true, terminalId: projectId, seq: 1, replay: projectId + '_REPLAY' } });

function harness(t, { attach = async ({ projectId }) => response(projectId), hold = null, rejectInput = false } = {}) {
  let terminal; let key; let deliver = () => {}; let release = null;
  const calls = [], notices = []; const container = { dataset: {}, clientWidth: 640, clientHeight: 480 };
  class Terminal extends RealTerminal {
    constructor(options) { super({ ...options, allowProposedApi: true }); terminal = this; }
    open() {}
    onData(fn) { key = fn; return super.onData(fn); }
    write(text, callback) {
      super.write(text, () => { if (hold === text) release = () => callback?.(); else callback?.(); });
    }
  }
  class FitAddon { activate() {} fit() {} dispose() {} }
  class ResizeObserver { observe() {} disconnect() {} }
  const ui = makeController(Terminal, FitAddon, ResizeObserver, isTerminalProtocolInput)({
    container, toast:message=>notices.push(message),
    subscribe: (_name, callback) => { deliver = callback; return () => {}; },
    invoke: async (op, args) => { calls.push({ op, args }); return op === 'terminal.attach' ? attach(args) : op==='terminal.input'&&rejectInput?{ok:false,error:{code:'TERMINAL_STALE',message:'controlled stale input'}}:{ ok: true }; },
  });
  t.after(() => { release?.(); ui.dispose(); });
  return {
    ui, calls, container, notices,
    event: (event) => deliver(event),
    key: (text) => key(text),
    waitHeld: () => until(() => release !== null),
    release: () => release?.(),
    screen: () => Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) || '').filter(Boolean).join('\n'),
    flush: () => new Promise(resolve => terminal.write('', resolve)),
  };
}

test('real xterm replay resets existing content exactly once', async (t) => {
  const h = harness(t);
  await h.ui.attach({ projectId: 'A', role: 'qa' });
  await h.ui.attach({ projectId: 'A', role: 'qa' });
  assert.equal(h.screen(), 'A_REPLAY');
});

test('geometry-tagged replay preserves full-screen cursor coordinates before live resize output', async t => {
  const h=harness(t,{attach:async()=>({ok:true,value:{available:true,terminalId:'A',seq:2,replay:'unused',replayFrames:[
    {cols:120,rows:32,data:'\x1b[32;1HINPUT-AT-ORIGINAL-BOTTOM'},
    {cols:60,rows:20,data:'\x1b[20;1HINPUT-AFTER-RESIZE'},
  ]}})});
  await h.ui.attach({projectId:'A',role:'qa'});
  assert.match(h.screen(),/INPUT-AFTER-RESIZE/);
  h.event({type:'terminal.output',projectId:'A',role:'qa',terminalId:'A',seq:3,data:'\r\nLIVE-REDRAW'});
  await h.flush();
  await until(()=>h.screen().includes('LIVE-REDRAW'));
  assert.ok(!h.screen().includes('unused'));
});

test('project change during replay parsing cannot restore old input ownership', async (t) => {
  const h = harness(t, { hold: 'A_REPLAY' });
  const a = h.ui.attach({ projectId: 'A', role: 'qa' }); await h.waitHeld();
  const b = h.ui.attach({ projectId: 'B', role: 'qa' });
  h.key('while-switching');
  assert.equal(h.calls.filter(c => c.op === 'terminal.input').length, 0);
  // Give an incorrectly independent B parser queue time to complete before A.
  await new Promise(resolve => setTimeout(resolve, 25));
  h.release();
  assert.equal((await a).stale, true);
  assert.equal((await b).terminalId, 'B');
  h.key('after-switch');
  assert.deepEqual(h.calls.filter(c => c.op === 'terminal.input').map(c => c.args), [{ terminalId: 'B', data: 'after-switch' }]);
  assert.equal(h.screen(), 'B_REPLAY');
});

test('queued previous-project output cannot contaminate the new screen', async (t) => {
  const h = harness(t); await h.ui.attach({ projectId: 'A', role: 'qa' });
  h.event({ type: 'terminal.output', projectId: 'A', role: 'qa', terminalId: 'A', seq: 2, data: 'A_PRIVATE' });
  await h.ui.attach({ projectId: 'B', role: 'qa' }); await h.flush();
  assert.equal(h.screen(), 'B_REPLAY');
});

test('pending output and exit follow replay without duplicating replayed sequences', async (t) => {
  let resolve;
  const h = harness(t, { attach: () => new Promise(r => { resolve = r; }) });
  const attached = h.ui.attach({ projectId: 'P', role: 'qa' });
  for (const event of [
    { type: 'terminal.output', seq: 1, data: 'DUPLICATE' },
    { type: 'terminal.output', seq: 2, data: '_TAIL' },
    { type: 'terminal.exit', seq: 3, exitCode: 0 },
  ]) h.event({ projectId: 'P', role: 'qa', terminalId: 'P', ...event });
  resolve(response('P')); await attached;
  assert.equal(h.container.dataset.terminalState, 'exited');
  assert.match(h.screen(), /^P_REPLAY_TAIL/);
  assert.match(h.screen(), /终端已退出 0/);
  assert.doesNotMatch(h.screen(), /DUPLICATE/);
});

test('disposing during replay invalidates the attach and any later input', async (t) => {
  const h = harness(t, { hold: 'A_REPLAY' });
  const attached = h.ui.attach({ projectId: 'A', role: 'qa' }); await h.waitHeld();
  h.ui.dispose(); h.release();
  assert.equal((await attached).stale, true);assert.ok(h.calls.some(c=>c.op==='terminal.detach'&&c.args.terminalId==='A'));
  h.key('after-dispose');
  assert.equal(h.calls.filter(c => c.op === 'terminal.input').length, 0);
  assert.equal((await h.ui.attach({ projectId: 'B', role: 'qa' })).stale, true);
  assert.equal(h.calls.filter(c => c.op === 'terminal.attach').length, 1);
});

test('late IPC attach response cannot take over the current project', async (t) => {
  let resolveA;
  const h = harness(t, { attach: ({ projectId }) => projectId === 'A' ? new Promise(r => { resolveA = r; }) : response(projectId) });
  const a = h.ui.attach({ projectId: 'A', role: 'qa' });
  await h.ui.attach({ projectId: 'B', role: 'qa' });
  resolveA(response('A')); assert.equal((await a).stale, true);
  h.key('B-input');
  assert.equal(h.calls.find(c => c.op === 'terminal.input').args.terminalId, 'B');
  assert.equal(h.screen(), 'B_REPLAY');
});


test('hidden terminal drains output and answers protocol queries without respawning', async (t) => {
  const h = harness(t);
  await h.ui.attach({ projectId: 'A', role: 'qa' });
  h.ui.setVisible(false);
  assert.equal(h.container.hidden, true);
  assert.equal(h.container.inert, true);
  h.event({ type: 'terminal.output', projectId: 'A', role: 'qa', terminalId: 'A', seq: 2, data: '_BACKGROUND\x1b[6n' });
  await until(() => h.calls.some(c => c.op === 'terminal.ack' && c.args.seq === 2));
  h.ui.setVisible(true); h.key('visible');
  assert.equal(h.screen(), 'A_REPLAY_BACKGROUND');
  const sent = h.calls.filter(c => c.op === 'terminal.input').map(c => c.args.data);
  assert.ok(sent.some(data => /^\x1b\[\d+;\d+R$/.test(data)));
  assert.equal(sent.at(-1), 'visible');
  assert.equal(h.container.inert, false);
  assert.equal(h.calls.filter(c => c.op === 'terminal.attach').length, 1);
  await until(() => h.calls.filter(c => c.op === 'terminal.resize').length >= 2);
});

test('exited terminal rejects keyboard input', async (t) => {
  const h = harness(t); await h.ui.attach({ projectId: 'A', role: 'qa' });
  h.event({ type: 'terminal.exit', projectId: 'A', role: 'qa', terminalId: 'A', seq: 2, exitCode: 0 });
  await until(() => h.container.dataset.terminalState === 'exited');
  h.key('after-exit');
  assert.equal(h.calls.filter(c => c.op === 'terminal.input').length, 0);
});

test('disposing before attachment returns releases the late terminal lease',async t=>{
 let release;const h=harness(t,{attach:()=>new Promise(r=>release=r)});
 const pending=h.ui.attach({projectId:'late',role:'qa'});h.ui.dispose();release(response('late'));
 assert.equal((await pending).stale,true);assert.ok(h.calls.some(c=>c.op==='terminal.detach'&&c.args.terminalId==='late'));
});

test('stale input invalidates lease, blocks later keys and reconnects without replay',async t=>{
 const h=harness(t,{rejectInput:true});await h.ui.attach({projectId:'A',role:'qa'});
 h.key('unsent-on-stale');await until(()=>h.container.dataset.terminalState==='stale');
 assert.equal(h.notices[0],'controlled stale input');h.key('must-not-replay');
 assert.equal(h.calls.filter(c=>c.op==='terminal.input').length,1);
 await h.ui.attach({projectId:'B',role:'qa'});
 assert.equal(h.container.dataset.terminalState,'attached');
 assert.equal(h.calls.filter(c=>c.op==='terminal.input').length,1,'no rejected keystroke is replayed on new lease');
 h.event({type:'terminal.exit',projectId:'A',role:'qa',terminalId:'A',exitCode:9});
 await h.flush();assert.equal(h.container.dataset.terminalState,'attached');
});

test('connecting terminal answers cursor queries before attach completion but blocks user text',async t=>{
 let release;const h=harness(t,{attach:()=>new Promise(r=>release=r)});const pending=h.ui.attach({projectId:'A',role:'qa'});
 h.event({type:'terminal.output',projectId:'A',role:'qa',terminalId:'A',seq:1,data:'READY\x1b[6n'});
 await until(()=>h.calls.some(c=>c.op==='terminal.input'&&/^\x1b\[\d+;\d+R$/.test(c.args.data)));
 h.key('must not send');assert.ok(!h.calls.some(c=>c.op==='terminal.input'&&c.args.data==='must not send'));
 release(response('A'));assert.equal((await pending).available,true);assert.equal(h.screen(),'A_REPLAY');
});
