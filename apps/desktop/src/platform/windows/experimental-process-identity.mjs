// Observation only: never selects the ownership adapter or releases resources.
// The optional {allowTerminate:true} lease is the narrow, explicitly requested
// termination authority bound to the retained original HANDLE; the default
// pin stays query-only and keeps refusing termination.
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
export function openExperimentalProcessIdentity(pid, {allowTerminate = false} = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Object.assign(Error('Native Windows x64 required'), {code:'PROCESS_PLATFORM_UNSUPPORTED'});
  if (typeof allowTerminate !== 'boolean') throw Object.assign(Error('allowTerminate must be a boolean'), {code:'PROCESS_PID_INVALID'});
  return require('../../../native/windows-process/build/Release/nozeli_windows_process.node').openProcessIdentity(pid, {allowTerminate});
}
