import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { runGit } from '../agents/managed/git-runtime.mjs';

const NIL = process.platform === 'win32' ? 'NUL' : '/dev/null';
const fail = (code, message) => Object.assign(new Error(message), { code });
const sameIdentity = (a, b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
async function exists(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const unchangedFile = (a,b) => a.isFile() && b.isFile() && sameIdentity(a,b) && a.size===b.size && a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs;
// Lock pathnames can be reused as soon as publication succeeds. Cleanup owns
// only the entity opened with wx, never a subsequent occupant of that name.
async function ownsLock(file, identity) {
  const stat = await exists(file);
  return Boolean(identity && stat?.isFile() && !stat.isSymbolicLink() && sameIdentity(stat, identity));
}
async function removeOwnedLock(file, identity) {
  if (await ownsLock(file, identity)) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
// A conservative filename policy, not content inspection or a secret detector.
// Directory exclusions cover their entire subtree without opening its files.
function sensitiveBaselineName(name) {
  return /^\.env(?:$|[._-]|rc(?:$|[._-]))/i.test(name)
    || /^(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.docker|\.npmrc|\.pypirc|\.?netrc|\.htpasswd|\.git-credentials|\.gitconfig|id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?)$/i.test(name)
    || /\.(?:pem|key|p12|pfx|ppk|jks|keystore)$/i.test(name)
    || /(?:^|[._-])(?:credentials?|secrets?|passwords?|api[-_]?keys?|private[-_]?keys?|service[-_]?accounts?|tokens?)(?:[._-]|$)/i.test(name);
}
async function captureFile(full,git,root,env) {
  const before=await fs.lstat(full);
  if(!before.isFile()||before.isSymbolicLink())throw fail('PROJECT_GIT_FILE_CONFLICT','File changed while capturing baseline');
  let handle;
  try { handle=await fs.open(full,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)); }
  catch(error){if(['ELOOP','ENOENT'].includes(error.code))throw fail('PROJECT_GIT_FILE_CONFLICT','File changed while capturing baseline');throw error;}
  try {
    const opened=await handle.stat(),pathStat=await fs.lstat(full);
    if(!unchangedFile(before,opened)||!unchangedFile(opened,pathStat)||pathStat.isSymbolicLink()||await fs.realpath(full)!==full)throw fail('PROJECT_GIT_FILE_CONFLICT','File changed while capturing baseline');
    // Read only the already verified descriptor, never ask Git to reopen a
    // mutable pathname. Fixed-size chunks bound memory independently of size.
    async function* chunks(){let position=0;while(position<opened.size){const buffer=Buffer.allocUnsafe(Math.min(64*1024,opened.size-position));const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)throw fail('PROJECT_GIT_FILE_CONFLICT','File changed while capturing baseline');position+=bytesRead;yield buffer.subarray(0,bytesRead);}}
    const oid=(await runGit(root,[...git,'hash-object','--no-filters','-w','--stdin'],{env,encoding:'utf8',input:Readable.from(chunks())})).trim();
    const after=await handle.stat(),finalPath=await fs.lstat(full);
    if(!unchangedFile(opened,after)||!unchangedFile(after,finalPath)||finalPath.isSymbolicLink())throw fail('PROJECT_GIT_FILE_CONFLICT','File changed while capturing baseline');
    return {oid,mode:process.platform!=='win32'&&(opened.mode&0o111)?'100755':'100644'};
  }finally{await handle.close();}
}

// The caller owns a durable, local operation journal. A write must resolve only
// after persistence; thrown writes stop the operation before its next effect.
// A committed object is recorded before update-ref, so a retry reconciles that
// exact object and never manufactures a second initial commit.
// expectedIdentity is the registered canonical directory's {dev, ino} (strings
// or numbers). journal.read() returns the last state or null; journal.write(state)
// replaces it durably. The caller must serialize operations for this directory.
// Returns {status:'ready', operationId, repositoryRoot, gitDirectory,
// createdRepository, initialCommit:null|oid, ignore:{path,rule,changed}, warnings,
// baseline:null|{policy,root,included:[path],excluded:[{path,reason}]}}.
// Baseline paths are repository-relative; excluded directories end in '/'.
// It is a sequential per-file snapshot, not an atomic filesystem backup.
// null means no recorded baseline (existing repositories or legacy journals).
// Failures retain the journal for explicit retry with the SAME operationId.
// Existing repositories, even unborn ones, never have HEAD or index rewritten.
export async function ensureProjectGit(root, { operationId, expectedIdentity, journal } = {}) {
  if (!operationId || !expectedIdentity || !journal?.read || !journal?.write) {
    throw fail('PROJECT_GIT_OPTIONS', 'operationId, expectedIdentity {dev,ino}, and durable journal {read,write} are required');
  }
  root = path.resolve(root);
  let repositoryIdentity=null;
  async function verifyRoot() {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, expectedIdentity) || await fs.realpath(root) !== root) {
      throw fail('PROJECT_IDENTITY_CONFLICT', 'Project directory identity changed');
    }
    if(repositoryIdentity){const stat=await fs.lstat(repositoryIdentity.root);if(!stat.isDirectory()||stat.isSymbolicLink()||!sameIdentity(stat,repositoryIdentity)||await fs.realpath(repositoryIdentity.root)!==repositoryIdentity.root)throw fail('PROJECT_GIT_CONFLICT','Git根目录实体已变化');}
  }
  await verifyRoot();
  let state = await journal.read();
  if (state && (state.version !== 1 || state.operationId !== operationId || state.root !== root || !sameIdentity(state.identity, expectedIdentity))) {
    throw fail('PROJECT_GIT_JOURNAL_CONFLICT', 'Git operation journal belongs to another operation or directory');
  }
  async function checkpoint(patch) {
    const next = { ...state, ...patch };
    await journal.write(next);
    state = next;
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-project-git-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NIL, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Nozeli', GIT_AUTHOR_EMAIL: 'initialization@nozeli.local',
    GIT_COMMITTER_NAME: 'Nozeli', GIT_COMMITTER_EMAIL: 'initialization@nozeli.local',
  });
  const config = ['-c', `core.hooksPath=${scratch}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', `core.attributesFile=${NIL}`, '-c', 'commit.gpgsign=false'];
  const git = (cwd, args, extra = {}) => runGit(cwd, [...config, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  async function repository() {
    // Distinguish a genuinely absent repository from permissions, corruption,
    // dubious ownership, or a failed bundled runtime. Only absence allows init.
    let cursor = root;
    for (;;) {
      if (await exists(path.join(cursor, '.git'))) {
        const repositoryRoot = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
        if(path.resolve(repositoryRoot)!==cursor||await fs.realpath(repositoryRoot)!==cursor)throw fail('PROJECT_GIT_CONFLICT','Git报告的根不属于已发现项目祖先');
        const stat=await fs.lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('PROJECT_GIT_CONFLICT','Git根不是安全目录');repositoryIdentity={root:cursor,dev:String(stat.dev),ino:String(stat.ino)};
        const gitDirectory = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
        return { repositoryRoot:cursor, gitDirectory };
      }
      if (await exists(path.join(cursor, 'HEAD')) && await exists(path.join(cursor, 'objects')) && await exists(path.join(cursor, 'refs'))) {
        throw fail('PROJECT_GIT_BARE_REPOSITORY', 'A bare repository is not a project working directory');
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
  try {
    if (state?.phase === 'complete') return state.result;
    let repo;
    if (!state) {
      repo = await repository();
      await checkpoint({ version: 1, operationId, root, identity: { dev: String(expectedIdentity.dev), ino: String(expectedIdentity.ino) }, createdRepository: !repo, phase: 'prepared' });
    }
    const ownGit = path.join(root, '.git');
    const marker = path.join(ownGit, 'nozeli-initialization');
    if (state.createdRepository) {
      await verifyRoot();
      let dir = await exists(ownGit);
      if (!dir) {
        if (state.phase !== 'prepared') throw fail('PROJECT_GIT_CONFLICT', 'Initialized repository disappeared');
        await fs.mkdir(ownGit);
        await fs.writeFile(marker, operationId, { flag: 'wx' });
        const handle = await fs.open(marker, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      } else if (!dir.isDirectory() || dir.isSymbolicLink() || await fs.readFile(marker, 'utf8').catch(() => null) !== operationId) {
        throw fail('PROJECT_GIT_CONFLICT', 'Repository initialization ownership cannot be verified');
      }
      if (!await exists(path.join(ownGit, 'HEAD'))) {
        // An empty template prevents copying executable user templates/hooks.
        await git(root, ['init', '--quiet', `--template=${scratch}`, '--initial-branch=main', root]);
      }
      repo = await repository();
      if (!repo || path.resolve(repo.repositoryRoot) !== root) throw fail('PROJECT_GIT_CONFLICT', 'Initialized repository root changed');
      if (state.phase === 'prepared') await checkpoint({ phase: 'initialized', ...repo });
    } else {
      repo ??= await repository();
      if (!repo) throw fail('PROJECT_GIT_CONFLICT', 'Existing repository disappeared');
      if (state.repositoryRoot && (state.repositoryRoot !== repo.repositoryRoot || state.gitDirectory !== repo.gitDirectory)) throw fail('PROJECT_GIT_CONFLICT', 'Existing repository changed');
      if (!state.repositoryRoot) await checkpoint({ phase: 'initialized', ...repo });
    }
    await verifyRoot();
    const relative = path.relative(repo.repositoryRoot, root).split(path.sep).join('/');
    if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('../'))throw fail('PROJECT_GIT_CONFLICT','项目范围不在Git根内');
    const ignoredPath = (relative ? relative + '/' : '') + '.nozeli/';
    if (/[\r\n]/.test(ignoredPath)) throw fail('PROJECT_GIT_IGNORE_PATH', 'Project path cannot be represented safely in a Git ignore rule');
    // Escape Git wildmatch metacharacters; this is one exact Git-root-relative rule.
    const rule = '/' + ignoredPath.replace(/[\\*?\[\]#! ]/g, '\\$&');
    const ignoreFile = path.join(repo.repositoryRoot, '.gitignore');
    const ignore = await ensureIgnore(ignoreFile, rule, async () => {
      try { await git(repo.repositoryRoot, ['check-ignore', '--no-index', '-q', '--', ignoredPath]); return true; }
      catch (error) { if (error.code === 1) return false; throw error; }
    }, verifyRoot);
    if (!state.ignore) await checkpoint({ phase: 'ignored', ignore });
    const warnings = [];
    const tracked = await git(repo.repositoryRoot, ['ls-files', '-z', '--', ignoredPath]);
    if (tracked) warnings.push({ code: 'PROJECT_METADATA_TRACKED', path: ignoredPath });
    let initialCommit = state.initialCommit || null;
    if (state.createdRepository) {
      const head = await readHead(git, root);
      if (!initialCommit && head) throw fail('PROJECT_GIT_HEAD_CONFLICT', 'Another commit appeared during project initialization');
      if (!initialCommit) {
        const index = path.join(scratch, 'index');
        const indexEnv = { GIT_INDEX_FILE: index };
        await git(root, ['read-tree', '--empty'], indexEnv);
        const baseline = { policy: 'conservative-filenames-v1', root, included: [], excluded: [] };
        async function walk(directory, prefix = '') {
          const items = await fs.readdir(directory, { withFileTypes: true });
          items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
          for (const item of items) {
            const relativePath = prefix + item.name;
            const excluded = reason => baseline.excluded.push({ path: relativePath + (item.isDirectory() ? '/' : ''), reason });
            if (item.name === '.git' || item.name === '.nozeli' || relativePath === '.gitignore.lock' || item.name.startsWith('.nozeli-init-') || item.name.startsWith('.nozeli-source-')) { excluded('project-metadata'); continue; }
            if (sensitiveBaselineName(item.name)) { excluded('sensitive-name'); continue; }
            const full = path.join(directory, item.name);
            if (item.isSymbolicLink()) { excluded('symbolic-link'); continue; }
            try { await git(root, ['check-ignore', '--no-index', '-q', '--', relativePath]); excluded('gitignore'); continue; }
            catch (error) { if (error.code !== 1) throw error; }
            if (item.isDirectory()) {
              const directoryStat = await fs.lstat(full);
              if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await fs.realpath(full) !== full) throw fail('PROJECT_GIT_FILE_CONFLICT', 'Directory changed while capturing baseline');
              if (await exists(path.join(full, '.git')) || (await exists(path.join(full, 'HEAD')) && await exists(path.join(full, 'objects')) && await exists(path.join(full, 'refs')))) { excluded('nested-repository'); continue; }
              await walk(full, relativePath + '/');
            } else if (item.isFile()) {
              const {oid,mode}=await captureFile(full,config,root,env);
              await git(root, ['update-index', '--add', '--cacheinfo', mode, oid, relativePath], indexEnv);
              baseline.included.push(relativePath);
            } else { excluded('non-regular'); }
          }
        }
        await walk(root);
        await verifyRoot();
        const tree = (await git(root, ['write-tree'], indexEnv)).trim();
        initialCommit = (await git(root, ['commit-tree', tree, '-m', 'Initial project baseline'])).trim();
        await checkpoint({ phase: 'commit-prepared', initialCommit, baseline });
      }
      await verifyRoot();
      const current = await readHead(git, root);
      if (current && current !== initialCommit) throw fail('PROJECT_GIT_HEAD_CONFLICT', 'HEAD changed before baseline publication');
      if (!current) {
        const branch = (await git(root, ['symbolic-ref', 'HEAD'])).trim();
        if (branch !== 'refs/heads/main') throw fail('PROJECT_GIT_HEAD_CONFLICT', 'Initial branch changed');
        await git(root, ['update-ref', branch, initialCommit, '0'.repeat(initialCommit.length)]);
      }
      // Publish a baseline index only for our newly created repository, never
      // replacing an index another writer supplied during initialization.
      if (!await exists(path.join(ownGit, 'index'))) {
        const baselineIndex = path.join(scratch, 'baseline-index');
        await git(root, ['read-tree', initialCommit], { GIT_INDEX_FILE: baselineIndex });
        const indexLock = path.join(ownGit, 'index.lock');
        const lockHandle = await fs.open(indexLock, 'wx', 0o600);
        let lockIdentity, published = false;
        try {
          lockIdentity = await lockHandle.stat();
          await lockHandle.writeFile(await fs.readFile(baselineIndex));
          await lockHandle.sync();
          await verifyRoot();
          if (!await ownsLock(indexLock, lockIdentity)) throw fail('PROJECT_GIT_INDEX_CONFLICT', 'Index lock ownership changed');
          if (!await exists(path.join(ownGit, 'index'))) {
            await fs.rename(indexLock, path.join(ownGit, 'index'));
            published = true;
          }
        } finally {
          try { if (!published) await removeOwnedLock(indexLock, lockIdentity); }
          finally { await lockHandle.close(); }
        }
      }
      await checkpoint({ phase: 'committed' });
    }
    const result = { status: 'ready', operationId, ...repo, createdRepository: state.createdRepository, initialCommit, baseline: state.baseline || null, ignore: state.ignore || ignore, warnings };
    await checkpoint({ phase: 'complete', result });
    return result;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function readHead(git, root) {
  try { return (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim(); }
  catch (error) {
    // Only an unborn symbolic branch is an absent HEAD; corruption is an error.
    const branch = (await git(root, ['symbolic-ref', 'HEAD'])).trim();
    try { await git(root, ['show-ref', '--verify', '--quiet', branch]); }
    catch (missing) { if (missing.code === 1) return null; throw missing; }
    throw error;
  }
}

async function ensureIgnore(file, rule, effective, verifyRoot) {
  if (await effective()) return { path: file, rule, changed: false };
  const lock = file + '.lock';
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('PROJECT_GIT_IGNORE_BUSY', 'Git ignore file is being edited; retry explicitly'); throw error; }
  let lockIdentity, published = false;
  try {
    lockIdentity = await handle.stat();
    const stat = await exists(file);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw fail('PROJECT_GIT_IGNORE_CONFLICT', 'Git ignore file is not a regular file');
    const original = stat ? await fs.readFile(file) : Buffer.alloc(0);
    if (await effective()) return { path: file, rule, changed: false };
    const newline = original.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
    const separator = original.length && original[original.length - 1] !== 10 ? newline : '';
    await handle.writeFile(Buffer.concat([original, Buffer.from(separator + rule + newline)]));
    if (stat) await handle.chmod(stat.mode & 0o777);
    await handle.sync();
    await verifyRoot();
    const now = await exists(file);
    if (Boolean(stat) !== Boolean(now) || (stat && (!sameIdentity(stat, now) || !original.equals(await fs.readFile(file))))) throw fail('PROJECT_GIT_IGNORE_CONFLICT', 'Git ignore file changed concurrently');
    // Standard Git lockfile publication: cooperative writers serialize on .lock;
    // non-cooperative writers are detected by the byte/identity comparison.
    if (!await ownsLock(lock, lockIdentity)) throw fail('PROJECT_GIT_IGNORE_CONFLICT', 'Git ignore lock ownership changed');
    await fs.rename(lock, file);
    published = true;
    return { path: file, rule, changed: true };
  } finally {
    try { if (!published) await removeOwnedLock(lock, lockIdentity); }
    finally { await handle.close(); }
  }
}
