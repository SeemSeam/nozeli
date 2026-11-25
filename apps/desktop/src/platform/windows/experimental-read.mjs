// W1 component under qualification. Deliberately absent from shared selectors.
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);

export function openExperimentalAnchoredRead(root, relative) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw Object.assign(new Error('Native Windows x64 required'), {code:'FS_PLATFORM_UNSUPPORTED'});
  }
  // No system binary, C# compilation, PowerShell, or alternative implementation.
  const bridge = require('../../../native/windows/build/Release/nozeli_windows_read.node');
  return bridge.openAnchoredRead(root, relative);
}
