// Windows worker shell selection. The host resolves a supported Bash from
// the SDK's documented locations before constructing the private owner
// environment (which does not inherit ProgramFiles), and passes the verified
// absolute path via NOZELI_PI_SHELL. Ordinary tool lookup separately retains
// the host PATH after the bundled Node and System32 locations. This is a
// detected user-installed dependency, not a bundled portable Bash: absence is
// a capability fact, never a startup failure — reading and chat continue, and
// the worker's bash tool answers with the explicit device prerequisite.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const VERSION_TIMEOUT_MS = 5000;
const GNU_BASH = /^GNU bash[,\s]/;

// A candidate counts only when it actually runs and identifies as GNU bash.
// This rejects stale PATH entries, non-bash shells, and a legacy WSL launcher
// without an installed distribution before any session depends on it.
function verifyCandidate(candidate, run) {
  if (typeof candidate !== 'string' || !candidate || !path.isAbsolute(candidate)) return null;
  const result = run(candidate, ['--version']);
  const banner = result?.status === 0 ? String(result.stdout ?? '').split(/\r?\n/)[0] ?? '' : '';
  return GNU_BASH.test(banner) ? { shell: candidate, version: banner.trim() } : null;
}

function candidateFromWhere(run) {
  const result = run('where.exe', ['bash.exe']);
  if (result?.status !== 0) return null;
  const first = String(result.stdout ?? '').trim().split(/\r?\n/)[0];
  return first || null;
}

/**
 * Resolve a supported Bash for the Windows Pi worker, or null when the device
 * has none. Order mirrors the SDK's documented discovery: Git Bash under
 * ProgramFiles, then ProgramFiles(x86), then bash.exe found via where.exe.
 * Never throws: every failure step just moves to the next candidate.
 */
export function resolveWorkerShell({ platform = process.platform, env = process.env, run = (file, args) => spawnSync(file, args, { env, timeout: VERSION_TIMEOUT_MS, encoding: 'utf8', windowsHide: true }) } = {}) {
  if (platform !== 'win32') return null;
  const locations = [];
  const programFiles = env.ProgramFiles;
  if (programFiles) locations.push({ source: 'program-files-git', candidate: path.join(programFiles, 'Git', 'bin', 'bash.exe') });
  const programFilesX86 = env['ProgramFiles(x86)'];
  if (programFilesX86) locations.push({ source: 'program-files-x86-git', candidate: path.join(programFilesX86, 'Git', 'bin', 'bash.exe') });
  const searched = locations.map(({ candidate }) => candidate);
  for (const { source, candidate } of locations) {
    const verified = verifyCandidate(candidate, run);
    if (verified) return { ...verified, source, searched };
  }
  const onPath = candidateFromWhere(run);
  if (onPath) {
    searched.push(onPath);
    const verified = verifyCandidate(onPath, run);
    if (verified) return { ...verified, source: 'path', searched };
  }
  return null;
}
