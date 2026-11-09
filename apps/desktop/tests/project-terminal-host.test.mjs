import test from 'node:test';import assert from 'node:assert/strict';
import {createLayout,reduceLayout} from '../src/domain/workspace-layout.mjs';
import {ProjectTerminalHost} from '../src/main/project-terminal.mjs';

// ---- fakes -----------------------------------------------------------------

let pidSequence = 0;
function fakePty() {
  const sessions = [];
  return { sessions, spawn(command, args, { cols, rows, cwd, env }) {
    const listeners = { data: [], exit: [] };
    const term = { pid: ++pidSequence, command, args, cols, rows, cwd, env, written: [], killed: false,
      onData: fn => { listeners.data.push(fn); return term; },
      onExit: fn => { listeners.exit.push(fn); return term; },
      write: data => { term.written.push(data); },
      resize: (c, r) => { term.cols = c; term.rows = r; },
      kill: () => { if (term.killed) return; term.killed = true; for (const fn of listeners.exit) fn({ exitCode: term.exitCode ?? 0 }); },
      emit: data => { for (const fn of listeners.data) fn(data); },
      exit: code => { term.exitCode = code; for (const fn of listeners.exit) fn({ exitCode: code }); },
    };
    sessions.push(term); return term;
  } };
}

// Fake verified-ownership adapter with the same shape the host consumes:
// stable /proc stamps, the pre-spawn uninspectable baseline snapshot, group
// signals, and the whole-table tagged reaper with optional test control over
// its verdict and timing.
function fakeOwnership() {
  const alive = new Set(), tagged = new Map(), control = { gate: null, fail: false, stampGate: null, stampNull: false };
  const selection = { state: 'available', platform: 'linux', capability: 'verified-process-ownership', implementation: {
    processStamp: async pid => { if (control.stampGate) { await control.stampGate.promise; } return control.stampNull ? null : (alive.has(pid) ? `boot:7:${pid}` : null); },
    signalProcess(pid) { alive.delete(pid); },
    signalProcessGroup(pid) { alive.delete(pid); },
    // Pre-spawn uninspectable snapshot, mirroring the real adapters (darwin
    // helper scan; the host /proc fallback is Linux-only): the fake table has
    // no uninspectable incarnations yet, so each spawn captures a fresh empty
    // Set — anything uninspectable appearing later stays an unknown to the
    // strict reaper.
    captureUninspectableBaseline: async () => new Set(),
    reapOwnerTaggedTree: async (record, identity, options) => { control.lastOptions = options ?? null;
      if (control.gate) { await control.gate.promise; }
      if (control.fail) throw Object.assign(new Error('owned project terminal descendants did not exit'), { code: 'TERMINAL_DESCENDANTS_ALIVE' });
      let reaped = 0;
      for (const pid of tagged.get(record.tag) ?? []) if (alive.has(pid)) { alive.delete(pid); reaped++; }
      return { verified: true, platform: 'linux', descendantsReaped: reaped };
    },
  } };
  return { alive, tagged, control, selection, put(pid, tag) { alive.add(pid); tagged.set(tag, new Set([...(tagged.get(tag) ?? []), pid])); } };
}

function makeTerminal({ platform = 'linux', uid = 1000,
  env = { HOME: '/home/me', PATH: '/usr/bin', NOZELI_TOKEN: 'secret-token', OMP_API_KEY: 'omp-secret', MY_SERVICE_TOKEN: 'user-token', SHELL: '/bin/false' },
  passwd = 'root:x:0:0:root:/root:/bin/false\nme:x:1000:1000:Me:/home/me:/usr/bin/zsh\n',
  root = '/data/projects/demo', loader } = {}) {
  const pty = fakePty(), ownership = fakeOwnership();
  const rawSpawn = pty.spawn.bind(pty);
  pty.spawn = (...args) => { const term = rawSpawn(...args); ownership.alive.add(term.pid); return term; }; // the host stamps the leader at spawn
  const layouts = new Map(), broadcasts = [], persisted = [], commands = [], surfaces = new Map(), focusCalls = [];
  let rootHold = null;
  let layout = createLayout('demo', { workspace: { minimized: true } });
  const workspace = {
    lifecycle: new Map(), layouts, surfaces,
    layout: async () => layout,
    command: async (_r, payload) => { commands.push(payload.command.type); layout = reduceLayout(layout, payload.command); layouts.set('demo', layout); return { layout, windowId: 'main' }; },
    persist: async value => { persisted.push(value); },
    serial: async (_id, work) => work(),
    changed: () => {},
    broadcast: (channel, payload) => { broadcasts.push({ channel, payload }); },
  };
  const harnessHost = { requireRegisteredProject: async () => { if (rootHold) await rootHold.promise; return { id: 'demo', root }; } };
  const terminalSurface = { dead: false, wc: { focus: () => focusCalls.push('terminal'), send: () => {} } };
  const terminal = new ProjectTerminalHost({ workspace, host: harnessHost, platform, uid, env,
    ...(loader ? {} : { ptyLoader: () => pty }),
    ownership: () => ownership.selection,
    readFile: async file => { if (file === '/etc/passwd') return passwd; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    access: async () => {},
    now: () => 1700000000000,
  });
  const attachView = () => Object.values(layout.views).find(view => view.kind === 'project-terminal')?.id ?? null;
  return { terminal, workspace, pty, ownership, broadcasts, persisted, commands, surfaces, focusCalls, layoutRef: () => layout, attachView,
    holdRoot() { rootHold = Promise.withResolvers(); return rootHold; },
    registerSurface() { surfaces.set(attachView(), terminalSurface); return terminalSurface; },
    shell: extra => ({ role: 'shell', projectId: 'demo', ...extra }),
    surface: (extra = {}) => ({ role: 'surface', projectId: 'demo', kind: 'project-terminal', viewId: attachView(), ...extra }) };
}

// ---- admission, shell and environment policy --------------------------------

test('cold surface attach without explicit intent never spawns a shell', async () => {
  const { terminal, workspace, surface, attachView, pty } = makeTerminal();
  // A cold-restored layout carries the view, but the in-memory explicit-start
  // intent died with the previous process: attach must stay honest.
  await workspace.command({}, { command: { type: 'open', view: { kind: 'project-terminal' } } });
  const viewId = attachView();
  const result = await terminal.attach(surface({ viewId }), { projectId: 'demo', viewId });
  assert.deepEqual(result, { instanceId: null, status: 'not-started', reason: 'EXPLICIT_START_REQUIRED' });
  assert.equal(pty.sessions.length, 0);
});

test('rail open records host-memory intent and broadcasts the reveal; attach spawns login shell at project root', async () => {
  const { terminal, shell, surface, attachView, pty, broadcasts } = makeTerminal();
  const opened = await terminal.open(shell(), { projectId: 'demo' });
  assert.equal(opened.viewId, attachView());
  assert.equal(opened.layout.views[opened.viewId].resourceId, 'project-terminal:demo');
  assert.ok(broadcasts.some(entry => entry.channel === 'nozeli:workspace-control' && entry.payload.type === 'project-terminal-open' && entry.payload.viewId === opened.viewId));
  const again = await terminal.open(shell(), { projectId: 'demo' }); // repeat click reveals, never duplicates
  assert.equal(again.viewId, opened.viewId);
  assert.equal(Object.values(again.layout.views).filter(view => view.kind === 'project-terminal').length, 1);
  const live = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView(), cols: 100, rows: 30 });
  assert.equal(live.status, 'running');
  assert.equal(live.shell.path, '/usr/bin/zsh');   // /etc/passwd policy for the current uid
  assert.equal(live.cwd, '/data/projects/demo');   // registered project root, not a renderer cwd
  assert.equal(live.pid, pty.sessions[0].pid);
  assert.equal(live.instanceId.length, 36);
  assert.ok(!('env' in live), 'renderer must never receive the shell environment');
  const spawned = pty.sessions[0];
  assert.equal(spawned.cwd, '/data/projects/demo');
  assert.equal(spawned.env.HOME, '/home/me');
  assert.equal(spawned.env.TERM, 'xterm-256color');
  assert.equal(spawned.env.TERM_PROGRAM, 'Nozeli');
  assert.equal(spawned.env.NOZELI_TOKEN, undefined);  // agent runtime secrets never injected
  assert.equal(spawned.env.OMP_API_KEY, undefined);
  assert.equal(spawned.env.MY_SERVICE_TOKEN, undefined);
  assert.equal(spawned.env.SHELL, '/bin/false');      // inherited user env stays untouched
  assert.match(spawned.env.NOZELI_PROJECT_TERMINAL_OWNER, /^[0-9a-f-]{36}$/, 'secret-free ownership tag rides the tree');
});

test('shell policy falls back through passwd, $SHELL and /bin/sh without assuming bash', async () => {
  const envShell = makeTerminal({ uid: 1234, env: { HOME: '/h', SHELL: '/usr/local/bin/fish' } });
  await envShell.terminal.open(envShell.shell(), { projectId: 'demo' });
  const fish = await envShell.terminal.attach(envShell.surface(), { projectId: 'demo', viewId: envShell.attachView() });
  assert.equal(fish.shell.path, '/usr/local/bin/fish');
  const unusable = makeTerminal({ uid: 1234, env: { HOME: '/h', SHELL: '/bin/false' }, passwd: 'root:x:0:0:root:/root:/bin/false\n' });
  await unusable.terminal.open(unusable.shell(), { projectId: 'demo' });
  const sh = await unusable.terminal.attach(unusable.surface(), { projectId: 'demo', viewId: unusable.attachView() });
  assert.equal(sh.shell.path, '/bin/sh');
});

test('only the exact project-terminal surface reaches runtime ops', async () => {
  const { terminal, shell, surface, attachView } = makeTerminal();
  await assert.rejects(terminal.attach(shell(), { projectId: 'demo', viewId: 'v' }), error => error.code === 'IPC_DENIED');
  await assert.rejects(terminal.attach(surface({ kind: 'web' }), { projectId: 'demo', viewId: 'v' }), error => error.code === 'IPC_DENIED');
  await assert.rejects(terminal.attach(surface(), { projectId: 'other', viewId: attachView() }), error => error.code === 'PROJECT_SCOPE_DENIED');
  await assert.rejects(terminal.attach(surface(), { projectId: 'demo', viewId: 'someone-elses-view' }), error => error.code === 'PROJECT_SCOPE_DENIED');
  await assert.rejects(terminal.open({ role: 'surface', projectId: 'demo', kind: 'project-terminal' }, { projectId: 'demo' }), error => error.code === 'IPC_DENIED');
});

test('unsupported platforms get an honest error, never a fake terminal', async () => {
  const { terminal, shell, surface, attachView, pty } = makeTerminal({ platform: 'win32' });
  await terminal.open(shell(), { projectId: 'demo' });
  await assert.rejects(terminal.attach(surface(), { projectId: 'demo', viewId: attachView() }), error => error.code === 'UNSUPPORTED_PLATFORM' && error.platform === 'windows');
  assert.equal(pty.sessions.length, 0);
});

test('the default ESM pty loader resolves node-pty instead of a bare require', async () => {
  // Without an injected loader the host must attempt a real module resolution;
  // any failure must be an honest PTY_UNAVAILABLE, never "require is not defined".
  const { terminal, shell, surface, attachView } = makeTerminal({ loader: 'default' });
  await terminal.open(shell(), { projectId: 'demo' });
  await assert.rejects(terminal.attach(surface(), { projectId: 'demo', viewId: attachView() }), error => {
    assert.equal(error.code, 'PTY_UNAVAILABLE');
    assert.ok(!/require is not defined/i.test(error.message), 'loader must not fall back to a bare require: ' + error.message);
    return true;
  });
});

test('rail open is refused while the project lifecycle is closing', async () => {
  const { terminal, shell } = makeTerminal();
  terminal.workspace.lifecycle.set('demo', { operationId: 'op' });
  await assert.rejects(terminal.open(shell(), { projectId: 'demo' }), error => error.code === 'PROJECT_LIFECYCLE_ACTIVE');
});

// ---- attach identity and spawn serialization --------------------------------

test('surface restart intent spawns; rebind keeps the same instance across reload and resize', async () => {
  const { terminal, shell, surface, attachView, pty } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const first = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  const rebound = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView(), cols: 120, rows: 40 });
  assert.equal(rebound.instanceId, first.instanceId);
  assert.equal(rebound.pid, first.pid);            // detach/dock/reload preserve the original shell
  assert.equal(pty.sessions.length, 1);            // no duplicate process on re-attach
  assert.equal(pty.sessions[0].cols, 120);
  assert.equal(rebound.cols, 120);
});

test('concurrent attaches serialize per project into exactly one spawn', async () => {
  const { terminal, shell, surface, attachView, pty } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const results = await Promise.all(Array.from({ length: 5 }, () => terminal.attach(surface(), { projectId: 'demo', viewId: attachView() })));
  assert.equal(pty.sessions.length, 1);
  assert.equal(new Set(results.map(result => result.instanceId)).size, 1);
  assert.equal(new Set(results.map(result => result.pid)).size, 1);
  for (const result of results) assert.equal(result.status, 'running');
});

test('a spawn without a verified process identity is refused and cleaned up', async () => {
  const { terminal, shell, surface, attachView, pty, ownership } = makeTerminal();
  ownership.control.stampNull = true; // no /proc identity can be proven
  await terminal.open(shell(), { projectId: 'demo' });
  await assert.rejects(terminal.attach(surface(), { projectId: 'demo', viewId: attachView() }), error => error.code === 'PTY_UNAVAILABLE');
  assert.equal(pty.sessions[0].killed, true, 'the unprovable shell must not survive');
  assert.equal(terminal.instances.size, 0);
  ownership.control.stampNull = false;
  assert.equal((await terminal.attach(surface(), { projectId: 'demo', viewId: attachView(), restart: true })).status, 'running', 'a later verified spawn still works');
});

test('a stop during an in-flight startup waits for it and reclaims the shell', async () => {
  const { terminal, shell, surface, attachView, pty, ownership } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  ownership.control.stampGate = Promise.withResolvers(); // startup identity check in flight
  const starting = terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  await new Promise(resolve => setTimeout(resolve, 30));
  const stopping = terminal.stopProject('demo', 'content-closed'); // explicit close races the start
  await new Promise(resolve => setTimeout(resolve, 30));
  ownership.control.stampGate.resolve();
  const attached = await starting;
  assert.equal(attached.status, 'running');          // the startup completed first…
  const stopped = await stopping;
  assert.equal(stopped.stopped, true);               // …then the same chain reclaimed it
  assert.equal(stopped.cleanup.cleanupComplete, true);
  assert.equal(pty.sessions[0].killed, true);
  assert.equal(terminal.instances.size, 0);
  assert.equal(terminal.pendingStart.size, 0, 'a stop also clears any queued start intent');
});

test('unverified cleanup retains ownership, blocks new shells and retries to completion', async () => {
  const { terminal, shell, surface, attachView, pty, ownership } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const live = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  const instance = terminal.instances.get('demo');
  const straggler = ++pidSequence; ownership.put(straggler, instance.tag);
  ownership.control.fail = true;                     // the verified reaper cannot clear the tree
  await assert.rejects(terminal.stop(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId }),
    error => error.code === 'TERMINAL_CLEANUP_INCOMPLETE' && error.cleanup.cleanupComplete === false);
  assert.equal(terminal.instances.size, 1, 'the failed-cleanup ownership record is retained');
  assert.equal(pty.sessions.length, 1, 'no replacement shell is spawned over an unproven tree');
  await assert.rejects(terminal.attach(surface(), { projectId: 'demo', viewId: attachView(), restart: true }),
    error => error.code === 'TERMINAL_CLEANUP_INCOMPLETE');
  ownership.control.fail = false;                    // retry now verifies the empty table
  const retried = await terminal.stopProject('demo', 'content-closed');
  assert.equal(retried.stopped, true);
  assert.equal(retried.cleanup.cleanupComplete, true);
  assert.equal(ownership.alive.has(straggler), false);
  assert.equal(terminal.instances.size, 0, 'the record is released only after verified cleanup');
  const fresh = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView(), restart: true });
  assert.equal(fresh.status, 'running');
  assert.equal(pty.sessions.length, 2);
});

// ---- output replay ----------------------------------------------------------

test('read replays bounded monotonic frames and reports honest truncation', async () => {
  const { terminal, shell, surface, attachView, pty } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const live = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  pty.sessions[0].emit('$ ');
  pty.sessions[0].emit('ready\r\n');
  const all = await terminal.read(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, afterSeq: 0 });
  assert.equal(all.status, 'running');
  assert.deepEqual(all.frames.map(frame => frame.data), ['$ ', 'ready\r\n']);
  assert.deepEqual(all.frames.map(frame => frame.seq), [1, 2]);
  assert.equal(all.nextSeq, 2);
  const next = await terminal.read(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, afterSeq: 2 });
  assert.deepEqual(next.frames, []);
  assert.equal(next.nextSeq, 2);
  pty.sessions[0].emit('more');
  const incremental = await terminal.read(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, afterSeq: 2 });
  assert.deepEqual(incremental.frames.map(frame => frame.data), ['more']);
  assert.equal(incremental.nextSeq, 3, 'nextSeq is the total emitted sequence');
  await assert.rejects(terminal.read(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, afterSeq: 99 }), error => error.code === 'INVALID_SEQ');
  for (let index = 0; index < 20100; index++) pty.sessions[0].emit('x'); // retention ring trims the head
  const truncated = await terminal.read(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, afterSeq: 0 });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.frames[0].seq, 104);       // only retained frames, never fabricated history
  assert.equal(truncated.frames.length, 128);       // frame-count ceiling still applies to truncated replays
  assert.equal(truncated.nextSeq, 20103, 'total sequence stays visible so the surface can drain to it');
});

test('read bounds each response even with huge frames', async () => {
  const { terminal, shell, surface, attachView, pty } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const live = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  const big = 'a'.repeat(64 * 1024);
  for (let index = 0; index < 8; index++) pty.sessions[0].emit(big);
  const page = await terminal.read(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, afterSeq: 0 });
  let bytes = 0; for (const frame of page.frames) bytes += Buffer.byteLength(frame.data);
  assert.equal(page.frames.length, 3);              // 192 KiB byte ceiling per response
  assert.equal(bytes, 192 * 1024);
  assert.equal(page.nextSeq, 8, 'paging never hides the total sequence');
  const rest = await terminal.read(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, afterSeq: page.frames.at(-1).seq });
  assert.deepEqual(rest.frames.map(frame => frame.seq), [4, 5, 6]);
  const tail = await terminal.read(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, afterSeq: rest.frames.at(-1).seq });
  assert.deepEqual(tail.frames.map(frame => frame.seq), [7, 8]);
  assert.equal(tail.nextSeq, 8);
});

// ---- input ------------------------------------------------------------------

test('write delivers bounded text to the real pty and refuses after exit', async () => {
  const { terminal, shell, surface, attachView, pty } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const live = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  const receipt = await terminal.write(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, data: 'ls\r' });
  assert.equal(receipt.written, true);
  assert.deepEqual(pty.sessions[0].written, ['ls\r']);
  await assert.rejects(terminal.write(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, data: 'x'.repeat(17 * 1024) }), error => error.code === 'INVALID_PAYLOAD');
  pty.sessions[0].exit(0);
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(terminal.write(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, data: 'ls\r' }), error => error.code === 'TERMINAL_EXITED' && error.exitCode === 0);
});

test('stale instance binding is rejected instead of feeding a replacement view', async () => {
  const { terminal, shell, surface, attachView, pty } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const live = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  await terminal.stop(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId });
  await assert.rejects(terminal.write(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, data: 'ls\r' }), error => error.code === 'TERMINAL_INSTANCE_STALE' && error.currentInstanceId === null);
  const fresh = await terminal.read(surface(), { projectId: 'demo', viewId: attachView(), instanceId: 'missing', afterSeq: 0 });
  assert.equal(fresh.instanceId, null);
  assert.equal(pty.sessions.length, 1);
});

// ---- exit, verified cleanup, restart ---------------------------------------

test('natural shell exit reaps the verified tagged tree and reports the receipt', async () => {
  const { terminal, shell, surface, attachView, pty, ownership } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const live = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  const instance = terminal.instances.get('demo');
  const sameGroupChild = ++pidSequence; ownership.put(sameGroupChild, instance.tag);       // job-control group member
  const setsidChild = ++pidSequence; ownership.put(setsidChild, instance.tag);             // escaped its own session
  pty.sessions[0].exit(3);
  let read;
  for (let index = 0; index < 50; index++) {
    read = await terminal.read(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId, afterSeq: 0 });
    if (read.status === 'exited' && read.cleanup) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(read.status, 'exited');
  assert.equal(read.exitCode, 3);
  assert.equal(read.cleanup.descendantsConfirmed, true);
  assert.equal(read.cleanup.cleanupComplete, true);
  assert.equal(ownership.alive.has(sameGroupChild), false);
  assert.equal(ownership.alive.has(setsidChild), false, 'setsid descendants are reaped through the ownership tag, not the group');
  const exited = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  assert.equal(exited.status, 'exited');
  assert.equal(exited.instanceId, live.instanceId);
  const restarted = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView(), restart: true });
  assert.equal(restarted.status, 'running');
  assert.notEqual(restarted.instanceId, live.instanceId);
  assert.equal(pty.sessions.length, 2);
});

test('restart waits for the prior verified cleanup and refuses on an unproven tree', async () => {
  const { terminal, shell, surface, attachView, pty, ownership } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const live = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  const instance = terminal.instances.get('demo');
  const straggler = ++pidSequence; ownership.put(straggler, instance.tag);
  ownership.control.gate = Promise.withResolvers(); // natural-exit reap is still in flight
  pty.sessions[0].exit(0);
  const restart = terminal.attach(surface(), { projectId: 'demo', viewId: attachView(), restart: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pty.sessions.length, 1, 'no new shell while the owned tree is unproven');
  ownership.control.gate.resolve();
  const result = await restart;
  assert.equal(result.status, 'running');
  assert.notEqual(result.instanceId, live.instanceId);
  assert.equal(pty.sessions.length, 2);
  assert.equal(ownership.alive.has(straggler), false);
  // An unverified leftover blocks the next restart honestly.
  const second = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  const secondInstance = terminal.instances.get('demo');
  const stubborn = ++pidSequence; ownership.put(stubborn, secondInstance.tag);
  ownership.control.gate = Promise.withResolvers();
  pty.sessions[1].exit(0);
  const blocked = terminal.attach(surface(), { projectId: 'demo', viewId: attachView(), restart: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  ownership.control.fail = true;                    // the verified reaper cannot clear the tree
  ownership.control.gate.resolve();
  await assert.rejects(blocked, error => error.code === 'TERMINAL_CLEANUP_INCOMPLETE' && error.cleanup.cleanupComplete === false);
  assert.equal(pty.sessions.length, 2);
});

test('surface stop kills the owned tree and returns a verified receipt', async () => {
  const { terminal, shell, surface, attachView, pty, ownership } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const live = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  const instance = terminal.instances.get('demo');
  const child = ++pidSequence; ownership.put(child, instance.tag);
  const stopped = await terminal.stop(surface(), { projectId: 'demo', viewId: attachView(), instanceId: live.instanceId });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.cleanup.exited, true);
  assert.equal(stopped.cleanup.descendantsConfirmed, true);
  assert.equal(stopped.cleanup.cleanupComplete, true);
  assert.equal(pty.sessions[0].killed, true);
  assert.equal(ownership.alive.has(child), false);
});

// ---- layout-driven lifetime -------------------------------------------------

test('backgrounding keeps the shell while content close reclaims it', async () => {
  const { terminal, shell, surface, pty, layoutRef, attachView } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  const viewId = attachView();
  let layout = layoutRef();
  layout = reduceLayout(layout, { type: 'open', view: { kind: 'document', relPath: 'notes.md' } }); // backgrounded into pane history
  terminal.layoutChanged(layout);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pty.sessions[0].killed, false);
  layout = reduceLayout(layout, { type: 'detach', viewId, windowId: 'float-1' }); // detached pane keeps the shell
  terminal.layoutChanged(layout);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pty.sessions[0].killed, false);
  layout = reduceLayout(layout, { type: 'closeContent', viewId }); // explicit close orphans the view
  terminal.layoutChanged(layout);
  let killed = false;
  for (let index = 0; index < 80 && !killed; index++) { await new Promise(resolve => setTimeout(resolve, 20)); killed = pty.sessions[0].killed; }
  assert.equal(killed, true);
  assert.equal(terminal.instances.size, 0);
});

test('stopProject and stopAll reclaim every owned shell for project/app close', async () => {
  const first = makeTerminal(), second = makeTerminal();
  for (const harness of [first, second]) {
    await harness.terminal.open(harness.shell(), { projectId: 'demo' });
    await harness.terminal.attach(harness.surface(), { projectId: 'demo', viewId: harness.attachView() });
  }
  const closed = await first.terminal.stopProject('demo', 'project-close');
  assert.equal(closed.stopped, true);
  assert.equal(closed.cleanup.cleanupComplete, true);
  assert.equal(first.pty.sessions[0].killed, true);
  const idle = await first.terminal.stopProject('demo', 'project-close');
  assert.equal(idle.stopped, false);
  const all = await second.terminal.stopAll();
  assert.equal(all.stopped, true);
  assert.equal(second.pty.sessions[0].killed, true);
});

// ---- resize -----------------------------------------------------------------

test('resize is bounded and persists host-owned size viewState only', async () => {
  const { terminal, shell, surface, attachView, pty, persisted } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const live = await terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  const viewId = attachView();
  const resized = await terminal.resize(surface(), { projectId: 'demo', viewId, instanceId: live.instanceId, cols: 132, rows: 43 });
  assert.deepEqual(resized, { resized: true, cols: 132, rows: 43 });
  assert.equal(pty.sessions[0].cols, 132);
  await new Promise(resolve => setTimeout(resolve, 20));
  const saved = persisted.at(-1);
  assert.deepEqual(saved.views[viewId].viewState, { cols: 132, rows: 43 });
  await assert.rejects(terminal.resize(surface(), { projectId: 'demo', viewId, instanceId: live.instanceId, cols: 1, rows: 43 }), error => error.code === 'INVALID_SIZE');
  await assert.rejects(terminal.resize(surface(), { projectId: 'demo', viewId, instanceId: live.instanceId, cols: 132, rows: 999 }), error => error.code === 'INVALID_SIZE');
});

test('repeat rail entries reveal the existing terminal without new panes and hand it focus', async () => {
  const { terminal, shell, surface, attachView, pty, layoutRef, commands, focusCalls, registerSurface, ownership } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const viewId = attachView();
  await terminal.attach(surface(), { projectId: 'demo', viewId });
  registerSurface();
  // Another content backgrounds the terminal; a repeat rail entry must only
  // reveal it — never register, split or add a pane.
  let layout = layoutRef();
  layout = reduceLayout(layout, { type: 'open', view: { kind: 'document', relPath: 'notes.md' } });
  const panesBefore = countPanes(layout);
  const revealed = await terminal.open(shell(), { projectId: 'demo' });
  assert.equal(revealed.viewId, viewId);
  assert.equal(countPanes(revealed.layout), panesBefore, 'no pane is created by a repeat entry');
  assert.equal(revealed.layout.mainRoot.activeViewId, viewId, 'the terminal becomes the presented content');
  assert.equal(commands.at(-1), 'activate');
  assert.ok(commands.includes('open') && !commands.slice(1).includes('open'), 'the view is registered exactly once');
  assert.deepEqual(focusCalls, ['terminal'], 'the reveal focuses the terminal surface so Enter/Ctrl-C reach the shell');
  const instance = terminal.instances.get('demo');
  assert.ok(instance.baseline instanceof Set, 'pre-spawn uninspectable baseline is captured');
  ownership.control.lastOptions = null;
  pty.sessions[0].exit(0);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(ownership.control.lastOptions?.strict, true, 'terminal reaping runs the adapter in strict mode');
  assert.equal(ownership.control.lastOptions?.baseline, instance.baseline, 'the captured baseline travels with every reap');
});
function countPanes(layout) {
  let count = 0;
  const walk = node => { if (node.kind === 'group') count++; else if (node.kind === 'split') { walk(node.first); walk(node.second); } };
  walk(layout.mainRoot);
  for (const window of layout.detached) walk(window.root);
  return count;
}

test('stopAll also shuts down a startup still awaiting its project root', async () => {
  const { terminal, shell, surface, attachView, pty, holdRoot } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  const hold = holdRoot(); // attach runs, but the spawn is stuck before any instance exists
  const attaching = terminal.attach(surface(), { projectId: 'demo', viewId: attachView() });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(terminal.instances.size, 0, 'no instance exists yet');
  assert.ok(terminal.spawnGates.has('demo'), 'the spawn gate is held');
  const stopping = terminal.stopAll();
  hold.resolve();
  const attached = await attaching;
  assert.equal(attached.status, 'running');       // the startup finished inside the chain…
  assert.deepEqual(await stopping, { stopped: true }); // …and shutdown reclaimed it in order
  assert.equal(pty.sessions[0].killed, true);
  assert.equal(terminal.instances.size, 0);
  assert.equal(terminal.spawnGates.size, 0);
  assert.equal(terminal.pendingStart.size, 0);
});

test('closing the terminal content before any attach cancels the start intent', async () => {
  const { terminal, shell, surface, attachView, layoutRef } = makeTerminal();
  await terminal.open(shell(), { projectId: 'demo' });
  assert.equal(terminal.pendingStart.size, 1);
  const layout = reduceLayout(layoutRef(), { type: 'closeContent', viewId: attachView() });
  terminal.layoutChanged(layout);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(terminal.pendingStart.size, 0, 'content close cancels a not-yet-started terminal');
  const viewId = attachView();
  const result = await terminal.attach(surface({ viewId }), { projectId: 'demo', viewId });
  assert.equal(result.status, 'not-started');
});

test('strict ownership reaps non-dumpable session jobs and fails closed on post-spawn unknowns', { skip: process.platform !== 'linux' }, async t => {
  const { spawn } = await import('node:child_process');
  const { reapOwnerTaggedTree, processStamp } = await import('../src/platform/linux/process-ownership.mjs');
  const probe = await new Promise(resolve => { const child = spawn('python3', ['-c', 'import ctypes;ctypes.CDLL(None).prctl(4,0)']); child.on('error', () => resolve(false)); child.on('exit', code => resolve(code === 0)); });
  if (!probe) return t.skip('python3 prctl unavailable');
  const identity = { member: (env, record) => env.includes(`STRICT_TAG=${record.tag}`), leader: () => true, messages: { groupReused: 'group reused', leaderReused: 'leader reused', memberUnverified: 'member unverified', leaderUnverified: 'leader unverified', leaderDidNotExit: 'leader did not exit', descendantsDidNotExit: 'descendants did not exit' } };
  const captureBaseline = async () => {
    const { readdir, readFile, stat } = await import('node:fs/promises');
    const uid = process.getuid(), baseline = new Set();
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      try {
        const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), parts = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        if (parts[0] === 'Z' || (await stat(`/proc/${pid}`)).uid !== uid) continue;
        try { await readFile(`/proc/${pid}/environ`); } catch { baseline.add(`${pid}:${parts[19]}`); }
      } catch { /* transient */ }
    }
    return baseline;
  };
  const exited = child => new Promise(resolve => child.on('exit', () => resolve()));
  // 1) a non-dumpable job inside the leader's session is provable without /proc/environ
  const baseline1 = await captureBaseline();
  const job = spawn('python3', ['-c', 'import ctypes,time;ctypes.CDLL(None).prctl(4,0);time.sleep(30)'], { detached: true, stdio: 'ignore' });
  const jobExit = exited(job);
  const stamp = await processStamp(job.pid);
  assert.ok(stamp, 'leader identity captured');
  const receipt = await reapOwnerTaggedTree({ pid: job.pid, stamp, tag: 'session-job' }, identity, { strict: true, baseline: baseline1 });
  assert.equal(receipt.verified, true, 'session provenance certifies the non-dumpable job');
  await Promise.race([jobExit, new Promise(resolve => setTimeout(resolve, 3000))]);
  assert.equal(job.exitCode !== null || job.signalCode !== null, true, 'the non-dumpable session job was terminated');
  // 2) an uninspectable process that appeared after the baseline is never killed nor certified
  const baseline2 = await captureBaseline();
  const leader = spawn('python3', ['-c', 'import ctypes,time;ctypes.CDLL(None).prctl(4,0);time.sleep(0.3)'], { detached: true, stdio: 'ignore' });
  const unknown = spawn('python3', ['-c', 'import ctypes,time;ctypes.CDLL(None).prctl(4,0);time.sleep(30)'], { detached: true, stdio: 'ignore' });
  const leaderStamp = await processStamp(leader.pid);
  await exited(leader); // the tagged leader dies naturally; only the unknown remains
  await assert.rejects(reapOwnerTaggedTree({ pid: leader.pid, stamp: leaderStamp, tag: 'gone' }, identity, { strict: true, baseline: baseline2 }),
    error => error.message.includes('member unverified'), 'post-spawn uninspectable process fails closed');
  assert.equal(unknown.exitCode === null && unknown.signalCode === null, true, 'the unknown process was never signalled');
  unknown.kill('SIGKILL');
  await exited(unknown);
});
