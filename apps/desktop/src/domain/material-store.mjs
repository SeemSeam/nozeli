import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export class MaterialError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'MaterialError';
    this.code = code;
  }
}

export const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex');

/** Host-only immutable byte store. The directory must be application-owned.
 * Publication uses an exclusive hard link: an existing digest is never replaced.
 * Unsupported filesystems fail explicitly. This is not a user-document save API.
 */
export class MaterialStore {
  constructor(directory, { maxBytes = 32 * 1024 * 1024 } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new MaterialError('INVALID_DIRECTORY', 'Material directory must be absolute.');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) {
      throw new MaterialError('INVALID_LIMIT', 'Invalid material byte limit.');
    }
    this.directory = path.resolve(directory);
    this.maxBytes = maxBytes;
  }

  location(digest) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new MaterialError('INVALID_DIGEST', 'Expected a SHA-256 content identifier.');
    }
    return path.join(this.directory, digest);
  }

  async ensureDirectory() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new MaterialError('INVALID_DIRECTORY', 'Material directory is not a regular directory.');
    }
  }

  async get(digest) {
    const file = this.location(digest);
    let handle;
    try {
      const directory = await fs.lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new MaterialError('INVALID_DIRECTORY', 'Material directory is not a regular directory.');
      }
      const entry = await fs.lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new MaterialError('INVALID_MATERIAL', 'Material is not a regular file.');
      }
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxBytes) {
        throw new MaterialError('MATERIAL_TOO_LARGE', 'Stored material exceeds the byte limit.');
      }
      const bytes = await handle.readFile();
      if (bytes.length > this.maxBytes) {
        throw new MaterialError('MATERIAL_TOO_LARGE', 'Stored material exceeds the byte limit.');
      }
      if (digestBytes(bytes) !== digest) {
        throw new MaterialError('MATERIAL_CORRUPT', 'Material content does not match its identifier.');
      }
      return bytes;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new MaterialError('MATERIAL_MISSING', 'The referenced material is unavailable.', { cause: error });
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async put(input) {
    if (!(input instanceof Uint8Array)) {
      throw new MaterialError('INVALID_BYTES', 'Material input must be bytes.');
    }
    if (input.byteLength > this.maxBytes) {
      throw new MaterialError('MATERIAL_TOO_LARGE', 'Material exceeds the byte limit.');
    }
    // Copy before the first await: later edits cannot change this submission.
    const bytes = Buffer.from(input);
    const digest = digestBytes(bytes), target = this.location(digest);
    const result = { digest, byteLength: bytes.length };
    await this.ensureDirectory();
    try {
      await this.get(digest);
      return result;
    } catch (error) {
      if (error.code !== 'MATERIAL_MISSING') throw error;
    }
    const temporary = path.join(this.directory, '.pending-' + randomUUID());
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await fs.link(temporary, target);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      // Also validates the winner when concurrent publication loses EEXIST.
      await this.get(digest);
      if (process.platform !== 'win32') {
        const directory = await fs.open(this.directory, constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return result;
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
