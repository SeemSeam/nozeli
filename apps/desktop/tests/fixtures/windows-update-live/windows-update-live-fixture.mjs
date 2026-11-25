// Shared utilities for desktop-auto-update-windows-live.mjs only. Nothing here
// is product code: a deterministic forward-slash ZIP writer (so the archive
// consumer sees a standard, reproducible Windows x64 package), a GitHub-shaped
// loopback feed/tag/checksum server with request counters, Windows process
// lookup/termination by executable path under a root, and a tolerant scan of
// updater attempt records in the installed profile's updates directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? ((value >>> 1) ^ 0xedb88320) : (value >>> 1);
    table[index] = value;
  }
  return table;
})();
const crc32 = bytes => {
  let crc = -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
};
const dosTime = date => ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
const dosDate = date => (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;

// Deterministic release layout, UTF-8, fixed mtime, deflate when smaller.
// No data descriptors, extra fields or ZIP64.
export async function zipDirectory(directory, {label = path.basename(directory), at = new Date('2026-11-18T00:00:00Z')} = {}) {
  const files = [];
  const walk = async (current, prefix) => {
    files.push({name: prefix, directory: true});
    for (const row of (await fs.readdir(current, {withFileTypes: true})).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (row.isDirectory()) await walk(path.join(current, row.name), prefix + row.name + '/');
      else if (row.isFile()) files.push({name: prefix + row.name, file: path.join(current, row.name)});
      else throw Error('Unsupported payload member for ZIP: ' + prefix + row.name);
    }
  };
  await walk(directory, label + '/');
  const chunks = [], central = [];
  let offset = 0;
  for (const entry of files) {
    const raw = entry.directory ? Buffer.alloc(0) : await fs.readFile(entry.file);
    const deflated = entry.directory ? raw : zlib.deflateRawSync(raw, {level: 6});
    const method = deflated.length < raw.length ? 8 : 0;
    const payload = method === 8 ? deflated : raw;
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(dosTime(at), 10); local.writeUInt16LE(dosDate(at), 12);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, name, payload);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10); header.writeUInt16LE(dosTime(at), 12); header.writeUInt16LE(dosDate(at), 14);
    header.writeUInt32LE(crc32(raw), 16); header.writeUInt32LE(payload.length, 20); header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt16LE(0, 30); header.writeUInt16LE(0, 32); header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36); header.writeUInt32LE(0, 38); header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + payload.length;
  }
  const directory_ = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory_.length, 12); end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...chunks, directory_, end]);
  if (offset + directory_.length + 22 >= 0xffffffff) throw Error('ZIP64 required; payload too large');
  return archive;
}

// Loopback release endpoint: GitHub releases shape, tag peel API, checksum
// manifest and archive bytes, with per-endpoint request counters so journeys
// can prove whether the updater actually re-fetched an asset.
export async function createFeedServer({archive, version, commit}) {
  const state = {archive, version, commit, serve: null};
  const counters = {feed: 0, tag: 0, sums: 0, archive: 0};
  const checksum = () => createHash('sha256').update(state.archive).digest('hex');
  const name = () => 'Nozeli-' + state.version + '-windows-x64.zip';
  let ready;
  const gate = new Promise(resolve => { ready = resolve; });
  const server = http.createServer((request, response) => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      const pathname = request.url.split('?')[0];
      if (pathname === '/releases') {
        counters.feed++;
        void gate.then(() => response.end(JSON.stringify([{tag_name: 'v' + state.version, prerelease: /^\d+\.\d+\.\d+-/.test(state.version), assets: [
          {name: name(), size: (state.serve ?? state.archive).length, browser_download_url: origin + '/archive'},
          {name: 'SHA256SUMS.txt', size: 160, browser_download_url: origin + '/sums'},
        ]}])));
      } else if (pathname === '/git/ref/tags/v' + state.version) {
        counters.tag++;
        response.end(JSON.stringify({ref: 'refs/tags/v' + state.version, object: {type: 'commit', sha: state.commit}}));
      } else if (pathname === '/sums') {
        counters.sums++;
        response.end(checksum() + '  ' + name() + '\n');
      } else if (pathname === '/archive') {
        counters.archive++;
        const bytes = state.serve ?? state.archive;
        response.setHeader('Content-Length', bytes.length);
        response.end(bytes);
      } else { response.statusCode = 404; response.end(); }
    } catch (error) { response.statusCode = 500; response.end(String(error?.message || error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    server, counters,
    url: 'http://127.0.0.1:' + server.address().port + '/releases',
    releaseFeed: gate,
    setPayload(next) { Object.assign(state, next, {serve: null}); ready(); ready = () => {}; },
    // Serve bytes that differ from the checksum manifest's archive (tamper
    // refusal journeys) without touching the declared checksum.
    serve(bytes) { state.serve = bytes; },
    close: () => new Promise(resolve => server.close(resolve)),
    release() { ready(); ready = () => {}; },
  };
}

// Real Windows process facts via CIM: executable paths under a root, so the
// driver only ever touches processes it owns (its own installed trees).
export async function processesUnder(root) {
  const escaped = (path.resolve(root) + path.sep).toLowerCase().replace(/'/g, "''");
  const script = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter "ExecutablePath IS NOT NULL" | Where-Object { $_.ExecutablePath.ToLower().StartsWith('${escaped}') } | ForEach-Object { "{0}|{1}|{2}" -f $_.ProcessId, $_.ExecutablePath, $_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ') } | Out-String -Width 4096`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {encoding: 'utf8', timeout: 30000, windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('Cannot observe installed processes: ' + (result.stderr || result.signal || result.status));
  const rows = [];
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    const match = /^(\d+)\|(.+?)\|(\d{4}-\d{2}-\d{2}T\S+Z)$/.exec(line.trim());
    if (match) rows.push({pid: Number(match[1]), executable: match[2], creationDate: match[3], startedAt: Date.parse(match[3])});
  }
  return rows;
}
export async function appProcesses(root) {
  return (await processesUnder(root)).filter(row => path.basename(row.executable).toLowerCase() === 'nozeli.exe');
}
// Identity-bound termination for fault injection: the victim row is only an
// observation (resolved by executable path under the installation root). The
// kill itself runs in terminate-original-process.mjs with the same
// application tree's native module: it opens the experimental process
// identity pin in allowTerminate mode (the exact original HANDLE
// incarnation), requires the pinned image path to stay under the
// installation root and the pinned kernel creation stamp to equal the
// exact journal creation stamp, then terminates through the retained HANDLE. No PID is acted on
// after the open, so reuse cannot redirect the termination; exit is proven
// by the signaled HANDLE. Terminating the helper alone also ends its whole
// successor tree: the helper holds the child in a native kill-on-close Job.
export async function terminateOriginalProcess({root, row, expectedStart100ns}) {
  if (!row || !Number.isInteger(row.pid) || !Number.isFinite(row.startedAt)) throw Error('terminateOriginalProcess requires a resolved process row with a creation time');
  const exactStamp = typeof expectedStart100ns === 'string' && /^\d+$/.test(expectedStart100ns) ? expectedStart100ns : null;
  if (exactStamp === null) throw Error('terminateOriginalProcess requires the exact journal creation stamp');
  const versions = path.join(path.resolve(root), 'versions');
  const [releaseId] = path.relative(versions, row.executable).split(path.sep);
  if (!/^[a-f0-9-]{36}$/i.test(releaseId)) throw Error('Fault target is not an installed release image');
  const release = path.join(versions, releaseId);
  const appTree = path.join(release, 'resources', 'app');
  const node = path.join(appTree, 'runtime', 'node', 'node.exe');
  const image = path.resolve(row.executable).toLowerCase();
  if (image !== node.toLowerCase() && image !== path.join(release, 'Nozeli.exe').toLowerCase()) throw Error('Fault target is not the installed browser or bundled helper runtime');
  const script = path.join(import.meta.dirname, 'terminate-original-process.mjs');
  const args = [script, '--pid', String(row.pid), '--under', root, '--app-tree', appTree, '--image', image, '--expected-start-100ns', exactStamp];
  const result = spawnSync(node, args, {encoding: 'utf8', timeout: 90000, windowsHide: true});
  const output = (result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  let proof = null;
  try { proof = output ? JSON.parse(output) : null; } catch {}
  if (result.error || result.status !== 0 || !proof?.ok) {
    throw Error('terminate-original-process failed for pid ' + row.pid + ' (status ' + result.status + '): ' + (proof ? JSON.stringify(proof) : (result.stderr || result.stdout || result.error || 'no output')).slice(0, 2000));
  }
  return proof;
}

// Tolerant scan of the installed profile's updates directory: the canonical
// attempt record names belong to the Windows updater modules; the driver only
// assumes a JSON record with a string `phase` (and usually `token`).
export async function scanUpdateRecords(updatesDir) {
  const records = [];
  for (const name of await fs.readdir(updatesDir).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(updatesDir, name);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) continue;
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value && typeof value === 'object' && typeof value.phase === 'string') records.push({file: name, value});
    } catch {}
  }
  return records;
}
export async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

export async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitFor(read, label, timeout = 120000, {deadline, stopping} = {}) {
  const end = Math.min(Date.now() + timeout, deadline ?? Infinity);
  while (Date.now() < end) {
    if (stopping?.value) throw Error('Driver aborted while waiting: ' + label);
    const value = await read();
    if (value) return value;
    await sleep(120);
  }
  throw Error('Timed out: ' + label);
}
export function compareVersions(a, b) {
  const parse = value => { const [core, pre = ''] = String(value).split('+')[0].split('-'); return {core: core.split('.').map(part => Number(part) || 0), pre: pre ? pre.split('.') : []}; };
  const x = parse(a), y = parse(b);
  for (let index = 0; index < 3; index++) if ((x.core[index] || 0) !== (y.core[index] || 0)) return (x.core[index] || 0) < (y.core[index] || 0) ? -1 : 1;
  // Semver precedence: a release outranks any prerelease of the same core;
  // prerelease identifiers compare numerically then lexically, shorter wins.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : (x.pre.length ? -1 : 1);
  for (let index = 0; index < Math.min(x.pre.length, y.pre.length); index++) {
    const left = x.pre[index], right = y.pre[index], numeric = /^\d+$/.test(left) && /^\d+$/.test(right);
    if (left === right) continue;
    if (numeric) return Number(left) < Number(right) ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return x.pre.length === y.pre.length ? 0 : (x.pre.length < y.pre.length ? -1 : 1);
}
