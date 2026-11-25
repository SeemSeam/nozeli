// W1 staging primitives under qualification, absent from production selectors.
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);

export function openExperimentalWriteParent(root, relative) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw Object.assign(new Error('Native Windows x64 required'), {code:'FS_PLATFORM_UNSUPPORTED'});
  }
  const bridge = require('../../../native/windows/build/Release/nozeli_windows_read.node');
  return bridge.openAnchoredWriteParent(root, relative);
}
