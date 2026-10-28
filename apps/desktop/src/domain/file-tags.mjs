import { randomUUID, createHash } from 'node:crypto';

export class TagFileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export class FileTags {
  // `namespace` separates review-candidate annotation records from same-path
  // project files: identical relPaths in different publications never share a
  // tag record. Materials stay content-addressed and shared.
  constructor({ storage, projectId, root, namespace }) { this.storage = storage; this.projectId = projectId; this.root = root; this.namespace = typeof namespace === 'string' && namespace ? namespace : null; }
  key(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes(':') || rel.includes('\0') || rel.split('/').some(p => !p || p === '.' || p === '..') || rel.split('/')[0] === '.nozeli') throw new TagFileError('BAD_PATH', 'Invalid document path.');
   const id = this.namespace ? this.namespace + '\0' + rel : rel;
   if (this.namespace && !/^review(-version)?\0/.test(this.namespace)) throw new TagFileError('BAD_PATH', 'Invalid annotation namespace.');
    return createHash('sha256').update(id).digest('hex');
  }
  putMaterial(bytes) { return this.storage.putObject(this.projectId, bytes); }
  getMaterial(digest) { return this.storage.readObject(this.projectId, digest); }
  validate(value, rel) {
    if (!value || value.schemaVersion !== 1) throw new TagFileError('SCHEMA_UNSUPPORTED', 'Unknown tag format; kept unchanged.');
    if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024) throw new TagFileError('METADATA_TOO_LARGE', 'Tag record exceeds the size limit; existing data was kept.');
    if (!Number.isSafeInteger(value.nextOrdinal) || value.nextOrdinal < 1 || !Array.isArray(value.tags) || value.tags.some(tag => !Number.isSafeInteger(tag?.ordinal) || tag.ordinal < 1 || tag.ordinal >= value.nextOrdinal)) throw new TagFileError('METADATA_CORRUPT', 'Invalid tag numbering.');
    if (value.format !== 'nozeli.file-tags' || value.file?.relPath !== rel || !/^[0-9a-f-]{36}$/i.test(value.file?.fileId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.tags.some(tag => !/^[0-9a-f-]{36}$/i.test(tag.id) || tag.relPath !== rel || typeof tag.note !== 'string' || !tag.anchor || !/^[a-f0-9]{64}$/.test(tag.materialDigest)) || new Set(value.tags.map(t => t.id)).size !== value.tags.length) throw new TagFileError('METADATA_CORRUPT', 'Tag record identity is invalid; kept unchanged.');
    return value;
  }
  async read(rel) {
    const value = await this.storage.getProject(this.projectId, 'file_tags', this.key(rel));
    return value == null ? null : this.validate(value, rel);
  }
  async all() {
    const rows = await this.storage.listProject(this.projectId, 'file_tags');
    return rows.flatMap(({ id, value }) => {
      // Namespaced review records share the collection; each store lists only
      // its own namespace and still rejects lookups that disagree with the key.
      if ((value?.reviewNamespace ?? null) !== this.namespace) return [];
      if (this.key(value?.file?.relPath) !== id) throw new TagFileError('METADATA_CORRUPT', 'Tag lookup does not match document.');
      return [this.validate(value, value.file.relPath)];
    });
  }
  async write(rel, value, expectedRevision = null) {
    const record = await this.storage.getProjectRecord(this.projectId, 'file_tags', this.key(rel));
    const old = record == null ? null : this.validate(record.value, rel);
    if ((old?.revision ?? null) !== expectedRevision) throw new TagFileError('ANNOTATION_CONFLICT', 'Tag record was changed by another writer.');
    const next = { ...value, format: 'nozeli.file-tags', schemaVersion: 1, ...(this.namespace ? { reviewNamespace: this.namespace } : {}), file: { ...value.file, fileId: old?.file.fileId || value.file?.fileId || randomUUID(), relPath: rel }, revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    if (Buffer.byteLength(JSON.stringify(next)) > 16 * 1024 * 1024) throw new TagFileError('METADATA_TOO_LARGE', 'Tag record exceeds the size limit; existing data was kept.');
    this.validate(next, rel);
    await this.storage.putProject(this.projectId, 'file_tags', this.key(rel), next, { expectedRevision: record?.revision ?? 0 });
    return next;
  }
}
