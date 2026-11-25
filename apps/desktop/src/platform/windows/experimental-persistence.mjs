// Explicit qualification entry; never selected by shared production persistence.
import {createRequire} from 'node:module';
import {createHash, randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
const require = createRequire(import.meta.url);

async function lockedDigest(transaction, checkAbort) {
  const hash = createHash('sha256');
  for (let offset = 0;;) {
    checkAbort();
    const chunk = transaction.readChunk(offset, 256 * 1024);
    if (!chunk.length) return hash.digest('hex');
    hash.update(chunk); offset += chunk.length;
    await setImmediate();
  }
}

export function openExperimentalPersistenceParent(root, relative) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Object.assign(Error('Native Windows x64 required'), {code:'FS_PLATFORM_UNSUPPORTED'});
  return require('../../../native/windows/build/Release/nozeli_windows_read.node').openAnchoredPersistenceParent(root, relative);
}

// Root-scoped so the native chain validates every component. An absent expected
// digest means create-only, never an unconditional overwrite of an existing file.
// A successful result records actual barriers, not a product durability grant.
export function createExperimentalWindowsPersistence(root, {
  directorySync = parent => parent.syncDirectory(),
} = {}) {
  if (typeof directorySync !== 'function') throw new TypeError('Expected directorySync function');
  const writeStream = async (relative, source, {expectedSha256 = null, expectedNewSha256 = null, signal, checkpoint, beforePublish} = {}) => {
      if (checkpoint !== undefined && typeof checkpoint !== 'function') throw new TypeError('Expected checkpoint function');
      if (beforePublish !== undefined && typeof beforePublish !== 'function') throw new TypeError('Expected synchronous beforePublish function');
      if (expectedSha256 !== null && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)))
        throw Object.assign(Error('Expected lowercase SHA-256 or null for create-only'), {code:'FS_VERSION_REJECTED'});
      if (expectedNewSha256 !== null && (typeof expectedNewSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedNewSha256)))
        throw Object.assign(Error('Expected lowercase candidate SHA-256'), {code:'FS_VERSION_REJECTED'});
      if (!source || typeof source === 'string' || source instanceof Uint8Array ||
          (typeof source[Symbol.asyncIterator] !== 'function' && typeof source[Symbol.iterator] !== 'function'))
        throw Object.assign(Error('Expected an iterable of non-shared byte chunks'), {code:'FS_WRITE_LIMIT'});
      const checkAbort = () => {if (signal?.aborted) throw Object.assign(Error('Versioned write aborted'), {code:'ABORT_ERR'});};
      checkAbort();
      const parent = openExperimentalPersistenceParent(root, relative);
      let stage, transaction, published = false, primaryError;
      try {
        const target = relative.split('/').at(-1);
        const temporary = `.nozeli-${randomUUID()}.pending`;
        if (expectedSha256 === null) {
          if (checkpoint) await checkpoint('create');
          stage = parent.createPrivateExclusive(temporary);
        } else {
          transaction = parent.beginReplacement(target);
          const actualSha256 = await lockedDigest(transaction, checkAbort);
          if (actualSha256 !== expectedSha256)
            throw Object.assign(Error('Locked target differs from the expected version'), {
              code:'FS_VERSION_CONFLICT', expectedSha256, actualSha256,
            });
          if (checkpoint) await checkpoint('create');
          transaction.beginCandidate(temporary);
        }
        if (checkpoint) await checkpoint('write');
        const candidateHash = createHash('sha256');
        for await (const bytes of source) {
          if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer))
            throw Object.assign(Error('Expected non-shared Uint8Array source chunks'), {code:'FS_WRITE_LIMIT'});
          for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
            checkAbort();
            const chunk = bytes.subarray(offset, offset + 256 * 1024);
            if (transaction) transaction.writeCandidate(chunk); else stage.write(chunk);
            candidateHash.update(chunk);
            await setImmediate();
          }
        }
        const actualNewSha256 = candidateHash.digest('hex');
        if (expectedNewSha256 !== null && actualNewSha256 !== expectedNewSha256)
          throw Object.assign(Error('Candidate stream differs from its approved digest'), {
            code:'FS_CANDIDATE_CONFLICT', expectedSha256:expectedNewSha256, actualSha256:actualNewSha256,
          });
        checkAbort();
        if (checkpoint) await checkpoint('file-sync');
        if (transaction) {
          transaction.finishCandidate();
          if (checkpoint) await checkpoint('rename');
          checkAbort();
          if (beforePublish?.()?.then) throw new TypeError('beforePublish must be synchronous');
          transaction.commit();published = true;
          transaction.close();transaction = undefined;
        } else {
          stage.sync();
          if (checkpoint) await checkpoint('rename');
          checkAbort();
          if (beforePublish?.()?.then) throw new TypeError('beforePublish must be synchronous');
          stage.publishNew(target);published = true;
          stage.close();stage = undefined;
        }
        await directorySync(parent);
        return {schema:1, platform:'win32', state:'barriers-completed', published:true,
          durability:'namespace-not-qualified', barriers:{file:'flushed', directory:'flushed'}};
      } catch (cause) {
        const error = cause instanceof Error ? cause : Object.assign(Error('Versioned publication failed', {cause}), {code:'FS_WRITE_FAILED'});
        primaryError = error;
        if (published || error.committed) {error.committed = true;error.durability = 'uncertain';}
        throw error;
      } finally {
        const cleanupErrors = [];
        for (const resource of [transaction, stage, parent]) {
          try {resource?.close();} catch (error) {cleanupErrors.push(error);}
        }
        if (cleanupErrors.length) {
          if (primaryError) primaryError.cleanupErrors = cleanupErrors;
          else {
            const error = cleanupErrors[0];
            if (published) {error.committed = true;error.durability = 'uncertain';}
            throw error;
          }
        }
      }
  };
  return Object.freeze({
    platform:'win32', supported:false,
    writeStream,
    async removeVersioned(relative, {expectedSha256, signal} = {}) {
      if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256))
        throw Object.assign(Error('A lowercase SHA-256 base version is required for deletion'), {code:'FS_VERSION_REJECTED'});
      const checkAbort = () => {if (signal?.aborted) throw Object.assign(Error('Versioned deletion aborted'), {code:'ABORT_ERR'});};
      checkAbort();
      const parent = openExperimentalPersistenceParent(root, relative);
      let transaction, published = false, primaryError;
      try {
        transaction = parent.beginReplacement(relative.split('/').at(-1));
        const actualSha256 = await lockedDigest(transaction, checkAbort);
        if (actualSha256 !== expectedSha256)
          throw Object.assign(Error('Locked target differs from the expected deletion version'), {
            code:'FS_VERSION_CONFLICT', expectedSha256, actualSha256,
          });
        checkAbort();
        transaction.prepareDelete(); transaction.commit(); published = true;
        transaction.close(); transaction = undefined;
        await directorySync(parent);
        return {schema:1, platform:'win32', state:'barriers-completed', published:true, deleted:true,
          durability:'namespace-not-qualified', barriers:{directory:'flushed'}};
      } catch (cause) {
        const error = cause instanceof Error ? cause : Object.assign(Error('Versioned deletion failed', {cause}), {code:'FS_WRITE_FAILED'});
        primaryError = error;
        if (published || error.committed) {error.committed = true;error.durability = 'uncertain';}
        throw error;
      } finally {
        const cleanupErrors = [];
        for (const resource of [transaction, parent]) {
          try {resource?.close();} catch (error) {cleanupErrors.push(error);}
        }
        if (cleanupErrors.length) {
          if (primaryError) primaryError.cleanupErrors = cleanupErrors;
          else {
            const error = cleanupErrors[0];
            if (published) {error.committed = true;error.durability = 'uncertain';}
            throw error;
          }
        }
      }
    },
    async writeAtomic(relative, bytes, options = {}) {
      if (typeof bytes === 'string') bytes = Buffer.from(bytes);
      if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteLength > 1048576)
        throw Object.assign(Error('Expected string or non-shared Uint8Array, at most 1048576 bytes'), {code:'FS_WRITE_LIMIT'});
      return writeStream(relative, [bytes], options);
    },
  });
}
