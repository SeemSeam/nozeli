import { createHash } from 'node:crypto';
import { anchorText } from './tag-anchors.mjs';

const MAX_TEXT = 8 * 1024 * 1024;
export const textDigest = text => createHash('sha256').update(text, 'utf8').digest('hex');
export class VersionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalid = message => { throw new VersionError('INVALID_PAYLOAD', message); };
const corrupt = () => { throw new VersionError('CHANGE_HISTORY_CORRUPT', '历史差异无法校验，原记录已保留；未修改任何文档。'); };
const unavailable = () => { throw new VersionError('HISTORY_VERSION_UNAVAILABLE', '此历史版本缺少可校验的正文快照，无法可靠对比。'); };
const headVersion = ledger => ({ docId: ledger.docId, revision: ledger.revision, digest: ledger.digest });

export function versionMetadata(ledger, revision) {
  const event = revision ? ledger.events[revision - 1] : null;
  return { docId: ledger.docId, revision, digest: event ? event.afterDigest : ledger.events.length ? ledger.events[0].beforeDigest : ledger.digest,
    eventId: event?.id ?? null, actor: event?.actor ?? null, time: event?.time ?? null, type: event?.type ?? 'baseline' };
}

export function listDocumentVersions(ledger, { cursor = null, limit = 50 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('每页版本应为1至100个。');
  const head = headVersion(ledger);
  if (cursor && (cursor.docId !== head.docId || cursor.revision !== head.revision || cursor.digest !== head.digest))
    throw new VersionError('STALE_HISTORY', '文件已出现新版本，请重新打开版本列表。');
  const before = cursor ? cursor.beforeRevision : ledger.revision + 1;
  if (!Number.isSafeInteger(before) || before < 1 || before > ledger.revision + 1) invalid('版本分页位置无效。');
  const versions = [];
  for (let revision = before - 1; revision >= 0 && versions.length < limit; revision--) versions.push(versionMetadata(ledger, revision));
  const last = versions.at(-1).revision;
  return { head, versions, total: ledger.revision + 1, nextCursor: last > 0 ? { ...head, beforeRevision: last } : null };
}

// Edits carry both coordinate systems. Checking the unchanged gaps as well as
// the inserted text prevents a valid-looking range from restoring the wrong copy.
export function reverseVersionEdits(after, edits) {
  let delta = 0, oldEnd = 0, newEnd = 0;
  const pieces = [];
  for (const edit of edits) {
    if (![edit.from, edit.to, edit.newFrom, edit.newTo].every(n => Number.isSafeInteger(n) && n >= 0)
      || typeof edit.removed !== 'string' || typeof edit.insert !== 'string'
      || edit.from < oldEnd || edit.newFrom < newEnd || edit.newFrom !== edit.from + delta
      || edit.to - edit.from !== edit.removed.length || edit.newTo - edit.newFrom !== edit.insert.length
      || edit.newTo > after.length || after.slice(edit.newFrom, edit.newTo) !== edit.insert
      || anchorText(edit.removed) !== edit.removed || anchorText(edit.insert) !== edit.insert) corrupt();
    pieces.push(after.slice(newEnd, edit.newFrom), edit.removed);
    delta += edit.insert.length - edit.removed.length;
    oldEnd = edit.to; newEnd = edit.newTo;
  }
  if (oldEnd > after.length - delta || after.length - delta > MAX_TEXT) corrupt();
  pieces.push(after.slice(newEnd));
  const before = pieces.join('');
  if (before.length !== after.length - delta) corrupt();
  return before;
}

async function fixedText(digest, getMaterial) {
  if (digest === null) return '';
  try {
    const bytes = await getMaterial(digest);
    if (bytes.length > MAX_TEXT) unavailable();
    return anchorText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error.code === 'MATERIAL_MISSING') return null;
    if (error.code === 'MATERIAL_CORRUPT' || error instanceof TypeError) corrupt();
    throw error;
  }
}

async function verifyText(text, digest, canonicalDigest, getMaterial) {
  if (canonicalDigest != null) { if (textDigest(text) !== canonicalDigest) corrupt(); return; }
  if (digest === null) { if (text !== '') corrupt(); return; }
  // Older records store the raw source digest. Recognize common UTF-8 byte
  // encodings without claiming that LF text reconstructs arbitrary raw bytes.
  const crlf = text.replaceAll('\n', '\r\n');
  if ([text, '\uFEFF' + text, crlf, '\uFEFF' + crlf].some(value => textDigest(value) === digest)) return;
  const stored = await fixedText(digest, getMaterial);
  if (stored === null) unavailable();
  if (stored !== text) corrupt();
}

export async function readDocumentVersion(ledger, requested, getMaterial) {
  if (!requested || !Number.isSafeInteger(requested.revision) || requested.revision < 0) invalid('请选择一个历史版本。');
  if (requested.docId !== ledger.docId || requested.revision > ledger.revision)
    throw new VersionError('STALE_HISTORY', '历史版本不属于此文件，请重新选择。');
  const version = versionMetadata(ledger, requested.revision);
  if (version.digest !== requested.digest) throw new VersionError('STALE_HISTORY', '历史版本摘要已变化，请重新选择。');
  let text = await fixedText(version.digest, getMaterial);
  let source = 'material';
  const canonical = version.revision ? ledger.events[version.revision - 1].afterTextDigest : ledger.events.length ? ledger.events[0].beforeTextDigest : ledger.textDigest;
  if (text !== null && canonical != null && textDigest(text) !== canonical) corrupt();
  if (text === null) {
    source = 'verified-edits'; text = ledger.text;
    await verifyText(text, ledger.digest, ledger.textDigest, getMaterial);
    for (let revision = ledger.revision; revision > version.revision; revision--) {
      const event = ledger.events[revision - 1];
      await verifyText(text, event.afterDigest, event.afterTextDigest, getMaterial);
      text = reverseVersionEdits(text, event.edits);
      await verifyText(text, event.beforeDigest, event.beforeTextDigest, getMaterial);
    }
  }
  return { relPath: ledger.relPath, kind: 'text', text, version, head: headVersion(ledger), textDigest: textDigest(text), source,
    offsetEncoding: 'UTF-16; LF line endings' };
}
