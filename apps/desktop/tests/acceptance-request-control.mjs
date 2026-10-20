import http from 'node:http';
import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { processStamp, ownerAlive } from '../src/agents/managed/process-ownership.mjs';

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const abortError = () => new DOMException('Acceptance control stopped; no upstream admission', 'AbortError');
const numericUsage = usage => Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].filter(k => Number.isSafeInteger(usage?.[k]) && usage[k] >= 0).map(k => [k, usage[k]]));
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : undefined;
const destination = address => { const u = new URL(address); return u.origin + u.pathname; };

// Short-lived acquisition gate serializes stale recovery with fresh acquisition.
// An abandoned gate is deliberately NOT guessed stale: fail closed for inspection.
async function claimLedgerOwner(ledgerPath, recoverStaleOwner) {
  const lock = ledgerPath + '.owner', gate = lock + '.gate';
  await fs.mkdir(gate, { mode: 0o700 }).catch(error => { if (error.code === 'EEXIST') throw new Error('Ledger ownership transition already active; refusing concurrent owner'); throw error; });
  let owner;
  try {
    owner = { pid: process.pid, stamp: await processStamp(process.pid), nonce: randomUUID() };
    let previous;
    try { previous = JSON.parse(await fs.readFile(lock, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      if (!recoverStaleOwner || process.platform !== 'linux' || typeof previous.stamp !== 'string' || !previous.stamp || typeof previous.nonce !== 'string' || await ownerAlive(previous)) throw new Error('Ledger already owned or owner staleness unproven');
      await fs.unlink(lock);
    }
    const handle = await fs.open(lock, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); }
    catch (error) { await fs.unlink(lock); throw error; }
    finally { await handle.close(); }
  } finally { await fs.rmdir(gate); }
  return async () => {
    const current = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (current.nonce !== owner.nonce) throw new Error('Ledger owner changed; refusing release');
    await fs.unlink(lock);
  };
}

/**
 * Single admission authority shared by every role and process reopen. Persist-before-grant
 * conservatively counts uncertain/crashed admissions; never refund or reset on reconnect.
 * Numeric maxAttempts is a hard HTTP-admission bound, NOT a token/cost bound.
 * Numeric maxInputOutput is an observed-usage stop threshold; in-flight usage can
 * exceed it. Explicit null disables each numeric limit/deadline, not accounting,
 * destination/model authorization, exclusive ownership, or deliberate stopping.
 * onStop must stop the runner's owned processes: SDK ctx.abort is not a process-wide gate.
 * Keep this server alive across Electron reopen; alternatively reopen the same ledger.
 */
export async function createAcceptanceCollector({ ledgerPath, maxAttempts = null, maxInputOutput = null, deadlineAt = null, allowedDestinations, allowedModels = null, recoverStaleOwner = false, listenPort = 0, onStop = () => {} }) {
  if (!ledgerPath || (maxAttempts !== null && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0)) || (maxInputOutput !== null && (!Number.isSafeInteger(maxInputOutput) || maxInputOutput < 0)) || (deadlineAt !== null && !Number.isFinite(deadlineAt)) || !Array.isArray(allowedDestinations)) throw new TypeError('Explicit ledger and destinations with valid optional limits required');
  if (allowedModels !== null && (!Array.isArray(allowedModels) || allowedModels.some(m => typeof m !== 'string'))) throw new TypeError('Invalid model allowlist');
  if (!Number.isSafeInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new TypeError('Invalid loopback collector port');
  const policy = { maxAttempts, maxInputOutput, deadlineAt, allowedDestinations: [...new Set(allowedDestinations.map(destination))].sort(), allowedModels: allowedModels === null ? null : [...new Set(allowedModels)].sort() };
  ledgerPath = path.join(await fs.realpath(path.dirname(ledgerPath)), path.basename(ledgerPath));
  const ledgerStat = await fs.lstat(ledgerPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (ledgerStat?.isSymbolicLink()) throw new Error('Ledger symlinks are not supported');
  const releaseOwner = await claimLedgerOwner(ledgerPath, recoverStaleOwner);
  let server, timer;
  try {
  let ledger;
  try { ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; ledger = { version: 1, runId: randomUUID(), policy, attempts: {}, usage: {}, events: [], inputOutput: 0, stopped: null }; }
  if (ledger.version !== 1 || JSON.stringify(ledger.policy) !== JSON.stringify(policy) || !ledger.attempts || !ledger.usage || !Array.isArray(ledger.events) || !Number.isSafeInteger(ledger.inputOutput)) throw new Error('Acceptance ledger/policy mismatch; refusing budget reset');
  let chain = Promise.resolve(), notified = false;
  const persist = async () => { const tmp = ledgerPath + '.pending'; await fs.writeFile(tmp, JSON.stringify(ledger), { mode: 0o600 }); await fs.rename(tmp, ledgerPath); };
  const notify = reason => { if (!notified) { notified = true; Promise.resolve().then(() => onStop(reason)).catch(() => {}); } };
  const stopInside = async reason => { ledger.stopped ??= reason; await persist(); notify(ledger.stopped); };
  const serialize = fn => { const result = chain.then(fn); chain = result.catch(() => {}); return result; };
  const check = async () => {
    if (!ledger.stopped && deadlineAt !== null && Date.now() >= deadlineAt) await stopInside('deadline');
    if (!ledger.stopped && maxInputOutput !== null && ledger.inputOutput >= maxInputOutput) await stopInside('observed-input-output');
    if (ledger.stopped) notify(ledger.stopped);
  };
  await persist();
  await check();
  server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !['/admit', '/event', '/stop'].includes(req.url)) { res.writeHead(404).end(); return; }
      let raw = ''; for await (const bytes of req) { raw += bytes; if (raw.length > 32768) throw new Error('Control record too large'); }
      const v = JSON.parse(raw);
      const result = await serialize(async () => {
        await check();
        if (req.url === '/stop') { await stopInside('extension-control-stop'); return { allowed: false, stopped: ledger.stopped }; }
        if (typeof v.id !== 'string' || !/^[a-zA-Z0-9:._-]{1,256}$/.test(v.id) || typeof v.instance !== 'string' || !/^[a-f0-9]{64}$/.test(v.instance)) throw new Error('Invalid identity');
        if (req.url === '/admit') {
          if (ledger.stopped) return { allowed: false, stopped: ledger.stopped };
          // A repeated grant ID is never sent upstream twice, even after reconnect.
          if (ledger.attempts[v.id]) return { allowed: false, stopped: 'duplicate-admission' };
          if (!policy.allowedDestinations.includes(v.destination)) {
            let origin='invalid',pathHash=digest(String(v.destination));
            try {const denied=new URL(v.destination);origin=denied.origin;pathHash=digest(denied.pathname);}catch{}
            ledger.events.push({id:v.id,instance:v.instance,at:Date.now(),kind:'denied-destination',origin,pathHash});
            await stopInside('unauthorized-destination'); return { allowed: false, stopped: ledger.stopped };
          }
          if (policy.allowedModels && !policy.allowedModels.includes(v.model)) { await stopInside('unauthorized-model'); return { allowed: false, stopped: ledger.stopped }; }
          if (maxAttempts !== null && Object.keys(ledger.attempts).length >= maxAttempts) { await stopInside('attempt-budget'); return { allowed: false, stopped: ledger.stopped }; }
          ledger.attempts[v.id] = { instance: v.instance, destination: v.destination, bodyDigest: /^[a-f0-9]{64}$/.test(v.bodyDigest) ? v.bodyDigest : null, at: Date.now() };
          await persist(); return { allowed: true, runId: ledger.runId };
        }
        // Only whitelisted scalars/hashes are persisted; never error messages, headers,
        // URLs with query strings, payload text, tool args, credentials, or cost guesses.
        const record = { id: v.id, instance: v.instance, at: Date.now() };
        if (v.kind === 'usage') {
          const usage = numericUsage(v.usage);
          if (!ledger.usage[v.id]) { ledger.usage[v.id] = { ...record, usage, attribution: 'unattributed' }; ledger.inputOutput += (usage.input ?? 0) + (usage.output ?? 0); }
        } else if (['response', 'transport-error', 'hook', 'loaded'].includes(v.kind)) {
          if (!ledger.events.some(e => e.id === v.id && e.kind === v.kind)) ledger.events.push({ ...record, kind: v.kind, ...(Number.isInteger(v.status) && v.status >= 100 && v.status <= 599 ? { status: v.status } : {}), ...(safeCode(v.code) ? { code: v.code } : {}), ...(safeCode(v.causeCode) ? { causeCode: v.causeCode } : {}), ...(v.signalAborted === true ? { signalAborted: true } : {}), ...(typeof v.attemptId === 'string' && ledger.attempts[v.attemptId] ? { attemptId: v.attemptId } : {}) });
          if (v.kind === 'response' && [401, 403, 429].includes(v.status)) await stopInside('upstream-http-' + v.status);
        } else throw new Error('Unknown observation kind');
        await check(); await persist(); return { allowed: !ledger.stopped, stopped: ledger.stopped };
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch {
      // Persistence/control faults revoke future admission instead of being SDK errors.
      ledger.stopped ??= 'collector-fault'; notify(ledger.stopped);
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"allowed":false,"stopped":"collector-fault"}');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, '127.0.0.1', resolve); });
  if (deadlineAt !== null) {
    timer = setTimeout(() => { void serialize(() => stopInside('deadline')).catch(() => notify('collector-fault')); }, Math.max(0, Math.min(2147483647, deadlineAt - Date.now())));
    timer.unref();
  }
  let closing;
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => structuredClone(ledger),
    stop: reason => serialize(() => stopInside(reason)),
    close: () => closing ??= (async () => { clearTimeout(timer); try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await chain; } finally { await releaseOwner(); } })(),
  };
  } catch (error) {
    clearTimeout(timer);
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await releaseOwner();
    throw error;
  }
}

const registrationKey = Symbol.for('nozeli.acceptance-request-control.v1');
/**
 * Installed SDK facts (2026-10-18): pi.on returns void, ctx.abort() takes no
 * reason/signal, before_provider_request exposes payload only, after_provider_response
 * exposes status/headers/requestId but no shared request ID with message_end.
 * Thus no fake hook->HTTP->usage matching: each HTTP has its own strong ID; SDK
 * usage is explicitly unattributed. Native/background fetch gets admission without
 * requiring a hook. NativeAPI/Bun native HTTP/websocket/child-process egress cannot
 * be intercepted by this fetch wrapper: runner MUST deny it externally or refuse
 * that transport. This is not a network sandbox. No model/payload/settings changes.
 */
export function installAcceptanceControl(pi, { endpoint, roleInstance, brokerURL = null, target = globalThis, controlFetch = target.fetch.bind(target), observationTimeoutMs = 3000, onStop = () => {} }) {
  const controlURL = new URL(endpoint);
  if (controlURL.protocol !== 'http:' || controlURL.hostname !== '127.0.0.1' || controlURL.username || controlURL.password || controlURL.search || controlURL.hash || controlURL.pathname !== '/') throw new Error('Loopback control endpoint required');
  if (typeof roleInstance !== 'string' || !roleInstance) throw new TypeError('Stable role instance required');
  let registry = target[registrationKey];
  // Routing only: never inspect broker credentials, headers or response bodies.
  const broker = brokerURL ? new URL(brokerURL) : null;
  if (broker && (broker.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(broker.hostname) || broker.username || broker.password || broker.search || broker.hash || broker.pathname !== '/')) throw new Error('Exact loopback broker root required');
  const brokerControl = (input, init) => {
    if (!broker) return false;
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== broker.origin || url.username || url.password) return false;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    return (method === 'GET' && ['/v1/healthz', '/v1/snapshot', '/v1/snapshot/stream', '/v1/usage', '/v1/usage/history', '/v1/usage/clients', '/v1/credentials/disabled'].includes(url.pathname)) || (method === 'POST' && ['/v1/usage/observed', '/v1/usage/stale'].includes(url.pathname)) || (method === 'POST' && /^\/v1\/credential\/\d+\/(refresh|disable|block)$/.test(url.pathname)) || (method === 'DELETE' && /^\/v1\/credential\/\d+\/blocks?$/.test(url.pathname));
  };
  if (!registry) target[registrationKey] = registry = { slots: new WeakMap(), owner: null };
  if (registry.owner) {
    if (registry.owner.pi === pi && registry.owner.endpoint === endpoint && registry.owner.roleInstance === roleInstance) return registry.owner.handle;
    throw new Error('A different acceptance fetch owner is already installed');
  }
  const real = target.fetch, epoch = randomUUID(), instance = digest(roleInstance);
  let stopped = false, active = true, sequence = 0;
  const controllers = new Set(), contexts = new Set(), seenUsage = new WeakSet();
  const id = () => epoch + ':' + (++sequence);
  const stop = (reason, notifyCollector = true) => {
    if (stopped) return;
    stopped = true;
    for (const controller of controllers) controller.abort(abortError());
    for (const ctx of contexts) { try { Promise.resolve(ctx.abort()).catch(() => {}); } catch {} }
    try { onStop(reason); } catch {}
    // Never await a stop from the provider stream that it must cancel.
    if (notifyCollector) void controlFetch(endpoint + '/stop', { method: 'POST', body: '{}', signal: AbortSignal.timeout(observationTimeoutMs) }).catch(() => {});
  };
  const send = async (route, data) => {
    const response = await controlFetch(endpoint + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance, ...data }), signal: AbortSignal.timeout(observationTimeoutMs) });
    if (!response.ok) throw new Error('Acceptance collector unavailable');
    const result = await response.json();
    if (result.allowed !== true) stop('control-stop');
    return result;
  };
  const observe = async data => { try { await send('/event', data); } catch { stop('observation-fault'); } };
  const handler = {
    session_start: async (_e, ctx) => { contexts.add(ctx); await observe({ id: id(), kind: 'loaded' }); },
    before_provider_request: async (_e, ctx) => { contexts.add(ctx); await observe({ id: id(), kind: 'hook' }); if (stopped) { try { Promise.resolve(ctx.abort()).catch(() => {}); } catch {} } },
    message_end: async e => {
      const m = e.message;
      if (m?.role !== 'assistant' || !m.usage || seenUsage.has(m)) return;
      seenUsage.add(m);
      await observe({ id: id(), kind: 'usage', usage: numericUsage(m.usage) });
    },
    session_shutdown: () => handle.dispose(),
  };
  let slot = registry.slots.get(pi);
  if (!slot) {
    slot = { current: null }; registry.slots.set(pi, slot);
    for (const name of Object.keys(handler)) pi.on(name, (...args) => slot.current?.[name](...args));
  }
  slot.current = handler;
  const wrapper = async function (input, init) {
    if (active && brokerControl(input, init)) return real.call(this, input, init);
    if (!active || stopped) throw abortError();
    const controller = new AbortController(); controllers.add(controller);
    const attemptId = id();
    const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
    const signal = originalSignal ? AbortSignal.any([originalSignal, controller.signal]) : controller.signal;
    try {
      let admitted;
      try {
        const address = input instanceof Request ? input.url : String(input);
        const body = typeof init?.body === 'string' ? init.body : input instanceof Request && init?.body === undefined ? await input.clone().text() : null;
        let model = null;
        try { const parsed = JSON.parse(body); if (typeof parsed?.model === 'string') model = parsed.model; } catch {}
        admitted = await send('/admit', { id: attemptId, destination: destination(address), model, bodyDigest: body === null ? null : digest(body) });
      } catch { stop('admission-fault'); throw abortError(); }
      if (!admitted.allowed || stopped || signal.aborted) throw abortError();
      let response;
      try { response = await real.call(this, input, { ...init, signal, redirect: 'error' }); }
      catch (error) {
        await observe({ id: id(), attemptId, kind: 'transport-error', code: safeCode(error?.code), causeCode: safeCode(error?.cause?.code), signalAborted: signal.aborted });
        // Original transport exception identity and cause survive observer failure.
        throw error;
      }
      // Do not read/clone the response body or replace HTTP failures with an observer
      // exception. The raw Response survives even when collection fails here.
      controllers.delete(controller);
      await observe({ id: id(), attemptId, kind: 'response', status: response.status });
      return response;
    } finally { controllers.delete(controller); }
  };
  const handle = {
    stop,
    get stopped() { return stopped; },
    dispose() {
      if (!active) return;
      stop('uninstalled', false); active = false; slot.current = null;
      // Do not overwrite a wrapper installed later by somebody else.
      if (target.fetch === wrapper) target.fetch = real;
      if (registry.owner?.handle === handle) registry.owner = null;
    },
  };
  registry.owner = { pi, endpoint, roleInstance, handle };
  target.fetch = wrapper;
  return handle;
}

/** Write returned source to an explicitly runner-owned temporary extension file. */
export function acceptanceExtensionSource({ modulePath, endpoint, roleInstance }) {
  return `import {installAcceptanceControl} from ${JSON.stringify(pathToFileURL(modulePath).href)};\nexport default pi => { installAcceptanceControl(pi, {...${JSON.stringify({ endpoint, roleInstance })}, brokerURL: process.env.OMP_AUTH_BROKER_URL ?? null}); };\n`;
}
