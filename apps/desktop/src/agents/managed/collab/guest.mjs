import { WebSocket } from 'ws';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { MAX_RELAY_FRAME } from './local-relay.mjs';

export function sealFrame(key, frame, iv = randomBytes(12)) {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([Buffer.alloc(4), iv, cipher.update(JSON.stringify(frame)), cipher.final(), cipher.getAuthTag()]);
}
export function openFrame(key, data) {
  if (data.length < 32 || data.length > MAX_RELAY_FRAME || data.readUInt32BE(0) !== 0) throw Error('invalid-host-envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
  decipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(16, -16)), decipher.final()]).toString('utf8'));
}
/** No automatic reconnect or application replay. Every send is generation-fenced. */
export class ManagedCollabGuest {
  constructor({ capability, onFrame, onLost }) {
    this.capability = capability; this.onFrame = onFrame; this.onLost = onLost; this.generation = 0; this.chain = Promise.resolve();
    this.seenNonces = new Set(); this.noncePrefix = randomBytes(8); this.nonceCounter = 0;
    this.ended = new Promise(resolve => { this.resolveEnd = resolve; });
  }
  async connect(link) {
    if (this.ws) throw Error('collab-reconnect-disabled');
    const url = new URL(link), split = url.pathname.lastIndexOf('.');
    if (split < 0 || url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') throw Error('invalid-private-collab-link');
    const secret = Buffer.from(url.pathname.slice(split + 1), 'base64url');
    if (secret.length !== 48) throw Error('invalid-private-collab-secret');
    this.key = secret.subarray(0, 32); this.writeToken = secret.subarray(32).toString('base64url');
    url.pathname = url.pathname.slice(0, split); url.searchParams.set('role', 'guest'); url.searchParams.set('cap', this.capability);
    const generation = ++this.generation;
    const ws = this.ws = new WebSocket(url, { maxPayload: MAX_RELAY_FRAME, perMessageDeflate: false });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; }); this.ready.catch(() => {});
    ws.on('message', (data, binary) => {
      if (generation !== this.generation) return;
      if (!binary) return;
      this.chain = this.chain.then(async () => {
        // Frames accepted by the socket before close still belong to this generation.
        // Drain them even after the close event increments the send fence.
        const nonce = data.subarray(4, 16).toString('hex');
        if (this.seenNonces.has(nonce)) throw Error('collab-frame-replay');
        if (this.seenNonces.size >= 262144) throw Error('collab-replay-window-exhausted');
        const frame = openFrame(this.key, data);
        this.lastFrame = { type: frame.t, ...(frame.t === 'nozeli-entry-part' ? { entryId: frame.id, index: frame.index, final: frame.final } : {}), ...(frame.t === 'nozeli-event' ? { eventType: frame.event?.type } : {}) };
        this.seenNonces.add(nonce);
        if (frame.t === 'welcome') {
          if (frame.nozeli?.managedCollab !== 1 || frame.nozeli.admission !== 'rid-required' || frame.readOnly) throw Error('managed-collab-not-negotiated');
          this.epoch = frame.nozeli.epoch; this.sessionId = frame.header.id;
        }
        if (frame.t === 'bye') { this.hostEnded = true; this.resolveEnd(); }
        await this.onFrame(frame);
        if (frame.t === 'snapshot-chunk' && frame.final) this.resolveReady();
      }).catch(error => { this.failure ??= error; this.rejectReady(error); ws.terminate(); });
    });
    ws.on('close', (code, reason) => {
      if (generation !== this.generation) return;
      // Do not retain arbitrary peer text: close reasons may contain private data.
      const text = reason.toString();
      this.disconnect = { code, reason: ['backpressure', 'idle timeout', 'ping timeout'].includes(text) ? text : text ? 'peer-reason-redacted' : '', local: !!this.closing, at: new Date().toISOString() };
      this.generation++; this.hostEnded = true; this.resolveEnd(); this.rejectReady(Error('collab-disconnected'));
      this.chain = this.chain.then(() => this.onLost?.()).catch(error => { this.failure ??= error; });
    });
    ws.on('error', error => this.rejectReady(error));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(Error('collab-closed-before-open'))); });
    await this.send({ t: 'hello', name: 'Nozeli', proto: 3, writeToken: this.writeToken });
    let timer; try { await Promise.race([this.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('collab-snapshot-timeout')), 30000); })]); } finally { clearTimeout(timer); }
  }
  async send(frame, generation = this.generation, { beforeSend, onHandoff } = {}) {
    if (this.failure) throw this.failure;
    if (this.hostEnded) throw Object.assign(Error('collab-host-ended'), { code: 'OMP_COLLAB_EOF' });
    if (this.closing) throw Error('collab-closed');
    if (this.nonceCounter >= 0xffffffff) throw Error('collab-nonce-exhausted');
    const iv = Buffer.alloc(12); this.noncePrefix.copy(iv); iv.writeUInt32BE(this.nonceCounter++, 8);
    const data = sealFrame(this.key, frame, iv);
    if (data.length > MAX_RELAY_FRAME) throw Error('collab-frame-over-budget');
    while (this.ws.bufferedAmount > 65536) {
      if (this.ws.readyState !== WebSocket.OPEN || generation !== this.generation) throw Error('collab-generation-lost');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await beforeSend?.();
    if (this.failure) throw this.failure;
    if (this.closing || this.ws.readyState !== WebSocket.OPEN || generation !== this.generation) throw Error('collab-generation-lost');
    await new Promise((resolve, reject) => {
      // From here on a socket error cannot prove non-delivery.
      onHandoff?.();
      this.ws.send(data, { binary: true }, error => error ? reject(error) : resolve());
    });
  }
  async upload(images) {
    const generation = this.generation, refs = [];
    for (const image of images) {
      const up = randomBytes(16).toString('hex'); refs.push(up);
      await this.send({ t: 'attach-open', up, ep: this.epoch, mime: image.mimeType }, generation);
      for (let offset = 0; offset < image.data.length; offset += 512 * 1024) await this.send({ t: 'attach-chunk', up, ep: this.epoch, data: image.data.slice(offset, offset + 512 * 1024) }, generation);
      await this.send({ t: 'attach-close', up, ep: this.epoch }, generation);
    }
    return refs;
  }
  diagnostics() {
    const categories = ['collab-frame-replay', 'collab-replay-window-exhausted', 'collab-receipt-identity', 'collab-receipt-sequence', 'collab-receipt-status', 'collab-receipt-mutated', 'collab-event-epoch-mismatch', 'native-entry-mutated', 'native-entry-truncated', 'native-entry-chunk-order', 'native-entry-chunk-budget', 'native-entry-identity', 'invalid-host-envelope'];
    const codes = ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'ECONNRESET', 'EPIPE', 'OMP_COLLAB_HOLD'];
    return { disconnect: this.disconnect ?? null, lastFrame: this.lastFrame ?? null, failure: this.failure ? { name: ['Error', 'TypeError', 'SyntaxError', 'AggregateError'].includes(this.failure.name) ? this.failure.name : 'Error', code: codes.includes(this.failure.code) ? this.failure.code : null, category: categories.includes(this.failure.message) ? this.failure.message : 'callback-or-authentication-failed' } : null };
  }
  async drain() {
    // Close can append lost/persistence work while a preceding callback awaits I/O.
    let chain;
    do { chain = this.chain; await chain; } while (chain !== this.chain);
    if (this.failure) throw this.failure;
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      // Terminate first, then await close and the chain it appends. Never wipe a
      // key while an already accepted encrypted callback still needs it.
      if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
        const closed = new Promise(resolve => this.ws.once('close', resolve));
        this.ws.terminate(); await closed;
      }
      try { await this.drain(); }
      finally { this.generation++; this.key?.fill(0); this.writeToken = null; this.seenNonces.clear(); }
    })();
    return this.closePromise;
  }
}
