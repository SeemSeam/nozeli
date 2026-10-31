// Synchronous tar I/O runs off the Electron main thread. Worker exit is the
// ownership boundary: no extraction filesystem operation can outlive cleanup.
import {workerData} from 'node:worker_threads';
import path from 'node:path';
import * as tar from 'tar';
// Electron must treat bundled *.asar files as ordinary archive bytes.
process.noAsar = true;
const {archive, destination, label, maxArchive, maxUnpacked} = workerData;
let size = 0, entries = 0;
const seen = new Set();
tar.x({file: archive, cwd: destination, sync: true, strict: true, preserveOwner: false, noChmod: true, filter(name, entry) {
  const normalized = name.replace(/\/$/, '');
  const parts = normalized.split('/');
  if (parts[0] !== label || parts.some(p => !p || p === '.' || p === '..') || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name)) throw Error('Archive path escapes expected release root');
  if (!['File', 'Directory', 'SymbolicLink'].includes(entry.type) || entry.mode & 0o6000) throw Error('Unsafe archive entry type/mode');
  if (seen.has(normalized)) throw Error('Duplicate archive entry');
  seen.add(normalized);
  size += entry.size; entries++;
  if (!Number.isSafeInteger(size) || size > maxUnpacked || entries > 250000 || entry.size > maxArchive) throw Error('Archive extraction limit exceeded');
  if (entry.type === 'SymbolicLink') {
    const target = path.posix.join(path.posix.dirname(normalized), entry.linkpath);
    if (path.posix.isAbsolute(entry.linkpath) || entry.linkpath.includes('\\') || target !== label && !target.startsWith(label + '/')) throw Error('Archive link escapes release');
  }
  return true;
}});
