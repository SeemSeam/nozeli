// Linux native file-safety adapter (contract nozeli.platform.filesystem/1,
// selection owned by platform/shared/filesystem.mjs via the shared
// capability matrix, capability id `safe-file-io`).
//
// Identity anchoring pins one O_DIRECTORY|O_NOFOLLOW directory fd per path
// component and resolves every next component through /proc/self/fd, so a
// swapped or symlinked component can never redirect resolution outside the
// pinned tree. The final entry is opened O_NOFOLLOW|O_NONBLOCK and handed
// to the policy layer (agents/managed/file-stream.mjs), which owns path
// rules, byte budgets, mode mapping and error codes; this adapter owns the
// native mechanics only:
//  - openAnchoredFile(root, rel): pin ancestors, open the entry, expose
//    { stat, stream(), fdSourcePath(), verify(), close() }. Returns null
//    exactly when the entry (or an ancestor) is missing. verify() compares
//    dev/ino/size/mtimeNs/ctimeNs/nlink of the open inode and its directory
//    entry plus dev/ino of every pinned ancestor, reporting which fact
//    changed without deciding what that means.
//  - openWriteParent(root, rel): pin the parent directory (creating missing
//    intermediate directories under the pin) and return single-component
//    operations inside it: openExclusive/writeExclusive, renameOver,
//    remove, close. A composed name can never escape the anchor.
//  - chain.*: pinned directory-chain operations for provisioning-style
//    consumers (readdir/lstat/openDirectory/openFile/mkdir/writeExclusive/
//    rename/removeTree/removeDirectoryIfEmpty/realpath/anchoredPath) —
//    consumers never compose native fd paths themselves.
//
// fdSourcePath() feeds Git's hash-object with /proc/<pid>/fd/<fd> source
// paths so Git reads the exact pinned inodes.
//
// Durability note: this adapter provides no fsync barrier; anchored edits
// rely on the caller's durable intent manifest (reconcile on recovery).
// Persistence barriers are the separate durable-persistence capability
// (platform/shared/persistence.mjs).
import fs from 'node:fs/promises';
import {constants} from 'node:fs';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const ENTRY_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const pinnedPath = handle => '/proc/self/fd/' + handle.fd;
const closeAll = async handles => { for (const handle of handles.reverse()) await handle.close(); };
const closeQuiet = async handles => { for (const handle of handles.reverse()) await handle.close().catch(() => {}); };

const sameIdentity = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;

const anchoredName = name => {
  if (typeof name !== 'string' || !name || name.length > 255 || name === '.' || name === '..'
    || name.includes('/') || name.includes('\\') || name.includes('\0'))
    throw Object.assign(new Error('锚定目录内的文件名不是单个安全组件：' + JSON.stringify(name)), { code: 'FS_NAME_REJECTED' });
  return name;
};

export const linuxFilesystemAdapter = {
  id: 'linux-proc-fd',
  platform: 'linux',
  supported: true,
  capabilities: Object.freeze({ anchoredRead: true, anchoredWrite: true, gitFdSourcePaths: true, hooksExecuteRegardlessOfModeBits: false }),
  evidence: 'Linux 实机回归：/proc/self/fd 逐级 O_DIRECTORY|O_NOFOLLOW 锚定打开与写父目录固定；fd 源路径喂给 git hash-object',
  async openAnchoredFile(root, rel) {
    const handles = [], ancestors = [];
    let file = null;
    try {
      let directory = await fs.open(root, DIRECTORY_FLAGS); handles.push(directory);
      ancestors.push({ entryPath: root, stat: await directory.stat({ bigint: true }) });
      for (const part of rel.split('/').slice(0, -1)) {
        const entryPath = pinnedPath(directory) + '/' + part;
        directory = await fs.open(entryPath, DIRECTORY_FLAGS); handles.push(directory);
        ancestors.push({ entryPath, stat: await directory.stat({ bigint: true }) });
      }
      const entryPath = pinnedPath(directory) + '/' + rel.split('/').at(-1);
      file = await fs.open(entryPath, ENTRY_FLAGS); handles.push(file);
      const stat = await file.stat({ bigint: true });
      let closed = false;
      return {
        stat,
        fdSourcePath: () => '/proc/' + process.pid + '/fd/' + file.fd,
        stream: () => file.createReadStream({ start: 0, autoClose: false, highWaterMark: 256 * 1024 }),
        verify: async () => {
          try {
            if (!sameIdentity(await file.stat({ bigint: true }), stat)) return { stable: false, reason: 'file' };
            const entry = await fs.lstat(entryPath, { bigint: true });
            if (!sameIdentity(entry, stat)) return { stable: false, reason: 'entry' };
            for (const ancestor of ancestors) {
              const current = await fs.lstat(ancestor.entryPath, { bigint: true });
              if (!current.isDirectory() || current.dev !== ancestor.stat.dev || current.ino !== ancestor.stat.ino) return { stable: false, reason: 'ancestor' };
            }
            return { stable: true, reason: null };
          } catch (error) {
            if (error.code === 'ENOENT') return { stable: false, reason: 'missing' };
            throw error;
          }
        },
        close: async () => { if (closed) return; closed = true; await closeAll(handles); },
      };
    } catch (error) {
      // Missing root/ancestor/final entry (nothing opened yet) is the
      // contract's null result; every other failure closes the pins and
      // propagates to the policy layer.
      await closeAll(handles);
      if (error.code === 'ENOENT' && file === null) return null;
      throw error;
    }
  },
  async openWriteParent(root, rel) {
    const handles = [];
    let settled = false;
    try {
      let directory = await fs.open(root, DIRECTORY_FLAGS); handles.push(directory);
      for (const part of rel.split('/').slice(0, -1)) {
        const next = pinnedPath(directory) + '/' + part;
        await fs.mkdir(next).catch(error => { if (error.code !== 'EEXIST') throw error; });
        directory = await fs.open(next, DIRECTORY_FLAGS); handles.push(directory);
      }
      const prefix = pinnedPath(directory) + '/';
      const close = async () => { if (settled) return; settled = true; await closeAll(handles); };
      return {
        close,
        async openExclusive(name, { mode = 0o600 } = {}) {
          return fs.open(prefix + anchoredName(name), 'wx', mode);
        },
        async writeExclusive(name, data, { mode = 0o644 } = {}) {
          await fs.writeFile(prefix + anchoredName(name), data, { flag: 'wx', mode });
        },
        async renameOver(fromName, toName) {
          await fs.rename(prefix + anchoredName(fromName), prefix + anchoredName(toName));
        },
        async remove(name) {
          await fs.rm(prefix + anchoredName(name), { force: true });
        },
      };
    } catch (error) {
      await closeAll(handles);
      throw error;
    }
  },
  // Anchored directory-chain operations for provisioning-style consumers:
  // one pinned directory handle plus single-component addressing inside it
  // (and cross-directory rename between two pins).
  chain: {
    async directory(root, relDir = '') {
      // The chain contract addresses the pin root as '' ; a '.' dirname
      // (root-level resource) names the same directory. Real traversal
      // components ('..', embedded '.') stay rejected by anchoredName.
      const parts = relDir && relDir !== '.' ? relDir.split('/') : [];
      const handles = [];
      try {
        let directory = await fs.open(root, DIRECTORY_FLAGS); handles.push(directory);
        for (const part of parts) {
          directory = await fs.open(pinnedPath(directory) + '/' + anchoredName(part), DIRECTORY_FLAGS); handles.push(directory);
        }
        return { handle: directory, close: async () => { await closeAll(handles); } };
      } catch (error) {
        await closeQuiet(handles);
        throw error;
      }
    },
    readdir: async directory => fs.readdir(pinnedPath(directory)),
    lstat: async (directory, name) => fs.lstat(pinnedPath(directory) + '/' + anchoredName(name)),
    openDirectory: async (directory, name) => fs.open(pinnedPath(directory) + '/' + anchoredName(name), DIRECTORY_FLAGS),
    openFile: async (directory, name) => fs.open(pinnedPath(directory) + '/' + anchoredName(name), constants.O_RDONLY | constants.O_NOFOLLOW),
    mkdir: async (directory, name, mode = 0o755) => fs.mkdir(pinnedPath(directory) + '/' + anchoredName(name), { mode }),
    writeExclusive: async (directory, name, data) => fs.writeFile(pinnedPath(directory) + '/' + anchoredName(name), data, { flag: 'wx' }),
    async rename(fromDirectory, fromName, toDirectory, toName) {
      await fs.rename(pinnedPath(fromDirectory) + '/' + anchoredName(fromName), pinnedPath(toDirectory) + '/' + anchoredName(toName));
    },
    removeTree: async (directory, name) => fs.rm(pinnedPath(directory) + '/' + anchoredName(name), { recursive: true, force: true }),
    removeDirectoryIfEmpty: async (directory, name) => fs.rmdir(pinnedPath(directory) + '/' + anchoredName(name)),
    realpath: async directory => fs.realpath(pinnedPath(directory)),
    // Adapter-issued anchored path token for bulk copy destinations; the
    // consumer never constructs native fd paths itself.
    anchoredPath: (directory, name) => pinnedPath(directory) + '/' + anchoredName(name),
  },
};
