// macOS (darwin) durability barriers for the durable-persistence capability
// (platform/shared/persistence.mjs).
//
// Porting the Linux adapter verbatim would be a silent durability downgrade,
// so darwin gets its own real primitives:
//  - Apple's fsync(2) flushes the kernel cache to the drive but does not
//    force the drive's write cache to permanent storage; the documented
//    barrier that does is fcntl(fd, F_FULLFSYNC).
//  - Node's FileHandle.sync() is plain fsync(), and Node has no fcntl
//    binding, so both barriers go through the tiny N-API helper in
//    native/fullsync.c, built by native/build.mjs (plain clang against the
//    running Node's headers; see FULLSYNC_BUILD_COMMAND).
//  - Directory durability works the same way on APFS: open(directory,'r'),
//    fcntl(dirfd, F_FULLFSYNC), close. (Verified on real darwin/arm64 hosts:
//    the fcntl succeeds on directory descriptors; a plain directory fsync
//    also "succeeds" but does not force the rename to permanent storage.)
//
// Availability is a hard precondition, never a fallback: when the helper is
// missing or unloadable every operation rejects with
// PERSISTENCE_HELPER_UNAVAILABLE carrying the exact build command. There is
// deliberately NO plain-fsync fallback — that would keep succeeding while
// promising durability macOS had not delivered.
import {open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const ADDON_URL = new URL('./native/fullsync.node', import.meta.url);

export const FULLSYNC_BUILD_COMMAND = 'node apps/desktop/src/platform/darwin/native/build.mjs';

function helperUnavailable(cause) {
  return Object.assign(
    new Error(
      'macOS durable persistence requires the native F_FULLFSYNC helper (fcntl(fd, F_FULLFSYNC)); plain fsync is not a substitute. Build it first: ' + FULLSYNC_BUILD_COMMAND
    ),
    {
      code: 'PERSISTENCE_HELPER_UNAVAILABLE',
      platform: 'darwin',
      capability: 'durableAtomicReplace',
      buildCommand: FULLSYNC_BUILD_COMMAND,
      cause,
    }
  );
}

// Resolve the fcntl(fd, F_FULLFSYNC) primitive from the built addon. Failures
// are not cached, so a helper built while the host is running starts working
// on the next barrier without a process restart.
let cachedFullSync;
export function resolveFullSync(addonUrl = ADDON_URL) {
  try {
    const addon = createRequire(import.meta.url)(fileURLToPath(addonUrl));
    if (typeof addon?.fullSync !== 'function') throw new Error('native helper does not export fullSync(fd)');
    return addon.fullSync;
  } catch (error) {
    throw helperUnavailable(error);
  }
}

function fullSync() {
  cachedFullSync ??= resolveFullSync();
  return cachedFullSync;
}

// Honest readiness report for capability snapshots and probes.
export function fullSyncAvailability() {
  try {
    fullSync();
    return {available: true, platform: 'darwin', barrier: 'fcntl(fd, F_FULLFSYNC)', addon: fileURLToPath(ADDON_URL)};
  } catch (error) {
    return {available: false, platform: 'darwin', error};
  }
}

// Precondition for the shared adapter's requireSupported(): darwin counts as
// supported exactly when the real barrier is loadable. Throws the structured
// unavailable error (never a fallback) otherwise.
export function requireFullSyncHelper() {
  return fullSync();
}

// File-data barrier on an already open FileHandle: F_FULLFSYNC its descriptor.
export function syncFileBarrier(handle) {
  const barrier = fullSync();
  const fd = handle?.fd;
  if (!Number.isSafeInteger(fd) || fd < 0)
    throw Object.assign(new TypeError('darwin file barrier requires an open fs.promises.FileHandle'), {
      code: 'FULLFSYNC_BAD_ARGUMENT',
    });
  barrier(fd);
}

// Directory (namespace) barrier: F_FULLFSYNC the directory descriptor so a
// completed rename or unlink survives power loss.
export async function syncDirectory(directory) {
  const barrier = fullSync();
  const handle = await open(directory, 'r');
  try {
    barrier(handle.fd);
  } finally {
    await handle.close();
  }
}
