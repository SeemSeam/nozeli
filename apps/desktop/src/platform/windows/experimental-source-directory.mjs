// Read-only public source directories; separate native receiver type from all
// private persistence/move leases. No source ACL repair or path enumeration.
import {createRequire} from 'node:module';
import {experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';
const require=createRequire(import.meta.url);
export function openExperimentalSourceDirectory(root,directory) {
  if(process.platform!=='win32'||process.arch!=='x64')throw Object.assign(Error('Native Windows x64 required'),{code:'FS_PLATFORM_UNSUPPORTED'});
  const parts=experimentalPrivateDirectoryComponents(root,directory);
  const bridge=require('../../../native/windows/build/Release/nozeli_windows_read.node');
  return bridge.openAnchoredSourceDirectory(root,parts.join('/')+'/__source_anchor__');
}
