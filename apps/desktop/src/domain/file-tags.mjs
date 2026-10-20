import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { MaterialStore } from './material-store.mjs';

export class TagFileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export class FileTags {
  constructor(root) { this.root = root; this.directory = path.join(root, '.nozeli', 'tags'); this.materials = new MaterialStore(path.join(root, '.nozeli', 'materials'),{maxBytes:256*1024*1024}); }
  key(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes(':') || rel.includes('\0') || rel.split('/').some(p => !p || p === '.' || p === '..') || rel.split('/')[0] === '.nozeli') throw new TagFileError('BAD_PATH', 'Invalid document path.');
    return createHash('sha256').update(rel).digest('hex');
  }
  location(rel) { return path.join(this.directory, this.key(rel) + '.json'); }
  async ensure() {
    for (const dir of [path.join(this.root, '.nozeli'), this.directory, this.materials.directory]) {
      await fs.mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TagFileError('SYMLINK', 'Project metadata directory is not a regular directory.');
    }
  }
  async read(rel) {
    const file = this.location(rel);
    // Validate directory components before any read; hidden metadata is not trusted.
    for (const dir of [path.join(this.root, '.nozeli'), this.directory]) {
      const stat = await fs.lstat(dir).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (!stat) return null;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TagFileError('SYMLINK', 'Unsafe metadata directory.');
    }
    const stat = await fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new TagFileError('METADATA_CORRUPT', 'Invalid tag sidecar.');
    let value;
    try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new TagFileError('METADATA_CORRUPT', 'Tag sidecar JSON is invalid; kept unchanged.'); }
    if (!value || value.schemaVersion !== 1) throw new TagFileError('SCHEMA_UNSUPPORTED', 'Unknown tag format; kept unchanged.');
    if (!Number.isSafeInteger(value.nextOrdinal) || value.nextOrdinal < 1 || !Array.isArray(value.tags) || value.tags.some(tag => !Number.isSafeInteger(tag?.ordinal) || tag.ordinal < 1 || tag.ordinal >= value.nextOrdinal)) throw new TagFileError('METADATA_CORRUPT', 'Invalid tag numbering.');
    if (value.format !== 'nozeli.file-tags' || value.file?.relPath !== rel || !/^[0-9a-f-]{36}$/i.test(value.file?.fileId) || !Array.isArray(value.tags) || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.tags.some(tag => !/^[0-9a-f-]{36}$/i.test(tag.id) || tag.relPath !== rel || typeof tag.note !== 'string' || !tag.anchor || !/^[a-f0-9]{64}$/.test(tag.materialDigest)) || new Set(value.tags.map(t => t.id)).size !== value.tags.length) throw new TagFileError('METADATA_CORRUPT', 'Tag sidecar identity is invalid; kept unchanged.');
    return value;
  }
  async all() {
    const parent = await fs.lstat(path.join(this.root, '.nozeli')).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!parent) return [];
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new TagFileError('SYMLINK', 'Unsafe metadata directory.');
    const dir = await fs.lstat(this.directory).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!dir) return [];
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new TagFileError('SYMLINK', 'Unsafe tag directory.');
    const out = [];
    for (const name of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const stat = await fs.lstat(path.join(this.directory, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new TagFileError('METADATA_CORRUPT', 'Unsafe tag file.');
      let probe; try { probe = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')); } catch { throw new TagFileError('METADATA_CORRUPT', 'Invalid tag JSON.'); }
      if (this.key(probe.file?.relPath) + '.json' !== name) throw new TagFileError('METADATA_CORRUPT', 'Tag lookup name does not match document.');
      out.push(await this.read(probe.file.relPath));
    }
    return out;
  }
  async write(rel, value, expectedRevision = null) {
    await this.ensure();
    const lockPath = this.location(rel) + '.lock';
    const lock = await fs.open(lockPath, 'wx', 0o600).catch(error => {
      if (error.code === 'EEXIST') throw new TagFileError('ANNOTATION_CONFLICT', 'Tag sidecar is locked by another writer; no changes were made.');
      throw error;
    });
    try {
    const old = await this.read(rel);
    if ((old?.revision ?? null) !== expectedRevision) throw new TagFileError('ANNOTATION_CONFLICT', 'Tag sidecar was changed by another writer.');
    const next = { ...value, format: 'nozeli.file-tags', schemaVersion: 1, file: { ...value.file, fileId: old?.file.fileId || value.file?.fileId || randomUUID(), relPath: rel }, revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    if (Buffer.byteLength(JSON.stringify(next)) > 16 * 1024 * 1024) throw new TagFileError('METADATA_TOO_LARGE', 'Tag sidecar exceeds the size limit; existing data was kept.');
    const temp = path.join(this.directory, '.pending-' + randomUUID());
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600); await handle.writeFile(JSON.stringify(next, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = null;
      // Compare again after staging. Single-host writers also hold the metadata lock.
      if ((await this.read(rel))?.revision !== old?.revision) throw new TagFileError('ANNOTATION_CONFLICT', 'Tag sidecar changed during staging.');
      await fs.rename(temp, this.location(rel));
      if (process.platform !== 'win32') { const dir = await fs.open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    } finally { await handle?.close(); await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    return next;
    } finally { await lock.close(); await fs.unlink(lockPath); }
  }
}
