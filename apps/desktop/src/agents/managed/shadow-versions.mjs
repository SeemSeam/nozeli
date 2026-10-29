import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureGit, runGit } from './git-runtime.mjs';
import { createHash, randomUUID } from 'node:crypto';
import {entry,openDirectoryChain,renameAt,removeTreeAt,statAt} from '../../platform/directory-fs.mjs';
import { FileChanges } from '../../domain/file-changes.mjs';
import { workPath, safeBytes } from './execution-workspace.mjs';

const zero = '0'.repeat(40);
const REF = 'refs/heads/nozeli/versions';
const META_PATH = '.nozeli-meta/checkpoint.json';
const MAX_LIST_META = 20;
const CAS_LOST = /Cannot lock ref|Cannot update|is at [0-9a-f]+ but expected|cannot lock ref|unable to resolve reference/i;

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const strictText = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } };

// Shadow bare repo for user-visible document checkpoints. Completely separate
// from the user's own Git repository: plumbing only, dedicated temp index,
// isolated GIT_* environment (no user config/hooks/index), no checkout/reset,
// no push. Only content that provably came from a managed successful write is
// admitted: each path needs a file-changes ledger whose digest and last event
// match the frozen bytes.
export class ShadowVersions {
  constructor({ projectRoot, projectId, storage, actor = null }) {
    this.projectRoot = path.resolve(projectRoot);
    this.projectId = projectId; this.storage = storage;
    this.gitDir = path.join(this.projectRoot, '.nozeli', 'versions.git');
    this.requestsDir = null;
    this.identity = { name: actor?.name || 'Nozeli 影子版本', email: actor?.email || 'nozeli-versions@localhost' };
    this._serial = Promise.resolve();
  }

  // Isolated environment: drop every inherited GIT_* variable (index/common
  // dir/object dir/config pointers cannot reach the user's repo), disable
  // system/global config and hooks lookups, pin a fixed committer identity.
  async git(args, { extra = {} } = {}) {
    await this.storage.requireOnline(this.projectId);
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
    const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull,
      GIT_AUTHOR_NAME: this.identity.name,
      GIT_AUTHOR_EMAIL: this.identity.email,
      GIT_COMMITTER_NAME: this.identity.name,
      GIT_COMMITTER_EMAIL: this.identity.email,
      GIT_DIR: this.gitDir,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: devNull,
    }, extra);
    return runGit(this.projectRoot, args, { env, maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  }

  async ensureRepo() {
    await this.storage.requireOnline(this.projectId);
    this.requestsDir = path.join(await this.storage.localDirectory(this.projectId), 'versions-staging');
    await ensureGit();
    try { await fs.access(this.gitDir); return false; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.mkdir(path.dirname(this.gitDir), { recursive: true });
    const parent=await openDirectoryChain(path.dirname(this.gitDir)),name='versions-init-'+randomUUID(),staging=path.join(path.dirname(this.gitDir),name),temporary=entry(parent.directory.fd,name);
    let identity;
    try{
      await runGit(this.projectRoot,['init','--bare','--template=','-q',staging],{env:this.gitEnvForInit(),timeout:60000});
      identity=await statAt(temporary,{bigint:true});
      await runGit(this.projectRoot,['--git-dir='+staging,'symbolic-ref','HEAD',REF],{env:this.gitEnvForInit()});
      try{await renameAt(temporary,entry(parent.directory.fd,path.basename(this.gitDir)),{exclusive:process.platform==='darwin'});}
      catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;await this.git(['rev-parse','--is-bare-repository']);return false;}
    }finally{if(identity)await removeTreeAt(temporary,{expected:identity});await parent.close();}
    return true;
  }

  gitEnvForInit() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
    const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull });
    return env;
  }

  // Serializes checkpoints per instance; a failed task must not poison the
  // queue for later requests.
  runExclusive(fn) {
    const task = this._serial.then(fn, fn);
    this._serial = task.then(() => {}, () => {});
    return task;
  }

  // Read project bytes exactly once, refusing symlinks/escapes/oversize
  // (reuses the execution-copy boundary tools: workPath + O_NOFOLLOW + 32MiB).
  async readProjectBytes(rel) {
    const bytes = await safeBytes(this.projectRoot, rel);
    if (bytes === null) fail('NOT_FOUND', '文件不存在：' + rel);
    return bytes;
  }

  // Freeze the target set once: exact bytes + ledger provenance. The frozen
  // material is the ONLY thing a checkpoint may stage, so metadata digests and
  // blob digests cannot diverge.
  async freezeDocumentSet(relPaths, { workId, workName } = {}) {
    const store = new FileChanges({ root: this.projectRoot, storage: this.storage, projectId: this.projectId });
    const entries = [];
    for (const relPath of relPaths) {
      workPath(relPath); // shared boundary: traversal/absolute/.nozeli/credential names rejected
      const bytes = await this.readProjectBytes(relPath);
      if (strictText(bytes) === null) fail('BINARY', '影子仓只接受 UTF-8 文本：' + relPath);
      const contentDigest = digest(bytes);
      let ledger = null;
      try { ledger = await store.read(relPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!ledger || !ledger.docId) fail('NOT_MANAGED', '此文件没有受管修改记录，不能生成版本：' + relPath);
      if (ledger.digest !== contentDigest) fail('PROVENANCE', '磁盘内容与受管记录不一致，不能定格：' + relPath);
      const lastEvent = ledger.events?.at(-1) || null;
      if (!lastEvent || lastEvent.afterDigest !== contentDigest || lastEvent.type === 'external') {
        fail('PROVENANCE', '最新内容不是受管成功写入的结果，不能定格：' + relPath);
      }
      entries.push({
        relPath,
        bytes,
        docId: ledger.docId,
        revision: ledger.revision ?? 0,
        digest: contentDigest,
        bytesLength: bytes.length,
        lastEventId: lastEvent.id,
        lastEventActor: lastEvent.actor?.kind || null,
        lastEventType: lastEvent.type || null,
      });
    }
    if (!entries.length) fail('EMPTY_SET', '固定文档集合为空');
    const payloadDigest = digest(Buffer.from(JSON.stringify({
      workId: workId || null,
      docs: entries.map(({ relPath, digest: d }) => ({ relPath, digest: d })).sort((a, b) => a.relPath.localeCompare(b.relPath)),
    })));
    return { entries, payloadDigest, workId: workId || null, workName: workName || null };
  }

  async readRequest(requestId) { return this.storage.getProject(this.projectId, 'version_requests', requestId); }
  async persistRequest(requestId, record) { await this.storage.putProject(this.projectId, 'version_requests', requestId, record); }

  // Stage frozen bytes into the bare repo with a dedicated temp index and
  // verify each staged blob against the frozen digest.
  async stageEntries(requestId, entries, meta) {
    this.requestsDir = path.join(await this.storage.localDirectory(this.projectId), 'versions-staging');
    const tmpIndex = path.join(this.requestsDir, `${requestId}.index`);
    await fs.mkdir(path.dirname(tmpIndex), { recursive: true });
    await fs.rm(tmpIndex, { force: true });
    const indexEnv = { GIT_INDEX_FILE: tmpIndex };
    try {
      for (const entry of entries) {
        const bytes = await this.storage.readObject(this.projectId, entry.digest);
        if (digest(bytes) !== entry.digest) fail('CHECKPOINT_DATA_LOST', '定格材料校验失败：' + entry.relPath);
        const file = path.join(this.requestsDir, `${requestId}.${entry.digest}.blob.tmp`);
        await fs.writeFile(file, bytes, { mode: 0o600 });
        let sha;
        try { sha = (await this.git(['hash-object', '-w', file], { extra: indexEnv })).toString().trim(); }
        finally { await fs.rm(file, { force: true }); }
        await this.git(['update-index', '--add', '--cacheinfo', `100644,${sha},${entry.relPath}`], { extra: indexEnv });
      }
      const tmpMeta = path.join(this.requestsDir, `${requestId}.meta.json`);
      await fs.writeFile(tmpMeta, JSON.stringify(meta, null, 2));
      const metaSha = (await this.git(['hash-object', '-w', tmpMeta], { extra: indexEnv })).toString().trim();
      await fs.rm(tmpMeta, { force: true });
      await this.git(['update-index', '--add', '--cacheinfo', `100644,${metaSha},${META_PATH}`], { extra: indexEnv });
      const tree = (await this.git(['write-tree'], { extra: indexEnv })).toString().trim();
      return tree;
    } finally {
      await fs.rm(tmpIndex, { force: true });
    }
  }

  // Publish with old-value CAS so concurrent writers can never drop each
  // other's commit. A lost race re-reads the moved ref, rebuilds the commit on
  // top of it, and retries (reconciliation); the losing tree is never lost.
  async publishWithCAS(requestId, docs, tree, commitInput) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const raw = await this.git(['rev-parse', '--verify', '--quiet', REF]).catch(() => null);
      const parent = raw ? raw.toString().trim() : null;
      // Crash-window recovery: if the ref tip is already this request's commit
      // (published but not finalized), adopt it instead of duplicating.
      if (parent) {
        const tipMeta = await this.readMeta(parent).catch(() => null);
        if (tipMeta && tipMeta.checkpointRequestId === requestId && JSON.stringify(tipMeta.docs) === JSON.stringify(docs)) return { commit: parent, adopted: true };
      }
      const args = parent ? ['commit-tree', tree, '-p', parent, '-m', commitInput] : ['commit-tree', tree, '-m', commitInput];
      const commit = (await this.git(args)).toString().trim();
      try {
        await this.git(['update-ref', REF, commit, parent || zero]);
        return { commit, adopted: false };
      } catch (e) {
        if (!CAS_LOST.test(String(e?.stderr || e?.message))) throw e;
      }
    }
    fail('PUBLISH_CONFLICT', '并发发布多次冲突，检查点未写入（可安全重试）');
  }

  // Idempotent checkpoint: the frozen set is persisted BEFORE staging, so a
  // restart retries from the original materials, never from current disk.
  // Same requestId + same identity (workId + target paths) → same commit;
  // different identity reusing the id → rejected.
  async checkpoint({ requestId, workId, workName, relPaths }) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) fail('INVALID_PAYLOAD', 'checkpointRequestId 无效');
    if (!Array.isArray(relPaths) || relPaths.some(p => typeof p !== 'string')) fail('INVALID_PAYLOAD', 'relPaths 无效');
    return this.runExclusive(() => this._checkpoint({ requestId, workId, workName, relPaths }));
  }

  async _checkpoint({ requestId, workId, workName, relPaths }) {
    await this.ensureRepo();
    const prior = await this.readRequest(requestId);
    if (prior) {
      const wanted = [...new Set(relPaths)].sort();
      const have = [...new Set((prior.entries || []).map(e => e.relPath))].sort();
      const sameIdentity = prior.workId === (workId || null) && wanted.length === have.length && wanted.every((p, i) => p === have[i]);
      if (!sameIdentity) fail('CHECKPOINT_ID_CONFLICT', '同一 checkpointRequestId 已被不同请求使用（workId 或目标集合不同）');
      if (prior.status === 'committed' && prior.commit) {
        const alive = await this.git(['cat-file', '-e', `${prior.commit}^{commit}`]).then(() => true).catch(() => false);
        if (alive) return { checkpointId: requestId, commit: prior.commit, reused: true, docs: prior.docs };
      }
      // prepared (or committed record whose commit vanished): resume from the
      // persisted frozen materials.
      const entries = prior.entries.map(e => ({ ...e }));
      const docs = prior.docs || docsFromEntries(entries);
      const meta = { checkpointRequestId: requestId, workId: prior.workId, workName: prior.workName, createdAt: prior.createdAt, docs };
      const tree = await this.stageEntries(requestId, entries, meta);
      const { commit } = await this.publishWithCAS(requestId, docs, tree, `Nozeli checkpoint ${requestId}\n\nwork: ${prior.workId || ''}\n`);
      const record = { ...prior, status: 'committed', commit, tree, publishedAt: new Date().toISOString() };
      await this.persistRequest(requestId, record);
      return { checkpointId: requestId, commit, reused: true, docs };
    }
    // New request: freeze once, persist materials, then stage/publish.
    const frozen = await this.freezeDocumentSet(relPaths, { workId, workName });
    const entries = frozen.entries.map(({ bytes, ...e }) => ({ ...e }));
    const docs = docsFromEntries(frozen.entries);
    const createdAt = new Date().toISOString();
    for (const entry of frozen.entries) await this.storage.putObject(this.projectId, entry.bytes);
    await this.persistRequest(requestId, {
      requestId, status: 'prepared', workId: frozen.workId, workName: frozen.workName,
      payloadDigest: frozen.payloadDigest, entries, docs, createdAt,
    });
    const meta = { checkpointRequestId: requestId, workId: frozen.workId, workName: frozen.workName, createdAt, docs };
    const tree = await this.stageEntries(requestId, frozen.entries, meta);
    const { commit } = await this.publishWithCAS(requestId, docs, tree, `Nozeli checkpoint ${requestId}\n\nwork: ${frozen.workId || ''}\n`);
    const record = { requestId, status: 'committed', workId: frozen.workId, workName: frozen.workName, payloadDigest: frozen.payloadDigest, entries, docs, tree, commit, createdAt, publishedAt: new Date().toISOString() };
    await this.persistRequest(requestId, record);
    return { checkpointId: requestId, commit, reused: false, docs };
  }

  // Unfinished (prepared) request ids — surfaced for UI “待检查点”状态.
  async pending() {
    return (await this.storage.listProject(this.projectId, 'version_requests')).map(row => row.value).filter(record => record.status !== 'committed').map(record => ({ requestId: record.requestId, status: record.status }));
  }

  // List checkpoints (newest first); newest MAX_LIST_META get metadata docs.
  async list() {
    await ensureGit();
    const exists = await fs.access(this.gitDir).then(() => true).catch(() => false);
    if (!exists) return [];
    const out = (await this.git(['log', '--format=%H%x1f%ct%x1f%s', REF]).catch(() => Buffer.alloc(0))).toString('utf8');
    const rows = out.split('\n').filter(Boolean).map(line => {
      const [commit, ct, subject] = line.split('\x1f');
      return { commit, committedAt: Number(ct) * 1000, subject };
    });
    for (const row of rows.slice(0, MAX_LIST_META)) {
      const meta = await this.readMeta(row.commit).catch(() => null);
      if (meta) Object.assign(row, { requestId: meta.checkpointRequestId, workId: meta.workId, workName: meta.workName, docs: meta.docs });
    }
    return rows;
  }

  // Read a file blob from a checkpoint commit (plumbing read, no worktree).
  async readBlob(commit, relPath) {
    const spec = `${commit}:${relPath}`;
    const bytes = await this.git(['cat-file', 'blob', spec]).catch(e => {
      if (/does not exist|Not a valid object name|Not a valid object|path.*exists|Invalid/i.test(String(e.stderr || e.message))) fail('NOT_IN_COMMIT', '该检查点不包含此文件：' + relPath);
      throw e;
    });
    return bytes;
  }

  async readMeta(commit) {
    const raw = await this.git(['cat-file', 'blob', `${commit}:${META_PATH}`]).catch(e => { if (/does not exist|Not a valid/i.test(String(e.stderr || e.message))) return null; throw e; });
    return raw ? JSON.parse(raw.toString('utf8')) : null;
  }

  async readPrep(prepId) {
    if (typeof prepId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(prepId)) fail('INVALID_PAYLOAD', '对比准备标识无效');
    return this.storage.getProject(this.projectId, 'version_preps', prepId);
  }

  // Freeze ONE compare/restore prep: the caller has already synced the latest
  // human buffer and hands in the digest of what the user actually SAW on
  // disk. The prep record is persisted before any restore can reference it,
  // and its currentDigest — not a fresh re-read — is the only baseline a
  // restore may submit.
  async prepare({ commit, relPath, currentDigest }) {
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) fail('INVALID_PAYLOAD', '检查点提交无效');
    workPath(relPath);
    if (typeof currentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(currentDigest)) fail('INVALID_PAYLOAD', '当前内容摘要无效');
    const bytes = await this.readBlob(commit, relPath);
    const checkpointDigest = digest(bytes);
    const prep = { prepId: randomUUID(), commit, relPath, checkpointDigest, currentDigest, at: new Date().toISOString() };
    await this.storage.putProject(this.projectId, 'version_preps', prep.prepId, prep);
    return { ...prep, checkpointText: strictText(bytes) };
  }

  async readRestore(operationId) {
    return this.storage.getProject(this.projectId, 'version_restores', operationId);
  }

  // Restore through the managed save entry: each file becomes a NEW rollback
  // event in the ledger. The caller must reference persisted preps (from the
  // compare step the user actually viewed); the baseline is the prep's
  // currentDigest and is NEVER refreshed at submit time. Before each file's
  // save the caller-provided sync() flushes the latest human buffer through
  // the managed document-sync channel; if the buffer moved past the prep the
  // managed save refuses with CONFLICT and the human input stays. Results are
  // persisted in project.sqlite so partial completion survives restart;
  // the same operationId resumes with the SAME preps.
  async restoreThroughManagedSave({ host, projectId, commit, relPaths, preps, actor, operationId, sync = null }) {
    if (!actor || typeof actor !== 'object' || !actor.id) fail('INVALID_PAYLOAD', '恢复需要宿主绑定的恢复身份');
    if (operationId !== undefined && (typeof operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(operationId))) fail('INVALID_PAYLOAD', '恢复操作标识无效');
    const opId = operationId || randomUUID();
    if (!Array.isArray(relPaths) || !relPaths.length || relPaths.some(p => typeof p !== 'string')) fail('INVALID_PAYLOAD', '恢复目标集合无效');
    if (!preps || typeof preps !== 'object' || Array.isArray(preps)) fail('INVALID_PAYLOAD', '恢复必须引用对比准备记录');
    const prepByPath = new Map();
    for (const relPath of relPaths) {
      const prep = await this.readPrep(preps[relPath]);
      if (!prep) fail('INVALID_PAYLOAD', '缺少对比准备记录，请先对比：' + relPath);
      if (prep.commit !== commit || prep.relPath !== relPath) fail('INVALID_PAYLOAD', '对比准备与恢复目标不一致：' + relPath);
      const blobDigest = digest(await this.readBlob(commit, relPath));
      if (prep.checkpointDigest !== blobDigest) fail('INVALID_PAYLOAD', '对比准备指向的检查点内容已失效：' + relPath);
      prepByPath.set(relPath, prep);
    }
    let record = await this.readRestore(opId);
    if (record) {
      const known = record.commit === commit && relPaths.every(p => record.relPaths.includes(p) && record.preps[p] === preps[p]);
      if (!known) fail('RESTORE_CONFLICT', '同一恢复操作标识已被不同请求使用；重新对比后请使用新的恢复操作');
      if (record.status === 'finished' && relPaths.every(p => record.results.some(r => r.relPath === p && r.ok))) return this.restoreResult(record, relPaths);
    } else {
      record = {
        operationId: opId, status: 'prepared', commit, relPaths: [...relPaths],
        preps: Object.fromEntries(relPaths.map(p => [p, preps[p]])),
        expectedBaselines: Object.fromEntries(relPaths.map(p => [p, prepByPath.get(p).currentDigest])),
        actorId: actor.id, results: [], createdAt: new Date().toISOString(),
      };
      await this.storage.putProject(this.projectId, 'version_restores', opId, record);
    }
    const done = new Set(record.results.filter(r => r.ok).map(r => r.relPath));
    for (const relPath of relPaths) {
      if (done.has(relPath)) continue;
      let result;
      try {
        workPath(relPath);
        const bytes = await this.readBlob(commit, relPath);
        const text = strictText(bytes);
        if (text === null) throw Object.assign(new Error('检查点内容不是 UTF-8 文本'), { code: 'BINARY' });
        if (sync) await sync(relPath);
        // The prep's baseline is authoritative; host.save re-checks it against
        // CURRENT disk after the buffer flush and refuses with CONFLICT
        // (keeping human input) when they diverge.
        const saved = await host.save(projectId, relPath, record.expectedBaselines[relPath], text, { actor, type: 'rollback', operationId: opId });
        result = { relPath, ok: true, prepId: preps[relPath], eventId: saved?.eventId || null, digest: saved?.digest || digest(bytes) };
      } catch (error) {
        const code = error.code || 'RESTORE_FAILED';
        result = { relPath, ok: false, code, message: error.message, ...(code === 'CONFLICT' ? { kept: 'human' } : {}) };
      }
      record.results = record.results.filter(r => r.relPath !== relPath).concat(result);
      record.updatedAt = new Date().toISOString();
      await this.storage.putProject(this.projectId, 'version_restores', opId, record);
    }
    record.status = 'finished';
    record.updatedAt = new Date().toISOString();
    await this.storage.putProject(this.projectId, 'version_restores', opId, record);
    return this.restoreResult(record, relPaths);
  }

  // Counts are scoped to the invoking call's target set; results carries the
  // whole persisted record so callers see prior partial completions too.
  restoreResult(record, scope) {
    const inScope = r => scope.includes(r.relPath);
    return {
      operationId: record.operationId,
      status: record.status,
      results: record.results,
      completed: record.results.filter(r => r.ok && inScope(r)).length,
      failed: record.results.filter(r => !r.ok && inScope(r)).length,
    };
  }

  // Frozen bytes are shared immutable objects, not disposable request copies.
  // Only unreferenced staging scratch files may be collected here.
  async collectGarbage({ now = Date.now(), maxFiles = 200, maxBytes = 64 * 1024 * 1024, tempAgeMs = 60 * 60 * 1000 } = {}) {
    return this.runExclusive(async () => {
      await this.storage.requireOnline(this.projectId);
      const report = { scanned: 0, deleted: [], quarantined: [], restored: [], skipped: [], freedBytes: 0, remainingBytes: 0, refBefore: null, refAfter: null, pressure: null, scope: 'unreferenced staging scratch only; immutable objects and project records retained' };
      this.requestsDir = path.join(await this.storage.localDirectory(this.projectId), 'versions-staging');
      const names = await fs.readdir(this.requestsDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const name of names) {
        if (!name.endsWith('.index') && !name.endsWith('.meta.json') && !name.endsWith('.blob.tmp')) continue;
        const file = path.join(this.requestsDir, name), stat = await fs.lstat(file);
        report.scanned++;
        if (!stat.isFile() || stat.isSymbolicLink() || now - stat.mtimeMs < tempAgeMs || report.deleted.length >= maxFiles || report.freedBytes + stat.size > maxBytes) { report.skipped.push({ name, reason: 'PROTECTED' }); continue; }
        await fs.unlink(file); report.deleted.push({ name, bytes: stat.size, kind: 'temp' }); report.freedBytes += stat.size;
      }
      return report;
    });
  }

  // A committed checkpoint is "backed by Git" when the commit is an ancestor
  // of the versions ref, the REAL META_PATH metadata inside that commit
  // (checkpointRequestId + per-doc docId/revision/digest) matches the request
  // record, and every target blob read from the commit matches the frozen
  // entry digest — only then are the request's on-disk blob files redundant.
  async verifyCheckpointBacked(requestId) {
    const record = await this.readRequest(requestId);
    if (!record || record.status !== 'committed' || !record.commit) return false;
    if (!record.entries?.length || !record.docs || Object.keys(record.docs).length !== record.entries.length) return false;
    const meta = await this.readMeta(record.commit).catch(() => null);
    if (!meta || meta.checkpointRequestId !== record.requestId) return false;
    for (const entry of record.entries) {
      const mine = record.docs[entry.relPath], gitMeta = meta.docs?.[entry.relPath];
      if (!mine || !gitMeta) return false;
      if (gitMeta.digest !== entry.digest || gitMeta.docId !== mine.docId || gitMeta.revision !== mine.revision) return false;
      let gitBytes;
      try { gitBytes = await this.readBlob(record.commit, entry.relPath); } catch { return false; }
      if (digest(gitBytes) !== entry.digest) return false;
    }
    return true;
  }
}

function docsFromEntries(entries) {
  const docs = {};
  for (const e of entries) {
    docs[e.relPath] = {
      docId: e.docId,
      revision: e.revision,
      digest: e.digest,
      bytes: e.bytesLength,
      lastEventId: e.lastEventId,
      lastEventActor: e.lastEventActor,
      lastEventType: e.lastEventType,
    };
  }
  return docs;
}
