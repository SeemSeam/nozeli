/**
 * Nozeli-authored. Bounded, sanitized provider HTTP observer for the Pi
 * owner process. Wraps global fetch ONCE and keeps a small ring of response
 * observations: origin + pathname + method + status + timing ONLY.
 *
 * No query strings, no headers, no request/response bodies, no credentials
 * and no error message text ever enter the ring. The record exists so a
 * provider failure can carry REAL transport evidence (for example the HTTP
 * 402 of a balance refusal) instead of a message-text guess. Observer faults
 * never break the wrapped fetch.
 *
 * Per-turn correlation: an AsyncLocalStorage scope, entered around one
 * owner-turn's native inference request, tags that turn's observations with
 * an OPAQUE context id (a host-generated UUID — never a URL, credential or
 * user text). Rows recorded outside any scope stay untagged, so concurrent
 * traffic of other endpoints/sources can be excluded by identity, not by
 * guessing from an origin cluster.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const MAX_RING = 32;
const MAX_PATH_CHARS = 200;
const MAX_METHOD_CHARS = 16;
const CONTEXT_ID = /^[A-Za-z0-9:_-]{1,64}$/;

let installed = false;
let seq = 0;
const ring = [];

const correlation = new AsyncLocalStorage();

/** Opaque per-turn inference correlation id, or null outside a scope. */
export function currentHttpCorrelation() {
  const id = correlation.getStore();
  return typeof id === "string" && CONTEXT_ID.test(id) ? id : null;
}

/** Run fn with every observed fetch inside tagged with the opaque context id. */
export function runWithHttpCorrelation(contextId, fn) {
  if (typeof contextId !== "string" || !CONTEXT_ID.test(contextId) || typeof fn !== "function") {
    return fn();
  }
  return correlation.run(contextId, fn);
}

const NETWORK_CODE = /^[A-Z0-9_]{1,32}$/;

const networkCodeOf = error =>
  typeof error?.code === "string" && NETWORK_CODE.test(error.code) ? error.code : null;

function targetOf(input, init) {
  try {
    // The fetch API allows string | URL | Request. A Request carries its own
    // url/method; only those identity fields are read — never body, headers
    // or credentials — and the wrapped call forwards the original arguments
    // verbatim, so any Request signal/abort semantics are preserved.
    let url = null;
    if (typeof input === "string") url = new URL(input);
    else if (input instanceof URL) url = new URL(input.href);
    else if (typeof Request === "function" && input instanceof Request) url = new URL(input.url);
    if (!url || !["http:", "https:"].includes(url.protocol)) return null;
    const rawMethod = init?.method ?? (input && typeof input === "object" ? input.method : undefined);
    const method = String(rawMethod ?? "GET").toUpperCase();
    if (!/^[A-Z]{1,16}$/.test(method)) return null;
    return { origin: url.origin, pathname: url.pathname.slice(0, MAX_PATH_CHARS), method };
  } catch {
    return null;
  }
}

function record(observation) {
  const context = currentHttpCorrelation();
  ring.push({ seq: (seq += 1), ...(context ? { context } : {}), ...observation });
  if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING);
}

/** Idempotent install; safe to call from any owner entrypoint. */
export function installProviderHttpObserver() {
  if (installed || typeof globalThis.fetch !== "function") return;
  installed = true;
  const original = globalThis.fetch;
  globalThis.fetch = async function observedFetch(input, init) {
    const target = targetOf(input, init);
    const startedAt = Date.now();
    if (!target) return original.call(this, input, init);
    try {
      const response = await original.call(this, input, init);
      if (response && Number.isSafeInteger(response.status)) {
        record({ ...target, status: response.status, at: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt });
      }
      return response;
    } catch (error) {
      // undici wraps transport failures (TypeError "fetch failed") with the
      // real code on error.cause; probe it through a bounded two-hop chain.
      const networkCode = networkCodeOf(error) ?? networkCodeOf(error?.cause) ?? networkCodeOf(error?.cause?.cause);
      if (networkCode) record({ ...target, status: null, networkCode, at: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt });
      throw error;
    }
  };
}

/** Bounded sanitized recent observations strictly after sinceSeq. */
export function providerHttpObservations({ sinceSeq = 0, max = 8 } = {}) {
  const limit = Math.max(1, Math.min(max, 16));
  return ring
    .filter(row => row.seq > sinceSeq)
    .slice(-limit)
    .map(row => ({
      seq: row.seq,
      ...(typeof row.context === "string" && CONTEXT_ID.test(row.context) ? { context: row.context } : {}),
      origin: row.origin,
      pathname: row.pathname,
      method: row.method,
      status: Number.isSafeInteger(row.status) ? row.status : null,
      ...(row.networkCode ? { networkCode: row.networkCode } : {}),
      at: row.at,
      durationMs: Number.isSafeInteger(row.durationMs) ? row.durationMs : null,
    }));
}

/** Current ring sequence, for windowed queries across an owner turn. */
export function providerHttpObserverSeq() {
  return seq;
}
