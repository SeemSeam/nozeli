import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realUserHome, resolveSystemOmpSource, sanitizeOmpConfig, OMP_CONFIG_FILES } from './omp-system-source.mjs';

const inside = (root, file) => { const rel = path.relative(root, file); return !rel.startsWith('..') && !path.isAbsolute(rel); };
const present = file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
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


export async function initializeNozeliConfiguration(paths) {
  await safeDirectory(paths.root);
  return withLock(paths, async () => {
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
