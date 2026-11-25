// Independent process-boundary component; no production capability selection.
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw Object.assign(Error('Native Windows x64 required'), {code:'NATIVE_BUILD_UNSUPPORTED'});
if (process.versions.node !== '22.23.4' || process.versions.electron)
  throw Error('Use pinned development Node 22.23.4; qualify Electron separately');
const require = createRequire(import.meta.url);
const child = spawnSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild',
  '--arch=x64', '--target=22.23.4', '--dist-url=https://nodejs.org/download/release'], {
  cwd:path.resolve(import.meta.dirname, '../native/windows-process'), stdio:'inherit', windowsHide:true,
});
if (child.error) throw child.error;
if (child.signal) throw Error(`Process component build terminated: ${child.signal}`);
process.exitCode = child.status ?? 1;
