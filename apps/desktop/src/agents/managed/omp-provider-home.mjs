// Role homes are Nozeli-owned native state. Configuration is seeded once, never
// projected on each startup: every subsequent native config/models edit persists.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { OMP_CONFIG_FILES } from './omp-system-source.mjs';

async function optional(file) { try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function atomic(file, bytes) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
async function safe(file, directory = false) {
  const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))) throw new Error('Unsafe private OMP path: ' + file);
  return stat;
}

const inheritedCapability = /^(?:extensions?|plugins?|hooks?|commands?|shell|exec|executable|commandPrefix|terminal|skills?|skillful|packages?|marketplace|trust(?:ed.*)?|mcp(?:Servers)?|lsp(?:Servers)?|auth|oauth|env|environment|startup|autoResume)$/i;
async function migrateProjectedCapabilities(home, parse, stringify) {
  if (!await safe(path.join(home, '.nozeli-omp-projection.json'))) return;
  const archive = path.join(home, '.nozeli-omp-capability-migration');
  await fs.mkdir(archive, { recursive: true, mode: 0o700 }); await safe(archive, true);
  const bridge = path.join(home, 'nozeli-terminal-bridge.mjs');
  for (const name of OMP_CONFIG_FILES) {
    const file = path.join(home, name);
    if (!await safe(file)) continue;
    const raw = await fs.readFile(file, 'utf8');
    let doc;
    try { doc = parse(raw) ?? {}; } catch { throw Object.assign(new Error('Private OMP configuration contains invalid YAML; original file preserved'), { code: 'CONFIG_INVALID' }); }
    let changed = false;
    function clean(value, trail = []) {
      if (Array.isArray(value)) return value.map(item => clean(item, trail));
      if (!value || typeof value !== 'object') return value;
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Object.assign(new Error('Unsafe private configuration key'), { code: 'CONFIG_INVALID' });
        const namespace = trail.length === 1 && ['providers', 'modelRoles'].includes(trail[0]);
        if (!namespace && typeof item === 'string' && (item.trimStart().startsWith('!') || (path.isAbsolute(item) && item.split(path.sep).includes('.omp')))) {
          changed = true;
          continue;
        }
        if (!namespace && key.split('.').some(segment => inheritedCapability.test(segment))) {
          changed = true;
          if (trail.length === 0 && key === 'extensions' && Array.isArray(item) && item.includes(bridge)) out[key] = [bridge];
          continue;
        }
        out[key] = clean(item, [...trail, key]);
      }
      return out;
    }
    const cleaned = clean(doc);
    if (!changed) continue;
    const backup = path.join(archive, name + '.original');
    if (!await safe(backup)) {
      const handle = await fs.open(backup, 'wx', 0o600);
      try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
    }
    await atomic(file, stringify(cleaned));
  }
}
const opaqueCredential = value => typeof value === 'string' && /^NOZELI_OMP_CONFIG_[A-Fa-f0-9]{64}$/.test(value);
async function migrateProjectedCredentials(home, source, parse, stringify) {
  const manifest = path.join(home, '.nozeli-omp-projection.json');
  if (!await safe(manifest)) return { loginRequired: false, unresolvedProviders: [] };
  const archive = path.join(home, '.nozeli-omp-credential-migration');
  await fs.mkdir(archive, { mode: 0o700, recursive: true }); await safe(archive, true);
  const statusFile = path.join(archive, 'status.json');
  await safe(statusFile);
  const prior = await optional(statusFile);
  const unresolved = new Set(prior ? JSON.parse(prior).unresolvedProviders : []);
  const parseSafe = raw => {
    try { return parse(raw) ?? {}; }
    catch { throw Object.assign(new Error('Private OMP configuration contains invalid YAML; original file preserved'), { code: 'CONFIG_INVALID' }); }
  };
  let privateModels = null;
  if (source) for (const name of ['models.yml', 'models.yaml']) {
    const file = path.join(source.agentDir, name);
    if (!await safe(file)) continue;
    privateModels = parseSafe(await fs.readFile(file, 'utf8')); break;
  }
  for (const name of ['models.yml', 'models.yaml']) {
    const file = path.join(home, name);
    if (!await safe(file)) continue;
    const raw = await fs.readFile(file, 'utf8'), doc = parseSafe(raw);
    let changed = false;
    for (const [provider, settings] of Object.entries(doc.providers ?? {})) {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) continue;
      const base = privateModels?.providers?.[provider];
      const replace = (container, key, replacement) => {
        if (!opaqueCredential(container[key])) return;
        changed = true;
        if (typeof replacement === 'string' && replacement && !opaqueCredential(replacement) && !replacement.trimStart().startsWith('!')) container[key] = replacement;
        else { delete container[key]; unresolved.add(provider); }
      };
      replace(settings, 'apiKey', base?.apiKey);
      if (settings.headers && typeof settings.headers === 'object' && !Array.isArray(settings.headers)) {
        for (const header of Object.keys(settings.headers)) replace(settings.headers, header, base?.headers?.[header]);
      }
    }
    if (!changed) continue;
    // Persist exact original bytes before changing any credential reference.
    const backup = path.join(archive, name + '.original');
    if (!await safe(backup)) {
      const handle = await fs.open(backup, 'wx', 0o600);
      try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
    }
    const status = { version: 1, loginRequired: unresolved.size > 0, unresolvedProviders: [...unresolved] };
    await atomic(statusFile, JSON.stringify(status));
    await atomic(file, stringify(doc));
  }
  return { loginRequired: unresolved.size > 0, unresolvedProviders: [...unresolved] };
}
export async function prepareOmpPrivateHome(home, { system = null, legacyNativeSeed = null } = {}) {
  if (!path.isAbsolute(home)) throw new Error('OMP private home must be absolute');
  if (system && !system.private) throw new Error('Only a Nozeli-owned OMP source may seed role configuration');
  if (system) {
    const relative = path.relative(system.root, home);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Role home must be beneath the Nozeli root');
  }
  await fs.mkdir(home, { recursive: true, mode: 0o700 }); await safe(home, true);
  if (await fs.realpath(home) !== home) throw new Error('Private OMP home contains a symlink');
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true, mode: 0o700 }); await safe(path.join(home, 'sessions'), true);
  const marker = path.join(home, '.nozeli-omp-independent.json');
  await safe(marker);
  const markerRaw = await optional(marker);
  if (markerRaw !== null) {
    const record = JSON.parse(markerRaw);
    return { agentDir: home, seeded: false, loginRequired: Boolean(record.loginRequired), unresolvedProviders: record.unresolvedProviders ?? [] };
  }
  // Existing native files are authoritative, including migrated private drafts,
  // provider settings, tools, extensions and models. Never replace them with defaults.
  const existing = new Set();
  for (const name of OMP_CONFIG_FILES) if (await safe(path.join(home, name))) existing.add(name);
  const hasConfig = existing.has('config.yml') || existing.has('config.yaml');
  const hasModels = existing.has('models.yml') || existing.has('models.yaml');
  for (const name of OMP_CONFIG_FILES) {
    const target = path.join(home, name);
    const exists = await safe(target);
    if (exists || (name.startsWith('config.') ? hasConfig : hasModels) || !system) continue;
    const sourceFile = path.join(system.agentDir, name);
    if (!await safe(sourceFile)) continue;
    await atomic(target, await fs.readFile(sourceFile));
  }
  const { parse, stringify } = await import('yaml');
  const credentialMigration = await migrateProjectedCredentials(home, system, parse, stringify);
  await migrateProjectedCapabilities(home, parse, stringify);
  const configName = await safe(path.join(home, 'config.yml')) ? 'config.yml' : await safe(path.join(home, 'config.yaml')) ? 'config.yaml' : 'config.yml';
  const configFile = path.join(home, configName);
  const raw = await optional(configFile) ?? '';
  let doc;
  try { doc = parse(raw) ?? {}; }
  catch { throw Object.assign(new Error('Private OMP configuration contains invalid YAML; original file preserved'), { code: 'CONFIG_INVALID' }); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw Object.assign(new Error('Private OMP configuration must contain an object'), { code: 'CONFIG_INVALID' });
  if (!hasConfig) {
    doc.startup = { ...doc.startup, checkUpdate: false, showSplash: false };
    doc.marketplace = { ...doc.marketplace, autoUpdate: 'off' };
    doc.autoResume = false; doc.skillful = false; doc.setupVersion = 2;
    if (legacyNativeSeed?.model && !doc.modelRoles?.default) doc.modelRoles = { ...doc.modelRoles, default: legacyNativeSeed.model };
    if (legacyNativeSeed?.effort && !doc.defaultThinkingLevel) doc.defaultThinkingLevel = legacyNativeSeed.effort;
    await atomic(configFile, stringify(doc));
  }
  // Remove only the obsolete role-local encrypted system broker snapshot.
  const cache = path.join(home, '.omp', 'cache');
  if (await safe(path.join(home, '.omp'), true) && await safe(cache, true)) await fs.rm(path.join(cache, 'auth-broker-snapshot.enc'), { force: true });
  await atomic(marker, JSON.stringify({ version: 1, ...credentialMigration }));
  return { agentDir: home, seeded: true, ...credentialMigration };
}
// Copy only the explicitly selected global provider; unrelated native edits stay owned by this home.
export async function syncOmpSelectedProvider(home, system, selector) {
  if (!system || !selector) return;
  if (!system.private) throw new Error('Only a Nozeli-owned OMP source may supply models');
  const relative = path.relative(system.root, home);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Role home must be beneath the Nozeli root');
  const { parse, stringify } = await import('yaml');
  const provider = selector.slice(0, selector.indexOf('/'));
  if (!provider) return;
  let source;
  for (const name of ['models.yml', 'models.yaml']) {
    const file = path.join(system.agentDir, name);
    if (await safe(file)) { source = parse(await fs.readFile(file, 'utf8')); break; }
  }
  if (!Object.hasOwn(source?.providers ?? {}, provider)) return;
  await safe(home, true);
  let file = path.join(home, 'models.yml'), doc = {};
  for (const name of ['models.yml', 'models.yaml']) {
    const candidate = path.join(home, name);
    if (await safe(candidate)) { file = candidate; doc = parse(await fs.readFile(candidate, 'utf8')) ?? {}; break; }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || (doc.providers && (typeof doc.providers !== 'object' || Array.isArray(doc.providers)))) throw new Error('Invalid private OMP model configuration; original preserved');
  doc.providers = { ...doc.providers, [provider]: source.providers[provider] };
  await atomic(file, stringify(doc));
}
export async function ompEnvironmentKey(home) {
  return `omp:${createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 24)}`;
}
