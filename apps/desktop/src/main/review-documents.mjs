import { createHash } from 'node:crypto';
import { HostError } from './host.mjs';
import { readDraftRecord, draftTextFor, normalizeReviewText, reviewDraftBytes, REVIEW_TEXT_MAX_BYTES, REVIEW_REQUEST_KEY } from '../agents/managed/review-candidate.mjs';
import { readManagedObject } from '../agents/managed/managed-storage.mjs';
import { documentResourceId, validateDocumentSource } from '../domain/document-source.mjs';
import { imageInfo } from './image-format.mjs';
const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');
const binaryKind = (relPath, bytes) => {
  const head = bytes.subarray(0, 8).toString('latin1');
  if (head.startsWith('%PDF-')) return 'pdf';
  if (head.startsWith('PK\x03\x04')) {
    const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
    return ext === '.docx' ? 'word' : ext === '.xlsx' ? 'sheet' : ext === '.pptx' ? 'ppt' : 'unsupported';
  }
  if (head.startsWith('BM') || bytes[0] === 0x89 && bytes[1] === 0x50) return 'image';
  return 'unsupported';
};
const omittedReason = value => value === 'size' || value === 'binary' ? `frozen-${value}` : value ?? 'frozen-unavailable';

// Host-side review document adapter: the single bridge between ordinary
// file.*/document.*/annotation.*/tag.* operations and the managed review
// controller (managed.review.read / managed.review.save). The controller stays
// the only content authority; this module never touches the project worktree
// and never falls back to same-path project files.
export function createReviewDocumentAdapter({ host, managed }) {
  const invoke = (op, payload) => managed.invoke(op, payload);
  const resourceIdOf = (projectId, source, relPath) => documentResourceId(projectId, source, relPath);

  // The last saved human draft revision per document key. Old publications
  // keep presenting their own final draft after the ledger moves on; the pin
  // also survives restarts so cold recovery never reverts to a newer candidate.
  // Per-project pin serialization: two candidate windows saving concurrently
  // must never lose the other document's last-draft revision.
  const pinLocks = new Map();
  const pinned = (projectId, work) => {
    const run = (pinLocks.get(projectId) ?? Promise.resolve()).catch(() => {}).then(work);
    pinLocks.set(projectId, run.catch(() => {}));
    return run;
  };
  async function readPins(projectId) {
    return (await host.storage.getLocal(projectId, 'review-documents')) ?? { schema: 1, pins: {} };
  }
  function writePin(projectId, source, relPath, entry, preSave) {
    return pinned(projectId, async () => {
      const record = await readPins(projectId);
      const key = resourceIdOf(projectId, source, relPath);
      record.pins[key] = entry;
      // The pre-save body of the newest revision: an idempotent file.save with
      // anchor changes stages its mapping against this, exactly once.
      if (preSave === null) delete (record.preSave ??= {})[key];
      else if (preSave) (record.preSave ??= {})[key] = preSave;
      await host.storage.putLocal(projectId, 'review-documents', record);
    });
  }
  function readPreSave(projectId, source, relPath) {
    return pinned(projectId, async () => (await readPins(projectId)).preSave?.[resourceIdOf(projectId, source, relPath)] ?? null);
  }
  async function pinnedRevision(projectId, source, relPath) {
    const record = await readPins(projectId);
    const pin = record.pins[resourceIdOf(projectId, source, relPath)];
    return pin && pin.objectId === source.objectId ? pin.draftRevision : null;
  }

  async function reviewFile(projectId, source, relPath) {
    const value = await invoke('managed.review.read', { projectId, workId: source.workId, objectId: source.objectId, relPath });
    const file = (value.files || []).find(entry => entry.relPath === relPath) ?? null;
    if (!file) throw new HostError('NOT_FOUND', '此文件不在该发布的审校清单中；未读取项目源文件。', { relPath });
    return { value, file };
  }
  // A missing object reads as absent; storage corruption must surface instead
  // of silently falling back to another body.
  async function objectBytes(projectId, digest) {
    try { return await readManagedObject(host.storage, projectId, digest,{maxBytes:32*1024*1024}); }
    catch (error) { if (['NOT_FOUND', 'OBJECT_MISSING', 'MATERIAL_MISSING', 'MATERIAL_TOO_LARGE', 'ENOENT'].includes(error.code)) return null; throw error; }
  }
  async function candidateBytes(projectId, value, file) {
    if (typeof file.candidateText === 'string') return Buffer.from(file.candidateText, 'utf8');
    const entry = (value.candidate?.files || []).find(row => row.relPath === file.relPath);
    if (entry?.objectDigest) return objectBytes(projectId, entry.objectDigest);
    if (file.material?.candidate?.digest && file.material.candidate.available === true) return objectBytes(projectId, file.material.candidate.digest);
    return null;
  }
  // Resolves the exact body this document currently presents, plus where it
  // came from. A live publication shows its saved human draft; a decided or
  // superseded one keeps its own final draft (accepted binding, host pin or
  // durable history) and never silently adopts a newer candidate.
  async function resolveBody(projectId, source, relPath) {
    const { value, file } = await reviewFile(projectId, source, relPath);
    const record = await readDraftRecord(host.storage, projectId, source.workId);
    if (source.type === 'review-version') {
      const kind = source.version.kind;
      if (kind === 'baseline') {
        if (typeof file.baselineText === 'string') return { value, file, text: file.baselineText, digest: file.baselineDigest, origin: 'baseline' };
        if (file.material?.baseline?.available === true) {
          const bytes = await objectBytes(projectId, file.material.baseline.digest);
          if (bytes) return { value, file, text: null, digest: file.baselineDigest, bytes, origin: 'baseline' };
        }
        return { value, file, text: null, digest: file.baselineDigest ?? null, origin: 'baseline', unavailable: file.material?.baseline?.reason || 'baseline-unavailable' };
      }
      if (kind === 'candidate') {
        const bytes = await candidateBytes(projectId, value, file);
        return { value, file, text: typeof file.candidateText === 'string' ? file.candidateText : null, digest: file.candidateDigest ?? null, bytes, origin: 'candidate', unavailable: file.candidateText == null && !bytes ? omittedReason(file.textOmitted) : null };
      }
      const revision = source.version.revision ?? file.draft?.revision ?? null;
      const text = revision == null ? null : draftTextFor(record, relPath, revision);
      if (text != null) return { value, file, text, digest: reviewDraftBytes(text).digest, origin: 'draft', revision };
      return { value, file, text: null, digest: null, origin: 'draft', revision, unavailable: 'draft-revision' };
    }
    if (file.draft && typeof file.draft.text === 'string') {
      return { value, file, text: file.draft.text, digest: file.draft.textDigest ?? reviewDraftBytes(file.draft.text).digest, origin: 'draft', revision: file.draft.revision, savedAt: file.draft.savedAt };
    }
    const accepted = value.accepted?.files?.find(row => row.relPath === relPath);
    if (accepted) {
      if (accepted.draftRevision != null) {
        const text = draftTextFor(record, relPath, accepted.draftRevision);
        if (text != null) return { value, file, text, digest: accepted.reviewedDigest, origin: 'accepted-draft', revision: accepted.draftRevision };
      }
      if (accepted.reviewedDigest === file.candidateDigest) {
        const bytes = await candidateBytes(projectId, value, file);
        return { value, file, text: typeof file.candidateText === 'string' ? file.candidateText : null, digest: file.candidateDigest ?? null, bytes, origin: 'accepted-candidate' };
      }
    }
    const pin = await pinnedRevision(projectId, source, relPath);
    if (pin != null) {
      const text = draftTextFor(record, relPath, pin);
      if (text != null) return { value, file, text, digest: reviewDraftBytes(text).digest, origin: 'retained', revision: pin };
      return { value, file, text: null, digest: null, origin: 'retained', revision: pin, unavailable: 'draft-history-evicted' };
    }
    const bytes = await candidateBytes(projectId, value, file);
    return { value, file, text: typeof file.candidateText === 'string' ? file.candidateText : null, digest: file.candidateDigest ?? null, bytes, origin: 'candidate', unavailable: file.candidateText == null && !bytes ? omittedReason(file.textOmitted) : null };
  }
  function editableOf(source, value, file) {
    if (source.type !== 'review') return false;
    // The whole-work continuation record persists after apply; per-file
    // editable + stale + capabilities decide editability for THIS publication.
    return file.editable === true && !value.stale && value.status !== 'ended' && value.capabilities?.canSave !== false;
  }
  function reviewMeta(source, resolved) {
    const { value, file, digest, origin, revision, unavailable, bytes } = resolved;
    return {
      workId: source.workId, objectId: source.objectId, ...(source.type === 'review-version' ? { version: source.version } : {}),
      change: file.change ?? file.status ?? null, status: file.status ?? null, oldPath: file.oldPath ?? null,
      counts: { added: file.added ?? null, deleted: file.deleted ?? null, binary: file.binary === true, unsupportedReason: file.unsupportedReason ?? null },
      humanEdited: file.humanEdited === true,
      baselineDigest: file.baselineDigest ?? null, candidateDigest: file.candidateDigest ?? null,
      baselineUnavailable: file.baselineUnavailable === true, textOmitted: file.textOmitted ?? null,
      draftRevision: revision ?? 0, textDigest: digest ?? null, reviewVersion: value.reviewVersion ?? null,
      editable: editableOf(source, value, file), stale: value.stale ?? null,
      accepted: value.accepted ? { reviewVersion: value.accepted.reviewVersion, at: value.accepted.at ?? null } : null,
      continuation: value.continuation ?? null, merge: value.merge ?? null,
      origin,
      ...(unavailable ? { unavailable } : {}),
      byteLength: resolved.text != null ? Buffer.byteLength(resolved.text, 'utf8') : bytes?.length ?? file.material?.candidate?.bytes ?? null,
    };
  }

  return {
    async read({ projectId, source, relPath }) {
      const canonical = validateDocumentSource(source);
      if (canonical.type === 'project') throw new HostError('INVALID_PAYLOAD', '项目文档不经审校适配器读取。');
      await host.requireRegisteredProject(projectId);
      const resolved = await resolveBody(projectId, canonical, relPath);
      const text = resolved.text;
      const bytes = text != null ? Buffer.from(text, 'utf8') : resolved.bytes ?? null;
      const kind = text != null ? 'text' : bytes ? binaryKind(relPath, bytes) : 'unsupported';
      return {
        relPath, kind,
        unsupportedReason: bytes ? null : omittedReason(resolved.unavailable),
        digest: resolved.digest ?? (bytes ? digestOf(bytes) : null),
        materialDigest: bytes ? digestOf(bytes) : null,
        byteLength: bytes?.length ?? 0,
        text,
        bytes: ['image', 'pdf', 'word', 'sheet', 'ppt'].includes(kind) ? bytes : null,
        encoding: kind === 'text' ? 'utf-8' : null,
        authorship: null, authorshipText: null, authorshipError: null, image: kind === 'image' && bytes ? imageInfo(bytes) : null,
        draft: null, draftError: null, sourceChanged: false, diskPresent: false, mtimeMs: null,
        documentSource: canonical, readOnly: kind !== 'text' ? true : !editableOf(canonical, resolved.value, resolved.file),
        review: reviewMeta(canonical, resolved),
      };
    },
    async currentBytes({ projectId, source, relPath }) {
      const canonical = validateDocumentSource(source);
      if (canonical.type === 'project') return null;
      const resolved = await resolveBody(projectId, canonical, relPath);
      return resolved.text != null ? Buffer.from(resolved.text, 'utf8') : resolved.bytes ?? null;
    },
    async save({ projectId, source, relPath, text, expectedDraftRevision, anchorChanges = null, mode = 'save' }) {
      const canonical = validateDocumentSource(source);
      if (canonical.type === 'review-version') throw new HostError('READONLY', '冻结审校版本只读；恢复为当前稿请在候选文档中操作。');
      if (typeof text !== 'string') throw new HostError('INVALID_PAYLOAD', '审校正文必须是字符串。');
      if (Buffer.byteLength(text, 'utf8') > REVIEW_TEXT_MAX_BYTES) throw new HostError('REVIEW_TEXT_TOO_LARGE', '审校正文超过2MiB上限；请缩减内容。');
      await host.requireRegisteredProject(projectId);
      const normalized = normalizeReviewText(text);
      const { digest } = reviewDraftBytes(normalized);
      // Single content authority: a file.draft → file.save round-trip of the
      // SAME text replays the existing draft receipt instead of writing a
      // second revision through reviewSave; anchor staging runs only when a
      // new revision was actually written (before-body captured pre-save).
      const current = await reviewFile(projectId, canonical, relPath);
      const active = current.file.draft && current.file.draft.textDigest === digest && (typeof current.file.draft.text !== 'string' || current.file.draft.text === normalized) ? current.file.draft : null;
      if (active && (expectedDraftRevision === undefined || expectedDraftRevision === active.revision)) {
        let anchorMappingsStaged = false, anchorMappingsUnavailable = false;
        if (anchorChanges) {
          const preSave = await readPreSave(projectId, canonical, relPath);
          if (preSave && preSave.textDigest === digest && typeof preSave.before === 'string') {
            await host.stageTagMappings(projectId, relPath, Buffer.from(preSave.before, 'utf8'), Buffer.from(normalized, 'utf8'), anchorChanges, canonical);
            await writePin(projectId, canonical, relPath, { objectId: canonical.objectId, draftRevision: active.revision, savedAt: active.savedAt }, null);
            anchorMappingsStaged = true;
          } else anchorMappingsUnavailable = true;
        }
        const flags = { ...(anchorMappingsStaged ? { anchorMappingsStaged } : {}), ...(anchorMappingsUnavailable ? { anchorMappingsUnavailable } : {}) };
        if (mode === 'draft') return { draft: { text: normalized, baseDigest: null, status: 'draft', updatedAt: active.savedAt, lastError: null }, digest, materialDigest: digest, draftRevision: active.revision, reviewVersion: current.value.reviewVersion ?? null, documentSource: canonical, idempotent: true, ...flags };
        return { saved: true, relPath, digest, materialDigest: digest, draftRevision: active.revision, reviewVersion: current.value.reviewVersion ?? null, savedAt: active.savedAt, documentSource: canonical, workId: canonical.workId, idempotent: true, ...flags };
      }
      const before = await this.currentBytes({ projectId, source: canonical, relPath });
      const result = await invoke('managed.review.save', { projectId, workId: canonical.workId, objectId: canonical.objectId, relPath, text: normalized, expectedDraftRevision: Number.isSafeInteger(expectedDraftRevision) ? expectedDraftRevision : 0 });
      await writePin(projectId, canonical, relPath, { objectId: canonical.objectId, draftRevision: result.draftRevision, savedAt: result.savedAt }, { textDigest: digest, before: before === null ? null : before.toString('utf8') });
      if (anchorChanges && before != null) await host.stageTagMappings(projectId, relPath, before, Buffer.from(normalized, 'utf8'), anchorChanges, canonical);
      if (mode === 'draft') return { draft: { text: normalized, baseDigest: null, status: 'draft', updatedAt: result.savedAt, lastError: null }, digest, materialDigest: digest, draftRevision: result.draftRevision, reviewVersion: result.reviewVersion ?? null, documentSource: canonical };
      return { saved: true, relPath, digest, materialDigest: digest, draftRevision: result.draftRevision, reviewVersion: result.reviewVersion ?? null, savedAt: result.savedAt, documentSource: canonical, workId: canonical.workId };
    },
    async versions({ projectId, source, relPath, cursor = null, limit = 50 }) {
      const canonical = validateDocumentSource(source);
      if (canonical.type === 'project') throw new HostError('INVALID_PAYLOAD', '项目文档使用普通版本账本。');
      const { value, file } = await reviewFile(projectId, canonical, relPath);
      const rows = (file.versions || []).map(entry => ({
        kind: entry.kind, ...(Number.isSafeInteger(entry.revision) ? { revision: entry.revision } : {}),
        digest: entry.digest ?? null, at: entry.savedAt ?? entry.at ?? value.candidate?.publishedAt ?? null,
        actor: entry.actor?.kind ?? (entry.kind === 'draft' ? 'user' : 'worker'), ...(entry.actor?.name ? { actorName: entry.actor.name } : {}), ...(entry.commit ? { commit: entry.commit } : {}),
      }));
      rows.sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0) || String(b.at ?? '').localeCompare(String(a.at ?? '')));
      const start = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0;
      const page = rows.slice(start, start + Math.min(Math.max(limit, 1), 100));
      return { versions: page, ...(start + page.length < rows.length ? { cursor: start + page.length } : {}), readOnly: !editableOf(canonical, value, file) };
    },
    async version({ projectId, source, relPath, version }) {
      const canonical = validateDocumentSource(source);
      if (canonical.type === 'project') throw new HostError('INVALID_PAYLOAD', '项目文档使用普通版本账本。');
      if (!version || !['baseline', 'candidate', 'draft'].includes(version.kind) || version.kind !== 'draft' && version.revision !== undefined) throw new HostError('INVALID_PAYLOAD', '审校版本引用无效。');
      const target = canonical.type === 'review-version' && version.kind === canonical.version.kind && (version.revision ?? null) === (canonical.version.revision ?? null)
        ? canonical
        : { type: 'review-version', workId: canonical.workId, objectId: canonical.objectId, version: { kind: version.kind, ...(version.revision !== undefined ? { revision: version.revision } : {}) } };
      const resolved = await resolveBody(projectId, target, relPath);
      const bytes = resolved.text != null ? Buffer.from(resolved.text, 'utf8') : resolved.bytes ?? null;
      const digest = resolved.digest ?? (bytes ? digestOf(bytes) : null);
      return {
        relPath,
        kind: resolved.text != null ? 'text' : bytes ? binaryKind(relPath, bytes) : 'unsupported',
        unsupportedReason: bytes ? null : omittedReason(resolved.unavailable),
        text: resolved.text,
        bytes: bytes && ['image', 'pdf', 'word', 'sheet', 'ppt'].includes(binaryKind(relPath, bytes)) ? bytes : null,
        digest, materialDigest: bytes ? digestOf(bytes) : null,
        byteLength: bytes?.length ?? 0,
        version: { kind: version.kind, ...(version.revision !== undefined ? { revision: version.revision } : {}), digest, at: resolved.savedAt ?? null, actor: version.kind === 'draft' ? 'user' : 'worker' },
        documentSource: canonical, readOnly: true,
        ...(resolved.text == null && resolved.unavailable ? { unavailable: resolved.unavailable } : {}),
      };
    },
    // Allowed annotation materials: the frozen candidate bytes plus every saved
    // human draft body of this publication. Never the same-path project file.
    async materials({ projectId, source, relPath }) {
      const canonical = validateDocumentSource(source);
      if (canonical.type === 'project') throw new HostError('INVALID_PAYLOAD', '项目文档材料走普通来源。');
      const out = new Map();
      const { value, file } = await reviewFile(projectId, canonical, relPath);
      const candidate = await candidateBytes(projectId, value, file);
      if (candidate && file.candidateDigest) out.set(file.candidateDigest, candidate);
      const record = await readDraftRecord(host.storage, projectId, canonical.workId);
      const pushRevision = revision => {
        if (!Number.isSafeInteger(revision)) return;
        const text = draftTextFor(record, relPath, revision);
        if (text == null) return;
        out.set(reviewDraftBytes(text).digest, Buffer.from(text, 'utf8'));
      };
      if (canonical.type === 'review-version' && canonical.version.kind === 'draft') pushRevision(canonical.version.revision ?? record.files?.[relPath]?.revision ?? null);
      else if (canonical.type === 'review') {
        if (typeof file.draft?.text === 'string' && file.draft.revision != null) out.set(file.draft.textDigest ?? reviewDraftBytes(file.draft.text).digest, Buffer.from(file.draft.text, 'utf8'));
        if (file.draft?.revision != null) pushRevision(file.draft.revision);
        for (const row of (file.history || [])) if (row.objectId === canonical.objectId) pushRevision(row.revision);
        const accepted = value.accepted?.files?.find(row => row.relPath === relPath);
        if (accepted?.draftRevision != null) pushRevision(accepted.draftRevision);
        pushRevision(await pinnedRevision(projectId, canonical, relPath));
      }
      return out;
    },
  };
}

// Cross-document decision barrier: flush every candidate writer and report
// owner of the publication, protect same-path project documents, recompute the
// whole-work token and only then run accept/continue with the user-confirmed
// token. A changed token aborts for explicit re-confirmation — never adopted.
export async function runReviewDecision({ workspace, managed, host, payload }) {
  const { projectId, workId, objectId, action, reviewVersion, requestKey } = payload ?? {};
  if (!['accept', 'continue'].includes(action)) throw new HostError('INVALID_PAYLOAD', '审核决定只能是接受或继续。');
  if (typeof reviewVersion !== 'string' || !/^[a-f0-9]{64}$/.test(reviewVersion)) throw new HostError('INVALID_PAYLOAD', '审校版本令牌无效。');
  if (typeof requestKey !== 'string' || !REVIEW_REQUEST_KEY.test(requestKey)) throw new HostError('INVALID_PAYLOAD', '决定确认身份无效。');
  if (action === 'continue' && payload.instruction != null && (typeof payload.instruction !== 'string' || payload.instruction.length > 4000)) throw new HostError('INVALID_PAYLOAD', '续作补充要求无效。');
  await host.requireRegisteredProject(projectId);
  const initial = await managed.invoke('managed.review.read', { projectId, workId, objectId });
  if (!initial.reviewVersion) throw new HostError('REVIEW_UNAVAILABLE', '冻结候选或审核版本不可用，不能决定。');
  const paths = (initial.files || []).map(file => file.relPath);
  const decision = await workspace.runReviewBarrier(projectId, { workId, objectId, paths }, async () => {
    const unsaved = [];
    for (const relPath of paths) {
      const buffer = workspace.buffers.get(workspace.resource(projectId, relPath));
      if (buffer?.dirty === true) { unsaved.push({ relPath, reason: 'buffer' }); continue; }
      const draft = await host.readDraftRecord(projectId, relPath).catch(() => null);
      if (draft && !draft.draftError && draft.status !== 'saved') unsaved.push({ relPath, reason: 'draft' });
    }
    if (unsaved.length) throw new HostError('REVIEW_SOURCE_UNSAVED', '同名项目文档仍有未保存内容；请先保存或放弃后再决定。', { unsaved });
    const current = await managed.invoke('managed.review.read', { projectId, workId, objectId });
    if (current.reviewVersion !== reviewVersion) {
      throw new HostError('REVIEW_TOKEN_CHANGED', '审核版本在确认后已变化；请重新读取并再次确认，未自动采用新版本。', {
        reviewVersion: current.reviewVersion ?? null,
        files: (current.files || []).map(file => ({ relPath: file.relPath, status: file.status ?? null, draftRevision: file.draft?.revision ?? 0 })),
      });
    }
    const result = await managed.invoke('managed.review.' + action, { projectId, workId, objectId, reviewVersion, requestKey, ...(action === 'continue' ? { instruction: payload.instruction ?? null } : {}) });
    return { ...result, action, reviewVersion };
  });
  workspace.emitReviewDocumentState(projectId, workId, { readOnly: true, reason: 'decided' });
  return decision;
}

// Admission envelope: the preload attaches flushRequestId so host admission
// can tie a write to its pending flush receipt. Business controllers keep
// strict payload schemas, so the envelope key is removed after authorization
// — managed.review.* must never see (or tolerate) transport metadata.
export function stripFlushEnvelope(payload) {
  if (payload === null || typeof payload !== 'object' || !Object.hasOwn(payload, 'flushRequestId')) return payload;
  const { flushRequestId, ...rest } = payload;
  return rest;
}
