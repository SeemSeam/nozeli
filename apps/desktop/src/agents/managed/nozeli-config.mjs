import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { realUserHome, resolveSystemOmpSource, sanitizeOmpConfig, OMP_CONFIG_FILES } from './omp-system-source.mjs';
import { runGit } from './git-runtime.mjs';
import { processStamp } from './process-ownership.mjs';

const inside = (root, file) => { const rel = path.relative(root, file); return !rel.startsWith('..') && !path.isAbsolute(rel); };
const present = file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function atomic(file, bytes) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(tmp, file);
  if (process.platform !== 'win32') { const dir = await fs.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
}
async function json(file) { const stat = await present(file); if (!stat) return null; if (!stat.isFile() || stat.isSymbolicLink()) fail('CONFIG_UNSAFE', 'Configuration record must be an ordinary file: ' + file); return JSON.parse(await fs.readFile(file, 'utf8')); }
async function safeDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) await safeDirectory(parent);
  const stat = await present(directory);
  if (!stat) await fs.mkdir(directory, { mode: 0o700 });
  else if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CONFIG_UNSAFE', 'Directory must not be a symlink: ' + directory);
}
export function resolveNozeliPaths({ env = process.env, home = realUserHome() } = {}) {
  if (!path.isAbsolute(home)) fail('CONFIG_ROOT_INVALID', 'Absolute OS home required');
  const testing = env.NOZELI_TEST_INSTANCE === '1';
  const override = testing && env.NOZELI_USER_DATA;
  if (testing && ((env.NOZELI_CONFIG_ROOT && !path.isAbsolute(env.NOZELI_CONFIG_ROOT)) || (override && !path.isAbsolute(override)))) fail('CONFIG_ROOT_INVALID', 'Test roots must be absolute');
  const root = path.resolve(testing && env.NOZELI_CONFIG_ROOT || (override ? path.dirname(override) : path.join(home, '.Nozeli')));
  const desktop = override ? path.resolve(override) : path.join(root, 'desktop');
  if (!inside(root, desktop) || root === desktop) fail('CONFIG_ROOT_INVALID', 'Test desktop must be beneath the explicit Nozeli root');
  return { root, desktop, omp: path.join(root, 'omp'), migrations: path.join(root, 'migrations') };
}
async function withLock(paths, fn) {
  await safeDirectory(paths.migrations);
  const file = path.join(paths.migrations, 'configuration.lock');
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const record = await json(file);
    let alive = true; try { process.kill(record.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) fail('CONFIG_BUSY', 'Another configuration operation is active');
    await fs.unlink(file); handle = await fs.open(file, 'wx', 0o600);
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid }));
  try { return await fn(); } finally { await handle.close(); await fs.unlink(file); }
}

// Only structural host-owned metadata is rewritten. Drafts, job text, native JSONL,
// source ledgers, report bodies and project-local .nozeli files stay byte-identical.
const PATH_KEYS = new Set(['home', 'cwd', 'directory', 'artifactDirectory', 'sessionFile', 'repo', 'gitDir', 'commonDir', 'workerGitDir', 'index', 'contentRoot', 'runtime', 'root', 'file', 'path']);
const TEXT_KEYS = new Set(['text', 'request', 'brief', 'prompt', 'body', 'drafts', 'inputs', 'sourceText', 'sourceContext']);
function relocate(value, source, target) {
  if (Array.isArray(value)) return value.map(item => relocate(item, source, target));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (TEXT_KEYS.has(key)) result[key] = item;
    else if (PATH_KEYS.has(key) && typeof item === 'string' && path.isAbsolute(item) && inside(source, item)) result[key] = path.join(target, path.relative(source, item));
    else result[key] = relocate(item, source, target);
  }
  return result;
}
async function scanLegacy(root, recordedRoot = root) {
  const files = [];
  const singletonNames = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  const lockFile = path.join(root, 'SingletonLock'), singletonLock = await present(lockFile);
  let staleSingleton = false;
  if (singletonLock) {
    if (!singletonLock.isSymbolicLink()) fail('MIGRATION_SOURCE_LOCKED', 'Unrecognized Electron singleton ownership: ' + lockFile);
    const descriptor = await fs.readlink(lockFile), match = /^(.*)-(\d+)$/.exec(descriptor);
    if (!match || match[1] !== os.hostname()) fail('MIGRATION_SOURCE_LOCKED', 'Electron singleton belongs to an unknown host; source preserved: ' + lockFile);
    try { process.kill(Number(match[2]), 0); fail('MIGRATION_SOURCE_LIVE', 'Legacy Electron process is still alive: ' + match[2]); }
    catch (error) { if (error.code !== 'ESRCH') throw error; staleSingleton = true; }
  }
  async function visit(dir) {
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name), stat = await fs.lstat(file);
      if (dir === root && singletonNames.includes(name)) {
        if (!staleSingleton) fail('MIGRATION_SOURCE_LOCKED', 'Electron singleton ownership is uncertain; source preserved: ' + file);
        continue;
      }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('MIGRATION_UNSAFE', 'Unsupported legacy link/special file; source preserved: ' + file);
      if (stat.isDirectory()) await visit(file);
      else {
        if (name === 'host.lock' || name === 'recovery.lock') {
          const owner = await json(file);
          if (!owner?.pid) fail('MIGRATION_SOURCE_LOCKED', 'Legacy owner requires explicit recovery: ' + file);
          try { process.kill(owner.pid, 0); fail('MIGRATION_SOURCE_LIVE', 'Legacy desktop is still running: ' + file); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        const rel = path.relative(root, file).split(path.sep).join('/');
        if (/^nozeli\/managed-v1\/[^/]+\/runtime\/state\.json$/.test(rel)) {
          const state = await json(file);
          for (const record of Object.values(state?.providers ?? {})) {
            const agents = path.join(recordedRoot, path.dirname(rel), 'agents');
            if (!Number.isInteger(record?.pid) || record.pid <= 0 || typeof record.home !== 'string' || !path.isAbsolute(record.home)) fail('MIGRATION_SOURCE_LOCKED', 'Legacy provider ownership is incomplete; source preserved: ' + file);
            const relocatedAgents = path.join(root, path.dirname(rel), 'agents');
            const owned = base => record.home !== base && inside(base, record.home);
            if (!owned(agents) && !owned(relocatedAgents)) fail('MIGRATION_SOURCE_LOCKED', 'Legacy provider home is outside its owned agents directory; explicit recovery required: ' + file);
            let alive = true;
            try { process.kill(record.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else if (error.code !== 'EPERM') throw error; }
            if (!alive) continue;
            let stamp = null;
            try { stamp = await processStamp(record.pid); } catch { fail('MIGRATION_SOURCE_LOCKED', 'Legacy provider identity cannot be inspected; source preserved: ' + file); }
            if (process.platform === 'linux' && record.stamp && stamp && record.stamp !== stamp) fail('MIGRATION_SOURCE_LOCKED', 'Legacy provider PID was reused; explicit ownership recovery required before migration: ' + file);
            fail('MIGRATION_SOURCE_LIVE', 'A legacy provider process is still alive or its identity is uncertain; stop it through the old desktop before migration: ' + file);
          }
        }
        files.push(file);
      }
    }
  }
  await visit(root); return files;
}
async function migrateDesktop(paths, legacyDesktop) {
  const journalFile = path.join(paths.migrations, 'desktop-v1.json');
  let journal = await json(journalFile);
  if (journal?.phase === 'complete') return;
  if (journal && !['prepared', 'moved', 'relocated'].includes(journal.phase)) fail('MIGRATION_RECOVERY_REQUIRED', 'Inspect preserved migration journal: ' + journalFile);
  if (!journal) {
    if (!legacyDesktop || path.resolve(legacyDesktop) === paths.desktop || !await present(legacyDesktop)) return;
    const source = path.resolve(legacyDesktop);
    if (inside(source, paths.root) || inside(paths.root, source)) fail('MIGRATION_OVERLAP', 'Legacy and new roots overlap');
    if (await present(paths.desktop)) fail('MIGRATION_TARGET_CONFLICT', 'Both desktop profiles exist; neither was changed');
    await safeDirectory(path.dirname(source));
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) fail('MIGRATION_UNSAFE', 'Legacy desktop is not an ordinary directory');
    const files = await scanLegacy(source), edits = [], worktrees = [];
    for (const file of files) {
      const rel = path.relative(source, file).split(path.sep).join('/');
      if (/^nozeli\/managed-v1\/[^/]+\/runtime\/agents\/[^/]+\/config\.ya?ml$/.test(rel)) {
        const { parse, stringify } = await import('yaml');
        const before = await fs.readFile(file, 'utf8');
        let doc;
        try { doc = parse(before); } catch { fail('CONFIG_INVALID', 'Legacy native configuration contains invalid YAML; original file preserved'); }
        if (Array.isArray(doc?.extensions)) {
          let changed = false;
          doc.extensions = doc.extensions.map(entry => {
            if (typeof entry === 'string' && path.isAbsolute(entry) && inside(source, entry) && path.basename(entry) === 'nozeli-terminal-bridge.mjs') { changed = true; return path.join(paths.desktop, path.relative(source, entry)); }
            return entry;
          });
          if (changed) edits.push({ rel, before, after: stringify(doc), digest: hash(before) });
        }
        continue;
      }
      if (!/^nozeli\/managed-v1\/[^/]+\/(?:runtime\/state\.json|runtime\/evidence\/execution-[^/]+\.json|runtime\/memory\/reports\/[^/]+\.json|binding\.json)$/.test(rel)) continue;
      const before = await fs.readFile(file, 'utf8'), parsed = JSON.parse(before), after = JSON.stringify(relocate(parsed, source, paths.desktop), null, 2);
      if (/\/execution-[^/]+\.json$/.test(rel) && parsed.workerGitDir && parsed.gitPointer && parsed.directory && inside(source, parsed.directory)) {
        if (inside(source, parsed.repo) || inside(source, parsed.workerGitDir)) fail('MIGRATION_WORKTREE_RECOVERY_REQUIRED', 'Repository Git metadata is inside the legacy desktop; source preserved for explicit recovery: ' + file);
        const pointer = await fs.readFile(path.join(parsed.directory, '.git'), 'utf8');
        const back = (await fs.readFile(path.join(parsed.workerGitDir, 'gitdir'), 'utf8')).trim();
        if (pointer !== parsed.gitPointer || back !== path.join(parsed.directory, '.git')) fail('MIGRATION_WORKTREE_IDENTITY', 'Worker Git identity changed: ' + file);
        worktrees.push({ repo: parsed.repo, directory: path.join(paths.desktop, path.relative(source, parsed.directory)), originalDirectory: parsed.directory, workerGitDir: parsed.workerGitDir });
      }
      if (after !== before) edits.push({ rel, before, after, digest: hash(before) });
    }
    journal = { version: 1, phase: 'prepared', source, target: paths.desktop, edits, worktrees, automaticReplay: false, rollback: { requiresStoppedDesktop: true, restoreMetadataFrom: 'edits[].before', renameTargetBackTo: source, repairWorktreesBackTo: 'worktrees[].originalDirectory', automatic: false } };
    await atomic(journalFile, JSON.stringify(journal));
  }
  const save = async phase => { journal.phase = phase; await atomic(journalFile, JSON.stringify(journal)); };
  if (journal.phase === 'prepared') {
    const source = await present(journal.source), target = await present(journal.target);
    if (source && target) fail('MIGRATION_TARGET_CONFLICT', 'Migration source and target both exist; inspect journal ' + journalFile);
    if (source) {
      await scanLegacy(journal.source);
      for (const edit of journal.edits) if (hash(await fs.readFile(path.join(journal.source, edit.rel))) !== edit.digest) fail('MIGRATION_METADATA_CONFLICT', 'Source metadata changed before relocation; source preserved: ' + edit.rel);
      try { await fs.rename(journal.source, journal.target); }
      catch (error) { if (error.code === 'EXDEV') fail('MIGRATION_CROSS_DEVICE', 'Move the stopped legacy profile to the same filesystem before retrying; source preserved: ' + journal.source); throw error; }
    } else if (!target) fail('MIGRATION_RECOVERY_REQUIRED', 'Neither migration profile exists: ' + journalFile);
    await save('moved');
  }
  if (journal.phase === 'moved') {
    await scanLegacy(journal.target, journal.source);
    // The old profile is now exclusively relocated. Remove only proven-stale
    // root Electron singleton artifacts, never following their socket symlinks.
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const file = path.join(journal.target, name);
      if (await present(file)) await fs.unlink(file);
    }
    for (const edit of journal.edits) {
      const file = path.join(journal.target, edit.rel), current = await fs.readFile(file, 'utf8');
      if (current === edit.after) continue;
      if (hash(current) !== edit.digest) fail('MIGRATION_METADATA_CONFLICT', 'Relocation metadata changed; original bytes in recovery journal: ' + file);
      await atomic(file, edit.after);
    }
    for (const tree of journal.worktrees) {
      if (inside(journal.source, tree.repo) || inside(journal.source, tree.workerGitDir)) fail('MIGRATION_WORKTREE_RECOVERY_REQUIRED', 'Repository Git metadata is inside the old desktop; recover from migration journal before opening: ' + journalFile);
      await runGit(tree.repo, ['worktree', 'repair', tree.directory]);
      const back = (await fs.readFile(path.join(tree.workerGitDir, 'gitdir'), 'utf8')).trim();
      if (back !== path.join(tree.directory, '.git')) fail('MIGRATION_WORKTREE_REPAIR', 'Git registration requires recovery; journal: ' + journalFile);
    }
    await save('relocated');
  }
  await save('complete');
}

export async function initializeNozeliConfiguration(paths, { legacyDesktop = null } = {}) {
  await safeDirectory(paths.root);
  return withLock(paths, async () => {
    await migrateDesktop(paths, legacyDesktop);
    await safeDirectory(paths.desktop); await safeDirectory(paths.omp);
    return readNozeliConfiguration(paths);
  });
}
export async function readNozeliConfiguration(paths) {
  const record = await json(path.join(paths.migrations, 'setup-v1.json'));
  const initialized = record?.phase === 'complete';
  return { version: 1, initialized, choiceRequired: !initialized, choice: initialized ? record.choice : null, apiKeyImportSupported: true, oauthRequiresLogin: true };
}
export async function completeNozeliConfiguration(paths, { choice, includeApiKeys = false, source = null } = {}) {
  if (!['independent', 'import'].includes(choice)) fail('CONFIG_CHOICE_INVALID', 'Choose independent or import');
  return withLock(paths, async () => {
    const marker = path.join(paths.migrations, 'setup-v1.json');
    let record = await json(marker);
    if (record?.phase === 'complete') fail('CONFIG_ALREADY_INITIALIZED', 'Configuration choice has already been completed');
    await safeDirectory(paths.omp);
    if (!record) {
      const stage = path.join(paths.migrations, 'import-' + randomUUID());
      await safeDirectory(stage);
      if (choice === 'import') {
        const origin = source ?? resolveSystemOmpSource();
        const realOrigin = await fs.realpath(origin.agentDir).catch(error => { if (error.code === 'ENOENT') return path.resolve(origin.agentDir); throw error; });
        if (realOrigin !== path.resolve(origin.agentDir)) fail('CONFIG_IMPORT_UNSAFE', 'Import source ancestry contains a symlink');
        if (inside(paths.root, realOrigin) || inside(realOrigin, paths.root)) fail('CONFIG_IMPORT_OVERLAP', 'Import source and Nozeli root overlap');
        const { parse, stringify } = await import('yaml');
        for (const name of OMP_CONFIG_FILES) {
          const file = path.join(origin.agentDir, name), stat = await present(file);
          if (!stat) continue;
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('CONFIG_IMPORT_UNSAFE', 'Import config must be an ordinary unlinked file');
          const raw = await fs.readFile(file, 'utf8');
          let doc;
          try { doc = parse(raw) ?? {}; } catch { fail('CONFIG_IMPORT_INVALID', 'Import configuration contains invalid YAML; original file preserved'); }
          if (typeof doc !== 'object' || Array.isArray(doc)) fail('CONFIG_IMPORT_INVALID', 'Import config must contain an object');
          await atomic(path.join(stage, name), stringify(sanitizeOmpConfig(doc, { includeApiKeys })));
        }
      }
      record = { version: 1, phase: 'staged', choice, includeApiKeys: choice === 'import' && includeApiKeys, stage };
      await atomic(marker, JSON.stringify(record));
    }
    if (record.choice !== choice) fail('CONFIG_IMPORT_RECOVERY_REQUIRED', 'Finish the journaled configuration choice before selecting another');
    if (!inside(paths.migrations, record.stage) || path.dirname(record.stage) !== paths.migrations) fail('CONFIG_IMPORT_UNSAFE', 'Invalid staged import directory');
    for (const name of await fs.readdir(record.stage)) {
      if (!OMP_CONFIG_FILES.includes(name)) fail('CONFIG_IMPORT_UNSAFE', 'Unexpected staged import file');
      const target = path.join(paths.omp, name), bytes = await fs.readFile(path.join(record.stage, name));
      const stat = await present(target);
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink() || !bytes.equals(await fs.readFile(target))) fail('CONFIG_IMPORT_CONFLICT', 'Private configuration exists; no overwrite: ' + name);
      } else await atomic(target, bytes);
    }
    record.phase = 'complete'; record.completedAt = new Date().toISOString();
    await atomic(marker, JSON.stringify(record));
    await fs.rm(record.stage, { recursive: true });
    return readNozeliConfiguration(paths);
  });
}
