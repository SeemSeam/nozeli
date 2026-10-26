'use strict';

// Test-only preload: observe every Node child_process API and fail closed for
// non-loopback Node networking before the Electron main entry is evaluated.
const childProcess = require('node:child_process');
const diagnostics = require('node:diagnostics_channel');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const {syncBuiltinESMExports} = require('node:module');
const net = require('node:net');
const tls = require('node:tls');
const {promisify} = require('node:util');

const output = process.env.NOZELI_GUIDED_DEMO_OBSERVER;
const loopback = host => {
  const value = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value.startsWith('127.');
};
const record = value => {
  if (!output) throw Error('NOZELI_GUIDED_DEMO_OBSERVER is required');
  try { fs.appendFileSync(output, JSON.stringify({time: new Date().toISOString(), pid: process.pid, ...value}) + '\n', {mode: 0o600}); }
  catch (error) { process.stderr.write(`GUIDED_DEMO_OBSERVER_FAILURE ${error.stack || error}\n`); throw error; }
};
const command = (file, args) => [file, ...(Array.isArray(args) ? args : [])].map(String);
function preservePromiseContract(original, observed, name, describe) {
  for (const symbol of Object.getOwnPropertySymbols(original)) {
    const descriptor = Object.getOwnPropertyDescriptor(original, symbol);
    if (symbol === promisify.custom) descriptor.value = function (...args) {
      record({type:'child', method:name, command:describe(args)});
      return original[symbol].apply(this,args);
    };
    Object.defineProperty(observed,symbol,descriptor);
  }
  return observed;
}

for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = preservePromiseContract(original, function observed(file, args, ...rest) {
    record({type: 'child', method: name, command: command(file, args)});
    return original.call(this, file, args, ...rest);
  }, name, args=>command(args[0],args[1]));
}
for (const name of ['exec', 'execSync']) {
  const original = childProcess[name];
  childProcess[name] = preservePromiseContract(original, function observed(value, ...rest) {
    record({type: 'child', method: name, command: [String(value)]});
    return original.call(this, value, ...rest);
  }, name, args=>[String(args[0])]);
}
// Refresh already-loaded ESM named exports such as import {spawn}.
syncBuiltinESMExports();

function destination(args) {
  const first = args[0];
  if (first instanceof URL) return first.hostname;
  if (typeof first === 'object' && first) return first.hostname || first.host;
  if (typeof first === 'string' && /^https?:\/\//i.test(first)) {
    try { return new URL(first).hostname; } catch { return first; }
  }
  if (typeof first === 'string' && typeof args[1] === 'number') return first;
  if (typeof first === 'number' && typeof args[1] === 'string') return args[1];
  return null;
}
function deny(type, args) {
  const host = destination(args);
  if (!host || loopback(host)) return;
  record({type: 'network', api: type, host: String(host), blocked: true});
  throw Object.assign(Error(`Guided demo live test blocked external network: ${host}`), {code: 'NOZELI_TEST_EXTERNAL_NETWORK'});
}
for (const [owner, names] of [[net, ['connect', 'createConnection']], [tls, ['connect']], [http, ['request', 'get']], [https, ['request', 'get']]]) {
  for (const name of names) {
    const original = owner[name];
    owner[name] = function observed(...args) {
      deny(`${owner === https ? 'https' : owner === http ? 'http' : owner === tls ? 'tls' : 'net'}.${name}`, args);
      return original.apply(this, args);
    };
  }
}
syncBuiltinESMExports();

// diagnostics_channel observes alternate Undici clients. It cannot cancel, so
// any such external event is evidence failure even when it bypasses fetch.
diagnostics.channel('undici:request:create').subscribe(message => {
  const origin = message?.request?.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).hostname; } catch { host = origin; }
  if (!loopback(host)) record({type: 'network', api: 'undici:request:create', host: String(host), blocked: false});
});
if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function observedFetch(input, ...rest) {
    let host;
    try { host = new URL(typeof Request !== 'undefined' && input instanceof Request ? input.url : input).hostname; } catch { host = null; }
    if (host && !loopback(host)) {
      record({type: 'network', api: 'fetch', host: String(host), blocked: true});
      return Promise.reject(Object.assign(Error(`Guided demo live test blocked external fetch: ${host}`), {code: 'NOZELI_TEST_EXTERNAL_NETWORK'}));
    }
    return originalFetch.call(this, input, ...rest);
  };
}
record({type: 'observer-ready'});
