// Official OMP is read only during an explicitly requested one-time import.
import os from 'node:os';
import path from 'node:path';

export const OMP_CONFIG_FILES = ['config.yml', 'config.yaml', 'models.yml', 'models.yaml'];
export function realUserHome() {
  const home = os.userInfo({ encoding: 'utf8' }).homedir;
  if (!path.isAbsolute(home)) throw new Error('Cannot determine the OS user home');
  return path.resolve(home);
}

export function createNozeliOmpSource(paths) {
  if (!paths || !path.isAbsolute(paths.root) || !path.isAbsolute(paths.omp)) throw new Error('Absolute Nozeli paths required');
  const relative = path.relative(paths.root, paths.omp);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('OMP configuration must be beneath the Nozeli root');
  const layout = { root: paths.root, configRoot: paths.root, agentDir: paths.omp, dataDir: paths.omp, stateDir: paths.omp, cacheDir: paths.omp, profile: null };
  return { ...layout, private: true, describe: async () => ({ ...layout }) };
}

// Call only inside explicit import. This resolver never runs during ordinary startup.
export function resolveSystemOmpSource({ env = process.env, home = realUserHome() } = {}) {
  if (!path.isAbsolute(home)) throw new Error('Absolute import home required');
  const rawProfile = env.OMP_PROFILE ?? env.PI_PROFILE;
  const profile = rawProfile && rawProfile !== 'default' ? rawProfile : null;
  if (profile && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) throw new Error('Invalid import profile');
  const configRoot = path.join(home, env.PI_CONFIG_DIR || '.omp', ...(profile ? ['profiles', profile] : []));
  const agentDir = !profile && env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : path.join(configRoot, 'agent');
  return { configRoot, agentDir, profile, describe: async () => ({ configRoot, agentDir, profile }) };
}

const unsafeKey = /^(?:extensions?|plugins?|hooks?|commands?|shell|exec|executable|commandPrefix|terminal|skills?|skillful|packages?|marketplace|trust(?:ed.*)?|mcp(?:Servers)?|lsp(?:Servers)?|auth|oauth|env|environment|startup|autoResume)$/i;
const secretKey = /api[-_]?key|token|secret|password|credential|privateKey|authorization|headers/i;
// Imported data must not activate ambient executables, project trust or OAuth/brokers.
// Keys are copied only by explicit consent; command-valued credentials never are.
export function sanitizeOmpConfig(value, { includeApiKeys = false, env = process.env } = {}) {
  const safeTop = new Set(['providers', 'modelRoles', 'defaultModel', 'defaultProvider', 'defaultThinkingLevel', 'theme', 'thinkingLevel', 'model', 'models', 'maxTokens', 'temperature', 'contextWindow']);
  function visit(item, trail = []) {
    if (Array.isArray(item)) return item.map(value => visit(value, trail));
    if (!item || typeof item !== 'object') return item;
    const result = {};
    for (const [key, child] of Object.entries(item)) {
      if (trail.length === 0 && !safeTop.has(key)) continue;
      if (typeof child === 'string' && child.trimStart().startsWith('!')) continue;
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe OMP configuration key');
      // Provider IDs and model-role names are data, not executable/secret fields.
      // Keep their namespace segment intact (IDs may contain dots).
      if (trail.length === 1 && ['providers', 'modelRoles'].includes(trail[0])) {
        result[key] = visit(child, [...trail, key]);
        continue;
      }
      const segments = key.split('.');
      if (segments.some(segment => unsafeKey.test(segment))) continue;
      const providerField = trail[0] === 'providers' && trail.length >= 2;
      const providerHeaders = providerField && trail[2] === 'headers';
      if (secretKey.test(key) || providerHeaders) {
        // Only provider API keys and static headers are valid consented secrets.
        if (!includeApiKeys || !providerField || !(/api[-_]?key|headers|authorization/i.test(key) || providerHeaders)) continue;
        if (typeof child === 'string') {
          if (child.trimStart().startsWith('!')) continue;
          const resolved = /^[A-Z][A-Z0-9_]*$/.test(child) ? env[child] : child;
          if (typeof resolved === 'string' && resolved && !resolved.trimStart().startsWith('!')) result[key] = resolved;
        } else if (child && typeof child === 'object') result[key] = visit(child, [...trail, key]);
        continue;
      }
      result[key] = visit(child, [...trail, ...segments]);
    }
    return result;
  }
  return visit(value);
}
