// Shared settings-side Pi worker: one private Node process, no session, serving
// only the supplementary provider catalog / credential / OAuth methods.
// Transport follows integrations/pi: stdin {"id","method","params"} JSONL;
// stdout {"id","result"} | {"id","error"} responses plus bare events
// {"event":"entry"|"native"|"tool"|"interaction"}; reverse auth interactions
// use "w-" ids answered via the respond method. stderr is diagnostics only.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const LINE_LIMIT = 16 * 1024 * 1024;
const unavailable = message => Object.assign(new Error(message), { code: 'PI_RUNTIME_UNAVAILABLE' });

async function terminate(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  await new Promise(resolve => {
    const done = () => { clearTimeout(term); clearTimeout(kill); resolve(); };
    child.once('exit', done);
    const term = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    const kill = setTimeout(done, 6000);
    try { child.kill('SIGTERM'); } catch { done(); }
  });
}

export class PiSettingsWorker {
  constructor({ runtime, source, spawnFn = spawn, idleMs = 30000 } = {}) {
    if (!runtime || !source) throw new Error('PiSettingsWorker requires the bundled Pi runtime and private source');
    if (!Number.isFinite(idleMs) || idleMs < 0) throw new TypeError('PiSettingsWorker idleMs must be a non-negative number');
    Object.assign(this, { runtime, source, spawnFn, idleMs });
    this.events = new EventEmitter();
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.stopped = false;
    this.retiring = null;
    this.idleTimer = null;
    this.stderr = '';
  }

  get running() { return !!this.child && this.child.exitCode == null && this.child.signalCode == null; }

  async acquire() {
    if (this.stopped) throw unavailable('Nozeli 私有 Pi 运行环境已停止。');
    // An idle retire in flight owns the current child; wait for the handoff so
    // the request below never races the dying child, then respawn on demand.
    if (this.retiring) await this.retiring.catch(() => {});
    if (this.stopped) throw unavailable('Nozeli 私有 Pi 运行环境已停止。');
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async start() {
    if (this.stopped) throw unavailable('Nozeli 私有 Pi 运行环境已停止。');
    const child = this.spawnFn(this.runtime.command, this.runtime.args, { cwd: this.source.root, env: this.runtime.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.stderr = '';
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > LINE_LIMIT) {
        buffer = '';
        this.failPending(unavailable('Pi 设置进程输出超出限制。'));
        child.kill();
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) this.dispatch(line, child);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-65536); });
    child.on('error', error => {
      this.failPending(unavailable('Nozeli 私有 Pi 运行环境启动失败：' + (error.code ?? 'spawn')), child);
      if (this.child === child) { this.child = null; this.clearIdleTimer(); }
    });
    child.once('exit', () => {
      this.failPending(unavailable('Nozeli 私有 Pi 运行环境意外退出。'), child);
      if (this.child === child) { this.child = null; this.clearIdleTimer(); }
    });
    await new Promise((resolve, reject) => {
      if (child.exitCode != null || child.signalCode != null) { reject(unavailable('Nozeli 私有 Pi 运行环境未能启动。')); return; }
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    if (this.stopped) await terminate(child);
    this.armIdle();
    return {};
  }

  dispatch(line, child) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (typeof message.id === 'string' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending || (child && pending.child && pending.child !== child)) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      this.armIdle();
      if (pending.timedOut) return; // late answer only clears the unconfirmed marker; the caller already saw PI_TIMEOUT
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Nozeli 私有 Pi 运行环境操作失败。'), { code: message.error.code || 'PI_WORKER_ERROR' }));
      else pending.resolve(message.result);
      return;
    }
    if (child && this.child !== child) return; // stale events from a retired or replaced child
    if (message.event === 'interaction' && message.interaction) { this.events.emit('interaction', message.interaction); return; }
    if (message.event === 'native') {
      const data = message.eventData;
      if (data?.type === 'authStatus') this.events.emit('authStatus', data);
      else if (data?.type === 'stopped') this.events.emit('stopped', data);
      return; // log and session natives are diagnostics on the settings worker
    }
    if (message.event === 'tool') {
      // The settings worker exposes no tools; refuse deterministically.
      void this.call('respond', { id: message.id, answer: { content: [{ type: 'text', text: 'Nozeli settings worker exposes no tools.' }], isError: true } }, 10000).catch(() => {});
    }
  }

  send(message) {
    if (!this.running) throw unavailable('Nozeli 私有 Pi 运行环境不可用。');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  call(method, params, timeoutMs) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Keep the entry as an unconfirmed in-flight marker: the child may
        // still be executing the operation (credential write, auth flow) with
        // unknown effect. Only its late answer, an explicit cancel/stop or the
        // child's exit clears the marker; the caller keeps the single
        // PI_TIMEOUT rejection and nothing is ever replayed.
        const pending = this.pending.get(id);
        if (pending) { pending.timedOut = true; pending.resolve = null; pending.reject = null; }
        this.armIdle();
        reject(Object.assign(new Error('Nozeli 私有 Pi 运行环境响应超时：' + method), { code: 'PI_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, child: this.child });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); this.armIdle(); reject(error); }
    });
  }

  async request(method, params = {}, { timeoutMs = 20000 } = {}) {
    if(method==='cancel'){
      const child=this.child;
      this.failPending(Object.assign(new Error('Pi authentication cancelled'),{code:'PI_AUTH_CANCELLED'}));
      await terminate(child);
      if(this.child===child)this.child=null;
      return {stopped:true};
    }
    await this.acquire();
    return this.call(method, params, timeoutMs);
  }

  // Reverse auth interaction answers: answer is {text} (select option id or
  // typed value); error surfaces as {error:{message}} to the worker.
  respond(interactionId, answer) { return this.request('respond', { id: interactionId, answer }, { timeoutMs: 20000 }); }
  respondError(interactionId, messageText) { return this.request('respond', { id: interactionId, error: { message: messageText } }, { timeoutMs: 20000 }); }

  failPending(error, child) {
    // Child-scoped: a retired or replaced child only fails its own calls,
    // including unconfirmed in-flight markers. Without a child argument every
    // pending entry fails (stop, cancel, output limit).
    for (const [id, pending] of this.pending) {
      if (child && pending.child && pending.child !== child) continue;
      clearTimeout(pending.timer);
      pending.reject?.(error);
      this.pending.delete(id);
    }
  }

  async stop() {
    if (this.stopped) return { exited: true };
    this.stopped = true;
    this.clearIdleTimer();
    // An idle retire already owns the child: let it finish the stop/terminate
    // handoff instead of writing a second stop request and waiting again.
    if (this.retiring) await this.retiring.catch(() => {});
    const child = this.child;
    if (this.running) {
      try { await this.call('stop', { timeoutMs: 5000 }, 6000); } catch { /* forced termination below */ }
    }
    this.failPending(unavailable('Nozeli 私有 Pi 运行环境已停止。'));
    await terminate(child);
    this.child = null;
    this.clearIdleTimer();
    return { exited: true };
  }

  // Idle reclaim: the settings child carries the full Pi runtime yet serves
  // only settings/OAuth calls, so after idleMs of total quiescence it exits
  // through the normal 'stop' protocol (forced termination as fallback).
  // Retire only ever runs with no pending request — timed-out calls stay as
  // unconfirmed in-flight markers until their late answer, an explicit
  // cancel/stop or the child's exit clears them — and with no start/stop/
  // retire in flight; long authLogin, respond or discovery calls simply
  // postpone the clock. Idle retire is not a permanent stop: the next request
  // respawns through acquire(); requests are never replayed and the idle path
  // itself never restarts the child.
  clearIdleTimer() {
    if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  armIdle() {
    this.clearIdleTimer();
    if (this.stopped || !this.idleMs || this.retiring || !this.running) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; this.retireIdle(); }, this.idleMs);
    this.idleTimer.unref?.();
  }

  retireIdle() {
    if (this.stopped || this.retiring || this.starting || this.pending.size || !this.running) { this.armIdle(); return; }
    const child = this.child;
    // retireChild sends its 'stop' request synchronously below, before
    // this.retiring becomes observable, so a request racing the timer can
    // only land in acquire() and wait for the handoff — never on the child.
    this.retiring = this.retireChild(child).finally(() => { this.retiring = null; });
    this.retiring.catch(() => {});
  }

  async retireChild(child) {
    try { await this.call('stop', { timeoutMs: 5000 }, 6000); } catch { /* no graceful answer; forced termination below */ }
    await terminate(child);
    if (this.child === child) this.child = null;
    this.clearIdleTimer();
  }
}
