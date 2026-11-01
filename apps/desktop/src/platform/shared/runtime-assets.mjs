// Shared, real checks for bundled runtime assets (Node/Pi/Git/OMP resolvers).
// Extracted from the runtime resolvers so executable naming, path safety and
// integrity verification have one tested implementation instead of three
// near-copies. Every helper preserves the resolvers' failure semantics: a
// missing, linked or non-executable asset is an explicit error, never a
// fallback to an ambient system install.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// A bundled executable is named per platform: Windows ships `name.exe` at the
// package root, POSIX layouts ship `bin/name`.
export function runtimeExecutableName(platform = process.platform, { win32 = 'node.exe', posix = 'bin/node' } = {}) {
  return platform === 'win32' ? win32 : posix;
}

export function manifestExecutable(manifest, platform = process.platform, names) {
  return manifest?.executable || runtimeExecutableName(platform, names);
}

// Access rule shared by all bundled executables: Windows checks presence
// (F_OK; executability is not an ACL bit there), other platforms require the
// executable bit (X_OK).
export async function assertExecutableAccess(file, { platform = process.platform } = {}) {
  await fs.access(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
}

// Verify a bundled file is a real regular file, not a link or something else.
// follow=false (default): lstat and reject symlinks outright, treating a
// missing file as a violation (private-runtime semantics). follow=true: stat
// the final target and let transport errors surface unchanged (relocatable
// bundled-Git semantics). The caller supplies the exact failure via
// `violation(file)` so user-facing messages stay with their resolver.
export async function assertBundledExecutable(file, { platform = process.platform, follow = false, violation = defaultViolation, access = true } = {}) {
  if (follow) {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw violation(file);
  } else {
    const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw violation(file);
  }
  if (access) await assertExecutableAccess(file, { platform });
  return file;
}

function defaultViolation(file) {
  return new Error('Bundled runtime asset is missing or not a regular file: ' + file);
}

// Bundled runtime manifests carry the exact platform/arch they were built for;
// a manifest from another platform must never satisfy resolution.
export function validateRuntimeManifest(manifest, { schema = 1, platform = process.platform, arch = process.arch, rejection = () => new Error('Bundled runtime manifest does not match this platform') } = {}) {
  if (!manifest || manifest.schema !== schema || manifest.platform !== platform || manifest.arch !== arch) throw rejection();
  return manifest;
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
