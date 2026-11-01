// Platform capability probe — plain Node, no Bash, no Electron required.
// Runnable unchanged on phase2 hosts (real Windows/macOS) to produce that
// platform's actual evidence.
//
//   node tools/platform-probe.mjs [--pretty] [--no-isolation]
//
// Emits machine-readable evidence (schema 1):
//   declaredCoverage — what the shared capability matrix DECLARES for this
//                       platform (implemented / not-run / unsupported); coverage
//                       alone is never a readiness verdict.
//   executedProbes    — what this run actually exercised on this host: real
//                       safe-chain file reads (incl. symlink rejection), a
//                       real durable atomic write + reopen, a real self
//                       process stamp, a real bwrap isolation availability
//                       probe (unless --no-isolation), real bundled Git
//                       resolution + self-identification, and full pinned Pi
//                       manifest digest verification. The bundled standalone
//                       Node is checked for real (executable + digest) only
//                       when the packaged layout exists; manifest absence is
//                       reported not-run, never as integrity.
//   managedExecution  — ready only when declared AND executed evidence agree;
//                       a declared-but-unexecuted or failed probe keeps it
//                       not ready. Exit code 0 only when ready.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { capabilitySnapshot, implementationCoverage } from '../src/platform/platform-capabilities.mjs';
import { assertBundledExecutable, sha256File, validateRuntimeManifest } from '../src/platform/shared/runtime-assets.mjs';

const appRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pretty = process.argv.includes('--pretty');
const isolationGating = process.argv.includes('--no-isolation') ? 'not-requested' : 'required';
const evidence = {
  schema: 1,
  probe: 'nozeli-platform-probe',
  generatedAt: new Date().toISOString(),
  host: {
    platformRaw: process.platform,
    platform: { linux: 'linux', win32: 'windows', darwin: 'macos' }[process.platform] ?? process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    cwd: process.cwd(),
  },
  declaredCoverage: null,
  executedProbes: {},
  managedExecution: null,
};

async function fixture() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-platform-probe-'));
}

// Real exercise of the production safe-open chain: pinned ancestor opens via
// /proc/self/fd, O_NOFOLLOW everywhere, inode/nlink identity, digest read.
async function probeSafeFileIo() {
  let root;
  try {
    const { inspectFile } = await import('../src/agents/managed/file-stream.mjs');
    root = await fixture();
    const content = 'nozeli-probe-safe-io\n';
    const nested = path.join(root, 'documents', 'papers');
    await fs.mkdir(nested, { recursive: true });
    const file = path.join(nested, 'evidence.txt');
    await fs.writeFile(file, content, { mode: 0o644 });
    const digest = createHash('sha256').update(content).digest('hex');
    const read = await inspectFile(root, 'documents/papers/evidence.txt');
    if (!read || read.digest !== digest || read.size !== Buffer.byteLength(content)) return { status: 'failed', error: 'safe read digest/size mismatch', root };
    await fs.mkdir(path.join(root, 'linked'));
    await fs.writeFile(path.join(root, 'linked', 'evidence.txt'), content);
    await fs.symlink(path.join(root, 'linked'), path.join(root, 'documents', 'trap'));
    try {
      await inspectFile(root, 'documents/trap/evidence.txt');
      return { status: 'failed', error: 'safe chain followed a symlinked directory component', root };
    } catch (enforced) {
      return { status: 'ok', digest, symlinkDirectoryRejected: { code: enforced.code ?? null }, root };
    }
  } catch (error) {
    return { status: error.code === 'SAFE_OPEN_UNSUPPORTED' ? 'unsupported' : 'failed', error: String(error.message), code: error.code ?? null, root };
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// Real durable atomic publication through the production adapter, verified by
// reopening the published bytes and confirming no temporary remnants.
async function probeDurablePersistence() {
  let root;
  try {
    const { platformPersistence } = await import('../src/platform/shared/persistence.mjs');
    root = await fixture();
    const file = path.join(root, 'record.json');
    const bytes = Buffer.from('{"probe":"durable"}\n');
    const receipt = await platformPersistence.writeAtomic(file, bytes);
    const reopened = await fs.readFile(file);
    const leftovers = (await fs.readdir(root)).filter(name => name.includes('.tmp'));
    if (receipt.state !== 'durable' || !reopened.equals(bytes) || leftovers.length) {
      return { status: 'failed', error: 'atomic publication did not reopen intact without remnants', receipt: receipt.state, leftovers, root };
    }
    return { status: 'ok', receipt: receipt.state, publishedBytes: bytes.length, root };
  } catch (error) {
    return { status: error.code === 'PERSISTENCE_UNSUPPORTED' ? 'unsupported' : 'failed', error: String(error.message), code: error.code ?? null, root };
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// Real identity stamp for THIS process from the landed Linux adapter.
async function probeProcessOwnership() {
  try {
    const adapter = await import('../src/platform/linux/process-ownership.mjs');
    const boot = await adapter.bootId();
    const stamp = await adapter.processStamp(process.pid);
    if (!stamp || !stamp.startsWith(boot + ':')) return { status: 'failed', error: 'self process stamp missing or not bound to the current boot id', stamp: stamp ?? null };
    return { status: 'ok', pid: process.pid, stampFormat: 'bootId:starttime', bootIdLength: boot.length };
  } catch (error) {
    return { status: 'failed', error: String(error.message), code: error.code ?? null };
  }
}

// Real bwrap availability probe (the production cached check runs true(1)
// inside the actual sandbox profile).
async function probeIsolation() {
  try {
    const { isolationAvailable } = await import('../src/agents/managed/process-isolation.mjs');
    const available = await isolationAvailable();
    return { status: available ? 'ok' : 'failed', available, gating: isolationGating };
  } catch (error) {
    return { status: 'failed', error: String(error.message), code: error.code ?? null, gating: isolationGating };
  }
}

async function probeBundledGit() {
  try {
    const { ensureGit } = await import('../src/agents/managed/git-runtime.mjs');
    const runtime = await ensureGit();
    return { status: 'ok', source: runtime.source, command: runtime.command, version: runtime.version, execPath: runtime.env.GIT_EXEC_PATH ?? null };
  } catch (error) {
    return { status: 'failed', error: String(error.message), code: error.code ?? null };
  }
}

async function probePiRuntime(piHome) {
  try {
    const { resolveBundledPiRuntime } = await import('../src/agents/managed/pi-runtime.mjs');
    const runtime = await resolveBundledPiRuntime({ appRoot, packaged: false, piHome });
    return {
      status: 'ok', command: runtime.command, entry: runtime.entry, packagedNode: false,
      sdk: runtime.manifest.pi?.sdk ?? null,
      manifestFilesVerified: Object.keys(runtime.manifest.pi?.files ?? {}).length,
    };
  } catch (error) {
    return { status: 'failed', error: String(error.message), code: error.code ?? null };
  }
}

// Real executable + digest verification when the packaged layout exists;
// absence in a development tree is not-run, never claimed as integrity.
async function probeBundledNode() {
  const directory = path.join(appRoot, 'runtime', 'node');
  const manifestFile = path.join(directory, 'NODE-RUNTIME.json');
  try {
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    validateRuntimeManifest(manifest, { rejection: () => new Error('Bundled Node runtime platform mismatch') });
    const executable = path.join(directory, manifest.executable || (process.platform === 'win32' ? 'node.exe' : 'bin/node'));
    await assertBundledExecutable(executable, { violation: file => new Error('Bundled Node executable is missing or not a regular file: ' + file) });
    const digest = await sha256File(executable);
    if (manifest.sha256Executable && digest !== manifest.sha256Executable) return { status: 'failed', error: 'Bundled Node runtime integrity mismatch', executable };
    return { status: 'ok', platform: manifest.platform, arch: manifest.arch, executable, sha256Verified: Boolean(manifest.sha256Executable) };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'not-run', reason: 'packaged-only layout; the development tree has no runtime/node bundle (development launches under the running binary)' };
    return { status: 'failed', error: String(error.message), code: error.code ?? null };
  }
}

const piHome = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-platform-probe-home-'));
try {
  evidence.executedProbes.safeFileIo = await probeSafeFileIo();
  evidence.executedProbes.durablePersistence = await probeDurablePersistence();
  evidence.executedProbes.processOwnership = await probeProcessOwnership();
  evidence.executedProbes.executionIsolation = await probeIsolation();
  evidence.executedProbes.bundledGit = await probeBundledGit();
  evidence.executedProbes.bundledPiRuntime = await probePiRuntime(piHome);
  evidence.executedProbes.bundledNodeRuntime = await probeBundledNode();
} finally {
  await fs.rm(piHome, { recursive: true, force: true }).catch(() => {});
}

const snapshot = capabilitySnapshot();
evidence.declaredCoverage = implementationCoverage();
evidence.capabilities = snapshot.capabilities;
evidence.residualBoundaries = snapshot.residualBoundaries;

const required = ['safeFileIo', 'durablePersistence', 'processOwnership', 'bundledGit', 'bundledPiRuntime'];
if (isolationGating === 'required') required.push('executionIsolation');
const failures = required.filter(name => evidence.executedProbes[name]?.status !== 'ok')
  .map(name => ({ probe: name, status: evidence.executedProbes[name]?.status ?? 'missing' }));
if (evidence.executedProbes.bundledNodeRuntime?.status === 'failed') failures.push({ probe: 'bundledNodeRuntime', status: 'failed' });
evidence.managedExecution = {
  platform: evidence.host.platformRaw,
  declaredCoverageComplete: evidence.declaredCoverage.complete, declaredCoverageMissing: evidence.declaredCoverage.missing,
  isolationGating,
  requiredProbes: required,
  failed: failures,
  ready: evidence.declaredCoverage.complete && failures.length === 0,
  note: 'ready requires declared implementation coverage AND executed host evidence to agree (implementationCoverage alone is never readiness); this probe runs unchanged on real Windows/macOS hosts, where unverified capabilities must stay not-run/unsupported rather than green.',
};

process.stdout.write(JSON.stringify(evidence, null, pretty ? 2 : 0) + '\n');
if (!evidence.managedExecution.ready) process.exitCode = 1;
