import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { GrantAuthority } from './grants.mjs';
import { ManagedCollabGuest } from './guest.mjs';
import { startLocalRelay } from './local-relay.mjs';
import { writeAtomicJson } from './atomic-state.mjs';
const digest = (ep, kind, text, images = [], target) => createHash('sha256').update(JSON.stringify({ ep, kind, text, images: images.map(image => ({ t: image.type, m: image.mimeType, d: image.data })), tr: target ?? null })).digest('hex');
const hash = text => createHash('sha256').update(text).digest('hex');
const LIMIT = 2048, ANSWER_BYTES = 4 * 1024 * 1024;
const errorWith = (message, code) => Object.assign(Error(message), { code });
const failureCategory = error => {
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EMFILE'].includes(error?.code)) return 'persistence-' + error.code.toLowerCase();
  if (['OMP_COLLAB_EOF', 'ECONNRESET', 'EPIPE'].includes(error?.code)) return 'transport';
  if (['TIMELINE_SCHEMA', 'TIMELINE_INPUT', 'TIMELINE_IDENTITY', 'TIMELINE_SIZE', 'TIMELINE_OWNER', 'TIMELINE_OBJECT', 'TIMELINE_CORRUPT', 'TIMELINE_COLLISION'].includes(error?.code)) return error.code.toLowerCase().replaceAll('_', '-');
  if (['native-entry-truncated', 'native-entry-mutated', 'native-entry-chunk-order', 'native-entry-chunk-budget', 'native-entry-identity', 'collab-receipt-identity', 'collab-event-epoch-mismatch', 'grant-authority-unavailable', 'grant-authority-already-open', 'invalid transport fact', 'transport immutable binding changed', 'transport request identity collision', 'transport must bind an existing accepted job'].includes(error?.message)) return error.message.replaceAll(' ', '-');
  return error?.code === 'ERR_OSSL_BAD_DECRYPT' || error?.message === 'Unsupported state or unable to authenticate data' ? 'authentication' : 'callback-or-resource-failed';
};
// Compare only native persistence's known representation changes. Never alter
// archived entries: a signature is redundant only if the full reasoning object
// is already present byte-for-byte in the same message's provider payload.
export function canonicalNativeEntryDigest(entry) {
  if (entry.type !== 'message') return hash(JSON.stringify(entry));
  const source = entry.message;
  let message = source;
  if (source?.errorId === 0) { message = { ...message }; delete message.errorId; }
  const payload = source?.providerPayload;
  if (source?.role === 'assistant' && payload?.type === 'openaiResponsesHistory' && Array.isArray(payload.items) && Array.isArray(source.content)) {
    const signatures = new Set(payload.items.filter(item => item?.type === 'reasoning').map(item => JSON.stringify(item)));
    let changed = false;
    const content = source.content.map(block => {
      if (block?.type !== 'thinking' || typeof block.thinkingSignature !== 'string' || !signatures.has(block.thinkingSignature)) return block;
      changed = true;
      const { thinkingSignature, ...remaining } = block;
      return remaining;
    });
    if (changed) message = { ...message, content };
  }
  return hash(JSON.stringify(message === source ? entry : { ...entry, message }));
}

export class NativeCollabRuntime {
  constructor({ home, context, onEntry, onEvent, onFact, nativeState, eligibility }) {
    this.home = home; this.context = context; this.onEntry = onEntry; this.onEvent = onEvent; this.onFact = onFact; this.nativeState = nativeState; this.eligibility = eligibility;
    this.attempts = new Map(); this.entries = new Map(); this.identities = new Map(); this.parts = null; this.snapshot = []; this.snapshotting = true;
    this.answerState = null;
  }
  async prepare() {
    this.relay = await startLocalRelay();
    const controlRoot = path.join(path.dirname(this.home), 'collab-control');
    await fs.mkdir(controlRoot, { recursive: true, mode: 0o700 });
    this.root = await fs.mkdtemp(path.join(controlRoot, 'owner-'));
    this.evidenceRoot = path.join(this.root, 'entries');
    await fs.mkdir(this.evidenceRoot, { mode: 0o700 });
    this.grants = await GrantAuthority.open(this.root);
    this.endpoint = path.join(this.home, 'collab-endpoint-' + randomUUID() + '.json');
    this.adjudicator = path.join(this.root, 'grant-adjudicator.cjs');
    await fs.copyFile(fileURLToPath(new URL('./grant-adjudicator.cjs', import.meta.url)), this.adjudicator);
    return { NOZELI_MANAGED_COLLAB: '1', NOZELI_COLLAB_RELAY: this.relay.url, NOZELI_COLLAB_CAPABILITY: this.relay.capability, NOZELI_COLLAB_ENDPOINT: this.endpoint, NOZELI_ADMISSION_MODULE: this.adjudicator, NOZELI_GRANT_FILE: this.grants.manifestPath, NOZELI_GRANT_OWNER: this.context.ownerId };
  }
  async connect(sessionId) {
    let endpoint;
    const deadline = Date.now() + 30000;
    for (;;) {
      try { endpoint = JSON.parse(await fs.readFile(this.endpoint, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (endpoint.sessionId !== sessionId) throw Error('collab-session-mismatch');
    if (new URL(endpoint.link).origin !== new URL(this.relay.url).origin) throw Error('collab-relay-mismatch');
    this.sessionId = sessionId;
    this.guest = new ManagedCollabGuest({ capability: this.relay.capability, onFrame: frame => this.receive(frame), onLost: () => this.lost() });
    await this.guest.connect(endpoint.link);
    if (this.guest.sessionId !== sessionId) throw Error('collab-welcome-session-mismatch');
    this.epoch = this.guest.epoch;
    await fs.unlink(this.endpoint);
  }
  remember(map, key, value) {
    map.delete(key); map.set(key, value);
    // Eviction is allowed only when immutable evidence has a disk backing.
    if (map.size > LIMIT) {
      if (!this.evidenceRoot) throw Error('collab-evidence-capacity');
      map.delete(map.keys().next().value);
    }
  }
  async stored(entryId) {
    if (!entryId || !this.evidenceRoot) return null;
    try { return JSON.parse(await fs.readFile(path.join(this.evidenceRoot, hash(entryId) + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async identity(entry) {
    const details = entry.type === 'custom_message' ? entry.details : entry.type === 'custom' && entry.customType === 'nozeli-manual-binding' ? entry.data : null;
    if (details?.requestId && details?.epoch) return { requestId: details.requestId, jobId: details.jobId ?? this.attempts.get(details.requestId)?.jobId ?? null, epoch: details.epoch };
    if (entry.type === 'message' && entry.message?.role === 'user') return { requestId: null, jobId: null, epoch: this.guest.epoch };
    return this.identities.get(entry.parentId) ?? (await this.stored(entry.parentId))?.identity ?? { requestId: null, jobId: null, epoch: this.guest.epoch };
  }
  collectAnswer(entry, identity) {
    // Replayed disk entries remain historical evidence, never a new turn answer.
    if (this.snapshotting) return;
    if (identity.epoch && identity.epoch !== (this.epoch ?? this.guest?.epoch)) return;
    if (!identity.requestId || entry.type !== 'message' || entry.message?.role !== 'assistant') return;
    this.answerState ??= { requestId: identity.requestId, text: '', bytes: 0 };
    const answer = this.answerState;
    if (answer.requestId !== identity.requestId || answer.overflow) return;
    const content = entry.message.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';
    const addition = (answer.text ? '\n' : '') + text;
    answer.bytes += Buffer.byteLength(addition);
    if (answer.bytes > ANSWER_BYTES) { answer.text = ''; answer.overflow = true; }
    else answer.text += addition;
  }
  async receive(frame) {
    if (frame.t === 'nozeli-entry-part') {
      if (!this.parts) this.parts = { id: frame.id, index: 0, bytes: 0, chunks: [] };
      const parts = this.parts;
      if (parts.id !== frame.id || parts.index++ !== frame.index || typeof frame.data !== 'string') throw Error('native-entry-chunk-order');
      const chunk = Buffer.from(frame.data, 'base64');
      if (chunk.toString('base64') !== frame.data || (parts.bytes += chunk.length) > 64 * 1024 * 1024) throw Error('native-entry-chunk-budget');
      parts.chunks.push(chunk);
      if (!frame.final) return;
      const entry = JSON.parse(Buffer.concat(parts.chunks).toString('utf8')); this.parts = null;
      if (entry.id !== frame.id || typeof entry.id !== 'string') throw Error('native-entry-identity');
      const entryHash = canonicalNativeEntryDigest(entry);
      const stored = this.entries.has(entry.id) ? null : await this.stored(entry.id);
      const previous = this.entries.get(entry.id) ?? (stored && canonicalNativeEntryDigest(stored.entry));
      if (previous && previous !== entryHash) throw Error('native-entry-mutated');
      // An archive proves immutable evidence, not successful consumer persistence.
      // Retry only the exact entry projection; never resend a model request.
      if (this.entries.has(entry.id) || stored?.projected === true || this.snapshot.some(fact => fact.entry.id === entry.id)) return;
      const identity = stored?.identity ?? await this.identity(entry);
      if (this.evidenceRoot && !stored) await fs.writeFile(path.join(this.evidenceRoot, hash(entry.id) + '.json'), JSON.stringify({ hash: entryHash, identity, entry, projected: false }), { flag: 'wx', mode: 0o600 });
      this.remember(this.identities, entry.id, identity);
      const fact = { sessionId: this.sessionId, ...identity, streamId: frame.streamId ?? null, entry };
      if (this.snapshotting) {
        this.snapshot.push(fact); this.snapshotBytes = (this.snapshotBytes ?? 0) + parts.bytes;
        if (this.snapshot.length >= 128 || this.snapshotBytes >= 1024 * 1024) await this.flushSnapshot();
      } else {
        await this.onEntry?.(fact);
        await this.projected(fact);
        this.collectAnswer(entry, identity);
      }
    } else if (frame.t === 'snapshot-chunk' && frame.final) {
      if (this.parts) throw Error('native-entry-truncated');
      await this.flushSnapshot(); this.snapshotting = false;
    } else if (frame.t === 'action-receipt') {
      const attempt = this.attempts.get(frame.rid);
      if (!attempt || frame.ep !== attempt.epoch || frame.kind !== attempt.kind || frame.ar !== attempt.nonce) throw Error('collab-receipt-identity');
      if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) throw Error('collab-receipt-sequence');
      if (!['pending', 'admitted', 'executed', 'rejected', 'unknown'].includes(frame.status)) throw Error('collab-receipt-status');
      if (attempt.sequence !== undefined && frame.seq < attempt.sequence) return;
      if (frame.seq === attempt.sequence) {
        if (attempt.receiptStatus !== frame.status || attempt.receiptReason !== frame.reason) throw Error('collab-receipt-mutated');
        return; // An explicit query may return the same retained receipt.
      }
      if (attempt.status !== 'settled') await this.fact(attempt, frame.status, frame.reason, frame.seq);
      attempt.sequence = frame.seq; attempt.receiptStatus = frame.status; attempt.receiptReason = frame.reason;
      if (frame.status === 'admitted' || frame.status === 'executed') attempt.resolve({ collab: { sessionId: this.sessionId, epoch: attempt.epoch, requestId: attempt.requestId } });
      else if (['rejected', 'unknown'].includes(frame.status)) attempt.reject(errorWith(frame.reason ?? frame.status, frame.status === 'unknown' ? 'OMP_COLLAB_UNKNOWN' : 'OMP_COLLAB_REJECTED'));
    } else if (frame.t === 'nozeli-event') {
      const identity = this.attempts.get(frame.requestId);
      if (identity && identity.epoch !== frame.epoch) throw Error('collab-event-epoch-mismatch');
      await this.onEvent?.({ sessionId: this.sessionId, epoch: frame.epoch, requestId: frame.requestId, jobId: identity?.jobId ?? this.manual?.get(frame.requestId) ?? null, streamId: frame.streamId, seq: frame.seq, event: frame.event });
    } else if (frame.t === 'nozeli-sync') {
      this.syncWaiters?.get(frame.nonce)?.(); this.syncWaiters?.delete(frame.nonce);
    }
  }
  async projected(fact) {
    const entryHash = canonicalNativeEntryDigest(fact.entry);
    if (this.evidenceRoot) {
      const evidence = await this.stored(fact.entry.id);
      if (!evidence || canonicalNativeEntryDigest(evidence.entry) !== entryHash) throw Error('native-entry-mutated');
      await writeAtomicJson(path.join(this.evidenceRoot, hash(fact.entry.id) + '.json'), { ...evidence, projected: true });
    }
    this.remember(this.entries, fact.entry.id, entryHash);
  }
  async flushSnapshot() {
    if (!this.snapshot.length) return;
    const entries = this.snapshot;
    await this.onEntry?.({ sessionId: this.sessionId, epoch: this.guest.epoch, entries });
    for (const fact of entries) await this.projected(fact);
    this.snapshot = []; this.snapshotBytes = 0;
  }
  async fact(attempt, status, reason, seq) {
    try {
      await this.onFact?.({ jobId: attempt.jobId, sessionId: this.sessionId, epoch: attempt.epoch, requestId: attempt.requestId, attempt: attempt.attempt, status, reason, kind: attempt.kind, contentDigest: attempt.contentDigest, ...(seq === undefined ? {} : { seq }) });
    } catch (error) { throw this.failHold(error); }
    attempt.status = status;
  }
  bindManual(requestId, jobId) {
    this.manual ??= new Map();
    if (this.manual.has(requestId) && this.manual.get(requestId) !== jobId) throw Error('collab-manual-binding-conflict');
    if (!this.manual.has(requestId) && this.manual.size >= LIMIT) throw Error('collab-manual-binding-capacity');
    this.manual.set(requestId, jobId);
    this.answerState = { requestId, text: '', bytes: 0 };
  }
  async check(job, kind, attempt) {
    if (this.closed || this.hold || this.guest?.failure) throw this.hold ?? this.guest?.failure ?? Error('collab-closed');
    if (attempt?.cancelled) throw errorWith('collab-request-cancelled', 'OMP_COLLAB_NOT_SUBMITTED');
    const state = kind === 'prompt' ? await this.nativeState() : null;
    if (kind === 'prompt' && (state?.editorDraft?.known !== true || state.editorDraft.hasText !== false)) throw errorWith('native editor draft is not empty/known', 'NATIVE_DRAFT_PENDING');
    const eligibility = await this.eligibility?.(job, kind);
    if (eligibility?.scopeAllowed !== true || eligibility.hostAdmitted !== true || (kind === 'prompt' && eligibility.workOpen !== true)) throw errorWith('collab-current-ticket-ineligible', 'OMP_COLLAB_NOT_SUBMITTED');
    if (attempt?.cancelled || this.closed || this.hold) throw this.hold ?? errorWith('collab-request-cancelled', 'OMP_COLLAB_NOT_SUBMITTED');
    return { ...eligibility, nativeDraft: state?.editorDraft };
  }
  failHold(cause) { this.hold ??= Object.assign(errorWith('collab-hold: ' + cause.message, 'OMP_COLLAB_HOLD'), { cause }); return this.hold; }
  async dispatch(text, images, job, kind = 'prompt', targetTurn = null) {
    if (!job?.id) throw Error('collab-durable-job-required');
    if (!['prompt', 'abort'].includes(kind)) throw Error('collab-invalid-action');
    const target = kind === 'abort' ? this.attempts.get(targetTurn) : null;
    if (kind === 'abort' && (!target || target.jobId !== job.id || target.ownerId !== this.context.ownerId || target.epoch !== this.epoch || target.kind !== 'prompt')) throw Error('collab-abort-target-mismatch');
    if (kind === 'prompt' && this.dispatching) throw errorWith('collab-dispatch-busy', 'OMP_COLLAB_NOT_SUBMITTED');
    if (kind === 'prompt') this.dispatching = true;
    let attempt, handedOff = false;
    try {
      const generation = this.guest.generation, epoch = this.epoch;
      const eligibility = await this.check(job, kind);
      // Never evict unresolved attribution. Capacity pressure holds new work instead.
      if (this.attempts.size >= LIMIT) throw Error('collab-attempt-capacity');
      this.attemptSequence = (this.attemptSequence ?? 0) + 1;
      attempt = { jobId: job.id, ownerId: this.context.ownerId, requestId: randomUUID(), nonce: randomBytes(32).toString('hex'), attempt: this.attemptSequence, epoch, kind, contentDigest: digest(epoch, kind, text, images, targetTurn) };
      const admitted = new Promise((resolve, reject) => { attempt.resolve = resolve; attempt.reject = reject; }); admitted.catch(() => {});
      this.attempts.set(attempt.requestId, attempt);
      if (kind === 'prompt') this.answerState = { requestId: attempt.requestId, text: '', bytes: 0 };
      try { await this.fact(attempt, 'prepared'); } catch (error) { throw this.failHold(error); }
      try {
        await this.grants.issue({ jobId: job.id, rid: attempt.requestId, nonce: attempt.nonce, kind, attempt: attempt.attempt, binding: { ...this.context, sessionId: this.sessionId, epoch }, contentDigest: attempt.contentDigest, targetTurn, expiresAt: Date.now() + 30000, eligibility });
      } catch (error) { throw this.failHold(error); }
      const refs = images.length ? await this.guest.upload(images) : [];
      try { await this.fact(attempt, 'submitted'); } catch (error) { throw this.failHold(error); }
      await this.guest.send({ t: kind, rid: attempt.requestId, at: attempt.attempt, ep: epoch, ar: attempt.nonce, dg: attempt.contentDigest, ...(kind === 'prompt' ? { text, refs } : { tr: targetTurn }) }, generation, {
        beforeSend: async () => { await this.check(job, kind, attempt); },
        onHandoff: () => {
          if (attempt.cancelled || this.closed || this.hold) throw this.hold ?? errorWith('collab-request-cancelled', 'OMP_COLLAB_NOT_SUBMITTED');
          handedOff = true; attempt.handedOff = true;
        },
      });
      let timer;
      try { return await Promise.race([admitted, new Promise((_, reject) => { timer = setTimeout(() => reject(errorWith('collab-admission-timeout', 'OMP_COLLAB_UNKNOWN')), 30000); })]); }
      finally { clearTimeout(timer); }
    } catch (error) {
      if (!attempt) throw error;
      let failure = error;
      // Includes partial issue/publication and prepared callback failures.
      try { await this.grants.revoke(attempt.nonce, 'dispatch-unresolved'); } catch (cause) { failure = this.failHold(cause); }
      if (attempt.status !== 'rejected') {
        try { await this.fact(attempt, handedOff ? 'unknown' : 'rejected', handedOff ? 'dispatch-unresolved' : 'not-submitted'); }
        catch (cause) { failure = this.failHold(cause); }
      }
      if (failure.code !== 'OMP_COLLAB_HOLD') failure = Object.assign(errorWith(failure.message, handedOff ? 'OMP_COLLAB_UNKNOWN' : (failure.code ?? 'OMP_COLLAB_NOT_SUBMITTED')), { cause: failure });
      attempt.reject(failure);
      throw failure;
    } finally { if (kind === 'prompt') this.dispatching = false; }
  }
  async cancel(job, requestId) {
    const target = this.attempts.get(requestId);
    if (!target || target.jobId !== job?.id || target.ownerId !== this.context.ownerId || target.kind !== 'prompt') throw Error('collab-abort-target-mismatch');
    target.cancelled = true;
    try { await this.grants.revokeJob(job.id, 'user-cancelled'); } catch (error) { throw this.failHold(error); }
    // An explicitly unsubmitted request needs no native abort; no new request is sent.
    if (!target.handedOff) return { notSubmitted: true };
    return this.dispatch('', [], job, 'abort', requestId);
  }
  async query(requestId) { if (!this.attempts.has(requestId)) throw Error('unknown-request'); await this.guest.send({ t: 'action-query', rid: requestId, ep: this.epoch }); }
  diagnostics() { return this.guest?.diagnostics?.() ?? null; }
  async settled(requestId, evidence) {
    const attempt = this.attempts.get(requestId);
    if (!attempt || attempt.kind !== 'prompt' || attempt.epoch !== this.epoch || evidence?.sessionId !== this.sessionId || evidence.epoch !== attempt.epoch || evidence.requestId !== requestId || evidence.agentEnd !== true || evidence.idle !== true || evidence.noPending !== true) throw Error('collab-settlement-identity');
    if (attempt.status === 'settled') return;
    if (!attempt.handedOff || !['admitted', 'executed'].includes(attempt.status)) throw Object.assign(Error('collab-settlement-status'), { diagnostics: this.diagnostics() });
    await this.fact(attempt, 'settled', 'agent-end-idle-no-pending');
  }
  async lost() {
    for (const attempt of this.attempts.values()) if (attempt.handedOff && !['rejected', 'executed', 'unknown', 'settled'].includes(attempt.status)) {
      const diagnostics = this.diagnostics();
      const reason = 'transport-lost' + (diagnostics ? ': ' + JSON.stringify(diagnostics) : '');
      try { await this.grants.revoke(attempt.nonce, 'transport-lost'); await this.fact(attempt, 'unknown', reason); }
      catch (error) { this.failHold(error); }
      attempt.reject(this.hold ?? errorWith('collab-disconnected', 'OMP_COLLAB_UNKNOWN'));
    }
    if (this.hold) throw this.hold;
  }
  async drain() {
    if (this.guest?.ws?.readyState === 1 && !this.guest.hostEnded) {
      this.syncWaiters ??= new Map(); const nonce = randomUUID(); let timer;
      const barrier = new Promise((resolve, reject) => { this.syncWaiters.set(nonce, resolve); timer = setTimeout(() => reject(Error('collab-drain-timeout')), 8000); });
      try {
        try { await this.guest.send({ t: 'nozeli-sync', nonce }); }
        catch (error) { if (error.code !== 'OMP_COLLAB_EOF') throw error; }
        await Promise.race([barrier, ...(this.guest.ended ? [this.guest.ended] : [])]);
      } finally { clearTimeout(timer); this.syncWaiters.delete(nonce); }
    }
    await this.guest?.drain();
    if (this.parts) throw Error('native-entry-truncated');
    await this.flushSnapshot();
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const failures = [];
      // Session drains the live host before shutdown. Here only accepted local
      // callbacks remain: sending a sync to an exited host cannot prove anything.
      const steps = [
        ['guest-close', () => this.guest?.close()],
        ['journal-drain', () => this.guest?.drain()],
        ['entry-integrity', () => { if (this.parts) throw Error('native-entry-truncated'); }],
        ['snapshot-persistence', () => this.flushSnapshot()],
        ['grant-revocation', () => this.grants?.revokeOwner(this.context.ownerId, 'runtime-closed')],
        ['grant-close', () => this.grants?.close()],
        ['relay-close', () => this.relay?.close()],
      ];
      const priorHold = this.hold;
      if (priorHold) failures.push(priorHold);
      this.closeReport = { stages: [], recoverySafe: false, priorHold: priorHold ? failureCategory(priorHold.cause ?? priorHold) : null };
      for (const [stage, operation] of steps) {
        try { await operation(); this.closeReport.stages.push({ stage, ok: true }); }
        catch (error) {
          failures.push(error);
          // Only a transport error in socket cleanup can be superseded by a
          // successful local journal drain. Never classify arbitrary callbacks,
          // authentication errors or disk failures by their message text.
          const transport = stage === 'guest-close' && ['OMP_COLLAB_EOF', 'ECONNRESET', 'EPIPE'].includes(error.code);
          this.closeReport.stages.push({ stage, ok: false, category: transport ? 'transport' : stage, failure: failureCategory(error) });
        }
      }
      this.closeReport.recoverySafe = Boolean(this.guest && this.grants && this.relay) && this.snapshotting === false && !priorHold && !this.guest?.failure && this.closeReport.stages.every(result => result.ok || result.category === 'transport');
      if (failures.length) {
        const error = this.failHold(new AggregateError(failures, 'collab-close-failed'));
        error.closeReport = this.closeReport;
        throw error;
      }
    })();
    return this.closePromise;
  }
  answer(requestId) {
    if (this.answerState?.requestId !== requestId) throw Error('collab-answer-not-current-use-durable-index');
    if (this.answerState.overflow) throw errorWith('collab-answer-over-budget-use-durable-index', 'OMP_COLLAB_ANSWER_LIMIT');
    return this.answerState.text;
  }
}
