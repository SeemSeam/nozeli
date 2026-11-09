// Ordinary interactive project terminal: one real user shell per project.
//
// The host — never the renderer — owns the process identity: cwd is the
// registered project root, the shell follows OS login policy (/etc/passwd for
// the current uid, then a validated $SHELL, then /bin/sh; never "bash" as a
// universal assumption), and the environment is the user's inherited
// environment with Agent-runtime/secret-bearing selectors scrubbed before the
// PTY ever sees them. The renderer gets no cwd/command authority: payloads
// carry only identity, size and text.
//
// Ownership proof: every spawned tree carries a private, secret-free
// `NOZELI_PROJECT_TERMINAL_OWNER=<uuid>` env tag, and termination is the
// platform adapter's verified whole-table reaper (same-uid tagged processes
// plus un-tagged same-group members), not a group-only guess — interactive
// shells place jobs in their own process groups and a setsid child escapes the
// group entirely. If the leader's verified /proc identity cannot be
// established at startup the shell is killed and the spawn refuses; nothing
// runs without a provable identity.
//
// Liveness intent is host memory only. `project-terminal.open` (rail) records
// the explicit-start intent and broadcasts it; `attach` spawns only on that
// intent or an explicit surface restart request, serialized per project so
// concurrent attaches can never create two shells. A cold-restored surface
// shows an honest not-started state instead of replaying a shell nobody asked
// for. The intent is never persisted into the workspace layout.

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { findView, layoutGroups, reduceLayout } from '../domain/workspace-layout.mjs';
import { terminalEnvironment } from '../agents/terminal-environment.mjs';
import { selectCapability, capabilityStatus, currentPlatform } from '../platform/platform-capabilities.mjs';
import * as linuxOwnership from '../platform/linux/process-ownership.mjs';
import * as macosOwnership from '../platform/darwin/process-ownership.mjs';

const fail = (code, message = code) => Object.assign(new Error(message), { code });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);

const MIN_COLS = 2, MAX_COLS = 500, MIN_ROWS = 2, MAX_ROWS = 300;
const DEFAULT_COLS = 80, DEFAULT_ROWS = 24;
const WRITE_LIMIT = 16 * 1024;
const READ_FRAME_LIMIT = 128, READ_BYTE_LIMIT = 192 * 1024;
const RING_BYTE_LIMIT = 2 * 1024 * 1024, RING_ENTRY_LIMIT = 20000;
const EXIT_WAIT_MS = 2000;

// Secret-free private ownership tag: descendants carry it in their
// environment so the platform reaper can prove — not guess — tree membership
// across process groups. It is a random identity, never a credential.
const OWNER_TAG = 'NOZELI_PROJECT_TERMINAL_OWNER';
const OWNER_MESSAGES = {
  groupReused: 'project terminal group identity reused',
  leaderReused: 'project terminal leader identity reused',
  memberUnverified: 'project terminal descendant identity cannot be verified',
  leaderUnverified: 'project terminal identity cannot be verified',
  leaderDidNotExit: 'owned project terminal did not exit',
  descendantsDidNotExit: 'owned project terminal descendants did not exit',
};
const terminalOwnership = {
  member: (env, record) => env.includes(`${OWNER_TAG}=${record.tag}`),
  leader: (env, _command, record) => env.includes(`${OWNER_TAG}=${record.tag}`),
  messages: OWNER_MESSAGES,
};

// Agent-runtime selectors, Electron/Chromium internals and obvious secret
// bearers never reach the user's interactive shell. HOME/PATH/DBUS/display
// variables stay: this is the user's own login environment, sanitized.
const SCRUBBED_ENV = /^(NOZELI|OMP|ELECTRON|CHROMIUM|CHROME|CRONET|VSCODE|CODEX|AWS|AZURE)_/;
const SCRUBBED_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY)/i;
const NON_INTERACTIVE_SHELLS = new Set(['/sbin/nologin', '/usr/sbin/nologin', '/bin/false', '/usr/bin/false', '/sbin/halt', '/usr/sbin/halt', '/sbin/shutdown', '/usr/sbin/shutdown']);

function userEnv(base) {
  const env = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    if (typeof value !== 'string') continue;
    if (SCRUBBED_ENV.test(key) || SCRUBBED_ENV_NAME.test(key) || key === 'GOOGLE_API_KEY') continue;
    env[key] = value;
  }
  return terminalEnvironment(env);
}

export class ProjectTerminalHost {
  constructor({
    workspace, host, onError = () => {},
    platform = process.platform, uid = typeof process.getuid === 'function' ? process.getuid() : -1,
    env = process.env, readFile, access, ptyLoader, ownership, now = Date.now,
  } = {}) {
    Object.assign(this, { workspace, host, onError, platform, uid, env, now });
    const fs = () => import('node:fs/promises');
    this.readFile = readFile ?? (async (file, encoding = 'utf8') => (await fs()).readFile(file, encoding));
    this.access = access ?? (async (file, mode) => (await fs()).access(file, mode));
    // ESM has no bare `require`; the loader must still resolve node-pty from
    // this module's own location so the real PTY loads in the packed app.
    this.nodeRequire = createRequire(import.meta.url);
    this.ptyLoader = ptyLoader ?? (() => this.nodeRequire('node-pty'));
    this.ownership = ownership ?? (() => selectCapability({ capability: 'verified-process-ownership', implementations: { linux: linuxOwnership, macos: macosOwnership } }));
    this.instances = new Map();   // projectId -> live instance record
    this.pendingStart = new Set(); // explicit rail/restart intent, host memory only
    this.spawnGates = new Map();  // projectId -> serialized spawn/attach chain
  }

  invoke(r, op, p = {}) {
    if (op === 'project-terminal.open') return this.open(r, p);
    if (op === 'project-terminal.attach') return this.attach(r, p);
    if (op === 'project-terminal.read') return this.read(r, p);
    if (op === 'project-terminal.write') return this.write(r, p);
    if (op === 'project-terminal.resize') return this.resize(r, p);
    if (op === 'project-terminal.stop') return this.stop(r, p);
    throw fail('UNKNOWN_OP', '未知项目终端操作。');
  }

  #requireSurface(r, p) {
    if (r?.role !== 'surface' || r.kind !== 'project-terminal') throw fail('IPC_DENIED', '项目终端操作只属于项目终端工作面。');
    if (p.projectId !== r.projectId || p.viewId !== r.viewId) throw fail('PROJECT_SCOPE_DENIED', '项目终端操作只能作用于自身工作面。');
  }

  #instance(r, p) {
    const instance = this.instances.get(r.projectId);
    if (!instance || instance.instanceId !== p.instanceId) {
      throw Object.assign(fail('TERMINAL_INSTANCE_STALE', '项目终端连接已变化，请重新附着。'), { currentInstanceId: instance?.instanceId ?? null });
    }
    return instance;
  }

  // Rail entry: register (or reveal) the single project-terminal view. Never
  // spawns by itself — it only records the explicit-start intent and tells the
  // mounted surface to attach.
  async open(r, p = {}) {
    if (r.role !== 'shell') throw fail('IPC_DENIED', '项目终端只能从工作区入口打开。');
    if (p.projectId !== r.projectId || !p.projectId) throw fail('PROJECT_SCOPE_DENIED');
    if (p.groupId !== undefined && !identity(p.groupId)) throw fail('INVALID_GROUP');
    if (this.workspace.lifecycle.has(p.projectId)) throw fail('PROJECT_LIFECYCLE_ACTIVE', '项目正在保留并关闭，请等待操作结果。');
    let result;
    for (let attempt = 0; ; attempt++) {
      const layout = await this.workspace.layout(p.projectId);
      const existing = Object.values(layout.views).find(entry => entry?.kind === 'project-terminal');
      // Repeat rail entries REVEAL: activation never creates a pane, so the
      // terminal can never fan out blank splits on re-entry. Only the first
      // entry registers the view.
      const terminalCommand = existing
        ? { type: 'activate', viewId: existing.id, ...(p.groupId ? { groupId: p.groupId } : {}) }
        : { type: 'open', ...(p.groupId ? { groupId: p.groupId } : {}), view: { kind: 'project-terminal' } };
      try {
        result = await this.workspace.command(r, {
          projectId: p.projectId, expectedRevision: layout.revision, requestKey: 'project-terminal-open-' + randomUUID(),
          command: terminalCommand,
        });
        break;
      } catch (error) {
        if (error.code !== 'LAYOUT_STALE' || attempt >= 2) throw error;
      }
    }
    const view = Object.values(result.layout.views).find(entry => entry?.kind === 'project-terminal');
    if (!view) throw fail('TERMINAL_VIEW_MISSING', '项目终端未能注册到工作区。');
    this.pendingStart.add(p.projectId);
    this.workspace.broadcast('nozeli:workspace-control', { type: 'project-terminal-open', projectId: p.projectId, viewId: view.id }, p.projectId);
    // The reveal hands the keyboard to the terminal surface so Enter/Ctrl-C
    // reach the shell, not shell-chrome shortcuts.
    try {
      const surface = this.workspace.surfaces.get(view.id);
      if (surface && !surface.dead) { surface.wc.focus(); surface.wc.send('nozeli:workspace-control', { type: 'focus-content' }); }
    } catch { /* still mounting: the open broadcast re-attaches it */ }
    return { layout: result.layout, windowId: result.windowId, viewId: view.id, started: true };
  }

  // All attach work — including the fast rebind path — runs through one
  // per-project chain: the instance check and the spawn decision are never
  // separated by an await another attach could interleave with.
  #serialized(projectId, work) {
    const turn = (this.spawnGates.get(projectId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.spawnGates.set(projectId, turn);
    return turn.finally(() => { if (this.spawnGates.get(projectId) === turn) this.spawnGates.delete(projectId); });
  }

  async attach(r, p = {}) {
    this.#requireSurface(r, p);
    const size = this.#sizeHint(p);
    return this.#serialized(r.projectId, async () => {
      let instance = this.instances.get(r.projectId);
      if (instance?.spawning) await instance.spawning.catch(() => {});
      instance = this.instances.get(r.projectId);
      if (instance && instance.status === 'running') {
        instance.viewId = r.viewId; // rebind survives detach/dock/reload: same shell
        if (size && (size.cols !== instance.cols || size.rows !== instance.rows)) await this.#applyResize(instance, size.cols, size.rows);
        return this.#live(instance);
      }
      if (instance && instance.status !== 'running') {
        if (p.restart !== true) { instance.viewId = r.viewId; return this.#exitedView(instance); }
        // An explicit restart must first PROVE the previous shell's owned tree
        // is gone; a new shell never starts over an unverified leftover.
        if (instance.cleanupPromise) await instance.cleanupPromise;
        if (instance.cleanup?.cleanupComplete !== true) {
          throw Object.assign(fail('TERMINAL_CLEANUP_INCOMPLETE', '原终端后台进程尚未确认退出，暂不启动新终端。'), { cleanup: this.#cleanupView(instance.cleanup) });
        }
        this.instances.delete(r.projectId);
      }
      const explicit = p.restart === true || this.pendingStart.has(r.projectId);
      if (!explicit) return { instanceId: null, status: 'not-started', reason: 'EXPLICIT_START_REQUIRED' };
      instance = await this.#spawn(r.projectId, r.viewId, size ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
      return this.#live(instance);
    });
  }

  async #spawn(projectId, viewId, { cols, rows }) {
    const selection = this.ownership();
    // The gate is the capability matrix, not a platform literal: a platform
    // declares verified native terminal ownership (and ships its adapter) or
    // gets the same explicit refusal — never a fake terminal.
    const declared = capabilityStatus('verified-process-ownership', { platform: this.platform });
    if (declared.status !== 'implemented' || selection.state !== 'available') {
      const status = declared.status !== 'implemented'
        ? `Capability verified-process-ownership is ${declared.status} on ${declared.platformRaw}`
        : (selection.status ?? selection.reason ?? 'verified process ownership unavailable');
      throw Object.assign(fail('UNSUPPORTED_PLATFORM', `项目终端仅在经过验证的平台提供：${currentPlatform(this.platform)}（${status}），不会伪造终端。`), { platform: currentPlatform(this.platform), status });
    }
    const ownership = selection.implementation;
    const project = await this.host.requireRegisteredProject(projectId);
    const root = project?.root;
    if (typeof root !== 'string' || !root) throw fail('PROJECT_ROOT_MISSING', '项目根目录不可用，无法启动终端。');
    const shell = await this.#resolveShell();
    const tag = randomUUID();
    // Pre-spawn snapshot of uninspectable same-uid incarnations: only these
    // can be excluded later; anything uninspectable that appears afterwards is
    // an unknown the strict reaper refuses to certify or kill.
    const baseline = await (this.captureBaseline ?? (typeof ownership.captureUninspectableBaseline === 'function' ? ownership.captureUninspectableBaseline : this.#captureBaseline)).call(this);
    const instance = {
      instanceId: randomUUID(), projectId, viewId, pid: null, stamp: null, tag, baseline,
      cols, rows, cwd: root, shell, seq: 0, ring: [], ringBytes: 0,
      status: 'starting', exitCode: null, cleanup: null, cleanupPromise: null, startedAt: this.now(),
      pty: null, exitPromise: null, spawning: null, stopping: null,
    };
    this.instances.set(projectId, instance);
    instance.spawning = (async () => {
      let term;
      try {
        const pty = this.ptyLoader();
        term = pty.spawn(shell.path, [], { name: 'xterm-256color', cols, rows, cwd: root, env: { ...userEnv(this.env), [OWNER_TAG]: tag } });
      } catch (error) {
        this.instances.delete(projectId);
        throw fail('PTY_UNAVAILABLE', '本机 PTY 不可用，无法启动项目终端：' + (error?.message || error));
      }
      instance.pty = term;
      instance.pid = term.pid;
      instance.exitPromise = new Promise(resolve => term.onExit(value => resolve(value)));
      const stamp = await ownership.processStamp(term.pid).catch(() => null);
      if (typeof stamp !== 'string' || !stamp) {
        // No verified /proc identity means no provable ownership later: the
        // shell dies now and the spawn refuses instead of running untracked.
        try { term.kill(); } catch { /* already gone */ }
        await Promise.race([instance.exitPromise.catch(() => {}), delay(EXIT_WAIT_MS)]);
        try { ownership.signalProcessGroup(term.pid, 'SIGKILL'); } catch { /* already gone */ }
        this.instances.delete(projectId);
        throw fail('PTY_UNAVAILABLE', '无法建立项目终端进程身份，本次启动已终止。');
      }
      instance.stamp = stamp;
      if (this.instances.get(projectId) !== instance) {
        // A stop raced the startup: this shell must never run untracked.
        try { term.kill(); } catch { /* already gone */ }
        try { ownership.signalProcessGroup(term.pid, 'SIGKILL'); } catch { /* already gone */ }
        throw fail('TERMINAL_STOPPED_DURING_START', '启动期间终端已被关闭，本次进程已终止。');
      }
      instance.status = 'running';
      term.onData(data => this.#emit(instance, data));
      term.onExit(value => { void this.#exited(instance, value?.exitCode); });
      this.pendingStart.delete(projectId);
      return instance;
    })();
    try {
      await instance.spawning;
    } catch (error) {
      this.instances.delete(projectId);
      throw error;
    }
    return instance;
  }

  #emit(instance, data) {
    if (typeof data !== 'string' || !data) return;
    const frame = { seq: ++instance.seq, data };
    instance.ring.push(frame);
    instance.ringBytes += Buffer.byteLength(data);
    while (instance.ring.length > RING_ENTRY_LIMIT || instance.ringBytes > RING_BYTE_LIMIT) {
      const dropped = instance.ring.shift();
      if (!dropped) break;
      instance.ringBytes -= Buffer.byteLength(dropped.data);
    }
  }

  async #exited(instance, exitCode) {
    if (instance.status !== 'running') return;
    instance.status = 'exited';
    instance.exitCode = typeof exitCode === 'number' ? exitCode : null;
    // A dead leader does not imply its background children died: verify and
    // reap the owned tagged tree even on natural exit. The receipt (complete
    // or not) gates any later restart.
    instance.cleanupPromise = this.#reapTree(instance)
      .then(receipt => { instance.cleanup = { ...receipt, reason: 'shell-exit' }; return receipt; })
      .catch(error => {
        instance.cleanup = { exited: true, descendantsConfirmed: false, cleanupComplete: false, error: error?.code || error?.message || String(error), reason: 'shell-exit' };
        return instance.cleanup;
      });
    await instance.cleanupPromise;
  }

  // Verified termination through the platform adapter: the whole same-uid
  // tagged tree (any process group, including setsid escapees) plus un-tagged
  // same-group members, TERM→KILL until the table is empty. Only the
  // adapter's verified verdict certifies cleanup; anything else fails closed.
  async #reapTree(instance) {
    const selection = this.ownership();
    if (capabilityStatus('verified-process-ownership', { platform: this.platform }).status !== 'implemented' || selection.state !== 'available') return { exited: true, descendantsConfirmed: false, cleanupComplete: false, reason: `verified reaping unavailable on ${this.platform}` };
    if (typeof instance.stamp !== 'string' || !instance.stamp) return { exited: true, descendantsConfirmed: false, cleanupComplete: false, reason: 'terminal process identity was never established' };
    const result = await selection.implementation.reapOwnerTaggedTree({ pid: instance.pid, stamp: instance.stamp, tag: instance.tag }, terminalOwnership, { strict: true, baseline: instance.baseline ?? null });
    return { exited: true, descendantsConfirmed: result?.verified === true, cleanupComplete: result?.verified === true, reaped: result?.descendantsReaped ?? 0 };
  }

  async read(r, p = {}) {
    this.#requireSurface(r, p);
    if (!Number.isSafeInteger(p.afterSeq) || p.afterSeq < 0) throw fail('INVALID_SEQ', '终端回放序号无效。');
    const instance = this.instances.get(r.projectId);
    if (!instance || instance.instanceId !== p.instanceId) {
      if (!instance) return { instanceId: null, status: 'not-started', frames: [], nextSeq: p.afterSeq, reason: 'EXPLICIT_START_REQUIRED' };
      throw Object.assign(fail('TERMINAL_INSTANCE_STALE', '项目终端连接已变化，请重新附着。'), { currentInstanceId: instance.instanceId });
    }
    if (instance.spawning) await instance.spawning.catch(() => {});
    if (p.afterSeq > instance.seq) throw fail('INVALID_SEQ', '终端回放序号超过当前输出。');
    let truncated = false;
    let frames = instance.ring.filter(frame => frame.seq > p.afterSeq);
    const oldest = instance.ring[0]?.seq;
    if (frames.length && oldest !== undefined && p.afterSeq + 1 < oldest) {
      truncated = true;
      frames = [...instance.ring];
    }
    const bounded = [];
    let bytes = 0;
    for (const frame of frames) {
      if (bounded.length >= READ_FRAME_LIMIT || bytes + Buffer.byteLength(frame.data) > READ_BYTE_LIMIT) break;
      bounded.push(frame);
      bytes += Buffer.byteLength(frame.data);
    }
    return {
      instanceId: instance.instanceId,
      status: instance.status === 'running' ? 'running' : 'exited',
      frames: bounded.map(({ seq, data }) => ({ seq, data })),
      // Total emitted sequence, not the last page: an exited surface can drain
      // until its rendered seq reaches nextSeq without premature completion.
      nextSeq: instance.seq,
      ...(truncated ? { truncated: true } : {}),
      ...(instance.status !== 'running' ? { exitCode: instance.exitCode, ...(instance.cleanup ? { cleanup: this.#cleanupView(instance.cleanup) } : {}) } : {}),
    };
  }

  async write(r, p = {}) {
    this.#requireSurface(r, p);
    const instance = this.#instance(r, p);
    if (instance.spawning) await instance.spawning.catch(() => {});
    if (instance.status !== 'running') throw Object.assign(fail('TERMINAL_EXITED', '终端进程已退出，输入未送达。'), { exitCode: instance.exitCode });
    if (typeof p.data !== 'string' || !p.data) throw fail('INVALID_PAYLOAD', '终端输入无效。');
    if (Buffer.byteLength(p.data) > WRITE_LIMIT) throw fail('INVALID_PAYLOAD', '单次终端输入超过限制。');
    instance.pty.write(p.data);
    return { written: true, nextSeq: instance.seq };
  }

  async resize(r, p = {}) {
    this.#requireSurface(r, p);
    const instance = this.#instance(r, p);
    const { cols, rows } = this.#requireSize(p);
    await this.#applyResize(instance, cols, rows);
    return { resized: true, cols: instance.cols, rows: instance.rows };
  }

  async #applyResize(instance, cols, rows) {
    instance.cols = cols; instance.rows = rows;
    if (instance.status === 'running' && instance.pty) {
      try { instance.pty.resize(cols, rows); } catch { /* leader may be exiting */ }
    }
    void this.#persistSize(instance).catch(error => this.onError(error));
  }

  #sizeHint(p) {
    if (p.cols === undefined && p.rows === undefined) return null;
    return this.#requireSize(p);
  }

  #requireSize(p) {
    const cols = p.cols ?? DEFAULT_COLS, rows = p.rows ?? DEFAULT_ROWS;
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < MIN_COLS || cols > MAX_COLS || rows < MIN_ROWS || rows > MAX_ROWS) {
      throw fail('INVALID_SIZE', `终端尺寸须为 ${MIN_COLS}–${MAX_COLS} 列 × ${MIN_ROWS}–${MAX_ROWS} 行。`);
    }
    return { cols, rows };
  }

  // Host-owned viewState: only presentation size is persisted, never a spawn
  // intent — cold restore reads the size but never auto-starts a shell.
  async #persistSize(instance) {
    await this.workspace.serial(instance.projectId, async () => {
      const layout = await this.workspace.layout(instance.projectId);
      const view = layout.views[instance.viewId];
      if (!view || view.kind !== 'project-terminal') return;
      if (view.viewState?.cols === instance.cols && view.viewState?.rows === instance.rows) return;
      const next = reduceLayout(layout, { type: 'restoreViewState', viewId: instance.viewId, viewState: { ...(view.viewState ?? {}), cols: instance.cols, rows: instance.rows } });
      next.revision = layout.revision;
      await this.workspace.persist(next);
      this.workspace.layouts.set(instance.projectId, next);
      this.workspace.changed(next);
    });
  }

  async stop(r, p = {}) {
    this.#requireSurface(r, p);
    const instance = this.#instance(r, p);
    const cleanup = await this.#stopInstance(instance, 'surface-stop');
    return { stopped: true, instanceId: instance.instanceId, exitCode: instance.exitCode, cleanup: this.#cleanupView(cleanup) };
  }

  // Shutdown shares the per-project spawn chain: a stop never reports
  // "nothing to stop" while an attach is still between intents and process,
  // and a queued attach cannot create a shell across a completed stop.
  stopProject(projectId, reason = 'project-close') {
    return this.#serialized(projectId, async () => {
      this.pendingStart.delete(projectId);
      const instance = this.instances.get(projectId);
      if (!instance) return { stopped: false, reason };
      const cleanup = await this.#stopInstance(instance, reason);
      return { stopped: true, reason, instanceId: instance.instanceId, cleanup: this.#cleanupView(cleanup) };
    });
  }

  async stopAll() {
    // A project can be mid-startup (gate held, no instance yet) or merely
    // intent-carrying: shutdown must cover every possible future process, not
    // only the ones already registered.
    const projects = new Set([...this.instances.keys(), ...this.spawnGates.keys()]);
    this.pendingStart.clear();
    const failures = [];
    for (const projectId of projects) {
      try { await this.stopProject(projectId, 'app-exit'); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures.length === 1 ? failures[0] : Object.assign(new AggregateError(failures, '项目终端清理未完成确认。'), { code: 'TERMINAL_CLEANUP_INCOMPLETE' });
    return { stopped: true };
  }

  #stopInstance(instance, reason) {
    if (instance.stopping) return instance.stopping;
    instance.stopping = (async () => {
      this.pendingStart.delete(instance.projectId);
      if (instance.status !== 'exited' && instance.pty) { try { instance.pty.kill(); } catch { /* already gone */ } }
      if (instance.exitPromise) await Promise.race([instance.exitPromise.catch(() => {}), delay(EXIT_WAIT_MS)]);
      if (instance.cleanupPromise) await instance.cleanupPromise;
      // A second verified pass even after the natural-exit reap: only the
      // adapter's empty-table verdict completes the stop.
      const cleanup = await this.#reapTree(instance).catch(error => ({ exited: true, descendantsConfirmed: false, cleanupComplete: false, error: error?.code || error?.message || String(error) }));
      instance.status = 'exited';
      instance.exitCode ??= null;
      instance.cleanup = { ...cleanup, reason };
      if (instance.cleanup.cleanupComplete !== true) {
        // Retain the ownership record: an unverified tree must block any new
        // shell for this project and keep its identity available for a retry,
        // never be reported as a successful stop. The cached stop is cleared
        // so a later stop genuinely re-runs the verified reaper.
        instance.stopping = null;
        throw Object.assign(fail('TERMINAL_CLEANUP_INCOMPLETE', '项目终端后台进程尚未确认全部退出，已保留归属记录以便重试。'), { cleanup: this.#cleanupView(instance.cleanup), instanceId: instance.instanceId });
      }
      this.instances.delete(instance.projectId);
      return instance.cleanup;
    })();
    return instance.stopping;
  }

  // Layout transitions own shell lifetime: closing the content (or removing
  // the view) reclaims the PTY; merely backgrounding it behind another view
  // (history) or hiding the project keeps the same shell alive.
  layoutChanged(layout) {
    try {
      if (!layout || layout.schema !== 2) return;
      if (!this.#active(layout.projectId)) return;
      const view = Object.values(layout.views).find(entry => entry?.kind === 'project-terminal');
      if (!view) { void this.stopProject(layout.projectId, 'content-closed').catch(error => this.onError(error)); return; }
      const presented = Boolean(findView(layout, view.id));
      const retained = ['main', ...layout.detached.map(window => window.id)].some(windowId => layoutGroups(layout, windowId).some(group => group.historyViewIds?.includes(view.id)));
      if (!presented && !retained) void this.stopProject(layout.projectId, 'content-closed').catch(error => this.onError(error));
    } catch (error) { this.onError(error); }
  }

  #active(projectId) { return this.instances.has(projectId) || this.spawnGates.has(projectId) || this.pendingStart.has(projectId); }

  // Snapshot of uninspectable same-uid processes taken strictly BEFORE the
  // spawn. Only these incarnations are excludable later; a failed snapshot
  // just narrows exclusions (strictness never decreases), so it never blocks
  // a spawn.
  async #captureBaseline() {
    try {
      const { readdir, readFile, stat } = await import('node:fs/promises');
      const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
      const baseline = new Set();
      for (const name of await readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        try {
          const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
          const parts = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
          if (parts[0] === 'Z' || (await stat(`/proc/${pid}`)).uid !== uid) continue;
          try { await readFile(`/proc/${pid}/environ`); }
          catch (error) {
            if (['EACCES', 'EPERM'].includes(error.code)) baseline.add(`${pid}:${parts[19]}`);
            else if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
          }
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
      }
      return baseline;
    } catch { return null; }
  }

  #live(instance) {
    return { instanceId: instance.instanceId, status: 'running', pid: instance.pid, shell: { ...instance.shell }, cwd: instance.cwd, cols: instance.cols, rows: instance.rows, nextSeq: instance.seq, startedAt: instance.startedAt };
  }

  #exitedView(instance) {
    return { instanceId: instance.instanceId, status: 'exited', exitCode: instance.exitCode, nextSeq: instance.seq, ...(instance.cleanup ? { cleanup: this.#cleanupView(instance.cleanup) } : {}) };
  }

  #cleanupView(receipt) {
    return { exited: receipt?.exited === true, descendantsConfirmed: receipt?.descendantsConfirmed === true, cleanupComplete: receipt?.cleanupComplete === true, ...(receipt?.reason ? { reason: receipt.reason } : {}), ...(receipt?.error ? { error: receipt.error } : {}) };
  }

  // OS login shell policy for the current uid: /etc/passwd first, then a
  // validated $SHELL, then /bin/sh. Every candidate must be an absolute,
  // executable, interactive path — never a hardcoded bash.
  async #resolveShell() {
    const candidates = [];
    try {
      const passwd = await this.readFile('/etc/passwd', 'utf8');
      const entry = passwd.split('\n').find(line => Number(line.split(':')[2]) === this.uid);
      const shell = entry?.split(':')?.[6];
      if (shell) candidates.push(shell);
    } catch { /* no passwd readable: policy falls through */ }
    if (typeof this.env.SHELL === 'string' && this.env.SHELL) candidates.push(this.env.SHELL);
    candidates.push('/bin/sh');
    const seen = new Set();
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !candidate.startsWith('/') || NON_INTERACTIVE_SHELLS.has(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        const { X_OK } = (await import('node:fs/promises')).constants;
        await this.access(candidate, X_OK);
        return { path: candidate, name: candidate.split('/').at(-1) };
      } catch { /* candidate unusable: try the next policy source */ }
    }
    throw fail('SHELL_UNAVAILABLE', '当前系统未配置可用的交互式登录 shell，无法启动项目终端。');
  }
}
