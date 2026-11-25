import path from 'node:path';
import {runGit} from '../agents/managed/git-runtime.mjs';
import {createProjectGitIO} from './project-git-io.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code});
const sameIdentity=(a,b)=>String(a.dev)===String(b.dev)&&String(a.ino)===String(b.ino);
const NIL = process.platform === 'win32' ? 'NUL' : '/dev/null';
// A conservative filename policy, not content inspection or a secret detector.
// Directory exclusions cover their entire subtree without opening its files.
function sensitiveBaselineName(name) {
  return /^\.env(?:$|[._-]|rc(?:$|[._-]))/i.test(name)
    || /^(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.docker|\.npmrc|\.pypirc|\.?netrc|\.htpasswd|\.git-credentials|\.gitconfig|id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?)$/i.test(name)
    || /\.(?:pem|key|p12|pfx|ppk|jks|keystore)$/i.test(name)
    || /(?:^|[._-])(?:credentials?|secrets?|passwords?|api[-_]?keys?|private[-_]?keys?|service[-_]?accounts?|tokens?)(?:[._-]|$)/i.test(name);
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
export async function ensureProjectGit(root, {operationId,expectedIdentity,journal,ioFactory=createProjectGitIO}={}) {
 const io=ioFactory(path.resolve(root));
 try{return await initializeProjectGit(root,{operationId,expectedIdentity,journal,io});}
 finally{await io.close?.();}
}
async function initializeProjectGit(root,{operationId,expectedIdentity,journal,io}) {
  io.requireSupported();
  const exists=file=>io.exists(file);
  if (!operationId || !expectedIdentity || !journal?.read || !journal?.write) {
    throw fail('PROJECT_GIT_OPTIONS', 'operationId, expectedIdentity {dev,ino}, and durable journal {read,write} are required');
  }
  root = path.resolve(root);
  let repositoryIdentity=null;
  let worktreeBinding=null;
  async function verifyRoot() {
    if(!sameIdentity(await io.directoryIdentity(root),expectedIdentity))throw fail('PROJECT_IDENTITY_CONFLICT','Project directory identity changed');
    if(repositoryIdentity&&!sameIdentity(await io.directoryIdentity(repositoryIdentity.root),repositoryIdentity))throw fail('PROJECT_GIT_CONFLICT','Git根目录实体已变化');
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
  const scratch = await io.createScratch(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NIL, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Nozeli', GIT_AUTHOR_EMAIL: 'initialization@nozeli.local',
    GIT_COMMITTER_NAME: 'Nozeli', GIT_COMMITTER_EMAIL: 'initialization@nozeli.local',
  });
  const config = ['-c', `core.hooksPath=${scratch}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', `core.attributesFile=${NIL}`, '-c', 'commit.gpgsign=false'];
  const git = async(cwd,args,extra={})=>{await io.beforeGit?.(args);return runGit(cwd,[...config,...(io.gitConfig??[]),...args],{env:{...env,...extra},encoding:'utf8'});};
  async function repository() {
    // Distinguish a genuinely absent repository from permissions, corruption,
    // dubious ownership, or a failed bundled runtime. Only absence allows init.
    let cursor = root;
    for (;;) {
      const dotGit=await exists(path.join(cursor,'.git'));
      if (dotGit) {
        const linked=await io.prepareRepository?.(cursor,dotGit);
        const repositoryRoot = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
        if(path.resolve(repositoryRoot)!==cursor||await io.canonicalDirectory(repositoryRoot)!==cursor)throw fail('PROJECT_GIT_CONFLICT','Git报告的根不属于已发现项目祖先');
        repositoryIdentity={root:cursor,...await io.directoryIdentity(cursor)};
        const gitDirectory = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
        if(linked){
          const common=(await git(root,['rev-parse','--path-format=absolute','--git-common-dir'])).trim();
          const canonicalOutput=file=>path.normalize(file).replace(/^[a-z]:/i,drive=>drive.toUpperCase());
          if(!path.isAbsolute(gitDirectory)||!path.isAbsolute(common)||canonicalOutput(gitDirectory)!==canonicalOutput(linked.gitDirectory)||canonicalOutput(common)!==canonicalOutput(linked.commonDirectory))throw fail('PROJECT_GIT_CONFLICT','Git reported a different linked worktree layout');
        }
        worktreeBinding=linked?.binding??null;
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
      await checkpoint({ version: 1, operationId, root, identity: { dev: String(expectedIdentity.dev), ino: String(expectedIdentity.ino) }, createdRepository: !repo, phase: 'prepared', ...(worktreeBinding?{...repo,worktreeBinding}:{}) });
    }
    const ownGit = path.join(root, '.git');
    const marker = path.join(ownGit, 'nozeli-initialization');
    if (state.createdRepository) {
      await verifyRoot();
      let dir = await exists(ownGit);
      if (!dir) {
        if (state.phase !== 'prepared') throw fail('PROJECT_GIT_CONFLICT', 'Initialized repository disappeared');
        await io.allocateRepository(ownGit,marker,operationId);
      } else if (!dir.isDirectory() || dir.isSymbolicLink() || await io.readText(marker).catch(() => null) !== operationId) {
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
      if(state.repositoryRoot&&JSON.stringify(state.worktreeBinding??null)!==JSON.stringify(worktreeBinding))throw fail('PROJECT_GIT_CONFLICT','Linked worktree ownership changed');
      if (state.phase==='prepared') await checkpoint({ phase: 'initialized', ...repo, ...(worktreeBinding?{worktreeBinding}:{}) });
    }
    await verifyRoot();
    const relative = path.relative(repo.repositoryRoot, root).split(path.sep).join('/');
    if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('../'))throw fail('PROJECT_GIT_CONFLICT','项目范围不在Git根内');
    const ignoredPath = (relative ? relative + '/' : '') + '.nozeli/';
    if (/[\r\n]/.test(ignoredPath)) throw fail('PROJECT_GIT_IGNORE_PATH', 'Project path cannot be represented safely in a Git ignore rule');
    // Escape Git wildmatch metacharacters; this is one exact Git-root-relative rule.
    const rule = '/' + ignoredPath.replace(/[\\*?\[\]#! ]/g, '\\$&');
    const ignoreFile = path.join(repo.repositoryRoot, '.gitignore');
    const ignore = await io.ensureIgnore(ignoreFile, rule, async () => {
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
          const items = await io.listDirectory(directory);
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
              await io.directoryIdentity(full);
              if (await exists(path.join(full, '.git')) || (await exists(path.join(full, 'HEAD')) && await exists(path.join(full, 'objects')) && await exists(path.join(full, 'refs')))) { excluded('nested-repository'); continue; }
              await walk(full, relativePath + '/');
            } else if (item.isFile()) {
              const {oid,mode}=await io.captureFile(full,config,root,env);
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
      const headPin=io.pinInitialHead?.(ownGit);
      let branchPin;
      try {
        const current = await readHead(git, root);
        if (current && current !== initialCommit) throw fail('PROJECT_GIT_HEAD_CONFLICT', 'HEAD changed before baseline publication');
        if (!current) {
          const branch = (await git(root, ['symbolic-ref', 'HEAD'])).trim();
          if (branch !== 'refs/heads/main') throw fail('PROJECT_GIT_HEAD_CONFLICT', 'Initial branch changed');
          headPin?.verify();
          await git(root, ['update-ref', ...(headPin?['--no-deref']:[]), branch, initialCommit, '0'.repeat(initialCommit.length)]);
        }
        // Never replace an index another writer supplied during initialization.
        if (!await exists(path.join(ownGit, 'index'))) {
          branchPin=io.pinInitialBranch?.(ownGit,initialCommit);
          const baselineIndex = path.join(scratch, 'baseline-index');
          await git(root, ['read-tree', initialCommit], { GIT_INDEX_FILE: baselineIndex });
          await io.publishInitialIndex(ownGit,baselineIndex,async()=>{await verifyRoot();headPin?.verify();branchPin?.verify();});
        }
        headPin?.verify();
        branchPin?.verify();
        await checkpoint({ phase: 'committed' });
      } finally { try{branchPin?.close();}finally{headPin?.close();} }
    }
    const result = { status: 'ready', operationId, ...repo, createdRepository: state.createdRepository, initialCommit, baseline: state.baseline || null, ignore: state.ignore || ignore, warnings };
    await checkpoint({ phase: 'complete', result });
    return result;
  } finally {
    await io.removeScratch(scratch);
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
