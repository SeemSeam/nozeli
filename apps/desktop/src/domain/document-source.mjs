// Native document identity shared by the workspace layout, the native host and
// the renderer. A document's source is either the project tree, a live review
// candidate publication, or a frozen review version snapshot. Identity is
// host-derived: renderers may propose a documentSource, but canonical
// resourceIds are always computed here and renderer-provided resourceIds for
// documents are ignored. The whole-work reviewVersion CAS token is NEVER part
// of document identity.

const VERSION_KINDS = new Set(['baseline', 'candidate', 'draft']);
const encode = encodeURIComponent;

export class DocumentSourceError extends Error {
  constructor(code, message) { super(message); this.name = 'DocumentSourceError'; this.code = code; }
}
const invalid = message => { throw new DocumentSourceError('INVALID_DOCUMENT_SOURCE', message); };
const identifier = (value, label) => {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f]/.test(value)) invalid(`文档来源的${label}无效。`);
  return value;
};
const exactKeys = (value, keys) => {
  const present = Object.keys(value);
  if (present.length !== keys.length || !keys.every(key => present.includes(key))) invalid('文档来源字段不被支持。');
};

// Returns the canonical source: {type:'project'} | {type:'review',workId,objectId}
// | {type:'review-version',workId,objectId,version:{kind,revision?}}.
// A draft version carries revision===null-ish "latest" only when omitted;
// baseline/candidate are frozen whole publications and never carry a revision.
export function validateDocumentSource(source) {
  if (source === undefined || source === null) return { type: 'project' };
  if (typeof source !== 'object' || Array.isArray(source)) invalid('文档来源必须是对象。');
  if (source.type === 'project') { exactKeys(source, ['type']); return { type: 'project' }; }
  if (source.type === 'review') {
    exactKeys(source, ['type', 'workId', 'objectId']);
    return { type: 'review', workId: identifier(source.workId, '工作标识'), objectId: identifier(source.objectId, '报告标识') };
  }
  if (source.type === 'review-version') {
    exactKeys(source, ['type', 'workId', 'objectId', 'version']);
    const version = source.version;
    if (typeof version !== 'object' || version === null || Array.isArray(version) || !VERSION_KINDS.has(version.kind)) invalid('审校版本种类无效。');
    const keys = Object.keys(version);
    if (version.kind === 'draft') {
      if (keys.length === 1) return { type: 'review-version', workId: identifier(source.workId, '工作标识'), objectId: identifier(source.objectId, '报告标识'), version: { kind: 'draft' } };
      exactKeys(version, ['kind', 'revision']);
      if (!Number.isSafeInteger(version.revision) || version.revision < 1) invalid('审校草稿版本号无效。');
      return { type: 'review-version', workId: identifier(source.workId, '工作标识'), objectId: identifier(source.objectId, '报告标识'), version: { kind: 'draft', revision: version.revision } };
    }
    exactKeys(version, ['kind']);
    return { type: 'review-version', workId: identifier(source.workId, '工作标识'), objectId: identifier(source.objectId, '报告标识'), version: { kind: version.kind } };
  }
  invalid('未知文档来源类型。');
}
// Classifier for ALREADY-VALIDATED sources and legacy view fields where an
// absent source means the project tree. It is never a substitute for
// validateDocumentSource at trust boundaries.
export function isProjectDocumentSource(source) {
  return source === undefined || source === null || source?.type === 'project';
}
export function sameDocumentSource(a, b) {
  const left = isProjectDocumentSource(a) ? null : a, right = isProjectDocumentSource(b) ? null : b;
  if (!left !== !right) return false;
  if (!left) return true;
  if (left.type !== right.type) return false;
  if (left.workId !== right.workId || left.objectId !== right.objectId) return false;
  if (left.type === 'review') return true;
  return left.version.kind === right.version.kind && (left.version.revision ?? null) === (right.version.revision ?? null);
}
export function documentSourceLabel(source) {
  if (isProjectDocumentSource(source)) return 'project';
  if (source.type === 'review') return `review/${source.workId}/${source.objectId}`;
  return `review-version/${source.workId}/${source.objectId}/${source.version.kind}${source.version.revision ? `/${source.version.revision}` : ''}`;
}

// Canonical layout resourceId. The project branch intentionally keeps the
// legacy 'document:'+relPath form so existing saved layouts stay valid.
export function documentResourceId(projectId, source, relPath) {
  if (typeof relPath !== 'string' || !relPath) invalid('文档路径无效。');
  // Canonicalize first: a duck-typed "project-looking" input must never
  // short-circuit into the project namespace. Exact-key validation runs
  // before any branch, so malformed sources fail closed at every caller.
  const canonical = validateDocumentSource(source);
  if (canonical.type === 'project') return 'document:' + relPath;
  const head = canonical.type === 'review' ? 'document:review:' : 'document:review-version:';
  const version = canonical.type === 'review-version' ? ':' + canonical.version.kind + (canonical.version.revision ? ':' + canonical.version.revision : '') : '';
  return `${head}${encode(canonical.workId)}:${encode(canonical.objectId)}${version}:${encode(relPath)}`;
}

// Internal lease/buffer/mirror key for one editable document in one project.
export function documentKey(projectId, source, relPath) {
  return `${projectId}\0${documentResourceId(projectId, source, relPath)}`;
}

// Storage namespace for review-scoped FileTags records: annotations of one
// publication never mix with same-path project files or other publications.
export function reviewTagNamespace(source) {
  const canonical = validateDocumentSource(source);
  if (canonical.type === 'review') return `review\0${canonical.workId}\0${canonical.objectId}`;
  const version = canonical.version.revision ? `${canonical.version.kind}:${canonical.version.revision}` : canonical.version.kind;
  return `review-version\0${canonical.workId}\0${canonical.objectId}\0${version}`;
}
