// Pi configuration is Nozeli-private: the Pi home (models.json, auth.json,
// sessions) lives only beneath the Nozeli root. Ambient ~/.pi is never read,
// written or imported; there is no system Pi discovery anywhere.
import path from 'node:path';

export function createNozeliPiSource(paths) {
  if (!paths || !path.isAbsolute(paths.root)) throw new Error('Absolute Nozeli paths required');
  const pi = path.join(paths.root, 'pi');
  const relative = path.relative(paths.root, pi);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Pi configuration must be beneath the Nozeli root');
  const layout = { root: paths.root, configRoot: paths.root, agentDir: pi, dataDir: pi, stateDir: pi, cacheDir: pi, profile: null };
  return { ...layout, private: true, describe: async () => ({ ...layout }) };
}
