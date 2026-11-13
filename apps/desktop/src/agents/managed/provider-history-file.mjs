import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const fail = () => { throw Object.assign(new Error('History file or ancestor changed'), { code: 'SOURCE_CHANGED' }); };
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => identity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
const reliable = stat => {
  if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || stat.ino <= 0n) throw Object.assign(new Error('Reliable history file identity unavailable'), { code: 'IDENTITY_UNSUPPORTED' });
};

// Portable descriptor verification: match the actual opened inode against the
// entry captured before open, and revalidate every ancestor and entry before
// exposing any bytes. There is no platform-specific fd-path or shell dependency.
// A path swapped between validation and open cannot establish a new trusted inode.
export async function openHistoryFile(file, { fault } = {}) {
  const ancestors = [];
  let directory = path.parse(file).root;
  const rootStat = await lstat(directory, { bigint: true });
  reliable(rootStat);
  ancestors.push({ path: directory, stat: rootStat });
  for (const part of path.relative(directory, path.dirname(file)).split(path.sep).filter(Boolean)) {
    directory = path.join(directory, part);
    const stat = await lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    reliable(stat);
    ancestors.push({ path: directory, stat });
  }
  const expected = await lstat(file, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n) fail();
  reliable(expected);
  await fault?.({ phase: 'before-open', file });
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  async function verify() {
    const actual = await handle.stat({ bigint: true });
    if (!actual.isFile() || !sameFile(actual, expected)) fail();
    const entry = await lstat(file, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || !sameFile(entry, expected)) fail();
    for (const ancestor of ancestors) {
      const current = await lstat(ancestor.path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !identity(current, ancestor.stat)) fail();
    }
  }
  try { await verify(); } catch (error) { await handle.close(); throw error; }
  let closed = false;
  return {
    stat: () => handle.stat(),
    async read(...args) {
      await verify();
      const result = await handle.read(...args);
      await fault?.({ phase: 'after-read', file });
      await verify();
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await verify(); } finally { await handle.close(); }
    },
  };
}
