// Windows stable updater package validation, hostile-ZIP extraction and
// same-volume promotion. The ZIP is parsed from central/local records through
// the original native archive HANDLE before any extraction happens, so
// duplicate or colliding entries can never be silently discarded by a library
// consumer the way JSZip-based readers drop them. No shell, no tar/unzip, no
// path-based reopens; the caller enforces the same-volume installation root.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createInflateRaw} from 'node:zlib';
import {Readable, Transform, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {semver, MAX_ARCHIVE} from './auto-update-files.mjs';
import {validateWindowsCandidate} from '../../tools/package-windows-candidate.mjs';
import {absolute} from '../../tools/windows-install-core.mjs';
import {openExperimentalSourceDirectory} from '../platform/windows/experimental-source-directory.mjs';
import {openExperimentalPersistenceParent} from '../platform/windows/experimental-persistence.mjs';
import {moveExperimentalPrivateDirectory} from '../platform/windows/experimental-directory-move.mjs';

const MAX_UNPACKED = 10 * 1024 ** 3; // Total expansion bound (tar worker parity).
const MAX_ENTRIES = 250000;          // Archive member bound (tar worker parity).
const MAX_CENTRAL = 32 * 1024 ** 2;
const READ_CHUNK = 256 * 1024;       // Native readAt/write cap is 1 MiB.
const AUTO_UPDATE_PROTOCOLS = ['unsupported', 'native-windows-health-v1'];
const RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)$/;

const crcTable = Uint32Array.from({length: 256}, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc32 = (crc, chunk) => { for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc; };
const invalidZip = () => Error('Unsafe or unsupported Windows update archive');
const fold = value => value.normalize('NFKC').toUpperCase().toLowerCase(); // Native lease name convention.
function nativeWindows() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Object.assign(Error('Native Windows x64 required'), {code: 'FS_PLATFORM_UNSUPPORTED'});
}
// Mirrors the native private-directory component contract: no traversal,
// device-reserved names, NTFS 8.3 tilde aliases, trailing dot/space or Windows
// filename characters. Alternate data streams need ':' and are rejected here.
function unsafeComponent(part) {
  if (!part || part === '.' || part === '..' || part.length > 255 || /[\x00-\x1f\x7f\\/:*?"<>|]/.test(part) || /[. ]$/.test(part)) return true;
  const comparable = fold(part);
  return comparable.includes('~') || RESERVED.test(comparable.split('.')[0].trim());
}
async function readAt(reader, offset, length) {
  const data = Buffer.alloc(length);
  for (let done = 0; done < length; ) {
    const chunk = reader.readAt(offset + done, Math.min(1 << 20, length - done));
    if (!chunk?.length) throw invalidZip();
    try { chunk.copy(data, done); } catch { throw invalidZip(); }
    done += chunk.length;
  }
  return data;
}
async function digestReader(reader, size, signal) {
  const hash = createHash('sha256');
  for (let offset = 0; offset < size; offset += READ_CHUNK) {
    signal?.throwIfAborted();
    const chunk = reader.readAt(offset, Math.min(READ_CHUNK, size - offset));
    if (!chunk?.length) throw Error('Windows update archive truncated');
    hash.update(chunk);
  }
  return hash.digest('hex');
}

// Parse ZIP records ourselves before extraction: no library name
// interpretation, no extraction through links, no privileged modes, ZIP64,
// encrypted entries or unbounded inflate.
export async function windowsZipEntries(reader, size, label) {
  if (typeof label !== 'string' || !label || label.includes('/') || unsafeComponent(label)) throw invalidZip();
  if (!Number.isSafeInteger(size) || size < 22 || size > MAX_ARCHIVE) throw invalidZip();
  const tailStart = Math.max(0, size - 65557), tail = await readAt(reader, tailStart, size - tailStart);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
  if (eocd < 0 || tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6)) throw invalidZip();
  const count = tail.readUInt16LE(eocd + 10), centralSize = tail.readUInt32LE(eocd + 12), centralOffset = tail.readUInt32LE(eocd + 16);
  if (!count || count === 65535 || count !== tail.readUInt16LE(eocd + 8) || count > MAX_ENTRIES || centralSize > MAX_CENTRAL || centralOffset + centralSize !== size - tail.length + eocd) throw invalidZip();
  const central = await readAt(reader, centralOffset, centralSize), entries = [], names = new Set();
  let offset = 0, total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) throw invalidZip();
    const flags = central.readUInt16LE(offset + 8), method = central.readUInt16LE(offset + 10), compressed = central.readUInt32LE(offset + 20), length = central.readUInt32LE(offset + 24), n = central.readUInt16LE(offset + 28), x = central.readUInt16LE(offset + 30), c = central.readUInt16LE(offset + 32), mode = central.readUInt32LE(offset + 38) >>> 16, localOffset = central.readUInt32LE(offset + 42);
    const type = mode & 0o170000;
    // Regular files and directories only: symlinks, devices, FIFOs and
    // setuid/setgid/sticky modes never reach the staging filesystem.
    if (!n || offset + 46 + n + x + c > central.length || flags & ~0x808 || ![0, 8].includes(method) || central.readUInt16LE(offset + 34) || length === 0xffffffff || compressed === 0xffffffff || mode & 0o6000 || (type !== 0 && type !== 0o100000 && type !== 0o040000)) throw invalidZip();
    const nameBytes = central.subarray(offset + 46, offset + 46 + n), name = nameBytes.toString('utf8');
    const stripped = name.endsWith('/') ? name.slice(0, -1) : name, parts = stripped.split('/');
    const directory = type === 0o040000 || (type === 0 && name.endsWith('/'));
    if (!Buffer.from(name).equals(nameBytes) || /[\\\x00-\x1f\x7f:*?"<>|]/.test(name) || name.startsWith('/') || parts[0] !== label || parts.some(unsafeComponent) || (stripped === label && !directory) || name.endsWith('/') !== directory) throw invalidZip();
    if (directory && (length || compressed || central.readUInt32LE(offset + 16))) throw invalidZip();
    if (!directory && method === 0 && length !== compressed) throw invalidZip();
    total += length;
    if (total > MAX_UNPACKED || length > MAX_ARCHIVE) throw invalidZip();
    const key = fold(stripped); // Exact, NFKC-equivalent and case-insensitive collisions all land here.
    if (names.has(key)) throw invalidZip();
    names.add(key);
    const local = await readAt(reader, localOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || local.readUInt16LE(26) !== n) throw invalidZip();
    if(!(flags&8)&&(local.readUInt32LE(14)!==central.readUInt32LE(offset+16)||local.readUInt32LE(18)!==compressed||local.readUInt32LE(22)!==length))throw invalidZip();
    const localName = await readAt(reader, localOffset + 30, n);
    if (!localName.equals(nameBytes)) throw invalidZip();
    const start = localOffset + 30 + n + local.readUInt16LE(28), end = start + compressed;
    if (localOffset >= centralOffset || end > centralOffset) throw invalidZip();
    entries.push({name, type: directory ? 0o040000 : 0o100000, method, length, compressed, start, end, localOffset, crc: central.readUInt32LE(offset + 16)});
    offset += 46 + n + x + c;
  }
  if (offset !== central.length) throw invalidZip();
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].localOffset < sorted[i - 1].end) throw invalidZip();
  const files = new Set(entries.filter(entry => entry.type === 0o100000).map(entry => fold(entry.name)));
  for (const entry of entries) {
    const parts = fold(entry.name).split('/');
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join('/'))) throw invalidZip();
  }
  return entries;
}

function stageEntry(stage, reader, entry, signal) {
  let received = 0, crc = 0xffffffff, compressedOffset = 0;
  const check = new Transform({transform(chunk, encoding, done) {
    received += chunk.length;
    if (received > entry.length) return done(invalidZip());
    crc = crc32(crc, chunk);
    done(null, chunk);
  }});
  const sink = new Writable({write(chunk, encoding, done) {
    try { stage.write(chunk); done(); } catch (error) { done(error); }
  }});
  // Compressed bytes come only from the pinned archive HANDLE, never a path.
  const source = new Readable({read() {
    try {
      if (compressedOffset >= entry.compressed) return this.push(null);
      const chunk = reader.readAt(entry.start + compressedOffset, Math.min(READ_CHUNK, entry.compressed - compressedOffset));
      if(!chunk.length)throw Error('Windows update archive truncated during inflation');
      compressedOffset += chunk.length;
      this.push(chunk);
    } catch (error) { this.destroy(error); }
  }});
  return pipeline(source, ...(entry.method === 8 ? [createInflateRaw()] : []), check, sink, {signal}).then(() => {
    if (received !== entry.length || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw invalidZip();
  });
}

export async function validateWindowsUpdatePackage(directory, version, expectedCommit) {
  nativeWindows();
  const checked = await validateWindowsCandidate(absolute(directory));
  try {
    const {tree, manifest} = checked;
    let metadata;
    try { metadata = JSON.parse(tree.read('RELEASE.json')); } catch { throw Error('Windows update release metadata (RELEASE.json) is missing or invalid'); }
    if (version === undefined) version = metadata.version;
    if (!semver(version)) throw Error('Invalid Windows release version');
    if (metadata.application !== 'Nozeli' || metadata.version !== version || manifest.version !== version || metadata.platform !== 'win32' || metadata.arch !== 'x64' || metadata.format !== 'manual-candidate-zip' || !/^[a-f0-9]{40}$/.test(metadata.commit ?? '')) throw Error('Windows release metadata does not match update');
    if(expectedCommit!==undefined&&(!/^[a-f0-9]{40}$/.test(expectedCommit)||metadata.commit!==expectedCommit))throw Error('Windows release commit does not match release tag');
    if (!AUTO_UPDATE_PROTOCOLS.includes(metadata.autoUpdate) || metadata.autoUpdate !== manifest.automaticUpdater) throw Error('Windows release updater protocol differs from candidate manifest');
    // The new protocol binds the release, candidate manifest and native
    // provenance to one exact commit; legacy manual candidates carry only the
    // RELEASE commit and are accepted for validation/source use alone.
    if (metadata.autoUpdate === 'native-windows-health-v1' && (!/^[a-f0-9]{40}$/.test(manifest.commit ?? '') || manifest.commit !== metadata.commit || manifest.nativeProvenance?.commit !== manifest.commit)) throw Error('Windows update commit binding differs between release, manifest and native provenance');
    const application = JSON.parse(tree.read('resources/app/package.json'));
    if (application.name !== 'nozeli-desktop' || application.version !== version || application.main !== 'src/main/main.cjs') throw Error('Unexpected application entrypoint');
    const has = name => tree.entries.some(entry => entry.path === name && entry.type === 'file');
    const required = ['RELEASE.json', 'resources/app/src/main/main.cjs', 'resources/app/dist/renderer/app.js', 'resources/app/src/main/auto-update-helper.mjs'];
    if (metadata.autoUpdate === 'native-windows-health-v1') required.push('resources/app/src/main/auto-update-windows-package.mjs', 'resources/app/src/main/auto-update-files.mjs');
    for (const name of required) if (!has(name)) throw Error('Missing Windows update payload: ' + name);
    return Object.freeze({...metadata, candidateDigest: checked.digest});
  } finally { checked.tree.close(); }
}

export async function extractWindowsUpdatePackage(archive, destination, version, signal, expectedCommit, expectedArchiveSha256) {
  nativeWindows();
  archive = absolute(archive); destination = absolute(destination);
  const release = semver(version);
  if (!release || release.version !== version) throw Error('Invalid Windows release version');
  if (expectedCommit !== undefined && !/^[a-f0-9]{40}$/.test(expectedCommit)) throw Error('Expected 40-hex release commit');
  if (expectedArchiveSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedArchiveSha256)) throw Error('Expected 64-hex archive SHA-256');
  const label = 'Nozeli-' + version + '-windows-x64';
  signal?.throwIfAborted();
  const directory=openExperimentalSourceDirectory(path.dirname(path.dirname(archive)),path.dirname(archive));
  let file;
  try {
    file = directory.openFile(path.basename(archive)); // Original HANDLE: single link, no reparse, no alternate streams.
    const size = Number(file.stat().size);
    if (!Number.isSafeInteger(size)) throw invalidZip();
    const before = await digestReader(file, size, signal);
    file.verify();
    if (expectedArchiveSha256 !== undefined && before !== expectedArchiveSha256) throw Error('Windows update archive SHA-256 mismatch');
    const entries = await windowsZipEntries(file, size, label);
    file.verify();
    // The archive is fully validated before the first staging effect.
    const parent = openExperimentalPersistenceParent(path.dirname(destination), path.basename(destination));
    let staging;
    try {
      staging = parent.createPrivateTreeRootExclusive(path.basename(destination));
      const labelDirectory = staging.createPrivateDirectoryExclusive(label);
      const directories = new Map([['', labelDirectory]]);
      const openDirectory = components => {
        if (!components.length) return labelDirectory;
        const key = components.join('/');
        if (directories.has(key)) return directories.get(key);
        const holder = openDirectory(components.slice(0, -1));
        const lease = holder.createPrivateDirectoryExclusive(components.at(-1));
        directories.set(key, lease);
        return lease;
      };
      try {
        for (const entry of entries) {
          signal?.throwIfAborted();
          let relative = entry.name.slice(label.length + 1);
          if (entry.type === 0o040000) { if (relative.endsWith('/')) relative = relative.slice(0, -1); if (relative) await openDirectory(relative.split('/')); continue; }
          const components = relative.split('/');
          const holder = await openDirectory(components.slice(0, -1));
          const stage = holder.createPrivateExclusive('.stage-' + createHash('sha256').update(entry.name).digest('hex').slice(0, 32));
          try { await stageEntry(stage, file, entry, signal); stage.sync(); stage.publishNew(components.at(-1)); }
          finally { stage.close(); } // Unpublished stages are discarded; published files are retained.
        }
        // Postorder directory barriers, then the staging root and its parent.
        for (const lease of [...directories.values()].reverse()) lease.syncDirectory();
        staging.syncDirectory();
        parent.syncDirectory();
      } finally {
        // No recursive cleanup on abort or failure: unknown stages stay
        // observable for the caller's reconciliation.
        for (const lease of [...directories.values()].reverse()) { try { lease.close(); } catch {} }
      }
    } finally {
      try { staging?.close(); } catch {}
      parent.close();
    }
    file.verify();
    const after = await digestReader(file, size, signal); // Revalidate the pinned archive after extraction.
    if (after !== before) throw Error('Windows update archive changed during extraction');
    const extracted = path.join(destination, label);
    await validateWindowsUpdatePackage(extracted, version, expectedCommit);
    return extracted;
  } finally {
    try { await file?.close(); } catch {}
    directory.close();
  }
}

// Identity-pinned same-volume promotion of a validated, already flushed
// extraction. Uncertain outcomes are reported, never cleaned up here.
export async function promoteWindowsUpdatePackage(extracted, destination, root, {signal, expectedIdentity} = {}) {
  nativeWindows();
  extracted = absolute(extracted); destination = absolute(destination);
  if (expectedIdentity !== undefined && !/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(expectedIdentity)) throw Error('Expected canonical source directory identity');
  if (expectedIdentity === undefined) {
    const parent = openExperimentalPersistenceParent(path.dirname(extracted), path.basename(extracted));
    let directory;
    try { directory = parent.openPrivateDirectory(path.basename(extracted), false); expectedIdentity = directory.identity(); }
    finally { try { directory?.close(); } catch {} parent.close(); }
  }
  return await moveExperimentalPrivateDirectory(root, extracted, destination, {expectedIdentity, signal});
}
