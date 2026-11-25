import {openWindowsTreeRecoveryObservation} from './tree-recovery.mjs';

export async function observeWindowsTreeSurface(host, project, relative) {
  const observation = openWindowsTreeRecoveryObservation(host, project, relative);
  try {
    const name = relative.split('/').at(-1), entry = observation.observe(name, true);
    if (!entry || entry.directory) throw Object.assign(Error('原文档位置无法核验。'), {code:'TREE_SURFACE_CHANGED'});
    const snapshot = await observation.capture(name, entry);
    const verify = async () => {
      await observation.verifyLeases();
      if (observation.observe(name)?.identity !== snapshot.identity) throw Object.assign(Error('原文档身份已变化。'), {code:'TREE_SURFACE_CHANGED'});
    };
    await verify();
    return {snapshot, verify, close:observation.close};
  } catch (error) { observation.close(); throw error; }
}
