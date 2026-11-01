// Platform filesystem capability contract (nozeli.platform.filesystem/1).
//
// Narrow, honest boundary for managed file safety, selected through the
// shared capability matrix (capability id `safe-file-io`,
// platform/platform-capabilities.mjs). Only a matrix-declared 'implemented'
// platform can yield a native adapter; 'not-run'/'unsupported'/unknown
// platforms get unsupportedFilesystemAdapter, whose every operation rejects
// with FS_PLATFORM_UNSUPPORTED and structured evidence — never a silent
// identity or durability downgrade, never a placeholder mac/win adapter.
//
// Adapter surface (implemented by platform/linux/filesystem.mjs):
//  - openAnchoredFile(root, rel) → null | { stat, stream(), fdSourcePath(),
//    verify(), close() }: pin every ancestor, open the entry without
//    following links; null exactly when the entry or an ancestor is
//    missing; verify() reports which identity fact changed.
//  - openWriteParent(root, rel) → { openExclusive(name,{mode}),
//    writeExclusive(name,data,{mode}), renameOver(from,to), remove(name),
//    close() }: single-component operations inside one pinned directory.
//
// Durability scope: this contract provides no fsync barrier. Anchored
// writes rely on the caller's durable intent manifest (reconcile on
// recovery); persistence barriers are the separate durable-persistence
// capability (platform/shared/persistence.mjs).
import {selectCapability, capabilityStatus} from '../platform-capabilities.mjs';
import {linuxFilesystemAdapter} from '../linux/filesystem.mjs';

export const FILESYSTEM_CONTRACT = 'nozeli.platform.filesystem/1';
export const FILESYSTEM_CAPABILITY = 'safe-file-io';

const IMPLEMENTATIONS = { linux: linuxFilesystemAdapter };

export function filesystemUnsupported(platform, operation, reason, status = 'unsupported') {
  return Object.assign(new Error(`平台 ${platform} 没有已验证的原生文件安全实现（${operation}）：${reason}`), {
    code: 'FS_PLATFORM_UNSUPPORTED',
    details: Object.freeze({
      contract: FILESYSTEM_CONTRACT,
      capability: FILESYSTEM_CAPABILITY,
      platform,
      operation,
      adapter: null,
      capabilities: null,
      status,
      reason,
    }),
  });
}

// The honest adapter for platforms without a verified implementation. Unlike
// a stub it implements the whole contract surface: every operation rejects
// with structured unsupported evidence, so callers can never silently lose
// identity or durability guarantees.
export function unsupportedFilesystemAdapter(platform, reason, status = 'unsupported') {
  const reject = operation => { throw filesystemUnsupported(platform, operation, reason, status); };
  return {
    id: `unsupported(${platform})`,
    platform,
    supported: false,
    capabilities: Object.freeze({ anchoredRead: false, anchoredWrite: false, gitFdSourcePaths: false }),
    evidence: reason,
    contract: FILESYSTEM_CONTRACT,
    openAnchoredFile: async (root, rel) => reject('openAnchoredFile'),
    openWriteParent: async (root, rel) => reject('openWriteParent'),
    chain: new Proxy({}, { get: (_target, operation) => async () => reject('chain.' + String(operation)) }),
    status,
  };
}

// Selection reflects the capability matrix only. The platform override is
// for tests and synthetic inspection; it never synthesizes OS behavior.
export function selectFilesystemAdapter({ platform = process.platform } = {}) {
  let selection;
  try {
    selection = selectCapability({ capability: FILESYSTEM_CAPABILITY, implementations: IMPLEMENTATIONS, platform });
  } catch (error) {
    // Unknown platforms have no matrix declaration at all — explicit
    // unsupported, never a guess.
    return unsupportedFilesystemAdapter(String(platform), error.message, 'unsupported');
  }
  if (selection.state === 'available') {
    return Object.freeze({ ...selection.implementation, contract: FILESYSTEM_CONTRACT });
  }
  const raw = (() => { try { return capabilityStatus(FILESYSTEM_CAPABILITY, { platform }).platformRaw; } catch { return String(platform); } })();
  return unsupportedFilesystemAdapter(raw, selection.reason, selection.status);
}

// Machine-readable capability snapshot for phase gates and reporting.
export function filesystemCapabilitySnapshot({ platform = process.platform } = {}) {
  const adapter = selectFilesystemAdapter({ platform });
  return Object.freeze({
    schema: 1,
    contract: FILESYSTEM_CONTRACT,
    capability: FILESYSTEM_CAPABILITY,
    platform: adapter.platform,
    adapterId: adapter.id,
    supported: adapter.supported === true,
    capabilities: adapter.capabilities,
    status: adapter.supported ? 'implemented' : (adapter.status || 'unsupported'),
    durability: 'anchored writes rely on the caller durable intent manifest; persistence fsync barriers are the separate durable-persistence boundary (platform/shared/persistence.mjs)',
    evidence: adapter.evidence,
  });
}
