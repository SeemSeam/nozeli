import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FileChanges } from '../../domain/file-changes.mjs';
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
  const store = new FileChanges(root), env = gitEnv();
  const actor = { id: 'nozeli:worker:' + work.id, kind: 'agent2', name: work.name || 'Worker', mark: 'W', workId: work.id, threadId: work.threadId || null };
  const files = [];
  for (const op of receipt.operations) {
    const rel = workPath(op.relPath);
    if (op.commit !== receipt.commit || op.workId !== work.id) fail('ADOPTION_RECEIPT_INVALID', 'Adoption operation identity mismatch: ' + rel);
    const operationId = digest(Buffer.from(JSON.stringify(['adoption', work.id, receipt.commit, rel])));
    const before = await blob(root, receipt.commit + '^', rel, env), after = await blob(root, receipt.commit, rel, env);
    if (digest(before) !== op.beforeDigest || digest(after) !== op.afterDigest) fail('ADOPTION_RECEIPT_INVALID', 'Adoption blob digests do not match the integration receipt: ' + rel);
    const beforeText = text(before), afterText = text(after);
    const result = await host.fileLock(projectId, rel)(() => store.withLock(rel, async () => {
      const draft = await host.readDraftRecord(projectId, rel);
      if (draft?.draftError || draft && draft.status !== 'saved') fail('ADOPTION_DRAFT_PENDING', 'Unsaved draft preserved; adoption history is pending: ' + rel);
      let ledger = await store.read(rel);
      if (ledger?.pending) fail('ADOPTION_HISTORY_PENDING', 'Pending document journal preserved: ' + rel);
      const done = ledger?.events.find(event => event.operationId === operationId);
      if (done && (done.beforeDigest !== op.beforeDigest || done.afterDigest !== op.afterDigest || done.actor.id !== actor.id)) fail('ADOPTION_HISTORY_CONFLICT', 'Adoption history identity conflict: ' + rel);
      const current = await safeBytes(root, rel);
      if (digest(current) !== op.afterDigest) fail('ADOPTION_SOURCE_CHANGED', 'Adopted path moved or changed; current content preserved: ' + rel);
      if (done) return { relPath: rel, status: 'duplicate', eventId: done.id, operationId };
      if (beforeText === null || afterText === null || ledger?.textSpace === 'docx-main-text') return { relPath: rel, status: 'skipped', reason: 'non-text-content', operationId };
      if (ledger && ledger.digest !== op.beforeDigest) {
        // An editor/external observer may already have advanced the ledger.
        // Preserve that real chain; never rewrite it to invent Worker history.
        await store.observe(rel, afterText, op.afterDigest);
        return { relPath: rel, status: 'skipped', reason: 'history-baseline-mismatch', operationId };
      }
      ledger ??= store.initial(rel, beforeText, op.beforeDigest);
      const candidate = store.candidate(ledger, afterText, op.afterDigest, textChangeSet(ledger.text, afterText), actor, { operationId, fingerprint: receipt.commit, type: after === null ? 'delete' : before === null ? 'create' : 'edit' });
      // Recheck after all reads, before the only mutation (the ledger).
      if (digest(await safeBytes(root, rel)) !== op.afterDigest) fail('ADOPTION_SOURCE_CHANGED', 'Adopted path changed during attribution: ' + rel);
      await store.write(rel, candidate);
      return { relPath: rel, status: 'recorded', eventId: candidate.events.at(-1).id, operationId };
    }));
    host.documentStatusCache?.delete(projectId + '\0' + rel);
    await host.onDocumentChange({ projectId, relPath: rel, digest: op.afterDigest, actor: result.status === 'skipped' ? undefined : actor });
    files.push(result);
  }
  return { commit: receipt.commit, files };
}
