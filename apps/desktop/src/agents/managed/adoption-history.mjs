import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FileChanges } from '../../domain/file-changes.mjs';
import { userActor } from '../../domain/document-changes.mjs';
import { textChangeSet } from '../../domain/tag-anchors.mjs';
import { runGit } from './git-runtime.mjs';
import { safeBytes, workPath } from './execution-workspace.mjs';

const digest = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function text(bytes) {
  if (bytes === null) return '';
  if (bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}
function gitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1' };
}
async function blob(root, commit, rel, env) {
  const entry = (await runGit(root, ['ls-tree', '-z', commit, '--', rel], { env })).toString();
  if (!entry) return null;
  const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(entry);
  if (!match || match[3] !== rel) fail('ADOPTION_BLOB_INVALID', 'Adoption history requires an exact ordinary Git blob: ' + rel);
  return runGit(root, ['cat-file', 'blob', match[2]], { env });
}

/** Record already-integrated bytes, never write/merge/reset original content. */
export async function recordAdoption({ host, projectId, work, receipt }) {
  if (receipt?.status !== 'merged' || !/^[a-f0-9]{40,64}$/.test(receipt.commit || '') || !Array.isArray(receipt.operations) || !work?.id) fail('ADOPTION_RECEIPT_INVALID', 'A completed integration receipt is required for attribution');
  const project = await host.requireProject(projectId), root = project.root;
  if (work.execution?.repo && await fs.realpath(work.execution.repo) !== await fs.realpath(root)) fail('ADOPTION_IDENTITY_CHANGED', 'Adoption repository does not match the project');
  const store = new FileChanges({root,storage:host.storage,projectId}), env = gitEnv();
  const workerActor = { id: 'nozeli:worker:' + work.id, kind: 'agent2', name: work.name || 'Worker', mark: 'W', workId: work.id };
  // Reviewed provenance: the immutable accepted binding carries per-file worker
  // candidate digests versus the human final digests.
  const reviewedFiles = work.closure?.reviewedVersion && Array.isArray(work.closure.reviewedVersion.files)
    ? new Map(work.closure.reviewedVersion.files.map(file => [file.relPath, file])) : null;
  const reconciliation=work.closure?.reconciledReview?await host.storage.getRecovery(projectId,work.closure.reconciledReview.key):null;
  const files = [];
  for (const op of receipt.operations) {
    const rel = workPath(op.relPath);
    if (op.commit !== receipt.commit || op.workId !== work.id) fail('ADOPTION_RECEIPT_INVALID', 'Adoption operation identity mismatch: ' + rel);
    const operationId = digest(Buffer.from(JSON.stringify(['adoption', work.id, receipt.commit, rel])));
    const humanOperationId = digest(Buffer.from(JSON.stringify(['adoption-human', work.id, receipt.commit, rel])));
    const before = await blob(root, receipt.commit + '^', rel, env), after = await blob(root, receipt.commit, rel, env);
    const reconciled=reconciliation?.rows?.find(row=>row.relPath===rel&&row.targetDigest===op.beforeDigest&&row.digest===op.afterDigest);
    if ((!reconciled&&digest(before)!==op.beforeDigest)||digest(after)!==op.afterDigest) fail('ADOPTION_RECEIPT_INVALID', 'Adoption blob digests do not match the integration receipt: ' + rel);
    // Human fact: a draft revision whose final digest differs from the worker candidate;
    // the human final must equal the merged bytes, otherwise the receipt is inconsistent.
    const reviewed = reviewedFiles?.get(rel) || null;
    if (reviewed && reviewed.draftRevision != null && reviewed.reviewedDigest !== op.afterDigest) fail('ADOPTION_RECEIPT_INVALID', 'Reviewed final bytes do not match the integration receipt: ' + rel);
    const humanEdited = Boolean(reviewed && reviewed.draftRevision != null && reviewed.reviewedDigest !== reviewed.candidateDigest);
    const workerChanged = reviewed ? reviewed.candidateDigest !== op.beforeDigest : op.beforeDigest !== op.afterDigest;
    // Mixed provenance records the truthful two-step chain (worker, then human), so the
    // worker candidate bytes are required evidence — never relabel the whole delta.
    let candidateBytes = null;
    if (humanEdited && workerChanged) {
      const commit = work.execution?.candidate?.commit;
      candidateBytes = typeof commit === 'string' ? await blob(root, commit, rel, env) : null;
      if (candidateBytes === null || digest(candidateBytes) !== reviewed.candidateDigest) fail('ADOPTION_REVIEW_MATERIAL_MISSING', 'Worker candidate bytes are required for truthful mixed attribution: ' + rel);
    }
    const beforeText = text(before), afterText = text(after), candidateText = candidateBytes === null ? null : text(candidateBytes);
    const result = await host.fileLock(projectId, rel)(() => store.withLock(rel, async () => {
      const draft = await host.readDraftRecord(projectId, rel);
      if (draft?.draftError || draft && draft.status !== 'saved') fail('ADOPTION_DRAFT_PENDING', 'Unsaved draft preserved; adoption history is pending: ' + rel);
      let ledger = await store.read(rel);
      if (ledger?.pending) fail('ADOPTION_HISTORY_PENDING', 'Pending document journal preserved: ' + rel);
      if(reconciled){
        const current=await safeBytes(root,rel);
        if(digest(current)!==op.afterDigest)fail('ADOPTION_SOURCE_CHANGED','Reconciled path changed after integration: '+rel);
        await store.observe(rel,text(after),op.afterDigest);
        return {relPath:rel,status:'skipped',reason:'explicit-target-reconciliation',operationId};
      }
      const done = ledger?.events.find(event => event.operationId === operationId);
      // In a mixed chain the worker step ends at the candidate digest, not the merged digest.
      const doneAfterExpected = humanEdited && workerChanged ? reviewed.candidateDigest : op.afterDigest;
      if (done && (done.beforeDigest !== op.beforeDigest || done.afterDigest !== doneAfterExpected || done.actor.id !== workerActor.id)) fail('ADOPTION_HISTORY_CONFLICT', 'Adoption history identity conflict: ' + rel);
      const humanDone = humanEdited ? ledger?.events.find(event => event.operationId === humanOperationId) : undefined;
      if (humanDone && (humanDone.afterDigest !== op.afterDigest || humanDone.actor.id !== userActor.id || humanDone.beforeDigest !== (workerChanged ? reviewed.candidateDigest : op.beforeDigest))) fail('ADOPTION_HISTORY_CONFLICT', 'Adoption history identity conflict: ' + rel);
      if (humanEdited && workerChanged && Boolean(done) !== Boolean(humanDone)) fail('ADOPTION_HISTORY_CONFLICT', 'Partial adoption chain preserved: ' + rel);
      const current = await safeBytes(root, rel);
      if (digest(current) !== op.afterDigest) fail('ADOPTION_SOURCE_CHANGED', 'Adopted path moved or changed; current content preserved: ' + rel);
      if (done || humanDone) return { relPath: rel, status: 'duplicate', eventId: (humanDone ?? done).id, operationId };
      if (beforeText === null || afterText === null || humanEdited && workerChanged && candidateText === null || ledger?.textSpace === 'docx-main-text') return { relPath: rel, status: 'skipped', reason: 'non-text-content', operationId };
      if (ledger && ledger.digest !== op.beforeDigest) {
        // An editor/external observer may already have advanced the ledger.
        // Preserve that real chain; never rewrite it to invent attribution.
        await store.observe(rel, afterText, op.afterDigest);
        return { relPath: rel, status: 'skipped', reason: 'history-baseline-mismatch', operationId };
      }
      ledger ??= store.initial(rel, beforeText, op.beforeDigest);
      let candidate;
      if (humanEdited && workerChanged) {
        const workerStep = store.candidate(ledger, candidateText, reviewed.candidateDigest, textChangeSet(ledger.text, candidateText), workerActor, { operationId, fingerprint: receipt.commit, type: candidateBytes === null ? 'delete' : before === null ? 'create' : 'edit' });
        candidate = store.candidate(workerStep, afterText, op.afterDigest, textChangeSet(candidateText, afterText), userActor, { operationId: humanOperationId, fingerprint: receipt.commit, type: 'edit' });
      } else if (humanEdited) {
        candidate = store.candidate(ledger, afterText, op.afterDigest, textChangeSet(ledger.text, afterText), userActor, { operationId: humanOperationId, fingerprint: receipt.commit, type: after === null ? 'delete' : before === null ? 'create' : 'edit' });
      } else {
        candidate = store.candidate(ledger, afterText, op.afterDigest, textChangeSet(ledger.text, afterText), workerActor, { operationId, fingerprint: receipt.commit, type: after === null ? 'delete' : before === null ? 'create' : 'edit' });
      }
      // Recheck after all reads, before the only mutation (the ledger).
      if (digest(await safeBytes(root, rel)) !== op.afterDigest) fail('ADOPTION_SOURCE_CHANGED', 'Adopted path changed during attribution: ' + rel);
      await store.write(rel, candidate);
      return { relPath: rel, status: 'recorded', eventId: candidate.events.at(-1).id, operationId: humanEdited && !workerChanged ? humanOperationId : operationId, ...(humanEdited && workerChanged ? { humanOperationId } : {}) };
    }));
    host.documentStatusCache?.delete(projectId + '\0' + rel);
    await host.onDocumentChange({ projectId, relPath: rel, digest: op.afterDigest, actor: result.status === 'skipped' ? undefined : humanEdited ? userActor : workerActor });
    files.push(result);
  }
  return { commit: receipt.commit, files };
}
