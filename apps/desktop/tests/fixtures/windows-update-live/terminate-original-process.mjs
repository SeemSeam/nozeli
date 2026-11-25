// Dedicated fault-injection terminator for the Windows update live driver.
// Run with the bundled node.exe of the SAME application tree as the pinned
// process (the native module build must match the tree being tested).
//
// Binding is HANDLE-based, never a bare PID: the original process incarnation
// is opened with the native experimental process identity pin in
// terminate-allowed mode, the pinned image path must live under the given
// installation root and equal the expected image, and its kernel creation
// stamp must equal the exact journal stamp. Only the retained HANDLE is
// terminated; exit is proven by that same signaled HANDLE.
const usage = 'usage: terminate-original-process.mjs --pid N --under INSTALL_ROOT --app-tree ABS --image ABS --expected-start-100ns N';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  if (!['--pid', '--under', '--app-tree', '--image', '--expected-start-100ns'].includes(process.argv[index]) || !process.argv[index + 1]) throw Error(usage);
  options[process.argv[index]] = process.argv[index + 1];
}
assert.equal(process.platform, 'win32');
const pid = Number(options['--pid']);
// The 100 ns stamp stays an exact string end-to-end: it exceeds
// Number.MAX_SAFE_INTEGER, so numeric coercion could silently unbind a match.
const expected100ns = options['--expected-start-100ns'];
assert(Number.isFinite(pid) && Number.isInteger(pid) && pid > 0, 'valid --pid required');
assert(/^\d+$/.test(expected100ns ?? '') && path.isAbsolute(options['--image'] ?? ''), usage);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const {openExperimentalProcessIdentity} = await import(pathToFileURL(path.join(options['--app-tree'], 'src/platform/windows/experimental-process-identity.mjs')).href);
let pin;
try {
  pin = openExperimentalProcessIdentity(pid, {allowTerminate: true});
} catch (error) {
  if (error?.code === 'PROCESS_PID_INVALID') throw Object.assign(Error('native rebuild missing: openExperimentalProcessIdentity rejects the allowTerminate option (pre-rebuild nozeli_windows_process.node); rebuild the native component before running fault-injection journeys'), {code: 'PROCESS_TERMINATE_UNSUPPORTED', cause: error});
  throw error;
}
try {
  if (typeof pin.terminate !== 'function') throw Object.assign(Error('native exact-handle termination unavailable: the process identity pin does not expose terminate (allowTerminate build required)'), {code: 'PROCESS_TERMINATE_UNSUPPORTED'});
  const snapshot = pin.snapshot();
  const imagePath = snapshot.imagePath?.replaceAll('\\', '/') ?? '';
  const under = options['--under'].replaceAll('\\', '/').replace(/\/$/, '') + '/';
  if (!imagePath.toLowerCase().startsWith(under.toLowerCase())) throw Object.assign(Error('pinned image path is outside the installation root: ' + snapshot.imagePath), {code: 'PROCESS_PATH_UNBOUND'});
  // creationTime100ns arrives as a string and exceeds Number.MAX_SAFE_INTEGER:
  // compare stamps exactly as BigInt so precision loss cannot unbind a match.
  if (path.resolve(snapshot.imagePath).toLowerCase() !== path.resolve(options['--image']).toLowerCase()) throw Object.assign(Error('pinned image does not match the expected installed image'), {code: 'PROCESS_PATH_UNBOUND'});
  if (BigInt(snapshot.creationTime100ns) !== BigInt(expected100ns)) throw Object.assign(Error(`pinned creation stamp ${snapshot.creationTime100ns} does not match the expected original stamp ${expected100ns}`), {code: 'PROCESS_IDENTITY_UNBOUND'});
  if (snapshot.state !== 'running') throw Object.assign(Error('pinned process already exited before termination: ' + snapshot.state), {code: 'PROCESS_ALREADY_EXITED'});
  pin.terminate(1);
  let exited = null;
  for (let round = 0; round < 300; round++) {
    const observed = pin.snapshot();
    if (observed.state === 'exited') { exited = observed; break; }
    await sleep(100);
  }
  if (!exited) throw Object.assign(Error('terminated process HANDLE did not signal exit within 30s'), {code: 'PROCESS_EXIT_UNPROVEN'});
  console.log(JSON.stringify({ok: true, pid: snapshot.pid, stamp: snapshot.stamp, imagePath: snapshot.imagePath, pinnedStart100ns: snapshot.creationTime100ns, expectedStart100ns: expected100ns, terminatedThrough: 'retained-native-handle', exitCode: exited.exitCode ?? null, exitProvenBy: 'signaled-handle'}));
} finally {
  pin.close();
}
