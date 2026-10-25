import {openTestController,openTestWorkspace} from './project-storage.fixture.mjs';
// Real private bundled OMP + CollabHost, no model turns, no extension/transport fake.
// Barriers wrap only public session acquisition / terminal snapshot interfaces.
// Run from apps/desktop: node --test tests/omp-tui-attach-races.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { OmpTuiSession } from '../src/agents/managed/omp-tui-session.mjs';
import { Controller } from '../src/agents/managed/controller.mjs';
import { attachNativeTerminal } from '../src/agents/managed/native-terminal.mjs';
import { connectOmpTerminalBridge } from '../src/agents/managed/omp-terminal-bridge.mjs';
import { processStamp } from '../src/agents/managed/process-ownership.mjs';

const command = fileURLToPath(new URL('../runtime/omp/omp', import.meta.url));
const draft = '  原始 draft\n@Worker 不提交、不重放  ';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise, label, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}

async function openController(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'nozeli-attach-race-'));
  const sessions = [], owners = [], unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  let c;
  t.after(async () => {
    const failures = [];
    try {
      try { await c?.stop(); } catch (error) { failures.push(error); }
      for (const session of sessions) {
        try { await session.stop(); await session.controllerExitCleanup; } catch (error) { failures.push(error); }
      }
      // Only an exact recorded PID incarnation may be killed on failed teardown.
      for (const { pid, stamp } of owners) {
        if (stamp && await processStamp(pid) === stamp) {
          try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failures.push(error); }
          const session = sessions.find(s => s.pid === pid);
          if (session?.exitPromise) await bounded(session.exitPromise, 'owned process SIGKILL exit');
        }
        assert.notEqual(await processStamp(pid), stamp, 'owned native process exited');
      }
      assert.equal(unhandled.length, 0, 'no unhandled rejections');
      assert.equal(failures.length, 0, 'cleanup failures: ' + failures.map(String).join('; '));
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await rm(dir, { recursive: true, force: true });
    }
  });
  const agentDir = path.join(dir, 'seed');
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, 'config.yml'), 'startup:\n  checkUpdate: false\n  showSplash: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nsetupVersion: 2\nmodelRoles:\n  default: synthetic-omp/model\n');
  await writeFile(path.join(agentDir, 'models.yml'), 'providers:\n  synthetic-omp:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:9/\n    auth: none\n    models:\n      - id: model\n');
  c = await openTestController({
    runtimeRoot: path.join(dir, 'runtime'), contentRoot: path.join(dir, 'content'),
    ompCommand: command, ompSystemSource: { private: true, root: dir, agentDir },
    sessionFactory: spec => {
      const session = new OmpTuiSession({ ...spec, onSpawn: async pid => {
        const stamp = await processStamp(pid);
        assert.ok(stamp, 'spawn has a recordable process incarnation');
        owners.push({ pid, stamp });
        await spec.onSpawn?.(pid);
      } });
      sessions.push(session);
      return session;
    },
  });
  await c.setDraft('frontdesk', draft);
  return { c, sessions };
}

async function stopOwner(session) {
  const receipt = await session.stop();
  await session.controllerExitCleanup;
  assert.equal(receipt.confirmationComplete, true, 'native owner and descendants confirmed exited');
  assert.equal(await processStamp(session.pid), null, 'old PID gone before proceeding');
  assert.equal(session.promptsDelivered, 0, 'no model prompt delivered');
}

function assertIdentity(c, session) {
  assert.equal(c.sessions.get('frontdesk'), session, 'same session owner');
  assert.equal(c.store.state.residents.frontdesk.threadId, session.threadId, 'durable thread identity retained');
  assert.equal(c.store.state.drafts.frontdesk, draft, 'original draft bytes retained');
  assert.equal(c.store.state.jobs.length, 0, 'draft never submitted or replayed');
}

test('barrier1: stopped owner / stopped Controller reject attach without changing draft or identity', { timeout: 120000 }, async t => {
  const { c } = await openController(t);
  const session = await c.session('frontdesk');
  await stopOwner(session);
  await assert.rejects(session.prompt('after stop'), error => ['OMP_STOPPING', 'OMP_NOT_DISPATCHABLE'].includes(error.code));
  // Force acquisition of the stopped instance through the public session boundary.
  const realSession = c.session.bind(c);
  c.session = async () => session;
  try { await assert.rejects(attachNativeTerminal(c, 'frontdesk'), /停止|stopped/); }
  finally { c.session = realSession; }
  assert.equal(c.terminals.size, 0);
  assertIdentity(c, session);
  await c.stop();
  await assert.rejects(attachNativeTerminal(c, 'frontdesk'), /closing|停止/);
  assert.equal(c.terminals.size, 0);
  assert.equal(c.store.state.drafts.frontdesk, draft);
});

test('barrier2/4: overlapping snapshot/release and late old-view callbacks cannot steal a replacement lease', { timeout: 120000 }, async t => {
  const { c } = await openController(t);
  const session = await c.session('frontdesk');
  const entered = deferred(), release = deferred();
  const realAttachment = session.terminalAttachment.bind(session);
  session.terminalAttachment = (...args) => {
    const view = realAttachment(...args), snapshot = view.snapshot.bind(view);
    view.snapshot = async () => { entered.resolve(); await release.promise; return snapshot(); };
    return view;
  };
  const oldEvents = [];
  const old = await attachNativeTerminal(c, 'frontdesk', {
    onScreen: value => oldEvents.push(['screen', value]), onData: value => oldEvents.push(['data', value]), onExit: value => oldEvents.push(['exit', value]),
  });
  const pendingSnapshot = old.snapshot();
  t.after(() => release.resolve());
  await entered.promise;
  const [first, second] = await Promise.all([old.close(), old.close()]);
  assert.equal(first.viewDetached, true);
  assert.equal(second.viewDetached, true);
  assert.equal(c.terminals.size, 0);
  assert.equal(session.closed, false, 'view release does not stop the native owner');
  session.terminalAttachment = realAttachment;
  const current = await attachNativeTerminal(c, 'frontdesk');
  assert.notEqual(current.terminalId, old.terminalId);
  release.resolve();
  await pendingSnapshot;
  assert.deepEqual(oldEvents, [], 'in-flight stale snapshot must not publish after release');
  assert.throws(() => old.input('stale view'), /detached/);
  assert.throws(() => old.resize(80, 24), /detached/);
  await assert.rejects(old.snapshot(), /detached/);
  await old.close();
  assert.equal(c.terminals.get('frontdesk'), current, 'late close cannot delete replacement lease');
  assertIdentity(c, session);
  await current.close();
  await stopOwner(session);
  assert.deepEqual(oldEvents, [], 'old exit callback remains detached after native process exits');
});

test('barrier3: three bounded same-target stop/recreate cycles retain one live owner and reject old credentials/callbacks', { timeout: 240000 }, async t => {
  const { c, sessions } = await openController(t);
  for (let loop = 0; loop < 3; loop++) {
    const old = await c.session('frontdesk');
    const staleView = await attachNativeTerminal(c, 'frontdesk');
    const oldStamp = await processStamp(old.pid);
    await staleView.close();
    await stopOwner(old);
    const current = await c.session('frontdesk');
    assert.notEqual(current, old);
    assert.notEqual(current.viewOwnerId, old.viewOwnerId, 'new owner incarnation');
    assert.notEqual(await processStamp(current.pid), oldStamp, 'new native process incarnation');
    assert.equal(current.deployed.socketPath, old.deployed.socketPath, 'same-target bridge endpoint safely reused');
    if (current.zeroActivityRestarted) {
      assert.notEqual(current.threadId, old.threadId, 'explicit missing zero-activity thread recreation');
      assert.ok(c.store.state.recoveryEvents.some(event => event.type === 'omp-zero-activity-restarted' && event.previousThreadId === old.threadId));
    } else {
      assert.equal(current.threadId, old.threadId, 'existing pinned conversation is resumed');
    }
    const obsolete = connectOmpTerminalBridge({ socketPath: current.deployed.socketPath, token: old.deployed.token, requestTimeoutMs: 1000 });
    try { await assert.rejects(obsolete.hello(), error => ['AUTH', 'BRIDGE_CLOSED'].includes(error.code)); }
    finally { await obsolete.close(); }
    const view = await attachNativeTerminal(c, 'frontdesk');
    old.emit('native-draft', true);
    old.emit('exit', { code: 0 });
    await staleView.close();
    assert.throws(() => staleView.input('late input'), /detached/);
    assert.equal(c.terminals.get('frontdesk'), view, 'late old-owner callback does not steal terminal identity');
    assert.equal(c.nativeDraftTargets.has('frontdesk'), false, 'old owner cannot replace native draft state');
    assertIdentity(c, current);
    const live = [];
    for (const session of sessions) {
      if (await processStamp(session.pid) !== null) live.push(session);
    }
    assert.deepEqual(live, [current], 'exactly one live native owner in cycle ' + loop);
    await view.close();
    await stopOwner(current);
  }
  assert.equal(c.terminals.size, 0);
});

test('startup acquisition barrier: Controller.stop while attach awaits real session rejects without a live view', { timeout: 120000 }, async t => {
  const { c } = await openController(t);
  const entered = deferred(), release = deferred();
  const realSession = c.session.bind(c);
  let owner;
  c.session = async (...args) => {
    owner = await realSession(...args);
    entered.resolve();
    await release.promise;
    return owner;
  };
  t.after(() => release.resolve());
  // Install rejection consumption before entering the deterministic overlap window.
  const outcome = attachNativeTerminal(c, 'frontdesk').then(view => ({ view }), error => ({ error }));
  await Promise.race([entered.promise, outcome.then(result => { throw result.error ?? new Error('attach escaped acquisition barrier'); })]);
  try { await c.stop(); }
  finally { release.resolve(); c.session = realSession; }
  const result = await outcome;
  assert.ok(result.error, 'attach cannot return a live lease after Controller.stop');
  assert.match(result.error.message, /closing|停止|stopped/);
  assert.equal(c.terminals.size, 0);
  assert.equal(owner.closed, true);
  assert.equal(await processStamp(owner.pid), null);
  assert.equal(c.store.state.drafts.frontdesk, draft);
  assert.equal(c.store.state.residents.frontdesk.threadId, owner.threadId);
  assert.equal(owner.promptsDelivered, 0);
});
