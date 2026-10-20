// Linux candidate: validate an independent snapshot without touching current,
// launchers or menus. Retain one pending candidate plus current/rollback/live.
import fs from 'node:fs/promises';
import path from 'node:path';
import {packageRelease} from './local-release.mjs';
import {installationRoot, withInstallationLock, retainReleases} from './release-retention.mjs';

if (process.platform !== 'linux') throw Error('Candidate packaging supports Linux only; Windows/macOS installation is not implemented.');
const [label, ...extra] = process.argv.slice(2);
if (!label || extra.length || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(label)) throw Error('usage: node tools/package-candidate.mjs <release-label>');
const source = path.resolve(import.meta.dirname, '..');
const root = installationRoot();
const release = path.join(root, 'releases', label);
await withInstallationLock(root, async () => {
  try { await fs.lstat(release); throw Error('Release label already exists: ' + label); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Bound remnants from interrupted/failed packaging before allocating another
  // snapshot; current, rollback and live processes remain protected.
  await retainReleases({root, mode: 'candidate'});
  await packageRelease({root, release, source});
  const retention = await retainReleases({root, mode: 'candidate', protect: [release]});
  console.log(JSON.stringify({release, currentUntouched: true, retention}, null, 2));
});
