// Project-terminal-only native ownership. This does not enable the global
// verified-process-ownership capability or authorize adoption of existing PIDs.
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const fail = (code, message) => Object.assign(new Error(message), { code });
export function loadProjectConpty() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw fail('CONPTY_UNAVAILABLE', 'Native Windows x64 ConPTY required');
  const native = require('../../../native/windows-process/build/Release/nozeli_windows_process.node');
  if (typeof native.createProjectConpty !== 'function' || typeof native.projectTerminalShell !== 'function') throw fail('CONPTY_BUILD_REQUIRED', 'The Windows terminal native component must be rebuilt before project terminals can start');
  return native;
}
export function projectTerminalShell() {
  const path = loadProjectConpty().projectTerminalShell();
  return { path, name: 'cmd.exe', args: ['/d', '/q'] }; // /d disables ambient AutoRun commands.
}
export function createProjectTerminal({ shell, cwd, env, cols, rows, native = loadProjectConpty() }) {
  const lease = native.createProjectConpty(shell.path, shell.args ?? [], cwd, Object.entries(env).map(([key, value]) => `${key}=${value}`), cols, rows);
  const facts = lease.snapshot();
  const dataListeners = [], exitListeners = [], decoder = new StringDecoder('utf8');
  let timer, started = false, exited = false, closed = false, failure = null, queuedBytes = 0, pending = null, eof = false, cleanupPromise = null;
  const queue = [];
  const emit = bytes => { const text = decoder.write(bytes); if (text) for (const fn of dataListeners) fn(text); };
  function pump() {
    if (closed) return;
    try {
      for (let count = 0; count < 4; count++) {
        const result = lease.readOutput();
        if (result.state === 'data') emit(result.bytes);
        else { if (result.state === 'eof' && !eof) { eof = true; const text = decoder.end(); if (text) for (const fn of dataListeners) fn(text); } break; }
      }
      if (pending) {
        const result = lease.pollInput();
        if (result.state === 'done') {
          if (result.bytes !== pending.length) throw fail('CONPTY_WRITE_UNKNOWN', 'Native console input completion was partial; input is not replayed');
          queuedBytes -= pending.length; pending = null;
        }
      }
      if (!pending && queue.length) {
        const bytes = queue.shift(); const result = lease.writeInput(bytes);
        if (result.state === 'pending') pending = bytes;
        else { if (result.bytes !== bytes.length) throw fail('CONPTY_WRITE_UNKNOWN', 'Native console input was partial; input is not replayed'); queuedBytes -= bytes.length; }
      }
      const state = lease.snapshot();
      if (state.leaderState === 'exited' && !exited) {
        exited = true;
        // A leader-first exit still owns its Job descendants. The host's exit
        // callback initiates cleanup; it never equates leader exit with Job exit.
        for (const fn of exitListeners) fn({ exitCode: state.leaderExitCode });
      }
    } catch (error) {
      failure = error;
      if (!exited) { exited = true; for (const fn of exitListeners) fn({ exitCode: null }); }
    }
  }
  const term = {
    pid: facts.pid, stamp: facts.stamp,
    onData(fn) { dataListeners.push(fn); return term; },
    onExit(fn) { exitListeners.push(fn); return term; },
    start() {
      if (started) throw fail('CONPTY_RESUME_REFUSED', 'Console already started');
      started = true;
      // Both output and exit handlers are attached before any shell code runs.
      lease.resume(); timer = setInterval(pump, 10); pump();
    },
    write(text) {
      if (failure) throw failure;
      if (closed || exited) throw fail('TERMINAL_EXITED', 'Console shell exited');
      const bytes = Buffer.from(text, 'utf8');
      if (!bytes.length || bytes.length > 16384 || queuedBytes + bytes.length > 65536) throw fail('CONPTY_INPUT_BUSY', 'Console input queue is full or frame exceeds limit');
      queuedBytes += bytes.length; queue.push(bytes);
    },
    resize(c, r) { if (failure) throw failure; lease.resize(c, r); },
    kill() { if (!closed) { queue.length = 0; pending = null; queuedBytes = 0; lease.terminate(); } },
    cleanup({ timeoutMs = 5000 } = {}) {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = Promise.resolve().then(async () => {
      if (closed) return { exited: true, descendantsConfirmed: true, cleanupComplete: true };
      term.kill();
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        // Continue draining while ClosePseudoConsole flushes on its native
        // close thread. Never block the JS reader waiting on that thread.
        pump();
        const state = lease.snapshot();
        if (state.jobEmptyObserved && eof) {
          try { lease.close(); closed = true; clearInterval(timer); return { exited: true, descendantsConfirmed: true, cleanupComplete: true }; }
          catch (error) { if (error.code !== 'CONPTY_DRAIN_PENDING') throw error; }
        }
        if (performance.now() >= deadline) {
          throw Object.assign(fail('CONPTY_CLEANUP_UNKNOWN', 'Console Job exit/output drain unconfirmed; retain original lease'), { cause: failure, facts: state });
        }
        await delay(10);
      }
      }).catch(error => { cleanupPromise = null; throw error; });
      return cleanupPromise;
    },
  };
  return term;
}
