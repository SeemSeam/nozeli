// N-API uses the locked Electron headers and is also loaded by plain Node tests.
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
const require=createRequire(import.meta.url);
if(process.platform==='darwin') {
  if(process.arch!=='arm64')throw Error('The macOS platform bridge is currently validated for arm64 only');
  const version=require('electron/package.json').version;
  const gyp=require.resolve('@electron/node-gyp/bin/node-gyp.js');
  const result=spawnSync(process.execPath,[gyp,'rebuild','--directory',path.resolve(import.meta.dirname,'../native/platform'),'--target='+version,'--dist-url=https://electronjs.org/headers'],{stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
  const output=path.resolve(import.meta.dirname,'../runtime/platform',process.platform+'-'+process.arch);
  await fs.mkdir(output,{recursive:true});
  await fs.copyFile(path.resolve(import.meta.dirname,'../native/platform/build/Release/nozeli_platform.node'),path.join(output,'nozeli_platform.node'));
}
