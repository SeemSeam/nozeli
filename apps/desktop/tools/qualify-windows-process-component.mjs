// Synthetic source + ZIP roundtrip. This does not package the Nozeli app.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire,isBuiltin} from 'node:module';
import path from 'node:path';
import {parseArgs} from 'node:util';
import JSZip from 'jszip';

const {values}=parseArgs({options:{output:{type:'string'},'with-pi':{type:'boolean',default:false}}});
assert.ok(values.output&&path.isAbsolute(values.output),'Pass a fresh absolute --output evidence directory');
const app=path.resolve(import.meta.dirname,'..'),repo=path.resolve(app,'../..');
const require=createRequire(import.meta.url),pkg=require('../package.json');
const lock=require('./node-runtime.win32-x64.lock.json');
assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');
assert.equal(process.versions.node,lock.version);assert.equal(process.versions.electron,undefined);
const output=path.resolve(values.output);
await fs.mkdir(output); // Never overwrite another qualification.
const extracted=path.join(output,'解压 空格'),extractedApp=path.join(extracted,'app');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=async file=>sha(await fs.readFile(file));
const relativeFiles=[
  'native/windows-process/process-identity.cc','native/windows-process/process-job.inc','native/windows-process/process-stdio.inc','native/windows-process/binding.gyp',
  'native/windows-process/process-supervision.inc','native/windows-process/process-supervisor.cc','native/windows-process/supervisor-protocol.h',
  'native/windows-process/supervisor-output.h',
  'native/windows-process/supervisor-input.h',
  'native/windows-process/build/Release/nozeli_windows_supervisor.exe','tests/windows-process-supervisor.test.mjs',
  'tests/windows-supervisor-custody.test.mjs',
  'tests/windows-supervisor-output.test.mjs',
  'tests/windows-supervisor-input.test.mjs',
  'tests/windows-host-sources.test.mjs',
  'tests/windows-workspace-open.test.mjs',
  'native/windows-process/build/Release/nozeli_windows_process.node',
  'native/windows-process/build/Release/nozeli_process_fixture.exe','tests/fixtures/windows-process-helper.cc',
  'src/platform/windows/experimental-process-identity.mjs','src/platform/windows/experimental-process-job.mjs',
  'src/platform/windows/experimental-process-transport.mjs','src/agents/managed/jsonl-reader.mjs',
  'src/agents/managed/pi-session.mjs','src/agents/managed/pi-process-ownership.mjs',
  'src/agents/managed/omp-credentials.mjs','src/agents/managed/process-isolation.mjs',
  'src/platform/linux/bwrap-isolation.mjs','src/platform/shared/persistence.mjs','src/platform/linux/persistence.mjs',
  'src/agents/managed/process-ownership.mjs','src/platform/platform-capabilities.mjs',
  'src/platform/linux/process-ownership.mjs','tests/windows-process-identity.test.mjs','tests/windows-process-job.test.mjs','tests/windows-process-transport.test.mjs',
  'tools/build-windows-process.mjs','tools/qualify-windows-process-component.mjs',
  'tools/node-runtime.win32-x64.lock.json','package.json','package-lock.json',
  'src/main/owner-launch-registry.mjs','tests/windows-owner-launch.test.mjs','tests/windows-host-lease.test.mjs',
  'native/windows/build/Release/nozeli_windows_read.node',
];
for(const name of (await fs.readdir(path.join(app,'native/windows'))).sort())
  if(/\.(cc|inc|gyp|h)$/.test(name))relativeFiles.push('native/windows/'+name);
async function treeFiles(root,visit){
  for(const entry of (await fs.readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    assert.ok(!entry.isSymbolicLink(),'No links in the qualification closure: '+path.join(root,entry.name));
    const file=path.join(root,entry.name);if(entry.isDirectory())await treeFiles(file,visit);else await visit(file);
  }
}
if(values['with-pi']){
  relativeFiles.push('tests/windows-pi-owner.test.mjs','tests/windows-worker-flow.test.mjs','src/platform/windows/experimental-pi-owner-launch.mjs','src/agents/managed/roles.json');
  await treeFiles(path.join(app,'src/agents/managed/roles'),file=>relativeFiles.push(path.relative(app,file).split(path.sep).join('/')));
}
const packages=new Set();
// The registry exercises the real shared storage worker in the extracted
// component. Include literal relative module/worker/native dependencies, not
// just the test's direct imports. Built-ins stay provided by the pinned host.
for(let index=0;index<relativeFiles.length;index++){
  const name=relativeFiles[index];if(!name.endsWith('.mjs'))continue;
  const source=await fs.readFile(path.join(app,name),'utf8');
  if(!name.startsWith('tools/'))for(const reference of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^.'"][^'"]*)['"]/g))
    if(!isBuiltin(reference[1])&&/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/i.test(reference[1]))packages.add(reference[1].startsWith('@')?reference[1].split('/').slice(0,2).join('/'):reference[1].split('/')[0]);
  const references=[...source.matchAll(/(?:from\s*|import\s*\(|require\s*\(|new\s+URL\s*\()\s*['"](\.{1,2}\/[A-Za-z0-9_./@-]+)['"]/g)];
  for(const reference of references){
    const target=path.resolve(path.dirname(path.join(app,name)),reference[1]);
    // PiSession's default owner entry is a launch resource, not an app module.
    // --with-pi packages that separate integration closure below and supplies
    // its explicit source/extracted root to the actual startup tests.
    if(reference[0].startsWith('new URL')&&target===path.join(repo,'integrations/pi/src/owner.mjs'))continue;
    assert.ok(target.startsWith(app+path.sep),'Module closure must stay inside the desktop app');
    const relative=path.relative(app,target).split(path.sep).join('/');
    if(!relativeFiles.includes(relative))relativeFiles.push(relative);
  }
}
// Include the installed, lockfile-checked runtime package trees and their
// declared dependencies, including licenses. The extraction must not resolve
// missing packages through this checkout's node_modules or ambient NODE_PATH.
const installedLock=require('../package-lock.json'),packageRoots=new Set();
async function addPackage(name,from=path.join(app,'package.json')){
  const resolver=createRequire(from);let resolved;
  try{resolved=resolver.resolve(name+'/package.json');}catch{resolved=resolver.resolve(name);}
  let directory=path.dirname(resolved);
  for(;;){
    const manifest=path.join(directory,'package.json');let metadata;
    try{metadata=JSON.parse(await fs.readFile(manifest,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(metadata?.name===name){
      if(packageRoots.has(directory))return;packageRoots.add(directory);
      const relative=path.relative(app,directory).split(path.sep).join('/');assert.ok(relative.startsWith('node_modules/'));
      assert.equal(installedLock.packages[relative]?.version,metadata.version,'Installed package must match lockfile');
      const addTree=async root=>{for(const entry of (await fs.readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        assert.ok(!entry.isSymbolicLink(),'No package links in the qualification closure');const file=path.join(root,entry.name);
        if(entry.isDirectory())await addTree(file);else relativeFiles.push(path.relative(app,file).split(path.sep).join('/'));
      }};
      await addTree(directory);
      for(const dependency of Object.keys(metadata.dependencies??{}).sort())await addPackage(dependency,manifest);
      return;
    }
    const parent=path.dirname(directory);assert.notEqual(parent,directory,'Package manifest missing: '+name);directory=parent;
  }
}
for(const name of [...packages].sort())await addPackage(name);
const receipt={schema:1,synthetic:true,startedAt:new Date().toISOString(),status:'failed',
  custodyScope:'Native host anchor/local UI database, source catalog/project.sqlite and immutable project manifest with retained directory chains; fresh source row revisions and cold source observation only, no atomic cross-database business release',
  scope:values['with-pi']?'Explicit Windows Job and actual Pi SDK loopback interaction through shared public Controller.start/send scheduler, scoped public-source/private-target dependencies and prepared resources, real Node imports in the Worker execution directory, native document edit, frozen candidate, exact human review acceptance and Git, original owner retirement, complete private home archival with interrupted-publication reconciliation and same-process warm reopen; shared Workspace/host custody and original Job/stdin/output custody across host death. Production selection, source-link/large payload and stale-stage recovery, cold business release and whole app package remain unqualified':'Explicit created-Job identity/stdio, shared prepared launch/SQLite CAS/UNKNOWN fences, native host custody and shared Workspace.open/Controller.open without provider launch; original-kernel-Job supervisor reconnection; no full PiSession.start or cold business release qualification',
  files:[],runs:[],productionSelected:false,treeOwnershipQualified:false,appPackageQualified:false};
const sourcePaths=new Map(relativeFiles.map(name=>['app/'+name,path.join(app,name)]));
if(values['with-pi']){
  const integration=path.join(repo,'integrations/pi'),piLock=JSON.parse(await fs.readFile(path.join(integration,'package-lock.json'),'utf8'));
  const add=file=>sourcePaths.set('integrations/pi/'+path.relative(integration,file).split(path.sep).join('/'),file);
  for(const name of ['src','dist','vendor','patches','licenses'])await treeFiles(path.join(integration,name),add);
  for(const name of ['package.json','package-lock.json','runtime-manifest.json','upstream-manifest.json','build.mjs'])add(path.join(integration,name));
  receipt.piPackages=[];
  for(const [relative,locked] of Object.entries(piLock.packages).sort(([a],[b])=>a.localeCompare(b))){
    if(!relative||locked.dev)continue;
    assert.ok(relative.startsWith('node_modules/')&&!relative.includes('..'));
    const directory=path.join(integration,relative);let metadata;
    try{metadata=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));}catch(error){
      if(error.code==='ENOENT'&&locked.optional){receipt.piPackages.push({path:relative,version:locked.version,installed:false,optional:true});continue;}throw error;
    }
    assert.equal(metadata.version,locked.version,'Pi installed package must match lockfile: '+relative);
    receipt.piPackages.push({path:relative,version:metadata.version,installed:true,optional:locked.optional===true});
    const addPackageTree=async root=>{for(const entry of await fs.readdir(root,{withFileTypes:true})){
      if(entry.name==='node_modules')continue;
      assert.ok(!entry.isSymbolicLink(),'Pi dependency links are unqualified');const file=path.join(root,entry.name);
      if(entry.isDirectory())await addPackageTree(file);else add(file);
    }};await addPackageTree(directory);
  }
  const manifest=JSON.parse(await fs.readFile(path.join(integration,'runtime-manifest.json'),'utf8'));
  for(const [name,expected] of Object.entries(manifest.files))assert.equal(await digest(path.join(integration,name)),expected,'Pi runtime manifest: '+name);
  receipt.piRuntime={sdk:manifest.sdk,entry:manifest.entry,manifestSha256:await digest(path.join(integration,'runtime-manifest.json'))};
}
sourcePaths.set('runtime/node.exe',process.execPath);
sourcePaths.set('runtime/LICENSE',path.join(path.dirname(process.execPath),'LICENSE'));
sourcePaths.set('LICENSE',path.join(repo,'LICENSE'));
const binaryRelative='app/native/windows-process/build/Release/nozeli_windows_process.node';
const binary=sourcePaths.get(binaryRelative);
const factsCode='JSON.stringify({platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron,napi:process.versions.napi})';
const baseEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>
  !/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)&&
  !/^(GH_|GITHUB_|GIT_CONFIG_|CCB_|CODEX_|OMP_|PI_)/.test(key)&&
  !['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','NOZELI_CONFIG_ROOT','NOZELI_USER_DATA'].includes(key)));

async function runHost(label,executable,cwd,host) {
  const env={...baseEnv};if(host==='electron')env.ELECTRON_RUN_AS_NODE='1';
  if(values['with-pi'])env.NOZELI_TEST_PI_ROOT=label.startsWith('extracted-')?path.join(extracted,'integrations/pi'):path.join(repo,'integrations/pi');
  const invoke=args=>spawnSync(executable,args,{cwd,env,encoding:'utf8',windowsHide:true,timeout:values['with-pi']?180000:60000,maxBuffer:8*1024*1024});
  const run={label,host,executable,startedAt:new Date().toISOString()};receipt.runs.push(run);
  const facts=invoke(['-p',factsCode]);assert.ifError(facts.error);assert.equal(facts.status,0,facts.stderr);
  assert.equal(facts.signal,null);run.runtime=JSON.parse(facts.stdout);
  assert.equal(run.runtime.platform,'win32');assert.equal(run.runtime.arch,'x64');
  assert.equal(run.runtime[host],host==='node'?lock.version:pkg.devDependencies.electron);
  const tests=['windows-process-identity.test.mjs','windows-process-job.test.mjs','windows-process-transport.test.mjs','windows-process-supervisor.test.mjs','windows-supervisor-custody.test.mjs','windows-supervisor-output.test.mjs','windows-supervisor-input.test.mjs','windows-host-sources.test.mjs','windows-workspace-open.test.mjs','windows-owner-launch.test.mjs','windows-host-lease.test.mjs',...(values['with-pi']?['windows-pi-owner.test.mjs','windows-worker-flow.test.mjs']:[])];
  const testArgs=['--test','--test-reporter=tap',...tests.map(name=>path.join(cwd,'tests',name))];
  const result=invoke(testArgs);
  run.command=[executable,...testArgs];run.exitCode=result.status;run.signal=result.signal;
  run.log=path.join(output,label+'.tap');run.stderr=path.join(output,label+'.err');
  await fs.writeFile(run.log,result.stdout??'');await fs.writeFile(run.stderr,result.stderr??'');
  assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,result.stdout+result.stderr);
  run.counts={};
  for(const key of ['tests','pass','fail','cancelled','skipped','todo']) {
    const values=[...result.stdout.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`,'gm'))];
    assert.equal(values.length,1);run.counts[key]=Number(values[0][1]);
  }
  assert.ok(run.counts.tests>0);assert.equal(run.counts.tests,run.counts.pass);
  for(const key of ['fail','cancelled','skipped','todo'])assert.equal(run.counts[key],0);
  run.status='passed';run.finishedAt=new Date().toISOString();
  console.log(label,JSON.stringify(run.counts));
}

try {
  const archive=new JSZip();
  for(const [name,source] of sourcePaths) {
    const bytes=await fs.readFile(source);
    receipt.files.push({path:name,sha256:sha(bytes),bytes:bytes.length});archive.file(name,bytes);
  }
  receipt.binarySha256=await digest(binary);
  const manifest={schema:1,scope:receipt.scope,files:receipt.files};
  archive.file('component-manifest.json',JSON.stringify(manifest,null,2)+'\n');
  const bytes=await archive.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}});
  const zipPath=path.join(output,'windows-process-component.zip');await fs.writeFile(zipPath,bytes,{flag:'wx'});
  receipt.archive={path:zipPath,sha256:sha(bytes),bytes:bytes.length};
  const zip=await JSZip.loadAsync(await fs.readFile(zipPath),{checkCRC32:true});
  assert.deepEqual(Object.keys(zip.files).filter(name=>!zip.files[name].dir).sort(),[...sourcePaths.keys(),'component-manifest.json'].sort());
  for(const [name,entry] of Object.entries(zip.files)) {
    if(entry.dir)continue;
    const target=path.resolve(extracted,name);
    assert.ok(target.startsWith(extracted+path.sep),'ZIP entry must stay in extraction root');
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,await entry.async('nodebuffer'),{flag:'wx'});
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(extracted,'component-manifest.json'),'utf8')),manifest);
  for(const item of receipt.files)assert.equal(await digest(path.join(extracted,item.path)),item.sha256,item.path);
  const electron=require('electron');
  await runHost('source-node',process.execPath,app,'node');
  await runHost('source-electron',electron,app,'electron');
  await runHost('extracted-node',path.join(extracted,'runtime/node.exe'),extractedApp,'node');
  // Development Electron is explicit in the receipt; it is not bundled here.
  await runHost('extracted-electron',electron,extractedApp,'electron');
  for(const item of receipt.files) {
    assert.equal(await digest(path.join(extracted,item.path)),item.sha256,'Extracted file changed: '+item.path);
    assert.equal(await digest(sourcePaths.get(item.path)),item.sha256,'Source changed: '+item.path);
  }
  assert.equal(receipt.binarySha256,await digest(binary));receipt.status='passed';
} catch(error) {
  receipt.error=error.stack??String(error);throw error;
} finally {
  receipt.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(output,'process-component-roundtrip.json'),JSON.stringify(receipt,null,2)+'\n');
}
