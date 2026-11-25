// An explicit development build of the W1 experiment; not a support selector.
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw Object.assign(new Error('The experimental Windows bridge requires native Windows x64'), {code:'NATIVE_BUILD_UNSUPPORTED'});
}
if (process.versions.node !== '22.23.4' || process.versions.electron) {
  throw new Error('Build this Node-API experiment with the pinned development Node 22.23.4; test the result in Electron separately');
}
const require = createRequire(import.meta.url);
const gyp = require.resolve('node-gyp/bin/node-gyp.js');
const child = spawnSync(process.execPath, [gyp, 'rebuild', '--arch=x64', '--target=22.23.4', '--dist-url=https://nodejs.org/download/release'], {
  cwd:path.resolve(import.meta.dirname, '../native/windows'),
  stdio:'inherit', windowsHide:true,
});
if (child.error) throw child.error;
if (child.signal) throw new Error(`Native build terminated by ${child.signal}`);
process.exitCode = child.status ?? 1;
