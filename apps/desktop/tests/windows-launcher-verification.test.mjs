// Generated-launcher regression (launcher regression only, not product
// acceptance). These tests execute the actual Launch-Nozeli.ps1 that
// install-windows.mjs writes into a real isolated installation and observe its
// externally visible behavior only:
//   - UTF8/.NET extended-path reads of the ownership records and manifest,
//   - complete byte-length and SHA-256 digest checks over every listed member,
//     including a non-ASCII record path and a member whose absolute path is
//     longer than MAX_PATH (260),
//   - refusal (no process admission) when any listed member, the manifest or
//     the state record is tampered with, or a listed member is a reparse point,
//   - admission of the actual pinned node.exe runtime from the installed
//     payload, environment scrubbing and exit-code propagation.
//
// The admission leg deliberately runs a synthetic payload: the real fixed node
// executable copied from the running test runtime plus a minimal real marker
// module (the module the generated launcher invokes). The synthetic Nozeli.exe
// PE fixture is never executed and is not treated as Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {windowsInstall} from '../tools/install-windows.mjs';
import {openPayload,sha256,json} from '../tools/windows-install-core.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
const app='resources/app/';
const ADMITTED=7,MARKER_FAILED=8;
const MARKER='LAUNCHER-ADMISSION.json';
// Marker module executed by the real pinned node.exe after the generated
// launcher admits it. It records observed process facts (argv, environment,
// executable, node version); it verifies nothing itself.
const markerModule=`// Launcher regression admission marker. Minimal real Node program executed by
// the generated launcher line; NOT the product install module and NOT product
// acceptance evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
try{
  const forbidden=['ELECTRON_RUN_AS_NODE','NOZELI_TEST_INSTANCE','NOZELI_CONFIG_ROOT','NOZELI_USER_DATA'];
  const profile=process.env.NOZELI_WINDOWS_INSTALL_PROFILE;
  if(!profile)throw Error('launcher did not provide the installation profile');
  const record={execPath:process.execPath,nodeVersion:process.version,argv:process.argv.slice(2),profile,cwd:process.cwd(),forbiddenEnv:forbidden.filter(key=>process.env[key]!==undefined)};
  await fs.writeFile(path.join(profile,'${MARKER}'),JSON.stringify(record));
  process.exit(${ADMITTED});
}catch(error){console.error('launcher regression marker failed:',error);process.exit(${MARKER_FAILED});}
`;
function syntheticPE(){const bytes=Buffer.alloc(256);bytes.write('MZ');bytes.writeUInt32LE(128,60);bytes.writeUInt32LE(0x4550,128);bytes.writeUInt16LE(0x8664,132);return bytes;}
// One installed member must exceed the 260-character MAX_PATH limit; the
// generated launcher reads it through the \\\\?\\ .NET extended path.
const longSegment='目录段-'.repeat(15);
const longRelative=app+'dist/'+[longSegment,longSegment,longSegment,'渲染器-'+('长'.repeat(60))+'.js'].join('/');
const longBytes=Buffer.concat(Array.from({length:12000},(_,i)=>Buffer.from('长路径成员 '+String(i).padStart(6,'0')+'\n')));
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-launcher-behavior-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return {directory,root:path.join(directory,'安装 空间 启动'),candidate:name=>path.join(directory,name)};
}
async function candidate(directory,version='synthetic-1',{productExit=false}={}){
  await fs.mkdir(directory);
  const nodeBytes=await fs.readFile(process.execPath);
  const payload={
    'Nozeli.exe':productExit?nodeBytes:syntheticPE(),[app+'runtime/node/node.exe']:nodeBytes,
    [app+'runtime/node/NODE-RUNTIME.json']:json({platform:'win32',arch:'x64',executable:'node.exe',version:process.version,sha256Executable:sha256(nodeBytes)}),
    [app+'package.json']:json({version}),[app+'dist/renderer/app.js']:'synthetic renderer',
    [app+'integrations/pi/build.mjs']:'synthetic build input',[app+'integrations/pi/tools/patch-sdk.mjs']:'synthetic patch input',
    [app+'node_modules/dugite/git/cmd/git.exe']:syntheticPE(),
    [app+'native/windows/build/Release/synthetic.node']:syntheticPE(),[app+'native/windows/input.cc']:'synthetic native source',
    [app+'用户 空格.txt']:Buffer.from('synthetic Unicode content '+version,'utf8'),
    [longRelative]:longBytes,[app+'tools/install-windows.mjs']:markerModule,
  };
  for(const name of ['windows-install-core.mjs','package-windows-candidate.mjs','local-release.mjs','release-retention.mjs','package-pi-runtime.mjs','package-node-runtime.mjs'])payload[app+'tools/'+name]='synthetic installation tool';
  const sdkOutputs=['dist/core/model-config.js','dist/core/model-runtime.js','dist/core/models-store.js','dist/core/model-config.d.ts','dist/core/model-runtime.d.ts','dist/core/models-store.d.ts','dist/utils/paths.js'];
  const files=sdkOutputs.map((name,i)=>{const bytes='synthetic SDK output '+i;payload[app+'integrations/pi/node_modules/@earendil-works/pi-coding-agent/'+name]=bytes;return {path:name,sha256:sha256(bytes)};});
  payload[app+'integrations/pi/patches/sdk/model-storage-1.4.0.json']=json({schema:1,files});
  if(productExit){
    const entry=path.resolve(import.meta.dirname,'../tools/install-windows.mjs');
    payload[app+'tools/install-windows.mjs']=`process.argv[1]=${JSON.stringify(entry)};await import(${JSON.stringify(pathToFileURL(entry).href)});`;
  }
  for(const [name,bytes] of Object.entries(payload)){await fs.mkdir(path.dirname(path.join(directory,name)),{recursive:true});await fs.writeFile(path.join(directory,name),bytes);}
  const tree=await openPayload(directory);try{await fs.writeFile(path.join(directory,'WINDOWS-CANDIDATE.json'),json({schema:1,application:'Nozeli',kind:'windows-manual-candidate',platform:'win32',arch:'x64',version,automaticUpdater:'unsupported',nativeProvenance:{schema:1,files:{[app+'native/windows/build/Release/synthetic.node']:sha256(syntheticPE())},buildInputs:{[app+'native/windows/input.cc']:sha256('synthetic native source')}},entries:tree.entries}));}finally{tree.close();}
  return directory;
}
function powershell(){return path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');}
// Runs the actual generated launcher from the installed root. The environment
// is stripped of launcher-managed variables first so any value observed by the
// admitted process is attributable to the launcher itself.
function runLauncher(root,args=[],extraEnv={}){
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('NOZELI_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];
  Object.assign(env,extraEnv);
  // Node inherits pwsh's module path verbatim; let Windows PowerShell 5.1
  // construct its own so Get-FileHash resolves from the matching Utility module.
  for(const key of Object.keys(env))if(key.toUpperCase()==='PSMODULEPATH')delete env[key];
  return spawnSync(powershell(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'Launch-Nozeli.ps1'),...args],{encoding:'utf8',env,windowsHide:true,timeout:120000});
}

test('generated launcher verifies a Unicode long-path installation and admits the real pinned node runtime',native,async t=>{
  const f=await fixture(t),input=await candidate(f.candidate('one'));
  const installed=await windowsInstall({root:f.root,command:'install',candidate:input});
  const payload=path.join(f.root,'versions',installed.active),markerPath=path.join(f.root,'profile',MARKER);
  const longInstalled=path.join(payload,longRelative),nodeInstalled=path.join(payload,app+'runtime/node/node.exe');
  assert.ok(longInstalled.length>260,'installed member must exceed MAX_PATH 260, got '+longInstalled.length);
  assert.ok(nodeInstalled.length<250,'payload node.exe must stay reachable through a plain path for admission, got '+nodeInstalled.length);
  assert.equal((await fs.stat(longInstalled)).size,longBytes.length);
  await assert.rejects(fs.stat(markerPath),{code:'ENOENT'});
  const activeBefore=await fs.readFile(path.join(f.root,'ACTIVE.json'));
  // External shared readers held across the whole run: the launcher's pinned
  // FileShare::Read verification opens must coexist with other readers.
  const heldLong=await fs.open(longInstalled,'r'),heldManifest=await fs.open(path.join(payload,'WINDOWS-CANDIDATE.json'),'r');
  let result;
  try{
    result=runLauncher(f.root,['通行证-Ω-7f3d','第二-参数'],{ELECTRON_RUN_AS_NODE:'1',NOZELI_TEST_INSTANCE:'sentinel',NOZELI_CONFIG_ROOT:'sentinel',NOZELI_USER_DATA:'sentinel'});
  }finally{await heldLong.close();await heldManifest.close();}
  assert.equal(result.status,ADMITTED,'launcher must run the admitted node process to completion and propagate its exit code; stderr: '+result.stderr);
  const marker=JSON.parse(await fs.readFile(markerPath,'utf8'));
  assert.equal(marker.execPath.toLowerCase(),nodeInstalled.toLowerCase());
  assert.equal(marker.nodeVersion,process.version);
  assert.equal(marker.profile,path.join(f.root,'profile'));
  assert.deepEqual(marker.forbiddenEnv,[]);
  assert.deepEqual(marker.argv,['launch','--root',f.root,'--','通行证-Ω-7f3d','第二-参数']);
  assert.deepEqual(await fs.readFile(path.join(f.root,'ACTIVE.json')),activeBefore);
  const status=await windowsInstall({root:f.root,command:'status'});
  assert.equal(status.installerLock,false);
  assert.equal(status.versions.length,1);assert.ok(status.versions.every(v=>v.state==='verified'));
});

test('generated launcher propagates a nonzero application exit and preserves its JSON receipt',native,async t=>{
  const f=await fixture(t),input=await candidate(f.candidate('exit'),'synthetic-1',{productExit:true});
  const installed=await windowsInstall({root:f.root,command:'install',candidate:input});
  const result=runLauncher(f.root,['-e','process.exit(7)']);
  assert.equal(result.status,7,result.stderr);
  const {exitCode,signal,active}=JSON.parse(result.stdout);
  assert.deepEqual({exitCode,signal,active},{exitCode:7,signal:null,active:installed.active});
});

test('generated launcher refuses tampered members before admitting any process',native,async t=>{
  const f=await fixture(t),input=await candidate(f.candidate('one'));
  const installed=await windowsInstall({root:f.root,command:'install',candidate:input});
  const payload=path.join(f.root,'versions',installed.active),markerPath=path.join(f.root,'profile',MARKER);
  const activeFile=path.join(f.root,'ACTIVE.json'),activeOriginal=await fs.readFile(activeFile);
  const refuse=async message=>{
    const before=await fs.readFile(activeFile);
    const result=runLauncher(f.root);
    assert.notEqual(result.status,0,'tampered installation must not be launched');
    assert.notEqual(result.status,ADMITTED,'no admission may happen for a tampered installation');
    assert.ok(result.stderr.includes(message),'launcher must report: '+message+'; stderr: '+result.stderr);
    await assert.rejects(fs.stat(markerPath),{code:'ENOENT'});
    assert.deepEqual(await fs.readFile(activeFile),before,'launcher must not rewrite installation state on refusal');
  };
  await t.test('digest change on the >260-character member is detected',async()=>{
    const file=path.join(payload,longRelative),original=Buffer.from(await fs.readFile(file));
    original[original.length-23]^=0xff;await fs.writeFile(file,original);
    try{await refuse('Installed payload changed; refusing launch');}
    finally{original[original.length-23]^=0xff;await fs.writeFile(file,original);}
  });
  await t.test('digest change on a non-ASCII record path is detected',async()=>{
    const file=path.join(payload,app+'用户 空格.txt'),original=Buffer.from(await fs.readFile(file));
    original[original.length-1]^=0xff;await fs.writeFile(file,original);
    try{await refuse('Installed payload changed; refusing launch');}
    finally{original[original.length-1]^=0xff;await fs.writeFile(file,original);}
  });
  await t.test('byte-length change on a listed member is detected',async()=>{
    const file=path.join(payload,app+'dist/renderer/app.js'),original=Buffer.from(await fs.readFile(file));
    await fs.appendFile(file,'!');
    try{await refuse('Installed payload changed; refusing launch');}
    finally{await fs.writeFile(file,original);}
  });
  await t.test('modified installed manifest is rejected before any member is read',async()=>{
    const file=path.join(payload,'WINDOWS-CANDIDATE.json'),original=Buffer.from(await fs.readFile(file)),flip=Math.floor(original.length/2);
    original[flip]^=0x20;await fs.writeFile(file,original);
    try{await refuse('Installed manifest changed; refusing launch');}
    finally{original[flip]^=0x20;await fs.writeFile(file,original);}
  });
  await t.test('reparse point in place of a listed directory is rejected',async()=>{
    const outside=path.join(f.directory,'junction-outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'decoy'),'decoy');
    const directory=path.join(payload,app+'integrations/pi/patches/sdk'),spec=Buffer.from(await fs.readFile(path.join(directory,'model-storage-1.4.0.json')));
    const heal=async()=>{await fs.rm(directory,{force:true});await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'model-storage-1.4.0.json'),spec);};
    await fs.rm(directory,{recursive:true,force:true});await fs.symlink(outside,directory,'junction');
    try{await refuse('Reparse payload entry rejected');assert.equal(await fs.readFile(path.join(outside,'decoy'),'utf8'),'decoy');}
    finally{await heal();}
  });
  await t.test('state record from a different installation is rejected',async()=>{
    const state=JSON.parse(activeOriginal.toString());state.installationId=randomUUID();
    await fs.writeFile(activeFile,json(state));
    try{await refuse('Invalid installation ownership/state; use install-windows.mjs status');}
    finally{await fs.writeFile(activeFile,activeOriginal);}
  });
  await t.test('restored installation verifies and is admitted again',async()=>{
    const result=runLauncher(f.root);
    assert.equal(result.status,ADMITTED,'pristine re-run must be admitted after all refusals; stderr: '+result.stderr);
    const marker=JSON.parse(await fs.readFile(markerPath,'utf8'));
    assert.equal(marker.execPath.toLowerCase(),path.join(payload,app+'runtime/node/node.exe').toLowerCase());
    assert.deepEqual(await fs.readFile(activeFile),activeOriginal);
  });
});
