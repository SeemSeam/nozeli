// Versioned platform capability selection for the Nozeli desktop host.
//
// This module is the single shared place that answers "is capability X real on
// this platform?". It records facts, never optimism:
//   'implemented' — a real implementation exists for that platform and is
//                   exercised by the current Linux regression suite.
//   'not-run'     — an implementation path exists in code but has never been
//                   executed on a real host of that platform (Windows/macOS
//                   evidence must come from that platform; Linux results do
//                   not extrapolate).
//   'unsupported' — no implementation; callers must fail explicitly and must
//                   not substitute a weaker silent fallback.
// Business code consumes this contract instead of scattering process.platform
// branches; platform adapters may branch internally. Adapters keep their own
// explicit error codes (FS_PLATFORM_UNSUPPORTED, PI_PLATFORM_UNSUPPORTED,
// PERSISTENCE_UNSUPPORTED, ...) — requireCapability()/selectCapability() add
// the shared selection vocabulary, they do not replace adapter errors.
//
// implementationCoverage() reports only whether implementations are DECLARED
// for a platform; it is not a runtime readiness verdict. Actual readiness
// comes from executing the platform probe (tools/platform-probe.mjs), whose
// managedExecution.ready requires declared coverage AND executed host
// evidence to agree.
//
// Statuses mirror the source tree as of this change; they are declarations of
// the current implementation, not claims about other platforms. The matrix is
// data so the machine-readable inventory and this module cannot drift.

export const CAPABILITY_SCHEMA = 1;

const TARGET_PLATFORMS = ['linux', 'win32', 'darwin'];

export function currentPlatform(platform = process.platform) {
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return platform;
}

const NORMALIZED_TO_RAW = { linux: 'linux', windows: 'win32', macos: 'darwin' };

function rawPlatform(platform) {
  return NORMALIZED_TO_RAW[currentPlatform(platform)] ?? platform;
}

// Owner names the adapter or resolver that implements the capability today.
const MATRIX = {
  'safe-file-io': {
    owner: 'platform/linux/filesystem.mjs + platform/darwin/filesystem.mjs via platform/shared/filesystem.mjs',
    note: 'Linux pins directory descriptors through /proc/self/fd; macOS uses native openat/fstatat/renameat with O_NOFOLLOW and held directory descriptors. Both verify file, entry and ancestor identity; Git receives the pinned content stream, never a reopened source path. Missing macOS native helpers fail closed.',
    platforms: { linux: 'implemented', win32: 'unsupported', darwin: 'implemented' },
  },
  'verified-process-ownership': {
    owner: 'platform/linux/process-ownership.mjs + platform/darwin/process-ownership.mjs',
    note: 'Linux /proc and macOS native kinfo/KERN_PROCARGS2 bind process incarnation to boot identity, verify host-owned environment tags and reap owned descendants. Unverified identities retain locks and writer slots; no signal-0 liveness guess.',
    platforms: { linux: 'implemented', win32: 'unsupported', darwin: 'implemented' },
  },
  'recovery-source-ownership': {
    owner: 'platform/linux/recovery-owner.mjs + platform/darwin/recovery-owner.mjs via main/project-recovery-owner.mjs',
    note: 'Platform-native project-recovery ownership checks refuse live or unverified source owners. Missing helpers or unreadable ownership facts do not authorize lock takeover.',
    platforms: { linux: 'implemented', win32: 'unsupported', darwin: 'implemented' },
  },
  'execution-isolation': {
    owner: 'platform/linux/bwrap-isolation.mjs (PlatformProcessBoundary)',
    note: 'Linux: bubblewrap read/write domain launcher with availability probe; no fallback execution when isolation is unavailable or unverified.',
    platforms: { linux: 'implemented', win32: 'unsupported', darwin: 'unsupported' },
  },
  'durable-persistence': {
    owner: 'platform/shared/persistence.mjs + platform/linux/persistence.mjs + platform/darwin/persistence.mjs',
    note: 'Atomic replacement with file and directory barriers: Linux fsync; macOS native F_FULLFSYNC. Missing macOS helper rejects before effects. A post-publication barrier failure reports committed=true, durability=uncertain. Custom multi-file transactions retain their own journal/reconciliation and are not a power-loss qualification.',
    platforms: { linux: 'implemented', win32: 'unsupported', darwin: 'implemented' },
  },
  'bundled-git': {
    owner: 'agents/managed/git-runtime.mjs (dugite relocatable layout)',
    note: 'Relocatable dugite runtime with executable, helper and template checks. Linux x64 and local macOS arm64 builds include their own Git; Windows path remains unverified.',
    platforms: { linux: 'implemented', win32: 'not-run', darwin: 'implemented' },
  },
  'bundled-pi-runtime': {
    owner: 'agents/managed/pi-runtime.mjs + integrations/pi pinned manifest',
    note: 'Pinned Pi integration with manifest digest verification, owner entry and environment scrubbing. Native owner management exists for Linux and macOS; Windows remains unverified. This does not qualify a public model provider or OAuth login.',
    platforms: { linux: 'implemented', win32: 'not-run', darwin: 'implemented' },
  },
  'bundled-node-runtime': {
    owner: 'apps/desktop/tools/node-runtime.lock.json + runtime/node NODE-RUNTIME.json',
    note: 'Packaged builds run their own SHA-256-pinned Node archive, selected for Linux x64 or macOS arm64. Windows has no pinned archive and packaging refuses it.',
    platforms: { linux: 'implemented', win32: 'unsupported', darwin: 'implemented' },
  },
  'system-terminal-attach': {
    owner: 'agents/managed/system-terminal-launch.mjs',
    note: 'Linux system terminal discovery/attach only; explicit rejection elsewhere (基础阅读不受影响).',
    platforms: { linux: 'implemented', win32: 'unsupported', darwin: 'unsupported' },
  },
  'native-elevation': {
    owner: 'main/privilege-broker.mjs (TrustedRuntimeElevation)',
    note: "Linux pkexec + trusted system python3 launcher, root-owned facts channel (implemented). darwin osascript / win32 UAC strategies are implemented-untested in the broker's own capabilities() report; they stay not-run here until verified on real hosts.",
    platforms: { linux: 'implemented', win32: 'not-run', darwin: 'not-run' },
  },
  'omp-legacy-bridge': {
    owner: 'agents/managed/omp-terminal-bridge.mjs + omp-runtime.mjs',
    note: 'Legacy OMP history/recovery only; new execution is Pi. Windows named-pipe endpoint branch exists in code but is unverified on a real Windows host.',
    platforms: { linux: 'implemented', win32: 'not-run', darwin: 'not-run' },
  },
};

export const CAPABILITY_IDS = Object.freeze(Object.keys(MATRIX));

// Shared OS-touching callers not yet behind a capability adapter, plus work
// that is explicitly phase2. Phase 1 exit requires shared I/O ROUTING to be
// complete, so anything still unrouted is listed here by name; this list is
// deliberately explicit so phase1 exit cannot claim a whole-OS audit from a
// few migrated modules.
const RESIDUAL_BOUNDARIES = [
  { id: 'custom-transaction-durability', file: 'main/project-git.mjs + main/file-clipboard-import.mjs + main/file-tree-ops.mjs', note: 'Phase1 decision: custom rename/link/move transactions keep their existing Linux journal/reconciliation and concurrency semantics; a successful return is not a new power-loss durability promise. Mutation entry points explicitly require safe-file-io and durable-persistence before effects. Phase2 MUST qualify each native transaction with identity, rollback/recovery and post-publication barrier tests before enabling these capabilities; do not reuse plain writeAtomic as a multi-file transaction.' },
  { id: 'privilege-elevation-mechanisms', file: 'main/privilege-broker.mjs', note: 'Per-platform OS elevation strategies (pkexec/osascript/UAC) and root-facts verification; darwin/win32 implemented-untested, readRootResults returns null on win32. Phase2: native verification.' },
  { id: 'force-quit-process-tree', file: 'main/force-quit.cjs', note: '/proc exe/cmdline/task-children walking plus SIGKILL; on other platforms the tree walk yields nothing and only app.exit remains. Phase2: per-platform tree mechanism.' },
  { id: 'omp-tui-reap-assumptions', file: 'agents/managed/omp-tui-session.mjs', note: 'Legacy OMP: platform-default group reap result and PTY/terminal assumptions; read-only history recovery, never a portability precedent.' },
  { id: 'process-tree-kill', file: 'main/tex-build-manager.mjs + main/auto-update.mjs + main/auto-update-helper.mjs', note: 'POSIX kill(-pgid) vs win32 taskkill.exe /T /F branches; tree-termination semantics unverified outside Linux. Managed Pi sessions no longer branch here (processTree contract). Phase2.' },
  { id: 'win32-path-env-branches', file: 'agents/managed/controller.mjs + shadow-versions.mjs + main/project-git.mjs + git-service.mjs + agents/system-terminal-client.mjs', note: 'PATHEXT executable discovery, NUL vs /dev/null git isolation, win32 hook exec-bit skip, terminal-client ticket permission assumptions: unverified non-Linux branches. Phase2 verification.' },
  { id: 'updater-installation-layout', file: 'main/auto-update.mjs + auto-update-helper.mjs + auto-update-files.mjs', note: 'Symlink current/previous swap, /proc-based helper identity, process-group stop, tar.gz releases: managed installations are Linux-only by design. Phase2 W5/M5.' },
  { id: 'lsp-external-node', file: 'main/language-service-manager.mjs', note: 'Optional JS/TS language service spawns NOZELI_LSP_NODE/NODE/ambient "node"; the only production path that may consult an ambient runtime (optional capability, degrades honestly). Phase2 bundle-or-gate decision.' },
  { id: 'electron-native-surface', file: 'main/main.cjs + window-recovery.cjs + isolated-preview.mjs', note: 'Native dialogs (incl. unparented Wayland open dialog), clipboard items, shell.reveal, error boxes: real-host verification is gate W4/M4.' },
  { id: 'linux-session-flags', file: 'main/main.cjs + agents/managed-projects.mjs', note: 'ozone headless/wayland switches, wayland dialog parenting, disable-gpu fallback: Linux session integration.' },
  { id: 'runtime-audit-proc-scan', file: 'agents/managed/runtime-audit.mjs', note: 'Linux scans /proc environ; macOS scans same-user KERN_PROCARGS2 through the native process adapter and propagates failures. Windows audit is unverified; an empty list there is not verified-none.' },
  { id: 'packaging-tools', file: 'apps/desktop/tools/package-portable.mjs + package-candidate.mjs + package-macos.mjs + package-pi-runtime.mjs', note: 'Linux portable/candidate installers remain Linux-only. macOS arm64 has a local ad-hoc-signed Nozeli.app builder with bundled Node/Git/Pi, not Developer ID signing, notarization or auto-update qualification. Windows packaging remains unavailable.' },
];

export function capabilityStatus(capability, { platform = process.platform } = {}) {
  const entry = MATRIX[capability];
  if (!entry) throw new Error('Unknown platform capability: ' + String(capability));
  const raw = NORMALIZED_TO_RAW[platform] ?? rawPlatform(platform);
  const status = entry.platforms[raw];
  if (!status) throw new Error(`Capability ${capability} has no declaration for platform ${raw}; add an explicit status instead of guessing`);
  return Object.freeze({ capability, platform: currentPlatform(raw), platformRaw: raw, status, owner: entry.owner, note: entry.note });
}

export function capabilitySnapshot({ platform = process.platform } = {}) {
  const raw = rawPlatform(platform);
  const capabilities = {};
  for (const id of CAPABILITY_IDS) capabilities[id] = capabilityStatus(id, { platform: raw });
  return Object.freeze({
    schema: CAPABILITY_SCHEMA,
    generatedAt: new Date().toISOString(),
    platform: currentPlatform(raw),
    platformRaw: raw,
    arch: process.arch,
    verifiedOn: ['linux'],
    capabilities: Object.freeze(capabilities),
    residualBoundaries: Object.freeze(RESIDUAL_BOUNDARIES.map(boundary => Object.freeze({ ...boundary }))),
  });
}

// Select a per-platform implementation without ever promoting an unverified or
// missing one to "available". `implementations` maps NORMALIZED platform names
// ('linux', 'windows', 'macos') to adapters; only a matrix-declared
// 'implemented' entry can be handed out. The optional `platform` override is
// for tests and synthetic inspection: selection reflects the matrix only and
// never synthesizes OS behavior.
export function selectCapability({ capability, implementations = {}, platform = process.platform }) {
  const status = capabilityStatus(capability, { platform });
  const implementation = implementations[status.platform];
  if (status.status === 'implemented') {
    if (implementation === undefined) {
      return { state: 'unavailable', capability, platform: status.platform, status: status.status, reason: `Capability is implemented on ${status.platformRaw} but no implementation was supplied by the caller` };
    }
    return Object.freeze({ state: 'available', capability, platform: status.platform, implementation });
  }
  const reason = status.status === 'not-run'
    ? `Capability ${capability} has an unverified code path on ${status.platformRaw}; it has never been run on a real ${status.platformRaw} host and must not be treated as available`
    : `Capability ${capability} is not implemented on ${status.platformRaw}; this path must fail explicitly instead of degrading`;
  return Object.freeze({ state: 'unavailable', capability, platform: status.platform, status: status.status, reason });
}

export function requireCapability(capability, { platform = process.platform } = {}) {
  const status = capabilityStatus(capability, { platform });
  if (status.status !== 'implemented') {
    throw Object.assign(new Error(`Platform capability ${capability} is ${status.status} on ${status.platformRaw}: ${status.note}`), {
      code: 'NOZELI_CAPABILITY_UNAVAILABLE', capability, platform: status.platformRaw, status: status.status,
    });
  }
  return status;
}

// Declared implementation coverage for managed execution — NOT a runtime
// readiness verdict. `complete` means every managed-execution capability has
// an implemented adapter declared for the platform; actual readiness requires
// the executed evidence from tools/platform-probe.mjs.
export const MANAGED_EXECUTION_CAPABILITIES = Object.freeze([
  'safe-file-io', 'verified-process-ownership', 'execution-isolation', 'durable-persistence', 'bundled-git', 'bundled-pi-runtime',
]);

export function implementationCoverage({ platform = process.platform } = {}) {
  const missing = MANAGED_EXECUTION_CAPABILITIES
    .map(capability => capabilityStatus(capability, { platform }))
    .filter(status => status.status !== 'implemented')
    .map(status => ({ capability: status.capability, platform: status.platformRaw, status: status.status }));
  return Object.freeze({ schema: CAPABILITY_SCHEMA, platform: rawPlatform(platform), complete: missing.length === 0, missing: Object.freeze(missing) });
}

export const TARGET_PLATFORM_LIST = Object.freeze(TARGET_PLATFORMS);
