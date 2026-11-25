// Explicit injection for W1 qualification only. No production selector imports it.
import {Readable} from 'node:stream';
import {openExperimentalAnchoredRead} from './experimental-read.mjs';
import {unsupportedFilesystemAdapter} from '../shared/filesystem.mjs';
import {writablePath} from '../../agents/managed/file-stream.mjs';
import {createExperimentalWindowsPersistence} from './experimental-persistence.mjs';
import {createExperimentalWindowsProvisioning} from './experimental-provisioning.mjs';

export const experimentalWindowsReadFilesystem = Object.freeze({
  ...unsupportedFilesystemAdapter('win32', 'W1 experimental read-only adapter; product qualification incomplete'),
  id:'experimental-windows-handle-read',
  capabilities:Object.freeze({anchoredRead:true, anchoredWrite:false, gitFdSourcePaths:false}),
  async openAnchoredFile(root, relative) {
    let pin;
    try { pin = openExperimentalAnchoredRead(root, relative); }
    catch (error) {
      if (error.code === 'WIN32_IO_ERROR' && [2,3].includes(error.win32Code)) return null;
      throw error;
    }
    try {
      const facts = pin.stat();
      if (facts.size < 0n || facts.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw Object.assign(new Error('File exceeds experimental stream offset range'), {code:'FS_READ_LIMIT'});
      // Windows worktree files have no POSIX execute bits. Tracked executable
      // mode preservation is a separate, still unqualified Git policy.
      const stat = Object.freeze({...facts, mode:0o100644n, isFile:() => true});
      return {
        stat,
        stream:() => Readable.from((async function* () {
          let offset = 0;
          for (;;) {
            const chunk = pin.readAt(offset, 256 * 1024);
            if (!chunk.length) return;
            offset += chunk.length;
            yield chunk;
          }
        })(), {objectMode:false, highWaterMark:256 * 1024}),
        verify:async () => ({stable:pin.verify(), reason:'file'}),
        close:async () => pin.close(),
      };
    } catch (error) { pin.close(); throw error; }
  },
});

// Conservative managed-write policy until actual alias/case-sensitive-directory
// qualification is complete. Compare canonical spellings for denial only;
// never rewrite the path sent to the native bridge.
function managedWritePath(relative) {
  writablePath(relative);
  const comparable = relative.normalize('NFKC').toUpperCase().toLowerCase();
  writablePath(comparable);
  for (const component of comparable.split('/')) {
    if (component === '.ccb' || component.includes('~') ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)$/.test(component.split('.')[0].trim()))
      throw Object.assign(new Error('Unqualified Windows managed-write alias or reserved name'), {code:'PATH_REJECTED'});
  }
}

function versionedOptions(options) {
  if (typeof options.expectedNewSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedNewSha256))
    throw Object.assign(new Error('Approved candidate digest is required'), {code:'FS_VERSION_REJECTED'});
  if (options.mode !== undefined && options.mode !== '100644')
    throw Object.assign(new Error('Only regular non-executable Git mode is qualified'), {code:'FS_MODE_UNSUPPORTED'});
}

// Only these narrow operations are supplied. Generic rename/remove/chain remain
// unsupported so shared consumers cannot silently fall back to an unsafe write.
export const experimentalWindowsVersionedFilesystem = Object.freeze({
  ...experimentalWindowsReadFilesystem,
  id:'experimental-windows-versioned-files',
  provisioning:createExperimentalWindowsProvisioning(),
  capabilities:Object.freeze({...experimentalWindowsReadFilesystem.capabilities,
    versionedWrite:true, versionedWriteStream:true, versionedRemove:true}),
  validateWritePath:managedWritePath,
  async writeVersioned(root, relative, bytes, options = {}) {
    managedWritePath(relative);
    if (typeof bytes === 'string') bytes = Buffer.from(bytes);
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer))
      throw Object.assign(new Error('Expected non-shared candidate bytes'), {code:'FS_WRITE_LIMIT'});
    versionedOptions(options);
    return createExperimentalWindowsPersistence(root).writeStream(relative, [bytes], options);
  },
  async writeVersionedStream(root, relative, source, options = {}) {
    managedWritePath(relative); versionedOptions(options);
    return createExperimentalWindowsPersistence(root).writeStream(relative, source, options);
  },
  async removeVersioned(root, relative, options = {}) {
    managedWritePath(relative);
    return createExperimentalWindowsPersistence(root).removeVersioned(relative, options);
  },
});
