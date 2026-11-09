// macOS native file-safety adapter (contract nozeli.platform.filesystem/1,
// selection owned by platform/shared/filesystem.mjs via the shared capability
// matrix, capability id `safe-file-io`).
//
// macOS has no /proc fd namespace and Node has no openat surface, so the same
// anchoring discipline as the Linux adapter is implemented through a small
// native Node-API helper (native/fs_anchor.c): every path component is opened
// openat(dirfd, name, O_NOFOLLOW|...) and must fstat as a directory, so a
// swapped or symlinked component can never redirect resolution outside the
// pinned tree. The final entry opens O_NOFOLLOW|O_NONBLOCK and is handed to
// the policy layer (agents/managed/file-stream.mjs), which owns path rules,
// byte budgets, mode mapping and error codes; this adapter owns the native
// mechanics only:
//  - openAnchoredFile(root, rel): pin ancestors, open the entry, expose
//    { stat, stream(), verify(), close() }. Returns null exactly when the
//    entry (or an ancestor) is missing. verify() compares dev/ino/size/
//    mtimeNs/ctimeNs/nlink of the open inode, its directory entry (fstatat
//    AT_SYMLINK_NOFOLLOW on the pinned parent) and dev/ino of every pinned
//    ancestor's original path, reporting which fact changed without deciding
//    what that means.
//  - openWriteParent(root, rel): pin the parent directory (creating missing
//    intermediate directories under the pin) and return single-component
//    operations inside it: openExclusive/writeExclusive, renameOver,
//    remove, close. A composed name can never escape the anchor.
//  - chain.*: pinned directory-chain operations for provisioning-style
//    consumers (readdir/opendir/lstat/openDirectory/openFile/openExclusive/
//    mkdir/writeExclusive/rename/removeTree/removeDirectoryIfEmpty/realpath/
//    sync/destination) — consumers never compose native paths themselves.
//    openExclusive yields the pinned write handle (writeFile/sync =
//    F_FULLFSYNC/close) and sync() is the post-rename namespace barrier
//    through the same pin; destination() hands out a single-component entry
//    driver (mkdir/chmod/copyFile/openDir) whose copies land via clonefileat
//    onto the pinned directory descriptor.
//
// Git has no fd-source path on macOS: /dev/fd/<fd> resolves against the
// child's own descriptor table, and Node's spawn cloexecs every non-stdio
// descriptor, so pinned inodes cannot be handed to a Git subprocess as paths.
// Git object ingestion therefore goes through the consumer's content feed
// (agents/managed/git-service.mjs streams the pinned bytes into
// `git hash-object -w --stdin`); this adapter declares no gitFdSourcePaths.
//
// Durability note: this adapter provides no fsync barrier; anchored edits
// rely on the caller's durable intent manifest (reconcile on recovery).
// Persistence barriers are the separate durable-persistence capability
// (platform/shared/persistence.mjs).
import {createReadStream} from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);

// The helper is built by native/build.mjs and ships next to this file. Loading
// stays lazy so a missing artifact can never break other platforms importing
// the shared selector; every operation fails closed with the build command
// instead of degrading to an unsafe fallback.
let nativeModule;
function native() {
  if (nativeModule === undefined) {
    try {
      nativeModule = require('./native/fs_anchor.node');
    } catch (cause) {
      nativeModule = Object.assign(new Error('macOS 原生锚定 helper 未加载：请先在 apps/desktop 运行 node src/platform/darwin/native/build.mjs 并确保 fs_anchor.node 随应用打包。'), { cause, code: 'FS_NATIVE_HELPER_MISSING' });
    }
  }
  return nativeModule;
}
const need = () => {
  const value = native();
  if (value instanceof Error) throw value;
  return value;
};

const S_IFMT = 0o170000;
const toStats = raw => {
  const kind = Number(raw.mode) & S_IFMT;
  return Object.assign(Object.create(null), raw, {
    isFile: () => kind === 0o100000,
    isDirectory: () => kind === 0o040000,
    isSymbolicLink: () => kind === 0o120000,
  });
};

const sameIdentity = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;

const toBuffer = data => Buffer.isBuffer(data) ? data : Buffer.from(String(data));

const anchoredName = name => {
  if (typeof name !== 'string' || !name || name.length > 255 || name === '.' || name === '..'
    || name.includes('/') || name.includes('\\') || name.includes('\0'))
    throw Object.assign(new Error('锚定目录内的文件名不是单个安全组件：' + JSON.stringify(name)), { code: 'FS_NAME_REJECTED' });
  return name;
};

// Chain directory handles and pinned file handles are opaque tokens created
// here; every operation re-validates liveness so a closed handle can never
// act on a recycled descriptor number.
const liveFd = (handle, kind) => {
  if (!handle || handle.closed === true || !Number.isInteger(handle.fd))
    throw Object.assign(new Error('锚定' + kind + '句柄不可用（可能已关闭）'), { code: 'EBADF' });
  return handle.fd;
};

const dirFd = handle => liveFd(handle, '目录');

const chainHandle = (N, fds) => {
  const handle = {
    fd: fds.at(-1),
    closed: false,
    async close() {
      if (handle.closed) return;
      handle.closed = true;
      for (const fd of fds.slice().reverse()) N.closeFd(fd);
    },
  };
  return handle;
};

// Interface parity with the Linux adapter's Node FileHandle for the exact
// consumer surface (writeFile/sync/chmod for temp+chmod+sync publishing,
// stat/readFile for chain reads). chmod goes through fchmod(fd) — the pinned
// descriptor, never a path re-resolution — and every operation re-validates
// liveness so a closed handle rejects instead of touching a recycled fd.
const openFileHandle = (N, fd) => {
  const live = () => liveFd(handle, '文件');
  const handle = {
    fd,
    closed: false,
    async writeFile(data) { N.writeAll(live(), toBuffer(data)); },
    async chmod(mode) { N.fchmodFd(live(), mode); },
    async sync() { N.fsyncFd(live()); },
    async stat() { return toStats(N.fstatEntry(live())); },
    async readFile() { return N.readAll(live()); },
    async close() { if (handle.closed) return; handle.closed = true; N.closeFd(handle.fd); },
  };
  return handle;
};

// Single-component entry inside a pinned directory for bulk copies: mkdir /
// chmod / clone-into / open as a pinned directory. No composed path is ever
// formed on the destination side.
const destinationEntry = (N, parent, name) => ({
  async mkdir() {
    try { N.mkdirAt(dirFd(parent), name, 0o777); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  },
  async chmod(mode) { N.fchmodAt(dirFd(parent), name, mode); },
  async copyFile(sourcePath) { N.copyFileInto(dirFd(parent), name, sourcePath); },
  async openDir() { return chainHandle(N, [N.openDirAt(dirFd(parent), name)]); },
});

export const darwinFilesystemAdapter = {
  id: 'darwin-openat',
  platform: 'darwin',
  supported: true,
  capabilities: Object.freeze({ anchoredRead: true, anchoredWrite: true, hooksExecuteRegardlessOfModeBits: false }),
  evidence: 'macOS 原生 openat 逐级 O_NOFOLLOW 锚定（NAPI helper fs_anchor：目录描述符单组件寻址、clonefileat 拷贝、fstatat 身份复核；无 /proc 依赖）；Git 对象由消费端流送已核字节（hash-object --stdin），不依赖跨进程 fd 路径',
  async openAnchoredFile(root, rel) {
    const N = need();
    const fds = [], ancestors = [];
    let file = null;
    try {
      let directory = N.openRoot(root); fds.push(directory);
      ancestors.push({ entryPath: root, stat: toStats(N.fstatEntry(directory)) });
      const parts = rel.split('/');
      for (const part of parts.slice(0, -1)) {
        directory = N.openDirAt(directory, part); fds.push(directory);
        ancestors.push({ entryPath: ancestors.at(-1).entryPath + '/' + part, stat: toStats(N.fstatEntry(directory)) });
      }
      file = N.openEntryAt(directory, parts.at(-1), 1); fds.push(file);
      const stat = toStats(N.fstatEntry(file));
      let closed = false;
      return {
        stat,
        // The stream thunk accepts createReadStream range options (e.g.
        // {end} for bounded prefix reads) so a consumer can let the stream
        // end naturally instead of breaking iteration — destroying a raw-fd
        // stream early would take the pinned descriptor with it.
        stream: ({ start = 0, end } = {}) => createReadStream('', { fd: file, start, ...(end === undefined ? {} : { end }), autoClose: false, highWaterMark: 256 * 1024 }),
        verify: async () => {
          try {
            if (!sameIdentity(toStats(N.fstatEntry(file)), stat)) return { stable: false, reason: 'file' };
            if (!sameIdentity(toStats(N.lstatAt(directory, parts.at(-1))), stat)) return { stable: false, reason: 'entry' };
            for (const ancestor of ancestors) {
              const current = toStats(N.lstatPath(ancestor.entryPath));
              if (!current.isDirectory() || current.dev !== ancestor.stat.dev || current.ino !== ancestor.stat.ino) return { stable: false, reason: 'ancestor' };
            }
            return { stable: true, reason: null };
          } catch (error) {
            if (error.code === 'ENOENT') return { stable: false, reason: 'missing' };
            throw error;
          }
        },
        close: async () => {
          if (closed) return;
          closed = true;
          for (const fd of fds.slice().reverse()) N.closeFd(fd);
        },
      };
    } catch (error) {
      // Missing root/ancestor/final entry (nothing opened yet) is the
      // contract's null result; every other failure closes the pins and
      // propagates to the policy layer.
      for (const fd of fds.slice().reverse()) N.closeFd(fd);
      if (error.code === 'ENOENT' && file === null) return null;
      throw error;
    }
  },
  async openWriteParent(root, rel) {
    const N = need();
    const fds = [];
    let settled = false;
    try {
      let directory = N.openRoot(root); fds.push(directory);
      for (const part of rel.split('/').slice(0, -1)) {
        try { N.mkdirAt(directory, part, 0o777); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        directory = N.openDirAt(directory, part); fds.push(directory);
      }
      const close = async () => {
        if (settled) return;
        settled = true;
        for (const fd of fds.slice().reverse()) N.closeFd(fd);
      };
      return {
        close,
        async openExclusive(name, { mode = 0o600 } = {}) {
          return openFileHandle(N, N.openExclusiveAt(directory, anchoredName(name), mode));
        },
        async writeExclusive(name, data, { mode = 0o644 } = {}) {
          N.writeExclusiveAt(directory, anchoredName(name), toBuffer(data), mode);
        },
        async renameOver(fromName, toName) {
          N.renameAt(directory, anchoredName(fromName), directory, anchoredName(toName));
        },
        async remove(name) {
          N.removeAt(directory, anchoredName(name), 1);
        },
      };
    } catch (error) {
      for (const fd of fds.slice().reverse()) N.closeFd(fd);
      throw error;
    }
  },
  // Anchored directory-chain operations for provisioning-style consumers:
  // one pinned directory handle plus single-component addressing inside it
  // (and cross-directory rename between two pins).
  chain: {
    async directory(root, relDir = '') {
      const N = need();
      // The chain contract addresses the pin root as '' ; a '.' dirname
      // (root-level resource) names the same directory. Real traversal
      // components ('..', embedded '.') stay rejected by anchoredName.
      const parts = relDir && relDir !== '.' ? relDir.split('/') : [];
      const fds = [];
      try {
        let directory = N.openRoot(root); fds.push(directory);
        for (const part of parts) {
          directory = N.openDirAt(directory, anchoredName(part)); fds.push(directory);
        }
      } catch (error) {
        for (const fd of fds.slice().reverse()) N.closeFd(fd);
        throw error;
      }
      const handle = chainHandle(N, fds);
      return { handle, close: async () => { await handle.close(); } };
    },
    async readdir(directory) { return need().readdirAt(dirFd(directory)); },
    // Bounded Dirent-style snapshot of one pinned directory (the Linux
    // adapter's fs.opendir(pinnedPath) equivalent): names come from
    // fdopendir on a dup of the pin and every kind from a single-component
    // fstatat on the pin — macOS readdir promises no usable d_type — so an
    // entry is never classified through an unpinned path. Entries vanishing
    // between the two facts are skipped like a raced-out Dirent; no composed
    // path is ever formed.
    async opendir(directory) {
      const N = need(), fd = dirFd(directory);
      const entries = [];
      for (const name of N.readdirAt(fd)) {
        let stat;
        try { stat = toStats(N.lstatAt(fd, anchoredName(name))); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        entries.push({ name, isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink() });
      }
      let index = 0;
      return {
        [Symbol.asyncIterator]: () => ({ next: async () => index < entries.length ? { value: entries[index++], done: false } : { value: undefined, done: true } }),
        close: async () => {},
      };
    },
    async lstat(directory, name) { return toStats(need().lstatAt(dirFd(directory), anchoredName(name))); },
    async openDirectory(directory, name) {
      const N = need();
      return chainHandle(N, [N.openDirAt(dirFd(directory), anchoredName(name))]);
    },
    async openFile(directory, name) {
      const N = need();
      return openFileHandle(N, N.openEntryAt(dirFd(directory), anchoredName(name), 0));
    },
    // Exclusive-creation write handle inside the pin: the same primitive
    // openWriteParent.openExclusive hands out, addressed through an existing
    // chain pin. writeFile/sync/close only; sync is fcntl(fd, F_FULLFSYNC).
    async openExclusive(directory, name, { mode = 0o600 } = {}) {
      const N = need();
      return openFileHandle(N, N.openExclusiveAt(dirFd(directory), anchoredName(name), mode));
    },
    // Namespace barrier through the pin itself: fcntl(fd, F_FULLFSYNC) on the
    // pinned directory descriptor, the same primitive openFileHandle.sync()
    // uses, so a completed rename or unlink survives power loss. A filesystem
    // that rejects the barrier fails the call — never a silent fsync
    // downgrade.
    async sync(directory) { need().fsyncFd(dirFd(directory)); },
    async mkdir(directory, name, mode = 0o755) { need().mkdirAt(dirFd(directory), anchoredName(name), mode); },
    async writeExclusive(directory, name, data) { need().writeExclusiveAt(dirFd(directory), anchoredName(name), toBuffer(data), 0o666); },
    async rename(fromDirectory, fromName, toDirectory, toName) {
      need().renameAt(dirFd(fromDirectory), anchoredName(fromName), dirFd(toDirectory), anchoredName(toName));
    },
    async removeTree(directory, name) { need().removeAt(dirFd(directory), anchoredName(name), 1); },
    async removeDirectoryIfEmpty(directory, name) { need().rmdirAt(dirFd(directory), anchoredName(name)); },
    async realpath(directory) { return need().getpathFd(dirFd(directory)); },
    // Adapter-issued single-component entry for bulk copy destinations; the
    // consumer never constructs native paths itself.
    destination: (directory, name) => destinationEntry(need(), directory, anchoredName(name)),
  },
};
